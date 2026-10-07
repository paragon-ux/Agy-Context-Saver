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
import { ensureRtkInstalled, findExistingRtk } from "./provision-rtk.mjs";

const fsPromises = fs.promises;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const homeDir = os.homedir();
const geminiConfigDir = path.join(homeDir, ".gemini", "config");
const pluginsDir = path.join(geminiConfigDir, "plugins");
const pluginDest = path.join(pluginsDir, "agy-context-saver");
const scriptsDir = path.join(geminiConfigDir, "scripts");
const hooksJsonPath = path.join(geminiConfigDir, "hooks.json");
const hooksBakPath = path.join(geminiConfigDir, "hooks.json.bak");
const mcpJsonPath = path.join(geminiConfigDir, "mcp_config.json");
const mcpBakPath = path.join(geminiConfigDir, "mcp_config.json.bak");
const antigravityMcpDir = path.join(homeDir, ".gemini", "antigravity", "mcp", "agy-context-saver");

const sourceHook = path.join(repoRoot, "scripts", "execution-guard-hook.mjs");
const destHook = path.join(scriptsDir, "execution-guard-hook.mjs");
const mcpIndexPath = path.join(pluginDest, "mcp", "index.js").replace(/\\/g, "/");
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
    fs.existsSync(path.join(antigravityMcpDir, "check_context_health.json")) &&
    fs.existsSync(path.join(antigravityMcpDir, "subagent_brief.json")) &&
    fs.existsSync(path.join(antigravityMcpDir, "get_installation_status.json")) &&
    fs.existsSync(path.join(antigravityMcpDir, "sync_installation.json")) &&
    fs.existsSync(path.join(antigravityMcpDir, "read_transcript.json")) &&
    fs.existsSync(path.join(antigravityMcpDir, "query_transcript.json"));

  const rtkInfo = findExistingRtk();
  const isInstalled = pluginExists || (hookRegistered && mcpRegistered);
  const isComplete = (pluginExists || (hookRegistered && mcpRegistered && scriptExists)) && schemasExist && Boolean(rtkInfo);

  return {
    isInstalled,
    isComplete,
    details: {
      plugin: { exists: pluginExists, target: pluginTarget },
      hook: { registered: hookRegistered, command: hookCommand, scriptExists },
      mcp: { registered: mcpRegistered, args: mcpArgs },
      schemas: { exists: schemasExist, dir: antigravityMcpDir },
      rtk: rtkInfo
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

  // 0. Pre-flight Validation: Verify configuration directory write access
  try {
    await fsPromises.mkdir(geminiConfigDir, { recursive: true });
    const probeFile = path.join(geminiConfigDir, `.preflight-${process.pid}.tmp`);
    await fsPromises.writeFile(probeFile, "ok", "utf-8");
    await fsPromises.unlink(probeFile);
  } catch (err) {
    throw new Error(`Pre-flight check failed: cannot write to Antigravity configuration directory (${geminiConfigDir}): ${err.message}`);
  }

  // 0a. Ensure RTK is provisioned and available
  try {
    const rtkResult = await ensureRtkInstalled({ silent: options.silent });
    log(`[OK] RTK Command Optimizer verified: ${rtkResult.version} (${rtkResult.path})`);
  } catch (err) {
    warn(`[WARN] RTK provisioning check encountered an issue: ${err.message}`);
  }

  // 1. Instant Native Plugin Junction / Symlink or Permanent Copy (Takes ~5ms)
  await fsPromises.mkdir(pluginsDir, { recursive: true });
  const isGitRepo = fs.existsSync(path.join(repoRoot, ".git"));
  const isTempOrNpx = !isGitRepo || repoRoot.includes("_npx") || repoRoot.includes("npm-cache") || repoRoot.includes("node_modules");

  if (!fs.existsSync(pluginDest)) {
    if (isTempOrNpx) {
      await fsPromises.cp(repoRoot, pluginDest, { recursive: true });
      log(`[OK] Native Antigravity Plugin installed to: ${pluginDest}`);
    } else {
      try {
        const isWin = os.platform() === "win32";
        fs.symlinkSync(repoRoot, pluginDest, isWin ? "junction" : "dir");
        log(`[OK] Native Antigravity Plugin linked: ${pluginDest} -> ${repoRoot}`);
      } catch (err) {
        await fsPromises.cp(repoRoot, pluginDest, { recursive: true });
        log(`[OK] Native Antigravity Plugin copied to: ${pluginDest}`);
      }
    }
  } else {
    if (isTempOrNpx) {
      try {
        await fsPromises.cp(repoRoot, pluginDest, { recursive: true });
      } catch {}
    }
    log(`[OK] Native Antigravity Plugin verified: ${pluginDest}`);
  }

  // 2. Ensure scripts dir exists & copy hook script asynchronously
  await fsPromises.mkdir(scriptsDir, { recursive: true });
  await fsPromises.copyFile(sourceHook, destHook);
  log(`[OK] Governor hook script mirrored to: ${destHook}`);

  // 3. Register Hook in ~/.gemini/config/hooks.json (Preserves existing hooks + creates backup)
  let hooksConfig = {};
  if (fs.existsSync(hooksJsonPath)) {
    try {
      hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
      // Create backup if none exists
      if (!fs.existsSync(hooksBakPath)) {
        await fsPromises.copyFile(hooksJsonPath, hooksBakPath);
        log(`[OK] Created configuration backup: ${hooksBakPath}`);
      }
    } catch (err) {
      hooksConfig = {};
    }
  }

  const alreadyHadHook = Boolean(hooksConfig["execution-guard"]);
  hooksConfig["execution-guard"] = {
    PreToolUse: [
      {
        matcher: "manage_task|schedule|run_command|view_file|read_file|read_many_files|grep_search|find_by_name|list_dir",
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

  // 4. Register MCP Server in ~/.gemini/config/mcp_config.json (Preserves existing servers + creates backup)
  let mcpConfig = { mcpServers: {} };
  if (fs.existsSync(mcpJsonPath)) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      // Create backup if none exists
      if (!fs.existsSync(mcpBakPath)) {
        await fsPromises.copyFile(mcpJsonPath, mcpBakPath);
        log(`[OK] Created configuration backup: ${mcpBakPath}`);
      }
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

  // Clean up legacy safe_command schema if present
  const legacySafeCommandPath = path.join(antigravityMcpDir, "safe_command.json");
  if (fs.existsSync(legacySafeCommandPath)) {
    try {
      await fsPromises.unlink(legacySafeCommandPath);
      log(`[OK] Cleaned up legacy safe_command schema from: ${legacySafeCommandPath}`);
    } catch {}
  }

  const instructionsContent = `# Agy-Context-Saver MCP Server Instructions

## Overview
Agy-Context-Saver is the universal Model Context Protocol server and lifecycle governor for Google Antigravity, paired with RTK (Rust Token Killer) for transparent CLI output reduction.

## Core Rules for Antigravity Agents
1. **Reactive Wakeup (Zero Task Polling)**:
   - When background tasks run, DO NOT call \`manage_task(Action='status')\` or \`schedule\` polling timers.
   - Stop calling tools and yield the turn. The system notifies you automatically via \`<SYSTEM_MESSAGE>\`.
   - Repeated polling triggers an escalating circuit breaker (frozen at 5 denials).
2. **Never Read Internal State Directly**:
   - Access to \`.system_generated/\` via \`view_file\` is strictly denied to prevent transcript explosion.
   - Use \`read_transcript\` or \`query_transcript\` to inspect conversation history cleanly.
3. **Platform-Aware Codebase Inspection**:
   - **Windows**: Use \`rtk read <file>\`, \`rtk find <path>\`, and \`rtk rg "<pattern>" .\` (the trailing \`.\` is required to avoid stdin stalls).
   - **POSIX**: Use \`rtk read <file>\`, \`rtk ls <path>\`, and \`rtk grep "<pattern>"\` or \`rtk rg "<pattern>"\`.

## Available MCP Tools
- \`check_context_health\`: Diagnoses transcript turn counts, byte payload, and polling loops. Accepts \`transcriptPath\` or \`conversationId\`.
- \`subagent_brief\`: Generates scope-isolated instructions for delegated subagents to prevent parent context bloat.
- \`read_transcript\`: Streams recent turns from \`transcript.jsonl\` or \`transcript_full.jsonl\` formatted as clean Markdown.
- \`query_transcript\`: Forensic regex search and filtering engine across transcript steps with optional \`summaryOnly: true\`.
- \`get_installation_status\`: Audits live health of the plugin link, hook, MCP server, tool schemas, and RTK.
- \`sync_installation\`: Synchronizes and repairs all 4 integration layers in ~25ms.

## Diagnostic & CLI Playbook
- Audit Status: \`npm run status\` or \`node mcp/index.js status\`
- Run Test Suite: \`npm test\`
- CLI Help: \`node mcp/index.js --help\`
- ⚠️ Warning: Do not run \`npm start\` or \`node mcp/index.js\` without subcommands interactively (it is a stdio JSON-RPC server).
`;

  const checkHealthSchema = {
    name: "check_context_health",
    description: "Inspects a conversation transcript (transcript.jsonl) to diagnose turn count, payload size, tool polling loops, and context degradation risk. Accepts full file path, conversation UUID, or empty for active session.",
    parameters: {
      type: "object",
      properties: {
        transcriptPath: {
          type: "string",
          description: "Path to transcript.jsonl file, conversation UUID, or empty for active conversation."
        },
        conversationId: {
          type: "string",
          description: "Conversation UUID or folder name (alternative to transcriptPath)."
        }
      }
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

  const readTranscriptSchema = {
    name: "read_transcript",
    description: "Quickly read recent conversation history from an Antigravity transcript in clean Markdown format with zero JSON noise. Supports 'compact' (transcript.jsonl) and 'full' (transcript_full.jsonl) modes with minimal parameters.",
    parameters: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "Conversation ID (UUID), folder name, or full path to transcript.jsonl. If omitted, defaults to active conversation."
        },
        mode: {
          type: "string",
          enum: ["compact", "full"],
          description: "Transcript mode: 'compact' reads transcript.jsonl; 'full' reads transcript_full.jsonl (default: 'compact')."
        },
        lastTurns: {
          type: "number",
          description: "Number of most recent conversation turns to display (default: 3). Set to 0 to read all."
        },
        includeThinking: {
          type: "boolean",
          description: "Whether to include model thinking / internal reasoning blocks (default: false)."
        }
      },
      required: ["conversationId"]
    }
  };

  const queryTranscriptSchema = {
    name: "query_transcript",
    description: "Granular query and forensic filtering engine for Antigravity conversation transcripts. Searches by keyword or regex, filters by role (user, assistant, tool, error), slices step ranges, and automatically dereferences full content when truncated.",
    parameters: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "Conversation ID (UUID), folder name, or full path to transcript.jsonl."
        },
        query: {
          type: "string",
          description: "Search keyword or regex pattern to match across message content, tool calls, and thinking."
        },
        roles: {
          type: "array",
          items: { type: "string" },
          description: "Filter steps by role/source: 'user', 'assistant', 'tool', 'error', or 'all' (default: ['user', 'assistant'])."
        },
        mode: {
          type: "string",
          enum: ["auto", "compact", "full"],
          description: "Mode: 'auto' streams transcript.jsonl and dereferences matched truncated lines from transcript_full.jsonl; 'compact' reads transcript.jsonl only; 'full' reads transcript_full.jsonl only (default: 'auto')."
        },
        startStep: {
          type: "number",
          description: "Start step_index (inclusive)."
        },
        endStep: {
          type: "number",
          description: "End step_index (inclusive)."
        },
        lastTurns: {
          type: "number",
          description: "Limit to last N matched turns."
        },
        includeThinking: {
          type: "boolean",
          description: "Include model thinking blocks in output (default: false)."
        },
        includeToolCalls: {
          type: "boolean",
          description: "Include tool call arguments and results in output (default: false)."
        },
        maxResults: {
          type: "number",
          description: "Maximum number of matched steps to return (default: 5)."
        },
        summaryOnly: {
          type: "boolean",
          description: "If true, returns high-density 1-line step summaries instead of full message blocks to minimize UI card height (default: false)."
        }
      },
      required: ["conversationId"]
    }
  };

  await Promise.all([
    fsPromises.writeFile(path.join(antigravityMcpDir, "instructions.md"), instructionsContent, "utf-8"),
    fsPromises.writeFile(path.join(antigravityMcpDir, "check_context_health.json"), JSON.stringify(checkHealthSchema, null, 2), "utf-8"),
    fsPromises.writeFile(path.join(antigravityMcpDir, "subagent_brief.json"), JSON.stringify(subagentBriefSchema, null, 2), "utf-8"),
    fsPromises.writeFile(path.join(antigravityMcpDir, "get_installation_status.json"), JSON.stringify(getInstallationStatusSchema, null, 2), "utf-8"),
    fsPromises.writeFile(path.join(antigravityMcpDir, "sync_installation.json"), JSON.stringify(syncInstallationSchema, null, 2), "utf-8"),
    fsPromises.writeFile(path.join(antigravityMcpDir, "read_transcript.json"), JSON.stringify(readTranscriptSchema, null, 2), "utf-8"),
    fsPromises.writeFile(path.join(antigravityMcpDir, "query_transcript.json"), JSON.stringify(queryTranscriptSchema, null, 2), "utf-8")
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

  // 2. Remove mirrored hook script
  if (fs.existsSync(destHook)) {
    try {
      await fsPromises.unlink(destHook);
      log(`[OK] Removed mirrored hook script: ${destHook}`);
    } catch (err) {
      warn(`[WARN] Could not remove mirrored hook script: ${err.message}`);
    }
  }

  // 3. Remove from hooks.json
  if (fs.existsSync(hooksJsonPath)) {
    try {
      const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
      delete hooksConfig["execution-guard"];
      delete hooksConfig["agy-context-saver"];
      await fsPromises.writeFile(hooksJsonPath, JSON.stringify(hooksConfig, null, 2), "utf-8");
      log(`[OK] Removed from: ${hooksJsonPath}`);
    } catch {}
  }

  // 4. Remove from mcp_config.json
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

  // 5. Remove mirrored Antigravity MCP schemas directory
  if (fs.existsSync(antigravityMcpDir)) {
    try {
      await fsPromises.rm(antigravityMcpDir, { recursive: true, force: true });
      log(`[OK] Removed mirrored MCP schema directory: ${antigravityMcpDir}`);
    } catch (err) {
      warn(`[WARN] Could not remove schema directory: ${err.message}`);
    }
  }

  // 6. Optional: Restore configuration files from backups if requested
  if (options.restoreBackups) {
    if (fs.existsSync(hooksBakPath)) {
      try {
        await fsPromises.copyFile(hooksBakPath, hooksJsonPath);
        log(`[OK] Restored hooks.json from backup: ${hooksBakPath}`);
      } catch (err) {
        warn(`[WARN] Could not restore hooks backup: ${err.message}`);
      }
    }
    if (fs.existsSync(mcpBakPath)) {
      try {
        await fsPromises.copyFile(mcpBakPath, mcpJsonPath);
        log(`[OK] Restored mcp_config.json from backup: ${mcpBakPath}`);
      } catch (err) {
        warn(`[WARN] Could not restore mcp backup: ${err.message}`);
      }
    }
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
  log(`- Antigravity Tool Schemas: ${existing.details.schemas.exists ? "PRESENT (6 Schemas)" : "MISSING"}`);
  log(`- RTK Command Optimizer: ${existing.details.rtk ? "INSTALLED (" + existing.details.rtk.version + ")" : "MISSING"}`);

  log(`\nOverall Status: ${existing.isComplete ? "HEALTHY & ACTIVE 🛡️" : existing.isInstalled ? "PARTIAL INSTALLATION" : "NOT INSTALLED"}\n`);
  return existing;
}

export {
  pluginDest,
  destHook,
  hooksJsonPath,
  hooksBakPath,
  mcpJsonPath,
  mcpBakPath,
  antigravityMcpDir
};

function printCliHelp() {
  console.log(`
Agy-Context-Saver Registration & Lifecycle Engine

Usage:
  node scripts/install-register.mjs [command/option]

Commands & Options:
  --status, status             Check live integration status across all layers + RTK
  --check, -c                  Run pre-flight validation check without writing changes
  --uninstall, uninstall       Remove governor hook, plugin link, and MCP server
  --restore-backups            Restore original configuration backup files (*.bak) during uninstall
  --help, -h, help             Show this help message
  (no arguments)               Synchronize and verify full 4-layer installation
`);
}

// Auto-run if executed directly as script
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === "--help" || arg === "-h" || arg === "help") {
    printCliHelp();
    process.exit(0);
  } else if (arg === "--uninstall" || arg === "uninstall") {
    const restoreBackups = process.argv.includes("--restore-backups");
    await runUninstall({ restoreBackups });
  } else if (arg === "--status" || arg === "status") {
    runStatus();
  } else if (arg === "--check" || arg === "-c") {
    await runInstall({ checkOnly: true });
  } else {
    await runInstall();
  }
}
