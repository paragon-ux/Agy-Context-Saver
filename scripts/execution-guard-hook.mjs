#!/usr/bin/env node

/**
 * Agy-Context-Saver: Intelligent Execution Governor Hook for Antigravity
 *
 * Closed Execution Topology & Governance Invariants:
 * 1. RTK Transparent Command Optimization:
 *    - Offloads 100% of command output reduction to RTK (Rust Token Killer).
 *    - Intercepts native run_command and calls `rtk rewrite <cmd>`.
 *    - Non-daemon commands maintain WaitMsBeforeAsync=10000 for synchronous completion.
 * 2. Hard-Routed Native File/Search Inspection (LH-07):
 *    - view_file, read_file, read_many_files -> Deny and route to `rtk read <file>`.
 *    - grep_search -> Deny and route to `rtk grep <pattern>`.
 *    - find_by_name -> Deny and route to `rtk find <path>`.
 *    - list_dir -> Deny and route to `rtk ls` or `rtk tree`.
 *    - Safe Harbor: Documented Antigravity special files (SKILL.md, brain artifacts, configs) are allowed.
 * 3. Root-Based Antigravity Internal State Protection (LH-02):
 *    - Hard denial for any inspection of `.system_generated/` (transcripts, task logs, progress).
 *    - Directed to Agy MCP tools `read_transcript` / `query_transcript`.
 * 4. Closed Lifecycle Governance (LH-03, LH-04, LH-05, LH-06):
 *    - Session-wide ledger without cooldown resets, task-ID resets, or duration exemptions.
 *    - Enforces native Reactive Wakeup (<SYSTEM_MESSAGE>) for background tasks.
 *    - Circuit Breaker: 5 cumulative denials trigger `force_ask` to halt runaway autonomous loops.
 * 5. Benchmark & Evaluator Mutation Protection (LH-09):
 *    - Requires user approval before mutating benchmark definitions, evaluators, or scoring files.
 * 6. Fail-Closed on Governed Operations (LH-10):
 *    - Governed tool failures deny instead of silently allowing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function respond(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(0);
}

const GOVERNED_TOOLS = new Set([
  "manage_task",
  "schedule",
  "run_command",
  "view_file",
  "read_file",
  "read_many_files",
  "grep_search",
  "find_by_name",
  "list_dir",
  "replace_file_content",
  "write_to_file"
]);

const STATE_TTL_MS = 3600000; // 1 hour TTL
const MAX_STATE_ENTRIES = 50;

function getStateFilePath(convId = "global") {
  if (!convId || convId === "global") {
    return path.join(os.tmpdir(), "agy-session-governance-state.json");
  }
  const safeId = String(convId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.tmpdir(), `agy-session-${safeId}.json`);
}

function getSessionState(convId = "global") {
  const file = getStateFilePath(convId);
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
      const entry = (parsed && typeof parsed.pollCount === "number") ? parsed : (parsed && parsed[convId]);
      const now = Date.now();
      if (entry && typeof entry.lastPollTime === "number" && (now - entry.lastPollTime) < STATE_TTL_MS) {
        return entry;
      }
    }
  } catch {}
  return { pollCount: 0, denials: 0, taskIds: [], lastPollTime: 0 };
}

function saveSessionState(convId = "global", entry) {
  const file = getStateFilePath(convId);
  try {
    const now = Date.now();
    entry.lastPollTime = now;
    let toWrite;
    if (!convId || convId === "global") {
      let state = {};
      if (fs.existsSync(file)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
          if (parsed && typeof parsed === "object" && typeof parsed.pollCount !== "number") {
            state = parsed;
          }
        } catch {}
      }
      state[convId] = entry;

      // Prune stale entries
      const entries = Object.entries(state)
        .filter(([_, v]) => v && typeof v.lastPollTime === "number" && (now - v.lastPollTime) < STATE_TTL_MS)
        .sort((a, b) => (b[1].lastPollTime || 0) - (a[1].lastPollTime || 0))
        .slice(0, MAX_STATE_ENTRIES);

      toWrite = JSON.stringify(Object.fromEntries(entries));
    } else {
      toWrite = JSON.stringify(entry);
    }

    const tmpFile = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmpFile, toWrite, "utf-8");
    try {
      fs.renameSync(tmpFile, file);
    } catch {
      fs.writeFileSync(file, toWrite, "utf-8");
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  } catch {}
}

/**
 * Checks if target path references Antigravity internal state by root directory.
 */
