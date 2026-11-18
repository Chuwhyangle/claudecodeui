import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'vitest';

/**
 * The Settings → Diagnostics tab's copy, in every shipped locale.
 *
 * react-i18next renders a missing key verbatim, so a half-translated bundle
 * ships the literal text `diagnostics.featuresTitle` to the user. The required
 * key list below is the LIVE contract (every `diagnostics.*` key the diagnostics
 * module and the Settings tab read) and is kept as an independent literal rather
 * than derived from `en`, so a key dropped from all twelve still reds. The test
 * walks the whole `locales/*\/settings.json` glob, so an added or removed
 * language cannot pass by going stale.
 *
 * Resolved from the vitest process cwd (the repo root): under vitest's jsdom
 * environment `import.meta.url` is not a `file:` URL.
 */

const LOCALES_DIR = path.resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');
const REFERENCE = 'en';
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Every `diagnostics.*` leaf the tab and the diagnostics module render. */
const REQUIRED_DIAGNOSTICS_KEYS = [
  'title',
  'description',
  'refresh',
  'loading',
  'error',
  'retry',
  'featuresTitle',
  'featuresEmpty',
  'features.replySuggestions',
  'state.off',
  'state.misconfigured',
  'state.ready',
  'state.degraded',
  'state.ok',
  'enabled',
  'disabled',
  'configLabel',
  'defaultSource',
  'lastSuccessLabel',
  'lastFailureLabel',
  'never',
  'none',
  'problemsLabel',
  'failuresTitle',
  'failuresEmpty',
  'viewRecentFailures',
  'table.time',
  'table.feature',
  'table.category',
  'table.httpStatus',
  'table.duration',
  'table.requestId',
  'copy.button',
  'copy.copying',
  'copy.copied',
  'copy.failed',
  'copy.hint',
] as const;

type Namespace = Record<string, unknown>;
type SettingsBundle = { diagnostics?: Namespace; mainTabs?: Namespace };

/** Reads a dotted path; undefined on a missing hop. */
function readPath(namespace: Namespace, dotted: string): unknown {
  let node: unknown = namespace;
  for (const part of dotted.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Every leaf key of a namespace, dotted. */
function flattenKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return prefix.length > 0 ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenKeys(child, prefix.length > 0 ? `${prefix}.${key}` : key),
  );
}

/** The reasons a bundle fails the contract; `[]` means it passes. */
function diagnosticsProblems(namespace: Namespace | undefined): string[] {
  const problems: string[] = [];
  const source = namespace ?? {};
  for (const key of REQUIRED_DIAGNOSTICS_KEYS) {
    const value = readPath(source, key);
    if (value === undefined) {
      problems.push(`${key} is missing`);
      continue;
    }
    if (typeof value !== 'string') {
      problems.push(`${key} is not a string`);
      continue;
    }
    if (value.trim().length === 0) {
      problems.push(`${key} is an empty string`);
      continue;
    }
    const leaf = key.slice(key.lastIndexOf('.') + 1);
    if (value === leaf || value === key || value === `diagnostics.${key}`) {
      problems.push(`${key} is the raw key name, not a label`);
    }
  }
  return problems;
}

/** The placeholder names inside one value, sorted. */
function placeholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)].map((match) => match[1]).sort();
}

function readBundle(file: string): SettingsBundle {
  return JSON.parse(readFileSync(path.join(LOCALES_DIR, file), 'utf8')) as SettingsBundle;
}

describe('every locale carries a complete diagnostics namespace', () => {
  const bundleFiles = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${entry.name}/settings.json`)
    .sort();

  it('covers all twelve languages and both required namespaces are non-empty', () => {
    console.log(`[AC5] settings bundles (${bundleFiles.length}): ${JSON.stringify(bundleFiles)}`);
    assert.ok(bundleFiles.length >= 12, `expected at least twelve locales, found ${bundleFiles.length}`);
    for (const file of bundleFiles) {
      const bundle = readBundle(file);
      assert.ok(bundle.diagnostics, `${file} must declare a diagnostics namespace`);
      const tabLabel = bundle.mainTabs?.diagnostics;
      assert.equal(typeof tabLabel, 'string', `${file} must declare mainTabs.diagnostics`);
      assert.ok(String(tabLabel).trim().length > 0);
    }
  });

  it('gives every locale every required diagnostics key, non-empty and not the key name', () => {
    const offenders: string[] = [];
    for (const file of bundleFiles) {
      const bundle = readBundle(file);
      for (const problem of diagnosticsProblems(bundle.diagnostics)) offenders.push(`${file}: ${problem}`);
    }
    console.log(`[AC5] key offenders (${offenders.length}): ${JSON.stringify(offenders)}`);
    assert.deepEqual(offenders, []);
  });

  it('gives every locale exactly the same diagnostics key set as en, with the same placeholders', () => {
    const reference = readBundle(`${REFERENCE}/settings.json`);
    const referenceNamespace = reference.diagnostics ?? {};
    const referenceKeys = new Set(flattenKeys(referenceNamespace));

    const diffs: Record<string, { missing: string[]; extra: string[] }> = {};
    for (const file of bundleFiles) {
      const bundle = readBundle(file);
      const keys = new Set(flattenKeys(bundle.diagnostics));
      diffs[file] = {
        missing: [...referenceKeys].filter((key) => !keys.has(key)).sort(),
        extra: [...keys].filter((key) => !referenceKeys.has(key)).sort(),
      };
    }
    console.log(`[AC5] per-locale key-set diffs vs ${REFERENCE}: ${JSON.stringify(diffs)}`);
    for (const file of bundleFiles) {
      assert.deepEqual(diffs[file], { missing: [], extra: [] }, `${file} key set vs ${REFERENCE}`);
    }

    for (const file of bundleFiles) {
      const bundle = readBundle(file);
      for (const key of REQUIRED_DIAGNOSTICS_KEYS) {
        const referenceValue = readPath(referenceNamespace, key);
        const value = readPath(bundle.diagnostics ?? {}, key);
        assert.deepEqual(
          placeholders(String(value)),
          placeholders(String(referenceValue)),
          `${file} ${key} must keep the same {{placeholders}}`,
        );
      }
    }
  });

  // Positive control: the checker must reject a missing, blank or key-copied label,
  // otherwise the green above cannot go red.
  it('rejects a bundle with a missing, blank or key-copied label (positive control)', () => {
    assert.deepEqual(
      diagnosticsProblems({}),
      REQUIRED_DIAGNOSTICS_KEYS.map((key) => `${key} is missing`),
    );

    const complete: Namespace = {};
    for (const key of REQUIRED_DIAGNOSTICS_KEYS) {
      const parts = key.split('.');
      const leaf = parts.pop() as string;
      let node = complete;
      for (const part of parts) {
        if (node[part] === undefined || typeof node[part] !== 'object') node[part] = {};
        node = node[part] as Namespace;
      }
      node[leaf] = `translated text for ${key}`;
    }
    assert.deepEqual(diagnosticsProblems(complete), []);

    const missingOne = { ...complete };
    delete (missingOne as Record<string, unknown>).retry;
    assert.deepEqual(diagnosticsProblems(missingOne), ['retry is missing']);

    const blank = { ...complete, retry: '   ' };
    assert.deepEqual(diagnosticsProblems(blank), ['retry is an empty string']);

    const copied = { ...complete, title: 'title' };
    assert.deepEqual(diagnosticsProblems(copied), ['title is the raw key name, not a label']);
  });
});
