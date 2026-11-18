#!/usr/bin/env node
/**
 * Non-destructive release metadata/package preflight for Agy-Context-Saver.
 * Run from the repository root: node scripts/release-preflight.mjs
 * This script reads files only; it does not install the plugin or provision RTK.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');

export function matchesPackageEntry(relativePath, normalized) {
  if (!normalized) return false;
  if (normalized.includes('*')) {
    const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const pattern = escaped.replace(/\*\*\/|\*\*|\*/g, (m) =>
      m === '**/' ? '(?:.*/)?' : m === '**' ? '.*' : '[^/]*'
    );
    return new RegExp(`^${pattern}$`).test(relativePath);
  }
  return relativePath === normalized || relativePath.startsWith(`${normalized}/`);
}

export function isPackageFileCovered(relativePath, packageFiles = []) {
  const normalizedTarget = String(relativePath).replace(/\\/g, '/').replace(/^\.\//, '');
  const fileEntries = (packageFiles ?? [])
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => {
      const negated = entry.startsWith('!');
      const normalized = (negated ? entry.slice(1) : entry)
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/\/+$/, '');
      return { negated, normalized };
    });
  const positiveEntries = fileEntries.filter((entry) => !entry.negated);
  const negativeEntries = fileEntries.filter((entry) => entry.negated);
  return (
    positiveEntries.some((entry) => matchesPackageEntry(normalizedTarget, entry.normalized)) &&
    !negativeEntries.some((entry) => matchesPackageEntry(normalizedTarget, entry.normalized))
  );
}

