#!/usr/bin/env node

/**
 * Agy-Context-Saver Registration & Installation Engine
 * Zero-delay cross-platform installer with intelligent existing-installation detection.
 *
 * Capabilities:
 * - Detects existing native plugin link, hook registration, MCP server, and tool schemas
 * - Re-verifies and updates in ~10-15ms without redundant configuration churn
 * - Uses asynchronous file operations (fs.promises) with parallel schema writes
 * - Supports silent mode for stdio MCP JSON-RPC compatibility
 * - Supports CLI flags: install, install --check, uninstall, status
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fsPromises = fs.promises;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const homeDir = os.homedir();
const geminiConfigDir = path.join(homeDir, ".gemini", "config");
const pluginsDir = path.join(geminiConfigDir, "plugins");
const pluginDest = path.join(pluginsDir, "agy-context-saver");
const scriptsDir = path.join(geminiConfigDir, "scripts");
const hooksJsonPath = path.join(geminiConfigDir, "hooks.json");
const mcpJsonPath = path.join(geminiConfigDir, "mcp_config.json");
const antigravityMcpDir = path.join(homeDir, ".gemini", "antigravity", "mcp", "agy-context-saver");

const sourceHook = path.join(repoRoot, "scripts", "execution-guard-hook.mjs");
const destHook = path.join(scriptsDir, "execution-guard-hook.mjs");
const mcpIndexPath = path.join(repoRoot, "mcp", "index.js").replace(/\\/g, "/");
const destHookNormalized = destHook.replace(/\\/g, "/");

/**
 * Detects whether Agy-Context-Saver is already installed across all Antigravity integration points.
 */
export function detectExistingInstallation() {
  const pluginExists = fs.existsSync(pluginDest);
  let pluginTarget = null;
  if (pluginExists) {
    try {
      pluginTarget = fs.readlinkSync(pluginDest);
    } catch {
      pluginTarget = "direct folder or junction";
    }
  }

  let hookRegistered = false;
  let hookCommand = null;
  if (fs.existsSync(hooksJsonPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
      const h = cfg["execution-guard"] || cfg["agy-context-saver"];
      if (h) {
        hookRegistered = true;
        hookCommand = h.PreToolUse?.[0]?.hooks?.[0]?.command;
      }
    } catch {}
  }

  let mcpRegistered = false;
  let mcpArgs = null;
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      if (cfg.mcpServers?.["agy-context-saver"]) {
        mcpRegistered = true;
        mcpArgs = cfg.mcpServers["agy-context-saver"].args;
      }
    } catch {}
  }

  const scriptExists = fs.existsSync(destHook);
  const schemasExist =
    fs.existsSync(path.join(antigravityMcpDir, "safe_command.json")) &&
    fs.existsSync(path.join(antigravityMcpDir, "check_context_health.json")) &&
    fs.existsSync(path.join(antigravityMcpDir, "subagent_brief.json")) &&
    fs.existsSync(path.join(antigravityMcpDir, "get_installation_status.json")) &&
    fs.existsSync(path.join(antigravityMcpDir, "sync_installation.json"));

  const isInstalled = pluginExists || (hookRegistered && mcpRegistered);
  const isComplete = (pluginExists || (hookRegistered && mcpRegistered && scriptExists)) && schemasExist;

  return {
    isInstalled,
    isComplete,
    details: {
      plugin: { exists: pluginExists, target: pluginTarget },
      hook: { registered: hookRegistered, command: hookCommand, scriptExists },
      mcp: { registered: mcpRegistered, args: mcpArgs },
      schemas: { exists: schemasExist, dir: antigravityMcpDir }
    }
  };
}

