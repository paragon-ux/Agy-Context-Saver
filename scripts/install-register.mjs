#!/usr/bin/env node

/**
 * Agy-Context-Saver Registration & Installation Engine (v2.0.3)
 * Zero-delay cross-platform installer with CLI-first shim provisioning,
 * unified hook registration, and legacy MCP retirement/sweep.
 *
 * Capabilities:
 * - Detects native plugin link, hook registration (agy-context-saver), CLI shims, RTK (>= 1.1.0), and MCP cleanup
 * - Re-verifies and updates without redundant disk churn
 * - Retires legacy MCP registration in mcp_config.json and sweeps agy-context-saver* schema dirs (ACS-HOOK-11)
 * - Supports silent mode and CLI flags: --check, uninstall, status, --restore-backups, --allow-degraded
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRtkInstalled, findExistingRtk } from "./provision-rtk.mjs";
import { getStateDir, removeLegacyTmpState } from "./state-dir.mjs";
import { formatTranscriptAccessStatus } from "../lib/transcript-core.mjs";

const fsPromises = fs.promises;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version || "2.0.3";
  } catch {
    return "2.0.3";
  }
})();

export function resolveProfilePaths() {
  const homeDir = process.env.AGY_TEST_PROFILE_DIR || os.homedir();
  const geminiConfigDir = path.join(homeDir, ".gemini", "config");
  const pluginsDir = path.join(geminiConfigDir, "plugins");
  const pluginDest = path.join(pluginsDir, "agy-context-saver");
  const scriptsDir = path.join(geminiConfigDir, "scripts");
  const hooksJsonPath = path.join(geminiConfigDir, "hooks.json");
  const hooksBakPath = path.join(geminiConfigDir, "hooks.json.bak");
  const configJsonPath = path.join(geminiConfigDir, "config.json");
  const mcpJsonPath = path.join(geminiConfigDir, "mcp_config.json");
  const mcpBakPath = path.join(geminiConfigDir, "mcp_config.json.agy-context-saver.bak");
  const legacyMcpBakPath = path.join(geminiConfigDir, "mcp_config.json.bak");
  const antigravityMcpRootDir = path.join(homeDir, ".gemini", "antigravity", "mcp");
  const antigravityMcpDir = path.join(antigravityMcpRootDir, "agy-context-saver");
  const antigravityBinDir = path.join(homeDir, ".gemini", "antigravity", "bin");
  const destHook = path.join(scriptsDir, "execution-guard-hook.mjs");
  const destHookNormalized = destHook.replace(/\\/g, "/");
  return {
    homeDir,
    geminiConfigDir,
    pluginsDir,
    pluginDest,
    scriptsDir,
    hooksJsonPath,
    hooksBakPath,
    configJsonPath,
    mcpJsonPath,
    mcpBakPath,
    legacyMcpBakPath,
    antigravityMcpRootDir,
    antigravityMcpDir,
    antigravityBinDir,
    destHook,
    destHookNormalized
  };
}

const sourceHook = path.join(repoRoot, "scripts", "execution-guard-hook.mjs");
const repoHooksJsonPath = path.join(repoRoot, "hooks.json");

const HOOK_KEY = "agy-context-saver";
const LEGACY_HOOK_KEY = "execution-guard";
const CLI_SHIM_NAMES = ["agy-context", "agy-context-saver"];
const DEFAULT_HOOK_MATCHER =
  "manage_task|schedule|run_command|view_file|read_file|read_many_files|grep_search|find_by_name|list_dir|replace_file_content|write_file|write_to_file|edit_file";

function getExpectedHookMatcher() {
  try {
    const cfg = JSON.parse(fs.readFileSync(repoHooksJsonPath, "utf-8"));
    const matcher = cfg?.[HOOK_KEY]?.PreToolUse?.[0]?.matcher;
    if (typeof matcher === "string" && matcher.trim()) return matcher;
  } catch {}
  return DEFAULT_HOOK_MATCHER;
}

function isLegacyAgyMcpKey(key) {
  return key === "agy-context-saver" || key.startsWith("agy-context-saver");
}

function isExecutableFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  if (os.platform() === "win32") return true;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function detectCliShims() {
  const { antigravityBinDir } = resolveProfilePaths();
  const isWin = os.platform() === "win32";
  const expectedFiles = isWin
    ? CLI_SHIM_NAMES.map((name) => `${name}.cmd`)
    : CLI_SHIM_NAMES;
  const present = expectedFiles.filter((name) => isExecutableFile(path.join(antigravityBinDir, name)));
  return {
    exists: present.length === expectedFiles.length,
    dir: antigravityBinDir,
    shims: present
  };
}

function findLegacyMcpArtifacts() {
  const { mcpJsonPath, antigravityMcpRootDir } = resolveProfilePaths();
  const legacyMcpKeys = [];
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      if (cfg && typeof cfg.mcpServers === "object" && cfg.mcpServers !== null) {
        for (const key of Object.keys(cfg.mcpServers)) {
          if (isLegacyAgyMcpKey(key)) {
            legacyMcpKeys.push(key);
          }
        }
      }
    } catch {}
  }

  const legacySchemaDirs = [];
  if (fs.existsSync(antigravityMcpRootDir)) {
    try {
      for (const entry of fs.readdirSync(antigravityMcpRootDir, { withFileTypes: true })) {
        if (entry.name.startsWith("agy-context-saver")) {
          legacySchemaDirs.push(path.join(antigravityMcpRootDir, entry.name));
        }
      }
    } catch {}
  }

  const duplicateCount = legacyMcpKeys.length + legacySchemaDirs.length;
  return {
    clean: duplicateCount === 0,
    duplicateCount,
    legacyMcpKeys,
    legacySchemaDirs
  };
}

/**
 * Write file only if content has changed, eliminating disk churn.
 */
