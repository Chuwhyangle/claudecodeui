import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';

// The capability declaration the health payload republishes. Imported as a type from the
// repository-root shared tree rather than restated here: the whole point of the payload is
// that it carries the registry's own declaration, so a restatement could drift from it
// silently. `import type` only — the backend never calls an adapter from this file.
import type {
  AsrCapabilities,
  AsrCredentialFields,
  AsrErrorCode,
  AsrHints,
  AsrRuntimeStatus,
} from '../../shared/asr/asrRegistry.js';

//----------------- HTTP RESPONSE SHAPES ------------
/**
 * Canonical success envelope used by backend APIs that return a structured payload.
 *
 * Use this for route handlers that need a stable `success/data` shape so frontend
 * consumers can parse responses consistently across endpoints.
 */
export type ApiSuccessShape<TData = unknown> = {
  success: true;
  data: TData;
};

/**
 * Generic plain-object record used when parsing loosely typed JSON payloads.
 *
 * Use this only after runtime shape checks, not as a replacement for validated
 * domain models.
 */
export type AnyRecord = Record<string, any>;

// ---------------------------
//----------------- WEBSOCKET TRANSPORT TYPES ------------
/**
 * Minimal websocket client contract used by backend broadcaster services.
 *
 * Any transport object added to `connectedClients` must implement these two
 * members so shared services can safely send JSON strings and check whether the
 * socket is still open before broadcasting.
 */
export type RealtimeClientConnection = {
  readyState: number;
  send(data: string): void;
};

/**
 * Authenticated user payload attached to websocket upgrade requests.
 *
 * Platform and OSS auth flows currently use either `id` or `userId`; both are
 * represented here so websocket handlers can resolve a stable writer user id.
 */
export type AuthenticatedWebSocketUser = {
  id?: string | number;
  userId?: string | number;
  username?: string;
  [key: string]: unknown;
};

/**
 * HTTP upgrade request shape after websocket authentication succeeds.
 *
 * `verifyClient` populates `request.user` with the authenticated payload, and
 * downstream websocket handlers rely on this extended request type.
 */
export type AuthenticatedWebSocketRequest = IncomingMessage & {
  user?: AuthenticatedWebSocketUser;
};

// ---------------------------

//----------------- UI CLIENT IDENTITY ------------
/**
 * One browser tab currently connected and identified, as published by the UI
 * client registry's read port (`listUiClients`).
 *
 * A tab is the unit the registry stores; a device is the grouping it derives.
 * `connectedAt` is the server's clock at the moment this tab's `ui.hello`
 * arrived, so a caller can tell a long-lived tab from one that just opened.
 */
export type UiClientTab = {
  /** This tab's own id (sessionStorage-scoped in the browser). */
  tabId: string;
  /** The name this tab announced; devices group tabs that may carry different names. */
  deviceName: string;
  /** Epoch milliseconds when this tab's identity reached the server. */
  connectedAt: number;
};

/**
 * One device (one browser) currently connected, with every identified tab of it.
 *
 * `deviceId` is the browser's stable id and is what a caller addresses a device
 * by. `deviceName` is the name of this device's most recently connected tab, so
 * a rename announced by the newest tab is what a listing shows.
 *
 * The connection a tab arrived on is deliberately absent: identity is addressed
 * by device and tab, never by a socket, whose id changes on every reconnect.
 */
export type UiClientDevice = {
  /** The browser's stable id; survives reloads, changes only when site data is cleared. */
  deviceId: string;
  /** The device's display name, taken from its most recently connected tab. */
  deviceName: string;
  /** Every identified tab of this device, oldest connection first. */
  tabs: UiClientTab[];
};

// ---------------------------
//----------------- UI VISIBLE CONTEXT ------------
/**
 * One connection the UI-state round trip can address.
 *
 * The registry holds the live socket behind an announced identity, which is
 * exactly the pair the round trip needs: it must WRITE to that socket and
 * REPORT the answering tab by the identity a caller can name. Only the round
 * trip's own service reads this port, so the socket reached here is never
 * published to a caller — the registry's own `listUiClients` projection stays
 * the one read surface the MCP tools are handed.
 */
export type UiStateRequestTarget = {
  /** The live connection this identity arrived on. */
  connection: RealtimeClientConnection;
  deviceId: string;
  tabId: string;
  deviceName: string;
  /** Epoch ms when this identity reached the server. */
  connectedAt: number;
};

/** The Git diffs a tab has expanded; a collection, because the panel expands many at once. */
export type UiCurrentDiff = {
  /** The active Git sub-view: 'changes' | 'history' | 'branches' | 'worktrees'. */
  view: string;
  /** Workspace file paths expanded in the changes view. */
  files: string[];
  /** Commit hashes expanded in the history view. */
  commits: string[];
};

/** The task a tab has focused; `source` disambiguates the TaskMaster / quay id namespaces. */
export type UiCurrentTask = {
  /** Which task system this id belongs to. Only TaskMaster has a selection surface. */
  source: 'taskmaster';
  /** The task's id in its own namespace. */
  id: string;
  /** The task's title, or null when the surface carries none. */
  title: string | null;
};

/** The user's transcript selection as it crosses this boundary: reduced, but still content. */
export type UiSelectedTextReading = {
  text: string;
  truncated: boolean;
  region: 'transcript';
};

/**
 * What one tab reports about what it is showing, as the server reads it off a
 * `ui.state_response` frame.
 *
 * Identifiers and ranges ONLY — message ids, counts, and the names of things.
 * A message body and a panel's content are deliberately not representable here:
 * the server projects a frame down to exactly these fields, so a browser that
 * sends more (or a fixture that injects one) cannot widen what a caller reads.
 * The one content-bearing field, `selectedText`, is projected but then delivered
 * only through the separately-scoped `ui_selected_text` tool; `ui_visible_context`
 * strips it, so a cloudcli:read caller can never read the text.
 */
export type UiVisibleContextReport = {
  /** This device's own navigation policy at the moment it answered. */
  navigationPolicy: string;
  /** The Git diffs this tab has expanded; null when the Git panel is not active. */
  currentDiff: UiCurrentDiff | null;
  /** The TaskMaster task this tab has focused, or null. */
  currentTask: UiCurrentTask | null;
  /** The transcript selection this tab holds, or null. Content is scoped separately. */
  selectedText: UiSelectedTextReading | null;
  /** Whether the page was in the foreground. */
  visibility: 'visible' | 'hidden';
  /** Whether this tab held keyboard focus. */
  hasFocus: boolean;
  /** Epoch ms of the last moment this tab was focused; null when it never was. */
  lastFocusedAt: number | null;
  /** The workspace panel this tab is showing, or null when none is known. */
  panel: string | null;
  /** The project this tab has open, or null. */
  selectedProject: string | null;
  /** The session this tab has open, or null. */
  selectedSession: string | null;
  /** The first and last message ids currently visible in the transcript. */
  visibleMessages: { first: string | null; last: string | null };
  /** How many tool approvals are waiting for the user in this tab. */
  pendingApprovals: number;
  /** How many of this tab's messages are still waiting in the send queue. */
  queuedMessages: number;
};

/** The frame the server broadcasts to ask every connected tab what it is showing. */
export type UiStateRequestFrame = {
  type: 'ui.state_request';
  requestId: string;
};

/**
 * The frame a tab answers a `ui.state_request` with.
 *
 * `requestId` is echoed verbatim so the server can match the answer to the
 * request it belongs to and drop anything else. The identity fields are the
 * tab's own; the remaining fields are {@link UiVisibleContextReport}, which is
 * the whole of what may cross this boundary.
 */
export type UiStateResponseFrame = {
  type: 'ui.state_response';
  requestId: string;
  deviceId: string;
  tabId: string;
  deviceName: string;
} & UiVisibleContextReport;

/**
 * One tab as a UI-visible-context reading reports it: the identity the server
 * addressed it by, plus the report it answered with.
 *
 * An unanswered tab is the same shape with `unresponsive: true` and every report
 * field null — "this tab did not answer" is a fact about the reading, not a
 * failure of it, so it is carried in the result rather than thrown.
 */
export type UiVisibleContextTab = {
  tabId: string;
  deviceName: string;
  /** True when the tab was asked and did not answer inside the window. */
  unresponsive: boolean;
  navigationPolicy: string | null;
  visibility: 'visible' | 'hidden' | null;
  hasFocus: boolean | null;
  lastFocusedAt: number | null;
  panel: string | null;
  selectedProject: string | null;
  selectedSession: string | null;
  visibleMessages: { first: string | null; last: string | null } | null;
  pendingApprovals: number | null;
  queuedMessages: number | null;
  currentDiff: UiCurrentDiff | null;
  currentTask: UiCurrentTask | null;
  /** The transcript selection this tab held; null for a tab that did not answer. */
  selectedText: UiSelectedTextReading | null;
};

/**
 * One device's tabs, as a UI-visible-context reading reports them.
 *
 * `lastFocusedAt` is the newest focus moment across this device's tabs and is
 * what the listing is ordered by, so "which device is the user actually looking
 * at" is the first row rather than a fact to be derived by the caller.
 */
export type UiVisibleContextDevice = {
  deviceId: string;
  deviceName: string;
  /** The newest tab focus moment of this device; null when none of its tabs answered. */
  lastFocusedAt: number | null;
  /** This device's tabs, most recently focused first. */
  tabs: UiVisibleContextTab[];
};

// ---------------------------
//----------------- UI NAVIGATION ------------
/**
 * What a `ui.navigate` instruction asks the browser to reveal.
 *
 * Three of these land inside the named session and so make it the active one:
 * `{ latest: true }` (the transcript's tail), `{ messageId }` (one message) and
 * `{ turnId }` (a turn, addressed by its `messageAnchorId` per
 * turn-message-addressing). The other two change WHAT the workspace shows without
 * changing the active session: `{ diffFile }` (a file's diff, the path relative to
 * the session's project) and `{ taskId }` (a task's detail). The distinction
 * matters downstream: only a session-opening position fires the
 * applied-notification that feeds `ui_last_opened_session`, because revealing a
 * diff or a task is not opening a session.
 *
 * Every id comes from a `ui_visible_context` / `session_read` reading rather than
 * being guessed.
 */
export type UiNavigationPosition =
  | { latest: true }
  | { messageId: string }
  | { turnId: string }
  | { diffFile: string }
  | { taskId: string };

/** Whether a position makes its session the active one (as opposed to revealing a diff or a task). */
export function isSessionOpeningPosition(at: UiNavigationPosition): boolean {
  return 'latest' in at || 'messageId' in at || 'turnId' in at;
}

/**
 * The frame the server writes to one device's tabs to ask them to open a session
 * and land at a position.
 *
 * It is the OPPOSITE direction from `ui.state_request`: the server is not asking
 * a question, it is delivering an instruction, and `navigationId` is what the
 * browser echoes back so the answer can be matched to the instruction that
 * minted it. The frame carries no identity of its own — the server knows which
 * socket it wrote to, and the browser answers with its own `deviceId` /
 * `tabId`.
 */
export type UiNavigateFrame = {
  type: 'ui.navigate';
  navigationId: string;
  sessionId: string;
  at: UiNavigationPosition;
};

/**
 * How a browser received a `ui.navigate` — the DELIVERY ack.
 *
 *  - `shown`: the tab is showing the user a confirmation bar (the device's
 *    policy is "ask"); the tool reports `pending_user`.
 *  - `applied`: the tab navigated immediately (policy "accept", or a policy that
 *    requires no confirmation); the tool reports `applied`.
 *  - `declined`: the tab refused the instruction (policy "reject").
 *
 * The ack says nothing about a LATER decision: an `ask` tab answers `shown` now
 * and reports what the user chose through `ui.navigate_result`.
 */
export type UiNavigationAck = 'shown' | 'applied' | 'declined';

/**
 * The frame a tab answers a `ui.navigate` with, immediately on delivery.
 *
 * `navigationId` and the two identity fields are echoed so the server can match
 * the ack to the instruction it wrote and record which tab received it.
 */
export type UiNavigateAckFrame = {
  type: 'ui.navigate_ack';
  navigationId: string;
  deviceId: string;
  tabId: string;
  status: UiNavigationAck;
};

/**
 * The final outcome of a navigation, as a tab reports it after the user decided.
 *
 * Only an `ask` device reaches this frame later than the ack: it answered
 * `shown`, and this is the user's verdict (or the reason none was reached). An
 * `accept` / `reject` device's ack IS its final outcome and no result frame
 * follows.
 *
 *  - `applied`  — the browser opened the session (this is what writes the
 *    "last opened" pointer);
 *  - `declined` — the user said no;
 *  - `ignored`  — the user dismissed the prompt without answering;
 *  - `superseded` — a newer navigation to the same tab arrived first;
 *  - `expired`  — the prompt timed out unanswered.
 */
export type UiNavigationFinalStatus = 'applied' | 'declined' | 'ignored' | 'superseded' | 'expired';

/** The frame a tab reports a navigation's final outcome with. */
export type UiNavigateResultFrame = {
  type: 'ui.navigate_result';
  navigationId: string;
  deviceId: string;
  tabId: string;
  status: UiNavigationFinalStatus;
};

/**
 * A navigation's status as a caller reads it.
 *
 * `pending_user` is the one non-terminal value: the bar is up and the user has
 * not decided yet. Everything else is final and is what `ui_visible_context`'s
 * `navigations[]` reports.
 */
export type UiNavigationStatus =
  | 'applied'
  | 'declined'
  | 'pending_user'
  // The delivery window closed with no ack: nobody was listening, or the tab that
  // was is gone. Distinct from every browser-reported verdict because it says
  // nothing about what the user wanted — only that the instruction did not land.
  | 'unresponsive'
  | UiNavigationFinalStatus;

/**
 * One navigation as the server remembers it in memory.
 *
 * This is the record `ui_open_session` returns (the delivery reading) and the
 * one `ui_visible_context`'s `navigations[]` lists (the as-of-now reading): the
 * same row, mutated in place when the browser reports a final outcome. It is
 * never persisted — a navigation is about a live socket, and a restart makes
 * every unanswered record meaningless.
 */
export type UiNavigationRecord = {
  navigationId: string;
  /** The device the instruction was addressed to. */
  deviceId: string;
  deviceName: string;
  /** The tab that acknowledged it; null while nothing has answered. */
  tabId: string | null;
  sessionId: string;
  at: UiNavigationPosition;
  /** The MCP client that asked (`clientId`), or null for a personal access token. */
  requestedBy: string | null;
  /** Epoch ms the instruction was written. */
  requestedAt: number;
  /** Epoch ms of the last status change. */
  updatedAt: number;
  status: UiNavigationStatus;
};

// ---------------------------
//----------------- PROVIDER MESSAGE MODEL ------------
/**
 * Providers supported by the unified server runtime.
 *
 * Use this as the source of truth whenever a function or payload needs to identify
 * a specific LLM integration.
 */
export type LLMProvider = 'claude' | 'codex' | 'cursor' | 'opencode';

/**
 * One selectable model row in a provider model catalog.
 */
export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  /** Stable SQLite row id used only by model-management actions. */
  recordId?: number;
  /** True for user-created rows; false for immutable CloudCLI defaults. */
  isCustom?: boolean;
  /** Custom-model env config as returned to clients; secret values are never included. */
  config?: ProviderModelPublicConfig | null;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
};

/**
 * Provider model catalog returned by `GET /api/providers/:provider/models`.
 */
export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

/**
 * One persisted custom-model row in the provider model library.
 *
 * Provider modules use this shape at the database boundary. Predefined models
 * never use this type because they remain source-controlled in provider
 * adapters. `modelId` is sent to the provider runtime, while `model` is the
 * user-supplied display name shown in pickers.
 */
export type CustomProviderModelRecord = {
  recordId: number;
  provider: LLMProvider;
  modelId: string;
  model: string;
  sortOrder: number;
  config: ProviderModelConfig | null;
};

/**
 * User-editable values accepted when creating or changing a custom model.
 *
 * `id` must be the exact provider-facing model identifier and cannot contain
 * whitespace. `model` is a concise display name. The provider is supplied by
 * the route path so a row can never be moved across providers accidentally.
 */
export type CustomProviderModelInput = {
  id: string;
  model: string;
  /** `undefined` leaves stored config untouched (update) or none (create); `null` clears it. */
  config?: ProviderModelConfig | null;
};

/**
 * One env row of a custom model's config. `kind` selects the semantics:
 * `value` sets a literal, `secret` sets a write-only literal, `envref` reads
 * the host variable named in `value`, and `unset` removes the variable (no
 * `value`). `key` must pass the launch env allowlist.
 */
export type ProviderModelEnvRow = {
  key: string;
  kind: 'value' | 'secret' | 'envref' | 'unset';
  value?: string;
};

/**
 * Client-facing env row: identical to the stored row except that a secret
 * carries only `isSet` and never its value.
 */
export type ProviderModelPublicEnvRow =
  | { key: string; kind: 'value' | 'envref'; value?: string }
  | { key: string; kind: 'unset' }
  | { key: string; kind: 'secret'; isSet: true };

export type ProviderModelPublicConfig = {
  env: ProviderModelPublicEnvRow[];
};

/**
 * Per-model config stored in `provider_models.config_json`. `env` is ordered
 * and each key may appear at most once.
 */
export type ProviderModelConfig = {
  env: ProviderModelEnvRow[];
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
  /** The reasoning effort recorded for the session; omitted leaves it unrecorded. */
  effort?: string;
  /** The permission mode the session's first run should launch under. */
  permissionMode?: string;
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
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number | null;
  tokenUsage?: unknown;
};

// ---------------------------
//----------------- PROVIDER SKILL TYPES ------------
/**
 * Scope where a provider skill definition was discovered.
 *
 * Provider skill adapters should use this to describe the origin of each
 * skill markdown file without leaking provider-specific folder names into route
 * contracts. `repo` is used for Codex repository lookup locations, while
 * `project` is used for providers that treat workspace-local skills as project
 * scoped.
 */
