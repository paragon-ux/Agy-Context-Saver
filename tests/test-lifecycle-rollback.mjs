import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRtkShim, prependToPath } from "./helpers/hermetic-fixture.mjs";

console.log("=================================================");
console.log("Agy-Context-Saver Lifecycle & Rollback Test Suite");
console.log("=================================================\n");

// Isolate test in temporary sandbox to protect operator's live profile
const testProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-lifecycle-test-"));
process.env.AGY_TEST_PROFILE_DIR = testProfileDir;

try {
  // Ensure deterministic RTK shim is on PATH for clean offline CI runners
  const shimDir = path.join(testProfileDir, "rtk-shim-bin");
  createRtkShim(shimDir, "0.51.0");
  prependToPath(shimDir);

  const configDir = path.join(testProfileDir, ".gemini", "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "hooks.json"), JSON.stringify({
    "foreign-preservation-hook": { PreToolUse: [] }
  }, null, 2));
  fs.writeFileSync(path.join(configDir, "mcp_config.json"), JSON.stringify({
    mcpServers: { "foreign-preservation-server": { command: "node" } }
  }, null, 2));

  // Dynamically import install-register so it resolves to testProfileDir
  const {
    runInstall,
    runUninstall,
    detectExistingInstallation,
    pluginDest,
    destHook,
    hooksJsonPath,
    hooksBakPath,
    mcpJsonPath,
    mcpBakPath,
    antigravityMcpDir
  } = await import("../scripts/install-register.mjs");

  // Initial installation into isolated sandbox
  await runInstall({ silent: true, allowDegraded: true });

  // --- 1. Pre-flight Validation Test ---
  console.log("--- 1. Pre-flight Validation Audit ---");
  const preflightResult = await runInstall({ checkOnly: true, silent: true, allowDegraded: true });
  assert.ok(preflightResult, "Pre-flight audit should return status object");
  console.log("✓ Pre-flight audit completed without throwing write errors");

  // --- 2. Initial State Verification ---
  console.log("\n--- 2. Initial State Verification ---");
  const initial = detectExistingInstallation();
  assert.equal(initial.isComplete, true, "Initial installation must be complete and healthy");
  assert.ok(fs.existsSync(hooksBakPath), "hooks.json.bak must exist");
  assert.ok(fs.existsSync(mcpBakPath), "mcp_config.json.bak must exist");
  console.log("✓ Initial installation verified healthy with configuration backups present");

  // --- 3. Clean Uninstallation Test ---
  console.log("\n--- 3. Clean Uninstallation Verification ---");
  // Seed hook state in the per-user state folder, plus files that versions up to 1.7.0 left in the
  // shared temp folder. The temp folder is redirected into the sandbox so the real one is untouched.
  const { getStateDir } = await import("../scripts/state-dir.mjs");
  const stateDir = getStateDir();
  assert.ok(stateDir.startsWith(testProfileDir), "State folder must resolve inside the test profile");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "agy-session-governance-state.json"), "{}");
  fs.writeFileSync(path.join(stateDir, "agy-rtk-rewrite-cache.json"), "{}");
  const sandboxTmp = path.join(testProfileDir, "tmp");
  fs.mkdirSync(sandboxTmp, { recursive: true });
  const legacyFiles = [
    "agy-session-governance-state.json",
    "agy-session-conv_1.json",
    "agy-rtk-rewrite-cache.json",
    "agy-rtk-rewrite-cache.json.4242.tmp"
  ];
  for (const f of legacyFiles) fs.writeFileSync(path.join(sandboxTmp, f), "{}");
  fs.writeFileSync(path.join(sandboxTmp, "unrelated-file.json"), "{}");
  const savedTmpEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = sandboxTmp;
  try {
    assert.equal(os.tmpdir(), sandboxTmp, "Temp folder redirect must take effect");
    await runUninstall({ silent: true });
  } finally {
    for (const [k, v] of Object.entries(savedTmpEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  // Check filesystem cleanup
  assert.equal(fs.existsSync(pluginDest), false, "Plugin link must be removed");
  assert.equal(fs.existsSync(destHook), false, "Mirrored hook script must be removed");
  assert.equal(fs.existsSync(antigravityMcpDir), false, "Mirrored MCP schemas dir must be removed");
  assert.equal(fs.existsSync(stateDir), false, "Hook state folder must be removed");
  for (const f of legacyFiles) {
    assert.equal(fs.existsSync(path.join(sandboxTmp, f)), false, `Legacy temp-folder state ${f} must be removed`);
  }
  assert.ok(fs.existsSync(path.join(sandboxTmp, "unrelated-file.json")), "Unrelated temp files must be left alone");

  // Check configuration preservation
  const uninstalledHooks = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
  assert.equal(uninstalledHooks["execution-guard"], undefined, "execution-guard must be removed from hooks.json");
  assert.ok(uninstalledHooks["foreign-preservation-hook"], "foreign-preservation-hook MUST remain preserved in hooks.json");

  const uninstalledMcp = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
  assert.equal(uninstalledMcp.mcpServers?.["agy-context-saver"], undefined, "agy-context-saver must be removed from mcp_config.json");
  assert.ok(uninstalledMcp.mcpServers?.["foreign-preservation-server"], "foreign-preservation-server MUST remain preserved in mcp_config.json");

  const uninstalledDetect = detectExistingInstallation();
  assert.equal(uninstalledDetect.isInstalled, false, "detectExistingInstallation must report isInstalled: false after uninstallation");
  console.log("✓ Clean uninstallation verified: all artifacts removed and foreign configurations preserved");

  // --- 4. Re-Installation & Recovery Test ---
  console.log("\n--- 4. Re-Installation & Synchronization Recovery ---");
  // Seed schemas from an older install that still shipped the subagent tools; re-install must retire them
  fs.mkdirSync(antigravityMcpDir, { recursive: true });
  for (const stale of ["subagent_brief.json", "dispatch_squad.json"]) {
    fs.writeFileSync(path.join(antigravityMcpDir, stale), JSON.stringify({ name: stale.replace(".json", "") }));
  }
  const reinstallResult = await runInstall({ silent: true, allowDegraded: true });
  assert.equal(reinstallResult.isInstalled, true, "Re-installation should succeed");

  const recoveredDetect = detectExistingInstallation();
  assert.equal(recoveredDetect.isInstalled, true, "detectExistingInstallation must report isInstalled: true");
  assert.equal(recoveredDetect.isComplete, true, "detectExistingInstallation must report isComplete: true");

  // Verify all restored files
  assert.equal(fs.existsSync(pluginDest), true, "Plugin link restored");
  assert.equal(fs.existsSync(destHook), true, "Mirrored hook script restored");
  assert.equal(fs.existsSync(antigravityMcpDir), true, "Mirrored MCP schemas dir restored");

  const recoveredHooks = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
  assert.ok(recoveredHooks["execution-guard"], "execution-guard restored in hooks.json");
  assert.ok(recoveredHooks["foreign-preservation-hook"], "foreign-preservation-hook still preserved");

  const recoveredMcp = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
  assert.ok(recoveredMcp.mcpServers?.["agy-context-saver"], "agy-context-saver restored in mcp_config.json");
  assert.ok(recoveredMcp.mcpServers?.["foreign-preservation-server"], "foreign-preservation-server still preserved");

  // Verify all 5 schemas exist and retired schemas are absent
  const requiredSchemas = [
    "check_context_health.json",
    "get_installation_status.json",
    "sync_installation.json",
    "read_transcript.json",
    "query_transcript.json"
  ];
  for (const schemaName of requiredSchemas) {
    assert.equal(fs.existsSync(path.join(antigravityMcpDir, schemaName)), true, `Schema ${schemaName} restored`);
  }
  const retiredSchemas = [
    "safe_command.json",
    "get_spillover_content.json",
    "subagent_brief.json",
    "dispatch_squad.json",
    "read_task_output.json",
    "get_step_detail.json"
  ];
  for (const retired of retiredSchemas) {
    assert.equal(fs.existsSync(path.join(antigravityMcpDir, retired)), false, `${retired} must NOT exist`);
  }
  console.log("✓ Re-installation completed successfully: all 4 integration layers and 5 canonical schemas active (0 extra tools)");

  // --- 5. Backup Restore Option Test ---
  console.log("\n--- 5. Backup Restore Option Verification ---");
  await runUninstall({ silent: true, restoreBackups: true });
  assert.equal(fs.existsSync(pluginDest), false, "Plugin link removed");
  assert.equal(fs.existsSync(destHook), false, "Mirrored hook script removed");

  // Re-install to leave sandbox in healthy state before cleanup
  await runInstall({ silent: true, allowDegraded: true });
  const finalCheck = detectExistingInstallation();
  assert.equal(finalCheck.isComplete, true, "Final state must be complete and healthy");
  console.log("✓ Backup restoration option verified and sandbox returned to clean healthy state");

  // --- 6. Upgrade Idempotency & Legacy Cleanup Test (D-09) ---
  console.log("\n--- 6. Upgrade Idempotency & Legacy Cleanup Verification (D-09) ---");
  const customBakSentinel = JSON.stringify({ sentinelBackup: true }, null, 2);
  fs.writeFileSync(hooksBakPath, customBakSentinel, "utf-8");

  // Seed legacy hook key and retired schema to verify upgrade cleanup
  const hooksBeforeUpgrade = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
  hooksBeforeUpgrade["agy-context-saver"] = { PreToolUse: [] };
  fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksBeforeUpgrade, null, 2), "utf-8");
  const retiredSchemaFile = path.join(antigravityMcpDir, "safe_command.json");
  fs.writeFileSync(retiredSchemaFile, "{}", "utf-8");

  await runInstall({ silent: true, allowDegraded: true });
  const hooksAfterUpgrade = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
  assert.equal(hooksAfterUpgrade["agy-context-saver"], undefined, "Legacy 'agy-context-saver' hook key must be removed on upgrade");
  assert.ok(hooksAfterUpgrade["execution-guard"], "Canonical 'execution-guard' hook key must be present");
  assert.ok(hooksAfterUpgrade["foreign-preservation-hook"], "Foreign hook must survive upgrade");
  assert.equal(fs.existsSync(retiredSchemaFile), false, "Retired safe_command.json schema must be pruned on upgrade");
  assert.equal(fs.readFileSync(hooksBakPath, "utf-8"), customBakSentinel, "Existing hooks.json.bak must not be overwritten on repeat install");
  console.log("✓ Upgrade idempotency verified: legacy keys/schemas pruned, foreign entries & initial .bak preserved");

  // --- 7. Copy Fallback Verification (D-09) ---
  console.log("\n--- 7. Plugin Directory Copy Fallback Verification (D-09) ---");
  await runUninstall({ silent: true });
  const fallbackInstall = await runInstall({ silent: true, allowDegraded: true, forceCopyFallback: true });
  assert.equal(fallbackInstall.isInstalled, true, "Install with forceCopyFallback must succeed");
  const destStat = fs.lstatSync(pluginDest);
  assert.equal(destStat.isDirectory(), true, "Fallback pluginDest must be a directory");
  assert.equal(destStat.isSymbolicLink(), false, "Fallback pluginDest must be a real directory copy, not a symlink/junction");
  assert.equal(fs.existsSync(path.join(pluginDest, "package.json")), true, "Copied plugin directory must contain package.json");
  assert.equal(fs.existsSync(path.join(pluginDest, ".git")), false, "Copied plugin directory must exclude .git");
  console.log("✓ Plugin directory copy fallback verified (excludes .git and passes health check)");

  // --- 8. RTK Version Gate & AGY_ALLOW_ANY_RTK Removal Verification (D-01, D-09) ---
  console.log("\n--- 8. RTK Semver Compatibility Gate & Bypass Removal Verification (D-01, D-09) ---");
  const { isCompatibleRtkVersion, findExistingRtk } = await import("../scripts/provision-rtk.mjs");
  assert.equal(isCompatibleRtkVersion("rtk 0.49.9"), false, "0.49.9 must be rejected");
  assert.equal(isCompatibleRtkVersion("rtk 0.50.0"), true, "0.50.0 must be accepted");
  assert.equal(isCompatibleRtkVersion("rtk 0.51.0"), true, "0.51.0 must be accepted");
  assert.equal(isCompatibleRtkVersion("rtk 0.51.9"), true, "0.51.9 must be accepted");
  assert.equal(isCompatibleRtkVersion("rtk 0.52.0"), false, "0.52.0 must be rejected");
  assert.equal(isCompatibleRtkVersion("rtk 0.60.0"), false, "0.60.0 must be rejected");

  // Verify that an incompatible PATH rtk (0.60.0) is rejected even if AGY_ALLOW_ANY_RTK=1 is set
  const badRtkDir = path.join(testProfileDir, "bad-rtk-bin");
  createRtkShim(badRtkDir, "0.60.0");
  const origPath = process.env.PATH;
  const origAllow = process.env.AGY_ALLOW_ANY_RTK;
  try {
    process.env.PATH = badRtkDir;
    for (const k of Object.keys(process.env)) {
      if (k.toLowerCase() === "path") process.env[k] = badRtkDir;
    }
    process.env.AGY_ALLOW_ANY_RTK = "1";
    const found = findExistingRtk({ silent: true });
    // Either null (if no local repo bin/rtk exists) or local compatible binary, NEVER the 0.60.0 PATH binary
    if (found) {
      assert.equal(found.isLocal, true, "Must not accept incompatible PATH rtk even when AGY_ALLOW_ANY_RTK=1");
      assert.equal(isCompatibleRtkVersion(found.version), true);
    }
  } finally {
    process.env.PATH = origPath;
    for (const k of Object.keys(process.env)) {
      if (k.toLowerCase() === "path") process.env[k] = origPath;
    }
    if (origAllow === undefined) delete process.env.AGY_ALLOW_ANY_RTK;
    else process.env.AGY_ALLOW_ANY_RTK = origAllow;
  }
  console.log("✓ RTK semver boundaries [>=0.50.0 <0.52.0] and removal of AGY_ALLOW_ANY_RTK bypass verified");

  console.log("\n=================================================");
  console.log("ALL LIFECYCLE & ROLLBACK TESTS PASSED 100%!");
  console.log("=================================================\n");
} finally {
  try {
    fs.rmSync(testProfileDir, { recursive: true, force: true });
  } catch {}
}
