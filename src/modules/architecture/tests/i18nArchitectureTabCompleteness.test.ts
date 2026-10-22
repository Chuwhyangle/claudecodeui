import { globSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The architecture workspace view is registered as `{ id: 'architecture', labelKey:
 * 'tabs.architecture' }` in WorkspaceTabs and its panel renders from `architecture.…` keys,
 * both through the default `common` namespace. react-i18next renders a missing key verbatim,
 * which is how the Quay tab once shipped showing the literal text `tabs.quay`; the panel's
 * keys all carry a `defaultValue`, so a missing translation silently falls back to English
 * rather than going red anywhere else.
 *
 * This walks the whole `locales/&#42;/common.json` glob rather than a hardcoded language list,
 * so a locale added (or dropped) without the keys cannot pass by going stale, and it does not
 * settle for checking `en` alone. The required keys are extracted from the panel's own
 * `t('architecture.…')` calls and from the tab registration, so adding a new panel string
 * without translating it turns this test red instead of drifting away from a hand-copied list.
 *
 * Resolved from the vitest process cwd (the repo root), the way the other filesystem-reading
 * tests in this repo do it: under vitest's jsdom environment `import.meta.url` is not a
 * file: URL, so `fileURLToPath` rejects it.
 */
const REPO_ROOT = process.cwd();
const LOCALES_DIR = resolve(REPO_ROOT, 'src', 'modules', 'i18n', 'locales');
/**
 * Every architecture source that draws translated chrome. The dock and the
 * inspector were split out of the panel, so their keys must be part of the same
 * completeness reading rather than escaping it by living in a new file.
 */
const ARCHITECTURE_SOURCES = [
  resolve(REPO_ROOT, 'src', 'modules', 'architecture', 'ArchitecturePanel.tsx'),
  resolve(REPO_ROOT, 'src', 'modules', 'architecture', 'ArchitectureDock.tsx'),
  resolve(REPO_ROOT, 'src', 'modules', 'architecture', 'ArchitectureInspector.tsx'),
];
const TABS_SOURCE = resolve(REPO_ROOT, 'src', 'modules', 'project-workspace', 'WorkspaceTabs.tsx');

/** The shape this test reads back out of a locale bundle — deliberately loose. */
type CommonBundle = Record<string, unknown>;

/**
 * Every key the panel asks the translator for, in source order of first appearance. Reading
 * them out of the component (rather than restating them here) is what makes "a panel string
 * shipped without a translation" a failure of this test.
 */
function architectureKeysInPanel(source: string): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(/\bt\(\s*['"](architecture\.[A-Za-z0-9_.]+)['"]/g)) {
    keys.add(match[1]);
  }
  return [...keys].sort();
}

/** The `labelKey` the architecture tab registration passes to the tab renderer. */
function architectureTabLabelKey(source: string): string | null {
  const registration = source.match(/id:\s*'architecture'[\s\S]{0,200}?labelKey:\s*'([^']+)'/);
  return registration?.[1] ?? null;
}

/** Reads a dotted key out of a parsed bundle; `undefined` when any segment is absent. */
function valueAt(bundle: CommonBundle, key: string): unknown {
  return key.split('.').reduce<unknown>((node, segment) => {
    if (node === null || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[segment];
  }, bundle);
}

/**
 * The reasons a bundle fails one key's contract; an empty array means it passes. Returning
 * the reason rather than a boolean is what lets the positive controls below prove the checker
 * can actually go red, instead of the suite merely asserting a constant green.
 */
function keyProblems(bundle: CommonBundle, key: string): string[] {
  const value = valueAt(bundle, key);
  if (typeof value !== 'string') return [`${key} is missing or not a string`];
  if (value.trim().length === 0) return [`${key} is an empty string`];
  if (value === key) return [`${key} is the raw key name, not a label`];
  return [];
}

/** The `{{name}}` placeholders carried by a string, sorted, for cross-locale comparison. */
function placeholdersIn(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]).sort();
}

/** Placeholders the English bundle marks in a key — the ones every translation must keep. */
function expectedPlaceholders(english: CommonBundle, key: string): string[] {
  const value = valueAt(english, key);
  return typeof value === 'string' ? placeholdersIn(value) : [];
}

