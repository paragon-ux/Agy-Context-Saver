import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setupHermeticTestEnv, withEnvPath } from "./helpers/hermetic-fixture.mjs";
import {
  ensureRtkConfigured,
  findExistingRtk,
  formatWindowsExpandArchiveCommand,
  getRtkConfigPath,
  RTK_CHECKSUMS
} from "../scripts/provision-rtk.mjs";

console.log("=================================================");
console.log("RTK >= 1.1.0 Ledger & Fresh Install Verification Suite");
console.log("=================================================\n");

// --- TEST 0: L37 Pinned SHA-256 Checksums for All 5 Supported Platform Assets ---
console.log("--- 0. L37: Pinned RTK v1.1.0 Release Asset SHA-256 Checksums ---");
for (const assetName of [
  "rtk-x86_64-pc-windows-msvc.zip",
  "rtk-aarch64-apple-darwin.tar.gz",
  "rtk-x86_64-apple-darwin.tar.gz",
  "rtk-x86_64-unknown-linux-musl.tar.gz",
  "rtk-aarch64-unknown-linux-gnu.tar.gz"
]) {
  assert.match(RTK_CHECKSUMS[assetName] || "", /^[a-f0-9]{64}$/, `Missing or invalid SHA-256 checksum for ${assetName}`);
}
const psExpand = formatWindowsExpandArchiveCommand("C:\\Users\\O'Brien [Dev]\\rtk.zip", "C:\\Users\\O'Brien [Dev]\\bin");
assert.equal(
  psExpand,
  "Expand-Archive -LiteralPath 'C:\\Users\\O''Brien [Dev]\\rtk.zip' -DestinationPath 'C:\\Users\\O''Brien [Dev]\\bin' -Force"
);
console.log("✓ All 5 RTK v1.1.0 platform release assets have pinned 64-char SHA-256 checksums");

// --- TEST 1: RTK-01 Fresh Installation Standardizes config.toml ---
console.log("--- 1. RTK-01: Fresh Install Config Standardization ---");
const tempProfile = fs.mkdtempSync(path.join(os.tmpdir(), "agy-rtk-fresh-test-"));
process.env.AGY_TEST_PROFILE_DIR = tempProfile;
const isolatedGitConfig = path.join(tempProfile, ".gitconfig");
const preExistingGitConfig = "[core]\n\tsafecrlf = true\n";
fs.writeFileSync(isolatedGitConfig, preExistingGitConfig, "utf-8");
process.env.GIT_CONFIG_GLOBAL = isolatedGitConfig;
const hostGitConfig = path.join(os.homedir(), ".gitconfig");
const hostGitBefore = fs.existsSync(hostGitConfig) ? fs.readFileSync(hostGitConfig, "utf-8") : null;

const configPath = getRtkConfigPath();
assert.equal(fs.existsSync(configPath), false, "Fresh profile must not have config.toml initially");

ensureRtkConfigured({ silent: true });

const hostGitAfter = fs.existsSync(hostGitConfig) ? fs.readFileSync(hostGitConfig, "utf-8") : null;
assert.equal(hostGitAfter, hostGitBefore, "Setup must never mutate host ~/.gitconfig (UX-ACS-004)");
assert.equal(
  fs.readFileSync(isolatedGitConfig, "utf-8"),
  preExistingGitConfig,
  "ensureRtkConfigured must NOT mutate GIT_CONFIG_GLOBAL or overwrite core.safecrlf = true (UX-ACS-004)"
);

assert.equal(fs.existsSync(configPath), true, `config.toml must be created at ${configPath}`);
const freshContent = fs.readFileSync(configPath, "utf-8");
assert.match(freshContent, /\[hooks\]/, "Must contain [hooks] section");
assert.match(freshContent, /suppress_hook_warning\s*=\s*true/, "Must standardize suppress_hook_warning = true");
console.log("✓ Fresh install automatically creates RTK config.toml with suppress_hook_warning = true");

// --- TEST 2: RTK-01 Non-destructive Config Preservation ---
console.log("\n--- 2. RTK-01: Non-destructive Preservation of Custom Config ---");
const customConfig = [
  "# Custom RTK user preferences",
  "[general]",
  'log_level = "debug"',
  "telemetry = false",
  "",
  "[hooks]",
  "suppress_hook_warning = false",
  'other_flag = "preserved"',
  ""
].join("\n");
fs.writeFileSync(configPath, customConfig, "utf-8");

