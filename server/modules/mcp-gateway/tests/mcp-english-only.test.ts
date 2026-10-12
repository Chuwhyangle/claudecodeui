/**
 * AC-289 criterion — every string the SERVER authors for a gateway caller is
 * English (no CJK): `message`, `note`, `explanation`, `hostNote`, `activityNote`,
 * the `relative` half of every time field, every tool/parameter `description` in
 * `tools/list`, the `initialize` instructions (when declared) and the OAuth
 * consent page's error copy. User data — session titles, project names, message
 * bodies, approval questions/options — is NOT server copy and must arrive
 * byte-for-byte, so the fixtures that prove it are Chinese.
 *
 * Everything below is real. A real express application carries the production
 * `/mcp` mount; the client is the MCP SDK's own `Client` over
 * `StreamableHTTPClientTransport`, driven with a `node:http`-based fetch (the
 * sibling criteria's seam: `listen(0)` on this host can land on a port undici
 * refuses). The transport is handed every deps bag explicitly, so no database is
 * needed beyond the audit table the audited wrapper writes.
 *
 * Readings, one leg each:
 *   (a) `tools/list` names 28 tools. Every tool has a success probe; every tool
 *       with declared arguments also has a failure probe (the argument-less
 *       tools — `ui_last_opened_session` and `ui_clients_list` — have no
 *       validation branch to drive and are exempted with reasoned entries —
 *       {@link NO_VALIDATION_FAILURE}); the
 *       success payloads are walked and every string under a
 *       {@link SERVER_AUTHORED_FIELDS} key must be CJK-free. The tool and
 *       parameter `description`s and the `initialize` instructions are read the
 *       same way, and the OAuth consent router's error page is fetched as HTML.
 *       A SUPPLEMENTARY rule closes the whitelist's gaps: any string ANYWHERE in
 *       a response that contains CJK must sit under a declared user-data key —
 *       so a server-authored string under a key nobody thought to whitelist reds
 *       rather than passing silently (that is how `relative` was found).
 *   (b) every failure's `(code, message)` is collected and bucketed by `code`;
 *       every bucket is CJK-free, so one code speaks one language across tools.
 *   (c) the checker is a pure function with demonstrable discriminating power:
 *       `containsCjk` / `assertServerCopyEnglish` go RED on a synthetic Chinese
 *       sentence and GREEN on a synthetic English one. Without this, a checker
 *       that always passed would satisfy (a) vacuously.
 *   (d) the Chinese user-data fixtures are read back VERBATIM (`===`), proving
 *       the checker is scoped by field and never "cleans CJK" wholesale. The
 *       falsifying mutation for this leg is a sanitiser applied to user data.
 *
 * Why TWO clients on the same mount. The SDK `Client` validates a call's
 * `structuredContent` against the tool's declared `outputSchema`, and caches
 * those validators when `listTools()` runs — so a client that has listed tools
 * throws `-32602` on a payload that does not match. The registry reader
 * (`listClient`) is the only client that lists; every probe runs on a separate
 * client (`probeClient`) whose validator cache stays cold. Both reach the SAME
 * stateless mount, so the names the reader sees are the names the prober calls.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import type { RequestHandler } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { TurnState } from '@/modules/providers/index.js';

import type { McpReadToolDeps, McpResidentToolDeps, McpWriteToolDeps } from '../index.js';

// `auth.middleware.ts` resolves the JWT secret at module-load time and
// `shared/utils.ts` freezes IS_PLATFORM on first import, so the environment is
// set before any aliased module is pulled in — and every application module
// below therefore comes in dynamically.
process.env.JWT_SECRET = 'mcp-english-only-test-secret';
delete process.env.VITE_IS_PLATFORM;

// Every probe reaches the audited wrapper, which writes one `mcp_audit_log` row.
// A file that writes audit rows needs a database with the CURRENT schema, so give
// it its own migrated temp DB rather than riding the ambient `DATABASE_PATH`.
const dbDirectory = mkdtempSync(path.join(tmpdir(), 'mcp-english-only-'));
process.env.DATABASE_PATH = path.join(dbDirectory, 'audit.db');
const { closeConnection, initializeDatabase } = await import('@/modules/database/index.js');
await initializeDatabase();

const { ACCESS_TOKEN_SCOPES } = await import('@/modules/oauth/index.js');
const { createOAuthConsentRouter } = await import('@/modules/oauth/index.js');
const { MCP_GATEWAY_PATH, mountMcpGateway } = await import('../index.js');

type AnyRecord = Record<string, unknown>;

// =====================================================================
// (c) the checker, as pure functions
// =====================================================================

/**
 * CJK ideographs (the unified block and its main extension), kana, Hangul and
 * the CJK punctuation / full-width forms block. The `relative` field's old
 * values used full-width `，。/`-style punctuation, so the punctuation block is
 * part of the reading rather than an afterthought.
 */
const CJK_PATTERN = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/;

/** The narrowest statement of the reading: does this string contain any CJK? */
function containsCjk(value: string): boolean {
  return CJK_PATTERN.test(value);
}

/**
 * Asserts one server-authored field is English, naming the field so a failure
 * says WHICH string broke. Pure, so leg (c) can drive it on synthetic input
 * without a mount.
 */
function assertServerCopyEnglish(field: string, value: string): void {
  assert.equal(
    containsCjk(value),
    false,
    `${field}: server-authored copy must be English (no CJK), saw ${JSON.stringify(value)}`,
  );
}

/**
 * The keys whose strings the server WROTE. A string under one of these must be
 * English. `activityNote` is included because it is the same kind of field as
 * `note` (a sentence explaining an absent value); `relative` because it is the
 * human half of every time reading.
 */
const SERVER_AUTHORED_FIELDS = new Set([
  'message',
  'note',
  'explanation',
  'hostNote',
  'activityNote',
  'relative',
]);

/**
 * The keys whose strings are USER data, carried verbatim. CJK here is correct
 * and must survive: a session title, a project name, a filesystem path, a
 * message body, an approval question / option. `inputSummary` belongs here
 * because AC-274 defines it as a DIGEST OF THE CALLER'S INPUT (for an
 * `AskUserQuestion`, the JSON of the questions themselves) — it is the caller's
 * own text echoed back, not server copy.
 */
const USER_DATA_FIELDS = new Set([
  'title',
  'name',
  'path',
  'project',
  'peerName',
  'content',
  'text',
  'question',
  'header',
  'label',
  'description',
  'inputSummary',
  'preview',
  'summary',
  // gap-mcp-session-search: the three strings `session_search` carries out of the
  // store — a session's own title, its project's display name and the matched
  // transcript text. All three are provider/user data the tool echoes, never
  // server copy, so CJK under them is correct and must survive untouched (the
  // same reading `title` / `name` / `summary` carry for the other tools).
  'sessionTitle',
  'projectDisplayName',
  'snippet',
]);

/** One string found in a payload, with the JSON path that reached it. */
type FoundString = { path: string; key: string | null; value: string };

/** The nearest ancestor key of a path (array indices are not keys). */
function terminalKey(segments: readonly string[]): string | null {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (!segments[i].startsWith('[')) {
      return segments[i];
    }
  }
  return null;
}

/** Walks any JSON value collecting every string with its path. */
function collectStrings(value: unknown, path: string[] = [], out: FoundString[] = []): FoundString[] {
  if (typeof value === 'string') {
    out.push({ path: path.join('.'), key: terminalKey(path), value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStrings(entry, [...path, `[${index}]`], out));
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value as AnyRecord)) {
      collectStrings(entry, [...path, key], out);
    }
  }
  return out;
}

/**
 * The two readings over one payload, returning the server-authored strings so a
 * caller can print them. Throws (reds) on the first violation.
 */
