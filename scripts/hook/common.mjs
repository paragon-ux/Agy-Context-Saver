/**
 * Shared PreToolUse hook primitives: locked session state, memoized lineage/access,
 * canonical path & direct internal-state guards, repo-scoped governance protection, and task state.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getStateDir } from "../state-dir.mjs";
import { getEffectiveMode, isTopLevelUnrestricted } from "../../lib/transcript-policy.mjs";
import {
  getProfileHomeDir,
  getBrainDirs,
  resolveRealOrAncestorPath,
  isContainedInAnyBrainDir,
  isProtectedBenchmarkPath,
  isProtectedBrainSubpath as isProtectedBrainSubpathShared,
  isProtectedGeminiConfigFile
} from "../../lib/path-guards.mjs";

export const STATE_TTL_MS = 3600000;

export const MAX_SAFE_SLICE_LINES = 800;
export const MAX_SMALL_AUTO_ALLOW_LINES = 800;
export const MAX_SMALL_AUTO_ALLOW_BYTES = 45 * 1024;
export const MAX_SPILLOVER_SLICE_LINES = 150;
export const MAX_FULL_FILE_LINES = 800;
export const MAX_FULL_FILE_BYTES = 45 * 1024;
export const MAX_LINE_COUNT_SCAN_BYTES = 1024 * 1024;
export const TASK_TAIL_BYTES = 262144;
export const TASK_QUIET_MS = 300000;
export const HOOK_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MAX_STATE_ENTRIES = 50;
export const MAX_TASK_BACKOFF_ENTRIES = 64;

const SESSION_LOCK_STALE_MS = 3000;
const SESSION_LOCK_WAIT_MS = 800;
const SLEEP_WAIT_ARR = new Int32Array(new SharedArrayBuffer(4));

const heldLocks = new Map();

function releaseAllLocks() {
  for (const lockPath of heldLocks.keys()) {
    try { fs.unlinkSync(lockPath); } catch {}
  }
  heldLocks.clear();
}
process.on("exit", releaseAllLocks);

export function respond(obj) {
  releaseAllLocks();
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(0);
}

export function ensureStateDir() {
  try { fs.mkdirSync(getStateDir(), { recursive: true }); } catch {}
}

export function getStateFilePath(convId = "global") {
  if (!convId || convId === "global") return path.join(getStateDir(), "agy-session-governance-state.json");
  return path.join(getStateDir(), `agy-session-${String(convId).replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function withSessionLock(convId, fn) {
  ensureStateDir();
  const safeId = !convId || convId === "global" ? "global" : String(convId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const lockPath = path.join(getStateDir(), `agy-session-${safeId}.lock`);
  if (heldLocks.has(lockPath)) {
    heldLocks.set(lockPath, heldLocks.get(lockPath) + 1);
    try { return fn(); } finally {
      const next = (heldLocks.get(lockPath) || 1) - 1;
      if (next <= 0) heldLocks.delete(lockPath);
      else heldLocks.set(lockPath, next);
    }
  }

  let acquired = false;
  const deadline = Date.now() + SESSION_LOCK_WAIT_MS;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try { fs.writeFileSync(fd, `${process.pid}:${Date.now()}\n`, "utf-8"); } catch {}
      try { fs.closeSync(fd); } catch {}
      heldLocks.set(lockPath, 1);
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") break;
      try {
        if ((Date.now() - fs.statSync(lockPath).mtimeMs) > SESSION_LOCK_STALE_MS) {
          try { fs.unlinkSync(lockPath); } catch {}
          continue;
        }
      } catch { continue; }
      if (Date.now() >= deadline) break;
      try { Atomics.wait(SLEEP_WAIT_ARR, 0, 0, 15); } catch { break; }
    }
  }
  try { return fn(); } finally {
    if (acquired) {
      heldLocks.delete(lockPath);
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}

export function writeAtomicJson(filePath, jsonStr) {
  const tmpFile = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmpFile, jsonStr, "utf-8");
  try { fs.renameSync(tmpFile, filePath); } catch {
    fs.writeFileSync(filePath, jsonStr, "utf-8");
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function pruneExpiredSessionFiles(now) {
  try {
    const dir = getStateDir();
    for (const name of fs.readdirSync(dir)) {
      if (name === "agy-session-governance-state.json" || !/^agy-session-[a-zA-Z0-9_-]+\.(?:json|lock)$/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.lstatSync(full);
        if (!st.isSymbolicLink() && st.isFile() && (now - st.mtimeMs) > STATE_TTL_MS) fs.unlinkSync(full);
      } catch {}
    }
  } catch {}
}

export function getSessionState(convId = "global") {
  try {
    const parsed = JSON.parse(fs.readFileSync(getStateFilePath(convId), "utf-8"));
    const entry = parsed && typeof parsed.pollCount === "number" ? parsed : parsed?.[convId];
    const activityTime = Math.max(entry?.lastPollTime || 0, entry?.lastSeenTime || 0);
    if (entry && activityTime > 0 && (Date.now() - activityTime) < STATE_TTL_MS) {
      if (!entry.taskBackoff || typeof entry.taskBackoff !== "object" || Array.isArray(entry.taskBackoff)) entry.taskBackoff = {};
      if (!Array.isArray(entry.taskIds)) entry.taskIds = [];
      return entry;
    }
  } catch {}
  return { pollCount: 0, denials: 0, taskIds: [], taskBackoff: {}, lastPollTime: 0, lastSeenTime: 0 };
}

export function updateSessionState(convId = "global", mutateFn, { updatePollTime = false } = {}) {
  return withSessionLock(convId, () => {
    const entry = getSessionState(convId);
    const now = Date.now();
    const out = mutateFn(entry, now);
    const skipWrite = out === false || Boolean(out && typeof out === "object" && out.skipWrite);
    const shouldUpdatePoll = Boolean(updatePollTime || (out && typeof out === "object" && out.updatePollTime));
    if (!skipWrite) {
      const file = getStateFilePath(convId);
      ensureStateDir();
      try {
        const existed = fs.existsSync(file);
        entry.lastSeenTime = now;
        if (shouldUpdatePoll) entry.lastPollTime = now;
        delete entry.recentHookCalls;
        delete entry.writtenFiles;
        let toWrite;
        if (!convId || convId === "global") {
          let state = {};
          try {
            const p = JSON.parse(fs.readFileSync(file, "utf-8"));
            if (p && typeof p === "object" && typeof p.pollCount !== "number") state = p;
          } catch {}
          state[convId || "global"] = entry;
          const entries = Object.entries(state)
            .filter(([_, v]) => { const ts = Math.max(v?.lastPollTime || 0, v?.lastSeenTime || 0); return v && ts > 0 && (now - ts) < STATE_TTL_MS; })
            .sort((a, b) => Math.max(b[1].lastPollTime || 0, b[1].lastSeenTime || 0) - Math.max(a[1].lastPollTime || 0, a[1].lastSeenTime || 0))
            .slice(0, MAX_STATE_ENTRIES);
          toWrite = JSON.stringify(Object.fromEntries(entries));
        } else {
          entry.conversationId = convId;
          toWrite = JSON.stringify(entry);
        }
        writeAtomicJson(file, toWrite);
        if (!existed && convId && convId !== "global") pruneExpiredSessionFiles(now);
      } catch {}
    }
    return { state: entry, result: out && typeof out === "object" && "result" in out ? out.result : out };
  });
}

// --- Path & Memoized Lineage Helpers ---

export function resolveHookPath(p, cwd = "") {
  return p && typeof p === "string" ? (cwd ? path.resolve(cwd, p) : path.resolve(p)) : "";
}

export function expandLeadingTilde(p) {
  if (!p || typeof p !== "string") return "";
  const t = p.trim();
  if (t === "~") return getProfileHomeDir();
  return /^~[/\\]/.test(t) ? path.join(getProfileHomeDir(), t.slice(2)) : t;
}

export function cleanFileToken(p) {
  let tok = String(p || "").trim().replace(/^file:\/\//i, "");
  return /^\/[A-Za-z]:/.test(tok) ? tok.slice(1) : tok;
}

export function isExecutableScriptPath(p) {
  return Boolean(p && typeof p === "string" && /\.(?:m?js|cjs|ts|mts|cts|py|sh|bash|zsh|pl|rb|php|ps1|cmd|bat)$/i.test(p.trim()));
}

export function expandAndResolvePathVariants(rawPath, cwd = "") {
  if (!rawPath || typeof rawPath !== "string") return [];
  const cleaned = cleanFileToken(rawPath);
  if (!cleaned) return [];
  const out = new Set();
  const push = (p) => { if (p && typeof p === "string") { out.add(p); const s = p.replace(/\\/g, "/"); if (s !== p) out.add(s); } };
  push(cleaned);
  const expanded = expandLeadingTilde(cleaned);
  push(expanded);
  try {
    const resolved = resolveHookPath(expanded, cwd);
    push(resolved);
    push(resolveRealOrAncestorPath(resolved, { cwd }));
  } catch {}
  return [...out];
}

// --- Direct Internal State, Governance (1B.1), Benchmark & Cross-Conversation Guards ---

// Native reads of conversation transcripts are allowed; writes and deletes stay protected via isProtectedInternalState.
const TRANSCRIPT_LOG_PATH_RE = /[^\s'"`;|&()<>]*\.system_generated[\/\\]+logs[\/\\]+transcript(?:_full)?\.jsonl/gi;
const TRANSCRIPT_READ_ONLY_CMDS = new Set(["cat", "head", "tail", "rg", "grep", "egrep", "fgrep", "wc", "jq", "less", "more", "ls", "stat", "cut", "sort", "uniq", "tr", "nl", "tac", "file", "du"]);

export function isTranscriptLogPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  return /(?:^|[\/\\])\.system_generated[\/\\]+logs[\/\\]+transcript(?:_full)?\.jsonl$/i.test(targetPath.replace(/[\\/]+$/, ""));
}

export function stripTranscriptLogRefs(text) {
  return typeof text === "string" ? text.replace(TRANSCRIPT_LOG_PATH_RE, "TRANSCRIPT_LOG") : text;
}

export function isReadOnlyTranscriptVerb(verb) {
  return TRANSCRIPT_READ_ONLY_CMDS.has(verb);
}

export function isProtectedInternalState(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  if (
    /\.system_generated(?:$|[\/\\])/i.test(targetPath) ||
    /(?:^|[\/\\'"`\s=:])\.system_gen/i.test(targetPath) ||
    /['"]\.system_['"]\s*(?:[+.]\s*)?['"]gen/i.test(targetPath) ||
    /['"]\.['"]\s*(?:[+.]\s*)?['"]system_gen/i.test(targetPath) ||
    /\btranscript(?:_full)?\.jsonl\b/i.test(targetPath) ||
    /\.gemini[\/\\]+antigravity(?:-cli|-ide)?[\/\\]+brain[\/\\]+(?:[^\/\\\s'"]+[\/\\]?)?$/i.test(targetPath) ||
    isProtectedBrainSubpathShared(targetPath) ||
    /\.gemini[\/\\]+antigravity(?:-cli|-ide)?[\/\\]+brain[\/\\]+(?:[^\/\\\s'"]+[\/\\]+)?(?:\.(?!agents(?:$|[\/\\]))|[*?\[])/i.test(targetPath) ||
    /\b(?:transcript-policy|agy-session-governance-state|agy-rtk-rewrite-cache)\.json\b/i.test(targetPath) ||
    /\bagy-session-[a-zA-Z0-9_-]+\.json\b/i.test(targetPath) ||
    /[\/\\](?:\.local[\/\\]+state|AppData[\/\\]+Local)[\/\\]+agy-context-saver(?:$|[\/\\'"`\s])/i.test(targetPath)
  ) return true;
  try {
    const stateDirNorm = getStateDir().replace(/\\/g, "/");
    const targetNorm = targetPath.replace(/\\/g, "/");
    const isCI = os.platform() === "win32" || os.platform() === "darwin";
    if (stateDirNorm && (isCI ? targetNorm.toLowerCase().includes(stateDirNorm.toLowerCase()) : targetNorm.includes(stateDirNorm))) return true;
  } catch {}
  return false;
}

export function isProtectedInternalStatePath(rawPath, cwd = "") {
  return expandAndResolvePathVariants(rawPath, cwd).some(isProtectedInternalState);
}

export function isProtectedGovernanceFileMutationPath(rawPath, convId = "global", ctx = {}) {
  if (!rawPath || typeof rawPath !== "string") return false;
  const cwd = ctx?.cwd || "";
  for (const v of expandAndResolvePathVariants(rawPath, cwd)) {
    const norm = v.replace(/\\/g, "/");
    if (
      isProtectedGeminiConfigFile(norm) ||
      /\/\.gemini\/config\/scripts\/execution-guard-hook\.mjs$/i.test(norm) ||
      /\/\.gemini\/config\/plugins\/agy-context-saver(?:$|\/)/i.test(norm) ||
      /\/\.gemini\/antigravity(?:-cli|-ide)?\/bin\/agy-context(?:-saver)?(?:\.(?:cmd|exe|bat))?$/i.test(norm)
    ) return true;
  }
  return false;
}

const USER_EDITABLE_GEMINI_CONFIG_RE =
  /\/\.gemini\/(?:config|antigravity(?:-cli|-ide)?)\/(?:mcp_config\.json|config\.json)$/i;

// Top-level unrestricted sessions may edit non-symlink mcp_config.json / config.json via force_ask; hooks.json and all child sessions stay hard-deny
export function isUserEditableGeminiConfigPath(rawPath, convId = "global", ctx = {}) {
  if (!rawPath || typeof rawPath !== "string") return false;
  if (!isTopLevelUnrestricted(convId)) return false;
  const cwd = ctx?.cwd || "";
  const resolved = resolveHookPath(expandLeadingTilde(cleanFileToken(rawPath)), cwd);
  if (!resolved) return false;
  const canonical = resolveRealOrAncestorPath(resolved, { cwd });
  if (
    !USER_EDITABLE_GEMINI_CONFIG_RE.test(resolved.replace(/\\/g, "/")) ||
    !USER_EDITABLE_GEMINI_CONFIG_RE.test(canonical.replace(/\\/g, "/"))
  ) return false;
  const cfgDir = path.dirname(resolved);
  for (const seg of [path.dirname(cfgDir), cfgDir, resolved]) {
    try { if (fs.lstatSync(seg).isSymbolicLink()) return false; } catch {}
  }
  return true;
}

export function isProtectedGovernanceDirPath(rawPath, cwd = "") {
  return Boolean(rawPath && typeof rawPath === "string" && expandAndResolvePathVariants(rawPath, cwd).some((v) =>
    /\/\.gemini\/(?:config(?:\/(?:scripts|plugins))?|antigravity(?:-cli|-ide)?\/bin)\/?$/i.test(v.replace(/\\/g, "/"))
  ));
}

export function isProtectedBenchmarkFilePath(rawPath, cwd = "") {
  return expandAndResolvePathVariants(rawPath, cwd).some(isProtectedBenchmarkPath);
}

export function isBenchmarkGuardDisabled(convId = "global", ctx = {}) {
  const raw = String(process.env.AGY_DISABLE_BENCHMARK_GUARD || "").trim().toLowerCase();
  return (raw === "1" || raw === "true") && !getEffectiveMode(convId).restricted;
}

// --- Spillover & Task Log Resolution / State Inspection ---

export function isStepSpilloverPath(targetPath) {
  return Boolean(targetPath && typeof targetPath === "string" &&
    /(?:^|\/)\.system_generated\/steps\/\d+\/output\.txt$/i.test(cleanFileToken(targetPath).replace(/\\/g, "/")));
}

function isInsideAntigravityBrainPath(targetPath, ctx = {}) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const cwd = ctx?.cwd || "";
  const rawNorm = path.resolve(targetPath).replace(/\\/g, "/");
  const realNorm = resolveRealOrAncestorPath(targetPath, { cwd }).replace(/\\/g, "/");
  if ([rawNorm, realNorm].some((c) => /(?:^|\/)\.system_generated(?:\/|$)|\/\.gemini\/antigravity(?:-cli|-ide)?\/brain(?:\/|$)/i.test(c))) {
    return true;
  }
  return Boolean(isContainedInAnyBrainDir(targetPath, getBrainDirs({ activeTranscriptPath: ctx?.transcriptPath || "" }), null, { cwd }));
}

function pickTaskFilesInSysDir(sysDir, taskName, literalBase) {
  const candidateTranscript = path.join(sysDir, "logs", "transcript.jsonl");
  const literalLog = literalBase ? path.join(sysDir, "tasks", literalBase) : "";
  const prefixedLog = path.join(sysDir, "tasks", `${taskName}.log`);
  const chosenLog = literalLog && literalBase.toLowerCase() !== `${taskName}.log`.toLowerCase() && fs.existsSync(literalLog)
    ? literalLog
    : (fs.existsSync(prefixedLog) ? prefixedLog : (literalLog || prefixedLog));
  return { candidateTranscript, chosenLog };
}

export function matchTaskLogToken(targetPath, convId = "global", ctx = {}) {
  if (!targetPath || typeof targetPath !== "string") return null;
  const cwd = ctx?.cwd || "";
  const clean = cleanFileToken(targetPath);
  const normalized = clean.replace(/\\/g, "/");
  const m = normalized.match(/^(?:.+\/)?tasks\/(?:task-)?([a-zA-Z0-9_-]+)\.log$/i);
  if (!m) return null;
  if (/(?:^|\/)\.system_generated\/tasks\/[^/]+\.log$/i.test(normalized)) return { id: m[1], token: normalized };

  const buildBrainMatch = (cand) => {
    const realNorm = resolveRealOrAncestorPath(cand, { cwd }).replace(/\\/g, "/");
    const rm = realNorm.match(/(?:^|\/)tasks\/(?:task-)?([a-zA-Z0-9_-]+)\.log$/i);
    return { id: rm ? rm[1] : m[1], token: normalized, realPath: realNorm };
  };

  const expanded = expandLeadingTilde(clean);
  if (path.isAbsolute(expanded) || /^(?:[A-Za-z]:)?\//.test(expanded.replace(/\\/g, "/"))) {
    return isInsideAntigravityBrainPath(expanded, ctx) ? buildBrainMatch(expanded) : null;
  }
  const cwdResolved = resolveHookPath(expanded, cwd);
  if (cwdResolved && isInsideAntigravityBrainPath(cwdResolved, ctx)) return buildBrainMatch(cwdResolved);

  const bareRelMatch = normalized.match(/^(?:\.\/)?tasks\/([^/]+\.log)$/i);
  if (!bareRelMatch) return null;
  const literalBase = bareRelMatch[1];
  const taskId = m[1];
  if (convId && convId !== "global") {
    for (const bDir of getBrainDirs({ activeTranscriptPath: ctx?.transcriptPath || "" })) {
      if (fs.existsSync(pickTaskFilesInSysDir(path.join(bDir, convId, ".system_generated"), taskId, literalBase).chosenLog)) {
        return { id: taskId, token: normalized };
      }
    }
  }
  if (cwdResolved && fs.existsSync(cwdResolved)) return null;
  return /^task-[a-zA-Z0-9_-]+\.log$/i.test(literalBase) ? { id: taskId, token: normalized } : null;
}

export function extractTaskLogMatches(text, convId = "global", ctx = {}, extraTokens = null) {
  if (!text || typeof text !== "string" || !text.includes(".log")) return [];
  const normalized = text.replace(/\\/g, "/");
  if (!normalized.includes("tasks/")) return [];
  const matches = [];
  const push = (m) => {
    if (!m || matches.some((e) => e.id === m.id && e.token.endsWith(m.token))) return;
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i].id === m.id && m.token.endsWith(matches[i].token)) matches.splice(i, 1);
    }
    matches.push(m);
  };
  if (Array.isArray(extraTokens)) for (const tok of extraTokens) push(matchTaskLogToken(tok, convId, ctx));
  const spanRe = /"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'()=;,\[\]{}]+)/g;
  for (const sm of normalized.matchAll(spanRe)) {
    const cand = sm[1] ?? sm[2] ?? sm[3] ?? "";
    const direct = matchTaskLogToken(cand, convId, ctx);
    if (direct) { push(direct); continue; }
    for (const im of cand.matchAll(/(?:^|[\s"'(=,;\[{])((?:[^\s"'(=,;\[{]*\/)?tasks\/(?:task-)?([a-zA-Z0-9_-]+)\.log)(?=$|[\s"');,\]}])/gi)) {
      push(matchTaskLogToken(im[1], convId, ctx));
    }
  }
  return matches;
}

export function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString("utf-8"), whole: len === size };
  } catch { return null; } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function hasTaskTerminalMarker(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`/${esc}(?:\\\\?" (?:finished|was cancell?ed|cancell?ed\\.)| has already finished)`).test(text);
}

export function scanTaskMarkers(text, taskName) {
  if (hasTaskTerminalMarker(text, taskName)) return "COMPLETED";
  const escapedLaunch = `/${taskName}\\nTask Description: Timer:`;
  const plainLaunch = `/${taskName}\nTask Description: Timer:`;
  const launchMarker = text.includes(escapedLaunch) ? escapedLaunch : (text.includes(plainLaunch) ? plainLaunch : "");
  if (launchMarker) {
    if (text.includes(`/${taskName} priority=`)) return "COMPLETED";
    const launchIdx = text.lastIndexOf(launchMarker);
    if (launchIdx !== -1) {
      const prevTimerIdx = text.lastIndexOf("Task Description: Timer:", Math.max(0, launchIdx - 1));
      const prevLineEnd = prevTimerIdx !== -1 ? text.indexOf("\n", prevTimerIdx) : -1;
      const floorIdx = prevTimerIdx === -1 ? 0 : (prevLineEnd !== -1 && prevLineEnd < launchIdx ? prevLineEnd + 1 : prevTimerIdx + 24);
      const windowSlice = text.slice(Math.max(0, launchIdx - 2500, floorIdx), Math.min(text.length, launchIdx + 600));
      const condMatches = [...windowSlice.matchAll(/TimerCondition[^/\n]{0,80}\/(task-[a-z0-9_-]+)/gi)];
      const condTask = condMatches[condMatches.length - 1]?.[1];
      if (condTask && condTask.toLowerCase() !== taskName.toLowerCase() && hasTaskTerminalMarker(text, condTask)) return "COMPLETED";
    }
  }
  return (text.includes(`/${taskName}\\nTask `) || text.includes(`/${taskName}\nTask `)) ? "RUNNING" : null;
}

export function resolveTaskPaths(match, convId, ctx = {}) {
  const cwd = ctx?.cwd || "";
  const brainDirs = getBrainDirs({ activeTranscriptPath: ctx?.transcriptPath || "" });
  const taskName = `task-${match.id}`;
  const expandedTok = expandLeadingTilde(cleanFileToken(match.token));
  const normExpanded = expandedTok.replace(/\\/g, "/");
  const normRel = normExpanded.replace(/^(?:\.[\/\\])+/g, "");
  const literalBase = /\.log$/i.test(normExpanded) ? path.posix.basename(normExpanded) : "";
  let logPath = null;
  let transcript = null;

  const setFromAbs = (absNorm) => {
    const sysDir = path.posix.dirname(path.posix.dirname(absNorm));
    logPath = absNorm;
    if (path.posix.basename(sysDir) === ".system_generated") transcript = `${sysDir}/logs/transcript.jsonl`;
  };
  if (match.realPath && /^(?:[A-Za-z]:)?\//.test(match.realPath) && path.posix.basename(path.posix.dirname(path.posix.dirname(match.realPath))) === ".system_generated") {
    setFromAbs(match.realPath);
  } else if (/^(?:[A-Za-z]:)?\//.test(normExpanded)) {
    setFromAbs(normExpanded);
  } else {
    const cwdResolved = resolveHookPath(expandedTok, cwd);
    const cwdSysDir = cwdResolved ? path.dirname(path.dirname(cwdResolved)) : "";
    if (cwdResolved && path.basename(cwdSysDir) === ".system_generated" && (fs.existsSync(cwdResolved) || fs.existsSync(path.join(cwdSysDir, "logs", "transcript.jsonl")))) {
      logPath = cwdResolved.replace(/\\/g, "/");
      transcript = path.join(cwdSysDir, "logs", "transcript.jsonl").replace(/\\/g, "/");
    } else {
      const relCross = normRel.match(/^([^/]+)\/\.system_generated\/tasks\/([^/]+\.log)$/i);
      const targetConv = relCross ? relCross[1] : (convId && convId !== "global" ? convId : "");
      if (targetConv) {
        for (const bDir of brainDirs) {
          const { candidateTranscript, chosenLog } = pickTaskFilesInSysDir(path.join(bDir, targetConv, ".system_generated"), taskName, literalBase);
          if (fs.existsSync(candidateTranscript) || fs.existsSync(chosenLog)) { logPath = chosenLog; transcript = candidateTranscript; break; }
        }
        if (!logPath || !transcript) {
          const { candidateTranscript, chosenLog } = pickTaskFilesInSysDir(path.join(getBrainDir({ activeTranscriptPath: ctx?.transcriptPath || "" }), targetConv, ".system_generated"), taskName, literalBase);
          logPath = logPath || chosenLog;
          transcript = transcript || candidateTranscript;
        }
      }
    }
  }
  if (!transcript && convId && convId !== "global" && !/^([^/]+)\/\.system_generated\//i.test(normRel)) {
    for (const bDir of brainDirs) {
      const cand = path.join(bDir, convId, ".system_generated", "logs", "transcript.jsonl");
      if (fs.existsSync(cand)) { transcript = cand; break; }
    }
  }
  return { taskName, logPath, transcript };
}

export function resolveInternalReadStatPaths(candidateTok, convId, ctx = {}, taskMatch = null, isSpillover = false) {
  const cwd = ctx?.cwd || "";
  const cleanTok = cleanFileToken(candidateTok);
  const expandedTok = expandLeadingTilde(cleanTok);
  const normalizedTok = expandedTok.replace(/\\/g, "/");
  const normRel = normalizedTok.replace(/^(?:\.[\/\\])+/g, "");
  const results = [resolveHookPath(expandedTok, cwd)].filter(Boolean);
  if (!path.isAbsolute(expandedTok) && !/^(?:[A-Za-z]:)?\//.test(normalizedTok)) {
    const brainDirs = getBrainDirs({ activeTranscriptPath: ctx?.transcriptPath || "" });
    if (/^[^/]+\/\.system_generated\//i.test(normRel)) for (const bDir of brainDirs) results.push(path.join(bDir, normRel));
    if (convId && convId !== "global") {
      const tokMatch = (taskMatch && cleanTok.replace(/\\/g, "/") === cleanFileToken(taskMatch.token).replace(/\\/g, "/") ? taskMatch : null) || matchTaskLogToken(expandedTok, convId, ctx);
      if (tokMatch) {
        const resolved = resolveTaskPaths(tokMatch, convId, ctx);
        if (resolved.logPath) results.push(resolved.logPath);
        const baseLog = /\.log$/i.test(normalizedTok) ? path.posix.basename(normalizedTok) : "";
        if (baseLog) for (const bDir of brainDirs) results.push(path.join(bDir, convId, ".system_generated", "tasks", baseLog));
      }
      const spillMatch = isSpillover && isStepSpilloverPath(normalizedTok) && normalizedTok.match(/(?:^|\/)(\.system_generated\/steps\/\d+\/output\.txt)$/i);
      if (spillMatch) for (const bDir of brainDirs) results.push(path.join(bDir, convId, spillMatch[1]));
    }
  }
  return [...new Set(results)];
}

export function isOversizedInternalTarget(target, convId, ctx = {}, taskMatch = null, isSpillover = false) {
  for (const p of resolveInternalReadStatPaths(target, convId, ctx, taskMatch, isSpillover)) {
    try { const st = fs.statSync(p); if (st.isFile()) return st.size > MAX_FULL_FILE_BYTES; } catch {}
  }
  return false;
}

export function getTaskState(match, convId, ctx = {}) {
  const { taskName, logPath, transcript } = resolveTaskPaths(match, convId, ctx);
  if (transcript) {
    const tail = readTail(transcript, TASK_TAIL_BYTES);
    if (tail) {
      let state = scanTaskMarkers(tail.text, taskName);
      if (!state && !tail.whole) { try { state = scanTaskMarkers(fs.readFileSync(transcript, "utf-8"), taskName); } catch {} }
      if (state) return state;
    }
  }
  if (logPath) { try { return (Date.now() - fs.statSync(logPath).mtimeMs) > TASK_QUIET_MS ? "COMPLETED" : "RUNNING"; } catch {} }
  return "UNKNOWN";
}

function buildInternalStateDenial(kindLabel) {
  return (
    `Antigravity Execution Governance: Direct ${kindLabel} to internal Antigravity execution state (.system_generated and governance state) is strictly prohibited to prevent polling loops and context blowouts.\n` +
    "- Conversation transcripts (.system_generated/logs/transcript.jsonl) can be read directly with bounded read_file slices, grep_search, or read-only shell commands.\n" +
    "- To inspect background tasks: Pure Yield (end turn; no 'schedule'/status card; await <SYSTEM_MESSAGE>). Do not read internal task logs."
  );
}

export const buildInternalStateShellDenial = (convId = "global", ctx = {}) => buildInternalStateDenial("shell access");
export const buildInternalStateToolDenial = (convId = "global", ctx = {}) => buildInternalStateDenial("access");
