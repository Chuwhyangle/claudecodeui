import type { Dirent } from 'node:fs';

import type { TurnTokenUsage } from './turn-usage.js';

import type {
  AnyRecord,
  CockpitCard,
  FetchHistoryOptions,
  FetchHistoryResult,
  HostCloseDetail,
  HostCloseReason,
  HostLease,
  HostReconfigurePatch,
  HostResidentLaunch,
  HostResidentStartResult,
  HostTurnInput,
  LLMProvider,
  McpScope,
  NormalizedMessage,
  ProcessHost,
  ProviderSkill,
  ProviderSkillListOptions,
  ProviderAuthStatus,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderMcpServer,
  ProviderSkillCreateInput,
  ProviderSkillRemoveInput,
  ProviderRuntimeContext,
  ProviderRuntimePermissionGateway,
  ProviderRuntimeWriter,
  ProviderTranscriptMessage,
  SessionAskEvent,
  SessionBinding,
  UpsertProviderMcpServerInput,
} from './index.js';

//----------------- PROVIDER CONTRACT INTERFACES ------------

/**
 * Live execution contract implemented by each provider SDK/CLI adapter.
 *
 * The provider registry owns this adapter as one facet of `IProvider`; runtime
 * execution context is supplied by the application service at call time.
 */
export interface IProviderRuntime {
  run(
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<unknown>;
  abort(sessionId: string): boolean | Promise<boolean>;
  permissions?: ProviderRuntimePermissionGateway;
}

/**
 * Main provider contract for CLI and SDK integrations.
 *
 * Each concrete provider owns its MCP/auth handlers plus the provider-specific
 * logic for converting native events/history into the app's normalized shape.
 */
export interface IProvider {
  readonly id: LLMProvider;
  readonly runtime: IProviderRuntime;
  readonly models: IProviderModels;
  readonly mcp: IProviderMcp;
  readonly auth: IProviderAuth;
  readonly skills: IProviderSkills;
  readonly sessions: IProviderSessions;
  readonly sessionSynchronizer: IProviderSessionSynchronizer;
  /**
   * Transcript branching. Present only for providers that can materialise a
   * prefix of one conversation as an independent, resumable provider session;
   * its absence is what makes "fork session" unavailable.
   */
  readonly fork?: IProviderFork;
  /**
   * Rename write-back. Present only for providers whose own storage keeps a
   * session title that their tooling reads back (Claude's transcript
   * `custom-title` entry); its absence is what makes the app-side name the only
   * place the rename exists.
   */
  readonly rename?: IProviderSessionRename;
  /**
   * Process-lifetime ownership. Present only for providers that can hold a
   * process across turns (Claude `resident`) or multiplex several conversations
   * onto one already-running process. Its absence is the normal case: every
   * provider without it is driven by the session-host manager's default per-run
   * wrapper, which keeps the existing `IProviderRuntime.run`/`abort` contract as
   * the whole of the provider's lifecycle.
   */
  readonly hostDriver?: IProviderHostDriver;
  /**
   * Plain-shell launch and welcome-text contract.
   *
   * The terminal asks the provider how its CLI is started instead of naming the
   * providers it knows: a fifth provider that mounts this facet is launchable
   * from the Shell tab with no change to the websocket service. Optional only
   * for runtime-registered ids that never reach the Shell tab (the debug agent);
   * every provider in `LLMProvider` mounts it.
   */
  readonly shell?: IProviderShell;
  /**
   * Token/context-usage reader.
   *
   * Same shape of seam as `shell`: the usage service dispatches through this
   * facet, so a provider that reports usage differently (or not at all) states
   * that in its own directory instead of adding a name branch to the service.
   * Absent means the Claude transcript reader is used, which is what a
   * runtime-registered id without a facet has always done.
   */
  readonly tokenUsage?: IProviderTokenUsage;
}

// ---------------------------
//----------------- PROVIDER SHELL INTERFACE ------------
/**
 * How one provider's CLI is launched in the terminal, and what that provider is
 * called in the words a user reads.
 *
 * The returned string is a whole shell command line: it may contain `||`
 * fallbacks and platform-specific syntax, because "resume, and start fresh when
 * that fails" is a launch decision only the provider's CLI can state.
 */
export interface IProviderShell {
  /** The name shown in the welcome notice ("Starting new Codex session in: …"). */
  readonly displayName: string;

