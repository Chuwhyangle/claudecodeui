/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { getSessionInfo, query, type Query } from '@anthropic-ai/claude-agent-sdk';

import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  CLAUDE_ULTRACODE_EFFORT
} from '@/modules/providers/list/claude/claude-models.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { resolveModelContextWindowRow, resolveModelLaunchSpec } from '@/modules/providers/services/model-launch-spec.service.js';
import { resolveContextWindow } from '@/modules/providers/services/launch-spec.service.js';
import { createClaudeSessionScopeSpawn } from '@/modules/providers/services/claude-session-scope.service.js';
import { createClaudeTurnTracker } from '@/modules/providers/services/claude-turn-phase.service.js';
import {
  createClaudeTaskReducer,
  earnsTaskTerminalRow,
  type ActivityTask,
  type BackgroundTaskSummary,
  type ClaudeTaskTransition,
} from '@/modules/providers/services/claude-activity-task-reducer.service.js';
import {
  createClaudeScheduleTracker,
  type ActivitySchedule,
  type SessionCronEntry,
} from '@/modules/providers/services/claude-activity-schedules.service.js';
import {
  ClaudeSessionOccupiedError,
  applyLaunchSpecEnv,
  createCompleteMessage,
  createNormalizedMessage,
  findBackgroundSessionOwner,
  resolveClaudeConfigDir,
} from '@/shared/utils.js';
import type {
  AnyRecord,
  ApprovalDecisionRecord,
  MissingApprovalReason,
  NormalizedMessage,
  ProviderModelsDefinition,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import type { TurnState } from '@/modules/providers/services/claude-turn-phase.service.js';

/** The SDK query instance behind one run: the only handle that can interrupt it. */
type ClaudeQuery = Query;

/**
 * The run writer this module is handed, viewed with the socket-swap verb the
 * reconnect path uses.
 *
 * The shared {@link ProviderRuntimeWriter} is the exit contract the run loop
 * needs; a client that reconnects mid-run hands over a writer that also carries
 * `updateWebSocket`, and the optional member keeps this a widening of that
 * contract rather than a second one.
 */
type ClaudeRunWriter = ProviderRuntimeWriter & {
  updateWebSocket?(rawWs: unknown): void;
};

/** One live SDK run, as the process map holds it. */
type ActiveClaudeSession = {
  instance: ClaudeQuery;
  startTime: number;
  status: 'active' | 'aborted';
  writer: ClaudeRunWriter | null;
  /** Closes the held stdin stream so the CLI can exit; absent until it exists. */
  releaseInput?: (() => void) | null;
};

/**
 * A pending tool-approval waiter.
 *
 * The extra fields are the metadata `getPendingApprovalsForSession` replays a
 * pending prompt from, attached to the resolver so one map holds the wait and
 * the facts a reconnecting client needs.
 */
type ToolApprovalResolver = ((decision: AnyRecord | null) => void) & {
  _sessionId?: string | null;
  _toolName?: string;
  _input?: unknown;
  _context?: unknown;
  _receivedAt?: Date;
};

const activeSessions = new Map<string, ActiveClaudeSession>();
const pendingToolApprovals = new Map<string, ToolApprovalResolver>();

/** How many settled approval request ids this process remembers. */
const MAX_REMEMBERED_APPROVALS = 512;

/**
 * The bounded ledger of approval request ids this process has HELD.
 *
 * `pendingToolApprovals` is emptied by `cleanup()` the instant a request
 * settles, so the live map alone cannot tell an id that was here and timed out
 * from one that was never minted — both simply read as absent. AC-287 requires
 * the MCP `approval_answer` surface to report those two apart, so the id is
 * recorded here when the wait is armed and kept after the pending entry is
 * gone. Bounded (oldest first out) so a long-lived process cannot grow the set
 * without limit; an evicted id degrades to the conservative `never_issued`
 * rather than a false `expired`.
 *
 * Consumed by {@link classifyMissingApproval}, which
 * `claudeRuntime.permissions.classifyMissingApproval` exposes to
 * `provider-runtime.service.ts` and, through it, to the MCP approval adapter.
 */
const heldApprovalLedger = new Set<string>();

/** Records `requestId` as held, evicting the oldest id past the cap. */
function rememberHeldApproval(requestId: string): void {
  heldApprovalLedger.delete(requestId);
  heldApprovalLedger.add(requestId);
  if (heldApprovalLedger.size > MAX_REMEMBERED_APPROVALS) {
    const oldest = heldApprovalLedger.values().next().value;
    if (oldest !== undefined) {
      heldApprovalLedger.delete(oldest);
    }
  }
}

/**
 * Classifies a `requestId` that is NOT in the pending registry.
 *
 * `expired` means this process held the request and no longer does (it timed
 * out or was already decided); `never_issued` means nothing here ever minted
 * it. Consumers: `provider-runtime.service.ts` forwards it, and
 * `chat-control.service.ts` / `mcp-approvals.ts` turn it into the
 * `APPROVAL_NOT_FOUND` envelope's `details.reason`.
 */
function classifyMissingApproval(requestId: string): MissingApprovalReason {
  return heldApprovalLedger.has(requestId) ? 'expired' : 'never_issued';
}

/**
 * The bounded ledger of approval request ids this process has DECIDED.
 *
 * `pendingToolApprovals` is deleted the instant a request settles, so a second
 * `approval_answer` for the same id finds nothing and cannot tell "another
 * caller just decided this" from "nothing ever held it" — both read as absent
 * and both collapse to `APPROVAL_EXPIRED_OR_NOT_FOUND`. The MCP surface needs
 * them apart so a client can confirm its own answer landed (or learn, and
 * report, that it lost the race), so the decision is recorded here at settle
 * time, before the resolver runs.
 *
 * Bounded (oldest first out) for the same reason `heldApprovalLedger` is: a
 * long-lived process must not grow it without limit. An evicted id degrades to
 * the conservative `expired`/`never_issued` reading rather than a false
 * `ALREADY_DECIDED`.
 *
 * Consumed by {@link readApprovalDecision}, which
 * `claudeRuntime.permissions.readApprovalDecision` exposes to
 * `provider-runtime.service.ts` and, through it, to `chat-control.service.ts`.
 */
const approvalDecisionLedger = new Map<string, ApprovalDecisionRecord>();

/** Records one settled decision, evicting the oldest entry past the cap. */
function rememberApprovalDecision(requestId: string, record: ApprovalDecisionRecord): void {
  approvalDecisionLedger.delete(requestId);
  approvalDecisionLedger.set(requestId, record);
  if (approvalDecisionLedger.size > MAX_REMEMBERED_APPROVALS) {
    const oldest = approvalDecisionLedger.keys().next().value;
    if (oldest !== undefined) {
      approvalDecisionLedger.delete(oldest);
    }
  }
}

/**
 * The decision this process recorded for a request id, or `null` when it never
 * decided one. A request still awaiting an answer reads `null` — this ledger
 * only ever names requests that were actually settled.
 */
function readApprovalDecision(requestId: string): ApprovalDecisionRecord | null {
  return approvalDecisionLedger.get(requestId) ?? null;
}

/**
 * The SDK query factory every run creates its process through.
 *
 * Held in a module-level binding rather than calling the SDK's `query` directly,
 * so the providers module's tests can substitute a counting double and observe
 * whether a query was created at all — the reading the per-run occupancy gate
 * turns on, where "refused before any process exists" is only meaningful if a
 * refused run really created none. Production never assigns it; it stays the
 * SDK's own `query`.
 *
 * Consumed by `queryClaudeSDK` (both the first attempt and the hooks-retry) and
 * by `claude-per-run-occupied-session.test.ts`.
 */
export const claudeQueryFactory: { current: typeof query } = { current: query };
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set<string>();
// Query instances interrupted because a newer run took over their session id
// (see addSession). Their run loops must stay silent on wind-down: the map
// entry, the abort flag, and all client-facing events belong to the new run.
const supersededInstances = new WeakSet<object>();

/**
 * How long an ordinary (non-interactive) tool approval waits before it is
 * auto-denied, in milliseconds. Read once from the environment.
 *
 * Exported because the MCP gateway has to state this same deadline on the
 * requests it lists (`approvals_list`'s `autoTimeoutMs` and
 * `session_get`'s `pendingInteraction`), and a re-derived copy would be a
 * second answer to the same question.
 */
export const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS as string, 10) || 55000;