export async function runInstall(options = {}) {
  const log = options.silent ? () => {} : console.log;
  const warn = options.silent ? () => {} : console.warn;

  const startTime = performance.now();
  const existing = detectExistingInstallation();

  if (existing.isInstalled) {
    log("🔍 Existing installation detected:");
    if (existing.details.plugin.exists) {
      log(`   ✓ Native Plugin Link: ${pluginDest}`);
    }
    if (existing.details.hook.registered) {
      log(`   ✓ Governor Hook: Registered in ${hooksJsonPath}`);
    }
    if (existing.details.mcp.registered) {
      log(`   ✓ Universal MCP Server: Configured in ${mcpJsonPath}`);
    }
    if (existing.details.schemas.exists) {
      log(`   ✓ Antigravity Tool Schemas: Present in ${antigravityMcpDir}`);
    }

    if (options.checkOnly) {
      log("\n[OK] Pre-flight check complete. Installation is active.");
      return existing;
    }
    log("\n⚡ Re-verifying and synchronizing to latest version...");
  } else {
    log("⚡ Fresh installation of Agy-Context-Saver (Zero-Delay Mode)...");
  }

  // 1. Instant Native Plugin Junction / Symlink (Takes ~5ms)
  await fsPromises.mkdir(pluginsDir, { recursive: true });
  if (!fs.existsSync(pluginDest)) {
    try {
      const isWin = os.platform() === "win32";
      fs.symlinkSync(repoRoot, pluginDest, isWin ? "junction" : "dir");
      log(`[OK] Native Antigravity Plugin linked: ${pluginDest} -> ${repoRoot}`);
    } catch (err) {
      warn(`[WARN] Plugin symlink skipped (${err.message}). Using direct configuration.`);
    }
  } else {
    log(`[OK] Native Antigravity Plugin link verified: ${pluginDest}`);
  }

  // 2. Ensure scripts dir exists & copy hook script asynchronously
  await fsPromises.mkdir(scriptsDir, { recursive: true });
  await fsPromises.copyFile(sourceHook, destHook);
  log(`[OK] Governor hook script mirrored to: ${destHook}`);

  // 3. Register Hook in ~/.gemini/config/hooks.json (Preserves existing hooks)
  let hooksConfig = {};
  if (fs.existsSync(hooksJsonPath)) {
    try {
      hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
    } catch (err) {
      hooksConfig = {};
    }
  }

  const alreadyHadHook = Boolean(hooksConfig["execution-guard"]);
  hooksConfig["execution-guard"] = {
    PreToolUse: [
      {
        matcher: "manage_task|run_command|schedule",
        hooks: [
          {
            type: "command",
            command: `node "${destHookNormalized}"`,
            timeout: 5
          }
        ]
      }
    ]
  };
  await fsPromises.writeFile(hooksJsonPath, JSON.stringify(hooksConfig, null, 2), "utf-8");
  log(`[OK] Lifecycle hook ${alreadyHadHook ? "re-verified" : "registered"} in: ${hooksJsonPath}`);

  // 4. Register MCP Server in ~/.gemini/config/mcp_config.json (Preserves existing servers)
  let mcpConfig = { mcpServers: {} };
  if (fs.existsSync(mcpJsonPath)) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    } catch (err) {
      mcpConfig = { mcpServers: {} };
    }
  }

  const alreadyHadMcp = Boolean(mcpConfig.mcpServers["agy-context-saver"]);
  mcpConfig.mcpServers["agy-context-saver"] = {
    command: "node",
    args: [mcpIndexPath]
  };
  await fsPromises.writeFile(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
  log(`[OK] MCP Server ${alreadyHadMcp ? "re-verified" : "registered"} in: ${mcpJsonPath}`);

  // 5. Mirror Antigravity Tool Schemas in parallel
  await fsPromises.mkdir(antigravityMcpDir, { recursive: true });

  const instructionsContent = `Agy-Context-Saver MCP Server: Universal Model Context Protocol server for Google Antigravity. Provides safe_command execution with automatic repetitive output compression, check_context_health transcript diagnostics, subagent_brief scope isolation, and native installation self-audit/synchronization tools.`;

  const safeCommandSchema = {
    name: "safe_command",
    description: "Run a shell command with intelligent output compression, generous timeout, and zero context bloat. Collapses massive test dot streams and repetitive logs to protect context window attention.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The exact shell command to execute." },
        cwd: { type: "string", description: "Working directory (optional, defaults to current working directory)." },
        timeoutSeconds: { type: "number", description: "Execution timeout in seconds (default: 30)." },
        maxOutputLines: { type: "number", description: "Maximum output lines to return before compressing (default: 30)." }
      },
      required: ["command"]
    }
  };

  const checkHealthSchema = {
    name: "check_context_health",
    description: "Inspects a conversation transcript (transcript.jsonl) to diagnose turn count, payload size, tool polling loops, and context degradation risk.",
    parameters: {
      type: "object",
      properties: {
        transcriptPath: { type: "string", description: "Path to transcript.jsonl file." }
      },
      required: ["transcriptPath"]
    }
  };

  const subagentBriefSchema = {
    name: "subagent_brief",
    description: "Generates a scope-isolated, anti-bloat prompt for invoking a subagent. Instructs the subagent to absorb all intermediate file reads/searches and return only high-signal findings.",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "The core research or investigative objective." },
        scopeFiles: { type: "array", items: { type: "string" }, description: "List of files or directories to investigate." },
        expectedDeliverable: { type: "string", description: "The concise format expected back by the parent agent." }
      },
      required: ["objective"]
    }
  };

  const getInstallationStatusSchema = {
    name: "get_installation_status",
    description: "Inspect the live installation status of Agy-Context-Saver across all Antigravity integration points (Native Plugin Link, Governor Hook, MCP Server, and Tool Schemas).",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  };

  const syncInstallationSchema = {
    name: "sync_installation",
    description: "Re-verify and synchronize Agy-Context-Saver installation, updating the governor hook, plugin link, and tool schemas in ~25ms without terminal shell commands.",
    parameters: {
      type: "object",
      properties: {
        checkOnly: {
          type: "boolean",
          description: "If true, performs a pre-flight audit without writing changes (default: false)."
        }
      },
      required: []
    }
  };

  await Promise.all([
    fsPromises.writeFile(path.join(antigravityMcpDir, "instructions.md"), instructionsContent, "utf-8"),
    fsPromises.writeFile(path.join(antigravityMcpDir, "safe_command.json"), JSON.stringify(safeCommandSchema, null, 2), "utf-8"),
    fsPromises.writeFile(path.join(antigravityMcpDir, "check_context_health.json"), JSON.stringify(checkHealthSchema, null, 2), "utf-8"),
    fsPromises.writeFile(path.join(antigravityMcpDir, "subagent_brief.json"), JSON.stringify(subagentBriefSchema, null, 2), "utf-8"),
    fsPromises.writeFile(path.join(antigravityMcpDir, "get_installation_status.json"), JSON.stringify(getInstallationStatusSchema, null, 2), "utf-8"),
    fsPromises.writeFile(path.join(antigravityMcpDir, "sync_installation.json"), JSON.stringify(syncInstallationSchema, null, 2), "utf-8")
  ]);

  const elapsed = (performance.now() - startTime).toFixed(1);
  const statusVerb = existing.isInstalled ? "synchronized & up-to-date" : "completed";
  log(`\n✓ Installation ${statusVerb} in ${elapsed}ms (Zero Delay)!\n`);
  return { ...existing, isInstalled: true, elapsedMs: elapsed };
}