  /**
   * Builds the command line for a new or resumed CLI process.
   *
   * `resumeSessionId` absent/empty means a fresh launch. `platform` is resolved
   * by the caller (rather than read here) so a criterion can exercise both
   * platforms in one process.
   */
  launchCommand(options: ProviderShellLaunchOptions): string;
}

export type ProviderShellLaunchOptions = {
  /** Provider-native session id to resume; absent/empty launches a new session. */
  resumeSessionId?: string | null;
  /** A command the caller supplied for a plain-shell-like launch. */
  initialCommand?: string;
  /** `os.platform()` at launch time. */
  platform?: NodeJS.Platform;
  /** Claude's `--dangerously-skip-permissions` carry-over. */
  bypassPermissions?: boolean;
  /** Compiled model argv (already split), appended to every Claude launch attempt. */
  modelArgv?: readonly string[];
};

// ---------------------------
//----------------- PROVIDER TOKEN USAGE INTERFACE ------------
/**
 * The session fields a usage reader needs, structurally.
 *
 * Declared here rather than as the database row so a provider directory reads
 * usage without importing the database repository, which would drag
 * `modules/database` into the provider cycle budget's picture.
 */
export type ProviderTokenUsageSession = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  model: string | null;
};

/** A transcript tail: `content` plus whether it is the whole file. */
export type ProviderTokenUsageFileTail = {
  content: string;
  isComplete: boolean;
};

/**
 * One provider-reported usage quantity set — either the session's cumulative
 * totals or the latest single request's.
 *
 * Every field is optional because "the source did not report this quantity" and
 * "the source reported zero" are different answers: an absent field must stay
 * absent so a UI can omit the row instead of printing a fabricated zero.
 *
 * `cacheReadTokens`, `cacheWriteTokens` and `reasoningOutputTokens` are SUBSETS
 * of their parent totals. They are detail reads, never extra addends:
 * `inputTokens + outputTokens` already covers them, so a consumer that adds them
 * again double-counts.
 */
export type ProviderTokenUsageCounts = {
  inputTokens?: number;
  outputTokens?: number;
  /** Cached input tokens read back; already contained in `inputTokens`. */
  cacheReadTokens?: number;
  /**
   * Cached input tokens written to the cache (Anthropic
   * `cache_creation_input_tokens`, Codex-style `cache_write_input_tokens`);
   * already contained in `inputTokens`. Absent means the source did not report
   * the quantity — it is never a fabricated zero.
   */
  cacheWriteTokens?: number;
  /** Reasoning tokens; already contained in `outputTokens`. */
  reasoningOutputTokens?: number;
  /** The source's own total when it reported one, else absent (never re-derived here). */
  totalTokens?: number;
};

/**
 * I/O the reader may use, injected so the service's tests keep their isolated
 * filesystem and home directory.
 */
export type ProviderTokenUsageDependencies = {
  getHomeDirectory(): string;
  getOpenCodeDatabasePath(): string;
  fileExists(filePath: string): boolean;
  readDirectory(directoryPath: string): Promise<Dirent[]>;
  readTextFile(filePath: string): Promise<string>;
  readTextFileTail(filePath: string, maxBytes: number): Promise<ProviderTokenUsageFileTail>;
  getClaudeContextWindow(): string | undefined;
  getClaudeModelContextWindow?(modelId: string): string | undefined;
};