function assertPayloadEnglish(label: string, payload: unknown): string[] {
  const found = collectStrings(payload);
  const serverCopy: string[] = [];
  for (const entry of found) {
    if (entry.key !== null && SERVER_AUTHORED_FIELDS.has(entry.key)) {
      assertServerCopyEnglish(`${label} ${entry.path}`, entry.value);
      serverCopy.push(`${entry.path} = ${JSON.stringify(entry.value)}`);
    }
  }
  // The supplementary rule: CJK anywhere must sit under a declared user-data key.
  for (const entry of found) {
    if (!containsCjk(entry.value)) {
      continue;
    }
    assert.ok(
      entry.key !== null && USER_DATA_FIELDS.has(entry.key),
      `${label} ${entry.path}: CJK appears under the undeclared key ${String(entry.key)} — ` +
        `declare it as user data or translate the server copy`,
    );
  }
  return serverCopy;
}

/** The one line of evidence each reading prints. */
function say(line: string): void {
  console.log(`english-only ${line}`);
}

// =====================================================================
// fixture identities
// =====================================================================

const USER_ONE = 1;
const ALL_SCOPES: readonly string[] = [...ACCESS_TOKEN_SCOPES];

/** A released turn: no live tool, so the self-target guard never refuses. */
const IDLE_TURN: TurnState = { phase: 'idle', toolName: null, toolDurationMs: null };

/** A fixed clock, so every `relative` reading is exactly predictable. */
const FIXED_NOW = Date.parse('2026-10-07T12:00:00.000Z');
const THIRTY_MIN_MS = 30 * 60 * 1000;

// The Chinese USER-DATA fixtures. Their whole point is to survive untouched.
const ZH_PROJECT_NAME = '示例项目';
const ZH_SESSION_TITLE = '中文标题的会话';
const ZH_MESSAGE_TEXT = '这是一条中文正文消息。';
const ZH_QUESTION = '选哪个？';
const ZH_HEADER = '选择';
const ZH_OPTION_A = '甲';
const ZH_OPTION_B = '乙';
const ZH_TOOL_INPUT_COMMAND = 'echo 你好';

// The resolvable targets AC-246's gate answers against. Exact ids let a probe
// reach its handler; the Chinese titles prove the gate itself carries user data.
// `sess-2` / `sess-3` share the substring "shared session", so the ambiguity
// probe has two candidates to refuse rather than one to resolve.
const resolveDeps = {
  listProjects: () => [{ id: 'proj-1', title: ZH_PROJECT_NAME }],
  listSessions: () => [
    { id: 'sess-1', title: ZH_SESSION_TITLE },
    { id: 'sess-2', title: 'shared session alpha' },
    { id: 'sess-3', title: 'shared session beta' },
  ],
};

const NO_SUCH_SESSION = 'zzz-no-such-session';
const NO_SUCH_PROJECT = 'zzz-no-such-project';

const LAST_ACTIVITY_ISO = new Date(FIXED_NOW - THIRTY_MIN_MS).toISOString();

// =====================================================================
// injected services
// =====================================================================

/**
 * The control service the successful probes use. `cancelQueued` switches on the
 * uuid so ONE mount exposes all three outcome sentences (withdrawn /
 * already-started / unknown) rather than one.
 */
function makeControl() {
  return {
    async send(): Promise<
      | { ok: true; runId: string; queued: boolean; queuedMessageUuid: null }
      | { ok: false; code: string; message: string }
    > {
      return { ok: true, runId: 'run-1', queued: false, queuedMessageUuid: null };
    },
    async abort() {
      return { ok: true as const, aborted: false };
    },
    async cancelQueued(_caller: unknown, input: { sessionId: string; messageUuid: string }) {
      if (input.messageUuid === 'uuid-withdrawn') return 'withdrawn';
      if (input.messageUuid === 'uuid-started') return 'already-started';
      return 'unknown';
    },
    async stopTask() {
      return 'stopped';
    },
  };
}

/** The control service whose `send` always reads "busy" — the SESSION_BUSY arm. */
function makeBusyControl() {
  return {
    ...makeControl(),
    async send(): Promise<{ ok: false; code: string; message: string }> {
      return { ok: false, code: 'RUN_IN_PROGRESS', message: 'A run is already in progress for this session.' };
    },
  };
}

/** The run registry reader `session_send` reads the origin from. */
const runs = { getRun: () => ({ runId: 'run-1', source: 'mcp', status: 'running' }) };

/** AC-248's `run_get` seam over a fake registry and clock. */
const runGetDeps = {
  runs: {
    getRunById: (runId: string) =>
      runId === 'run-1'
        ? {
            runId: 'run-1',
            sessionId: 'sess-1',
            source: 'mcp',
            status: 'running' as const,
            startedAt: FIXED_NOW - 90 * 1000,
            completedAt: null,
            lastSeq: 4,
          }
        : { status: 'unknown' as const, reason: 'unknown' as const },
    getRunBootId: () => 'boot-1',
  },
  activity: { snapshot: () => null },
  sessions: {
    fetchHistory: async () => ({ messages: [{ role: 'assistant', kind: 'message', content: 'Done.', timestamp: LAST_ACTIVITY_ISO }] }),
  },
  now: () => FIXED_NOW,
  sleep: async () => undefined,
  bootId: () => 'boot-1',
};

/** The resident host control the two host tools delegate to (success arms). */
const sessionHostControl = {
  hosts: {
    start: async (sessionId: string) => ({
      ok: true as const,
      sessionId,
      hostId: 'ac289-host',
      mode: 'resident',
      pid: 4242,
      leases: [],
    }),
    close: (sessionId: string) => ({
      ok: true as const,
      sessionId,
      hostId: 'ac289-host',
      mode: 'resident',
      closeReason: 'user',
      leases: [],
    }),
    liveHost: () => null,
  },
};

/**
 * The shape this fixture's `sessionSearch.search` stub reads off its argument.
 *
 * The read bag below is cast to `McpReadToolDeps` AFTER its literal, so the stub
 * gets no contextual type and its parameter must be named — this is the two
 * channels the engine streams, kept structural so the fixture never restates the
 * engine's own types.
 */
type SessionSearchEngineStubInput = {
  onTitleResults?: (rows: ReadonlyArray<AnyRecord>) => void;
  onProgress?: (update: { projectResult: AnyRecord | null }) => void;
};

