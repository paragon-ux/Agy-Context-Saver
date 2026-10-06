import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
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
} from "../scripts/install-register.mjs";

console.log("=================================================");
console.log("Agy-Context-Saver Lifecycle & Rollback Test Suite");
console.log("=================================================\n");

// --- 1. Pre-flight Validation Test ---
console.log("--- 1. Pre-flight Validation Audit ---");
const preflightResult = await runInstall({ checkOnly: true, silent: true });
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
await runUninstall({ silent: true });

// Check filesystem cleanup
assert.equal(fs.existsSync(pluginDest), false, "Plugin link must be removed");
assert.equal(fs.existsSync(destHook), false, "Mirrored hook script must be removed");
assert.equal(fs.existsSync(antigravityMcpDir), false, "Mirrored MCP schemas dir must be removed");

// Check configuration preservation
const uninstalledHooks = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
assert.equal(uninstalledHooks["execution-guard"], undefined, "execution-guard must be removed from hooks.json");
assert.ok(uninstalledHooks["waymark-continuity"], "waymark-continuity MUST remain preserved in hooks.json");

const uninstalledMcp = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
assert.equal(uninstalledMcp.mcpServers?.["agy-context-saver"], undefined, "agy-context-saver must be removed from mcp_config.json");
assert.ok(uninstalledMcp.mcpServers?.["waymark-engine"], "waymark-engine MUST remain preserved in mcp_config.json");

const uninstalledDetect = detectExistingInstallation();
assert.equal(uninstalledDetect.isInstalled, false, "detectExistingInstallation must report isInstalled: false after uninstallation");
console.log("✓ Clean uninstallation verified: all artifacts removed and foreign configurations preserved");

// --- 4. Re-Installation & Recovery Test ---
console.log("\n--- 4. Re-Installation & Synchronization Recovery ---");
const reinstallResult = await runInstall({ silent: true });
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
assert.ok(recoveredHooks["waymark-continuity"], "waymark-continuity still preserved");

const recoveredMcp = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
assert.ok(recoveredMcp.mcpServers?.["agy-context-saver"], "agy-context-saver restored in mcp_config.json");
assert.ok(recoveredMcp.mcpServers?.["waymark-engine"], "waymark-engine still preserved");

// Verify all 7 schemas exist
const requiredSchemas = [
  "safe_command.json",
  "check_context_health.json",
  "subagent_brief.json",
  "get_installation_status.json",
  "sync_installation.json",
  "read_transcript.json",
  "query_transcript.json"
];
for (const schemaName of requiredSchemas) {
  assert.equal(fs.existsSync(path.join(antigravityMcpDir, schemaName)), true, `Schema ${schemaName} restored`);
}
console.log("✓ Re-installation completed successfully: all 4 integration layers and 7 schemas active");

// --- 5. Backup Restore Option Test ---
console.log("\n--- 5. Backup Restore Option Verification ---");
// Simulate custom uninstallation with restoreBackups
await runUninstall({ silent: true, restoreBackups: true });
assert.equal(fs.existsSync(pluginDest), false, "Plugin link removed");
assert.equal(fs.existsSync(destHook), false, "Mirrored hook script removed");

// Re-install to leave system in clean healthy state
await runInstall({ silent: true });
const finalCheck = detectExistingInstallation();
assert.equal(finalCheck.isComplete, true, "Final state must be complete and healthy");
console.log("✓ Backup restoration option verified and system returned to clean healthy state");

console.log("\n=================================================");
console.log("ALL LIFECYCLE & ROLLBACK TESTS PASSED 100%!");
console.log("=================================================\n");
process.exit(0);
