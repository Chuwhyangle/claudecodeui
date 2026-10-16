/**
 * The MCP gateway's composer-draft tools (gap-mcp-draft-get-set-submit).
 *
 * A session's unsent composer text — its DRAFT — already persists on the server
 * (`session_drafts`, written by the browser through `/api/user/drafts` and
 * re-read on every load), but before this task an external MCP caller could not
 * touch it. These three tools close that gap:
 *
 *  - `draft_get`    reads the draft for one session (scope `cloudcli:read`);
 *  - `draft_set`    replaces it, WITHOUT sending (scope `cloudcli:session:send`);
 *  - `draft_submit` sends it as an ordinary user turn and clears it (the same
 *                   scope, `cloudcli:session:send`).
 *
 * ## Why three tools rather than one tool with a verb argument
 *
 * The transport's `audited` seam takes exactly ONE required scope per
 * registration, so a single discriminated tool could not be read-scoped for its
 * read verb and send-scoped for its two write verbs at the same time: it would
 * either over-grant `cloudcli:session:send` to a plain read, or push the scope
 * decision into the handler and lose the wrapper's one refusal path. Splitting
 * the verbs keeps each verb's scope on its own registration, which is the same
 * shape `approvals_list` / `approval_answer` already use. The split is honest
 * about the storage too: `get` only reads, while `set` and `submit` are writes
 * and are registered through the write seam beside `session_send`.
 *
 * ## Why submission cannot be a second send path
 *
 * `draft_submit` does not write a transcript, queue a message, or start a run
 * itself. It reads the draft and hands the TEXT to the SAME injected control
 * service `session_send` uses — the one shared control service the WebSocket
 * gateway, the scheduled-message timer and the HTTP routes all use — under the
 * identical caller (`{ userId, via: 'mcp' }`). A turn it submits is therefore
 * indistinguishable from a user-typed send: one path, one run registry, one
 * recorded origin.
 *
 * ## What these tools do NOT do
 *
 * They do not COMPOSE a message: `draft_set` replaces the stored text only. And
 * they do not clear a queued message — a draft and a queued turn are two
 * separate things in the same record, so `draft_set` and `draft_submit` carry
 * the queued-message half through untouched.
 *
 * Everything is injected ({@link McpDraftDeps} plus the control seam and run
 * reader for the submit verb). Production wires the process singletons
 * (`server/index.ts`: the `session_drafts` repository and `chatControl`); the
 * criterion wires a real store over a temp database and a spied control service.
 */

import { z } from 'zod';

import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';
import type { McpReadToolContext, McpReadToolSeam } from './mcp-gateway.read-tools.js';
import type { McpWriteToolSeam } from './mcp-gateway.write-tools.js';
import type { McpControlCaller, McpControlSeam, McpRunReader } from './mcp-session-send.js';

// --------------------------- the three tool names ---------------------------

/**
 * The three names, declared here because both seams name them: `read-tools.ts`
 * registers {@link DRAFT_GET_TOOL_NAME} on its side and `write-tools.ts`
 * registers the other two, and neither module should have to reach through the
 * other for a name.
 */
export const DRAFT_GET_TOOL_NAME = 'draft_get';
export const DRAFT_SET_TOOL_NAME = 'draft_set';
export const DRAFT_SUBMIT_TOOL_NAME = 'draft_submit';

/** What `draft_get` says it does on `tools/list`. */
export const DRAFT_GET_DESCRIPTION =
  'Read the unsent composer draft for a session, exactly as the composer would restore it.';

/** What `draft_set` says it does on `tools/list`. */
export const DRAFT_SET_DESCRIPTION =
  'Replace the unsent composer draft for a session without sending it. An empty text clears the draft; a queued message is left untouched.';

/** What `draft_submit` says it does on `tools/list`. */
export const DRAFT_SUBMIT_DESCRIPTION =
  "Submit the session's unsent composer draft as an ordinary user turn, through the same path the composer sends with, and clear the draft.";

// --------------------------- the draft store ---------------------------

/**
 * One stored draft, structurally: the scope (a session id), the unsent text,
 * and the message queued behind an in-flight turn.
 */
export type McpDraftRecord = {
  scope: string;
  text: string;
  queuedMessage: unknown | null;
};

/**
 * The draft storage these tools reuse — deliberately the SHAPE of the existing
 * `sessionDraftsDb` repository rather than a new abstraction over it.
 *
 * `getDrafts` reads every draft the user owns (the same call the browser's
 * hydrate route makes), so a per-session read is one filtered lookup and no new
 * storage method has to exist. `saveDraft` is the one writer: it stores the
 * text, and — because the repository deletes a row nothing is left in — setting
 * an empty text with no queued message clears the draft for good.
 */
export type McpDraftStore = {
  getDrafts(userId: number): ReadonlyArray<McpDraftRecord>;
  saveDraft(userId: number, scope: string, draft: { text: string; queuedMessage: unknown | null }): void;
};

