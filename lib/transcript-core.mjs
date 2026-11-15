/**
 * Agy-Context-Saver: Hardened Streaming Transcript & Health Engine (v2.0.0)
 *
 * Zero-dependency ESM core powering both `bin/agy-context.mjs` CLI and
 * the deprecated `mcp/index.js` thin compatibility wrapper.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { findExistingRtk } from "../scripts/provision-rtk.mjs";

export const MAX_LINE_CHARS = 1000;
export const MAX_TURN_CHARS = 6000;
export const MAX_OUTPUT_CHARS = 24000;
export const MAX_FIELD_CHARS = 24000;
export const ACTIVE_SWARM_WINDOW_MS = 5 * 60 * 1000;
export const MAX_BOUNDED_READ_STEPS = 200;
export const MAX_HEALTH_LINES = 100000;

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

export function getProfileHomeDir() {
  return process.env.AGY_TEST_PROFILE_DIR || os.homedir();
}

export function getBrainDir() {
  return process.env.AGY_BRAIN_DIR || path.join(getProfileHomeDir(), ".gemini", "antigravity", "brain");
}

export function extractConvId(p) {
  const normalized = String(p || "").replace(/\\/g, "/");
  const brainMatch = normalized.match(/\/brain\/([^/]+)\//);
  if (brainMatch) return brainMatch[1];
  const logsMatch = normalized.match(/\/([^/]+)\/\.system_generated\/logs\//);
  if (logsMatch) return logsMatch[1];
  return path.basename(normalized, path.extname(normalized));
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isContainedInDir(targetPath, parentDir) {
  const realTarget = realOrNull(targetPath);
  const realParent = realOrNull(parentDir);
  if (!realTarget || !realParent) return false;
  return realTarget === realParent || realTarget.startsWith(realParent + path.sep);
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

function scanBrainTranscripts(brainDir) {
  const candidates = [];
  let entries = [];
  try {
    entries = fs.readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return candidates;
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
    candidates.push({ convId: d.name, mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

/**
 * Resolves a conversation ID or explicit transcript file path.
 *
 * Security & disambiguation rules:
 * - When `explicitFile` (`--file`) is given, it must exist, be a file, and end with `.jsonl`.
 * - When `conversationId` is omitted or `"current"`, checks `GEMINI_CONVERSATION_ID`, else scans
 *   `getBrainDir()`. If >= 2 transcripts were modified in the last 5 minutes (active swarm),
 *   returns a clear disambiguation error listing candidate UUIDs.
 * - Unless `explicitFile` or `allowExternalPaths` is true, enforces `fs.realpathSync` containment
 *   inside `realpath(getBrainDir())`.
 */
