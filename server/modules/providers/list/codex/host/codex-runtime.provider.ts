/**
 * OpenAI Codex SDK Integration
 * =============================
 *
 * This module provides integration with the OpenAI Codex SDK for non-interactive
 * chat sessions. It mirrors the Claude runtime adapter for consistency.
 *
 * ## Usage
 *
 * - codexRuntime.run(command, options, writer, context) - Execute a streamed prompt
 * - codexRuntime.abort(sessionId) - Cancel an active session
 */

import { Codex } from '@openai/codex-sdk';
import type { ModelReasoningEffort, Thread, ThreadOptions } from '@openai/codex-sdk';

import {
  appendFilesInputTag,
  buildCodexInputItems,
  normalizeImageDescriptors,
  createCompleteMessage,
  createNormalizedMessage,
} from '@/shared/index.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { compileCodexProviderOptions } from '@/modules/providers/list/codex/app-server/codex-provider-injection.js';
import { readCodexSessionTokenUsage } from '@/modules/providers/list/codex/sessions/codex-token-usage-files.js';
import { approvalRequests } from '@/modules/providers/shared/base/approval-requests.service.js';
import { readSessionAwaitingReplyPort } from '@/shared/ports/session-awaiting-reply.port.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';

type ActiveCodexSession = {
  thread: Thread;
  codex: Codex;
  status: 'running' | 'aborted' | 'completed';
  abortController: AbortController;
  startedAt: string;
};

/**
 * Owns the Codex runtime's in-flight sessions.
 *
 * The session map used to be a module-level `const ... = new Map` mutated from
 * five places: a global mutable singleton with no owner and no lifecycle. It is
 * a private field now, and the class exposes only the transitions the runtime
 * actually performs — register a run, read it back while streaming, abort it,
 * mark it finished, and sweep finished entries. The module exports one instance
 * ({@link codexRuntimeState}) used by `queryCodex`, `abortCodexSession` and the
 * cleanup timer.
 */
class CodexRuntimeState {
  /**
   * Keyed by the app session id when the caller supplied one, else by the
   * provider-native thread id once captured (legacy/direct API callers).
   */
  private readonly activeCodexSessions = new Map<string, ActiveCodexSession>();

  /** Adds (or refreshes) the session map entry for a run that just started. */
  register(id: string, session: ActiveCodexSession): void {
    this.activeCodexSessions.set(id, session);
  }

  /** The live entry for a run, or undefined once it was swept. */
  get(id: string): ActiveCodexSession | undefined {
    return this.activeCodexSessions.get(id);
  }

  /**
   * Marks a run finished. An abort recorded while it was streaming wins: the
   * terminal status stays `aborted` rather than being overwritten as completed.
   */
  finish(id: string): void {
    const session = this.activeCodexSessions.get(id);
    if (session) {
      session.status = session.status === 'aborted' ? 'aborted' : 'completed';
    }
  }

  /**
   * Marks a run aborted and cancels its stream. Returns false when the id is
   * unknown, which callers surface as "nothing to abort".
   */
  abort(id: string): boolean {
    const session = this.activeCodexSessions.get(id);

    if (!session) {
      return false;
    }

    session.status = 'aborted';
    try {
      session.abortController?.abort();
    } catch (error) {
      console.warn(`[Codex] Failed to abort session ${id}:`, error);
    }

    return true;
  }

  /**
   * Deletes entries that have not been running for longer than `maxAgeMs`.
   * Running sessions are never swept, however old they are.
   */
  purgeFinished(maxAgeMs: number, now = Date.now()): void {
    for (const [id, session] of this.activeCodexSessions.entries()) {
      if (session.status !== 'running') {
        const startedAt = new Date(session.startedAt).getTime();
        if (now - startedAt > maxAgeMs) {
          this.activeCodexSessions.delete(id);
        }
      }
    }
  }
}

/** The module's one session owner; see {@link CodexRuntimeState}. */
const codexRuntimeState = new CodexRuntimeState();

// Codex CLI requires non-whitespace stdin even when --image arguments are
// present, so attachment-only turns need a small text instruction.
const CODEX_IMAGE_ONLY_PROMPT = 'Please analyze the attached image(s).';

/**
 * Item types whose in-flight updates are worth showing. These are the ones a
 * user waits on — a shell command's output, an MCP call, and the running plan.
 */
const PROGRESSIVE_CODEX_ITEM_TYPES = new Set(['command_execution', 'mcp_tool_call', 'todo_list']);