export type ProviderSkillScope = 'user' | 'project' | 'plugin' | 'repo' | 'admin' | 'system';

/**
 * Shared input accepted by provider skill listing operations.
 *
 * Routes pass `workspacePath` when a caller wants project/repository skills for
 * a specific folder. Providers should fall back to the backend process cwd when
 * this option is omitted.
 */
export type ProviderSkillListOptions = {
  workspacePath?: string;
};

/**
 * One supporting file bundled with an uploaded provider skill.
 *
 * `relativePath` is resolved below the installed skill directory and must never
 * be absolute or contain traversal segments. Text files may use `utf8`; binary
 * scripts and assets should use `base64` so JSON transport does not corrupt
 * their bytes.
 */
export type ProviderSkillCreateFile = {
  relativePath: string;
  content: string;
  encoding: 'utf8' | 'base64';
};

/**
 * One skill markdown payload submitted for provider-managed installation.
 *
 * `content` is the raw markdown body that will be written to `SKILL.md`.
 * `directoryName` lets callers control the target folder name explicitly when
 * they want stable filesystem paths that differ from the markdown front matter
 * `name` field. `fileName` is optional upload metadata used only as a final
 * fallback when no directory name or front matter name is present. `files`
 * carries scripts, references, and other files from a complete skill folder.
 */
export type ProviderSkillCreateEntry = {
  content: string;
  directoryName?: string;
  fileName?: string;
  files?: ProviderSkillCreateFile[];
};

/**
 * Shared input accepted by provider skill creation operations.
 *
 * The service layer batches multiple skill definitions in one request. Each
 * entry can contain only markdown or a complete skill folder.
 */
export type ProviderSkillCreateInput = {
  entries: ProviderSkillCreateEntry[];
};

export type ProviderSkillRemoveInput = {
  directoryName: string;
};

/**
 * Normalized skill record returned by provider skill adapters.
 *
 * The `command` value is the exact invocation text the selected provider expects
 * for this skill. Claude plugin skills use a namespaced command such as
 * `/plugin-name:skill-name`, while Codex skills use the `$skill-name` form.
 * `sourcePath` points to the skill markdown file that produced the record so
 * callers can distinguish duplicate skill names across scopes.
 */
export type ProviderSkill = {
  provider: LLMProvider;
  name: string;
  description: string;
  command: string;
  scope: ProviderSkillScope;
  sourcePath: string;
  pluginName?: string;
  pluginId?: string;
};

/**
 * Internal source descriptor consumed by shared provider skill discovery logic.
 *
 * Concrete provider adapters build these records from their native lookup rules.
 * The shared skills provider then scans `rootDir` for child skill markdown files
 * and uses `commandForSkill` or `commandPrefix` to produce the provider-specific
 * invocation command. Set `recursive` only when a provider stores skills under
 * arbitrary nested folders below the source root.
 */
export type ProviderSkillSource = {
  scope: ProviderSkillScope;
  rootDir: string;
  recursive?: boolean;
  commandPrefix?: '/' | '$';
  commandForSkill?: (skillName: string) => string;
  pluginName?: string;
  pluginId?: string;
};

// ---------------------------
//----------------- SHARED ERROR TYPES ------------
/**
 * Optional metadata used when constructing application-level errors.
 *
 * `statusCode` should reflect the HTTP response status, while `code` identifies
 * the stable machine-readable error category.
 */
export type AppErrorOptions = {
  code?: string;
  statusCode?: number;
  details?: unknown;
};

// ---------------------------
//----------------- MCP TYPES ------------
/**
 * Scope where an MCP server definition is stored and resolved.
 *
 * `user` is global for a user account, `local` is provider-local, and `project`
 * is tied to a specific project path.
 */
export type McpScope = 'user' | 'local' | 'project';

/**
 * Transport protocol used by an MCP server definition.
 */
export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * Normalized MCP server model exposed to frontend and route handlers.
 *
 * Provider adapters should map provider-native config to this structure before
 * returning results.
 */
export type ProviderMcpServer = {
  provider: LLMProvider;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
};

/**
 * Payload for create/update MCP server operations.
 *
 * Routes and services should accept this type, validate it, and then persist it
 * through provider-specific MCP repositories.
 */
export type UpsertProviderMcpServerInput = {
  name: string;
  scope?: McpScope;
  transport: McpTransport;
  workspacePath?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
};

// ---------------------------
//----------------- PROVIDER AUTH TYPES ------------
/**
 * Authentication status result returned by provider health checks.
 *
 * This shape is consumed by settings/status endpoints to report installation and
 * credential state for each provider.
 */
export type ProviderAuthStatus = {
  installed: boolean;
  provider: LLMProvider;
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

// ---------------------------
//----------------- SHARED DATABASE CREDENTIAL TYPES ------------
/**
 * Safe credential view returned by credential listing APIs.
 *
 * This intentionally excludes the raw credential secret while still exposing
 * metadata needed for UI rendering and management operations.
 */
export type CredentialPublicRow = {
  id: number;
  credential_name: string;
  credential_type: string;
  description: string | null;
  created_at: string;
  is_active: number;
};

/**
 * Result returned after creating a credential record.
 *
 * Use this return shape when callers need the created id and display metadata,
 * but must never receive the stored secret value.
 */
export type CreateCredentialResult = {
  id: number | bigint;
  credentialName: string;
  credentialType: string;
};

// ---------------------------
//----------------- PROJECT PERSISTENCE TYPES ------------
/**
 * Canonical project row shape returned by the projects repository.
 *
 * Use this type whenever backend services need to pass around one database
 * project record without leaking raw SQL row typing across modules.
 */
export type ProjectRepositoryRow = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  isStarred: number;
  isArchived: number;
  session_filter?: string | null;
};

/**
 * Result category returned by `projectsDb.createProjectPath`.
 *
 * `created` means a fresh row was inserted, `reactivated_archived` means an
 * existing archived path was accepted and updated, and `active_conflict` means
 * an already-active path blocked project creation.
 */
export type CreateProjectPathOutcome =
  | 'created'
  | 'reactivated_archived'
  | 'active_conflict';

/**
 * Structured result returned by project-path upsert operations.
 *
 * Services should use this result to decide whether a request succeeded,
 * should return a conflict, or needs follow-up retrieval of row metadata.
 */
export type CreateProjectPathResult = {
  outcome: CreateProjectPathOutcome;
  project: ProjectRepositoryRow | null;
};

/**
 * Validation result for user-supplied workspace/project paths.
 *
 * `resolvedPath` is present only when validation succeeds. `error` is present
 * only when validation fails and is suitable for user-facing diagnostics.
 */
export type WorkspacePathValidationResult = {
  valid: boolean;
  resolvedPath?: string;
  error?: string;
};

// ---------------------------
//----------------- GIT WORKTREE MANAGEMENT ------------
/**
 * Captured output of one completed `git` invocation.
 *
 * Returned by `GitCommandRunner` implementations so worktree services can read
 * both streams without caring about process plumbing.
 */
export type GitCommandResult = {
  stdout: string;
  stderr: string;
};

/**
 * Executes `git <args>` inside `cwd` and resolves with the captured output.
 *
 * All worktree services receive their git access through this contract so
 * tests can inject a fake runner instead of spawning real processes. The
 * promise must reject (with `stderr` attached when available) on a non-zero
 * exit code.
 */
export type GitCommandRunner = (args: string[], cwd: string) => Promise<GitCommandResult>;

/**
 * One entry parsed from `git worktree list --porcelain`.
 *
 * This is the raw repository-level view (path/HEAD/branch/flags) before any
 * enrichment with project links or ahead/behind counts. `branch` is null for
 * detached-HEAD worktrees.
 */
export type WorktreePorcelainEntry = {
  path: string;
  headSha: string | null;
  branch: string | null;
  isDetached: boolean;
  isLocked: boolean;
  isPrunable: boolean;
};

/**
 * Fully enriched worktree row served to the UI.
 *
 * Extends the porcelain entry with everything the Worktrees panel renders:
 * dirty-file count, ahead/behind relative to the base branch (the branch
 * checked out in the main worktree), last-commit metadata, and the CloudCLI
 * project row linked to the worktree directory (if one was registered).
 */
export type WorktreeDescriptor = {
  path: string;
  branch: string | null;
  headSha: string | null;
  isMain: boolean;
  isCurrent: boolean;
  isLocked: boolean;
  isDetached: boolean;
  changedFileCount: number;
  ahead: number;
  behind: number;
  lastCommitSubject: string | null;
  lastCommitDate: string | null;
  linkedProjectId: string | null;
  linkedProjectArchived: boolean;
};

/**
 * Response payload of `GET /api/worktrees`.
 *
 * `baseBranch` is the branch checked out in the main worktree — the merge
 * target offered by the UI. `worktrees` always lists the main worktree first.
 */
export type WorktreeListResult = {
  repositoryRoot: string;
  baseBranch: string | null;
  worktrees: WorktreeDescriptor[];
};

// ---------------------------
//----------------- WORKTREE SERVICE INPUTS AND RESULTS ------------
/**
 * Input accepted by the worktree-listing workflow.
 *
 * `projectPath` may point at the main checkout or any linked worktree. The
 * service uses Git to resolve the complete repository-level worktree list.
 */
export type ListWorktreesInput = {
  projectPath: string;
};

/**
 * Input accepted when creating a linked Git worktree.
 *
 * `branch` is checked out when it already exists, otherwise it is created from
 * `baseBranch`. When `baseBranch` is omitted, the main worktree branch is used.
 */
export type CreateWorktreeInput = {
  projectPath: string;
  branch: string;
  baseBranch?: string | null;
};

/**
 * Result of successfully creating a linked Git worktree.
 *
 * `createdBranch` distinguishes a new branch from an existing branch checkout,
 * allowing API clients to accurately describe what Git changed.
 */
export type CreateWorktreeResult = {
  worktreePath: string;
  branch: string;
  createdBranch: boolean;
};

/**
 * Result of atomically creating and registering a worktree for project use.
 *
 * The Worktrees application service compensates the Git creation if project
 * registration fails, so routes only receive this shape after both steps pass.
 */
export type CreateAndOpenWorktreeResult = CreateWorktreeResult & {
  project: WorktreeProjectView;
};

/**
 * Input accepted when registering an existing worktree as a CloudCLI project.
 *
 * The service verifies that `worktreePath` belongs to the repository containing
 * `projectPath` before it creates or restores any project record.
 */
export type OpenWorktreeInput = {
  projectPath: string;
  worktreePath: string;
};

/**
 * Project view returned after a worktree is opened in CloudCLI.
 *
 * This deliberately mirrors the project-selection payload used by the Projects
 * module so the frontend can switch to the worktree without another lookup.
 */
export type WorktreeProjectView = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  isStarred: boolean;
  sessions: [];
  sessionMeta: { hasMore: false; total: 0 };
};

/**
 * Input accepted when removing a linked Git worktree.
 *
 * `force` permits removal with local changes. `deleteBranch` requests
 * best-effort branch cleanup after the worktree directory is removed.
 */
export type RemoveWorktreeInput = {
  projectPath: string;
  worktreePath: string;
  force?: boolean;
  deleteBranch?: boolean;
};

/**
 * Result of removing a linked Git worktree.
 *
 * `archivalError` reports best-effort project archival failure after Git has
 * already removed the worktree, allowing callers to represent partial success.
 */
export type RemoveWorktreeResult = {
  removedPath: string;
  branch: string | null;
  branchDeleted: boolean;
  archivedProjectId: string | null;
  archivalError: string | null;
};

/**
 * Input accepted when merging a linked worktree into the main worktree branch.
 *
 * The service verifies both worktrees are clean, supports squash and regular
 * merges, and may remove the source worktree after a successful merge.
 */
export type MergeWorktreeInput = {
  projectPath: string;
  worktreePath: string;
  squash?: boolean;
  message?: string | null;
  removeAfterMerge?: boolean;
};

/**
 * Result of a completed worktree merge.
 *
 * `removedWorktree` is populated only when post-merge removal succeeds.
 * `cleanupError` reports failed optional removal without misrepresenting the
 * already-completed merge as a failure.
 */
export type MergeWorktreeResult = {
  mergedBranch: string;
  targetBranch: string;
  squash: boolean;
  removedWorktree: RemoveWorktreeResult | null;
  cleanupError: string | null;
};

// ---------------------------
//----------------- WORKTREE MODULE DEPENDENCY CONTRACTS ------------
/**
 * Filesystem capability required by the Worktrees module.
 *
 * Production wiring checks the real filesystem; unit tests provide a small
 * deterministic fake so worktree creation never touches developer directories.
 */
export type WorktreeFileSystem = {
  pathExists(candidatePath: string): Promise<boolean>;
};

/**
 * Project-management boundary consumed by Worktrees workflows.
 *
 * The Worktrees module uses this contract instead of importing Database or
 * Projects internals. Production adapters delegate through those modules'
 * `index.ts` barrels, while unit tests supply in-memory functions.
 */
export type WorktreeProjectGateway = {
  getProjectPathById(projectId: string): string | null;
  getProjectByPath(projectPath: string): ProjectRepositoryRow | null;
  createProject(input: {
    projectPath: string;
    customName: string;
  }): Promise<{
    outcome: 'created' | 'reactivated_archived';
    project: { projectId: string };
  }>;
  restoreProject(projectId: string): void | Promise<void>;
  archiveProject(projectId: string): void | Promise<void>;
};

/**
 * Complete application-service surface used by the Worktrees HTTP router.
 *
 * Routes parse transport values and call these functions; they do not import
 * repositories, filesystem adapters, Git runners, or individual service files.
 */
export type WorktreeServices = {
  resolveProjectPath(projectId: string): string;
  list(input: ListWorktreesInput): Promise<WorktreeListResult>;
  create(input: CreateWorktreeInput): Promise<CreateWorktreeResult>;
  createAndOpen(input: CreateWorktreeInput): Promise<CreateAndOpenWorktreeResult>;
  open(input: OpenWorktreeInput): Promise<WorktreeProjectView>;
  merge(input: MergeWorktreeInput): Promise<MergeWorktreeResult>;
  remove(input: RemoveWorktreeInput): Promise<RemoveWorktreeResult>;
};

// ---------------------------
//----------------- FILE TREE MODULE CONTRACTS ------------
/**
 * One filesystem item returned by the File Tree API.
 *
 * The service populates metadata without following symlinks and recursively
 * attaches `children` only while the requested depth permits traversal. The
 * frontend uses the absolute `path` as the stable identifier for editor and
 * file-operation requests.
 */
export type FileTreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string | null;
  permissions: string;
  permissionsRwx: string;
  isSymlink?: boolean;
  children?: FileTreeNode[];
  // Lazy directory listings never open child directories, so a directory entry
  // reports whether it may have children optimistically (always true today) and
  // the frontend draws an expander without a peek request.
  hasChildren?: boolean;
};

/**
 * One lazily-listed directory level for the Files tab.
 *
 * The listing contains exactly the visible entries of `path` (no recursion).
 * `truncated` is true when the directory has more visible entries than the
 * per-directory cap, in which case `entries` holds the first `cap` of them and
 * the request still succeeds instead of failing the whole tree.
 */
export type FileTreeDirectoryListing = {
  path: string;
  entries: FileTreeNode[];
  truncated: boolean;
};

/**
 * One flat entry in a project's file index.
 *
 * The index exists so filename-resolution consumers (chat @-mentions, the command
 * palette, the open-file resolver, Files-tab search) can share one bounded list
 * instead of each walking the project tree. `path` is absolute and `name` is its
 * basename, so a consumer can match on either without re-deriving the parent.
 *
 * Entries describe files only: a git-backed index is exactly the path set from
 * `git ls-files`, which lists no directories, and the non-git fallback matches
 * that shape. `type` stays a union so a later directory-index reader can widen
 * the contract without a second entry type.
 */
export type FileTreeIndexEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory';
};

/**
 * A project's bounded flat file index.
 *
 * `truncated` is true only when the non-git filesystem fallback stopped at the
 * entry cap. A git-backed index is exact and therefore never truncated.
 */
export type FileTreeIndex = {
  files: FileTreeIndexEntry[];
  truncated: boolean;
};

/**
 * Minimal directory-entry shape required during File Tree traversal.
 *
 * Production adapts Node `Dirent` objects to this structural contract. Tests
 * provide small handwritten entries and therefore never read real directories.
 */
export type FileTreeDirectoryEntry = {
  name: string;
  isDirectory(): boolean;
};

/**
 * Minimal file-stat shape used for tree metadata and delete decisions.
 *
 * The numeric mode is converted to octal and rwx strings for the UI. `lstat`
 * supplies symlink state while `stat` is used when deciding file versus folder
 * deletion behavior.
 */
