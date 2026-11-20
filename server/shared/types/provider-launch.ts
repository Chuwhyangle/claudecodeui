import type { CommandLifecycleState, HostMode } from './primitives.js';
import type { LLMProvider, ProviderModelsDefinition } from './provider-message.js';
import type { AnyRecord } from './ui.js';

//----------------- CODEX UPSTREAM MODEL PROVIDER TYPES ------------
/**
 * One Codex upstream provider as `GET /api/settings/codex/model-providers` returns it.
 *
 * `id` is the key Codex uses in `model_providers.<id>`; the built-in ids (`openai`, `ollama`,
 * `lmstudio`) are reserved and can never appear. `baseUrl` is the Responses API root, `envKey`
 * is the child environment variable the secret is handed over in, and `tokenFile` is the
 * resolved path the runtime reads the secret from. The secret itself is NEVER part of this
 * reading: `tokenSet` says only whether the token file currently holds a non-empty value.
 * `wireApi` is always `responses` because Codex 0.166 refuses to load a provider that asks for
 * Chat Completions. `warnings` names fields the project file carried that this surface does not
 * understand (for example Codex's own `api`) plus an unusable token file, so neither is lost
 * silently.
 *
 * Mirrored by hand in `src/shared/types.ts` and compared field-for-field by
 * `src/shared/tests/wireContractTypeSync.test.ts`.
 */
export type CodexModelProvider = {
  id: string;
  name: string;
  baseUrl: string;
  envKey: string;
  tokenFile: string;
  wireApi: 'responses';
  /** Static request headers Codex sends to this provider (`http_headers`). */
  httpHeaders?: Record<string, string>;
  /** Header name → environment variable holding that header's value. */
  envHttpHeaders?: Record<string, string>;
  /** Query parameters appended to every request (`query_params`). */
  queryParams?: Record<string, string>;
  requestMaxRetries?: number;
  streamMaxRetries?: number;
  streamIdleTimeoutMs?: number;
  /** A Codex-native model catalog URL this provider serves (`model_catalog_url`). */
  modelCatalogUrl?: string;
  /** Top-level Codex `model_context_window` override for this provider's models. */
  modelContextWindow?: number;
  /** Top-level Codex `model_auto_compact_token_limit` override. */
  modelAutoCompactTokenLimit?: number;
  tokenSet: boolean;
  warnings: string[];
};

/**
 * The whole `GET /api/settings/codex/model-providers` reading.
 *
 * `path` is the project settings file this process reads and writes, `version` is its content
 * hash (the value a save must send back as `expectedVersion`), `providers` is the sorted
 * registry, and top-level `warnings` reports document-level problems (a provider entry that was
 * skipped). Mirrored by hand in `src/shared/types.ts` (TypeSync row).
 */
export type CodexModelProvidersReading = {
  path: string;
  version: string;
  providers: CodexModelProvider[];
  warnings: string[];
};

// ---------------------------
//----------------- PROVIDER ACTIVE MODEL TYPES ------------
/**
 * Provider-neutral result for the model that is actively driving a session or
 * provider runtime at the time of lookup.
 *
 * `model` must always be populated. Provider adapters should use the
 * provider-specific lookup method requested by the caller, and only fall back
 * to the provider catalog `DEFAULT` value when the active model cannot be read.
 */
export type ProviderCurrentActiveModel = {
  model: string;
};

/**
 * Where a resolved session model came from.
 *
 * `session` means the app has recorded a model for this session (the user
 * picked one, or the session has been sent on at least once) and that value is
 * authoritative. `provider` means the session predates any app-recorded model
 * and the value was read back from the provider's own session state — the case
 * for sessions started directly in a provider CLI. `default` means neither was
 * available and the catalog default is standing in.
 *
 * Routes surface this so the frontend can tell a real selection apart from a
 * placeholder without re-deriving the precedence chain.
 */
export type ProviderSessionModelSource = 'session' | 'provider' | 'default';

/**
 * The model one session runs with, its persisted reasoning effort and
 * permission mode when they have been recorded, and where the model answer
 * came from.
 *
 * Returned by `providerModelsService.resolveSessionModel` and used by the
 * `/models`, `/cost` and `/status` commands, the active-model route, and the
 * composer's model picker so every surface agrees on one answer.
 */
