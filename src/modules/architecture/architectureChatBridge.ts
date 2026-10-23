import { useEffect, useRef } from 'react';

import { resolveDraftScope } from '@/modules/architecture/selectionModel';
import { readDraftText, writeDraftText } from '@/shared/chatDrafts';

/**
 * The bridge between a standalone architecture page and its session's workspace
 * tab.
 *
 * The standalone page has no chat composer of its own. Two things still have to
 * reach the real workspace: the reader's "Put in chat input" action and the
 * "Back to session" entry. Both travel over ONE
 * `BroadcastChannel('cloudcli-architecture')`:
 *
 *  - `put-in-chat` carries the composed message. The workspace tab appends it to
 *    the session's draft (the same draft store the in-page action writes), shows
 *    Chat and answers `put-in-chat-ack`. No answer within
 *    {@link ARCHITECTURE_CHAT_ACK_TIMEOUT_MS} means no workspace tab is
 *    listening — the standalone page then copies the text instead of pretending
 *    it was delivered.
 *  - `focus-session` asks the workspace tab to bring itself forward; the reply
 *    is what lets "Back to session" switch to the open tab rather than navigate
 *    a second copy of the workspace into the standalone tab.
 *
 * Messages are scoped by session id so a workspace tab showing another session
 * ignores them. The channel is only a transport: the draft itself is written by
 * the workspace tab through the shared chat-draft store, exactly like the
 * in-page action, so the two entry points cannot drift apart.
 */

/** The one channel name the standalone page and the workspace tab share. */
export const ARCHITECTURE_CHAT_CHANNEL = 'cloudcli-architecture';

/** How long a standalone action waits for the workspace tab before falling back. */
export const ARCHITECTURE_CHAT_ACK_TIMEOUT_MS = 1500;

type ArchitectureChatMessage =
  | {
    readonly type: 'put-in-chat';
    readonly sessionId: string;
    readonly text: string;
    readonly requestId: number;
  }
  | {
    readonly type: 'put-in-chat-ack';
    readonly sessionId: string;
    readonly requestId: number;
  }
  | {
    readonly type: 'focus-session';
    readonly sessionId: string;
    readonly requestId: number;
  }
  | {
    readonly type: 'focus-session-ack';
    readonly sessionId: string;
    readonly requestId: number;
  };

/**
 * The slice of `BroadcastChannel` this module uses.
 *
 * Kept as a structural type so a test can stand in for the browser channel
 * without implementing the whole interface.
 */
type ArchitectureChannel = {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  close(): void;
};

/** A message counter within one page; the reply must name the request it answers. */
let nextArchitectureRequestId = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** Narrow an incoming channel payload; anything unrecognised is ignored. */
function parseArchitectureChatMessage(data: unknown): ArchitectureChatMessage | null {
  if (!isRecord(data)) return null;
  const { type, sessionId, requestId } = data;
  if (typeof sessionId !== 'string' || typeof requestId !== 'number') return null;
  if (type === 'put-in-chat') {
    return typeof data.text === 'string'
      ? { type, sessionId, text: data.text, requestId }
      : null;
  }
  if (type === 'put-in-chat-ack' || type === 'focus-session' || type === 'focus-session-ack') {
    return { type, sessionId, requestId };
  }
  return null;
}

/** The browser's channel, or null in an environment that has none (a test, a worker). */
function createArchitectureChannel(): ArchitectureChannel | null {
  if (typeof BroadcastChannel !== 'function') return null;
  return new BroadcastChannel(ARCHITECTURE_CHAT_CHANNEL) as unknown as ArchitectureChannel;
}

/**
 * Post one request and wait for the workspace tab's acknowledgement.
 *
 * The promise resolves `false` for every "nobody is listening" shape: no
 * channel in this environment, no session, or the timeout expiring. Resolving
 * rather than rejecting keeps the caller's fallback a straight `if`.
 */
