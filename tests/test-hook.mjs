import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.resolve(__dirname, "../scripts/execution-guard-hook.mjs");
const stateFile = path.join(os.tmpdir(), "agy-session-governance-state.json");

function resetState() {
  try {
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    const rewriteCache = path.join(os.tmpdir(), "agy-rtk-rewrite-cache.json");
    if (fs.existsSync(rewriteCache)) fs.unlinkSync(rewriteCache);
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith("agy-session-") && f.endsWith(".json")) {
        try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch {}
      }
    }
  } catch {}
}

function runHook(payload) {
  const result = spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify(payload),
    encoding: "utf-8"
  });
  assert.equal(result.status, 0, `Hook exited with code ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

console.log("Running Agy-Context-Saver Closed Execution Governance Hook Tests...\n");
resetState();

// ============================================================================
// GROUP A: RTK Integration & Command Rewriting (LH-01)
// ============================================================================
console.log("--- Group A: RTK Integration & Command Rewriting ---");

// 1. run_command: optimizable command rewritten to rtk
{
  const out = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 2000 } }
  });
  assert.equal(out.decision, "allow");
  assert.equal(out.overwrite?.CommandLine, "rtk git status", "Must rewrite 'git status' to 'rtk git status'");
  assert.equal(out.overwrite?.WaitMsBeforeAsync, 10000, "Must upgrade WaitMsBeforeAsync to 10000");
  console.log("✓ run_command('git status') transparently rewritten to 'rtk git status'");
}

// 2. run_command: already prefixed with rtk is preserved
{
  const out = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "rtk read src/index.js", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(out.decision, "allow");
  assert.equal(out.overwrite?.CommandLine, undefined, "CommandLine must not be double-prefixed");
  assert.equal(out.overwrite?.WaitMsBeforeAsync, 10000);
  console.log("✓ run_command with existing 'rtk ' prefix is preserved without duplicate wrapping");
}

// 3. run_command: unsupported command falls back gracefully
{
  const out = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "custom_proprietary_tool --arg1", WaitMsBeforeAsync: 500 } }
  });
  assert.equal(out.decision, "allow");
  assert.equal(out.overwrite?.CommandLine, undefined, "Unsupported command must not be rewritten");
  assert.equal(out.overwrite?.WaitMsBeforeAsync, 10000);
  console.log("✓ run_command with unsupported command falls back gracefully to raw command");
}

// 3a. run_command: fast-path shell builtin bypass (node, powershell, dir)
{
  const outNode = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "node -e 'console.log(1)'", WaitMsBeforeAsync: 1000 } }
  });
  assert.equal(outNode.decision, "allow");
  assert.equal(outNode.overwrite?.CommandLine, undefined, "Node command must not be rewritten");
  assert.equal(outNode.overwrite?.WaitMsBeforeAsync, 10000);

  const outPs = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "powershell Get-Process", WaitMsBeforeAsync: 1000 } }
  });
  assert.equal(outPs.decision, "allow");
  assert.equal(outPs.overwrite?.CommandLine, undefined, "PowerShell command must not be rewritten");

  console.log("✓ run_command fast-path bypasses non-rewritable shell builtins and utilities");
}

// 3b. run_command: rewrite caching in tmpdir
{
  const cacheFile = path.join(os.tmpdir(), "agy-rtk-rewrite-cache.json");
  assert.ok(fs.existsSync(cacheFile), "Rewrite cache file should exist after prior rewrites");
  const cache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
  assert.equal(cache["git status"], "rtk git status", "Cache must store git status rewrite");

  const outCached = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 1000 } }
  });
  assert.equal(outCached.decision, "allow");
  assert.equal(outCached.overwrite?.CommandLine, "rtk git status");
  console.log("✓ run_command uses LRU rewrite cache on repeat invocations");
}

// 4. run_command: daemon process preserves custom wait window
{
  const out = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "npm run dev", IsDaemon: true, WaitMsBeforeAsync: 500 } }
  });
  assert.equal(out.decision, "allow");
  assert.equal(out.overwrite?.WaitMsBeforeAsync, undefined, "Daemon process wait must not be upgraded");
  console.log("✓ run_command with IsDaemon: true preserves wait window");
}

// 5. run_command: missing CommandLine fails closed
{
  const out = runHook({
    toolCall: { name: "run_command", args: {} }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Missing or empty CommandLine/);
  console.log("✓ run_command with empty arguments fails closed (denied)");
}

// ============================================================================
// GROUP B: Native Inspection Hard-Routing to RTK (LH-07)
// ============================================================================
console.log("\n--- Group B: Native Inspection Hard-Routing to RTK ---");

// 6. view_file on workspace source file is hard-routed to rtk read
{
  const out = runHook({
    toolCall: { name: "view_file", args: { AbsolutePath: "c:/project/src/session_engine.py" } }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Run 'rtk read c:\/project\/src\/session_engine\.py' via run_command instead/);
  console.log("✓ view_file on workspace file hard-routed to 'rtk read'");
}

// 7. read_file is hard-routed to rtk read
{
  const out = runHook({
    toolCall: { name: "read_file", args: { targetFile: "c:/project/src/index.js" } }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Run 'rtk read c:\/project\/src\/index\.js' via run_command instead/);
  console.log("✓ read_file hard-routed to 'rtk read'");
}

// 8. read_many_files is hard-routed to rtk read
{
  const out = runHook({
    toolCall: { name: "read_many_files", args: { paths: ["a.js", "b.js"] } }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /read_many_files.*Run 'rtk read <file>'/);
  console.log("✓ read_many_files hard-routed to 'rtk read'");
}

// 9. grep_search is hard-routed to rtk grep / rtk rg
{
  const out = runHook({
    toolCall: { name: "grep_search", args: { query: "export function handleRequest" } }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Run '(?:rtk rg "export function handleRequest" \.|rtk grep "export function handleRequest")' via run_command instead/);
  console.log("✓ grep_search hard-routed to 'rtk grep' / 'rtk rg'");
}

// 10. find_by_name is hard-routed to rtk find
{
  const out = runHook({
    toolCall: { name: "find_by_name", args: { query: "*.py" } }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Run 'rtk find \*\.py' via run_command instead/);
  console.log("✓ find_by_name hard-routed to 'rtk find'");
}

// 11. list_dir is hard-routed to rtk ls / rtk find
{
  const out = runHook({
    toolCall: { name: "list_dir", args: { dirPath: "c:/project/tests" } }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Run '(?:rtk find c:\/project\/tests|rtk ls c:\/project\/tests)'/);
  console.log("✓ list_dir hard-routed to 'rtk find' / 'rtk ls'");
}

// ============================================================================
// GROUP C: Protected Antigravity State vs Special Files (LH-02)
// ============================================================================
console.log("\n--- Group C: Protected Antigravity State vs Special Files ---");

// 12. view_file on transcript.jsonl: HARD DENIAL
{
  const p = "C:/Users/USER/.gemini/antigravity/brain/sess-123/.system_generated/logs/transcript.jsonl";
  const out = runHook({ toolCall: { name: "view_file", args: { AbsolutePath: p } } });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Direct access to internal Antigravity execution state \(\.system_generated\) is strictly prohibited/);
  assert.match(out.reason, /read_transcript/);
  console.log("✓ view_file on transcript.jsonl strictly denied by root");
}

// 13. view_file on task-1521.log: HARD DENIAL (LH-02 permanently closed)
{
  const p = "C:/Users/USER/.gemini/antigravity/brain/sess-123/.system_generated/tasks/task-1521.log";
  const out = runHook({ toolCall: { name: "view_file", args: { AbsolutePath: p } } });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /\.system_generated/);
  assert.match(out.reason, /rely on native Reactive Wakeup/);
  console.log("✓ view_file on task-1521.log strictly denied (LH-02 closed)");
}

// 14. view_file on arbitrary future .system_generated file: HARD DENIAL
{
  const p = "C:/Users/USER/.gemini/antigravity/brain/sess-123/.system_generated/scheduler/future_state.json";
  const out = runHook({ toolCall: { name: "view_file", args: { AbsolutePath: p } } });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /\.system_generated/);
  console.log("✓ view_file on future internal .system_generated file denied by root");
}

// 15. view_file on SKILL.md: ALLOWED (special file safe harbor)
{
  const p = "C:/Users/USER/.gemini/antigravity/builtin/skills/antigravity_guide/SKILL.md";
  const out = runHook({ toolCall: { name: "view_file", args: { AbsolutePath: p } } });
  assert.equal(out.decision, "allow");
  console.log("✓ view_file on SKILL.md allowed under special file safe harbor");
}

// 16. view_file on brain markdown artifact: ALLOWED
{
  const p = "C:/Users/USER/.gemini/antigravity/brain/sess-123/implementation_report.md";
  const out = runHook({ toolCall: { name: "view_file", args: { AbsolutePath: p } } });
  assert.equal(out.decision, "allow");
  console.log("✓ view_file on brain artifact allowed");
}

// 17. view_file on AGENTS.md rulebook: ALLOWED
{
  const p = "C:/Users/USER/Desktop/Frameworks/Agy-Context-Saver/rules/AGENTS.md";
  const out = runHook({ toolCall: { name: "view_file", args: { AbsolutePath: p } } });
  assert.equal(out.decision, "allow");
  console.log("✓ view_file on AGENTS.md rulebook allowed");
}

// ============================================================================
// GROUP D: Lifecycle Governance & Reactive Wakeup (LH-03, LH-04, LH-05, LH-06)
// ============================================================================
console.log("\n--- Group D: Lifecycle Governance & Reactive Wakeup ---");
resetState();

const convId = "conv-replay-lifecycle";

// 18. manage_task kill & send_input: ALWAYS ALLOWED
{
  const k = runHook({ conversationId: convId, toolCall: { name: "manage_task", args: { Action: "kill", TaskId: "t1" } } });
  const s = runHook({ conversationId: convId, toolCall: { name: "manage_task", args: { Action: "send_input", TaskId: "t1", Input: "y" } } });
  assert.equal(k.decision, "allow");
  assert.equal(s.decision, "allow");
  console.log("✓ manage_task kill and send_input are always allowed");
}

// 19. manage_task status: initial check in session is allowed
{
  const out = runHook({ conversationId: convId, toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-A" } } });
  assert.equal(out.decision, "allow");
  console.log("✓ manage_task initial status check in session allowed");
}

// 20. manage_task status: second check on same task is DENIED
{
  const out = runHook({ conversationId: convId, toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-A" } } });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Background task polling is prohibited/);
  console.log("✓ manage_task second check on same task denied (1 denial)");
}

// 21. LH-06: Changing task ID does NOT reset session denial counter!
{
  const out = runHook({ conversationId: convId, toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-B" } } });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /2 denial/);
  console.log("✓ changing TaskId does NOT reset session ledger (LH-06 closed)");
}

// 22. LH-04: Adding debug/stuck/timeout keywords does NOT grant immunity!
{
  const out = runHook({
    conversationId: convId,
    toolCall: {
      name: "manage_task",
      args: { Action: "status", TaskId: "task-C", Reason: "debug hung and stuck process timeout investigation" }
    }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /3 denial/);
  console.log("✓ debug/stuck/timeout keywords do NOT bypass governance (LH-04 closed)");
}

// 23. LH-03: Long schedule timers (>= 120s, e.g. 180s) on tasks are DENIED!
{
  const out = runHook({
    conversationId: convId,
    toolCall: {
      name: "schedule",
      args: { DurationSeconds: 180, Prompt: "Check on background task-1542", TimerCondition: "task-1542" }
    }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Scheduling timers to poll or monitor background tasks is prohibited regardless of duration/);
  console.log("✓ schedule timer with duration >= 120s is strictly denied (LH-03 closed)");
}

// 24. Circuit Breaker Tier 3: 5th cumulative denial triggers force_ask!
{
  const out = runHook({
    conversationId: convId,
    toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-D" } }
  });
  assert.equal(out.decision, "force_ask");
  assert.match(out.reason, /\[CIRCUIT BREAKER ACTIVATED\] Autonomous loop suspended/);
  console.log("✓ 5th cumulative polling denial triggers force_ask autonomous loop suspension");
}

// 25. Standard non-polling user reminder is ALLOWED
{
  const out = runHook({
    conversationId: "conv-user-reminder",
    toolCall: {
      name: "schedule",
      args: { DurationSeconds: 600, Prompt: "Remind the user to stretch", TimerCondition: "never" }
    }
  });
  assert.equal(out.decision, "allow");
  console.log("✓ standard non-polling user reminder is allowed");
}

// ============================================================================
// GROUP E: Benchmark Mutation Protection (LH-09)
// ============================================================================
console.log("\n--- Group E: Benchmark Mutation Protection ---");

// 26. replace_file_content on evaluator requires explicit user approval
{
  const out = runHook({
    toolCall: {
      name: "replace_file_content",
      args: { TargetFile: "c:/project/evaluators/eval_accuracy.py", TargetContent: "foo", ReplacementContent: "bar" }
    }
  });
  assert.equal(out.decision, "force_ask");
  assert.match(out.reason, /\[BENCHMARK MUTATION DETECTED\].*requires explicit user confirmation/);
  console.log("✓ mutation of evaluator artifact triggers force_ask (LH-09 closed)");
}

// 27. write_to_file on prompt templates requires explicit user approval
{
  const out = runHook({
    toolCall: {
      name: "write_to_file",
      args: { TargetFile: "c:/project/benchmarks/prompt_templates/eval_14_02.json", CodeContent: "{}" }
    }
  });
  assert.equal(out.decision, "force_ask");
  assert.match(out.reason, /BENCHMARK MUTATION DETECTED/);
  console.log("✓ mutation of prompt template artifact triggers force_ask");
}

// 28. Normal workspace code edit is ALLOWED
{
  const out = runHook({
    toolCall: {
      name: "replace_file_content",
      args: { TargetFile: "c:/project/src/models/user.py", TargetContent: "foo", ReplacementContent: "bar" }
    }
  });
  assert.equal(out.decision, "allow");
  console.log("✓ normal workspace source edit is allowed without interference");
}

// ============================================================================
// GROUP F: Historical Escape Replay (Incident 609d4489-2e7f-44b0-8170-390ee67cad97)
// ============================================================================
console.log("\n--- Group F: Historical Escape Sequence Replay ---");
resetState();
const incidentConv = "conv-incident-609d4489";

// Step 1: Model ran native run_command -> NOW transparently rewritten to RTK
const s1 = runHook({
  conversationId: incidentConv,
  toolCall: { name: "run_command", args: { CommandLine: "pytest tests/test_bench.py" } }
});
assert.equal(s1.decision, "allow");
assert.equal(s1.overwrite?.CommandLine, "rtk pytest tests/test_bench.py");
console.log("  Replay Step 1: run_command('pytest') -> rewritten to 'rtk pytest'");

// Step 2: Model polled status on task-1521 -> Allowed once, then locked
const s2a = runHook({
  conversationId: incidentConv,
  toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-1521" } }
});
assert.equal(s2a.decision, "allow");
const s2b = runHook({
  conversationId: incidentConv,
  toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-1521" } }
});
assert.equal(s2b.decision, "deny");
console.log("  Replay Step 2: manage_task('task-1521') subsequent poll -> denied");

// Step 3: Model tried to route-around by reading task-1521.log via view_file -> BLOCKED
const s3 = runHook({
  conversationId: incidentConv,
  toolCall: {
    name: "view_file",
    args: { AbsolutePath: "C:/Users/USER/.gemini/antigravity/brain/conv-incident-609d4489/.system_generated/tasks/task-1521.log" }
  }
});
assert.equal(s3.decision, "deny");
console.log("  Replay Step 3: view_file on task-1521.log -> blocked by root guard");

// Step 4: Model tried long watchdog timer (180s) to wait in foreground -> BLOCKED
const s4 = runHook({
  conversationId: incidentConv,
  toolCall: {
    name: "schedule",
    args: { DurationSeconds: 180, Prompt: "Check on task-1542", TimerCondition: "task-1542" }
  }
});
assert.equal(s4.decision, "deny");
console.log("  Replay Step 4: 180s schedule timer on task -> blocked regardless of duration");

// Step 5: Model tried switching task IDs to task-1581 -> BLOCKED (session ledger)
const s5 = runHook({
  conversationId: incidentConv,
  toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-1581" } }
});
assert.equal(s5.decision, "deny");
console.log("  Replay Step 5: status poll on new task-1581 -> blocked by session ledger");

// Step 6: Model added 'diagnose timeout' debug keywords -> BLOCKED
const s6 = runHook({
  conversationId: incidentConv,
  toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-1587", Reason: "diagnose timeout" } }
});
assert.equal(s6.decision, "deny");
console.log("  Replay Step 6: status poll with 'diagnose timeout' -> blocked");

// Step 7: Model tried reading repository files 36x via view_file -> ROUTED TO RTK READ
const s7 = runHook({
  conversationId: incidentConv,
  toolCall: { name: "view_file", args: { AbsolutePath: "C:/project/session_engine.py" } }
});
assert.equal(s7.decision, "deny");
assert.match(s7.reason, /rtk read/);
console.log("  Replay Step 7: view_file('session_engine.py') -> routed to 'rtk read'");

// Step 8: Model tried mutating evaluator to overfit benchmark -> FORCE_ASK
const s8 = runHook({
  conversationId: incidentConv,
  toolCall: {
    name: "replace_file_content",
    args: { TargetFile: "C:/project/evaluators/scoring.py", TargetContent: "x", ReplacementContent: "y" }
  }
});
assert.equal(s8.decision, "force_ask");
console.log("  Replay Step 8: benchmark mutation -> gated with force_ask");

// Step 9: Normal code fix is ALLOWED
const s9 = runHook({
  conversationId: incidentConv,
  toolCall: {
    name: "replace_file_content",
    args: { TargetFile: "C:/project/src/logic.py", TargetContent: "x", ReplacementContent: "y" }
  }
});
assert.equal(s9.decision, "allow");
console.log("  Replay Step 9: normal application code change -> allowed");

resetState();
console.log("\nAll 28 comprehensive closed-topology governance tests passed successfully!");
process.exit(0);
