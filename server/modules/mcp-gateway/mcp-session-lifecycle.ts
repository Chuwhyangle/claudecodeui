/**
 * The MCP gateway's `session_create` / `session_interrupt` handlers (AC-250).
 *
 * These are the two stage-4 write tools that create and stop a session. Both are
 * ADAPTERS: they translate a tool call into calls on the production services the
 * WebSocket gateway already uses — `sessionsService.createAppSession` and the
 * shared `ChatControlService`'s `send` / `abort` — and translate the services'
 * structured answers back into the JSON-bodied payload the audited registration
 * seam renders.
 *
 * `session_create` creates the session ROW first, then, only when a non-empty
 * `message` was given, opens the first run through the SAME control service a UI
 * send uses and returns the run's id alongside the session's. With no message the
 * control service is never called, so "created a session" and "started a run"
 * stay different acts: the run id is produced by exactly one thing (a real send)
 * and its absence is the honest reading of "no run was started".
 *
 * The lifecycle preference is stored before the opening send, and when the
 * caller names no `lifecycleMode` it is chosen per provider: `claude` — the one
 * provider the resident host subsystem (`server/modules/session-hosts/`) was
 * built for, and the only one whose capability matrix declares `resident` —
 * defaults to `resident`, while every other provider falls through to the row's
 * own DB default (`per-run`) untouched. An explicit `lifecycleMode`, in either
 * direction, always wins over that default. The choice lives here, not in the
 * `lifecycle_mode` column's `DEFAULT`: the schema default is what a provider
 * with no resident capability keeps, and moving it would retroactively
 * reinterpret every stored row.
 *
 * A `permissionMode` argument closes the race between "create a session with a
 * first message" and "the mode that first message runs under": the mode is
 * checked against the provider's capability matrix before anything is created,
 * recorded on the row, and carried on the opening send so the first child spawns
 * with it — no `session_reconfigure` round-trip is needed before the message, so
 * that first turn is not left paused on an unattended permission prompt.
 *
 * AC-337 adds the optional opaque `correlationId` label to `session_create`: the
 * opening send's run is stamped with it (through the optional
 * {@link McpSessionCreateDeps.runs} seam, addressed by run id), and the call's
 * own audit row carries it through the wrapper. A create with no message opens no
 * run and so stamps nothing; a create with no label behaves exactly as before.
 *
 * `session_interrupt` stops the run a session currently has and NOTHING ELSE.
 * It calls the control service's `abort` and reports what that answered: a
 * resident session's process is owned by its host driver, so interrupting leaves
 * the process (and its pid) untouched — the adapter has no host-manager seam to
 * close a host with, which is what makes "the resident process survives" a
 * property of the shape rather than of a branch a later edit could flip. An idle
 * session is reported as `aborted: false` with a message that literally says
 * there was no run to abort, never as a fabricated success.
 *
 * Everything is injected ({@link McpSessionCreateDeps} /
 * {@link McpSessionInterruptDeps}): production wires the process singletons
 * (`server/index.ts`); the criterion wires the real `sessionsService` and the
 * real control service over its own fixture. The `project` / `session` arguments
 * arrive already rewritten to an id by AC-246's target gate, which is why the
 * create path only has to look the id up, never resolve a name itself.
 */

import { z } from 'zod';

