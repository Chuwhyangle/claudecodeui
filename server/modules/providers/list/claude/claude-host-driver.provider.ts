/**
 * Claude's resident host driver: one CLI process held across turns, behind
 * `IProvider.hostDriver`, which is what makes `lifecycle_mode = 'resident'` a
 * process the user keeps rather than one they restart on every message.
 *
 * ## What one resident host is
 *
 * One SDK query whose prompt iterable never finishes. `submit` does not build a
 * query — it writes the turn's messages into the input queue the process has
 * been reading since it started, which is the whole of "the pid does not
 * change": a second turn is more stdin on the stream that has been open all
 * along. The queue is closed only when the host is, and closing it is stdin EOF,
 * which is the CLI's own graceful exit path. `closeHost` is that and nothing
 * else; the query's own `close` is a backstop for a CLI that does not take the
 * hint (see `CLAUDE_RESIDENT_EXIT_GRACE_MS`).
 *
 * ## Turn boundaries
 *
 * A turn ends at its `result`, exactly as the runtime's own read loop reads it
 * (`claude-runtime.provider.js`), and each round submitted expects one —
 * including an interrupted round, which is why the runtime checks its abort flag
 * at `result` time rather than at the interrupt. So rounds are a FIFO: `submit`
 * appends, a `result` shifts, and the shifted round's own `run` promise settles.
 * That promise is the one the dispatch awaits, so it resolves when the turn
 * really ended — an interrupt asks for the ending, it does not stand in for one.
 * The interrupted round stays in the queue as a tombstone until then, so its
 * `result` is consumed by the turn it belongs to instead of being mistaken for a
 * later turn's; and the terminal `complete` — `aborted` for that round — is
 * written at that same moment, before the round settles, so the run the dispatch
 * is watching is already completed by the time its own safety net runs.
 *
 * ## What it reports, and what it never decides
 *
 * Leases, through the sink `openHost` hands over: `turn` while a round is in
 * flight (dropped at its own `result`), `resident-policy` — the mode's
 * statement that the process is meant to sit between turns — and the held-work
 * reasons the CLI's own `Stop` hook reports (`cron` for each `session_crons`
 * entry, `background-task` for each `background_tasks` one), reconciled by id so
 * a firing that changes nothing reports nothing. `resident-policy` is the
 * manager's whole reading of "resident": with it an otherwise empty binding
 * derives `idle` and arms the mode's quiet ceiling, where a per-run host would
 * have closed; the held-work leases are the reading that overrides it — the
 * manager defers the idle close while an unexpired `cron` lease is held, and
 * re-counts the window from that lease's own `expiresAt`. Nothing here decides a
 * close: the resident policy is
 * `supersedeOnNewTurn: false`, so a new turn on a bound session is written to
 * the process that is already there, and the host ends only when the manager
 * says so (a quiet ceiling, the close route, a shutdown).
 *
 * Unlike the per-run driver, this one does emit frames: `HostTurnInput` carries
 * no writer, so a resident turn's writer and runtime context arrive through this
 * class's own `run` entry, which the application dispatch calls. What it does
 * *not* emit is the runtime's interactive half — permission prompts, the
 * notification hook and MCP config loading live in `claude-runtime.provider.js`
 * and are deliberately not duplicated here; a resident turn's tool approvals are
 * therefore resolved by the permission mode alone. That is a known boundary of
 * the mode, not an oversight, and it is why the criterion drives turns whose
 * permission mode needs no prompt.
 *
 * ## Why a fresh start asks for a host rather than a binding
 *
 * `openHost`, not `bindSession`. A session's first resident turn needs the
 * manager to open a process *for that session*, and the manager's `bindSession`
 * is a different question — "which live process can take this conversation" —
 * whose answer for a driver that does not multiplex is a refusal. `openHost`
 * also takes the pid, and the manager accepts a pid only at open time, which is
 * why `run` brings the process up *before* asking for the host record: the
 * record is opened knowing the real pid rather than backfilling it later.
 *
 * The same launch is reachable with no turn at all, through
 * {@link ClaudeResidentHostDriver.startResidentSession}: a user asking for the
 * process before sending anything is asking for the state `run` would have
 * produced, and the only thing missing is the messages. Both entries share one
 * launch path, so "started by the button" and "started by the first turn" cannot
 * come up under different gates or different options.
 *
 * Consumed by `ClaudeProvider`, which mounts it as `IProvider.hostDriver`, and by
 * the criterion in `tests/claude-resident-process.test.ts`, which drives it
 * against the real `claude` binary.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SpawnOptions as SdkSpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

import {
  ClaudePerRunHostDriver,
  type ClaudeBackgroundWorkEvent,
} from '@/modules/providers/list/claude/claude-per-run-host-driver.provider.js';
import { createNotificationEvent, notifyUserIfEnabled } from '@/modules/notifications/index.js';
import {
  TOOLS_REQUIRING_INTERACTION,
  buildPromptMessages,
  extractCumulativeTokenBudget,
  extractTokenBudget,
  forwardNormalizedFrames,
  mapCliOptionsToSDK,
  reconcileSessionHeldWork,
  requestClientToolDecision,
  resolveClaudeSessionTitle,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { resolveModelContextWindowRow } from '@/modules/providers/services/model-launch-spec.service.js';
import { readTranscriptAiTitle } from '@/modules/providers/services/session-ai-title.service.js';
import type { SessionHostManager } from '@/modules/session-hosts/index.js';
import type { IProviderHostDriver, IProviderHostDriverSink } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  BackgroundWorkTrigger,
  CommandLifecycleEvent,
  CommandLifecycleState,
  HostBindErrorCode,
  HostCloseReason,
  HostInputPriority,
  HostLease,
  HostPendingQueuedInputs,
  HostQueuedInputCancelResult,
  HostReconfigurePatch,
  HostResidentLaunch,
  HostResidentStartResult,
  HostTurnInput,
  LLMProvider,
  ProcessHost,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  RemoteControlIsolation,
  SessionBinding,
} from '@/shared/types.js';
import {
  ClaudeSessionOccupiedError,
  createCompleteMessage,
  createNormalizedMessage,
  findBackgroundSessionOwner,
  resolveClaudeConfigDir,
} from '@/shared/utils.js';

/**
 * The notification record builder, viewed with the argument shape it really takes.
 *
 * `createNotificationEvent` lives in a `.js` module and `checkJs` is off, so
 * TypeScript infers its destructured parameters from their defaults alone: it
 * presents `sessionId` and `dedupeKey` as `null | undefined` even though its own
 * body stores whatever it is handed. The assertion is that true contract, made
 * once here rather than cast at the call site, and it is only a widening — a
 * record built through it is the same record, with the refusal's own words in
 * `meta` reaching the user unchanged.
 */
const buildNotificationEvent = createNotificationEvent as (event: {
  provider: LLMProvider;
  sessionId?: string | null;
  kind?: string;
  code?: string;
  meta?: AnyRecord;
  severity?: string;
  dedupeKey?: string | null;
  requiresUserAction?: boolean;
}) => AnyRecord;

/**
 * How long a resident process is given to leave on its own before the SDK query
 * is closed under it.
 *
 * Deliberately far longer than a graceful exit: a Claude CLI told EOF stops in
 * well under a second, so an exit observed inside any ordinary assertion window
 * is the EOF's doing. A shorter backstop would let a kill masquerade as the
 * graceful path this driver exists to provide.
 */
export const CLAUDE_RESIDENT_EXIT_GRACE_MS = 15_000;

/**
 * How long a withdrawal waits for the queue to say a message was cancelled.
 *
 * A budget, not a timeout with a meaning: the queue answers in the same read
 * loop this driver is already consuming, so the wait is over either as soon as
 * the event arrives or when the budget runs out — and running out is not
 * evidence of anything except that no `cancelled` was seen. The verdict is
 * computed from the reading after the wait, never from the wait's expiry.
 */
export const CLAUDE_CANCEL_VERDICT_WAIT_MS = 5_000;

/** How often the withdrawal re-reads the queue while waiting. */
const CLAUDE_CANCEL_VERDICT_POLL_MS = 25;

/**
 * How long an interrupt request waits for the CLI's own `RESULT` before the host
 * records `interrupt-no-result`.
 *
 * An interrupt is a request and nothing else (§6.3): the CLI's `RESULT` is what
 * ends the turn, and the measured gap is about 10 ms. This is the bound on
 * waiting for it — long enough that no working CLI reaches it, and short enough
 * that a turn whose `RESULT` is never coming reads as the anomaly `§10` names
 * rather than as work still in progress.
 */
const CLAUDE_RESIDENT_INTERRUPT_RESULT_TIMEOUT_MS = 5_000;

/**
 * How this build acts on a reconcile anomaly: it only says so.
 *
 * `enforce` — closing a phantom run as `aborted` with `reason: reconciled` — is
 * the switch that comes once this stage has watched the log for a while (§10.1,
 * §12 S5), so until that exists every `[reconcile]` line written here reports
 * `mode=log` and changes no state.
 */
const CLAUDE_RESIDENT_RECONCILE_MODE = 'log';

/**
 * The permission mode a resident process is launched under.
 *
 * Always `bypassPermissions`, and that is a statement about the mode rather than
 * a default a caller may override: a resident process is one nobody is
 * guaranteed to be watching — it runs cron and background turns of its own — so
 * a launch that stopped at the CLI's own permission step would park such a turn
 * on a person who is not there. The three callbacks below are where a
 * human-facing request is answered instead; they are what makes "nobody is
 * there" a policy this host applies rather than a hang it causes. A session that
 * wants another mode moves it on the *running* process (`reconfigure` →
 * `setPermissionMode`), which is the one place the mode may change, because a
 * switch keeps the process and a relaunch would not.
 *
 * The SDK requires the second option alongside the first — a `bypassPermissions`
 * launch must also set `allowDangerouslySkipPermissions` (`sdk.d.ts:1664`) — so
 * the two are stated together here and read back together by the criterion.
 */
export const RESIDENT_PERMISSION_MODE = 'bypassPermissions';

/**
 * The words every unattended refusal carries.
 *
 * A constant rather than a literal at each of the three entries because the
 * three refusals are one statement — this host has nobody to ask — and a
 * criterion has to be able to hold them to the same words. It is also the
 * notification's own reason text, so what the user is told and what the CLI was
 * told cannot drift.
 */
export const UNATTENDED_REFUSAL = '当前无人值守';

/**
 * The refusal one entry is answered with when nobody is there to ask.
 *
 * Names what was refused as well as why, and always contains
 * {@link UNATTENDED_REFUSAL} verbatim: the message is what reaches the CLI (and
 * through it the transcript), so it is the only place a reader of a refused turn
 * can learn that the refusal was about attendance rather than about the request.
 */
function unattendedRefusalMessage(entry: ClaudePermissionEntry, toolName: string | null): string {
  const subject =
    entry === 'canUseTool'
      ? `工具 ${toolName ?? 'unknown'}`
      : entry === 'onElicitation'
        ? 'MCP elicitation 请求'
        : 'request_user_dialog 对话框';
  return `${UNATTENDED_REFUSAL}：已自动拒绝 ${subject}。`;
}

/**
 * How long a session cron is taken to live, from when the CLI created it.
 *
 * The CLI's own receipt for `CronCreate` states it verbatim — "Session-only (not
 * written to disk, dies when Claude exits). Auto-expires after 7 days. Use
 * CronDelete to cancel sooner." (E9, `claude-resident-sessions-experiments.md`
 * §9.4) — and neither the stream nor the hook names an instant, so the seven
 * days are counted here from the moment the job is first read. A job the CLI
 * keeps naming keeps the expiry it was first given rather than restarting the
 * week (see `cronsFromStopList`), and the manager reads that instant as the
 * point the `cron` lease stops deferring the idle close.
 *
 * Exported so a criterion places the deadline from the same value the driver
 * uses instead of restating the number, the way `RESIDENT_IDLE_TIMEOUT` is.
 */
export const CRON_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The `system` subtypes this driver's read loop reads for held work.
 *
 * Everything else the CLI puts on the stream is forwarded untouched and read by
 * nobody here, which is the property the loop has to have: the CLI emits
 * subtypes this build has never seen (`task_updated`, `control_request_progress`,
 * and `scheduled_task_fire`, which E9 never observed but the binary carries), and
 * a loop that only advances on a closed vocabulary stops the moment the CLI
 * learns a new word. The set is the loop's own reading vocabulary, not a claim
 * about the CLI's — a subtype absent from it is recorded
 * ({@link ClaudeResidentLifecycleReading.unhandledSystemSubtypes}) and passed
 * through, never treated as an error.
 */
const HELD_WORK_SYSTEM_SUBTYPES = new Set([
  'init',
  'task_started',
  'task_notification',
  'background_tasks_changed',
]);

/**
 * The slice of the SDK's `Query` a resident process uses.
 *
 * Wider than the per-run driver's stream, because a resident process is
 * reconfigured rather than replaced: the live verbs are optional so a criterion
 * can hand in a scripted stream, and absent means `reconfigure` answers
 * `next-turn` for what it would have applied.
 */
export type ClaudeResidentQuery = AsyncIterable<AnyRecord> & {
  /** Stops the turn in flight; the process itself stays up. */
  interrupt(): Promise<void>;
  /** Backstop teardown, used only after {@link CLAUDE_RESIDENT_EXIT_GRACE_MS}. */
  close?(): void;
  /** Live model switch, SDK permitting. */
  setModel?(model?: string): Promise<void>;
  /** Live permission-mode switch, SDK permitting. */
  setPermissionMode?(mode: string): Promise<void>;
  /**
   * Stops one named background task, leaving the turn in flight and the process
   * up (the SDK's own `Query.stopTask`).
   *
   * Optional like the other live verbs so a criterion can hand in a scripted
   * stream: a stream that exposes no verb makes the driver's `stopTask` answer
   * "not placed" rather than throwing.
   */
  stopTask?(taskId: string): Promise<void>;
  /**
   * Promotes the named *foreground* tool to a background task, leaving the turn
   * in flight and the process up (the SDK's own `Query.backgroundTasks`).
   *
   * Deliberately takes the `toolUseId` as a required string: the SDK method's
   * parameter is optional (its no-arg form backgrounds *every* foreground tool),
   * and AC-197 exposes only the single-task form — calling it with no id would
   * background tools the caller never named. The SDK's boolean is returned as-is;
   * `false` means the process held no matching foreground tool.
   *
   * Optional like the other live verbs so a criterion can hand in a scripted
   * stream: a stream that exposes no verb makes the driver's `background` answer
   * "not placed" rather than throwing.
   */
  backgroundTasks?(toolUseId: string): Promise<boolean>;
};

/**
 * One resident process: the SDK query, plus the pid the manager's record needs.
 *
 * `pid` is a getter rather than a value so a caller can read it after the
 * spawn hook has run, however many ticks later that is.
 */
export type ClaudeResidentProcess = {
  query: ClaudeResidentQuery;
  readonly pid: number | null;
  /**
   * Writes one raw frame to the process's stdin, when this process has a stdin
   * this driver can reach.
   *
   * The SDK's `Query` interface exposes no verb for most of
   * `SDKControlRequestInner` — `cancel_async_message` among them (measured: the
   * `Query` methods are interrupt / setPermissionMode / setModel /
   * setMaxThinkingTokens / applyFlagSettings / stopTask / backgroundTasks /
   * streamInput / rewindFiles, and nothing else) — so a control frame the SDK has no method
   * for is reachable only by writing the stream-json line itself, which is
   * exactly how the protocol's behavior was measured in the first place
   * (`docs/proposals/claude-resident-sessions-experiments.md` §9).
   *
   * Optional because a process seam may not carry one: a scripted stream has no
   * stdin to write to, and a driver that assumed otherwise would be claiming a
   * capability its own seam never gave it. Absent means the withdrawal entry
   * answers `unknown` rather than pretending to have written anything.
   */
  writeRaw?(frame: AnyRecord): void;
  /**
   * The `settings` object this process's launch handed the SDK, as it was handed
   * over; null when the launch stated none.
   *
   * Reported by the factory rather than guessed by the driver, because the
   * driver never sees the built bag: `buildResidentSdkOptions` produces it and
   * `query` consumes it, both inside `createSdkResidentProcess`. That is the only
   * boundary at which "what did the launch really state" can be read at all, and
   * it is the reading the Remote Control criterion asks for — the request is the
   * driver's, the launched bag is the SDK's.
   *
   * Optional for the same reason `writeRaw` is: a substituted factory has no bag
   * to report, and absent means the host record's `launched` half is `null`
   * rather than a claim built from the request.
   */
  launchSettings?: { remoteControlAtStartup?: boolean; isolatePeerMachines?: boolean } | null;
};

/**
 * The tier every message a busy host pushes is written under.
 *
 * `later` is what makes a busy message behave the way the interactive CLI's
 * does: it waits for the turn in flight, is then run as a turn of its own, and
 * is never merged into the turn it arrived during. Measured on the real binary
 * (`§9.2`): pushed under this tier, a message landed in the sixth real agent
 * turn — a later turn, not the one it was pushed during — and the tier that
 * "never lands" is `next`, not this one. `now` exists in the CLI's vocabulary
 * and is deliberately not used: it jumps the queue ahead of other `later`
 * messages, which is not what a message sent during someone else's turn asked
 * for.
 */
export const CLAUDE_QUEUED_INPUT_PRIORITY: HostInputPriority = 'later';

/**
 * The turn option a caller uses to name the tier ONE busy write is made under instead.
 *
 * WHY IT EXISTS. The default above is the right tier for a message a PERSON typed while
 * something else was running: they asked for it to happen after, and it does. It is the
 * wrong tier for the Live Voice relay's busy release, where the person is standing in
 * front of the session and the words they just spoke are meant for the turn already
 * running — the X3' replay (2026-10-15) measured a p90 delivery delay of 10.8–18.5 s and
 * a p90 first-reaction of 14.0–22.5 s under `later`, against 1.6 s / 8.4 s under `next`
 * on the same 84 readings, because `later` makes the running turn finish without ever
 * having heard the instruction.
 *
 * The relay therefore names the tier on the turn it dispatches, and this host honours it
 * for that write — and only for that write. An option bag that names none (every send
 * that is not the relay's release, including every browser and MCP send and every
 * scheduled message) keeps {@link CLAUDE_QUEUED_INPUT_PRIORITY} exactly as before.
 *
 * Read through {@link readRequestedPriority}: the bag is the caller's own `AnyRecord`, so
 * a value that is not one of the CLI's three tiers is ignored rather than written — a
 * frame carrying a tier the process cannot honor is worse than one carrying the default.
 */
export const CLAUDE_TURN_PRIORITY_OPTION = 'priority';

/**
 * The CLI's three tiers, in the vocabulary {@link HostInputPriority} declares.
 *
 * Restated as a runtime list because the type is erased: a caller hands this host an
 * `AnyRecord`, and the check that keeps a mistyped tier off the wire has to happen on a
 * value, not on a type.
 */
const HOST_INPUT_PRIORITIES: readonly HostInputPriority[] = ['now', 'next', 'later'];

/**
 * The tier a caller named for THIS turn, or `null` when it named none this host can use.
 *
 * Consumers: {@link ClaudeResidentHostDriver.turnMessages}, which writes the value onto
 * the frame when the process is busy and falls back to `CLAUDE_QUEUED_INPUT_PRIORITY`
 * when this answers `null`.
 */
function readRequestedPriority(options: AnyRecord): HostInputPriority | null {
  const requested = options[CLAUDE_TURN_PRIORITY_OPTION];
  return typeof requested === 'string' && (HOST_INPUT_PRIORITIES as readonly string[]).includes(requested)
    ? (requested as HostInputPriority)
    : null;
}

/**
 * One user frame this host wrote into the process while the process was busy.
 *
 * The reading exists because the frame's own facts are unreadable from
 * anywhere else once it has been written: the moment it was handed to the
 * process, the tier it was written under, and the uuid the host assigned it
 * (which is also the CLI's `command_uuid` for it) are all host-side facts.
 * `queuedBeforeResult` is the precomputed half of the AC's write-timing
 * reading — whether the frame reached the process before the turn in flight
 * ended — kept here rather than in the criterion so the two timestamps it
 * compares come from the same clock on the same side.
 */
export type ClaudeQueuedInput = {
  uuid: string;
  /** When this host handed the frame to the process input, in host clock terms. */
  at: number;
  /** The tier the frame was written under. */
  priority: string | null;
  /** The frame verbatim, as it was written. */
  frame: AnyRecord;
  /**
   * When the CLI dequeued this message into a turn of its own, or `null` while
   * it is still queued.
   */
  startedAt: number | null;
  /**
   * How many turns had ended when the frame was pushed. The turn in flight at
   * that moment is the one whose `result` this index points at, so
   * `resultTimes[resultsSeenAtPush]` is the `turnResultAt` of the AC's
   * write-timing reading.
   */
  resultsSeenAtPush: number;
  /** Whether the frame reached the process before that turn's `result`. */
  queuedBeforeResult: boolean | null;
};

/**
 * The UTF-8 bytes of one queued frame's user text — the length unit the voice
 * relay's admission bound (`VOICE_QUEUE_MAX_BYTES`) is written in.
 *
 * The frame is an SDK user message: `{ type:'user', message:{ role:'user',
 * content } }` where `content` is either the prompt string or the block array an
 * attachment-carrying turn expands to. Both shapes are read so the byte reading
 * describes the text the CLI is really holding, not the JSON envelope around it
 * — an envelope length would make the relay's budget and its own count disagree
 * by an order of magnitude. A frame with neither shape counts as zero: there are
 * no words to charge.
 */
function claudeQueuedFrameTextBytes(frame: AnyRecord): number {
  const content = (frame?.message as AnyRecord | undefined)?.content;
  if (typeof content === 'string') {
    return Buffer.byteLength(content, 'utf8');
  }
  if (Array.isArray(content)) {
    let bytes = 0;
    for (const block of content) {
      const text = (block as AnyRecord | undefined)?.text;
      if (typeof text === 'string') {
        bytes += Buffer.byteLength(text, 'utf8');
      }
    }
    return bytes;
  }
  return 0;
}

/**
 * What a live resident host knows about the messages it pushed while busy, the
 * queue's own account of them, and the control frames it wrote.
 *
 * A copy, like {@link ClaudeUnattendedReading}, and `null` for a session this
 * driver is not hosting. Everything in it is read off the host that owns the
 * process: the push moments and tiers are the host's own marks, the lifecycle
 * list is the CLI's answer as this host read it, and the control frames are the
 * bytes this host wrote.
 */
export type ClaudeBusyInputReading = {
  /** Every frame this host pushed while the process was already busy, in push order. */
  queuedInputs: ClaudeQueuedInput[];
  /** Every `command_lifecycle` event this host read, in arrival order. */
  lifecycle: CommandLifecycleEvent[];
  /** Every control frame this host wrote to the process, in write order. */
  controlFrames: Array<{ at: number; requestId: string; frame: AnyRecord }>;
  /** Every `control_response` the CLI sent back, in arrival order. */
  controlResponses: Array<{ at: number; requestId: string | null }>;
  /**
   * When each turn's `result` was read, in arrival order.
   *
   * Indexed by turns *ended*, which is the same index
   * {@link ClaudeQueuedInput.resultsSeenAtPush} counts, so the two line up
   * without either side knowing a round's identity.
   */
  resultTimes: number[];
  /** How many `session_state_changed` messages the stream carried (E9 §9.1: none). */
  sessionStateChanged: number;
  /**
   * How many rounds are still waiting for a turn to end — `state.rounds`, the
   * driver's FIFO of turns it has armed and not yet settled.
   *
   * Read by the criterion for the merged-turn settlement
   * (`claude-resident-merged-queued-turn.test.ts`): a `result` that carries a
   * merged turn has to drain every round the CLI merged into it, so the queue
   * reading is what shows the FIFO is empty at rest rather than one off. Nothing
   * in production consumes it.
   */
  roundsOpen: number;
  /** The host process's pid, or null when the seam did not report one. */
  hostPid: number | null;
};

/**
 * Builds one resident process.
 *
 * Injected for the same reason the per-run driver injects its query factory: the
 * SDK's `query` is a module-level function, so there is no seam to stub. The
 * default is the real SDK plus the pid capture; a criterion that wants a
 * scripted stream — or a fake process that really dies — hands in its own.
 */
/**
 * Readings the driver takes out of the process it is about to spawn.
 *
 * The `Stop` hook is the only place the CLI says what it is still holding
 * (`background_tasks`, `session_crons`), and it is not on the message stream:
 * the SDK delivers it to a callback, so the only way to have it is to install
 * one. Installing it through the process factory rather than inside the driver
 * is what keeps the seam honest — the factory owns the SDK options, so a
 * criterion that substitutes a factory is also the thing that decides whether
 * the hook ever runs, instead of the driver reading a hook it quietly added.
 */
export type ClaudeResidentProcessSeams = {
  /** Called with every `Stop` hook input verbatim, in arrival order. */
  onStop?: (input: AnyRecord) => void;
};

/**
 * One place a turn can need a person, named once so every reading agrees.
 *
 * The three are the SDK's own three callbacks, and they are the whole of this
 * host's answer to "who does a turn ask when it needs a human": `side_question`
 * is deliberately absent — it travels host→CLI, so it is a question *this* side
 * asks, and E9 read the CLI accepting the subtype with no `control_response`
 * ever coming back (see the README's resident-permission section).
 */
export type ClaudePermissionEntry = 'canUseTool' | 'onElicitation' | 'onUserDialog';

/**
 * The three callbacks a resident process is launched with, structurally typed.
 *
 * `canUseTool`'s signature is the SDK's (`toolName`, `input`, `{ signal }` →
 * `PermissionResult`); the other two take their own request object verbatim and
 * answer in their own result shape. All three are typed as `AnyRecord` in and
 * out on purpose: this file's promise is *where* the callback comes from and
 * *what this host decides*, and restating the SDK's union types here would be a
 * second copy of a contract the SDK already publishes (`sdk.d.ts`).
 */
export type ClaudeResidentPermissions = {
  canUseTool: (toolName: string, input: AnyRecord, options: AnyRecord) => Promise<AnyRecord>;
  onElicitation: (request: AnyRecord, options: AnyRecord) => Promise<AnyRecord>;
  onUserDialog: (request: AnyRecord, options: AnyRecord) => Promise<AnyRecord>;
};

/**
 * One decision one of the three entries made, as a reader can re-read it.
 *
 * Kept because none of the three answers is readable anywhere else after the
 * fact: the SDK consumes the callback's return value, the wire carries only the
 * *request*, and a refusal produces no frame at all. A criterion therefore has
 * to read what the host decided from the host.
 */
export type ClaudePermissionDecision = {
  /** Which entry answered. */
  entry: ClaudePermissionEntry;
  /** The tool name the entry was given, or null for the two request-shaped ones. */
  toolName: string | null;
  /** The request as the callback received it, verbatim. */
  request: AnyRecord;
  /**
   * The answer this host returned, verbatim.
   *
   * Null when the client flow timed out — the third outcome of a wait that the
   * per-run path has always branched on, and `null` rather than an invented
   * object is what keeps that branch readable from here.
   */
  answer: AnyRecord | null;
  /** True when the answer was the unattended refusal. */
  refused: boolean;
  /** True when the answer came from the client's request-frame flow. */
  viaClient: boolean;
  /** The request id the client flow used, or null when no frame was sent. */
  requestId: string | null;
  /** The refusal wording, or null when this was not a refusal. */
  reason: string | null;
  /** When the decision was made, in host clock terms. */
  at: number;
};