describe('every locale carries the architecture tab label and panel text', () => {
  const localeDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const bundleFiles = globSync('*/common.json', { cwd: LOCALES_DIR }).sort();

  const panelKeys = [...new Set(
    ARCHITECTURE_SOURCES.flatMap((file) => architectureKeysInPanel(readFileSync(file, 'utf8'))),
  )].sort();
  const tabLabelKey = architectureTabLabelKey(readFileSync(TABS_SOURCE, 'utf8'));

  it('covers every language directory on disk (the 12-locale glob, not a sampled subset)', () => {
    // Two independent enumerations agreeing: readdir for the directories, glob for the
    // bundles. A dropped directory or a truncated glob breaks this equality.
    expect(bundleFiles).toEqual(localeDirs.map((dir) => `${dir}/common.json`));
    expect(localeDirs.length, `locale directories found: ${JSON.stringify(localeDirs)}`).toBeGreaterThanOrEqual(12);
  });

  it('reads the required keys from the tab registration and the panel itself', () => {
    // Guards the extraction: a regex that stopped matching (panel refactor, renamed tab)
    // would otherwise leave the completeness case below checking an empty list.
    expect(tabLabelKey).toBe('tabs.architecture');
    expect(panelKeys.length, `architecture keys found in the panel: ${JSON.stringify(panelKeys)}`).toBeGreaterThanOrEqual(10);
    expect(panelKeys).toContain('architecture.title');
    expect(panelKeys).toContain('architecture.honesty.analysis');
  });

  it('gives every locale the tab label and every panel key, with real values', () => {
    const english = JSON.parse(readFileSync(join(LOCALES_DIR, 'en', 'common.json'), 'utf8')) as CommonBundle;
    const requiredKeys = tabLabelKey === null ? panelKeys : [tabLabelKey, ...panelKeys];
    const offenders: string[] = [];

    for (const file of bundleFiles) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as CommonBundle;
      for (const key of requiredKeys) {
        for (const problem of keyProblems(bundle, key)) {
          offenders.push(`${file}: ${problem}`);
        }
        const value = valueAt(bundle, key);
        if (typeof value !== 'string') continue;
        // A translation that drops `{{count}}` still renders, but silently loses the number.
        const expected = expectedPlaceholders(english, key);
        const actual = placeholdersIn(value);
        if (expected.join(',') !== actual.join(',')) {
          offenders.push(
            `${file}: ${key} carries placeholders {${actual.join(',')}} instead of {${expected.join(',')}}`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  // Positive controls: the same checkers must reject the three ways a bundle can fail — a
  // missing key, a blank / key-copied value, and a translation that dropped its placeholder.
  // If they could not, the case above would be a green that cannot go red.
  it('rejects a bundle with a missing, blank or key-copied value (positive control)', () => {
    expect(keyProblems({ tabs: {} }, 'tabs.architecture')).toEqual([
      'tabs.architecture is missing or not a string',
    ]);
    expect(keyProblems({ tabs: { architecture: '' } }, 'tabs.architecture')).toEqual([
      'tabs.architecture is an empty string',
    ]);
    expect(keyProblems({ tabs: { architecture: 'tabs.architecture' } }, 'tabs.architecture')).toEqual([
      'tabs.architecture is the raw key name, not a label',
    ]);
    expect(keyProblems({ tabs: { architecture: 'Architecture' } }, 'tabs.architecture')).toEqual([]);

    expect(keyProblems({ architecture: {} }, 'architecture.title')).toEqual([
      'architecture.title is missing or not a string',
    ]);
    expect(keyProblems({ architecture: { title: 'Architecture' } }, 'architecture.title')).toEqual([]);
  });

  it('rejects a translation that dropped an interpolation placeholder (positive control)', () => {
    expect(placeholdersIn('{{count}} unresolved seed(s)')).toEqual(['count']);
    expect(placeholdersIn('no number here')).toEqual([]);
    // Same comparison the real loop uses: en says `{{count}}`, the translation does not.
    const english = { architecture: { honesty: { unresolved: '{{count}} unresolved seed(s)' } } };
    expect(expectedPlaceholders(english, 'architecture.honesty.unresolved')).toEqual(['count']);
    expect(placeholdersIn('Semillas sin resolver')).not.toEqual(['count']);
  });

  it('extracts architecture keys from the panel source, not from a hand-copied list (positive control)', () => {
    const source = [
      "t('architecture.title', { defaultValue: 'Architecture' })",
      't("architecture.noSeeds", { defaultValue: \'No seeds\' })',
      "t('architecture.title', { defaultValue: 'again' })",
      "someOtherFunction('architecture.notAPanelKey')",
    ].join('\n');
    expect(architectureKeysInPanel(source)).toEqual(['architecture.noSeeds', 'architecture.title']);
    expect(architectureTabLabelKey("const TAB = {\n  id: 'architecture',\n  labelKey: 'tabs.architecture',\n};")).toBe(
      'tabs.architecture',
    );
    expect(architectureTabLabelKey("const TAB = {\n  id: 'quay',\n  labelKey: 'tabs.quay',\n};")).toBeNull();
  });
});