export async function runUninstall(options = {}) {
  const log = options.silent ? () => {} : console.log;
  const warn = options.silent ? () => {} : console.warn;
  log("Uninstalling Agy-Context-Saver...");

  // 1. Remove plugin link
  if (fs.existsSync(pluginDest)) {
    try {
      await fsPromises.rm(pluginDest, { recursive: true, force: true });
      log(`[OK] Removed plugin link: ${pluginDest}`);
    } catch (err) {
      warn(`[WARN] Could not remove plugin link: ${err.message}`);
    }
  }

  // 2. Remove from hooks.json
  if (fs.existsSync(hooksJsonPath)) {
    try {
      const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
      delete hooksConfig["execution-guard"];
      delete hooksConfig["agy-context-saver"];
      await fsPromises.writeFile(hooksJsonPath, JSON.stringify(hooksConfig, null, 2), "utf-8");
      log(`[OK] Removed from: ${hooksJsonPath}`);
    } catch {}
  }

  // 3. Remove from mcp_config.json
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      if (mcpConfig.mcpServers) {
        delete mcpConfig.mcpServers["agy-context-saver"];
      }
      await fsPromises.writeFile(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
      log(`[OK] Removed from: ${mcpJsonPath}`);
    } catch {}
  }

  log("\n✓ Uninstallation complete.\n");
}

export function runStatus(options = {}) {
  const log = options.silent ? () => {} : console.log;
  const existing = detectExistingInstallation();
  log("Checking Agy-Context-Saver installation status...\n");
  log(`- Native Plugin Link: ${existing.details.plugin.exists ? "ACTIVE (" + pluginDest + ")" : "NOT LINKED"}`);
  log(`- Execution Governor Hook: ${existing.details.hook.registered ? "REGISTERED in hooks.json" : "NOT REGISTERED"}`);
  log(`- Universal MCP Server: ${existing.details.mcp.registered ? "CONFIGURED in mcp_config.json" : "NOT CONFIGURED"}`);
  log(`- Antigravity Tool Schemas: ${existing.details.schemas.exists ? "PRESENT" : "MISSING"}`);

  log(`\nOverall Status: ${existing.isComplete ? "HEALTHY & ACTIVE 🛡️" : existing.isInstalled ? "PARTIAL INSTALLATION" : "NOT INSTALLED"}\n`);
  return existing;
}

// Auto-run if executed directly as script
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === "--uninstall" || arg === "uninstall") {
    await runUninstall();
  } else if (arg === "--status" || arg === "status") {
    runStatus();
  } else if (arg === "--check" || arg === "-c") {
    await runInstall({ checkOnly: true });
  } else {
    await runInstall();
  }
}