/**
 * What a live resident host knows about the requests it answered for a person.
 *
 * A copy, and `null` for a session this driver is not hosting — the same two
 * properties every other reading here has. `permissionMode` is this host's own
 * account of the mode the process is under (it is the value the three entries
 * consult, and the value `setPermissionMode` moved), not a re-read of the
 * launch's option bag, which stops being the truth after the first switch.
 */
export type ClaudePermissionReading = {
  permissionMode: string;
  decisions: ClaudePermissionDecision[];
  /** The browser count this host last consulted; see {@link ClaudeResidentHostDriverOptions.connectedClientCount}. */
  lastConnectedCount: number;
};

/**
 * One resident process's permission state, alive from before its spawn.
 *
 * The three callbacks are installed on the SDK options *before* `query()` is
 * called, while the host state they report into is adopted one `openHost` later
 * — the same ordering problem the `Stop` sink has, and solved the same way: the
 * scope exists first, carries its own decision log so a request answered in that
 * gap is still readable, and is pointed at the host state by `startHost`.
 *
 * `mode` is this host's own account of the mode its process is under. It starts
 * at {@link RESIDENT_PERMISSION_MODE} and moves only when `reconfigure` really
 * moved it, because a value written before the call returned would be a claim
 * about a process that may not have taken it.
 */
type ClaudePermissionScope = {
  state: ResidentHostState | null;
  mode: string;
  decisions: ClaudePermissionDecision[];
  lastConnectedCount: number;
};

/**
 * What one entry got back for one request: a refusal, or the client's own answer.
 *
 * The refusal is a shape of its own rather than a `deny` decision because it
 * never travelled through the client flow at all — the distinction the criterion
 * reads, and the reason the two cannot be collapsed into "the answer object".
 * `decision` is the client's answer verbatim, which is `null` when the wait
 * timed out and `{cancelled: true}` when it was aborted; both are the client
 * flow's own outcomes and each entry branches on them itself.
 */
type ClaudePermissionAnswer =
  | { kind: 'refused'; message: string }
  | { kind: 'client'; decision: AnyRecord | null };

export type ClaudeResidentProcessFactory = (input: {
  prompt: AsyncIterable<AnyRecord>;
  options: AnyRecord;
  seams?: ClaudeResidentProcessSeams;
  /**
   * The three human-facing entries this host answers for, when it has any.
   *
   * Carried on the factory input rather than built inside the factory because
   * the *policy* is this driver's — whether the host is unattended, which writer
   * a request belongs on, what the refusal says — while the *installation* is
   * the launch's, because the SDK options belong to whoever calls `query`. The
   * default factory puts them on the SDK options verbatim; a criterion's factory
   * can read them without the SDK being involved at all.
   */
  permissions?: ClaudeResidentPermissions;
  /**
   * The two Remote Control flags this launch must state for the SDK.
   *
   * On the factory input for the same reason `permissions` is: the *request* is
   * this driver's policy decision (it is the half of the gate the driver owns
   * once the user's settings have said "not enabled"), while *stating* it on the
   * SDK options is the launch's job. The default factory writes them into
   * `sdkOptions.settings`; the driver records the same object on the host record,
   * so the request and the launched bag can be compared against each other.
   *
   * Absent means "state nothing", which is what a build that dropped the
   * defence-in-depth half does — the mutant the criterion's arm (b) expresses.
   */
  remoteControlFlags?: ClaudeRemoteControlFlags;
}) => ClaudeResidentProcess;

/**
 * The manager surface this driver needs, as a port rather than the singleton.
 *
 * `openHost` is how a resident session gets a process (see the file header for
 * why not `bindSession`), `snapshot` is how the driver finds the host a later
 * turn belongs to, and `bindSession` is only ever passed through to the per-run
 * driver this one composes. Taking it as a constructor option is what lets a
 * criterion inject a manager with its own clock — the quiet ceiling a resident
 * host is held under is that manager's policy, not a number this file knows.
 */
export type ClaudeResidentHostPort = Pick<
  SessionHostManager,
  'openHost' | 'snapshot' | 'bindSession' | 'openUnattendedRun'
>;

/**
 * The notification a resident turn's end makes.
 *
 * The same shape the runtime's own run reports, so a resident turn stops the
 * same way a per-run one does and nothing downstream has to learn a second
 * vocabulary. `sessionId` is the *application* session id, which is what the
 * runtime passes (it prefers the app id over the provider-native one here), and
 * `sessionName` comes from the turn's own options.
 */
export type ClaudeResidentRunStoppedEvent = {
  userId: string | number | null;
  provider: LLMProvider;
  sessionId: string | null;
  sessionName: string | null;
  stopReason: 'completed' | 'aborted';
};

export type ClaudeResidentHostDriverOptions = {
  host: ClaudeResidentHostPort;
  /** Background-work completion, forwarded to the per-run driver this one composes. */
  notifyBackgroundWork: (event: ClaudeBackgroundWorkEvent) => void;
  /**
   * Background work reported by a turn the process opened by itself.
   *
   * A separate verb from `notifyBackgroundWork` because the two carry different
   * facts, not because they are different notifications: the per-run report has
   * no trigger to give (its turn arrived as a request, so there is nothing to
   * reconcile) and this one always does. Both reach the same notification in
   * production; a host that composes this driver names where each goes.
   */
  notifyUnattendedWork: (event: ClaudeUnattendedWorkEvent) => void;
  /** Called once per completed round, mirroring the runtime's own stop notification. */
  notifyRunStopped: (event: ClaudeResidentRunStoppedEvent) => void;
  /** Process seam; defaults to the real SDK with the pid capture installed. */
  createProcess?: ClaudeResidentProcessFactory;
  /**
   * How many browsers are connected right now; defaults to none.
   *
   * Taken as a port rather than imported because the connection registry lives in
   * the websocket module, which imports this one, so an edge from here would
   * close a cycle — the gap the file header states and the structural reading in
   * `claude-resident-unattended-turn.test.ts` holds this file to (zero imports of
   * `modules/websocket`). The composition root, the one place both modules are in
   * scope, installs it over the registry's own set.
   *
   * The default is `() => 0` — nobody — because that is the answer that refuses:
   * a host that cannot reach the registry must not conclude that a person is
   * watching. It is also why the other half of the same test has to stand on its
   * own; see {@link ClaudeResidentHostDriver.isUnattended}.
   */
  connectedClientCount?: () => number;
  /**
   * Delivers one permission notification to the session's user.
   *
   * The same delivery the per-run path uses (`notifyUserIfEnabled`, through the
   * notifications barrel), taken as a seam because a resident host's notification
   * has no connection to be addressed through: the event is the notification
   * layer's own record and the user is the one the last round carried. A
   * criterion substitutes its own to read *that* a notification was made, which
   * is otherwise only observable as a channel side effect.
   */
  notifyUser?: (delivery: { userId: string | number | null; event: AnyRecord }) => void;
  /**
   * The instant a held-work reason is dated from, defaults to the wall clock.
   *
   * The only thing this driver puts a *date* on is a cron's `expiresAt` (the
   * CLI names no instant; see {@link CRON_MAX_AGE_MS}), and that date decides
   * when the manager stops deferring the idle close. Taking it as an option is
   * what lets a criterion reach the seven-day expiry without waiting it out —
   * and it is injected alongside the manager's own `now` so both layers read one
   * clock rather than two.
   */
  now?: () => number;
  /**
   * How long an interrupt request waits for the CLI's own `RESULT` before the
   * host records `interrupt-no-result`; defaults to
   * {@link CLAUDE_RESIDENT_INTERRUPT_RESULT_TIMEOUT_MS}.
   *
   * A seam for the same reason the other waits here are: a criterion has to
   * reach the deadline without spending five seconds of wall clock on it, and
   * the reading it takes is the anomaly line rather than the wait.
   */
  interruptResultTimeoutMs?: number;
  /**
   * The user-level settings file the Remote Control gate reads, when it is not
   * the one the process will run under.
   *
   * Defaults to `<CLAUDE_CONFIG_DIR>/settings.json` resolved *at launch time*,
   * which is the only file whose answer decides what the child is launched with
   * — so production never sets this. It is a seam for the same reason the
   * filesystem is normally reached through one: a criterion has to be able to
   * drive the gate against a temp directory, and to express the mutant where the
   * gate reads something other than the settings the process runs under (see the
   * Remote Control section above).
   */
  userSettingsPath?: string;
};

/**
 * The unattended-turn entry, named where the run it opens would have to live.
 *
 * `openUnattendedRun` is on the manager's surface rather than in this file for
 * the same reason the rest of the port is: what opens a *run* is the websocket
 * module's registry, and the providers module already imports the websocket
 * module — so an edge back from here would close a cycle. The manager carries
 * the seam (`setUnattendedRunOpener`) and the composition root fills it; the
 * driver only calls it. What it answers with is the writer the turn's frames
 * belong to, or null when no run could be opened (no seam installed, or one
 * already in flight for the session).
 */
export type ClaudeResidentUnattendedRun = {
  /** The open run's writer; frames the host routes to it are client-facing frames. */
  writer: ProviderRuntimeWriter;
};

/**
 * The notification an unattended turn's end makes.
 *
 * The per-run background-work report's own shape, plus the one fact only the
 * host can reconcile: what the reporting turn was *for*. A resident process that
 * opens a turn of its own sends no request, so nothing in the turn says why it
 * happened; the trigger is derived from the `Stop` hook's task list as it read
 * when the turn opened (see {@link deriveBackgroundWorkTrigger}) and carried
 * here, rather than guessed from the turn's contents.
 */
export type ClaudeUnattendedWorkEvent = Omit<ClaudeBackgroundWorkEvent, 'userId'> & {
  /**
   * Never `null`-for-no-connection the way the per-run event's is: this turn
   * has no connection either, but it does have a predecessor, so the user is
   * the last round's — the same reading `ClaudeResidentRunStoppedEvent` already
   * reports, and wide in the same way for the same reason (a user id is a
   * database id, which is a number in every path that produces one).
   */
  userId: string | number | null;
  trigger: BackgroundWorkTrigger;
};

/**
 * The identification of an unattended turn, read off a live resident host.
 *
 * The whole record exists because the two halves of "a turn nobody pushed" live
 * on opposite sides of the process boundary: the uuids this host stamped are
 * only known here (the stream never echoes one), while the uuid the CLI minted
 * for the turn's opener is only known to the CLI. Neither is a readable fact
 * from a transcript or a frame, so a reader that has to prove a turn was
 * unattended reads them together, from the host that holds both.
 *
 * Read-only by construction: it is a copy, taken on demand, and the caller is a
 * test that reports what it saw rather than one that can change it. The
 * `server/modules/providers/tests/claude-resident-unattended-turn.test.ts`
 * criterion is its consumer — the identification and the tool-table readings the
 * criterion prints come from here.
 */
export type ClaudeUnattendedReading = {
  /** Every uuid this host stamped on a user frame it pushed, in push order. */
  pushedUuids: string[];
  /** The last of them, or `null` when nothing was ever pushed. */
  lastPushedUuid: string | null;
  /** The opener uuid of the last unattended turn this host opened, if any. */
  unattendedCommandUuid: string | null;
  /** The tool names the process reported at `system/init`. */
  initTools: string[];
  /** The `system/task_started` task type, if the process started one. */
  backgroundTaskType: string | null;
};

/** The `cron` member of the lease union, named once so the held list can be typed. */
type CronLease = Extract<HostLease, { kind: 'cron' }>;
/** The two background-work members of the lease union, named for the same reason. */
type BackgroundTaskLease = Extract<HostLease, { kind: 'background-task' | 'monitor' }>;
/**
 * Either held-work reason, so the comparison below stays inside the two kinds
 * that carry an id — `turn` and `resident-policy` are never held work and are
 * never compared as if they were.
 */
type HeldWorkLease = CronLease | BackgroundTaskLease;

/**
 * What a live resident host holds, and what it had to guess.
 *
 * The manager's own snapshot reports the union of a binding's leases, which is
 * the surface every reader of "why is this process still here" should prefer.
 * This reading exists for the one thing the snapshot cannot carry: the driver's
 * *own* account of how it arrived at that union — which list was the authority,
 * which reason was inferred from a tool call instead, and which `system`
 * subtypes it passed through without acting on. A criterion that has to tell
 * "the CLI named this job" from "this build guessed at it" reads it here; in
 * production nothing consumes it.
 *
 * A copy, and `null` for a session this driver is not hosting — the same two
 * properties {@link ClaudeUnattendedReading} has, for the same reason.
 */
export type ClaudeResidentLifecycleReading = {
  /** The live host this reading is about. */
  hostId: string;
  /** The `cron` reasons this driver currently reports, in report order. */
  crons: CronLease[];
  /** The background-work reasons it currently reports, in report order. */
  backgroundTasks: BackgroundTaskLease[];
  /**
   * `system` subtypes the read loop saw and did not act on, in arrival order.
   *
   * A frame named here was forwarded to the client untouched and changed nothing
   * about the process's lifetime; the loop's survival across one is the point
   * (see {@link HELD_WORK_SYSTEM_SUBTYPES}).
   */
  unhandledSystemSubtypes: string[];
  /** True once a `Stop` firing had named the cron list (`session_crons`). */
  cronsAuthoritative: boolean;
  /** True once a `Stop` firing had named the background-task list. */
  tasksAuthoritative: boolean;
};

/**
 * What made a turn nobody pushed, from the CLI's own account of what it holds.
 *
 * Only two things can make this CLI open a turn by itself: a background task
 * finishing, or a session cron firing. Both are reported by the `Stop` hook, so
 * both are readable — and everything else is `non-user`, which is the reading
 * for a turn with no list to explain it rather than a claim about who asked.
 *
 * `non-user` is the whole of the fallback on purpose: an unreadable hook, a
 * missing field and an empty list are the same fact from this side (nothing the
 * CLI holds explains the turn), and three names for it would be three ways for a
 * reader to disagree about which one they got.
 */
export function deriveBackgroundWorkTrigger(
  readings: { backgroundTasks?: unknown; sessionCrons?: unknown } | null,
): BackgroundWorkTrigger {
  const tasks = Array.isArray(readings?.backgroundTasks) ? readings.backgroundTasks : [];
  if (tasks.length > 0) {
    return 'background-task';
  }
  const crons = Array.isArray(readings?.sessionCrons) ? readings.sessionCrons : [];
  if (crons.length > 0) {
    return 'session-cron';
  }
  return 'non-user';
}

// The address a resident process answers to used to be *computed* here and
// handed to the CLI as `--name`. That is gone: in the CLI's ladder a launch name
// is both the session's `agent-name` and its `custom-title`, so writing one
// pinned the session's name at launch, let a CloudCLI-invented address outrank
// an `ai-title` the session had earned, and grew another `-<id6>` on every
// restart. The app no longer names anything; it reads the name the CLI derived
// for the process, in `readCliSessionRegistration` below.

/**
 * How long a launched process is given to state its own name, and how often it
 * is asked.
 *
 * The name is written to the process's transcript as an `agent-name` entry, and
 * that entry is the only reading of it that proves the process really registered
 * the address rather than merely being launched with the flag. The budget is
 * short because the entry is written at startup: a process that has already
 * emitted its session id has been up long enough that a name which has not
 * appeared by the end of this window is one that is not coming.
 */
export const CLAUDE_RESIDENT_IDENTITY_BUDGET_MS = 5_000;
const CLAUDE_RESIDENT_IDENTITY_POLL_MS = 50;

// `resolveClaudeConfigDir` now lives in `server/shared/utils.ts`: the per-run
// runtime resolves the same directory for its own occupancy gate, so the one
// definition is shared rather than copied.

// ------------------------- The Remote Control gate -------------------------
//
// A resident process is launched under `bypassPermissions` (see
// `RESIDENT_PERMISSION_MODE`), and a Claude CLI with the user's own
// `remoteControlAtStartup` on is reachable from *other machines*: Remote Control
// bridges it to Anthropic's backend, where a peer session on another host can
// drive it. A resident process that nobody is watching, running under bypass,
// therefore has a trust boundary that is wider than the Unix user this
// application's whole process model assumes — which is the boundary the proposal
// promised. The gate below is the conservative branch of that promise.
//
// ## Why "refuse" and not "turn it off"
//
// The obvious fix — state `remoteControlAtStartup: false` in the launch's own
// settings and rely on it — is *also* done (see `CLAUDE_REMOTE_CONTROL_FLAGS`),
// but it is not what the refusal rests on, because this build has no reading
// that the flag wins: E9 §9.7 asked the running process what its settings were
// and got no answer at all (`get_settings` never responded), so "the flag
// overrides the user's file" is an assumption rather than a measurement. A gate
// that assumed it would be claiming a security property from an unmeasured
// precedence rule. So the user's *file* is read first, and if it says on, no
// process is started at all: the refusal is a fact this side owns, where the
// precedence is not. The two flags are still passed on every launch that *does*
// happen — defence in depth, and stated as such, never as evidence.
//
// ## What is read, and what is not
//
// User-level settings only: `<CLAUDE_CONFIG_DIR>/settings.json`. Project-level,
// local and managed settings are **not** read by this gate — that is a known gap,
// not an oversight, and it is recorded as one here because the reading has to be
// honest about its own scope. The file is read at launch time, on the config
// directory the process will actually be given, so what is read is what the
// child sees.
//
// A missing file, a missing key, an unparseable file and a `false` all read as
// "not on": only a literal `true` refuses. That is a deliberate asymmetry — this
// gate does not turn a file it cannot read into a permission it never granted —
// and it is why the reading is three-valued (`null` for "not stated") rather
// than a boolean: a criterion has to be able to tell `false` from "the key was
// not there at all".

/** The file inside a Claude config directory that holds the user-level settings. */
export const CLAUDE_USER_SETTINGS_FILE = 'settings.json';

/** The user-level key that turns Remote Control on at startup. */
export const CLAUDE_REMOTE_CONTROL_KEY = 'remoteControlAtStartup';

/**
 * The user-level key that requires an explicit approval before `SendMessage` can
 * reach a peer session on another machine.
 */
export const CLAUDE_ISOLATE_PEERS_KEY = 'isolatePeerMachines';

/**
 * The words the refusal's copy carries, named as constants for the same reason
 * `UNATTENDED_REFUSAL` is: the sentence is a user-facing statement this build
 * makes in exactly one place, and a criterion has to be able to hold it to those
 * words rather than to a paraphrase of them.
 */
export const REMOTE_CONTROL_ENABLED_REFUSAL = 'Remote Control 已开启';
export const REMOTE_CONTROL_BYPASS_REASON = '以 bypass 运行的常驻进程会被跨机器驱动';

/**
 * The two flags every resident launch states, requested and launched alike.
 *
 * `remoteControlAtStartup: false` is the defence-in-depth half and
 * `isolatePeerMachines: true` is the peer half — measured out of the SDK's own
 * type (`sdk.d.ts`: "Require explicit approval before SendMessage can reach a
 * peer session on another machine via Remote Control"). Both travel together
 * because the SDK's `settings` is one object; a launch that stated only one of
 * them would be a build that dropped half the sentence.
 */
export const CLAUDE_REMOTE_CONTROL_FLAGS: ClaudeRemoteControlFlags = {
  remoteControlAtStartup: false,
  isolatePeerMachines: true,
};

export type ClaudeRemoteControlFlags = {
  remoteControlAtStartup: boolean;
  isolatePeerMachines: boolean;
};

/**
 * What one user-level settings file said, key by key.
 *
 * `path` is carried so a reading can be printed next to the file it came from —
 * the criterion's negative half ("nothing under `~/.claude` was touched") is only
 * checkable if every reading names its source.
 */
export type ClaudeUserSettingsReading = {
  path: string;
  /** `true` only for a literal `true`; `false` for a literal `false`; else `null`. */
  remoteControlAtStartup: boolean | null;
  isolatePeerMachines: boolean | null;
};

/**
 * Why a resident start was refused, and what the user is told about it.
 *
 * `code` is a member of the application's refusal vocabulary (`HostBindErrorCode`)
 * rather than a word this file invents, so a caller branches on it the same way
 * it branches on the manager's two placement refusals; `message` is the
 * interface copy verbatim — the sentence a client renders is *this* string, not
 * a second one written beside it.
 */
export type ClaudeRemoteControlRefusal = {
  code: Extract<HostBindErrorCode, 'remote-control-enabled'>;
  message: string;
  /** The settings file the reading that refused came from, verbatim. */
  settingsPath: string;
  /** When the refusal was made, in host clock terms. */
  at: number;
};

/**
 * The refusal, as something a caller can catch.
 *
 * Thrown rather than returned because the refusal happens inside a *run*, whose
 * signature (`Promise<void>`) has no room for an answer, and because the caller
 * that has to branch on it — the application dispatch — already handles a
 * rejected run. `code` and `settingsPath` are carried as fields rather than
 * folded into the message so the branch is on a value, not on prose.
 */
export class ClaudeRemoteControlRefusalError extends Error {
  readonly code: ClaudeRemoteControlRefusal['code'];
  readonly settingsPath: string;

  constructor(refusal: ClaudeRemoteControlRefusal) {
    super(refusal.message);
    this.name = 'ClaudeRemoteControlRefusalError';
    this.code = refusal.code;
    this.settingsPath = refusal.settingsPath;
  }
}

/** The refusal's copy, built once so every caller gets the same sentence. */
export function remoteControlRefusalMessage(): string {
  return (
    `${REMOTE_CONTROL_ENABLED_REFUSAL}：${REMOTE_CONTROL_BYPASS_REASON}，` +
    '已拒绝以 bypass 启动常驻进程。请在用户级 settings 里关闭 Remote Control 后重试。'
  );
}

/** True for exactly the two JSON values this gate reads as a statement. */
function readSettingsFlag(value: unknown): boolean | null {
  return value === true ? true : value === false ? false : null;
}

/**
 * Reads one user-level settings file, as the gate sees it.
 *
 * The three "not stated" paths — no such file, unreadable file, unparseable
 * JSON — all answer `null` for both keys rather than throwing, because the gate
 * that calls this is deciding whether to *allow* a launch: a settings file this
 * process cannot make sense of is not a file that said "on", and refusing every
 * launch on a machine with a malformed file would trade a real feature for
 * nothing. What that costs is stated above: the reading's scope is one file.
 */