ensureRtkConfigured({ silent: true });

const updatedContent = fs.readFileSync(configPath, "utf-8");
assert.match(updatedContent, /suppress_hook_warning\s*=\s*true/, "suppress_hook_warning must be updated to true");
assert.match(updatedContent, /\[general\]/, "[general] section preserved");
assert.match(updatedContent, /log_level\s*=\s*"debug"/, "log_level setting preserved");
assert.match(updatedContent, /other_flag\s*=\s*"preserved"/, "other_flag preserved");
console.log("✓ Existing user sections, comments, and flags preserved");

try { fs.rmSync(tempProfile, { recursive: true, force: true }); } catch {}

// --- TEST 3: Direct `rtk hook antigravity` Delegation & WaitMs Preservation ---
console.log("\n--- 3. `rtk hook antigravity` Delegation & WaitMs Preservation ---");
const { profileDir, cleanup } = await setupHermeticTestEnv({ forceShim: true, shimVersion: "1.1.0" });
const hookScript = path.resolve(fileURLToPath(import.meta.url), "../../scripts/execution-guard-hook.mjs");

function runHook(payload, customEnv = process.env) {
  const res = spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: customEnv
  });
  assert.equal(res.status, 0, `Hook exited with ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

const rewriteOutput = runHook({
  toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 3000 } }
});
assert.equal(rewriteOutput.decision, "allow");
assert.equal(rewriteOutput.overwrite?.CommandLine, "rtk git status");
assert.equal(rewriteOutput.overwrite?.WaitMsBeforeAsync, undefined, "Explicit WaitMsBeforeAsync must be preserved (ACS-HOOK-05)");

const unsetWaitOutput = runHook({
  toolCall: { name: "run_command", args: { CommandLine: "cat package.json" } }
});
assert.equal(unsetWaitOutput.decision, "allow");
assert.equal(unsetWaitOutput.overwrite?.CommandLine, "rtk read package.json");
assert.equal(unsetWaitOutput.overwrite?.WaitMsBeforeAsync, 10000, "Unset WaitMsBeforeAsync defaults to 10000");

// --- TEST 4: Search/Find/List Routing Hints ---
console.log("\n--- 4. Search, Find & List Native Tool Routing ---");
const noRgEnv = withEnvPath(path.join(profileDir, "rtk-shim-bin"));
const grepOutput = runHook(
  { toolCall: { name: "grep_search", args: { query: "export function" } } },
  noRgEnv
);
assert.equal(grepOutput.decision, "deny");
assert.match(grepOutput.reason, /rtk grep -rnE "export function" \./, "When rg is absent, grep_search routes to rtk grep -rnE <pattern> .");

const findOutput = runHook({ toolCall: { name: "find_by_name", args: { pattern: "*.mjs" } } });
assert.equal(findOutput.decision, "deny");
assert.match(findOutput.reason, /rtk find \*\.mjs/);
assert.equal(findOutput.reason.includes("-name"), false);

const listOutput = runHook({ toolCall: { name: "list_dir", args: { dir_path: "c:/project/tests" } } });
assert.equal(listOutput.decision, "deny");
if (process.platform === "win32") {
  assert.match(listOutput.reason, /rtk find c:\/project\/tests/);
} else {
  assert.match(listOutput.reason, /rtk ls c:\/project\/tests/);
}

cleanup();

// --- TEST 5: Windows .cmd Shim Resolution in findExistingRtk (`ACS-R2-SCRIPT-001`) ---
console.log("\n--- 5. Windows rtk.cmd Shim Resolution (`ACS-R2-SCRIPT-001`) ---");
{
  const cmdCalls = [];
  const winStubExec = (cmd, args, opts) => {
    cmdCalls.push({ cmd, args, opts });
    if (cmd === "rtk") {
      throw Object.assign(new Error("spawn rtk ENOENT"), { code: "ENOENT" });
    }
    if (/cmd\.exe$/i.test(cmd) && args.includes("/c") && args[3] === "\"rtk --version\"") {
      assert.equal(opts.windowsVerbatimArguments, true);
      return "rtk 1.1.0 (cmd-shim)\n";
    }
    throw new Error(`Unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const winPathHit = findExistingRtk({ platform: "win32", execFileSync: winStubExec, silent: true });
  assert.equal(winPathHit?.path, "rtk");
  assert.match(winPathHit?.version || "", /1\.1\.0/);
  assert.equal(cmdCalls.length, 2, "win32 PATH lookup must fall back from ENOENT to cmd.exe /d /s /c \"rtk --version\"");

  const localCmdProfile = fs.mkdtempSync(path.join(os.tmpdir(), "agy-win-cmd-"));
  const origProfile = process.env.AGY_TEST_PROFILE_DIR;
  try {
    process.env.AGY_TEST_PROFILE_DIR = localCmdProfile;
    const pluginBin = path.join(localCmdProfile, ".gemini", "config", "plugins", "agy-context-saver", "bin");
    fs.mkdirSync(pluginBin, { recursive: true });
    const fakeLocalCmd = path.join(pluginBin, "rtk.cmd");
    fs.writeFileSync(fakeLocalCmd, "@echo off\r\necho rtk 1.1.0\r\n", "utf-8");

    let localCmdWrapped = false;
    const localStubExec = (cmd, args, opts) => {
      if (cmd === "rtk" || (/cmd\.exe$/i.test(cmd) && args[3] === "\"rtk --version\"")) {
        throw Object.assign(new Error("not on PATH"), { code: "ENOENT" });
      }
      if (/cmd\.exe$/i.test(cmd) && args[3].includes('rtk.cmd" --version')) {
        assert.equal(opts.windowsVerbatimArguments, true);
        localCmdWrapped = true;
        return "rtk 1.1.0 (local-cmd)\n";
      }
      throw new Error(`Direct execFileSync on .cmd must not occur on win32: ${cmd}`);
    };
    const winLocalHit = findExistingRtk({ platform: "win32", execFileSync: localStubExec, silent: true });
    assert.equal(localCmdWrapped, true, "Local rtk.cmd must execute via cmd.exe /d /s /c wrapper");
    assert.equal(winLocalHit?.path, fakeLocalCmd);
    assert.equal(winLocalHit?.isLocal, true);
  } finally {
    if (origProfile === undefined) delete process.env.AGY_TEST_PROFILE_DIR;
    else process.env.AGY_TEST_PROFILE_DIR = origProfile;
    fs.rmSync(localCmdProfile, { recursive: true, force: true });
  }

  if (process.platform === "win32") {
    const winRealProfile = fs.mkdtempSync(path.join(os.tmpdir(), "agy-win-real-cmd-"));
    const prevPath = process.env.PATH;
    const prevProfile = process.env.AGY_TEST_PROFILE_DIR;
    try {
      const shimDir = path.join(winRealProfile, "path-shim");
      const emptyDir = path.join(winRealProfile, "empty-path");
      fs.mkdirSync(shimDir, { recursive: true });
      fs.mkdirSync(emptyDir, { recursive: true });
      const { createRtkShim } = await import("./helpers/hermetic-fixture.mjs");
      createRtkShim(shimDir, "1.1.0");
      process.env.AGY_TEST_PROFILE_DIR = winRealProfile;
      process.env.PATH = shimDir;
      const realPathHit = findExistingRtk({ silent: true });
      assert.equal(realPathHit?.path, "rtk", "Live win32 findExistingRtk must detect rtk.cmd on PATH");

      process.env.PATH = emptyDir;
      const pluginBin = path.join(winRealProfile, ".gemini", "config", "plugins", "agy-context-saver", "bin");
      createRtkShim(pluginBin, "1.1.0");
      const realLocalHit = findExistingRtk({ silent: true });
      assert.equal(realLocalHit?.isLocal, true, "Live win32 findExistingRtk must detect plugin bin rtk.cmd without network download");
    } finally {
      process.env.PATH = prevPath;
      if (prevProfile === undefined) delete process.env.AGY_TEST_PROFILE_DIR;
      else process.env.AGY_TEST_PROFILE_DIR = prevProfile;
      fs.rmSync(winRealProfile, { recursive: true, force: true });
    }
  }
  console.log("✓ findExistingRtk resolves Windows rtk.cmd shims via cmd.exe /d /s /c without network fallback");
}

console.log("\n=================================================");
console.log("ALL RTK >= 1.1.0 LEDGER CHECKS PASSED!");
console.log("=================================================");
