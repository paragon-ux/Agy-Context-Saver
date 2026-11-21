/**
 * Sections 2 & 4 PreToolUse Guards:
 * - Native inspection (`read_file`, `view_file`, `read_many_files`, `grep_search`, `find_by_name`, `list_dir`)
 * - Native mutation (`write_file`, `write_to_file`, `edit_file`, `replace_file_content`, `multi_replace_file_content`)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStateDir } from "../state-dir.mjs";
import { getProfileHomeDir, getBrainDirs, resolveRealOrAncestorPath, tryRealpath } from "../../lib/path-guards.mjs";
import {
  MAX_SAFE_SLICE_LINES,
  MAX_SMALL_AUTO_ALLOW_LINES,
  MAX_SMALL_AUTO_ALLOW_BYTES,
  MAX_SPILLOVER_SLICE_LINES,
  MAX_FULL_FILE_LINES,
  MAX_FULL_FILE_BYTES,
  MAX_LINE_COUNT_SCAN_BYTES,
  respond,
  resolveHookPath,
  expandLeadingTilde,
  cleanFileToken,
  expandAndResolvePathVariants,
  isExecutableScriptPath,
  evaluateCallerTranscriptAccess,
  isProtectedInternalState,
  isProtectedInternalStatePath,
  isProtectedGovernanceFileMutationPath,
  isProtectedBenchmarkFilePath,
  isBenchmarkGuardDisabled,
  isCrossConversationTargetDenied,
  isStepSpilloverPath,
  matchTaskLogToken,
  getTaskState,
  isOversizedInternalTarget,
  buildInternalStateToolDenial
} from "./common.mjs";

const SAFE_MULTIMODAL_MEDIA_RE = /\.(?:png|jpe?g|gif|webp|bmp|ico|pdf|mp3|wav|ogg|flac|m4a|mp4|webm|mov)$/i;

const INSPECTION_PATH_KEYS = [
  "Path", "path", "AbsolutePath", "absolutePath", "absolute_path", "FilePath", "filePath", "file_path",
  "TargetFile", "targetFile", "target_file", "DirectoryPath", "directoryPath", "directory_path",
  "dirPath", "dir_path", "directory", "SearchDirectory", "searchDirectory", "search_directory",
  "SearchPath", "searchPath", "search_path", "SearchRoot", "searchRoot", "search_root"
];

const MUTATION_PATH_KEYS = [
  "Path", "path", "TargetFile", "targetFile", "target_file", "TargetPath", "targetPath", "target_path",
  "AbsolutePath", "absolutePath", "absolute_path", "FilePath", "filePath", "file_path"
];

function collectPathAliases(args, keys, includeArrays = false) {
  const seen = new Set();
  const push = (v) => { if (typeof v === "string" && v.trim()) seen.add(v.trim()); };
  for (const k of keys) push(args[k]);
  if (includeArrays) {
    for (const arr of [args.paths, args.Paths]) if (Array.isArray(arr)) arr.forEach(push);
  }
  return [...seen];
}

export function parsePositiveLineInt(val) {
  if (typeof val === "boolean" || val === null || val === undefined) return NaN;
  if (typeof val === "number") return Number.isInteger(val) && val > 0 ? val : NaN;
  if (typeof val === "string") {
    const t = val.trim();
    if (!/^\d+$/.test(t)) return NaN;
    const n = Number(t);
    return Number.isSafeInteger(n) && n > 0 ? n : NaN;
  }
  return NaN;
}

function matchesSpecialFilePattern(norm) {
  return (
    norm.endsWith("/SKILL.md") || norm === "SKILL.md" ||
    norm.endsWith("/AGENTS.md") || norm === "AGENTS.md" ||
    norm.endsWith("/CLAUDE.md") || norm === "CLAUDE.md" ||
    norm.includes("/.agents/rules/") || norm.includes("/.gemini/config/") ||
    /(?:^|\/)(?:\.agents?|\.gemini(?:\/antigravity(?:-cli|-ide)?\/builtin)?|\.claude)\/skills\//i.test(norm) ||
    /\/\.gemini\/antigravity(?:-cli|-ide)?\/(?:brain|mcp)\//i.test(norm)
  );
}

function isAntigravitySpecialFile(targetPath, cwd = "") {
  if (!targetPath || typeof targetPath !== "string" || isProtectedInternalStatePath(targetPath, cwd)) return false;
  const cleaned = cleanFileToken(targetPath);
  if (!matchesSpecialFilePattern(cleaned.replace(/\\/g, "/"))) return false;
  const abs = resolveHookPath(expandLeadingTilde(cleaned), cwd);
  if (abs) {
    try {
      if (fs.lstatSync(abs).isSymbolicLink()) {
        const canonicalNorm = resolveRealOrAncestorPath(abs, { cwd }).replace(/\\/g, "/");
        if (!matchesSpecialFilePattern(canonicalNorm)) return false;
      }
    } catch {}
  }
  return true;
}

function isSymlinkMaskedInternalPath(rawPath, cwd = "") {
  const abs = resolveHookPath(expandLeadingTilde(cleanFileToken(rawPath)), cwd);
  if (!abs) return false;
  const absNorm = abs.replace(/\\/g, "/");
  if (/(?:^|\/)\.system_generated\//i.test(absNorm)) return false;
  let isLink = false;
  try { isLink = fs.lstatSync(abs).isSymbolicLink(); } catch {}
  const canonical = resolveRealOrAncestorPath(abs, { cwd }).replace(/\\/g, "/");
  return isLink || (canonical !== absNorm && /(?:^|\/)\.system_generated\//i.test(canonical));
}

function isProtectedDiscoveryAncestorPath(candidateTarget, isDiscoveryTool, isRecursiveDiscoveryTool, ctx = {}) {
  if (!isDiscoveryTool) return false;
  const effectiveCandidate = candidateTarget || ctx?.cwd || "";
  if (!effectiveCandidate) return false;
  const isCI = os.platform() === "win32" || os.platform() === "darwin";
  const normDir = (p) => {
    if (!p) return "";
    const raw = tryRealpath(path.resolve(p)).replace(/\\/g, "/");
    const norm = raw.replace(/\/+$/, "") || (raw.startsWith("/") ? "/" : raw);
    return isCI ? norm.toLowerCase() : norm;
  };
  const profileHomeNorm = normDir(getProfileHomeDir());
  const stateDirNorm = normDir(getStateDir());
  const stateParentNorm = normDir(path.dirname(getStateDir()));
  const stateGrandRaw = normDir(path.dirname(path.dirname(getStateDir())));
  const stateGrandNorm = [".local", "appdata", "library"].includes(path.basename(stateGrandRaw).toLowerCase()) ? stateGrandRaw : "";
  const brainDirNorms = getBrainDirs({ activeTranscriptPath: ctx?.transcriptPath || "" }).map(normDir).filter(Boolean);
  const agyRootNorms = brainDirNorms.map((b) => normDir(path.dirname(b))).filter(Boolean);
  const geminiRootNorms = agyRootNorms.map((a) => normDir(path.dirname(a))).filter(Boolean);

  for (const variant of expandAndResolvePathVariants(effectiveCandidate, ctx?.cwd || "")) {
    const nv = normDir(variant);
    if (!nv) continue;
    if (nv === stateDirNorm || brainDirNorms.includes(nv) || agyRootNorms.includes(nv) || geminiRootNorms.includes(nv)) return true;
    if (isRecursiveDiscoveryTool) {
      if (nv === "/" || /^[a-z]:$/i.test(nv) || (profileHomeNorm && nv === profileHomeNorm)) return true;
      if (stateParentNorm && stateParentNorm !== profileHomeNorm && nv === stateParentNorm) return true;
      if (stateGrandNorm && stateGrandNorm !== profileHomeNorm && nv === stateGrandNorm) return true;
      if (brainDirNorms.some((b) => nv.startsWith(b + "/") && !nv.slice(b.length + 1).includes("/"))) return true;
      try { if (fs.existsSync(path.join(variant, ".system_generated"))) return true; } catch {}
    }
  }
  return false;
}

function getFileMetrics(filePath, cwd = "") {
  if (!filePath || typeof filePath !== "string") return null;
  try {
    const resolved = resolveHookPath(expandLeadingTilde(cleanFileToken(filePath)), cwd);
    if (!resolved) return null;
    if (!fs.existsSync(resolved)) {
      let dangling = false;
      try { fs.lstatSync(resolved); dangling = true; } catch {}
      return !dangling && fs.existsSync(path.dirname(resolved)) ? { exists: false, bytes: 0, lineCount: 0, oversized: false } : null;
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    const bytes = stat.size;
    if (bytes === 0) return { exists: true, bytes: 0, lineCount: 0, oversized: false };
    const oversized = bytes > MAX_FULL_FILE_BYTES;
    if (bytes > MAX_LINE_COUNT_SCAN_BYTES) return { exists: true, bytes, lineCount: null, oversized: true };
    const buf = fs.readFileSync(resolved);
    let nlCount = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) nlCount++;
    const lineCount = buf[buf.length - 1] === 0x0a ? Math.max(1, nlCount) : nlCount + 1;
    return { exists: true, bytes, lineCount, oversized };
  } catch { return null; }
}

async function hasHostRtkAvailable() {
  const { resolveCachedHostEnv } = await import("./shell-guard.mjs");
  return Boolean(resolveCachedHostEnv().rtk);
}

function evaluateReadFileBounds(target, toolName, { rawStart, rawEnd, hasByteOffset, hasSliceParams }, cwd) {
  const guidance = `Locate the target symbol, heading, or section first with 'grep_search' (or rg/grep via run_command) and pass a bounded slice ('StartLine' and 'EndLine', max ${MAX_SAFE_SLICE_LINES} lines) to '${toolName}'`;
  const tag = (m) => {
    if (!m || m.exists === false) return "";
    const kib = (m.bytes / 1024).toFixed(1);
    if (m.lineCount === null) return ` (actual file: ${kib} KiB > 45 KiB)`;
    return m.oversized ? ` (actual file: ${m.lineCount} lines, ${kib} KiB > 45 KiB)` : ` (actual file: ${m.lineCount} lines, ${kib} KiB)`;
  };
  const deny = (reason) => ({ decision: "deny", reason });

  if (hasByteOffset && !hasSliceParams) {
    return deny(`Antigravity Governance: Unbounded 'ByteOffset'-only read via '${toolName}'${tag(getFileMetrics(target, cwd))} is denied. ${guidance}.`);
  }

  if (hasSliceParams) {
    const startLine = rawStart !== undefined ? parsePositiveLineInt(rawStart) : 1;
    const hasExplicitEnd = rawEnd !== undefined;
    const endLine = hasExplicitEnd ? parsePositiveLineInt(rawEnd) : null;

    if (rawStart !== undefined && !hasExplicitEnd) {
      if (!Number.isInteger(startLine) || startLine <= 0) {
        return deny(`Antigravity Governance: Invalid slice range via '${toolName}'. Ensure StartLine and EndLine are positive integers with EndLine >= StartLine. ${guidance}.`);
      }
      const metrics = getFileMetrics(target, cwd);
      if (metrics?.exists === false) return { decision: "allow" };
      if (metrics && metrics.lineCount !== null) {
        if (startLine > metrics.lineCount || (metrics.lineCount - startLine + 1) <= MAX_SAFE_SLICE_LINES) return { decision: "allow" };
        const rem = metrics.lineCount - startLine + 1;
        return deny(`Antigravity Governance: Unbounded tail read from StartLine=${startLine} via '${toolName}' (${rem} remaining lines > ${MAX_SAFE_SLICE_LINES} lines max safe slice window)${tag(metrics)}. Pass an explicit EndLine (max ${MAX_SAFE_SLICE_LINES} lines) or StartLine=1, EndLine=${metrics.lineCount} if <= ${MAX_FULL_FILE_LINES} lines and <= 45 KiB. ${guidance}.`);
      }
      return deny(`Antigravity Governance: Unbounded tail read from StartLine=${startLine} via '${toolName}'${tag(metrics)} requires an explicit EndLine (max ${MAX_SAFE_SLICE_LINES} lines). ${guidance}.`);
    }

    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine <= 0 || endLine < startLine) {
      return deny(`Antigravity Governance: Invalid slice range via '${toolName}'. Ensure StartLine and EndLine are positive integers with EndLine >= StartLine. ${guidance}.`);
    }
    const span = endLine - startLine + 1;
    if (span <= MAX_SAFE_SLICE_LINES) return { decision: "allow" };

    const metrics = getFileMetrics(target, cwd);
    if (metrics?.exists === false) return { decision: "allow" };
    if (metrics && metrics.lineCount !== null) {
      if (startLine > metrics.lineCount) return { decision: "allow" };
      const effSpan = Math.min(endLine, metrics.lineCount) - startLine + 1;
      if (effSpan >= 1 && effSpan <= MAX_SAFE_SLICE_LINES) return { decision: "allow" };
      if (startLine === 1 && !hasByteOffset && endLine >= metrics.lineCount) {
        if (!metrics.oversized && metrics.lineCount <= MAX_FULL_FILE_LINES && metrics.bytes <= MAX_FULL_FILE_BYTES) return { decision: "allow" };
        return deny(`Antigravity Governance: Explicit full-file read via '${toolName}' (${metrics.lineCount} lines, ${(metrics.bytes / 1024).toFixed(1)} KiB) exceeds the full-file audit ceiling (max ${MAX_FULL_FILE_LINES} lines and 45 KiB). ${guidance}.`);
      }
    }
    return deny(`Antigravity Governance: Oversized partial file slice via '${toolName}' (${span} lines > ${MAX_SAFE_SLICE_LINES} lines max safe slice window)${tag(metrics)}. Partial slices above ${MAX_SAFE_SLICE_LINES} lines are denied; full-file reads are permitted via StartLine=1, EndLine >= TotalLines when <= ${MAX_FULL_FILE_LINES} lines and <= 45 KiB. ${guidance}.`);
  }

  const m = getFileMetrics(target, cwd);
  if (m?.exists === false) return { decision: "allow" };
  if (m && !m.oversized && m.lineCount !== null && m.lineCount <= MAX_SMALL_AUTO_ALLOW_LINES && m.bytes <= MAX_SMALL_AUTO_ALLOW_BYTES) {
    return { decision: "allow" };
  }
  return deny(`Antigravity Governance: Full-file inspection via '${toolName}' without explicit bounds is denied${tag(m)} (omitted bounds auto-allow files <= ${MAX_SMALL_AUTO_ALLOW_LINES} lines and <= 24 KiB). ${guidance} (or pass explicit StartLine=1, EndLine=<TotalLines> for a one-pass audit when the file is <= ${MAX_FULL_FILE_LINES} lines and <= 45 KiB).`);
}

export async function handleInspectionTool(ctx) {
  const { toolName, args, convId, cwd } = ctx;
  const isDiscoveryTool = toolName === "grep_search" || toolName === "find_by_name" || toolName === "list_dir";
  const isRecursiveDiscoveryTool = toolName === "grep_search" || toolName === "find_by_name";

  const allCandidates = collectPathAliases(args, INSPECTION_PATH_KEYS, true);
  if (allCandidates.length === 0 && isDiscoveryTool && cwd) allCandidates.push(cwd);

  const rawStart = args.StartLine !== undefined ? args.StartLine : (args.startLine !== undefined ? args.startLine : args.start_line);
  const rawEnd = args.EndLine !== undefined ? args.EndLine : (args.endLine !== undefined ? args.endLine : args.end_line);
  const hasByteOffset = args.ByteOffset !== undefined || args.byteOffset !== undefined || args.byte_offset !== undefined;
  const hasSliceParams = rawStart !== undefined || rawEnd !== undefined;

  const isBoundedInternalSlice = (() => {
    if (toolName !== "read_file" || rawStart === undefined || rawEnd === undefined) return false;
    const s = parsePositiveLineInt(rawStart);
    const e = parsePositiveLineInt(rawEnd);
    return Number.isInteger(s) && Number.isInteger(e) && s > 0 && e >= s && (e - s + 1) <= MAX_SPILLOVER_SLICE_LINES;
  })();

  const safeHarborCandidates = new Set();

  // Checks 2a (step spillovers) & 2b (task logs) across EVERY candidate path
  for (const cand of allCandidates) {
    if (isStepSpilloverPath(cand) || expandAndResolvePathVariants(cand, cwd).some(isStepSpilloverPath)) {
      if (isCrossConversationTargetDenied(cand, convId, ctx)) {
        respond({ decision: "deny", reason: "Antigravity Execution Governance: Cross-conversation inspection of another session's step spillover is prohibited under Parent Transcript Isolation." });
      }
      if (!isSymlinkMaskedInternalPath(cand, cwd) && isBoundedInternalSlice) { safeHarborCandidates.add(cand); continue; }
      const spillCmd = (await hasHostRtkAvailable())
        ? (isOversizedInternalTarget(cand, convId, ctx, null, true) ? `'rtk read --tail-lines 150 ${cand}' (or '--head-lines 150')` : `'rtk read ${cand}'`)
        : `'tail -n 150 ${cand}' (or 'head -n 150 ${cand}')`;
      respond({ decision: "deny", reason: `Antigravity Governance: Unbounded inspection of step spillover via '${toolName}' is denied. Pass a bounded slice ('StartLine' and 'EndLine', max ${MAX_SPILLOVER_SLICE_LINES} lines) to 'read_file' or run ${spillCmd} via run_command instead.` });
    }

    const taskMatch = matchTaskLogToken(cand, convId, ctx);
    if (taskMatch) {
      if (isCrossConversationTargetDenied(taskMatch.realPath || cand, convId, ctx)) {
        respond({ decision: "deny", reason: "Antigravity Execution Governance: Cross-conversation inspection of another session's task log is prohibited under Parent Transcript Isolation." });
      }
      const state = getTaskState(taskMatch, convId, ctx);
      if (state === "RUNNING") {
        const { denyRunningTask } = await import("./task-guard.mjs");
        denyRunningTask(taskMatch.id, convId, taskMatch.token, ctx);
      }
      if (state === "COMPLETED") {
        if (!isSymlinkMaskedInternalPath(cand, cwd) && isBoundedInternalSlice) { safeHarborCandidates.add(cand); continue; }
        const taskCmd = (await hasHostRtkAvailable())
          ? (isOversizedInternalTarget(cand, convId, ctx, taskMatch, false) ? `'rtk read --tail-lines 150 ${cand}' (or '--head-lines 150')` : `'rtk read ${cand}'`)
          : `'tail -n 150 ${cand}' (or 'head -n 150 ${cand}')`;
        respond({ decision: "deny", reason: `Antigravity Governance: Unbounded inspection of completed task logs via '${toolName}' is denied. Pass a bounded slice ('StartLine' and 'EndLine', max ${MAX_SPILLOVER_SLICE_LINES} lines) to 'read_file' or run ${taskCmd} via run_command instead.` });
      }
      respond({ decision: "deny", reason: "Antigravity Execution Governance: Direct access to internal Antigravity execution state (.system_generated/tasks) is strictly prohibited to prevent polling loops. Rely on native Reactive Wakeup (<SYSTEM_MESSAGE>) upon completion." });
    }
  }

  // Check 2c: Internal state & discovery ancestor roots (never scanning Query/Pattern/Includes/Excludes/Extensions)
  for (const cand of allCandidates) {
    if (safeHarborCandidates.has(cand)) continue;
    if (isProtectedInternalStatePath(cand, cwd) || isProtectedDiscoveryAncestorPath(cand, isDiscoveryTool, isRecursiveDiscoveryTool, ctx)) {
      respond({ decision: "deny", reason: buildInternalStateToolDenial(convId, ctx) });
    }
  }

  // Check 2d: Cross-conversation brain artifact isolation
  for (const cand of allCandidates) {
    if (isCrossConversationTargetDenied(cand, convId, ctx)) {
      respond({ decision: "deny", reason: "Antigravity Execution Governance: Cross-conversation inspection of another session's brain artifacts is prohibited under Parent Transcript Isolation." });
    }
  }

  // Check 2f: Block unbounded multi-file dumps BEFORE special-file / media allows
  if (toolName === "read_many_files") {
    const hasRtk = await hasHostRtkAvailable();
    respond({
      decision: "deny",
      reason: hasRtk
        ? `Antigravity Governance: Native multi-file reading via 'read_many_files' bypasses context bounds. Use bounded 'read_file' slices ('<= ${MAX_SAFE_SLICE_LINES}' lines) for editable workspace code, or run 'rtk read <file>' via run_command for read-only logs and spillovers instead.`
        : `Antigravity Governance: Native multi-file reading via 'read_many_files' bypasses context bounds. Use bounded 'read_file' slices ('<= ${MAX_SAFE_SLICE_LINES}' lines) for editable workspace code, or run bounded 'head -n 150 <file>' / 'tail -n 150 <file>' via run_command for read-only logs and spillovers instead.`
    });
  }

  if (safeHarborCandidates.size > 0 && safeHarborCandidates.size === allCandidates.length) respond({ decision: "allow" });
  if (allCandidates.length > 0 && allCandidates.every((c) => safeHarborCandidates.has(c) || isAntigravitySpecialFile(c, cwd))) {
    respond({ decision: "allow" });
  }

  // Check 2e: Unified 300L / 24 KiB hybrid slice & guarded full-file policy for read_file & view_file
  if (toolName === "read_file" || toolName === "view_file") {
    for (const cand of allCandidates) {
      if (safeHarborCandidates.has(cand) || isAntigravitySpecialFile(cand, cwd) || SAFE_MULTIMODAL_MEDIA_RE.test(cand)) continue;
      const verdict = evaluateReadFileBounds(cand, toolName, { rawStart, rawEnd, hasByteOffset, hasSliceParams }, cwd);
      if (verdict.decision !== "allow") respond(verdict);
    }
  }

  respond({ decision: "allow" });
}

function getRestrictedChildScriptBlockReason(body) {
  if (!body || typeof body !== "string") return null;
  if (isProtectedInternalState(body)) return "internal-state";
  if (/\b(?:import|require|spawn|spawnSync|exec|execSync|execFile|execFileSync|popen|system|subprocess)\b[\s\S]*?(?:\b(?:transcript-core|access-policy)(?:\.m?js)?\b|(?:bin[\/\\]+|\b)agy-context(?:-saver)?\.m?js\b)/i.test(body)) {
    return "inline-transcript-core";
  }
  if (
    /(?:^|[\s;|&(])(?:AGY_TEST_PROFILE_DIR|AGY_BRAIN_DIR|GEMINI_CONVERSATION_ID|XDG_STATE_HOME|LOCALAPPDATA)=/i.test(body) ||
    /(?:process\.env|os\.environ)\s*(?:\.\s*(?:AGY_TEST_PROFILE_DIR|AGY_BRAIN_DIR|GEMINI_CONVERSATION_ID|XDG_STATE_HOME|LOCALAPPDATA)\b|\[\s*['"](?:AGY_TEST_PROFILE_DIR|AGY_BRAIN_DIR|GEMINI_CONVERSATION_ID|XDG_STATE_HOME|LOCALAPPDATA)['"]\s*\])/i.test(body)
  ) return "governance-env";
  if (/\bagy-context(?:-saver)?(?:\.(?:m?js|cmd|exe|bat))?[\s'",\[\]()]{1,24}transcript\b/i.test(body)) return "non-canonical-cli";
  return null;
}

export function handleMutationTool(ctx) {
  const { args, convId, cwd } = ctx;
  const targetFiles = collectPathAliases(args, MUTATION_PATH_KEYS, false);
  const callerAccess = evaluateCallerTranscriptAccess(convId, ctx);

  for (const targetFile of targetFiles) {
    if (isProtectedInternalStatePath(targetFile, cwd)) {
      respond({ decision: "deny", reason: buildInternalStateToolDenial(convId, ctx) });
    }
    if (isProtectedGovernanceFileMutationPath(targetFile, convId, ctx)) {
      respond({ decision: "deny", reason: "Antigravity Execution Governance: Direct mutation of protected Antigravity hook, shim, or governance source files is strictly prohibited." });
    }
    if (isCrossConversationTargetDenied(targetFile, convId, ctx, callerAccess)) {
      respond({ decision: "deny", reason: "Antigravity Execution Governance: Cross-conversation mutation of another session's brain artifacts is prohibited under Parent Transcript Isolation." });
    }
  }

  // Scan script bodies ONLY for restricted child sessions (Finding #7: unrestricted top-level devs pass cleanly)
  if (callerAccess.isRestrictedChild) {
    const bodyParts = [
      args.Content, args.content, args.file_content, args.CodeContent, args.codeContent, args.code_content,
      args.Replacement, args.replacement, args.ReplacementContent, args.replacementContent, args.new_string
    ].filter((v) => typeof v === "string" && v);
    const rawChunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : (Array.isArray(args.replacementChunks) ? args.replacementChunks : []);
    for (const ch of rawChunks) {
      const cb = ch && typeof ch === "object" ? (ch.ReplacementContent || ch.replacementContent || ch.Replacement || ch.replacement || ch.Content || ch.content || "") : "";
      if (typeof cb === "string" && cb) bodyParts.push(cb);
    }
    const bodyContent = bodyParts.join("\n");
    if (bodyContent && (targetFiles.some(isExecutableScriptPath) || /^\s*#!/.test(bodyContent))) {
      const code = getRestrictedChildScriptBlockReason(bodyContent);
      if (code === "inline-transcript-core") {
        respond({ decision: "deny", reason: "Antigravity Execution Governance: Direct inline script or interpreter imports of 'transcript-core.mjs' or 'bin/agy-context.mjs' are prohibited for restricted child sessions." });
      }
      if (code === "governance-env") {
        respond({ decision: "deny", reason: "Antigravity Execution Governance: Overriding Antigravity governance/state environment variables inside restricted child scripts is prohibited." });
      }
      if (code === "non-canonical-cli") {
        respond({ decision: "deny", reason: "Antigravity Execution Governance: 'agy-context transcript' must be invoked as a single unchained command directly via run_command." });
      }
      if (code) respond({ decision: "deny", reason: buildInternalStateToolDenial(convId, ctx) });
    }
  }

  if (!isBenchmarkGuardDisabled(convId, ctx)) {
    const matchedBench = targetFiles.find((t) => isProtectedBenchmarkFilePath(t, cwd));
    if (matchedBench) {
      respond({
        decision: "force_ask",
        reason: `[BENCHMARK MUTATION DETECTED] Mutation of protected evaluator/benchmark artifact '${matchedBench}' requires explicit user confirmation to prevent benchmark contamination. Set AGY_DISABLE_BENCHMARK_GUARD=1 to disable this guard for non-evaluation repos.`
      });
    }
  }

  respond({ decision: "allow" });
}
