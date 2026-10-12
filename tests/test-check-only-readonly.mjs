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
  if (parts[0] === 'bin') return false;
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
    fs.writeFileSync(path.join(fakeBin, 'rtk.cmd'), '@echo off\r\necho RTK v0.51.0\r\n');
  } else {
    const fakeRtk = path.join(fakeBin, 'rtk');
    fs.writeFileSync(fakeRtk, '#!/bin/sh\necho "RTK v0.51.0"\n');
    fs.chmodSync(fakeRtk, 0o755);
  }

  const env = { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome };
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
    fs.existsSync(path.join(isolatedRepo, 'bin')),
    false,
    `--check created the RTK bin directory in the isolated source tree.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
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
  console.log('PASS: --check fails closed on malformed configuration without mutating files (D-06).');

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

  const mcpCliConflict = spawnSync(process.execPath, ['mcp/index.js', 'sync', '--check', '--restore-backups'], {
    cwd: isolatedRepo,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.notEqual(mcpCliConflict.status, 0, 'mcp/index.js sync --check --restore-backups must be rejected with non-zero exit code (D-05).');
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), activeHooks, 'mcp/index.js sync --check --restore-backups must not mutate hooks.json.');
  console.log('PASS: conflicting --check --restore-backups flags are rejected without mutating profile (D-05).');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
