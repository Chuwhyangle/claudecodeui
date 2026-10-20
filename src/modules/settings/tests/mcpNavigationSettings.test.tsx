import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  MCP_NAVIGATION_POLICY_STORAGE_KEY,
  readMcpNavigationPolicy,
  useMcpNavigationSettings,
} from '@/modules/settings/hooks/useMcpNavigationSettings';
import { MCP_DEVICE_NAME_STORAGE_KEY, readDeviceName } from '@/shared/userSettings';
import CredentialsSettingsTab from '@/modules/settings/tabs/api-settings/CredentialsSettingsTab';

/**
 * The per-device MCP navigation policy and device name, and the Settings → API block that
 * edits them. TWO READINGS, one file: the hook's own contract (default / invalid / throwing
 * reads all answer `ask`, a write round-trips, a `storage` event re-syncs a *different* hook
 * instance, and a blank name falls back to a User-Agent default with no version number), and
 * the settings page really rendering the three-state choice and the name box so that an edit
 * reaches localStorage — the wiring a hook-only test would miss.
 *
 * The device name is asserted through the reader (with the User-Agent swapped per case), not
 * by calling the parser directly: the reader is the surface non-component code uses, so a case
 * that reached past it would prove the parser but not the contract.
 */

// Resolve keys against the real English bundle rather than echoing them, so the page under
// test shows the copy a user reads (and the device-only sentence can be matched on its words).
vi.mock('react-i18next', async () => {
  const { default: enSettings } = await import('@/modules/i18n/locales/en/settings.json');
  const readPath = (bundle: unknown, path: string): unknown => {
    let node: unknown = bundle;
    for (const part of path.split('.')) {
      if (!node || typeof node !== 'object') {
        return undefined;
      }
      node = (node as Record<string, unknown>)[part];
    }
    return node;
  };
  return {
    useTranslation: () => ({
      t: (key: string) => {
        const value = readPath(enSettings, key);
        return typeof value === 'string' ? value : key;
      },
      i18n: { language: 'en', changeLanguage: async () => {} },
    }),
  };
});

/**
 * The tab's own data hooks are stubbed with an empty, already-loaded shape: this criterion is
 * about the block the tab wires in, not about the token or OAuth lists beside it.
 */
vi.mock('@/modules/settings/hooks/useCredentialsSettings', () => ({
  useCredentialsSettings: () => ({
    accessTokens: [],
    oauthTokens: [],
    githubCredentials: [],
    loading: false,
    showNewTokenForm: false,
    setShowNewTokenForm: () => {},
    newTokenName: '',
    setNewTokenName: () => {},
    newTokenExpiryDays: 30,
    setNewTokenExpiryDays: () => {},
    newlyCreatedToken: null,
    copiedToken: false,
    createAccessToken: () => {},
    revokeAccessToken: () => {},
    mcpGatewayStatus: null,
    newTokenScopes: [],
    toggleNewTokenScope: () => {},
    showNewGithubForm: false,
    setShowNewGithubForm: () => {},
    newGithubName: '',
    setNewGithubName: () => {},
    newGithubToken: '',
    setNewGithubToken: () => {},
    newGithubDescription: '',
    setNewGithubDescription: () => {},
    showToken: {},
    createGithubCredential: () => {},
    deleteGithubCredential: () => {},
    toggleGithubCredential: () => {},
    copyTokenToClipboard: () => {},
    dismissNewlyCreatedToken: () => {},
    cancelNewAccessTokenForm: () => {},
    cancelNewGithubForm: () => {},
    toggleNewGithubTokenVisibility: () => {},
  }),
}));

vi.mock('@/modules/settings/hooks/useOAuthSettings', () => ({
  useOAuthSettings: () => ({
    grants: [],
    clients: [],
    loading: false,
    showNewClientForm: false,
    setShowNewClientForm: () => {},
    newClientName: '',
    setNewClientName: () => {},
    newClientRedirectUris: '',
    setNewClientRedirectUris: () => {},
    newlyCreatedClient: null,
    createManualClient: () => {},
    revokeGrant: () => {},
    disableClient: () => {},
    dismissNewClient: () => {},
    cancelNewClientForm: () => {},
  }),
}));

const CHROME_ON_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SAFARI_ON_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/** Pins `navigator.userAgent` for one case and returns a restore for the caller to run. */
const withUserAgent = (userAgent: string): (() => void) => {
  const original = window.navigator.userAgent;
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
  return () => {
    Object.defineProperty(window.navigator, 'userAgent', { value: original, configurable: true });
  };
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

test('readMcpNavigationPolicy answers ask for no value, an illegal value and a read that throws', () => {
  localStorage.removeItem(MCP_NAVIGATION_POLICY_STORAGE_KEY);
  assert.equal(readMcpNavigationPolicy(), 'ask', 'no stored value defaults to ask');

  localStorage.setItem(MCP_NAVIGATION_POLICY_STORAGE_KEY, 'maybe');
  assert.equal(readMcpNavigationPolicy(), 'ask', 'an unrecognised value is not a policy');

  localStorage.setItem(MCP_NAVIGATION_POLICY_STORAGE_KEY, 'reject');
  assert.equal(readMcpNavigationPolicy(), 'reject', 'a stored policy is read back verbatim');

  const blocked = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('storage is blocked');
  });
  try {
    assert.equal(readMcpNavigationPolicy(), 'ask', 'a throwing read still answers ask');
    assert.equal(readDeviceName().length > 0, true, 'a throwing read still answers a name');
  } finally {
    blocked.mockRestore();
  }
});

