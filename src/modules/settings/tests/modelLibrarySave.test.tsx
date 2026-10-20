import assert from 'node:assert/strict';

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import ModelsContent from '@/modules/settings/tabs/agents-settings/sections/content/ModelsContent';

/** AC-026: saving a model never submits an unedited secret value nor overwrites fields the form did not edit. */

const providers = vi.hoisted(() => ({
  models: vi.fn(),
  modelEnvStatus: vi.fn(),
  createModel: vi.fn(),
  updateModel: vi.fn(),
  deleteModel: vi.fn(),
}));
vi.mock('@/shared/api', () => ({ api: { providers }, authenticatedFetch: vi.fn() }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useTranslation: () => ({ t: (key: string, options?: { name?: string }) => (options?.name ? `${key}:${options.name}` : key) }),
}));

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => data });
const catalog = {
  OPTIONS: [{
    value: 'gw-model', label: 'Gateway Model', recordId: 7, isCustom: true,
    config: { env: [
      { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', isSet: true },
      { key: 'FOO', kind: 'value', value: 'bar' },
    ] },
  }],
  DEFAULT: 'x',
};

beforeEach(() => {
  Object.values(providers).forEach((mock) => mock.mockReset());
  providers.models.mockImplementation(() => ok({ success: true, data: { models: catalog } }));
  providers.modelEnvStatus.mockImplementation(() => ok({ success: true, data: { status: {} } }));
  providers.createModel.mockImplementation(() => ok({ success: true, data: { model: catalog.OPTIONS[0], models: catalog } }));
  providers.updateModel.mockImplementation(() => ok({ success: true, data: { model: catalog.OPTIONS[0], models: catalog } }));
});

const openEditor = async () => {
  const view = render(<ModelsContent agent="claude" />);
  await waitFor(() => assert.ok(view.getByText('Gateway Model')));
  fireEvent.click(view.getByLabelText('Edit Gateway Model'));
  return view;
};

/** The add form: filled in far enough that the save button does something, nothing else touched. */
const openAddFormWithGatewayTemplate = async (view: ReturnType<typeof render>) => {
  fireEvent.change(view.getByLabelText('Model name'), { target: { value: 'My Gateway' } });
  fireEvent.change(view.getByLabelText('Model ID'), { target: { value: 'my-gateway' } });
  fireEvent.click(view.getByText('modelLibrary.env.gatewayTemplate'));
};

/** The value input of the row whose variable name is `key`. */
const valueInputOf = (view: ReturnType<typeof render>, key: string) => {
  const row = view.getAllByTestId('model-env-row')
    .find((entry) => (entry.querySelector('input') as HTMLInputElement).value === key);
  assert.ok(row, `no env row for ${key}`);
  return row.querySelectorAll('input')[1] as HTMLInputElement;
};

const GATEWAY_TEMPLATE_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];

test('renaming without touching env sends no config at all', async () => {
  const view = await openEditor();
  fireEvent.change(view.getByDisplayValue('Gateway Model'), { target: { value: 'Renamed' } });
  await act(async () => { fireEvent.click(view.getByText('Save changes')); });

  const [, , body] = providers.updateModel.mock.calls[0];
  assert.deepStrictEqual(body, { model: 'Renamed', id: 'gw-model' });
});

test('editing another row keeps the stored secret without a value; replacing sends only the new value', async () => {
  const view = await openEditor();
  fireEvent.change(view.getByDisplayValue('bar'), { target: { value: 'baz' } });
  await act(async () => { fireEvent.click(view.getByText('Save changes')); });

  let body = providers.updateModel.mock.calls[0][2];
  assert.deepStrictEqual(body.config.env, [
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret' },
    { key: 'FOO', kind: 'value', value: 'baz' },
  ]);
  assert.equal(JSON.stringify(body).includes('isSet'), false);

  fireEvent.click(view.getByLabelText('Edit Gateway Model'));
  fireEvent.change(view.getByLabelText('modelLibrary.env.secretValue'), { target: { value: 'new-secret' } });
  await act(async () => { fireEvent.click(view.getByText('Save changes')); });
  body = providers.updateModel.mock.calls[1][2];
  assert.deepStrictEqual(body.config.env[0], { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: 'new-secret' });
});

test('applying the gateway template and saving with every field empty names the rows the request will drop', async () => {
  const view = render(<ModelsContent agent="claude" />);
  await waitFor(() => assert.ok(view.getByText('Gateway Model')));
  await openAddFormWithGatewayTemplate(view);

  // Nothing filled in yet: each empty template row is marked where the user is looking.
  const summary = view.getByTestId('model-env-unsaved-summary');
  for (const key of GATEWAY_TEMPLATE_KEYS) {
    assert.ok(summary.textContent.includes(key), `${key} must be listed as not saved`);
  }
  assert.equal(view.getAllByTestId('model-env-row-unsaved').length, 5);
  assert.ok(view.getAllByTestId('model-env-row-unsaved')[0].textContent.includes('modelLibrary.env.unsavedRow'));

  await act(async () => { fireEvent.click(view.getByText('Add model')); });

  // The request really does drop them — but only after the user was told which.
  const [, body] = providers.createModel.mock.calls[0];
  assert.deepStrictEqual(body.config.env, [{ key: 'ANTHROPIC_API_KEY', kind: 'unset' }]);
});

test('filling only the base URL leaves exactly the four unpinned variables reported as unsaved', async () => {
  const view = render(<ModelsContent agent="claude" />);
  await waitFor(() => assert.ok(view.getByText('Gateway Model')));
  await openAddFormWithGatewayTemplate(view);
  fireEvent.change(valueInputOf(view, 'ANTHROPIC_BASE_URL'), { target: { value: 'https://gw.example' } });

  const summary = view.getByTestId('model-env-unsaved-summary');
  for (const key of GATEWAY_TEMPLATE_KEYS) {
    assert.ok(summary.textContent.includes(key), `${key} must be listed as not saved`);
  }
  // The row the user filled is no longer one of them, and neither is a row already sent.
  assert.equal(summary.textContent.includes('ANTHROPIC_BASE_URL'), false);
  assert.equal(view.getAllByTestId('model-env-row-unsaved').length, 4);

  await act(async () => { fireEvent.click(view.getByText('Add model')); });
  const [, body] = providers.createModel.mock.calls[0];
  assert.deepStrictEqual(body.config.env, [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://gw.example' },
    { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
  ]);
});

test('a stored secret left blank is never reported as unsaved and still keeps its value', async () => {
  const view = await openEditor();
  // An untouched form sends no config at all, so there is nothing to warn about.
  assert.equal(view.queryByTestId('model-env-unsaved-summary'), null);
  assert.equal(view.queryAllByTestId('model-env-row-unsaved').length, 0);

  fireEvent.change(view.getByDisplayValue('bar'), { target: { value: 'baz' } });

  // Blank value on a stored secret means "keep it", not "drop it".
  assert.equal(view.queryByTestId('model-env-unsaved-summary'), null);
  assert.equal(view.queryAllByTestId('model-env-row-unsaved').length, 0);
  assert.equal(view.getByTestId('secret-set-badge').textContent, 'modelLibrary.env.secretSet');

  await act(async () => { fireEvent.click(view.getByText('Save changes')); });
  const body = providers.updateModel.mock.calls[0][2];
  assert.deepStrictEqual(body.config.env, [
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret' },
    { key: 'FOO', kind: 'value', value: 'baz' },
  ]);
});
