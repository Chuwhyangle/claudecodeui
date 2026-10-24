/**
 * The context event stream — the CloudCLI side of the host-level interaction
 * ledger, plus the shadow predictor that runs on top of it.
 *
 * TWO JOBS, ONE SEAM.
 *
 *   1. Append CloudCLI-produced events (an utterance, a chip, a cockpit focus or
 *      send, later a build/restart) to `~/.quay-fleet/context/events`.
 *   2. For every utterance, classify it, score the previous prediction, and mint
 *      the next `shadow.prediction`. Predictions go to the same file and to
 *      nowhere else.
 *
 * FAILURE IS CONTAINED. Recording is a side effect of a user's real action, never
 * a precondition for it: every path here catches its own errors, and `record`
 * resolves even when the writer rejects or throws. A missing fleet installation
 * turns the stream into `schema-unavailable` (zero writes), not a failed send.
 *
 * ORDERING. Calls are serialised through one promise chain, so an utterance is
 * on disk before the prediction it produced, and a `chip.picked` is always seen
 * before the utterance that follows it. The chain keeps running after a rejected
 * append, so one bad event cannot wedge the stream.
 *
 * Consumers: `server/index.ts` (installs the process instance and hands its
 * `record` to the chat-control, cockpit and reply-suggestions seams),
 * `server/modules/quay/quay.module.ts` (reads {@link readContextEventStatus} for
 * the fleet-summary reading beside it), and `tests/*`.
 */
import {
  CLOUDCLI_CONTEXT_EVENT_KINDS,
  createContextEventWriter,
  type AppendContextEventResult,
  type CloudCliContextEventKind,
  type ContextEventDraft,
  type ContextEventWriter,
  type ContextEventWriterStatus,
} from './context-event-writer.js';
import { createShadowPredictor, type ShadowPredictor } from './shadow-predictor.js';
import { UTTERANCE_CLASSES, classifyUtterance, type UtteranceClass } from './utterance-classifier.js';

/** A usage-ledger row from the reply-suggestions writer; only the fields this bridge reads. */
export type ReplySuggestionsUsageRecord = {
  type?: unknown;
  sessionId?: unknown;
  draw?: unknown;
  index?: unknown;
  source?: unknown;
  chips?: unknown;
};

/** The draft shape the production seams pass: a subset of a full event. */
export type ContextEventRecord = {
  kind: CloudCliContextEventKind;
  project?: string | null;
  session?: string | null;
  refs?: readonly string[];
  data?: Record<string, unknown>;
};

/** The stream surface consumed by the composition root and its criteria. */
export type ContextEvents = {
  /** Appends one event and runs the utterance flow. Never rejects. */
  record(event: ContextEventRecord): Promise<AppendContextEventResult | null>;
  /** Maps one reply-suggestions usage row to a `chip.*` event (other rows are ignored). */
  recordUsage(record: ReplySuggestionsUsageRecord): void;
  /** The writer's state, including whether the fleet schema was found. */
  status(): ContextEventWriterStatus;
  /** The predictor, exposed for backfill and criteria; not a UI seam. */
  predictor: ShadowPredictor;
};

/** Construction seams; every default is the real host. */
export type ContextEventsOptions = {
  homeDir?: string;
  eventsDir?: string;
  schemaPath?: string | null;
  env?: Record<string, string | undefined>;
  now?: () => number;
  newId?: (nowMs: number) => string;
  /** A pre-built writer, so an integration criterion can make appends fail. */
  writer?: ContextEventWriter;
  /** A pre-built predictor, so a criterion can fix ids. */
  predictor?: ShadowPredictor;
};

/** How long a picked chip marks the next utterance from the same session as chip-sourced. */
export const CHIP_SOURCE_WINDOW_MS = 120_000;

/**
 * THE ONE PROCESS INSTANCE.
 *
 * Built at module load like `quayService`: the composition root imports it, the
 * quay module reads its status, and the reply-suggestions observer writes through
 * it. Construction does no filesystem work — the schema is read on the first
 * append — so importing this module in a criterion costs nothing.
 */
export const contextEvents: ContextEvents = createContextEvents();

/**
 * Builds a stream over the writer/classifier/predictor triple.
 *
 * Consumers: the process instance above, `server/index.ts` for tests/overrides,
 * and the criteria.
 */
