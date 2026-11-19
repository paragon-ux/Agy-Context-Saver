#!/usr/bin/env node

/**
 * Agy-Context-Saver Registration & Installation Engine (v2.0.4)
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
import {
  ensureRtkInstalled,
  findExistingRtk,
  isDirectoryWritable,
  MANAGED_SHIM_MARKER,
  verifyLocalRtkBinary
} from "./provision-rtk.mjs";
import { getStateDir, removeLegacyTmpState } from "./state-dir.mjs";
import { formatTranscriptAccessStatus } from "../lib/transcript-core.mjs";

export const MIN_NODE_MAJOR = 22;

export function parseNodeMajorVersion(versionStr = process.versions.node) {
  const m = String(versionStr || "").trim().replace(/^v/i, "").match(/^(\d+)(?:\.\d+)?(?:\.\d+)?/);
  return m ? Number.parseInt(m[1], 10) : NaN;
}

export function assertSupportedNodeVersion(versionStr = process.versions.node) {
  const raw = String(versionStr || "").trim();
  const major = parseNodeMajorVersion(raw);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    const display = raw ? (raw.startsWith("v") ? raw : `v${raw}`) : "unknown";
    throw new Error(
      `Unsupported Node.js version ${display}. Agy-Context-Saver requires Node.js >= ${MIN_NODE_MAJOR}.0.0.\n` +
      `Please upgrade Node.js (https://nodejs.org/ or via nvm/fnm/volta) and re-run setup.`
    );
  }
  return major;
}

const fsPromises = fs.promises;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version || "2.0.4";
  } catch {
    return "2.0.4";
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

function normalizeDirForPathCompare(dirPath, platform = os.platform()) {
  if (!dirPath || typeof dirPath !== "string") return "";
  let trimmed = dirPath.trim().replace(/^"(.*)"$/, "$1");
  if (!trimmed) return "";
  if (trimmed === "~") {
    trimmed = os.homedir();
  } else if (/^~[\\/]/.test(trimmed)) {
    trimmed = path.join(os.homedir(), trimmed.slice(2));
  }
  const resolved = path.resolve(trimmed);
  const stripTrailing = (p) => {
    const root = path.parse(p).root;
    if (p === root) return p;
    return p.replace(/[\\/]+$/, "");
  };
  let normalized = stripTrailing(resolved);
  if (platform === "win32" || platform === "darwin") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

export function isDirOnPath(targetDir, pathEnv = process.env.PATH || process.env.Path || "", platform = os.platform()) {
  if (!targetDir || !pathEnv) return false;
  const delim = platform === "win32" ? ";" : ":";
  const targetNorm = normalizeDirForPathCompare(targetDir, platform);
  let targetReal = "";
  try {
    targetReal = normalizeDirForPathCompare(fs.realpathSync(targetDir), platform);
  } catch {}

  for (const rawEntry of String(pathEnv).split(delim)) {
    const entryNorm = normalizeDirForPathCompare(rawEntry, platform);
    if (!entryNorm) continue;
    if (entryNorm === targetNorm || (targetReal && entryNorm === targetReal)) {
      return true;
    }
    try {
      const entryReal = normalizeDirForPathCompare(fs.realpathSync(rawEntry.trim().replace(/^"(.*)"$/, "$1")), platform);
      if (entryReal && (entryReal === targetNorm || (targetReal && entryReal === targetReal))) {
        return true;
      }
    } catch {}
  }
  return false;
}

export function formatPathOnboardingLines(antigravityBinDir, { platform = os.platform() } = {}) {
  if (platform === "win32") {
    return [
      `[NEXT STEP] CLI bin directory is not on your PATH: ${antigravityBinDir}`,
      "  PowerShell (current session):",
      '    $bin = "$env:USERPROFILE\\.gemini\\antigravity\\bin"; $parts = @($env:Path -split ";" | Where-Object { $_.Trim() }); if (@($parts | ForEach-Object { $_.TrimEnd("\\") }) -notcontains $bin) { $env:Path = ($parts + $bin) -join ";" }',
      "  PowerShell (persistent user PATH, preserves REG_EXPAND_SZ):",
      '    $bin = "$env:USERPROFILE\\.gemini\\antigravity\\bin"; $raw = "%USERPROFILE%\\.gemini\\antigravity\\bin"; $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment"); try { $cur = [string]$k.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $parts = @($cur -split ";" | Where-Object { $_.Trim() }); $norm = @($parts | ForEach-Object { $_.TrimEnd("\\") }); if ($norm -notcontains $bin -and $norm -notcontains $raw) { $k.SetValue("Path", (($parts + $raw) -join ";"), [Microsoft.Win32.RegistryValueKind]::ExpandString) } } finally { $k.Close() }',
      "  Or run without modifying PATH:",
      "    npx --package=agy-context-saver agy-context status",
      "    npx --package=agy-context-saver agy-context uninstall"
    ];
  }
  return [
    `[NEXT STEP] CLI bin directory is not on your PATH: ${antigravityBinDir}`,
    "  Bash / Zsh (add to ~/.bashrc or ~/.zshrc):",
    '    export PATH="$HOME/.gemini/antigravity/bin:$PATH"',
    "  Or run without modifying PATH:",
    "    npx --package=agy-context-saver agy-context status",
    "    npx --package=agy-context-saver agy-context uninstall"
  ];
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
    onPath: isDirOnPath(antigravityBinDir),
    dir: antigravityBinDir,
    shims: present
  };
}

function inspectJsonObject(filePath, label) {
  if (!fs.existsSync(filePath)) return { exists: false, data: null, error: null };
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
      return { exists: true, data: null, error: `${label} is empty` };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, data: null, error: `${label} root must be a JSON object` };
    }
    return { exists: true, data: parsed, error: null };
  } catch (err) {
    return { exists: true, data: null, error: `${label} contains malformed JSON (${err.message})` };
  }
}

function findLegacyMcpArtifacts() {
  const { mcpJsonPath, antigravityMcpRootDir } = resolveProfilePaths();
  const legacyMcpKeys = [];
  let corrupt = false;
  let error = null;
  const mcpCheck = inspectJsonObject(mcpJsonPath, "mcp_config.json");
  if (mcpCheck.error) {
    corrupt = true;
    error = mcpCheck.error;
  } else if (mcpCheck.data) {
    if (
      mcpCheck.data.mcpServers !== undefined &&
      (!mcpCheck.data.mcpServers || typeof mcpCheck.data.mcpServers !== "object" || Array.isArray(mcpCheck.data.mcpServers))
    ) {
      corrupt = true;
      error = "mcp_config.json field 'mcpServers' must be a JSON object";
    } else if (mcpCheck.data.mcpServers) {
      for (const key of Object.keys(mcpCheck.data.mcpServers)) {
        if (isLegacyAgyMcpKey(key)) {
          legacyMcpKeys.push(key);
        }
      }
    }
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
    clean: duplicateCount === 0 && !corrupt,
    corrupt,
    error,
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
 * Recursively ensures copied plugin directories and files are user-writable on POSIX
 * so installs from read-only package stores (0o555 dirs / 0o444 files) can be upgraded
 * or uninstalled cleanly without EACCES. Never follows symlinks.
 */
