import { globSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The API-speed workspace view is registered as `{ id: 'api-speed', labelKey: 'tabs.apiSpeed' }`
 * and its panel renders every `apiSpeed.*` label below. react-i18next renders a missing key
 * verbatim — which is how the Quay tab once shipped showing `tabs.quay` — and a dropped
 * interpolation renders a sentence with the value missing. Neither is visible in an
 * English-only read, so this walks the whole `locales/&#42;/common.json` glob rather than a
 * hardcoded list: a locale added (or dropped) without the matching keys cannot pass by going
 * stale.
 *
 * Resolved from the vitest process cwd (the repo root), the way the sibling Quay criterion
 * does it: under vitest's jsdom environment `import.meta.url` is not a `file:` URL.
 */
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');

/** The shape this test reads back out of a locale bundle — deliberately loose. */
type CommonBundle = {
  tabs?: Record<string, unknown>;
  apiSpeed?: Record<string, unknown>;
};

/**
 * The keys the panel renders. Pinned here so a key REMOVED from the English bundle (which would
 * make every locale's comparison vacuum-green) still fails, and so the English bundle itself is
 * checked to be complete rather than merely self-consistent.
 */
const EXPECTED_KEYS = [
  'autoOff',
  'autoOn',
  'colLink',
  'colMode',
  'colTime',
  'empty',
  'firstToken',
  'loading',
  'loadingTarget',
  'noCredential',
  'noCredentialShort',
  'probePing',
  'probeUpload',
  'reused',
  'stageConnect',
  'stageDownload',
  'stageGateway',
  'stageUpload',
  'statGatewayP50',
  'statTotalP50',
  'statTotalP90',
  'statUploadP50',
  'targetLine',
  'title',
  'total',
  'trend',
];

/** The interpolation names in a translated string, e.g. `{{count}}` → `count`, sorted. */
function interpolationNames(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]).sort();
}

/** The reasons a bundle fails the `tabs.apiSpeed` contract; an empty array means it passes. */
function apiSpeedTabProblems(bundle: CommonBundle): string[] {
  const value = bundle.tabs?.apiSpeed;
  if (typeof value !== 'string') return ['tabs.apiSpeed is missing or not a string'];
  if (value.trim().length === 0) return ['tabs.apiSpeed is an empty string'];
  if (value === 'tabs.apiSpeed') return ['tabs.apiSpeed is the raw key name, not a label'];
  return [];
}

/**
 * The reasons one locale's `apiSpeed` block fails the panel's contract. The ENGLISH non-plural
 * keys are the reference: every other locale must carry the same set, the same interpolation
 * names, and a value that is not merely its own key name.
 */
function apiSpeedBlockProblems(bundle: CommonBundle, reference: Record<string, unknown>): string[] {
  const block = bundle.apiSpeed;
  if (typeof block !== 'object' || block === null) return ['apiSpeed is missing'];

  const problems: string[] = [];
  for (const [key, referenceValue] of Object.entries(reference)) {
    const value = block[key];
    if (typeof value !== 'string') {
      problems.push(`apiSpeed.${key} is missing or not a string`);
      continue;
    }
    if (value.trim().length === 0) {
      problems.push(`apiSpeed.${key} is an empty string`);
      continue;
    }
    if (value === `apiSpeed.${key}`) {
      problems.push(`apiSpeed.${key} is the raw key name, not a label`);
      continue;
    }
    const expected = interpolationNames(String(referenceValue));
    const actual = interpolationNames(value);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`apiSpeed.${key} interpolates ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }
  return problems;
}

const bundleFiles = globSync('*/common.json', { cwd: LOCALES_DIR }).sort();

describe('every locale carries the API-speed tab label and panel keys', () => {
  it('covers every language directory on disk (the 12-locale glob, not a sampled subset)', () => {
    const localeDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(bundleFiles).toEqual(localeDirs.map((dir) => `${dir}/common.json`));
    expect(localeDirs.length, `locale directories found: ${JSON.stringify(localeDirs)}`).toBeGreaterThanOrEqual(12);
  });

  it('gives every locale a non-empty tabs.apiSpeed that is not the key name itself', () => {
    const offenders: string[] = [];
    for (const file of bundleFiles) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as CommonBundle;
      for (const problem of apiSpeedTabProblems(bundle)) offenders.push(`${file}: ${problem}`);
    }
    expect(offenders).toEqual([]);
  });

  it('rejects a missing, blank or key-copied tab label (positive control)', () => {
    expect(apiSpeedTabProblems({ tabs: {} })).toEqual(['tabs.apiSpeed is missing or not a string']);
    expect(apiSpeedTabProblems({ tabs: { apiSpeed: '' } })).toEqual(['tabs.apiSpeed is an empty string']);
    expect(apiSpeedTabProblems({ tabs: { apiSpeed: 'tabs.apiSpeed' } })).toEqual([
      'tabs.apiSpeed is the raw key name, not a label',
    ]);
    expect(apiSpeedTabProblems({ tabs: { apiSpeed: 'API speed' } })).toEqual([]);
  });
});

describe('every locale carries the API-speed panel keys', () => {
  const english = JSON.parse(
    readFileSync(join(LOCALES_DIR, 'en', 'common.json'), 'utf8'),
  ) as CommonBundle;
  const reference = english.apiSpeed ?? {};

  it('the English bundle declares exactly the keys this panel renders', () => {
    expect(Object.keys(reference).sort()).toEqual(EXPECTED_KEYS);
  });

  it('every locale carries each key with the English placeholders and a real value', () => {
    const offenders: string[] = [];
    for (const file of bundleFiles) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as CommonBundle;
      for (const problem of apiSpeedBlockProblems(bundle, reference)) offenders.push(`${file}: ${problem}`);
    }
    expect(offenders).toEqual([]);
  });

  it('rejects a missing, blank, key-copied or placeholder-dropping block (positive control)', () => {
    expect(apiSpeedBlockProblems({}, reference)).toEqual(['apiSpeed is missing']);

    const { title: _omitted, ...withoutTitle } = reference;
    expect(apiSpeedBlockProblems({ apiSpeed: withoutTitle }, reference)).toEqual([
      'apiSpeed.title is missing or not a string',
    ]);

    expect(apiSpeedBlockProblems({ apiSpeed: { ...reference, title: '  ' } }, reference)).toEqual([
      'apiSpeed.title is an empty string',
    ]);

    expect(apiSpeedBlockProblems({ apiSpeed: { ...reference, empty: 'apiSpeed.empty' } }, reference)).toEqual([
      'apiSpeed.empty is the raw key name, not a label',
    ]);

    expect(
      apiSpeedBlockProblems({ apiSpeed: { ...reference, targetLine: '{{host}} · {{model}}' } }, reference),
    ).toEqual([
      'apiSpeed.targetLine interpolates ["host","model"], expected ["host","model","source"]',
    ]);
  });
});