export function createContextEvents(options: ContextEventsOptions = {}): ContextEvents {
  const now = options.now ?? Date.now;
  const writer =
    options.writer ??
    createContextEventWriter({
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      ...(options.eventsDir === undefined ? {} : { eventsDir: options.eventsDir }),
      ...(options.schemaPath === undefined ? {} : { schemaPath: options.schemaPath }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.newId === undefined ? {} : { newId: options.newId }),
    });
  const predictor = options.predictor ?? createShadowPredictor();

  /** session id -> the moment a chip was picked, for the typing/voice/chip source reading. */
  const recentChipPick = new Map<string, number>();
  /** The serial chain: every append sees the one before it settled. */
  let tail: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    // The chain itself must never stay rejected, or a later append would be
    // skipped; each caller still receives its own task's outcome.
    tail = next.catch(() => undefined);
    return next;
  };

  const appendSafely = async (draft: ContextEventDraft): Promise<AppendContextEventResult | null> => {
    try {
      return await writer.append(draft);
    } catch {
      // A writer that THROWS (not merely rejects) is still contained: recording
      // is a side effect of a user action, never a reason for it to fail.
      return null;
    }
  };

  /**
   * The utterance flow: classify, score the last prediction, predict the next.
   *
   * The source upgrade (typing → chip) happens here rather than at the send seam
   * because the picked chip is recorded by the reply-suggestions observer, which
   * this module owns. A voice send is never upgraded: speech is its own source.
   */
  const handleUtterance = async (draft: ContextEventRecord): Promise<AppendContextEventResult | null> => {
    const text = typeof draft.data?.text === 'string' ? draft.data.text : '';
    const sessionKey = draft.session ?? '__no-session__';
    const declaredSource = draft.data?.source === 'voice' ? 'voice' : 'typing';
    const pickedAt = recentChipPick.get(sessionKey);
    const source =
      declaredSource === 'typing' && pickedAt !== undefined && now() - pickedAt <= CHIP_SOURCE_WINDOW_MS
        ? 'chip'
        : declaredSource;
    const classification = classifyUtterance(text);

    const result = await appendSafely({
      ...draft,
      data: { ...(draft.data ?? {}), source, class: classification.class, rule: classification.rule },
    });
    if (result === null || !result.ok) return result;

    const flow = predictor.flow(sessionKey, classification.class);
    if (flow.outcome !== null) {
      await appendSafely({
        kind: 'shadow.prediction.outcome',
        ...(draft.project === undefined ? {} : { project: draft.project }),
        ...(draft.session === undefined ? {} : { session: draft.session }),
        data: {
          predictionId: flow.outcome.predictionId,
          actualClass: flow.outcome.actualClass,
          hit: flow.outcome.hit,
        },
      });
    }
    if (flow.prediction !== null) {
      await appendSafely({
        kind: 'shadow.prediction',
        ...(draft.project === undefined ? {} : { project: draft.project }),
        ...(draft.session === undefined ? {} : { session: draft.session }),
        data: {
          predictionId: flow.prediction.id,
          class: flow.prediction.class,
          confidence: flow.prediction.confidence,
          method: flow.prediction.method,
          basis: flow.prediction.basis,
        },
      });
    }
    return result;
  };

  const record = (draft: ContextEventRecord): Promise<AppendContextEventResult | null> =>
    enqueue(async (): Promise<AppendContextEventResult | null> => {
      if (draft.kind === 'utterance') {
        return handleUtterance(draft);
      }
      if (draft.kind === 'chip.picked' && typeof draft.session === 'string') {
        recentChipPick.set(draft.session, now());
      }
      return appendSafely({
        kind: draft.kind,
        ...(draft.project === undefined ? {} : { project: draft.project }),
        ...(draft.session === undefined ? {} : { session: draft.session }),
        ...(draft.refs === undefined ? {} : { refs: draft.refs }),
        data: draft.data ?? {},
      });
    }).catch(() => null);

  const recordUsage = (usage: ReplySuggestionsUsageRecord): void => {
    const session = typeof usage.sessionId === 'string' ? usage.sessionId : null;
    const draw = typeof usage.draw === 'number' ? usage.draw : undefined;
    const index = typeof usage.index === 'number' ? usage.index : undefined;
    const source = typeof usage.source === 'string' ? usage.source : undefined;
    const chipCount = Array.isArray(usage.chips) ? usage.chips.length : undefined;

    let draft: ContextEventRecord | null = null;
    switch (usage.type) {
      case 'shown':
        draft = {
          kind: 'chip.shown',
          session,
          data: {
            ...(draw === undefined ? {} : { draw }),
            ...(chipCount === undefined ? {} : { count: chipCount }),
          },
        };
        break;
      case 'picked':
        draft = {
          kind: 'chip.picked',
          session,
          data: {
            ...(draw === undefined ? {} : { draw }),
            ...(index === undefined ? {} : { index }),
            ...(source === undefined ? {} : { source }),
          },
        };
        break;
      case 'redrawn':
        draft = {
          kind: 'chip.redrawn',
          session,
          data: {
            ...(draw === undefined ? {} : { draw }),
            ...(source === undefined ? {} : { source }),
          },
        };
        break;
      default:
        // `cleared` / `sent` have no v0 kind of their own; the usage ledger keeps
        // them, and inventing a kind here would mint a second contract.
        return;
    }
    if (draft !== null) void record(draft);
  };

  return {
    record,
    recordUsage,
    status: () => writer.status(),
    predictor,
  };
}

/**
 * The status of the process-wide stream, for the fleet-summary reading mounted
 * beside quay-fleet's own availability. Before the composition root installs
 * anything this reports `schema-unavailable` with an explicit reason, never a
 * fabricated `ok`.
 */
export function readContextEventStatus(): ContextEventWriterStatus {
  return contextEvents.status();
}

/** Re-exported so the status shape is nameable through the barrel. */
export type { ContextEventWriterStatus };
/** The kinds a producer may state, re-exported for the wiring's exhaustive switch. */
export { CLOUDCLI_CONTEXT_EVENT_KINDS };
/** The ten categories, for the shadow-report's table. */
export { UTTERANCE_CLASSES };
export type { UtteranceClass };
