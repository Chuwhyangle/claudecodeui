#!/usr/bin/env node
/**
 * Distribution verifier for the Cloudpit rename (AC-457 carrier, AC-454 criterion).
 *
 * AC-454 asks whether the *external* release actually happened:
 *
 *   - `@yalehwang/cloudcli@1.42.0` is deprecated and the notice points at the new package;
 *   - `@yalehwang/cloudpit@<version>` is published and its packed tarball exposes only the
 *     `cloudpit` bin;
 *   - the `yaleh/cloudpit` repository URL, homepage, repository and bugs fields resolve;
 *   - the desktop `cloudpit-desktop-*` and `cloudpit-local-server-v<version>-*` release
 *     assets are downloadable;
 *
 * VERSIONED READING. The release being verified is a parameter, not a baked-in target:
 * `NEW_VERSION` (3.1.0) is the default, and `--version <x.y.z>` reads any other release
 * (for example the historical `--version 2.0.0` reading of AC-458's 2.0.0 release). The
 * npm version document, the packed-manifest lookup, the GitHub release tag and the
 * local-server asset prefix all derive from that one value.
 *   - README/NOTICE/LICENSE still carry the upstream CloudCLI UI attribution.
 *
 * ONE JUDGEMENT PATH. `distributionViolations(snapshot)` is the only place those six checks are
 * decided. The live reader in `collectReleaseSnapshot` assembles a snapshot from npm, the GitHub
 * API and the the local documents; the fixture reader parses the same shape from a JSON file.
 * The CLI (`--release` / `--fixture <path>`) then feeds either source through that one function,
 * which is what makes the offline criterion meaningful: it cannot be green through a second
 * implementation that the live path never runs.
 *
 * WHY THE READER IS INJECTABLE. AC-457 must run pre-merge with zero network, so every external
 * reading in the fixture shape is data (`published`, `resolved`, `downloadable`, ...), not a
 * side effect. The tests build compliant and non-compliant snapshots of that shape; `--release`
 * is the only mode that touches the network, and it is the mode AC-454 runs after the merge.
 *
 * WHAT IS NOT HERE. This file performs no publish, no deprecate, no rename and no upload. It is
 * a reading, not a release step.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The final legacy package, deprecated in favour of the new name. */
export const OLD_PACKAGE = '@yalehwang/cloudcli';
export const OLD_VERSION = '1.42.0';
/** The renamed package and the default version this verifier reads. */
export const NEW_PACKAGE = '@yalehwang/cloudpit';
/** The release the default reading targets; `--version` overrides it per invocation. */
export const NEW_VERSION = '3.1.0';
/** The repository the rename points every URL field at. */
export const REPOSITORY = 'yaleh/cloudpit';
/** The attribution token the upstream licence terms require the documents to keep. */
export const ATTRIBUTION = 'CloudCLI UI';
/** Asset-name prefixes the desktop release must publish. */
export const DESKTOP_ASSET_PREFIX = 'cloudpit-desktop-';
/** The local-server asset prefix for one release version (defaults to {@link NEW_VERSION}). */
export function localServerAssetPrefix(version = NEW_VERSION) {
  return `cloudpit-local-server-v${version}-`;
}
export const LOCAL_SERVER_ASSET_PREFIX = localServerAssetPrefix(NEW_VERSION);
/** A semver-shaped release version accepted by `--version`. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** The repository fields AC-454 names. */
export const REQUIRED_REPOSITORY_FIELDS = ['url', 'homepage', 'repository', 'bugs'];
/** The six check groups, in one place so a count in a reading cannot drift from the judgements. */
export const CHECKS = [
  'old-package',
  'new-package',
  'tarball-bin',
  'repository',
  'desktop-assets',
  'ownership',
];

/**
 * @typedef {{ field: string, url: string, resolved: boolean }} RepositoryFieldSnapshot
 * @typedef {{ name: string, downloadable: boolean, url?: string }} ReleaseAssetSnapshot
 * @typedef {{
 *   npm: {
 *     oldPackage: { name: string, version: string, deprecated: string | null },
 *     newPackage: {
 *       name: string,
 *       version: string,
 *       published: boolean,
 *       tarballBin: Record<string, unknown>,
 *     },
 *   },
 *   repository: { fullName: string, fields: RepositoryFieldSnapshot[] },
 *   release: { assets: ReleaseAssetSnapshot[] },
 *   ownership: { readme: string, notice: string, license: string },
 * }} DistributionSnapshot
 *
 * @typedef {{ check: string, message: string }} DistributionViolation
 */