export async function safeWriteFileIfChanged(targetPath, newContent) {
  try {
    if (fs.existsSync(targetPath)) {
      const existing = await fsPromises.readFile(targetPath, "utf-8");
      if (existing === newContent) {
        return false;
      }
    }
  } catch {}
  await fsPromises.writeFile(targetPath, newContent, "utf-8");
  return true;
}

/**
 * Copy file only if content differs.
 */
export async function safeCopyFileIfChanged(sourcePath, targetPath) {
  try {
    if (fs.existsSync(targetPath)) {
      const [srcBuf, destBuf] = await Promise.all([
        fsPromises.readFile(sourcePath),
        fsPromises.readFile(targetPath)
      ]);
      if (srcBuf.equals(destBuf)) {
        return false;
      }
    }
  } catch {}
  await fsPromises.copyFile(sourcePath, targetPath);
  return true;
}

/**
 * Detects whether Agy-Context-Saver is already installed across all Antigravity 2.0 integration points.
 */
export function detectExistingInstallation(options = {}) {
  const {
    pluginDest,
    hooksJsonPath,
    destHook,
    destHookNormalized
  } = resolveProfilePaths();
  const pluginExists = fs.existsSync(pluginDest);
  let pluginLst = null;
  try {
    pluginLst = fs.lstatSync(pluginDest);
  } catch {}
  const pluginIsSymlink = Boolean(pluginLst && pluginLst.isSymbolicLink());
  const pluginBrokenSymlink = Boolean(pluginLst && pluginIsSymlink && !pluginExists);
  let pluginTarget = null;
  let pluginPointsElsewhere = false;
  let pluginInstalledVersion = null;
  const isLocalCheckout =
    fs.existsSync(path.join(repoRoot, ".git")) &&
    !repoRoot.includes("_npx") &&
    !repoRoot.includes("npm-cache") &&
    !repoRoot.includes("node_modules");

  if (pluginBrokenSymlink) {
    try {
      pluginTarget = fs.readlinkSync(pluginDest);
    } catch {
      pluginTarget = "broken symlink";
    }
    pluginPointsElsewhere = true;
  } else if (pluginExists) {
    if (pluginIsSymlink) {
      try {
        pluginTarget = fs.readlinkSync(pluginDest);
      } catch {
        pluginTarget = "symlink";
      }
      if (isLocalCheckout) {
        try {
          const destReal = fs.realpathSync(pluginDest);
          const repoReal = fs.realpathSync(repoRoot);
          pluginPointsElsewhere =
            os.platform() === "win32" || os.platform() === "darwin"
              ? destReal.toLowerCase() !== repoReal.toLowerCase()
              : destReal !== repoReal;
        } catch {
          pluginPointsElsewhere = true;
        }
      }
    } else {
      pluginTarget = "direct folder or junction";
    }
    try {
      const installedPkg = JSON.parse(fs.readFileSync(path.join(pluginDest, "package.json"), "utf8"));
      if (typeof installedPkg?.version === "string" && installedPkg.version.trim()) {
        pluginInstalledVersion = installedPkg.version.trim();
      }
    } catch {}
  }
  const pluginVersionMismatch = Boolean(pluginInstalledVersion && pluginInstalledVersion !== PACKAGE_VERSION);

  let pluginHookRegistered = false;
  let pluginHookCommand = null;
  const pluginHooksPath = path.join(pluginDest, "hooks.json");
  if (fs.existsSync(pluginHooksPath)) {
    try {
      const pCfg = JSON.parse(fs.readFileSync(pluginHooksPath, "utf-8"));
      const h = pCfg?.[HOOK_KEY];
      if (h) {
        pluginHookCommand = h.PreToolUse?.[0]?.hooks?.[0]?.command ?? null;
        pluginHookRegistered = Boolean(pluginHookCommand) && !String(pluginHookCommand).includes("ANTIGRAVITY_PLUGIN_ROOT");
      }
    } catch {}
  }

  let legacyHookPresent = false;
  let globalHookRegistered = false;
  let globalHookCommand = null;
  const expectedMatcher = getExpectedHookMatcher();
  if (fs.existsSync(hooksJsonPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
      legacyHookPresent = Boolean(cfg?.[LEGACY_HOOK_KEY]);
      const gh = cfg?.[HOOK_KEY];
      if (gh) {
        globalHookCommand = gh.PreToolUse?.[0]?.hooks?.[0]?.command ?? null;
        const globalMatcher = gh.PreToolUse?.[0]?.matcher ?? "";
        globalHookRegistered =
          Boolean(globalHookCommand) &&
          String(globalHookCommand).replace(/\\/g, "/").includes(destHookNormalized) &&
          globalMatcher === expectedMatcher;
      }
    } catch {}
  }

  const pluginHookScript = path.join(pluginDest, "scripts", "execution-guard-hook.mjs");
  const scriptExists = fs.existsSync(pluginHookScript);
  const mirroredHookExists = fs.existsSync(destHook);
  let mirroredHookStale = false;
  if (mirroredHookExists && fs.existsSync(sourceHook)) {
    try {
      mirroredHookStale = !fs.readFileSync(sourceHook).equals(fs.readFileSync(destHook));
    } catch {}
  }
  const cliShim = detectCliShims();
  const mcp = findLegacyMcpArtifacts();
  const rtkInfo = findExistingRtk({ silent: Boolean(options.silent) });
  const hookRegistered = pluginHookRegistered && globalHookRegistered && mirroredHookExists && !mirroredHookStale;

  const isInstalled =
    pluginExists ||
    Boolean(pluginLst) ||
    pluginHookRegistered ||
    globalHookRegistered ||
    legacyHookPresent ||
    mirroredHookExists ||
    cliShim.exists ||
    mcp.legacyMcpKeys.length > 0 ||
    mcp.legacySchemaDirs.length > 0;

  const isComplete =
    pluginExists &&
    !pluginPointsElsewhere &&
    !pluginVersionMismatch &&
    hookRegistered &&
    !mirroredHookStale &&
    scriptExists &&
    !legacyHookPresent &&
    cliShim.exists &&
    Boolean(rtkInfo) &&
    mcp.clean;

  return {
    isInstalled,
    isComplete,
    details: {
      plugin: {
        exists: pluginExists,
        target: pluginTarget,
        isSymlink: pluginIsSymlink,
        brokenSymlink: pluginBrokenSymlink,
        isCopyFallback: pluginExists && !pluginIsSymlink,
        pointsElsewhere: pluginPointsElsewhere,
        version: pluginInstalledVersion,
        versionMismatch: pluginVersionMismatch
      },
      hook: {
        key: HOOK_KEY,
        registered: hookRegistered,
        pluginHookRegistered,
        globalHookRegistered,
        mirroredHookExists,
        mirroredHookStale,
        legacyHookPresent,
        command: globalHookCommand || pluginHookCommand,
        scriptExists
      },
      cliShim,
      mcp,
      rtk: rtkInfo,
      transcriptAccess: formatTranscriptAccessStatus()
    }
  };
}