export type FileTreeStats = {
  size: number;
  mtime: Date;
  mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/**
 * Complete filesystem capability injected into File Tree services.
 *
 * The production composition root delegates these operations to Node's fs
 * APIs. Unit tests provide deterministic path-keyed fakes so service tests
 * cannot inspect, write, rename, or delete developer files.
 */
export type FileTreeFileSystem = {
  access(candidatePath: string): Promise<void>;
  stat(candidatePath: string): Promise<FileTreeStats>;
  lstat(candidatePath: string): Promise<FileTreeStats>;
  // Streamed rather than returned as an array so a directory with millions of
  // children is abandoned at the entry limit instead of being materialized.
  openDirectory(directoryPath: string): AsyncIterable<FileTreeDirectoryEntry>;
  realpath(candidatePath: string): Promise<string>;
  readTextFile(filePath: string): Promise<string>;
  writeTextFile(filePath: string, content: string): Promise<void>;
  makeDirectory(directoryPath: string, recursive: boolean): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  removeDirectory(directoryPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  copyFile(sourcePath: string, destinationPath: string): Promise<void>;
  createReadStream(filePath: string): Readable;
  // Optional repository probes for the flat file index. Production supplies both
  // (a git-backed index); a filesystem-only fake may omit them, and the service
  // then takes the bounded walk fallback. They are optional so adding this
  // reading seam does not force every existing test fake to grow two members.
  isGitRepository?(projectRoot: string): Promise<boolean>;
  // Project-root-relative POSIX paths, exactly as `git ls-files` reports them.
  listGitFiles?(projectRoot: string): Promise<string[]>;
};

/**
 * Project lookup boundary consumed by File Tree workflows.
 *
 * File Tree services resolve DB-assigned project ids through this contract and
 * never import the Database module or its repositories directly.
 */
export type FileTreeProjectGateway = {
  getProjectPathById(projectId: string): string | null | Promise<string | null>;
};

/**
 * Workspace validation boundary used by filesystem browsing and folder creation.
 *
 * The injected validator enforces the configured workspace root and resolves
 * symlinks before the File Tree service exposes or mutates paths.
 */
export type FileTreeWorkspaceGateway = {
  rootPath: string;
  validatePath(candidatePath: string): Promise<WorkspacePathValidationResult>;
};

/**
 * Uploaded-file record passed from the Multer transport adapter into the File
 * Tree service.
 *
 * Transport-specific field names are normalized so upload workflows do not
 * depend on Express or Multer types.
 */
export type FileTreeUploadedFile = {
  originalName: string;
  temporaryPath: string;
  size: number;
  mimeType: string;
};

/**
 * Logger boundary for expected File Tree diagnostics.
 *
 * Production delegates to the server console. Unit tests use no-op or captured
 * loggers and never patch the global console singleton.
 */
export type FileTreeLogger = {
  error(message: string, error?: unknown): void;
};

/**
 * Required production dependencies for the File Tree application service.
 *
 * Filesystem, project lookup, workspace policy, MIME detection, concurrency,
 * and logging are all explicit so service construction has no hidden process,
 * repository, or machine-wide defaults.
 */
export type FileTreeServiceDependencies = {
  fileSystem: FileTreeFileSystem;
  projects: FileTreeProjectGateway;
  workspace: FileTreeWorkspaceGateway;
  resolveMimeType(filePath: string): string;
  fileSystemConcurrency: number;
  logger: FileTreeLogger;
};

/**
 * Complete File Tree application-service surface consumed by HTTP routes.
 *
 * Routes parse transport inputs and call these methods; they never resolve
 * project repositories, validate filesystem ownership, or perform filesystem
 * mutations themselves.
 */
export type FileTreeServices = {
  browseWorkspace(inputPath: string | null): Promise<{
    path: string;
    suggestions: Array<{ path: string; name: string; type: 'directory' }>;
  }>;
  createWorkspaceFolder(folderPath: string): Promise<{ success: true; path: string }>;
  readTextFile(projectId: string, filePath: string): Promise<{ content: string; path: string }>;
  openFile(projectId: string, filePath: string): Promise<{ contentType: string; stream: Readable }>;
  saveTextFile(projectId: string, filePath: string, content: string): Promise<{
    success: true;
    path: string;
    message: string;
  }>;
  // Lazy Files tab listing: exactly one directory level, bounded per directory.
  // `directoryPath` omitted (or the project root) lists the project root.
  listProjectDirectory(
    projectId: string,
    directoryPath?: string,
  ): Promise<FileTreeDirectoryListing>;
  // Flat file index shared by filename-resolution consumers; a git project is
  // served from `git ls-files`, everything else from a bounded filesystem walk.
  listProjectFileIndex(projectId: string): Promise<FileTreeIndex>;
  // Files-tab search index: an unfiltered bounded walk of what is on disk
  // (gitignored paths, `.git/`, `node_modules/` included). Deliberately
  // separate from `listProjectFileIndex`: display/search read disk truth,
  // filename references read git semantics.
  listProjectSearchIndex(projectId: string): Promise<FileTreeIndex>;
  createEntry(input: {
    projectId: string;
    parentPath: string;
    type: 'file' | 'directory';
    name: string;
  }): Promise<{ success: true; path: string; name: string; type: 'file' | 'directory'; message: string }>;
  renameEntry(input: { projectId: string; oldPath: string; newName: string }): Promise<{
    success: true;
    oldPath: string;
    newPath: string;
    newName: string;
    message: string;
  }>;
  deleteEntry(input: { projectId: string; targetPath: string }): Promise<{
    success: true;
    path: string;
    type: 'file' | 'directory';
    message: string;
  }>;
  storeUploadedFiles(input: {
    projectId: string;
    targetPath: string;
    relativePaths: string[];
    requestedFileCount: number;
    files: FileTreeUploadedFile[];
  }): Promise<{
    success: true;
    files: Array<{ name: string; path: string; size: number; mimeType: string }>;
    uploadedCount: number;
    requestedFileCount: number;
    targetPath: string;
    message: string;
  }>;
};

// ---------------------------
//----------------- VOICE MODULE CONTRACTS ------------
/**
 * Per-request voice settings parsed from authenticated HTTP headers.
 *
 * The Voice routes create this value from the optional `x-voice-*` headers and
 * pass it to the Voice service. Empty values mean "use the server-configured
 * default"; the backend base URL is intentionally absent because clients must
 * never control the server's outbound destination.
 */
export type VoiceRequestOverrides = {
  apiKey?: string;
  sttModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsFormat?: string;
  /**
   * The recogniser this request must use, as it is spelled in user-level configuration.
   *
   * It is an override rather than a stored setting because it selects among the registered
   * adapters and changes with them, not with the user's backend. An id no adapter claims is
   * refused with an explicit error; it is never replaced by the default provider, because a
   * silent fallback's worst case is a user who believes they are transcribing with the service
   * they chose while the previous one answers.
   */
  providerId?: string;
};

/**
 * Uploaded audio accepted by the Voice transcription service.
 *
 * Routes translate Multer's transport-specific file object into this minimal
 * shape so the service does not depend on Express or Multer types.
 */
export type VoiceAudioUpload = {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
};

/**
 * Successful speech payload returned by the Voice service.
 *
 * The route copies `contentType` to the client response and pipes `body`
 * without buffering the complete synthesized audio in application memory.
 */
export type VoiceSpeechPayload = {
  contentType: string;
  body: ReadableStream<Uint8Array> | null;
};

/**
 * One user's Voice backend settings as they are stored server-side.
 *
 * The first six fields are the ones the settings tab has always edited; the empty string is the
 * "unset" value for every one of them, which is what a user who has never saved anything reads back
 * as. Declared here rather than in the Voice module because both the database repository (which
 * persists a row) and the Voice service (which validates and returns it) speak this shape.
 *
 * `baseUrl` is only stored, never fetched by the server: a client-configured backend is called
 * directly from the browser, so this value never becomes SSRF input on this side.
 *
 * THE LAST FOUR ARE OPTIONAL, AND EACH ONE IS OWNED BY A PROVIDER RATHER THAN BY THE SERVER. A
 * recogniser whose credential is the user's own — a workspace endpoint that only that user has, a
 * key that may only be presented server-side — cannot be reached through `baseUrl`/`apiKey`, which
 * describe the browser's own backend and are deliberately control-able from a header. Which fields
 * carry such a credential is DECLARED BY THE PROVIDER (`AsrAdapter.credentials`,
 * `AsrCredentialFields` in `shared/asr/asrRegistry.ts`) rather than fixed here, so this type does
 * not have to grow a branch per provider and the server never indexes anything by an id: it reads
 * the field names off whichever adapter it selected.
 *
 * OPTIONAL RATHER THAN REQUIRED, even though a stored document always carries all four (the
 * repository fills an absent one with the empty string). A required field would make every existing
 * caller that speaks the six-field document a compile error, and the ones that matter are outside
 * the change that adds these: a settings document read from a row written by an older build has no
 * such fields at all, and that state is exactly what "unset" means. Absent and empty are the same
 * reading here, on purpose.
 *
 * `providerId` is the one exception in kind: it selects WHICH adapter serves the user's audio, so it
 * is the user-level half of the precedence `effectiveProviderId` applies (user's choice, then the
 * deployment's environment, then the registry's first row). An id no adapter claims is still
 * refused rather than replaced.
 */
export type VoiceSettings = {
  baseUrl: string;
  apiKey: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: string;
  /** The recogniser this user selected, as it is spelled in user-level configuration. */
  providerId?: string;
  /** A provider-declared endpoint field: the address a `'proxy-only'` recogniser is reached at. */
  dashscopeEndpoint?: string;
  /** A provider-declared credential field: a key the server holds and the browser must never see. */
  dashscopeApiKey?: string;
  /** A provider-declared model field: the model the user selected for that recogniser. */
  dashscopeModel?: string;
  /**
   * The Live Voice realtime relay's own DashScope credential — INDEPENDENT of the voice-input
   * `dashscopeApiKey` above (that one is the dashscope-omni RECOGNISER's key). The realtime relay is
   * a different service (the WebSocket speech model), so it carries its own key rather than re-using
   * the recogniser's. Server-held, masked on readback exactly like the provider-declared credentials.
   */
  liveVoiceDashscopeApiKey?: string;
  /**
   * Whether this user's dictation is kept on this machine as a voice record. Default `true`.
   *
   * THE USER-DATA SWITCH, AND NOT THE DIAGNOSTIC ONE. `VOICE_CAPTURE` is a deployment property read
   * once at start-up, defaults off and fails closed; this is a per-user preference that defaults ON,
   * which is what the D1 promise — recordings stay local, and can be cleared — rests on. Optional
   * like the provider-owned fields above, and for the same reason: a document written before this
   * setting existed carries no key, and absent has to read as the default rather than as "off".
   * Only the literal `false` turns recording off, so a document that never named the key records.
   */
  voiceDataRecording?: boolean;
  /**
   * The ceiling, in bytes, on the voice-data directory. Absent means the shipped default (2 GiB).
   *
   * ONLY A BOUND ON THE STORE. When a write pushes the directory past it, the oldest records are
   * removed first (see `voice-data.ts`); it never refuses a transcription and is not the per-request
   * upload limit — that is the provider's own budget. The user may change it from the settings page.
   */
  voiceDataMaxBytes?: number;
};

/**
 * Explicit service result used by Voice routes instead of transport-aware
 * exceptions.
 *
 * Services return `ok: false` with the exact client status/message for expected
 * backend, validation, and timeout failures. Routes only translate the result
 * into HTTP output, while unexpected programming errors still reject normally.
 */
export type VoiceServiceResult<TValue> =
  | { ok: true; value: TValue }
  | {
    ok: false;
    status: number;
    error: string;
    /**
     * The semantic code for this failure, taken from the recogniser seam's own vocabulary
     * (`AsrErrorCode`). EVERY FAILURE OF AN ATTEMPT CARRIES ONE, and so does every refusal of an
     * upload that reached a gate — the three pre-request gates (container, budget, endpoint rule)
     * always did, and the failures read off the transport now do as well: an adapter already names
     * its upstream's refusal in the vocabulary (`UNAUTHORIZED` for a rejected key, `RATE_LIMITED`
     * for the upstream's own limit, `UPSTREAM_UNAVAILABLE` for a 5xx, a transport that never
     * answered and an answer that was not the service's envelope, and the finer members the answer's
     * own body earns it: `ACCOUNT_ACCESS`, `QUOTA_EXHAUSTED`, `MODEL_NOT_FOUND`, `AUDIO_REJECTED`,
     * `CONTENT_FLAGGED` — see `classifyUpstreamFailure`), and the route republishes
     * that name instead of dropping it. A client that has to choose the words for "you said nothing"
     * against "we could not reach the service" cannot do it from a status number — `422` and `502`
     * are the same two numbers for several different remedies — and the code is the one field that
     * survives the round trip with its meaning.
     *
     * THE FAILURES STILL WITHOUT ONE, named so the rule above is read as what it is rather than as a
     * promise the path does not keep: the format gate (`validateConfiguredBackend`), which refuses a
     * setting that is not a URL at all — a state of the deployment rather than a meaning about an
     * attempt, and the narrower endpoint rule above it is what carries `INVALID_BASE_URL`; a provider
     * id nothing in the registry claims, which is the same kind of state and has no member in the
     * vocabulary to be named by; and the TTS face, which shares this type but not the recogniser's
     * vocabulary.
     *
     * The route republishes it verbatim beside the message.
     */
    code?: AsrErrorCode;
    /**
     * The upstream's own error code, when it answered with one — the string its body used to name the
     * failure, such as `AccessDenied.Unpurchased` or `Throttling.RateQuota`.
     *
     * WHAT THIS IS FOR, given `code` above already says what went wrong. `code` is the CLASSIFIED
     * meaning, and the classification is this application's reading; `upstreamCode` is the evidence
     * it was read from, unclassified and unlocalised. A user (or a support thread, or the folded
     * technical detail in the UI) can compare it against the service's own error-code page, which is
     * the only place the exact row for a failure like an expired account exists — and a code the
     * classifier does not recognise still arrives with its evidence attached instead of being
     * swallowed into the generic `UPSTREAM_UNAVAILABLE`.
     *
     * IT IS ALWAYS A SLICE OF THE UPSTREAM'S BODY (`extractUpstreamCode` guarantees that) and it is
     * absent, never empty or invented, when the upstream named nothing, when this process never got
     * an answer to read (a transport that refused to connect), or when the answer held no string of
     * the shape a code has. It is a value the server read, not a value it composed — so it is also
     * not sanitised prose, and the two rules that keep it that way (never copy the body, never
     * truncate a candidate) are stated where it is extracted.
     */
    upstreamCode?: string;
  };

/**
 * One recogniser as the health payload publishes it.
 *
 * `capabilities` is the registry's own declaration for this id, republished unchanged: the
 * client reads the container, the inline budget and the hint switches from here instead of
 * keeping its own table, which is what stops the two from disagreeing after a provider changes.
 *
 * `configured` answers "if this provider were the effective one, would the current
 * configuration let a request through". Every registered provider reads the same user-level
 * backend in this version, so the entries agree today; the field is per-entry so a provider
 * that later needs its own credential does not force every consumer to special-case it.
 */
export type VoiceProviderSummary = {
  id: string;
  /**
   * The name to show a user. The first version has no separate display names, so the id is
   * its own label; the field exists so the UI never has to grow a translation table.
   */
  label: string;
  capabilities: AsrCapabilities;
  configured: boolean;
  /**
   * WHICH STORED SETTINGS FIELDS ARE THIS PROVIDER'S OWN, republished verbatim from the
   * registry's declaration (`AsrCredentialFields`), the same way `capabilities` is.
   *
   * The settings form has to render a different set of inputs per provider — a provider whose
   * address and key are its own gets their fields, one reached through the deployment's backend
   * gets the shared six — and neither of the two obvious ways to answer that is acceptable: a
   * table of ids in the client is a second source of truth that would silently disagree with the
   * registry after a provider changes, and a client that simply rendered all ten fields would ask
   * a user for an address that is never sent anywhere.
   *
   * `undefined` is the declaration's own answer for "no fields of its own" — the same absence
   * `providerConfigured` and `resolveRecognitionConfig` branch on server-side, so the client and
   * the request path read one shape rather than two.
   */
  credentialFields?: AsrCredentialFields;
  /**
   * THE ON-HOST ENGINE'S STATE, for a provider that runs one, republished verbatim from
   * `AsrAdapter.runtime` — the same way `capabilities` and `credentialFields` are.
   *
   * ABSENT FOR A PROVIDER THAT DECLARES NO RUNTIME, which today is every provider reached over the
   * network: their availability is a property of a service the client can reach itself, and this
   * field would have nothing to say about it. A provider that DOES declare one is a process this
   * deployment owns, so "is it up, and which build is it" is answerable here and nowhere else — and
   * `buildId` is the figure that makes a transcript's provenance checkable against the build a
   * deployment believes it is running.
   *
   * `state` is carried as well as `available` because the two are not the same reading for a
   * provider that is merely not started yet: `stopped` is a healthy engine nothing has asked to
   * run, and folding it into the unavailable form would report an idle deployment as a broken one.
   */
  runtime?: AsrRuntimeStatus;
};

/**
 * The answer `GET /api/voice/health` gives: the user's *effective* configuration, not the
 * server's environment.
 *
 * `configured` keeps the position and the meaning its only consumer already reads (
 * `useVoiceAvailable`): whether a recording would reach a recogniser right now. What changed is
 * whose configuration counts — a user who saved their own backend is configured even when the
 * server process has no environment variables set, which is the answer this endpoint gave
 * wrongly before.
 *
 * `provider` is the effective provider id, and `providers` is the whole registered list with
 * each one's capabilities. The list is the registry's, not a copy.
 */
export type VoiceHealth = {
  configured: boolean;
  /** The effective provider id, or the empty string when the registry is empty. */
  provider: string;
  providers: VoiceProviderSummary[];
};

/**
 * Complete application-service surface consumed by the Voice HTTP router.
 *
 * The composition root supplies a concrete implementation with environment
 * configuration and an injected outbound HTTP adapter. Unit tests use the same
 * contract with handwritten fetch fakes and never patch global state.
 */
export type VoiceService = {
  /**
   * Reads the health of the Voice link for one user's stored settings.
   *
   * The settings are an argument rather than something the service fetches, so the route owns
   * the storage lookup and the service stays free of the database. A user whose stored backend
   * is complete is `configured` even when the server has no environment configuration at all.
   *
   * Returns `ok: false` with `UNKNOWN_PROVIDER` when the effective provider id is not one the
   * registry knows: the link is unavailable and naming the id is the only useful answer, since
   * falling back would transcribe with a service the user did not choose.
   */
  getHealth(input: {
    settings: VoiceSettings;
  }): VoiceServiceResult<VoiceHealth>;
  transcribe(input: {
    audio: VoiceAudioUpload;
    overrides: VoiceRequestOverrides;
    /**
     * The user's stored settings, when the caller has them.
     *
     * IT IS AN ARGUMENT FOR THE SAME REASON `getHealth`'s is: which provider is effective, and what
     * a provider that declares credential fields of its own is reached with, are properties of the
     * USER's stored document, and the route owns the storage lookup so the service stays free of the
     * database. Optional because the document is not always at hand — a caller driving this service
     * without a user (a probe, an invariant board, the request path before the lookup) gets the
     * behaviour this path had before these fields existed, which is the deployment's own
     * configuration, and an absent document and an all-empty one are the same reading.
     */
    settings?: VoiceSettings;
    /**
     * The caller's hints for the selected recogniser, when it sent any.
     *
     * THE ONLY HINT THE TRANSPORT CARRIES TODAY IS `context`: the C2 conversation pack the voice
     * relay mode uses to resolve a spoken referent. It is passed through unchanged and the adapter
     * decides whether its own `honors.context` declaration acknowledges it; a provider that does
     * not must leave it off the wire. It is never written to a capture row or a log line.
     */
    hints?: AsrHints;
    /**
     * The pairing id this listen's recording client minted, when it sent one.
     *
     * WHEN PRESENT IT BECOMES A FIELD ON THIS ATTEMPT'S CAPTURE ROW, so the row can be joined with
     * the raw-corpus row (`voice.capture.raw`) of the same listen — see `VoiceCaptureRawInput`. WHEN
     * ABSENT THE ROW HAS NO `listenId` KEY AT ALL, this module's absence-not-placeholder convention,
     * so "not paired" and "paired with nothing" stay distinguishable.
     *
     * It is TRANSPORT TEXT the client chose, so it never reaches a file name: the raw sink builds the
     * file name from it through its own path-safe substitution, and this path only carries it into a
     * log row.
     */
    listenId?: string;
  }): Promise<VoiceServiceResult<{ text: string; recordId?: string }>>;
  synthesizeSpeech(input: {
    text: string;
    overrides: VoiceRequestOverrides;
  }): Promise<VoiceServiceResult<VoiceSpeechPayload>>;
  /**
   * Records one listen's raw (pre-VAD) upload, when this deployment collects raw audio.
   *
   * WHY IT IS ON THIS SERVICE AND NOT A ROUTE'S OWN LOGIC. The recording seam is the capture port the
   * transcription path already holds, and "does this deployment collect raw audio" is that port's own
   * switch (`VoiceCapturePort.raw`). So the route parses the upload and calls here, and the decision
   * to write — and the no-op when the switch is off — lives where the port is. `listenId` is required
   * by the caller: a raw row exists to be paired, so a request without one is refused at the route.
   *
   * `stored` is `false` when the deployment does not collect raw — a truthful "nothing was written"
   * rather than an error, because the route reaching here with the switch off is a client that asked
   * about a capability this deployment does not have, not a malformed request.
   */
  captureRaw(input: {
    listenId: string;
    audio: VoiceAudioUpload;
  }): VoiceServiceResult<{ stored: boolean }>;
  /**
   * Whether this deployment collects raw (pre-VAD) audio, for `GET /api/voice/capture`.
   *
   * A capability reading, not a per-user one: the switch is the deployment's own environment, so a
   * client asks once whether uploading raw audio is meaningful at all before it sends any.
   */
  captureState(): { raw: boolean };
  /**
   * Deletes every voice record this user's data store holds, for `DELETE /api/voice/data`.
   *
   * THE USER-DATA COUNTERPART OF `captureState`, and the other half of the D1 promise: the same
   * setting that makes recordings default-on makes them clearable in one action. The answer is the
   * number of RECORDS removed — not files, so it reads as "how many recordings" rather than
   * double-counting each one's audio — and a deployment or user with no store yet answers `0`
   * rather than failing, because "there is nothing here to clear" is a clear that succeeded.
   *
   * OPTIONAL LIKE THE STORE ITSELF, and for the same reason the deps carry `voiceData?`: the leaf
   * route tests build small `VoiceService` doubles that never clear anything, and a required member
   * would make every one of them a compile error for a behaviour they do not exercise. The shipping
   * service always implements it; a caller that does not reads as a store that held nothing, which
   * is the same answer the empty case gives.
   */
  clearVoiceData?(): { deleted: number };
  /**
   * Writes the text the user actually sent, and the `听到 → 想说` pairs derived from their edit, onto
   * the record the transcription already wrote — for `PATCH /api/voice/data/:recordId`.
   *
   * WHY A PATCH AND NOT A FIELD ON THE TRANSCRIBE REPLY. The correction does not exist when the
   * transcription is answered: the user edits the box afterwards, and may send much later or not at
   * all. The record id returned by `transcribe` is the handle that lets the two moments be joined,
   * and this is the write that closes the loop.
   *
   * A MISS IS THE EXPECTED FAILURE, not an error: the ceiling may have evicted the record, or the
   * user may have cleared their data, between the two moments. `404` is the honest answer to a
   * client that asked about a recording that is no longer there, and the client is expected to treat
   * it as "the label was not kept" rather than as a failed send.
   *
   * OPTIONAL LIKE THE STORE ITSELF: the leaf route tests build small doubles that never store
   * anything, and a caller that wired no store has no records to label — which the route answers as
   * the same `404` a vanished record gets.
   */
  labelVoiceData?(input: {
    recordId: string;
    finalText: string;
    labels: VoiceDataEditLabel[];
  }): VoiceServiceResult<{ recordId: string }>;
};

//----------------- VOICE DATA RECORDS ------------
/**
 * One `heard → final` pair, as it crosses the wire and as it is persisted.
 *
 * DECLARED HERE RATHER THAN ALONGSIDE THE STORE because it is the request body's shape as much as
 * the record's: the route parses a client's array into exactly this, and the store writes exactly
 * this back out. The producing module is `src/shared/voiceEditLabels.ts`, whose `VoiceEditLabel` is
 * this type plus the closed `op` vocabulary; the backend keeps `op` a string deliberately, because a
 * store that re-judged the client's correction/rewrite call would be a second authority on a
 * decision made where the segment text and the box were both in hand.
 */
export type VoiceDataEditLabel = {
  /** The ordinal of the speech segment this pair came from. */
  segmentIndex: number;
  /** What the recogniser produced, spanning whole tokens. */
  heard: string;
  /** What the user left in the box. Empty for a deletion. */
  final: string;
  /** Which kind of change it was — `replace`/`merge`/`split`/`delete`, or `rewrite`. */
  op: string;
};
//----------------- VOICE CLIENT ASSETS ------------

/**
 * One artifact the browser-side recogniser needs, as the server's readiness reading reports it.
 *
 * `bytes` is `null` until the file is there: an absent file has no length, and writing `0` would
 * collapse "missing" and "empty" into the same reading. `expectedBytes` is the pinned length for the
 * one artifact whose size is part of the contract — the 239 MB checkpoint — and `null` for a file
 * the deployment does not size-check.
 */
export type VoiceClientAssetFile = {
  /** The file name as it must appear in the resolved directory. */
  name: string;
  /** Whether a regular file of this name is present in the resolved directory. */
  present: boolean;
  /** The file's length in bytes, or `null` when it is not there. */
  bytes: number | null;
  /** The length this deployment requires, or `null` when the file has no required length. */
  expectedBytes: number | null;
};

/**
 * The server's reading of the on-device recogniser's provisioning, for `GET /api/voice/client-assets`.
 *
 * It exists so a browser can learn that the checkpoint is absent BEFORE it downloads anything: the
 * client path's failure mode is a first recognition that fetches a quarter of a gigabyte and then
 * cannot run it, and this reading turns that into a sentence naming the file and the directory.
 * `configured` is about the DIRECTORY VARIABLE, `source` names which one supplied the directory, and
 * `ready` is about the FILES inside it — so "no directory at all" and "a directory missing a file"
 * stay distinguishable to whoever has to fix it.
 */
export type VoiceClientAssetsReading = {
  /** Whether a directory variable supplied a directory at all. */
  configured: boolean;
  /** The resolved directory, or `null` when neither variable is set. */
  directory: string | null;
  /** Which variable supplied the directory, or `null` when none did. */
  source: 'VOICE_CLIENT_MODEL_DIR' | 'SENSEVOICE_MODEL_DIR' | null;
  /** The checkpoint's reading. */
  model: VoiceClientAssetFile;
  /** The token list's reading. */
  tokens: VoiceClientAssetFile;
  /** Whether this deployment can serve a browser-side recogniser right now. */
  ready: boolean;
};

/** A servable artifact: the path the route streams, and the number of bytes it holds. */
export type VoiceClientAssetFileRef = {
  path: string;
  size: number;
};

/**
 * The application-service surface behind the client-asset routes.
 *
 * ONE SERVICE FOR THE READING AND THE BYTES, because both are answered from one resolved directory:
 * the readiness route reports what `readiness()` reads, and the two serving routes stream what
 * `resolveModelFile`/`resolveOrtFile` whitelist. Both resolvers answer `null` for a name that is not
 * one of the pinned artifacts, which is what turns directory traversal into a plain 404 instead of a
 * path some later layer would have to sanitise.
 */
export type VoiceClientAssetsService = {
  /** The provisioning reading the authenticated readiness route republishes. */
  readiness(): VoiceClientAssetsReading;
  /** The model directory's file of this name, or `null` when it is not one of the two whitelisted. */
  resolveModelFile(name: string): VoiceClientAssetFileRef | null;
  /** The runtime distribution's file of this name, or `null` when it is not whitelisted. */
  resolveOrtFile(name: string): VoiceClientAssetFileRef | null;
};

// ---------------------------

/**
 * The persistence contract the Voice settings service writes through.
 *
 * Declared as a narrow port rather than imported from the database module so the
 * service can be unit-tested with an in-memory fake, and so the Voice module
 * keeps talking to the database through its public barrel only. The database
 * module's `voiceSettingsDb` is the production implementation.
 */
export type VoiceSettingsStore = {
  getSettings(userId: number): VoiceSettings;
  saveSettings(userId: number, settings: VoiceSettings): void;
};

/**
 * Application-service surface consumed by the Voice settings routes.
 *
 * Kept separate from `VoiceService` because it is a different concern with a
 * different dependency (a settings store rather than an outbound HTTP adapter),
 * and because the transcription service is constructed once at start-up with
 * environment defaults while this one only ever acts on a named user.
 */
export type VoiceSettingsService = {
  /**
   * Reads the authenticated user's stored settings, or the all-empty set when
   * they have never saved any. Synchronous because the store is a local SQLite
   * read on the request path, not a network call.
   */
  getSettings(userId: number): VoiceSettings;
  /**
   * Validates and stores a complete settings document, replacing what was
   * there. Returns `ok: false, status: 400` when a field is the wrong type, too
   * long, or names a backend URL the browser could not call directly — and when a
   * provider-declared endpoint field names an address that provider's own rule does not accept.
   */
  saveSettings(userId: number, input: unknown): VoiceServiceResult<VoiceSettings>;
  /**
   * The same document as it may be sent back over HTTP: every field a provider has declared as ITS
   * OWN credential is replaced by a mask, and every other field is returned verbatim.
   *
   * WHY IT IS A SEPARATE METHOD RATHER THAN WHAT `getSettings` RETURNS. The two readers want
   * opposite things. `getSettings` is the STORAGE face: the route's own health reading and the
   * transcription path have to see the credential as it will be presented upstream, so a masked
   * document there would authenticate with `••••`. `maskForReadback` is the READBACK face, applied
   * at the HTTP boundary and nowhere else, and the split is what makes "the mask exists" and "the
   * wire still carries the plaintext" two readings of one document rather than a contradiction.
   *
   * Which fields are masked is read off the registry's declarations, never off a list here: a
   * provider that declares `credentials.apiKeyField` gets that field masked, a provider that
   * declares nothing (the browser's own backend, whose `apiKey` the client must keep) is untouched.
   * The field is DECLARED by the provider and the mask is applied by this method — that is what
   * keeps one provider's secret from being handled by a rule written for another's.
   */
  maskForReadback(settings: VoiceSettings): VoiceSettings;
};

/**
 * Where one transcription attempt's structured reading goes.
 *
 * WHY A PORT AND NOT `console`. Two reasons, and both are readings rather than taste. A port can be
 * collected by a caller, which is the only way "this line does not contain the key" is checkable at
 * all — against the global console it is a claim about a stream no test can hold. And the process's
 * console is not one writer's to replace: patching `console.log` to intercept one service's lines
 * changes the output of every other module in the process for the duration.
 *
 * The default is resolved INSIDE `createVoiceService` (the injected port wins; `console` is the
 * fallback), so the composition root that wires the service to the process's real output does not
 * have to name this type or pass anything — which is also why the production wiring is unchanged by
 * the seam's existence.
 */
export type VoiceLogPort = {
  info(message: string): void;
  /**
   * Where a failure goes, when the deployment's port keeps the distinction.
   *
   * OPTIONAL, and the optionality is the point rather than an oversight. This port is implemented by
   * `console` and by three test doubles that build a literal with an `info` and stop there; a
   * REQUIRED `warn` would make every one of them incomplete for the sake of a severity one provider
   * prefers. What must not be optional is that the sentence SURVIVES — so a consumer that has a
   * failure to report routes it here when the port keeps a `warn` and through `info` when it does
   * not (`sensevoice-worker.ts`'s own log adapter is the one that does), and no deployment loses a
   * line because its port was written before this field existed.
   */
  warn?(message: string): void;
};

// ---------------------------
//----------------- VOICE USER-IDENTIFIER LEXICON ------------

/**
 * One stored frequency row of the U-source lexicon.
 *
 * `tokenLower` is the lookup key (`canonical` lowercased) and `canonical` is the
 * spelling first seen — the pair is what lets `CloudCLI` and `cloudcli` be one
 * token that still displays a real casing. `firstSeenAt` / `lastSeenAt` are epoch
 * milliseconds supplied by the service's clock, not `CURRENT_TIMESTAMP`, so a
 * caller can pin them. `projectKey` is the path the message was sent from, which
 * scopes the row; the listing sums across projects.
 */
export type VoiceIdentifierRow = {
  tokenLower: string;
  canonical: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  projectKey: string;
};

/**
 * One occurrence to add on the send path: which token, in which project, when.
 *
 * `at` is the epoch-millisecond instant the message was sent. It is carried per
 * entry rather than read from the clock inside the store, so the store stays a
 * pure writer and a criterion can deposit a row at a known instant.
 */
export type VoiceIdentifierIncrement = {
  tokenLower: string;
  canonical: string;
  projectKey: string;
  at: number;
};

/**
 * One row of the lexicon listing: a token, its summed frequency, and when it was
 * last seen. Deliberately carries no sentence and no message id — the API this
 * shape serves returns frequencies, and a field that could hold text is the one
 * thing that must never appear here.
 */
export type VoiceIdentifierListItem = {
  token: string;
  count: number;
  lastSeenAt: number;
};

/**
 * The persistence contract the lexicon service writes through.
 *
 * Declared as a narrow port rather than imported from the database module so the
 * service can be unit-tested with an in-memory fake, and so the Voice module
 * keeps talking to the database through its public barrel only. The database
 * module's `voiceUserIdentifiersDb` is the production implementation.
 */
export type VoiceIdentifierStore = {
  /** Adds one occurrence of each entry's token, creating rows on first sight. */
  incrementTokens(entries: VoiceIdentifierIncrement[]): void;
  /** Replaces the whole table with the derived rows; import's recompute write. */
  replaceAll(entries: VoiceIdentifierRow[]): void;
  /** The most frequent tokens, most frequent first, summed across projects. */
  listTop(limit: number): VoiceIdentifierListItem[];
  /** Empties the lexicon. */
  clear(): void;
  /** How many rows the table holds. */
  countRows(): number;
};

/**
 * One human-written message offered to the cold-start import.
 *
 * `id` is the message's stable identity (its app session id joined with the
 * provider's own message id), used to count a message once even when two reads
 * of the history return it. `projectKey` is the session's project path. `text` is
 * the raw message body — the import applies the same shape, prompt and credential
 * rules the live path does before any token is stored. `at` is the
 * epoch-millisecond timestamp when the transcript carries one.
 */
export type VoiceHumanMessage = {
  id: string;
  projectKey: string;
  text: string;
  at?: number;
};

/**
 * Application-service surface consumed by the Voice lexicon routes and by the
 * automatic recording hook the chat dispatch calls.
 *
 * Kept separate from `VoiceService` because it is a different concern with a
 * different dependency (a token store and a history source rather than an
 * outbound HTTP adapter), and because the recording hook is called on the send
 * path while the read/import surface is called on the request path.
 */
export type VoiceLexiconService = {
  /**
   * Records the identifier-shaped tokens of one message the user just sent.
   *
   * Credential-style messages and injected prompts contribute nothing — the same
   * rules the import applies, so a token can never enter through the live path
   * that the offline path would have refused.
   */
  observeSentText(text: string, projectKey: string): void;
  /**
   * Recomputes the lexicon from the whole indexed history: a cold start that
   * makes the first day usable. Idempotent — it replaces the table with the
   * derived rows, so running it twice leaves the same counts.
   */
  importFromHistory(): Promise<{ importedMessages: number; tokenCount: number }>;
  /** The most frequent tokens, most frequent first, capped at `limit`. */
  list(limit: number): VoiceIdentifierListItem[];
  /** Empties the lexicon. */
  clear(): void;
};

// ---------------------------
//----------------- CLI MODULE CONTRACTS ------------
/**
 * Output boundary used by the CLI and Sandbox services.
 *
 * Production wiring delegates to the real console. Unit tests collect these
 * calls in arrays, which keeps command assertions deterministic and avoids
 * monkey-patching the global console singleton.
 */
export type CliOutput = {
  log(message?: string): void;
  error(message?: string): void;
};

/**
 * Minimal synchronous filesystem surface shared by CLI status reporting and
 * sandbox workspace validation.
 *
 * The production composition root adapts Node's filesystem module. Tests supply
 * path-keyed fakes, so service tests never inspect or modify the real machine.
 */
export type CliFileSystem = {
  pathExists(filePath: string): boolean;
  getFileStats(filePath: string): { size: number; modifiedAt: Date };
};

/**
 * Mutable environment view owned by the CLI application.
 *
 * CLI options update this object before the server starts. Production passes
 * `process.env`; tests pass a plain record to verify option precedence without
 * changing process-wide environment state.
 */
export type CliEnvironment = Record<string, string | undefined>;

/**
 * Package metadata displayed by CLI help, status, version, and update commands.
 *
 * The composition root reads this once from the application package file and
 * injects only the fields the service needs.
 */
export type CliPackageMetadata = {
  version: string;
  homepage?: string;
  bugsUrl?: string;
};

/**
 * Executable CLI application returned by the CLI composition root.
 *
 * The thin executable entrypoint passes `process.argv` arguments to `run` and
 * copies the returned code to `process.exitCode`. Tests invoke the same method
 * directly with isolated dependencies.
 */
export type CliApplication = {
  run(argumentsList: string[]): Promise<number>;
};

/**
 * Sandbox command service consumed by the top-level CLI command dispatcher.
 *
 * Keeping this behind one required dependency lets CLI tests use a tiny fake,
 * while focused Sandbox tests exercise subprocess and filesystem behavior with
 * their own handwritten adapters.
 */
export type SandboxCommandService = {
  execute(argumentsList: string[]): Promise<number>;
};

// ---------------------------
//----------------- LAUNCH SPEC ------------

/**
 * Compiled launch configuration returned by the model-launch-spec compiler.
 *
 * Consumed by the Claude SDK runtime and the shell websocket service, which
 * merge `env` over the host environment when spawning a provider process.
 * With no configured model selected (passthrough) `env` is `{}` and `argv` is
 * `[]`, so callers' env assembly stays byte-identical to the pre-model-library
 * behavior. `env` must only hold overrides, never a copy of `process.env`.
 * `unsetEnv` lists keys that must be REMOVED from the final spawn environment
 * (a model-library `unset` row); callers must apply it with
 * `applyLaunchSpecEnv` so the removal lands on the object handed to the
 * spawn, not merely on the spec. Absent for passthrough specs.
 */
export type ResolvedLaunchSpec = {
  env: Record<string, string>;
  unsetEnv?: string[];
  argv: string[];
  contextWindow: number;
  warnings: string[];
};

// ---------------------------
//----------------- SESSION HOST LIFECYCLE TYPES ------------
/**
 * How long one host process is meant to live.
 *
 * `per-run` is the default for every provider: the process exists for exactly
 * one turn, so the application has no handle on it between turns. `resident`
 * is the Claude-only mode in which one process serves many turns, which is what
 * `HostLease` records are for.
 */
export type HostMode = 'per-run' | 'resident';

/**
 * State of one `ProcessHost`.
 *
 * `busy` and `lingering` are the two states the default per-run wrapper can
 * reach on its own: `busy` while the turn's `turn` lease is held, and
 * `lingering` once that lease is gone but the run's promise has still not
 * settled (Claude's held-stdin window, made observable for the first time).
 * `starting`, `idle` and `closing` are reached only by a provider that owns its
 * process lifetime through a host driver, so no default-wrapped provider ever
 * reports them.
 */
export type HostState = 'starting' | 'idle' | 'busy' | 'lingering' | 'closing' | 'closed';

/**
 * Why a host process or one of its session bindings ended.
 *
 * One enum covers both `ProcessHost.closeReason` and
 * `SessionBinding.detachReason` so a client renders a single vocabulary instead
 * of two provider-shaped ones. Only `turn-complete`, `aborted` and `released`
 * are produced by the default per-run wrapper; the remaining members are named
 * here because the state machine they document is shared with the resident mode
 * and with providers that implement a host driver.
 */
export type HostCloseReason =
  /** The turn ended and nothing else kept the host alive. */
  | 'turn-complete'
  /** A held host was let go — the background work reported back or the hold hit its ceiling. */
  | 'released'
  /** A newer turn replaced the host a previous turn was still holding. */
  | 'superseded'
  /** The user stopped the turn; for a per-run host that means the process dies. */
  | 'aborted'
  /** The user closed the host, or deleted/archived the session it served. */
  | 'user'
  /** A resident host hit its inactivity ceiling. */
  | 'idle'
  /** The session changed between per-run and resident. */
  | 'mode-change'
  /** An edited message forced the conversation to restart from a truncation point. */
  | 'rewind'
  /** The process exited on its own or crashed. */
  | 'exited'
  /** The server shut down normally. */
  | 'server-shutdown';

/**
 * Every member of `HostCloseReason`, as a runtime value.
 *
 * The union above is the contract; this array is the same list in a form a
 * program can iterate, so "which reasons exist" is one fact rather than two
 * lists that can drift apart. It is a shared definition because it has two
 * consumers that must agree: the session-host manager derives its close
 * decisions from reasons named here, and the lifecycle criterion asserts that
 * every value in this array was actually produced by some case — an enumeration
 * test that read its own literal list could pass while the union changed under
 * it. Keep the two in the same order, and add a member to both at once.
 */
export const HOST_CLOSE_REASONS = [
  'turn-complete',
  'released',
  'superseded',
  'aborted',
  'user',
  'idle',
  'mode-change',
  'rewind',
  'exited',
  'server-shutdown',
] as const satisfies readonly HostCloseReason[];

/**
 * The extra fact some close reasons carry.
 *
 * `ProcessHost.closeReason` says why a host ended; for two reasons that answer
 * is incomplete and this names the rest. `exited` distinguishes a process the
 * kernel killed for memory from one that died on a signal or failed on its own
 * — the three the runtime can report. `forced` is not a driver report at all:
 * it records that the server shut down while the driver had still not settled
 * its `closeHost`, so the host was closed out from under it. A null
 * `closeDetail` means the reason needs no detail (`turn-complete`, `user`, …).
 */
export type HostCloseDetail = 'oom' | 'signal' | 'error' | 'forced';

/**
 * The two knobs that decide when a host is closed, one set per lifecycle mode.
 *
 * Read by the session-host manager each time it recomputes state, so a policy is
 * data rather than a branch on `mode`: `per-run` and `resident` differ only in
 * the values below, which is what makes either mode testable by injecting a
 * policy instead of a provider. The values themselves mirror
 * `docs/proposals/claude-resident-sessions.md` §3.
 */
export type LifecyclePolicy = {
  /** A new turn on the same bound session closes the host the previous turn held. */
  supersedeOnNewTurn: boolean;
  /** Close the host as soon as the union of its bindings' leases is empty. */
  closeWhenLeasesEmpty: boolean;
  /**
   * How long a host with no `turn` lease — `lingering` under `per-run`, `idle`
   * under `resident` — may sit before the quiet ceiling closes it. The window is
   * counted from the binding's `lastActivityAt`, not from the last frame.
   */
  quietCeilingMs: number;
};

/**
 * One reason a bound session still needs its host process.
 *
 * The host is kept alive while the union of its bindings' leases is non-empty,
 * so leases — not the process — are what the close decision is computed from. A
 * `turn` lease is held for the duration of one run; the others record work that
 * outlives the turn that started it, which is what makes a host `lingering`
 * rather than `closed`.
 *
 * `inferred` marks the two held-work reasons whose *identity* a driver may have
 * had to guess. A cron and a background task are normally named twice: by the
 * `Stop` hook's own lists, which are the CLI's authoritative account of what it
 * holds, and by the events the same work emits on the stream. When the first is
 * unavailable — an older CLI, a hook that never fired — a driver can still read
 * the second and hold the host for it, but the entry it names is its own reading
 * rather than the CLI's; that is what this flag says, and its absence is the
 * authoritative case (an omitted flag means "the CLI named this"). It is
 * deliberately optional so a lease written before this distinction existed still
 * satisfies the type, and it is confined to the two kinds a stream can describe,
 * because `turn` and `resident-policy` are never inferred from anything.
 *
 * `since` is when the manager recorded the lease — the instant the hold began,
 * which is the only fact a reader needs to report how long the work has been
 * outstanding. It is written by `addLease`, not by the driver that reports the
 * lease: a driver states *that* it is holding work for an id and has no reason
 * to know when the manager started counting, while the manager is the one place
 * every lease passes through. Optional here so a driver's own request type keeps
 * compiling; the listing projection fills it for both members, so a client
 * always reads a number. `cron` carries its own schedule (`expiresAt`) and is
 * deliberately not given one.
 */
export type HostLease =
  | { kind: 'turn'; runId: string }
  | { kind: 'background-task' | 'monitor'; id: string; since?: number; inferred?: boolean }
  | { kind: 'cron'; id: string; recurring: boolean; expiresAt: number; inferred?: boolean }
  | { kind: 'resident-policy' };

/**
 * One application session running inside one host process.
 *
 * Hosts are 1:N with sessions: a per-run host always carries exactly one
 * binding, while a multiplexing process (Codex `app-server`, `opencode serve`)
 * carries one per conversation. `providerSessionId` is filled in from the
 * runtime's own session-id announcement when the provider reports one, so a
 * binding is the join point between the app id and the provider-native id.
 */
export type SessionBinding = {
  appSessionId: string;
  providerSessionId: string | null;
  state: 'idle' | 'busy';
  leases: HostLease[];
  lastActivityAt: number;
  /**
   * The SendMessage address this binding's process answers to, when it has one.
   *
   * Reported by the driver once the process has registered the name with its own
   * tooling and the driver has read that registration back — never computed and
   * assumed here, because the name a process answers to is a fact about the
   * process's own peer registry rather than about the string some caller chose.
   * `null` means "not addressable": the mode has no stable address at all, the
   * process never registered one, or what it registered is not what the naming
   * rule asked for. Fixed for the process's lifetime — a title change does not
   * move it — and belongs to the binding rather than to the host because it is
   * per-conversation, like every other fact on this record.
   */
  peerName: string | null;
  /** Set when the binding was detached; mirrors the host's `closeReason` for that binding. */
  detachReason: HostCloseReason | null;
};

/**
 * Why a bind request was refused.
 *
 * Three refusals, and they are different failures: `session-already-bound` says
 * the session is already somewhere (the request may have named a second host,
 * but the session is not free), while `host-not-multiplexed` says the session is
 * free and the *process* is what cannot take it — a host whose driver did not
 * declare `multiplexedHost` carries one conversation and no more. Named here
 * rather than thrown as a message because the manager's caller has to branch on
 * which refusal it got, and a branch on prose is a branch that breaks silently.
 *
 * `remote-control-enabled` is a refusal about a *launch* rather than about a
 * placement, and it is named in this same vocabulary on purpose: what the caller
 * has to branch on is identical — "you did not get a host, and here is the kind
 * of no it was" — and a second vocabulary for the same branch would be two lists
 * to keep in step. The one it names is the Remote Control gate: the user's own
 * settings have Remote Control on, so a resident process launched under
 * `bypassPermissions` would be reachable from another machine's peer sessions and
 * the trust boundary would leave the Unix user. The gate refuses instead of
 * launching (see the Claude resident driver's Remote Control section).
 */
export type HostBindErrorCode = 'session-already-bound' | 'host-not-multiplexed' | 'remote-control-enabled';

/**
 * Every member of `HostBindErrorCode`, as a runtime value.
 *
 * Same contract as `HOST_CLOSE_REASONS`: the union is the definition and this
 * array is the same list in a form a program can iterate, so a criterion that
 * wants to prove each refusal is reachable reads the list the manager is typed
 * against instead of a literal typed a second time. Keep the two in the same
 * order, and add a member to both at once.
 */
export const HOST_BIND_ERROR_CODES = [
  'session-already-bound',
  'host-not-multiplexed',
  'remote-control-enabled',
] as const satisfies readonly HostBindErrorCode[];

/**
 * Why a lifecycle-mode read or write was refused.
 *
 * One vocabulary for two surfaces that answer about the same two facts — which
 * mode a session is stored under, and whether a process is running for it — so
 * a client can tell the refusals apart without reading prose. The members are
 * deliberately all distinct: "you asked for a mode this provider's driver does
 * not implement" (`LIFECYCLE_MODE_NOT_SUPPORTED`) and "you asked for a mode that
 * does not exist" (`LIFECYCLE_MODE_UNKNOWN`) are different mistakes with
 * different fixes, and a client that had to branch on a message would conflate
 * them the first time one was reworded.
 *
 * `SESSION_NOT_FOUND` and `SESSION_HOST_NOT_FOUND` are the two ways "there is
 * nothing to act on" splits: the first says no session row exists, the second
 * says the session exists and no live process is serving it. The close route
 * needs both because they lead a client to different repair — create/refresh the
 * session versus start the host — and `LIFECYCLE_MODE_NOT_RESIDENT` sits beside
 * them as the third answer, which is that there *is* something there and the
 * action is not allowed on it.
 */
export type LifecycleModeErrorCode =
  /** The requested mode is not one the application knows. */
  | 'LIFECYCLE_MODE_UNKNOWN'
  /** The provider's capability matrix does not list the requested mode. */
  | 'LIFECYCLE_MODE_NOT_SUPPORTED'
  /** The verb is only available to a resident session, and this one is not. */
  | 'LIFECYCLE_MODE_NOT_RESIDENT'
  /** The session is resident but its provider mounts no host driver to start. */
  | 'LIFECYCLE_MODE_HOST_UNAVAILABLE'
  /** The host serving the session is mid-turn, so the mode cannot change under it. */
  | 'LIFECYCLE_MODE_HOST_BUSY'
  /** No session row exists under the given id. */
  | 'SESSION_NOT_FOUND'
  /** The session exists but no live host is serving it. */
  | 'SESSION_HOST_NOT_FOUND';

/**
 * Every member of `LifecycleModeErrorCode`, as a runtime value.
 *
 * Same contract as `HOST_CLOSE_REASONS` and `HOST_BIND_ERROR_CODES`: the union
 * is the definition and this array is the same list in a form a program can
 * iterate. The criterion that has to show three refusals are mutually
 * distinguishable reads this list rather than a literal typed a second time, so
 * a reader can see that "distinct" is a property of the vocabulary and not of
 * the three values the case happened to produce. Keep the two in the same order,
 * and add a member to both at once.
 */
export const LIFECYCLE_MODE_ERROR_CODES = [
  'LIFECYCLE_MODE_UNKNOWN',
  'LIFECYCLE_MODE_NOT_SUPPORTED',
  'LIFECYCLE_MODE_NOT_RESIDENT',
  'LIFECYCLE_MODE_HOST_UNAVAILABLE',
  'LIFECYCLE_MODE_HOST_BUSY',
  'SESSION_NOT_FOUND',
  'SESSION_HOST_NOT_FOUND',
] as const satisfies readonly LifecycleModeErrorCode[];

/**
 * The outcome of one `bindSession` request.
 *
 * A discriminated union rather than a thrown error because a refusal is an
 * ordinary answer to a race — two turns arriving for one session is normal
 * traffic, not a fault — and because the caller needs the refusal's identity,
 * not just its message.
 *
 * `existingHostId` is the load-bearing half of a refusal: for
 * `session-already-bound` it names the host that already holds the session
 * (which is *not* necessarily the host the request was aimed at, and naming the
 * aimed-at host instead would hide the conflict); for `host-not-multiplexed` it
 * names the live host that could not take a second binding. Null only when a
 * refusal has no host to point at.
 */
export type HostBindResult =
  | { ok: true; hostId: string }
  | { ok: false; code: HostBindErrorCode; existingHostId: string | null };

/**
 * What one host has to say about the Remote Control gate it launched under.
 *
 * The three halves are three different facts and are deliberately not one
 * object's fields: `requested` is what *this* build asked the SDK for,
 * `detected` is what the user's own settings file said when the gate read it,
 * and `launched` is the `settings` object the SDK query was really handed.
 *
 * `detected` is the reading the refusal is decided on, and it is a *reading of a
 * file*, not an effective value: `null` means the key was absent (or the file
 * was not there, or was not parseable) and is distinct from `false`. There is
 * deliberately no member here that claims to say whether Remote Control is off
 * on the running process — the experiment that would have measured it (E9 §9.7)
 * got no `get_settings` answer at all, so a field named for an "effective" value
 * would be asserting something this build cannot read. A criterion therefore
 * reads these fields against the file it wrote, never against a claim about what
 * the CLI did with the flag.
 *
 * `launched` is `null` for a host whose process factory does not report one (a
 * substituted factory in a criterion), and its two members are `boolean |
 * undefined` for the same reason `detected`'s are `boolean | null`: a launch
 * that did not state a key is not a launch that stated `false`.
 */
export type RemoteControlIsolation = {
  /** What this host asked the SDK's `settings` to carry, verbatim. */
  requested: { remoteControlAtStartup: boolean; isolatePeerMachines: boolean };
  /** What the user-level settings file said, key by key; `null` = not stated. */
  detected: { remoteControlAtStartup: boolean | null; isolatePeerMachines: boolean | null };
  /** The settings file the reading above came from, verbatim. */
  settingsPath: string;
  /** The `settings` object the SDK query was handed, as it was handed over. */
  launched: { remoteControlAtStartup?: boolean; isolatePeerMachines?: boolean } | null;
};

/**
 * One process the session-host layer knows about, in any lifecycle mode.
 *
 * `pid` is deliberately nullable: a runtime driven through the default per-run
 * wrapper never reports its child's pid, and the layer records the truth
 * (`null`) rather than inventing one. Filling it in is the job of a provider
 * that owns its process through a host driver.
 */
export type ProcessHost = {
  hostId: string;
  provider: LLMProvider;
  mode: HostMode;
  state: HostState;
  pid: number | null;
  startedAt: number;
  /** Keyed by application session id; see `SessionBinding`. */
  bindings: Map<string, SessionBinding>;
  closeReason: HostCloseReason | null;
  /**
   * The extra fact `closeReason` carries, or null when it carries none.
   *
   * Set together with `closeReason` and never before it: a host that is still
   * open has null here, and `'forced'` appears only on a host the server closed
   * during shutdown while its driver was still settling. Optional so a reader
   * written against the reason alone keeps type-checking.
   */
  closeDetail?: HostCloseDetail | null;
  /**
   * When the quiet ceiling is due to close this host, on the manager's clock.
   *
   * Exposed because the deadline is the only evidence that a host with no
   * `turn` lease is being *held* rather than merely not yet collected — the
   * lifecycle criterion prints it instead of waiting for it. Null while none is
   * armed (a `turn` lease is held, or the host is closed).
   */
  quietDeadlineAt?: number | null;
  /**
   * The instant `quietDeadlineAt` was counted from: `lastActivityAt`, or — after
   * a re-time — the `expiresAt` of the cron lease that pushed the deadline out.
   */
  quietWindowStartAt?: number | null;
  /**
   * What the launch of this host stated and read about Remote Control, when its
   * driver has anything to say about it.
   *
   * Optional and null-for-silent because only a driver that runs a launch gate
   * can answer — every other host (a per-run turn, a provider whose driver never
   * read the user's settings) has nothing here rather than a record of zeroes.
   * Written by the resident driver while `openHost` is still opening the host and
   * deep-copied by the snapshot, so a reader of `snapshot()` sees the same object
   * a reader of the live record does (see `RemoteControlIsolation`).
   */
  remoteControl?: RemoteControlIsolation | null;
};

/**
 * One turn handed to a host driver.
 *
 * Mirrors the command plus run options the application already passes to
 * `IProviderRuntime.run`, so a driver receives the same inputs the default
 * wrapper forwards to the runtime it replaces.
 */
export type HostTurnInput = {
  command: string;
  options: AnyRecord;
};

/**
 * What a driver needs to open one session's own process with no turn behind it.
 *
 * A cold start on demand has no turn to carry these, and they cannot be derived
 * by the session-host layer: the launch options are the ones the session's *next*
 * turn would have carried (`cwd`/`projectPath` off the session row, the stored
 * model/effort/permissionMode), and the context is the provider-scoped lookup bag
 * a runtime is normally handed for one run. Both are assembled by the caller that
 * owns those sources — the providers layer — and passed in whole, because the
 * host layer's boundary is to read no session row of its own and to import no
 * provider registry (see the `HostDriverResolver` reasoning in
 * `session-hosts.routes.ts`).
 *
 * Separate from {@link HostTurnInput} deliberately rather than reusing it with an
 * empty `command`: a turn's options describe work the client asked for, these
 * describe the process that work will land in, and a driver that read one as the
 * other would write a turn nobody sent.
 */
export type HostResidentLaunch = {
  /** The options the session's next turn would launch under; assembled by the caller. */
  options: AnyRecord;
  /** The provider-scoped lookups (session-id mapping, model catalogue) the launch needs. */
  context: ProviderRuntimeContext;
};

/**
 * What a driver answers when asked to open a session's own resident process.
 *
 * `pid` is nullable for the same reason {@link ProcessHost.pid} is: a driver that
 * cannot read its child's pid records the truth rather than a stand-in. `hostId`
 * is the manager's record id, which is what a client addresses the process by —
 * it is answered rather than assumed because the manager, not the driver, decides
 * it, and a driver that already had a live host for the session returns *that*
 * host's id rather than opening a second process.
 */
export type HostResidentStartResult = {
  hostId: string;
  pid: number | null;
};

/**
 * One live setting change for a host that is already running.
 *
 * Only the three settings a resident provider can change without restarting its
 * process are modelled; anything else is a new turn's option. Applied through
 * `IProviderHostDriver.reconfigure`, which reports whether the change took
 * effect immediately or was deferred to the next turn.
 */
export type HostReconfigurePatch = {
  model?: string;
  effort?: string;
  permissionMode?: string;
};

// ---------------------------
//----------------- CHAT RUN ORIGIN + NON-UNION CAPABILITIES ------------
/**
 * Who asked for one provider run.
 *
 * `user` is a turn a human sent from a client; `scheduled` is one a timer
 * fired (the scheduled-messages dispatcher); `unattended` is one the
 * session-host layer opened by itself, with no request and no socket behind
 * it. The fact is recorded on the run rather than inferred later from the
 * absence of a connection, because "no connection" is equally true of a
 * scheduled run — and a run opened by a host driver must be distinguishable
 * from both.
 *
 * `mcp` is one the MCP gateway opened on a tool call. It too has no socket
 * behind it, so it shares the no-connection shape with `scheduled` and
 * `unattended`: which of the three a run is has to come from this recorded
 * value, never from whether a connection happens to be attached.
 *
 * `voice` is one the Live Voice relay opened when a spoken sentence settled. It
 * reaches the control service through the MCP gateway's own `session_send`
 * builder, but it is deliberately NOT `mcp`: a spoken delivery is not a command
 * a person can withdraw, and the activity channel's clients read this value to
 * decide whether a delivery row is theirs to draw (see `src/shared/types.ts`'s
 * `ActivityDeliverySource`). Keeping it a distinct member is what lets a voice
 * delivery reach the transcript without becoming a pending command row.
 *
 * Read by `chatRunRegistry` (which stamps it at `startRun` and exposes it on
 * the run record) and by the debug agent's host-driver criterion.
 */
export type ChatRunSource = 'user' | 'scheduled' | 'unattended' | 'mcp' | 'voice';

/**
 * What made a provider CLI open a turn nobody pushed.
 *
 * A resident process whose own background work finishes starts a turn of its
 * own, and that turn is not evidence of a user: the process was already running
 * and the host pushed nothing. The reason it exists is not in the request — the
 * CLI sends none — so it has to be reconciled from what the turn left behind,
 * which for this build is the `Stop` hook's own task list.
 *
 * `background-task` is a background task reporting back, `session-cron` is a
 * scheduled prompt firing, and `non-user` is the path where no list is readable
 * at all: the honest reading there is that the turn is unexplained, not that it
 * has a reason this code could not name.
 *
 * `cross-session-message` is the fourth reason and the one the task list cannot
 * explain: a peer session addressed this process and the message itself is what
 * opened the turn, so the process was holding nothing of its own at the time.
 * The CLI states that fact on the turn's own `result` (the message's origin),
 * which is why the trigger for this reason is read at the turn's end rather than
 * at its opener — see `finishUnattendedTurn` in the resident driver.
 */
export type BackgroundWorkTrigger = 'background-task' | 'session-cron' | 'non-user' | 'cross-session-message';

/**
 * What a provider's resident process can do, beyond merely being long-lived.
 *
 * One field per fact the frontend would otherwise have to branch on the provider
 * id to learn — the same reason `permissionModes` and `supportsImages` live in
 * the capability matrix. Every entry is an observation about the provider's CLI
 * rather than a design intention, so a field whose experiment has not been run
 * states `false` (or an empty list) rather than the value the author expects:
 * `authoritativeLeases` is still "nothing verified", and a matrix that guessed
 * would make the frontend promise a feature no driver implements.
 *
 * Only meaningful for a provider whose `lifecycleModes` includes `resident`, and
 * absent for one that has no resident mode at all — the same conditional shape
 * as `IProvider.hostDriver`.
 */
export type ResidentFeatures = {
  /** Stopping the current turn leaves the process running (so the next turn is warm). */
  interruptKeepsProcess: boolean;
  /** Settings that can be changed on a running process without restarting it, verified live. */
  liveReconfigure: Array<'model' | 'effort' | 'permissionMode'>;
  /** Turns the provider can run with no client attached (cron, wakeup, cross-session message). */
  unattendedTurns: boolean;
  /** The process has a stable address another session can send a message to. */
  addressable: boolean;
  /** Input sent while a turn is in flight reaches the process rather than being refused. */
  inputWhileBusy: boolean;
  /** Input that has not yet been dequeued can be withdrawn. */
  cancelQueuedInput: boolean;
  /**
   * A running *foreground* tool can be promoted to a background task without
   * ending the turn or the process (the SDK's `Query.backgroundTasks`).
   *
   * Unmeasured against a live resident process, so it states `false` — the same
   * conservative default `authoritativeLeases` takes. The
   * value is what the background-task control plane reads before it reaches any
   * driver: a `false` is answered `unsupported` rather than risking a verb the
   * resident control channel has not been shown to carry.
   */
  backgroundTasks: boolean;
  /** The reasons keeping the process alive come from the CLI's own events, not from inference. */
  authoritativeLeases: boolean;
  /** Reserved: reachability through the provider's own remote-control bridge. */
  remoteControl: boolean;
};

/**
 * Lifecycle facts a provider states about itself at runtime.
 *
 * Deliberately keyed by a plain provider id string rather than by
 * `LLMProvider`: the providers this describes include ones intentionally kept
 * outside that union (the debug agent), and widening the union to hold them
 * would make every exhaustive `Record<LLMProvider, …>` in the codebase claim
 * support for a provider that has no CLI, no SDK and no user-facing entry.
 * Declared through `providerCapabilitiesService.declareRuntimeProviderCapabilities`
 * and read through `getRuntimeProviderCapabilities`.
 */
export type RuntimeProviderCapabilities = {
  provider: string;
  /** Lifecycle modes this provider's host driver implements. */
  lifecycleModes: HostMode[];
  /**
   * Whether one process of this provider may serve several sessions at once —
   * `IProviderHostDriver.multiplexedHost` stated as a standalone fact, so it
   * can be read without an instance of the driver.
   */
  multiplexedHost: boolean;
  /**
   * What the provider's resident process can do, when it has one.
   *
   * Optional so a declaration written before this field existed stays valid —
   * the debug agent's declaration states only the two lifecycle facts above, and
   * "no declaration" is the honest reading of a provider that never claimed any
   * of these capabilities.
   */
  residentFeatures?: ResidentFeatures;
};

// ---------------------------
//--------------- BUSY INPUT: PRIORITY, LIFECYCLE, WITHDRAWAL ----------
/**
 * The tier a user message is written into the CLI's own command queue under.
 *
 * The CLI holds its own queue and the host writes into it rather than building
 * one of its own, so "what happens to a message sent while a turn is running"
 * is a fact about the tier, not about the server. `later` is the tier that
 * reproduces the interactive CLI's behavior — the message waits for the turn in
 * flight and is then run as a turn of its own, never merged into the current
 * one and never dropped (`docs/proposals/claude-resident-sessions.md` §8).
 *
 * A union rather than a bare string because it is the CLI's vocabulary, not
 * this codebase's: the SDK declares the same three values, and a host that
 * accepted anything else would be writing a frame the process cannot honor.
 */
export type HostInputPriority = 'now' | 'next' | 'later';

// ---------------------------
//--------------- DELIVERY STATE CHANNEL: SNAPSHOT ENTRIES ------------
/**
 * How long the text a delivery carries may be before the activity channel
 * truncates it.
 *
 * The snapshot is an *activity* record, not a transcript: it has to say what a
 * session is holding well enough for a client to draw a pending row, and the
 * transcript itself is the authoritative full text (fetched per message, over
 * its own route). So the text travels bounded — a long prompt is cut here rather
 * than allowed to make every heartbeat-sized frame carry a document.
 *
 * Exported as a value because it sits on both sides of the reduction: the driver
 * cuts to it, and the criterion that reads the channel back is handed the same
 * number instead of retyping it, so a change to the bound moves the measurement
 * with it.
 */
export const DELIVERY_TEXT_MAX_CHARS = 400;

/**
 * The runtime option key a dispatch states a delivery's origin under.
 *
 * The delivery's `source` is the caller's fact — a timer, the MCP gateway and a
 * person's socket all dispatch through the same entry — and the run's origin is
 * already carried on the run record. The *delivery* is built inside the resident
 * driver, on the far side of the module edge from the dispatch, so the origin has
 * to travel on the one thing that crosses it: the options bag the turn is
 * dispatched with. Named here, as a value, because both ends of that edge spell
 * it and a literal retyped on either side is exactly the kind of pair that drifts.
 */
export const DELIVERY_SOURCE_OPTION = 'deliverySource';

// ---------------------------
//--------------- API COMPAT: THE runId BACKFILL WINDOW ------------
/**
 * The instant the `runId` backfill window closes (SPEC §8.3).
 *
 * S3 gives every accepted send a `deliveryId` — the `commandUuid` the host minted
 * and the CLI echoes back — and widens `runId` to be nullable, because a resident
 * send has no turn yet when it answers. That would break every caller that
 * already holds a `runId` and feeds it to `run_get`, so for one minor version the
 * answer BACKFILLS the field: while the turn is unbound, `runId` is stated as the
 * `deliveryId` (`runId === deliveryId` is how a caller recognizes the backfill),
 * and `run_get` accepts either id (SPEC §8.2). Past this instant the backfill is
 * removed — an unbound send states `runId: null` — and a criterion that reads
 * THIS constant turns red on its own the day the date passes, which is what
 * forces the removal rather than leaving it to memory.
 *
 * Written as an absolute instant rather than a duration so the very same number
 * is what the criterion asserts against; the criterion reads it and checks it is
 * still in the future, and never retypes the date.
 */
export const RUN_ID_COMPAT_WINDOW_END_MS = Date.parse('2027-01-15T00:00:00Z');

/**
 * Whether the `runId` backfill still applies at `nowMs` (SPEC §8.3).
 *
 * A reader that only has a clock asks this rather than comparing the constant
 * itself, so "is the window open" is decided in one place — the criterion can
 * push an injected `now` past the deadline, and the implementation and the
 * criterion then agree by construction about which side of the boundary the send
 * is on.
 */
export function isRunIdCompatWindowOpen(nowMs: number): boolean {
  return nowMs < RUN_ID_COMPAT_WINDOW_END_MS;
}

/**
 * Where one accepted delivery is, as the activity channel states it.
 *
 * Deliberately narrower than the ledger's own state vocabulary
 * (`ClaudeResidentDeliveryState`, which also carries `pushed`): `pushed` is the
 * host's mark on a write the CLI has not spoken about yet, and from a client's
 * side an accepted-but-unreported command *is* a queued one — it is waiting for
 * the process to take it. Collapsing the two here is what keeps the channel's
 * vocabulary the CLI's own four words (SPEC §4.1) while the ledger keeps the
 * finer distinction it needs internally.
 */
export type DeliveryEntryState = 'queued' | 'started' | 'completed' | 'cancelled';

/**
 * Why a delivery ended in a way that was not a clean completion.
 *
 * The same set the driver's ledger states on a `cancelled`
 * (`ClaudeResidentDeliveryReason` minus its `cli` residual, which the snapshot
 * carries as `null`: a terminal the CLI stated with nobody here asking is the
 * ordinary ending, not a reason worth naming).
 */
export type DeliveryEntryReason = 'withdrawn' | 'interrupt' | 'process-exit' | 'owed-terminal-missing';

/**
 * One accepted delivery, as the activity snapshot carries it (SPEC §7.1).
 *
 * This is the *status projection* of one accepted send: what a client needs to
 * draw a pending row and settle it, without replaying a stream and without being
 * attached to the run that happened to write the frames. It is deliberately not
 * the ledger record — the ledger is the driver's own account (frames written,
 * leases held, rungs owed) and lives across the module edge; this is the ten
 * facts of it that a browser is entitled to.
 *
 * The channel is a **snapshot**, not a delta: the entry travels inside the whole
 * `activity.snapshot` / `activity.upsert` body, so a client that reconnects
 * reads the current queue and every terminal still inside the retention window
 * without anyone replaying anything at it (`id-relations` B-7).
 *
 * Two field-presence rules are load-bearing, and both are stated as *values*
 * rather than as absent keys so an entry's shape never depends on its state:
 *
 * - `reason` is `null` unless the delivery was cancelled, because a `completed`
 *   delivery has no reason to state and a client that had to test `'reason' in
 *   entry` before drawing a row would be branching on a shape rather than on a
 *   fact.
 * - `text` is `null` once the delivery reaches a terminal, and bounded
 *   ({@link DELIVERY_TEXT_MAX_CHARS}) while it is live. The text is what makes a
 *   queued row readable; an ended delivery's words belong to the transcript, and
 *   carrying them would keep every finished message alive in a snapshot that is
 *   re-sent on every change.
 */
export type DeliveryEntry = {
  /** The delivery's identity: the `commandUuid` the host minted and the CLI echoes back. */
  deliveryId: string;
  state: DeliveryEntryState;
  /** Who asked for this delivery — the same origin vocabulary the run records use. */
  source: ChatRunSource;
  /** The CLI queue tier the write was made under, or `null` for a write that had no queue to be behind. */
  priority: HostInputPriority | null;
  /** When the send was accepted (the host's clock at the write). */
  enqueuedAt: number;
  /** When the CLI said it started running this command, or `null`. */
  startedAt: number | null;
  /** When the CLI stated its terminal, or `null` while it is live. */
  endedAt: number | null;
  /** The turn this command was bound to (SPEC §4.2), or `null` while it is bound to none. */
  turnId: string | null;
  /** The `cancelled` reason, or `null` for a live or cleanly completed delivery. */
  reason: DeliveryEntryReason | null;
  /** The command's own words while the delivery is live, bounded; `null` once it ends. */
  text: string | null;
};

/**
 * How `run_get` states a delivery it read by id (SPEC §8.2).
 *
 * Deliberately the same four words {@link DeliveryEntry} carries — this is a
 * reading of the same ledger, and a second vocabulary would be a second truth.
 */
export type ResidentDeliveryLookupState = DeliveryEntryState;

/**
 * Why a delivery `run_get` read by id ended without completing (SPEC §8.2).
 *
 * WIDER than {@link DeliveryEntryReason}: `run_get` reports the ledger's own
 * reason verbatim, including the `cli` residual (a terminal the CLI stated that
 * nobody here asked for). The activity snapshot drops that residual because a
 * browser drawing a row has nothing to do with the distinction; a caller that
 * asked "has the sentence I sent finished, and if not why not" does.
 */
export type ResidentDeliveryLookupReason = DeliveryEntryReason | 'cli';

/**
 * One delivery, as `run_get` resolves it by id (SPEC §8.2).
 *
 * The by-id face of the same ledger {@link DeliveryEntry} projects as a list:
 * what a caller who holds only a `deliveryId` needs in order to wait for the
 * command it names to end and to read that turn's closing message. It carries
 * the facts the *list* projection does not need — the owning session and the
 * run the delivery's turn is executing as — because the reason a caller reads
 * by id at all is that it holds no session to look the delivery up under.
 *
 * `runId` is the run of the TURN this command was bound to (run=turn, SPEC
 * §5.2), or `null` for a command with no turn yet.
 */
export type ResidentDeliveryLookup = {
  deliveryId: string;
  /** The session whose resident ledger holds this delivery. */
  sessionId: string;
  /** The turn this command was bound to, or `null`. */
  turnId: string | null;
  /** The run the bound turn is executing as, or `null` when the command has no turn. */
  runId: string | null;
  state: ResidentDeliveryLookupState;
  /** The `cancelled` reason (including the `cli` residual), else `null`. */
  reason: ResidentDeliveryLookupReason | null;
  /** Who asked for this delivery — the same origin vocabulary the run records use. */
  source: ChatRunSource;
  /** When the send was accepted. */
  enqueuedAt: number;
  /** When the CLI said it started running this command, or `null`. */
  startedAt: number | null;
  /** When the CLI stated its terminal, or `null` while it is live. */
  endedAt: number | null;
};

// ---------------------------------------------------------------------------
// The resident ledger's own types (SPEC `resident-delivery-turn-ledger` §5).
//
// These cross one module edge and one only: `modules/resident-ledger` owns
// their transitions and the driver holds one ledger per host as the read-only
// view declared at the end of this group. They are stated here rather than in
// the driver because they sit on both sides of that edge, which is the same
// "two or more consumers" rule the rest of this file follows.
//
// The view is READ-ONLY by construction: every field is `readonly`, every
// collection is a `Readonly*` one. A module outside the ledger cannot write a
// ledger field at all — not by convention, but because the type refuses — which
// is what makes "the ledger has one writer" (I6) a fact about the compiler
// rather than a rule a reviewer has to hold.
// ---------------------------------------------------------------------------

/**
 * Whether a delivery has reached the one terminal the CLI states for it (C-1).
 *
 * The single definition of "this command is over", so the settled test, the
 * owed test and the anomaly reconciliation cannot drift apart: a delivery is
 * done exactly when it is `completed` or `cancelled`, and nothing else counts.
 */
export function isTerminalDeliveryState(state: ClaudeResidentDeliveryState): boolean {
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
 *
 * NOTHING DRIVER-SHAPED IS HERE (AC-395 (d)): the round a delivery's dispatcher
 * is awaiting, the lease it holds and the run writer its terminal frame goes to
 * are the driver's own bookkeeping, kept driver-side and indexed by
 * `commandUuid`. The ledger records what the CLI said and nothing about how
 * this process is wired.
 */
export type ResidentLedgerDelivery = {
  /** The uuid this delivery is addressed by — the last frame's, which is the prompt. */
  readonly commandUuid: string;
  /** Every frame uuid this one send wrote (an attachment expansion writes several). */
  readonly uuids: readonly string[];
  readonly state: ClaudeResidentDeliveryState;
  readonly reason: ClaudeResidentDeliveryReason | null;
  /**
   * Who asked for this send — the same origin vocabulary the run records use.
   *
   * Read at the send from the dispatch's own statement (the runtime option the
   * websocket dispatch writes under the run=turn flag) rather than inferred here:
   * a timeline, the MCP gateway and a person's socket all reach this driver
   * through the same entry, so only the caller can say which of them it was, and
   * `user` is the honest default for a caller that stated nothing (SPEC §4.1, §6.1).
   */
  readonly source: ChatRunSource;
  /**
   * The command's own words, kept for the activity channel's live rows only.
   *
   * Bounded at read time rather than here (`DELIVERY_TEXT_MAX_CHARS`) because the
   * transcript is the authoritative full text and this copy exists for a queued
   * row's sake; it is dropped from the projection as soon as the delivery ends.
   */
  readonly text: string;
  /** The turn the CLI bound this command to (C-2), or null while it is bound to none. */
  readonly turnId: string | null;
  /**
   * The run the delivery's turn is executing as (SPEC §5.2), or null.
   *
   * Written when the turn binds, so a caller holding only a `deliveryId` can
   * learn the run without a session to look it up under. It stays readable after
   * the turn has closed, which the driver's own open-turn binding cannot be —
   * that field is the OPEN turn's binding and is cleared at `RESULT`, while a
   * delivery's terminal may arrive later (C-3).
   */
  readonly runId: string | null;
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
  readonly runOpen: boolean;
  /**
   * True when the run closed while the CLI had not yet stated a terminal (I4).
   *
   * This is the cross-check the order-independence of §5.3 rests on: an owed
   * delivery is expected to receive its terminal before the next turn begins,
   * and one that does not is settled `cancelled(owed-terminal-missing)` and
   * recorded as an anomaly rather than left quietly non-terminal.
   */
  readonly owed: boolean;
  /** True when this host asked the CLI to withdraw the command. */
  readonly withdrawalRequested: boolean;
  readonly enqueuedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly priority: string | null;
};

/**
 * The turn the CLI is working on, as the ledger sees it.
 *
 * Minted at `system/init` and closed at `RESULT` — the two moments the CLI
 * itself states a turn boundary with (C-6: there is no `session_state_changed`).
 */
export type ResidentLedgerTurn = {
  readonly id: string;
  /**
   * Whether anybody at this end sent the command that opened it.
   *
   * Read at the `init` from the commands already waiting to be bound: a turn
   * whose opener this host pushed is `delivered`, and one nothing here pushed is
   * `unattended` — the CLI's own cron or background follow-up, which no caller
   * holds a handle for (I5).
   */
  readonly kind: 'delivered' | 'unattended';
  readonly open: boolean;
  /** The delivery the turn's frames belong to: the earliest command it bound. */
  readonly ownerDeliveryId: string | null;
  /** Whether this host has asked the CLI to interrupt, so its `RESULT` reads `aborted`. */
  readonly interruptRequested: boolean;
};

/** One turn that has closed, with the terminal it read (SPEC §5.1). */
export type ResidentLedgerClosedTurn = {
  readonly id: string;
  readonly kind: 'delivered' | 'unattended';
  readonly outcome: 'completed' | 'aborted';
  readonly ownerDeliveryId: string | null;
};

/**
 * The ledger's own account of a state it could not make consistent.
 *
 * Recorded rather than thrown: a stream that breaks one of the CLI's rules is a
 * fact about the CLI, and ending the read loop over it would take the whole
 * process down on a frame the CLI is entitled to send.
 */
export type ResidentLedgerAnomaly = {
  readonly code: string;
  readonly detail: string;
};

/**
 * One host's delivery/turn ledger, as its owner hands it out: a READ-ONLY VIEW.
 *
 * This is the whole of the host's own account of what it sent and what the CLI
 * said came of it. Every state in it is written by an event the CLI or this
 * driver caused — never by a position in a list, a count of results, or an
 * inference from how many turns have ended. Its other readers (the manager's
 * leases, the registry's runs, this driver's own readings) are projections of
 * it, recomputed rather than balanced by hand.
 *
 * The view is what the driver holds and passes back to the ledger's own
 * transitions; the transition functions in `modules/resident-ledger` are the
 * only writers, and they are the only place the mutable shape exists.
 */
export type ResidentLedger = {
  /** Every delivery this host has sent, in send order. */
  readonly deliveries: readonly ResidentLedgerDelivery[];
  /** The same deliveries, addressed by any frame uuid they wrote. */
  readonly byUuid: ReadonlyMap<string, ResidentLedgerDelivery>;
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
  readonly foreign: ReadonlySet<string>;
  /** The turn the CLI is working on, or the one most recently closed. */
  readonly turn: ResidentLedgerTurn | null;
  /** Every turn that has closed, in order, with the terminal it read. */
  readonly closedTurns: readonly ResidentLedgerClosedTurn[];
  /** Commands the CLI started while no turn was open, waiting for the next one. */
  readonly pendingStart: readonly ResidentLedgerDelivery[];
  /** The ledger's own account of the states it could not make consistent. */
  readonly anomalies: readonly ResidentLedgerAnomaly[];
};

/**
 * Where one queued user message is in the CLI's own lifecycle.
 *
 * `queued` and `started` are the two facts that separate "still withdrawable"
 * from "already running"; `cancelled` is the only evidence a withdrawal worked
 * (the CLI answers a `cancel_async_message` control frame with no
 * `control_response` at any timing, so the queue's own account of the message is
 * the verdict — `docs/proposals/claude-resident-sessions-experiments.md` §9.2);
 * `completed` is the turn having run to its end.
 */
export type CommandLifecycleState = 'queued' | 'started' | 'cancelled' | 'completed';

/**
 * The dialect's own name for the row that carries one command lifecycle fact.
 *
 * The name is the claude transcript dialect's, not this codebase's: the row is
 * what the CLI writes into a transcript and what the host reads back off the
 * stream, and both envelopes the CLI uses (`type: 'command_lifecycle'` and
 * `type: 'system'` with this subtype) are spelled with it
 * (`docs/proposals/claude-resident-sessions-experiments.md` §9.2).
 *
 * Exported as a value, and not as prose the producers each retype, because the
 * string sits on both sides of the row → frame edge: the normalizer recognises
 * the row by it, and the client-visible kind that row normalizes to carries the
 * same name in `MessageKind`. A producer that must write the row *without*
 * naming a frame — the debug agent is one, and its static guard forbids wire
 * names in its own sources
 * (`server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts`) —
 * references the dialect's name here instead of embedding the literal.
 */
export const COMMAND_LIFECYCLE_ROW_TYPE = 'command_lifecycle';

/**
 * The claude dialect's own names for the two content blocks a tool call is made
 * of: the `tool_use` block an assistant row carries, and the `tool_result` block
 * the paired user row answers it with.
 *
 * Exported for the same reason {@link COMMAND_LIFECYCLE_ROW_TYPE} is: the
 * strings sit on the row → frame edge, and a producer that is forbidden from
 * naming a frame in its own sources — the debug agent is one, and its static
 * guard rejects the literals `tool_use` / `tool_result` outright
 * (`server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts`) —
 * references the dialect's name here rather than embedding the literal. The
 * normalizer recognises the blocks by these same strings.
 */
export const CLAUDE_TOOL_USE_BLOCK_TYPE = 'tool_use';
export const CLAUDE_TOOL_RESULT_BLOCK_TYPE = 'tool_result';

/**
 * The claude dialect's four `system` subtypes a background task's lifecycle is
 * carried by: the task table's reducer (AC-191,
 * `claude-activity-task-reducer.service.ts`) reads each one off the raw frame.
 *
 * Exported for the same reason {@link COMMAND_LIFECYCLE_ROW_TYPE} is: the strings
 * sit on the row → frame edge, and a producer forbidden from naming a frame in
 * its own sources — the debug agent, whose static guard lists `task_notification`
 * as a forbidden wire literal
 * (`server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts`) —
 * references the dialect's name here instead of embedding the literal. The
 * reducer recognises the frames by these same strings.
 */
export const CLAUDE_TASK_STARTED_SUBTYPE = 'task_started';
export const CLAUDE_TASK_PROGRESS_SUBTYPE = 'task_progress';
export const CLAUDE_TASK_UPDATED_SUBTYPE = 'task_updated';
export const CLAUDE_TASK_NOTIFICATION_SUBTYPE = 'task_notification';

/**
 * The option the chat transport stamps on every turn it dispatches, marking the
 * dispatch as one whose `command` is a message somebody composed.
 *
 * A provider runtime receives turns from more than one place. The chat transport
 * is the one that carries a person's message: `chat-websocket.service.ts` builds
 * the options bag for every `chat.send` / `chat.edit-send`, and for the detached
 * turns a scheduled message fires. Everything else that reaches a runtime — the
 * debug agent's own control plane driving an armed scenario, a launch-option
 * probe — carries a *label* in `command` rather than a message, and must not be
 * recorded as though somebody had sent it.
 *
 * Stated by the transport rather than inferred by the reader, because the two
 * dispatch shapes are otherwise identical: the runtime sees the same entry, the
 * same option keys, and (in the debug agent's case) the same session, and only
 * the sender knows which of the two it is. A provider that writes a turn's own
 * row — the debug agent is the one that does, since its "process" runs a
 * scenario rather than a CLI that would record the prompt itself — reads this
 * flag to decide whether the command is worth recording.
 *
 * Absent means "not a chat turn", so a dispatch from an internal driver writes
 * no user row by default. The direction matters: manufacturing a user row out of
 * a driver's label invents a message nobody sent, while failing to write one for
 * a chat turn is the gap this flag exists to close.
 */
export const CHAT_TURN_OPTION = 'chatTurn';

/**
 * One `command_lifecycle` event the CLI emitted for a queued user message.
 *
 * `commandUuid` is the uuid the *host* assigned when it wrote the frame — the
 * CLI echoes it back verbatim rather than minting one of its own (§9.2), which
 * is what makes a pushed message and a queue entry the same object from this
 * side. `at` is when the host read it off the stream, in host clock terms.
 */
export type CommandLifecycleEvent = {
  commandUuid: string;
  state: CommandLifecycleState;
  at: number;
};

/**
 * How one attempt to withdraw a queued user message ended.
 *
 * `withdrawn` means the CLI reported `cancelled` for that uuid, so the message
 * will run in no turn at all. `already-started` means it did not — the message
 * had been dequeued before the withdrawal reached the process, so it is running
 * or has run, and the process was not disturbed. `unknown` is the honest answer
 * for a uuid this host has no live process to withdraw from, or none it ever
 * pushed; it is deliberately not folded into `already-started`, because "we
 * cannot say" and "we know it is too late" are different facts.
 */
export type HostQueuedInputCancelResult = 'withdrawn' | 'already-started' | 'unknown';

/**
 * How much of a person's text a live resident process's OWN queue is still holding.
 *
 * A reading a caller reconciles a locally-guessed depth against, never a state the
 * caller keeps: the CLI holds its own queue and is the only thing that knows when a
 * turn boundary drains it, so a relay that counts its own deliveries can only ever
 * grow (measured 2026-10-12: the relay reported `queued=8→9→10` while the CLI's own
 * `command_lifecycle` showed seven entries dequeued together at one boundary, real
 * depth ≤2 afterwards).
 *
 * `items` counts messages the CLI accepted but has not dequeued into a turn — no
 * `started`/`completed`/`cancelled` `command_lifecycle` for them. `bytes` is the
 * UTF-8 length of their message text, the same unit the voice relay's admission
 * bound is written in, so the two numbers describe one set of messages.
 *
 * A reader answers `null` (not `{ items: 0 }`) when it cannot take the reading at
 * all — a per-run session, or a host that is gone — and a caller must read that as
 * UNKNOWN, never as empty.
 */
export type HostPendingQueuedInputs = { items: number; bytes: number };

// ---------------------------
//----------------- CLAUDE SESSION REGISTRY TYPES ------------
/**
 * A Claude Code background job that is holding a conversation, as the CLI's own
 * registry describes it.
 *
 * `jobId` is the handle `claude stop` / `claude attach` take (the CLI's short id
 * for the job); `pid` is the live process. Both are carried so the refusal can
 * name the exact command the user has to run.
 *
 * Consumed by the shared `findBackgroundSessionOwner` reader, by the Claude
 * resident host driver (which refuses to resume the conversation this names —
 * resident launch) and by the Claude per-run runtime (same refusal on the
 * per-run path). Both launch paths share this one definition so there is never a
 * second answer to "is this conversation occupied".
 */
export type ClaudeBackgroundSessionOwner = {
  pid: number;
  jobId: string;
  name: string | null;
};

/**
 * The two facts the outside world is owed about an occupied conversation.
 *
 * Not the whole {@link ClaudeBackgroundSessionOwner}: the job's display name is
 * the refusal's business, and the host listing's row is a client contract that
 * says exactly what a client can act on — the handle to stop the job with, and
 * the process to look at.
 *
 * Consumed by the shared `readClaudeSessionOccupancy` reader, by the Claude host
 * listing that reports it to clients, and re-exported through the providers
 * barrel for `server/index.ts`.
 */
export type ClaudeSessionOccupancy = {
  jobId: string;
  pid: number;
};

/**
 * Lists the files of one session-registry directory.
 *
 * A parameter of the registry readers rather than a direct call, for one reason:
 * the host listing is polled once a second, and "one directory scan per request,
 * however many conversations the listing holds" is a property that a
 * per-conversation implementation would silently lose. A criterion can only
 * count the scans if it can see them.
 *
 * Consumed by `scanSessionRegistry` and `readClaudeSessionOccupancy` in
 * `server/shared/utils.ts`; production callers pass the real listing, and a
 * criterion passes a counting one.
 */
export type ClaudeSessionRegistryLister = (sessionsDirectory: string) => string[];

// --------------------------- MCP tool-package shared types ------------

// The types below were re-homed from the feature modules that used to own them
// (proposal `docs/proposals/mcp-gateway-tool-architecture.md` stage 1) so the
// stage-2 domain tool packages can depend on `server/shared/**` alone. Each
// owning module re-exports its former definitions unchanged, so every existing
// consumer keeps reading the same shape from the same barrel.

/**
 * The phase of a session's turn, each value named for the signal that produces
 * it. `idle` is the absence of a turn (before the first frame, or after the
 * turn's `result`).
 *
 * - `thinking`  — a `system/thinking_tokens` estimate arrived.
 * - `writing`   — a text `content_block_delta` (the normalizer's `stream_delta`)
 *                 is in flight.
 * - `tool`      — a `tool_use` block was emitted and its paired `tool_result`
 *                 has not arrived.
 * - `awaitingPermission` — a `permission_request` is outstanding.
 * - `compacting` — a `system/compact_boundary` arrived.
 */
export type TurnPhase = 'idle' | 'thinking' | 'writing' | 'tool' | 'awaitingPermission' | 'compacting';

/**
 * What a caller reads back for one session.
 *
 * `toolName` is the `name` of the pending `tool_use` block (or `null`); it is
 * never derived from a lookup table or a clock. `toolDurationMs` is the tool's
 * elapsed time when a frame carries one — `null` otherwise, and always `null`
 * today because no captured run emitted a `tool_progress` frame.
 */
export type TurnState = {
  phase: TurnPhase;
  toolName: string | null;
  toolDurationMs: number | null;
};

/** One call's arguments: how long to wait, and which single device to ask. */
export type UiStateRequestOptions = {
  /** Overrides {@link UI_STATE_REQUEST_DEFAULT_TIMEOUT_MS} for this call. */
  timeoutMs?: number;
  /** Ask only this device's tabs; omitted means every connected device. */
  deviceId?: string;
};

/**
 * The answer the stop-task control plane's driver call gives.
 *
 * `requested` means the provider driver was called and its call settled — the
 * request was placed, and nothing about the task's state is claimed.
 * `unsupported` means no driver could carry it (the capability is off, the
 * session is not resident and has no per-run runtime, or the live process
 * exposes no stop verb). `timeout` means the driver call did not settle inside
 * its bound, and `error` means it threw. The three failure values are
 * deliberately distinct: a caller that conflated "cannot" with "did not finish"
 * would report a process-less session as a slow one.
 */
export type ControlStopTaskOutcome = 'requested' | 'unsupported' | 'timeout' | 'error';

/**
 * Read-only facts about one run, looked up by the run's own id.
 *
 * Deliberately *not* the internal `ChatRun`: a caller addressing a run by id
 * needs its identity and lifecycle and nothing else, and handing out the
 * internal record would leak the live `writer` and the event buffer it could
 * still mutate. Consumed by this module's criterion
 * (`server/modules/websocket/tests/chat-run-by-id.test.ts`) and, through the
 * module barrel, by the MCP gateway's `overview` tool (AC-247), which types the
 * aborted-run reading of `listRecentRuns` against it.
 */
export type ChatRunSummary = {
  runId: string;
  sessionId: string;
  source: ChatRunSource;
  status: 'running' | 'completed' | 'aborted';
  startedAt: number;
  completedAt: number | null;
  lastSeq: number;
};

/**
 * Why a `getRunById` lookup returned no summary.
 *
 * `expired` means the run existed and stayed terminal past the retention
 * window; `unknown` means the id was never handed out. The two are kept apart
 * so a caller can distinguish "you waited too long" from "that id is not
 * ours". Consumed by the same criterion as `ChatRunSummary`.
 */
export type ChatRunLookupMiss = {
  status: 'unknown';
  reason: 'expired' | 'unknown';
};

/**
 * The result of a run lookup by id: the run's summary, or a typed miss.
 * Consumed by the same criterion as `ChatRunSummary`.
 */
export type ChatRunLookupResult = ChatRunSummary | ChatRunLookupMiss;

/**
 * The authoritative activity snapshot for one session: what the server knows the
 * session is doing, stamped with who is saying it and when.
 *
 * This is the record the whole activity protocol moves. A client never assembles
 * it by patching deltas — the server hands the *whole* thing on every change (see
 * `recordChange`) and hands the same whole thing over REST to a client that joins
 * late, so the two paths cannot disagree about what the session's activity is. The
 * fields are:
 *
 *  - `sessionId` — the app session id the client subscribes with. It is carried in
 *    the body (not only in the URL) so a frame and a snapshot are the same shape
 *    whether they arrive over the socket or over HTTP.
 *  - `bootId` — the identity of the running process, the same value the heartbeat
 *    frames carry, so a client can tell "the server restarted" from "the session
 *    is busy". It is *the same* value by construction: this module reads the one
 *    `BOOT_ID` the heartbeat owns rather than generating a second one.
 *  - `rev` — the session's monotonic activity revision. It is the single number
 *    that lets a client tell a continuous stream from one with a hole in it, and it
 *    has exactly one producer in the process (see `readActivityRevision`).
 *  - `asOf` — the instant the snapshot was produced, read from the injected
 *    `now()`. The protocol has no local clock of its own: every timestamp here is
 *    whatever the injected reader answered, so a criterion can pin it and a
 *    caller cannot be surprised by a value that came from `Date.now()` anyway.
 *  - `turn` — the session's turn phase, from the providers module's reduction,
 *    joined with the identity of the turn's run when the driver knows one
 *    ({@link ActivitySnapshotTurn}). Transported, not computed here.
 *  - `tasks` / `schedules` — the session's live task and schedule projections. Their
 *    internal shape belongs to the reducers that own them (AC-191 / AC-192); this
 *    module only carries whatever the injected readers answer, which is why the
 *    element type is `unknown` rather than a shape redefined here.
 *  - `deliveries` — the session's accepted deliveries, in send order: what is
 *    still queued or running, plus every one that ended inside the retention
 *    window (SPEC §7.1). This is the one projection whose *element* shape this
 *    file names, because it is the channel's own contract rather than a reducer's
 *    private record: a client draws a pending row and settles it from exactly
 *    these ten facts, and a reader that had to discover the shape from the
 *    producer would be reading a copy of it.
 *
 *    Optional in the *type*, and only there. Every snapshot this module builds
 *    carries it — `buildSnapshot` reads it from the reader unconditionally — but a
 *    frame-shaped literal written by a caller (a criterion injecting a
 *    hand-built frame to prove a client ignores an unplaceable one) is still a
 *    well-formed frame without it, and requiring the field would have made this
 *    channel's arrival edit criteria whose subject is not this channel. A reader
 *    that needs the queue reads `snapshot.deliveries ?? []`.
 */
export type ActivityProtocolSnapshot = {
  sessionId: string;
  bootId: string;
  rev: number;
  asOf: number;
  turn: ActivitySnapshotTurn;
  tasks: unknown[];
  schedules: unknown[];
  deliveries?: DeliveryEntry[];
};

/**
 * The session's turn as the snapshot carries it: the phase reduction, plus the
 * run the turn IS when a driver on the run=turn path can name one (SPEC §7.1).
 *
 * The two extra fields are optional on purpose. The phase belongs to the
 * providers module's tracker and is known for every session; the run identity
 * belongs to whoever opened the run, and a session whose turns are one process
 * each (or whose driver has not bound a turn yet) has no run to state. Stating
 * them as a separate, optional half is what lets one snapshot serve both, and it
 * is why a reader that injected its own turn reduction is not made to invent a
 * run id it does not have.
 */
export type ActivitySnapshotTurn = TurnState & {
  /** The run this turn is executing as, when the driver has bound one. */
  runId?: string | null;
  /** When that run was opened, by the driver's clock. */
  startedAt?: number | null;
};

/** Driver summary rendered by the sidebar badge and the Tier-2 panel header. */
export type QuayDriverState = 'running' | 'idle' | 'stale';

export type QuayDriverSummary = {
  state: QuayDriverState;
  alive: boolean;
  running: boolean;
  lastRecordAt: string | null;
};

/**
 * One row of a per-entity detail list (tasks, goals or ADRs). Only the fields the
 * panel renders are kept; the source command returns whole documents (body,
 * children, extra, …) which would bloat every snapshot response.
 */
export type QuayListItem = {
  id: string;
  title: string;
  status: string;
  /**
   * The row's last-updated instant as ISO-8601, converted from the epoch
   * **milliseconds** the CLI prints (`1786439928515.85`), or `null` when the
   * record carried no usable timestamp. This is the value the list is ranked by,
   * so the panel can show the ordering key instead of an invisible one. It is
   * never epoch 0 (`1970-01-01T00:00:00.000Z`) for a missing reading, and never
   * an `Invalid Date` string.
   */
  updatedAt: string | null;
};

export type QuayTaskCounts = {
  total: number;
  byStatus: Record<string, number>;
  ready: number;
  needsHuman: number;
  done: number;
  /** Up to `QUAY_RECENT_LIST_LIMIT` tasks, most recently updated first. */
  recent: QuayListItem[];
};

/** Goal counts read from `quay goal list --json`; the panel shows the stage breakdown. */
export type QuayGoalCounts = {
  total: number;
  achieved: number;
  /** Per-status grouping plus the most recent goals, for the panel's "Stage goals" card. */
  breakdown: QuayGoalBreakdown;
};

/**
 * Stage-goals card payload: how many goals sit in each status the CLI reports,
 * plus the most recently updated goals as display rows.
 */
export type QuayGoalBreakdown = {
  /** Counts keyed by the CLI's own status string (`active`/`achieved`/`draft`/`superseded`/…). */
  byStatus: Record<string, number>;
  /** Up to `QUAY_RECENT_LIST_LIMIT` goals, most recently updated first. */
  recent: QuayListItem[];
};

export type QuayAdrCounts = {
  total: number;
  /** Up to `QUAY_RECENT_LIST_LIMIT` ADRs, most recently updated first. */
  recent: QuayListItem[];
};

/**
 * Current full-suite reading from `.quay/full-suite-state.json`, rendered as the
 * "current" half of the Tests card. `null` means no run state is on disk — a
 * normal "nothing running" state, never a warning.
 */
export type QuaySuiteState = {
  state: string;
  runner: string | null;
  scope: string | null;
  /** ISO timestamp the run started, as the carrier file stores it. */
  startedAt: string | null;
  /** Unix epoch **seconds** the run finished, as the carrier file stores it. */
  finishedAt: number | null;
  durationMs: number | null;
  laneCount: number | null;
  commit: string | null;
  taskId: string | null;
  runId: string | null;
};

/** One history round projected from `.quay/verification-round.jsonl`; the heavy per-file detail is dropped. */
export type QuayTestRoundSummary = {
  round: number;
  startedAt: string | null;
  durationMs: number | null;
  pass: number | null;
  fail: number | null;
  tests: number | null;
  state: string;
};

/** Tests card payload: the current run (if any) plus the most recent history rounds. */
export type QuayTestsSummary = {
  current: QuaySuiteState | null;
  recentRounds: QuayTestRoundSummary[];
};

/**
 * One merged in-flight-or-historical run interval for the Loop pulse gantt.
 *
 * Field-for-field what quay's `dashboard-kernel` publishes as `LiveGanttInterval`, as they
 * arrive inside the read-only `quay lanes --json` document. This is re-declared rather than
 * imported from the plugin because the plugin is an external, per-project artifact resolved
 * at runtime — the shape is the contract, and the verb is what supplies the values.
 */
export type QuayGanttInterval = {
  taskId: string;
  runId: string;
  startMs: number;
  endMs: number;
  phase: string | null;
  finalState: string | null;
  fanInOutcome: string | null;
};

/**
 * Loop pulse card payload: the document `quay lanes --json` prints for one time window
 * (quay's `packLanes` output, plus the window it was selected at and the clock it was read).
 *
 * `overflow` counts the intervals that found no free lane. quay deliberately does not drop
 * them, so `lanes` alone does NOT account for the whole window whenever it is non-zero —
 * a consumer must render the count or it silently loses runs.
 */
export type QuayGanttLanes = {
  windowHours: number;
  nowMs: number;
  lanes: QuayGanttInterval[][];
  overflow: number;
};

/**
 * Why a Loop pulse lane reading is missing, when it is.
 *
 * The card must not collapse every missing reading into one sentence: "the installed plugin has
 * no `lanes` verb" is the normal state of an un-upgraded project, while "the verb ran and its
 * document could not be read" is a read failure. Different facts about different things, and the
 * reader acts differently on each — one calls for an upgrade, the other for a retry.
 */
export type QuayGanttUnavailableReason = 'plugin-lacks-lanes-verb' | 'lanes-read-failed';

/** One fan-in attempt projected from `.quay/worker-outcome.jsonl`. */
export type QuayFanInAttemptSummary = {
  task: string;
  outcome: string;
  /** Lock acquisition as Unix epoch **seconds** (quay's own unit); the panel converts to ms. */
  lockAcquireEpoch: number | null;
  /** Lock release as Unix epoch **seconds**; `null` when the attempt never released the lock. */
  lockReleaseEpoch: number | null;
};

/** Fan-in card payload: the most recent mechanical fan-in attempts across all tasks. */
export type QuayFanInSummary = {
  recent: QuayFanInAttemptSummary[];
};

/**
 * One of quay's published in-flight phases — the values its `dashboard-kernel` marks a live
 * interval with (`LIVE_INTERVAL_PHASES`). Re-declared rather than imported because the plugin
 * is an external, per-project artifact resolved at runtime; the set is the contract.
 */
export type QuayInFlightPhase = 'implementing' | 'fan-in' | 'awaiting-land' | 'landed';

/**
 * One task currently in flight, as the Loop pulse gantt plots it — the SAME set the "In
 * flight" card renders, so the two readings can never disagree about which tasks are running.
 *
 * The task set and `phase` come from quay's own `lanes` reading (its `readLive`, which merges
 * the worker-round carrier, worker-outcome history and live worker processes, and drops tasks
 * that have already landed). The project's `.quay/worker-round.jsonl` heartbeat carrier
 * supplies ONLY the supplementary fields the card adds on top of that set — the task's ISO
 * dispatch instant, the reading's heartbeat, and the worker-driver process id — so this
 * projection opens no second in-flight state machine and can never contradict the chart.
 *
 * Consumer: the MCP `quay_snapshot` tool (`mcp-overview-tools.ts`) surfaces the whole
 * list as `snapshot.inFlight`, and the Quay panel's "In flight" card renders it.
 */
export type QuayInFlightTask = {
  taskId: string;
  /**
   * The in-flight phase quay's lane interval carries for the task. It is relayed from that
   * interval (which quay derives from its own signals, including an unreleased fan-in lock),
   * never re-derived here — so it always equals the phase the Loop pulse card draws for the
   * same interval.
   */
  phase: QuayInFlightPhase;
  /** The task's dispatch instant (ISO) from the round record's per-task start map, or the lane interval's start when it carries none. */
  startedAt: string | null;
  /**
   * The reading's heartbeat instant (ISO): the round record's `ts` when the carrier has one,
   * otherwise the lane clock's own read instant. When the round carrier is what has gone quiet
   * this value lags `generatedAt`, which is exactly the staleness the card marks.
   */
  lastHeartbeat: string;
  /**
   * The worker-driver loop's own process id from the round record — the `--kind worker`
   * instance, NOT a per-task child/session pid (the carrier holds no per-task pid). `null`
   * when the record carries none.
   */
  workerPid: number | null;
};

export type QuayConfigIssueCounts = {
  total: number;
  errors: number;
};

/**
 * Everything the Tier-2 panel renders, assembled from whitelisted read-only
 * commands. A section is `null` when its command failed or returned unparseable
 * output; the failure is recorded in `warnings` rather than thrown, so one
 * misbehaving subcommand never blanks the whole panel.
 */
export type QuaySnapshot = {
  projectId: string;
  projectPath: string;
  generatedAt: string;
  cached: boolean;
  driver: QuayDriverSummary | null;
  tasks: QuayTaskCounts | null;
  goals: QuayGoalCounts | null;
  adrs: QuayAdrCounts | null;
  configIssues: QuayConfigIssueCounts | null;
  /** Tests card: the current suite run plus recent history rounds, read from `.quay/` carrier files. */
  tests: QuayTestsSummary;
  /** Fan-in card: recent mechanical fan-in attempts, read from `.quay/worker-outcome.jsonl`. */
  fanIn: QuayFanInSummary;
  /**
   * Tasks the worker currently has in flight, taken from the SAME `lanes` reading the Loop
   * pulse gantt plots (quay's `readLive`, which drops already-landed tasks) so the card and the
   * chart cannot disagree. `null` = no reading: the `lanes` verb failed or the installed plugin
   * predates it. `[]` = read, and nothing is running. The two are deliberately distinct — the
   * same null-vs-empty convention `tests.current` and `driver` follow — so "could not read" is
   * never shown as "nothing running".
   */
  inFlight: QuayInFlightTask[] | null;
  /**
   * Loop pulse card: the packed gantt lanes for this project's recent worker runs, as printed
   * by quay's own read-only `quay lanes --json` verb — which merges quay's live telemetry with
   * its worker-outcome history and packs the result onto the fixed five lanes using quay's own
   * kernel. `null` = the reading could not be produced: the installed plugin predates the
   * `lanes` verb, or the verb failed to read its carriers. A null is never "no runs": an unread
   * lane set and a genuinely idle window are different readings, and only the second means
   * nothing ran (the same convention `inFlight` and `tests.current` follow).
   */
  gantt: QuayGanttLanes | null;
  /**
   * Why `gantt` is null, when it is: the installed plugin has no `lanes` verb, or the verb ran
   * and its document was unreadable. `null` when `gantt` is present. The two are kept distinct
   * (they are different facts — an un-upgraded plugin vs. a failed read) so the panel can state
   * the actual reason rather than one generic sentence.
   */
  ganttUnavailable?: QuayGanttUnavailableReason | null;
  /**
   * Link to quay's own `quay serve` dashboard, when a live web service is
   * reported for this project. `null` when no dashboard is running — an absent
   * dashboard is a normal state, never a warning.
   */
  dashboardUrl: string | null;
  warnings: string[];
};
