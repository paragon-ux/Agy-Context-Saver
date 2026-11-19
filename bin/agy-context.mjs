#!/usr/bin/env node

/**
 * Agy-Context-Saver CLI (v2.0.4)
 *
 * Local-first CLI for streaming transcript inspection, forensic querying,
 * context health diagnostics, and lifecycle management.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readTranscript,
  queryTranscript,
  getStepDetail,
  checkContextHealth,
  getBrainDir,
  getBrainDirs,
  getProfileHomeDir,
  listTranscriptConversations,
  exportSanitizedTranscript,
  manageTranscriptAccessPolicy,
  consumeTranscriptAccessGrant,
  INLINE_SAFE_CHARS,
  MAX_BOUNDED_READ_STEPS,
  MAX_DEEP_OUTPUT_CHARS,
  MAX_FIELD_CHARS,
  utf8SliceToBytes
} from "../lib/transcript-core.mjs";
import { getStateDir } from "../scripts/state-dir.mjs";
import {
  runInstall,
  runUninstall,
  runStatus,
  runRestoreBackups
} from "../scripts/install-register.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgPath = path.resolve(__dirname, "../package.json");

function getVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version || "2.0.4";
  } catch {
    return "2.0.4";
  }
}

function printHelp() {
  const version = getVersion();
  console.log(`Agy-Context-Saver CLI (v${version})

Usage:
  agy-context <command> [options]

Transcript Commands:
  agy-context transcript read   [--id <conv>] [--mode compact|full] [--last-turns N] [--offset N] [--limit N] [--outline] [--include-thinking] [--full] [--max-chars N] [--out <path>] [--json] [--file <path>]
  agy-context transcript query  [--id <conv>] [--query <regex>] [--roles csv] [--mode auto|compact|full] [--start N] [--end N] [--last-turns N] [--limit N] [--summary] [--include-tools] [--full-args] [--field content|thinking|tool_calls|tool_args|tool_args:<Key>|all] [--include-thinking] [--full] [--max-chars N] [--out <path>] [--json] [--file <path>]
  agy-context transcript step   [--id <conv>] (--step <N|N,M|N-M|N..M> | --start N --end M) [--field content|thinking|tool_calls|tool_args|tool_args:<Key>|all] [--head N] [--tail N] [--line-start N] [--line-end N] [--full] [--max-chars N] [--out <path>] [--json] [--file <path>]
  agy-context transcript health [--id <conv>] [--json] [--file <path>]
  agy-context transcript list   [--limit N] [--parent <id>] [--lineage] [--json]
  agy-context transcript export [<id>] [--id <conv[,conv...]>] [--parent <id>] --sanitized [--start N] [--end N] [--limit N] [--full] [--max-chars N] [--out|--output <path>] [--file <path>] [--json]
  agy-context transcript access [--status | --off | --on | --reset | --self-only | --mode <open|allowlist|self-only|deny> | --allow <id,@roster*...> | --deny <id,@roster*...> | --ttl <sec>] [--json]
  Aliases: grep/search/find -> query | stats/info -> health | tools -> query --roles assistant --field tool_args | outline/summary -> query --summary --include-tools | ls -> list | dump -> export | policy -> access

Lifecycle Commands:
  agy-context status            [--json]
  agy-context setup             [--check] [--allow-degraded]
  agy-context uninstall         [--restore-backups]
  agy-context restore-backups
  agy-context --help | -h | --version | -v
`);
}

function parseFlags(argv, spec) {
  const opts = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("-") || token === "-") {
      positional.push(token);
      continue;
    }

    if (token === "-h") {
      opts.help = true;
      continue;
    }
    if (token === "-v") {
      opts.version = true;
      continue;
    }
    if (token === "-c") {
      if (!spec.booleans.has("check")) {
        throw new Error(`Unknown flag '-c' for this command.`);
      }
      opts.check = true;
      continue;
    }

    if (!token.startsWith("--")) {
      throw new Error(`Unknown option '${token}'.`);
    }

    const eqIdx = token.indexOf("=");
    const key = eqIdx === -1 ? token.slice(2) : token.slice(2, eqIdx);
    const inlineVal = eqIdx === -1 ? null : token.slice(eqIdx + 1);

    if (key === "help") {
      if (inlineVal !== null) {
        throw new Error(`Boolean flag '--help' does not accept value '${inlineVal}'.`);
      }
      opts.help = true;
      continue;
    }
    if (key === "version") {
      if (inlineVal !== null) {
        throw new Error(`Boolean flag '--version' does not accept value '${inlineVal}'.`);
      }
      opts.version = true;
      continue;
    }

    if (spec.booleans.has(key)) {
      if (inlineVal !== null) {
        if (inlineVal !== "true" && inlineVal !== "false") {
          throw new Error(`Boolean flag '--${key}' does not accept value '${inlineVal}'.`);
        }
        opts[key] = inlineVal === "true";
      } else {
        opts[key] = true;
      }
      continue;
    }

    if (spec.multiValues && spec.multiValues.has(key)) {
      let val = inlineVal;
      if (val === null) {
        if (i + 1 >= argv.length) {
          throw new Error(`Missing value for flag '--${key}'.`);
        }
        val = argv[++i];
      }
      if (!Array.isArray(opts[key])) opts[key] = [];
      opts[key].push(val);
      continue;
    }

    if (spec.values.has(key)) {
      let val = inlineVal;
      if (val === null) {
        if (i + 1 >= argv.length) {
          throw new Error(`Missing value for flag '--${key}'.`);
        }
        val = argv[++i];
      }
      opts[key] = val;
      continue;
    }

    throw new Error(`Unknown flag '--${key}'.`);
  }

  return { opts, positional };
}

function assertCleanHelp(opts, positional) {
  const extraKeys = Object.keys(opts).filter((k) => k !== "help");
  if (extraKeys.length > 0 || positional.length > 0) {
    throw new Error("Conflicting flags: '--help' cannot be combined with operational flags or arguments.");
  }
}

function parseOptionalInt(val, flagName) {
  if (val === undefined) return undefined;
  if (typeof val === "boolean" || (typeof val === "string" && val.trim() === "")) {
    throw new Error(`Flag '--${flagName}' must be an integer (received: '${val}').`);
  }
  const num = Number(val);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new Error(`Flag '--${flagName}' must be an integer (received: '${val}').`);
  }
  return num;
}

function parseNonNegInt(val, flagName) {
  const num = parseOptionalInt(val, flagName);
  if (num !== undefined && num < 0) {
    throw new Error(`Flag '--${flagName}' must be a non-negative integer (received: '${val}').`);
  }
  return num;
}

function parsePositiveInt(val, flagName) {
  const num = parseOptionalInt(val, flagName);
  if (num !== undefined && num <= 0) {
    throw new Error(`Flag '--${flagName}' must be a positive integer (received: '${val}').`);
  }
  return num;
}

function validateExplicitFileFlag(fileArg) {
  if (fileArg === undefined) return undefined;
  const trimmed = String(fileArg).trim();
  if (!trimmed || !trimmed.toLowerCase().endsWith(".jsonl")) {
    throw new Error(`Invalid --file '${fileArg}': must be an existing .jsonl transcript file.`);
  }
  const resolved = path.resolve(trimmed);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Transcript file not found at --file '${resolved}'.`);
  }
  const real = fs.realpathSync(resolved);
  if (!fs.statSync(real).isFile()) {
    throw new Error(`Invalid --file '${resolved}': target is not a regular file.`);
  }
  return real;
}

function normalizeWinDevicePath(p) {
  let s = String(p || "");
  if (/^\\\\\?\\UNC\\/i.test(s)) {
    return "\\\\" + s.slice(8);
  }
  if (/^\\\\[?.]\\/.test(s)) {
    return s.slice(4);
  }
  return s;
}

function hasUncOrDevicePrefix(p) {
  const s = String(p || "").trim();
  return /^(?:\\\\|\/\/)/.test(s) || /^[\\/]{2}[?.][\\/]/.test(s);
}

function isInsideDirCaseAware(targetPath, baseDir) {
  const cleanTarget = normalizeWinDevicePath(targetPath);
  const cleanBase = normalizeWinDevicePath(baseDir);
  if (hasUncOrDevicePrefix(cleanTarget) || hasUncOrDevicePrefix(cleanBase)) {
    return false;
  }
  const norm = (p) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
  const rel = path.relative(norm(cleanBase), norm(cleanTarget));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isProtectedBenchmarkOutPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const normalized = targetPath.replace(/\\/g, "/");
  return (
    /(?:^|\/)(?:benchmarks?|evaluators?|evaluation|scoring|ground_truth|prompt_templates)(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)(?:eval_[^/]+\.(?:py|json|toml)|bench_[^/]+\.(?:py|json|toml))$/i.test(normalized)
  );
}

function isProtectedInternalOutPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const normalized = targetPath.replace(/\\/g, "/");
  return (
    /(?:^|\/)\.system_generated(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)\.git(?:\/|$)/i.test(normalized) ||
    /\/\.gemini\/(?:config|antigravity(?:-cli|-ide)?)\/(?:hooks\.json(?:\.bak)?|mcp_config\.json|config\.json)$/i.test(normalized) ||
    /\/\.gemini\/config\/scripts\/execution-guard-hook\.mjs$/i.test(normalized) ||
    /(?:^|\/)hooks\.json$/i.test(normalized) ||
    isProtectedBenchmarkOutPath(normalized)
  );
}

function resolveWithExistingAncestor(targetPath) {
  const absTarget = path.resolve(targetPath);
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

function validateSafeExportOutPath(outArg) {
  if (outArg === undefined) return undefined;
  const trimmed = String(outArg).trim();
  if (!trimmed || trimmed.includes("\0")) {
    throw new Error(`Invalid --out path '${outArg}'.`);
  }
  if (hasUncOrDevicePrefix(trimmed)) {
    throw new Error(`Invalid --out path '${outArg}': UNC and device paths are prohibited.`);
  }
  const segments = trimmed.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error(`Invalid --out path '${outArg}': '..' traversal is prohibited.`);
  }
  if (!/\.(?:md|json|txt)$/i.test(trimmed)) {
    throw new Error(`Invalid --out path '${outArg}': must end with .md, .json, or .txt.`);
  }
  const abs = path.resolve(trimmed);
  if (hasUncOrDevicePrefix(abs)) {
    throw new Error(`Invalid --out path '${outArg}': UNC and device paths are prohibited.`);
  }
  if (isProtectedInternalOutPath(abs)) {
    throw new Error(`Refusing '--out' inside protected internal, governance, or benchmark directory: '${abs}'.`);
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

  let absLst = null;
  try {
    absLst = fs.lstatSync(abs);
  } catch {}

  if (absLst) {
    if (absLst.isSymbolicLink() || !absLst.isFile()) {
      throw new Error(`Invalid --out path '${abs}': refusing symlink or non-regular file.`);
    }
    const realTarget = fs.realpathSync(abs);
    if (hasUncOrDevicePrefix(realTarget) || isProtectedInternalOutPath(realTarget)) {
      throw new Error(`Refusing '--out' inside protected internal, governance, or benchmark directory: '${realTarget}'.`);
    }
    for (const pr of protectedRoots) {
      if (isInsideDirCaseAware(realTarget, pr)) {
        throw new Error(`Refusing '--out' inside protected governance/state directory: '${realTarget}'.`);
      }
    }
  } else {
    const resolvedTarget = resolveWithExistingAncestor(abs);
    if (hasUncOrDevicePrefix(resolvedTarget) || isProtectedInternalOutPath(resolvedTarget)) {
      throw new Error(`Refusing '--out' inside protected internal, governance, or benchmark directory: '${resolvedTarget}'.`);
    }
    for (const pr of protectedRoots) {
      if (isInsideDirCaseAware(resolvedTarget, pr)) {
        throw new Error(`Refusing '--out' inside protected governance/state directory: '${resolvedTarget}'.`);
      }
    }
  }
  return abs;
}

let pendingErrorGrantContext = null;

function emitError(message, asJson = false, extra = {}) {
  consumeTranscriptAccessGrant(pendingErrorGrantContext || undefined);
  if (asJson) {
    console.error(JSON.stringify({ isError: true, error: message, ...extra }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(1);
}

function resolveOutFlag(opts) {
  if (opts.out !== undefined && opts.output !== undefined && opts.out !== opts.output) {
    throw new Error("Conflicting '--out' and '--output' values provided.");
  }
  const rawOut = opts.out !== undefined ? opts.out : opts.output;
  const safeOutPath = validateSafeExportOutPath(rawOut);
  return { rawOut, safeOutPath };
}

function parseMaxCharsFlag(opts) {
  const raw = opts["max-chars"];
  if (raw === undefined) return undefined;
  const parsed = parsePositiveInt(raw, "max-chars");
  if (parsed > MAX_DEEP_OUTPUT_CHARS) {
    throw new Error(`Flag '--max-chars' exceeds 512 KB ceiling (${MAX_DEEP_OUTPUT_CHARS} bytes; received: '${raw}').`);
  }
  return parsed;
}

function serializeBoundedJsonPayload(payload, maxBytes, { readPageSize, summaryStart, summaryEnd, summaryDirection } = {}) {
  const encode = (obj, indent) => JSON.stringify(obj, null, indent) + "\n";
  const fits = (text) => Buffer.byteLength(text, "utf8") <= maxBytes;
  const pretty = encode(payload, 2);
  if (fits(pretty)) return { content: pretty };
  const compact = encode(payload);
  if (fits(compact)) return { content: compact };

  const key = Array.isArray(payload.items) ? "items" : "steps";
  const entries = payload[key];
  const total = entries?.length || (payload.stepIndex !== undefined ? 1 : 0);
  const meta = (included) => ({
    jsonTruncated: true,
    jsonItemsIncluded: included,
    jsonItemsTotal: total,
    jsonTruncatedReason: "Output exceeds the byte budget. Use a larger budget or a narrower selection."
  });

  if (entries?.length) {
    const isBatch = Array.isArray(payload.stepIndices);
    const isRead = payload.displayedSteps !== undefined;
    const hasBackwardSummaryCursor =
      summaryDirection === "backward" ||
      Boolean(payload.nextCursor && payload.nextCursor.end !== undefined && payload.nextCursor.start === undefined);
    const forward = isBatch || readPageSize !== undefined ||
      (!hasBackwardSummaryCursor && (summaryEnd !== undefined || payload.nextCursor?.start !== undefined));
    const stepNumber = (entry) => Number(entry.step_index ?? entry._ordinal ?? 0);

    const build = (count) => {
      const retained = forward ? entries.slice(0, count) : entries.slice(entries.length - count);
      const page = { ...payload, [key]: retained, clamped: true, ...meta(count) };
      if (count < total) {
        if (isBatch) {
          const skipIdx = count > 0 ? count : 1;
          const pending = entries.slice(skipIdx).map((entry) => entry.stepIndex);
          if (payload.nextCursor) pending.push(payload.nextCursor.step);
          if (pending.length > 0) {
            page.nextCursor = { step: pending.join(",") };
          } else {
            delete page.nextCursor;
          }
        } else if (isRead && forward) {
          if (count > 0) {
            page.nextCursor = {
              offset: retained.at(-1)._fileOrd + 1,
              limit: readPageSize
            };
          } else if (entries.length > 1 || payload.nextCursor) {
            page.nextCursor = {
              offset: entries[0]._fileOrd + 1,
              limit: readPageSize
            };
          } else {
            delete page.nextCursor;
          }
        } else if (isRead && count) {
          const first = retained[0]._fileOrd;
          if (first > 0) {
            const limit = Math.min(MAX_BOUNDED_READ_STEPS, first);
            page.nextCursor = { offset: 0, limit };
          } else {
            delete page.nextCursor;
          }
        } else if (isRead) {
          const lastOrd = entries.at(-1)._fileOrd;
          if (lastOrd > 0) {
            page.nextCursor = { offset: 0, limit: Math.min(MAX_BOUNDED_READ_STEPS, lastOrd) };
          } else {
            delete page.nextCursor;
          }
        } else if (forward) {
          if (count > 0 || entries.length > 1) {
            const nextIdx = count > 0 ? count : 1;
            page.nextCursor = {
              start: stepNumber(entries[nextIdx]),
              end: payload.nextCursor?.start !== undefined ? payload.nextCursor.end : summaryEnd
            };
          } else if (payload.nextCursor?.start !== undefined) {
            page.nextCursor = { ...payload.nextCursor };
          } else {
            delete page.nextCursor;
          }
        } else {
          const nextEnd = count ? stepNumber(retained[0]) - 1 : stepNumber(entries.at(-1)) - 1;
          const minStart = payload.nextCursor?.start ?? summaryStart ?? 0;
          if (nextEnd >= minStart) {
            page.nextCursor = minStart > 0 ? { start: minStart, end: nextEnd } : { end: nextEnd };
          } else {
            delete page.nextCursor;
          }
        }
      }
      if (isBatch) {
        page.data = payload.data.slice(0, count);
        page.stepIndices = retained.map((entry) => entry.stepIndex);
        page.stepIndex = retained[0]?.stepIndex ?? null;
      } else if (isRead) {
        page.displayedSteps = count;
      } else {
        page.displayedCount = count;
      }
      return page;
    };

    const fitCount = (indent) => {
      let lo = 0;
      let hi = total;
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (fits(encode(build(mid), indent))) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const prettyCount = fitCount(2);
    if (prettyCount > 0) {
      const page = build(prettyCount);
      return { content: encode(page, 2), metadata: page };
    }
    const compactCount = fitCount();
    const page = build(compactCount);
    if (compactCount === 0) {
      const prettyZero = encode(page, 2);
      if (fits(prettyZero)) return { content: prettyZero, metadata: page };
    }
    const content = encode(page);
    if (fits(content)) return { content, metadata: page };
  } else if (payload.stepIndex !== undefined) {
    // A single step can carry its selected field without duplicating the entire raw step.
    const { step, data, ...header } = payload;
    const selected = { ...header, data, clamped: true, ...meta(1) };
    const prettySelected = encode(selected, 2);
    if (fits(prettySelected)) return { content: prettySelected, metadata: selected };
    const content = encode(selected);
    if (fits(content)) return { content, metadata: selected };
    const summary = { ...header, clamped: true, ...meta(0) };
    const prettySummary = encode(summary, 2);
    if (fits(prettySummary)) return { content: prettySummary, metadata: summary };
    const summaryContent = encode(summary);
    if (fits(summaryContent)) return { content: summaryContent, metadata: summary };
  }

  throw new Error(`The ${maxBytes}-byte budget is too small for transcript JSON metadata. Increase --max-chars or narrow the selection.`);
}

function serializeTranscriptResult(res, asJson, maxBytes, pageOptions) {
  if (asJson) {
    if (typeof res._serializedJson === "string") {
      const { text, _serializedJson, _serializedMarkdown, _summaryDirection, ...payload } = res;
      return { content: _serializedJson, metadata: payload };
    }
    const { text, _serializedJson, _serializedMarkdown, _summaryDirection, ...payload } = res;
    return serializeBoundedJsonPayload(payload, maxBytes, { ...pageOptions, summaryDirection: _summaryDirection });
  }

  if (typeof res._serializedMarkdown === "string") {
    return { content: res._serializedMarkdown };
  }
  const content = res.text + "\n";
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return { content };
  const next = Object.entries(res.nextCursor ?? {}).map(([flag, value]) => `--${flag} ${value}`).join(" ");
  const nextHint = next ? `; next: ${next}` : "";
  const notice = `\n\n[Output clamped at ${maxBytes} bytes${nextHint}; use a larger --max-chars or narrow the selection.]\n`;
  const available = maxBytes - Buffer.byteLength(notice, "utf8");
  const heading = res.text.split("\n", 1)[0];
  if (available <= Buffer.byteLength(heading, "utf8")) {
    throw new Error(`The ${maxBytes}-byte budget is too small for transcript Markdown metadata. Increase --max-chars or narrow the selection.`);
  }
  return { content: utf8SliceToBytes(res.text, available).trimEnd() + notice };
}

function writeSafeTranscriptOutFile(rawOut, safeOutPath, res, asJson = false, {
  label = "transcript output",
  customMessage = null,
  maxBytes = MAX_DEEP_OUTPUT_CHARS,
  ...pageOptions
} = {}) {
  const { content, metadata } = serializeTranscriptResult(res, asJson, maxBytes, pageOptions);
  validateSafeExportOutPath(rawOut);
  fs.mkdirSync(path.dirname(safeOutPath), { recursive: true });
  validateSafeExportOutPath(rawOut);
  const tmpOut = `${safeOutPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmpOut, content, { encoding: "utf8", flag: "wx" });
    fs.renameSync(tmpOut, safeOutPath);
  } catch (err) {
    try { fs.unlinkSync(tmpOut); } catch {}
    throw err;
  }

  const bytesWritten = Buffer.byteLength(content, "utf8");
  if (asJson) {
    const {
      text,
      steps,
      items,
      sessions,
      step,
      data,
      _serializedJson,
      _serializedMarkdown,
      _summaryDirection,
      ...compactMeta
    } = metadata ?? res;
    console.log(JSON.stringify({
      ...compactMeta,
      outputPath: safeOutPath,
      bytesWritten,
      charsWritten: content.length
    }, null, 2));
  } else {
    console.log(customMessage || `[OK] Wrote ${label} (${bytesWritten} bytes) to: ${safeOutPath}`);
  }
}

function emitTranscriptResult(res, asJson, rawOut, safeOutPath, options) {
  if (res.isError) {
    emitError(res.text, asJson, res.candidates ? { candidates: res.candidates } : {});
  }
  if (safeOutPath) {
    writeSafeTranscriptOutFile(rawOut, safeOutPath, res, asJson, options);
  } else {
    process.stdout.write(serializeTranscriptResult(res, asJson, options.maxBytes, options).content);
  }
}

async function handleTranscriptCommand(argv) {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    if (argv.length > 1) {
      throw new Error("Conflicting flags: '--help' cannot be combined with operational flags or arguments.");
    }
    printHelp();
    process.exit(0);
  }

  const rest = argv.slice(1);
  pendingErrorGrantContext = { subcommand: sub, targetConvId: null };

  if (sub === "read" || sub === "outline" || sub === "summary") {
    pendingErrorGrantContext = { subcommand: sub, targetConvId: null };
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["include-thinking", "outline", "summary", "include-tools", "full-args", "full", "json"]),
      values: new Set(["id", "mode", "last-turns", "last", "tail", "offset", "limit", "start", "end", "max-chars", "out", "output", "file"])
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      consumeTranscriptAccessGrant({ subcommand: sub });
      printHelp();
      process.exit(0);
    }
    if (opts.id === undefined && positional.length === 1) {
      opts.id = positional.shift();
    }
    pendingErrorGrantContext = { subcommand: sub, targetConvId: opts.id || null };
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript ${sub}': ${positional.join(" ")}`);
    }
    const explicitFile = validateExplicitFileFlag(opts.file);
    const { rawOut, safeOutPath } = resolveOutFlag(opts);
    const parsedMaxChars = parseMaxCharsFlag(opts);
    const isFull = Boolean(opts.full);
    const effectiveMaxChars = parsedMaxChars ?? (safeOutPath || isFull ? MAX_DEEP_OUTPUT_CHARS : INLINE_SAFE_CHARS);
    const limit = parsePositiveInt(opts.limit, "limit");

    if (sub === "outline" || sub === "summary" || opts.outline || opts.summary) {
      const startStep = parseNonNegInt(opts.start, "start");
      const endStep = parseNonNegInt(opts.end, "end");
      if (startStep !== undefined && endStep !== undefined && endStep < startStep) {
        throw new Error(`Invalid step range '--start ${startStep} --end ${endStep}': '--end' must be >= '--start'.`);
      }
      const res = await queryTranscript({
        conversationId: opts.id,
        filePath: explicitFile,
        startStep: startStep !== undefined ? startStep : 0,
        endStep: endStep !== undefined ? endStep : 999999,
        maxResults: limit !== undefined ? limit : ((isFull || safeOutPath) ? 2000 : 500),
        summaryOnly: true,
        includeToolCalls: true,
        fullArgs: Boolean(opts["full-args"]),
        full: isFull,
        maxOutputChars: effectiveMaxChars,
        includeThinking: Boolean(opts["include-thinking"]),
        allowExternalPaths: false,
        subcommand: sub
      });
      emitTranscriptResult(res, Boolean(opts.json), rawOut, safeOutPath, {
        label: `transcript ${sub}`,
        maxBytes: effectiveMaxChars,
        summaryStart: startStep ?? 0,
        summaryEnd: endStep ?? 999999
      });
      return;
    }

    const mode = opts.mode || "compact";
    if (mode !== "compact" && mode !== "full") {
      throw new Error(`Invalid --mode '${mode}' for 'transcript read' (expected 'compact' or 'full').`);
    }
    const rawLastTurns = opts["last-turns"] !== undefined ? opts["last-turns"] : (opts.last !== undefined ? opts.last : opts.tail);
    const lastTurns = parseNonNegInt(rawLastTurns, "last-turns");
    const offset = parseNonNegInt(opts.offset, "offset");

    const res = await readTranscript({
      conversationId: opts.id,
      filePath: explicitFile,
      mode,
      lastTurns: lastTurns !== undefined ? lastTurns : 3,
      offset,
      limit,
      includeThinking: Boolean(opts["include-thinking"]),
      full: isFull,
      maxOutputChars: effectiveMaxChars,
      allowExternalPaths: false
    });

    emitTranscriptResult(res, Boolean(opts.json), rawOut, safeOutPath, {
      label: `transcript read (${res.mode})`,
      maxBytes: effectiveMaxChars,
      readPageSize: offset !== undefined || limit !== undefined ? Math.min(MAX_BOUNDED_READ_STEPS, limit ?? 50) : undefined
    });
    return;
  }

  if (sub === "query" || sub === "grep" || sub === "search" || sub === "find" || sub === "tools") {
    pendingErrorGrantContext = { subcommand: sub, targetConvId: null };
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["summary", "outline", "include-tools", "full-args", "include-thinking", "full", "json"]),
      values: new Set(["id", "query", "roles", "mode", "start", "end", "last-turns", "last", "tail", "limit", "field", "max-chars", "out", "output", "file"])
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      consumeTranscriptAccessGrant({ subcommand: sub });
      printHelp();
      process.exit(0);
    }
    if (sub === "grep" || sub === "search" || sub === "find") {
      opts["include-tools"] = true;
    }
    if (sub === "tools") {
      if (!opts.roles) opts.roles = "assistant";
      if (!opts.field) opts.field = "tool_args";
      opts["include-tools"] = true;
      if (opts.limit === undefined) opts.limit = (Boolean(opts.full) || opts.out !== undefined || opts.output !== undefined) ? "2000" : "500";
      if (opts.start === undefined && opts.last === undefined && opts["last-turns"] === undefined && opts.tail === undefined) {
        opts.start = "0";
        if (opts.end === undefined) opts.end = "999999";
      }
    }
    if (opts.query === undefined && positional.length >= 1) {
      opts.query = positional.shift();
    }
    if (opts.id === undefined && positional.length >= 1) {
      opts.id = positional.shift();
    }
    pendingErrorGrantContext = { subcommand: sub, targetConvId: opts.id || null };
    const isFull = Boolean(opts.full);
    const { rawOut, safeOutPath } = resolveOutFlag(opts);
    const parsedMaxChars = parseMaxCharsFlag(opts);
    const effectiveMaxChars = parsedMaxChars ?? (safeOutPath || isFull ? MAX_DEEP_OUTPUT_CHARS : INLINE_SAFE_CHARS);
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript ${sub}': ${positional.join(" ")}`);
    }
    const mode = opts.mode || "auto";
    if (mode !== "auto" && mode !== "compact" && mode !== "full") {
      throw new Error(`Invalid --mode '${mode}' for 'transcript query' (expected 'auto', 'compact', or 'full').`);
    }
    const explicitFile = validateExplicitFileFlag(opts.file);
    const startStep = parseNonNegInt(opts.start, "start");
    const endStep = parseNonNegInt(opts.end, "end");
    if (startStep !== undefined && endStep !== undefined && endStep < startStep) {
      throw new Error(`Invalid step range '--start ${startStep} --end ${endStep}': '--end' must be >= '--start'.`);
    }
    const rawLastTurns = opts["last-turns"] !== undefined ? opts["last-turns"] : (opts.last !== undefined ? opts.last : opts.tail);
    const lastTurns = parseNonNegInt(rawLastTurns, "last-turns");
    const maxResults = parsePositiveInt(opts.limit, "limit");
    const roles = opts.roles
      ? opts.roles.split(",").map((r) => r.trim()).filter(Boolean)
      : ["all"];

    const res = await queryTranscript({
      conversationId: opts.id,
      filePath: explicitFile,
      query: opts.query,
      roles,
      mode,
      startStep,
      endStep,
      lastTurns,
      maxResults,
      summaryOnly: Boolean(opts.summary || opts.outline),
      includeToolCalls: Boolean(opts["include-tools"]),
      fullArgs: Boolean(opts["full-args"]),
      full: isFull,
      maxOutputChars: effectiveMaxChars,
      field: opts.field,
      includeThinking: Boolean(opts["include-thinking"]),
      allowExternalPaths: false,
      subcommand: sub
    });

    emitTranscriptResult(res, Boolean(opts.json), rawOut, safeOutPath, {
      label: `transcript ${sub}`,
      maxBytes: effectiveMaxChars,
      summaryStart: (opts.summary || opts.outline) ? startStep : undefined,
      summaryEnd: (opts.summary || opts.outline) && startStep !== undefined ? endStep : undefined
    });
    return;
  }

  if (sub === "step") {
    pendingErrorGrantContext = { subcommand: sub, targetConvId: null };
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["json", "full"]),
      values: new Set(["id", "step", "start", "end", "field", "mode", "tail", "tail-lines", "head", "head-lines", "line-start", "line-end", "max-chars", "out", "output", "file"])
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      consumeTranscriptAccessGrant({ subcommand: sub });
      printHelp();
      process.exit(0);
    }
    if (opts.step === undefined && positional.length >= 1) {
      opts.step = positional.shift();
    }
    if (opts.id === undefined && positional.length >= 1) {
      opts.id = positional.shift();
    }
    pendingErrorGrantContext = { subcommand: sub, targetConvId: opts.id || null };
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript step': ${positional.join(" ")}`);
    }
    const startStep = parseNonNegInt(opts.start, "start");
    const endStep = parseNonNegInt(opts.end, "end");
    if (startStep !== undefined && endStep !== undefined && endStep < startStep) {
      throw new Error(`Invalid step range '--start ${startStep} --end ${endStep}': '--end' must be >= '--start'.`);
    }
    const tailLines = parsePositiveInt(opts["tail-lines"] !== undefined ? opts["tail-lines"] : opts.tail, "tail");
    const headLines = parsePositiveInt(opts["head-lines"] !== undefined ? opts["head-lines"] : opts.head, "head");
    const lineStart = parsePositiveInt(opts["line-start"], "line-start");
    const lineEnd = parsePositiveInt(opts["line-end"], "line-end");
    if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
      throw new Error(`Invalid line slice '--line-start ${lineStart} --line-end ${lineEnd}': '--line-end' must be >= '--line-start'.`);
    }
    if (opts.step === undefined && startStep === undefined && endStep === undefined) {
      throw new Error(`Missing required flag '--step <N|N,M|N-M>' (or '--start N --end M') for 'transcript step'.`);
    }
    const explicitFile = validateExplicitFileFlag(opts.file);
    const { rawOut, safeOutPath } = resolveOutFlag(opts);
    const parsedMaxChars = parseMaxCharsFlag(opts);
    const isFull = Boolean(opts.full);
    const effectiveMaxChars = parsedMaxChars ?? (safeOutPath && !isFull ? MAX_DEEP_OUTPUT_CHARS : undefined);

    const res = await getStepDetail({
      conversationId: opts.id,
      filePath: explicitFile,
      stepIndex: opts.step,
      startStep,
      endStep,
      field: opts.field || "all",
      headLines,
      tailLines,
      lineStart,
      lineEnd,
      full: isFull,
      maxOutputChars: effectiveMaxChars,
      allowExternalPaths: false
    });

    emitTranscriptResult(res, Boolean(opts.json), rawOut, safeOutPath, {
      label: "transcript step",
      maxBytes: effectiveMaxChars ?? (isFull ? MAX_DEEP_OUTPUT_CHARS : MAX_FIELD_CHARS)
    });
    return;
  }

  if (sub === "health" || sub === "stats" || sub === "info") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["json"]),
      values: new Set(["id", "file"])
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (opts.id === undefined && positional.length === 1) {
      opts.id = positional.shift();
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript ${sub}': ${positional.join(" ")}`);
    }
    const explicitFile = validateExplicitFileFlag(opts.file);

    const res = await checkContextHealth({
      conversationId: opts.id,
      filePath: explicitFile,
      allowExternalPaths: false
    });

    if (res.isError) {
      emitError(res.text, Boolean(opts.json), res.candidates ? { candidates: res.candidates } : {});
    }
    if (opts.json) {
      const { text, reportText, ...payload } = res;
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(res.reportText);
    }
    return;
  }

  if (sub === "list" || sub === "ls") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["json", "lineage"]),
      values: new Set(["limit", "parent"])
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript ${sub}': ${positional.join(" ")}`);
    }
    if (opts.parent !== undefined && !String(opts.parent).trim()) {
      throw new Error("Flag '--parent' must be a non-empty conversation ID or 'current'.");
    }
    const parsedLimit = parseOptionalInt(opts.limit, "limit");
    if (parsedLimit !== undefined && parsedLimit <= 0) {
      throw new Error(`Flag '--limit' must be a positive integer (received: '${opts.limit}').`);
    }
    const limit = parsedLimit ?? (opts.parent !== undefined ? 50 : 10);
    const listed = listTranscriptConversations({
      limit,
      parentId: opts.parent,
      includeLineage: Boolean(opts.lineage)
    });
    if (listed.isError) {
      emitError(listed.text || listed.error, Boolean(opts.json));
    }
    const dirLabel = listed.brainDirs.length === 1 ? listed.brainDirs[0] : listed.brainDirs.join(", ");
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            total: listed.total,
            ...(listed.parentFilter ? { parentFilter: listed.parentFilter } : {}),
            ...(listed.includeLineage ? { includeLineage: true } : {}),
            conversations: listed.conversations
          },
          null,
          2
        )
      );
    } else {
      const parentLabel = listed.parentFilter ? ` [parent: ${listed.parentFilter}]` : "";
      const lines = [`Recent Conversations (${listed.conversations.length} of ${listed.total} in ${dirLabel})${parentLabel}:`];
      for (const item of listed.conversations) {
        if (listed.includeLineage) {
          const rosterStr = item.rosterName ? `@${item.rosterName}` : "none";
          const parentStr = item.parentConvId || "none";
          lines.push(
            `- ${item.conversationId} | kind: ${item.sessionKind} | steps: ${item.stepCount} | parent: ${parentStr} | roster: ${rosterStr} | updated: ${item.updatedAt} | ${(item.bytes / 1024).toFixed(1)} KB`
          );
        } else {
          lines.push(`- ${item.conversationId} | updated: ${item.updatedAt} | ${(item.bytes / 1024).toFixed(1)} KB`);
        }
      }
      console.log(lines.join("\n"));
    }
    return;
  }

  if (sub === "export" || sub === "dump") {
    pendingErrorGrantContext = { subcommand: sub, targetConvId: null };
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["sanitized", "full", "json"]),
      values: new Set(["parent", "start", "end", "limit", "max-chars", "out", "output", "file"]),
      multiValues: new Set(["id"])
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      consumeTranscriptAccessGrant({ subcommand: sub });
      printHelp();
      process.exit(0);
    }
    if ((!opts.id || opts.id.length === 0) && !opts.parent && !opts.file && positional.length >= 1) {
      opts.id = [positional.shift()];
    }
    const exportIdsForGrant = (opts.id || [])
      .flatMap((id) => String(id || "").split(","))
      .map((id) => id.trim())
      .filter(Boolean);
    const exportTargetConvId = opts.parent
      ? `parent:${String(opts.parent).trim()}`
      : exportIdsForGrant.length === 1
        ? exportIdsForGrant[0]
        : exportIdsForGrant.length > 1
          ? `multi:${[...new Set(exportIdsForGrant)].sort().join(",")}`
          : null;
    pendingErrorGrantContext = { subcommand: sub, targetConvId: exportTargetConvId };
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript ${sub}': ${positional.join(" ")}`);
    }
    if (opts.parent !== undefined && !String(opts.parent).trim()) {
      throw new Error("Flag '--parent' must be a non-empty conversation ID or 'current'.");
    }
    const { rawOut, safeOutPath } = resolveOutFlag(opts);
    const explicitFile = validateExplicitFileFlag(opts.file);
    const parsedMaxChars = parseMaxCharsFlag(opts);
    const isFull = Boolean(opts.full);
    const effectiveMaxChars = parsedMaxChars ?? (safeOutPath || isFull ? MAX_DEEP_OUTPUT_CHARS : INLINE_SAFE_CHARS);
    const startStep = parseOptionalInt(opts.start, "start");
    const endStep = parseOptionalInt(opts.end, "end");
    if (startStep !== undefined && startStep < 0) {
      throw new Error(`Flag '--start' must be a non-negative integer (received: '${opts.start}').`);
    }
    if (endStep !== undefined && endStep < 0) {
      throw new Error(`Flag '--end' must be a non-negative integer (received: '${opts.end}').`);
    }
    if (startStep !== undefined && endStep !== undefined && endStep < startStep) {
      throw new Error(`Invalid step range '--start ${startStep} --end ${endStep}': '--end' must be >= '--start'.`);
    }
    const limit = parseOptionalInt(opts.limit, "limit");
    if (limit !== undefined && limit <= 0) {
      throw new Error(`Flag '--limit' must be a positive integer (received: '${opts.limit}').`);
    }

    const asJson = Boolean(opts.json);
    const res = await exportSanitizedTranscript({
      conversationIds: opts.id || [],
      parentId: opts.parent,
      filePath: explicitFile,
      sanitized: Boolean(opts.sanitized),
      startStep,
      endStep,
      limit,
      maxOutputChars: effectiveMaxChars,
      outputFormat: asJson ? "json" : "markdown",
      allowExternalPaths: false
    });

    emitTranscriptResult(res, asJson, rawOut, safeOutPath, {
      label: "sanitized transcript export",
      customMessage: safeOutPath
        ? `[OK] Exported sanitized transcript index (${res.exportedCount} session(s)) to: ${safeOutPath}`
        : undefined,
      maxBytes: effectiveMaxChars
    });
    return;
  }

  if (sub === "access" || sub === "policy") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["status", "off", "deny-children", "on", "reset", "self-only", "json"]),
      values: new Set(["mode", "allow", "deny", "ttl"])
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (positional.length === 1 && !opts.status && !opts.off && !opts["deny-children"] && !opts.on && !opts.reset && !opts["self-only"] && opts.mode === undefined) {
      const p0 = positional[0].toLowerCase();
      if (p0 === "status") opts.status = true;
      else if (p0 === "off" || p0 === "deny" || p0 === "lock") opts.off = true;
      else if (p0 === "on" || p0 === "open" || p0 === "reset" || p0 === "unlock") opts.on = true;
      else if (p0 === "self-only") opts["self-only"] = true;
      else throw new Error(`Unexpected positional argument '${positional[0]}' for 'transcript ${sub}'.`);
      positional.shift();
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript ${sub}': ${positional.join(" ")}`);
    }

    const hasMutationFlag =
      Boolean(opts.off) ||
      Boolean(opts["deny-children"]) ||
      Boolean(opts.on) ||
      Boolean(opts.reset) ||
      Boolean(opts["self-only"]) ||
      opts.mode !== undefined ||
      opts.allow !== undefined ||
      opts.deny !== undefined ||
      opts.ttl !== undefined;

    const res = manageTranscriptAccessPolicy({
      status: Boolean(opts.status) || !hasMutationFlag,
      off: Boolean(opts.off),
      denyChildren: Boolean(opts["deny-children"]),
      on: Boolean(opts.on),
      reset: Boolean(opts.reset),
      selfOnly: Boolean(opts["self-only"]),
      mode: opts.mode,
      allow: opts.allow,
      deny: opts.deny,
      ttl: opts.ttl
    });

    if (opts.json) {
      const { text, ...payload } = res;
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(res.text);
    }
    return;
  }

  throw new Error(`Unknown transcript subcommand '${sub}'. Expected read, query, step, health, list, export, or access.`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    if (argv.length > 1) {
      throw new Error("Conflicting flags: '--help' cannot be combined with operational flags or arguments.");
    }
    printHelp();
    process.exit(0);
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    if (argv.length > 1) {
      throw new Error("Conflicting flags: '--version' cannot be combined with operational flags or arguments.");
    }
    console.log(getVersion());
    process.exit(0);
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  if (cmd === "transcript") {
    await handleTranscriptCommand(rest);
    return;
  }

  if (cmd === "status" || cmd === "--status") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["json"]),
      values: new Set()
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected arguments for 'status': ${positional.join(" ")}`);
    }
    const status = runStatus({ silent: Boolean(opts.json) });
    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
    }
    if (!status.isComplete) {
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "setup" || cmd === "install" || cmd === "--install") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["check", "allow-degraded"]),
      values: new Set()
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected arguments for 'setup': ${positional.join(" ")}`);
    }
    await runInstall({
      checkOnly: Boolean(opts.check),
      allowDegraded: Boolean(opts["allow-degraded"])
    });
    return;
  }

  if (cmd === "uninstall" || cmd === "--uninstall") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["restore-backups"]),
      values: new Set()
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected arguments for 'uninstall': ${positional.join(" ")}`);
    }
    await runUninstall({
      restoreBackups: Boolean(opts["restore-backups"])
    });
    return;
  }

  if (cmd === "restore-backups" || cmd === "--restore-backups") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(),
      values: new Set()
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected arguments for 'restore-backups': ${positional.join(" ")}`);
    }
    await runRestoreBackups();
    return;
  }

  throw new Error(`Unknown command '${cmd}'. Run 'agy-context --help' for usage.`);
}

main().catch((err) => {
  const wantsJson = process.argv.includes("--json");
  emitError(err?.message || String(err), wantsJson);
});