import type { providerCapabilitiesService, providerModelsService } from '@/modules/providers/index.js';
import type { LLMProvider, SessionLaunchSelection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { MCP_ERROR_CODES, McpToolError, type McpErrorDetails } from './mcp-error-envelope.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';
import { MCP_CORRELATION_ID_INPUT_FIELD, readCorrelationId } from './mcp-correlation-id.js';
import type { McpControlCaller, McpControlRefusalCode, McpControlSeam, McpRunReader } from './mcp-session-send.js';

// --------------------------- injected services ---------------------------

/**
 * One project a `session_create` call may target, as the write tool reads it.
 *
 * Structurally satisfied by AC-245's `McpProjectPage` (the `projects_list` read
 * shape): `id` is what AC-246's gate leaves in the `project` argument, `path` is
 * the filesystem path `createAppSession` is given, and `title` is unused here
 * but kept so one project projection serves both read and write callers.
 */
export type McpProjectEntry = {
  id: string;
  title: string;
  path: string;
};

/**
 * The `abort` verb of the shared control service, as `session_interrupt` reads
 * it.
 *
 * `ok: false` is the control service's own structured refusal (a missing session
 * / provider, or a caller not allowed to abort); `ok: true` carries the
 * provider's own answer, where `aborted: false` means there was no run in flight
 * to stop — never a fabricated stop.
 */
export type McpControlAbortResult =
  | { ok: true; aborted: boolean }
  | { ok: false; aborted: false; code: McpControlRefusalCode; message: string };

/** The one control verb `session_interrupt` needs: stopping a run. */
export type McpControlAbortSeam = {
  abort(caller: McpControlCaller, input: { sessionId: string }): Promise<McpControlAbortResult>;
};

/**
 * The services `session_create` answers from, all injected.
 *
 * `projects.list()` is the active-project projection (production:
 * `getProjectsWithSessions`); `sessions.create` /
 * `sessions.switchLifecycle` are `sessionsService.createAppSession` /
 * `sessionsService.switchSessionLifecycleMode`; `control` is the shared chat
 * control service. Narrowing `sessions` to the two members this tool reads keeps
 * the criterion from having to stand up the whole service surface.
 */
export type McpSessionCreateDeps = {
  projects: {
    list(): ReadonlyArray<McpProjectEntry>;
  };
  sessions: {
    create(
      provider: LLMProvider,
      projectPath: string,
      initialMessage: string,
      selection?: SessionLaunchSelection,
    ): { sessionId: string };
    switchLifecycle(provider: LLMProvider, sessionId: string, mode: string): unknown;
  };
  control: McpControlSeam;
  /**
   * AC-337: the run-registry seam `session_create` stamps its optional
   * `correlationId` label through, addressed by the run id the opening send
   * answered with. The SAME seam `session_send` is handed — `session_create`
   * opens its first run through the same control service, so its label has to
   * land in the same place.
   *
   * OPTIONAL so every mount that predates AC-337 stays a valid
   * `McpSessionCreateDeps`: absent, a labelled create simply stamps nothing and
   * the label still reaches the call's audit row. `registerMcpWriteTools` passes
   * the write bag's own `runs` here (the `draft_submit` precedent: the
   * registration site is the one place that knows both halves), so production
   * wires it without a second assembly.
   */
  runs?: McpRunReader;
  /**
   * The provider capability matrix, read exactly the way `session_reconfigure`
   * reads it, so an unsupported `permissionMode` is refused with the supported
   * list instead of being recorded and rejected later by the runtime.
   *
   * OPTIONAL so the pre-permissionMode wiring (and its AST-scanning criterion,
   * AC-278) keeps compiling untouched. A caller that supplies no `permissionMode`
   * never reads it; a caller that does, with the matrix unwired, fails closed —
   * an unverifiable mode is refused rather than written.
   */
  capabilities?: Pick<typeof providerCapabilitiesService, 'getProviderCapabilities'>;
  /** The session-row writer for the recorded permission mode (the same service `session_reconfigure` uses). */
  models?: Pick<typeof providerModelsService, 'setSessionPermissionMode'> & {
    /**
     * The catalog reader that refuses a model the app cannot select. It is the
     * SAME `providerModelsService.assertSelectableModel` the HTTP session
     * gateway calls, and it is what makes this tool's long-declared `model`
     * argument mean something.
     *
     * OPTIONAL for the reason every seam member here is: a mount that hand-writes
     * its own `models` (several criteria do) stays valid. Production wires the
     * whole `providerModelsService`, so it is always present there. When it is
     * absent the model is still recorded — the fix does not depend on the guard —
     * only the typo check is skipped.
     */
    assertSelectableModel?: typeof providerModelsService.assertSelectableModel;
  };
};

/** The services `session_interrupt` answers from. */
export type McpSessionInterruptDeps = {
  control: McpControlAbortSeam;
};

// --------------------------- input and payload ---------------------------

/** The `session_create` tool's typed input. */
export type McpSessionCreateInput = {
  /** The target project; the transport's target gate resolves a name to an id first. */
  project: string;
  /** The first message. Absent or empty means "create the session, start nothing". */
  message?: string;
  /** The provider to create the session under; absent means `claude`. */
  provider?: LLMProvider;
  /** The model preference recorded on the session. */
  model?: string;
  /**
   * The lifecycle mode to store before any turn runs. Absent means the
   * provider-scoped default: `resident` for Claude (the resident host
   * subsystem's provider), the row's untouched DB default `per-run` for every
   * other provider. An explicit value wins over that default.
   */
  lifecycleMode?: string;
  /**
   * The permission mode the FIRST run should launch under.
   *
   * Checked against the provider's capability matrix before anything is created
   * (an unsupported value is refused), recorded on the session row so later
   * turns inherit it, and carried on the opening send's run options so the very
   * first child spawns with it — no `session_reconfigure` round-trip before the
   * message, which is what makes an unattended first turn possible.
   */
  permissionMode?: string;
  /**
   * AC-337's opaque correlation label, when the caller supplied a usable one.
   * It labels the FIRST run (the one the optional `message` opens) — a create
   * with no message opens no run, so it has nothing to label and the value only
   * reaches the call's audit row.
   */
  correlationId?: string;
};

/** The `session_create` tool's Zod input shape, used for registration and validation. */
export const SESSION_CREATE_INPUT_SCHEMA = {
  project: z.string(),
  message: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  lifecycleMode: z.string().optional(),
  permissionMode: z.string().optional(),
  // AC-337: the one declaration of the label's contract (see
  // `mcp-correlation-id.ts`), splices in so `tools/list` advertises it.
  correlationId: MCP_CORRELATION_ID_INPUT_FIELD.optional(),
} satisfies z.ZodRawShape;

/**
 * The `session_create` result.
 *
 * `runId` is present ONLY when the caller supplied a message, because it is the
 * id of the run that send actually opened — omitting the field is how "no run
 * was started" reaches a caller rather than a null placeholder it might read as
 * "a run whose id we do not know".
 */
export type SessionCreatePayload = {
  sessionId: string;
  /**
   * The delivery the opening message was accepted as (SPEC §8.1). Present ONLY
   * when a message was supplied, for the same reason `runId` is: it is the id of
   * the send that actually happened, and omitting the field is how "no run was
   * started" reaches a caller.
   */
  deliveryId?: string | null;
  /**
   * The turn's run id for the opening message, or `null` when the delivery has
   * not bound to a turn and the backfill window has closed (SPEC §8.3). Inside
   * the window an unbound send states the `deliveryId` here.
   */
  runId?: string | null;
};

/** The `session_interrupt` tool's typed input. */
export type McpSessionInterruptInput = {
  /** The session to interrupt; the gate resolves a title fragment to an id first. */
  session: string;
};

/** The `session_interrupt` tool's Zod input shape. */
export const SESSION_INTERRUPT_INPUT_SCHEMA = {
  session: z.string(),
} satisfies z.ZodRawShape;

/**
 * The `session_interrupt` result.
 *
 * `aborted: true` means a run was in flight and the provider stopped it.
 * `aborted: false` means there was nothing to stop; it carries a message saying
 * so, so a caller is never left to read a silent `false` as an error.
 */
export type SessionInterruptPayload = {
  aborted: boolean;
  message?: string;
};

/**
 * The idle reading `session_interrupt` returns. The phrase "no run to abort" is
 * load-bearing: it is what AC-250's criterion matches, and what tells a caller
 * the `false` is "nothing was running" rather than "the stop failed".
 */
const NO_RUN_TO_ABORT_MESSAGE = 'This session currently has no run in flight, so there is no run to abort.';

/** Reads and validates `session_create`'s arguments. */
export function readSessionCreateInput(args: Record<string, unknown>): McpSessionCreateInput {
  const project = args.project;
  if (typeof project !== 'string' || project.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"project" is required and must be a non-empty string.',
    );
  }
  const message = typeof args.message === 'string' ? args.message : undefined;
  const provider = typeof args.provider === 'string' ? (args.provider as LLMProvider) : undefined;
  const model = typeof args.model === 'string' ? args.model : undefined;
  const lifecycleMode = typeof args.lifecycleMode === 'string' ? args.lifecycleMode : undefined;
  const permissionMode = typeof args.permissionMode === 'string' ? args.permissionMode : undefined;
  // AC-337: the shared reading — absent and unusable both read `undefined`, so a
  // label-less create takes no extra branch anywhere below.
  const correlationId = readCorrelationId(args.correlationId) ?? undefined;
  return {
    project,
    message,
    provider,
    model,
    lifecycleMode,
    permissionMode,
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

/** Reads and validates `session_interrupt`'s arguments. */
export function readSessionInterruptInput(args: Record<string, unknown>): McpSessionInterruptInput {
  const session = args.session;
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"session" is required and must be a non-empty string.',
    );
  }
  return { session };
}

