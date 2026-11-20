#!/usr/bin/env node

/**
 * Agy-Context-Saver: Intelligent Execution Governor Hook for Antigravity (v2.1.1)
 *
 * Closed Execution Topology & Governance Invariants:
 * 1. RTK Transparent Command Optimization:
 *    - Delegates command rewriting to `rtk hook antigravity` (>= 1.1.0) via stdin JSON.
 *    - Reverts lossy `rtk wc` / `rtk ls` / `rtk diff` rewrites unless explicitly requested.
 *    - Never emits `rtk rg` when `rg` is absent on PATH (maps safe invocations to `rtk grep`
 *      with explicit path, or strips `rtk ` when rg-only flags are used).
 *    - Sets WaitMsBeforeAsync=10000 only when `!isDaemon && waitMs === undefined`.
 * 2. Hard-Routed Native File/Search Inspection (LH-07):
 *    - read_file & view_file -> Symmetrical Safe Harbor + Hybrid Slice (<= 150 lines, or
 *      explicit full-file StartLine=1..EndLine=TotalLines when <= 800 lines & <= 45 KiB);
 *      bounded read_file (<= 150 lines) allowed on `.system_generated/steps/<n>/output.txt`.
 *    - read_many_files, grep_search, find_by_name, list_dir -> Hard-routed to RTK CLI.
 * 3. Root-Based Antigravity Internal State Protection (LH-02):
 *    - Quote/heredoc-aware shell parser (`splitShellSegments`) protects `.system_generated/`
 *      without false-blocking heredoc prose, `echo`/`printf`, or literal search patterns.
 *    - Allows strictly single unchained `rtk read <spillover|completed task log>` and
 *      `agy-context transcript (read|query|step|health|list|export|access) ...` within `<brainDir>`.
 * 4. Closed Lifecycle Governance (LH-03, LH-04, LH-05, LH-06):
 *    - Session-wide ledger with proportional backoff and 5-denial `force_ask` circuit breaker.
 * 5. Benchmark & Evaluator Mutation Protection (LH-09):
 *    - Requires user approval (`force_ask`) for `edit_file`, `write_file`,
 *      `replace_file_content`, `write_to_file`, and destructive shell commands.
 * 6. Fail-Closed on Governed Operations (LH-10).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let activeHookCwd = "";
let activeTranscriptPath = "";

function resolveHookPath(p) {
  if (!p || typeof p !== "string") return "";
  return activeHookCwd ? path.resolve(activeHookCwd, p) : path.resolve(p);
}

const HOOK_DEDUP_TTL_MS = 5000;
const HOOK_SAME_ARG_CROSS_SCRIPT_MS = 500;
const MAX_SAFE_SLICE_LINES = 150;
const MAX_FULL_FILE_LINES = 800;
const MAX_FULL_FILE_BYTES = 45 * 1024; // 45 KiB (46,080 bytes)
let dedupRecordCtx = null;

function respond(obj) {
  if (dedupRecordCtx && dedupRecordCtx.convId) {
    try {
      const latest = getSessionState(dedupRecordCtx.convId);
      const now = Date.now();
      let outSig = dedupRecordCtx.rawSig;
      if (obj && obj.overwrite && typeof obj.overwrite === "object") {
        try {
          const parsedRaw = JSON.parse(dedupRecordCtx.rawSig);
          outSig = JSON.stringify({ ...parsedRaw, ...obj.overwrite });
        } catch {}
      }
      const prevList = Array.isArray(latest.recentHookCalls) ? latest.recentHookCalls : [];
      const freshList = prevList.filter((e) => e && typeof e.ts === "number" && (now - e.ts) < HOOK_DEDUP_TTL_MS);
      freshList.push({
        ts: now,
        callId: dedupRecordCtx.callId || "",
        stepIdx: dedupRecordCtx.stepIdx !== undefined ? dedupRecordCtx.stepIdx : null,
        toolName: dedupRecordCtx.toolName,
        scriptPath: dedupRecordCtx.scriptPath,
        rawSig: dedupRecordCtx.rawSig,
        outSig,
        response: obj
      });
      latest.recentHookCalls = freshList.slice(-8);
      saveSessionState(dedupRecordCtx.convId, latest, { updatePollTime: false });
    } catch {}
  }
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
  "write_to_file",
  "write_file",
  "edit_file"
]);

const STATE_TTL_MS = 3600000; // 1 hour TTL
const MAX_STATE_ENTRIES = 50;
const MAX_TASK_BACKOFF_ENTRIES = 64;

// Per-user state folder, never the shared os.tmpdir(). Keep identical to scripts/state-dir.mjs:
// this hook is mirrored as a standalone file, so it can't import it.
function getStateDir() {
  const profileHome = process.env.AGY_TEST_PROFILE_DIR;
  if (os.platform() === "win32") {
    const localAppData = profileHome
      ? path.join(profileHome, "AppData", "Local")
      : (process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"));
    return path.join(localAppData, "agy-context-saver");
  }
  const stateHome = profileHome
    ? path.join(profileHome, ".local", "state")
    : (process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"));
  return path.join(stateHome, "agy-context-saver");
}

function ensureStateDir() {
  try { fs.mkdirSync(getStateDir(), { recursive: true }); } catch {}
}

function getStateFilePath(convId = "global") {
  if (!convId || convId === "global") {
    return path.join(getStateDir(), "agy-session-governance-state.json");
  }
  const safeId = String(convId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(getStateDir(), `agy-session-${safeId}.json`);
}

function getSessionState(convId = "global") {
  const file = getStateFilePath(convId);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    const entry = (parsed && typeof parsed.pollCount === "number") ? parsed : (parsed && parsed[convId]);
    const now = Date.now();
    const activityTime = Math.max(entry?.lastPollTime || 0, entry?.lastSeenTime || 0);
    if (entry && activityTime > 0 && (now - activityTime) < STATE_TTL_MS) {
      if (!entry.taskBackoff || typeof entry.taskBackoff !== "object" || Array.isArray(entry.taskBackoff)) {
        entry.taskBackoff = {};
      }
      return entry;
    }
  } catch {}
  return { pollCount: 0, denials: 0, taskIds: [], taskBackoff: {}, lastPollTime: 0, lastSeenTime: 0, recentHookCalls: [] };
}

function saveSessionState(convId = "global", entry, { updatePollTime = true } = {}) {
  const file = getStateFilePath(convId);
  ensureStateDir();
  try {
    const now = Date.now();
    entry.lastSeenTime = now;
    if (updatePollTime) {
      entry.lastPollTime = now;
    }
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
        .filter(([_, v]) => {
          const ts = Math.max(v?.lastPollTime || 0, v?.lastSeenTime || 0);
          return v && ts > 0 && (now - ts) < STATE_TTL_MS;
        })
        .sort((a, b) => Math.max(b[1].lastPollTime || 0, b[1].lastSeenTime || 0) - Math.max(a[1].lastPollTime || 0, a[1].lastSeenTime || 0))
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

function matchesRawProtectedInternalState(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  if (/\.system_generated(?:$|[\/\\])/i.test(targetPath)) return true;
  if (/(?:^|[\/\\'"`\s=:])\.system_gen/i.test(targetPath)) return true;
  if (/['"]\.system_['"]\s*(?:[+.]\s*)?['"]gen/i.test(targetPath)) return true;
  if (/['"]\.['"]\s*(?:[+.]\s*)?['"]system_gen/i.test(targetPath)) return true;
  if (/\btranscript(?:_full)?\.jsonl\b/i.test(targetPath)) return true;
  if (/\.gemini[\/\\]+antigravity(?:-cli|-ide)?[\/\\]+brain[\/\\]+(?:[^\/\\\s'"]+[\/\\]?)?$/i.test(targetPath)) {
    return true;
  }
  if (/\.gemini[\/\\]+antigravity(?:-cli|-ide)?[\/\\]+brain[\/\\]+.*(?:logs[\/\\]|tasks[\/\\]|steps[\/\\]|\$)/i.test(targetPath)) {
    return true;
  }
  // Block hidden segments (e.g. .s*/*/*, .*) or wildcard globs directly under brain/<convId>/ (allowing .agents/)
  if (/\.gemini[\/\\]+antigravity(?:-cli|-ide)?[\/\\]+brain[\/\\]+(?:[^\/\\\s'"]+[\/\\]+)?(?:\.(?!agents(?:$|[\/\\]))|[*?\[])/i.test(targetPath)) {
    return true;
  }
  // Protect Agy-Context-Saver state directory and session/policy JSON files
  if (/\b(?:transcript-access|agy-session-governance-state|agy-rtk-rewrite-cache)\.json\b/i.test(targetPath)) return true;
  if (/\bagy-session-[a-zA-Z0-9_-]+\.json\b/i.test(targetPath)) return true;
  if (/[\/\\]\.local[\/\\]+state[\/\\]+agy-context-saver(?:$|[\/\\'"`\s])/i.test(targetPath)) return true;
  if (/[\/\\]AppData[\/\\]+Local[\/\\]+agy-context-saver(?:$|[\/\\'"`\s])/i.test(targetPath)) return true;
  try {
    const stateDirNorm = getStateDir().replace(/\\/g, "/");
    const targetNorm = targetPath.replace(/\\/g, "/");
    if (stateDirNorm && targetNorm.includes(stateDirNorm)) return true;
  } catch {}
  if (/\bbase64\b[\s\S]*\|\s*(?:[^\s|]+\/)?(?:ba|z|da|a)?sh\b/i.test(targetPath)) return true;
  return false;
}

function isProtectedShellOrScriptOperation(text, options = {}) {
  if (!text || typeof text !== "string") return false;
  if (isProtectedInternalState(text)) return true;

  // Non-canonical or wrapped agy-context transcript invocations that did not pass checkAgyContextTranscriptCommand
  if (/(?:^|[\s;|&('"\/\\])agy-context(?:-saver)?(?:\.m?js)?['"]?\s+(?:-[^\s;|&'"]+\s+)*transcript(?:\s|$|['";|&)])/i.test(text)) {
    return true;
  }

  // Inline interpreter or script execution importing/spawning transcript-core.mjs, bin/agy-context.mjs, or retired Agy-Context-Saver mcp/index.js
  if (
    /(?:\b(?:import|require|spawn|spawnSync|exec|execSync|execFile|execFileSync|popen|system|subprocess)\b|(?:^|[\s;|&(])(?:node|python[23]?|perl|ruby|php|bash|sh|zsh|dash)\b[^\n;|&]*?(?:\s-[a-z]*[ec]\b|<<))[\s\S]*?(?:\btranscript-core(?:\.m?js)?\b|(?:bin[\/\\]+|\b)agy-context(?:-saver)?\.m?js\b|\bagy-context-saver[\/\\]+mcp[\/\\]+index\.js\b)/i.test(
      text
    )
  ) {
    return true;
  }

  // Unconditionally block Antigravity-specific governance or brain env redirection inside shell commands/scripts
  if (/(?:^|[\s;|&(])(?:AGY_TEST_PROFILE_DIR|AGY_BRAIN_DIR|GEMINI_CONVERSATION_ID)=/i.test(text)) {
    return true;
  }
  if (
    /(?:process\.env|os\.environ)\s*(?:\.\s*(?:AGY_TEST_PROFILE_DIR|AGY_BRAIN_DIR|GEMINI_CONVERSATION_ID)\b|\[\s*['"](?:AGY_TEST_PROFILE_DIR|AGY_BRAIN_DIR|GEMINI_CONVERSATION_ID)['"]\s*\])/i.test(
      text
    )
  ) {
    return true;
  }

  // Scope standard OS env vars (XDG_STATE_HOME, LOCALAPPDATA) so ordinary user tests run cleanly in non-restricted
  // sessions, while blocking restricted child sessions and commands targeting governance or .gemini state
  const touchesStateEnv =
    /(?:^|[\s;|&(])(?:XDG_STATE_HOME|LOCALAPPDATA)=/i.test(text) ||
    /(?:process\.env|os\.environ)\s*(?:\.\s*(?:XDG_STATE_HOME|LOCALAPPDATA)\b|\[\s*['"](?:XDG_STATE_HOME|LOCALAPPDATA)['"]\s*\])/i.test(
      text
    );
  if (touchesStateEnv) {
    const isRestrictedChild = Boolean(options.isRestrictedChild);
    const targetsGovernanceState =
      /\bagy-context(?:-saver)?\b|\bexecution-guard\b|\btranscript(?:-access|-core)?\b|\.gemini\b/i.test(text);
    if (isRestrictedChild || targetsGovernanceState) {
      return true;
    }
  }

  // Block symlinks, bulk copies/archives, file reads, or directory enumeration of <brainDir>/<convId> outside /scratch/, /browser_sandbox/, /swarm_view/, or .agents/ (in either order)
  const hasUnprotectedBrainRef =
    /\.gemini[\/\\]+antigravity(?:-cli|-ide)?[\/\\]+brain[\/\\]+(?![^\s'"]*[\/\\](?:scratch|browser_sandbox|swarm_view|\.agents)(?:$|[\/\\])|[^\s'"]*\.(?:md|txt|json|png|jpg|jpeg|svg|html|css|webp|pdf)\b)/i.test(
      text
    );
  if (
    hasUnprotectedBrainRef &&
    /\b(?:ln|cp|mv|rsync|tar|zip|find|readdir|readdirSync|scandir|listdir|walk|glob|iglob|readFile|readFileSync|createReadStream|open|openSync)\b/i.test(
      text
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Checks if target path or shell operand references Antigravity internal state or obfuscated smuggling
 * (including runtime Base64, URL-safe Base64, Hex, escape, or char-code path decoding).
 */
