/**
 * Shared path canonicalization, brain-root discovery, and export/state containment guards.
 * Single source of truth for `lib/transcript-core.mjs`, `bin/agy-context.mjs`, and PreToolUse hooks.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStateDir } from "../scripts/state-dir.mjs";

const MAX_SYMLINK_DEPTH = 40;
let brainDirsCacheKey = null;
let brainDirsCacheValue = null;

export function getProfileHomeDir() {
  return process.env.AGY_TEST_PROFILE_DIR || os.homedir();
}

function inferBrainRootFromTranscriptPath(tp) {
  if (!tp || typeof tp !== "string") return "";
  const norm = tp.replace(/\\/g, "/");
  const lower = norm.toLowerCase();
  const marker = "/.system_generated/";
  let matched = "";
  let searchFrom = 0;
  while (searchFrom < lower.length) {
    const markerIdx = lower.indexOf(marker, searchFrom);
    if (markerIdx === -1) break;
    const convSlash = lower.lastIndexOf("/", markerIdx - 1);
    if (convSlash > 6 && convSlash < markerIdx - 1 && lower.slice(convSlash - 6, convSlash) === "/brain") {
      matched = norm.slice(0, convSlash);
      break;
    }
    searchFrom = markerIdx + marker.length;
  }
  if (!matched && lower.endsWith("/brain") && norm.length > 6) {
    matched = norm;
  }
  if (!matched) return "";
  return os.platform() === "win32" ? path.normalize(matched) : matched;
}

export function getBrainDir({ activeTranscriptPath = "" } = {}) {
  const envBrain = process.env.AGY_BRAIN_DIR && process.env.AGY_BRAIN_DIR.trim();
  if (envBrain) return envBrain;
  const fromTranscript = inferBrainRootFromTranscriptPath(activeTranscriptPath);
  if (fromTranscript) return fromTranscript;
  return path.join(getProfileHomeDir(), ".gemini", "antigravity", "brain");
}

export function getBrainDirs({ bypassCache = false, activeTranscriptPath = "" } = {}) {
  const envBrain = process.env.AGY_BRAIN_DIR ? process.env.AGY_BRAIN_DIR.trim() : "";
  const envProfile = process.env.AGY_TEST_PROFILE_DIR || "";
  const tp = typeof activeTranscriptPath === "string" ? activeTranscriptPath : "";
  const cacheKey = `${envBrain}\0${envProfile}\0${tp}`;
  if (!bypassCache && brainDirsCacheKey === cacheKey && brainDirsCacheValue) {
    return [...brainDirsCacheValue];
  }
  let result;
  if (envBrain) {
    result = [envBrain];
  } else {
    const home = getProfileHomeDir();
    const candidates = [
      path.join(home, ".gemini", "antigravity", "brain"),
      path.join(home, ".gemini", "antigravity-cli", "brain"),
      path.join(home, ".gemini", "antigravity-ide", "brain")
    ];
    const fromTranscript = inferBrainRootFromTranscriptPath(tp);
    if (fromTranscript && !candidates.includes(fromTranscript)) {
      candidates.unshift(fromTranscript);
    }
    const existing = candidates.filter((dir) => {
      try { return fs.existsSync(dir); } catch { return false; }
    });
    result = existing.length > 0 ? existing : [candidates[0]];
  }
  brainDirsCacheKey = cacheKey;
  brainDirsCacheValue = result;
  return [...result];
}

export function normalizeWinDevicePath(p) {
  const s = String(p || "");
  if (/^\\\\\?\\UNC\\/i.test(s)) return "\\\\" + s.slice(8);
  if (/^\\\\[?.]\\/.test(s)) return s.slice(4);
  return s;
}

export function hasUncOrDevicePrefix(p) {
  const s = String(p || "").trim();
  return /^(?:\\\\|\/\/)/.test(s) || /^[\\/]{2}[?.][\\/]/.test(s);
}

export function realOrNull(p) {
  if (!p) return null;
  try {
    return normalizeWinDevicePath(fs.realpathSync(p));
  } catch {
    return null;
  }
}

/**
 * Canonical symlink-following path resolver that handles non-existent tails and dangling
 * intermediate symlinks (up to 40 hops with cycle detection) so `--out` and containment
 * checks cannot be bypassed by dangling symlinks (PT-SEC-001).
 */
