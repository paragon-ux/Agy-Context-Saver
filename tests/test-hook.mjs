import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.resolve(__dirname, "../scripts/execution-guard-hook.mjs");

function runHook(payload) {
  const result = spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify(payload),
    encoding: "utf-8"
  });
  assert.equal(result.status, 0, `Hook exited with code ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

console.log("Running Agy-Context-Saver hook tests...\n");

// 1. manage_task status denied
{
  const out = runHook({ toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-1" } } });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Background polling with manage_task\('status'\) is denied/);
  console.log("✓ manage_task(status) is denied");
}

// 2. manage_task kill allowed
{
  const out = runHook({ toolCall: { name: "manage_task", args: { Action: "kill", TaskId: "task-1" } } });
  assert.equal(out.decision, "allow");
  console.log("✓ manage_task(kill) is allowed");
}

// 3. run_command overwrites WaitMsBeforeAsync
{
  const out = runHook({ toolCall: { name: "run_command", args: { CommandLine: "pytest", WaitMsBeforeAsync: 2000 } } });
  assert.equal(out.decision, "allow");
  assert.equal(out.overwrite?.WaitMsBeforeAsync, 10000);
  console.log("✓ run_command upgrades WaitMsBeforeAsync to 10000");
}

// 4. run_command daemon not overwritten
{
  const out = runHook({ toolCall: { name: "run_command", args: { CommandLine: "dev-server", IsDaemon: true, WaitMsBeforeAsync: 500 } } });
  assert.equal(out.decision, "allow");
  assert.equal(out.overwrite, undefined);
  console.log("✓ run_command with IsDaemon: true preserves wait window");
}

// 5. schedule polling timer denied
{
  const out = runHook({ toolCall: { name: "schedule", args: { DurationSeconds: 30, Prompt: "Check on the background task" } } });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Using schedule as a polling timer/);
  console.log("✓ schedule with task polling prompt is denied");
}

// 6. schedule standard user timer allowed
{
  const out = runHook({ toolCall: { name: "schedule", args: { DurationSeconds: 600, Prompt: "Remind user to review PR" } } });
  assert.equal(out.decision, "allow");
  console.log("✓ schedule standard timer is allowed");
}

console.log("\nAll 6 tests passed successfully!");