function isProtectedInternalState(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  if (matchesRawProtectedInternalState(targetPath)) return true;

  // Decode candidate Base64 / URL-safe Base64 substrings (length >= 16) to block runtime path decoding
  // e.g. python3 b64decode(...), node Buffer.from(..., 'base64'), $(echo <b64> | base64 -d)
  const b64Matches = targetPath.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g);
  if (b64Matches) {
    for (const rawTok of b64Matches) {
      const norm = rawTok.replace(/-/g, "+").replace(/_/g, "/");
      for (const offset of [0, 1, 2]) {
        const slice = norm.slice(offset);
        if (slice.length < 16) continue;
        try {
          const decoded = Buffer.from(slice, "base64").toString("utf-8");
          if (
            matchesRawProtectedInternalState(decoded) ||
            /\.system_gen|transcript(?:_full)?\.jsonl/i.test(decoded)
          ) {
            return true;
          }
        } catch {}
      }
    }
  }

  // Decode candidate Hex substrings (length >= 24) to block Buffer.from(..., 'hex') / bytes.fromhex(...) / xxd -r
  const hexMatches = targetPath.match(/[0-9a-fA-F]{24,}/g);
  if (hexMatches) {
    for (const rawHex of hexMatches) {
      for (const offset of [0, 1]) {
        const slice = rawHex.slice(offset);
        const evenSlice = slice.length % 2 === 0 ? slice : slice.slice(0, -1);
        if (evenSlice.length < 24) continue;
        try {
          const decoded = Buffer.from(evenSlice, "hex").toString("utf-8");
          if (
            matchesRawProtectedInternalState(decoded) ||
            /\.system_gen|transcript(?:_full)?\.jsonl/i.test(decoded)
          ) {
            return true;
          }
        } catch {}
      }
    }
  }

  // Decode \xNN hex escapes or String.fromCharCode / chr() integer sequences
  if (/\\x[0-9a-fA-F]{2}/.test(targetPath)) {
    const unescaped = targetPath.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    if (matchesRawProtectedInternalState(unescaped) || /\.system_gen|transcript(?:_full)?\.jsonl/i.test(unescaped)) {
      return true;
    }
  }
  if (/(?:fromCharCode|\bchr\s*\(|\bbytes\s*\(\s*\[)/i.test(targetPath)) {
    const nums = targetPath.match(/\b(?:3[2-9]|[4-9]\d|1[01]\d|12[0-6])\b/g);
    if (nums && nums.length >= 10) {
      const decoded = nums.map((n) => String.fromCharCode(Number(n))).join("");
      if (matchesRawProtectedInternalState(decoded) || /\.system_gen|transcript(?:_full)?\.jsonl/i.test(decoded)) {
        return true;
      }
    }
  }

  return false;
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

  // Antigravity skill definitions & documented skill bundles (do not match arbitrary app paths like src/skills/hero.ts)
  if (
    normalized.endsWith("/SKILL.md") ||
    normalized === "SKILL.md" ||
    /(?:^|\/)(?:\.agents?|\.gemini(?:\/antigravity(?:-cli|-ide)?\/builtin)?|\.claude)\/skills\//i.test(normalized)
  ) {
    return true;
  }

  // Antigravity brain markdown artifacts or scratch scripts (outside .system_generated)
  if (/\/\.gemini\/antigravity(?:-cli|-ide)?\/brain\//i.test(normalized)) {
    return true;
  }

  // Gemini / Antigravity plugin, MCP, or configuration files
  if (normalized.includes("/.gemini/config/") || /\/\.gemini\/antigravity(?:-cli|-ide)?\/mcp\//i.test(normalized)) {
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
    /(?:^|\/)(?:benchmarks?|evaluators?|evaluation|scoring|ground_truth|prompt_templates)\//i.test(normalized) ||
    /(?:^|\/)(?:eval_[^\/]+\.(?:py|json|toml)|bench_[^\/]+\.(?:py|json|toml))$/i.test(normalized)
  );
}

/**
 * Allows top-level non-restricted user sessions to opt out of benchmark-folder mutation prompts
 * via AGY_DISABLE_BENCHMARK_GUARD=1 (ignored for restricted child sessions).
 */
function isBenchmarkGuardDisabled(convId = "global") {
  const raw = String(process.env.AGY_DISABLE_BENCHMARK_GUARD || "").trim().toLowerCase();
  if (raw !== "1" && raw !== "true") return false;
  if (evaluateCallerTranscriptAccess(convId).isRestrictedChild) return false;
  return true;
}

/**
 * Expands a leading `~/` or `~\` prefix against the active Antigravity profile home directory.
 */
function expandLeadingTilde(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return "";
  const trimmed = targetPath.trim();
  if (trimmed === "~") return getProfileHomeDir();
  if (/^~[/\\]/.test(trimmed)) {
    return path.join(getProfileHomeDir(), trimmed.slice(2));
  }
  return trimmed;
}

/**
 * Strips optional `file://` scheme and leading `/C:` Windows URI slash from a path token.
 */
function cleanFileToken(targetPath) {
  let tok = String(targetPath || "").trim().replace(/^file:\/\//i, "");
  if (/^\/[A-Za-z]:/.test(tok)) tok = tok.slice(1);
  return tok;
}

/**
 * Checks if target path strictly matches runtime step output spillover:
 * `<prefix>/.system_generated/steps/<digits>/output.txt` (or relative `.system_generated/steps/<digits>/output.txt`).
 */
function isStepSpilloverPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const normalized = cleanFileToken(targetPath).replace(/\\/g, "/");
  return /(?:^|\/)\.system_generated\/steps\/\d+\/output\.txt$/i.test(normalized);
}

/**
 * Returns all step spillover path tokens found in a tokenized command array.
 */
function findStepSpilloverTokens(tokens) {
  const found = [];
  for (const tok of tokens) {
    const clean = cleanFileToken(tok);
    if (isStepSpilloverPath(clean)) found.push(clean);
  }
  return found;
}

/**
 * Checks whether any path token in a command string strictly contains a step spillover path.
 */
function findStepSpilloverToken(tokens) {
  const found = findStepSpilloverTokens(tokens);
  return found.length > 0 ? found[0] : null;
}

function resolveRealOrAncestorPath(targetPath) {
  const resolved = path.resolve(targetPath);
  const tail = [];
  let cursor = resolved;
  while (true) {
    try {
      const realCursor = fs.realpathSync(cursor);
      return tail.length > 0 ? path.join(realCursor, ...tail.reverse()) : realCursor;
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      tail.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isInsideAntigravityBrainPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const cmp = os.platform() === "win32" || os.platform() === "darwin" ? (s) => s.toLowerCase() : (s) => s;
  const rawNorm = path.resolve(targetPath).replace(/\\/g, "/");
  const realNorm = resolveRealOrAncestorPath(targetPath).replace(/\\/g, "/");
  const candidateTargets = rawNorm === realNorm ? [rawNorm] : [rawNorm, realNorm];

  for (const cand of candidateTargets) {
    if (/(?:^|\/)\.system_generated(?:\/|$)/i.test(cand)) return true;
    if (/\/\.gemini\/antigravity(?:-cli|-ide)?\/brain(?:\/|$)/i.test(cand)) return true;
  }

  const brainNorms = [];
  for (const bDir of getBrainDirs()) {
    if (!bDir) continue;
    const rawBrain = cmp(path.resolve(bDir).replace(/\\/g, "/").replace(/\/+$/, ""));
    brainNorms.push(rawBrain);
    const realBrain = cmp(resolveRealOrAncestorPath(bDir).replace(/\\/g, "/").replace(/\/+$/, ""));
    if (realBrain !== rawBrain) brainNorms.push(realBrain);
  }

  for (const cand of candidateTargets) {
    const nTarget = cmp(cand);
    for (const nBrain of brainNorms) {
      if (nTarget === nBrain || nTarget.startsWith(`${nBrain}/`)) return true;
    }
  }
  return false;
}

/**
 * Extracts `{ id, token, realPath? }` if a single file path token matches an Antigravity internal
 * `tasks/*.log` path (not an ordinary user workspace log file), or null.
 * Resolves workspace symlinks so symlinks pointing into `.system_generated/` stay gated.
 * Preserves spaces inside full path tokens.
 */
function matchTaskLogToken(targetPath, convId = "global") {
  if (!targetPath || typeof targetPath !== "string") return null;
  const clean = cleanFileToken(targetPath);
  const normalized = clean.replace(/\\/g, "/");
  const m = normalized.match(/^(?:.+\/)?tasks\/(?:task-)?([a-zA-Z0-9_-]+)\.log$/i);
  if (!m) return null;

  // 1. Explicit `.system_generated/tasks/*.log` paths are always Antigravity internal task logs
  if (/(?:^|\/)\.system_generated\/tasks\/[^/]+\.log$/i.test(normalized)) {
    return { id: m[1], token: normalized };
  }

  const buildBrainMatch = (resolvedCandidate) => {
    const realNorm = resolveRealOrAncestorPath(resolvedCandidate).replace(/\\/g, "/");
    const realTaskMatch = realNorm.match(/(?:^|\/)tasks\/(?:task-)?([a-zA-Z0-9_-]+)\.log$/i);
    return {
      id: realTaskMatch ? realTaskMatch[1] : m[1],
      token: normalized,
      realPath: realNorm
    };
  };

  const expanded = expandLeadingTilde(clean);
  const normExpanded = expanded.replace(/\\/g, "/");
  const isAbs = path.isAbsolute(expanded) || /^(?:[A-Za-z]:)?\//.test(normExpanded);

  // 2. Absolute or `~/`-expanded paths are internal task logs only when inside an Antigravity brain root (following symlinks)
  if (isAbs) {
    return isInsideAntigravityBrainPath(expanded) ? buildBrainMatch(expanded) : null;
  }

  // 3. Relative paths whose resolved cwd location (or symlink realpath) falls inside `.system_generated` or a brain root
  const cwdResolved = resolveHookPath(expanded);
  if (cwdResolved && isInsideAntigravityBrainPath(cwdResolved)) {
    return buildBrainMatch(cwdResolved);
  }

  // 4. Only bare relative shorthand `tasks/<name>.log` (or `./tasks/<name>.log`) can reference
  //    `<brainDir>/<convId>/.system_generated/tasks/<name>.log`; nested project paths like
  //    `logs/tasks/worker.log` are ordinary workspace files.
  const bareRelMatch = normalized.match(/^(?:\.\/)?tasks\/([^/]+\.log)$/i);
  if (!bareRelMatch) return null;

  const literalBase = bareRelMatch[1];
  const taskId = m[1];
  if (convId && convId !== "global") {
    for (const bDir of getBrainDirs()) {
      const sysDir = path.join(bDir, convId, ".system_generated");
      const { chosenLog } = pickTaskFilesInSysDir(sysDir, taskId, literalBase);
      if (fs.existsSync(chosenLog)) {
        return { id: taskId, token: normalized };
      }
    }
  }

  // If a real workspace file exists at `<cwd>/tasks/<name>.log` (outside brain dirs), treat it as workspace code/log
  if (cwdResolved && fs.existsSync(cwdResolved)) {
    return null;
  }

  // Preserve Antigravity shorthand gating for canonical `tasks/task-<id>.log` references when no workspace file exists
  if (/^task-[a-zA-Z0-9_-]+\.log$/i.test(literalBase)) {
    return { id: taskId, token: normalized };
  }

  return null;
}

/**
 * Extracts all `{ id, token }` task-log references across command/script text or a single target path,
 * preserving spaces inside quoted spans and full tokens.
 */
function extractTaskLogMatches(text, convId = "global") {
  if (!text || typeof text !== "string" || !text.includes(".log")) return [];
  const normalized = text.replace(/\\/g, "/");
  if (!normalized.includes("tasks/")) return [];

  const matches = [];
  const pushMatch = (m) => {
    if (!m) return;
    if (matches.some((existing) => existing.id === m.id && existing.token.endsWith(m.token))) return;
    const filtered = matches.filter((existing) => !(existing.id === m.id && m.token.endsWith(existing.token)));
    if (filtered.length !== matches.length) {
      matches.length = 0;
      matches.push(...filtered);
    }
    matches.push(m);
  };

  for (const tok of tokenizeShellWords(text)) {
    pushMatch(matchTaskLogToken(tok, convId));
  }

  const spanRe = /"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'()=;,\[\]{}]+)/g;
  let sm;
  while ((sm = spanRe.exec(normalized)) !== null) {
    const cand = sm[1] ?? sm[2] ?? sm[3] ?? "";
    const directCand = matchTaskLogToken(cand, convId);
    if (directCand) {
      pushMatch(directCand);
      continue;
    }
    const innerRe = /(?:^|[\s"'(=,;\[{])((?:[^\s"'(=,;\[{]*\/)?tasks\/(?:task-)?([a-zA-Z0-9_-]+)\.log)(?=$|[\s"');,\]}])/gi;
    let im;
    while ((im = innerRe.exec(cand)) !== null) {
      pushMatch(matchTaskLogToken(im[1], convId));
    }
  }
  return matches;
}

/**
 * Extracts the first task-log reference from a target path or command, or null.
 * Returns { id, token }: `id` is the bare task id; `token` is the matched path text.
 */
function getTaskLogMatch(text, convId = "global") {
  const matches = extractTaskLogMatches(text, convId);
  return matches.length > 0 ? matches[0] : null;
}

const TASK_TAIL_BYTES = 262144; // transcript tail scanned first (256 KB)
const TASK_QUIET_MS = 300000;   // log-mtime fallback: quiet for 5 min => treated as finished

function getProfileHomeDir() {
  return process.env.AGY_TEST_PROFILE_DIR || os.homedir();
}

function inferBrainRootFromTranscriptPath(tp) {
  if (!tp || typeof tp !== "string") return "";
  const norm = tp.replace(/\\/g, "/");
  const m = norm.match(/^(.+?\/brain)(?:\/[^/]+\/\.system_generated\/.*)?$/i);
  if (m) {
    return os.platform() === "win32" ? path.normalize(m[1]) : m[1];
  }
  return "";
}

function getBrainDirs() {
  if (process.env.AGY_BRAIN_DIR && process.env.AGY_BRAIN_DIR.trim()) {
    return [process.env.AGY_BRAIN_DIR.trim()];
  }
  const home = getProfileHomeDir();
  const candidates = [
    path.join(home, ".gemini", "antigravity", "brain"),
    path.join(home, ".gemini", "antigravity-cli", "brain"),
    path.join(home, ".gemini", "antigravity-ide", "brain")
  ];
  const fromTranscript = inferBrainRootFromTranscriptPath(activeTranscriptPath);
  if (fromTranscript && !candidates.includes(fromTranscript)) {
    candidates.unshift(fromTranscript);
  }
  const existing = candidates.filter((dir) => {
    try { return fs.existsSync(dir); } catch { return false; }
  });
  return existing.length > 0 ? existing : [candidates[0]];
}

function getBrainDir() {
  const fromTranscript = inferBrainRootFromTranscriptPath(activeTranscriptPath);
  if (fromTranscript && !(process.env.AGY_BRAIN_DIR && process.env.AGY_BRAIN_DIR.trim())) {
    return fromTranscript;
  }
  return process.env.AGY_BRAIN_DIR || path.join(getProfileHomeDir(), ".gemini", "antigravity", "brain");
}

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

function scanTaskMarkers(text, taskName) {
  if (
    text.includes(`/${taskName}\\" finished`) ||
    text.includes(`/${taskName}" finished`) ||
    text.includes(`/${taskName}\\" was canceled`) ||
    text.includes(`/${taskName}" was canceled`) ||
    text.includes(`/${taskName}\\" cancelled.`) ||
    text.includes(`/${taskName}" cancelled.`)
  ) {
    return "COMPLETED";
  }
  const hasOneShotTimerLaunch =
    text.includes(`/${taskName}\\nTask Description: Timer:`) ||
    text.includes(`/${taskName}\nTask Description: Timer:`);
  if (hasOneShotTimerLaunch && text.includes(`/${taskName} priority=`)) {
    return "COMPLETED";
  }
  if (text.includes(`/${taskName}\\nTask `) || text.includes(`/${taskName}\nTask `)) return "RUNNING";
  return null;
}

/**
 * Picks candidate log and transcript paths inside one `.system_generated` directory,
 * checking the exact literal filename (`tasks/custom.log`) before `task-<id>.log`.
 */
function pickTaskFilesInSysDir(sysDir, taskName, literalBase) {
  const candidateTranscript = path.join(sysDir, "logs", "transcript.jsonl");
  const literalLog = literalBase ? path.join(sysDir, "tasks", literalBase) : "";
  const prefixedLog = path.join(sysDir, "tasks", `${taskName}.log`);
  let chosenLog = prefixedLog;
  if (literalLog && literalBase.toLowerCase() !== `${taskName}.log`.toLowerCase() && fs.existsSync(literalLog)) {
    chosenLog = literalLog;
  } else if (fs.existsSync(prefixedLog)) {
    chosenLog = prefixedLog;
  } else if (literalLog && literalBase) {
    chosenLog = literalLog;
  }
  return { candidateTranscript, chosenLog };
}

/**
 * Strips one or more leading `./` or `.\` segments from a relative path.
 */
function stripLeadingDotSlash(p) {
  return String(p || "").replace(/^(?:\.[\/\\])+/g, "");
}

/**
 * Resolves the task log name, candidate log path, and transcript path for a matched task token.
 * Expands leading `~/`, checks cwd-relative `.system_generated/tasks/` paths, resolves
 * relative `<otherConvId>/.system_generated/tasks/...` (with or without leading `./`) across
 * `getBrainDirs()`, and falls back to non-`task-` literal log filenames when present.
 */
function resolveTaskPaths(match, convId) {
  const taskName = `task-${match.id}`;
  const expandedTok = expandLeadingTilde(cleanFileToken(match.token));
  const normExpanded = expandedTok.replace(/\\/g, "/");
  const normRel = stripLeadingDotSlash(normExpanded);
  const literalBase = /\.log$/i.test(normExpanded) ? path.posix.basename(normExpanded) : "";
  let logPath = null;
  let transcript = null;

  if (match.realPath && /^(?:[A-Za-z]:)?\//.test(match.realPath)) {
    const realSysDir = path.posix.dirname(path.posix.dirname(match.realPath));
    if (path.posix.basename(realSysDir) === ".system_generated") {
      logPath = match.realPath;
      transcript = `${realSysDir}/logs/transcript.jsonl`;
    }
  }
  if (!logPath && /^(?:[A-Za-z]:)?\//.test(normExpanded)) {
    logPath = normExpanded;
    const sysDir = path.posix.dirname(path.posix.dirname(normExpanded));
    if (path.posix.basename(sysDir) === ".system_generated") transcript = `${sysDir}/logs/transcript.jsonl`;
  } else if (!logPath) {
    const cwdResolved = resolveHookPath(expandedTok);
    const cwdSysDir = cwdResolved ? path.dirname(path.dirname(cwdResolved)) : "";
    if (
      cwdResolved &&
      path.basename(cwdSysDir) === ".system_generated" &&
      (fs.existsSync(cwdResolved) || fs.existsSync(path.join(cwdSysDir, "logs", "transcript.jsonl")))
    ) {
      logPath = cwdResolved.replace(/\\/g, "/");
      transcript = path.join(cwdSysDir, "logs", "transcript.jsonl").replace(/\\/g, "/");
    } else {
      const relCrossMatch = normRel.match(/^([^/]+)\/\.system_generated\/tasks\/([^/]+\.log)$/i);
      const targetConv = relCrossMatch ? relCrossMatch[1] : (convId && convId !== "global" ? convId : "");
      if (targetConv) {
        for (const bDir of getBrainDirs()) {
          const sysDir = path.join(bDir, targetConv, ".system_generated");
          const { candidateTranscript, chosenLog } = pickTaskFilesInSysDir(sysDir, taskName, literalBase);
          if (fs.existsSync(candidateTranscript) || fs.existsSync(chosenLog)) {
            logPath = chosenLog;
            transcript = candidateTranscript;
            break;
          }
        }
        if (!logPath || !transcript) {
          const sysDir = path.join(getBrainDir(), targetConv, ".system_generated");
          const { candidateTranscript, chosenLog } = pickTaskFilesInSysDir(sysDir, taskName, literalBase);
          logPath = logPath || chosenLog;
          transcript = transcript || candidateTranscript;
        }
      }
    }
  }
  if (!transcript && convId && convId !== "global" && !/^([^/]+)\/\.system_generated\//i.test(normRel)) {
    for (const bDir of getBrainDirs()) {
      const sysDir = path.join(bDir, convId, ".system_generated");
      const candidateTranscript = path.join(sysDir, "logs", "transcript.jsonl");
      if (fs.existsSync(candidateTranscript)) {
        transcript = candidateTranscript;
        break;
      }
    }
  }
  return { taskName, logPath, transcript };
}

/**
 * Builds deduplicated candidate paths to stat for `>45 KiB` spillover and task-log bounds checks,
 * expanding `~/` and resolving relative tokens (including leading `./`) against active brain dirs
 * when absent from `activeHookCwd`.
 */
function resolveInternalReadStatPaths(candidateTok, convId, taskMatch, isSpillover) {
  const cleanTok = cleanFileToken(candidateTok);
  const expandedTok = expandLeadingTilde(cleanTok);
  const normalizedTok = expandedTok.replace(/\\/g, "/");
  const normRel = stripLeadingDotSlash(normalizedTok);
  const results = [];
  const directPath = resolveHookPath(expandedTok);
  if (directPath) results.push(directPath);

  const isAbs = path.isAbsolute(expandedTok) || /^(?:[A-Za-z]:)?\//.test(normalizedTok);
  if (!isAbs) {
    const brainDirs = getBrainDirs();
    if (/^[^/]+\/\.system_generated\//i.test(normRel)) {
      for (const bDir of brainDirs) {
        results.push(path.join(bDir, normRel));
      }
    }
    if (convId && convId !== "global") {
      const tokTaskMatch =
        (taskMatch && cleanTok.replace(/\\/g, "/") === cleanFileToken(taskMatch.token).replace(/\\/g, "/") ? taskMatch : null) ||
        matchTaskLogToken(expandedTok, convId);
      if (tokTaskMatch) {
        const resolved = resolveTaskPaths(tokTaskMatch, convId);
        if (resolved.logPath) results.push(resolved.logPath);
        const baseLog = /\.log$/i.test(normalizedTok) ? path.posix.basename(normalizedTok) : "";
        if (baseLog) {
          for (const bDir of brainDirs) {
            results.push(path.join(bDir, convId, ".system_generated", "tasks", baseLog));
          }
        }
      }
      if (isSpillover && isStepSpilloverPath(normalizedTok)) {
        const spillMatch = normalizedTok.match(/(?:^|\/)(\.system_generated\/steps\/\d+\/output\.txt)$/i);
        if (spillMatch) {
          for (const bDir of brainDirs) {
            results.push(path.join(bDir, convId, spillMatch[1]));
          }
        }
      }
    }
  }
  return [...new Set(results.filter(Boolean))];
}

/**
 * Returns true if any resolved disk path for an internal spillover or task log exceeds 45 KiB.
 */
function isOversizedInternalTarget(target, convId, taskMatchObj, isSpilloverTarget) {
  for (const statPath of resolveInternalReadStatPaths(target, convId, taskMatchObj, isSpilloverTarget)) {
    try {
      const st = fs.statSync(statPath);
      if (st.isFile()) return st.size > MAX_FULL_FILE_BYTES;
    } catch {}
  }
  return false;
}

function getTaskState(match, convId) {
  const { taskName, logPath, transcript } = resolveTaskPaths(match, convId);

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

// ============================================================================
// RTK Resolution & `rtk hook antigravity` Delegation
// ============================================================================

function isCompatibleRtkVersion(versionStr) {
  if (!versionStr || typeof versionStr !== "string") return false;
  const match = versionStr.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  return major > 1 || (major === 1 && minor >= 1);
}

function findExecutableOnPath(baseName) {
  const pathEnv = process.env.PATH || process.env.Path || "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const isWin = os.platform() === "win32";
  const exts = isWin ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${baseName}${ext}`);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (!isWin) {
          fs.accessSync(candidate, fs.constants.X_OK);
        }
        return candidate;
      } catch {}
    }
  }
  return "";
}

function getLocalRtkCandidate() {
  const names = os.platform() === "win32" ? ["rtk.exe", "rtk.cmd"] : ["rtk"];
  const hookDir = path.dirname(fileURLToPath(import.meta.url));
  for (const exeName of names) {
    const pluginBin = path.join(getProfileHomeDir(), ".gemini", "config", "plugins", "agy-context-saver", "bin", exeName);
    if (fs.existsSync(pluginBin)) return pluginBin;
  }
  if (!process.env.AGY_TEST_PROFILE_DIR) {
    for (const exeName of names) {
      const repoBin = path.resolve(hookDir, "..", "bin", exeName);
      if (fs.existsSync(repoBin)) return repoBin;
    }
  }
  return "";
}

function resolveInstalledAgyContextCommand(binName = "agy-context") {
  const profileHome = getProfileHomeDir();
  const isWin = os.platform() === "win32";
  const pluginCli = path.join(profileHome, ".gemini", "config", "plugins", "agy-context-saver", "bin", "agy-context.mjs");
  const resolvePluginCli = () => {
    try {
      if (fs.statSync(pluginCli).isFile()) {
        return `node "${pluginCli.replace(/\\/g, "/")}"`;
      }
    } catch {}
    return "";
  };

  // On Windows, prefer `node "<pluginCli>"` over a `.cmd` shim path so spaces in %USERPROFILE%
  // execute cleanly across PowerShell, cmd.exe, and Git Bash without leading-quote parse errors.
  if (isWin) {
    const nodeCliCmd = resolvePluginCli();
    if (nodeCliCmd) return nodeCliCmd;
  }

  const candidateNames = binName === "agy-context-saver"
    ? ["agy-context-saver", "agy-context"]
    : ["agy-context", "agy-context-saver"];
  for (const name of candidateNames) {
    const shimFile = path.join(profileHome, ".gemini", "antigravity", "bin", isWin ? `${name}.cmd` : name);
    try {
      const st = fs.statSync(shimFile);
      if (!st.isFile()) continue;
      if (!isWin) fs.accessSync(shimFile, fs.constants.X_OK);
      const formatted = isWin ? shimFile : shimFile.replace(/\\/g, "/");
      return /\s/.test(formatted) ? `"${formatted}"` : formatted;
    } catch {}
  }

  return isWin ? "" : resolvePluginCli();
}

function getTrustedLocalRtkLauncherCandidates() {
  const hookDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(getProfileHomeDir(), ".gemini", "config", "plugins", "agy-context-saver", "scripts", "rtk-run.mjs"),
    path.resolve(hookDir, "rtk-run.mjs")
  ];
  return [...new Set(candidates)];
}

function resolveLocalRtkLauncher(localCandidate = "") {
  if (localCandidate) {
    const pairedLauncher = path.resolve(path.dirname(localCandidate), "..", "scripts", "rtk-run.mjs");
    try {
      if (fs.statSync(pairedLauncher).isFile() && isTrustedLocalRtkLauncherPath(pairedLauncher)) {
        return pairedLauncher;
      }
    } catch {}
  }
  for (const candidate of getTrustedLocalRtkLauncherCandidates()) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return "";
}

function isTrustedLocalRtkLauncherPath(candidatePath) {
  if (!candidatePath || typeof candidatePath !== "string") return false;
  const clean = cleanFileToken(candidatePath);
  if (!/(?:^|[\\/])rtk-run\.mjs$/i.test(clean)) return false;
  const isCaseInsensitive = os.platform() === "win32" || os.platform() === "darwin";
  const normalizeCmp = (p) => {
    let resolved = path.resolve(p);
    try {
      resolved = fs.realpathSync(resolved);
    } catch {}
    const slash = resolved.replace(/\\/g, "/");
    return isCaseInsensitive ? slash.toLowerCase() : slash;
  };
  const targetNorm = normalizeCmp(clean);
  for (const trusted of getTrustedLocalRtkLauncherCandidates()) {
    if (normalizeCmp(trusted) === targetNorm) return true;
  }
  return false;
}

function spawnRtk(bin, args, opts = {}) {
  if (!bin) return { error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }), status: null, stdout: "", stderr: "" };
  const baseEnv = opts.env || process.env;
  const mergedEnv = {
    ...baseEnv,
    RTK_SUPPRESS_HOOK_WARNING: baseEnv.RTK_SUPPRESS_HOOK_WARNING ?? "1"
  };
  const spawnOpts = { ...opts, env: mergedEnv };
  if (os.platform() === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    const comspec =
      mergedEnv.ComSpec ||
      mergedEnv.COMSPEC ||
      path.join(mergedEnv.SystemRoot || mergedEnv.windir || "C:\\Windows", "System32", "cmd.exe");
    const quotedBin = /\s/.test(bin) ? `"${bin}"` : bin;
    const quotedArgs = args.map((a) => (/\s|["&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
    return spawnSync(comspec, ["/d", "/s", "/c", `"${quotedBin} ${quotedArgs}"`], { ...spawnOpts, windowsVerbatimArguments: true });
  }
  return spawnSync(bin, args, spawnOpts);
}

const ENV_CACHE_TTL_MS = 60000;
let cachedRtkKey = null;
let cachedRtkValue = undefined;
let cachedRgKey = null;
let cachedRgValue = undefined;

function getFileMtimeMsSafe(p) {
  if (!p) return 0;
  try {
    return Math.trunc(fs.statSync(p).mtimeMs);
  } catch {
    return 0;
  }
}

function readEnvCacheRaw() {
  try {
    const cacheFile = path.join(getStateDir(), "env-cache.json");
    if (!fs.existsSync(cacheFile)) return null;
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    if (parsed && typeof parsed.ts === "number" && (Date.now() - parsed.ts) < ENV_CACHE_TTL_MS) {
      return parsed;
    }
  } catch {}
  return null;
}

function writeEnvCacheRaw(entry) {
  try {
    ensureStateDir();
    const cacheFile = path.join(getStateDir(), "env-cache.json");
    const tmpFile = `${cacheFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(entry), "utf-8");
    try {
      fs.renameSync(tmpFile, cacheFile);
    } catch {
      fs.writeFileSync(cacheFile, JSON.stringify(entry), "utf-8");
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  } catch {}
}

function resolveCachedHostEnv() {
  const pathEnv = process.env.PATH || process.env.Path || "";
  const localCandidate = getLocalRtkCandidate();
  const winLauncher = os.platform() === "win32" ? resolveLocalRtkLauncher(localCandidate) : "";
  const parsed = readEnvCacheRaw();

  // Fast-path when cache was written by this hook with full pathEnv + candidate metadata (skips multi-dir PATH stat scans)
  if (
    parsed &&
    typeof parsed.pathEnv === "string" &&
    parsed.pathEnv === pathEnv &&
    parsed.localCandidate === localCandidate &&
    (parsed.winLauncher || "") === winLauncher &&
    typeof parsed.pathCandidate === "string" &&
    typeof parsed.rgAvailable === "boolean"
  ) {
    const fastKey = `${parsed.pathCandidate}::${localCandidate}::${getFileMtimeMsSafe(parsed.pathCandidate)}::${getFileMtimeMsSafe(localCandidate)}::${winLauncher}`;
    const rgValid =
      !parsed.rgAvailable ||
      (typeof parsed.rgPath === "string" &&
        parsed.rgPath.length > 0 &&
        getFileMtimeMsSafe(parsed.rgPath) === parsed.rgMtime &&
        parsed.rgMtime > 0);
    if (parsed.key === fastKey && rgValid) {
      cachedRtkKey = fastKey;
      cachedRtkValue = parsed.resolved ?? null;
      cachedRgKey = pathEnv;
      cachedRgValue = parsed.rgAvailable;
      return { rtk: cachedRtkValue, rgAvailable: cachedRgValue };
    }
  }

  const pathCandidate = findExecutableOnPath("rtk");
  const key = `${pathCandidate}::${localCandidate}::${getFileMtimeMsSafe(pathCandidate)}::${getFileMtimeMsSafe(localCandidate)}::${winLauncher}`;
  if (cachedRtkKey === key && cachedRtkValue !== undefined && cachedRgKey === pathEnv && cachedRgValue !== undefined) {
    return { rtk: cachedRtkValue, rgAvailable: cachedRgValue };
  }

  // Legacy / test-poisoned cache fallback (when env-cache.json only has { key, ts, resolved })
  if (parsed && parsed.key === key && typeof parsed.pathEnv !== "string") {
    cachedRtkKey = key;
    cachedRtkValue = parsed.resolved ?? null;
    const rgAvailable = cachedRgKey === pathEnv && cachedRgValue !== undefined
      ? cachedRgValue
      : Boolean(findExecutableOnPath("rg"));
    cachedRgKey = pathEnv;
    cachedRgValue = rgAvailable;
    return { rtk: cachedRtkValue, rgAvailable };
  }

  const opts = { encoding: "utf-8", timeout: 2000, windowsHide: true };
  let resolved = null;

  // Prefer PATH rtk (>= 1.1.0) before local binaries
  if (pathCandidate) {
    const pathRes = spawnRtk(pathCandidate, ["--version"], opts);
    if (!pathRes.error && pathRes.status === 0 && isCompatibleRtkVersion(pathRes.stdout)) {
      resolved = { exe: pathCandidate, prefix: "rtk" };
    }
  }

  if (!resolved && localCandidate) {
    const localRes = spawnRtk(localCandidate, ["--version"], opts);
    if (!localRes.error && localRes.status === 0 && isCompatibleRtkVersion(localRes.stdout)) {
      const normalizedLocal = localCandidate.replace(/\\/g, "/");
      // On Windows, route off-PATH local RTK through `node "<rtk-run.mjs>"` so CommandLine
      // never starts with a double-quoted path (which fails PowerShell parsing for spaced %USERPROFILE%).
      let prefix;
      if (os.platform() === "win32" && winLauncher) {
        prefix = `node "${winLauncher.replace(/\\/g, "/")}"`;
      } else {
        prefix = /\s/.test(normalizedLocal) ? `"${normalizedLocal}"` : normalizedLocal;
      }
      resolved = { exe: localCandidate, prefix };
    }
  }

  const rgPath = findExecutableOnPath("rg");
  const rgAvailable = Boolean(rgPath);
  const rgMtime = getFileMtimeMsSafe(rgPath);

  cachedRtkKey = key;
  cachedRtkValue = resolved;
  cachedRgKey = pathEnv;
  cachedRgValue = rgAvailable;
  writeEnvCacheRaw({
    key,
    ts: Date.now(),
    resolved,
    pathEnv,
    pathCandidate,
    localCandidate,
    winLauncher,
    rgAvailable,
    rgPath,
    rgMtime
  });
  return { rtk: resolved, rgAvailable };
}

function resolveCompatibleRtk() {
  return resolveCachedHostEnv().rtk;
}

function isRgAvailableCached() {
  return resolveCachedHostEnv().rgAvailable;
}

// ============================================================================
// Quote- & Heredoc-Aware Shell Segment Parser & Tokenizer
// ============================================================================

const SHELL_ESCAPE_CHARS = new Set([" ", "\t", "\n", "\r", ";", "|", "&", "<", ">", "(", ")", '"', "'", "\\", "$", "`"]);

function parseHeredocTag(cmd, pos) {
  // Assumes cmd[pos] === '<' && cmd[pos + 1] === '<' && cmd[pos + 2] !== '<'
  let i = pos + 2;
  let stripTabs = false;
  if (cmd[i] === "-") {
    stripTabs = true;
    i++;
  }
  while (i < cmd.length && (cmd[i] === " " || cmd[i] === "\t")) i++;
  if (i >= cmd.length) return null;

  let delim = "";
  let quoted = false;
  const ch = cmd[i];
  if (ch === "'" || ch === '"') {
    quoted = true;
    const q = ch;
    i++;
    while (i < cmd.length && cmd[i] !== q && cmd[i] !== "\n" && cmd[i] !== "\r") {
      if (q === '"' && cmd[i] === "\\" && i + 1 < cmd.length) {
        i++;
      }
      delim += cmd[i++];
    }
    if (i < cmd.length && cmd[i] === q) i++;
  } else {
    while (i < cmd.length && !/[\s;|&<>()"']/.test(cmd[i])) {
      if (cmd[i] === "\\" && i + 1 < cmd.length) {
        quoted = true;
        i++;
      }
      delim += cmd[i++];
    }
  }

  if (!delim) return null;
  return { delim, stripTabs, quoted, endIndex: i };
}

function readBalancedSubshell(cmd, startPos) {
  // startPos points right after "$("
  let i = startPos;
  let depth = 1;
  let inSingle = false;
  let inDouble = false;

  while (i < cmd.length && depth > 0) {
    const c = cmd[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (c === "\\" && i + 1 < cmd.length) {
        i += 2;
        continue;
      }
      if (c === '"') inDouble = false;
      else if (c === "$" && cmd[i + 1] === "(") {
        depth++;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length && SHELL_ESCAPE_CHARS.has(cmd[i + 1])) {
      i += 2;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      i++;
    } else if (c === '"') {
      inDouble = true;
      i++;
    } else if (c === "(") {
      depth++;
      i++;
    } else if (c === ")") {
      depth--;
      i++;
    } else {
      i++;
    }
  }

  const endInner = depth === 0 ? i - 1 : i;
  return { inner: cmd.slice(startPos, endInner), nextIndex: i };
}

function readBacktickSubshell(cmd, startPos) {
  // startPos points right after opening "`"
  let i = startPos;
  let inner = "";
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "\\" && i + 1 < cmd.length) {
      inner += cmd[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      return { inner, nextIndex: i + 1 };
    }
    inner += c;
    i++;
  }
  return { inner, nextIndex: i };
}

/**
 * Splits a shell command string into segments while respecting single/double quotes,
 * backslash escapes, `$()` / backtick subshells, process substitutions, and `<<DELIM ... DELIM`
 * heredoc bodies.
 */
function splitShellSegments(command) {
  if (!command || typeof command !== "string") return [];

  const segments = [];
  const pendingHeredocs = [];
  let inSingle = false;
  let inDouble = false;

  let segStart = 0;
  let leadingSep = "";
  let hasRedirect = false;
  let hasWriteRedirect = false;
  let hasHeredoc = false;
  let hasSubshell = false;
  let subshells = [];
  let heredocBodies = [];
  let firstHeredocSegIdx = -1;

  const pushSegment = (endOffset) => {
    const raw = command.slice(segStart, endOffset);
    const trimmed = raw.trim();
    if (trimmed || hasHeredoc) {
      const leadWS = raw.length - raw.trimStart().length;
      const trailWS = raw.length - raw.trimEnd().length;
      segments.push({
        text: trimmed,
        raw,
        start: segStart + leadWS,
        end: Math.max(segStart + leadWS, endOffset - trailWS),
        leadingSep,
        hasRedirect,
        hasWriteRedirect,
        hasHeredoc,
        heredocBodies,
        hasSubshell,
        subshells
      });
      if (hasHeredoc && firstHeredocSegIdx === -1) {
        firstHeredocSegIdx = segments.length - 1;
      }
    }
    leadingSep = "";
    hasRedirect = false;
    hasWriteRedirect = false;
    hasHeredoc = false;
    hasSubshell = false;
    subshells = [];
    heredocBodies = [];
  };

  let i = 0;
  while (i < command.length) {
    const c = command[i];
    const next = command[i + 1];

    if (inSingle) {
      if (c === "'") inSingle = false;
      i++;
      continue;
    }

    if (inDouble) {
      if (c === "\\" && i + 1 < command.length) {
        i += 2;
        continue;
      }
      if (c === '"') {
        inDouble = false;
        i++;
      } else if (c === "$" && next === "(") {
        hasSubshell = true;
        const sub = readBalancedSubshell(command, i + 2);
        subshells.push(sub.inner);
        i = sub.nextIndex;
      } else if (c === "`") {
        hasSubshell = true;
        const sub = readBacktickSubshell(command, i + 1);
        subshells.push(sub.inner);
        i = sub.nextIndex;
      } else {
        i++;
      }
      continue;
    }

    // Backslash escape outside quotes (preserve Windows paths like C:\Users\...)
    if (c === "\\") {
      if (next === "\r" && command[i + 2] === "\n") {
        i += 3;
        continue;
      }
      if (next !== undefined && SHELL_ESCAPE_CHARS.has(next)) {
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (c === "'") {
      inSingle = true;
      i++;
      continue;
    }

    if (c === '"') {
      inDouble = true;
      i++;
      continue;
    }

    // Comments (# at start of segment or after whitespace)
    if (c === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
      while (i < command.length && command[i] !== "\n") i++;
      continue;
    }

    // Subshells & process substitutions
    if ((c === "$" || c === "<" || c === ">") && next === "(") {
      hasSubshell = true;
      if (c === "<" || c === ">") hasRedirect = true;
      const sub = readBalancedSubshell(command, i + 2);
      subshells.push(sub.inner);
      i = sub.nextIndex;
      continue;
    }

    if (c === "(") {
      hasSubshell = true;
      const sub = readBalancedSubshell(command, i + 1);
      subshells.push(sub.inner);
      i = sub.nextIndex;
      continue;
    }

    if (c === "`") {
      hasSubshell = true;
      const sub = readBacktickSubshell(command, i + 1);
      subshells.push(sub.inner);
      i = sub.nextIndex;
      continue;
    }

    // Heredocs << / <<- vs here-string <<< vs input redirect <
    if (c === "<") {
      if (next === "<" && command[i + 2] !== "<") {
        const tag = parseHeredocTag(command, i);
        if (tag) {
          hasHeredoc = true;
          pendingHeredocs.push(tag);
          i = tag.endIndex;
          continue;
        }
      }
      hasRedirect = true;
      i += next === "<" ? (command[i + 2] === "<" ? 3 : 2) : 1;
      continue;
    }

    if (c === ">") {
      hasRedirect = true;
      hasWriteRedirect = true;
      i += next === ">" ? 2 : 1;
      continue;
    }

    // Newline: flush current segment, then consume any pending heredoc bodies
    if (c === "\n" || (c === "\r" && next === "\n")) {
      const nlLen = c === "\r" ? 2 : 1;
      pushSegment(i);
      i += nlLen;

      if (pendingHeredocs.length > 0) {
        const targetIdx = firstHeredocSegIdx !== -1 ? firstHeredocSegIdx : segments.length - 1;
        while (pendingHeredocs.length > 0) {
          const hd = pendingHeredocs.shift();
          const bodyLines = [];
          while (i < command.length) {
            const nlPos = command.indexOf("\n", i);
            const lineEnd = nlPos === -1 ? command.length : nlPos;
            const rawLine = command.slice(i, lineEnd).replace(/\r$/, "");
            const checkLine = hd.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
            i = nlPos === -1 ? command.length : nlPos + 1;
            if (checkLine === hd.delim) {
              break;
            }
            bodyLines.push(rawLine);
          }
          if (targetIdx >= 0 && segments[targetIdx]) {
            segments[targetIdx].heredocBodies.push(bodyLines.join("\n"));
          }
        }
        firstHeredocSegIdx = -1;
      }

      segStart = i;
      leadingSep = "\n";
      continue;
    }

    // Operators: &&, ||, |&, |, ;, &
    if (c === "&" && next === "&") {
      pushSegment(i);
      i += 2;
      segStart = i;
      leadingSep = "&&";
      continue;
    }
    if (c === "|" && next === "|") {
      pushSegment(i);
      i += 2;
      segStart = i;
      leadingSep = "||";
      continue;
    }
    if (c === "|" && next === "&") {
      pushSegment(i);
      i += 2;
      segStart = i;
      leadingSep = "|&";
      continue;
    }
    if (c === "|") {
      pushSegment(i);
      i += 1;
      segStart = i;
      leadingSep = "|";
      continue;
    }
    if (c === ";") {
      pushSegment(i);
      i += 1;
      segStart = i;
      leadingSep = ";";
      continue;
    }
    if (c === "&") {
      // Exclude fd redirects like >&2, 2>&1, <&0, &>file
      const prevChar = i > 0 ? command[i - 1] : "";
      if (prevChar === ">" || prevChar === "<") {
        hasRedirect = true;
        i++;
        continue;
      }
      if (next === ">") {
        hasRedirect = true;
        hasWriteRedirect = true;
        i += 2;
        continue;
      }
      pushSegment(i);
      i += 1;
      segStart = i;
      leadingSep = "&";
      continue;
    }

    i++;
  }

  pushSegment(command.length);
  return segments;
}

/**
 * Tokenizes a single shell segment into words (preserving raw token text & unquoted value).
 */
const REDIRECT_OP_REGEX = /^(?:&>>?|(?:\d+)?(?:>>?|<<<?|<<-|<&|>&|>\||<>))$/;
const REDIRECT_ATTACHED_REGEX = /^(?:\d+)?(?:>>?|<<?)(.+)$/;

function tokenizeShellWordsDetailed(text) {
  const tokens = [];
  let i = 0;

  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;

    const start = i;
    let value = "";
    let quoted = false;

    while (i < text.length && !/\s/.test(text[i])) {
      const c = text[i];
      if (c === ">" || c === "<") {
        if (i > start) {
          const prefixRaw = text.slice(start, i);
          const isFdOrAmpPrefix = !quoted && (/^\d+$/.test(prefixRaw) || (c === ">" && prefixRaw === "&"));
          if (!isFdOrAmpPrefix) {
            break;
          }
        }
        i++;
        if (i < text.length && (text[i] === c || text[i] === "&" || (c === ">" && text[i] === "|") || (c === "<" && text[i] === ">"))) {
          i++;
          if (i < text.length && (text[i] === "<" || text[i] === ">" || text[i] === "-")) {
            i++;
          }
        }
        value = text.slice(start, i);
        break;
      } else if (c === "&" && i + 1 < text.length && text[i + 1] === ">" && i === start) {
        i += 2;
        if (i < text.length && text[i] === ">") i++;
        value = text.slice(start, i);
        break;
      } else if (c === "'") {
        quoted = true;
        i++;
        while (i < text.length && text[i] !== "'") {
          value += text[i++];
        }
        if (i < text.length && text[i] === "'") i++;
      } else if (c === '"') {
        quoted = true;
        i++;
        while (i < text.length && text[i] !== '"') {
          if (text[i] === "\\" && i + 1 < text.length && (text[i + 1] === '"' || text[i + 1] === "\\" || text[i + 1] === "$" || text[i + 1] === "`")) {
            value += text[i + 1];
            i += 2;
          } else {
            value += text[i++];
          }
        }
        if (i < text.length && text[i] === '"') i++;
      } else if (c === "\\" && i + 1 < text.length && SHELL_ESCAPE_CHARS.has(text[i + 1])) {
        value += text[i + 1];
        i += 2;
      } else {
        value += c;
        i++;
      }
    }

    tokens.push({ raw: text.slice(start, i), value, quoted, start, end: i });
  }

  return tokens;
}

const ENV_VALUE_FLAGS = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);

function splitEnvPrefix(text) {
  const tokens = tokenizeShellWordsDetailed(text);
  let idx = 0;

  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.raw)) {
      idx++;
      continue;
    }
    if (normalizeCmdName(tok.value) === "env") {
      idx++;
      while (idx < tokens.length) {
        const sub = tokens[idx];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(sub.raw)) {
          idx++;
          continue;
        }
        if (sub.value.startsWith("-") && sub.value !== "-") {
          idx++;
          if (ENV_VALUE_FLAGS.has(sub.value) && idx < tokens.length) {
            idx++;
          }
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }

  if (idx === 0) return { prefix: "", body: text };
  if (idx >= tokens.length) return { prefix: text, body: "" };
  return {
    prefix: text.slice(0, tokens[idx].start),
    body: text.slice(tokens[idx].start)
  };
}

function tokenizeShellWords(text) {
  return tokenizeShellWordsDetailed(text).map((t) => t.value);
}

function hasDotDotTraversal(str) {
  if (!str || typeof str !== "string") return false;
  return /(?:^|[\/\\])\.\.(?:$|[\/\\])/.test(str);
}

function tryRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    try {
      const parent = path.dirname(p);
      const base = path.basename(p);
      return path.join(fs.realpathSync(parent), base);
    } catch {
      return path.resolve(p);
    }
  }
}

function normalizeSessionTrackedPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return "";
  try {
    const resolved = tryRealpath(resolveHookPath(targetPath));
    const norm = resolved.replace(/\\/g, "/");
    return os.platform() === "win32" ? norm.toLowerCase() : norm;
  } catch {
    return "";
  }
}

function recordSessionWrittenFile(convId = "global", targetPath) {
  const norm = normalizeSessionTrackedPath(targetPath);
  if (!norm) return;
  const session = getSessionState(convId);
  const existing = Array.isArray(session.writtenFiles) ? session.writtenFiles : [];
  if (existing.includes(norm)) return;
  session.writtenFiles = existing.slice(-199).concat([norm]);
  saveSessionState(convId, session, { updatePollTime: false });
}

function wasFileWrittenInSession(convId = "global", targetPath) {
  const norm = normalizeSessionTrackedPath(targetPath);
  if (!norm) return false;
  const session = getSessionState(convId);
  return Array.isArray(session.writtenFiles) && session.writtenFiles.includes(norm);
}

function isPathInsideDir(candidatePath, baseDir) {
  const norm = (p) => (os.platform() === "win32" || os.platform() === "darwin" ? p.toLowerCase() : p);
  const resolvedCandidate = norm(tryRealpath(resolveHookPath(candidatePath)));
  const resolvedBase = norm(tryRealpath(path.resolve(baseDir)));
  const prefix = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  return resolvedCandidate.startsWith(prefix);
}

function resolveWithExistingAncestor(targetPath) {
  const absTarget = resolveHookPath(targetPath);
  if (!absTarget) return "";
  if (fs.existsSync(absTarget)) {
    try { return fs.realpathSync(absTarget); } catch { return absTarget; }
  }
  const missingTail = [];
  let probe = absTarget;
  while (probe && !fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    missingTail.unshift(path.basename(probe));
    probe = parent;
  }
  let baseReal = probe;
  if (fs.existsSync(probe)) {
    try { baseReal = fs.realpathSync(probe); } catch {}
  }
  return missingTail.length > 0 ? path.join(baseReal, ...missingTail) : baseReal;
}

function normalizeWinDevicePathInHook(p) {
  let s = String(p || "");
  if (/^\\\\\?\\UNC\\/i.test(s)) {
    return "\\\\" + s.slice(8);
  }
  if (/^\\\\[?.]\\/.test(s)) {
    return s.slice(4);
  }
  return s;
}

function hasUncOrDevicePrefixInHook(p) {
  const s = String(p || "").trim();
  return /^(?:\\\\|\/\/)/.test(s) || /^[\\/]{2}[?.][\\/]/.test(s);
}

function isProtectedExportOutPathInHook(outPath, resolvedOut) {
  const cleanTarget = normalizeWinDevicePathInHook(resolvedOut);
  if (hasUncOrDevicePrefixInHook(outPath) || hasUncOrDevicePrefixInHook(cleanTarget) || /^\\/.test(String(outPath || "").trim())) {
    return true;
  }
  const normCase = (p) => (os.platform() === "win32" || os.platform() === "darwin" ? p.toLowerCase() : p);
  const isInsideCaseAware = (target, root) => {
    const tNorm = normalizeWinDevicePathInHook(target);
    const rNorm = normalizeWinDevicePathInHook(root);
    if (hasUncOrDevicePrefixInHook(tNorm) || hasUncOrDevicePrefixInHook(rNorm)) return false;
    const rel = path.relative(normCase(rNorm), normCase(tNorm));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };

  if (/(?:^|[\\/])\.git(?:[\\/]|$)/i.test(outPath) || /(?:^|[\\/])\.git(?:[\\/]|$)/i.test(resolvedOut)) {
    return true;
  }
  try {
    const lst = fs.lstatSync(resolvedOut);
    if (lst.isSymbolicLink() || !lst.isFile()) {
      return true;
    }
  } catch {}

  const realTarget = resolveWithExistingAncestor(resolvedOut);
  const realNorm = realTarget.replace(/\\/g, "/");
  if (
    hasUncOrDevicePrefixInHook(realTarget) ||
    isProtectedInternalState(realTarget) ||
    isProtectedBenchmarkPath(realTarget) ||
    /(?:^|[\\/])\.git(?:[\\/]|$)/i.test(realTarget) ||
    /\/\.gemini\/(?:config|antigravity(?:-cli|-ide)?)\/(?:hooks\.json(?:\.bak)?|mcp_config\.json|config\.json)$/i.test(realNorm) ||
    /\/\.gemini\/config\/scripts\/execution-guard-hook\.mjs$/i.test(realNorm) ||
    /(?:^|\/)hooks\.json$/i.test(realNorm)
  ) {
    return true;
  }

  const profileHome = getProfileHomeDir();
  const protectedRoots = [
    getStateDir(),
    path.join(profileHome, ".gemini", "config"),
    path.join(profileHome, ".gemini", "antigravity", "bin"),
    path.join(profileHome, ".gemini", "antigravity", "mcp"),
    path.join(profileHome, ".gemini", "antigravity-cli", "bin"),
    path.join(profileHome, ".gemini", "antigravity-cli", "mcp"),
    path.join(profileHome, ".gemini", "antigravity-ide", "bin"),
    path.join(profileHome, ".gemini", "antigravity-ide", "mcp")
  ].map((p) => resolveWithExistingAncestor(p));

  return protectedRoots.some((pr) => pr && isInsideCaseAware(realTarget, pr));
}

function isSafeSelfOnlyOutPathInHook(outPath, resolvedOut, convId) {
  if (!convId || convId === "global") return false;
  const realTarget = resolveWithExistingAncestor(resolvedOut);
  if (!realTarget || hasUncOrDevicePrefixInHook(outPath) || hasUncOrDevicePrefixInHook(realTarget)) {
    return false;
  }
  const normCase = (p) => (os.platform() === "win32" || os.platform() === "darwin" ? p.toLowerCase() : p);
  const isInside = (target, root) => {
    const tNorm = normalizeWinDevicePathInHook(target);
    const rNorm = normalizeWinDevicePathInHook(root);
    if (!tNorm || !rNorm) return false;
    const rel = path.relative(normCase(rNorm), normCase(tNorm));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const wsScratch = resolveWithExistingAncestor(path.join(resolveHookPath("."), "scratch"));
  if (isInside(realTarget, wsScratch)) {
    return true;
  }
  for (const brainDir of getBrainDirs()) {
    const ownScratch = resolveWithExistingAncestor(path.join(brainDir, String(convId), "scratch"));
    if (isInside(realTarget, ownScratch)) {
      return true;
    }
  }
  return false;
}

function isPathInsideAnyBrainDir(candidatePath, selfConvId = null) {
  for (const dir of getBrainDirs()) {
    const checkDir = selfConvId ? path.join(dir, String(selfConvId)) : dir;
    if (isPathInsideDir(candidatePath, checkDir)) {
      return dir;
    }
  }
  return null;
}

function normalizeCmdName(token) {
  const base = path.basename(token.replace(/\\/g, "/")).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|mjs|cjs|js)$/i, "");
}

// ============================================================================
// Internal State & `agy-context transcript` Governance
// ============================================================================

const TRANSCRIPT_READ_SUBCOMMANDS = new Set([
  "read",
  "query",
  "step",
  "health",
  "list",
  "ls",
  "export",
  "dump",
  "grep",
  "search",
  "find",
  "stats",
  "info",
  "tools",
  "outline",
  "summary"
]);
const TRANSCRIPT_HELP_SUBCOMMANDS = new Set(["help", "--help", "-h"]);
const TRANSCRIPT_ADMIN_SUBCOMMANDS = new Set(["access", "policy"]);
const COMMAND_WRAPPERS = new Set([
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "nice",
  "timeout",
  "stdbuf",
  "setsid",
  "chrt",
  "ionice",
  "taskset",
  "xargs"
]);

function isAllowedAgyContextScriptPath(scriptToken) {
  if (!scriptToken || hasDotDotTraversal(scriptToken)) return false;
  const normalized = scriptToken.replace(/\\/g, "/");
  if (!normalized.endsWith("/bin/agy-context.mjs") && normalized !== "bin/agy-context.mjs") {
    return false;
  }

  const hookDir = path.dirname(fileURLToPath(import.meta.url));
  const repoOrPluginRoot = path.resolve(hookDir, "..");
  const installedPluginRoot = path.join(getProfileHomeDir(), ".gemini", "config", "plugins", "agy-context-saver");
  const allowedTargets = new Set([
    tryRealpath(path.join(repoOrPluginRoot, "bin", "agy-context.mjs")),
    tryRealpath(path.join(installedPluginRoot, "bin", "agy-context.mjs"))
  ]);
  const resolvedArg = tryRealpath(resolveHookPath(scriptToken));
  if (allowedTargets.has(resolvedArg)) return true;

  // Also allow relative "bin/agy-context.mjs" when invoked from repo/plugin root
  if (normalized === "bin/agy-context.mjs") return true;
  return false;
}

function isAllowedAgyContextBinaryToken(binToken) {
  if (!binToken || hasDotDotTraversal(binToken)) return false;
  const normalized = binToken.replace(/\\/g, "/");
  if (!normalized.includes("/")) {
    const base = normalizeCmdName(normalized);
    return base === "agy-context" || base === "agy-context-saver";
  }
  if (isAllowedAgyContextScriptPath(binToken)) return true;
  if (/\/\.gemini\/antigravity\/bin\/agy-context(?:-saver)?(?:\.(?:exe|cmd|bat))?$/i.test(normalized)) {
    return true;
  }
  return false;
}

function extractWrappedScriptInfo(segText) {
  const trimmed = (segText || "").trim();
  if (!trimmed) return null;

  // Unpack `env -S "..."` or `env --split-string="..."`
  const rawTokens = tokenizeShellWordsDetailed(trimmed);
  for (let i = 0; i < rawTokens.length; i++) {
    const tok = rawTokens[i];
    if (normalizeCmdName(tok.value) === "env") {
      for (let j = i + 1; j < rawTokens.length; j++) {
        const sub = rawTokens[j].value;
        if ((sub === "-S" || sub === "--split-string") && rawTokens[j + 1]) {
          const restAfter = rawTokens.slice(j + 2).map((t) => t.value).join(" ");
          return {
            hadEnvPrefix: true,
            innerScript: `${rawTokens[j + 1].value}${restAfter ? " " + restAfter : ""}`.trim()
          };
        }
        if (sub.startsWith("-S") && sub.length > 2) {
          const restAfter = rawTokens.slice(j + 1).map((t) => t.value).join(" ");
          return {
            hadEnvPrefix: true,
            innerScript: `${sub.slice(2)}${restAfter ? " " + restAfter : ""}`.trim()
          };
        }
        if (sub.startsWith("--split-string=")) {
          const restAfter = rawTokens.slice(j + 1).map((t) => t.value).join(" ");
          return {
            hadEnvPrefix: true,
            innerScript: `${sub.slice("--split-string=".length)}${restAfter ? " " + restAfter : ""}`.trim()
          };
        }
      }
    }
  }

  const { prefix: envPrefix, body } = splitEnvPrefix(trimmed);
  const effective = (body || trimmed).trim();
  const detailed = tokenizeShellWordsDetailed(effective);
  if (detailed.length === 0) return null;
  const cmd0 = normalizeCmdName(detailed[0].value);
  if (cmd0 === "eval" && detailed.length >= 2) {
    return {
      hadEnvPrefix: Boolean(envPrefix.trim()),
      innerScript: detailed.slice(1).map((t) => t.value).join(" ")
    };
  }
  if ((cmd0 === "bash" || cmd0 === "sh" || cmd0 === "zsh" || cmd0 === "dash") && detailed.length >= 3) {
    for (let i = 1; i < detailed.length - 1; i++) {
      const flag = detailed[i].value;
      if (flag === "--") break;
      if (/^-[a-z]*c$/i.test(flag)) {
        return {
          hadEnvPrefix: Boolean(envPrefix.trim()),
          innerScript: detailed[i + 1].value
        };
      }
    }
  }
  if (COMMAND_WRAPPERS.has(cmd0) && detailed.length >= 2) {
    let subStart = 1;
    while (subStart < detailed.length && detailed[subStart].value.startsWith("-")) {
      const fl = detailed[subStart].value;
      subStart++;
      if ((cmd0 === "nice" && fl === "-n") || (cmd0 === "timeout" && (fl === "-k" || fl === "-s"))) {
        if (subStart < detailed.length) subStart++;
      }
    }
    if (cmd0 === "timeout" && subStart < detailed.length && /^\d/.test(detailed[subStart].value)) {
      subStart++;
    }
    if (subStart < detailed.length) {
      return {
        hadEnvPrefix: true,
        innerScript: detailed.slice(subStart).map((t) => t.value).join(" ")
      };
    }
  }
  return null;
}

function parseAgyContextTranscriptTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  const cmd0 = normalizeCmdName(tokens[0]);
  let subOffset = -1;
  let hasNodeFlags = false;
  let invalidBinaryPath = false;

  if ((cmd0 === "agy-context" || cmd0 === "agy-context-saver") && tokens[1] === "transcript") {
    subOffset = 2;
    if (!isAllowedAgyContextBinaryToken(tokens[0])) {
      invalidBinaryPath = true;
    }
  } else if (cmd0 === "node" && tokens.length >= 3) {
    for (let i = 1; i < tokens.length - 1; i++) {
      const tok = tokens[i];
      if (
        (isAllowedAgyContextScriptPath(tok) || normalizeCmdName(tok) === "agy-context" || normalizeCmdName(tok) === "agy-context-saver") &&
        tokens[i + 1] === "transcript"
      ) {
        subOffset = i + 2;
        hasNodeFlags = i !== 1;
        if (!isAllowedAgyContextScriptPath(tok)) {
          invalidBinaryPath = true;
        }
        break;
      }
    }
  }

  if (subOffset === -1) return null;
  const rawSub = tokens[subOffset];
  const subcommand = rawSub !== undefined ? String(rawSub).trim() : "help";
  const isReadSub = TRANSCRIPT_READ_SUBCOMMANDS.has(subcommand);
  const isHelpSub = TRANSCRIPT_HELP_SUBCOMMANDS.has(subcommand);
  const isAdminSub = TRANSCRIPT_ADMIN_SUBCOMMANDS.has(subcommand);
  const isKnownSubcommand = isReadSub || isHelpSub || isAdminSub;

  return {
    subOffset,
    subcommand,
    isReadSub,
    isHelpSub,
    isAdminSub,
    isKnownSubcommand,
    hasNodeFlags,
    invalidBinaryPath,
    tokens
  };
}

function findAgyContextTranscriptUsage(segments, depth = 0) {
  if (depth > 4) return null;
  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx];
    let text = (seg.text || "").trim();
    let wrappedInSubshell = false;
    while (text.startsWith("(") && text.endsWith(")")) {
      wrappedInSubshell = true;
      text = text.slice(1, -1).trim();
    }
    const { prefix: envPrefix, body } = splitEnvPrefix(text);
    const hadWrapper = wrappedInSubshell || Boolean(envPrefix.trim());
    const directTokens = tokenizeShellWords(body || text);
    const parsedDirect = parseAgyContextTranscriptTokens(directTokens);
    if (parsedDirect) {
      return { ...parsedDirect, seg, segIndex: idx, totalSegs: segments.length, hadWrapper };
    }
    const wrapped = extractWrappedScriptInfo(text);
    if (wrapped && wrapped.innerScript) {
      const innerMatch = findAgyContextTranscriptUsage(splitShellSegments(wrapped.innerScript), depth + 1);
      if (innerMatch) {
        return { ...innerMatch, hadWrapper: true, totalSegs: Math.max(segments.length, innerMatch.totalSegs) };
      }
    }
    if (Array.isArray(seg.subshells)) {
      for (const sub of seg.subshells) {
        const subMatch = findAgyContextTranscriptUsage(splitShellSegments(sub), depth + 1);
        if (subMatch) {
          return { ...subMatch, hadWrapper: true, totalSegs: Math.max(segments.length, 2) };
        }
      }
    }
  }
  return null;
}

// ============================================================================
// Transcript Access Policy & Lineage Engine (Refined Approach D)
// ============================================================================

const HOOK_GRANT_TTL_MS = 10000;
const STANDALONE_DIRECTIVE_LINE_RE = /^(?:@[a-zA-Z0-9_-]+\s+)?\[agy-transcript-access:\s*(deny|self-only|allow)\]\s*$/i;

function getTranscriptAccessPolicyPath() {
  return path.join(getStateDir(), "transcript-access.json");
}

function normalizePatternList(rawList) {
  if (!rawList) return [];
  const arr = Array.isArray(rawList)
    ? rawList
    : String(rawList)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  return Array.from(new Set(arr.map((s) => String(s).trim()).filter(Boolean)));
}

function readTranscriptAccessStore() {
  const filePath = getTranscriptAccessPolicyPath();
  const now = Date.now();
  const baseStore = {
    version: 1,
    activeOwnerId: null,
    policies: {},
    lastHookGrant: null,
    lastAccessMutationGrant: null
  };
  try {
    if (!fs.existsSync(filePath)) return baseStore;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return baseStore;

    const policies = {};
    const rawPolicies = parsed.policies && typeof parsed.policies === "object" ? parsed.policies : {};
    for (const [ownerId, pol] of Object.entries(rawPolicies)) {
      if (!pol || typeof pol !== "object") continue;
      const updatedAt = Number(pol.updatedAt || pol.createdAt || 0);
      const ttlMs = Number(pol.ttlMs) > 0 ? Number(pol.ttlMs) : STATE_TTL_MS;
      if (updatedAt > 0 && (now - updatedAt) < ttlMs) {
        policies[ownerId] = {
          ownerId: String(pol.ownerId || ownerId),
          mode: ["open", "allowlist", "self-only", "deny"].includes(pol.mode) ? pol.mode : "open",
          allow: normalizePatternList(pol.allow),
          deny: normalizePatternList(pol.deny),
          createdAt: Number(pol.createdAt || updatedAt),
          updatedAt,
          ttlMs
        };
      }
    }

    let activeOwnerId = parsed.activeOwnerId && policies[parsed.activeOwnerId] ? parsed.activeOwnerId : null;
    if (!activeOwnerId) {
      const sortedOwners = Object.values(policies).sort((a, b) => b.updatedAt - a.updatedAt);
      if (sortedOwners.length > 0) activeOwnerId = sortedOwners[0].ownerId;
    }

    const lastHookGrant =
      parsed.lastHookGrant &&
      typeof parsed.lastHookGrant === "object" &&
      typeof parsed.lastHookGrant.ts === "number" &&
      (now - parsed.lastHookGrant.ts) < HOOK_GRANT_TTL_MS
        ? parsed.lastHookGrant
        : null;

    const lastAccessMutationGrant =
      parsed.lastAccessMutationGrant &&
      typeof parsed.lastAccessMutationGrant === "object" &&
      typeof parsed.lastAccessMutationGrant.ts === "number" &&
      (now - parsed.lastAccessMutationGrant.ts) < HOOK_GRANT_TTL_MS
        ? parsed.lastAccessMutationGrant
        : null;

    return {
      version: 1,
      activeOwnerId,
      policies,
      lastHookGrant,
      lastAccessMutationGrant
    };
  } catch {
    return baseStore;
  }
}

function writeTranscriptAccessStore(store) {
  ensureStateDir();
  const filePath = getTranscriptAccessPolicyPath();
  try {
    const payload = JSON.stringify(
      {
        version: 1,
        activeOwnerId: store.activeOwnerId || null,
        policies: store.policies || {},
        lastHookGrant: store.lastHookGrant || null,
        lastAccessMutationGrant: store.lastAccessMutationGrant || null
      },
      null,
      2
    );
    const tmpFile = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmpFile, payload, "utf-8");
    try {
      fs.renameSync(tmpFile, filePath);
    } catch {
      fs.writeFileSync(filePath, payload, "utf-8");
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  } catch {}
}

function recordTranscriptHookGrant({
  callerConvId = "global",
  subcommand = "read",
  targetConvId = null,
  mode = "open",
  isMutation = false
} = {}) {
  const grantsDir = path.join(getStateDir(), "grants");
  try { fs.mkdirSync(grantsDir, { recursive: true }); } catch {}
  const now = Date.now();
  const prefix = isMutation ? "mut-" : "grant-";
  const record = isMutation
    ? { callerConvId, ts: now }
    : { callerConvId, subcommand, targetConvId, mode, ts: now };
  const payload = JSON.stringify(record);

  for (let attempt = 0; attempt < 4; attempt++) {
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    const grantPath = path.join(grantsDir, `${prefix}${now}-${process.pid}-${id}.json`);
    try {
      const fd = fs.openSync(grantPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, payload, "utf-8");
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch {}
  }
}

function extractFirstLineDirective(bodyText) {
  if (!bodyText || typeof bodyText !== "string") return null;
  let cleaned = bodyText.replace(/<\/SYSTEM_MESSAGE>[\s\S]*$/i, "");
  cleaned = cleaned.replace(/^\s*<USER_REQUEST>\s*/i, "");
  const lines = cleaned.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(STANDALONE_DIRECTIVE_LINE_RE);
    return m ? m[1].toLowerCase() : null;
  }
  return null;
}

/**
 * Inspects initial transcript JSONL steps (up to 48 header lines before execution turns)
 * to classify caller session lineage (`isTopLevelUserSession`, `isChildSession`, `isSwarmChild`),
 * extract `parentConvId` and `@rosterName`, and parse any first-line `[agy-transcript-access: ...]` directive.
 *
 * SYNC-MIRROR: Must match `inspectTranscriptLineageFromFile()` in `lib/transcript-core.mjs`.
 */
