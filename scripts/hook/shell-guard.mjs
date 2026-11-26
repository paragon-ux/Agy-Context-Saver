/**
 * Section 1 PreToolUse Guard (`run_command`):
 * - Clean quote- & heredoc-aware shell parser (parsed once per call)
 * - Concise LH-09-B governance & benchmark mutation checks
 * - Blocking CI watch loop guard (`gh pr checks --watch`, `gh run watch`)
 * - Narrow High-ROI RTK Pre-Gate (`AGY_RTK_MODE=pregate|off`, lossless `rg`/`grep`)
 * - Unchained `rtk read` / degraded bounded `head -n 150`/`tail -n 150` spillover & task-log parity
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getEffectiveMode } from "../../lib/transcript-policy.mjs";
import { mintHookIdentity } from "../../lib/hook-identity.mjs";
import { getStateDir } from "../state-dir.mjs";
import { quoteForCmd } from "../rtk-run.mjs";
import { isCompatibleRtkVersion } from "../provision-rtk.mjs";
import { getProfileHomeDir, getBrainDirs, tryRealpath, resolveRealOrAncestorPath, isContainedInAnyBrainDir, isContainedInDir } from "../../lib/path-guards.mjs";
import {
  HOOK_REPO_ROOT, MAX_SPILLOVER_SLICE_LINES, MAX_FULL_FILE_BYTES, respond, ensureStateDir,
  writeAtomicJson, updateSessionState, resolveHookPath, expandLeadingTilde, expandAndResolvePathVariants,
  cleanFileToken, isProtectedInternalState, isProtectedGovernanceFileMutationPath, isUserEditableGeminiConfigPath, isProtectedGovernanceDirPath,
  isProtectedBenchmarkFilePath, isBenchmarkGuardDisabled, isStepSpilloverPath, stripTranscriptLogRefs, isReadOnlyTranscriptVerb,
  isExecutableScriptPath, matchTaskLogToken, extractTaskLogMatches, resolveInternalReadStatPaths, getTaskState,
  buildInternalStateShellDenial
} from "./common.mjs";

// ============================================================================
// Host Environment & Local RTK / CLI Shim Resolution (Simplified env-cache)
// ============================================================================

const ENV_CACHE_TTL_MS = 60000;
let cachedRtkKey = null;
let cachedRtkValue = undefined;

function findExecutableOnPath(baseName) {
  const pathEnv = process.env.PATH || process.env.Path || "";
  const isWin = os.platform() === "win32";
  const exts = isWin ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${baseName}${ext}`);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (!isWin) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return "";
}

function getLocalRtkCandidate() {
  const names = os.platform() === "win32" ? ["rtk.exe", "rtk.cmd"] : ["rtk"];
  for (const exeName of names) {
    const p = path.join(getProfileHomeDir(), ".gemini", "config", "plugins", "agy-context-saver", "bin", exeName);
    if (fs.existsSync(p)) return p;
  }
  if (!process.env.AGY_TEST_PROFILE_DIR) {
    for (const exeName of names) {
      const p = path.join(HOOK_REPO_ROOT, "bin", exeName);
      if (fs.existsSync(p)) return p;
    }
  }
  return "";
}

function getTrustedLocalRtkLauncherCandidates() {
  return [...new Set([
    path.join(getProfileHomeDir(), ".gemini", "config", "plugins", "agy-context-saver", "scripts", "rtk-run.mjs"),
    path.join(HOOK_REPO_ROOT, "scripts", "rtk-run.mjs")
  ])];
}

function isTrustedLocalRtkLauncherPath(candidatePath) {
  if (!candidatePath || typeof candidatePath !== "string") return false;
  const clean = cleanFileToken(candidatePath);
  if (!/(?:^|[\\/])rtk-run\.mjs$/i.test(clean)) return false;
  const isCI = os.platform() === "win32" || os.platform() === "darwin";
  const norm = (p) => { const s = tryRealpath(path.resolve(p)).replace(/\\/g, "/"); return isCI ? s.toLowerCase() : s; };
  const target = norm(clean);
  return getTrustedLocalRtkLauncherCandidates().some((t) => norm(t) === target);
}

function resolveLocalRtkLauncher(localCandidate = "") {
  const cands = localCandidate
    ? [path.resolve(path.dirname(localCandidate), "..", "scripts", "rtk-run.mjs"), ...getTrustedLocalRtkLauncherCandidates()]
    : getTrustedLocalRtkLauncherCandidates();
  for (const c of cands) {
    try { if (fs.statSync(c).isFile() && isTrustedLocalRtkLauncherPath(c)) return c; } catch {}
  }
  return "";
}

function resolveInstalledAgyContextCommand(binName = "agy-context") {
  const profileHome = getProfileHomeDir();
  const isWin = os.platform() === "win32";
  const pluginCli = path.join(profileHome, ".gemini", "config", "plugins", "agy-context-saver", "bin", "agy-context.mjs");
  const nodeCli = () => { try { return fs.statSync(pluginCli).isFile() ? `node "${pluginCli.replace(/\\/g, "/")}"` : ""; } catch { return ""; } };
  if (isWin) { const c = nodeCli(); if (c) return c; }
  const names = binName === "agy-context-saver" ? ["agy-context-saver", "agy-context"] : ["agy-context", "agy-context-saver"];
  for (const name of names) {
    const shim = path.join(profileHome, ".gemini", "antigravity", "bin", isWin ? `${name}.cmd` : name);
    try {
      if (!fs.statSync(shim).isFile()) continue;
      if (!isWin) fs.accessSync(shim, fs.constants.X_OK);
      const fmt = isWin ? shim : shim.replace(/\\/g, "/");
      return /\s/.test(fmt) ? `"${fmt}"` : fmt;
    } catch {}
  }
  return isWin ? "" : nodeCli();
}

function spawnRtk(bin, args, opts = {}) {
  if (!bin) return { error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }), status: null, stdout: "", stderr: "" };
  const baseEnv = opts.env || process.env;
  const mergedEnv = { ...baseEnv, RTK_SUPPRESS_HOOK_WARNING: baseEnv.RTK_SUPPRESS_HOOK_WARNING ?? "1" };
  const spawnOpts = { ...opts, env: mergedEnv };
  if (os.platform() === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    const comspec = mergedEnv.ComSpec || mergedEnv.COMSPEC || path.join(mergedEnv.SystemRoot || mergedEnv.windir || "C:\\Windows", "System32", "cmd.exe");
    const quotedBin = /[\s&|<>^()%!]/.test(bin) ? `"${bin}"` : bin;
    const quotedArgs = args.map(quoteForCmd).join(" ");
    const cmdLine = quotedArgs ? `"${quotedBin} ${quotedArgs}"` : `"${quotedBin}"`;
    return spawnSync(comspec, ["/d", "/s", "/c", cmdLine], { ...spawnOpts, windowsVerbatimArguments: true });
  }
  return spawnSync(bin, args, spawnOpts);
}

const getFileMtimeMsSafe = (p) => { if (!p) return 0; try { return Math.trunc(fs.statSync(p).mtimeMs); } catch { return 0; } };

function extractRtkSemver(versionStr) {
  const match = String(versionStr || "").match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : "";
}

function isRtkVersionBelow(versionStr, targetMajor, targetMinor) {
  const match = String(versionStr || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return true;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  return major < targetMajor || (major === targetMajor && minor < targetMinor);
}

export function resolveCachedHostEnv() {
  const pathEnv = process.env.PATH || process.env.Path || "";
  const localCandidate = getLocalRtkCandidate();
  const winLauncher = os.platform() === "win32" ? resolveLocalRtkLauncher(localCandidate) : "";
  const cacheFile = path.join(getStateDir(), "env-cache.json");
  let parsed = null;
  try {
    if (fs.existsSync(cacheFile)) {
      const p = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      if (p && typeof p.ts === "number" && (Date.now() - p.ts) < ENV_CACHE_TTL_MS) parsed = p;
    }
  } catch {}

  const hasValidCachedResolved = (v) => v === null || (Boolean(v) && typeof v.version === "string");
  if (parsed && parsed.pathEnv === pathEnv && parsed.localCandidate === localCandidate && (parsed.winLauncher || "") === winLauncher && typeof parsed.pathCandidate === "string") {
    const fastKey = `${parsed.pathCandidate}::${localCandidate}::${getFileMtimeMsSafe(parsed.pathCandidate)}::${getFileMtimeMsSafe(localCandidate)}::${winLauncher}`;
    if (parsed.key === fastKey && hasValidCachedResolved(parsed.resolved ?? null)) { cachedRtkKey = fastKey; cachedRtkValue = parsed.resolved ?? null; return { rtk: cachedRtkValue }; }
  }

  const pathCandidate = findExecutableOnPath("rtk");
  const key = `${pathCandidate}::${localCandidate}::${getFileMtimeMsSafe(pathCandidate)}::${getFileMtimeMsSafe(localCandidate)}::${winLauncher}`;
  if (cachedRtkKey === key && cachedRtkValue !== undefined) return { rtk: cachedRtkValue };
  if (parsed && parsed.key === key && typeof parsed.pathEnv !== "string" && hasValidCachedResolved(parsed.resolved ?? null)) { cachedRtkKey = key; cachedRtkValue = parsed.resolved ?? null; return { rtk: cachedRtkValue }; }

  const opts = { encoding: "utf-8", timeout: 2000, windowsHide: true };
  let resolved = null;
  if (pathCandidate) {
    const r = spawnRtk(pathCandidate, ["--version"], opts);
    if (!r.error && r.status === 0 && isCompatibleRtkVersion(r.stdout)) {
      resolved = { exe: pathCandidate, prefix: "rtk", version: extractRtkSemver(r.stdout) };
    }
  }
  if (!resolved && localCandidate) {
    const r = spawnRtk(localCandidate, ["--version"], opts);
    if (!r.error && r.status === 0 && isCompatibleRtkVersion(r.stdout)) {
      const normLocal = localCandidate.replace(/\\/g, "/");
      const prefix = os.platform() === "win32" && winLauncher
        ? `node "${winLauncher.replace(/\\/g, "/")}"`
        : (/\s/.test(normLocal) ? `"${normLocal}"` : normLocal);
      resolved = { exe: localCandidate, prefix, version: extractRtkSemver(r.stdout) };
    }
  }

  cachedRtkKey = key;
  cachedRtkValue = resolved;
  try {
    ensureStateDir();
    writeAtomicJson(cacheFile, JSON.stringify({ key, ts: Date.now(), pathEnv, localCandidate, pathCandidate, winLauncher, resolved }));
  } catch {}
  return { rtk: resolved };
}

// ============================================================================
// Quote- & Heredoc-Aware Shell Segment Parser & Tokenizer
// ============================================================================

const SHELL_ESCAPE_CHARS = new Set([" ", "\t", "\n", "\r", ";", "|", "&", "<", ">", "(", ")", '"', "'", "\\", "$", "`"]);
const REDIRECT_CLOSE_FD_REGEX = /^(?:\d+)?(?:<&|>&)-$/;
const REDIRECT_OP_REGEX = /^(?:&>>?|(?:\d+)?(?:>>?|<<<?|<<-|<|<&|>&|>\||<>))$/;
const REDIRECT_ATTACHED_REGEX = /^(?:&>>?|(?:\d+)?(?:>>?|<<<?|<<-|<|<&|>&|>\||<>))(.+)$/;
const ENV_VALUE_FLAGS = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);
const SHELL_CONTROL_KEYWORDS = new Set(["{", "!", "if", "then", "elif", "else", "do", "while", "until", "time", "&"]);
const SUDO_VALUE_FLAGS = new Set(["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "--user", "--group", "--host"]);
const SIMPLE_WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "time"]);
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "eval"]);
const CODE_INTERPRETERS = new Set(["python", "python2", "python3", "node", "perl", "ruby", "php", "pwsh", "powershell"]);

const normalizeCmdName = (tok) => path.basename(String(tok || "").replace(/\\/g, "/")).toLowerCase().replace(/\.(exe|cmd|bat|mjs|cjs|js)$/i, "");
const hasDotDotTraversal = (s) => Boolean(s && typeof s === "string" && /(?:^|[\/\\])\.\.(?:$|[\/\\])/.test(s));
const isUnquotedRedir = (t) => Boolean(t && !t.quoted && (REDIRECT_CLOSE_FD_REGEX.test(t.raw) || REDIRECT_OP_REGEX.test(t.raw) || REDIRECT_ATTACHED_REGEX.test(t.raw)));

function parseHeredocTag(cmd, pos) {
  let i = pos + 2;
  const stripTabs = cmd[i] === "-";
  if (stripTabs) i++;
  while (i < cmd.length && (cmd[i] === " " || cmd[i] === "\t")) i++;
  if (i >= cmd.length) return null;
  let delim = "";
  const ch = cmd[i];
  if (ch === "'" || ch === '"') {
    i++;
    while (i < cmd.length && cmd[i] !== ch && cmd[i] !== "\n" && cmd[i] !== "\r") {
      if (ch === '"' && cmd[i] === "\\" && i + 1 < cmd.length) i++;
      delim += cmd[i++];
    }
    if (cmd[i] === ch) i++;
  } else {
    while (i < cmd.length && !/[\s;|&<>()"']/.test(cmd[i])) {
      if (cmd[i] === "\\" && i + 1 < cmd.length) i++;
      delim += cmd[i++];
    }
  }
  return delim ? { delim, stripTabs, endIndex: i } : null;
}

function readBalancedSubshell(cmd, startPos) {
  let i = startPos;
  let depth = 1;
  let inSingle = false;
  let inDouble = false;
  while (i < cmd.length && depth > 0) {
    const c = cmd[i];
    if (inSingle) { if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) {
      if (c === "\\" && i + 1 < cmd.length) { i += 2; continue; }
      if (c === '"') inDouble = false;
      else if (c === "$" && cmd[i + 1] === "(") { depth++; i += 2; continue; }
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length && SHELL_ESCAPE_CHARS.has(cmd[i + 1])) { i += 2; continue; }
    if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    i++;
  }
  return { inner: cmd.slice(startPos, depth === 0 ? i - 1 : i), nextIndex: i };
}

function readBacktickSubshell(cmd, startPos) {
  let i = startPos;
  let inner = "";
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "\\" && i + 1 < cmd.length) { inner += cmd[i + 1]; i += 2; continue; }
    if (c === "`") return { inner, nextIndex: i + 1 };
    inner += c;
    i++;
  }
  return { inner, nextIndex: i };
}

export function splitShellSegments(command) {
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
  let firstHdIdx = -1;

  const pushSeg = (endOffset) => {
    const raw = command.slice(segStart, endOffset);
    const trimmed = raw.trim();
    if (trimmed || hasHeredoc) {
      const leadWS = raw.length - raw.trimStart().length;
      const trailWS = raw.length - raw.trimEnd().length;
      segments.push({
        text: trimmed, raw, start: segStart + leadWS, end: Math.max(segStart + leadWS, endOffset - trailWS),
        leadingSep, hasRedirect, hasWriteRedirect, hasHeredoc, heredocBodies, hasSubshell, subshells, _tokens: null
      });
      if (hasHeredoc && firstHdIdx === -1) firstHdIdx = segments.length - 1;
    }
    leadingSep = ""; hasRedirect = false; hasWriteRedirect = false; hasHeredoc = false; hasSubshell = false;
    subshells = []; heredocBodies = [];
  };

  for (let i = 0; i < command.length;) {
    const c = command[i];
    const next = command[i + 1];
    if (inSingle) { if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) {
      if (c === "\\" && i + 1 < command.length) { i += 2; continue; }
      if (c === '"') { inDouble = false; i++; }
      else if (c === "$" && next === "(") { hasSubshell = true; const s = readBalancedSubshell(command, i + 2); subshells.push(s.inner); i = s.nextIndex; }
      else if (c === "`") { hasSubshell = true; const s = readBacktickSubshell(command, i + 1); subshells.push(s.inner); i = s.nextIndex; }
      else i++;
      continue;
    }
    if (c === "\\") { i += (next === "\r" && command[i + 2] === "\n") ? 3 : (next !== undefined && SHELL_ESCAPE_CHARS.has(next) ? 2 : 1); continue; }
    if (c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = true; i++; continue; }
    if (c === "#" && (i === 0 || /\s/.test(command[i - 1]))) { while (i < command.length && command[i] !== "\n") i++; continue; }
    if ((c === "$" || c === "<" || c === ">") && next === "(") {
      hasSubshell = true; if (c !== "$") hasRedirect = true;
      const s = readBalancedSubshell(command, i + 2); subshells.push(s.inner); i = s.nextIndex; continue;
    }
    if (c === "(") { hasSubshell = true; const s = readBalancedSubshell(command, i + 1); subshells.push(s.inner); i = s.nextIndex; continue; }
    if (c === "`") { hasSubshell = true; const s = readBacktickSubshell(command, i + 1); subshells.push(s.inner); i = s.nextIndex; continue; }
    if (c === "<") {
      if (next === "<" && command[i + 2] !== "<") {
        const tag = parseHeredocTag(command, i);
        if (tag) { hasHeredoc = true; pendingHeredocs.push(tag); i = tag.endIndex; continue; }
      }
      hasRedirect = true; i += next === "<" ? (command[i + 2] === "<" ? 3 : 2) : 1; continue;
    }
    if (c === ">") { hasRedirect = true; hasWriteRedirect = true; i += (next === ">" || next === "|") ? 2 : 1; continue; }
    if (c === "\n" || (c === "\r" && next === "\n")) {
      pushSeg(i);
      i += c === "\r" ? 2 : 1;
      if (pendingHeredocs.length > 0) {
        const tIdx = firstHdIdx !== -1 ? firstHdIdx : segments.length - 1;
        while (pendingHeredocs.length > 0) {
          const hd = pendingHeredocs.shift();
          const lines = [];
          while (i < command.length) {
            const nl = command.indexOf("\n", i);
            const rawLine = command.slice(i, nl === -1 ? command.length : nl).replace(/\r$/, "");
            i = nl === -1 ? command.length : nl + 1;
            if ((hd.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine) === hd.delim) break;
            lines.push(rawLine);
          }
          if (tIdx >= 0 && segments[tIdx]) segments[tIdx].heredocBodies.push(lines.join("\n"));
        }
        firstHdIdx = -1;
      }
      segStart = i; leadingSep = "\n"; continue;
    }
    if ((c === "&" && next === "&") || (c === "|" && (next === "|" || next === "&"))) {
      pushSeg(i); i += 2; segStart = i; leadingSep = c + next; continue;
    }
    if (c === "|" || c === ";") { pushSeg(i); i += 1; segStart = i; leadingSep = c; continue; }
    if (c === "&") {
      if (i > 0 && (command[i - 1] === ">" || command[i - 1] === "<")) { hasRedirect = true; i++; continue; }
      if (next === ">") { hasRedirect = true; hasWriteRedirect = true; i += 2; continue; }
      pushSeg(i); i += 1; segStart = i; leadingSep = "&"; continue;
    }
    i++;
  }
  pushSeg(command.length);
  return segments;
}

export function tokenizeShellWordsDetailed(text, { collapseSubshellGroups = false } = {}) {
  const tokens = [];
  for (let i = 0; i < text.length;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const start = i;
    if (collapseSubshellGroups && text[i] === "(") {
      const sub = readBalancedSubshell(text, i + 1);
      const closed = sub.nextIndex > i + 1 && text[sub.nextIndex - 1] === ")";
      tokens.push({
        raw: text.slice(start, sub.nextIndex),
        value: "()",
        quoted: false,
        isSubshellGroup: true,
        unclosedSubshell: !closed,
        globPositions: [],
        hasUnquotedGlob: false,
        start,
        end: sub.nextIndex
      });
      i = sub.nextIndex;
      continue;
    }
    let value = "";
    let quoted = false;
    const globPositions = [];
    while (i < text.length && !/\s/.test(text[i])) {
      const c = text[i];
      if (c === ">" || c === "<") {
        if (i > start) {
          const pre = text.slice(start, i);
          if (quoted || !(/^\d+$/.test(pre) || (c === ">" && pre === "&"))) break;
        }
        i++;
        if (i < text.length && (text[i] === c || text[i] === "&" || (c === ">" && text[i] === "|") || (c === "<" && text[i] === ">"))) {
          const second = text[i++];
          if (i < text.length) {
            if (c === "<" && second === "<" && (text[i] === "<" || text[i] === "-")) i++;
            else if (second === "&" && text[i] === "-") i++;
          }
        }
        value = text.slice(start, i);
        globPositions.length = 0;
        break;
      } else if (c === "&" && text[i + 1] === ">" && i === start) {
        i += text[i + 2] === ">" ? 3 : 2;
        value = text.slice(start, i);
        globPositions.length = 0;
        break;
      } else if (c === "'") {
        quoted = true; i++;
        while (i < text.length && text[i] !== "'") value += text[i++];
        if (text[i] === "'") i++;
      } else if (c === '"') {
        quoted = true; i++;
        while (i < text.length && text[i] !== '"') {
          if (text[i] === "\\" && ['"', "\\", "$", "`"].includes(text[i + 1])) { value += text[i + 1]; i += 2; }
          else value += text[i++];
        }
        if (text[i] === '"') i++;
      } else if (c === "\\" && i + 1 < text.length && (SHELL_ESCAPE_CHARS.has(text[i + 1]) || /[*?\[]/.test(text[i + 1]))) {
        value += text[i + 1]; i += 2;
      } else {
        if (/[*?\[]/.test(c)) globPositions.push(value.length);
        value += c;
        i++;
      }
    }
    tokens.push({ raw: text.slice(start, i), value, quoted, globPositions, hasUnquotedGlob: globPositions.length > 0, start, end: i });
  }
  return tokens;
}

const getSegTokens = (seg) => (seg._tokens ||= tokenizeShellWordsDetailed(seg.text || "", { collapseSubshellGroups: Boolean(seg.hasSubshell) }));
const tokenizeShellWords = (text) => tokenizeShellWordsDetailed(text).map((t) => t.value);

function skipSingleRedirect(tokens, idx) {
  const tok = tokens[idx];
  if (!tok || tok.quoted) return null;
  if (REDIRECT_CLOSE_FD_REGEX.test(tok.raw)) return { nextIdx: idx + 1, missingTarget: false };
  if (REDIRECT_OP_REGEX.test(tok.raw)) return (idx + 1 >= tokens.length || isUnquotedRedir(tokens[idx + 1])) ? { nextIdx: tokens.length, missingTarget: true } : { nextIdx: idx + 2, missingTarget: false };
  return REDIRECT_ATTACHED_REGEX.test(tok.raw) ? { nextIdx: idx + 1, missingTarget: false } : null;
}

function hasMalformedRedirects(tokens) {
  for (let i = 0; i < tokens.length; i++) { const r = skipSingleRedirect(tokens, i); if (r) { if (r.missingTarget) return true; i = r.nextIdx - 1; } }
  return false;
}

function nextNonRedirectIndex(tokens, fromIdx, endIdx) {
  for (let idx = fromIdx; idx < endIdx;) {
    const r = skipSingleRedirect(tokens, idx);
    if (!r) return { idx, missingRedirect: false };
    if (r.missingTarget) return { idx: endIdx, missingRedirect: true };
    idx = r.nextIdx;
  }
  return { idx: endIdx, missingRedirect: false };
}

function skipEnvTokens(tokens, startIdx = 0) {
  let idx = startIdx;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.raw)) { idx++; continue; }
    if (normalizeCmdName(tok.value) !== "env") break;
    for (idx++; idx < tokens.length;) {
      const r = skipSingleRedirect(tokens, idx);
      if (r) { idx = r.nextIdx; continue; }
      const sub = tokens[idx];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(sub.raw)) { idx++; continue; }
      if (sub.value === "--") { idx++; break; }
      if (sub.value.startsWith("-") && sub.value !== "-") { idx += ENV_VALUE_FLAGS.has(sub.value) && idx + 1 < tokens.length ? 2 : 1; continue; }
      break;
    }
  }
  return idx;
}

function splitEnvPrefix(text, preTokens = null) {
  const tokens = preTokens || tokenizeShellWordsDetailed(text), idx = skipEnvTokens(tokens, 0);
  return idx === 0 ? { prefix: "", body: text } : (idx >= tokens.length ? { prefix: text, body: "" } : { prefix: text.slice(0, tokens[idx].start), body: text.slice(tokens[idx].start) });
}

function stripLeadingShellPrefixes(tokens, startIdx = 0, { includeControlKeywords = true } = {}) {
  let idx = startIdx;
  for (let guard = 0; idx < tokens.length && guard++ < 32;) {
    const redir = skipSingleRedirect(tokens, idx);
    if (redir) { idx = redir.nextIdx; continue; }
    const nextEnv = skipEnvTokens(tokens, idx);
    if (nextEnv !== idx) { idx = nextEnv; continue; }
    const rawKw = tokens[idx].value.toLowerCase();
    if (!tokens[idx].quoted && (includeControlKeywords ? SHELL_CONTROL_KEYWORDS.has(rawKw) : (rawKw === "!" || rawKw === "time" || (idx === 0 && rawKw === "&")))) { idx++; continue; }
    const cmd = normalizeCmdName(tokens[idx].value);
    if (cmd === "sudo" || cmd === "doas" || cmd === "timeout" || cmd === "nice") {
      const valFlags = (cmd === "sudo" || cmd === "doas") ? SUDO_VALUE_FLAGS : (cmd === "timeout" ? new Set(["-k", "-s", "--kill-after", "--signal"]) : new Set(["-n", "--adjustment"]));
      for (idx++; idx < tokens.length;) {
        const r = skipSingleRedirect(tokens, idx);
        if (r) { idx = r.nextIdx; continue; }
        const fl = tokens[idx].value;
        if (fl === "--") { idx++; break; }
        if (!fl.startsWith("-") || fl === "-") break;
        idx += valFlags.has(fl) && idx + 1 < tokens.length ? 2 : 1;
      }
      if (cmd === "timeout" && idx < tokens.length && !skipSingleRedirect(tokens, idx)) idx++;
      continue;
    }
    if (cmd === "command") {
      let probe = idx + 1, queryOnly = false;
      while (probe < tokens.length) {
        const r = skipSingleRedirect(tokens, probe);
        if (r) { probe = r.nextIdx; continue; }
        const fl = tokens[probe].value;
        if (fl === "--") { probe++; break; }
        if (!fl.startsWith("-") || fl === "-") break;
        if ((/^-[pPvV]+$/.test(fl) && /[vV]/.test(fl)) || fl !== "-p") queryOnly = true;
        probe++;
      }
      if (queryOnly) break;
      idx = probe; continue;
    }
    if (!SIMPLE_WRAPPERS.has(cmd)) break;
    for (idx++; idx < tokens.length;) {
      const r = skipSingleRedirect(tokens, idx);
      if (r) { idx = r.nextIdx; continue; }
      if (!tokens[idx].value.startsWith("-") || tokens[idx].value === "-") break;
      if (tokens[idx++].value === "--") break;
    }
  }
  return idx;
}

function onlyRedirectsRemain(tokens, fromIdx) {
  for (let c = fromIdx; c < tokens.length;) { const r = skipSingleRedirect(tokens, c); if (!r || r.missingTarget) return false; c = r.nextIdx; }
  return true;
}

function extractWrapperLocalCwd(tokens, startPos, cmdIdx) {
  let localCwd = null;
  for (let i = startPos; i < cmdIdx; i++) {
    const r = skipSingleRedirect(tokens, i);
    if (r) { i = r.nextIdx - 1; continue; }
    if (normalizeCmdName(tokens[i].value) !== "env") continue;
    for (let j = i + 1; j < cmdIdx; j++) {
      const r2 = skipSingleRedirect(tokens, j);
      if (r2) { j = r2.nextIdx - 1; continue; }
      const v = tokens[j].value;
      if (v === "--") break;
      if ((v === "-C" || v === "--chdir") && j + 1 < cmdIdx) localCwd = tokens[++j].value;
      else if (v.startsWith("--chdir=")) localCwd = v.slice(8);
      else if (!v.startsWith("--") && /^-[^-]*C.+$/.test(v)) localCwd = v.slice(v.indexOf("C") + 1);
      else if ((v === "-u" || v === "--unset" || v === "-S" || v === "--split-string") && j + 1 < cmdIdx) j++;
      else if (!v.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[j].raw)) break;
    }
  }
  return localCwd;
}

const FIND_NON_PATH_VAL = new Set("-name -iname -path -ipath -wholename -iwholename -lname -ilname -regex -iregex -regextype -type -xtype -perm -user -group -uid -gid -size -links -inum -mindepth -maxdepth -mtime -atime -ctime -mmin -amin -cmin -printf -used -fstype -context".split(" "));
const FIND_FILE_VAL = new Set(["-newer", "-anewer", "-cnewer", "-samefile", "-files0-from", "-fprint", "-fprint0", "-fls"]);
const FIND_WRITE_VAL = new Set(["-fprint", "-fprint0", "-fls", "-fprintf"]);
const FIND_NO_ARG = new Set("-print -print0 -ls -delete -prune -quit -empty -executable -readable -writable -true -false -depth -d -mount -xdev -daystart -follow -noleaf -warn -nowarn -ignore_readdir_race -noignore_readdir_race ( ) ! -not -a -and -o -or ,".split(" "));

function scanFindCommand(tokens, cmdIdx, endIdx, depth = 0) {
  const starts = [], pathItems = [], startPoints = [], writeTargets = [];
  let uncertain = depth > 4, mutates = false, i = cmdIdx + 1;
  while (i < endIdx) {
    const r = skipSingleRedirect(tokens, i);
    if (r) { if (r.missingTarget) uncertain = true; i = r.nextIdx; continue; }
    const tok = tokens[i], v = tok.value;
    if (v === "-H" || v === "-L" || v === "-P" || /^-O\d*$/.test(v)) { i++; continue; }
    if (v === "-D") { const nx = nextNonRedirectIndex(tokens, i + 1, endIdx); if (nx.missingRedirect || nx.idx >= endIdx) { uncertain = true; i = endIdx; break; } i = nx.idx + 1; continue; }
    if (v.startsWith("-") || v === "(" || v === "!" || v === ",") break;
    pathItems.push({ value: v, globPositions: tok.globPositions, isOperand: true });
    startPoints.push(v); i++;
  }
  while (i < endIdx) {
    const r = skipSingleRedirect(tokens, i);
    if (r) { if (r.missingTarget) uncertain = true; i = r.nextIdx; continue; }
    const tok = tokens[i], v = tok.value;
    if (v === "-delete") mutates = true;
    if (!tok.quoted && ["-exec", "-execdir", "-ok", "-okdir"].includes(v)) {
      let termIdx = i + 1;
      while (termIdx < endIdx) {
        const rt = skipSingleRedirect(tokens, termIdx);
        if (rt) { termIdx = rt.nextIdx; continue; }
        if (!tokens[termIdx].quoted && (tokens[termIdx].value === ";" || (tokens[termIdx].value === "+" && termIdx > i + 1 && tokens[termIdx - 1]?.value === "{}"))) break;
        termIdx++;
      }
      if (i + 1 >= endIdx || termIdx === i + 1 || termIdx >= endIdx) { uncertain = true; break; }
      const subCmdIdx = stripLeadingShellPrefixes(tokens, i + 1, { includeControlKeywords: false });
      starts.push({ startPos: i + 1, cmdIdx: subCmdIdx, endIdx: termIdx });
      if (subCmdIdx < termIdx) {
        const execVerb = normalizeCmdName(tokens[subCmdIdx].value);
        if (OBVIOUS_MUTATION_VERBS.has(execVerb) || SHELL_INTERPRETERS.has(execVerb) || CODE_INTERPRETERS.has(execVerb)) mutates = true;
        if (execVerb === "find" && depth < 4) { const n = scanFindCommand(tokens, subCmdIdx, termIdx, depth + 1); starts.push(...n.starts); if (n.uncertain) uncertain = true; }
      }
      i = termIdx + 1; continue;
    }
    if (FIND_NON_PATH_VAL.has(v)) { const nx = nextNonRedirectIndex(tokens, i + 1, endIdx); if (nx.missingRedirect || nx.idx >= endIdx) { uncertain = true; break; } i = nx.idx + 1; continue; }
    if (FIND_FILE_VAL.has(v) || /^-(?:newer[aBcmMt]{2})$/.test(v)) {
      const nx = nextNonRedirectIndex(tokens, i + 1, endIdx);
      if (nx.missingRedirect || nx.idx >= endIdx) { uncertain = true; break; }
      const vt = tokens[nx.idx];
      if (!/^-(?:newer[aBcmMt]t)$/.test(v)) pathItems.push({ value: vt.value, globPositions: vt.globPositions, isOperand: true });
      if (FIND_WRITE_VAL.has(v)) writeTargets.push(vt.value);
      i = nx.idx + 1; continue;
    }
    if (v === "-fprintf") {
      const nf = nextNonRedirectIndex(tokens, i + 1, endIdx);
      const nfmt = nf.idx < endIdx ? nextNonRedirectIndex(tokens, nf.idx + 1, endIdx) : { idx: endIdx, missingRedirect: true };
      if (nf.missingRedirect || nf.idx >= endIdx || nfmt.missingRedirect || nfmt.idx >= endIdx) { uncertain = true; break; }
      pathItems.push({ value: tokens[nf.idx].value, globPositions: tokens[nf.idx].globPositions, isOperand: true });
      writeTargets.push(tokens[nf.idx].value);
      i = nfmt.idx + 1; continue;
    }
    if (FIND_NO_ARG.has(v)) { i++; continue; }
    uncertain = true; pathItems.push({ value: v, globPositions: tok.globPositions, isOperand: !v.startsWith("-") }); i++;
  }
  return { starts, pathItems, startPoints, writeTargets, mutates, implicitCwd: uncertain || startPoints.length === 0, uncertain };
}

function analyzeSegmentCommandStarts(segments, { allowPartialCompound = false } = {}) {
  const state = { ifDepth: 0, loopDepth: 0, braceDepth: 0, awaitingThen: false, awaitingDo: false };
  const perSegment = [];
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const tokens = getSegTokens(segments[segIdx]), starts = [], forWordTokens = [];
    let uncertainSyntax = hasMalformedRedirects(tokens), cursor = 0, terminal = false;
    const inCompoundBefore = state.ifDepth > 0 || state.loopDepth > 0;
    for (let guard = 0; cursor < tokens.length && guard++ < 24;) {
      const redir = skipSingleRedirect(tokens, cursor);
      if (redir) { cursor = redir.nextIdx; continue; }
      const tok = tokens[cursor];
      if (tok.isSubshellGroup) { if (tok.unclosedSubshell || !onlyRedirectsRemain(tokens, cursor + 1)) uncertainSyntax = true; terminal = true; break; }
      if (tok.quoted) break;
      const kw = tok.value.toLowerCase();
      if (kw === "!" || kw === "time" || (cursor === 0 && kw === "&")) { cursor++; continue; }
      if (kw === "{") { state.braceDepth++; if (++cursor >= tokens.length) uncertainSyntax = true; continue; }
      if (kw === "}" || kw === "fi" || kw === "done") {
        const bad = kw === "}" ? state.braceDepth <= 0 : (kw === "fi" ? (state.ifDepth <= 0 || state.awaitingThen) : (state.loopDepth <= 0 || state.awaitingDo));
        if (bad && !allowPartialCompound) uncertainSyntax = true;
        else if (!bad) { if (kw === "}") state.braceDepth--; else if (kw === "fi") state.ifDepth--; else state.loopDepth--; }
        if (!onlyRedirectsRemain(tokens, cursor + 1)) uncertainSyntax = true;
        terminal = true; break;
      }
      if (kw === "if" || kw === "while" || kw === "until") {
        if (kw === "if") { state.ifDepth++; state.awaitingThen = true; } else { state.loopDepth++; state.awaitingDo = true; }
        if (++cursor >= tokens.length) uncertainSyntax = true;
        continue;
      }
      if (kw === "elif" || kw === "else") {
        if ((state.ifDepth <= 0 || state.awaitingThen) && !allowPartialCompound) uncertainSyntax = true;
        if (kw === "elif") state.awaitingThen = true;
        if (++cursor >= tokens.length) uncertainSyntax = true;
        continue;
      }
      if (kw === "then" || kw === "do") {
        if (!(kw === "then" ? state.awaitingThen : state.awaitingDo) && !allowPartialCompound) uncertainSyntax = true;
        if (kw === "then") state.awaitingThen = false; else state.awaitingDo = false;
        if (++cursor >= tokens.length) uncertainSyntax = true;
        continue;
      }
      if (kw === "for" || kw === "select") {
        state.loopDepth++; state.awaitingDo = true;
        if (cursor + 1 >= tokens.length) { uncertainSyntax = true; terminal = true; break; }
        if (cursor + 2 < tokens.length && !tokens[cursor + 2].quoted && tokens[cursor + 2].value.toLowerCase() === "do") {
          state.awaitingDo = false; cursor += 3; if (cursor >= tokens.length) uncertainSyntax = true; continue;
        }
        let wIdx = cursor + 2;
        if (wIdx < tokens.length && !tokens[wIdx].quoted && tokens[wIdx].value.toLowerCase() === "in") wIdx++;
        else if (wIdx < tokens.length) uncertainSyntax = true;
        for (; wIdx < tokens.length; wIdx++) { const r = skipSingleRedirect(tokens, wIdx); if (r) { wIdx = r.nextIdx - 1; continue; } forWordTokens.push(tokens[wIdx]); }
        terminal = true; break;
      }
      // shortcut: case/[[/function/coproc mark syntax uncertain instead of full compound AST parsing, upgrade if needed
      if (["case", "esac", "[[", "]]", "function", "coproc"].includes(kw) || tok.raw.endsWith(")")) { uncertainSyntax = true; cursor++; continue; }
      break;
    }
    if (!terminal && cursor < tokens.length) {
      if (tokens.slice(cursor).some((t) => t.isSubshellGroup)) uncertainSyntax = true;
      const cmdIdx = stripLeadingShellPrefixes(tokens, cursor, { includeControlKeywords: false });
      if (cmdIdx < tokens.length && tokens[cmdIdx].isSubshellGroup) {
        if (tokens[cmdIdx].unclosedSubshell || !onlyRedirectsRemain(tokens, cmdIdx + 1)) uncertainSyntax = true;
      } else {
        starts.push({ startPos: cursor, cmdIdx, endIdx: tokens.length });
        if (cmdIdx < tokens.length && normalizeCmdName(tokens[cmdIdx].value) === "find") {
          const f = scanFindCommand(tokens, cmdIdx, tokens.length);
          if (f.uncertain) uncertainSyntax = true;
          starts.push(...f.starts);
        }
      }
    }
    perSegment.push({ starts, forWordTokens, uncertainSyntax, inCompoundBranch: inCompoundBefore || state.ifDepth > 0 || state.loopDepth > 0 });
  }
  const unclosedCompound = !allowPartialCompound && (state.ifDepth > 0 || state.loopDepth > 0 || state.braceDepth > 0 || state.awaitingThen || state.awaitingDo);
  return { perSegment, unclosedCompound };
}

const collectSegmentCommandStartIndices = (tokens) => analyzeSegmentCommandStarts([{ text: "", _tokens: tokens }], { allowPartialCompound: true }).perSegment[0].starts.map((s) => s.startPos);
function getSegmentCmdName(seg) {
  const tokens = getSegTokens(seg), first = analyzeSegmentCommandStarts([seg], { allowPartialCompound: true }).perSegment[0].starts[0];
  return first && first.cmdIdx < tokens.length ? normalizeCmdName(tokens[first.cmdIdx].value) : "";
}

export function extractRedirectTargetTokens(tokens, writeOnly = false) {
  const targets = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.quoted || REDIRECT_CLOSE_FD_REGEX.test(tok.raw)) continue;
    if (REDIRECT_OP_REGEX.test(tok.raw)) {
      const next = tokens[i + 1];
      if (tok.raw === "<<" || tok.raw === "<<-" || tok.raw === "<<<" || (/^(?:\d+)?(?:>&|<&)$/.test(tok.raw) && next && !next.quoted && /^\d+$/.test(next.raw))) { if (next && !isUnquotedRedir(next)) i++; continue; }
      if (next && !isUnquotedRedir(next)) { if (!writeOnly || tok.raw.includes(">")) targets.push(next); i++; }
      continue;
    }
    const attached = tok.raw.match(REDIRECT_ATTACHED_REGEX);
    if (!attached) continue;
    const opPart = tok.raw.slice(0, tok.raw.length - attached[1].length), valPart = attached[1].replace(/^["']|["']$/g, "");
    if (opPart === "<<" || opPart === "<<-" || opPart === "<<<" || (/^(?:\d+)?(?:>&|<&)$/.test(opPart) && /^(?:\d+|-)$/.test(valPart))) continue;
    if (!writeOnly || opPart.includes(">")) targets.push({ raw: attached[1], value: valPart, quoted: /^["']/.test(attached[1]), globPositions: [], hasUnquotedGlob: false });
  }
  return targets;
}

export const extractRedirectTargets = (tokens, writeOnly = false) => extractRedirectTargetTokens(tokens, writeOnly).map((t) => t.value);
function unwrapShellWrapper(segText) {
  const m = segText.match(/^((?:cmd(?:\.exe)?\s+\/[cC]|(?:powershell|pwsh)(?:\.exe)?\s+(?:-Command|-c)|(?:bash|sh|zsh|dash)\s+-[a-z]*c)\s+)(["'])([\s\S]*)\2$/i);
  return m ? { prefix: m[1], quote: m[2], inner: m[3] } : null;
}

export function extractSimpleWrappedScript(segText) {
  const trimmed = String(segText || "").trim();
  if (!trimmed) return null;
  const detailed = tokenizeShellWordsDetailed(trimmed);
  if (detailed.length < 2) return null;
  let headIdx = 0, hadPrefix = false;
  while (headIdx < detailed.length) {
    const r = skipSingleRedirect(detailed, headIdx);
    if (r) { hadPrefix = true; headIdx = r.nextIdx; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(detailed[headIdx].raw) || (!detailed[headIdx].quoted && ["!", "time", "{", "then", "do", "else", "elif", "if", "while", "until"].includes(detailed[headIdx].value.toLowerCase()))) {
      hadPrefix = true; headIdx++; continue;
    }
    break;
  }
  if (headIdx >= detailed.length - 1) return null;
  const nonRedirRest = (fromIdx) => {
    const out = [];
    for (let k = fromIdx; k < detailed.length; k++) { const r = skipSingleRedirect(detailed, k); if (r) { k = r.nextIdx - 1; continue; } out.push(detailed[k].value); }
    return out;
  };
  const cmd0 = normalizeCmdName(detailed[headIdx].value);
  if (cmd0 === "env") {
    let envLocalCwd = null;
    for (let i = headIdx + 1; i < detailed.length; i++) {
      const r = skipSingleRedirect(detailed, i);
      if (r) { i = r.nextIdx - 1; continue; }
      const v = detailed[i].value;
      if (v === "--") break;
      if ((v === "-C" || v === "--chdir") && i + 1 < detailed.length) { envLocalCwd = detailed[++i].value; continue; }
      if (v.startsWith("--chdir=")) { envLocalCwd = v.slice(8); continue; }
      if ((v === "-S" || v === "--split-string") && i + 1 < detailed.length) return { hadEnvPrefix: true, localCwd: envLocalCwd, innerScript: nonRedirRest(i + 1).join(" ") };
      if (v.startsWith("--split-string=")) return { hadEnvPrefix: true, localCwd: envLocalCwd, innerScript: [v.slice(15), ...nonRedirRest(i + 1)].filter(Boolean).join(" ") };
      if (!v.startsWith("--") && /^-[a-zA-Z]*S/.test(v)) { const inner = [v.slice(v.indexOf("S") + 1), ...nonRedirRest(i + 1)].filter(Boolean).join(" "); if (inner) return { hadEnvPrefix: true, localCwd: envLocalCwd, innerScript: inner }; }
      if ((v === "-u" || v === "--unset") && i + 1 < detailed.length) { i++; continue; }
      if (!v.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(detailed[i].raw)) break;
    }
  }
  if (cmd0 === "eval") return { hadEnvPrefix: hadPrefix, innerScript: nonRedirRest(headIdx + 1).join(" ") };
  if (["bash", "sh", "zsh", "dash", "ksh", "cmd", "pwsh", "powershell"].includes(cmd0)) {
    for (let i = headIdx + 1; i < detailed.length - 1; i++) {
      const r = skipSingleRedirect(detailed, i);
      if (r) { i = r.nextIdx - 1; continue; }
      const fl = detailed[i].value;
      if (fl === "--") break;
      if (cmd0 === "cmd" ? /^\/[ck]$/i.test(fl) : (cmd0 === "pwsh" || cmd0 === "powershell" ? /^-(?:command|c)$/i.test(fl) : /^-[a-z]*c$/i.test(fl))) {
        if (cmd0 === "cmd" || cmd0 === "pwsh" || cmd0 === "powershell") return { hadEnvPrefix: hadPrefix, isChildShell: true, innerScript: nonRedirRest(i + 1).join(" ") };
        const nx = nextNonRedirectIndex(detailed, i + 1, detailed.length);
        if (nx.idx < detailed.length) return { hadEnvPrefix: hadPrefix, isChildShell: true, innerScript: detailed[nx.idx].value };
      }
    }
  }
  if (["env", "sudo", "doas", "timeout", "nice"].includes(cmd0) || SIMPLE_WRAPPERS.has(cmd0)) {
    const nextIdx = stripLeadingShellPrefixes(detailed, headIdx, { includeControlKeywords: false });
    if (nextIdx > headIdx && nextIdx < detailed.length) return { hadEnvPrefix: true, localCwd: extractWrapperLocalCwd(detailed, headIdx, nextIdx), innerScript: trimmed.slice(detailed[nextIdx].start) };
  }
  return null;
}

function isSingleUnchainedShellCmd(segments) {
  const seg = segments.length === 1 ? segments[0] : null;
  return Boolean(seg && (!seg.leadingSep || seg.leadingSep === "\n") && !seg.hasRedirect && !seg.hasHeredoc && !seg.hasSubshell && !hasDotDotTraversal(seg.text));
}

const OBVIOUS_MUTATION_VERBS = new Set(["rm", "del", "remove-item", "mv", "cp", "ln", "tee", "truncate", "shred", "dd", "patch", "chmod", "chown", "sed", "perl", "find", "install"]);
const DIR_MUTATION_VERBS = new Set(["rm", "del", "remove-item", "mv", "cp", "ln", "chmod", "chown", "find"]);
const DESTRUCTIVE_CONFIG_VERBS = new Set(["rm", "del", "remove-item", "mv", "ln", "truncate", "shred", "dd", "chmod", "chown", "find"]);

function extractVerbMutationTargets(verb, tokens, cmdIdx, endIdx = tokens.length) {
  if (verb === "find") {
    const f = scanFindCommand(tokens, cmdIdx, endIdx);
    const t = [...(f.mutates ? (f.startPoints.length > 0 ? f.startPoints : ["."]) : []), ...f.writeTargets];
    return { benchTargets: t, govTargets: t };
  }
  const vals = [];
  for (let i = cmdIdx + 1; i < endIdx; i++) { const r = skipSingleRedirect(tokens, i); if (r) { i = r.nextIdx - 1; continue; } vals.push(tokens[i].value); }
  const nonFlag = (list) => {
    const out = []; let dd = false;
    for (const v of list) { if (!dd && v === "--") dd = true; else if (dd || !v.startsWith("-") || v === "-") out.push(v); }
    return out;
  };
  if (verb === "cp" || verb === "ln") {
    const targetDirs = [], positionals = [], valFlags = new Set(["-S", "--suffix", "--no-preserve", "--sparse"]);
    let dd = false;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (!dd && v === "--") { dd = true; continue; }
      if (!dd && v.startsWith("-") && v !== "-") {
        if (v === "-t" || v === "--target-directory" || (!v.startsWith("--") && /^-[^-]*t$/.test(v))) { if (vals[i + 1]) targetDirs.push(vals[++i]); }
        else if (v.startsWith("--target-directory=")) targetDirs.push(v.slice(19));
        else if (!v.startsWith("--") && /^-[^-]*t(.+)$/.test(v)) targetDirs.push(v.slice(v.indexOf("t") + 1));
        else if (valFlags.has(v) && i + 1 < vals.length) i++;
        continue;
      }
      positionals.push(v);
    }
    const dests = targetDirs.length > 0 ? targetDirs : (positionals.length >= 2 ? [positionals[positionals.length - 1]] : []);
    return { benchTargets: dests, govTargets: verb === "ln" ? [...dests, ...positionals] : dests };
  }
  if (verb === "dd") { const t = vals.filter((v) => v.startsWith("of=")).map((v) => v.slice(3)).filter(Boolean); return { benchTargets: t, govTargets: t }; }
  if (verb === "sed" || verb === "perl") {
    let hasI = false;
    for (const v of vals) { if (v === "--") break; if (v === "-i" || v.startsWith("--in-place") || /^-[a-zA-Z0-9]*i/.test(v)) { hasI = true; break; } }
    const t = hasI ? nonFlag(vals) : [];
    return { benchTargets: t, govTargets: t };
  }
  const t = nonFlag(vals);
  return { benchTargets: t, govTargets: t };
}

export function segmentPipesToShell(segments, idx) {
  if (SHELL_INTERPRETERS.has(getSegmentCmdName(segments[idx]))) return true;
  for (let j = idx + 1; j < segments.length && ["|", "|&"].includes(segments[j].leadingSep); j++) if (SHELL_INTERPRETERS.has(getSegmentCmdName(segments[j]))) return true;
  return false;
}

function checkShellMutations(segments, convId, ctx, depth = 0) {
  if (depth > 4) return null;
  let cwds = [ctx?.cwd || ""], oldCwds = null, prePrevCwds = null, branchBaseCwds = null, pendingForceAsk = null;
  const benchDisabled = isBenchmarkGuardDisabled(convId, ctx);
  const record = (res) => (!res ? null : (res.decision === "deny" ? res : ((pendingForceAsk ||= res), null)));
  const { perSegment } = analyzeSegmentCommandStarts(segments, { allowPartialCompound: depth > 0 });
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx], segInfo = perSegment[segIdx];
    if (seg.leadingSep === "||" && prePrevCwds) cwds = dedupCwds([...cwds, ...prePrevCwds]);
    if (segInfo.inCompoundBranch && !branchBaseCwds) branchBaseCwds = [...cwds];
    const segCwds = [...cwds], tokens = getSegTokens(seg);
    const writeRedirects = seg.hasWriteRedirect ? extractRedirectTargets(tokens, true) : [];
    const govChecks = writeRedirects.map((tok) => ({ tok, isDirVerb: false, isDestructive: false, cmdCwds: segCwds }));
    const benchChecks = writeRedirects.map((tok) => ({ tok, cmdCwds: segCwds }));
    for (const { startPos, cmdIdx, endIdx } of segInfo.starts) {
      if (cmdIdx >= tokens.length || cmdIdx >= endIdx) continue;
      const localCwd = extractWrapperLocalCwd(tokens, startPos, cmdIdx);
      const cmdCwds = localCwd ? segCwds.map((c) => resolveHookPath(expandLeadingTilde(localCwd), c)) : segCwds;
      const verb = normalizeCmdName(tokens[cmdIdx].value);
      if (verb === "cd") {
        const nextSep = segIdx + 1 < segments.length ? segments[segIdx + 1].leadingSep : "";
        const inPipe = ["|", "|&"].includes(seg.leadingSep) || ["|", "|&"].includes(nextSep);
        const cdStep = stepCdDirectorySet(tokens, cmdIdx, endIdx, segCwds, oldCwds, { inPipeline: inPipe, inCompoundBranch: segInfo.inCompoundBranch, nextLeadingSep: nextSep });
        prePrevCwds = segCwds; oldCwds = segCwds;
        cwds = cdStep.uncertain ? dedupCwds([...cdStep.cwds, path.join(getProfileHomeDir(), ".gemini", "config"), path.join(getProfileHomeDir(), ".gemini", "antigravity"), getStateDir()]) : cdStep.cwds;
        continue;
      }
      if (!OBVIOUS_MUTATION_VERBS.has(verb)) continue;
      const { govTargets, benchTargets } = extractVerbMutationTargets(verb, tokens, cmdIdx, endIdx);
      for (const tok of govTargets) govChecks.push({ tok, isDirVerb: DIR_MUTATION_VERBS.has(verb), isDestructive: DESTRUCTIVE_CONFIG_VERBS.has(verb), cmdCwds });
      for (const tok of benchTargets) benchChecks.push({ tok, cmdCwds });
    }
    if (!segInfo.inCompoundBranch && branchBaseCwds) { cwds = dedupCwds([...branchBaseCwds, ...cwds]); branchBaseCwds = null; }
    for (const { tok, isDirVerb, isDestructive, cmdCwds } of govChecks) {
      for (const effCwd of cmdCwds) {
        const scopedCtx = { ...ctx, cwd: effCwd };
        if (isDirVerb && isProtectedGovernanceDirPath(tok, effCwd)) return { decision: "deny", reason: "Antigravity Execution Governance: Shell mutation of protected Antigravity hook, shim, or governance source files is strictly prohibited." };
        if (isProtectedGovernanceFileMutationPath(tok, convId, scopedCtx)) {
          if (!isDestructive && isUserEditableGeminiConfigPath(tok, convId, scopedCtx)) record({ decision: "force_ask", reason: `[GEMINI CONFIG MUTATION] Shell edit to Antigravity user configuration '${tok}' requires explicit user confirmation.` });
          else return { decision: "deny", reason: "Antigravity Execution Governance: Shell mutation of protected Antigravity hook, shim, or governance source files is strictly prohibited." };
        }
      }
    }
    if (!benchDisabled && benchChecks.some(({ tok, cmdCwds }) => cmdCwds.some((effCwd) => isProtectedBenchmarkFilePath(tok, effCwd)))) {
      record({ decision: "force_ask", reason: "[BENCHMARK MUTATION DETECTED] Shell command mutation of protected evaluator/benchmark artifact requires explicit user confirmation to prevent benchmark contamination. Set AGY_DISABLE_BENCHMARK_GUARD=1 to disable this guard for non-evaluation repos." });
    }
    const wrap = extractSimpleWrappedScript(seg.text);
    for (const effCwd of segCwds) {
      if (wrap?.innerScript) { const d = record(checkShellMutations(splitShellSegments(wrap.innerScript), convId, { ...ctx, cwd: wrap.localCwd ? resolveHookPath(expandLeadingTilde(wrap.localCwd), effCwd) : effCwd }, depth + 1)); if (d) return d; }
      for (const sub of seg.subshells || []) { const d = record(checkShellMutations(splitShellSegments(sub), convId, { ...ctx, cwd: effCwd }, depth + 1)); if (d) return d; }
      if (seg.heredocBodies?.length && segmentPipesToShell(segments, segIdx)) for (const hd of seg.heredocBodies) if (hd) { const d = record(checkShellMutations(splitShellSegments(hd), convId, { ...ctx, cwd: effCwd }, depth + 1)); if (d) return d; }
    }
  }
  return pendingForceAsk;
}

const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack", "select-string"]);

function makeOptionSpec({ sb = "", sr = "", so = "", lb = "", lr = "", lo = "", lfr = "", patNoArg = "", hasPattern = true, allowNoPrefix = false }) {
  const sw = (s) => s.trim().split(/\s+/).filter(Boolean), pna = new Set(sw(patNoArg)), baseLb = sw(lb);
  const fullLb = new Set([...baseLb, ...pna, ...(allowNoPrefix ? baseLb.filter((f) => f.startsWith("--") && !f.startsWith("--no-")).map((f) => `--no-${f.slice(2)}`) : [])]);
  return { sb: new Set(sb), sr: new Set(sr), so: new Set(so), lb: fullLb, lr: new Set(sw(lr)), lo: new Set(sw(lo)), lfr: new Set(sw(lfr)), pna, hasPattern };
}

const OPTION_SPECS = {
  rg: makeOptionSpec({
    sb: "zsFivxUPSawL.ubhnN0opqHIclV", sr: "efEmjgdtTABCMr", allowNoPrefix: true, patNoArg: "--files --type-list --pcre2-version --help --version",
    lb: "--search-zip --case-sensitive --crlf --fixed-strings --ignore-case --invert-match --line-regexp --mmap --multiline --multiline-dotall --unicode --null-data --pcre2 --smart-case --stop-on-nonmatch --text --word-regexp --auto-hybrid-regex --pcre2-unicode --binary --follow --glob-case-insensitive --hidden --ignore-file-case-insensitive --ignore --ignore-dot --ignore-exclude --ignore-files --ignore-global --ignore-parent --ignore-vcs --require-git --one-file-system --unrestricted --block-buffered --byte-offset --column --no-context-separator --heading --include-zero --line-buffered --line-number --max-columns-preview --null --only-matching --passthru --pretty --quiet --trim --vimgrep --with-filename --no-filename --sort-files --count --count-matches --files-with-matches --files-without-match --json --debug --ignore-messages --messages --stats --trace --config",
    lr: "--regexp --file --ignore-file --pre --pre-glob --hostname-bin --dfa-size-limit --encoding --engine --max-count --regex-size-limit --threads --glob --iglob --max-depth --max-filesize --type --type-not --type-add --type-clear --after-context --before-context --context --color --colors --context-separator --field-context-separator --field-match-separator --hyperlink-format --max-columns --path-separator --replace --sort --sortr --generate",
    lfr: "--file --ignore-file --pre --hostname-bin"
  }),
  grep: makeOptionSpec({
    sb: "EFGPiyvwxzsbnHhoqaIrRLlcTZUV0123456789", sr: "efmdDABC", patNoArg: "--help --version",
    lb: "--extended-regexp --fixed-strings --basic-regexp --perl-regexp --ignore-case --no-ignore-case --word-regexp --line-regexp --null-data --no-messages --invert-match --byte-offset --line-number --line-buffered --with-filename --no-filename --only-matching --quiet --silent --text --recursive --dereference-recursive --files-without-match --files-with-matches --count --initial-tab --null --no-group-separator --binary --unix-byte-offsets",
    lr: "--regexp --file --exclude-from --max-count --label --binary-files --directories --devices --include --exclude --exclude-dir --before-context --after-context --context --group-separator",
    lo: "--color --colour", lfr: "--file --exclude-from"
  }),
  "git-grep": makeOptionSpec({
    sb: "viwaIrEGFPnhHlLzocpWqu0123456789", sr: "efCBAm", so: "O", patNoArg: "--help", allowNoPrefix: true,
    lb: "--cached --no-index --index --untracked --exclude-standard --recurse-submodules --invert-match --ignore-case --word-regexp --text --textconv --recursive --extended-regexp --basic-regexp --fixed-strings --perl-regexp --line-number --column --full-name --files-with-matches --name-only --files-without-match --null --only-matching --count --break --heading --show-function --function-context --and --or --not --quiet --all-match --ext-grep",
    lr: "--regexp --file --max-depth --context --before-context --after-context --threads --max-count",
    lo: "--color --no-color --open-files-in-pager --no-open-files-in-pager", lfr: "--file"
  }),
  ls: makeOptionSpec({
    hasPattern: false, sb: "aAbBcCdDfFgGhHiklLmnNopqQrRsStuUvxXZ1", sr: "IwT",
    lb: "--all --almost-all --author --escape --ignore-backups --directory --dired --file-type --full-time --group-directories-first --no-group --human-readable --si --dereference-command-line --dereference-command-line-symlink-to-dir --inode --kibibytes --dereference --numeric-uid-gid --literal --hide-control-chars --show-control-chars --quote-name --reverse --recursive --size --context --zero --help --version",
    lr: "--ignore --hide --block-size --format --quoting-style --sort --time --time-style --width --tabsize",
    lo: "--color --hyperlink --indicator-style --classify"
  })
};

const shiftGlobPositions = (globPositions, offset) => Array.isArray(globPositions) ? globPositions.filter((g) => g >= offset).map((g) => g - offset) : null;

export function collapseActiveShellGlob(value, globPositions = null) {
  if (!value || typeof value !== "string") return value;
  const idx = Array.isArray(globPositions) ? (globPositions.length > 0 ? globPositions[0] : -1) : value.search(/[*?\[]/);
  if (idx < 0) return value;
  const prefix = value.slice(0, idx);
  return (prefix.endsWith("/") || prefix.endsWith(path.sep)) ? (prefix.slice(0, -1) || prefix) : path.dirname(`${prefix}_`);
}

function expandItemPathCandidates(item) {
  const value = typeof item === "string" ? item : item.value;
  const globPositions = typeof item === "string" ? null : (item.globPositions ?? []);
  const isOperand = typeof item === "string" ? false : Boolean(item.isOperand);
  if (!value || typeof value !== "string") return [];
  const out = [{ value, globPositions, isOperand }];
  if (!isOperand) {
    for (const ch of ["=", "@"]) { const p = value.indexOf(ch); if (p !== -1 && p + 1 < value.length) out.push({ value: value.slice(p + 1), globPositions: shiftGlobPositions(globPositions, p + 1), isOperand: true }); }
    if (value.startsWith("-") && !value.startsWith("--")) {
      for (let i = 1; i < value.length && /[A-Za-z0-9]/.test(value[i]); i++) if ("FfCKTo".includes(value[i]) && i + 1 < value.length) out.push({ value: value.slice(i + 1), globPositions: shiftGlobPositions(globPositions, i + 1), isOperand: true });
    }
  }
  return out;
}
export const expandInlinePathCandidates = (raw) => expandItemPathCandidates(raw).map((c) => c.value);

function parseOptionRoles(tokens, argStart, endIdx, dialect) {
  const spec = OPTION_SPECS[dialect] || null, fileTargets = [], unknownOpts = [], preDD = [], postDD = [];
  let hasExplicitPat = false, sawDD = false, uncertain = !spec, gitUntracked = false, gitNoIndex = false, gitUnsupported = false, executesHelper = false;
  for (let i = argStart; i < endIdx; i++) {
    const r = skipSingleRedirect(tokens, i);
    if (r) { if (r.missingTarget) uncertain = true; i = r.nextIdx - 1; continue; }
    const tok = tokens[i], v = tok.value;
    if (!sawDD && v === "--") { sawDD = true; continue; }
    if (sawDD) { postDD.push({ value: v, globPositions: tok.globPositions, isOperand: true }); continue; }
    if (dialect === "git-grep" && !tok.quoted && (v === "(" || v === ")")) continue;
    if (v.startsWith("--") && v.length > 2) {
      if (!spec) { unknownOpts.push({ value: v, globPositions: tok.globPositions, isOperand: false }); continue; }
      const eq = v.indexOf("="), opt = eq === -1 ? v : v.slice(0, eq);
      if (opt === "--pre" || opt === "--hostname-bin" || opt === "--open-files-in-pager") executesHelper = true;
      if (dialect === "git-grep") {
        if (opt === "--untracked") gitUntracked = true;
        else if (opt === "--no-index") gitNoIndex = true;
        else if (opt === "--cached" || opt === "--recurse-submodules" || opt === "--textconv") gitUnsupported = true;
      }
      if (eq !== -1) {
        if (spec.lr.has(opt) || spec.lo.has(opt)) {
          if (opt === "--regexp" || opt === "--file") hasExplicitPat = true;
          if (spec.lfr.has(opt)) fileTargets.push({ value: v.slice(eq + 1), globPositions: shiftGlobPositions(tok.globPositions, eq + 1), isOperand: true });
        } else { uncertain = true; unknownOpts.push({ value: v, globPositions: tok.globPositions, isOperand: false }); }
      } else if (spec.lb.has(opt) || spec.lo.has(opt)) {
        if (spec.pna.has(opt)) hasExplicitPat = true;
      } else if (spec.lr.has(opt)) {
        if (opt === "--regexp" || opt === "--file") hasExplicitPat = true;
        const next = nextNonRedirectIndex(tokens, i + 1, endIdx);
        if (next.missingRedirect || next.idx >= endIdx) { uncertain = true; break; }
        if (spec.lfr.has(opt)) fileTargets.push({ value: tokens[next.idx].value, globPositions: tokens[next.idx].globPositions, isOperand: true });
        i = next.idx;
      } else { uncertain = true; unknownOpts.push({ value: v, globPositions: tok.globPositions, isOperand: false }); }
      continue;
    }
    if (v.startsWith("-") && v !== "-") {
      if (!spec) { unknownOpts.push({ value: v, globPositions: tok.globPositions, isOperand: false }); continue; }
      for (let k = 1; k < v.length; k++) {
        const ch = v[k];
        if (spec.sb.has(ch)) { if (dialect === "git-grep" && ch === "u") gitUntracked = true; continue; }
        if (spec.so.has(ch)) { if (dialect === "git-grep" && ch === "O") executesHelper = true; break; }
        if (spec.sr.has(ch)) {
          if (ch === "e" || ch === "f") hasExplicitPat = true;
          if (k + 1 < v.length) { if (ch === "f") fileTargets.push({ value: v.slice(k + 1), globPositions: shiftGlobPositions(tok.globPositions, k + 1), isOperand: true }); }
          else {
            const next = nextNonRedirectIndex(tokens, i + 1, endIdx);
            if (next.missingRedirect || next.idx >= endIdx) uncertain = true;
            else { if (ch === "f") fileTargets.push({ value: tokens[next.idx].value, globPositions: tokens[next.idx].globPositions, isOperand: true }); i = next.idx; }
          }
          break;
        }
        uncertain = true; unknownOpts.push({ value: v, globPositions: tok.globPositions, isOperand: false }); break;
      }
      continue;
    }
    preDD.push({ value: v, globPositions: tok.globPositions, isOperand: true });
  }
  const allPos = [...preDD, ...postDD];
  if (uncertain) return { uncertain: true, pathItems: [...fileTargets, ...unknownOpts, ...allPos], implicitCwd: true, executesHelper, gitTrackedScope: null };
  const preDDPostPat = !spec.hasPattern || hasExplicitPat ? preDD : (preDD.length > 0 ? preDD.slice(1) : []);
  const operands = !spec.hasPattern || hasExplicitPat ? allPos : (preDD.length > 0 ? [...preDDPostPat, ...postDD] : postDD.slice(1));
  let gitTrackedScope = null;
  if (dialect === "git-grep" && !gitUntracked && !gitNoIndex && !gitUnsupported) {
    if (sawDD && preDDPostPat.length > 0) uncertain = true;
    else if (!(!sawDD && operands.some((op) => op.hasUnquotedGlob))) gitTrackedScope = { sawDoubleDash: sawDD, pathspecs: operands.map((op) => op.value), fileTargets };
  }
  return { uncertain, pathItems: uncertain ? [...fileTargets, ...allPos] : [...fileTargets, ...operands], implicitCwd: uncertain || operands.length === 0, executesHelper, gitTrackedScope };
}

function parseGitPrefixBeforeSubcommand(tokens, gitIdx, endIdx) {
  const gitGlobalArgs = [], extraPathItems = [];
  let gitLocalCwd = null, hasConfigOverride = false, uncertain = false, idx = gitIdx + 1;
  while (idx < endIdx) {
    const r = skipSingleRedirect(tokens, idx);
    if (r) { if (r.missingTarget) uncertain = true; idx = r.nextIdx; continue; }
    const tok = tokens[idx], v = tok.value;
    if (v === "--") { idx++; break; }
    if (!v.startsWith("-") || v === "-") break;
    if (["-C", "--git-dir", "--work-tree", "--namespace", "-c", "--config-env", "--super-prefix"].includes(v)) {
      const next = nextNonRedirectIndex(tokens, idx + 1, endIdx);
      if (next.missingRedirect || next.idx >= endIdx) { uncertain = true; idx = endIdx; break; }
      const vt = tokens[next.idx];
      if (v === "-c" || v === "--config-env" || v === "--super-prefix") hasConfigOverride = true; else gitGlobalArgs.push(v, vt.value);
      if (v === "-C") gitLocalCwd = gitLocalCwd ? path.resolve(gitLocalCwd, expandLeadingTilde(vt.value)) : vt.value;
      if (v === "-C" || v === "--git-dir" || v === "--work-tree") extraPathItems.push({ value: vt.value, globPositions: vt.globPositions, isOperand: true });
      idx = next.idx + 1; continue;
    }
    if (v.startsWith("-C") && v.length > 2 && !v.startsWith("--")) {
      const dirVal = v.slice(2);
      gitLocalCwd = gitLocalCwd ? path.resolve(gitLocalCwd, expandLeadingTilde(dirVal)) : dirVal;
      gitGlobalArgs.push("-C", dirVal); extraPathItems.push({ value: dirVal, globPositions: shiftGlobPositions(tok.globPositions, 2), isOperand: true });
    } else if (v.startsWith("--git-dir=") || v.startsWith("--work-tree=")) {
      const eq = v.indexOf("="); gitGlobalArgs.push(v); extraPathItems.push({ value: v.slice(eq + 1), globPositions: shiftGlobPositions(tok.globPositions, eq + 1), isOperand: true });
    } else if (v.startsWith("--namespace=")) gitGlobalArgs.push(v);
    else if ((v.startsWith("-c") && v.length > 2 && !v.startsWith("--")) || v.startsWith("--config-env=") || v.startsWith("--super-prefix=")) hasConfigOverride = true;
    else if (["-p", "--paginate", "-P", "--no-pager", "--no-replace-objects", "--bare", "--no-optional-locks"].includes(v)) { if (v === "--bare") gitGlobalArgs.push(v); }
    else uncertain = true;
    idx++;
  }
  return { subIdx: idx, subName: idx < endIdx ? normalizeCmdName(tokens[idx].value) : "", gitGlobalArgs, gitLocalCwd, hasConfigOverride, extraPathItems, uncertain };
}

function classifyCommandRoles(tokens, startPos, cmdIdx, endIdx, { hasDownstreamPipe = false } = {}) {
  if (cmdIdx >= endIdx || cmdIdx >= tokens.length) return { verb: "", pathItems: [], implicitCwd: false, recursive: false, uncertain: false, gitGrepScope: null };
  const prefixItems = [];
  for (let p = startPos; p < cmdIdx; p++) {
    const r = skipSingleRedirect(tokens, p);
    if (r) { p = r.nextIdx - 1; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[p].raw)) prefixItems.push({ value: tokens[p].value, globPositions: tokens[p].globPositions, isOperand: false });
  }
  const verb = normalizeCmdName(tokens[cmdIdx].value);
  if ((!hasDownstreamPipe && ["echo", "printf", "write-output"].includes(verb)) || verb === "cd") return { verb, pathItems: prefixItems, implicitCwd: false, recursive: false, uncertain: false, gitGrepScope: null };
  let effVerb = verb, argStart = cmdIdx + 1;
  if (verb === "rtk" && argStart < endIdx && ["grep", "rg", "ls", "git"].includes(normalizeCmdName(tokens[argStart].value))) effVerb = normalizeCmdName(tokens[argStart++].value);
  else if (verb === "node" && argStart + 1 < endIdx && isTrustedLocalRtkLauncherPath(tokens[argStart].value) && ["grep", "rg", "ls", "git"].includes(normalizeCmdName(tokens[argStart + 1].value))) { effVerb = normalizeCmdName(tokens[argStart + 1].value); argStart += 2; }
  if (effVerb === "git") {
    const gm = parseGitPrefixBeforeSubcommand(tokens, argStart - 1, endIdx);
    if (gm.subName === "grep") {
      const p = parseOptionRoles(tokens, gm.subIdx + 1, endIdx, "git-grep"), okTracked = Boolean(p.gitTrackedScope && !gm.uncertain && !gm.hasConfigOverride && !p.uncertain);
      return {
        verb, effectiveVerb: "git-grep", localCwd: gm.gitLocalCwd, pathItems: [...prefixItems, ...gm.extraPathItems, ...p.pathItems],
        implicitCwd: p.implicitCwd || gm.uncertain, recursive: true, uncertain: p.uncertain || gm.uncertain,
        gitGrepScope: okTracked ? { gitGlobalArgs: gm.gitGlobalArgs, sawDoubleDash: p.gitTrackedScope.sawDoubleDash, pathspecs: p.gitTrackedScope.pathspecs, nonPathspecItems: [...prefixItems, ...gm.extraPathItems, ...p.gitTrackedScope.fileTargets] } : null
      };
    }
  }
  if (SEARCH_COMMANDS.has(effVerb) || effVerb === "ls") {
    const dialect = effVerb === "ls" ? "ls" : ((effVerb === "rg" || effVerb === "ripgrep") ? "rg" : (["grep", "egrep", "fgrep"].includes(effVerb) ? "grep" : "unknown"));
    const p = parseOptionRoles(tokens, argStart, endIdx, dialect);
    return { verb, effectiveVerb: dialect, pathItems: [...prefixItems, ...p.pathItems], implicitCwd: p.implicitCwd, recursive: true, uncertain: p.uncertain, gitGrepScope: null };
  }
  if (effVerb === "find") {
    const f = scanFindCommand(tokens, argStart - 1, endIdx);
    return { verb, effectiveVerb: "find", pathItems: [...prefixItems, ...f.pathItems], implicitCwd: f.implicitCwd, recursive: true, uncertain: f.uncertain, gitGrepScope: null };
  }
  const genericItems = [...prefixItems];
  let sawDD = false;
  for (let i = cmdIdx; i < endIdx; i++) {
    const r = skipSingleRedirect(tokens, i);
    if (r) { i = r.nextIdx - 1; continue; }
    if (!sawDD && i > cmdIdx && tokens[i].value === "--") { sawDD = true; continue; }
    genericItems.push({ value: tokens[i].value, globPositions: tokens[i].globPositions, isOperand: sawDD });
  }
  return { verb, effectiveVerb: effVerb, pathItems: genericItems, implicitCwd: false, recursive: false, uncertain: false, gitGrepScope: null };
}

export function needsImplicitRecursiveCwd(tokens) {
  const { perSegment, unclosedCompound } = analyzeSegmentCommandStarts([{ text: "", _tokens: tokens }], { allowPartialCompound: true });
  return perSegment[0].uncertainSyntax || unclosedCompound || perSegment[0].starts.some(({ startPos, cmdIdx, endIdx }) => classifyCommandRoles(tokens, startPos, cmdIdx, endIdx).implicitCwd);
}

function filterProseFlags(detailed, subIdx, allTokens, envPrefix, shouldSkipPair, shouldSkipInline, asWords = false) {
  const kept = envPrefix.trim() ? [envPrefix.trim()] : [];
  let afterDD = false;
  for (let i = 0; i < detailed.length; i++) {
    const tok = detailed[i];
    if (i <= subIdx) { kept.push(tok.value); continue; }
    const r = skipSingleRedirect(detailed, i);
    if (r) { for (let k = i; k < Math.min(r.nextIdx, detailed.length); k++) kept.push(detailed[k].value); i = r.nextIdx - 1; continue; }
    if (!afterDD && tok.value === "--") { afterDD = true; kept.push(tok.value); continue; }
    if (!afterDD) {
      const next = nextNonRedirectIndex(detailed, i + 1, detailed.length), nextTok = next.idx < detailed.length ? detailed[next.idx] : null;
      if (shouldSkipPair(tok.value, nextTok)) { if (nextTok) i = next.idx; continue; }
      if (shouldSkipInline(tok.value)) continue;
    }
    kept.push(tok.value);
  }
  kept.push(...extractRedirectTargets(allTokens));
  return asWords ? kept : kept.join(" ");
}

export function getInspectableTextForSegment(seg, { hasDownstreamPipe = false, asWords = false } = {}) {
  const allTokens = getSegTokens(seg);
  if (allTokens.length === 0) return asWords ? [] : "";
  const { prefix: envPrefix } = splitEnvPrefix(seg.text, allTokens);
  const segInfo = analyzeSegmentCommandStarts([seg], { allowPartialCompound: true }).perSegment[0];
  const cmdIdx = segInfo.starts[0] ? segInfo.starts[0].cmdIdx : allTokens.length;
  if (cmdIdx >= allTokens.length) {
    const targets = [...segInfo.forWordTokens.map((t) => t.value), ...extractRedirectTargets(allTokens)];
    return asWords ? targets : targets.join(" ");
  }
  const nr = [];
  for (let i = cmdIdx; i < allTokens.length; i++) { const r = skipSingleRedirect(allTokens, i); if (r) { i = r.nextIdx - 1; continue; } nr.push({ tok: allTokens[i], origIdx: i }); }
  const cmd0 = nr[0] ? normalizeCmdName(nr[0].tok.value) : "", cmd1 = nr[1] ? normalizeCmdName(nr[1].tok.value) : "", cmd2 = nr[2] ? normalizeCmdName(nr[2].tok.value) : "";
  if (!hasDownstreamPipe && ["echo", "printf", "write-output"].includes(cmd0) && segInfo.starts.length <= 1) { const targets = extractRedirectTargets(allTokens); return asWords ? targets : targets.join(" "); }
  const rtkBase = (t) => cmd0 === t ? 0 : (cmd0 === "rtk" && cmd1 === t ? 1 : (cmd0 === "node" && nr[1] && isTrustedLocalRtkLauncherPath(nr[1].tok.value) && cmd2 === t ? 2 : -1));
  const skipGlobalNr = (start, valSet) => { let idx = start; while (idx < nr.length && nr[idx].tok.value.startsWith("-")) idx += valSet.has(nr[idx].tok.value) ? 2 : 1; return idx; };
  const gitBase = rtkBase("git");
  if (gitBase !== -1 && segInfo.starts.length <= 1) {
    const subNrIdx = skipGlobalNr(gitBase + 1, new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]));
    const gitSub = subNrIdx < nr.length ? normalizeCmdName(nr[subNrIdx].tok.value) : "", subOrigIdx = subNrIdx < nr.length ? nr[subNrIdx].origIdx : cmdIdx;
    if (gitSub === "commit" || gitSub === "tag") {
      const preRe = gitSub === "commit" ? /^-[apsnvqezoih]*m$/ : /^-[asfdvin]*m$/, inlRe = gitSub === "commit" ? /^-[apsnvqezoih]*m.+/ : /^-[asfdvin]*m.+/;
      return filterProseFlags(allTokens, subOrigIdx, allTokens, envPrefix, (v) => v === "-m" || v === "--message" || preRe.test(v), (v) => v.startsWith("--message=") || (!v.startsWith("--") && inlRe.test(v)), asWords);
    }
    if (["log", "rev-list", "shortlog"].includes(gitSub)) {
      return filterProseFlags(allTokens, subOrigIdx, allTokens, envPrefix, (v) => v === "--grep" || v === "-S" || v === "-G", (v) => v.startsWith("--grep=") || ((v.startsWith("-S") || v.startsWith("-G")) && v.length > 2), asWords);
    }
  }
  const ghBase = rtkBase("gh");
  if (ghBase !== -1 && ghBase + 1 < nr.length && segInfo.starts.length <= 1) {
    const ghGlobals = new Set(["-R", "--repo", "--hostname"]), subNrIdx = skipGlobalNr(ghBase + 1, ghGlobals);
    const ghSub = subNrIdx < nr.length ? normalizeCmdName(nr[subNrIdx].tok.value) : "", subOrigIdx = subNrIdx < nr.length ? nr[subNrIdx].origIdx : cmdIdx;
    if (ghSub === "api") {
      const isFileF = (val) => { const eq = String(val || "").indexOf("="); return eq !== -1 && String(val).slice(eq + 1).startsWith("@"); };
      return filterProseFlags(allTokens, subOrigIdx, allTokens, envPrefix, (v, next) => v === "-f" || v === "--raw-field" || ((v === "-F" || v === "--field") && next && !isFileF(next.value)), (v) => v.startsWith("--raw-field=") || (v.startsWith("-f") && v.length > 2 && !v.startsWith("--")) || (v.startsWith("--field=") && !isFileF(v.slice(8))) || (v.startsWith("-F") && v.length > 2 && !v.startsWith("--") && !isFileF(v.slice(2))), asWords);
    }
    if (["pr", "issue", "release"].includes(ghSub)) {
      const actNrIdx = skipGlobalNr(subNrIdx + 1, ghGlobals), ghAction = actNrIdx < nr.length ? normalizeCmdName(nr[actNrIdx].tok.value) : "";
      const allowC = (ghSub === "pr" || ghSub === "issue") && (ghAction === "close" || ghAction === "reopen");
      return filterProseFlags(allTokens, subOrigIdx, allTokens, envPrefix, (v) => ["-b", "--body", "-t", "--title", "-n", "--notes", "--subject"].includes(v) || (allowC && (v === "-c" || v === "--comment")), (v) => /^--(?:body|title|notes|subject)=/.test(v) || (allowC && v.startsWith("--comment=")) || (!v.startsWith("--") && (allowC ? /^-[btnc].+/ : /^-[btn].+/).test(v)), asWords);
    }
  }
  const roles = segInfo.starts.map((s) => classifyCommandRoles(allTokens, s.startPos, s.cmdIdx, s.endIdx, { hasDownstreamPipe }));
  if (roles.some((r) => ["rg", "grep", "git-grep", "unknown", "find", "ls"].includes(r.effectiveVerb))) {
    const targets = envPrefix.trim() ? [envPrefix.trim()] : [];
    for (const r of roles) for (const item of r.pathItems) targets.push(item.value);
    for (const fw of segInfo.forWordTokens) targets.push(fw.value);
    targets.push(...extractRedirectTargets(allTokens));
    return asWords ? targets : targets.join(" ");
  }
  if (asWords) return allTokens.map((tok) => tok.value);
  const unquoted = allTokens.map((t) => t.value.replace(/[\r\n]+/g, " ")).join(" ");
  return unquoted && unquoted !== seg.text ? `${seg.text}\n${unquoted}` : seg.text;
}

const CODE_FILE_ACCESS_RE = /\b(?:open|read|readFile|readFileSync|createReadStream|readdir|listdir|scandir|walk|glob|iglob|readlines|Path|subprocess|popen|system|exec|spawn|eval|require|import|from\s+\w+\s+import|__import__|fs\.|os\.|io\.|path\.)\b/i;

function collectInspectableTexts(segments, depth = 0) {
  if (depth > 4) return [];
  const texts = [];
  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx], pipelineCmds = [getSegmentCmdName(seg)];
    for (let j = idx + 1; j < segments.length && ["|", "|&"].includes(segments[j].leadingSep); j++) pipelineCmds.push(getSegmentCmdName(segments[j]));
    const inspectable = getInspectableTextForSegment(seg, { hasDownstreamPipe: pipelineCmds.length > 1 });
    if (inspectable) texts.push(inspectable);
    const wrapped = extractSimpleWrappedScript(seg.text);
    if (wrapped?.innerScript) texts.push(...collectInspectableTexts(splitShellSegments(wrapped.innerScript), depth + 1));
    for (const sub of seg.subshells || []) texts.push(...collectInspectableTexts(splitShellSegments(sub), depth + 1));
    if (seg.heredocBodies?.length) {
      const hasShell = pipelineCmds.some((c) => SHELL_INTERPRETERS.has(c)), hasXargs = pipelineCmds.includes("xargs");
      const hasCode = !seg.hasWriteRedirect && pipelineCmds.some((c) => CODE_INTERPRETERS.has(c));
      const writesExecScript = seg.hasWriteRedirect && extractRedirectTargets(getSegTokens(seg), true).some(isExecutableScriptPath);
      for (const hd of seg.heredocBodies) if (hd) { if (hasShell) texts.push(...collectInspectableTexts(splitShellSegments(hd), depth + 1)); else if (hasXargs || (hasCode && CODE_FILE_ACCESS_RE.test(hd)) || writesExecScript || /^\s*#!/.test(hd)) texts.push(hd); }
    }
  }
  return texts;
}

const dedupCwds = (list) => [...new Set(list.map((c) => c || ""))];
const isAccessibleDirectory = (d) => { if (!d) return false; try { return fs.statSync(d).isDirectory() && (fs.accessSync(d, fs.constants.X_OK), true); } catch { return false; } };

function stepCdDirectorySet(tokens, cmdIdx, endIdx, curCwds, oldCwds, { inPipeline = false, inCompoundBranch = false, nextLeadingSep = "" } = {}) {
  const posTokens = [];
  let sawDD = false, malformed = false;
  for (let i = cmdIdx + 1; i < endIdx; i++) {
    const r = skipSingleRedirect(tokens, i);
    if (r) { if (r.missingTarget) malformed = true; i = r.nextIdx - 1; continue; }
    const tok = tokens[i], v = tok.value;
    if (!sawDD && v === "--") { sawDD = true; continue; }
    if (!sawDD && (["-L", "-P", "-e", "-@"].includes(v) || v.toLowerCase() === "/d")) continue;
    if (!sawDD && v.startsWith("-") && v !== "-") { malformed = true; continue; }
    posTokens.push(tok);
  }
  // shortcut: glob, dynamic, or ambiguous cd marks cwd uncertain instead of expanding globs, upgrade if multi-dir glob cd is needed
  const fallback = () => ({ cwds: dedupCwds([...curCwds, getProfileHomeDir()]), uncertain: true });
  if (malformed || posTokens.length > 1) return fallback();
  const targetTok = posTokens[0] || null;
  if (!targetTok) {
    const home = getProfileHomeDir(), must = !inPipeline && !inCompoundBranch && (nextLeadingSep === "&&" || isAccessibleDirectory(home));
    return { cwds: must ? [home] : dedupCwds([...curCwds, home]), uncertain: false };
  }
  const rawVal = targetTok.value;
  if (rawVal === "-") {
    if (!oldCwds?.length) return fallback();
    return { cwds: (!inPipeline && !inCompoundBranch && nextLeadingSep === "&&" && oldCwds.length === 1) ? [...oldCwds] : dedupCwds([...curCwds, ...oldCwds]), uncertain: false };
  }
  const hasExpansion = (!targetTok.quoted && /[$`%]/.test(targetTok.raw)) || (targetTok.quoted && targetTok.raw.includes('"') && /(?:^|[^\\])[$`]/.test(targetTok.raw));
  if (hasExpansion || /^~[^/\\]+/.test(rawVal) || targetTok.hasUnquotedGlob) return fallback();
  const nextCwds = dedupCwds(curCwds.map((c) => resolveHookPath(expandLeadingTilde(rawVal), c)));
  return { cwds: (!inPipeline && !inCompoundBranch && (nextLeadingSep === "&&" || nextCwds.every(isAccessibleDirectory))) ? nextCwds : dedupCwds([...curCwds, ...nextCwds]), uncertain: false };
}

function wouldNaiveScopeTouchProtected(baseCwd, pathspecs, sawDoubleDash, protectedDirs) {
  for (const raw of ((!sawDoubleDash || pathspecs.length === 0) ? [baseCwd || ".", ...pathspecs] : pathspecs)) {
    if (raw.startsWith(":")) return true;
    for (const target of expandAndResolvePathVariants(raw, baseCwd)) {
      const canon = resolveRealOrAncestorPath(target);
      for (const pDir of protectedDirs) { const cp = resolveRealOrAncestorPath(pDir); if (isContainedInDir(canon, cp) || isContainedInDir(cp, canon)) return true; }
    }
  }
  return false;
}

function resolveTrackedGitGrepCandidates(effectiveCwd, gitGlobalArgs, pathspecs, sawDoubleDash) {
  let cwd = effectiveCwd ? path.resolve(expandLeadingTilde(effectiveCwd)) : process.cwd(), workTree = "";
  const gitArgs = [];
  for (let i = 0; i < gitGlobalArgs.length; i++) {
    const a = gitGlobalArgs[i];
    if (a === "-C" && gitGlobalArgs[i + 1]) { cwd = path.resolve(cwd, expandLeadingTilde(gitGlobalArgs[++i])); continue; }
    if (a === "--work-tree" && gitGlobalArgs[i + 1]) { workTree = path.resolve(cwd, expandLeadingTilde(gitGlobalArgs[i + 1])); gitArgs.push(a, gitGlobalArgs[++i]); continue; }
    if (a.startsWith("--work-tree=")) workTree = path.resolve(cwd, expandLeadingTilde(a.slice(12)));
    gitArgs.push(a);
  }
  if (!isAccessibleDirectory(cwd) || pathspecs.some((sp) => sp.startsWith(":"))) return { ok: false };
  if (!sawDoubleDash && pathspecs.length > 0) {
    for (const sp of pathspecs) { try { fs.lstatSync(path.resolve(workTree || cwd, sp)); } catch { return { ok: false }; } }
  }
  const topRes = spawnSync("git", [...gitArgs, "rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", timeout: 1500, maxBuffer: 64 * 1024, windowsHide: true });
  if (topRes.error || topRes.signal || topRes.status !== 0 || !topRes.stdout?.trim()) return { ok: false };
  const topLevel = path.resolve(cwd, topRes.stdout.trim());
  const lsRes = spawnSync("git", [...gitArgs, "ls-files", "-z", "--full-name", "--", ...pathspecs], { cwd, encoding: "buffer", timeout: 2000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  if (lsRes.error || lsRes.signal || lsRes.status !== 0 || !Buffer.isBuffer(lsRes.stdout)) return { ok: false };
  const buf = lsRes.stdout;
  if (buf.length === 0) return { ok: true, topLevel, files: [] };
  if (buf[buf.length - 1] !== 0) return { ok: false };
  const files = [];
  for (let i = 0, start = 0; i < buf.length; i++) {
    if (buf[i] !== 0) continue;
    if (i > start) { if (files.length >= 10000) return { ok: false }; files.push(path.resolve(topLevel, buf.subarray(start, i).toString("utf-8"))); }
    start = i + 1;
  }
  return { ok: true, topLevel, files };
}

export function inspectShellCommandScope(commandOrSegments, initialCwd = "", { depth = 0, protectedDirs = [], out = [] } = {}) {
  if (depth > 12) { out.push({ value: initialCwd || ".", cwd: initialCwd || "", globPositions: [], isOperand: true, recursive: true, uncertainCwd: true, depthExceeded: true }); return out; }
  const segments = Array.isArray(commandOrSegments) ? commandOrSegments : splitShellSegments(commandOrSegments);
  if (!segments.length) return out;
  const shellPipeline = new Set();
  for (let i = segments.length - 1; i >= 0; i--) {
    if (SHELL_INTERPRETERS.has(getSegmentCmdName(segments[i])) || (segments[i + 1] && ["|", "|&"].includes(segments[i + 1].leadingSep) && shellPipeline.has(i + 1))) shellPipeline.add(i);
  }
  let cwds = [initialCwd || ""], oldCwds = null, prePrevCwds = null, branchBaseCwds = null, cwdUncertain = false;
  const { perSegment, unclosedCompound } = analyzeSegmentCommandStarts(segments);
  const emitItems = (items, baseCwd, rec, unc) => {
    for (const item of items) for (const cand of expandItemPathCandidates(item)) {
      if (cand.value && (cand.isOperand || !cand.value.startsWith("-"))) out.push({ value: cand.value, cwd: baseCwd, globPositions: cand.globPositions, isOperand: cand.isOperand, recursive: rec, uncertainCwd: unc });
    }
  };
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx], segInfo = perSegment[segIdx];
    if (seg.leadingSep === "||" && prePrevCwds) cwds = dedupCwds([...cwds, ...prePrevCwds]);
    if (segInfo.inCompoundBranch && !branchBaseCwds) branchBaseCwds = [...cwds];
    const segCwds = [...cwds], segUnc = cwdUncertain, tokens = getSegTokens(seg);
    const hasPipeOut = segIdx + 1 < segments.length && ["|", "|&"].includes(segments[segIdx + 1].leadingSep);
    const redirToks = extractRedirectTargetTokens(tokens, false);
    for (const baseCwd of segCwds) {
      if (segInfo.uncertainSyntax || unclosedCompound) out.push({ value: baseCwd || ".", cwd: baseCwd, globPositions: [], isOperand: true, recursive: true, uncertainCwd: segUnc });
      emitItems(segInfo.forWordTokens.map((fw) => ({ value: fw.value, globPositions: fw.globPositions, isOperand: true })), baseCwd, false, segUnc);
      for (const rt of redirToks) out.push({ value: rt.value, cwd: baseCwd, globPositions: rt.globPositions, isOperand: true, recursive: false, uncertainCwd: segUnc });
    }
    for (const { startPos, cmdIdx, endIdx } of segInfo.starts) {
      if (cmdIdx >= tokens.length || cmdIdx >= endIdx) continue;
      const wrapperLocalCwd = extractWrapperLocalCwd(tokens, startPos, cmdIdx);
      const role = classifyCommandRoles(tokens, startPos, cmdIdx, endIdx, { hasDownstreamPipe: hasPipeOut });
      if (role.verb === "cd") {
        const nextSep = segIdx + 1 < segments.length ? segments[segIdx + 1].leadingSep : "";
        const cdStep = stepCdDirectorySet(tokens, cmdIdx, endIdx, segCwds, oldCwds, { inPipeline: ["|", "|&"].includes(seg.leadingSep) || ["|", "|&"].includes(nextSep), inCompoundBranch: segInfo.inCompoundBranch, nextLeadingSep: nextSep });
        prePrevCwds = segCwds; oldCwds = segCwds; cwds = cdStep.cwds; if (cdStep.uncertain) cwdUncertain = true;
        for (const baseCwd of segCwds) emitItems(role.pathItems, baseCwd, false, segUnc);
        continue;
      }
      let cmdCwds = wrapperLocalCwd ? dedupCwds(segCwds.map((c) => resolveHookPath(expandLeadingTilde(wrapperLocalCwd), c))) : segCwds;
      if (role.localCwd) cmdCwds = dedupCwds(cmdCwds.map((c) => resolveHookPath(expandLeadingTilde(role.localCwd), c)));
      if (role.gitGrepScope) {
        const { gitGlobalArgs, sawDoubleDash, pathspecs, nonPathspecItems } = role.gitGrepScope;
        for (const baseCwd of cmdCwds) {
          emitItems(nonPathspecItems, baseCwd, false, segUnc);
          const needsQuery = gitGlobalArgs.some((a) => a === "--work-tree" || a.startsWith("--work-tree=") || a === "--git-dir" || a.startsWith("--git-dir=")) || wouldNaiveScopeTouchProtected(baseCwd, pathspecs, sawDoubleDash, protectedDirs);
          if (!needsQuery) {
            for (const sp of (pathspecs.length > 0 ? pathspecs : [baseCwd || "."])) out.push({ value: sp, cwd: baseCwd, globPositions: [], isOperand: true, recursive: true, uncertainCwd: segUnc });
          } else {
            const spawnBaseCwd = wrapperLocalCwd ? resolveHookPath(expandLeadingTilde(wrapperLocalCwd), segCwds[0] || "") : (segCwds.includes(baseCwd) ? baseCwd : (segCwds[0] || baseCwd));
            const tracked = resolveTrackedGitGrepCandidates(spawnBaseCwd, gitGlobalArgs, pathspecs, sawDoubleDash);
            if (!tracked.ok) out.push({ value: baseCwd || ".", cwd: baseCwd, globPositions: [], isOperand: true, recursive: true, uncertainCwd: true, uncertainFailClosed: true });
            else for (const absFile of tracked.files) out.push({ value: absFile, cwd: tracked.topLevel, globPositions: [], isOperand: true, recursive: false, uncertainCwd: segUnc });
          }
        }
        continue;
      }
      for (const baseCwd of cmdCwds) {
        if (role.implicitCwd) out.push({ value: baseCwd || ".", cwd: baseCwd, globPositions: [], isOperand: true, recursive: true, uncertainCwd: segUnc });
        emitItems(role.pathItems, baseCwd, role.recursive, segUnc);
      }
      if ((role.verb === "echo" || role.verb === "printf") && shellPipeline.has(segIdx)) {
        const pipedScript = tokens.slice(cmdIdx + 1, endIdx).filter((_, k) => !skipSingleRedirect(tokens, cmdIdx + 1 + k)).map((t) => t.value).join(" ");
        if (pipedScript) for (const subCwd of cmdCwds) inspectShellCommandScope(pipedScript, subCwd, { depth: depth + 1, protectedDirs, out });
      }
    }
    if (!segInfo.inCompoundBranch && branchBaseCwds) { cwds = dedupCwds([...branchBaseCwds, ...cwds]); branchBaseCwds = null; }
    const wrapper = extractSimpleWrappedScript(seg.text);
    for (const subCwd of segCwds) {
      if (wrapper?.innerScript) inspectShellCommandScope(wrapper.innerScript, wrapper.localCwd ? resolveHookPath(expandLeadingTilde(wrapper.localCwd), subCwd) : subCwd, { depth: depth + 1, protectedDirs, out });
      for (const sub of seg.subshells || []) inspectShellCommandScope(sub, subCwd, { depth: depth + 1, protectedDirs, out });
      for (const hd of seg.heredocBodies || []) if (hd) inspectShellCommandScope(hd, subCwd, { depth: depth + 1, protectedDirs, out });
    }
  }
  return out;
}

function touchesCanonicalState(segments, ctx) {
  const stateDir = getStateDir(), seen = new Set();
  for (const entry of inspectShellCommandScope(segments, ctx.cwd || "", { protectedDirs: [stateDir] })) {
    if (entry.depthExceeded || entry.uncertainFailClosed) return true;
    const checkDesc = Boolean(entry.recursive || entry.globPositions?.length);
    const collapsed = collapseActiveShellGlob(entry.value, entry.globPositions);
    if (!collapsed || (!entry.isOperand && collapsed.startsWith("-"))) continue;
    const key = `${checkDesc}\0${entry.cwd}\0${collapsed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const target of expandAndResolvePathVariants(collapsed, entry.cwd)) {
      if (isContainedInDir(target, stateDir) || (checkDesc && isContainedInDir(stateDir, target))) return true;
    }
  }
  return false;
}

function areAllSegmentsReadOnlyTranscriptReads(segments) {
  if (!segments.length) return false;
  const { perSegment, unclosedCompound } = analyzeSegmentCommandStarts(segments);
  if (unclosedCompound) return false;
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx], segInfo = perSegment[segIdx], tokens = getSegTokens(seg);
    if (seg.hasSubshell || seg.hasHeredoc || segInfo.uncertainSyntax || !segInfo.starts.length || (seg.hasWriteRedirect && extractRedirectTargets(tokens, true).some((t) => !/^(?:\/dev\/null|nul)$/i.test(t)))) return false;
    for (const { cmdIdx, endIdx } of segInfo.starts) {
      if (cmdIdx >= tokens.length || cmdIdx >= endIdx) return false;
      const verb = normalizeCmdName(tokens[cmdIdx].value), args = [];
      for (let i = cmdIdx + 1; i < endIdx; i++) { const r = skipSingleRedirect(tokens, i); if (r) { if (r.missingTarget) return false; i = r.nextIdx - 1; continue; } args.push(tokens[i].value); }
      if (!isReadOnlyTranscriptVerb(verb) && !(verb === "rtk" && ["read", "grep", "ls"].includes(String(args[0] || "")))) return false;
      if ((verb === "sort" && args.some((v) => v === "--output" || v.startsWith("--output=") || /^-[^-]*o/.test(v) || v.startsWith("--compress-program"))) ||
          (verb === "rg" && args.some((v) => /^(?:--pre|--hostname-bin)(?:=|$)/.test(v))) ||
          (verb === "file" && args.some((v) => v === "--compile" || /^-[^-]*C/.test(v))) ||
          (verb === "uniq" && args.filter((v) => !v.startsWith("-")).length > 1) ||
          (verb === "jq" && args.some((v) => /^(?:-L|--(?:argfile|slurpfile|rawfile|from-file))/.test(v)))) return false;
    }
  }
  return true;
}

function getProtectedShellOperationReason(text, convId, ctx) {
  if (!text || typeof text !== "string") return null;
  if (isProtectedInternalState(text)) return "internal-state";
  if (/(?:^|[\s;|&(])(?:AGY_TEST_PROFILE_DIR|AGY_BRAIN_DIR|GEMINI_CONVERSATION_ID)=/i.test(text) || /(?:process\.env|os\.environ)\s*(?:\.\s*(?:AGY_TEST_PROFILE_DIR|AGY_BRAIN_DIR|GEMINI_CONVERSATION_ID)\b|\[\s*['"](?:AGY_TEST_PROFILE_DIR|AGY_BRAIN_DIR|GEMINI_CONVERSATION_ID)['"]\s*\])/i.test(text)) return "governance-env";
  if ((/(?:^|[\s;|&(])(?:XDG_STATE_HOME|LOCALAPPDATA)=/i.test(text) || /(?:process\.env|os\.environ)\s*(?:\.\s*(?:XDG_STATE_HOME|LOCALAPPDATA)\b|\[\s*['"](?:XDG_STATE_HOME|LOCALAPPDATA)['"]\s*\])/i.test(text)) &&
      (/\bagy-context(?:-saver)?\b|\bexecution-guard\b|\.gemini\b/i.test(text) || getEffectiveMode(convId, undefined, getBrainDirs({ activeTranscriptPath: ctx?.transcriptPath || "" })).restricted)) return "governance-env";
  if (/\.gemini[\/\\]+antigravity(?:-cli|-ide)?[\/\\]+brain[\/\\]+(?![^\/\\\s'"]+[\/\\](?:scratch|browser_sandbox|swarm_view|\.agents)(?:$|[\/\\])|[^\/\\\s'"]+[\/\\][^\/\\\s'"]+\.(?:md|txt|json|csv|tsv|yaml|yml|xml|zip|png|jpg|jpeg|gif|svg|html|css|webp|bmp|ico|pdf|mp3|wav|mp4|webm|mov)\b)/i.test(text) &&
      /\b(?:ln|cp|mv|rsync|tar|zip|find|readdir|readdirSync|scandir|listdir|walk|glob|iglob|readFile|readFileSync|createReadStream|open|openSync)\b/i.test(text)) return "internal-state";
  return null;
}

const buildProtectedShellReasonMessage = (code, convId, ctx) => code === "governance-env"
  ? "Antigravity Execution Governance: Overriding Antigravity governance/state environment variables (AGY_TEST_PROFILE_DIR, AGY_BRAIN_DIR, GEMINI_CONVERSATION_ID, or governance-scoped XDG_STATE_HOME/LOCALAPPDATA) inside shell commands is prohibited."
  : buildInternalStateShellDenial(convId, ctx);

const GH_VALUE_FLAGS = new Set(["-R", "--repo", "-i", "--interval", "-q", "--jq", "-t", "--template", "-H", "--hostname"]);

function findBlockingWatchLoop(segments, depth = 0) {
  if (depth > 4) return null;
  const { perSegment } = analyzeSegmentCommandStarts(segments, { allowPartialCompound: depth > 0 });
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx], tokens = getSegTokens(seg);
    for (const { cmdIdx: baseIdx, endIdx } of perSegment[segIdx].starts) {
      let idx = baseIdx;
      while (idx < endIdx) { const r = skipSingleRedirect(tokens, idx); if (r) { idx = r.nextIdx; continue; } if (normalizeCmdName(tokens[idx].value) === "rtk") { idx++; continue; } break; }
      if (idx < endIdx && normalizeCmdName(tokens[idx].value) === "gh") {
        const rest = [], pos = [];
        for (let k = idx + 1; k < endIdx; k++) { const r = skipSingleRedirect(tokens, k); if (r) { k = r.nextIdx - 1; continue; } rest.push(tokens[k].value); }
        let hasHelp = false, hasWatch = false, afterDD = false;
        for (let i = 0; i < rest.length; i++) {
          const tok = String(rest[i] || "");
          if (!afterDD && tok === "--") { afterDD = true; continue; }
          if (!afterDD && tok.startsWith("-") && tok !== "-") {
            if (tok === "--help" || tok === "-h") { hasHelp = true; break; }
            if (tok === "--watch" || /^--watch=(?:true|1|yes)$/i.test(tok) || (!/^-[RiqHt].+/.test(tok) && /^-[a-zA-Z]*w[a-zA-Z]*$/.test(tok))) { hasWatch = true; continue; }
            if (GH_VALUE_FLAGS.has(tok) && i + 1 < rest.length) i++;
            continue;
          }
          pos.push(tok.toLowerCase());
        }
        if (!hasHelp && pos[0] === "pr" && pos[1] === "checks" && hasWatch) return { command: "gh pr checks --watch" };
        if (!hasHelp && pos[0] === "run" && pos[1] === "watch") return { command: "gh run watch" };
      }
    }
    const w = extractSimpleWrappedScript(seg.text);
    if (w?.innerScript) { const r = findBlockingWatchLoop(splitShellSegments(w.innerScript), depth + 1); if (r) return r; }
    for (const sub of seg.subshells || []) { const r = findBlockingWatchLoop(splitShellSegments(sub), depth + 1); if (r) return r; }
    if (seg.heredocBodies?.length && segmentPipesToShell(segments, segIdx)) for (const hd of seg.heredocBodies) if (hd) { const r = findBlockingWatchLoop(splitShellSegments(hd), depth + 1); if (r) return r; }
  }
  return null;
}

// ============================================================================
// Unified `rtk read` & Degraded `head`/`tail` Bounded Read Parser
// ============================================================================

const RTK_READ_ALLOWED_LEVELS = new Set(["none", "minimal", "aggressive"]);

function parseBoundedReadCommand(cmd, mode) {
  if (!cmd || typeof cmd !== "string") return null;
  const tokens = tokenizeShellWords(cmd);
  if (tokens.length < 2) return null;
  let argStart = -1;
  if (mode === "rtk") {
    if (normalizeCmdName(tokens[0]) === "rtk" && tokens[1].toLowerCase() === "read") argStart = 2;
    else if (tokens.length >= 3 && normalizeCmdName(tokens[0]) === "node" && isTrustedLocalRtkLauncherPath(tokens[1]) && tokens[2].toLowerCase() === "read") argStart = 3;
  } else {
    const v = normalizeCmdName(tokens[0]);
    if (v === "head" || v === "tail") argStart = 1;
  }
  if (argStart === -1) return null;

  const operands = [];
  const lineLimits = [];
  let hasInvalidBound = false;
  let hasDisallowedFlag = false;
  let afterDD = false;
  const recordLimit = (rawVal) => {
    const n = /^\d+$/.test(rawVal) ? Number(rawVal) : NaN;
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_SPILLOVER_SLICE_LINES) hasInvalidBound = true;
    else lineLimits.push(n);
  };

  for (let i = argStart; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!afterDD && tok === "--") { afterDD = true; continue; }
    if (afterDD || !tok.startsWith("-") || tok === "-") { operands.push(tok); continue; }

    if (mode === "rtk") {
      if (["--head-lines", "--tail-lines", "--max-lines", "-m"].includes(tok)) { if (i + 1 >= tokens.length) hasInvalidBound = true; else recordLimit(tokens[++i]); continue; }
      const eq = tok.indexOf("=");
      if (eq > 0) {
        const fl = tok.slice(0, eq);
        const fv = tok.slice(eq + 1);
        if (["--head-lines", "--tail-lines", "--max-lines"].includes(fl)) { recordLimit(fv); continue; }
        if (fl === "--level") { if (!RTK_READ_ALLOWED_LEVELS.has(fv.toLowerCase())) hasDisallowedFlag = true; continue; }
        hasDisallowedFlag = true; continue;
      }
      if (tok.startsWith("-m") && tok.length > 2) { recordLimit(tok.slice(2)); continue; }
      if (tok === "-l" || tok === "--level") { if (!RTK_READ_ALLOWED_LEVELS.has((tokens[++i] || "").toLowerCase())) hasDisallowedFlag = true; continue; }
      if (tok.startsWith("-l") && tok.length > 2) { if (!RTK_READ_ALLOWED_LEVELS.has(tok.slice(2).toLowerCase())) hasDisallowedFlag = true; continue; }
      if (/^(?:-n|--line-numbers|--skip-env|-h|--help)$/i.test(tok) || /^-[nh]+$/i.test(tok)) continue;
      hasDisallowedFlag = true;
    } else {
      if (tok === "-n" || tok === "--lines") { if (i + 1 >= tokens.length) hasInvalidBound = true; else recordLimit(tokens[++i]); continue; }
      if (tok.startsWith("--lines=")) { recordLimit(tok.slice(8)); continue; }
      if (tok.startsWith("-n") && tok.length > 2) { recordLimit(tok.slice(2)); continue; }
      hasDisallowedFlag = true;
    }
  }
  return { operands, hasSafeLineBound: lineLimits.length > 0 && !hasInvalidBound, hasDisallowedFlag };
}

// ============================================================================
// Narrow High-ROI RTK Pre-Gate (`AGY_RTK_MODE=pregate|off`, B1)
// ============================================================================

const RTK_HIGH_ROI_DIRECT_CMDS = new Set(["pytest", "vitest", "jest", "playwright", "ctest", "phpunit", "pest", "paratest", "rspec", "mvn", "mvnd", "gradlew", "sbt", "tsc", "eslint", "ruff", "mypy", "ty", "prettier", "phpstan", "rubocop", "golangci-lint", "sqlfluff", "ecs", "pint"]);
const RTK_HIGH_ROI_SUBCMDS = {
  cargo: new Set(["test", "build", "check", "clippy", "install"]),
  go: new Set(["test", "build", "vet"]),
  dotnet: new Set(["build", "restore"]),
  npm: new Set(["run", "lint"]),
  pnpm: new Set(["run", "install", "i", "outdated", "lint", "tsc", "list"]),
  bun: new Set(["test", "build", "install", "add"]),
  deno: new Set(["test", "compile", "install", "lint", "check"]),
  npx: new Set(["tsc", "eslint", "vitest", "jest", "playwright", "prettier", "prisma", "next", "ng"]),
  bunx: new Set(["tsc", "eslint", "vitest", "jest", "playwright", "prettier", "prisma", "next", "ng"]),
  uv: new Set(["run", "sync", "pip"]),
  pip: new Set(["install", "list", "outdated"]),
  pip3: new Set(["install", "list", "outdated"]),
  next: new Set(["build"]),
  ng: new Set(["build"]),
  prisma: new Set(["generate", "migrate", "db"]),
  docker: new Set(["build", "compose", "ps", "images", "logs"]),
  kubectl: new Set(["get", "logs", "describe", "apply"]),
  oc: new Set(["get", "logs", "describe", "apply"]),
  git: new Set(["status", "push", "pull", "fetch"])
};
const RTK_HIGH_ROI_PKG_RUN_SCRIPTS = new Set(["lint"]);
const RTK_RUNNER_VALUE_FLAGS = {
  git: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]),
  npm: new Set(["--prefix", "-C", "--cwd", "--workspace", "-w"]),
  pnpm: new Set(["--dir", "-C", "--filter", "-F", "--prefix"]),
  bun: new Set(["--cwd"]),
  npx: new Set(["-p", "--package", "-c", "--call"]),
  bunx: new Set(["-p", "--package"]),
  uv: new Set(["--directory", "--project", "--python", "-p", "--with", "--group", "--extra"]),
  docker: new Set(["-H", "--host", "--context", "--config", "-l", "--log-level"]),
  kubectl: new Set(["-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user"]),
  oc: new Set(["-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user"])
};
const MACHINE_FORMAT_RE = /^(?:json|jsonl|ndjson|yaml|yml|sarif|checkstyle|junit|tap|xml|csv|tsv|jsonpath|custom-columns|go-template|name|compact|unix|concise|rdjson|gitlab|github|blob|dot|short)(?:[=:]|$)/i;

const getAgyRtkMode = () => ["off", "none", "disabled"].includes(String(process.env.AGY_RTK_MODE || "pregate").trim().toLowerCase()) ? "off" : "pregate";

function matchRtkInvocation(text) {
  const direct = text.match(/^((?:["']?[^\s"']*[/\\])?rtk(?:\.exe|\.cmd|\.bat)?["']?\s+)([\s\S]+)$/i);
  if (direct) return { rtkWord: direct[1], rest: direct[2] };
  const launcher = text.match(/^(node(?:\.exe)?\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))\s+)([\s\S]+)$/i);
  if (launcher && isTrustedLocalRtkLauncherPath(launcher[2] || launcher[3] || launcher[4] || "")) return { rtkWord: launcher[1], rest: launcher[5] };
  return null;
}

function hasMachineReadableOutputFlag(cmd0, subcmd, tokens) {
  const effectiveTool = (cmd0 === "npx" || cmd0 === "bunx") ? subcmd : cmd0;
  const isVitestOrJest = effectiveTool === "vitest" || effectiveTool === "jest";
  for (let i = 1; i < tokens.length; i++) {
    const v = tokens[i].value;
    const low = v.toLowerCase();
    if (
      isVitestOrJest &&
      (low === "--reporter" || low.startsWith("--reporter=") || low === "--reporters" || low.startsWith("--reporters="))
    ) return true;
    if (
      ["--json", "-json", "--porcelain", "--raw", "-ojson", "-oyaml", "-oname"].includes(low) ||
      low.startsWith("--porcelain=") || low.startsWith("-ojsonpath") || low.startsWith("-ocustom-columns") || low.startsWith("-ogo-template") ||
      (low.startsWith("-o=") && MACHINE_FORMAT_RE.test(low.slice(3))) ||
      (/^--(?:format|output|output-format|out-format|message-format|reporter)=/.test(low) && MACHINE_FORMAT_RE.test(low.slice(low.indexOf("=") + 1)))
    ) return true;
    if (["-o", "--output", "--format", "-f", "--output-format", "--out-format", "--message-format", "--reporter"].includes(low) &&
        i + 1 < tokens.length && MACHINE_FORMAT_RE.test(tokens[i + 1].value.toLowerCase())) return true;
    if (cmd0 === "docker" && (low === "--format" || low.startsWith("--format=") || low === "--quiet" || (!v.startsWith("--") && /^-[a-zA-Z]*q[a-zA-Z]*$/.test(v)))) return true;
    if (cmd0 === "git" && subcmd === "status" && (v === "--short" || low.startsWith("--porcelain") || (!v.startsWith("--") && /^-[a-zA-Z]*[sz][a-zA-Z]*$/.test(v)))) return true;
  }
  return false;
}

function findNearestNodeModulesBin(toolName, startDir) {
  if (!toolName || !startDir) return "";
  const isWin = os.platform() === "win32";
  const exts = isWin ? [".cmd", ".exe", ".bat", ""] : [""];
  let dir = path.resolve(startDir);
  while (true) {
    const binDir = path.join(dir, "node_modules", ".bin");
    for (const ext of exts) {
      const candidate = path.join(binDir, `${toolName}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

function isLocalBinShadowedByGlobalPath(toolName, startDir) {
  const localBin = findNearestNodeModulesBin(toolName, startDir);
  if (!localBin) return false;
  const pathBin = findExecutableOnPath(toolName);
  if (!pathBin) return false;
  const isCI = os.platform() === "win32" || os.platform() === "darwin";
  const norm = (p) => {
    const r = tryRealpath(path.resolve(p)).replace(/\\/g, "/");
    return isCI ? r.toLowerCase() : r;
  };
  return norm(localBin) !== norm(pathBin);
}

function findNearestVitestMajorVersion(startDir) {
  if (!startDir) return null;
  let dir = path.resolve(startDir);
  while (true) {
    const pkgPath = path.join(dir, "node_modules", "vitest", "package.json");
    try {
      if (fs.statSync(pkgPath).isFile()) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        const match = String(pkg?.version || "").match(/^(\d+)\./);
        return match ? parseInt(match[1], 10) : null;
      }
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isUnsupportedVitestForRtk(startDir, rtkVersion) {
  if (!isRtkVersionBelow(rtkVersion, 1, 2)) return false;
  const major = findNearestVitestMajorVersion(startDir);
  return major !== null && major >= 5;
}

function resolveNextSegmentCwd(segText, curCwd) {
  const trimmed = String(segText || "").trim();
  if (!trimmed) return curCwd;
  const tokens = tokenizeShellWordsDetailed(trimmed);
  const cmdIdx = stripLeadingShellPrefixes(tokens, 0, { includeControlKeywords: false });
  if (cmdIdx >= tokens.length || normalizeCmdName(tokens[cmdIdx].value) !== "cd") return curCwd;
  const stepped = stepCdDirectorySet(tokens, cmdIdx, tokens.length, [curCwd], null, { nextLeadingSep: "&&" });
  return !stepped.uncertain && stepped.cwds.length === 1 ? stepped.cwds[0] : curCwd;
}

function filterAllowedStderrRedirects(tokens) {
  const clean = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (isUnquotedRedir(t)) {
      if (t.raw === "2>&" && tokens[i + 1]?.value === "1") { i++; continue; }
      if (t.raw === "2>" && /^(?:\/dev\/null|nul)$/i.test(tokens[i + 1]?.value || "")) { i++; continue; }
      if (/^2>&1$/i.test(t.raw) || /^2>(?:\/dev\/null|nul)$/i.test(t.raw)) continue;
      return null;
    }
    clean.push(t);
  }
  return clean;
}

function shouldDelegateSegmentToRtk(segText, { inPipeline = false, allowInternalReadRewrite = false, cwd = "", rtkVersion = "" } = {}) {
  const trimmed = String(segText || "").trim();
  if (!trimmed || inPipeline) return false;
  const target = (splitEnvPrefix(trimmed).body || trimmed).trim();
  if (!target || matchRtkInvocation(target)) return false;

  const tokens = filterAllowedStderrRedirects(tokenizeShellWordsDetailed(target));
  if (!tokens || tokens.length === 0) return false;
  const cmd0 = normalizeCmdName(tokens[0].value);
  if (!cmd0) return false;
  const effectiveCwd = cwd ? path.resolve(expandLeadingTilde(cwd)) : process.cwd();
  if (allowInternalReadRewrite && (cmd0 === "cat" || cmd0 === "head" || cmd0 === "tail")) return true;
  if (RTK_HIGH_ROI_DIRECT_CMDS.has(cmd0)) {
    if (cmd0 === "vitest" && isUnsupportedVitestForRtk(effectiveCwd, rtkVersion)) return false;
    return !hasMachineReadableOutputFlag(cmd0, "", tokens);
  }
  if (cmd0 === "rake") { const sub = normalizeCmdName(tokens[1]?.value); return (sub === "test" || sub.startsWith("test:")) && !hasMachineReadableOutputFlag(cmd0, sub, tokens); }
  if (cmd0 === "python" || cmd0 === "python3") {
    let idx = 1;
    while (idx < tokens.length && tokens[idx].value.startsWith("-") && tokens[idx].value !== "-m") idx++;
    const mod = tokens[idx]?.value === "-m" ? normalizeCmdName(tokens[idx + 1]?.value) : "";
    return (mod === "pytest" || mod === "mypy") && !hasMachineReadableOutputFlag(mod, "", tokens.slice(idx + 1));
  }

  const allowedSubs = RTK_HIGH_ROI_SUBCMDS[cmd0];
  if (!allowedSubs) return false;
  const valueFlags = RTK_RUNNER_VALUE_FLAGS[cmd0] || new Set();
  const advancePastFlags = (start, vf = valueFlags) => {
    let idx = start;
    while (idx < tokens.length && tokens[idx].value.startsWith("-") && tokens[idx].value !== "--") idx += vf.has(tokens[idx].value) ? 2 : 1;
    return idx;
  };
  const subIdx = advancePastFlags(1);
  const sub = subIdx < tokens.length ? normalizeCmdName(tokens[subIdx].value) : "";
  if (!sub || !allowedSubs.has(sub)) return false;

  if ((cmd0 === "npm" || cmd0 === "pnpm") && sub === "run") {
    const sIdx = advancePastFlags(subIdx + 1, new Set());
    const scriptName = String(tokens[sIdx]?.value || "").trim().toLowerCase();
    if (!RTK_HIGH_ROI_PKG_RUN_SCRIPTS.has(scriptName)) return false;
  }
  if (cmd0 === "npx" || cmd0 === "bunx") {
    if (isLocalBinShadowedByGlobalPath(sub, effectiveCwd)) return false;
    if (sub === "vitest" && isUnsupportedVitestForRtk(effectiveCwd, rtkVersion)) return false;
  }
  if (cmd0 === "pnpm" && sub === "tsc" && isLocalBinShadowedByGlobalPath("tsc", effectiveCwd)) return false;
  if (cmd0 === "uv" && sub === "run") {
    const rIdx = advancePastFlags(subIdx + 1);
    if (rIdx >= tokens.length) return false;
    const rc = normalizeCmdName(tokens[rIdx].value);
    if (["pytest", "ruff", "mypy", "ty"].includes(rc)) return !hasMachineReadableOutputFlag(rc, "", tokens.slice(rIdx));
    if ((rc === "python" || rc === "python3") && tokens[rIdx + 1]?.value === "-m") {
      const mod = normalizeCmdName(tokens[rIdx + 2]?.value);
      return (mod === "pytest" || mod === "mypy") && !hasMachineReadableOutputFlag(mod, "", tokens.slice(rIdx + 2));
    }
    return false;
  }
  if (cmd0 === "uv" && sub === "pip" && !["install", "list", "show"].includes(normalizeCmdName(tokens[advancePastFlags(subIdx + 1)]?.value))) return false;
  if (cmd0 === "docker" && sub === "compose") {
    const cIdx = advancePastFlags(subIdx + 1, new Set(["-f", "--file", "-p", "--project-name", "--env-file"]));
    if (!["ps", "logs", "build"].includes(normalizeCmdName(tokens[cIdx]?.value))) return false;
  }
  return !hasMachineReadableOutputFlag(cmd0, sub, tokens);
}

function delegateRewriteToRtk(rawCmd, rtk) {
  const res = spawnRtk(rtk.exe, ["hook", "antigravity"], {
    input: JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: rawCmd } } }),
    encoding: "utf-8", timeout: 2000, windowsHide: true
  });
  if (res.error || res.status !== 0 || !res.stdout) return { decision: "allow", commandLine: rawCmd };
  try {
    const p = JSON.parse(res.stdout.trim());
    if (p?.decision === "deny" || p?.decision === "force_ask") return { decision: p.decision, reason: p.reason || "Denied by RTK hook." };
    const rewritten = p?.overwrite?.CommandLine;
    return { decision: "allow", commandLine: typeof rewritten === "string" && rewritten.trim() ? rewritten : rawCmd };
  } catch { return { decision: "allow", commandLine: rawCmd }; }
}

function rewriteCommandViaRtkPreGate(rawCmd, rtk, { allowInternalReadRewrite = false, preSegments = null, cwd = "" } = {}) {
  const segs = preSegments || splitShellSegments(rawCmd);
  const baseCwd = cwd ? path.resolve(expandLeadingTilde(cwd)) : process.cwd();
  const segCwds = new Array(segs.length);
  let curCwd = baseCwd;
  for (let i = 0; i < segs.length; i++) {
    segCwds[i] = curCwd;
    const nextSep = i + 1 < segs.length ? segs[i + 1].leadingSep : "";
    if (segs[i].leadingSep !== "|" && segs[i].leadingSep !== "|&" && nextSep !== "|" && nextSep !== "|&" && nextSep !== "||") {
      curCwd = resolveNextSegmentCwd(segs[i].text, curCwd);
    }
  }
  let result = rawCmd;
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    const trimmed = seg.text.trim();
    if (!trimmed) continue;
    const wrap = unwrapShellWrapper(trimmed);
    if (wrap) {
      const inner = rewriteCommandViaRtkPreGate(wrap.inner, rtk, { allowInternalReadRewrite: false, cwd: segCwds[i] });
      if (inner.decision !== "allow") return inner;
      if (inner.commandLine !== wrap.inner) result = result.slice(0, seg.start) + `${wrap.prefix}${wrap.quote}${inner.commandLine}${wrap.quote}` + result.slice(seg.end);
      continue;
    }
    const inPipe = seg.leadingSep === "|" || seg.leadingSep === "|&" || (i + 1 < segs.length && (segs[i + 1].leadingSep === "|" || segs[i + 1].leadingSep === "|&"));
    if (!shouldDelegateSegmentToRtk(trimmed, { inPipeline: inPipe, allowInternalReadRewrite: Boolean(allowInternalReadRewrite && segs.length === 1), cwd: segCwds[i], rtkVersion: rtk?.version || "" })) continue;
    const del = delegateRewriteToRtk(trimmed, rtk);
    if (del.decision !== "allow") return del;
    if (del.commandLine && del.commandLine !== trimmed) result = result.slice(0, seg.start) + del.commandLine + result.slice(seg.end);
  }
  return { decision: "allow", commandLine: result };
}

function formatRtkPrefixForWrapperQuote(rtkPrefix, outerQuote, wrapperPrefix = "") {
  if (!rtkPrefix || !outerQuote) return rtkPrefix;
  if (/^cmd(?:\.exe)?\b/i.test(wrapperPrefix)) return rtkPrefix.includes('"') || rtkPrefix.includes("'") ? null : rtkPrefix;
  if (/^(?:powershell|pwsh)(?:\.exe)?\b/i.test(wrapperPrefix)) {
    if (outerQuote === '"') return /[$`]/.test(rtkPrefix) ? null : (rtkPrefix.includes('"') ? rtkPrefix.replace(/"([^"\r\n]*)"/g, (_, inner) => `'${inner.replace(/'/g, "''")}'`) : rtkPrefix);
    return outerQuote === "'" && rtkPrefix.includes("'") ? rtkPrefix.replace(/'/g, "''") : rtkPrefix;
  }
  if (outerQuote === '"') {
    if (/[$`]/.test(rtkPrefix)) return null;
    if (!rtkPrefix.includes('"')) return rtkPrefix;
    return !rtkPrefix.includes("'") ? rtkPrefix.replace(/"/g, "'") : rtkPrefix.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  return outerQuote === "'" && rtkPrefix.includes("'") ? rtkPrefix.replace(/'/g, "'\\''") : rtkPrefix;
}

function postProcessCommand(rawCmd, effCmd, rtkPrefix) {
  if (!rtkPrefix || rtkPrefix === "rtk") return effCmd;
  const rawSegs = splitShellSegments(rawCmd);
  const effSegs = splitShellSegments(effCmd);
  const sameCount = rawSegs.length === effSegs.length;
  let result = effCmd;
  for (let i = effSegs.length - 1; i >= 0; i--) {
    const seg = effSegs[i];
    const trimmedEff = seg.text.trim();
    const trimmedRaw = (sameCount ? rawSegs[i].text : rawCmd).trim();
    let replacement = trimmedEff;
    const effWrap = unwrapShellWrapper(trimmedEff);
    if (effWrap) {
      const rawWrap = unwrapShellWrapper(trimmedRaw);
      const wrappedPfx = formatRtkPrefixForWrapperQuote(rtkPrefix, effWrap.quote, effWrap.prefix);
      replacement = wrappedPfx === null ? (trimmedRaw || trimmedEff) : `${effWrap.prefix}${effWrap.quote}${postProcessCommand(rawWrap ? rawWrap.inner : effWrap.inner, effWrap.inner, wrappedPfx)}${effWrap.quote}`;
    } else {
      const { prefix: envPfx, body } = splitEnvPrefix(trimmedEff);
      const target = body || trimmedEff;
      if (!matchRtkInvocation(target)) {
        if (/^uv(?:\.exe)?\s+run\s+rtk(?:\.exe|\.cmd|\.bat)?(?=\s)/i.test(target)) {
          replacement = `${envPfx}${target.replace(/^(uv(?:\.exe)?\s+run\s+)rtk(?:\.exe|\.cmd|\.bat)?(?=\s)/i, (_, pfx) => `${pfx}${rtkPrefix}`)}`;
        }
      } else if (/^rtk(?:\.exe|\.cmd|\.bat)?\s+/i.test(target)) {
        replacement = `${envPfx}${target.replace(/^rtk(?:\.exe|\.cmd|\.bat)?(?=\s)/i, () => rtkPrefix)}`;
      }
    }
    if (replacement !== seg.text) result = result.slice(0, seg.start) + replacement + result.slice(seg.end);
  }
  return result;
}

// ============================================================================
// Main Section 1 Entrypoint (`handleRunCommand`)
// ============================================================================

export async function handleRunCommand(ctx) {
  const { args, convId, cwd } = ctx;
  const rawCmd = args.CommandLine !== undefined ? args.CommandLine : args.command;
  if (typeof rawCmd !== "string" || !rawCmd.trim()) {
    respond({ decision: "deny", reason: "Antigravity Governance: Missing or empty CommandLine in run_command." });
  }

  // Parse ONCE per run_command
  const segments = splitShellSegments(rawCmd);
  if (touchesCanonicalState(segments, ctx)) {
    respond({ decision: "deny", reason: "Antigravity Governance: Direct access to protected plugin state is prohibited." });
  }

  const mutVerdict = checkShellMutations(segments, convId, ctx);
  if (mutVerdict) respond(mutVerdict);

  const blockingWatch = findBlockingWatchLoop(segments);
  if (blockingWatch) {
    respond({
      decision: "deny",
      reason:
        `Antigravity Execution Governance: Blocking CI watch loop ('${blockingWatch.command}') stalls agents indefinitely when remote runners queue.\n` +
        "- Run a single non-blocking snapshot ('gh pr checks' or 'gh run list') instead.\n" +
        "- If waiting on remote CI, end your turn or use a backoff-compliant 'schedule' timer (DurationSeconds >= 30s initially, scaling 30s -> 75s -> 188s -> 469s -> 600s) rather than blocking inside run_command."
    });
  }

  let isSpillover = false;
  let spilloverTok = null;
  let taskMatch = null;
  let taskState = null;

  {
    const inspectableTexts = collectInspectableTexts(segments);
    const inspectableCombined = inspectableTexts.join("\n");
    const singleTokens = segments.length === 1 ? getSegTokens(segments[0]).map((t) => t.value) : [];
    const spilloverTokens = singleTokens.map(cleanFileToken).filter(isStepSpilloverPath);
    spilloverTok = spilloverTokens[0] || null;
    isSpillover = spilloverTokens.length > 0;
    const taskMatches = extractTaskLogMatches(inspectableCombined, convId, ctx, singleTokens);
    taskMatch = taskMatches[0] || null;

    if ((isSpillover || taskMatch) && !isSingleUnchainedShellCmd(segments)) {
      const hasRtk = Boolean(resolveCachedHostEnv().rtk);
      const reason = isSpillover
        ? (hasRtk
            ? "Antigravity Execution Governance: Runtime step output spillover files must be inspected using a single unchained 'rtk read <path>' command (no chaining, redirects, subshells, or '..' traversal)."
            : "Antigravity Execution Governance: Runtime step output spillover files must be inspected using a single unchained 'head -n 150 <path>' or 'tail -n 150 <path>' command (or bounded 'read_file' <= 150 lines; no chaining, redirects, subshells, or '..' traversal).")
        : (taskMatches.length > 0 && taskMatches.every((m) => getTaskState(m, convId, ctx) === "COMPLETED")
            ? (hasRtk
                ? "Antigravity Execution Governance: Completed task logs must be inspected using a single unchained 'rtk read <path>' command (no chaining, pipes, redirects, subshells, or '..' traversal)."
                : "Antigravity Execution Governance: Completed task logs must be inspected using a single unchained 'head -n 150 <path>' or 'tail -n 150 <path>' command (or bounded 'read_file' <= 150 lines; no chaining, pipes, redirects, subshells, or '..' traversal).")
            : buildInternalStateShellDenial(convId, ctx));
      respond({ decision: "deny", reason });
    }

    if (taskMatches.length > 0) {
      const states = taskMatches.map((m) => ({ match: m, state: getTaskState(m, convId, ctx) }));
      const running = states.find((e) => e.state === "RUNNING");
      if (running) {
        const { denyRunningTask } = await import("./task-guard.mjs");
        denyRunningTask(running.match.id, convId, running.match.token, ctx);
      }
      taskState = states.some((e) => e.state === "UNKNOWN") ? "UNKNOWN" : "COMPLETED";
    }

    let inspectRemainder = inspectableCombined;
    if ((isSpillover || taskMatch) && inspectableTexts.length === 1 && segments.length === 1) {
      const singleTok = isSpillover && !taskMatch && spilloverTokens.length === 1 ? spilloverTokens[0] : (!isSpillover && taskMatches.length === 1 ? taskMatches[0].token : "");
      if (singleTok) {
        const normTarget = cleanFileToken(singleTok).replace(/\\/g, "/");
        let removed = false;
        const remaining = singleTokens.filter((tok) => (!removed && cleanFileToken(tok).replace(/\\/g, "/") === normTarget ? ((removed = true), false) : true));
        if (removed) inspectRemainder = remaining.join(" ");
      }
    }

    if (areAllSegmentsReadOnlyTranscriptReads(segments)) inspectRemainder = stripTranscriptLogRefs(inspectRemainder);
    const protectedReason = getProtectedShellOperationReason(inspectRemainder, convId, ctx);
    if (protectedReason) respond({ decision: "deny", reason: buildProtectedShellReasonMessage(protectedReason, convId, ctx) });
  }

  // Narrow High-ROI RTK Pre-Gate (`AGY_RTK_MODE=pregate|off`)
  const { rtk } = resolveCachedHostEnv();
  const rtkMode = getAgyRtkMode();
  const allowInternalReadRewrite = Boolean(isSingleUnchainedShellCmd(segments) && (isSpillover || (taskMatch && taskState === "COMPLETED")));
  let effectiveCmd = rawCmd;

  if (rtk) {
    if (rtkMode === "pregate" || (rtkMode === "off" && allowInternalReadRewrite)) {
      const gated = rewriteCommandViaRtkPreGate(rawCmd, rtk, { allowInternalReadRewrite, preSegments: segments, cwd });
      if (gated.decision !== "allow") respond({ decision: gated.decision, reason: gated.reason });
      effectiveCmd = gated.commandLine;
    }
    if (effectiveCmd !== rawCmd || /\brtk(?:\.exe|\.cmd|\.bat)?\b/i.test(rawCmd)) {
      effectiveCmd = postProcessCommand(rawCmd, effectiveCmd, rtk.prefix);
    }
  }

  // Rewrite bare `agy-context` / `agy-context-saver` to installed shim when off PATH
  if (isSingleUnchainedShellCmd(segments) && !isSpillover && !taskMatch) {
    const bareAgy = effectiveCmd.match(/^(\s*)(agy-context(?:-saver)?(?:\.(?:cmd|exe|bat))?)(?=\s|$)/i);
    if (bareAgy && !findExecutableOnPath(normalizeCmdName(bareAgy[2]))) {
      const localAgyCmd = resolveInstalledAgyContextCommand(normalizeCmdName(bareAgy[2]));
      if (localAgyCmd) effectiveCmd = `${bareAgy[1]}${localAgyCmd}${effectiveCmd.slice(bareAgy[0].length)}`;
    }
  }

  // Spillover & Completed Task Log Parity + Single-Operand Isolation + >45 KiB Fail-Loud Check
  if (isSpillover || taskMatch) {
    const parsedEff = parseBoundedReadCommand(effectiveCmd, "rtk");
    const parsedRaw = parseBoundedReadCommand(rawCmd, "rtk");
    const parsedDegraded = !rtk ? parseBoundedReadCommand(effectiveCmd, "degraded") : null;
    const isSingleMatchingTarget = (parsed) => {
      if (!parsed || parsed.operands.length !== 1 || parsed.hasDisallowedFlag) return false;
      const op = cleanFileToken(parsed.operands[0]);
      return (isSpillover && !taskMatch && isStepSpilloverPath(op)) || (taskMatch && !isSpillover && Boolean(matchTaskLogToken(op, convId, ctx)));
    };
    const isDegradedBoundedRead = Boolean(parsedDegraded?.hasSafeLineBound && isSingleMatchingTarget(parsedDegraded));

    if (parsedEff && !isSingleMatchingTarget(parsedEff)) {
      respond({ decision: "deny", reason: "Antigravity Execution Governance: Internal step spillovers and task logs must be inspected strictly one file at a time using 'rtk read <path>' with valid read flags (multi-file operands and mixed targets are prohibited)." });
    }

    if (isSpillover) {
      if (rtk ? !parsedEff : !isDegradedBoundedRead) {
        respond({
          decision: "deny",
          reason: rtk
            ? "Antigravity Execution Governance: Runtime step output spillover files must be inspected using 'rtk read <path>' via run_command (or bounded 'read_file' <= 150 lines) to prevent context blowouts."
            : "Antigravity Execution Governance: Runtime step output spillover files must be inspected using a single unchained 'head -n 150 <path>' or 'tail -n 150 <path>' via run_command (or bounded 'read_file' <= 150 lines) to prevent context blowouts."
        });
      }
    }

    if (taskMatch) {
      const allowedTaskRead = rtk
        ? (taskState === "COMPLETED" ? Boolean(parsedEff) : Boolean(parsedRaw && parsedEff))
        : (taskState === "COMPLETED" && isDegradedBoundedRead);
      if (!allowedTaskRead) {
        respond({
          decision: "deny",
          reason: rtk
            ? "Antigravity Execution Governance: Direct shell access to internal Antigravity execution state (.system_generated) is strictly prohibited to prevent transcript bloat and polling loops.\n- Once completed, inspect output using 'rtk read <path>' via run_command (or bounded 'read_file' <= 150 lines).\n- If actively running, use Pure Yield (end turn; no 'schedule'/status card; await <SYSTEM_MESSAGE>)."
            : "Antigravity Execution Governance: Direct shell access to internal Antigravity execution state (.system_generated) is strictly prohibited to prevent transcript bloat and polling loops.\n- Once completed, inspect output using a single unchained 'head -n 150 <path>' or 'tail -n 150 <path>' via run_command (or bounded 'read_file' <= 150 lines).\n- If actively running, use Pure Yield (end turn; no 'schedule'/status card; await <SYSTEM_MESSAGE>)."
        });
      }
    }

    if (parsedEff && !parsedEff.hasSafeLineBound) {
      for (const tok of new Set([spilloverTok, taskMatch?.token, ...parsedEff.operands].filter(Boolean))) {
        for (const statPath of resolveInternalReadStatPaths(tok, convId, ctx, taskMatch, isSpillover)) {
          try {
            const st = fs.statSync(statPath);
            if (st.isFile()) {
              if (st.size > MAX_FULL_FILE_BYTES) {
                const kib = (st.size / 1024).toFixed(1);
                respond({
                  decision: "deny",
                  reason: `Antigravity Execution Governance: Unbounded 'rtk read' on >45 KiB spillover/task log (${kib} KiB) is denied to prevent cascading spillovers. Pass '--head-lines 150' or '--tail-lines 150' explicitly${isSpillover && !taskMatch ? " (or use bounded 'read_file' <= 150 lines)" : ""} instead.`
                });
              }
              break;
            }
          } catch {}
        }
      }
    }
  }

  const invocation = parseTranscriptInvocation(rawCmd);
  const hasRealCaller = Boolean(ctx.convId && ctx.convId !== "global");
  if (invocation && (hasRealCaller ? !invocation.clean : Boolean(process.env.GEMINI_CONVERSATION_ID))) {
    respond({ decision: "deny", reason: "Antigravity Governance: Run transcript commands as a single direct command so the hook can pass the caller identity." });
  }
  if (invocation?.clean && hasRealCaller) {
    const nonce = mintHookIdentity(ctx, invocation.command);
    if (!nonce) respond({ decision: "deny", reason: "Antigravity Governance: Unable to mint verified caller identity for transcript command." });
    effectiveCmd += ` --hook-grant=${nonce}`;
  }

  const isDaemon = args.IsDaemon === true || args.isDaemon === true;
  const rawWaitMs = args.WaitMsBeforeAsync !== undefined ? args.WaitMsBeforeAsync : args.waitMsBeforeAsync;
  const waitMs = rawWaitMs === null ? undefined : rawWaitMs;
  const overwrite = {};
  if (effectiveCmd !== rawCmd) overwrite.CommandLine = effectiveCmd;
  if (!isDaemon && waitMs === undefined) overwrite.WaitMsBeforeAsync = Number(process.env.AGY_MAX_WAIT_MS) || 10000;

  respond(Object.keys(overwrite).length > 0 ? { decision: "allow", overwrite } : { decision: "allow" });
}

const NODE_VALUE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--env-file", "--env-file-if-exists", "--watch-path", "--redirect-warnings", "--diagnostic-dir", "--heapsnapshot-near-heap-limit", "--title", "--openssl-config", "--icu-data-dir"]);
const XARGS_VALUE_FLAGS = new Set(["-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a", "--arg-file", "--max-args", "--max-procs", "--max-lines", "--replace", "--delimiter", "--eof", "--max-chars"]);

function isCleanTranscriptArgs(sub, args) {
  if (sub === "access") {
    if (args.length === 0) return true;
    if (args.length === 1) return ["status", "--help", "-h"].includes(args[0]);
    if (args.length === 2) return args[0] === "set" && Boolean(args[1]) && !args[1].startsWith("-");
    return false;
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json" || a === "--help" || a === "-h") continue;
    if (a.startsWith("--id=") || a.startsWith("--parent=")) {
      if (!a.slice(a.indexOf("=") + 1)) return false;
      continue;
    }
    if (a === "--id" || a === "--parent") {
      if (i + 1 >= args.length || !args[i + 1]) return false;
      i++;
      continue;
    }
    return false;
  }
  return true;
}

/** Recognize the actual argv, including quoted executable/subcommand words. */
export function parseTranscriptInvocation(command, depth = 0) {
  if (depth > 12) return { clean: false };
  if (!command.includes("transcript") && !/['"\\]/.test(command)) return null;
  const segments = splitShellSegments(command);
  const { perSegment, unclosedCompound } = analyzeSegmentCommandStarts(segments, { allowPartialCompound: depth > 0 });
  let matchCount = 0;
  let invocation = null;
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    const segInfo = perSegment[segIdx];
    const detailed = getSegTokens(seg);
    for (const { cmdIdx: initialCmdIdx, endIdx } of segInfo.starts) {
      let cmdIdx = initialCmdIdx;
      let viaXargs = false;
      while (cmdIdx < endIdx && normalizeCmdName(detailed[cmdIdx].value) === "xargs") {
        viaXargs = true;
        cmdIdx++;
        while (cmdIdx < endIdx) {
          const r = skipSingleRedirect(detailed, cmdIdx);
          if (r) { cmdIdx = r.nextIdx; continue; }
          if (!detailed[cmdIdx].value.startsWith("-")) break;
          const fl = detailed[cmdIdx++].value;
          if (fl === "--") break;
          if (XARGS_VALUE_FLAGS.has(fl) && cmdIdx < endIdx) cmdIdx++;
        }
      }
      if (cmdIdx >= endIdx) continue;
      const argvEntries = [];
      for (let k = cmdIdx; k < endIdx; k++) {
        const r = skipSingleRedirect(detailed, k);
        if (r) { k = r.nextIdx - 1; continue; }
        argvEntries.push({ value: detailed[k].value, origIdx: k });
      }
      if (argvEntries.length === 0) continue;
      const argv = argvEntries.map((e) => e.value);
      const name = normalizeCmdName(argv[0]);
      if ((name === "echo" || name === "printf") && segmentPipesToShell(segments, segIdx)) {
        if (parseTranscriptInvocation(argv.slice(1).join(" "), depth + 1)) matchCount++;
        continue;
      }
      const direct = /^agy-context(?:-saver)?(?:\.(?:cmd|exe|bat))?$/.test(name);
      const isNode = /^node(?:\.exe)?$/.test(name);
      let scriptArgvIdx = 1;
      if (isNode) {
        while (scriptArgvIdx < argv.length && argv[scriptArgvIdx].startsWith("-") && argv[scriptArgvIdx] !== "--") {
          const fl = argv[scriptArgvIdx++];
          if (NODE_VALUE_FLAGS.has(fl) && scriptArgvIdx < argv.length) scriptArgvIdx++;
        }
        if (argv[scriptArgvIdx] === "--") scriptArgvIdx++;
      }
      const node = isNode && /(?:^|[\\/])agy-context\.mjs$/i.test(argv[scriptArgvIdx] || "");
      const start = node ? scriptArgvIdx + 1 : 1;
      if ((!direct && !node) || argv[start] !== "transcript") continue;
      const sub = argv[start + 1];
      const isBareHelpShape = !viaXargs && cmdIdx === 0 && segments.length === 1 && !seg.hasSubshell && !seg.hasHeredoc && !seg.hasRedirect && !segInfo.uncertainSyntax && !unclosedCompound;
      if (((sub === "--help" || sub === "-h" || sub === "help") && argv.length === start + 2 && isBareHelpShape) || (!sub && isBareHelpShape)) continue;
      matchCount++;
      if (!["access", "health", "stats", "info"].includes(sub)) continue;
      const invArgs = argv.slice(start + 2);
      const directCleanStart = !viaXargs && cmdIdx === 0 && (!node || (scriptArgvIdx === 1 && argvEntries[1]?.origIdx === 1));
      const validLeadingPrefix = /^[ \t]*(?:&[ \t]*)?$/.test(command.slice(0, seg.start));
      invocation = {
        command: sub === "access" ? "access" : "health",
        args: invArgs,
        clean: segments.length === 1 && directCleanStart && !seg.hasSubshell && !seg.hasHeredoc && !seg.hasRedirect &&
          !segInfo.uncertainSyntax && !unclosedCompound && isCleanTranscriptArgs(sub, invArgs) &&
          validLeadingPrefix && /^[ \t]*$/.test(command.slice(seg.end)) &&
          !detailed.some((t) => !t.quoted && t.raw.startsWith("#")) &&
          !argv.some((w) => w.startsWith("--hook-grant"))
      };
    }
    const wrapper = extractSimpleWrappedScript(seg.text);
    if (wrapper?.innerScript && parseTranscriptInvocation(wrapper.innerScript, depth + 1)) matchCount++;
    for (const sub of [...(seg.subshells || []), ...(seg.heredocBodies || [])]) if (parseTranscriptInvocation(sub, depth + 1)) matchCount++;
  }
  if (invocation && matchCount > 1) invocation.clean = false;
  return invocation || (matchCount > 0 ? { clean: false } : null);
}
