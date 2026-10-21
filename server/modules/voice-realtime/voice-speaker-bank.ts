/**
 * The LONG-TERM SPEAKER BANK: the enrolled core plus the clusters a deployment has learned, with the
 * state transitions the dual-key rule needs.
 *
 * WHAT IT IS FOR. The session attractor (`voice-speaker-attractor.ts`) can only say "this turn sounds
 * like what this connection has heard". The bank holds the other key: the CORE — the enrollment
 * centroid(s) belonging to the real user — plus the satellites learned around it. The offline readings
 * that fix the transitions (`experiments/voice-tse-eval/CONFIRMED-LABELS.md` §3 and §6):
 *
 *  - a cluster confirmed by the core may authorize TSE; nothing else may;
 *  - a NEW cluster is at most a candidate (provisional), and becomes a satellite only after it shows
 *    up across TWO sessions — so a bystander's first appearance is never learned as the user;
 *  - a core entry is never the victim of capacity eviction, so a chatty session cannot evict the
 *    enrolled identity it is supposed to be measured against;
 *  - two candidates that agree with each other are merged rather than allowed to crowd the cap.
 *
 * CAPACITY. `k` bounds the LEARNED part of the bank: at most `k - cores.length` satellites/candidates
 * are kept (`bankSize = 4` in `thresholds.v1.json`). Cores are pinned — if a deployment enrolls more
 * than `k`, every core stays and the learned part is empty. Eviction prefers candidates over
 * satellites and then the least recently seen, so an accumulating bystander is the first thing to go.
 *
 * Everything here is pure: a transition takes a bank and returns a NEW bank. No I/O, no clock, no
 * environment. Consumers: `voice-realtime-speaker-seam.ts` and its criterion.
 */

import {
  normalizeSpeakerVector,
  speakerCosine,
  clampSpeakerStep,
} from './voice-speaker-attractor.js';

/** Where a cluster came from. `core` is enrollment; the other two are learned. */
export type SpeakerClusterKind = 'core' | 'satellite' | 'candidate';

/** One cluster: a centroid, the sessions it has been seen in, and its recency. */
export type SpeakerCluster = {
  readonly id: string;
  readonly kind: SpeakerClusterKind;
  readonly centroid: Float32Array;
  /** Distinct session keys that observed this cluster. A candidate needs two to be promoted. */
  readonly sessions: readonly string[];
  /** How many turns contributed to the centroid. */
  readonly turns: number;
  /** The bank turn on which this cluster was last seen; eviction reads it. */
  readonly lastTurn: number;
};

/** The bank's immutable state. */
export type SpeakerBank = {
  readonly clusters: readonly SpeakerCluster[];
  /** The cap on the LEARNED part of the bank (see the module comment). */
  readonly k: number;
  readonly nextId: number;
  readonly turn: number;
};

/** How to build a bank. Every knob has a calibrated default. */
export type SpeakerBankOptions = {
  /** Enrollment centroids. Missing/short/zero vectors are skipped rather than inventing a core. */
  cores?: readonly ArrayLike<number>[];
  /** The learned-part cap. `thresholds.v1.json` ships 4. */
  k?: number;
  /** A cluster is MATCHED at this score. `TRACK` — 0.30. */
  track?: number;
  /** A cluster is CONFIRMED by the core at this score. `MATCH_FAST` — 0.35. */
  matchFast?: number;
  /** Two candidates at or above this cosine are mergeable. `consistencyMin` — 0.60. */
  consistencyMin?: number;
};

/** The cap `thresholds.v1.json` pins (`bankSize`). */
export const SPEAKER_BANK_DEFAULT_K = 4;
/** The tracking threshold (`track`). */
export const SPEAKER_BANK_DEFAULT_TRACK = 0.3;
/** The core-confirmation threshold (`matchFast`). */
export const SPEAKER_BANK_DEFAULT_MATCH_FAST = 0.35;
/** The cluster-consistency floor (`consistencyMin`). */
export const SPEAKER_BANK_DEFAULT_CONSISTENCY_MIN = 0.6;
/** How far one matched learned turn may rotate its cluster (`maxStepBankDeg`). */
export const SPEAKER_BANK_DEFAULT_MAX_STEP_DEGREES = 8;

/** One transition's outcome. */
export type SpeakerBankAction =
  | 'matched-core'
  | 'matched-satellite'
  | 'matched-candidate'
  | 'promoted'
  | 'new-candidate'
  | 'rejected';

/** What {@link matchSpeakerCluster} found. */
export type SpeakerClusterMatch = { cluster: SpeakerCluster; score: number };

