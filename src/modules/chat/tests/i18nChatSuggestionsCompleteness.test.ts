import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'vitest';

/**
 * The reply-suggestions failure notice's copy, in every shipped locale.
 *
 * The notice renders six state lines plus the popover's field/action labels; a
 * locale that silently lacks one of them falls back to English (or to the
 * server's message), which is exactly the kind of half-translated surface this
 * criterion exists to catch. It compares the FLATTENED key set under
 * `input.suggestions.failure` and every `{{placeholder}}` inside each value, so
 * neither a missing translation nor a dropped `{{status}}` placeholder can land.
 *
 * The en file is the reference; the eleven other language directories must match.
 */

const LOCALES_DIR = path.resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');
const REFERENCE = 'en';
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

type Json = Record<string, unknown>;

const readChat = (locale: string): Json => JSON.parse(
  readFileSync(path.join(LOCALES_DIR, locale, 'chat.json'), 'utf8'),
) as Json;

/** The failure copy block, flattened to `path -> value`; a missing object is a red. */
const failureCopy = (locale: string): Map<string, string> => {
  const chat = readChat(locale);
  const input = chat.input as Json | undefined;
  const suggestions = input?.suggestions as Json | undefined;
  const failure = suggestions?.failure as Json | undefined;
  assert.ok(failure && typeof failure === 'object', `${locale}/chat.json must declare input.suggestions.failure`);

  const flat = new Map<string, string>();
  const walk = (value: unknown, prefix: string): void => {
    if (typeof value === 'string') {
      flat.set(prefix, value);
      return;
    }
    assert.ok(value && typeof value === 'object', `${locale}: ${prefix} must be a string or an object`);
    for (const [key, child] of Object.entries(value as Json)) walk(child, prefix === '' ? key : `${prefix}.${key}`);
  };
  walk(failure, '');
  return flat;
};

/** The placeholder names inside one value, sorted so the comparison is order-free. */
const placeholders = (value: string): string[] => [...value.matchAll(PLACEHOLDER)]
  .map((match) => match[1])
  .sort();

describe('reply-suggestions failure copy across locales', () => {
  const locales = ['de', 'en', 'es', 'fr', 'id', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW'];
  const reference = failureCopy(REFERENCE);

  it('(a) all twelve locales are present and the reference block is non-empty', () => {
    assert.equal(locales.length, 12);
    assert.ok(reference.size >= 10, 'the failure copy declares the state lines and the popover labels');
  });

  for (const locale of locales) {
    it(`(b) ${locale} declares exactly the reference key set`, () => {
      assert.deepEqual([...failureCopy(locale).keys()].sort(), [...reference.keys()].sort());
    });

    it(`(c) ${locale} keeps every placeholder of the reference`, () => {
      const copy = failureCopy(locale);
      for (const [key, value] of reference) {
        assert.deepEqual(
          placeholders(copy.get(key) ?? ''),
          placeholders(value),
          `${locale} ${key} must keep the same {{placeholders}}`,
        );
      }
    });

    it(`(d) ${locale} translates every state line (no empty or English-copied title)`, () => {
      const copy = failureCopy(locale);
      for (const [key, value] of copy) {
        assert.ok(value.trim() !== '', `${locale} ${key} must not be empty`);
      }
      if (locale !== REFERENCE) {
        assert.notEqual(copy.get('title'), reference.get('title'), `${locale} title must be translated`);
        assert.notEqual(copy.get('retry'), reference.get('retry'), `${locale} retry label must be translated`);
      }
    });
  }
});