function isProtectedInternalState(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const normalized = targetPath.replace(/\\/g, "/");
  return (
    normalized.includes("/.system_generated/") ||
    normalized.endsWith("/.system_generated") ||
    /\.system_generated(?:$|[\/\\])/i.test(normalized)
  );
}

/**
 * Checks if target file is a documented Antigravity special file (skills, brain artifacts, configs).
 */
function isAntigravitySpecialFile(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const normalized = targetPath.replace(/\\/g, "/");

  // If inside .system_generated, it's ALWAYS protected internal state, never a special file
  if (isProtectedInternalState(normalized)) {
    return false;
  }

  // Antigravity skill definitions
  if (normalized.endsWith("/SKILL.md") || normalized === "SKILL.md" || normalized.includes("/skills/")) {
    return true;
  }

  // Antigravity brain markdown artifacts or scratch scripts (outside .system_generated)
  if (normalized.includes("/.gemini/antigravity/brain/")) {
    return true;
  }

  // Gemini / Antigravity plugin, MCP, or configuration files
  if (normalized.includes("/.gemini/config/") || normalized.includes("/.gemini/antigravity/mcp/")) {
    return true;
  }

  // Governance rulebooks
  if (
    normalized.endsWith("/AGENTS.md") ||
    normalized === "AGENTS.md" ||
    normalized.endsWith("/CLAUDE.md") ||
    normalized === "CLAUDE.md" ||
    normalized.includes("/.agents/rules/")
  ) {
    return true;
  }

  return false;
}

/**
 * Checks if a target path is a protected benchmark or evaluation artifact.
 */
function isProtectedBenchmarkPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const normalized = targetPath.replace(/\\/g, "/");
  return (
    /\/(?:benchmarks?|evaluators?|evaluation|scoring|ground_truth|prompt_templates)\//i.test(normalized) ||
    /\/(?:eval_[^\/]+\.(?:py|json|toml)|bench_[^\/]+\.(?:py|json|toml))$/i.test(normalized)
  );
}

let resolvedRtkPath = null;
function getRtkBinary() {
  if (resolvedRtkPath) return resolvedRtkPath;

  // 1. Try global rtk on PATH
  try {
    const check = spawnSync("rtk", ["--version"], { timeout: 1000, windowsHide: true });
    if (check.status === 0) {
      resolvedRtkPath = "rtk";
      return resolvedRtkPath;
    }
  } catch {}

  // 2. Try plugin local bin
  const isWin = os.platform() === "win32";
  const exeName = isWin ? "rtk.exe" : "rtk";
  const homeDir = os.homedir();
  const pluginBin = path.join(homeDir, ".gemini", "config", "plugins", "agy-context-saver", "bin", exeName);
  if (fs.existsSync(pluginBin)) {
    resolvedRtkPath = pluginBin;
    return resolvedRtkPath;
  }

  resolvedRtkPath = "rtk";
  return resolvedRtkPath;
}

const NON_REWRITABLE_BINARIES = new Set([
  "node", "node.exe",
  "powershell", "powershell.exe",
  "pwsh", "pwsh.exe",
  "cmd", "cmd.exe",
  "dir",
  "echo",
  "cd",
  "del",
  "mkdir",
  "rmdir",
  "copy",
  "move",
  "type",
  "cls",
  "clear",
  "set",
  "export"
]);

const REWRITE_CACHE_FILE = path.join(os.tmpdir(), "agy-rtk-rewrite-cache.json");
const REWRITE_CACHE_MAX = 100;
let inMemoryRewriteCache = null;

function loadRewriteCache() {
  if (inMemoryRewriteCache) return inMemoryRewriteCache;
  try {
    if (fs.existsSync(REWRITE_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(REWRITE_CACHE_FILE, "utf-8"));
      if (data && typeof data === "object") {
        inMemoryRewriteCache = data;
        return inMemoryRewriteCache;
      }
    }
  } catch {}
  inMemoryRewriteCache = {};
  return inMemoryRewriteCache;
}