/** The usage reading every provider facet answers with. */
export type ProviderTokenUsageReading = {
  /**
   * @deprecated The dual-meaning legacy number: for a context-scoped provider
   * (Claude) it is the newest request's input+output, for Codex the session's
   * cumulative total, and only `usageScope` tells the two apart. New code must
   * read {@link sessionSpend} and {@link contextOccupancy} instead, which name
   * the two meanings explicitly. Kept on the wire for older consumers.
   */
  used: number;
  /**
   * @deprecated Window capacity, kept for older consumers; the same quantity is
   * {@link contextOccupancy}`.total` on the first-class shape.
   */
  total?: number;
  /**
   * The session's whole spend, named as such: the one reading `/cost` renders
   * as "Total tokens used". Absent when the provider reported no session
   * snapshot at all — which is different from a snapshot that spent zero.
   */
  sessionSpend?: ProviderTokenUsageCounts;
  /**
   * What the newest request leaves in the context window, kept apart from the
   * session's spend. `used` is that request's prompt occupancy and `total` the
   * window capacity; a provider that only knows the window (Codex) leaves
   * `used` absent rather than fabricating a request reading.
   */
  contextOccupancy?: {
    used?: number;
    total?: number;
  };
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheTokens?: number;
  /** Reasoning tokens, a subset of `outputTokens` when the provider reports them. */
  reasoningOutputTokens?: number;
  /**
   * @deprecated Legacy name for {@link sessionSpend}; providers still fill it
   * for older consumers, new code reads `sessionSpend`.
   */
  cumulative?: ProviderTokenUsageCounts;
  /** The newest single request's usage, for context-occupancy approximations. */
  lastRequest?: ProviderTokenUsageCounts;
  /**
   * Totals for the session's subagent/sidechain turns, kept apart from
   * `cumulative` because they bill to the same account while owning a separate
   * context. Absent when the provider has no sidechain concept or the transcript
   * recorded none.
   */
  sidechain?: ProviderTokenUsageCounts;
  /**
   * @deprecated Tells older consumers what the dual-meaning `used` measures.
   * The first-class shape no longer needs the marker: `sessionSpend` is always
   * the session and `contextOccupancy` always the newest request.
   */
  usageScope?: 'context' | 'session-cumulative';
  /**
   * Provider timestamp of the snapshot this reading came from (ISO 8601). Two
   * writers can race — a history page and a live frame — and a timestamp is what
   * lets the client keep the newer one instead of adopting whichever arrived last.
   */
  observedAt?: string;
  /**
   * The current turn's spend, measured from the last human prompt. Absent when
   * the transcript carries no turn to measure (older transcripts, or a turn
   * still in flight) — absence means "render the session reading only", not
   * "a turn that spent zero".
   */
  turn?: TurnTokenUsage;
  breakdown: {
    input: number;
    output: number;
  };
  unsupported?: boolean;
  message?: string;
};

/**
 * One provider's usage reader.
 *
 * Implementations own where the numbers live (a transcript, a SQLite row, or
 * nowhere at all) and throw only for genuinely missing storage; "this provider
 * has no usage" is an `unsupported` reading, not an error.
 */
export interface IProviderTokenUsage {
  readSessionUsage(
    session: ProviderTokenUsageSession,
    dependencies: ProviderTokenUsageDependencies,
  ): Promise<ProviderTokenUsageReading> | ProviderTokenUsageReading;
}

// ---------------------------
//----------------- PROVIDER HOST DRIVER INTERFACE ------------
/**
 * Optional provider facet for lifecycle modes the default per-run wrapper
 * cannot express.
 *
 * The default wrapper in `server/modules/session-hosts` only observes: it opens
 * a per-run host, watches the runtime's writer for the terminal frame and lets
 * the runtime keep `IProviderRuntime.abort` as the way to stop a turn. A
 * provider that implements this facet instead owns process lifetime — it decides
 * when a host starts, which session is bound to it, and how it is closed — which
 * is what makes `resident` mode and multiplexed hosts possible.
 *
 * `host` carries the identity and state the manager already tracks; a driver
 * mutates process reality and reports back through the manager, never by editing
 * the host record itself. Verbs are specified in
 * `docs/proposals/claude-resident-sessions.md` §4.
 */
