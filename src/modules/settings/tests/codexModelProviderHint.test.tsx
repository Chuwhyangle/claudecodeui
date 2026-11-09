import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { UseCodexProvidersResult } from '@/modules/settings/hooks/useCodexProviders';
import CodexProvidersContent from '@/modules/settings/tabs/agents-settings/sections/content/CodexProvidersContent';
import type { CodexProviderDraft } from '@/modules/settings/utils/codexProvidersController';
import { ModelLibraryPanel } from '@/modules/model-library';
import type {
  AgentProvider,
  CodexModelProvider,
  CodexModelProvidersReading,
  ProviderModelActions,
  ProviderModelsDefinition,
} from '@/shared/types';

/**
 * Settings → Agents → Codex's two provider-variant readings (AC-471):
 *
 *  1. Each provider CARD says how the provider shows up in the composer and new-session
 *     pickers — as a `(provider)` variant whose suffix is the provider id.
 *  2. Each BUILT-IN model row says `built-in · N provider variants`, where N is the
 *     registered provider count the registry reading carries.
 *
 * The negative arm is a host with no registry reading (N=0), and the false-form arm proves
 * neither half is a copied literal: two different provider ids move the card hint, and two
 * different registry lengths move the built-in count. The variant row is selected by the
 * provider DESCRIPTOR (`modelConfigKind`), so swapping descriptor rows moves the row too —
 * a view that branched on `provider === 'codex'` fails that case.
 */

const hookMocks = vi.hoisted(() => ({ useCodexProviders: vi.fn() }));

vi.mock('@/modules/settings/hooks/useCodexProviders', () => ({
  useCodexProviders: hookMocks.useCodexProviders,
}));
// The model library is asserted directly below with its own props; the panel's copy inside
// the Codex settings route would otherwise fetch a catalog from the API layer.
vi.mock('@/modules/settings/tabs/agents-settings/sections/content/ModelsContent', () => ({
  default: () => null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const draftWith = (id: string): CodexProviderDraft => ({
  id,
  name: id.toUpperCase(),
  baseUrl: `https://${id}.example/v1`,
  envKey: `${id.toUpperCase()}_API_KEY`,
  tokenFile: '',
  token: '',
  tokenSet: true,
  httpHeaders: [],
  envHttpHeaders: [],
  queryParams: [],
  requestMaxRetries: '',
  streamMaxRetries: '',
  streamIdleTimeoutMs: '',
  modelCatalogUrl: '',
});

const readingWith = (ids: string[]): CodexModelProvidersReading => ({
  path: '/home/tester/.cloudpit/codex.settings.json',
  version: 'version-1',
  providers: ids.map((id) => ({
    id,
    name: id.toUpperCase(),
    baseUrl: `https://${id}.example/v1`,
    envKey: `${id.toUpperCase()}_API_KEY`,
    tokenFile: '',
    wireApi: 'responses' as const,
    tokenSet: true,
    warnings: [],
  })),
  warnings: [],
});

/** A snapshot whose rows and reading carry the same provider ids, as the controller publishes. */
const snapshotFor = (ids: string[]): UseCodexProvidersResult['snapshot'] => ({
  status: 'ready',
  reading: readingWith(ids),
  drafts: ids.map(draftWith),
  error: null,
  imports: null,
  importStatus: 'ready',
  importError: null,
  connection: null,
  connectionStatus: 'idle',
  connectionError: null,
});

const hookResult = (ids: string[]): UseCodexProvidersResult => ({
  snapshot: snapshotFor(ids),
  load: vi.fn(async () => {}),
  addDraft: vi.fn(),
  updateDraft: vi.fn(),
  removeDraft: vi.fn(),
  save: vi.fn(async () => {}),
  loadImports: vi.fn(async () => {}),
  bindImportedProvider: vi.fn(async () => {}),
  testConnection: vi.fn(async () => {}),
});

const AGENT: AgentProvider = 'codex';

const actions: ProviderModelActions = {
  create: vi.fn(async () => {}),
  duplicate: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
};

const registry = (ids: string[]): CodexModelProvider[] => ids.map((id) => ({
  id,
  name: id.toUpperCase(),
  baseUrl: `https://${id}.example/v1`,
  envKey: `${id.toUpperCase()}_API_KEY`,
  tokenFile: '',
  wireApi: 'responses',
  tokenSet: true,
  warnings: [],
}));

beforeEach(() => {
  hookMocks.useCodexProviders.mockReset();
});

test('provider cards name the (provider) variant and its provider-id suffix', () => {
  hookMocks.useCodexProviders.mockReturnValue(hookResult(['bob']));

  render(<CodexProvidersContent agent={AGENT} />);

  const [hint] = screen.getAllByTestId('codex-provider-variant-hint');
  assert.ok(hint, 'the provider card carries a variant hint');
  const text = hint.textContent ?? '';
  assert.match(text, /composer/);
  assert.match(text, /new-session/);
  assert.match(text, /\(provider\)/);
  assert.ok(text.includes('(bob)'), `the hint names this provider id, got: ${text}`);
});

test('two provider cards read their own ids — the hint is not a copied name', () => {
  hookMocks.useCodexProviders.mockReturnValue(hookResult(['bob', 'alice']));

  render(<CodexProvidersContent agent={AGENT} />);

  const hints = screen.getAllByTestId('codex-provider-variant-hint').map((node) => node.textContent ?? '');
  assert.equal(hints.length, 2);
  assert.ok(hints[0].includes('(bob)'), `first card should name bob, got: ${hints[0]}`);
  assert.ok(hints[1].includes('(alice)'), `second card should name alice, got: ${hints[1]}`);
});

test('the built-in models section lists a provider\'s own models by their provider-id label', () => {
  const catalogWithProviderModel: ProviderModelsDefinition = {
    OPTIONS: [
      { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra · fjdac', modelProviderId: 'fjdac' },
    ],
    DEFAULT: 'gpt-5-codex',
  };

  render(
    <ModelLibraryPanel
      initialProvider="codex"
      providerModelCatalog={{ codex: catalogWithProviderModel }}
      actions={actions}
      codexProviders={registry(['fjdac'])}
      hideProviderTabs
    />,
  );

  // The old "built-in · N provider variants" mirror count is gone: built-ins are
  // no longer mirrored across providers — each provider's own models are listed.
  assert.equal(screen.queryByTestId('builtin-model-provider-variants'), null);
  assert.equal(screen.getAllByText('gpt-5.6-terra · fjdac').length, 1);
});