// How long background work is allowed to keep running after a turn ends. This drives
// two halves of the same behaviour:
//
//  1. Passed to the spawned CLI as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, which is how
//     long it waits for still-running background *agents* before killing them.
//  2. A backstop on how long we hold the SDK's stdin open after a turn's `result`.
//     The SDK closes stdin as soon as a turn ends, and the CLI reads that EOF as
//     "print wind-down" — killing background *shells* after a short grace period,
//     which the ceiling above does not cover. Holding stdin open also lets the CLI
//     push follow-up turns (background-task completions, Monitor notifications,
//     scheduled wake-ups).
//
// The hold normally ends long before this: a turn with nothing outstanding closes
// stdin immediately, background work releases it as soon as it reports back, and a
// new turn supersedes the previous hold. This ceiling only catches background work
// that never reports at all, so an abandoned session cannot leak a CLI process
// forever. The timer resets on every message, so it measures silence, not total time.
const BG_WAIT_CEILING_MS = 30 * 60 * 1000;

/**
 * The tools whose whole purpose is to ask the person something.
 *
 * Exported because the resident host has to make the same call about the same
 * two names: it is the reading of "this tool call needs a human", and the
 * resident interception has to agree with the per-run one about which tools
 * those are — a second copy would be a second answer.
 */
export const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** How one approval request behaves: who must answer it, and against what clock. */
export type ApprovalPolicy = {
  /** True for a request only a person can answer (`AskUserQuestion`/`ExitPlanMode`). */
  interactive: boolean;
  /**
   * The auto-deny deadline in milliseconds, or `null` when there is none: an
   * interactive request is handed `timeoutMs: 0` (wait forever) by
   * `waitForToolApproval`, so it has no deadline to report.
   */
  autoTimeoutMs: number | null;
};

/**
 * The policy a request for `toolName` runs under.
 *
 * The one place the two facts `approvals_list` entries and
 * `session_get`'s `pendingInteraction` both have to state are derived, so the
 * two surfaces cannot disagree: `interactive` is the
 * {@link TOOLS_REQUIRING_INTERACTION} membership decision the wait itself makes,
 * and `autoTimeoutMs` is the real {@link TOOL_APPROVAL_TIMEOUT_MS} the wait
 * would otherwise run against — never a hard-coded echo.
 *
 * Consumed by `mcp-approvals.ts`.
 */
export function describeApprovalPolicy(toolName: string | null | undefined): ApprovalPolicy {
  const interactive = TOOLS_REQUIRING_INTERACTION.has(toolName ?? '');
  return { interactive, autoTimeoutMs: interactive ? null : TOOL_APPROVAL_TIMEOUT_MS };
}

// Ultracode is a session-scoped setting rather than an SDK effort level: it pairs xhigh
// effort with standing dynamic-workflow orchestration, and the CLI only honours it when
// Workflows are enabled. The catalog offers it as an effort choice for the picker, so the
// selection is translated back into the two options the SDK actually understands here.
const ULTRACODE_SDK_EFFORT = 'xhigh';

function resolveClaudeEffort(
  model: string | null | undefined,
  effort: string | null | undefined,
  modelsDefinition: ProviderModelsDefinition = CLAUDE_PREDEFINED_MODELS,
): string | undefined {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

/**
 * Writes the resolved effort choice onto the SDK options, expanding `ultracode` into the
 * xhigh effort level plus the session-scoped settings it requires.
 * @param {Object} sdkOptions - SDK options being built
 * @param {string|undefined} resolvedEffort - Catalog-validated effort selection
 */
function applyClaudeEffort(sdkOptions: AnyRecord, resolvedEffort: string | undefined): void {
  if (!resolvedEffort) {
    return;
  }

  if (resolvedEffort !== CLAUDE_ULTRACODE_EFFORT) {
    sdkOptions.effort = resolvedEffort;
    return;
  }

  sdkOptions.effort = ULTRACODE_SDK_EFFORT;
  sdkOptions.settings = {
    ...(sdkOptions.settings || {}),
    ultracode: true,
    enableWorkflows: true
  };
}

function createRequestId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

/** The options one tool-approval wait is armed with. */
type ToolApprovalOptions = {
  timeoutMs?: number;
  signal?: AbortSignal | null;
  onCancel?: (reason: string) => void;
  metadata?: AnyRecord | null;
};

function waitForToolApproval(
  requestId: string,
  options: ToolApprovalOptions = {},
): Promise<AnyRecord | null> {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  // Recorded at ARM time, not at settle time: the ledger must still name this id
  // after `cleanup()` deletes the pending entry, which is the whole point.
  rememberHeldApproval(requestId);

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision: AnyRecord | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver: ToolApprovalResolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(
  requestId: string,
  decision: AnyRecord | null,
  decidedBy: string | null = null,
): void {
  const resolver = pendingToolApprovals.get(requestId);
  if (!resolver) {
    // No live wait means nothing was decided — a decision for an id this
    // process is not holding must not enter the ledger, or a later caller would
    // read a settlement that never happened.
    return;
  }
  // Recorded BEFORE the resolver runs, and synchronously with the lookup above:
  // the resolver's `finalize` deletes the pending entry in the same tick, so
  // this is the only point at which a concurrent second caller can still learn
  // the request was decided rather than merely gone.
  rememberApprovalDecision(requestId, {
    decidedAt: Date.now(),
    decidedBy,
    allow: typeof decision?.allow === 'boolean' ? decision.allow : null,
  });
  resolver(decision);
}

/**
 * Asks the attached client to decide one human-facing request.
 *
 * The protocol is the one this module has always used for a tool call — a
 * `permission_request` frame on the run's writer, an `action_required`
 * notification, then a wait on `waitForToolApproval` — and it is factored out
 * rather than duplicated so a *resident* host asks the same question the same
 * way instead of inventing a second request protocol. The resident path needs
 * no new frame kind for elicitation or dialogs: the request travels as the
 * frame's `input` and the caller keeps its own mapping back.
 *
 * Returns the client's own decision object, `{ cancelled: true }` when the wait
 * was aborted, or `null` when it timed out — the three answers the per-run
 * callback has always branched on, so the caller keeps its own branch and its
 * own wording. `permission_resolved` is sent here, before an answer is handed
 * back, for the reason it always was: a mid-run page refresh replays the run
 * buffer, and a prompt with nothing to retract it resurrects.
 *
 * `onCancel` is an extra side effect for a caller that has one — the
 * `permission_cancelled` frame is sent here either way, and both callers (the
 * per-run callback and the resident one) have nothing to add, so its default
 * states the optionality the body's `onCancel?.(reason)` already assumed.
 */
export async function requestClientToolDecision({
  toolName,
  input,
  requiresInteraction,
  requestId,
  ws,
  emitNotification,
  sessionId,
  sessionSummary,
  signal,
  onCancel = undefined,
}: {
  toolName: string;
  input: unknown;
  requiresInteraction: boolean;
  requestId: string;
  ws: ProviderRuntimeWriter | null;
  emitNotification: (event: AnyRecord) => void;
  sessionId: string | null;
  sessionSummary: string | null;
  signal?: AbortSignal | null;
  onCancel?: (reason: string) => void;
}): Promise<AnyRecord | null> {
  ws!.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: sessionId || null, provider: 'claude' }));
  // Fed from here rather than from either caller: this is the one seam both the
  // per-run and the resident path ask a client through, so the tracker's
  // `awaitingPermission` phase (which `overview` and `session_get` read) is the
  // same signal as the prompt above, not a second bookkeeping of it. No session
  // id means no phase to key — the frame still travels with `sessionId: null`.
  if (sessionId) {
    turnTracker.observePermission(sessionId, { kind: 'permission_request', requestId });
  }
  emitNotification(createNotificationEvent({
    provider: 'claude',
    sessionId: sessionId || null,
    kind: 'action_required',
    code: 'permission.required',
    meta: { toolName, sessionName: sessionSummary },
    severity: 'warning',
    requiresUserAction: true,
    dedupeKey: `claude:permission:${sessionId || 'none'}:${requestId}`
  } as unknown as Parameters<typeof createNotificationEvent>[0]));

  let decision: AnyRecord | null = null;
  try {
    decision = await waitForToolApproval(requestId, {
      timeoutMs: requiresInteraction ? 0 : undefined,
      signal,
      metadata: {
        // Keyed by the app session id so `chat.subscribe` can look pending
        // approvals up directly; provider id only for legacy callers.
        _sessionId: sessionId || null,
        _toolName: toolName,
        _input: input,
        _receivedAt: new Date(),
      },
      onCancel: (reason) => {
        ws!.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: sessionId || null, provider: 'claude' }));
        onCancel?.(reason);
      }
    });
  } finally {
    // The wait is over the moment it settles, times out or aborts — the phase
    // must leave `awaitingPermission` in every one of those cases, or the
    // session would read as still parked on a prompt nobody is waiting on.
    if (sessionId) {
      turnTracker.observePermission(sessionId, { kind: 'permission_resolved', requestId });
    }
  }
  if (!decision) {
    return null;
  }
  if (decision.cancelled) {
    return { cancelled: true };
  }

  ws!.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: sessionId || null, provider: 'claude' }));
  return decision;
}

