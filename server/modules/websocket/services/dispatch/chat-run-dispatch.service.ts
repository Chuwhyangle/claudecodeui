import { randomUUID } from 'node:crypto';

import type { WebSocket } from 'ws';

import { sessionsDb } from '@/modules/database/index.js';
import { providerModelsService, sessionAwaitingReplyService } from '@/modules/providers/index.js';
import { voiceLexicon } from '@/modules/voice/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/dispatch/chat-run-registry.service.js';
import { filterAttachmentsToUploadStore } from '@/modules/websocket/services/dispatch/chat-attachment-filter.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/dispatch/chat-control.contract.js';
import { sendProtocolError } from '@/modules/websocket/services/websocket-protocol-error.js';
import {
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
} from '@/shared/image-attachments.js';
import { CHAT_TURN_OPTION, DELIVERY_SOURCE_OPTION } from '@/shared/types.js';
import type { AnyRecord, ChatRunSource, LLMProvider, RealtimeClientConnection } from '@/shared/types.js';
import { AppError, residentRunIsTurn } from '@/shared/utils.js';

/**
 * The slice of dependencies the run dispatcher reads.
 *
 * Declared structurally rather than as the transport's full dependency bag: the
 * dispatcher only ever reads the runtime gateway and the client-env seam, and
 * naming the transport's bag here would import the transport module back — the
 * edge that closed the `chat-control ⇄ chat-websocket` cycle this extraction
 * removed. Both callers (the transport and the control service) satisfy this
 * type without a cast.
 */
export type ChatRunDispatchDependencies = {
  /** Central dispatcher for every provider SDK/CLI runtime. */
  runtime: ProviderRuntimeGateway;
  /** Test seam: replaces the default that discards a client-supplied `options.env`. */
  dropClientEnv?: (options: AnyRecord) => AnyRecord;
};

/** The wire protocol carries the model selection; a client-supplied `options.env` is discarded. */
function withoutClientEnv(options: AnyRecord): AnyRecord {
  const { env: _ignoredClientEnv, ...rest } = options;
  return rest;
}

/**
 * Registers the run and hands the turn to the provider runtime.
 *
 * `extraRuntimeOptions` is how an edited message asks the provider to resume
 * partway instead of continuing from the tip; a normal send passes nothing.
 *
 * It lives in its own module (rather than in the WebSocket transport) so both
 * the transport and the transport-agnostic control service
 * (`chat-control.service.ts`) can import it without the two importing each
 * other: the control service's `send` calls this with `ws = null` and a
 * `beforeRun` hook, so a run opened by MCP or a timer is registered and
 * dispatched through the exact same path `chat.send` uses rather than a second
 * copy of the registry logic.
 *
 * `beforeRun`'s second argument states whether this dispatch took the
 * resident-session busy path — the registry refused the first `startRun`,
 * `acceptsBusyInput` answered yes, and the turn was admitted as a superseding
 * run. It is reported here, through the same hook that reports the run, because
 * the fact belongs to this function's own control flow: a caller that wants to
 * know "was this turn queued into a running process" must not re-derive it by
 * probing the registry, and existing callers (a plain `chat.send`, an edit)
 * simply ignore the extra argument.
 *
 * `connectionOverride` separates "who this run streams to" from "who a refusal
 * is written to". The transport-agnostic control service dispatches with
 * `ws = null` (it reports refusals as its own result, so `dispatchRun` must not
 * also write a `RUN_IN_PROGRESS` frame) but still binds the requesting socket as
 * the run's connection, so a `chat.send` driven through the control service
 * reaches the same audience as before. Left `undefined` by callers that only
 * ever have one socket, in which case `ws` is used.
 *
 * `source` is the run's recorded origin, when the caller knows one the
 * connection cannot state. The control service passes it explicitly because it
 * always dispatches with `ws = null` (and, for a WebSocket send, with a
 * connection override that is also null): without it, `startRun`'s
 * connection-derived default would file every run the service opens as
 * `scheduled`, including a `chat.send` that arrived over a socket and an MCP
 * tool call. Left `undefined` by callers that want `startRun`'s existing
 * default (a run with a connection is `user`, one without is `scheduled`).
 */
