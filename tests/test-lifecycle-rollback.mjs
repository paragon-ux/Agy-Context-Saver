import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRtkShim, prependToPath } from "./helpers/hermetic-fixture.mjs";

console.log("=================================================");
console.log("Agy-Context-Saver v2.0.0 Lifecycle & ACS-HOOK-11 Sweep Tests");
console.log("=================================================\n");

const testProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-lifecycle-test-"));
process.env.AGY_TEST_PROFILE_DIR = testProfileDir;

try {
  const shimDir = path.join(testProfileDir, "rtk-shim-bin");
  createRtkShim(shimDir, "1.1.0");
  prependToPath(shimDir);

  const configDir = path.join(testProfileDir, ".gemini", "config");
  const mcpRootDir = path.join(testProfileDir, ".gemini", "antigravity", "mcp");
  fs.mkdirSync(configDir, { recursive: true });

  // Seed legacy 1.8.1 state + duplicate MCP schemas (`ACS-HOOK-11`) + foreign entries
  fs.writeFileSync(path.join(configDir, "hooks.json"), JSON.stringify({
    "execution-guard": { PreToolUse: [] },
    "agy-context-saver": { PreToolUse: [] },
    "foreign-preservation-hook": { PreToolUse: [] }
  }, null, 2));
  fs.writeFileSync(path.join(configDir, "mcp_config.json"), JSON.stringify({
    mcpServers: {
      "agy-context-saver": { command: "node" },
      "agy-context-saver_agy-context-saver": { command: "node" },
      "foreign-preservation-server": { command: "node" }
    }
  }, null, 2));

  for (const dirName of ["agy-context-saver", "agy-context-saver_agy-context-saver", "foreign-server"]) {
    const d = path.join(mcpRootDir, dirName);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "tool.json"), "{}");
  }

  const {
    runInstall,
    runUninstall,
    detectExistingInstallation,
    formatWindowsCmdShim,
    pluginDest,
    destHook,
    hooksJsonPath,
    hooksBakPath,
    mcpJsonPath,
    mcpBakPath,
    antigravityMcpRootDir,
    antigravityBinDir
  } = await import("../scripts/install-register.mjs");

  // --- 1. Upgrade / Fresh Install Sweeps Legacy Hook & All agy-context-saver* MCP Entries (ACS-HOOK-11) ---
  console.log("--- 1. Install & Legacy MCP/Hook Sweep (ACS-HOOK-11) ---");
  await runInstall({ silent: true });

  const initial = detectExistingInstallation();
  assert.equal(initial.isComplete, true, "Installation must be complete and healthy");
  assert.equal(initial.details.mcp.clean, true, "Zero legacy agy-context-saver* MCP configs/schemas may remain");
  assert.ok(fs.existsSync(hooksBakPath), "hooks.json.bak must exist after pruning legacy hook keys");
  assert.ok(fs.existsSync(mcpBakPath), "mcp_config.json.bak must exist after stripping legacy MCP keys");

  const installedHooks = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
  assert.equal(installedHooks["execution-guard"], undefined, "Legacy execution-guard key must be pruned");
  assert.ok(fs.existsSync(destHook), "Mirrored hook script must be installed for /swarm workers");
  assert.ok(installedHooks["agy-context-saver"]?.PreToolUse?.[0]?.hooks?.[0]?.command?.includes("execution-guard-hook.mjs"), "Global agy-context-saver hook must be registered for /swarm workers");
  assert.ok(installedHooks["foreign-preservation-hook"], "Foreign hook must be preserved");

  const installedMcp = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
  assert.equal(installedMcp.mcpServers["agy-context-saver"], undefined);
  assert.equal(installedMcp.mcpServers["agy-context-saver_agy-context-saver"], undefined);
  assert.ok(installedMcp.mcpServers["foreign-preservation-server"], "Foreign MCP server must be preserved");

  const remainingMcpDirs = fs.readdirSync(antigravityMcpRootDir);
  assert.deepEqual(remainingMcpDirs, ["foreign-server"], "All agy-context-saver* schema dirs must be swept while keeping foreign-server");
  console.log("✓ ACS-HOOK-11 sweep removed all duplicate agy-context-saver* configs/schemas and legacy hooks while preserving foreign entries");

  // --- 2. Clean Uninstallation Verification ---
  console.log("\n--- 2. Clean Uninstallation Verification ---");
  const { getStateDir } = await import("../scripts/state-dir.mjs");
  const stateDir = getStateDir();
  assert.ok(stateDir.startsWith(testProfileDir));
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "agy-session-governance-state.json"), "{}");

  const sandboxTmp = path.join(testProfileDir, "tmp");
  fs.mkdirSync(sandboxTmp, { recursive: true });
  const legacyTmpFile = path.join(sandboxTmp, "agy-session-conv_1.json");
  const unrelatedTmpFile = path.join(sandboxTmp, "unrelated-file.json");
  fs.writeFileSync(legacyTmpFile, "{}");
  fs.writeFileSync(unrelatedTmpFile, "{}");

  // Also re-seed a stale duplicate dir before uninstall to verify `--uninstall` sweeps it too
  fs.mkdirSync(path.join(mcpRootDir, "agy-context-saver_stale"), { recursive: true });

  const savedTmpEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = sandboxTmp;
  try {
    await runUninstall({ silent: true });
  } finally {
    for (const [k, v] of Object.entries(savedTmpEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  assert.equal(fs.existsSync(pluginDest), false, "Plugin link must be removed");
  assert.equal(fs.existsSync(destHook), false, "Mirrored hook script must be absent");
  assert.equal(fs.existsSync(path.join(antigravityBinDir, process.platform === "win32" ? "agy-context.cmd" : "agy-context")), false, "CLI shim must be removed");
  assert.equal(fs.existsSync(path.join(mcpRootDir, "agy-context-saver_stale")), false, "Uninstall must sweep agy-context-saver* schema dirs");
  assert.ok(fs.existsSync(path.join(mcpRootDir, "foreign-server")), "Foreign MCP schema dir preserved");
  assert.equal(fs.existsSync(stateDir), false, "State dir removed");
  assert.equal(fs.existsSync(legacyTmpFile), false, "Legacy tmp state removed");
  assert.ok(fs.existsSync(unrelatedTmpFile), "Unrelated tmp file preserved");

  const uninstalledDetect = detectExistingInstallation();
  assert.equal(uninstalledDetect.isInstalled, false);
  console.log("✓ Clean uninstallation verified");

  // --- 3. Copy Fallback, Symlink-to-Copy Upgrade & Re-Installation Verification ---
  console.log("\n--- 3. Copy Fallback & Re-Install Recovery ---");
  // Seed a symlinked install first, then upgrade via forceCopyFallback (ACS-SCRIPT-003)
  await runInstall({ silent: true });
  await runInstall({ silent: true, forceCopyFallback: true });
  const copyRes = detectExistingInstallation();
  assert.equal(copyRes.isComplete, true);
  assert.equal(fs.lstatSync(pluginDest).isSymbolicLink(), false, "forceCopyFallback must replace prior symlink with real directory copy (ACS-SCRIPT-003)");
  assert.ok(fs.existsSync(path.join(pluginDest, "bin", "agy-context.mjs")), "Copied plugin must contain CLI binary");
  assert.ok(fs.existsSync(path.join(pluginDest, "lib", "transcript-core.mjs")), "Copied plugin must contain transcript engine");

  // Re-running normal runInstall() when pluginDest is a stale real directory must refresh/re-link it cleanly (L46)
  fs.writeFileSync(path.join(pluginDest, "stale-copy-file.txt"), "stale");
  await runInstall({ silent: true });
  assert.equal(fs.existsSync(path.join(pluginDest, "stale-copy-file.txt")), false, "runInstall() must refresh stale copied pluginDest rather than leaving old files");

  // Windows .cmd shim avoids parenthesized %errorlevel% cmd parse-time bug and install.ps1 emits BOM-less UTF-8 + chcp 65001 (L46)
  const cmdShimText = formatWindowsCmdShim(path.join(pluginDest, "bin", "agy-context.mjs"));
  assert.match(cmdShimText, /if errorlevel 1 goto :fallback/);
  assert.match(cmdShimText, /:fallback/);
  assert.doesNotMatch(cmdShimText, /if %errorlevel% equ 0 \(/i);
  const ps1Text = fs.readFileSync(new URL("../install.ps1", import.meta.url), "utf8");
  assert.match(ps1Text, /chcp 65001 >nul/);
  assert.match(ps1Text, /\[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.doesNotMatch(ps1Text, /-Encoding ASCII/);
  if (os.platform() === "win32") {
    const winShimRoot = path.join(testProfileDir, "win-shim-exec");
    fs.mkdirSync(winShimRoot, { recursive: true });
    const exitScript = path.join(winShimRoot, "exit-probe.mjs");
    fs.writeFileSync(exitScript, "process.exit(Number(process.argv[2] || 0));\n");
    const winShimPath = path.join(testProfileDir, "agy-context-test.cmd");
    fs.writeFileSync(winShimPath, formatWindowsCmdShim(exitScript));
    const { spawnSync } = await import("node:child_process");
    const okCmd = spawnSync("cmd.exe", ["/d", "/c", winShimPath, "0"], { encoding: "utf8" });
    assert.equal(okCmd.status, 0, okCmd.stderr || okCmd.stdout);
    const errCmd = spawnSync("cmd.exe", ["/d", "/c", winShimPath, "7"], { encoding: "utf8" });
    assert.equal(errCmd.status, 7, `Expected Windows .cmd shim to propagate exit code 7, got ${errCmd.status}`);
  }

  // Seed managed node.cmd & node.cmd.bak, verify uninstall removes managed wrapper and restores backup (ACS-SCRIPT-002)
  const nodeCmdPath = path.join(configDir, "node.cmd");
  const nodeCmdBakPath = path.join(configDir, "node.cmd.bak");
  fs.writeFileSync(nodeCmdPath, "@echo off\r\nREM agy-context-saver-managed\r\n", "utf-8");
  fs.writeFileSync(nodeCmdBakPath, "@echo off\r\nREM original-user-wrapper\r\n", "utf-8");

  // --- 4. Backup Restoration Verification ---
  console.log("\n--- 4. Backup Restore Option Verification ---");
  await runUninstall({ silent: true, restoreBackups: true });
  assert.ok(fs.existsSync(nodeCmdPath), "Uninstall must restore node.cmd from node.cmd.bak");
  assert.match(fs.readFileSync(nodeCmdPath, "utf-8"), /original-user-wrapper/);
  assert.equal(fs.existsSync(nodeCmdBakPath), false, "node.cmd.bak should be moved rather than left orphaned");
  const restoredHooks = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
  assert.ok(restoredHooks["foreign-preservation-hook"], "Backup restore must restore prior hooks.json");
  console.log("✓ Copy fallback, symlink-to-copy upgrade, node.cmd cleanup, and backup restoration verified");
} finally {
  try {
    fs.rmSync(testProfileDir, { recursive: true, force: true });
  } catch {}
}

console.log("\n=================================================");
console.log("ALL 2.0 LIFECYCLE & ROLLBACK TESTS PASSED!");
console.log("=================================================");
