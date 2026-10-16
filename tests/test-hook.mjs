import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupHermeticTestEnv, createRtkShim, prependToPath } from "./helpers/hermetic-fixture.mjs";
import { getStateDir } from "../scripts/state-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.resolve(__dirname, "../scripts/execution-guard-hook.mjs");
const hermetic = await setupHermeticTestEnv({ installProfile: false });
process.env.AGY_FORCE_WAYMARK = "1";
// The hook keeps its state in the per-user state folder (rooted in the hermetic profile), never in os.tmpdir()
const stateDir = getStateDir();
const stateFile = path.join(stateDir, "agy-session-governance-state.json");

function resetState() {
  try {
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    const rewriteCache = path.join(stateDir, "agy-rtk-rewrite-cache.json");
    if (fs.existsSync(rewriteCache)) fs.unlinkSync(rewriteCache);
    for (const f of fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : []) {
      if (f.startsWith("agy-session-") && f.endsWith(".json")) {
        try { fs.unlinkSync(path.join(stateDir, f)); } catch {}
      }
    }
  } catch {}
}

function runHook(payload, customEnv = process.env) {
  const result = spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: customEnv
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

// 1b. run_command: bare pytest rewrites to rtk pytest with native semantics (LH-11)
{
  const out = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "pytest", WaitMsBeforeAsync: 2000 } }
  });
  assert.equal(out.decision, "allow");
  assert.equal(out.overwrite?.CommandLine, "rtk pytest", "Bare pytest rewrites natively without forced -x");
  console.log("✓ run_command('pytest') rewrites to 'rtk pytest' preserving native semantics");
}

// 1c. run_command: opt-in fail-fast flags (-x) are preserved cleanly (LH-11)
{
  const out = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "pytest -x", WaitMsBeforeAsync: 2000 } }
  });
  assert.equal(out.decision, "allow");
  assert.equal(out.overwrite?.CommandLine, "rtk pytest -x", "Opt-in -x flag must be preserved");
  console.log("✓ run_command('pytest -x') preserves opt-in fail-fast flag");
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

// 3b. run_command: shell wrapper unwrapping (cmd /c, powershell -Command) (LH-01-B)
{
  const outCmd = runHook({
    toolCall: { name: "run_command", args: { CommandLine: 'cmd /c "git status"', WaitMsBeforeAsync: 1000 } }
  });
  assert.equal(outCmd.decision, "allow");
  assert.equal(outCmd.overwrite?.CommandLine, 'cmd /c "rtk git status"');

  const outPs = runHook({
    toolCall: { name: "run_command", args: { CommandLine: 'powershell -Command "git status"', WaitMsBeforeAsync: 1000 } }
  });
  assert.equal(outPs.decision, "allow");
  assert.equal(outPs.overwrite?.CommandLine, 'powershell -Command "rtk git status"');

  console.log("✓ run_command unwraps shell wrappers (cmd /c, powershell -Command) for RTK (LH-01-B closed)");
}

// 3b. run_command: rewrite caching in the per-user state folder
{
  const cacheFile = path.join(stateDir, "agy-rtk-rewrite-cache.json");
  assert.ok(stateDir.startsWith(process.env.AGY_TEST_PROFILE_DIR), "State folder must resolve inside the hermetic profile");
  assert.ok(fs.existsSync(cacheFile), "Rewrite cache file should exist in the state folder after prior rewrites (hook and scripts/state-dir.mjs must agree)");
  const cache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
  assert.equal(cache["git status"], "rtk git status", "Cache must store git status rewrite");

  const outCached = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 1000 } }
  });
  assert.equal(outCached.decision, "allow");
  assert.equal(outCached.overwrite?.CommandLine, "rtk git status");
  console.log("✓ run_command uses LRU rewrite cache on repeat invocations");
}

// 3c. run_command: incompatible PATH rtk falls back to compatible local binary with explicit path (D-03, D-09)
{
  const tempFallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-rtk-fallback-"));
  try {
    const badPathDir = path.join(tempFallbackRoot, "bad-path-bin");
    const tempProfile = path.join(tempFallbackRoot, "profile");
    const localPluginBin = path.join(tempProfile, ".gemini", "config", "plugins", "agy-context-saver", "bin");
    createRtkShim(badPathDir, "0.60.0");
    const localGoodBin = createRtkShim(localPluginBin, "0.51.0");
    const expectedPrefix = localGoodBin.replace(/\\/g, "/");

    const customEnv = { ...process.env, AGY_TEST_PROFILE_DIR: tempProfile };
    prependToPath(badPathDir, customEnv);

    const outFallback = runHook(
      { toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 1000 } } },
      customEnv
    );
    assert.equal(outFallback.decision, "allow");
    assert.ok(
      outFallback.overwrite?.CommandLine?.includes(expectedPrefix),
      `Expected rewritten command to use compatible local binary (${expectedPrefix}), got: ${outFallback.overwrite?.CommandLine}`
    );
    console.log("✓ run_command bypasses incompatible PATH rtk (0.60.0) and rewrites with compatible local binary path");
  } finally {
    resetState();
    try { fs.rmSync(tempFallbackRoot, { recursive: true, force: true }); } catch {}
  }
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

