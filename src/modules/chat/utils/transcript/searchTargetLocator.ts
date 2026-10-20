import type { ChatMessage } from '@/shared/types';

/**
 * Locates the message a sidebar search result points at, against the loaded
 * transcript rather than the rendered DOM.
 *
 * The jump used to render the entire transcript and then scan `.chat-message`
 * textContent for the snippet, retrying fifteen times before giving up
 * silently. Resolving the index from the data first means the caller can size
 * the render window so the target is guaranteed to be on screen, and a miss is
 * knowable instead of being papered over by the nearest-timestamp fallback.
 */

/** Shorter fragments match too many messages to identify one. Exported so the outline applies the same floor. */
export const MIN_SNIPPET_LENGTH = 10;

/** The sidebar sends an elided fragment; only the leading part is reliable. */
const MAX_SNIPPET_LENGTH = 80;

export type SearchTarget = {
  snippet?: string;
  timestamp?: string;
};

export type SearchTargetIndexOptions = {
  /**
   * Whether the nearest-timestamp fallback may be used when the snippet does
   * not match. The search jump passes `false` for the *loaded* transcript: that
   * window is a slice of the history, so the row nearest an old hit's instant
   * inside it is the window's own oldest row — not the hit. The id has to come
   * from a real snippet match, or the resolution has to move on to the outline.
   */
  allowTimestampFallback?: boolean;
};

/** Every field of a message that ends up as rendered text. */
function getSearchableText(message: ChatMessage): string {
  const parts = [message.displayText, message.content];

  if (typeof message.toolInput === 'string') {
    parts.push(message.toolInput);
  }
  const toolResultContent = message.toolResult?.content;
  if (typeof toolResultContent === 'string') {
    parts.push(toolResultContent);
  }

  return parts.filter(Boolean).join('\n').toLowerCase();
}

/**
 * Reduces a sidebar snippet to the fragment matching is done on: the wrapper's
 * ellipses dropped, whitespace trimmed, and the tail cut at the length cap the
 * sidebar elides at.
 *
 * Exported because the outline rebuilds the same fragment before comparing it
 * against a turn's preview, and the preview is capped at the same length — a
 * phrase left longer than the cap could never be carried by a preview.
 */
export function normalizeSearchSnippet(snippet: string): string {
  return snippet
    .replace(/^\.{3}/, '')
    .replace(/\.{3}$/, '')
    .trim()
    .slice(0, MAX_SNIPPET_LENGTH)
    .toLowerCase()
    .trim();
}

/**
 * Returns the index of the best match, or -1 when the target is not in the
 * loaded transcript. The snippet is authoritative; the timestamp only breaks a
 * tie when no snippet matched, mirroring what the previous DOM scan did —
 * unless the caller forbids the timestamp fallback because the list it holds is
 * a partial window rather than the transcript.
 */
export function findSearchTargetIndex(
  messages: ChatMessage[],
  target: SearchTarget,
  options: SearchTargetIndexOptions = {},
): number {
  if (target.snippet) {
    const phrase = normalizeSearchSnippet(target.snippet);
    if (phrase.length >= MIN_SNIPPET_LENGTH) {
      const matchIndex = messages.findIndex((message) =>
        getSearchableText(message).includes(phrase),
      );
      if (matchIndex >= 0) {
        return matchIndex;
      }
    }
  }

  if (options.allowTimestampFallback === false) {
    return -1;
  }

  if (target.timestamp) {
    const targetTime = new Date(target.timestamp).getTime();
    if (Number.isFinite(targetTime)) {
      let closestIndex = -1;
      let closestDistance = Infinity;

      for (const [index, message] of messages.entries()) {
        const messageTime = new Date(message.timestamp).getTime();
        if (!Number.isFinite(messageTime)) {
          continue;
        }

        const distance = Math.abs(messageTime - targetTime);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      }

      return closestIndex;
    }
  }

  return -1;
}

/**
 * How many trailing messages must be rendered for `targetIndex` to be on screen.
 *
 * `visibleMessages` is a tail slice, so covering an old hit means rendering
 * everything after it. Exported for the caller and pinned by tests because an
 * off-by-one here scrolls to the wrong row or to nothing at all.
 */
export function resolveSearchWindowSize(
  messageCount: number,
  targetIndex: number,
  trailingContext: number,
): number {
  return messageCount - targetIndex + trailingContext;
}
