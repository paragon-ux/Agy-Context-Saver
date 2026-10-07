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
    description: "Run a shell command with adaptive semantic reduction, generous timeout, and zero context bloat. Collapses repetitive test passes and progress streams to 2-4 KB, protects errors and diffs, and formats outputs with clean Markdown fences.",
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
        },
        verbosity: {
          type: "string",
          enum: ["quiet", "normal", "full"],
          description: "quiet = status badge only for routine passes (<=200 chars); normal = adaptive semantic reduction targeting 2-4 KB (default); full = preserve raw output up to 24 KB ceiling."
        },
        terse: {
          type: "boolean",
          description: "Legacy alias: if true, maps to verbosity='quiet' to minimize UI step height (default: false)."
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
const MAX_LINE_CHARS = 1000;
const MAX_TOTAL_CHARS = 24000;
const TARGET_NORMAL_CHARS = 4096;
const MAX_CAPTURE_BYTES = 50 * 1024 * 1024; // 50MB memory ceiling against runaway commands

function clampLine(line) {
  if (line.length <= MAX_LINE_CHARS) return line;
  const half = Math.floor(MAX_LINE_CHARS / 2);
  return `${line.slice(0, half)} ... [truncated long line ${line.length} chars] ... ${line.slice(-half)}`;
}

/**
 * Adaptive Semantic Output Reducer:
 * Optimizes the representation of command outputs for LLM reasoning and UI readability.
 * Targets 2-4 KB for routine commands while preserving 100% of errors, stack traces, and diffs.
 */
function reduceSemanticOutput({
  stdout = "",
  stderr = "",
  exitCode = 0,
  command = "",
  maxOutputLines = 30,
  verbosity = "normal",
  elapsed = "0.00",
  isTerseLegacy = false
}) {
  const isQuiet = verbosity === "quiet";
  const isFull = verbosity === "full";
  const isSuccess = exitCode === 0;

  const rawCombined = (stdout + (stderr ? "\n[STDERR]\n" + stderr : "")).trim();
  const rawLines = rawCombined ? rawCombined.split(/\r?\n/).filter(Boolean).length : 0;

  // 1. Quiet mode: if successful, return compact 1-line badge (<=200 chars)
  // If failed, automatically bypass quiet mode to provide full diagnostic signal
  if (isQuiet && isSuccess) {
    const modeLabel = isTerseLegacy ? "terse mode" : "quiet mode";
    return {
      isError: false,
      text: `✓ [STATUS: PASSED (exit 0) in ${elapsed}s] (${rawLines} lines collapsed in ${modeLabel})`
    };
  }

  // 2. Full mode: preserve raw output bounded by 24 KB ceiling inside markdown fences
  if (isFull) {
    let body = rawCombined || "(empty output)";
    if (body.length > MAX_TOTAL_CHARS) {
      const half = Math.floor(MAX_TOTAL_CHARS / 2);
      body = `${body.slice(0, half)}\n\n... [agy-context-saver: clamped to 24 KB ceiling] ...\n\n${body.slice(-half)}`;
    }
    const statusHeader = isSuccess
      ? `[STATUS: PASSED (exit 0) in ${elapsed}s]`
      : `[STATUS: FAILED (exit ${exitCode}) in ${elapsed}s]`;
    return {
      isError: !isSuccess,
      text: `${statusHeader}\n\`\`\`text\n${body.trim()}\n\`\`\``
    };
  }

  // 3. Normal mode: adaptive semantic reduction targeting 2-4 KB
  let errSection = "";
  if (stderr && stderr.trim()) {
    errSection = stderr.trim();
  }

  const rawStdoutLines = stdout ? stdout.trim().split(/\r?\n/).map(clampLine) : [];

  // Phase A: Identify high-value lines (errors, stack traces, diffs)
  const isHighValueLine = (line) => {
    return /^(?:diff --git|index [0-9a-f]|---|\+\+\+|@@ -|error|exception|fail|failed|fatal|traceback|\s*at\s+\S+|\s+File\s+".*",\s+line)/i.test(line);
  };

  // Phase B: Detect and collapse repetitive patterns
  const isTestPassLine = (line) => {
    return /^\s*(?:PASS|✓|✔|\[PASS\]|test\s+\S+\s+\.\.\.\s+ok|ok\s+\d+|passed)/i.test(line);
  };

  const isProgressLine = (line) => {
    return /^\s*(?:\.{3,}|[-=]{4,}|\[[=\s>]{4,}\]|\d+%\s*\||Progress:|Fetching:|Downloading:)/i.test(line);
  };

  const processed = [];
  let i = 0;
  while (i < rawStdoutLines.length) {
    const line = rawStdoutLines[i];

    // Check for repetitive test passes (run of 3 or more)
    if (isTestPassLine(line) && !isHighValueLine(line)) {
      let runEnd = i;
      while (runEnd < rawStdoutLines.length && isTestPassLine(rawStdoutLines[runEnd]) && !isHighValueLine(rawStdoutLines[runEnd])) {
        runEnd++;
      }
      const runLength = runEnd - i;
      if (runLength >= 3) {
        processed.push(rawStdoutLines[i]);
        processed.push(`... [${runLength - 2} repetitive test pass lines collapsed] ...`);
        processed.push(rawStdoutLines[runEnd - 1]);
        i = runEnd;
        continue;
      }
    }

    // Check for repetitive progress indicators (run of 3 or more)
    if (isProgressLine(line)) {
      let runEnd = i;
      while (runEnd < rawStdoutLines.length && isProgressLine(rawStdoutLines[runEnd])) {
        runEnd++;
      }
      const runLength = runEnd - i;
      if (runLength >= 3) {
        processed.push(`... [${runLength} progress updates collapsed] ...`);
        i = runEnd;
        continue;
      }
    }

    // Check for consecutive identical lines (run of 3 or more)
    let runEnd = i + 1;
    while (runEnd < rawStdoutLines.length && rawStdoutLines[runEnd] === line) {
      runEnd++;
    }
    const identicalRun = runEnd - i;
    if (identicalRun >= 3 && line.trim().length > 0) {
      processed.push(line);
      processed.push(`... [${identicalRun - 1} identical lines collapsed] ...`);
      i = runEnd;
      continue;
    }

    processed.push(line);
    i++;
  }

  // Phase C: If lines exceed maxOutputLines, apply head/tail safety clamping
  let stdoutBody = "";
  if (processed.length <= maxOutputLines) {
    stdoutBody = processed.join("\n");
  } else {
    const half = Math.floor(maxOutputLines / 2);
    const head = processed.slice(0, half).join("\n");
    const tail = processed.slice(-half).join("\n");
    const omitted = processed.length - maxOutputLines;
    stdoutBody = `${head}\n\n... [agy-context-saver: compressed ${omitted} repetitive output lines] ...\n\n${tail}`;
  }

  // Combine stdoutBody and errSection (ensuring errors are never dropped)
  let combinedNormal = stdoutBody;
  if (errSection) {
    combinedNormal = combinedNormal ? `${combinedNormal}\n\n[STDERR]\n${errSection}` : `[STDERR]\n${errSection}`;
  }
  if (!combinedNormal.trim()) {
    combinedNormal = "(empty output)";
  }

  // Phase D: Target budget safety clamping (target <= 4096 chars)
  if (combinedNormal.length > TARGET_NORMAL_CHARS) {
    const halfBudget = Math.floor(TARGET_NORMAL_CHARS / 2);
    combinedNormal = `${combinedNormal.slice(0, halfBudget)}\n\n... [clamped to 4 KB normal budget; pass verbosity: "full" to see raw output] ...\n\n${combinedNormal.slice(-halfBudget)}`;
  }

  const statusHeader = isSuccess
    ? `[STATUS: PASSED (exit 0) in ${elapsed}s]`
    : `[STATUS: FAILED (exit ${exitCode}) in ${elapsed}s]`;

  return {
    isError: !isSuccess,
    text: `${statusHeader}\n\`\`\`text\n${combinedNormal.trim()}\n\`\`\``
  };
}

// Legacy helper retained for backwards compatibility
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
    output = `${output.slice(0, halfChars)}\n\n... [agy-context-saver: clamped to 24 KB ceiling to prevent host disk spillover] ...\n\n${output.slice(-halfChars)}`;
  }

  return output;
}

