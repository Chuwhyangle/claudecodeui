/**
 * The six tools the Realtime bridge advertises to a Realtime session, each a
 * field-for-field mirror of the MCP gateway's own declared tool schema.
 *
 * WHY THIS FILE EXISTS. `docs/proposals/voice-native-control-plane.md` §2 wants
 * the voice control plane to "speak the same language" the MCP gateway already
 * speaks: a function call the model emits for `session_send` has to carry the
 * SAME parameters an MCP client would send, or the two front doors drift into
 * two protocols. This module is that one language, written down once for the
 * bridge to advertise in `session.update`.
 *
 * WHY A MIRROR RATHER THAN AN IMPORT. The gateway's six Zod shapes are not all
 * reachable through its barrel (`ui_visible_context` / `session_get` / `run_get`
 * live inline in `mcp-gateway.read-tools.ts`'s body table; `approvals_list` is
 * module-private in `mcp-approvals.ts`), and importing the gateway's barrel at
 * runtime would drag express, the database and the voice/sensevoice boot into
 * this module — the Realtime bridge is meant to stay a lean, offline-provable
 * seam. So the shapes are mirrored here, and `tests/realtime-bridge-harness.ts`
 * supplies the gateway's OWN registrations as the oracle: `tests/
 * voice-realtime-bridge.test.ts` compares the two field by field every run, so
 * a drift on either side is a red, and the AC-2 false form proves that
 * comparison names the field it caught.
 *
 * Consumers: `voice-realtime-bridge.service.ts` (the descriptors are advertised
 * in `session.update`), and `tests/voice-realtime-bridge.test.ts` (the AC-2
 * comparison against the captured gateway registrations).
 */
import { z } from 'zod';

/**
 * The name of one mirrored tool — exactly the name the MCP gateway registers,
 * because that NAME is the routing key a Realtime function call arrives under.
 */
export type RealtimeToolName =
  | 'ui_visible_context'
  | 'session_send'
  | 'session_interrupt'
  | 'session_status'
  | 'session_get'
  | 'run_get'
  | 'approvals_list'
  | 'session_background';

/**
 * One tool as the bridge declares it: the name/description a Realtime session
 * is told about, plus the input and output raw shapes (`z.ZodRawShape`, the same
 * unit the MCP gateway's registration seam carries) the AC-2 comparison binds
 * against the gateway.
 */
export type RealtimeToolDescriptor = {
  name: RealtimeToolName;
  description: string;
  inputSchema: z.ZodRawShape;
  outputSchema: z.ZodRawShape;
};

/** The instant reading `session_get`'s time fields carry — the gateway's own `timeSchema`. */
const timeShape = z.object({ relative: z.string(), iso: z.string() });

/** `session_get`'s per-session summary (`mcp-gateway.read-tools.ts`'s `sessionSchema`). */
const sessionRowShape = z.object({
  id: z.string(),
  title: z.string(),
  provider: z.string(),
  projectId: z.string().nullable(),
  lifecycleMode: z.string(),
  hostState: z.string().nullable(),
  running: z.boolean(),
  awaitingUser: z.boolean(),
  lastActivity: timeShape.nullable(),
});

/** `session_get`'s live-host reading (`hostSchema`). */
const hostShape = z.object({
  hostId: z.string(),
  mode: z.string(),
  state: z.string(),
  pid: z.number().nullable(),
  startedAt: timeShape,
  idleForMs: z.number(),
  peerName: z.string().nullable(),
  leases: z.array(z.unknown()),
});

/** `session_get`'s run reading (`runSchema`). */
const runRowShape = z.object({
  sessionId: z.string(),
  provider: z.string(),
  startedAt: timeShape,
  lastSeq: z.number(),
});

/** `ui_visible_context`'s expanded-diff reading (ids only, never a diff body). */
const uiCurrentDiffShape = z
  .object({ view: z.string(), files: z.array(z.string()), commits: z.array(z.string()) })
  .nullable();

/** `ui_visible_context`'s focused-task reading. */
const uiCurrentTaskShape = z
  .object({ source: z.literal('taskmaster'), id: z.string(), title: z.string().nullable() })
  .nullable();

