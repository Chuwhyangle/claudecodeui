import type { FormEvent } from 'react';

import type { ProjectSession } from '@/shared/types';

/**
 * The message text a draft sends as: trailing spaces and line breaks removed, anything internal
 * kept. A quote chip accepted at the end of an empty line leaves two newlines in the box, and
 * those are the composer's padding rather than part of the message.
 */
export function stripTrailingWhitespace(text: string): string {
  return text.replace(/\s+$/u, '');
}

/** The synthetic submit form event an immediate send hands to the composer's submit path. */
export function createFakeSubmitEvent(): FormEvent<HTMLFormElement> {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
}

/** The history row's title for a send: the session's own name, else the draft, bounded to 80. */
export function getNotificationSessionSummary(
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
}