/**
 * Announces one human-facing permission request on a run's writer and feeds the
 * Turn Tracker in the same breath.
 *
 * Built here, and exported, because this module owns the two things the debug
 * agent may not name: the wire frame (`permission_request`, constructed through
 * `createNormalizedMessage`) and the module-level `turnTracker` the activity
 * dock reads its phase from. The debug agent's own sources must contain no wire
 * name at all (ADR-003 decision 7, pinned by `debug-agent-vocabulary-guard`), so
 * `provider.registry.ts` injects this function as the debug agent's announcer
 * and the debug scenario's `permission-request` step calls through it.
 *
 * Frame and tracker travel together here — unlike {@link requestClientToolDecision},
 * where they are deliberately split because the tracker must leave
 * `awaitingPermission` on a timeout or an abort even when no frame goes out. A
 * debug prompt has no such second source: the frame IS the prompt and the tracker
 * feed IS its phase, so one call states both, and a prompt a client can see but
 * the overview cannot is impossible by construction.
 */
export function announceNormalizedPermission(input: {
  sessionId: string | null;
  requestId: string;
  toolName: string;
  input: unknown;
  ws: ProviderRuntimeWriter;
}): void {
  input.ws.send(createNormalizedMessage({
    kind: 'permission_request',
    requestId: input.requestId,
    toolName: input.toolName,
    input: input.input,
    sessionId: input.sessionId || null,
    provider: 'claude',
  }));
  if (input.sessionId) {
    turnTracker.observePermission(input.sessionId, { kind: 'permission_request', requestId: input.requestId });
  }
}

/**
 * Retracts a permission request announced by {@link announceNormalizedPermission}
 * — the frame that clears the client's prompt, plus the tracker feed that leaves
 * `awaitingPermission`.
 *
 * The counterpart of the function above, built here for the same reason: both
 * halves are this module's vocabulary and this module's tracker, so the debug
 * agent reaches them through the injected announcer rather than spelling either.
 */