/** One browser tab as `ui_visible_context` reports it. */
const uiTabShape = z.object({
  tabId: z.string(),
  deviceName: z.string(),
  unresponsive: z.boolean(),
  navigationPolicy: z.string().nullable(),
  visibility: z.enum(['visible', 'hidden']).nullable(),
  hasFocus: z.boolean().nullable(),
  lastFocusedAt: z.number().nullable(),
  panel: z.string().nullable(),
  selectedProject: z.string().nullable(),
  selectedSession: z.string().nullable(),
  visibleMessages: z
    .object({ first: z.string().nullable(), last: z.string().nullable() })
    .nullable(),
  pendingApprovals: z.number().nullable(),
  queuedMessages: z.number().nullable(),
  currentDiff: uiCurrentDiffShape,
  currentTask: uiCurrentTaskShape,
});

/** A `session_background` held-work entry (reused by `tasks` and `remaining`). */
const backgroundTaskShape = z.object({
  id: z.string(),
  kind: z.string(),
  recurring: z.boolean(),
});

/** One `AskUserQuestion` option as `approvals_list` / `pendingInteraction` expand it. */
const approvalOptionShape = z.object({
  label: z.string(),
  description: z.string().optional(),
  multiSelect: z.boolean().optional(),
});

/** One expanded `AskUserQuestion` question (the expansion both tools share). */
const approvalQuestionShape = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(approvalOptionShape),
});

/**
 * `session_get`'s pending-interaction reading (`mcp-gateway.read-tools.ts`'s
 * `pendingInteractionSchema`): the same fields `approvals_list` reports for a
 * request, minus `session` — the tool carrying this reading already names it.
 */
const pendingInteractionShape = z.object({
  requestId: z.string(),
  toolName: z.string(),
  inputSummary: z.string(),
  interactive: z.boolean(),
  autoTimeoutMs: z.number().nullable(),
  waitedMs: z.number(),
  questions: z.array(approvalQuestionShape).optional(),
});

/**
 * The one statement of the six mirrored schemas. Order follows the MCP gateway's
 * own stage tables so a reader can compare the two side by side.
 */