export interface IProviderHostDriver {
  /**
   * Starts the host process, or returns the already-running one a multiplexing provider reuses.
   *
   * `sink` is how the driver reports back what the manager cannot observe for
   * itself: which leases the process is being held for, when work moved, and
   * when the process went away on its own. A driver must report through it
   * rather than edit the host record — the record is the manager's, and the
   * close decision is computed from the leases the sink reports, never from the
   * driver's own bookkeeping.
   */
  startHost(host: ProcessHost, sink: IProviderHostDriverSink): Promise<ProcessHost>;
  /** Opens one session binding on the host (for Claude this is the same action as `startHost`). */
  bind(host: ProcessHost, binding: SessionBinding): Promise<void>;
  /** Delivers one turn: for `per-run` this is what `run` used to be; for `resident` it writes to the process input. */
  submit(host: ProcessHost, appSessionId: string, turn: HostTurnInput): Promise<void>;
  /** Stops the turn in flight and reports whether anything was stopped. */
  interrupt(host: ProcessHost, appSessionId: string): Promise<boolean>;
  /** Applies a model/effort/permission change, reporting whether it took effect now or next turn. */
  reconfigure(
    host: ProcessHost,
    appSessionId: string,
    patch: HostReconfigurePatch,
  ): Promise<'live' | 'next-turn'>;
  /** Detaches one session, leaving the host running while it still has other bindings. */
  unbind(host: ProcessHost, appSessionId: string, reason: HostCloseReason): Promise<void>;
  /** Terminates the host process. */
  closeHost(host: ProcessHost, reason: HostCloseReason): Promise<void>;
  /**
   * Whether one process of this provider may serve several sessions at once.
   *
   * The statement only the driver can make, because it is a fact about the
   * process's protocol rather than about the manager: a multiplexing driver
   * (`Codex app-server`, `opencode serve`) routes conversations by session id
   * inside one process, while a driver that replaces the per-run wrapper does
   * not. Absent means false — a driver that never thought about multiplexing
   * gets the safe reading, one conversation per process — so the manager reads
   * this as `=== true` and never as truthiness. Consumed by
   * `session-host-manager.bindSession`, which reuses a live host only for a
   * provider that declares it and refuses the second binding otherwise.
   */
  readonly multiplexedHost?: boolean;
  /**
   * Opens *this session's own* resident process, with no turn behind it.
   *
   * Orthogonal to {@link multiplexedHost}, which governs **reuse** — whether one
   * process may serve several sessions — and says nothing about how a process for
   * one session is opened. The two are in fact needed together: a driver that
   * declares `false` is exactly the driver the manager's `bindSession` cannot
   * place a cold session on (there is no live process that may take a second
   * conversation, and there is no process for this session yet), so a caller
   * asked to start one must have this verb rather than the binding one.
   *
   * Optional, and absent means "this driver cannot be asked for a process": the
   * caller falls back to the manager's `bindSession`, which is the right answer
   * for a multiplexing provider whose live process really can adopt the session,
   * and the safe answer for a driver that never implemented this. Implementations
   * must be idempotent — a session that already has a live host answers with that
   * host rather than opening a second process for it — because "start" is a
   * request for a state, not for a spawn.
   *
   * `launch` carries the options and the provider context, assembled by the
   * caller: the driver neither reads a session row nor decides what the session's
   * next turn would have launched with (see {@link HostResidentLaunch}).
   */
  startResidentSession?(
    appSessionId: string,
    launch: HostResidentLaunch,
  ): Promise<HostResidentStartResult>;
}

/**
 * The manager side of a host driver: what a driver reports, and nothing else.
 *
 * Held by the driver for the life of the host (`startHost` receives it) because
 * every fact here is one the manager cannot read off the process: a lease is a
 * statement of intent the manager has no other way to learn, and an exit is an
 * event rather than a state. The manager owns the host record; a driver that
 * wrote to `ProcessHost` directly would be able to make the record disagree
 * with the process, which is exactly the disagreement this seam exists to
 * prevent. Verbs are specified in
 * `docs/proposals/claude-resident-sessions.md` §4.
 */
export interface IProviderHostDriverSink {
  /** Reports that the host is now being held for one more reason. */
  leaseAdded(appSessionId: string, lease: HostLease): void;
  /** Reports that a reason no longer applies; the manager re-derives state from what is left. */
  leaseRemoved(appSessionId: string, kind: HostLease['kind']): void;
  /**
   * Reports real work on the binding — a turn boundary, a streamed frame, a
   * user send. This is the only thing that moves `lastActivityAt`; a reader
   * attaching to the session deliberately does not.
   */
  activity(appSessionId: string): void;
  /**
   * Reports the address this binding's process answers to, once it is known.
   *
   * A driver reports it because only the process knows it: the name is handed
   * to the provider CLI at launch and the CLI registers it on its own side, so
   * reading it back is the only way to learn whether the address a caller
   * computed is the address that actually answers. `null` is the honest reading
   * when the process was launched without one — not "unknown yet", but "this
   * binding has no address".
   *
   * Unlike `activity`, this is not a work event and must not move
   * `lastActivityAt`: a process stating its own name says nothing about a turn.
   */
  identity(appSessionId: string, peerName: string | null): void;
  /**
   * Reports that the process is gone, with the detail the runtime could see.
   *
   * Terminal: the manager closes the host with `exited` and this detail. The
   * manager does not call `closeHost` back for an exit — the process is already
   * gone, and a driver asked to kill it would be asked to kill something that
   * is not there.
   */
  exited(event: { hostId: string; detail: Exclude<HostCloseDetail, 'forced'> }): void;
}