// --------------------------- buildSessionCreate ---------------------------

/**
 * Creates a session under `input.project`, starting a run only when a message
 * was given.
 *
 * The `project` argument is an id already (the target gate resolved it), so the
 * only lookup left is id -> project row, and a miss is a structured
 * `PROJECT_NOT_FOUND` thrown BEFORE anything is created — an id that names no
 * project must not mint a session. The row is created through the injected
 * `sessions.create`; the lifecycle preference is stored BEFORE the send,
 * because a resident session must be resident at dispatch time rather than
 * after its first turn. When the caller names no preference the mode is chosen
 * per provider — `resident` for Claude, unchanged for every other provider (see
 * the branch below) — and an explicit preference always wins.
 *
 * A non-empty message is sent through the same control service the WebSocket
 * gateway uses, with the token's owner as caller, and the resulting run id is
 * returned verbatim. A refusal from the control service carries the created
 * session's id in its body — the row exists whether or not the first send
 * succeeded, and hiding that would make the caller create a second session for a
 * conversation that already has one.
 *
 * Consumers: `registerMcpWriteTools` (the registered handler) and this module's
 * criterion, which drives it through the real mount.
 */
export async function buildSessionCreate(
  input: McpSessionCreateInput,
  ctx: { principal: McpPrincipal },
  deps: McpSessionCreateDeps,
): Promise<SessionCreatePayload> {
  const entry = deps.projects.list().find((project) => project.id === input.project);
  if (entry === undefined) {
    throw new McpToolError(MCP_ERROR_CODES.PROJECT_NOT_FOUND, `No project has id "${input.project}".`);
  }

  const provider = input.provider ?? ('claude' as LLMProvider);

  // Refuse an unsupported permission mode BEFORE the row exists: the same read
  // `session_reconfigure` performs, against the same matrix. With the matrix
  // unwired (the legacy wiring) an unverifiable mode fails closed rather than
  // being written and rejected later by the runtime.
  if (input.permissionMode !== undefined) {
    const supported = deps.capabilities?.getProviderCapabilities(provider)?.permissionModes ?? [];
    if (!supported.includes(input.permissionMode)) {
      throw new McpToolError(
        MCP_ERROR_CODES.UNSUPPORTED_PERMISSION_MODE,
        `Provider "${provider}" does not support permission mode "${input.permissionMode}"; supported: ${supported.join(', ') || 'none'}.`,
        false,
        { supported: [...supported] },
      );
    }
  }

  // Refuse a model the app cannot select BEFORE the row exists, exactly as the
  // permission mode below is refused. This argument had been declared and read
  // since this tool was written and then dropped on the floor: a caller asking
  // for "sonnet" got a session with no recorded model, whose first (options-less)
  // run launched with the CLI's account default instead. An unwired catalog
  // reader skips the check rather than the recording — the model still lands on
  // the row — because the guard is a typo check, not the fix.
  let model = typeof input.model === 'string' ? input.model.trim() : '';
  if (model && deps.models?.assertSelectableModel) {
    try {
      model = await deps.models.assertSelectableModel(provider, model);
    } catch (error) {
      // The catalog reader answers an HTTP-shaped `AppError`; this transport
      // speaks its own envelope, and an untranslated throw would reach the caller
      // as INTERNAL_ERROR — an argument mistake reported as a server fault. The
      // supported list rides along in `details`, the same shape
      // `UNSUPPORTED_PERMISSION_MODE` uses for its own argument refusal.
      if (error instanceof AppError) {
        const details = error.details as McpErrorDetails | undefined;
        throw new McpToolError(MCP_ERROR_CODES.INVALID_ARGUMENT, error.message, false, details);
      }
      throw error;
    }
  }

  const created = deps.sessions.create(
    provider,
    entry.path,
    input.message ?? '',
    model ? { model } : undefined,
  );

  // Record the mode on the row right after creation, so it is readable even when
  // no message follows (the session is configured, just not started) and every
  // later turn inherits it.
  if (input.permissionMode !== undefined && deps.models !== undefined) {
    deps.models.setSessionPermissionMode(provider, created.sessionId, input.permissionMode);
  }

  // Both branches store the preference BEFORE the send, because the mode is read
  // at dispatch time: a resident session whose preference were stored after the
  // first turn would run that turn per-run and only become resident once it had
  // already ended.
  //
  // The mode is the caller's when they named one — an explicit preference is
  // never overridden by the default — and otherwise chosen per provider: Claude
  // is the one provider the resident host subsystem
  // (`server/modules/session-hosts/`) was built for and the only one whose
  // capability matrix declares `resident`, so a Claude session that names no mode
  // defaults to `resident`. Every other provider takes the second branch's miss
  // and falls through to the row's own DB default (`per-run`) with NO call here.
  // The default lives in this handler, not in the schema: the column's
  // `DEFAULT 'per-run'` is what every provider keeps, and a provider that gains
  // `resident` later is served by widening this branch rather than by a
  // migration that would retroactively reinterpret every stored row.
  if (input.lifecycleMode !== undefined) {
    deps.sessions.switchLifecycle(provider, created.sessionId, input.lifecycleMode);
  } else if (provider === 'claude') {
    deps.sessions.switchLifecycle(provider, created.sessionId, 'resident');
  }

  const message = input.message;
  if (message === undefined || message.length === 0) {
    return { sessionId: created.sessionId };
  }

  const caller: McpControlCaller = { userId: ctx.principal.userId, via: 'mcp' };
  // The mode rides on the opening send's options so the FIRST child spawns with
  // it. When no mode was given the send input is byte-for-byte what it always
  // was (no `options` key at all), which is what keeps the old call shape a
  // reading rather than a convention.
  const sent = await deps.control.send(
    caller,
    input.permissionMode === undefined
      ? { sessionId: created.sessionId, content: message }
      : { sessionId: created.sessionId, content: message, options: { permissionMode: input.permissionMode } },
  );
  if (!sent.ok) {
    throw new McpToolError(sent.code, sent.message, false, { sessionId: created.sessionId });
  }
  // AC-337 / SPEC §6.1: the label the caller attached labels the DELIVERY this
  // create's opening message was accepted as — addressed by delivery id, exactly
  // the way `session_send` stamps its own, and for the same reason: a create that
  // launches a resident session has no bound turn when the send answers, so the
  // delivery id is the only id that exists. The run-addressed write is the
  // fallback for a mount (or a send) that named no delivery. A create that
  // carried no label touches the registry not at all, and a mount with no
  // registry seam wired stamps nothing rather than failing the create.
  if (input.correlationId !== undefined) {
    const deliveryId = sent.deliveryId ?? null;
    const stamped =
      deliveryId !== null
        ? (deps.runs?.setDeliveryCorrelationId?.(deliveryId, input.correlationId) ?? false)
        : false;
    if (!stamped && sent.runId !== null) {
      deps.runs?.setRunCorrelationId?.(sent.runId, input.correlationId);
    }
  }
  return { sessionId: created.sessionId, deliveryId: sent.deliveryId ?? null, runId: sent.runId };
}

