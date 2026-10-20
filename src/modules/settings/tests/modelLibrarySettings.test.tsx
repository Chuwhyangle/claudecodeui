import assert from 'node:assert/strict';

import { fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import AgentCategoryContentSection from '@/modules/settings/tabs/agents-settings/sections/AgentCategoryContentSection';
import AgentCategoryTabsSection from '@/modules/settings/tabs/agents-settings/sections/AgentCategoryTabsSection';
import enSettings from '@/modules/i18n/locales/en/settings.json';
import deSettings from '@/modules/i18n/locales/de/settings.json';

/** AC-026: Settings > Agents > Models is a first-class category with masked secrets, envref status, warnings and the gateway template. */

const providers = vi.hoisted(() => ({
  models: vi.fn(),
  modelEnvStatus: vi.fn(),
  createModel: vi.fn(),
  updateModel: vi.fn(),
  deleteModel: vi.fn(),
}));
vi.mock('@/shared/api', () => ({ api: { providers }, authenticatedFetch: vi.fn() }));
vi.mock('@/modules/mcp', () => ({ McpServers: () => null }));
vi.mock('@/modules/skills', () => ({ ProviderSkills: () => null }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useTranslation: () => ({ t: (key: string, options?: { name?: string }) => (options?.name ? `${key}:${options.name}` : key) }),
}));

