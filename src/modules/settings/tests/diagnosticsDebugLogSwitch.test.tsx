import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { DiagnosticsApi } from '@/modules/diagnostics';
import DiagnosticsSettingsTab, {
  type ReplySuggestionsDebugLogApi,
} from '@/modules/settings/tabs/DiagnosticsSettingsTab';
import type { DiagnosticsFeature } from '@/shared/types';

/**
 * Settings → Diagnostics → the OPT-IN reply-suggestions debug-ledger switch.
 *
 * WHAT IT PINS. The switch starts OFF and settles from `/status`; one press writes
 * `{ enabled: true }`; while the write is in flight the control is disabled; a refused write
 * rolls the drawn value back and shows an error; the description is linked by
 * `aria-describedby`; the inline warning names the exact behaviour and the fixed local path;
 * there is NO clear-log action and NO confirmation dialog. The same file also checks that every
 * one of the 12 locales carries the new keys non-empty.
 */

const LOCALES = ['de', 'en', 'es', 'fr', 'id', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW'] as const;

function localeSettings(locale: string): Record<string, any> {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), 'src', 'modules', 'i18n', 'locales', locale, 'settings.json'), 'utf8'),
  ) as Record<string, any>;
}

const ZH = localeSettings('zh-CN');

vi.mock('react-i18next', async (importOriginal) => {
  // Resolve keys against the zh-CN settings bundle so the rendered copy is the real Chinese
  // warning the criterion asserts, not a key echo.
  const lookup = (key: string): string => {
    const value = key.split('.').reduce<any>((node, part) => (node == null ? undefined : node[part]), ZH);
    return typeof value === 'string' ? value : key;
  };
  return {
    ...(await importOriginal() as object),
    useTranslation: () => ({ t: lookup }),
  };
});

const FEATURE: DiagnosticsFeature = {
  id: 'reply-suggestions',
  label: 'Reply suggestions',
  state: 'ready',
  enabled: true,
  problems: [],
  lastSuccessAt: null,
  lastFailure: null,
  configSource: 'file:/tmp/settings.json',
};

function diagnosticsApi(): DiagnosticsApi {
  return {
    features: async () => ({ features: [FEATURE] }),
    recentFailures: async () => ({ failures: [] }),
    bundle: async () => 'bundle',
  };
}

type DebugHarness = {
  api: ReplySuggestionsDebugLogApi;
  calls: boolean[];
  resolveNext: (value: boolean) => void;
  rejectNext: (reason: unknown) => void;
};