export type ProviderSessionModel = {
  provider: LLMProvider;
  sessionId: string | null;
  model: string;
  /** NULL means this session has not recorded an effort choice yet. */
  effort: string | null;
  /**
   * Permission mode the session last sent a message with. NULL means no
   * message has carried one yet, which the client reads as "use the provider
   * default" rather than as a mode of its own.
   */
  permissionMode: string | null;
  /**
   * The upstream provider this session's model is bound to (a Codex
   * `model_providers.<id>` id, recorded by the session's first send). NULL
   * means no binding has been recorded — the run uses the provider's own
   * default — and is not the same answer as "the default provider".
   *
   * The id is part of the conversation's identity: a session cannot move to a
   * different one in place, so a composer that offers a model from another
   * provider must fork or start a new session instead.
   */
  modelProviderId: string | null;
  /**
   * A readable statement of why the recorded provider id cannot be used any
   * more (the provider was deleted or renamed), or NULL when it still resolves.
   *
   * It is a MARK, not a fallback: `model` keeps the value the session actually
   * ran with, so the client can offer the fork/new-session action instead of
   * silently showing a default model the conversation never used.
   */
  modelProviderProblem: string | null;
  source: ProviderSessionModelSource;
};

// ---------------------------
//----------------- SESSION LAUNCH SELECTION TYPES ------------
/**
 * The composer-level selections a session is created with: the model its runs
 * launch as, plus the reasoning effort and permission mode that ride along.
 *
 * Every field is optional. Absent means "the caller stated nothing", which is
 * exactly what the session gateway accepted before this type existed and what
 * the runtime's own fallbacks still cover for a caller that has no answer.
 *
 * `model` is the load-bearing one: it selects the launch spec, and a custom
 * model's spec (its env rows) is what routes the child to that model's own
 * endpoint and credential. A session created without it runs whatever the
 * provider CLI defaults to — for Claude that is `--model default`, the host
 * account — so a caller that KNOWS the selection must state it here rather than
 * leave it to a later `chat.send`, which a voice or MCP first turn never sends.
 *
 * Consumed by the two row writers (`sessionsDb.createAppSession`,
 * `sessionsService.createAppSession`) and by the two gateway callers that state
 * it (`POST /api/providers/sessions`, the MCP `session_create` adapter).
 */
export type SessionLaunchSelection = {
  /** The model id every run of this session launches with, unless a run overrides it. */
  model?: string;
  /**
   * The upstream provider id the model runs under, when the picker stated one.
   *
   * A built-in model's provider variant shares the bare `value` and differs
   * only by provider, so the id cannot be re-derived from `model` and must be
   * carried verbatim onto the minted row. Absent means the model inherits the
   * provider's own default.
   */
  modelProviderId?: string;
  /** The reasoning effort recorded for the session; omitted leaves it unrecorded. */
  effort?: string;
  /** The permission mode the session's first run should launch under. */
  permissionMode?: string;
  /**
   * The lifecycle mode the row is created WITH.
   *
   * Absent means "the caller stated nothing", and the unified creation service
   * resolves that to the provider's own `defaultLifecycleMode`. Present means an
   * explicit choice, in either direction, which always wins over the default —
   * but only when the provider's capability matrix actually lists the mode; an
   * unsupported or unknown value is refused rather than silently replaced.
   *
   * Carried on the creation write rather than written afterwards so the row is
   * already correct when it is returned: the mode is read at dispatch time, and
   * a row created as `per-run` and switched later would run its first turn
   * under the wrong mode (or, worse, let a mode change race the send).
   */
  lifecycleMode?: HostMode;
};

/**
 * Message/event variants emitted by provider adapters and normalized transports.
 *
 * Keep this union in sync with event kinds produced by provider session adapters.
 */
export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_resolved'
  | 'permission_cancelled'
  | 'session_created'
  | 'history_truncated'
  | 'task_notification'
  | 'command_lifecycle';

/**
 * Event kinds added by the chat gateway layer on top of provider message kinds.
 *
 * These are app-level realtime events (subscription acks, sidebar deltas,
 * project loading progress, protocol failures) that are not produced by any
 * provider adapter. Together with `MessageKind` they form the complete set of
 * `kind` values a websocket client can receive, so the frontend only ever
 * needs one kind-based switch.
 */
export type GatewayEventKind =
  | 'chat_subscribed'
  | 'session_upserted'
  | 'loading_progress'
  | 'protocol_error';