// ---------------------------
//----------------- PROVIDER SESSION RENAME INTERFACE ------------
/**
 * Rename contract for one provider.
 *
 * A rename is authoritative on the provider's side; this app's copy of the name
 * is a cache of it. The name a user sets here is written to the provider's own
 * store first, and only what the provider then reports is stored here — so the
 * name in this app's database can never be one the provider never accepted.
 */
export interface IProviderSessionRename {
  /**
   * Records `title` as the session's name in the provider's own store.
   *
   * `projectPath` is the session's working directory — the same scoping
   * `forkSession` takes — because providers locate a session by the directory
   * it was run in rather than by the transcript path a caller already knows.
   *
   * A rejection is a *refused* rename and is propagated to the caller, which
   * must not store the name; a caller treats the absence of this facet, or a
   * session the provider has nothing writable for, as a skip instead.
   */
  renameSession(input: {
    providerSessionId: string;
    /** The session's working directory — how providers scope a session lookup. */
    projectPath: string;
    title: string;
  }): Promise<void>;

  /**
   * Reads back the name the provider's own tooling shows for a session.
   *
   * This is the other half of the cache rule: after a successful write the
   * caller stores what this reports rather than what it asked for, so the two
   * sides cannot drift. Optional — a provider that keeps no name of its own has
   * nothing to report, and its callers keep the name they were given.
   *
   * Answers `null` when the provider has no name for the session, which is a
   * reading and not a failure.
   */
  readSessionTitle?(input: {
    providerSessionId: string;
    projectPath: string;
  }): Promise<string | null>;
}

// ---------------------------
//----------------- PROVIDER FORK INTERFACE ------------
/**
 * Transcript-branching contract for one provider.
 */
export interface IProviderFork {
  /**
   * Copies a session's transcript, up to and including `upToAnchorId` (the
   * whole conversation when omitted), into a brand-new provider session.
   *
   * Returns the new provider-native id and the path of the artifact it wrote,
   * so the caller can insert the database row before the filesystem watcher
   * notices the file and indexes it as an unrelated session.
   */
  forkSession(input: {
    providerSessionId: string;
    jsonlPath: string;
    /** The session's working directory — how providers scope a session lookup. */
    projectPath: string;
    upToAnchorId?: string;
    title?: string;
    /** The upstream provider id the fork's short-lived app-server must run under. */
    modelProviderId?: string | null;
  }): Promise<{ providerSessionId: string; jsonlPath: string }>;
}

// ---------------------------
//----------------- PROVIDER MODEL INTERFACE ------------
/**
 * Model catalog contract for one provider.
 *
 * Implementations supply Cloudpit's curated predefined models and can inspect
 * provider-native session state. The Providers service merges these immutable
 * source-controlled definitions with user-created SQLite rows at read time.
 */
export interface IProviderModels {
  /**
   * Returns the curated predefined catalog owned by this provider adapter.
   */
  getSupportedModels(): Promise<ProviderModelsDefinition>;

  /**
   * Reads the model the provider itself believes one session is running with.
   *
   * Only consulted for sessions the app has never recorded a model for — a
   * session started directly in the provider CLI, for example. Selecting a
   * model in the app is persisted on the session row instead, so adapters here
   * are read-only and must fall back to the catalog default when the
   * provider-specific lookup finds nothing.
   */
  getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel>;

  /**
   * Whether a model selection may name the upstream provider it runs under.
   *
   * Codex records `model_providers.<id>` in the thread it starts and checks it
   * again on resume, so a built-in model can be offered once per
   * project-registered provider and the chosen id must reach the session row.
   * An adapter for a provider with no such concept omits this flag, and the
   * model write path then ignores an explicit id rather than persisting a
   * binding the runtime could not honour. Implemented by
   * `CodexProviderModels`; consumed by `provider-models.service.ts`.
   */
  readonly bindsUpstreamProvider?: boolean;
}