export function parseAndValidateJsonConfig(filePath, configName) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf-8");
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Configuration error: ${filePath} contains invalid JSON (${err.message}). Installation aborted to prevent data loss. Original file is unchanged.`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Configuration error: ${filePath} must contain a JSON object, but found ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}. Installation aborted to prevent data loss. Original file is unchanged.`
    );
  }
  if (configName === "mcp" && parsed.mcpServers !== undefined) {
    if (typeof parsed.mcpServers !== "object" || parsed.mcpServers === null || Array.isArray(parsed.mcpServers)) {
      throw new Error(
        `Configuration error: ${filePath} property "mcpServers" must be a JSON object. Installation aborted to prevent data loss. Original file is unchanged.`
      );
    }
  }
  return parsed;
}

async function stripLegacyMcpRegistrations(parsedMcp, { log, warn }) {
  const { mcpJsonPath, mcpBakPath } = resolveProfilePaths();
  if (!fs.existsSync(mcpJsonPath) || !parsedMcp?.mcpServers || typeof parsedMcp.mcpServers !== "object") {
    return;
  }

  const keysToStrip = Object.keys(parsedMcp.mcpServers).filter(isLegacyAgyMcpKey);
  if (keysToStrip.length === 0) {
    return;
  }

  if (!fs.existsSync(mcpBakPath)) {
    try {
      await fsPromises.copyFile(mcpJsonPath, mcpBakPath);
      log(`[OK] Created configuration backup: ${mcpBakPath}`);
    } catch (err) {
      warn(`[WARN] Could not create backup of ${mcpJsonPath}: ${err.message}`);
    }
  }

  const nextMcpConfig = {
    ...parsedMcp,
    mcpServers: { ...parsedMcp.mcpServers }
  };
  for (const key of keysToStrip) {
    delete nextMcpConfig.mcpServers[key];
  }

  await safeWriteFileIfChanged(mcpJsonPath, JSON.stringify(nextMcpConfig, null, 2));
  log(`[OK] Retired legacy MCP registration(s) (${keysToStrip.join(", ")}) from: ${mcpJsonPath}`);
}

async function sweepLegacyMcpSchemas({ log, warn }) {
  const { antigravityMcpRootDir } = resolveProfilePaths();
  if (!fs.existsSync(antigravityMcpRootDir)) {
    return;
  }
  let entries = [];
  try {
    entries = await fsPromises.readdir(antigravityMcpRootDir, { withFileTypes: true });
  } catch (err) {
    warn(`[WARN] Could not inspect ${antigravityMcpRootDir}: ${err.message}`);
    return;
  }

  for (const entry of entries) {
    if (!entry.name.startsWith("agy-context-saver")) continue;
    const targetPath = path.join(antigravityMcpRootDir, entry.name);
    try {
      await fsPromises.rm(targetPath, { recursive: true, force: true });
      log(`[OK] Swept legacy MCP schema directory: ${targetPath}`);
    } catch (err) {
      warn(`[WARN] Could not remove legacy MCP schema directory ${targetPath}: ${err.message}`);
    }
  }
}

export function formatWindowsCmdShim(targetCliPath) {
  return [
    "@echo off",
    "chcp 65001 >nul",
    "setlocal",
    "where node >nul 2>nul",
    "if errorlevel 1 goto :fallback",
    `node "${targetCliPath}" %*`,
    "exit /b %errorlevel%",
    ":fallback",
    `"${process.execPath}" "${targetCliPath}" %*`,
    "exit /b %errorlevel%",
    ""
  ].join("\r\n");
}

