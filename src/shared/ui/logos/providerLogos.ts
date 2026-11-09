import type { ComponentType } from 'react';

import type { LLMProvider } from '@/shared/types';
import ClaudeLogo from '@/shared/ui/logos/ClaudeLogo';
import CodexLogo from '@/shared/ui/logos/CodexLogo';
import CursorLogo from '@/shared/ui/logos/CursorLogo';
import OpenCodeLogo from '@/shared/ui/logos/OpenCodeLogo';

/**
 * The mark each selectable provider renders, keyed by `LLMProvider`.
 *
 * This table lives in the UI package rather than beside `PROVIDER_DESCRIPTORS`
 * in `src/shared/constants.ts`: the logo components are the only reason the
 * shared root would import out of `src/shared/ui`, and keeping the React
 * components here leaves the root with no edge into a sub-package. The
 * provider difference stays data — a new provider adds one row here next to its
 * descriptor row, not a `provider === '…'` branch at a render site.
 */
export const PROVIDER_LOGOS: Record<LLMProvider, ComponentType<{ className?: string }>> = {
  claude: ClaudeLogo,
  cursor: CursorLogo,
  codex: CodexLogo,
  opencode: OpenCodeLogo,
};

/**
 * The mark for a provider id from the wire, or `undefined` when this build has
 * no row for it (the debug agent, a typo, an id from a newer server) — the same
 * id set `resolveProviderDescriptor` recognises.
 */
export const resolveProviderLogo = (
  provider: string | null | undefined,
): ComponentType<{ className?: string }> | undefined =>
  provider && Object.prototype.hasOwnProperty.call(PROVIDER_LOGOS, provider)
    ? PROVIDER_LOGOS[provider as LLMProvider]
    : undefined;