/** Builds a bank from zero or more enrollment centroids. */
export function createSpeakerBank(options: SpeakerBankOptions = {}): SpeakerBank {
  const clusters: SpeakerCluster[] = [];
  for (const core of options.cores ?? []) {
    const centroid = normalizeSpeakerVector(core);
    if (centroid === null) {
      continue;
    }
    clusters.push({
      id: `core-${clusters.length + 1}`,
      kind: 'core',
      centroid,
      sessions: [],
      turns: 0,
      lastTurn: 0,
    });
  }
  return {
    clusters,
    k: Math.max(0, Math.trunc(options.k ?? SPEAKER_BANK_DEFAULT_K)),
    nextId: 1,
    turn: 0,
  };
}

/** The best-matching cluster at or above `threshold`, or `null`. Cores are candidates too. */
export function matchSpeakerCluster(
  bank: SpeakerBank,
  embedding: ArrayLike<number>,
  threshold = SPEAKER_BANK_DEFAULT_TRACK,
): SpeakerClusterMatch | null {
  let best: SpeakerClusterMatch | null = null;
  for (const cluster of bank.clusters) {
    const score = speakerCosine(embedding, cluster.centroid);
    if (score >= threshold && (best === null || score > best.score)) {
      best = { cluster, score };
    }
  }
  return best;
}

/** Adds a NEW candidate for an embedding no cluster matched, then enforces the capacity cap. */
export function addSpeakerCandidate(
  bank: SpeakerBank,
  embedding: ArrayLike<number>,
  sessionKey: string,
): { bank: SpeakerBank; cluster: SpeakerCluster | null } {
  const centroid = normalizeSpeakerVector(embedding);
  if (centroid === null) {
    return { bank, cluster: null };
  }
  const turn = bank.turn + 1;
  const cluster: SpeakerCluster = {
    id: `cluster-${bank.nextId}`,
    kind: 'candidate',
    centroid,
    sessions: [sessionKey],
    turns: 1,
    lastTurn: turn,
  };
  const grown: SpeakerBank = {
    ...bank,
    clusters: [...bank.clusters, cluster],
    nextId: bank.nextId + 1,
    turn,
  };
  return { bank: evictSpeakerClusters(grown).bank, cluster };
}

/**
 * Promotes a candidate to a satellite once it has been seen in at least two DISTINCT sessions.
 *
 * Fewer than two leaves the bank untouched (`promoted: false`) — the rule that keeps a bystander who
 * appeared once from becoming a learned identity.
 */
export function promoteSpeakerCandidate(
  bank: SpeakerBank,
  id: string,
): { bank: SpeakerBank; promoted: boolean } {
  const target = bank.clusters.find((cluster) => cluster.id === id);
  if (target === undefined || target.kind !== 'candidate') {
    return { bank, promoted: false };
  }
  if (new Set(target.sessions).size < 2) {
    return { bank, promoted: false };
  }
  return {
    bank: replaceCluster(bank, { ...target, kind: 'satellite' }),
    promoted: true,
  };
}

/**
 * Merges two CANDIDATES whose centroids agree at `consistencyMin`, unioning their sessions.
 *
 * Cores are never merged into anything (they are enrollment, not evidence), and a merge below the
 * consistency floor is refused. The merged cluster keeps `left`'s identity and is a satellite if
 * either side already was one.
 */
export function mergeSpeakerClusters(
  bank: SpeakerBank,
  leftId: string,
  rightId: string,
  consistencyMin = SPEAKER_BANK_DEFAULT_CONSISTENCY_MIN,
): { bank: SpeakerBank; merged: boolean } {
  const left = bank.clusters.find((cluster) => cluster.id === leftId);
  const right = bank.clusters.find((cluster) => cluster.id === rightId);
  if (
    left === undefined ||
    right === undefined ||
    left.id === right.id ||
    left.kind === 'core' ||
    right.kind === 'core' ||
    speakerCosine(left.centroid, right.centroid) < consistencyMin
  ) {
    return { bank, merged: false };
  }
  const leftWeight = Math.max(1, left.turns);
  const rightWeight = Math.max(1, right.turns);
  const blended = new Float32Array(left.centroid.length);
  for (let index = 0; index < blended.length; index += 1) {
    blended[index] = (left.centroid[index] * leftWeight + right.centroid[index] * rightWeight) /
      (leftWeight + rightWeight);
  }
  const mergedCentroid = normalizeSpeakerVector(blended) ?? left.centroid;
  const merged: SpeakerCluster = {
    id: left.id,
    kind: left.kind === 'satellite' || right.kind === 'satellite' ? 'satellite' : 'candidate',
    centroid: mergedCentroid,
    sessions: [...new Set([...left.sessions, ...right.sessions])],
    turns: left.turns + right.turns,
    lastTurn: Math.max(left.lastTurn, right.lastTurn),
  };
  return {
    bank: {
      ...bank,
      clusters: bank.clusters
        .filter((cluster) => cluster.id !== right.id)
        .map((cluster) => (cluster.id === left.id ? merged : cluster)),
    },
    merged: true,
  };
}

