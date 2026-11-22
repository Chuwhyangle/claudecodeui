#!/usr/bin/env node
/**
 * AC-457 criterion: the Cloudpit distribution verifier discriminates.
 *
 * This file is the executable reading of AC-457. It does not restate the verifier's six checks
 * in a second implementation: every arm builds a snapshot, runs the CLI in `--fixture` mode, and
 * the single judgement path is the production `distributionViolations` — the same function the
 * green arm calls directly and the same one `--release` calls after the merge.
 *
 * Arms:
 *   AC3 — a compliant snapshot is green (exit 0, zero violations) through that one function.
 *   AC2a — the legacy package is not deprecated            → red names `old package`.
 *   AC2b — the new package is not published                → red names `new package`.
 *   AC2c — the packed tarball carries a `cloudcli` bin     → red names `tarball`.
 *   AC2d — each repository field is unresolvable           → red names `repository field "<name>"`.
 *   AC2e — the desktop/local-server assets are missing     → red names both asset prefixes.
 *   AC2f — the ownership notice is deleted from each doc   → red names `ownership`.
 *   AC4 — `--help` exits 0 and lists `--release`.
 *   AC5 — a 2.0.0 snapshot is red under the 3.1.0 default and green with
 *         `--version 2.0.0`: the historical release stays readable without being
 *         mistaken for the current one.
 *
 * NOTHING HERE TOUCHES THE NETWORK. Fixture mode reads a JSON file; no arm runs `--release`.
 * The compliant snapshot reads the real README/NOTICE/LICENSE, so a document that loses its
 * attribution reds this criterion even before anyone edits the synthetic fixture.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ATTRIBUTION,
  DESKTOP_ASSET_PREFIX,
  LOCAL_SERVER_ASSET_PREFIX,
  NEW_PACKAGE,
  NEW_VERSION,
  OLD_PACKAGE,
  OLD_VERSION,
  REPOSITORY,
  distributionViolations,
  localServerAssetPrefix,
} from './cloudpit-distribution-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// `scripts/` -> repository root is one level up.
const ROOT = path.resolve(HERE, '..');
const SCRIPT = path.join(HERE, 'cloudpit-distribution-check.mjs');

/** @param {string} rel @returns {string} */
function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * A snapshot in which all six checks pass. The ownership documents are the real ones, so this
 * arm also pins that the checkout still carries the attribution AC-454 wants.
 *
 * @returns {any}
 */
function compliantSnapshot() {
  return {
    npm: {
      oldPackage: {
        name: OLD_PACKAGE,
        version: OLD_VERSION,
        deprecated:
          `${OLD_PACKAGE}@${OLD_VERSION} is deprecated: install ${NEW_PACKAGE} `
            + `and uninstall ${OLD_PACKAGE}.`,
      },
      newPackage: {
        name: NEW_PACKAGE,
        version: NEW_VERSION,
        published: true,
        tarballBin: { cloudpit: 'dist-server/server/modules/cli/cli.js' },
      },
    },
    repository: {
      fullName: REPOSITORY,
      fields: [
        { field: 'url', url: `https://github.com/${REPOSITORY}`, resolved: true },
        { field: 'homepage', url: `https://github.com/${REPOSITORY}`, resolved: true },
        { field: 'repository', url: `git+https://github.com/${REPOSITORY}.git`, resolved: true },
        { field: 'bugs', url: `https://github.com/${REPOSITORY}/issues`, resolved: true },
      ],
    },
    release: {
      assets: [
        { name: `${DESKTOP_ASSET_PREFIX}${NEW_VERSION}-linux-x64.deb`, downloadable: true },
        { name: `${LOCAL_SERVER_ASSET_PREFIX}linux-x64.tar.gz`, downloadable: true },
      ],
    },
    ownership: {
      readme: read('README.md'),
      notice: read('NOTICE'),
      license: read('LICENSE'),
    },
  };
}