function ensureTreeWritablePosix(rootPath) {
  if (os.platform() === "win32") return;
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    let st;
    try {
      st = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      try {
        fs.chmodSync(current, st.mode | 0o700);
      } catch {}
      try {
        for (const entry of fs.readdirSync(current)) {
          stack.push(path.join(current, entry));
        }
      } catch {}
    } else if (st.isFile()) {
      try {
        fs.chmodSync(current, st.mode | 0o200);
      } catch {}
    }
  }
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
  if (os.platform() !== "win32" && fs.existsSync(targetPath)) {
    try {
      const st = fs.lstatSync(targetPath);
      if (st.isFile()) fs.chmodSync(targetPath, st.mode | 0o200);
    } catch {}
  }
  await fsPromises.copyFile(sourcePath, targetPath);
  if (os.platform() !== "win32") {
    try {
      const st = fs.lstatSync(targetPath);
      if (st.isFile()) fs.chmodSync(targetPath, st.mode | 0o200);
    } catch {}
  }
  return true;
}

/**
 * Detects whether Agy-Context-Saver is already installed across all Antigravity 2.0 integration points.
 */
export function detectExistingInstallation(options = {}) {
  const {
    pluginDest,
    hooksJsonPath,
    configJsonPath,
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
  let hookCorrupt = false;
  let hookError = null;
  const appendHookError = (errMsg) => {
    hookCorrupt = true;
    hookError = hookError ? `${hookError}; ${errMsg}` : errMsg;
  };
  const pluginHooksPath = path.join(pluginDest, "hooks.json");
  const pluginHookCheck = inspectJsonObject(pluginHooksPath, "plugin hooks.json");
  if (pluginHookCheck.error) {
    appendHookError(pluginHookCheck.error);
  } else if (pluginHookCheck.data) {
    const h = pluginHookCheck.data[HOOK_KEY];
    if (h && typeof h === "object" && !Array.isArray(h)) {
      pluginHookCommand = h.PreToolUse?.[0]?.hooks?.[0]?.command ?? null;
      pluginHookRegistered = Boolean(pluginHookCommand) && !String(pluginHookCommand).includes("ANTIGRAVITY_PLUGIN_ROOT");
    }
  }

  let legacyHookPresent = false;
  let globalHookRegistered = false;
  let globalHookCommand = null;
  const expectedMatcher = getExpectedHookMatcher();
  const globalHookCheck = inspectJsonObject(hooksJsonPath, "hooks.json");
  if (globalHookCheck.error) {
    appendHookError(globalHookCheck.error);
  } else if (globalHookCheck.data) {
    const cfg = globalHookCheck.data;
    legacyHookPresent = Boolean(cfg[LEGACY_HOOK_KEY]);
    const gh = cfg[HOOK_KEY];
    if (gh && typeof gh === "object" && !Array.isArray(gh)) {
      globalHookCommand = gh.PreToolUse?.[0]?.hooks?.[0]?.command ?? null;
      const globalMatcher = gh.PreToolUse?.[0]?.matcher ?? "";
      globalHookRegistered =
        Boolean(globalHookCommand) &&
        String(globalHookCommand).replace(/\\/g, "/").includes(destHookNormalized) &&
        globalMatcher === expectedMatcher;
    }
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
  const hookRegistered = pluginHookRegistered && globalHookRegistered && mirroredHookExists && !mirroredHookStale && !hookCorrupt;

  const hasInstalledArtifacts =
    pluginExists ||
    Boolean(pluginLst) ||
    pluginHookRegistered ||
    globalHookRegistered ||
    legacyHookPresent ||
    mirroredHookExists ||
    cliShim.exists;

  let configCorrupt = false;
  let configError = null;
  let configEnabled = hasInstalledArtifacts;
  const cfgCheck = inspectJsonObject(configJsonPath, "config.json");
  if (cfgCheck.error) {
    configCorrupt = true;
    configError = cfgCheck.error;
    configEnabled = false;
  } else if (cfgCheck.data) {
    if (
      cfgCheck.data.plugins !== undefined &&
      (!cfgCheck.data.plugins || typeof cfgCheck.data.plugins !== "object" || Array.isArray(cfgCheck.data.plugins))
    ) {
      configCorrupt = true;
      configError = "config.json field 'plugins' must be a JSON object";
      configEnabled = false;
    } else {
      const cfgEntry = cfgCheck.data.plugins?.[HOOK_KEY];
      if (cfgEntry && typeof cfgEntry === "object" && !Array.isArray(cfgEntry) && typeof cfgEntry.enabled === "boolean") {
        configEnabled = cfgEntry.enabled;
      }
    }
  }

  const isInstalled =
    hasInstalledArtifacts ||
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
    mcp.clean &&
    !mcp.corrupt &&
    !configCorrupt &&
    configEnabled;

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
        corrupt: hookCorrupt,
        error: hookError,
        command: globalHookCommand || pluginHookCommand,
        scriptExists
      },
      cliShim,
      mcp,
      config: {
        corrupt: configCorrupt,
        error: configError,
        enabled: configEnabled
      },
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
    "where node.exe >nul 2>nul",
    "if errorlevel 1 goto :fallback",
    // A label-less GOTO ends the batch context. The queued executable can
    // delete this shim (and any managed node.cmd) and return its own status.
    `(goto) 2>nul & node.exe "${targetCliPath}" %*`,
    ":fallback",
    `(goto) 2>nul & "${process.execPath}" "${targetCliPath}" %*`,
    ""
  ].join("\r\n");
}

