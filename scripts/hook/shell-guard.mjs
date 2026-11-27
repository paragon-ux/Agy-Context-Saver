/** Section 1 PreToolUse Guard (`run_command`): parser, governance/benchmark mutation, watch-loop, RTK pre-gate, spillover & transcript CLI identity. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getEffectiveMode } from "../../lib/transcript-policy.mjs";
import { mintHookIdentity } from "../../lib/hook-identity.mjs";
import { getStateDir } from "../state-dir.mjs";
import { quoteForCmd } from "../rtk-run.mjs";
import { isCompatibleRtkVersion } from "../provision-rtk.mjs";
import { getProfileHomeDir, getBrainDirs, tryRealpath, resolveRealOrAncestorPath, isContainedInDir } from "../../lib/path-guards.mjs";
import { HOOK_REPO_ROOT, MAX_SPILLOVER_SLICE_LINES, MAX_FULL_FILE_BYTES, respond, ensureStateDir, writeAtomicJson, resolveHookPath,
  expandLeadingTilde, expandAndResolvePathVariants, cleanFileToken, isProtectedInternalState, isProtectedGovernanceFileMutationPath,
  isUserEditableGeminiConfigPath, isProtectedGovernanceDirPath, isProtectedBenchmarkFilePath, isBenchmarkGuardDisabled, isStepSpilloverPath,
  stripTranscriptLogRefs, isReadOnlyTranscriptVerb, isExecutableScriptPath, matchTaskLogToken, extractTaskLogMatches, resolveInternalReadStatPaths,
  getTaskState, buildInternalStateShellDenial, lifecycleActionIndex, scriptBodyHasLifecycleCommand, commandScriptPath,
  isRestrictedLifecycleCaller } from "./common.mjs";
const ENV_CACHE_TTL_MS = 60000;
let cachedRtkKey = null, cachedRtkValue = undefined;
const safeStat = (p) => {
  try {
    return p ? fs.statSync(p) : null;
  } catch {
    return null;
  }
};
const isFileSafe = (p) => Boolean(safeStat(p)?.isFile());
const mtimeSafe = (p) => Math.trunc(safeStat(p)?.mtimeMs || 0);
const normRealCI = (p) => {
  const s = tryRealpath(path.resolve(p)).replace(/\\/g, "/");
  return os.platform() === "win32" || os.platform() === "darwin" ? s.toLowerCase() : s;
};
function findExecutableOnPath(baseName) {
  const isWin = os.platform() === "win32", exts = isWin ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const cand = path.join(dir, `${baseName}${ext}`);
      try {
        if (!isFileSafe(cand)) continue;
        if (!isWin) fs.accessSync(cand, fs.constants.X_OK);
        return cand;
      } catch {}
    }
  }
  return "";
}
function getLocalRtkCandidate() {
  const names = os.platform() === "win32" ? ["rtk.exe", "rtk.cmd"] : ["rtk"];
  const roots = [path.join(getProfileHomeDir(), ".gemini", "config", "plugins", "agy-context-saver", "bin")];
  if (!process.env.AGY_TEST_PROFILE_DIR) roots.push(path.join(HOOK_REPO_ROOT, "bin"));
  for (const root of roots) {
    const hit = names.map((exe) => path.join(root, exe)).find((p) => fs.existsSync(p));
    if (hit) return hit;
  }
  return "";
}
const getTrustedLaunchers = () => [...new Set([
  path.join(getProfileHomeDir(), ".gemini", "config", "plugins", "agy-context-saver", "scripts", "rtk-run.mjs"),
  path.join(HOOK_REPO_ROOT, "scripts", "rtk-run.mjs")
])];
function isTrustedLocalRtkLauncherPath(candidatePath) {
  if (!candidatePath || typeof candidatePath !== "string") return false;
  const clean = cleanFileToken(candidatePath);
  return /(?:^|[\\/])rtk-run\.mjs$/i.test(clean) && getTrustedLaunchers().some((t) => normRealCI(t) === normRealCI(clean));
}
function resolveLocalRtkLauncher(localCandidate = "") {
  const cands = localCandidate
    ? [path.resolve(path.dirname(localCandidate), "..", "scripts", "rtk-run.mjs"), ...getTrustedLaunchers()]
    : getTrustedLaunchers();
  return cands.find((c) => isFileSafe(c) && isTrustedLocalRtkLauncherPath(c)) || "";
}
function resolveInstalledAgyContextCommand(binName = "agy-context") {
  const home = getProfileHomeDir(), isWin = os.platform() === "win32";
  const pluginCli = path.join(home, ".gemini", "config", "plugins", "agy-context-saver", "bin", "agy-context.mjs");
  const nodeCli = isFileSafe(pluginCli) ? `node "${pluginCli.replace(/\\/g, "/")}"` : "";
  if (isWin && nodeCli) return nodeCli;
  const names = binName === "agy-context-saver" ? ["agy-context-saver", "agy-context"] : ["agy-context", "agy-context-saver"];
  for (const name of names) {
    const shim = path.join(home, ".gemini", "antigravity", "bin", isWin ? `${name}.cmd` : name);
    try {
      if (!fs.statSync(shim).isFile()) continue;
      if (!isWin) fs.accessSync(shim, fs.constants.X_OK);
      const fmt = isWin ? shim : shim.replace(/\\/g, "/");
      return /\s/.test(fmt) ? `"${fmt}"` : fmt;
    } catch {}
  }
  return isWin ? "" : nodeCli;
}
function spawnRtk(bin, args, opts = {}) {
  if (!bin) return { error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }), status: null, stdout: "", stderr: "" };
  const baseEnv = opts.env || process.env;
  const env = { ...baseEnv, RTK_SUPPRESS_HOOK_WARNING: baseEnv.RTK_SUPPRESS_HOOK_WARNING ?? "1" };
  if (os.platform() === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    const comspec = env.ComSpec || env.COMSPEC || path.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "cmd.exe");
    const qBin = /[\s&|<>^()%!]/.test(bin) ? `"${bin}"` : bin, qArgs = args.map(quoteForCmd).join(" ");
    return spawnSync(comspec, ["/d", "/s", "/c", qArgs ? `"${qBin} ${qArgs}"` : `"${qBin}"`], { ...opts, env, windowsVerbatimArguments: true });
  }
  return spawnSync(bin, args, { ...opts, env });
}
const extractRtkSemver = (v) => String(v || "").match(/(\d+\.\d+\.\d+)/)?.[1] || "";
function isRtkVersionBelow(versionStr, maj, min) {
  const m = String(versionStr || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return !m || Number(m[1]) < maj || (Number(m[1]) === maj && Number(m[2]) < min);
}
export function resolveCachedHostEnv() {
  const pathEnv = process.env.PATH || process.env.Path || "", localCandidate = getLocalRtkCandidate();
  const winLauncher = os.platform() === "win32" ? resolveLocalRtkLauncher(localCandidate) : "";
  const cacheFile = path.join(getStateDir(), "env-cache.json");
  let parsed = null;
  try {
    const p = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf-8")) : null;
    if (p && typeof p.ts === "number" && (Date.now() - p.ts) < ENV_CACHE_TTL_MS) parsed = p;
  } catch {}
  const makeKey = (pc) => [pc, localCandidate, mtimeSafe(pc), mtimeSafe(localCandidate), winLauncher].join("::");
  const validRes = (v) => v === null || (Boolean(v) && typeof v.version === "string");
  if (parsed && parsed.pathEnv === pathEnv && parsed.localCandidate === localCandidate &&
      (parsed.winLauncher || "") === winLauncher && typeof parsed.pathCandidate === "string") {
    const fastKey = makeKey(parsed.pathCandidate);
    if (parsed.key === fastKey && validRes(parsed.resolved ?? null)) {
      cachedRtkKey = fastKey;
      cachedRtkValue = parsed.resolved ?? null;
      return { rtk: cachedRtkValue };
    }
  }
  const pathCandidate = findExecutableOnPath("rtk"), key = makeKey(pathCandidate);
  if (cachedRtkKey === key && cachedRtkValue !== undefined) return { rtk: cachedRtkValue };
  if (parsed && parsed.key === key && typeof parsed.pathEnv !== "string" && validRes(parsed.resolved ?? null)) {
    cachedRtkKey = key;
    cachedRtkValue = parsed.resolved ?? null;
    return { rtk: cachedRtkValue };
  }
  const opts = { encoding: "utf-8", timeout: 2000, windowsHide: true };
  let resolved = null;
  for (const [cand, isPath] of [[pathCandidate, true], [localCandidate, false]]) {
    if (!cand || resolved) continue;
    const r = spawnRtk(cand, ["--version"], opts);
    if (!r.error && r.status === 0 && isCompatibleRtkVersion(r.stdout)) {
      const norm = cand.replace(/\\/g, "/");
      const prefix = isPath ? "rtk" : (os.platform() === "win32" && winLauncher
        ? `node "${winLauncher.replace(/\\/g, "/")}"`
        : (/\s/.test(norm) ? `"${norm}"` : norm));
      resolved = { exe: cand, prefix, version: extractRtkSemver(r.stdout) };
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
const SHELL_ESCAPE_CHARS = new Set([" ", "\t", "\n", "\r", ";", "|", "&", "<", ">", "(", ")", '"', "'", "\\", "$", "`"]);
const REDIRECT_CLOSE_FD_REGEX = /^(?:\d+)?(?:<&|>&)-$/;
const REDIRECT_OP_REGEX = /^(?:&>>?|(?:\d+)?(?:>>?|<<<?|<<-|<|<&|>&|>\||<>))$/;
const REDIRECT_ATTACHED_REGEX = /^(?:&>>?|(?:\d+)?(?:>>?|<<<?|<<-|<|<&|>&|>\||<>))(.+)$/;
const ENV_VALUE_FLAGS = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);
const SHELL_CONTROL_KEYWORDS = new Set(["{", "!", "if", "then", "elif", "else", "do", "while", "until", "time", "&"]);
const SUDO_VALUE_FLAGS = new Set(["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D", "--user", "--group", "--host", "--chdir"]);
const TIMEOUT_VALUE_FLAGS = new Set(["-k", "-s", "--kill-after", "--signal"]);
const NICE_VALUE_FLAGS = new Set(["-n", "--adjustment"]);
const SIMPLE_WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "time"]);
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "eval"]);
const CODE_INTERPRETERS = new Set(["python", "python2", "python3", "node", "perl", "ruby", "php", "pwsh", "powershell"]);
const NODE_VALUE_FLAGS = new Set(("-r --require --import --loader --experimental-loader -C --conditions --env-file --env-file-if-exists " +
  "--watch-path --redirect-warnings --diagnostic-dir --heapsnapshot-near-heap-limit --title --openssl-config --icu-data-dir").split(" "));
const normalizeCmdName = (tok) => path.basename(String(tok || "").replace(/\\/g, "/")).toLowerCase().replace(/\.(exe|cmd|bat|mjs|cjs|js)$/i, "");
const hasDotDotTraversal = (s) => Boolean(s && typeof s === "string" && /(?:^|[\/\\])\.\.(?:$|[\/\\])/.test(s));
const isUnquotedRedir = (t) =>
  Boolean(t && !t.quoted && (REDIRECT_CLOSE_FD_REGEX.test(t.raw) || REDIRECT_OP_REGEX.test(t.raw) || REDIRECT_ATTACHED_REGEX.test(t.raw)));
function parseHeredocTag(cmd, pos) {
  let i = pos + 2, delim = "";
  const stripTabs = cmd[i] === "-";
  if (stripTabs) i++;
  while (i < cmd.length && (cmd[i] === " " || cmd[i] === "\t")) i++;
  const ch = cmd[i];
  if (ch === "'" || ch === '"') {
    for (i++; i < cmd.length && cmd[i] !== ch && cmd[i] !== "\n" && cmd[i] !== "\r";) {
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
  let i = startPos, depth = 1, inSingle = false, inDouble = false;
  while (i < cmd.length && depth > 0) {
    const c = cmd[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      i++;
    } else if (inDouble) {
      if (c === "\\" && i + 1 < cmd.length) i += 2;
      else if (c === "$" && cmd[i + 1] === "(") {
        depth++;
        i += 2;
      } else {
        if (c === '"') inDouble = false;
        i++;
      }
    } else if (c === "\\" && i + 1 < cmd.length && SHELL_ESCAPE_CHARS.has(cmd[i + 1])) i += 2;
    else {
      if (c === "'") inSingle = true;
      else if (c === '"') inDouble = true;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
  }
  return { inner: cmd.slice(startPos, depth === 0 ? i - 1 : i), nextIndex: i };
}
function readBacktickSubshell(cmd, startPos) {
  let i = startPos, inner = "";
  while (i < cmd.length && cmd[i] !== "`") {
    if (cmd[i] === "\\" && i + 1 < cmd.length) {
      inner += cmd[i + 1];
      i += 2;
    } else inner += cmd[i++];
  }
  return { inner, nextIndex: cmd[i] === "`" ? i + 1 : i };
}
export function splitShellSegments(command) {
  if (!command || typeof command !== "string") return [];
  const segments = [], pendingHeredocs = [];
  let inSingle = false, inDouble = false, segStart = 0, leadingSep = "", firstHdIdx = -1;
  let hasRedirect = false, hasWriteRedirect = false, hasInputRedirect = false, hasHeredoc = false, hasHereString = false, hasSubshell = false;
  let subshells = [], heredocBodies = [];
  const takeSub = (pos, bt = false) => {
    hasSubshell = true;
    const s = bt ? readBacktickSubshell(command, pos) : readBalancedSubshell(command, pos);
    subshells.push(s.inner);
    return s.nextIndex;
  };
  const pushSeg = (endOffset) => {
    const raw = command.slice(segStart, endOffset), trimmed = raw.trim();
    if (trimmed || hasHeredoc) {
      const leadWS = raw.length - raw.trimStart().length, trailWS = raw.length - raw.trimEnd().length;
      segments.push({
        text: trimmed, raw, start: segStart + leadWS, end: Math.max(segStart + leadWS, endOffset - trailWS),
        leadingSep, hasRedirect, hasWriteRedirect, hasInputRedirect, hasHeredoc, hasHereString, heredocBodies, hasSubshell, subshells, _tokens: null
      });
      if (hasHeredoc && firstHdIdx === -1) firstHdIdx = segments.length - 1;
    }
    leadingSep = "";
    hasRedirect = hasWriteRedirect = hasInputRedirect = hasHeredoc = hasHereString = hasSubshell = false;
    subshells = [];
    heredocBodies = [];
  };
  for (let i = 0; i < command.length;) {
    const c = command[i], next = command[i + 1];
    if (inSingle) {
      if (c === "'") inSingle = false;
      i++;
    } else if (inDouble) {
      if (c === "\\" && i + 1 < command.length) i += 2;
      else if (c === "$" && next === "(") i = takeSub(i + 2);
      else if (c === "`") i = takeSub(i + 1, true);
      else {
        if (c === '"') inDouble = false;
        i++;
      }
    } else if (c === "\\") {
      i += (next === "\r" && command[i + 2] === "\n") ? 3 : (next !== undefined && SHELL_ESCAPE_CHARS.has(next) ? 2 : 1);
    } else if (c === "'" || c === '"') {
      if (c === "'") inSingle = true;
      else inDouble = true;
      i++;
    } else if (c === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
      while (i < command.length && command[i] !== "\n") i++;
    } else if ((c === "$" || c === "<" || c === ">") && next === "(") {
      if (c !== "$") hasRedirect = true;
      i = takeSub(i + 2);
    } else if (c === "(") i = takeSub(i + 1);
    else if (c === "`") i = takeSub(i + 1, true);
    else if (c === "<") {
      hasInputRedirect = true;
      if (next === "<" && command[i + 2] === "<") {
        hasRedirect = hasHereString = true;
        i += 3;
      } else if (next === "<") {
        const tag = parseHeredocTag(command, i);
        if (tag) {
          hasHeredoc = true;
          pendingHeredocs.push(tag);
          i = tag.endIndex;
        } else {
          hasRedirect = true;
          i += 2;
        }
      } else {
        hasRedirect = true;
        i += 1;
      }
    } else if (c === ">") {
      hasRedirect = hasWriteRedirect = true;
      i += (next === ">" || next === "|") ? 2 : 1;
    } else if (c === "\n" || (c === "\r" && next === "\n")) {
      pushSeg(i);
      i += c === "\r" ? 2 : 1;
      const tIdx = firstHdIdx !== -1 ? firstHdIdx : segments.length - 1;
      while (pendingHeredocs.length > 0) {
        const hd = pendingHeredocs.shift(), lines = [];
        while (i < command.length) {
          const nl = command.indexOf("\n", i), rawLine = command.slice(i, nl === -1 ? command.length : nl).replace(/\r$/, "");
          i = nl === -1 ? command.length : nl + 1;
          if ((hd.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine) === hd.delim) break;
          lines.push(rawLine);
        }
        if (tIdx >= 0 && segments[tIdx]) segments[tIdx].heredocBodies.push(lines.join("\n"));
      }
      firstHdIdx = -1;
      segStart = i;
      leadingSep = "\n";
    } else if ((c === "&" && next === "&") || (c === "|" && (next === "|" || next === "&")) || c === "|" || c === ";") {
      pushSeg(i);
      const len = (c === "&" || (c === "|" && (next === "|" || next === "&"))) ? 2 : 1;
      leadingSep = command.slice(i, i + len);
      i += len;
      segStart = i;
    } else if (c === "&") {
      if (i > 0 && (command[i - 1] === ">" || command[i - 1] === "<")) {
        hasRedirect = true;
        i++;
      } else if (next === ">") {
        hasRedirect = hasWriteRedirect = true;
        i += 2;
      } else {
        pushSeg(i);
        segStart = ++i;
        leadingSep = "&";
      }
    } else i++;
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
      const sub = readBalancedSubshell(text, i + 1), closed = sub.nextIndex > i + 1 && text[sub.nextIndex - 1] === ")";
      i = sub.nextIndex;
      tokens.push({
        raw: text.slice(start, i), value: "()", quoted: false, isSubshellGroup: true,
        unclosedSubshell: !closed, globPositions: [], hasUnquotedGlob: false, start, end: i
      });
      continue;
    }
    let value = "", quoted = false;
    const globPositions = [];
    while (i < text.length && !/\s/.test(text[i])) {
      const c = text[i];
      if (c === ">" || c === "<") {
        const pre = text.slice(start, i);
        if (i > start && (quoted || !(/^\d+$/.test(pre) || (c === ">" && pre === "&")))) break;
        i++;
        if (i < text.length && (text[i] === c || text[i] === "&" || (c === ">" && text[i] === "|") || (c === "<" && text[i] === ">"))) {
          const second = text[i++];
          if ((c === "<" && second === "<" && (text[i] === "<" || text[i] === "-")) || (second === "&" && text[i] === "-")) i++;
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
        quoted = true;
        for (i++; i < text.length && text[i] !== "'";) value += text[i++];
        if (text[i] === "'") i++;
      } else if (c === '"') {
        quoted = true;
        for (i++; i < text.length && text[i] !== '"';) {
          if (text[i] === "\\" && ['"', "\\", "$", "`"].includes(text[i + 1])) {
            value += text[i + 1];
            i += 2;
          } else value += text[i++];
        }
        if (text[i] === '"') i++;
      } else if (c === "\\" && i + 1 < text.length && (SHELL_ESCAPE_CHARS.has(text[i + 1]) || /[*?\[]/.test(text[i + 1]))) {
        value += text[i + 1];
        i += 2;
      } else {
        if (/[*?\[]/.test(c)) globPositions.push(value.length);
        value += text[i++];
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
  if (REDIRECT_OP_REGEX.test(tok.raw)) {
    const missing = idx + 1 >= tokens.length || isUnquotedRedir(tokens[idx + 1]);
    return missing ? { nextIdx: tokens.length, missingTarget: true } : { nextIdx: idx + 2, missingTarget: false };
  }
  return REDIRECT_ATTACHED_REGEX.test(tok.raw) ? { nextIdx: idx + 1, missingTarget: false } : null;
}
function hasMalformedRedirects(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const r = skipSingleRedirect(tokens, i);
    if (r && r.missingTarget) return true;
    if (r) i = r.nextIdx - 1;
  }
  return false;
}
function nextNonRedirectIndex(tokens, fromIdx, endIdx) {
  for (let idx = fromIdx; idx < endIdx;) {
    const r = skipSingleRedirect(tokens, idx);
    if (!r) return idx;
    if (r.missingTarget) return -1;
    idx = r.nextIdx;
  }
  return endIdx;
}
function onlyRedirectsRemain(tokens, fromIdx) {
  for (let c = fromIdx; c < tokens.length;) {
    const r = skipSingleRedirect(tokens, c);
    if (!r || r.missingTarget) return false;
    c = r.nextIdx;
  }
  return true;
}
const joinLocalCwd = (prev, next) => !next ? prev : (prev && !path.isAbsolute(expandLeadingTilde(next)) ? path.join(prev, next) : next);
// shortcut: xargs unwraps only -0/-r/-t/-p/-x and -n/-L/-P/-I <val>; -a or other flags return uncertain: true
function unwrapCommandPrefix(tokens, startIdx = 0, endIdx = tokens.length, { includeControlKeywords = false, envOnly = false, unwrapXargs = false } = {}) {
  let idx = startIdx, localCwd = null, viaXargs = false;
  const fail = (at = endIdx) => ({ cmdIdx: at, localCwd, viaXargs, uncertain: true });
  for (let guard = 0; idx < endIdx && guard < 32; guard++) {
    if (!envOnly) {
      idx = nextNonRedirectIndex(tokens, idx, endIdx);
      if (idx < 0) return fail();
      if (idx >= endIdx) break;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx].raw)) {
      idx++;
      continue;
    }
    const cmd = normalizeCmdName(tokens[idx].value), kw = tokens[idx].value.toLowerCase();
    const isKw = includeControlKeywords ? SHELL_CONTROL_KEYWORDS.has(kw) : (kw === "!" || kw === "time" || (idx === 0 && kw === "&"));
    if (cmd === "env") {
      for (idx++; idx < endIdx;) {
        idx = nextNonRedirectIndex(tokens, idx, endIdx);
        if (idx < 0) return fail();
        if (idx >= endIdx) break;
        const sub = tokens[idx], v = sub.value;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(sub.raw)) idx++;
        else if (v === "--") {
          idx++;
          break;
        } else if (v === "-C" || v === "--chdir" || ENV_VALUE_FLAGS.has(v)) {
          const vi = nextNonRedirectIndex(tokens, idx + 1, endIdx);
          if (vi < 0 || vi >= endIdx) return fail();
          if (v === "-C" || v === "--chdir") localCwd = joinLocalCwd(localCwd, tokens[vi].value);
          idx = vi + 1;
        } else if (v.startsWith("--chdir=") || (!v.startsWith("--") && /^-[^-]*C.+$/.test(v))) {
          localCwd = joinLocalCwd(localCwd, v.startsWith("--chdir=") ? v.slice(8) : v.slice(v.indexOf("C") + 1));
          idx++;
        } else if (v.startsWith("-") && v !== "-") idx++;
        else break;
      }
    } else if (envOnly) break;
    else if (!tokens[idx].quoted && isKw) idx++;
    else if (cmd === "sudo" || cmd === "doas" || cmd === "timeout" || cmd === "nice" || SIMPLE_WRAPPERS.has(cmd)) {
      const vf = (cmd === "sudo" || cmd === "doas") ? SUDO_VALUE_FLAGS : (cmd === "timeout" ? TIMEOUT_VALUE_FLAGS : (cmd === "nice" ? NICE_VALUE_FLAGS : null));
      let queryOnly = false, probe = idx + 1;
      while (probe < endIdx) {
        probe = nextNonRedirectIndex(tokens, probe, endIdx);
        if (probe < 0) return fail();
        if (probe >= endIdx) break;
        const fl = tokens[probe].value;
        if (fl === "--") {
          probe++;
          break;
        }
        if (!fl.startsWith("-") || fl === "-") break;
        if (cmd === "command" && ((/^-[pPvV]+$/.test(fl) && /[vV]/.test(fl)) || fl !== "-p")) queryOnly = true;
        probe += vf?.has(fl) && probe + 1 < endIdx ? 2 : 1;
      }
      if (queryOnly) break;
      if (cmd === "timeout") {
        const dur = nextNonRedirectIndex(tokens, probe, endIdx);
        if (dur >= 0 && dur < endIdx) probe = dur + 1;
      }
      idx = probe;
    } else if (unwrapXargs && cmd === "xargs") {
      viaXargs = true;
      for (idx++; idx < endIdx;) {
        idx = nextNonRedirectIndex(tokens, idx, endIdx);
        if (idx < 0) return fail();
        if (idx >= endIdx) break;
        const v = tokens[idx].value;
        if (v === "--") {
          idx++;
          break;
        }
        if (!v.startsWith("-") || v === "-") break;
        if (/^-[0rtpx]+$/.test(v) || ["--null", "--no-run-if-empty", "--verbose", "--interactive", "--exit"].includes(v)) idx++;
        else if (/^-[0rtpx]*[nLPI]$/.test(v) || ["--max-args", "--max-lines", "--max-procs", "--replace"].includes(v)) {
          const vi = nextNonRedirectIndex(tokens, idx + 1, endIdx);
          if (vi < 0 || vi >= endIdx) return fail();
          idx = vi + 1;
        } else if (/^-[0rtpx]*[nLPI].+$/.test(v) || /^--(?:max-args|max-lines|max-procs|replace)=/.test(v)) idx++;
        else return fail(idx);
      }
    } else break;
  }
  return { cmdIdx: idx, localCwd, viaXargs, uncertain: false };
}
function splitEnvPrefix(text, preTokens = null) {
  const tokens = preTokens || tokenizeShellWordsDetailed(text);
  const { cmdIdx } = unwrapCommandPrefix(tokens, 0, tokens.length, { envOnly: true });
  if (cmdIdx === 0) return { prefix: "", body: text };
  return cmdIdx >= tokens.length ? { prefix: text, body: "" } : { prefix: text.slice(0, tokens[cmdIdx].start), body: text.slice(tokens[cmdIdx].start) };
}
const FIND_NON_PATH_VAL = new Set(("-name -iname -path -ipath -wholename -iwholename -lname -ilname -regex -iregex -regextype -type -xtype " +
  "-perm -user -group -uid -gid -size -links -inum -mindepth -maxdepth -mtime -atime -ctime -mmin -amin -cmin -printf -used -fstype -context").split(" "));
const FIND_FILE_VAL = new Set(["-newer", "-anewer", "-cnewer", "-samefile", "-files0-from", "-fprint", "-fprint0", "-fls"]);
const FIND_WRITE_VAL = new Set(["-fprint", "-fprint0", "-fls", "-fprintf"]);
const FIND_NO_ARG = new Set(("-print -print0 -ls -delete -prune -quit -empty -executable -readable -writable -true -false -depth -d " +
  "-mount -xdev -daystart -follow -noleaf -warn -nowarn -ignore_readdir_race -noignore_readdir_race ( ) ! -not -a -and -o -or ,").split(" "));
function scanFindCommand(tokens, cmdIdx, endIdx, depth = 0) {
  const starts = [], pathItems = [], startPoints = [], writeTargets = [];
  let uncertain = depth > 4, mutates = false, inExpr = false;
  for (let i = cmdIdx + 1; i < endIdx;) {
    i = nextNonRedirectIndex(tokens, i, endIdx);
    if (i < 0 || i >= endIdx) {
      if (i < 0) uncertain = true;
      break;
    }
    const tok = tokens[i], v = tok.value;
    if (!inExpr && (v === "-H" || v === "-L" || v === "-P" || /^-O\d*$/.test(v))) {
      i++;
      continue;
    }
    if (!inExpr && v === "-D") {
      const di = nextNonRedirectIndex(tokens, i + 1, endIdx);
      if (di < 0 || di >= endIdx) {
        uncertain = true;
        break;
      }
      i = di + 1;
      continue;
    }
    if (!inExpr && !v.startsWith("-") && !["(", "!", ","].includes(v)) {
      pathItems.push({ value: v, globPositions: tok.globPositions, hasUnquotedGlob: tok.hasUnquotedGlob, isOperand: true });
      startPoints.push(v);
      i++;
      continue;
    }
    inExpr = true;
    if (v === "-delete") mutates = true;
    if (!tok.quoted && ["-exec", "-execdir", "-ok", "-okdir"].includes(v)) {
      let t = i + 1;
      while (t < endIdx) {
        const rt = skipSingleRedirect(tokens, t);
        if (rt) t = rt.nextIdx;
        else if (!tokens[t].quoted && (tokens[t].value === ";" || (tokens[t].value === "+" && t > i + 1 && tokens[t - 1]?.value === "{}"))) break;
        else t++;
      }
      if (i + 1 >= endIdx || t === i + 1 || t >= endIdx) {
        uncertain = true;
        break;
      }
      const uw = unwrapCommandPrefix(tokens, i + 1, t);
      if (uw.uncertain) uncertain = true;
      starts.push({ startPos: i + 1, cmdIdx: uw.cmdIdx, endIdx: t, localCwd: uw.localCwd });
      const execVerb = uw.cmdIdx < t ? normalizeCmdName(tokens[uw.cmdIdx].value) : "";
      if (OBVIOUS_MUTATION_VERBS.has(execVerb) || SHELL_INTERPRETERS.has(execVerb) || CODE_INTERPRETERS.has(execVerb)) mutates = true;
      if (execVerb === "find" && depth < 4) {
        const n = scanFindCommand(tokens, uw.cmdIdx, t, depth + 1);
        starts.push(...n.starts);
        if (n.uncertain) uncertain = true;
      }
      i = t + 1;
    } else if (FIND_NON_PATH_VAL.has(v) || FIND_FILE_VAL.has(v) || /^-(?:newer[aBcmMt]{2})$/.test(v) || v === "-fprintf") {
      const a1 = nextNonRedirectIndex(tokens, i + 1, endIdx);
      const a2 = v === "-fprintf" && a1 >= 0 && a1 < endIdx ? nextNonRedirectIndex(tokens, a1 + 1, endIdx) : a1;
      if (a1 < 0 || a1 >= endIdx || a2 < 0 || a2 >= endIdx) {
        uncertain = true;
        break;
      }
      const vt = tokens[a1];
      if (!FIND_NON_PATH_VAL.has(v) && !/^-(?:newer[aBcmMt]t)$/.test(v)) {
        pathItems.push({ value: vt.value, globPositions: vt.globPositions, hasUnquotedGlob: vt.hasUnquotedGlob, isOperand: true });
      }
      if (FIND_WRITE_VAL.has(v)) writeTargets.push(vt.value);
      i = a2 + 1;
    } else if (FIND_NO_ARG.has(v)) i++;
    else {
      uncertain = true;
      pathItems.push({ value: v, globPositions: tok.globPositions, isOperand: !v.startsWith("-") });
      i++;
    }
  }
  return { starts, pathItems, startPoints, writeTargets, mutates, implicitCwd: uncertain || startPoints.length === 0, uncertain };
}
const KW_OPEN = { "{": [null, "{"], if: [null, "if"], while: [null, "loop"], until: [null, "loop"],
  then: ["if", "then"], do: ["loop", "do"], elif: ["then", "if"], else: ["then", "else"] };
const KW_CLOSE = { "}": ["{"], fi: ["then", "else"], done: ["do"] };
// shortcut: case/select/[[/function/coproc mark syntax uncertain instead of full compound AST parsing, upgrade if needed
function analyzeSegmentCommandStarts(segments, { allowPartialCompound = false } = {}) {
  const stack = [], perSegment = [], hasBranch = () => stack.some((s) => s !== "{");
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const tokens = getSegTokens(segments[segIdx]), starts = [], forWordTokens = [], preBranch = hasBranch();
    let uncertainSyntax = hasMalformedRedirects(tokens), cursor = 0, terminal = false;
    for (let guard = 0; cursor < tokens.length && guard < 24; guard++) {
      const redir = skipSingleRedirect(tokens, cursor);
      if (redir) {
        cursor = redir.nextIdx;
        continue;
      }
      const tok = tokens[cursor], kw = tok.value.toLowerCase();
      if (tok.isSubshellGroup) {
        terminal = true;
        if (tok.unclosedSubshell || !onlyRedirectsRemain(tokens, cursor + 1)) uncertainSyntax = true;
        break;
      }
      if (tok.quoted) break;
      if (kw === "!" || kw === "time" || (cursor === 0 && kw === "&")) cursor++;
      else if (kw in KW_CLOSE) {
        terminal = true;
        if (KW_CLOSE[kw].includes(stack[stack.length - 1])) stack.pop();
        else if (!allowPartialCompound) uncertainSyntax = true;
        if (!onlyRedirectsRemain(tokens, cursor + 1)) uncertainSyntax = true;
        break;
      } else if (kw in KW_OPEN) {
        const req = KW_OPEN[kw][0], popped = req ? stack.pop() : null;
        if (req && popped !== req && !allowPartialCompound) uncertainSyntax = true;
        stack.push(KW_OPEN[kw][1]);
        cursor++;
        if (cursor >= tokens.length) uncertainSyntax = true;
      } else if (kw === "for") {
        const w2 = cursor + 2 < tokens.length && !tokens[cursor + 2].quoted ? tokens[cursor + 2].value.toLowerCase() : null;
        if (cursor + 1 < tokens.length && w2 === "do") {
          stack.push("do");
          cursor += 3;
          if (cursor >= tokens.length) uncertainSyntax = true;
        } else {
          terminal = true;
          stack.push("loop");
          if (cursor + 1 >= tokens.length || (w2 !== null && w2 !== "in")) uncertainSyntax = true;
          for (let w = w2 === "in" ? cursor + 3 : tokens.length; w < tokens.length; w++) {
            const r = skipSingleRedirect(tokens, w);
            if (r) w = r.nextIdx - 1;
            else forWordTokens.push(tokens[w]);
          }
          break;
        }
      } else if (["select", "case", "esac", "[[", "]]", "function", "coproc"].includes(kw) || tok.raw.endsWith(")")) {
        uncertainSyntax = true;
        cursor++;
      } else break;
    }
    if (!terminal && cursor < tokens.length) {
      if (tokens.slice(cursor).some((t) => t.isSubshellGroup)) uncertainSyntax = true;
      const uw = unwrapCommandPrefix(tokens, cursor, tokens.length);
      if (uw.uncertain) uncertainSyntax = true;
      if (uw.cmdIdx < tokens.length && tokens[uw.cmdIdx].isSubshellGroup) {
        if (tokens[uw.cmdIdx].unclosedSubshell || !onlyRedirectsRemain(tokens, uw.cmdIdx + 1)) uncertainSyntax = true;
      } else {
        starts.push({ startPos: cursor, cmdIdx: uw.cmdIdx, endIdx: tokens.length, localCwd: uw.localCwd });
        if (uw.cmdIdx < tokens.length && normalizeCmdName(tokens[uw.cmdIdx].value) === "find") {
          const f = scanFindCommand(tokens, uw.cmdIdx, tokens.length);
          if (f.uncertain) uncertainSyntax = true;
          starts.push(...f.starts);
        }
      }
    }
    perSegment.push({ starts, forWordTokens, uncertainSyntax, inCompoundBranch: preBranch || hasBranch() });
  }
  return { perSegment, unclosedCompound: !allowPartialCompound && stack.length > 0 };
}
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
      const next = tokens[i + 1], isFdDup = /^(?:\d+)?(?:>&|<&)$/.test(tok.raw) && next && !next.quoted && /^\d+$/.test(next.raw);
      if (next && !isUnquotedRedir(next)) {
        if (tok.raw !== "<<" && tok.raw !== "<<-" && tok.raw !== "<<<" && !isFdDup && (!writeOnly || tok.raw.includes(">"))) targets.push(next);
        i++;
      }
    } else {
      const m = tok.raw.match(REDIRECT_ATTACHED_REGEX);
      if (!m) continue;
      const op = tok.raw.slice(0, tok.raw.length - m[1].length), val = m[1].replace(/^["']|["']$/g, "");
      if (op !== "<<" && op !== "<<-" && op !== "<<<" && !(/^(?:\d+)?(?:>&|<&)$/.test(op) && /^(?:\d+|-)$/.test(val)) && (!writeOnly || op.includes(">"))) {
        targets.push({ raw: m[1], value: val, quoted: /^["']/.test(m[1]), globPositions: [], hasUnquotedGlob: false });
      }
    }
  }
  return targets;
}
export const extractRedirectTargets = (tokens, writeOnly = false) => extractRedirectTargetTokens(tokens, writeOnly).map((t) => t.value);
function extractHereStringPayloads(tokens) {
  const payloads = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].quoted) continue;
    if (/^(?:\d+)?<<<$/.test(tokens[i].raw) && i + 1 < tokens.length && !isUnquotedRedir(tokens[i + 1])) payloads.push(tokens[++i].value);
    else if (/^(?:\d+)?<<<(.+)$/.test(tokens[i].raw)) {
      const raw = tokens[i].raw.replace(/^(?:\d+)?<<</, "");
      payloads.push(tokenizeShellWordsDetailed(raw)[0]?.value ?? raw);
    }
  }
  return payloads;
}
function unwrapShellWrapper(segText) {
  const re = /^((?:cmd(?:\.exe)?\s+\/[cC]|(?:powershell|pwsh)(?:\.exe)?\s+(?:-Command|-c)|(?:bash|sh|zsh|dash)\s+-[a-z]*c)\s+)(["'])([\s\S]*)\2$/i;
  const m = segText.match(re);
  return m ? { prefix: m[1], quote: m[2], inner: m[3] } : null;
}
function collectSegmentChildScripts(seg, segInfo, segments, segIdx, heredocMode = "none") {
  const list = [], seen = new Set(), tokens = getSegTokens(seg);
  const add = (localCwd, innerScript) => {
    const key = innerScript ? `${localCwd || ""}\0${innerScript}` : "";
    if (key && !seen.has(key) && seen.add(key)) list.push({ localCwd: localCwd || null, innerScript });
  };
  const unwrapRange = (det, startPos, endIdx = det.length, rawSlice = "") => {
    let h = startPos;
    while (h < endIdx) {
      const r = skipSingleRedirect(det, h);
      if (r) h = r.nextIdx;
      else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(det[h].raw) || (!det[h].quoted && SHELL_CONTROL_KEYWORDS.has(det[h].value.toLowerCase()))) h++;
      else break;
    }
    if (h >= endIdx - 1) return null;
    const restVals = (from) => {
      const out = [];
      for (let k = from; k < endIdx; k++) {
        const r = skipSingleRedirect(det, k);
        if (r) k = r.nextIdx - 1;
        else out.push(det[k].value);
      }
      return out;
    };
    const cmd0 = normalizeCmdName(det[h].value);
    if (cmd0 === "eval") return { localCwd: null, innerScript: restVals(h + 1).join(" ") };
    if (["bash", "sh", "zsh", "dash", "ksh", "cmd", "pwsh", "powershell"].includes(cmd0)) {
      for (let i = h + 1; i < endIdx - 1; i++) {
        const r = skipSingleRedirect(det, i);
        if (r) i = r.nextIdx - 1;
        else if (det[i].value === "--") break;
        else {
          const fl = det[i].value;
          const isExec = cmd0 === "cmd" ? /^\/[ck]$/i.test(fl) : (/^(?:pwsh|powershell)$/.test(cmd0) ? /^-(?:command|c)$/i.test(fl) : /^-[a-z]*c$/i.test(fl));
          if (!isExec) continue;
          if (cmd0 === "cmd" || cmd0 === "pwsh" || cmd0 === "powershell") return { localCwd: null, innerScript: restVals(i + 1).join(" ") };
          const ni = nextNonRedirectIndex(det, i + 1, endIdx);
          if (ni >= 0 && ni < endIdx) return { localCwd: null, innerScript: det[ni].value };
        }
      }
    }
    if (["env", "sudo", "doas", "timeout", "nice"].includes(cmd0) || SIMPLE_WRAPPERS.has(cmd0)) {
      const uw = unwrapCommandPrefix(det, h, endIdx);
      if (!uw.uncertain && uw.cmdIdx > h && uw.cmdIdx < endIdx) {
        return { localCwd: uw.localCwd, innerScript: rawSlice ? rawSlice.slice(det[uw.cmdIdx].start) : restVals(uw.cmdIdx).join(" ") };
      }
    }
    return null;
  };
  const topW = seg.text ? unwrapRange(tokenizeShellWordsDetailed(seg.text), 0, undefined, seg.text) : null;
  if (topW) add(topW.localCwd, topW.innerScript);
  for (const st of segInfo.starts) {
    const w = st.cmdIdx < tokens.length && st.cmdIdx < st.endIdx ? unwrapRange(tokens, st.cmdIdx, st.endIdx) : null;
    if (w) add(joinLocalCwd(st.localCwd, w.localCwd), w.innerScript);
  }
  if (seg.hasHereString) {
    const payloads = extractHereStringPayloads(tokens);
    const pipesShell = segments ? segmentPipesToShell(segments, segIdx) : SHELL_INTERPRETERS.has(getSegmentCmdName(seg));
    for (const st of segInfo.starts) {
      if (st.cmdIdx >= tokens.length || st.cmdIdx >= st.endIdx) continue;
      const verb = normalizeCmdName(tokens[st.cmdIdx].value);
      if (SHELL_INTERPRETERS.has(verb) || pipesShell) payloads.forEach((p) => add(st.localCwd, p));
      else if (verb === "xargs") {
        const xr = unwrapCommandPrefix(tokens, st.cmdIdx, st.endIdx, { unwrapXargs: true }), subToks = [];
        for (let k = xr.uncertain ? st.cmdIdx + 1 : xr.cmdIdx; k < st.endIdx; k++) {
          const r = skipSingleRedirect(tokens, k);
          if (r) k = r.nextIdx - 1;
          else subToks.push(tokens[k].value);
        }
        payloads.forEach((p) => add(st.localCwd, `${subToks.length ? subToks.join(" ") : "echo"} ${JSON.stringify(p)}`));
      }
    }
  }
  (seg.subshells || []).forEach((sub) => add(null, sub));
  if (seg.heredocBodies?.length && (heredocMode === "all" || (heredocMode === "shellPipe" && segmentPipesToShell(segments, segIdx)))) {
    seg.heredocBodies.forEach((hd) => add(null, hd));
  }
  return list;
}
const isSingleUnchainedShellCmd = (segs) => Boolean(segs.length === 1 && (!segs[0].leadingSep || segs[0].leadingSep === "\n") &&
  !segs[0].hasRedirect && !segs[0].hasHeredoc && !segs[0].hasSubshell && !hasDotDotTraversal(segs[0].text));
const OBVIOUS_MUTATION_VERBS = new Set("rm del remove-item mv cp ln tee truncate shred dd patch chmod chown sed perl find install".split(" "));
const DIR_MUTATION_VERBS = new Set(["rm", "del", "remove-item", "mv", "cp", "ln", "chmod", "chown", "find"]);
const DESTRUCTIVE_CONFIG_VERBS = new Set(["rm", "del", "remove-item", "mv", "ln", "truncate", "shred", "dd", "chmod", "chown", "find"]);
function extractVerbMutationTargets(verb, tokens, cmdIdx, endIdx = tokens.length) {
  if (verb === "find") {
    const f = scanFindCommand(tokens, cmdIdx, endIdx), t = [...(f.mutates ? (f.startPoints.length ? f.startPoints : ["."]) : []), ...f.writeTargets];
    return { benchTargets: t, govTargets: t };
  }
  const vals = [], nonFlag = [];
  for (let i = cmdIdx + 1, dd = false; i < endIdx; i++) {
    const r = skipSingleRedirect(tokens, i);
    if (r) i = r.nextIdx - 1;
    else {
      const v = tokens[i].value;
      vals.push(v);
      if (!dd && v === "--") dd = true;
      else if (dd || !v.startsWith("-") || v === "-") nonFlag.push(v);
    }
  }
  if (verb === "cp" || verb === "ln") {
    const targetDirs = [], pos = [], vf = new Set(["-S", "--suffix", "--no-preserve", "--sparse"]);
    for (let i = 0, dd = false; i < vals.length; i++) {
      const v = vals[i];
      if (!dd && v === "--") dd = true;
      else if (!dd && v.startsWith("-") && v !== "-") {
        if ((v === "-t" || v === "--target-directory" || (!v.startsWith("--") && /^-[^-]*t$/.test(v))) && vals[i + 1]) targetDirs.push(vals[++i]);
        else if (v.startsWith("--target-directory=")) targetDirs.push(v.slice(19));
        else if (!v.startsWith("--") && /^-[^-]*t(.+)$/.test(v)) targetDirs.push(v.slice(v.indexOf("t") + 1));
        else if (vf.has(v) && i + 1 < vals.length) i++;
      } else pos.push(v);
    }
    const dests = targetDirs.length ? targetDirs : (pos.length >= 2 ? [pos[pos.length - 1]] : []);
    return { benchTargets: dests, govTargets: verb === "ln" ? [...dests, ...pos] : dests };
  }
  if (verb === "dd") {
    const t = vals.filter((v) => v.startsWith("of=")).map((v) => v.slice(3)).filter(Boolean);
    return { benchTargets: t, govTargets: t };
  }
  if (verb === "sed" || verb === "perl") {
    const iIdx = vals.indexOf("--"), pre = iIdx === -1 ? vals : vals.slice(0, iIdx);
    const hasI = pre.some((v) => v === "-i" || (verb === "sed" && v === "-I") || v.startsWith("--in-place") ||
      (verb === "sed" ? /^-[a-zA-Z0-9]*[iI]/.test(v) : /^-[a-zA-Z0-9]*i/.test(v)));
    const t = hasI ? nonFlag : [];
    return { benchTargets: t, govTargets: t };
  }
  return { benchTargets: nonFlag, govTargets: nonFlag };
}
export function segmentPipesToShell(segments, idx) {
  for (let j = idx; j < segments.length && (j === idx || ["|", "|&"].includes(segments[j].leadingSep)); j++) {
    if (SHELL_INTERPRETERS.has(getSegmentCmdName(segments[j]))) return true;
  }
  return false;
}
const GOV_MUTATION_DENY_REASON =
  "Antigravity Execution Governance: Shell mutation of protected Antigravity hook, shim, or governance source files is strictly prohibited.";
const BENCH_MUTATION_ASK_REASON = "[BENCHMARK MUTATION DETECTED] Shell command mutation of protected evaluator/benchmark artifact requires explicit user " +
  "confirmation to prevent benchmark contamination. Set AGY_DISABLE_BENCHMARK_GUARD=1 to disable this guard for non-evaluation repos.";
function directSubdirsBounded(baseCwd, limit = 64) {
  if (!baseCwd) return [];
  const resolved = expandLeadingTilde(baseCwd), dirs = [];
  try {
    for (const d of fs.readdirSync(resolved, { withFileTypes: true })) {
      if (dirs.length < limit && (d.isDirectory() || d.isSymbolicLink())) dirs.push(path.join(resolved, d.name));
    }
  } catch {}
  return dirs;
}
function isAccessibleDirectory(d) {
  if (!safeStat(d)?.isDirectory()) return false;
  try {
    fs.accessSync(d, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function stepTopLevelCd(tokens, cmdIdx, endIdx, curCwd, opts = {}) {
  const { inPipeline = false, inCompoundBranch = false, leadingSep = "", nextLeadingSep = "", fallbackExits = false } = opts;
  // shortcut: non-top-level, conditional, glob, or dynamic cd marks cwd uncertain instead of branching state, upgrade if needed
  if (inPipeline || inCompoundBranch || leadingSep === "||" || (nextLeadingSep === "||" && !fallbackExits)) {
    return { cwd: curCwd, uncertain: true, homeHint: false };
  }
  const posTokens = [];
  for (let i = cmdIdx + 1, sawDD = false; i < endIdx; i++) {
    const r = skipSingleRedirect(tokens, i);
    if (r && r.missingTarget) return { cwd: curCwd, uncertain: true, homeHint: false };
    if (r) i = r.nextIdx - 1;
    else if (!sawDD && tokens[i].value === "--") sawDD = true;
    else if (!sawDD && (["-L", "-P", "-e", "-@"].includes(tokens[i].value) || tokens[i].value.toLowerCase() === "/d")) continue;
    else if (!sawDD && tokens[i].value.startsWith("-") && tokens[i].value !== "-") return { cwd: curCwd, uncertain: true, homeHint: false };
    else posTokens.push(tokens[i]);
  }
  if (posTokens.length > 1) return { cwd: curCwd, uncertain: true, homeHint: false };
  const stepTo = (dir, hint) => (nextLeadingSep === ";" && !isAccessibleDirectory(dir)
    ? { cwd: curCwd, uncertain: true, homeHint: hint } : { cwd: dir, uncertain: false, homeHint: false });
  if (posTokens.length === 0) return stepTo(getProfileHomeDir(), true);
  const t = posTokens[0], rawVal = t.value;
  const hasExp = (!t.quoted && /[$`%]/.test(t.raw)) || (t.quoted && t.raw.includes('"') && /(?:^|[^\\])[$`%]/.test(t.raw));
  const homeHint = /^(?:~|\/|[A-Za-z]:)|\b(?:HOME|USERPROFILE|LOCALAPPDATA|XDG_STATE_HOME)\b/i.test(t.raw);
  if (rawVal === "-" || hasExp || /^~[^/\\]+/.test(rawVal) || t.hasUnquotedGlob) return { cwd: curCwd, uncertain: true, homeHint };
  return stepTo(resolveHookPath(expandLeadingTilde(rawVal), curCwd), homeHint);
}
function stepSegmentCd(segments, perSegment, segIdx, tokens, cmdIdx, endIdx, segCwd) {
  const seg = segments[segIdx], nextSeg = segments[segIdx + 1], nextInfo = perSegment[segIdx + 1], nextSep = nextSeg?.leadingSep || "";
  const fbToks = nextSeg && nextSep === "||" && nextInfo?.starts?.length ? getSegTokens(nextSeg) : null;
  const fbLast = fbToks ? nextInfo.starts[nextInfo.starts.length - 1] : null;
  const fbVerb = fbLast && fbLast.cmdIdx < fbToks.length ? normalizeCmdName(fbToks[fbLast.cmdIdx].value) : "";
  const fallbackExits = (fbVerb === "exit" || fbVerb === "return") && (segIdx + 2 >= segments.length || segments[segIdx + 2].leadingSep !== "||");
  return stepTopLevelCd(tokens, cmdIdx, endIdx, segCwd, {
    inPipeline: ["|", "|&"].includes(seg.leadingSep) || ["|", "|&"].includes(nextSep),
    inCompoundBranch: perSegment[segIdx].inCompoundBranch, leadingSep: seg.leadingSep, nextLeadingSep: nextSep, fallbackExits
  });
}
function checkShellMutations(segments, convId, ctx, depth = 0) {
  if (depth > 4) return null;
  let curCwd = ctx?.cwd || "", cwdUncertain = false, pendingForceAsk = null;
  const benchDisabled = isBenchmarkGuardDisabled(convId, ctx), home = getProfileHomeDir();
  const protectedMutCwds = [home, path.join(home, ".gemini"), path.join(home, ".gemini", "config"),
    path.join(home, ".gemini", "antigravity"), getStateDir(), HOOK_REPO_ROOT];
  const record = (res) => {
    if (!res) return null;
    if (res.decision === "deny") return res;
    pendingForceAsk ||= res;
    return null;
  };
  const { perSegment } = analyzeSegmentCommandStarts(segments, { allowPartialCompound: depth > 0 });
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx], segInfo = perSegment[segIdx], segCwd = curCwd, segUnc = cwdUncertain, tokens = getSegTokens(seg);
    const mutCwdsFor = (lc) => lc ? [resolveHookPath(expandLeadingTilde(lc), segCwd)]
      : (segUnc ? [...new Set([segCwd, ...directSubdirsBounded(segCwd, 32), ...protectedMutCwds])] : [segCwd]);
    const govChecks = [], benchChecks = [];
    for (const tok of (seg.hasWriteRedirect ? extractRedirectTargets(tokens, true) : [])) {
      for (const effCwd of mutCwdsFor(null)) {
        govChecks.push({ tok, isDirVerb: false, isDestructive: false, effCwd });
        benchChecks.push({ tok, effCwd });
      }
    }
    for (const { cmdIdx, endIdx, localCwd } of segInfo.starts) {
      if (cmdIdx >= tokens.length || cmdIdx >= endIdx) continue;
      let verb = normalizeCmdName(tokens[cmdIdx].value), effCmdIdx = cmdIdx, effTokens = tokens, effEndIdx = endIdx;
      if (verb === "cd") {
        const stepped = stepSegmentCd(segments, perSegment, segIdx, tokens, cmdIdx, endIdx, segCwd);
        curCwd = stepped.cwd;
        if (stepped.uncertain) cwdUncertain = true;
        continue;
      }
      if (verb === "pushd" || verb === "popd" || verb === "eval" || verb === "source" || verb === ".") {
        cwdUncertain = true;
        continue;
      }
      if (verb === "xargs") {
        const xr = unwrapCommandPrefix(tokens, cmdIdx, endIdx, { unwrapXargs: true });
        if (xr.uncertain) return { decision: "deny", reason: GOV_MUTATION_DENY_REASON };
        verb = xr.cmdIdx < endIdx ? normalizeCmdName(tokens[xr.cmdIdx].value) : "echo";
        const piped = [];
        if (segIdx > 0 && ["|", "|&"].includes(seg.leadingSep)) {
          const prevToks = getSegTokens(segments[segIdx - 1]), pStart = perSegment[segIdx - 1].starts[0]?.cmdIdx ?? -1;
          for (let k = pStart + 1; k < prevToks.length; k++) {
            const r = skipSingleRedirect(prevToks, k);
            if (r) k = r.nextIdx - 1;
            else if (!prevToks[k].value.startsWith("-") || prevToks[k].value === "-") piped.push(prevToks[k]);
          }
        }
        if (SHELL_INTERPRETERS.has(verb) || CODE_INTERPRETERS.has(verb)) {
          if (piped.length > 0) {
            const subCmd = [...tokens.slice(xr.cmdIdx, endIdx), ...piped].map((t) => t.value).join(" ");
            const d = record(checkShellMutations(splitShellSegments(subCmd), convId, { ...ctx, cwd: segCwd }, depth + 1));
            if (d) return d;
          }
          continue;
        }
        effTokens = [...tokens.slice(xr.cmdIdx, endIdx), ...piped];
        effCmdIdx = 0;
        effEndIdx = effTokens.length;
      }
      if (!OBVIOUS_MUTATION_VERBS.has(verb)) continue;
      const { govTargets, benchTargets } = extractVerbMutationTargets(verb, effTokens, effCmdIdx, effEndIdx);
      for (const effCwd of mutCwdsFor(localCwd)) {
        for (const tok of govTargets) {
          govChecks.push({ tok, isDirVerb: DIR_MUTATION_VERBS.has(verb), isDestructive: DESTRUCTIVE_CONFIG_VERBS.has(verb), effCwd });
        }
        benchTargets.forEach((tok) => benchChecks.push({ tok, effCwd }));
      }
    }
    if (seg.hasHereString && CODE_INTERPRETERS.has(getSegmentCmdName(seg)) &&
        extractHereStringPayloads(tokens).some((p) => /\.gemini\b|agy-context(?:-saver)?\b|mcp_config\.json|hooks\.json/i.test(p))) {
      return { decision: "deny", reason: GOV_MUTATION_DENY_REASON };
    }
    for (const { tok, isDirVerb, isDestructive, effCwd } of govChecks) {
      const scopedCtx = { ...ctx, cwd: effCwd };
      if (isDirVerb && isProtectedGovernanceDirPath(tok, effCwd)) return { decision: "deny", reason: GOV_MUTATION_DENY_REASON };
      if (isProtectedGovernanceFileMutationPath(tok, convId, scopedCtx)) {
        if (!isDestructive && isUserEditableGeminiConfigPath(tok, convId, scopedCtx)) {
          const msg = `[GEMINI CONFIG MUTATION] Shell edit to Antigravity user configuration '${tok}' requires explicit user confirmation.`;
          record({ decision: "force_ask", reason: msg });
        } else return { decision: "deny", reason: GOV_MUTATION_DENY_REASON };
      }
    }
    if (!benchDisabled && benchChecks.some(({ tok, effCwd }) => isProtectedBenchmarkFilePath(tok, effCwd))) {
      record({ decision: "force_ask", reason: BENCH_MUTATION_ASK_REASON });
    }
    for (const child of collectSegmentChildScripts(seg, segInfo, segments, segIdx, "shellPipe")) {
      const nextCwd = child.localCwd ? resolveHookPath(expandLeadingTilde(child.localCwd), segCwd) : segCwd;
      const d = record(checkShellMutations(splitShellSegments(child.innerScript), convId, { ...ctx, cwd: nextCwd }, depth + 1));
      if (d) return d;
    }
  }
  return pendingForceAsk;
}
const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack", "select-string"]);
function makeOptionSpec({ sb = "", sr = "", so = "", lb = "", lr = "", lo = "", lfr = "", patNoArg = "", hasPattern = true, allowNoPrefix = false }) {
  const sw = (s) => s.trim().split(/\s+/).filter(Boolean).map((w) => (w.startsWith("--") ? w : `--${w}`)), pna = new Set(sw(patNoArg)), baseLb = sw(lb);
  const negLb = allowNoPrefix ? baseLb.filter((f) => !f.startsWith("--no-")).map((f) => `--no-${f.slice(2)}`) : [];
  return { sb: new Set(sb), sr: new Set(sr), so: new Set(so), lb: new Set([...baseLb, ...pna, ...negLb]),
    lr: new Set(sw(lr)), lo: new Set(sw(lo)), lfr: new Set(sw(lfr)), pna, hasPattern };
}
const OPTION_SPECS = {
  rg: makeOptionSpec({
    sb: "zsFivxUPSawL.ubhnN0opqHIclV", sr: "efEmjgdtTABCMr", allowNoPrefix: true,
    patNoArg: "files type-list pcre2-version help version", lfr: "file ignore-file pre hostname-bin",
    lb: "search-zip case-sensitive crlf fixed-strings ignore-case invert-match line-regexp mmap multiline multiline-dotall unicode null-data pcre2 " +
      "smart-case text word-regexp binary follow glob-case-insensitive hidden ignore ignore-dot ignore-files ignore-global ignore-parent ignore-vcs " +
      "one-file-system unrestricted byte-offset column heading line-buffered line-number max-columns-preview null only-matching passthru pretty quiet " +
      "trim vimgrep with-filename no-filename sort-files count count-matches files-with-matches files-without-match json debug messages stats config",
    lr: "regexp file ignore-file pre pre-glob hostname-bin encoding engine max-count threads glob iglob max-depth max-filesize type type-not type-add " +
      "type-clear after-context before-context context color colors context-separator max-columns path-separator replace sort sortr" }),
  grep: makeOptionSpec({
    sb: "EFGPiyvwxzsbnHhoqaIrRLlcTZUV0123456789", sr: "efmdDABC", patNoArg: "help version", lo: "color colour", lfr: "file exclude-from",
    lb: "extended-regexp fixed-strings basic-regexp perl-regexp ignore-case no-ignore-case word-regexp line-regexp null-data no-messages invert-match " +
      "byte-offset line-number line-buffered with-filename no-filename only-matching quiet silent text recursive dereference-recursive " +
      "files-without-match files-with-matches count initial-tab null no-group-separator binary",
    lr: "regexp file exclude-from max-count label binary-files directories devices include exclude exclude-dir before-context after-context " +
      "context group-separator" }),
  "git-grep": makeOptionSpec({
    sb: "viwaIrEGFPnhHlLzocpWqu0123456789", sr: "efCBAm", so: "O", patNoArg: "help", allowNoPrefix: true, lfr: "file",
    lo: "color no-color open-files-in-pager no-open-files-in-pager",
    lb: "cached no-index index untracked exclude-standard recurse-submodules invert-match ignore-case word-regexp text textconv recursive " +
      "extended-regexp basic-regexp fixed-strings perl-regexp line-number column full-name files-with-matches name-only files-without-match null " +
      "only-matching count break heading show-function function-context and or not quiet all-match ext-grep",
    lr: "regexp file max-depth context before-context after-context threads max-count" }),
  ls: makeOptionSpec({
    hasPattern: false, sb: "aAbBcCdDfFgGhHiklLmnNopqQrRsStuUvxXZ1", sr: "IwT", lo: "color hyperlink indicator-style classify",
    lb: "all almost-all author directory file-type full-time group-directories-first no-group human-readable si inode dereference numeric-uid-gid " +
      "literal quote-name reverse recursive size context zero help version",
    lr: "ignore hide block-size format quoting-style sort time time-style width tabsize" })
};
const shiftGlobPositions = (gp, off) => Array.isArray(gp) ? gp.filter((g) => g >= off).map((g) => g - off) : null;
export function collapseActiveShellGlob(value, globPositions = null) {
  if (!value || typeof value !== "string") return value;
  const idx = Array.isArray(globPositions) ? (globPositions.length > 0 ? globPositions[0] : -1) : value.search(/[*?\[]/);
  if (idx < 0) return value;
  const prefix = value.slice(0, idx);
  return (prefix.endsWith("/") || prefix.endsWith(path.sep)) ? (prefix.slice(0, -1) || prefix) : path.dirname(`${prefix}_`);
}
function expandItemPathCandidates(item) {
  const value = typeof item === "string" ? item : item.value, gp = typeof item === "string" ? null : (item.globPositions ?? []);
  const isOperand = typeof item === "string" ? false : Boolean(item.isOperand);
  if (!value || typeof value !== "string") return [];
  const out = [{ value, globPositions: gp, isOperand }];
  if (!isOperand) {
    for (const ch of ["=", "@"]) {
      const p = value.indexOf(ch);
      if (p !== -1 && p + 1 < value.length) out.push({ value: value.slice(p + 1), globPositions: shiftGlobPositions(gp, p + 1), isOperand: true });
    }
    if (value.startsWith("-") && !value.startsWith("--")) {
      for (let i = 1; i < value.length && /[A-Za-z0-9]/.test(value[i]); i++) {
        if ("FfCKToa".includes(value[i]) && i + 1 < value.length) {
          out.push({ value: value.slice(i + 1), globPositions: shiftGlobPositions(gp, i + 1), isOperand: true });
        }
      }
    }
  }
  return out;
}
export const expandInlinePathCandidates = (raw) => expandItemPathCandidates(raw).map((c) => c.value);
function parseOptionRoles(tokens, argStart, endIdx, dialect, { stdinSupplied = false } = {}) {
  const spec = OPTION_SPECS[dialect] || null, fileTargets = [], unknownOpts = [], preDD = [], postDD = [];
  let hasExplicitPat = false, sawDD = false, uncertain = !spec, grepRecursive = false;
  let gitUntracked = false, gitNoIndex = false, gitUnsupported = false, executesHelper = false;
  const recVal = (optKey, val, gp, isFile) => {
    if (optKey === "--regexp" || optKey === "--file" || optKey === "e" || optKey === "f") hasExplicitPat = true;
    if (dialect === "grep" && (optKey === "--directories" || optKey === "d") && val === "recurse") grepRecursive = true;
    if (isFile) fileTargets.push({ value: val, globPositions: gp, isOperand: true });
  };
  for (let i = argStart; i < endIdx; i++) {
    i = nextNonRedirectIndex(tokens, i, endIdx);
    if (i < 0 || i >= endIdx) {
      if (i < 0) uncertain = true;
      break;
    }
    const tok = tokens[i], v = tok.value;
    if (!sawDD && v === "--") sawDD = true;
    else if (sawDD) postDD.push({ value: v, globPositions: tok.globPositions, hasUnquotedGlob: tok.hasUnquotedGlob, isOperand: true });
    else if (dialect === "git-grep" && !tok.quoted && (v === "(" || v === ")")) continue;
    else if (v.startsWith("--") && v.length > 2) {
      const eq = v.indexOf("="), opt = eq === -1 ? v : v.slice(0, eq);
      if (opt === "--pre" || opt === "--hostname-bin" || opt === "--open-files-in-pager") executesHelper = true;
      if (dialect === "grep" && (opt === "--recursive" || opt === "--dereference-recursive")) grepRecursive = true;
      if (dialect === "git-grep" && opt === "--untracked") gitUntracked = true;
      else if (dialect === "git-grep" && opt === "--no-index") gitNoIndex = true;
      else if (dialect === "git-grep" && ["--cached", "--recurse-submodules", "--textconv"].includes(opt)) gitUnsupported = true;
      if (spec && eq !== -1 && (spec.lr.has(opt) || spec.lo.has(opt))) {
        recVal(opt, v.slice(eq + 1), shiftGlobPositions(tok.globPositions, eq + 1), spec.lfr.has(opt));
      } else if (spec && eq === -1 && (spec.lb.has(opt) || spec.lo.has(opt))) {
        if (spec.pna.has(opt)) hasExplicitPat = true;
      } else if (spec && eq === -1 && spec.lr.has(opt)) {
        const vi = nextNonRedirectIndex(tokens, i + 1, endIdx);
        if (vi < 0 || vi >= endIdx) {
          uncertain = true;
          break;
        }
        recVal(opt, tokens[vi].value, tokens[vi].globPositions, spec.lfr.has(opt));
        i = vi;
      } else {
        uncertain = true;
        unknownOpts.push({ value: v, globPositions: tok.globPositions, isOperand: false });
      }
    } else if (v.startsWith("-") && v !== "-") {
      if (!spec) {
        uncertain = true;
        unknownOpts.push({ value: v, globPositions: tok.globPositions, isOperand: false });
      } else {
        for (let k = 1; k < v.length; k++) {
          const ch = v[k];
          if (spec.sb.has(ch)) {
            if (dialect === "git-grep" && ch === "u") gitUntracked = true;
            if (dialect === "grep" && (ch === "r" || ch === "R")) grepRecursive = true;
          } else if (spec.so.has(ch)) {
            if (dialect === "git-grep" && ch === "O") executesHelper = true;
            break;
          } else if (spec.sr.has(ch)) {
            if (k + 1 < v.length) recVal(ch, v.slice(k + 1), shiftGlobPositions(tok.globPositions, k + 1), ch === "f");
            else {
              const vi = nextNonRedirectIndex(tokens, i + 1, endIdx);
              if (vi < 0 || vi >= endIdx) uncertain = true;
              else {
                i = vi;
                recVal(ch, tokens[i].value, tokens[i].globPositions, ch === "f");
              }
            }
            break;
          } else {
            uncertain = true;
            unknownOpts.push({ value: v, globPositions: tok.globPositions, isOperand: false });
            break;
          }
        }
      }
    } else preDD.push({ value: v, globPositions: tok.globPositions, hasUnquotedGlob: tok.hasUnquotedGlob, isOperand: true });
  }
  const allPos = [...preDD, ...postDD];
  if (uncertain) return { uncertain: true, pathItems: [...fileTargets, ...unknownOpts, ...allPos], implicitCwd: true, executesHelper, gitTrackedScope: null };
  const preDDPostPat = !spec.hasPattern || hasExplicitPat ? preDD : (preDD.length > 0 ? preDD.slice(1) : []);
  const operands = !spec.hasPattern || hasExplicitPat ? allPos : (preDD.length > 0 ? [...preDDPostPat, ...postDD] : postDD.slice(1));
  let gitTrackedScope = null;
  if (dialect === "git-grep" && !gitUntracked && !gitNoIndex && !gitUnsupported && !executesHelper) {
    if (sawDD && preDDPostPat.length > 0) uncertain = true;
    else if (!(!sawDD && operands.some((op) => op.hasUnquotedGlob))) {
      gitTrackedScope = { sawDoubleDash: sawDD, pathspecs: operands.map((op) => op.value), operandItems: operands, fileTargets };
    }
  }
  const readsStdinOnly = dialect === "grep" && stdinSupplied && !grepRecursive && operands.length === 0;
  return { uncertain, pathItems: uncertain ? [...fileTargets, ...allPos] : [...fileTargets, ...operands],
    implicitCwd: uncertain || (operands.length === 0 && !readsStdinOnly), executesHelper, gitTrackedScope };
}
function parseGitPrefixBeforeSubcommand(tokens, gitIdx, endIdx) {
  const gitGlobalArgs = [], extraPathItems = [];
  let gitLocalCwd = null, hasConfigOverride = false, uncertain = false, idx = gitIdx + 1;
  while (idx < endIdx) {
    const ni = nextNonRedirectIndex(tokens, idx, endIdx);
    if (ni < 0 || ni >= endIdx) {
      if (ni < 0) uncertain = true;
      idx = endIdx;
      break;
    }
    idx = ni;
    const tok = tokens[idx], v = tok.value;
    if (v === "--") {
      idx++;
      break;
    }
    if (!v.startsWith("-") || v === "-") break;
    if (["-C", "--git-dir", "--work-tree", "--namespace", "-c", "--config-env", "--super-prefix"].includes(v)) {
      const vi = nextNonRedirectIndex(tokens, idx + 1, endIdx);
      if (vi < 0 || vi >= endIdx) {
        uncertain = true;
        idx = endIdx;
        break;
      }
      const vt = tokens[vi];
      if (v === "-c" || v === "--config-env" || v === "--super-prefix") hasConfigOverride = true;
      else gitGlobalArgs.push(v, vt.value);
      if (v === "-C") gitLocalCwd = gitLocalCwd ? path.resolve(gitLocalCwd, expandLeadingTilde(vt.value)) : vt.value;
      if (v === "-C" || v === "--git-dir" || v === "--work-tree") {
        extraPathItems.push({ value: vt.value, globPositions: vt.globPositions, isOperand: true });
      }
      idx = vi + 1;
      continue;
    }
    if (v.startsWith("-C") && v.length > 2 && !v.startsWith("--")) {
      const dirVal = v.slice(2);
      gitLocalCwd = gitLocalCwd ? path.resolve(gitLocalCwd, expandLeadingTilde(dirVal)) : dirVal;
      gitGlobalArgs.push("-C", dirVal);
      extraPathItems.push({ value: dirVal, globPositions: shiftGlobPositions(tok.globPositions, 2), isOperand: true });
    } else if (v.startsWith("--git-dir=") || v.startsWith("--work-tree=")) {
      const eq = v.indexOf("=") + 1;
      gitGlobalArgs.push(v);
      extraPathItems.push({ value: v.slice(eq), globPositions: shiftGlobPositions(tok.globPositions, eq), isOperand: true });
    } else if (v.startsWith("--namespace=")) gitGlobalArgs.push(v);
    else if ((v.startsWith("-c") && v.length > 2 && !v.startsWith("--")) || v.startsWith("--config-env=") || v.startsWith("--super-prefix=")) {
      hasConfigOverride = true;
    } else if (["-p", "--paginate", "-P", "--no-pager", "--no-replace-objects", "--bare", "--no-optional-locks"].includes(v)) {
      if (v === "--bare") gitGlobalArgs.push(v);
    } else uncertain = true;
    idx++;
  }
  const subName = idx < endIdx ? normalizeCmdName(tokens[idx].value) : "";
  return { subIdx: idx, subName, gitGlobalArgs, gitLocalCwd, hasConfigOverride, extraPathItems, uncertain };
}
const GIT_REPO_OR_EXEC_ENV_RE =
  /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|NAMESPACE|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|EXEC_PATH|EXTERNAL_DIFF|SSH)/i;
const expandKnownHomeEnv = (val) => expandLeadingTilde(String(val || "").replace(/\$\{?HOME\}?/g, getProfileHomeDir()));
function classifyCommandRoles(tokens, startPos, cmdIdx, endIdx, { hasDownstreamPipe = false, stdinSupplied = false } = {}) {
  const mk = (over) => ({ verb: "", effectiveVerb: "", pathItems: [], implicitCwd: false, recursive: false,
    uncertain: false, executesHelper: false, viaXargs: false, gitGrepScope: null, ...over });
  if (cmdIdx >= endIdx || cmdIdx >= tokens.length) return mk({});
  const prefixItems = [], gitRepoEnvPaths = [];
  let hasUnsafeGitEnv = false;
  for (let p = startPos; p < cmdIdx; p++) {
    const r = skipSingleRedirect(tokens, p);
    if (r) p = r.nextIdx - 1;
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[p].raw)) {
      const eq = tokens[p].value.indexOf("="), envName = tokens[p].value.slice(0, eq), envVal = tokens[p].value.slice(eq + 1);
      if (GIT_REPO_OR_EXEC_ENV_RE.test(envName)) {
        hasUnsafeGitEnv = true;
        if (/^GIT_(?:DIR|WORK_TREE)$/i.test(envName) && envVal) gitRepoEnvPaths.push({ value: expandKnownHomeEnv(envVal) });
      }
      prefixItems.push({ value: expandKnownHomeEnv(tokens[p].value), globPositions: tokens[p].globPositions, isOperand: false });
    }
  }
  const verb = normalizeCmdName(tokens[cmdIdx].value);
  if ((!hasDownstreamPipe && ["echo", "printf", "write-output"].includes(verb)) || verb === "cd") {
    return mk({ verb, effectiveVerb: verb, pathItems: prefixItems });
  }
  let effVerb = verb, argStart = cmdIdx + 1, viaXargs = false;
  if (verb === "xargs") {
    const xr = unwrapCommandPrefix(tokens, cmdIdx, endIdx, { unwrapXargs: true });
    if (xr.uncertain) {
      const rem = tokens.slice(xr.cmdIdx, endIdx).map((t) => ({ value: t.value, globPositions: t.globPositions, isOperand: !t.value.startsWith("-") }));
      return mk({ verb, effectiveVerb: "xargs", pathItems: [...prefixItems, ...rem], implicitCwd: true, recursive: true, uncertain: true, viaXargs: true });
    }
    const subVerb = xr.cmdIdx < endIdx ? normalizeCmdName(tokens[xr.cmdIdx].value) : "echo";
    if (subVerb === "echo" || subVerb === "printf") return mk({ verb, effectiveVerb: subVerb, pathItems: prefixItems });
    viaXargs = true;
    effVerb = subVerb;
    argStart = xr.cmdIdx + 1;
  }
  if (effVerb === "rtk" && argStart < endIdx && ["grep", "rg", "ls", "git"].includes(normalizeCmdName(tokens[argStart].value))) {
    effVerb = normalizeCmdName(tokens[argStart++].value);
  } else if (effVerb === "node" && argStart + 1 < endIdx && isTrustedLocalRtkLauncherPath(tokens[argStart].value) &&
      ["grep", "rg", "ls", "git"].includes(normalizeCmdName(tokens[argStart + 1].value))) {
    effVerb = normalizeCmdName(tokens[argStart + 1].value);
    argStart += 2;
  }
  if (effVerb === "git") {
    const gm = parseGitPrefixBeforeSubcommand(tokens, argStart - 1, endIdx);
    if (gm.subName === "grep") {
      const p = parseOptionRoles(tokens, gm.subIdx + 1, endIdx, "git-grep");
      const envItems = gitRepoEnvPaths.map((e) => ({ value: e.value, globPositions: [], isOperand: true }));
      const badEnv = hasUnsafeGitEnv && (!gitRepoEnvPaths.length || gitRepoEnvPaths.some((e) => /[$`%]/.test(e.value)));
      const okTracked = Boolean(p.gitTrackedScope && !gm.uncertain && !gm.hasConfigOverride && !hasUnsafeGitEnv && !p.uncertain && !p.executesHelper);
      const gitGrepScope = okTracked ? { gitGlobalArgs: gm.gitGlobalArgs, sawDoubleDash: p.gitTrackedScope.sawDoubleDash,
        pathspecs: p.gitTrackedScope.pathspecs, operandItems: p.gitTrackedScope.operandItems,
        nonPathspecItems: [...prefixItems, ...gm.extraPathItems, ...p.gitTrackedScope.fileTargets] } : null;
      return mk({ verb, effectiveVerb: "git-grep", localCwd: gm.gitLocalCwd, pathItems: [...prefixItems, ...envItems, ...gm.extraPathItems, ...p.pathItems],
        implicitCwd: viaXargs || p.implicitCwd || gm.uncertain || p.executesHelper || badEnv, recursive: true,
        uncertain: viaXargs || p.uncertain || gm.uncertain || p.executesHelper || hasUnsafeGitEnv, executesHelper: p.executesHelper || badEnv,
        viaXargs, gitGrepScope });
    }
  }
  if (SEARCH_COMMANDS.has(effVerb) || effVerb === "ls") {
    const dialect = effVerb === "ls" ? "ls" : (/^r(?:ip)?g(?:rep)?$/.test(effVerb) ? "rg" : (/^[ef]?grep$/.test(effVerb) ? "grep" : "unknown"));
    const p = parseOptionRoles(tokens, argStart, endIdx, dialect, { stdinSupplied: stdinSupplied && !viaXargs });
    return mk({ verb, effectiveVerb: dialect, pathItems: [...prefixItems, ...p.pathItems], implicitCwd: viaXargs || p.implicitCwd,
      recursive: true, uncertain: viaXargs || p.uncertain || p.executesHelper, executesHelper: p.executesHelper, viaXargs });
  }
  if (effVerb === "find") {
    const f = scanFindCommand(tokens, argStart - 1, endIdx);
    return mk({ verb, effectiveVerb: "find", pathItems: [...prefixItems, ...f.pathItems],
      implicitCwd: viaXargs || f.implicitCwd, recursive: true, uncertain: viaXargs || f.uncertain, viaXargs });
  }
  const genericItems = [...prefixItems];
  for (let i = viaXargs ? argStart - 1 : cmdIdx, sawDD = false; i < endIdx; i++) {
    const r = skipSingleRedirect(tokens, i);
    if (r) i = r.nextIdx - 1;
    else if (!sawDD && i > cmdIdx && tokens[i].value === "--") sawDD = true;
    else genericItems.push({ value: tokens[i].value, globPositions: tokens[i].globPositions, isOperand: sawDD });
  }
  return mk({ verb, effectiveVerb: effVerb, pathItems: genericItems, implicitCwd: viaXargs, recursive: viaXargs, viaXargs });
}
export function needsImplicitRecursiveCwd(tokens) {
  const { perSegment, unclosedCompound } = analyzeSegmentCommandStarts([{ text: "", _tokens: tokens }], { allowPartialCompound: true });
  return perSegment[0].uncertainSyntax || unclosedCompound ||
    perSegment[0].starts.some(({ startPos, cmdIdx, endIdx }) => classifyCommandRoles(tokens, startPos, cmdIdx, endIdx).implicitCwd);
}
function filterProseFlags(detailed, subIdx, envPrefix, shouldSkipPair, shouldSkipInline, asWords = false) {
  const kept = envPrefix.trim() ? [envPrefix.trim()] : [];
  for (let i = 0, afterDD = false; i < detailed.length; i++) {
    const tok = detailed[i], r = i > subIdx ? skipSingleRedirect(detailed, i) : null;
    if (i <= subIdx) kept.push(tok.value);
    else if (r) {
      for (let k = i; k < Math.min(r.nextIdx, detailed.length); k++) kept.push(detailed[k].value);
      i = r.nextIdx - 1;
    } else if (!afterDD && tok.value === "--") {
      afterDD = true;
      kept.push(tok.value);
    } else if (!afterDD) {
      const ni = nextNonRedirectIndex(detailed, i + 1, detailed.length), nextTok = ni >= 0 && ni < detailed.length ? detailed[ni] : null;
      if (shouldSkipPair(tok.value, nextTok)) {
        if (nextTok) i = ni;
      } else if (!shouldSkipInline(tok.value)) kept.push(tok.value);
    } else kept.push(tok.value);
  }
  kept.push(...extractRedirectTargets(detailed));
  return asWords ? kept : kept.join(" ");
}
export function getInspectableTextForSegment(seg, { hasDownstreamPipe = false, asWords = false } = {}) {
  const allTokens = getSegTokens(seg);
  if (!allTokens.length) return asWords ? [] : "";
  const { prefix: envPrefix } = splitEnvPrefix(seg.text, allTokens);
  const segInfo = analyzeSegmentCommandStarts([seg], { allowPartialCompound: true }).perSegment[0];
  const cmdIdx = segInfo.starts[0] ? segInfo.starts[0].cmdIdx : allTokens.length;
  if (cmdIdx >= allTokens.length) {
    const targets = [...segInfo.forWordTokens.map((t) => t.value), ...extractRedirectTargets(allTokens)];
    return asWords ? targets : targets.join(" ");
  }
  const nr = [];
  for (let i = cmdIdx; i < allTokens.length; i++) {
    const r = skipSingleRedirect(allTokens, i);
    if (r) i = r.nextIdx - 1;
    else nr.push({ tok: allTokens[i], origIdx: i });
  }
  const cmd0 = normalizeCmdName(nr[0]?.tok.value), cmd1 = normalizeCmdName(nr[1]?.tok.value), cmd2 = normalizeCmdName(nr[2]?.tok.value);
  if (!hasDownstreamPipe && ["echo", "printf", "write-output"].includes(cmd0) && segInfo.starts.length <= 1) {
    const targets = extractRedirectTargets(allTokens);
    return asWords ? targets : targets.join(" ");
  }
  const rtkBase = (t) => cmd0 === t ? 0 : (cmd0 === "rtk" && cmd1 === t ? 1
    : (cmd0 === "node" && nr[1] && isTrustedLocalRtkLauncherPath(nr[1].tok.value) && cmd2 === t ? 2 : -1));
  const skipGlobalNr = (s, vf) => {
    while (s < nr.length && nr[s].tok.value.startsWith("-")) s += vf.has(nr[s].tok.value) ? 2 : 1;
    return s;
  };
  if (segInfo.starts.length <= 1 && rtkBase("git") !== -1) {
    const gitGf = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
    const subNr = skipGlobalNr(rtkBase("git") + 1, gitGf);
    const gitSub = normalizeCmdName(nr[subNr]?.tok.value), subOrig = subNr < nr.length ? nr[subNr].origIdx : cmdIdx;
    if (gitSub === "commit" || gitSub === "tag") {
      const preRe = gitSub === "commit" ? /^-[apsnvqezoih]*m$/ : /^-[asfdvin]*m$/;
      const inlRe = gitSub === "commit" ? /^-[apsnvqezoih]*m.+/ : /^-[asfdvin]*m.+/;
      return filterProseFlags(allTokens, subOrig, envPrefix, (v) => v === "-m" || v === "--message" || preRe.test(v),
        (v) => v.startsWith("--message=") || (!v.startsWith("--") && inlRe.test(v)), asWords);
    }
    if (["log", "rev-list", "shortlog"].includes(gitSub)) {
      return filterProseFlags(allTokens, subOrig, envPrefix, (v) => v === "--grep" || v === "-S" || v === "-G",
        (v) => v.startsWith("--grep=") || ((v.startsWith("-S") || v.startsWith("-G")) && v.length > 2), asWords);
    }
  }
  const ghBase = rtkBase("gh");
  if (segInfo.starts.length <= 1 && ghBase !== -1 && ghBase + 1 < nr.length) {
    const ghGlobals = new Set(["-R", "--repo", "--hostname"]), subNr = skipGlobalNr(ghBase + 1, ghGlobals);
    const ghSub = normalizeCmdName(nr[subNr]?.tok.value), subOrig = subNr < nr.length ? nr[subNr].origIdx : cmdIdx;
    if (ghSub === "api") {
      const isFileF = (val) => String(val || "").includes("=@") && String(val).slice(String(val).indexOf("=") + 1).startsWith("@");
      return filterProseFlags(allTokens, subOrig, envPrefix,
        (v, nx) => v === "-f" || v === "--raw-field" || ((v === "-F" || v === "--field") && nx && !isFileF(nx.value)),
        (v) => v.startsWith("--raw-field=") || (v.startsWith("-f") && v.length > 2 && !v.startsWith("--")) ||
          (v.startsWith("--field=") && !isFileF(v.slice(8))) || (v.startsWith("-F") && v.length > 2 && !v.startsWith("--") && !isFileF(v.slice(2))), asWords);
    }
    if (["pr", "issue", "release"].includes(ghSub)) {
      const ghAct = normalizeCmdName(nr[skipGlobalNr(subNr + 1, ghGlobals)]?.tok.value);
      const allowC = (ghSub === "pr" || ghSub === "issue") && (ghAct === "close" || ghAct === "reopen");
      return filterProseFlags(allTokens, subOrig, envPrefix,
        (v) => ["-b", "--body", "-t", "--title", "-n", "--notes", "--subject"].includes(v) || (allowC && (v === "-c" || v === "--comment")),
        (v) => /^--(?:body|title|notes|subject)=/.test(v) || (allowC && v.startsWith("--comment=")) ||
          (!v.startsWith("--") && (allowC ? /^-[btnc].+/ : /^-[btn].+/).test(v)), asWords);
    }
  }
  const roles = segInfo.starts.map((s) => classifyCommandRoles(allTokens, s.startPos, s.cmdIdx, s.endIdx, { hasDownstreamPipe }));
  if (roles.some((r) => ["rg", "grep", "git-grep", "unknown", "find", "ls"].includes(r.effectiveVerb))) {
    const targets = [...(envPrefix.trim() ? [envPrefix.trim()] : []), ...roles.flatMap((r) => r.pathItems.map((it) => it.value))];
    targets.push(...segInfo.forWordTokens.map((fw) => fw.value), ...extractRedirectTargets(allTokens));
    return asWords ? targets : targets.join(" ");
  }
  if (asWords) return allTokens.map((tok) => tok.value);
  const unquoted = allTokens.map((t) => t.value.replace(/[\r\n]+/g, " ")).join(" ");
  return unquoted && unquoted !== seg.text ? `${seg.text}\n${unquoted}` : seg.text;
}
const CODE_FILE_ACCESS_RE = new RegExp(
  "\\b(?:open|read|readFile|readFileSync|createReadStream|readdir|listdir|scandir|walk|glob|iglob|" +
  "readlines|Path|subprocess|popen|system|exec|spawn|eval|require|import|from\\s+\\w+\\s+import|__import__|fs\\.|os\\.|io\\.|path\\.)\\b", "i"
);
function collectInspectableTexts(segments, depth = 0) {
  if (depth > 4) return [];
  const texts = [], { perSegment } = analyzeSegmentCommandStarts(segments, { allowPartialCompound: depth > 0 });
  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx], pipelineCmds = [getSegmentCmdName(seg)];
    for (let j = idx + 1; j < segments.length && ["|", "|&"].includes(segments[j].leadingSep); j++) {
      pipelineCmds.push(getSegmentCmdName(segments[j]));
    }
    const inspectable = getInspectableTextForSegment(seg, { hasDownstreamPipe: pipelineCmds.length > 1 });
    if (inspectable) texts.push(inspectable);
    for (const child of collectSegmentChildScripts(seg, perSegment[idx], segments, idx, "shellPipe")) {
      texts.push(...collectInspectableTexts(splitShellSegments(child.innerScript), depth + 1));
    }
    if (seg.hasHereString && pipelineCmds.some((c) => CODE_INTERPRETERS.has(c))) {
      texts.push(...extractHereStringPayloads(getSegTokens(seg)).filter((p) => CODE_FILE_ACCESS_RE.test(p)));
    }
    if (seg.heredocBodies?.length && !segmentPipesToShell(segments, idx)) {
      const hasXargs = pipelineCmds.includes("xargs"), hasCode = !seg.hasWriteRedirect && pipelineCmds.some((c) => CODE_INTERPRETERS.has(c));
      const writesExec = seg.hasWriteRedirect && extractRedirectTargets(getSegTokens(seg), true).some(isExecutableScriptPath);
      texts.push(...seg.heredocBodies.filter((hd) => hd && (hasXargs || (hasCode && CODE_FILE_ACCESS_RE.test(hd)) || writesExec || /^\s*#!/.test(hd))));
    }
  }
  return texts;
}
function wouldNaiveScopeTouchProtected(baseCwd, pathspecs, sawDoubleDash, protectedDirs) {
  for (const raw of ((!sawDoubleDash || !pathspecs.length) ? [baseCwd || ".", ...pathspecs] : pathspecs)) {
    if (raw.startsWith(":")) return true;
    for (const target of expandAndResolvePathVariants(raw, baseCwd)) {
      const canon = resolveRealOrAncestorPath(target);
      if (protectedDirs.some((pDir) => {
        const cp = resolveRealOrAncestorPath(pDir);
        return isContainedInDir(canon, cp) || isContainedInDir(cp, canon);
      })) return true;
    }
  }
  return false;
}
function resolveTrackedGitGrepCandidates(effectiveCwd, gitGlobalArgs, pathspecs, sawDoubleDash) {
  let cwd = effectiveCwd ? path.resolve(expandLeadingTilde(effectiveCwd)) : process.cwd(), workTree = "";
  const gitArgs = [];
  for (let i = 0; i < gitGlobalArgs.length; i++) {
    const a = gitGlobalArgs[i];
    if (a === "-C" && gitGlobalArgs[i + 1]) cwd = path.resolve(cwd, expandLeadingTilde(gitGlobalArgs[++i]));
    else if (a === "--work-tree" && gitGlobalArgs[i + 1]) {
      workTree = path.resolve(cwd, expandLeadingTilde(gitGlobalArgs[i + 1]));
      gitArgs.push(a, gitGlobalArgs[++i]);
    } else {
      if (a.startsWith("--work-tree=")) workTree = path.resolve(cwd, expandLeadingTilde(a.slice(12)));
      gitArgs.push(a);
    }
  }
  if (!isAccessibleDirectory(cwd) || pathspecs.some((sp) => sp.startsWith(":"))) return { ok: false };
  if (!sawDoubleDash) {
    for (const sp of pathspecs) {
      try {
        fs.lstatSync(path.resolve(workTree || cwd, sp));
      } catch {
        return { ok: false };
      }
    }
  }
  const topOpts = { cwd, encoding: "utf-8", timeout: 1500, maxBuffer: 65536, windowsHide: true };
  const topRes = spawnSync("git", [...gitArgs, "rev-parse", "--show-toplevel"], topOpts);
  if (topRes.error || topRes.signal || topRes.status !== 0 || !topRes.stdout?.trim()) return { ok: false };
  const topLevel = path.resolve(cwd, topRes.stdout.trim());
  const lsOpts = { cwd, encoding: "buffer", timeout: 2000, maxBuffer: 2097152, windowsHide: true };
  const lsRes = spawnSync("git", [...gitArgs, "ls-files", "-z", "--full-name", "--", ...pathspecs], lsOpts);
  if (lsRes.error || lsRes.signal || lsRes.status !== 0 || !Buffer.isBuffer(lsRes.stdout)) return { ok: false };
  const buf = lsRes.stdout, files = [];
  if (buf.length > 0 && buf[buf.length - 1] !== 0) return { ok: false };
  for (let i = 0, start = 0; i < buf.length; i++) {
    if (buf[i] !== 0) continue;
    if (i > start) {
      if (files.length >= 10000) return { ok: false };
      files.push(path.resolve(topLevel, buf.subarray(start, i).toString("utf-8")));
    }
    start = i + 1;
  }
  return { ok: true, topLevel, files };
}
export function inspectShellCommandScope(commandOrSegments, initialCwd = "", { depth = 0, protectedDirs = [], out = [] } = {}) {
  if (depth > 12) {
    out.push({ value: initialCwd || ".", cwd: initialCwd || "", globPositions: [], isOperand: true, recursive: true, uncertainCwd: true, depthExceeded: true });
    return out;
  }
  const segments = Array.isArray(commandOrSegments) ? commandOrSegments : splitShellSegments(commandOrSegments);
  if (!segments.length) return out;
  const shellPipeline = new Set();
  for (let i = segments.length - 1; i >= 0; i--) {
    const nextPipes = segments[i + 1] && ["|", "|&"].includes(segments[i + 1].leadingSep) && shellPipeline.has(i + 1);
    if (SHELL_INTERPRETERS.has(getSegmentCmdName(segments[i])) || nextPipes) shellPipeline.add(i);
  }
  let curCwd = initialCwd || "", cwdUncertain = false, cwdHomeHint = false;
  const { perSegment, unclosedCompound } = analyzeSegmentCommandStarts(segments);
  const emitObj = (value, cwd, gp, isOperand, rec, unc, homeHint, extra = {}) =>
    out.push({ value, cwd, globPositions: gp, isOperand, recursive: rec, uncertainCwd: unc, homeHint, ...extra });
  const emitItems = (items, baseCwd, rec, unc, homeHint = false, extra = {}) => {
    for (const item of items) {
      for (const c of expandItemPathCandidates(item)) {
        if (c.value && (c.isOperand || !c.value.startsWith("-"))) emitObj(c.value, baseCwd, c.globPositions, c.isOperand, rec, unc, homeHint, extra);
      }
    }
  };
  const emitFailClosed = (baseCwd) => emitObj(baseCwd || ".", baseCwd, [], true, true, true, false, { uncertainFailClosed: true });
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx], segInfo = perSegment[segIdx], segCwd = curCwd, segUnc = cwdUncertain, segHome = cwdHomeHint, tokens = getSegTokens(seg);
    const hasPipeIn = ["|", "|&"].includes(seg.leadingSep), hasPipeOut = segIdx + 1 < segments.length && ["|", "|&"].includes(segments[segIdx + 1].leadingSep);
    if (segInfo.uncertainSyntax || unclosedCompound) emitObj(segCwd || ".", segCwd, [], true, true, segUnc, segHome);
    emitItems(segInfo.forWordTokens.map((fw) => ({ value: fw.value, globPositions: fw.globPositions, isOperand: true })), segCwd, false, segUnc, segHome);
    extractRedirectTargetTokens(tokens, false).forEach((rt) => emitObj(rt.value, segCwd, rt.globPositions, true, false, segUnc, segHome));
    for (const { startPos, cmdIdx, endIdx, localCwd: wrapperLocalCwd } of segInfo.starts) {
      if (cmdIdx >= tokens.length || cmdIdx >= endIdx) continue;
      const role = classifyCommandRoles(tokens, startPos, cmdIdx, endIdx, {
        hasDownstreamPipe: hasPipeOut, stdinSupplied: Boolean(hasPipeIn || seg.hasInputRedirect)
      });
      if (role.verb === "cd") {
        const stepped = stepSegmentCd(segments, perSegment, segIdx, tokens, cmdIdx, endIdx, segCwd);
        curCwd = stepped.cwd;
        if (stepped.uncertain) cwdUncertain = true;
        if (stepped.homeHint) cwdHomeHint = true;
        emitItems(role.pathItems, segCwd, false, segUnc, segHome);
        continue;
      }
      if (role.verb === "pushd" || role.verb === "popd" || role.verb === "eval" || role.verb === "source" || role.verb === ".") {
        cwdUncertain = true;
        if (role.verb === "source" || role.verb === ".") {
          emitItems(role.pathItems, segCwd, false, segUnc, segHome, { uncertainSource: true });
          continue;
        }
      }
      let baseCwd = wrapperLocalCwd ? resolveHookPath(expandLeadingTilde(wrapperLocalCwd), segCwd) : segCwd;
      if (role.localCwd) baseCwd = resolveHookPath(expandLeadingTilde(role.localCwd), baseCwd);
      const cmdUnc = segUnc && !wrapperLocalCwd && !role.localCwd, extra = role.viaXargs ? { viaXargs: true } : {};
      if (role.executesHelper) {
        emitFailClosed(baseCwd);
        continue;
      }
      if (role.gitGrepScope) {
        const { gitGlobalArgs, sawDoubleDash, pathspecs, operandItems, nonPathspecItems } = role.gitGrepScope;
        emitItems(nonPathspecItems, baseCwd, false, cmdUnc, segHome);
        const hasTree = gitGlobalArgs.some((a) => a === "--work-tree" || a.startsWith("--work-tree=") || a === "--git-dir" || a.startsWith("--git-dir="));
        if (!hasTree && !wouldNaiveScopeTouchProtected(baseCwd, pathspecs, sawDoubleDash, protectedDirs)) {
          for (const it of (operandItems.length ? operandItems : [{ value: baseCwd || ".", globPositions: [] }])) {
            emitObj(it.value, baseCwd, it.globPositions || [], true, true, cmdUnc, segHome);
          }
        } else {
          const spawnBase = wrapperLocalCwd ? resolveHookPath(expandLeadingTilde(wrapperLocalCwd), segCwd) : segCwd;
          const tracked = resolveTrackedGitGrepCandidates(spawnBase, gitGlobalArgs, pathspecs, sawDoubleDash);
          if (!tracked.ok) emitFailClosed(baseCwd);
          else tracked.files.forEach((f) => emitObj(f, tracked.topLevel, [], true, false, cmdUnc, segHome));
        }
        continue;
      }
      if (role.implicitCwd) emitObj(baseCwd || ".", baseCwd, [], true, true, cmdUnc, segHome, extra);
      emitItems(role.pathItems, baseCwd, role.recursive, cmdUnc, segHome, extra);
      if ((role.verb === "echo" || role.verb === "printf") && shellPipeline.has(segIdx)) {
        const pipedScript = tokens.slice(cmdIdx + 1, endIdx).filter((_, k) => !skipSingleRedirect(tokens, cmdIdx + 1 + k)).map((t) => t.value).join(" ");
        if (pipedScript) inspectShellCommandScope(pipedScript, baseCwd, { depth: depth + 1, protectedDirs, out });
      }
    }
    if (seg.hasHereString && CODE_INTERPRETERS.has(getSegmentCmdName(seg)) &&
        extractHereStringPayloads(tokens).some((p) => /\.gemini\b|agy-context(?:-saver)?\b|transcript\.jsonl/i.test(p))) {
      emitFailClosed(segCwd);
    }
    for (const child of collectSegmentChildScripts(seg, segInfo, segments, segIdx, "all")) {
      const nextCwd = child.localCwd ? resolveHookPath(expandLeadingTilde(child.localCwd), segCwd) : segCwd;
      inspectShellCommandScope(child.innerScript, nextCwd, { depth: depth + 1, protectedDirs, out });
    }
  }
  return out;
}
function touchesCanonicalState(segments, ctx) {
  const stateDir = getStateDir(), seen = new Set();
  for (const entry of inspectShellCommandScope(segments, ctx.cwd || "", { protectedDirs: [stateDir] })) {
    if (entry.depthExceeded || entry.uncertainFailClosed) return true;
    const checkDesc = Boolean(entry.recursive || entry.globPositions?.length), collapsed = collapseActiveShellGlob(entry.value, entry.globPositions);
    if (!collapsed || (!entry.isOperand && collapsed.startsWith("-"))) continue;
    const candidateCwds = entry.uncertainCwd && (!path.isAbsolute(expandLeadingTilde(collapsed)) || entry.recursive)
      ? [entry.cwd, ...directSubdirsBounded(entry.cwd, 64), ...(entry.homeHint ? [getProfileHomeDir(), path.dirname(stateDir), stateDir] : [])]
      : [entry.cwd];
    for (const candCwd of candidateCwds) {
      const effVal = entry.uncertainCwd && entry.recursive && collapsed === entry.cwd ? candCwd : collapsed;
      const key = `${checkDesc}\0${candCwd}\0${effVal}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (expandAndResolvePathVariants(effVal, candCwd).some((t) => isContainedInDir(t, stateDir) || (checkDesc && isContainedInDir(stateDir, t)))) return true;
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
    const nonNullWrite = seg.hasWriteRedirect && extractRedirectTargets(tokens, true).some((t) => !/^(?:\/dev\/null|nul)$/i.test(t));
    if (seg.hasSubshell || seg.hasHeredoc || seg.hasHereString || segInfo.uncertainSyntax || !segInfo.starts.length || nonNullWrite) return false;
    for (const { cmdIdx, endIdx } of segInfo.starts) {
      if (cmdIdx >= tokens.length || cmdIdx >= endIdx) return false;
      const verb = normalizeCmdName(tokens[cmdIdx].value), args = [];
      for (let i = cmdIdx + 1; i < endIdx; i++) {
        const r = skipSingleRedirect(tokens, i);
        if (r && r.missingTarget) return false;
        if (r) i = r.nextIdx - 1;
        else args.push(tokens[i].value);
      }
      if (!isReadOnlyTranscriptVerb(verb) && !(verb === "rtk" && ["read", "grep", "ls"].includes(String(args[0] || "")))) return false;
      const badSort = verb === "sort" && args.some((v) => /^--(?:output(?:=|$)|compress-program)|^-[^-]*o/.test(v));
      if (badSort || (verb === "rg" && args.some((v) => /^(?:--pre|--hostname-bin)(?:=|$)/.test(v))) ||
          (verb === "file" && args.some((v) => v === "--compile" || /^-[^-]*C/.test(v))) ||
          (verb === "uniq" && args.filter((v) => !v.startsWith("-")).length > 1) ||
          (verb === "jq" && args.some((v) => /^(?:-L|--(?:argfile|slurpfile|rawfile|from-file))/.test(v)))) return false;
    }
  }
  return true;
}
const makeEnvRe = (k) => new RegExp(
  `(?:(?:^|[\\s;|&(])(?:${k})=|(?:process\\.env|os\\.environ)\\s*(?:\\.\\s*(?:${k})\\b|\\[\\s*['"](?:${k})['"]\\s*\\]))`, "i"
);
const GOV_ENV_RE = makeEnvRe("AGY_TEST_PROFILE_DIR|AGY_BRAIN_DIR|GEMINI_CONVERSATION_ID");
const STATE_ENV_RE = makeEnvRe("XDG_STATE_HOME|LOCALAPPDATA");
const BRAIN_INTERNAL_PATH_RE = new RegExp(
  "\\.gemini[\\/\\\\]+antigravity(?:-cli|-ide)?[\\/\\\\]+brain[\\/\\\\]+" +
  "(?![^\\/\\\\\\s'\"]+[\\/\\\\](?:scratch|browser_sandbox|swarm_view|\\.agents)(?:$|[\\/\\\\])|[^\\/\\\\\\s'\"]+[\\/\\\\][^\\/\\\\\\s'\"]+\\." +
  "(?:md|txt|json|csv|tsv|yaml|yml|xml|zip|png|jpg|jpeg|gif|svg|html|css|webp|bmp|ico|pdf|mp3|wav|mp4|webm|mov)\\b)", "i"
);
const BRAIN_ENUM_VERBS_RE =
  /\b(?:ln|cp|mv|rsync|tar|zip|find|readdir|readdirSync|scandir|listdir|walk|glob|iglob|readFile|readFileSync|createReadStream|open|openSync)\b/i;
function getProtectedShellOperationReason(text, convId, ctx) {
  if (!text || typeof text !== "string") return null;
  if (isProtectedInternalState(text)) return "internal-state";
  if (GOV_ENV_RE.test(text)) return "governance-env";
  if (STATE_ENV_RE.test(text) && (/\bagy-context(?:-saver)?\b|\bexecution-guard\b|\.gemini\b/i.test(text) ||
      getEffectiveMode(convId, undefined, getBrainDirs({ activeTranscriptPath: ctx?.transcriptPath || "" })).restricted)) return "governance-env";
  return BRAIN_INTERNAL_PATH_RE.test(text) && BRAIN_ENUM_VERBS_RE.test(text) ? "internal-state" : null;
}
const buildProtectedShellReasonMessage = (code, convId, ctx) => code === "governance-env"
  ? "Antigravity Execution Governance: Overriding Antigravity governance/state environment variables " +
    "(AGY_TEST_PROFILE_DIR, AGY_BRAIN_DIR, GEMINI_CONVERSATION_ID, or governance-scoped XDG_STATE_HOME/LOCALAPPDATA) inside shell commands is prohibited."
  : buildInternalStateShellDenial(convId, ctx);
const GH_VALUE_FLAGS = new Set(["-R", "--repo", "-i", "--interval", "-q", "--jq", "-t", "--template", "-H", "--hostname"]);
function findBlockingWatchLoop(segments, depth = 0) {
  if (depth > 4) return null;
  const { perSegment } = analyzeSegmentCommandStarts(segments, { allowPartialCompound: depth > 0 });
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx], tokens = getSegTokens(seg);
    for (const { cmdIdx: baseIdx, endIdx } of perSegment[segIdx].starts) {
      let idx = baseIdx;
      while (idx < endIdx) {
        const r = skipSingleRedirect(tokens, idx);
        if (r) idx = r.nextIdx;
        else if (normalizeCmdName(tokens[idx].value) === "rtk") idx++;
        else if (normalizeCmdName(tokens[idx].value) === "xargs") {
          const xr = unwrapCommandPrefix(tokens, idx, endIdx, { unwrapXargs: true });
          if (xr.uncertain) break;
          idx = xr.cmdIdx;
        } else break;
      }
      if (idx < endIdx && normalizeCmdName(tokens[idx].value) === "gh") {
        const rest = [], pos = [];
        for (let k = idx + 1; k < endIdx; k++) {
          const r = skipSingleRedirect(tokens, k);
          if (r) k = r.nextIdx - 1;
          else rest.push(tokens[k].value);
        }
        let hasHelp = false, hasWatch = false, afterDD = false;
        for (let i = 0; i < rest.length; i++) {
          const tok = String(rest[i] || "");
          if (!afterDD && tok === "--") afterDD = true;
          else if (!afterDD && tok.startsWith("-") && tok !== "-") {
            if (tok === "--help" || tok === "-h") {
              hasHelp = true;
              break;
            }
            if (tok === "--watch" || /^--watch=(?:true|1|yes)$/i.test(tok) || (!/^-[RiqHt].+/.test(tok) && /^-[a-zA-Z]*w[a-zA-Z]*$/.test(tok))) hasWatch = true;
            else if (GH_VALUE_FLAGS.has(tok) && i + 1 < rest.length) i++;
          } else pos.push(tok.toLowerCase());
        }
        if (!hasHelp && pos[0] === "pr" && pos[1] === "checks" && hasWatch) return { command: "gh pr checks --watch" };
        if (!hasHelp && pos[0] === "run" && pos[1] === "watch") return { command: "gh run watch" };
      }
    }
    for (const child of collectSegmentChildScripts(seg, perSegment[segIdx], segments, segIdx, "shellPipe")) {
      const r = findBlockingWatchLoop(splitShellSegments(child.innerScript), depth + 1);
      if (r) return r;
    }
  }
  return null;
}
const RTK_READ_ALLOWED_LEVELS = new Set(["none", "minimal", "aggressive"]);
function parseBoundedReadCommand(cmd, mode) {
  if (!cmd || typeof cmd !== "string") return null;
  const tokens = tokenizeShellWords(cmd), c0 = normalizeCmdName(tokens[0]);
  const isNodeRead = tokens.length >= 3 && c0 === "node" && isTrustedLocalRtkLauncherPath(tokens[1]) && tokens[2].toLowerCase() === "read";
  const argStart = mode === "rtk" ? (c0 === "rtk" && tokens[1]?.toLowerCase() === "read" ? 2 : (isNodeRead ? 3 : -1))
    : ((c0 === "head" || c0 === "tail") && tokens.length >= 2 ? 1 : -1);
  if (argStart === -1) return null;
  const operands = [], lineLimits = [];
  let hasInvalidBound = false, hasDisallowedFlag = false, afterDD = false;
  const recLim = (raw) => {
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_SPILLOVER_SLICE_LINES) hasInvalidBound = true;
    else lineLimits.push(n);
  };
  for (let i = argStart; i < tokens.length; i++) {
    const tok = tokens[i], eq = tok.indexOf("=");
    if (!afterDD && tok === "--") afterDD = true;
    else if (afterDD || !tok.startsWith("-") || tok === "-") operands.push(tok);
    else if (mode === "rtk") {
      if (["--head-lines", "--tail-lines", "--max-lines", "-m"].includes(tok)) recLim(tokens[++i] ?? "");
      else if (eq > 0 && ["--head-lines", "--tail-lines", "--max-lines"].includes(tok.slice(0, eq))) recLim(tok.slice(eq + 1));
      else if (eq > 0) {
        if (tok.slice(0, eq) !== "--level" || !RTK_READ_ALLOWED_LEVELS.has(tok.slice(eq + 1).toLowerCase())) hasDisallowedFlag = true;
      } else if (tok.startsWith("-m") && tok.length > 2) recLim(tok.slice(2));
      else if (tok === "-l" || tok === "--level") {
        const lvl = (tokens[++i] || "").toLowerCase();
        if (!RTK_READ_ALLOWED_LEVELS.has(lvl)) hasDisallowedFlag = true;
      } else if (tok.startsWith("-l") && tok.length > 2) {
        if (!RTK_READ_ALLOWED_LEVELS.has(tok.slice(2).toLowerCase())) hasDisallowedFlag = true;
      } else if (!/^(?:-n|--line-numbers|--skip-env|-h|--help)$/i.test(tok) && !/^-[nh]+$/i.test(tok)) hasDisallowedFlag = true;
    } else if (tok === "-n" || tok === "--lines") recLim(tokens[++i] ?? "");
    else if (tok.startsWith("--lines=")) recLim(tok.slice(8));
    else if (tok.startsWith("-n") && tok.length > 2) recLim(tok.slice(2));
    else hasDisallowedFlag = true;
  }
  return { operands, hasSafeLineBound: lineLimits.length > 0 && !hasInvalidBound, hasDisallowedFlag };
}
const RTK_HIGH_ROI_DIRECT_CMDS = new Set(("pytest vitest jest playwright ctest phpunit pest paratest rspec mvn mvnd gradlew sbt " +
  "tsc eslint ruff mypy ty prettier phpstan rubocop golangci-lint sqlfluff ecs pint").split(" "));
const RTK_HIGH_ROI_SUBCMDS = Object.fromEntries([
  ["cargo", "test build check clippy install"], ["go", "test build vet"], ["dotnet", "build restore"], ["npm", "run lint"],
  ["pnpm", "run install i outdated lint tsc list"], ["bun", "test build install add"], ["deno", "test compile install lint check"],
  ["npx", "tsc eslint vitest jest playwright prettier prisma next ng"], ["bunx", "tsc eslint vitest jest playwright prettier prisma next ng"],
  ["uv", "run sync pip"], ["pip", "install list outdated"], ["pip3", "install list outdated"], ["next", "build"], ["ng", "build"],
  ["prisma", "generate migrate db"], ["docker", "build compose ps images logs"], ["kubectl", "get logs describe apply"],
  ["oc", "get logs describe apply"], ["git", "status push pull fetch"]
].map(([k, v]) => [k, new Set(v.split(" "))]));
const RTK_RUNNER_VALUE_FLAGS = Object.fromEntries([
  ["git", "-C -c --git-dir --work-tree --namespace --super-prefix --config-env"], ["npm", "--prefix -C --cwd --workspace -w"],
  ["pnpm", "--dir -C --filter -F --prefix"], ["bun", "--cwd"], ["npx", "-p --package -c --call"], ["bunx", "-p --package"],
  ["uv", "--directory --project --python -p --with --group --extra"], ["docker", "-H --host --context --config -l --log-level"],
  ["kubectl", "-n --namespace --context --kubeconfig --cluster --user"], ["oc", "-n --namespace --context --kubeconfig --cluster --user"]
].map(([k, v]) => [k, new Set(v.split(" "))]));
const MACHINE_FORMAT_RE = new RegExp("^(?:json|jsonl|ndjson|yaml|yml|sarif|checkstyle|junit|tap|xml|csv|tsv|jsonpath|custom-columns|" +
  "go-template|name|compact|unix|concise|rdjson|gitlab|github|blob|dot|short)(?:[=:]|$)", "i");
const getAgyRtkMode = () => ["off", "none", "disabled"].includes(String(process.env.AGY_RTK_MODE || "pregate").trim().toLowerCase()) ? "off" : "pregate";
function matchRtkInvocation(text) {
  const direct = text.match(/^((?:["']?[^\s"']*[/\\])?rtk(?:\.exe|\.cmd|\.bat)?["']?\s+)([\s\S]+)$/i);
  if (direct) return { rtkWord: direct[1], rest: direct[2] };
  const launcher = text.match(/^(node(?:\.exe)?\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))\s+)([\s\S]+)$/i);
  return launcher && isTrustedLocalRtkLauncherPath(launcher[2] || launcher[3] || launcher[4] || "") ? { rtkWord: launcher[1], rest: launcher[5] } : null;
}
function hasMachineReadableOutputFlag(cmd0, subcmd, tokens) {
  const eff = (cmd0 === "npx" || cmd0 === "bunx") ? subcmd : cmd0;
  for (let i = 1; i < tokens.length; i++) {
    const v = tokens[i].value, low = v.toLowerCase();
    if ((eff === "vitest" || eff === "jest") && /^--reporters?(?:=|$)/.test(low)) return true;
    const isDockerFmt = cmd0 === "docker" && (/^--(?:format(?:=|$)|quiet$)/.test(low) || (!v.startsWith("--") && /^-[a-zA-Z]*q[a-zA-Z]*$/.test(v)));
    const isGitShort = cmd0 === "git" && subcmd === "status" &&
      (v === "--short" || low.startsWith("--porcelain") || (!v.startsWith("--") && /^-[a-zA-Z]*[sz][a-zA-Z]*$/.test(v)));
    const isFmtEq = /^--(?:format|output|output-format|out-format|message-format|reporter)=/.test(low) &&
      MACHINE_FORMAT_RE.test(low.slice(low.indexOf("=") + 1));
    if (isDockerFmt || isGitShort || isFmtEq || ["--json", "-json", "--porcelain", "--raw", "-ojson", "-oyaml", "-oname"].includes(low) ||
        low.startsWith("--porcelain=") || /^-(?:ojsonpath|ocustom-columns|ogo-template)/.test(low) ||
        (low.startsWith("-o=") && MACHINE_FORMAT_RE.test(low.slice(3))) ||
        (["-o", "--output", "--format", "-f", "--output-format", "--out-format", "--message-format", "--reporter"].includes(low) &&
          i + 1 < tokens.length && MACHINE_FORMAT_RE.test(tokens[i + 1].value.toLowerCase()))) return true;
  }
  return false;
}
function walkUpDirs(startDir, visit) {
  for (let dir = startDir ? path.resolve(startDir) : ""; dir;) {
    const res = visit(dir), parent = path.dirname(dir);
    if (res !== undefined || parent === dir) return res;
    dir = parent;
  }
  return undefined;
}
function isLocalBinShadowedByGlobalPath(toolName, startDir) {
  const exts = os.platform() === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  const localBin = toolName && startDir
    ? (walkUpDirs(startDir, (dir) => exts.map((e) => path.join(dir, "node_modules", ".bin", `${toolName}${e}`)).find(isFileSafe)) || "")
    : "";
  const pathBin = localBin ? findExecutableOnPath(toolName) : "";
  return Boolean(localBin && pathBin && normRealCI(localBin) !== normRealCI(pathBin));
}
function isUnsupportedVitestForRtk(startDir, rtkVersion) {
  if (!isRtkVersionBelow(rtkVersion, 1, 2)) return false;
  const major = walkUpDirs(startDir, (dir) => {
    const pkgPath = path.join(dir, "node_modules", "vitest", "package.json");
    if (!isFileSafe(pkgPath)) return undefined;
    try {
      const m = String(JSON.parse(fs.readFileSync(pkgPath, "utf-8"))?.version || "").match(/^(\d+)\./);
      return m ? parseInt(m[1], 10) : null;
    } catch {
      return undefined;
    }
  });
  return typeof major === "number" && major >= 5;
}
function resolveNextSegmentCwd(segText, curCwd) {
  const trimmed = String(segText || "").trim();
  if (!trimmed) return curCwd;
  const tokens = tokenizeShellWordsDetailed(trimmed), uw = unwrapCommandPrefix(tokens, 0, tokens.length);
  if (uw.uncertain || uw.cmdIdx >= tokens.length || normalizeCmdName(tokens[uw.cmdIdx].value) !== "cd") return curCwd;
  const stepped = stepTopLevelCd(tokens, uw.cmdIdx, tokens.length, curCwd, { nextLeadingSep: "&&" });
  return !stepped.uncertain ? stepped.cwd : curCwd;
}
function filterAllowedStderrRedirects(tokens) {
  const clean = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!isUnquotedRedir(t)) clean.push(t);
    else if ((t.raw === "2>&" && tokens[i + 1]?.value === "1") || (t.raw === "2>" && /^(?:\/dev\/null|nul)$/i.test(tokens[i + 1]?.value || ""))) i++;
    else if (!/^2>&1$/i.test(t.raw) && !/^2>(?:\/dev\/null|nul)$/i.test(t.raw)) return null;
  }
  return clean;
}
function shouldDelegateSegmentToRtk(segText, { inPipeline = false, allowInternalReadRewrite = false, cwd = "", rtkVersion = "" } = {}) {
  const trimmed = String(segText || "").trim();
  if (!trimmed || inPipeline) return false;
  const target = (splitEnvPrefix(trimmed).body || trimmed).trim();
  if (!target || matchRtkInvocation(target)) return false;
  const tokens = filterAllowedStderrRedirects(tokenizeShellWordsDetailed(target)), cmd0 = normalizeCmdName(tokens?.[0]?.value);
  if (!tokens?.length || !cmd0) return false;
  const effCwd = cwd ? path.resolve(expandLeadingTilde(cwd)) : process.cwd();
  if (allowInternalReadRewrite && (cmd0 === "cat" || cmd0 === "head" || cmd0 === "tail")) return true;
  if (RTK_HIGH_ROI_DIRECT_CMDS.has(cmd0)) {
    return !(cmd0 === "vitest" && isUnsupportedVitestForRtk(effCwd, rtkVersion)) && !hasMachineReadableOutputFlag(cmd0, "", tokens);
  }
  if (cmd0 === "rake") {
    const sub = normalizeCmdName(tokens[1]?.value);
    return (sub === "test" || sub.startsWith("test:")) && !hasMachineReadableOutputFlag(cmd0, sub, tokens);
  }
  if (cmd0 === "python" || cmd0 === "python3") {
    let idx = 1;
    while (idx < tokens.length && tokens[idx].value.startsWith("-") && tokens[idx].value !== "-m") idx++;
    const mod = tokens[idx]?.value === "-m" ? normalizeCmdName(tokens[idx + 1]?.value) : "";
    return (mod === "pytest" || mod === "mypy") && !hasMachineReadableOutputFlag(mod, "", tokens.slice(idx + 1));
  }
  const allowedSubs = RTK_HIGH_ROI_SUBCMDS[cmd0], vfDefault = RTK_RUNNER_VALUE_FLAGS[cmd0] || new Set();
  if (!allowedSubs) return false;
  const adv = (s, vf = vfDefault) => {
    while (s < tokens.length && tokens[s].value.startsWith("-") && tokens[s].value !== "--") s += vf.has(tokens[s].value) ? 2 : 1;
    return s;
  };
  const subIdx = adv(1), sub = normalizeCmdName(tokens[subIdx]?.value);
  if (!sub || !allowedSubs.has(sub)) return false;
  if ((cmd0 === "npm" || cmd0 === "pnpm") && sub === "run") {
    if (String(tokens[adv(subIdx + 1, new Set())]?.value || "").trim().toLowerCase() !== "lint") return false;
  }
  if (cmd0 === "npx" || cmd0 === "bunx") {
    if (isLocalBinShadowedByGlobalPath(sub, effCwd) || (sub === "vitest" && isUnsupportedVitestForRtk(effCwd, rtkVersion))) return false;
  }
  if (cmd0 === "pnpm" && sub === "tsc" && isLocalBinShadowedByGlobalPath("tsc", effCwd)) return false;
  if (cmd0 === "uv" && sub === "run") {
    const rIdx = adv(subIdx + 1), rc = normalizeCmdName(tokens[rIdx]?.value);
    if (["pytest", "ruff", "mypy", "ty"].includes(rc)) return !hasMachineReadableOutputFlag(rc, "", tokens.slice(rIdx));
    const mod = (rc === "python" || rc === "python3") && tokens[rIdx + 1]?.value === "-m" ? normalizeCmdName(tokens[rIdx + 2]?.value) : "";
    return (mod === "pytest" || mod === "mypy") && !hasMachineReadableOutputFlag(mod, "", tokens.slice(rIdx + 2));
  }
  if (cmd0 === "uv" && sub === "pip" && !["install", "list", "show"].includes(normalizeCmdName(tokens[adv(subIdx + 1)]?.value))) return false;
  if (cmd0 === "docker" && sub === "compose") {
    const composeNext = normalizeCmdName(tokens[adv(subIdx + 1, new Set(["-f", "--file", "-p", "--project-name", "--env-file"]))]?.value);
    if (!["ps", "logs", "build"].includes(composeNext)) return false;
  }
  return !hasMachineReadableOutputFlag(cmd0, sub, tokens);
}
function delegateRewriteToRtk(rawCmd, rtk) {
  const res = spawnRtk(rtk.exe, ["hook", "antigravity"], {
    input: JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: rawCmd } } }), encoding: "utf-8", timeout: 2000, windowsHide: true
  });
  if (res.error || res.status !== 0 || !res.stdout) return { decision: "allow", commandLine: rawCmd };
  try {
    const p = JSON.parse(res.stdout.trim()), rewritten = p?.overwrite?.CommandLine;
    if (p?.decision === "deny" || p?.decision === "force_ask") return { decision: p.decision, reason: p.reason || "Denied by RTK hook." };
    return { decision: "allow", commandLine: typeof rewritten === "string" && rewritten.trim() ? rewritten : rawCmd };
  } catch {
    return { decision: "allow", commandLine: rawCmd };
  }
}
function rewriteCommandViaRtkPreGate(rawCmd, rtk, { allowInternalReadRewrite = false, preSegments = null, cwd = "" } = {}) {
  const segs = preSegments || splitShellSegments(rawCmd), segCwds = new Array(segs.length);
  let curCwd = cwd ? path.resolve(expandLeadingTilde(cwd)) : process.cwd(), result = rawCmd;
  for (let i = 0; i < segs.length; i++) {
    segCwds[i] = curCwd;
    const nextSep = segs[i + 1]?.leadingSep || "";
    if (!["|", "|&"].includes(segs[i].leadingSep) && !["|", "|&", "||"].includes(nextSep)) curCwd = resolveNextSegmentCwd(segs[i].text, curCwd);
  }
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i], trimmed = seg.text.trim();
    if (!trimmed) continue;
    const wrap = unwrapShellWrapper(trimmed);
    if (wrap) {
      const inner = rewriteCommandViaRtkPreGate(wrap.inner, rtk, { allowInternalReadRewrite: false, cwd: segCwds[i] });
      if (inner.decision !== "allow") return inner;
      if (inner.commandLine !== wrap.inner) {
        result = result.slice(0, seg.start) + `${wrap.prefix}${wrap.quote}${inner.commandLine}${wrap.quote}` + result.slice(seg.end);
      }
      continue;
    }
    const inPipe = ["|", "|&"].includes(seg.leadingSep) || ["|", "|&"].includes(segs[i + 1]?.leadingSep);
    const allowInt = Boolean(allowInternalReadRewrite && segs.length === 1);
    const rtkOpts = { inPipeline: inPipe, allowInternalReadRewrite: allowInt, cwd: segCwds[i], rtkVersion: rtk?.version || "" };
    if (!shouldDelegateSegmentToRtk(trimmed, rtkOpts)) continue;
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
    if (outerQuote === '"') return /[$`]/.test(rtkPrefix) ? null : rtkPrefix.replace(/"([^"\r\n]*)"/g, (_, inner) => `'${inner.replace(/'/g, "''")}'`);
    return outerQuote === "'" ? rtkPrefix.replace(/'/g, "''") : rtkPrefix;
  }
  if (outerQuote === '"') {
    if (/[$`]/.test(rtkPrefix)) return null;
    if (!rtkPrefix.includes('"')) return rtkPrefix;
    return !rtkPrefix.includes("'") ? rtkPrefix.replace(/"/g, "'") : rtkPrefix.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  return outerQuote === "'" ? rtkPrefix.replace(/'/g, "'\\''") : rtkPrefix;
}
function postProcessCommand(rawCmd, effCmd, rtkPrefix) {
  if (!rtkPrefix || rtkPrefix === "rtk") return effCmd;
  const rawSegs = splitShellSegments(rawCmd), effSegs = splitShellSegments(effCmd), sameCount = rawSegs.length === effSegs.length;
  let result = effCmd;
  for (let i = effSegs.length - 1; i >= 0; i--) {
    const seg = effSegs[i], trimmedEff = seg.text.trim(), trimmedRaw = (sameCount ? rawSegs[i].text : rawCmd).trim();
    const effWrap = unwrapShellWrapper(trimmedEff);
    let replacement = trimmedEff;
    if (effWrap) {
      const rawWrap = unwrapShellWrapper(trimmedRaw), wrappedPfx = formatRtkPrefixForWrapperQuote(rtkPrefix, effWrap.quote, effWrap.prefix);
      const recursed = wrappedPfx === null ? null : postProcessCommand(rawWrap ? rawWrap.inner : effWrap.inner, effWrap.inner, wrappedPfx);
      replacement = wrappedPfx === null ? (trimmedRaw || trimmedEff) : `${effWrap.prefix}${effWrap.quote}${recursed}${effWrap.quote}`;
    } else {
      const { prefix: envPfx, body } = splitEnvPrefix(trimmedEff), target = body || trimmedEff;
      if (!matchRtkInvocation(target) && /^uv(?:\.exe)?\s+run\s+rtk(?:\.exe|\.cmd|\.bat)?(?=\s)/i.test(target)) {
        replacement = `${envPfx}${target.replace(/^(uv(?:\.exe)?\s+run\s+)rtk(?:\.exe|\.cmd|\.bat)?(?=\s)/i, (_, pfx) => `${pfx}${rtkPrefix}`)}`;
      } else if (matchRtkInvocation(target) && /^rtk(?:\.exe|\.cmd|\.bat)?\s+/i.test(target)) {
        replacement = `${envPfx}${target.replace(/^rtk(?:\.exe|\.cmd|\.bat)?(?=\s)/i, () => rtkPrefix)}`;
      }
    }
    if (replacement !== seg.text) result = result.slice(0, seg.start) + replacement + result.slice(seg.end);
  }
  return result;
}
function hasLifecycleInvocation(segments, depth = 0, cwd = "") {
  if (depth > 4) return true;
  const { perSegment } = analyzeSegmentCommandStarts(segments, { allowPartialCompound: depth > 0 });
  for (let idx = 0; idx < segments.length; idx++) {
    const tokens = getSegTokens(segments[idx]);
    for (const start of perSegment[idx]?.starts || []) {
      const endIdx = start.endIdx ?? tokens.length, xr = unwrapCommandPrefix(tokens, start.cmdIdx, endIdx, { unwrapXargs: true });
      const clean = [];
      for (let k = xr.uncertain ? start.cmdIdx : xr.cmdIdx; k < endIdx; k++) {
        const r = skipSingleRedirect(tokens, k);
        if (r) k = r.nextIdx - 1;
        else clean.push(tokens[k]);
      }
      if (lifecycleActionIndex(clean, 0, clean.length) !== -1) return true;
      const script = commandScriptPath(clean, 0, clean.length), effCwd = joinLocalCwd(start.localCwd, xr.localCwd);
      if (script) {
        const base = effCwd ? path.resolve(cwd || "", expandLeadingTilde(effCwd)) : (cwd || "");
        if (scriptBodyHasLifecycleCommand(resolveHookPath(expandLeadingTilde(script), base))) return true;
      }
    }
    for (const child of collectSegmentChildScripts(segments[idx], perSegment[idx], segments, idx, "none")) {
      const nextCwd = child.localCwd ? path.resolve(cwd || "", expandLeadingTilde(child.localCwd)) : cwd;
      if (!child.innerScript || hasLifecycleInvocation(splitShellSegments(child.innerScript), depth + 1, nextCwd)) return true;
    }
  }
  return false;
}
export async function handleRunCommand(ctx) {
  const { args, convId, cwd } = ctx, rawCmd = args.CommandLine !== undefined ? args.CommandLine : args.command;
  const deny = (reason) => respond({ decision: "deny", reason });
  if (typeof rawCmd !== "string" || !rawCmd.trim()) deny("Antigravity Governance: Missing or empty CommandLine in run_command.");
  const segments = splitShellSegments(rawCmd);
  if (touchesCanonicalState(segments, ctx)) deny("Antigravity Governance: Direct access to protected plugin state is prohibited.");
  if (isRestrictedLifecycleCaller(convId, ctx) && hasLifecycleInvocation(segments, 0, cwd)) {
    deny("Antigravity Execution Governance: Sessions restricted by parent transcript isolation cannot execute " +
      "plugin lifecycle setup, install, uninstall, or restore-backups commands.");
  }
  const mutVerdict = checkShellMutations(segments, convId, ctx);
  if (mutVerdict) respond(mutVerdict);
  const blockingWatch = findBlockingWatchLoop(segments);
  if (blockingWatch) {
    deny(`Antigravity Execution Governance: Blocking CI watch loop ('${blockingWatch.command}') stalls agents indefinitely when remote runners queue.\n` +
      "- Run a single non-blocking snapshot ('gh pr checks' or 'gh run list') instead.\n- If waiting on remote CI, end your turn or use a backoff-compliant " +
      "'schedule' timer (DurationSeconds >= 30s initially, scaling 30s -> 75s -> 188s -> 469s -> 600s) rather than blocking inside run_command.");
  }
  const inspectableTexts = collectInspectableTexts(segments), inspectableCombined = inspectableTexts.join("\n");
  const singleTokens = segments.length === 1 ? getSegTokens(segments[0]).map((t) => t.value) : [];
  const spilloverTokens = singleTokens.map(cleanFileToken).filter(isStepSpilloverPath), spilloverTok = spilloverTokens[0] || null;
  const isSpillover = spilloverTokens.length > 0, taskMatches = extractTaskLogMatches(inspectableCombined, convId, ctx, singleTokens);
  const taskMatch = taskMatches[0] || null;
  if ((isSpillover || taskMatch) && !isSingleUnchainedShellCmd(segments)) {
    const hasRtk = Boolean(resolveCachedHostEnv().rtk), sep = hasRtk ? " (" : " ";
    const how = hasRtk ? "'rtk read <path>' command" : "'head -n 150 <path>' or 'tail -n 150 <path>' command (or bounded 'read_file' <= 150 lines;";
    const allDone = taskMatches.length > 0 && taskMatches.every((m) => getTaskState(m, convId, ctx) === "COMPLETED");
    const pfx = "Antigravity Execution Governance:";
    const reason = isSpillover
      ? `${pfx} Runtime step output spillover files must be inspected using a single unchained ${how}${sep}` +
        "no chaining, redirects, subshells, or '..' traversal)."
      : (allDone
          ? `${pfx} Completed task logs must be inspected using a single unchained ${how}${sep}` +
            "no chaining, pipes, redirects, subshells, or '..' traversal)."
          : buildInternalStateShellDenial(convId, ctx));
    deny(reason);
  }
  let taskState = null;
  if (taskMatches.length > 0) {
    const states = taskMatches.map((m) => ({ match: m, state: getTaskState(m, convId, ctx) })), running = states.find((e) => e.state === "RUNNING");
    if (running) {
      const { denyRunningTask } = await import("./task-guard.mjs");
      denyRunningTask(running.match.id, convId, running.match.token, ctx);
    }
    taskState = states.some((e) => e.state === "UNKNOWN") ? "UNKNOWN" : "COMPLETED";
  }
  let inspectRemainder = inspectableCombined;
  if ((isSpillover || taskMatch) && inspectableTexts.length === 1 && segments.length === 1) {
    const singleTok = isSpillover && !taskMatch && spilloverTokens.length === 1
      ? spilloverTokens[0]
      : (!isSpillover && taskMatches.length === 1 ? taskMatches[0].token : "");
    if (singleTok) {
      const normTarget = cleanFileToken(singleTok).replace(/\\/g, "/");
      let removed = false;
      const remaining = singleTokens.filter((tok) => {
        if (!removed && cleanFileToken(tok).replace(/\\/g, "/") === normTarget) {
          removed = true;
          return false;
        }
        return true;
      });
      if (removed) inspectRemainder = remaining.join(" ");
    }
  }
  if (areAllSegmentsReadOnlyTranscriptReads(segments)) inspectRemainder = stripTranscriptLogRefs(inspectRemainder);
  const protectedReason = getProtectedShellOperationReason(inspectRemainder, convId, ctx);
  if (protectedReason) deny(buildProtectedShellReasonMessage(protectedReason, convId, ctx));
  const { rtk } = resolveCachedHostEnv(), rtkMode = getAgyRtkMode();
  const allowInternalReadRewrite = Boolean(isSingleUnchainedShellCmd(segments) && (isSpillover || (taskMatch && taskState === "COMPLETED")));
  let effectiveCmd = rawCmd;
  if (rtk) {
    if (rtkMode === "pregate" || (rtkMode === "off" && allowInternalReadRewrite)) {
      const gated = rewriteCommandViaRtkPreGate(rawCmd, rtk, { allowInternalReadRewrite, preSegments: segments, cwd });
      if (gated.decision !== "allow") respond({ decision: gated.decision, reason: gated.reason });
      effectiveCmd = gated.commandLine;
    }
    if (effectiveCmd !== rawCmd || /\brtk(?:\.exe|\.cmd|\.bat)?\b/i.test(rawCmd)) effectiveCmd = postProcessCommand(rawCmd, effectiveCmd, rtk.prefix);
  }
  if (isSingleUnchainedShellCmd(segments) && !isSpillover && !taskMatch) {
    const bareAgy = effectiveCmd.match(/^(\s*)(agy-context(?:-saver)?(?:\.(?:cmd|exe|bat))?)(?=\s|$)/i), agyName = bareAgy ? normalizeCmdName(bareAgy[2]) : "";
    const localAgyCmd = bareAgy && !findExecutableOnPath(agyName) ? resolveInstalledAgyContextCommand(agyName) : "";
    if (localAgyCmd) effectiveCmd = `${bareAgy[1]}${localAgyCmd}${effectiveCmd.slice(bareAgy[0].length)}`;
  }
  if (isSpillover || taskMatch) {
    const parsedEff = parseBoundedReadCommand(effectiveCmd, "rtk"), parsedRaw = parseBoundedReadCommand(rawCmd, "rtk");
    const parsedDeg = !rtk ? parseBoundedReadCommand(effectiveCmd, "degraded") : null;
    const isSingleMatch = (p) => {
      if (!p || p.operands.length !== 1 || p.hasDisallowedFlag) return false;
      const op = cleanFileToken(p.operands[0]);
      return (isSpillover && !taskMatch && isStepSpilloverPath(op)) || (taskMatch && !isSpillover && Boolean(matchTaskLogToken(op, convId, ctx)));
    };
    const isDegOk = Boolean(parsedDeg?.hasSafeLineBound && isSingleMatch(parsedDeg));
    if (parsedEff && !isSingleMatch(parsedEff)) {
      deny("Antigravity Execution Governance: Internal step spillovers and task logs must be inspected strictly one file at a time " +
        "using 'rtk read <path>' with valid read flags (multi-file operands and mixed targets are prohibited).");
    }
    const readHow = rtk ? "'rtk read <path>'" : "a single unchained 'head -n 150 <path>' or 'tail -n 150 <path>'";
    if (isSpillover && (rtk ? !parsedEff : !isDegOk)) {
      deny(`Antigravity Execution Governance: Runtime step output spillover files must be inspected using ${readHow} via run_command ` +
        "(or bounded 'read_file' <= 150 lines) to prevent context blowouts.");
    }
    if (taskMatch && !(rtk ? (taskState === "COMPLETED" ? Boolean(parsedEff) : Boolean(parsedRaw && parsedEff)) : (taskState === "COMPLETED" && isDegOk))) {
      deny("Antigravity Execution Governance: Direct shell access to internal Antigravity execution state (.system_generated) " +
        "is strictly prohibited to prevent transcript bloat and polling loops.\n" +
        `- Once completed, inspect output using ${readHow} via run_command (or bounded 'read_file' <= 150 lines).\n` +
        "- If actively running, use Pure Yield (end turn; no 'schedule'/status card; await <SYSTEM_MESSAGE>).");
    }
    if (parsedEff && !parsedEff.hasSafeLineBound) {
      for (const tok of new Set([spilloverTok, taskMatch?.token, ...parsedEff.operands].filter(Boolean))) {
        for (const statPath of resolveInternalReadStatPaths(tok, convId, ctx, taskMatch, isSpillover)) {
          const st = safeStat(statPath);
          if (!st?.isFile()) continue;
          if (st.size > MAX_FULL_FILE_BYTES) {
            const kib = (st.size / 1024).toFixed(1), hint = isSpillover && !taskMatch ? " (or use bounded 'read_file' <= 150 lines)" : "";
            deny(`Antigravity Execution Governance: Unbounded 'rtk read' on >45 KiB spillover/task log (${kib} KiB) is denied to prevent ` +
              `cascading spillovers. Pass '--head-lines 150' or '--tail-lines 150' explicitly${hint} instead.`);
          }
          break;
        }
      }
    }
  }
  const invocation = parseTranscriptInvocation(rawCmd), hasRealCaller = Boolean(ctx.convId && ctx.convId !== "global");
  if (invocation && (hasRealCaller ? !invocation.clean : Boolean(process.env.GEMINI_CONVERSATION_ID))) {
    deny("Antigravity Governance: Run transcript commands as a single direct command so the hook can pass the caller identity.");
  }
  if (invocation?.clean && hasRealCaller) {
    const nonce = mintHookIdentity(ctx, invocation.command);
    if (!nonce) deny("Antigravity Governance: Unable to mint verified caller identity for transcript command.");
    effectiveCmd += ` --hook-grant=${nonce}`;
  }
  const isDaemon = args.IsDaemon === true || args.isDaemon === true;
  const rawWaitMs = args.WaitMsBeforeAsync !== undefined ? args.WaitMsBeforeAsync : args.waitMsBeforeAsync;
  const overwrite = {};
  if (effectiveCmd !== rawCmd) overwrite.CommandLine = effectiveCmd;
  if (!isDaemon && (rawWaitMs === null ? undefined : rawWaitMs) === undefined) overwrite.WaitMsBeforeAsync = Number(process.env.AGY_MAX_WAIT_MS) || 10000;
  respond(Object.keys(overwrite).length > 0 ? { decision: "allow", overwrite } : { decision: "allow" });
}
function isCleanTranscriptArgs(sub, args) {
  if (sub === "access") {
    return args.length === 0 || (args.length === 1 && ["status", "--help", "-h"].includes(args[0])) ||
      (args.length === 2 && args[0] === "set" && Boolean(args[1]) && !args[1].startsWith("-"));
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json" || a === "--help" || a === "-h") continue;
    if (a.startsWith("--id=") || a.startsWith("--parent=")) {
      if (!a.slice(a.indexOf("=") + 1)) return false;
    } else if (a === "--id" || a === "--parent") {
      i++;
      if (!args[i]) return false;
    } else return false;
  }
  return true;
}
/** Recognize the actual argv, including quoted executable/subcommand words. */
export function parseTranscriptInvocation(command, depth = 0) {
  if (depth > 12) return { clean: false };
  if (!command.includes("transcript") && !/['"\\]/.test(command)) return null;
  const segments = splitShellSegments(command), { perSegment, unclosedCompound } = analyzeSegmentCommandStarts(segments, { allowPartialCompound: depth > 0 });
  let matchCount = 0, invocation = null;
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx], segInfo = perSegment[segIdx], detailed = getSegTokens(seg);
    for (const { cmdIdx: initialCmdIdx, endIdx } of segInfo.starts) {
      const xr = unwrapCommandPrefix(detailed, initialCmdIdx, endIdx, { unwrapXargs: true }), cmdIdx = xr.cmdIdx, viaXargs = xr.viaXargs;
      if (cmdIdx >= endIdx) continue;
      const argvEntries = [];
      for (let k = cmdIdx; k < endIdx; k++) {
        const r = skipSingleRedirect(detailed, k);
        if (r) k = r.nextIdx - 1;
        else argvEntries.push({ value: detailed[k].value, origIdx: k });
      }
      if (!argvEntries.length) continue;
      const argv = argvEntries.map((e) => e.value), name = normalizeCmdName(argv[0]);
      if ((name === "echo" || name === "printf") && segmentPipesToShell(segments, segIdx)) {
        if (parseTranscriptInvocation(argv.slice(1).join(" "), depth + 1)) matchCount++;
        continue;
      }
      const direct = /^agy-context(?:-saver)?(?:\.(?:cmd|exe|bat))?$/.test(name), isNode = /^node(?:\.exe)?$/.test(name);
      let scriptArgvIdx = 1;
      if (isNode) {
        while (scriptArgvIdx < argv.length && argv[scriptArgvIdx].startsWith("-") && argv[scriptArgvIdx] !== "--") {
          const fl = argv[scriptArgvIdx++];
          if (NODE_VALUE_FLAGS.has(fl) && scriptArgvIdx < argv.length) scriptArgvIdx++;
        }
        if (argv[scriptArgvIdx] === "--") scriptArgvIdx++;
      }
      const node = isNode && /(?:^|[\\/])agy-context\.mjs$/i.test(argv[scriptArgvIdx] || ""), start = node ? scriptArgvIdx + 1 : 1;
      if ((!direct && !node) || argv[start] !== "transcript") continue;
      const sub = argv[start + 1];
      const isBare = !viaXargs && cmdIdx === 0 && segments.length === 1 && !seg.hasSubshell && !seg.hasHeredoc &&
        !seg.hasHereString && !seg.hasRedirect && !segInfo.uncertainSyntax && !unclosedCompound;
      if (((sub === "--help" || sub === "-h" || sub === "help") && argv.length === start + 2 && isBare) || (!sub && isBare)) continue;
      matchCount++;
      if (!["access", "health", "stats", "info"].includes(sub)) continue;
      const invArgs = argv.slice(start + 2), directCleanStart = !viaXargs && cmdIdx === 0 && (!node || (scriptArgvIdx === 1 && argvEntries[1]?.origIdx === 1));
      const noHashOrGrant = !detailed.some((t) => !t.quoted && t.raw.startsWith("#")) && !argv.some((w) => w.startsWith("--hook-grant"));
      invocation = {
        command: sub === "access" ? "access" : "health", args: invArgs,
        clean: isBare && directCleanStart && isCleanTranscriptArgs(sub, invArgs) &&
          /^[ \t]*(?:&[ \t]*)?$/.test(command.slice(0, seg.start)) && /^[ \t]*$/.test(command.slice(seg.end)) && noHashOrGrant
      };
    }
    for (const child of collectSegmentChildScripts(seg, segInfo, segments, segIdx, "all")) {
      if (parseTranscriptInvocation(child.innerScript, depth + 1)) matchCount++;
    }
  }
  if (invocation && matchCount > 1) invocation.clean = false;
  return invocation || (matchCount > 0 ? { clean: false } : null);
}
