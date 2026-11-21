import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setupHermeticTestEnv, withEnvPath } from "./helpers/hermetic-fixture.mjs";
import {
  ensureRtkConfigured,
  ensureRtkInstalled,
  findExistingRtk,
  formatWindowsExpandArchiveCommand,
  getRtkConfigPath,
  RTK_CHECKSUMS,
  updateRtkConfigToml
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

// --- TEST 2b: SCRIPT-001 & TEST-001 Explicit Cross-OS Config Path Assertions ---
console.log("\n--- 2b. SCRIPT-001 / TEST-001: Cross-OS RTK Config Path Resolution ---");
{
  const normSlash = (p) => String(p).replace(/\\/g, "/");
  const darwinPath = normSlash(getRtkConfigPath({ platform: "darwin", homeDir: "/Users/dev", profileHome: "" }));
  assert.equal(darwinPath, "/Users/dev/Library/Application Support/rtk/config.toml");

  const darwinProfilePath = normSlash(getRtkConfigPath({ platform: "darwin", profileHome: "/tmp/mac-prof" }));
  assert.equal(darwinProfilePath, "/tmp/mac-prof/Library/Application Support/rtk/config.toml");

  const linuxPath = normSlash(getRtkConfigPath({ platform: "linux", homeDir: "/home/dev", env: {}, profileHome: "" }));
  assert.equal(linuxPath, "/home/dev/.config/rtk/config.toml");

  const linuxXdgPath = normSlash(
    getRtkConfigPath({ platform: "linux", homeDir: "/home/dev", env: { XDG_CONFIG_HOME: "/xdg" }, profileHome: "" })
  );
  assert.equal(linuxXdgPath, "/xdg/rtk/config.toml");

  const winDefaultPath = normSlash(getRtkConfigPath({ platform: "win32", homeDir: "C:/Users/Dev", env: {}, profileHome: "" }));
  assert.ok(winDefaultPath.endsWith("AppData/Roaming/rtk/config.toml"), `Unexpected win32 default path: ${winDefaultPath}`);

  const winAppDataPath = normSlash(
    getRtkConfigPath({ platform: "win32", homeDir: "C:/Users/Dev", env: { APPDATA: "C:/Users/Dev/AppData/Roaming" }, profileHome: "" })
  );
  assert.ok(winAppDataPath.endsWith("AppData/Roaming/rtk/config.toml"), `Unexpected win32 APPDATA path: ${winAppDataPath}`);

  const winProfilePath = normSlash(getRtkConfigPath({ platform: "win32", profileHome: "/tmp/win-prof" }));
  assert.ok(winProfilePath.endsWith("AppData/Roaming/rtk/config.toml"), `Unexpected win32 profile path: ${winProfilePath}`);
  console.log("✓ Explicit darwin/linux/win32 RTK config.toml paths verified");
}

// --- TEST 2c: SCRIPT-003 Non-Comment TOML Editing ---
console.log("\n--- 2c. SCRIPT-003: Comment-Safe TOML Editing in updateRtkConfigToml() ---");
{
  const commentedFalse = "[hooks]\n# suppress_hook_warning = false\nother = 1\n";
  const r1 = updateRtkConfigToml(commentedFalse);
  assert.equal(r1.changed, true);
  assert.match(r1.content, /^\[hooks\]\nsuppress_hook_warning = true\n# suppress_hook_warning = false/m);

  const commentedTrueOnly = "# suppress_hook_warning = true\n[general]\nfoo = 1\n";
  const r2 = updateRtkConfigToml(commentedTrueOnly);
  assert.equal(r2.changed, true);
  assert.match(r2.content, /\[hooks\]\nsuppress_hook_warning = true\n$/);

  const wrongSection = "[other]\nsuppress_hook_warning = true\n";
  const r3 = updateRtkConfigToml(wrongSection);
  assert.equal(r3.changed, true);
  assert.match(r3.content, /\[hooks\]\nsuppress_hook_warning = true\n$/);

  const inlineComment = "[hooks]\nsuppress_hook_warning = false # user note\n";
  const r4 = updateRtkConfigToml(inlineComment);
  assert.equal(r4.changed, true);
  assert.equal(r4.content, "[hooks]\nsuppress_hook_warning = true # user note\n");

  const alreadyOn = "[hooks]\r\nsuppress_hook_warning = true\r\n";
  const r5 = updateRtkConfigToml(alreadyOn);
  assert.equal(r5.changed, false);
  assert.equal(r5.content, alreadyOn);

  // Array-of-tables [[custom]] must exit [hooks] cleanly instead of inheriting inHooks
  const arrayTableAfterHooks = "[hooks]\nfoo = 1\n[[custom]]\nsuppress_hook_warning = true\n";
  const r6 = updateRtkConfigToml(arrayTableAfterHooks);
  assert.equal(r6.changed, true);
  assert.match(r6.content, /^\[hooks\]\nsuppress_hook_warning = true\nfoo = 1\n\[\[custom\]\]/m);

  // Top-level dotted hooks.suppress_hook_warning must update in place without appending invalid duplicate [hooks]
  const dottedFalse = "hooks.suppress_hook_warning = false # dotted\n";
  const r7 = updateRtkConfigToml(dottedFalse);
  assert.equal(r7.changed, true);
  assert.equal(r7.content, "hooks.suppress_hook_warning = true # dotted\n");
  assert.equal(r7.content.includes("[hooks]"), false);

  const dottedTrue = "hooks.suppress_hook_warning = true\n";
  const r8 = updateRtkConfigToml(dottedTrue);
  assert.equal(r8.changed, false);

  // Verify end-to-end ensureRtkConfigured handles commented key on disk
  fs.writeFileSync(configPath, "[hooks]\n# suppress_hook_warning = true\n", "utf-8");
  ensureRtkConfigured({ silent: true });
  const diskAfterComment = fs.readFileSync(configPath, "utf-8");
  assert.match(diskAfterComment, /^\s*suppress_hook_warning\s*=\s*true\s*$/m, "Must add active key even when commented key exists");
  console.log("✓ Commented keys, wrong sections, inline comments, and CRLF TOML preservation verified");
}

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
assert.equal(unsetWaitOutput.overwrite?.CommandLine, undefined, "Workspace cat stays lossless under Narrow High-ROI Pre-Gate");
assert.equal(unsetWaitOutput.overwrite?.WaitMsBeforeAsync, 10000, "Unset WaitMsBeforeAsync defaults to 10000");

// --- TEST 4: Native Discovery Unblocked & Internal State Protected ---
console.log("\n--- 4. Native Discovery Unblocked & Internal State Protection ---");
const noRgEnv = withEnvPath(path.join(profileDir, "rtk-shim-bin"));
const grepOutput = runHook(
  { toolCall: { name: "grep_search", args: { query: "export function", SearchPath: "scripts" } } },
  noRgEnv
);
assert.equal(grepOutput.decision, "allow", "Native grep_search on workspace paths must be allowed");

const grepProtectedOutput = runHook(
  { toolCall: { name: "grep_search", args: { query: "secret", SearchPath: ".system_generated/logs" } } },
  noRgEnv
);
assert.equal(grepProtectedOutput.decision, "deny", "Native grep_search on .system_generated must stay denied");

const findOutput = runHook({ toolCall: { name: "find_by_name", args: { pattern: "*.mjs", SearchPath: "." } } });
assert.equal(findOutput.decision, "allow", "Native find_by_name on workspace paths must be allowed");

const listOutput = runHook({ toolCall: { name: "list_dir", args: { dir_path: "c:/project/tests" } } });
assert.equal(listOutput.decision, "allow", "Native list_dir on workspace paths must be allowed");

const readManyOutput = runHook({ toolCall: { name: "read_many_files", args: { paths: ["a.js", "b.js"] } } });
assert.equal(readManyOutput.decision, "deny", "Unbounded read_many_files must stay denied");

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

    // UX-ACS-R2-001: Managed rtk.cmd shim in ~/.gemini/antigravity/bin on PATH must resolve as local plugin RTK, never `{ path: "rtk", isLocal: false }`
    const managedShimDir = path.join(localCmdProfile, ".gemini", "antigravity", "bin");
    fs.mkdirSync(managedShimDir, { recursive: true });
    fs.writeFileSync(
      path.join(managedShimDir, "rtk.cmd"),
      "@echo off\r\nREM agy-context-saver-managed\r\n\"C:\\fake\\rtk.exe\" %*\r\n",
      "utf-8"
    );
    const managedStubExec = (cmd, args) => {
      if (cmd === "rtk" || (/cmd\.exe$/i.test(cmd) && args[3] === "\"rtk --version\"")) {
        throw new Error("findExistingRtk must not treat managed ~/.gemini/antigravity/bin/rtk.cmd as external PATH rtk");
      }
      if (/cmd\.exe$/i.test(cmd) && args[3].includes("rtk.cmd\" --version")) {
        return "rtk 1.1.0 (local-managed-target)\n";
      }
      throw new Error(`Unexpected exec call: ${cmd} ${args.join(" ")}`);
    };
    const winManagedHit = findExistingRtk({
      platform: "win32",
      pathEnv: `${managedShimDir};C:\\Windows\\System32`,
      execFileSync: managedStubExec,
      silent: true
    });
    assert.equal(winManagedHit?.path, fakeLocalCmd);
    assert.equal(winManagedHit?.isLocal, true, "Managed rtk.cmd on PATH must return local plugin binary with isLocal: true (UX-ACS-R2-001)");
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

// --- TEST 6: SCRIPT-004 Download Timeout Signal & Manual Install Guidance ---
console.log("\n--- 6. SCRIPT-004: Fetch Timeout AbortSignal & Manual Install Instructions ---");
{
  const isolatedEmptyProfile = fs.mkdtempSync(path.join(os.tmpdir(), "agy-rtk-script004-"));
  const origProfile = process.env.AGY_TEST_PROFILE_DIR;
  try {
    process.env.AGY_TEST_PROFILE_DIR = isolatedEmptyProfile;
    const noRtkExec = () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    };

    // Unsupported platform/arch (win32-arm64) must include manual install commands
    await assert.rejects(
      () =>
        ensureRtkInstalled({
          silent: true,
          platform: "win32",
          arch: "arm64",
          pathEnv: "",
          execFileSync: noRtkExec
        }),
      (err) => {
        assert.match(err.message, /Unsupported platform\/architecture/i);
        assert.match(err.message, /brew install rtk/);
        assert.match(err.message, /cargo install --locked rtk/);
        return true;
      }
    );

    // Fetch call must receive an AbortSignal and emit manual install guidance on network/HTTP failure
    let receivedSignal = null;
    await assert.rejects(
      () =>
        ensureRtkInstalled({
          silent: true,
          platform: "linux",
          arch: "x64",
          pathEnv: "",
          execFileSync: noRtkExec,
          timeoutMs: 1234,
          fetch: async (_url, opts) => {
            receivedSignal = opts?.signal || null;
            return { ok: false, status: 503, statusText: "Service Unavailable" };
          }
        }),
      (err) => {
        assert.match(err.message, /503/);
        assert.match(err.message, /brew install rtk/);
        assert.match(err.message, /cargo install --locked rtk/);
        return true;
      }
    );
    assert.ok(receivedSignal && typeof receivedSignal.aborted === "boolean", "fetch() must receive an AbortSignal timeout");

    // Mid-stream body read timeout/abort must also wrap with manual RTK install instructions
    await assert.rejects(
      () =>
        ensureRtkInstalled({
          silent: true,
          platform: "linux",
          arch: "x64",
          pathEnv: "",
          execFileSync: noRtkExec,
          timeoutMs: 1234,
          fetch: async () => ({
            ok: true,
            arrayBuffer: async () => {
              throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
            }
          })
        }),
      (err) => {
        assert.match(err.message, /Failed to download RTK release/i);
        assert.match(err.message, /brew install rtk/);
        assert.match(err.message, /cargo install --locked rtk/);
        return true;
      }
    );
    console.log("✓ Fetch AbortSignal.timeout (headers + body stream) and manual RTK install instructions verified");
  } finally {
    if (origProfile === undefined) delete process.env.AGY_TEST_PROFILE_DIR;
    else process.env.AGY_TEST_PROFILE_DIR = origProfile;
    fs.rmSync(isolatedEmptyProfile, { recursive: true, force: true });
  }
}

console.log("\n=================================================");
console.log("ALL RTK >= 1.1.0 LEDGER CHECKS PASSED!");
console.log("=================================================");