export const REALTIME_TOOLS: readonly RealtimeToolDescriptor[] = [
  {
    name: 'ui_visible_context',
    description:
      'Ask the connected browsers what they are showing: per device and tab, the identifiers, ranges and current task/diff, plus the ui_open_session navigation log.',
    inputSchema: { client: z.string().optional(), navigationId: z.string().optional() },
    outputSchema: {
      devices: z.array(
        z.object({
          deviceId: z.string(),
          deviceName: z.string(),
          lastFocusedAt: z.number().nullable(),
          tabs: z.array(uiTabShape),
        }),
      ),
      navigations: z.array(
        z.object({
          navigationId: z.string(),
          deviceId: z.string(),
          deviceName: z.string(),
          tabId: z.string().nullable(),
          sessionId: z.string(),
          at: z.union([
            z.object({ latest: z.literal(true) }),
            z.object({ messageId: z.string() }),
            z.object({ turnId: z.string() }),
            z.object({ diffFile: z.string() }),
            z.object({ taskId: z.string() }),
          ]),
          requestedBy: z.string().nullable(),
          requestedAt: z.number(),
          updatedAt: z.number(),
          status: z.enum(['applied', 'declined', 'pending_user', 'ignored', 'superseded', 'expired']),
        }),
      ),
    },
  },
  {
    name: 'session_send',
    description:
      'Send a message to a session, returning the run id at once. A queued message does not answer a pending approval; use approval_answer to answer it.',
    inputSchema: {
      session: z.string(),
      message: z.string(),
      waitSeconds: z.number().optional(),
      // AC-337: the gateway's `session_send` declares the opaque correlation
      // label, so the mirror has to carry the field or AC-2 reds (`kind:
      // 'missing'`, `expected: 'optional<string>'`). Mirrored as a bare
      // `z.string()` because that IS the gateway's signature: its length/charset
      // contract (`.min(1).max(128).regex(...)`) is applied as Zod CHECKS, which
      // `zodSignature` does not read, so re-stating them here would add an
      // invisible-to-the-alarm second copy of a rule that lives once in
      // `mcp-correlation-id.ts`. That is also why a label this plane lets
      // through cannot do damage: the gateway reads it with the permissive
      // `readCorrelationId`, which answers `null` for anything outside the
      // contract instead of storing or acting on it.
      correlationId: z.string().optional(),
    },
    outputSchema: {
      runId: z.string(),
      queued: z.boolean(),
      queuedMessageUuid: z.string().nullable(),
      source: z.string(),
      // gap-mcp-session-send-reports-pending-interaction-it-queued-behind: the
      // pending request a `queued: true` send is parked behind — the same
      // `pendingInteractionShape` `session_get` advertises, nullable because a
      // send that opened a run is never blocked.
      blockedBy: pendingInteractionShape.nullable(),
      run: z.unknown().optional(),
    },
  },
  {
    name: 'session_get',
    description: 'Read one session: its summary, its live host and its current run.',
    inputSchema: { session: z.string() },
    outputSchema: {
      session: sessionRowShape,
      pendingInteraction: pendingInteractionShape.nullable(),
      host: hostShape.nullable(),
      hostNote: z.string().nullable(),
      run: runRowShape.nullable(),
    },
  },
  {
    name: 'run_get',
    description: 'Read one run by id, waiting a bounded time for it to settle.',
    inputSchema: {
      runId: z.string().optional(),
      waitSeconds: z.number().optional(),
      session: z.string().optional(),
      run: z.string().optional(),
      wait: z.boolean().optional(),
    },
    outputSchema: { run: z.unknown().optional() },
  },
  {
    name: 'approvals_list',
    description:
      'List the tool approvals waiting on a session (or every running session), expanding an AskUserQuestion into its questions and options.',
    inputSchema: { session: z.string().optional() },
    outputSchema: {
      approvals: z.array(
        z.object({
          requestId: z.string(),
          session: z.string(),
          toolName: z.string(),
          inputSummary: z.string(),
          interactive: z.boolean(),
          autoTimeoutMs: z.number().nullable(),
          waitedMs: z.number(),
          questions: z.array(approvalQuestionShape).optional(),
        }),
      ),
    },
  },
  {
    name: 'session_background',
    description:
      'List a session background-task and cron leases from the live host snapshot; with stopTaskId, stop one through the control service.',
    inputSchema: { session: z.string(), stopTaskId: z.string().optional() },
    outputSchema: {
      ok: z.boolean(),
      session: z.string(),
      host: z.union([z.object({ state: z.string(), pid: z.number().nullable() }), z.null()]),
      tasks: z.array(backgroundTaskShape),
      stopped: z.boolean().optional(),
      taskId: z.string().optional(),
      remaining: z.array(backgroundTaskShape).optional(),
      code: z.string().optional(),
      message: z.string().optional(),
    },
  },
] as const;

