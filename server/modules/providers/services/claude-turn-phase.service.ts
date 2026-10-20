import type { TurnPhase, TurnState } from '@/shared/types.js';
export type { TurnPhase, TurnState };
/**
 * The Turn Tracker: reduces Claude's raw SDK frame stream into the real phase of
 * a session's turn.
 *
 * The normalizer that turns SDK frames into transcript rows is lossy for this
 * question on purpose — `system/thinking_tokens` normalizes to nothing, a
 * `compact_boundary` becomes an ordinary text row, and a partial
 * `content_block_delta` becomes a transient `stream_delta`. So the only seam
 * that sees all of them at once is the raw message the run loop hands the
 * normalizer (the `transformedMessage` argument of `forwardNormalizedFrames`),
 * which is what this reducer consumes.
 *
 * Two properties are load-bearing and are what the criterion pins:
 *
 *  - **Phase comes from a signal, never from elapsed time.** There is no clock
 *    in this file: `toolDurationMs` stays `null` unless a frame actually carries
 *    an elapsed time, because a spinner whose number is invented locally keeps
 *    ticking after the server is gone.
 *  - **A tool ends when its own `tool_result` arrives**, not when the next
 *    assistant message does. The `tool_use` block's `id` is remembered and only
 *    the `tool_result` carrying the matching `tool_use_id` moves the turn off
 *    `tool`.
 *
 * State is per tracker instance and keyed by session id, so two sessions fed
 * interleaved frames cannot read each other's phase. A module-level singleton
 * would pass every single-session test and fail exactly the cross-talk one.
 *
 * **The key is the app session id, and every edge must agree on it.** A caller
 * that observes under one id space and reads under another gets a fresh `idle`
 * record on every read (`getTurn` answers `idle` for an unknown key) — a turn
 * that is genuinely running would be reported as not running, with no error. On
 * the real run loop the provider-native id the SDK reports is *not* the id the
 * activity frames read back under, so the forwarder feeds this reducer the app
 * session id explicitly (`forwardNormalizedFrames`'s `turnSessionId`); see that
 * seam for the two ids and why they differ.
 */





/** A permission prompt's lifecycle, as the run's writer already emits it. */
type TurnPermissionEvent = {
  kind: 'permission_request' | 'permission_resolved';
  requestId: string;
};

/**
 * The reducer instance: one per consumer, holding its own per-session state.
 * `getTurn` never exposes the mutable record, so a caller cannot corrupt the
 * reduction by holding onto a returned state.
 */
export type ClaudeTurnTracker = {
  observe(sessionId: string, message: unknown): void;
  observePermission(sessionId: string, event: TurnPermissionEvent): void;
  getTurn(sessionId: string): TurnState;
  /**
   * The `tool_use.id` of the session's currently pending foreground tool, or
   * `null`.
   *
   * A foreground tool is pending from the `tool_use` block that emitted it until
   * its paired `tool_result` arrives (or the turn's `result` clears the turn):
   * exactly the window in which the CLI can still be asked to background it.
   * This is the addressing seam AC-197's `chat.background-task` reads — a
   * background request names a `toolUseId` and is accepted only when it equals
   * this value, which is what makes the request address a *running foreground
   * tool* rather than a row in the task table (a foreground tool is not a task
   * until the CLI backgrounds it). Exporting the pending id is deliberate: the
   * task table cannot answer this question, and a handler that tried to would
   * be reading the wrong store.
   */
  getPendingToolUseId(sessionId: string): string | null;
};

/** The internal reduction per session; the pairing ids never leave this file. */
type SessionTurn = {
  phase: TurnPhase;
  toolName: string | null;
  toolDurationMs: number | null;
  /** The `tool_use.id` awaiting its paired `tool_result`, or null. */
  pendingToolUseId: string | null;
  /** The phase to restore when the pending tool's result arrives. */
  phaseBeforeTool: TurnPhase;
  /** The phase to restore when the outstanding permission prompt resolves. */
  phaseBeforePermission: TurnPhase | null;
  /** The request id of the outstanding prompt, for correlating its resolution. */
  pendingPermissionRequestId: string | null;
};

/**
 * Narrows an unknown frame to a plain object.
 *
 * Written here rather than imported from `@/shared/utils.js` on purpose: that
 * module pulls in `node:fs`/`express`, and this reducer is required to stay
 * free of filesystem, process and network imports so its criterion proves the
 * phase is signal-driven and not a side effect of the host.
 */
function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Whether a frame belongs to a subagent's sidechain rather than the main line.
 *
 * Subagent traffic carries `parent_tool_use_id`; the resident path additionally
 * re-spells it as `parentToolUseId`. Either spelling means the frame describes a
 * nested agent's work, which must not overwrite the main turn's phase.
 */
function isSubagentFrame(frame: Record<string, unknown>): boolean {
  return Boolean(frame.parent_tool_use_id) || Boolean(frame.parentToolUseId);
}

/** The first content block of the named type inside an assistant/user message. */
function firstContentBlock(
  frame: Record<string, unknown>,
  blockType: string,
): Record<string, unknown> | null {
  const message = readRecord(frame.message);
  const content = message?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const block of content) {
    const record = readRecord(block);
    if (record?.type === blockType) {
      return record;
    }
  }
  return null;
}