export async function dispatchRun(
  ws: WebSocket | null,
  userId: string | number | null,
  sessionId: string,
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  data: AnyRecord,
  dependencies: ChatRunDispatchDependencies,
  extraRuntimeOptions: AnyRecord = {},
  beforeRun?: (
    run: NonNullable<ReturnType<typeof chatRunRegistry.startRun>>,
    info: { busyAccepted: boolean },
  ) => void | Promise<void>,
  connectionOverride?: RealtimeClientConnection | null,
  /**
   * A synchronous notification that this dispatch was refused because the
   * session already has a run in progress.
   *
   * The refusal is decided before this function's first `await` (`startRun`
   * returning null and the provider not accepting busy input are both
   * synchronous), so a caller that never passes a socket — the shared control
   * service passes `ws = null` and translates the verdict itself — can still
   * report the refusal on the same tick `chat.send` arrived. Passed by the
   * control service alone; every other caller leaves it undefined.
   */
  onRefuse?: (refusal: { code: string; message: string }) => void,
  source?: ChatRunSource,
): Promise<{ started: boolean; error: string | null }> {
  const provider = session.provider as LLMProvider;

  // A session's upstream provider is part of what the provider started its
  // thread with, and it cannot be moved to another one in place (Codex answers
  // `modelProviderMismatch` on the turn; the thread is already bound). The
  // switch is therefore refused HERE — before the run is reserved — because the
  // recording write below (`setSessionModel`) refuses the same selection and
  // runs after `startRun`: a throw there would leave a `running` run with no
  // process behind it. Every send funnels through this function (`chat.send`
  // and `chat.edit-send` alike), so this is the one admission gate. A session
  // with no recorded binding — every session's first send — passes.
  const requestedModel = (data.options as AnyRecord | undefined)?.model;
  const requestedModelProviderId = (data.options as AnyRecord | undefined)?.modelProviderId;
  if (typeof requestedModel === 'string' && requestedModel.trim()) {
    try {
      providerModelsService.assertSessionProviderSwitch(
        provider,
        sessionId,
        requestedModel,
        typeof requestedModelProviderId === 'string' ? requestedModelProviderId : undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof AppError ? error.code : 'SESSION_PROVIDER_MISMATCH';
      if (ws) {
        sendProtocolError(ws, code, message, sessionId);
      }
      onRefuse?.({ code, message });
      return { started: false, error: message };
    }
  }

  const runIsTurn = residentRunIsTurn();
  // Whether a busy send from this provider would be taken by a process that is
  // already running. Read once, before the probe, because run=turn makes two
  // decisions out of one answer: a busy send that IS accepted must not open a run
  // of its own, and a send that cannot be busy-accepted keeps the per-run shape,
  // where the delivery and the run are born together (SPEC §6.1) — so the run is
  // labelled with the delivery this send itself is (SPEC §4.1: a non-resident
  // delivery id is the uuid minted at send time).
  const busyInputAccepted = dependencies.runtime.acceptsBusyInput?.(provider, sessionId) === true;

  const startInput = {
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: connectionOverride ?? ws,
    userId,
    source,
    // A run=turn run's deliveries are what the CLI's ledger binds to the turn; the
    // per-run shape has no ledger, so the only delivery such a run will ever hold
    // is this send's. Off the flag the field is not stated at all.
    ...(runIsTurn && !busyInputAccepted ? { deliveryIds: [randomUUID()] } : {}),
  };

  /** The run this dispatch is admitted under, or `null`/`undefined` when refused. */
  let run: ReturnType<typeof chatRunRegistry.startRun> | undefined;
  let busyAccepted = false;
  if (runIsTurn) {
    // RUN=TURN RETIRES THE SUPERSEDING RUN (SPEC §6.1). A resident session's run IS
    // its turn, so an accepted busy send is a DELIVERY of the turn already in
    // flight rather than a second run: the session keeps the run it has, this
    // command's frames are written through that run's writer, and the CLI's own
    // queue runs the command later. The answer to "can this session take the
    // send" is unchanged; only what it buys changes, from a run to a delivery.
    // Opening a run here was the shape that left the newest run `running` forever,
    // because the CLI folds the command into the turn already in flight and emits
    // only one `RESULT` for it (SPEC §1.2).
    //
    // The probe is not made on this path at all, and that is deliberate: a
    // `startRun` that returns null because the session is busy is a call that
    // mints nothing, so the reading "every startRun call minted a run" (what the
    // S2 criterion takes as evidence that no run is opened behind a turn) holds
    // only when the busy branch is decided by a READ rather than by a refused
    // write. `getRun` is that read; it changes nothing.
    const current = chatRunRegistry.getRun(sessionId);
    if (current && current.status === 'running') {
      // A busy session whose provider cannot take busy input keeps the refusal
      // below — `run` stays undefined, the duplicate-send answer, byte for byte
      // what a per-run session answers today. The provider is never entered.
      if (busyInputAccepted) {
        run = current;
        busyAccepted = true;
      }
    } else {
      run = chatRunRegistry.startRun(startInput);
    }
  } else {
    run = chatRunRegistry.startRun(startInput);

    // The refusal is asked first, and only then is the session asked whether it
    // can take this turn anyway. That order is what keeps the answer correct for
    // every provider that runs a process per turn: it never reaches the second
    // question, so its behaviour is byte-for-byte what it was. A provider that
    // holds one process across turns answers yes, and the turn gets a run of its
    // own — the registry holds one run per session, so `supersedeRunning` is how
    // the newer turn becomes the session's current one instead of being refused.
    // Note that the first call is a pure probe: it returns null precisely when it
    // has changed nothing, which is what makes the retry safe.
    if (!run && busyInputAccepted) {
      run = chatRunRegistry.startRun({ ...startInput, supersedeRunning: true });
      busyAccepted = run !== null;
    }
  }

  if (!run) {
    const message = `Session "${sessionId}" already has a run in progress.`;
    if (ws) {
      sendProtocolError(ws, 'RUN_IN_PROGRESS', message, sessionId);
    }
    // Reported synchronously, before this function's first `await` below, so a
    // socket front end that translated the verdict itself (the control
    // service's `chat.send` adapter) lands the frame on the same tick the old
    // inline handler did.
    onRefuse?.({ code: 'RUN_IN_PROGRESS', message });
    return { started: false, error: 'A run is already in progress for this session.' };
  }

  // A turn is starting, so whatever wait this session was on is over: the user
  // has said something, which is the first of the three ways an awaiting-reply
  // row ends (the other two are answering an approval, and dismissing the row).
  // Placed after the refusal above — a turn that was never accepted must not
  // silently empty a row the user still owes an answer to — and before the
  // provider is entered, so the row is gone for every path that opens a run.
  sessionAwaitingReplyService.clearSessionAwaitingReply(sessionId);

  const rawClientOptions = (data.options ?? {}) as AnyRecord;
  const clientOptions = (dependencies.dropClientEnv ?? withoutClientEnv)(rawClientOptions);
  const command = typeof data.content === 'string' ? data.content : '';

  // THE ONE PLACE a message the person composed is recorded into the U-source
  // lexicon. `dispatchRun` is the single funnel every accepted human turn passes
  // through — the control service's `chat.send` and the inline `chat.edit-send`
  // both land here — so this is the whole auto-record path, not one of several.
  // A second hook anywhere else would count a message twice, which is exactly the
  // number this index exists to report.
  //
  // It is deliberately AFTER the `!run` refusal above: a turn that was refused
  // because the session was busy was never sent, so its words are not something
  // the user said yet. `command` is what the comment below already calls "a
  // message somebody composed"; the injected prompts and credential-style
  // messages are filtered inside the lexicon, so no caller has to know the rules.
  voiceLexicon.observeSentText(command, session.project_path ?? '');

  // Record what this turn runs with so reopening the session later restores the
  // same model and reasoning effort, and so the resume path has a
  // session-scoped model answer to use.
  if (typeof clientOptions.model === 'string' && clientOptions.model.trim()) {
    providerModelsService.setSessionModel(
      provider,
      sessionId,
      clientOptions.model,
      typeof clientOptions.modelProviderId === 'string' ? clientOptions.modelProviderId : undefined,
    );
  }
  if (typeof clientOptions.effort === 'string' && clientOptions.effort.trim()) {
    providerModelsService.setSessionEffort(provider, sessionId, clientOptions.effort);
  }
  // The permission mode is a session attribute the client no longer persists
  // anywhere, so this send is the only place it can be recorded. Only a mode
  // the provider's capability matrix lists is stored; an unsupported one is
  // ignored rather than rejected, because the run still has to go out and the
  // client would otherwise be told its message failed over a display detail.
  if (typeof clientOptions.permissionMode === 'string' && clientOptions.permissionMode.trim()) {
    providerModelsService.setSessionPermissionMode(provider, sessionId, clientOptions.permissionMode);
  }

  const attachmentCandidates = [
    ...normalizeAttachmentDescriptors(clientOptions.images),
    ...normalizeAttachmentDescriptors(clientOptions.files),
    ...normalizeAttachmentDescriptors(clientOptions.attachments),
  ];
  const verifiedAttachments = filterAttachmentsToUploadStore(attachmentCandidates);
  const uniqueAttachments = verifiedAttachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );

  // The provider runtimes receive the stable app session id. When their
  // CLI/SDK needs the provider-native id for resume, they resolve it from the
  // session row themselves (sessionsService.resolveProviderSessionId).
  // Brand-new sessions have no provider id yet, so the runtime starts fresh
  // and announces one, which the gateway writer captures and maps back to the
  // app session id.
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    ...extraRuntimeOptions,
    // Attachments are re-validated server-side: only direct children of the
    // global upload store may reach provider runtimes or their file tools.
    attachments: uniqueAttachments,
    images: uniqueAttachments.filter(isImageAttachmentDescriptor),
    files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
    sessionId,
    cwd: clientOptions.cwd ?? session.project_path ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
    // This dispatch's `command` is a message somebody composed — typed now, or
    // scheduled earlier and fired by the timer below. Marked here and not left
    // to the runtime to infer, because the runtime cannot: an internal driver
    // reaching the same entry passes the same option keys with a *label* in
    // `command`, and a provider that records the prompt it was handed (the
    // debug agent, whose "process" runs a scenario instead of a CLI that would
    // write the row itself) has no other way to tell the two apart.
    [CHAT_TURN_OPTION]: true,
    // The DELIVERY's origin (SPEC §4.1, §6.1). The run record already carries the
    // source, but a resident delivery is built inside the host driver — the far
    // side of a module edge this file's own options bag is the only thing to
    // cross — so the run=turn path states it here too, and the delivery's snapshot
    // entry can say who asked. The default mirrors `startRun`'s own reading
    // (`source ?? connection ? 'user' : 'scheduled'`) so the two cannot disagree
    // about a send that stated nothing.
    //
    // Flag-gated on purpose: with run=turn off nothing projects a delivery, and the
    // options bag keeps the exact shape every existing provider and criterion
    // expects to see.
    ...(runIsTurn
      ? { [DELIVERY_SOURCE_OPTION]: source ?? ((connectionOverride ?? ws) ? 'user' : 'scheduled') }
      : {}),
  };

  let failure: string | null = null;
  try {
    // Runs only now that the session is reserved, because an edit rewinds the
    // conversation here and a rewind for a run that was never admitted cannot
    // be taken back. Inside the try so a rewind that throws still releases the
    // run instead of leaving the session processing forever.
    await beforeRun?.(run, { busyAccepted });
    await dependencies.runtime.run(provider, command, runtimeOptions, run.writer);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: failure });
  } finally {
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }

  return { started: true, error: failure };
}