export function resolveRealOrAncestorPath(targetPath, { cwd = "", depth = 0, visited = new Set() } = {}) {
  const raw = String(targetPath || "");
  if (!raw) return "";
  const normInput = normalizeWinDevicePath(raw);
  if (/^\\\\/.test(normInput) && os.platform() !== "win32") return normInput;
  const resolved = cwd ? path.resolve(cwd, normInput) : path.resolve(normInput);
  if (depth >= MAX_SYMLINK_DEPTH) return normalizeWinDevicePath(resolved);

  const tail = [];
  let cursor = resolved;
  while (true) {
    try {
      const realCursor = normalizeWinDevicePath(fs.realpathSync(cursor));
      return normalizeWinDevicePath(tail.length > 0 ? path.join(realCursor, ...tail.reverse()) : realCursor);
    } catch {
      try {
        const lst = fs.lstatSync(cursor);
        if (lst.isSymbolicLink()) {
          let linkDir = path.dirname(cursor);
          try { linkDir = normalizeWinDevicePath(fs.realpathSync(linkDir)); } catch {}
          const linkKey = path.join(linkDir, path.basename(cursor));
          if (!visited.has(linkKey)) {
            const linkTarget = normalizeWinDevicePath(fs.readlinkSync(cursor));
            const tailParts = tail.slice().reverse();
            if (/^\\\\/.test(linkTarget) && os.platform() !== "win32") {
              return tailParts.length > 0 ? `${linkTarget}\\${tailParts.join("\\")}` : linkTarget;
            }
            const nextBase = path.resolve(linkDir, linkTarget);
            const nextPath = tailParts.length > 0 ? path.join(nextBase, ...tailParts) : nextBase;
            const nextVisited = new Set(visited);
            nextVisited.add(linkKey);
            return resolveRealOrAncestorPath(nextPath, { cwd: "", depth: depth + 1, visited: nextVisited });
          }
        }
      } catch {}
      const parent = path.dirname(cursor);
      if (parent === cursor) return normalizeWinDevicePath(resolved);
      tail.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function tryRealpath(p) {
  if (!p) return "";
  return realOrNull(p) || resolveRealOrAncestorPath(p);
}

function isRelParentEscape(rel) {
  return rel === ".." || rel.startsWith(".." + path.sep) || rel.startsWith("../") || rel.startsWith("..\\");
}

export function isContainedInDir(targetPath, parentDir, { platform = os.platform(), cwd = "", allowEqual = true } = {}) {
  if (!targetPath || !parentDir) return false;
  const cleanTarget = resolveRealOrAncestorPath(targetPath, { cwd });
  const cleanParent = resolveRealOrAncestorPath(parentDir, { cwd });
  if (!cleanTarget || !cleanParent) return false;
  if (hasUncOrDevicePrefix(cleanTarget) || hasUncOrDevicePrefix(cleanParent)) return false;
  const isCaseInsensitive = platform === "win32" || platform === "darwin";
  const norm = (p) => (isCaseInsensitive ? p.toLowerCase() : p);
  const rel = path.relative(norm(cleanParent), norm(cleanTarget));
  if (rel === "") return allowEqual;
  return !isRelParentEscape(rel) && !path.isAbsolute(rel);
}

export function isContainedInAnyBrainDir(targetPath, brainDirs = getBrainDirs(), selfConvId = null, options = {}) {
  for (const dir of brainDirs) {
    const checkDir = selfConvId ? path.join(dir, String(selfConvId)) : dir;
    if (isContainedInDir(targetPath, checkDir, options)) return dir;
  }
  return null;
}

export function extractConvId(p, { strictBrainContainment = false, platform = os.platform() } = {}) {
  const rawStr = String(p || "");
  try {
    const targetResolved = resolveRealOrAncestorPath(rawStr);
    const isCaseInsensitive = platform === "win32" || platform === "darwin";
    const norm = (s) => (isCaseInsensitive ? s.toLowerCase() : s);
    const home = getProfileHomeDir();
    const candidateDirs =
      process.env.AGY_BRAIN_DIR && process.env.AGY_BRAIN_DIR.trim()
        ? getBrainDirs()
        : Array.from(new Set([
            ...getBrainDirs(),
            path.join(home, ".gemini", "antigravity", "brain"),
            path.join(home, ".gemini", "antigravity-cli", "brain"),
            path.join(home, ".gemini", "antigravity-ide", "brain")
          ]));
    for (const candidateDir of candidateDirs) {
      const brainRoot = resolveRealOrAncestorPath(candidateDir);
      const rel = path.relative(norm(brainRoot), norm(targetResolved));
      if (rel && !isRelParentEscape(rel) && !path.isAbsolute(rel)) {
        const relSegments = rel.split(path.sep).filter(Boolean);
        const targetSegments = targetResolved.split(path.sep).filter(Boolean);
        const origIdx = targetSegments.length - relSegments.length;
        const firstSeg = origIdx >= 0 ? targetSegments[origIdx] : relSegments[0];
        if (firstSeg && firstSeg !== "." && firstSeg !== "..") {
          if (strictBrainContainment && relSegments.length === 1 && firstSeg.toLowerCase().endsWith(".jsonl")) {
            return null;
          }
          return firstSeg;
        }
      }
    }
  } catch {}
  if (strictBrainContainment) return null;
  const normalized = rawStr.replace(/\\/g, "/");
  const brainMatch = normalized.match(/\/brain\/([^/]+)\//);
  if (brainMatch) return brainMatch[1];
  const logsMatch = normalized.match(/\/([^/]+)\/\.system_generated\/logs\//);
  if (logsMatch) return logsMatch[1];
  return path.basename(normalized, path.extname(normalized));
}

export function isProtectedBenchmarkPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const normalized = targetPath.replace(/\\/g, "/");
  return (
    /(?:^|\/)(?:benchmarks?|evaluators?|evaluation|scoring|ground_truth|prompt_templates)(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)(?:eval_[^/]+\.(?:py|json|toml)|bench_[^/]+\.(?:py|json|toml))$/i.test(normalized)
  );
}

export function isProtectedInternalOutPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const normalized = targetPath.replace(/\\/g, "/");
  return (
    /(?:^|\/)\.system_generated(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)\.git(?:\/|$)/i.test(normalized) ||
    /\/\.gemini\/(?:config|antigravity(?:-cli|-ide)?)\/(?:hooks\.json(?:\.bak)?|mcp_config\.json|config\.json)$/i.test(normalized) ||
    /\/\.gemini\/config\/scripts\/execution-guard-hook\.mjs$/i.test(normalized) ||
    /(?:^|\/)hooks\.json$/i.test(normalized) ||
    /\b(?:transcript-access|agy-session-governance-state|agy-rtk-rewrite-cache)\.json\b/i.test(normalized) ||
    /\bagy-session-[a-zA-Z0-9_-]+\.json\b/i.test(normalized) ||
    /\.gemini\/antigravity(?:-cli|-ide)?\/brain\/.*(?:logs\/|tasks\/|steps\/)/i.test(normalized) ||
    isProtectedBenchmarkPath(normalized)
  );
}

function getProtectedOutRoots() {
  const home = getProfileHomeDir();
  return [
    getStateDir(),
    path.join(home, ".gemini", "config"),
    path.join(home, ".gemini", "antigravity", "bin"),
    path.join(home, ".gemini", "antigravity", "mcp"),
    path.join(home, ".gemini", "antigravity-cli", "bin"),
    path.join(home, ".gemini", "antigravity-cli", "mcp"),
    path.join(home, ".gemini", "antigravity-ide", "bin"),
    path.join(home, ".gemini", "antigravity-ide", "mcp")
  ].map((p) => resolveRealOrAncestorPath(p));
}

export function validateSafeExportOutPath(outArg, { cwd = "" } = {}) {
  if (outArg === undefined) return undefined;
  const trimmed = String(outArg).trim();
  if (!trimmed || trimmed.includes("\0")) throw new Error(`Invalid --out path '${outArg}'.`);
  if (hasUncOrDevicePrefix(trimmed)) {
    throw new Error(`Invalid --out path '${outArg}': UNC and device paths are prohibited.`);
  }
  if (trimmed.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid --out path '${outArg}': '..' traversal is prohibited.`);
  }
  if (!/\.(?:md|json|txt)$/i.test(trimmed)) {
    throw new Error(`Invalid --out path '${outArg}': must end with .md, .json, or .txt.`);
  }
  const abs = cwd ? path.resolve(cwd, trimmed) : path.resolve(trimmed);
  if (hasUncOrDevicePrefix(abs)) {
    throw new Error(`Invalid --out path '${outArg}': UNC and device paths are prohibited.`);
  }
  if (isProtectedInternalOutPath(abs)) {
    throw new Error(`Refusing '--out' inside protected internal, governance, or benchmark directory: '${abs}'.`);
  }

  let absLst = null;
  try { absLst = fs.lstatSync(abs); } catch {}
  if (absLst && (absLst.isSymbolicLink() || !absLst.isFile())) {
    throw new Error(`Invalid --out path '${abs}': refusing symlink or non-regular file.`);
  }

  const resolvedTarget = resolveRealOrAncestorPath(abs);
  if (hasUncOrDevicePrefix(resolvedTarget) || isProtectedInternalOutPath(resolvedTarget)) {
    throw new Error(`Refusing '--out' inside protected internal, governance, or benchmark directory: '${resolvedTarget}'.`);
  }
  for (const pr of getProtectedOutRoots()) {
    if (pr && isContainedInDir(resolvedTarget, pr)) {
      throw new Error(`Refusing '--out' inside protected governance/state directory: '${resolvedTarget}'.`);
    }
  }
  return abs;
}

export function isProtectedExportOutPath(outPath, resolvedOut, { cwd = "" } = {}) {
  const effectiveOut = resolvedOut || (cwd ? path.resolve(cwd, String(outPath || "")) : path.resolve(String(outPath || "")));
  const cleanTarget = normalizeWinDevicePath(effectiveOut);
  if (
    hasUncOrDevicePrefix(outPath) ||
    hasUncOrDevicePrefix(cleanTarget) ||
    /^\\/.test(String(outPath || "").trim()) ||
    /(?:^|[\\/])\.git(?:[\\/]|$)/i.test(String(outPath || "")) ||
    /(?:^|[\\/])\.git(?:[\\/]|$)/i.test(effectiveOut)
  ) {
    return true;
  }
  try {
    const lst = fs.lstatSync(effectiveOut);
    if (lst.isSymbolicLink() || !lst.isFile()) return true;
  } catch {}

  const realTarget = resolveRealOrAncestorPath(effectiveOut, { cwd });
  if (!realTarget || hasUncOrDevicePrefix(realTarget) || isProtectedInternalOutPath(realTarget)) {
    return true;
  }
  return getProtectedOutRoots().some((pr) => pr && isContainedInDir(realTarget, pr));
}

export function isSafeSelfOnlyOutPath(outPath, resolvedOut, convId, { cwd = "" } = {}) {
  if (!convId || convId === "global") return false;
  const effectiveOut = resolvedOut || (cwd ? path.resolve(cwd, String(outPath || "")) : path.resolve(String(outPath || "")));
  const realTarget = resolveRealOrAncestorPath(effectiveOut, { cwd });
  if (!realTarget || hasUncOrDevicePrefix(outPath) || hasUncOrDevicePrefix(realTarget)) return false;

  const baseDir = cwd ? path.resolve(cwd) : process.cwd();
  const wsScratch = resolveRealOrAncestorPath(path.join(baseDir, "scratch"));
  if (isContainedInDir(realTarget, wsScratch, { allowEqual: false })) return true;

  for (const brainDir of getBrainDirs()) {
    const ownScratch = resolveRealOrAncestorPath(path.join(brainDir, String(convId), "scratch"));
    if (isContainedInDir(realTarget, ownScratch, { allowEqual: false })) return true;
  }
  return false;
}