/**
 * Enforces the learned-part cap: at most `k - cores` non-core clusters survive.
 *
 * Candidates go before satellites, and within a kind the least recently seen goes first. An enrolled
 * core is NEVER evicted by this function — the cap applies to what the sessions taught, not to who the
 * user is.
 */
export function evictSpeakerClusters(bank: SpeakerBank): { bank: SpeakerBank; evicted: readonly string[] } {
  const coreCount = bank.clusters.filter((cluster) => cluster.kind === 'core').length;
  const learnedCap = Math.max(0, bank.k - coreCount);
  const learned = bank.clusters.filter((cluster) => cluster.kind !== 'core');
  if (learned.length <= learnedCap) {
    return { bank, evicted: [] };
  }
  const evictionOrder = [...learned].sort((left, right) => {
    const kindRank = (cluster: SpeakerCluster): number => (cluster.kind === 'candidate' ? 0 : 1);
    return kindRank(left) - kindRank(right) || left.lastTurn - right.lastTurn || left.id.localeCompare(right.id);
  });
  const evictedIds = new Set(evictionOrder.slice(0, learned.length - learnedCap).map((cluster) => cluster.id));
  return {
    bank: { ...bank, clusters: bank.clusters.filter((cluster) => !evictedIds.has(cluster.id)) },
    evicted: [...evictedIds],
  };
}

/** One bank observation's outcome. */
export type SpeakerBankObservation = {
  bank: SpeakerBank;
  action: SpeakerBankAction;
  cluster: SpeakerCluster | null;
  score: number;
};

/**
 * Feeds one embedding to the bank: match → update (and promote a candidate seen in a second session),
 * or no match → a new candidate.
 *
 * A CORE cluster is never moved by a session. Only learned clusters absorb the turn's direction, and
 * then only within `maxStepBankDeg`, for the same reason the session attractor has a ceiling: one turn
 * must not rewrite who a cluster is.
 */
export function observeSpeakerBank(
  bank: SpeakerBank,
  embedding: ArrayLike<number>,
  sessionKey: string,
  options: SpeakerBankOptions & { maxStepDegrees?: number } = {},
): SpeakerBankObservation {
  const track = options.track ?? SPEAKER_BANK_DEFAULT_TRACK;
  const unit = normalizeSpeakerVector(embedding);
  if (unit === null) {
    return { bank, action: 'rejected', cluster: null, score: 0 };
  }
  const turn = bank.turn + 1;
  const matched = matchSpeakerCluster(bank, unit, track);
  if (matched === null) {
    const added = addSpeakerCandidate(bank, unit, sessionKey);
    return { bank: added.bank, action: 'new-candidate', cluster: added.cluster, score: 0 };
  }
  const cluster = matched.cluster;
  if (cluster.kind === 'core') {
    // Recency only: enrollment is the reference, never the thing being adapted.
    const seen: SpeakerCluster = {
      ...cluster,
      sessions: addSession(cluster.sessions, sessionKey),
      turns: cluster.turns + 1,
      lastTurn: turn,
    };
    return { bank: replaceCluster({ ...bank, turn }, seen), action: 'matched-core', cluster: seen, score: matched.score };
  }
  const maxStep = options.maxStepDegrees ?? SPEAKER_BANK_DEFAULT_MAX_STEP_DEGREES;
  const blended = new Float32Array(cluster.centroid.length);
  for (let index = 0; index < blended.length; index += 1) {
    blended[index] = 0.7 * cluster.centroid[index] + 0.3 * unit[index];
  }
  const rotated = clampSpeakerStep(cluster.centroid, normalizeSpeakerVector(blended) ?? unit, maxStep) ?? cluster.centroid;
  const sessions = addSession(cluster.sessions, sessionKey);
  const shouldPromote = cluster.kind === 'candidate' && new Set(sessions).size >= 2;
  const updated: SpeakerCluster = {
    ...cluster,
    kind: shouldPromote ? 'satellite' : cluster.kind,
    centroid: rotated,
    sessions,
    turns: cluster.turns + 1,
    lastTurn: turn,
  };
  return {
    bank: replaceCluster({ ...bank, turn }, updated),
    action: shouldPromote ? 'promoted' : cluster.kind === 'satellite' ? 'matched-satellite' : 'matched-candidate',
    cluster: updated,
    score: matched.score,
  };
}

/** Returns the bank with one cluster replaced by `cluster`. */
function replaceCluster(bank: SpeakerBank, cluster: SpeakerCluster): SpeakerBank {
  return {
    ...bank,
    clusters: bank.clusters.map((existing) => (existing.id === cluster.id ? cluster : existing)),
  };
}

/** Adds a session key if it is not already present, preserving order. */
function addSession(sessions: readonly string[], sessionKey: string): readonly string[] {
  return sessions.includes(sessionKey) ? sessions : [...sessions, sessionKey];
}