function debugApi(initial: boolean, options: { failLoad?: boolean } = {}): DebugHarness {
  const calls: boolean[] = [];
  let pending: { resolve: (value: boolean) => void; reject: (reason: unknown) => void } | null = null;
  const api: ReplySuggestionsDebugLogApi = {
    status: async () => {
      if (options.failLoad === true) throw new Error('status down');
      return { debugLog: initial };
    },
    setDebugLog: (enabled) => {
      calls.push(enabled);
      return new Promise<boolean>((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
  };
  return {
    api,
    calls,
    resolveNext(value) {
      assert.ok(pending, 'a write must be in flight');
      pending.resolve(value);
      pending = null;
    },
    rejectNext(reason) {
      assert.ok(pending, 'a write must be in flight');
      pending.reject(reason);
      pending = null;
    },
  };
}

function renderTab(harness: DebugHarness) {
  return render(
    <DiagnosticsSettingsTab
      api={diagnosticsApi()}
      writeClipboard={async () => {}}
      replySuggestionsApi={harness.api}
    />,
  );
}

const LABEL = ZH.diagnostics.debugLog.label as string;
const DESCRIPTION = ZH.diagnostics.debugLog.description as string;

test('(a) the switch starts OFF and settles from /status', async () => {
  const harness = debugApi(false);
  const view = renderTab(harness);

  const toggle = await view.findByRole('switch', { name: LABEL });
  await waitFor(() => assert.equal(toggle.hasAttribute('disabled'), false));
  assert.equal(toggle.getAttribute('aria-checked'), 'false', 'the shipped default is off');
});

test('(b) one press writes { enabled: true } and shows the persisted value', async () => {
  const harness = debugApi(false);
  const view = renderTab(harness);
  const toggle = await view.findByRole('switch', { name: LABEL });
  await waitFor(() => assert.equal(toggle.hasAttribute('disabled'), false));

  fireEvent.click(toggle);
  assert.deepEqual(harness.calls, [true], 'exactly one PUT with enabled:true');
  assert.equal(toggle.hasAttribute('disabled'), true, 'the control is disabled while saving');

  harness.resolveNext(true);
  await waitFor(() => assert.equal(toggle.getAttribute('aria-checked'), 'true'));
  assert.equal(toggle.hasAttribute('disabled'), false);
});

test('(c) a refused write rolls back to the previous value and shows an error', async () => {
  const harness = debugApi(false);
  const view = renderTab(harness);
  const toggle = await view.findByRole('switch', { name: LABEL });
  await waitFor(() => assert.equal(toggle.hasAttribute('disabled'), false));

  fireEvent.click(toggle);
  harness.rejectNext(new Error('HTTP 500'));

  await waitFor(() => {
    assert.equal(toggle.getAttribute('aria-checked'), 'false', 'the drawn value returns to the previous one');
    assert.ok(view.getByText(ZH.diagnostics.debugLog.saveFailed as string), 'the error is visible');
  });
  assert.equal(toggle.hasAttribute('disabled'), false, 'the control is usable again');
});

test('(d) the accessible name and the description are wired with aria-describedby', async () => {
  const harness = debugApi(false);
  const view = renderTab(harness);
  const toggle = await view.findByRole('switch', { name: LABEL });

  const describedBy = toggle.getAttribute('aria-describedby');
  assert.ok(describedBy !== null && describedBy !== '', 'the switch names its description');
  const description = view.container.querySelector(`#${describedBy}`);
  assert.ok(description instanceof HTMLElement, 'the linked element exists');
  assert.ok(description.textContent?.includes(DESCRIPTION), 'the linked text is the explanation');
});

test('(e) the inline warning names the behaviour and the fixed path; no clear action, no dialog', async () => {
  const harness = debugApi(false);
  const view = renderTab(harness);
  await view.findByRole('switch', { name: LABEL });

  const section = view.container.querySelector('[data-slot="diagnostics-debug-log"]');
  assert.ok(section instanceof HTMLElement);
  const text = section.textContent ?? '';
  assert.ok(text.includes(DESCRIPTION), 'the warning sentence is drawn');
  assert.ok(text.includes('~/.cloudpit/reply-suggestions-debug.jsonl'), 'the fixed path is drawn');
  assert.ok(
    (ZH.diagnostics.debugLog.description as string).includes('开启后会把当前草稿、最近对话上下文与候选原文写入本机日志'),
    'the Chinese warning states exactly what is written',
  );

  // No clear-log action anywhere in the section (rotation is the only retention policy).
  assert.equal(
    Array.from(section.querySelectorAll('button')).filter((button) => /清空|clear/i.test(button.textContent ?? '')).length,
    0,
  );

  // Turning it on is a single press: no confirmation dialog is opened.
  fireEvent.click(await view.findByRole('switch', { name: LABEL }));
  assert.equal(view.queryByRole('dialog'), null, 'no confirmation dialog');
});

test('(f) every locale carries the new debugLog keys, non-empty', () => {
  const keys = ['title', 'description', 'label', 'saveFailed'] as const;
  for (const locale of LOCALES) {
    const block = localeSettings(locale).diagnostics?.debugLog;
    assert.ok(block !== undefined, `${locale} declares diagnostics.debugLog`);
    for (const key of keys) {
      assert.equal(typeof block[key], 'string', `${locale} ${key} is a string`);
      assert.ok((block[key] as string).trim() !== '', `${locale} ${key} is non-empty`);
    }
  }
  cleanup();
});