// ---------------------------
//----------------- PROVIDER AUTH INTERFACE ------------
/**
 * Auth contract for one provider.
 *
 * Implementations should return a complete installation/authentication status
 * without throwing for normal "not installed" or "not authenticated" states.
 */
export interface IProviderAuth {
  /**
   * Checks whether the provider is installed and has usable credentials.
   */
  getStatus(): Promise<ProviderAuthStatus>;
}

// ---------------------------
//----------------- PROVIDER SKILLS INTERFACE ------------
/**
 * Skills contract for one provider.
 *
 * Implementations discover provider-native skill markdown locations and return
 * normalized skill records with the exact command syntax expected by that
 * provider. Each skill is read from a `SKILL.md` file under its skill directory.
 */
export interface IProviderSkills {
  /**
   * Lists all skills visible to this provider for the optional workspace.
   */
  listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]>;

  /**
   * Writes one or more global user-scoped skills for this provider.
   *
   * Implementations should install the supplied markdown entries into the
   * provider's writable user skill folder and return the normalized skill
   * records that were written.
   */
  addSkills(input: ProviderSkillCreateInput): Promise<ProviderSkill[]>;

  removeSkill(
    input: ProviderSkillRemoveInput,
  ): Promise<{ removed: boolean; provider: LLMProvider; directoryName: string }>;
}

// ---------------------------
//----------------- PROVIDER MCP INTERFACE ------------
/**
 * MCP contract for one provider.
 *
 * Implementations must map provider-native MCP config formats to shared
 * `ProviderMcpServer` records used by routes and frontend state.
 */
export interface IProviderMcp {
  listServers(options?: { workspacePath?: string }): Promise<Record<McpScope, ProviderMcpServer[]>>;
  listServersForScope(scope: McpScope, options?: { workspacePath?: string }): Promise<ProviderMcpServer[]>;
  upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer>;
  removeServer(
    input: { name: string; scope?: McpScope; workspacePath?: string },
  ): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }>;
}

// ---------------------------
//----------------- PROVIDER SESSION INTERFACE ------------
/**
 * Session/history contract for one provider.
 *
 * Implementations normalize provider-specific events and message history into
 * shared transport shapes consumed by API routes and realtime streams.
 */
export interface IProviderSessions {
  /**
   * Whether this provider's `fetchHistory` parses the session row's `jsonl_path`
   * itself.
   *
   * The history cache keys on that file's stat, so the cache may only serve
   * providers whose reader really reads it. Claude and Codex parse the JSONL
   * transcript; Cursor and OpenCode read messages from their own stores, where
   * that file's stat says nothing about the history. This used to be a
   * `provider === 'claude' || provider === 'codex'` branch at every cache call
   * site; the statement belongs to the reader that knows.
   */
  readonly transcriptFileBacked: boolean;

  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  fetchHistory(sessionId: string, options?: FetchHistoryOptions): Promise<FetchHistoryResult>;

  /**
   * The user/assistant PROSE one raw transcript row carries, or `null` when the row is not a
   * message the conversation authored.
   *
   * This is the narrow reader behind prose consumers (today the Quay session-mentions reading):
   * it applies this provider's own transcript format — its message-row gate, its visible-content
   * rules and its carrier selection — without projecting a whole history. Each provider that
   * owns a transcript format implements it by reusing that format's readers; a provider without a
   * readable transcript leaves it undefined, which is what makes "prose mentions" unavailable
   * rather than silently empty.
   *
   * `null` covers every non-prose row: internal injections, tool calls/results, thinking or
   * reasoning, command wrappers/output, lifecycle events, and a duplicate carrier of a message
   * another row already represents. It does NOT mean "the transcript is unreadable" — that is
   * the caller's file-level concern.
   */
  readTranscriptMessage?(row: unknown): ProviderTranscriptMessage | null;

  /**
   * Resolves where a conversation must resume from so that the turn identified
   * by `anchorId`, and everything after it, is replaced.
   *
   * `resumeThroughId` is the last transcript row to KEEP — resuming is
   * inclusive of it — or `null` when the edited turn is the first prompt and
   * the conversation should start over. `found` is false when `anchorId` is not
   * in the transcript, which the caller must report rather than guess at.
   *
   * Implemented only by providers whose transcripts have stable per-row
   * identity; its absence is what makes "edit this message" unavailable.
   */
  resolveEditAnchor?(
    sessionId: string,
    anchorId: string,
  ): Promise<{ found: boolean; resumeThroughId: string | null }>;