export function resolveTranscriptPath(target, mode = "compact", options = {}) {
  const { explicitFile = null, allowExternalPaths = false } = options;
  const isFull = mode === "full";
  const fileName = isFull ? "transcript_full.jsonl" : "transcript.jsonl";
  const brainDir = getBrainDir();

  // 0. Explicit --file operator path
  if (explicitFile !== null && explicitFile !== undefined && String(explicitFile).trim() !== "") {
    const fileStr = String(explicitFile).trim();
    if (!fileStr.toLowerCase().endsWith(".jsonl")) {
      return { error: `Invalid --file path '${fileStr}': explicit transcript file must end with .jsonl.` };
    }
    const resolvedFile = path.resolve(fileStr);
    if (!fs.existsSync(resolvedFile)) {
      return { error: `Transcript file not found at --file path: '${resolvedFile}'.` };
    }
    const realFile = realOrNull(resolvedFile);
    if (!realFile) {
      return { error: `Unable to resolve realpath for --file path: '${resolvedFile}'.` };
    }
    try {
      if (!fs.statSync(realFile).isFile()) {
        return { error: `Invalid --file path '${resolvedFile}': target is not a regular file.` };
      }
    } catch (err) {
      return { error: `Unable to stat --file path '${resolvedFile}': ${err.message}` };
    }
    const finalPath = siblingModePath(realFile, mode);
    return { filePath: finalPath, convId: extractConvId(finalPath) };
  }

  // 1. Omitted or "current": check GEMINI_CONVERSATION_ID, else scan <brainDir> with active-swarm disambiguation
  let raw = String(target || "").trim();
  if (!raw || raw.toLowerCase() === "current") {
    if (process.env.GEMINI_CONVERSATION_ID && process.env.GEMINI_CONVERSATION_ID.trim()) {
      raw = process.env.GEMINI_CONVERSATION_ID.trim();
    } else {
      const candidates = scanBrainTranscripts(brainDir);
      const now = Date.now();
      const recent = candidates.filter((c) => (now - c.mtimeMs) <= ACTIVE_SWARM_WINDOW_MS);

      if (recent.length >= 2) {
        const listing = recent
          .map((c) => `- ${c.convId} (modified ${Math.max(0, Math.round((now - c.mtimeMs) / 1000))}s ago)`)
          .join("\n");
        return {
          error: `Ambiguous active conversation: ${recent.length} transcripts in ${brainDir} were modified in the last 5 minutes (active swarm). Specify an explicit --id <uuid>:\n${listing}`,
          candidates: recent.map((c) => c.convId)
        };
      }
      if (recent.length === 1) {
        raw = recent[0].convId;
      } else if (candidates.length > 0) {
        raw = candidates[0].convId;
      } else {
        return { error: `No conversation transcripts found in brain directory: ${brainDir}. Specify --id <uuid> or --file <path>.` };
      }
    }
  }

  // 2. Reject path traversal / external path tokens in --id unless allowExternalPaths is explicitly enabled
  const normalized = raw.replace(/\\/g, "/");
  if (!allowExternalPaths) {
    if (raw.includes("\0") || raw.includes("..") || raw.includes("/") || raw.includes("\\") || normalized.endsWith(".jsonl")) {
      return {
        error: `Invalid conversation ID '${raw}': must be a bare conversation UUID/folder inside ${brainDir}. Use --file <path> for explicit external .jsonl files.`
      };
    }
  }

  // 3. Direct file path (legacy MCP compatibility when allowExternalPaths === true)
  if (allowExternalPaths && normalized.endsWith(".jsonl") && fs.existsSync(normalized)) {
    const finalPath = siblingModePath(normalized, mode);
    return { filePath: finalPath, convId: extractConvId(finalPath) };
  }

  // 4. UUID / Directory resolution under <brainDir>/<id>
  const brainCandidate = path.join(brainDir, normalized, ".system_generated", "logs", fileName);
  if (fs.existsSync(brainCandidate)) {
    if (!allowExternalPaths && !isContainedInDir(brainCandidate, brainDir)) {
      return { error: `Security containment error: resolved path '${brainCandidate}' escapes brain directory '${brainDir}'.` };
    }
    return { filePath: realOrNull(brainCandidate) || brainCandidate, convId: normalized };
  }
  if (isFull) {
    const compactFallback = path.join(brainDir, normalized, ".system_generated", "logs", "transcript.jsonl");
    if (fs.existsSync(compactFallback)) {
      if (!allowExternalPaths && !isContainedInDir(compactFallback, brainDir)) {
        return { error: `Security containment error: resolved path '${compactFallback}' escapes brain directory '${brainDir}'.` };
      }
      return { filePath: realOrNull(compactFallback) || compactFallback, convId: normalized };
    }
  } else {
    const fullFallback = path.join(brainDir, normalized, ".system_generated", "logs", "transcript_full.jsonl");
    if (fs.existsSync(fullFallback)) {
      if (!allowExternalPaths && !isContainedInDir(fullFallback, brainDir)) {
        return { error: `Security containment error: resolved path '${fullFallback}' escapes brain directory '${brainDir}'.` };
      }
      return { filePath: realOrNull(fullFallback) || fullFallback, convId: normalized };
    }
  }

  // 5. Legacy local relative/absolute directory path (only when allowExternalPaths === true)
  if (allowExternalPaths) {
    const localCandidate = path.resolve(normalized, ".system_generated", "logs", fileName);
    if (fs.existsSync(localCandidate)) {
      return { filePath: localCandidate, convId: extractConvId(localCandidate) };
    }
    const directCandidate = path.resolve(normalized, fileName);
    if (fs.existsSync(directCandidate)) {
      return { filePath: directCandidate, convId: extractConvId(directCandidate) };
    }
  }

  return { error: `Transcript not found for target: '${target}'. Searched: ${brainCandidate}` };
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

/**
 * Sanitizes message content:
 * 1. Strips data:image base64 URIs, large non-URL/non-hex base64 payloads (>=256 chars),
 *    and Git CRLF/LF warnings BEFORE `maxChars` slicing.
 * 2. Clamps any line exceeding MAX_LINE_CHARS (even single-line logs without newlines).
 * 3. Slices to `maxChars` using either verbose banner or clean `...` ellipsis.
 */
export function cleanMessageContent(content, maxChars = MAX_TURN_CHARS, options = {}) {
  if (content === null || content === undefined) return "";
  const { truncationStyle = "banner" } = options;
  let text = typeof content === "string" ? content : JSON.stringify(content, null, 2);

  // Fast-path: short text without base64 or CRLF warning noise
  if (text.length <= 120 && !text.includes("base64") && !text.includes("will be replaced by")) {
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
    text = text.replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=_-]+/g, "[Embedded Media/Binary Omitted]");
  }

  // 2. Strip tightened raw base64 payloads (>=256 chars, non-URL, non-pure-hex) BEFORE maxChars slicing
  if (text.length >= 256) {
    text = text.replace(/[A-Za-z0-9+/=_-]{256,}/g, (match, offset, fullStr) => {
      if (isUrlTokenAtOffset(fullStr, offset)) return match;
      if (!isLikelyRawBase64(match)) return match;
      return "[Binary/Base64 Payload Omitted]";
    });
  }

  // 3. Strip Git CRLF/LF line-ending diagnostic warning noise BEFORE maxChars slicing
  if (text.includes("will be replaced by")) {
    text = text.replace(
      /(?:#\s*)?warning:\s*(?:in the working copy of [^,\r\n]+,\s*)?(?:CRLF will be replaced by LF|LF will be replaced by CRLF)[^\r\n]*(?:\r?\n)?/gi,
      ""
    );
  }

  // 4. Always clamp lines exceeding MAX_LINE_CHARS, even for single-line logs without newlines
  if (text.length > MAX_LINE_CHARS && truncationStyle !== "ellipsis") {
    const lines = text.split("\n");
    let changed = false;
    const clampedLines = lines.map((l) => {
      if (l.length > MAX_LINE_CHARS) {
        changed = true;
        return l.slice(0, MAX_LINE_CHARS) + " ... [line clamped]";
      }
      return l;
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
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Keep original string if not valid JSON string literal
    }
  }
  return v;
}

const LARGE_BODY_ARG_KEYS = new Set(["Content", "content", "Replacement", "Target", "CodeContent", "brief"]);

export function formatArgumentDescriptor(k, v, options = {}) {
  const { fullArgs = false } = options;
  const val = unwrapCompactArgValue(v);
  if (typeof val === "string") {
    if (fullArgs && LARGE_BODY_ARG_KEYS.has(k) && val.length > 600) {
      const preview = val.replace(/[\r\n\t]+/g, " ").slice(0, 240).trim();
      const sizeKb = (Buffer.byteLength(val, "utf8") / 1024).toFixed(1);
      return `${k}="${preview}..." [${sizeKb} KB body; use 'step --step <N> --field tool_args' for full text]`;
    }
    if (fullArgs || (val.length <= 80 && !val.includes("\n"))) {
      return `${k}=${JSON.stringify(val)}`;
    }
    const preview = val.replace(/[\r\n\t]+/g, " ").slice(0, 50).trim();
    const sizeKb = (Buffer.byteLength(val, "utf8") / 1024).toFixed(1);
    return `${k}="${preview}..." [${sizeKb} KB]`;
  }
  if (typeof val === "number" || typeof val === "boolean" || val === null) {
    return `${k}=${val}`;
  }
  if (fullArgs) {
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
  const { fullArgs = false } = options;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  return toolCalls
    .map((tc) => {
      const name = tc.name || tc.tool_name || "unknown_tool";
      const args = tc.args || tc.arguments || {};
      const keys = Object.keys(args);
      if (keys.length === 0) return `${name}()`;
      if (fullArgs) {
        const allPairs = Object.entries(args)
          .map(([k, v]) => formatArgumentDescriptor(k, v, { fullArgs: true }))
          .join(", ");
        return `${name}(${allPairs})`;
      }
      let chosenKey = KEY_ARG_PRIORITY.find((k) => Object.prototype.hasOwnProperty.call(args, k) && args[k] !== undefined && args[k] !== "");
      if (!chosenKey) chosenKey = keys[0];
      const val = unwrapCompactArgValue(args[chosenKey]);
      let valStr;
      if (typeof val === "string") {
        const flat = val.replace(/\s+/g, " ").trim();
        valStr = flat.length > 36 ? `${flat.slice(0, 33)}...` : flat;
        valStr = JSON.stringify(valStr);
      } else if (typeof val === "number" || typeof val === "boolean" || val === null) {
        valStr = String(val);
      } else {
        valStr = Array.isArray(val) ? `[${val.length}]` : "{...}";
      }
      return `${name}(${chosenKey}=${valStr})`;
    })
    .join(", ");
}

export function normalizeRoleLabel(item) {
  const type = String(item?.type || "UNKNOWN").toUpperCase();
  if (type === "USER_INPUT") return "USER";
  if (type === "PLANNER_RESPONSE") return "ASSISTANT";
  if (type === "SUBAGENT_RESPONSE") return "SUBAGENT";
  return type;
}

export function isStructuredErrorItem(item) {
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
    field = null,
    maxContentChars = MAX_TURN_CHARS
  } = options;
  const stepIdx = item.step_index !== undefined ? item.step_index : "?";
  const role = normalizeRoleLabel(item);
  const time = item.created_at ? item.created_at.replace(/\.\d+Z$/, "Z") : "";
  const timeStr = time ? ` (${time})` : "";
  const errorBadge = isStructuredErrorItem(item) ? " [ERROR]" : "";

  const normalizedField = field ? String(field).trim() : null;
  if (normalizedField && normalizedField !== "all") {
    const single = formatSingleStepDetail(item, stepIdx, normalizedField, { capLargeFileBodies: true });
    return single.text;
  }

  const parts = [];
  parts.push(`### [Step ${stepIdx} | ${role}]${errorBadge}${timeStr}`);

  if (includeThinking && item.thinking) {
    const cleanThinking = cleanMessageContent(item.thinking, 4000);
    parts.push(`> <thinking>\n> ${cleanThinking.split("\n").join("\n> ")}\n> </thinking>`);
  }

  if ((includeToolCalls || fullArgs || role === "ASSISTANT") && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
    const tcSummary = item.tool_calls.map((tc) => {
      const name = tc.name || tc.tool_name || "unknown_tool";
      const args = tc.args || tc.arguments || {};
      const compactArgs = Object.entries(args)
        .map(([k, v]) => formatArgumentDescriptor(k, v, { fullArgs }))
        .join(", ");
      return `- \`${name}(${compactArgs})\``;
    });
    parts.push(`**Tool Calls (${item.tool_calls.length}):**\n${tcSummary.join("\n")}`);
  }

  if (item.content) {
    const cleaned = cleanMessageContent(item.content, maxContentChars);
    if (cleaned.trim()) {
      parts.push(cleaned.trim());
    }
  }

  return parts.join("\n\n");
}

const regexCache = new Map();
const MAX_REGEX_CACHE_ENTRIES = 100;

export function getCompiledRegex(pattern) {
  if (!pattern || typeof pattern !== "string") return null;
  const cached = regexCache.get(pattern);
  if (cached) return cached;

  let rx;
  try {
    rx = new RegExp(pattern, "i");
  } catch {
    rx = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  if (regexCache.size >= MAX_REGEX_CACHE_ENTRIES) {
    const firstKey = regexCache.keys().next().value;
    regexCache.delete(firstKey);
  }
  regexCache.set(pattern, rx);
  return rx;
}

export async function batchFindFullSteps(fullPath, stepIndicesSet) {
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

export async function findFullStep(fullPath, targetStepIndex) {
  const map = await batchFindFullSteps(fullPath, new Set([targetStepIndex]));
  return map.get(targetStepIndex) || null;
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
export async function readTranscript({
  conversationId,
  filePath: explicitFile,
  mode = "compact",
  lastTurns = 3,
  offset,
  limit,
  includeThinking = false,
  allowExternalPaths = false
} = {}) {
  const resolved = resolveTranscriptPath(conversationId, mode, { explicitFile, allowExternalPaths });
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
        if (totalStepsCount >= pageOffset && pageLines.length < pageLimit) {
          pageLines.push(trimmed);
        }
        totalStepsCount++;
        if (pageLines.length >= pageLimit) {
          break;
        }
      } else {
        totalStepsCount++;
        ringBuffer.push(trimmed);
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
    return { convId, filePath, mode, totalSteps: 0, selectedSteps: 0, displayedSteps: 0, clamped: false, steps: [], text: msg };
  }

  const rawLines = hasExplicitPagination ? pageLines : ringBuffer.toArray();
  const items = [];
  for (let i = 0; i < rawLines.length; i++) {
    try {
      const parsed = JSON.parse(rawLines[i]);
      if (parsed._ordinal === undefined) parsed._ordinal = i;
      items.push(parsed);
    } catch {
      // Tolerates incomplete trailing flushes during concurrent writes
    }
  }

  let selected = items;
  if (!hasExplicitPagination && effectiveLastTurns > 0) {
    const turnItems = items.filter((it) => it.type === "USER_INPUT" || it.type === "PLANNER_RESPONSE");
    const cutoff = Math.max(0, turnItems.length - effectiveLastTurns);
    const anchor = turnItems[cutoff];
    if (anchor) {
      const minStep = anchor.step_index !== undefined ? anchor.step_index : anchor._ordinal;
      selected = items.filter((it) => (it.step_index !== undefined ? it.step_index : it._ordinal) >= minStep);
    }
  }

  const maxWindowChars = mode === "compact" ? 3800 : MAX_OUTPUT_CHARS;
  const buildHeader = (displayedCount) => {
    const scopeDesc = hasExplicitPagination
      ? `page offset=${pageOffset}, limit=${pageLimit}`
      : effectiveLastTurns > 0
        ? `${effectiveLastTurns} turns`
        : `all (bounded window ${selected.length} steps)`;
    return [
      `# Conversation Transcript: \`${convId}\``,
      `- Mode: **${mode}** (${path.basename(filePath)})`,
      `- Total Steps in Log: ${hasExplicitPagination ? `${totalStepsCount}+ (paged)` : totalStepsCount}`,
      `- Displayed Steps: ${displayedCount} (showing last ${scopeDesc})`,
      "",
      "---",
      ""
    ].join("\n");
  };

  // Reserve exact header space based on worst-case header size, then rebuild header with actual count
  const provisionalHeaderLen = buildHeader(selected.length).length + 16;
  const formattedBlocks = [];
  const displayedItems = [];
  let currentLength = provisionalHeaderLen;
  let clamped = false;

  if (hasExplicitPagination) {
    for (let i = 0; i < selected.length; i++) {
      const item = selected[i];
      const isDialogueTurn =
        item.type === "USER_INPUT" ||
        item.type === "PLANNER_RESPONSE" ||
        item.type === "SUBAGENT_RESPONSE";
      const block = formatTranscriptItem(item, {
        includeThinking,
        includeToolCalls: true,
        maxContentChars: mode === "compact" && !isDialogueTurn ? 300 : MAX_TURN_CHARS
      });
      if (currentLength + block.length + 6 > maxWindowChars && formattedBlocks.length > 0) {
        clamped = true;
        break;
      }
      formattedBlocks.push(block);
      displayedItems.push(item);
      currentLength += block.length + 6;
    }
  } else {
    for (let i = selected.length - 1; i >= 0; i--) {
      const item = selected[i];
      const isDialogueTurn =
        item.type === "USER_INPUT" ||
        item.type === "PLANNER_RESPONSE" ||
        item.type === "SUBAGENT_RESPONSE";
      const block = formatTranscriptItem(item, {
        includeThinking,
        includeToolCalls: true,
        maxContentChars: mode === "compact" && !isDialogueTurn ? 300 : MAX_TURN_CHARS
      });
      if (currentLength + block.length + 6 > maxWindowChars && formattedBlocks.length > 0) {
        clamped = true;
        break;
      }
      formattedBlocks.unshift(block);
      displayedItems.unshift(item);
      currentLength += block.length + 6;
    }
  }

  const header = buildHeader(formattedBlocks.length);
  let fullOutput = header + formattedBlocks.join("\n\n---\n\n");
  if (clamped) {
    const ceilingLabel = mode === "compact" ? "3.8 KB inline" : "24 KB";
    fullOutput += `\n\n... [Transcript display clamped at ${ceilingLabel} safety ceiling; use \`agy-context transcript step --id ${convId} --step <N,M,K|N-M> [--field tool_args|content]\` or \`agy-context transcript query --id ${convId} --summary\`] ...`;
  }

  return {
    convId,
    filePath,
    mode,
    totalSteps: totalStepsCount,
    selectedSteps: selected.length,
    displayedSteps: formattedBlocks.length,
    clamped,
    steps: displayedItems,
    text: fullOutput
  };
}

const MAX_BATCH_STEPS = 200;

export function parseStepSelector(stepIndex, startStep, endStep) {
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

function applyLineSlice(str, { headLines, tailLines } = {}) {
  if (!str || typeof str !== "string") return str;
  const h = Number(headLines);
  const t = Number(tailLines);
  if (Number.isFinite(h) && h > 0) {
    const lines = str.split("\n");
    if (lines.length > h) return lines.slice(0, h).join("\n");
    if (lines.length === 1 && str.length > h * 120) return str.slice(0, h * 120);
  }
  if (Number.isFinite(t) && t > 0) {
    const lines = str.split("\n");
    if (lines.length > t) return lines.slice(-t).join("\n");
    if (lines.length === 1 && str.length > t * 120) return str.slice(-(t * 120));
  }
  return str;
}

export function formatSingleStepDetail(step, numIndex, field, options = {}) {
  const { maxFieldChars = MAX_FIELD_CHARS, capLargeFileBodies = false, headLines, tailLines } = options;
  const f = field ? String(field).trim() : "all";
  const effectiveStep = (headLines || tailLines) && step && typeof step.content === "string"
    ? { ...step, content: applyLineSlice(step.content, { headLines, tailLines }) }
    : step;

  if (f === "content") {
    const val = String(effectiveStep.content || "(No content in step)");
    const body = val.length > maxFieldChars
      ? `${val.slice(0, maxFieldChars)}\n... [Step ${numIndex} truncated in batch view; run --step ${numIndex} [--tail <lines>] for full 24 KB view]`
      : val;
    const text = `### Step ${numIndex} Content\n\n${body}`;
    return { stepIndex: numIndex, field: f, step: effectiveStep, data: effectiveStep.content ?? null, text };
  }

  if (f === "thinking") {
    const val = applyLineSlice(String(step.thinking || "(No thinking block in step)"), { headLines, tailLines });
    const body = val.length > maxFieldChars
      ? `${val.slice(0, maxFieldChars)}\n... [Step ${numIndex} truncated in batch view; run --step ${numIndex} for full 24 KB view]`
      : val;
    const text = `### Step ${numIndex} Thinking\n\n${body}`;
    return { stepIndex: numIndex, field: f, step, data: step.thinking ?? null, text };
  }

  if (f === "tool_calls") {
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const val = JSON.stringify(calls, null, 2);
    const text = `### Step ${numIndex} Tool Calls (${calls.length})\n\`\`\`json\n${val.slice(0, maxFieldChars)}\n\`\`\``;
    return { stepIndex: numIndex, field: f, step, data: calls, text };
  }

  if (f === "tool_args" || f.startsWith("tool_args:")) {
    const argName = f.includes(":") ? f.slice(f.indexOf(":") + 1).trim() : null;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (calls.length === 0) {
      const text = `Step ${numIndex} contains no tool calls.`;
      return { stepIndex: numIndex, field: f, step, data: [], text };
    }

    const mappedCalls = calls.map((tc, idx) => {
      const name = tc.name || tc.tool_name || "unknown_tool";
      const tcArgs = tc.args || tc.arguments || {};
      if (!capLargeFileBodies) {
        return { index: idx, name, args: tcArgs };
      }
      const displayArgs = {};
      for (const [k, v] of Object.entries(tcArgs)) {
        const un = unwrapCompactArgValue(v);
        if (typeof un === "string" && LARGE_BODY_ARG_KEYS.has(k) && un.length > 600) {
          displayArgs[k] = `${un.slice(0, 300)}... [${un.length} chars; use 'step --step ${numIndex} --field tool_args' for full text]`;
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
        value: entry.args[argName]
      }));

      let text;
      if (extracted.length === 1) {
        const displayVal = typeof extracted[0].value === "string"
          ? extracted[0].value
          : JSON.stringify(extracted[0].value, null, 2);
        text = `### Step ${numIndex} Argument: \`${argName}\`\n\n${String(displayVal).slice(0, maxFieldChars)}`;
      } else {
        const sections = extracted.map((entry) => {
          const valStr = entry.hasKey
            ? (typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value, null, 2))
            : "(not present)";
          return `- **[${entry.index}] \`${entry.name}\`**:\n${String(valStr)}`;
        });
        text = `### Step ${numIndex} Argument: \`${argName}\` (across ${extracted.length} tool calls)\n\n${sections.join("\n\n").slice(0, maxFieldChars)}`;
      }
      return { stepIndex: numIndex, field: f, step, data: extracted, text };
    }

    let text;
    if (mappedCalls.length === 1) {
      const renderedArgs = mappedCalls[0].displayArgs || mappedCalls[0].args;
      text = `### Step ${numIndex} Tool Arguments (1 tool call: \`${mappedCalls[0].name}\`)\n\`\`\`json\n${JSON.stringify(renderedArgs, null, 2).slice(0, maxFieldChars)}\n\`\`\``;
    } else {
      const blocks = mappedCalls.map(
        (entry) => `#### [${entry.index}] \`${entry.name}\`\n\`\`\`json\n${JSON.stringify(entry.displayArgs || entry.args, null, 2)}\n\`\`\``
      );
      text = `### Step ${numIndex} Tool Arguments (${mappedCalls.length} tool calls)\n\n${blocks.join("\n\n").slice(0, maxFieldChars)}`;
    }
    return { stepIndex: numIndex, field: f, step, data: mappedCalls.map(({ index, name, args }) => ({ index, name, args })), text };
  }

  const formatted = formatTranscriptItem(effectiveStep, {
    includeThinking: true,
    includeToolCalls: true,
    fullArgs: true,
    maxContentChars: maxFieldChars
  });
  return { stepIndex: numIndex, field: "all", step: effectiveStep, data: effectiveStep, text: formatted };
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
  allowExternalPaths = false
} = {}) {
  const parsedSelector = parseStepSelector(stepIndex, startStep, endStep);
  if (parsedSelector.error) {
    return { isError: true, text: parsedSelector.error, error: parsedSelector.error };
  }

  const { indices, isMulti } = parsedSelector;
  const targetSet = new Set(indices);

  const resolvedFull = resolveTranscriptPath(conversationId, "full", { explicitFile, allowExternalPaths });
  if (resolvedFull.error && explicitFile) {
    return { isError: true, text: resolvedFull.error, error: resolvedFull.error, candidates: resolvedFull.candidates };
  }

  let usedConvId = resolvedFull.convId;
  let usedFilePath = resolvedFull.filePath;
  const foundMap = new Map();

  if (resolvedFull && resolvedFull.filePath && fs.existsSync(resolvedFull.filePath)) {
    const fullMatches = await batchFindFullSteps(resolvedFull.filePath, targetSet);
    for (const [k, v] of fullMatches.entries()) {
      foundMap.set(k, v);
    }
  }

  if (foundMap.size < targetSet.size) {
    const missingSet = new Set(indices.filter((idx) => !foundMap.has(idx)));
    const resolvedCompact = resolveTranscriptPath(conversationId, "compact", { explicitFile, allowExternalPaths });
    if (resolvedCompact.error && !resolvedFull.filePath) {
      return { isError: true, text: resolvedCompact.error, error: resolvedCompact.error, candidates: resolvedCompact.candidates };
    }
    if (
      resolvedCompact &&
      resolvedCompact.filePath &&
      resolvedCompact.filePath !== resolvedFull.filePath &&
      fs.existsSync(resolvedCompact.filePath)
    ) {
      usedConvId = usedConvId || resolvedCompact.convId;
      if (foundMap.size === 0) usedFilePath = resolvedCompact.filePath;
      const compactMatches = await batchFindFullSteps(resolvedCompact.filePath, missingSet);
      for (const [k, v] of compactMatches.entries()) {
        foundMap.set(k, v);
      }
    }
  }

  if (!isMulti) {
    const numIndex = indices[0];
    const step = foundMap.get(numIndex);
    if (!step) {
      const msg = `Step index ${numIndex} not found in transcript.`;
      return { isError: true, text: msg, error: msg };
    }
    const single = formatSingleStepDetail(step, numIndex, field, { headLines, tailLines });
    return {
      convId: usedConvId,
      filePath: usedFilePath,
      stepIndex: numIndex,
      field: single.field,
      step: single.step,
      data: single.data,
      text: single.text
    };
  }

  const foundSteps = [];
  const missingSteps = [];
  const perStepMaxChars = Math.max(2000, Math.min(8000, Math.floor(MAX_FIELD_CHARS / Math.max(1, indices.length))));
  for (const idx of indices) {
    const step = foundMap.get(idx);
    if (step) {
      foundSteps.push(
        formatSingleStepDetail(step, idx, field, {
          maxFieldChars: perStepMaxChars,
          capLargeFileBodies: indices.length >= 3,
          headLines,
          tailLines
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
  const blocks = foundSteps.map((s) => s.text);
  let joined = blocks.join("\n\n---\n\n");
  if (joined.length > MAX_FIELD_CHARS) {
    joined = joined.slice(0, MAX_FIELD_CHARS) + "\n\n... [Batch step output clamped at 32 KB safety ceiling] ...";
  }

  return {
    convId: usedConvId,
    filePath: usedFilePath,
    stepIndex: foundSteps[0].stepIndex,
    stepIndices: foundSteps.map((s) => s.stepIndex),
    requestedSteps: indices,
    missingSteps,
    field: normalizedField,
    steps: foundSteps.map((s) => ({ stepIndex: s.stepIndex, step: s.step, data: s.data })),
    data: foundSteps.map((s) => ({ stepIndex: s.stepIndex, data: s.data })),
    text: joined
  };
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
    maxResults,
    summaryOnly = false,
    stepIndex,
    field,
    allowExternalPaths = false
  } = args;

  if (stepIndex !== undefined && stepIndex !== null) {
    return getStepDetail({ conversationId, filePath: explicitFile, stepIndex, startStep, endStep, field, allowExternalPaths });
  }

  const normalizedField = field ? String(field).trim() : null;
  const fieldImpliesTools = Boolean(
    normalizedField === "tool_args" ||
    normalizedField === "tool_calls" ||
    (normalizedField && normalizedField.startsWith("tool_args:"))
  );
  const effectiveFullArgs = Boolean(fullArgs || fieldImpliesTools);
  const effectiveIncludeTools = Boolean(includeToolCalls || effectiveFullArgs);

  const resolved = resolveTranscriptPath(conversationId, mode === "full" ? "full" : "compact", {
    explicitFile,
    allowExternalPaths
  });
  if (resolved.error) {
    return { isError: true, text: resolved.error, error: resolved.error, candidates: resolved.candidates };
  }

  const { filePath, convId } = resolved;
  const fullSiblingPath = filePath.endsWith("transcript_full.jsonl")
    ? filePath
    : filePath.replace(/transcript\.jsonl$/, "transcript_full.jsonl");

  const roleList = Array.isArray(roles)
    ? roles
    : String(roles || "user,assistant").split(",").map((s) => s.trim()).filter(Boolean);
  const roleSet = new Set(roleList.map((r) => String(r).toLowerCase()));
  const matchAllRoles = roleSet.has("all");

  const queryRegex = getCompiledRegex(query);
  const isPlainLiteral = Boolean(query && /^[A-Za-z0-9_ -]+$/.test(query));

  const hasExplicitStepRange =
    startStep !== undefined &&
    startStep !== null &&
    endStep !== undefined &&
    endStep !== null &&
    Number.isFinite(Number(startStep)) &&
    Number.isFinite(Number(endStep)) &&
    Number(endStep) >= Number(startStep);
  const rangeSpan = hasExplicitStepRange
    ? Math.min(50, Math.floor(Number(endStep)) - Math.floor(Number(startStep)) + 1)
    : 0;
  const defaultMaxResults = hasExplicitStepRange
    ? (summaryOnly || normalizedField ? Math.max(30, rangeSpan) : Math.max(5, rangeSpan))
    : (summaryOnly ? 30 : (normalizedField ? 25 : 5));
  const parsedMax = Number(maxResults);
  const effectiveMaxResults = Number.isFinite(parsedMax) && parsedMax > 0 ? Math.floor(parsedMax) : defaultMaxResults;

  const parsedLastTurns = Number(lastTurns);
  const effectiveLastTurns = Number.isFinite(parsedLastTurns) && parsedLastTurns > 0 ? Math.floor(parsedLastTurns) : 0;

  // Ring buffer capacity must hold all steps within the last N dialogue turns, never collapsing turns to steps
  const ringCap = effectiveLastTurns > 0
    ? Math.max(effectiveMaxResults, effectiveLastTurns * 25, 200)
    : effectiveMaxResults;

  const compactRing = new CircularRingBuffer(ringCap);
  const turnStepRing = effectiveLastTurns > 0 ? new CircularRingBuffer(effectiveLastTurns) : null;

  // For ACS-MCP-02: collect compact lines with truncated_fields when query missed compact snippet in mode="auto"
  const truncatedCandidateSteps = [];
  const hydratedMatchesRing = new CircularRingBuffer(ringCap);
  let totalHydratedMatches = 0;

  let compactMatchedCount = 0;
  let lineOrdinal = 0;
  let fileStream;
  let rl;

  const flushTruncatedCandidates = async (batchIndices) => {
    if (batchIndices.length === 0 || mode !== "auto") return;
    if (!fs.existsSync(fullSiblingPath)) return;
    const fullMap = await batchFindFullSteps(fullSiblingPath, new Set(batchIndices));
    for (const stepIdx of batchIndices) {
      const fullItem = fullMap.get(stepIdx);
      if (!fullItem) continue;
      if (!itemMatchesRole(fullItem, roleSet, matchAllRoles)) continue;
      if (!itemMatchesQuery(fullItem, queryRegex)) continue;
      totalHydratedMatches++;
      hydratedMatchesRing.push(fullItem);
    }
  };

  try {
    fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
    rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineOrdinal++;

      // PERF-12: Raw-line prefilter for plain literal queries, BUT never skip truncated lines in mode="auto"
      const mayHaveTruncatedTail = mode === "auto" && Boolean(queryRegex) && line.includes('"truncated_fields"');
      if (isPlainLiteral && !queryRegex.test(line) && !mayHaveTruncatedTail) continue;

      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }

      const stepIdx = item.step_index !== undefined ? item.step_index : lineOrdinal;
      if (item.step_index === undefined) item._ordinal = lineOrdinal;

      if (turnStepRing && (item.type === "USER_INPUT" || item.type === "PLANNER_RESPONSE")) {
        turnStepRing.push(stepIdx);
      }

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
        truncatedCandidateSteps.push(item.step_index);
        // Bound candidate batch in RAM when lastTurns is not filtering at the end
        if (!effectiveLastTurns && truncatedCandidateSteps.length >= 500) {
          const batch = truncatedCandidateSteps.splice(0, truncatedCandidateSteps.length);
          await flushTruncatedCandidates(batch);
        }
      }
    }
  } catch (err) {
    const msg = `Error streaming transcript: ${err.message}`;
    return { isError: true, text: msg, error: msg };
  } finally {
    if (rl) rl.close();
    if (fileStream) fileStream.destroy();
  }

  // Compute dialogue-turn cutoff if lastTurns > 0
  let minTurnStep = 0;
  if (turnStepRing && turnStepRing.count >= effectiveLastTurns && turnStepRing.count > 0) {
    minTurnStep = turnStepRing.toArray()[0];
  }

  if (truncatedCandidateSteps.length > 0) {
    const remaining = minTurnStep > 0
      ? truncatedCandidateSteps.filter((idx) => idx >= minTurnStep)
      : truncatedCandidateSteps;
    for (let i = 0; i < remaining.length; i += 500) {
      await flushTruncatedCandidates(remaining.slice(i, i + 500));
    }
  }

  // Merge compact matches and hydrated truncated-tail matches
  const compactItems = compactRing.toArray().filter((it) => {
    const idx = it.step_index !== undefined ? it.step_index : (it._ordinal || 0);
    return idx >= minTurnStep;
  });
  const tailItems = hydratedMatchesRing.toArray().filter((it) => {
    const idx = it.step_index !== undefined ? it.step_index : (it._ordinal || 0);
    return idx >= minTurnStep;
  });

  const mergedMap = new Map();
  for (const it of compactItems) {
    const key = it.step_index !== undefined ? it.step_index : `ord:${it._ordinal}`;
    mergedMap.set(key, it);
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

  // Auto-dereferencing for full rendering mode (or when fullArgs / field requires untruncated tool calls)
  if (mode === "auto" && (!summaryOnly || effectiveFullArgs || normalizedField) && filePath !== fullSiblingPath) {
    const hydrateIndices = new Set();
    for (const it of finalItems) {
      if (it.step_index === undefined) continue;
      const hasTruncated = Array.isArray(it.truncated_fields) && it.truncated_fields.length > 0;
      const needsFullTools = (effectiveFullArgs || normalizedField) && Array.isArray(it.tool_calls) && it.tool_calls.length > 0;
      if (hasTruncated || needsFullTools || normalizedField) {
        hydrateIndices.add(it.step_index);
      }
    }
    if (hydrateIndices.size > 0 && fs.existsSync(fullSiblingPath)) {
      const fullMap = await batchFindFullSteps(fullSiblingPath, hydrateIndices);
      for (let i = 0; i < finalItems.length; i++) {
        const it = finalItems[i];
        if (it && fullMap.has(it.step_index)) {
          finalItems[i] = fullMap.get(it.step_index);
        }
      }
    }
  }

  if (summaryOnly) {
    const summaryLines = [];
    const displayedItems = [];
    const buildSummaryHeader = (shownCount) => [
      `## Transcript Query Summary: \`${convId}\``,
      `- Filter: query=${query ? `"${query}"` : "NONE"}, roles=[${Array.from(roleSet).join(", ")}], mode=${mode}`,
      `- Matched Steps: ${matchedCount} (showing ${shownCount} in compact summary mode)`,
      "",
      "---",
      ""
    ].join("\n");

    let currentLength = buildSummaryHeader(finalItems.length).length + 8;
    let clamped = false;

    for (const it of finalItems) {
      const step = it.step_index ?? "?";
      const role = normalizeRoleLabel(it);
      const time = it.created_at ? ` (${it.created_at.replace(/\.\d+Z$/, "Z")})` : "";
      const errorBadge = isStructuredErrorItem(it) ? " [ERROR]" : "";

      const parts = [];
      if (it.content) {
        const preview = cleanMessageContent(it.content, 120, { truncationStyle: "ellipsis" }).replace(/\s+/g, " ").trim();
        if (preview) parts.push(preview);
      }
      if (includeThinking && it.thinking) {
        const thinkPreview = cleanMessageContent(it.thinking, 80, { truncationStyle: "ellipsis" }).replace(/\s+/g, " ").trim();
        if (thinkPreview) parts.push(`[thinking: ${thinkPreview}]`);
      }
      const hasTools = Array.isArray(it.tool_calls) && it.tool_calls.length > 0;
      if (hasTools && (effectiveIncludeTools || roleSet.has("tool") || !it.content)) {
        parts.push(`[tools: ${formatCompactToolList(it.tool_calls, { fullArgs: effectiveFullArgs })}]`);
      }

      const line = `- **[Step ${step} | ${role}]**${errorBadge}${time}: ${parts.join(" ") || "(empty)"}`;
      if (currentLength + line.length + 1 > MAX_OUTPUT_CHARS && summaryLines.length > 0) {
        clamped = true;
        break;
      }
      summaryLines.push(line);
      displayedItems.push(it);
      currentLength += line.length + 1;
    }

    let output = buildSummaryHeader(summaryLines.length) + summaryLines.join("\n");
    if (clamped) {
      output += "\n\n... [Query results clamped at 24 KB safety ceiling] ...";
    }

    return {
      convId,
      filePath,
      mode,
      query: query || null,
      roles: Array.from(roleSet),
      matchedCount,
      displayedCount: summaryLines.length,
      clamped,
      items: displayedItems,
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

  const blocks = [];
  const displayedItems = [];
  let currentLength = buildResultsHeader(finalItems.length).length + 8;
  let clamped = false;

  for (let i = finalItems.length - 1; i >= 0; i--) {
    const block = formatTranscriptItem(finalItems[i], {
      includeThinking,
      includeToolCalls: effectiveIncludeTools || roleSet.has("tool"),
      fullArgs: effectiveFullArgs,
      field: normalizedField
    });
    if (currentLength + block.length + 6 > MAX_OUTPUT_CHARS && blocks.length > 0) {
      clamped = true;
      break;
    }
    blocks.unshift(block);
    displayedItems.unshift(finalItems[i]);
    currentLength += block.length + 6;
  }

  let output = buildResultsHeader(blocks.length) + blocks.join("\n\n---\n\n");
  if (clamped) {
    output += "\n\n... [Query results clamped at 24 KB safety ceiling] ...";
  }

  return {
    convId,
    filePath,
    mode,
    query: query || null,
    roles: Array.from(roleSet),
    matchedCount,
    displayedCount: blocks.length,
    clamped,
    items: displayedItems,
    text: output
  };
}

/**
 * Exact parity with scripts/execution-guard-hook.mjs `getRequiredBackoffSeconds`.
 */
export function getRequiredBackoffSeconds(pollCount) {
  if (pollCount <= 0) return 0;
  return Math.min(600, Math.round(30 * Math.pow(2.5, Math.max(0, pollCount - 1))));
}

/**
 * Exact parity with scripts/execution-guard-hook.mjs `isTaskPollSchedule`.
 */
export function isTaskPollSchedule(args = {}) {
  const prompt = String(args.Prompt || args.prompt || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
  const cond = String(args.TimerCondition || args.timerCondition || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
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
 * Unified Context Health & Proportional Backoff Evaluator (ACS-MCP-01, ACS-HOOK-12).
 */
export async function checkContextHealth({
  conversationId,
  transcriptPath,
  filePath: explicitFile,
  allowExternalPaths = false
} = {}) {
  const resolved = explicitFile
    ? resolveTranscriptPath(null, "compact", { explicitFile, allowExternalPaths })
    : resolveTranscriptPath(transcriptPath || conversationId || "current", "compact", {
        allowExternalPaths: allowExternalPaths || Boolean(transcriptPath)
      });

  if (resolved.error) {
    return { isError: true, text: resolved.error, error: resolved.error, candidates: resolved.candidates };
  }

  const { filePath, convId } = resolved;
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

  // Simulated hook backoff ledger state across transcript timestamps
  let pollCount = 0;
  let lastPollMs = null;

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
                if (!hasValidTs) {
                  // Un-timestamped manage_task(status) cannot prove backoff compliance
                  pollingViolations++;
                } else {
                  const requiredBackoffSec = Math.max(30, getRequiredBackoffSeconds(pollCount));
                  const elapsedSec = lastPollMs !== null ? (stepTsMs - lastPollMs) / 1000 : Infinity;
                  if (elapsedSec < requiredBackoffSec) {
                    pollingViolations++;
                  } else {
                    legalChecks++;
                    pollCount++;
                    lastPollMs = stepTsMs;
                  }
                }
              }
            } else if (name === "schedule" && isTaskPollSchedule(tcArgs)) {
              const duration = Number(tcArgs.DurationSeconds || tcArgs.durationSeconds || tcArgs.duration || 0);
              const requiredBackoffSec = Math.max(30, getRequiredBackoffSeconds(pollCount));
              if (!Number.isFinite(duration) || duration < requiredBackoffSec) {
                pollingViolations++;
              } else {
                legalChecks++;
              }
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
  let healthStatus = "HEALTHY";
  if (pollingViolations > 3) {
    healthStatus = "CRITICAL (Active Polling Loops Detected)";
  } else if (pollingViolations > 0 && userTurns > 40) {
    healthStatus = "WARNING (High Turn Budget & Polling Violations Detected)";
  } else if (pollingViolations > 0) {
    healthStatus = "WARNING (Polling Violations Detected)";
  } else if (userTurns > 40) {
    healthStatus = "WARNING (High Turn Budget)";
  }

  const rtkInfo = findExistingRtk();
  const reportLines = [
    `### Context Health Report: ${healthStatus}`,
    "",
    "#### [Active Session Metrics]",
    `- Total Steps: ${totalSteps}`,
    `- User Turns: ${userTurns}`,
    `- Assistant Responses: ${modelTurns}`,
    `- Tool Calls: ${toolCalls}`,
    `- Detected Busy-Polling Events: ${pollingViolations}`,
    `- Legal Backoff-Compliant Checks/Watchdogs: ${legalChecks}`,
    `- Approximate Raw Transcript Size: ${kb} KB`
  ];

  if (corruptLines > 0) {
    reportLines.push(`- Corrupted/Unparsed Lines: ${corruptLines}`);
  }

  reportLines.push("");
  reportLines.push("#### [Local RTK Environment]");
  reportLines.push(`- RTK Command Optimizer: ${rtkInfo ? `Active (${rtkInfo.version})` : "Missing (run agy-context setup)"}`);
  reportLines.push(`- Note: Lifetime token gains from 'rtk gain' represent cumulative machine-wide host savings, not single-session metrics.`);
  reportLines.push("");

  if (pollingViolations > 0) {
    reportLines.push("⚠️ Recommendation: Background polling violations detected! Cease premature manage_task(status) or short schedule polling calls and yield execution to native Reactive Wakeup.");
  }
  if (userTurns >= 35) {
    reportLines.push("💡 Recommendation: Turn budget approaching threshold. Summarize progress and continue in a fresh conversation to preserve context.");
  }
  if (pollingViolations === 0 && userTurns < 35 && healthStatus === "HEALTHY") {
    reportLines.push("✓ Context footprint is well-managed.");
  }

  return {
    convId,
    filePath,
    status: healthStatus,
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
    rtkInfo: rtkInfo || null,
    reportText: reportLines.join("\n"),
    text: reportLines.join("\n")
  };
}