function saveRewriteCache(cache) {
  try {
    const keys = Object.keys(cache);
    let toSave = cache;
    if (keys.length > REWRITE_CACHE_MAX) {
      const slice = keys.slice(keys.length - REWRITE_CACHE_MAX);
      toSave = {};
      for (const k of slice) toSave[k] = cache[k];
    }
    fs.writeFileSync(REWRITE_CACHE_FILE, JSON.stringify(toSave), "utf-8");
  } catch {}
}

/**
 * Rewrite raw shell command using RTK (Rust Token Killer).
 */
function rewriteCommandWithRtk(rawCmd) {
  if (!rawCmd || typeof rawCmd !== "string") return rawCmd;
  const trimmed = rawCmd.trim();
  if (!trimmed) return rawCmd;

  // Already prefixed with rtk
  if (/^rtk(?:\.exe)?\s+/i.test(trimmed)) {
    return trimmed;
  }

  // Fast-path bypass for shell builtins, non-rewritable binaries, and powershell cmdlets
  const firstWord = (trimmed.match(/^[^\s"']+/)?.[0] || "").toLowerCase();
  if (
    NON_REWRITABLE_BINARIES.has(firstWord) ||
    firstWord.startsWith("get-") ||
    firstWord.startsWith("set-") ||
    firstWord.startsWith("start-") ||
    firstWord.startsWith("stop-") ||
    firstWord.startsWith("new-") ||
    firstWord.startsWith("remove-") ||
    firstWord.startsWith("test-")
  ) {
    return trimmed;
  }

  // Check persistent cache
  const cache = loadRewriteCache();
  if (cache[trimmed] !== undefined) {
    return cache[trimmed];
  }

  let rewritten = trimmed;
  try {
    const rtkBin = getRtkBinary();
    const res = spawnSync(rtkBin, ["rewrite", trimmed], {
      encoding: "utf-8",
      timeout: 2000,
      windowsHide: true
    });

    // RTK exits 0 or 3 when rewritten, with new command on stdout
    if ((res.status === 0 || res.status === 3) && res.stdout && res.stdout.trim()) {
      rewritten = res.stdout.trim();
    }
  } catch {}

  cache[trimmed] = rewritten;
  saveRewriteCache(cache);
  return rewritten;
}

// --- Main Hook Entrypoint ---
let isGovernedTool = false;

try {
  const inputRaw = fs.readFileSync(0, "utf-8");
  if (!inputRaw || !inputRaw.trim()) {
    respond({ decision: "allow" });
  }

  // Fast-path string scan (< 1ms)
  let foundGoverned = false;
  for (const name of GOVERNED_TOOLS) {
    if (inputRaw.includes(name)) {
      foundGoverned = true;
      break;
    }
  }

  if (!foundGoverned) {
    respond({ decision: "allow" });
  }

  isGovernedTool = true;
  const payload = JSON.parse(inputRaw);
  const toolCall = payload.toolCall || payload.tool_call || {};
  const toolName = String(toolCall.name || toolCall.tool_name || "").trim().toLowerCase();
  const args = toolCall.args || toolCall.arguments || {};
  const convId = payload.conversationId || "global";

  if (!GOVERNED_TOOLS.has(toolName)) {
    respond({ decision: "allow" });
  }

  isGovernedTool = true;

  // =========================================================================
  // 1. run_command: Transparent RTK Command Optimization & Synchronous Wait
  // =========================================================================
  if (toolName === "run_command") {
    const rawCmd = args.CommandLine !== undefined ? args.CommandLine : args.command;
    if (typeof rawCmd !== "string" || !rawCmd.trim()) {
      respond({
        decision: "deny",
        reason: "Antigravity Governance: Missing or empty CommandLine in run_command."
      });
    }

    const rewritten = rewriteCommandWithRtk(rawCmd);
    const isDaemon = args.IsDaemon === true || args.isDaemon === true;
    const waitMs = args.WaitMsBeforeAsync !== undefined ? args.WaitMsBeforeAsync : args.waitMsBeforeAsync;
    const targetMaxWait = Number(process.env.AGY_MAX_WAIT_MS) || 10000;

    const overwrite = {};
    if (rewritten !== rawCmd) {
      overwrite.CommandLine = rewritten;
    }
    if (!isDaemon && (waitMs === undefined || waitMs < targetMaxWait)) {
      overwrite.WaitMsBeforeAsync = targetMaxWait;
    }

    if (Object.keys(overwrite).length > 0) {
      respond({ decision: "allow", overwrite });
    }
    respond({ decision: "allow" });
  }

  // =========================================================================
  // 2. Native File & Inspection Tools: Root Protection & RTK Hard-Routing
  // =========================================================================
  const INSPECTION_TOOLS = new Set([
    "view_file",
    "read_file",
    "read_many_files",
    "grep_search",
    "find_by_name",
    "list_dir"
  ]);

  if (INSPECTION_TOOLS.has(toolName)) {
    const rawTarget =
      args.AbsolutePath ||
      args.absolutePath ||
      args.targetFile ||
      args.target_file ||
      args.path ||
      args.dirPath ||
      args.dir_path ||
      args.directory ||
      "";
    const target = String(rawTarget).trim();

    // 2a. Internal State Protection by Root (LH-02)
    if (isProtectedInternalState(target) || isProtectedInternalState(JSON.stringify(args))) {
      respond({
        decision: "deny",
        reason:
          "Antigravity Execution Governance: Direct access to internal Antigravity execution state (.system_generated) is strictly prohibited to prevent transcript bloat and polling loops.\n" +
          "- To inspect conversation transcripts: Call MCP tool read_transcript(conversationId=\"...\", mode=\"compact\") or query_transcript(...).\n" +
          "- To inspect background tasks: Yield execution turn and rely on native Reactive Wakeup (<SYSTEM_MESSAGE>). Do not read internal task logs."
      });
    }

    // 2b. Allow Antigravity Special Files (SKILL.md, brain artifacts, configs)
    if (isAntigravitySpecialFile(target)) {
      respond({ decision: "allow" });
    }

    // 2c. Hard-Route Workspace Code/Data Inspection to Canonical RTK Commands (LH-07)
    if (toolName === "view_file" || toolName === "read_file") {
      respond({
        decision: "deny",
        reason: `Antigravity Governance: Native file inspection via '${toolName}' bypasses token optimization. Run 'rtk read ${target || "<file>"}' via run_command instead.`
      });
    }

    if (toolName === "read_many_files") {
      respond({
        decision: "deny",
        reason: "Antigravity Governance: Native multi-file reading via 'read_many_files' bypasses token optimization. Run 'rtk read <file>' via run_command instead."
      });
    }

    if (toolName === "grep_search") {
      const pattern = args.query || args.pattern || "";
      const isWin = os.platform() === "win32";
      const cmdHint = isWin ? `rtk rg "${pattern}" .` : `rtk grep "${pattern}"`;
      respond({
        decision: "deny",
        reason: `Antigravity Governance: Native grep inspection via 'grep_search' bypasses token optimization. Run '${cmdHint}' via run_command instead.`
      });
    }

    if (toolName === "find_by_name") {
      const searchTarget = args.query || args.pattern || target || ".";
      respond({
        decision: "deny",
        reason: `Antigravity Governance: Native file search via 'find_by_name' bypasses token optimization. Run 'rtk find ${searchTarget}' via run_command instead.`
      });
    }

    if (toolName === "list_dir") {
      const isWin = os.platform() === "win32";
      const cmdHint = isWin ? `rtk find ${target || "."}` : `rtk ls ${target || ""}`;
      respond({
        decision: "deny",
        reason: `Antigravity Governance: Native directory listing via 'list_dir' bypasses token optimization. Run '${cmdHint}' via run_command instead.`
      });
    }

    respond({ decision: "allow" });
  }

  // =========================================================================
  // 3. Background Task Lifecycle: Closed Session Ledger & Reactive Wakeup
  // =========================================================================
  if (toolName === "manage_task") {
    const action = String(args.Action || args.action || "").replace(/^["']|["']$/g, "").trim().toLowerCase();

    // kill, send_input are always allowed immediately
    if (action !== "status" && action !== "list") {
      respond({ decision: "allow" });
    }

    const session = getSessionState(convId);
    const taskId = String(args.TaskId || args.taskId || "").trim();
    if (taskId && !session.taskIds.includes(taskId)) {
      session.taskIds.push(taskId);
    }

    // First inspection check in the session is permitted
    if (session.pollCount === 0) {
      session.pollCount = 1;
      saveSessionState(convId, session);
      respond({ decision: "allow" });
    }

    // Any subsequent polling checks in the session are strictly denied
    session.denials++;
    saveSessionState(convId, session);

    if (session.denials >= 5) {
      respond({
        decision: "force_ask",
        reason: `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: manage_task('${action}') has been denied ${session.denials} times across tasks [${session.taskIds.join(", ")}]. Stop calling tools and yield the turn for native Reactive Wakeup (<SYSTEM_MESSAGE>). User confirmation required to proceed.`
      });
    }

    respond({
      decision: "deny",
      reason: `Antigravity Execution Governance: Background task polling is prohibited (${session.denials} denial). Tasks execute asynchronously and notify you automatically via native Reactive Wakeup (<SYSTEM_MESSAGE>) upon completion. Stop calling tools and yield your turn now.`
    });
  }

  if (toolName === "schedule") {
    const prompt = String(args.Prompt || args.prompt || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
    const cond = String(args.TimerCondition || args.timerCondition || "").replace(/^["']|["']$/g, "").trim().toLowerCase();

    const isTaskPoll =
      cond.startsWith("task-") ||
      cond.includes("task") ||
      prompt.includes("check on") ||
      prompt.includes("check task") ||
      prompt.includes("background task") ||
      prompt.includes("still running") ||
      prompt.includes("test suite") ||
      ((prompt.includes("check") || prompt.includes("status") || prompt.includes("poll") || prompt.includes("monitor") || prompt.includes("wait")) &&
       (prompt.includes("task") || prompt.includes("process") || prompt.includes("job") || prompt.includes("test") || prompt.includes("command") || prompt.includes("suite")));

    // All polling timers are strictly denied regardless of duration (LH-03)
    if (isTaskPoll) {
      const session = getSessionState(convId);
      session.denials++;
      saveSessionState(convId, session);

      if (session.denials >= 5) {
        respond({
          decision: "force_ask",
          reason: `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: schedule polling timer has been denied ${session.denials} times. Background tasks notify you automatically upon completion. User confirmation required to proceed.`
        });
      }

      respond({
        decision: "deny",
        reason: "Antigravity Execution Governance: Scheduling timers to poll or monitor background tasks is prohibited regardless of duration. Background tasks notify you automatically via native Reactive Wakeup (<SYSTEM_MESSAGE>). Stop calling tools and yield the turn instead."
      });
    }

    // Non-polling timers (e.g. user-requested reminders) are allowed
    respond({ decision: "allow" });
  }

  // =========================================================================
  // 4. Benchmark & Evaluator Mutation Protection (LH-09)
  // =========================================================================
  if (toolName === "replace_file_content" || toolName === "write_to_file") {
    const targetFile = String(args.TargetFile || args.targetFile || args.path || "").trim();
    if (isProtectedBenchmarkPath(targetFile)) {
      respond({
        decision: "force_ask",
        reason: `[BENCHMARK MUTATION DETECTED] Mutation of protected evaluator/benchmark artifact '${targetFile}' requires explicit user confirmation to prevent benchmark contamination.`
      });
    }
    respond({ decision: "allow" });
  }

  respond({ decision: "allow" });
} catch (err) {
  // Fail-closed for governed tools, fail-open for unclassified non-governed tools (LH-10)
  if (isGovernedTool) {
    respond({
      decision: "deny",
      reason: `Antigravity Governance: Exception encountered while evaluating governed tool call: ${err.message}. Denied for session integrity.`
    });
  }
  respond({ decision: "allow" });
}