// 6. Unbounded view_file on workspace source file: Waymark-first denial vs RTK fallback when Waymark unavailable
{
  const outWaymark = runHook({
    toolCall: { name: "view_file", args: { AbsolutePath: "c:/project/src/session_engine.py" } }
  });
  assert.equal(outWaymark.decision, "deny");
  assert.match(outWaymark.reason, /waymark_ask\(\.\.\., plain: true\)/);
  assert.doesNotMatch(outWaymark.reason, /rtk read/);

  const outFallback = runHook(
    { toolCall: { name: "view_file", args: { AbsolutePath: "c:/project/src/session_engine.py" } } },
    { ...process.env, AGY_FORCE_WAYMARK: "0" }
  );
  assert.equal(outFallback.decision, "deny");
  assert.match(outFallback.reason, /run 'rtk read c:\/project\/src\/session_engine\.py' via run_command instead/);
  console.log("✓ unbounded view_file recommends waymark_ask when Waymark installed, and RTK fallback when unavailable");
}

// 6b. view_file with bounded slice (1-150 lines) is ALLOWED
{
  const out = runHook({
    toolCall: {
      name: "view_file",
      args: { AbsolutePath: "c:/project/src/session_engine.py", StartLine: 10, EndLine: 50 }
    }
  });
  assert.equal(out.decision, "allow");
  console.log("✓ view_file with bounded slice (StartLine: 10, EndLine: 50) is ALLOWED");
}

// 6c. Hybrid Full-File & Partial Slice Policy (151-800 partial deny, <=800L & <=45KiB full-file allow, >800L or >45KiB deny)
{
  const tmpHybridDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hybrid-slice-"));
  try {
    // Medium file: 300 lines, ~6 KiB (<= 800 lines and <= 45 KiB)
    const mediumFile = path.join(tmpHybridDir, "medium_service.mjs");
    fs.writeFileSync(mediumFile, Array.from({ length: 300 }, (_, i) => `export const line_${i + 1} = ${i + 1};`).join("\n") + "\n", "utf-8");

    // Partial slice of 151-800 lines (e.g., 1..200 on a 300-line file, or 10..200) -> DENY
    const outPartial1 = runHook({
      toolCall: { name: "view_file", args: { AbsolutePath: mediumFile, StartLine: 1, EndLine: 200 } }
    });
    assert.equal(outPartial1.decision, "deny");
    assert.match(outPartial1.reason, /Oversized partial file slice via 'view_file'/);

    const outPartial2 = runHook({
      toolCall: { name: "view_file", args: { AbsolutePath: mediumFile, StartLine: 50, EndLine: 300 } }
    });
    assert.equal(outPartial2.decision, "deny");
    assert.match(outPartial2.reason, /Oversized partial file slice via 'view_file'/);

    // Claiming EndLine larger than actual file (e.g., 1..500 on a 300-line file) -> DENY
    const outFakeEnd = runHook({
      toolCall: { name: "view_file", args: { AbsolutePath: mediumFile, StartLine: 1, EndLine: 500 } }
    });
    assert.equal(outFakeEnd.decision, "deny");
    assert.match(outFakeEnd.reason, /Oversized partial file slice via 'view_file'/);

    // Explicit full-file read (StartLine: 1, EndLine: 300) on 300-line, ~6 KiB file -> ALLOW
    const outFullAllowed = runHook({
      toolCall: { name: "view_file", args: { AbsolutePath: mediumFile, StartLine: 1, EndLine: 300 } }
    });
    assert.equal(outFullAllowed.decision, "allow");

    // File exceeding 800 lines (850 lines, ~17 KiB) with explicit full-file bounds -> DENY
    const longFile = path.join(tmpHybridDir, "long_service.mjs");
    fs.writeFileSync(longFile, Array.from({ length: 850 }, (_, i) => `export const v_${i + 1} = ${i + 1};`).join("\n") + "\n", "utf-8");
    const outLongDenied = runHook({
      toolCall: { name: "view_file", args: { AbsolutePath: longFile, StartLine: 1, EndLine: 850 } }
    });
    assert.equal(outLongDenied.decision, "deny");
    assert.match(outLongDenied.reason, /Explicit full-file read via 'view_file'.*exceeds the full-file audit ceiling/);

    // File <= 800 lines (250 lines) but exceeding 45 KiB (~50 KiB) with explicit full-file bounds -> DENY
    const heavyFile = path.join(tmpHybridDir, "heavy_bundle.mjs");
    fs.writeFileSync(heavyFile, Array.from({ length: 250 }, () => "x".repeat(210)).join("\n") + "\n", "utf-8");
    const outHeavyDenied = runHook({
      toolCall: { name: "view_file", args: { AbsolutePath: heavyFile, StartLine: 1, EndLine: 250 } }
    });
    assert.equal(outHeavyDenied.decision, "deny");
    assert.match(outHeavyDenied.reason, /Explicit full-file read via 'view_file'.*exceeds the full-file audit ceiling/);

    console.log("✓ hybrid slice policy verified: 151-800 partial denied, explicit full-file <=800L & <=45KiB allowed, >800L or >45KiB denied");
  } finally {
    try { fs.rmSync(tmpHybridDir, { recursive: true, force: true }); } catch {}
  }
}