/**
 * Complete set of `kind` values emitted to websocket clients.
 *
 * Every server-to-client websocket frame carries a `kind` from this union.
 * Provider runtimes emit `MessageKind` values; gateway services emit
 * `GatewayEventKind` values.
 */
export type ServerEventKind = MessageKind | GatewayEventKind;

/** The owning project as it appears inside a `session_upserted` delta. */
export type SessionUpsertedProject = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  isStarred: boolean;
};

/**
 * The `session_upserted` sidebar delta, built only by
 * `modules/websocket/services/session-upsert-broadcast.service.ts`.
 *
 * Typed rather than assembled as an untyped object literal because the payload
 * used to be built in two places and silently drifted apart: one copy set
 * `providerSessionId` and the other did not, and nothing could detect it.
 *
 * `providerSessionId` is how a client recognises that a row it is currently
 * showing has been merged into its canonical app-session row, so it is always
 * present — `null` only while the provider has not reported an id yet.
 */
export type SessionUpsertedEvent = {
  kind: 'session_upserted';
  sessionId: string;
  providerSessionId: string | null;
  provider: LLMProvider;
  session: {
    id: string;
    summary: string;
    messageCount: number;
    lastActivity: string;
  };
  project: SessionUpsertedProject | null;
  timestamp: string;
};

/**
 * The `hosts_changed` invalidation frame, built only by
 * `modules/websocket/services/hosts-changed-broadcast.service.ts`.
 *
 * An invalidation rather than a payload: `rev` is the session-host manager's
 * listing revision, and a client that has already applied that revision ignores
 * a repeat of it. The listing itself is deliberately absent — `GET
 * /api/session-hosts` remains the only face that builds it — so the browser
 * re-reads that endpoint instead of receiving a second, driftable copy of the
 * view.
 */
export type HostsChangedEvent = {
  kind: 'hosts_changed';
  /** The manager's listing revision; strictly increasing across one server run. */
  rev: number;
  timestamp: string;
};

/**
 * Provider-neutral message envelope used in REST responses and realtime channels.
 *
 * Every provider-specific message must be converted into this shape before being
 * emitted outside provider-specific modules.
 */
/**
 * A compaction, as the transcript records it.
 *
 * `running` is the status the CLI sends when it starts compacting, `done` the
 * boundary it sends when it has, `failed` a compaction that did not finish.
 * The token counts and duration only come with a boundary.
 */
export type CompactionInfo = {
  phase: 'running' | 'done' | 'failed';
  /** Whether the user asked for it or the context window did. */
  trigger?: 'manual' | 'auto';
  /** Tokens the conversation held before and after, when the boundary reports them. */
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  error?: string | null;
};

/**
 * What started a turn nobody typed.
 *
 * A closed set, and the ONLY one: the divider the transcript draws before such a
 * turn, the copy the popover shows and the lease a host is held for all have to
 * name the same three causes, so the names live here and every other module
 * narrows to them rather than spelling its own list. `background-task` and
 * `cron` are the two host leases that describe work outliving a turn; the third
 * is a message another session sent, which is why it — and only it — carries a
 * sender.
 */
export type MessageOriginTrigger = 'background-task' | 'cron' | 'cross-session';

/**
 * Why a turn exists, when the answer is not "the user sent it".
 *
 * Absent on every turn a person typed, which is what makes the absence
 * meaningful: a message with no `origin` is a user turn, and the transcript
 * renders it the way it has always been rendered. `sender` is the address the
 * sending session answers to (`SessionBinding.peerName`), and is null for the
 * two triggers that have no other conversation behind them.
 */
export type MessageOrigin = {
  trigger: MessageOriginTrigger;
  sender: string | null;
};

