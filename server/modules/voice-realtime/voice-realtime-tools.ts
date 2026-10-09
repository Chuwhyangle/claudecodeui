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
 * The tool list the VOICE plane advertises: {@link REALTIME_TOOLS} with `session_send`'s
 * `session` made optional.
 *
 * WHY NOT THE MIRROR AS-IS. The mirror must match the MCP gateway field by field (AC-2),
 * and there `session` is required because an MCP client names its target. A voice
 * connection is bound to ONE session by the connection itself, and the instructions
 * tell the model never to name one. Advertising `session` as required therefore made
 * the real transport reject every call that obeyed the instructions
 * (`TOOL_ARGUMENT_SCHEMA_VIOLATION: session: expected string, received undefined`),
 * so the user's words were transcribed and then nothing ran. The executor already
 * treats an omitted `session` as the bound one and refuses a different one, so the
 * fix is to stop advertising it as mandatory, not to loosen the executor.
 */
export const VOICE_REALTIME_TOOLS: readonly RealtimeToolDescriptor[] = REALTIME_TOOLS.map((tool) =>
  tool.name === 'session_send'
    ? { ...tool, inputSchema: { ...tool.inputSchema, session: z.string().optional() } }
    : tool,
);

/** The descriptors keyed by name, so the bridge routes a function call by tool NAME. */
export const REALTIME_TOOLS_BY_NAME: Readonly<Record<RealtimeToolName, RealtimeToolDescriptor>> =
  Object.fromEntries(REALTIME_TOOLS.map((tool) => [tool.name, tool])) as Record<
    RealtimeToolName,
    RealtimeToolDescriptor
  >;

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
