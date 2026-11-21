import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    assertSupportedNodeVersion,
    runInstall,
    runUninstall,
    runRestoreBackups,
    detectExistingInstallation,
    formatWindowsCmdShim,
    cleanupLegacyWindowsNodeCmd,
    isDirOnPath,
    formatPathOnboardingLines,
    isManagedAgyShimFile,
    resolveProfilePaths
  } = await import("../scripts/install-register.mjs");
  const {
    pluginDest,
    pluginHookScriptNormalized,
    destHook,
    hooksJsonPath,
    hooksBakPath,
    legacyHooksBakPath,
    mcpJsonPath,
    mcpBakPath,
    antigravityMcpRootDir,
    antigravityBinDir
  } = resolveProfilePaths();

  // Seed a legacy standalone mirrored hook script to verify runInstall removes it (Decision A2)
  fs.mkdirSync(path.dirname(destHook), { recursive: true });
  fs.writeFileSync(destHook, "// legacy standalone hook mirror\n", "utf-8");

  // --- 1. Upgrade / Fresh Install Sweeps Legacy Hook & All agy-context-saver* MCP Entries (ACS-HOOK-11) ---
  console.log("--- 1. Install & Legacy MCP/Hook Sweep (ACS-HOOK-11) ---");
  await runInstall({ silent: true });

  const initial = detectExistingInstallation();
  assert.equal(initial.isComplete, true, "Installation must be complete and healthy");
  assert.equal(initial.details.mcp.clean, true, "Zero legacy agy-context-saver* MCP configs/schemas may remain");
  assert.match(hooksBakPath, /hooks\.json\.agy-context-saver\.bak$/, "hooks backup must be namespaced (1B.4)");
  assert.ok(fs.existsSync(hooksBakPath), "hooks.json.agy-context-saver.bak must exist after pruning legacy hook keys");
  assert.equal(fs.existsSync(legacyHooksBakPath), false, "Install must not create unnamespaced legacy hooks.json.bak (1B.4)");
  assert.ok(fs.existsSync(mcpBakPath), "mcp_config.json.agy-context-saver.bak must exist after stripping legacy MCP keys");

  const installedHooks = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
  assert.equal(installedHooks["execution-guard"], undefined, "Legacy execution-guard key must be pruned");
  assert.equal(fs.existsSync(destHook), false, "Legacy standalone mirrored hook script must be removed on install (Decision A2)");
  assert.equal(initial.details.hook.legacyMirrorPresent, false);
  assert.equal(initial.details.hook.mirroredHookExists, false);
  assert.equal(initial.details.hook.scriptExists, true);
  const installedHookCmd = installedHooks["agy-context-saver"]?.PreToolUse?.[0]?.hooks?.[0]?.command || "";
  assert.ok(installedHookCmd.includes("execution-guard-hook.mjs"), "Global agy-context-saver hook must be registered");
  assert.equal(installedHookCmd.includes("--surface="), false, "Global hook must not use legacy --surface= flag (Decision A2)");
  const normCase = (s) => (os.platform() === "win32" || os.platform() === "darwin" ? s.toLowerCase() : s);
  assert.ok(
    normCase(installedHookCmd.replace(/\\/g, "/")).includes(normCase(pluginHookScriptNormalized)),
    "Global hook command must point directly at pluginDest/scripts/execution-guard-hook.mjs (Decision A2)"
  );
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

  // Windows .cmd shim avoids parenthesized %errorlevel% cmd parse-time bug and uses chcp 65001 >nul (L46)
  const cmdShimText = formatWindowsCmdShim(path.join(pluginDest, "bin", "agy-context.mjs"));
  assert.match(cmdShimText, /chcp 65001 >nul/);
  assert.match(cmdShimText, /if errorlevel 1 goto :fallback/);
  assert.match(cmdShimText, /:fallback/);
  assert.doesNotMatch(cmdShimText, /if %errorlevel% equ 0 \(/i);
  const ps1Text = fs.readFileSync(new URL("../install.ps1", import.meta.url), "utf8");
  assert.doesNotMatch(ps1Text, /-Encoding ASCII/);
  // A-Win1: install.ps1 no longer writes a node.cmd wrapper; delegates cleanly to scripts/install-register.mjs
  assert.doesNotMatch(ps1Text, /WriteAllText[\s\S]*node\.cmd/i);
  assert.match(ps1Text, /install-register\.mjs/);
  // ACS-BOOST-SCRIPT-001: install.ps1 checks $env:ProgramFiles and ${env:ProgramFiles(x86)} and fails closed via Write-Error + exit 1 when node is missing
  assert.match(ps1Text, /\$env:ProgramFiles[\s\S]*nodejs\\node\.exe/);
  assert.match(ps1Text, /\$\{env:ProgramFiles\(x86\)\}[\s\S]*nodejs\\node\.exe/);
  assert.match(ps1Text, /Write-Error[\s\S]*exit 1/);
  assert.doesNotMatch(ps1Text, /\$NodeExe\s*=\s*"node"/);
  if (os.platform() !== "win32") {
    // ACS-TEST-003: POSIX shim escaping with `$` and spaces in AGY_TEST_PROFILE_DIR
    const { spawnSync } = await import("node:child_process");
    const specialProfile = fs.mkdtempSync(path.join(os.tmpdir(), "agy-posix $shim dir-"));
    try {
      const fakeRtkBin = path.join(specialProfile, "fake-rtk");
      fs.mkdirSync(fakeRtkBin, { recursive: true });
      const fakeRtk = path.join(fakeRtkBin, "rtk");
      fs.writeFileSync(fakeRtk, '#!/bin/sh\necho "rtk 1.1.0"\n');
      fs.chmodSync(fakeRtk, 0o755);
      const specialEnv = {
        ...process.env,
        AGY_TEST_PROFILE_DIR: specialProfile,
        PATH: `${fakeRtkBin}:${process.env.PATH || ""}`
      };
      const installScriptPath = fileURLToPath(new URL("../scripts/install-register.mjs", import.meta.url));
      const installSpecial = spawnSync(process.execPath, [installScriptPath], {
        env: specialEnv,
        encoding: "utf8"
      });
      assert.equal(installSpecial.status, 0, installSpecial.stderr || installSpecial.stdout);
      const posixShim = path.join(specialProfile, ".gemini", "antigravity", "bin", "agy-context");
      const shimBody = fs.readFileSync(posixShim, "utf8");
      assert.match(shimBody, /\\\$shim/, "POSIX shim must backslash-escape $ in target path (ACS-TEST-003)");
      const shimExec = spawnSync(posixShim, ["--version"], { env: specialEnv, encoding: "utf8" });
      assert.equal(shimExec.status, 0, `Escaped POSIX shim failed: ${shimExec.stderr}`);
      assert.match(shimExec.stdout.trim(), /^\d+\.\d+\.\d+/);
    } finally {
      fs.rmSync(specialProfile, { recursive: true, force: true });
    }
  }
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

  // Broken symlink at pluginDest must also be cleanly unlinked by runUninstall
  let brokenAcsSymCreated = false;
  try {
    fs.mkdirSync(path.dirname(pluginDest), { recursive: true });
    fs.symlinkSync(path.join(testProfileDir, "missing-acs-target"), pluginDest, os.platform() === "win32" ? "junction" : "dir");
    brokenAcsSymCreated = true;
  } catch (err) {
    if (err?.code !== "EPERM") throw err;
  }
  if (brokenAcsSymCreated) {
    await runUninstall({ silent: true });
    assert.throws(() => fs.lstatSync(pluginDest), { code: "ENOENT" }, "runUninstall must remove broken pluginDest symlink");
  }
  console.log("✓ Copy fallback, symlink-to-copy upgrade, node.cmd cleanup, and backup restoration verified");

  // --- 5. Launch UX Regressions (UX-ACS-001, UX-ACS-003, UX-ACS-004, UX-ACS-006, UX-ACS-013) ---
  console.log("\n--- 5. Launch UX Day-One Regressions (Managed RTK Shim, PATH Onboarding, Git Config, Windows Parity & Status Hints) ---");
  {
    const { spawnSync } = await import("node:child_process");
    const installScriptPath = fileURLToPath(new URL("../scripts/install-register.mjs", import.meta.url));
    const uxProfile = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ux-lifecycle-"));
    try {
      const uxBinDir = path.join(uxProfile, ".gemini", "antigravity", "bin");
      const uxConfigDir = path.join(uxProfile, ".gemini", "config");
      const uxPluginBin = path.join(uxConfigDir, "plugins", "agy-context-saver", "bin");
      const uxGitConfig = path.join(uxProfile, ".gitconfig");
      const origGitContent = "[core]\n\tsafecrlf = true\n";
      fs.writeFileSync(uxGitConfig, origGitContent, "utf-8");

      // 5a. UX-ACS-013: Clean profile `status` prints NOT INSTALLED + Next step setup hint; --json stays pure JSON
      const emptyPathEnv = {
        ...process.env,
        AGY_TEST_PROFILE_DIR: uxProfile,
        GIT_CONFIG_GLOBAL: uxGitConfig,
        PATH: path.dirname(process.execPath)
      };
      if (process.platform === "win32") emptyPathEnv.Path = emptyPathEnv.PATH;

      const cleanStatus = spawnSync(process.execPath, [installScriptPath, "--status"], {
        env: emptyPathEnv,
        encoding: "utf-8"
      });
      assert.notEqual(cleanStatus.status, 0);
      assert.match(cleanStatus.stdout, /Overall Status:\s*NOT INSTALLED/);
      assert.match(cleanStatus.stdout, /Next step:\s*run 'npx --package=agy-context-saver agy-context setup'/);

      const cleanStatusJson = spawnSync(process.execPath, [installScriptPath, "--status", "--json"], {
        env: emptyPathEnv,
        encoding: "utf-8"
      });
      assert.notEqual(cleanStatusJson.status, 0);
      const parsedClean = JSON.parse(cleanStatusJson.stdout);
      assert.equal(parsedClean.isInstalled, false);

      // 5b. UX-ACS-001 + UX-ACS-003 + UX-ACS-004 + UX-ACS-006:
      // Provision standalone local-only RTK inside pluginDest/bin (no RTK on PATH), run copy-mode setup (matching npx) with uxBinDir OFF PATH
      const writeStandaloneFakeRtk = (dir) => {
        fs.mkdirSync(dir, { recursive: true });
        if (process.platform === "win32") {
          const p = path.join(dir, "rtk.cmd");
          fs.writeFileSync(p, "@echo off\r\necho rtk 1.1.0\r\n", "utf-8");
          return p;
        }
        const p = path.join(dir, "rtk");
        fs.writeFileSync(p, '#!/bin/sh\necho "rtk 1.1.0"\n', "utf-8");
        fs.chmodSync(p, 0o755);
        return p;
      };
      const runCopySetup = (env, extraOpts = "") =>
        spawnSync(
          process.execPath,
          ["--input-type=module", "-e", `import { runInstall } from ${JSON.stringify(new URL("../scripts/install-register.mjs", import.meta.url).href)}; await runInstall({ forceCopyFallback: true${extraOpts ? `, ${extraOpts}` : ""} });`],
          { env, encoding: "utf-8" }
        );

      writeStandaloneFakeRtk(uxPluginBin);
      const setupOffPath = runCopySetup(emptyPathEnv);
      assert.equal(setupOffPath.status, 0, setupOffPath.stderr || setupOffPath.stdout);

      // UX-ACS-004: GIT_CONFIG_GLOBAL must stay untouched
      assert.equal(
        fs.readFileSync(uxGitConfig, "utf-8"),
        origGitContent,
        "runInstall must NEVER mutate GIT_CONFIG_GLOBAL (UX-ACS-004)"
      );

      // UX-ACS-006: Next steps guidance emitted
      assert.match(setupOffPath.stdout, /Next steps:/);
      assert.match(setupOffPath.stdout, /Reload Antigravity Desktop IDE or start a new session/);
      assert.match(setupOffPath.stdout, /agy-context status/);

      // UX-ACS-003: PATH warning + copy-paste export snippet + npx fallback emitted when uxBinDir is absent from PATH
      assert.match(setupOffPath.stdout, /\[NEXT STEP\] CLI bin directory is not on your PATH/);
      assert.match(setupOffPath.stdout, /npx --package=agy-context-saver agy-context status/);
      if (process.platform === "win32") {
        assert.match(setupOffPath.stdout, /\$env:Path/);
        assert.match(setupOffPath.stdout, /CreateSubKey\("Environment"\)/);
      } else {
        assert.match(setupOffPath.stdout, /export PATH="\$HOME\/\.gemini\/antigravity\/bin:\$PATH"/);
      }

      // UX-ACS-001: Managed rtk shim installed into uxBinDir and executable
      const managedRtkShim = path.join(uxBinDir, process.platform === "win32" ? "rtk.cmd" : "rtk");
      assert.equal(fs.existsSync(managedRtkShim), true, "Managed rtk shim must be installed when local plugin rtk is used (UX-ACS-001)");
      assert.equal(isManagedAgyShimFile(managedRtkShim), true, "Managed rtk shim must carry agy-context-saver-managed marker");
      if (process.platform !== "win32") {
        const shimVer = spawnSync(managedRtkShim, ["--version"], { env: emptyPathEnv, encoding: "utf-8" });
        assert.equal(shimVer.status, 0, `Managed rtk shim execution failed: ${shimVer.stderr}`);
        assert.match(shimVer.stdout, /rtk 1\.1\.0/);
      }

      // UX-ACS-003: `status` emits PATH onboarding when off PATH, omits it when uxBinDir IS on PATH
      const statusOffPath = spawnSync(process.execPath, [installScriptPath, "--status"], {
        env: emptyPathEnv,
        encoding: "utf-8"
      });
      assert.equal(statusOffPath.status, 0, statusOffPath.stderr || statusOffPath.stdout);
      assert.match(statusOffPath.stdout, /\[NOT ON PATH\]/);
      assert.match(statusOffPath.stdout, /\[NEXT STEP\] CLI bin directory is not on your PATH/);

      const onPathEnv = {
        ...emptyPathEnv,
        PATH: `${uxBinDir}${path.delimiter}${emptyPathEnv.PATH}`
      };
      if (process.platform === "win32") onPathEnv.Path = onPathEnv.PATH;
      const statusOnPath = spawnSync(process.execPath, [installScriptPath, "--status"], {
        env: onPathEnv,
        encoding: "utf-8"
      });
      assert.equal(statusOnPath.status, 0, statusOnPath.stderr || statusOnPath.stdout);
      assert.equal(statusOnPath.stdout.includes("[NOT ON PATH]"), false);
      assert.equal(statusOnPath.stdout.includes("CLI bin directory is not on your PATH"), false);

      // UX-ACS-R2-001: Second copy-mode setup/upgrade WITH uxBinDir on PATH must preserve pluginDest/bin/rtk
      // and keep the managed shim executable & status HEALTHY
      const pluginLocalRtk = path.join(uxPluginBin, process.platform === "win32" ? "rtk.cmd" : "rtk");
      const setupOnPathUpgrade = runCopySetup(onPathEnv);
      assert.equal(setupOnPathUpgrade.status, 0, setupOnPathUpgrade.stderr || setupOnPathUpgrade.stdout);
      assert.equal(
        fs.existsSync(pluginLocalRtk),
        true,
        "Copy-mode re-install/upgrade with managed rtk shim on PATH must preserve pluginDest/bin/rtk (UX-ACS-R2-001)"
      );
      assert.equal(isManagedAgyShimFile(managedRtkShim), true, "Managed rtk shim must remain intact after on-PATH upgrade");
      const upgradedShimRun =
        process.platform === "win32"
          ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"\"${managedRtkShim}\" --version"`], {
              env: emptyPathEnv,
              encoding: "utf-8",
              windowsVerbatimArguments: true
            })
          : spawnSync(managedRtkShim, ["--version"], { env: emptyPathEnv, encoding: "utf-8" });
      assert.equal(upgradedShimRun.status, 0, `Managed rtk shim failed after on-PATH upgrade: ${upgradedShimRun.stderr}`);
      assert.match(upgradedShimRun.stdout, /rtk 1\.1\.0/);

      const statusAfterUpgradeJson = spawnSync(process.execPath, [installScriptPath, "--status", "--json"], {
        env: onPathEnv,
        encoding: "utf-8"
      });
      assert.equal(statusAfterUpgradeJson.status, 0, statusAfterUpgradeJson.stderr || statusAfterUpgradeJson.stdout);
      const parsedAfterUpgrade = JSON.parse(statusAfterUpgradeJson.stdout);
      assert.equal(parsedAfterUpgrade.isComplete, true, "status --json must remain isComplete === true after on-PATH copy upgrade");
      assert.equal(parsedAfterUpgrade.details.rtk?.isLocal, true, "Managed rtk shim on PATH must resolve as local plugin RTK");
      assert.ok(
        path.resolve(parsedAfterUpgrade.details.rtk?.path || "").startsWith(path.resolve(uxPluginBin) + path.sep),
        `Expected local pluginDest/bin rtk path, got: ${parsedAfterUpgrade.details.rtk?.path}`
      );

      // UX-ACS-013: Partial installation prints Next step hint in non-JSON mode
      fs.unlinkSync(path.join(uxConfigDir, "plugins", "agy-context-saver", "scripts", "execution-guard-hook.mjs"));
      const partialStatus = spawnSync(process.execPath, [installScriptPath, "--status"], {
        env: onPathEnv,
        encoding: "utf-8"
      });
      assert.notEqual(partialStatus.status, 0);
      assert.match(partialStatus.stdout, /Overall Status:\s*PARTIAL INSTALLATION/);
      assert.match(partialStatus.stdout, /Next step:\s*run 'npx --package=agy-context-saver agy-context setup'/);

      // UX-ACS-001 + PT-SCRIPT-002: Uninstall removes managed rtk shim cleanly and emits Antigravity reload notice
      const uninstallManaged = spawnSync(process.execPath, [installScriptPath, "--uninstall"], {
        env: emptyPathEnv,
        encoding: "utf-8"
      });
      assert.equal(uninstallManaged.status, 0, uninstallManaged.stderr || uninstallManaged.stdout);
      assert.equal(fs.existsSync(managedRtkShim), false, "Uninstall must remove Agy-managed rtk shim");
      assert.match(
        uninstallManaged.stdout,
        /Reload Antigravity Desktop IDE or start a new session/,
        "PT-SCRIPT-002: uninstall must emit post-uninstall Antigravity reload notice"
      );

      // UX-ACS-R2-001: Stale/dangling managed rtk shim cleanup when transitioning to --allow-degraded or external system rtk
      {
        // Case A: Transition to --allow-degraded when pluginDest/bin/rtk is gone removes dangling managed shim
        writeStandaloneFakeRtk(uxPluginBin);
        const seedRes = runCopySetup(emptyPathEnv);
        assert.equal(seedRes.status, 0, seedRes.stderr || seedRes.stdout);
        assert.equal(isManagedAgyShimFile(managedRtkShim), true);
        fs.unlinkSync(pluginLocalRtk);
        const degradedOnlyShimEnv = { ...emptyPathEnv, PATH: uxBinDir };
        if (process.platform === "win32") degradedOnlyShimEnv.Path = uxBinDir;
        const degradedCleanupRes = runCopySetup(degradedOnlyShimEnv, "allowDegraded: true");
        assert.equal(degradedCleanupRes.status, 0, degradedCleanupRes.stderr || degradedCleanupRes.stdout);
        assert.equal(
          fs.existsSync(managedRtkShim),
          false,
          "Stale/dangling managed rtk shim must be removed on --allow-degraded when no local RTK binary exists (UX-ACS-R2-001)"
        );

        // SVC-003: When RTK is the sole missing component after --allow-degraded, status prints manual RTK install + --allow-degraded guidance
        const degradedOnlyStatus = spawnSync(process.execPath, [installScriptPath, "--status"], {
          env: degradedOnlyShimEnv,
          encoding: "utf-8"
        });
        assert.notEqual(degradedOnlyStatus.status, 0);
        assert.match(degradedOnlyStatus.stdout, /Overall Status:\s*PARTIAL INSTALLATION/);
        assert.match(degradedOnlyStatus.stdout, /degraded mode/i);
        assert.match(degradedOnlyStatus.stdout, /brew install rtk/);
        assert.match(degradedOnlyStatus.stdout, /cargo install --locked rtk/);
        assert.match(degradedOnlyStatus.stdout, /--allow-degraded/);

        // Case B (SVC-002 / TEST-001): Transition to external system rtk later on PATH supersedes bundled pluginDest/bin/rtk
        // WITHOUT manually unlinking pluginLocalRtk, removes the stale managed shim, and reports system rtk 1.2.0
        writeStandaloneFakeRtk(uxPluginBin);
        const seedSysRes = runCopySetup(emptyPathEnv);
        assert.equal(seedSysRes.status, 0, seedSysRes.stderr || seedSysRes.stdout);
        assert.equal(isManagedAgyShimFile(managedRtkShim), true);
        assert.equal(fs.existsSync(pluginLocalRtk), true, "Bundled pluginLocalRtk stays on disk to test realistic system-RTK upgrade");

        const sysRtkDir = path.join(uxProfile, "system-rtk-bin");
        fs.mkdirSync(sysRtkDir, { recursive: true });
        if (process.platform === "win32") {
          fs.writeFileSync(path.join(sysRtkDir, "rtk.cmd"), "@echo off\r\necho rtk 1.2.0\r\n", "utf-8");
        } else {
          const sysRtk = path.join(sysRtkDir, "rtk");
          fs.writeFileSync(sysRtk, '#!/bin/sh\necho "rtk 1.2.0"\n', "utf-8");
          fs.chmodSync(sysRtk, 0o755);
        }
        const sysTransitionEnv = {
          ...emptyPathEnv,
          PATH: `${uxBinDir}${path.delimiter}${sysRtkDir}${path.delimiter}${emptyPathEnv.PATH}`
        };
        if (process.platform === "win32") sysTransitionEnv.Path = sysTransitionEnv.PATH;
        const sysTransitionRes = runCopySetup(sysTransitionEnv);
        assert.equal(sysTransitionRes.status, 0, sysTransitionRes.stderr || sysTransitionRes.stdout);
        assert.equal(
          fs.existsSync(managedRtkShim),
          false,
          "Stale managed rtk shim must be removed when external system rtk supersedes bundled pluginDest/bin/rtk (SVC-002)"
        );
        const statusSysJson = spawnSync(process.execPath, [installScriptPath, "--status", "--json"], {
          env: sysTransitionEnv,
          encoding: "utf-8"
        });
        assert.equal(statusSysJson.status, 0, statusSysJson.stderr || statusSysJson.stdout);
        const parsedSys = JSON.parse(statusSysJson.stdout);
        assert.equal(parsedSys.isComplete, true);
        assert.equal(parsedSys.details.rtk?.isLocal, false);
        assert.match(parsedSys.details.rtk?.version || "", /1\.2\.0/);

        const uninstallAfterSys = spawnSync(process.execPath, [installScriptPath, "--uninstall"], {
          env: emptyPathEnv,
          encoding: "utf-8"
        });
        assert.equal(uninstallAfterSys.status, 0, uninstallAfterSys.stderr || uninstallAfterSys.stdout);

        // Case C: Migrating directly from a local git-clone symlink (with bin/rtk) to copy mode preserves local RTK on first run
        const uxPluginDest = path.dirname(uxPluginBin);
        const fakeCloneRoot = path.join(uxProfile, "fake-clone-checkout");
        writeStandaloneFakeRtk(path.join(fakeCloneRoot, "bin"));
        fs.mkdirSync(path.dirname(uxPluginDest), { recursive: true });
        let symlinkSeeded = false;
        try {
          fs.symlinkSync(fakeCloneRoot, uxPluginDest, process.platform === "win32" ? "junction" : "dir");
          symlinkSeeded = true;
        } catch (err) {
          if (err?.code !== "EPERM") throw err;
        }
        if (symlinkSeeded) {
          const symlinkToCopyRes = runCopySetup(emptyPathEnv);
          assert.equal(symlinkToCopyRes.status, 0, symlinkToCopyRes.stderr || symlinkToCopyRes.stdout);
          assert.equal(fs.lstatSync(uxPluginDest).isSymbolicLink(), false, "Copy setup must replace symlink with a standalone copy");
          assert.equal(
            fs.existsSync(pluginLocalRtk),
            true,
            "Symlink-to-copy migration must carry over previously bundled local bin/rtk on first run"
          );
          assert.equal(isManagedAgyShimFile(managedRtkShim), true);
          const uninstallAfterSymlinkCopy = spawnSync(process.execPath, [installScriptPath, "--uninstall"], {
            env: emptyPathEnv,
            encoding: "utf-8"
          });
          assert.equal(uninstallAfterSymlinkCopy.status, 0, uninstallAfterSymlinkCopy.stderr || uninstallAfterSymlinkCopy.stdout);
        }
      }

      // UX-ACS-001: Pre-existing unmanaged user rtk binary in antigravityBinDir must NEVER be overwritten or deleted
      fs.mkdirSync(uxBinDir, { recursive: true });
      const userRtkBody = process.platform === "win32"
        ? "@echo off\r\necho user-custom-rtk 1.1.0\r\n"
        : "#!/bin/sh\necho 'user-custom-rtk 1.1.0'\n";
      fs.writeFileSync(managedRtkShim, userRtkBody, "utf-8");
      if (process.platform !== "win32") fs.chmodSync(managedRtkShim, 0o755);
      writeStandaloneFakeRtk(uxPluginBin);
      const setupPreserveUserRtk = runCopySetup(emptyPathEnv);
      assert.equal(setupPreserveUserRtk.status, 0, setupPreserveUserRtk.stderr || setupPreserveUserRtk.stdout);
      assert.equal(fs.readFileSync(managedRtkShim, "utf-8"), userRtkBody, "Setup must never overwrite an unmanaged user rtk binary");

      // Unmanaged user rtk must also survive --allow-degraded when no local pluginDest/bin/rtk exists
      if (fs.existsSync(pluginLocalRtk)) fs.unlinkSync(pluginLocalRtk);
      const degradedPreserveUserRtk = runCopySetup({ ...emptyPathEnv, PATH: path.dirname(process.execPath) }, "allowDegraded: true");
      assert.equal(degradedPreserveUserRtk.status, 0, degradedPreserveUserRtk.stderr || degradedPreserveUserRtk.stdout);
      assert.equal(fs.readFileSync(managedRtkShim, "utf-8"), userRtkBody, "Stale-shim cleanup must NEVER remove an unmanaged user rtk binary");

      const uninstallPreserveUserRtk = spawnSync(process.execPath, [installScriptPath, "--uninstall"], {
        env: emptyPathEnv,
        encoding: "utf-8"
      });
      assert.equal(uninstallPreserveUserRtk.status, 0, uninstallPreserveUserRtk.stderr || uninstallPreserveUserRtk.stdout);
      assert.equal(fs.existsSync(managedRtkShim), true, "Uninstall must NEVER remove a user's unmanaged rtk binary");
      assert.equal(fs.readFileSync(managedRtkShim, "utf-8"), userRtkBody);

      // UX-ACS-003 / DOC-001: Unit checks for isDirOnPath and safe idempotent REG_EXPAND_SZ-preserving Windows PATH snippet
      assert.equal(isDirOnPath(uxBinDir, `${uxBinDir}${path.delimiter}/usr/bin`), true);
      assert.equal(isDirOnPath(uxBinDir, `${uxBinDir}${path.sep}${path.delimiter}/usr/bin`), true);
      assert.equal(isDirOnPath(uxBinDir, "/usr/bin:/bin", "linux"), false);
      assert.equal(
        isDirOnPath("C:\\Users\\Dev\\.gemini\\antigravity\\bin", '"c:\\users\\dev\\.gemini\\antigravity\\bin\\";C:\\Windows', "win32"),
        true
      );
      const winPathLines = formatPathOnboardingLines("C:\\Users\\Dev\\.gemini\\antigravity\\bin", { platform: "win32" }).join("\n");
      assert.match(winPathLines, /\$env:Path/);
      assert.match(winPathLines, /CreateSubKey\("Environment"\)/);
      assert.match(winPathLines, /DoNotExpandEnvironmentNames/);
      assert.match(winPathLines, /RegistryValueKind\]::ExpandString/);
      assert.match(winPathLines, /-notcontains/);
      assert.equal(winPathLines.includes('SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable'), false, "Unsafe REG_SZ flattening snippet must not be emitted (DOC-001)");
      assert.match(winPathLines, /npx --package=agy-context-saver agy-context status/);

      if (process.platform === "win32") {
        // Verify the pure PowerShell PATH normalization logic handles $null, trailing ';', REG_EXPAND_SZ vars, and idempotent re-run
        const psPathCheckScript = [
          "$bin = 'C:\\Users\\Dev\\.gemini\\antigravity\\bin'",
          "$raw = '%USERPROFILE%\\.gemini\\antigravity\\bin'",
          "function Add-AgyPath($cur) {",
          "  $parts = @(([string]$cur) -split ';' | Where-Object { $_ })",
          "  $norm = @($parts | ForEach-Object { $_.TrimEnd('\\') })",
          "  if ($norm -notcontains $bin -and $norm -notcontains $raw) { return (($parts + $raw) -join ';') }",
          "  return ($parts -join ';')",
          "}",
          "$rNull = Add-AgyPath $null",
          "$rTrail = Add-AgyPath '%LOCALAPPDATA%\\Programs\\Python;'",
          "$rDup = Add-AgyPath $rTrail",
          "$rExpand = Add-AgyPath 'C:\\Users\\Dev\\.gemini\\antigravity\\bin\\;C:\\Windows'",
          "Write-Output \"NULL=$rNull\"",
          "Write-Output \"TRAIL=$rTrail\"",
          "Write-Output \"DUP=$rDup\"",
          "Write-Output \"EXP=$rExpand\""
        ].join("\n");
        const psRes = spawnSync("powershell", ["-NoProfile", "-Command", psPathCheckScript], { encoding: "utf-8" });
        assert.equal(psRes.status, 0, `PowerShell PATH helper test failed: ${psRes.stderr}`);
        assert.match(psRes.stdout, /NULL=%USERPROFILE%\\\.gemini\\antigravity\\bin\r?\n/);
        assert.match(psRes.stdout, /TRAIL=%LOCALAPPDATA%\\Programs\\Python;%USERPROFILE%\\\.gemini\\antigravity\\bin\r?\n/);
        assert.match(psRes.stdout, /DUP=%LOCALAPPDATA%\\Programs\\Python;%USERPROFILE%\\\.gemini\\antigravity\\bin\r?\n/);
        assert.match(psRes.stdout, /EXP=C:\\Users\\Dev\\\.gemini\\antigravity\\bin\\;C:\\Windows\r?\n/);
      }

      // DEP-001: Runtime Node.js >= 22 version preflight assertions
      for (const badNode of ["v18.20.0", "20.18.0", "v16.0.0", "0.0.0", ""]) {
        assert.throws(
          () => assertSupportedNodeVersion(badNode),
          /Unsupported Node\.js version.*requires Node\.js >= 22\.0\.0/i,
          `Node version '${badNode}' must be rejected (DEP-001)`
        );
      }
      assert.equal(assertSupportedNodeVersion("v22.0.0"), 22);
      assert.equal(assertSupportedNodeVersion("22.14.0"), 22);
      assert.equal(assertSupportedNodeVersion("v24.1.0"), 24);
      if (process.platform !== "win32") {
        const fakeOldNodeDir = path.join(uxProfile, "fake-node20-bin");
        fs.mkdirSync(fakeOldNodeDir, { recursive: true });
        const fakeOldNode = path.join(fakeOldNodeDir, "node");
        fs.writeFileSync(fakeOldNode, '#!/bin/sh\nif [ "$1" = "-v" ]; then echo "v20.18.0"; exit 0; fi\nexit 0\n', "utf-8");
        fs.chmodSync(fakeOldNode, 0o755);
        const installShPath = path.resolve(fileURLToPath(import.meta.url), "../../install.sh");
        const oldNodeShRes = spawnSync("bash", [installShPath, "--check"], {
          env: { ...process.env, PATH: `${fakeOldNodeDir}:/usr/bin:/bin` },
          encoding: "utf-8"
        });
        assert.notEqual(oldNodeShRes.status, 0, "install.sh must reject Node.js v20.x (DEP-001)");
        assert.match(oldNodeShRes.stderr, /Unsupported Node\.js version v20\.18\.0.*>= 22\.0\.0/i);
      }

      // SCRIPT-002: Copy-mode provisioning with read-only (0o555) repoRoot/bin targets pluginDest/bin without EACCES
      if (process.platform !== "win32") {
        const cryptoMod = await import("node:crypto");
        const roRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ro-repo-"));
        const roProfile = path.join(roRoot, "profile");
        const roRepo = path.join(roRoot, "readonly-pkg");
        const roRepoBin = path.join(roRepo, "bin");
        const archiveStage = path.join(roRoot, "archive-src");
        try {
          const srcRepoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
          for (const entry of [
            "package.json",
            "plugin.json",
            "hooks.json",
            "README.md",
            "CHANGELOG.md",
            "LICENSE",
            "install.sh",
            "install.ps1",
            "assets",
            "bin",
            "lib",
            "scripts",
            "rules",
            "skills"
          ]) {
            const srcPath = path.join(srcRepoRoot, entry);
            if (fs.existsSync(srcPath)) {
              fs.cpSync(srcPath, path.join(roRepo, entry), { recursive: true });
            }
          }
          // Build a real .tar.gz archive containing a fake executable rtk (v1.1.0)
          fs.mkdirSync(archiveStage, { recursive: true });
          const fakeRtkInArchive = path.join(archiveStage, "rtk");
          fs.writeFileSync(fakeRtkInArchive, '#!/bin/sh\necho "rtk 1.1.0"\n', "utf-8");
          fs.chmodSync(fakeRtkInArchive, 0o755);
          const archiveFile = path.join(roRoot, "rtk-test.tar.gz");
          const tarRes = spawnSync("tar", ["-czf", archiveFile, "-C", archiveStage, "rtk"], { encoding: "utf-8" });
          assert.equal(tarRes.status, 0, `tar archive creation failed: ${tarRes.stderr}`);
          const archiveBuf = fs.readFileSync(archiveFile);
          const archiveSha = cryptoMod.createHash("sha256").update(archiveBuf).digest("hex");

          // Remove any developer-local rtk binary copied from checkout so roRepo mirrors a clean npm tarball
          for (const staleRtk of ["rtk", "rtk.exe", "rtk.cmd"]) {
            const p = path.join(roRepoBin, staleRtk);
            if (fs.existsSync(p)) fs.unlinkSync(p);
          }

          // Lock down ENTIRE roRepo tree to immutable Nix/npm-store permissions (0o555 dirs, 0o444 files)
          const lockReadOnlyTree = (dirPath) => {
            for (const entry of fs.readdirSync(dirPath)) {
              const p = path.join(dirPath, entry);
              const st = fs.lstatSync(p);
              if (st.isDirectory()) {
                lockReadOnlyTree(p);
                fs.chmodSync(p, 0o555);
              } else if (st.isFile()) {
                fs.chmodSync(p, 0o444);
              }
            }
          };

          lockReadOnlyTree(roRepo);
          fs.chmodSync(roRepo, 0o555);
          const roInstallModuleUrl = `file://${path.join(roRepo, "scripts", "install-register.mjs")}`;
          const roEnv = {
            ...process.env,
            AGY_TEST_PROFILE_DIR: roProfile,
            PATH: path.dirname(process.execPath) + ":/usr/bin:/bin"
          };

          // 1) Initial install + 2) Re-install/upgrade + 3) Uninstall from fully immutable 0o555/0o444 package store
          const roRunRes = spawnSync(
            process.execPath,
            [
              "-e",
              `import fs from "node:fs";
               import { runInstall, runUninstall } from ${JSON.stringify(roInstallModuleUrl)};
               const archiveBuf = fs.readFileSync(${JSON.stringify(archiveFile)});
               const installOpts = {
                 silent: true,
                 forceCopyFallback: true,
                 rtkOptions: {
                   platform: "linux",
                   arch: "x64",
                   pathEnv: "",
                   platformAsset: { asset: "rtk-test.tar.gz", exeName: "rtk", isZip: false },
                   checksums: { "rtk-test.tar.gz": ${JSON.stringify(archiveSha)} },
                   fetch: async () => ({ ok: true, arrayBuffer: async () => archiveBuf })
                 }
               };
               await runInstall(installOpts);
               await runInstall(installOpts);
               await runUninstall({ silent: true });
               // 4) Re-install when pluginDest is an existing symlink -> immutable roRepo must NOT write through symlink
               const pluginDest = ${JSON.stringify(path.join(roProfile, ".gemini", "config", "plugins", "agy-context-saver"))};
               fs.mkdirSync(${JSON.stringify(path.join(roProfile, ".gemini", "config", "plugins"))}, { recursive: true });
               fs.symlinkSync(${JSON.stringify(roRepo)}, pluginDest, "dir");
               await runInstall(installOpts);`
            ],
            { env: roEnv, encoding: "utf-8" }
          );
          assert.equal(roRunRes.status, 0, `Immutable 0o555/0o444 install/re-install/uninstall/symlink-replace failed (SCRIPT-002): ${roRunRes.stderr || roRunRes.stdout}`);
          const installedPluginRtk = path.join(roProfile, ".gemini", "config", "plugins", "agy-context-saver", "bin", "rtk");
          assert.equal(fs.existsSync(installedPluginRtk), true, "RTK must be provisioned into user-writable pluginDest/bin (SCRIPT-002)");
          assert.equal(fs.lstatSync(path.join(roProfile, ".gemini", "config", "plugins", "agy-context-saver")).isSymbolicLink(), false, "Symlink to read-only repo must be replaced by copy");
          assert.equal(fs.existsSync(path.join(roRepoBin, "rtk")), false, "Read-only repoRoot/bin must never be mutated (SCRIPT-002)");

          // 5) Failed RTK download on a fresh profile (no --allow-degraded) must NOT leave an orphan pluginDest directory
          const failProfile = path.join(roRoot, "fail-profile");
          const failRes = spawnSync(
            process.execPath,
            [
              "-e",
              `import { runInstall } from ${JSON.stringify(roInstallModuleUrl)};
               await runInstall({
                 silent: true,
                 forceCopyFallback: true,
                 rtkOptions: {
                   platform: "linux",
                   arch: "x64",
                   pathEnv: "",
                   fetch: async () => ({ ok: false, status: 503, statusText: "Offline" })
                 }
               });`
            ],
            {
              env: { ...roEnv, AGY_TEST_PROFILE_DIR: failProfile },
              encoding: "utf-8"
            }
          );
          assert.notEqual(failRes.status, 0, "Failed RTK download without --allow-degraded must fail");
          assert.equal(
            fs.existsSync(path.join(failProfile, ".gemini", "config", "plugins", "agy-context-saver")),
            false,
            "Failed RTK provisioning must NOT leave an orphan pluginDest/bin directory behind"
          );
        } finally {
          const restoreWritable = (p) => {
            if (!fs.existsSync(p)) return;
            const st = fs.lstatSync(p);
            if (st.isSymbolicLink()) return;
            if (st.isDirectory()) {
              try { fs.chmodSync(p, 0o755); } catch {}
              for (const entry of fs.readdirSync(p)) restoreWritable(path.join(p, entry));
            } else if (st.isFile()) {
              try { fs.chmodSync(p, 0o644); } catch {}
            }
          };
          restoreWritable(roRoot);
          fs.rmSync(roRoot, { recursive: true, force: true });
        }
      }

      // A-Win1: cleanupLegacyWindowsNodeCmd unit + runInstall / runUninstall retirement tests (never creates node.cmd)
      const fakeWinCfg = path.join(uxProfile, "win-node-cleanup");
      fs.mkdirSync(fakeWinCfg, { recursive: true });
      const origUserNodeCmd = "@echo off\r\nREM user-owned-node-cmd\r\n";
      const managedNodeCmd = "@echo off\r\nREM agy-context-saver-managed\r\n";
      const fakeNodeCmd = path.join(fakeWinCfg, "node.cmd");
      const fakeNodeBak = path.join(fakeWinCfg, "node.cmd.bak");
      // Unmanaged user node.cmd must be preserved untouched
      fs.writeFileSync(fakeNodeCmd, origUserNodeCmd, "utf-8");
      assert.equal(await cleanupLegacyWindowsNodeCmd({ geminiConfigDir: fakeWinCfg }), false);
      assert.equal(fs.readFileSync(fakeNodeCmd, "utf-8"), origUserNodeCmd);
      // Managed node.cmd + node.cmd.bak -> removes managed wrapper and restores backup
      fs.writeFileSync(fakeNodeCmd, managedNodeCmd, "utf-8");
      fs.writeFileSync(fakeNodeBak, origUserNodeCmd, "utf-8");
      assert.equal(await cleanupLegacyWindowsNodeCmd({ geminiConfigDir: fakeWinCfg }), true);
      assert.equal(fs.readFileSync(fakeNodeCmd, "utf-8"), origUserNodeCmd);
      assert.equal(fs.existsSync(fakeNodeBak), false);
      // Managed node.cmd without backup -> removes managed wrapper cleanly
      fs.writeFileSync(fakeNodeCmd, managedNodeCmd, "utf-8");
      assert.equal(await cleanupLegacyWindowsNodeCmd({ geminiConfigDir: fakeWinCfg }), true);
      assert.equal(fs.existsSync(fakeNodeCmd), false);

      // Verify both runInstall and runUninstall clean up legacy managed node.cmd, restore node.cmd.bak, and never create a new node.cmd
      const uxNodeCmd = path.join(uxConfigDir, "node.cmd");
      const uxNodeBak = path.join(uxConfigDir, "node.cmd.bak");
      fs.mkdirSync(uxConfigDir, { recursive: true });
      fs.writeFileSync(uxNodeCmd, managedNodeCmd, "utf-8");
      fs.writeFileSync(uxNodeBak, origUserNodeCmd, "utf-8");
      const installCleanNode = runCopySetup(emptyPathEnv, "allowDegraded: true");
      assert.equal(installCleanNode.status, 0, installCleanNode.stderr || installCleanNode.stdout);
      assert.equal(fs.readFileSync(uxNodeCmd, "utf-8"), origUserNodeCmd, "A-Win1: runInstall must restore node.cmd.bak over legacy managed node.cmd");
      assert.equal(fs.existsSync(uxNodeBak), false, "A-Win1: runInstall must consume node.cmd.bak on restore");
      fs.unlinkSync(uxNodeCmd);
      const installNoNode = runCopySetup(emptyPathEnv, "allowDegraded: true");
      assert.equal(installNoNode.status, 0, installNoNode.stderr || installNoNode.stdout);
      assert.equal(fs.existsSync(uxNodeCmd), false, "A-Win1: runInstall must never create a new node.cmd");
      // Also verify runUninstall cleans a legacy managed node.cmd and restores node.cmd.bak
      fs.writeFileSync(uxNodeCmd, managedNodeCmd, "utf-8");
      fs.writeFileSync(uxNodeBak, origUserNodeCmd, "utf-8");
      const uninstallCleanNode = spawnSync(process.execPath, [installScriptPath, "--uninstall"], {
        env: emptyPathEnv,
        encoding: "utf-8"
      });
      assert.equal(uninstallCleanNode.status, 0, uninstallCleanNode.stderr || uninstallCleanNode.stdout);
      assert.equal(fs.readFileSync(uxNodeCmd, "utf-8"), origUserNodeCmd, "A-Win1: runUninstall must restore node.cmd.bak over legacy managed node.cmd");
      assert.equal(fs.existsSync(uxNodeBak), false);
      assert.match(uninstallCleanNode.stdout, /Reload Antigravity Desktop IDE or start a new session/);
    } finally {
      fs.rmSync(uxProfile, { recursive: true, force: true });
    }
    console.log("✓ Managed RTK shim, PATH onboarding, GIT_CONFIG_GLOBAL safety, A-Win1 legacy node.cmd cleanup, PT-SCRIPT-002 reload notice, and status hints verified");
  }

  // --- 6. 1B.4 Namespaced Backups, Legacy Ownership Gating, Fail-Closed Corrupt Backups & Key-Scoped Merge-Restore ---
  console.log("\n--- 6. 1B.4 Backup Namespacing, Ownership Gating, Fail-Closed Validation & Key-Scoped Merge-Restore ---");
  {
    const b4Profile = fs.mkdtempSync(path.join(os.tmpdir(), "agy-1b4-backups-"));
    const prevProfile = process.env.AGY_TEST_PROFILE_DIR;
    process.env.AGY_TEST_PROFILE_DIR = b4Profile;
    try {
      const p = resolveProfilePaths();
      fs.mkdirSync(p.geminiConfigDir, { recursive: true });
      assert.match(p.hooksBakPath, /hooks\.json\.agy-context-saver\.bak$/);
      assert.match(p.mcpBakPath, /mcp_config\.json\.agy-context-saver\.bak$/);

      // 6a. Key-scoped merge-restore preserves post-install foreign hooks and foreign MCP servers
      fs.writeFileSync(p.hooksJsonPath, JSON.stringify({
        "execution-guard": { PreToolUse: [{ matcher: "legacy", hooks: [] }] },
        "pre-install-foreign-hook": { PreToolUse: [] }
      }, null, 2), "utf-8");
      fs.writeFileSync(p.mcpJsonPath, JSON.stringify({
        mcpServers: {
          "agy-context-saver": { command: "node", args: ["old-mcp.js"] },
          "pre-install-foreign-mcp": { command: "node", args: ["keep.js"] }
        }
      }, null, 2), "utf-8");

      await runInstall({ silent: true, allowDegraded: true });
      assert.ok(fs.existsSync(p.hooksBakPath), "1B.4: install must create namespaced hooks.json.agy-context-saver.bak");
      assert.equal(fs.existsSync(p.legacyHooksBakPath), false, "1B.4: install must not create unnamespaced hooks.json.bak");
      assert.ok(fs.existsSync(p.mcpBakPath), "1B.4: install must create namespaced mcp_config.json.agy-context-saver.bak");

      // Simulate user installing a brand-new foreign plugin/MCP AFTER agy-context-saver setup
      const liveHooksAfterInstall = JSON.parse(fs.readFileSync(p.hooksJsonPath, "utf-8"));
      liveHooksAfterInstall["post-install-foreign-hook"] = { PreToolUse: [{ matcher: "run_command", hooks: [] }] };
      fs.writeFileSync(p.hooksJsonPath, JSON.stringify(liveHooksAfterInstall, null, 2), "utf-8");

      const liveMcpAfterInstall = JSON.parse(fs.readFileSync(p.mcpJsonPath, "utf-8"));
      liveMcpAfterInstall.mcpServers["post-install-foreign-mcp"] = { command: "node", args: ["post.js"] };
      fs.writeFileSync(p.mcpJsonPath, JSON.stringify(liveMcpAfterInstall, null, 2), "utf-8");

      await runUninstall({ silent: true, restoreBackups: true });
      const mergedHooks = JSON.parse(fs.readFileSync(p.hooksJsonPath, "utf-8"));
      assert.deepEqual(mergedHooks["execution-guard"], { PreToolUse: [{ matcher: "legacy", hooks: [] }] }, "1B.4: legacy execution-guard key restored from backup");
      assert.equal(mergedHooks["agy-context-saver"], undefined, "1B.4: agy-context-saver key absent when absent from backup");
      assert.ok(mergedHooks["pre-install-foreign-hook"], "1B.4: pre-install foreign hook preserved");
      assert.ok(mergedHooks["post-install-foreign-hook"], "1B.4: post-install foreign hook preserved on key-scoped merge-restore");

      const mergedMcp = JSON.parse(fs.readFileSync(p.mcpJsonPath, "utf-8"));
      assert.deepEqual(mergedMcp.mcpServers["agy-context-saver"], { command: "node", args: ["old-mcp.js"] }, "1B.4: legacy agy-context-saver MCP key restored");
      assert.ok(mergedMcp.mcpServers["pre-install-foreign-mcp"], "1B.4: pre-install foreign MCP preserved");
      assert.ok(mergedMcp.mcpServers["post-install-foreign-mcp"], "1B.4: post-install foreign MCP preserved on key-scoped merge-restore");

      // 6b. Fail-closed corrupt namespaced backup rejection BEFORE mutating any file
      const snapshotHooks = JSON.stringify({ "stay-intact": { PreToolUse: [] } }, null, 2);
      const snapshotMcp = JSON.stringify({ mcpServers: { "stay-intact-mcp": { command: "node" } } }, null, 2);
      fs.writeFileSync(p.hooksJsonPath, snapshotHooks, "utf-8");
      fs.writeFileSync(p.mcpJsonPath, snapshotMcp, "utf-8");
      fs.writeFileSync(p.hooksBakPath, "{ corrupt hooks backup", "utf-8");
      await assert.rejects(() => runRestoreBackups({ silent: true }), /Configuration error|invalid JSON/i, "1B.4: corrupt hooks backup must fail closed");
      assert.equal(fs.readFileSync(p.hooksJsonPath, "utf-8"), snapshotHooks, "1B.4: live hooks.json must stay untouched on corrupt backup");
      assert.equal(fs.readFileSync(p.mcpJsonPath, "utf-8"), snapshotMcp, "1B.4: live mcp_config.json must stay untouched even when mcp backup is valid");

      // 6c. Legacy unnamespaced hooks.json.bak ownership gating (ignores foreign-only, restores owned, fails closed on corrupt owned)
      fs.rmSync(p.hooksBakPath, { force: true });
      fs.rmSync(p.mcpBakPath, { force: true });
      fs.writeFileSync(p.legacyHooksBakPath, JSON.stringify({ "unrelated-plugin": { PreToolUse: [] } }), "utf-8");
      const foreignOnlyRestored = await runRestoreBackups({ silent: true });
      assert.equal(foreignOnlyRestored, false, "1B.4: foreign-only legacy hooks.json.bak must be ignored");
      assert.equal(fs.readFileSync(p.hooksJsonPath, "utf-8"), snapshotHooks, "1B.4: live hooks.json untouched when legacy backup is foreign-only");

      fs.writeFileSync(p.legacyHooksBakPath, '{ "execution-guard": { corrupt', "utf-8");
      await assert.rejects(() => runRestoreBackups({ silent: true }), /Configuration error|invalid JSON/i, "1B.4: corrupt owned legacy hooks.json.bak must fail closed");
      assert.equal(fs.readFileSync(p.hooksJsonPath, "utf-8"), snapshotHooks);

      fs.writeFileSync(p.legacyHooksBakPath, JSON.stringify({
        "execution-guard": { PreToolUse: [{ matcher: "from-legacy-bak", hooks: [] }] },
        "old-foreign-in-bak": { PreToolUse: [] }
      }), "utf-8");
      const ownedLegacyRestored = await runRestoreBackups({ silent: true });
      assert.equal(ownedLegacyRestored, true, "1B.4: owned legacy hooks.json.bak must restore owned keys");
      const afterLegacyRestore = JSON.parse(fs.readFileSync(p.hooksJsonPath, "utf-8"));
      assert.deepEqual(afterLegacyRestore["execution-guard"], { PreToolUse: [{ matcher: "from-legacy-bak", hooks: [] }] });
      assert.ok(afterLegacyRestore["stay-intact"], "1B.4: live foreign hook preserved during legacy backup restore");
      assert.equal(afterLegacyRestore["old-foreign-in-bak"], undefined, "1B.4: unrelated foreign keys inside backup must not clobber live hooks.json");
    } finally {
      if (prevProfile === undefined) delete process.env.AGY_TEST_PROFILE_DIR;
      else process.env.AGY_TEST_PROFILE_DIR = prevProfile;
      fs.rmSync(b4Profile, { recursive: true, force: true });
    }
    console.log("✓ 1B.4 namespaced backups, legacy ownership gating, fail-closed corrupt backup rejection, and key-scoped merge-restore verified");
  }
} finally {
  try {
    fs.rmSync(testProfileDir, { recursive: true, force: true });
  } catch {}
}

console.log("\n=================================================");
console.log("ALL 2.0 LIFECYCLE & ROLLBACK TESTS PASSED!");
console.log("=================================================");