function getCallerLineage(convId) {
  if (!convId || convId === "global") {
    return {
      transcriptFound: false,
      isTopLevelUserSession: false,
      isChildSession: false,
      isSwarmChild: false,
      parentConvId: null,
      rosterName: null,
      launchDirective: null,
      birthTimeMs: 0
    };
  }

  let targetFile = null;
  for (const bDir of getBrainDirs()) {
    const compactPath = path.join(bDir, convId, ".system_generated", "logs", "transcript.jsonl");
    const fullPath = path.join(bDir, convId, ".system_generated", "logs", "transcript_full.jsonl");
    if (fs.existsSync(compactPath)) {
      targetFile = compactPath;
      break;
    }
    if (fs.existsSync(fullPath)) {
      targetFile = fullPath;
      break;
    }
  }

  const session = getSessionState(convId);
  let targetStat = null;
  if (targetFile) {
    try { targetStat = fs.statSync(targetFile); } catch {}
  }
  if (session.lineage && session.lineage.transcriptFound && session.lineage.lineageVersion === 2) {
    if (
      session.lineage.isSwarmChild ||
      session.lineage.isTopLevelUserSession ||
      (targetStat &&
        targetStat.size === session.lineage.fileSize &&
        targetStat.mtimeMs === session.lineage.fileMtimeMs)
    ) {
      return session.lineage;
    }
  }

  if (!targetFile) {
    return {
      transcriptFound: false,
      isTopLevelUserSession: false,
      isChildSession: false,
      isSwarmChild: false,
      parentConvId: null,
      rosterName: null,
      launchDirective: null,
      birthTimeMs: 0
    };
  }

  const MAX_HEADER_LINES = 48;
  let birthTimeMs = 0;
  let headStr = "";
  try {
    const st = targetStat || fs.statSync(targetFile);
    const candidates = [st.birthtimeMs, st.ctimeMs, st.mtimeMs].filter((n) => Number.isFinite(n) && n > 0);
    if (candidates.length > 0) birthTimeMs = Math.min(...candidates);

    const MAX_HEADER_BYTES = 524288; // 512 KiB ceiling for oversized Step 0 prompts
    const CHUNK_SIZE = 16384;
    const chunks = [];
    let totalRead = 0;
    let newlineCount = 0;
    const fd = fs.openSync(targetFile, "r");
    try {
      while (totalRead < MAX_HEADER_BYTES) {
        const toRead = Math.min(CHUNK_SIZE, MAX_HEADER_BYTES - totalRead);
        const buf = Buffer.alloc(toRead);
        const bytesRead = fs.readSync(fd, buf, 0, toRead, totalRead);
        if (bytesRead <= 0) break;
        const slice = buf.subarray(0, bytesRead);
        chunks.push(slice);
        totalRead += bytesRead;
        for (let b = 0; b < bytesRead; b++) {
          if (slice[b] === 10) newlineCount++;
        }
        if (newlineCount >= MAX_HEADER_LINES) break;
      }
      headStr = Buffer.concat(chunks).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {}

  let isTopLevelUserSession = false;
  let isChildSession = false;
  let isSwarmChild = false;
  let parentConvId = null;
  let boardFallbackSender = null;
  let rosterName = null;
  let launchDirective = null;
  let line0Parsed = false;

  const lines = headStr.split(/\r?\n/).filter((l) => l.trim()).slice(0, MAX_HEADER_LINES);
  for (let i = 0; i < lines.length; i++) {
    let item = null;
    try {
      item = JSON.parse(lines[i]);
      if (i === 0) line0Parsed = true;
    } catch {
      continue;
    }
    const content = typeof item?.content === "string" ? item.content : "";
    if (i === 0 && (item?.type === "USER_INPUT" || item?.source === "USER_EXPLICIT")) {
      isTopLevelUserSession = true;
      launchDirective = extractFirstLineDirective(content);
      break;
    }

    if (item?.type === "SYSTEM_MESSAGE" || item?.source === "SYSTEM") {
      const senderMatch = content.match(/\[Message\][^\n]*\bsender=([a-zA-Z0-9_-]{4,})\b/);
      const isBoardNotification = content.includes("content=[swarm] new board message");
      if (senderMatch) {
        isChildSession = true;
        if (isBoardNotification) {
          if (!boardFallbackSender) boardFallbackSender = senderMatch[1];
        } else if (!parentConvId) {
          parentConvId = senderMatch[1];
        }
      }

      const swarmAssignMatch = content.match(
        /Your assignment \(recorded on the board as #\d+ for @([a-zA-Z0-9_-]+)\):([\s\S]*)$/
      );
      if (swarmAssignMatch) {
        isChildSession = true;
        isSwarmChild = true;
        const assignPrefix = content.slice(0, swarmAssignMatch.index);
        const assignSenders = [...assignPrefix.matchAll(/\[Message\][^\n]*\bsender=([a-zA-Z0-9_-]{4,})\b/g)];
        if (assignSenders.length > 0) {
          parentConvId = assignSenders[assignSenders.length - 1][1];
        } else if (senderMatch) {
          parentConvId = senderMatch[1];
        }
        rosterName = swarmAssignMatch[1];
        const dir = extractFirstLineDirective(swarmAssignMatch[2]);
        if (dir) launchDirective = dir;
        break;
      }

      if (senderMatch && i === 0 && !isBoardNotification) {
        const msgBodyMatch = content.match(/\bpriority=MESSAGE_PRIORITY_[A-Z_]+\s+content=([\s\S]*)$/);
        if (msgBodyMatch) {
          const dir = extractFirstLineDirective(msgBodyMatch[1]);
          if (dir) launchDirective = dir;
        }
      }
    } else if (i > 0) {
      break;
    }
  }
  if (!parentConvId && boardFallbackSender) {
    parentConvId = boardFallbackSender;
  }

  const lineage = {
    lineageVersion: 2,
    fileSize: targetStat ? targetStat.size : 0,
    fileMtimeMs: targetStat ? targetStat.mtimeMs : 0,
    transcriptFound: lines.length > 0 && line0Parsed,
    isTopLevelUserSession,
    isChildSession,
    isSwarmChild,
    parentConvId,
    rosterName,
    launchDirective,
    birthTimeMs
  };

  if (lineage.transcriptFound) {
    session.lineage = lineage;
    saveSessionState(convId, session, { updatePollTime: false });
  }
  return lineage;
}

function matchesAgentPattern(pattern, callerConvId, rosterName) {
  if (!pattern) return false;
  const rawPat = String(pattern).trim().toLowerCase();
  if (!rawPat) return false;
  const isRosterPat = rawPat.startsWith("@");
  const cleanPat = isRosterPat ? rawPat.slice(1) : rawPat;
  const isGlob = cleanPat.endsWith("*");
  const prefix = isGlob ? cleanPat.slice(0, -1) : cleanPat;

  if (rosterName) {
    const cleanRoster = String(rosterName).trim().toLowerCase().replace(/^@/, "");
    if (isGlob ? cleanRoster.startsWith(prefix) : cleanRoster === cleanPat) {
      return true;
    }
  }
  if (!isRosterPat && callerConvId) {
    const cleanId = String(callerConvId).trim().toLowerCase();
    if (isGlob ? cleanId.startsWith(prefix) : cleanId === cleanPat) {
      return true;
    }
  }
  return false;
}

function matchesAgentList(list, callerConvId, rosterName) {
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.some((pat) => matchesAgentPattern(pat, callerConvId, rosterName));
}

function findGoverningPolicyForCaller(store, convId, lineage) {
  const policies = store?.policies || {};
  const policyList = Object.values(policies).sort((a, b) => b.updatedAt - a.updatedAt);
  if (policyList.length === 0) return null;

  // 1. If caller is an owner itself, return its own policy
  if (convId && policies[convId]) {
    return policies[convId];
  }

  // 2. Verified top-level user conversation (`USER_INPUT` at Step 0) is NEVER subject to another session's child lock
  if (lineage.isTopLevelUserSession && !lineage.isChildSession) {
    return null;
  }

  // 3. Real child transcript with lineage: scope policy lookup strictly to its ancestor chain (+ global local-operator fallback)
  if (lineage.parentConvId) {
    const ancestors = [];
    const visited = new Set(convId ? [convId] : []);
    let curParent = lineage.parentConvId;
    for (let depth = 0; curParent && !visited.has(curParent) && depth < 8; depth++) {
      visited.add(curParent);
      ancestors.push(curParent);
      const parentLin = getCallerLineage(curParent);
      curParent = parentLin?.parentConvId || null;
    }

    for (const anc of ancestors) {
      const pol = policies[anc];
      if (!pol) continue;
      if (matchesAgentList(pol.deny, convId, lineage.rosterName) || matchesAgentList(pol.allow, convId, lineage.rosterName)) {
        return pol;
      }
    }
    for (const anc of ancestors) {
      if (policies[anc]) return policies[anc];
    }
    return policies["local-operator"] || policies["global"] || null;
  }

  // 4. Child transcript without explicit sender metadata: check matching allow/deny or global/active owner
  if (lineage.isChildSession) {
    for (const pol of policyList) {
      if (matchesAgentList(pol.deny, convId, lineage.rosterName) || matchesAgentList(pol.allow, convId, lineage.rosterName)) {
        return pol;
      }
    }
    return policies["local-operator"] || policies["global"] || (store.activeOwnerId && policies[store.activeOwnerId]) || null;
  }

  // 5. Fallback for synthetic test conversationIds (when transcript file does not exist on disk)
  if (!lineage.transcriptFound) {
    for (const pol of policyList) {
      if (matchesAgentList(pol.deny, convId, lineage.rosterName) || matchesAgentList(pol.allow, convId, lineage.rosterName)) {
        return pol;
      }
    }
    return (store.activeOwnerId && policies[store.activeOwnerId]) || policyList[0] || null;
  }

  return null;
}

function evaluateCallerTranscriptAccess(convId) {
  const lineage = getCallerLineage(convId);
  const store = readTranscriptAccessStore();
  const policy = findGoverningPolicyForCaller(store, convId, lineage);

  // Tier 1: Policy owner
  if (policy && convId && policy.ownerId === convId) {
    return {
      allowed: true,
      mode: "open",
      source: "owner",
      isOwner: true,
      isRestrictedChild: false,
      rosterName: lineage.rosterName,
      ownerId: policy.ownerId
    };
  }

  // Tier 2: Explicit CLI --deny match
  if (policy && matchesAgentList(policy.deny, convId, lineage.rosterName)) {
    return {
      allowed: false,
      mode: "deny",
      source: "cli-deny-list",
      isOwner: false,
      isRestrictedChild: true,
      rosterName: lineage.rosterName,
      ownerId: policy.ownerId
    };
  }

  // Tier 3: Explicit CLI --allow match
  if (policy && matchesAgentList(policy.allow, convId, lineage.rosterName)) {
    return {
      allowed: true,
      mode: "open",
      source: "cli-allow-list",
      isOwner: false,
      isRestrictedChild: false,
      rosterName: lineage.rosterName,
      ownerId: policy.ownerId
    };
  }

  // Tier 4: First-line launch directive (`[agy-transcript-access: allow|self-only|deny]`)
  if (lineage.launchDirective) {
    if (lineage.launchDirective === "deny") {
      return {
        allowed: false,
        mode: "deny",
        source: "launch-directive",
        isOwner: false,
        isRestrictedChild: true,
        rosterName: lineage.rosterName,
        ownerId: policy ? policy.ownerId : lineage.parentConvId
      };
    }
    // If parent updated policy to deny/allowlist AFTER child launch, parent mid-session lock overrides
    const parentOverrodeMidSession =
      Boolean(policy) &&
      (policy.mode === "deny" || policy.mode === "allowlist") &&
      lineage.birthTimeMs > 0 &&
      policy.updatedAt > lineage.birthTimeMs + 1000;

    if (parentOverrodeMidSession) {
      return {
        allowed: false,
        mode: policy.mode,
        source: "cli-policy-override",
        isOwner: false,
        isRestrictedChild: true,
        rosterName: lineage.rosterName,
        ownerId: policy.ownerId
      };
    }

    if (lineage.launchDirective === "self-only") {
      return {
        allowed: true,
        mode: "self-only",
        source: "launch-directive",
        isOwner: false,
        isRestrictedChild: true,
        rosterName: lineage.rosterName,
        ownerId: policy ? policy.ownerId : lineage.parentConvId
      };
    }
    if (lineage.launchDirective === "allow") {
      return {
        allowed: true,
        mode: "open",
        source: "launch-directive",
        isOwner: false,
        isRestrictedChild: false,
        rosterName: lineage.rosterName,
        ownerId: policy ? policy.ownerId : lineage.parentConvId
      };
    }
  }

  // Tier 5: Cohort default mode from governing parent policy
  if (policy) {
    if (policy.mode === "deny" || policy.mode === "allowlist") {
      return {
        allowed: false,
        mode: policy.mode,
        source: "cli-policy",
        isOwner: false,
        isRestrictedChild: true,
        rosterName: lineage.rosterName,
        ownerId: policy.ownerId
      };
    }
    if (policy.mode === "self-only") {
      return {
        allowed: true,
        mode: "self-only",
        source: "cli-policy",
        isOwner: false,
        isRestrictedChild: true,
        rosterName: lineage.rosterName,
        ownerId: policy.ownerId
      };
    }
  }

  return {
    allowed: true,
    mode: "open",
    source: "default",
    isOwner: !lineage.isChildSession,
    isRestrictedChild: false,
    rosterName: lineage.rosterName,
    ownerId: policy ? policy.ownerId : null
  };
}

function canCallerMutateTranscriptAccess(convId) {
  const lineage = getCallerLineage(convId);
  if (lineage.isChildSession || lineage.isSwarmChild) {
    return false;
  }
  if (lineage.launchDirective === "deny" || lineage.launchDirective === "self-only") {
    return false;
  }
  const store = readTranscriptAccessStore();
  const policy = findGoverningPolicyForCaller(store, convId, lineage);
  if (policy && convId && policy.ownerId !== convId && !lineage.isTopLevelUserSession) {
    return false;
  }
  return true;
}

function getTranscriptValueFlagsForSubcommand(subcommand) {
  const READ_VALUE_FLAGS = new Set([
    "id",
    "mode",
    "last-turns",
    "last",
    "tail",
    "offset",
    "limit",
    "start",
    "end",
    "max-chars",
    "out",
    "output",
    "file"
  ]);
  const QUERY_VALUE_FLAGS = new Set([
    "id",
    "query",
    "roles",
    "mode",
    "start",
    "end",
    "last-turns",
    "last",
    "tail",
    "limit",
    "field",
    "max-chars",
    "out",
    "output",
    "file"
  ]);
  const STEP_VALUE_FLAGS = new Set([
    "id",
    "step",
    "start",
    "end",
    "field",
    "mode",
    "tail",
    "tail-lines",
    "head",
    "head-lines",
    "line-start",
    "line-end",
    "max-chars",
    "out",
    "output",
    "file"
  ]);
  const HEALTH_VALUE_FLAGS = new Set(["id", "file"]);
  const LIST_VALUE_FLAGS = new Set(["limit", "parent"]);
  const EXPORT_VALUE_FLAGS = new Set(["id", "parent", "start", "end", "limit", "max-chars", "out", "output", "file"]);

  if (subcommand === "query" || subcommand === "grep" || subcommand === "search" || subcommand === "find" || subcommand === "tools") {
    return QUERY_VALUE_FLAGS;
  }
  if (subcommand === "step") {
    return STEP_VALUE_FLAGS;
  }
  if (subcommand === "health" || subcommand === "stats" || subcommand === "info") {
    return HEALTH_VALUE_FLAGS;
  }
  if (subcommand === "list" || subcommand === "ls") {
    return LIST_VALUE_FLAGS;
  }
  if (subcommand === "export" || subcommand === "dump") {
    return EXPORT_VALUE_FLAGS;
  }
  return READ_VALUE_FLAGS;
}

function extractTargetConvIdFromTranscriptTokens(subcommand, restTokens) {
  const valueFlags = getTranscriptValueFlagsForSubcommand(subcommand);

  const opts = {};
  const idValues = [];
  const outPaths = [];
  const positionals = [];
  for (let i = 0; i < restTokens.length; i++) {
    const tok = restTokens[i];
    if (!tok.startsWith("-") || tok === "-") {
      positionals.push(tok);
      continue;
    }
    if (!tok.startsWith("--")) continue;
    const eqIdx = tok.indexOf("=");
    const key = eqIdx === -1 ? tok.slice(2) : tok.slice(2, eqIdx);
    const inlineVal = eqIdx === -1 ? null : tok.slice(eqIdx + 1);
    if (valueFlags.has(key)) {
      let val = inlineVal;
      if (val === null && i + 1 < restTokens.length) {
        val = restTokens[++i];
      }
      if (val !== null) {
        if (key === "id") {
          for (const part of String(val).split(",").map((s) => s.trim()).filter(Boolean)) {
            idValues.push(part);
          }
        }
        if (key === "out" || key === "output") {
          const trimmedOut = String(val).trim();
          if (trimmedOut) outPaths.push(trimmedOut);
        }
        opts[key] = val;
      }
    }
  }

  const posCopy = [...positionals];
  if (subcommand === "query" || subcommand === "grep" || subcommand === "search" || subcommand === "find" || subcommand === "tools") {
    if (opts.query === undefined && posCopy.length >= 1) {
      opts.query = posCopy.shift();
    }
    if (opts.id === undefined && posCopy.length >= 1) {
      const pId = posCopy.shift();
      opts.id = pId;
      idValues.push(pId);
    }
  } else if (subcommand === "step") {
    if (opts.step === undefined && posCopy.length >= 1) {
      opts.step = posCopy.shift();
    }
    if (opts.id === undefined && posCopy.length >= 1) {
      const pId = posCopy.shift();
      opts.id = pId;
      idValues.push(pId);
    }
  } else if (
    subcommand === "read" ||
    subcommand === "outline" ||
    subcommand === "summary" ||
    subcommand === "health" ||
    subcommand === "stats" ||
    subcommand === "info" ||
    subcommand === "export" ||
    subcommand === "dump"
  ) {
    const canConsumePositionalId =
      (subcommand !== "export" && subcommand !== "dump") ||
      (opts.parent === undefined && opts.file === undefined);
    if (opts.id === undefined && canConsumePositionalId && posCopy.length >= 1) {
      const pId = posCopy.shift();
      opts.id = pId;
      if (subcommand === "export" || subcommand === "dump") {
        for (const part of String(pId).split(",").map((s) => s.trim()).filter(Boolean)) {
          idValues.push(part);
        }
      } else {
        idValues.push(pId);
      }
    }
  }

  if (posCopy.length > 0) {
    return {
      error: `Antigravity Execution Governance: Unexpected positional arguments '${posCopy.join(" ")}' for 'agy-context transcript ${subcommand}'.`
    };
  }

  const uniqueIds = Array.from(new Set(idValues.map((s) => String(s).trim()).filter(Boolean)));
  return {
    targetId: (subcommand === "export" || subcommand === "dump") && uniqueIds.length === 1 ? uniqueIds[0] : (opts.id ? String(opts.id).trim() : null),
    targetIds: uniqueIds,
    targetParent: opts.parent !== undefined ? String(opts.parent).trim() : null,
    outPath: outPaths.length > 0 ? outPaths[outPaths.length - 1] : null,
    outPaths,
    explicitFile: opts.file ? String(opts.file).trim() : null
  };
}

function buildTranscriptAccessDenial({ subcommand, mode, source, callerConvId, rosterName, detail }) {
  const label = rosterName ? `@${rosterName} (${callerConvId})` : callerConvId;
  const extra = detail ? ` ${detail}` : "";
  return (
    `Antigravity Execution Governance: 'agy-context transcript ${subcommand}' is restricted for this session (${label}) by parent governance [mode=${mode}, source=${source}].${extra} ` +
    `Do NOT retry transcript inspection commands or attempt direct '.system_generated' file/shell reads; proceed with your assigned task using your workspace files and task brief.`
  );
}

/**
 * Checks if a command is a valid, strictly single, unchained `agy-context transcript ...` invocation
 * and enforces parent-scoped transcript access governance.
 */
function checkAgyContextTranscriptCommand(segments, convId = "global") {
  if (segments.length === 0) return { matched: false, allowed: false };
  const match = findAgyContextTranscriptUsage(segments);
  if (!match) {
    return { matched: false, allowed: false };
  }

  const {
    seg,
    segIndex,
    totalSegs,
    hadWrapper,
    subOffset,
    subcommand,
    isReadSub,
    isHelpSub,
    isAdminSub,
    isKnownSubcommand,
    hasNodeFlags,
    invalidBinaryPath,
    tokens
  } = match;

  // Must be strictly single segment at index 0, unchained, unwrapped, no redirects/heredocs/subshells/node-flags
  if (
    totalSegs !== 1 ||
    segIndex !== 0 ||
    hadWrapper ||
    hasNodeFlags ||
    invalidBinaryPath ||
    seg.hasRedirect ||
    seg.hasHeredoc ||
    seg.hasSubshell
  ) {
    return {
      matched: true,
      allowed: false,
      reason:
        "Antigravity Execution Governance: 'agy-context transcript' access to .system_generated must be strictly single and unchained (no chaining, wrappers, env prefixes, node flags, redirects, heredocs, or subshells)."
    };
  }

  if (!isKnownSubcommand) {
    return {
      matched: true,
      allowed: false,
      reason: `Antigravity Execution Governance: Unknown 'agy-context transcript' subcommand '${subcommand}'. Expected read, query, step, health, list, export, or access.`
    };
  }

  // Validate flags: disallow `..` traversal and `--file` outside <brainDirs>
  for (let i = subOffset + 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--file") {
      const val = tokens[i + 1];
      if (!val || hasDotDotTraversal(val) || !isPathInsideAnyBrainDir(val)) {
        const dirs = getBrainDirs();
        const dirDesc = dirs.length === 1 ? `'${dirs[0]}'` : `'${dirs.join("' or '")}'`;
        return {
          matched: true,
          allowed: false,
          reason: `Antigravity Execution Governance: '--file' in 'agy-context transcript' must stay inside ${dirDesc} without '..' path traversal.`
        };
      }
      i++;
      continue;
    }
    if (tok.startsWith("--file=")) {
      const val = tok.slice("--file=".length);
      if (!val || hasDotDotTraversal(val) || !isPathInsideAnyBrainDir(val)) {
        const dirs = getBrainDirs();
        const dirDesc = dirs.length === 1 ? `'${dirs[0]}'` : `'${dirs.join("' or '")}'`;
        return {
          matched: true,
          allowed: false,
          reason: `Antigravity Execution Governance: '--file' in 'agy-context transcript' must stay inside ${dirDesc} without '..' path traversal.`
        };
      }
      continue;
    }
    if (hasDotDotTraversal(tok)) {
      return {
        matched: true,
        allowed: false,
        reason: "Antigravity Execution Governance: Path traversal ('..') is prohibited in 'agy-context transcript' commands."
      };
    }
  }

  if (isHelpSub) {
    return { matched: true, allowed: true, subcommand, mode: "open", needsReadGrant: false };
  }

  const restTokens = tokens.slice(subOffset + 1);
  if (restTokens.length === 1 && (restTokens[0] === "--help" || restTokens[0] === "-h")) {
    return { matched: true, allowed: true, subcommand, mode: "open", needsReadGrant: false };
  }

  if (isAdminSub) {
    const hasMutationToken = restTokens.some((t) => {
      const low = String(t).toLowerCase();
      return (
        low === "--off" ||
        low === "--deny-children" ||
        low === "--on" ||
        low === "--reset" ||
        low === "--self-only" ||
        low === "--mode" ||
        low.startsWith("--mode=") ||
        low === "--allow" ||
        low.startsWith("--allow=") ||
        low === "--deny" ||
        low.startsWith("--deny=") ||
        low === "--ttl" ||
        low.startsWith("--ttl=") ||
        low === "off" ||
        low === "deny" ||
        low === "lock" ||
        low === "on" ||
        low === "open" ||
        low === "reset" ||
        low === "unlock" ||
        low === "self-only"
      );
    });

    if (hasMutationToken && !canCallerMutateTranscriptAccess(convId)) {
      return {
        matched: true,
        allowed: false,
        isAccessDenial: true,
        reason:
          "Antigravity Execution Governance: Only the parent/coordinator session may modify 'agy-context transcript access' policy. Child sessions cannot unlock or alter transcript governance."
      };
    }

    return {
      matched: true,
      allowed: true,
      subcommand,
      mode: "open",
      needsReadGrant: false,
      isAccessMutation: hasMutationToken
    };
  }

  if (isReadSub) {
    const accessEval = evaluateCallerTranscriptAccess(convId);
    if (!accessEval.allowed) {
      return {
        matched: true,
        allowed: false,
        isAccessDenial: true,
        reason: buildTranscriptAccessDenial({
          subcommand,
          mode: accessEval.mode,
          source: accessEval.source,
          callerConvId: convId,
          rosterName: accessEval.rosterName
        })
      };
    }

    const targetInfo = extractTargetConvIdFromTranscriptTokens(subcommand, restTokens);
    if (targetInfo.error) {
      return {
        matched: true,
        allowed: false,
        reason: targetInfo.error
      };
    }

    const isExportSub = subcommand === "export" || subcommand === "dump";
    const isListSub = subcommand === "list" || subcommand === "ls";

    if (Array.isArray(targetInfo.outPaths) && targetInfo.outPaths.length > 0) {
      for (const outPath of targetInfo.outPaths) {
        const resolvedOut = resolveHookPath(outPath);
        const hasUnexpandedShellToken = /^~/.test(outPath) || /\$|%[A-Za-z_][A-Za-z0-9_]*%/.test(outPath);
        if (
          hasUnexpandedShellToken ||
          hasDotDotTraversal(outPath) ||
          isProtectedInternalState(outPath) ||
          isProtectedInternalState(resolvedOut) ||
          isProtectedBenchmarkPath(outPath) ||
          isProtectedBenchmarkPath(resolvedOut) ||
          isProtectedGovernanceFileMutation(outPath, convId) ||
          isProtectedGovernanceFileMutation(resolvedOut, convId) ||
          hasGovernanceMutationInText(`> ${outPath}`, convId) ||
          hasGovernanceMutationInText(`> ${resolvedOut}`, convId) ||
          isProtectedExportOutPathInHook(outPath, resolvedOut) ||
          !/\.(?:md|json|txt)$/i.test(outPath)
        ) {
          return {
            matched: true,
            allowed: false,
            reason: `Antigravity Execution Governance: '--out' path '${outPath}' in 'agy-context transcript ${subcommand}' must be a literal (no shell variables, '~', UNC, or device prefixes) safe .md/.json/.txt artifact outside protected internal state, governance, and benchmark directories.`
          };
        }
        if (accessEval.mode === "self-only" && !isSafeSelfOnlyOutPathInHook(outPath, resolvedOut, convId)) {
          return {
            matched: true,
            allowed: false,
            isAccessDenial: true,
            reason: buildTranscriptAccessDenial({
              subcommand,
              mode: "self-only",
              source: accessEval.source,
              callerConvId: convId,
              rosterName: accessEval.rosterName,
              detail: `'--out' must stay under '<workspace>/scratch/' or '<brainDir>/${convId}/scratch/' in self-only mode (received '${outPath}').`
            })
          };
        }
      }
    }

    if (accessEval.mode === "self-only") {
      if (isListSub) {
        return {
          matched: true,
          allowed: false,
          isAccessDenial: true,
          reason: buildTranscriptAccessDenial({
            subcommand,
            mode: "self-only",
            source: accessEval.source,
            callerConvId: convId,
            rosterName: accessEval.rosterName,
            detail: "'list'/'ls' across sessions is disabled in self-only mode."
          })
        };
      }

      if (isExportSub && targetInfo.targetParent) {
        return {
          matched: true,
          allowed: false,
          isAccessDenial: true,
          reason: buildTranscriptAccessDenial({
            subcommand,
            mode: "self-only",
            source: accessEval.source,
            callerConvId: convId,
            rosterName: accessEval.rosterName,
            detail: "'--parent' across sessions is disabled in self-only mode."
          })
        };
      }

      if (
        isExportSub &&
        Array.isArray(targetInfo.targetIds) &&
        (targetInfo.targetIds.length > 1 ||
          targetInfo.targetIds.some((id) => id.toLowerCase() !== "current" && id !== convId))
      ) {
        return {
          matched: true,
          allowed: false,
          isAccessDenial: true,
          reason: buildTranscriptAccessDenial({
            subcommand,
            mode: "self-only",
            source: accessEval.source,
            callerConvId: convId,
            rosterName: accessEval.rosterName,
            detail: "Cross-session or multi-session transcript export is disabled in self-only mode."
          })
        };
      }

      if (targetInfo.explicitFile) {
        if (!isPathInsideAnyBrainDir(targetInfo.explicitFile, convId)) {
          return {
            matched: true,
            allowed: false,
            isAccessDenial: true,
            reason: buildTranscriptAccessDenial({
              subcommand,
              mode: "self-only",
              source: accessEval.source,
              callerConvId: convId,
              rosterName: accessEval.rosterName,
              detail: `Cross-session '--file' access outside '${convId}' is disabled in self-only mode.`
            })
          };
        }
      }

      if (targetInfo.targetId && targetInfo.targetId.toLowerCase() !== "current" && targetInfo.targetId !== convId) {
        return {
          matched: true,
          allowed: false,
          isAccessDenial: true,
          reason: buildTranscriptAccessDenial({
            subcommand,
            mode: "self-only",
            source: accessEval.source,
            callerConvId: convId,
            rosterName: accessEval.rosterName,
            detail: `Cross-session inspection of '${targetInfo.targetId}' is disabled in self-only mode (you may only inspect your own session '${convId}').`
          })
        };
      }

      const targetWasCurrentPlaceholder = Boolean(
        targetInfo.targetId && targetInfo.targetId.toLowerCase() === "current"
      );
      const needsSelfIdInjection =
        !targetInfo.explicitFile &&
        (!targetInfo.targetId || targetWasCurrentPlaceholder) &&
        Boolean(convId && convId !== "global");

      return {
        matched: true,
        allowed: true,
        subcommand,
        mode: "self-only",
        targetConvId: convId,
        needsReadGrant: true,
        injectSelfId: needsSelfIdInjection ? convId : null,
        targetWasCurrentPlaceholder
      };
    }

    let resolvedTargetConvId = targetInfo.targetId || null;
    let injectParentId = null;
    if (
      (isExportSub || isListSub) &&
      targetInfo.targetParent &&
      targetInfo.targetParent.toLowerCase() === "current" &&
      convId &&
      convId !== "global"
    ) {
      injectParentId = convId;
    }
    if (isExportSub) {
      if (targetInfo.targetParent) {
        const resolvedP = injectParentId || targetInfo.targetParent;
        resolvedTargetConvId = `parent:${resolvedP}`;
      } else if (Array.isArray(targetInfo.targetIds) && targetInfo.targetIds.length > 1) {
        resolvedTargetConvId = `multi:${[...targetInfo.targetIds].sort().join(",")}`;
      } else if (Array.isArray(targetInfo.targetIds) && targetInfo.targetIds.length === 1) {
        resolvedTargetConvId = targetInfo.targetIds[0];
      }
    }
    if (targetInfo.explicitFile) {
      const matchedBrainDir = isPathInsideAnyBrainDir(targetInfo.explicitFile);
      if (accessEval.ownerId && !accessEval.isOwner && !matchedBrainDir) {
        const dirs = getBrainDirs();
        const dirDesc = dirs.length === 1 ? `'${dirs[0]}'` : `'${dirs.join("' or '")}'`;
        return {
          matched: true,
          allowed: false,
          isAccessDenial: true,
          reason: buildTranscriptAccessDenial({
            subcommand,
            mode: accessEval.mode,
            source: accessEval.source,
            callerConvId: convId,
            rosterName: accessEval.rosterName,
            detail: `'--file' paths outside ${dirDesc} are disabled while a parent transcript access policy is active.`
          })
        };
      }
      if (matchedBrainDir) {
        const rel = path.relative(
          tryRealpath(path.resolve(matchedBrainDir)),
          tryRealpath(resolveHookPath(targetInfo.explicitFile))
        );
        const firstSeg = rel.split(path.sep)[0];
        if (firstSeg && firstSeg !== "." && firstSeg !== "..") {
          resolvedTargetConvId = firstSeg;
        }
      }
    }

    return {
      matched: true,
      allowed: true,
      subcommand,
      mode: "open",
      needsReadGrant: true,
      targetConvId: resolvedTargetConvId,
      injectParentId
    };
  }

  return { matched: true, allowed: true, subcommand, mode: "open", needsReadGrant: false };
}

/**
 * Extracts redirect target paths from a segment's unquoted tokens.
 */
function extractRedirectTargets(tokens) {
  const targets = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.quoted && REDIRECT_OP_REGEX.test(tok.raw)) {
      if (tokens[i + 1]) targets.push(tokens[i + 1].value);
      continue;
    }
    const attached = tok.raw.match(REDIRECT_ATTACHED_REGEX);
    if (attached && !tok.quoted) {
      targets.push(attached[1].replace(/^["']|["']$/g, ""));
    }
  }
  return targets;
}

const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack", "select-string"]);
const SEARCH_VALUE_FLAGS = new Set([
  "-e", "--regexp", "-f", "--file", "-m", "--max-count",
  "-A", "--after-context", "-B", "--before-context", "-C", "--context",
  "-t", "--type", "-T", "--type-not", "-g", "--glob", "--iglob",
  "-M", "--max-columns", "--max-filesize", "--color", "-j", "--threads",
  "-r", "--replace", "--sort", "--sortr"
]);

/**
 * Extracts inspectable path tokens for a segment, ignoring benign echo/printf text
 * and ignoring literal search patterns on grep/rg commands (inspecting only target paths).
 */
function getInspectableTextForSegment(seg, opts = {}) {
  const { prefix: envPrefix, body } = splitEnvPrefix(seg.text);
  const allTokens = tokenizeShellWordsDetailed(seg.text);
  const detailed = body ? tokenizeShellWordsDetailed(body) : allTokens;
  if (detailed.length === 0) return "";

  const cmd0 = normalizeCmdName(detailed[0].value);
  const cmd1 = detailed[1] ? normalizeCmdName(detailed[1].value) : "";
  const cmd2 = detailed[2] ? normalizeCmdName(detailed[2].value) : "";

  // Benign standalone echo / printf: only inspect redirect targets (never printed prose),
  // UNLESS piped into a downstream command (e.g. `echo <b64> | base64 -d | xargs head`)
  if (!opts.hasDownstreamPipe && (cmd0 === "echo" || cmd0 === "printf" || cmd0 === "write-output")) {
    const redirects = extractRedirectTargets(allTokens);
    return redirects.join(" ");
  }

  // `git commit` / `git tag` (including `rtk git ...` and trusted `node <rtk-run.mjs> git ...`):
  // skip literal `-m` / `--message` / safe combined `-am` prose values while preserving leading
  // env assignments, redirects, `-F`/`--file`, and paths (subshells are inspected separately).
  let gitBaseIdx = -1;
  if (cmd0 === "git") {
    gitBaseIdx = 0;
  } else if (cmd0 === "rtk" && cmd1 === "git") {
    gitBaseIdx = 1;
  } else if (cmd0 === "node" && detailed[1] && isTrustedLocalRtkLauncherPath(detailed[1].value) && cmd2 === "git") {
    gitBaseIdx = 2;
  }
  if (gitBaseIdx !== -1) {
    const gitGlobalValueFlags = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
    let subIdx = gitBaseIdx + 1;
    while (subIdx < detailed.length) {
      const v = detailed[subIdx].value;
      if (gitGlobalValueFlags.has(v)) {
        subIdx += 2;
        continue;
      }
      if (v.startsWith("-")) {
        subIdx++;
        continue;
      }
      break;
    }
    const gitSub = subIdx < detailed.length ? normalizeCmdName(detailed[subIdx].value) : "";
    if (gitSub === "commit" || gitSub === "tag") {
      const safeMsgPrefixRe = gitSub === "commit" ? /^-[apsnvqezoih]*m$/ : /^-[asfdvin]*m$/;
      const safeMsgInlineRe = gitSub === "commit" ? /^-[apsnvqezoih]*m.+/ : /^-[asfdvin]*m.+/;
      const isUnquotedRedirect = (t) =>
        Boolean(t && !t.quoted && (REDIRECT_OP_REGEX.test(t.raw) || REDIRECT_ATTACHED_REGEX.test(t.raw)));
      const kept = [];
      if (envPrefix && envPrefix.trim()) {
        kept.push(envPrefix.trim());
      }
      let afterDoubleDash = false;
      for (let i = 0; i < detailed.length; i++) {
        const tok = detailed[i];
        if (i <= subIdx) {
          kept.push(tok.value);
          continue;
        }
        if (isUnquotedRedirect(tok)) {
          kept.push(tok.raw);
          if (!tok.quoted && REDIRECT_OP_REGEX.test(tok.raw) && i + 1 < detailed.length) {
            kept.push(detailed[++i].value);
          }
          continue;
        }
        if (!afterDoubleDash && tok.value === "--") {
          afterDoubleDash = true;
          kept.push(tok.value);
          continue;
        }
        if (!afterDoubleDash) {
          if (tok.value === "-m" || tok.value === "--message" || safeMsgPrefixRe.test(tok.value)) {
            if (i + 1 < detailed.length && !isUnquotedRedirect(detailed[i + 1])) {
              i++; // skip literal message payload (never an unquoted redirect)
            }
            continue;
          }
          if (tok.value.startsWith("--message=") || (!tok.value.startsWith("--") && safeMsgInlineRe.test(tok.value))) {
            continue;
          }
        }
        kept.push(tok.value);
      }
      const redirs = extractRedirectTargets(allTokens);
      for (const r of redirs) kept.push(r);
      return kept.join(" ");
    }
  }

  // Search commands: skip pattern argument and inspect only target paths / -f files / redirects
  let argStart = -1;
  if (SEARCH_COMMANDS.has(cmd0)) {
    argStart = 1;
  } else if ((cmd0 === "rtk" && (cmd1 === "grep" || cmd1 === "rg")) || (cmd0 === "git" && cmd1 === "grep")) {
    argStart = 2;
  } else if (cmd0 === "node" && detailed[1] && isTrustedLocalRtkLauncherPath(detailed[1].value) && (cmd2 === "grep" || cmd2 === "rg")) {
    argStart = 3;
  }

  if (argStart !== -1) {
    const targets = extractRedirectTargets(allTokens);
    if (envPrefix && envPrefix.trim()) {
      targets.unshift(envPrefix.trim());
    }
    let hasExplicitPattern = false;
    let afterDoubleDash = false;
    const positionals = [];

    for (let i = argStart; i < detailed.length; i++) {
      const tok = detailed[i];
      if (!tok.quoted && REDIRECT_OP_REGEX.test(tok.raw)) {
        i++; // skip redirect target (already in targets)
        continue;
      }
      if (!tok.quoted && REDIRECT_ATTACHED_REGEX.test(tok.raw)) {
        continue;
      }
      const val = tok.value;
      if (!afterDoubleDash && val === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && val.startsWith("-") && val !== "-") {
        if (val === "--regexp" || val.startsWith("--regexp=")) {
          hasExplicitPattern = true;
          if (val === "--regexp" && i + 1 < detailed.length) i++;
          continue;
        }
        if (val === "-f" || val === "--file" || (!val.startsWith("--") && /^-[^-]*f$/.test(val))) {
          if (detailed[i + 1]) targets.push(detailed[i + 1].value);
          i++;
          hasExplicitPattern = true;
          continue;
        }
        if (!val.startsWith("--") && /^-([^-]*)f(.+)$/.test(val)) {
          const fIdx = val.indexOf("f");
          targets.push(val.slice(fIdx + 1));
          hasExplicitPattern = true;
          continue;
        }
        if (val.startsWith("--file=")) {
          targets.push(val.slice("--file=".length));
          hasExplicitPattern = true;
          continue;
        }
        if (!val.startsWith("--") && /^-[^-]*e/.test(val)) {
          hasExplicitPattern = true;
          if (/^-[^-]*e$/.test(val) && i + 1 < detailed.length) i++;
          continue;
        }
        if (SEARCH_VALUE_FLAGS.has(val) && i + 1 < detailed.length) {
          i++;
        }
        continue;
      }
      positionals.push(val);
    }

    // First positional is the pattern unless -e / -f was provided
    const filePositionals = hasExplicitPattern ? positionals : positionals.slice(1);
    targets.push(...filePositionals);
    return targets.join(" ");
  }

  const unquotedJoined = allTokens.map((t) => t.value).join(" ");
  return unquotedJoined && unquotedJoined !== seg.text ? `${seg.text}\n${unquotedJoined}` : seg.text;
}

const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "eval"]);
const CODE_INTERPRETERS = new Set(["python", "python2", "python3", "node", "perl", "ruby", "php", "pwsh", "powershell"]);
const CODE_FILE_ACCESS_REGEX = /\b(?:open|read|readFile|readFileSync|createReadStream|readdir|listdir|scandir|walk|glob|iglob|readlines|Path|subprocess|popen|system|exec|spawn|eval|require|import|from\s+\w+\s+import|__import__|getattr|b64decode|atob|fs\.|os\.|io\.|path\.)\b|Buffer\.from/i;

function getSegmentCmdName(seg) {
  const { body } = splitEnvPrefix(seg.text || "");
  const tokens = tokenizeShellWords(body || seg.text || "");
  return tokens.length > 0 ? normalizeCmdName(tokens[0]) : "";
}

function collectSegmentWrittenTargets(segments, depth = 0, out = new Set()) {
  if (depth > 4) return out;
  for (const seg of segments) {
    const tokens = tokenizeShellWordsDetailed(seg.text || "");
    if (seg.hasWriteRedirect) {
      for (const redir of extractRedirectTargets(tokens)) {
        const norm = normalizeSessionTrackedPath(redir);
        if (norm) out.add(norm);
      }
    }
    const segCmd = getSegmentCmdName(seg);
    const nonFlagArgs = tokenizeShellWords(seg.text || "").slice(1).filter((t) => t && !t.startsWith("-"));
    if ((segCmd === "cp" || segCmd === "mv" || segCmd === "ln" || segCmd === "install") && nonFlagArgs.length >= 2) {
      const dst = normalizeSessionTrackedPath(nonFlagArgs[nonFlagArgs.length - 1]);
      if (dst) out.add(dst);
    } else if (segCmd === "tee") {
      for (const target of nonFlagArgs) {
        const norm = normalizeSessionTrackedPath(target);
        if (norm) out.add(norm);
      }
    } else if (segCmd === "dd") {
      for (const tok of tokenizeShellWords(seg.text || "")) {
        if (tok.startsWith("of=")) {
          const norm = normalizeSessionTrackedPath(tok.slice(3));
          if (norm) out.add(norm);
        }
      }
    }
    const wrapped = extractWrappedScriptInfo(seg.text);
    if (wrapped && wrapped.innerScript) {
      collectSegmentWrittenTargets(splitShellSegments(wrapped.innerScript), depth + 1, out);
    }
    if (Array.isArray(seg.subshells)) {
      for (const sub of seg.subshells) {
        collectSegmentWrittenTargets(splitShellSegments(sub), depth + 1, out);
      }
    }
  }
  return out;
}

function isRestrictedLifecycleInvocation(segments, depth = 0) {
  if (depth > 4) return false;
  for (const seg of segments) {
    const rawSeg = String(seg.text || "");
    if (
      /\bagy-context(?:-saver)?(?:\.m?js)?\s+(?:--?(?:setup|install|uninstall|restore-backups)|setup|install|uninstall|restore-backups)\b/i.test(
        rawSeg
      ) ||
      /\bnpm\s+(?:--prefix\s+\S+\s+)?run\s+(?:setup|uninstall)\b/i.test(rawSeg)
    ) {
      return true;
    }
    const segCmd = getSegmentCmdName(seg);
    if (SHELL_INTERPRETERS.has(segCmd) || CODE_INTERPRETERS.has(segCmd) || segCmd === "npx" || segCmd === "bun") {
      const segTokens = tokenizeShellWords(rawSeg);
      for (let i = 1; i < segTokens.length; i++) {
        const tok = String(segTokens[i] || "").trim().replace(/\\/g, "/");
        if (!tok || tok.startsWith("-")) continue;
        if (/(?:^|\/)install-register\.mjs$/i.test(tok)) {
          const resolvedNorm = normalizeSessionTrackedPath(tok);
          if (!/\/agy-squad\/scripts\/install-register\.mjs$/i.test(resolvedNorm) && !/\/agy-squad\/scripts\/install-register\.mjs$/i.test(tok)) {
            return true;
          }
        }
      }
    }
    const wrapped = extractWrappedScriptInfo(seg.text);
    if (wrapped && wrapped.innerScript && isRestrictedLifecycleInvocation(splitShellSegments(wrapped.innerScript), depth + 1)) {
      return true;
    }
    if (Array.isArray(seg.subshells)) {
      for (const sub of seg.subshells) {
        if (isRestrictedLifecycleInvocation(splitShellSegments(sub), depth + 1)) return true;
      }
    }
  }
  return false;
}

const GH_VALUE_FLAGS = new Set([
  "-R",
  "--repo",
  "-i",
  "--interval",
  "-q",
  "--jq",
  "-t",
  "--template",
  "-H",
  "--hostname"
]);

function findBlockingWatchLoop(segments, depth = 0) {
  if (depth > 4) return null;
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    const pipelineCmds = [getSegmentCmdName(seg)];
    for (let j = segIdx + 1; j < segments.length; j++) {
      const nextSeg = segments[j];
      if (nextSeg.leadingSep !== "|" && nextSeg.leadingSep !== "|&") break;
      pipelineCmds.push(getSegmentCmdName(nextSeg));
    }

    const { body } = splitEnvPrefix(seg.text || "");
    const tokens = tokenizeShellWords(body || seg.text || "");
    let idx = 0;
    while (idx < tokens.length) {
      const norm = normalizeCmdName(tokens[idx]);
      if (norm === "rtk" || norm === "command" || norm === "exec" || norm === "nohup") {
        idx++;
        continue;
      }
      if (norm === "sudo") {
        idx++;
        while (idx < tokens.length && tokens[idx].startsWith("-")) {
          if (tokens[idx] === "-u" || tokens[idx] === "-g" || tokens[idx] === "-h" || tokens[idx] === "-p" || tokens[idx] === "-C") {
            idx += 2;
          } else {
            idx++;
          }
        }
        continue;
      }
      break;
    }

    if (idx < tokens.length && normalizeCmdName(tokens[idx]) === "gh") {
      const rest = tokens.slice(idx + 1);
      const positionals = [];
      let hasHelpFlag = false;
      let hasWatchFlag = false;
      let afterDoubleDash = false;
      for (let i = 0; i < rest.length; i++) {
        const tok = String(rest[i] || "");
        if (!afterDoubleDash && tok === "--") {
          afterDoubleDash = true;
          continue;
        }
        if (!afterDoubleDash && tok.startsWith("-") && tok !== "-") {
          if (tok === "--help" || tok === "-h") {
            hasHelpFlag = true;
            break;
          }
          const isShortValueAttached = /^-[RiqHt].+/.test(tok);
          if (
            tok === "--watch" ||
            /^--watch=(?:true|1|yes)$/i.test(tok) ||
            (!isShortValueAttached && /^-[a-zA-Z]*w[a-zA-Z]*$/.test(tok))
          ) {
            hasWatchFlag = true;
            continue;
          }
          if (GH_VALUE_FLAGS.has(tok) && i + 1 < rest.length) {
            i++;
          }
          continue;
        }
        positionals.push(tok.toLowerCase());
      }
      if (!hasHelpFlag) {
        if (positionals[0] === "pr" && positionals[1] === "checks" && hasWatchFlag) {
          return { command: "gh pr checks --watch" };
        }
        if (positionals[0] === "run" && positionals[1] === "watch") {
          return { command: "gh run watch" };
        }
      }
    }

    const wrapped = extractWrappedScriptInfo(seg.text);
    if (wrapped && wrapped.innerScript) {
      const nested = findBlockingWatchLoop(splitShellSegments(wrapped.innerScript), depth + 1);
      if (nested) return nested;
    }
    if (Array.isArray(seg.subshells)) {
      for (const sub of seg.subshells) {
        const nested = findBlockingWatchLoop(splitShellSegments(sub), depth + 1);
        if (nested) return nested;
      }
    }
    if (
      Array.isArray(seg.heredocBodies) &&
      seg.heredocBodies.length > 0 &&
      pipelineCmds.some((c) => SHELL_INTERPRETERS.has(c))
    ) {
      for (const hdBody of seg.heredocBodies) {
        if (!hdBody) continue;
        const nested = findBlockingWatchLoop(splitShellSegments(hdBody), depth + 1);
        if (nested) return nested;
      }
    }
  }
  return null;
}

