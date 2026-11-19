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
    runInstall,
    runUninstall,
    detectExistingInstallation,
    formatWindowsCmdShim,
    formatWindowsNodeCmdWrapper,
    installWindowsNodeCmdWrapper,
    isDirOnPath,
    formatPathOnboardingLines,
    isManagedAgyShimFile,
    resolveProfilePaths
  } = await import("../scripts/install-register.mjs");
  const {
    pluginDest,
    destHook,
    hooksJsonPath,
    hooksBakPath,
    mcpJsonPath,
    mcpBakPath,
    antigravityMcpRootDir,
    antigravityBinDir
  } = resolveProfilePaths();

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

  // Windows .cmd shim avoids parenthesized %errorlevel% cmd parse-time bug and uses chcp 65001 >nul matching install.ps1 (L46)
  const cmdShimText = formatWindowsCmdShim(path.join(pluginDest, "bin", "agy-context.mjs"));
  assert.match(cmdShimText, /chcp 65001 >nul/);
  assert.match(cmdShimText, /if errorlevel 1 goto :fallback/);
  assert.match(cmdShimText, /:fallback/);
  assert.doesNotMatch(cmdShimText, /if %errorlevel% equ 0 \(/i);
  const ps1Text = fs.readFileSync(new URL("../install.ps1", import.meta.url), "utf8");
  assert.match(ps1Text, /chcp 65001 >nul/);
  assert.match(ps1Text, /\[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.doesNotMatch(ps1Text, /-Encoding ASCII/);
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
        assert.match(setupOffPath.stdout, /\$env:Path \+=/);
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
      fs.unlinkSync(path.join(uxConfigDir, "scripts", "execution-guard-hook.mjs"));
      const partialStatus = spawnSync(process.execPath, [installScriptPath, "--status"], {
        env: onPathEnv,
        encoding: "utf-8"
      });
      assert.notEqual(partialStatus.status, 0);
      assert.match(partialStatus.stdout, /Overall Status:\s*PARTIAL INSTALLATION/);
      assert.match(partialStatus.stdout, /Next step:\s*run 'npx --package=agy-context-saver agy-context setup'/);

      // UX-ACS-001: Uninstall removes managed rtk shim cleanly
      const uninstallManaged = spawnSync(process.execPath, [installScriptPath, "--uninstall"], {
        env: emptyPathEnv,
        encoding: "utf-8"
      });
      assert.equal(uninstallManaged.status, 0, uninstallManaged.stderr || uninstallManaged.stdout);
      assert.equal(fs.existsSync(managedRtkShim), false, "Uninstall must remove Agy-managed rtk shim");

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

        // Case B: Transition to external system rtk later on PATH removes dangling managed shim and resolves system rtk
        writeStandaloneFakeRtk(uxPluginBin);
        const seedSysRes = runCopySetup(emptyPathEnv);
        assert.equal(seedSysRes.status, 0, seedSysRes.stderr || seedSysRes.stdout);
        assert.equal(isManagedAgyShimFile(managedRtkShim), true);
        fs.unlinkSync(pluginLocalRtk);

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
          "Stale/dangling managed rtk shim must be removed when transitioning to an external system rtk on PATH (UX-ACS-R2-001)"
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

      // UX-ACS-003: Unit checks for isDirOnPath and formatPathOnboardingLines across POSIX & Windows
      assert.equal(isDirOnPath(uxBinDir, `${uxBinDir}${path.delimiter}/usr/bin`), true);
      assert.equal(isDirOnPath(uxBinDir, `${uxBinDir}${path.sep}${path.delimiter}/usr/bin`), true);
      assert.equal(isDirOnPath(uxBinDir, "/usr/bin:/bin", "linux"), false);
      assert.equal(
        isDirOnPath("C:\\Users\\Dev\\.gemini\\antigravity\\bin", '"c:\\users\\dev\\.gemini\\antigravity\\bin\\";C:\\Windows', "win32"),
        true
      );
      const winPathLines = formatPathOnboardingLines("C:\\Users\\Dev\\.gemini\\antigravity\\bin", { platform: "win32" }).join("\n");
      assert.match(winPathLines, /\$env:Path \+=/);
      assert.match(winPathLines, /SetEnvironmentVariable/);
      assert.match(winPathLines, /npx --package=agy-context-saver agy-context status/);

      // UX-ACS-006: Cross-platform unit verification of Windows node.cmd wrapper parity & backup preservation
      const winNodeWrapText = formatWindowsNodeCmdWrapper("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\Dev\\.gemini\\config\\scripts\\execution-guard-hook.mjs");
      assert.match(winNodeWrapText, /chcp 65001 >nul/);
      assert.match(winNodeWrapText, /REM agy-context-saver-managed/);
      assert.match(winNodeWrapText, /execution-guard-hook\.mjs/);
      const fakeWinCfg = path.join(uxProfile, "win-node-parity");
      fs.mkdirSync(fakeWinCfg, { recursive: true });
      const origUserNodeCmd = "@echo off\r\nREM user-owned-node-cmd\r\n";
      fs.writeFileSync(path.join(fakeWinCfg, "node.cmd"), origUserNodeCmd, "utf-8");
      await installWindowsNodeCmdWrapper({
        geminiConfigDir: fakeWinCfg,
        destHook: path.join(fakeWinCfg, "scripts", "execution-guard-hook.mjs"),
        nodeExe: "C:\\Program Files\\nodejs\\node.exe"
      });
      assert.equal(fs.readFileSync(path.join(fakeWinCfg, "node.cmd.bak"), "utf-8"), origUserNodeCmd);
      assert.match(fs.readFileSync(path.join(fakeWinCfg, "node.cmd"), "utf-8"), /REM agy-context-saver-managed/);
    } finally {
      fs.rmSync(uxProfile, { recursive: true, force: true });
    }
    console.log("✓ Managed RTK shim, PATH onboarding, GIT_CONFIG_GLOBAL safety, Windows node.cmd parity, and status hints verified");
  }
} finally {
  try {
    fs.rmSync(testProfileDir, { recursive: true, force: true });
  } catch {}
}

console.log("\n=================================================");
console.log("ALL 2.0 LIFECYCLE & ROLLBACK TESTS PASSED!");
console.log("=================================================");
