/**
 * Regression test template. Copy to tests/test-check-only-readonly.mjs and add it
 * to the npm test chain. Run it only from a checkout; it makes isolated temp copies.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-check-readonly-'));
const isolatedRepo = path.join(tempRoot, 'repo');
const isolatedHome = path.join(tempRoot, 'home');
const fakeBin = path.join(tempRoot, 'fake-bin');

function copyFilter(source) {
  const relative = path.relative(repoRoot, source);
  if (!relative) return true;
  const parts = relative.split(path.sep);
  if (parts.some((part) => part === '.git' || part === 'node_modules' || part === '.venv')) return false;
  if (parts[0] === 'bin' && parts[1] && /^rtk/i.test(parts[1])) return false;
  return true;
}

function prependPath(env, directory) {
  const existingKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  env[existingKey] = `${directory}${path.delimiter}${env[existingKey] ?? ''}`;
  env.PATH = env[existingKey];
}

try {
  fs.mkdirSync(isolatedHome, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  await fs.promises.cp(repoRoot, isolatedRepo, { recursive: true, filter: copyFilter });

  // A deterministic fake RTK prevents the test from reaching the network.
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(fakeBin, 'rtk.cmd'), '@echo off\r\necho rtk 1.1.0\r\n');
  } else {
    const fakeRtk = path.join(fakeBin, 'rtk');
    fs.writeFileSync(fakeRtk, '#!/bin/sh\necho "rtk 1.1.0"\n');
    fs.chmodSync(fakeRtk, 0o755);
  }

  const env = { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, AGY_TEST_PROFILE_DIR: isolatedHome };
  prependPath(env, fakeBin);
  const result = spawnSync(process.execPath, ['scripts/install-register.mjs', '--check'], {
    cwd: isolatedRepo,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });

  assert.equal(result.error, undefined, `Child process failed to start: ${result.error?.message}`);
  assert.equal(result.status, 0, `--check should succeed on a fresh profile.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.deepEqual(
    fs.readdirSync(isolatedHome),
    [],
    `--check modified a fresh home directory.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(
    fs.existsSync(path.join(isolatedRepo, 'bin', 'rtk')) || fs.existsSync(path.join(isolatedRepo, 'bin', 'rtk.exe')),
    false,
    `--check provisioned an RTK binary in the isolated source tree.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  console.log('PASS: --check leaves a fresh profile and source tree unchanged.');

  // D-06: --check must fail closed when existing hooks.json or mcp_config.json is malformed
  const configDir = path.join(isolatedHome, '.gemini', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const hooksPath = path.join(configDir, 'hooks.json');
  const malformedHooks = '{ "broken": invalid json }';
  fs.writeFileSync(hooksPath, malformedHooks, 'utf8');

  const malformedCheck = spawnSync(process.execPath, ['scripts/install-register.mjs', '--check'], {
    cwd: isolatedRepo,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.notEqual(malformedCheck.status, 0, '--check must exit non-zero when existing hooks.json is malformed (D-06).');
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), malformedHooks, '--check must not modify malformed hooks.json.');

  // SCRIPT-001: --check must fail closed when config.json.plugins is not a JSON object
  const badPluginsHome = path.join(tempRoot, 'check-bad-plugins');
  const badPluginsCfgDir = path.join(badPluginsHome, '.gemini', 'config');
  fs.mkdirSync(badPluginsCfgDir, { recursive: true });
  fs.writeFileSync(path.join(badPluginsCfgDir, 'config.json'), '{"plugins":["antislop"]}\n', 'utf8');
  const badPluginsCheck = spawnSync(process.execPath, ['scripts/install-register.mjs', '--check'], {
    cwd: isolatedRepo,
    env: { ...env, HOME: badPluginsHome, USERPROFILE: badPluginsHome, AGY_TEST_PROFILE_DIR: badPluginsHome },
    encoding: 'utf8',
    timeout: 30000
  });
  assert.notEqual(badPluginsCheck.status, 0, '--check must exit non-zero when config.json.plugins is not a JSON object (SCRIPT-001).');
  console.log('PASS: --check fails closed on malformed configuration without mutating files (D-06, SCRIPT-001).');

  // D-05: Conflicting read-only + mutating flags (--check --restore-backups) must be rejected without mutating
  const activeHooks = JSON.stringify({ activeHook: { PreToolUse: [] } }, null, 2);
  const backupHooks = JSON.stringify({ oldBackupHook: { PreToolUse: [] } }, null, 2);
  fs.writeFileSync(hooksPath, activeHooks, 'utf8');
  fs.writeFileSync(`${hooksPath}.bak`, backupHooks, 'utf8');

  const conflictCheck = spawnSync(process.execPath, ['scripts/install-register.mjs', '--check', '--restore-backups'], {
    cwd: isolatedRepo,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.notEqual(conflictCheck.status, 0, '--check --restore-backups must be rejected with non-zero exit code (D-05).');
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), activeHooks, '--check --restore-backups must not overwrite active hooks.json with .bak.');

  const cliConflict = spawnSync(process.execPath, ['bin/agy-context.mjs', 'setup', '--check', '--restore-backups'], {
    cwd: isolatedRepo,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.notEqual(cliConflict.status, 0, 'bin/agy-context.mjs setup --check --restore-backups must be rejected with non-zero exit code (D-05).');
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), activeHooks, 'bin/agy-context.mjs setup --check --restore-backups must not mutate hooks.json.');
  console.log('PASS: conflicting --check --restore-backups flags are rejected without mutating profile (D-05).');

  // ACS-PR4-SCRIPT-001: unknown flags, unknown positionals, and --help conflicts on install-register.mjs must fail closed without mutating an empty profile
  const cleanHome = path.join(tempRoot, 'clean-home-strict');
  fs.mkdirSync(cleanHome, { recursive: true });
  const strictEnv = { ...env, HOME: cleanHome, USERPROFILE: cleanHome, AGY_TEST_PROFILE_DIR: cleanHome };
  for (const badArgs of [
    ['--bogus'],
    ['--stat'],
    ['bogus-positional'],
    ['--help', '--check'],
    ['--uninstall', '--allow-degraded'],
    ['--status', '--allow-degraded'],
    ['--restore-backups', '--allow-degraded']
  ]) {
    const res = spawnSync(process.execPath, ['scripts/install-register.mjs', ...badArgs], {
      cwd: isolatedRepo,
      env: strictEnv,
      encoding: 'utf8',
      timeout: 30000
    });
    assert.notEqual(res.status, 0, `Expected strict rejection for install-register.mjs ${badArgs.join(' ')}`);
    assert.deepEqual(fs.readdirSync(cleanHome), [], `Rejected install-register.mjs ${badArgs.join(' ')} mutated profile`);
  }
  console.log('PASS: unknown flags/positionals on install-register.mjs fail closed without mutating profile (ACS-PR4-SCRIPT-001).');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
