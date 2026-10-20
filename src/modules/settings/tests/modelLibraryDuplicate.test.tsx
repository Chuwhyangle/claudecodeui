import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import ModelLibraryPanel from '@/shared/ui/ModelLibraryPanel';
import type {
  CustomProviderModelInput,
  LLMProvider,
  ProviderModelActions,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types';

/**
 * The copy entry of the model library: the form it pre-fills, the request it
 * submits, and what cancelling it leaves behind.
 *
 * The panel is rendered directly rather than through ModelsContent, because the
 * actions are a prop — so a submission is observable as the arguments of one
 * call, with no HTTP layer to stand in for. It is imported from `shared` because
 * both chat and settings render it, and the two feature modules may not import
 * each other.
 *
 * react-i18next is mocked with the shipped English copy instead of echoing keys,
 * so the pre-filled name is asserted as the user actually sees it and a key the
 * locale file is missing fails the test as a bare key rather than passing.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const [enCommon, enSettings, enChat] = await Promise.all([
    import('@/modules/i18n/locales/en/common.json'),
    import('@/modules/i18n/locales/en/settings.json'),
    import('@/modules/i18n/locales/en/chat.json'),
  ]);
  const tables: Record<string, unknown> = {
    common: enCommon.default,
    settings: enSettings.default,
    chat: enChat.default,
  };
  const resolve = (namespace: string, key: string, options?: Record<string, unknown>): string => {
    // `ns:path` overrides the namespace the hook was called with, and `{{name}}`
    // placeholders interpolate; anything unresolved stays the raw key on screen.
    const [head, ...rest] = key.split(':');
    const scoped = rest.length > 0 ? head : namespace;
    const path = (rest.length > 0 ? rest.join(':') : key).split('.');
    let value: unknown = tables[scoped];
    for (const segment of path) {
      value = (value as Record<string, unknown> | undefined)?.[segment];
    }
    return typeof value === 'string'
      ? value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
      : key;
  };
  return {
    ...(await importOriginal() as object),
    useTranslation: (namespace = 'common') => ({
      t: (key: string, options?: Record<string, unknown>) => resolve(namespace, key, options),
    }),
  };
});

const SOURCE_CONFIG = {
  env: [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value' as const, value: 'https://gw.example' },
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret' as const, isSet: true as const },
    { key: 'ANTHROPIC_API_KEY', kind: 'unset' as const },
  ],
};

const catalogWith = (options: ProviderModelsDefinition['OPTIONS']): ProviderModelsDefinition => ({
  OPTIONS: [{ value: 'builtin-one', label: 'Built-in One', isCustom: false }, ...options],
  DEFAULT: 'builtin-one',
});

const SOURCE: ProviderModelOption = {
  value: 'gw-model',
  label: 'Gateway Model',
  recordId: 7,
  isCustom: true,
  config: SOURCE_CONFIG,
};

type Actions = ProviderModelActions & {
  create: ReturnType<typeof vi.fn>;
  duplicate: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

const createActions = (): Actions => ({
  create: vi.fn(async () => {}),
  duplicate: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
} as unknown as Actions);

const renderPanel = (options: ProviderModelsDefinition['OPTIONS'], actions: Actions = createActions()) => ({
  actions,
  ...render(
    <ModelLibraryPanel
      initialProvider={'claude' as LLMProvider}
      providerModelCatalog={{ claude: catalogWith(options) }}
      actions={actions}
      hideProviderTabs
    />,
  ),
});

const duplicateSource = (view: ReturnType<typeof render>, label = SOURCE.label) => (
  fireEvent.click(view.getByLabelText(`Duplicate ${label}`))
);

// `queryAll`: the empty-env states below assert on zero rows, which `getAll` reports as a failure.
const envRows = (view: ReturnType<typeof render>) => view.queryAllByTestId('model-env-row');

beforeEach(() => {
  vi.clearAllMocks();
});

test('the copy state pre-fills the name, a free id and the source env rows', async () => {
  const view = renderPanel([SOURCE]);
  duplicateSource(view);

  assert.equal((view.getByLabelText('Model name') as HTMLInputElement).value, 'Gateway Model (copy)');
  assert.equal((view.getByLabelText('Model ID') as HTMLInputElement).value, 'gw-model-copy');
  assert.equal(view.getByText('Copy custom model').textContent, 'Copy custom model');

  // The same rows the source holds, in the same order — including the secret,
  // which reads back as "already set" rather than as a value.
  const rows = envRows(view);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => (row.querySelector('input') as HTMLInputElement).value),
    ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  );
  assert.equal(view.getAllByTestId('secret-set-badge').length, 1);
  assert.equal((view.getByLabelText('Secret value') as HTMLInputElement).value, '');
});

test('submitting the copy sends the rows the form holds, the blank secret without a value', async () => {
  const view = renderPanel([SOURCE]);
  duplicateSource(view);
  fireEvent.change(view.getByLabelText('Model ID'), { target: { value: 'gw-model-alt' } });

  await act(async () => {
    fireEvent.click(view.getByText('Create copy'));
  });

  assert.equal(view.actions.create.mock.calls.length, 0);
  const [provider, source, body] = view.actions.duplicate.mock.calls[0] as [
    LLMProvider,
    ProviderModelOption,
    CustomProviderModelInput,
  ];
  assert.equal(provider, 'claude');
  assert.equal(source.recordId, 7);
  assert.deepEqual(body, {
    model: 'Gateway Model (copy)',
    id: 'gw-model-alt',
    config: { env: [
      { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://gw.example' },
      { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret' },
      { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
    ] },
  });
  // `isSet` is a read-side flag; a request that carried it would be rejected.
  assert.equal(JSON.stringify(body).includes('isSet'), false);
  assert.equal(view.getByText('Gateway Model was copied to Gateway Model (copy).').textContent,
    'Gateway Model was copied to Gateway Model (copy).');
});

test('cancelling the copy clears the copy state and everything it pre-filled', async () => {
  const view = renderPanel([SOURCE]);
  duplicateSource(view);
  assert.equal(envRows(view).length, 3);

  fireEvent.click(view.getByLabelText('Cancel editing'));

  assert.equal((view.getByLabelText('Model name') as HTMLInputElement).value, '');
  assert.equal((view.getByLabelText('Model ID') as HTMLInputElement).value, '');
  assert.equal(envRows(view).length, 0);
  assert.equal(view.getByText('Add a custom model').textContent, 'Add a custom model');
  assert.equal(view.getByText('Add model').textContent, 'Add model');
  assert.equal(view.queryByText('Copy custom model'), null);

  // Back to a plain add: the submit must not reach the duplicate action.
  fireEvent.change(view.getByLabelText('Model name'), { target: { value: 'Fresh' } });
  fireEvent.change(view.getByLabelText('Model ID'), { target: { value: 'fresh' } });
  await act(async () => {
    fireEvent.click(view.getByText('Add model'));
  });
  assert.equal(view.actions.duplicate.mock.calls.length, 0);
  assert.equal(view.actions.create.mock.calls.length, 1);
});

test('the suggested id steps past ids that are already taken and stays within the limit', () => {
  const taken = renderPanel([
    SOURCE,
    { value: 'gw-model-copy', label: 'First Copy', recordId: 8, isCustom: true },
  ]);
  duplicateSource(taken);
  assert.equal((taken.getByLabelText('Model ID') as HTMLInputElement).value, 'gw-model-copy-2');
  // The form fields are addressed by `id`, so a second mounted panel would
  // answer for the first one's inputs.
  taken.unmount();

  // A source id already at the server's 200-character limit still yields a
  // sendable suggestion: the base is truncated rather than the suffix dropped.
  const longest = 'g'.repeat(200);
  const long = renderPanel([{ value: longest, label: 'Longest', recordId: 9, isCustom: true }]);
  duplicateSource(long, 'Longest');
  const suggested = (long.getByLabelText('Model ID') as HTMLInputElement).value;
  assert.equal(suggested.endsWith('-copy'), true);
  assert.equal(suggested.length, 200);
});

test('an id the catalog already holds is refused before the request leaves the panel', async () => {
  const view = renderPanel([SOURCE]);
  duplicateSource(view);
  // 'builtin-one' comes from the provider catalog, not from `provider_models`,
  // so only a panel that checks both sets can refuse it here.
  fireEvent.change(view.getByLabelText('Model ID'), { target: { value: 'builtin-one' } });

  await act(async () => {
    fireEvent.click(view.getByText('Create copy'));
  });

  assert.equal(view.actions.duplicate.mock.calls.length, 0);
  assert.equal(
    view.getByRole('alert').textContent,
    'A model with the ID builtin-one already exists. Choose another ID.',
  );
});
