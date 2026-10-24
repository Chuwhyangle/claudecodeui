/**
 * Every observation tile is a PROJECTION, and a projection that does not say what it drops
 * invites the reader to treat it as the whole picture. This module owns the declaration of that
 * loss: a short, non-empty list of things the reading cannot see, chosen by the object's kind
 * (and, for sessions, by the producer's tier), with an optional producer-supplied tail that is
 * merged and de-duplicated rather than allowed to replace the defaults.
 *
 * DEFAULTS ARE NOT PERSISTED AS A SEPARATE COLUMN. The observed-object row already carries an
 * opaque `digest_json`; the merged list is written there under {@link BLIND_SPOTS_DIGEST_KEY}
 * and stripped back out on read, so `ObservedObject.digest` stays the producer's own document.
 * A row written before this declaration existed has no key and is resolved from the defaults at
 * read time — the wall never shows an object with an empty blind-spot list.
 *
 * Consumers: `server/modules/observation/observation-store.ts` (write merge + read resolution)
 * and `server/modules/observation/tests/blind-spots.test.ts` (the criterion).
 */
import type { ObservationKind } from './observation-uri.js';

/** The provenance tier, restated here so the defaults can differ for an LLM-written reading. */
export type ObservationTier = 'deterministic' | 'llm';

/**
 * What a deterministic session digest cannot see. The transcript is the whole input, so anything
 * that never entered it — an external process, a manual edit, a sub-agent's internal steps — is
 * invisible; "waiting on you" is a heuristic over the last turn, not a fact.
 */
const SESSION_BLIND_SPOTS: readonly string[] = [
  '看不见会话是否偏离意图',
  '看不见未进入 transcript 的副作用（外部进程、手工改动）',
  '看不见子 agent 内部过程',
  '「在问你」是启发式判断',
];

/** What an LLM-written session summary adds on top of the deterministic list. */
const SESSION_LLM_BLIND_SPOTS: readonly string[] = [
  '摘要可能编造或遗漏',
  '偏离提示是语义判断，仅作建议',
];

/** What the layered project-truth reading cannot see. */
const PROJECT_BLIND_SPOTS: readonly string[] = [
  '看不见未登记到 quay-fleet 的项目与不经 quay 的工作',
  '部署层只对 CloudCLI 自身有意义',
  '验证层只反映 gate 的判据，不反映判据本身是否判别',
];

/** What a structural architecture diff cannot see. */
const ARCHITECTURE_BLIND_SPOTS: readonly string[] = [
  '看不见运行时依赖与动态 import',
  '看不见语义层面的退化',
  '规模增长口径固定为 additionsShare',
];

/**
 * The observation layer's own declaration, attached to the 「观察层自身」 reading: a producer
 * heartbeat proves the producer is alive, not that its reading is right.
 */
export const OBSERVATION_LAYER_BLIND_SPOTS: readonly string[] = [
  '生产者心跳只证明生产者在运行，不证明读数正确',
];

/**
 * The reserved `digest_json` key holding the merged declaration. It never reaches a consumer:
 * `splitBlindSpotsFromDigest` removes it, so the digest the store returns is the producer's.
 */
export const BLIND_SPOTS_DIGEST_KEY = '__blindSpots';

/** The default declarations for one (kind, tier) pair. Always non-empty; returns a fresh copy. */
export function defaultBlindSpots(kind: ObservationKind, tier: ObservationTier): string[] {
  if (kind === 'session') {
    return [
      ...SESSION_BLIND_SPOTS,
      ...(tier === 'llm' ? SESSION_LLM_BLIND_SPOTS : []),
    ];
  }
  if (kind === 'project') return [...PROJECT_BLIND_SPOTS];
  return [...ARCHITECTURE_BLIND_SPOTS];
}

/**
 * Merges the kind's defaults with a producer's appended declarations.
 *
 * Order is defaults first, then the producer's additions in the order given; trimming happens
 * before the duplicate check, so a producer repeating a default does not draw it twice.
 */
export function mergeBlindSpots(
  kind: ObservationKind,
  tier: ObservationTier,
  appended: readonly string[] = [],
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [...defaultBlindSpots(kind, tier), ...appended]) {
    const text = candidate.trim();
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    merged.push(text);
  }
  return merged;
}

/** The digest document to persist: the producer's fields plus the reserved declaration key. */
export function withBlindSpotsInDigest(
  digest: Record<string, unknown>,
  blindSpots: readonly string[],
): Record<string, unknown> {
  return { ...digest, [BLIND_SPOTS_DIGEST_KEY]: [...blindSpots] };
}

/**
 * Resolves one stored row's digest into (producer document, declaration).
 *
 * A stored list is re-merged with the current defaults, so a row written by an older release (or
 * with an empty tail) still gets the defaults. A row with no reserved key — every row written
 * before this declaration existed — resolves to the defaults alone.
 */
export function splitBlindSpotsFromDigest(
  digest: Record<string, unknown>,
  kind: ObservationKind,
  tier: ObservationTier,
): { digest: Record<string, unknown>; blindSpots: string[] } {
  const { [BLIND_SPOTS_DIGEST_KEY]: stored, ...rest } = digest;
  const appended = Array.isArray(stored)
    ? stored.filter((item): item is string => typeof item === 'string')
    : [];
  return { digest: rest, blindSpots: mergeBlindSpots(kind, tier, appended) };
}
