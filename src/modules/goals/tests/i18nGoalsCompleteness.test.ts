import { globSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The Goals workspace view is registered as `{ id: 'goals', labelKey: 'tabs.goals' }` and its
 * panel renders every `goals.*` label below. react-i18next renders a missing key verbatim — which
 * is how the Quay tab once shipped showing `tabs.quay` — and a dropped interpolation renders a
 * sentence with the value missing. Neither is visible in an English-only read, so this walks the
 * whole `locales/&#42;/common.json` glob rather than a sampled subset: a locale added (or dropped)
 * without the matching keys cannot pass by going stale.
 *
 * Resolved from the vitest process cwd (the repo root), the way the sibling Quay/API-speed
 * criteria do it: under vitest's jsdom environment `import.meta.url` is not a `file:` URL.
 */
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');

/** The shape this test reads back out of a locale bundle — deliberately loose. */
type CommonBundle = {
  tabs?: Record<string, unknown>;
  goals?: Record<string, unknown>;
};

/**
 * The keys the panel renders, pinned so a key REMOVED from the English bundle (which would make
 * every locale's comparison vacuum-green) still fails, and so English itself is checked complete.
 */
const EXPECTED_STRING_KEYS = [
  'acCriterionPlaceholder',
  'acExpectPlaceholder',
  'acProgress',
  'acTitlePlaceholder',
  'abandon',
  'activate',
  'addCriterion',
  'budget',
  'budgetHint',
  'collapse',
  'create',
  'createCancel',
  'createSubmit',
  'creating',
  'criteria',
  'criterionNumber',
  'emptyBody',
  'emptyTitle',
  'expect',
  'expand',
  'fieldMaxNoProgress',
  'fieldMaxRounds',
  'fieldObjective',
  'fieldObjectivePlaceholder',
  'fieldTitle',
  'fieldTitlePlaceholder',
  'fieldWallClockHours',
  'formBudgetInvalid',
  'formIncomplete',
  'formTitle',
  'goalId',
  'lastReading',
  'latestRound',
  'loading',
  'noCriteria',
  'noReading',
  'noRounds',
  'outcomeRunning',
  'pause',
  'providerLabel',
  'refusalGreenAcs',
  'refresh',
  'removeCriterion',
  'resume',
  'retry',
  'rounds',
  'runRound',
  'timedOut',
  'title',
];

/** The three nested label groups; their key sets are fixed because the panel renders every row. */
const NESTED_GROUPS: Record<string, string[]> = {
  provider: ['claude', 'codex', 'cursor', 'opencode'],
  verdict: ['fail', 'pass'],
  outcome: ['budget-hit', 'error', 'green', 'no-progress', 'progress', 'stalled'],
};

/** The interpolation names in a translated string, e.g. `{{count}}` → `count`, sorted. */
function interpolationNames(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]).sort();
}

/** The reasons a bundle fails the `tabs.goals` contract; an empty array means it passes. */
function goalsTabProblems(bundle: CommonBundle): string[] {
  const value = bundle.tabs?.goals;
  if (typeof value !== 'string') return ['tabs.goals is missing or not a string'];
  if (value.trim().length === 0) return ['tabs.goals is an empty string'];
  if (value === 'tabs.goals') return ['tabs.goals is the raw key name, not a label'];
  return [];
}

/** One string label's problems against the English reference, shared by top-level and nested keys. */
function labelProblems(prefix: string, value: unknown, referenceValue: unknown): string[] {
  if (typeof value !== 'string') return [`${prefix} is missing or not a string`];
  if (value.trim().length === 0) return [`${prefix} is an empty string`];
  if (value === prefix) return [`${prefix} is the raw key name, not a label`];
  const expected = interpolationNames(String(referenceValue));
  const actual = interpolationNames(value);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return [`${prefix} interpolates ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`];
  }
  return [];
}

/**
 * The reasons one locale's `goals` block fails the panel's contract. The ENGLISH block is the
 * reference: every other locale must carry the same top-level keys, the same nested groups and
 * the same interpolation names, with values that are not merely their own key names.
 */
