import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.resolve(__dirname, "../scripts/execution-guard-hook.mjs");
const stateFile = path.join(os.tmpdir(), "agy-poll-state.json");

// Clean state before tests
try {
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
} catch {}

function runHook(payload) {
  const result = spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify(payload),
    encoding: "utf-8"
  });
  assert.equal(result.status, 0, `Hook exited with code ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

console.log("Running Agy-Context-Saver intelligent hook tests...\n");

// 1. manage_task initial poll: ALLOWED (safe harbor for inspecting potentially hung tasks)
{
  const out = runHook({
    conversationId: "test-conv-1",
    toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-1" } }
  });
  assert.equal(out.decision, "allow");
  console.log("✓ manage_task(status) initial check is allowed (safe harbor for debugging)");
}

// 2. manage_task rapid consecutive poll: DENIED (blocks compulsive busy-wait loops)
{
  const out = runHook({
    conversationId: "test-conv-1",
    toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-1" } }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Rapid task polling detected/);
  console.log("✓ manage_task(status) rapid consecutive poll is denied (busy-loop blocked)");
}

// 3. manage_task with explicit debugging context: ALLOWED (safe harbor for debugging stuck tasks)
{
  const out = runHook({
    conversationId: "test-conv-1",
    toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-1", Reason: "debugging stuck process" } }
  });
  assert.equal(out.decision, "allow");
  console.log("✓ manage_task(status) with debugging context is allowed");
}

// 4. manage_task with teamwork / subagent context: ALLOWED (safe harbor for /teamwork-preview)
{
  const out = runHook({
    conversationId: "test-conv-teamwork",
    toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-teamwork-1" } }
  });
  assert.equal(out.decision, "allow");
  console.log("✓ manage_task(status) with teamwork context is allowed");
}

// 5. manage_task kill: ALLOWED
{
  const out = runHook({ toolCall: { name: "manage_task", args: { Action: "kill", TaskId: "task-1" } } });
  assert.equal(out.decision, "allow");
  console.log("✓ manage_task(kill) is allowed");
}

// 6. run_command upgrades WaitMsBeforeAsync
{
  const out = runHook({ toolCall: { name: "run_command", args: { CommandLine: "pytest", WaitMsBeforeAsync: 2000 } } });
  assert.equal(out.decision, "allow");
  assert.equal(out.overwrite?.WaitMsBeforeAsync, 10000);
  console.log("✓ run_command upgrades WaitMsBeforeAsync to 10000");
}

// 7. run_command daemon not overwritten
{
  const out = runHook({ toolCall: { name: "run_command", args: { CommandLine: "dev-server", IsDaemon: true, WaitMsBeforeAsync: 500 } } });
  assert.equal(out.decision, "allow");
  assert.equal(out.overwrite, undefined);
  console.log("✓ run_command with IsDaemon: true preserves wait window");
}

// 8. schedule short polling timer (<120s): DENIED
{
  const out = runHook({ toolCall: { name: "schedule", args: { DurationSeconds: 30, Prompt: "Check on the background task" } } });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Short artificial polling timers/);
  console.log("✓ schedule short polling timer (<120s) is denied");
}

// 9. schedule watchdog timer (>=120s): ALLOWED (safe harbor for catching hung tasks)
{
  const out = runHook({ toolCall: { name: "schedule", args: { DurationSeconds: 300, Prompt: "Watchdog timer for background task", TimerCondition: "task-1" } } });
  assert.equal(out.decision, "allow");
  console.log("✓ schedule watchdog timer (>=120s) is allowed");
}

// 10. schedule with teamwork context: ALLOWED
{
  const out = runHook({ toolCall: { name: "schedule", args: { DurationSeconds: 60, Prompt: "teamwork check on subagents" } } });
  assert.equal(out.decision, "allow");
  console.log("✓ schedule with teamwork context is allowed");
}

// 11. schedule standard user timer: ALLOWED
{
  const out = runHook({ toolCall: { name: "schedule", args: { DurationSeconds: 600, Prompt: "Remind user to review PR" } } });
  assert.equal(out.decision, "allow");
  console.log("✓ schedule standard timer is allowed");
}

// 12. State TTL eviction & pruning: Stale entries (> 1 hr) automatically evicted
{
  const staleTime = Date.now() - 3700000; // 61 minutes ago
  fs.writeFileSync(stateFile, JSON.stringify({
    "test-conv-ttl:task-old": { count: 5, denials: 2, lastTime: staleTime, stepIdx: 1 }
  }), "utf-8");

  // An initial status poll for this key should now be treated as a fresh count 0 poll (ALLOWED)
  const out = runHook({
    conversationId: "test-conv-ttl",
    toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-old" } }
  });
  assert.equal(out.decision, "allow");

  const currentState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  assert.equal(currentState["test-conv-ttl:task-old"].count, 1, "Count must reset to 1 after TTL eviction");
  console.log("✓ state TTL eviction automatically purges entries older than 1 hour");
}

// 13. 3-Tier Circuit Breaker for manage_task:
// Attempt 1: Allowed (initial check)
// Attempt 2: Denied (Tier 1 standard guidance, denial 1)
// Attempt 3: Denied (Tier 1 standard guidance, denial 2)
// Attempt 4: Denied (Tier 2 critical warning, denial 3)
// Attempt 5: Denied (Tier 2 critical warning, denial 4)
// Attempt 6: force_ask (Tier 3 autonomous loop freeze, denial 5)
{
  const cbConv = "test-conv-cb";
  const cbTask = "task-stubborn";

  // 1st: Allowed
  const r1 = runHook({ conversationId: cbConv, toolCall: { name: "manage_task", args: { Action: "status", TaskId: cbTask } } });
  assert.equal(r1.decision, "allow");

  // 2nd (denial 1): Tier 1
  const r2 = runHook({ conversationId: cbConv, toolCall: { name: "manage_task", args: { Action: "status", TaskId: cbTask } } });
  assert.equal(r2.decision, "deny");
  assert.match(r2.reason, /Rapid task polling detected/);

  // 3rd (denial 2): Tier 1
  const r3 = runHook({ conversationId: cbConv, toolCall: { name: "manage_task", args: { Action: "status", TaskId: cbTask } } });
  assert.equal(r3.decision, "deny");

  // 4th (denial 3): Tier 2 (Critical warning)
  const r4 = runHook({ conversationId: cbConv, toolCall: { name: "manage_task", args: { Action: "status", TaskId: cbTask } } });
  assert.equal(r4.decision, "deny");
  assert.match(r4.reason, /\[CRITICAL CIRCUIT BREAKER: Repeated Denials \(Attempt 3\)\]/);

  // 5th (denial 4): Tier 2 (Critical warning)
  const r5 = runHook({ conversationId: cbConv, toolCall: { name: "manage_task", args: { Action: "status", TaskId: cbTask } } });
  assert.equal(r5.decision, "deny");
  assert.match(r5.reason, /\[CRITICAL CIRCUIT BREAKER: Repeated Denials \(Attempt 4\)\]/);

  // 6th (denial 5): Tier 3 (force_ask freezes autonomous loop)
  const r6 = runHook({ conversationId: cbConv, toolCall: { name: "manage_task", args: { Action: "status", TaskId: cbTask } } });
  assert.equal(r6.decision, "force_ask");
  assert.match(r6.reason, /\[CIRCUIT BREAKER ACTIVATED\] Autonomous loop suspended/);
  console.log("✓ manage_task 3-tier circuit breaker correctly escalates Tier 1 -> Tier 2 -> Tier 3 (force_ask)");
}

// 14. 3-Tier Circuit Breaker for schedule short polling timer:
{
  const schedConv = "test-conv-sched-cb";
  // Simulate 4 previous schedule denials
  fs.writeFileSync(stateFile, JSON.stringify({
    [`${schedConv}:schedule_poll`]: { denials: 4, lastTime: Date.now() }
  }), "utf-8");

  // 5th denial triggers Tier 3 force_ask
  const out = runHook({
    conversationId: schedConv,
    toolCall: { name: "schedule", args: { DurationSeconds: 30, Prompt: "check task" } }
  });
  assert.equal(out.decision, "force_ask");
  assert.match(out.reason, /\[CIRCUIT BREAKER ACTIVATED\] Autonomous loop suspended/);
  console.log("✓ schedule short polling timer escalates to force_ask on 5th denial");
}

// 15. Evasive Loophole Defense: manage_task(Action='list') rapid busy-polling
{
  const listConv = "test-conv-list";
  // 1st list call: ALLOWED
  const l1 = runHook({ conversationId: listConv, toolCall: { name: "manage_task", args: { Action: "list" } } });
  assert.equal(l1.decision, "allow");

  // Immediate consecutive list call (<15s): DENIED
  const l2 = runHook({ conversationId: listConv, toolCall: { name: "manage_task", args: { Action: "list" } } });
  assert.equal(l2.decision, "deny");
  assert.match(l2.reason, /Rapid task list polling detected/);
  console.log("✓ manage_task(Action='list') initial call allowed, rapid consecutive polling blocked");
}

console.log("\nAll 15 intelligent hook tests passed successfully!");