/**
 * Recursively collects inspectable command texts (main segment, unquoted forms,
 * bash/sh/eval inner scripts, nested subshells, and interpreter/xargs heredoc bodies).
 * Plain documentation heredocs (e.g. `cat > file <<'EOF'`) and non-code prompt text remain exempt.
 */
function collectInspectableTexts(segments, depth = 0, options = {}) {
  if (depth > 4) return [];
  const texts = [];
  const isRestrictedChild = Boolean(options.isRestrictedChild);
  const convId = options.convId || "global";
  const pendingWrittenSet = options.pendingWrittenSet || new Set();
  const osTmpNorm = os.tmpdir().replace(/\\/g, "/");

  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx];
    const segCmd = getSegmentCmdName(seg);
    const pipelineCmds = [segCmd];
    for (let j = idx + 1; j < segments.length; j++) {
      const nextSeg = segments[j];
      if (nextSeg.leadingSep !== "|" && nextSeg.leadingSep !== "|&") break;
      pipelineCmds.push(getSegmentCmdName(nextSeg));
    }
    const downstreamCmds = pipelineCmds.slice(1);

    const inspectable = getInspectableTextForSegment(seg, { hasDownstreamPipe: downstreamCmds.length > 0 });
    if (inspectable) texts.push(inspectable);

    const wrapped = extractWrappedScriptInfo(seg.text);
    if (wrapped && wrapped.innerScript) {
      texts.push(...collectInspectableTexts(splitShellSegments(wrapped.innerScript), depth + 1, options));
    }

    if (Array.isArray(seg.subshells)) {
      for (const sub of seg.subshells) {
        const subSegs = splitShellSegments(sub);
        texts.push(...collectInspectableTexts(subSegs, depth + 1, options));
      }
    }

    if (segCmd === "base64" && downstreamCmds.some((c) => SHELL_INTERPRETERS.has(c) || CODE_INTERPRETERS.has(c))) {
      texts.push("base64 | sh");
    }

    // Inspect on-disk script files executed by shell/code interpreters (when in /tmp, /scratch, non-script extension, or written in restricted child session)
    if ((SHELL_INTERPRETERS.has(segCmd) && segCmd !== "eval") || CODE_INTERPRETERS.has(segCmd)) {
      const segTokens = tokenizeShellWords(seg.text || "");
      const inspectScriptToken = (rawTok) => {
        const tok = String(rawTok || "").trim();
        if (!tok) return false;
        if (isAllowedAgyContextScriptPath(tok) || isTrustedLocalRtkLauncherPath(tok)) return true;
        try {
          const resolvedFile = resolveHookPath(tok);
          const normFile = resolvedFile.replace(/\\/g, "/");
          if (!fs.existsSync(resolvedFile)) return false;
          const st = fs.statSync(resolvedFile);
          if (!st.isFile()) return false;
          const trackedNorm = normalizeSessionTrackedPath(resolvedFile);
          const isTmpOrScratchFile =
            normFile.startsWith("/tmp/") ||
            normFile.startsWith("/var/tmp/") ||
            normFile.startsWith(osTmpNorm + "/") ||
            normFile.includes("/scratch/");
          const isNonScriptExt = !isExecutableScriptPath(normFile);
          const isChildMutatedScript =
            isRestrictedChild &&
            (pendingWrittenSet.has(trackedNorm) || wasFileWrittenInSession(convId, resolvedFile));
          if (isTmpOrScratchFile || isNonScriptExt || isChildMutatedScript) {
            if (st.size > 0 && st.size <= 131072) {
              texts.push(fs.readFileSync(resolvedFile, "utf-8"));
            }
          }
          return true;
        } catch {
          return false;
        }
      };

      const isDocOrJsonArg = (t) => /\.(?:md|markdown|json)$/i.test(t);

      const isNode = segCmd === "node";
      const isPython = segCmd === "python" || segCmd === "python2" || segCmd === "python3";
      const isShell = SHELL_INTERPRETERS.has(segCmd);
      const isPowerShell = segCmd === "pwsh" || segCmd === "powershell";
      const isRuby = segCmd === "ruby";
      const isPerl = segCmd === "perl";
      const isPhp = segCmd === "php";

      let afterDoubleDash = false;
      let inlineCodeMode = false;
      let consumedPrimaryScript = false;
      let expectCodeFileArg = false;
      let expectSkipValueArg = false;
      let expectStdinFile = false;

      for (let tIdx = 1; tIdx < segTokens.length; tIdx++) {
        const tok = String(segTokens[tIdx] || "").trim();
        if (!tok) continue;

        if (expectStdinFile) {
          expectStdinFile = false;
          inspectScriptToken(tok);
          continue;
        }
        if (tok === "<") {
          expectStdinFile = true;
          continue;
        }
        if (tok.startsWith("<") && !tok.startsWith("<<")) {
          inspectScriptToken(tok.slice(1));
          continue;
        }
        if (expectCodeFileArg) {
          expectCodeFileArg = false;
          inspectScriptToken(tok);
          continue;
        }
        if (expectSkipValueArg) {
          expectSkipValueArg = false;
          continue;
        }

        if (!afterDoubleDash) {
          if (tok === "--") {
            afterDoubleDash = true;
            continue;
          }
          if (tok === "-") {
            consumedPrimaryScript = true;
            continue;
          }
          if (tok.startsWith("-") || (isShell && tok === "+o")) {
            const lower = tok.toLowerCase();
            if (isNode) {
              const eqIdx = tok.indexOf("=");
              const flag = eqIdx === -1 ? tok : tok.slice(0, eqIdx);
              const inlineVal = eqIdx === -1 ? null : tok.slice(eqIdx + 1);
              if (flag === "-r" || flag === "--require" || flag === "--import" || flag === "--loader" || flag === "--experimental-loader") {
                if (inlineVal !== null) inspectScriptToken(inlineVal);
                else expectCodeFileArg = true;
              } else if (flag === "-e" || flag === "--eval" || flag === "-p" || flag === "--print") {
                inlineCodeMode = true;
                if (inlineVal === null) expectSkipValueArg = true;
              } else if (
                flag === "-C" || flag === "--conditions" || flag === "--input-type" ||
                flag === "--env-file" || flag === "--env-file-if-exists" || flag === "--watch-path" ||
                flag === "--watch-kill-signal" || flag === "--cpu-prof-dir" || flag === "--cpu-prof-interval" ||
                flag === "--cpu-prof-name" || flag === "--heap-prof-dir" || flag === "--heap-prof-interval" ||
                flag === "--heap-prof-name" || flag === "--diagnostic-dir" || flag === "--redirect-warnings" ||
                flag === "--title" || flag === "--max-old-space-size" || flag === "--max-semi-space-size" ||
                flag === "--max-http-header-size" || flag === "--heapsnapshot-signal" ||
                flag === "--heapsnapshot-near-heap-limit" || flag === "--dns-result-order" ||
                flag === "--disable-proto" || flag === "--disable-warning" || flag === "--icu-data-dir" ||
                flag === "--openssl-config" || flag === "--build-snapshot-config" ||
                flag === "--experimental-config-file" || flag === "--experimental-sea-config" ||
                flag === "--unhandled-rejections" || flag === "--use-largepages" || flag === "--v8-pool-size" ||
                flag === "--trace-event-categories" || flag === "--trace-event-file-pattern" ||
                flag === "--allow-fs-read" || flag === "--allow-fs-write" || flag === "--inspect" ||
                flag === "--inspect-brk" || flag === "--inspect-port" || flag === "--inspect-wait" ||
                flag === "--test-name-pattern" || flag === "--test-reporter" ||
                flag === "--test-reporter-destination" || flag === "--test-shard" ||
                flag === "--test-concurrency" || flag === "--test-timeout" || flag === "--report-dir" ||
                flag === "--report-directory" || flag === "--report-filename" || flag === "--report-signal" ||
                flag === "--secure-heap" || flag === "--secure-heap-min" || flag === "--tls-cipher-list"
              ) {
                if (inlineVal === null) expectSkipValueArg = true;
              }
            } else if (isPython) {
              if (tok === "-c" || tok === "-m") {
                inlineCodeMode = true;
                expectSkipValueArg = true;
              } else if (tok.startsWith("-c") || tok.startsWith("-m")) {
                inlineCodeMode = true;
              } else if (tok === "-W" || tok === "-X" || tok === "-Q" || tok === "--check-hash-based-pycs") {
                expectSkipValueArg = true;
              }
            } else if (isShell) {
              if (/^-[a-z]*c$/i.test(tok)) {
                inlineCodeMode = true;
                expectSkipValueArg = true;
              } else if (tok === "-o" || tok === "+o") {
                expectSkipValueArg = true;
              }
            } else if (isPowerShell) {
              if (lower === "-command" || lower === "-c" || lower === "-encodedcommand" || lower === "-ec" || lower === "-e") {
                inlineCodeMode = true;
                expectSkipValueArg = true;
              } else if (lower === "-file" || lower === "-f") {
                expectCodeFileArg = true;
              } else if (
                lower === "-executionpolicy" || lower === "-ep" || lower === "-windowstyle" || lower === "-w" ||
                lower === "-workingdirectory" || lower === "-wd" || lower === "-outputformat" || lower === "-of" ||
                lower === "-inputformat" || lower === "-if" || lower === "-settingsfile" ||
                lower === "-configurationname" || lower === "-custompipename" || lower === "-version" || lower === "-v"
              ) {
                expectSkipValueArg = true;
              }
            } else if (isRuby) {
              if (tok === "-e") {
                inlineCodeMode = true;
                expectSkipValueArg = true;
              } else if (tok === "-r") {
                expectCodeFileArg = true;
              } else if (
                tok === "-I" || tok === "-C" || tok === "-E" || tok === "-F" || tok === "-K" ||
                tok === "--encoding" || tok === "--external-encoding" || tok === "--internal-encoding"
              ) {
                expectSkipValueArg = true;
              }
            } else if (isPerl) {
              if (tok === "-e" || tok === "-E") {
                inlineCodeMode = true;
                expectSkipValueArg = true;
              } else if (tok === "-I" || tok === "-M" || tok === "-m") {
                expectSkipValueArg = true;
              }
            } else if (isPhp) {
              if (tok === "-r") {
                inlineCodeMode = true;
                expectSkipValueArg = true;
              } else if (tok === "-f") {
                expectCodeFileArg = true;
              } else if (tok === "-d" || tok === "-c") {
                expectSkipValueArg = true;
              }
            }
            continue;
          }
        }

        if (inlineCodeMode) {
          if (!isDocOrJsonArg(tok)) {
            inspectScriptToken(tok);
          }
          continue;
        }

        if (consumedPrimaryScript) {
          if (!isDocOrJsonArg(tok)) {
            inspectScriptToken(tok);
          }
          continue;
        }

        const isExistingRegularFile = inspectScriptToken(tok);
        if (isExistingRegularFile && !isDocOrJsonArg(tok)) {
          consumedPrimaryScript = true;
        }
      }
    }

    if (Array.isArray(seg.heredocBodies) && seg.heredocBodies.length > 0) {
      const hasShellConsumer = pipelineCmds.some((c) => SHELL_INTERPRETERS.has(c));
      const hasXargsConsumer = pipelineCmds.some((c) => c === "xargs");
      const hasCodeConsumer = !seg.hasWriteRedirect && pipelineCmds.some((c) => CODE_INTERPRETERS.has(c));
      let writesExecutableOrTmpScript = false;
      if (seg.hasWriteRedirect) {
        const redirectTargets = extractRedirectTargets(tokenizeShellWordsDetailed(seg.text || ""));
        writesExecutableOrTmpScript = redirectTargets.some((t) => {
          const normT = String(t || "").replace(/\\/g, "/");
          return (
            isExecutableScriptPath(normT) ||
            normT.startsWith("/tmp/") ||
            normT.startsWith("/var/tmp/") ||
            normT.startsWith(osTmpNorm + "/")
          );
        });
      }

      for (const hdBody of seg.heredocBodies) {
        if (!hdBody) continue;
        if (hasShellConsumer) {
          texts.push(...collectInspectableTexts(splitShellSegments(hdBody), depth + 1, options));
        } else if (hasXargsConsumer) {
          texts.push(hdBody);
        } else if (hasCodeConsumer && CODE_FILE_ACCESS_REGEX.test(hdBody)) {
          texts.push(hdBody);
        } else if (writesExecutableOrTmpScript || /^\s*#!/.test(hdBody)) {
          texts.push(hdBody);
        }
      }
    }
  }
  return texts;
}

const RTK_READ_LINE_VALUE_FLAGS = new Set(["--head-lines", "--tail-lines", "--max-lines", "-m"]);
const RTK_READ_OTHER_VALUE_FLAGS = new Set(["-l", "--level"]);
const RTK_READ_ALLOWED_LEVELS = new Set(["none", "minimal", "aggressive"]);

/**
 * Parses an `rtk read ...` invocation (fail-closed on env prefixes: PR9-RUN-007 Closed (By Design)).
 * Tracks positional operands after `--`, validates line bounds (`1 <= n <= MAX_SAFE_SLICE_LINES`),
 * and rejects disallowed flags or `-l`/`--level` values.
 */
function parseRtkReadCommand(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  const tokens = tokenizeShellWords(cmd);
  if (tokens.length < 2) return null;
  let argStart = -1;
  if (normalizeCmdName(tokens[0]) === "rtk" && tokens[1].toLowerCase() === "read") {
    argStart = 2;
  } else if (
    tokens.length >= 3 &&
    normalizeCmdName(tokens[0]) === "node" &&
    isTrustedLocalRtkLauncherPath(tokens[1]) &&
    tokens[2].toLowerCase() === "read"
  ) {
    argStart = 3;
  }
  if (argStart === -1) return null;

  const operands = [];
  const lineLimits = [];
  let hasInvalidOrOversizedLineBound = false;
  let hasDisallowedFlag = false;
  let afterDoubleDash = false;

  const recordLineLimit = (rawVal) => {
    if (!/^\d+$/.test(rawVal)) {
      hasInvalidOrOversizedLineBound = true;
      return;
    }
    const n = Number(rawVal);
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_SAFE_SLICE_LINES) {
      hasInvalidOrOversizedLineBound = true;
      return;
    }
    lineLimits.push(n);
  };

  for (let i = argStart; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!afterDoubleDash && tok === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (afterDoubleDash || !tok.startsWith("-") || tok === "-") {
      operands.push(tok);
      continue;
    }
    if (RTK_READ_LINE_VALUE_FLAGS.has(tok)) {
      if (i + 1 >= tokens.length) {
        hasInvalidOrOversizedLineBound = true;
      } else {
        recordLineLimit(tokens[++i]);
      }
      continue;
    }
    const eqIdx = tok.indexOf("=");
    if (eqIdx > 0) {
      const flagName = tok.slice(0, eqIdx);
      const flagVal = tok.slice(eqIdx + 1);
      if (flagName === "--head-lines" || flagName === "--tail-lines" || flagName === "--max-lines") {
        recordLineLimit(flagVal);
        continue;
      }
      if (flagName === "--level") {
        if (!RTK_READ_ALLOWED_LEVELS.has(flagVal.toLowerCase())) hasDisallowedFlag = true;
        continue;
      }
      hasDisallowedFlag = true;
      continue;
    }
    if (tok.startsWith("-m") && tok.length > 2) {
      recordLineLimit(tok.slice(2));
      continue;
    }
    if (RTK_READ_OTHER_VALUE_FLAGS.has(tok)) {
      const levelVal = i + 1 < tokens.length ? tokens[++i] : "";
      if (!RTK_READ_ALLOWED_LEVELS.has(levelVal.toLowerCase())) hasDisallowedFlag = true;
      continue;
    }
    if (tok.startsWith("-l") && tok.length > 2) {
      if (!RTK_READ_ALLOWED_LEVELS.has(tok.slice(2).toLowerCase())) hasDisallowedFlag = true;
      continue;
    }
    if (/^(?:-n|--line-numbers|--skip-env|-h|--help)$/i.test(tok) || /^-[nh]+$/i.test(tok)) {
      continue;
    }
    hasDisallowedFlag = true;
  }

  return {
    operands,
    lineLimits,
    hasSafeLineBound: lineLimits.length > 0 && !hasInvalidOrOversizedLineBound,
    hasInvalidOrOversizedLineBound,
    hasDisallowedFlag
  };
}

function isRtkReadCommand(cmd) {
  return Boolean(parseRtkReadCommand(cmd));
}

/**
 * Parses a single unchained bounded `head -n <N>` / `tail -n <N>` command for degraded mode (when RTK is unavailable).
 * Enforces explicit positive line limits `1 <= N <= MAX_SAFE_SLICE_LINES`, rejects `+N` offsets and unknown flags,
 * and returns parsed positional operands for single-operand isolation checks.
 */
function parseDegradedBoundedHeadTailCommand(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  const tokens = tokenizeShellWords(cmd);
  if (tokens.length < 2) return null;
  const verb = normalizeCmdName(tokens[0]);
  if (verb !== "head" && verb !== "tail") return null;

  const operands = [];
  const lineLimits = [];
  let hasInvalidOrOversizedLineBound = false;
  let hasDisallowedFlag = false;
  let afterDoubleDash = false;

  const recordLineLimit = (rawVal) => {
    if (!/^\d+$/.test(rawVal)) {
      hasInvalidOrOversizedLineBound = true;
      return;
    }
    const n = Number(rawVal);
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_SAFE_SLICE_LINES) {
      hasInvalidOrOversizedLineBound = true;
      return;
    }
    lineLimits.push(n);
  };

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!afterDoubleDash && tok === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (afterDoubleDash || !tok.startsWith("-") || tok === "-") {
      operands.push(tok);
      continue;
    }
    if (tok === "-n" || tok === "--lines") {
      if (i + 1 >= tokens.length) {
        hasInvalidOrOversizedLineBound = true;
      } else {
        recordLineLimit(tokens[++i]);
      }
      continue;
    }
    if (tok.startsWith("--lines=")) {
      recordLineLimit(tok.slice("--lines=".length));
      continue;
    }
    if (tok.startsWith("-n") && tok.length > 2) {
      recordLineLimit(tok.slice(2));
      continue;
    }
    hasDisallowedFlag = true;
  }

  return {
    operands,
    lineLimits,
    hasSafeLineBound: lineLimits.length > 0 && !hasInvalidOrOversizedLineBound,
    hasInvalidOrOversizedLineBound,
    hasDisallowedFlag
  };
}

function isSingleUnchainedShellCmd(segments) {
  if (segments.length !== 1) return false;
  const seg = segments[0];
  return !seg.hasRedirect && !seg.hasHeredoc && !seg.hasSubshell && !hasDotDotTraversal(seg.text);
}

// ============================================================================
// RTK Post-Processing (wc/ls/diff revert & rg -> rtk grep fallback)
// ============================================================================

const RG_GREP_ZERO_ARG_FLAGS = new Map([
  ["-i", "-i"], ["--ignore-case", "-i"],
  ["-n", "-n"], ["--line-number", "-n"],
  ["-l", "-l"], ["--files-with-matches", "-l"],
  ["-c", "-c"], ["--count", "-c"],
  ["-v", "-v"], ["--invert-match", "-v"],
  ["-w", "-w"], ["--word-regexp", "-w"],
  ["-x", "-x"], ["--line-regexp", "-x"],
  ["-F", "-F"], ["--fixed-strings", "-F"],
  ["-E", "-E"], ["--extended-regexp", "-E"],
  ["-P", "-P"], ["--pcre2", "-P"],
  ["-a", "-a"], ["--text", "-a"],
  ["-0", "-Z"], ["--null", "-Z"],
  ["-H", "-H"], ["--with-filename", "-H"],
  ["-h", "-h"], ["--no-filename", "-h"], ["-I", "-h"],
  ["-q", "-q"], ["--quiet", "-q"],
  ["-s", "-s"], ["--no-messages", "-s"],
  ["-o", "-o"], ["--only-matching", "-o"]
]);

const RG_NOOP_FLAGS = new Set([
  "--no-heading", "--heading", "-p", "--pretty", "--line-buffered",
  "-U", "--multiline", "--multiline-dotall",
  "-u", "-uu", "-uuu", "--unrestricted",
  "--no-ignore", "--no-ignore-vcs", "--no-ignore-parent", "--no-ignore-global",
  "--hidden", "-.", "--column", "--vimgrep", "--stats", "--json",
  "--passthru", "--passthrough", "--no-config", "--one-file-system", "--sort-files"
]);

const RG_GREP_VALUE_FLAGS = new Map([
  ["-m", "-m"], ["--max-count", "--max-count"],
  ["-A", "-A"], ["--after-context", "-A"],
  ["-B", "-B"], ["--before-context", "-B"],
  ["-C", "-C"], ["--context", "-C"],
  ["-e", "-e"], ["--regexp", "-e"]
]);