/** A fresh, idle reduction for a session that has not been seen yet. */
function createSessionTurn(): SessionTurn {
  return {
    phase: 'idle',
    toolName: null,
    toolDurationMs: null,
    pendingToolUseId: null,
    phaseBeforeTool: 'idle',
    phaseBeforePermission: null,
    pendingPermissionRequestId: null,
  };
}

/**
 * Creates a Turn Tracker.
 *
 * Consumed by the providers module's public facade (`index.ts`) and, through
 * it, by the turn-phase criterion (`claude-turn-phase.test.ts`), which drives
 * the reducer with captured frame sequences. It is the module's answer to
 * "what is this session doing right now, and with which tool", so a future
 * activity aggregator reads it instead of the rotating client-side label.
 */
export function createClaudeTurnTracker(): ClaudeTurnTracker {
  const sessions = new Map<string, SessionTurn>();

  const stateFor = (sessionId: string): SessionTurn => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = createSessionTurn();
      sessions.set(sessionId, state);
    }
    return state;
  };

  /** Moves a session to a signal-driven phase, leaving any pending tool alone. */
  const enterPhase = (sessionId: string, phase: TurnPhase): void => {
    const state = stateFor(sessionId);
    // A pending `tool_use` is left only by its paired `tool_result` (or by the
    // turn's `result`). A stray signal in between must not orphan the pairing,
    // so it cannot override `tool`.
    if (state.phase === 'tool') {
      return;
    }
    state.phase = phase;
  };

  const observe = (sessionId: string, message: unknown): void => {
    const frame = readRecord(message);
    if (!frame || isSubagentFrame(frame)) {
      return;
    }

    const type = frame.type;

    if (type === 'system') {
      if (frame.subtype === 'thinking_tokens') {
        enterPhase(sessionId, 'thinking');
      } else if (frame.subtype === 'compact_boundary') {
        enterPhase(sessionId, 'compacting');
      }
      return;
    }

    if (type === 'stream_event') {
      const event = readRecord(frame.event);
      // The SDK wraps each partial Anthropic event; the text delta the
      // normalizer turns into `stream_delta` is the one that means "writing".
      if (event?.type === 'content_block_delta') {
        const delta = readRecord(event.delta);
        if (typeof delta?.text === 'string' && delta.text.length > 0) {
          enterPhase(sessionId, 'writing');
        }
      }
      return;
    }

    if (type === 'assistant') {
      const block = firstContentBlock(frame, 'tool_use');
      if (!block) {
        return;
      }
      const state = stateFor(sessionId);
      // Re-entering a tool without having left the previous one (a second
      // `tool_use` in the same turn) keeps the original restore target.
      if (state.phase !== 'tool') {
        state.phaseBeforeTool = state.phase;
      }
      state.phase = 'tool';
      state.toolName = typeof block.name === 'string' ? block.name : null;
      state.toolDurationMs = null;
      state.pendingToolUseId = typeof block.id === 'string' ? block.id : null;
      return;
    }

    if (type === 'user') {
      const block = firstContentBlock(frame, 'tool_result');
      const toolUseId = block?.tool_use_id;
      if (typeof toolUseId !== 'string') {
        return;
      }
      const state = stateFor(sessionId);
      if (!state.pendingToolUseId || state.pendingToolUseId !== toolUseId) {
        return;
      }
      state.phase = state.phaseBeforeTool;
      state.phaseBeforeTool = 'idle';
      state.toolName = null;
      state.toolDurationMs = null;
      state.pendingToolUseId = null;
      state.phaseBeforePermission = null;
      state.pendingPermissionRequestId = null;
      return;
    }

    if (type === 'result') {
      const state = stateFor(sessionId);
      state.phase = 'idle';
      state.toolName = null;
      state.toolDurationMs = null;
      state.pendingToolUseId = null;
      state.phaseBeforeTool = 'idle';
      state.phaseBeforePermission = null;
      state.pendingPermissionRequestId = null;
    }
  };

  const observePermission = (sessionId: string, event: TurnPermissionEvent): void => {
    const state = stateFor(sessionId);

    if (event.kind === 'permission_request') {
      if (state.phase === 'awaitingPermission') {
        return;
      }
      state.phaseBeforePermission = state.phase;
      state.phase = 'awaitingPermission';
      state.pendingPermissionRequestId = event.requestId;
      return;
    }

    if (state.phase !== 'awaitingPermission') {
      return;
    }
    // Resolution is correlated by request id: a resolve for some other prompt
    // must not clear this one. A missing id on either side still resolves,
    // because the frame kind alone already says a prompt went away.
    if (state.pendingPermissionRequestId && event.requestId && state.pendingPermissionRequestId !== event.requestId) {
      return;
    }
    state.phase = state.phaseBeforePermission ?? 'idle';
    state.phaseBeforePermission = null;
    state.pendingPermissionRequestId = null;
  };

  const getTurn = (sessionId: string): TurnState => {
    const state = sessions.get(sessionId);
    if (!state) {
      return { phase: 'idle', toolName: null, toolDurationMs: null };
    }
    return { phase: state.phase, toolName: state.toolName, toolDurationMs: state.toolDurationMs };
  };

  const getPendingToolUseId = (sessionId: string): string | null => {
    return sessions.get(sessionId)?.pendingToolUseId ?? null;
  };

  return { observe, observePermission, getTurn, getPendingToolUseId };
}
