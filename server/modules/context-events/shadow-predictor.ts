/**
 * The shadow predictor — it predicts, records, and is never shown.
 *
 * WHAT IT PREDICTS. For one conversation, the category of the NEXT utterance,
 * from the category of the one just observed: a first-order transition table
 * (`transition-v0`). The counts are per session, built from that session's own
 * utterances (and any seed the caller supplies, e.g. a transcript backfill), so
 * one conversation's history can never steer another's prediction.
 *
 * THE TWO RECORDS. After an utterance the predictor emits one
 * `shadow.prediction` (`{class, confidence, method, basis}`); when the next
 * utterance arrives it emits exactly one `shadow.prediction.outcome`
 * (`{predictionId, actualClass, hit}`) for that prediction and then the next
 * prediction. That pairing is what makes the hit-rate table measurable later.
 *
 * IT IS INVISIBLE BY CONSTRUCTION. This file imports no websocket, socket, frame
 * or UI module and exposes no render hook: its only sink is the callback the
 * composing module hands it, which writes to the context stream. A prediction
 * therefore travels to a local JSONL file and nowhere else. The criterion reads
 * this file's own import list to keep it that way.
 *
 * Consumers: `context-events.module.ts`, and
 * `tests/shadow-predictor.test.ts` (which supplies deterministic ids).
 */
import { createUlid } from './context-event-writer.js';
import { UTTERANCE_CLASSES, type UtteranceClass } from './utterance-classifier.js';

/** The prediction method's version string, stored on every prediction. */
export const SHADOW_PREDICTION_METHOD = 'transition-v0';

/** The transition table for one session: `from -> to -> count`. */
export type TransitionTable = Map<UtteranceClass, Map<UtteranceClass, number>>;

/** One prediction, fully identified so its outcome can name it. */
export type ShadowPrediction = {
  /** The `shadow.prediction` event's id; the outcome's `predictionId`. */
  id: string;
  class: UtteranceClass;
  /** The winner's share of this session's observed transitions from its class. */
  confidence: number;
  method: typeof SHADOW_PREDICTION_METHOD;
  basis: {
    from: UtteranceClass;
    samples: number;
    counts: Record<string, number>;
  };
};

/** The verdict on one prior prediction. */
export type ShadowPredictionOutcome = {
  predictionId: string;
  actualClass: UtteranceClass;
  hit: boolean;
};

/** What one utterance produced: the previous prediction's verdict, then the next prediction. */
export type ShadowFlow = {
  outcome: ShadowPredictionOutcome | null;
  prediction: ShadowPrediction | null;
};

/** The predictor surface consumed by the composing module. */
export type ShadowPredictor = {
  /** Records one observed class and returns the outcome/prediction pair it implies. */
  flow(sessionKey: string, observed: UtteranceClass): ShadowFlow;
  /** Seeds one session's transition table from an ordered class sequence (transcript backfill). */
  seed(sessionKey: string, classes: readonly UtteranceClass[]): void;
  /** Replaces one session's transition table wholesale; used by fixtures and the report. */
  seedTransitions(sessionKey: string, transitions: Readonly<Record<string, Readonly<Record<string, number>>>>): void;
  /** The row for one class, as the prediction's basis states it; empty when unobserved. */
  countsFor(sessionKey: string, from: UtteranceClass): { samples: number; counts: Record<string, number> };
  /** The prediction still waiting for its outcome in this session, if any. */
  pendingFor(sessionKey: string): { id: string; class: UtteranceClass } | null;
  /** Forgets everything about one session (sessions are isolated; this is the reset seam). */
  forget(sessionKey: string): void;
};

type SessionState = {
  last: UtteranceClass | null;
  pending: { id: string; class: UtteranceClass } | null;
  transitions: TransitionTable;
};

/**
 * The deterministic tie order: the declared class order. Two classes with equal
 * counts must not make the prediction depend on Map insertion order, or the same
 * history would predict differently in two processes.
 */
const CLASS_ORDER = new Map<UtteranceClass, number>(UTTERANCE_CLASSES.map((name, index) => [name, index]));

