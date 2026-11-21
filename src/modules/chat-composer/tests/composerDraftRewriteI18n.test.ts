import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'vitest';

/**
 * The draft-rewrite copy exists in every chat locale the app ships.
 *
 * The language set is READ from `src/modules/i18n/languages.ts`, not restated here: adding a
 * language without the rewrite keys must fail this criterion rather than silently fall back to
 * English at runtime. Each key must be present and non-blank in that locale's `chat.json`.
 *
 * The file is parsed rather than imported because the i18n module's public barrel does not carry
 * `languages`, and a deep import from another module is forbidden by the frontend boundary rule.
 */

const REQUIRED_KEYS = [
  'input.draftRewrite.chip',
  'input.draftRewrite.panelLabel',
  'input.draftRewrite.apply',
  'input.draftRewrite.retry',
  'input.draftRewrite.loading',
  'input.draftRewrite.failed',
] as const;

const repoRoot = process.cwd();

/** Reads the declared language codes from `src/modules/i18n/languages.ts`. */
function readDeclaredLanguages(): string[] {
  const file = path.join(repoRoot, 'src', 'modules', 'i18n', 'languages.ts');
  const source = readFileSync(file, 'utf8');
  const values = [...source.matchAll(/value:\s*'([^']+)'/g)].map((match) => match[1]);
  assert.ok(values.length > 0, 'languages.ts must declare at least one language');
  return [...new Set(values)];
}

const languages = readDeclaredLanguages();

function readChatResource(language: string): Record<string, unknown> {
  const file = path.join(repoRoot, 'src', 'modules', 'i18n', 'locales', language, 'chat.json');
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function readKey(resource: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, segment) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    return (node as Record<string, unknown>)[segment];
  }, resource);
}

describe('draft rewrite i18n', () => {
  it('the language set is read from languages.ts and is non-empty', () => {
    assert.ok(Array.isArray(languages));
    assert.ok(languages.length > 0);
    for (const language of languages) {
      assert.ok(typeof language === 'string' && language !== '');
    }
  });

  it('every shipped language carries every rewrite key, non-blank', () => {
    for (const language of languages) {
      const resource = readChatResource(language);
      for (const key of REQUIRED_KEYS) {
        const value = readKey(resource, key);
        assert.equal(typeof value, 'string', `${language}: ${key} must be a string`);
        assert.ok((value as string).trim() !== '', `${language}: ${key} must be non-blank`);
      }
    }
  });

  it('the chip copy is stable across languages (the ✦ marker is part of the affordance)', () => {
    for (const language of languages) {
      const chip = readKey(readChatResource(language), 'input.draftRewrite.chip');
      assert.ok(typeof chip === 'string' && chip.includes('✦'), `${language}: chip must carry ✦`);
    }
  });

  it('the set the criterion covers is exactly the ten-plus chat locales the repo declares', () => {
    // Guards against a vacuous pass if languages.ts were ever emptied/renamed to a single entry.
    assert.ok(languages.length >= 12, `expected the full language set, read ${languages.length}`);
    for (const expected of ['de', 'en', 'es', 'fr', 'id', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW']) {
      assert.ok(languages.includes(expected), `languages.ts must include ${expected}`);
    }
  });
});
