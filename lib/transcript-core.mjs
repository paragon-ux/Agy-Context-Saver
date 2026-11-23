/**
 * Agy-Context-Saver: Hardened Streaming Transcript & Health Engine (v2.1.2)
 *
 * Zero-dependency ESM core powering the `bin/agy-context.mjs` CLI.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { findExistingRtk } from "../scripts/provision-rtk.mjs";
import {
  getProfileHomeDir,
  getBrainDir,
  getBrainDirs,
  isContainedInDir,
  isContainedInAnyBrainDir,
  extractConvId,
  realOrNull
} from "./path-guards.mjs";
import {
  ACTIVE_SWARM_WINDOW_MS,
  recordTranscriptHookGrant,
  canonicalizeTranscriptSubcommand,
  consumeTranscriptAccessGrant,
  verifyTranscriptCoreAccess,
  scanRecentLaunchRestrictions,
  formatTranscriptAccessStatus,
  manageTranscriptAccessPolicy,
  inspectTranscriptLineageFromFile
} from "./access-policy.mjs";
import {
  getRequiredBackoffSeconds,
  getRequiredSubagentBackoffSeconds,
  extractTaskBackoffKey,
  hasValidTaskTimerCondition,
  hasValidSubagentTimerCondition,
  isTaskPollSchedule,
  isRemoteCiPollSchedule,
  extractRemoteCiBackoffKey,
  isSwarmPollSchedule,
  isSubagentPollSchedule,
  stepBackoffState
} from "./backoff.mjs";

export {
  getProfileHomeDir,
  getBrainDir,
  getBrainDirs,
  extractConvId,
  ACTIVE_SWARM_WINDOW_MS,
  recordTranscriptHookGrant,
  consumeTranscriptAccessGrant,
  verifyTranscriptCoreAccess,
  scanRecentLaunchRestrictions,
  formatTranscriptAccessStatus,
  manageTranscriptAccessPolicy,
  inspectTranscriptLineageFromFile,
  getRequiredBackoffSeconds,
  getRequiredSubagentBackoffSeconds,
  extractTaskBackoffKey,
  hasValidTaskTimerCondition,
  hasValidSubagentTimerCondition,
  isTaskPollSchedule,
  isRemoteCiPollSchedule,
  extractRemoteCiBackoffKey,
  isSwarmPollSchedule,
  isSubagentPollSchedule
};

const MAX_LINE_CHARS = 1000;
const MAX_TURN_CHARS = 6000;
const MAX_OUTPUT_CHARS = 24000;
export const MAX_FIELD_CHARS = 24000;
export const INLINE_SAFE_CHARS = 9200;
export const MAX_DEEP_OUTPUT_CHARS = 512 * 1024;
export const MAX_BOUNDED_READ_STEPS = 200;
const MAX_HEALTH_LINES = 100000;

function utf8ByteLength(str) {
  return Buffer.byteLength(String(str ?? ""), "utf8");
}

export function utf8SliceToBytes(str, maxBytes) {
  const s = String(str ?? "");
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), "utf8") <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  // Avoid cutting inside a UTF-16 surrogate pair
  if (lo > 0 && lo < s.length) {
    const code = s.charCodeAt(lo - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      lo--;
    }
  }
  return s.slice(0, lo);
}

/**
 * Fixed-capacity O(1) circular ring buffer (`ring`, `head`, `count`)
 * eliminating O(n) `Array.shift()` overhead during large transcript streams.
 */
export class CircularRingBuffer {
  constructor(capacity) {
    this.cap = Math.max(1, Math.floor(Number(capacity) || 1));
    this.ring = new Array(this.cap);
    this.head = 0;
    this.count = 0;
  }

  push(item) {
    this.ring[this.head] = item;
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) {
      this.count++;
    }
  }

  toArray() {
    if (this.count === 0) return [];
    const out = new Array(this.count);
    const start = this.count < this.cap ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      out[i] = this.ring[(start + i) % this.cap];
    }
    return out;
  }
}

function siblingModePath(filePath, mode) {
  const isFull = mode === "full";
  if (isFull && filePath.endsWith("transcript.jsonl")) {
    const fullCandidate = filePath.replace(/transcript\.jsonl$/, "transcript_full.jsonl");
    if (fs.existsSync(fullCandidate)) return fullCandidate;
  }
  if (!isFull && filePath.endsWith("transcript_full.jsonl")) {
    const compactCandidate = filePath.replace(/transcript_full\.jsonl$/, "transcript.jsonl");
    if (fs.existsSync(compactCandidate)) return compactCandidate;
  }
  return filePath;
}

function resolveFullSiblingPath(filePath) {
  if (!filePath) return null;
  if (filePath.endsWith("transcript_full.jsonl")) return filePath;
  const verifiedParentDir = path.dirname(realOrNull(filePath) || filePath);
  const rawSibling = filePath.replace(/transcript\.jsonl$/, "transcript_full.jsonl");
  if (rawSibling === filePath || !fs.existsSync(rawSibling)) return null;
  const realSibling = realOrNull(rawSibling);
  try {
    if (realSibling && fs.statSync(realSibling).isFile() && isContainedInDir(realSibling, verifiedParentDir)) {
      return realSibling;
    }
  } catch {}
  return null;
}

function clampRenderedBlocksToBudget(items, {
  direction = "backward",
  headerBytes = 0,
  effectiveBudget,
  sepBytes = 7,
  countFirstSep = false,
  overflowReserve = 48,
  overflowSuffix = "\n... [Block truncated to inline ceiling]",
  render
}) {
  const blocks = [];
  const displayed = [];
  let currentBytes = headerBytes;
  let clamped = false;
  const forward = direction === "forward";
  for (let i = forward ? 0 : items.length - 1; forward ? i < items.length : i >= 0; i += forward ? 1 : -1) {
    const rendered = render(items[i], i);
    const block = typeof rendered === "string" ? rendered : rendered.block;
    const entry = typeof rendered === "string" ? items[i] : rendered.item;
    const extraSep = (countFirstSep || blocks.length > 0) ? sepBytes : 0;
    const blockBytes = utf8ByteLength(block);
    if (currentBytes + extraSep + blockBytes > effectiveBudget) {
      if (blocks.length === 0) {
        const avail = Math.max(40, effectiveBudget - headerBytes - overflowReserve);
        const truncated = `${utf8SliceToBytes(block, avail)}${overflowSuffix}`;
        if (forward) {
          blocks.push(truncated);
          displayed.push(entry);
        } else {
          blocks.unshift(truncated);
          displayed.unshift(entry);
        }
      }
      clamped = true;
      break;
    }
    if (forward) {
      blocks.push(block);
      displayed.push(entry);
    } else {
      blocks.unshift(block);
      displayed.unshift(entry);
    }
    currentBytes += extraSep + blockBytes;
  }
  return { blocks, displayed, clamped };
}

function scanBrainTranscripts(brainDirOrDirs) {
  const brainDirs = Array.isArray(brainDirOrDirs) ? brainDirOrDirs : [brainDirOrDirs];
  const candidates = [];
  for (const brainDir of brainDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const d of entries) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      const compactPath = path.join(brainDir, d.name, ".system_generated", "logs", "transcript.jsonl");
      const fullPath = path.join(brainDir, d.name, ".system_generated", "logs", "transcript_full.jsonl");
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(compactPath).mtimeMs;
      } catch {
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch {
          continue;
        }
      }
      candidates.push({ convId: d.name, mtimeMs, brainDir });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

/**
 * Counts non-empty JSONL lines in a transcript file without JSON.parse overhead.
 */
function countTranscriptStepsFast(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return 0;
  const CHUNK_SIZE = 65536;
  const buf = Buffer.allocUnsafe(CHUNK_SIZE);
  let count = 0;
  let lineHasNonWs = false;
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, null);
      if (bytesRead <= 0) break;
      for (let i = 0; i < bytesRead; i++) {
        const byte = buf[i];
        if (byte === 10) {
          if (lineHasNonWs) {
            count++;
            lineHasNonWs = false;
          }
        } else if (byte !== 13 && byte !== 32 && byte !== 9) {
          lineHasNonWs = true;
        }
      }
    }
    if (lineHasNonWs) count++;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return count;
}

function listTranscriptConversationsInternal({
  limit = 10,
  parentId = null,
  includeLineage = false
} = {}) {
  const brainDirs = getBrainDirs();
  let resolvedParentId = null;
  if (parentId !== null && parentId !== undefined) {
    const trimmedParent = String(parentId).trim();
    if (!trimmedParent) {
      throw new Error("Flag '--parent' must be a non-empty conversation ID or 'current'.");
    }
    if (trimmedParent.toLowerCase() === "current") {
      const envId = process.env.GEMINI_CONVERSATION_ID && process.env.GEMINI_CONVERSATION_ID.trim();
      if (!envId) {
        throw new Error("Cannot resolve '--parent current': GEMINI_CONVERSATION_ID is not set. Pass an explicit parent UUID.");
      }
      resolvedParentId = envId;
    } else {
      resolvedParentId = trimmedParent;
    }
  }

  const byId = new Map();
  for (const dir of brainDirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const brainRootName = path.basename(path.dirname(dir)) || dir;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue;
      const name = d.name;
      const convDir = path.join(dir, name);
      const compactFile = path.join(convDir, ".system_generated", "logs", "transcript.jsonl");
      const fullFile = path.join(convDir, ".system_generated", "logs", "transcript_full.jsonl");
      const targetFile = fs.existsSync(compactFile) ? compactFile : fs.existsSync(fullFile) ? fullFile : null;
      if (!targetFile) continue;
      if (!isContainedInDir(targetFile, convDir) || !isContainedInDir(targetFile, dir)) continue;
      try {
        const stat = fs.statSync(targetFile);
        const prev = byId.get(name);
        if (!prev || stat.mtimeMs > prev.mtimeMs) {
          byId.set(name, {
            conversationId: name,
            updatedAt: stat.mtime.toISOString(),
            mtimeMs: stat.mtimeMs,
            bytes: stat.size,
            filePath: realOrNull(targetFile) || targetFile,
            brainRoot: brainRootName
          });
        }
      } catch {}
    }
  }

  let entries = Array.from(byId.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const wantMetadata = Boolean(includeLineage || resolvedParentId);

  if (resolvedParentId) {
    const filtered = [];
    for (const item of entries) {
      const lineage = inspectTranscriptLineageFromFile(item.filePath);
      if (lineage.parentConvId === resolvedParentId) {
        filtered.push({ ...item, _lineage: lineage });
      }
    }
    entries = filtered;
  }

  const sliced = entries.slice(0, limit).map((item) => {
    const base = {
      conversationId: item.conversationId,
      updatedAt: item.updatedAt,
      bytes: item.bytes
    };
    if (!wantMetadata) return base;
    const lineage = item._lineage || inspectTranscriptLineageFromFile(item.filePath);
    const stepCount = countTranscriptStepsFast(item.filePath);
    return {
      ...base,
      stepCount,
      parentConvId: lineage.parentConvId,
      rosterName: lineage.rosterName,
      isChildSession: lineage.isChildSession,
      isSwarmChild: lineage.isSwarmChild,
      isTopLevelUserSession: lineage.isTopLevelUserSession,
      sessionKind: lineage.sessionKind,
      brainRoot: item.brainRoot
    };
  });

  return {
    brainDirs,
    total: entries.length,
    parentFilter: resolvedParentId,
    includeLineage: wantMetadata,
    conversations: sliced
  };
}

/**
 * Lists conversations across all brain roots with optional `--parent` filtering and `--lineage` metadata.
 * Enforces `verifyTranscriptCoreAccess({ subcommand: "list" })` at the library boundary.
 */
export function listTranscriptConversations({
  limit = 10,
  parentId = null,
  includeLineage = false
} = {}) {
  const access = verifyTranscriptCoreAccess({
    subcommand: "list",
    consumeGrant: true
  });
  if (!access.allowed) {
    return { isError: true, text: access.error, error: access.error };
  }
  return listTranscriptConversationsInternal({ limit, parentId, includeLineage });
}

/**
 * Resolves a conversation ID or explicit transcript file path.
 *
 * Security & disambiguation rules:
 * - When `explicitFile` (`--file`) is given, it must exist, be a file, and end with `.jsonl`.
 * - When `conversationId` is omitted or `"current"`, checks `GEMINI_CONVERSATION_ID`, else scans
 *   `getBrainDirs()`. If >= 2 transcripts were modified in the last 5 minutes (active swarm),
 *   returns a clear disambiguation error listing candidate UUIDs.
 * - Unless `explicitFile` or `allowExternalPaths` is true, enforces `fs.realpathSync` containment
 *   inside `realpath(brainDir)`.
 */
function resolveTranscriptPath(target, mode = "compact", options = {}) {
  const {
    explicitFile = null,
    allowExternalPaths = false,
    subcommand = "read",
    retainGrantForFallback = false
  } = options;
  const isFull = mode === "full";
  const fileName = isFull ? "transcript_full.jsonl" : "transcript.jsonl";
  const brainDirs = getBrainDirs();
  const brainDir = brainDirs[0];

  const hasExplicitFile = explicitFile !== null && explicitFile !== undefined && String(explicitFile).trim() !== "";
  const rawTargetInput = String(target || "").trim();
  const isImplicitCurrent = !hasExplicitFile && (!rawTargetInput || rawTargetInput.toLowerCase() === "current");

  const preAccess = verifyTranscriptCoreAccess({ subcommand, consumeGrant: false, isImplicitCurrent });
  if (!preAccess.allowed) {
    return { error: preAccess.error, isGovernanceError: true };
  }

  const failResolution = (errorMsg, extra = {}) => {
    if (!retainGrantForFallback) {
      consumeTranscriptAccessGrant({ subcommand, targetConvId: rawTargetInput || null });
    }
    return { error: errorMsg, ...extra };
  };

  const enforceResolvedFileContainment = (candidatePath) => {
    if (preAccess.mode === "self-only") {
      if (
        !preAccess.callerConvId ||
        preAccess.callerConvId === "global" ||
        !isContainedInAnyBrainDir(candidatePath, brainDirs, preAccess.callerConvId)
      ) {
        return failResolution(
          `Antigravity Execution Governance: Cross-session '--file' access outside '${preAccess.callerConvId}' is disabled in self-only mode.`,
          { isGovernanceError: true }
        );
      }
    } else if (preAccess.hasRestriction && !isContainedInAnyBrainDir(candidatePath, brainDirs)) {
      return failResolution(
        `Security containment error: '--file' path '${candidatePath}' escapes brain directory scope [${brainDirs.join(", ")}] while a transcript access policy is active.`,
        { isGovernanceError: true }
      );
    }
    return null;
  };

  const finalizeResolution = (filePath, convId) => {
    if (preAccess.hasRestriction && !convId) {
      return failResolution(
        `Security containment error: unable to derive a valid conversation directory inside brain directories for '${filePath}'.`,
        { isGovernanceError: true }
      );
    }
    const postAccess = verifyTranscriptCoreAccess({
      targetConvId: convId,
      subcommand,
      consumeGrant: !retainGrantForFallback,
      isImplicitCurrent
    });
    if (!postAccess.allowed) {
      return { error: postAccess.error, isGovernanceError: true };
    }
    return { filePath, convId };
  };

  // 0. Explicit --file operator path
  if (hasExplicitFile) {
    const fileStr = String(explicitFile).trim();
    if (!fileStr.toLowerCase().endsWith(".jsonl")) {
      return failResolution(`Invalid --file path '${fileStr}': explicit transcript file must end with .jsonl.`);
    }
    const resolvedFile = path.resolve(fileStr);
    if (!fs.existsSync(resolvedFile)) {
      return failResolution(`Transcript file not found at --file path: '${resolvedFile}'.`);
    }
    const realFile = realOrNull(resolvedFile);
    if (!realFile) {
      return failResolution(`Unable to resolve realpath for --file path: '${resolvedFile}'.`);
    }
    try {
      if (!fs.statSync(realFile).isFile()) {
        return failResolution(`Invalid --file path '${resolvedFile}': target is not a regular file.`);
      }
    } catch (err) {
      return failResolution(`Unable to stat --file path '${resolvedFile}': ${err.message}`);
    }
    const modeCandidate = siblingModePath(realFile, mode);
    const finalPath = realOrNull(modeCandidate) || modeCandidate;
    try {
      if (!fs.statSync(finalPath).isFile()) {
        return failResolution(`Invalid --file path '${finalPath}': target is not a regular file.`);
      }
    } catch (err) {
      return failResolution(`Unable to stat --file path '${finalPath}': ${err.message}`);
    }
    const containmentErr = enforceResolvedFileContainment(finalPath);
    if (containmentErr) return containmentErr;
    return finalizeResolution(
      finalPath,
      extractConvId(finalPath, { strictBrainContainment: preAccess.hasRestriction })
    );
  }

  // 1. Omitted or "current": check GEMINI_CONVERSATION_ID, else scan <brainDirs> with active-swarm disambiguation
  let raw = rawTargetInput;
  if (!raw || raw.toLowerCase() === "current") {
    if (process.env.GEMINI_CONVERSATION_ID && process.env.GEMINI_CONVERSATION_ID.trim()) {
      raw = process.env.GEMINI_CONVERSATION_ID.trim();
    } else if (preAccess.mode === "self-only" && preAccess.callerConvId && preAccess.callerConvId !== "global") {
      raw = preAccess.callerConvId;
    } else {
      const candidates = scanBrainTranscripts(brainDirs);
      const now = Date.now();
      const recent = candidates.filter((c) => (now - c.mtimeMs) <= ACTIVE_SWARM_WINDOW_MS);

      if (recent.length >= 2) {
        const listing = recent
          .map((c) => `- ${c.convId} (modified ${Math.max(0, Math.round((now - c.mtimeMs) / 1000))}s ago)`)
          .join("\n");
        return failResolution(
          `Ambiguous active conversation: ${recent.length} transcripts in [${brainDirs.join(", ")}] were modified in the last 5 minutes (active swarm). Specify an explicit --id <uuid>:\n${listing}`,
          { candidates: recent.map((c) => c.convId) }
        );
      }
      if (recent.length === 1) {
        raw = recent[0].convId;
      } else if (candidates.length > 0) {
        raw = candidates[0].convId;
      } else {
        return failResolution(
          `No conversation transcripts found in brain directories [${brainDirs.join(", ")}]. Specify --id <uuid> or --file <path>.`
        );
      }
    }
  }

  // 2. Reject path traversal / external path tokens in --id unless allowExternalPaths is explicitly enabled
  const normalized = raw.replace(/\\/g, "/");
  if (!allowExternalPaths || preAccess.hasRestriction) {
    if (raw.includes("\0") || raw.includes("..") || raw.includes("/") || raw.includes("\\") || normalized.endsWith(".jsonl")) {
      return failResolution(
        `Invalid conversation ID '${raw}': must be a bare conversation UUID/folder inside brain directory. Use --file <path> for explicit external .jsonl files.`
      );
    }
  }

  // 3. Direct file path (legacy compatibility when allowExternalPaths === true and no restriction is active)
  if (allowExternalPaths && !preAccess.hasRestriction && normalized.endsWith(".jsonl") && fs.existsSync(normalized)) {
    const modeCandidate = siblingModePath(normalized, mode);
    const finalPath = realOrNull(modeCandidate) || modeCandidate;
    const containmentErr = enforceResolvedFileContainment(finalPath);
    if (containmentErr) return containmentErr;
    return finalizeResolution(
      finalPath,
      extractConvId(finalPath, { strictBrainContainment: preAccess.hasRestriction })
    );
  }

  // 4. UUID / Directory resolution under each <brainDir>/<id>
  const searchedCandidates = [];
  for (const dir of brainDirs) {
    const expectedSessionDir = path.join(dir, normalized);
    const checkBrainCandidate = (candidatePath) => {
      const realCandidate = realOrNull(candidatePath);
      if (!realCandidate) {
        return failResolution(`Unable to resolve realpath for '${candidatePath}'.`);
      }
      if ((!allowExternalPaths || preAccess.hasRestriction) && (!isContainedInDir(realCandidate, dir) || !isContainedInDir(realCandidate, expectedSessionDir))) {
        return failResolution(
          `Security containment error: resolved path '${realCandidate}' escapes conversation directory '${expectedSessionDir}'.`,
          { isGovernanceError: true }
        );
      }
      const derivedConvId = extractConvId(realCandidate, { strictBrainContainment: preAccess.hasRestriction }) || normalized;
      return finalizeResolution(realCandidate, derivedConvId);
    };

    const brainCandidate = path.join(expectedSessionDir, ".system_generated", "logs", fileName);
    searchedCandidates.push(brainCandidate);
    if (fs.existsSync(brainCandidate)) {
      return checkBrainCandidate(brainCandidate);
    }
    if (isFull) {
      const compactFallback = path.join(expectedSessionDir, ".system_generated", "logs", "transcript.jsonl");
      if (fs.existsSync(compactFallback)) {
        return checkBrainCandidate(compactFallback);
      }
    } else {
      const fullFallback = path.join(expectedSessionDir, ".system_generated", "logs", "transcript_full.jsonl");
      if (fs.existsSync(fullFallback)) {
        return checkBrainCandidate(fullFallback);
      }
    }
  }

  // 5. Legacy local relative/absolute directory path (only when allowExternalPaths === true and no restriction is active)
  if (allowExternalPaths && !preAccess.hasRestriction) {
    const localCandidate = path.resolve(normalized, ".system_generated", "logs", fileName);
    if (fs.existsSync(localCandidate)) {
      const realLocal = realOrNull(localCandidate) || localCandidate;
      return finalizeResolution(realLocal, extractConvId(realLocal));
    }
    const directCandidate = path.resolve(normalized, fileName);
    if (fs.existsSync(directCandidate)) {
      const realDirect = realOrNull(directCandidate) || directCandidate;
      return finalizeResolution(realDirect, extractConvId(realDirect));
    }
  }

  return failResolution(`Transcript not found for target: '${target}'. Searched: ${searchedCandidates.join(", ")}`);
}

