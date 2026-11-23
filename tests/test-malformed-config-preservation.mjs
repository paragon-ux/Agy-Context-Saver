/**
 * Regression test template. Copy to tests/test-malformed-config-preservation.mjs
 * and add it to the npm test chain. It only writes to a disposable temp profile.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-config-preserve-'));
const isolatedRepo = path.join(tempRoot, 'repo');
const isolatedHome = path.join(tempRoot, 'home');
const fakeBin = path.join(tempRoot, 'fake-bin');
const configDir = path.join(isolatedHome, '.gemini', 'config');
const hooksPath = path.join(configDir, 'hooks.json');
const mcpPath = path.join(configDir, 'mcp_config.json');
const malformedHooks = '{ "operatorHook": { invalid JSON }\n';
const originalMcp = JSON.stringify({ mcpServers: { otherServer: { command: 'do-not-touch' } } }, null, 2);

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
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(hooksPath, malformedHooks, 'utf8');
  fs.writeFileSync(mcpPath, originalMcp, 'utf8');
  await fs.promises.cp(repoRoot, isolatedRepo, { recursive: true, filter: copyFilter });

  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(fakeBin, 'rtk.cmd'), '@echo off\r\necho rtk 1.1.0\r\n');
  } else {
    const fakeRtk = path.join(fakeBin, 'rtk');
    fs.writeFileSync(fakeRtk, '#!/bin/sh\necho "rtk 1.1.0"\n');
    fs.chmodSync(fakeRtk, 0o755);
  }

  const env = { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, AGY_TEST_PROFILE_DIR: isolatedHome };
  prependPath(env, fakeBin);
  const result = spawnSync(process.execPath, ['scripts/install-register.mjs'], {
    cwd: isolatedRepo,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });

  assert.equal(result.error, undefined, `Child process failed to start: ${result.error?.message}`);
  assert.notEqual(result.status, 0, `Install should fail closed on malformed hooks.json.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), malformedHooks, 'Malformed hooks.json was changed.');
  assert.equal(fs.readFileSync(mcpPath, 'utf8'), originalMcp, 'Unrelated MCP configuration was changed after install failure.');
  assert.equal(
    fs.existsSync(path.join(configDir, 'plugins', 'agy-context-saver')),
    false,
    'Plugin was installed even though configuration preflight should have failed.',
  );
  console.log('PASS: malformed hooks.json is preserved and install aborts before changing configuration.');

  // SCRIPT-001: non-object config.json.plugins must fail preflight on a fresh profile before mutating pluginDest or hooks.json
  const badPluginsHome = path.join(tempRoot, 'bad-plugins-home');
  const badPluginsCfgDir = path.join(badPluginsHome, '.gemini', 'config');
  fs.mkdirSync(badPluginsCfgDir, { recursive: true });
  const badConfigRaw = '{"plugins":["antislop"]}\n';
  fs.writeFileSync(path.join(badPluginsCfgDir, 'config.json'), badConfigRaw, 'utf8');
  const badPluginsEnv = { ...env, HOME: badPluginsHome, USERPROFILE: badPluginsHome, AGY_TEST_PROFILE_DIR: badPluginsHome };
  const badPluginsInstall = spawnSync(process.execPath, ['scripts/install-register.mjs'], {
    cwd: isolatedRepo, env: badPluginsEnv, encoding: 'utf8', timeout: 30000
  });
  assert.notEqual(badPluginsInstall.status, 0, 'SCRIPT-001: install must fail closed on non-object config.json.plugins.');
  assert.equal(fs.readFileSync(path.join(badPluginsCfgDir, 'config.json'), 'utf8'), badConfigRaw, 'SCRIPT-001: config.json must stay unchanged.');
  assert.equal(fs.existsSync(path.join(badPluginsCfgDir, 'plugins', 'agy-context-saver')), false, 'SCRIPT-001: pluginDest must not be created on preflight failure.');
  assert.equal(fs.existsSync(path.join(badPluginsCfgDir, 'hooks.json')), false, 'SCRIPT-001: hooks.json must not be created on preflight failure.');
  console.log('PASS: non-object config.json.plugins fails closed in preflight without mutating profile (SCRIPT-001).');

  // D-04: On Windows, install.ps1 must run install-register.mjs preflight BEFORE touching node.cmd
  if (process.platform === 'win32') {
    const customNodeCmdPath = path.join(configDir, 'node.cmd');
    const customNodeCmdContent = '@echo off\r\nREM custom-operator-node-wrapper\r\n';
    fs.writeFileSync(customNodeCmdPath, customNodeCmdContent, 'utf8');

    const psResult = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(isolatedRepo, 'install.ps1')],
      {
        cwd: isolatedRepo,
        env: { ...env, AGY_TEST_PROFILE_DIR: isolatedHome },
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    assert.notEqual(psResult.status, 0, 'install.ps1 must fail closed when hooks.json is malformed (D-04).');
    assert.equal(
      fs.readFileSync(customNodeCmdPath, 'utf8'),
      customNodeCmdContent,
      'install.ps1 overwrote pre-existing node.cmd despite preflight failure (D-04).'
    );
    assert.equal(fs.readFileSync(hooksPath, 'utf8'), malformedHooks, 'hooks.json must remain untouched after install.ps1 abort.');
    console.log('PASS: install.ps1 aborts on malformed hooks.json before writing or overwriting node.cmd (D-04).');
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