/** The read bag. Every tool is wired so each has a real success path. */
const readTools = {
  projects: {
    getProjectsWithSessions: async () => [
      {
        projectId: 'proj-1',
        path: '/tmp/proj-1',
        displayName: ZH_PROJECT_NAME,
        sessionMeta: { total: 1 },
        sessions: [{ lastActivity: LAST_ACTIVITY_ISO }],
      },
    ],
    getArchivedProjectsWithSessions: async () => [],
    getProjectSessionsPage: async () => ({ projectId: 'proj-1', sessions: [] }),
  },
  sessions: {
    listRecentSessions: () => ({
      conversations: [
        {
          sessionId: 'sess-1',
          provider: 'claude',
          projectId: 'proj-1',
          sessionTitle: ZH_SESSION_TITLE,
          lastActivity: LAST_ACTIVITY_ISO,
        },
      ],
      total: 1,
    }),
    readSessionLifecycle: () => ({ provider: 'claude', mode: 'resident' }),
    fetchHistory: async () => ({
      messages: [{ role: 'user', kind: 'message', content: ZH_MESSAGE_TEXT, timestamp: LAST_ACTIVITY_ISO }],
    }),
    fetchOutline: async () => ({ total: 0, turns: [] }),
    fetchWindowAround: async () => ({ messages: [], startIndex: 0, total: 0 }),
  },
  hosts: { snapshot: () => [], liveHostForSession: () => null },
  runs: {
    listRunningRuns: () => [
      { sessionId: 'sess-1', provider: 'claude', startedAt: FIXED_NOW - 90 * 1000, lastSeq: 3 },
    ],
    listRecentRuns: () => [],
  },
  quay: { hasQuayConfig: () => false, readCached: () => null, refresh: async () => null },
  activity: { snapshot: () => null },
  runGet: runGetDeps,
  now: () => FIXED_NOW,
  // The browser's last-opened pointer, wired so `ui_last_opened_session` has a
  // real success path: it names the `sess-1` this fixture resolves, one minute
  // before the fixed clock. (The tool declares no input, so its only failure is
  // this reader answering `null`; that arm is the owner criterion's, see
  // {@link NO_VALIDATION_FAILURE}.)
  uiLastOpened: { read: () => ({ sessionId: 'sess-1', openedAt: FIXED_NOW - 60 * 1000 }) },
  // The UI-state round trip, wired so `ui_visible_context` has a real success
  // path: one device whose one tab reports the `sess-1` this fixture resolves,
  // watching `m-1`..`m-9`. Every field is an ASCII identifier, so (a)'s walk and
  // its supplementary rule both read the same nothing-to-translate payload a real
  // browser answering about an English-titled session would send.
  uiVisibleContext: {
    listUiClients: () => [
      {
        deviceId: 'dev-1',
        deviceName: 'laptop',
        tabs: [{ tabId: 'tab-1', deviceName: 'laptop', connectedAt: FIXED_NOW - 120 * 1000 }],
      },
    ],
    requestUiState: async () => [
      {
        deviceId: 'dev-1',
        deviceName: 'laptop',
        lastFocusedAt: FIXED_NOW - 60 * 1000,
        tabs: [
          {
            tabId: 'tab-1',
            deviceName: 'laptop',
            unresponsive: false,
            navigationPolicy: 'ask-before-navigate',
            visibility: 'visible' as const,
            hasFocus: true,
            lastFocusedAt: FIXED_NOW - 60 * 1000,
            panel: 'chat',
            selectedProject: 'proj-1',
            selectedSession: 'sess-1',
            visibleMessages: { first: 'm-1', last: 'm-9' },
            pendingApprovals: 1,
            queuedMessages: 0,
          },
        ],
      },
    ],
  },
  // The same round trip, wired so `ui_clients_list` has a real success path: one
  // device whose one tab reports the `sess-1` this fixture resolves. Only the
  // device's identity and status reach the listing, and every one of those is an
  // ASCII identifier, so (a)'s walk reads the same nothing-to-translate payload
  // `ui_visible_context`'s does.
  uiClientsList: {
    listUiClients: () => [
      {
        deviceId: 'dev-1',
        deviceName: 'laptop',
        tabs: [{ tabId: 'tab-1', deviceName: 'laptop', connectedAt: FIXED_NOW - 120 * 1000 }],
      },
    ],
    requestUiState: async () => [
      {
        deviceId: 'dev-1',
        deviceName: 'laptop',
        lastFocusedAt: FIXED_NOW - 60 * 1000,
        tabs: [
          {
            tabId: 'tab-1',
            deviceName: 'laptop',
            unresponsive: false,
            navigationPolicy: 'ask-before-navigate',
            visibility: 'visible' as const,
            hasFocus: true,
            lastFocusedAt: FIXED_NOW - 60 * 1000,
            panel: 'chat',
            selectedProject: 'proj-1',
            selectedSession: 'sess-1',
            visibleMessages: { first: 'm-1', last: 'm-9' },
            pendingApprovals: 1,
            queuedMessages: 0,
          },
        ],
      },
    ],
  },
  // gap-mcp-session-search: the conversation-search engine, wired so
  // `session_search` has a real success path. The stub streams the engine's two
  // channels directly — one title row carrying the Chinese session title and
  // project display name the rest of this fixture uses, and one project bucket
  // whose one session matched one Chinese transcript line — so the walk reads a
  // payload whose user data is genuinely CJK, exactly as the other tools'.
  // `now` is the fixture clock, so the recency tier of the sort key is pinned.
  sessionSearch: {
    search: async (input: SessionSearchEngineStubInput) => {
      input.onTitleResults?.([
        {
          sessionId: 'sess-1',
          provider: 'claude',
          projectId: 'proj-1',
          projectDisplayName: ZH_PROJECT_NAME,
          sessionTitle: ZH_SESSION_TITLE,
          lastActivity: LAST_ACTIVITY_ISO,
        },
      ]);
      input.onProgress?.({
        projectResult: {
          projectId: 'proj-1',
          projectName: 'proj-1',
          projectDisplayName: ZH_PROJECT_NAME,
          sessions: [
            {
              sessionId: 'sess-1',
              provider: 'claude',
              sessionSummary: ZH_MESSAGE_TEXT,
              matches: [
                {
                  role: 'user',
                  snippet: ZH_MESSAGE_TEXT,
                  highlights: [{ start: 0, end: 2 }],
                  timestamp: LAST_ACTIVITY_ISO,
                  provider: 'claude',
                  messageUuid: 'm-1',
                },
              ],
            },
          ],
        },
      });
    },
    now: () => FIXED_NOW,
  },
  // gap-mcp-changes-on-demand-event-stream (AC-335): the incremental change
  // stream, wired so `changes` has a real success path. One session row newer
  // than the empty watermark is the one event; the run and approval readers are
  // empty, and the one project's cache is cold but has NO quay config, so the
  // reading is complete with no gap. The session title and project title are the
  // CJK fixture's own — user data the tool echoes (`summary` / `title` are
  // declared user-data keys), while every word the SERVER authors (`relative`,
  // the event kind/signal identifiers) is English.
  changes: {
    sessions: {
      listChangedSince: () => ({
        rows: [
          {
            sessionId: 'sess-1',
            projectId: 'proj-1',
            title: ZH_SESSION_TITLE,
            updatedAtMs: FIXED_NOW - 30 * 60 * 1000,
          },
        ],
        hasMore: false,
      }),
      projectForSession: () => 'proj-1',
    },
    runs: { listRecentRuns: () => [] },
    approvals: { listPending: () => [] },
    quay: { hasQuayConfig: () => false, readCachedTasks: () => null },
    projects: { list: () => [{ id: 'proj-1', title: ZH_PROJECT_NAME }] },
    now: () => FIXED_NOW,
    bootId: () => 'ac289-boot',
  },
} as unknown as McpReadToolDeps;

/** Builds the write bag over a control service. */
function makeWriteTools(control: ReturnType<typeof makeControl>): McpWriteToolDeps {
  // gap-mcp-ui-open-session / gap-mcp-ui-focus-turn-show-diff-open-task: the fakes
  // the four `ui_*` navigation tools answer from — one connected device (so the
  // omitted `client` is auto-selected) and a navigation that lands. Every field of
  // the payload is an ASCII identifier, so (a)'s walk reads the same
  // nothing-to-translate answer a real browser would produce for an English-titled
  // session. ONE bag, shared by all four tools, because their deps are the same
  // shape — exactly as `server/index.ts` binds one bag to all four.
  const uiNavDeps = {
    listUiClients: () => [
      {
        deviceId: 'dev-1',
        deviceName: 'laptop',
        tabs: [{ tabId: 'tab-1', deviceName: 'laptop', connectedAt: FIXED_NOW - 120 * 1000 }],
      },
    ],
    navigate: async () => ({
      navigationId: 'nav-1',
      deviceId: 'dev-1',
      deviceName: 'laptop',
      tabId: 'tab-1',
      sessionId: 'sess-1',
      at: { latest: true },
      requestedBy: null,
      requestedAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      status: 'applied',
    }),
  };
  return {
    control,
    runs,
    runGet: { deps: runGetDeps, build: async () => ({ runId: 'run-1', status: 'unknown' }) },
    sessionCreate: {
      projects: { list: () => [{ id: 'proj-1', path: '/tmp/proj-1' }] },
      sessions: {
        create: () => ({ sessionId: 'sess-new' }),
        switchLifecycle: () => undefined,
      },
      control,
      providers: { capabilities: () => ({}) },
    },
    sessionInterrupt: { control },
    sessionHostControl,
    // gap-mcp-ui-open-session: wired so `ui_open_session` has a real success path.
    uiOpenSession: uiNavDeps,
    // gap-mcp-ui-focus-turn-show-diff-open-task: the three sibling tools answer
    // from the same bag, so each has a real success path too.
    uiFocusTurn: uiNavDeps,
    uiShowDiff: uiNavDeps,
    uiOpenTask: uiNavDeps,
  } as unknown as McpWriteToolDeps;
}