function isUrlTokenAtOffset(str, offset) {
  let start = offset;
  while (start > 0 && !/\s/.test(str[start - 1])) {
    start--;
  }
  const tokenPrefix = str.slice(start, offset + 12);
  return /(?:https?|ftp|file|ssh|git|ws|wss):\/\//i.test(tokenPrefix);
}

function isLikelyRawBase64(token) {
  if (token.length < 256) return false;
  // Must not have '=' anywhere except up to 2 trailing padding chars
  const eqIdx = token.indexOf("=");
  if (eqIdx !== -1 && eqIdx < token.length - 2) return false;
  if (eqIdx !== -1 && !/={1,2}$/.test(token)) return false;

  // Preserve hex hashes / SHAs: pure lowercase hex OR hex containing digits 0-9
  if (/^[0-9a-f]+$/.test(token)) return false;
  if (/^[0-9a-fA-F]+$/.test(token) && /[0-9]/.test(token)) return false;

  // Preserve single-case snake_case / kebab-case / CONSTANT identifiers (e.g. long_symbol_name_...)
  if (/^[a-z_-]+$/.test(token) || /^[A-Z_-]+$/.test(token)) return false;

  // Standard or URL-safe base64 length check (mod 4 === 0, or unpadded URL-safe with _/-)
  const hasPlusSlashEq = /[+/=]/.test(token);
  const hasUrlSafe = /[_-]/.test(token);
  if (!hasPlusSlashEq && !hasUrlSafe) {
    // Alphanumeric-only token >= 256: require valid base64 quartet alignment and mixed/non-hex content
    if (token.length % 4 !== 0) return false;
  }
  return true;
}

function normalizeLineEndings(str) {
  if (typeof str !== "string") return str;
  return str.includes("\r") ? str.replace(/\r\n?/g, "\n") : str;
}

function collapseExcessBlankLines(str) {
  if (typeof str !== "string") return str;
  return str.includes("\n\n\n") ? str.replace(/\n{3,}/g, "\n\n") : str;
}

function isDialogueType(itemOrType) {
  const raw = itemOrType && typeof itemOrType === "object" ? itemOrType.type : itemOrType;
  const upper = String(raw || "").toUpperCase();
  return upper === "USER_INPUT" || upper === "PLANNER_RESPONSE" || upper === "SUBAGENT_RESPONSE";
}

function stripLeadingHostTimestampHeaders(content) {
  if (typeof content !== "string") return content;
  const normalized = normalizeLineEndings(content);
  const lines = normalized.split("\n");
  const keptPrefixLines = [];
  let sawSpillNotice = false;
  let strippedAny = false;
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx];
    const trimmed = line.trim();
    if (!trimmed) {
      if (keptPrefixLines.length > 0 && keptPrefixLines[keptPrefixLines.length - 1] !== "") {
        keptPrefixLines.push("");
      }
      idx++;
      continue;
    }
    if (/^(?:Created|Completed) At:\s*/i.test(trimmed)) {
      strippedAny = true;
      idx++;
      continue;
    }
    if (/^A pre-tool hook changed the arguments of this tool call before it ran\.?(?:\s+Changed:[^\n]*)?$/i.test(trimmed)) {
      keptPrefixLines.push(line);
      idx++;
      continue;
    }
    if (/^The tool's output was truncated due to being too long\. You can find the full output in a file at [^\n]+$/i.test(trimmed)) {
      sawSpillNotice = true;
      keptPrefixLines.push(line);
      idx++;
      continue;
    }
    if (sawSpillNotice && /^Here is a preview[^\n]*:$/i.test(trimmed)) {
      keptPrefixLines.push(line);
      idx++;
      continue;
    }
    break;
  }

  if (!strippedAny) return normalized;

  const restLines = lines.slice(idx);
  while (restLines.length > 0 && restLines[0].trim() === "") {
    restLines.shift();
  }
  while (keptPrefixLines.length > 0 && keptPrefixLines[keptPrefixLines.length - 1] === "") {
    keptPrefixLines.pop();
  }
  if (keptPrefixLines.length === 0) {
    return restLines.join("\n");
  }
  if (restLines.length === 0) {
    return keptPrefixLines.join("\n");
  }
  const lastPrefixTrimmed = keptPrefixLines[keptPrefixLines.length - 1].trim();
  const sep = /^Here is a preview[^\n]*:$/i.test(lastPrefixTrimmed) ? "\n" : "\n\n";
  return `${keptPrefixLines.join("\n")}${sep}${restLines.join("\n")}`;
}

function clampOrPrettyPrintLongLine(line, maxLineChars, allowJsonPretty = true, minCharsForJson = maxLineChars) {
  const finiteMax = Number.isFinite(maxLineChars);
  const triggerThreshold = finiteMax ? maxLineChars : minCharsForJson;
  if (line.length <= triggerThreshold) return { text: line, changed: false };
  if (allowJsonPretty && line.length <= 65536) {
    const trimmed = line.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        const parsed = JSON.parse(trimmed);
        const prettyLines = JSON.stringify(parsed, null, 2).split("\n");
        const safeLines = finiteMax
          ? prettyLines.map((pl) => (pl.length > maxLineChars ? `${pl.slice(0, maxLineChars)} ... [line clamped]` : pl))
          : prettyLines;
        return { text: safeLines.join("\n"), changed: true };
      } catch {
        // Not valid JSON; fall through to standard line clamp
      }
    }
  }
  if (!finiteMax) return { text: line, changed: false };
  return { text: `${line.slice(0, maxLineChars)} ... [line clamped]`, changed: true };
}

/**
 * Sanitizes message content:
 * 1. Strips data:image base64 URIs, large non-URL/non-hex base64 payloads (>=256 chars),
 *    and Git CRLF/LF warnings BEFORE `maxChars` slicing.
 * 2. Normalizes CRLF line endings, collapses excess blank lines, and pretty-prints bounded single-line JSON before clamping lines exceeding MAX_LINE_CHARS.
 * 3. Slices to `maxChars` using either verbose banner or clean `...` ellipsis.
 */
export function cleanMessageContent(content, maxChars = MAX_TURN_CHARS, options = {}) {
  if (content === null || content === undefined) return "";
  const { truncationStyle = "banner", maxLineChars = MAX_LINE_CHARS, full = false, formatJsonLines = true } = options;
  const effectiveMaxLineChars = full ? Infinity : maxLineChars;
  let text = typeof content === "string" ? content : JSON.stringify(content, null, 2);

  // Fast-path: short normalized text without base64 or CRLF warning noise
  if (
    text.length <= 120 &&
    !text.includes("\r") &&
    !text.includes("\n\n\n") &&
    !text.includes("base64") &&
    !text.includes("will be replaced by")
  ) {
    return truncationStyle === "ellipsis" && text.length > maxChars
      ? text.slice(0, Math.max(0, maxChars - 3)).trimEnd() + "..."
      : text;
  }

  // Cap pathological multi-MB inputs at a generous ceiling before regex passes, never at small maxChars
  const SANITIZE_CAP = Math.max(maxChars * 8, 512 * 1024);
  let wasPreCapped = false;
  const rawOrigLength = text.length;
  if (text.length > SANITIZE_CAP) {
    text = text.slice(0, SANITIZE_CAP);
    wasPreCapped = true;
  }

  // 1. Strip embedded data:image/...;base64,... BEFORE maxChars slicing
  if (text.includes("base64")) {
    text = text.replace(/data:image\/[^;:\s/]+;base64,[A-Za-z0-9+/=_-]+/g, "[Embedded Media/Binary Omitted]");
  }

  // 2. Strip tightened raw base64 payloads (>=256 chars, non-URL, non-pure-hex) BEFORE maxChars slicing
  if (text.length >= 256) {
    text = text.replace(/[A-Za-z0-9+/=_-]{256,}/g, (match, offset, fullStr) => {
      if (isUrlTokenAtOffset(fullStr, offset)) return match;
      if (!isLikelyRawBase64(match)) return match;
      return "[Binary/Base64 Payload Omitted]";
    });
  }

  // 3. Normalize PTY CRLF/CR endings, strip Git CRLF/LF diagnostic warnings, and collapse excess blank runs BEFORE maxChars slicing
  text = normalizeLineEndings(text);
  if (text.includes("will be replaced by")) {
    text = text.replace(
      /(?:#\s*)?warning:\s*(?:in the working copy of [^,\n]+,\s*)?(?:CRLF will be replaced by LF|LF will be replaced by CRLF)[^\n]*(?:\n)?/gi,
      ""
    );
  }
  text = collapseExcessBlankLines(text);

  // 4. Pretty-format valid JSON lines or clamp lines exceeding effectiveMaxLineChars when finite
  const lineTriggerThreshold = Number.isFinite(effectiveMaxLineChars) ? effectiveMaxLineChars : MAX_LINE_CHARS;
  if (text.length > lineTriggerThreshold && truncationStyle !== "ellipsis" && (Number.isFinite(effectiveMaxLineChars) || formatJsonLines)) {
    const lines = text.split("\n");
    let changed = false;
    const clampedLines = lines.map((l) => {
      const res = clampOrPrettyPrintLongLine(l, effectiveMaxLineChars, formatJsonLines, MAX_LINE_CHARS);
      if (res.changed) changed = true;
      return res.text;
    });
    if (changed) {
      text = clampedLines.join("\n");
    }
  }

  const effectiveLength = wasPreCapped ? rawOrigLength : text.length;
  if (effectiveLength > maxChars || text.length > maxChars) {
    if (truncationStyle === "ellipsis") {
      const collapsed = text.replace(/\s+/g, " ").trim();
      if (collapsed.length <= maxChars) return collapsed;
      return collapsed.slice(0, Math.max(0, maxChars - 3)).trimEnd() + "...";
    }
    const omitted = Math.max(effectiveLength - maxChars, 0);
    return text.slice(0, maxChars) + `\n\n... [Content Truncated (${omitted} chars omitted to preserve token budget)] ...`;
  }
  return text;
}

function unwrapCompactArgValue(v) {
  if (typeof v !== "string") return v;
  if (v.length >= 2 && v.startsWith('"')) {
    if (v.endsWith('"')) {
      try {
        const parsed = JSON.parse(v);
        if (typeof parsed === "string") {
          return normalizeLineEndings(parsed);
        }
      } catch {
        // Keep original string if not valid JSON string literal
      }
      return normalizeLineEndings(v);
    }
    const truncMatch = v.match(/(\r?\n<truncated \d+ bytes>)\s*$/);
    if (truncMatch) {
      const bodyRaw = v.slice(0, truncMatch.index);
      const validPrefix = bodyRaw.match(/^"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*/);
      if (validPrefix) {
        const tailRemainder = bodyRaw.slice(validPrefix[0].length);
        if (/^(?:\\(?:u[0-9a-fA-F]{0,3})?)?$/.test(tailRemainder)) {
          try {
            const parsed = JSON.parse(`${validPrefix[0]}"`);
            if (typeof parsed === "string") {
              return normalizeLineEndings(`${parsed}${truncMatch[1]}`);
            }
          } catch {
            // Keep original string if prefix fails to parse
          }
        }
      }
    }
  }
  return normalizeLineEndings(v);
}

function normalizeJsonValueStrings(v) {
  if (typeof v === "string") return normalizeLineEndings(v);
  if (Array.isArray(v)) return v.map((el) => normalizeJsonValueStrings(el));
  if (v && typeof v === "object") {
    const copy = {};
    for (const [k, val] of Object.entries(v)) {
      copy[k] = normalizeJsonValueStrings(val);
    }
    return copy;
  }
  return v;
}

function normalizeCompactJsonArgValue(v) {
  if (Array.isArray(v)) return v.map((el) => normalizeCompactJsonArgValue(el));
  if (v && typeof v === "object") {
    const copy = {};
    for (const [k, val] of Object.entries(v)) {
      copy[k] = normalizeCompactJsonArgValue(val);
    }
    return copy;
  }
  if (typeof v !== "string") return v;
  if (v.startsWith('"')) return unwrapCompactArgValue(v);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v)) {
    const num = Number(v);
    if (Number.isFinite(num) && String(num) === v) return num;
  }
  if ((v.startsWith("[") && v.endsWith("]")) || (v.startsWith("{") && v.endsWith("}"))) {
    try {
      return normalizeCompactJsonArgValue(JSON.parse(v));
    } catch {
      // Preserve original string if not valid JSON container
    }
  }
  return normalizeLineEndings(v);
}

function normalizeStepRecordForOutput(item, { fromCompact = false } = {}) {
  if (!item || typeof item !== "object") return item;
  const out = { ...item };
  if (typeof out.content === "string") {
    let normalizedContent = collapseExcessBlankLines(normalizeLineEndings(out.content));
    if (!isDialogueType(out)) {
      normalizedContent = stripLeadingHostTimestampHeaders(normalizedContent);
    }
    out.content = normalizedContent;
  }
  if (typeof out.thinking === "string") {
    out.thinking = collapseExcessBlankLines(normalizeLineEndings(out.thinking)).trimEnd();
  }
  if (Array.isArray(out.tool_calls)) {
    out.tool_calls = out.tool_calls.map((tc) => {
      if (!tc || typeof tc !== "object") return tc;
      const nextTc = { ...tc };
      const normalizeArgsObj = (rawArgs) => {
        if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return rawArgs;
        const nextArgs = {};
        for (const [k, val] of Object.entries(rawArgs)) {
          nextArgs[k] = fromCompact ? normalizeCompactJsonArgValue(val) : normalizeJsonValueStrings(val);
        }
        return nextArgs;
      };
      if (tc.args && typeof tc.args === "object") nextTc.args = normalizeArgsObj(tc.args);
      if (tc.arguments && typeof tc.arguments === "object") nextTc.arguments = normalizeArgsObj(tc.arguments);
      return nextTc;
    });
  }
  return out;
}

const LARGE_BODY_ARG_KEYS = new Set(["Content", "content", "Replacement", "Target", "CodeContent", "brief"]);
const PATH_ARG_KEYS = new Set([
  "Path", "path", "TargetFile", "targetFile", "AbsolutePath",
  "ArtifactPath", "DirectoryPath", "SearchPath", "file_path", "cwd", "Cwd"
]);

function elideArgString(flat, maxLen, isPath = false) {
  if (flat.length <= maxLen) return flat;
  if (isPath && maxLen >= 32) {
    const tailLen = Math.min(Math.floor((maxLen - 3) * 0.68), flat.length - 12);
    const headLen = Math.max(8, maxLen - 3 - tailLen);
    return `${flat.slice(0, headLen)}...${flat.slice(flat.length - tailLen)}`;
  }
  const clipLen = Math.max(3, maxLen - 3);
  return `${flat.slice(0, clipLen)}...`;
}

function formatArgumentDescriptor(k, v, options = {}) {
  const { fullArgs = false, unclampLargeArgs = false, compactMaxStr = 84, fromCompact = false } = options;
  const val = fromCompact ? normalizeCompactJsonArgValue(v) : normalizeJsonValueStrings(v);
  if (typeof val === "string") {
    if (unclampLargeArgs) {
      return `${k}=${JSON.stringify(val)}`;
    }
    if (fullArgs && LARGE_BODY_ARG_KEYS.has(k) && val.length > 600) {
      const preview = val.replace(/[\r\n\t]+/g, " ").slice(0, 240).trim();
      const sizeKb = (Buffer.byteLength(val, "utf8") / 1024).toFixed(1);
      return `${k}="${preview}..." [${sizeKb} KB body; use 'step --step <N> --field tool_args' or '--full' for full text]`;
    }
    const isPathKey = PATH_ARG_KEYS.has(k);
    const effectiveMaxStr = isPathKey ? Math.max(compactMaxStr, 108) : compactMaxStr;
    if (fullArgs || (val.length <= effectiveMaxStr && !val.includes("\n"))) {
      return `${k}=${JSON.stringify(val)}`;
    }
    const flat = val.replace(/[\r\n\t]+/g, " ").trim();
    const preview = elideArgString(flat, effectiveMaxStr, isPathKey);
    const byteLen = Buffer.byteLength(val, "utf8");
    if (byteLen < 256) {
      return `${k}=${JSON.stringify(preview)}`;
    }
    const sizeKb = (byteLen / 1024).toFixed(1);
    return `${k}=${JSON.stringify(preview)} [${sizeKb} KB]`;
  }
  if (typeof val === "number" || typeof val === "boolean" || val === null) {
    return `${k}=${val}`;
  }
  if (fullArgs || unclampLargeArgs) {
    return `${k}=${JSON.stringify(val)}`;
  }
  if (Array.isArray(val)) {
    return `${k}=[Array(${val.length})]`;
  }
  if (typeof val === "object") {
    const keys = Object.keys(val);
    return `${k}={Object(${keys.length} keys)}`;
  }
  return `${k}=${String(val).slice(0, 60)}`;
}

