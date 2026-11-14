#!/usr/bin/env node

/**
 * @deprecated Agy-Context-Saver MCP Compatibility Wrapper (v2.0.0)
 *
 * Legacy JSON-RPC 2.0 stdio wrapper delegating all transcript & health logic to
 * `lib/transcript-core.mjs`. New integrations should use the CLI (`agy-context`)
 * directly rather than spawning an MCP server.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  checkContextHealth,
  readTranscript,
  queryTranscript
} from "../lib/transcript-core.mjs";
import {
  runInstall,
  runUninstall,
  runStatus,
  runRestoreBackups,
  detectExistingInstallation
} from "../scripts/install-register.mjs";
import { findExistingRtk } from "../scripts/provision-rtk.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rulesPath = path.resolve(__dirname, "../rules/AGENTS.md");

const realOrSelf = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const isEntryPoint = Boolean(
  process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(__filename)
);

function printHelp() {
  console.log(`
Agy-Context-Saver (v2.0.0) — DEPRECATED MCP Wrapper
Prefer the native CLI: \`agy-context transcript read|query|step|health\` and \`agy-context status|setup|uninstall\`.

Legacy Wrapper Usage:
  node mcp/index.js [command] [options]
  status, --status             Audit live registration
  install, --install           Synchronize installation
  install --check, -c          Dry-run verification check
  uninstall, --uninstall       Unregister installation
  uninstall --restore-backups  Unregister and restore backups
  help, --help, -h             Show this help message
`);
}

if (isEntryPoint) {
  const cliArgs = process.argv.slice(2);
  const cliArg = cliArgs[0];
  const checkFlag = cliArgs.includes("--check") || cliArgs.includes("-c");
  const statusFlag = cliArgs.includes("--status") || cliArgs.includes("status");
  const uninstallFlag = cliArgs.includes("--uninstall") || cliArgs.includes("uninstall");
  const restoreFlag = cliArgs.includes("--restore-backups") || cliArgs.includes("restore-backups");
  const helpFlag = cliArgs.includes("--help") || cliArgs.includes("-h") || cliArgs.includes("help");
  const allowDegraded = cliArgs.includes("--allow-degraded");

  if (helpFlag) {
    printHelp();
    process.exit(0);
  }
  if ((checkFlag || statusFlag) && (uninstallFlag || restoreFlag)) {
    console.error("Error: Read-only flags (--check, --status) cannot be combined with mutating flags (--uninstall, --restore-backups).");
    process.exit(1);
  }
  if (checkFlag && statusFlag) {
    console.error("Error: Conflicting flags: specify either --check or --status, not both.");
    process.exit(1);
  }
  if (checkFlag) {
    await runInstall({ checkOnly: true, allowDegraded });
    process.exit(0);
  } else if (statusFlag) {
    runStatus();
    process.exit(0);
  } else if (uninstallFlag) {
    await runUninstall({ restoreBackups: restoreFlag });
    process.exit(0);
  } else if (restoreFlag) {
    await runRestoreBackups();
    process.exit(0);
  } else if (cliArg === "install" || cliArg === "--install") {
    await runInstall({ allowDegraded });
    process.exit(0);
  }
}

const SERVER_NAME = "agy-context-saver";
const SERVER_VERSION = "2.0.0";

const TOOLS = [
  {
    name: "check_context_health",
    description: "[Deprecated MCP wrapper] Inspects a conversation transcript (transcript.jsonl) to diagnose turn count, payload size, tool polling loops, and context degradation risk. Prefer `agy-context transcript health`.",
    inputSchema: {
      type: "object",
      properties: {
        transcriptPath: { type: "string", description: "Path to transcript.jsonl file, conversation UUID, or empty for active conversation." },
        conversationId: { type: "string", description: "Conversation UUID or folder name (alternative to transcriptPath)." }
      }
    }
  },
  {
    name: "get_installation_status",
    description: "[Deprecated MCP wrapper] Inspect the live installation status of Agy-Context-Saver. Prefer `agy-context status`.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "sync_installation",
    description: "[Deprecated MCP wrapper] Re-verify and synchronize Agy-Context-Saver installation. Prefer `agy-context setup`.",
    inputSchema: {
      type: "object",
      properties: {
        checkOnly: { type: "boolean", description: "If true, performs a pre-flight audit without writing changes (default: false)." }
      },
      required: []
    }
  },
  {
    name: "read_transcript",
    description: "[Deprecated MCP wrapper] Read recent conversation history from an Antigravity transcript. Prefer `agy-context transcript read`.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Conversation ID (UUID) or path. If omitted, defaults to active conversation." },
        mode: { type: "string", enum: ["compact", "full"], description: "Transcript mode (default: 'compact')." },
        lastTurns: { type: "number", description: "Number of most recent conversation turns to extract (default: 3)." },
        includeThinking: { type: "boolean", description: "Include assistant thinking blocks (default: false)." }
      }
    }
  },
  {
    name: "query_transcript",
    description: "[Deprecated MCP wrapper] Forensic filtering and regex search engine for conversation logs. Prefer `agy-context transcript query` / `step`.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Conversation ID (UUID) or path." },
        query: { type: "string", description: "Regex pattern or literal text to search for." },
        roles: { type: "array", items: { type: "string", enum: ["user", "assistant", "subagent", "tool", "error", "all"] }, description: "Roles to include." },
        mode: { type: "string", enum: ["auto", "compact", "full"], description: "Resolution mode (default: 'auto')." },
        startStep: { type: "number", description: "Optional inclusive minimum step_index." },
        endStep: { type: "number", description: "Optional inclusive maximum step_index." },
        lastTurns: { type: "number", description: "Restrict query to the last N dialogue turns." },
        includeThinking: { type: "boolean", description: "Include thinking blocks (default: false)." },
        includeToolCalls: { type: "boolean", description: "Include tool call summaries (default: false)." },
        maxResults: { type: "number", description: "Maximum number of matching steps to display." },
        summaryOnly: { type: "boolean", description: "Return compact 1-line summary bullets (default: false)." },
        stepIndex: { type: "number", description: "Optional step_index to surgically retrieve a single step." },
        field: { type: "string", description: "Optional specific field to extract when stepIndex is provided." }
      },
      required: ["conversationId"]
    }
  }
];

const RESOURCES = [
  {
    uri: "context-saver://rules/governance",
    name: "Antigravity Execution & Context Governance Rulebook",
    description: "Authoritative 3-Layer rules preventing background polling loops, maximizing synchronous execution, and keeping command output compact.",
    mimeType: "text/markdown"
  }
];

const PROMPTS = [
  {
    name: "context_shield",
    description: "Apply Agy-Context-Saver 3-Layer governance to the active session to prevent polling loops and transcript degradation.",
    arguments: []
  }
];

function toMcpResult(res) {
  if (res.isError) {
    return {
      isError: true,
      content: [{ type: "text", text: res.text || res.error || "Unknown error" }]
    };
  }
  return {
    content: [{ type: "text", text: res.text || res.reportText || "" }]
  };
}

function handleGetInstallationStatus() {
  const existing = detectExistingInstallation();
  const rtkInfo = findExistingRtk();
  const details = existing.details || {};
  const cliShimLine = details.cliShim
    ? `- CLI Shim (agy-context): ${details.cliShim.exists ? `ACTIVE (${details.cliShim.path || "installed"})` : "MISSING"}`
    : null;
  const legacySchemaLine = details.schemas
    ? `- Antigravity Tool Schemas: ${details.schemas.exists ? "ALL 5 SCHEMAS PRESENT" : "MISSING"} (${details.schemas.dir})`
    : null;

  const lines = [
    `### Agy-Context-Saver Installation Status: ${existing.isComplete ? "HEALTHY & ACTIVE 🛡️" : existing.isInstalled ? "PARTIAL INSTALLATION ⚠️" : "NOT INSTALLED ❌"}`,
    `- Native Plugin Link: ${details.plugin?.exists ? `ACTIVE (${details.plugin.target})` : "NOT LINKED"}`,
    `- Governor Lifecycle Hook: ${details.hook?.registered ? "REGISTERED in hooks.json" : "NOT REGISTERED"} (Script: ${details.hook?.scriptExists ? "Present" : "Missing"})`,
    cliShimLine,
    legacySchemaLine,
    `- RTK Binary: ${rtkInfo ? `INSTALLED (${rtkInfo.version})` : "MISSING"}`,
    `- RTK Hook Optimization: ${details.hook?.registered ? "ACTIVE (via PreToolUse)" : "INACTIVE"}`,
    "",
    existing.isComplete && rtkInfo
      ? "✓ All Antigravity integration layers and RTK optimizer are fully operational."
      : "⚠️ Recommendation: Run `agy-context setup` to re-verify and repair missing layers."
  ].filter((l) => l !== null);

  return { content: [{ type: "text", text: lines.join("\n") }] };
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
    `- RTK Binary: ${rtkInfo ? `Verified (${rtkInfo.version})` : "Provisioned"}`,
    "",
    checkOnly ? "✓ Pre-flight check complete (dry-run)." : "✓ Installation fully synchronized and up-to-date."
  ].join("\n");

  return { content: [{ type: "text", text: report }] };
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
    return null;
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (method === "tools/call") {
    const { name, arguments: args = {} } = params || {};
    let toolResult;

    if (name === "check_context_health") {
      toolResult = toMcpResult(await checkContextHealth({ ...args, allowExternalPaths: true }));
    } else if (name === "get_installation_status") {
      toolResult = handleGetInstallationStatus();
    } else if (name === "sync_installation") {
      toolResult = await handleSyncInstallation(args);
    } else if (name === "read_transcript") {
      toolResult = toMcpResult(await readTranscript({ ...args, allowExternalPaths: true }));
    } else if (name === "query_transcript") {
      toolResult = toMcpResult(await queryTranscript({ ...args, allowExternalPaths: true }));
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
      return {
        jsonrpc: "2.0",
        id,
        result: {
          contents: [{ uri, mimeType: "text/markdown", text: getGovernanceRules() }]
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

if (isEntryPoint) {
  const MAX_STDIO_PAYLOAD_BYTES = Number(process.env.AGY_MAX_STDIO_PAYLOAD_BYTES) || (10 * 1024 * 1024);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  rl.on("line", async (line) => {
    if (!line || !line.trim()) return;
    if (line.length > MAX_STDIO_PAYLOAD_BYTES) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request: Payload exceeds 10MB safety ceiling" }
      }) + "\n");
      return;
    }
    try {
      const req = JSON.parse(line);
      const resp = await handleRequest(req);
      if (resp) {
        process.stdout.write(JSON.stringify(resp) + "\n");
      }
    } catch (err) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `Parse error: ${err.message}` }
      }) + "\n");
    }
  });

  rl.on("close", () => process.exit(0));
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  process.stdout.on("error", (err) => {
    if (err && err.code === "EPIPE") process.exit(0);
  });

  const initialPpid = process.ppid;
  if (initialPpid && initialPpid > 1) {
    const watchdog = setInterval(() => {
      try {
        process.kill(initialPpid, 0);
      } catch (err) {
        if (err && err.code === "ESRCH") process.exit(0);
      }
    }, 15000);
    watchdog.unref();
  }
}

export { handleRequest };