/**
 * The STOP tool: `session_interrupt`, the GATEWAY's contract plus the VOICE plane's audit pair.
 *
 * THE GATEWAY SIDE IS UNCHANGED. `mcp-gateway.write-tools.ts` still declares
 * `inputSchema: SESSION_INTERRUPT_INPUT_SCHEMA` (`{ session }`) and
 * `outputSchema: { aborted, message? }`, so an MCP client sees byte-for-byte what it saw before.
 * This descriptor is the VOICE plane's declaration, and the two fields it adds are read on the
 * voice side only: `voice-realtime-live-executor.ts` validates and then STRIPS them before the
 * gateway's own `readSessionInterruptInput` runs, and the proxy adds its three receipt readings
 * after the gateway's payload comes back.
 *
 *  - `intent` (OPTIONAL in the schema) — the model's own statement of what it took the user to
 *    want when it decided to stop. A stop is a JUDGEMENT, not a command, so the reading behind it
 *    belongs on the record: SPEC §6.2 makes it mandatory and §10.3 / C-3's "误停可审计" is
 *    unsatisfiable without it. It is nonetheless optional HERE, at the transport schema: the model
 *    omitting it is a real, observed form, and a required `intent` makes the transport reject the
 *    whole call (`TOOL_ARGUMENT_SCHEMA_VIOLATION`) — losing the stop AND the message it carried.
 *    An omitted intent is therefore accepted and the audit records `intent: null` together with
 *    `intentMissing: true`, never an empty string and never a fabricated reading — a record that
 *    said intent was given when it was not would be the lie.
 *  - `heard` (optional) — the transcription the judgement was made on. The model may legitimately
 *    have none (a stop with no words behind it), and an absent one is recorded as `null`, never
 *    invented.
 *  - `message` (optional) — the CORRECTED instruction, for an interrupt the model judged to be a
 *    change of direction rather than an outright stop (SPEC §0.3 D-6, §18.4 G1, GOAL-041 AC-342).
 *    The proxy enqueues it into the CLI's own queue and requires the enqueue's confirmation BEFORE
 *    it aborts, so the correction and the run it corrects ride the SAME turn (the E10/U2 reading);
 *    an absent one is exactly today's bare stop. It is a voice-plane field like the other two —
 *    stripped before the gateway — but it does not appear in the tool's description: the §6.3 tool
 *    budget has 9 bytes of slack and the instructions carry the directive instead.
 *
 * The `outputSchema` carries the three readings the voice plane's receipt adds to the gateway's own
 * payload (`runId`, `triggerSeq`, `queuedStillPending` — see `sessionInterrupt` in
 * `voice-realtime-ws-proxy.service.ts`); the gateway's `{ aborted, message? }` is what an MCP client
 * still receives.
 *
 * It is kept OUT of {@link REALTIME_TOOLS} on purpose. That array is the six-tool mirror the AC-2
 * comparison walks field by field against the gateway's captured registrations, and its LENGTH is
 * asserted in several places (`voice-realtime-dashscope-transport.test.ts`,
 * `voice-realtime-connection-resilience.test.ts`); a seventh entry there would red them all. The
 * stop tool needs no such mirror: it is a one-field command whose whole contract is "abort the
 * bound session", and the voice plane never advertises it with the gateway's required `session`
 * (see `VOICE_REALTIME_TOOLS`).
 *
 * THE DESCRIPTION IS PAID FOR ON EVERY TURN. `voice-realtime-status-tool.test.ts`'s AC6 pins the
 * three voice descriptions inside twice one `session_send` description (SPEC §6.3), so the hint that
 * the two new fields exist is squeezed into the sentence already there rather than added beside it.
 */
export const REALTIME_INTERRUPT_TOOL: RealtimeToolDescriptor = {
  name: 'session_interrupt',
  description: "Stop the run, then deliver `message` (the user's words); `intent` = why.",
  inputSchema: { session: z.string(), intent: z.string().optional(), message: z.string().optional(), heard: z.string().optional() },
  outputSchema: {
    aborted: z.boolean(),
    message: z.string().optional(),
    runId: z.string().nullable(),
    triggerSeq: z.number().nullable(),
    queuedStillPending: z.number(),
  },
};

/**
 * The FULL-STATUS tool: `session_status`, SPEC §6.3's "主动查询全量状态" side of D-1.
 *
 * The injected status line (§8.4) is deliberately COMPACT — it is paid for on every response — so
 * when the model needs the detail rather than the gist (the human asked "what is it doing?"), it asks
 * for it here. The shape is §6.3's, verbatim: the WHOLE state the injected line abbreviates.
 *
 * WHY IT IS NOT IN {@link REALTIME_TOOLS}. That array is the six-tool MIRROR the AC-2 comparison
 * walks field by field against the MCP gateway's own registrations, and `session_status` has no such
 * counterpart — no MCP client can ask a Realtime session for its execution plane. It is therefore
 * VOICE-ONLY ({@link VOICE_ONLY_TOOLS}), which is why widening {@link VOICE_REALTIME_TOOLS} to carry
 * it does not disturb AC-2: the mirror list is untouched at six.
 *
 * `phase`'s enum is the UNION of §6.3's vocabulary (`idle`/`running`/`awaiting-permission`) and the
 * L3 reading's own (`+ queued`). The tool reports the reading's phase VERBATIM — §6.3's first
 * bullet forbids a second, disagreeing computation — so a declared enum narrower than the reading
 * could carry would be the lie. `awaiting-permission` is §7.1's first-class phase but not yet
 * OBSERVABLE (the aggregator has no event source for a pending interaction; see
 * `voice-realtime-ws-proxy.service.ts`), so it is declared as vocabulary, not as a value produced
 * today.
 */