/** @param {string} check @param {string} message @returns {DistributionViolation} */
function violation(check, message) {
  return { check, message };
}

/**
 * The GitHub repository path a URL points at, or null when the value does not parse as a
 * GitHub URL. `git+https://…` and the `.git` suffix are accepted because those are the shapes
 * `package.json` uses; `git@github.com:` is accepted for completeness.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function githubRepositoryPath(value) {
  let text = String(value ?? '').trim();
  if (!text) return null;
  if (text.startsWith('git+')) text = text.slice(4);
  if (text.startsWith('git@github.com:')) {
    text = `https://github.com/${text.slice('git@github.com:'.length)}`;
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'github.com') return null;
  return parsed.pathname.replace(/\.git$/, '').replace(/\/+$/, '');
}

/**
 * The path each named repository field must resolve to.
 *
 * @type {Record<string, string>}
 */
const EXPECTED_REPOSITORY_PATHS = {
  url: `/${REPOSITORY}`,
  homepage: `/${REPOSITORY}`,
  repository: `/${REPOSITORY}`,
  bugs: `/${REPOSITORY}/issues`,
};

/**
 * Decide every AC-454 reading for one snapshot.
 *
 * The function is pure: no I/O, no network, no clock. Callers that want the live readings use
 * `collectReleaseSnapshot`, callers that want an offline reading use `loadSnapshotFromFile`.
 *
 * @param {DistributionSnapshot | null | undefined} snapshot
 * @param {{ version?: string }} [options] release version to judge (defaults to NEW_VERSION)
 * @returns {DistributionViolation[]}
 */
export function distributionViolations(snapshot, { version = NEW_VERSION } = {}) {
  /** @type {DistributionViolation[]} */
  const violations = [];
  const npm = snapshot?.npm;

  // 1. The legacy package must exist, be deprecated, and point at the new name.
  const oldPackage = npm?.oldPackage;
  if (!oldPackage || oldPackage.name !== OLD_PACKAGE || oldPackage.version !== OLD_VERSION) {
    violations.push(violation(
      'old-package',
      `old package ${OLD_PACKAGE}@${OLD_VERSION} is missing from the snapshot`,
    ));
  } else if (typeof oldPackage.deprecated !== 'string' || oldPackage.deprecated.trim() === '') {
    violations.push(violation(
      'old-package',
      `old package ${OLD_PACKAGE}@${OLD_VERSION} is not deprecated`,
    ));
  } else if (!oldPackage.deprecated.includes(NEW_PACKAGE)) {
    violations.push(violation(
      'old-package',
      `old package deprecation notice does not point at ${NEW_PACKAGE}: `
        + JSON.stringify(oldPackage.deprecated),
    ));
  }

  // 2. The new package must be published, and its packed manifest must expose only one bin.
  const newPackage = npm?.newPackage;
  if (
    !newPackage
    || newPackage.name !== NEW_PACKAGE
    || newPackage.version !== version
    || newPackage.published !== true
  ) {
    violations.push(violation(
      'new-package',
      `new package ${NEW_PACKAGE}@${version} is not published`,
    ));
  }
  if (newPackage) {
    const tarballBin = newPackage.tarballBin;
    const binKeys = tarballBin !== null && typeof tarballBin === 'object'
      ? Object.keys(tarballBin)
      : [];
    if (binKeys.length !== 1 || binKeys[0] !== 'cloudpit') {
      violations.push(violation(
        'tarball-bin',
        `new package tarball bin must be exactly "cloudpit", found ${JSON.stringify(binKeys)}`,
      ));
    }
  }

  // 3. Every repository identity field must resolve to yaleh/cloudpit.
  const repository = snapshot?.repository;
  if (repository?.fullName !== REPOSITORY) {
    violations.push(violation(
      'repository',
      `repository identity must be "${REPOSITORY}", found ${JSON.stringify(repository?.fullName)}`,
    ));
  }
  const fields = Array.isArray(repository?.fields) ? repository.fields : [];
  for (const field of REQUIRED_REPOSITORY_FIELDS) {
    const entry = fields.find((candidate) => candidate?.field === field);
    if (!entry) {
      violations.push(violation(
        'repository',
        `repository field "${field}" is not resolvable: missing from the snapshot`,
      ));
      continue;
    }
    if (entry.resolved !== true) {
      violations.push(violation(
        'repository',
        `repository field "${field}" is not resolvable: ${JSON.stringify(entry.url ?? '')}`,
      ));
      continue;
    }
    if (githubRepositoryPath(entry.url) !== EXPECTED_REPOSITORY_PATHS[field]) {
      violations.push(violation(
        'repository',
        `repository field "${field}" does not point at ${REPOSITORY}: `
          + JSON.stringify(entry.url ?? ''),
      ));
    }
  }

  // 4. Both desktop release assets must be present and downloadable.
  const assets = Array.isArray(snapshot?.release?.assets) ? snapshot.release.assets : [];
  /**
   * @param {string} prefix
   * @returns {boolean}
   */
  const downloadable = (prefix) => assets.some((asset) => (
    typeof asset?.name === 'string'
    && asset.name.startsWith(prefix)
    && asset.downloadable === true
  ));
  for (const prefix of [DESKTOP_ASSET_PREFIX, localServerAssetPrefix(version)]) {
    if (!downloadable(prefix)) {
      violations.push(violation(
        'desktop-assets',
        `desktop release asset ${prefix}* is missing or not downloadable`,
      ));
    }
  }

  // 5. The upstream attribution survives in all three documents.
  const ownership = snapshot?.ownership;
  /** @type {{ doc: 'readme' | 'notice' | 'license', label: string, present: (text: string) => boolean }[]} */
  const attributionRules = [
    {
      doc: 'readme',
      label: 'README',
      // README carries the fork attribution, not necessarily the licence token verbatim.
      present: (text) => /fork of\s+\[?siteboon\/claudecodeui/i.test(text),
    },
    { doc: 'notice', label: 'NOTICE', present: (text) => text.includes(ATTRIBUTION) },
    { doc: 'license', label: 'LICENSE', present: (text) => text.includes(ATTRIBUTION) },
  ];
  for (const rule of attributionRules) {
    const text = ownership?.[rule.doc];
    if (typeof text !== 'string' || !rule.present(text)) {
      const expected = rule.doc === 'readme'
        ? `the "${ATTRIBUTION}" fork-of notice (siteboon/claudecodeui)`
        : `the "${ATTRIBUTION}" notice`;
      violations.push(violation(
        'ownership',
        `ownership attribution is missing from ${rule.label}: expected ${expected}`,
      ));
    }
  }

  return violations;
}

/**
 * Read one snapshot file. The file must be a JSON object; a malformed file is a caller error,
 * not a compliance reading, so it throws instead of producing a violation.
 *
 * @param {string} file
 * @returns {DistributionSnapshot}
 */
export function loadSnapshotFromFile(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`snapshot ${file} must be a JSON object`);
  }
  return /** @type {DistributionSnapshot} */ (parsed);
}