/** Builds the resident bag over a control service. */
function makeResidentTools(control: ReturnType<typeof makeControl>): McpResidentToolDeps {
  return {
    control,
    reconfigure: {
      sessions: { getSessionById: () => ({ provider: 'claude' }) },
      runtime: { reconfigure: async () => 'next-turn' },
      models: {
        setSessionModel: () => undefined,
        setSessionEffort: () => undefined,
        setSessionPermissionMode: () => undefined,
      },
      capabilities: {
        // An empty live list: a live-capable table whose provider moves nothing
        // live, which is the NOT_LIVE_MESSAGE arm.
        getProviderCapabilities: () => ({ permissionModes: ['default'], residentFeatures: { liveReconfigure: [] } }),
        getRuntimeProviderCapabilities: () => undefined,
      },
    },
    background: {
      sessions: { getSessionById: () => ({ provider: 'claude' }) },
      hosts: { liveHostForSession: () => null },
      control: { stopTask: async () => 'stopped' },
    },
    approvals: {
      control: {
        pendingApprovals: async () => ({
          ok: true as const,
          approvals: [
            {
              requestId: 'req-1',
              sessionId: 'sess-1',
              toolName: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: ZH_QUESTION,
                    header: ZH_HEADER,
                    options: [{ label: ZH_OPTION_A }, { label: ZH_OPTION_B }],
                  },
                  {
                    question: 'Which command?',
                    options: [{ label: 'run', description: ZH_TOOL_INPUT_COMMAND }],
                  },
                ],
              },
              receivedAt: new Date(FIXED_NOW - 5000),
            },
          ],
        }),
        // AC-287: `approval_answer` for a request that names no live approval is
        // an ERROR, so a success walk must answer one that IS held. `req-1` is
        // the pending entry `pendingApprovals` above reports, so this verb
        // succeeds — the old fixture answered not-found and leaned on the
        // pre-AC-287 "not found is a success" shape.
        answerApproval: async () => ({
          ok: true as const,
          requestId: 'req-1',
        }),
      },
      now: () => FIXED_NOW,
    },
  } as unknown as McpResidentToolDeps;
}

const selfTarget = {
  readTurn: (): TurnState => IDLE_TURN,
  writeToolNames: ['session_send', 'session_create', 'session_interrupt', 'session_start', 'session_close'],
};

// =====================================================================
// HTTP: a node:http based fetch
// =====================================================================

/** The SDK client's `fetch`, over `node:http`, so a port undici refuses cannot red this criterion. */
const nodeFetch: FetchLike = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const target = new URL(String(url));
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    const body = init?.body === undefined || init?.body === null ? null : String(init.body);

    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              responseHeaders.set(key, value);
            } else if (Array.isArray(value)) {
              for (const entry of value) {
                responseHeaders.append(key, entry);
              }
            }
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: responseHeaders }));
        });
      },
    );
    request.on('error', reject);
    if (body !== null) {
      request.write(body);
    }
    request.end();
  });

/** One GET over `node:http`, returning status and body text. */
function httpGet(url: URL): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

// =====================================================================
// the mount and its clients
// =====================================================================

type Mount = { endpoint: URL; close: () => Promise<void> };

/**
 * Boots one real `/mcp` mount whose authorize seam attaches a principal with
 * `scopes` — an explicit `authorize` keeps the real token middleware (and its
 * database) out of this criterion; scope ENFORCEMENT is still the wrapper's.
 */