export const REALTIME_SESSION_STATUS_TOOL: RealtimeToolDescriptor = {
  name: 'session_status',
  description: "Read the bound session's live status: phase, run, queue depth and pending interaction.",
  inputSchema: { session: z.string().optional() },
  outputSchema: {
    sessionId: z.string(),
    phase: z.enum(['idle', 'queued', 'running', 'awaiting-permission']),
    runId: z.string().nullable(),
    elapsedMs: z.number().nullable(),
    startedAt: z.number().nullable(),
    queuedItems: z.number(),
    queuedBytes: z.number(),
    maxBytes: z.number(),
    lastDelivery: z.object({ at: z.number(), bytes: z.number() }).nullable(),
    pendingInteraction: z
      .object({ requestId: z.string(), toolName: z.string(), inputSummary: z.string() })
      .nullable(),
    statusSeq: z.number(),
    at: z.number(),
    // The RunDigest (SPEC §12.5). The whole set the compact line only abbreviates: which deliveries
    // the current run covers, what is queued but not started, the CLI's last activity, and how fresh
    // the sample is. Each is `null` before the proxy has sampled one (an idle plane).
    covers: z.object({ count: z.number(), last: z.string().nullable() }).nullable(),
    queuedNotStarted: z.object({ count: z.number().nullable(), last: z.string().nullable() }).nullable(),
    lastCliActivity: z.object({ tool: z.string().nullable() }).nullable(),
    freshness: z.number().nullable(),
  },
};

/**
 * The tools that exist ONLY on the voice plane: they carry no MCP gateway counterpart, so
 * {@link diffToolDescriptors} has no oracle for them and must not be asked for one.
 *
 * The whitelist is what keeps AC-2 honest: every OTHER tool the voice plane advertises still has to
 * mirror the gateway field for field, and this array is the exhaustive list of the ones that are
 * excused from doing so. It holds exactly one member, and a criterion asserts the set equality
 * rather than trusting the comment.
 *
 * THE ONE MEMBER IS NO LONGER ADVERTISED (2026-10-14 ruling). `session_status` was withdrawn from
 * {@link VOICE_REALTIME_TOOLS} — the relay model is a pen, not an agent, and it does not choose
 * when to ask for a fresh reading — but the descriptor, the live executor's route and this whitelist
 * all stay: the routing table still answers a call by name, and the mirror invariant is still stated
 * here rather than inferred from what happens to be advertised.
 */
export const VOICE_ONLY_TOOLS: readonly RealtimeToolName[] = ['session_status'];

/**
 * The tool list the VOICE plane advertises: `session_send` and `session_interrupt`, both with their
 * `session` made optional.
 *
 * `session_send` is the relay's one job (see `VOICE_REALTIME_INSTRUCTIONS`): the model passes the
 * user's words on and does nothing else. `session_interrupt` is the exception the instructions name:
 * the person wants the running work stopped or taken a different way, and the model calls it to
 * abort the run in flight, carrying their words in `message`. There is no third tool — see below.
 * The five other mirror tools (`ui_visible_context`, `session_get`, `run_get`, `approvals_list`,
 * `session_background`) were never used to good effect — the model polled `run_get` with malformed
 * arguments and invented session ids for `session_get` — and cost about 600 tokens of EVERY
 * response's context: measured on the real endpoint, a session's fixed context was ~1,280 tokens,
 * and the bill is per token read per response.
 *
 * `session_status` WAS ADVERTISED AND IS WITHDRAWN (2026-10-14 ruling, journal `e650117b`; replay in
 * `experiments/voice-realtime-relay-mode-replay/`). It was the FULL reading behind the compact status
 * line (SPEC §6.3), offered so the model could ask for the detail. The ruling re-scoped the model to
 * a pen — it tidies the person's words and passes them on, and choosing when to ask the execution
 * plane for a fresh reading is not its job — so it is no longer advertised. The descriptor
 * ({@link REALTIME_SESSION_STATUS_TOOL}), the {@link VOICE_ONLY_TOOLS} whitelist, the live executor's
 * route and the proxy's reading all stay: withdrawing the advertisement is the whole change, and the
 * cleanup is a separate question. The remaining two descriptions stay inside the §6.3 tool budget
 * (they fit inside twice one `session_send` description).
 *
 * WHY NOT THE MIRROR AS-IS. The mirror must match the MCP gateway field by field (AC-2), and there
 * `session` is required because an MCP client names its target. A voice connection is bound to ONE
 * session by the connection itself, and the instructions tell the model never to name one.
 * Advertising `session` as required therefore made the real transport reject every call that obeyed
 * the instructions (`TOOL_ARGUMENT_SCHEMA_VIOLATION: session: expected string, received undefined`),
 * so the user's words were transcribed and then nothing ran. The executor already treats an omitted
 * `session` as the bound one and refuses a different one, so the fix is to stop advertising it as
 * mandatory, not to loosen the executor. `session_status`, while it WAS advertised, is not a gateway
 * mirror at all (see {@link VOICE_ONLY_TOOLS}), but it took the same optional `session` for the same
 * reason.
 */