export type NormalizedMessage = {
  id: string;
  /**
   * The provider's own identifier for the transcript row this message came
   * from, when the provider has stable per-row identity (today: Claude's
   * `uuid`). It is what "edit this message" and "fork from here" address, so it
   * has to survive a reload — never a value this app synthesized.
   */
  transcriptAnchorId?: string;
  /**
   * The transcript row a *fork* taken from this answer should cut at.
   *
   * Set on the one assistant message that ends a turn — the last text-bearing
   * assistant row before the next real user prompt (Claude: that row's `uuid`;
   * Codex: the turn's `turnId`). Forking at it produces a conversation whose
   * last row is this answer, which is the "same question, different answer"
   * shape the sidebar's fork action promises.
   *
   * Deliberately separate from `transcriptAnchorId`: that one names a *user*
   * input row and is shared by editing, the turn outline, lazy-row keys and
   * the `aroundId` window, so reusing it for assistant rows would move all of
   * those consumers at once. A message may carry neither, one, or (never) both.
   *
   * Withheld from the last turn while its session is running: the answer is
   * still being written, and a fork cut there would copy a half-finished turn.
   */
  forkAnchorId?: string;
  /**
   * Identity of the stream block a *live* frame belongs to, as `<message.id>:<index>`.
   *
   * Set only on frames forwarded off a live Claude run — the `stream_delta`
   * fragments, the `stream_end` that closes the block, and the settled
   * `text`/`thinking`/`tool_use` record that block becomes all carry the same
   * value. That is what lets a client fold the streaming fragments onto the row
   * they settle into instead of guessing by text equality and adjacency.
   *
   * Opaque to clients: never parse it. Provider history reads never set it — a
   * transcript row has no live stream to belong to — so its presence is also the
   * signal that a frame came off the wire rather than out of the file.
   */
  blockKey?: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  /**
   * Monotonic per-run sequence number assigned by the chat run registry when a
   * live event is forwarded to the websocket. History messages loaded over
   * REST do not carry it. Clients use it with `chat.subscribe` to replay only
   * the live events they missed across websocket reconnects.
   */
  seq?: number;
  /**
   * Identity of the run a live event's `seq` belongs to, assigned by the chat
   * run registry when the run starts. `seq` is numbered per run, so a client
   * that reconnects into a *different* run than the one its `lastSeq` was
   * recorded against must start over from that run's first event — this is the
   * value that lets it say which run its cursor is good for. History messages
   * loaded over REST do not carry it.
   */
  runId?: string;
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * Who started this turn, when it was not a person at a browser.
   *
   * Present only on turns the host layer opened on its own behalf — a
   * background task reporting back, a timer firing, another session writing in.
   * The transcript draws those turns differently from a typed one, and it can
   * only do that from a fact the server published: a client that guessed from
   * the sender's absence would be inferring, not reading.
   */
  origin?: MessageOrigin;
  /**
   * The host-assigned uuid of the queued command a `command_lifecycle` message
   * is about, and where that command is in the CLI's own queue.
   *
   * Both are set only on `kind: 'command_lifecycle'`, and they are the whole
   * payload of it: the frame says "command <uuid> is now <state>" and nothing
   * else, because that is all the dialect row it comes from carries. The uuid is
   * the same value the host wrote into the transcript row for the user's message
   * and the same one a withdrawal names, which is what lets a client hold one
   * message and its queue state as one object.
   */
  commandUuid?: string;
  commandState?: CommandLifecycleState;
  /**
   * Optional display-oriented metadata used by providers that need to expose
   * richer transcript artifacts without introducing a brand-new message kind.
   *
   * Current Claude usage:
   * - local slash commands expose parsed command fields
   * - compact summaries are flagged so the UI can treat them differently later
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  /** Set on the row that stands in for a compaction, so the UI can draw it as one. */
  compact?: CompactionInfo;
  images?: unknown;
  /** Non-image files attached to a user turn after provider history normalization. */
  files?: unknown;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: {
    content?: string;
    isError?: boolean;
    toolUseResult?: unknown;
  };
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  reason?: string;
  newSessionId?: string;
  status?: string;
  summary?: string;
  /**
   * The background task a `kind: 'task_notification'` frame is about — the SDK's
   * own `task_id`.
   *
   * Set on the frames the server emits for a task's terminal transition, where it
   * is the row's stable identity: it joins the transcript line to the task table
   * (the dock's `ActivityTask.taskId`) and lets a replay be recognized as the
   * same event rather than a new one. Absent on the CLI's own notification rows,
   * which carry it inside their `<task-id>` element instead.
   */
  taskId?: string;
  tokenBudget?: unknown;
  /**
   * Timeline of everything a subagent did, attached to the `tool_use` that
   * spawned it. Present for Claude `Agent`/`Task` calls and Codex
   * `spawn_agent` calls; absent for every other tool.
   */
  subagentTools?: SubagentActivity[];
  /** Identity and lifecycle of the subagent this `tool_use` spawned. */
  subagent?: SubagentInfo;
  /** Stored memory the reply drew on, when the provider reports it. */
  memoryCitations?: MemoryCitation[];
  toolUseResult?: unknown;
  sequence?: number;
  rowid?: number;
  [key: string]: unknown;
};

