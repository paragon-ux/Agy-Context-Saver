#!/usr/bin/env node

/**
 * Agy-Context-Saver Registration & Installation Engine
 * Zero-delay cross-platform installer for Google Antigravity.
 *
 * Capabilities:
 * - 1-step Native Plugin Link (~10ms): Links directly into ~/.gemini/config/plugins/
 * - Global JSON Fallback: Safely registers hooks & MCP servers without overwriting existing entries
 * - Antigravity Schema Mirroring: Updates ~/.gemini/antigravity/mcp/ tool definitions
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

export function runInstall() {
  const startTime = performance.now();
  console.log("⚡ Installing Agy-Context-Saver (Zero-Delay Mode)...");

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
  console.log(`[OK] Lifecycle hook registered in: ${hooksJsonPath}`);

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

  mcpConfig.mcpServers["agy-context-saver"] = {
    command: "node",
    args: [mcpIndexPath]
  };
  fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
  console.log(`[OK] MCP Server registered in: ${mcpJsonPath}`);

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
  console.log(`\n✓ Installation completed in ${elapsed}ms (Zero Delay)!\n`);
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
  console.log("Checking Agy-Context-Saver installation status...\n");
  const pluginActive = fs.existsSync(pluginDest);
  console.log(`- Native Plugin Link: ${pluginActive ? "ACTIVE (" + pluginDest + ")" : "NOT LINKED"}`);

  let hookActive = false;
  if (fs.existsSync(hooksJsonPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
      hookActive = Boolean(cfg["execution-guard"] || cfg["agy-context-saver"]);
    } catch {}
  }
  console.log(`- Execution Governor Hook: ${hookActive ? "REGISTERED in hooks.json" : "NOT REGISTERED"}`);

  let mcpActive = false;
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      mcpActive = Boolean(cfg.mcpServers?.["agy-context-saver"]);
    } catch {}
  }
  console.log(`- Universal MCP Server: ${mcpActive ? "CONFIGURED in mcp_config.json" : "NOT CONFIGURED"}`);

  const schemasActive = fs.existsSync(antigravityMcpDir);
  console.log(`- Antigravity Tool Schemas: ${schemasActive ? "PRESENT" : "MISSING"}`);

  const fullyHealthy = pluginActive || (hookActive && mcpActive && schemasActive);
  console.log(`\nOverall Status: ${fullyHealthy ? "HEALTHY & ACTIVE 🛡️" : "INCOMPLETE SETUP"}\n`);
}

// Auto-run if executed directly as script
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === "--uninstall" || arg === "uninstall") {
    runUninstall();
  } else if (arg === "--status" || arg === "status") {
    runStatus();
  } else {
    runInstall();
  }
}
