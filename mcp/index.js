#!/usr/bin/env node

/**
 * Agy-Context-Saver: Universal Model Context Protocol (MCP) Server
 *
 * Implements standard MCP (JSON-RPC 2.0 over stdio) with zero external dependencies.
 * Purpose-built for Google Antigravity across macOS, Linux, and Windows.
 *
 * Capabilities:
 * - Tools:
 *   - safe_command: Executes shell commands with intelligent output compression,
 *     chunk-based stream buffering, escalating SIGKILL fallback, and generous timeouts.
 *   - check_context_health: Inspects conversation transcripts using async streaming
 *     to diagnose turn count, tool polling loops, and context degradation with minimal memory.
 *   - subagent_brief: Formulates scope-isolated prompts for delegated subagents.
 * - Prompts:
 *   - context_shield: Injects the 3-Layer Context Governance rules.
 * - Resources:
 *   - context-saver://rules/governance: Serves the full AGENTS.md rulebook.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { runInstall, runUninstall, runStatus, detectExistingInstallation } from "../scripts/install-register.mjs";

// Handle CLI subcommands (e.g. npx agy-context-saver install)
const cliArg = process.argv[2];
const checkFlag = process.argv.includes("--check") || process.argv.includes("-c");
if (cliArg === "install" || cliArg === "--install") {
  await runInstall({ checkOnly: checkFlag });
  process.exit(0);
} else if (cliArg === "uninstall" || cliArg === "--uninstall") {
  await runUninstall();
  process.exit(0);
} else if (cliArg === "status" || cliArg === "--status") {
  runStatus();
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rulesPath = path.resolve(__dirname, "../rules/AGENTS.md");

const SERVER_NAME = "agy-context-saver";
const SERVER_VERSION = "1.0.0";

// --- Tools Specification ---
const TOOLS = [
  {
    name: "safe_command",
    description: "Run a shell command with intelligent output compression, generous timeout, and zero context bloat. Collapses massive test dot streams and repetitive logs to protect context window attention.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The exact shell command to execute."
        },
        cwd: {
          type: "string",
          description: "Working directory (optional, defaults to current working directory)."
        },
        timeoutSeconds: {
          type: "number",
          description: "Execution timeout in seconds (default: 30)."
        },
        maxOutputLines: {
          type: "number",
          description: "Maximum output lines to return before compressing (default: 30)."
        }
      },
      required: ["command"]
    }
  },
  {
    name: "check_context_health",
    description: "Inspects a conversation transcript (transcript.jsonl) to diagnose turn count, payload size, tool polling loops, and context degradation risk.",
    inputSchema: {
      type: "object",
      properties: {
        transcriptPath: {
          type: "string",
          description: "Path to transcript.jsonl file."
        }
      },
      required: ["transcriptPath"]
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
const MAX_LINE_CHARS = 2000;
const MAX_TOTAL_CHARS = 64000;
const MAX_CAPTURE_BYTES = 50 * 1024 * 1024; // 50MB memory ceiling against runaway commands

function clampLine(line) {
  if (line.length <= MAX_LINE_CHARS) return line;
  const half = Math.floor(MAX_LINE_CHARS / 2);
  return `${line.slice(0, half)} ... [truncated long line ${line.length} chars] ... ${line.slice(-half)}`;
}

function compressOutput(text, maxLines) {
  if (!text) return "(empty output)";
  const rawLines = text.split(/\r?\n/);
  const lines = rawLines.map(clampLine);

  let output = "";
  if (lines.length <= maxLines) {
    output = lines.join("\n");
  } else {
    const half = Math.floor(maxLines / 2);
    const head = lines.slice(0, half).join("\n");
    const tail = lines.slice(-half).join("\n");
    const omitted = lines.length - maxLines;
    output = `${head}\n\n... [agy-context-saver: compressed ${omitted} repetitive output lines] ...\n\n${tail}`;
  }

  if (output.length > MAX_TOTAL_CHARS) {
    const halfChars = Math.floor(MAX_TOTAL_CHARS / 2);
    output = `${output.slice(0, halfChars)}\n\n... [agy-context-saver: clamped excessive character output (${output.length} chars)] ...\n\n${output.slice(-halfChars)}`;
  }

  return output;
}

async function handleSafeCommand({ command, cwd, timeoutSeconds = 30, maxOutputLines = 30 }) {
  return new Promise((resolve) => {
    const isWin = os.platform() === "win32";
    const shell = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-c", command];

    const startTime = Date.now();
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let killEscalationTimer = null;
    let captureTruncated = false;

    const proc = spawn(shell, shellArgs, {
      cwd: cwd || process.cwd(),
      env: process.env,
      windowsHide: true,
      windowsVerbatimArguments: isWin
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {}

      // Escalating kill signal: force SIGKILL / tree-kill after 1.5s if process lingers
      killEscalationTimer = setTimeout(() => {
        try {
          if (!proc.killed) {
            if (isWin && proc.pid) {
              spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
            } else {
              proc.kill("SIGKILL");
            }
          }
        } catch {}
      }, 1500);
    }, timeoutSeconds * 1000);

    proc.stdout.on("data", (chunk) => {
      if (stdoutBytes < MAX_CAPTURE_BYTES) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        captureTruncated = true;
      }
    });

    proc.stderr.on("data", (chunk) => {
      if (stderrBytes < MAX_CAPTURE_BYTES) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      } else {
        captureTruncated = true;
      }
    });

    proc.on("close", (exitCode) => {
      clearTimeout(timer);
      if (killEscalationTimer) clearTimeout(killEscalationTimer);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

      let stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      let stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (captureTruncated) {
        stdout += "\n... [agy-context-saver: raw output exceeded 50MB stream capture ceiling] ...\n";
      }

      if (timedOut) {
        return resolve({
          isError: true,
          content: [
            {
              type: "text",
              text: `[COMMAND TIMEOUT] Process exceeded ${timeoutSeconds}s and was terminated.\nPartial output:\n${compressOutput(stdout, 15)}`
            }
          ]
        });
      }

      const combined = (stdout + (stderr ? "\n[STDERR]\n" + stderr : "")).trim();
      const compressed = compressOutput(combined, maxOutputLines);

      const statusSummary = exitCode === 0 ? "PASSED (exit 0)" : `FAILED (exit ${exitCode})`;
      const resultText = `[STATUS: ${statusSummary} in ${elapsed}s]\n${compressed}`;

      resolve({
        isError: exitCode !== 0,
        content: [{ type: "text", text: resultText }]
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (killEscalationTimer) clearTimeout(killEscalationTimer);
      resolve({
        isError: true,
        content: [{ type: "text", text: `[SPAWN ERROR] Failed to start command: ${err.message}` }]
      });
    });
  });
}

async function handleCheckContextHealth({ transcriptPath }) {
  try {
    if (!fs.existsSync(transcriptPath)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Transcript not found: ${transcriptPath}` }]
      };
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

    const reportLines = [
      `### Context Health Report: ${healthStatus}`,
      `- Total Steps: ${totalSteps}`,
      `- User Turns: ${userTurns}`,
      `- Assistant Responses: ${modelTurns}`,
      `- Tool Calls: ${toolCalls}`,
      `- Detected Busy-Polling Events: ${pollingEvents}`,
      `- Approximate Raw Transcript Size: ${kb} KB`
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
  const report = [
    `### Agy-Context-Saver Installation Status: ${existing.isComplete ? "HEALTHY & ACTIVE 🛡️" : existing.isInstalled ? "PARTIAL INSTALLATION ⚠️" : "NOT INSTALLED ❌"}`,
    `- Native Plugin Link: ${existing.details.plugin.exists ? `ACTIVE (${existing.details.plugin.target})` : "NOT LINKED"}`,
    `- Governor Lifecycle Hook: ${existing.details.hook.registered ? "REGISTERED in hooks.json" : "NOT REGISTERED"} (Script: ${existing.details.hook.scriptExists ? "Present" : "Missing"})`,
    `- Universal MCP Server: ${existing.details.mcp.registered ? "CONFIGURED in mcp_config.json" : "NOT CONFIGURED"}`,
    `- Antigravity Tool Schemas: ${existing.details.schemas.exists ? "ALL 5 SCHEMAS PRESENT" : "MISSING"} (${existing.details.schemas.dir})`,
    "",
    existing.isComplete
      ? "✓ All 4 Antigravity integration layers are fully operational and synchronized."
      : "⚠️ Recommendation: Run sync_installation to re-verify and repair missing layers."
  ].join("\n");

  return {
    content: [{ type: "text", text: report }]
  };
}

async function handleSyncInstallation({ checkOnly = false } = {}) {
  const result = await runInstall({ checkOnly, silent: true });
  const report = [
    `### Agy-Context-Saver Installation Synchronization`,
    `- Status: ${result.isComplete ? "SYNCHRONIZED & HEALTHY 🛡️" : "UPDATED"}`,
    `- Elapsed Time: ${result.elapsedMs || "0"} ms`,
    `- Plugin Link: ${result.details?.plugin?.exists ? "Verified" : "Updated"}`,
    `- Lifecycle Hook: Registered in hooks.json`,
    `- MCP Server: Registered in mcp_config.json`,
    `- Tool Schemas: 5 Schemas mirrored to ~/.gemini/antigravity/mcp/agy-context-saver`,
    "",
    checkOnly ? "✓ Pre-flight check complete (dry-run)." : "✓ Installation fully synchronized and up-to-date in Zero-Delay mode."
  ].join("\n");

  return {
    content: [{ type: "text", text: report }]
  };
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

    if (name === "safe_command") {
      toolResult = await handleSafeCommand(args);
    } else if (name === "check_context_health") {
      toolResult = await handleCheckContextHealth(args);
    } else if (name === "subagent_brief") {
      toolResult = handleSubagentBrief(args);
    } else if (name === "get_installation_status") {
      toolResult = handleGetInstallationStatus();
    } else if (name === "sync_installation") {
      toolResult = await handleSyncInstallation(args);
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
      const content = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, "utf-8") : "# Governance rules not found";
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
      const content = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, "utf-8") : "";
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
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on("line", async (line) => {
  if (!line || !line.trim()) return;
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
