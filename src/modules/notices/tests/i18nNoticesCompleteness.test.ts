import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The notices surfaces render every visible string through `react-i18next` (`title` and
 * `primaryAction.labelKey` arrive from the server as i18n KEYS), so each of the 12 shipped
 * locale bundles has to carry the `notices` block. react-i18next renders a missing key verbatim —
 * the failure mode the Quay tab once shipped — so this walks the whole `locales/<lang>/common.json`
 * glob and checks interpolation placeholders too: `{{n}}` dropped in one language is a silently
 * mangled sentence, not a missing key.
 *
 * Resolved from the vitest process cwd (the repo root), the way the other filesystem-reading
 * tests in this repo do it: under jsdom `import.meta.url` is not a file: URL.
 */
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');

type CommonBundle = {
  notices?: Record<string, unknown>;
};

/** The `{{name}}` placeholders a translated sentence must keep, sorted for a stable comparison. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]!).sort();
}

/** The block's string leaves by dotted key, so a nested `deploy.pendingBuild.title` can be
 * compared with the server's dotted i18n key. */
function flatten(block: Record<string, unknown> | undefined, prefix = ''): Record<string, string> {
  const flat: Record<string, string> = {};
  if (block === undefined) return flat;
  for (const [key, value] of Object.entries(block)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') {
      flat[path] = value;
    } else if (value !== null && typeof value === 'object') {
      Object.assign(flat, flatten(value as Record<string, unknown>, path));
    }
  }
  return flat;
}

/**
 * Why one locale's `notices` block fails the contract against the English reference; an empty
 * array means it passes. Returning reasons (not a boolean) is what lets the positive control
 * below prove the checker can actually go red.
 */
function noticesProblems(
  block: Record<string, unknown> | undefined,
  reference: Record<string, string>,
): string[] {
  if (block === undefined) {
    return ['notices block is missing'];
  }

  const translated = flatten(block);
  const problems: string[] = [];

  for (const [key, referenceValue] of Object.entries(reference)) {
    const value = translated[key];
    if (value === undefined) {
      problems.push(`notices.${key} is missing or not a string`);
      continue;
    }
    if (value.trim().length === 0) {
      problems.push(`notices.${key} is an empty string`);
      continue;
    }
    if (value === key) {
      problems.push(`notices.${key} is the raw key name, not a label`);
      continue;
    }
    if (placeholders(value).join(',') !== placeholders(referenceValue).join(',')) {
      problems.push(`notices.${key} changes the placeholders of the English sentence`);
    }
  }

  for (const key of Object.keys(translated)) {
    if (!(key in reference)) {
      problems.push(`notices.${key} is not present in English`);
    }
  }

  return problems;
}

describe('every locale carries the notices copy', () => {
  const localeDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const bundleFiles = localeDirs.map((dir) => `${dir}/common.json`);

  const readBundle = (file: string): CommonBundle =>
    JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as CommonBundle;

  const reference = flatten(readBundle('en/common.json').notices);

  it('covers every language directory on disk (the 12-locale set, not a sampled subset)', () => {
    expect(bundleFiles).toEqual(localeDirs.map((dir) => `${dir}/common.json`));
    expect(localeDirs.length, `locale directories found: ${JSON.stringify(localeDirs)}`).toBeGreaterThanOrEqual(12);
  });

  it('names the keys the slot and the server-provided notice titles resolve', () => {
    const required = [
      'dismiss',
      'more',
      'inboxTitle',
      'dismissedGroup',
      'deploy.pendingBuild.title',
      'deploy.pendingBuild.action',
      'deploy.failed.title',
    ];
    for (const key of required) {
      expect(typeof reference[key], `notices.${key}`).toBe('string');
      expect(reference[key]!.trim().length, `notices.${key}`).toBeGreaterThan(0);
    }
    // The fold count is the one placeholder the client owns; the server-provided titles carry
    // none (their `params` may grow without changing the sentences).
    expect(placeholders(reference.more!)).toEqual(['n']);
  });

  it('gives every locale a complete, translated notices block with the same placeholders', () => {
    const offenders: string[] = [];
    for (const file of bundleFiles) {
      for (const problem of noticesProblems(readBundle(file).notices, reference)) {
        offenders.push(`${file}: ${problem}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  // Positive control: the same checker must reject a missing block, a blank value, a key-copied
  // value, a dropped placeholder and an extra key. Without this the green above could not go red.
  it('rejects a missing, blank, key-copied or placeholder-dropping block (positive control)', () => {
    const sample = { dismiss: 'Dismiss', more: '{{n}} more' };

    expect(noticesProblems(undefined, sample)).toContain('notices block is missing');
    expect(noticesProblems({ dismiss: '  ', more: '{{n}} more' }, sample)).toContain(
      'notices.dismiss is an empty string',
    );
    expect(noticesProblems({ dismiss: 'dismiss', more: '{{n}} more' }, sample)).toContain(
      'notices.dismiss is the raw key name, not a label',
    );
    expect(noticesProblems({ dismiss: 'Dismiss', more: 'x' }, sample)).toContain(
      'notices.more changes the placeholders of the English sentence',
    );
    expect(noticesProblems({ dismiss: 'Dismiss', more: '{{n}} more', extra: 'x' }, sample)).toContain(
      'notices.extra is not present in English',
    );
  });
});