// 6d. view_file with bounded slice or full-file bounds on .system_generated remains strictly denied by root
{
  const out = runHook({
    toolCall: {
      name: "view_file",
      args: {
        AbsolutePath: "C:/Users/USER/.gemini/antigravity/brain/abc/.system_generated/logs/transcript.jsonl",
        StartLine: 1,
        EndLine: 10
      }
    }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Direct access to internal Antigravity execution state \(\.system_generated\)/);
  console.log("✓ view_file with bounded slice on .system_generated remains STRICTLY DENIED");
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

// 13b. run_command: direct shell access to .system_generated is DENIED (LH-02-B)
{
  const outCat = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "cat .system_generated/logs/transcript.jsonl" } }
  });
  assert.equal(outCat.decision, "deny");
  assert.match(outCat.reason, /Direct shell access to internal Antigravity execution state/);

  const outGc = runHook({
    toolCall: { name: "run_command", args: { CommandLine: 'Get-Content "C:/brain/.system_generated/tasks/task-1.log"' } }
  });
  assert.equal(outGc.decision, "deny");
  assert.match(outGc.reason, /Direct shell access to internal Antigravity execution state/);

  console.log("✓ run_command direct shell access to .system_generated denied (LH-02-B closed)");
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

// 20. manage_task status: second check on same task is DENIED (proportional backoff)
{
  const out = runHook({ conversationId: convId, toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-A" } } });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Proportional Backoff Active/);
  assert.match(out.reason, /1 denial/);
  console.log("✓ manage_task second check on same task denied under Proportional Backoff (1 denial)");
}

// 21. LH-06: Changing task ID does NOT reset session denial counter!
{
  const out = runHook({ conversationId: convId, toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-B" } } });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /2 denials/);
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
  assert.match(out.reason, /3 denials/);
  console.log("✓ debug/stuck/timeout keywords do NOT bypass governance (LH-04 closed)");
}

// 23. LH-03: Task watchdog timer shorter than required backoff (< 30s) is DENIED!
{
  const out = runHook({
    conversationId: convId,
    toolCall: {
      name: "schedule",
      args: { DurationSeconds: 15, Prompt: "Check on background task-1542", TimerCondition: "task-1542" }
    }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Task watchdog timer duration too short/);
  assert.match(out.reason, /4 denials/);
  console.log("✓ task watchdog timer < 30s is strictly denied (LH-03 closed)");
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

// 25b. Task watchdog timer meeting backoff requirement (>= 30s) is ALLOWED
{
  const out = runHook({
    conversationId: "conv-watchdog-allowed",
    toolCall: {
      name: "schedule",
      args: { DurationSeconds: 60, Prompt: "Check on background task-1542", TimerCondition: "task-1542" }
    }
  });
  assert.equal(out.decision, "allow");
  console.log("✓ task watchdog timer meeting backoff requirement (>= 30s) is allowed");
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

// 27b. run_command mutation of evaluator triggers force_ask (LH-09-B)
{
  const out = runHook({
    toolCall: {
      name: "run_command",
      args: { CommandLine: 'echo "score=1.0" > c:/project/evaluators/eval_accuracy.py' }
    }
  });
  assert.equal(out.decision, "force_ask");
  assert.match(out.reason, /BENCHMARK MUTATION DETECTED/);
  console.log("✓ shell command mutation of evaluator triggers force_ask (LH-09-B closed)");
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

// Step 4: Model tried short watchdog timer (15s) to wait in foreground -> BLOCKED
const s4 = runHook({
  conversationId: incidentConv,
  toolCall: {
    name: "schedule",
    args: { DurationSeconds: 15, Prompt: "Check on task-1542", TimerCondition: "task-1542" }
  }
});
assert.equal(s4.decision, "deny");
assert.match(s4.reason, /Task watchdog timer duration too short/);
console.log("  Replay Step 4: short schedule timer on task (< 30s) -> blocked by backoff coordination");

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

// Step 7: Model tried reading repository files 36x via unbounded view_file -> ROUTED TO WAYMARK + BOUNDED SLICE
const s7 = runHook({
  conversationId: incidentConv,
  toolCall: { name: "view_file", args: { AbsolutePath: "C:/project/session_engine.py" } }
});
assert.equal(s7.decision, "deny");
assert.match(s7.reason, /waymark_ask\(\.\.\., plain: true\)/);
console.log("  Replay Step 7: unbounded view_file('session_engine.py') -> routed to 'waymark_ask' + bounded slice");

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
console.log("\nAll 27 comprehensive closed-topology governance tests passed successfully!");
process.exit(0);