// --------------------------- buildSessionInterrupt ---------------------------

/**
 * Interrupts the run `input.session` currently has, leaving its host alone.
 *
 * The control service's `abort` decides: `ok: false` is passed through verbatim
 * (code and message), `ok: true` reports the provider's own answer. When there
 * was no run in flight the payload says so in words — the adapter adds the
 * explanation, it never rewrites `aborted`.
 *
 * The adapter calls ONLY `abort`. It holds no host-manager seam, so it cannot
 * close a resident host or kill a process: "the resident process survives an
 * interrupt" is therefore a property of the adapter's shape, not of a check it
 * performs.
 *
 * Consumers: `registerMcpWriteTools` (the registered handler) and this module's
 * criterion, which reads the resident host's pid before and after.
 */
export async function buildSessionInterrupt(
  input: McpSessionInterruptInput,
  ctx: { principal: McpPrincipal },
  deps: McpSessionInterruptDeps,
): Promise<SessionInterruptPayload> {
  const caller: McpControlCaller = { userId: ctx.principal.userId, via: 'mcp' };
  const result = await deps.control.abort(caller, { sessionId: input.session });

  if (!result.ok) {
    throw new McpToolError(result.code, result.message);
  }
  if (result.aborted) {
    return { aborted: true };
  }
  return { aborted: false, message: NO_RUN_TO_ABORT_MESSAGE };
}
