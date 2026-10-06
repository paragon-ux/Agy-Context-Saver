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

console.log("\nAll 11 intelligent hook tests passed successfully!");