const KEY_ARG_PRIORITY = [
  "Path", "path", "TargetFile", "targetFile", "AbsolutePath",
  "CommandLine", "command", "query", "SearchQuery", "Pattern",
  "TaskId", "taskId", "Action", "action", "url", "Url", "Prompt", "prompt"
];

export function formatCompactToolList(toolCalls, options = {}) {
  const { fullArgs = false, collapseDuplicates = !fullArgs, maxTotalChars = 0, fromCompact = false } = options;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  const entries = toolCalls.map((tc) => {
    const name = tc.name || tc.tool_name || "unknown_tool";
    const args = tc.args || tc.arguments || {};
    const canonicalArgs = Object.keys(args)
      .sort()
      .map((k) => [k, args[k]]);
    const canonical = JSON.stringify({ n: name, a: canonicalArgs });
    const keys = Object.keys(args);
    if (keys.length === 0) return { label: `${name}()`, canonical };
    if (fullArgs) {
      const allPairs = Object.entries(args)
        .map(([k, v]) => formatArgumentDescriptor(k, v, { fullArgs: true, fromCompact }))
        .join(", ");
      return { label: `${name}(${allPairs})`, canonical };
    }
    let chosenKey = KEY_ARG_PRIORITY.find((k) => Object.prototype.hasOwnProperty.call(args, k) && args[k] !== undefined && args[k] !== "");
    if (!chosenKey) chosenKey = keys[0];
    const val = fromCompact ? normalizeCompactJsonArgValue(args[chosenKey]) : normalizeJsonValueStrings(args[chosenKey]);
    let valStr;
    if (typeof val === "string") {
      const flat = val.replace(/\s+/g, " ").trim();
      const isPathKey = PATH_ARG_KEYS.has(chosenKey);
      valStr = JSON.stringify(elideArgString(flat, isPathKey ? 96 : 84, isPathKey));
    } else if (typeof val === "number" || typeof val === "boolean" || val === null || val === undefined) {
      valStr = String(val);
    } else {
      valStr = Array.isArray(val) ? `[${val.length}]` : "{...}";
    }
    return { label: `${name}(${chosenKey}=${valStr})`, canonical };
  });

  let joined;
  if (!collapseDuplicates || entries.length <= 1) {
    joined = entries.map((e) => e.label).join(", ");
  } else {
    const collapsed = [];
    for (let i = 0; i < entries.length; i++) {
      let count = 1;
      while (i + 1 < entries.length && entries[i + 1].canonical === entries[i].canonical) {
        count++;
        i++;
      }
      collapsed.push(count > 1 ? `${entries[i].label} (x${count})` : entries[i].label);
    }
    joined = collapsed.join(", ");
  }

  if (maxTotalChars > 0 && joined.length > maxTotalChars) {
    return `${utf8SliceToBytes(joined, Math.max(80, maxTotalChars - 24))}... (+${toolCalls.length} total)`;
  }
  return joined;
}

function normalizeRoleLabel(item) {
  const type = String(item?.type || "UNKNOWN").toUpperCase();
  if (type === "USER_INPUT") return "USER";
  if (type === "PLANNER_RESPONSE") return "ASSISTANT";
  if (type === "SUBAGENT_RESPONSE") return "SUBAGENT";
  return type;
}

function isStructuredErrorItem(item) {
  if (!item || typeof item !== "object") return false;
  if (String(item.status || "").toUpperCase() === "ERROR") return true;
  if (item.error !== undefined && item.error !== null && item.error !== false) return true;
  if (item.isError === true) return true;
  if (Array.isArray(item.tool_calls)) {
    for (const tc of item.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      if (String(tc.status || "").toUpperCase() === "ERROR") return true;
      if (tc.error !== undefined && tc.error !== null && tc.error !== false) return true;
      if (tc.isError === true) return true;
    }
  }
  const type = String(item.type || "").toUpperCase();
  if ((type === "GENERIC" || type === "TOOL_RESULT") && typeof item.content === "string") {
    const header = item.content.split(/\r?\n\r?\nCommand output:/)[0].slice(0, 600);
    if (/(?:^|\n)Command exited with code (?!0\b)\d+\./.test(header)) return true;
    if (/(?:^|\n)Encountered error in tool execution:/.test(header)) return true;
  }
  return false;
}

export function formatTranscriptItem(item, options = {}) {
  const {
    includeThinking = false,
    includeToolCalls = false,
    fullArgs = false,
    explicitFullArgs = fullArgs,
    full = false,
    field = null,
    fromCompact = false,
    maxContentChars = MAX_TURN_CHARS,
    maxFieldChars = maxContentChars,
    maxThinkingChars = 4000,
    stripBoilerplate = false
  } = options;
  const effectiveItem = fromCompact ? normalizeStepRecordForOutput(item, { fromCompact: true }) : item;
  const stepIdx = effectiveItem.step_index !== undefined ? effectiveItem.step_index : "?";
  const role = normalizeRoleLabel(effectiveItem);
  const time = effectiveItem.created_at ? effectiveItem.created_at.replace(/\.\d+Z$/, "Z") : "";
  const timeStr = time ? ` (${time})` : "";
  const errorBadge = isStructuredErrorItem(effectiveItem) ? " [ERROR]" : "";

  const normalizedField = field ? String(field).trim() : null;
  if (normalizedField && normalizedField !== "all") {
    const single = formatSingleStepDetail(effectiveItem, stepIdx, normalizedField, {
      capLargeFileBodies: !full && !explicitFullArgs,
      maxFieldChars,
      full,
      fromCompact: false
    });
    return single.text;
  }

  const effectiveFullArgs = Boolean(fullArgs || full);
  const parts = [];
  parts.push(`### [Step ${stepIdx} | ${role}]${errorBadge}${timeStr}`);

  if (includeThinking && effectiveItem.thinking) {
    const cleanThinking = cleanMessageContent(effectiveItem.thinking, full ? maxContentChars : maxThinkingChars, { full }).trim();
    if (cleanThinking) {
      parts.push(`> <thinking>\n> ${cleanThinking.split("\n").join("\n> ")}\n> </thinking>`);
    }
  }

  if ((includeToolCalls || effectiveFullArgs || role === "ASSISTANT") && Array.isArray(effectiveItem.tool_calls) && effectiveItem.tool_calls.length > 0) {
    const tcSummary = effectiveItem.tool_calls.map((tc) => {
      const name = tc.name || tc.tool_name || "unknown_tool";
      const args = tc.args || tc.arguments || {};
      const compactArgs = Object.entries(args)
        .map(([k, v]) => formatArgumentDescriptor(k, v, { fullArgs: effectiveFullArgs, unclampLargeArgs: Boolean(full && explicitFullArgs), fromCompact: false }))
        .join(", ");
      return `- \`${name}(${compactArgs})\``;
    });
    parts.push(`**Tool Calls (${effectiveItem.tool_calls.length}):**\n${tcSummary.join("\n")}`);
  }

  if (effectiveItem.content) {
    const isDialogue = isDialogueType(effectiveItem);
    let rawContent = effectiveItem.content;
    if (!isDialogue) {
      rawContent = stripBoilerplate && !full
        ? stripSummaryStepBoilerplate(rawContent, { stripWrappers: false, preserveSpillTag: true })
        : stripLeadingHostTimestampHeaders(rawContent);
    }
    const cleaned = cleanMessageContent(rawContent, maxContentChars, { full });
    if (cleaned.trim()) {
      parts.push(cleaned.trim());
    }
  }

  return parts.join("\n\n");
}

const regexCache = new Map();
const MAX_REGEX_CACHE_ENTRIES = 100;

const MAX_QUERY_REGEX_CHARS = 512;

export function getCompiledRegex(pattern) {
  if (!pattern || typeof pattern !== "string") return null;
  const cached = regexCache.get(pattern);
  if (cached) return cached;

  const escapedLiteral = () => new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  let rx;
  if (pattern.length > MAX_QUERY_REGEX_CHARS) {
    rx = escapedLiteral();
  } else {
    try {
      rx = new RegExp(pattern, "i");
    } catch {
      rx = escapedLiteral();
    }
  }

  if (regexCache.size >= MAX_REGEX_CACHE_ENTRIES) {
    const firstKey = regexCache.keys().next().value;
    regexCache.delete(firstKey);
  }
  regexCache.set(pattern, rx);
  return rx;
}

async function batchFindFullSteps(fullPath, stepIndicesSet) {
  const result = new Map();
  if (!stepIndicesSet || stepIndicesSet.size === 0 || !fullPath) return result;

  let fileStream;
  let rl;
  try {
    fileStream = fs.createReadStream(fullPath, { encoding: "utf-8" });
    rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (stepIndicesSet.has(item.step_index)) {
          result.set(item.step_index, item);
          if (result.size >= stepIndicesSet.size) {
            break;
          }
        }
      } catch {}
    }
  } catch {} finally {
    if (rl) rl.close();
    if (fileStream) fileStream.destroy();
  }
  return result;
}

function itemMatchesRole(item, roleSet, matchAllRoles) {
  if (matchAllRoles) return true;
  const type = String(item.type || "").toUpperCase();
  if (roleSet.has("user") && type === "USER_INPUT") return true;
  if (roleSet.has("assistant") && type === "PLANNER_RESPONSE") return true;
  if (roleSet.has("subagent") && type === "SUBAGENT_RESPONSE") return true;
  if (roleSet.has("generic") && type === "GENERIC") return true;
  if (roleSet.has("system") && type === "SYSTEM_MESSAGE") return true;
  if (roleSet.has("tool") && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) return true;
  if (roleSet.has("error") && isStructuredErrorItem(item)) return true;
  return false;
}

function itemMatchesQuery(item, queryRegex) {
  if (!queryRegex) return true;
  if (typeof item.content === "string" && queryRegex.test(item.content)) return true;
  if (item.content && typeof item.content !== "string" && queryRegex.test(JSON.stringify(item.content))) return true;
  if (typeof item.thinking === "string" && queryRegex.test(item.thinking)) return true;
  if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0 && queryRegex.test(JSON.stringify(item.tool_calls))) return true;
  return false;
}

/**
 * Bounded streaming reader for Antigravity compact & full transcripts.
 */
function isSubstantiveWorkerPromptItem(item) {
  if (!item) return false;
  const isSystem = item.type === "SYSTEM_MESSAGE" || item.source === "SYSTEM";
  if (!isSystem) return false;
  const content = typeof item.content === "string" ? item.content : "";
  if (!content.trim()) return false;
  if (content.includes("content=[swarm] new board message")) return false;
  return true;
}

/**
 * Streams a transcript file, optionally clamping turns and content lengths.
 */
export async function readTranscript({
  conversationId,
  filePath: explicitFile,
  mode = "compact",
  lastTurns = 3,
  offset,
  limit,
  includeThinking = false,
  full = false,
  maxOutputChars,
  allowExternalPaths = false
} = {}) {
  const effectiveMode = full && mode === "compact" ? "full" : mode;
  const resolved = resolveTranscriptPath(conversationId, effectiveMode, {
    explicitFile,
    allowExternalPaths,
    subcommand: "read"
  });
  if (resolved.error) {
    return { isError: true, text: resolved.error, error: resolved.error, candidates: resolved.candidates };
  }

  const { filePath, convId } = resolved;
  const hasExplicitPagination = offset !== undefined || limit !== undefined;
  const parsedLastTurns = Number(lastTurns);
  const effectiveLastTurns = Number.isFinite(parsedLastTurns) ? parsedLastTurns : 3;

  const pageOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const pageLimit = Math.min(MAX_BOUNDED_READ_STEPS, Math.max(1, Math.floor(Number(limit) || 50)));
  const ringCap = effectiveLastTurns > 0
    ? Math.min(2000, Math.max(100, effectiveLastTurns * 25))
    : MAX_BOUNDED_READ_STEPS;

  const ringBuffer = hasExplicitPagination ? null : new CircularRingBuffer(ringCap);
  const pageLines = hasExplicitPagination ? [] : null;
  let hasMorePaged = false;

  let fileStream;
  let rl;
  let totalStepsCount = 0;

  try {
    fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
    rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (hasExplicitPagination) {
        if (totalStepsCount >= pageOffset) {
          if (pageLines.length < pageLimit) {
            pageLines.push({ raw: trimmed, fileOrdinal: totalStepsCount });
          } else {
            hasMorePaged = true;
            totalStepsCount++;
            break;
          }
        }
        totalStepsCount++;
      } else {
        ringBuffer.push({ raw: trimmed, fileOrdinal: totalStepsCount });
        totalStepsCount++;
      }
    }
  } catch (err) {
    const msg = `Error reading transcript stream: ${err.message}`;
    return { isError: true, text: msg, error: msg };
  } finally {
    if (rl) rl.close();
    if (fileStream) fileStream.destroy();
  }

  if (totalStepsCount === 0) {
    const msg = `Transcript is empty at: ${filePath}`;
    return { convId, filePath, mode: effectiveMode, totalSteps: 0, selectedSteps: 0, displayedSteps: 0, clamped: false, nextCursor: null, steps: [], text: msg };
  }

  const rawEntries = hasExplicitPagination ? pageLines : ringBuffer.toArray();
  const items = [];
  const fileOrdinalMap = new WeakMap();
  for (let i = 0; i < rawEntries.length; i++) {
    try {
      const parsed = JSON.parse(rawEntries[i].raw);
      parsed._fileOrd = rawEntries[i].fileOrdinal;
      fileOrdinalMap.set(parsed, rawEntries[i].fileOrdinal);
      items.push(parsed);
    } catch {
      // Tolerates incomplete trailing flushes during concurrent writes
    }
  }

  let selected = items;
  if (!hasExplicitPagination && effectiveLastTurns > 0) {
    const userTurnItems = items.filter((it) => it.type === "USER_INPUT");
    const workerPromptItems = userTurnItems.length === 0
      ? items.filter((it) => isSubstantiveWorkerPromptItem(it))
      : [];
    const turnItems = userTurnItems.length > 0
      ? userTurnItems
      : workerPromptItems.length > 0
        ? workerPromptItems
        : items.filter((it) => it.type === "PLANNER_RESPONSE");
    const cutoff = Math.max(0, turnItems.length - effectiveLastTurns);
    const anchor = turnItems[cutoff];
    if (anchor) {
      const minOrd = anchor._fileOrd ?? 0;
      selected = items.filter((it) => (it._fileOrd ?? 0) >= minOrd);
    }
  }

  const fromCompact = !filePath.endsWith("transcript_full.jsonl");
  selected = selected.map((it) => {
    const normalizedItem = normalizeStepRecordForOutput(it, { fromCompact });
    if (fileOrdinalMap.has(it)) {
      fileOrdinalMap.set(normalizedItem, fileOrdinalMap.get(it));
    }
    return normalizedItem;
  });

  const parsedMaxChars = Number(maxOutputChars);
  const hasExplicitMaxChars = Number.isFinite(parsedMaxChars) && parsedMaxChars > 0;
  const maxWindowChars = hasExplicitMaxChars
    ? Math.min(MAX_DEEP_OUTPUT_CHARS, Math.floor(parsedMaxChars))
    : (full ? MAX_DEEP_OUTPUT_CHARS : (effectiveMode === "compact" ? INLINE_SAFE_CHARS : MAX_OUTPUT_CHARS));
  const modeSuffix = full
    ? (maxWindowChars >= MAX_DEEP_OUTPUT_CHARS ? " (unclamped)" : ` (capped at ${maxWindowChars} B)`)
    : "";
  const buildHeader = (displayedCount) => {
    const scopeDesc = hasExplicitPagination
      ? `page offset=${pageOffset}, limit=${pageLimit}`
      : effectiveLastTurns > 0
        ? `${effectiveLastTurns} turns`
        : `all (bounded window ${selected.length} steps)`;
    return [
      `# Conversation Transcript: \`${convId}\``,
      `- Mode: **${effectiveMode}**${modeSuffix} (${path.basename(filePath)})`,
      `- Total Steps in Log: ${hasExplicitPagination ? `${totalStepsCount}+ (paged)` : totalStepsCount}`,
      `- Displayed Steps: ${displayedCount} (showing last ${scopeDesc})`,
      "",
      "---",
      ""
    ].join("\n");
  };

  // Reserve exact header space + footer reserve based on UTF-8 bytes
  const headerBytes = utf8ByteLength(buildHeader(selected.length)) + 16;
  const footerReserve = 240;
  const effectiveBudget = Math.max(0, maxWindowChars - footerReserve);

  const formatReadBlock = (item) => {
    const isDialogueTurn =
      item.type === "USER_INPUT" ||
      item.type === "PLANNER_RESPONSE" ||
      item.type === "SUBAGENT_RESPONSE";
    return formatTranscriptItem(item, {
      includeThinking,
      includeToolCalls: true,
      fullArgs: Boolean(full),
      explicitFullArgs: Boolean(full),
      full: Boolean(full),
      stripBoilerplate: effectiveMode === "compact" && !full,
      maxContentChars: full
        ? maxWindowChars
        : (effectiveMode === "compact" && !isDialogueTurn ? 750 : MAX_TURN_CHARS),
      maxThinkingChars: full ? maxWindowChars : 4000
    });
  };

  const {
    blocks: formattedBlocks,
    displayed: displayedItems,
    clamped
  } = clampRenderedBlocksToBudget(selected, {
    direction: hasExplicitPagination ? "forward" : "backward",
    headerBytes,
    effectiveBudget,
    render: formatReadBlock
  });

  let nextCursor = null;
  if (hasExplicitPagination && (clamped || hasMorePaged)) {
    const nextOrd = displayedItems.length > 0
      ? (fileOrdinalMap.get(displayedItems[displayedItems.length - 1]) ?? (pageOffset + displayedItems.length - 1)) + 1
      : pageOffset + pageLimit;
    nextCursor = { offset: nextOrd, limit: pageLimit };
  } else if (!hasExplicitPagination && clamped && displayedItems.length > 0) {
    const firstOrd = fileOrdinalMap.get(displayedItems[0]) ?? 0;
    if (firstOrd > 0) {
      const prevLimit = Math.min(MAX_BOUNDED_READ_STEPS, firstOrd);
      nextCursor = { offset: 0, limit: prevLimit };
    }
  }

  const header = buildHeader(formattedBlocks.length);
  let fullOutput = header + formattedBlocks.join("\n\n---\n\n");
  if (clamped || (hasExplicitPagination && hasMorePaged)) {
    const ceilingLabel = full
      ? `${(maxWindowChars / 1024).toFixed(0)} KB deep`
      : effectiveMode === "compact"
        ? `${(maxWindowChars / 1024).toFixed(1)} KB inline`
        : `${(maxWindowChars / 1024).toFixed(0)} KB`;
    const nextHint = nextCursor
      ? `; next: \`--offset ${nextCursor.offset} --limit ${nextCursor.limit}\``
      : "";
    const reasonPrefix = clamped
      ? `Transcript display clamped at ${ceilingLabel} ceiling`
      : `More steps follow (${pageOffset}..${pageOffset + displayedItems.length - 1} shown)`;
    fullOutput += `\n\n... [${reasonPrefix}${nextHint}; or use \`agy-context transcript outline --id ${convId}\` / \`--full\` / \`--out <path>\`] ...`;
  }

  return {
    convId,
    filePath,
    mode: effectiveMode,
    totalSteps: totalStepsCount,
    selectedSteps: selected.length,
    displayedSteps: formattedBlocks.length,
    clamped: clamped || (hasExplicitPagination && hasMorePaged),
    nextCursor,
    steps: displayedItems,
    text: fullOutput
  };
}