/**
 * One stored memory an assistant reply drew on.
 *
 * Codex appends these to a reply that used its memory files, naming the file
 * and line range it read plus a short note on what it took from there. The
 * transcript shows them as a footnote so a memory-derived claim is traceable
 * rather than arriving as an unattributed assertion.
 */
export type MemoryCitation = {
  /** File and line range that was read, e.g. `MEMORY.md:137-142`. */
  source: string;
  /** What the reply took from that range, when the provider states it. */
  note?: string;
};

/**
 * One entry in a subagent's recorded timeline.
 *
 * Providers store a subagent's work in a separate transcript (Claude:
 * `<session>/subagents/agent-<id>.jsonl`; Codex: a sibling rollout keyed by
 * `agent_thread_id`). Both are flattened into this shape so the transcript can
 * replay a subagent's run with the same renderers the main thread uses.
 *
 * `kind` decides which fields matter: `tool` uses the tool fields, `text` and
 * `thinking` use `content`. Consumers must not assume tool fields exist on the
 * text kinds.
 */
export type SubagentActivity = {
  kind: 'tool' | 'text' | 'thinking';
  timestamp?: string;
  /** Tool-call identity; only set when `kind` is `tool`. */
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: { content?: string; isError?: boolean } | null;
  /** Message body; only set when `kind` is `text` or `thinking`. */
  content?: string;
};

/**
 * Identity and lifecycle of one spawned subagent, normalized across providers.
 *
 * `status` is `running` until the call that spawned the agent resolves. After
 * that it is whatever the provider reported — Claude's task notification
 * carries one — and `completed` when the provider reported nothing. A failed
 * tool call *inside* the agent is not a failed agent, so it is never inferred
 * from the transcript.
 */
export type SubagentInfo = {
  /** Provider-native agent id — Claude `agentId`, Codex `agent_thread_id`. */
  id: string;
  /** Human-facing label: Claude's agent type, or Codex's assigned nickname. */
  name?: string;
  /** Agent type/preset when the provider records one (Claude `agentType`). */
  type?: string;
  /** One-line task summary shown in the collapsed header. */
  description?: string;
  status: 'running' | 'completed' | 'failed';
  /** Model the subagent ran on, when the provider records it. */
  model?: string;
  /**
   * How many activities the agent actually recorded. It exceeds
   * `subagentTools.length` when a long run was truncated for transport, which
   * lets the UI say so instead of silently showing a partial timeline.
   */
  activityCount?: number;
};

/**
 * Output gateway shared by WebSocket and SSE provider runs.
 *
 * Runtime adapters only depend on this structural surface, which keeps them
 * independent from the transport that ultimately delivers normalized events.
 */
export type ProviderRuntimeWriter = {
  send(data: unknown): void;
  setSessionId?(sessionId: string): void;
  userId?: string | number | null;
  isWebSocketWriter?: boolean;
  isSSEStreamWriter?: boolean;
};

export type ProviderPermissionDecision = {
  allow: boolean;
  updatedInput?: unknown;
  message?: string;
  rememberEntry?: unknown;
};

