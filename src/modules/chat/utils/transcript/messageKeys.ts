import type { ChatMessage } from '@/shared/types';

/**
 * The identity fields a transcript row can be addressed by, on either side of
 * the projection: a store row (`NormalizedMessage`) carries `id`, a rendered row
 * (`ChatMessage`) carries the same value as `transcriptRowId` instead.
 */
export type MessageAnchorFields = {
  /** The provider's row id, when the provider has stable per-row identity. */
  transcriptAnchorId?: string | null;
  /** A read row's own id, carried onto the rendered message. */
  transcriptRowId?: string | null;
  /** This client's row id, for a row the client is streaming itself. */
  id?: string | null;
};

/**
 * The id a transcript row is *addressed* by: the provider anchor when there is
 * one, else the row's own id from the read it came from, else this client's own
 * row id.
 *
 * This is one rule with several readers, and they only agree because it is one
 * function. The chat pane publishes it as `data-message-anchor-id`, the jump and
 * locate machinery looks a row up by that same attribute
 * (`findRenderedMessageElementById`), the session store windows a load by it
 * (`windowIdOf`), and the server resolves `session_read mode=around` against
 * exactly `transcriptAnchorId ?? id`. So an id read off a visible row is an id
 * `around` understands — the range `ui_visible_context` reports can be re-read.
 *
 * It is deliberately *not* `transcriptAnchorId` alone. Only a `user` row carries
 * a provider anchor — that is what names the prompt a turn answers — so keying
 * the transcript on the raw field leaves every assistant, tool and thinking row
 * unaddressable, and a pane band full of an assistant's answer reports no range
 * at all.
 *
 * Nor is it `id` alone: the projection drops `id` for a row that came from a
 * read (see `useChatMessages`), because a React key has to survive a provider
 * that re-mints its ids, so a read row's id travels as `transcriptRowId` instead.
 */
export const messageAnchorId = (message: MessageAnchorFields): string | null =>
  message.transcriptAnchorId ?? message.transcriptRowId ?? message.id ?? null;

const toMessageKeyPart = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
};

export const getIntrinsicMessageKey = (message: ChatMessage): string | null => {
  // `blockKey` leads the candidates on purpose. It is the one field that is the
  // same on all three states of a streamed block — the client's live row, the
  // settled record that replaces it, and the persisted row a refresh brings in
  // under the same id — while every other candidate changes between them: the
  // live id is the client's own, the settled id is the server's, and the
  // timestamp is re-minted. Keying by any of those re-keys the row on the frame
  // it settles, which is an unmount on a pane pinned to the bottom.
  const candidates = [
    message.blockKey,
    message.id,
    message.messageId,
    message.toolId,
    message.toolCallId,
    message.blobId,
    message.rowid,
    message.sequence,
  ];

  for (const candidate of candidates) {
    const keyPart = toMessageKeyPart(candidate);
    if (keyPart) {
      return `message-${message.type}-${keyPart}`;
    }
  }

  const timestamp = new Date(message.timestamp).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const contentPreview = typeof message.content === 'string' ? message.content.slice(0, 48) : '';
  const toolName = typeof message.toolName === 'string' ? message.toolName : '';
  return `message-${message.type}-${timestamp}-${toolName}-${contentPreview}`;
};
