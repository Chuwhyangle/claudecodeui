import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The sidebar NC-lease row's translation completeness criterion.
 *
 * A missing key renders as the raw key name, which is how a sidebar row ships
 * showing `ncLease.busy`. This walks the whole `locales/&#42;/common.json` glob
 * (rather than a hand-copied language list), reads the `ncLease.*` keys the
 * indicator actually asks for, and requires every locale to carry the same
 * non-empty key set with the same placeholders — and that English declares
 * nothing the component never renders.
 *
 * Resolved from the vitest process cwd (the repo root), the way the other
 * filesystem-reading criteria in this repo do it.
 */
const REPO_ROOT = process.cwd();
const LOCALES_DIR = resolve(REPO_ROOT, 'src', 'modules', 'i18n', 'locales');

/** The one source that draws the NC-lease row and its panel. */
const SOURCES = [resolve(REPO_ROOT, 'src', 'modules', 'nclease', 'NcLeaseIndicator.tsx')];

type Bundle = Record<string, unknown>;

/** Every `ncLease.*` literal in a source. */
function ncLeaseKeysIn(source: string): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(/['"](ncLease\.[A-Za-z0-9_.]+)['"]/g)) keys.add(match[1]);
  return [...keys].sort();
}

/** Flattens the `ncLease` subtree to dotted leaves; a nested object contributes its leaves. */
function flattenNcLease(bundle: Bundle, prefix = 'ncLease'): Map<string, string> {
  const node = prefix === 'ncLease' ? bundle.ncLease : bundle;
  const leaves = new Map<string, string>();
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return leaves;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = `${prefix}.${key}`;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nested, nestedValue] of flattenNcLease(value as Bundle, path)) {
        leaves.set(nested, nestedValue);
      }
      continue;
    }
    leaves.set(path, typeof value === 'string' ? value : '');
  }
  return leaves;
}

/** The `{{name}}` placeholders a string carries, sorted. */
function placeholdersIn(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]).sort();
}

/** The reasons one locale fails the contract; empty means it passes. */
function bundleProblems(required: Map<string, string>, actual: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [key, english] of required) {
    const value = actual.get(key);
    if (value === undefined) {
      problems.push(`${key} is missing`);
      continue;
    }
    if (value.trim() === '') problems.push(`${key} is empty`);
    const expected = placeholdersIn(english);
    const got = placeholdersIn(value);
    if (expected.join(',') !== got.join(',')) {
      problems.push(`${key} placeholders ${JSON.stringify(got)} != ${JSON.stringify(expected)}`);
    }
  }
  for (const key of actual.keys()) {
    if (!required.has(key)) problems.push(`${key} is not used by the indicator`);
  }
  return problems;
}

describe('every locale carries the NC-lease sidebar keys', () => {
  const localeDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const bundles = new Map(localeDirs.map((locale) => [
    locale,
    JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'common.json'), 'utf8')) as Bundle,
  ]));
  const english = flattenNcLease(bundles.get('en') as Bundle);

  const sourceKeys = [...new Set(SOURCES.flatMap((file) => ncLeaseKeysIn(readFileSync(file, 'utf8'))))].sort();

  it('reads the keys the indicator actually uses', () => {
    expect(sourceKeys.length).toBeGreaterThan(10);
    for (const key of sourceKeys) expect(english.has(key), key).toBe(true);
    // Every leaf in the English bundle must be one of those keys: a translated
    // string nothing renders is the same drift in the other direction.
    expect([...english.keys()].sort()).toEqual(sourceKeys);
  });

  it('has 12 locales and every one carries the identical, non-empty key set', () => {
    expect(localeDirs.length).toBe(12);
    for (const locale of localeDirs) {
      const problems = bundleProblems(english, flattenNcLease(bundles.get(locale) as Bundle));
      expect(problems, `${locale}: ${problems.join('; ')}`).toEqual([]);
    }
  });

  it('negative control: the checker reports a dropped key and a lost placeholder', () => {
    const broken = new Map(english);
    broken.delete('ncLease.busy');
    broken.set('ncLease.codeBehind', 'Code behind pre');
    const problems = bundleProblems(english, broken);
    expect(problems).toContain('ncLease.busy is missing');
    expect(problems.some((problem) => problem.includes('ncLease.codeBehind placeholders'))).toBe(true);
  });
});