const MAX_BATCH_STEPS = 200;

function parseStepSelector(stepIndex, startStep, endStep) {
  const indexSet = new Set();
  let isMulti = false;

  const hasStart = startStep !== undefined && startStep !== null && startStep !== "";
  const hasEnd = endStep !== undefined && endStep !== null && endStep !== "";

  if (hasStart || hasEnd) {
    if (!hasStart || !hasEnd) {
      return { error: "Error: Both '--start' and '--end' must be provided when specifying a step range." };
    }
    const s = Number(startStep);
    const e = Number(endStep);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < s) {
      return { error: `Error: Invalid step range start=${startStep}, end=${endStep} (expected non-negative integers with end >= start).` };
    }
    if (e - s + 1 > MAX_BATCH_STEPS) {
      return { error: `Error: Step range ${s}..${e} exceeds maximum batch size of ${MAX_BATCH_STEPS} steps.` };
    }
    isMulti = true;
    for (let idx = s; idx <= e; idx++) {
      indexSet.add(idx);
    }
  }

  if (stepIndex !== undefined && stepIndex !== null && stepIndex !== "") {
    if (typeof stepIndex === "number") {
      if (!Number.isInteger(stepIndex) || stepIndex < 0) {
        return { error: `Error: 'stepIndex' must be a non-negative integer (received: ${stepIndex}).` };
      }
      indexSet.add(stepIndex);
    } else if (Array.isArray(stepIndex)) {
      isMulti = true;
      for (const part of stepIndex) {
        const sub = parseStepSelector(part);
        if (sub.error) return sub;
        for (const idx of sub.indices) indexSet.add(idx);
      }
    } else {
      const raw = String(stepIndex).trim();
      if (/^\d+$/.test(raw)) {
        indexSet.add(Number(raw));
      } else if (/^\d+(?:\s*(?:,|-|\.\.)\s*\d+)+$/.test(raw)) {
        isMulti = true;
        const segments = raw.split(",").map((s) => s.trim()).filter(Boolean);
        for (const seg of segments) {
          const rangeMatch = seg.match(/^(\d+)\s*(?:-|\.\.)\s*(\d+)$/);
          if (rangeMatch) {
            const s = Number(rangeMatch[1]);
            const e = Number(rangeMatch[2]);
            if (e < s) {
              return { error: `Error: Invalid step range '${seg}' (end must be >= start).` };
            }
            if (e - s + 1 > MAX_BATCH_STEPS) {
              return { error: `Error: Step range '${seg}' exceeds maximum batch size of ${MAX_BATCH_STEPS} steps.` };
            }
            for (let idx = s; idx <= e; idx++) indexSet.add(idx);
          } else if (/^\d+$/.test(seg)) {
            indexSet.add(Number(seg));
          } else {
            return { error: `Error: 'stepIndex' must be a number, comma-separated list, or range (received: ${stepIndex}).` };
          }
        }
      } else {
        return { error: `Error: 'stepIndex' must be a number (received: ${stepIndex}).` };
      }
    }
  }

  if (indexSet.size === 0) {
    return { error: `Error: 'stepIndex' must be a number (received: ${stepIndex}).` };
  }
  if (indexSet.size > MAX_BATCH_STEPS) {
    return { error: `Error: Requested ${indexSet.size} steps, exceeding maximum batch size of ${MAX_BATCH_STEPS}.` };
  }

  const indices = Array.from(indexSet).sort((a, b) => a - b);
  if (indices.length > 1) isMulti = true;
  return { indices, isMulti };
}

function applyLineSlice(str, { headLines, tailLines, lineStart, lineEnd } = {}) {
  if (!str || typeof str !== "string") return { text: str, sliced: false, totalLines: 0, startLine: 0, endLine: 0 };
  const hasStart = lineStart !== undefined && lineStart !== null && Number.isFinite(Number(lineStart)) && Number(lineStart) > 0;
  const hasEnd = lineEnd !== undefined && lineEnd !== null && Number.isFinite(Number(lineEnd)) && Number(lineEnd) > 0;
  const h = Number(headLines);
  const t = Number(tailLines);
  const hasHead = Number.isFinite(h) && h > 0;
  const hasTail = Number.isFinite(t) && t > 0;

  const trimmedTrailingNl = str.endsWith("\r\n") ? str.slice(0, -2) : (str.endsWith("\n") ? str.slice(0, -1) : str);
  let lines = trimmedTrailingNl.split(/\r?\n/);
  const isSingleLongLine = lines.length === 1 && trimmedTrailingNl.length > 120;
  if (!hasStart && !hasEnd && !hasHead && !hasTail) {
    return { text: str, sliced: false, totalLines: lines.length, startLine: 1, endLine: lines.length };
  }

  if (isSingleLongLine) {
    const chunks = [];
    for (let pos = 0; pos < trimmedTrailingNl.length; pos += 120) {
      chunks.push(trimmedTrailingNl.slice(pos, pos + 120));
    }
    lines = chunks;
  }

  const totalLines = lines.length;
  let startIdx = 0;
  let endIdx = totalLines;

  if (hasStart || hasEnd) {
    startIdx = hasStart ? Math.min(totalLines, Math.max(0, Math.floor(Number(lineStart)) - 1)) : 0;
    endIdx = hasEnd ? Math.min(totalLines, Math.max(startIdx, Math.floor(Number(lineEnd)))) : totalLines;
  }

  if (startIdx >= totalLines) {
    const reqStart = hasStart ? Math.floor(Number(lineStart)) : 1;
    const reqEnd = hasEnd ? Math.floor(Number(lineEnd)) : totalLines;
    return {
      text: `[No lines in requested range ${reqStart}-${reqEnd} (total lines: ${totalLines})]`,
      sliced: false,
      totalLines,
      startLine: 0,
      endLine: 0
    };
  }

  let subset = lines.slice(startIdx, endIdx);
  if (hasHead && subset.length > h) {
    endIdx = startIdx + h;
    subset = subset.slice(0, h);
  }
  if (hasTail && subset.length > t) {
    startIdx = endIdx - t;
    subset = subset.slice(-t);
  }

  const sliced = startIdx > 0 || endIdx < totalLines;
  const joined = isSingleLongLine ? subset.join("") : subset.join("\n");
  return {
    text: joined,
    sliced,
    totalLines,
    startLine: totalLines === 0 ? 0 : startIdx + 1,
    endLine: endIdx
  };
}

function clampFieldBody(bodyStr, numIndex, fieldLabel, { maxFieldChars, reserveBytes = 1, isBatch = false, full = false, sliceMeta = null }) {
  const effectiveBody = String(bodyStr);
  const lineInfo = sliceMeta && sliceMeta.sliced
    ? `\n\n[Lines ${sliceMeta.startLine}-${sliceMeta.endLine} of ${sliceMeta.totalLines}]`
    : "";
  const fullWithMeta = effectiveBody + lineInfo;
  const maxBodyBytes = Math.max(0, maxFieldChars - reserveBytes);
  if (utf8ByteLength(fullWithMeta) <= maxBodyBytes && fullWithMeta.length <= maxBodyBytes) {
    return { body: fullWithMeta, clamped: false };
  }
  const limitDesc = maxFieldChars >= 2048
    ? `${Math.round(maxFieldChars / 1024)} KB`
    : `${maxFieldChars} chars`;
  const hint = isBatch
    ? `Step ${numIndex} (${fieldLabel}) clamped in batch view at ${maxFieldChars.toLocaleString("en-US")} chars; run --step ${numIndex} --field ${fieldLabel} --full or --out <path>`
    : full
      ? `Step ${numIndex} (${fieldLabel}) clamped at ${limitDesc} deep ceiling; pass --max-chars <N> or --line-start/--line-end`
      : `Step ${numIndex} (${fieldLabel}) clamped at ${limitDesc} limit; pass --full, --out <path>, --json, or --head/--tail/--line-start`;
  const notice = `\n... [${hint}]`;
  const noticeBytes = utf8ByteLength(notice);
  const bodyBudget = maxBodyBytes - noticeBytes;
  if (bodyBudget <= 0) {
    return {
      body: utf8SliceToBytes(effectiveBody, maxBodyBytes),
      clamped: true
    };
  }
  const truncated = utf8SliceToBytes(effectiveBody, bodyBudget);
  return {
    body: `${truncated}${notice}`,
    clamped: true
  };
}

function toFieldDisplayString(val, fallback) {
  if (val === undefined || val === null || val === "") return fallback;
  return typeof val === "string" ? val : JSON.stringify(val, null, 2);
}

export function formatSingleStepDetail(step, numIndex, field, options = {}) {
  const {
    maxFieldChars,
    capLargeFileBodies = false,
    full = false,
    isBatch = false,
    fromCompact = false,
    headLines,
    tailLines,
    lineStart,
    lineEnd
  } = options;
  const effectiveStep = fromCompact ? normalizeStepRecordForOutput(step, { fromCompact: true }) : step;
  const hasExplicitMax = Number.isFinite(Number(maxFieldChars)) && Number(maxFieldChars) > 0;
  const effectiveMax = hasExplicitMax
    ? Math.min(MAX_DEEP_OUTPUT_CHARS, Math.floor(Number(maxFieldChars)))
    : (full ? MAX_DEEP_OUTPUT_CHARS : MAX_FIELD_CHARS);
  const f = field ? String(field).trim() : "all";
  const sliceOpts = { headLines, tailLines, lineStart, lineEnd };
  const hasAnySlice = Boolean(
    (headLines !== undefined && Number(headLines) > 0) ||
    (tailLines !== undefined && Number(tailLines) > 0) ||
    (lineStart !== undefined && Number(lineStart) > 0) ||
    (lineEnd !== undefined && Number(lineEnd) > 0)
  );

  if (f === "content") {
    const rawVal = toFieldDisplayString(effectiveStep.content, "(No content in step)");
    const prefix = `### Step ${numIndex} Content\n\n`;
    let normalizedContent = collapseExcessBlankLines(normalizeLineEndings(rawVal));
    if (effectiveStep.content !== undefined && effectiveStep.content !== null && effectiveStep.content !== "" && !isDialogueType(effectiveStep)) {
      normalizedContent = stripLeadingHostTimestampHeaders(normalizedContent) || "(No content in step)";
    }
    if (normalizedContent.length > MAX_LINE_CHARS) {
      let jsonFormatted = false;
      const prettyLines = normalizedContent.split("\n").map((l) => {
        if (l.length <= MAX_LINE_CHARS) return l;
        const res = clampOrPrettyPrintLongLine(l, Infinity, true, MAX_LINE_CHARS);
        if (res.changed) jsonFormatted = true;
        return res.text;
      });
      if (jsonFormatted) normalizedContent = prettyLines.join("\n");
    }
    const sliceRes = applyLineSlice(normalizedContent, sliceOpts);
    const { body, clamped } = clampFieldBody(sliceRes.text, numIndex, "content", {
      maxFieldChars: effectiveMax,
      reserveBytes: utf8ByteLength(prefix) + 1,
      isBatch,
      full,
      sliceMeta: sliceRes
    });
    const text = `${prefix}${body}`;
    return { stepIndex: numIndex, field: f, clamped, step: effectiveStep, data: effectiveStep.content ?? null, text };
  }

  if (f === "thinking") {
    const rawVal = toFieldDisplayString(effectiveStep.thinking, "(No thinking block in step)");
    const prefix = `### Step ${numIndex} Thinking\n\n`;
    const normalizedThinking = effectiveStep.thinking !== undefined && effectiveStep.thinking !== null && effectiveStep.thinking !== ""
      ? collapseExcessBlankLines(normalizeLineEndings(rawVal)).trim() || "(No thinking block in step)"
      : rawVal;
    const sliceRes = applyLineSlice(normalizedThinking, sliceOpts);
    const { body, clamped } = clampFieldBody(sliceRes.text, numIndex, "thinking", {
      maxFieldChars: effectiveMax,
      reserveBytes: utf8ByteLength(prefix) + 1,
      isBatch,
      full,
      sliceMeta: sliceRes
    });
    const text = `${prefix}${body}`;
    return { stepIndex: numIndex, field: f, clamped, step: effectiveStep, data: effectiveStep.thinking ?? null, text };
  }

  if (f === "tool_calls") {
    const calls = Array.isArray(effectiveStep.tool_calls) ? effectiveStep.tool_calls : [];
    const rawVal = JSON.stringify(calls, null, 2);
    const prefix = `### Step ${numIndex} Tool Calls (${calls.length})\n\`\`\`json\n`;
    const suffix = "\n```";
    const sliceRes = applyLineSlice(rawVal, sliceOpts);
    const { body, clamped } = clampFieldBody(sliceRes.text, numIndex, "tool_calls", {
      maxFieldChars: effectiveMax,
      reserveBytes: utf8ByteLength(prefix) + utf8ByteLength(suffix) + 1,
      isBatch,
      full,
      sliceMeta: sliceRes
    });
    const text = `${prefix}${body}${suffix}`;
    return { stepIndex: numIndex, field: f, clamped, step: effectiveStep, data: calls, text };
  }

  if (f === "tool_args" || f.startsWith("tool_args:")) {
    const argName = f.includes(":") ? f.slice(f.indexOf(":") + 1).trim() : null;
    const calls = Array.isArray(effectiveStep.tool_calls) ? effectiveStep.tool_calls : [];
    if (calls.length === 0) {
      const text = `Step ${numIndex} contains no tool calls.`;
      return { stepIndex: numIndex, field: f, clamped: false, step: effectiveStep, data: [], text };
    }

    const mappedCalls = calls.map((tc, idx) => {
      const name = tc.name || tc.tool_name || "unknown_tool";
      const tcArgs = tc.args || tc.arguments || {};
      if (!capLargeFileBodies || full) {
        return { index: idx, name, args: tcArgs };
      }
      const displayArgs = {};
      for (const [k, v] of Object.entries(tcArgs)) {
        const un = normalizeJsonValueStrings(v);
        if (typeof un === "string" && LARGE_BODY_ARG_KEYS.has(k) && un.length > 600) {
          displayArgs[k] = `${un.slice(0, 300)}... [${un.length} chars; use 'step --step ${numIndex} --field tool_args' or '--full' for full text]`;
        } else {
          displayArgs[k] = un;
        }
      }
      return { index: idx, name, args: tcArgs, displayArgs };
    });

    if (argName) {
      const extracted = mappedCalls.map((entry) => ({
        index: entry.index,
        name: entry.name,
        hasKey: Object.prototype.hasOwnProperty.call(entry.args, argName),
        value: Object.prototype.hasOwnProperty.call(entry.args, argName) ? entry.args[argName] : undefined
      }));

      let rawBody;
      let headerLine;
      if (extracted.length === 1) {
        rawBody = extracted[0].hasKey
          ? (typeof extracted[0].value === "string" ? extracted[0].value : JSON.stringify(extracted[0].value, null, 2))
          : "(not present)";
        headerLine = `### Step ${numIndex} Argument: \`${argName}\``;
      } else {
        const sections = extracted.map((entry) => {
          const valStr = entry.hasKey
            ? (typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value, null, 2))
            : "(not present)";
          return `- **[${entry.index}] \`${entry.name}\`**:\n${String(valStr)}`;
        });
        rawBody = sections.join("\n\n");
        headerLine = `### Step ${numIndex} Argument: \`${argName}\` (across ${extracted.length} tool calls)`;
      }
      const prefix = `${headerLine}\n\n`;
      const sliceRes = applyLineSlice(String(rawBody), sliceOpts);
      const { body, clamped } = clampFieldBody(sliceRes.text, numIndex, f, {
        maxFieldChars: effectiveMax,
        reserveBytes: utf8ByteLength(prefix) + 1,
        isBatch,
        full,
        sliceMeta: sliceRes
      });
      return { stepIndex: numIndex, field: f, clamped, step: effectiveStep, data: extracted, text: `${prefix}${body}` };
    }

    let rawBody;
    let headerLine;
    let isJsonFence = false;
    if (mappedCalls.length === 1) {
      const renderedArgs = mappedCalls[0].displayArgs || mappedCalls[0].args;
      rawBody = JSON.stringify(renderedArgs, null, 2);
      headerLine = `### Step ${numIndex} Tool Arguments (1 tool call: \`${mappedCalls[0].name}\`)`;
      isJsonFence = true;
    } else {
      const blocks = mappedCalls.map(
        (entry) => `#### [${entry.index}] \`${entry.name}\`\n\`\`\`json\n${JSON.stringify(entry.displayArgs || entry.args, null, 2)}\n\`\`\``
      );
      rawBody = blocks.join("\n\n");
      headerLine = `### Step ${numIndex} Tool Arguments (${mappedCalls.length} tool calls)`;
    }
    const prefix = isJsonFence ? `${headerLine}\n\`\`\`json\n` : `${headerLine}\n\n`;
    const suffix = isJsonFence ? "\n```" : "";
    const sliceRes = applyLineSlice(rawBody, sliceOpts);
    const { body, clamped } = clampFieldBody(sliceRes.text, numIndex, "tool_args", {
      maxFieldChars: effectiveMax,
      reserveBytes: utf8ByteLength(prefix) + utf8ByteLength(suffix) + 1,
      isBatch,
      full,
      sliceMeta: sliceRes
    });
    const text = `${prefix}${body}${suffix}`;
    return { stepIndex: numIndex, field: f, clamped, step: effectiveStep, data: mappedCalls.map(({ index, name, args }) => ({ index, name, args })), text };
  }

  const formatted = formatTranscriptItem(effectiveStep, {
    includeThinking: true,
    includeToolCalls: true,
    fullArgs: true,
    explicitFullArgs: true,
    full: Boolean(full || hasAnySlice),
    fromCompact: false,
    maxContentChars: hasAnySlice ? MAX_DEEP_OUTPUT_CHARS : effectiveMax,
    maxThinkingChars: (full || hasAnySlice) ? (hasAnySlice ? MAX_DEEP_OUTPUT_CHARS : effectiveMax) : Math.min(4000, effectiveMax)
  });
  const sliceRes = applyLineSlice(formatted, sliceOpts);
  const { body, clamped } = clampFieldBody(sliceRes.text, numIndex, "all", {
    maxFieldChars: effectiveMax,
    reserveBytes: 1,
    isBatch,
    full,
    sliceMeta: sliceRes
  });
  return { stepIndex: numIndex, field: "all", clamped, step: effectiveStep, data: effectiveStep, text: body };
}

