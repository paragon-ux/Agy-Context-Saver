#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { text } from "node:stream/consumers";

const REQUIRED = [
  "package.json",
  "plugin.json",
  "hooks.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "install.sh",
  "install.ps1",
  "assets/architecture-overview.svg",
  "assets/logo.svg",
  "bin/agy-context.mjs",
  "lib/backoff.mjs",
  "lib/path-guards.mjs",
  "lib/transcript-health.mjs",
  "lib/transcript-policy.mjs",
  "lib/hook-identity.mjs",
  "scripts/hook/transcript-guard.mjs",
  "scripts/execution-guard-hook.mjs",
  "scripts/hook/common.mjs",
  "scripts/hook/file-guard.mjs",
  "scripts/hook/shell-guard.mjs",
  "scripts/hook/task-guard.mjs",
  "scripts/install-register.mjs",
  "scripts/provision-rtk.mjs",
  "scripts/release-preflight.mjs",
  "scripts/rtk-run.mjs",
  "scripts/state-dir.mjs",
  "rules/AGENTS.md",
  "skills/context-governance/SKILL.md",
  "skills/context-governance/references/cli.md",
  "skills/context-governance/references/guardrails.md",
  "docs/architecture.md",
  "docs/governance.md",
  "docs/index.md",
  "docs/installation.md",
  "docs/INSTALLER-HARDENING.md",
  "docs/publishing.md",
  "docs/roadmap.md",
  "docs/RTK-SUPPORT-MATRIX.md",
  "docs/tools.md",
  "docs/assets/architecture-overview.svg",
  "docs/assets/default-vs-context-saver.svg",
  "docs/assets/hook-interception-flow.svg",
  "docs/assets/roadmap-phases.svg"
];

const RETIRED_DENYLIST = [
  "mcp_config.json",
  "mcp/index.js"
];

function validate(packages) {
  assert.ok(Array.isArray(packages) && packages.length === 1 && packages[0] && typeof packages[0] === "object",
    "Expected one npm pack JSON package record");
  const entries = packages[0].files;
  assert.ok(Array.isArray(entries) && entries.length > 0,
    "Expected a nonempty npm pack file list");
  const names = entries.map((entry) => entry?.path);
  assert.ok(names.every((name) => typeof name === "string" && name.length > 0),
    "Every npm pack file must have a nonempty path");
  assert.equal(new Set(names).size, names.length, "Duplicate package paths");

  const unsafe = names.filter((name) =>
    name.startsWith("/") || name.includes("\\") ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  );
  assert.deepEqual(unsafe, [], `Unsafe package paths: ${unsafe.join(", ")}`);

  const hasBadSubpath = (name) => {
    const lower = name.toLowerCase();
    return (
      lower.endsWith(".tgz") ||
      lower.endsWith(".log") ||
      /(?:^|\/)scratch(?:\/|$)/.test(lower) ||
      lower === "docs/plans" ||
      lower.startsWith("docs/plans/") ||
      lower === "docs/reviews" ||
      lower.startsWith("docs/reviews/")
    );
  };
  const allowed = names.filter((name) =>
    !hasBadSubpath(name) &&
    (name === "package.json" || name === "plugin.json" || name === "hooks.json" ||
      name === "README.md" || name === "CHANGELOG.md" || name === "LICENSE" ||
      name === "install.sh" || name === "install.ps1" ||
      name.startsWith("assets/") || name.startsWith("bin/") || name.startsWith("lib/") ||
      name.startsWith("scripts/") || name.startsWith("rules/") ||
      name.startsWith("skills/") || name.startsWith("docs/"))
  );
  const forbidden = names.filter((name) => !allowed.includes(name) || RETIRED_DENYLIST.includes(name));
  assert.deepEqual(forbidden, [],
    `Forbidden npm package contents: ${forbidden.join(", ")}`);

  const present = new Set(names);
  for (const file of REQUIRED) {
    assert.ok(present.has(file), `Missing required npm package file: ${file}`);
  }
  return names.length;
}

function selfTest() {
  const fixture = (extra) => [{ files: [...REQUIRED, ...extra].map((p) => ({ path: p })) }];
  assert.equal(validate(fixture(["docs/extra-guide.md"])), REQUIRED.length + 1);
  const badCases = [
    "tests/leaked.mjs",
    "benchmarks/private.json",
    "scratch/trace.log",
    "docs/scratch/leak.md",
    "docs/plans",
    "docs/plans/LEDGER.md",
    "docs/reviews",
    "docs/reviews/audit.md",
    "docs/package.tgz",
    "scripts/debug.log",
    "other/private.txt",
    "../outside.txt",
    "mcp_config.json",
    "mcp/index.js"
  ];
  for (const bad of badCases) {
    assert.throws(() => validate(fixture([bad])),
      /Forbidden npm package contents|Unsafe package paths/,
      `Expected synthetic package with ${bad} to be rejected`);
  }
  assert.throws(() => validate([{ files: REQUIRED
    .filter((p) => p !== "lib/transcript-health.mjs").map((p) => ({ path: p })) }]),
    /Missing required npm package file: lib\/transcript-health\.mjs/);
  console.log(`Package verifier self-test passed (positive + ${badCases.length + 1} negatives)`);
}

if (process.argv[2] === "--self-test") {
  selfTest();
} else {
  const usage = "Usage: node tests/verify-package.mjs [<npm-pack-json> | - | --self-test]";
  assert.ok(process.argv.length === 2 || process.argv.length === 3, usage);
  const useStdin = process.argv.length === 2 || process.argv[2] === "-";
  if (process.argv.length === 2 && process.stdin.isTTY) {
    assert.fail(usage);
  }
  const raw = useStdin
    ? await text(process.stdin)
    : fs.readFileSync(process.argv[2], "utf8");
  const packages = JSON.parse(raw);
  console.log(`Package boundary verified (${validate(packages)} files)`);
}