test('the hook writes the policy and name, and mirrors a change made in another tab', async () => {
  const first = renderHook(() => useMcpNavigationSettings());
  const second = renderHook(() => useMcpNavigationSettings());

  assert.equal(first.result.current.policy, 'ask');
  assert.equal(second.result.current.policy, 'ask');

  act(() => first.result.current.setPolicy('reject'));
  assert.equal(localStorage.getItem(MCP_NAVIGATION_POLICY_STORAGE_KEY), 'reject');
  assert.equal(first.result.current.policy, 'reject');
  // A writer's own tab gets no `storage` event, so the sibling instance is still on its old
  // value — the sync below has to come from the event, not from shared module state.
  assert.equal(second.result.current.policy, 'ask', 'the sibling tab has not been notified yet');

  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: MCP_NAVIGATION_POLICY_STORAGE_KEY, newValue: 'reject' }),
    );
  });
  await waitFor(() => assert.equal(second.result.current.policy, 'reject'));

  act(() => first.result.current.setDeviceName('Work Laptop'));
  assert.equal(localStorage.getItem(MCP_DEVICE_NAME_STORAGE_KEY), 'Work Laptop');

  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: MCP_DEVICE_NAME_STORAGE_KEY, newValue: 'Home Laptop' }),
    );
  });
  await waitFor(() => assert.equal(second.result.current.deviceName, 'Home Laptop'));

  // An event that removes the name re-derives the default rather than keeping the stale one.
  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: MCP_DEVICE_NAME_STORAGE_KEY, newValue: null }),
    );
  });
  await waitFor(() => assert.notEqual(second.result.current.deviceName, 'Home Laptop'));

  console.log(
    `[mcp-navigation] policy=${first.result.current.policy} name=${JSON.stringify(second.result.current.deviceName)}`,
  );
});

test('a blank device name falls back to a User-Agent default that carries no version number', () => {
  const restoreChrome = withUserAgent(CHROME_ON_LINUX);
  try {
    localStorage.removeItem(MCP_DEVICE_NAME_STORAGE_KEY);
    assert.equal(readDeviceName(), 'Chrome · Linux', 'the default names the browser and the OS');

    localStorage.setItem(MCP_DEVICE_NAME_STORAGE_KEY, '   ');
    assert.equal(readDeviceName(), 'Chrome · Linux', 'a whitespace-only name is not a name');

    localStorage.setItem(MCP_DEVICE_NAME_STORAGE_KEY, 'My Device');
    assert.equal(readDeviceName(), 'My Device', 'a chosen name is read back verbatim');
  } finally {
    restoreChrome();
  }

  // A second User-Agent proves the default is parsed rather than a constant...
  const restoreSafari = withUserAgent(SAFARI_ON_MAC);
  try {
    localStorage.removeItem(MCP_DEVICE_NAME_STORAGE_KEY);
    assert.equal(readDeviceName(), 'Safari · macOS');
  } finally {
    restoreSafari();
  }

  // ...and neither default carries a version number.
  for (const name of ['Chrome · Linux', 'Safari · macOS']) {
    assert.doesNotMatch(name, /\d/, `${name} must not carry a version number`);
  }
});

test('the Settings → API tab renders the choice and the name box, and edits reach localStorage', async () => {
  const restore = withUserAgent(CHROME_ON_LINUX);
  try {
    const view = render(<CredentialsSettingsTab />);

    assert.ok(view.getByTestId('mcp-navigation-section'), 'the tab wires the navigation block in');

    const accept = view.getByTestId('mcp-navigation-policy-accept') as HTMLInputElement;
    const ask = view.getByTestId('mcp-navigation-policy-ask') as HTMLInputElement;
    const reject = view.getByTestId('mcp-navigation-policy-reject') as HTMLInputElement;
    assert.deepEqual([accept.value, ask.value, reject.value], ['accept', 'ask', 'reject']);
    assert.equal(ask.checked, true, 'the three-state choice starts on the ask default');

    fireEvent.click(reject);
    await waitFor(() =>
      assert.equal(localStorage.getItem(MCP_NAVIGATION_POLICY_STORAGE_KEY), 'reject'),
    );
    assert.equal(reject.checked, true, 'the clicked state is the one shown');

    const name = view.getByTestId('mcp-device-name') as HTMLInputElement;
    assert.equal(name.value, 'Chrome · Linux', 'the box opens on the derived default');
    fireEvent.change(name, { target: { value: 'Desk Browser' } });
    await waitFor(() =>
      assert.equal(localStorage.getItem(MCP_DEVICE_NAME_STORAGE_KEY), 'Desk Browser'),
    );

    // Clearing returns the box to the default and drops the stored key.
    fireEvent.change(name, { target: { value: '' } });
    await waitFor(() => assert.equal(localStorage.getItem(MCP_DEVICE_NAME_STORAGE_KEY), null));
    assert.equal(name.value, 'Chrome · Linux', 'the box falls back to the default when cleared');

    const deviceOnly = view.getByTestId('mcp-navigation-device-only');
    assert.match(deviceOnly.textContent ?? '', /this device/i, 'the page states it is per device');

    console.log(
      `[mcp-navigation] page policy=${localStorage.getItem(MCP_NAVIGATION_POLICY_STORAGE_KEY)}`
        + ` deviceOnly=${JSON.stringify(deviceOnly.textContent)}`,
    );
  } finally {
    restore();
  }
});