/**
 * Surgical single-step or multi-step batch extraction (`step` subcommand / `stepIndex` mode).
 * Supports `--step N`, `--step N,M,K`, `--step N-M` / `N..M`, and `--start N --end M`,
 * plus `tool_args` and `tool_args:<Key>` across ALL `step.tool_calls[0..N]`.
 */
export async function getStepDetail({
  conversationId,
  filePath: explicitFile,
  stepIndex,
  startStep,
  endStep,
  field,
  headLines,
  tailLines,
  lineStart,
  lineEnd,
  full = false,
  maxOutputChars,
  allowExternalPaths = false
} = {}) {
  const parsedSelector = parseStepSelector(stepIndex, startStep, endStep);
  if (parsedSelector.error) {
    consumeTranscriptAccessGrant({ subcommand: "step", targetConvId: conversationId || null });
    return { isError: true, text: parsedSelector.error, error: parsedSelector.error };
  }

  const { indices, isMulti } = parsedSelector;
  const targetSet = new Set(indices);

  let resolvedFull;
  let resolvedCompact;
  try {
    resolvedFull = resolveTranscriptPath(conversationId, "full", {
      explicitFile,
      allowExternalPaths,
      subcommand: "step",
      retainGrantForFallback: true
    });
    if (resolvedFull.error && (explicitFile || resolvedFull.isGovernanceError)) {
      return { isError: true, text: resolvedFull.error, error: resolvedFull.error, candidates: resolvedFull.candidates };
    }
    resolvedCompact = resolveTranscriptPath(conversationId, "compact", {
      explicitFile,
      allowExternalPaths,
      subcommand: "step",
      retainGrantForFallback: false
    });
  } finally {
    consumeTranscriptAccessGrant({ subcommand: "step", targetConvId: conversationId || null });
  }

  if (resolvedCompact.error && !resolvedFull.filePath) {
    return { isError: true, text: resolvedCompact.error, error: resolvedCompact.error, candidates: resolvedCompact.candidates };
  }

  let usedConvId = resolvedFull.convId || resolvedCompact.convId;
  let usedFilePath = resolvedFull.filePath || resolvedCompact.filePath;
  const foundMap = new Map();

  if (resolvedFull && resolvedFull.filePath && fs.existsSync(resolvedFull.filePath)) {
    const fullMatches = await batchFindFullSteps(resolvedFull.filePath, targetSet);
    for (const [k, v] of fullMatches.entries()) {
      foundMap.set(k, v);
    }
  }

  const compactMatchIndices = new Set();
  if (foundMap.size < targetSet.size) {
    const missingSet = new Set(indices.filter((idx) => !foundMap.has(idx)));
    if (
      resolvedCompact &&
      resolvedCompact.filePath &&
      resolvedCompact.filePath !== resolvedFull.filePath &&
      fs.existsSync(resolvedCompact.filePath)
    ) {
      if (foundMap.size === 0) usedFilePath = resolvedCompact.filePath;
      const compactMatches = await batchFindFullSteps(resolvedCompact.filePath, missingSet);
      for (const [k, v] of compactMatches.entries()) {
        foundMap.set(k, v);
        compactMatchIndices.add(k);
      }
    }
  }

  const baseUsedCompact = usedFilePath && !usedFilePath.endsWith("transcript_full.jsonl");
  const parsedMaxChars = Number(maxOutputChars);
  const hasExplicitMaxChars = Number.isFinite(parsedMaxChars) && parsedMaxChars > 0;
  const effectiveCeiling = hasExplicitMaxChars
    ? Math.min(MAX_DEEP_OUTPUT_CHARS, Math.floor(parsedMaxChars))
    : (full ? MAX_DEEP_OUTPUT_CHARS : MAX_FIELD_CHARS);

  if (!isMulti) {
    const numIndex = indices[0];
    const rawStep = foundMap.get(numIndex);
    if (!rawStep) {
      const msg = `Step index ${numIndex} not found in transcript.`;
      return { isError: true, text: msg, error: msg };
    }
    const step = normalizeStepRecordForOutput(rawStep, {
      fromCompact: Boolean(baseUsedCompact || compactMatchIndices.has(numIndex))
    });
    const single = formatSingleStepDetail(step, numIndex, field, {
      maxFieldChars: effectiveCeiling,
      full,
      isBatch: false,
      headLines,
      tailLines,
      lineStart,
      lineEnd
    });
    return {
      convId: usedConvId,
      filePath: usedFilePath,
      stepIndex: numIndex,
      field: single.field,
      clamped: Boolean(single.clamped),
      nextCursor: null,
      ...(single.field === "all" ? { step: single.step } : { data: single.data }),
      text: single.text
    };
  }

  const foundSteps = [];
  const missingSteps = [];
  const perStepMaxChars = full
    ? effectiveCeiling
    : hasExplicitMaxChars
      ? Math.min(effectiveCeiling, Math.max(250, Math.floor(effectiveCeiling / Math.max(1, indices.length))))
      : Math.max(2000, Math.min(8000, Math.floor(effectiveCeiling / Math.max(1, indices.length))));
  for (const idx of indices) {
    const rawStep = foundMap.get(idx);
    if (rawStep) {
      const step = normalizeStepRecordForOutput(rawStep, {
        fromCompact: Boolean(baseUsedCompact || compactMatchIndices.has(idx))
      });
      foundSteps.push(
        formatSingleStepDetail(step, idx, field, {
          maxFieldChars: perStepMaxChars,
          capLargeFileBodies: !full && indices.length >= 3,
          full,
          isBatch: true,
          headLines,
          tailLines,
          lineStart,
          lineEnd
        })
      );
    } else {
      missingSteps.push(idx);
    }
  }

  if (foundSteps.length === 0) {
    const msg = `Step indices [${indices.join(", ")}] not found in transcript.`;
    return { isError: true, text: msg, error: msg };
  }

  const normalizedField = foundSteps[0].field;
  const footerReserve = 220;
  const effectiveBatchBudget = Math.max(0, effectiveCeiling - footerReserve);
  const {
    blocks,
    displayed: retainedSteps,
    clamped: batchClamped
  } = clampRenderedBlocksToBudget(foundSteps, {
    direction: "forward",
    headerBytes: 0,
    effectiveBudget: effectiveBatchBudget,
    overflowReserve: 40,
    overflowSuffix: "",
    render: (entry) => ({ block: entry.text, item: entry })
  });

  let joined = blocks.join("\n\n---\n\n");
  const anyStepClamped = retainedSteps.some((s) => s.clamped);
  const remainingSteps = batchClamped
    ? foundSteps.slice(blocks.length).map((s) => s.stepIndex)
    : [];
  const remainingIsContiguous =
    remainingSteps.length > 1 &&
    remainingSteps.every((s, idx) => idx === 0 || s === remainingSteps[idx - 1] + 1);
  const nextCursor = remainingSteps.length > 0
    ? {
        step: remainingSteps.length === 1
          ? String(remainingSteps[0])
          : remainingIsContiguous
            ? `${remainingSteps[0]}-${remainingSteps[remainingSteps.length - 1]}`
            : remainingSteps.join(",")
      }
    : null;

  if (batchClamped) {
    const nextHint = nextCursor ? `; next: \`--step ${nextCursor.step}\`` : "";
    joined += `\n\n... [Batch step output clamped at ${effectiveCeiling.toLocaleString("en-US")}-character ceiling (showed ${retainedSteps.length} of ${foundSteps.length} steps)${nextHint}; or pass \`--full\` / \`--out <path>\`] ...`;
  }

  return {
    convId: usedConvId,
    filePath: usedFilePath,
    stepIndex: retainedSteps[0].stepIndex,
    stepIndices: retainedSteps.map((s) => s.stepIndex),
    requestedSteps: indices,
    missingSteps,
    field: normalizedField,
    clamped: batchClamped || anyStepClamped,
    nextCursor,
    steps: retainedSteps.map((s) =>
      normalizedField === "all"
        ? { stepIndex: s.stepIndex, step: s.step }
        : { stepIndex: s.stepIndex, data: s.data }
    ),
    text: joined
  };
}

function consumeLeadingLineIf(text, predicate) {
  const trimmed = text.trimStart();
  if (!trimmed) return { matched: false, rest: text };
  const nlIdx = trimmed.indexOf("\n");
  const firstLine = nlIdx === -1 ? trimmed : trimmed.slice(0, nlIdx);
  if (!predicate(firstLine)) return { matched: false, rest: text };
  return { matched: true, rest: nlIdx === -1 ? "" : trimmed.slice(nlIdx + 1) };
}

function stripTrailingClosingTags(text, lowerTags) {
  if (typeof text !== "string" || !text) return text;
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  const lower = text.slice(0, end).toLowerCase();
  for (const tag of lowerTags) {
    if (lower.endsWith(tag)) {
      end -= tag.length;
      while (end > 0 && /\s/.test(text[end - 1])) end--;
      return text.slice(0, end);
    }
  }
  return text;
}

const SPILL_BANNER_PREFIX =
  "the tool's output was truncated due to being too long. you can find the full output in a file at file://";

export function stripSummaryStepBoilerplate(content, options = {}) {
  if (typeof content !== "string") return content;
  const { stripWrappers = true, preserveSpillTag = true } = options;
  let working = normalizeLineEndings(content);
  let spillTag = "";
  let strippedAny = false;

  for (let pass = 0; pass < 6; pass++) {
    const before = working;

    // 1. Pre-tool hook mutation notice (linear line-by-line scan)
    while (true) {
      const res = consumeLeadingLineIf(working, (line) =>
        /^A pre-tool hook changed the arguments of this tool call before it ran\.?(?:[ \t]+Changed:.*)?$/i.test(line.trim())
      );
      if (!res.matched) break;
      working = res.rest;
    }

    // 2. Host Created/Completed At timestamp headers (linear line-by-line scan)
    while (true) {
      const res = consumeLeadingLineIf(working, (line) => /^(?:Created|Completed) At:/i.test(line.trim()));
      if (!res.matched) break;
      working = res.rest;
    }

    // 3. Successful command exit header + optional `Command output:` line (linear)
    const exitRes = consumeLeadingLineIf(working, (line) => /^Command exited with code 0\.$/i.test(line.trim()));
    if (exitRes.matched) {
      working = exitRes.rest;
      const outRes = consumeLeadingLineIf(working, (line) => /^Command output:$/i.test(line.trim()));
      if (outRes.matched) {
        working = outRes.rest;
      }
    }

    // 4. Truncation spillover banner + optional `Here is a preview...:` line (linear)
    const spillTrimmed = working.trimStart();
    const spillNlIdx = spillTrimmed.indexOf("\n");
    if (spillNlIdx !== -1) {
      const firstLine = spillTrimmed.slice(0, spillNlIdx);
      if (firstLine.toLowerCase().startsWith(SPILL_BANNER_PREFIX)) {
        const stepIdMatch = /[\\/]steps[\\/](\d+)[\\/]output\.txt/i.exec(firstLine);
        if (stepIdMatch) {
          if (preserveSpillTag && !spillTag && stepIdMatch[1]) {
            spillTag = `[spill: steps/${stepIdMatch[1]}] `;
          }
          let restStart = spillNlIdx + 1;
          while (restStart < spillTrimmed.length && spillTrimmed[restStart] === "\n") {
            restStart++;
          }
          let restAfterSpill = spillTrimmed.slice(restStart);
          const previewNlIdx = restAfterSpill.indexOf("\n");
          const previewLine = previewNlIdx === -1 ? restAfterSpill : restAfterSpill.slice(0, previewNlIdx);
          const previewTrimmed = previewLine.trimEnd();
          if (previewTrimmed.toLowerCase().startsWith("here is a preview") && previewTrimmed.endsWith(":")) {
            restAfterSpill = previewNlIdx === -1 ? "" : restAfterSpill.slice(previewNlIdx + 1);
          }
          working = restAfterSpill;
        }
      }
    }

    if (stripWrappers) {
      working = working
        .replace(/^\s*The following is a <SYSTEM_MESSAGE> not actually sent by the user\.[^\r\n]*(?:\r?\n|$)/i, "")
        .replace(/^\s*<\/?(?:SYSTEM_MESSAGE|USER_REQUEST)>\s*(?:\r?\n|$)/i, "");
      const msgMatch = working.match(/^\s*\[Message\]\s*timestamp=\S+\s+sender=(\S+)\s+priority=\S+\s+content=/i);
      if (msgMatch) {
        working = working.slice(msgMatch[0].length);
      }
    }

    if (working !== before) strippedAny = true;
    working = working.trimStart();
    if (working === before) break;
  }

  if (stripWrappers) {
    working = stripTrailingClosingTags(working, ["</system_message>", "</user_request>"]).trim();
  }
  const combined = (spillTag + working).trim();
  if (combined) return combined;
  return strippedAny ? "" : content;
}

/**
 * Forensic streaming query engine across Antigravity transcripts.
 */