/**
 * Run the production CLI against one snapshot in fixture mode.
 *
 * @param {any} snapshot
 * @param {string[]} [extraArgs] additional CLI arguments (e.g. `--version`)
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runFixture(snapshot, extraArgs = []) {
  const directory = mkdtempSync(path.join(tmpdir(), 'cloudpit-distribution-'));
  try {
    const fixture = path.join(directory, 'snapshot.json');
    writeFileSync(fixture, JSON.stringify(snapshot), 'utf8');
    const result = spawnSync(process.execPath, [SCRIPT, '--fixture', fixture, ...extraArgs], {
      encoding: 'utf8',
      // The fixture path is the only input; no environment switch can reach the live reader.
      env: { ...process.env, GITHUB_TOKEN: '' },
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('AC3: the compliant snapshot is green through the single judgement function', () => {
  const snapshot = compliantSnapshot();
  assert.deepEqual(distributionViolations(snapshot), [], 'the compliant snapshot must have no violations');

  const result = runFixture(snapshot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /violations=0/, result.stdout);
});

test('AC2a: a legacy package that is not deprecated reds', () => {
  const snapshot = compliantSnapshot();
  snapshot.npm.oldPackage.deprecated = null;

  const result = runFixture(snapshot);
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /old-package: old package @yalehwang\/cloudcli@1\.42\.0 is not deprecated/,
    result.stderr,
  );
});

test('AC2b: a new package that is not published reds', () => {
  const snapshot = compliantSnapshot();
  snapshot.npm.newPackage.published = false;

  const result = runFixture(snapshot);
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    new RegExp(`new-package: new package @yalehwang/cloudpit@${NEW_VERSION.replaceAll('.', '\\.')} is not published`),
    result.stderr,
  );
});

test('AC2c: a packed tarball that exposes a cloudcli bin reds', () => {
  const snapshot = compliantSnapshot();
  snapshot.npm.newPackage.tarballBin = {
    cloudcli: 'dist-server/server/modules/cli/cli.js',
    cloudpit: 'dist-server/server/modules/cli/cli.js',
  };

  const result = runFixture(snapshot);
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /tarball-bin: new package tarball bin must be exactly "cloudpit", found .*cloudcli/,
    result.stderr,
  );
});

test('AC2d: each unresolvable repository field reds and is named', () => {
  for (const field of ['url', 'homepage', 'repository', 'bugs']) {
    const snapshot = compliantSnapshot();
    const entry = snapshot.repository.fields.find(
      (/** @type {any} */ candidate) => candidate.field === field,
    );
    assert.ok(entry, `the compliant snapshot must carry the ${field} field`);
    entry.resolved = false;

    const result = runFixture(snapshot);
    assert.equal(result.status, 1, `${field}: ${result.stderr}`);
    assert.match(
      result.stderr,
      new RegExp(`repository field "${field}" is not resolvable`),
      `${field}: ${result.stderr}`,
    );
  }
});

test('AC2e: missing desktop and local-server assets red and name both prefixes', () => {
  const snapshot = compliantSnapshot();
  snapshot.release.assets = [
    { name: `${DESKTOP_ASSET_PREFIX}${NEW_VERSION}-linux-x64.deb`, downloadable: false },
  ];

  const result = runFixture(snapshot);
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /desktop release asset cloudpit-desktop-\* is missing or not downloadable/,
    result.stderr,
  );
  assert.ok(
    result.stderr.includes(
      `desktop release asset ${localServerAssetPrefix(NEW_VERSION)}* is missing or not downloadable`,
    ),
    result.stderr,
  );
});

test('AC2f: deleting the ownership notice from each document reds', () => {
  /** @type {{ doc: 'readme' | 'notice' | 'license', label: string, mutate: (text: string) => string }[]} */
  const mutations = [
    {
      doc: 'readme',
      label: 'README',
      mutate: (text) => text.replaceAll('siteboon/claudecodeui', 'example/elsewhere'),
    },
    {
      doc: 'notice',
      label: 'NOTICE',
      mutate: (text) => text.replaceAll(ATTRIBUTION, 'the upstream project'),
    },
    {
      doc: 'license',
      label: 'LICENSE',
      mutate: (text) => text.replaceAll(ATTRIBUTION, 'the upstream project'),
    },
  ];

  for (const mutation of mutations) {
    const snapshot = compliantSnapshot();
    snapshot.ownership[mutation.doc] = mutation.mutate(snapshot.ownership[mutation.doc]);

    const result = runFixture(snapshot);
    assert.equal(result.status, 1, `${mutation.label}: ${result.stderr}`);
    assert.match(
      result.stderr,
      new RegExp(`ownership attribution is missing from ${mutation.label}`),
      `${mutation.label}: ${result.stderr}`,
    );
  }
});

test('AC4: --help exits 0 and lists --release and --version', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--release/, result.stdout);
  assert.match(result.stdout, /--version/, result.stdout);
  assert.ok(result.stdout.includes(NEW_VERSION), result.stdout);
});

test('AC5: the historical 2.0.0 release is readable only through an explicit --version', () => {
  /** @param {string} version @returns {any} */
  const historicalSnapshot = (version) => {
    const snapshot = compliantSnapshot();
    snapshot.npm.newPackage.version = version;
    snapshot.release.assets[0].name = `${DESKTOP_ASSET_PREFIX}${version}-linux-x64.deb`;
    snapshot.release.assets[1].name = `${localServerAssetPrefix(version)}linux-x64.tar.gz`;
    return snapshot;
  };

  // Negative arm: under the 3.1.0 default the 2.0.0 snapshot is NOT read as the current
  // release — the red names 3.1.0, so a stale 2.0.0 fixture cannot make the default green.
  const asCurrent = runFixture(historicalSnapshot('2.0.0'));
  assert.equal(asCurrent.status, 1, asCurrent.stderr);
  assert.ok(
    asCurrent.stderr.includes(`new package @yalehwang/cloudpit@${NEW_VERSION} is not published`),
    asCurrent.stderr,
  );

  // Positive arm: the historical release remains verifiable when asked for explicitly.
  const historical = runFixture(historicalSnapshot('2.0.0'), ['--version', '2.0.0']);
  assert.equal(historical.status, 0, historical.stderr);
  assert.match(historical.stdout, /violations=0/, historical.stdout);
});
