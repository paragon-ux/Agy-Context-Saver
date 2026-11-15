import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupHermeticTestEnv, createRtkShim, prependToPath } from "./helpers/hermetic-fixture.mjs";
import { getStateDir } from "../scripts/state-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const hookScript = path.resolve(repoRoot, "scripts/execution-guard-hook.mjs");
const hooksJsonFile = path.resolve(repoRoot, "hooks.json");

const hermetic = await setupHermeticTestEnv({ installProfile: false, forceShim: true, shimVersion: "1.1.0" });
const stateDir = getStateDir();
const stateFile = path.join(stateDir, "agy-session-governance-state.json");

function resetState() {
  try {
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    for (const f of fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : []) {
      if (f.startsWith("agy-session-") && f.endsWith(".json")) {
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
  const emptyBinEnv = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${path.join(hermetic.profileDir, "rtk-shim-bin")}`
  };
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
  const emptyBinEnv = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${path.join(hermetic.profileDir, "rtk-shim-bin")}`
  };
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
}

hermetic.cleanup();
console.log("\n=================================================");
console.log("ALL 2.0 PRETOOLUSE HOOK GOVERNANCE TESTS PASSED!");
console.log("=================================================");
