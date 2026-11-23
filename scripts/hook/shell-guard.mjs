/**
 * Section 1 PreToolUse Guard (`run_command`):
 * - Clean quote- & heredoc-aware shell parser (parsed once per call)
 * - Concise LH-09-B governance & benchmark mutation checks
 * - Blocking CI watch loop guard (`gh pr checks --watch`, `gh run watch`)
 * - `agy-context transcript` CLI governance + atomic 10s capability grants
 * - Narrow High-ROI RTK Pre-Gate (`AGY_RTK_MODE=pregate|off`, lossless `rg`/`grep`)
 * - Unchained `rtk read` / degraded bounded `head -n 150`/`tail -n 150` spillover & task-log parity
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getStateDir } from "../state-dir.mjs";
import { quoteForCmd } from "../rtk-run.mjs";
import { isCompatibleRtkVersion } from "../provision-rtk.mjs";
import {
  getProfileHomeDir,
  getBrainDirs,
  tryRealpath,
  isContainedInAnyBrainDir,
  isProtectedExportOutPath,
  isSafeSelfOnlyOutPath
} from "../../lib/path-guards.mjs";
import {
  readTranscriptAccessStore,
  recordTranscriptHookGrant,
  findGoverningPolicyForCaller
} from "../../lib/access-policy.mjs";
import {
  HOOK_REPO_ROOT,
  MAX_SPILLOVER_SLICE_LINES,
  MAX_FULL_FILE_BYTES,
  respond,
  ensureStateDir,
  writeAtomicJson,
  updateSessionState,
  resolveHookPath,
  expandLeadingTilde,
  hasInlineTranscriptCoreInvocation,
  cleanFileToken,
  getCallerLineage,
  evaluateCallerTranscriptAccess,
  isProtectedInternalState,
  isInsideAgyContextSaverRepo,
  isProtectedGovernanceFileMutationPath,
  isUserEditableGeminiConfigPath,
  isProtectedGovernanceDirPath,
  isProtectedBenchmarkFilePath,
  isBenchmarkGuardDisabled,
  isCrossConversationTargetDenied,
  isStepSpilloverPath,
  isExecutableScriptPath,
  matchTaskLogToken,
  extractTaskLogMatches,
  resolveInternalReadStatPaths,
  getTaskState,
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
const REDIRECT_OP_REGEX = /^(?:&>>?|(?:\d+)?(?:>>?|<<<?|<<-|<&|>&|>\||<>))$/;
const REDIRECT_ATTACHED_REGEX = /^(?:\d+)?(?:>>?|<<?)(.+)$/;
const ENV_VALUE_FLAGS = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);
const SHELL_CONTROL_KEYWORDS = new Set(["{", "!", "if", "then", "elif", "else", "do", "while", "until", "time", "&"]);
const SUDO_VALUE_FLAGS = new Set(["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "--user", "--group", "--host"]);
const SIMPLE_WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "time"]);
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "eval"]);
const CODE_INTERPRETERS = new Set(["python", "python2", "python3", "node", "perl", "ruby", "php", "pwsh", "powershell"]);

const normalizeCmdName = (tok) => path.basename(String(tok || "").replace(/\\/g, "/")).toLowerCase().replace(/\.(exe|cmd|bat|mjs|cjs|js)$/i, "");
const hasDotDotTraversal = (s) => Boolean(s && typeof s === "string" && /(?:^|[\/\\])\.\.(?:$|[\/\\])/.test(s));
const isUnquotedRedir = (t) => Boolean(t && !t.quoted && (REDIRECT_OP_REGEX.test(t.raw) || REDIRECT_ATTACHED_REGEX.test(t.raw)));

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
    if (c === ">") { hasRedirect = true; hasWriteRedirect = true; i += next === ">" ? 2 : 1; continue; }
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

function tokenizeShellWordsDetailed(text) {
  const tokens = [];
  for (let i = 0; i < text.length;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const start = i;
    let value = "";
    let quoted = false;
    while (i < text.length && !/\s/.test(text[i])) {
      const c = text[i];
      if (c === ">" || c === "<") {
        if (i > start) {
          const pre = text.slice(start, i);
          if (quoted || !(/^\d+$/.test(pre) || (c === ">" && pre === "&"))) break;
        }
        i++;
        if (i < text.length && (text[i] === c || text[i] === "&" || (c === ">" && text[i] === "|") || (c === "<" && text[i] === ">"))) {
          i++;
          if (i < text.length && (text[i] === "<" || text[i] === ">" || text[i] === "-")) i++;
        }
        value = text.slice(start, i);
        break;
      } else if (c === "&" && text[i + 1] === ">" && i === start) {
        i += text[i + 2] === ">" ? 3 : 2;
        value = text.slice(start, i);
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
      } else if (c === "\\" && i + 1 < text.length && SHELL_ESCAPE_CHARS.has(text[i + 1])) {
        value += text[i + 1]; i += 2;
      } else { value += c; i++; }
    }
    tokens.push({ raw: text.slice(start, i), value, quoted, start, end: i });
  }
  return tokens;
}

const getSegTokens = (seg) => (seg._tokens ||= tokenizeShellWordsDetailed(seg.text || ""));
const tokenizeShellWords = (text) => tokenizeShellWordsDetailed(text).map((t) => t.value);

function skipEnvTokens(tokens, startIdx = 0) {
  let idx = startIdx;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.raw)) { idx++; continue; }
    if (normalizeCmdName(tok.value) === "env") {
      idx++;
      while (idx < tokens.length) {
        const sub = tokens[idx];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(sub.raw)) { idx++; continue; }
        if (sub.value.startsWith("-") && sub.value !== "-") {
          idx += ENV_VALUE_FLAGS.has(sub.value) && idx + 1 < tokens.length ? 2 : 1;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  return idx;
}

function splitEnvPrefix(text, preTokens = null) {
  const tokens = preTokens || tokenizeShellWordsDetailed(text);
  const idx = skipEnvTokens(tokens, 0);
  if (idx === 0) return { prefix: "", body: text };
  if (idx >= tokens.length) return { prefix: text, body: "" };
  return { prefix: text.slice(0, tokens[idx].start), body: text.slice(tokens[idx].start) };
}

function stripLeadingShellPrefixes(tokens, startIdx = 0) {
  let idx = startIdx;
  for (let guard = 0; idx < tokens.length && guard++ < 24;) {
    const nextEnv = skipEnvTokens(tokens, idx);
    if (nextEnv !== idx) { idx = nextEnv; continue; }
    if (!tokens[idx].quoted && SHELL_CONTROL_KEYWORDS.has(tokens[idx].value.toLowerCase())) { idx++; continue; }
    const cmd = normalizeCmdName(tokens[idx].value);
    if (cmd === "sudo" || cmd === "doas") {
      idx++;
      while (idx < tokens.length) {
        const fl = tokens[idx].value;
        if (fl === "--") { idx++; break; }
        if (!fl.startsWith("-") || fl === "-") break;
        idx += SUDO_VALUE_FLAGS.has(fl) && idx + 1 < tokens.length ? 2 : 1;
      }
      continue;
    }
    if (cmd === "timeout" || cmd === "nice") {
      const valFlags = cmd === "timeout" ? new Set(["-k", "-s", "--kill-after", "--signal"]) : new Set(["-n", "--adjustment"]);
      idx++;
      while (idx < tokens.length && tokens[idx].value.startsWith("-")) {
        idx += valFlags.has(tokens[idx].value) && idx + 1 < tokens.length ? 2 : 1;
      }
      if (cmd === "timeout" && idx < tokens.length) idx++;
      continue;
    }
    if (SIMPLE_WRAPPERS.has(cmd)) {
      idx++;
      while (idx < tokens.length && tokens[idx].value.startsWith("-")) { if (tokens[idx++].value === "--") break; }
      continue;
    }
    break;
  }
  return idx;
}

function collectSegmentCommandStartIndices(tokens) {
  const starts = [0];
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].quoted && ["{", "then", "do", "else", "elif", "-exec", "-execdir", "-ok", "-okdir"].includes(tokens[i].value.toLowerCase()) && i + 1 < tokens.length) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function getSegmentCmdName(seg) {
  const tokens = getSegTokens(seg);
  const idx = stripLeadingShellPrefixes(tokens, 0);
  return idx < tokens.length ? normalizeCmdName(tokens[idx].value) : "";
}

function extractRedirectTargets(tokens, writeOnly = false) {
  const targets = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.quoted && REDIRECT_OP_REGEX.test(tok.raw)) {
      if ((!writeOnly || tok.raw.includes(">")) && tokens[i + 1]) targets.push(tokens[i + 1].value);
      continue;
    }
    const attached = !tok.quoted && tok.raw.match(REDIRECT_ATTACHED_REGEX);
    if (attached && (!writeOnly || tok.raw.includes(">"))) targets.push(attached[1].replace(/^["']|["']$/g, ""));
  }
  return targets;
}

function unwrapShellWrapper(segText) {
  const m = segText.match(/^((?:cmd(?:\.exe)?\s+\/[cC]|(?:powershell|pwsh)(?:\.exe)?\s+(?:-Command|-c)|(?:bash|sh|zsh|dash)\s+-[a-z]*c)\s+)(["'])([\s\S]*)\2$/i);
  return m ? { prefix: m[1], quote: m[2], inner: m[3] } : null;
}

function extractSimpleWrappedScript(segText) {
  const trimmed = String(segText || "").trim();
  if (!trimmed) return null;
  const { prefix: envPrefix, body } = splitEnvPrefix(trimmed);
  const effective = (body || trimmed).trim();
  const detailed = tokenizeShellWordsDetailed(effective);
  if (detailed.length < 2) return null;
  let headIdx = 0;
  while (headIdx < detailed.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(detailed[headIdx].raw)) headIdx++;
  if (headIdx >= detailed.length - 1) return null;
  const cmd0 = normalizeCmdName(detailed[headIdx].value);
  if (cmd0 === "env") {
    for (let i = headIdx + 1; i < detailed.length; i++) {
      const v = detailed[i].value;
      if (v === "--") break;
      if ((v === "-S" || v === "--split-string") && i + 1 < detailed.length) {
        return { hadEnvPrefix: true, innerScript: detailed.slice(i + 1).map((t) => t.value).join(" ") };
      }
      if (v.startsWith("--split-string=")) {
        return { hadEnvPrefix: true, innerScript: [v.slice(15), ...detailed.slice(i + 1).map((t) => t.value)].filter(Boolean).join(" ") };
      }
      if (!v.startsWith("--") && /^-[a-zA-Z]*S/.test(v)) {
        const tail = v.slice(v.indexOf("S") + 1);
        const inner = [tail, ...detailed.slice(i + 1).map((t) => t.value)].filter(Boolean).join(" ");
        if (inner) return { hadEnvPrefix: true, innerScript: inner };
      }
    }
  }
  if (cmd0 === "eval") return { hadEnvPrefix: Boolean(envPrefix.trim()), innerScript: detailed.slice(headIdx + 1).map((t) => t.value).join(" ") };
  if (["bash", "sh", "zsh", "dash"].includes(cmd0) && detailed.length >= headIdx + 3) {
    for (let i = headIdx + 1; i < detailed.length - 1; i++) {
      if (detailed[i].value === "--") break;
      if (/^-[a-z]*c$/i.test(detailed[i].value)) return { hadEnvPrefix: Boolean(envPrefix.trim()), innerScript: detailed[i + 1].value };
    }
  }
  if (cmd0 === "cmd" && detailed.length >= headIdx + 3) {
    for (let i = headIdx + 1; i < detailed.length - 1; i++) {
      if (/^\/[ck]$/i.test(detailed[i].value)) return { hadEnvPrefix: Boolean(envPrefix.trim()), innerScript: detailed.slice(i + 1).map((t) => t.value).join(" ") };
    }
  }
  if ((cmd0 === "pwsh" || cmd0 === "powershell") && detailed.length >= headIdx + 3) {
    for (let i = headIdx + 1; i < detailed.length - 1; i++) {
      if (["-command", "-c"].includes(detailed[i].value.toLowerCase())) return { hadEnvPrefix: Boolean(envPrefix.trim()), innerScript: detailed.slice(i + 1).map((t) => t.value).join(" ") };
    }
  }
  if (["sudo", "doas", "timeout", "nice"].includes(cmd0) || SIMPLE_WRAPPERS.has(cmd0)) {
    const nextIdx = stripLeadingShellPrefixes(detailed, headIdx);
    if (nextIdx > headIdx && nextIdx < detailed.length) return { hadEnvPrefix: true, innerScript: effective.slice(detailed[nextIdx].start) };
  }
  return null;
}

function isSingleUnchainedShellCmd(segments) {
  if (segments.length !== 1) return false;
  const seg = segments[0];
  return (!seg.leadingSep || seg.leadingSep === "\n") && !seg.hasRedirect && !seg.hasHeredoc && !seg.hasSubshell && !hasDotDotTraversal(seg.text);
}

// ============================================================================
// Concise LH-09-B Governance & Benchmark Shell Mutation Check
// ============================================================================

const OBVIOUS_MUTATION_VERBS = new Set([
  "rm", "del", "remove-item", "mv", "cp", "ln", "tee", "truncate", "shred", "dd", "patch", "chmod", "chown", "sed", "perl", "find", "install"
]);
const DIR_MUTATION_VERBS = new Set(["rm", "del", "remove-item", "mv", "cp", "ln", "chmod", "chown", "find"]);
const DESTRUCTIVE_CONFIG_VERBS = new Set(["rm", "del", "remove-item", "mv", "ln", "truncate", "shred", "dd", "chmod", "chown", "find"]);

function extractVerbMutationTargets(verb, tokens, cmdIdx) {
  const args = tokens.slice(cmdIdx + 1);
  const vals = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].quoted && REDIRECT_OP_REGEX.test(args[i].raw)) { i++; continue; }
    if (!args[i].quoted && REDIRECT_ATTACHED_REGEX.test(args[i].raw)) continue;
    vals.push(args[i].value);
  }
  if (verb === "cp" || verb === "ln") {
    const targetDirs = [];
    const positionals = [];
    let afterDD = false;
    const valFlags = new Set(["-S", "--suffix", "--no-preserve", "--sparse"]);
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (!afterDD && v === "--") { afterDD = true; continue; }
      if (!afterDD && v.startsWith("-") && v !== "-") {
        if (v === "-t" || v === "--target-directory" || (!v.startsWith("--") && /^-[^-]*t$/.test(v))) { if (vals[i + 1]) targetDirs.push(vals[++i]); continue; }
        if (v.startsWith("--target-directory=")) { targetDirs.push(v.slice("--target-directory=".length)); continue; }
        if (!v.startsWith("--") && /^-[^-]*t(.+)$/.test(v)) { targetDirs.push(v.slice(v.indexOf("t") + 1)); continue; }
        if (valFlags.has(v) && i + 1 < vals.length) i++;
        continue;
      }
      positionals.push(v);
    }
    const dests = targetDirs.length > 0 ? targetDirs : (positionals.length >= 2 ? [positionals[positionals.length - 1]] : []);
    // For `ln`, also inspect source args for governance dir symlink attempts while keeping `ln -s benchmarks/x /tmp/y` allowed (FRIC-RUN-009)
    return { benchTargets: dests, govTargets: verb === "ln" ? [...dests, ...positionals] : dests };
  }
  if (verb === "dd") {
    const t = vals.filter((v) => v.startsWith("of=")).map((v) => v.slice(3)).filter(Boolean);
    return { benchTargets: t, govTargets: t };
  }
  if (verb === "sed" || verb === "perl") {
    const hasI = vals.some((v) => v === "-i" || v === "--in-place" || v.startsWith("--in-place=") || /^-[a-zA-Z0-9]*i/.test(v));
    const t = hasI ? vals.filter((v) => !v.startsWith("-")) : [];
    return { benchTargets: t, govTargets: t };
  }
  if (verb === "find") {
    let isMutFind = vals.includes("-delete");
    if (!isMutFind) {
      for (let i = 0; i < vals.length - 1; i++) {
        if (["-exec", "-execdir", "-ok", "-okdir"].includes(vals[i])) {
          const execVerb = normalizeCmdName(vals[i + 1]);
          if (OBVIOUS_MUTATION_VERBS.has(execVerb) || SHELL_INTERPRETERS.has(execVerb) || CODE_INTERPRETERS.has(execVerb)) {
            isMutFind = true;
            break;
          }
        }
      }
    }
    const t = isMutFind ? vals.filter((v) => !v.startsWith("-")) : [];
    return { benchTargets: t, govTargets: t };
  }
  const t = vals.filter((v) => !v.startsWith("-"));
  return { benchTargets: t, govTargets: t };
}

function segmentPipesToShell(segments, idx) {
  if (SHELL_INTERPRETERS.has(getSegmentCmdName(segments[idx]))) return true;
  for (let j = idx + 1; j < segments.length && (segments[j].leadingSep === "|" || segments[j].leadingSep === "|&"); j++) {
    if (SHELL_INTERPRETERS.has(getSegmentCmdName(segments[j]))) return true;
  }
  return false;
}

function checkShellMutations(segments, convId, ctx, depth = 0) {
  if (depth > 4) return null;
  const cwd = ctx?.cwd || "";
  const benchDisabled = isBenchmarkGuardDisabled(convId, ctx);
  let pendingForceAsk = null;
  const record = (res) => {
    if (!res) return null;
    if (res.decision === "deny") return res;
    if (!pendingForceAsk) pendingForceAsk = res;
    return null;
  };

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    const tokens = getSegTokens(seg);
    const writeRedirects = seg.hasWriteRedirect ? extractRedirectTargets(tokens, true) : [];
    const govChecks = writeRedirects.map((tok) => ({ tok, isDirVerb: false, isDestructive: false }));
    const benchChecks = [...writeRedirects];

    for (const startPos of collectSegmentCommandStartIndices(tokens)) {
      const cmdIdx = stripLeadingShellPrefixes(tokens, startPos);
      if (cmdIdx >= tokens.length) continue;
      const verb = normalizeCmdName(tokens[cmdIdx].value);
      if (!OBVIOUS_MUTATION_VERBS.has(verb)) continue;
      const isDirVerb = DIR_MUTATION_VERBS.has(verb);
      const isDestructive = DESTRUCTIVE_CONFIG_VERBS.has(verb);
      const { govTargets, benchTargets } = extractVerbMutationTargets(verb, tokens, cmdIdx);
      for (const tok of govTargets) govChecks.push({ tok, isDirVerb, isDestructive });
      benchChecks.push(...benchTargets);
    }

    for (const { tok, isDirVerb, isDestructive } of govChecks) {
      if (isDirVerb && isProtectedGovernanceDirPath(tok, cwd)) {
        return { decision: "deny", reason: "Antigravity Execution Governance: Shell mutation of protected Antigravity hook, shim, or governance source files is strictly prohibited." };
      }
      if (isProtectedGovernanceFileMutationPath(tok, convId, ctx)) {
        if (!isDestructive && isUserEditableGeminiConfigPath(tok, convId, ctx)) {
          record({ decision: "force_ask", reason: `[GEMINI CONFIG MUTATION] Shell edit to Antigravity user configuration '${tok}' requires explicit user confirmation.` });
        } else {
          return { decision: "deny", reason: "Antigravity Execution Governance: Shell mutation of protected Antigravity hook, shim, or governance source files is strictly prohibited." };
        }
      }
    }
    if (!benchDisabled && benchChecks.some((tok) => isProtectedBenchmarkFilePath(tok, cwd))) {
      record({ decision: "force_ask", reason: "[BENCHMARK MUTATION DETECTED] Shell command mutation of protected evaluator/benchmark artifact requires explicit user confirmation to prevent benchmark contamination. Set AGY_DISABLE_BENCHMARK_GUARD=1 to disable this guard for non-evaluation repos." });
    }

    const wrap = extractSimpleWrappedScript(seg.text);
    if (wrap?.innerScript) { const d = record(checkShellMutations(splitShellSegments(wrap.innerScript), convId, ctx, depth + 1)); if (d) return d; }
    for (const sub of seg.subshells || []) { const d = record(checkShellMutations(splitShellSegments(sub), convId, ctx, depth + 1)); if (d) return d; }
    if (seg.heredocBodies?.length && segmentPipesToShell(segments, segIdx)) {
      for (const hd of seg.heredocBodies) if (hd) { const d = record(checkShellMutations(splitShellSegments(hd), convId, ctx, depth + 1)); if (d) return d; }
    }
  }
  return pendingForceAsk;
}

// ============================================================================
// `agy-context transcript` CLI Governance & Parent Transcript Isolation
// ============================================================================

const TRANSCRIPT_READ_SUBCOMMANDS = new Set(["read", "query", "step", "health", "list", "ls", "export", "dump", "grep", "search", "find", "stats", "info", "tools", "outline", "summary"]);
const TRANSCRIPT_HELP_SUBCOMMANDS = new Set(["help", "--help", "-h"]);
const TRANSCRIPT_ADMIN_SUBCOMMANDS = new Set(["access", "policy"]);
const ADMIN_MUTATION_TOKENS = new Set(["--off", "--deny-children", "--on", "--reset", "--self-only", "--mode", "--allow", "--deny", "--ttl", "off", "deny", "lock", "on", "open", "reset", "unlock", "self-only"]);

function isAllowedAgyContextScriptPath(scriptToken, cwd = "") {
  if (!scriptToken || hasDotDotTraversal(scriptToken)) return false;
  const norm = scriptToken.replace(/\\/g, "/");
  if (!norm.endsWith("/bin/agy-context.mjs") && norm !== "bin/agy-context.mjs") return false;
  const pluginRoot = path.join(getProfileHomeDir(), ".gemini", "config", "plugins", "agy-context-saver");
  const allowed = new Set([tryRealpath(path.join(HOOK_REPO_ROOT, "bin", "agy-context.mjs")), tryRealpath(path.join(pluginRoot, "bin", "agy-context.mjs"))]);
  return norm === "bin/agy-context.mjs" || allowed.has(tryRealpath(resolveHookPath(scriptToken, cwd)));
}

function isAllowedAgyContextBinaryToken(binToken, cwd = "") {
  if (!binToken || hasDotDotTraversal(binToken)) return false;
  const norm = binToken.replace(/\\/g, "/");
  if (!norm.includes("/")) return ["agy-context", "agy-context-saver"].includes(normalizeCmdName(norm));
  return isAllowedAgyContextScriptPath(binToken, cwd) || /\/\.gemini\/antigravity(?:-cli|-ide)?\/bin\/agy-context(?:-saver)?(?:\.(?:exe|cmd|bat))?$/i.test(norm);
}

function parseAgyContextTranscriptTokens(tokens, cwd = "") {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  const cmd0 = normalizeCmdName(tokens[0]);
  let subOffset = -1;
  let hasNodeFlags = false;
  let invalidBinaryPath = false;
  if ((cmd0 === "agy-context" || cmd0 === "agy-context-saver") && tokens[1] === "transcript") {
    subOffset = 2;
    invalidBinaryPath = !isAllowedAgyContextBinaryToken(tokens[0], cwd);
  } else if (cmd0 === "node" && tokens.length >= 3) {
    for (let i = 1; i < tokens.length - 1; i++) {
      if ((isAllowedAgyContextScriptPath(tokens[i], cwd) || ["agy-context", "agy-context-saver"].includes(normalizeCmdName(tokens[i]))) && tokens[i + 1] === "transcript") {
        subOffset = i + 2;
        hasNodeFlags = i !== 1;
        invalidBinaryPath = !isAllowedAgyContextScriptPath(tokens[i], cwd);
        break;
      }
    }
  }
  if (subOffset === -1) return null;
  const subcommand = tokens[subOffset] !== undefined ? String(tokens[subOffset]).trim() : "help";
  const isReadSub = TRANSCRIPT_READ_SUBCOMMANDS.has(subcommand);
  const isHelpSub = TRANSCRIPT_HELP_SUBCOMMANDS.has(subcommand);
  const isAdminSub = TRANSCRIPT_ADMIN_SUBCOMMANDS.has(subcommand);
  return { subOffset, subcommand, isReadSub, isHelpSub, isAdminSub, isKnownSubcommand: isReadSub || isHelpSub || isAdminSub, hasNodeFlags, invalidBinaryPath, tokens };
}

function findAgyContextTranscriptUsage(segments, cwd = "", depth = 0) {
  if (depth > 4) return null;
  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx];
    let text = (seg.text || "").trim();
    let inSub = false;
    while (text.startsWith("(") && text.endsWith(")")) { inSub = true; text = text.slice(1, -1).trim(); }
    const { prefix: envPrefix, body } = splitEnvPrefix(text);
    const parsedDirect = parseAgyContextTranscriptTokens(tokenizeShellWords(body || text), cwd);
    if (parsedDirect) return { ...parsedDirect, seg, segIndex: idx, totalSegs: segments.length, hadWrapper: inSub || Boolean(envPrefix.trim()) };
    const detailed = tokenizeShellWordsDetailed(text);
    for (const startPos of collectSegmentCommandStartIndices(detailed)) {
      const cmdIdx = stripLeadingShellPrefixes(detailed, startPos);
      if (cmdIdx > 0 && cmdIdx < detailed.length) {
        const parsedPrefixed = parseAgyContextTranscriptTokens(detailed.slice(cmdIdx).map((t) => t.value), cwd);
        if (parsedPrefixed) return { ...parsedPrefixed, seg, segIndex: idx, totalSegs: segments.length, hadWrapper: true };
      }
    }
    const wrapped = extractSimpleWrappedScript(text);
    if (wrapped?.innerScript) {
      const m = findAgyContextTranscriptUsage(splitShellSegments(wrapped.innerScript), cwd, depth + 1);
      if (m) return { ...m, hadWrapper: true, totalSegs: Math.max(segments.length, m.totalSegs) };
    }
    for (const sub of seg.subshells || []) {
      const m = findAgyContextTranscriptUsage(splitShellSegments(sub), cwd, depth + 1);
      if (m) return { ...m, hadWrapper: true, totalSegs: Math.max(segments.length, 2) };
    }
  }
  return null;
}

function canCallerMutateTranscriptAccess(convId, ctx = {}) {
  const lineage = getCallerLineage(convId, ctx);
  if (lineage.isChildSession || lineage.isSwarmChild || lineage.launchDirective === "deny" || lineage.launchDirective === "self-only") return false;
  const policy = findGoverningPolicyForCaller(readTranscriptAccessStore(), convId, lineage, {
    getLineage: (id) => getCallerLineage(id, ctx),
    brainDirs: getBrainDirs({ activeTranscriptPath: ctx?.transcriptPath || "" })
  });
  return !(policy && convId && policy.ownerId !== convId && !lineage.isTopLevelUserSession);
}

function extractTargetConvIdFromTranscriptTokens(sub, restTokens) {
  const valueFlags = ["query", "grep", "search", "find", "tools"].includes(sub)
    ? new Set(["id", "query", "roles", "mode", "start", "end", "last-turns", "last", "tail", "limit", "field", "max-chars", "out", "output", "file"])
    : sub === "step"
      ? new Set(["id", "step", "start", "end", "field", "tail", "tail-lines", "head", "head-lines", "line-start", "line-end", "max-chars", "out", "output", "file"])
      : ["health", "stats", "info"].includes(sub)
        ? new Set(["id", "parent", "file"])
        : ["list", "ls"].includes(sub)
          ? new Set(["limit", "parent"])
          : ["export", "dump"].includes(sub)
            ? new Set(["id", "parent", "start", "end", "limit", "max-chars", "out", "output", "file"])
            : new Set(["id", "query", "roles", "field", "mode", "last-turns", "last", "tail", "offset", "limit", "start", "end", "max-chars", "out", "output", "file"]);

  const opts = {};
  const idValues = [];
  const outPaths = [];
  const positionals = [];
  let sanitized = false;
  for (let i = 0; i < restTokens.length; i++) {
    const tok = restTokens[i];
    if (!tok.startsWith("-") || tok === "-") { positionals.push(tok); continue; }
    if (!tok.startsWith("--")) continue;
    const eq = tok.indexOf("=");
    const key = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    if (key === "sanitized") {
      sanitized = eq === -1 ? true : tok.slice(eq + 1) === "true";
      continue;
    }
    if (!valueFlags.has(key)) continue;
    const val = eq === -1 ? (i + 1 < restTokens.length ? restTokens[++i] : null) : tok.slice(eq + 1);
    if (val === null) continue;
    if (key === "id") String(val).split(",").map((s) => s.trim()).filter(Boolean).forEach((p) => idValues.push(p));
    if ((key === "out" || key === "output") && String(val).trim()) outPaths.push(String(val).trim());
    opts[key] = val;
  }

  const isMultiCapable = ["export", "dump", "health", "stats", "info"].includes(sub);
  const pos = [...positionals];
  if (["query", "grep", "search", "find", "tools"].includes(sub)) {
    if (opts.query === undefined && pos.length) opts.query = pos.shift();
    if (opts.id === undefined && pos.length) { opts.id = pos.shift(); idValues.push(opts.id); }
  } else if (sub === "step") {
    if (opts.step === undefined && pos.length) opts.step = pos.shift();
    if (opts.id === undefined && pos.length) { opts.id = pos.shift(); idValues.push(opts.id); }
  } else if (["read", "outline", "summary", "health", "stats", "info", "export", "dump"].includes(sub)) {
    const canTakeId = !isMultiCapable || (opts.parent === undefined && opts.file === undefined);
    if (opts.id === undefined && canTakeId && pos.length) {
      opts.id = pos.shift();
      if (isMultiCapable) String(opts.id).split(",").map((s) => s.trim()).filter(Boolean).forEach((p) => idValues.push(p));
      else idValues.push(opts.id);
    }
  }
  if (pos.length) return { error: `Antigravity Execution Governance: Unexpected positional arguments '${pos.join(" ")}' for 'agy-context transcript ${sub}'.` };

  const uniqueIds = [...new Set(idValues.map((s) => String(s).trim()).filter(Boolean))];
  return {
    targetId: isMultiCapable && uniqueIds.length === 1 ? uniqueIds[0] : (opts.id ? String(opts.id).trim() : null),
    targetIds: uniqueIds,
    targetParent: opts.parent !== undefined ? String(opts.parent).trim() : null,
    outPaths,
    explicitFile: opts.file ? String(opts.file).trim() : null,
    sanitized
  };
}

const SAFE_TRANSCRIPT_FILTER_CMDS = new Set(["head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "jq", "cut", "sort", "uniq", "tr"]);
const GREP_FILTER_SHORT_BOOL = new Set(["i", "v", "n", "c", "E", "F", "P", "G", "w", "x", "o", "q", "s", "S", "h", "H", "a", "U"]);
const GREP_FILTER_SHORT_NUM = new Set(["m", "A", "B", "C"]);
const GREP_FILTER_LONG_BOOL = new Set([
  "--ignore-case", "--smart-case", "--case-sensitive", "--invert-match", "--line-number", "--no-line-number",
  "--count", "--only-matching", "--fixed-strings", "--extended-regexp", "--basic-regexp", "--perl-regexp",
  "--word-regexp", "--line-regexp", "--quiet", "--silent", "--no-heading", "--no-filename", "--with-filename",
  "--multiline", "--text", "--passthru", "--passthrough", "--json", "--vimgrep", "--stats"
]);
const GREP_FILTER_LONG_NUM = new Set(["--max-count", "--after-context", "--before-context", "--context", "--max-columns"]);
const JQ_FILTER_SHORT_BOOL = new Set(["r", "c", "s", "R", "S", "e", "a", "M", "n", "j"]);
const JQ_FILTER_LONG_BOOL = new Set([
  "--raw-output", "--compact-output", "--slurp", "--raw-input", "--sort-keys",
  "--exit-status", "--ascii-output", "--monochrome-output", "--null-input", "--join-output", "--tab"
]);
const WC_FILTER_SHORT_BOOL = new Set(["l", "w", "c", "m", "L"]);
const WC_FILTER_LONG_BOOL = new Set(["--lines", "--words", "--bytes", "--chars", "--max-line-length"]);
const CUT_FILTER_SHORT_BOOL = new Set(["s", "n", "z"]);
const CUT_FILTER_SHORT_VAL = new Set(["d", "f", "c", "b"]);
const CUT_FILTER_LONG_BOOL = new Set(["--only-delimited", "--complement", "--zero-terminated"]);
const CUT_FILTER_LONG_VAL = new Set(["--delimiter", "--fields", "--characters", "--bytes", "--output-delimiter"]);
const SORT_FILTER_SHORT_BOOL = new Set(["r", "n", "u", "f", "h", "V", "b", "d", "i", "M", "R", "s", "z", "c", "C", "g"]);
const SORT_FILTER_SHORT_VAL = new Set(["k", "t"]);
const SORT_FILTER_LONG_BOOL = new Set(["--reverse", "--numeric-sort", "--unique", "--ignore-case", "--human-numeric-sort", "--version-sort", "--stable", "--zero-terminated", "--general-numeric-sort"]);
const SORT_FILTER_LONG_VAL = new Set(["--key", "--field-separator"]);
const UNIQ_FILTER_SHORT_BOOL = new Set(["c", "d", "D", "u", "i", "z"]);
const UNIQ_FILTER_SHORT_NUM = new Set(["f", "s", "w"]);
const UNIQ_FILTER_LONG_BOOL = new Set(["--count", "--repeated", "--all-repeated", "--unique", "--ignore-case", "--zero-terminated"]);
const UNIQ_FILTER_LONG_NUM = new Set(["--skip-fields", "--skip-chars", "--check-chars"]);
const TR_FILTER_SHORT_BOOL = new Set(["d", "s", "c", "C", "t"]);
const TR_FILTER_LONG_BOOL = new Set(["--delete", "--squeeze-repeats", "--complement", "--truncate-set1"]);

function isSafeReadOnlyTranscriptFilterSegment(seg) {
  if (!seg || (seg.leadingSep !== "|" && seg.leadingSep !== "|&")) return false;
  if (seg.hasHeredoc || seg.hasSubshell) return false;
  const rawTokens = getSegTokens(seg);
  if (!rawTokens || rawTokens.length === 0) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rawTokens[0].raw)) return false;
  const clean = filterAllowedStderrRedirects(rawTokens);
  if (!clean || clean.length === 0) return false;

  const cmdRaw = clean[0].value;
  if (!cmdRaw || /[/\\]/.test(cmdRaw)) return false;
  const cmd = cmdRaw.toLowerCase();
  if (!SAFE_TRANSCRIPT_FILTER_CMDS.has(cmd)) return false;

  const args = clean.slice(1).map((t) => t.value);
  let afterDD = false;
  let posCount = 0;

  if (cmd === "head" || cmd === "tail") {
    for (let i = 0; i < args.length; i++) {
      const v = args[i];
      if (!afterDD && v === "--") { afterDD = true; continue; }
      if (afterDD || !v.startsWith("-") || v === "-") return false;
      if (/^-\d+$/.test(v)) continue;
      if (v.startsWith("--")) {
        if (["--quiet", "--silent", "--verbose", "--zero-terminated"].includes(v)) continue;
        const eq = v.indexOf("=");
        const fl = eq === -1 ? v : v.slice(0, eq);
        const val = eq === -1 ? args[++i] : v.slice(eq + 1);
        if (fl === "--lines") { if (!/^[+-]?\d+$/.test(val || "")) return false; continue; }
        if (fl === "--bytes") { if (!/^[+-]?\d+[bkmKMGTPEZY]?$/.test(val || "")) return false; continue; }
        return false;
      }
      for (let j = 1; j < v.length; j++) {
        const ch = v[j];
        if (ch === "q" || ch === "v" || ch === "z") continue;
        if (ch === "n" || ch === "c") {
          const val = j + 1 < v.length ? v.slice(j + 1) : args[++i];
          const re = ch === "n" ? /^[+-]?\d+$/ : /^[+-]?\d+[bkmKMGTPEZY]?$/;
          if (!re.test(val || "")) return false;
          break;
        }
        return false;
      }
    }
    return true;
  }

  if (cmd === "grep" || cmd === "egrep" || cmd === "fgrep" || cmd === "rg") {
    let hasExplicitPattern = false;
    for (let i = 0; i < args.length; i++) {
      const v = args[i];
      if (!afterDD && v === "--") { afterDD = true; continue; }
      if (afterDD || !v.startsWith("-") || v === "-") { posCount++; continue; }
      if (v.startsWith("--")) {
        if (GREP_FILTER_LONG_BOOL.has(v)) continue;
        const eq = v.indexOf("=");
        const fl = eq === -1 ? v : v.slice(0, eq);
        const val = eq === -1 ? args[++i] : v.slice(eq + 1);
        if (val === undefined) return false;
        if (fl === "--regexp") { hasExplicitPattern = true; continue; }
        if (GREP_FILTER_LONG_NUM.has(fl)) { if (!/^\d+$/.test(val)) return false; continue; }
        if (fl === "--color" || fl === "--colour") { if (!/^(?:always|never|auto|ansi)$/i.test(val)) return false; continue; }
        return false;
      }
      for (let j = 1; j < v.length; j++) {
        const ch = v[j];
        if (GREP_FILTER_SHORT_BOOL.has(ch)) continue;
        if (ch === "e") {
          hasExplicitPattern = true;
          if (j + 1 === v.length && ++i >= args.length) return false;
          break;
        }
        if (GREP_FILTER_SHORT_NUM.has(ch)) {
          const val = j + 1 < v.length ? v.slice(j + 1) : args[++i];
          if (!/^\d+$/.test(val || "")) return false;
          break;
        }
        return false;
      }
    }
    return hasExplicitPattern ? posCount === 0 : posCount === 1;
  }

  if (cmd === "wc") {
    for (const v of args) {
      if (!v.startsWith("-") || v === "-") return false;
      if (v.startsWith("--")) { if (!WC_FILTER_LONG_BOOL.has(v)) return false; continue; }
      for (let j = 1; j < v.length; j++) if (!WC_FILTER_SHORT_BOOL.has(v[j])) return false;
    }
    return true;
  }

  if (cmd === "jq") {
    for (let i = 0; i < args.length; i++) {
      const v = args[i];
      if (!afterDD && v === "--") { afterDD = true; continue; }
      if (afterDD || !v.startsWith("-") || v === "-") { posCount++; continue; }
      if (v.startsWith("--")) {
        if (JQ_FILTER_LONG_BOOL.has(v)) continue;
        if (v === "--arg" || v === "--argjson") { if (i + 2 >= args.length) return false; i += 2; continue; }
        return false;
      }
      for (let j = 1; j < v.length; j++) if (!JQ_FILTER_SHORT_BOOL.has(v[j])) return false;
    }
    return posCount <= 1;
  }

  if (cmd === "cut") {
    for (let i = 0; i < args.length; i++) {
      const v = args[i];
      if (!afterDD && v === "--") { afterDD = true; continue; }
      if (afterDD || !v.startsWith("-") || v === "-") return false;
      if (v.startsWith("--")) {
        if (CUT_FILTER_LONG_BOOL.has(v)) continue;
        const eq = v.indexOf("=");
        const fl = eq === -1 ? v : v.slice(0, eq);
        const val = eq === -1 ? args[++i] : v.slice(eq + 1);
        if (CUT_FILTER_LONG_VAL.has(fl) && val !== undefined) continue;
        return false;
      }
      for (let j = 1; j < v.length; j++) {
        const ch = v[j];
        if (CUT_FILTER_SHORT_BOOL.has(ch)) continue;
        if (CUT_FILTER_SHORT_VAL.has(ch)) { if (j + 1 === v.length && ++i >= args.length) return false; break; }
        return false;
      }
    }
    return true;
  }

  if (cmd === "sort") {
    for (let i = 0; i < args.length; i++) {
      const v = args[i];
      if (!afterDD && v === "--") { afterDD = true; continue; }
      if (afterDD || !v.startsWith("-") || v === "-") return false;
      if (v.startsWith("--")) {
        if (SORT_FILTER_LONG_BOOL.has(v)) continue;
        const eq = v.indexOf("=");
        const fl = eq === -1 ? v : v.slice(0, eq);
        const val = eq === -1 ? args[++i] : v.slice(eq + 1);
        if (SORT_FILTER_LONG_VAL.has(fl) && val !== undefined) continue;
        return false;
      }
      for (let j = 1; j < v.length; j++) {
        const ch = v[j];
        if (SORT_FILTER_SHORT_BOOL.has(ch)) continue;
        if (SORT_FILTER_SHORT_VAL.has(ch)) { if (j + 1 === v.length && ++i >= args.length) return false; break; }
        return false;
      }
    }
    return true;
  }

  if (cmd === "uniq") {
    for (let i = 0; i < args.length; i++) {
      const v = args[i];
      if (!afterDD && v === "--") { afterDD = true; continue; }
      if (afterDD || !v.startsWith("-") || v === "-") return false;
      if (v.startsWith("--")) {
        if (UNIQ_FILTER_LONG_BOOL.has(v)) continue;
        const eq = v.indexOf("=");
        const fl = eq === -1 ? v : v.slice(0, eq);
        const val = eq === -1 ? args[++i] : v.slice(eq + 1);
        if (UNIQ_FILTER_LONG_NUM.has(fl) && /^\d+$/.test(val || "")) continue;
        return false;
      }
      for (let j = 1; j < v.length; j++) {
        const ch = v[j];
        if (UNIQ_FILTER_SHORT_BOOL.has(ch)) continue;
        if (UNIQ_FILTER_SHORT_NUM.has(ch)) {
          const val = j + 1 < v.length ? v.slice(j + 1) : args[++i];
          if (!/^\d+$/.test(val || "")) return false;
          break;
        }
        return false;
      }
    }
    return true;
  }

  if (cmd === "tr") {
    for (let i = 0; i < args.length; i++) {
      const v = args[i];
      if (!afterDD && v === "--") { afterDD = true; continue; }
      if (afterDD || !v.startsWith("-") || v === "-") { posCount++; continue; }
      if (v.startsWith("--")) { if (!TR_FILTER_LONG_BOOL.has(v)) return false; continue; }
      for (let j = 1; j < v.length; j++) if (!TR_FILTER_SHORT_BOOL.has(v[j])) return false;
    }
    return posCount >= 1 && posCount <= 2;
  }

  return false;
}

function checkAgyContextTranscriptCommand(segments, convId, ctx) {
  const cwd = ctx?.cwd || "";
  const match = segments.length ? findAgyContextTranscriptUsage(segments, cwd) : null;
  if (!match) return { matched: false, allowed: false };
  const { seg, segIndex, totalSegs, hadWrapper, subOffset, subcommand, isReadSub, isHelpSub, isAdminSub, isKnownSubcommand, hasNodeFlags, invalidBinaryPath } = match;
  const fail = (reason, isAccessDenial = false) => ({ matched: true, allowed: false, isAccessDenial, reason });

  const seg0CleanDetailed = !seg.hasRedirect ? getSegTokens(seg) : filterAllowedStderrRedirects(getSegTokens(seg));
  const hasValidPipeline = totalSegs === 1 || (totalSegs <= 7 && (isReadSub || isHelpSub) && segments.slice(1).every(isSafeReadOnlyTranscriptFilterSegment));
  if (segIndex !== 0 || !hasValidPipeline || (seg.leadingSep && seg.leadingSep !== "\n") || hadWrapper || hasNodeFlags || invalidBinaryPath || !seg0CleanDetailed || seg.hasHeredoc || seg.hasSubshell) {
    return fail("Antigravity Execution Governance: 'agy-context transcript' access to .system_generated must be a single unchained command or piped strictly to read-only stdin filters (rg/grep/head/tail/jq/wc/cut/sort/uniq/tr; no &&, ;, write redirects, file operands, wrappers, env prefixes, node flags, heredocs, or subshells). Use: 'list'/'health --parent|--id u1,u2 --json' -> parallel 'outline'/'query'/'read'/'step --id <uuid> --full' ('--out <path>' if >9 KB raw).");
  }
  const tokens = seg.hasRedirect ? seg0CleanDetailed.map((t) => t.value) : match.tokens;
  if (!isKnownSubcommand) {
    return fail(`Antigravity Execution Governance: Unknown 'agy-context transcript' subcommand '${subcommand}'. Expected read, query, step, health, list, export, or access.`);
  }

  const brainDirs = getBrainDirs({ activeTranscriptPath: ctx?.transcriptPath || "" });
  const dirDesc = brainDirs.length === 1 ? `'${brainDirs[0]}'` : `'${brainDirs.join("' or '")}'`;
  for (let i = subOffset + 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--file" || tok.startsWith("--file=")) {
      const val = tok === "--file" ? tokens[++i] : tok.slice("--file=".length);
      if (!val || hasDotDotTraversal(val) || !isContainedInAnyBrainDir(val, brainDirs, null, { cwd })) {
        return fail(`Antigravity Execution Governance: '--file' in 'agy-context transcript' must stay inside ${dirDesc} without '..' path traversal.`);
      }
      continue;
    }
    if (hasDotDotTraversal(tok)) return fail("Antigravity Execution Governance: Path traversal ('..') is prohibited in 'agy-context transcript' commands.");
  }

  const restTokens = tokens.slice(subOffset + 1);
  if (isHelpSub || (restTokens.length === 1 && (restTokens[0] === "--help" || restTokens[0] === "-h"))) {
    return { matched: true, allowed: true, subcommand, mode: "open", needsReadGrant: false };
  }

  if (isAdminSub) {
    const hasMut = restTokens.some((t) => { const l = String(t).toLowerCase(); return ADMIN_MUTATION_TOKENS.has(l) || /^--(?:mode|allow|deny|ttl)=/.test(l); });
    if (hasMut && !canCallerMutateTranscriptAccess(convId, ctx)) {
      return fail("Antigravity Execution Governance: Only the parent/coordinator session may modify 'agy-context transcript access' policy. Child sessions cannot unlock or alter transcript governance.", true);
    }
    return { matched: true, allowed: true, subcommand, mode: "open", needsReadGrant: false, isAccessMutation: hasMut };
  }

  if (isReadSub) {
    const accessEval = evaluateCallerTranscriptAccess(convId, ctx);
    const denyAccess = (detail = "") => {
      const label = accessEval.rosterName ? `@${accessEval.rosterName} (${convId})` : convId;
      return fail(`Antigravity Execution Governance: 'agy-context transcript ${subcommand}' is restricted for this session (${label}) by parent governance [mode=${accessEval.mode}, source=${accessEval.source}].${detail ? " " + detail : ""} Do NOT retry transcript inspection commands or attempt direct '.system_generated' file/shell reads; proceed with your assigned task using your workspace files and task brief.`, true);
    };
    if (!accessEval.allowed) return denyAccess();

    const targetInfo = extractTargetConvIdFromTranscriptTokens(subcommand, restTokens);
    if (targetInfo.error) return fail(targetInfo.error);
    const isExport = subcommand === "export" || subcommand === "dump";
    const isHealth = subcommand === "health" || subcommand === "stats" || subcommand === "info";
    const isMultiTargetSub = isExport || isHealth;
    const isList = subcommand === "list" || subcommand === "ls";
    if (isExport && !targetInfo.sanitized) {
      return fail("Antigravity Execution Governance: Flag '--sanitized' is required for 'agy-context transcript export' to enforce transcript isolation (raw transcript export is prohibited).");
    }

    for (const outPath of targetInfo.outPaths || []) {
      const resolvedOut = resolveHookPath(outPath, cwd);
      if (
        /^~/.test(outPath) || /\$|%[A-Za-z_][A-Za-z0-9_]*%/.test(outPath) || hasDotDotTraversal(outPath) ||
        isProtectedInternalState(outPath) || isProtectedInternalState(resolvedOut) ||
        isProtectedBenchmarkFilePath(outPath, cwd) || isProtectedGovernanceFileMutationPath(outPath, convId, ctx) ||
        isProtectedExportOutPath(outPath, resolvedOut, { cwd }) || !/\.(?:md|json|txt)$/i.test(outPath)
      ) {
        return fail(`Antigravity Execution Governance: '--out' path '${outPath}' in 'agy-context transcript ${subcommand}' must be a literal (no shell variables, '~', UNC, or device prefixes) safe .md/.json/.txt artifact outside protected internal state, governance, and benchmark directories.`);
      }
      if (accessEval.mode === "self-only" && !isSafeSelfOnlyOutPath(outPath, resolvedOut, convId, { cwd })) {
        return denyAccess(`'--out' must stay under '<workspace>/scratch/' or '<brainDir>/${convId}/scratch/' in self-only mode (received '${outPath}').`);
      }
    }

    if (accessEval.mode === "self-only") {
      if (isList) return denyAccess("'list'/'ls' across sessions is disabled in self-only mode.");
      if (isMultiTargetSub && targetInfo.targetParent !== null) return denyAccess("'--parent' across sessions is disabled in self-only mode.");
      if (isMultiTargetSub && (targetInfo.targetIds.length > 1 || targetInfo.targetIds.some((id) => id.toLowerCase() !== "current" && id !== convId))) {
        return denyAccess(`Cross-session or multi-session transcript ${isExport ? "export" : "health inspection"} is disabled in self-only mode.`);
      }
      if (targetInfo.explicitFile && !isContainedInAnyBrainDir(targetInfo.explicitFile, brainDirs, convId, { cwd })) {
        return denyAccess(`Cross-session '--file' access outside '${convId}' is disabled in self-only mode.`);
      }
      if (targetInfo.targetId && targetInfo.targetId.toLowerCase() !== "current" && targetInfo.targetId !== convId) {
        return denyAccess(`Cross-session inspection of '${targetInfo.targetId}' is disabled in self-only mode (you may only inspect your own session '${convId}').`);
      }
      const wasCur = Boolean(targetInfo.targetId && targetInfo.targetId.toLowerCase() === "current");
      const injectSelfId = !targetInfo.explicitFile && (!targetInfo.targetId || wasCur) && convId && convId !== "global" ? convId : null;
      return { matched: true, allowed: true, subcommand, mode: "self-only", targetConvId: convId, needsReadGrant: true, injectSelfId, targetWasCurrentPlaceholder: wasCur, seg0Start: seg.start, seg0End: seg.end };
    }

    let resolvedTarget = targetInfo.targetId || null;
    const injectParentId = (isMultiTargetSub || isList) && targetInfo.targetParent?.toLowerCase() === "current" && convId && convId !== "global" ? convId : null;
    if (isMultiTargetSub) {
      if (targetInfo.targetParent) resolvedTarget = `parent:${injectParentId || targetInfo.targetParent}`;
      else if (targetInfo.targetIds.length > 1) resolvedTarget = `multi:${[...targetInfo.targetIds].sort().join(",")}`;
      else if (targetInfo.targetIds.length === 1) resolvedTarget = targetInfo.targetIds[0];
    }
    if (targetInfo.explicitFile) {
      const matchedDir = isContainedInAnyBrainDir(targetInfo.explicitFile, brainDirs, null, { cwd });
      if (accessEval.ownerId && !accessEval.isOwner && !matchedDir) return denyAccess(`'--file' paths outside ${dirDesc} are disabled while a parent transcript access policy is active.`);
      if (matchedDir) {
        const firstSeg = path.relative(tryRealpath(path.resolve(matchedDir)), tryRealpath(resolveHookPath(targetInfo.explicitFile, cwd))).split(path.sep)[0];
        if (firstSeg && firstSeg !== "." && firstSeg !== "..") resolvedTarget = firstSeg;
      }
    }
    const wasCur = Boolean(targetInfo.targetId && targetInfo.targetId.toLowerCase() === "current");
    const injectSelfId = !isList && !(isMultiTargetSub && (targetInfo.targetParent || targetInfo.targetIds.length > 1)) && !targetInfo.explicitFile && (!targetInfo.targetId || wasCur) && convId && convId !== "global" ? convId : null;
    if (injectSelfId) resolvedTarget = convId;
    return { matched: true, allowed: true, subcommand, mode: "open", needsReadGrant: true, targetConvId: resolvedTarget, injectSelfId, targetWasCurrentPlaceholder: wasCur, injectParentId, seg0Start: seg.start, seg0End: seg.end };
  }
  return { matched: true, allowed: true, subcommand, mode: "open", needsReadGrant: false };
}

// ============================================================================
// Prose-Flag Exemptions, Shell Safety Inspection & Blocking Watch Loop Guard
// ============================================================================

const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack", "select-string"]);
const SEARCH_VALUE_FLAGS = new Set(["-e", "--regexp", "-f", "--file", "-m", "--max-count", "-A", "--after-context", "-B", "--before-context", "-C", "--context", "-t", "--type", "-T", "--type-not", "-g", "--glob", "--iglob", "-M", "--max-columns", "--max-filesize", "--color", "-j", "--threads", "-r", "--replace", "--sort", "--sortr"]);

function filterProseFlags(detailed, subIdx, allTokens, envPrefix, shouldSkipPair, shouldSkipInline) {
  const kept = envPrefix.trim() ? [envPrefix.trim()] : [];
  let afterDD = false;
  for (let i = 0; i < detailed.length; i++) {
    const tok = detailed[i];
    if (i <= subIdx) { kept.push(tok.value); continue; }
    if (isUnquotedRedir(tok)) {
      kept.push(tok.raw);
      if (!tok.quoted && REDIRECT_OP_REGEX.test(tok.raw) && i + 1 < detailed.length) kept.push(detailed[++i].value);
      continue;
    }
    if (!afterDD && tok.value === "--") { afterDD = true; kept.push(tok.value); continue; }
    if (!afterDD) {
      const nextTok = i + 1 < detailed.length && !isUnquotedRedir(detailed[i + 1]) ? detailed[i + 1] : null;
      if (shouldSkipPair(tok.value, nextTok)) { if (nextTok) i++; continue; }
      if (shouldSkipInline(tok.value)) continue;
    }
    kept.push(tok.value);
  }
  kept.push(...extractRedirectTargets(allTokens));
  return kept.join(" ");
}

function getInspectableTextForSegment(seg, { hasDownstreamPipe = false } = {}) {
  const allTokens = getSegTokens(seg);
  const { prefix: envPrefix, body } = splitEnvPrefix(seg.text, allTokens);
  const detailed = body && body !== seg.text ? tokenizeShellWordsDetailed(body) : allTokens;
  if (detailed.length === 0) return "";

  const cmd0 = normalizeCmdName(detailed[0].value);
  const cmd1 = detailed[1] ? normalizeCmdName(detailed[1].value) : "";
  const cmd2 = detailed[2] ? normalizeCmdName(detailed[2].value) : "";

  if (!hasDownstreamPipe && (cmd0 === "echo" || cmd0 === "printf" || cmd0 === "write-output")) {
    return extractRedirectTargets(allTokens).join(" ");
  }

  const rtkBase = (target) => cmd0 === target ? 0 : (cmd0 === "rtk" && cmd1 === target ? 1 : (cmd0 === "node" && detailed[1] && isTrustedLocalRtkLauncherPath(detailed[1].value) && cmd2 === target ? 2 : -1));
  const skipGlobal = (start, valSet) => {
    let idx = start;
    while (idx < detailed.length) {
      const v = detailed[idx].value;
      if (valSet.has(v)) { idx += 2; continue; }
      if (v.startsWith("-")) { idx++; continue; }
      break;
    }
    return idx;
  };

  // git commit/tag (-m) and git log/rev-list/shortlog (--grep/-S/-G)
  const gitBase = rtkBase("git");
  if (gitBase !== -1) {
    const subIdx = skipGlobal(gitBase + 1, new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]));
    const gitSub = subIdx < detailed.length ? normalizeCmdName(detailed[subIdx].value) : "";
    if (gitSub === "commit" || gitSub === "tag") {
      const preRe = gitSub === "commit" ? /^-[apsnvqezoih]*m$/ : /^-[asfdvin]*m$/;
      const inlRe = gitSub === "commit" ? /^-[apsnvqezoih]*m.+/ : /^-[asfdvin]*m.+/;
      return filterProseFlags(detailed, subIdx, allTokens, envPrefix, (v) => v === "-m" || v === "--message" || preRe.test(v), (v) => v.startsWith("--message=") || (!v.startsWith("--") && inlRe.test(v)));
    }
    if (["log", "rev-list", "shortlog"].includes(gitSub)) {
      return filterProseFlags(detailed, subIdx, allTokens, envPrefix, (v) => v === "--grep" || v === "-S" || v === "-G", (v) => v.startsWith("--grep=") || ((v.startsWith("-S") || v.startsWith("-G")) && v.length > 2));
    }
  }

  // gh pr/issue/release (-b/-t/-n/--subject + action-scoped -c/--comment) and gh api (-f + non-@ -F)
  const ghBase = rtkBase("gh");
  if (ghBase !== -1 && ghBase + 1 < detailed.length) {
    const ghGlobals = new Set(["-R", "--repo", "--hostname"]);
    const subIdx = skipGlobal(ghBase + 1, ghGlobals);
    const ghSub = subIdx < detailed.length ? normalizeCmdName(detailed[subIdx].value) : "";
    if (ghSub === "api") {
      const isFileF = (val) => { const eq = String(val || "").indexOf("="); return eq !== -1 && String(val).slice(eq + 1).startsWith("@"); };
      return filterProseFlags(
        detailed, subIdx, allTokens, envPrefix,
        (v, next) => v === "-f" || v === "--raw-field" || ((v === "-F" || v === "--field") && next && !isFileF(next.value)),
        (v) => v.startsWith("--raw-field=") || (v.startsWith("-f") && v.length > 2 && !v.startsWith("--")) ||
          (v.startsWith("--field=") && !isFileF(v.slice(8))) || (v.startsWith("-F") && v.length > 2 && !v.startsWith("--") && !isFileF(v.slice(2)))
      );
    }
    if (["pr", "issue", "release"].includes(ghSub)) {
      const actIdx = skipGlobal(subIdx + 1, ghGlobals);
      const ghAction = actIdx < detailed.length ? normalizeCmdName(detailed[actIdx].value) : "";
      const allowC = (ghSub === "pr" || ghSub === "issue") && (ghAction === "close" || ghAction === "reopen");
      return filterProseFlags(
        detailed, subIdx, allTokens, envPrefix,
        (v) => ["-b", "--body", "-t", "--title", "-n", "--notes", "--subject"].includes(v) || (allowC && (v === "-c" || v === "--comment")),
        (v) => /^--(?:body|title|notes|subject)=/.test(v) || (allowC && v.startsWith("--comment=")) || (!v.startsWith("--") && (allowC ? /^-[btnc].+/ : /^-[btn].+/).test(v))
      );
    }
  }

  // Search commands (`grep`, `rg`, `git grep`, `rtk grep/rg`): skip pattern, inspect only target paths / -f files / redirects
  let argStart = -1;
  if (SEARCH_COMMANDS.has(cmd0)) argStart = 1;
  else if ((cmd0 === "rtk" && (cmd1 === "grep" || cmd1 === "rg")) || (cmd0 === "git" && cmd1 === "grep")) argStart = 2;
  else if (cmd0 === "node" && detailed[1] && isTrustedLocalRtkLauncherPath(detailed[1].value) && (cmd2 === "grep" || cmd2 === "rg")) argStart = 3;

  if (argStart !== -1) {
    const targets = extractRedirectTargets(allTokens);
    if (envPrefix.trim()) targets.unshift(envPrefix.trim());
    let hasPat = false;
    let afterDD = false;
    const positionals = [];
    for (let i = argStart; i < detailed.length; i++) {
      const tok = detailed[i];
      if (!tok.quoted && REDIRECT_OP_REGEX.test(tok.raw)) { i++; continue; }
      if (!tok.quoted && REDIRECT_ATTACHED_REGEX.test(tok.raw)) continue;
      const v = tok.value;
      if (!afterDD && v === "--") { afterDD = true; continue; }
      if (!afterDD && v.startsWith("-") && v !== "-") {
        if (v === "--regexp" || v.startsWith("--regexp=")) { hasPat = true; if (v === "--regexp") i++; continue; }
        if (v === "-f" || v === "--file" || (!v.startsWith("--") && /^-[^-]*f$/.test(v))) { if (detailed[i + 1]) targets.push(detailed[++i].value); hasPat = true; continue; }
        if (!v.startsWith("--") && /^-([^-]*)f(.+)$/.test(v)) { targets.push(v.slice(v.indexOf("f") + 1)); hasPat = true; continue; }
        if (v.startsWith("--file=")) { targets.push(v.slice(7)); hasPat = true; continue; }
        if (!v.startsWith("--") && /^-[^-]*e/.test(v)) { hasPat = true; if (/^-[^-]*e$/.test(v)) i++; continue; }
        if (SEARCH_VALUE_FLAGS.has(v)) i++;
        continue;
      }
      positionals.push(v);
    }
    targets.push(...(hasPat ? positionals : positionals.slice(1)));
    return targets.join(" ");
  }

  const unquoted = allTokens.map((t) => t.value.replace(/[\r\n]+/g, " ")).join(" ");
  return unquoted && unquoted !== seg.text ? `${seg.text}\n${unquoted}` : seg.text;
}

const CODE_FILE_ACCESS_RE = /\b(?:open|read|readFile|readFileSync|createReadStream|readdir|listdir|scandir|walk|glob|iglob|readlines|Path|subprocess|popen|system|exec|spawn|eval|require|import|from\s+\w+\s+import|__import__|fs\.|os\.|io\.|path\.)\b/i;

function collectInspectableTexts(segments, depth = 0) {
  if (depth > 4) return [];
  const texts = [];
  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx];
    const pipelineCmds = [getSegmentCmdName(seg)];
    for (let j = idx + 1; j < segments.length && (segments[j].leadingSep === "|" || segments[j].leadingSep === "|&"); j++) {
      pipelineCmds.push(getSegmentCmdName(segments[j]));
    }
    const inspectable = getInspectableTextForSegment(seg, { hasDownstreamPipe: pipelineCmds.length > 1 });
    if (inspectable) texts.push(inspectable);

    const wrapped = extractSimpleWrappedScript(seg.text);
    if (wrapped?.innerScript) texts.push(...collectInspectableTexts(splitShellSegments(wrapped.innerScript), depth + 1));
    for (const sub of seg.subshells || []) texts.push(...collectInspectableTexts(splitShellSegments(sub), depth + 1));

    if (seg.heredocBodies?.length) {
      const hasShell = pipelineCmds.some((c) => SHELL_INTERPRETERS.has(c));
      const hasXargs = pipelineCmds.includes("xargs");
      const hasCode = !seg.hasWriteRedirect && pipelineCmds.some((c) => CODE_INTERPRETERS.has(c));
      const writesExecScript = seg.hasWriteRedirect && extractRedirectTargets(getSegTokens(seg), true).some(isExecutableScriptPath);
      for (const hd of seg.heredocBodies) {
        if (!hd) continue;
        if (hasShell) texts.push(...collectInspectableTexts(splitShellSegments(hd), depth + 1));
        else if (hasXargs || (hasCode && CODE_FILE_ACCESS_RE.test(hd)) || writesExecScript || /^\s*#!/.test(hd)) texts.push(hd);
      }
    }
  }
  return texts;
}

function hasNonCanonicalAgyTranscriptInvocation(text, depth = 0) {
  if (!text || typeof text !== "string" || depth > 4 || !/agy-context(?:-saver)?/i.test(text) || !/\btranscript\b/i.test(text)) return false;
  if (/\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|popen|system|subprocess|child_process)\b/i.test(text) &&
      /\bagy-context(?:-saver)?(?:\.(?:m?js|cmd|exe|bat))?[\s'",\[\]()]{1,24}transcript\b/i.test(text)) return true;
  const segs = splitShellSegments(text);
  if (findAgyContextTranscriptUsage(segs, "", depth)) return true;
  return segs.some((seg) => (seg.heredocBodies || []).some((hd) => hd && hasNonCanonicalAgyTranscriptInvocation(hd, depth + 1)));
}

function getProtectedShellOperationReason(text, { isRestrictedChild = false } = {}) {
  if (!text || typeof text !== "string") return null;
  if (isProtectedInternalState(text)) return "internal-state";
  if (hasNonCanonicalAgyTranscriptInvocation(text)) return "non-canonical-cli";
  // PT-RUN-001: Only block direct inline import/require/spawn of transcript-core / bin/agy-context for restricted children
  if (isRestrictedChild && hasInlineTranscriptCoreInvocation(text)) {
    return "inline-transcript-core";
  }
  if (
    /(?:^|[\s;|&(])(?:AGY_TEST_PROFILE_DIR|AGY_BRAIN_DIR|GEMINI_CONVERSATION_ID)=/i.test(text) ||
    /(?:process\.env|os\.environ)\s*(?:\.\s*(?:AGY_TEST_PROFILE_DIR|AGY_BRAIN_DIR|GEMINI_CONVERSATION_ID)\b|\[\s*['"](?:AGY_TEST_PROFILE_DIR|AGY_BRAIN_DIR|GEMINI_CONVERSATION_ID)['"]\s*\])/i.test(text)
  ) return "governance-env";

  const touchesStateEnv =
    /(?:^|[\s;|&(])(?:XDG_STATE_HOME|LOCALAPPDATA)=/i.test(text) ||
    /(?:process\.env|os\.environ)\s*(?:\.\s*(?:XDG_STATE_HOME|LOCALAPPDATA)\b|\[\s*['"](?:XDG_STATE_HOME|LOCALAPPDATA)['"]\s*\])/i.test(text);
  if (touchesStateEnv && (isRestrictedChild || /\bagy-context(?:-saver)?\b|\bexecution-guard\b|\btranscript(?:-access|-core)?\b|\.gemini\b/i.test(text))) {
    return "governance-env";
  }

  if (
    /\.gemini[\/\\]+antigravity(?:-cli|-ide)?[\/\\]+brain[\/\\]+(?![^\/\\\s'"]+[\/\\](?:scratch|browser_sandbox|swarm_view|\.agents)(?:$|[\/\\])|[^\/\\\s'"]+[\/\\][^\/\\\s'"]+\.(?:md|txt|json|csv|tsv|yaml|yml|xml|zip|png|jpg|jpeg|gif|svg|html|css|webp|bmp|ico|pdf|mp3|wav|mp4|webm|mov)\b)/i.test(text) &&
    /\b(?:ln|cp|mv|rsync|tar|zip|find|readdir|readdirSync|scandir|listdir|walk|glob|iglob|readFile|readFileSync|createReadStream|open|openSync)\b/i.test(text)
  ) return "internal-state";
  return null;
}

function buildProtectedShellReasonMessage(code, convId, ctx) {
  if (code === "non-canonical-cli") return "Antigravity Execution Governance: 'agy-context transcript' must be invoked as a single unchained command or piped strictly to read-only stdin filters (rg/grep/head/tail/jq/wc; no &&, ;, write redirects, subshells, or '..' traversal). Follow: 'list'/'health --parent|--id u1,u2 --json' -> parallel 'outline'/'query'/'read'/'step --id <uuid> --full' ('--out <path>' if >9 KB raw).";
  if (code === "inline-transcript-core") return "Antigravity Execution Governance: Direct inline script or interpreter imports of 'transcript-core.mjs' or 'bin/agy-context.mjs' are prohibited. Invoke 'agy-context transcript' (read-only '|' ok; no '&&'/';') directly via run_command instead.";
  if (code === "governance-env") return "Antigravity Execution Governance: Overriding Antigravity governance/state environment variables (AGY_TEST_PROFILE_DIR, AGY_BRAIN_DIR, GEMINI_CONVERSATION_ID, or governance-scoped XDG_STATE_HOME/LOCALAPPDATA) inside shell commands is prohibited.";
  return buildInternalStateShellDenial(convId, ctx);
}

// 1B.1: Repo-scoped restricted-child lifecycle guard (zero hardcoded `/agy-squad/` regex)
function isRestrictedLifecycleInvocation(segments, cwd = "", depth = 0) {
  if (depth > 4) return false;
  const isOwnLifecycleScript = (tok) => {
    const clean = cleanFileToken(tok).replace(/\\/g, "/");
    return /(?:^|\/)(?:install-register\.mjs|install\.sh|install\.ps1)$/i.test(clean) && isInsideAgyContextSaverRepo(resolveHookPath(expandLeadingTilde(clean), cwd));
  };
  for (const seg of segments) {
    if (/\bagy-context(?:-saver)?(?:\.m?js)?\s+(?:--?(?:setup|install|uninstall|restore-backups)|setup|install|uninstall|restore-backups)\b/i.test(String(seg.text || ""))) return true;
    const tokens = getSegTokens(seg);
    for (const startPos of collectSegmentCommandStartIndices(tokens)) {
      const cmdIdx = stripLeadingShellPrefixes(tokens, startPos);
      if (cmdIdx >= tokens.length) continue;
      const cmdTok = tokens[cmdIdx].value;
      const cmd = normalizeCmdName(cmdTok);
      if (cmd === "npm" || cmd === "pnpm" || cmd === "bun") {
        let prefixDir = "";
        let runSub = "";
        for (let i = cmdIdx + 1; i < tokens.length; i++) {
          const v = tokens[i].value;
          if (["--prefix", "-C", "--dir", "--cwd"].includes(v) && tokens[i + 1]) { prefixDir = tokens[++i].value; continue; }
          if (v.startsWith("--prefix=")) { prefixDir = v.slice(9); continue; }
          if (v === "run" && tokens[i + 1]) { runSub = tokens[i + 1].value.toLowerCase(); break; }
        }
        if ((runSub === "setup" || runSub === "uninstall") && isInsideAgyContextSaverRepo(resolveHookPath(prefixDir || ".", cwd))) return true;
      }
      if (isOwnLifecycleScript(cmdTok)) return true;
      if (["node", "npx", "bun", "bash", "sh", "zsh", "dash", "pwsh", "powershell"].includes(cmd)) {
        for (let i = cmdIdx + 1; i < tokens.length; i++) if (!tokens[i].value.startsWith("-") && isOwnLifecycleScript(tokens[i].value)) return true;
      }
    }
    const w = extractSimpleWrappedScript(seg.text);
    if (w?.innerScript && isRestrictedLifecycleInvocation(splitShellSegments(w.innerScript), cwd, depth + 1)) return true;
    for (const sub of seg.subshells || []) if (isRestrictedLifecycleInvocation(splitShellSegments(sub), cwd, depth + 1)) return true;
  }
  return false;
}

const GH_VALUE_FLAGS = new Set(["-R", "--repo", "-i", "--interval", "-q", "--jq", "-t", "--template", "-H", "--hostname"]);

function findBlockingWatchLoop(segments, depth = 0) {
  if (depth > 4) return null;
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    const tokens = getSegTokens(seg);
    let idx = stripLeadingShellPrefixes(tokens, 0);
    while (idx < tokens.length && normalizeCmdName(tokens[idx].value) === "rtk") idx++;
    if (idx < tokens.length && normalizeCmdName(tokens[idx].value) === "gh") {
      const rest = tokens.slice(idx + 1).map((t) => t.value);
      const pos = [];
      let hasHelp = false;
      let hasWatch = false;
      let afterDD = false;
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
      if (!hasHelp) {
        if (pos[0] === "pr" && pos[1] === "checks" && hasWatch) return { command: "gh pr checks --watch" };
        if (pos[0] === "run" && pos[1] === "watch") return { command: "gh run watch" };
      }
    }
    const w = extractSimpleWrappedScript(seg.text);
    if (w?.innerScript) { const r = findBlockingWatchLoop(splitShellSegments(w.innerScript), depth + 1); if (r) return r; }
    for (const sub of seg.subshells || []) { const r = findBlockingWatchLoop(splitShellSegments(sub), depth + 1); if (r) return r; }
    if (seg.heredocBodies?.length && segmentPipesToShell(segments, segIdx)) {
      for (const hd of seg.heredocBodies) if (hd) { const r = findBlockingWatchLoop(splitShellSegments(hd), depth + 1); if (r) return r; }
    }
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
  const body = (splitEnvPrefix(trimmed).body || trimmed).trim();
  const tokens = tokenizeShellWordsDetailed(body);
  if (!tokens.length || normalizeCmdName(tokens[0].value) !== "cd") return curCwd;
  let idx = 1;
  while (idx < tokens.length && (tokens[idx].value === "-L" || tokens[idx].value === "-P" || tokens[idx].value === "--")) idx++;
  const target = tokens[idx]?.value || "";
  if (!target || target === "-" || /[$`]/.test(target)) return curCwd;
  return path.resolve(curCwd, expandLeadingTilde(target));
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

  const agyTranscriptCheck = checkAgyContextTranscriptCommand(segments, convId, ctx);
  if (agyTranscriptCheck.matched && !agyTranscriptCheck.allowed) {
    if (agyTranscriptCheck.isAccessDenial) {
      const { result } = updateSessionState(convId, (session) => {
        session.transcriptDenials = (session.transcriptDenials || 0) + 1;
        return {
          updatePollTime: false,
          result: session.transcriptDenials >= 5
            ? { decision: "force_ask", reason: `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: restricted session '${convId}' attempted forbidden 'agy-context transcript' access ${session.transcriptDenials} times. ${agyTranscriptCheck.reason}` }
            : { decision: "deny", reason: agyTranscriptCheck.reason }
        };
      });
      respond(result);
    }
    respond({ decision: "deny", reason: agyTranscriptCheck.reason });
  }

  let isSpillover = false;
  let spilloverTok = null;
  let taskMatch = null;
  let taskState = null;

  if (!agyTranscriptCheck.allowed) {
    const callerAccess = evaluateCallerTranscriptAccess(convId, ctx);
    const inspectableTexts = collectInspectableTexts(segments);
    const inspectableCombined = inspectableTexts.join("\n");
    const singleTokens = segments.length === 1 ? getSegTokens(segments[0]).map((t) => t.value) : [];
    const spilloverTokens = singleTokens.map(cleanFileToken).filter(isStepSpilloverPath);
    spilloverTok = spilloverTokens[0] || null;
    isSpillover = spilloverTokens.length > 0;
    const taskMatches = extractTaskLogMatches(inspectableCombined, convId, ctx, singleTokens);
    taskMatch = taskMatches[0] || null;

    if (callerAccess.isRestrictedChild && isRestrictedLifecycleInvocation(segments, cwd)) {
      respond({ decision: "deny", reason: "Antigravity Execution Governance: Restricted child sessions cannot execute plugin lifecycle setup or uninstall commands." });
    }

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

    const protectedReason = getProtectedShellOperationReason(inspectRemainder, { isRestrictedChild: callerAccess.isRestrictedChild });
    if (protectedReason) respond({ decision: "deny", reason: buildProtectedShellReasonMessage(protectedReason, convId, ctx) });
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

  // Self-ID / parent-ID injection for `agy-context transcript` in open & self-only modes (scoped to Segment 0 when piped)
  if (agyTranscriptCheck.allowed && (agyTranscriptCheck.injectSelfId || agyTranscriptCheck.injectParentId)) {
    const s0Start = Number.isInteger(agyTranscriptCheck.seg0Start) ? agyTranscriptCheck.seg0Start : 0;
    const s0End = Number.isInteger(agyTranscriptCheck.seg0End) ? agyTranscriptCheck.seg0End : effectiveCmd.length;
    let seg0Cmd = effectiveCmd.slice(s0Start, s0End);
    const appendFlagToSeg0 = (cmdStr, flagStr) => {
      const m = cmdStr.match(/(\s+2>(?:&1|\s*(?:\/dev\/null|nul)))+\s*$/i);
      return m ? `${cmdStr.slice(0, m.index).trimEnd()} ${flagStr}${m[0]}` : `${cmdStr.trimEnd()} ${flagStr}`;
    };
    if (agyTranscriptCheck.injectSelfId) {
      if (/(^|\s)--id(?:=|\s+)(["']?)current\2(?=\s|$)/i.test(seg0Cmd)) {
        seg0Cmd = seg0Cmd.replace(/(^|\s)--id(?:=|\s+)(["']?)current\2(?=\s|$)/gi, `$1--id ${agyTranscriptCheck.injectSelfId}`);
      } else if (agyTranscriptCheck.targetWasCurrentPlaceholder) {
        const upd = seg0Cmd.replace(/(^|\s)(["']?)current\2(?=(?:\s|$)(?!.*\s["']?current["']?(?:\s|$)))/i, `$1--id ${agyTranscriptCheck.injectSelfId}`);
        seg0Cmd = upd !== seg0Cmd ? upd : appendFlagToSeg0(seg0Cmd, `--id ${agyTranscriptCheck.injectSelfId}`);
      } else {
        seg0Cmd = appendFlagToSeg0(seg0Cmd, `--id ${agyTranscriptCheck.injectSelfId}`);
      }
    }
    if (agyTranscriptCheck.injectParentId) {
      seg0Cmd = seg0Cmd.replace(/(^|\s)--parent(?:=|\s+)(["']?)current\2(?=\s|$)/gi, `$1--parent ${agyTranscriptCheck.injectParentId}`);
    }
    effectiveCmd = effectiveCmd.slice(0, s0Start) + seg0Cmd + effectiveCmd.slice(s0End);
  }

  // Rewrite bare `agy-context` / `agy-context-saver` to installed shim when off PATH
  if (agyTranscriptCheck.allowed || (isSingleUnchainedShellCmd(segments) && !isSpillover && !taskMatch)) {
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

    const callerAccess = evaluateCallerTranscriptAccess(convId, ctx);
    const isRestricted = Boolean(callerAccess.isRestrictedChild || !callerAccess.allowed || callerAccess.mode === "self-only");

    if (isSpillover) {
      if (isCrossConversationTargetDenied(spilloverTok || parsedEff?.operands?.[0] || "", convId, ctx, callerAccess)) {
        respond({ decision: "deny", reason: "Antigravity Execution Governance: Cross-conversation inspection of another session's step spillover is prohibited under Parent Transcript Isolation." });
      }
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
      if (isCrossConversationTargetDenied(taskMatch.realPath || taskMatch.token || parsedEff?.operands?.[0] || "", convId, ctx, callerAccess)) {
        respond({ decision: "deny", reason: "Antigravity Execution Governance: Cross-conversation inspection of another session's task log is prohibited under Parent Transcript Isolation." });
      }
      const allowedTaskRead = rtk
        ? (taskState === "COMPLETED" ? Boolean(parsedEff) : (!isRestricted && Boolean(parsedRaw && parsedEff)))
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

  const isDaemon = args.IsDaemon === true || args.isDaemon === true;
  const rawWaitMs = args.WaitMsBeforeAsync !== undefined ? args.WaitMsBeforeAsync : args.waitMsBeforeAsync;
  const waitMs = rawWaitMs === null ? undefined : rawWaitMs;
  const overwrite = {};
  if (effectiveCmd !== rawCmd) overwrite.CommandLine = effectiveCmd;
  if (!isDaemon && waitMs === undefined) overwrite.WaitMsBeforeAsync = Number(process.env.AGY_MAX_WAIT_MS) || 10000;

  respond(Object.keys(overwrite).length > 0 ? { decision: "allow", overwrite } : { decision: "allow" });
}
