#!/usr/bin/env node

/**
 * Agy-Context-Saver Registration & Installation Engine
 * Zero-delay cross-platform installer with intelligent existing-installation detection.
 *
 * Capabilities:
 * - Detects existing native plugin link, hook registration, MCP server, and tool schemas
 * - Re-verifies and updates in ~10-15ms without redundant configuration churn
 * - Supports CLI flags: install, install --check, uninstall, status
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    fs.existsSync(path.join(antigravityMcpDir, "subagent_brief.json"));

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

export function runInstall(options = {}) {
  const startTime = performance.now();
  const existing = detectExistingInstallation();

  if (existing.isInstalled) {
    console.log("🔍 Existing installation detected:");
    if (existing.details.plugin.exists) {
      console.log(`   ✓ Native Plugin Link: ${pluginDest}`);
    }
    if (existing.details.hook.registered) {
      console.log(`   ✓ Governor Hook: Registered in ${hooksJsonPath}`);
    }
    if (existing.details.mcp.registered) {
      console.log(`   ✓ Universal MCP Server: Configured in ${mcpJsonPath}`);
    }
    if (existing.details.schemas.exists) {
      console.log(`   ✓ Antigravity Tool Schemas: Present in ${antigravityMcpDir}`);
    }

    if (options.checkOnly) {
      console.log("\n[OK] Pre-flight check complete. Installation is active.");
      return existing;
    }
    console.log("\n⚡ Re-verifying and synchronizing to latest version...");
  } else {
    console.log("⚡ Fresh installation of Agy-Context-Saver (Zero-Delay Mode)...");
  }

  // 1. Instant Native Plugin Junction / Symlink (Takes ~5ms)
  fs.mkdirSync(pluginsDir, { recursive: true });
  if (!fs.existsSync(pluginDest)) {
    try {
      const isWin = os.platform() === "win32";
      fs.symlinkSync(repoRoot, pluginDest, isWin ? "junction" : "dir");
      console.log(`[OK] Native Antigravity Plugin linked: ${pluginDest} -> ${repoRoot}`);
    } catch (err) {
      console.warn(`[WARN] Plugin symlink skipped (${err.message}). Using direct configuration.`);
    }
  } else {
    console.log(`[OK] Native Antigravity Plugin link verified: ${pluginDest}`);
  }

  // 2. Ensure scripts dir exists & copy hook script
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(sourceHook, destHook);
  console.log(`[OK] Governor hook script mirrored to: ${destHook}`);

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
  fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2), "utf-8");
  console.log(`[OK] Lifecycle hook ${alreadyHadHook ? "re-verified" : "registered"} in: ${hooksJsonPath}`);

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
  fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
  console.log(`[OK] MCP Server ${alreadyHadMcp ? "re-verified" : "registered"} in: ${mcpJsonPath}`);

  // 5. Mirror Antigravity Tool Schemas
  fs.mkdirSync(antigravityMcpDir, { recursive: true });

  const instructionsContent = `Agy-Context-Saver MCP Server: Universal Model Context Protocol server for Google Antigravity. Provides safe_command execution with automatic repetitive output compression, check_context_health transcript diagnostics, and subagent_brief scope isolation.`;
  fs.writeFileSync(path.join(antigravityMcpDir, "instructions.md"), instructionsContent, "utf-8");

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
  fs.writeFileSync(path.join(antigravityMcpDir, "safe_command.json"), JSON.stringify(safeCommandSchema, null, 2), "utf-8");

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
  fs.writeFileSync(path.join(antigravityMcpDir, "check_context_health.json"), JSON.stringify(checkHealthSchema, null, 2), "utf-8");

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
  fs.writeFileSync(path.join(antigravityMcpDir, "subagent_brief.json"), JSON.stringify(subagentBriefSchema, null, 2), "utf-8");

  const elapsed = (performance.now() - startTime).toFixed(1);
  const statusVerb = existing.isInstalled ? "synchronized & up-to-date" : "completed";
  console.log(`\n✓ Installation ${statusVerb} in ${elapsed}ms (Zero Delay)!\n`);
  return { ...existing, isInstalled: true, elapsedMs: elapsed };
}

export function runUninstall() {
  console.log("Uninstalling Agy-Context-Saver...");

  // 1. Remove plugin link
  if (fs.existsSync(pluginDest)) {
    try {
      fs.rmSync(pluginDest, { recursive: true, force: true });
      console.log(`[OK] Removed plugin link: ${pluginDest}`);
    } catch (err) {
      console.warn(`[WARN] Could not remove plugin link: ${err.message}`);
    }
  }

  // 2. Remove from hooks.json
  if (fs.existsSync(hooksJsonPath)) {
    try {
      const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
      delete hooksConfig["execution-guard"];
      delete hooksConfig["agy-context-saver"];
      fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2), "utf-8");
      console.log(`[OK] Removed from: ${hooksJsonPath}`);
    } catch {}
  }

  // 3. Remove from mcp_config.json
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      if (mcpConfig.mcpServers) {
        delete mcpConfig.mcpServers["agy-context-saver"];
      }
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
      console.log(`[OK] Removed from: ${mcpJsonPath}`);
    } catch {}
  }

  console.log("\n✓ Uninstallation complete.\n");
}

export function runStatus() {
  const existing = detectExistingInstallation();
  console.log("Checking Agy-Context-Saver installation status...\n");
  console.log(`- Native Plugin Link: ${existing.details.plugin.exists ? "ACTIVE (" + pluginDest + ")" : "NOT LINKED"}`);
  console.log(`- Execution Governor Hook: ${existing.details.hook.registered ? "REGISTERED in hooks.json" : "NOT REGISTERED"}`);
  console.log(`- Universal MCP Server: ${existing.details.mcp.registered ? "CONFIGURED in mcp_config.json" : "NOT CONFIGURED"}`);
  console.log(`- Antigravity Tool Schemas: ${existing.details.schemas.exists ? "PRESENT" : "MISSING"}`);

  console.log(`\nOverall Status: ${existing.isComplete ? "HEALTHY & ACTIVE 🛡️" : existing.isInstalled ? "PARTIAL INSTALLATION" : "NOT INSTALLED"}\n`);
  return existing;
}

// Auto-run if executed directly as script
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === "--uninstall" || arg === "uninstall") {
    runUninstall();
  } else if (arg === "--status" || arg === "status") {
    runStatus();
  } else if (arg === "--check" || arg === "-c") {
    runInstall({ checkOnly: true });
  } else {
    runInstall();
  }
}
