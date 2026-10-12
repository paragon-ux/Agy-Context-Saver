#!/usr/bin/env node
/**
 * Non-destructive release metadata/package preflight for Agy-Context-Saver.
 * Run from the repository root: node scripts/release-preflight.mjs
 * This script reads files only; it does not install the plugin or provision RTK.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
try {
  pkg = JSON.parse(readText('package.json'));
} catch (error) {
  errors.push(`package.json is not valid JSON: ${error.message}`);
}

if (pkg) {
  if (pkg.name !== 'agy-context-saver') {
    errors.push(`Expected package name "agy-context-saver"; found ${JSON.stringify(pkg.name)}.`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version ?? '')) {
    errors.push(`package.json version is not a valid semver release version: ${JSON.stringify(pkg.version)}.`);
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
    'mcp/index.js',
    'scripts/install-register.mjs',
    'scripts/provision-rtk.mjs',
    'plugin.json',
    'hooks.json',
    'mcp_config.json',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
  ];

  for (const relativePath of requiredPackageFiles) {
    if (!exists(relativePath)) errors.push(`Required runtime/release file is missing: ${relativePath}`);
    const coveredByFiles = (pkg.files ?? []).some((entry) => {
      const normalized = entry.replace(/\\/g, '/').replace(/\/$/, '');
      return relativePath === normalized || relativePath.startsWith(`${normalized}/`);
    });
    if (!coveredByFiles) {
      errors.push(`package.json "files" does not clearly include ${relativePath}.`);
    }
  }

  const binEntries = Object.values(pkg.bin ?? {});
  if (binEntries.length === 0) errors.push('package.json has no bin entry.');
  for (const binPath of binEntries) {
    if (!exists(binPath)) errors.push(`package.json bin target does not exist: ${binPath}`);
    const coveredByFiles = (pkg.files ?? []).some((entry) => {
      const normalized = entry.replace(/\\/g, '/').replace(/\/$/, '');
      return binPath === normalized || binPath.startsWith(`${normalized}/`);
    });
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
      errors.push('README.md must state the exact suite count using a sentence such as "Runs all 8 test suites".');
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
  const rtkVersionMatch = rtkProvisioner.match(/RTK_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!rtkVersionMatch) {
    errors.push('Could not locate a pinned RTK_VERSION in scripts/provision-rtk.mjs.');
  } else {
    console.log(`RTK provisioner pin found: ${rtkVersionMatch[1]}`);
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