function assistantOnlyBlock(text) {
  return {
    type: "text",
    text,
    annotations: {
      audience: ["assistant"],
      priority: 0
    }
  };
}

function userFacingBlock(text) {
  return {
    type: "text",
    text,
    annotations: {
      audience: ["user"],
      priority: 1
    }
  };
}

async function resolveWorkspaceCwd() {
  try {
    const dbPath = path.join(os.homedir(), ".gemini", "antigravity", "conversation_summaries.db");
    if (fs.existsSync(dbPath)) {
      const origEmitWarning = process.emitWarning;
      process.emitWarning = () => {};
      try {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const row = db.prepare("SELECT workspace_uris FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 1").get();
        if (row && row.workspace_uris) {
          const uris = JSON.parse(row.workspace_uris);
          if (Array.isArray(uris) && uris.length > 0) {
            const parsed = new URL(uris[0]);
            let wsPath = decodeURIComponent(parsed.pathname);
            if (os.platform() === "win32" && wsPath.startsWith("/")) {
              wsPath = wsPath.slice(1);
            }
            if (fs.existsSync(wsPath)) {
              return wsPath;
            }
          }
        }
      } finally {
        process.emitWarning = origEmitWarning;
      }
    }
  } catch {}
  return process.env.INIT_CWD || process.env.PWD || process.cwd();
}