function hasPcreOnlyPattern(pattern) {
  if (!pattern) return false;
  return /\\[dDsSwW]|\(\?[=!<:#]|\\[pP]\{/.test(pattern);
}

const RG_TYPE_INCLUDE_MAP = {
  js: ["*.js", "*.mjs", "*.cjs", "*.jsx"],
  mjs: ["*.mjs"],
  cjs: ["*.cjs"],
  ts: ["*.ts", "*.mts", "*.cts", "*.tsx"],
  py: ["*.py", "*.pyi"],
  json: ["*.json"],
  md: ["*.md"],
  sh: ["*.sh", "*.bash"],
  yaml: ["*.yml", "*.yaml"],
  yml: ["*.yml", "*.yaml"],
  txt: ["*.txt"],
  css: ["*.css"],
  html: ["*.html", "*.htm"],
  rs: ["*.rs"],
  go: ["*.go"]
};

function quotePosixGrepFlagVal(val) {
  if (/^[A-Za-z0-9_.*?,/-]+$/.test(val)) return val;
  return `'${val.replace(/'/g, "'\\''")}'`;
}

function rewriteRtkRgSegment(rtkPrefixWord, restAfterRtk, { inPipeline = false } = {}) {
  const afterRgMatch = restAfterRtk.match(/^rg(?:\.exe)?\s+([\s\S]+)$/i);
  if (!afterRgMatch) return restAfterRtk;

  const tokens = tokenizeShellWordsDetailed(afterRgMatch[1]);
  const grepFlags = [];
  const positionals = [];
  const patterns = [];
  let hasExtended = false;
  let hasFixed = false;
  let hasSmartCase = false;
  let hasIgnoreCase = false;
  let hasFollow = false;
  let filesOnly = false;
  let hasExplicitPattern = false;
  let afterDoubleDash = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const val = tok.value;

    if (!afterDoubleDash && val === "--") {
      afterDoubleDash = true;
      continue;
    }

    if (!afterDoubleDash && val.startsWith("-") && val !== "-") {
      if (val === "--files") {
        filesOnly = true;
        continue;
      }
      if (val === "-S" || val === "--smart-case") {
        hasSmartCase = true;
        continue;
      }
      if (val === "-L" || val === "--follow") {
        hasFollow = true;
        continue;
      }
      if (RG_NOOP_FLAGS.has(val)) {
        continue;
      }
      if (RG_GREP_ZERO_ARG_FLAGS.has(val)) {
        const mapped = RG_GREP_ZERO_ARG_FLAGS.get(val);
        if (mapped === "-i") hasIgnoreCase = true;
        if (mapped === "-E" || mapped === "-P") hasExtended = true;
        if (mapped === "-F") hasFixed = true;
        grepFlags.push(mapped);
        continue;
      }

      if (RG_GREP_VALUE_FLAGS.has(val)) {
        if (i + 1 >= tokens.length) return restAfterRtk;
        const nextTok = tokens[++i];
        const mapped = RG_GREP_VALUE_FLAGS.get(val);
        if (mapped === "-e") {
          hasExplicitPattern = true;
          patterns.push(nextTok.value);
        }
        grepFlags.push(mapped, nextTok.raw);
        continue;
      }

      if (val === "-g" || val === "--glob" || val.startsWith("--glob=")) {
        let globVal;
        if (val.startsWith("--glob=")) {
          globVal = val.slice("--glob=".length);
        } else {
          if (i + 1 >= tokens.length) return restAfterRtk;
          globVal = tokens[++i].value;
        }
        if (globVal.startsWith("!")) {
          grepFlags.push(`--exclude=${quotePosixGrepFlagVal(globVal.slice(1))}`);
        } else {
          grepFlags.push(`--include=${quotePosixGrepFlagVal(globVal)}`);
        }
        continue;
      }

      if (val === "-t" || val === "--type" || val.startsWith("--type=") || val === "-T" || val === "--type-not" || val.startsWith("--type-not=")) {
        const isNot = val === "-T" || val.startsWith("--type-not");
        let typeVal;
        if (val.includes("=")) {
          typeVal = val.slice(val.indexOf("=") + 1).toLowerCase();
        } else {
          if (i + 1 >= tokens.length) return restAfterRtk;
          typeVal = tokens[++i].value.toLowerCase();
        }
        const exts = RG_TYPE_INCLUDE_MAP[typeVal];
        if (!exts) return restAfterRtk;
        for (const ext of exts) {
          grepFlags.push(`${isNot ? "--exclude" : "--include"}=${ext}`);
        }
        continue;
      }

      // Attached short flags like -in, -ni, -lw, -nS, -nU (exclude -r which is --replace in rg!)
      if (/^-[inlcvwxFEHhqsoSLPaUup]+$/.test(val)) {
        let clean = "-";
        for (const ch of val.slice(1)) {
          if (ch === "S") {
            hasSmartCase = true;
            continue;
          }
          if (ch === "L") {
            hasFollow = true;
            continue;
          }
          if (ch === "U" || ch === "u" || ch === "p") {
            continue;
          }
          if (ch === "i") hasIgnoreCase = true;
          if (ch === "E" || ch === "P") hasExtended = true;
          if (ch === "F") hasFixed = true;
          clean += ch;
        }
        if (clean.length > 1) grepFlags.push(clean);
        continue;
      }

      const eqIdx = val.indexOf("=");
      if (eqIdx !== -1) {
        const flagName = val.slice(0, eqIdx);
        const flagVal = val.slice(eqIdx + 1);
        if (RG_GREP_VALUE_FLAGS.has(flagName)) {
          if (flagName === "--regexp") {
            hasExplicitPattern = true;
            patterns.push(flagVal);
          }
          grepFlags.push(tok.raw);
          continue;
        }
        if (flagName === "--color") {
          grepFlags.push(tok.raw);
          continue;
        }
      }

      return restAfterRtk;
    }

    positionals.push(tok);
  }

  if (filesOnly) {
    const findTargets = positionals.map((p) => p.raw).join(" ") || ".";
    return `${rtkPrefixWord}find ${findTargets}`;
  }

  if (!hasExplicitPattern) {
    if (positionals.length === 0) return restAfterRtk;
    patterns.push(positionals[0].value);
  }

  const needsPcre = !hasFixed && patterns.some(hasPcreOnlyPattern);
  if (needsPcre && os.platform() !== "linux") {
    return restAfterRtk;
  }

  const outArgs = [];
  if (!inPipeline) {
    outArgs.push(hasFollow ? "-R" : "-r");
  }
  if (hasSmartCase && !hasIgnoreCase && !patterns.some((p) => /[A-Z]/.test(p))) {
    outArgs.push("-i");
  }
  if (needsPcre) {
    outArgs.push("-P");
  } else if (!hasFixed && !hasExtended) {
    outArgs.push("-E");
  }
  outArgs.push(...grepFlags);

  if (afterDoubleDash) {
    outArgs.push("--");
  }

  for (const p of positionals) {
    outArgs.push(p.raw);
  }

  const hasExplicitPath = hasExplicitPattern ? positionals.length > 0 : positionals.length > 1;
  if (!inPipeline && !hasExplicitPath) {
    outArgs.push(".");
  }

  return `${rtkPrefixWord}grep ${outArgs.join(" ")}`;
}

const GREP_VALUE_FLAGS = new Set([
  "-e", "--regexp", "-f", "--file", "-m", "--max-count",
  "-A", "--after-context", "-B", "--before-context", "-C", "--context",
  "-d", "--directories", "--include", "--exclude", "--exclude-dir", "--color", "-D", "--devices"
]);

/**
 * Normalizes `rtk grep` when host `rg` is absent so GNU `grep` receives `-r` (when targeting dirs/omitted)
 * and `-E` (for alternation/quantifiers like `a|b`) instead of failing with exit 2 ("Is a directory")
 * or exit 1 (BRE literal `|`).
 */
function rewriteRtkGrepSegment(rtkPrefixWord, restAfterRtk, { inPipeline = false } = {}) {
  const afterGrepMatch = restAfterRtk.match(/^grep(?:\.exe)?\s+([\s\S]+)$/i);
  if (!afterGrepMatch) return `${rtkPrefixWord}${restAfterRtk}`;

  const tokens = tokenizeShellWordsDetailed(afterGrepMatch[1]);
  let hasRecursive = false;
  let hasRegexMode = false;
  let hasExplicitPattern = false;
  let afterDoubleDash = false;
  const positionals = [];
  const patterns = [];

  for (let i = 0; i < tokens.length; i++) {
    const val = tokens[i].value;
    if (!afterDoubleDash && val === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && val.startsWith("-") && val !== "-") {
      if (val === "--recursive" || val === "--dereference-recursive" || val === "--directories" || val.startsWith("--directories=")) {
        hasRecursive = true;
      }
      if (
        val === "--extended-regexp" ||
        val === "--fixed-strings" ||
        val === "--basic-regexp" ||
        val === "--perl-regexp"
      ) {
        hasRegexMode = true;
      }
      if (val === "--regexp" || val.startsWith("--regexp=") || val === "--file" || val.startsWith("--file=")) {
        hasExplicitPattern = true;
        if (val.startsWith("--regexp=")) patterns.push(val.slice("--regexp=".length));
      }
      if (!val.startsWith("--")) {
        if (/[rR]/.test(val.slice(1))) hasRecursive = true;
        if (/[EFGP]/.test(val.slice(1))) hasRegexMode = true;
        if (/[ef]/.test(val.slice(1))) hasExplicitPattern = true;
        const lastCh = val[val.length - 1];
        if ((lastCh === "e" || lastCh === "f" || lastCh === "m" || lastCh === "A" || lastCh === "B" || lastCh === "C" || lastCh === "d" || lastCh === "D") && i + 1 < tokens.length) {
          if (lastCh === "e") patterns.push(tokens[i + 1].value);
          i++;
          continue;
        }
      } else if (GREP_VALUE_FLAGS.has(val) && i + 1 < tokens.length) {
        if (val === "--regexp") patterns.push(tokens[i + 1].value);
        i++;
      }
      continue;
    }
    positionals.push(tokens[i]);
  }

  if (!hasExplicitPattern && positionals.length > 0) {
    patterns.push(positionals[0].value);
  }
  if (patterns.length === 0) {
    return `${rtkPrefixWord}${restAfterRtk}`;
  }

  const pathPositionals = hasExplicitPattern ? positionals : positionals.slice(1);
  const needsExplicitDot = !inPipeline && pathPositionals.length === 0;
  let allExistingRegularFiles = false;
  if (!inPipeline && pathPositionals.length > 0) {
    allExistingRegularFiles = pathPositionals.every((p) => {
      try {
        return fs.statSync(resolveHookPath(p.value)).isFile();
      } catch {
        return false;
      }
    });
  }

  const injectFlags = [];
  if (!inPipeline && !hasRecursive && !allExistingRegularFiles) {
    injectFlags.push("-r");
  }
  if (!hasRegexMode) {
    if (os.platform() === "linux" && patterns.some(hasPcreOnlyPattern)) {
      injectFlags.push("-P");
    } else {
      injectFlags.push("-E");
    }
  }

  if (injectFlags.length === 0 && !needsExplicitDot) {
    return `${rtkPrefixWord}${restAfterRtk}`;
  }

  const flagPrefix = injectFlags.length > 0 ? `${injectFlags.join(" ")} ` : "";
  const dotSuffix = needsExplicitDot ? " ." : "";
  return `${rtkPrefixWord}grep ${flagPrefix}${afterGrepMatch[1]}${dotSuffix}`;
}

function unwrapShellWrapper(segText) {
  const m = segText.match(
    /^((?:cmd(?:\.exe)?\s+\/[cC]|(?:powershell|pwsh)(?:\.exe)?\s+(?:-Command|-c)|(?:bash|sh)\s+-c)\s+)(["'])([\s\S]*)\2$/i
  );
  if (!m) return null;
  return { prefix: m[1], quote: m[2], inner: m[3] };
}

function formatRtkPrefixForWrapperQuote(rtkPrefix, outerQuote, wrapperPrefix = "") {
  if (!rtkPrefix || !outerQuote) return rtkPrefix;
  const isCmd = /^cmd(?:\.exe)?\b/i.test(wrapperPrefix);
  const isPowerShell = /^(?:powershell|pwsh)(?:\.exe)?\b/i.test(wrapperPrefix);

  if (isCmd) {
    // cmd.exe does not treat single quotes as delimiters and breaks on nested double quotes inside `cmd /c "..."`.
    if (rtkPrefix.includes('"') || rtkPrefix.includes("'")) return null;
    return rtkPrefix;
  }

  if (isPowerShell) {
    if (outerQuote === '"') {
      if (/[$`]/.test(rtkPrefix)) return null;
      if (!rtkPrefix.includes('"')) return rtkPrefix;
      return rtkPrefix.replace(/"([^"\r\n]*)"/g, (_, inner) => `'${inner.replace(/'/g, "''")}'`);
    }
    if (outerQuote === "'") {
      return rtkPrefix.includes("'") ? rtkPrefix.replace(/'/g, "''") : rtkPrefix;
    }
    return rtkPrefix;
  }

  // POSIX shells (`bash -c`, `sh -c`)
  if (outerQuote === '"') {
    if (/[$`]/.test(rtkPrefix)) return null;
    if (!rtkPrefix.includes('"')) return rtkPrefix;
    if (!rtkPrefix.includes("'")) {
      return rtkPrefix.replace(/"/g, "'");
    }
    return rtkPrefix.replace(/"/g, '\\"');
  }
  if (outerQuote === "'") {
    return rtkPrefix.includes("'") ? rtkPrefix.replace(/'/g, "'\\''") : rtkPrefix;
  }
  return rtkPrefix;
}

function matchRtkInvocation(text) {
  const direct = text.match(/^((?:["']?[^\s"']*[/\\])?rtk(?:\.exe|\.cmd|\.bat)?["']?\s+)([\s\S]+)$/i);
  if (direct) return { rtkWord: direct[1], rest: direct[2], isLauncher: false };
  const launcher = text.match(/^(node(?:\.exe)?\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))\s+)([\s\S]+)$/i);
  if (launcher) {
    const scriptPath = launcher[2] || launcher[3] || launcher[4] || "";
    if (isTrustedLocalRtkLauncherPath(scriptPath)) {
      return { rtkWord: launcher[1], rest: launcher[5], isLauncher: true };
    }
  }
  return null;
}

function postProcessSegmentText(rawSegText, effSegText, { rgAvailable, inPipeline, rtkPrefix }) {
  const trimmedEff = effSegText.trim();
  const trimmedRaw = (rawSegText || "").trim();

  // Recursively handle shell wrappers (e.g., bash -c "rtk wc -l foo")
  const effWrap = unwrapShellWrapper(trimmedEff);
  if (effWrap) {
    const rawWrap = unwrapShellWrapper(trimmedRaw);
    const wrappedRtkPrefix = formatRtkPrefixForWrapperQuote(rtkPrefix, effWrap.quote, effWrap.prefix);
    if (wrappedRtkPrefix === null) {
      // Wrapper shell cannot safely quote a local-only spaced RTK prefix; keep original raw wrapper command intact.
      return trimmedRaw || trimmedEff;
    }
    const processedInner = postProcessCommand(
      rawWrap ? rawWrap.inner : effWrap.inner,
      effWrap.inner,
      { rgAvailable, rtkPrefix: wrappedRtkPrefix }
    );
    return `${effWrap.prefix}${effWrap.quote}${processedInner}${effWrap.quote}`;
  }

  const { prefix: effEnvPrefix, body: effBody } = splitEnvPrefix(trimmedEff);
  const { body: rawBody } = splitEnvPrefix(trimmedRaw);
  const effMatchTarget = effBody || trimmedEff;
  const rawMatchTarget = rawBody || trimmedRaw;

  const rtkMatch = matchRtkInvocation(effMatchTarget);
  if (!rtkMatch) {
    // When host `rg` is absent, also rewrite bare `rg` in pipelines or `bash -c` subshells to `grep`/`find`
    if (!rgAvailable && /^rg(?:\.exe)?(?=\s|$)/i.test(effMatchTarget)) {
      const mapped = rewriteRtkRgSegment("", effMatchTarget, { inPipeline });
      if (mapped !== effMatchTarget) {
        return `${effEnvPrefix}${mapped}`;
      }
    }
    return trimmedEff;
  }

  const rtkWord = rtkMatch.rtkWord;
  const rest = rtkMatch.rest;
  const subcmd = (rest.match(/^([^\s"']+)/)?.[1] || "").toLowerCase();

  // Revert lossy `rtk wc` / `rtk ls` / `rtk diff` / `rtk grep` back to raw unless caller explicitly typed it (ACS-HOOK-09, ACS-HOOK-GREP-CLAMP)
  if (subcmd === "wc" || subcmd === "ls" || subcmd === "diff" || subcmd === "grep") {
    const rawRtkMatch = matchRtkInvocation(rawMatchTarget);
    const rawSubcmd = rawRtkMatch ? (rawRtkMatch.rest.match(/^([^\s"']+)/)?.[1] || "").toLowerCase() : "";
    if (rawSubcmd !== subcmd) {
      return `${effEnvPrefix}${rest}`;
    }
  }

  // Never emit `rtk rg` when `rg` is absent on PATH
  if ((subcmd === "rg" || subcmd === "rg.exe") && !rgAvailable) {
    let mapped = rewriteRtkRgSegment(rtkWord, rest, { inPipeline });
    if (mapped !== rest && rtkPrefix && rtkPrefix !== "rtk" && /^rtk(?:\.exe|\.cmd|\.bat)?\s+/i.test(mapped)) {
      mapped = mapped.replace(/^rtk(?:\.exe|\.cmd|\.bat)?(?=\s)/i, () => rtkPrefix);
    }
    return `${effEnvPrefix}${mapped}`;
  }

  // Normalize `rtk grep` when host `rg` is absent so directories & `a|b` alternation work reliably
  if ((subcmd === "grep" || subcmd === "grep.exe") && !rgAvailable) {
    let mapped = rewriteRtkGrepSegment(rtkWord, rest, { inPipeline });
    if (rtkPrefix && rtkPrefix !== "rtk" && /^rtk(?:\.exe|\.cmd|\.bat)?\s+/i.test(mapped)) {
      mapped = mapped.replace(/^rtk(?:\.exe|\.cmd|\.bat)?(?=\s)/i, () => rtkPrefix);
    }
    return `${effEnvPrefix}${mapped}`;
  }

  // If RTK came from a local binary not on PATH, rewrite bare `rtk ` prefix (including explicit `rtk ...` commands) to explicit path
  if (rtkPrefix && rtkPrefix !== "rtk" && /^rtk(?:\.exe|\.cmd|\.bat)?\s+/i.test(effMatchTarget)) {
    return `${effEnvPrefix}${effMatchTarget.replace(/^rtk(?:\.exe|\.cmd|\.bat)?(?=\s)/i, () => rtkPrefix)}`;
  }

  return trimmedEff;
}

function postProcessCommand(rawCmd, effCmd, opts) {
  const rawSegs = splitShellSegments(rawCmd);
  const effSegs = splitShellSegments(effCmd);
  if (effSegs.length === 0) return effCmd;

  const sameCount = rawSegs.length === effSegs.length;
  let result = effCmd;

  // Splice from end to start so earlier offsets remain valid
  for (let i = effSegs.length - 1; i >= 0; i--) {
    const seg = effSegs[i];
    const rawSegText = sameCount ? rawSegs[i].text : rawCmd;
    const inPipeline = seg.leadingSep === "|" || seg.leadingSep === "|&";
    const replacement = postProcessSegmentText(rawSegText, seg.text, {
      ...opts,
      inPipeline
    });
    if (replacement !== seg.text) {
      result = result.slice(0, seg.start) + replacement + result.slice(seg.end);
    }
  }

  return result;
}

function delegateRewriteToRtk(rawCmd, rtk) {
  const opts = {
    input: JSON.stringify({
      toolCall: {
        name: "run_command",
        args: { CommandLine: rawCmd }
      }
    }),
    encoding: "utf-8",
    timeout: 2000,
    windowsHide: true
  };
  const res = spawnRtk(rtk.exe, ["hook", "antigravity"], opts);
  if (res.error || res.status !== 0 || !res.stdout) {
    return { decision: "allow", commandLine: rawCmd };
  }
  try {
    const parsed = JSON.parse(res.stdout.trim());
    if (parsed && (parsed.decision === "deny" || parsed.decision === "force_ask")) {
      return {
        decision: parsed.decision,
        reason: parsed.reason || "Denied by RTK hook."
      };
    }
    const rewritten = parsed?.overwrite?.CommandLine;
    return {
      decision: "allow",
      commandLine: typeof rewritten === "string" && rewritten.trim() ? rewritten : rawCmd
    };
  } catch {
    return { decision: "allow", commandLine: rawCmd };
  }
}

// ============================================================================
// Proportional Backoff & Strict Task-Polling Schedule Detection
// ============================================================================

/**
 * Calculates the required minimum cooldown interval (in seconds)
 * proportional to the number of diagnostic status inspections already performed.
 * Formula: Math.min(600, Math.round(30 * Math.pow(2.5, Math.max(0, pollCount - 1))))
 * Levels: Level 0 -> 0s (baseline), Level 1 -> 30s, Level 2 -> 75s, Level 3 -> 188s, Level 4 -> 469s, Level 5+ -> 600s
 * Keep identical to lib/transcript-core.mjs `getRequiredBackoffSeconds`.
 */
function getRequiredBackoffSeconds(pollCount) {
  if (pollCount <= 0) return 0;
  return Math.min(600, Math.round(30 * Math.pow(2.5, Math.max(0, pollCount - 1))));
}

/**
 * Proportional Backoff for direct `invoke_subagent` stall watchdogs bound via `TimerCondition`.
 * Formula: Math.min(600, Math.round(180 * Math.pow(2.5, Math.max(0, pollCount))))
 * Levels: Level 0 -> 180s, Level 1 -> 450s, Level 2+ -> 600s
 * Keep identical to lib/transcript-core.mjs `getRequiredSubagentBackoffSeconds`.
 */
function getRequiredSubagentBackoffSeconds(pollCount) {
  return Math.min(600, Math.round(180 * Math.pow(2.5, Math.max(0, pollCount))));
}

const BACKOFF_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanGovernanceArg(val) {
  return String(val || "").replace(/^["']|["']$/g, "").trim();
}

function normalizeTaskKeyFromId(taskId, taskToken = "") {
  const cleanTok = cleanGovernanceArg(taskToken).replace(/\\/g, "/");
  const baseMatch = cleanTok.match(/(?:^|\/)([^/]+)\.log$/i);
  if (baseMatch && baseMatch[1]) {
    return baseMatch[1].toLowerCase();
  }
  const clean = cleanGovernanceArg(taskId);
  if (!clean) return null;
  const taskMatch = clean.match(/(?:^|\/)(task-[a-z0-9_-]+)$/i);
  if (taskMatch) return taskMatch[1].toLowerCase();
  const tail = clean.includes("/") ? clean.slice(clean.lastIndexOf("/") + 1).trim() : clean;
  if (!tail) return null;
  return /^task-/i.test(tail) ? tail.toLowerCase() : `task-${tail.toLowerCase()}`;
}

/**
 * Extracts a normalized per-task (or per-subagent) backoff key for `manage_task` and `schedule`.
 * Returns `null` when no task or subagent identifier is present so callers fall back to flat `session.pollCount`.
 * Keep identical to lib/transcript-core.mjs `extractTaskBackoffKey`.
 */
function extractTaskBackoffKey(toolName, args = {}) {
  if (toolName === "manage_task") {
    const raw = cleanGovernanceArg(args.TaskId || args.taskId);
    if (!raw) return null;
    const taskMatch = raw.match(/(?:^|\/)(task-[a-z0-9_-]+)$/i);
    if (taskMatch) return taskMatch[1].toLowerCase();
    const tail = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1).trim() : raw;
    return tail ? tail.toLowerCase() : null;
  }

  if (toolName === "schedule") {
    const cond = cleanGovernanceArg(args.TimerCondition || args.timerCondition);
    const condLower = cond.toLowerCase();
    if (cond && condLower !== "any" && condLower !== "never" && !/\s/.test(cond)) {
      const taskMatch = cond.match(/(?:^|\/)(task-[a-z0-9_-]+)$/i);
      if (taskMatch) return taskMatch[1].toLowerCase();
      if (BACKOFF_UUID_RE.test(cond)) return condLower;
      const tail = cond.includes("/") ? cond.slice(cond.lastIndexOf("/") + 1).trim() : cond;
      if (tail) return tail.toLowerCase();
    }
    const prompt = cleanGovernanceArg(args.Prompt || args.prompt);
    const promptTask = prompt.match(/\b(task-\d+)\b/i);
    if (promptTask) return promptTask[1].toLowerCase();
    const promptUuid = prompt.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
    if (promptUuid) return promptUuid[1].toLowerCase();
  }

  return null;
}

/**
 * Returns true when a task `schedule` call binds a specific auto-cancelling `TimerCondition`
 * (neither omitted, `"any"`, nor `"never"`).
 * Keep identical to lib/transcript-core.mjs `hasValidTaskTimerCondition`.
 */
function hasValidTaskTimerCondition(args = {}) {
  const cond = cleanGovernanceArg(args.TimerCondition || args.timerCondition);
  const condLower = cond.toLowerCase();
  return Boolean(cond) && condLower !== "any" && condLower !== "never" && !/\s/.test(cond);
}

/**
 * Returns true when a direct `invoke_subagent` stall watchdog binds a specific subagent
 * conversation/sender ID via `TimerCondition` (not omitted, `"any"`, `"never"`, or a `task-*` target).
 * Keep identical to lib/transcript-core.mjs `hasValidSubagentTimerCondition`.
 */
function hasValidSubagentTimerCondition(args = {}) {
  const cond = cleanGovernanceArg(args.TimerCondition || args.timerCondition);
  const condLower = cond.toLowerCase();
  if (!cond || condLower === "any" || condLower === "never" || /\s/.test(cond)) return false;
  if (/(?:^|\/)task-[a-z0-9_-]+$/i.test(cond) || condLower.includes("task")) return false;
  return true;
}

/**
 * Strict task-polling detection for `schedule` tool calls.
 * Keep identical to lib/transcript-core.mjs `isTaskPollSchedule`.
 */
function isTaskPollSchedule(args = {}) {
  const prompt = cleanGovernanceArg(args.Prompt || args.prompt).toLowerCase();
  const cond = cleanGovernanceArg(args.TimerCondition || args.timerCondition).toLowerCase();
  return (
    cond.startsWith("task-") ||
    cond.includes("task") ||
    prompt.includes("check on") ||
    prompt.includes("check task") ||
    prompt.includes("background task") ||
    prompt.includes("still running") ||
    prompt.includes("test suite") ||
    ((prompt.includes("check") || prompt.includes("status") || prompt.includes("poll") || prompt.includes("monitor") || prompt.includes("wait")) &&
      (prompt.includes("task") || prompt.includes("process") || prompt.includes("job") || prompt.includes("test") || prompt.includes("command") || prompt.includes("suite")))
  );
}

/**
 * Detects one-shot `schedule` timers used to poll a `/swarm`, squad, or board instead of
 * relying on `swarm_wait` + `swarm_monitor`.
 * Exempts the dedicated `swarm_monitor` daemon cron (`CronExpression` + `IsDaemon: true`).
 * Keep identical to lib/transcript-core.mjs `isSwarmPollSchedule`.
 */
function isSwarmPollSchedule(args = {}) {
  const isDaemon = args.IsDaemon === true || args.isDaemon === true;
  const cron = String(args.CronExpression || args.cronExpression || "").trim();
  if (isDaemon && cron) return false;

  const prompt = cleanGovernanceArg(args.Prompt || args.prompt).toLowerCase();
  const cond = cleanGovernanceArg(args.TimerCondition || args.timerCondition).toLowerCase();
  return (
    /\b(?:swarm|squad|board)\b/i.test(prompt) ||
    (cond === "any" &&
      !/\b(?:subagent|subagents)\b/i.test(prompt) &&
      /\b(?:check|status|poll|monitor|wait|worker|lead|auditor)\b/i.test(prompt))
  );
}

/**
 * Detects one-shot `schedule` timers targeting a direct `invoke_subagent` (separated from `/swarm`
 * bans so specific `TimerCondition="<subagentConvId>"` stall watchdogs can use the `180s -> 450s -> 600s`
 * safety floor while `< 30s` and unconditioned subagent polling remain denied).
 * Keep identical to lib/transcript-core.mjs `isSubagentPollSchedule`.
 */
function isSubagentPollSchedule(args = {}) {
  const isDaemon = args.IsDaemon === true || args.isDaemon === true;
  const cron = String(args.CronExpression || args.cronExpression || "").trim();
  if (isDaemon && cron) return false;
  if (isSwarmPollSchedule(args)) return false;

  const prompt = cleanGovernanceArg(args.Prompt || args.prompt).toLowerCase();
  const cond = cleanGovernanceArg(args.TimerCondition || args.timerCondition).toLowerCase();
  if (/(?:^|\/)task-[a-z0-9_-]+$/i.test(cond) || cond.includes("task")) return false;
  return /\b(?:subagent|subagents)\b/i.test(prompt) || BACKOFF_UUID_RE.test(cond);
}

/**
 * Prunes expired, completed (`getTaskState() === "COMPLETED"`), and excess per-task backoff buckets.
 */
function pruneTaskBackoff(session, convId, now = Date.now()) {
  if (!session.taskBackoff || typeof session.taskBackoff !== "object" || Array.isArray(session.taskBackoff)) {
    session.taskBackoff = {};
    return;
  }
  const kept = [];
  for (const [key, entry] of Object.entries(session.taskBackoff)) {
    if (!entry || typeof entry !== "object") continue;
    const activityTs = Math.max(entry.lastPollTime || 0, entry.lastSeenTime || 0);
    if (activityTs > 0 && (now - activityTs) >= STATE_TTL_MS) continue;
    if (convId && convId !== "global" && !BACKOFF_UUID_RE.test(key)) {
      try {
        const strippedId = key.replace(/^task-/i, "");
        const state = getTaskState({ id: strippedId, token: `tasks/${key}.log` }, convId);
        if (state === "COMPLETED") continue;
      } catch {}
    }
    kept.push([key, entry]);
  }
  kept.sort(
    (a, b) =>
      Math.max(b[1].lastPollTime || 0, b[1].lastSeenTime || 0) -
      Math.max(a[1].lastPollTime || 0, a[1].lastSeenTime || 0)
  );
  session.taskBackoff = Object.fromEntries(kept.slice(0, MAX_TASK_BACKOFF_ENTRIES));
}

function getOrCreateTaskBucket(session, key, now = Date.now()) {
  if (!session.taskBackoff || typeof session.taskBackoff !== "object" || Array.isArray(session.taskBackoff)) {
    session.taskBackoff = {};
  }
  if (!session.taskBackoff[key] || typeof session.taskBackoff[key] !== "object") {
    session.taskBackoff[key] = { pollCount: 0, lastPollTime: 0, denials: 0, lastSeenTime: now };
  }
  return session.taskBackoff[key];
}

/**
 * Denies reading the log of an actively RUNNING task: records the denial, trips the circuit
 * breaker at 5 cumulative denials, otherwise answers with the Proportional Backoff message.
 */
function denyRunningTask(taskId, convId, taskToken = "") {
  const session = getSessionState(convId);
  const now = Date.now();
  pruneTaskBackoff(session, convId, now);
  const taskKey = normalizeTaskKeyFromId(taskId, taskToken);
  const bucket = taskKey ? getOrCreateTaskBucket(session, taskKey, now) : null;
  if (bucket) {
    bucket.denials++;
    bucket.lastSeenTime = now;
  }
  session.denials++;
  saveSessionState(convId, session, { updatePollTime: false });

  const effectiveDenials = bucket ? Math.max(bucket.denials, session.denials) : session.denials;
  if (effectiveDenials >= 5) {
    respond({
      decision: "force_ask",
      reason: `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: reading task log '${taskId}' attempted prematurely ${effectiveDenials} times during active backoff window. User confirmation required to proceed.`
    });
  }

  const currentPollCount = bucket ? bucket.pollCount : session.pollCount;
  const currentLastPoll = bucket ? bucket.lastPollTime : session.lastPollTime;
  const requiredBackoffSec = Math.max(30, getRequiredBackoffSeconds(currentPollCount));
  const requiredBackoffMs = requiredBackoffSec * 1000;
  const elapsedMs = currentLastPoll ? Math.max(0, now - currentLastPoll) : 0;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const remainingSec = Math.max(1, Math.ceil((requiredBackoffMs - elapsedMs) / 1000));
  const condTarget = taskKey || `task-${taskId}`;
  const condExample = convId && convId !== "global" ? `${convId}/${condTarget}` : condTarget;

  respond({
    decision: "deny",
    reason: `Antigravity Execution Governance: Task '${taskId}' is actively RUNNING. Reading task logs in .system_generated during execution is strictly prohibited to prevent polling loops. Diagnostic check #${currentPollCount + 1} requires at least ${requiredBackoffSec}s elapsed (${elapsedSec}s elapsed, ${remainingSec}s remaining). Keep a conditioned watchdog armed via schedule(DurationSeconds=${requiredBackoffSec}, TimerCondition="${condExample}") so Reactive Wakeup (<SYSTEM_MESSAGE>) notifies you on completion or stall (manage_task(Action='kill') is always allowed immediately at 0s if hung).`
  });
}

// ============================================================================
// Denial Helpers & File Metrics
// ============================================================================

function buildInternalStateShellDenial(convId = "global") {
  const accessEval = evaluateCallerTranscriptAccess(convId);
  if (!accessEval.allowed) {
    return (
      "Antigravity Execution Governance: Direct shell access to internal Antigravity execution state (.system_generated and governance state) is strictly prohibited.\n" +
      "- Transcript inspection ('agy-context transcript' and '.system_generated/logs/') is DISABLED for this session by parent governance (Parent Transcript Isolation). Do NOT retry transcript commands or alternative file/shell reads; proceed using only your assigned workspace files and task brief.\n" +
      "- To inspect background tasks: Yield execution turn and rely on native Reactive Wakeup (<SYSTEM_MESSAGE>). Do not read internal task logs."
    );
  }
  if (accessEval.mode === "self-only") {
    return (
      "Antigravity Execution Governance: Direct shell access to internal Antigravity execution state (.system_generated and governance state) is strictly prohibited.\n" +
      `- Cross-session transcript inspection is DISABLED for this session (mode: self-only). You may only inspect your own transcript via 'agy-context transcript read --id ${convId} --mode compact' via run_command.\n` +
      "- To inspect background tasks: Yield execution turn and rely on native Reactive Wakeup (<SYSTEM_MESSAGE>). Do not read internal task logs."
    );
  }
  return (
    "Antigravity Execution Governance: Direct shell access to internal Antigravity execution state (.system_generated) is strictly prohibited to prevent transcript bloat and polling loops.\n" +
    "- To inspect conversation transcripts: Run 'agy-context transcript read --id <uuid> --mode compact' or 'agy-context transcript query --id <uuid> --query \"<pattern>\" --summary' via run_command.\n" +
    "- To inspect background tasks: Yield execution turn and rely on native Reactive Wakeup (<SYSTEM_MESSAGE>). Do not read internal task logs."
  );
}

function buildInternalStateToolDenial(convId = "global") {
  const accessEval = evaluateCallerTranscriptAccess(convId);
  if (!accessEval.allowed) {
    return (
      "Antigravity Execution Governance: Direct access to internal Antigravity execution state (.system_generated and governance state) is strictly prohibited.\n" +
      "- Transcript inspection ('agy-context transcript' and '.system_generated/logs/') is DISABLED for this session by parent governance (Parent Transcript Isolation). Do NOT retry transcript commands or alternative file/shell reads; proceed using only your assigned workspace files and task brief.\n" +
      "- To inspect background tasks: Yield execution turn and rely on native Reactive Wakeup (<SYSTEM_MESSAGE>). Do not read internal task logs."
    );
  }
  if (accessEval.mode === "self-only") {
    return (
      "Antigravity Execution Governance: Direct access to internal Antigravity execution state (.system_generated and governance state) is strictly prohibited.\n" +
      `- Cross-session transcript inspection is DISABLED for this session (mode: self-only). You may only inspect your own transcript via 'agy-context transcript read --id ${convId} --mode compact' via run_command.\n` +
      "- To inspect background tasks: Yield execution turn and rely on native Reactive Wakeup (<SYSTEM_MESSAGE>). Do not read internal task logs."
    );
  }
  return (
    "Antigravity Execution Governance: Direct access to internal Antigravity execution state (.system_generated) is strictly prohibited to prevent transcript bloat and polling loops.\n" +
    "- To inspect conversation transcripts: Run 'agy-context transcript read --id <uuid> --mode compact' or 'agy-context transcript query --id <uuid> --query \"<pattern>\" --summary' via run_command.\n" +
    "- To inspect background tasks: Yield execution turn and rely on native Reactive Wakeup (<SYSTEM_MESSAGE>). Do not read internal task logs."
  );
}

function isProtectedGovernanceFileMutation(targetPath, convId = "global") {
  if (!targetPath || typeof targetPath !== "string") return false;
  const norm = targetPath.replace(/\\/g, "/");
  // Installed hook, plugin, & hooks.json in ~/.gemini/config are always protected from direct agent edit/rm
  if (
    /\/\.gemini\/(?:config|antigravity)\/hooks\.json(?:\.bak)?$/i.test(norm) ||
    /\/\.gemini\/config\/scripts\/execution-guard-hook\.mjs$/i.test(norm) ||
    /\/\.gemini\/config\/plugins\/agy-context-saver(?:$|[\/\\])/i.test(norm) ||
    /\/\.gemini\/antigravity\/bin\/agy-context(?:-saver)?(?:\.(?:cmd|exe|bat))?$/i.test(norm)
  ) {
    return true;
  }
  // When caller is a restricted child session, also block mutating repo governance source files
  const accessEval = evaluateCallerTranscriptAccess(convId);
  if (accessEval.isRestrictedChild) {
    if (
      /(?:^|[\/\\])(?:execution-guard-hook\.mjs|transcript-core\.mjs|agy-context\.mjs|state-dir\.mjs|install-register\.mjs|hooks\.json)$/i.test(
        norm
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasGovernanceMutationInText(text, convId = "global") {
  if (!text || typeof text !== "string") return false;
  const norm = text.replace(/\\/g, "/");
  const hasShellMutationVerb =
    /(?:^|[\s;|&(`'"])(?:rm|del|remove-item|mv|cp|tee|truncate|shred|install|sed|perl|chmod|chown|ln|dd|patch)(?=$|[\s;|&)`'"])/i.test(
      norm
    );
  const hasCodeMutationVerb =
    /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rmSync|rmdir|rmdirSync|rename|renameSync|truncateSync|chmodSync|copyFile|copyFileSync|WriteAllText)\s*\(|\bos\.(?:remove|unlink)\s*\(|\bshutil\.(?:copy|move|rmtree)\s*\(|\bPath\([^\n)]*\)\.(?:write_text|write_bytes|unlink)\s*\(/i.test(
      norm
    );
  const hasMutationVerb = hasShellMutationVerb || hasCodeMutationVerb;
  let hasGovernanceRedirect = false;
  if (norm.includes(">")) {
    for (const seg of splitShellSegments(text)) {
      const redirs = extractRedirectTargets(tokenizeShellWordsDetailed(seg.text || ""));
      if (redirs.some((tok) => isProtectedGovernanceFileMutation(tok, convId))) {
        hasGovernanceRedirect = true;
        break;
      }
    }
  }
  if (!hasMutationVerb && !hasGovernanceRedirect) return false;
  if (hasGovernanceRedirect) return true;

  if (
    /\/\.gemini\/(?:config|antigravity)\/hooks\.json(?:\.bak)?\b/i.test(norm) ||
    /\/\.gemini\/config\/scripts\/execution-guard-hook\.mjs\b/i.test(norm) ||
    /\/\.gemini\/config\/plugins\/agy-context-saver(?:$|[\/\\\s'"])/i.test(norm) ||
    /\/\.gemini\/antigravity\/bin\/agy-context(?:-saver)?(?:\.(?:cmd|exe|bat))?\b/i.test(norm)
  ) {
    return true;
  }

  if (evaluateCallerTranscriptAccess(convId).isRestrictedChild) {
    if (
      /\b(?:execution-guard-hook\.mjs|transcript-core\.mjs|agy-context\.mjs|state-dir\.mjs|install-register\.mjs|hooks\.json)\b/i.test(
        norm
      )
    ) {
      return true;
    }
  }
  return false;
}

function isExecutableScriptPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  return /\.(?:m?js|cjs|ts|mts|cts|py|sh|bash|zsh|pl|rb|php|ps1|cmd|bat)$/i.test(targetPath.trim());
}

function escapeDoubleQuotedArg(str) {
  return String(str).replace(/["\\$`]/g, "\\$&");
}

function getFileMetrics(filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  try {
    const resolvedPath = resolveHookPath(filePath);
    if (!resolvedPath || !fs.existsSync(resolvedPath)) return null;
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) return null;
    const bytes = stat.size;
    const content = fs.readFileSync(resolvedPath, "utf-8");
    if (content.length === 0) {
      return { bytes: 0, lineCount: 0, rawSplitCount: 1 };
    }
    const rawSplitCount = content.split(/\r?\n/).length;
    const lineCount = /\r?\n$/.test(content) ? Math.max(1, rawSplitCount - 1) : rawSplitCount;
    return { bytes, lineCount, rawSplitCount };
  } catch {
    return null;
  }
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

  // Only pre-classify as governed before JSON.parse when the tool name field itself matches a governed tool
  isGovernedTool = /"(?:name|tool_name)"\s*:\s*"(?:run_command|read_file|view_file|read_many_files|grep_search|find_by_name|list_dir|manage_task|schedule|replace_file_content|write_to_file|write_file|edit_file)"/i.test(
    inputRaw
  );
  const payload = JSON.parse(inputRaw);
  const hookCwdRaw = payload.cwd || payload.workspacePath || "";
  activeHookCwd = hookCwdRaw && typeof hookCwdRaw === "string" ? hookCwdRaw.trim() : "";
  activeTranscriptPath = typeof payload.transcriptPath === "string" ? payload.transcriptPath.trim() : "";
  const toolCall = payload.toolCall || payload.tool_call || {};
  const toolName = String(toolCall.name || toolCall.tool_name || "").trim().toLowerCase();
  const args = toolCall.args || toolCall.arguments || {};
  const convId = payload.conversationId || "global";

  if (!GOVERNED_TOOLS.has(toolName)) {
    respond({ decision: "allow" });
  }

  isGovernedTool = true;

  // Dual-hook idempotency deduplication when payload.conversationId is present (coordinator plugin + global hooks.json)
  if (payload.conversationId) {
    const callId = String(toolCall.id || payload.toolUseId || payload.tool_use_id || "").trim();
    const stepIdx = payload.stepIdx !== undefined ? payload.stepIdx : payload.step_index;
    const inSig = JSON.stringify(args || {});
    let currentScriptPath = "";
    try {
      currentScriptPath = tryRealpath(fileURLToPath(import.meta.url));
    } catch {}
    const now = Date.now();
    const prevState = getSessionState(convId);
    const recent = Array.isArray(prevState.recentHookCalls) ? prevState.recentHookCalls : [];
    const matchedCall = recent.find((e) => {
      if (!e || typeof e.ts !== "number" || (now - e.ts) >= HOOK_DEDUP_TTL_MS) return false;
      if (callId && e.callId && e.callId === callId) return true;
      const argMatch = inSig === e.rawSig || inSig === e.outSig;
      if (!argMatch || e.toolName !== toolName) return false;
      if (stepIdx !== undefined && stepIdx !== null && e.stepIdx === stepIdx) return true;
      if (currentScriptPath && e.scriptPath && e.scriptPath !== currentScriptPath && (now - e.ts) < HOOK_SAME_ARG_CROSS_SCRIPT_MS) {
        return true;
      }
      return false;
    });
    if (matchedCall && matchedCall.response) {
      const replay =
        inSig === matchedCall.outSig &&
        matchedCall.rawSig !== matchedCall.outSig &&
        matchedCall.response.decision === "allow"
          ? { decision: "allow" }
          : matchedCall.response;
      respond(replay);
    }
    dedupRecordCtx = {
      convId,
      callId,
      stepIdx: stepIdx !== undefined ? stepIdx : null,
      toolName,
      scriptPath: currentScriptPath,
      rawSig: inSig
    };
  }

  // =========================================================================
  // 1. run_command: Raw Safety Gates + `rtk hook antigravity` Delegation
  // =========================================================================
  if (toolName === "run_command") {
    const rawCmd = args.CommandLine !== undefined ? args.CommandLine : args.command;
    if (typeof rawCmd !== "string" || !rawCmd.trim()) {
      respond({
        decision: "deny",
        reason: "Antigravity Governance: Missing or empty CommandLine in run_command."
      });
    }

    const segments = splitShellSegments(rawCmd);

    // LH-09-B: Shell command mutation of protected benchmark & governance artifacts
    const SHELL_MUTATION_VERBS = new Set([
      "rm",
      "del",
      "remove-item",
      "mv",
      "cp",
      "tee",
      "truncate",
      "shred",
      "install",
      "sed",
      "perl",
      "chmod",
      "chown",
      "ln",
      "dd",
      "patch"
    ]);
    const extractSedWriteTargets = (expr) => {
      if (!expr || typeof expr !== "string") return [];
      const found = [];
      // 1. Substitution commands with `w <file>` flag: `s/pat/rep/w file`
      const substWriteRe = /s([^\s\\])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[a-zA-Z0-9]*w\s+([^\s;'"]+)/g;
      let sm;
      while ((sm = substWriteRe.exec(expr)) !== null) {
        if (sm[2]) found.push(sm[2]);
      }
      // 2. Strip `s`/`y` bodies so words like `new foo` inside patterns never false-match, then find standalone `w <file>`
      const stripped = expr
        .replace(/[sy]([^\s\\])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[a-zA-Z0-9]*/g, "")
        .replace(/\/(?:\\.|[^/])*\//g, "/");
      const cmdWriteRe = /(?:^|[;\n}\d$/!,])\s*w\s+([^\s;'"]+)/g;
      let cm;
      while ((cm = cmdWriteRe.exec(stripped)) !== null) {
        if (cm[1]) found.push(cm[1]);
      }
      return found;
    };

    const extractInlineScriptPathCandidates = (script) => {
      if (!script || typeof script !== "string") return [];
      const out = [];
      const pushClean = (raw) => {
        const trimmed = String(raw || "").trim();
        if (!trimmed) return;
        out.push(trimmed);
        // Strip Perl/shell open mode prefixes (`>`, `>>`, `+>`, `+<`, `<`)
        const strippedMode = trimmed.replace(/^(?:\+?[<>]|>>)\s*/, "");
        if (strippedMode && strippedMode !== trimmed) out.push(strippedMode);
      };
      const quotedRe = /"([^"\r\n]+)"|'([^'\r\n]+)'/g;
      let qm;
      while ((qm = quotedRe.exec(script)) !== null) {
        pushClean(qm[1] ?? qm[2]);
      }
      for (const piece of script.split(/[\s'"(),;]+/)) {
        if (piece && (piece.includes("/") || piece.includes("\\") || piece.includes("."))) {
          pushClean(piece);
        }
      }
      return out;
    };

    const getShellMutationArgCandidates = (verb, detailedTokens, cmdIdx) => {
      const argTokens = detailedTokens.slice(cmdIdx + 1);
      const rawValues = argTokens.map((t) => t.value).filter((v) => !v.includes("\n"));

      if (verb === "sed") {
        let hasInPlace = false;
        let hasExplicitScript = false;
        let afterDoubleDash = false;
        const expressions = [];
        const positionals = [];
        for (let i = 0; i < argTokens.length; i++) {
          const tok = argTokens[i];
          if (!tok.quoted && REDIRECT_OP_REGEX.test(tok.raw)) {
            i++;
            continue;
          }
          if (!tok.quoted && REDIRECT_ATTACHED_REGEX.test(tok.raw)) {
            continue;
          }
          const v = tok.value;
          if (!afterDoubleDash && v === "--") {
            afterDoubleDash = true;
            continue;
          }
          if (!afterDoubleDash && v.startsWith("-") && v !== "-") {
            if (v === "-e" || v === "--expression") {
              hasExplicitScript = true;
              if (argTokens[i + 1]) expressions.push(argTokens[++i].value);
              continue;
            }
            if (v.startsWith("--expression=")) {
              hasExplicitScript = true;
              expressions.push(v.slice("--expression=".length));
              continue;
            }
            if (!v.startsWith("--") && /^-([nrEsuz]*)e(.+)$/.test(v)) {
              hasExplicitScript = true;
              expressions.push(v.slice(v.indexOf("e") + 1));
              continue;
            }
            if (v === "-f" || v === "--file" || v.startsWith("--file=")) {
              hasExplicitScript = true;
              if ((v === "-f" || v === "--file") && i + 1 < argTokens.length) i++;
              continue;
            }
            if (v === "-i" || v.startsWith("-i") || v === "--in-place" || v.startsWith("--in-place=") || /^-[nrEsuz]+i/i.test(v)) {
              hasInPlace = true;
              continue;
            }
            continue;
          }
          positionals.push(v);
        }
        if (hasInPlace) return rawValues;
        if (!hasExplicitScript && positionals.length > 0) {
          expressions.push(positionals[0]);
        }
        const writeTargets = expressions.flatMap(extractSedWriteTargets);
        return writeTargets;
      }

      if (verb === "perl") {
        let hasInPlace = false;
        let hasInlineWrite = false;
        let afterDoubleDash = false;
        const inlineScripts = [];
        const perlWriteRe =
          /\b(?:unlink|rename|truncate|sysopen|spew|write_file|write_text|write_bytes|copy|move)\b|\bopen(?:\s*\(|\s+)[^;\n]*(?:['"]\s*(?:\+?<|>>?|>)|\bO_(?:WRONLY|RDWR|CREAT)\b)/i;
        for (let i = 0; i < argTokens.length; i++) {
          const v = argTokens[i].value;
          if (!afterDoubleDash && v === "--") {
            afterDoubleDash = true;
            break;
          }
          if (v === "-e" || v === "-E" || /^-[pna0-9lwWCTS]+[eE]$/.test(v)) {
            const script = argTokens[i + 1]?.value || "";
            inlineScripts.push(script);
            if (perlWriteRe.test(script)) {
              hasInlineWrite = true;
            }
            i++;
            continue;
          }
          if (/^-[pna0-9lwWCTS]*[eE](.+)$/s.test(v) && !v.startsWith("--")) {
            const eMatch = v.match(/^-[pna0-9lwWCTS]*[eE](.+)$/s);
            const script = eMatch ? eMatch[1] : "";
            inlineScripts.push(script);
            if (perlWriteRe.test(script)) {
              hasInlineWrite = true;
            }
            continue;
          }
          if (v === "-i" || v.startsWith("-i") || /^-[pna0-9lwWCTS]+i/.test(v)) {
            hasInPlace = true;
            break;
          }
        }
        if (hasInPlace) return rawValues;
        if (hasInlineWrite) {
          return [...rawValues, ...inlineScripts.flatMap(extractInlineScriptPathCandidates)];
        }
        return [];
      }

      if (verb === "cp") {
        // Only flags that genuinely consume a separate next-token value (never GNU optional `=VALUE` flags like `--backup`/`--preserve`/`--reflink`/`--update`/`--context`)
        const cpValueFlags = new Set(["-S", "--suffix", "--no-preserve", "--sparse"]);
        const targetDirs = [];
        const positionals = [];
        let afterDoubleDash = false;
        for (let i = 0; i < argTokens.length; i++) {
          const tok = argTokens[i];
          if (!tok.quoted && REDIRECT_OP_REGEX.test(tok.raw)) {
            i++;
            continue;
          }
          if (!tok.quoted && REDIRECT_ATTACHED_REGEX.test(tok.raw)) {
            continue;
          }
          const v = tok.value;
          if (!afterDoubleDash && v === "--") {
            afterDoubleDash = true;
            continue;
          }
          if (!afterDoubleDash && v.startsWith("-") && v !== "-") {
            if (v === "-t" || v === "--target-directory" || (!v.startsWith("--") && /^-[^-]*t$/.test(v))) {
              if (argTokens[i + 1]) targetDirs.push(argTokens[++i].value);
              continue;
            }
            if (v.startsWith("--target-directory=")) {
              targetDirs.push(v.slice("--target-directory=".length));
              continue;
            }
            if (/^-[^-]*t(.+)$/.test(v) && !v.startsWith("--")) {
              targetDirs.push(v.slice(v.indexOf("t") + 1));
              continue;
            }
            if ((cpValueFlags.has(v) || (!v.startsWith("--") && /^-[^-]*S$/.test(v))) && i + 1 < argTokens.length) {
              i++;
            }
            continue;
          }
          if (!v.includes("\n")) positionals.push(v);
        }
        const expandDirTarget = (dest) => (dest.endsWith("/") || dest.endsWith("\\") ? [dest] : [dest, `${dest}/`]);
        if (targetDirs.length > 0) return targetDirs.filter((v) => !v.includes("\n")).flatMap(expandDirTarget);
        return positionals.length >= 2 ? expandDirTarget(positionals[positionals.length - 1]) : [];
      }

      return rawValues;
    };
    for (const seg of segments) {
      const segTexts = [seg.text, ...(seg.subshells || [])];
      for (const st of segTexts) {
        const detailed = tokenizeShellWordsDetailed(st);
        if (detailed.length === 0) continue;
        let cmdIdx = 0;
        while (
          cmdIdx < detailed.length &&
          (/^[A-Za-z_][A-Za-z0-9_]*=/.test(detailed[cmdIdx].value) ||
            detailed[cmdIdx].value === "env" ||
            detailed[cmdIdx].value === "sudo")
        ) {
          cmdIdx++;
        }
        const verb = cmdIdx < detailed.length ? normalizeCmdName(detailed[cmdIdx].value) : "";
        const isMutatingVerb = SHELL_MUTATION_VERBS.has(verb);
        if (seg.hasWriteRedirect || isMutatingVerb) {
          const redirectTargets = extractRedirectTargets(detailed);
          const argCandidates = isMutatingVerb
            ? getShellMutationArgCandidates(verb, detailed, cmdIdx)
            : [];
          const candidateTokens = [...redirectTargets, ...argCandidates];
          if (candidateTokens.some((tok) => isProtectedGovernanceFileMutation(tok, convId))) {
            respond({
              decision: "deny",
              reason:
                "Antigravity Execution Governance: Shell mutation of protected Antigravity hook, shim, or governance source files is strictly prohibited."
            });
          }
          if (!isBenchmarkGuardDisabled(convId) && candidateTokens.some((tok) => isProtectedBenchmarkPath(tok))) {
            respond({
              decision: "force_ask",
              reason:
                "[BENCHMARK MUTATION DETECTED] Shell command mutation of protected evaluator/benchmark artifact requires explicit user confirmation to prevent benchmark contamination. Set AGY_DISABLE_BENCHMARK_GUARD=1 to disable this guard for non-evaluation repos."
            });
          }
        }
      }
    }

    const blockingWatch = findBlockingWatchLoop(segments);
    if (blockingWatch) {
      respond({
        decision: "deny",
        reason:
          `Antigravity Execution Governance: Blocking CI watch loop ('${blockingWatch.command}') stalls agents indefinitely when remote runners queue.\n` +
          "- Run a single non-blocking snapshot ('gh pr checks' or 'gh run list') instead.\n" +
          "- If waiting on remote CI, end your turn or use a backoff-compliant 'schedule' timer (DurationSeconds >= Math.max(30, requiredBackoffSec): >= 30s initially, then 75s/188s/469s/600s) rather than blocking inside run_command."
      });
    }

    // Check agy-context transcript CLI exemption & parent-scoped access governance
    const agyTranscriptCheck = checkAgyContextTranscriptCommand(segments, convId);
    if (agyTranscriptCheck.matched && !agyTranscriptCheck.allowed) {
      if (agyTranscriptCheck.isAccessDenial) {
        const session = getSessionState(convId);
        session.transcriptDenials = (session.transcriptDenials || 0) + 1;
        saveSessionState(convId, session, { updatePollTime: false });
        if (session.transcriptDenials >= 5) {
          respond({
            decision: "force_ask",
            reason: `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: restricted session '${convId}' attempted forbidden 'agy-context transcript' access ${session.transcriptDenials} times. ${agyTranscriptCheck.reason}`
          });
        }
      }
      respond({
        decision: "deny",
        reason: agyTranscriptCheck.reason
      });
    }

    // Raw-command internal state checks (skipping heredoc bodies, echo/printf text, and grep patterns)
    let isSpillover = false;
    let spilloverTok = null;
    let taskMatch = null;
    let taskState = null;
    const pendingWrittenSet = collectSegmentWrittenTargets(segments);
    if (!agyTranscriptCheck.allowed) {
      const callerAccess = evaluateCallerTranscriptAccess(convId);
      const inspectableTexts = collectInspectableTexts(segments, 0, {
        isRestrictedChild: callerAccess.isRestrictedChild,
        convId,
        pendingWrittenSet
      });
      const inspectableCombined = inspectableTexts.join("\n");
      const singleTokens = segments.length === 1 ? tokenizeShellWords(segments[0].text) : [];
      const spilloverTokens = findStepSpilloverTokens(singleTokens);
      spilloverTok = spilloverTokens[0] || null;
      isSpillover = spilloverTokens.length > 0;
      const taskMatches = extractTaskLogMatches(inspectableCombined, convId);
      taskMatch = taskMatches[0] || null;

      // Block unwrapped shell/interpreter mutations of governance/hook files
      if (hasGovernanceMutationInText(inspectableCombined, convId)) {
        respond({
          decision: "deny",
          reason:
            "Antigravity Execution Governance: Shell mutation of protected Antigravity hook, shim, or governance source files is strictly prohibited."
        });
      }

      // Block restricted child sessions from running setup/install/uninstall/restore-backups lifecycle commands
      if (callerAccess.isRestrictedChild && isRestrictedLifecycleInvocation(segments)) {
        respond({
          decision: "deny",
          reason:
            "Antigravity Execution Governance: Restricted child sessions cannot execute plugin lifecycle setup or uninstall commands."
        });
      }

      // If spillover or task log is chained, redirected, uses heredocs, subshells, or `..` traversal -> DENY
      if ((isSpillover || taskMatch) && !isSingleUnchainedShellCmd(segments)) {
        const hasRtkForSpillover = Boolean(resolveCachedHostEnv().rtk);
        respond({
          decision: "deny",
          reason: isSpillover
            ? hasRtkForSpillover
              ? "Antigravity Execution Governance: Runtime step output spillover files must be inspected using a single unchained 'rtk read <path>' command (no chaining, redirects, subshells, or '..' traversal)."
              : "Antigravity Execution Governance: Runtime step output spillover files must be inspected using a single unchained 'head -n 150 <path>' or 'tail -n 150 <path>' command (or bounded 'read_file' <= 150 lines; no chaining, redirects, subshells, or '..' traversal)."
            : buildInternalStateShellDenial(convId)
        });
      }

      // Check 2: Task Log Inspection (Lifecycle-Gated across ALL matched logs): RUNNING => Proportional Backoff
      if (taskMatches.length > 0) {
        const taskStates = taskMatches.map((m) => ({ match: m, state: getTaskState(m, convId) }));
        const runningEntry = taskStates.find((entry) => entry.state === "RUNNING");
        if (runningEntry) {
          denyRunningTask(runningEntry.match.id, convId, runningEntry.match.token);
        }
        taskState = taskStates.some((entry) => entry.state === "UNKNOWN") ? "UNKNOWN" : "COMPLETED";
      }

      // Check 1: Other protected internal state (strip at most one non-mixed spillover/task token from single-segment tokens so quoted pairs & piggybacked paths never bypass Check 1)
      let inspectRemainder = inspectableCombined;
      if ((isSpillover || taskMatch) && inspectableTexts.length === 1 && segments.length === 1) {
        const singleAllowedTok =
          isSpillover && !taskMatch && spilloverTokens.length === 1
            ? spilloverTokens[0]
            : (!isSpillover && taskMatches.length === 1 ? taskMatches[0].token : "");
        if (singleAllowedTok) {
          const normTarget = cleanFileToken(singleAllowedTok).replace(/\\/g, "/");
          let removed = false;
          const remainingTokens = singleTokens.filter((tok) => {
            if (!removed && cleanFileToken(tok).replace(/\\/g, "/") === normTarget) {
              removed = true;
              return false;
            }
            return true;
          });
          if (removed) {
            inspectRemainder = remainingTokens.join(" ");
          }
        }
      }
      if (isProtectedShellOrScriptOperation(inspectRemainder, { isRestrictedChild: callerAccess.isRestrictedChild })) {
        respond({
          decision: "deny",
          reason: buildInternalStateShellDenial(convId)
        });
      }
    }

    if (agyTranscriptCheck.allowed && (agyTranscriptCheck.needsReadGrant || agyTranscriptCheck.isAccessMutation)) {
      recordTranscriptHookGrant({
        callerConvId: convId,
        subcommand: agyTranscriptCheck.subcommand,
        targetConvId: agyTranscriptCheck.targetConvId || null,
        mode: agyTranscriptCheck.mode || "open",
        isMutation: Boolean(agyTranscriptCheck.isAccessMutation)
      });
    }

    // Delegate command rewriting to `rtk hook antigravity` (>= 1.1.0)
    const { rtk, rgAvailable } = resolveCachedHostEnv();
    let effectiveCmd = rawCmd;

    if (rtk) {
      const delegated = delegateRewriteToRtk(rawCmd, rtk);
      if (delegated.decision !== "allow") {
        respond({ decision: delegated.decision, reason: delegated.reason });
      }
      effectiveCmd = postProcessCommand(rawCmd, delegated.commandLine, {
        rgAvailable,
        rtkPrefix: rtk.prefix
      });
    } else if (!rgAvailable) {
      effectiveCmd = postProcessCommand(rawCmd, rawCmd, {
        rgAvailable: false,
        rtkPrefix: "rtk"
      });
    }

    // In self-only mode, deterministically inject --id <convId> when --id and --file were omitted (or --id current / positional current)
    if (agyTranscriptCheck.allowed && agyTranscriptCheck.injectSelfId) {
      if (/(^|\s)--id(?:=|\s+)(["']?)current\2(?=\s|$)/i.test(effectiveCmd)) {
        effectiveCmd = effectiveCmd.replace(/(^|\s)--id(?:=|\s+)(["']?)current\2(?=\s|$)/gi, `$1--id ${agyTranscriptCheck.injectSelfId}`);
      } else if (agyTranscriptCheck.targetWasCurrentPlaceholder) {
        const updatedCmd = effectiveCmd.replace(
          /(^|\s)(["']?)current\2(?=(?:\s|$)(?!.*\s["']?current["']?(?:\s|$)))/i,
          `$1--id ${agyTranscriptCheck.injectSelfId}`
        );
        effectiveCmd = updatedCmd !== effectiveCmd ? updatedCmd : `${effectiveCmd.trim()} --id ${agyTranscriptCheck.injectSelfId}`;
      } else {
        effectiveCmd = `${effectiveCmd.trim()} --id ${agyTranscriptCheck.injectSelfId}`;
      }
    }
    if (agyTranscriptCheck.allowed && agyTranscriptCheck.injectParentId) {
      effectiveCmd = effectiveCmd.replace(/(^|\s)--parent(?:=|\s+)(["']?)current\2(?=\s|$)/gi, `$1--parent ${agyTranscriptCheck.injectParentId}`);
    }

    // Rewrite bare `agy-context` / `agy-context-saver` to the installed shim (or plugin CLI) when absent from PATH
    if (agyTranscriptCheck.allowed || (isSingleUnchainedShellCmd(segments) && !isSpillover && !taskMatch)) {
      const bareAgyMatch = effectiveCmd.match(/^(\s*)(agy-context(?:-saver)?(?:\.(?:cmd|exe|bat))?)(?=\s|$)/i);
      if (bareAgyMatch) {
        const agyBinName = normalizeCmdName(bareAgyMatch[2]);
        if (!findExecutableOnPath(agyBinName)) {
          const localAgyCmd = resolveInstalledAgyContextCommand(agyBinName);
          if (localAgyCmd) {
            effectiveCmd = `${bareAgyMatch[1]}${localAgyCmd}${effectiveCmd.slice(bareAgyMatch[0].length)}`;
          }
        }
      }
    }

    const parsedEff = parseRtkReadCommand(effectiveCmd);
    const parsedRaw = parseRtkReadCommand(rawCmd);
    const isRtkRead = Boolean(parsedEff);
    const isExplicitRtkRead = Boolean(parsedRaw && parsedEff);
    const parsedDegraded = !rtk ? parseDegradedBoundedHeadTailCommand(effectiveCmd) : null;
    let isDegradedBoundedRead = false;
    if ((isSpillover || taskMatch) && parsedDegraded) {
      const opCountOk = parsedDegraded.operands.length === 1;
      const cleanOp = opCountOk ? cleanFileToken(parsedDegraded.operands[0]) : "";
      isDegradedBoundedRead =
        opCountOk &&
        parsedDegraded.hasSafeLineBound &&
        !parsedDegraded.hasDisallowedFlag &&
        ((isSpillover && !taskMatch && isStepSpilloverPath(cleanOp)) ||
          (taskMatch && !isSpillover && Boolean(matchTaskLogToken(cleanOp, convId))));
    }

    // Enforce strict single-operand isolation whenever an internal spillover or task log is present (PR9-RUN-001)
    if ((isSpillover || taskMatch) && parsedEff) {
      const opCountOk = parsedEff.operands.length === 1;
      const cleanOp = opCountOk ? cleanFileToken(parsedEff.operands[0]) : "";
      const singleOpValid =
        opCountOk &&
        !parsedEff.hasDisallowedFlag &&
        ((isSpillover && !taskMatch && isStepSpilloverPath(cleanOp)) ||
          (taskMatch && !isSpillover && Boolean(matchTaskLogToken(cleanOp, convId))));
      if (!singleOpValid) {
        respond({
          decision: "deny",
          reason:
            "Antigravity Execution Governance: Internal step spillovers and task logs must be inspected strictly one file at a time using 'rtk read <path>' with valid read flags (multi-file operands and mixed targets are prohibited)."
        });
      }
    }

    // Check 3: Step Output Spillover Safe Harbor (strictly single unchained `rtk read`, or bounded `head -n 150`/`tail -n 150` in degraded mode)
    if (isSpillover && (rtk ? !isRtkRead : !isDegradedBoundedRead)) {
      respond({
        decision: "deny",
        reason: rtk
          ? "Antigravity Execution Governance: Runtime step output spillover files must be inspected using 'rtk read <path>' via run_command (or bounded 'read_file' <= 150 lines) to prevent context blowouts."
          : "Antigravity Execution Governance: Runtime step output spillover files must be inspected using a single unchained 'head -n 150 <path>' or 'tail -n 150 <path>' via run_command (or bounded 'read_file' <= 150 lines) to prevent context blowouts."
      });
    }

    // Check 4: Completed task logs allow post-rewrite `rtk read` (or bounded `head -n 150`/`tail -n 150` when degraded without RTK); unknown-state logs require explicit `rtk read`
    if (taskMatch && (rtk ? (taskState === "COMPLETED" ? !isRtkRead : !isExplicitRtkRead) : (taskState !== "COMPLETED" || !isDegradedBoundedRead))) {
      respond({
        decision: "deny",
        reason: rtk
          ? "Antigravity Execution Governance: Direct shell access to internal Antigravity execution state (.system_generated) is strictly prohibited to prevent transcript bloat and polling loops.\n" +
            "- Once completed, inspect output using 'rtk read <path>' via run_command.\n" +
            "- If actively running, yield execution turn and rely on native Reactive Wakeup (<SYSTEM_MESSAGE>)."
          : "Antigravity Execution Governance: Direct shell access to internal Antigravity execution state (.system_generated) is strictly prohibited to prevent transcript bloat and polling loops.\n" +
            "- Once completed, inspect output using a single unchained 'head -n 150 <path>' or 'tail -n 150 <path>' via run_command (or bounded 'read_file' <= 150 lines).\n" +
            "- If actively running, yield execution turn and rely on native Reactive Wakeup (<SYSTEM_MESSAGE>)."
      });
    }

    // Fail loud with explicit guidance instead of silently injecting --tail-lines 150 on >45 KiB spillover/task logs (ACS-HOOK-GREP-CLAMP)
    if (isRtkRead && (isSpillover || taskMatch) && !parsedEff.hasSafeLineBound) {
      const candidates = [];
      if (spilloverTok) candidates.push(spilloverTok);
      if (taskMatch?.token) candidates.push(taskMatch.token);
      for (const op of parsedEff.operands) candidates.push(op);
      for (const candidateTok of new Set(candidates)) {
        for (const statPath of resolveInternalReadStatPaths(candidateTok, convId, taskMatch, isSpillover)) {
          try {
            const st = fs.statSync(statPath);
            if (st.isFile()) {
              if (st.size > MAX_FULL_FILE_BYTES) {
                const kib = (st.size / 1024).toFixed(1);
                const boundedFallback = isSpillover && !taskMatch ? " (or use bounded 'read_file' <= 150 lines)" : "";
                respond({
                  decision: "deny",
                  reason:
                    `Antigravity Execution Governance: Unbounded 'rtk read' on >45 KiB spillover/task log (${kib} KiB) is denied to prevent cascading spillovers. ` +
                    `Pass '--head-lines 150' or '--tail-lines 150' explicitly${boundedFallback} instead.`
                });
              }
              break;
            }
          } catch {}
        }
      }
    }

    const isDaemon = args.IsDaemon === true || args.isDaemon === true;
    const rawWaitMs = args.WaitMsBeforeAsync !== undefined ? args.WaitMsBeforeAsync : args.waitMsBeforeAsync;
    const waitMs = rawWaitMs === null ? undefined : rawWaitMs;
    const targetMaxWait = Number(process.env.AGY_MAX_WAIT_MS) || 10000;

    const overwrite = {};
    if (effectiveCmd !== rawCmd) {
      overwrite.CommandLine = effectiveCmd;
    }
    if (!isDaemon && waitMs === undefined) {
      overwrite.WaitMsBeforeAsync = targetMaxWait;
    }

    if (pendingWrittenSet.size > 0) {
      for (const writtenPath of pendingWrittenSet) {
        recordSessionWrittenFile(convId, writtenPath);
      }
    }

    if (Object.keys(overwrite).length > 0) {
      respond({ decision: "allow", overwrite });
    }
    respond({ decision: "allow" });
  }

  // =========================================================================
  // 2. Native File & Inspection Tools: Root Protection, Hybrid Slice & RTK
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
      args.Path ||
      args.path ||
      args.AbsolutePath ||
      args.absolutePath ||
      args.TargetFile ||
      args.targetFile ||
      args.target_file ||
      args.dirPath ||
      args.dir_path ||
      args.directory ||
      args.SearchPath ||
      args.searchPath ||
      "";
    const target = String(rawTarget).trim();

    const rawStart = args.StartLine !== undefined ? args.StartLine : (args.startLine !== undefined ? args.startLine : args.start_line);
    const rawEnd = args.EndLine !== undefined ? args.EndLine : (args.endLine !== undefined ? args.endLine : args.end_line);
    const hasByteOffset = args.ByteOffset !== undefined || args.byteOffset !== undefined || args.byte_offset !== undefined;
    const hasSliceParams = rawStart !== undefined || rawEnd !== undefined;

    // 2a. Step Output Spillover Safe Harbor: bounded read_file (<= 150 lines) allowed; else route to rtk read / bounded read_file
    if (isStepSpilloverPath(target)) {
      if (toolName === "read_file" && rawStart !== undefined && rawEnd !== undefined) {
        const startLine = Number(rawStart);
        const endLine = Number(rawEnd);
        if (
          Number.isInteger(startLine) &&
          Number.isInteger(endLine) &&
          startLine > 0 &&
          endLine >= startLine &&
          (endLine - startLine + 1) <= MAX_SAFE_SLICE_LINES
        ) {
          respond({ decision: "allow" });
        }
      }
      const hasRtkForSpill = Boolean(resolveCachedHostEnv().rtk);
      const spillCmd = hasRtkForSpill
        ? (isOversizedInternalTarget(target, convId, null, true)
            ? `'rtk read --tail-lines 150 ${target}' (or '--head-lines 150')`
            : `'rtk read ${target}'`)
        : `'tail -n 150 ${target}' (or 'head -n 150 ${target}')`;
      respond({
        decision: "deny",
        reason: `Antigravity Governance: Unbounded inspection of step spillover via '${toolName}' is denied. Pass a bounded slice ('StartLine' and 'EndLine', max ${MAX_SAFE_SLICE_LINES} lines) to 'read_file' or run ${spillCmd} via run_command instead.`
      });
    }

    // 2b. Task Log Inspection (Lifecycle-Gated)
    const taskMatch = matchTaskLogToken(target, convId);
    if (taskMatch) {
      const state = getTaskState(taskMatch, convId);
      if (state === "RUNNING") {
        denyRunningTask(taskMatch.id, convId, taskMatch.token);
      }
      if (state === "COMPLETED") {
        const hasRtkForTask = Boolean(resolveCachedHostEnv().rtk);
        if (!hasRtkForTask && toolName === "read_file" && rawStart !== undefined && rawEnd !== undefined) {
          const startLine = Number(rawStart);
          const endLine = Number(rawEnd);
          if (
            Number.isInteger(startLine) &&
            Number.isInteger(endLine) &&
            startLine > 0 &&
            endLine >= startLine &&
            (endLine - startLine + 1) <= MAX_SAFE_SLICE_LINES
          ) {
            respond({ decision: "allow" });
          }
        }
        const taskCmd = hasRtkForTask
          ? (isOversizedInternalTarget(target, convId, taskMatch, false)
              ? `'rtk read --tail-lines 150 ${target}' (or '--head-lines 150')`
              : `'rtk read ${target}'`)
          : `'tail -n 150 ${target}' (or 'head -n 150 ${target}')`;
        respond({
          decision: "deny",
          reason: hasRtkForTask
            ? `Antigravity Governance: Native file inspection via '${toolName}' bypasses token optimization. Run ${taskCmd} via run_command instead.`
            : `Antigravity Governance: Unbounded inspection of completed task logs via '${toolName}' is denied. Pass a bounded slice ('StartLine' and 'EndLine', max ${MAX_SAFE_SLICE_LINES} lines) to 'read_file' or run ${taskCmd} via run_command instead.`
        });
      }
      respond({
        decision: "deny",
        reason:
          "Antigravity Execution Governance: Direct access to internal Antigravity execution state (.system_generated/tasks) is strictly prohibited to prevent polling loops. Rely on native Reactive Wakeup (<SYSTEM_MESSAGE>) upon completion."
      });
    }

    // 2c. Other Internal State Protection by Root (LH-02)
    if (isProtectedInternalState(target) || isProtectedInternalState(JSON.stringify(args))) {
      respond({
        decision: "deny",
        reason: buildInternalStateToolDenial(convId)
      });
    }

    // 2d. Allow Antigravity Special Files (SKILL.md, brain artifacts, configs) symmetrically for read_file & view_file
    if (isAntigravitySpecialFile(target)) {
      respond({ decision: "allow" });
    }

    // 2e. Symmetrical Hybrid Slice & Guarded Full-File Policy for `read_file` and `view_file`
    if (toolName === "read_file" || toolName === "view_file") {
      const getDiscoveryGuidance = () => {
        const { rtk, rgAvailable } = resolveCachedHostEnv();
        if (rtk) {
          const searchHint = rgAvailable ? "rtk rg" : "rtk grep -rnE";
          return `Locate the target symbol, heading, or config key first with '${searchHint}' via run_command and pass a precise bounded slice ('StartLine' and 'EndLine', max ${MAX_SAFE_SLICE_LINES} lines) to '${toolName}'`;
        }
        const shellSearchHint = rgAvailable ? "rg" : "grep -rnE";
        return `Locate the target symbol, heading, or config key first with 'grep_search' (or '${shellSearchHint}' via run_command) and pass a precise bounded slice ('StartLine' and 'EndLine', max ${MAX_SAFE_SLICE_LINES} lines) to '${toolName}'`;
      };

      if (hasByteOffset && !hasSliceParams) {
        respond({
          decision: "deny",
          reason: `Antigravity Governance: Unbounded 'ByteOffset'-only read via '${toolName}' is denied. ${getDiscoveryGuidance()}.`
        });
      }

      if (hasSliceParams) {
        const startLine = Number(rawStart);
        const endLine = Number(rawEnd);

        if (
          rawStart !== undefined &&
          rawEnd !== undefined &&
          Number.isInteger(startLine) &&
          Number.isInteger(endLine) &&
          startLine > 0 &&
          endLine >= startLine
        ) {
          const span = endLine - startLine + 1;
          if (span <= MAX_SAFE_SLICE_LINES) {
            respond({ decision: "allow" });
          }

          const metrics = startLine === 1 && !hasByteOffset ? getFileMetrics(target) : null;
          const isExplicitFullFile = Boolean(
            metrics &&
              startLine === 1 &&
              (endLine === metrics.lineCount || endLine === metrics.rawSplitCount)
          );

          if (isExplicitFullFile) {
            if (metrics.lineCount <= MAX_FULL_FILE_LINES && metrics.bytes <= MAX_FULL_FILE_BYTES) {
              respond({ decision: "allow" });
            }
            const kib = (metrics.bytes / 1024).toFixed(1);
            respond({
              decision: "deny",
              reason: `Antigravity Governance: Explicit full-file read via '${toolName}' (${metrics.lineCount} lines, ${kib} KiB) exceeds the full-file audit ceiling (max ${MAX_FULL_FILE_LINES} lines and 45 KiB). ${getDiscoveryGuidance()}.`
            });
          }

          respond({
            decision: "deny",
            reason: `Antigravity Governance: Oversized partial file slice via '${toolName}' (${span} lines > ${MAX_SAFE_SLICE_LINES} lines max safe slice window). Partial slices above ${MAX_SAFE_SLICE_LINES} lines are denied; full-file reads are only permitted when explicitly covering line 1 through the actual end of a file <= ${MAX_FULL_FILE_LINES} lines and <= 45 KiB. ${getDiscoveryGuidance()}.`
          });
        }

        respond({
          decision: "deny",
          reason: `Antigravity Governance: Invalid slice range via '${toolName}'. Ensure StartLine and EndLine are positive integers with EndLine >= StartLine. ${getDiscoveryGuidance()}.`
        });
      }

      respond({
        decision: "deny",
        reason: `Antigravity Governance: Full-file inspection via '${toolName}' without explicit bounds is denied. ${getDiscoveryGuidance()} (or pass explicit StartLine=1, EndLine=<TotalLines> for a one-pass audit when the file is <= ${MAX_FULL_FILE_LINES} lines and <= 45 KiB).`
      });
    }

    // 2f. Hard-Route Other Native File/Search Tools (LH-07); degrade gracefully when RTK is absent (--allow-degraded)
    const { rtk: hostRtk, rgAvailable: hostRgAvailable } = resolveCachedHostEnv();

    if (toolName === "read_many_files") {
      respond({
        decision: "deny",
        reason: hostRtk
          ? "Antigravity Governance: Native multi-file reading via 'read_many_files' bypasses token optimization. Use bounded 'read_file' slices ('<= 150' lines) for editable workspace code, or run 'rtk read <file>' via run_command for read-only logs and spillovers instead."
          : "Antigravity Governance: Native multi-file reading via 'read_many_files' bypasses context bounds. Use bounded 'read_file' slices ('<= 150' lines) for editable workspace code, or run bounded 'head -n 150 <file>' / 'tail -n 150 <file>' via run_command for read-only logs and spillovers instead."
      });
    }

    if (!hostRtk && (toolName === "grep_search" || toolName === "find_by_name" || toolName === "list_dir")) {
      respond({ decision: "allow" });
    }

    if (toolName === "grep_search") {
      const pattern = String(args.Query || args.query || args.Pattern || args.pattern || "").trim();
      const searchTarget = String(args.SearchPath || args.searchPath || args.path || ".").trim() || ".";
      const safePattern = pattern ? escapeDoubleQuotedArg(pattern) : "<pattern>";
      const cmdHint = hostRgAvailable
        ? `rtk rg -- "${safePattern}" ${searchTarget}`
        : `rtk grep -rnE "${safePattern}" ${searchTarget}`;
      respond({
        decision: "deny",
        reason: `Antigravity Governance: Native grep inspection via 'grep_search' bypasses token optimization. Run '${cmdHint}' via run_command instead (or raw 'grep -rnE' when untruncated lines or >25 matches per file are needed).`
      });
    }

    if (toolName === "find_by_name") {
      const searchTarget = args.Pattern || args.pattern || args.query || target || ".";
      respond({
        decision: "deny",
        reason: `Antigravity Governance: Native file search via 'find_by_name' bypasses token optimization. Run 'rtk find ${searchTarget}' via run_command instead.`
      });
    }

    if (toolName === "list_dir") {
      const isWin = os.platform() === "win32";
      const cmdHint = isWin ? `rtk find ${target || "."}` : `rtk ls ${target || "."}`;
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

    // kill, send_input, and list are always allowed immediately
    if (action !== "status") {
      respond({ decision: "allow" });
    }

    const session = getSessionState(convId);
    const now = Date.now();
    pruneTaskBackoff(session, convId, now);

    const taskId = cleanGovernanceArg(args.TaskId || args.taskId);
    if (taskId && !session.taskIds.includes(taskId)) {
      session.taskIds.push(taskId);
    }

    const taskKey = extractTaskBackoffKey("manage_task", args);
    const bucket = taskKey ? getOrCreateTaskBucket(session, taskKey, now) : null;
    const stateRef = bucket || session;
    const pendingWatchdog = stateRef.pendingWatchdog && typeof stateRef.pendingWatchdog === "object"
      ? stateRef.pendingWatchdog
      : null;

    const requiredBackoffSec = pendingWatchdog
      ? Math.max(0, (Number(pendingWatchdog.requiredSec) || 30) - 2)
      : (stateRef.pollCount === 0 ? 0 : getRequiredBackoffSeconds(stateRef.pollCount));
    const displayRequiredSec = pendingWatchdog
      ? (Number(pendingWatchdog.requiredSec) || 30)
      : requiredBackoffSec;
    const requiredBackoffMs = requiredBackoffSec * 1000;
    const elapsedMs = stateRef.lastPollTime ? Math.max(0, now - stateRef.lastPollTime) : Infinity;
    const elapsedSec = Math.floor(elapsedMs / 1000);

    // Premature check before backoff interval has elapsed
    if (elapsedMs < requiredBackoffMs) {
      if (bucket) {
        bucket.denials++;
        bucket.lastSeenTime = now;
      }
      session.denials++;
      saveSessionState(convId, session, { updatePollTime: false });

      const effectiveDenials = bucket ? Math.max(bucket.denials, session.denials) : session.denials;
      if (effectiveDenials >= 5) {
        respond({
          decision: "force_ask",
          reason: `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: manage_task('${action}') called prematurely ${effectiveDenials} times during active backoff window across tasks [${session.taskIds.join(", ")}]. User confirmation required to proceed.`
        });
      }

      const remainingSec = Math.max(1, Math.ceil((Math.max(requiredBackoffMs, displayRequiredSec * 1000) - elapsedMs) / 1000));
      const condTarget = taskKey || "task-X";
      const condExample = convId && convId !== "global" ? `${convId}/${condTarget}` : condTarget;
      respond({
        decision: "deny",
        reason: `Antigravity Execution Governance: Proportional Backoff Active (Level ${stateRef.pollCount}${taskKey ? ` for '${taskKey}'` : ""}, ${effectiveDenials} denial${effectiveDenials > 1 ? "s" : ""}). Diagnostic check #${stateRef.pollCount + 1} requires at least ${displayRequiredSec}s elapsed since previous check (${elapsedSec}s elapsed, ${remainingSec}s remaining). Keep a conditioned watchdog armed via schedule(DurationSeconds=${Math.max(30, displayRequiredSec)}, TimerCondition="${condExample}") so Reactive Wakeup (<SYSTEM_MESSAGE>) wakes you on completion or stall (manage_task(Action='kill') is always allowed immediately at 0s if hung).`
      });
    }

    // Backoff window satisfied! Allow diagnostic check and advance level:
    if (pendingWatchdog) {
      // Consuming an armed watchdog's diagnostic inspection preserves the level already advanced by schedule()
      delete stateRef.pendingWatchdog;
    } else {
      stateRef.pollCount++;
    }
    stateRef.lastPollTime = now;
    if (bucket) {
      bucket.lastSeenTime = now;
      bucket.denials = 0;
    }
    session.denials = 0;
    saveSessionState(convId, session);
    respond({ decision: "allow" });
  }

  if (toolName === "schedule") {
    const duration = Number(args.DurationSeconds || args.durationSeconds || args.duration || 0);
    const rawCond = cleanGovernanceArg(args.TimerCondition || args.timerCondition);

    if (isSwarmPollSchedule(args)) {
      const session = getSessionState(convId);
      session.denials++;
      saveSessionState(convId, session, { updatePollTime: false });
      if (session.denials >= 5) {
        respond({
          decision: "force_ask",
          reason: `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: /swarm schedule polling attempted ${session.denials} times. Use 'swarm_wait' for '/swarm' (the dedicated 'swarm_monitor' daemon cron checks for stalls). User confirmation required to proceed.`
        });
      }
      respond({
        decision: "deny",
        reason:
          "Antigravity Execution Governance: Using one-shot 'schedule' timers to poll a '/swarm' board or squad is strictly prohibited. " +
          "Call 'swarm_wait' directly without a 'schedule' timer (it sleeps at zero token cost and wakes immediately when any board message arrives, while the dedicated 'swarm_monitor' daemon cron handles stall detection)."
      });
    }

    if (isSubagentPollSchedule(args)) {
      const session = getSessionState(convId);
      const now = Date.now();
      pruneTaskBackoff(session, convId, now);

      const subKey = extractTaskBackoffKey("schedule", args);
      const bucket = subKey ? getOrCreateTaskBucket(session, subKey, now) : null;
      const stateRef = bucket || session;
      const requiredSubagentSec = getRequiredSubagentBackoffSeconds(stateRef.pollCount);
      const hasValidCond = hasValidSubagentTimerCondition(args);

      if (!hasValidCond || !Number.isFinite(duration) || duration < 30) {
        if (bucket) {
          bucket.denials++;
          bucket.lastSeenTime = now;
        }
        session.denials++;
        saveSessionState(convId, session, { updatePollTime: false });

        const effectiveDenials = bucket ? Math.max(bucket.denials, session.denials) : session.denials;
        if (effectiveDenials >= 5) {
          respond({
            decision: "force_ask",
            reason: `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: direct subagent schedule polling denied ${effectiveDenials} times. Retry 'schedule' with DurationSeconds >= ${requiredSubagentSec} and TimerCondition="<subagentConvId>", or confirm with the user to proceed.`
          });
        }

        const condHint = rawCond && hasValidCond ? rawCond : (subKey || "<subagentConvId>");
        const cause = !hasValidCond
          ? "Unconditioned subagent polling timers are prohibited."
          : `Direct subagent stall watchdog duration too short (${duration}s < 30s minimum).`;
        respond({
          decision: "deny",
          reason: `Antigravity Execution Governance: ${cause} (${effectiveDenials} denial${effectiveDenials > 1 ? "s" : ""}). For direct invoke_subagent stall safety, retry 'schedule' with DurationSeconds >= ${requiredSubagentSec} and TimerCondition="${condHint}" so the watchdog auto-cancels at zero cost if the subagent finishes normally.`
        });
      }

      // Valid conditioned direct-subagent stall watchdog (>= 30s): auto-clamp 30..required-1 up to requiredSubagentSec
      const clamped = duration < requiredSubagentSec;
      stateRef.pollCount++;
      stateRef.lastPollTime = now;
      if (bucket) {
        bucket.lastSeenTime = now;
        bucket.denials = 0;
      }
      session.denials = 0;
      saveSessionState(convId, session);
      if (clamped) {
        respond({ decision: "allow", overwrite: { DurationSeconds: requiredSubagentSec } });
      }
      respond({ decision: "allow" });
    }

    if (isTaskPollSchedule(args)) {
      const session = getSessionState(convId);
      const now = Date.now();
      pruneTaskBackoff(session, convId, now);

      const taskKey = extractTaskBackoffKey("schedule", args);
      const bucket = taskKey ? getOrCreateTaskBucket(session, taskKey, now) : null;
      const stateRef = bucket || session;
      const requiredBackoffSec = Math.max(30, getRequiredBackoffSeconds(stateRef.pollCount));
      const hasValidCond = hasValidTaskTimerCondition(args);
      const condTarget = taskKey || "task-X";
      const condHint = hasValidCond
        ? rawCond
        : (convId && convId !== "global" ? `${convId}/${condTarget}` : condTarget);

      // Hard deny abusive micro-polls (< 15s) or unconditioned task polling loops
      if (!hasValidCond || !Number.isFinite(duration) || duration < 15) {
        if (bucket) {
          bucket.denials++;
          bucket.lastSeenTime = now;
        }
        session.denials++;
        saveSessionState(convId, session, { updatePollTime: false });

        const effectiveDenials = bucket ? Math.max(bucket.denials, session.denials) : session.denials;
        if (effectiveDenials >= 5) {
          respond({
            decision: "force_ask",
            reason: `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: schedule polling timer denied ${effectiveDenials} times. Retry 'schedule' with DurationSeconds >= ${requiredBackoffSec} and TimerCondition="${condHint}", or confirm with the user to proceed.`
          });
        }

        const cause = !hasValidCond
          ? "Unconditioned task polling timers are prohibited because they do not auto-cancel when the task finishes."
          : `Task watchdog timer duration too short (${duration}s < 15s minimum).`;
        respond({
          decision: "deny",
          reason: `Antigravity Execution Governance: ${cause} (Level ${stateRef.pollCount}${taskKey ? ` for '${taskKey}'` : ""}, ${effectiveDenials} denial${effectiveDenials > 1 ? "s" : ""}). Retry 'schedule' with DurationSeconds >= ${requiredBackoffSec} and TimerCondition="${condHint}" so the watchdog auto-cancels at zero cost on normal completion while protecting against stalls.`
        });
      }

      // Conditioned task watchdog with DurationSeconds >= 15: auto-clamp up to requiredBackoffSec instead of dropping monitoring
      const effectiveDuration = duration < requiredBackoffSec ? requiredBackoffSec : duration;
      stateRef.pollCount = Math.max(1, stateRef.pollCount) + 1;
      stateRef.lastPollTime = now;
      stateRef.pendingWatchdog = { armedAt: now, requiredSec: requiredBackoffSec, durationSec: effectiveDuration };
      if (bucket) {
        bucket.lastSeenTime = now;
        bucket.denials = 0;
      }
      session.denials = 0;
      saveSessionState(convId, session);
      if (duration < requiredBackoffSec) {
        respond({ decision: "allow", overwrite: { DurationSeconds: requiredBackoffSec } });
      }
      respond({ decision: "allow" });
    }

    // Non-polling timers (e.g. user-requested reminders) are allowed
    respond({ decision: "allow" });
  }

  // =========================================================================
  // 4. Benchmark, Governance & Evaluator Mutation Protection (LH-09 & LH-02)
  // =========================================================================
  if (
    toolName === "replace_file_content" ||
    toolName === "write_to_file" ||
    toolName === "write_file" ||
    toolName === "edit_file"
  ) {
    const targetFile = String(args.Path || args.path || args.TargetFile || args.targetFile || "").trim();
    if (isProtectedInternalState(targetFile)) {
      respond({
        decision: "deny",
        reason: buildInternalStateToolDenial(convId)
      });
    }
    if (isProtectedGovernanceFileMutation(targetFile, convId)) {
      respond({
        decision: "deny",
        reason:
          "Antigravity Execution Governance: Direct mutation of protected Antigravity hook, shim, or governance source files is strictly prohibited."
      });
    }

    const bodyContent = String(
      args.Content ||
        args.content ||
        args.file_content ||
        args.Replacement ||
        args.replacement ||
        args.new_string ||
        ""
    );
    const normTarget = targetFile.replace(/\\/g, "/");
    const isTmpOrScratch =
      normTarget.startsWith("/tmp/") ||
      normTarget.startsWith("/var/tmp/") ||
      normTarget.includes("/scratch/") ||
      normTarget.startsWith("scratch/") ||
      normTarget.startsWith(os.tmpdir().replace(/\\/g, "/") + "/");
    const isScript = isExecutableScriptPath(targetFile) || /^\s*#!/.test(bodyContent);
    const callerAccess = evaluateCallerTranscriptAccess(convId);

    if (isScript && bodyContent && (callerAccess.isRestrictedChild || isTmpOrScratch)) {
      if (isProtectedShellOrScriptOperation(bodyContent, { isRestrictedChild: callerAccess.isRestrictedChild })) {
        respond({
          decision: "deny",
          reason: buildInternalStateShellDenial(convId)
        });
      }
    }

    if (!isBenchmarkGuardDisabled(convId) && isProtectedBenchmarkPath(targetFile)) {
      respond({
        decision: "force_ask",
        reason: `[BENCHMARK MUTATION DETECTED] Mutation of protected evaluator/benchmark artifact '${targetFile}' requires explicit user confirmation to prevent benchmark contamination. Set AGY_DISABLE_BENCHMARK_GUARD=1 to disable this guard for non-evaluation repos.`
      });
    }
    if (targetFile && (callerAccess.isRestrictedChild || isExecutableScriptPath(targetFile) || isTmpOrScratch)) {
      recordSessionWrittenFile(convId, targetFile);
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
