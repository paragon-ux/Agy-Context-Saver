#!/usr/bin/env node

/**
 * Agy-Context-Saver CLI (v2.2.0)
 *
 * Local-first CLI for streaming transcript inspection, forensic querying,
 * context health diagnostics, and lifecycle management.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSafeExportOutPath } from "../lib/path-guards.mjs";
import {
  consumeTranscriptAccessGrant,
  manageTranscriptAccessPolicy
} from "../lib/access-policy.mjs";
import {
  readTranscript,
  queryTranscript,
  getStepDetail,
  checkContextHealth,
  listTranscriptConversations,
  exportSanitizedTranscript,
  INLINE_SAFE_CHARS,
  MAX_BOUNDED_READ_STEPS,
  MAX_DEEP_OUTPUT_CHARS,
  MAX_FIELD_CHARS,
  utf8SliceToBytes
} from "../lib/transcript-core.mjs";
import {
  assertSupportedNodeVersion,
  runInstall,
  runUninstall,
  runStatus,
  runRestoreBackups
} from "../scripts/install-register.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgPath = path.resolve(__dirname, "../package.json");

process.stdout.on("error", (err) => {
  if (err?.code === "EPIPE") process.exit(0);
  throw err;
});

function getVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version || "2.2.0";
  } catch {
    return "2.2.0";
  }
}

function printHelp() {
  const version = getVersion();
  console.log(`Agy-Context-Saver CLI (v${version})

Usage:
  agy-context <command> [options]

Transcript Commands:
  transcript read [id]         Stream recent turns in Markdown/JSON (--outline, --full)
  transcript query [pat] [id]  Search turns and tool calls (grep, search, find, tools)
  transcript step <N|N..M>     Extract full fields for one step or range (--field, --tail)
  transcript health [id]       Audit turns, transcript size, RTK, and polling (stats, info)
  transcript list              List recent sessions with optional lineage (alias: ls)
  transcript export [id]       Export sanitized transcript index (--sanitized, dump)
  transcript access            Manage child transcript access policy (alias: policy)

Lifecycle Commands:
  status [--json]              Audit plugin link, hook, CLI shims, RTK, and access policy
  setup [--check]              Install or sync plugin, hooks, shims, and RTK
  uninstall                    Remove plugin link, hooks, and shims (--restore-backups)
  restore-backups              Restore pre-install .bak configuration files
  --help | -h | --version | -v Show help or CLI version

Examples:
  agy-context status
  agy-context transcript health
  agy-context transcript read --last-turns 3
  agy-context transcript query "error" --summary

Run 'agy-context <command> --help' or 'agy-context transcript <subcommand> --help' for flags.
`);
}

const COMMON_DEEP_OPTS = [
  "  --full                 Opt into 512 KB deep output tier",
  "  --max-chars <N>        Override UTF-8 output budget (up to 524288 bytes)",
  "  --out, --output <path> Write output to a safe .md/.json/.txt file",
  "  --file <path>          Explicit transcript .jsonl path inside Antigravity brain roots",
  "  --json                 Emit structured JSON output"
];

const HELP_ALIASES = {
  outline: "read", summary: "read",
  grep: "query", search: "query", find: "query", tools: "query",
  stats: "health", info: "health",
  ls: "list", dump: "export", policy: "access", install: "setup"
};

const SUBCOMMAND_HELP = {
  transcript: {
    title: "transcript",
    usage: "agy-context transcript <subcommand> [options]",
    section: "Subcommands:",
    body: [
      "  read [id]            Stream recent conversation turns (--outline, --full, --out)",
      "  query [pat] [id]     Search turns and tool calls (aliases: grep, search, find, tools)",
      "  step <N|N..M> [id]   Extract untruncated fields for a step, list, or range",
      "  health [id]          Check turn counts, byte size, RTK, and polling (stats, info)",
      "  list                 List recent conversations with optional lineage (alias: ls)",
      "  export [id]          Export sanitized transcript index (--sanitized, alias: dump)",
      "  access               View or update child transcript access policy (alias: policy)"
    ],
    examples: ["agy-context transcript health", "agy-context transcript read --last-turns 3"],
    footer: "Run 'agy-context transcript <subcommand> --help' for full options."
  },
  read: {
    title: "transcript read (aliases: outline, summary)",
    usage: "agy-context transcript read [<id>] [options]",
    body: [
      "  --id <uuid>            Conversation UUID (or pass as first positional argument)",
      "  --mode <compact|full>  Read transcript.jsonl (default) or transcript_full.jsonl",
      "  --last-turns <N>       Trailing turns to show (default: 3; aliases: --last, --tail)",
      "  --offset <N>           0-indexed forward step offset for pagination",
      "  --limit <N>            Maximum steps to return (default: 50, max: 200; 500 in outline)",
      "  --outline, --summary   Delegate to 1-line-per-step outline (accepts --start, --end)",
      "  --include-tools        Include tool names/args in outline mode",
      "  --full-args            Show untruncated tool arguments in outline mode",
      "  --include-thinking     Include model thinking blocks",
      ...COMMON_DEEP_OPTS
    ],
    examples: ["agy-context transcript read --last-turns 3", "agy-context transcript read --outline --start 0 --end 50"]
  },
  query: {
    title: "transcript query (aliases: grep, search, find, tools)",
    usage: "agy-context transcript query [<pattern>] [<id>] [options]",
    body: [
      "  --query <regex>        Case-insensitive regex or substring pattern (or positional #1)",
      "  --id <uuid>            Conversation UUID (or positional #2)",
      "  --roles <csv>          Filter roles: user,assistant,subagent,tool,system,generic,error,all",
      "  --mode <mode>          auto (default), compact, or full",
      "  --start <N> / --end <N> Inclusive step_index bounds",
      "  --last-turns <N>       Restrict search to last N turns (aliases: --last, --tail)",
      "  --limit <N>            Maximum matching steps to return",
      "  --summary, --outline   Print 1-line timeline bullets with tool and error tags",
      "  --include-tools        Search and display tool call names and arguments",
      "  --full-args            Print full tool call arguments",
      "  --field <spec>         content|thinking|tool_calls|tool_args|tool_args:<Key>|all",
      "  --include-thinking     Search and include model thinking blocks",
      ...COMMON_DEEP_OPTS
    ],
    examples: [
      'agy-context transcript grep "verification failed" --limit 5',
      'agy-context transcript tools "run_command" --field tool_args:CommandLine'
    ]
  },
  step: {
    title: "transcript step",
    usage: "agy-context transcript step [<N|N,M|N-M|N..M>] [<id>] [options]",
    body: [
      "  --step <spec>          Step index, comma list (2,8,14), or range (2-10 / 2..10)",
      "  --start <N> / --end <N> Inclusive step range when --step is omitted",
      "  --id <uuid>            Conversation UUID (or positional #2)",
      "  --field <spec>         content|thinking|tool_calls|tool_args|tool_args:<Key>|all",
      "  --head <N>             Return first N lines (alias: --head-lines)",
      "  --tail <N>             Return last N lines (alias: --tail-lines)",
      "  --line-start <N>       1-indexed start line for slice extraction",
      "  --line-end <N>         1-indexed inclusive end line for slice extraction",
      ...COMMON_DEEP_OPTS
    ],
    examples: [
      "agy-context transcript step 10..15 --field content --tail 40",
      "agy-context transcript step --step 42 --full --out ./step-42.md"
    ]
  },
  health: {
    title: "transcript health (aliases: stats, info)",
    usage: "agy-context transcript health [<id[,id...]>] [options]",
    body: [
      "  --id <uuid[,uuid...]>  One or more conversation UUIDs (positional, comma-separated, or repeatable)",
      "  --parent <uuid>        Audit health across all child sessions belonging to a parent UUID",
      "  --file <path>          Explicit transcript .jsonl path inside Antigravity brain roots",
      "  --json                 Emit structured JSON health metrics"
    ],
    examples: [
      "agy-context transcript health",
      "agy-context transcript stats --parent current --json",
      "agy-context transcript info --id <uuid1>,<uuid2> --json"
    ]
  },
  list: {
    title: "transcript list (alias: ls)",
    usage: "agy-context transcript list [options]",
    body: [
      "  --limit <N>            Maximum conversations to show (default: 10, or 50 w/ --parent)",
      "  --parent <uuid>        Filter strictly to child sessions of a parent conversation",
      "  --lineage              Include sessionKind, stepCount, parentConvId, and @rosterName",
      "  --json                 Emit structured JSON output"
    ],
    examples: ["agy-context transcript list --limit 5", "agy-context transcript ls --parent current --lineage --json"]
  },
  export: {
    title: "transcript export (alias: dump)",
    usage: "agy-context transcript export [<id>] --sanitized [options]",
    body: [
      "  --sanitized            Required: redact tool payload bodies and secrets",
      "  --id <uuid[,uuid...]>  One or more conversation UUIDs (repeatable or comma-separated)",
      "  --parent <uuid>        Export all child sessions belonging to a parent UUID",
      "  --start <N> / --end <N> Inclusive step_index bounds",
      "  --limit <N>            Maximum steps retained per session (default: 150, max: 500)",
      ...COMMON_DEEP_OPTS
    ],
    examples: [
      "agy-context transcript export --sanitized --out ./transcript-export.md",
      "agy-context transcript dump --parent current --sanitized --json"
    ]
  },
  access: {
    title: "transcript access (alias: policy)",
    usage: "agy-context transcript access [status|off|on|reset|self-only] [options]",
    body: [
      "  --status               Show active parent policy and recent launchRestrictions",
      "  --off, --deny-children Deny transcript access to all child sessions",
      "  --on, --reset          Clear parent CLI policy overrides (keeps Tier 4 launch locks)",
      "  --self-only            Restrict child sessions to their own conversation transcript",
      "  --mode <mode>          Explicit cohort default: open | allowlist | self-only | deny",
      "  --allow <list>         Comma-separated allowed session IDs or @roster* globs",
      "  --deny <list>          Comma-separated denied session IDs or @roster* globs",
      "  --ttl <sec>            Policy expiration time in seconds (default: 3600)",
      "  --json                 Emit structured JSON output"
    ],
    examples: [
      "agy-context transcript access --status",
      "agy-context transcript policy --mode allowlist --allow @reviewer-*"
    ]
  },
  status: {
    title: "status",
    usage: "agy-context status [options]",
    body: ["  --json                 Emit structured JSON installation and policy status"],
    examples: ["agy-context status", "agy-context status --json"]
  },
  setup: {
    title: "setup (alias: install)",
    usage: "agy-context setup [options]",
    body: [
      "  --check, -c            Read-only preflight validation (writes zero files)",
      "  --allow-degraded       Install hook-only governance even if RTK provisioning fails"
    ],
    examples: ["agy-context setup", "agy-context setup --check"]
  },
  uninstall: {
    title: "uninstall",
    usage: "agy-context uninstall [options]",
    body: ["  --restore-backups      Restore pre-install .bak hook and MCP configuration files"],
    examples: ["agy-context uninstall", "agy-context uninstall --restore-backups"]
  },
  "restore-backups": {
    title: "restore-backups",
    usage: "agy-context restore-backups",
    section: "Description:",
    body: [
      "  Restores namespaced hooks.json.agy-context-saver.bak (or legacy hooks.json.bak) and",
      "  mcp_config.json backup entries via validated key-scoped merge."
    ],
    examples: ["agy-context restore-backups", "agy-context uninstall --restore-backups"]
  }
};

function printSubcommandHelp(topic) {
  const key = String(topic || "").toLowerCase();
  const doc = SUBCOMMAND_HELP[HELP_ALIASES[key] || key];
  if (!doc) {
    printHelp();
    return;
  }
  const lines = [
    `Agy-Context-Saver CLI (v${getVersion()}) - ${doc.title}`,
    "",
    "Usage:",
    `  ${doc.usage}`,
    "",
    doc.section || "Options:",
    ...doc.body,
    "",
    "Examples:",
    ...doc.examples.map((ex) => `  ${ex}`)
  ];
  if (doc.footer) lines.push("", doc.footer);
  console.log(`${lines.join("\n")}\n`);
}

function parseFlags(argv, spec) {
  const booleans = spec.booleans instanceof Set ? spec.booleans : new Set(spec.booleans || []);
  const values = spec.values instanceof Set ? spec.values : new Set(spec.values || []);
  const multiValues = spec.multiValues instanceof Set ? spec.multiValues : new Set(spec.multiValues || []);
  const opts = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("-") || token === "-") { positional.push(token); continue; }
    if (token === "-h") { opts.help = true; continue; }
    if (token === "-v") { opts.version = true; continue; }
    if (token === "-c") {
      if (!booleans.has("check")) throw new Error("Unknown flag '-c' for this command.");
      opts.check = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unknown option '${token}'.`);

    const eqIdx = token.indexOf("=");
    const key = eqIdx === -1 ? token.slice(2) : token.slice(2, eqIdx);
    const inlineVal = eqIdx === -1 ? null : token.slice(eqIdx + 1);

    if (key === "help" || key === "version") {
      if (inlineVal !== null) throw new Error(`Boolean flag '--${key}' does not accept value '${inlineVal}'.`);
      opts[key] = true;
      continue;
    }
    if (booleans.has(key)) {
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
    if (multiValues.has(key) || values.has(key)) {
      let val = inlineVal;
      if (val === null) {
        if (i + 1 >= argv.length) throw new Error(`Missing value for flag '--${key}'.`);
        val = argv[++i];
      }
      if (multiValues.has(key)) {
        if (!Array.isArray(opts[key])) opts[key] = [];
        opts[key].push(val);
      } else {
        opts[key] = val;
      }
      continue;
    }
    throw new Error(`Unknown flag '--${key}'.`);
  }

  return { opts, positional };
}

function assertCleanHelp(opts, positional) {
  if (Object.keys(opts).some((k) => k !== "help") || positional.length > 0) {
    throw new Error("Conflicting flags: '--help' cannot be combined with operational flags or arguments.");
  }
}

function parseOptionalInt(val, flagName) {
  if (val === undefined) return undefined;
  const num = typeof val === "boolean" || (typeof val === "string" && val.trim() === "") ? NaN : Number(val);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new Error(`Flag '--${flagName}' must be an integer (received: '${val}').`);
  }
  return num;
}

function parseNonNegInt(val, flagName) {
  const num = parseOptionalInt(val, flagName);
  if (num !== undefined && num < 0) throw new Error(`Flag '--${flagName}' must be a non-negative integer (received: '${val}').`);
  return num;
}

function parsePositiveInt(val, flagName) {
  const num = parseOptionalInt(val, flagName);
  if (num !== undefined && num <= 0) throw new Error(`Flag '--${flagName}' must be a positive integer (received: '${val}').`);
  return num;
}

function validateExplicitFileFlag(fileArg) {
  if (fileArg === undefined) return undefined;
  const trimmed = String(fileArg).trim();
  if (!trimmed || !trimmed.toLowerCase().endsWith(".jsonl")) {
    throw new Error(`Invalid --file '${fileArg}': must be an existing .jsonl transcript file.`);
  }
  const resolved = path.resolve(trimmed);
  if (!fs.existsSync(resolved)) throw new Error(`Transcript file not found at --file '${resolved}'.`);
  const real = fs.realpathSync(resolved);
  if (!fs.statSync(real).isFile()) throw new Error(`Invalid --file '${resolved}': target is not a regular file.`);
  return real;
}

let pendingErrorGrantContext = null;

function emitError(message, asJson = false, extra = {}) {
  consumeTranscriptAccessGrant(pendingErrorGrantContext || undefined);
  console.error(asJson ? JSON.stringify({ isError: true, error: message, ...extra }, null, 2) : `Error: ${message}`);
  process.exit(1);
}

function resolveOutFlag(opts) {
  if (opts.out !== undefined && opts.output !== undefined && opts.out !== opts.output) {
    throw new Error("Conflicting '--out' and '--output' values provided.");
  }
  const rawOut = opts.out !== undefined ? opts.out : opts.output;
  return { rawOut, safeOutPath: validateSafeExportOutPath(rawOut) };
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
  const tryFit = (obj, includeMeta = true) => {
    for (const indent of [2, undefined]) {
      const content = encode(obj, indent);
      if (fits(content)) return includeMeta ? { content, metadata: obj } : { content };
    }
    return null;
  };
  const direct = tryFit(payload, false);
  if (direct) return direct;

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

    const computeCursor = (retained, count) => {
      if (isBatch) {
        const pending = entries.slice(count || 1).map((entry) => entry.stepIndex);
        if (payload.nextCursor) pending.push(payload.nextCursor.step);
        return pending.length ? { step: pending.join(",") } : undefined;
      }
      if (isRead && forward) {
        if (count > 0) return { offset: retained.at(-1)._fileOrd + 1, limit: readPageSize };
        return entries.length > 1 || payload.nextCursor ? { offset: entries[0]._fileOrd + 1, limit: readPageSize } : undefined;
      }
      if (isRead) {
        const ord = count ? retained[0]._fileOrd : entries.at(-1)._fileOrd;
        return ord > 0 ? { offset: 0, limit: Math.min(MAX_BOUNDED_READ_STEPS, ord) } : undefined;
      }
      if (forward) {
        if (count > 0 || entries.length > 1) {
          return {
            start: stepNumber(entries[count || 1]),
            end: payload.nextCursor?.start !== undefined ? payload.nextCursor.end : summaryEnd
          };
        }
        return payload.nextCursor?.start !== undefined ? { ...payload.nextCursor } : undefined;
      }
      const nextEnd = stepNumber(count ? retained[0] : entries.at(-1)) - 1;
      const minStart = payload.nextCursor?.start ?? summaryStart ?? 0;
      return nextEnd >= minStart ? (minStart > 0 ? { start: minStart, end: nextEnd } : { end: nextEnd }) : undefined;
    };

    const build = (count) => {
      const retained = forward ? entries.slice(0, count) : entries.slice(entries.length - count);
      const page = { ...payload, [key]: retained, clamped: true, ...meta(count) };
      if (count < total) {
        const cursor = computeCursor(retained, count);
        if (cursor) page.nextCursor = cursor;
        else delete page.nextCursor;
      }
      if (isBatch) {
        if (Array.isArray(payload.data)) page.data = payload.data.slice(0, count);
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
    const fitted = compactCount === 0
      ? tryFit(page)
      : (fits(encode(page)) ? { content: encode(page), metadata: page } : null);
    if (fitted) return fitted;
  } else if (payload.stepIndex !== undefined) {
    // A single step can carry its selected field without duplicating the entire raw step.
    const { step, data, ...header } = payload;
    const fitted =
      (step !== undefined && data !== undefined ? tryFit({ ...header, data, clamped: true, ...meta(1) }) : null) ||
      tryFit({ ...header, clamped: true, ...meta(0) });
    if (fitted) return fitted;
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
  const lineCount = content.length === 0 ? 0 : (content.split("\n").length - (content.endsWith("\n") ? 1 : 0));
  if (asJson) {
    const { text, steps, items, sessions, step, data, _serializedJson, _serializedMarkdown, _summaryDirection, ...compactMeta } = metadata ?? res;
    console.log(JSON.stringify({ ...compactMeta, outputPath: safeOutPath, lineCount, bytesWritten, charsWritten: content.length }, null, 2));
  } else {
    const msg = typeof customMessage === "function" ? customMessage({ lineCount, bytesWritten, safeOutPath }) : customMessage;
    console.log(msg || `[OK] Wrote ${label} (${lineCount} lines, ${bytesWritten} bytes) to: ${safeOutPath}`);
  }
}

function emitTranscriptResult(res, asJson, rawOut, safeOutPath, options) {
  if (res.isError) emitError(res.text, asJson, res.candidates ? { candidates: res.candidates } : {});
  if (safeOutPath) writeSafeTranscriptOutFile(rawOut, safeOutPath, res, asJson, options);
  else process.stdout.write(serializeTranscriptResult(res, asJson, options.maxBytes, options).content);
}

function parseTranscriptSubcommand(sub, rest, spec) {
  pendingErrorGrantContext = { subcommand: sub, targetConvId: null };
  const { opts, positional } = parseFlags(rest, spec);
  if (opts.help) {
    assertCleanHelp(opts, positional);
    consumeTranscriptAccessGrant({ subcommand: sub });
    printSubcommandHelp(sub);
    process.exit(0);
  }
  return { opts, positional };
}

function assertNoExtraPositionals(sub, positional) {
  if (positional.length > 0) {
    throw new Error(`Unexpected positional arguments for 'transcript ${sub}': ${positional.join(" ")}`);
  }
}

function parseStepRange(opts) {
  const startStep = parseNonNegInt(opts.start, "start");
  const endStep = parseNonNegInt(opts.end, "end");
  if (startStep !== undefined && endStep !== undefined && endStep < startStep) {
    throw new Error(`Invalid step range '--start ${startStep} --end ${endStep}': '--end' must be >= '--start'.`);
  }
  return { startStep, endStep };
}

function parseOutputOptions(opts, { stepMode = false } = {}) {
  const explicitFile = validateExplicitFileFlag(opts.file);
  const { rawOut, safeOutPath } = resolveOutFlag(opts);
  const parsedMaxChars = parseMaxCharsFlag(opts);
  const isFull = Boolean(opts.full);
  const effectiveMaxChars = stepMode
    ? (parsedMaxChars ?? (safeOutPath && !isFull ? MAX_DEEP_OUTPUT_CHARS : undefined))
    : (parsedMaxChars ?? (safeOutPath || isFull ? MAX_DEEP_OUTPUT_CHARS : INLINE_SAFE_CHARS));
  return { explicitFile, rawOut, safeOutPath, isFull, effectiveMaxChars };
}

const parseLastTurns = (opts) => parseNonNegInt(opts["last-turns"] ?? opts.last ?? opts.tail, "last-turns");

const ACCESS_POSITIONAL_FLAGS = {
  status: "status", off: "off", deny: "off", lock: "off",
  on: "on", open: "on", reset: "on", unlock: "on", "self-only": "self-only"
};

const TRANSCRIPT_HANDLERS = {
  async read(sub, rest) {
    const { opts, positional } = parseTranscriptSubcommand(sub, rest, {
      booleans: ["include-thinking", "outline", "summary", "include-tools", "full-args", "full", "json"],
      values: ["id", "mode", "last-turns", "last", "tail", "offset", "limit", "start", "end", "max-chars", "out", "output", "file"]
    });
    if (opts.id === undefined && positional.length === 1) opts.id = positional.shift();
    pendingErrorGrantContext = { subcommand: sub, targetConvId: opts.id || null };
    assertNoExtraPositionals(sub, positional);
    const { explicitFile, rawOut, safeOutPath, isFull, effectiveMaxChars } = parseOutputOptions(opts);
    const limit = parsePositiveInt(opts.limit, "limit");

    if (sub === "outline" || sub === "summary" || opts.outline || opts.summary) {
      const { startStep, endStep } = parseStepRange(opts);
      const res = await queryTranscript({
        conversationId: opts.id, filePath: explicitFile, startStep: startStep ?? 0, endStep: endStep ?? 999999,
        maxResults: limit ?? ((isFull || safeOutPath) ? 2000 : 500), summaryOnly: true, includeToolCalls: true,
        fullArgs: Boolean(opts["full-args"]), full: isFull, maxOutputChars: effectiveMaxChars,
        includeThinking: Boolean(opts["include-thinking"]), allowExternalPaths: false, subcommand: sub
      });
      return emitTranscriptResult(res, Boolean(opts.json), rawOut, safeOutPath, {
        label: `transcript ${sub}`, maxBytes: effectiveMaxChars, summaryStart: startStep ?? 0, summaryEnd: endStep ?? 999999
      });
    }

    const mode = opts.mode || "compact";
    if (mode !== "compact" && mode !== "full") {
      throw new Error(`Invalid --mode '${mode}' for 'transcript read' (expected 'compact' or 'full').`);
    }
    const lastTurns = parseLastTurns(opts);
    const offset = parseNonNegInt(opts.offset, "offset");
    const res = await readTranscript({
      conversationId: opts.id, filePath: explicitFile, mode, lastTurns: lastTurns ?? 3, offset, limit,
      includeThinking: Boolean(opts["include-thinking"]), full: isFull, maxOutputChars: effectiveMaxChars, allowExternalPaths: false
    });
    emitTranscriptResult(res, Boolean(opts.json), rawOut, safeOutPath, {
      label: `transcript read (${res.mode})`, maxBytes: effectiveMaxChars,
      readPageSize: offset !== undefined || limit !== undefined ? Math.min(MAX_BOUNDED_READ_STEPS, limit ?? 50) : undefined
    });
  },

  async query(sub, rest) {
    const { opts, positional } = parseTranscriptSubcommand(sub, rest, {
      booleans: ["summary", "outline", "include-tools", "full-args", "include-thinking", "full", "json"],
      values: ["id", "query", "roles", "mode", "start", "end", "last-turns", "last", "tail", "limit", "field", "max-chars", "out", "output", "file"]
    });
    if (sub === "grep" || sub === "search" || sub === "find") opts["include-tools"] = true;
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
    if (opts.query === undefined && positional.length >= 1) opts.query = positional.shift();
    if (opts.id === undefined && positional.length >= 1) opts.id = positional.shift();
    pendingErrorGrantContext = { subcommand: sub, targetConvId: opts.id || null };
    const { rawOut, safeOutPath } = resolveOutFlag(opts);
    const isFull = Boolean(opts.full);
    const effectiveMaxChars = parseMaxCharsFlag(opts) ?? (safeOutPath || isFull ? MAX_DEEP_OUTPUT_CHARS : INLINE_SAFE_CHARS);
    assertNoExtraPositionals(sub, positional);
    const mode = opts.mode || "auto";
    if (mode !== "auto" && mode !== "compact" && mode !== "full") {
      throw new Error(`Invalid --mode '${mode}' for 'transcript query' (expected 'auto', 'compact', or 'full').`);
    }
    const { startStep, endStep } = parseStepRange(opts);
    const roles = opts.roles ? opts.roles.split(",").map((r) => r.trim()).filter(Boolean) : ["all"];
    const res = await queryTranscript({
      conversationId: opts.id, filePath: validateExplicitFileFlag(opts.file), query: opts.query, roles, mode,
      startStep, endStep, lastTurns: parseLastTurns(opts), maxResults: parsePositiveInt(opts.limit, "limit"),
      summaryOnly: Boolean(opts.summary || opts.outline), includeToolCalls: Boolean(opts["include-tools"]),
      fullArgs: Boolean(opts["full-args"]), full: isFull, maxOutputChars: effectiveMaxChars,
      field: opts.field, includeThinking: Boolean(opts["include-thinking"]), allowExternalPaths: false, subcommand: sub
    });
    emitTranscriptResult(res, Boolean(opts.json), rawOut, safeOutPath, {
      label: `transcript ${sub}`, maxBytes: effectiveMaxChars,
      summaryStart: (opts.summary || opts.outline) ? startStep : undefined,
      summaryEnd: (opts.summary || opts.outline) && startStep !== undefined ? endStep : undefined
    });
  },

  async step(sub, rest) {
    const { opts, positional } = parseTranscriptSubcommand(sub, rest, {
      booleans: ["json", "full"],
      values: ["id", "step", "start", "end", "field", "mode", "tail", "tail-lines", "head", "head-lines", "line-start", "line-end", "max-chars", "out", "output", "file"]
    });
    if (opts.step === undefined && positional.length >= 1) opts.step = positional.shift();
    if (opts.id === undefined && positional.length >= 1) opts.id = positional.shift();
    pendingErrorGrantContext = { subcommand: sub, targetConvId: opts.id || null };
    assertNoExtraPositionals(sub, positional);
    const { startStep, endStep } = parseStepRange(opts);
    const tailLines = parsePositiveInt(opts["tail-lines"] ?? opts.tail, "tail");
    const headLines = parsePositiveInt(opts["head-lines"] ?? opts.head, "head");
    const lineStart = parsePositiveInt(opts["line-start"], "line-start");
    const lineEnd = parsePositiveInt(opts["line-end"], "line-end");
    if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
      throw new Error(`Invalid line slice '--line-start ${lineStart} --line-end ${lineEnd}': '--line-end' must be >= '--line-start'.`);
    }
    if (opts.step === undefined && startStep === undefined && endStep === undefined) {
      throw new Error("Missing required flag '--step <N|N,M|N-M>' (or '--start N --end M') for 'transcript step'.");
    }
    const { explicitFile, rawOut, safeOutPath, isFull, effectiveMaxChars } = parseOutputOptions(opts, { stepMode: true });
    const res = await getStepDetail({
      conversationId: opts.id, filePath: explicitFile, stepIndex: opts.step, startStep, endStep,
      field: opts.field || "all", headLines, tailLines, lineStart, lineEnd,
      full: isFull, maxOutputChars: effectiveMaxChars, allowExternalPaths: false
    });
    emitTranscriptResult(res, Boolean(opts.json), rawOut, safeOutPath, {
      label: "transcript step", maxBytes: effectiveMaxChars ?? (isFull ? MAX_DEEP_OUTPUT_CHARS : MAX_FIELD_CHARS)
    });
  },

  async health(sub, rest) {
    const { opts, positional } = parseTranscriptSubcommand(sub, rest, {
      booleans: ["json"],
      values: ["parent", "file"],
      multiValues: ["id"]
    });
    if ((!opts.id || opts.id.length === 0) && !opts.parent && !opts.file && positional.length === 1) {
      opts.id = [positional.shift()];
    }
    const healthIds = (opts.id || []).flatMap((id) => String(id || "").split(",")).map((id) => id.trim()).filter(Boolean);
    pendingErrorGrantContext = {
      subcommand: sub,
      targetConvId: opts.parent
        ? `parent:${String(opts.parent).trim()}`
        : healthIds.length === 1 ? healthIds[0] : healthIds.length > 1 ? `multi:${[...new Set(healthIds)].sort().join(",")}` : null
    };
    assertNoExtraPositionals(sub, positional);
    if (opts.parent !== undefined && !String(opts.parent).trim()) {
      throw new Error("Flag '--parent' must be a non-empty conversation ID or 'current'.");
    }
    const res = await checkContextHealth({
      conversationIds: opts.id || [],
      parentId: opts.parent,
      filePath: validateExplicitFileFlag(opts.file),
      allowExternalPaths: false
    });
    if (res.isError) emitError(res.text, Boolean(opts.json), res.candidates ? { candidates: res.candidates } : {});
    if (opts.json) {
      const { text, reportText, ...payload } = res;
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(res.reportText);
    }
  },

  async list(sub, rest) {
    const { opts, positional } = parseTranscriptSubcommand(sub, rest, { booleans: ["json", "lineage"], values: ["limit", "parent"] });
    assertNoExtraPositionals(sub, positional);
    if (opts.parent !== undefined && !String(opts.parent).trim()) {
      throw new Error("Flag '--parent' must be a non-empty conversation ID or 'current'.");
    }
    const limit = parsePositiveInt(opts.limit, "limit") ?? (opts.parent !== undefined ? 50 : 10);
    const listed = listTranscriptConversations({ limit, parentId: opts.parent, includeLineage: Boolean(opts.lineage) });
    if (listed.isError) emitError(listed.text || listed.error, Boolean(opts.json));
    if (opts.json) {
      console.log(JSON.stringify({
        total: listed.total,
        ...(listed.parentFilter ? { parentFilter: listed.parentFilter } : {}),
        ...(listed.includeLineage ? { includeLineage: true } : {}),
        conversations: listed.conversations
      }, null, 2));
      return;
    }
    const dirLabel = listed.brainDirs.length === 1 ? listed.brainDirs[0] : listed.brainDirs.join(", ");
    const parentLabel = listed.parentFilter ? ` [parent: ${listed.parentFilter}]` : "";
    const lines = [`Recent Conversations (${listed.conversations.length} of ${listed.total} in ${dirLabel})${parentLabel}:`];
    for (const item of listed.conversations) {
      lines.push(listed.includeLineage
        ? `- ${item.conversationId} | kind: ${item.sessionKind} | steps: ${item.stepCount} | parent: ${item.parentConvId || "none"} | roster: ${item.rosterName ? `@${item.rosterName}` : "none"} | updated: ${item.updatedAt} | ${(item.bytes / 1024).toFixed(1)} KB`
        : `- ${item.conversationId} | updated: ${item.updatedAt} | ${(item.bytes / 1024).toFixed(1)} KB`);
    }
    console.log(lines.join("\n"));
  },

  async export(sub, rest) {
    const { opts, positional } = parseTranscriptSubcommand(sub, rest, {
      booleans: ["sanitized", "full", "json"],
      values: ["parent", "start", "end", "limit", "max-chars", "out", "output", "file"],
      multiValues: ["id"]
    });
    if ((!opts.id || opts.id.length === 0) && !opts.parent && !opts.file && positional.length >= 1) opts.id = [positional.shift()];
    const exportIds = (opts.id || []).flatMap((id) => String(id || "").split(",")).map((id) => id.trim()).filter(Boolean);
    pendingErrorGrantContext = {
      subcommand: sub,
      targetConvId: opts.parent
        ? `parent:${String(opts.parent).trim()}`
        : exportIds.length === 1 ? exportIds[0] : exportIds.length > 1 ? `multi:${[...new Set(exportIds)].sort().join(",")}` : null
    };
    assertNoExtraPositionals(sub, positional);
    if (opts.parent !== undefined && !String(opts.parent).trim()) {
      throw new Error("Flag '--parent' must be a non-empty conversation ID or 'current'.");
    }
    const { explicitFile, rawOut, safeOutPath, effectiveMaxChars } = parseOutputOptions(opts);
    const { startStep, endStep } = parseStepRange(opts);
    const asJson = Boolean(opts.json);
    const res = await exportSanitizedTranscript({
      conversationIds: opts.id || [], parentId: opts.parent, filePath: explicitFile, sanitized: Boolean(opts.sanitized),
      startStep, endStep, limit: parsePositiveInt(opts.limit, "limit"),
      maxOutputChars: effectiveMaxChars, outputFormat: asJson ? "json" : "markdown", allowExternalPaths: false
    });
    emitTranscriptResult(res, asJson, rawOut, safeOutPath, {
      label: "sanitized transcript export",
      customMessage: safeOutPath
        ? ({ lineCount, bytesWritten }) => `[OK] Exported sanitized transcript index (${res.exportedCount} session(s), ${lineCount} lines, ${bytesWritten} bytes) to: ${safeOutPath}`
        : undefined,
      maxBytes: effectiveMaxChars
    });
  },

  async access(sub, rest) {
    const { opts, positional } = parseTranscriptSubcommand(sub, rest, {
      booleans: ["status", "off", "deny-children", "on", "reset", "self-only", "json"],
      values: ["mode", "allow", "deny", "ttl"]
    });
    if (positional.length === 1 && !opts.status && !opts.off && !opts["deny-children"] && !opts.on && !opts.reset && !opts["self-only"] && opts.mode === undefined) {
      const mapped = ACCESS_POSITIONAL_FLAGS[positional[0].toLowerCase()];
      if (!mapped) throw new Error(`Unexpected positional argument '${positional[0]}' for 'transcript ${sub}'.`);
      opts[mapped] = true;
      positional.shift();
    }
    assertNoExtraPositionals(sub, positional);
    const hasMutationFlag =
      Boolean(opts.off || opts["deny-children"] || opts.on || opts.reset || opts["self-only"]) ||
      opts.mode !== undefined || opts.allow !== undefined || opts.deny !== undefined || opts.ttl !== undefined;
    const res = manageTranscriptAccessPolicy({
      status: Boolean(opts.status) || !hasMutationFlag,
      off: Boolean(opts.off), denyChildren: Boolean(opts["deny-children"]), on: Boolean(opts.on),
      reset: Boolean(opts.reset), selfOnly: Boolean(opts["self-only"]),
      mode: opts.mode, allow: opts.allow, deny: opts.deny, ttl: opts.ttl
    });
    if (opts.json) {
      const { text, ...payload } = res;
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(res.text);
    }
  }
};

async function handleTranscriptCommand(argv) {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    if (argv.length > 1) {
      throw new Error("Conflicting flags: '--help' cannot be combined with operational flags or arguments.");
    }
    printSubcommandHelp("transcript");
    process.exit(0);
  }
  const canonical = HELP_ALIASES[sub] || sub;
  const handler = TRANSCRIPT_HANDLERS[canonical];
  if (!handler) {
    throw new Error(`Unknown transcript subcommand '${sub}'. Expected read, query, step, health, list, export, or access.`);
  }
  await handler(sub, argv.slice(1));
}

function parseLifecycleCmd(cmdLabel, rest, booleans = []) {
  const { opts, positional } = parseFlags(rest, { booleans: new Set(booleans), values: new Set() });
  if (opts.help) {
    assertCleanHelp(opts, positional);
    printSubcommandHelp(cmdLabel);
    process.exit(0);
  }
  if (positional.length > 0) {
    throw new Error(`Unexpected arguments for '${cmdLabel}': ${positional.join(" ")}`);
  }
  return opts;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    if (argv.length > 1) throw new Error("Conflicting flags: '--help' cannot be combined with operational flags or arguments.");
    printHelp();
    process.exit(0);
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    if (argv.length > 1) throw new Error("Conflicting flags: '--version' cannot be combined with operational flags or arguments.");
    console.log(getVersion());
    process.exit(0);
  }

  assertSupportedNodeVersion();
  const [cmd, ...rest] = argv;

  if (cmd === "transcript") return handleTranscriptCommand(rest);
  if (cmd === "status" || cmd === "--status") {
    const opts = parseLifecycleCmd("status", rest, ["json"]);
    const status = runStatus({ silent: Boolean(opts.json) });
    if (opts.json) console.log(JSON.stringify(status, null, 2));
    if (!status.isComplete) process.exitCode = 1;
    return;
  }
  if (cmd === "setup" || cmd === "install" || cmd === "--install") {
    const opts = parseLifecycleCmd("setup", rest, ["check", "allow-degraded"]);
    await runInstall({ checkOnly: Boolean(opts.check), allowDegraded: Boolean(opts["allow-degraded"]) });
    return;
  }
  if (cmd === "uninstall" || cmd === "--uninstall") {
    const opts = parseLifecycleCmd("uninstall", rest, ["restore-backups"]);
    await runUninstall({ restoreBackups: Boolean(opts["restore-backups"]) });
    return;
  }
  if (cmd === "restore-backups" || cmd === "--restore-backups") {
    parseLifecycleCmd("restore-backups", rest);
    await runRestoreBackups();
    return;
  }

  throw new Error(`Unknown command '${cmd}'. Run 'agy-context --help' for usage.`);
}

main().catch((err) => {
  if (err?.code === "EPIPE") process.exit(0);
  const wantsJson = process.argv.includes("--json");
  emitError(err?.message || String(err), wantsJson);
});