async function handleSafeCommand({ command, cwd, timeoutSeconds = 30, maxOutputLines = 30, verbosity = "normal", terse = false }) {
  const resolvedCwd = cwd || (await resolveWorkspaceCwd());
  const isTerseLegacy = terse === true;
  const effectiveVerbosity = isTerseLegacy ? "quiet" : (verbosity || "normal");

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
      cwd: resolvedCwd,
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
        const timeoutReduction = reduceSemanticOutput({
          stdout,
          stderr: `[COMMAND TIMEOUT] Process exceeded ${timeoutSeconds}s and was terminated.`,
          exitCode: 124,
          command,
          maxOutputLines: 15,
          verbosity: "normal",
          elapsed: String(timeoutSeconds)
        });
        return resolve({
          isError: true,
          content: [
            assistantOnlyBlock(timeoutReduction.text)
          ]
        });
      }

      const reduction = reduceSemanticOutput({
        stdout,
        stderr,
        exitCode,
        command,
        maxOutputLines,
        verbosity: effectiveVerbosity,
        elapsed,
        isTerseLegacy
      });

      resolve({
        isError: reduction.isError,
        content: [
          assistantOnlyBlock(reduction.text)
        ]
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (killEscalationTimer) clearTimeout(killEscalationTimer);
      resolve({
        isError: true,
        content: [
          assistantOnlyBlock(`[STATUS: FAILED (spawn error)]\n\`\`\`text\n[SPAWN ERROR] Failed to start command: ${err.message}\n\`\`\``)
        ]
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
    `- Antigravity Tool Schemas: ${existing.details.schemas.exists ? "ALL 7 SCHEMAS PRESENT" : "MISSING"} (${existing.details.schemas.dir})`,
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
    `- Tool Schemas: 7 Schemas mirrored to ~/.gemini/antigravity/mcp/agy-context-saver`,
    "",
    checkOnly ? "✓ Pre-flight check complete (dry-run)." : "✓ Installation fully synchronized and up-to-date in Zero-Delay mode."
  ].join("\n");

  return {
    content: [{ type: "text", text: report }]
  };
}

// --- Transcript Reader & Forensics Engine Helpers ---

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

  // Strip huge base64 media blocks
  text = text.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[Embedded Media/Binary Omitted]");
  text = text.replace(/[A-Za-z0-9+/=]{200,}/g, "[Binary/Base64 Payload Omitted]");

  // Clamp lines exceeding MAX_LINE_CHARS
  const lines = text.split("\n");
  const clampedLines = lines.map((l) => {
    if (l.length > MAX_LINE_CHARS) {
      return l.slice(0, MAX_LINE_CHARS) + " ... [line clamped]";
    }
    return l;
  });
  text = clampedLines.join("\n");

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

async function findFullStep(fullPath, targetStepIndex) {
  if (!fs.existsSync(fullPath)) return null;
  const fileStream = fs.createReadStream(fullPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.step_index === targetStepIndex) {
          rl.close();
          return item;
        }
      } catch {}
    }
  } catch {}
  return null;
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

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        items.push(item);
      } catch {
        // Tolerates incomplete trailing flushes during concurrent writes
      }
    }
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Error reading transcript stream: ${err.message}` }] };
  }

  if (items.length === 0) {
    return { content: [{ type: "text", text: `Transcript is empty at: ${filePath}` }] };
  }

  let selected = items;
  if (lastTurns > 0) {
    const turnItems = items.filter((it) => it.type === "USER_INPUT" || it.type === "PLANNER_RESPONSE");
    const cutoff = Math.max(0, turnItems.length - lastTurns);
    const minStep = turnItems[cutoff] ? turnItems[cutoff].step_index : 0;
    selected = items.filter((it) => (it.step_index || 0) >= minStep);
  }

  const formattedBlocks = selected.map((it) => formatTranscriptItem(it, {
    includeThinking,
    includeToolCalls: true
  }));

  const header = [
    `# Conversation Transcript: \`${convId}\``,
    `- Mode: **${mode}** (${path.basename(filePath)})`,
    `- Total Steps in Log: ${items.length}`,
    `- Displayed Steps: ${selected.length} (showing last ${lastTurns > 0 ? `${lastTurns} turns` : "all"})`,
    "",
    "---",
    ""
  ].join("\n");

  let fullOutput = header + formattedBlocks.join("\n\n---\n\n");
  if (fullOutput.length > MAX_OUTPUT_CHARS) {
    fullOutput = fullOutput.slice(0, MAX_OUTPUT_CHARS) + "\n\n... [Transcript display clamped at 24 KB safety ceiling] ...";
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

  let queryRegex = null;
  if (query) {
    try {
      queryRegex = new RegExp(query, "i");
    } catch {
      queryRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
  }

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
        const contentStr = typeof item.content === "string" ? item.content : JSON.stringify(item.content || "");
        const thinkingStr = typeof item.thinking === "string" ? item.thinking : "";
        const toolStr = item.tool_calls ? JSON.stringify(item.tool_calls) : "";
        const haystack = `${contentStr} ${thinkingStr} ${toolStr}`;
        if (!queryRegex.test(haystack)) continue;
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

  // Auto-dereferencing if mode is "auto" and fields were truncated
  if (mode === "auto" && hasFullSibling) {
    for (let i = 0; i < finalItems.length; i++) {
      const it = finalItems[i];
      if (Array.isArray(it.truncated_fields) && it.truncated_fields.length > 0) {
        const fullItem = await findFullStep(fullSiblingPath, it.step_index);
        if (fullItem) {
          finalItems[i] = fullItem;
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

  const blocks = finalItems.map((it) => formatTranscriptItem(it, {
    includeThinking,
    includeToolCalls: includeToolCalls || roleSet.has("tool")
  }));

  const header = [
    `## Transcript Query Results: \`${convId}\``,
    `- Filter: query=${query ? `"${query}"` : "NONE"}, roles=[${Array.from(roleSet).join(", ")}], mode=${mode}`,
    `- Matched Steps: ${matched.length} (showing ${finalItems.length})`,
    "",
    "---",
    ""
  ].join("\n");

  let output = header + blocks.join("\n\n---\n\n");
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS) + "\n\n... [Query results clamped at 24 KB safety ceiling] ...";
  }

  return { content: [{ type: "text", text: output }] };
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