export async function queryTranscript(args = {}) {
  const {
    conversationId,
    filePath: explicitFile,
    query,
    roles = ["all"],
    mode = "auto",
    startStep,
    endStep,
    lastTurns,
    includeThinking = false,
    includeToolCalls = false,
    fullArgs = false,
    full = false,
    maxOutputChars,
    maxResults,
    summaryOnly = false,
    stepIndex,
    field,
    allowExternalPaths = false,
    subcommand = "query"
  } = args;

  const isFullRender = Boolean(full);

  if (stepIndex !== undefined && stepIndex !== null) {
    return getStepDetail({
      conversationId,
      filePath: explicitFile,
      stepIndex,
      startStep,
      endStep,
      field,
      full: isFullRender,
      maxOutputChars,
      allowExternalPaths
    });
  }

  const effectiveSubcommand =
    canonicalizeTranscriptSubcommand(subcommand) === "read" && Boolean(summaryOnly) && !query
      ? "read"
      : "query";

  const normalizedField = field ? String(field).trim() : null;
  const fieldImpliesTools = Boolean(
    normalizedField === "tool_args" ||
    normalizedField === "tool_calls" ||
    (normalizedField && normalizedField.startsWith("tool_args:"))
  );
  const explicitFullArgs = Boolean(fullArgs);
  const effectiveFullArgs = Boolean(explicitFullArgs || fieldImpliesTools || (isFullRender && !summaryOnly));
  const effectiveIncludeTools = Boolean(includeToolCalls || effectiveFullArgs);

  const resolved = resolveTranscriptPath(conversationId, mode === "full" ? "full" : "compact", {
    explicitFile,
    allowExternalPaths,
    subcommand: effectiveSubcommand
  });
  if (resolved.error) {
    return { isError: true, text: resolved.error, error: resolved.error, candidates: resolved.candidates };
  }

  const { filePath, convId } = resolved;
  const fullSiblingPath = resolveFullSiblingPath(filePath);

  const roleList = Array.isArray(roles)
    ? roles
    : String(roles || "user,assistant").split(",").map((s) => s.trim()).filter(Boolean);
  const roleSet = new Set(roleList.map((r) => String(r).toLowerCase()));
  const matchAllRoles = roleSet.has("all");

  const queryRegex = getCompiledRegex(query);
  const isPlainLiteral = Boolean(query && /^[A-Za-z0-9_ -]+$/.test(query));

  const parsedMaxOutput = Number(maxOutputChars);
  const hasExplicitMaxOutput = Number.isFinite(parsedMaxOutput) && parsedMaxOutput > 0;
  const effectiveCeiling = hasExplicitMaxOutput
    ? Math.min(MAX_DEEP_OUTPUT_CHARS, Math.floor(parsedMaxOutput))
    : isFullRender
      ? MAX_DEEP_OUTPUT_CHARS
      : INLINE_SAFE_CHARS;

  const hasExplicitStart =
    startStep !== undefined &&
    startStep !== null &&
    Number.isFinite(Number(startStep)) &&
    Number(startStep) >= 0;
  const hasExplicitEnd =
    endStep !== undefined &&
    endStep !== null &&
    Number.isFinite(Number(endStep)) &&
    Number(endStep) >= 0;
  const hasExplicitStepRange =
    hasExplicitStart &&
    hasExplicitEnd &&
    Number(endStep) >= Number(startStep);
  const maxRangeCap = isFullRender || (hasExplicitMaxOutput && effectiveCeiling > MAX_OUTPUT_CHARS) ? 5000 : 500;
  const rangeSpan = hasExplicitStepRange
    ? Math.min(maxRangeCap, Math.floor(Number(endStep)) - Math.floor(Number(startStep)) + 1)
    : 0;
  const baseDefaultMax = isFullRender ? 500 : (summaryOnly ? 100 : (normalizedField ? 25 : 5));
  const defaultMaxResults = hasExplicitStepRange ? Math.max(baseDefaultMax, rangeSpan) : baseDefaultMax;
  const parsedMax = Number(maxResults);
  const effectiveMaxResults = Number.isFinite(parsedMax) && parsedMax > 0 ? Math.floor(parsedMax) : defaultMaxResults;

  const parsedLastTurns = Number(lastTurns);
  const effectiveLastTurns = Number.isFinite(parsedLastTurns) && parsedLastTurns > 0 ? Math.floor(parsedLastTurns) : 0;

  // Ring buffer capacity must hold all steps within the last N dialogue turns, never collapsing turns to steps
  const ringCap = effectiveLastTurns > 0
    ? Math.max(effectiveMaxResults, effectiveLastTurns * 25, 200)
    : effectiveMaxResults;

  const compactRing = new CircularRingBuffer(ringCap);
  const userTurnStepRing = effectiveLastTurns > 0 ? new CircularRingBuffer(effectiveLastTurns) : null;
  const workerTurnStepRing = effectiveLastTurns > 0 ? new CircularRingBuffer(effectiveLastTurns) : null;
  const plannerTurnStepRing = effectiveLastTurns > 0 ? new CircularRingBuffer(effectiveLastTurns) : null;

  // PT-SVC-001: Collect candidate truncated step indices in a Set during the compact pass,
  // then perform at most ONE streaming pass over `transcript_full.jsonl` afterward.
  const truncatedCandidateSteps = new Set();
  const hydratedMatchesRing = new CircularRingBuffer(ringCap);
  const fullHydratedItems = new WeakSet();
  let totalHydratedMatches = 0;

  let compactMatchedCount = 0;
  let lineOrdinal = 0;
  let fileStream;
  let rl;

  try {
    fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
    rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineOrdinal++;

      // PERF-12: Raw-line prefilter for plain literal queries, BUT never skip truncated lines in mode="auto" or turn-anchor lines when lastTurns is set
      const mayHaveTruncatedTail = mode === "auto" && Boolean(queryRegex) && line.includes('"truncated_fields"');
      const lineMatchesPrefilter = !isPlainLiteral || queryRegex.test(line) || mayHaveTruncatedTail;
      const mayBeTurnAnchor =
        effectiveLastTurns > 0 &&
        (line.includes('"USER_INPUT"') ||
          line.includes('"SYSTEM_MESSAGE"') ||
          line.includes('"SYSTEM"') ||
          line.includes('"PLANNER_RESPONSE"'));
      if (!lineMatchesPrefilter && !mayBeTurnAnchor) continue;

      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }

      const stepIdx = item.step_index !== undefined ? item.step_index : lineOrdinal;
      if (item.step_index === undefined) item._ordinal = lineOrdinal;

      if (effectiveLastTurns > 0) {
        if (item.type === "USER_INPUT") {
          userTurnStepRing.push(stepIdx);
        } else if (isSubstantiveWorkerPromptItem(item)) {
          workerTurnStepRing.push(stepIdx);
        } else if (item.type === "PLANNER_RESPONSE") {
          plannerTurnStepRing.push(stepIdx);
        }
      }

      if (!lineMatchesPrefilter) continue;

      if (startStep !== undefined && stepIdx < Number(startStep)) continue;
      if (endStep !== undefined && stepIdx > Number(endStep)) continue;

      const hasTruncatedFields = Array.isArray(item.truncated_fields) && item.truncated_fields.length > 0;
      const roleMayBeTruncated = !matchAllRoles && roleSet.has("tool") && hasTruncatedFields && item.truncated_fields.includes("tool_calls");
      const roleMatched = itemMatchesRole(item, roleSet, matchAllRoles);

      if (!roleMatched && !(mode === "auto" && roleMayBeTruncated)) {
        continue;
      }

      const matchedCompact = roleMatched && itemMatchesQuery(item, queryRegex);
      if (matchedCompact) {
        compactMatchedCount++;
        compactRing.push(item);
      } else if (
        mode === "auto" &&
        (queryRegex || roleMayBeTruncated) &&
        hasTruncatedFields &&
        item.step_index !== undefined &&
        filePath !== fullSiblingPath
      ) {
        truncatedCandidateSteps.add(item.step_index);
      }
    }
  } catch (err) {
    const msg = `Error streaming transcript: ${err.message}`;
    return { isError: true, text: msg, error: msg };
  } finally {
    if (rl) rl.close();
    if (fileStream) fileStream.destroy();
  }

  // Compute dialogue-turn cutoff if lastTurns > 0 (prefer USER_INPUT anchors, then promptless worker SYSTEM_MESSAGE prompts, then PLANNER_RESPONSE)
  let minTurnStep = 0;
  const activeTurnRing =
    userTurnStepRing && userTurnStepRing.count > 0
      ? userTurnStepRing
      : workerTurnStepRing && workerTurnStepRing.count > 0
        ? workerTurnStepRing
        : plannerTurnStepRing;
  if (activeTurnRing && activeTurnRing.count > 0) {
    minTurnStep = activeTurnRing.toArray()[0];
  }

  const compactItems = compactRing
    .toArray()
    .filter((it) => (it.step_index !== undefined ? it.step_index : (it._ordinal || 0)) >= minTurnStep)
    .sort((a, b) => (a.step_index !== undefined ? a.step_index : (a._ordinal || 0)) - (b.step_index !== undefined ? b.step_index : (b._ordinal || 0)));

  const candidateSet = new Set();
  for (const idx of truncatedCandidateSteps) {
    if (minTurnStep <= 0 || idx >= minTurnStep) candidateSet.add(idx);
  }

  const needsFullRenderHydration = Boolean(!summaryOnly || effectiveFullArgs || normalizedField || isFullRender);
  const compactHydrateSet = new Set();
  if (mode === "auto" && needsFullRenderHydration && fullSiblingPath && filePath !== fullSiblingPath) {
    for (const it of compactItems.slice(-effectiveMaxResults)) {
      if (it.step_index === undefined) continue;
      const hasTruncated = Array.isArray(it.truncated_fields) && it.truncated_fields.length > 0;
      const needsFullTools = (effectiveFullArgs || normalizedField || isFullRender) && Array.isArray(it.tool_calls) && it.tool_calls.length > 0;
      if (hasTruncated || needsFullTools || normalizedField || isFullRender) {
        compactHydrateSet.add(it.step_index);
      }
    }
  }

  // Single streaming pass over `transcript_full.jsonl` for both truncated-tail candidates and full-render hydration
  const compactFullMap = new Map();
  if (
    mode === "auto" &&
    (candidateSet.size > 0 || compactHydrateSet.size > 0) &&
    fullSiblingPath &&
    filePath !== fullSiblingPath &&
    fs.existsSync(fullSiblingPath)
  ) {
    let fullStream;
    let fullRl;
    try {
      fullStream = fs.createReadStream(fullSiblingPath, { encoding: "utf-8" });
      fullRl = readline.createInterface({ input: fullStream, crlfDelay: Infinity });
      for await (const line of fullRl) {
        if (!line.trim()) continue;
        let fullItem;
        try {
          fullItem = JSON.parse(line);
        } catch {
          continue;
        }
        const sIdx = fullItem.step_index;
        if (candidateSet.has(sIdx)) {
          candidateSet.delete(sIdx);
          if (itemMatchesRole(fullItem, roleSet, matchAllRoles) && itemMatchesQuery(fullItem, queryRegex)) {
            totalHydratedMatches++;
            fullHydratedItems.add(fullItem);
            hydratedMatchesRing.push(fullItem);
          }
        }
        if (compactHydrateSet.has(sIdx)) {
          compactHydrateSet.delete(sIdx);
          compactFullMap.set(sIdx, fullItem);
          fullHydratedItems.add(fullItem);
        }
        if (candidateSet.size === 0 && compactHydrateSet.size === 0) break;
      }
    } catch {} finally {
      if (fullRl) fullRl.close();
      if (fullStream) fullStream.destroy();
    }
  }

  const tailItems = hydratedMatchesRing
    .toArray()
    .filter((it) => (it.step_index !== undefined ? it.step_index : (it._ordinal || 0)) >= minTurnStep);

  const mergedMap = new Map();
  for (const it of compactItems) {
    const key = it.step_index !== undefined ? it.step_index : `ord:${it._ordinal}`;
    mergedMap.set(key, it.step_index !== undefined && compactFullMap.has(it.step_index) ? compactFullMap.get(it.step_index) : it);
  }
  for (const it of tailItems) {
    const key = it.step_index !== undefined ? it.step_index : `ord:${it._ordinal}`;
    mergedMap.set(key, it);
  }

  const mergedItems = Array.from(mergedMap.values()).sort((a, b) => {
    const idxA = a.step_index !== undefined ? a.step_index : (a._ordinal || 0);
    const idxB = b.step_index !== undefined ? b.step_index : (b._ordinal || 0);
    return idxA - idxB;
  });

  const matchedCount = effectiveLastTurns > 0
    ? mergedItems.length
    : compactMatchedCount + totalHydratedMatches;

  if (mergedItems.length === 0) {
    const msg = `No matching steps found in transcript for \`${convId}\` (query: "${query || "*"}", roles: [${Array.from(roleSet).join(", ")}]).`;
    return {
      convId,
      filePath,
      mode,
      query: query || null,
      roles: Array.from(roleSet),
      matchedCount: 0,
      displayedCount: 0,
      clamped: false,
      items: [],
      text: msg
    };
  }

  const finalItems = mergedItems.length > effectiveMaxResults
    ? mergedItems.slice(-effectiveMaxResults)
    : mergedItems;
  const maxResultsTruncated = matchedCount > finalItems.length;

  const baseFileIsFull = filePath.endsWith("transcript_full.jsonl");
  const normalizedFinalItems = finalItems.map((it) =>
    normalizeStepRecordForOutput(it, { fromCompact: !(baseFileIsFull || fullHydratedItems.has(it)) })
  );

  const getItemStepNum = (it) => (it && it.step_index !== undefined ? Number(it.step_index) : Number(it?._ordinal || 0));
  const footerReserve = 240;
  const effectiveBudget = Math.max(0, effectiveCeiling - footerReserve);

  if (summaryOnly) {
    const utcDates = new Set();
    for (const it of normalizedFinalItems) {
      if (typeof it.created_at === "string" && /^\d{4}-\d{2}-\d{2}T/.test(it.created_at)) {
        utcDates.add(it.created_at.slice(0, 10));
      }
    }
    const singleUtcDate = utcDates.size === 1 ? Array.from(utcDates)[0] : null;
    const contentPreviewBudget = isFullRender ? 160 : 120;
    const thinkingPreviewBudget = isFullRender ? 120 : 80;
    const summaryFullArgs = Boolean(explicitFullArgs);

    const buildSummaryHeader = (shownCount) => [
      `## Transcript Query Summary: \`${convId}\``,
      `- Filter: query=${query ? `"${query}"` : "NONE"}, roles=[${Array.from(roleSet).join(", ")}], mode=${mode}${singleUtcDate ? `, date=${singleUtcDate} UTC` : ""}`,
      `- Matched Steps: ${matchedCount} (showing ${shownCount} in compact summary mode)`,
      "",
      "---",
      ""
    ].join("\n");

    const headerBytes = utf8ByteLength(buildSummaryHeader(normalizedFinalItems.length)) + 12;

    const formatSummaryEntry = (it) => {
      const stepNum = getItemStepNum(it);
      const step = it.step_index ?? "?";
      const role = normalizeRoleLabel(it);
      const cleanIso = it.created_at ? String(it.created_at).replace(/\.\d+Z$/, "Z") : null;
      let time = "";
      if (cleanIso) {
        time = singleUtcDate && cleanIso.startsWith(singleUtcDate + "T")
          ? ` (${cleanIso.slice(singleUtcDate.length + 1)})`
          : ` (${cleanIso})`;
      }
      const isErr = isStructuredErrorItem(it);
      const errorBadge = isErr ? " [ERROR]" : "";

      const parts = [];
      if (it.content) {
        const itemTypeUpper = String(it.type || "").toUpperCase();
        let summaryInput = it.content;
        if (itemTypeUpper === "USER_INPUT") {
          summaryInput = stripTrailingClosingTags(
            String(it.content).replace(/^\s*<USER_REQUEST>\s*(?:\r?\n|$)/i, ""),
            ["</user_request>"]
          );
        } else if (itemTypeUpper !== "PLANNER_RESPONSE" && itemTypeUpper !== "SUBAGENT_RESPONSE") {
          summaryInput = stripSummaryStepBoilerplate(it.content, { stripWrappers: true, preserveSpillTag: true });
        }
        const preview = cleanMessageContent(summaryInput, contentPreviewBudget, { truncationStyle: "ellipsis", full: false })
          .replace(/\s+/g, " ")
          .trim();
        if (preview) parts.push(preview);
      }
      if (includeThinking && it.thinking) {
        const thinkPreview = cleanMessageContent(it.thinking, thinkingPreviewBudget, { truncationStyle: "ellipsis", full: false })
          .replace(/\s+/g, " ")
          .trim();
        if (thinkPreview) parts.push(`[thinking: ${thinkPreview}]`);
      }
      const hasTools = Array.isArray(it.tool_calls) && it.tool_calls.length > 0;
      if (hasTools && (effectiveIncludeTools || roleSet.has("tool") || !it.content)) {
        parts.push(
          `[tools: ${formatCompactToolList(it.tool_calls, {
            fullArgs: summaryFullArgs,
            collapseDuplicates: !summaryFullArgs,
            maxTotalChars: summaryFullArgs ? (isFullRender ? 0 : 1200) : 560
          })}]`
        );
      }

      const summaryBody = parts.join(" ") || "(empty)";
      const summaryItem = {
        step_index: stepNum,
        type: it.type || "UNKNOWN",
        role: String(role || "unknown").toLowerCase(),
        created_at: cleanIso,
        status: isErr ? "ERROR" : "OK",
        summary: isErr ? `[ERROR] ${summaryBody}` : summaryBody
      };
      const line = `- **[Step ${step} | ${role}]**${errorBadge}${time}: ${summaryBody}`;
      return { block: line, item: summaryItem };
    };

    const {
      blocks: summaryLines,
      displayed: summaryItems,
      clamped
    } = clampRenderedBlocksToBudget(normalizedFinalItems, {
      direction: maxResultsTruncated ? "backward" : "forward",
      headerBytes,
      effectiveBudget,
      sepBytes: 1,
      countFirstSep: true,
      overflowReserve: 8,
      overflowSuffix: "...",
      render: formatSummaryEntry
    });

    const firstDisplayed = summaryItems[0];
    const lastFinal = normalizedFinalItems[normalizedFinalItems.length - 1];
    let nextCursor = null;
    if (maxResultsTruncated && firstDisplayed) {
      const firstShownStep = getItemStepNum(firstDisplayed);
      const minStartBound = hasExplicitStart ? Math.floor(Number(startStep)) : 0;
      if (firstShownStep > minStartBound) {
        nextCursor = minStartBound > 0
          ? { start: minStartBound, end: firstShownStep - 1 }
          : { end: firstShownStep - 1 };
      }
    } else if (clamped && summaryItems.length < normalizedFinalItems.length) {
      const nextUnshown = normalizedFinalItems[summaryItems.length];
      const nextStart = getItemStepNum(nextUnshown);
      const nextEnd = hasExplicitEnd ? Math.floor(Number(endStep)) : getItemStepNum(lastFinal);
      nextCursor = { start: nextStart, end: nextEnd };
    }

    let output = buildSummaryHeader(summaryLines.length) + summaryLines.join("\n");
    const isTruncated = clamped || maxResultsTruncated || matchedCount > summaryLines.length;
    if (clamped) {
      const ceilLabel = effectiveCeiling <= INLINE_SAFE_CHARS
        ? "~9 KB inline ceiling"
        : `${Math.round(effectiveCeiling / 1024)} KB ceiling`;
      const hintParts = ["--full", "--out <path>"];
      if (nextCursor && nextCursor.start !== undefined && nextCursor.end !== undefined) {
        hintParts.push(`--start ${nextCursor.start} --end ${nextCursor.end}`);
      } else if (nextCursor && nextCursor.end !== undefined) {
        hintParts.push(`--end ${nextCursor.end}`);
      }
      const shownLabel = maxResultsTruncated
        ? `showing last ${summaryLines.length} of ${matchedCount}`
        : `showing ${summaryLines.length} of ${matchedCount}`;
      output += `\n\n... [Truncated: reached ${ceilLabel} (${shownLabel} matching steps); pass ${hintParts.join(" or ")} to inspect remaining steps] ...`;
    } else if (isTruncated) {
      const cursorHint = nextCursor && nextCursor.end !== undefined
        ? (nextCursor.start !== undefined ? `, --start ${nextCursor.start} --end ${nextCursor.end}` : `, --end ${nextCursor.end}`)
        : "";
      output += `\n\n... [Truncated: showing last ${summaryLines.length} of ${matchedCount} matching steps; pass --limit <N>${cursorHint}, or --start/--end to inspect earlier steps] ...`;
    }

    return {
      convId,
      filePath,
      mode,
      query: query || null,
      roles: Array.from(roleSet),
      matchedCount,
      displayedCount: summaryLines.length,
      clamped: isTruncated,
      nextCursor,
      items: summaryItems,
      _summaryDirection: maxResultsTruncated ? "backward" : "forward",
      text: output
    };
  }

  const buildResultsHeader = (shownCount) => [
    `## Transcript Query Results: \`${convId}\``,
    `- Filter: query=${query ? `"${query}"` : "NONE"}, roles=[${Array.from(roleSet).join(", ")}], mode=${mode}`,
    `- Matched Steps: ${matchedCount} (showing ${shownCount})`,
    "",
    "---",
    ""
  ].join("\n");

  const resHeaderBytes = utf8ByteLength(buildResultsHeader(normalizedFinalItems.length)) + 12;
  const maxPerItemFieldChars = Math.max(80, effectiveCeiling - resHeaderBytes - footerReserve - 40);
  const {
    blocks,
    displayed: displayedItems,
    clamped
  } = clampRenderedBlocksToBudget(normalizedFinalItems, {
    direction: "backward",
    headerBytes: resHeaderBytes,
    effectiveBudget,
    render: (item) => formatTranscriptItem(item, {
      includeThinking,
      includeToolCalls: effectiveIncludeTools || roleSet.has("tool"),
      fullArgs: effectiveFullArgs,
      explicitFullArgs,
      full: isFullRender,
      field: normalizedField,
      maxFieldChars: isFullRender ? effectiveCeiling : Math.min(MAX_FIELD_CHARS, maxPerItemFieldChars),
      maxContentChars: isFullRender ? effectiveCeiling : Math.min(MAX_TURN_CHARS, maxPerItemFieldChars),
      maxThinkingChars: isFullRender ? effectiveCeiling : Math.min(4000, maxPerItemFieldChars),
      stripBoilerplate: !isFullRender
    })
  });

  const isTruncated = clamped || maxResultsTruncated || matchedCount > blocks.length;
  const firstShownStep = displayedItems[0] ? getItemStepNum(displayedItems[0]) : 0;
  const nextCursor = isTruncated && firstShownStep > 0 ? { end: firstShownStep - 1 } : null;

  let output = buildResultsHeader(blocks.length) + blocks.join("\n\n---\n\n");
  if (clamped) {
    const ceilLabel = effectiveCeiling <= INLINE_SAFE_CHARS
      ? "~9 KB inline ceiling"
      : `${Math.round(effectiveCeiling / 1024)} KB ceiling`;
    const endHint = nextCursor ? `, or --end ${nextCursor.end}` : "";
    output += `\n\n... [Truncated: reached ${ceilLabel} (showing last ${blocks.length} of ${matchedCount} matching steps); pass --full, --out <path>${endHint} to inspect earlier steps] ...`;
  } else if (isTruncated) {
    const endHint = nextCursor ? `, --end ${nextCursor.end}` : "";
    output += `\n\n... [Truncated: showing last ${blocks.length} of ${matchedCount} matching steps; pass --limit <N>${endHint}, or --start/--end to inspect earlier steps] ...`;
  }

  return {
    convId,
    filePath,
    mode,
    query: query || null,
    roles: Array.from(roleSet),
    matchedCount,
    displayedCount: blocks.length,
    clamped: isTruncated,
    nextCursor,
    items: displayedItems,
    text: output
  };
}