/**
 * @param {string} file
 * @returns {string}
 */
function readTextOrEmpty(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * @param {string} file
 * @returns {Record<string, any>}
 */
function readJsonOrEmpty(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * A `git+` / `git@github.com:` URL as a fetchable URL, or null.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function fetchableUrl(value) {
  let text = String(value ?? '').trim();
  if (!text) return null;
  if (text.startsWith('git+')) text = text.slice(4);
  if (text.startsWith('git@github.com:')) {
    text = `https://github.com/${text.slice('git@github.com:'.length)}`;
  }
  try {
    return new URL(text).href;
  } catch {
    return null;
  }
}

const USER_AGENT = 'cloudpit-distribution-check/1.0';

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<{ ok: boolean, status: number, response: Response | null }>}
 */
async function request(fetchImpl, url, init = {}) {
  try {
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
    return { ok: response.ok, status: response.status, response };
  } catch {
    return { ok: false, status: 0, response: null };
  }
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<{ ok: boolean, status: number, body: any }>}
 */
async function requestJson(fetchImpl, url, init = {}) {
  const result = await request(fetchImpl, url, init);
  if (!result.ok || result.response === null) {
    return { ok: false, status: result.status, body: null };
  }
  try {
    return { ok: true, status: result.status, body: await result.response.json() };
  } catch {
    return { ok: false, status: result.status, body: null };
  }
}

/**
 * Whether HEAD (following redirects) answers 2xx/3xx for a URL.
 *
 * @param {typeof fetch} fetchImpl
 * @param {unknown} value
 * @returns {Promise<boolean>}
 */
async function resolves(fetchImpl, value) {
  const url = fetchableUrl(value);
  if (url === null) return false;
  const result = await request(fetchImpl, url, { method: 'HEAD' });
  return result.status >= 200 && result.status < 400;
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} field
 * @param {unknown} url
 * @returns {Promise<RepositoryFieldSnapshot>}
 */
async function repositoryField(fetchImpl, field, url) {
  return {
    field,
    url: typeof url === 'string' ? url : '',
    resolved: await resolves(fetchImpl, url),
  };
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {any} release
 * @param {string} version
 * @returns {Promise<ReleaseAssetSnapshot[]>}
 */
async function releaseAssets(fetchImpl, release, version) {
  /** @type {any[]} */
  const raw = Array.isArray(release?.assets) ? release.assets : [];
  return Promise.all(raw.map(async (asset) => {
    const name = String(asset?.name ?? '');
    const url = String(asset?.browser_download_url ?? '');
    const isCandidate = name.startsWith(DESKTOP_ASSET_PREFIX)
      || name.startsWith(localServerAssetPrefix(version));
    const downloadable = asset?.state === 'uploaded'
      && (isCandidate ? await resolves(fetchImpl, url) : true);
    return { name, url, downloadable };
  }));
}

/**
 * Assemble the AC-454 snapshot from live sources.
 *
 * npm is read through the registry's version documents; the packed `bin` map is read from the
 * published tarball's `package.json` via unpkg, so the reading is the packed artifact rather
 * than this checkout. GitHub's repository and release documents supply the URL and asset names,
 * and each named URL is HEAD-checked (redirects followed) for `resolved` / `downloadable`.
 *
 * A failed request is not an exception: it yields an unresolved reading, which the same
 * `distributionViolations` path turns into a named red. That is the post-merge behaviour AC-454
 * wants — an unreachable release is a failed check, not a crash.
 *
 * @param {{
 *   root?: string,
 *   fetchImpl?: typeof fetch,
 *   githubToken?: string | undefined,
 *   version?: string,
 * }} [options]
 * @returns {Promise<DistributionSnapshot>}
 */
export async function collectReleaseSnapshot({
  root = process.cwd(),
  fetchImpl = globalThis.fetch,
  githubToken = process.env.GITHUB_TOKEN,
  version = NEW_VERSION,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('no fetch implementation is available for --release');
  }

  /** @type {Record<string, string>} */
  const githubHeaders = githubToken ? { authorization: `Bearer ${githubToken}` } : {};
  const [oldMetadata, newMetadata, packedManifest, repoMetadata, releaseMetadata] =
    await Promise.all([
      requestJson(fetchImpl, `https://registry.npmjs.org/${encodeURIComponent(OLD_PACKAGE)}/${OLD_VERSION}`),
      requestJson(fetchImpl, `https://registry.npmjs.org/${encodeURIComponent(NEW_PACKAGE)}/${version}`),
      requestJson(fetchImpl, `https://unpkg.com/${NEW_PACKAGE}@${version}/package.json`),
      requestJson(fetchImpl, `https://api.github.com/repos/${REPOSITORY}`, { headers: githubHeaders }),
      requestJson(fetchImpl, `https://api.github.com/repos/${REPOSITORY}/releases/tags/v${version}`, {
        headers: githubHeaders,
      }),
    ]);

  const packageJson = readJsonOrEmpty(path.join(root, 'package.json'));
  const packedBin = packedManifest.body?.bin;
  const tarballBin = packedBin !== null && typeof packedBin === 'object' ? packedBin : {};

  return {
    npm: {
      oldPackage: {
        name: OLD_PACKAGE,
        version: OLD_VERSION,
        deprecated: oldMetadata.ok && typeof oldMetadata.body?.deprecated === 'string'
          ? oldMetadata.body.deprecated
          : null,
      },
      newPackage: {
        name: NEW_PACKAGE,
        version,
        published: newMetadata.ok,
        tarballBin,
      },
    },
    repository: {
      fullName: repoMetadata.ok ? String(repoMetadata.body?.full_name ?? '') : '',
      fields: await Promise.all([
        repositoryField(
          fetchImpl,
          'url',
          repoMetadata.body?.html_url ?? `https://github.com/${REPOSITORY}`,
        ),
        repositoryField(fetchImpl, 'homepage', packageJson?.homepage),
        repositoryField(fetchImpl, 'repository', packageJson?.repository?.url),
        repositoryField(fetchImpl, 'bugs', packageJson?.bugs?.url),
      ]),
    },
    release: { assets: await releaseAssets(fetchImpl, releaseMetadata.body, version) },
    ownership: {
      readme: readTextOrEmpty(path.join(root, 'README.md')),
      notice: readTextOrEmpty(path.join(root, 'NOTICE')),
      license: readTextOrEmpty(path.join(root, 'LICENSE')),
    },
  };
}

/** @returns {string} */
export function usage() {
  return [
    'Cloudpit distribution verifier (AC-457 carrier / AC-454 criterion)',
    '',
    'Usage:',
    '  node scripts/cloudpit-distribution-check.mjs --release [--version <x.y.z>]',
    '  node scripts/cloudpit-distribution-check.mjs --fixture <snapshot.json> [--version <x.y.z>] [--json]',
    '  node scripts/cloudpit-distribution-check.mjs --help',
    '',
    'Modes:',
    '  --release            read npm, GitHub secrets/URLs and the local documents, then judge',
    '  --fixture <path>     judge a recorded snapshot without network access',
    '  --root <dir>         repository root for local documents (default: current directory)',
    `  --version <x.y.z>    release version to verify (default: ${NEW_VERSION}; e.g. 2.0.0`,
    '                       reads the historical 2.0.0 release)',
    '  --json               print the verdict and violations as JSON',
    '  --help               print this help and exit 0',
    '',
  ].join('\n');
}

/**
 * @param {string[]} argv
 * @returns {{
 *   mode: 'release' | 'fixture' | null,
 *   fixture: string | null,
 *   root: string,
 *   version: string | null,
 *   json: boolean,
 *   help: boolean,
 *   error: string | null,
 * }}
 */
function parseArgs(argv) {
  /** @type {ReturnType<typeof parseArgs>} */
  const options = {
    mode: null,
    fixture: null,
    root: process.cwd(),
    version: null,
    json: false,
    help: false,
    error: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--release') {
      options.mode = 'release';
    } else if (arg === '--fixture') {
      options.mode = 'fixture';
      options.fixture = argv[index + 1] ?? null;
      if (options.fixture === null) {
        options.error = '--fixture needs a snapshot path';
      } else {
        index += 1;
      }
    } else if (arg === '--root') {
      options.root = path.resolve(argv[index + 1] ?? '.');
      if (argv[index + 1] !== undefined) index += 1;
    } else if (arg === '--version') {
      options.version = argv[index + 1] ?? null;
      if (options.version === null) {
        if (options.error === null) options.error = '--version needs a semver value';
      } else if (!VERSION_PATTERN.test(options.version)) {
        if (options.error === null) {
          options.error = `--version must be a semver version, got ${JSON.stringify(options.version)}`;
        }
        index += 1;
      } else {
        index += 1;
      }
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (options.error === null) {
      options.error = `unknown argument: ${arg}`;
    }
  }

  return options;
}

/**
 * CLI entry point.
 *
 * @param {string[]} [argv]
 * @param {{ fetchImpl?: typeof fetch, stdout?: Pick<Console, 'log'>, stderr?: Pick<Console, 'error'> }} [io]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2), {
  fetchImpl = globalThis.fetch,
  stdout = console,
  stderr = console,
} = {}) {
  const options = parseArgs(argv);

  if (options.help) {
    stdout.log(usage());
    return 0;
  }
  if (options.error !== null) {
    stderr.error(`[distribution] ${options.error}`);
    stderr.error(usage());
    return 2;
  }
  if (options.mode === null) {
    stderr.error('[distribution] choose --release or --fixture <path>');
    stderr.error(usage());
    return 2;
  }

  const version = options.version ?? NEW_VERSION;
  /** @type {DistributionSnapshot} */
  let snapshot;
  /** @type {string} */
  let source;
  try {
    if (options.mode === 'fixture') {
      snapshot = loadSnapshotFromFile(/** @type {string} */ (options.fixture));
      source = `fixture:${options.fixture}`;
    } else {
      snapshot = await collectReleaseSnapshot({ root: options.root, fetchImpl, version });
      source = 'release';
    }
  } catch (error) {
    stderr.error(`[distribution] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const violations = distributionViolations(snapshot, { version });
  const exitCode = violations.length === 0 ? 0 : 1;

  if (options.json) {
    stdout.log(JSON.stringify({ source, version, exitCode, checks: CHECKS, violations }, null, 2));
  } else {
    stdout.log(
      `cloudpit-distribution: source=${source} version=${version} checks=${CHECKS.length} `
        + `violations=${violations.length}`,
    );
    for (const item of violations) {
      stderr.error(`[distribution] ${item.check}: ${item.message}`);
    }
  }

  return exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`[distribution] fatal: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