/** The services the draft tools answer from. */
export type McpDraftDeps = {
  drafts: McpDraftStore;
};

/**
 * What `draft_submit` needs on top of the store: the ONE control service, and
 * the run registry the submitted run's recorded origin is read back from. Both
 * are the same seams `session_send` takes, passed down from `write-tools.ts`.
 */
export type McpDraftSubmitDeps = McpDraftDeps & {
  control: McpControlSeam;
  runs: McpRunReader;
};

// --------------------------- input and payload ---------------------------

/** `draft_get`'s typed input. */
export type McpDraftGetInput = { session: string };

/** `draft_set`'s typed input. `text` may be empty, which clears the draft. */
export type McpDraftSetInput = { session: string; text: string };

/** `draft_submit`'s typed input. */
export type McpDraftSubmitInput = { session: string };

/** `draft_get`'s arguments. */
export const DRAFT_GET_INPUT_SCHEMA = {
  session: z.string(),
} satisfies z.ZodRawShape;

/** `draft_get`'s reading: the text still in the composer, verbatim. */
export const DRAFT_GET_OUTPUT_SCHEMA = {
  session: z.string(),
  text: z.string(),
  queuedMessage: z.unknown(),
} satisfies z.ZodRawShape;

/** `draft_set`'s arguments. An empty `text` clears the draft. */
export const DRAFT_SET_INPUT_SCHEMA = {
  session: z.string(),
  text: z.string(),
} satisfies z.ZodRawShape;

/** `draft_set`'s reading. */
export const DRAFT_SET_OUTPUT_SCHEMA = {
  session: z.string(),
  text: z.string(),
  cleared: z.boolean(),
} satisfies z.ZodRawShape;

/** `draft_submit`'s arguments. */
export const DRAFT_SUBMIT_INPUT_SCHEMA = {
  session: z.string(),
} satisfies z.ZodRawShape;

/**
 * `draft_submit`'s reading: the delivery the draft turned into, and the turn it
 * belongs to (SPEC §8.1).
 *
 * `runId` is nullable because a resident session's send has no turn when it
 * answers: inside the run-id backfill window the field states the delivery id
 * instead, and past the window it is stated as `null`. `deliveryId` is the id
 * that always exists for an accepted submit.
 */
export const DRAFT_SUBMIT_OUTPUT_SCHEMA = {
  session: z.string(),
  deliveryId: z.string().nullable(),
  runId: z.string().nullable(),
  queued: z.boolean(),
  source: z.string(),
} satisfies z.ZodRawShape;

/**
 * The `SESSION_BUSY` hint `draft_submit` carries. It says what happened to the
 * draft too, because that is the caller's first question after a refusal.
 */
const SUBMIT_BUSY_HINT =
  'This session already has a run in progress; use run_get to follow it, or retry later. The draft was left untouched.';

/** Reads `draft_get`'s arguments off the validated `args`. */
export function readDraftGetInput(args: Record<string, unknown>): McpDraftGetInput {
  return { session: readSessionArgument(args) };
}

/** Reads `draft_set`'s arguments off the validated `args`. */
export function readDraftSetInput(args: Record<string, unknown>): McpDraftSetInput {
  const text = args.text;
  if (typeof text !== 'string') {
    throw new McpToolError(MCP_ERROR_CODES.INVALID_ARGUMENT, '"text" is required and must be a string.');
  }
  return { session: readSessionArgument(args), text };
}

/** Reads `draft_submit`'s arguments off the validated `args`. */
export function readDraftSubmitInput(args: Record<string, unknown>): McpDraftSubmitInput {
  return { session: readSessionArgument(args) };
}

/** The one `session` argument all three tools take, checked the same way. */
function readSessionArgument(args: Record<string, unknown>): string {
  const session = args.session;
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"session" is required and must be a non-empty string.',
    );
  }
  return session;
}

// --------------------------- reading the store ---------------------------

/**
 * The token owner's id.
 *
 * `withMcpAudit` denies a null principal before any handler runs, so this is
 * unreachable in production; it is stated rather than asserted so a future
 * wrapper change fails as a typed envelope instead of a crash.
 */
function requireUserId(ctx: { principal: McpPrincipal | null } | undefined): number {
  const userId = ctx?.principal?.userId;
  if (typeof userId !== 'number') {
    throw new McpToolError(
      MCP_ERROR_CODES.INTERNAL_ERROR,
      'The draft store requires an authenticated caller.',
    );
  }
  return userId;
}

/** One session's stored record, or `undefined` when it has none. */
function findDraft(deps: McpDraftDeps, userId: number, scope: string): McpDraftRecord | undefined {
  return deps.drafts.getDrafts(userId).find((record) => record.scope === scope);
}

// --------------------------- the handlers ---------------------------