function emptyRow(): Map<UtteranceClass, number> {
  return new Map<UtteranceClass, number>();
}

function readRow(state: SessionState, from: UtteranceClass): { samples: number; counts: Record<string, number> } {
  const row = state.transitions.get(from) ?? emptyRow();
  const counts: Record<string, number> = {};
  let samples = 0;
  for (const name of UTTERANCE_CLASSES) {
    const count = row.get(name) ?? 0;
    if (count > 0) {
      counts[name] = count;
      samples += count;
    }
  }
  return { samples, counts };
}

/**
 * Builds one predictor. `newId` is injected so a criterion can pair predictions
 * deterministically; production uses the same ULID factory the stream uses.
 */
export function createShadowPredictor(options: { newId?: () => string } = {}): ShadowPredictor {
  const newId = options.newId ?? (() => createUlid(Date.now()));
  const sessions = new Map<string, SessionState>();

  const stateFor = (sessionKey: string): SessionState => {
    const existing = sessions.get(sessionKey);
    if (existing !== undefined) return existing;
    const created: SessionState = { last: null, pending: null, transitions: new Map() };
    sessions.set(sessionKey, created);
    return created;
  };

  const predictFrom = (state: SessionState, from: UtteranceClass): ShadowPrediction | null => {
    const { samples, counts } = readRow(state, from);
    if (samples === 0) return null;
    const ranked = Object.entries(counts).sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return (CLASS_ORDER.get(left[0] as UtteranceClass) ?? 0) - (CLASS_ORDER.get(right[0] as UtteranceClass) ?? 0);
    });
    const [winner, winnerCount] = ranked[0];
    const prediction: ShadowPrediction = {
      id: newId(),
      class: winner as UtteranceClass,
      confidence: winnerCount / samples,
      method: SHADOW_PREDICTION_METHOD,
      basis: { from, samples, counts },
    };
    state.pending = { id: prediction.id, class: prediction.class };
    return prediction;
  };

  return {
    flow(sessionKey, observed) {
      const state = stateFor(sessionKey);
      const outcome =
        state.pending === null
          ? null
          : {
              predictionId: state.pending.id,
              actualClass: observed,
              hit: state.pending.class === observed,
            };
      state.pending = null;

      // The observed transition is counted AFTER the verdict is drawn, so a
      // prediction is never scored against a table that already contains its own
      // outcome (that would inflate confidence on repeated sequences).
      if (state.last !== null) {
        const row = state.transitions.get(state.last) ?? emptyRow();
        row.set(observed, (row.get(observed) ?? 0) + 1);
        state.transitions.set(state.last, row);
      }
      state.last = observed;

      return { outcome, prediction: predictFrom(state, observed) };
    },

    seed(sessionKey, classes) {
      const state = stateFor(sessionKey);
      for (let index = 1; index < classes.length; index += 1) {
        const from = classes[index - 1];
        const to = classes[index];
        const row = state.transitions.get(from) ?? emptyRow();
        row.set(to, (row.get(to) ?? 0) + 1);
        state.transitions.set(from, row);
      }
      const last = classes.at(-1);
      if (last !== undefined) state.last = last;
    },

    seedTransitions(sessionKey, transitions) {
      const state = stateFor(sessionKey);
      const table: TransitionTable = new Map();
      for (const [from, row] of Object.entries(transitions)) {
        if (!CLASS_ORDER.has(from as UtteranceClass)) continue;
        const target = emptyRow();
        for (const [to, count] of Object.entries(row)) {
          if (!CLASS_ORDER.has(to as UtteranceClass) || !Number.isFinite(count) || count <= 0) continue;
          target.set(to as UtteranceClass, Math.floor(count));
        }
        if (target.size > 0) table.set(from as UtteranceClass, target);
      }
      state.transitions = table;
    },

    countsFor(sessionKey, from) {
      return readRow(stateFor(sessionKey), from);
    },

    pendingFor(sessionKey) {
      return stateFor(sessionKey).pending;
    },

    forget(sessionKey) {
      sessions.delete(sessionKey);
    },
  };
}