/**
 * Transform Codex SDK event to WebSocket message format
 * @param {object} event - SDK event
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexEvent(event: AnyRecord): AnyRecord {
  // Map SDK event types to a consistent format
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      const item = event.item;
      if (!item) {
        return { type: event.type, item: null };
      }

      // `itemId` is the SDK's stable per-item id. Carrying it through means an
      // in-progress row and its later completion normalize to the same message
      // id, so the client updates one transcript entry instead of appending a
      // new one for every progress tick.
      switch (item.type) {
        case 'agent_message':
          return {
            type: 'item',
            itemType: 'agent_message',
            itemId: item.id,
            message: {
              role: 'assistant',
              content: item.text
            }
          };

        case 'reasoning':
          return {
            type: 'item',
            itemType: 'reasoning',
            itemId: item.id,
            message: {
              role: 'assistant',
              content: item.text,
              isReasoning: true
            }
          };

        case 'command_execution':
          return {
            type: 'item',
            itemType: 'command_execution',
            itemId: item.id,
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status
          };

        case 'file_change':
          return {
            type: 'item',
            itemType: 'file_change',
            itemId: item.id,
            changes: item.changes,
            status: item.status
          };

        case 'mcp_tool_call':
          return {
            type: 'item',
            itemType: 'mcp_tool_call',
            itemId: item.id,
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status
          };

        case 'web_search':
          return {
            type: 'item',
            itemType: 'web_search',
            itemId: item.id,
            query: item.query
          };

        case 'todo_list':
          return {
            type: 'item',
            itemType: 'todo_list',
            itemId: item.id,
            items: item.items
          };

        case 'error':
          return {
            type: 'item',
            itemType: 'error',
            itemId: item.id,
            message: {
              role: 'error',
              content: item.message
            }
          };

        default:
          return {
            type: 'item',
            itemType: item.type,
            itemId: item.id,
            item: item
          };
      }

    case 'turn.started':
      return {
        type: 'turn_started'
      };

    case 'turn.completed':
      return {
        type: 'turn_complete',
        usage: event.usage
      };

    case 'turn.failed':
      return {
        type: 'turn_failed',
        error: event.error
      };

    case 'thread.started':
      return {
        type: 'thread_started',
        threadId: event.thread_id || event.id
      };

    case 'error':
      return {
        type: 'error',
        message: event.message
      };

    default:
      return {
        type: event.type,
        data: event
      };
  }
}

/**
 * Map permission mode to Codex SDK options
 * @param {string} permissionMode - 'default', 'acceptEdits', or 'bypassPermissions'
 * @returns {object} - { sandboxMode, approvalPolicy }
 */