  /**
   * Rewinds the session so `keepThroughId` is the last row of its
   * conversation, and points the session at whatever provider session now
   * holds it. `null` keeps nothing: the conversation starts over.
   *
   * Implemented only by providers whose runtime cannot resume a transcript
   * partway and have to branch instead. Codex is one — it has no
   * resume-at-a-row, so the rewind is a `thread/fork` that leaves the pre-edit
   * thread on disk and moves the session onto the copy. Providers that can
   * resume partway leave this undefined, and the anchor is handed to their
   * runtime as a resume option instead; that is the difference the edit
   * gateway branches on.
   */
  rewindSession?(sessionId: string, keepThroughId: string | null): Promise<void>;
}

// ---------------------------
//----------------- PROVIDER SESSION SYNCHRONIZER INTERFACE ------------
/**
 * Session indexing contract for one provider.
 *
 * Implementations scan provider-specific session artifacts on disk and upsert
 * normalized session metadata into the database. The service layer uses this
 * interface for both full rescans and single-file incremental sync triggered
 * by filesystem watcher events.
 */
export interface IProviderSessionSynchronizer {
  /**
   * Scans provider session artifacts and upserts discovered sessions into DB.
   */
  synchronize(since?: Date): Promise<number>;

  /**
   * Parses and upserts one provider artifact file without running a full scan.
   */
  synchronizeFile(filePath: string): Promise<string | null>;
}

// ---------------------------
//----------------- COCKPIT CARD PROVIDER INTERFACES ------------

/**
 * One source of cockpit cards.
 *
 * The cockpit knows nothing about what a provider means: it lists the provider's
 * open cards, merges them under the provider's own `group`/`rank` ordering, and
 * never filters or re-ranks them on its own. Adding a provider is one
 * implementation plus one registration; no cockpit call site changes.
 *
 * `declaredExecutors` is the provider's DECLARED action set. The action channel
 * refuses an executor id that is not declared, even when a card names it, so a
 * typo in a card cannot reach arbitrary code.
 */
export interface ICockpitCardProvider {
  /** Stable provider id; cards carry it in `CockpitCard.provider`. */
  readonly id: string;

  /**
   * The provider's cards, in any order. The registry projects only `state:
   * 'open'` cards and orders them by `group` then `rank`; `resolved` and
   * `expired` cards must be returned too if the provider wants them observed,
   * because the projection — not the provider — owns the visibility rule.
   */
  listCards(): Promise<CockpitCard[]> | CockpitCard[];

  /**
   * Reports that the provider's cards may have changed. Optional: a provider
   * with no push path is polled. The returned function stops the subscription.
   */
  subscribe?(listener: () => void): () => void;

  /** The executor ids this provider's cards may name. */
  declaredExecutors(): readonly string[];
}

/**
 * One action a confirmed card option can run.
 *
 * `execute` is called exactly once per accepted confirmation (one card
 * revision); `params` are the option's declared params verbatim. An executor
 * whose id is not declared by any provider is never reached.
 */
export interface ICockpitActionExecutor {
  readonly id: string;
  execute(params: Record<string, unknown>): Promise<unknown> | unknown;
}

// ---------------------------
//----------------- SESSION ASK EVENT WRITER ------------

/**
 * The write seam for the observation layer's `session.asking` / `session.answered` events.
 *
 * The observation producer states the event; the host-level context-event writer is the real
 * implementation. Production binds it through `shared/ports/session-ask-events.port.ts` (the
 * composition root installs the context-events adapter, the process producer reads the port at
 * write time), so the observation directory never imports the context-events feature module.
 * Criteria inject an in-memory writer, which is why the seam is an interface rather than the
 * concrete writer: a producer must be exercisable without a fleet install. While the installed
 * fleet schema is still v0 the adapter counts the rejected rows (`invalid-kind`) instead of
 * throwing; the v1 schema makes them land with no further producer change.
 */
export interface ISessionAskEventWriter {
  /** Appends one event. Throwing is the writer's business; the producer catches and swallows. */
  write(event: SessionAskEvent): void;
}