export function runReleasePreflight() {
  const errors = [];
  const warnings = [];

  function readText(relativePath) {
    const target = path.join(root, relativePath);
    try {
      return fs.readFileSync(target, 'utf8');
    } catch {
      errors.push(`Required file is missing or unreadable: ${relativePath}`);
      return '';
    }
  }

  function exists(relativePath) {
    return fs.existsSync(path.join(root, relativePath));
  }

  let pkg;
  const pkgText = readText('package.json');
  if (pkgText) {
    try {
      pkg = JSON.parse(pkgText);
    } catch (error) {
      errors.push(`package.json is not valid JSON: ${error.message}`);
    }
  }

  if (pkg) {
    if (pkg.name !== 'agy-context-saver') {
      errors.push(`Expected package name "agy-context-saver"; found ${JSON.stringify(pkg.name)}.`);
    }
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version ?? '')) {
      errors.push(`package.json version is not a valid semver release version: ${JSON.stringify(pkg.version)}.`);
    }

    const pluginText = readText('plugin.json');
    if (pluginText) {
      try {
        const pluginManifest = JSON.parse(pluginText);
        if (pluginManifest.name !== pkg.name) {
          errors.push(`plugin.json name ${JSON.stringify(pluginManifest.name)} does not match package.json name ${JSON.stringify(pkg.name)}.`);
        }
        if (pluginManifest.version !== pkg.version) {
          errors.push(`plugin.json version ${JSON.stringify(pluginManifest.version)} does not match package.json version ${JSON.stringify(pkg.version)}.`);
        }
        if (typeof pluginManifest.displayName !== 'string' || !pluginManifest.displayName.trim()) {
          errors.push('plugin.json must define a non-empty "displayName".');
        }
        if (
          !Array.isArray(pluginManifest.suggestedPrompts) ||
          pluginManifest.suggestedPrompts.length === 0 ||
          pluginManifest.suggestedPrompts.some((p) => typeof p !== 'string' || !p.trim())
        ) {
          errors.push('plugin.json must define a non-empty string array "suggestedPrompts".');
        }
        if (typeof pluginManifest.logo === 'string' && pluginManifest.logo.trim() && !exists(pluginManifest.logo.trim())) {
          errors.push(`plugin.json logo target does not exist: ${pluginManifest.logo}`);
        }
      } catch (error) {
        errors.push(`plugin.json is not valid JSON: ${error.message}`);
      }
    }

    const changelogText = readText('CHANGELOG.md');
    if (changelogText && pkg.version && !changelogText.includes(`## [${pkg.version}]`)) {
      errors.push(`CHANGELOG.md is missing a release heading for current version "## [${pkg.version}]".`);
    }

    const requiredMetadata = [
      ['repository.url', pkg.repository?.url],
      ['homepage', pkg.homepage],
      ['bugs.url', pkg.bugs?.url],
      ['engines.node', pkg.engines?.node],
    ];
    for (const [label, value] of requiredMetadata) {
      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(`Add package.json metadata field "${label}" before publishing.`);
      }
    }
    if (pkg.engines?.node && !/^>=\s*22(?:\.0\.0)?$/.test(pkg.engines.node.trim())) {
      warnings.push(`Current release policy expects engines.node to be ">=22"; found ${JSON.stringify(pkg.engines.node)}. Update this check if the support policy changes.`);
    }

    const requiredPackageFiles = [
      'lib/transcript-core.mjs',
      'bin/agy-context.mjs',
      'scripts/install-register.mjs',
      'scripts/provision-rtk.mjs',
      'plugin.json',
      'hooks.json',
      'README.md',
      'CHANGELOG.md',
      'LICENSE',
    ];

    if (exists('mcp_config.json')) {
      errors.push('Legacy mcp_config.json is still present at repository root; remove it for 2.0 CLI-first release.');
    }
    if (exists('mcp')) {
      errors.push('Legacy mcp/ directory is still present at repository root; remove it for 2.0 CLI-first release.');
    }

    const hooksText = readText('hooks.json');
    if (hooksText) {
      try {
        const pluginHooks = JSON.parse(hooksText);
        const hookCmd = pluginHooks?.['agy-context-saver']?.PreToolUse?.[0]?.hooks?.[0]?.command ?? '';
        const hookMatcher = pluginHooks?.['agy-context-saver']?.PreToolUse?.[0]?.matcher ?? '';
        if (!hookCmd) {
          errors.push('hooks.json must define "agy-context-saver".PreToolUse[0].hooks[0].command.');
        } else if (hookCmd.includes('ANTIGRAVITY_PLUGIN_ROOT')) {
          errors.push('hooks.json command must not use unexpanded ${ANTIGRAVITY_PLUGIN_ROOT}; use ./scripts/execution-guard-hook.mjs (cwd is plugin root).');
        }
        for (const tool of ['read_file', 'edit_file', 'write_file', 'run_command']) {
          if (!hookMatcher.includes(tool)) {
            errors.push(`hooks.json PreToolUse matcher must include ${tool}.`);
          }
        }
      } catch (error) {
        errors.push(`hooks.json is not valid JSON: ${error.message}`);
      }
    }

    for (const relativePath of requiredPackageFiles) {
      if (!exists(relativePath)) errors.push(`Required runtime/release file is missing: ${relativePath}`);
      const alwaysIncluded = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE'].includes(relativePath);
      const coveredByFiles = alwaysIncluded || isPackageFileCovered(relativePath, pkg.files);
      if (!coveredByFiles) {
        errors.push(`package.json "files" does not clearly include ${relativePath}.`);
      }
    }

    const binEntries = Object.values(pkg.bin ?? {});
    if (binEntries.length === 0) errors.push('package.json has no bin entry.');
    for (const binPath of binEntries) {
      const normalizedBin = String(binPath).replace(/\\/g, '/').replace(/^\.\//, '');
      if (!exists(normalizedBin)) errors.push(`package.json bin target does not exist: ${binPath}`);
      const coveredByFiles = isPackageFileCovered(normalizedBin, pkg.files);
      if (!coveredByFiles) errors.push(`package.json "files" does not include the bin target: ${binPath}`);
    }

    const testCommand = pkg.scripts?.test;
    if (typeof testCommand !== 'string' || !testCommand.trim()) {
      errors.push('package.json is missing the npm test script.');
    } else {
      const suitePaths = [...testCommand.matchAll(/(?:^|&&\s*)node\s+(tests\/[\w.-]+\.mjs)/g)].map((match) => match[1]);
      if (suitePaths.length === 0) {
        errors.push('Could not find test entrypoints in package.json scripts.test; update release-preflight.mjs for the new test runner format.');
      }
      for (const suitePath of suitePaths) {
        if (!exists(suitePath)) errors.push(`npm test references a missing test file: ${suitePath}`);
      }

      const readme = readText('README.md');
      const countMatch = readme.match(/Runs all\s+(\d+)\s+test suites?/i);
      if (!countMatch) {
        errors.push('README.md must state the exact suite count using a sentence such as "Runs all 11 test suites".');
      } else if (Number(countMatch[1]) !== suitePaths.length) {
        errors.push(`README.md says ${countMatch[1]} test suites, but package.json scripts.test runs ${suitePaths.length}.`);
      }
      for (const suitePath of suitePaths) {
        if (!readme.includes(suitePath)) {
          errors.push(`README.md does not list the test entrypoint that npm test runs: ${suitePath}`);
        }
      }
    }

    for (const relativePath of ['SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md']) {
      if (!exists(relativePath)) errors.push(`Add ${relativePath} before the public release.`);
    }

    const rtkProvisioner = readText('scripts/provision-rtk.mjs');
    const minRtkMatch = rtkProvisioner.match(/MIN_(?:COMPATIBLE_)?RTK_VERSION\s*=\s*['"]v?([^'"]+)['"]/);
    const rtkVersionMatch = rtkProvisioner.match(/RTK_VERSION\s*=\s*['"]v?([^'"]+)['"]/);
    const detectedRtkVersion = minRtkMatch?.[1] || rtkVersionMatch?.[1];
    if (!detectedRtkVersion) {
      errors.push('Could not locate MIN_RTK_VERSION or RTK_VERSION in scripts/provision-rtk.mjs.');
    } else {
      const semverMatch = detectedRtkVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
      if (!semverMatch) {
        errors.push(`Invalid RTK version format in scripts/provision-rtk.mjs: ${detectedRtkVersion}`);
      } else {
        const major = Number(semverMatch[1]);
        const minor = Number(semverMatch[2]);
        if (major < 1 || (major === 1 && minor < 1)) {
          errors.push(`RTK version requirement must be >= 1.1.0; found ${detectedRtkVersion} in scripts/provision-rtk.mjs.`);
        } else {
          console.log(`RTK provisioner requirement found: ${detectedRtkVersion} (>= 1.1.0)`);
        }
      }
    }

    if (!pkg.scripts?.setup || !pkg.scripts?.status || !pkg.scripts?.test) {
      errors.push('Expected npm scripts setup, status, and test to be present.');
    }
    if (Object.keys(pkg.dependencies ?? {}).length > 0) {
      warnings.push(`Runtime npm dependencies are present (${Object.keys(pkg.dependencies).join(', ')}); review whether each is required and trusted.`);
    }
  }

  for (const warning of warnings) console.warn(`WARN: ${warning}`);
  for (const error of errors) console.error(`FAIL: ${error}`);

  if (errors.length) {
    console.error(`\nRelease preflight failed with ${errors.length} error(s) and ${warnings.length} warning(s).`);
    process.exitCode = 1;
  } else {
    console.log(`\nRelease preflight passed${warnings.length ? ` with ${warnings.length} warning(s)` : ''}.`);
  }
}

const isEntryPoint = Boolean(
  process.argv[1] &&
  (() => {
    try {
      const resolvedArg = fs.realpathSync(path.resolve(process.argv[1]));
      const resolvedSelf = fs.realpathSync(__filename);
      return process.platform === 'win32' || process.platform === 'darwin'
        ? resolvedArg.toLowerCase() === resolvedSelf.toLowerCase()
        : resolvedArg === resolvedSelf;
    } catch {
      return false;
    }
  })()
);

if (isEntryPoint) {
  runReleasePreflight();
}
