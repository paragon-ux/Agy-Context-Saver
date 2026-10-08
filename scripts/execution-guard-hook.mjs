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
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    const entry = (parsed && typeof parsed.pollCount === "number") ? parsed : (parsed && parsed[convId]);
    const now = Date.now();
    if (entry && typeof entry.lastPollTime === "number" && (now - entry.lastPollTime) < STATE_TTL_MS) {
      return entry;
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
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (parsed && typeof parsed === "object" && typeof parsed.pollCount !== "number") {
          state = parsed;
        }
      } catch {}
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
  return /\.system_generated(?:$|[\/\\])/i.test(targetPath);
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

/**
 * Checks if target path references runtime step output spillover file.
 */
function isStepSpilloverPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  if (!isProtectedInternalState(targetPath)) return false; // cheap precheck
  const normalized = targetPath.replace(/\\/g, "/");
  return (
    /\.system_generated[/\\]steps[/\\]\d+[/\\]output\.txt/i.test(normalized) ||
    (normalized.includes("/.system_generated/steps/") && normalized.endsWith("output.txt"))
  );
}

/**
 * Extracts the task-log reference from a target path or command, or null.
 * Returns { id, token }: `id` is the bare task id; `token` is the matched path text
 * (relative "tasks/task-1.log" or absolute ".../.system_generated/tasks/task-1.log").
 */