async function startGateway(scopes: readonly string[], control = makeControl()): Promise<Mount> {
  const authorize: RequestHandler = (_req, res, next) => {
    res.locals.mcpPrincipal = { userId: USER_ONE, tokenId: 1, clientId: null, scopes: [...scopes] };
    next();
  };
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize,
    readTools,
    writeTools: makeWriteTools(control),
    residentTools: makeResidentTools(control),
    resolveDeps,
    selfTarget,
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;

  return {
    endpoint: new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** One fresh SDK client over the endpoint. A client is a fresh output-validator cache. */
async function connectClient(endpoint: URL, name: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(endpoint, { fetch: nodeFetch });
  const client = new Client({ name, version: '0.0.0' });
  await client.connect(transport);
  return client;
}

let mountA: Mount;
let mountB: Mount;
let mountBusy: Mount;
/** The ONLY client that calls `tools/list`; warms its own output-validator cache, never a probe's. */
let listClient: Client;
/** The probe client: never lists, so its validator cache stays cold. */
let probeClient: Client;
/** The same deps behind a principal with NO scopes, for the 权限不足 class. */
let deniedClient: Client;
/** A mount whose control service always reads "busy", for the SESSION_BUSY class. */
let busyClient: Client;
/** The OAuth consent router, mounted on its own app so its error page can be fetched. */
let oauthBase: URL;
let oauthClose: () => Promise<void>;

before(async () => {
  mountA = await startGateway(ALL_SCOPES);
  mountB = await startGateway([]);
  mountBusy = await startGateway(ALL_SCOPES, makeBusyControl());
  listClient = await connectClient(mountA.endpoint, 'ac289-registry');
  probeClient = await connectClient(mountA.endpoint, 'ac289-probe');
  deniedClient = await connectClient(mountB.endpoint, 'ac289-denied');
  busyClient = await connectClient(mountBusy.endpoint, 'ac289-busy');

  const oauthApp = express();
  oauthApp.use(
    createOAuthConsentRouter({
      clients: { findById: () => undefined },
    }),
  );
  const oauthServer = oauthApp.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => oauthServer.once('listening', () => resolve()));
  const oauthAddress = oauthServer.address() as AddressInfo;
  oauthBase = new URL(`http://127.0.0.1:${oauthAddress.port}/`);
  oauthClose = () => new Promise<void>((resolve) => oauthServer.close(() => resolve()));
});

after(async () => {
  await listClient.close().catch(() => undefined);
  await probeClient.close().catch(() => undefined);
  await deniedClient.close().catch(() => undefined);
  await busyClient.close().catch(() => undefined);
  await mountA.close();
  await mountB.close();
  await mountBusy.close();
  await oauthClose();
  closeConnection();
  rmSync(dbDirectory, { recursive: true, force: true });
});

// --------------------------- reading a call ---------------------------

type CallReading = {
  isError: boolean;
  structuredContent?: unknown;
  content: unknown;
};

async function call(client: Client, tool: string, args: AnyRecord): Promise<CallReading> {
  const result = (await client.callTool({ name: tool, arguments: args } as Parameters<Client['callTool']>[0])) as {
    isError?: boolean;
    content?: unknown;
    structuredContent?: unknown;
  };
  return { isError: result.isError === true, structuredContent: result.structuredContent, content: result.content };
}

// =====================================================================
// (a) the success + failure probe tables and the registry
// =====================================================================

/**
 * One SUCCESS path per tool — the (a) coverage table. The registry's name set
 * must equal these keys exactly: a tool the registry grows without a success
 * probe here reds, which is AC-289's "adding a registry tool must not go
 * unnoticed" reading. Arguments are chosen to reach the handler and return a
 * payload (not an error).
 */
const SUCCESS_TABLE: Record<string, AnyRecord> = {
  overview: {},
  projects_list: {},
  sessions_list: {},
  session_get: { session: 'sess-1' },
  session_read: { session: 'sess-1' },
  run_get: { runId: 'run-1' },
  quay_snapshot: { project: 'proj-1' },
  session_send: { session: 'sess-1', message: 'hello' },
  session_create: { project: 'proj-1' },
  session_interrupt: { session: 'sess-1' },
  session_start: { session: 'sess-1' },
  session_close: { session: 'sess-1' },
  session_cancel_queued: { session: 'sess-1', messageUuid: 'uuid-withdrawn' },
  session_reconfigure: { session: 'sess-1', model: 'claude-sonnet-5-5' },
  session_background: { session: 'sess-1' },
  approvals_list: {},
  approval_answer: { requestId: 'req-1', allow: true },
  // No arguments: the success path is the INJECTED pointer reader saying a
  // session was opened, wired below to the `sess-1` this fixture resolves.
  ui_last_opened_session: {},
  // No arguments: the success path is the INJECTED round trip answering with one
  // device whose tab reports the `sess-1` fixture above; asking no device in
  // particular is the broadest (and here, only) question.
  ui_visible_context: {},
  // No arguments either: the success path is the INJECTED round trip answering
  // with one device; listing every connected device is the only question it asks.
  ui_clients_list: {},
  // gap-ui-visible-context-extended-fields: no arguments; the success path is the
  // same INJECTED round trip answering with one device, and the reading is a
  // success whether the mounted token carries `cloudcli:selection` (the text) or
  // not (the `'withheld'` marker) — neither is an error envelope.
  ui_selected_text: {},
  // gap-mcp-ui-open-session: `session` is resolved by the AC-246 target gate
  // against the `sess-1` fixture, and `client` is omitted so the single injected
  // device is auto-selected and the injected navigation lands `applied`.
  ui_open_session: { session: 'sess-1' },
  // gap-mcp-ui-focus-turn-show-diff-open-task: the three sibling navigation tools
  // succeed through the same injected single device; each carries its required
  // target id, and `session` is resolved by the AC-246 target gate against the
  // `sess-1` fixture. The payloads are the same ASCII identifiers as
  // `ui_open_session`'s.
  ui_focus_turn: { session: 'sess-1', turnId: 'anchor-1' },
  ui_show_diff: { session: 'sess-1', filePath: 'src/app.ts' },
  ui_open_task: { session: 'sess-1', taskId: 'QX-1' },
  // gap-mcp-session-search: the injected engine above answers with one session
  // whose one Chinese transcript line matched, so the payload's user data — the
  // title, the project display name and the snippet — is drawn from the CJK
  // fixture rather than an ASCII stand-in.
  session_search: { query: 'hello' },
  // gap-mcp-usage-stats: `groupBy` is the one required argument and the handler
  // reads the caller's own audit rows — here an empty log, so the payload is a
  // well-formed set of zero groups (a success, not an error).
  mcp_usage_stats: { groupBy: 'tool' },
  // gap-mcp-changes-on-demand-event-stream (AC-335): no required argument — the
  // success path is the INJECTED readers below (one session row, no runs, no
  // approvals, a cache that is cold but for a project with no quay config, so not
  // even a gap), and the payload is a well-formed stream of one session event.
  changes: {},
};

/**
 * One FAILURE probe per tool — the (a) failure half. Every entry uses the
 * SHALLOWEST failure the tool has (a missing or wrong-typed argument) so the
 * envelope comes from the wrapper's validation branch for all of them at once;
 * the other codes are probed in {@link CLASS_FAILURES}.
 *
 * The tools that CANNOT appear here are the ones that declare no input at all:
 * with no declared argument the wrapper's validation branch has nothing to
 * reject, so neither `ui_last_opened_session` nor `ui_clients_list` has a shallow
 * failure to drive. They are named in {@link NO_VALIDATION_FAILURE} with their
 * reasons instead of by dropping them — the registry deepEqual below forbids a
 * silent omission.
 */
const FAILURE_TABLE: Record<string, { args: AnyRecord; expect: string }> = {
  overview: { args: { project: 5 }, expect: 'INVALID_ARGUMENT' },
  projects_list: { args: { includeArchived: 'yes' }, expect: 'INVALID_ARGUMENT' },
  sessions_list: { args: { state: 'bogus' }, expect: 'INVALID_ARGUMENT' },
  session_get: { args: {}, expect: 'INVALID_ARGUMENT' },
  session_read: { args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  run_get: { args: { waitSeconds: 'soon' }, expect: 'INVALID_ARGUMENT' },
  quay_snapshot: { args: { refresh: 'yes' }, expect: 'INVALID_ARGUMENT' },
  session_send: { args: { session: 5, message: 'x' }, expect: 'INVALID_ARGUMENT' },
  session_create: { args: {}, expect: 'INVALID_ARGUMENT' },
  session_interrupt: { args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  session_start: { args: {}, expect: 'INVALID_ARGUMENT' },
  session_close: { args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  session_cancel_queued: { args: { session: 5, messageUuid: 'uuid' }, expect: 'INVALID_ARGUMENT' },
  session_reconfigure: { args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  session_background: { args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  approvals_list: { args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  approval_answer: { args: {}, expect: 'INVALID_ARGUMENT' },
  // `client` is a declared optional string, so a wrong-typed one is a shallow
  // validation failure like the rest — no device resolution is reached.
  ui_visible_context: { args: { client: 5 }, expect: 'INVALID_ARGUMENT' },
  // gap-ui-visible-context-extended-fields: `client` is the same declared optional
  // string, so a wrong-typed one is the same shallow validation failure.
  ui_selected_text: { args: { client: 5 }, expect: 'INVALID_ARGUMENT' },
  // `session` is a declared string, so a wrong-typed one is the same shallow
  // validation failure — no device resolution and no navigation is reached.
  ui_open_session: { args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  // gap-mcp-ui-focus-turn-show-diff-open-task: `session` is the same declared
  // string on all three, so a wrong-typed one is the same shallow failure — no
  // device resolution and no navigation is reached.
  ui_focus_turn: { args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  ui_show_diff: { args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  ui_open_task: { args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  // gap-mcp-session-search: `query` is a declared string, so a wrong-typed one is
  // the same shallow validation failure — the engine is never reached.
  session_search: { args: { query: 5 }, expect: 'INVALID_ARGUMENT' },
  // gap-mcp-usage-stats: `groupBy` is REQUIRED (an enum), so an empty argument
  // object is the shallowest failure — the wrapper's validation branch rejects
  // it before the handler's SQL runs.
  mcp_usage_stats: { args: {}, expect: 'INVALID_ARGUMENT' },
  // gap-mcp-changes-on-demand-event-stream (AC-335): the tool declares no
  // REQUIRED argument (an empty object is a legal call), so the shallowest
  // failure is a wrong-TYPED declared optional — `since` is a string, so a number
  // is refused by the wrapper's validation branch before the handler reads any
  // source.
  changes: { args: { since: 5 }, expect: 'INVALID_ARGUMENT' },
};

/**
 * The reasoned-exemption bucket the (a) failure half needs. It is NOT empty: two
 * tools declare no input arguments, so the wrapper's declared-input validation
 * branch — the shallowest failure every other tool is probed through — has
 * nothing to reject. Naming them here (rather than deleting them from the
 * coverage reading) is the same choice `mcp-error-envelope.test.ts` makes for the
 * same tools; the CJK-free property of their refusal literals is still read, by
 * leg (d)'s module-source scan.
 */
const NO_VALIDATION_FAILURE: Record<string, string> = {
  ui_last_opened_session:
    'declares no input arguments, so there is no INVALID_ARGUMENT probe to drive through the wrapper; its SESSION_NOT_FOUND envelope is covered by mcp-ui-last-opened.test.ts',
  ui_clients_list:
    'declares no input arguments, so there is no INVALID_ARGUMENT probe to drive through the wrapper; with no target reference either, no AC-246 refusal is reachable, and its success payload is the criterion tests/mcp-ui-clients-list.test.ts',
};

/** One failure beyond the validation class, so (b)'s buckets are not all one code. */
type ClassFailure = { label: string; mount: 'probe' | 'denied' | 'busy'; tool: string; args: AnyRecord; expect: string };

const CLASS_FAILURES: ClassFailure[] = [
  { label: 'session not found', mount: 'probe', tool: 'session_get', args: { session: NO_SUCH_SESSION }, expect: 'SESSION_NOT_FOUND' },
  { label: 'session not found (send)', mount: 'probe', tool: 'session_send', args: { session: NO_SUCH_SESSION, message: 'x' }, expect: 'SESSION_NOT_FOUND' },
  { label: 'project not found', mount: 'probe', tool: 'sessions_list', args: { project: NO_SUCH_PROJECT }, expect: 'PROJECT_NOT_FOUND' },
  { label: 'project not found (create)', mount: 'probe', tool: 'session_create', args: { project: NO_SUCH_PROJECT }, expect: 'PROJECT_NOT_FOUND' },
  { label: 'ambiguous target', mount: 'probe', tool: 'session_get', args: { session: 'shared session' }, expect: 'TARGET_AMBIGUOUS' },
  { label: 'unknown tool', mount: 'probe', tool: 'no_such_tool', args: {}, expect: 'UNKNOWN_TOOL' },
  { label: 'scope denial', mount: 'denied', tool: 'session_get', args: {}, expect: 'INSUFFICIENT_SCOPE' },
  { label: 'session busy', mount: 'busy', tool: 'session_send', args: { session: 'sess-1', message: 'hi' }, expect: 'SESSION_BUSY' },
  { label: 'task not found', mount: 'probe', tool: 'session_background', args: { session: 'sess-1', stopTaskId: 'nope' }, expect: 'TASK_NOT_FOUND' },
];

/** Reads an error envelope, asserting its shape and an English message. */
function readEnvelope(reading: CallReading, label: string, expectedCode: string): { code: string; message: string } {
  assert.equal(reading.isError, true, `${label}: a failure must set isError === true`);
  const envelope = reading.structuredContent as AnyRecord | undefined;
  assert.ok(typeof envelope === 'object' && envelope !== null, `${label}: a failure must carry structuredContent`);
  assert.equal(envelope.code, expectedCode, `${label}: expected code ${expectedCode}, saw ${String(envelope.code)}`);
  assert.equal(typeof envelope.message, 'string', `${label}: envelope.message must be a string`);
  assert.ok(String(envelope.message).trim().length > 0, `${label}: envelope.message must not be empty`);
  assertServerCopyEnglish(`${label} message`, String(envelope.message));
  return { code: String(envelope.code), message: String(envelope.message) };
}

// =====================================================================
// (c) the checker has discriminating power
// =====================================================================

test('(c) the checker goes red on synthetic Chinese copy and green on English', () => {
  const chinese = '找不到会话 "x"。';
  assert.equal(containsCjk(chinese), true, 'the synthetic Chinese sentence must contain CJK');
  assert.throws(
    () => assertServerCopyEnglish('synthetic.message', chinese),
    /server-authored copy must be English \(no CJK\)/,
    'assertServerCopyEnglish must RED on a synthetic Chinese sentence',
  );
  say(`(c) synthetic Chinese reds: ${JSON.stringify(chinese)}`);

  const english = 'No session has id "x".';
  assert.equal(containsCjk(english), false, 'the synthetic English sentence must contain no CJK');
  assertServerCopyEnglish('synthetic.message', english);
  say(`(c) synthetic English passes: ${JSON.stringify(english)}`);

  // The punctuation block is part of the reading, not an afterthought: the old
  // `relative` values used full-width commas and the full stop 。
  for (const sample of ['全角，标点', '句末。', '（括号）']) {
    assert.equal(containsCjk(sample), true, `${JSON.stringify(sample)} must be read as CJK`);
  }
  say('(c) full-width CJK punctuation is read as CJK');
});

// =====================================================================
// (d) the sources carry no CJK in a string literal
// =====================================================================

/** One string literal with the line it starts on. */
type SourceLiteral = { value: string; line: number };

/**
 * Extracts every `'` / `"` / `` ` `` string literal from TypeScript source,
 * skipping line and block comments. A regex literal (the CJK detector itself)
 * is not a quote, so it is not captured — which is correct: it is a pattern,
 * not caller-facing copy.
 */
function extractStringLiterals(source: string): SourceLiteral[] {
  const out: SourceLiteral[] = [];
  let index = 0;
  let line = 1;
  const length = source.length;
  while (index < length) {
    const ch = source[index];
    if (ch === '\n') {
      line += 1;
      index += 1;
      continue;
    }
    if (ch === '/' && source[index + 1] === '/') {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line += 1;
        index += 1;
      }
      index += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      const startLine = line;
      index += 1;
      let value = '';
      while (index < length && source[index] !== quote) {
        if (source[index] === '\\') {
          value += source[index + 1] ?? '';
          index += 2;
          continue;
        }
        if (source[index] === '\n') line += 1;
        value += source[index];
        index += 1;
      }
      index += 1;
      out.push({ value, line: startLine });
      continue;
    }
    index += 1;
  }
  return out;
}

/**
 * The files the scan reads. The mcp-gateway module's own sources plus the two
 * cross-module files whose copy reaches a caller (the approval-expiry sentence
 * `chat-control.service.ts` produces and the consent error page the OAuth
 * router renders).
 *
 * `mcp-write-notification.ts` is DELIBERATELY excluded: it composes the
 * notification a write call raises for the CloudCLI USER (title / body of an
 * in-app notification), not copy sent to the MCP caller, and it is outside
 * AC-289's field list. Translating it would change user-facing product copy in
 * a task that is about the caller-facing contract.
 */
const SCANNED_SOURCES = [
  ...readdirSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
    .filter((entry) => entry.endsWith('.ts') && entry !== 'mcp-write-notification.ts')
    .map((entry) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', entry)),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../websocket/services/chat-control.service.ts'),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../oauth/oauth-consent.routes.ts'),
];

test('(d) no module source carries CJK inside a string literal', () => {
  assert.ok(SCANNED_SOURCES.length >= 20, `the scan must read the module's sources, found ${SCANNED_SOURCES.length}`);
  let literals = 0;
  let sentenceLike = 0;
  const offenders: string[] = [];
  for (const file of SCANNED_SOURCES) {
    const source = readFileSync(file, 'utf8');
    for (const literal of extractStringLiterals(source)) {
      literals += 1;
      if (literal.value.length >= 25 && literal.value.includes(' ')) {
        sentenceLike += 1;
      }
      if (containsCjk(literal.value)) {
        offenders.push(`${path.relative(process.cwd(), file)}:${literal.line}: ${JSON.stringify(literal.value)}`);
      }
    }
  }
  // Non-vacuity: the lexer really read string literals and really saw sentences.
  assert.ok(literals > 200, `the lexer must read a substantial number of literals, found ${literals}`);
  assert.ok(sentenceLike > 20, `the lexer must see sentence-like copy, found ${sentenceLike}`);
  assert.deepEqual(offenders, [], 'server-authored string literals must be English (no CJK)');
  say(`(d) ${SCANNED_SOURCES.length} sources, ${literals} string literals, ${sentenceLike} sentence-like, 0 CJK`);
});

// =====================================================================
// (a) the registry drives the probe tables
// =====================================================================

test('(a) the success and failure tables cover exactly the tools the registry lists', async () => {
  const listed = await listClient.listTools();
  const registryNames = listed.tools.map((tool) => tool.name).sort();

  assert.equal(registryNames.length, 28, `tools/list must return the full 28-tool set, got ${registryNames.join(', ')}`);
  assert.deepEqual(
    Object.keys(SUCCESS_TABLE).sort(),
    registryNames,
    'every registered tool must have a success probe, and the table must carry no phantom name',
  );
  const probedFailureNames = Object.keys(FAILURE_TABLE);
  const exemptFailureNames = Object.keys(NO_VALIDATION_FAILURE);
  assert.equal(
    probedFailureNames.filter((name) => exemptFailureNames.includes(name)).length,
    0,
    'a tool cannot be both probed and exempted from the failure half',
  );
  assert.deepEqual(
    [...probedFailureNames, ...exemptFailureNames].sort(),
    registryNames,
    'every registered tool must have a failure probe OR a reasoned exemption, and neither set may carry a phantom name',
  );
  say(`(a) registry names: ${registryNames.join(', ')}`);
});

test('(a) every tool description and parameter description is English', async () => {
  const listed = await listClient.listTools();
  let scanned = 0;
  for (const tool of listed.tools) {
    if (typeof tool.description === 'string' && tool.description.length > 0) {
      assertServerCopyEnglish(`tools/list ${tool.name}.description`, tool.description);
      scanned += 1;
    }
    const schema = tool.inputSchema as AnyRecord | undefined;
    const properties = schema?.properties as AnyRecord | undefined;
    for (const [name, raw] of Object.entries(properties ?? {})) {
      const description = (raw as AnyRecord | undefined)?.description;
      if (typeof description === 'string' && description.length > 0) {
        assertServerCopyEnglish(`tools/list ${tool.name}.${name}.description`, description);
        scanned += 1;
      }
    }
  }
  assert.ok(scanned >= 28, `every one of the 28 tools must declare a description, scanned ${scanned}`);
  say(`(a) scanned ${scanned} tool/parameter descriptions, all English`);
});

test('(a) the initialize instructions, when declared, are English', () => {
  const instructions = listClient.getInstructions();
  if (instructions === undefined) {
    say('(a) initialize instructions: absent (the gateway declares none)');
    return;
  }
  assertServerCopyEnglish('initialize.instructions', instructions);
  say(`(a) initialize instructions: ${JSON.stringify(instructions)}`);
});

test('(a) the OAuth consent error page carries no CJK', async () => {
  const response = await httpGet(new URL('authorize', oauthBase));
  assert.equal(response.status, 400, 'a request with no client_id must answer the 400 error page');
  // Positive control: we really read the rendered page, not an empty body.
  assert.ok(response.text.includes('Authorization error'), 'the error page must be the rendered HTML document');
  assert.equal(containsCjk(response.text), false, 'the OAuth error page must be English (no CJK)');
  say(`(a) OAuth error page: ${response.status}, ${response.text.length} chars, no CJK`);
});

// =====================================================================
// (a) every success payload is English, and its user data is declared
// =====================================================================

test('(a) every tool success payload carries only English server copy', async () => {
  const seen: string[] = [];
  for (const [tool, args] of Object.entries(SUCCESS_TABLE)) {
    const reading = await call(probeClient, tool, args);
    assert.equal(reading.isError, false, `${tool}: the success probe must not fail (got ${JSON.stringify(reading.structuredContent)})`);
    const payload = reading.structuredContent ?? reading.content;
    const serverCopy = assertPayloadEnglish(tool, payload);
    for (const line of serverCopy) {
      seen.push(`${tool}.${line}`);
    }
  }
  assert.ok(seen.length >= 8, `the walk must find server-authored strings, found ${seen.length}`);
  for (const line of seen) {
    say(`(a) ${line}`);
  }
});

test('(a) the notable server-authored readings are the translated English sentences', async () => {
  // These are read from the ACTUAL payload the client received, so a revert to
  // Chinese reds here even before the supplementary rule speaks.
  const expectations: Array<[string, AnyRecord, string, string]> = [
    [
      'session_get',
      { session: 'sess-1' },
      'hostNote',
      'No host: this session currently has no host process (per-invocation process mode and not running).',
    ],
    ['session_interrupt', { session: 'sess-1' }, 'message', 'This session currently has no run in flight, so there is no run to abort.'],
    [
      'session_background',
      { session: 'sess-1' },
      'message',
      'This session currently has no host, so it has no background tasks or schedules.',
    ],
    [
      'session_cancel_queued',
      { session: 'sess-1', messageUuid: 'uuid-withdrawn' },
      'message',
      'The queued message was withdrawn and will not become a turn.',
    ],
    [
      'session_reconfigure',
      { session: 'sess-1', model: 'x' },
      'message',
      'This provider does not support live reconfiguration; changes take effect on the next start / next turn.',
    ],
    ['run_get', { runId: 'run-1' }, 'activityNote', 'This session has no activity record.'],
  ];

  for (const [tool, args, field, expected] of expectations) {
    const reading = await call(probeClient, tool, args);
    assert.equal(reading.isError, false, `${tool}: probe must succeed`);
    const payload = reading.structuredContent as AnyRecord;
    assert.equal(payload[field], expected, `${tool}.${field} must be the translated English sentence`);
    assertServerCopyEnglish(`${tool}.${field}`, expected);
    say(`(a) ${tool}.${field} = ${JSON.stringify(expected)}`);
  }

  // The `relative` half of every time reading, which the whitelist exists for.
  const sessions = (await call(probeClient, 'sessions_list', {})).structuredContent as AnyRecord;
  const rows = sessions.sessions as AnyRecord[];
  const activityTime = rows[0].lastActivity as AnyRecord;
  assert.equal(activityTime.relative, '30 minutes ago', 'a 30-minute-old activity reads "30 minutes ago"');
  assertServerCopyEnglish('sessions_list.sessions[0].lastActivity.relative', String(activityTime.relative));
  say(`(a) sessions_list relative = ${JSON.stringify(activityTime.relative)}`);

  // AC-287: an unknown run id is now a `RUN_NOT_FOUND` error whose `message` is
  // the translated explanation and whose `details.fallback` carries the note —
  // the old success-shaped `explanation` field no longer reaches the wire.
  const missReading = await call(probeClient, 'run_get', { runId: 'zzz-no-such-run' });
  assert.equal(missReading.isError, true, 'an unknown run id is a RUN_NOT_FOUND error (AC-287)');
  const miss = missReading.structuredContent as AnyRecord;
  assert.equal(miss.code, 'RUN_NOT_FOUND', 'the unknown run id error carries RUN_NOT_FOUND');
  const missFallback = (miss.details as AnyRecord).fallback as AnyRecord;
  assert.equal(miss.message, 'This runId was never issued.', 'an unknown run id carries the translated explanation');
  assert.equal(
    missFallback.note,
    'No session can be determined, so there is nothing to fall back to.',
    'a miss with no session names the translated fallback note',
  );
  assertServerCopyEnglish('run_get.message', String(miss.message));
  assertServerCopyEnglish('run_get.details.fallback.note', String(missFallback.note));
  say(`(a) run_get miss message = ${JSON.stringify(miss.message)}`);

  // The other two session_cancel_queued sentences, from the one mount. AC-287
  // moved `uuid-other` (a uuid no live queue holds) from a SUCCESS outcome to a
  // `QUEUED_MESSAGE_NOT_FOUND` error, so the SAME English sentence now rides the
  // envelope's `message`; `uuid-started` stays the already-started success.
  for (const [uuid, expected] of [
    ['uuid-started', 'The message is no longer in the queue (it was taken out to start executing) and can no longer be withdrawn.'],
    ['uuid-other', 'The session queue has no message with this uuid (it may never have existed, belong to another session, or there is no resident host).'],
  ] as const) {
    const reading = await call(probeClient, 'session_cancel_queued', { session: 'sess-1', messageUuid: uuid });
    const payload = reading.structuredContent as AnyRecord;
    if (uuid === 'uuid-other') {
      assert.equal(reading.isError, true, 'an unknown queue uuid is an error (AC-287)');
      assert.equal(payload.code, 'QUEUED_MESSAGE_NOT_FOUND', 'the unknown uuid error carries QUEUED_MESSAGE_NOT_FOUND');
    } else {
      assert.equal(reading.isError, false, 'an already-started message stays a success (AC-287)');
      assert.equal(payload.outcome, 'already-started', 'a dequeued message reads already-started');
    }
    assert.equal(payload.message, expected, `session_cancel_queued (${uuid}) must be the translated sentence`);
    say(`(a) session_cancel_queued (${uuid}) = ${JSON.stringify(expected)}`);
  }

  // The overview / quay_snapshot note, read from the real payloads.
  const overview = (await call(probeClient, 'overview', {})).structuredContent as AnyRecord;
  assert.equal((overview.quay as AnyRecord[])[0].note, 'This project has no quay', 'the overview quay note is English');
  const snapshot = (await call(probeClient, 'quay_snapshot', { project: 'proj-1' })).structuredContent as AnyRecord;
  assert.equal(snapshot.note, 'This project has no quay', 'the quay_snapshot note is English');
  say('(a) overview + quay_snapshot notes are English');
});

// =====================================================================
// (b) one code speaks one language across every tool
// =====================================================================

test('(b) every failure message is English, bucketed by code', async () => {
  const buckets = new Map<string, string[]>();

  const record = (label: string, tool: string, entry: { code: string; message: string }): void => {
    const bucket = buckets.get(entry.code) ?? [];
    bucket.push(`${tool}: ${entry.message}`);
    buckets.set(entry.code, bucket);
    say(`(b) ${label} ${tool} -> ${entry.code}`);
  };

  for (const [tool, probe] of Object.entries(FAILURE_TABLE)) {
    record('validation', tool, readEnvelope(await call(probeClient, tool, probe.args), `failure ${tool}`, probe.expect));
  }

  for (const probe of CLASS_FAILURES) {
    const client = probe.mount === 'denied' ? deniedClient : probe.mount === 'busy' ? busyClient : probeClient;
    record(probe.label, probe.tool, readEnvelope(await call(client, probe.tool, probe.args), `class ${probe.label}`, probe.expect));
  }

  assert.ok(buckets.size >= 6, `the failures must span several codes, saw ${buckets.size}`);
  for (const [code, messages] of buckets) {
    assert.ok(messages.length > 0, `${code}: a bucket must carry at least one message`);
    for (const message of messages) {
      assertServerCopyEnglish(`code ${code}`, message);
    }
    say(`(b) ${code} -> ${messages.length} message(s): ${messages.map((m) => JSON.stringify(m)).join(' | ')}`);
  }
});

// =====================================================================
// (d) Chinese user data arrives verbatim
// =====================================================================

test('(d) Chinese user data is returned verbatim, never cleaned', async () => {
  // A project name.
  const projects = (await call(probeClient, 'projects_list', {})).structuredContent as AnyRecord;
  const project = (projects.projects as AnyRecord[]).find((entry) => entry.id === 'proj-1');
  assert.equal(project?.name, ZH_PROJECT_NAME, 'the project name must come back byte-for-byte');

  // A session title, through two different tools.
  const sessions = (await call(probeClient, 'sessions_list', {})).structuredContent as AnyRecord;
  const sessionRow = (sessions.sessions as AnyRecord[]).find((entry) => entry.id === 'sess-1');
  assert.equal(sessionRow?.title, ZH_SESSION_TITLE, 'the session title must come back byte-for-byte');
  const sessionGet = (await call(probeClient, 'session_get', { session: 'sess-1' })).structuredContent as AnyRecord;
  assert.equal((sessionGet.session as AnyRecord).title, ZH_SESSION_TITLE, 'session_get must echo the title verbatim');

  // The overview's running row carries both.
  const overview = (await call(probeClient, 'overview', {})).structuredContent as AnyRecord;
  const running = (overview.running as AnyRecord[])[0];
  assert.equal(running.title, ZH_SESSION_TITLE, 'the overview title must be verbatim');
  assert.equal(running.project, ZH_PROJECT_NAME, 'the overview project name must be verbatim');

  // A message body.
  const read = (await call(probeClient, 'session_read', { session: 'sess-1' })).structuredContent as AnyRecord;
  assert.ok(
    String(read.content).includes(ZH_MESSAGE_TEXT),
    'the transcript must contain the Chinese message body verbatim',
  );

  // Approval questions and options — the fixtures AC-274 landed.
  const approvals = (await call(probeClient, 'approvals_list', {})).structuredContent as AnyRecord;
  const question = ((approvals.approvals as AnyRecord[])[0].questions as AnyRecord[])[0];
  assert.equal(question.question, ZH_QUESTION, 'the approval question must be verbatim');
  assert.equal(question.header, ZH_HEADER, 'the approval header must be verbatim');
  const options = question.options as AnyRecord[];
  assert.equal(options[0].label, ZH_OPTION_A, 'the first option label must be verbatim');
  assert.equal(options[1].label, ZH_OPTION_B, 'the second option label must be verbatim');
  const secondQuestion = ((approvals.approvals as AnyRecord[])[0].questions as AnyRecord[])[1];
  assert.equal(
    (secondQuestion.options as AnyRecord[])[0].description,
    ZH_TOOL_INPUT_COMMAND,
    'an option description must be verbatim',
  );

  // gap-mcp-session-search: the search reading carries user text out of the
  // store too — the matched session's own title, its project's display name and
  // the matched transcript line — so all three must arrive verbatim.
  const search = (await call(probeClient, 'session_search', { query: 'hello' })).structuredContent as AnyRecord;
  const hit = (search.results as AnyRecord[])[0];
  assert.equal(hit.sessionTitle, ZH_SESSION_TITLE, 'session_search must echo the session title verbatim');
  assert.equal(hit.projectDisplayName, ZH_PROJECT_NAME, 'session_search must echo the project name verbatim');
  assert.equal((hit.matches as AnyRecord[])[0].snippet, ZH_MESSAGE_TEXT, 'session_search must echo the snippet verbatim');

  say(`(d) verbatim: project=${ZH_PROJECT_NAME} title=${ZH_SESSION_TITLE} body=${ZH_MESSAGE_TEXT}`);
  say(`(d) verbatim: question=${ZH_QUESTION} header=${ZH_HEADER} options=${ZH_OPTION_A}/${ZH_OPTION_B}`);
  say(`(d) verbatim: session_search title=${String(hit.sessionTitle)} snippet=${String((hit.matches as AnyRecord[])[0].snippet)}`);
});