/** The `draft_get` reading: the stored text verbatim, and any queued message. */
export function buildDraftGet(
  input: McpDraftGetInput,
  ctx: McpReadToolContext | undefined,
  deps: McpDraftDeps,
): { session: string; text: string; queuedMessage: unknown | null } {
  const userId = requireUserId(ctx);
  const record = findDraft(deps, userId, input.session);
  return {
    session: input.session,
    text: record?.text ?? '',
    queuedMessage: record?.queuedMessage ?? null,
  };
}

/**
 * The `draft_set` reading: the draft is now exactly `input.text`.
 *
 * The queued-message half of the record is carried through untouched — this tool
 * writes the composer text and nothing else — so a caller that only stages text
 * cannot silently drop a message the user queued. An empty `text` with no queued
 * message is the record's own delete case, and `cleared` says so.
 */
export function buildDraftSet(
  input: McpDraftSetInput,
  ctx: { principal: McpPrincipal },
  deps: McpDraftDeps,
): { session: string; text: string; cleared: boolean } {
  const userId = requireUserId(ctx);
  const queuedMessage = findDraft(deps, userId, input.session)?.queuedMessage ?? null;
  deps.drafts.saveDraft(userId, input.session, { text: input.text, queuedMessage });
  return {
    session: input.session,
    text: input.text,
    cleared: input.text === '' && queuedMessage === null,
  };
}

/**
 * The `draft_submit` reading: the draft became a real user turn.
 *
 * Order matters. The draft is read first and an empty one is refused with
 * `DRAFT_EMPTY` BEFORE the control service is asked to send, so an empty submit
 * starts no run and writes no message. Only then is the text handed to the
 * shared control service as the token owner — the identical call `session_send`
 * makes — and only after that call SUCCEEDS is the draft cleared, so a refusal
 * leaves the user's text where it was.
 *
 * Consumers: `write-tools.ts`'s `registerMcpWriteTools`, and this module's
 * criterion, which drives it through the real mount.
 */
export async function buildDraftSubmit(
  input: McpDraftSubmitInput,
  ctx: { principal: McpPrincipal },
  deps: McpDraftSubmitDeps,
): Promise<{
  session: string;
  deliveryId: string | null;
  runId: string | null;
  queued: boolean;
  source: string;
}> {
  const userId = requireUserId(ctx);
  const record = findDraft(deps, userId, input.session);
  const text = record?.text ?? '';

  if (text.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.DRAFT_EMPTY,
      'The session has no unsent composer text, so there is nothing to submit.',
      false,
      { session: input.session },
    );
  }

  const caller: McpControlCaller = { userId, via: 'mcp' };
  const result = await deps.control.send(caller, { sessionId: input.session, content: text });

  if (!result.ok) {
    if (result.code === 'RUN_IN_PROGRESS') {
      const current = deps.runs.getRun(input.session);
      const message = result.message.trim().length > 0 ? result.message : SUBMIT_BUSY_HINT;
      throw new McpToolError(MCP_ERROR_CODES.SESSION_BUSY, message, true, {
        runId: current?.runId ?? null,
        hint: SUBMIT_BUSY_HINT,
      });
    }
    throw new McpToolError(result.code, result.message, true);
  }

  // The turn is on its way, so the composer must stop showing text that has
  // already been sent: clear the TEXT and carry the queued-message half through
  // exactly as `draft_set` does.
  deps.drafts.saveDraft(userId, input.session, { text: '', queuedMessage: record?.queuedMessage ?? null });

  return {
    session: input.session,
    deliveryId: result.deliveryId ?? null,
    runId: result.runId,
    queued: result.queued,
    source: deps.runs.getRun(input.session)?.source ?? 'mcp',
  };
}

// --------------------------- registration ---------------------------

/**
 * One tool's metadata as the registration sites hand it down. The name,
 * description and scope come from the caller — `read-tools.ts` and
 * `write-tools.ts` are the one statement of the name sets they own.
 */
export type McpDraftRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema: z.ZodRawShape;
};

/** Registers `draft_get` through the audited READ seam. */
export function registerMcpDraftGetTool(
  seam: McpReadToolSeam,
  deps: McpDraftDeps,
  registration: McpDraftRegistration,
): void {
  seam({
    ...registration,
    handler: (args, ctx) => buildDraftGet(readDraftGetInput(args), ctx, deps),
  });
}

/** Registers `draft_set` through the audited WRITE seam. */
export function registerMcpDraftSetTool(
  seam: McpWriteToolSeam,
  deps: McpDraftDeps,
  registration: McpDraftRegistration,
): void {
  seam({
    ...registration,
    handler: (args, ctx) => buildDraftSet(readDraftSetInput(args), ctx, deps),
  });
}

/** Registers `draft_submit` through the audited WRITE seam. */
export function registerMcpDraftSubmitTool(
  seam: McpWriteToolSeam,
  deps: McpDraftSubmitDeps,
  registration: McpDraftRegistration,
): void {
  seam({
    ...registration,
    handler: (args, ctx) => buildDraftSubmit(readDraftSubmitInput(args), ctx, deps),
  });
}
