import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupHermeticTestEnv, createRtkShim, prependToPath, withEnvPath } from "./helpers/hermetic-fixture.mjs";
import { getStateDir } from "../scripts/state-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const hookScript = path.resolve(repoRoot, "scripts/execution-guard-hook.mjs");
const hooksJsonFile = path.resolve(repoRoot, "hooks.json");

const hermetic = await setupHermeticTestEnv({ installProfile: false, forceShim: true, shimVersion: "1.1.0" });
const stateDir = getStateDir();
const stateFile = path.join(stateDir, "agy-session-governance-state.json");
const accessFile = path.join(stateDir, "transcript-access.json");

function resetState() {
  try {
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    if (fs.existsSync(accessFile)) fs.unlinkSync(accessFile);
    for (const f of fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : []) {
      if ((f.startsWith("agy-session-") || f.startsWith("transcript-access")) && f.endsWith(".json")) {
        try { fs.unlinkSync(path.join(stateDir, f)); } catch {}
      }
    }
  } catch {}
}

function runHook(payload, customEnv = process.env) {
  const result = spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: customEnv
  });
  assert.equal(result.status, 0, `Hook exited with code ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

console.log("Running Agy-Context-Saver v2.0.0 PreToolUse Hook Governance Tests...\n");
resetState();

// ============================================================================
// GROUP A: hooks.json Schema & Portability (ACS-HOOK-14, ACS-HOOK-13)
// ============================================================================
console.log("--- Group A: hooks.json Schema & Portability ---");
{
  const hooksCfg = JSON.parse(fs.readFileSync(hooksJsonFile, "utf-8"));
  assert.ok(hooksCfg["agy-context-saver"], "Top-level hook key must be 'agy-context-saver'");
  assert.equal(hooksCfg["execution-guard"], undefined, "Legacy 'execution-guard' key must not exist");
  const entry = hooksCfg["agy-context-saver"].PreToolUse[0];
  const cmd = entry.hooks[0].command;
  assert.equal(cmd.includes("ANTIGRAVITY_PLUGIN_ROOT"), false, "Must NOT use unexpanded ANTIGRAVITY_PLUGIN_ROOT");
  assert.match(cmd, /execution-guard-hook\.mjs/);
  for (const t of ["read_file", "edit_file", "write_file", "run_command", "manage_task", "schedule"]) {
    assert.ok(entry.matcher.includes(t), `Matcher must include ${t}`);
  }
  console.log("✓ hooks.json uses unified 'agy-context-saver' key, relative cwd-safe script path, and 2.0 tool matcher");
}

// ============================================================================
// GROUP B: RTK >= 1.1.0 Delegation & Edge-Case Guards (ACS-HOOK-05..09, 15)
// ============================================================================
console.log("\n--- Group B: RTK >= 1.1.0 Delegation & Edge-Case Guards ---");

// B.1: run_command delegates optimizable command and sets WaitMsBeforeAsync=10000 ONLY when unset (ACS-HOOK-05)
{
  const outUnset = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "git status" } }
  });
  assert.equal(outUnset.decision, "allow");
  assert.equal(outUnset.overwrite?.CommandLine, "rtk git status");
  assert.equal(outUnset.overwrite?.WaitMsBeforeAsync, 10000, "Must apply default 10000ms when unset");

  const outExplicit = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 2000 } }
  });
  assert.equal(outExplicit.decision, "allow");
  assert.equal(outExplicit.overwrite?.CommandLine, "rtk git status");
  assert.equal(outExplicit.overwrite?.WaitMsBeforeAsync, undefined, "Must preserve caller explicit WaitMsBeforeAsync");

  const outDaemon = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "node server.js", IsDaemon: true } }
  });
  assert.equal(outDaemon.decision, "allow");
  assert.equal(outDaemon.overwrite?.WaitMsBeforeAsync, undefined, "Daemon commands must not force WaitMsBeforeAsync");
  console.log("✓ WaitMsBeforeAsync applied only when !isDaemon && waitMs === undefined (ACS-HOOK-05)");
}

// B.2: Compound chains & bash -c wrappers handled cleanly via `rtk hook antigravity` (ACS-HOOK-06, 07)
{
  const outChain = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "git status && cat package.json", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(outChain.decision, "allow");
  assert.equal(outChain.overwrite?.CommandLine, "rtk git status && rtk read package.json");

  const outWrap = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "bash -c 'git status && cat package.json'", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(outWrap.decision, "allow");
  assert.equal(outWrap.overwrite?.CommandLine, "bash -c 'rtk git status && rtk read package.json'");
  console.log("✓ Compound chains and bash -c wrappers rewrite via rtk hook antigravity without bespoke cache/wrapper bugs");
}

// B.3: Lossy rtk wc / rtk ls / rtk diff rewrites reverted back to raw (ACS-HOOK-09)
{
  for (const cmd of ["wc -l package.json", "ls -la scripts/", "diff -u a.txt b.txt"]) {
    const out = runHook({
      toolCall: { name: "run_command", args: { CommandLine: cmd, WaitMsBeforeAsync: 5000 } }
    });
    assert.equal(out.decision, "allow");
    assert.equal(out.overwrite?.CommandLine, undefined, `Lossy rewrite for '${cmd}' must be reverted to raw`);
  }

  // Explicit `rtk wc` typed by caller is preserved
  const outExplicitRtk = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "rtk wc -l package.json", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(outExplicitRtk.decision, "allow");
  assert.equal(outExplicitRtk.overwrite?.CommandLine, undefined);
  console.log("✓ Implicit rtk wc / rtk ls / rtk diff rewrites reverted; explicit rtk invocation preserved (ACS-HOOK-09)");
}

// B.4: Never emit `rtk rg` when `rg` binary is absent on PATH (ACS-HOOK-15)
{
  const emptyBinEnv = withEnvPath(path.join(hermetic.profileDir, "rtk-shim-bin"));
  const outSimpleRg = runHook(
    { toolCall: { name: "run_command", args: { CommandLine: 'rg -n "HOOK_KEY" scripts/', WaitMsBeforeAsync: 5000 } } },
    emptyBinEnv
  );
  assert.equal(outSimpleRg.decision, "allow");
  assert.match(outSimpleRg.overwrite?.CommandLine || "", /rtk grep/);
  assert.equal((outSimpleRg.overwrite?.CommandLine || "").includes("rtk rg"), false, "Must NEVER emit rtk rg when rg is absent");

  // Unsupported rg-only flag (-t js) maps cleanly to rtk grep --include instead of emitting `rtk rg`
  const outUnsupportedRg = runHook(
    { toolCall: { name: "run_command", args: { CommandLine: 'rg -t js "HOOK_KEY" scripts/', WaitMsBeforeAsync: 5000 } } },
    emptyBinEnv
  );
  assert.equal(outUnsupportedRg.decision, "allow");
  assert.equal((outUnsupportedRg.overwrite?.CommandLine || "").includes("rtk rg"), false, "Must NEVER emit rtk rg when rg is absent");
  assert.match(outUnsupportedRg.overwrite?.CommandLine || "", /rtk grep.*--include=\*\.js/);

  // Direct `rtk grep "a|b" lib/` & `rtk grep -rn "a|b" lib/` normalize to `-r` + `-E` when rg is absent
  const outRtkGrepDir = runHook(
    { toolCall: { name: "run_command", args: { CommandLine: 'rtk grep "HOOK_KEY|LEGACY_HOOK_KEY" scripts/', WaitMsBeforeAsync: 5000 } } },
    emptyBinEnv
  );
  assert.equal(outRtkGrepDir.decision, "allow");
  assert.match(outRtkGrepDir.overwrite?.CommandLine || "", /^rtk grep -r -E\b/);

  const outRtkGrepPipe = runHook(
    { toolCall: { name: "run_command", args: { CommandLine: 'echo "abc" | rtk grep "a|b"', WaitMsBeforeAsync: 5000 } } },
    emptyBinEnv
  );
  assert.equal(outRtkGrepPipe.decision, "allow");
  assert.match(outRtkGrepPipe.overwrite?.CommandLine || "", /\|\s*rtk grep -E\b/);
  assert.equal(/\brtk grep\b[^|]*-r\b/.test(outRtkGrepPipe.overwrite?.CommandLine || ""), false, "Piped rtk grep must NOT inject -r");

  // `rg -S` (smart-case) and `rg -g "*.mjs"` map cleanly instead of falling back to nonexistent `rg`
  const outSmartRg = runHook(
    { toolCall: { name: "run_command", args: { CommandLine: 'rg -S -g "*.mjs" "hook_key" scripts/', WaitMsBeforeAsync: 5000 } } },
    emptyBinEnv
  );
  assert.equal(outSmartRg.decision, "allow");
  assert.match(outSmartRg.overwrite?.CommandLine || "", /rtk grep -r -i -E --include=\*\.mjs/);

  // Env-prefixed commands still guard absent `rg` and revert lossy `wc` (HOOK-REV-02)
  const outEnvRg = runHook(
    { toolCall: { name: "run_command", args: { CommandLine: 'FOO=1 rg -n "HOOK_KEY" scripts/', WaitMsBeforeAsync: 5000 } } },
    emptyBinEnv
  );
  assert.equal(outEnvRg.decision, "allow");
  assert.match(outEnvRg.overwrite?.CommandLine || "", /^FOO=1 rtk grep\b/);
  assert.equal((outEnvRg.overwrite?.CommandLine || "").includes("rtk rg"), false, "Env-prefixed rg must never emit rtk rg when rg is absent");

  const outEnvWc = runHook(
    { toolCall: { name: "run_command", args: { CommandLine: "env FOO=1 wc -l package.json", WaitMsBeforeAsync: 5000 } } },
    emptyBinEnv
  );
  assert.equal(outEnvWc.decision, "allow");
  assert.equal(outEnvWc.overwrite?.CommandLine, undefined, "Env-prefixed implicit wc rewrite must revert cleanly");

  const outExplicitEnvWc = runHook(
    { toolCall: { name: "run_command", args: { CommandLine: "FOO=1 rtk wc -l package.json", WaitMsBeforeAsync: 5000 } } },
    emptyBinEnv
  );
  assert.equal(outExplicitEnvWc.decision, "allow");
  assert.equal(outExplicitEnvWc.overwrite?.CommandLine, undefined, "Explicit env-prefixed `FOO=1 rtk wc` must be preserved");

  // grep_search hint when rg absent recommends rtk grep -rn, never rtk rg
  const grepHint = runHook(
    { toolCall: { name: "grep_search", args: { query: "HOOK_KEY", SearchPath: "scripts" } } },
    emptyBinEnv
  );
  assert.equal(grepHint.decision, "deny");
  assert.match(grepHint.reason, /rtk grep -rn/);
  assert.equal(grepHint.reason.includes("rtk rg"), false);
  console.log("✓ Absent host `rg` guarded across run_command & grep_search hints (ACS-HOOK-15)");
}

// B.5: Legacy RTK < 1.1.0 is rejected (does not emit broken `rtk hook antigravity` calls)
{
  const oldBinDir = path.join(hermetic.profileDir, "old-rtk-bin");
  createRtkShim(oldBinDir, "0.51.0");
  const oldEnv = { ...process.env };
  prependToPath(oldBinDir, oldEnv);
  const out = runHook(
    { toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 5000 } } },
    oldEnv
  );
  assert.equal(out.decision, "allow");
  assert.equal(out.overwrite?.CommandLine, undefined, "Incompatible RTK < 1.1.0 must not be invoked");
  console.log("✓ Legacy RTK < 1.1.0 cleanly rejected in favor of >= 1.1.0 requirement");
}

// ============================================================================
// GROUP C: Antigravity 2.0 `read_file` Safe Harbor & Hybrid Slice (ACS-HOOK-01, 02, SWARM-02, 03)
// ============================================================================
console.log("\n--- Group C: read_file & view_file Safe Harbor + Hybrid Slice ---");

// C.1: read_file uses `args.Path` cleanly (special files allowed without bounds, workspace files bounded)
{
  const skillRead = runHook({
    toolCall: { name: "read_file", args: { Path: "/home/user/repo/.agents/skills/swarm/SKILL.md" } }
  });
  assert.equal(skillRead.decision, "allow", "read_file on SKILL.md via args.Path must pass Safe Harbor");

  const brainRead = runHook({
    toolCall: { name: "read_file", args: { Path: "/home/user/.gemini/antigravity/brain/conv-1/scratch/report.md" } }
  });
  assert.equal(brainRead.decision, "allow", "read_file on brain scratch artifact via args.Path must pass Safe Harbor");

  const agentsRead = runHook({
    toolCall: { name: "read_file", args: { Path: "/home/user/repo/AGENTS.md" } }
  });
  assert.equal(agentsRead.decision, "allow", "read_file on AGENTS.md must pass Safe Harbor");

  const sliceRead = runHook({
    toolCall: { name: "read_file", args: { Path: "/home/user/repo/src/app.js", StartLine: 1, EndLine: 150 } }
  });
  assert.equal(sliceRead.decision, "allow", "150-line bounded read_file via args.Path must be allowed");

  const camelEndSlice = runHook({
    toolCall: { name: "read_file", args: { Path: "/home/user/repo/src/app.js", startLine: 10, endLine: 40 } }
  });
  assert.equal(camelEndSlice.decision, "allow", "camelCase startLine/endLine read_file must be allowed");

  const unboundedRead = runHook({
    toolCall: { name: "read_file", args: { Path: "/home/user/repo/src/app.js" } }
  });
  assert.equal(unboundedRead.decision, "deny", "Unbounded workspace read_file must be denied");
  assert.equal(unboundedRead.reason.includes("waymark_ask"), false, "Must NOT reference ghost waymark_ask tool");
  assert.equal(unboundedRead.reason.includes("rtk read"), false, "Workspace unbounded read_file denial must NOT suggest rtk read");

  const byteOffsetOnly = runHook({
    toolCall: { name: "read_file", args: { Path: "/home/user/repo/src/app.js", ByteOffset: 46080 } }
  });
  assert.equal(byteOffsetOnly.decision, "deny", "ByteOffset-only unbounded read_file must be denied");
  assert.equal(byteOffsetOnly.reason.includes("rtk read"), false, "Workspace ByteOffset-only read_file denial must NOT suggest rtk read");

  // Guarded full-file audit (<= 800 lines, <= 45 KiB) using explicit StartLine=1..TotalLines
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-audit-file-"));
  try {
    const smallFile = path.join(auditDir, "small.js");
    fs.writeFileSync(smallFile, Array.from({ length: 220 }, (_, i) => `const x${i} = ${i};`).join("\n"), "utf-8");
    const fullSmallAudit = runHook({
      toolCall: { name: "read_file", args: { Path: smallFile, StartLine: 1, EndLine: 220 } }
    });
    assert.equal(fullSmallAudit.decision, "allow", "Explicit full-file read_file (<=800L & <=45KiB) allowed");

    const partialOver = runHook({
      toolCall: { name: "read_file", args: { Path: smallFile, StartLine: 1, EndLine: 180 } }
    });
    assert.equal(partialOver.decision, "deny", "Partial slice 1..180 of 220-line file must be denied");
    assert.equal(partialOver.reason.includes("rtk read"), false, "Workspace partial read_file denial must NOT suggest rtk read");

    const bigWorkspaceFile = path.join(auditDir, "big.js");
    fs.writeFileSync(bigWorkspaceFile, Array.from({ length: 850 }, (_, i) => `const y${i} = ${i};`).join("\n"), "utf-8");
    const fullTooBigAudit = runHook({
      toolCall: { name: "read_file", args: { Path: bigWorkspaceFile, StartLine: 1, EndLine: 850 } }
    });
    assert.equal(fullTooBigAudit.decision, "deny", "Oversized >800-line full-file read_file must be denied");
    assert.equal(fullTooBigAudit.reason.includes("rtk read"), false, "Workspace oversized read_file denial must NOT suggest rtk read");

    // Step spillover bounded read_file <= 150 lines allowed, > 150 or unbounded denied
    const boundedSpillover = runHook({
      toolCall: {
        name: "read_file",
        args: { Path: "/home/user/.gemini/antigravity/brain/conv-1/.system_generated/steps/42/output.txt", StartLine: 1, EndLine: 150 }
      }
    });
    assert.equal(boundedSpillover.decision, "allow", "Bounded read_file <=150 lines on step spillover allowed");

    const fakeSpillover = runHook({
      toolCall: {
        name: "read_file",
        args: { Path: "/home/user/.gemini/antigravity/brain/conv-1/.system_generated/steps/42/output_bak.txt", StartLine: 1, EndLine: 50 }
      }
    });
    assert.equal(fakeSpillover.decision, "deny", "Non-output.txt spillover lookalike must be denied");

    // Symmetrical `view_file` Safe Harbor, bounded slice, unbounded deny, and spillover deny (HOOK-REV-03)
    assert.equal(
      runHook({ toolCall: { name: "view_file", args: { AbsolutePath: "/home/user/repo/.agents/skills/swarm/SKILL.md" } } }).decision,
      "allow",
      "view_file on SKILL.md must pass Safe Harbor"
    );
    assert.equal(
      runHook({ toolCall: { name: "view_file", args: { AbsolutePath: "/home/user/repo/src/app.js", StartLine: 1, EndLine: 150 } } }).decision,
      "allow",
      "view_file 150-line slice must be allowed"
    );
    const viewUnbounded = runHook({ toolCall: { name: "view_file", args: { AbsolutePath: "/home/user/repo/src/app.js" } } });
    assert.equal(viewUnbounded.decision, "deny", "view_file unbounded read must be denied");
    assert.equal(viewUnbounded.reason.includes("rtk read"), false, "Workspace unbounded view_file denial must NOT suggest rtk read");
    assert.equal(
      runHook({
        toolCall: {
          name: "view_file",
          args: { AbsolutePath: "/home/user/.gemini/antigravity/brain/conv-1/.system_generated/steps/42/output.txt", StartLine: 1, EndLine: 50 }
        }
      }).decision,
      "deny",
      "view_file on step spillover must stay denied (use read_file or rtk read)"
    );
  } finally {
    fs.rmSync(auditDir, { recursive: true, force: true });
  }

  const readManyOut = runHook({
    toolCall: { name: "read_many_files", args: { paths: ["src/a.js", "src/b.js"] } }
  });
  assert.equal(readManyOut.decision, "deny", "Native read_many_files must be denied");
  assert.match(readManyOut.reason, /read_file/, "read_many_files denial must steer editable code to bounded read_file");
  assert.match(readManyOut.reason, /rtk read/, "read_many_files denial must still retain rtk read for logs/spillovers");
  console.log("✓ Symmetrical read_file / view_file Safe Harbor, Hybrid Slice, and spillover bounds verified");
}

// ============================================================================
// GROUP D: Quote/Heredoc Shell Parser & CLI Exemption (ACS-HOOK-03, 04, 16, SWARM-07, 08)
// ============================================================================
console.log("\n--- Group D: Quote/Heredoc Shell Parser & agy-context CLI Exemption ---");
{
  const brainDir = path.join(hermetic.profileDir, ".gemini", "antigravity", "brain");
  const validBrainTranscript = path.join(brainDir, "fcda194f-62d6-46aa-b545-b2de8fa5774e", ".system_generated", "logs", "transcript.jsonl");

  // D.1: Heredoc body mentioning .system_generated prose is ALLOWED (not false-blocked)
  const heredocCmd = `node - <<'EOF'\nCheck .system_generated/logs/transcript.jsonl rules in prompt text\nEOF`;
  const outHeredoc = runHook({
    toolCall: { name: "run_command", args: { CommandLine: heredocCmd, WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(outHeredoc.decision, "allow", "Heredoc prose containing .system_generated must NOT be false-blocked");

  // D.2: Echo/printf mentioning .system_generated (without redirecting into it) is ALLOWED
  const outEcho = runHook({
    toolCall: { name: "run_command", args: { CommandLine: 'echo "Never touch .system_generated directly"', WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(outEcho.decision, "allow", "echo prose containing .system_generated must be allowed");

  // D.3: Search pattern containing `.system_generated` against non-internal `scripts/` is ALLOWED (ACS-SWARM-08)
  const outGrepPattern = runHook({
    toolCall: { name: "run_command", args: { CommandLine: 'grep -rn ".system_generated" scripts/', WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(outGrepPattern.decision, "allow", "grep searching for literal '.system_generated' in workspace scripts/ must be allowed");

  // D.4: Direct shell access to .system_generated gives `agy-context transcript` CLI hint (ACS-HOOK-16)
  const outCatTranscript = runHook({
    toolCall: { name: "run_command", args: { CommandLine: `cat "${validBrainTranscript}"`, WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(outCatTranscript.decision, "deny");
  assert.match(outCatTranscript.reason, /agy-context transcript/);

  // D.5: Strictly single unchained `agy-context transcript ...` is ALLOWED
  const outCliQuery = runHook({
    toolCall: {
      name: "run_command",
      args: { CommandLine: `agy-context transcript query --id fcda194f-62d6-46aa-b545-b2de8fa5774e --query ".system_generated" --summary`, WaitMsBeforeAsync: 5000 }
    }
  });
  assert.equal(outCliQuery.decision, "allow");

  const outCliFileOk = runHook({
    toolCall: {
      name: "run_command",
      args: { CommandLine: `agy-context transcript read --file "${validBrainTranscript}"`, WaitMsBeforeAsync: 5000 }
    }
  });
  assert.equal(outCliFileOk.decision, "allow");

  // D.6: Chained/redirected/subshell/smuggled `agy-context transcript` & obfuscated bypasses MUST be DENIED
  for (const dangerous of [
    `agy-context transcript health --id abc && cat "${validBrainTranscript}"`,
    `rtk read package.json && agy-context transcript health --id abc`,
    `FOO=1 agy-context transcript health --id abc && head -n 5 package.json`,
    `env agy-context transcript health --id abc && head -n 5 package.json`,
    `bash -c "agy-context transcript health --id abc && head -n 5 package.json"`,
    `(agy-context transcript health --id abc)`,
    `agy-context transcript read --id abc | head -n 5`,
    `agy-context transcript read --file /etc/passwd`,
    `agy-context transcript read --file "${brainDir}/../config/hooks.json"`,
    `rtk read .system_generated/steps/1/output.txt && cat /etc/passwd`,
    `echo "hi">.system_generated/logs/transcript.jsonl`,
    `echo hi>>.system_generated/logs/transcript.jsonl`,
    `cat .system_""generated/logs/transcript.jsonl`,
    `head -n 2 .system_gene*/logs/transcript.jsonl`,
    `cat \${D}generated/logs/transcript.jsonl`,
    `node -e "console.log('.system_'+'generated')"`,
    `grep -Ff "${validBrainTranscript}" package.json`,
    `python3 - <<'EOF'\nprint(open("${validBrainTranscript}").read())\nEOF`,
    `node <<'EOF'\nfs.readFileSync("${validBrainTranscript}", "utf8")\nEOF`,
    `xargs head -n 2 <<'EOF'\n${validBrainTranscript}\nEOF`,
    `bash <<'EOF'\ncat "${validBrainTranscript}"\nEOF`,
    `echo Y2F0IC9ldGMvcGFzc3dkCg== | base64 -d | bash`,
    `python3 -c "import base64; p=base64.b64decode('${Buffer.from(validBrainTranscript).toString("base64")}').decode(); print(open(p).readline())"`,
    `head -n 1 "$(echo '${Buffer.from(validBrainTranscript).toString("base64")}' | base64 -d)"`,
    `node -e "console.log(require('fs').readFileSync(Buffer.from('${Buffer.from(validBrainTranscript).toString("base64")}','base64').toString(),'utf8').slice(0,60))"`,
    `node -e "console.log(require('fs').readFileSync(Buffer.from('${Buffer.from(validBrainTranscript).toString("hex")}','hex').toString(),'utf8').slice(0,60))"`,
    `echo '${Buffer.from(validBrainTranscript).toString("base64")}' | base64 -d | xargs head -n 1`
  ]) {
    const outBypass = runHook({
      toolCall: { name: "run_command", args: { CommandLine: dangerous, WaitMsBeforeAsync: 5000 } }
    });
    assert.equal(outBypass.decision, "deny", `Dangerous chained/escape command must be DENIED: ${dangerous}`);
  }

  // Benign markdown documentation heredoc writing to scratch report MUST still be ALLOWED
  const benignReportHeredoc = runHook({
    toolCall: {
      name: "run_command",
      args: {
        CommandLine: `cat <<'EOF' > scratch/report.md\nLayout of .system_generated/logs/transcript.jsonl and steps/1/output.txt\nEOF`,
        WaitMsBeforeAsync: 5000
      }
    }
  });
  assert.equal(benignReportHeredoc.decision, "allow", "Benign report-writing heredoc mentioning transcript.jsonl must stay allowed");
  console.log("✓ Heredoc/echo/pattern immunity, red-team smuggling defenses, and strict unchained agy-context CLI exemption verified");
}

// ============================================================================
// GROUP E: Task Polling Backoff, Watchdog & Benchmark Protection (LH-03..09, ACS-HOOK-13)
// ============================================================================
console.log("\n--- Group E: Task Polling Backoff, Watchdog & Benchmark Mutation Guard ---");
{
  resetState();
  const convId = "conv-backoff-test";
  // First status check allowed
  assert.equal(runHook({ conversationId: convId, toolCall: { name: "manage_task", args: { Action: "status", TaskId: "t1" } } }).decision, "allow");
  // Immediate checks 1..4 denied, 5th hits force_ask circuit breaker
  for (let i = 1; i <= 4; i++) {
    const d = runHook({ conversationId: convId, toolCall: { name: "manage_task", args: { Action: "status", TaskId: "t1" } } });
    assert.equal(d.decision, "deny", `Premature poll #${i} must be deny`);
  }
  const breaker = runHook({ conversationId: convId, toolCall: { name: "manage_task", args: { Action: "status", TaskId: "t1" } } });
  assert.equal(breaker.decision, "force_ask", "5th premature poll must trip force_ask circuit breaker");

  // kill and send_input always allowed immediately
  assert.equal(runHook({ conversationId: convId, toolCall: { name: "manage_task", args: { Action: "kill", TaskId: "t1" } } }).decision, "allow");

  // Short schedule polling timer denied; non-polling reminder allowed; swarm polling one-shot denied; repeated 60s task watchdog denied
  resetState();
  assert.equal(runHook({ conversationId: convId, toolCall: { name: "schedule", args: { DurationSeconds: 5, Prompt: "Check status of task-1", TimerCondition: "task-1" } } }).decision, "deny");
  assert.equal(runHook({ conversationId: convId, toolCall: { name: "schedule", args: { DurationSeconds: 60, Prompt: "Check status of Clarity Wave 2 swarm", TimerCondition: "any" } } }).decision, "deny");
  assert.equal(runHook({ conversationId: convId, toolCall: { name: "schedule", args: { CronExpression: "*/3 * * * *", IsDaemon: true, Prompt: "[monitor] tick: check the swarm for a stall" } } }).decision, "allow");
  assert.equal(runHook({ conversationId: convId, toolCall: { name: "schedule", args: { DurationSeconds: 45, Prompt: "Check status of task-1", TimerCondition: "task-1" } } }).decision, "allow");
  assert.equal(runHook({ conversationId: convId, toolCall: { name: "schedule", args: { DurationSeconds: 60, Prompt: "Check status of task-1", TimerCondition: "task-1" } } }).decision, "deny", "Second task watchdog must require Level 2 backoff (>= 75s), blocking repeated 60s timers");
  assert.equal(runHook({ conversationId: convId, toolCall: { name: "schedule", args: { DurationSeconds: 75, Prompt: "Check status of task-1", TimerCondition: "task-1" } } }).decision, "allow");
  assert.equal(runHook({ conversationId: convId, toolCall: { name: "schedule", args: { DurationSeconds: 10, Prompt: "Remind me about coffee" } } }).decision, "allow");

  // LH-09 Benchmark protection on edit_file, write_file, relative paths, and shell redirection/rm
  for (const mut of [
    { name: "edit_file", args: { Path: "/repo/benchmarks/suite.json", Target: "a", Replacement: "b" } },
    { name: "write_file", args: { Path: "evaluators/eval_score.py", Content: "print(1)" } },
    { name: "replace_file_content", args: { TargetFile: "/repo/scoring/rubric.json" } },
    { name: "run_command", args: { CommandLine: "echo '{}' > benchmarks/ground_truth.json", WaitMsBeforeAsync: 5000 } },
    { name: "run_command", args: { CommandLine: "echo {}>benchmarks/ground_truth.json", WaitMsBeforeAsync: 5000 } }
  ]) {
    const res = runHook({ toolCall: mut });
    assert.equal(res.decision, "force_ask", `LH-09 must guard ${mut.name} on benchmark artifact`);
  }
  const safeEdit = runHook({ toolCall: { name: "edit_file", args: { Path: "/repo/src/utils.js", Target: "a", Replacement: "b" } } });
  assert.equal(safeEdit.decision, "allow");

  // Dual-hook idempotency deduplication (same toolCall.id does not double-increment pollCount)
  resetState();
  const dedupFirst = runHook({
    conversationId: "conv-dedup-test",
    stepIdx: 10,
    toolCall: { id: "toolu_dedup_1", name: "manage_task", args: { Action: "status", TaskId: "t1" } }
  });
  assert.equal(dedupFirst.decision, "allow");
  const dedupSecond = runHook({
    conversationId: "conv-dedup-test",
    stepIdx: 10,
    toolCall: { id: "toolu_dedup_1", name: "manage_task", args: { Action: "status", TaskId: "t1" } }
  });
  assert.equal(dedupSecond.decision, "allow", "Duplicate hook invocation for same toolCall.id must replay allow without double-counting");
  console.log("✓ Backoff circuit breaker, schedule watchdog, dual-hook deduplication, and 2.0 edit_file/write_file LH-09 protection verified");

  console.log("\n--- Group F: Wave 1 & Wave 2 Adversarial Live Remediations ---");
  const emptyBinEnv = withEnvPath(path.join(hermetic.profileDir, "rtk-shim-bin"));
  // 1. rg -U, piped rg | sed, and bash -c "rg ... | awk" when host rg is absent
  const rgUOut = runHook(
    { conversationId: "conv-wave-fixes", toolCall: { name: "run_command", args: { CommandLine: 'rg -U "try" scripts/' } } },
    emptyBinEnv
  );
  assert.equal(rgUOut.decision, "allow");
  assert.ok(!rgUOut.overwrite?.CommandLine?.includes("-U"), "rg -U flag must be stripped or fallback cleanly");

  const rgPipeOut = runHook(
    { conversationId: "conv-wave-fixes", toolCall: { name: "run_command", args: { CommandLine: "rg -n 'catch' scripts/ | sed -n '1,5p'" } } },
    emptyBinEnv
  );
  assert.equal(rgPipeOut.decision, "allow");
  assert.match(rgPipeOut.overwrite?.CommandLine || "", /grep -r -E\b/, "Piped rg must fallback to grep -r -E when host rg is absent");

  const rgBashCOut = runHook(
    { conversationId: "conv-wave-fixes", toolCall: { name: "run_command", args: { CommandLine: "bash -c \"rg -n 'throw' scripts/ | awk -F: '{print \\$1}'\"" } } },
    emptyBinEnv
  );
  assert.equal(rgBashCOut.decision, "allow");
  assert.match(rgBashCOut.overwrite?.CommandLine || "", /grep -r -E\b/, "bash -c rg must fallback to grep -r -E when host rg is absent");

  // 2. Read-only node -e mentioning benchmark string literal allowed
  const nodeBenchReadOnly = runHook({
    conversationId: "conv-wave-fixes",
    toolCall: { name: "run_command", args: { CommandLine: 'node -e \'const target = "scratch/benchmarks/probe.json"; console.log(target);\'' } }
  });
  assert.equal(nodeBenchReadOnly.decision, "allow", "Read-only node -e string literal mentioning benchmark path must be allowed");

  // 3. Raw cat/head on tasks/*.log and edit_file on transcript.jsonl blocked
  const rawTaskLog = runHook({
    conversationId: "conv-wave-fixes",
    toolCall: { name: "run_command", args: { CommandLine: "head -n 5 /tmp/brain/conv/.system_generated/tasks/task-99.log" } }
  });
  assert.equal(rawTaskLog.decision, "deny", "Raw head on .system_generated/tasks/*.log must be blocked");

  const editTranscript = runHook({
    conversationId: "conv-wave-fixes",
    toolCall: { name: "edit_file", args: { Path: "/tmp/brain/conv/.system_generated/logs/transcript.jsonl", Target: "a", Replacement: "b" } }
  });
  assert.equal(editTranscript.decision, "deny", "Native edit_file on .system_generated/logs/transcript.jsonl must be blocked");

  // 4. Base64 path-decoding smuggling blocked
  const b64Path = Buffer.from("/tmp/brain/conv/.system_generated/logs/transcript.jsonl").toString("base64");
  const b64Smuggle = runHook({
    conversationId: "conv-wave-fixes",
    toolCall: { name: "run_command", args: { CommandLine: `head -n 1 "$(echo ${b64Path} | base64 -d)"` } }
  });
  assert.equal(b64Smuggle.decision, "deny", "Base64 path-decoding smuggling of transcript.jsonl must be blocked");
  console.log("✓ rg -U/pipe/bash -c fallbacks, read-only node -e benchmark literal, tasks/*.log & edit_file guards, and Base64 smuggling defense verified");

  // ============================================================================
  // GROUP G: On-Demand Transcript Access Governance & 6-Vector Red-Team Suite
  // ============================================================================
  console.log("\n--- Group G: On-Demand Transcript Access Governance & 6-Vector Red-Team Suite ---");
  resetState();
  const brainDirG = path.join(hermetic.profileDir, ".gemini", "antigravity", "brain");
  const writeSessionSteps = (id, steps) => {
    const dir = path.join(brainDirG, id, ".system_generated", "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(file, steps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf-8");
    return file;
  };

  const parentId = "parent-coord-1111";
  const subagentId = "subagent-leaf-2222";
  const swarmWorkerId = "swarm-worker-3333";
  const swarmAuditorId = "swarm-audit-4444";
  const launchDenyId = "subagent-launch-deny-5555";
  const launchSelfId = "subagent-launch-self-6666";
  const echoReviewerId = "swarm-echo-reviewer-7777";
  const independentTopId = "independent-top-8888";

  writeSessionSteps(parentId, [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Coordinate the verification swarm." }
  ]);
  writeSessionSteps(subagentId, [
    {
      step_index: 0,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-15T03:00:00Z sender=${parentId} priority=MESSAGE_PRIORITY_HIGH content=Solve the coding task without reading transcripts.\n</SYSTEM_MESSAGE>`
    }
  ]);
  writeSessionSteps(swarmWorkerId, [
    {
      step_index: 0,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-15T03:00:01Z sender=${parentId} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #1\n</SYSTEM_MESSAGE>`
    },
    {
      step_index: 1,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-15T03:00:01Z sender=${parentId} priority=MESSAGE_PRIORITY_HIGH content=You have just started. Your assignment (recorded on the board as #1 for @worker-1):\n\nImplement the feature.\n</SYSTEM_MESSAGE>`
    }
  ]);
  writeSessionSteps(swarmAuditorId, [
    {
      step_index: 0,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-15T03:00:02Z sender=${parentId} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #2\n</SYSTEM_MESSAGE>`
    },
    {
      step_index: 1,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-15T03:00:02Z sender=${parentId} priority=MESSAGE_PRIORITY_HIGH content=You have just started. Your assignment (recorded on the board as #2 for @audit-squad1):\n\nAudit worker transcripts.\n</SYSTEM_MESSAGE>`
    }
  ]);
  writeSessionSteps(launchDenyId, [
    {
      step_index: 0,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-15T03:00:03Z sender=${parentId} priority=MESSAGE_PRIORITY_HIGH content=[agy-transcript-access: deny]\nYou are a restricted leaf subagent.\n</SYSTEM_MESSAGE>`
    }
  ]);
  writeSessionSteps(launchSelfId, [
    {
      step_index: 0,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-15T03:00:04Z sender=${parentId} priority=MESSAGE_PRIORITY_HIGH content=[agy-transcript-access: self-only]\nYou may only inspect your own transcript.\n</SYSTEM_MESSAGE>`
    }
  ]);
  writeSessionSteps(echoReviewerId, [
    {
      step_index: 0,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-15T03:00:05Z sender=${parentId} priority=MESSAGE_PRIORITY_HIGH content=You have just started. Your assignment (recorded on the board as #3 for @sec-reviewer):\n\nPlease evaluate how [agy-transcript-access: deny] behaves when mentioned in prose:\n[agy-transcript-access: deny]\n</SYSTEM_MESSAGE>`
    }
  ]);
  writeSessionSteps(independentTopId, [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: "Brand new top-level user conversation started later."
    }
  ]);

  // G.1: Exhaustive Subcommand & Wrapper Governance (Vector 1)
  for (const validSub of [
    "agy-context transcript list --limit 3",
    "agy-context transcript ls --limit 3",
    `agy-context transcript grep "foo" --id ${parentId}`,
    `agy-context transcript search "foo" --id ${parentId}`,
    `agy-context transcript find "foo" --id ${parentId}`,
    `agy-context transcript stats --id ${parentId}`,
    `agy-context transcript info --id ${parentId}`,
    `agy-context transcript tools --id ${parentId}`,
    `agy-context transcript outline --id ${parentId}`,
    `agy-context transcript summary --id ${parentId}`,
    "agy-context transcript access --status",
    "agy-context transcript --help"
  ]) {
    const res = runHook({
      conversationId: parentId,
      toolCall: { name: "run_command", args: { CommandLine: validSub } }
    });
    assert.equal(res.decision, "allow", `Canonical '${validSub}' must be allowed for parent`);
  }

  for (const invalidOrWrapped of [
    "agy-context transcript list --limit 3 && echo pwn",
    "agy-context transcript bogus-subcommand",
    `node --no-warnings bin/agy-context.mjs transcript read --id ${parentId}`,
    `env -S "agy-context transcript read --id ${parentId}"`,
    `command agy-context transcript read --id ${parentId}`,
    `exec agy-context transcript read --id ${parentId}`,
    `timeout 5 agy-context transcript read --id ${parentId}`,
    `nice -n 5 agy-context transcript read --id ${parentId}`,
    `nohup agy-context transcript read --id ${parentId}`
  ]) {
    const res = runHook({
      conversationId: parentId,
      toolCall: { name: "run_command", args: { CommandLine: invalidOrWrapped } }
    });
    assert.equal(res.decision, "deny", `Wrapped or chained '${invalidOrWrapped}' must be DENIED`);
  }

  // G.2: Launch Directive (Tier 4) & Prompt Echo Immunity (Vector 5)
  assert.equal(
    runHook({
      conversationId: launchDenyId,
      toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript list" } }
    }).decision,
    "deny",
    "Subagent with first-line [agy-transcript-access: deny] must be denied"
  );
  assert.equal(
    runHook({
      conversationId: echoReviewerId,
      toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript list" } }
    }).decision,
    "allow",
    "Reviewer mentioning [agy-transcript-access: deny] after line 1 must NOT be false-locked (Prompt Echo Immunity)"
  );

  // G.3: Self-Only Mode Positional, Flag & Omitted-ID Rewriting (Vector 6)
  assert.equal(
    runHook({
      conversationId: launchSelfId,
      toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript list" } }
    }).decision,
    "deny",
    "self-only mode must deny transcript list"
  );
  assert.equal(
    runHook({
      conversationId: launchSelfId,
      toolCall: { name: "run_command", args: { CommandLine: `agy-context transcript read --id ${parentId}` } }
    }).decision,
    "deny",
    "self-only mode must deny --id <other>"
  );
  assert.equal(
    runHook({
      conversationId: launchSelfId,
      toolCall: { name: "run_command", args: { CommandLine: `agy-context transcript read ${parentId}` } }
    }).decision,
    "deny",
    "self-only mode must deny positional <otherId>"
  );
  assert.equal(
    runHook({
      conversationId: launchSelfId,
      toolCall: { name: "run_command", args: { CommandLine: `agy-context transcript query "foo" ${parentId}` } }
    }).decision,
    "deny",
    "self-only mode must deny positional <otherId> in query"
  );
  const selfOmittedId = runHook({
    conversationId: launchSelfId,
    toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript read --mode compact" } }
  });
  assert.equal(selfOmittedId.decision, "allow", "self-only mode must allow omitted --id and auto-inject caller ID");
  assert.match(selfOmittedId.overwrite?.CommandLine || "", new RegExp(`--id ${launchSelfId}`), "Must inject --id <self>");

  // G.4: On-Demand Parent Policy (`--off`, `--allow @audit-*`), Child Self-Unlock Block & Stale-Lock Immunity
  const parentLockHook = runHook({
    conversationId: parentId,
    toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript access --off" } }
  });
  assert.equal(parentLockHook.decision, "allow", "Parent must be allowed to run transcript access --off");
  // Execute the CLI command to persist policy in stateDir using the hook's mutation grant
  const cliLockExec = spawnSync(process.execPath, [path.resolve(repoRoot, "bin/agy-context.mjs"), "transcript", "access", "--off"], {
    encoding: "utf-8",
    env: process.env
  });
  assert.equal(cliLockExec.status, 0, `CLI access --off failed: ${cliLockExec.stderr}`);

  // Parent still allowed; subagent & swarm worker denied; independent top-level chat still allowed!
  assert.equal(
    runHook({
      conversationId: parentId,
      toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript list" } }
    }).decision,
    "allow",
    "Parent owner must remain allowed under --off"
  );
  const subDenied = runHook({
    conversationId: subagentId,
    toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript list" } }
  });
  assert.equal(subDenied.decision, "deny", "Child subagent must be denied when parent turns transcript access --off");
  assert.match(subDenied.reason, /Do NOT retry transcript inspection commands/);

  // Context-aware .system_generated denial for restricted child must NOT tell it to run agy-context transcript
  const subRawReadDenied = runHook({
    conversationId: subagentId,
    toolCall: {
      name: "read_file",
      args: { Path: path.join(brainDirG, parentId, ".system_generated", "logs", "transcript.jsonl"), StartLine: 1, EndLine: 5 }
    }
  });
  assert.equal(subRawReadDenied.decision, "deny");
  assert.ok(!subRawReadDenied.reason.includes("Run 'agy-context transcript read"), "Restricted child denial must NOT suggest running agy-context transcript");
  assert.match(subRawReadDenied.reason, /DISABLED for this session by parent governance/);

  // Child attempting to unlock itself via `agy-context transcript access --on` MUST be denied
  assert.equal(
    runHook({
      conversationId: subagentId,
      toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript access --on" } }
    }).decision,
    "deny",
    "Child session must be blocked from mutating transcript access policy"
  );

  // Independent top-level user conversation (`USER_INPUT` at Step 0) is NOT locked out!
  assert.equal(
    runHook({
      conversationId: independentTopId,
      toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript list" } }
    }).decision,
    "allow",
    "Independent top-level user conversation must never be locked out by another session's child lock"
  );

  // Parent allows `@audit-*` (Agy-Squad GOV-07 L6 Transcript Isolation)
  runHook({
    conversationId: parentId,
    toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript access --allow @audit-*" } }
  });
  spawnSync(process.execPath, [path.resolve(repoRoot, "bin/agy-context.mjs"), "transcript", "access", "--allow", "@audit-*"], {
    encoding: "utf-8",
    env: process.env
  });
  assert.equal(
    runHook({
      conversationId: swarmWorkerId,
      toolCall: { name: "run_command", args: { CommandLine: `agy-context transcript read --id ${parentId}` } }
    }).decision,
    "deny",
    "Swarm leaf specialist (@worker-1) must be denied under --allow @audit-*"
  );
  assert.equal(
    runHook({
      conversationId: swarmAuditorId,
      toolCall: { name: "run_command", args: { CommandLine: `agy-context transcript read --id ${swarmWorkerId}` } }
    }).decision,
    "allow",
    "Swarm Integrity Auditor (@audit-squad1) must be allowed via @audit-* glob"
  );

  // G.5: State Dir Tampering, Env Overrides, Wildcard Globs, Direct Core Imports & Two-Step Script Writes (Vectors 2, 3, 4)
  for (const stateAttack of [
    { name: "read_file", args: { Path: accessFile, StartLine: 1, EndLine: 20 } },
    { name: "write_file", args: { Path: accessFile, Content: '{"policies":{}}', Overwrite: true } },
    { name: "edit_file", args: { Path: accessFile, Target: "deny", Replacement: "open" } },
    { name: "run_command", args: { CommandLine: `rm -f "${accessFile}"` } },
    { name: "run_command", args: { CommandLine: `cat "${accessFile}"` } },
    { name: "run_command", args: { CommandLine: `XDG_STATE_HOME=/tmp/fake agy-context transcript list` } },
    { name: "run_command", args: { CommandLine: `AGY_TEST_PROFILE_DIR=/tmp/fake agy-context transcript list` } },
    { name: "run_command", args: { CommandLine: `node -e "import('./lib/transcript-core.mjs').then(m => m.readTranscript({conversationId:'${parentId}'}))"` } },
    { name: "run_command", args: { CommandLine: `head -n 20 "${brainDirG}/${parentId}/.s*/*/*"` } },
    { name: "run_command", args: { CommandLine: `cat "${brainDirG}/${parentId}/.*/*/*.jsonl"` } },
    { name: "run_command", args: { CommandLine: `ln -s "${brainDirG}/${parentId}" /tmp/brain-link` } },
    {
      name: "write_file",
      args: {
        Path: "/tmp/pwn-helper.mjs",
        Content: `import { readTranscript } from './lib/transcript-core.mjs'; console.log( await readTranscript({ conversationId: '${parentId}' }) );`
      }
    },
    {
      name: "write_file",
      args: {
        Path: "scratch/pwn.py",
        Content: `print(open('${brainDirG}/${parentId}/.system_generated/logs/transcript.jsonl').read())`
      }
    },
    {
      name: "edit_file",
      args: {
        Path: path.resolve(repoRoot, "scripts/execution-guard-hook.mjs"),
        Target: "deny",
        Replacement: "allow"
      }
    },
    {
      name: "run_command",
      args: { CommandLine: `agy-context transcript query --id ${parentId} --query --help --query ".*"` }
    },
    {
      name: "run_command",
      args: {
        CommandLine: `cat << 'EOF' > /tmp/pwn.py\nprint(open('${brainDirG}/${parentId}/.system_generated/logs/transcript.jsonl').read())\nEOF`
      }
    },
    {
      name: "run_command",
      args: {
        CommandLine: `node -e "const b='${brainDirG}/${parentId}'; console.log(fs.readdirSync(b))"`
      }
    },
    {
      name: "run_command",
      args: {
        CommandLine: `node -e "const b='${brainDirG}/${parentId}'; console.log(fs.readFileSync(b + '/.sys' + 'tem_generated/lo' + 'gs/trans' + 'cript.jsonl', 'utf8'))"`
      }
    },
    {
      name: "run_command",
      args: {
        CommandLine: "sed -i 's/deny/open/g' ~/.gemini/config/scripts/execution-guard-hook.mjs"
      }
    },
    {
      name: "run_command",
      args: {
        CommandLine: 'bash -c "rm -f ~/.gemini/config/hooks.json"'
      }
    },
    {
      name: "run_command",
      args: {
        CommandLine: "agy-context --uninstall"
      }
    }
  ]) {
    const res = runHook({
      conversationId: swarmWorkerId,
      toolCall: stateAttack
    });
    assert.equal(res.decision, "deny", `Red-team bypass vector must be DENIED for restricted child: ${JSON.stringify(stateAttack)}`);
  }

  // Two-step non-script file execution: writing to scratch/pwn.txt and then running `python3 <path>/scratch/pwn.txt`
  const pwnTxtPath = path.join(brainDirG, swarmWorkerId, "scratch/pwn.txt");
  fs.mkdirSync(path.dirname(pwnTxtPath), { recursive: true });
  fs.writeFileSync(pwnTxtPath, `print(open('${brainDirG}/${parentId}/.system_generated/logs/transcript.jsonl').read())\n`, "utf-8");
  const execTxtRes = runHook({
    conversationId: swarmWorkerId,
    toolCall: {
      name: "run_command",
      args: { CommandLine: `python3 "${pwnTxtPath}"` }
    }
  });
  assert.equal(execTxtRes.decision, "deny", "Executing a non-script .txt file containing protected brain reads via python3 must be DENIED");

  // Writing a markdown report in scratch/ mentioning .system_generated or transcript-core.mjs MUST still be allowed
  const benignMarkdownWrite = runHook({
    conversationId: swarmWorkerId,
    toolCall: {
      name: "write_file",
      args: {
        Path: path.join(brainDirG, swarmWorkerId, "scratch/report.md"),
        Content: "# Report\nInspected `lib/transcript-core.mjs` and `.system_generated/logs/transcript.jsonl`."
      }
    }
  });
  assert.equal(benignMarkdownWrite.decision, "allow", "Markdown report write in scratch/ must remain allowed");

  // Workspace paths containing /Agy-Context-Saver/ and a filename with 'transcript-' must NOT false-match as an agy-context transcript CLI call
  const benignRepoPathCmd = runHook({
    conversationId: parentId,
    toolCall: {
      name: "run_command",
      args: {
        CommandLine: "cp /tmp/diagram.svg /home/user/Antigravity/Agy-Context-Saver/docs/assets/transcript-access-governance.svg"
      }
    }
  });
  assert.equal(benignRepoPathCmd.decision, "allow", "Repo path with Agy-Context-Saver and transcript-access-governance.svg must be allowed");

  // Parent resets policy back to open
  runHook({
    conversationId: parentId,
    toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript access --on" } }
  });
  spawnSync(process.execPath, [path.resolve(repoRoot, "bin/agy-context.mjs"), "transcript", "access", "--on"], {
    encoding: "utf-8",
    env: process.env
  });
  assert.equal(
    runHook({
      conversationId: subagentId,
      toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript list" } }
    }).decision,
    "allow",
    "Child subagent must be allowed again after parent runs transcript access --on"
  );
  console.log("✓ 5-Tier Precedence, @roster* globs, self-only rewriting, Stale-Lock immunity, and all 6 Red-Team bypass vectors verified");
}

// ============================================================================
// GROUP H: Hardening Regressions (ACS-RUN-001..006, ACS-ARCH-002)
// ============================================================================
console.log("\n--- Group H: Multi-Root, Lineage Chunking, Cross-Swarm Isolation & Edge Cases ---");
{
  resetState();
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hook-cwd-"));
  const cliProfile = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cli-profile-"));
  try {
    // ACS-RUN-001: Relative Path resolved against payload.cwd for full-file audit
    fs.writeFileSync(path.join(wsDir, "small.js"), "line1\nline2\nline3\nline4\n", "utf-8");
    const relCwdAudit = runHook({
      cwd: wsDir,
      toolCall: { name: "read_file", args: { Path: "small.js", StartLine: 1, EndLine: 4 } }
    });
    assert.equal(relCwdAudit.decision, "allow", "Relative read_file audit 1..TotalLines must resolve against payload.cwd");

    // ACS-RUN-002: 2>/dev/null on plugin script command must NOT false-trigger governance mutation guard
    const pluginDiagCmd = runHook({
      toolCall: {
        name: "run_command",
        args: { CommandLine: "node ~/.gemini/config/plugins/agy-context-saver/scripts/diagnose.mjs 2>/dev/null" }
      }
    });
    assert.equal(pluginDiagCmd.decision, "allow", "Plugin command with 2>/dev/null must be allowed");
    const nestedRedirAttack = runHook({
      toolCall: {
        name: "run_command",
        args: { CommandLine: 'bash -c "echo pwn > ~/.gemini/config/hooks.json"' }
      }
    });
    assert.equal(nestedRedirAttack.decision, "deny", "Nested bash -c redirect into hooks.json must still be DENIED");

    // ACS-ARCH-002 + ACS-RUN-006: Multi-product antigravity-cli brain root & swarm_view/ narrator safety
    const cliBrainRoot = path.join(cliProfile, ".gemini", "antigravity-cli", "brain");
    const cliConv = "cli-conv-1";
    const cliLogs = path.join(cliBrainRoot, cliConv, ".system_generated", "logs");
    fs.mkdirSync(cliLogs, { recursive: true });
    fs.writeFileSync(
      path.join(cliLogs, "transcript.jsonl"),
      JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "CLI root session" }) + "\n"
    );
    const cliEnv = { ...process.env, AGY_TEST_PROFILE_DIR: cliProfile };
    delete cliEnv.AGY_BRAIN_DIR;
    const cliFileRead = runHook(
      {
        conversationId: cliConv,
        transcriptPath: path.join(cliLogs, "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: `agy-context transcript read --file "${path.join(cliLogs, "transcript.jsonl")}"` }
        }
      },
      cliEnv
    );
    assert.equal(cliFileRead.decision, "allow", "--file inside ~/.gemini/antigravity-cli/brain must be allowed");

    const swarmViewWrite = runHook({
      toolCall: {
        name: "run_command",
        args: { CommandLine: "cp /tmp/out.json /home/user/.gemini/antigravity/brain/conv-1/swarm_view/board.tmp" }
      }
    });
    assert.equal(swarmViewWrite.decision, "allow", "Narrator writes inside swarm_view/ must be allowed (ACS-RUN-006)");

    // ACS-RUN-003: Step 0 > 16 KiB must still extract parentConvId, rosterName & launchDirective
    const brainH = path.join(hermetic.profileDir, ".gemini", "antigravity", "brain");
    const writeTr = (id, steps) => {
      const dir = path.join(brainH, id, ".system_generated", "logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "transcript.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
    };
    const pA = "parent-swarm-a";
    const pB = "parent-swarm-b";
    const bigChildA = "big-step0-child-a";
    const subL1 = "subagent-l1-a";
    const grandL2 = "leaf-l2-under-l1";
    const auditB = "audit-b-isolated";

    writeTr(pA, [{ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Swarm A" }]);
    writeTr(pB, [{ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Swarm B" }]);
    writeTr(bigChildA, [{
      step_index: 0,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-16T00:00:00Z sender=${pA} priority=MESSAGE_PRIORITY_HIGH content=${"X".repeat(22000)}\nYour assignment (recorded on the board as #1 for @big-worker):\n[agy-transcript-access: deny]\nDo work\n</SYSTEM_MESSAGE>`
    }]);
    writeTr(subL1, [{
      step_index: 0,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `[Message] timestamp=2026-11-16T00:00:01Z sender=${pA} priority=MESSAGE_PRIORITY_HIGH content=Lead task`
    }]);
    writeTr(grandL2, [{
      step_index: 0,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `[Message] timestamp=2026-11-16T00:00:02Z sender=${subL1} priority=MESSAGE_PRIORITY_HIGH content=Leaf task under L1`
    }]);
    writeTr(auditB, [{
      step_index: 0,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `[Message] timestamp=2026-11-16T00:00:03Z sender=${pB} priority=MESSAGE_PRIORITY_HIGH content=Your assignment (recorded on the board as #1 for @audit-swarmB):\nAudit B`
    }]);

    assert.equal(
      runHook({ conversationId: bigChildA, toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript list" } } }).decision,
      "deny",
      "Child with >20 KiB Step 0 before trailing assignment & [agy-transcript-access: deny] must still be locked (ACS-RUN-003)"
    );

    // ACS-RUN-004: Cross-swarm @roster* isolation + 2-hop ancestor lock inheritance
    runHook({ conversationId: pA, toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript access --allow @audit-*" } } });
    spawnSync(process.execPath, [path.resolve(repoRoot, "bin/agy-context.mjs"), "transcript", "access", "--allow", "@audit-*"], { encoding: "utf-8", env: process.env });
    runHook({ conversationId: pB, toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript access --off" } } });
    spawnSync(process.execPath, [path.resolve(repoRoot, "bin/agy-context.mjs"), "transcript", "access", "--off"], { encoding: "utf-8", env: process.env });

    assert.equal(
      runHook({ conversationId: auditB, toolCall: { name: "run_command", args: { CommandLine: `agy-context transcript read --id ${pB}` } } }).decision,
      "deny",
      "Unrelated Swarm B @audit-swarmB must NOT inherit Swarm A's --allow @audit-* policy (ACS-RUN-004)"
    );
    assert.equal(
      runHook({ conversationId: grandL2, toolCall: { name: "run_command", args: { CommandLine: `agy-context transcript read --id ${pA}` } } }).decision,
      "deny",
      "2-hop grandchild under parentA must inherit parentA's restrict policy (ACS-RUN-004)"
    );

    // ACS-RUN-005: `query current` in self-only mode keeps query term 'current' and appends --id <self>
    const selfChildH = "self-child-query-current";
    writeTr(selfChildH, [{
      step_index: 0,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `[Message] timestamp=2026-11-16T00:00:04Z sender=${pA} priority=MESSAGE_PRIORITY_HIGH content=[agy-transcript-access: self-only]\nTask`
    }]);
    const selfQueryCurrent = runHook({
      conversationId: selfChildH,
      toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript query current" } }
    });
    assert.equal(selfQueryCurrent.decision, "allow");
    assert.equal(
      selfQueryCurrent.overwrite?.CommandLine,
      `agy-context transcript query current --id ${selfChildH}`,
      "query current must keep 'current' as pattern and append --id <self> (ACS-RUN-005)"
    );

    // Wave 2 regressions: restricted child read current --json, unmodified repo tests, git diff scripts/install-register.mjs, lifecycle script deny, antigravity-cli self-only, swarm-poll circuit breaker
    const selfReadCurrentJson = runHook({
      conversationId: selfChildH,
      toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript read current --json" } }
    });
    assert.equal(selfReadCurrentJson.decision, "allow");
    assert.equal(
      selfReadCurrentJson.overwrite?.CommandLine,
      `agy-context transcript read --id ${selfChildH} --json`,
      "read current --json under self-only must rewrite positional current before trailing flags (ACS-RUN-005)"
    );

    const restrictedGitDiffInstall = runHook({
      conversationId: bigChildA,
      cwd: repoRoot,
      toolCall: { name: "run_command", args: { CommandLine: "git diff -- scripts/install-register.mjs" } }
    });
    assert.equal(
      restrictedGitDiffInstall.decision,
      "allow",
      "Restricted child running git diff on scripts/install-register.mjs must be allowed (no false install-verb or bare basename block)"
    );

    const restrictedRunRepoTest = runHook({
      conversationId: bigChildA,
      cwd: repoRoot,
      toolCall: { name: "run_command", args: { CommandLine: `node "${path.resolve(repoRoot, "tests/test-hook.mjs")}"` } }
    });
    assert.equal(
      restrictedRunRepoTest.decision,
      "allow",
      "Restricted child executing unmodified repo test suite must be allowed"
    );

    const restrictedRunInstall = runHook({
      conversationId: bigChildA,
      cwd: repoRoot,
      toolCall: { name: "run_command", args: { CommandLine: `node "${path.resolve(repoRoot, "scripts/install-register.mjs")}" --check` } }
    });
    assert.equal(
      restrictedRunInstall.decision,
      "deny",
      "Restricted child executing Agy-Context-Saver scripts/install-register.mjs must still be denied"
    );

    const cliRestricted = "cli-self-child";
    const cliRestrictedLogs = path.join(cliBrainRoot, cliRestricted, ".system_generated", "logs");
    fs.mkdirSync(cliRestrictedLogs, { recursive: true });
    fs.writeFileSync(
      path.join(cliRestrictedLogs, "transcript.jsonl"),
      JSON.stringify({
        step_index: 0,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        content: `[Message] timestamp=2026-11-16T00:00:05Z sender=${pA} priority=MESSAGE_PRIORITY_HIGH content=[agy-transcript-access: self-only]\nCLI task`
      }) + "\n"
    );
    const cliSelfFileRead = runHook(
      {
        conversationId: cliRestricted,
        transcriptPath: path.join(cliRestrictedLogs, "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: `agy-context transcript read --file "${path.join(cliRestrictedLogs, "transcript.jsonl")}"` }
        }
      },
      cliEnv
    );
    assert.equal(
      cliSelfFileRead.decision,
      "allow",
      "self-only caller passing own --file under antigravity-cli/brain must resolve extractConvId via getBrainDirs (ACS-ARCH-002)"
    );

    // ACS-SVC-002: Hook validation for transcript list --parent/--lineage and transcript export --sanitized
    const parentListHook = runHook(
      {
        conversationId: pA,
        transcriptPath: path.join(cliBrainRoot, pA, ".system_generated", "logs", "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: `agy-context transcript list --parent ${pA} --lineage --json` }
        }
      },
      cliEnv
    );
    assert.equal(parentListHook.decision, "allow", "Parent must be allowed to run transcript list --parent --lineage");

    const parentExportHook = runHook(
      {
        conversationId: pA,
        transcriptPath: path.join(cliBrainRoot, pA, ".system_generated", "logs", "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: `agy-context transcript export --parent ${pA} --sanitized --out scratch/index.md` }
        }
      },
      cliEnv
    );
    assert.equal(parentExportHook.decision, "allow", "Parent must be allowed to run transcript export --parent --sanitized --out");

    const badOutExportHook = runHook(
      {
        conversationId: pA,
        transcriptPath: path.join(cliBrainRoot, pA, ".system_generated", "logs", "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: `agy-context transcript export --id ${pA} --sanitized --out scripts/evil.mjs` }
        }
      },
      cliEnv
    );
    assert.equal(badOutExportHook.decision, "deny", "export --out writing executable/governance script must be denied");

    const selfExportOwn = runHook(
      {
        conversationId: cliRestricted,
        transcriptPath: path.join(cliRestrictedLogs, "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: "agy-context transcript export --sanitized" }
        }
      },
      cliEnv
    );
    assert.equal(selfExportOwn.decision, "allow", "self-only caller exporting own transcript must be allowed");
    assert.match(selfExportOwn.overwrite?.CommandLine || "", new RegExp(`--id ${cliRestricted}`));

    for (const forbiddenSelfExport of [
      `agy-context transcript export --sanitized --parent ${pA}`,
      `agy-context transcript export --sanitized --id ${pA}`,
      `agy-context transcript export --sanitized --id ${pA},${cliRestricted}`,
      `agy-context transcript export --sanitized --id ${pA} --id ${cliRestricted}`
    ]) {
      const deniedSelfExp = runHook(
        {
          conversationId: cliRestricted,
          transcriptPath: path.join(cliRestrictedLogs, "transcript.jsonl"),
          toolCall: {
            name: "run_command",
            args: { CommandLine: forbiddenSelfExport }
          }
        },
        cliEnv
      );
      assert.equal(deniedSelfExp.decision, "deny", `self-only mode must deny '${forbiddenSelfExport}'`);
    }

    // Regression: cwd-resolved benchmark --out denial, dual --out/--output bypass denial, --parent current rewrite, and repeated --id current
    const cwdBenchExport = runHook(
      {
        conversationId: pA,
        cwd: path.join(wsDir, "benchmarks"),
        transcriptPath: path.join(cliBrainRoot, pA, ".system_generated", "logs", "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: `agy-context transcript export --id ${pA} --sanitized --out eval_data.json` }
        }
      },
      cliEnv
    );
    assert.equal(cwdBenchExport.decision, "deny", "Relative --out inside payload.cwd=benchmarks must be denied");

    const dualOutExport = runHook(
      {
        conversationId: pA,
        cwd: wsDir,
        transcriptPath: path.join(cliBrainRoot, pA, ".system_generated", "logs", "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: `agy-context transcript export --id ${pA} --sanitized --out scratch/ok.md --output benchmarks/evil.json` }
        }
      },
      cliEnv
    );
    assert.equal(dualOutExport.decision, "deny", "Conflicting --out safe + --output benchmarks must be denied");

    const parentCurrentList = runHook(
      {
        conversationId: pA,
        transcriptPath: path.join(cliBrainRoot, pA, ".system_generated", "logs", "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: "agy-context transcript list --parent current --lineage" }
        }
      },
      cliEnv
    );
    assert.equal(parentCurrentList.decision, "allow");
    assert.match(parentCurrentList.overwrite?.CommandLine || "", new RegExp(`--parent ${pA}`));

    const parentCurrentExport = runHook(
      {
        conversationId: pA,
        transcriptPath: path.join(cliBrainRoot, pA, ".system_generated", "logs", "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: "agy-context transcript export --parent current --sanitized" }
        }
      },
      cliEnv
    );
    assert.equal(parentCurrentExport.decision, "allow");
    assert.match(parentCurrentExport.overwrite?.CommandLine || "", new RegExp(`--parent ${pA}`));

    const repeatCurrentSelf = runHook(
      {
        conversationId: cliRestricted,
        transcriptPath: path.join(cliRestrictedLogs, "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: "agy-context transcript export --sanitized --id current --id current" }
        }
      },
      cliEnv
    );
    assert.equal(repeatCurrentSelf.decision, "allow");
    assert.doesNotMatch(repeatCurrentSelf.overwrite?.CommandLine || "", /\bcurrent\b/);

    // Regression: positional comma-separated IDs under allowlist policy bind exact 'multi:' grant key
    const allowlistExpChild = "cli-allow-exp";
    const allowlistExpLogs = path.join(cliBrainRoot, allowlistExpChild, ".system_generated", "logs");
    fs.mkdirSync(allowlistExpLogs, { recursive: true });
    fs.writeFileSync(
      path.join(allowlistExpLogs, "transcript.jsonl"),
      JSON.stringify({
        step_index: 0,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        content: `[Message] timestamp=2026-11-16T00:00:06Z sender=${pA} priority=MESSAGE_PRIORITY_HIGH content=[agy-transcript-access: allow]\nAudit`
      }) + "\n"
    );
    const multiPosHook = runHook(
      {
        conversationId: allowlistExpChild,
        transcriptPath: path.join(allowlistExpLogs, "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: `agy-context transcript export ${pA},${cliRestricted} --sanitized` }
        }
      },
      cliEnv
    );
    assert.equal(multiPosHook.decision, "allow");
    const cliStateDir = os.platform() === "win32"
      ? path.join(cliProfile, "AppData", "Local", "agy-context-saver")
      : path.join(cliProfile, ".local", "state", "agy-context-saver");
    const grantsDir = path.join(cliStateDir, "grants");
    const grantFiles = fs.readdirSync(grantsDir).filter((f) => f.startsWith("grant-"));
    const latestGrant = grantFiles
      .map((f) => JSON.parse(fs.readFileSync(path.join(grantsDir, f), "utf8")))
      .find((g) => g.callerConvId === allowlistExpChild && g.subcommand === "export");
    const expectedMultiKey = `multi:${[pA, cliRestricted].sort().join(",")}`;
    assert.equal(latestGrant?.targetConvId, expectedMultiKey, "Positional comma-separated export must bind sorted multi: grant key");

    // ACS-LIVE-SVC-001 & ACS-PR4-ARCH-001: Step 0 `[swarm] new board message` (sender=sibling) must not override Step 1 `Your assignment` (sender=coordinator)
    const { inspectTranscriptLineageFromFile } = await import("../lib/transcript-core.mjs");
    const liveBoardWorker = "cli-swarm-board-worker";
    const liveBoardWorkerLogs = path.join(cliBrainRoot, liveBoardWorker, ".system_generated", "logs");
    fs.mkdirSync(liveBoardWorkerLogs, { recursive: true });
    const liveBoardTrPath = path.join(liveBoardWorkerLogs, "transcript_full.jsonl");
    fs.writeFileSync(
      liveBoardTrPath,
      [
        {
          step_index: 0,
          source: "SYSTEM",
          type: "SYSTEM_MESSAGE",
          content: `[Message] timestamp=2026-11-16T00:00:07Z sender=${cliRestricted} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #1`
        },
        {
          step_index: 1,
          source: "SYSTEM",
          type: "SYSTEM_MESSAGE",
          content: `[Message] timestamp=2026-11-16T00:00:08Z sender=${pA} priority=MESSAGE_PRIORITY_HIGH content=Your assignment (recorded on the board as #2 for @audit-live):\n[agy-transcript-access: allow]\nAudit`
        }
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n"
    );
    const sharedCoreLineage = inspectTranscriptLineageFromFile(liveBoardTrPath);
    assert.equal(sharedCoreLineage.parentConvId, pA);
    assert.equal(sharedCoreLineage.rosterName, "audit-live");
    assert.equal(sharedCoreLineage.launchDirective, "allow");
    const hookBoardWorkerRes = runHook(
      {
        conversationId: liveBoardWorker,
        transcriptPath: liveBoardTrPath,
        toolCall: {
          name: "run_command",
          args: { CommandLine: `agy-context transcript read --id ${pA}` }
        }
      },
      cliEnv
    );
    assert.equal(
      hookBoardWorkerRes.decision,
      "allow",
      "getCallerLineage must bind Step 1 coordinator sender= (pA, allowlist @audit-*) rather than Step 0 board sibling (ACS-LIVE-SVC-001 / ACS-PR4-ARCH-001)"
    );

    // Pre-v2 stale cached session.lineage + Step 0->Step 1 startup write growth must invalidate cache and bind coordinator
    const raceWorker = "hermetic-swarm-race-worker";
    const raceTrPath = path.join(brainH, raceWorker, ".system_generated", "logs", "transcript.jsonl");
    writeTr(raceWorker, [{
      step_index: 0,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `[Message] timestamp=2026-11-16T00:00:07Z sender=${pB} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #1`
    }]);
    const raceStep0Res = runHook({
      conversationId: raceWorker,
      transcriptPath: raceTrPath,
      toolCall: { name: "run_command", args: { CommandLine: `agy-context transcript read --id ${pA}` } }
    });
    assert.equal(raceStep0Res.decision, "deny", "Before Step 1 assignment arrives, pB board fallback denies access");
    fs.appendFileSync(
      raceTrPath,
      JSON.stringify({
        step_index: 1,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        content: `[Message] timestamp=2026-11-16T00:00:08Z sender=${pA} priority=MESSAGE_PRIORITY_HIGH content=Your assignment (recorded on the board as #2 for @audit-race):\n[agy-transcript-access: allow]\nAudit`
      }) + "\n"
    );
    const raceStep1Res = runHook({
      conversationId: raceWorker,
      transcriptPath: raceTrPath,
      toolCall: { name: "run_command", args: { CommandLine: `agy-context transcript read --id ${pA}` } }
    });
    assert.equal(
      raceStep1Res.decision,
      "allow",
      "getCallerLineage must re-inspect when Step 1 Your assignment appends after Step 0 cached !isSwarmChild"
    );

    // Pre-v2 stale cached session.lineage (missing lineageVersion: 2) must be invalidated on upgrade
    const staleCacheWorker = "hermetic-stale-cache-worker";
    const staleCacheTrPath = path.join(brainH, staleCacheWorker, ".system_generated", "logs", "transcript.jsonl");
    writeTr(staleCacheWorker, [
      {
        step_index: 0,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        content: `[Message] timestamp=2026-11-16T00:00:07Z sender=${pB} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #1`
      },
      {
        step_index: 1,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        content: `[Message] timestamp=2026-11-16T00:00:08Z sender=${pA} priority=MESSAGE_PRIORITY_HIGH content=Your assignment (recorded on the board as #2 for @audit-stale):\n[agy-transcript-access: allow]\nAudit`
      }
    ]);
    const staleSessFile = path.join(stateDir, `agy-session-${staleCacheWorker}.json`);
    fs.mkdirSync(path.dirname(staleSessFile), { recursive: true });
    fs.writeFileSync(staleSessFile, JSON.stringify({
      pollCount: 0,
      denials: 0,
      taskIds: [],
      lastPollTime: 0,
      lastSeenTime: Date.now(),
      recentHookCalls: [],
      lineage: {
        transcriptFound: true,
        isTopLevelUserSession: false,
        isChildSession: true,
        isSwarmChild: true,
        parentConvId: pB,
        rosterName: "audit-stale",
        launchDirective: "deny",
        birthTimeMs: 0
      }
    }));
    const upgradedRes = runHook({
      conversationId: staleCacheWorker,
      transcriptPath: staleCacheTrPath,
      toolCall: { name: "run_command", args: { CommandLine: `agy-context transcript read --id ${pA}` } }
    });
    assert.equal(upgradedRes.decision, "allow", "Pre-v2 cached session.lineage must be invalidated and re-bound to Step 1 coordinator");

    // Concatenated SYSTEM_MESSAGE in single JSONL step still binds Your assignment sender= (`ACS-R2-ARCH-001`)
    const concatWorker = "hermetic-concat-worker";
    const concatTrPath = path.join(brainH, concatWorker, ".system_generated", "logs", "transcript.jsonl");
    writeTr(concatWorker, [
      {
        step_index: 0,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        content: `[Message] timestamp=2026-11-16T00:00:07Z sender=${pB} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #1\n[Message] timestamp=2026-11-16T00:00:08Z sender=${pA} priority=MESSAGE_PRIORITY_HIGH content=Your assignment (recorded on the board as #2 for @audit-concat):\n[agy-transcript-access: allow]\nAudit`
      }
    ]);
    const concatRes = runHook({
      conversationId: concatWorker,
      transcriptPath: concatTrPath,
      toolCall: { name: "run_command", args: { CommandLine: `agy-context transcript read --id ${pA}` } }
    });
    assert.equal(concatRes.decision, "allow", "Concatenated SYSTEM_MESSAGE must bind Your assignment to its local sender=");

    // >12 leading board notifications before Your assignment (large swarm)
    const largeSwarmWorker = "hermetic-swarm-large-worker";
    const largeSwarmTr = path.join(brainH, largeSwarmWorker, ".system_generated", "logs", "transcript.jsonl");
    const largeLines = [];
    for (let b = 0; b < 14; b++) {
      largeLines.push({
        step_index: b,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        content: `[Message] timestamp=2026-11-16T00:00:00Z sender=${pB} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #${b + 1}`
      });
    }
    largeLines.push({
      step_index: 14,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `[Message] timestamp=2026-11-16T00:00:14Z sender=${pA} priority=MESSAGE_PRIORITY_HIGH content=Your assignment (recorded on the board as #15 for @audit-large):\n[agy-transcript-access: allow]\nAudit`
    });
    writeTr(largeSwarmWorker, largeLines);
    const largeSwarmHookRes = runHook({
      conversationId: largeSwarmWorker,
      transcriptPath: largeSwarmTr,
      toolCall: { name: "run_command", args: { CommandLine: `agy-context transcript read --id ${pA}` } }
    });
    assert.equal(largeSwarmHookRes.decision, "allow", "getCallerLineage must scan past >12 leading board messages to bind Step 14 coordinator");

    // ACS-PR4-RUN-001 / ACS-TEST-001 / ACS-TEST-002: `transcript dump` hook routing & negative --out coverage
    const dumpAllowed = runHook(
      {
        conversationId: pA,
        cwd: wsDir,
        transcriptPath: path.join(cliBrainRoot, pA, ".system_generated", "logs", "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: "agy-context transcript dump --parent current --sanitized --out scratch/dump-index.md" }
        }
      },
      cliEnv
    );
    assert.equal(dumpAllowed.decision, "allow", "transcript dump --parent current --sanitized --out scratch/... must be allowed");
    assert.match(dumpAllowed.overwrite?.CommandLine || "", new RegExp(`--parent ${pA}`));

    const cliRestrictedDump = "cli-restricted-dump";
    const cliRestrictedDumpLogs = path.join(cliBrainRoot, cliRestrictedDump, ".system_generated", "logs");
    fs.mkdirSync(cliRestrictedDumpLogs, { recursive: true });
    fs.writeFileSync(
      path.join(cliRestrictedDumpLogs, "transcript.jsonl"),
      JSON.stringify({
        step_index: 0,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        content: `[Message] timestamp=2026-11-16T00:00:09Z sender=${pA} priority=MESSAGE_PRIORITY_HIGH content=[agy-transcript-access: self-only]\nSelf-only dump`
      }) + "\n"
    );

    const selfDumpOwn = runHook(
      {
        conversationId: cliRestrictedDump,
        transcriptPath: path.join(cliRestrictedDumpLogs, "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: "agy-context transcript dump --sanitized" }
        }
      },
      cliEnv
    );
    assert.equal(selfDumpOwn.decision, "allow", "self-only caller running transcript dump on own session must be allowed");
    assert.match(selfDumpOwn.overwrite?.CommandLine || "", new RegExp(`--id ${cliRestrictedDump}`));

    for (const badDumpCmd of [
      `agy-context transcript dump --id ${pA} --sanitized --out "${path.join(cliStateDir, "leak.md")}"`,
      `agy-context transcript dump --id ${pA} --sanitized --out "${path.join(cliProfile, ".gemini", "config", "hooks.json.md")}"`,
      `agy-context transcript dump --id ${pA} --sanitized --out ../outside.md`
    ]) {
      const deniedDumpOut = runHook(
        {
          conversationId: pA,
          cwd: wsDir,
          transcriptPath: path.join(cliBrainRoot, pA, ".system_generated", "logs", "transcript.jsonl"),
          toolCall: { name: "run_command", args: { CommandLine: badDumpCmd } }
        },
        cliEnv
      );
      assert.equal(deniedDumpOut.decision, "deny", `Protected/traversal --out must be denied: ${badDumpCmd}`);
    }

    const deniedSelfDumpCross = runHook(
      {
        conversationId: cliRestrictedDump,
        transcriptPath: path.join(cliRestrictedDumpLogs, "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: `agy-context transcript dump --sanitized --id ${pA}` }
        }
      },
      cliEnv
    );
    assert.equal(deniedSelfDumpCross.decision, "deny", "self-only mode must deny cross-session transcript dump");

    const pollBreakerConv = "swarm-poll-breaker";
    for (let attempt = 1; attempt <= 5; attempt++) {
      const schedRes = runHook({
        conversationId: pollBreakerConv,
        toolCall: { name: "schedule", args: { DurationSeconds: 45, Prompt: "Poll swarm board status" } }
      });
      assert.equal(
        schedRes.decision,
        attempt < 5 ? "deny" : "force_ask",
        `Swarm schedule polling attempt #${attempt} must trigger ${attempt < 5 ? "deny" : "force_ask circuit breaker"}`
      );
    }

    // ACS-RUN-002-P3-1: Trailing .md / .json arguments passed after `node <script.mjs> ...` must not be scanned as code,
    // while primary scripts, -r/--require preloads, and `< stdin` redirects in /tmp or scratch/ remain guarded.
    const appDir = path.join(wsDir, "bin");
    fs.mkdirSync(appDir, { recursive: true });
    const appScript = path.join(appDir, "verdict-runner.mjs");
    fs.writeFileSync(appScript, "console.log(process.argv.slice(2));\n", "utf8");
    const scratchReportMd = path.join(wsDir, "scratch", "agy-squad", "lead", "report.md");
    const scratchRecordJson = path.join(wsDir, "scratch", "bundle-record.json");
    fs.mkdirSync(path.dirname(scratchReportMd), { recursive: true });
    fs.writeFileSync(
      scratchReportMd,
      "# Synthesis\nChecked `.system_generated/logs/transcript.jsonl` via `agy-context transcript read --id parent`.\n",
      "utf8"
    );
    fs.writeFileSync(
      scratchRecordJson,
      JSON.stringify({ notes: "Audited ~/.gemini/config/hooks.json and .system_generated/logs/transcript.jsonl" }),
      "utf8"
    );

    // Even when a restricted child wrote scratch/report.md earlier in the session, passing it to `node bin/verdict-runner.mjs` must stay allowed
    const writeScratchNote = runHook(
      {
        conversationId: cliRestricted,
        cwd: wsDir,
        transcriptPath: path.join(cliRestrictedLogs, "transcript.jsonl"),
        toolCall: {
          name: "write_file",
          args: {
            Path: scratchReportMd,
            Content: "# Synthesis\nInspected .system_generated/logs/transcript.jsonl via agy-context transcript list.\n",
            Overwrite: true
          }
        }
      },
      cliEnv
    );
    assert.equal(writeScratchNote.decision, "allow");

    for (const allowedNodeCmd of [
      `node "${appScript}" verdict "${scratchReportMd}"`,
      `node "${appScript}" bundle "${scratchRecordJson}"`,
      `node --dns-result-order verbatim "${appScript}" verdict "${scratchReportMd}"`,
      `node -e "console.log(1)" "${scratchReportMd}"`
    ]) {
      const allowedRes = runHook(
        {
          conversationId: cliRestricted,
          cwd: wsDir,
          transcriptPath: path.join(cliRestrictedLogs, "transcript.jsonl"),
          toolCall: { name: "run_command", args: { CommandLine: allowedNodeCmd } }
        },
        cliEnv
      );
      assert.equal(allowedRes.decision, "allow", `Trailing data arg must NOT be scanned as code: ${allowedNodeCmd}`);
    }

    // Attack cases MUST still be denied: non-script primary operand, preload -r, scratch primary .mjs, and `< stdin`
    const evilMdPayload = path.join(wsDir, "scratch", "evil-script.md");
    const evilMjsPayload = path.join(wsDir, "scratch", "evil-primary.mjs");
    const evilPreloadTxt = path.join(wsDir, "scratch", "preload.txt");
    fs.writeFileSync(evilMdPayload, "console.log(fs.readFileSync('.system_generated/logs/transcript.jsonl', 'utf8'))\n");
    fs.writeFileSync(evilMjsPayload, "import fs from 'node:fs'; fs.readFileSync('.system_generated/logs/transcript.jsonl', 'utf8');\n");
    fs.writeFileSync(evilPreloadTxt, "fs.readFileSync('.system_generated/logs/transcript.jsonl', 'utf8');\n");
    for (const deniedNodeCmd of [
      `node "${evilMdPayload}"`,
      `node "${evilMjsPayload}" "${scratchReportMd}"`,
      `node --dns-result-order verbatim "${evilMjsPayload}"`,
      `node --dns-result-order verbatim "${evilMdPayload}"`,
      `node --experimental-config-file "${scratchRecordJson}" "${evilMjsPayload}"`,
      `node --experimental-config-file "${scratchRecordJson}" "${evilMdPayload}"`,
      `pwsh -ExecutionPolicy Bypass "${evilMjsPayload}"`,
      `node -r "${evilPreloadTxt}" "${appScript}" "${scratchReportMd}"`,
      `bash < "${evilPreloadTxt}"`
    ]) {
      const deniedRes = runHook(
        {
          conversationId: cliRestricted,
          cwd: wsDir,
          transcriptPath: path.join(cliRestrictedLogs, "transcript.jsonl"),
          toolCall: { name: "run_command", args: { CommandLine: deniedNodeCmd } }
        },
        cliEnv
      );
      assert.equal(deniedRes.decision, "deny", `Real script/preload/stdin payload MUST remain denied: ${deniedNodeCmd}`);
    }

    // ACS-SVC-001-P3-1: env-cache.json TTL expiry and RTK binary mtime invalidation
    const cacheProfile = fs.mkdtempSync(path.join(os.tmpdir(), "agy-env-cache-"));
    try {
      const cacheShimDir = path.join(cacheProfile, "bin");
      createRtkShim(cacheShimDir, "1.1.0");
      const cacheStateDir = os.platform() === "win32"
        ? path.join(cacheProfile, "AppData", "Local", "agy-context-saver")
        : path.join(cacheProfile, ".local", "state", "agy-context-saver");
      const cacheEnv = withEnvPath(cacheShimDir, {
        ...process.env,
        AGY_TEST_PROFILE_DIR: cacheProfile,
        XDG_STATE_HOME: os.platform() === "win32" ? undefined : path.join(cacheProfile, ".local", "state"),
        LOCALAPPDATA: os.platform() === "win32" ? path.join(cacheProfile, "AppData", "Local") : undefined
      });
      const firstCacheRes = runHook({ toolCall: { name: "run_command", args: { CommandLine: "git status" } } }, cacheEnv);
      assert.equal(firstCacheRes.overwrite?.CommandLine, "rtk git status");
      const envCachePath = path.join(cacheStateDir, "env-cache.json");
      assert.ok(fs.existsSync(envCachePath), "Hook must persist env-cache.json");
      const writtenCache = JSON.parse(fs.readFileSync(envCachePath, "utf8"));
      assert.equal(typeof writtenCache.pathEnv, "string", "env-cache.json must persist pathEnv for zero-scan warm lookup");
      assert.equal(typeof writtenCache.rgAvailable, "boolean", "env-cache.json must persist rgAvailable for zero-scan warm lookup");

      // Warm fast-path: trusts cached resolved=null + rgAvailable while pathEnv, TTL, and mtime match
      fs.writeFileSync(envCachePath, JSON.stringify({ ...writtenCache, ts: Date.now(), resolved: null }));
      const warmFastPathMiss = runHook({ toolCall: { name: "run_command", args: { CommandLine: "git status" } } }, cacheEnv);
      assert.equal(warmFastPathMiss.overwrite?.CommandLine, undefined, "Warm env-cache fast-path must serve cached entry while pathEnv/TTL/mtime match");

      // Poison resolved=null with fresh ts (legacy schema without pathEnv): hook trusts valid non-expired cache for matching mtime key
      fs.writeFileSync(envCachePath, JSON.stringify({ key: writtenCache.key, ts: Date.now(), resolved: null }));
      const freshCachedMiss = runHook({ toolCall: { name: "run_command", args: { CommandLine: "git status" } } }, cacheEnv);
      assert.equal(freshCachedMiss.overwrite?.CommandLine, undefined, "Fresh env-cache entry must be served while TTL and mtime match");

      // Expire TTL (> 60s): hook must re-probe RTK and rewrite
      fs.writeFileSync(envCachePath, JSON.stringify({ key: writtenCache.key, ts: Date.now() - 65000, resolved: null }));
      const expiredCacheRes = runHook({ toolCall: { name: "run_command", args: { CommandLine: "git status" } } }, cacheEnv);
      assert.equal(expiredCacheRes.overwrite?.CommandLine, "rtk git status", "Expired env-cache.json TTL must invalidate and re-probe RTK");

      // Re-poison with fresh ts, then bump shim binary mtime: key mismatch must invalidate immediately before TTL
      const refreshedCache = JSON.parse(fs.readFileSync(envCachePath, "utf8"));
      fs.writeFileSync(envCachePath, JSON.stringify({ key: refreshedCache.key, ts: Date.now(), resolved: null }));
      const shimFile = path.join(cacheShimDir, os.platform() === "win32" ? "rtk.cmd" : "rtk");
      const nextTime = new Date(Date.now() + 10000);
      fs.utimesSync(shimFile, nextTime, nextTime);
      const mtimeInvalidatedRes = runHook({ toolCall: { name: "run_command", args: { CommandLine: "git status" } } }, cacheEnv);
      assert.equal(mtimeInvalidatedRes.overwrite?.CommandLine, "rtk git status", "Changed RTK binary mtime must invalidate env-cache.json key immediately");
    } finally {
      fs.rmSync(cacheProfile, { recursive: true, force: true });
    }

    // Blocking CI watch loop guard (gh pr checks --watch / gh run watch)
    for (const blockedWatchCmd of [
      "gh pr checks 4 --repo paragon-ux/Agy-Context-Saver --watch --interval 15",
      "gh pr checks 7 -R paragon-ux/Agy-Squad -w",
      "gh pr checks 7 -wi 15",
      "gh pr checks 4 --watch=true",
      "rtk gh pr checks 4 --watch",
      "env GH_HOST=github.com gh pr checks 4 -w",
      "gh run watch 43948962826 -R paragon-ux/Agy-Context-Saver",
      "bash -c 'gh run watch 43948962826'",
      "bash <<\"EOF\"\ngh run watch 43948962826\nEOF",
      "cat <<'EOF' | sh\ngh pr checks 4 -w\nEOF",
      "echo $(gh pr checks 4 -w)"
    ]) {
      const watchDeny = runHook(
        {
          conversationId: "ci-watch-deny",
          cwd: wsDir,
          toolCall: { name: "run_command", args: { CommandLine: blockedWatchCmd } }
        },
        cliEnv
      );
      assert.equal(watchDeny.decision, "deny", `Blocking CI watch loop must be denied: ${blockedWatchCmd}`);
      assert.match(watchDeny.reason, /Blocking CI watch loop/i);
      assert.doesNotMatch(watchDeny.reason, />= 60s/);
      assert.match(watchDeny.reason, /Math\.max\(30,\s*requiredBackoffSec\)[\s\S]*30s[\s\S]*75s/);
    }

    for (const allowedGhCmd of [
      "gh pr checks 4 -R paragon-ux/workflow-repo",
      "gh pr checks 4 -Rmywork/repo",
      "gh pr checks 4 --repo paragon-ux/Agy-Context-Saver --watch=false",
      "gh pr checks --watch --help",
      "gh run list -R paragon-ux/Agy-Context-Saver -L 5",
      "gh run watch --help",
      "cat > notes.md <<'EOF'\ngh run watch 43948962826\nEOF",
      "git commit -m \"block gh pr checks --watch and gh run watch\"",
      "rtk grep \"gh run watch\" scripts/"
    ]) {
      const watchAllow = runHook(
        {
          conversationId: "ci-watch-allow",
          cwd: wsDir,
          toolCall: { name: "run_command", args: { CommandLine: allowedGhCmd } }
        },
        cliEnv
      );
      assert.equal(watchAllow.decision, "allow", `Non-blocking gh/text command must stay allowed: ${allowedGhCmd}`);
    }

    // LEAD-DEP-001: sibling Agy-Squad mcp/index.js probes allowed while Agy-Context-Saver internal paths stay blocked
    for (const allowedSiblingProbe of [
      "node -e \"import('../Agy-Squad/mcp/index.js')\"",
      "node mcp/index.js --help",
      "node ../Agy-Squad/mcp/index.js"
    ]) {
      const siblingRes = runHook(
        {
          conversationId: "lead-dep-allow",
          cwd: wsDir,
          toolCall: { name: "run_command", args: { CommandLine: allowedSiblingProbe } }
        },
        cliEnv
      );
      assert.equal(siblingRes.decision, "allow", `Sibling mcp/index.js probe must be allowed (LEAD-DEP-001): ${allowedSiblingProbe}`);
    }
    for (const blockedInternalProbe of [
      "node -e \"import('./lib/transcript-core.mjs')\"",
      "node -e \"import('agy-context-saver/mcp/index.js')\"",
      "node -e \"import('./bin/agy-context.mjs')\"",
      "node bin/agy-context.mjs transcript health && true"
    ]) {
      const internalRes = runHook(
        {
          conversationId: "lead-dep-deny",
          cwd: wsDir,
          toolCall: { name: "run_command", args: { CommandLine: blockedInternalProbe } }
        },
        cliEnv
      );
      assert.equal(internalRes.decision, "deny", `Internal Agy-Context-Saver script probe must remain denied: ${blockedInternalProbe}`);
    }

    // ACS-HOOK-GREP-CLAMP: implicit grep is reverted (lossless), explicit `rtk grep` allowed, >45 KiB spillover rtk read fails loud without silent --tail-lines rewrite
    const implicitGrepRes = runHook(
      {
        conversationId: "grep-clamp-implicit",
        cwd: wsDir,
        toolCall: { name: "run_command", args: { CommandLine: 'grep -rn "HOOK_KEY" scripts/', WaitMsBeforeAsync: 5000 } }
      },
      cliEnv
    );
    assert.equal(implicitGrepRes.decision, "allow");
    assert.equal(
      implicitGrepRes.overwrite?.CommandLine,
      undefined,
      "Implicit grep must not be silently lossy-rewritten to rtk grep (ACS-HOOK-GREP-CLAMP)"
    );

    const explicitRtkGrepRes = runHook(
      {
        conversationId: "grep-clamp-explicit",
        cwd: wsDir,
        toolCall: { name: "run_command", args: { CommandLine: 'rtk grep -rn "HOOK_KEY" scripts/', WaitMsBeforeAsync: 5000 } }
      },
      cliEnv
    );
    assert.equal(explicitRtkGrepRes.decision, "allow");

    const largeSpillDir = path.join(wsDir, ".system_generated", "steps", "99");
    fs.mkdirSync(largeSpillDir, { recursive: true });
    const largeSpillFile = path.join(largeSpillDir, "output.txt");
    fs.writeFileSync(largeSpillFile, "L".repeat(47000), "utf8");
    const unboundedLargeSpill = runHook(
      {
        conversationId: "spill-clamp-unbounded",
        cwd: wsDir,
        toolCall: { name: "run_command", args: { CommandLine: `rtk read "${largeSpillFile}"`, WaitMsBeforeAsync: 5000 } }
      },
      cliEnv
    );
    assert.equal(
      unboundedLargeSpill.decision,
      "deny",
      "Unbounded rtk read on >45 KiB spillover must deny with explicit --head-lines/--tail-lines guidance rather than silently rewriting to --tail-lines 150 (ACS-HOOK-GREP-CLAMP)"
    );
    assert.match(unboundedLargeSpill.reason, /--head-lines 150/);
    assert.match(unboundedLargeSpill.reason, /--tail-lines 150/);

    // Filter --level/-l does not bound line counts and must not bypass >45 KiB spillover protection
    for (const nonBoundFlag of ["-l none", "--level minimal", "--level=none", "-n"]) {
      const levelBypassRes = runHook(
        {
          conversationId: "spill-clamp-level",
          cwd: wsDir,
          toolCall: { name: "run_command", args: { CommandLine: `rtk read ${nonBoundFlag} "${largeSpillFile}"`, WaitMsBeforeAsync: 5000 } }
        },
        cliEnv
      );
      assert.equal(
        levelBypassRes.decision,
        "deny",
        `Non-line-bounding 'rtk read ${nonBoundFlag}' on >45 KiB spillover must still deny (ACS-HOOK-GREP-CLAMP)`
      );
    }

    const boundedHeadLargeSpill = runHook(
      {
        conversationId: "spill-clamp-head",
        cwd: wsDir,
        toolCall: { name: "run_command", args: { CommandLine: `rtk read --head-lines 150 "${largeSpillFile}"`, WaitMsBeforeAsync: 5000 } }
      },
      cliEnv
    );
    assert.equal(boundedHeadLargeSpill.decision, "allow");

    // Two-tier ergonomics hook regressions: --line-start/--line-end/--max-chars/--out value flags & path guards across read/query/outline/step
    for (const validErgoCmd of [
      `agy-context transcript read --id ${pA} --full --max-chars 16000 --out scratch/read_ergo.md`,
      `agy-context transcript outline --id ${pA} --full --out scratch/outline_ergo.md`,
      `agy-context transcript query --id ${pA} "verdict" --max-chars 12000 --out scratch/query_ergo.json`,
      `agy-context transcript tools --id ${pA} --full --out scratch/tools_ergo.md`,
      `agy-context transcript step --id ${pA} --step 1 --field tool_args:CommandLine --line-start 1 --line-end 30 --max-chars 8000`,
      `agy-context transcript step --id ${pA} --step 1 --full --out scratch/step_ergo.txt`
    ]) {
      const okErgoHook = runHook(
        {
          conversationId: pA,
          cwd: wsDir,
          transcriptPath: path.join(cliBrainRoot, pA, ".system_generated", "logs", "transcript.jsonl"),
          toolCall: { name: "run_command", args: { CommandLine: validErgoCmd } }
        },
        cliEnv
      );
      assert.equal(okErgoHook.decision, "allow", `Valid new transcript flags must be allowed by hook: ${validErgoCmd} (${okErgoHook.reason || ""})`);
    }

    for (const badOutErgoCmd of [
      `agy-context transcript read --id ${pA} --out scripts/evil.mjs`,
      `agy-context transcript outline --id ${pA} --out benchmarks/evil.json`,
      `agy-context transcript query --id ${pA} "x" --out .system_generated/evil.txt`,
      `agy-context transcript step --id ${pA} --step 1 --out eval_data.exe`
    ]) {
      const denyOutHook = runHook(
        {
          conversationId: pA,
          cwd: wsDir,
          transcriptPath: path.join(cliBrainRoot, pA, ".system_generated", "logs", "transcript.jsonl"),
          toolCall: { name: "run_command", args: { CommandLine: badOutErgoCmd } }
        },
        cliEnv
      );
      assert.equal(denyOutHook.decision, "deny", `Protected/unsafe --out path must be denied by hook: ${badOutErgoCmd}`);
    }

    const ergoRestricted = "cli-self-ergo-child";
    const ergoRestrictedLogs = path.join(cliBrainRoot, ergoRestricted, ".system_generated", "logs");
    fs.mkdirSync(ergoRestrictedLogs, { recursive: true });
    fs.writeFileSync(
      path.join(ergoRestrictedLogs, "transcript.jsonl"),
      JSON.stringify({
        step_index: 0,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        content: `[Message] timestamp=2026-11-17T00:00:05Z sender=${pA} priority=MESSAGE_PRIORITY_HIGH content=[agy-transcript-access: self-only]\nErgo CLI task`
      }) + "\n"
    );

    const selfStepSliceOut = runHook(
      {
        conversationId: ergoRestricted,
        cwd: wsDir,
        transcriptPath: path.join(ergoRestrictedLogs, "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: "agy-context transcript step --step 1 --field tool_args:CommandLine --line-start 1 --line-end 10 --out scratch/self_step.md" }
        }
      },
      cliEnv
    );
    assert.equal(selfStepSliceOut.decision, "allow", "self-only caller using --line-start/--line-end/--out on own transcript must be allowed");
    assert.match(selfStepSliceOut.overwrite?.CommandLine || "", new RegExp(`--id ${ergoRestricted}`));

    const selfStepOtherDeny = runHook(
      {
        conversationId: ergoRestricted,
        cwd: wsDir,
        transcriptPath: path.join(ergoRestrictedLogs, "transcript.jsonl"),
        toolCall: {
          name: "run_command",
          args: { CommandLine: `agy-context transcript step --id ${pA} --step 1 --line-start 1 --line-end 10 --out scratch/other.md` }
        }
      },
      cliEnv
    );
    assert.equal(selfStepOtherDeny.decision, "deny", "self-only caller passing --id <other> with new step flags must be denied");

    // PR #7 audit regressions: self-only --out confinement, unexpanded shell tokens, hooks.json, UNC, quoted `current`
    for (const badSelfOut of [
      `agy-context transcript read --out ${path.join(cliBrainRoot, pA, "notes.md")}`,
      "agy-context transcript read --out AGENTS.md",
      "agy-context transcript read --out $HOME/scratch/x.md",
      "agy-context transcript read --out ~/scratch/x.md",
      "agy-context transcript read --out scratch/hooks.json",
      "agy-context transcript read --out //server/share/leak.md"
    ]) {
      const deniedSelfOut = runHook(
        {
          conversationId: ergoRestricted,
          cwd: wsDir,
          transcriptPath: path.join(ergoRestrictedLogs, "transcript.jsonl"),
          toolCall: { name: "run_command", args: { CommandLine: badSelfOut } }
        },
        cliEnv
      );
      assert.equal(deniedSelfOut.decision, "deny", `Unsafe self-only --out must be denied: ${badSelfOut}`);
    }

    const quotedCurrent = runHook(
      {
        conversationId: ergoRestricted,
        cwd: wsDir,
        transcriptPath: path.join(ergoRestrictedLogs, "transcript.jsonl"),
        toolCall: { name: "run_command", args: { CommandLine: 'agy-context transcript read --id="current"' } }
      },
      cliEnv
    );
    assert.equal(quotedCurrent.decision, "allow");
    assert.match(quotedCurrent.overwrite?.CommandLine || "", new RegExp(`--id ${ergoRestricted}$`), "quoted current must be rewritten without a dangling quote");

    const queryLiteralId = runHook(
      {
        conversationId: ergoRestricted,
        cwd: wsDir,
        transcriptPath: path.join(ergoRestrictedLogs, "transcript.jsonl"),
        toolCall: { name: "run_command", args: { CommandLine: 'agy-context transcript query "--id current"' } }
      },
      cliEnv
    );
    if (queryLiteralId.decision === "allow") {
      assert.match(queryLiteralId.overwrite?.CommandLine || "", /"--id current"/, "query literal must not be rewritten");
      assert.match(queryLiteralId.overwrite?.CommandLine || "", new RegExp(`--id ${ergoRestricted}`));
    }

    console.log("✓ Group H regression checks passed (payload.cwd, 2>/dev/null, antigravity-cli, swarm_view, Step0>16KiB, cross-swarm isolation, query current, Wave 2 regressions)");
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
    fs.rmSync(cliProfile, { recursive: true, force: true });
  }
}

// ============================================================================
// GROUP I: PR #7 L46 Remediations (Tier 4 Option A Reset Parity & Export Flags)
// ============================================================================
console.log("\n--- Group I: Tier 4 Immutability After Reset & Export Flag Parsing ---");
{
  resetState();
  const brainI = path.join(hermetic.profileDir, ".gemini", "antigravity", "brain");
  const writeTrI = (id, steps) => {
    const dir = path.join(brainI, id, ".system_generated", "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "transcript.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
  };
  const coordI = "coord-group-i";
  const specDenyI = "spec-deny-group-i";
  writeTrI(coordI, [{ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Coord I" }]);
  writeTrI(specDenyI, [{
    step_index: 0,
    source: "SYSTEM",
    type: "SYSTEM_MESSAGE",
    content: `[Message] timestamp=2026-11-18T00:00:00Z sender=${coordI} priority=MESSAGE_PRIORITY_HIGH content=Your assignment (recorded on the board as #1 for @i-spec1):\n[agy-transcript-access: deny]\nDo work`
  }]);

  // 1. Denied at baseline
  assert.equal(
    runHook({ conversationId: specDenyI, toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript list --limit 1" } } }).decision,
    "deny"
  );

  // 2. Temporary Tier 3 --allow permits read + export with --full and --max-chars before/after flags
  assert.equal(
    runHook({ conversationId: coordI, toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript access --mode allowlist --allow @i-spec*" } } }).decision,
    "allow"
  );
  spawnSync(process.execPath, [path.resolve(repoRoot, "bin/agy-context.mjs"), "transcript", "access", "--mode", "allowlist", "--allow", "@i-spec*"], { encoding: "utf-8", env: process.env });

  const exportWithMaxCharsHook = runHook({
    conversationId: specDenyI,
    cwd: process.cwd(),
    toolCall: {
      name: "run_command",
      args: { CommandLine: `agy-context transcript export --max-chars 50000 ${specDenyI} --sanitized --full --json` }
    }
  });
  assert.equal(exportWithMaxCharsHook.decision, "allow", "Allowlisted child running export with --max-chars before <id> and --full must be parsed & allowed");

  // 3. Coordinator resets policy: status discloses remaining Tier 4 deny child, and child immediately drops back to Tier 4 deny
  assert.equal(
    runHook({ conversationId: coordI, toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript access --reset --json" } } }).decision,
    "allow"
  );
  const resetExecI = spawnSync(
    process.execPath,
    [path.resolve(repoRoot, "bin/agy-context.mjs"), "transcript", "access", "--reset", "--json"],
    { encoding: "utf-8", env: { ...process.env, GEMINI_CONVERSATION_ID: coordI } }
  );
  assert.equal(resetExecI.status, 0, resetExecI.stderr);
  const resetPayloadI = JSON.parse(resetExecI.stdout);
  assert.equal(resetPayloadI.mode, "open");
  assert.equal(resetPayloadI.launchRestrictions.restrictedCount, 1);
  assert.equal(resetPayloadI.launchRestrictions.sessions[0].conversationId, specDenyI);

  const deniedAfterResetHook = runHook({
    conversationId: specDenyI,
    toolCall: { name: "run_command", args: { CommandLine: `agy-context transcript export --max-chars 50000 ${specDenyI} --sanitized` } }
  });
  assert.equal(deniedAfterResetHook.decision, "deny", "Tier 4 launch-directive deny must remain immutable after parent access --reset");
  assert.match(deniedAfterResetHook.reason || "", /source=launch-directive/);

  const badExportExtraPos = runHook({
    conversationId: coordI,
    toolCall: { name: "run_command", args: { CommandLine: `agy-context transcript export --parent ${coordI} extra-pos --sanitized` } }
  });
  assert.equal(badExportExtraPos.decision, "deny", "export --parent with unexpected positional arg must fail hook validation");
  const badTildeUserOut = runHook({
    conversationId: coordI,
    toolCall: { name: "run_command", args: { CommandLine: `agy-context transcript read --id ${coordI} --out ~otheruser/leak.md` } }
  });
  assert.equal(badTildeUserOut.decision, "deny", "--out ~user/... tilde expansion must be blocked by hook");

  console.log("✓ Group I Tier 4 reset immutability + export --max-chars/--full hook checks passed");
}

// ============================================================================
// GROUP J: Launch UX Day-One Readiness Regressions (UX-ACS-001/002/003/007/008)
// ============================================================================
console.log("\n--- Group J: Launch UX Day-One Regressions (Local RTK, Degraded Mode, Shim Fallback, Env Scope, Benchmark Opt-Out) ---");
{
  // J.1: UX-ACS-001 - Explicit `rtk ...` commands rewrite to local pluginDest/bin/rtk when rtk is absent from PATH
  const localRtkProfile = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ux-local-rtk-"));
  try {
    const localPluginBin = path.join(localRtkProfile, ".gemini", "config", "plugins", "agy-context-saver", "bin");
    const localRtkBin = createRtkShim(localPluginBin, "1.1.0");
    const fakeRgDir = path.join(localRtkProfile, "rg-only-bin");
    fs.mkdirSync(fakeRgDir, { recursive: true });
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(fakeRgDir, "rg.cmd"), "@echo off\r\necho ripgrep 14.0.0\r\n");
    } else {
      const fakeRg = path.join(fakeRgDir, "rg");
      fs.writeFileSync(fakeRg, "#!/bin/sh\necho 'ripgrep 14.0.0'\n");
      fs.chmodSync(fakeRg, 0o755);
    }
    const expectedWinLauncher = path.join(repoRoot, "scripts", "rtk-run.mjs").replace(/\\/g, "/");
    const expectedNormPrefix =
      process.platform === "win32"
        ? `node "${expectedWinLauncher}"`
        : localRtkBin.replace(/\\/g, "/");
    const emptyBin = path.join(localRtkProfile, "empty-bin");
    fs.mkdirSync(emptyBin, { recursive: true });

    for (const [label, pathDir] of [["without rg", emptyBin], ["with rg on PATH", fakeRgDir]]) {
      const localEnv = withEnvPath(pathDir, { ...process.env, AGY_TEST_PROFILE_DIR: localRtkProfile });
      for (const cmd of [
        "rtk ls .",
        "rtk find .",
        "rtk read .system_generated/steps/1/output.txt",
        "rtk grep -rnE foo .",
        "rtk err npm test",
        "rtk summary git status"
      ]) {
        const res = runHook(
          { toolCall: { name: "run_command", args: { CommandLine: cmd, WaitMsBeforeAsync: 5000 } } },
          localEnv
        );
        assert.equal(res.decision, "allow", `Explicit '${cmd}' (${label}) must be allowed`);
        assert.ok(
          res.overwrite?.CommandLine?.startsWith(expectedNormPrefix),
          `Explicit '${cmd}' (${label}) must rewrite to local plugin rtk '${expectedNormPrefix}', got: ${res.overwrite?.CommandLine}`
        );
      }
    }
    console.log("✓ UX-ACS-001: Explicit rtk commands rewrite to local pluginDest/bin/rtk (with & without rg)");
  } finally {
    fs.rmSync(localRtkProfile, { recursive: true, force: true });
  }

  // J.2: UX-ACS-002 - Degraded mode without RTK allows native discovery & bounded spillover reads while keeping protection
  const degradedProfile = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ux-degraded-"));
  try {
    const emptyBin = path.join(degradedProfile, "empty-bin");
    fs.mkdirSync(emptyBin, { recursive: true });
    const degradedEnv = withEnvPath(emptyBin, { ...process.env, AGY_TEST_PROFILE_DIR: degradedProfile });

    for (const toolCall of [
      { name: "grep_search", args: { Query: "runInstall", SearchPath: "scripts" } },
      { name: "find_by_name", args: { Pattern: "*.mjs", SearchPath: "." } },
      { name: "list_dir", args: { Path: "scripts" } }
    ]) {
      const res = runHook({ toolCall }, degradedEnv);
      assert.equal(res.decision, "allow", `Degraded mode must allow ${toolCall.name}`);
    }

    // Internal .system_generated protection stays enforced in degraded mode
    assert.equal(
      runHook({ toolCall: { name: "grep_search", args: { Query: "foo", SearchPath: ".system_generated/logs" } } }, degradedEnv).decision,
      "deny"
    );
    assert.equal(
      runHook({ toolCall: { name: "read_file", args: { Path: ".system_generated/logs/transcript.jsonl", StartLine: 1, EndLine: 5 } } }, degradedEnv).decision,
      "deny"
    );

    // Unbounded read_file still denied, but guidance omits rtk and recommends native grep_search first (UX-ACS-R2-002)
    const degradedReadDeny = runHook(
      { toolCall: { name: "read_file", args: { Path: path.join(repoRoot, "scripts", "execution-guard-hook.mjs") } } },
      degradedEnv
    );
    assert.equal(degradedReadDeny.decision, "deny");
    assert.equal(degradedReadDeny.reason.includes("rtk "), false, "Degraded read_file guidance must not mention missing rtk");
    assert.match(degradedReadDeny.reason, /'grep_search'/, "Degraded read_file guidance must recommend native grep_search first (UX-ACS-R2-002)");
    assert.match(degradedReadDeny.reason, /grep -rnE|rg/);

    const degradedReadMany = runHook(
      { toolCall: { name: "read_many_files", args: { Paths: ["README.md", "package.json"] } } },
      degradedEnv
    );
    assert.equal(degradedReadMany.decision, "deny");
    assert.equal(degradedReadMany.reason.includes("rtk read"), false);
    assert.match(degradedReadMany.reason, /head -n 150/);

    // Bounded spillover head/tail allowed, unbounded/multi-file denied
    assert.equal(
      runHook({ toolCall: { name: "run_command", args: { CommandLine: "head -n 150 .system_generated/steps/1/output.txt" } } }, degradedEnv).decision,
      "allow"
    );
    assert.equal(
      runHook({ toolCall: { name: "run_command", args: { CommandLine: "tail -n 50 .system_generated/steps/1/output.txt" } } }, degradedEnv).decision,
      "allow"
    );
    assert.equal(
      runHook({ toolCall: { name: "run_command", args: { CommandLine: "head -n 200 .system_generated/steps/1/output.txt" } } }, degradedEnv).decision,
      "deny"
    );
    assert.equal(
      runHook({ toolCall: { name: "run_command", args: { CommandLine: "head -n 150 .system_generated/steps/1/output.txt /etc/passwd" } } }, degradedEnv).decision,
      "deny"
    );
    console.log("✓ UX-ACS-002: Degraded mode without RTK unblocks native discovery and bounded spillover reads cleanly");
  } finally {
    fs.rmSync(degradedProfile, { recursive: true, force: true });
  }

  // J.3: UX-ACS-003 - Bare `agy-context transcript ...` rewrites to installed shim (or plugin CLI) when absent from PATH
  const agyShimProfile = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ux-cli-shim-"));
  try {
    const emptyBin = path.join(agyShimProfile, "empty-bin");
    const agyBinDir = path.join(agyShimProfile, ".gemini", "antigravity", "bin");
    const agyPluginBin = path.join(agyShimProfile, ".gemini", "config", "plugins", "agy-context-saver", "bin");
    fs.mkdirSync(emptyBin, { recursive: true });
    fs.mkdirSync(agyBinDir, { recursive: true });
    fs.mkdirSync(agyPluginBin, { recursive: true });
    const shimFile = path.join(agyBinDir, process.platform === "win32" ? "agy-context.cmd" : "agy-context");
    fs.writeFileSync(shimFile, process.platform === "win32" ? "@echo off\r\necho ok\r\n" : "#!/bin/sh\necho ok\n", "utf-8");
    if (process.platform !== "win32") fs.chmodSync(shimFile, 0o755);
    const pluginCliFile = path.join(agyPluginBin, "agy-context.mjs");
    fs.writeFileSync(pluginCliFile, "// stub\n", "utf-8");

    const offPathEnv = withEnvPath(emptyBin, { ...process.env, AGY_TEST_PROFILE_DIR: agyShimProfile });
    const shimRes = runHook(
      { toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript health", WaitMsBeforeAsync: 5000 } } },
      offPathEnv
    );
    assert.equal(shimRes.decision, "allow");
    const expectedRewriteCmd = process.platform === "win32"
      ? `node "${pluginCliFile.replace(/\\/g, "/")}" transcript health`
      : `${shimFile.replace(/\\/g, "/")} transcript health`;
    assert.equal(
      shimRes.overwrite?.CommandLine,
      expectedRewriteCmd,
      "Bare agy-context off PATH must rewrite to installed CLI (node <pluginCli> on win32, shim on POSIX)"
    );

    // When agyBinDir IS on PATH, no rewrite is needed
    const onPathEnv = withEnvPath(agyBinDir, { ...process.env, AGY_TEST_PROFILE_DIR: agyShimProfile });
    const onPathRes = runHook(
      { toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript health", WaitMsBeforeAsync: 5000 } } },
      onPathEnv
    );
    assert.equal(onPathRes.decision, "allow");
    assert.equal(onPathRes.overwrite?.CommandLine, undefined, "Bare agy-context on PATH must pass through unrewritten");

    // On Windows, falling back to shimFile still works when pluginCli is absent
    if (process.platform === "win32") {
      fs.unlinkSync(pluginCliFile);
      const winShimFallbackRes = runHook(
        { toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript health", WaitMsBeforeAsync: 5000 } } },
        offPathEnv
      );
      assert.equal(winShimFallbackRes.decision, "allow");
      assert.equal(winShimFallbackRes.overwrite?.CommandLine, `${shimFile} transcript health`);
      fs.writeFileSync(pluginCliFile, "// stub\n", "utf-8");
    }

    // When shim is absent, fall back to `node "<pluginDest>/bin/agy-context.mjs"`
    fs.unlinkSync(shimFile);
    const fallbackRes = runHook(
      { toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript read --last-turns 2", WaitMsBeforeAsync: 5000 } } },
      offPathEnv
    );
    assert.equal(fallbackRes.decision, "allow");
    assert.equal(
      fallbackRes.overwrite?.CommandLine,
      `node "${pluginCliFile.replace(/\\/g, "/")}" transcript read --last-turns 2`,
      "Missing shim must fall back to node <pluginDest>/bin/agy-context.mjs"
    );

    // UX-ACS-R2-003: Spaced user profile directory (`Jane Doe Profile`) rewrites cleanly and executes without PowerShell leading-quote breakage
    const spacedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ux-spaced-root-"));
    try {
      const spacedProfile = path.join(spacedRoot, "Jane Doe Profile");
      const spacedEmptyBin = path.join(spacedRoot, "empty-bin");
      const spacedBinDir = path.join(spacedProfile, ".gemini", "antigravity", "bin");
      const spacedPluginBin = path.join(spacedProfile, ".gemini", "config", "plugins", "agy-context-saver", "bin");
      fs.mkdirSync(spacedEmptyBin, { recursive: true });
      fs.mkdirSync(spacedBinDir, { recursive: true });
      fs.mkdirSync(spacedPluginBin, { recursive: true });
      const spacedShim = path.join(spacedBinDir, process.platform === "win32" ? "agy-context.cmd" : "agy-context");
      fs.writeFileSync(spacedShim, process.platform === "win32" ? "@echo off\r\necho ok-shim\r\n" : "#!/bin/sh\necho ok-shim\n", "utf-8");
      if (process.platform !== "win32") fs.chmodSync(spacedShim, 0o755);
      const spacedPluginCli = path.join(spacedPluginBin, "agy-context.mjs");
      fs.writeFileSync(spacedPluginCli, 'console.log("ok-plugin-cli");\n', "utf-8");

      const spacedOffPathEnv = withEnvPath(spacedEmptyBin, { ...process.env, AGY_TEST_PROFILE_DIR: spacedProfile });
      const spacedRes = runHook(
        { toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript health", WaitMsBeforeAsync: 5000 } } },
        spacedOffPathEnv
      );
      assert.equal(spacedRes.decision, "allow");
      if (process.platform === "win32") {
        assert.equal(
          spacedRes.overwrite?.CommandLine,
          `node "${spacedPluginCli.replace(/\\/g, "/")}" transcript health`,
          "Windows spaced profile dir must rewrite bare agy-context to bare `node \"<pluginCli>\"` (UX-ACS-R2-003)"
        );
        assert.equal(
          spacedRes.overwrite?.CommandLine.startsWith('"'),
          false,
          "Windows rewrite must never emit a leading double-quoted .cmd path that fails PowerShell parsing (UX-ACS-R2-003)"
        );
        const psEnv = { ...process.env };
        prependToPath(path.dirname(process.execPath), psEnv);
        const psRun = spawnSync("powershell", ["-NoProfile", "-Command", spacedRes.overwrite.CommandLine], {
          env: psEnv,
          encoding: "utf-8"
        });
        assert.equal(psRun.status, 0, `PowerShell execution of rewritten spaced command failed: ${psRun.stderr}`);
        assert.match(psRun.stdout, /ok-plugin-cli/);
      } else {
        assert.equal(
          spacedRes.overwrite?.CommandLine,
          `"${spacedShim.replace(/\\/g, "/")}" transcript health`,
          "POSIX spaced profile dir must properly quote shim path"
        );
        const shRun = spawnSync("/bin/sh", ["-c", spacedRes.overwrite.CommandLine], { encoding: "utf-8" });
        assert.equal(shRun.status, 0, `POSIX shell execution of rewritten spaced command failed: ${shRun.stderr}`);
        assert.match(shRun.stdout, /ok-shim/);

        // Also verify node "<pluginCli>" fallback executes cleanly with spaces in profile path
        fs.unlinkSync(spacedShim);
        const spacedFallbackRes = runHook(
          { toolCall: { name: "run_command", args: { CommandLine: "agy-context transcript read --last-turns 2", WaitMsBeforeAsync: 5000 } } },
          spacedOffPathEnv
        );
        assert.equal(spacedFallbackRes.decision, "allow");
        assert.equal(
          spacedFallbackRes.overwrite?.CommandLine,
          `node "${spacedPluginCli.replace(/\\/g, "/")}" transcript read --last-turns 2`
        );
        const nodeEnv = { ...process.env };
        prependToPath(path.dirname(process.execPath), nodeEnv);
        const nodeRun = spawnSync("/bin/sh", ["-c", spacedFallbackRes.overwrite.CommandLine], {
          env: nodeEnv,
          encoding: "utf-8"
        });
        assert.equal(nodeRun.status, 0, `POSIX shell execution of node "<pluginCli>" failed: ${nodeRun.stderr}`);
        assert.match(nodeRun.stdout, /ok-plugin-cli/);
      }
    } finally {
      fs.rmSync(spacedRoot, { recursive: true, force: true });
    }
    console.log("✓ UX-ACS-003 / UX-ACS-R2-003: Bare agy-context rewrites cleanly off PATH (including spaced profile dirs)");
  } finally {
    fs.rmSync(agyShimProfile, { recursive: true, force: true });
  }

  // J.4: UX-ACS-007 - Scoped XDG_STATE_HOME / LOCALAPPDATA protection
  {
    resetState();
    const brainJ = path.join(hermetic.profileDir, ".gemini", "antigravity", "brain");
    const writeTrJ = (id, steps) => {
      const dir = path.join(brainJ, id, ".system_generated", "logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "transcript.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
    };
    const parentJ = "parent-group-j";
    const childDenyJ = "child-deny-group-j";
    writeTrJ(parentJ, [{ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Parent J" }]);
    writeTrJ(childDenyJ, [{
      step_index: 0,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      content: `[Message] timestamp=2026-11-19T00:00:00Z sender=${parentJ} priority=MESSAGE_PRIORITY_HIGH content=[agy-transcript-access: deny]\nWorker`
    }]);

    // Normal user tests allowed for non-restricted parent
    assert.equal(
      runHook({ conversationId: parentJ, toolCall: { name: "run_command", args: { CommandLine: "XDG_STATE_HOME=/tmp/my-app pytest" } } }).decision,
      "allow",
      "XDG_STATE_HOME=/tmp/my-app pytest must be allowed for normal parent session"
    );
    assert.equal(
      runHook({ conversationId: parentJ, toolCall: { name: "run_command", args: { CommandLine: "LOCALAPPDATA=/tmp/my-app npm test" } } }).decision,
      "allow",
      "LOCALAPPDATA=/tmp/my-app npm test must be allowed for normal parent session"
    );

    // Governance-targeting state env redirects and Antigravity env vars stay denied
    assert.equal(
      runHook({ conversationId: parentJ, toolCall: { name: "run_command", args: { CommandLine: "XDG_STATE_HOME=/tmp/fake agy-context transcript read" } } }).decision,
      "deny"
    );
    assert.equal(
      runHook({ conversationId: parentJ, toolCall: { name: "run_command", args: { CommandLine: "XDG_STATE_HOME=/tmp/fake node -e \"console.log('.gemini')\"" } } }).decision,
      "deny"
    );
    assert.equal(
      runHook({ conversationId: parentJ, toolCall: { name: "run_command", args: { CommandLine: "AGY_TEST_PROFILE_DIR=/tmp/fake npm test" } } }).decision,
      "deny"
    );

    // Restricted child sessions stay denied on XDG_STATE_HOME / LOCALAPPDATA
    assert.equal(
      runHook({ conversationId: childDenyJ, toolCall: { name: "run_command", args: { CommandLine: "XDG_STATE_HOME=/tmp/my-app pytest" } } }).decision,
      "deny",
      "Restricted child must remain denied on XDG_STATE_HOME assignment"
    );
    assert.equal(
      runHook({ conversationId: childDenyJ, toolCall: { name: "run_command", args: { CommandLine: "LOCALAPPDATA=/tmp/my-app npm test" } } }).decision,
      "deny",
      "Restricted child must remain denied on LOCALAPPDATA assignment"
    );
    console.log("✓ UX-ACS-007: XDG_STATE_HOME / LOCALAPPDATA allowed for normal user tests, blocked for restricted children & governance targets");

    // J.5: UX-ACS-008 - AGY_DISABLE_BENCHMARK_GUARD=1 opt-out for top-level non-restricted sessions
    const defaultBenchEdit = runHook({
      conversationId: parentJ,
      toolCall: { name: "edit_file", args: { Path: "src/scoring/ranker.ts", Target: "a", Replacement: "b" } }
    });
    assert.equal(defaultBenchEdit.decision, "force_ask");
    assert.match(defaultBenchEdit.reason, /AGY_DISABLE_BENCHMARK_GUARD=1/);

    const defaultBenchShell = runHook({
      conversationId: parentJ,
      toolCall: { name: "run_command", args: { CommandLine: "rm benchmarks/perf.js" } }
    });
    assert.equal(defaultBenchShell.decision, "force_ask");
    assert.match(defaultBenchShell.reason, /AGY_DISABLE_BENCHMARK_GUARD=1/);

    const optOutEnv = { ...process.env, AGY_DISABLE_BENCHMARK_GUARD: "1" };
    assert.equal(
      runHook({
        conversationId: parentJ,
        toolCall: { name: "edit_file", args: { Path: "src/scoring/ranker.ts", Target: "a", Replacement: "b" } }
      }, optOutEnv).decision,
      "allow",
      "Top-level parent with AGY_DISABLE_BENCHMARK_GUARD=1 must edit src/scoring/ranker.ts without force_ask"
    );
    assert.equal(
      runHook({
        conversationId: parentJ,
        toolCall: { name: "run_command", args: { CommandLine: "rm benchmarks/perf.js" } }
      }, optOutEnv).decision,
      "allow",
      "Top-level parent with AGY_DISABLE_BENCHMARK_GUARD=1 must allow shell mutation on benchmarks/perf.js"
    );
    assert.equal(
      runHook({
        conversationId: childDenyJ,
        toolCall: { name: "edit_file", args: { Path: "src/scoring/ranker.ts", Target: "a", Replacement: "b" } }
      }, optOutEnv).decision,
      "force_ask",
      "Restricted child session must NOT bypass benchmark guard via AGY_DISABLE_BENCHMARK_GUARD=1"
    );
    console.log("✓ UX-ACS-008: AGY_DISABLE_BENCHMARK_GUARD=1 opt-out verified for top-level sessions while keeping restricted children guarded");
  }
}

// ============================================================================
// GROUP K: Day-1 Launch Remediation Regressions (RUN-001, RUN-003, SVC-001, RUN-004, TEST-001)
// ============================================================================
console.log("\n--- Group K: Day-1 Launch Remediation Regressions (RUN-001, RUN-003, SVC-001, RUN-004) ---");
{
  // K.1: RUN-001 / TEST-001 - Windows spaced-profile local RTK launcher (scripts/rtk-run.mjs) & parseRtkReadCommand
  {
    const { resolveLocalRtkExecutable, runRtkPassthrough } = await import("../scripts/rtk-run.mjs");
    const spacedRtkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-run001-spaced-"));
    try {
      const spacedProfile = path.join(spacedRtkRoot, "Jane Doe Profile");
      const emptyBin = path.join(spacedRtkRoot, "empty-bin");
      const pluginRoot = path.join(spacedProfile, ".gemini", "config", "plugins", "agy-context-saver");
      const pluginBin = path.join(pluginRoot, "bin");
      const pluginScripts = path.join(pluginRoot, "scripts");
      fs.mkdirSync(emptyBin, { recursive: true });
      fs.mkdirSync(pluginBin, { recursive: true });
      fs.mkdirSync(pluginScripts, { recursive: true });
      fs.copyFileSync(path.resolve(path.dirname(hookScript), "rtk-run.mjs"), path.join(pluginScripts, "rtk-run.mjs"));

      const fakeLocalRtk = path.join(pluginBin, process.platform === "win32" ? "rtk.cmd" : "rtk");
      if (process.platform === "win32") {
        fs.writeFileSync(
          fakeLocalRtk,
          [
            "@echo off",
            'if "%1"=="--version" goto :ver',
            'if "%1"=="hook" goto :hook',
            'echo rtk-ok:%RTK_SUPPRESS_HOOK_WARNING%:%*',
            "exit /b 0",
            ":ver",
            "echo rtk 1.1.0",
            "exit /b 0",
            ":hook",
            `"${process.execPath}" -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(0,'utf8'));const c=d.toolCall.args.CommandLine;let rw=c;if(c==='git status')rw='rtk git status';else if(c==='cmd /c \"git status\"')rw='cmd /c \"rtk git status\"';else if(c==='bash -c \"git status\"')rw='bash -c \"rtk git status\"';else if(c.startsWith('cat '))rw='rtk read '+c.slice(4);console.log(JSON.stringify({decision:'allow',overwrite:{CommandLine:rw}}));"`,
            "exit /b 0",
            ""
          ].join("\r\n"),
          "utf-8"
        );
      } else {
        fs.writeFileSync(
          fakeLocalRtk,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then echo "rtk 1.1.0"; exit 0; fi',
            'if [ "$1" = "hook" ]; then',
            `  "${process.execPath}" -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(0,'utf8'));const c=d.toolCall.args.CommandLine;let rw=c;if(c==='git status')rw='rtk git status';else if(c==='cmd /c \\\"git status\\\"')rw='cmd /c \\\"rtk git status\\\"';else if(c==='bash -c \\\"git status\\\"')rw='bash -c \\\"rtk git status\\\"';else if(c.startsWith('cat '))rw='rtk read '+c.slice(4);console.log(JSON.stringify({decision:'allow',overwrite:{CommandLine:rw}}));"`,
            "  exit 0",
            "fi",
            'echo "rtk-ok:$RTK_SUPPRESS_HOOK_WARNING:$*"',
            ""
          ].join("\n"),
          "utf-8"
        );
        fs.chmodSync(fakeLocalRtk, 0o755);
      }

      // Direct unit & passthrough verification of scripts/rtk-run.mjs on all platforms
      const resolvedExe = resolveLocalRtkExecutable({
        env: { ...process.env, AGY_TEST_PROFILE_DIR: spacedProfile },
        scriptDir: pluginScripts
      });
      assert.equal(path.resolve(resolvedExe), path.resolve(fakeLocalRtk));
      const emptyTestProfile = path.join(spacedRtkRoot, "empty-profile");
      fs.mkdirSync(emptyTestProfile, { recursive: true });
      assert.equal(
        resolveLocalRtkExecutable({
          env: { ...process.env, AGY_TEST_PROFILE_DIR: emptyTestProfile },
          scriptDir: pluginScripts
        }),
        "rtk",
        "rtk-run.mjs must NOT leak sibling/repo bin when AGY_TEST_PROFILE_DIR has no local rtk"
      );
      const directPass = runRtkPassthrough(["git", "status"], {
        env: { ...process.env, AGY_TEST_PROFILE_DIR: spacedProfile },
        stdio: "pipe"
      });
      assert.equal(directPass.status, 0, directPass.stderr);
      assert.match(directPass.stdout.toString("utf-8"), /rtk-ok:1:git status/);

      const spacedOffPathEnv = withEnvPath(emptyBin, { ...process.env, AGY_TEST_PROFILE_DIR: spacedProfile });
      const gitRewrite = runHook(
        { toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 5000 } } },
        spacedOffPathEnv
      );
      assert.equal(gitRewrite.decision, "allow");
      const catRewrite = runHook(
        { toolCall: { name: "run_command", args: { CommandLine: "cat package.json", WaitMsBeforeAsync: 5000 } } },
        spacedOffPathEnv
      );
      assert.equal(catRewrite.decision, "allow");
      const grepRewrite = runHook(
        { toolCall: { name: "run_command", args: { CommandLine: 'rtk grep -rnE "foo" src/', WaitMsBeforeAsync: 5000 } } },
        spacedOffPathEnv
      );
      assert.equal(grepRewrite.decision, "allow");

      // Shell wrapper quoting safety with spaced local RTK:
      // `cmd /c "git status"` must NEVER emit single-quoted `node '...'` (cmd.exe ignores single quotes)
      const cmdWrapRewrite = runHook(
        { toolCall: { name: "run_command", args: { CommandLine: 'cmd /c "git status"', WaitMsBeforeAsync: 5000 } } },
        spacedOffPathEnv
      );
      assert.equal(cmdWrapRewrite.decision, "allow");
      assert.equal(
        cmdWrapRewrite.overwrite?.CommandLine,
        undefined,
        `cmd /c wrapper with spaced local RTK must preserve raw command instead of emitting broken single quotes: ${cmdWrapRewrite.overwrite?.CommandLine}`
      );

      // `bash -c "git status"` with spaced local RTK must convert inner quotes cleanly (no unescaped `"` inside `"..."`)
      const bashWrapRewrite = runHook(
        { toolCall: { name: "run_command", args: { CommandLine: 'bash -c "git status"', WaitMsBeforeAsync: 5000 } } },
        spacedOffPathEnv
      );
      assert.equal(bashWrapRewrite.decision, "allow");
      const bashWrapCmd = bashWrapRewrite.overwrite?.CommandLine || "";
      assert.match(bashWrapCmd, /^bash -c "[^"]*'[^']*Jane Doe Profile[^']*'[^"]*git status"$/);
      if (process.platform !== "win32") {
        const bashExec = spawnSync("bash", ["-c", bashWrapCmd], {
          env: { ...process.env, AGY_TEST_PROFILE_DIR: spacedProfile },
          encoding: "utf-8"
        });
        assert.equal(bashExec.status, 0, `Rewritten bash -c wrapper failed: ${bashExec.stderr || bashExec.error?.message}`);
        assert.match(bashExec.stdout, /rtk-ok:.*:git status/);
      }

      if (process.platform === "win32") {
        for (const [label, res] of [
          ["git status", gitRewrite],
          ["cat package.json", catRewrite],
          ["rtk grep", grepRewrite]
        ]) {
          const cmdLine = res.overwrite?.CommandLine || "";
          assert.equal(cmdLine.startsWith('"'), false, `Windows ${label} rewrite must NEVER start with double quote: ${cmdLine}`);
          assert.match(cmdLine, /^node ".*\/scripts\/rtk-run\.mjs"\s+/, `Windows ${label} rewrite must use node "<rtk-run.mjs>"`);
          const psEnv = { ...process.env, AGY_TEST_PROFILE_DIR: spacedProfile };
          prependToPath(path.dirname(process.execPath), psEnv);
          const psExec = spawnSync("powershell", ["-NoProfile", "-Command", cmdLine], { env: psEnv, encoding: "utf-8" });
          assert.equal(psExec.status, 0, `PowerShell execution failed for ${label} (${cmdLine}): ${psExec.stderr}`);
          assert.match(psExec.stdout, /rtk-ok:1:/);
        }
      }

      // Verify parseRtkReadCommand accepts trusted `node "<plugin>/scripts/rtk-run.mjs" read` on spillover
      // while rejecting an untrusted `/tmp/evil/rtk-run.mjs` script
      const trustedLauncher = path.join(pluginScripts, "rtk-run.mjs").replace(/\\/g, "/");
      const trustedSpill = runHook(
        {
          toolCall: {
            name: "run_command",
            args: { CommandLine: `node "${trustedLauncher}" read .system_generated/steps/1/output.txt`, WaitMsBeforeAsync: 5000 }
          }
        },
        spacedOffPathEnv
      );
      assert.equal(trustedSpill.decision, "allow", `Trusted rtk-run.mjs read on spillover must be allowed (${trustedSpill.reason || ""})`);

      const evilLauncher = path.join(spacedRtkRoot, "evil", "rtk-run.mjs").replace(/\\/g, "/");
      const evilSpill = runHook(
        {
          toolCall: {
            name: "run_command",
            args: { CommandLine: `node "${evilLauncher}" read .system_generated/steps/1/output.txt`, WaitMsBeforeAsync: 5000 }
          }
        },
        spacedOffPathEnv
      );
      assert.equal(evilSpill.decision, "deny", "Untrusted rtk-run.mjs path must NEVER bypass spillover guard");
    } finally {
      fs.rmSync(spacedRtkRoot, { recursive: true, force: true });
    }
    console.log("✓ RUN-001 / TEST-001: Spaced-profile local RTK launcher (rtk-run.mjs) and trusted parseRtkReadCommand verified");
  }

  // K.2: RUN-003 - Unprefixed `system_generated` workspace files & `git commit -m` / `git tag -m`
  {
    assert.equal(
      runHook({ toolCall: { name: "read_file", args: { Path: "models/system_generated.py", StartLine: 1, EndLine: 50 } } }).decision,
      "allow",
      "Bounded read_file on models/system_generated.py must be allowed (RUN-003)"
    );
    assert.equal(
      runHook({ toolCall: { name: "edit_file", args: { Path: "src/system_generated/report.ts", Target: "a", Replacement: "b" } } }).decision,
      "allow",
      "edit_file on src/system_generated/report.ts must be allowed (RUN-003)"
    );
    assert.equal(
      runHook({ toolCall: { name: "run_command", args: { CommandLine: "git commit -m 'Add system_generated column'", WaitMsBeforeAsync: 5000 } } }).decision,
      "allow",
      "git commit -m referencing system_generated must be allowed (RUN-003)"
    );
    assert.equal(
      runHook({ toolCall: { name: "run_command", args: { CommandLine: "git -c core.safecrlf=false commit -m 'Harden .system_generated guard'", WaitMsBeforeAsync: 5000 } } }).decision,
      "allow",
      "git commit -m mentioning .system_generated prose must be allowed (RUN-003)"
    );
    assert.equal(
      runHook({ toolCall: { name: "run_command", args: { CommandLine: "git tag -a v2.0.4 -m 'Release .system_generated fix'", WaitMsBeforeAsync: 5000 } } }).decision,
      "allow",
      "git tag -m mentioning .system_generated prose must be allowed (RUN-003)"
    );
    assert.equal(
      runHook({ toolCall: { name: "run_command", args: { CommandLine: "git commit -am 'Fix .system_generated handling'", WaitMsBeforeAsync: 5000 } } }).decision,
      "allow",
      "git commit -am mentioning .system_generated prose must be allowed (RUN-003)"
    );
    assert.equal(
      runHook({ toolCall: { name: "run_command", args: { CommandLine: "git tag -am 'Release .system_generated fix' v2.0.5", WaitMsBeforeAsync: 5000 } } }).decision,
      "allow",
      "git tag -am mentioning .system_generated prose must be allowed (RUN-003)"
    );
    assert.equal(
      runHook({ toolCall: { name: "run_command", args: { CommandLine: "rtk git commit -m 'Fix .system_generated handling'", WaitMsBeforeAsync: 5000 } } }).decision,
      "allow",
      "rtk git commit -m mentioning .system_generated prose must be allowed (RUN-003)"
    );

    // Obfuscated & real `.system_generated` smuggling vectors MUST remain denied
    for (const smugglingCmd of [
      'cat .system_""generated/foo',
      'cat .""system_generated/logs/transcript.jsonl',
      "node -e \"fs.readFileSync('.system_'+'generated/foo')\"",
      "node -e \"fs.readFileSync('.'+'system_generated/foo')\"",
      "git commit -F .system_generated/logs/transcript.jsonl",
      "git commit -aF .system_generated/logs/transcript.jsonl",
      "git commit -m <.system_generated/logs/transcript.jsonl",
      "AGY_BRAIN_DIR=/tmp git commit -m 'harmless message'",
      'git commit -m "$(cat .system_generated/logs/transcript.jsonl)"'
    ]) {
      assert.equal(
        runHook({ toolCall: { name: "run_command", args: { CommandLine: smugglingCmd, WaitMsBeforeAsync: 5000 } } }).decision,
        "deny",
        `Real/obfuscated .system_generated smuggling must stay denied: ${smugglingCmd}`
      );
    }
    console.log("✓ RUN-003: Unprefixed system_generated files & git commit/tag -m allowed while .system_generated smuggling stays denied");
  }

  // K.3: SVC-001 - Backoff & schedule denials must NOT overwrite session.lastPollTime or break 0s Check #1
  {
    resetState();
    const convSvc = "conv-svc001-backoff";
    const sessionFile = path.join(stateDir, `agy-session-${convSvc}.json`);

    // Part A: Fresh session -> denied schedule call -> lastPollTime stays 0 -> Check #1 manage_task(status) STILL succeeds immediately (0s)
    const schedDeny = runHook({
      conversationId: convSvc,
      toolCall: { name: "schedule", args: { DurationSeconds: 5, Prompt: "Check status of task-1", TimerCondition: "task-1" } }
    });
    assert.equal(schedDeny.decision, "deny");
    const afterSchedDeny = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    assert.equal(afterSchedDeny.lastPollTime, 0, "Denied task schedule must NOT overwrite lastPollTime (SVC-001)");

    const swarmDeny = runHook({
      conversationId: convSvc,
      toolCall: { name: "schedule", args: { DurationSeconds: 60, Prompt: "Check status of swarm workers", TimerCondition: "any" } }
    });
    assert.equal(swarmDeny.decision, "deny");
    const afterSwarmDeny = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    assert.equal(afterSwarmDeny.lastPollTime, 0, "Denied swarm schedule must NOT overwrite lastPollTime (SVC-001)");

    const checkOne = runHook({
      conversationId: convSvc,
      toolCall: { name: "manage_task", args: { Action: "status", TaskId: "t1" } }
    });
    assert.equal(checkOne.decision, "allow", "Check #1 manage_task(status) must remain immediate (0s) even after prior schedule denials (SVC-001)");

    // Part B: Premature manage_task denial at t=25s must NOT reset lastPollTime; retrying at t=31s must succeed
    const stateAfterCheck1 = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    const fixedT0 = Date.now() - 25000;
    stateAfterCheck1.lastPollTime = fixedT0;
    fs.writeFileSync(sessionFile, JSON.stringify(stateAfterCheck1), "utf-8");

    const prematureDeny = runHook({
      conversationId: convSvc,
      toolCall: { name: "manage_task", args: { Action: "status", TaskId: "t1" } }
    });
    assert.equal(prematureDeny.decision, "deny");
    const stateAfterDeny = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    assert.equal(stateAfterDeny.lastPollTime, fixedT0, "Premature manage_task denial must NOT advance lastPollTime (SVC-001)");

    // Advance elapsed time past 30s (t=31s) -> diagnostic check #2 must now be allowed
    stateAfterDeny.lastPollTime = Date.now() - 31000;
    fs.writeFileSync(sessionFile, JSON.stringify(stateAfterDeny), "utf-8");
    const checkTwo = runHook({
      conversationId: convSvc,
      toolCall: { name: "manage_task", args: { Action: "status", TaskId: "t1" } }
    });
    assert.equal(checkTwo.decision, "allow", "Diagnostic check #2 must succeed once original cooldown elapses (SVC-001)");

    // Part C: denyRunningTask must NOT advance lastPollTime (nor emit Infinitys)
    const convRunTask = "conv-svc001-runtask";
    const runTaskBrain = path.join(hermetic.profileDir, ".gemini", "antigravity", "brain", convRunTask, ".system_generated");
    fs.mkdirSync(path.join(runTaskBrain, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(runTaskBrain, "tasks", "task-live-svc.log"), "running...\n", "utf-8");
    const runTaskDeny = runHook({
      conversationId: convRunTask,
      toolCall: { name: "run_command", args: { CommandLine: "rtk read tasks/task-live-svc.log", WaitMsBeforeAsync: 5000 } }
    });
    assert.equal(runTaskDeny.decision, "deny");
    assert.equal(runTaskDeny.reason.includes("Infinity"), false, "denyRunningTask must never print Infinitys elapsed");
    const runTaskState = JSON.parse(fs.readFileSync(path.join(stateDir, `agy-session-${convRunTask}.json`), "utf-8"));
    assert.equal(runTaskState.lastPollTime, 0, "denyRunningTask must NOT overwrite lastPollTime (SVC-001)");
    console.log("✓ SVC-001: Backoff/schedule/running-task denials preserve lastPollTime and keep Check #1 immediate (0s)");
  }

  // K.4: RUN-004 - Read-only sed, perl, and cp source operands must NOT trigger benchmark force_ask
  {
    for (const readOnlyBenchCmd of [
      "sed -n '1,20p' benchmarks/suite.json",
      "sed 's/foo/bar/g' benchmarks/suite.json",
      "sed 's/new benchmarks\\/suite.json/old/g' src/a.txt",
      "perl -ne 'print if /score/' benchmarks/suite.json",
      "cp benchmarks/suite.json /tmp/suite-copy.json",
      "cp --backup benchmarks/suite.json /tmp/suite-copy.json",
      "cp -t /tmp benchmarks/suite.json"
    ]) {
      const res = runHook({
        toolCall: { name: "run_command", args: { CommandLine: readOnlyBenchCmd, WaitMsBeforeAsync: 5000 } }
      });
      assert.equal(res.decision, "allow", `Read-only benchmark inspection/copy source must be allowed: ${readOnlyBenchCmd}`);
    }

    for (const mutatingBenchCmd of [
      "sed -i 's/a/b/' benchmarks/suite.json",
      "sed --in-place 's/a/b/' benchmarks/suite.json",
      "sed -n 'w benchmarks/suite.json' /tmp/evil.json",
      "sed 's/a/b/w benchmarks/suite.json' /tmp/evil.json",
      "perl -pi -e 's/a/b/' benchmarks/suite.json",
      `perl -e 'open(my $f, ">", "benchmarks/suite.json"); print $f "x"'`,
      `perl -e 'open my $f, ">", "benchmarks/suite.json"; print $f "x"'`,
      `perl -e'unlink("benchmarks/suite.json")'`,
      "cp /tmp/fake.json benchmarks/suite.json",
      "cp --backup /tmp/fake.json benchmarks/suite.json",
      "cp --preserve /tmp/fake.json benchmarks/suite.json",
      "cp -t benchmarks /tmp/fake.json",
      "cp -rt benchmarks /tmp/fake.json",
      "sed 's/a/b/' src/data.json > benchmarks/suite.json"
    ]) {
      const res = runHook({
        toolCall: { name: "run_command", args: { CommandLine: mutatingBenchCmd, WaitMsBeforeAsync: 5000 } }
      });
      assert.equal(res.decision, "force_ask", `Mutating benchmark command must still trigger force_ask: ${mutatingBenchCmd}`);
    }
    console.log("✓ RUN-004: Read-only sed/perl and cp sources allowed while in-place sed/perl and cp destinations stay guarded");
  }
}

hermetic.cleanup();
console.log("\n=================================================");
console.log("ALL 2.0 PRETOOLUSE HOOK GOVERNANCE TESTS PASSED!");
console.log("=================================================");