function requestArchitectureAck(
  request: { readonly type: 'put-in-chat'; readonly text: string } | { readonly type: 'focus-session' },
  sessionId: string | null,
): Promise<boolean> {
  if (sessionId === null || sessionId === '') return Promise.resolve(false);
  const channel = createArchitectureChannel();
  if (channel === null) return Promise.resolve(false);
  const requestId = nextArchitectureRequestId;
  nextArchitectureRequestId += 1;
  const ackType = request.type === 'put-in-chat' ? 'put-in-chat-ack' : 'focus-session-ack';

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (answered: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      channel.removeEventListener('message', onMessage);
      channel.close();
      resolve(answered);
    };
    const onMessage = (event: { readonly data: unknown }): void => {
      const message = parseArchitectureChatMessage(event.data);
      if (message === null) return;
      if (message.type !== ackType) return;
      if (message.sessionId !== sessionId || message.requestId !== requestId) return;
      finish(true);
    };
    channel.addEventListener('message', onMessage);
    timer = setTimeout(() => finish(false), ARCHITECTURE_CHAT_ACK_TIMEOUT_MS);
    channel.postMessage({ ...request, sessionId, requestId });
  });
}

/**
 * Send one composed message to the session's workspace tab.
 *
 * Resolves `true` only when that tab confirmed it appended the text; the caller
 * owns the clipboard fallback, so a timeout is an answer rather than an error.
 */
export function sendArchitectureChatMessage(options: {
  readonly sessionId: string | null;
  readonly text: string;
}): Promise<boolean> {
  if (options.text === '') return Promise.resolve(false);
  return requestArchitectureAck({ type: 'put-in-chat', text: options.text }, options.sessionId);
}

/**
 * Ask the session's workspace tab to bring itself forward. Resolves `true` when
 * that tab answered, which is what makes "Back to session" a switch instead of
 * a second copy.
 */
export function requestArchitectureSessionFocus(sessionId: string | null): Promise<boolean> {
  return requestArchitectureAck({ type: 'focus-session' }, sessionId);
}

/** Append text to one session's chat draft, keeping any message already there. */
function appendToChatDraft(projectId: string | null, sessionId: string | null, text: string): boolean {
  const scope = resolveDraftScope(projectId, sessionId);
  if (scope === null) return false;
  const existing = readDraftText(scope);
  writeDraftText(scope, existing.trim() === '' ? text : `${existing}\n\n${text}`);
  return true;
}

/** Focus the workspace's composer once the Chat tab has been switched in. */
function focusChatComposer(): void {
  window.setTimeout(() => {
    document
      .querySelector<HTMLTextAreaElement>('textarea[data-slot="prompt-input-textarea"]')
      ?.focus();
  }, 0);
}

/**
 * The workspace tab's half of the bridge.
 *
 * Used by `WorkspaceMain` only. Mounting it above the tab switch (rather than
 * inside `ArchitecturePanel`) is deliberate: after the first message the
 * workspace is on Chat, and a standalone page must still be able to send the
 * next selection while that tab stays open.
 */
export function useArchitectureChatBridge(options: {
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly onSwitchToChat: () => void;
}): void {
  const { projectId, sessionId, onSwitchToChat } = options;
  // The switch is a setState dispatch from the workspace shell; keeping it in a
  // ref means the channel subscription survives a re-render without reopening.
  const switchToChatRef = useRef(onSwitchToChat);
  useEffect(() => {
    switchToChatRef.current = onSwitchToChat;
  }, [onSwitchToChat]);

  useEffect(() => {
    if (sessionId === null || sessionId === '') return;
    const channel = createArchitectureChannel();
    if (channel === null) return;

    const onMessage = (event: { readonly data: unknown }): void => {
      const message = parseArchitectureChatMessage(event.data);
      if (message === null || message.sessionId !== sessionId) return;

      if (message.type === 'put-in-chat') {
        if (!appendToChatDraft(projectId, sessionId, message.text)) return;
        switchToChatRef.current();
        focusChatComposer();
        channel.postMessage({
          type: 'put-in-chat-ack',
          sessionId,
          requestId: message.requestId,
        } satisfies ArchitectureChatMessage);
        return;
      }

      if (message.type === 'focus-session') {
        window.focus();
        channel.postMessage({
          type: 'focus-session-ack',
          sessionId,
          requestId: message.requestId,
        } satisfies ArchitectureChatMessage);
      }
    };

    channel.addEventListener('message', onMessage);
    return () => {
      channel.removeEventListener('message', onMessage);
      channel.close();
    };
  }, [projectId, sessionId]);
}