export function formatWindowsNodeCmdWrapper(nodeExe, destHook) {
  return [
    "@echo off",
    "chcp 65001 >nul",
    `REM ${MANAGED_SHIM_MARKER}`,
    'if /i "%~nx1"=="execution-guard-hook.mjs" goto :hook',
    'if /i "%~nx1"=="execution-guard.mjs" goto :hook',
    `"${nodeExe}" %*`,
    "exit /b %errorlevel%",
    ":hook",
    `"${nodeExe}" "${destHook}" %*`,
    "exit /b %errorlevel%",
    ""
  ].join("\r\n");
}

export async function installWindowsNodeCmdWrapper({ geminiConfigDir, destHook, nodeExe = process.execPath, log = () => {} }) {
  const nodeCmdPath = path.join(geminiConfigDir, "node.cmd");
  const nodeCmdBakPath = path.join(geminiConfigDir, "node.cmd.bak");
  await fsPromises.mkdir(geminiConfigDir, { recursive: true });

  if (fs.existsSync(nodeCmdPath)) {
    try {
      const existingWrapper = fs.readFileSync(nodeCmdPath, "utf-8");
      if (existingWrapper && !existingWrapper.includes(MANAGED_SHIM_MARKER) && !fs.existsSync(nodeCmdBakPath)) {
        await fsPromises.copyFile(nodeCmdPath, nodeCmdBakPath);
        log(`[OK] Backed up existing node.cmd to: ${nodeCmdBakPath}`);
      }
    } catch {}
  }

  const wrapperBody = formatWindowsNodeCmdWrapper(nodeExe, destHook);
  const changed = await safeWriteFileIfChanged(nodeCmdPath, wrapperBody);
  log(`[OK] Node wrapper ${changed ? "installed to" : "verified at"}: ${nodeCmdPath}`);
  return { path: nodeCmdPath, changed };
}

