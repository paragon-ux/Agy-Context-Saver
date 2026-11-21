import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findExistingRtk } from "../scripts/provision-rtk.mjs";
import { createRtkShim, prependToPath, runRtkCli, withEnvPath } from "./helpers/hermetic-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.resolve(__dirname, "../scripts/execution-guard-hook.mjs");

console.log("=================================================");
console.log("Agy-Context-Saver RTK >= 1.1.0 Contract & Integration Tests");
console.log("=================================================\n");

function runHook(payload, env) {
  const res = spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env
  });
  assert.equal(res.status, 0, `Hook failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-rtk-int-"));

try {
  process.env.AGY_TEST_PROFILE_DIR = tempDir;
  const hostRtk = findExistingRtk({ silent: true });
  let testEnv = { ...process.env, AGY_TEST_PROFILE_DIR: tempDir };
  let modeLabel = "LIVE HOST RTK";

  if (!hostRtk) {
    // Offline CI fallback without preinstalled rtk >= 1.1.0
    const shimDir = path.join(tempDir, "shim-bin");
    createRtkShim(shimDir, "1.1.0");
    prependToPath(shimDir, testEnv);
    modeLabel = "SHIM RTK 1.1.0 (no host rtk >= 1.1.0 on PATH)";
  } else {
    console.log(`Found compatible host RTK: ${hostRtk.version} at ${hostRtk.path}`);
  }

  console.log(`--- Testing against ${modeLabel} ---`);

  // 1. Compound command rewriting via real `rtk hook antigravity` + lossy revert check
  const compoundOut = runHook(
    { toolCall: { name: "run_command", args: { CommandLine: "git status && ls -la", WaitMsBeforeAsync: 5000 } } },
    testEnv
  );
  assert.equal(compoundOut.decision, "allow");
  assert.ok(compoundOut.overwrite?.CommandLine, "Expected CommandLine overwrite");
  assert.match(compoundOut.overwrite.CommandLine, /^rtk git status\b/, "git status segment must be rewritten");
  assert.equal(/\brtk\s+ls\b/.test(compoundOut.overwrite.CommandLine), false, "Lossy rtk ls rewrite must be reverted");
  console.log(`✓ Compound 'git status && ls -la' -> '${compoundOut.overwrite.CommandLine}'`);

  // 2. Shell wrapper `bash -c 'git status && cat package.json'` (Narrow Pre-Gate rewrites git status, keeps workspace cat lossless)
  const wrapperOut = runHook(
    { toolCall: { name: "run_command", args: { CommandLine: "bash -c 'git status && cat package.json'", WaitMsBeforeAsync: 5000 } } },
    testEnv
  );
  assert.equal(wrapperOut.decision, "allow");
  assert.match(wrapperOut.overwrite?.CommandLine || "", /rtk git status && cat package\.json/);
  console.log(`✓ Shell wrapper pre-gated cleanly -> '${wrapperOut.overwrite?.CommandLine}'`);

  // 2b. Narrow High-ROI Pre-Gate: noisy runners delegated; precision inspection commands stay untouched
  for (const [rawCmd, expectPrefix] of [
    ["pytest tests/", /^rtk pytest\b/],
    ["cargo test --lib", /^rtk cargo test\b/],
    ["npm run test", /^rtk npm run test\b/],
    ["vitest run", /^rtk vitest\b/]
  ]) {
    const out = runHook(
      { toolCall: { name: "run_command", args: { CommandLine: rawCmd, WaitMsBeforeAsync: 5000 } } },
      testEnv
    );
    assert.equal(out.decision, "allow");
    assert.match(out.overwrite?.CommandLine || "", expectPrefix, `High-ROI runner '${rawCmd}' must delegate to RTK`);
  }
  for (const losslessCmd of [
    "find . -maxdepth 2 -name '*.mjs'",
    "git diff HEAD~1",
    "git -C scripts diff",
    "git show HEAD",
    "git log -p -1",
    "git status --porcelain",
    "ps aux",
    "cat package.json",
    "pytest tests/ | tail -n 20"
  ]) {
    const out = runHook(
      { toolCall: { name: "run_command", args: { CommandLine: losslessCmd, WaitMsBeforeAsync: 5000 } } },
      testEnv
    );
    assert.equal(out.decision, "allow");
    assert.equal(out.overwrite?.CommandLine, undefined, `Precision/piped command '${losslessCmd}' must stay unrewritten under Narrow Pre-Gate`);
  }
  console.log("✓ Narrow High-ROI Pre-Gate verified across high-ROI runners vs lossless inspection/piped commands");

  // 2c. Decision B1: AGY_RTK_MODE=pregate|off (no `all` mode; unrecognized values fall back to pregate)
  {
    const offGit = runHook(
      { toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 5000 } } },
      { ...testEnv, AGY_RTK_MODE: "off" }
    );
    assert.equal(offGit.decision, "allow");
    assert.equal(offGit.overwrite?.CommandLine, undefined, "AGY_RTK_MODE=off must disable non-internal RTK rewrites");

    const legacyAllLs = runHook(
      { toolCall: { name: "run_command", args: { CommandLine: "ls -la", WaitMsBeforeAsync: 5000 } } },
      { ...testEnv, AGY_RTK_MODE: "all" }
    );
    assert.equal(legacyAllLs.decision, "allow");
    assert.equal(legacyAllLs.overwrite?.CommandLine, undefined, "Decision B1: AGY_RTK_MODE=all must not exist (falls back to pregate; ls stays untouched)");

    const legacyAllGit = runHook(
      { toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 5000 } } },
      { ...testEnv, AGY_RTK_MODE: "all" }
    );
    assert.equal(legacyAllGit.decision, "allow");
    assert.equal(legacyAllGit.overwrite?.CommandLine, "rtk git status");
    console.log("✓ Decision B1 (AGY_RTK_MODE=pregate|off, no `all` mode) verified");
  }

  // 3. Real `rtk hook antigravity` never mutates `agy-context transcript` invocations (including list --parent/--lineage and export --sanitized)
  for (const cmd of [
    "agy-context transcript health --id 1234",
    "agy-context transcript list --parent 1234 --lineage --json",
    "agy-context transcript export --parent 1234 --sanitized --out scratch/index.md"
  ]) {
    const agyCmd = runHook(
      { toolCall: { name: "run_command", args: { CommandLine: cmd, WaitMsBeforeAsync: 5000 } } },
      testEnv
    );
    assert.equal(agyCmd.decision, "allow", `Expected allow for '${cmd}'`);
    assert.equal(agyCmd.overwrite?.CommandLine, undefined, `'${cmd}' must pass through unrewritten by rtk`);
  }
  console.log("✓ 'agy-context transcript' (health, list --parent/--lineage, export --sanitized) passes through rtk unrewritten");

  // 4. PT-RUN-002: Bare `rg` and `grep` pass through untouched & lossless even when host `rg` is absent from PATH
  let rtkExeDir = path.join(tempDir, "shim-bin");
  if (hostRtk) {
    const resolvedWhich = spawnSync(process.platform === "win32" ? "where" : "which", ["rtk"], { encoding: "utf-8" });
    const firstExe = resolvedWhich.status === 0 ? resolvedWhich.stdout.trim().split(/\r?\n/)[0] : hostRtk.path;
    rtkExeDir = path.dirname(path.isAbsolute(firstExe) ? firstExe : hostRtk.path);
  }
  const noRgEnv = withEnvPath(rtkExeDir, testEnv);
  for (const searchCmd of [
    "rg -n foo scripts/",
    'rg -n "GOVERNED_TOOLS" scripts/',
    'FOO=1 rg -n "GOVERNED_TOOLS" scripts/',
    'grep -rn "GOVERNED_TOOLS" scripts/'
  ]) {
    const res = runHook(
      { toolCall: { name: "run_command", args: { CommandLine: searchCmd, WaitMsBeforeAsync: 5000 } } },
      noRgEnv
    );
    assert.equal(res.decision, "allow", `Search command '${searchCmd}' must be allowed`);
    assert.equal(
      res.overwrite?.CommandLine,
      undefined,
      `PT-RUN-002: '${searchCmd}' must pass through untouched and lossless without rg->grep transpilation or rtk wrapping`
    );
  }
  console.log("✓ PT-RUN-002: Bare `rg` and `grep` pass through untouched and lossless even when host `rg` is absent");

  // 5. Real `rtk 1.1.0` / shim `cat`/`head`/`tail` rewrite parity + Check 3/4 operand enforcement
  const convRtk = "conv-rtk-int-read";
  const sysDirRtk = path.join(tempDir, ".gemini", "antigravity", "brain", convRtk, ".system_generated");
  fs.mkdirSync(path.join(sysDirRtk, "logs"), { recursive: true });
  fs.mkdirSync(path.join(sysDirRtk, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(sysDirRtk, "steps", "1"), { recursive: true });
  fs.mkdirSync(path.join(sysDirRtk, "steps", "2"), { recursive: true });
  fs.writeFileSync(path.join(sysDirRtk, "tasks", "task-comp-1.log"), "done\n", "utf-8");
  fs.writeFileSync(
    path.join(sysDirRtk, "logs", "transcript.jsonl"),
    JSON.stringify({
      step_index: 1,
      type: "SYSTEM_MESSAGE",
      content: `Task id "${convRtk}/task-comp-1" finished with result:\nOK`
    }) + "\n",
    "utf-8"
  );
  fs.writeFileSync(path.join(sysDirRtk, "steps", "1", "output.txt"), "small spill\n", "utf-8");
  fs.writeFileSync(path.join(sysDirRtk, "steps", "2", "output.txt"), "z".repeat(48 * 1024), "utf-8");

  for (const [cmd, expectedRewrite] of [
    ["cat tasks/task-comp-1.log", "rtk read tasks/task-comp-1.log"],
    ["cat -n tasks/task-comp-1.log", "rtk read -n tasks/task-comp-1.log"],
    ["head tasks/task-comp-1.log", "rtk read tasks/task-comp-1.log --head-lines 10"],
    ["head -50 tasks/task-comp-1.log", "rtk read tasks/task-comp-1.log --head-lines 50"],
    ["head -n 50 tasks/task-comp-1.log", "rtk read tasks/task-comp-1.log --head-lines 50"],
    ["head --lines=50 tasks/task-comp-1.log", "rtk read tasks/task-comp-1.log --head-lines 50"],
    ["tail -50 tasks/task-comp-1.log", "rtk read tasks/task-comp-1.log --tail-lines 50"],
    ["tail -n 50 tasks/task-comp-1.log", "rtk read tasks/task-comp-1.log --tail-lines 50"],
    ["tail --lines=50 tasks/task-comp-1.log", "rtk read tasks/task-comp-1.log --tail-lines 50"]
  ]) {
    const out = runHook(
      { conversationId: convRtk, cwd: tempDir, toolCall: { name: "run_command", args: { CommandLine: cmd, WaitMsBeforeAsync: 5000 } } },
      testEnv
    );
    assert.equal(out.decision, "allow", `Expected allow for '${cmd}' (${out.reason || ""})`);
    assert.equal(out.overwrite?.CommandLine, expectedRewrite, `Unexpected rewrite for '${cmd}'`);
  }

  for (const unrewrittenDeny of [
    "cat -A tasks/task-comp-1.log",
    "cat -b tasks/task-comp-1.log",
    "cat -s tasks/task-comp-1.log",
    "tail tasks/task-comp-1.log",
    'head -n 50 "tasks/task-comp-1.log"',
    'tail -n 50 "tasks/task-comp-1.log"',
    "type tasks/task-comp-1.log",
    "Get-Content tasks/task-comp-1.log",
    "cat tasks/task-comp-1.log package.json",
    "cat .system_generated/steps/1/output.txt package.json",
    "rtk read .system_generated/steps/2/output.txt -- -m"
  ]) {
    const out = runHook(
      { conversationId: convRtk, cwd: tempDir, toolCall: { name: "run_command", args: { CommandLine: unrewrittenDeny, WaitMsBeforeAsync: 5000 } } },
      testEnv
    );
    assert.equal(out.decision, "deny", `Expected deny for '${unrewrittenDeny}' under live/aligned RTK`);
  }

  const m150Out = runHook(
    { conversationId: convRtk, cwd: tempDir, toolCall: { name: "run_command", args: { CommandLine: "rtk read -m150 .system_generated/steps/2/output.txt", WaitMsBeforeAsync: 5000 } } },
    testEnv
  );
  assert.equal(m150Out.decision, "allow", "Attached -m150 must pass >45 KiB spillover guard");

  if (hostRtk) {
    const cliM150 = runRtkCli(["read", "-m150", path.resolve(__dirname, "../package.json")], { env: testEnv });
    assert.equal(cliM150.status, 0, `Host rtk read -m150 failed: ${cliM150.stderr}`);
  }
  console.log(`✓ cat/head/tail rewrite parity, -m150 support, and single-operand enforcement verified against ${modeLabel}`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("\n=================================================");
console.log("ALL RTK >= 1.1.0 INTEGRATION CONTRACT TESTS PASSED!");
console.log("=================================================");