export function announceNormalizedPermissionResolved(input: {
  sessionId: string | null;
  requestId: string;
  ws: ProviderRuntimeWriter;
}): void {
  input.ws.send(createNormalizedMessage({
    kind: 'permission_resolved',
    requestId: input.requestId,
    sessionId: input.sessionId || null,
    provider: 'claude',
  }));
  if (input.sessionId) {
    turnTracker.observePermission(input.sessionId, { kind: 'permission_resolved', requestId: input.requestId });
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry: string | null | undefined, toolName: string | null | undefined, input: unknown): boolean {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof (input as AnyRecord).command === 'string') {
      command = (input as AnyRecord).command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/**
 * The title a session should answer to, or null to hand the CLI none.
 *
 * The value is the session's *own* Claude Code title and deliberately not the
 * display name this app has cached on the session row. Handing the cached name
 * over would pin every process to a string the app invented, which is the
 * failure this exists to remove.
 *
 * **It has to be a title, not the reading `summary` hands back.** `summary` is
 * the SDK's ladder over the transcript — `customTitle || aiTitle ||
 * lastPrompt || summaryHint || firstPrompt` — so it answers a question nobody
 * asked here: every session has a value, because the last rung is the session's
 * first prompt verbatim. A session that has not been named yet therefore reads
 * back as something that looks like a title, gets handed to the CLI, and the CLI
 * adopts it as a `custom-title`. That is worse than handing nothing over: a
 * `custom-title` is a rung the app reads as an override, so it outranks the
 * `ai-title` and the session is frozen under its own first prompt —
 * `getSessionInfo().summary` then returns the frozen string forever, and every
 * later round re-hands it. Measured on one machine: 18 of 522 sessions in 48
 * hours had an `ai-title`; the other 504 would each have frozen their first
 * prompt.
 *
 * `customTitle` is the rung that means "this session has a title": the SDK
 * compiles it as `customTitle || aiTitle`, so it is set by a generated title and
 * by a `/rename` alike, and undefined when the ladder falls through to a prompt.
 * That is the rung `readSessionTitle` names as its authority, and it is what a
 * renamed session has too, so a human's word still travels.
 *
 * The title is passed from the *second* round onwards, never on the round that
 * creates the session, because the SDK skips automatic title generation entirely
 * when a title is handed to it: a launch that supplied one at creation would
 * leave the session with nothing to adopt. That falls out of the same gate
 * rather than needing a round counter — the round that creates a session is the
 * round a title is being generated for, so there is none to read yet. A session
 * with no provider id (brand-new, or never resumed by this app) returns before
 * touching the disk, which is every first round.
 *
 * A reading that throws is not a launch failure: a process started without a
 * title is the behaviour that shipped before this, and it is still correct.
 */
export async function resolveClaudeSessionTitle(
  providerSessionId: string | null | undefined,
  projectPath: string | null | undefined,
): Promise<string | null> {
  if (!providerSessionId || !projectPath) {
    return null;
  }

  try {
    const info = await getSessionInfo(providerSessionId, { dir: projectPath });
    const title = typeof info?.customTitle === 'string' ? info.customTitle.trim() : '';
    return title.length > 0 ? title : null;
  } catch (error) {
    console.warn('[Claude SDK] Unable to read the session title:', (error as Error)?.message ?? error);
    return null;
  }
}

function mapCliOptionsToSDK(options: AnyRecord = {}): AnyRecord {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort, resumeAnchorId, resumeFromScratch, sessionTitle } = options;

  const sdkOptions: AnyRecord = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  const modelSpec = resolveModelLaunchSpec('claude', options.model);
  // The selected custom model's entry overlays the host env; its `unset` rows delete keys from the final object.
  sdkOptions.env = applyLaunchSpecEnv(
    applyLaunchSpecEnv({ ...process.env }, modelSpec),
    { env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(BG_WAIT_CEILING_MS) } },
  );

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  // When nothing resolves the option stays unset on purpose: the SDK then falls back to the
  // binary it ships, which beats handing it a bare `claude` that raw spawn can never launch.
  const claudeExecutablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (claudeExecutablePath) {
    sdkOptions.pathToClaudeCodeExecutable = claudeExecutablePath;
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;

  applyClaudeEffort(sdkOptions, resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_PREDEFINED_MODELS,
  ));

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The session's own title, handed back to the CLI so the process registers
  // under it. The CLI keeps a ladder for a process's name and reserves
  // `nameSource: "auto"` for a title it adopted rather than one a user typed, so
  // this is what makes an addressable process answer to the same phrase the
  // session already shows — instead of the directory-plus-two-characters name it
  // derives when it is given nothing.
  //
  // Only the authority is handed over, never an app-side invention: the caller
  // resolved this from the session's own transcript, and a session without a
  // title yet hands over nothing at all (see `resolveClaudeSessionTitle`).
  if (sessionTitle) {
    sdkOptions.title = sessionTitle;
  }

  // Anthropic's raw streaming events are opt-in: without this the SDK hands the
  // host only settled messages, so a reply reaches the client as one finished
  // block and nothing downstream can see it arrive. The frames are transient —
  // the normalizer turns them into `stream_delta`/`stream_end` for the wire and
  // drops everything else, and the CLI does not write them to the transcript,
  // which still lands the whole `assistant` record as its authority.
  sdkOptions.includePartialMessages = true;

  // The SDK resumes with the provider-native session id, never the app id.
  // `resumeFromScratch` is set when the very first prompt of a conversation was
  // edited: there is nothing before it to resume through, so the turn has to
  // start the conversation over instead.
  if (providerSessionId && !resumeFromScratch) {
    sdkOptions.resume = providerSessionId;

    // Editing an already-sent message re-runs the conversation truncated just
    // before it. `resumeSessionAt` is inclusive of the uuid it names, so the
    // caller resolves the last row to KEEP and passes that — never the edited
    // turn itself, which would leave the original prompt in context.
    if (resumeAnchorId) {
      sdkOptions.resumeSessionAt = resumeAnchorId;
    }
  }

  // Give every session its own capped systemd scope, so a runaway CLI or MCP server is reaped
  // alone instead of taking the server's own cgroup down with it. On a host with no usable systemd
  // user manager the factory returns undefined and the option is left unset, which keeps the
  // spawn path exactly as it is today.
  const spawnClaudeCodeProcess = createClaudeSessionScopeSpawn();
  if (spawnClaudeCodeProcess) {
    sdkOptions.spawnClaudeCodeProcess = spawnClaudeCodeProcess;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 * @param {Function} releaseInput - Closes the held stdin stream so the CLI can exit
 */
function addSession(
  sessionId: string | null,
  queryInstance: ClaudeQuery,
  writer: ClaudeRunWriter | null = null,
  releaseInput: (() => void) | null = null,
): void {
  const existing = activeSessions.get(sessionId as string);
  // A different live instance under the same key means an earlier run was
  // superseded without being stopped (e.g. an abort that raced run setup and
  // found nothing to interrupt). Overwriting it here would strand its
  // generator forever — this map entry is the only handle for interrupting
  // it. Stop it directly rather than via abortClaudeSDKSession, whose
  // session-keyed abortedSessionIds flag would be consumed by the new run
  // and suppress its terminal `complete`.
  const superseding = Boolean(
    existing && existing.status === 'active' && existing.instance && existing.instance !== queryInstance
  );
  if (superseding) {
    supersededInstances.add(existing!.instance);
    Promise.resolve()
      .then(() => existing!.instance.interrupt())
      .catch((error) => {
        console.error(`Error interrupting superseded run for session ${sessionId}:`, error?.message || error);
      });
    existing!.releaseInput?.();
  }
  const carried = superseding ? null : existing;
  activeSessions.set(sessionId as string, {
    instance: queryInstance,
    startTime: carried?.startTime || Date.now(),
    status: 'active',
    writer,
    // Re-registered mid-run once the provider session id lands; keep the closer.
    releaseInput: releaseInput || carried?.releaseInput || null
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId: string): void {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId: string): ActiveClaudeSession | undefined {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions(): string[] {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage: AnyRecord): AnyRecord {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * True for the user bubble the SDK echoes for a subagent's own prompt.
 *
 * Subagent traffic carries `parent_tool_use_id`, so this echo lands in the main
 * thread and stacks a second copy of the prompt right below the Agent tool card
 * that already displays it. It also disappears on reload, because the transcript
 * keeps that turn in the subagent's sidechain rather than the session file.
 * @param {Object} message - Normalized message about to be sent to the client
 * @returns {boolean}
 */
export function isSubagentPromptEcho(message: AnyRecord): boolean {
  return Boolean(message?.parentToolUseId) && message.role === 'user' && message.kind === 'text';
}

/**
 * Per-writer bookkeeping for the block a live stream is currently inside.
 *
 * The live frames of one assistant message carry no identity that connects them
 * to the transcript row they settle into: a `stream_delta` is keyed only by the
 * SDK's random frame id, and the settled block-level `assistant` record names no
 * index at all. The join key is assembled here — `<message.id>:<index>` — out of
 * the Anthropic streaming envelope the normalizer throws away:
 * `message_start` names the message id, `content_block_start` names the index of
 * the block being opened, `content_block_stop` closes it, and `message_stop` ends
 * the message.
 *
 * Keyed by the *writer*, not stored on the provider, because
 * `forwardNormalizedFrames` is the one exit the per-run and resident paths share
 * and the writer is the only handle both reach that also bounds the state's
 * lifetime. Keeping it off `ClaudeSessionsProvider` is required, not stylistic:
 * that normalizer also serves history reads, so a tracker living there would
 * stamp history rows with whatever block a concurrent live run happened to have
 * open.
 *
 * Scope is `(sessionId, parentToolUseId)`: a subagent's stream events travel with
 * a `parent_tool_use_id`, and one session's frames must never read another's open
 * block.
 */
/** The block one writer's stream is currently inside, under one scope key. */
type OpenStreamBlock = { messageId: string | null; index: number | null };

const streamBlockTrackers = new WeakMap<ProviderRuntimeWriter, Map<string, OpenStreamBlock>>();

/** The scope key one session + subagent pair's open block is tracked under. */
function blockScopeKey(sessionId: string | null | undefined, parentToolUseId: string | null | undefined): string {
  return `${sessionId ?? ''}\u0000${parentToolUseId ?? ''}`;
}

/** The open-block tracker for one writer, created on first use. */
function blockTrackerFor(writer: ProviderRuntimeWriter): Map<string, OpenStreamBlock> {
  let tracker = streamBlockTrackers.get(writer);
  if (!tracker) {
    tracker = new Map<string, OpenStreamBlock>();
    streamBlockTrackers.set(writer, tracker);
  }
  return tracker;
}

/** The Anthropic streaming event inside an SDK frame, or null for a settled record. */
function readStreamingEvent(rawMessage: AnyRecord | null | undefined): AnyRecord | null {
  return rawMessage?.type === 'stream_event' ? rawMessage.event : null;
}

/**
 * Folds one SDK frame into a writer's open-block state and returns the
 * `blockKey` the frames it normalizes to should carry, if any.
 *
 * The key is read before the frame's own close takes effect on purpose: the
 * settled `assistant` record that ends a block arrives *before* the
 * `content_block_stop` that closes it (measured against SDK 0.3.165), so the
 * block those frames belong to is still the open one when they are ranked.
 *
 * @param {Object} params
 * @param {Object} params.writer - Run writer the state is scoped to
 * @param {string|null} params.sessionId - Session the event belongs to
 * @param {string|null} params.parentToolUseId - Subagent the event belongs to, when any
 * @param {Object} params.rawMessage - SDK frame, after transformMessage
 * @returns {string|null} `"<message.id>:<index>"`, or null when no block is open
 */
function trackStreamBlock({ writer, sessionId, parentToolUseId, rawMessage }: {
  writer: ProviderRuntimeWriter | null | undefined;
  sessionId: string | null | undefined;
  parentToolUseId: string | null | undefined;
  rawMessage: AnyRecord | null | undefined;
}): string | null {
  // The tracker is keyed by the writer, so a caller with no writer (a headless
  // replay, say) simply gets no key rather than a shared global one.
  if (!writer || (typeof writer !== 'object' && typeof writer !== 'function')) {
    return null;
  }

  const tracker = blockTrackerFor(writer);
  const scopeKey = blockScopeKey(sessionId, parentToolUseId);
  const open = tracker.get(scopeKey) || null;
  const keyFor = (index: unknown) => (
    open && typeof open.messageId === 'string' && Number.isInteger(index)
      ? `${open.messageId}:${index}`
      : null
  );

  const event = readStreamingEvent(rawMessage);

  // A settled record is not a streaming event: only the block-level `assistant`
  // message is a candidate, and it is assigned to whichever block is still open.
  // An `assistant` arriving with nothing open is a record this state knows no
  // block for, so it carries no key rather than inheriting the last one.
  if (!event) {
    return rawMessage?.type === 'assistant' ? keyFor(open?.index) : null;
  }

  switch (event.type) {
    case 'message_start': {
      const messageId = event.message?.id;
      tracker.set(scopeKey, {
        messageId: typeof messageId === 'string' ? messageId : null,
        index: null,
      });
      return null;
    }
    case 'content_block_start': {
      if (open) {
        open.index = Number.isInteger(event.index) ? event.index : null;
      }
      return null;
    }
    case 'content_block_delta':
      return keyFor(open?.index);
    case 'content_block_stop': {
      const key = keyFor(open?.index);
      // Close only after the closing `stream_end` has been ranked with this
      // block's key.
      if (open) {
        open.index = null;
      }
      return key;
    }
    case 'message_stop': {
      // The message is over; drop its entry so a finished conversation leaves
      // nothing behind for the next one — or the next test — to read.
      tracker.delete(scopeKey);
      return null;
    }
    default:
      return null;
  }
}

/**
 * The frame kinds that carry a block's identity: the streaming fragments, the
 * `stream_end` that closes the block, and the settled record the block becomes.
 * Anything else a normalizer may emit for the same event stays unkeyed.
 */
const BLOCK_KEYED_KINDS = new Set(['stream_delta', 'stream_end', 'text', 'thinking', 'tool_use']);

/**
 * Counts the sessions/subagents a writer still has an open block tracked for.
 *
 * Exposed for the providers module's tests: "the state does not leak" is a claim
 * about this bookkeeping, and the only way a case can assert it directly is to
 * read the bookkeeping — a tracker that kept every finished message's entry
 * would still hand out correct keys and look green from the wire alone.
 *
 * @param {Object} writer - Run writer whose tracker is inspected
 * @returns {number} Number of live scope entries, zero once every message has stopped
 */
export function countOpenStreamBlocks(writer: ProviderRuntimeWriter): number {
  const tracker = streamBlockTrackers.get(writer);
  return tracker ? tracker.size : 0;
}

/**
 * The session turn tracker this module feeds from the forwarder below.
 *
 * Module-level and singleton on purpose: the phase belongs to the *server*, not
 * to one run, because the frames that read it back (`activity-heartbeat.service`)
 * are sent on a timer that outlives any single run's writer. State is still keyed
 * per session inside the tracker, so two sessions cannot read each other's phase.
 *
 * It is keyed by the **app session id** — the stable id a browser subscribes with
 * and the activity heartbeat transports under (`activity-heartbeat.service.ts` →
 * `readSessionTurn`). The forwarder feeds it under that same id (`turnSessionId`),
 * which is what lets a read find the phase of a turn that is genuinely running
 * instead of missing on every frame and reporting `idle`. See
 * `forwardNormalizedFrames` for why the routing id and the tracked id are not the
 * same value on the real run loop.
 *
 * It lives here rather than in a service of its own because this file already
 * owns the one seam both the real run loop and the debug agent's rows cross
 * (`forwardNormalizedFrames`), and the tracker is that seam's reading — see
 * `claude-turn-phase.service.ts` for the reduction itself.
 */
const turnTracker = createClaudeTurnTracker();

/**
 * The two per-session read models the activity dock's background half is built
 * from: the Task table (AC-191) and the Schedule table (AC-192).
 *
 * Module-level and singleton for the same reason `turnTracker` is: they are the
 * *server's* account of what a session is holding, and the frames that read them
 * back (the activity protocol's snapshot and upserts) outlive any single run.
 * Both are fed at the one seam every run — real and debug — already crosses
 * (`forwardNormalizedFrames` below), so a scenario's rows and a real SDK frame
 * take the identical path into them. State is keyed per session inside each
 * reducer, so two sessions cannot read each other's tables.
 */
const taskReducer = createClaudeTaskReducer();
const scheduleTracker = createClaudeScheduleTracker();

/**
 * The revision tick the activity protocol is told about when a task or a
 * schedule actually changes.
 *
 * Injected rather than imported because the protocol's store lives in the
 * websocket module, which imports this one (its heartbeat reads `readSessionTurn`)
 * — importing it back would close a cycle. `server/index.ts`, which holds both,
 * installs the tick at boot: `(sessionId) => activityStore.recordChange(sessionId)`.
 * Until something is installed a change is simply not announced, which is what a
 * headless criterion that drives the forwarder directly wants.
 */
let activityChangeNotifier: ((sessionId: string) => void) | null = null;

/** Installs the process-wide activity-change tick, or clears it with `null`. */
export function setActivityChangeNotifier(notifier: ((sessionId: string) => void) | null): void {
  activityChangeNotifier = notifier;
}

/**
 * The same tick, for a producer that holds its own reading rather than one here.
 *
 * The resident host driver keeps the delivery ledger — the per-host account of
 * every send and every turn the CLI ran for it — and projects it for the activity
 * channel itself (the delivery state channel, SPEC §7.1). It builds that
 * projection inside its own module, across the file edge this one owns, so it
 * cannot reach the installed tick directly; the tick is a module-private binding
 * precisely so there is one announcement path, and this is `setActivityChangeNotifier`
 * called from the driver's side rather than a second notifier grown beside it.
 *
 * Exported rather than folded into `setActivityChangeNotifier` because the two
 * verbs are different: a composition root *installs* the tick, a producer *fires*
 * it. Untyped in the same way the task/schedule path is — until something is
 * installed, a change is simply not announced, which is what a headless criterion
 * that drives a driver directly wants.
 */
export function notifyActivityChange(sessionId: string): void {
  activityChangeNotifier?.(sessionId);
}

/** The Task table for one session, as the Task Reducer holds it. */
export function readSessionTasks(sessionId: string): ActivityTask[] {
  return taskReducer.getTasks(sessionId);
}

/** The Schedule table for one session, as the Schedule Tracker holds it. */
export function readSessionSchedules(sessionId: string): ActivitySchedule[] {
  return scheduleTracker.getSchedules(sessionId);
}

/**
 * Reconciles both tables against a `Stop` hook firing's snapshot.
 *
 * The hook's two lists are each authoritative only when present: an absent key is
 * the CLI saying nothing about that kind, not saying it holds none (the same rule
 * the host driver's `reconcileHeldWork` applies to its lease ledger). A caller
 * passes the raw hook input and this decides; `undefined` is a no-op for that
 * kind.
 */
export function reconcileSessionHeldWork(
  sessionId: string,
  input: { backgroundTasks?: unknown; sessionCrons?: unknown },
): void {
  if (!sessionId) {
    return;
  }
  if (Array.isArray(input.backgroundTasks)) {
    taskReducer.reconcileStopHook(sessionId, input.backgroundTasks as BackgroundTaskSummary[]);
  }
  if (Array.isArray(input.sessionCrons)) {
    scheduleTracker.reconcileStopHook(sessionId, input.sessionCrons as SessionCronEntry[]);
  }
  activityChangeNotifier?.(sessionId);
}

/** A stable signature of a table, for "did this frame change anything" without a clock. */
function activitySignature(tasks: ActivityTask[], schedules: ActivitySchedule[]): string {
  return JSON.stringify([tasks, schedules]);
}

/**
 * The phase a session's turn is in, as the last frame through the forwarder left it.
 *
 * A session the forwarder has never seen reads `idle`, which is the honest answer:
 * nothing has told this process the session is doing anything.
 */
export function readSessionTurn(sessionId: string): TurnState {
  return turnTracker.getTurn(sessionId);
}

/**
 * The `tool_use.id` of a session's currently pending foreground tool, or `null`.
 *
 * Companion to {@link readSessionTurn} over the same module-level tracker, and
 * the addressing seam AC-197's `chat.background-task` reads: the control handler
 * accepts a background request only when the requested `toolUseId` equals this,
 * which is what makes the request address a *running foreground tool* rather
 * than a row in the task table (a foreground tool is not a task until the CLI
 * backgrounds it). Consumed by the websocket module's chat handler and by AC-197's
 * criterion (`server/modules/websocket/tests/chat-background-task.test.ts`).
 */
export function readSessionForegroundToolUseId(sessionId: string): string | null {
  return turnTracker.getPendingToolUseId(sessionId);
}

/**
 * The one-line result a terminal transition shows when no frame supplied a summary.
 *
 * Each label carries the terminal state's own word, so a row built from this
 * fallback says what happened without the client having to add it — and the
 * client's own "does this summary already name a status" rule
 * (`MessageComponent.tsx`) therefore leaves it alone rather than prefixing it a
 * second time.
 */
function defaultTerminalSummary(transition: ClaudeTaskTransition): string {
  const label = transition.description.trim() || transition.taskId;
  switch (transition.to) {
    case 'completed':
      return `Background task completed: ${label}`;
    case 'failed':
      return `Background task failed: ${label}`;
    case 'stopped':
      return `Background task stopped: ${label}`;
    case 'ended':
      return `Background task ended: ${label}`;
    default:
      return `Background task update: ${label}`;
  }
}

/**
 * Turns one terminal transition into the normalized `task_notification` frame the
 * transcript renders.
 *
 * The `id` is derived from the task id and its terminal state, so the same
 * transition always yields the same frame id — the server sends it exactly once
 * (the reducer reports a crossing once), and a replay carries the same id rather
 * than minting a new row. `taskId` is stamped so the row stays joinable to the
 * dock's task table.
 */
function buildTaskTerminalFrame(transition: ClaudeTaskTransition, sessionId: string | null): NormalizedMessage {
  const frame = createNormalizedMessage({
    id: `task-terminal:${transition.taskId}:${transition.to}`,
    kind: 'task_notification',
    provider: 'claude',
    sessionId,
    status: transition.to,
    summary: transition.summary ?? defaultTerminalSummary(transition),
    taskId: transition.taskId,
  });
  // Prefer the frame-supplied end time so the transcript row orders where the task
  // really ended; fall back to the writer's own stamp when no frame carried one.
  if (transition.endedAt !== undefined) {
    frame.timestamp = new Date(transition.endedAt).toISOString();
  }
  return frame;
}

/**
 * Hands every normalized frame of one SDK message to the run writer, in order.
 *
 * This is the seam the partial-stream path rests on: the normalizer decides what
 * an SDK frame becomes and the writer decides where it goes, and nothing else
 * connects the two. The loop lives here — with the normalizer and the writer both
 * passed in — so a test can drive it with a fake writer and prove the frames
 * really leave. `stream_delta` is the frame that matters most: it carries the
 * in-place transcript growth the client renders, and a dropped `writer.send`
 * forward would leave the normalizer's own tests green.
 *
 * `parentToolUseId` is copied from the SDK wrapper onto frames that lack one so
 * subagent traffic stays grouped under the tool card that spawned it, and the
 * subagent's own prompt echo is dropped rather than stacked as a second user
 * bubble (see {@link isSubagentPromptEcho}).
 *
 * Frames of the block this event belongs to are stamped with that block's
 * `blockKey` (see {@link trackStreamBlock}) — the streaming fragments, the
 * closing `stream_end`, and the settled record alike. The key is assigned to
 * `msg.blockKey` rather than baked into the normalizer so the history reads that
 * share that normalizer can never carry one.
 *
 * The turn tracker is fed under `turnSessionId` — the *stable app session id* —
 * and not under `sessionId`. Those are two different id spaces: `sessionId` is
 * whatever id the normalizer and the run writer address the run by (on the real
 * run loop that is the provider-native id the SDK reports), while the activity
 * frames read the phase back under the **app session id** the browser
 * subscribes with (`activity-heartbeat.service.ts` → `readSessionTurn`). Feeding
 * the tracker the provider id while reading it with the app id meant every read
 * missed and reported `idle` for a turn that was genuinely running, which is why
 * the dock stayed on the fallback `Working…` label and never timed. Keying the
 * tracker by the app id is the one id space both ends already share; a caller
 * that only has a provider-native id (a legacy/direct API caller with no app
 * session) falls back to it, and the reader has no app id to read it with then
 * either.
 *
 * A task that this frame moved from a non-terminal state into a terminal one adds
 * one more frame after the normalized ones: a `task_notification` line (see
 * {@link buildTaskTerminalFrame}), built from the transition the Task Reducer
 * reports. It travels this same writer, so it is sequenced and buffered for
 * `chat.subscribe` replay like any other frame and a reconnecting client sees the
 * line — which is the point of emitting it here rather than from a client-side
 * "the task table changed" guess. Only a **background** task's crossing earns the
 * line, and only for a kind the CLI does not already mirror into its own
 * `<task-notification>` row; see {@link earnsTaskTerminalRow}.
 *
 * @param {Object} params
 * @param {Object} params.transformedMessage - SDK message, after transformMessage
 * @param {string|null} params.sessionId - Id the frames are routed/normalized under
 * @param {string|null} [params.turnSessionId] - Stable app session id the turn phase is keyed by; defaults to `sessionId`
 * @param {Function} params.normalizeMessage - Provider normalizer, `(raw, sessionId) => NormalizedMessage[]`
 * @param {Object} params.writer - Run writer (the socket connection); only its `send(message)` is used
 */
export function forwardNormalizedFrames({ transformedMessage, sessionId, turnSessionId, normalizeMessage, writer, runsTaskTerminalRow = earnsTaskTerminalRow }: {
  transformedMessage: AnyRecord;
  sessionId: string | null;
  turnSessionId?: string | null;
  normalizeMessage: (raw: unknown, sessionId: string | null) => AnyRecord[];
  writer: ProviderRuntimeWriter;
  /**
   * The criterion deciding whether a terminal transition is worth a transcript
   * line; defaults to the shipped one ({@link earnsTaskTerminalRow}). Injected for
   * the same reason `normalizeMessage` and `writer` are: the criterion's false
   * form replaces it with a constant, and the case that must red is then a
   * reading of the real forwarding loop rather than of a re-implementation.
   */
  runsTaskTerminalRow?: (transition: ClaudeTaskTransition) => boolean;
}): void {
  // Fold the raw frame into the session's turn phase before it is normalized.
  // This is the one seam both the real run loop and the debug agent's rows pass
  // through, and it is the only place that sees the signals the normalizer drops
  // on purpose (`system/thinking_tokens` normalizes to nothing). The phase it
  // records is read back by the activity frames (`activity-heartbeat.service.ts`),
  // which is how a browser learns what a running turn is *actually* doing.
  const trackedSessionId = turnSessionId ?? sessionId;
  // The terminal transitions this one frame produced; sent as transcript frames
  // below, after the frame's own normalized output, so the "task stopped" line
  // lands behind whatever the triggering frame drew.
  let taskTransitions: ClaudeTaskTransition[] = [];
  if (trackedSessionId) {
    turnTracker.observe(trackedSessionId, transformedMessage);

    // The two background read models are fed here too, at the same seam, under
    // the same id. They are deliberately not folded into the turn tracker: a
    // task outlives the turn that started it, and the dock reads it between
    // turns. A frame that actually moved either table ticks the activity
    // protocol, which is what pushes a whole-snapshot upsert to the browser
    // without a reload.
    const before = activitySignature(
      taskReducer.getTasks(trackedSessionId),
      scheduleTracker.getSchedules(trackedSessionId),
    );
    taskTransitions = taskReducer.observe(trackedSessionId, transformedMessage);
    scheduleTracker.observe(trackedSessionId, transformedMessage);
    const after = activitySignature(
      taskReducer.getTasks(trackedSessionId),
      scheduleTracker.getSchedules(trackedSessionId),
    );
    if (before !== after) {
      activityChangeNotifier?.(trackedSessionId);
    }
  }

  const blockKey = trackStreamBlock({
    writer,
    sessionId,
    parentToolUseId: transformedMessage?.parentToolUseId,
    rawMessage: transformedMessage,
  });

  const normalized = normalizeMessage(transformedMessage, sessionId);
  for (const msg of normalized) {
    // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
    if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
      msg.parentToolUseId = transformedMessage.parentToolUseId;
    }
    if (isSubagentPromptEcho(msg)) {
      continue;
    }
    if (blockKey && BLOCK_KEYED_KINDS.has(msg.kind)) {
      msg.blockKey = blockKey;
    }
    writer.send(msg);
  }

  // A **background** task that just crossed into a terminal state leaves one
  // transcript line, produced here from the reducer's own transition rather than
  // by any client-side "the task table changed" guess — so it lands in the same
  // `chat.subscribe` seq stream as every other frame and survives a
  // reload/reconnect replay. A foreground command's end earns no line: its result
  // is already on its own tool card, and the extra row would both duplicate it and
  // cut the surrounding work segment in half. Kinds the CLI already notifies about
  // are skipped too, so a subagent or Monitor never gets a second line beside the
  // CLI's own row. The decision is {@link earnsTaskTerminalRow}'s.
  for (const transition of taskTransitions) {
    if (!runsTaskTerminalRow(transition)) {
      continue;
    }
    writer.send(buildTaskTerminalFrame(transition, sessionId));
  }
}

function readNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The context-window budget one message reports.
 *
 * `used` is `inputTokens + outputTokens` where `inputTokens` folds in the
 * cache-read and cache-creation halves of the prompt, and `total` is the
 * selected model entry's context window — the same two numbers the composer
 * counter renders.
 */
type TokenBudget = {
  used: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheTokens?: number;
  breakdown: { input: number; output: number };
};

/**
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @param {number|string} [profileContextWindow] - Selected model entry's CLAUDE_CODE_MAX_CONTEXT_TOKENS row
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage: AnyRecord, profileContextWindow?: number | string): TokenBudget {
  const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
  const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
  const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
  const contextWindow = resolveContextWindow(profileContextWindow);

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Extracts the session's context-window usage from an SDK stream message.
 *
 * Only assistant messages describe the context window: each one reports the
 * prompt its own request carried. The turn-ending `result` is deliberately not
 * a source here — see `extractCumulativeTokenBudget`.
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|string} [profileContextWindow] - Selected model entry's CLAUDE_CODE_MAX_CONTEXT_TOKENS row
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage: AnyRecord | null | undefined, profileContextWindow?: number | string): TokenBudget | null {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent traffic (parent_tool_use_id set) reports the subagent's own
  // context window, not this session's — surfacing it makes the counter drop
  // to the subagent's number and bounce back on the next main-thread event.
  if (sdkMessage.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (sdkMessage.type !== 'assistant') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage;
  if (!messageUsage || typeof messageUsage !== 'object') {
    return null;
  }

  return buildTokenBudget(messageUsage, profileContextWindow);
}

/**
 * Last-resort budget read from a turn's `result` message.
 *
 * `result.usage` and `result.modelUsage` are the turn's *bill*: every request
 * the turn made, summed, including each subagent's. A turn that made four
 * requests therefore reports roughly four times the context the conversation
 * actually holds, so publishing it made the counter leap at the end of a turn
 * and fall back on the next assistant message — worst with subagents running,
 * whose requests inflate the sum without ever entering this session's context.
 *
 * It is still the only usage an SDK build that reports none per assistant
 * message ever emits, so it stays available for the caller to use when a turn
 * produced no assistant budget at all.
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|string} [profileContextWindow] - Selected model entry's CLAUDE_CODE_MAX_CONTEXT_TOKENS row
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractCumulativeTokenBudget(sdkMessage: AnyRecord | null | undefined, profileContextWindow?: number | string): TokenBudget | null {
  if (!sdkMessage || typeof sdkMessage !== 'object' || sdkMessage.type !== 'result') {
    return null;
  }

  if (sdkMessage.usage && typeof sdkMessage.usage === 'object') {
    return buildTokenBudget(sdkMessage.usage, profileContextWindow);
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = resolveContextWindow(profileContextWindow);

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

// Tool calls that leave work running past the end of a turn. Bash and Agent only
// count when they are backgrounded; the rest defer or watch work by nature.
// Workflow belongs here rather than in a branch of its own: its input schema has
// no foreground option at all, so every call returns a task id immediately and
// reports back in a later turn.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'TaskCreate', 'Workflow']);

/**
 * Detects tool calls that keep working after the turn's `result` arrives.
 *
 * Only turns that start background work need their CLI process held open; every
 * other turn can let it exit immediately, as it did before the hold existed.
 *
 * Used by the providers module's tests, which pin the tool matching directly:
 * the alternative is driving a whole SDK run to observe whether stdin was held,
 * and the cost of getting this wrong is silently killed background work.
 *
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|string} [profileContextWindow] - Selected model entry's CLAUDE_CODE_MAX_CONTEXT_TOKENS row
 * @returns {boolean} True when the message launches work that outlives the turn
 */
export function startsBackgroundWork(sdkMessage: AnyRecord): boolean {
  const content = sdkMessage?.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
    if (block?.type !== 'tool_use') {
      return false;
    }
    if (block.name === 'Bash') {
      return block.input?.run_in_background === true;
    }
    // A backgrounded subagent outlives the turn exactly like a backgrounded
    // Bash does, so the process has to be held open for it to report back.
    // Agents background by default — `run_in_background` is optional and only
    // an explicit `false` opts out — hence `!== false` rather than `=== true`.
    // A foreground agent must stay out of DEFERRED_WORK_TOOLS: it never pushes
    // a follow-up turn, so it would pin the process for the full ceiling.
    if (block.name === 'Agent') {
      return block.input?.run_in_background !== false;
    }
    return DEFERRED_WORK_TOOLS.has(block.name);
  });
}

/**
 * Builds the SDK user messages for one turn.
 *
 * Always returns SDKUserMessage records rather than a bare string: a string
 * prompt makes the SDK flag the query as single-turn and close stdin the moment
 * the turn's `result` arrives, which kills the CLI's background tasks. Plain
 * text turns carry string content; turns with image attachments carry the
 * prompt text plus one base64 `image` block per attachment (read from the
 * global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 *
 * Exported for the per-run host driver, which must deliver the same prompt a run
 * of this runtime delivers: attachment expansion and file tags have to behave
 * identically whether the turn is driven from here or from a host, and the only
 * way to guarantee that is to run the same builder rather than a second copy.
 */
export async function buildPromptMessages(command: string, images: unknown, files: unknown, cwd: string): Promise<AnyRecord[]> {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * Wraps prompt messages in an async iterable that yields them and then parks.
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted (and
 * immediately on `result` for string prompts). The CLI reads that EOF as the end
 * of the run and kills anything still going in the background, so the iterable
 * has to stay pending until we actually want the process gone.
 *
 * @param {Array<Object>} messages - SDKUserMessage records to send
 * @returns {{ stream: AsyncIterable, release: () => void }} Stream plus its closer
 *
 * Exported for the per-run host driver: the driver owns a host's lifetime, and
 * the thing that keeps the CLI alive past a turn's `result` is this hold, so the
 * driver must use the same hold this runtime uses rather than inventing one.
 */
export function createHeldPromptStream(messages: AnyRecord[]): { stream: AsyncIterable<AnyRecord>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });

  const stream = (async function* () {
    for (const message of messages) {
      yield message;
    }
    // Keeps stdin open — the CLI stays alive until release() is called.
    await held;
  })();

  return { stream, release };
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd: string | null | undefined): Promise<AnyRecord | null> {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', (error as Error).message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', (error as Error).message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(
  command: string,
  options: AnyRecord = {},
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const { sessionId, sessionSummary } = options;
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Provider-native id as the SDK reports it (starts as the resume id, or is
  // captured from the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  const emitNotification = (event: AnyRecord) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    } as unknown as Parameters<typeof notifyUserIfEnabled>[0]);
  };

  // Closes the held stdin stream so the CLI can wind down. Replaced once the
  // stream exists; the finally block calls it no matter how the run ends.
  let releasePromptStream = () => {};
  let idleReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  // The client is told the turn is over as soon as `result` lands, even though
  // the process lingers, so the UI never waits out the idle hold.
  let turnCompleteSent = false;
  // Set when a turn starts background work, cleared when the next `result`
  // arrives — only turns with work still outstanding hold their process open.
  let backgroundWorkPending = false;
  // True while the process is being held open for background work, so a later
  // `result` can be recognised as that work reporting back.
  let heldForBackgroundWork = false;
  // Set once a turn publishes a budget read from an assistant message, so the
  // turn-ending `result` is only mined for usage when nothing better arrived.
  let assistantBudgetSent = false;
  const modelContextWindow = resolveModelContextWindowRow('claude', options.model);

  // A new turn supersedes any earlier one still holding this session's process
  // open, so held runs cannot stack up across a conversation.
  if (sessionKey()) {
    getSession(sessionKey())?.releaseInput?.();
  }

  // Arms (or re-arms) the idle countdown that eventually closes stdin.
  const scheduleRelease = () => {
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null;
      releasePromptStream();
    }, BG_WAIT_CEILING_MS);
    // Never let the hold keep the server process alive on its own.
    idleReleaseTimer.unref?.();
  };

  // Hoisted above the try so the catch's cleanup can tell whether this run
  // still owns the activeSessions entry (or was superseded by a newer run).
  let queryInstance: ClaudeQuery | null = null;

  try {
    // The occupancy gate: a conversation a Claude Code background job is running
    // cannot be resumed — the CLI exits 1 and says so only on stderr, which this
    // path drops — so the run is refused here, before the option bag is built or
    // a query is created. It is the same reader and the same refusal the resident
    // launch uses (see `findBackgroundSessionOwner`), so both server paths answer
    // "occupied" with one sentence. The throw stays inside this `try` on purpose:
    // the `catch` below turns it into the run's own error frame plus terminal
    // complete, which is the exit every other launch failure already takes, so
    // the user reads the refusal rather than an opaque `exited with code 1`.
    //
    // Asked only when this turn would really resume. A brand-new conversation
    // (no provider session id) and a turn explicitly starting over
    // (`resumeFromScratch`) share no session with any background job, so neither
    // can be about one.
    if (providerSessionId && !options.resumeFromScratch) {
      const occupant = findBackgroundSessionOwner(resolveClaudeConfigDir(), providerSessionId);
      if (occupant) {
        throw new ClaudeSessionOccupiedError(occupant);
      }
    }

    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    let effortModels = CLAUDE_PREDEFINED_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    // Read before the option bag is built, because the SDK takes the title as a
    // launch option rather than after the process is up. A brand-new session has
    // no provider id at this point, so this returns without a disk read and the
    // round that creates the session is left to generate its own title.
    const sessionTitle = await resolveClaudeSessionTitle(providerSessionId, options.cwd);

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      sessionTitle,
      model: resolvedModel || options.model,
      effortModels,
    });

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Every turn uses streaming input so stdin stays open past the turn's
    // `result`. The message list is reusable, but each query attempt needs its
    // own stream because an async generator cannot be replayed once consumed.
    const promptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input: AnyRecord) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sessionId || capturedSessionId || 'none'}:${message}`
          } as unknown as Parameters<typeof createNotificationEvent>[0]));
          return {};
        }]
      }]
    };

    // In 'bypassPermissions' the mode's own answer for an ordinary tool is
    // `allow` — but this callback is asked anyway, and it is asked about
    // human-facing tools too. E8 measured that: under `permissionMode:
    // bypassPermissions` an `AskUserQuestion` still reached `canUseTool` (called
    // once, with `AskUserQuestion` as the tool name), so an interactive tool is
    // interceptable here rather than resolved away before the callback runs. An
    // earlier comment at this spot claimed the opposite — that the SDK resolves
    // approval at the permission-mode step and skips the callback for interactive
    // tools — and E8 falsifies it (`docs/proposals/claude-resident-sessions-experiments.md`
    // §E8). The order below is what that reading buys: `requiresInteraction` is
    // checked *first*, so the bypass branch never short-circuits a tool that
    // needs a person.
    sdkOptions.canUseTool = async (toolName: string, input: unknown, context: AnyRecord) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some((entry: string) =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some((entry: string) =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      const decision = await requestClientToolDecision({
        toolName,
        input,
        requiresInteraction,
        requestId,
        ws,
        emitNotification,
        sessionId: sessionId || capturedSessionId || null,
        sessionSummary,
        signal: context?.signal,
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    let heldPrompt = createHeldPromptStream(promptMessages);
    releasePromptStream = heldPrompt.release;
    try {
      queryInstance = claudeQueryFactory.current({
        prompt: heldPrompt.stream,
        options: sdkOptions
      } as unknown as Parameters<typeof query>[0]);
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', (hookError as Error)?.message || hookError);
      delete sdkOptions.hooks;
      // Discard the abandoned stream and build a fresh one for the retry.
      heldPrompt.release();
      heldPrompt = createHeldPromptStream(promptMessages);
      releasePromptStream = heldPrompt.release;
      queryInstance = claudeQueryFactory.current({
        prompt: heldPrompt.stream,
        options: sdkOptions
      } as unknown as Parameters<typeof query>[0]);
    }

    // Track the query instance for abort capability
    if (sessionKey()) {
      addSession(sessionKey(), queryInstance, ws, releasePromptStream);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const message of queryInstance as AsyncIterable<AnyRecord>) {
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(sessionKey(), queryInstance, ws, releasePromptStream);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId as string);
        }

        // Send session-created event only once for sessions with nothing to resume
        if (!providerSessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      // Id the frames are routed by: the provider-native id once the SDK has
      // revealed it, so a `session_created` event and the frames that follow it
      // agree.
      const sid = capturedSessionId || sessionId || null;
      // Id the turn phase is keyed by: the *app session id* the activity
      // heartbeat reads back with. `sessionId` is that id (callers pass the
      // stable app session id); a legacy/direct API caller with none falls back
      // to the provider id, which is all it has.
      const turnSessionId = sessionId || capturedSessionId || null;

      // Normalize this SDK event and hand each resulting frame to the writer.
      // The loop is extracted so the seam itself is covered by a fake-writer test.
      forwardNormalizedFrames({
        transformedMessage,
        sessionId: sid,
        turnSessionId,
        normalizeMessage: context.normalizeMessage,
        writer: ws
      });

      // Extract and send token budget updates from assistant usage payloads,
      // falling back to the turn's cumulative bill only for SDK builds that
      // report no per-assistant usage at all.
      // The selected model entry's CLAUDE_CODE_MAX_CONTEXT_TOKENS row is the only per-model window source.
      const tokenBudgetData = extractTokenBudget(message, modelContextWindow)
        || (assistantBudgetSent ? null : extractCumulativeTokenBudget(message, modelContextWindow));
      if (tokenBudgetData) {
        if (message.type === 'assistant') {
          assistantBudgetSent = true;
        }
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      if (startsBackgroundWork(message)) {
        backgroundWorkPending = true;
      }

      if (message.type === 'result') {
        // The turn is done as far as the client is concerned.
        const abortPending = sessionKey() ? abortedSessionIds.has(sessionKey()) : false;
        if (!turnCompleteSent && !abortPending) {
          turnCompleteSent = true;
          ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
          notifyRunStopped({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary,
            stopReason: 'completed'
          });
        } else if (heldForBackgroundWork && !abortPending) {
          // A result after the turn already reported complete means the work we
          // held the process open for has finished and pushed a follow-up turn.
          notifyBackgroundWorkCompleted({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary
          });
        }
        if (backgroundWorkPending) {
          // Work started during this turn is still running. Hold the process
          // open so it can finish and report back in a follow-up turn; the
          // ceiling is only a backstop for work that never reports.
          backgroundWorkPending = false;
          heldForBackgroundWork = true;
          scheduleRelease();
        } else {
          // Either nothing was backgrounded, or the background work just
          // reported in — let the CLI exit now, as it always has.
          heldForBackgroundWork = false;
          releasePromptStream();
        }
      } else if (idleReleaseTimer) {
        // Background activity after the turn — push the countdown back out.
        scheduleRelease();
      }
    }

    // Clean up session on completion — only while this run still owns the map
    // entry. A superseding run may have replaced it, and deleting here would
    // strand that run.
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    // A superseded run winds down silently: the map entry, the abort flag,
    // and all client-facing events belong to the run that replaced it.
    const superseded = supersededInstances.has(queryInstance!);

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session, and
    // for runs that already reported completion when their `result` arrived.
    const wasAborted = !superseded && sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (!turnCompleteSent && !superseded) {
      turnCompleteSent = true;
      if (!wasAborted) {
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      }
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        stopReason: wasAborted ? 'aborted' : 'completed'
      });
    }
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error — only while this run still owns the map entry
    // (a superseding run may have replaced it).
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    if (supersededInstances.has(queryInstance!)) {
      // Interrupted because a newer run took over this session id; that run
      // owns the abort flag and all further client-facing events.
      return;
    }

    const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : (error as Error).message;

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion and then failed during its post-turn hold still
    // surfaces the error, but must not emit a second terminal complete.
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    if (!turnCompleteSent) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    }
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      error
    });
  } finally {
    // Always close stdin — otherwise an aborted or failed run leaves the CLI
    // process (and its MCP servers) alive until the server exits.
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    releasePromptStream();
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId: string): Promise<boolean> {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Release the held stdin stream; without this the CLI stays up for the rest
    // of the post-turn hold even though the user cancelled.
    session.releaseInput?.();

    // Update session status
    session.status = 'aborted';

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Stops one named background task a per-run Claude process is running.
 *
 * The per-run twin of the resident driver's `stopTask`, and deliberately *not*
 * `abortClaudeSDKSession`: a stop asks the SDK to end the named task and leaves
 * the turn, the run and the held stdin alone, while aborting ends all of them.
 * The held input is therefore never released and the session is never removed —
 * the run keeps going, and only the task is asked to end.
 *
 * Returns `true` when a live per-run session's query was really asked, and
 * `false` when there is no such session or its query exposes no stop verb. As in
 * the resident path, a `true` is only "the request landed": whether the task
 * really stopped is read from the task table's `stopped`, which the
 * `task_notification(stopped)` frame drives.
 *
 * @param {string} sessionId - App session identifier
 * @param {string} taskId - The background task the SDK named
 * @returns {Promise<boolean>} Whether the request was placed on a live process
 */
async function stopClaudeSDKTask(sessionId: string, taskId: string): Promise<boolean> {
  const session = getSession(sessionId);
  const stop = session?.instance?.stopTask;
  if (!session || typeof stop !== 'function') {
    return false;
  }
  await stop.call(session.instance, taskId);
  return true;
}

/**
 * Turns one named *foreground* tool of a per-run Claude process into a background
 * task.
 *
 * The per-run twin of the resident driver's `background`, and deliberately *not*
 * `abortClaudeSDKSession`: backgrounding asks the SDK to promote the named
 * foreground `tool_use` to a background task and leaves the turn, the run and the
 * held stdin in place — the turn keeps running and the tool keeps running, only
 * now detached. The held input is therefore never released and the session is
 * never removed; the run keeps going.
 *
 * The SDK's own boolean is the whole answer and it is consumed as-is: `true` when
 * the process agrees the named `toolUseId` was a foreground tool it has now
 * backgrounded, `false` when it does not (or the session has no live query, or
 * the query exposes no `backgroundTasks` verb). The caller — the runtime
 * gateway — maps `false` to `no-foreground-match`, so a `false` here is read as
 * "there was no matching foreground tool", never as a placed request. Whether the
 * task then *appears* in the task table is the reducer's business: it is written
 * from the `task_started` + `task_updated{is_backgrounded:true}` frames the CLI
 * emits, never from this call's return.
 *
 * @param {string} sessionId - App session identifier
 * @param {string} toolUseId - The foreground tool's `tool_use.id`
 * @returns {Promise<boolean>} Whether the SDK reported a matching foreground tool
 */
async function backgroundClaudeSDKTask(sessionId: string, toolUseId: string): Promise<boolean> {
  const session = getSession(sessionId);
  const background = session?.instance?.backgroundTasks;
  if (!session || typeof background !== 'function') {
    return false;
  }
  return (await background.call(session.instance, toolUseId)) === true;
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId: string): boolean | undefined {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions(): string[] {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId: string): AnyRecord[] {
  const pending: AnyRecord[] = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId: string, newRawWs: unknown): boolean {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  // The per-run control-plane verbs `provider-runtime.service` reaches through
  // `IProvider.runtime`; they are read structurally (as optional methods) so the
  // shared runtime interface is not widened for one provider's capabilities.
  stopTask: stopClaudeSDKTask,
  backgroundTask: backgroundClaudeSDKTask,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
    classifyMissingApproval,
    // Lets `chat-control.service.ts` tell a request another caller already
    // decided (its id is in the ledger) from one that was never here at all.
    readApprovalDecision,
  },
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  stopClaudeSDKTask,
  backgroundClaudeSDKTask,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  extractTokenBudget,
  extractCumulativeTokenBudget,
  // Consumed by the passthrough-parity test to capture sdkOptions.env.
  mapCliOptionsToSDK
};