function goalsBlockProblems(bundle: CommonBundle, reference: Record<string, unknown>): string[] {
  const block = bundle.goals;
  if (typeof block !== 'object' || block === null) return ['goals is missing'];

  const problems: string[] = [];
  for (const key of EXPECTED_STRING_KEYS) {
    problems.push(...labelProblems(`goals.${key}`, block[key], reference[key]));
  }
  for (const [group, keys] of Object.entries(NESTED_GROUPS)) {
    const nested = block[group];
    const referenceNested = reference[group];
    if (typeof nested !== 'object' || nested === null) {
      problems.push(`goals.${group} is missing`);
      continue;
    }
    for (const key of keys) {
      problems.push(
        ...labelProblems(
          `goals.${group}.${key}`,
          (nested as Record<string, unknown>)[key],
          (referenceNested as Record<string, unknown>)[key],
        ),
      );
    }
  }
  return problems;
}

const bundleFiles = globSync('*/common.json', { cwd: LOCALES_DIR }).sort();

describe('every locale carries the Goals tab label and panel keys', () => {
  it('covers every language directory on disk (the 12-locale glob, not a sampled subset)', () => {
    const localeDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(bundleFiles).toEqual(localeDirs.map((dir) => `${dir}/common.json`));
    expect(localeDirs.length, `locale directories found: ${JSON.stringify(localeDirs)}`).toBeGreaterThanOrEqual(12);
  });

  it('gives every locale a non-empty tabs.goals that is not the key name itself', () => {
    const offenders: string[] = [];
    for (const file of bundleFiles) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as CommonBundle;
      for (const problem of goalsTabProblems(bundle)) offenders.push(`${file}: ${problem}`);
    }
    expect(offenders).toEqual([]);
  });

  it('rejects a missing, blank or key-copied tab label (positive control)', () => {
    expect(goalsTabProblems({ tabs: {} })).toEqual(['tabs.goals is missing or not a string']);
    expect(goalsTabProblems({ tabs: { goals: '' } })).toEqual(['tabs.goals is an empty string']);
    expect(goalsTabProblems({ tabs: { goals: 'tabs.goals' } })).toEqual([
      'tabs.goals is the raw key name, not a label',
    ]);
    expect(goalsTabProblems({ tabs: { goals: 'Goals' } })).toEqual([]);
  });
});

describe('every locale carries the Goals panel keys', () => {
  const english = JSON.parse(
    readFileSync(join(LOCALES_DIR, 'en', 'common.json'), 'utf8'),
  ) as CommonBundle;
  const reference = english.goals ?? {};

  it('the English bundle declares exactly the keys this panel renders', () => {
    expect(Object.keys(reference).filter((key) => typeof reference[key] === 'string').sort()).toEqual(
      [...EXPECTED_STRING_KEYS].sort(),
    );
    expect(Object.keys(reference).filter((key) => typeof reference[key] === 'object').sort()).toEqual(
      Object.keys(NESTED_GROUPS).sort(),
    );
  });

  it('every locale carries each key with the English placeholders and a real value', () => {
    const offenders: string[] = [];
    for (const file of bundleFiles) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as CommonBundle;
      for (const problem of goalsBlockProblems(bundle, reference)) offenders.push(`${file}: ${problem}`);
    }
    expect(offenders).toEqual([]);
  });

  it('rejects a missing, blank, key-copied, placeholder-dropping or group-dropping block (positive control)', () => {
    expect(goalsBlockProblems({}, reference)).toEqual(['goals is missing']);

    const { title: _omitted, ...withoutTitle } = reference;
    expect(goalsBlockProblems({ goals: withoutTitle }, reference)).toContain('goals.title is missing or not a string');

    expect(goalsBlockProblems({ goals: { ...reference, title: '  ' } }, reference)).toContain(
      'goals.title is an empty string',
    );

    expect(goalsBlockProblems({ goals: { ...reference, emptyBody: 'goals.emptyBody' } }, reference)).toContain(
      'goals.emptyBody is the raw key name, not a label',
    );

    expect(goalsBlockProblems({ goals: { ...reference, acProgress: '{{passing}}' } }, reference)).toContain(
      'goals.acProgress interpolates ["passing"], expected ["passing","total"]',
    );

    const { provider: _provider, ...withoutProvider } = reference;
    expect(goalsBlockProblems({ goals: withoutProvider }, reference)).toContain('goals.provider is missing');
  });
});
