#!/usr/bin/env node

/**
 * Agy-Context-Saver: Universal Model Context Protocol (MCP) Server
 *
 * Implements standard MCP (JSON-RPC 2.0 over stdio) with zero external dependencies.
 * Purpose-built for Google Antigravity across macOS, Linux, and Windows.
 *
 * Capabilities:
 * - Tools:
 *   - safe_command: Executes shell commands with intelligent output compression
 *     and generous timeouts to prevent context-window bloat and polling loops.
 *   - check_context_health: Inspects conversation transcripts to diagnose bloat.
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
import { runInstall, runUninstall, runStatus } from "../scripts/install-register.mjs";

// Handle CLI subcommands (e.g. npx agy-context-saver install)
const cliArg = process.argv[2];
const checkFlag = process.argv.includes("--check") || process.argv.includes("-c");
if (cliArg === "install" || cliArg === "--install") {
  runInstall({ checkOnly: checkFlag });
  process.exit(0);
} else if (cliArg === "uninstall" || cliArg === "--uninstall") {
  runUninstall();
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
async function handleSafeCommand({ command, cwd, timeoutSeconds = 30, maxOutputLines = 30 }) {
  return new Promise((resolve) => {
    const isWin = os.platform() === "win32";
    const shell = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-c", command];

    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = spawn(shell, shellArgs, {
      cwd: cwd || process.cwd(),
      env: process.env,
      windowsHide: true,
      windowsVerbatimArguments: isWin
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutSeconds * 1000);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });

    proc.on("close", (exitCode) => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

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
      resolve({
        isError: true,
        content: [{ type: "text", text: `[SPAWN ERROR] Failed to start command: ${err.message}` }]
      });
    });
  });
}

function compressOutput(text, maxLines) {
  if (!text) return "(empty output)";
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;

  const half = Math.floor(maxLines / 2);
  const head = lines.slice(0, half).join("\n");
  const tail = lines.slice(-half).join("\n");
  const omitted = lines.length - maxLines;

  return `${head}\n\n... [agy-context-saver: compressed ${omitted} repetitive output lines] ...\n\n${tail}`;
}

function handleCheckContextHealth({ transcriptPath }) {
  try {
    if (!fs.existsSync(transcriptPath)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Transcript not found: ${transcriptPath}` }]
      };
    }

    const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/).filter(Boolean);
    let userTurns = 0;
    let modelTurns = 0;
    let toolCalls = 0;
    let pollingEvents = 0;
    let totalBytes = 0;

    for (const line of lines) {
      totalBytes += line.length;
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
      } catch {}
    }

    const kb = (totalBytes / 1024).toFixed(1);
    const healthStatus = pollingEvents > 3 ? "CRITICAL (Active Polling Loops Detected)" : userTurns > 40 ? "WARNING (High Turn Budget)" : "HEALTHY";

    const report = [
      `### Context Health Report: ${healthStatus}`,
      `- Total Steps: ${lines.length}`,
      `- User Turns: ${userTurns}`,
      `- Assistant Responses: ${modelTurns}`,
      `- Tool Calls: ${toolCalls}`,
      `- Detected Busy-Polling Events: ${pollingEvents}`,
      `- Approximate Raw Transcript Size: ${kb} KB`,
      "",
      pollingEvents > 0 ? "⚠️ Recommendation: Background polling detected! Cease manage_task(status) calls and yield execution to native Reactive Wakeup." : "",
      userTurns >= 35 ? "💡 Recommendation: Turn budget approaching threshold. Delegate broad research to subagents to preserve context." : "✓ Context footprint is well-managed."
    ].filter(Boolean).join("\n");

    return { content: [{ type: "text", text: report }] };
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
      toolResult = handleCheckContextHealth(args);
    } else if (name === "subagent_brief") {
      toolResult = handleSubagentBrief(args);
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