export type ProviderRuntimePermissionGateway = {
  /**
   * Settles a pending request with `decision`.
   *
   * `decidedBy` names the caller that decided it (an MCP principal's user id),
   * or `null` when the path does not name one — the browser UI's own resolve has
   * no principal. It is threaded only so the runtime's decision ledger can
   * report who won a race; it never changes whether the decision is applied.
   */
  resolve(requestId: string, decision: ProviderPermissionDecision, decidedBy?: string | null): void;
  listPending(sessionId: string): unknown[];
  /**
   * Why a `requestId` is absent from the pending registry.
   *
   * The two answers are different facts and AC-287 requires the MCP surface to
   * report them apart: `expired` means the runtime HELD this request and no
   * longer does (it timed out or was already decided), so a caller who waited is
   * told its case went away; `never_issued` means no trace of the id exists at
   * all, so the caller named something this process never minted. A registry
   * that deletes a settled request without a trace cannot answer this, which is
   * why the runtime keeps a bounded ledger of held ids separate from the live
   * pending map.
   *
   * Optional, and read as `expired` when absent, because the conservative
   * degradation is the one that never asserts a request never existed: a
   * gateway assembled without this verb still answers "that request is gone"
   * rather than inventing `never_issued` for an id it simply cannot classify.
   */
  classifyMissingApproval?(requestId: string): MissingApprovalReason;
  /**
   * The decision the runtime recorded for a `requestId`, or `null` when it never
   * decided one.
   *
   * `classifyMissingApproval` above answers WHERE a missing id went; this one
   * answers WHETHER it was decided, which is the distinction `approval_answer`
   * needs to report a lost race as `ALREADY_DECIDED` instead of folding it into
   * `expired`/`never_issued` — a settled id is absent from the pending registry
   * for the same reason a timed-out one is, and only this ledger tells them
   * apart. A still-pending request reads `null` here (it has not been decided).
   *
   * Optional: a gateway without it simply cannot report a lost race and falls
   * back to the missing-approval classification.
   */
  readApprovalDecision?(requestId: string): ApprovalDecisionRecord | null;
};

/**
 * One approval request's settled decision, as the runtime records it.
 *
 * `decidedBy` is the caller that won the race (an MCP principal's user id, or
 * `null` when the settling path named none — the browser UI's own resolve has
 * no principal); `allow` is the decision as applied, or `null` when the settle
 * carried no boolean (a cancellation or a timeout).
 *
 * Consumed by `provider-runtime.service.ts` (forwarded from the runtime's
 * permissions facet) and `chat-control.service.ts` (which turns it into the
 * `ALREADY_DECIDED` refusal).
 */
export type ApprovalDecisionRecord = {
  decidedAt: number;
  decidedBy: string | null;
  allow: boolean | null;
};

/**
 * Why a `requestId` is not in the pending registry: it was held and is gone
 * (`expired`), or nothing this process minted ever carried it (`never_issued`).
 *
 * Consumed by `provider-runtime.service.ts` (which forwards it from whichever
 * provider's permissions facet answers), `chat-control.service.ts` (which folds
 * it into the refusal), and `mcp-approvals.ts` (which reports it as the
 * `APPROVAL_NOT_FOUND` envelope's `details.reason`).
 */
export type MissingApprovalReason = 'expired' | 'never_issued';

/**
 * Provider-scoped application capabilities supplied to a runtime for one run.
 *
 * Keeping these lookups outside concrete SDK/CLI adapters prevents the
 * adapters from importing services that resolve back through providerRegistry.
 */
export type ProviderRuntimeContext = {
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels(): Promise<ProviderModelsDefinition>;
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  isProviderInstalled(): Promise<boolean>;
};

export type ProviderRunFunction = (
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
) => Promise<unknown>;

/**
 * Shared options used to fetch historical provider messages.
 *
 * Consumers should pass provider-specific lookup hints (`projectPath`) only
 * when the selected provider requires them.
 *
 * `providerSessionId` is the provider-native session id from the sessions
 * index (transcript file name / provider database key). Provider adapters
 * must use it — never the app-facing session id they were called with — when
 * matching transcript rows on disk, because app-created sessions use an
 * app-allocated id that the provider has never seen.
 */
export type FetchHistoryOptions = {
  projectPath?: string;
  limit?: number | null;
  offset?: number;
  providerSessionId?: string;
  /**
   * Whether the session's run is still in flight at read time.
   *
   * A reader that stamps `forkAnchorId` must withhold it from the final turn
   * while this is true — that turn's answer is still being written, and a fork
   * cut at a half-written answer copies a partial turn. Optional so direct
   * provider calls (and providers that do not offer forks) need not set it.
   */
  running?: boolean;
};

/**
 * Standardized response payload returned from provider history readers.
 *
 * Use this as the contract for APIs that return paginated conversation history.
 */
export type FetchHistoryResult = {
  messages: NormalizedMessage[];
  /**
   * Absolute 0-based subscript of `messages[0]` in the full normalized
   * history. Optional on the provider contract so each reader need not
   * recompute what `sliceTailPage` already knows; the sessions service fills
   * it in from `total`, `offset` and the page length on every route.
   */
  startIndex?: number;
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number | null;
  tokenUsage?: unknown;
};

// ---------------------------
