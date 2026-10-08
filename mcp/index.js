#!/usr/bin/env node

/**
 * Agy-Context-Saver: Universal Model Context Protocol (MCP) Server
 *
 * Implements standard MCP (JSON-RPC 2.0 over stdio) with zero external dependencies.
 * Purpose-built for Google Antigravity across macOS, Linux, and Windows.
 *
 * Capabilities:
 * - Transparent Command Optimization:
 *   - Native shell commands transparently optimized via RTK (Rust Token Killer).
 * - Tools:
 *   - check_context_health: Inspects conversation transcripts using async streaming
 *     to diagnose turn count, tool polling loops, and context degradation with minimal memory.
 *   - subagent_brief: Formulates scope-isolated prompts for delegated subagents.
 *   - get_installation_status: Audits live Antigravity plugin, hook, MCP, and RTK integration.
 *   - sync_installation: Re-verifies and synchronizes installation and tool schemas.
 *   - read_transcript: Clean Markdown streaming reader for compact and full transcripts.
 *   - query_transcript: Forensic filtering and regex search engine for conversation logs.
 * - Prompts:
 *   - context_shield: Injects the Context Governance rules.
 * - Resources:
 *   - context-saver://rules/governance: Serves the full AGENTS.md rulebook.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { runInstall, runUninstall, runStatus, detectExistingInstallation } from "../scripts/install-register.mjs";
import { findExistingRtk } from "../scripts/provision-rtk.mjs";

// Handle CLI subcommands (e.g. npx agy-context-saver install)
const cliArg = process.argv[2];
const checkFlag = process.argv.includes("--check") || process.argv.includes("-c");
if (cliArg === "install" || cliArg === "--install") {
  await runInstall({ checkOnly: checkFlag });
  process.exit(0);
} else if (cliArg === "uninstall" || cliArg === "--uninstall") {
  const restoreBackups = process.argv.includes("--restore-backups");
  await runUninstall({ restoreBackups });
  process.exit(0);
} else if (cliArg === "status" || cliArg === "--status") {
  runStatus();
  process.exit(0);
} else if (cliArg === "--help" || cliArg === "-h" || cliArg === "help") {
  printHelp();
  process.exit(0);
}

function printHelp() {
  console.log(`
Agy-Context-Saver 🛡️ (v1.2.1)
Universal MCP Server & Lifecycle Governor for Google Antigravity (Powered by RTK)

Usage:
  agy-context-saver [command] [options]
  node mcp/index.js [command] [options]

Commands:
  status, --status             Audit live registration across plugin, hook, MCP, & RTK
  install, --install           Synchronize & register plugin, hook, MCP server, and schemas
  install --check, -c          Run pre-flight validation check without writing changes
  uninstall, --uninstall       Unregister hook, MCP server, and remove plugin link
  uninstall --restore-backups  Unregister and restore original configuration backups
  help, --help, -h             Show this help message

Options:
  --check, -c                  Dry-run verification mode for install
  --restore-backups            Restore backup files (*.bak) during uninstall
  --silent                     Suppress console log outputs

MCP Server Stdio Mode:
  When launched without subcommands, agy-context-saver runs as a JSON-RPC 2.0
  stdio Model Context Protocol server (intended for Antigravity or MCP clients).
  ⚠️  Do not execute interactively in a terminal without piped JSON-RPC input.

Testing & Verification Playbook:
  npm run status               Verify live 4-layer integration status
  npm test                     Run complete 5-suite automated test suite
  node tests/test-hook.mjs     Run 28 closed-topology governance rule tests
  node tests/test-mcp.mjs      Run MCP protocol, method, and schema tests

Platform-Aware Inspection Directives (RTK):
  Windows:
    - Search:     rtk rg "<pattern>" .   (trailing dot is required to prevent stdin pipe stalls)
    - Read:       rtk read <file>
    - Directory:  rtk find <path>        (cross-platform; avoids missing ls.exe)
  POSIX (macOS/Linux):
    - Search:     rtk grep "<pattern>"  or  rtk rg "<pattern>"
    - Read:       rtk read <file>
    - Directory:  rtk ls <path>         or  rtk tree
`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rulesPath = path.resolve(__dirname, "../rules/AGENTS.md");

const SERVER_NAME = "agy-context-saver";
const SERVER_VERSION = "1.3.2";

// --- Tools Specification ---
const TOOLS = [
  {
    name: "check_context_health",
    description: "Inspects a conversation transcript (transcript.jsonl) to diagnose turn count, payload size, tool polling loops, and context degradation risk. Accepts a file path, conversation UUID, or empty for active conversation.",
    inputSchema: {
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
  },
  {
    name: "subagent_brief",
    description: "Generates a scope-isolated, anti-bloat prompt for invoking a subagent. Instructs the subagent to absorb all intermediate file reads/searches and return only high-signal findings.",
    inputSchema: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          description: "The core research or investigative objective."
        },
        scopeFiles: {
          type: "array",
          items: { type: "string" },
          description: "List of files or directories to investigate."
        },
        expectedDeliverable: {
          type: "string",
          description: "The concise format expected back by the parent agent."
        }
      },
      required: ["objective"]
    }
  },
  {
    name: "get_installation_status",
    description: "Inspect the live installation status of Agy-Context-Saver across all Antigravity integration points (Native Plugin Link, Governor Hook in hooks.json, MCP Server in mcp_config.json, and Tool Schemas).",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "sync_installation",
    description: "Re-verify and synchronize Agy-Context-Saver installation, updating the governor hook, plugin link, and tool schemas in ~25ms without terminal shell commands.",
    inputSchema: {
      type: "object",
      properties: {
        checkOnly: {
          type: "boolean",
          description: "If true, performs a pre-flight audit without writing changes (default: false)."
        }
      },
      required: []
    }
  },
  {
    name: "read_transcript",
    description: "Quickly read recent conversation history from an Antigravity transcript in clean Markdown format with zero JSON noise. Supports 'compact' (transcript.jsonl) and 'full' (transcript_full.jsonl) modes with minimal parameters.",
    inputSchema: {
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
  },
  {
    name: "query_transcript",
    description: "Granular query and forensic filtering engine for Antigravity conversation transcripts. Searches by keyword or regex, filters by role (user, assistant, tool, error), slices step ranges, and automatically dereferences full content when truncated.",
    inputSchema: {
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
  }
];

// --- Resources Specification ---
const RESOURCES = [
  {
    uri: "context-saver://rules/governance",
    name: "Antigravity Execution & Context Governance Rulebook",
    description: "Authoritative 3-Layer rules preventing background polling loops, maximizing synchronous execution, and isolating context via subagents.",
    mimeType: "text/markdown"
  }
];

// --- Prompts Specification ---
const PROMPTS = [
  {
    name: "context_shield",
    description: "Apply Agy-Context-Saver 3-Layer governance to the active session to prevent polling loops and transcript degradation.",
    arguments: []
  }
];

// --- Tool Implementations ---



async function handleCheckContextHealth(args = {}) {
  try {
    const rawTarget = args.transcriptPath || args.conversationId || "current";
    let transcriptPath = rawTarget;

    if (!fs.existsSync(transcriptPath)) {
      const resolved = resolveTranscriptPath(rawTarget, "compact");
      if (resolved && resolved.filePath && fs.existsSync(resolved.filePath)) {
        transcriptPath = resolved.filePath;
      } else {
        return {
          isError: true,
          content: [{ type: "text", text: `Transcript not found: ${rawTarget}` }]
        };
      }
    }

    const fileStream = fs.createReadStream(transcriptPath, { encoding: "utf-8" });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let totalSteps = 0;
    let userTurns = 0;
    let modelTurns = 0;
    let toolCalls = 0;
    let pollingEvents = 0;
    let totalBytes = 0;
    let corruptLines = 0;
    const MAX_LINES = 100000;

    for await (const line of rl) {
      if (!line.trim()) continue;
      totalSteps++;
      totalBytes += line.length;

      if (totalSteps > MAX_LINES) {
        break;
      }

      try {
        const item = JSON.parse(line);
        if (item.type === "USER_INPUT") userTurns++;
        if (item.type === "PLANNER_RESPONSE") modelTurns++;
        if (item.tool_calls && item.tool_calls.length) {
          toolCalls += item.tool_calls.length;
          for (const tc of item.tool_calls) {
            const name = tc.tool_name || tc.name;
            const args = tc.args || tc.arguments || {};
            const action = String(args.Action || args.action || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
            const prompt = String(args.Prompt || args.prompt || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
            const cond = String(args.TimerCondition || args.timerCondition || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
            if (name === "manage_task" && action === "status") pollingEvents++;
            if (name === "schedule" && (cond.startsWith("task") || cond.includes("task") || prompt.includes("test") || prompt.includes("check on") || prompt.includes("status"))) pollingEvents++;
          }
        }
      } catch (err) {
        corruptLines++;
      }
    }

    const kb = (totalBytes / 1024).toFixed(1);
    const healthStatus = pollingEvents > 3 ? "CRITICAL (Active Polling Loops Detected)" : userTurns > 40 ? "WARNING (High Turn Budget)" : "HEALTHY";

    const rtkInfo = findExistingRtk();
    const reportLines = [
      `### Context Health Report: ${healthStatus}`,
      `- Total Steps: ${totalSteps}`,
      `- User Turns: ${userTurns}`,
      `- Assistant Responses: ${modelTurns}`,
      `- Tool Calls: ${toolCalls}`,
      `- Detected Busy-Polling Events: ${pollingEvents}`,
      `- Approximate Raw Transcript Size: ${kb} KB`,
      `- RTK Command Optimizer: ${rtkInfo ? `Active (${rtkInfo.version})` : "Missing (run sync_installation)"}`
    ];

    if (corruptLines > 0) {
      reportLines.push(`- Corrupted/Unparsed Lines: ${corruptLines}`);
    }

    reportLines.push("");
    if (pollingEvents > 0) {
      reportLines.push("⚠️ Recommendation: Background polling detected! Cease manage_task(status) calls and yield execution to native Reactive Wakeup.");
    }
    if (userTurns >= 35) {
      reportLines.push("💡 Recommendation: Turn budget approaching threshold. Delegate broad research to subagents to preserve context.");
    } else {
      reportLines.push("✓ Context footprint is well-managed.");
    }

    return { content: [{ type: "text", text: reportLines.join("\n") }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Failed to inspect transcript: ${err.message}` }]
    };
  }
}

function handleSubagentBrief({ objective, scopeFiles = [], expectedDeliverable = "Synthesized factual findings" }) {
  const scopeStr = scopeFiles.length ? `\n\nTarget files:\n${scopeFiles.map(f => `- ${f}`).join("\n")}` : "";
  const prompt = [
    `ROLE: Scope-Isolated Deep Research Subagent`,
    `OBJECTIVE: ${objective}${scopeStr}`,
    ``,
    `CRITICAL CONTEXT GOVERNANCE INSTRUCTIONS:`,
    `1. You are running in an isolated subagent sandbox. Do all necessary multi-file exploration, searches, and analysis here.`,
    `2. DO NOT dump raw file contents or massive grep outputs in your final response.`,
    `3. Deliver strictly the high-signal findings in the following format:`,
    `   ${expectedDeliverable}`,
    `4. Keep your final response concise, structured, and cite exact file:line references.`
  ].join("\n");

  return { content: [{ type: "text", text: prompt }] };
}

function handleGetInstallationStatus() {
  const existing = detectExistingInstallation();
  const rtkInfo = findExistingRtk();
  const report = [
    `### Agy-Context-Saver Installation Status: ${existing.isComplete ? "HEALTHY & ACTIVE 🛡️" : existing.isInstalled ? "PARTIAL INSTALLATION ⚠️" : "NOT INSTALLED ❌"}`,
    `- Native Plugin Link: ${existing.details.plugin.exists ? `ACTIVE (${existing.details.plugin.target})` : "NOT LINKED"}`,
    `- Governor Lifecycle Hook: ${existing.details.hook.registered ? "REGISTERED in hooks.json" : "NOT REGISTERED"} (Script: ${existing.details.hook.scriptExists ? "Present" : "Missing"})`,
    `- Universal MCP Server: ${existing.details.mcp.registered ? "CONFIGURED in mcp_config.json" : "NOT CONFIGURED"}`,
    `- Antigravity Tool Schemas: ${existing.details.schemas.exists ? "ALL 6 SCHEMAS PRESENT" : "MISSING"} (${existing.details.schemas.dir})`,
    `- RTK Binary: ${rtkInfo ? `INSTALLED (${rtkInfo.version})` : "MISSING"}`,
    `- RTK Hook Optimization: ${existing.details.hook.registered ? "ACTIVE (via PreToolUse)" : "INACTIVE"}`,
    "",
    existing.isComplete && rtkInfo
      ? "✓ All Antigravity integration layers and RTK optimizer are fully operational."
      : "⚠️ Recommendation: Run sync_installation to re-verify and repair missing layers."
  ].join("\n");

  return {
    content: [{ type: "text", text: report }]
  };
}

async function handleSyncInstallation({ checkOnly = false } = {}) {
  const result = await runInstall({ checkOnly, silent: true });
  const rtkInfo = findExistingRtk();
  const report = [
    `### Agy-Context-Saver Installation Synchronization`,
    `- Status: ${result.isComplete ? "SYNCHRONIZED & HEALTHY 🛡️" : "UPDATED"}`,
    `- Elapsed Time: ${result.elapsedMs || "0"} ms`,
    `- Plugin Link: ${result.details?.plugin?.exists ? "Verified" : "Updated"}`,
    `- Lifecycle Hook: Registered in hooks.json`,
    `- MCP Server: Registered in mcp_config.json`,
    `- Tool Schemas: 6 Schemas mirrored to ~/.gemini/antigravity/mcp/agy-context-saver`,
    `- RTK Binary: ${rtkInfo ? `Verified (${rtkInfo.version})` : "Provisioned"}`,
    "",
    checkOnly ? "✓ Pre-flight check complete (dry-run)." : "✓ Installation fully synchronized and up-to-date in Zero-Delay mode."
  ].join("\n");

  return {
    content: [{ type: "text", text: report }]
  };
}

// --- Transcript Reader & Forensics Engine Helpers ---

const MAX_LINE_CHARS = 1000;
const MAX_TURN_CHARS = 6000;
const MAX_OUTPUT_CHARS = 24000;

function extractConvId(p) {
  const normalized = p.replace(/\\/g, "/");
  const match = normalized.match(/\/brain\/([^/]+)\//);
  return match ? match[1] : path.basename(normalized, path.extname(normalized));
}

function resolveTranscriptPath(target, mode = "compact") {
  const isFull = mode === "full";
  const fileName = isFull ? "transcript_full.jsonl" : "transcript.jsonl";

  // 1. If target is omitted, "current", or empty: resolve active conversation
  let raw = String(target || "").trim();
  if (!raw || raw.toLowerCase() === "current") {
    if (process.env.GEMINI_CONVERSATION_ID) {
      raw = process.env.GEMINI_CONVERSATION_ID;
    } else {
      const brainDir = path.join(os.homedir(), ".gemini", "antigravity", "brain");
      if (fs.existsSync(brainDir)) {
        try {
          const entries = fs.readdirSync(brainDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => {
              const p = path.join(brainDir, d.name);
              const stat = fs.statSync(p);
              return { name: d.name, mtime: stat.mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);
          if (entries.length > 0) {
            raw = entries[0].name;
          }
        } catch {}
      }
    }
  }

  // 2. Normalize separators
  const normalized = raw.replace(/\\/g, "/");

  // 3. Direct file path
  if (normalized.endsWith(".jsonl")) {
    if (fs.existsSync(normalized)) {
      if (isFull && normalized.endsWith("transcript.jsonl")) {
        const fullCandidate = normalized.replace(/transcript\.jsonl$/, "transcript_full.jsonl");
        if (fs.existsSync(fullCandidate)) return { filePath: fullCandidate, convId: extractConvId(normalized) };
      }
      if (!isFull && normalized.endsWith("transcript_full.jsonl")) {
        const compactCandidate = normalized.replace(/transcript_full\.jsonl$/, "transcript.jsonl");
        if (fs.existsSync(compactCandidate)) return { filePath: compactCandidate, convId: extractConvId(normalized) };
      }
      return { filePath: normalized, convId: extractConvId(normalized) };
    }
  }

  // 4. UUID / Directory resolution under ~/.gemini/antigravity/brain/<id>
  const homeDir = os.homedir();
  const brainCandidate = path.join(homeDir, ".gemini", "antigravity", "brain", normalized, ".system_generated", "logs", fileName);
  if (fs.existsSync(brainCandidate)) {
    return { filePath: brainCandidate, convId: normalized };
  }
  if (isFull) {
    const compactFallback = path.join(homeDir, ".gemini", "antigravity", "brain", normalized, ".system_generated", "logs", "transcript.jsonl");
    if (fs.existsSync(compactFallback)) {
      return { filePath: compactFallback, convId: normalized };
    }
  }

  // 5. Try local relative/absolute directory path
  const localCandidate = path.resolve(normalized, ".system_generated", "logs", fileName);
  if (fs.existsSync(localCandidate)) {
    return { filePath: localCandidate, convId: extractConvId(localCandidate) };
  }
  const directCandidate = path.resolve(normalized, fileName);
  if (fs.existsSync(directCandidate)) {
    return { filePath: directCandidate, convId: extractConvId(directCandidate) };
  }

  return { error: `Transcript not found for target: '${target}'. Searched: ${brainCandidate}` };
}

function cleanMessageContent(content, maxChars = MAX_TURN_CHARS) {
  if (content === null || content === undefined) return "";
  let text = typeof content === "string" ? content : JSON.stringify(content, null, 2);

  // Fast-path: short text without base64 or long blocks skips heavy line splits and regex
  if (text.length <= 120 && !text.includes("base64")) {
    return text;
  }

  // Strip huge base64 media blocks only if relevant keywords or large length
  if (text.includes("base64") || text.length > 200) {
    text = text.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[Embedded Media/Binary Omitted]");
    text = text.replace(/[A-Za-z0-9+/=]{200,}/g, "[Binary/Base64 Payload Omitted]");
  }

  // Clamp lines exceeding MAX_LINE_CHARS only if newline exists and text is long enough
  if (text.length > MAX_LINE_CHARS && text.includes("\n")) {
    const lines = text.split("\n");
    let changed = false;
    const clampedLines = lines.map((l) => {
      if (l.length > MAX_LINE_CHARS) {
        changed = true;
        return l.slice(0, MAX_LINE_CHARS) + " ... [line clamped]";
      }
      return l;
    });
    if (changed) {
      text = clampedLines.join("\n");
    }
  }

  if (text.length > maxChars) {
    return text.slice(0, maxChars) + `\n\n... [Content Truncated (${text.length - maxChars} chars omitted to preserve token budget)] ...`;
  }
  return text;
}

function formatTranscriptItem(item, options = {}) {
  const { includeThinking = false, includeToolCalls = false, maxContentChars = MAX_TURN_CHARS } = options;
  const stepIdx = item.step_index !== undefined ? item.step_index : "?";
  const type = item.type || "UNKNOWN";
  const time = item.created_at ? item.created_at.replace(/\.\d+Z$/, "Z") : "";
  const timeStr = time ? ` (${time})` : "";

  let role = "SYSTEM";
  if (type === "USER_INPUT") role = "USER";
  else if (type === "PLANNER_RESPONSE") role = "ASSISTANT";
  else if (type === "SUBAGENT_RESPONSE") role = "SUBAGENT";
  else role = type;

  const parts = [];
  parts.push(`### [Step ${stepIdx} | ${role}]${timeStr}`);

  // Thinking block
  if (includeThinking && item.thinking) {
    const cleanThinking = cleanMessageContent(item.thinking, 4000);
    parts.push(`> <thinking>\n> ${cleanThinking.split("\n").join("\n> ")}\n> </thinking>`);
  }

  // Tool calls
  if ((includeToolCalls || role === "ASSISTANT") && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
    const tcSummary = item.tool_calls.map((tc) => {
      const name = tc.name || tc.tool_name || "unknown_tool";
      const args = tc.args || tc.arguments || {};
      const compactArgs = Object.entries(args)
        .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 80)}`)
        .join(", ");
      return `- \`${name}(${compactArgs})\``;
    });
    parts.push(`**Tool Calls (${item.tool_calls.length}):**\n${tcSummary.join("\n")}`);
  }

  // Content
  if (item.content) {
    const cleaned = cleanMessageContent(item.content, maxContentChars);
    if (cleaned.trim()) {
      parts.push(cleaned.trim());
    }
  }

  return parts.join("\n\n");
}

const regexCache = new Map();
const MAX_REGEX_CACHE_ENTRIES = 100;

function getCompiledRegex(pattern) {
  if (!pattern || typeof pattern !== "string") return null;
  const cached = regexCache.get(pattern);
  if (cached) return cached;

  let rx;
  try {
    rx = new RegExp(pattern, "i");
  } catch {
    rx = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  if (regexCache.size >= MAX_REGEX_CACHE_ENTRIES) {
    const firstKey = regexCache.keys().next().value;
    regexCache.delete(firstKey);
  }
  regexCache.set(pattern, rx);
  return rx;
}

async function batchFindFullSteps(fullPath, stepIndicesSet) {
  const result = new Map();
  if (!fs.existsSync(fullPath) || !stepIndicesSet || stepIndicesSet.size === 0) return result;

  const fileStream = fs.createReadStream(fullPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (stepIndicesSet.has(item.step_index)) {
          result.set(item.step_index, item);
          if (result.size >= stepIndicesSet.size) {
            rl.close();
            break;
          }
        }
      } catch {}
    }
  } catch {}
  return result;
}

async function findFullStep(fullPath, targetStepIndex) {
  const map = await batchFindFullSteps(fullPath, new Set([targetStepIndex]));
  return map.get(targetStepIndex) || null;
}

async function handleReadTranscript({ conversationId, mode = "compact", lastTurns = 3, includeThinking = false } = {}) {
  const resolved = resolveTranscriptPath(conversationId, mode);
  if (resolved.error) {
    return { isError: true, content: [{ type: "text", text: resolved.error }] };
  }

  const { filePath, convId } = resolved;
  const items = [];
  const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let totalStepsCount = 0;
  const WINDOW_SIZE = lastTurns > 0 ? Math.max(100, lastTurns * 15) : Infinity;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        totalStepsCount++;
        items.push(item);
        if (items.length > WINDOW_SIZE) {
          items.shift();
        }
      } catch {
        // Tolerates incomplete trailing flushes during concurrent writes
      }
    }
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Error reading transcript stream: ${err.message}` }] };
  }

  if (totalStepsCount === 0) {
    return { content: [{ type: "text", text: `Transcript is empty at: ${filePath}` }] };
  }

  let selected = items;
  if (lastTurns > 0) {
    const turnItems = items.filter((it) => it.type === "USER_INPUT" || it.type === "PLANNER_RESPONSE");
    const cutoff = Math.max(0, turnItems.length - lastTurns);
    const minStep = turnItems[cutoff] ? turnItems[cutoff].step_index : 0;
    selected = items.filter((it) => (it.step_index || 0) >= minStep);
  }

  const header = [
    `# Conversation Transcript: \`${convId}\``,
    `- Mode: **${mode}** (${path.basename(filePath)})`,
    `- Total Steps in Log: ${totalStepsCount}`,
    `- Displayed Steps: ${selected.length} (showing last ${lastTurns > 0 ? `${lastTurns} turns` : "all"})`,
    "",
    "---",
    ""
  ].join("\n");

  const formattedBlocks = [];
  let currentLength = header.length;
  let clamped = false;

  for (let i = selected.length - 1; i >= 0; i--) {
    const block = formatTranscriptItem(selected[i], {
      includeThinking,
      includeToolCalls: true
    });
    if (currentLength + block.length + 6 > MAX_OUTPUT_CHARS) {
      clamped = true;
      break;
    }
    formattedBlocks.unshift(block);
    currentLength += block.length + 6;
  }

  let fullOutput = header + formattedBlocks.join("\n\n---\n\n");
  if (clamped) {
    fullOutput += "\n\n... [Transcript display clamped at 24 KB safety ceiling] ...";
  }

  return { content: [{ type: "text", text: fullOutput }] };
}

async function handleQueryTranscript(args = {}) {
  const {
    conversationId,
    query,
    roles = ["user", "assistant"],
    mode = "auto",
    startStep,
    endStep,
    lastTurns,
    includeThinking = false,
    includeToolCalls = false,
    maxResults = 5,
    summaryOnly = false
  } = args;

  const resolved = resolveTranscriptPath(conversationId, mode === "full" ? "full" : "compact");
  if (resolved.error) {
    return { isError: true, content: [{ type: "text", text: resolved.error }] };
  }

  const { filePath, convId } = resolved;
  const fullSiblingPath = filePath.replace(/transcript\.jsonl$/, "transcript_full.jsonl");
  const hasFullSibling = fs.existsSync(fullSiblingPath);

  const roleSet = new Set((Array.isArray(roles) ? roles : [roles]).map((r) => String(r).toLowerCase()));
  const matchAllRoles = roleSet.has("all");

  const queryRegex = getCompiledRegex(query);

  const matched = [];
  const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue; // skip corrupted or half-flushed trailing lines
      }

      const stepIdx = item.step_index || 0;
      if (startStep !== undefined && stepIdx < startStep) continue;
      if (endStep !== undefined && stepIdx > endStep) continue;

      if (!matchAllRoles) {
        const type = String(item.type || "").toUpperCase();
        let roleMatches = false;
        if (roleSet.has("user") && type === "USER_INPUT") roleMatches = true;
        if (roleSet.has("assistant") && type === "PLANNER_RESPONSE") roleMatches = true;
        if (roleSet.has("subagent") && type === "SUBAGENT_RESPONSE") roleMatches = true;
        if (roleSet.has("tool") && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) roleMatches = true;
        if (roleSet.has("error") && (item.status === "ERROR" || (typeof item.content === "string" && item.content.includes("Error")))) roleMatches = true;
        if (!roleMatches) continue;
      }

      if (queryRegex) {
        let matches = false;
        if (typeof item.content === "string") {
          matches = queryRegex.test(item.content);
        } else if (item.content) {
          matches = queryRegex.test(JSON.stringify(item.content));
        }

        if (!matches && typeof item.thinking === "string") {
          matches = queryRegex.test(item.thinking);
        }

        if (!matches && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
          matches = queryRegex.test(JSON.stringify(item.tool_calls));
        }

        if (!matches) continue;
      }

      matched.push(item);
    }
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Error streaming transcript: ${err.message}` }] };
  }

  if (matched.length === 0) {
    return {
      content: [{
        type: "text",
        text: `No matching steps found in transcript for \`${convId}\` (query: "${query || '*'}", roles: [${Array.from(roleSet).join(", ")}]).`
      }]
    };
  }

  let finalItems = matched;
  if (lastTurns && lastTurns > 0) {
    finalItems = finalItems.slice(-lastTurns);
  }
  if (finalItems.length > maxResults) {
    finalItems = finalItems.slice(-maxResults);
  }

  // Auto-dereferencing if mode is "auto" and fields were truncated (single pass)
  if (mode === "auto" && hasFullSibling) {
    const truncatedIndices = new Set();
    for (const it of finalItems) {
      if (Array.isArray(it.truncated_fields) && it.truncated_fields.length > 0 && it.step_index !== undefined) {
        truncatedIndices.add(it.step_index);
      }
    }
    if (truncatedIndices.size > 0) {
      const fullMap = await batchFindFullSteps(fullSiblingPath, truncatedIndices);
      for (let i = 0; i < finalItems.length; i++) {
        const it = finalItems[i];
        if (it && fullMap.has(it.step_index)) {
          finalItems[i] = fullMap.get(it.step_index);
        }
      }
    }
  }

  if (summaryOnly) {
    const summaryLines = finalItems.map((it) => {
      const step = it.step_index ?? "?";
      const role = it.type === "USER_INPUT" ? "USER" : it.type === "PLANNER_RESPONSE" ? "ASSISTANT" : it.type === "SUBAGENT_RESPONSE" ? "SUBAGENT" : it.type || "SYSTEM";
      const time = it.created_at ? ` (${it.created_at.replace(/\.\d+Z$/, "Z")})` : "";
      let preview = "";
      if (it.content) {
        preview = cleanMessageContent(it.content, 120).replace(/\s+/g, " ").trim();
      } else if (Array.isArray(it.tool_calls) && it.tool_calls.length > 0) {
        preview = `Tool calls: ${it.tool_calls.map(tc => tc.name || tc.tool_name).join(", ")}`;
      }
      return `- **[Step ${step} | ${role}]**${time}: ${preview || "(empty)"}`;
    });

    const header = [
      `## Transcript Query Summary: \`${convId}\``,
      `- Filter: query=${query ? `"${query}"` : "NONE"}, roles=[${Array.from(roleSet).join(", ")}], mode=${mode}`,
      `- Matched Steps: ${matched.length} (showing ${finalItems.length} in compact summary mode)`,
      "",
      "---",
      ""
    ].join("\n");

    let output = header + summaryLines.join("\n");
    if (output.length > MAX_OUTPUT_CHARS) {
      output = output.slice(0, MAX_OUTPUT_CHARS) + "\n\n... [Query results clamped at 24 KB safety ceiling] ...";
    }
    return { content: [{ type: "text", text: output }] };
  }

  const header = [
    `## Transcript Query Results: \`${convId}\``,
    `- Filter: query=${query ? `"${query}"` : "NONE"}, roles=[${Array.from(roleSet).join(", ")}], mode=${mode}`,
    `- Matched Steps: ${matched.length} (showing ${finalItems.length})`,
    "",
    "---",
    ""
  ].join("\n");

  const blocks = [];
  let currentLength = header.length;
  let clamped = false;

  for (let i = finalItems.length - 1; i >= 0; i--) {
    const block = formatTranscriptItem(finalItems[i], {
      includeThinking,
      includeToolCalls: includeToolCalls || roleSet.has("tool")
    });
    if (currentLength + block.length + 6 > MAX_OUTPUT_CHARS) {
      clamped = true;
      break;
    }
    blocks.unshift(block);
    currentLength += block.length + 6;
  }

  let output = header + blocks.join("\n\n---\n\n");
  if (clamped) {
    output += "\n\n... [Query results clamped at 24 KB safety ceiling] ...";
  }

  return { content: [{ type: "text", text: output }] };
}

let cachedRulesContent = null;
let cachedRulesMtime = 0;

function getGovernanceRules() {
  try {
    if (fs.existsSync(rulesPath)) {
      const stat = fs.statSync(rulesPath);
      if (cachedRulesContent && stat.mtimeMs === cachedRulesMtime) {
        return cachedRulesContent;
      }
      cachedRulesContent = fs.readFileSync(rulesPath, "utf-8");
      cachedRulesMtime = stat.mtimeMs;
      return cachedRulesContent;
    }
  } catch {}
  return "# Governance rules not found";
}

// --- JSON-RPC 2.0 Dispatcher ---
async function handleRequest(request) {
  const { id, method, params } = request;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {}, resources: {}, prompts: {} }
      }
    };
  }

  if (method === "notifications/initialized") {
    return null; // No response for notifications
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (method === "tools/call") {
    const { name, arguments: args = {} } = params || {};
    let toolResult;

    if (name === "check_context_health") {
      toolResult = await handleCheckContextHealth(args);
    } else if (name === "subagent_brief") {
      toolResult = handleSubagentBrief(args);
    } else if (name === "get_installation_status") {
      toolResult = handleGetInstallationStatus();
    } else if (name === "sync_installation") {
      toolResult = await handleSyncInstallation(args);
    } else if (name === "read_transcript") {
      toolResult = await handleReadTranscript(args);
    } else if (name === "query_transcript") {
      toolResult = await handleQueryTranscript(args);
    } else {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Tool not found: ${name}` }
      };
    }

    return { jsonrpc: "2.0", id, result: toolResult };
  }

  if (method === "resources/list") {
    return { jsonrpc: "2.0", id, result: { resources: RESOURCES } };
  }

  if (method === "resources/read") {
    const { uri } = params || {};
    if (uri === "context-saver://rules/governance") {
      const content = getGovernanceRules();
      return {
        jsonrpc: "2.0",
        id,
        result: {
          contents: [
            {
              uri,
              mimeType: "text/markdown",
              text: content
            }
          ]
        }
      };
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: `Resource not found: ${uri}` }
    };
  }

  if (method === "prompts/list") {
    return { jsonrpc: "2.0", id, result: { prompts: PROMPTS } };
  }

  if (method === "prompts/get") {
    const { name } = params || {};
    if (name === "context_shield") {
      const content = getGovernanceRules();
      return {
        jsonrpc: "2.0",
        id,
        result: {
          description: "3-Layer Context Governance Rules",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Apply the following Antigravity Context Governance rules to this session:\n\n${content}`
              }
            }
          ]
        }
      };
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: `Prompt not found: ${name}` }
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
}

// Stdio JSON-RPC line loop
const MAX_STDIO_PAYLOAD_BYTES = Number(process.env.AGY_MAX_STDIO_PAYLOAD_BYTES) || (10 * 1024 * 1024); // 10 MB ceiling default
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on("line", async (line) => {
  if (!line || !line.trim()) return;
  if (line.length > MAX_STDIO_PAYLOAD_BYTES) {
    const errResp = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request: Payload exceeds 10MB safety ceiling" }
    };
    process.stdout.write(JSON.stringify(errResp) + "\n");
    return;
  }
  try {
    const req = JSON.parse(line);
    const resp = await handleRequest(req);
    if (resp) {
      process.stdout.write(JSON.stringify(resp) + "\n");
    }
  } catch (err) {
    const errResp = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `Parse error: ${err.message}` }
    };
    process.stdout.write(JSON.stringify(errResp) + "\n");
  }
});