export function isManagedAgyShimFile(filePath) {
  try {
    const st = fs.lstatSync(filePath);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) return false;
    return fs.readFileSync(filePath, "utf-8").includes(MANAGED_SHIM_MARKER);
  } catch {
    return false;
  }
}

export function formatManagedRtkShims(targetRtkPath) {
  const targetNormalized = targetRtkPath.replace(/\\/g, "/").replace(/(["\\$`])/g, "\\$1");
  const posixBody = [
    "#!/bin/sh",
    `# ${MANAGED_SHIM_MARKER}`,
    "set -eu",
    `exec "${targetNormalized}" "$@"`,
    ""
  ].join("\n");
  const winBody = [
    "@echo off",
    "chcp 65001 >nul",
    `REM ${MANAGED_SHIM_MARKER}`,
    `"${targetRtkPath}" %*`,
    "exit /b %errorlevel%",
    ""
  ].join("\r\n");
  return { posixBody, winBody };
}

async function installManagedRtkShim({ log, rtkResult }) {
  const { pluginDest, antigravityBinDir } = resolveProfilePaths();
  const isWin = os.platform() === "win32";
  const exeNames = isWin ? ["rtk.exe", "rtk.cmd"] : ["rtk"];
  const posixShimPath = path.join(antigravityBinDir, "rtk");
  const winShimPath = path.join(antigravityBinDir, "rtk.cmd");

  const removeStaleManagedRtkShims = async () => {
    let removed = false;
    for (const shimPath of [posixShimPath, winShimPath]) {
      if (isManagedAgyShimFile(shimPath)) {
        try {
          await fsPromises.unlink(shimPath);
          log(`[OK] Removed stale managed RTK shim: ${shimPath}`);
          removed = true;
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
      }
    }
    return removed;
  };

  let localRtkTarget = "";
  for (const name of exeNames) {
    const candidate = path.join(pluginDest, "bin", name);
    if (verifyLocalRtkBinary(candidate)) {
      localRtkTarget = candidate;
      break;
    }
  }
  if (!localRtkTarget && rtkResult?.isLocal && rtkResult.path && verifyLocalRtkBinary(rtkResult.path)) {
    localRtkTarget = rtkResult.path;
  }
  // Only install/refresh a managed rtk shim when local plugin RTK is the active binary.
  // When an external system rtk on PATH supersedes bundled RTK (or in degraded mode), remove
  // any Agy-managed shim so it never shadows system rtk (never touching unmanaged user binaries).
  if (!rtkResult || !rtkResult.isLocal || !localRtkTarget) {
    const removed = await removeStaleManagedRtkShims();
    return { installed: false, removed };
  }

  await fsPromises.mkdir(antigravityBinDir, { recursive: true });
  const { posixBody, winBody } = formatManagedRtkShims(localRtkTarget);
  let changed = false;
  let wroteAny = false;

  const canWriteShim = (shimPath) => {
    try {
      fs.lstatSync(shimPath);
      return isManagedAgyShimFile(shimPath);
    } catch (err) {
      return err && err.code === "ENOENT";
    }
  };

  if (canWriteShim(posixShimPath)) {
    if (await safeWriteFileIfChanged(posixShimPath, posixBody)) {
      changed = true;
    }
    try {
      fs.chmodSync(posixShimPath, 0o755);
    } catch {}
    wroteAny = true;
  } else {
    log(`[INFO] Preserving existing unmanaged rtk executable at: ${posixShimPath}`);
  }

  if (isWin) {
    if (canWriteShim(winShimPath)) {
      if (await safeWriteFileIfChanged(winShimPath, winBody)) {
        changed = true;
      }
      wroteAny = true;
    } else {
      log(`[INFO] Preserving existing unmanaged rtk.cmd at: ${winShimPath}`);
    }
  }

  if (wroteAny) {
    log(`[OK] Managed RTK shim installed in: ${antigravityBinDir}${changed ? "" : " (up-to-date)"}`);
  }
  return { installed: wroteAny, changed, target: localRtkTarget };
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
  assertSupportedNodeVersion(options.nodeVersion);
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

  // 0a. Inspect existing pluginDest BEFORE RTK provisioning so we never write through a symlink
  //     to a read-only/shared repoRoot or leave an orphan pluginDest/bin directory on failure.
  let pluginLst = null;
  try {
    pluginLst = fs.lstatSync(pluginDest, { bigint: true });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const sourceStat = fs.statSync(repoRoot, { bigint: true });
  // A shim installed from an npm tarball runs directly from the plugin copy.
  const installedSource = pluginLst?.isDirectory() &&
    pluginLst.dev === sourceStat.dev && pluginLst.ino === sourceStat.ino;
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

  // Ensure RTK (>= 1.1.0) is provisioned and available into a user-writable target bin dir
  const repoBinDir = path.join(repoRoot, "bin");
  const repoBinWritable = isDirectoryWritable(repoBinDir);
  const isGitRepo = fs.existsSync(path.join(repoRoot, ".git"));
  const isTempOrNpx =
    !isGitRepo || repoRoot.includes("_npx") || repoRoot.includes("npm-cache") || repoRoot.includes("node_modules");
  const forceCopyMode = Boolean(isTempOrNpx || options.forceCopyFallback || !repoBinWritable);
  const pluginBinDir = path.join(pluginDest, "bin");
  const wantsPluginBin = forceCopyMode || Boolean(process.env.AGY_TEST_PROFILE_DIR);
  const shouldStagePluginRtk = wantsPluginBin && !installedSource && !options.rtkOptions?.targetBinDir;
  let stagedRtkBinDir = null;
  let stagedPluginRtk = null;
  let rtkResult = null;
  try {
    if (shouldStagePluginRtk) {
      stagedRtkBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-rtk-stage-bin-"));
    }
    const targetBinDir = stagedRtkBinDir || (wantsPluginBin ? pluginBinDir : repoBinDir);
    try {
      rtkResult = await ensureRtkInstalled({
        silent: options.silent,
        existingRtk: existing.details.rtk,
        targetBinDir,
        ...(options.rtkOptions || {})
      });
      if (
        stagedRtkBinDir &&
        rtkResult?.isLocal &&
        rtkResult.path &&
        path.resolve(path.dirname(rtkResult.path)).toLowerCase() === path.resolve(stagedRtkBinDir).toLowerCase()
      ) {
        const exeName = path.basename(rtkResult.path);
        stagedPluginRtk = {
          name: exeName,
          data: await fsPromises.readFile(rtkResult.path),
          mode: fs.statSync(rtkResult.path).mode
        };
        rtkResult = { ...rtkResult, path: path.join(pluginBinDir, exeName) };
      }
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
  } finally {
    if (stagedRtkBinDir) {
      try {
        fs.rmSync(stagedRtkBinDir, { recursive: true, force: true });
      } catch {}
    }
  }

  const provisionedInPluginBin = Boolean(
    stagedPluginRtk ||
      (rtkResult?.isLocal &&
        rtkResult.path &&
        path.resolve(path.dirname(rtkResult.path)).toLowerCase() === path.resolve(pluginBinDir).toLowerCase())
  );
  const mustCopyPlugin = forceCopyMode || provisionedInPluginBin;

  // 1. Native Plugin Junction / Symlink or Permanent Copy
  await fsPromises.mkdir(pluginsDir, { recursive: true });
  const copyFilter = (src) => {
    const rel = path.relative(repoRoot, src);
    if (!rel) return true;
    const topSegment = rel.split(path.sep)[0];
    return ![".git", "node_modules", ".venv", "scratch", "site"].includes(topSegment);
  };

  // Preserve a previously bundled local RTK binary inside pluginDest/bin if pluginDest is being replaced by a copy
  let preservedPluginRtk = null;
  if (
    pluginLst && !installedSource &&
    (!pluginExists || mustCopyPlugin || !pluginLst.isSymbolicLink() || pluginPointsElsewhere)
  ) {
    if (pluginExists && !stagedPluginRtk) {
      const candidateNames = os.platform() === "win32" ? ["rtk.exe", "rtk.cmd", "rtk"] : ["rtk", "rtk.exe", "rtk.cmd"];
      for (const candidateName of candidateNames) {
        const candidatePath = path.join(pluginDest, "bin", candidateName);
        if (verifyLocalRtkBinary(candidatePath, options.rtkOptions)) {
          try {
            preservedPluginRtk = {
              name: candidateName,
              data: await fsPromises.readFile(candidatePath),
              mode: fs.statSync(candidatePath).mode
            };
            break;
          } catch {}
        }
      }
    }
    if (pluginLst.isSymbolicLink()) {
      await fsPromises.unlink(pluginDest);
    } else {
      ensureTreeWritablePosix(pluginDest);
      await fsPromises.rm(pluginDest, { recursive: true, force: true });
    }
    pluginLst = null;
  }

  if (!pluginLst) {
    if (mustCopyPlugin) {
      await fsPromises.cp(repoRoot, pluginDest, { recursive: true, filter: copyFilter });
      ensureTreeWritablePosix(pluginDest);
      log(`[OK] Native Antigravity Plugin installed to: ${pluginDest}`);
    } else {
      try {
        const isWin = os.platform() === "win32";
        fs.symlinkSync(repoRoot, pluginDest, isWin ? "junction" : "dir");
        log(`[OK] Native Antigravity Plugin linked: ${pluginDest} -> ${repoRoot}`);
      } catch {
        await fsPromises.cp(repoRoot, pluginDest, { recursive: true, filter: copyFilter });
        ensureTreeWritablePosix(pluginDest);
        log(`[OK] Native Antigravity Plugin copied to: ${pluginDest}`);
      }
    }
  } else {
    log(`[OK] Native Antigravity Plugin verified: ${pluginDest}`);
  }

  const rtkToRestore = stagedPluginRtk || preservedPluginRtk;
  if (rtkToRestore) {
    let destIsSymlink = false;
    try { destIsSymlink = fs.lstatSync(pluginDest).isSymbolicLink(); } catch {}
    if (!destIsSymlink) {
      const restoredRtkPath = path.join(pluginDest, "bin", rtkToRestore.name);
      if (stagedPluginRtk || !verifyLocalRtkBinary(restoredRtkPath, options.rtkOptions)) {
        await fsPromises.mkdir(path.dirname(restoredRtkPath), { recursive: true });
        ensureTreeWritablePosix(path.dirname(restoredRtkPath));
        await fsPromises.writeFile(restoredRtkPath, rtkToRestore.data);
        if (os.platform() !== "win32") {
          try { fs.chmodSync(restoredRtkPath, rtkToRestore.mode || 0o755); } catch {}
        }
      }
    }
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

  // 5. Install executable CLI shims (agy-context, agy-context-saver) and managed local RTK shim into ~/.gemini/antigravity/bin/
  await installCliShims({ log });
  await installManagedRtkShim({ log, rtkResult });

  // 5b. On Windows, install managed ~/.gemini/config/node.cmd wrapper for full parity with install.ps1
  if (os.platform() === "win32") {
    await installWindowsNodeCmdWrapper({ geminiConfigDir, destHook, log });
  }

  // 6. Clean up legacy temp-folder state from versions <= 1.7.0
  for (const legacy of removeLegacyTmpState()) {
    log(`[OK] Removed legacy temp-folder state: ${legacy}`);
  }

  const elapsed = (performance.now() - startTime).toFixed(1);
  const statusVerb = existing.isInstalled ? "synchronized & up-to-date" : "completed";
  log(`\nInstallation ${statusVerb} in ${elapsed}ms!\n`);
  log("Next steps:");
  log("  1. Reload Antigravity Desktop IDE or start a new session so hooks, rules, and skills activate.");
  log("  2. Verify installation health: agy-context status");
  log("");
  if (!isDirOnPath(antigravityBinDir)) {
    for (const line of formatPathOnboardingLines(antigravityBinDir)) {
      log(line);
    }
    log("");
  }
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
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (pluginStat) {
    if (pluginStat.isSymbolicLink()) {
      await fsPromises.unlink(pluginDest);
    } else {
      ensureTreeWritablePosix(pluginDest);
      await fsPromises.rm(pluginDest, { recursive: true, force: true });
    }
    log(`[OK] Removed plugin link: ${pluginDest}`);
  }

  // 2. Remove mirrored hook script (including dangling symlinks via lstatSync, S2-SCRIPT-011)
  let destHookStat = null;
  try {
    destHookStat = fs.lstatSync(destHook);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (destHookStat) {
    if (destHookStat.isDirectory() && !destHookStat.isSymbolicLink()) {
      await fsPromises.rm(destHook, { recursive: true, force: true });
    } else {
      await fsPromises.unlink(destHook);
    }
    log(`[OK] Removed mirrored hook script: ${destHook}`);
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
      try {
        const shimStat = fs.lstatSync(shimPath);
        if (shimStat.isDirectory() && !shimStat.isSymbolicLink()) {
          await fsPromises.rm(shimPath, { recursive: true, force: true });
        } else {
          await fsPromises.unlink(shimPath);
        }
        log(`[OK] Removed CLI shim: ${shimPath}`);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
  }

  // 6a. Remove managed RTK shims created by Agy-Context-Saver only (never remove a user's pre-existing rtk binary)
  for (const candidate of ["rtk", "rtk.cmd"]) {
    const rtkShimPath = path.join(antigravityBinDir, candidate);
    if (isManagedAgyShimFile(rtkShimPath)) {
      try {
        await fsPromises.unlink(rtkShimPath);
        log(`[OK] Removed managed RTK shim: ${rtkShimPath}`);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
  }

  // 6b. Remove managed Windows node.cmd wrapper (created by setup/install.ps1) and restore backup if present
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
  const hookStatusLabel = existing.details.hook.corrupt
    ? `CORRUPT (${existing.details.hook.error})`
    : existing.details.hook.registered
      ? "ACTIVE (plugin + global hooks.json)"
      : existing.details.hook.mirroredHookStale
        ? `STALE MIRRORED HOOK (${destHook}; re-run agy-context setup)`
        : existing.details.hook.pluginHookRegistered
          ? "PARTIAL (plugin hooks.json only; global /swarm hook missing)"
          : "NOT REGISTERED";
  log(
    `- Execution Governor Hook (${HOOK_KEY}): ${hookStatusLabel}${existing.details.hook.legacyHookPresent ? " (legacy 'execution-guard' in global hooks.json)" : ""}`
  );
  const shimPathNote = existing.details.cliShim.exists && !existing.details.cliShim.onPath ? " [NOT ON PATH]" : "";
  log(
    `- CLI Shim (agy-context): ${existing.details.cliShim.exists ? "INSTALLED (" + antigravityBinDir + ")" + shimPathNote : "MISSING"}`
  );
  log(
    `- RTK Command Optimizer (>= 1.1.0): ${existing.details.rtk ? "INSTALLED (" + existing.details.rtk.version + ")" : "MISSING"}`
  );
  log(
    `- MCP Cleanup: ${
      existing.details.mcp.corrupt
        ? `CORRUPT (${existing.details.mcp.error})`
        : existing.details.mcp.clean
          ? "CLEAN (0 duplicate MCP configs/schemas)"
          : existing.details.mcp.duplicateCount + " legacy MCP config/schema entries present"
    }`
  );
  log(
    `- Plugin Enabled (config.json): ${
      existing.details.config.corrupt
        ? `CORRUPT (${existing.details.config.error})`
        : existing.details.config.enabled
          ? "ENABLED"
          : "DISABLED"
    }`
  );
  const ta = existing.details.transcriptAccess || formatTranscriptAccessStatus();
  const lr = ta.launchRestrictions;
  const lrNote = lr && lr.restrictedCount > 0
    ? ` | Recent launch-restricted children: ${lr.restrictedCount} (${lr.denyCount} deny, ${lr.selfOnlyCount} self-only; launch directives remain in effect)`
    : "";
  log(
    `- Transcript Access Policy: ${
      ta.active
        ? `${ta.mode.toUpperCase()} (owner: ${ta.ownerId})`
        : (lr && lr.restrictedCount > 0 ? "OPEN (parent CLI policy)" : "OPEN (default)")
    }${lrNote}`
  );

  const hasCorruption =
    existing.details.hook.corrupt ||
    existing.details.mcp.corrupt ||
    existing.details.config.corrupt;
  const overallLabel = existing.isComplete
    ? "HEALTHY & ACTIVE"
    : hasCorruption
      ? "CORRUPT CONFIGURATION"
      : existing.isInstalled
        ? (!existing.details.config.enabled ? "DISABLED" : "PARTIAL INSTALLATION")
        : "NOT INSTALLED";
  const onlyMissingRtk =
    !existing.isComplete &&
    !hasCorruption &&
    !existing.details.rtk &&
    existing.details.plugin.exists &&
    !existing.details.plugin.pointsElsewhere &&
    !existing.details.plugin.versionMismatch &&
    existing.details.hook.registered &&
    !existing.details.hook.mirroredHookStale &&
    !existing.details.hook.legacyHookPresent &&
    existing.details.cliShim.exists &&
    existing.details.mcp.clean &&
    existing.details.config.enabled;

  log(`\nOverall Status: ${overallLabel}\n`);
  if (onlyMissingRtk) {
    log(
      "Next step (degraded mode: RTK >= 1.1.0 is the only missing component):\n" +
      "  - Hook governance and the agy-context transcript CLI are active.\n" +
      "  - To enable RTK command compression, install RTK >= 1.1.0 manually on PATH:\n" +
      "      brew install rtk | cargo install --locked rtk | https://github.com/rtk-ai/rtk/releases/tag/v1.1.0\n" +
      "    then re-run 'agy-context setup', or run 'agy-context setup --allow-degraded' to stay in hook-only degraded mode.\n"
    );
  } else if (!existing.isInstalled || overallLabel === "PARTIAL INSTALLATION") {
    log("Next step: run 'npx --package=agy-context-saver agy-context setup' (or 'agy-context setup') to install/repair.\n");
  }
  if (existing.details.cliShim.exists && !existing.details.cliShim.onPath) {
    for (const line of formatPathOnboardingLines(antigravityBinDir)) {
      log(line);
    }
    log("");
  }
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