function resolveMultiTranscriptTargets({
  normalizedIds = [],
  trimmedParent = null,
  subcommand = "export",
  fail
}) {
  let displayParentFilter = trimmedParent;
  const targets = [];

  if (trimmedParent) {
    let resolvedParentId = trimmedParent;
    if (trimmedParent.toLowerCase() === "current") {
      const envId = process.env.GEMINI_CONVERSATION_ID && process.env.GEMINI_CONVERSATION_ID.trim();
      if (!envId) {
        return { error: fail("Cannot resolve '--parent current': GEMINI_CONVERSATION_ID is not set. Pass an explicit parent UUID.") };
      }
      resolvedParentId = envId;
    }
    displayParentFilter = resolvedParentId;

    const access = verifyTranscriptCoreAccess({
      targetConvId: `parent:${resolvedParentId}`,
      subcommand,
      consumeGrant: true,
      isImplicitCurrent: false
    });
    if (!access.allowed) return { error: fail(access.error, false) };

    const listed = listTranscriptConversationsInternal({ limit: 500, parentId: resolvedParentId, includeLineage: true });
    if (listed.conversations.length === 0) {
      return { error: fail(`No child conversations found for parent '${resolvedParentId}'.`, false) };
    }

    const brainDirs = getBrainDirs();
    for (const item of listed.conversations) {
      const candidatePath = resolveTargetFileInBrainDirs(brainDirs, item.conversationId);
      if (candidatePath.error) return { error: fail(candidatePath.error, false) };
      targets.push({ convId: item.conversationId, filePath: candidatePath.filePath });
    }
    return { targets, displayParentFilter };
  }

  if (normalizedIds.some((id) => id.toLowerCase() === "current")) {
    return { error: fail(`Placeholder 'current' cannot be combined with multiple '--id' values in 'transcript ${subcommand}'.`) };
  }
  const grantKey = `multi:${[...normalizedIds].sort().join(",")}`;
  const access = verifyTranscriptCoreAccess({
    targetConvId: grantKey,
    subcommand,
    consumeGrant: true,
    isImplicitCurrent: false
  });
  if (!access.allowed) return { error: fail(access.error, false) };

  const brainDirs = getBrainDirs();
  for (const id of normalizedIds) {
    const candidatePath = resolveTargetFileInBrainDirs(brainDirs, id);
    if (candidatePath.error) return { error: fail(candidatePath.error, false) };
    targets.push({ convId: id, filePath: candidatePath.filePath });
  }
  return { targets, displayParentFilter };
}

function classifyHealthStatus(pollingViolations, userTurns) {
  if (pollingViolations > 3) return "CRITICAL (Active Polling Loops Detected)";
  if (pollingViolations > 0 && userTurns > 40) return "WARNING (High Turn Budget & Polling Violations Detected)";
  if (pollingViolations > 0) return "WARNING (Polling Violations Detected)";
  if (userTurns > 40) return "WARNING (High Turn Budget)";
  return "HEALTHY";
}

async function analyzeSingleTranscriptHealth(filePath, convId) {
  const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let totalSteps = 0;
  let userTurns = 0;
  let modelTurns = 0;
  let toolCalls = 0;
  let pollingViolations = 0;
  let legalChecks = 0;
  let totalBytes = 0;
  let corruptLines = 0;

  // Simulated per-task & per-subagent hook backoff ledger state across transcript timestamps
  const taskBackoff = new Map();
  const fallbackBucket = { pollCount: 0, lastPollTime: 0, pendingWatchdog: null };
  const getBackoffBucket = (key) => {
    if (!key) return fallbackBucket;
    if (!taskBackoff.has(key)) {
      taskBackoff.set(key, { pollCount: 0, lastPollTime: 0, pendingWatchdog: null });
    }
    return taskBackoff.get(key);
  };

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      totalSteps++;
      totalBytes += line.length;

      if (totalSteps > MAX_HEALTH_LINES) {
        break;
      }

      const hasToolCalls = line.includes('"tool_calls"');
      const head = line.slice(0, 300);
      const isUserInput = head.includes('"type":"USER_INPUT"');
      const isPlannerResp = head.includes('"type":"PLANNER_RESPONSE"');

      if (!hasToolCalls && (isUserInput || isPlannerResp)) {
        if (isUserInput) userTurns++;
        else modelTurns++;
        continue;
      }

      try {
        const item = JSON.parse(line);
        if (item.type === "USER_INPUT") userTurns++;
        if (item.type === "PLANNER_RESPONSE") modelTurns++;

        const stepTsMs = item.created_at ? Date.parse(item.created_at) : NaN;
        const hasValidTs = Number.isFinite(stepTsMs);

        if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
          toolCalls += item.tool_calls.length;
          for (const tc of item.tool_calls) {
            const name = tc.tool_name || tc.name;
            const tcArgs = tc.args || tc.arguments || {};

            if (name === "manage_task") {
              const action = String(tcArgs.Action || tcArgs.action || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
              if (action === "status") {
                const bucket = getBackoffBucket(extractTaskBackoffKey("manage_task", tcArgs));
                const stepRes = stepBackoffState("manage_task", bucket, { nowMs: stepTsMs, hasValidTs });
                if (stepRes.violation) pollingViolations++;
                else legalChecks++;
              }
            } else if (name === "schedule" && isSwarmPollSchedule(tcArgs)) {
              pollingViolations++;
            } else if (name === "schedule" && isSubagentPollSchedule(tcArgs)) {
              const bucket = getBackoffBucket(extractTaskBackoffKey("schedule", tcArgs));
              const durationSec = Number(tcArgs.DurationSeconds || tcArgs.durationSeconds || tcArgs.duration || 0);
              const stepRes = stepBackoffState("subagent_schedule", bucket, {
                durationSec,
                hasValidCond: hasValidSubagentTimerCondition(tcArgs),
                nowMs: stepTsMs,
                hasValidTs
              });
              if (stepRes.violation) pollingViolations++;
              else legalChecks++;
            } else if (name === "schedule" && isRemoteCiPollSchedule(tcArgs)) {
              const bucket = getBackoffBucket(extractRemoteCiBackoffKey(tcArgs));
              const durationSec = Number(tcArgs.DurationSeconds || tcArgs.durationSeconds || tcArgs.duration || 0);
              const stepRes = stepBackoffState("remote_ci_schedule", bucket, {
                durationSec,
                nowMs: stepTsMs,
                hasValidTs
              });
              if (stepRes.violation) pollingViolations++;
              else legalChecks++;
            } else if (name === "schedule" && isTaskPollSchedule(tcArgs)) {
              const bucket = getBackoffBucket(extractTaskBackoffKey("schedule", tcArgs));
              const durationSec = Number(tcArgs.DurationSeconds || tcArgs.durationSeconds || tcArgs.duration || 0);
              const stepRes = stepBackoffState("task_schedule", bucket, {
                durationSec,
                hasValidCond: hasValidTaskTimerCondition(tcArgs),
                nowMs: stepTsMs,
                hasValidTs
              });
              if (stepRes.violation) pollingViolations++;
              else legalChecks++;
            }
          }
        }
      } catch {
        corruptLines++;
      }
    }
  } catch (err) {
    const msg = `Failed to inspect transcript: ${err.message}`;
    return { isError: true, text: msg, error: msg };
  } finally {
    rl.close();
    fileStream.destroy();
  }

  const kb = (totalBytes / 1024).toFixed(1);
  return {
    convId,
    filePath,
    status: classifyHealthStatus(pollingViolations, userTurns),
    metrics: {
      totalSteps,
      userTurns,
      modelTurns,
      toolCalls,
      pollingViolations,
      legalChecks,
      totalBytes,
      kb: Number(kb),
      corruptLines
    },
    kbLabel: kb
  };
}

/**
 * Unified Context Health & Proportional Backoff Evaluator (ACS-MCP-01, ACS-HOOK-12).
 * Supports single-session checks as well as multi-ID (`conversationIds`) and `--parent` cohorts.
 */
export async function checkContextHealth({
  conversationId,
  conversationIds = [],
  parentId = null,
  transcriptPath,
  filePath: explicitFile,
  allowExternalPaths = false
} = {}) {
  const failHealth = (msg, consume = true) => {
    if (consume) consumeTranscriptAccessGrant({ subcommand: "health" });
    return { isError: true, text: msg, error: msg };
  };

  const rawIds = [
    ...(Array.isArray(conversationIds) ? conversationIds : (conversationIds ? [conversationIds] : [])),
    ...(conversationId ? [conversationId] : [])
  ];
  const normalizedIds = Array.from(
    new Set(
      rawIds
        .flatMap((id) => String(id || "").split(","))
        .map((id) => id.trim())
        .filter(Boolean)
    )
  );
  const trimmedParent = parentId !== null && parentId !== undefined ? String(parentId).trim() : null;
  if (parentId !== null && parentId !== undefined && trimmedParent === "") {
    return failHealth("Flag '--parent' must be a non-empty conversation ID or 'current'.");
  }
  const hasExplicitFile = (explicitFile !== null && explicitFile !== undefined && String(explicitFile).trim() !== "") || Boolean(transcriptPath);
  if (hasExplicitFile && (trimmedParent || normalizedIds.length > 0)) {
    return failHealth("Conflicting selectors for 'transcript health': pass only one of '--id', '--parent', or '--file'.");
  }
  if (trimmedParent && normalizedIds.length > 0) {
    return failHealth("Conflicting selectors for 'transcript health': pass either '--parent' or '--id', not both.");
  }

  // Multi-ID or --parent cohort health mode
  if (trimmedParent || normalizedIds.length > 1) {
    const multi = resolveMultiTranscriptTargets({
      normalizedIds,
      trimmedParent,
      subcommand: "health",
      fail: failHealth
    });
    if (multi.error) return multi.error;

    const sessions = [];
    const totals = {
      totalSteps: 0,
      userTurns: 0,
      modelTurns: 0,
      toolCalls: 0,
      pollingViolations: 0,
      legalChecks: 0,
      totalBytes: 0,
      kb: 0,
      corruptLines: 0
    };
    let maxUserTurns = 0;

    for (const target of multi.targets) {
      const analyzed = await analyzeSingleTranscriptHealth(target.filePath, target.convId);
      if (analyzed.isError) return analyzed;
      sessions.push({
        convId: analyzed.convId,
        filePath: analyzed.filePath,
        status: analyzed.status,
        metrics: analyzed.metrics
      });
      totals.totalSteps += analyzed.metrics.totalSteps;
      totals.userTurns += analyzed.metrics.userTurns;
      totals.modelTurns += analyzed.metrics.modelTurns;
      totals.toolCalls += analyzed.metrics.toolCalls;
      totals.pollingViolations += analyzed.metrics.pollingViolations;
      totals.legalChecks += analyzed.metrics.legalChecks;
      totals.totalBytes += analyzed.metrics.totalBytes;
      totals.corruptLines += analyzed.metrics.corruptLines;
      if (analyzed.metrics.userTurns > maxUserTurns) maxUserTurns = analyzed.metrics.userTurns;
    }

    const totalKbLabel = (totals.totalBytes / 1024).toFixed(1);
    totals.kb = Number(totalKbLabel);
    const overallStatus = classifyHealthStatus(totals.pollingViolations, maxUserTurns);
    const rtkInfo = findExistingRtk({ silent: true });
    const scopeLabel = multi.displayParentFilter
      ? `parent=\`${multi.displayParentFilter}\``
      : `explicit \`--id\` list (${sessions.length} sessions)`;

    const reportLines = [
      `### Cohort Context Health Report: ${overallStatus} (${sessions.length} session${sessions.length === 1 ? "" : "s"})`,
      `- Scope: ${scopeLabel}`,
      `- Totals: Steps=${totals.totalSteps}, User Turns=${totals.userTurns}, Assistant=${totals.modelTurns}, Tool Calls=${totals.toolCalls}, Busy-Polling=${totals.pollingViolations}, Legal Checks=${totals.legalChecks}, Size=${totalKbLabel} KB`,
      `- RTK Command Optimizer: ${rtkInfo ? `Active (${rtkInfo.version})` : "Missing (run agy-context setup)"}`,
      "",
      "| Session | Status | Steps | User | Asst | Tools | Violations | Size (KB) |",
      "| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |"
    ];
    for (const s of sessions) {
      const shortStatus = s.status.startsWith("CRITICAL")
        ? "CRITICAL"
        : s.status.startsWith("WARNING")
          ? "WARNING"
          : "HEALTHY";
      reportLines.push(
        `| \`${s.convId}\` | ${shortStatus} | ${s.metrics.totalSteps} | ${s.metrics.userTurns} | ${s.metrics.modelTurns} | ${s.metrics.toolCalls} | ${s.metrics.pollingViolations} | ${(s.metrics.totalBytes / 1024).toFixed(1)} |`
      );
    }

    const reportText = reportLines.join("\n");
    return {
      parentFilter: multi.displayParentFilter || null,
      sessionCount: sessions.length,
      status: overallStatus,
      totals,
      sessions,
      rtkInfo: rtkInfo || null,
      reportText,
      text: reportText
    };
  }

  // Single-session mode (100% backward-compatible schema)
  const singleId = normalizedIds[0];
  const resolved = explicitFile
    ? resolveTranscriptPath(null, "compact", { explicitFile, allowExternalPaths, subcommand: "health" })
    : resolveTranscriptPath(transcriptPath || singleId || "current", "compact", {
        allowExternalPaths: allowExternalPaths || Boolean(transcriptPath),
        subcommand: "health"
      });

  if (resolved.error) {
    return { isError: true, text: resolved.error, error: resolved.error, candidates: resolved.candidates };
  }

  const analyzed = await analyzeSingleTranscriptHealth(resolved.filePath, resolved.convId);
  if (analyzed.isError) return analyzed;

  const { convId, filePath, status: healthStatus, metrics, kbLabel: kb } = analyzed;
  const rtkInfo = findExistingRtk({ silent: true });
  const reportLines = [
    `### Context Health Report: ${healthStatus}`,
    "",
    "#### [Active Session Metrics]",
    `- Total Steps: ${metrics.totalSteps}`,
    `- User Turns: ${metrics.userTurns}`,
    `- Assistant Responses: ${metrics.modelTurns}`,
    `- Tool Calls: ${metrics.toolCalls}`,
    `- Detected Busy-Polling Events: ${metrics.pollingViolations}`,
    `- Legal Backoff-Compliant Checks/Watchdogs: ${metrics.legalChecks}`,
    `- Approximate Raw Transcript Size: ${kb} KB`
  ];

  if (metrics.corruptLines > 0) {
    reportLines.push(`- Corrupted/Unparsed Lines: ${metrics.corruptLines}`);
  }

  reportLines.push("");
  reportLines.push("#### [Local RTK Environment]");
  reportLines.push(`- RTK Command Optimizer: ${rtkInfo ? `Active (${rtkInfo.version})` : "Missing (run agy-context setup)"}`);
  reportLines.push(`- Note: Lifetime token gains from 'rtk gain' represent cumulative machine-wide host savings, not single-session metrics.`);
  reportLines.push("");

  if (metrics.pollingViolations > 0) {
    reportLines.push("⚠️ Recommendation: Background polling violations detected! Default to Pure Yield for local background tasks (end turn; no 'schedule' timer or status card; await <SYSTEM_MESSAGE>), avoid premature manage_task(status) or /swarm schedule polling, and load 'context-governance' only if you need an opt-in conditioned stall watchdog.");
  }
  if (metrics.userTurns >= 35) {
    reportLines.push("💡 Recommendation: Turn budget approaching threshold. Summarize progress and continue in a fresh conversation to preserve context.");
  }
  if (metrics.pollingViolations === 0 && metrics.userTurns < 35 && healthStatus === "HEALTHY") {
    reportLines.push("✓ Context footprint is well-managed.");
  }

  return {
    convId,
    filePath,
    status: healthStatus,
    metrics,
    rtkInfo: rtkInfo || null,
    reportText: reportLines.join("\n"),
    text: reportLines.join("\n")
  };
}

function redactSensitiveSecrets(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/gi, "[Embedded Media/Binary Omitted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED]");
}

const EXPORT_OMITTED_ARG_KEYS = new Set([
  ...LARGE_BODY_ARG_KEYS,
  "ReplacementChunks",
  "replacementChunks"
]);

function sanitizeToolCallsForExport(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
  return toolCalls.map((tc) => {
    if (!tc || typeof tc !== "object") return tc;
    const rawArgs = tc.args || tc.arguments;
    if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return tc;
    const safeArgs = {};
    for (const [k, v] of Object.entries(rawArgs)) {
      if (EXPORT_OMITTED_ARG_KEYS.has(k)) {
        safeArgs[k] = "[omitted]";
      } else if (typeof v === "string") {
        safeArgs[k] = redactSensitiveSecrets(v);
      } else {
        safeArgs[k] = v;
      }
    }
    return {
      ...tc,
      ...(tc.args ? { args: safeArgs } : { arguments: safeArgs })
    };
  });
}

function sanitizeTableCellText(raw, maxLen = 120) {
  if (!raw || typeof raw !== "string") return "";
  let cleaned = cleanMessageContent(raw, Math.max(maxLen * 4, 600), { truncationStyle: "ellipsis" });
  cleaned = redactSensitiveSecrets(cleaned)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length > maxLen) {
    return cleaned.slice(0, Math.max(0, maxLen - 3)).trimEnd() + "...";
  }
  return cleaned;
}

function sanitizeExportContentPreview(item) {
  const raw = typeof item?.content === "string"
    ? item.content
    : item?.content !== undefined && item?.content !== null
      ? JSON.stringify(item.content)
      : "";
  if (!raw.trim()) return "";
  const stripped = stripSummaryStepBoilerplate(raw, { stripWrappers: true, preserveSpillTag: true });
  return sanitizeTableCellText(stripped, 120);
}

async function summarizeTranscriptForSanitizedExport({
  convId,
  filePath,
  startStep,
  endStep,
  maxStepsPerSession = 200,
  collectFromHead = false
}) {
  const lineage = inspectTranscriptLineageFromFile(filePath);
  const fullSiblingPath = resolveFullSiblingPath(filePath);

  const ring = collectFromHead ? null : new CircularRingBuffer(maxStepsPerSession);
  const headItems = collectFromHead ? [] : null;
  let totalSteps = 0;
  let matchingSteps = 0;
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCallCount = 0;
  let errorCount = 0;
  let lineOrdinal = 0;
  let fileStream;
  let rl;

  try {
    fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
    rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      lineOrdinal++;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      totalSteps++;
      const stepIdx = item.step_index !== undefined ? item.step_index : lineOrdinal;
      if (item.step_index === undefined) item._ordinal = lineOrdinal;
      if (item.type === "USER_INPUT") userTurns++;
      if (item.type === "PLANNER_RESPONSE") assistantTurns++;
      if (Array.isArray(item.tool_calls)) toolCallCount += item.tool_calls.length;
      if (isStructuredErrorItem(item)) errorCount++;

      if (startStep !== undefined && stepIdx < Number(startStep)) continue;
      if (endStep !== undefined && stepIdx > Number(endStep)) continue;
      matchingSteps++;
      if (collectFromHead) {
        if (headItems.length < maxStepsPerSession) {
          headItems.push(item);
        }
      } else {
        ring.push(item);
      }
    }
  } finally {
    if (rl) rl.close();
    if (fileStream) fileStream.destroy();
  }

  const selectedItems = collectFromHead ? headItems : ring.toArray();
  const baseFileIsFull = filePath.endsWith("transcript_full.jsonl");
  const hydratedToolSteps = new WeakSet();
  // Hydrate truncated tool_calls from transcript_full.jsonl when needed (never exporting raw thinking/content bodies)
  if (fullSiblingPath && fullSiblingPath !== filePath && fs.existsSync(fullSiblingPath)) {
    const needToolHydration = new Set();
    for (const it of selectedItems) {
      if (
        it.step_index !== undefined &&
        Array.isArray(it.truncated_fields) &&
        it.truncated_fields.includes("tool_calls")
      ) {
        needToolHydration.add(it.step_index);
      }
    }
    if (needToolHydration.size > 0) {
      const fullMap = await batchFindFullSteps(fullSiblingPath, needToolHydration);
      for (const it of selectedItems) {
        if (it.step_index !== undefined && fullMap.has(it.step_index)) {
          const full = fullMap.get(it.step_index);
          if (Array.isArray(full?.tool_calls)) {
            it.tool_calls = full.tool_calls;
            hydratedToolSteps.add(it);
          }
        }
      }
    }
  }

  const rows = selectedItems.map((it) => {
    const step = it.step_index !== undefined ? it.step_index : it._ordinal || "?";
    const role = normalizeRoleLabel(it);
    const isErr = isStructuredErrorItem(it);
    const status = isErr ? "ERROR" : "OK";
    const fromCompactTools = !(baseFileIsFull || hydratedToolSteps.has(it));
    const safeTools = sanitizeToolCallsForExport(it.tool_calls);
    const toolsCompact = safeTools.length > 0
      ? sanitizeTableCellText(formatCompactToolList(safeTools, { fullArgs: false, fromCompact: fromCompactTools }), 140)
      : "—";
    const note = sanitizeExportContentPreview(it) || "—";
    return {
      step,
      role,
      status,
      timestamp: it.created_at ? String(it.created_at).replace(/\.\d+Z$/, "Z") : null,
      tools: toolsCompact,
      summary: note
    };
  });

  return {
    convId,
    sessionKind: lineage.sessionKind,
    parentConvId: lineage.parentConvId,
    rosterName: lineage.rosterName,
    totalSteps,
    matchingSteps,
    displayedSteps: rows.length,
    truncatedSteps: matchingSteps > rows.length,
    userTurns,
    assistantTurns,
    toolCallCount,
    errorCount,
    rows
  };
}