export const VOICE_REALTIME_TOOLS: readonly RealtimeToolDescriptor[] = [
  ...REALTIME_TOOLS.filter((tool) => tool.name === 'session_send'),
  REALTIME_INTERRUPT_TOOL,
].map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema, session: z.string().optional() } }));

/**
 * The one-line description the slim `session_send` carries.
 *
 * The gateway's own description ("…returning the run id at once. A queued message does not answer a
 * pending approval; use approval_answer…") is about approvals the voice plane has no tool for; on this
 * plane the model's whole job is to pass the person's words on.
 */
const SLIM_SESSION_SEND_DESCRIPTION = 'Send a message to the Claude Code session.';

/**
 * The tool list one voice connection advertises.
 *
 * `slimSendTool: false` is {@link VOICE_REALTIME_TOOLS} itself — the historical advertisement, and the
 * rollback of `VOICE_REALTIME_SLIM_SEND_TOOL`. `true` replaces ONLY `session_send` with `{ message }`
 * and a one-line description (−202 tokens on every response; same delivery in four replay windows,
 * `experiments/voice-realtime-closing-turn`). `session_interrupt` is passed through untouched: its
 * slimmer form was never measured, and a function call is sensitive to its schema.
 *
 * The slim copy is derived HERE, never written back to {@link REALTIME_TOOLS}: that mirror is compared
 * with the MCP gateway field by field (AC-2) and must keep declaring `session`, `waitSeconds` and
 * `correlationId`. A call that still carries a retired field is not rejected — the transport validates
 * with a strip-unknown-keys object schema — and the executor already treats an omitted `session` as
 * the bound one.
 *
 * Consumed by `voice-realtime-ws-proxy.service.ts` (the tools each connection advertises).
 */
export function voiceRealtimeToolsFor(slimSendTool: boolean): readonly RealtimeToolDescriptor[] {
  if (!slimSendTool) {
    return VOICE_REALTIME_TOOLS;
  }
  return VOICE_REALTIME_TOOLS.map((tool) =>
    tool.name === 'session_send'
      ? { ...tool, description: SLIM_SESSION_SEND_DESCRIPTION, inputSchema: { message: tool.inputSchema.message! } }
      : tool,
  );
}

/** The descriptors keyed by name, so the bridge routes a function call by tool NAME. */
export const REALTIME_TOOLS_BY_NAME: Readonly<Record<RealtimeToolName, RealtimeToolDescriptor>> =
  Object.fromEntries(
    [...REALTIME_TOOLS, REALTIME_INTERRUPT_TOOL, REALTIME_SESSION_STATUS_TOOL].map((tool) => [tool.name, tool]),
  ) as Record<RealtimeToolName, RealtimeToolDescriptor>;

// --------------------------- the field-by-field comparison ---------------------------

/** Which side of a tool a mismatch was found on. */
export type ToolSchemaSection = 'input' | 'output';

/** How one field failed to line up. */
export type SchemaFieldMismatchKind = 'missing' | 'unexpected' | 'shape';

/**
 * One field-level disagreement between a mirrored tool schema and the gateway's
 * own declaration.
 *
 * `expected` is the gateway's canonical signature, `actual` the mirror's; a
 * `missing` field is one the gateway declares and the mirror does not, an
 * `unexpected` field the reverse, and `shape` a field present on both sides
 * whose type or optionality differs. The field NAME is the payload — the AC-2
 * false form requires the red to say which field it caught.
 */
export type SchemaFieldMismatch = {
  tool: string;
  section: ToolSchemaSection;
  field: string;
  kind: SchemaFieldMismatchKind;
  expected: string;
  actual: string;
};

/**
 * A canonical, order-insensitive structural signature for one Zod schema.
 *
 * The comparison that AC-2 needs is "do these two shapes declare the same fields
 * with the same types and the same optionality", and reading it off `def.type`
 * (zod 4's discriminant) rather than off a rendered JSON Schema keeps it stable
 * across formatters. Object field order is sorted so two objects that differ
 * only in key order compare equal — the pinned contract is the field SET, not
 * the order a `z.object({...})` literal happens to be typed in.
 */