function getTaskLogMatch(text) {
  if (!text || typeof text !== "string" || !text.includes(".log")) return null;
  const normalized = text.replace(/\\/g, "/");
  if (!normalized.includes("tasks/")) return null;
  const m = normalized.match(/(?:^|[\s"'])((?:[^\s"']*\/)?tasks\/(?:task-)?([a-zA-Z0-9_-]+)\.log)/i);
  if (!m) return null;
  let token = m[1].replace(/^file:\/\//i, "");
  if (/^\/[A-Za-z]:/.test(token)) token = token.slice(1);
  return { id: m[2], token };
}

const TASK_TAIL_BYTES = 262144; // transcript tail scanned first (256 KB)
const TASK_QUIET_MS = 300000;   // log-mtime fallback: quiet for 5 min => treated as finished

function getBrainDir() {
  return process.env.AGY_BRAIN_DIR || path.join(os.homedir(), ".gemini", "antigravity", "brain");
}

/** Reads the last `bytes` of a file. Returns { text, whole } or null. */
function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString("utf-8"), whole: len === size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * Looks for the finish / start notices of `taskName` in transcript text using literal needles
 * (JSON-escaped and raw variants). Finish: `<conv>/task-N" finished with result`.
 * Start: `<conv>/task-N` followed by a newline and "Task Description" or "Task logs".
 * Returns "COMPLETED", "RUNNING" or null.
 */
function scanTaskMarkers(text, taskName) {
  if (text.includes(`/${taskName}\\" finished`) || text.includes(`/${taskName}" finished`)) return "COMPLETED";
  if (text.includes(`/${taskName}\\nTask `) || text.includes(`/${taskName}\nTask `)) return "RUNNING";
  return null;
}

/**
 * Resolves a background task's lifecycle state: "RUNNING", "COMPLETED" or "UNKNOWN".
 * Authority order: transcript notices (tail first, full file only if needed), then log mtime.
 */
function getTaskState(match, convId) {
  const taskName = `task-${match.id}`;
  const token = match.token;
  let logPath = null;
  let transcript = null;

  if (/^(?:[A-Za-z]:)?\//.test(token)) {
    logPath = token;
    const sysDir = path.posix.dirname(path.posix.dirname(token));
    if (path.posix.basename(sysDir) === ".system_generated") transcript = `${sysDir}/logs/transcript.jsonl`;
  }
  if (convId && convId !== "global") {
    const sysDir = path.join(getBrainDir(), convId, ".system_generated");
    logPath = logPath || path.join(sysDir, "tasks", `${taskName}.log`);
    transcript = transcript || path.join(sysDir, "logs", "transcript.jsonl");
  }

  if (transcript) {
    const tail = readTail(transcript, TASK_TAIL_BYTES);
    if (tail) {
      let state = scanTaskMarkers(tail.text, taskName);
      if (!state && !tail.whole) {
        try { state = scanTaskMarkers(fs.readFileSync(transcript, "utf-8"), taskName); } catch {}
      }
      if (state) return state;
    }
  }

  if (logPath) {
    try {
      return (Date.now() - fs.statSync(logPath).mtimeMs) > TASK_QUIET_MS ? "COMPLETED" : "RUNNING";
    } catch {}
  }
  return "UNKNOWN";
}

/**
 * Runs `rtk rewrite <cmd>`. Spawns the PATH binary directly (a separate `--version` probe doubled
 * the cost of every cache miss); falls back to the plugin-local binary only when PATH has none.
 */
function runRtkRewrite(cmd) {
  const opts = { encoding: "utf-8", timeout: 2000, windowsHide: true };
  const res = spawnSync("rtk", ["rewrite", cmd], opts);
  if (res.error && res.error.code === "ENOENT") {
    const exeName = os.platform() === "win32" ? "rtk.exe" : "rtk";
    const pluginBin = path.join(os.homedir(), ".gemini", "config", "plugins", "agy-context-saver", "bin", exeName);
    if (fs.existsSync(pluginBin)) return spawnSync(pluginBin, ["rewrite", cmd], opts);
  }
  return res;
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

function readRewriteCacheFile() {
  try {
    const data = JSON.parse(fs.readFileSync(REWRITE_CACHE_FILE, "utf-8"));
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {}
  return {};
}

function loadRewriteCache() {
  if (!inMemoryRewriteCache) inMemoryRewriteCache = readRewriteCacheFile();
  return inMemoryRewriteCache;
}

/**
 * Persists one rewrite result. Re-reads the file first so concurrent hook processes merge instead
 * of overwriting each other, trims to the newest entries, and writes atomically (temp + rename).
 */
function rememberRewrite(cmd, rewritten) {
  loadRewriteCache()[cmd] = rewritten;
  try {
    const disk = readRewriteCacheFile();
    delete disk[cmd];
    disk[cmd] = rewritten;
    const keys = Object.keys(disk);
    for (const k of keys.slice(0, Math.max(0, keys.length - REWRITE_CACHE_MAX))) delete disk[k];
    const tmp = `${REWRITE_CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(disk), "utf-8");
    try {
      fs.renameSync(tmp, REWRITE_CACHE_FILE);
    } catch {
      fs.writeFileSync(REWRITE_CACHE_FILE, JSON.stringify(disk), "utf-8");
      try { fs.unlinkSync(tmp); } catch {}
    }
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

  // Unwrap shell wrappers (e.g. cmd /c "...", powershell -Command "...", bash -c "...") (LH-01-B)
  const shellWrapperMatch = trimmed.match(
    /^(cmd(?:\.exe)?\s+\/[cC]|(?:powershell|pwsh)(?:\.exe)?\s+(?:-Command|-c)|(?:bash|sh)\s+-c)\s+["']?(.+?)["']?$/i
  );
  if (shellWrapperMatch) {
    const wrapperPrefix = shellWrapperMatch[1];
    const innerCmd = shellWrapperMatch[2].trim();
    const rewrittenInner = rewriteCommandWithRtk(innerCmd);
    if (rewrittenInner !== innerCmd) {
      return `${wrapperPrefix} "${rewrittenInner}"`;
    }
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
  let cacheable = false;
  try {
    const res = runRtkRewrite(trimmed);
    // Never cache timeouts, spawn errors or signals: a transient failure must not pin a command
    // to "no rewrite" for the lifetime of the cache.
    cacheable = !res.error && !res.signal && typeof res.status === "number" && res.status >= 0 && res.status <= 3;

    // RTK exits 0 or 3 when rewritten, with new command on stdout
    if ((res.status === 0 || res.status === 3) && res.stdout && res.stdout.trim()) {
      rewritten = res.stdout.trim();
    }
  } catch {}

  if (cacheable) rememberRewrite(trimmed, rewritten);
  return rewritten;
}

/**
 * Calculates the required minimum cooldown interval (in seconds)
 * proportional to the number of diagnostic status inspections already performed.
 * Formula: Math.min(600, Math.round(30 * Math.pow(2.5, Math.max(0, pollCount - 1))))
 * Levels: Level 0 -> 0s (baseline), Level 1 -> 30s, Level 2 -> 75s, Level 3 -> 188s, Level 4 -> 469s, Level 5+ -> 600s
 */
function getRequiredBackoffSeconds(pollCount) {
  if (pollCount <= 0) return 0;
  return Math.min(600, Math.round(30 * Math.pow(2.5, Math.max(0, pollCount - 1))));
}

/**
 * Denies reading the log of an actively RUNNING task: records the denial, trips the circuit
 * breaker at 5 cumulative denials, otherwise answers with the Proportional Backoff message.
 */
function denyRunningTask(taskId, convId) {
  const session = getSessionState(convId);
  session.denials++;
  saveSessionState(convId, session);

  if (session.denials >= 5) {
    respond({
      decision: "force_ask",
      reason: `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: reading task log '${taskId}' attempted prematurely ${session.denials} times during active backoff window. Stop calling tools and yield the turn for native Reactive Wakeup (<SYSTEM_MESSAGE>). User confirmation required to proceed.`
    });
  }

  const requiredBackoffSec = Math.max(30, getRequiredBackoffSeconds(session.pollCount));
  const requiredBackoffMs = requiredBackoffSec * 1000;
  const elapsedMs = session.lastPollTime ? (Date.now() - session.lastPollTime) : Infinity;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const remainingSec = Math.max(1, Math.ceil((requiredBackoffMs - elapsedMs) / 1000));

  respond({
    decision: "deny",
    reason: `Antigravity Execution Governance: Task '${taskId}' is actively RUNNING. Reading task logs in .system_generated during execution is strictly prohibited to prevent polling loops. Diagnostic check #${session.pollCount + 1} requires at least ${requiredBackoffSec}s elapsed (${elapsedSec}s elapsed, ${remainingSec}s remaining). Tasks execute asynchronously and notify you automatically via native Reactive Wakeup (<SYSTEM_MESSAGE>) upon completion. Stop calling tools and yield your turn now.`
  });
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

    // LH-09-B: Shell command mutation of protected benchmark artifacts
    if (
      (rawCmd.includes(">") || /\b(?:rm|del|Remove-Item)\b/i.test(rawCmd)) &&
      isProtectedBenchmarkPath(rawCmd)
    ) {
      respond({
        decision: "force_ask",
        reason:
          "[BENCHMARK MUTATION DETECTED] Shell command mutation of protected evaluator/benchmark artifact requires explicit user confirmation to prevent benchmark contamination."
      });
    }

    // Raw-command governance gates are pure string/fs checks: run them BEFORE the rtk rewrite
    // spawn so denied commands never pay for a subprocess.
    const isSpillover = isStepSpilloverPath(rawCmd);
    const taskMatch = isSpillover ? null : getTaskLogMatch(rawCmd);

    // Check 1: Other protected internal state (transcripts, scheduler, progress)
    if (!isSpillover && !taskMatch && isProtectedInternalState(rawCmd)) {
      respond({
        decision: "deny",
        reason:
          "Antigravity Execution Governance: Direct shell access to internal Antigravity execution state (.system_generated) is strictly prohibited to prevent transcript bloat and polling loops.\n" +
          "- To inspect conversation transcripts: Call MCP tool read_transcript(conversationId=\"...\", mode=\"compact\") or query_transcript(...).\n" +
          "- To inspect background tasks: Yield execution turn and rely on native Reactive Wakeup (<SYSTEM_MESSAGE>). Do not read internal task logs."
      });
    }

    // Check 2: Task Log Inspection (Lifecycle-Gated, 0 New Tools): RUNNING => Proportional Backoff
    if (taskMatch && getTaskState(taskMatch, convId) === "RUNNING") {
      denyRunningTask(taskMatch.id, convId);
    }

    const rewritten = rewriteCommandWithRtk(rawCmd);
    const effectiveCmd = rewritten;
    const isRtkRead = /^rtk(?:\.exe)?\s+read\b/i.test(effectiveCmd);

    // Check 3: Step Output Spillover Safe Harbor (rtk read only; it clamps + windows output)
    if (isSpillover && !isRtkRead) {
      respond({
        decision: "deny",
        reason:
          "Antigravity Execution Governance: Runtime step output spillover files must be inspected using 'rtk read <path>' via run_command to prevent context blowouts."
      });
    }

    // Check 4: Terminated / unknown-state task log: allow only through rtk read
    if (taskMatch && !isRtkRead) {
      respond({
        decision: "deny",
        reason:
          "Antigravity Execution Governance: Direct shell access to internal Antigravity execution state (.system_generated) is strictly prohibited to prevent transcript bloat and polling loops.\n" +
          `- Once completed, inspect output using 'rtk read <path>' via run_command.\n` +
          "- If actively running, yield execution turn and rely on native Reactive Wakeup (<SYSTEM_MESSAGE>)."
      });
    }

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

    // 2a. Step Output Spillover Safe Harbor (hard-route to rtk read)
    if (isStepSpilloverPath(target)) {
      respond({
        decision: "deny",
        reason: `Antigravity Governance: Native file inspection via '${toolName}' bypasses token optimization. Run 'rtk read ${target}' via run_command instead.`
      });
    }

    // 2b. Task Log Inspection (Lifecycle-Gated)
    const taskMatch = getTaskLogMatch(target);
    if (taskMatch) {
      const state = getTaskState(taskMatch, convId);
      if (state === "RUNNING") {
        denyRunningTask(taskMatch.id, convId);
      }

      if (state === "COMPLETED") {
        // If terminated / completed, route to rtk read:
        respond({
          decision: "deny",
          reason: `Antigravity Governance: Native file inspection via '${toolName}' bypasses token optimization. Run 'rtk read ${target}' via run_command instead.`
        });
      }

      // If not verified completed (or does not exist):
      respond({
        decision: "deny",
        reason:
          "Antigravity Execution Governance: Direct access to internal Antigravity execution state (.system_generated/tasks) is strictly prohibited to prevent polling loops. rely on native Reactive Wakeup (<SYSTEM_MESSAGE>) upon completion."
      });
    }

    // 2c. Other Internal State Protection by Root (LH-02)
    if (isProtectedInternalState(target) || isProtectedInternalState(JSON.stringify(args))) {
      respond({
        decision: "deny",
        reason:
          "Antigravity Execution Governance: Direct access to internal Antigravity execution state (.system_generated) is strictly prohibited to prevent transcript bloat and polling loops.\n" +
          "- To inspect conversation transcripts: Call MCP tool read_transcript(conversationId=\"...\", mode=\"compact\") or query_transcript(...).\n" +
          "- To inspect background tasks: Yield execution turn and rely on native Reactive Wakeup (<SYSTEM_MESSAGE>). Do not read internal task logs."
      });
    }

    // 2d. Allow Antigravity Special Files (SKILL.md, brain artifacts, configs)
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

    const now = Date.now();
    const requiredBackoffSec = Math.max(30, getRequiredBackoffSeconds(session.pollCount));
    const requiredBackoffMs = requiredBackoffSec * 1000;
    const elapsedMs = session.lastPollTime ? (now - session.lastPollTime) : Infinity;
    const elapsedSec = Math.floor(elapsedMs / 1000);

    // Premature check before backoff interval has elapsed
    if (elapsedMs < requiredBackoffMs) {
      session.denials++;
      saveSessionState(convId, session);

      if (session.denials >= 5) {
        respond({
          decision: "force_ask",
          reason: `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: manage_task('${action}') called prematurely ${session.denials} times during active backoff window across tasks [${session.taskIds.join(", ")}]. Stop calling tools and yield the turn for native Reactive Wakeup (<SYSTEM_MESSAGE>). User confirmation required to proceed.`
        });
      }

      const remainingSec = Math.ceil((requiredBackoffMs - elapsedMs) / 1000);
      respond({
        decision: "deny",
        reason: `Antigravity Execution Governance: Proportional Backoff Active (Level ${session.pollCount}, ${session.denials} denial${session.denials > 1 ? "s" : ""}). Diagnostic check #${session.pollCount + 1} requires at least ${requiredBackoffSec}s elapsed since previous check (${elapsedSec}s elapsed, ${remainingSec}s remaining). Tasks execute asynchronously and notify you automatically via native Reactive Wakeup (<SYSTEM_MESSAGE>) upon completion. Stop calling tools and yield your turn now.`
      });
    }

    // Backoff window satisfied! Allow diagnostic check and advance level:
    session.pollCount++;
    session.lastPollTime = now;
    session.denials = 0;
    saveSessionState(convId, session);
    respond({ decision: "allow" });
  }

  if (toolName === "schedule") {
    const prompt = String(args.Prompt || args.prompt || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
    const cond = String(args.TimerCondition || args.timerCondition || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
    const duration = Number(args.DurationSeconds || args.durationSeconds || args.duration || 0);

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

    if (isTaskPoll) {
      const session = getSessionState(convId);
      const requiredBackoffSec = Math.max(30, getRequiredBackoffSeconds(session.pollCount));

      // Task watchdog timers must be AT LEAST the required backoff window!
      if (duration < requiredBackoffSec) {
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
          reason: `Antigravity Execution Governance: Task watchdog timer duration too short (${duration}s, ${session.denials} denial${session.denials > 1 ? "s" : ""}). Under Proportional Backoff (Level ${session.pollCount}), watchdog timer must be at least ${requiredBackoffSec}s. Tasks notify you automatically via native Reactive Wakeup (<SYSTEM_MESSAGE>). Stop calling tools and yield the turn instead.`
        });
      }

      // If duration >= requiredBackoffSec, watchdog timer is permitted!
      respond({ decision: "allow" });
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