function mapPermissionModeToCodexOptions(permissionMode: string): Pick<ThreadOptions, 'sandboxMode' | 'approvalPolicy'> {
  switch (permissionMode) {
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never'
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      };
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        // Current Codex CLI versions reject the retired `untrusted` policy.
        // Keep sandboxing enabled; exec cannot grant interactive approval requests.
        approvalPolicy: 'on-request'
      };
  }
}

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
async function queryCodex(
  command: string,
  options: AnyRecord = {},
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
) {
  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    effort,
    images,
    files,
    permissionMode = 'default'
  } = options;

  // Callers pass the stable app session id; the SDK resumes threads with the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);

  const resolvedModel = await context.resolveResumeModel(sessionId, model);

  const workingDirectory = cwd || projectPath || process.cwd();
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);
  const catalog = await context.getProviderModels();
  const selectedModel = catalog.OPTIONS.find((option) => option.value === resolvedModel) || null;
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  const resolvedEffort = typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort as ModelReasoningEffort
    : undefined;

  // A model entry bound to a project Codex provider must be launched under that
  // provider: Codex 0.166 rejects a turn whose provider differs from the one the
  // process started with (`modelProviderMismatch`), so the injection has to be on
  // the SDK options, not only on ThreadOptions. An unbound model keeps the exact
  // previous behaviour — `new Codex()` with no options, inheriting Codex's global
  // default. A bound model whose provider cannot be resolved throws inside the try
  // below, which surfaces the readable line instead of silently dialling the
  // default endpoint.
  const codexProviderId = selectedModel?.config?.codexProviderId;

  let codex: Codex;
  let thread: Thread;
  // Provider-native thread id (starts as the resume id, or is captured from
  // the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  let terminalFailure: { message: string } | null = null;
  // Codex surfaces API failures as streamed error items/turn.failed events, and
  // then the SDK also throws "Codex Exec exited with code N: <stderr>" once the
  // process dies. Showing both means the rendered error is followed by a raw
  // stderr dump of unrelated CLI log lines, so the thrown wrapper is dropped
  // when the stream already reported the failure.
  let errorSurfaced = false;
  const abortController = new AbortController();
  // Session-map key: the app session id when the caller supplied one, else
  // the provider-native thread id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  try {
    codex = codexProviderId
      ? new Codex(compileCodexProviderOptions(codexProviderId, {
        // The selected catalog entry is the most specific context-window fact
        // source (the tier a Claude launch profile occupies), falling back to
        // the provider entry's own default inside the compiler.
        contextWindow: selectedModel?.contextWindow,
        autoCompactTokenLimit: selectedModel?.autoCompactTokenLimit,
      }))
      : new Codex();

    const threadOptions: ThreadOptions = {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      model: resolvedModel,
      modelReasoningEffort: resolvedEffort,
    };

    if (providerSessionId) {
      thread = codex.resumeThread(providerSessionId, threadOptions);
    } else {
      thread = codex.startThread(threadOptions);
    }

    const registerSession = (id: string | null) => {
      if (!id) {
        return;
      }
      codexRuntimeState.register(id, {
        thread,
        codex,
        status: 'running',
        abortController,
        startedAt: new Date().toISOString()
      });
    };

    if (sessionKey()) {
      registerSession(sessionKey());
    }

    // Execute with streaming. Turns with image attachments send structured
    // input items so Codex reads the images from their local asset paths.
    const promptWithFiles = appendFilesInputTag(command, files);
    const normalizedImages = normalizeImageDescriptors(images);
    const promptWithImageFallback = !promptWithFiles.trim() && normalizedImages.length > 0
      ? CODEX_IMAGE_ONLY_PROMPT
      : promptWithFiles;
    const turnInput = normalizedImages.length > 0
      ? buildCodexInputItems(promptWithImageFallback, normalizedImages, workingDirectory)
      : promptWithFiles;
    const streamedTurn = await thread.runStreamed(turnInput, {
      signal: abortController.signal
    });

    for await (const event of streamedTurn.events) {
      // Capture thread/session id lazily from the stream (Codex emits this asynchronously).
      if (event.type === 'thread.started') {
        const discoveredSessionId = event.thread_id || null;
        if (discoveredSessionId && !capturedSessionId) {
          capturedSessionId = discoveredSessionId;
          registerSession(sessionKey());

          if (ws.setSessionId && typeof ws.setSessionId === 'function') {
            ws.setSessionId(capturedSessionId);
          }

          if (!providerSessionId && !sessionCreatedSent) {
            sessionCreatedSent = true;
            sendMessage(ws, createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'codex' }));
          }
        }
      }

      // Check if session was aborted
      if (abortController.signal.aborted) {
        break;
      }
      if (sessionKey()) {
        const session = codexRuntimeState.get(sessionKey() || '');
        if (session?.status === 'aborted') {
          break;
        }
      }

      // Progress events used to be dropped, so a long shell command or a
      // growing plan showed nothing until it finished. They are forwarded now;
      // every item carries a stable id, so the client replaces the row it
      // already has rather than stacking a new one per tick. Text items are
      // still skipped mid-flight because assistant prose arrives through the
      // separate streaming path.
      if (
        (event.type === 'item.started' || event.type === 'item.updated')
        && !PROGRESSIVE_CODEX_ITEM_TYPES.has(event.item?.type)
      ) {
        continue;
      }

      // Send the same normalized snapshot the history reader and the
      // `/token-usage` endpoint read. The SDK's `turn.completed.usage` is only
      // this turn's spend — it has no cumulative total and no window — so the
      // authoritative source is the rollout's newest `token_count` row, which
      // the CLI has written by the time the turn completes. If the file cannot
      // be read yet, no frame is sent rather than publishing a fabricated
      // all-zero or per-turn-as-cumulative budget.
      //
      // The read is awaited HERE, before the terminal frame below is normalized
      // and sent: the session-host wrapper treats a terminal frame followed by a
      // still-pending run promise as a held-open window (`lingering` → `released`
      // on settle). A filesystem await between the two would misreport a finished
      // turn as a held one, so the I/O must finish before the frame goes out.
      const tokenBudget = event.type === 'turn.completed'
        ? await readCodexSessionTokenUsage(capturedSessionId || sessionId || null)
        : null;

      const transformed = transformCodexEvent(event);
      if (transformed.type === 'error' || transformed.itemType === 'error') {
        errorSurfaced = true;
      }

      // Normalize the transformed event into NormalizedMessage(s) via adapter
      const normalizedMsgs = context.normalizeMessage(transformed, capturedSessionId || sessionId || null);
      for (const msg of normalizedMsgs) {
        sendMessage(ws, msg);
      }

      if (event.type === 'turn.failed' && !terminalFailure) {
        terminalFailure = event.error || new Error('Turn failed');
        errorSurfaced = true;
        // Notifications are app-facing, so they carry the app session id.
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          error: terminalFailure
        });
      }

      if (tokenBudget) {
        sendMessage(ws, createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget, sessionId: capturedSessionId || sessionId || null, provider: 'codex' }));
      }
    }

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const runSession = codexRuntimeState.get(sessionKey() || '');
    const runAborted = runSession?.status === 'aborted' || abortController.signal.aborted;
    if (!runAborted) {
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        actualSessionId: capturedSessionId || thread.id || sessionId || null,
        exitCode: terminalFailure ? 1 : 0,
      }));
      if (!terminalFailure) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          stopReason: 'completed'
        });
        // The turn is over and the user is the next actor: the sidebar's
        // awaiting-reply list says so, for codex exactly as for claude. Read
        // through the shared port so the codex group never imports the
        // providers services directory (that edge would close a directory cycle).
        readSessionAwaitingReplyPort()?.markSessionAwaitingReply(
          sessionId || capturedSessionId || null,
          'completed'
        );
      } else {
        // A turn that ended on `turn.failed` is stopped just the same; the
        // reason is what makes the row say "failed" rather than "finished".
        readSessionAwaitingReplyPort()?.markSessionAwaitingReply(
          sessionId || capturedSessionId || null,
          'failed'
        );
      }
    } else {
      // Aborted by the user: nothing is waiting on them.
      readSessionAwaitingReplyPort()?.clearSessionAwaitingReply(sessionId || capturedSessionId || null);
    }

  } catch (error) {
    const session = codexRuntimeState.get(sessionKey() || '');
    const runError = error instanceof Error ? error : new Error(String(error));
    const wasAborted =
      session?.status === 'aborted' ||
      runError.name === 'AbortError' ||
      runError.message.toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);

      if (!errorSurfaced) {
        // Check if Codex SDK is available for a clearer error message
        const installed = await context.isProviderInstalled();
        const errorContent = !installed
          ? 'Codex CLI is not configured. Please set up authentication first.'
          : runError.message;

        sendMessage(ws, createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'codex' }));
      }
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        exitCode: 1,
      }));
      if (!terminalFailure) {
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          error
        });
      }
      // Reached from the throw as well as from `turn.failed`: whatever made the
      // run stop, the user is the next actor.
      readSessionAwaitingReplyPort()?.markSessionAwaitingReply(
        sessionId || capturedSessionId || null,
        'failed'
      );
    } else {
      // The user stopped it, so nothing is waiting on them — including a mark an
      // outstanding tool approval left on the same session before the abort.
      readSessionAwaitingReplyPort()?.clearSessionAwaitingReply(sessionId || capturedSessionId || null);
    }

  } finally {
    // Update session status
    const finishedKey = sessionKey();
    if (finishedKey) {
      codexRuntimeState.finish(finishedKey);
    }
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
function abortCodexSession(sessionId: string) {
  return codexRuntimeState.abort(sessionId);
}

/**
 * Used by the providers module's CodexProvider to run and abort SDK turns.
 *
 * `permissions` is the facet `provider-runtime.service.resolveToolApproval`
 * fans out to, so a client answer for a resident Codex request reaches the same
 * pending registry the broker parked it on (AC-438). It is the shared
 * `approval-requests.service` instance, not a second registry.
 */
export const codexRuntime = {
  run: queryCodex,
  abort: abortCodexSession,
  permissions: {
    resolve: approvalRequests.resolveToolApproval,
    listPending: approvalRequests.getPendingApprovalsForSession,
    classifyMissingApproval: approvalRequests.classifyMissingApproval,
    readApprovalDecision: approvalRequests.readApprovalDecision,
  },
};

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws: ProviderRuntimeWriter, data: unknown) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

// Clean up old completed sessions periodically
const completedSessionCleanupTimer = setInterval(() => {
  const maxAge = 30 * 60 * 1000; // 30 minutes
  codexRuntimeState.purgeFinished(maxAge);
}, 5 * 60 * 1000); // Every 5 minutes

// Runtime cleanup should not keep focused tests or one-off scripts alive after
// their provider work has completed.
completedSessionCleanupTimer.unref?.();
