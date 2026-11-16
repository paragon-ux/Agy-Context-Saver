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

  const byteOffsetOnly = runHook({
    toolCall: { name: "read_file", args: { Path: "/home/user/repo/src/app.js", ByteOffset: 46080 } }
  });
  assert.equal(byteOffsetOnly.decision, "deny", "ByteOffset-only unbounded read_file must be denied");

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
    assert.equal(
      runHook({ toolCall: { name: "view_file", args: { AbsolutePath: "/home/user/repo/src/app.js" } } }).decision,
      "deny",
      "view_file unbounded read must be denied"
    );
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

    console.log("✓ Group H regression checks passed (payload.cwd, 2>/dev/null, antigravity-cli, swarm_view, Step0>16KiB, cross-swarm isolation, query current, Wave 2 regressions)");
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
    fs.rmSync(cliProfile, { recursive: true, force: true });
  }
}

hermetic.cleanup();
console.log("\n=================================================");
console.log("ALL 2.0 PRETOOLUSE HOOK GOVERNANCE TESTS PASSED!");
console.log("=================================================");
