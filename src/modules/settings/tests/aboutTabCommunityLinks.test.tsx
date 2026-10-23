import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { test, vi } from 'vitest';

import AboutTab from '@/modules/settings/tabs/AboutTab';

/** The copy is not under test; a key-echoing `t` keeps the fixture independent of the locale bundles. */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The version check fetches /health and the GitHub releases API on mount; this
// criterion is about the community links, so the hook answers a settled shape.
vi.mock('@/shared/hooks/useVersionCheck', () => ({
  useVersionCheck: () => ({
    updateAvailable: false,
    latestVersion: null,
    currentVersion: '0.0.0',
    releaseInfo: null,
  }),
}));

const ISSUE_URL = 'https://github.com/siteboon/claudecodeui/issues/new';
const DISCORD_URL = 'https://discord.gg/buxwujPNRE';

test('the About tab links to Report Issue and Join Community in a new tab, without opener access', () => {
  const { container } = render(<AboutTab />);
  const links = Array.from(container.querySelectorAll('a'));

  for (const href of [ISSUE_URL, DISCORD_URL]) {
    const link = links.find((candidate) => candidate.getAttribute('href') === href);
    assert.ok(link, `the About tab must render a link to ${href}`);
    assert.equal(link.getAttribute('target'), '_blank', `${href} must open in a new tab`);
    assert.match(
      link.getAttribute('rel') ?? '',
      /noopener/,
      `${href} must carry rel="noopener" so the opened page cannot reach window.opener`,
    );
  }
});