async function installCliShims({ log }) {
  const { pluginDest, antigravityBinDir } = resolveProfilePaths();
  const sourceCli = path.join(repoRoot, "bin", "agy-context.mjs");
  const pluginCli = path.join(pluginDest, "bin", "agy-context.mjs");

  for (const cliPath of [sourceCli, pluginCli]) {
    if (fs.existsSync(cliPath)) {
      try {
        fs.chmodSync(cliPath, 0o755);
      } catch {}
    }
  }

  const targetCli = fs.existsSync(pluginCli) ? pluginCli : sourceCli;
  const targetCliNormalized = targetCli.replace(/\\/g, "/").replace(/(["\\$`])/g, "\\$1");
  const execPathNormalized = process.execPath.replace(/\\/g, "/").replace(/(["\\$`])/g, "\\$1");

  await fsPromises.mkdir(antigravityBinDir, { recursive: true });

  const posixShimBody = [
    "#!/bin/sh",
    "set -eu",
    "if command -v node >/dev/null 2>&1; then",
    `  exec node "${targetCliNormalized}" "$@"`,
    "fi",
    `exec "${execPathNormalized}" "${targetCliNormalized}" "$@"`,
    ""
  ].join("\n");

  const winShimBody = formatWindowsCmdShim(targetCli);

  let changed = false;
  for (const name of CLI_SHIM_NAMES) {
    const posixShimPath = path.join(antigravityBinDir, name);
    if (await safeWriteFileIfChanged(posixShimPath, posixShimBody)) {
      changed = true;
    }
    try {
      fs.chmodSync(posixShimPath, 0o755);
    } catch {}

    if (os.platform() === "win32") {
      const winShimPath = path.join(antigravityBinDir, `${name}.cmd`);
      if (await safeWriteFileIfChanged(winShimPath, winShimBody)) {
        changed = true;
      }
    }
  }

  log(`[OK] CLI shims installed in: ${antigravityBinDir}${changed ? "" : " (up-to-date)"}`);
}

export async function runInstall(options = {}) {
  const {
    geminiConfigDir,
    pluginsDir,
    pluginDest,
    scriptsDir,
    hooksJsonPath,
    hooksBakPath,
    configJsonPath,
    mcpJsonPath,
    antigravityBinDir,
    destHook,
    destHookNormalized
  } = resolveProfilePaths();
  const log = options.silent ? () => {} : console.log;
  const warn = options.silent ? () => {} : console.warn;

  const startTime = performance.now();

  // Pre-flight Fail-Closed Validation: Verify existing configs BEFORE ANY DISK MUTATION OR CHECK RETURN
  const validatedHooks = parseAndValidateJsonConfig(hooksJsonPath, "hooks");
  const validatedMcp = parseAndValidateJsonConfig(mcpJsonPath, "mcp");
  const validatedConfig = parseAndValidateJsonConfig(configJsonPath, "config");

  const existing = detectExistingInstallation({ silent: Boolean(options.silent) });

  // If checkOnly is requested, execute strictly read-only inspection (zero disk writes, zero network calls)
  if (options.checkOnly) {
    if (existing.isInstalled) {
      log("Existing installation detected:");
      if (existing.details.plugin.exists) {
        log(`   [OK] Native Plugin Link: ${pluginDest}`);
      }
      if (existing.details.hook.registered) {
        log(`   [OK] Governor Hook (${HOOK_KEY}): Active via plugin + global hooks.json`);
      } else if (existing.details.hook.pluginHookRegistered) {
        log(
          existing.details.hook.mirroredHookStale
            ? `   [WARN] Global hooks.json mirrored hook copy is stale (run setup to synchronize)`
            : `   [WARN] Global hooks.json entry missing/stale for /swarm workers (run setup to synchronize)`
        );
      }
      if (existing.details.hook.legacyHookPresent) {
        log(`   [WARN] Global hooks.json has legacy 'execution-guard' entry (run setup to clean up)`);
      }
      if (existing.details.cliShim.exists) {
        log(`   [OK] CLI Shims (agy-context): Installed in ${antigravityBinDir}`);
      }
      if (existing.details.rtk) {
        log(`   [OK] RTK Command Optimizer: ${existing.details.rtk.version} (${existing.details.rtk.path})`);
      }
      if (existing.details.mcp.clean) {
        log("   [OK] MCP Cleanup: 0 duplicate MCP configs/schemas");
      } else {
        log(`   [WARN] MCP Cleanup: ${existing.details.mcp.duplicateCount} legacy MCP config/schema entries found`);
      }
      log("\n[OK] Pre-flight check complete. Zero changes written.");
    } else {
      log("Pre-flight check: No active installation detected (clean profile).");
      log("\n[OK] Pre-flight check complete. Zero changes written.");
    }
    return existing;
  }

  if (existing.isInstalled) {
    log("Existing installation detected:");
    if (existing.details.plugin.exists) {
      log(`   [OK] Native Plugin Link: ${pluginDest}`);
    }
    if (existing.details.hook.registered) {
      log(`   [OK] Governor Hook (${HOOK_KEY}): Active via plugin + global hooks.json`);
    }
    if (existing.details.cliShim.exists) {
      log(`   [OK] CLI Shims (agy-context): Installed in ${antigravityBinDir}`);
    }
    log(`\nRe-verifying and synchronizing to v${PACKAGE_VERSION}...`);
  } else {
    log(`Fresh installation of Agy-Context-Saver v${PACKAGE_VERSION}...`);
  }

  // 0. Pre-flight Validation: Verify configuration directory write access
  try {
    await fsPromises.mkdir(geminiConfigDir, { recursive: true });
    const probeFile = path.join(geminiConfigDir, `.preflight-${process.pid}.tmp`);
    await fsPromises.writeFile(probeFile, "ok", "utf-8");
    await fsPromises.unlink(probeFile);
  } catch (err) {
    throw new Error(
      `Pre-flight check failed: cannot write to Antigravity configuration directory (${geminiConfigDir}): ${err.message}`
    );
  }

  // 0a. Ensure RTK (>= 1.1.0) is provisioned and available
  try {
    const rtkResult = await ensureRtkInstalled({ silent: options.silent, existingRtk: existing.details.rtk });
    log(`[OK] RTK Command Optimizer verified: ${rtkResult.version} (${rtkResult.path})`);
  } catch (err) {
    if (options.allowDegraded) {
      warn(`[WARN] RTK provisioning check encountered an issue: ${err.message}. Continuing in degraded mode.`);
    } else {
      throw new Error(
        `RTK provisioning failed: ${err.message}. To install without RTK (degraded mode), re-run with --allow-degraded.`
      );
    }
  }

  // 1. Native Plugin Junction / Symlink or Permanent Copy
  await fsPromises.mkdir(pluginsDir, { recursive: true });
  const isGitRepo = fs.existsSync(path.join(repoRoot, ".git"));
  const isTempOrNpx =
    !isGitRepo || repoRoot.includes("_npx") || repoRoot.includes("npm-cache") || repoRoot.includes("node_modules");
  const copyFilter = (src) => {
    const rel = path.relative(repoRoot, src);
    if (!rel) return true;
    const topSegment = rel.split(path.sep)[0];
    return ![".git", "node_modules", ".venv", "scratch", "site"].includes(topSegment);
  };

  let pluginLst = null;
  try {
    pluginLst = fs.lstatSync(pluginDest);
  } catch {}
  const pluginExists = fs.existsSync(pluginDest);
  let pluginPointsElsewhere = false;
  if (pluginLst && pluginExists && pluginLst.isSymbolicLink()) {
    try {
      const destReal = fs.realpathSync(pluginDest);
      const repoReal = fs.realpathSync(repoRoot);
      pluginPointsElsewhere =
        os.platform() === "win32" || os.platform() === "darwin"
          ? destReal.toLowerCase() !== repoReal.toLowerCase()
          : destReal !== repoReal;
    } catch {
      pluginPointsElsewhere = true;
    }
  }

  if (
    pluginLst &&
    (!pluginExists || isTempOrNpx || options.forceCopyFallback || !pluginLst.isSymbolicLink() || pluginPointsElsewhere)
  ) {
    if (pluginLst.isSymbolicLink()) {
      await fsPromises.unlink(pluginDest);
    } else {
      await fsPromises.rm(pluginDest, { recursive: true, force: true });
    }
    pluginLst = null;
  }

  if (!pluginLst) {
    if (isTempOrNpx || options.forceCopyFallback) {
      await fsPromises.cp(repoRoot, pluginDest, { recursive: true, filter: copyFilter });
      log(`[OK] Native Antigravity Plugin installed to: ${pluginDest}`);
    } else {
      try {
        const isWin = os.platform() === "win32";
        fs.symlinkSync(repoRoot, pluginDest, isWin ? "junction" : "dir");
        log(`[OK] Native Antigravity Plugin linked: ${pluginDest} -> ${repoRoot}`);
      } catch {
        await fsPromises.cp(repoRoot, pluginDest, { recursive: true, filter: copyFilter });
        log(`[OK] Native Antigravity Plugin copied to: ${pluginDest}`);
      }
    }
  } else {
    log(`[OK] Native Antigravity Plugin verified: ${pluginDest}`);
  }

  // 2. Dual-surface hook governance (plugin hooks.json + global hooks.json for /swarm workers):
  //    Mirror execution-guard-hook.mjs to ~/.gemini/config/scripts/execution-guard-hook.mjs and register
  //    "agy-context-saver" in ~/.gemini/config/hooks.json so native /swarm workers (which load global hooks.json
  //    rather than plugin hooks.json) execute PreToolUse reliably alongside coordinator idempotency deduplication.
  await fsPromises.mkdir(scriptsDir, { recursive: true });
  const hookUpdated = await safeCopyFileIfChanged(sourceHook, destHook);
  log(`[OK] Mirrored hook script ${hookUpdated ? "updated" : "verified"}: ${destHook}`);

  const hookMatcher = getExpectedHookMatcher();
  const nextHooks = validatedHooks ? { ...validatedHooks } : {};
  const hadLegacyHook = Boolean(nextHooks[LEGACY_HOOK_KEY]);
  delete nextHooks[LEGACY_HOOK_KEY];
  nextHooks[HOOK_KEY] = {
    PreToolUse: [
      {
        matcher: hookMatcher,
        hooks: [
          {
            type: "command",
            command: `node "${destHookNormalized}"`,
            timeout: 10
          }
        ]
      }
    ]
  };
  const nextHooksRaw = JSON.stringify(nextHooks, null, 2);
  let hooksNeedsBackup = false;
  if (fs.existsSync(hooksJsonPath) && !fs.existsSync(hooksBakPath)) {
    try {
      const currentRaw = fs.readFileSync(hooksJsonPath, "utf-8");
      hooksNeedsBackup = currentRaw !== nextHooksRaw && (hadLegacyHook || Object.keys(validatedHooks || {}).length > 0);
    } catch {}
  }
  if (hooksNeedsBackup) {
    try {
      await fsPromises.copyFile(hooksJsonPath, hooksBakPath);
      log(`[OK] Created configuration backup: ${hooksBakPath}`);
    } catch (err) {
      warn(`[WARN] Could not create backup of ${hooksJsonPath}: ${err.message}`);
    }
  }
  const hooksChanged = await safeWriteFileIfChanged(hooksJsonPath, nextHooksRaw);
  log(`[OK] Lifecycle hook (${HOOK_KEY}) ${hooksChanged ? "registered" : "verified"} in: ${hooksJsonPath} + plugin hooks.json`);

  // 3. Ensure ~/.gemini/config/config.json enables plugin if present
  if (validatedConfig && typeof validatedConfig === "object") {
    if (
      validatedConfig.plugins !== undefined &&
      (!validatedConfig.plugins || typeof validatedConfig.plugins !== "object" || Array.isArray(validatedConfig.plugins))
    ) {
      throw new Error(
        `Configuration error: ${configJsonPath} property "plugins" must be a JSON object. Installation aborted to prevent data loss. Original file is unchanged.`
      );
    }
    const prevPluginEntry = validatedConfig.plugins?.[HOOK_KEY];
    if (!prevPluginEntry || typeof prevPluginEntry !== "object" || Array.isArray(prevPluginEntry) || prevPluginEntry.enabled !== true) {
      const nextConfig = {
        ...validatedConfig,
        plugins: {
          ...(validatedConfig.plugins && typeof validatedConfig.plugins === "object" && !Array.isArray(validatedConfig.plugins)
            ? validatedConfig.plugins
            : {}),
          [HOOK_KEY]: {
            ...(prevPluginEntry && typeof prevPluginEntry === "object" && !Array.isArray(prevPluginEntry) ? prevPluginEntry : {}),
            enabled: true
          }
        }
      };
      await safeWriteFileIfChanged(configJsonPath, JSON.stringify(nextConfig, null, 2));
      log(`[OK] Enabled plugin '${HOOK_KEY}' in: ${configJsonPath}`);
    }
  }

  // 4. Retire default MCP registration & sweep all agy-context-saver* schema directories (ACS-HOOK-11)
  await stripLegacyMcpRegistrations(validatedMcp, { log, warn });
  await sweepLegacyMcpSchemas({ log, warn });

  // 5. Install executable CLI shims (agy-context, agy-context-saver) into ~/.gemini/antigravity/bin/
  await installCliShims({ log });

  // 6. Clean up legacy temp-folder state from versions <= 1.7.0
  for (const legacy of removeLegacyTmpState()) {
    log(`[OK] Removed legacy temp-folder state: ${legacy}`);
  }

  const elapsed = (performance.now() - startTime).toFixed(1);
  const statusVerb = existing.isInstalled ? "synchronized & up-to-date" : "completed";
  log(`\nInstallation ${statusVerb} in ${elapsed}ms!\n`);
  const postInstall = detectExistingInstallation({ silent: Boolean(options.silent) });
  return { ...postInstall, isInstalled: true, elapsedMs: elapsed };
}

export async function runUninstall(options = {}) {
  const {
    geminiConfigDir,
    pluginDest,
    destHook,
    hooksJsonPath,
    configJsonPath,
    mcpJsonPath,
    antigravityBinDir
  } = resolveProfilePaths();
  const log = options.silent ? () => {} : console.log;
  const warn = options.silent ? () => {} : console.warn;
  log("Uninstalling Agy-Context-Saver...");

  // 0. Fail-closed Pre-Validation: verify JSON config files BEFORE removing plugin/hook artifacts (S2-SCRIPT-006)
  const validatedHooks = parseAndValidateJsonConfig(hooksJsonPath, "hooks");
  const validatedMcp = parseAndValidateJsonConfig(mcpJsonPath, "mcp");
  const validatedConfig = parseAndValidateJsonConfig(configJsonPath, "config");

  // 1. Remove plugin link (including broken symlinks)
  let pluginStat = null;
  try {
    pluginStat = fs.lstatSync(pluginDest);
  } catch {}
  if (pluginStat) {
    try {
      if (pluginStat.isSymbolicLink()) {
        await fsPromises.unlink(pluginDest);
      } else {
        await fsPromises.rm(pluginDest, { recursive: true, force: true });
      }
      log(`[OK] Removed plugin link: ${pluginDest}`);
    } catch (err) {
      warn(`[WARN] Could not remove plugin link: ${err.message}`);
    }
  }

  // 2. Remove mirrored hook script (including dangling symlinks via lstatSync, S2-SCRIPT-011)
  let destHookStat = null;
  try {
    destHookStat = fs.lstatSync(destHook);
  } catch {}
  if (destHookStat) {
    try {
      if (destHookStat.isDirectory() && !destHookStat.isSymbolicLink()) {
        await fsPromises.rm(destHook, { recursive: true, force: true });
      } else {
        await fsPromises.unlink(destHook);
      }
      log(`[OK] Removed mirrored hook script: ${destHook}`);
    } catch (err) {
      warn(`[WARN] Could not remove mirrored hook script: ${err.message}`);
    }
  }

  // 3. Remove both current and legacy hook keys from hooks.json, and plugin toggle from config.json
  if (validatedHooks && typeof validatedHooks === "object") {
    const nextHooks = { ...validatedHooks };
    delete nextHooks[LEGACY_HOOK_KEY];
    delete nextHooks[HOOK_KEY];
    await safeWriteFileIfChanged(hooksJsonPath, JSON.stringify(nextHooks, null, 2));
    log(`[OK] Removed hook registration from: ${hooksJsonPath}`);
  }
  if (
    validatedConfig &&
    typeof validatedConfig === "object" &&
    validatedConfig.plugins &&
    typeof validatedConfig.plugins === "object" &&
    !Array.isArray(validatedConfig.plugins) &&
    HOOK_KEY in validatedConfig.plugins
  ) {
    const nextPlugins = { ...validatedConfig.plugins };
    delete nextPlugins[HOOK_KEY];
    const nextConfig = { ...validatedConfig, plugins: nextPlugins };
    await safeWriteFileIfChanged(configJsonPath, JSON.stringify(nextConfig, null, 2));
    log(`[OK] Removed '${HOOK_KEY}' plugin entry from: ${configJsonPath}`);
  }

  // 4. Strip any agy-context-saver* keys from mcp_config.json (preserving foreign servers, creating namespaced .bak if absent)
  if (validatedMcp) {
    await stripLegacyMcpRegistrations(validatedMcp, { log, warn });
  }

  // 5. Sweep ALL agy-context-saver* directories under ~/.gemini/antigravity/mcp/
  await sweepLegacyMcpSchemas({ log, warn });

  // 6. Remove CLI shims from ~/.gemini/antigravity/bin/ (including dangling symlinks via lstatSync, S2-SCRIPT-011)
  for (const name of CLI_SHIM_NAMES) {
    for (const candidate of [name, `${name}.cmd`]) {
      const shimPath = path.join(antigravityBinDir, candidate);
      let shimStat = null;
      try {
        shimStat = fs.lstatSync(shimPath);
      } catch {}
      if (shimStat) {
        try {
          if (shimStat.isDirectory() && !shimStat.isSymbolicLink()) {
            await fsPromises.rm(shimPath, { recursive: true, force: true });
          } else {
            await fsPromises.unlink(shimPath);
          }
          log(`[OK] Removed CLI shim: ${shimPath}`);
        } catch (err) {
          warn(`[WARN] Could not remove CLI shim ${shimPath}: ${err.message}`);
        }
      }
    }
  }

  // 6b. Remove managed Windows node.cmd wrapper (created by install.ps1) and restore backup if present
  const nodeCmdPath = path.join(geminiConfigDir, "node.cmd");
  const nodeCmdBakPath = path.join(geminiConfigDir, "node.cmd.bak");
  if (fs.existsSync(nodeCmdPath)) {
    try {
      const content = fs.readFileSync(nodeCmdPath, "utf-8");
      if (content.includes("agy-context-saver-managed")) {
        await fsPromises.unlink(nodeCmdPath);
        if (fs.existsSync(nodeCmdBakPath)) {
          await fsPromises.rename(nodeCmdBakPath, nodeCmdPath);
          log(`[OK] Restored previous node.cmd from backup: ${nodeCmdBakPath}`);
        } else {
          log(`[OK] Removed managed node.cmd wrapper: ${nodeCmdPath}`);
        }
      }
    } catch (err) {
      warn(`[WARN] Could not clean managed node.cmd: ${err.message}`);
    }
  }

  // 7. Remove hook state: the per-user state folder and anything older versions left in the temp folder
  const stateDir = getStateDir();
  if (fs.existsSync(stateDir)) {
    try {
      await fsPromises.rm(stateDir, { recursive: true, force: true });
      log(`[OK] Removed hook state folder: ${stateDir}`);
    } catch (err) {
      warn(`[WARN] Could not remove hook state folder: ${err.message}`);
    }
  }
  for (const legacy of removeLegacyTmpState()) {
    log(`[OK] Removed legacy temp-folder state: ${legacy}`);
  }

  // 8. Optional: Restore configuration files from backups if requested
  if (options.restoreBackups) {
    await runRestoreBackups(options);
  }

  log("\nUninstallation complete.\n");
}

export async function runRestoreBackups(options = {}) {
  const { hooksJsonPath, hooksBakPath, mcpJsonPath, mcpBakPath, legacyMcpBakPath } = resolveProfilePaths();
  const log = options.silent ? () => {} : console.log;
  const warn = options.silent ? () => {} : console.warn;
  let restoredCount = 0;

  if (fs.existsSync(hooksBakPath)) {
    try {
      await fsPromises.copyFile(hooksBakPath, hooksJsonPath);
      log(`[OK] Restored hooks.json from backup: ${hooksBakPath}`);
      restoredCount++;
    } catch (err) {
      warn(`[WARN] Could not restore hooks backup: ${err.message}`);
    }
  } else {
    log(`[INFO] No hooks.json backup found at ${hooksBakPath}`);
  }

  let mcpBackupToRestore = null;
  if (fs.existsSync(mcpBakPath)) {
    mcpBackupToRestore = mcpBakPath;
  } else if (fs.existsSync(legacyMcpBakPath)) {
    try {
      const legacyParsed = JSON.parse(fs.readFileSync(legacyMcpBakPath, "utf-8"));
      if (
        legacyParsed &&
        typeof legacyParsed === "object" &&
        legacyParsed.mcpServers &&
        typeof legacyParsed.mcpServers === "object" &&
        Object.keys(legacyParsed.mcpServers).some(isLegacyAgyMcpKey)
      ) {
        mcpBackupToRestore = legacyMcpBakPath;
      }
    } catch {}
  }

  if (mcpBackupToRestore) {
    try {
      await fsPromises.copyFile(mcpBackupToRestore, mcpJsonPath);
      log(`[OK] Restored mcp_config.json from backup: ${mcpBackupToRestore}`);
      restoredCount++;
    } catch (err) {
      warn(`[WARN] Could not restore mcp backup: ${err.message}`);
    }
  } else {
    log(`[INFO] No mcp_config.json backup found at ${mcpBakPath}`);
  }

  return restoredCount > 0;
}

export function runStatus(options = {}) {
  const { pluginDest, destHook, antigravityBinDir } = resolveProfilePaths();
  const log = options.silent ? () => {} : console.log;
  const existing = detectExistingInstallation({ silent: Boolean(options.silent) });
  const plug = existing.details.plugin;
  const pluginNote = plug.brokenSymlink
    ? `BROKEN SYMLINK (${pluginDest} -> ${plug.target || "missing"}; re-run agy-context setup)`
    : !plug.exists
      ? "NOT LINKED"
      : plug.pointsElsewhere
        ? `REDIRECTED (${pluginDest} -> ${plug.target}; re-run agy-context setup)`
        : plug.versionMismatch
          ? `STALE VERSION (${plug.version} != ${PACKAGE_VERSION} at ${pluginDest}; re-run agy-context setup)`
          : plug.isCopyFallback
            ? `ACTIVE COPY (${pluginDest})`
            : `ACTIVE (${pluginDest})`;
  log("Checking Agy-Context-Saver installation status...\n");
  log(`- Native Plugin Link: ${pluginNote}`);
  const hookStatusLabel = existing.details.hook.registered
    ? "ACTIVE (plugin + global hooks.json)"
    : existing.details.hook.mirroredHookStale
      ? `STALE MIRRORED HOOK (${destHook}; re-run agy-context setup)`
      : existing.details.hook.pluginHookRegistered
        ? "PARTIAL (plugin hooks.json only; global /swarm hook missing)"
        : "NOT REGISTERED";
  log(
    `- Execution Governor Hook (${HOOK_KEY}): ${hookStatusLabel}${existing.details.hook.legacyHookPresent ? " (legacy 'execution-guard' in global hooks.json)" : ""}`
  );
  log(
    `- CLI Shim (agy-context): ${existing.details.cliShim.exists ? "INSTALLED (" + antigravityBinDir + ")" : "MISSING"}`
  );
  log(
    `- RTK Command Optimizer (>= 1.1.0): ${existing.details.rtk ? "INSTALLED (" + existing.details.rtk.version + ")" : "MISSING"}`
  );
  log(
    `- MCP Cleanup: ${existing.details.mcp.clean ? "CLEAN (0 duplicate MCP configs/schemas)" : existing.details.mcp.duplicateCount + " legacy MCP config/schema entries present"}`
  );
  const ta = existing.details.transcriptAccess || formatTranscriptAccessStatus();
  log(
    `- Transcript Access Policy: ${ta.active ? `${ta.mode.toUpperCase()} (owner: ${ta.ownerId})` : "OPEN (default)"}`
  );

  log(
    `\nOverall Status: ${existing.isComplete ? "HEALTHY & ACTIVE" : existing.isInstalled ? "PARTIAL INSTALLATION" : "NOT INSTALLED"}\n`
  );
  return existing;
}

function printCliHelp() {
  console.log(`
Agy-Context-Saver Registration & Lifecycle Engine (v${PACKAGE_VERSION})

Usage:
  node scripts/install-register.mjs [command/option]

Commands & Options:
  --status, status [--json]    Check live integration status (plugin, hook, CLI shim, RTK >= 1.1.0, MCP cleanup)
  --check, -c                  Run read-only pre-flight validation check without writing changes
  --uninstall, uninstall       Remove governor hook, plugin link, CLI shims, and legacy MCP configs/schemas
  --restore-backups            Restore original configuration backup files (*.bak) (standalone or during uninstall)
  --allow-degraded             Allow installation to proceed even if RTK optimizer provisioning fails
  --help, -h, help             Show this help message
  (no arguments)               Synchronize and verify v${PACKAGE_VERSION} CLI-first installation
`);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  const tryRealpath = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const resolvedArg = tryRealpath(path.resolve(process.argv[1]));
  const resolvedSelf = tryRealpath(fileURLToPath(import.meta.url));
  if (resolvedArg === resolvedSelf) return true;
  if (os.platform() === "win32" || os.platform() === "darwin") {
    return resolvedArg.toLowerCase() === resolvedSelf.toLowerCase();
  }
  return false;
}

// Auto-run if executed directly as script
if (isDirectExecution()) {
  const args = process.argv.slice(2);
  const knownFlags = new Set(["--help", "-h", "--uninstall", "--status", "--json", "--check", "-c", "--restore-backups", "--allow-degraded"]);
  const knownPositionals = new Set(["help", "uninstall", "status", "restore-backups"]);
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!knownFlags.has(arg)) {
        console.error(`Error: Unknown option '${arg}'. Run 'node scripts/install-register.mjs --help' for usage.`);
        process.exit(1);
      }
    } else if (!knownPositionals.has(arg)) {
      console.error(`Error: Unknown argument '${arg}'. Run 'node scripts/install-register.mjs --help' for usage.`);
      process.exit(1);
    }
  }

  const isHelp = args.includes("--help") || args.includes("-h") || args.includes("help");
  const isUninstall = args.includes("--uninstall") || args.includes("uninstall");
  const isStatus = args.includes("--status") || args.includes("status");
  const isJson = args.includes("--json");
  const isCheck = args.includes("--check") || args.includes("-c");
  const isRestoreBackups = args.includes("--restore-backups") || args.includes("restore-backups");
  const allowDegraded = args.includes("--allow-degraded");

  if (isHelp) {
    if (isUninstall || isStatus || isJson || isCheck || isRestoreBackups || allowDegraded) {
      console.error("Error: Conflicting flags: --help cannot be combined with operational flags.");
      process.exit(1);
    }
    printCliHelp();
    process.exit(0);
  }

  // Reject conflicting read-only and mutating flags explicitly
  if ((isCheck || isStatus) && (isUninstall || isRestoreBackups)) {
    console.error(
      "Error: Read-only flags (--check, --status) cannot be combined with mutating flags (--uninstall, --restore-backups)."
    );
    process.exit(1);
  }
  if (isCheck && isStatus) {
    console.error("Error: Conflicting flags: specify either --check or --status, not both.");
    process.exit(1);
  }
  if (isJson && !isStatus) {
    console.error("Error: Flag '--json' is only supported with --status / status.");
    process.exit(1);
  }
  if (allowDegraded && (isUninstall || isStatus || isRestoreBackups)) {
    console.error("Error: Invalid flag: --allow-degraded is only supported with setup/install or --check.");
    process.exit(1);
  }

  try {
    if (isCheck) {
      await runInstall({ checkOnly: true, allowDegraded });
    } else if (isStatus) {
      const st = runStatus({ silent: isJson });
      if (isJson) {
        console.log(JSON.stringify(st, null, 2));
      }
      if (!st.isComplete) {
        process.exitCode = 1;
      }
    } else if (isUninstall) {
      await runUninstall({ restoreBackups: isRestoreBackups });
    } else if (isRestoreBackups) {
      await runRestoreBackups();
    } else {
      await runInstall({ allowDegraded });
    }
  } catch (err) {
    console.error(`Error: ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  }
}