const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
const catalog = {
  OPTIONS: [
    { value: 'builtin-1', label: 'Built-in One', isCustom: false },
    {
      value: 'gw-model', label: 'Gateway Model', recordId: 7, isCustom: true,
      config: { env: [
        { key: 'FOO', kind: 'value', value: 'bar' },
        { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', isSet: true },
        { key: 'MY_TOKEN', kind: 'envref', value: 'MY_TOKEN_VAR' },
        { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
      ] },
    },
  ],
  DEFAULT: 'builtin-1',
};

beforeEach(() => {
  Object.values(providers).forEach((mock) => mock.mockReset());
  providers.models.mockImplementation(() => ok({ success: true, data: { models: catalog } }));
  providers.modelEnvStatus.mockImplementation(() => ok({ success: true, data: { status: { MY_TOKEN_VAR: false } } }));
});

const renderModels = () => render(
  <AgentCategoryContentSection
    selectedAgent="claude"
    selectedCategory="models"
    agentContextById={{} as never}
    claudePermissions={{ allowedTools: [], disallowedTools: [], skipPermissions: false }}
    onClaudePermissionsChange={() => {}}
    cursorPermissions={{ allowedCommands: [], disallowedCommands: [], skipPermissions: false }}
    onCursorPermissionsChange={() => {}}
    codexPermissionMode="default"
    onCodexPermissionModeChange={() => {}}
    projects={[]}
  />,
);

test('the models category exists as a tab', () => {
  const view = render(
    <AgentCategoryTabsSection categories={['account', 'models']} selectedAgent="claude" selectedCategory="models" onSelectCategory={() => {}} />,
  );
  assert.ok(view.getByRole('tab', { name: 'tabs.models' }));
});

test('lists built-in (read-only) and custom models in separate sections', async () => {
  const view = renderModels();
  await waitFor(() => assert.ok(view.getByText('Gateway Model')));
  assert.ok(view.getByText('Built-in One'));
  assert.ok(view.getByText('Built-in models'));
  assert.ok(view.getByText('Your models'));
  // Built-in rows have no edit affordance.
  assert.equal(view.queryByLabelText('Edit Built-in One'), null);
});

test('editing shows all four row types, masked secret, envref status and warning', async () => {
  const view = renderModels();
  await waitFor(() => assert.ok(view.getByText('Gateway Model')));
  fireEvent.click(view.getByLabelText('Edit Gateway Model'));

  const rows = view.getAllByTestId('model-env-row');
  assert.equal(rows.length, 4);
  const kinds = view.getAllByLabelText('modelLibrary.env.kind').map((el) => (el as HTMLSelectElement).value);
  assert.deepStrictEqual(kinds, ['value', 'secret', 'envref', 'unset']);

  // Secret: "set" badge, empty password input, no value anywhere.
  assert.ok(view.getByTestId('secret-set-badge'));
  const secretInput = view.getByLabelText('modelLibrary.env.secretValue') as HTMLInputElement;
  assert.equal(secretInput.type, 'password');
  assert.equal(secretInput.value, '');

  // Envref: live status, explanation, and a compile warning.
  await waitFor(() => assert.equal(view.getByTestId('envref-status').textContent, 'modelLibrary.env.envrefUnset'));
  assert.ok(view.getByText('modelLibrary.env.envrefHelp'));
  assert.equal(view.getByTestId('model-env-warning').textContent, 'modelLibrary.env.warningEnvrefUnset:MY_TOKEN_VAR');
  assert.deepStrictEqual(providers.modelEnvStatus.mock.calls[0][0], ['MY_TOKEN_VAR']);
});

test('the LLM gateway template pre-fills the gateway rows', async () => {
  const view = renderModels();
  await waitFor(() => assert.ok(view.getByText('Gateway Model')));
  fireEvent.click(view.getByText('modelLibrary.env.gatewayTemplate'));

  const keys = view.getAllByLabelText('modelLibrary.env.key').map((el) => (el as HTMLInputElement).value);
  assert.deepStrictEqual(keys, [
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_API_KEY',
  ]);
  const kinds = view.getAllByLabelText('modelLibrary.env.kind').map((el) => (el as HTMLSelectElement).value);
  assert.deepStrictEqual(kinds, ['value', 'secret', 'value', 'value', 'value', 'unset']);
});

const openGatewayEditorWithBaseUrl = async (url: string) => {
  const view = renderModels();
  await waitFor(() => assert.ok(view.getByText('Gateway Model')));
  fireEvent.click(view.getByLabelText('Edit Gateway Model'));
  fireEvent.click(view.getByText('modelLibrary.env.addRow'));
  const keyInputs = view.getAllByLabelText('modelLibrary.env.key');
  fireEvent.change(keyInputs[keyInputs.length - 1], { target: { value: 'ANTHROPIC_BASE_URL' } });
  const valueInputs = view.getAllByLabelText('modelLibrary.env.value');
  fireEvent.change(valueInputs[valueInputs.length - 1], { target: { value: url } });
  return view;
};

const rowSnapshot = (view: ReturnType<typeof renderModels>) => view.getAllByLabelText('modelLibrary.env.key')
  .map((el) => (el as HTMLInputElement).value);

test('the gateway template keeps an already-filled value instead of replacing the row', async () => {
  const view = await openGatewayEditorWithBaseUrl('https://my-real-gateway.example');
  fireEvent.click(view.getByText('modelLibrary.env.gatewayTemplate'));

  const rows = view.getAllByTestId('model-env-row');
  const baseRow = rows.find((row) => (row.querySelector('input') as HTMLInputElement).value === 'ANTHROPIC_BASE_URL');
  assert.ok(baseRow);
  const valueInput = baseRow.querySelectorAll('input')[1] as HTMLInputElement;
  assert.equal(valueInput.value, 'https://my-real-gateway.example');
  assert.equal(rowSnapshot(view).filter((key) => key === 'ANTHROPIC_BASE_URL').length, 1);
});

test('the gateway template is a toggle that removes only untouched template rows', async () => {
  const view = await openGatewayEditorWithBaseUrl('https://my-real-gateway.example');
  const before = rowSnapshot(view);
  const button = view.getByText('modelLibrary.env.gatewayTemplate');
  assert.equal(button.getAttribute('aria-pressed'), 'false');

  fireEvent.click(button);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.ok(rowSnapshot(view).includes('ANTHROPIC_AUTH_TOKEN'));

  fireEvent.click(button);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.deepStrictEqual(rowSnapshot(view), before);
  const kept = view.getAllByLabelText('modelLibrary.env.value').map((el) => (el as HTMLInputElement).value);
  assert.ok(kept.includes('https://my-real-gateway.example'));
});

test('a template row the user filled in survives turning the template off', async () => {
  const view = renderModels();
  await waitFor(() => assert.ok(view.getByText('Gateway Model')));
  fireEvent.click(view.getByLabelText('Edit Gateway Model'));
  const button = view.getByText('modelLibrary.env.gatewayTemplate');
  fireEvent.click(button);
  const opusRow = view.getAllByTestId('model-env-row')
    .find((row) => (row.querySelector('input') as HTMLInputElement).value === 'ANTHROPIC_DEFAULT_OPUS_MODEL');
  assert.ok(opusRow);
  fireEvent.change(opusRow.querySelectorAll('input')[1], { target: { value: 'my-opus' } });

  fireEvent.click(button);
  assert.ok(rowSnapshot(view).includes('ANTHROPIC_DEFAULT_OPUS_MODEL'));
  assert.ok(!rowSnapshot(view).includes('ANTHROPIC_DEFAULT_SONNET_MODEL'));
});

const openGatewayEditor = async () => {
  const view = renderModels();
  await waitFor(() => assert.ok(view.getByText('Gateway Model')));
  fireEvent.click(view.getByLabelText('Edit Gateway Model'));
  return view;
};

const kindHelpTexts = (view: Awaited<ReturnType<typeof openGatewayEditor>>) => (
  view.getAllByTestId('model-env-kind-help').map((node) => node.textContent)
);

/** AC1: the unset row says the variable is removed from the spawn environment, reachable through `aria-describedby`. */
test('the unset kind explains that it removes the variable and is linked via aria-describedby', async () => {
  // The harness i18n mock only echoes keys, so assert the shipped copy itself: it must be real text and
  // carry the removal semantics (de holds verbatim English here, as for every other modelLibrary env key).
  for (const settings of [enSettings, deSettings]) {
    const kindsHelp = settings.modelLibrary.env.kindsHelp;
    for (const [kind, text] of Object.entries(kindsHelp)) {
      assert.notEqual(text, '', `kindsHelp.${kind} is empty`);
      assert.ok(!text.includes('modelLibrary.env.kindsHelp'), `kindsHelp.${kind} is a raw key`);
    }
    assert.match(kindsHelp.unset, /removes this variable/i);
  }

  const view = await openGatewayEditor();
  const unsetRow = view.getAllByTestId('model-env-row')[3];
  const help = unsetRow.querySelector('[data-testid="model-env-kind-help"]');
  assert.ok(help);
  assert.equal(help.textContent, 'modelLibrary.env.kindsHelp.unset');

  // Both the name field and the kind select name that explanation as their description.
  const helpId = help.getAttribute('id');
  assert.ok(helpId);
  assert.equal(unsetRow.querySelector('input')?.getAttribute('aria-describedby'), helpId);
  assert.equal(unsetRow.querySelector('select')?.getAttribute('aria-describedby'), helpId);
});

/** AC2: each kind renders its own explanation, and changing the kind swaps the explanation with it. */
test('every kind renders its own explanation and switching the kind swaps it', async () => {
  const view = await openGatewayEditor();

  assert.deepStrictEqual(kindHelpTexts(view), ['value', 'secret', 'envref', 'unset']
    .map((kind) => `modelLibrary.env.kindsHelp.${kind}`));

  const firstKind = view.getAllByLabelText('modelLibrary.env.kind')[0];
  fireEvent.change(firstKind, { target: { value: 'unset' } });
  assert.equal(kindHelpTexts(view)[0], 'modelLibrary.env.kindsHelp.unset');

  fireEvent.change(firstKind, { target: { value: 'secret' } });
  assert.equal(kindHelpTexts(view)[0], 'modelLibrary.env.kindsHelp.secret');
  assert.equal(kindHelpTexts(view)[3], 'modelLibrary.env.kindsHelp.unset');
});

test('the gateway template reports the empty rows a save would leave out, and only those', async () => {
  const view = await openGatewayEditorWithBaseUrl('https://my-real-gateway.example');
  fireEvent.click(view.getByText('modelLibrary.env.gatewayTemplate'));

  await waitFor(() => assert.ok(view.getByTestId('model-env-unsaved-summary')));
  const summary = view.getByTestId('model-env-unsaved-summary');
  for (const key of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) {
    assert.ok(summary.textContent.includes(key), `${key} must be listed as not saved`);
  }
  // Filled rows are sent, and a blank stored secret means "keep it" — neither is reported.
  assert.equal(summary.textContent.includes('ANTHROPIC_BASE_URL'), false);
  assert.equal(summary.textContent.includes('ANTHROPIC_AUTH_TOKEN'), false);

  const flagged = view.getAllByTestId('model-env-row-unsaved');
  assert.equal(flagged.length, 3);
  // Each flagged row carries the marker next to the empty field it belongs to.
  const opusRow = view.getAllByTestId('model-env-row')
    .find((row) => (row.querySelector('input') as HTMLInputElement).value === 'ANTHROPIC_DEFAULT_OPUS_MODEL');
  assert.ok(opusRow);
  assert.ok(opusRow.querySelector('[data-testid="model-env-row-unsaved"]'));

  const secretRow = view.getAllByTestId('model-env-row')
    .find((row) => (row.querySelector('input') as HTMLInputElement).value === 'ANTHROPIC_AUTH_TOKEN');
  assert.ok(secretRow);
  assert.equal(secretRow.querySelector('[data-testid="model-env-row-unsaved"]'), null);
});