function zodSignature(value: unknown): string {
  // `unknown` rather than `z.ZodType` on purpose: a `z.ZodRawShape`'s values are
  // zod 4's CORE schema type, which is not the classic `z.ZodType` class, so the
  // narrower annotation rejects the very values this walker exists to read.
  const def = (value as { def: Record<string, unknown> }).def;
  const type = def.type as string;
  switch (type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
      return `${type}<${zodSignature(def.innerType)}>`;
    case 'nonoptional':
    case 'readonly':
      return `${type}<${zodSignature(def.innerType)}>`;
    case 'array':
      return `array<${zodSignature(def.element)}>`;
    case 'object': {
      const shape = def.shape as Record<string, unknown>;
      const fields = Object.keys(shape)
        .sort()
        .map((key) => `${key}:${zodSignature(shape[key])}`);
      return `object{${fields.join(',')}}`;
    }
    case 'union':
      return `union<${(def.options as unknown[]).map((option) => zodSignature(option)).join('|')}>`;
    case 'literal':
      return `literal:${JSON.stringify(def.values)}`;
    case 'enum':
      return `enum:${Object.keys(def.entries as Record<string, string>)
        .sort()
        .join('|')}`;
    case 'pipe':
      return `pipe<${zodSignature(def.in)}>`;
    case 'lazy':
      return 'lazy';
    default:
      // Any scalar or leaf construct (string / number / boolean / null / unknown
      // / any / never / …) is fully described by its type discriminator.
      return type;
  }
}

/**
 * Compares one section of a mirrored tool schema against the gateway's own
 * declaration, returning every field that does not line up.
 *
 * Consumers: `diffToolDescriptors` (which runs it for the input and output
 * halves) and `tests/voice-realtime-bridge.test.ts`, which calls it directly
 * with a deliberately mutated shape to prove the comparison goes red.
 */
export function diffToolSchemas(
  tool: string,
  section: ToolSchemaSection,
  expected: z.ZodRawShape,
  actual: z.ZodRawShape,
): SchemaFieldMismatch[] {
  const mismatches: SchemaFieldMismatch[] = [];
  const expectedFields = Object.keys(expected).sort();
  const actualFields = Object.keys(actual).sort();
  const expectedSet = new Set(expectedFields);
  const actualSet = new Set(actualFields);

  for (const field of expectedFields) {
    if (!actualSet.has(field)) {
      mismatches.push({
        tool,
        section,
        field,
        kind: 'missing',
        expected: zodSignature(expected[field]),
        actual: '<absent>',
      });
    }
  }
  for (const field of actualFields) {
    if (!expectedSet.has(field)) {
      mismatches.push({
        tool,
        section,
        field,
        kind: 'unexpected',
        expected: '<absent>',
        actual: zodSignature(actual[field]),
      });
    }
  }
  for (const field of expectedFields) {
    if (!actualSet.has(field)) continue;
    const expectedSignature = zodSignature(expected[field]);
    const actualSignature = zodSignature(actual[field]);
    if (expectedSignature !== actualSignature) {
      mismatches.push({ tool, section, field, kind: 'shape', expected: expectedSignature, actual: actualSignature });
    }
  }

  return mismatches;
}

/**
 * Compares a mirrored tool descriptor against the gateway's captured declaration
 * on both halves, returning every field that does not line up.
 *
 * Consumers: `tests/voice-realtime-bridge.test.ts` runs it for all six tools
 * against `tests/realtime-bridge-harness.ts`'s capture of the gateway's own
 * registrations; the AC-2 false form runs it against a mutated mirror and
 * requires the mismatching field to be named.
 */
export function diffToolDescriptors(
  expected: { name: string; inputSchema: z.ZodRawShape; outputSchema: z.ZodRawShape },
  actual: { name: string; inputSchema: z.ZodRawShape; outputSchema: z.ZodRawShape },
): SchemaFieldMismatch[] {
  return [
    ...diffToolSchemas(expected.name, 'input', expected.inputSchema, actual.inputSchema),
    ...diffToolSchemas(expected.name, 'output', expected.outputSchema, actual.outputSchema),
  ];
}