function buildSanitizedExportMarkdown(sessionList, totalSessionsCount, wasClamped, { generatedAt, displayParentFilter }) {
  const outLines = [
    "# Sanitized Transcript Index",
    "",
    `- Generated At: ${generatedAt}`,
    ...(displayParentFilter ? [`- Parent Session Filter: \`${displayParentFilter}\``] : []),
    `- Exported Sessions: ${sessionList.length}${sessionList.length < totalSessionsCount ? ` (of ${totalSessionsCount})` : ""}`,
    "- Transcript Isolation: Sanitized summary index only — raw `.system_generated/` JSONL lines, `thinking` blocks, and full file payloads omitted.",
    "",
    "| Conversation ID | Kind | Roster | Parent | Steps | Tool Calls | Errors |",
    "| --- | --- | --- | --- | ---: | ---: | ---: |"
  ];
  for (const sess of sessionList) {
    const rosterCell = sess.rosterName ? `@${sess.rosterName}` : "—";
    const parentCell = sess.parentConvId ? `\`${sess.parentConvId}\`` : "—";
    outLines.push(
      `| \`${sess.convId}\` | ${sess.sessionKind} | ${rosterCell} | ${parentCell} | ${sess.totalSteps} | ${sess.toolCallCount} | ${sess.errorCount} |`
    );
  }
  for (const sess of sessionList) {
    outLines.push(
      "",
      `## Session \`${sess.convId}\`${sess.rosterName ? ` (@${sess.rosterName})` : ""}`,
      `- Kind: ${sess.sessionKind} | Parent: ${sess.parentConvId || "none"} | Steps Shown: ${sess.displayedSteps} of ${sess.matchingSteps}${sess.truncatedSteps ? " (truncated)" : ""} | Errors: ${sess.errorCount}`,
      "",
      "| Step | Role | Status | Tool Calls | Sanitized Summary |",
      "| ---: | --- | --- | --- | --- |"
    );
    if (sess.rows.length === 0) {
      outLines.push("| — | — | — | — | (no matching steps) |");
    } else {
      for (const row of sess.rows) {
        outLines.push(`| ${row.step} | ${row.role} | ${row.status} | ${row.tools} | ${row.summary} |`);
      }
    }
  }
  let rendered = outLines.join("\n");
  if (wasClamped) {
    rendered += "\n\n... [Sanitized transcript export clamped at safety ceiling; pass --full, --max-chars, --out, or --start/--end/--limit] ...";
  }
  return rendered;
}

function projectExportSessionsWithCounts(sessions, rowCounts, keepTail = false) {
  return rowCounts.map((count, idx) => {
    const sess = sessions[idx];
    const keptRows = keepTail
      ? (count > 0 ? sess.rows.slice(sess.rows.length - count) : [])
      : sess.rows.slice(0, count);
    return {
      ...sess,
      rows: keptRows,
      displayedSteps: keptRows.length,
      truncatedSteps: Boolean(sess.truncatedSteps) || keptRows.length < sess.rows.length
    };
  });
}

function maxFitting(lo, hi, fits) {
  let low = lo;
  let high = hi;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

function fitBalancedExportLayout({ sessions, measureFits, onZeroFitError, keepTail = false }) {
  const fullProjected = projectExportSessionsWithCounts(sessions, sessions.map((s) => s.rows.length), keepTail);
  const baseClamped = sessions.some((s) => s.truncatedSteps);
  if (measureFits(fullProjected, baseClamped)) {
    return { retainedSessions: fullProjected, clamped: baseClamped };
  }
  if (!measureFits(projectExportSessionsWithCounts(sessions, [0], keepTail), true)) {
    return { error: onZeroFitError() };
  }

  const retainedCount = maxFitting(1, sessions.length, (n) =>
    measureFits(projectExportSessionsWithCounts(sessions, new Array(n).fill(0), keepTail), true)
  );
  const maxSessionRows = Math.max(0, ...sessions.slice(0, retainedCount).map((s) => s.rows.length));
  const rowCap = maxFitting(0, maxSessionRows, (cap) =>
    measureFits(
      projectExportSessionsWithCounts(sessions, sessions.slice(0, retainedCount).map((s) => Math.min(s.rows.length, cap)), keepTail),
      true
    )
  );

  const counts = sessions.slice(0, retainedCount).map((s) => Math.min(s.rows.length, rowCap));
  for (let i = 0; i < retainedCount; i++) {
    if (counts[i] >= sessions[i].rows.length) continue;
    counts[i] = maxFitting(counts[i], sessions[i].rows.length, (extra) => {
      const trial = [...counts];
      trial[i] = extra;
      return measureFits(projectExportSessionsWithCounts(sessions, trial, keepTail), true);
    });
  }

  return {
    retainedSessions: projectExportSessionsWithCounts(sessions, counts, keepTail),
    clamped: true
  };
}

/**
 * Generates a sanitized transcript summary index (for scratch/ artifacts or restricted child review).
 * Never emits raw `.system_generated/` JSONL lines, `thinking` blocks, or full file payloads.
 */
export async function exportSanitizedTranscript({
  conversationIds = [],
  parentId = null,
  filePath: explicitFile = null,
  sanitized = false,
  startStep,
  endStep,
  limit,
  maxOutputChars,
  outputFormat = "both",
  allowExternalPaths = false
} = {}) {
  const failExport = (msg, consume = true) => {
    if (consume) consumeTranscriptAccessGrant({ subcommand: "export" });
    return { isError: true, text: msg, error: msg };
  };

  if (sanitized !== true) {
    return failExport("Flag '--sanitized' is required for 'transcript export' to enforce transcript isolation (raw transcript export is prohibited).");
  }

  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(conversationIds) ? conversationIds : [conversationIds])
        .flatMap((id) => String(id || "").split(","))
        .map((id) => id.trim())
        .filter(Boolean)
    )
  );
  const trimmedParent = parentId !== null && parentId !== undefined ? String(parentId).trim() : null;
  if (parentId !== null && parentId !== undefined && trimmedParent === "") {
    return failExport("Flag '--parent' must be a non-empty conversation ID or 'current'.");
  }
  const hasExplicitFile = explicitFile !== null && explicitFile !== undefined && String(explicitFile).trim() !== "";

  if (startStep !== undefined && startStep !== null && (!Number.isInteger(Number(startStep)) || Number(startStep) < 0)) {
    return failExport(`Invalid '--start' step '${startStep}': expected a non-negative integer.`);
  }
  if (endStep !== undefined && endStep !== null && (!Number.isInteger(Number(endStep)) || Number(endStep) < 0)) {
    return failExport(`Invalid '--end' step '${endStep}': expected a non-negative integer.`);
  }
  if (startStep !== undefined && startStep !== null && endStep !== undefined && endStep !== null && Number(endStep) < Number(startStep)) {
    return failExport(`Invalid step range '--start ${startStep} --end ${endStep}': '--end' must be >= '--start'.`);
  }
  if (hasExplicitFile && (trimmedParent || normalizedIds.length > 0)) {
    return failExport("Conflicting selectors for 'transcript export': pass only one of '--id', '--parent', or '--file'.");
  }
  if (trimmedParent && normalizedIds.length > 0) {
    return failExport("Conflicting selectors for 'transcript export': pass either '--parent' or '--id', not both.");
  }

  const parsedLimit = limit !== undefined && limit !== null ? Number(limit) : 150;
  const maxStepsPerSession = Math.min(500, Math.max(1, Math.floor(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 150)));
  let displayParentFilter = trimmedParent;
  const targets = [];

  if (trimmedParent || normalizedIds.length > 1) {
    const multi = resolveMultiTranscriptTargets({
      normalizedIds,
      trimmedParent,
      subcommand: "export",
      fail: failExport
    });
    if (multi.error) return multi.error;
    displayParentFilter = multi.displayParentFilter;
    targets.push(...multi.targets);
  } else {
    const resolved = resolveTranscriptPath(normalizedIds[0], "compact", {
      explicitFile,
      allowExternalPaths,
      subcommand: "export"
    });
    if (resolved.error) {
      return { isError: true, text: resolved.error, error: resolved.error, candidates: resolved.candidates };
    }
    targets.push({ convId: resolved.convId, filePath: resolved.filePath });
  }

  const hasExplicitStart = startStep !== undefined && startStep !== null;
  const keepTail = !hasExplicitStart;
  const sessions = [];
  for (const target of targets) {
    sessions.push(await summarizeTranscriptForSanitizedExport({
      convId: target.convId,
      filePath: target.filePath,
      startStep,
      endStep,
      maxStepsPerSession,
      collectFromHead: hasExplicitStart
    }));
  }

  const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const mdMeta = { generatedAt, displayParentFilter };
  const parsedMaxOutput = Number(maxOutputChars);
  const effectiveCeiling = Number.isFinite(parsedMaxOutput) && parsedMaxOutput > 0
    ? Math.min(MAX_DEEP_OUTPUT_CHARS, Math.floor(parsedMaxOutput))
    : INLINE_SAFE_CHARS;
  const totalRowsAll = sessions.reduce((sum, s) => sum + s.rows.length, 0);

  const computeSingleSessionCursor = (keptSess, origSess) => {
    if (!(keptSess.truncatedSteps || keptSess.rows.length < origSess.rows.length)) return null;
    const endPart = endStep !== undefined && endStep !== null ? { end: Number(endStep) } : {};
    if (hasExplicitStart) {
      const lastStep = keptSess.rows.length > 0 ? Number(keptSess.rows[keptSess.rows.length - 1].step) : NaN;
      if (Number.isInteger(lastStep)) return { start: lastStep + 1, ...endPart };
      const firstOrig = origSess.rows.length > 0 ? Number(origSess.rows[0].step) : NaN;
      return Number.isInteger(firstOrig) ? { start: firstOrig, ...endPart } : null;
    }
    const firstStep = keptSess.rows.length > 0 ? Number(keptSess.rows[0].step) : NaN;
    if (Number.isInteger(firstStep) && firstStep > 0) return { end: firstStep - 1 };
    const lastOrig = origSess.rows.length > 0 ? Number(origSess.rows[origSess.rows.length - 1].step) : NaN;
    return Number.isInteger(lastOrig) && lastOrig >= 0 ? { end: lastOrig } : null;
  };

  const computeJsonNextCursor = (list) => {
    if (sessions.length === 1) return computeSingleSessionCursor(list[0], sessions[0]);
    const incompleteRetained = list.filter((s, idx) => s.truncatedSteps || s.rows.length < sessions[idx].rows.length);
    const omittedSessions = sessions.slice(list.length);
    if (incompleteRetained.length === 0 && omittedSessions.length > 0) {
      return { id: omittedSessions.map((s) => s.convId).join(",") };
    }
    if (incompleteRetained.length === 1 && omittedSessions.length === 0) {
      const idx = list.indexOf(incompleteRetained[0]);
      const sc = computeSingleSessionCursor(incompleteRetained[0], sessions[idx]);
      return sc ? { id: incompleteRetained[0].convId, ...sc } : null;
    }
    return null;
  };

  const buildJsonObject = (list, isClamped, { includeJsonTruncation = false } = {}) => {
    const retainedRows = list.reduce((sum, s) => sum + s.rows.length, 0);
    const nextCursor = (includeJsonTruncation || isClamped) ? computeJsonNextCursor(list) : null;
    const base = {
      sanitized: true,
      generatedAt,
      parentFilter: displayParentFilter,
      exportedCount: list.length,
      totalSessions: sessions.length,
      clamped: isClamped,
      ...(!includeJsonTruncation && nextCursor ? { nextCursor } : {})
    };
    if (includeJsonTruncation) {
      const multiSessionTrimmed =
        sessions.length > 1 &&
        !nextCursor &&
        list.some((s, idx) => s.truncatedSteps || s.rows.length < sessions[idx].rows.length);
      return {
        ...base,
        jsonTruncated: true,
        jsonSessionsIncluded: list.length,
        jsonSessionsTotal: sessions.length,
        jsonRowsIncluded: retainedRows,
        jsonRowsTotal: totalRowsAll,
        ...(nextCursor ? { nextCursor } : {}),
        jsonTruncatedReason: multiSessionTrimmed
          ? "Output exceeds the byte budget and trimmed rows across multiple sessions. Use --full, --max-chars, --out, or inspect individual sessions via --id <convId>."
          : "Output exceeds the byte budget. Use --full, --max-chars, --out, or a narrower --start/--end/--limit selection.",
        sessions: list
      };
    }
    return { ...base, sessions: list };
  };

  const formatTooSmallError = (fmtLabel) =>
    failExport(`The ${effectiveCeiling}-byte budget is too small for sanitized transcript export ${fmtLabel} metadata. Increase --max-chars or narrow the selection.`, false);

  if (outputFormat === "markdown") {
    const layout = fitBalancedExportLayout({
      sessions,
      keepTail,
      measureFits: (list, isClamped) =>
        utf8ByteLength(buildSanitizedExportMarkdown(list, sessions.length, isClamped, mdMeta) + "\n") <= effectiveCeiling,
      onZeroFitError: () => formatTooSmallError("Markdown")
    });
    if (layout.error) return layout.error;
    const text = buildSanitizedExportMarkdown(layout.retainedSessions, sessions.length, layout.clamped, mdMeta);
    return { ...buildJsonObject(layout.retainedSessions, layout.clamped), text, _serializedMarkdown: text + "\n" };
  }

  if (outputFormat === "json") {
    const baseClamped = sessions.some((s) => s.truncatedSteps);
    const unTruncatedObj = buildJsonObject(sessions, baseClamped);
    for (const serialized of [JSON.stringify(unTruncatedObj, null, 2) + "\n", JSON.stringify(unTruncatedObj) + "\n"]) {
      if (utf8ByteLength(serialized) <= effectiveCeiling) {
        return {
          ...unTruncatedObj,
          text: buildSanitizedExportMarkdown(sessions, sessions.length, baseClamped, mdMeta),
          _serializedJson: serialized
        };
      }
    }

    const layout = fitBalancedExportLayout({
      sessions,
      keepTail,
      measureFits: (list) =>
        utf8ByteLength(JSON.stringify(buildJsonObject(list, true, { includeJsonTruncation: true })) + "\n") <= effectiveCeiling,
      onZeroFitError: () => formatTooSmallError("JSON")
    });
    if (layout.error) return layout.error;

    const finalObj = buildJsonObject(layout.retainedSessions, true, { includeJsonTruncation: true });
    const prettyFitted = JSON.stringify(finalObj, null, 2) + "\n";
    return {
      ...finalObj,
      text: buildSanitizedExportMarkdown(layout.retainedSessions, sessions.length, true, mdMeta),
      _serializedJson: utf8ByteLength(prettyFitted) <= effectiveCeiling ? prettyFitted : JSON.stringify(finalObj) + "\n"
    };
  }

  const jointLayout = fitBalancedExportLayout({
    sessions,
    keepTail,
    measureFits: (list, isClamped) =>
      utf8ByteLength(buildSanitizedExportMarkdown(list, sessions.length, isClamped, mdMeta) + "\n") <= effectiveCeiling &&
      utf8ByteLength(JSON.stringify(buildJsonObject(list, isClamped), null, 2) + "\n") <= effectiveCeiling,
    onZeroFitError: () => formatTooSmallError("JSON/Markdown")
  });
  if (jointLayout.error) return jointLayout.error;

  const text = buildSanitizedExportMarkdown(jointLayout.retainedSessions, sessions.length, jointLayout.clamped, mdMeta);
  return { ...buildJsonObject(jointLayout.retainedSessions, jointLayout.clamped), text };
}

function resolveTargetFileInBrainDirs(brainDirs, convId) {
  if (!convId || typeof convId !== "string" || /[\\/]|\.\./.test(convId)) {
    return { error: `Invalid conversation ID '${convId}'.` };
  }
  const searched = [];
  let newest = null;
  for (const brainDir of brainDirs) {
    const realBrain = realOrNull(brainDir) || path.resolve(brainDir);
    const expectedSessionDir = path.join(realBrain, convId);
    if (!fs.existsSync(expectedSessionDir)) {
      searched.push(expectedSessionDir);
      continue;
    }
    const compactPath = path.join(expectedSessionDir, ".system_generated", "logs", "transcript.jsonl");
    const fullPath = path.join(expectedSessionDir, ".system_generated", "logs", "transcript_full.jsonl");
    const targetPath = fs.existsSync(compactPath) ? compactPath : fs.existsSync(fullPath) ? fullPath : null;
    if (!targetPath) {
      searched.push(compactPath);
      continue;
    }
    const realCandidate = realOrNull(targetPath);
    if (!realCandidate || !isContainedInDir(realCandidate, expectedSessionDir) || !isContainedInAnyBrainDir(realCandidate, brainDirs)) {
      return {
        error: `Security containment error: resolved path '${realCandidate || targetPath}' escapes conversation directory '${expectedSessionDir}'.`
      };
    }
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(realCandidate).mtimeMs; } catch {}
    if (!newest || mtimeMs > newest.mtimeMs) {
      newest = { filePath: realCandidate, convId, mtimeMs };
    }
  }
  if (newest) {
    return { filePath: newest.filePath, convId };
  }
  return { error: `Transcript not found for conversation '${convId}'. Searched: ${searched.join(", ")}` };
}
