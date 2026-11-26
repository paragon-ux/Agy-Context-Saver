#!/usr/bin/env node

/**
 * Agy-Context-Saver CLI (v2.3.0)
 *
 * Lifecycle commands (status, setup, uninstall, restore-backups), a read-only
 * `transcript health` report, and `transcript access` for child transcript isolation.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPolicies, setPolicy, getLineage, hasRestrictivePolicy } from "../lib/transcript-policy.mjs";
import { resolveCallerIdentity } from "../lib/hook-identity.mjs";
import { getBrainDirs } from "../lib/path-guards.mjs";
import { checkTranscriptHealth, formatTranscriptHealth } from "../lib/transcript-health.mjs";
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
    return pkg.version || "2.3.0";
  } catch {
    return "2.3.0";
  }
}

function printHelp() {
  const version = getVersion();
  console.log(`Agy-Context-Saver CLI (v${version})

Usage:
  agy-context <command> [options]

Diagnostics:
  transcript health            Report turns, steps, raw size, and polling events (aliases: stats, info)
  transcript access            Show or set child transcript access: open, self-only, deny

Lifecycle Commands:
  status [--json]              Audit plugin link, hook, CLI shims, and RTK
  setup [--check]              Install or sync plugin, hooks, shims, and RTK
  uninstall                    Remove plugin link, hooks, and shims (--restore-backups)
  restore-backups              Restore pre-install .bak configuration files
  --help | -h | --version | -v Show help or CLI version

Examples:
  agy-context status
  agy-context transcript health
  agy-context transcript health --parent current --json

Run 'agy-context <command> --help' or 'agy-context transcript health --help' for flags.
`);
}

const HELP_ALIASES = { stats: "health", info: "health", install: "setup" };

const SUBCOMMAND_HELP = {
  transcript: {
    title: "transcript",
    usage: "agy-context transcript <health|access> [options]",
    section: "Subcommands:",
    body: [
      "  health               Report turns, steps, raw size, and polling events (aliases: stats, info)",
      "  access               Show or set child transcript access: open, self-only, deny"
    ],
    examples: ["agy-context transcript health", "agy-context transcript health --parent current --json"]
  },
  access: {
    title: "transcript access",
    usage: "agy-context transcript access [status | set <open|self-only|deny>]",
    section: "Modes:",
    body: [
      "  open        Child sessions may read transcripts (default)",
      "  self-only   Child sessions may read only their own transcript",
      "  deny        Child sessions may not read any transcript",
      "  Applies to sessions launched by the session that runs 'set'. Enforced by the hook."
    ],
    examples: ["agy-context transcript access set self-only", "agy-context transcript access status"]
  },
  health: {
    title: "transcript health (aliases: stats, info)",
    usage: "agy-context transcript health [options]",
    body: [
      "  --id <uuid[,uuid]>     Check one or more sessions (default: GEMINI_CONVERSATION_ID)",
      "  --parent <uuid|current> Check every child session launched by a parent session",
      "  --json                 Emit structured JSON output"
    ],
    examples: [
      "agy-context transcript health",
      "agy-context transcript stats --parent current --json",
      "agy-context transcript info --id <uuid1>,<uuid2> --json"
    ]
  },
  status: {
    title: "status",
    usage: "agy-context status [options]",
    body: ["  --json                 Emit structured JSON installation status"],
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

function emitError(message, asJson = false) {
  console.error(asJson ? JSON.stringify({ isError: true, error: message }, null, 2) : `Error: ${message}`);
  process.exit(1);
}

async function handleTranscriptCommand(argv) {
  const grantArgs = argv.filter((arg) => arg.startsWith("--hook-grant="));
  if (grantArgs.length > 1) throw new Error("Duplicate hook identity grant.");
  argv = argv.filter((arg) => !arg.startsWith("--hook-grant="));
  const sub = argv[0];
  const identity = resolveCallerIdentity(grantArgs[0]?.slice("--hook-grant=".length), sub === "access" ? "access" : "health");
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    if (argv.length > 1) throw new Error("Conflicting flags: '--help' cannot be combined with operational flags or arguments.");
    printSubcommandHelp("transcript");
    process.exit(0);
  }
  if (sub === "access") {
    const [verb = "status", mode, ...extra] = argv.slice(1);
    if (verb === "--help" || verb === "-h") { printSubcommandHelp("access"); process.exit(0); }
    if (extra.length || (verb === "status" && mode) || !["status", "set"].includes(verb)) {
      throw new Error("Usage: agy-context transcript access [status | set <open|self-only|deny>]");
    }
    const owner = identity.callerConvId;
    if (!owner) throw new Error("No caller session; run this from inside an Antigravity session.");
    const previous = readPolicies();
    const lineage = getLineage(owner, getBrainDirs(identity));
    if (lineage.isChild || ((!lineage.found || lineage.unresolved) && hasRestrictivePolicy(previous))) {
      throw new Error("Only a confirmed top-level session may manage transcript access.");
    }
    const policies = verb === "set" ? setPolicy(owner, mode) : previous;
    const mine = policies[owner]?.mode || "open";
    console.log(verb === "set" ? `Transcript access for sessions launched by ${owner}: ${mine}` : `Transcript access for sessions launched by ${owner || "(unknown session)"}: ${mine}\nActive policies: ${Object.keys(policies).length}`);
    return;
  }
  if ((HELP_ALIASES[sub] || sub) !== "health") {
    throw new Error(`Unknown transcript subcommand '${sub}'. Expected health or access.`);
  }
  const { opts, positional } = parseFlags(argv.slice(1), { booleans: ["json"], values: ["parent"], multiValues: ["id"] });
  if (opts.help) {
    assertCleanHelp(opts, positional);
    printSubcommandHelp("health");
    process.exit(0);
  }
  if (positional.length > 0) throw new Error(`Unexpected arguments for 'transcript ${sub}': ${positional.join(" ")}`);
  const res = await checkTranscriptHealth({ ids: opts.id || [], parent: opts.parent ?? null, ...identity });
  if (res.error) throw new Error(res.error);
  console.log(opts.json ? JSON.stringify(res, null, 2) : formatTranscriptHealth(res));
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