export function readClaudeUserSettings(settingsPath: string): ClaudeUserSettingsReading {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch {
    return { path: settingsPath, remoteControlAtStartup: null, isolatePeerMachines: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { path: settingsPath, remoteControlAtStartup: null, isolatePeerMachines: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { path: settingsPath, remoteControlAtStartup: null, isolatePeerMachines: null };
  }

  const record = parsed as Record<string, unknown>;
  return {
    path: settingsPath,
    remoteControlAtStartup: readSettingsFlag(record[CLAUDE_REMOTE_CONTROL_KEY]),
    isolatePeerMachines: readSettingsFlag(record[CLAUDE_ISOLATE_PEERS_KEY]),
  };
}

/** The two Remote Control keys of an SDK `settings` object, as the launch stated them. */
export function readLaunchedRemoteControlSettings(
  settings: unknown,
): { remoteControlAtStartup?: boolean; isolatePeerMachines?: boolean } | null {
  if (!settings || typeof settings !== 'object') {
    return null;
  }
  const record = settings as Record<string, unknown>;
  const launched: { remoteControlAtStartup?: boolean; isolatePeerMachines?: boolean } = {};
  if (typeof record[CLAUDE_REMOTE_CONTROL_KEY] === 'boolean') {
    launched.remoteControlAtStartup = record[CLAUDE_REMOTE_CONTROL_KEY] as boolean;
  }
  if (typeof record[CLAUDE_ISOLATE_PEERS_KEY] === 'boolean') {
    launched.isolatePeerMachines = record[CLAUDE_ISOLATE_PEERS_KEY] as boolean;
  }
  // A bag that carried NEITHER key recorded nothing about Remote Control, and that is a null
  // reading rather than an empty one. `settings` is present for reasons that have nothing to do
  // with these two flags — the Live Voice `UserPromptSubmit` hook is written into the same object,
  // and `applyClaudeEffort` writes its own marker there — so keying the reading off the bag's
  // *existence* would report `{}` for a launch that stated nothing. `{}` is a shape no consumer
  // asked for and one the false-form arm cannot tell from a real reading; `null` keeps the launch
  // that stated nothing reading as "never read back".
  if (launched.remoteControlAtStartup === undefined && launched.isolatePeerMachines === undefined) {
    return null;
  }
  return launched;
}

/**
 * One live Claude CLI process, as the CLI's own registry describes it.
 *
 * Only the fields this driver has a use for are modelled; the file carries more
 * (`startedAt`, `tmux`, `peerFeatures`, …) and unmodelled keys are ignored
 * rather than rejected.
 */
export type ClaudeCliSessionRegistration = {
  pid: number;
  sessionId: string | null;
  /** The address other sessions reach this process at, or null when it has none. */
  name: string | null;
  /** Who chose that name: `derived` (the CLI itself) or `user` (a person). */
  nameSource: string | null;
  /** The socket the address resolves to; its presence is what makes it reachable. */
  messagingSocketPath: string | null;
};

/**
 * The name a live Claude CLI process registered for itself, from the CLI's own
 * registry.
 *
 * `~/.claude/sessions/<pid>.json` is the record the CLI writes for each process
 * on the host: the `name` other sessions address it by, the `nameSource` that
 * says who chose it (`derived` for the CLI's own per-process name, `user` for a
 * name a person set), the provider `sessionId` and the `messagingSocketPath` the
 * address resolves to. It is the *only* reading of the address that is the CLI's
 * own: this app no longer hands the process a name, so there is nothing on its
 * side to compare a requested name against, and — unlike the old arrangement —
 * nothing the app wrote that could show up in the transcript instead.
 *
 * Keyed by pid, because that is how the CLI keys it and because a fresh process
 * derives a fresh name: the record for *this* process is the one under this
 * process's pid. A file that names a different `sessionId` than the conversation
 * this host is running is treated as absent — pids are recycled on a busy host,
 * and a stale record must not hand this binding an address that answers for
 * somebody else.
 *
 * A missing or unparseable file is `null`, not an error: the process writes it
 * at startup, so a caller polls rather than assuming the first read is final.
 */
export function readCliSessionRegistration(
  configDir: string,
  pid: number,
  providerSessionId?: string | null,
): ClaudeCliSessionRegistration | null {
  let raw: string;
  try {
    raw = readFileSync(join(configDir, 'sessions', `${pid}.json`), 'utf8');
  } catch {
    // No registry entry yet, or a registry this process cannot see.
    return null;
  }
  let row: AnyRecord;
  try {
    row = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof row?.pid !== 'number' || row.pid !== pid) {
    return null;
  }
  const sessionId = typeof row.sessionId === 'string' && row.sessionId ? row.sessionId : null;
  if (providerSessionId && sessionId && sessionId !== providerSessionId) {
    return null;
  }
  return {
    pid,
    sessionId,
    name: typeof row.name === 'string' && row.name ? row.name : null,
    nameSource: typeof row.nameSource === 'string' ? row.nameSource : null,
    messagingSocketPath:
      typeof row.messagingSocketPath === 'string' && row.messagingSocketPath ? row.messagingSocketPath : null,
  };
}

// The occupancy registry readers and their refusal now live in `server/shared`,
// because the per-run runtime refuses the same occupied session the resident
// launch does. `findBackgroundSessionOwner` / `ClaudeSessionOccupiedError` are
// imported below for this driver's own launch gate; these two are re-exported
// so the providers barrel (`readClaudeSessionOccupancy`, `ClaudeSessionOccupancy`)
// keeps resolving unchanged.
export { readClaudeSessionOccupancy } from '@/shared/utils.js';
export type { ClaudeSessionOccupancy } from '@/shared/types.js';

/**
 * What the CLI's own `Stop` hook has said about the work it is holding.
 *
 * One reading per hook firing, newest kept. The list is a *ledger* rather than a
 * single value because the hook fires at the end of every turn: at the end of
 * the turn that started background work it lists that work, and at the end of
 * the unattended turn that work produced it lists nothing again. Reading it
 * "latest first" is therefore only correct if the read happens at the right
 * moment — which is why the trigger is taken when an unattended turn *opens*
 * (no round armed, the previous turn's hook the newest entry) and not when it
 * ends (by then the hook has already reported the empty list it leaves behind).
 */
type BackgroundWorkLedger = {
  record(input: AnyRecord): void;
  /** The newest reading that carried a task list, or null when none has. */
  latest(): { backgroundTasks?: unknown; sessionCrons?: unknown } | null;
  /** How many hook firings this process has reported. */
  readonly size: number;
};

function createBackgroundWorkLedger(): BackgroundWorkLedger {
  let entries: Array<{ backgroundTasks?: unknown; sessionCrons?: unknown }> = [];

  return {
    record(input: AnyRecord): void {
      if (!input || typeof input !== 'object') {
        return;
      }
      if (!Array.isArray(input.background_tasks) && !Array.isArray(input.session_crons)) {
        // A hook firing that carries neither list says nothing about what the
        // process holds; keeping it would make the newest entry an empty one and
        // read every later turn as unexplained.
        return;
      }
      entries.push({ backgroundTasks: input.background_tasks, sessionCrons: input.session_crons });
      if (entries.length > 8) {
        entries = entries.slice(-8);
      }
    },
    latest() {
      return entries.at(-1) ?? null;
    },
    get size() {
      return entries.length;
    },
  };
}

// ---------------------------
//----------------- HELD-WORK RECONCILIATION ------------

/**
 * Whether two held-work lists are the same report.
 *
 * The comparison is what keeps a reconciliation from being an event: a `Stop`
 * firing at the end of a quiet turn names the same jobs it named last time, and
 * reporting them again would move the binding's `lastActivityAt` and push the
 * idle deadline out on nothing. `inferred` is part of the comparison because a
 * job first guessed at from a tool call and then named by the CLI is a different
 * fact even when the id matches.
 */
function sameLeases(left: HeldWorkLease[], right: HeldWorkLease[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((lease, index) => {
    const other = right[index];
    if (!other || other.kind !== lease.kind) {
      return false;
    }
    if (lease.kind === 'cron' && other.kind === 'cron') {
      return (
        lease.id === other.id &&
        lease.recurring === other.recurring &&
        lease.expiresAt === other.expiresAt &&
        Boolean(lease.inferred) === Boolean(other.inferred)
      );
    }
    if (lease.kind !== 'cron' && other.kind !== 'cron') {
      return lease.id === other.id && Boolean(lease.inferred) === Boolean(other.inferred);
    }
    return false;
  });
}

/**
 * The `cron` reasons the CLI's own `session_crons` list asks for.
 *
 * `expiresAt` is preserved for an id the driver already holds: the CLI names no
 * instant, and the seven days a job lives are counted from its creation (E9's
 * receipt), so re-dating it on every firing would slide the deadline forward for
 * as long as the user kept talking. A job the list has stopped naming is simply
 * absent from the result, which is what makes "the list no longer names it" the
 * same event as "the reason went away".
 *
 * The entries carry no `inferred` flag: an id read off this list is the CLI's
 * own word for the job, and the absence of the flag is how that reads.
 */
function cronsFromStopList(list: unknown[], now: number, held: CronLease[]): CronLease[] {
  const heldById = new Map(held.map((lease) => [lease.id, lease]));
  return list.flatMap((entry): CronLease[] => {
    const record = entry as AnyRecord | null;
    const id = typeof record?.id === 'string' ? record.id : '';
    if (!id) {
      return [];
    }
    return [
      {
        kind: 'cron',
        id,
        // `!== false` rather than `=== true`, the same reading the per-run
        // driver makes of `run_in_background`: what the CLI schedules is a
        // recurring job, and only an explicit denial says otherwise.
        recurring: record?.recurring !== false,
        expiresAt: heldById.get(id)?.expiresAt ?? now + CRON_MAX_AGE_MS,
      },
    ];
  });
}

/** The background-work reasons a CLI-held task list asks for, keyed by task id. */
function tasksFromStopList(list: unknown[]): BackgroundTaskLease[] {
  return list.flatMap((entry): BackgroundTaskLease[] => {
    const record = entry as AnyRecord | null;
    const id = typeof record?.id === 'string' ? record.id : '';
    return id ? [{ kind: 'background-task', id }] : [];
  });
}

/** The background-work reasons a `background_tasks_changed` payload asks for. */
function tasksFromChangedFrame(tasks: unknown[]): BackgroundTaskLease[] {
  return tasks.flatMap((entry): BackgroundTaskLease[] => {
    const record = entry as AnyRecord | null;
    const id = typeof record?.task_id === 'string' ? record.task_id : '';
    return id ? [{ kind: 'background-task', id }] : [];
  });
}

/** The `task_id` a `task_started` / `task_notification` frame is about. */
function taskIdOf(message: AnyRecord): string {
  return typeof message?.task_id === 'string' ? message.task_id : '';
}

/**
 * The never-ending prompt iterable one resident process reads.
 *
 * The SDK writes each yielded message to the CLI's stdin and, when the iterable
 * is exhausted, closes it (stdin EOF, which the CLI reads as "wind down"). So
 * this queue is two things at once: the channel a turn is delivered through
 * (`push`) and the process's own off switch (`end`). A pull with something
 * buffered yields it; a pull on an ended queue finishes the generator.
 */
type ResidentInputQueue = {
  stream: AsyncIterable<AnyRecord>;
  push(...messages: AnyRecord[]): void;
  end(): void;
};

function createResidentInputQueue(): ResidentInputQueue {
  const buffered: AnyRecord[] = [];
  let wake: (() => void) | null = null;
  let ended = false;

  const stream = (async function* () {
    for (;;) {
      const next = buffered.shift();
      if (next) {
        yield next;
        continue;
      }
      if (ended) {
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  })();

  return {
    stream,
    push(...messages: AnyRecord[]): void {
      if (ended || messages.length === 0) {
        return;
      }
      buffered.push(...messages);
      const resume = wake;
      wake = null;
      resume?.();
    },
    end(): void {
      if (ended) {
        return;
      }
      ended = true;
      const resume = wake;
      wake = null;
      resume?.();
    },
  };
}

/**
 * The SDK's process contract as it really is at this seam: a Node child, which
 * carries a pid.
 *
 * The SDK interface leaves `pid` out (`SpawnedProcess` is what the transport
 * consumes, and its own default spawn returns a facade that hides the child),
 * but both spawn paths this driver can end up wrapping — the SDK's default and
 * the session-scope hook — return the real `ChildProcess`. Widening it here is
 * what makes the pid readable without pretending the SDK promised one.
 */
type ClaudeResidentProcessHandle = SpawnedProcess & { readonly pid?: number };

/**
 * Spawns the CLI the way the SDK's own default spawn does.
 *
 * Used only when the SDK options carry no `spawnClaudeCodeProcess` hook — a host
 * with no usable systemd user manager, where `mapCliOptionsToSDK` leaves the
 * hook unset. It mirrors that default's stdio shape (the CLI's stderr is dropped
 * unless SDK debugging is on) and forwards the abort signal, which the SDK has
 * already delayed past its own stdin-EOF grace window.
 */
function spawnResidentCli(spawnOptions: SdkSpawnOptions): ClaudeResidentProcessHandle {
  const pipedStderr = Boolean(process.env.DEBUG_CLAUDE_AGENT_SDK);
  const child = nodeSpawn(spawnOptions.command, spawnOptions.args, {
    cwd: spawnOptions.cwd,
    env: spawnOptions.env,
    signal: spawnOptions.signal,
    stdio: ['pipe', 'pipe', pipedStderr ? 'pipe' : 'ignore'],
    windowsHide: true,
  });

  if (pipedStderr) {
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  }

  return child as unknown as ClaudeResidentProcessHandle;
}

/**
 * The real SDK, plus the one fact the SDK does not expose: the child pid.
 *
 * The launch options are the runtime's own — `mapCliOptionsToSDK` is the same
 * builder a per-run turn goes through, so a resident process is launched with
 * the same env overlay, executable resolution, effort and permission mapping the
 * per-run path produces. What is added is a spawn hook that wraps whatever hook
 * the builder installed (the memory-capped systemd scope, when this host has
 * one) and keeps the child it returns.
 */
/**
 * The SDK options one resident launch is built from, decided in one place.
 *
 * Split out of {@link createSdkResidentProcess} so the *decisions* about a
 * resident launch can be read without a CLI: the factory's remaining body is the
 * spawn hook, the pid capture and the raw-stdin writer, none of which a reading
 * needs, while the mode and the three entries are exactly what a criterion has to
 * hold the driver to. A factory that substitutes a scripted stream calls this and
 * reads them back; so does the real one, which is what keeps the two from being
 * two different option bags.
 */
export function buildResidentSdkOptions(input: {
  options: AnyRecord;
  permissions?: ClaudeResidentPermissions;
  remoteControlFlags?: ClaudeRemoteControlFlags;
}): AnyRecord {
  const sdkOptions = mapCliOptionsToSDK(input.options) as unknown as AnyRecord;

  // The Remote Control flags, merged into whatever `settings` the shared builder
  // already produced rather than assigned over it: `applyClaudeEffort` writes an
  // `ultracode` marker into the same object, and a launch that lost it would be
  // trading one launch option for another. The resident bag is the only one that
  // states these — a per-run turn has no resident process to isolate — so they
  // arrive on the input rather than being read out of the option bag.
  if (input.remoteControlFlags) {
    sdkOptions.settings = {
      ...((sdkOptions.settings as AnyRecord | undefined) ?? {}),
      ...input.remoteControlFlags,
    };
  }

  // The launch mode is stated *after* the shared builder, not asked of it: the
  // builder maps a caller's `permissionMode` for the per-run path, where a turn
  // ends and a person can be asked; a resident process is launched under the
  // mode this file owns (see `RESIDENT_PERMISSION_MODE`) and moves it live if it
  // ever should. Both options are written together because the SDK requires
  // `allowDangerouslySkipPermissions` alongside `bypassPermissions`.
  sdkOptions.permissionMode = RESIDENT_PERMISSION_MODE;
  sdkOptions.allowDangerouslySkipPermissions = true;

  // The three human-facing entries, installed verbatim. The host builds them
  // (`createPermissionEntries`) and this factory only hands them to the SDK —
  // which is the whole reason they travel on the factory input rather than being
  // built here: the policy is the driver's, the installation is the launch's.
  if (input.permissions) {
    sdkOptions.canUseTool = input.permissions.canUseTool;
    sdkOptions.onElicitation = input.permissions.onElicitation;
    sdkOptions.onUserDialog = input.permissions.onUserDialog;
  }

  return sdkOptions;
}

/**
 * The SDK entry point one resident launch goes through.
 *
 * `query` is a module-level function — the per-run driver's `ClaudeHostQueryFactory`
 * states the same problem for the same reason — so there is no seam to stub and
 * no module-mocking precedent in this repository. A caller that wants to *read*
 * the options a launch is built with hands in its own, and that is the only way
 * the reading can come from the production path rather than from a second copy
 * of it: the option bag is built by {@link buildResidentSdkOptions}, handed
 * straight to this, and the default is the SDK.
 */
export type ClaudeResidentQueryFactory = (input: {
  prompt: AsyncIterable<AnyRecord>;
  options: AnyRecord;
}) => ClaudeResidentQuery;

/** The real SDK, at the one boundary where its wide type meets this module's narrow one. */
const sdkResidentQuery: ClaudeResidentQueryFactory = (input) =>
  query(input as unknown as Parameters<typeof query>[0]) as unknown as ClaudeResidentQuery;

export function createSdkResidentProcess(
  input: {
    prompt: AsyncIterable<AnyRecord>;
    options: AnyRecord;
    seams?: ClaudeResidentProcessSeams;
    permissions?: ClaudeResidentPermissions;
    remoteControlFlags?: ClaudeRemoteControlFlags;
  },
  launchSeams: { createQuery?: ClaudeResidentQueryFactory } = {},
): ClaudeResidentProcess {
  const sdkOptions = buildResidentSdkOptions(input);
  const installedSpawn = sdkOptions.spawnClaudeCodeProcess as
    | ((options: SdkSpawnOptions) => SpawnedProcess)
    | undefined;
  let pid: number | null = null;
  let stdin: Writable | null = null;

  // The `Stop` hook, appended to whatever `hooks` the launch builder produced —
  // the same way the spawn hook below wraps whatever hook it found — so nothing
  // the builder set is replaced. The callback returns an empty object, which is
  // the hook contract's "no decision": a hook that answered anything else here
  // would change the turn it is only supposed to be read from.
  //
  // The write goes through a record view because `hooks` is not part of the
  // builder's declared return; it is still the same object that is handed to
  // `query`, which reads `hooks` off it at runtime like any other option.
  const launchOptions = sdkOptions as unknown as Record<string, unknown>;

  // Raw CLI flags, carried through from the caller's option bag.
  //
  // The shared launch builder maps options field by field and has no passthrough
  // for `extraArgs`, which is deliberate: it is the builder every per-run turn
  // goes through, and a per-run turn has no launch-time address to state. The
  // resident factory is where that gap belongs, because it is the factory that
  // owns what a *resident* process is launched with — so the flag is copied here
  // rather than taught to the shared builder.
  const extraArgs = (input.options as AnyRecord)?.extraArgs;
  if (extraArgs && typeof extraArgs === 'object') {
    launchOptions.extraArgs = extraArgs;
  }

  const onStop = input.seams?.onStop;
  if (onStop) {
    const installedHooks = (launchOptions.hooks ?? {}) as Record<string, unknown>;
    const installedStop = Array.isArray(installedHooks.Stop) ? installedHooks.Stop : [];
    launchOptions.hooks = {
      ...installedHooks,
      Stop: [
        ...installedStop,
        {
          hooks: [
            async (hookInput: AnyRecord) => {
              onStop(hookInput);
              return {};
            },
          ],
        },
      ],
    };
  }

  // THE LIVE VOICE RULES HOOK — a `UserPromptSubmit` CALLBACK appended to the SDK's `hooks` bag, the
  // same way the `Stop` callback above is: a spread of what was already there, never a replacement.
  //
  // WHY A CALLBACK AND NOT A COMMAND IN `settings`. The `hooks` option bag is the SDK's IN-PROCESS
  // channel: `query()` walks each matcher's `hooks` array, registers every entry under a generated
  // `hookCallbackId`, and later INVOKES it — so an entry has to be a callback function. A
  // `{ type: 'command', command }` object put there is never run: handed to the CLI's callback dispatch
  // as a callee, it reports `Error in hook callback hook_0: … n is not a function` while the command
  // never fires (measured). The command form is the CLI's SETTINGS schema, and that is exactly what
  // this replaces — a command in the settings layer runs in a SEPARATE PROCESS, so every prompt
  // spawned a node process purely to decide whether to print seven lines.
  //
  // GATED BY THE RELAY'S OWN STATE, NOT BY A FILE. The callback asks the process-level registry
  // (`voice-realtime-active.ts`) whether THIS session has a Live Voice connection at this instant. The
  // relay marks a session as a connection is handled and clears it on every path that ends one, so "in
  // voice" is a fact about live memory rather than about a file a killed relay could leave behind —
  // which is what the start-up sweep the file gate needed was papering over. A session with no
  // connection returns `{}`, the hook contract's "no decision", and reads byte-for-byte as it did
  // before this hook existed.
  //
  // WHY THE RULES MODULE IS LOADED HERE AND NOT AT THE TOP OF THIS FILE. A STATIC import of the
  // voice-realtime barrel from this module closes an initialization cycle —
  // `voice-realtime/index` → `voice-realtime-live-executor` → `mcp-gateway/index` → `providers/index`
  // → `provider.registry` → this file — and the module that closes it throws
  // `ReferenceError: Cannot access 'ClaudeResidentHostDriver' before initialization` before the server
  // can start at all (measured). The cross-module rule here is that a module is reached through its
  // barrel, and the barrel is what carries the runtime half that closes the loop, so the edge is made
  // where it is harmless instead of removing it: at SUBMIT time the barrel is already in the module
  // cache — the server's composition root imports it at start-up — so this is a cache lookup, not a
  // load. The registry itself imports nothing, so it costs the providers side nothing new.
  //
  // THE TWO EXPERIMENTAL SWITCHES STAY. `VOICE_MODE_HOOK_FORCE=1` injects regardless of the registry and
  // `VOICE_MODE_RULES_VARIANT` selects the rules arm; both are read HERE, at submit time, so a launch's
  // arm is a property of the environment the process runs under.
  const launchHooks = (launchOptions.hooks ?? {}) as Record<string, unknown>;
  const installedUserPromptSubmit = Array.isArray(launchHooks.UserPromptSubmit)
    ? launchHooks.UserPromptSubmit
    : [];
  launchOptions.hooks = {
    ...launchHooks,
    UserPromptSubmit: [
      ...installedUserPromptSubmit,
      {
        hooks: [
          async (hookInput: AnyRecord): Promise<AnyRecord> => {
            const { isVoiceSessionActive, rulesFor } = await import(
              '@/modules/voice-realtime/index.js'
            );
            const sessionId = typeof hookInput.session_id === 'string' ? hookInput.session_id : '';
            if (process.env.VOICE_MODE_HOOK_FORCE !== '1' && !isVoiceSessionActive(sessionId)) {
              return {};
            }
            return {
              hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: rulesFor(process.env.VOICE_MODE_RULES_VARIANT),
              },
            };
          },
        ],
      },
    ],
  };

  sdkOptions.spawnClaudeCodeProcess = (spawnOptions: SdkSpawnOptions): SpawnedProcess => {
    const child = installedSpawn
      ? (installedSpawn(spawnOptions) as ClaudeResidentProcessHandle)
      : spawnResidentCli(spawnOptions);
    if (typeof child?.pid === 'number') {
      pid = child.pid;
    }
    // The stdin the SDK writes its own prompt messages to. Kept because a
    // control frame the SDK's `Query` has no verb for has to be written to the
    // same stream by hand (see `ClaudeResidentProcess.writeRaw`). Both writers
    // go through one `Writable`, which preserves write order and writes each
    // chunk whole — a JSON line is far inside the pipe's atomic-write bound.
    if (child?.stdin) {
      stdin = child.stdin;
    }
    return child;
  };

  const stream = (launchSeams.createQuery ?? sdkResidentQuery)({
    prompt: input.prompt,
    options: sdkOptions,
  });

  return {
    query: stream,
    get pid() {
      return pid;
    },
    writeRaw(frame: AnyRecord): void {
      if (!stdin || stdin.destroyed) {
        return;
      }
      stdin.write(`${JSON.stringify(frame)}\n`);
    },
    // Read off the bag that was just handed to `query`, not off the request: the
    // point of reporting it is that it is the SDK's copy of the fact rather than
    // the driver's, and the two are only the same number when the launch really
    // stated what it was asked to state.
    launchSettings: readLaunchedRemoteControlSettings(sdkOptions.settings),
  };
}

/**
 * One turn handed to a resident process, and the promise its dispatcher awaits.
 *
 * `settled` is what makes "the turn is over" idempotent across the two paths
 * that can end a round — its own `result` and an `interrupt` that got there
 * first — and `interrupted` is how the `result` that follows an interrupt knows
 * not to write a terminal `complete` the abort path has already written.
 *
 * Which turn a round belongs to is **not** kept here any more. The ledger binds
 * a delivery to a turn by the id the CLI states (`command_lifecycle started`
 * while a turn is open), and the rounds a turn closes are read from that
 * binding. This record is only what the *dispatcher* owns: who to write to, and
 * the promise to settle.
 */
type ResidentRound = {
  appSessionId: string;
  turn: HostTurnInput;
  writer: ProviderRuntimeWriter;
  context: ProviderRuntimeContext;
  done: Promise<void>;
  settle(): void;
  fail(error: Error): void;
  settled: boolean;
  interrupted: boolean;
};

/**
 * Whether a delivery has reached the one terminal the CLI states for it (C-1).
 *
 * The single definition of "this command is over", so the settled test, the
 * owed test and the anomaly reconciliation cannot drift apart: a delivery is
 * done exactly when it is `completed` or `cancelled`, and nothing else counts.
 */
function isTerminalDeliveryState(state: ClaudeResidentDeliveryState): boolean {
  return state === 'completed' || state === 'cancelled';
}

/**
 * Where one accepted send has got to, as the CLI states it.
 *
 * The state a delivery is in is written by exactly one thing: the CLI's own
 * `command_lifecycle` (`queued` → `started` → `completed`|`cancelled`). A send
 * the host has written but the CLI has not yet reported is `pushed`, which is
 * this driver's own mark and the reason the ledger has a state the CLI's
 * vocabulary does not carry.
 */
export type ClaudeResidentDeliveryState = 'pushed' | 'queued' | 'started' | 'completed' | 'cancelled';

/**
 * Why a delivery or a turn ended in a way that was not a clean completion.
 *
 * `cli` is the residual: the CLI stated a terminal this driver never asked for,
 * which is the ordinary result of a turn that simply finished. The rest are the
 * ends somebody here caused or reconciled: a withdrawal this host requested, an
 * interrupt it requested, the process going away, and the reconciliation of a
 * command whose terminal never arrived (I4).
 */
export type ClaudeResidentDeliveryReason =
  | 'withdrawn'
  | 'interrupt'
  | 'process-exit'
  | 'owed-terminal-missing'
  | 'cli';

/**
 * One delivery: one accepted send, and the run its dispatcher is awaiting.
 *
 * The identity is the CLI's, not this driver's: `commandUuid` is the value the
 * CLI reports back in `command_lifecycle`, and every frame of the send is
 * recorded under it so a lifecycle event finds the delivery it belongs to
 * whatever frame the CLI chose to name. Nothing here is inferred from a
 * position in a list.
 */
type ResidentLedgerDelivery = {
  /** The uuid this delivery is addressed by — the last frame's, which is the prompt. */
  commandUuid: string;
  /** Every frame uuid this one send wrote (an attachment expansion writes several). */
  uuids: string[];
  state: ClaudeResidentDeliveryState;
  reason: ClaudeResidentDeliveryReason | null;
  /** The turn the CLI bound this command to (C-2), or null while it is bound to none. */
  turnId: string | null;
  /**
   * Whether the dispatcher that sent this delivery is still awaiting its run.
   *
   * Cleared when the run is settled — at its turn's close, which is the moment
   * the run's terminal frame is written. It is deliberately NOT the same thing
   * as `state`: C-3 makes the CLI's terminal and the turn's `RESULT` two
   * independent events, so a delivery can be terminal while its run is still
   * open (folded command) or open while its terminal has not been read (a
   * first command whose `completed` follows its `RESULT`).
   */
  runOpen: boolean;
  /**
   * True when the run closed while the CLI had not yet stated a terminal (I4).
   *
   * This is the cross-check the order-independence of §5.3 rests on: an owed
   * delivery is expected to receive its terminal before the next turn begins,
   * and one that does not is settled `cancelled(owed-terminal-missing)` and
   * recorded as an anomaly rather than left quietly non-terminal.
   */
  owed: boolean;
  /** True when this host asked the CLI to withdraw the command. */
  withdrawalRequested: boolean;
  enqueuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  priority: string | null;
  /** The dispatcher's own record, carrying the writer and the settlement. */
  round: ResidentRound;
  /** The manager lease this run holds while it is open. */
  leaseId: string;
  /** Whether that lease is currently reported to the manager. */
  leaseHeld: boolean;
};

/**
 * The turn the CLI is working on, as the ledger sees it.
 *
 * Minted at `system/init` and closed at `RESULT` — the two moments the CLI
 * itself states a turn boundary with (C-6: there is no `session_state_changed`).
 */
type ResidentLedgerTurn = {
  id: string;
  /**
   * Whether anybody at this end sent the command that opened it.
   *
   * Read at the `init` from the commands already waiting to be bound: a turn
   * whose opener this host pushed is `delivered`, and one nothing here pushed is
   * `unattended` — the CLI's own cron or background follow-up, which no caller
   * holds a handle for (I5).
   */
  kind: 'delivered' | 'unattended';
  open: boolean;
  /** The delivery the turn's frames belong to: the earliest command it bound. */
  ownerDeliveryId: string | null;
  /** Whether this host has asked the CLI to interrupt, so its `RESULT` reads `aborted`. */
  interruptRequested: boolean;
};

/**
 * One host's delivery/turn ledger, and the anomalies it has recorded.
 *
 * This is the whole of the host's own account of what it sent and what the CLI
 * said came of it. Every state in it is written by an event the CLI or this
 * driver caused — never by a position in a list, a count of results, or an
 * inference from how many turns have ended. Its other readers (the manager's
 * leases, the registry's runs, this driver's own readings) are projections of
 * it, recomputed rather than balanced by hand.
 */
type ResidentLedger = {
  /** Every delivery this host has sent, in send order. */
  deliveries: ResidentLedgerDelivery[];
  /** The same deliveries, addressed by any frame uuid they wrote. */
  byUuid: Map<string, ResidentLedgerDelivery>;
  /**
   * Commands the CLI started under a uuid nothing here pushed.
   *
   * The CLI's own cron firings carry a `started` this host never wrote (E9
   * §9.4). They are kept so the ledger can say which commands were not its own
   * — the cross-check an unattended turn's `init` is read against (I5) — and
   * they are deliberately **not** deliveries: no caller holds a handle, so
   * there is nothing to report to and nothing to expose. Nothing here projects
   * them either: S1 leaves the host's busy surface exactly as it was (N-1), and
   * a foreign command's own terminal is the CLI's business rather than this
   * ledger's.
   */
  foreign: Set<string>;
  /** The turn the CLI is working on, or the one most recently closed. */
  turn: ResidentLedgerTurn | null;
  /** Every turn that has closed, in order, with the terminal it read. */
  closedTurns: Array<{
    id: string;
    kind: 'delivered' | 'unattended';
    outcome: 'completed' | 'aborted';
    ownerDeliveryId: string | null;
  }>;
  /** Commands the CLI started while no turn was open, waiting for the next one. */
  pendingStart: ResidentLedgerDelivery[];
  /**
   * The ledger's own account of a state it could not make consistent.
   *
   * Recorded rather than thrown: a stream that breaks one of the CLI's rules is
   * a fact about the CLI, and ending the read loop over it would take the whole
   * process down on a frame the CLI is entitled to send.
   */
  anomalies: Array<{ code: string; detail: string }>;
};

/**
 * One delivery, as {@link ClaudeResidentHostDriver.ledgerReading} reports it.
 *
 * A copy, so a reader cannot reach into host state. It is the criterion's whole
 * input: AC-378 drives a real host through scripted sequences and reads the
 * ledger back rather than reaching into the driver, so a red lands on a stated
 * reading rather than on a private field.
 */
export type ClaudeResidentLedgerReading = {
  deliveries: Array<{
    deliveryId: string;
    state: ClaudeResidentDeliveryState;
    reason: ClaudeResidentDeliveryReason | null;
    turnId: string | null;
    runOpen: boolean;
    owed: boolean;
    enqueuedAt: number;
    startedAt: number | null;
    endedAt: number | null;
    priority: string | null;
  }>;
  foreign: string[];
  turn: {
    id: string;
    kind: 'delivered' | 'unattended';
    open: boolean;
    ownerDeliveryId: string | null;
    interruptRequested: boolean;
  } | null;
  closedTurns: Array<{
    id: string;
    kind: 'delivered' | 'unattended';
    outcome: 'completed' | 'aborted';
    ownerDeliveryId: string | null;
  }>;
  pendingStart: string[];
  anomalies: Array<{ code: string; detail: string }>;
  /** How many deliveries still have a run open — the projection the leases follow. */
  openRuns: number;
};

/**
 * One resident host: the process, the queue it reads, and the turns waiting on it.
 *
 * Per host rather than per driver because all four are per-process facts. The
 * manager's host record stays the manager's; this is what the driver needs to
 * deliver a turn and to answer for the process's lifetime.
 */
type ResidentHostState = {
  hostId: string;
  appSessionId: string;
  sink: IProviderHostDriverSink;
  queue: ResidentInputQueue;
  process: ClaudeResidentProcess;
  /**
   * The delivery/turn ledger: the host's own account of every send it made and
   * every turn the CLI ran for it. It is the authority the rest of this state is
   * derived from.
   */
  turnLedger: ResidentLedger;
  /**
   * The runs still awaiting their turn to end, in the order they were armed.
   *
   * A **projection of the ledger** (`ledger.deliveries` with `runOpen`), kept as
   * its own list because it is the shape every reader of this state already
   * asks for: the front entry is the turn in flight, so `rounds[0].writer` is
   * the writer the current turn's frames belong to and `rounds.length > 0` is
   * "this process is busy". Nothing is added to or removed from it by position
   * logic any more — `openRun`/`closeRun` keep it in step with the ledger.
   */
  rounds: ResidentRound[];
  /** The last runtime context seen, so frames arriving outside a round still normalize. */
  context: ProviderRuntimeContext | null;
  /** The last writer seen, for frames no round owns. */
  writer: ProviderRuntimeWriter | null;
  /**
   * Every uuid this host has stamped on a user frame it pushed.
   *
   * The host's own mark on the turns it sent. It is not the CLI's id for a turn
   * — the stream never echoes a pushed uuid (measured: a pushed uuid appears in
   * no message the SDK emits) — so the set can only ever be read from this side,
   * and that is the reading it is for: a turn whose opener carries a uuid that
   * is not in this set was not pushed by anyone here.
   */
  pushedUuids: Set<string>;
  /** The `Stop` hook's own account of what this process is holding. */
  ledger: BackgroundWorkLedger;
  /**
   * The held-work reasons this driver has reported, so convergence is a diff.
   *
   * Kept here rather than read back off the manager because the manager reports
   * leases *by kind* — "the cron reason" — while this driver reconciles them by
   * id, and a rule that has to decide whether a `Stop` firing changed anything
   * needs the list it last reported, not the union the manager derived from it.
   */
  heldCrons: CronLease[];
  heldBackgroundTasks: BackgroundTaskLease[];
  /**
   * Whether the CLI's own list has ever named each kind of held work.
   *
   * The two flags are the whole of "is this build guessing?". Until a `Stop`
   * firing has carried `session_crons`, the only account of the crons available
   * is what the stream's tool calls imply, and anything read that way is marked
   * `inferred`; the same for `background_tasks`. Observed independently because
   * the lists are observed independently — E9's hook always carried both, but a
   * firing that carried one says nothing about the other.
   */
  cronsAuthoritative: boolean;
  tasksAuthoritative: boolean;
  /** See {@link ClaudeResidentLifecycleReading.unhandledSystemSubtypes}. */
  unhandledSystemSubtypes: string[];
  /** The user and session name of the last armed round, for a report no round owns. */
  lastUserId: string | number | null;
  lastSessionName: string | null;
  /**
   * The three human-facing entries this process answers for, and their log.
   *
   * Carried on the host state rather than rebuilt per request because it is one
   * value with one owner: the entries close over it, `startHost` points it at
   * this state, and the reading reads its decisions. See
   * {@link ClaudePermissionScope}.
   */
  permissions: ClaudePermissionScope;
  /** The turn this process opened by itself, while it is open. */
  unattended: {
    /** The CLI-minted uuid of the turn's opener: the value no push accounts for. */
    commandUuid: string;
    /** What the `Stop` hook said the process held when the turn opened. */
    trigger: BackgroundWorkTrigger;
    /** The run's writer. */
    writer: ProviderRuntimeWriter;
  } | null;
  /**
   * The opener uuid of the last unattended turn, kept after that turn ends.
   *
   * The live `unattended` record is cleared when its turn finishes, but the
   * identification it carries outlives it: a reader asking "did this process
   * open a turn nobody pushed?" is asking after the fact, once the turn's text
   * has landed. Held separately so the answer does not depend on the timing.
   */
  lastUnattendedCommandUuid: string | null;
  /**
   * The tool names the process reported at `system/init`.
   *
   * Recorded because the tool table is a launch decision, not a stream fact —
   * it is what says whether a trigger could have been a tool call at all, and
   * it is otherwise unreadable from outside the process.
   */
  initTools: string[];
  /** The `system/task_started` task type, when the process started one. */
  backgroundTaskType: string | null;
  /**
   * Every frame this host pushed while the process was already busy.
   *
   * Busy means a round or an unattended turn was in flight at the push: that is
   * the only state in which a frame is *not* the thing the process is about to
   * work on, and so the only state in which what it was written under (a tier,
   * a queue position) is a fact worth keeping. A cold start's frames are the
   * process's first work and are not recorded here.
   */
  queuedInputs: ClaudeQueuedInput[];
  /** Every `command_lifecycle` event read off the stream, in arrival order. */
  lifecycle: CommandLifecycleEvent[];
  /** Every control frame written to the process's stdin, in write order. */
  controlFrames: Array<{ at: number; requestId: string; frame: AnyRecord }>;
  /** Every `control_response` the CLI sent back, in arrival order. */
  controlResponses: Array<{ at: number; requestId: string | null }>;
  /** When each turn's `result` was read; see {@link ClaudeBusyInputReading.resultTimes}. */
  resultTimes: number[];
  /** How many `session_state_changed` messages the stream carried. */
  sessionStateChanged: number;
  /** Provider-native session id, captured once from the stream. */
  providerSessionId: string | null;
  /**
   * The pid of the process this host holds, when the spawn hook reported one.
   *
   * It is the key to the CLI's own registry (`~/.claude/sessions/<pid>.json`),
   * which is where the process's address is read from: this app no longer hands
   * the CLI a name, so the pid is the only handle it has on the name the CLI
   * derived for itself. Null when the driver could not observe a pid, in which
   * case no address can be read and the binding reports none.
   */
  pid: number | null;
  /**
   * Where this process's CLI keeps its state, as the process itself was told.
   *
   * Read from the environment the child really receives — the launch builder
   * builds `sdkOptions.env` from the host's own environment and ignores any
   * `env` a caller puts in the option bag, so reading the bag here would be
   * reading something that never reached the process.
   */
  configDir: string;
  /**
   * The working directory this process was launched in, or null when the turn
   * stated none.
   *
   * Kept for the same reason `configDir` is: it is the other half of the path to
   * this process's transcript (see `claudeProjectTranscriptPath`), and the title
   * mirror reads that transcript directly rather than through a session row.
   */
  projectPath: string | null;
  /** See {@link ResidentTitleMirror}. */
  titleMirror: ResidentTitleMirror;
  /** True once the identity read-back has been started, so it starts only once. */
  identityReadbackStarted: boolean;
  /**
   * The last address this host published through `sink.identity`, or null for none.
   *
   * The address is read back more than once over a host's life — once at startup,
   * and again after the title mirror moves the process's registered name — so the
   * last value is kept to publish only a *change*. Writing the same value twice
   * would tell the manager the address moved when it did not, and a re-read that
   * finds nothing (the rename frame never landed, or landed late) must leave the
   * address where the last successful read put it rather than blank it.
   */
  reportedIdentity: string | null;
  /**
   * The session's own title this process was launched with, or null for none.
   *
   * See {@link PendingHost.launchedTitle}: it is what tells the read-back that a
   * `derived` reading is a process mid-rewrite rather than a settled answer.
   */
  launchedTitle: string | null;
  /** True when this process was launched resuming an existing conversation. */
  resumed: boolean;
  sessionCreatedSent: boolean;
  assistantBudgetSent: boolean;
  modelContextWindow: ReturnType<typeof resolveModelContextWindowRow>;
  /**
   * The pending `T_int` watchdog: armed by an interrupt request, cleared by the
   * `RESULT` that answers it.
   *
   * The one thing about an interrupt that is a *wait* rather than a state. The
   * ledger is left exactly as the CLI's own frames leave it (§6.3) — nothing is
   * synthesized and no lease is taken away — so what keeps an unanswered
   * interrupt from reading as work still in progress is this deadline turning
   * the silence into a named anomaly. `turnId` is the turn the request was
   * placed on, kept for the anomaly's detail rather than re-read at fire time.
   */
  interruptWatchdog: { timer: ReturnType<typeof setTimeout>; turnId: string | null } | null;
  /** Set once the manager closed this host or the stream ended under it. */
  closed: boolean;
  /** The failure the stream ended with, when it ended on its own. */
  loopError: Error | null;
};

/** The next resident process's state, handed to `startHost` through `openHost`. */
type PendingHost = {
  queue: ResidentInputQueue;
  process: ClaudeResidentProcess;
  modelContextWindow: ReturnType<typeof resolveModelContextWindowRow>;
  /** The hook ledger built for this process, carried over with the queue. */
  ledger: BackgroundWorkLedger;
  /**
   * The process's pid, and the directory its CLI keeps state in — both read
   * facts for the address read-back, both settled before `openHost` adopts the
   * host. Carried here rather than recomputed at adoption because the config dir
   * is derived from the environment the child was actually launched under, which
   * `startHost` never sees.
   */
  pid: number | null;
  configDir: string;
  /** The working directory this process was launched in, or null when none was stated. */
  projectPath: string | null;
  /** The one slot this process's `Stop` hook can reach before its host exists. */
  stopHook: StopHookSink;
  /**
   * The permission scope built for this process, adopted with it.
   *
   * Travels beside the ledger and the `Stop` sink for the same reason: all three
   * are created before the spawn — they have to be, or the first turn's own
   * request would be answered into nothing — while the host state they belong to
   * is built one `openHost` later.
   */
  permissions: ClaudePermissionScope;
  /**
   * What this launch asked and read about Remote Control, adopted with the host.
   *
   * Built before `openHost` — the reading is taken before the spawn, because the
   * whole point of the gate is that a refused launch never reaches it — and
   * written onto the live host record by `startHost`, which is the only moment
   * the driver holds that record (see {@link ProcessHost.remoteControl}).
   */
  remoteControl: RemoteControlIsolation;
  /**
   * The session's own title this launch handed the CLI, or null for none.
   *
   * Carried to the host record because it is the one thing the address read-back
   * cannot learn from the registry alone: a process launched *with* a title
   * writes its entry twice — once under the derived name as it starts, once
   * under the adopted title a moment later — so a `derived` reading on such a
   * process is a state it is on its way out of, not its address.
   */
  launchedTitle: string | null;
};

/**
 * Where a process's `Stop` hook writes until its host state exists.
 *
 * The hook is installed before the spawn — it has to be, or the first turn's
 * firing would be lost — while the host state it reconciles into is built by
 * `startHost`, one `openHost` later. The two orderings cannot be made the same,
 * so a firing that lands in the gap is buffered here and replayed on adoption
 * instead of being dropped or, worse, reconciled against nothing.
 */
type StopHookSink = {
  /** The adopted state, or null while the host is still being opened. */
  state: ResidentHostState | null;
  /** Firings that arrived before it was adopted, replayed in arrival order. */
  buffered: AnyRecord[];
};

/**
 * The SDK's `transformMessage`, inlined.
 *
 * The runtime's own transformer is module-private and its whole body is this one
 * copy: subagent traffic carries `parent_tool_use_id` and every frame the
 * normalizer makes of such a message needs it as `parentToolUseId` to stay
 * grouped under the tool card that spawned it. Copying it here rather than
 * exporting it keeps a `.js` file outside this task's touched set untouched.
 */
function transformResidentMessage(message: AnyRecord): AnyRecord {
  if (message?.parent_tool_use_id) {
    return { ...message, parentToolUseId: message.parent_tool_use_id };
  }
  return message;
}

/** Interrupts a query, treating a refused interrupt as the turn having moved on. */
async function stopResidentTurn(queryStream: ClaudeResidentQuery): Promise<void> {
  try {
    await queryStream.interrupt();
  } catch {
    // The turn is going away either way; a refused interrupt is not a failure to
    // stop, so there is nothing left for the caller to branch on.
  }
}

// ------------------------- The live peer-name mirror -------------------------

/**
 * How often a resident host re-reads its transcript for a settled title, and how
 * long the settle window after one turn lasts.
 *
 * The window is bounded rather than open-ended: a process whose session never
 * earns an `ai-title` must not cost a transcript read every few hundred
 * milliseconds for the whole life of the host, so a turn that produces no title
 * spends its window and stops, and the next turn opens a fresh one.
 */
const CLAUDE_RESIDENT_TITLE_MIRROR_POLL_MS = 300;
const CLAUDE_RESIDENT_TITLE_MIRROR_WINDOW_MS = 20_000;

/**
 * The transcript path the CLI files `providerSessionId` under, given the launch
 * working directory.
 *
 * The CLI names a project directory by replacing every character outside
 * `[a-zA-Z0-9-]` of the session's working directory with a hyphen, so
 * `/home/me/work` files under `-home-me-work`. That encoding is the CLI's own
 * (the fork path and the token-usage resolver both rely on it), which is why the
 * path is computed here rather than read back from a session row: a host holding
 * a live process has been writing for seconds, while the row's `jsonl_path` is
 * filled by a scan that may not have reached the file yet.
 */
function claudeProjectTranscriptPath(
  configDir: string,
  projectPath: string,
  providerSessionId: string,
): string {
  const encodedProjectDir = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
  return join(configDir, 'projects', encodedProjectDir, `${providerSessionId}.jsonl`);
}

/**
 * What one host has read of its session's generated title, and what it did with
 * it.
 *
 * `lastSeen` is the previous observation's value, which is what turns "read the
 * title" into "read the *settled* title": the frame goes out only when a value
 * repeats, so a title still being written, or a first draft the CLI later
 * replaces, is not mistaken for the finished one. `mirrored` is the value
 * already written into the registry, and its presence is what makes the frame a
 * one-time act — a host that has mirrored never mirrors again, however many
 * times the CLI appends the same title afterwards.
 */
type ResidentTitleMirror = {
  /** The `ai-title` read at the previous observation, or null. */
  lastSeen: string | null;
  /** The title already written into the registry, or null while none has. */
  mirrored: string | null;
  /** The pending settle-window timer, or null when none is armed. */
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * True while a window is armed or one of its reads is in flight.
   *
   * The window is opened from every stream message, so without this a busy turn
   * would start a read per message: the flag makes the message a *prompt* to open
   * a window rather than a new window, and keeps the read cost at one poll per
   * interval for the window's whole life.
   */
  open: boolean;
  /**
   * True once a window has been opened for the turn in flight.
   *
   * The trigger moved off the `result` and onto the stream, where messages are
   * frequent; this is what holds the cost to *one* window per turn. It is cleared
   * at each `result`, so the next turn opens its own window at its own first
   * message — the old per-turn cadence, opened early enough to catch a title that
   * lands while the turn is still running.
   */
  openedForTurn: boolean;
};

/**
 * Owns the process lifetime of Claude's `resident` hosts.
 *
 * Constructed per provider (one instance serves every session, because a driver
 * holds no per-process state outside its maps). See the file header for what it
 * reports, what it never decides, and what it deliberately does not own.
 */
export class ClaudeResidentHostDriver implements IProviderHostDriver {
  private readonly provider: LLMProvider = 'claude';
  /**
   * One conversation per process. Stated rather than left absent because the
   * manager reads this as `=== true`, and because it is the reason a second
   * resident session gets its own process instead of a second binding.
   */
  readonly multiplexedHost = false;
  private readonly host: ClaudeResidentHostPort;
  private readonly notifyRunStopped: (event: ClaudeResidentRunStoppedEvent) => void;
  private readonly notifyUnattendedWork: (event: ClaudeUnattendedWorkEvent) => void;
  private readonly createProcess: ClaudeResidentProcessFactory;
  /** The instant a held-work reason is dated from; see {@link ClaudeResidentHostDriverOptions.now}. */
  private readonly now: () => number;
  /**
   * How long an interrupt waits for its `RESULT`; see
   * {@link ClaudeResidentHostDriverOptions.interruptResultTimeoutMs}.
   */
  private readonly interruptResultTimeoutMs: number;
  /** How many browsers are connected; see {@link ClaudeResidentHostDriverOptions.connectedClientCount}. */
  private readonly connectedClientCount: () => number;
  /** Where a permission notification goes; see {@link ClaudeResidentHostDriverOptions.notifyUser}. */
  private readonly notifyUser: (delivery: { userId: string | number | null; event: AnyRecord }) => void;
  /**
   * The user-level settings file the gate reads; null means "resolve it at
   * launch time from the config directory the process will run under".
   */
  private readonly userSettingsPath: string | null;
  /**
   * The refusals this driver has made, newest last per session.
   *
   * Kept because a refusal leaves no host behind — that is the point of it — so
   * there is nothing in `snapshot()` to carry the code and the copy to a reader.
   * The caller that caught the thrown error has them already; this is for the
   * caller that did not, which is every caller that reached the run through the
   * application dispatch (`chat.send`): there the rejection is logged and the
   * turn ends with a terminal frame, and the *reason* would otherwise be
   * unreadable from outside. The same shape the permission log has, and for the
   * same reason: a decision nothing else records.
   */
  private readonly refusals = new Map<string, ClaudeRemoteControlRefusal>();
  /**
   * The per-run facet, composed rather than replaced.
   *
   * The provider mounts exactly one `hostDriver`, so whoever holds the slot
   * serves every mode its capabilities declare — and `claude` declares both. A
   * `per-run` host opened by anyone (the criterion in `claude-host-per-run.test.ts`
   * is one) must still have working verbs, and the file that already implements
   * them owns the per-run process rules; reimplementing them here would be a
   * second copy to keep in step. Nothing on the per-run *dispatch* path goes
   * through a host driver at all — the manager's default wrapper owns it — so
   * this is about the facet being complete, not about per-run turn routing.
   */
  private readonly perRun: ClaudePerRunHostDriver;
  /** The live state per host. */
  private readonly hosts = new Map<string, ResidentHostState>();
  /** What the next `startHost` should adopt, since `openHost` decides the host id. */
  private pending: PendingHost | null = null;
  /** Counted turn ids: one per armed round, so a reading of the lease is repeatable. */
  private serial = 0;

  constructor(options: ClaudeResidentHostDriverOptions) {
    this.host = options.host;
    this.notifyRunStopped = options.notifyRunStopped;
    this.notifyUnattendedWork = options.notifyUnattendedWork;
    this.createProcess = options.createProcess ?? createSdkResidentProcess;
    this.now = options.now ?? (() => Date.now());
    this.interruptResultTimeoutMs =
      options.interruptResultTimeoutMs ?? CLAUDE_RESIDENT_INTERRUPT_RESULT_TIMEOUT_MS;
    this.connectedClientCount = options.connectedClientCount ?? (() => 0);
    this.notifyUser =
      options.notifyUser ?? (({ userId, event }) => notifyUserIfEnabled({ userId, event }));
    this.userSettingsPath = options.userSettingsPath ?? null;
    this.perRun = new ClaudePerRunHostDriver({
      host: options.host,
      notify: options.notifyBackgroundWork,
    });
  }

  /**
   * Opens this session's own resident process, with no turn behind it.
   *
   * The entry the on-demand [Start] control needs, and the one this driver's
   * absence made unreachable: a fresh resident session cannot be placed through
   * `bindSession` (this driver declares `multiplexedHost = false`, so any live
   * claude host refuses the second conversation) and cannot be placed through
   * `openHost` either (`startHost` throws when there is no process, and a resident
   * process is brought up by `run`). This is that launch with the turn left out.
   *
   * It reuses {@link startResidentHost} rather than growing a second launch path:
   * the Remote Control gate, the model resolution, the ledger, the `Stop` hook,
   * the permission scope, the spawn and the `openHost` are all turn-independent,
   * and the only thing a cold start does differently is seed the input queue with
   * nothing. The host is therefore left holding one binding, no round and no
   * writer — `idle` with the resident policy's quiet ceiling armed, which is
   * exactly what "started, nothing asked of it yet" should read as. Every read of
   * `state.writer`/`state.context` is null-safe (they are only ever dereferenced
   * through `?.` or a round that armed them), which is what makes a host with no
   * round safe to leave running.
   *
   * Idempotent by the same rule the route applies: a session that already has a
   * live host answers with that host, so a second start is a success that spawns
   * nothing.
   */
  async startResidentSession(
    appSessionId: string,
    launch: HostResidentLaunch,
  ): Promise<HostResidentStartResult> {
    const existing = this.liveStateFor(appSessionId);
    if (existing) {
      return { hostId: existing.hostId, pid: existing.pid };
    }

    // No messages and no command: the queue is what the process reads from, and
    // an empty one is a process that is up and waiting rather than one that has
    // been given work. `options` is the caller's assembled bag (see
    // `HostResidentLaunch`) — this file never reads a session row to build one.
    const state = await this.startResidentHost(
      appSessionId,
      [],
      { command: '', options: launch.options },
      launch.context,
    );

    return { hostId: state.hostId, pid: state.pid };
  }

  /**
   * Dispatches one turn for one session, and answers when the turn is over.
   *
   * This is the resident counterpart to `IProviderRuntime.run`, and the
   * application dispatch awaits it for exactly the reason it awaits the
   * runtime's own promise: the websocket layer's run settles with this turn, and
   * a driver that returned as soon as the messages were written would report
   * every resident turn as instantly complete.
   *
   * The process is found or started first. A session with a live resident host is
   * one whose process is already reading stdin, so the turn is written to it —
   * that is the pid stability this mode is made of. A session without one gets a
   * process of its own, brought up on this turn's messages.
   */
  async run(
    appSessionId: string,
    turn: HostTurnInput,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<void> {
    const existing = this.liveStateFor(appSessionId);
    if (existing) {
      const round = this.createRound(appSessionId, turn, writer, context);
      // A later turn is more stdin on the stream that is already open: the
      // messages go into the queue the process has been reading since it
      // started, which is the whole of "the pid does not change".
      //
      // Busy is read *now*, before the await that builds the messages, and it
      // is read off the two things that make the process busy rather than off
      // the turn count: a round in flight, or an unattended turn the process
      // opened for itself. Either one means the frame being written is not the
      // process's next piece of work but a queue entry behind one — which is
      // the fact the tier states and the fact the criterion reads the write
      // moment against.
      const busy = existing.rounds.length > 0 || Boolean(existing.unattended);
      this.armRound(existing, round, await this.turnMessages(turn, busy), false);
      await round.done;
      return;
    }

    const round = this.createRound(appSessionId, turn, writer, context);
    const messages = await this.turnMessages(turn, false);
    const state = await this.startResidentHost(appSessionId, messages, turn, context);
    // The first round's messages are already in the queue — they seeded it before
    // the process was spawned — so this only arms the round and its lease.
    this.armRound(state, round, messages, true);
    await round.done;
  }

  /**
   * Remembers the sink this host reports through, and adopts the process `run`
   * brought up for it.
   *
   * `startHost` is reached from `openHost`, after the record exists and before
   * the first binding is written, which is the one moment the manager and the
   * driver can be introduced. The process itself is already running: the manager
   * takes a pid only at open time, so a driver that wanted its record to carry
   * one has to have the child in hand before it asks for the host (see the file
   * header).
   */
  async startHost(host: ProcessHost, sink: IProviderHostDriverSink): Promise<ProcessHost> {
    if (host.mode !== 'resident') {
      return this.perRun.startHost(host, sink);
    }

    const pending = this.pending;
    this.pending = null;
    if (!pending) {
      throw new Error(
        `Resident host ${host.hostId} was opened without a process; a resident host is started by the driver's run entry.`,
      );
    }

    // The launch's Remote Control facts, onto the live record.
    //
    // Written here because this is the one moment the driver holds the record
    // itself: `run` gets a copy back from `openHost`, and `snapshot()` hands out
    // copies, so a value written anywhere else would never be visible to a
    // reader. `pid` is the manager's own field and is written the same way, for
    // the same reason.
    host.remoteControl = pending.remoteControl;

    this.hosts.set(host.hostId, {
      hostId: host.hostId,
      appSessionId: host.bindings.keys().next().value as string,
      sink,
      queue: pending.queue,
      process: pending.process,
      turnLedger: {
        deliveries: [],
        byUuid: new Map<string, ResidentLedgerDelivery>(),
        foreign: new Set<string>(),
        turn: null,
        closedTurns: [],
        pendingStart: [],
        anomalies: [],
      },
      rounds: [],
      context: null,
      writer: null,
      pushedUuids: new Set<string>(),
      ledger: pending.ledger,
      heldCrons: [],
      heldBackgroundTasks: [],
      cronsAuthoritative: false,
      tasksAuthoritative: false,
      unhandledSystemSubtypes: [],
      lastUserId: null,
      lastSessionName: null,
      permissions: pending.permissions,
      unattended: null,
      lastUnattendedCommandUuid: null,
      initTools: [],
      backgroundTaskType: null,
      queuedInputs: [],
      lifecycle: [],
      controlFrames: [],
      controlResponses: [],
      resultTimes: [],
      sessionStateChanged: 0,
      providerSessionId: null,
      pid: pending.pid,
      configDir: pending.configDir,
      projectPath: pending.projectPath,
      titleMirror: { lastSeen: null, mirrored: null, timer: null, open: false, openedForTurn: false },
      identityReadbackStarted: false,
      reportedIdentity: null,
      launchedTitle: pending.launchedTitle,
      resumed: false,
      sessionCreatedSent: false,
      assistantBudgetSent: false,
      modelContextWindow: pending.modelContextWindow,
      interruptWatchdog: null,
      closed: false,
      loopError: null,
    });

    // The hook could have fired while the record was being opened — the process
    // is already reading stdin by then. Adoption is what makes those firings
    // reconcilable, so they are replayed here in the order they arrived rather
    // than left in the buffer forever.
    const state = this.hosts.get(host.hostId);
    pending.stopHook.state = state ?? null;
    // The permission scope is the third thing this adoption is for: the entries
    // installed before the spawn have been able to refuse into their own log
    // since the CLI first spoke, and from here they can see the rounds and the
    // writer that decide whether there is anybody to ask.
    pending.permissions.state = state ?? null;
    if (state) {
      for (const input of pending.stopHook.buffered.splice(0)) {
        this.reconcileHeldWork(state, input);
      }
    }

    return host;
  }

  /** Records which session this host serves. One binding per resident host. */
  async bind(host: ProcessHost, binding: SessionBinding): Promise<void> {
    if (host.mode !== 'resident') {
      return this.perRun.bind(host, binding);
    }

    const state = this.hosts.get(host.hostId);
    if (state) {
      state.appSessionId = binding.appSessionId;
    }
  }

  /**
   * Delivers one turn with no client-facing writer.
   *
   * A resident turn's frames belong to the run that dispatched it, and a run's
   * writer arrives through this class's own `run` entry — `HostTurnInput` is the
   * command and its options and nothing else. So a call that reaches a resident
   * host here has no writer to send frames to, and writing the turn anyway would
   * run it blind: the CLI would take the turn and no client would ever see it.
   * Refusing and naming the entry that can serve it is the honest answer; for a
   * per-run host the sibling driver's rule applies instead.
   */
  async submit(host: ProcessHost, appSessionId: string, turn: HostTurnInput): Promise<void> {
    if (host.mode !== 'resident') {
      return this.perRun.submit(host, appSessionId, turn);
    }

    throw new Error(
      `A resident turn needs the writer and runtime context its frames belong to; dispatch it through this driver's run entry instead of submit.`,
    );
  }

  /**
   * Asks the CLI to stop the turn in flight, leaving the process up.
   *
   * This is the whole of what abort means in resident mode: the SDK's own
   * interrupt, which does not end the process. Nothing else is done here — the
   * ledger is not changed, no terminal is synthesized, and no lease is taken
   * away, because the CLI is the only thing that knows whether the interrupted
   * command actually stopped.
   *
   * C-5 is the measured reason: an interrupt stops the command that is running
   * and nothing else, and what follows is stated by the CLI — the in-flight
   * command is `cancelled`, the turn ends with an `is_error` `RESULT`, and a
   * queued command carries on in a new turn. Writing any of that here would be
   * this side inventing an ending, and it is what left a stale round and an open
   * turn behind when the CLI had already moved on.
   *
   * The two marks it does leave are the run's own (its terminal frame has to say
   * `aborted`) and the turn's request flag (the `RESULT` that follows reads
   * `aborted` from `is_error ∧ interruptRequested`, §5.2). The request goes out
   * before its answer can be read, so the flag is set first.
   *
   * What it adds to the request is a deadline rather than a state: the `RESULT`
   * is the CLI's to send, and one that never arrives would leave this round
   * indistinguishable from a turn still being worked on. The `T_int` watchdog
   * states that case in the reconciler's own vocabulary rather than acting on it
   * — see {@link reportInterruptNoResult}.
   */
  async interrupt(host: ProcessHost, appSessionId: string): Promise<boolean> {
    if (host.mode !== 'resident') {
      return this.perRun.interrupt(host, appSessionId);
    }

    const state = this.hosts.get(host.hostId);
    const round = state?.rounds[0];
    if (!state || !round || round.appSessionId !== appSessionId) {
      return false;
    }

    round.interrupted = true;
    if (state.turnLedger.turn) {
      state.turnLedger.turn.interruptRequested = true;
    }
    await stopResidentTurn(state.process.query);
    this.armInterruptWatchdog(state);
    return true;
  }

  /**
   * Arms the `T_int` watchdog for an interrupt request just placed.
   *
   * Re-arming replaces any pending one: a process runs one turn at a time, so a
   * second request is the same wait restarted rather than a second wait. The
   * timer is unref'd for the reason the exit backstop is — a host waiting out a
   * deadline must not be what keeps the process alive.
   */
  private armInterruptWatchdog(state: ResidentHostState): void {
    this.stopInterruptWatchdog(state);
    const turnId = state.turnLedger.turn?.id ?? null;
    const timer = setTimeout(() => {
      state.interruptWatchdog = null;
      this.reportInterruptNoResult(state, turnId);
    }, this.interruptResultTimeoutMs);
    timer.unref?.();
    state.interruptWatchdog = { timer, turnId };
  }

  /**
   * Cancels the pending `T_int` watchdog, if one is armed.
   *
   * Called at the two moments the wait stops being a wait: the `RESULT` that
   * answers the request, and every path that ends the host — the same moments
   * {@link stopTitleMirror} is called at, for the same reason.
   */
  private stopInterruptWatchdog(state: ResidentHostState): void {
    if (state.interruptWatchdog) {
      clearTimeout(state.interruptWatchdog.timer);
      state.interruptWatchdog = null;
    }
  }

  /**
   * Records an interrupt the CLI never answered (§6.3 by way of §10).
   *
   * Both halves are the reconciler's own vocabulary: the anomaly goes on the
   * ledger, so a reader after the fact finds it beside the state it is about,
   * and the `[reconcile]` line is §10.2's shape at this stage's `mode=log`
   * (§10.1) — the mode that observes and changes nothing.
   *
   * Nothing is closed here, and that is the point: synthesizing the interrupted
   * turn's ending is exactly the invention §6.3 takes away from the interrupt
   * path, and the run it would end is still the process's to finish. What the
   * line buys is that the residue is *stated* rather than silently left.
   */
  private reportInterruptNoResult(state: ResidentHostState, turnId: string | null): void {
    const detail = turnId
      ? `turn ${turnId} got no RESULT within ${this.interruptResultTimeoutMs}ms of the interrupt request`
      : `no RESULT within ${this.interruptResultTimeoutMs}ms of the interrupt request`;
    state.turnLedger.anomalies.push({ code: 'interrupt-no-result', detail });
    console.log(
      `[reconcile] session=${state.appSessionId} mode=${CLAUDE_RESIDENT_RECONCILE_MODE} ` +
        `anomaly=interrupt-no-result detail=${detail}`,
    );
  }

  /**
   * Stops one named background task the resident process is running.
   *
   * This is the SDK's own `Query.stopTask`, not an interrupt: the turn in flight
   * keeps running, the process keeps running, and only the named task is asked to
   * end. The confirmation is not here — the SDK answers a stop of an id it does
   * not hold silently, so "the task really stopped" is a fact the task table
   * learns from the `task_notification(stopped)` frame, never from this call's
   * return.
   *
   * Returns `true` when the live process was really asked, and `false` when this
   * session has no live resident process or its query exposes no stop verb. A
   * `false` is "cannot place the request", never "the task stopped".
   */
  async stopTask(appSessionId: string, taskId: string): Promise<boolean> {
    const state = this.liveStateFor(appSessionId);
    const stop = state?.process.query.stopTask;
    if (!state || typeof stop !== 'function') {
      return false;
    }
    await stop.call(state.process.query, taskId);
    return true;
  }

  /**
   * Promotes one named *foreground* tool the resident process is running to a
   * background task.
   *
   * This is the SDK's own `Query.backgroundTasks`, not an interrupt and not a
   * stop: the turn in flight keeps running, the process keeps running, and the
   * named foreground tool is detached so the turn may continue past it. The verb
   * is called with the `toolUseId` always supplied — the no-argument form the SDK
   * also accepts (background *everything*) is deliberately never reached, so a
   * caller cannot background tools it did not name.
   *
   * The SDK's boolean is returned as-is: `true` when the live process agreed the
   * id was a foreground tool it has now backgrounded, `false` when this session
   * has no live resident process, its query exposes no `backgroundTasks` verb, or
   * the process held no matching foreground tool. A `false` is "there was no
   * matching foreground tool to place on", never a claim one was backgrounded.
   * Whether the task subsequently appears in the task table is the reducer's
   * business — it is driven by the `task_started` +
   * `task_updated{is_backgrounded:true}` frames the CLI emits, never by this
   * call's return.
   */
  async background(appSessionId: string, toolUseId: string): Promise<boolean> {
    const state = this.liveStateFor(appSessionId);
    const background = state?.process.query.backgroundTasks;
    if (!state || typeof background !== 'function') {
      return false;
    }
    return (await background.call(state.process.query, toolUseId)) === true;
  }

  /**
   * Applies a live setting change where the SDK has a verb for it, and defers
   * everything else to the next turn.
   *
   * A resident process is the mode's reason to have a live surface at all, so the
   * two settings the SDK can change under a running turn are applied here:
   * `setModel` and `setPermissionMode`. Effort is a launch argument — it is
   * folded into the SDK options' env and effort flags when the process starts —
   * so a patch that names one is answered `next-turn` rather than claimed as
   * live. A verb the SDK build does not have is answered the same way, and the
   * answer is never `live` on faith: only a call that returned without throwing
   * is reported as applied.
   */
  async reconfigure(
    host: ProcessHost,
    appSessionId: string,
    patch: HostReconfigurePatch,
  ): Promise<'live' | 'next-turn'> {
    if (host.mode !== 'resident') {
      return this.perRun.reconfigure();
    }

    const state = this.hosts.get(host.hostId);
    if (!state || state.closed) {
      return 'next-turn';
    }

    let applied = false;
    if (typeof patch.model === 'string' && typeof state.process.query.setModel === 'function') {
      try {
        await state.process.query.setModel(patch.model);
        applied = true;
      } catch {
        // The verb is there but the process refused it; the next turn's options
        // carry the model again, so nothing is lost by deferring.
      }
    }
    if (
      typeof patch.permissionMode === 'string' &&
      typeof state.process.query.setPermissionMode === 'function'
    ) {
      try {
        await state.process.query.setPermissionMode(patch.permissionMode);
        // Only after the call returned: the host's own account of the mode is
        // what a later reading reports, and writing it before the process took
        // it would publish a mode the CLI may not be in. Nothing else moves it
        // — a switch is the one way the launch mode changes, and it does not
        // touch the process (see `RESIDENT_PERMISSION_MODE`).
        state.permissions.mode = patch.permissionMode;
        applied = true;
      } catch {
        // As above.
      }
    }

    return applied ? 'live' : 'next-turn';
  }

  /**
   * Detaches one session from the host.
   *
   * A resident host serves one conversation, so the detach is followed by the
   * manager's own close (a host with no bindings left is closed under the same
   * reason) and ending the process is that close's job, not this verb's. What
   * this does is settle whatever run was in flight: the session that asked for
   * it is gone, so nobody is waiting for its answer any more.
   */
  async unbind(host: ProcessHost, appSessionId: string, reason: HostCloseReason): Promise<void> {
    if (host.mode !== 'resident') {
      return this.perRun.unbind(host, appSessionId);
    }

    const state = this.hosts.get(host.hostId);
    if (!state) {
      return;
    }

    this.endLedger(state, 'process-exit', null);
  }

  /**
   * Ends the host: stdin EOF first, the query's own close only as a backstop.
   *
   * The graceful path is the input queue's `end`, which the SDK turns into stdin
   * EOF and the CLI answers by winding down. The `close` that follows is not a
   * second attempt at the same thing — it is the SDK's transport teardown, the
   * one that escalates to SIGTERM and SIGKILL — and it is deliberately late
   * enough ({@link CLAUDE_RESIDENT_EXIT_GRACE_MS}) that an exit observed inside
   * an ordinary assertion window is the EOF's doing rather than this. It is
   * unref'd so a host held at shutdown cannot keep the server's event loop alive.
   */
  async closeHost(host: ProcessHost, reason: HostCloseReason): Promise<void> {
    if (host.mode !== 'resident') {
      return this.perRun.closeHost(host, reason);
    }

    const state = this.hosts.get(host.hostId);
    this.hosts.delete(host.hostId);
    if (!state || state.closed) {
      return;
    }
    state.closed = true;
    this.stopTitleMirror(state);

    // Every run still waiting has lost the process that was going to answer it;
    // the close is that answer, and an unattended turn still open loses the same
    // thing — its `result` — so its run is ended here rather than left open.
    this.endLedger(state, 'process-exit', null);
    this.abandonUnattendedTurn(state, 1);

    state.queue.end();
    const backstop = setTimeout(() => {
      try {
        state.process.query.close?.();
      } catch {
        // The process is on its way out either way.
      }
    }, CLAUDE_RESIDENT_EXIT_GRACE_MS);
    backstop.unref?.();
  }

  /**
   * Reports what a live resident host knows about pushes and unattended turns.
   *
   * A copy, so the caller cannot reach into host state, and `null` for a session
   * this driver is not hosting — both properties a reading has to have to be
   * worth printing. The uuids are the point: the pushed set is the host's own
   * mark and the opener uuid is the CLI's, and a turn whose opener is absent from
   * the set is one nobody pushed (see {@link ResidentHostState.pushedUuids}).
   * `initTools` and `backgroundTaskType` ride along because they are facts of the
   * same process that nothing outside it can read.
   */
  unattendedReading(appSessionId: string): ClaudeUnattendedReading | null {
    const state = this.liveStateFor(appSessionId);
    if (!state) {
      return null;
    }

    const pushedUuids = [...state.pushedUuids];
    return {
      pushedUuids,
      lastPushedUuid: pushedUuids.at(-1) ?? null,
      unattendedCommandUuid: state.unattended?.commandUuid ?? state.lastUnattendedCommandUuid,
      initTools: [...state.initTools],
      backgroundTaskType: state.backgroundTaskType,
    };
  }

  /**
   * Reports what a live resident host knows about its busy-time writes.
   *
   * A copy, and `null` for a session this driver is not hosting — the same two
   * properties {@link unattendedReading} has, for the same reason. What is in
   * it is everything the write side of this driver produces that nothing else
   * can read: when each frame was handed over and under which tier, the CLI's
   * own queue account of it, the control frames this host wrote, and the
   * responses that came back to them.
   */
  busyInputReading(appSessionId: string): ClaudeBusyInputReading | null {
    const state = this.liveStateFor(appSessionId);
    if (!state) {
      return null;
    }

    return {
      queuedInputs: state.queuedInputs.map((input) => ({ ...input, frame: { ...input.frame } })),
      lifecycle: [...state.lifecycle],
      controlFrames: state.controlFrames.map((entry) => ({ ...entry, frame: { ...entry.frame } })),
      controlResponses: [...state.controlResponses],
      resultTimes: [...state.resultTimes],
      sessionStateChanged: state.sessionStateChanged,
      roundsOpen: state.rounds.length,
      hostPid: state.process.pid,
    };
  }

  /**
   * Reports the delivery/turn ledger for a session this driver is hosting, or
   * `null` for one it is not.
   *
   * A copy, like every other reading here, and the whole of what a criterion
   * needs to judge the host's own account of its sends: which deliveries it
   * made and where each has got to, which commands are foreign, the turn that
   * is open (and its kind), every turn that has closed with the ending it read,
   * the commands waiting to be bound, and every anomaly the ledger recorded.
   *
   * Consumed by the AC-378 criterion
   * (`tests/claude-resident-ledger-invariants.test.ts`), which drives a real
   * host through seeded frame sequences and asserts I1–I6 from these readings
   * rather than from the driver's private fields. Nothing in production consumes
   * it.
   *
   * Unlike every other reading here it stays readable after the host has ended —
   * see {@link ledgerStateFor} — because "nothing was left open" is a question
   * about a dead host as much as a live one, and the exit leg of that criterion
   * asks it.
   */
  ledgerReading(appSessionId: string): ClaudeResidentLedgerReading | null {
    const state = this.ledgerStateFor(appSessionId);
    if (!state) {
      return null;
    }

    const turn = state.turnLedger.turn;
    return {
      deliveries: state.turnLedger.deliveries.map((delivery) => ({
        deliveryId: delivery.commandUuid,
        state: delivery.state,
        reason: delivery.reason,
        turnId: delivery.turnId,
        runOpen: delivery.runOpen,
        owed: delivery.owed,
        enqueuedAt: delivery.enqueuedAt,
        startedAt: delivery.startedAt,
        endedAt: delivery.endedAt,
        priority: delivery.priority,
      })),
      foreign: [...state.turnLedger.foreign],
      turn: turn
        ? {
            id: turn.id,
            kind: turn.kind,
            open: turn.open,
            ownerDeliveryId: turn.ownerDeliveryId,
            interruptRequested: turn.interruptRequested,
          }
        : null,
      closedTurns: state.turnLedger.closedTurns.map((closed) => ({ ...closed })),
      pendingStart: state.turnLedger.pendingStart.map((delivery) => delivery.commandUuid),
      anomalies: state.turnLedger.anomalies.map((anomaly) => ({ ...anomaly })),
      openRuns: state.turnLedger.deliveries.filter((delivery) => delivery.runOpen).length,
    };
  }

  /**
   * The uuid of the newest message this host queued while busy, or null.
   *
   * The id `cancelQueuedInput` withdraws a message by, read off the same
   * `state.queuedInputs` record {@link busyInputReading} reports: an entry's
   * uuid is the CLI's own `command_uuid` for that message (the CLI's
   * `command_lifecycle` reports it back), so it is the value a control caller
   * must hold to withdraw the message. "Newest and not started" is the message
   * a withdrawal can still reach — a `started` entry has been dequeued into a
   * turn of its own and can no longer be taken back, and an older unstarted
   * entry is unreachable behind the newest for the same reason.
   *
   * Synchronous because the queue is this driver's own memory; the message is
   * written before the dispatch that queued it resolves, so there is no I/O to
   * await. `null` for a session this driver is not hosting, a closed host, or a
   * queue with nothing left to withdraw — the conservative direction, so a
   * caller that reads it never holds an id no withdrawal can match. Consumed by
   * the runtime gateway's `queuedInputUuid` (`provider-runtime.service.ts`),
   * which the websocket control service's busy-send branch reads
   * (`chat-control.service.ts`).
   */
  queuedInputUuid(appSessionId: string): string | null {
    const state = this.liveStateFor(appSessionId);
    if (!state || state.closed) {
      return null;
    }

    for (let index = state.queuedInputs.length - 1; index >= 0; index -= 1) {
      const input = state.queuedInputs[index];
      if (input.startedAt === null) {
        return input.uuid;
      }
    }
    return null;
  }

  /**
   * How much of the person's text the CLI's own queue is still holding, or null.
   *
   * THE READING A RELAY CANNOT PRODUCE ITSELF. The CLI holds its own command
   * queue and drains it at a turn boundary — measured 2026-10-12, seven entries
   * dequeued in one millisecond into a single turn — so a relay that counts its
   * own accepted deliveries can only ever grow, and reported `queued=8→9→10`
   * against a real depth that peaked at seven and then fell to two. The truth
   * lives here, and this is it handed out.
   *
   * RECONCILED FROM BOTH READINGS, not one. `queuedInputs` carries the bytes —
   * the CLI's `command_lifecycle` says nothing about how long a message is — and
   * `lifecycle` carries the dequeue: a message is still WAITING only when this
   * host pushed it (`queuedInputs`), the CLI has not dequeued it (`startedAt`
   * still null), and no `started`/`completed`/`cancelled` was read for its uuid.
   * Taking only `queuedInputs` would count a withdrawn message forever; taking
   * only `lifecycle` would lose the byte reading. The two together are the
   * acknowledged double-entry.
   *
   * `null` for a session this driver is not hosting — the same conservative
   * direction {@link queuedInputUuid} takes, so a caller reads "cannot say"
   * rather than a fabricated empty queue. Synchronous: the queue is this
   * driver's own memory. Consumed by the runtime gateway's
   * `pendingQueuedInputs` (`provider-runtime.service.ts`), which the voice relay
   * samples to reconcile its reported depth (`voice-realtime-ws-proxy.service.ts`).
   */
  pendingQueuedInputs(appSessionId: string): HostPendingQueuedInputs | null {
    const state = this.liveStateFor(appSessionId);
    if (!state) {
      return null;
    }

    // The CLI's own account of what has left the queue, by uuid: any of these
    // states means the message is no longer waiting, whatever `startedAt` says.
    const departed = new Set<string>();
    for (const event of state.lifecycle) {
      if (event.state !== 'queued') {
        departed.add(event.commandUuid);
      }
    }

    let items = 0;
    let bytes = 0;
    for (const input of state.queuedInputs) {
      if (input.startedAt !== null || departed.has(input.uuid)) {
        continue;
      }
      items += 1;
      bytes += claudeQueuedFrameTextBytes(input.frame);
    }
    return { items, bytes };
  }

  /**
   * The `commandUuid`s the CLI has already dequeued into a turn, or null.
   *
   * THE OTHER HALF OF THE SAME `command_lifecycle` RECORD. {@link pendingQueuedInputs}
   * reads it for what is STILL WAITING (any state but `queued` means the message
   * left the queue); this reads it for what has LEFT — the `started` events, in
   * arrival order — which is the reading an interrupt fence needs and cannot
   * derive from anything else. A proxy knows the messages it sent; only the CLI
   * knows which of them it took up, and the turn boundary that does the taking-up
   * is precisely the moment nothing tells the proxy about. Without this reading a
   * stop for a sentence the current run already carries cannot be told from a stop
   * for a run that has not reached it yet, and the model's second thought aborts
   * the very turn that is answering it (SPEC §0.3 D-7's repeated-interrupt churn).
   *
   * DEDUPLICATED, because the caller's use is a set membership test (`coveredSeqs`
   * in `voice-realtime-ws-proxy.service.ts`): a uuid the CLI reported `started`
   * twice is one dequeued command, not two. The terminal states are deliberately
   * NOT filtered out — a command that started and then completed was carried by
   * that turn, which is exactly what "the run covers this sentence" means.
   *
   * `null` for a session this driver is not hosting — the same conservative
   * direction {@link pendingQueuedInputs} takes, so a caller reads "cannot say"
   * rather than a fabricated empty list (an empty list is a REAL reading: this
   * host holds a process that has dequeued nothing). Synchronous: the lifecycle
   * list is this driver's own memory. Consumed by the runtime gateway's
   * `startedQueuedCommands` (`provider-runtime.service.ts`), which the voice
   * relay's interrupt fence samples through its `hostCommandLifecycle` seam
   * (`voice-realtime-ws-proxy.service.ts`, wired in `server/index.ts`).
   */
  startedQueuedCommands(appSessionId: string): readonly string[] | null {
    const state = this.liveStateFor(appSessionId);
    if (!state) {
      return null;
    }

    const started: string[] = [];
    const seen = new Set<string>();
    for (const event of state.lifecycle) {
      if (event.state !== 'started' || seen.has(event.commandUuid)) {
        continue;
      }
      seen.add(event.commandUuid);
      started.push(event.commandUuid);
    }
    return started;
  }

  /**
   * Whether a turn is IN FLIGHT for a session this driver hosts, or `null` when it hosts none.
   *
   * THE AUTHORITY THE TURN-PHASE READING LACKS. `state.rounds` is this driver's own FIFO of the turns
   * the CLI has armed — the front one is the turn in flight, and an interrupted round stays until its
   * `result` — so `rounds.length > 0` is the resident process's own account of "busy", read from the
   * process that knows it. The activity store's turn phase is a REDUCTION of stream traffic
   * (`claude-turn-phase.service.ts`): it has no "turn began" signal, so it only leaves `idle` on the
   * first `thinking_tokens`/text/`tool_use` and returns to `phaseBeforeTool` after a `tool_result` —
   * which is why the 2026-10-14 evening reading saw the relay release its ONE held message mid-turn
   * four times, dropping the words into the CLI's own queue. The composition root's `hostRunActivity`
   * (`server/index.ts`) prefers this reading and keeps the phase reading only for the sessions this
   * driver does not host.
   *
   * `null` for a session this driver is not hosting — the same conservative direction
   * {@link pendingQueuedInputs} takes, so a caller reads "cannot say" and keeps the older reading
   * rather than a fabricated `false`. Synchronous: the rounds list is this driver's own memory.
   * Consumed by the runtime gateway's `runInFlight` (`provider-runtime.service.ts`), which the
   * composition root samples inside `hostRunActivity` (`server/index.ts`); read into one place by
   * {@link composeHostRunActivityReading} (`voice-realtime-ws-proxy.service.ts`).
   */
  runInFlight(appSessionId: string): boolean | null {
    const state = this.liveStateFor(appSessionId);
    if (!state) {
      return null;
    }
    return state.rounds.length > 0;
  }

  /**
   * Reports what a live resident host is holding, and how it came to hold it.
   *
   * The manager's snapshot already answers "what reasons does this binding
   * carry"; what it cannot carry is this driver's own account of *how* each one
   * was arrived at — whether the CLI named it or a tool call implied it, and
   * which stream subtypes passed through unread. Read by the criterion in
   * `tests/claude-resident-idle.test.ts`, which has to tell those apart;
   * nothing in production consumes it.
   */
  lifecycleReading(appSessionId: string): ClaudeResidentLifecycleReading | null {
    const state = this.liveStateFor(appSessionId);
    if (!state) {
      return null;
    }

    return {
      hostId: state.hostId,
      crons: state.heldCrons.map((lease) => ({ ...lease })),
      backgroundTasks: state.heldBackgroundTasks.map((lease) => ({ ...lease })),
      unhandledSystemSubtypes: [...state.unhandledSystemSubtypes],
      cronsAuthoritative: state.cronsAuthoritative,
      tasksAuthoritative: state.tasksAuthoritative,
    };
  }

  /**
   * Reports the mode a live resident host is under, and what it decided for whom.
   *
   * A copy, and `null` for a session this driver is not hosting — the same two
   * properties every other reading here has, for the same reason. Nothing on the
   * wire carries either half: the SDK consumes a callback's return value, the
   * frames carry only the *request*, and a refusal produces no frame at all — so
   * "was this refused, and with what words?" is only answerable from the host
   * that answered. `lastConnectedCount` rides along so the browser half of the
   * attendance test is a reading rather than an inference from the other half.
   */
  permissionReading(appSessionId: string): ClaudePermissionReading | null {
    const state = this.liveStateFor(appSessionId);
    if (!state) {
      return null;
    }

    return {
      permissionMode: state.permissions.mode,
      decisions: state.permissions.decisions.map((decision) => ({ ...decision })),
      lastConnectedCount: state.permissions.lastConnectedCount,
    };
  }

  /**
   * The Remote Control refusal this driver made for a session, or null.
   *
   * Read from a map keyed by session rather than from a host, because a refusal
   * is precisely the case where no host exists: the gate refuses *before*
   * `openHost`, so there is no record in `snapshot()` to carry the code or the
   * copy. A caller that caught the thrown error does not need this; the caller
   * that drove the run through the application dispatch — where the rejection is
   * logged and the turn ends with a terminal frame — does, because otherwise the
   * reason is unreadable from outside the process.
   *
   * Last-write-wins per session, like the permission log: a session refused,
   * then allowed after the user turned Remote Control off, reads `null` — which
   * is the truth, and the pair of readings is why the map is cleared on a launch
   * that gets past the gate.
   */
  remoteControlRefusal(appSessionId: string): ClaudeRemoteControlRefusal | null {
    return this.refusals.get(appSessionId) ?? null;
  }

  /**
   * Withdraws a message this host wrote, if the CLI still has it queued.
   *
   * The frame is written by hand because the SDK's `Query` has no verb for
   * `cancel_async_message` (see `ClaudeResidentProcess.writeRaw`), and the
   * verdict is read from the queue's own account rather than from a response:
   * measured at all three timings — still queued, already dequeued, uuid that
   * never existed — the CLI answers this frame with **no** `control_response`
   * at all (`§9.2`). The one thing that changes when the withdrawal worked is
   * a `state=cancelled` event for that uuid, so that is what is waited for.
   *
   * Returns `unknown` when there is no live process to write to or no raw
   * write seam on it: a driver that cannot write has not withdrawn anything,
   * and reporting `already-started` there would be claiming knowledge of a
   * queue it never reached.
   */
  async cancelQueuedInput(
    appSessionId: string,
    messageUuid: string,
  ): Promise<HostQueuedInputCancelResult> {
    const state = this.liveStateFor(appSessionId);
    if (!state || state.closed || !messageUuid) {
      return 'unknown';
    }
    const writeRaw = state.process.writeRaw;
    if (typeof writeRaw !== 'function') {
      return 'unknown';
    }

    const requestId = randomUUID();
    const frame: AnyRecord = {
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'cancel_async_message', message_uuid: messageUuid },
    };
    // Recorded before the write so the reading holds the bytes even if the
    // process dies mid-write.
    state.controlFrames.push({ at: Date.now(), requestId, frame });
    // The ledger's record of the request, written before the frame goes out: the
    // CLI's `cancelled` says a command was cancelled but never says who asked,
    // so the reason a terminal carries is this side's own mark, and a mark
    // written after the frame was on the wire could miss the answer to it.
    const requested = state.turnLedger.byUuid.get(messageUuid);
    if (requested) {
      requested.withdrawalRequested = true;
    }
    writeRaw.call(state.process, frame);

    const withdrawn = await this.waitForLifecycle(state, messageUuid, 'cancelled');
    if (withdrawn) {
      this.endWithdrawnRun(state, messageUuid);
      return 'withdrawn';
    }
    // No `cancelled`, so the message was not withdrawn. It is only
    // `already-started` if the CLI actually dequeued it; a uuid this process
    // never queued is `unknown`, which is a different answer and stays one.
    const dequeued = state.lifecycle.some(
      (event) => event.commandUuid === messageUuid && event.state === 'started',
    );
    return dequeued ? 'already-started' : 'unknown';
  }

  /**
   * Ends the run a withdrawn message was armed as.
   *
   * A run exists per send the dispatcher asked for, and the dispatcher awaits
   * it: without this, a withdrawn message's run would stay open forever, because
   * the CLI never starts a message it cancelled and so never emits the
   * `system/init`/`result` pair the run would close on. Three things go wrong
   * while it sits open, and all three are the same bug seen from three sides:
   * the dispatcher's promise never settles, the next turn's `RESULT` closes the
   * wrong run (settling the withdrawal on a turn it never ran), and the open-run
   * projection is never empty — which is exactly the reading an unattended
   * turn's opener is refused by, so the process's own turn would be misread as a
   * queued one.
   *
   * The delivery's own terminal is the CLI's (already read: this is called only
   * after a `cancelled` was seen), so what happens here is the *run* half — the
   * terminal frame through the run's **own** writer, and the settlement. That
   * run was opened for this message and the message will now never run, so the
   * run is over and has to say so. `aborted` rather than a clean exit — the turn
   * did not run and was stopped by a person, which is what that flag means
   * everywhere else in this file. No round-end report is made: the caller of the
   * withdrawal is the person who asked for it and gets a verdict frame back, and
   * a "your run stopped" notification about their own withdrawal is noise about
   * a turn that never started.
   */
  private endWithdrawnRun(state: ResidentHostState, messageUuid: string): void {
    const delivery = state.turnLedger.byUuid.get(messageUuid) ?? null;
    if (!delivery || !delivery.runOpen) {
      // Either a run that was never a queue entry — a cold send's message is
      // the process's first work, not something the CLI can be asked to cancel
      // — or a run that already closed. Nothing to end: the CLI answered
      // `cancelled` for a uuid this host has no run waiting on.
      return;
    }

    delivery.round.writer.send(
      createCompleteMessage({
        provider: this.provider,
        sessionId: state.providerSessionId || delivery.round.appSessionId,
        exitCode: 0,
        aborted: true,
      }),
    );
    delivery.runOpen = false;
    // A withdrawn command's terminal was just read, so nothing is owed for it.
    delivery.owed = false;
    const index = state.rounds.indexOf(delivery.round);
    if (index >= 0) {
      state.rounds.splice(index, 1);
    }
    // Settles the dispatcher's await for this turn. `settled` also keeps a
    // `RESULT` that somehow arrives anyway from settling it a second time.
    delivery.round.settle();
    this.syncTurnLeases(state);
  }

  /**
   * Converges the reported `cron` reasons onto one list.
   *
   * Remove-then-re-add rather than a diff, because the manager's removal verb is
   * by *kind* — a driver reports "the cron reason", not which cron — so a change
   * of any size is expressed the same way. {@link sameLeases} is what keeps an
   * unchanged list from being reported at all, which matters more than it looks:
   * the `Stop` hook fires at the end of every turn, and a rule that reported its
   * list unconditionally would move `lastActivityAt` and push the idle deadline
   * out once per turn, so a session the user keeps talking to would never go
   * idle and a session the CLI holds a cron for would never be observably held.
   */
  private settleCrons(state: ResidentHostState, desired: CronLease[]): void {
    if (sameLeases(state.heldCrons, desired)) {
      return;
    }
    state.sink.leaseRemoved(state.appSessionId, 'cron');
    state.heldCrons = desired;
    for (const lease of desired) {
      state.sink.leaseAdded(state.appSessionId, lease);
    }
  }

  /** The same convergence for the background-work reasons, which carry no expiry. */
  private settleBackgroundTasks(state: ResidentHostState, desired: BackgroundTaskLease[]): void {
    if (sameLeases(state.heldBackgroundTasks, desired)) {
      return;
    }
    state.sink.leaseRemoved(state.appSessionId, 'background-task');
    state.heldBackgroundTasks = desired;
    for (const lease of desired) {
      state.sink.leaseAdded(state.appSessionId, lease);
    }
  }

  /**
   * Reconciles one `Stop` hook firing into the binding's held-work reasons.
   *
   * A firing is authoritative only for the lists it actually carries: the hook
   * input has `session_crons` and `background_tasks` as separate keys, and one
   * absent key is the CLI saying nothing about that kind rather than saying it
   * holds none. That distinction is the whole reason the two `…Authoritative`
   * flags are separate — a build that reported `[]` for a list it never read
   * would drop a live cron's lease and let the host go idle under it.
   */
  private reconcileHeldWork(state: ResidentHostState, input: AnyRecord): void {
    if (state.closed) {
      return;
    }

    const crons = input?.session_crons;
    if (Array.isArray(crons)) {
      state.cronsAuthoritative = true;
      this.settleCrons(state, cronsFromStopList(crons, this.now(), state.heldCrons));
    }

    const tasks = input?.background_tasks;
    if (Array.isArray(tasks)) {
      state.tasksAuthoritative = true;
      this.settleBackgroundTasks(state, tasksFromStopList(tasks));
    }

    // The same firing feeds the activity dock's two read models (AC-194's wiring
    // leg), under the app session id the forwarder keys them by. Each list is
    // authoritative only when present, which the callee re-checks (`undefined`
    // is a no-op per kind) — the lease ledger and the read models must never
    // disagree about a list the CLI did not name.
    reconcileSessionHeldWork(state.appSessionId, {
      backgroundTasks: tasks,
      sessionCrons: crons,
    });
  }

  /**
   * Reads the two `system` frames that report background work, and counts the
   * subtypes it does not read.
   *
   * The stream's own account runs alongside the hook's because the two answer
   * different questions: the hook says what the process is still holding at the
   * end of a turn, while these frames say what it is doing in the middle of one
   * — a task that starts and finishes inside a single turn is never on any hook
   * list, and a host that only read the hook would look idle for the whole of
   * it. Neither list is gated on the other's authority: they converge on the
   * same ids, and the last one to speak at a turn's end is the hook's.
   */
  private observeHeldWorkEvent(state: ResidentHostState, message: AnyRecord): void {
    switch (message.subtype) {
      case 'task_started': {
        const id = taskIdOf(message);
        if (id) {
          this.settleBackgroundTasks(state, [...state.heldBackgroundTasks, { kind: 'background-task', id }]);
        }
        return;
      }
      case 'task_notification': {
        const id = taskIdOf(message);
        if (id) {
          this.settleBackgroundTasks(
            state,
            state.heldBackgroundTasks.filter((lease) => lease.id !== id),
          );
        }
        return;
      }
      case 'background_tasks_changed': {
        if (Array.isArray(message.tasks)) {
          this.settleBackgroundTasks(state, tasksFromChangedFrame(message.tasks));
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * The fallback for a CLI that never tells the host what it holds.
   *
   * `CronCreate` / `CronDelete` are the only stream-side evidence a cron exists,
   * and they are strictly worse evidence than the hook's list: the tool call says
   * a job was made, not that it is still there, and nothing in the stream names
   * the job's own id — the receipt's `7d58f90e` arrives on a `tool_result`, while
   * the block that made it carries only the SDK's `tool_use_id`. So the inferred
   * lease is keyed by that block id and flagged `inferred`, and it is only ever
   * consulted while no `session_crons` list has been seen: once the CLI has named
   * its jobs, a guess has nothing left to add.
   *
   * A `CronDelete` retracts the inferred reasons wholesale. It cannot be matched
   * to one of them — its `input.id` is the CLI's id for the job, which is exactly
   * the value an inferred lease never had — and while inference is live every
   * cron lease is inferred, so "the user cancelled a cron" and "the reason went
   * away" are the same event from this side.
   */
  private inferHeldWork(state: ResidentHostState, message: AnyRecord): void {
    if (state.closed || state.cronsAuthoritative) {
      return;
    }

    const content = message?.message?.content;
    if (!Array.isArray(content)) {
      return;
    }

    for (const block of content) {
      if (block?.type !== 'tool_use') {
        continue;
      }
      if (block.name === 'CronCreate') {
        const id = typeof block.id === 'string' ? block.id : '';
        if (!id) {
          continue;
        }
        const input = block.input as AnyRecord | null | undefined;
        this.settleCrons(state, [
          ...state.heldCrons,
          {
            kind: 'cron',
            id,
            recurring: input?.recurring !== false,
            expiresAt: this.now() + CRON_MAX_AGE_MS,
            inferred: true,
          },
        ]);
      } else if (block.name === 'CronDelete') {
        this.settleCrons(state, []);
      }
    }
  }

  /**
   * Starts one resident process and asks the manager to track it.
   *
   * The order is forced by what the manager accepts: the record's pid is written
   * when the host is opened, so the child has to exist first — which is also why
   * the first turn's messages are in the queue before the process is spawned. The
   * host is then read back from `snapshot()` because `openHost` answers with a
   * copy; `startHost` has already put the live state in `hosts`.
   */
  private async startResidentHost(
    appSessionId: string,
    messages: AnyRecord[],
    turn: HostTurnInput,
    context: ProviderRuntimeContext,
  ): Promise<ResidentHostState> {
    const options = turn.options;

    // The Remote Control gate, first and before anything is built.
    //
    // Before the model lookup and before the queue, the ledger and the process:
    // a refused launch must leave no trace of one, and "no `/v1/messages`, no
    // child, no host" is only a meaningful reading if nothing that could produce
    // any of the three has run yet. The config directory is resolved here rather
    // than taken from `options` for the reason `resolveClaudeConfigDir` states:
    // the child's environment is built from `process.env`, so the file this reads
    // is the one the process would have been launched under.
    const configDir = resolveClaudeConfigDir();
    const settingsPath = this.userSettingsPath ?? join(configDir, CLAUDE_USER_SETTINGS_FILE);
    const detected = readClaudeUserSettings(settingsPath);
    if (detected.remoteControlAtStartup === true) {
      const refusal: ClaudeRemoteControlRefusal = {
        code: 'remote-control-enabled',
        message: remoteControlRefusalMessage(),
        settingsPath,
        at: this.now(),
      };
      this.refusals.set(appSessionId, refusal);
      throw new ClaudeRemoteControlRefusalError(refusal);
    }
    // A launch that got past the gate clears the last refusal: the reading is
    // "what this driver last said about this session", and a user who turned
    // Remote Control off and started again must not keep reading the old no.
    this.refusals.delete(appSessionId);

    // The occupancy gate: a conversation a Claude Code background job is running
    // cannot be resumed (the CLI exits 1 on stderr, which this app drops), so
    // the launch is refused before anything is built or spawned. Asked of the
    // CLI's own registry, the same one `readCliSessionRegistration` reads.
    const occupant = findBackgroundSessionOwner(configDir, context.resolveProviderSessionId(appSessionId));
    if (occupant) {
      throw new ClaudeSessionOccupiedError(occupant);
    }

    const resolvedModel = await context.resolveResumeModel(appSessionId, options.model);
    let effortModels: unknown;
    try {
      effortModels = await context.getProviderModels();
    } catch {
      // The runtime warns and carries on with the predefined effort table; the
      // launch must not fail because the model catalogue could not be read.
      effortModels = undefined;
    }

    const queue = createResidentInputQueue();
    queue.push(...messages);
    // One ledger per process, created before the spawn so the hook installed on
    // it can never fire into nowhere: the first turn can end before this method
    // returns, and its `Stop` reading is the one an unattended turn will need.
    const ledger = createBackgroundWorkLedger();
    // The same reason, one step further: the host state the hook reconciles into
    // does not exist until `openHost` has answered, so firings that beat that are
    // buffered for `startHost` rather than dropped.
    const stopHook: StopHookSink = { state: null, buffered: [] };

    // No name is *invented* here. What is handed over is the session's own
    // Claude Code title, read from the transcript the CLI itself wrote
    // (`resolveClaudeSessionTitle`), so the process registers under
    // `nameSource: "auto"` — the rung the CLI reserves for a title it adopted —
    // and answers to the same phrase the session already shows instead of the
    // directory-plus-two-characters name it derives when given nothing. The app
    // still names nothing: it passes the authority back, never a string of its
    // own, which is why the display name cached on the session row is not an
    // input here.
    //
    // A cold start with no provider session id yet is handed nothing at all, and
    // that is deliberate rather than incidental: the SDK suppresses its own
    // title generation when a title is passed, so a launch that supplied one
    // before the session had one would leave it with nothing to adopt. The
    // read-back below (`readCliSessionRegistration`, `startIdentityReadback`)
    // keeps its job — the process's address is still whatever the CLI registered,
    // and is still read rather than predicted.

    // The permission scope, created here and not in the factory: whether a
    // request is answered from a browser or refused outright is this driver's
    // policy, and the factory's job is only to install what it is handed (see
    // `buildResidentSdkOptions`). It exists before the spawn so a request that
    // arrives in the window before `startHost` adopts cannot fall through to an
    // unanswered promise.
    const permissions: ClaudePermissionScope = {
      state: null,
      mode: RESIDENT_PERMISSION_MODE,
      decisions: [],
      lastConnectedCount: 0,
    };

    // Read before the process is created, because the SDK takes the title as a
    // launch option rather than something it can be told afterwards: a resident
    // process holds one name for its whole life, so this is the only moment it
    // can be handed over.
    const providerSessionId = context.resolveProviderSessionId(appSessionId);
    const sessionTitle = await resolveClaudeSessionTitle(providerSessionId, options.cwd);

    const process = await this.createProcess({
      prompt: queue.stream,
      options: {
        ...options,
        providerSessionId,
        sessionTitle,
        model: resolvedModel || options.model,
        effortModels,
      },
      permissions: this.createPermissionEntries(appSessionId, permissions),
      // The defence-in-depth half of the gate: the settings above said "not on",
      // so the launch goes ahead — stating both flags as well, without ever
      // reading their effect back as a fact (see the Remote Control section).
      remoteControlFlags: { ...CLAUDE_REMOTE_CONTROL_FLAGS },
      seams: {
        onStop: (input) => {
          ledger.record(input);
          const state = stopHook.state;
          if (!state) {
            stopHook.buffered.push(input);
            return;
          }
          this.reconcileHeldWork(state, input);
        },
      },
    });

    // The pid is the key to the CLI's own registry, so it is resolved once and
    // shared: the pending host carries it for the address read-back, and
    // `openHost` records it on the binding.
    const pid = await this.resolvePid(process);

    this.pending = {
      queue,
      process,
      modelContextWindow: resolveModelContextWindowRow('claude', resolvedModel || options.model),
      ledger,
      pid,
      configDir,
      projectPath: typeof options.cwd === 'string' && options.cwd ? options.cwd : null,
      launchedTitle: sessionTitle,
      stopHook,
      permissions,
      remoteControl: {
        requested: { ...CLAUDE_REMOTE_CONTROL_FLAGS },
        detected: {
          remoteControlAtStartup: detected.remoteControlAtStartup,
          isolatePeerMachines: detected.isolatePeerMachines,
        },
        settingsPath,
        launched: process.launchSettings ?? null,
      },
    };

    const host = await this.host.openHost({
      provider: this.provider,
      mode: 'resident',
      appSessionId,
      driver: this,
      pid,
    });

    const state = this.hosts.get(host.hostId);
    if (!state) {
      throw new Error(`Resident host ${host.hostId} was opened but its driver state was not adopted.`);
    }

    state.resumed = Boolean((options.resume as string | undefined) || (options.providerSessionId as string | null));
    this.consume(state);
    return state;
  }

  /**
   * The pid, once the spawn hook has run.
   *
   * The SDK spawns eagerly for a streaming prompt, so the hook has almost always
   * fired by the time `query()` returns; the extra tick is for a build that
   * defers it by a microtask, and a pid that never appears is recorded as the
   * truth (`null`) rather than waited on.
   */
  private async resolvePid(process: ClaudeResidentProcess): Promise<number | null> {
    if (process.pid !== null) {
      return process.pid;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    return process.pid;
  }

  /**
   * Builds one turn's prompt messages through the runtime's own builder, each
   * stamped with the uuid this host pushes it under.
   *
   * The stamp is the host's mark on the turn and is recorded in the host's own
   * pushed set (see `armRound`). It is deliberately *not* claimed to be the
   * CLI's id for the turn: the stream echoes no pushed uuid, so the set answers
   * one question only — "did this host push this turn?" — which is the question
   * an unattended turn's opener has to be measured against.
   */
  private async turnMessages(turn: HostTurnInput, queuedBehindTurn: boolean): Promise<AnyRecord[]> {
    const options = turn.options;
    const messages = await buildPromptMessages(turn.command, options.images, options.files, options.cwd);
    // The caller's own tier for THIS write, when it named a usable one (see
    // `CLAUDE_TURN_PRIORITY_OPTION`). Read only for a busy write, because a tier is a
    // statement about a queue and only a busy write has one to be behind.
    const requested = queuedBehindTurn ? readRequestedPriority(options) : null;
    return messages.map((message) => ({
      ...message,
      uuid: randomUUID(),
      // A frame written while the process is busy is written under the tier that
      // makes it wait for the turn in flight and then run as a turn of its own —
      // unless its caller named one of the CLI's three tiers for it, which is how the
      // Live Voice relay's quiet-window release gets `next` (merged into the turn in
      // flight at its next tool boundary) without changing what any other busy write
      // does. A cold start's frame is the process's first work, so it carries no tier:
      // there is nothing for it to queue behind, and stating one anyway would make the
      // frame say something about a queue that does not exist yet.
      ...(queuedBehindTurn ? { priority: requested ?? CLAUDE_QUEUED_INPUT_PRIORITY } : {}),
    }));
  }

  /** One round record, with the settlement its dispatcher awaits. */
  private createRound(
    appSessionId: string,
    turn: HostTurnInput,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): ResidentRound {
    let resolveDone: () => void = () => {};
    let rejectDone: (error: Error) => void = () => {};
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const round: ResidentRound = {
      appSessionId,
      turn,
      writer,
      context,
      done,
      settled: false,
      interrupted: false,
      settle(): void {
        if (round.settled) {
          return;
        }
        round.settled = true;
        resolveDone();
      },
      fail(error: Error): void {
        if (round.settled) {
          return;
        }
        round.settled = true;
        rejectDone(error);
      },
    };

    return round;
  }

  /**
   * Arms one round: its messages into the queue, its lease into the manager.
   *
   * `messages` are passed rather than rebuilt because the cold-start path has
   * already spent them seeding the queue before the process existed.
   */
  private armRound(
    state: ResidentHostState,
    round: ResidentRound,
    messages: AnyRecord[],
    alreadyQueued: boolean,
  ): void {
    state.context = round.context;
    state.writer = round.writer;
    // What an unattended report needs when no round is left to ask: who to
    // report to, and what to call the session. Kept here rather than read off
    // the round at report time because by then the round is gone.
    state.lastUserId = round.writer.userId ?? null;
    const sessionName = round.turn.options?.sessionSummary;
    state.lastSessionName = typeof sessionName === 'string' ? sessionName : null;
    for (const message of messages) {
      if (typeof message?.uuid === 'string' && message.uuid) {
        state.pushedUuids.add(message.uuid);
      }
    }
    // Both readings are taken here, before the push below: `rounds` is appended
    // to at the end of this method, and the frame's tier and its write moment
    // have to be judged against the process's state as it was when the frame was
    // handed over, not after this round joined. Read once — `resultsSeenAtPush`
    // and the write moment are one statement about one moment, so they must not
    // be two reads of `state.resultTimes`.
    //
    // `busy` is the *write* reading only: whether this frame is a queue entry
    // behind a turn in flight, which is what decides its tier and whether it
    // gets a queue record. Which turn it runs in is a different question, and it
    // is answered by the ledger from the CLI's own `command_lifecycle` rather
    // than guessed at here from the count of turns that have ended.
    const busy = state.rounds.length > 0 || Boolean(state.unattended);
    const resultsSeenAtArm = state.resultTimes.length;
    if (!alreadyQueued) {
      const at = Date.now();
      for (const message of messages) {
        if (busy && typeof message?.uuid === 'string' && message.uuid) {
          state.queuedInputs.push({
            uuid: message.uuid,
            at,
            priority: typeof message.priority === 'string' ? message.priority : null,
            frame: message,
            startedAt: null,
            resultsSeenAtPush: resultsSeenAtArm,
            // Read off the turn's own `result` once it has one; the frame is
            // written strictly earlier by construction, and leaving this null
            // until then is what keeps the reading from being an assertion
            // dressed up as a measurement.
            queuedBeforeResult: null,
          });
        }
      }
      state.queue.push(...messages);
    }
    state.rounds.push(round);
    // The ledger's record of the send, and the only place a run is opened. The
    // lease is not balanced here any more: it is recomputed from the ledger, so
    // arming a run is one state change (`runOpen` going true) and one
    // projection (`syncTurnLeases`), not a manual add that a later site has to
    // remember to undo.
    this.openRun(state, round, messages);
  }

  /**
   * Records one accepted send in the ledger and opens its run.
   *
   * The identity is the CLI's: the uuids are the ones the frames were written
   * under, and `commandUuid` is the one the CLI will name them by — the last
   * frame, which carries the prompt (an attachment-carrying turn writes the
   * blocks first and the text last). Every uuid is indexed so a lifecycle event
   * finds this delivery whichever frame it names.
   */
  private openRun(state: ResidentHostState, round: ResidentRound, messages: AnyRecord[]): void {
    const uuids = messages
      .map((message) => (typeof message?.uuid === 'string' ? message.uuid : null))
      .filter((uuid): uuid is string => uuid !== null && uuid.length > 0);
    const commandUuid = uuids.at(-1) ?? randomUUID();
    // The tier read off the frame that was actually written, not recomputed from
    // the turn's options: `turnMessages` is what decides a busy write's effective
    // tier (its caller's, or the default queue tier), and a ledger that formed
    // its own answer could disagree with the bytes the CLI received.
    const written = messages.at(-1);
    const priority = typeof written?.priority === 'string' ? written.priority : null;
    const delivery: ResidentLedgerDelivery = {
      commandUuid,
      uuids: uuids.length > 0 ? uuids : [commandUuid],
      // The host's own mark on the send: the CLI has not spoken about it yet.
      state: 'pushed',
      reason: null,
      turnId: null,
      runOpen: true,
      owed: false,
      withdrawalRequested: false,
      enqueuedAt: this.now(),
      startedAt: null,
      endedAt: null,
      priority,
      round,
      leaseId: `turn-${++this.serial}`,
      leaseHeld: false,
    };
    state.turnLedger.deliveries.push(delivery);
    for (const uuid of delivery.uuids) {
      state.turnLedger.byUuid.set(uuid, delivery);
    }
    this.syncTurnLeases(state);
  }

  /**
   * Recomputes the host's `turn` leases from the ledger, and reports only a change.
   *
   * The manager's removal verb is by *kind* — "the turn lease" — so the
   * projection is expressed the same way: when the set of open runs changes, the
   * kind's leases are dropped and the open runs' leases are reported again. That
   * is what keeps a delivery's run and the lease that says the host is busy from
   * ever getting one ahead of the other, which is the whole of what the five
   * hand-balanced `leaseAdded` / `leaseRemoved` calls used to have to agree
   * about by remembering to.
   */
  private syncTurnLeases(state: ResidentHostState): void {
    const open = state.turnLedger.deliveries.filter((delivery) => delivery.runOpen);
    const held = state.turnLedger.deliveries.filter((delivery) => delivery.leaseHeld);
    if (open.length === held.length && open.every((delivery) => delivery.leaseHeld)) {
      return;
    }

    state.sink.leaseRemoved(state.appSessionId, 'turn');
    for (const delivery of state.turnLedger.deliveries) {
      delivery.leaseHeld = false;
    }
    for (const delivery of open) {
      state.sink.leaseAdded(state.appSessionId, { kind: 'turn', runId: delivery.leaseId });
      delivery.leaseHeld = true;
    }
  }

  /**
   * Closes one run: its turn has ended, so its dispatcher is settled here.
   *
   * Three things happen in the order the existing contract needs them to. The
   * terminal frame is written first, because it is what flips the run in the
   * registry and a frame written after the settle would race the dispatch's own
   * safety net. The round is settled second, which resolves the dispatcher's
   * await. The ledger's own bookkeeping is last, so a reader that runs in
   * between (`reportRoundEnd` goes out to the notification layer) sees the run
   * it is reporting on still open rather than already gone.
   *
   * `owed` is the cross-check C-3 requires: a run closed while the CLI has not
   * yet stated the command's terminal is held as owed until that terminal
   * arrives, and reconciled if the next turn begins first (I4). It is not an
   * error here — a folded command's `completed` arrives *before* its turn's
   * `RESULT`, and a first command's arrives after it, so both orders are normal.
   */
  private closeRun(
    state: ResidentHostState,
    delivery: ResidentLedgerDelivery,
    providerSessionId: string | null,
  ): void {
    if (!delivery.runOpen) {
      return;
    }
    const aborted = delivery.round.interrupted;
    delivery.round.writer.send(
      createCompleteMessage({
        provider: 'claude',
        sessionId: providerSessionId || delivery.round.appSessionId || null,
        exitCode: 0,
        aborted,
      }),
    );
    this.reportRoundEnd(delivery.round, aborted ? 'aborted' : 'completed', providerSessionId);
    delivery.round.settle();

    delivery.runOpen = false;
    delivery.owed = !isTerminalDeliveryState(delivery.state);
    const index = state.rounds.indexOf(delivery.round);
    if (index >= 0) {
      state.rounds.splice(index, 1);
    }
    this.syncTurnLeases(state);
  }

  /**
   * Ends every open run and turn the ledger is carrying, for a host going away.
   *
   * The process is gone (or the manager closed the host, or the session that
   * asked for the turn detached), so no `RESULT` and no `command_lifecycle` is
   * coming: what is left is to say so. Every run still open is ended here — by
   * failing it when the stream died under it, which is how the dispatcher learns
   * its run did not finish, and by settling it when the host is being closed
   * deliberately — and every command still without a terminal is written
   * `cancelled(process-exit)`, which is the honest name for "the process that
   * was going to answer went away". An open turn reads `aborted` for the same
   * reason: it never reached a `RESULT`.
   */
  private endLedger(
    state: ResidentHostState,
    reason: ClaudeResidentDeliveryReason,
    failure: Error | null,
  ): void {
    // A host that is ending will not answer an interrupt either: the turn it was
    // waiting on is closed here as `aborted` (below), which is the honest name
    // for it, so a watchdog outliving this call could only restate it wrongly.
    this.stopInterruptWatchdog(state);
    for (const delivery of state.turnLedger.deliveries) {
      if (delivery.runOpen) {
        if (failure) {
          delivery.round.fail(failure);
        } else {
          delivery.round.settle();
        }
        delivery.runOpen = false;
        delivery.owed = false;
      }
      if (!isTerminalDeliveryState(delivery.state)) {
        this.settleDelivery(delivery, 'cancelled', reason, this.now());
      }
    }

    const turn = state.turnLedger.turn;
    if (turn?.open) {
      turn.open = false;
      state.turnLedger.closedTurns.push({
        id: turn.id,
        kind: turn.kind,
        outcome: 'aborted',
        ownerDeliveryId: turn.ownerDeliveryId,
      });
    }

    state.rounds.splice(0);
    state.turnLedger.pendingStart.splice(0);
    this.syncTurnLeases(state);
  }

  /**
   * Settles a delivery's state from the CLI's own terminal.
   *
   * The terminal is written by the lifecycle and nothing else (§5.3): a
   * `RESULT` closes the turn, it never invents a delivery's ending, and an
   * interrupt request never synthesizes one either. A terminal that arrives
   * after the run has closed is how the folded command of C-3 gets its state:
   * the run ended at the turn boundary, and this fills in what the CLI said came
   * of the command — clearing the owed flag the close left behind.
   *
   * A second terminal for the same command is not applied: `completed` after
   * `cancelled` is the CLI restating something it already stated, and
   * overwriting the first would silently drop the fact that it did.
   */
  private settleDelivery(
    delivery: ResidentLedgerDelivery,
    state: ClaudeResidentDeliveryState,
    reason: ClaudeResidentDeliveryReason | null,
    at: number,
  ): void {
    // A terminal is written once (C-1). A second one for the same command is the
    // CLI contradicting itself, and overwriting the first would hide it.
    if (isTerminalDeliveryState(delivery.state)) {
      return;
    }
    delivery.state = state;
    delivery.reason = reason;
    delivery.endedAt = at;
    delivery.owed = false;
  }

  /**
   * The reason a `cancelled` belongs to, read off what this host asked for.
   *
   * The CLI's `cancelled` does not say *why* — it is the same frame whether a
   * person withdrew a queued message or an interrupt took a running one — so the
   * reason is this side's own record of the request. The residual (`cli`) is the
   * CLI cancelling something nobody here asked about, which is a fact worth
   * keeping rather than folding into one of the three requests.
   */
  private cancelledReason(state: ResidentHostState, delivery: ResidentLedgerDelivery): ClaudeResidentDeliveryReason {
    if (delivery.withdrawalRequested) {
      return 'withdrawn';
    }
    if (state.turnLedger.turn?.interruptRequested) {
      return 'interrupt';
    }
    return 'cli';
  }

  /**
   * Applies one `command_lifecycle` event to the ledger.
   *
   * `queued` and `started` are statements about a command this host pushed; a
   * uuid nothing here has a record for can only be the CLI's own (a cron
   * firing), so it is noted as foreign and otherwise left alone.
   *
   * `started` is also where a command's turn is decided, and the rule is the
   * CLI's own (C-2): a command started while a turn is open is folded into it;
   * one started while no turn is open belongs to the turn that opens next, so it
   * waits in `pendingStart` for that turn's `init`. Nothing is read from how
   * many turns have ended — an id bound here is an id, not an offset.
   */
  private applyLifecycle(
    state: ResidentHostState,
    commandUuid: string,
    lifecycleState: CommandLifecycleState,
    at: number,
  ): void {
    const delivery = state.turnLedger.byUuid.get(commandUuid) ?? null;
    if (!delivery) {
      state.turnLedger.foreign.add(commandUuid);
      return;
    }

    if (lifecycleState === 'queued') {
      // Idempotent, and never a step back: a `queued` that arrives after a
      // `started` (the stream is not obliged to be ordered that way) does not
      // put a running command back in the queue.
      if (delivery.state === 'pushed') {
        delivery.state = 'queued';
      }
      return;
    }

    if (lifecycleState === 'started') {
      if (delivery.state === 'pushed' || delivery.state === 'queued') {
        delivery.state = 'started';
      }
      delivery.startedAt ??= at;
      const turn = state.turnLedger.turn;
      // A turn this host did not open is not a fold target. The CLI runs one
      // turn at a time, and a command of ours written during the process's own
      // turn is drained at that turn's boundary into a turn of its own —
      // measured, `claude-resident-busy-input.test.ts` leg 2 — so it belongs to
      // the turn that opens next, which is where `pendingStart` puts it. Binding
      // it here would tie the run to a turn whose ending nobody here reports.
      const foldable = turn?.open === true && turn.kind === 'delivered';
      if (foldable) {
        delivery.turnId = turn.id;
        turn.ownerDeliveryId ??= delivery.commandUuid;
        return;
      }
      // No turn to fold into: this command belongs to the turn that opens next.
      // The boundary is also where an owed delivery from the previous turn is
      // reconciled — the turn it was waiting on is over and its terminal never
      // came (I4).
      this.reconcileOwedDeliveries(state);
      if (!state.turnLedger.pendingStart.includes(delivery)) {
        state.turnLedger.pendingStart.push(delivery);
      }
      return;
    }

    this.settleDelivery(
      delivery,
      lifecycleState,
      lifecycleState === 'cancelled' ? this.cancelledReason(state, delivery) : null,
      at,
    );
  }

  /**
   * Opens the turn the CLI has just announced, binding the commands that were
   * waiting for it.
   *
   * `kind` is the whole of I5, read at this one moment: a turn whose opener came
   * from a command this host pushed is `delivered`, and one that bound nothing
   * is `unattended` — the process's own turn, which no caller here opened. The
   * owner is the earliest command bound, which is the one whose writer the
   * turn's frames belong on (§6.2, the same writer `rounds[0].writer` names).
   *
   * A turn with nothing waiting can still be a delivered turn: a cold send whose
   * `init` is the first thing the CLI says never emits a `started` for it before
   * the announcement, so the earliest open run is bound as the owner here. That
   * is the same round the old code reached by reading `rounds[0]`, expressed as
   * an id.
   */
  private openTurn(state: ResidentHostState): ResidentLedgerTurn {
    const bound = state.turnLedger.pendingStart.splice(0);
    // The earliest open run is the turn's own opener: the process takes its next
    // piece of work in send order, so the first run still open is the one the
    // frames now arriving belong to — the same round the old code reached by
    // reading `rounds[0]`, expressed as an id. A cold send is the whole reason
    // this is read separately from `pendingStart`: its frame is the process's
    // first work rather than a queue entry, so the CLI may never emit a
    // `started` for it, and a turn that bound only the queued commands behind it
    // would leave the cold run open forever.
    const owner = state.turnLedger.deliveries.find((delivery) => delivery.runOpen) ?? null;
    if (owner && !bound.includes(owner)) {
      bound.unshift(owner);
    }

    const turn: ResidentLedgerTurn = {
      id: `turn-${++this.serial}`,
      kind: bound.length > 0 ? 'delivered' : 'unattended',
      open: true,
      ownerDeliveryId: null,
      interruptRequested: false,
    };
    for (const delivery of bound) {
      delivery.turnId = turn.id;
      turn.ownerDeliveryId ??= delivery.commandUuid;
    }
    state.turnLedger.turn = turn;
    return turn;
  }

  /**
   * Opens the ledger's turn for one `system/init`, if that is what this is.
   *
   * A second `init` before the first turn's `RESULT` is the CLI contradicting
   * C-6 (the handle is `init … RESULT` and nothing in between), so it is
   * recorded as an anomaly and the open turn is left where it is: minting a
   * second turn would move the frame routing onto a turn whose `RESULT` the
   * first one's `init` never announced, which is a worse guess than keeping the
   * turn the CLI already opened.
   */
  private openTurnAtInit(state: ResidentHostState, message: AnyRecord): void {
    if (message?.type !== 'system' || message.subtype !== 'init') {
      return;
    }
    // The turn boundary is also I4's boundary: a delivery still owed its
    // terminal when the next turn begins will not get one.
    this.reconcileOwedDeliveries(state);
    if (state.turnLedger.turn?.open) {
      state.turnLedger.anomalies.push({
        code: 'double-init',
        detail: `system/init ${String(message.uuid ?? '')} arrived before turn ${state.turnLedger.turn.id} ended`,
      });
      return;
    }
    this.openTurn(state);
  }

  /**
   * Closes the open turn at its `RESULT`, settling the runs it covered.
   *
   * The runs are the deliveries bound to this turn — a folded command is bound
   * by its `started` (C-2), and a cold opener by the `init` that announced it.
   * Nothing is closed by position, so a command the CLI drains into a *later*
   * turn (`pendingStart`, or simply not started yet) keeps its run: it never
   * became part of this turn.
   *
   * A `RESULT` with no open turn is still the CLI saying a turn just ended — the
   * announcement of that turn's `init` is a frame this build may not have read
   * (a scripted stream, or a stream that began mid-turn) — so the turn is opened
   * and closed at once around the commands waiting for it rather than dropped on
   * the floor. The outcome is read from the one place it is stated: `is_error`
   * on this message, together with whether this host asked for the interrupt
   * (C-5, §6.3).
   */
  private closeTurn(state: ResidentHostState, result: AnyRecord): void {
    const existing = state.turnLedger.turn;
    const turn = existing && existing.open ? existing : this.openTurn(state);
    const outcome: 'completed' | 'aborted' =
      result?.is_error === true && turn.interruptRequested ? 'aborted' : 'completed';

    turn.open = false;
    state.turnLedger.closedTurns.push({
      id: turn.id,
      kind: turn.kind,
      outcome,
      ownerDeliveryId: turn.ownerDeliveryId,
    });

    for (const delivery of state.turnLedger.deliveries) {
      if (!delivery.runOpen || delivery.turnId !== turn.id) {
        continue;
      }
      this.closeRun(state, delivery, state.providerSessionId);
    }
    // A run that closed here is no longer owed its turn's ending, but it may
    // still be owed the CLI's terminal for its own command (C-3) — that is what
    // `owed` carries, and `reconcileOwedDeliveries` is what settles it.
  }

  /**
   * Settles the deliveries whose terminal never arrived (I4).
   *
   * The rule is a boundary rule, not a timeout: a command whose run closed while
   * the CLI had not yet stated its ending may stay owed only until the next turn
   * begins. Reaching that boundary still owed means the terminal is not coming,
   * so it is written `cancelled(owed-terminal-missing)` — the honest name for it
   * — and recorded as an anomaly rather than left quietly non-terminal.
   */
  private reconcileOwedDeliveries(state: ResidentHostState): void {
    for (const delivery of state.turnLedger.deliveries) {
      if (!delivery.owed || isTerminalDeliveryState(delivery.state)) {
        continue;
      }
      this.settleDelivery(delivery, 'cancelled', 'owed-terminal-missing', this.now());
      state.turnLedger.anomalies.push({
        code: 'owed-terminal-missing',
        detail: `delivery ${delivery.commandUuid} reached the next turn with no terminal`,
      });
    }
  }

  /**
   * Opens a run for a turn the process started by itself, at the moment that
   * turn announces itself.
   *
   * The reading is structural and has to be: a turn nobody pushed sends no
   * request, so there is nothing to correlate a run with. What the CLI does say
   * is that a conversation turn is beginning (`system/init`) at a moment when
   * **nothing this host pushed is waiting to be bound to it** and under a uuid
   * this host never pushed. The first half is the ledger's `pendingStart` — the
   * command uuids the CLI's own `started` named while no turn was open (C-2),
   * which is exactly I5's "no `started` waiting to be bound" — and it is the
   * ledger that answers it rather than a count of rounds in flight. That
   * distinction is the whole criterion: a merged turn leaves stale bookkeeping
   * on the FIFO, and reading `state.rounds.length` let one stale round mask
   * every later unattended turn — a background task's follow-up, a cron firing,
   * a peer message — so nothing reported that the work had finished.
   *
   * A command the CLI started under a uuid nothing here pushed (a cron firing,
   * E9 §9.4) is `foreign`, not a delivery waiting for a turn, so it never makes
   * the turn delivered; its uuid stays out of everything this host exposes.
   *
   * Never throws and never reports. An unattended turn that cannot be opened is
   * not a failure: the run registry may already hold a run for the session, and
   * in that case the frames stay with the last writer, which is what this mode
   * did before it could open runs at all.
   */
  private openUnattendedTurnIfOwn(
    state: ResidentHostState,
    message: AnyRecord,
    sessionId: string | null,
    commandsWaitingForTurn: number,
  ): void {
    if (state.closed || state.unattended) {
      return;
    }
    if (message?.type !== 'system' || message.subtype !== 'init') {
      return;
    }
    // I5, read off the ledger rather than off the round FIFO. A command of ours
    // whose `started` the CLI stated while no turn was open is waiting for this
    // turn and makes it a delivered one; with nothing waiting, the turn is the
    // process's own. The count is passed in rather than read here because
    // `openTurn` has already bound — and so emptied — that waiting list by the
    // time this runs.
    if (commandsWaitingForTurn > 0) {
      return;
    }
    const commandUuid = typeof message.uuid === 'string' ? message.uuid : null;
    if (!commandUuid || state.pushedUuids.has(commandUuid)) {
      return;
    }

    const handle = this.host.openUnattendedRun({
      provider: this.provider,
      appSessionId: state.appSessionId,
      providerSessionId: sessionId,
      userId: state.lastUserId,
      sessionName: state.lastSessionName,
    });
    if (!handle) {
      return;
    }

    // Read at the opener and not at the end: the hook fires at every turn's
    // end, so by the time this turn's own `result` arrives the newest reading
    // is the empty list the turn itself left behind.
    const trigger = deriveBackgroundWorkTrigger(state.ledger.latest());
    state.unattended = { commandUuid, trigger, writer: handle.writer };
    state.lastUnattendedCommandUuid = commandUuid;
    if (sessionId) {
      handle.writer.setSessionId?.(sessionId);
    }
  }

  /**
   * Reads the process's address out of the CLI's own registry and reports it.
   *
   * The app does not name the process, so there is no requested name to compare
   * a reading against — the address is simply whatever the CLI registered, read
   * back from `~/.claude/sessions/<pid>.json`. That is still a *checked* reading
   * rather than a prediction: the file is keyed by pid and carries the provider
   * `sessionId`, so a record that names another conversation is refused (see
   * `readCliSessionRegistration`), and an entry that never appears inside the
   * budget is reported as `null` rather than guessed at.
   *
   * Called once per host, at the first message that names the provider session —
   * the earliest point at which the process is far enough along to have written
   * its registry entry. It is the *startup* read rather than the whole story: a
   * launch handed no title settles on the CLI's derived name here, and the title
   * mirror moves that name later in the same turn, so
   * {@link refreshIdentityAfterRename} reads it back again once the frame is out.
   * The poll is bounded and unref'd: the entry is written at startup, so a
   * process that has not produced it within the budget has not registered an
   * address, and a driver must not hold the event loop open waiting for one that
   * is not coming.
   */
  private startIdentityReadback(state: ResidentHostState, sessionId: string): void {
    if (state.identityReadbackStarted) {
      return;
    }
    state.identityReadbackStarted = true;

    const pid = state.pid;
    if (pid === null) {
      // No pid was observed, so the registry cannot be addressed at all:
      // reporting `null` is a statement — "this binding has no address" — rather
      // than the absence a binding that was never asked about would show.
      this.publishIdentity(state, null);
      return;
    }

    const deadline = Date.now() + CLAUDE_RESIDENT_IDENTITY_BUDGET_MS;
    const poll = (): void => {
      if (state.closed) {
        return;
      }
      const registration = readCliSessionRegistration(state.configDir, pid, sessionId);
      // A launch that handed the session's own title over is registered twice:
      // the entry appears under the CLI's derived name as the process starts and
      // is rewritten when the title is adopted, which is later in the same turn.
      // Reporting that first sighting would publish an address the process stops
      // answering to a moment later, so on such a launch a `derived` reading is
      // read as "not settled yet" and the poll keeps going. A launch that handed
      // nothing over is left exactly as it was — there a derived name *is* the
      // settled answer, and waiting on one would stall every first boot.
      const settled = Boolean(registration?.name) && !(state.launchedTitle && registration?.nameSource === 'derived');
      if (!settled) {
        if (Date.now() >= deadline) {
          this.publishIdentity(state, null);
          return;
        }
        const timer = setTimeout(poll, CLAUDE_RESIDENT_IDENTITY_POLL_MS);
        timer.unref?.();
        return;
      }
      this.publishIdentity(state, registration?.name ?? null);
    };

    poll();
  }

  /**
   * Publishes an address reading to the manager, and only when it moved.
   *
   * `recordIdentity` is the projection's only writer (see
   * `session-host-manager.service.ts`), and it treats "the process stated its
   * name" as a fact worth recording. The address is read more than once over a
   * host's life, so the same value can be offered twice — the startup read's
   * answer, then a re-read's — and a value that did not move is not news. `null`
   * is publishable when it differs (a host with no address at all), so a bounded
   * read that finds nothing settles the binding to "no address" rather than
   * leaving a stale one; but it can never *blank* an address a previous read
   * established, because a re-read that times out publishes nothing.
   */
  private publishIdentity(state: ResidentHostState, value: string | null): void {
    if (state.reportedIdentity === value) {
      return;
    }
    state.reportedIdentity = value;
    state.sink.identity(state.appSessionId, value);
  }

  /**
   * Re-reads the process's registered address after the title mirror moved it.
   *
   * A cold-start launch registers under the CLI's derived name and settles there
   * (see {@link startIdentityReadback}), and the `rename_session` frame that
   * {@link mirrorResidentTitle} writes is the one event that moves it: the CLI
   * rewrites `~/.claude/sessions/<pid>.json` when it adopts the title. Without a
   * read here the projection keeps the startup snapshot for the process's whole
   * life, so every peer is handed the machine-shaped name long after the registry
   * stopped answering to it — the stale-address defect this pass exists for.
   *
   * The re-read is a bounded poll, not a watcher, and it is *armed by the frame*
   * rather than run for the life of the host. The registry rewrite is
   * asynchronous — the frame's bytes are out before the CLI has processed them —
   * so a single read would race it, and the window is the startup read's own
   * shape (50 ms interval, one budget) because it is the same kind of wait: the
   * entry is coming, or it is not. A watcher would instead pay a read per turn
   * forever for an event that happens at most once per process.
   *
   * The value published is the registry's, never the title the frame carried:
   * the criterion that guards this reads the file for itself, and "we sent this
   * string" is a prediction, not a reading. `derived` is still read as "not yet"
   * — the adoption has not landed — so a frame the CLI never processed leaves the
   * last honest reading in place instead of publishing a value nobody registered.
   */
  private refreshIdentityAfterRename(state: ResidentHostState): void {
    const pid = state.pid;
    const sessionId = state.providerSessionId;
    if (state.closed || pid === null) {
      return;
    }

    const deadline = Date.now() + CLAUDE_RESIDENT_IDENTITY_BUDGET_MS;
    const poll = (): void => {
      if (state.closed) {
        return;
      }
      const registration = readCliSessionRegistration(state.configDir, pid, sessionId);
      // The CLI adopts the mirrored title as a name it did not derive itself
      // (`nameSource: "user"`), which is what "the rewrite landed" reads as. The
      // derived name it may still be showing is the pre-frame value, not the
      // answer; leaving it unpublished keeps `publishIdentity`'s dedup from even
      // considering it.
      const adopted = Boolean(registration?.name) && registration?.nameSource !== 'derived';
      if (adopted) {
        this.publishIdentity(state, registration?.name ?? null);
        return;
      }
      if (Date.now() >= deadline) {
        return;
      }
      const timer = setTimeout(poll, CLAUDE_RESIDENT_IDENTITY_POLL_MS);
      timer.unref?.();
    };

    poll();
  }

  /**
   * Cancels a settle window in flight.
   *
   * Called wherever the host stops being live — a close, a process exit — so the
   * poll cannot fire against a state whose process is gone. The mirror value
   * already written is left alone: it is a fact about what was sent, not about
   * whether more will be.
   */
  private stopTitleMirror(state: ResidentHostState): void {
    if (state.titleMirror.timer) {
      clearTimeout(state.titleMirror.timer);
      state.titleMirror.timer = null;
    }
    state.titleMirror.open = false;
  }

  /**
   * Opens a settle window that mirrors this session's generated title into the
   * process's registered name, once the title has stopped moving.
   *
   * The address this fixes is the one `ListAgents` and `SendMessage` use:
   * `~/.claude/sessions/<pid>.json`'s `name`, which the CLI derives from the
   * working directory plus two random characters and keeps for the process's
   * whole life. A resident process is launched with no title when the session has
   * none yet — deliberately, because a title handed over at creation suppresses
   * the CLI's own generation — so the readable title the session earns a moment
   * later never reaches the registry, and every peer keeps addressing it by the
   * machine-shaped name. The `rename_session` control frame is the one verb that
   * moves it without restarting the process (the SDK's `Query` has no method for
   * it; see {@link ClaudeResidentProcess.writeRaw}).
   *
   * Three rules, each one an invariant rather than a preference:
   *
   * - **Never before the title exists.** The frame is built only from a value
   *   read out of the transcript's own `ai-title` entries, so a title that has
   *   not been written cannot be sent. This is not politeness: a rename sent
   *   before generation makes the CLI skip generating a title at all (measured:
   *   the pre-renamed arm's transcript carries `custom-title` rows and zero
   *   `ai-title` rows), so an early frame would destroy the very title it was
   *   trying to mirror.
   * - **Mirror, never invent.** The string is the transcript's `ai-title`
   *   verbatim — no ladder rung, no display name, no placeholder. A transcript
   *   with no generated title leaves this silent rather than naming the process
   *   after its first prompt.
   * - **Once.** `titleMirror.mirrored` latches on the first frame, so the CLI
   *   appending the same title on later rounds does not write a second one.
   *
   * A process launched *with* a title is skipped outright: the CLI adopted that
   * title at startup (`nameSource: "auto"`), so there is nothing derived to
   * correct, and re-mirroring would be this driver naming a process a human or
   * the launch had already named.
   *
   * Called from every stream message, but a window is opened *once per turn* —
   * at the turn's first message, and not again until the next turn's `result`
   * clears the per-turn latch. That cadence is the old one (a window every turn)
   * with the opening moved off the `result` and onto the stream, where the title
   * it is waiting for actually lands: measured on a live session, the CLI writes
   * its `ai-title` row early in the first turn — before the first assistant
   * message — so a window that waited for the `result` left the sidebar's
   * readable name and the address peers dial apart for the whole first turn
   * (362 s on the session that filed this). Opening at the turn's first message
   * costs the same reads as opening at its `result` (one bounded window per turn)
   * and moves the address as soon as the title has settled.
   *
   * A window that finds nothing spends itself rather than polling for the life of
   * the host, and a message that arrives while one is open does not restart it —
   * otherwise a busy turn would buy a read per message instead of one poll per
   * interval.
   */
  private scheduleTitleMirror(state: ResidentHostState): void {
    if (state.closed || state.launchedTitle !== null || state.titleMirror.mirrored !== null) {
      return;
    }
    if (state.titleMirror.open || state.titleMirror.openedForTurn) {
      return;
    }
    state.titleMirror.open = true;
    state.titleMirror.openedForTurn = true;

    const deadline = Date.now() + CLAUDE_RESIDENT_TITLE_MIRROR_WINDOW_MS;
    const poll = (): void => {
      state.titleMirror.timer = null;
      if (state.closed || state.titleMirror.mirrored !== null) {
        state.titleMirror.open = false;
        return;
      }
      void this.readSettledTitle(state).then((title) => {
        if (state.closed || state.titleMirror.mirrored !== null) {
          state.titleMirror.open = false;
          return;
        }
        if (title !== null && title === state.titleMirror.lastSeen) {
          this.mirrorResidentTitle(state, title);
          state.titleMirror.open = false;
          return;
        }
        // A null read is "no generated title in the transcript", not a value to
        // remember: the title already seen stays the one a later equal read has
        // to match, so a round that happened not to write one cannot reset the
        // settle test.
        if (title !== null) {
          state.titleMirror.lastSeen = title;
        }
        if (Date.now() < deadline) {
          const timer = setTimeout(poll, CLAUDE_RESIDENT_TITLE_MIRROR_POLL_MS);
          timer.unref?.();
          state.titleMirror.timer = timer;
        } else {
          // The window is spent. `open` goes false so a later turn can open a
          // fresh one; `openedForTurn` stays set, so the rest of *this* turn does
          // not re-poll for a title it already spent a full window on.
          state.titleMirror.open = false;
        }
      });
    };

    poll();
  }

  /**
   * Reads the newest `ai-title` this process's transcript holds, or null.
   *
   * The transcript is located from the two facts the host already carries — the
   * config directory the child was launched under and its working directory —
   * plus the provider session id the stream named. A host that has not yet seen
   * a session id, or was launched with no working directory, has no transcript to
   * read and answers null.
   */
  private async readSettledTitle(state: ResidentHostState): Promise<string | null> {
    const providerSessionId = state.providerSessionId;
    if (!providerSessionId || !state.projectPath) {
      return null;
    }
    const transcriptPath = claudeProjectTranscriptPath(state.configDir, state.projectPath, providerSessionId);
    return readTranscriptAiTitle(transcriptPath, providerSessionId);
  }

  /**
   * Writes the `rename_session` control frame that moves the process's registered
   * name onto `title`, and latches the mirror so it is written once.
   *
   * The frame is recorded before the write, like every other control frame this
   * host sends, so a criterion reading what the driver wrote holds the bytes even
   * if the process dies mid-write. A process with no raw-write seam (a scripted
   * stream, a substituted factory) simply does not mirror: the reading is "this
   * host wrote nothing", which is true, rather than a claim about a frame that
   * never left.
   *
   * The frame is what moves the registered name, so the same write arms the
   * *re-read* of it: the projection this frame exists to correct is refreshed
   * from the registry once the CLI has processed the frame (see
   * {@link refreshIdentityAfterRename}). Arming it here rather than on a timer
   * keeps the two in one place — a path that writes the rename is a path that
   * owes the projection a re-read.
   */
  private mirrorResidentTitle(state: ResidentHostState, title: string): void {
    const writeRaw = state.process.writeRaw;
    if (typeof writeRaw !== 'function') {
      return;
    }
    const requestId = randomUUID();
    const frame: AnyRecord = {
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'rename_session',
        title,
        // `host` is the source the CLI lands as `user`; `auto` is its internal
        // lane for titles it adopted itself and is not reachable from here.
        source: 'host',
        session_id: state.providerSessionId,
      },
    };
    state.controlFrames.push({ at: Date.now(), requestId, frame });
    writeRaw.call(state.process, frame);
    state.titleMirror.mirrored = title;
    this.refreshIdentityAfterRename(state);
  }

  /**
   * Ends the unattended turn a `result` closed: its terminal frame, then the
   * report that says what the turn was for.
   *
   * The frame comes first for the same reason a round's does — it is what flips
   * the run to completed in the registry, and a notification about a run that
   * has ended should not be able to arrive before the ending it describes. No
   * lease is touched: an unattended turn never held one, because nothing asked
   * the manager for it.
   *
   * The trigger is the one reading that cannot be taken at the opener. A turn
   * opened by a peer session leaves nothing in the process's own task list, so
   * the `Stop` hook's account of what it holds reads as an unexplained turn; a
   * turn the host layer itself opened to report a background task back leaves
   * nothing there either, for the same reason. Both are stated only on the
   * turn's `result`, as the message's origin, which is the turn's *end*. So the
   * hook's reading is kept as the answer for every other reason and is
   * overridden here — at the `result` — exactly when the CLI states one of the
   * two origins it can state: `peer` for a cross-session message, and
   * `task-notification` for the host layer's own turn reporting back (the CLI's
   * name for the shared vocabulary's `background-task`, the same mapping
   * `readClaudeNotificationOrigin` makes for the transcript row).
   */
  private finishUnattendedTurn(state: ResidentHostState, sessionId: string | null, result: AnyRecord): void {
    const unattended = state.unattended;
    if (!unattended) {
      return;
    }
    state.unattended = null;
    unattended.writer.send(
      createCompleteMessage({
        provider: 'claude',
        sessionId: sessionId || state.appSessionId,
        exitCode: 0,
        aborted: false,
      }),
    );
    const origin = (result?.origin ?? null) as AnyRecord | null;
    const statedTrigger: BackgroundWorkTrigger | null =
      origin?.kind === 'peer'
        ? 'cross-session-message'
        : origin?.kind === 'task-notification'
          ? 'background-task'
          : null;
    this.notifyUnattendedWork({
      appSessionId: state.appSessionId,
      provider: 'claude',
      userId: state.lastUserId,
      sessionId: state.appSessionId,
      sessionName: state.lastSessionName,
      trigger: statedTrigger ?? unattended.trigger,
    });
  }

  /**
   * Drops an unattended run whose turn will never end.
   *
   * The process is gone (or the manager closed the host), so no `result` is
   * coming and the run would otherwise stay open for its session forever. The
   * frame is terminal and says `aborted` rather than claiming an exit the turn
   * never had, and no report is made — the notification is about background work
   * that *completed*, and a turn that never finished is not that.
   */
  private abandonUnattendedTurn(state: ResidentHostState, exitCode: number): void {
    const unattended = state.unattended;
    if (!unattended) {
      return;
    }
    state.unattended = null;
    unattended.writer.send(
      createCompleteMessage({
        provider: 'claude',
        sessionId: state.providerSessionId || state.appSessionId,
        exitCode,
        aborted: true,
      }),
    );
  }

  /** The live resident state for a session, or null when it has no process. */
  private liveStateFor(appSessionId: string): ResidentHostState | null {
    for (const state of this.hosts.values()) {
      if (state.appSessionId === appSessionId && !state.closed) {
        return state;
      }
    }
    return null;
  }

  /**
   * The host state for a session whose ledger is still worth reading.
   *
   * The same lookup as {@link liveStateFor} with one difference, and it is the
   * difference between "what is this host doing" and "what did this host have
   * open when it stopped": a host that has ended — its stream finished under it,
   * or the manager closed it — keeps its ledger readable. Everything else this
   * driver reports is about a process it is still holding, which is why the live
   * readings refuse a closed host; the ledger is frozen at that point instead,
   * and it is the answer to "did anything stay open when it died?".
   */
  private ledgerStateFor(appSessionId: string): ResidentHostState | null {
    for (const state of this.hosts.values()) {
      if (state.appSessionId === appSessionId) {
        return state;
      }
    }
    return null;
  }

  /**
   * Builds the three entries one resident process is launched with.
   *
   * One builder for the three because they are one policy — the same
   * attendance test, the same notification, the same decision log — and only the
   * *answer shape* differs: `canUseTool` speaks the SDK's `PermissionResult`,
   * `onElicitation` speaks `ElicitResult`, and `onUserDialog` speaks the dialog
   * result union. Those shapes are the SDK's own (`sdk.d.ts`) and are produced
   * here, in the one place that knows what the client's answer was.
   *
   * The per-run path's non-interactive branch is deliberately *not* mirrored. It
   * has an allow/deny list to consult before asking; a resident host launches
   * under `bypassPermissions` (where the CLI never refers a non-interactive tool
   * to a callback at all) and only reaches this branch after an explicit live
   * switch to a mode that means "ask me". Asking, there, is what the mode means.
   */
  private createPermissionEntries(
    appSessionId: string,
    scope: ClaudePermissionScope,
  ): ClaudeResidentPermissions {
    const ask = async (
      entry: ClaudePermissionEntry,
      toolName: string | null,
      request: AnyRecord,
      options: AnyRecord,
    ): Promise<ClaudePermissionAnswer> =>
      this.answerPermissionRequest({
        appSessionId,
        scope,
        entry,
        toolName,
        request,
        signal: options?.signal as AbortSignal | undefined,
      });

    return {
      canUseTool: async (toolName, input, options) => {
        const answer = await ask('canUseTool', toolName, input, options);
        if (answer.kind === 'refused') {
          return { behavior: 'deny', message: answer.message };
        }
        const decision = answer.decision;
        if (!decision) {
          return { behavior: 'deny', message: 'Permission request timed out' };
        }
        if (decision.cancelled) {
          return { behavior: 'deny', message: 'Permission request cancelled' };
        }
        if (decision.allow) {
          return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
        }
        return {
          behavior: 'deny',
          message: typeof decision.message === 'string' ? decision.message : 'User denied tool use',
        };
      },

      onElicitation: async (request, options) => {
        const answer = await ask('onElicitation', null, request, options);
        // A refusal, an aborted wait and a timed-out one all have the same
        // meaning to the server that asked: no answer is coming. `cancel` is the
        // SDK's word for exactly that (`ElicitResult.action`).
        if (answer.kind === 'refused' || !answer.decision?.allow) {
          return { action: 'cancel' };
        }
        return typeof answer.decision.content === 'object' && answer.decision.content !== null
          ? { action: 'accept', content: answer.decision.content }
          : { action: 'accept' };
      },

      onUserDialog: async (request, options) => {
        const answer = await ask('onUserDialog', null, request, options);
        // `cancelled` is the answer the SDK documents as the safe one: for a
        // dialog kind the client did not fill in, the CLI applies the dialog's
        // own default rather than being told a result nobody produced.
        if (answer.kind === 'refused' || !answer.decision?.allow) {
          return { behavior: 'cancelled' };
        }
        return { behavior: 'completed', result: answer.decision.result ?? null };
      },
    };
  }

  /**
   * One request, answered: refused when nobody is there, asked when somebody is.
   *
   * The refusal never enters the client flow at all, and that is the reading the
   * criterion takes of it: the per-run protocol's own pending list
   * (`getPendingApprovalsForSession`) stays empty for a session this host refused
   * for, and the entry returns inside the budget instead of waiting on a
   * `timeoutMs: 0` that would never fire. The client's answer, by contrast, comes
   * back through a promise this method is the only holder of — so it is recorded
   * here, before it is returned, or it would be readable nowhere.
   */
  private async answerPermissionRequest(input: {
    appSessionId: string;
    scope: ClaudePermissionScope;
    entry: ClaudePermissionEntry;
    toolName: string | null;
    request: AnyRecord;
    signal?: AbortSignal;
  }): Promise<ClaudePermissionAnswer> {
    const { appSessionId, scope, entry, toolName, request, signal } = input;
    const writer = this.permissionWriter(scope);

    if (this.isUnattended(scope, writer)) {
      const message = unattendedRefusalMessage(entry, toolName);
      this.notifyPermission(appSessionId, scope, { entry, toolName, reason: message });
      this.recordPermissionDecision(scope, {
        entry,
        toolName,
        request,
        answer: entry === 'canUseTool' ? { behavior: 'deny', message } : { action: 'cancel' },
        refused: true,
        viaClient: false,
        requestId: null,
        reason: message,
      });
      return { kind: 'refused', message };
    }

    // Non-null by the guard above: `isUnattended` answers true for a host with no
    // writer, so reaching here means there is one to send the request on.
    const requestId = randomUUID();
    const decision = await requestClientToolDecision({
      // The frame's `toolName` is the protocol's own label for the request; the
      // two request-shaped entries have no tool, so they carry their entry name
      // and the whole request travels in `input` (the README's resident-permission
      // section says so, and the per-run protocol is otherwise unchanged).
      toolName: toolName ?? entry,
      input: request,
      requiresInteraction:
        entry !== 'canUseTool' || TOOLS_REQUIRING_INTERACTION.has(toolName ?? ''),
      requestId,
      ws: writer,
      emitNotification: (event: AnyRecord) =>
        this.notifyUser({ userId: scope.state?.lastUserId ?? null, event }),
      sessionId: appSessionId,
      sessionSummary: scope.state?.lastSessionName ?? null,
      signal,
    });
    this.recordPermissionDecision(scope, {
      entry,
      toolName,
      request,
      answer: decision,
      refused: false,
      viaClient: true,
      requestId,
      reason: null,
    });
    return { kind: 'client', decision };
  }

  /**
   * Whether this host has nobody to ask about one request.
   *
   * Two facts, and the conjunction is the whole of the mode's arrival at
   * "unattended": nobody is connected *and* no user turn is in flight. Neither
   * half stands alone — a browser watching while the process runs a cron turn of
   * its own is somebody who could answer, and a turn this host armed came from a
   * client even if that client has since gone (its prompt is buffered for
   * replay, exactly as a per-run prompt's is) — so the test is
   * `connected <= 0 && no round`.
   *
   * A host with no adopted state, or with no writer yet, is unattended by this
   * reading: the callbacks can fire in the window between `query()` and
   * `openHost` answering, and refusing there is what keeps that window from
   * parking a turn on a person this driver cannot reach.
   *
   * `writer` is passed in rather than looked up again so the one caller that has
   * to *use* it keeps the same value this decision was made about.
   */
  private isUnattended(
    scope: ClaudePermissionScope,
    writer: ProviderRuntimeWriter | null,
  ): boolean {
    const connected = this.connectedClientCount();
    scope.lastConnectedCount = connected;
    const state = scope.state;
    if (!state || !writer) {
      return true;
    }
    if (state.rounds.length > 0) {
      return false;
    }
    return connected <= 0;
  }

  /**
   * The writer one request's frames belong on, or null when there is none yet.
   *
   * The unattended turn's own writer wins while it is open, for the reason the
   * read loop prefers it: that turn is the one running, so a request from it is
   * addressed to whoever opened *it*. After that the round in flight owns its
   * requests, and a host between turns falls back to the last writer it saw —
   * which is what lets a browser that is still watching answer for a process
   * running a turn of its own.
   */
  private permissionWriter(scope: ClaudePermissionScope): ProviderRuntimeWriter | null {
    const state = scope.state;
    if (!state) {
      return null;
    }
    return state.unattended?.writer ?? state.rounds[0]?.writer ?? state.writer;
  }

  /**
   * Tells the session's user that a request was refused because nobody was there.
   *
   * The same `action_required` notification the per-run flow emits for a request
   * it is waiting on, under a code of its own: the user has to be able to tell
   * "Claude is waiting for you" from "Claude was told to carry on without you",
   * and the refusal's own words travel in the event rather than being restated.
   */
  private notifyPermission(
    appSessionId: string,
    scope: ClaudePermissionScope,
    fact: { entry: ClaudePermissionEntry; toolName: string | null; reason: string },
  ): void {
    this.notifyUser({
      userId: scope.state?.lastUserId ?? null,
      event: buildNotificationEvent({
        provider: this.provider,
        sessionId: appSessionId,
        kind: 'action_required',
        code: 'permission.unattended_refused',
        meta: {
          entry: fact.entry,
          toolName: fact.toolName,
          sessionName: scope.state?.lastSessionName ?? null,
          reason: fact.reason,
        },
        severity: 'warning',
        requiresUserAction: true,
        // One per entry per refusal, so a turn that hits the same wall three
        // times does not collapse into a single notification.
        dedupeKey: `claude:permission-refused:${appSessionId}:${fact.entry}:${scope.decisions.length}`,
      }),
    });
  }

  /** Appends one answered request to its scope's log, dated on the host's clock. */
  private recordPermissionDecision(
    scope: ClaudePermissionScope,
    decision: Omit<ClaudePermissionDecision, 'at'>,
  ): void {
    scope.decisions.push({ ...decision, at: this.now() });
  }

  /**
   * Reads the queue facts off one stream message.
   *
   * Three readings, and each is kept for a different reason: the lifecycle
   * list is the CLI's own account of what became of a message this host wrote,
   * the `control_response` list is what came back to a control frame (measured:
   * nothing does for `cancel_async_message` — `§9.2` — so this list exists to
   * let the criterion say so from a reading rather than from an absence), and
   * the `session_state_changed` count is the boundary check that the stream
   * says nothing about turn starts or ends (`§9.1`).
   *
   * The lifecycle event's shape is accepted in both plausible encodings — a
   * top-level `command_lifecycle` type and a `system` subtype — because §9
   * records the event's name and payload but not which envelope carried it, and
   * a parser that picked one would silently read nothing on the other. The
   * fields it needs are the same either way: `command_uuid` and `state`.
   */
  private recordQueueFacts(state: ResidentHostState, message: AnyRecord): void {
    if (message?.type === 'system' && message.subtype === 'session_state_changed') {
      state.sessionStateChanged += 1;
    }

    if (message?.type === 'control_response') {
      const inner = message.response as AnyRecord | undefined;
      const requestId =
        typeof inner?.request_id === 'string'
          ? inner.request_id
          : typeof message.request_id === 'string'
            ? message.request_id
            : null;
      state.controlResponses.push({ at: Date.now(), requestId });
      return;
    }

    const isLifecycle =
      message?.type === 'command_lifecycle' ||
      (message?.type === 'system' && message.subtype === 'command_lifecycle');
    const commandUuid = typeof message?.command_uuid === 'string' ? message.command_uuid : null;
    const lifecycleState = typeof message?.state === 'string' ? message.state : null;
    if (!isLifecycle || !commandUuid || !lifecycleState) {
      return;
    }

    const at = Date.now();
    state.lifecycle.push({
      commandUuid,
      state: lifecycleState as CommandLifecycleState,
      at,
    });

    // The first `started` for a uuid is the dequeue moment — the point after
    // which a withdrawal can no longer succeed. A re-started uuid (there is no
    // such event today) does not move it.
    if (lifecycleState === 'started') {
      const input = state.queuedInputs.find(
        (candidate) => candidate.uuid === commandUuid && candidate.startedAt === null,
      );
      if (input) {
        input.startedAt = at;
      }
    }

    // And the same event into the ledger, which is where the command's turn is
    // decided: the CLI's own `started`/`completed`/`cancelled`, applied by id.
    // This is the only writer of a delivery's state and of a turn binding, so
    // the reading above and the reconciliation below cannot disagree — the
    // reading is what the stream said, the ledger is what it moved.
    this.applyLifecycle(state, commandUuid, lifecycleState as CommandLifecycleState, at);
  }

  /**
   * Waits for a specific lifecycle state to be read for a specific uuid.
   *
   * Polls the reading rather than being woken by the read loop: the stream is
   * consumed by one loop this class owns, and handing the queue a callback
   * registry so a withdrawal could be notified would make the wait a second
   * consumer of the same state. `true` only when the state was actually read;
   * the budget expiring is `false`, which the caller must interpret (and does,
   * from the reading — never from the expiry).
   */
  private async waitForLifecycle(
    state: ResidentHostState,
    commandUuid: string,
    wanted: CommandLifecycleState,
  ): Promise<boolean> {
    const deadline = Date.now() + CLAUDE_CANCEL_VERDICT_WAIT_MS;
    for (;;) {
      if (state.lifecycle.some((event) => event.commandUuid === commandUuid && event.state === wanted)) {
        return true;
      }
      if (state.closed || Date.now() >= deadline) {
        return false;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, CLAUDE_CANCEL_VERDICT_POLL_MS);
      });
    }
  }

  /** Runs the read loop detached, with a rejection sink so nothing floats unhandled. */
  private consume(state: ResidentHostState): void {
    this.readStream(state).catch(() => undefined);
  }

  /**
   * Reads one host's stream to its end.
   *
   * Not stopped when the manager closes the host: the close ends the *input*, and
   * the stream's own end is the fact being watched for — breaking out early would
   * drop whatever the CLI says on its way out. Continuing is safe, because the
   * sink's verbs refuse once the manager has closed the host.
   */
  private async readStream(state: ResidentHostState): Promise<void> {
    try {
      for await (const message of state.process.query) {
        this.observe(state, message);
      }
    } catch (error) {
      state.loopError = error instanceof Error ? error : new Error(String(error));
    }
    this.reportExit(state);
  }

  /**
   * Reports one round's ending to the notification layer.
   *
   * The call the runtime's own read loop makes at its turn boundary, made from
   * the same place here for the same reason: a client listening for run-ended
   * events has to hear about a stopped resident turn as well as a completed one,
   * and this driver is where either ending is reached. The application session id
   * is preferred over the provider-native one (mirroring the runtime, which
   * prefers the app id in this report and the native one in the frame), and a
   * turn that carried no session name reports none rather than inventing one.
   */
  private reportRoundEnd(
    round: ResidentRound,
    stopReason: 'completed' | 'aborted',
    providerSessionId: string | null,
  ): void {
    const sessionName = round.turn.options?.sessionSummary;
    this.notifyRunStopped({
      userId: round.writer.userId ?? null,
      provider: 'claude',
      sessionId: round.appSessionId || providerSessionId,
      sessionName: typeof sessionName === 'string' ? sessionName : null,
      stopReason,
    });
  }

  /**
   * Reports a stream that ended on its own, unless the manager already closed
   * the host.
   *
   * Every round still waiting has lost its process, so each is failed rather
   * than left hanging: the dispatcher that awaits one has to be able to report a
   * run that died, and a promise that never settles is not that. `error` is the
   * closest detail the close vocabulary carries for a stream that ended by
   * itself; `oom` and `signal` are kernel facts this layer cannot see.
   */
  private reportExit(state: ResidentHostState): void {
    if (state.closed) {
      return;
    }
    state.closed = true;
    this.stopTitleMirror(state);

    const error = state.loopError ?? new Error('The resident Claude process ended before the turn did.');
    this.endLedger(state, 'process-exit', error);
    this.abandonUnattendedTurn(state, 1);

    state.sink.exited({ hostId: state.hostId, detail: 'error' });
  }

  /**
   * Folds one SDK message into the host's reported state.
   *
   * The order is the runtime's own read loop, minus the interactive half this
   * mode does not carry (see the file header): capture the provider session id
   * once, hand the normalized frames to the current writer, publish the token
   * budget, mark the binding active, and read a `result` as the end of a turn.
   */
  private observe(state: ResidentHostState, message: AnyRecord): void {
    const round = state.rounds[0] ?? null;
    const writer = round?.writer ?? state.writer;
    const context = round?.context ?? state.context;

    if (typeof message?.session_id === 'string' && message.session_id && !state.providerSessionId) {
      state.providerSessionId = message.session_id;
      writer?.setSessionId?.(message.session_id);
      // This message is what names the transcript, so it is the first moment the
      // address the process was launched under can be read back out of it.
      this.startIdentityReadback(state, message.session_id);
      if (!state.resumed && !state.sessionCreatedSent) {
        state.sessionCreatedSent = true;
        writer?.send(
          createNormalizedMessage({
            kind: 'session_created',
            newSessionId: message.session_id,
            sessionId: message.session_id,
            provider: 'claude',
          }),
        );
      }
    }

    const sessionId = state.providerSessionId;

    // Two launch facts the stream states and nothing else can answer for: which
    // tools this process was given, and what kind of background task it started.
    // The tool table is a launch decision, so "no tool here could have made that
    // trigger" is only readable next to it; the task type is the CLI's own word
    // for the work the hook ledger reports as a bare id. Both outlive the turn
    // that reported them, so they are recorded as they arrive.
    if (message?.type === 'system' && message.subtype === 'init' && Array.isArray(message.tools)) {
      state.initTools = message.tools.filter((tool: unknown): tool is string => typeof tool === 'string');
    }
    if (message?.type === 'system' && message.subtype === 'task_started' && typeof message.task_type === 'string') {
      state.backgroundTaskType = message.task_type;
    }
    this.recordQueueFacts(state, message);

    // Held work is read from two places: the `Stop` hook's own lists (through
    // the seam installed on the process) and these stream frames. A `system`
    // subtype this build does not read is *passed through* — recorded, so a
    // reader can see the loop met one, and otherwise untouched. Throwing or
    // stopping here would end the read loop, and with it the process's whole
    // lifetime, on a frame the CLI is entitled to invent.
    if (message?.type === 'system') {
      const subtype = typeof message.subtype === 'string' ? message.subtype : '';
      if (subtype && !HELD_WORK_SYSTEM_SUBTYPES.has(subtype)) {
        state.unhandledSystemSubtypes.push(subtype);
      }
      this.observeHeldWorkEvent(state, message);
    }
    this.inferHeldWork(state, message);

    // The CLI's own statement that a turn is beginning — the ledger's one
    // moment for opening a turn, and for deciding whether it is a turn anybody
    // here sent (I5). The two readings agree by construction rather than each
    // forming its own account of "is anything of ours running": I5's reading is
    // the commands of ours whose `started` the CLI has already stated and that
    // are waiting for this turn, and that waiting list is exactly what
    // `openTurnAtInit` consumes to bind them. So it is taken here, before the
    // call — asking the ledger afterwards would ask a list this same frame had
    // just emptied, and then every ordinary turn would read as the process's
    // own.
    const commandsWaitingForTurn = state.turnLedger.pendingStart.length;
    this.openTurnAtInit(state, message);

    // A turn this host did not push announces itself here, and from this point
    // its frames are that run's. Read before the forwarding below so the
    // opener's own frames reach the run it opened instead of the last round's.
    this.openUnattendedTurnIfOwn(state, message, sessionId, commandsWaitingForTurn);

    // The unattended turn comes first while it is open, because the CLI runs
    // one turn at a time: a round armed during an unattended turn is queued
    // *behind* it, and the frames still arriving belong to the turn that is
    // actually running. Preferring the round would send the unattended turn's
    // own frames — its text, its tool calls, its `result` — into a run that has
    // not started, and leave the run the turn really belongs to empty. After
    // that, the round in flight owns its frames; a turn nothing owns belongs to
    // the run opened for it, and only then to the last writer this host saw.
    const frameWriter = state.unattended?.writer ?? round?.writer ?? state.writer;

    if (frameWriter && context) {
      forwardNormalizedFrames({
        transformedMessage: transformResidentMessage(message),
        // The frames are routed by the provider-native id (`sessionId`), but the
        // turn phase has to be keyed by the **app session id**: the activity
        // heartbeat reads it back with the id the browser subscribes with
        // (`activity-heartbeat.service.ts` → `readSessionTurn`), and on the
        // resident path those are two different id spaces. Without this the
        // tracker is fed the provider id while every reader uses the app id, so
        // every read misses and answers `idle` for a turn that is really running.
        // Same seam, same reason, as the per-run path in `claude-runtime.provider.ts`.
        turnSessionId: state.appSessionId,
        sessionId,
        normalizeMessage: context.normalizeMessage,
        writer: frameWriter,
      });
    }

    const tokenBudget =
      extractTokenBudget(message, state.modelContextWindow) ||
      (state.assistantBudgetSent ? null : extractCumulativeTokenBudget(message, state.modelContextWindow));
    if (tokenBudget && frameWriter) {
      if (message.type === 'assistant') {
        state.assistantBudgetSent = true;
      }
      frameWriter.send(
        createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget,
          sessionId,
          provider: 'claude',
        }),
      );
    }

    // Every message is real work on the binding: a streamed frame, a tool call, a
    // turn boundary. This is what holds the quiet ceiling off a process that is
    // actively being used.
    state.sink.activity(state.appSessionId);

    // A title can land while a turn is still running: the CLI writes its
    // `ai-title` row early in the first turn, before the first assistant message.
    // So every message is a prompt to open the settle window that mirrors a
    // generated title onto the process's registered name — a message arriving
    // while a window is open is not a second window, and a turn opens only one
    // (see {@link scheduleTitleMirror}).
    this.scheduleTitleMirror(state);

    if (message?.type !== 'result') {
      return;
    }

    // Whatever the CLI says about the turn here, an interrupt waiting on it has
    // its answer: the deadline is cancelled before the turn is closed, so a
    // `RESULT` that arrives inside `T_int` can never also be reported as one
    // that never came (§6.3).
    this.stopInterruptWatchdog(state);
    state.resultTimes.push(Date.now());
    // The turn that just ended is over for windowing too: the *next* turn opens
    // its own window at its own first message.
    state.titleMirror.openedForTurn = false;
    // Every queued frame whose turn in flight has now ended gets its write-timing
    // reading closed out here, at the only moment both timestamps exist.
    for (const input of state.queuedInputs) {
      if (input.queuedBeforeResult === null && state.resultTimes.length > input.resultsSeenAtPush) {
        input.queuedBeforeResult = input.at < (state.resultTimes[input.resultsSeenAtPush] as number);
      }
    }

    // The unattended turn's own `result`, and it has to be read as such before
    // the ledger's turn is closed. The CLI runs one turn at a time, so a result
    // arriving while an unattended turn is open is *that* turn's ending — any
    // run armed since was pushed behind it and has not started yet. Closing the
    // ledger's open turn here instead would settle a run on a turn it never ran,
    // and that run's own `RESULT` would then find nothing open and be read as
    // another ending of the unattended turn.
    if (state.unattended) {
      // The `result` travels with the ending here too: the unattended turn can
      // itself have come from a peer, and the origin that says so is stated on
      // this message and nowhere else.
      this.finishUnattendedTurn(state, sessionId, message);
      this.closeLedgerTurnOnly(state, message);
      return;
    }

    // A `RESULT` with no ledger turn and no open run at all is one nobody here
    // is waiting for: the process pushed a turn of its own — the resident shape
    // of the background-work follow-up, whose `init` this build did not read, or
    // read before it knew the turn had a run. The mode already holds the process
    // open, so there is no lease to drop, and the frames above have reached the
    // client. What there is to do is end the run the opener made for that turn,
    // if this driver made one — handing over the `result` itself, because that
    // message is the only place the turn's origin is stated and the origin is
    // what names the trigger.
    if (state.rounds.length === 0 && !state.turnLedger.turn?.open) {
      this.finishUnattendedTurn(state, sessionId, message);
      return;
    }

    // The `result` ends one turn, and which runs that turn covered is read from
    // the ledger's own bindings — never from a position. A command the CLI folded
    // into this turn was bound to it by its `started` (C-2); a command it drains
    // into a *later* turn has no binding here and keeps its run, which is the
    // negative case the old merge scan had to be told apart by an offset count.
    //
    // Every run this closes writes its own terminal frame, interrupted or not,
    // and it is written before the run settles. Both halves matter: the frame is
    // what flips the run in the registry, so writing it first keeps the
    // dispatch's safety net (`completeRunIfCurrent`) from reporting an
    // interrupted turn as a normal exit; and an interrupted run has to carry
    // `aborted`, which is only known here, at its `RESULT`. A run folded into
    // this turn has no `RESULT` of its own, so this is the only terminal frame
    // it ever gets — which is exactly why it has to be written here.
    this.closeTurn(state, message);
  }

  /**
   * Closes the ledger's open turn for an ending somebody else already handled.
   *
   * The unattended turn's run is ended by `finishUnattendedTurn`, which owns its
   * frame and its notification; what is left for the ledger is the turn record
   * itself, so a reader after the fact sees the same two facts the delivered
   * path leaves: the turn is shut, and its outcome is the one the CLI stated.
   */
  private closeLedgerTurnOnly(state: ResidentHostState, result: AnyRecord): void {
    const turn = state.turnLedger.turn;
    if (!turn || !turn.open) {
      return;
    }
    turn.open = false;
    state.turnLedger.closedTurns.push({
      id: turn.id,
      kind: turn.kind,
      outcome: result?.is_error === true && turn.interruptRequested ? 'aborted' : 'completed',
      ownerDeliveryId: turn.ownerDeliveryId,
    });
  }
}
