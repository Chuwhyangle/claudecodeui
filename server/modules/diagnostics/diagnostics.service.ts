/**
 * The diagnostics aggregation layer: it reads the feature providers the
 * composition root injects, derives the health state a person actually sees,
 * trims the failure lists and redacts every string before it leaves the process.
 *
 * WHY A PROVIDER SEAM. `modules/diagnostics` is a leaf: it may import
 * `server/shared/**` and itself, never a sibling feature module. `server/index.ts`
 * therefore adapts each feature's diagnostics reader (today reply-suggestions)
 * into a `DiagnosticsFeatureProvider` and hands the list in. That keeps the
 * import graph acyclic and gives a future feature one place to register, instead
 * of this module growing an import per feature.
 *
 * THE STATE IS DERIVED, NOT TRUSTED. A provider reports the feature's
 * configuration state; this layer turns "ready but the latest attempt failed"
 * into `degraded`, which is the reading an operator needs. `ok` is reserved for
 * a provider that genuinely reports healthy without the ready/degraded split.
 *
 * REDACTION IS SERVER-SIDE. The bundle and the JSON responses are scrubbed here,
 * not in the browser: a client-side filter would be theatre, because the secret
 * would already have crossed the wire. The redactor is deliberately broad — an
 * API-key-shaped token, an `LITELLM_API_KEY=` assignment, a bearer header or a
 * generic `key=`/`token:` pair all collapse to `[redacted]`.
 *
 * Consumers: `diagnostics.routes.ts` (the HTTP face), `diagnostics-bundle.ts`
 * (the plain-text rendering) and the diagnostics service criterion.
 */
import { errorMessage } from '@/shared/utils.js';

// --------------------------- WIRE SHAPES ---------------------------

/** The five states the Settings health card distinguishes. */
export type DiagnosticsFeatureState = 'off' | 'misconfigured' | 'ready' | 'degraded' | 'ok';

/** One failed attempt, in the same vocabulary as the feature's own failure ring. */
export type DiagnosticsFailureRecord = {
  at: string;
  requestId: string;
  category: string;
  httpStatus: number | null;
  durationMs: number;
  model: string;
  protocol: string;
};

/**
 * What a feature provider reports. `failures` is the feature's bounded history,
 * newest first; `lastFailure` is the one the health card shows.
 */
export type DiagnosticsFeatureReading = {
  state: DiagnosticsFeatureState;
  enabled: boolean;
  problems: string[];
  lastSuccessAt: string | null;
  lastFailure: DiagnosticsFailureRecord | null;
  failures: DiagnosticsFailureRecord[];
  configSource: string | null;
};

/** The injected seam: one adapter per feature, built by the composition root. */
export type DiagnosticsFeatureProvider = {
  id: string;
  label: string;
  read: () => DiagnosticsFeatureReading;
};

/** One feature as `GET /features` publishes it (already redacted). */
export type DiagnosticsFeature = {
  id: string;
  label: string;
  state: DiagnosticsFeatureState;
  enabled: boolean;
  problems: string[];
  lastSuccessAt: string | null;
  lastFailure: DiagnosticsFailure | null;
  configSource: string | null;
};

/** One failure row as the JSON routes publish it (already redacted). */
export type DiagnosticsFailure = DiagnosticsFailureRecord & {
  featureId: string;
  feature: string;
};

/** Process facts the bundle states; all injected by the composition root. */
export type DiagnosticsMeta = {
  version: string | null;
  installForm: string;
  platform: string;
  settingsSource: string;
  settingsPath: string | null;
};

/** Everything the bundle renderer needs, already aggregated and redacted. */
export type DiagnosticsBundleInput = {
  meta: DiagnosticsMeta;
  features: DiagnosticsFeature[];
  failures: DiagnosticsFailure[];
  generatedAt: string;
};

// --------------------------- BOUNDS ---------------------------

/** Failures a request gets when it names no `limit`. */
export const DEFAULT_RECENT_FAILURES_LIMIT = 50;
/** The hard ceiling; a request may never ask for an unbounded list. */
export const MAX_RECENT_FAILURES_LIMIT = 200;

/** Clamps a caller-supplied limit into `[1, 200]`; a non-finite value takes the default. */
export function clampRecentFailuresLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RECENT_FAILURES_LIMIT;
  return Math.min(MAX_RECENT_FAILURES_LIMIT, Math.max(1, Math.trunc(value)));
}

// --------------------------- REDACTION ---------------------------

/**
 * Strings that must never leave the process. Order matters: the specific
 * assignment/header forms run before the generic `key=value` rule so the
 * substituted `[redacted]` is not re-matched.
 */
const REDACTION_RULES: readonly (readonly [RegExp, string])[] = [
  // An OpenAI/Anthropic-shaped key anywhere.
  [/sk-[A-Za-z0-9_-]{3,}/g, '[redacted]'],
  // `LITELLM_API_KEY=...` — the name itself must disappear (AC3 forbids the name too).
  [/[A-Z][A-Z0-9_]*_API_KEY\s*=\s*\S+/g, '[redacted]'],
  // `Authorization: Bearer ...` and a bare bearer token.
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, '[redacted]'],
  // A generic `apiKey: ...`, `token=...`, `secret: ...` pair.
  [/\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*[^\s,;]+/gi, '[redacted]'],
];

/**
 * Scrubs one monitored string. Exported because the routing layer also scrubs
 * request-derived text; every consumer of a reading goes through it.
 *
 * Consumers: `diagnostics-bundle.ts` (the whole document) and this file's wire
 * mapping.
 */
export function redactDiagnosticsText(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of REDACTION_RULES) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

// --------------------------- STATE DERIVATION ---------------------------

/**
 * Turns a provider reading into the published state. `ready` plus a failure
 * newer than the last success is `degraded`; `off`/`misconfigured`/`ok` are
 * passed through untouched. An unparseable failure timestamp counts as live,
 * because hiding a failure is worse than reporting one that just recovered.
 *
 * Consumers: this file's `computeFeature`.
 */
export function resolveDiagnosticsFeatureState(reading: DiagnosticsFeatureReading): DiagnosticsFeatureState {
  if (reading.state !== 'ready') return reading.state;
  if (reading.lastFailure === null) return 'ready';
  const failureAt = Date.parse(reading.lastFailure.at);
  if (Number.isNaN(failureAt)) return 'degraded';
  const successAt = reading.lastSuccessAt === null ? Number.NaN : Date.parse(reading.lastSuccessAt);
  return Number.isNaN(successAt) || failureAt >= successAt ? 'degraded' : 'ready';
}

// --------------------------- SERVICE ---------------------------

/** One redacted failure row, tagged with the feature that produced it. */
function toWireFailure(
  record: DiagnosticsFailureRecord,
  provider: DiagnosticsFeatureProvider,
): DiagnosticsFailure {
  return {
    at: redactDiagnosticsText(record.at),
    featureId: redactDiagnosticsText(provider.id),
    feature: redactDiagnosticsText(provider.label),
    requestId: redactDiagnosticsText(record.requestId),
    category: redactDiagnosticsText(record.category),
    httpStatus: record.httpStatus,
    durationMs: record.durationMs,
    model: redactDiagnosticsText(record.model),
    protocol: redactDiagnosticsText(record.protocol),
  };
}

/** One redacted feature row. */
function toWireFeature(
  provider: DiagnosticsFeatureProvider,
  reading: DiagnosticsFeatureReading,
): DiagnosticsFeature {
  const lastFailure = reading.lastFailure === null
    ? null
    : toWireFailure(reading.lastFailure, provider);
  return {
    id: redactDiagnosticsText(provider.id),
    label: redactDiagnosticsText(provider.label),
    state: resolveDiagnosticsFeatureState(reading),
    enabled: reading.enabled,
    problems: reading.problems.map(redactDiagnosticsText),
    lastSuccessAt: reading.lastSuccessAt === null ? null : redactDiagnosticsText(reading.lastSuccessAt),
    lastFailure,
    configSource: reading.configSource === null ? null : redactDiagnosticsText(reading.configSource),
  };
}

/** The empty reading a provider that throws is reported as — degraded, never "off". */
function failedReading(error: unknown): DiagnosticsFeatureReading {
  return {
    state: 'degraded',
    enabled: false,
    problems: [`diagnostics reading failed: ${errorMessage(error, 'unknown error')}`],
    lastSuccessAt: null,
    lastFailure: null,
    failures: [],
    configSource: null,
  };
}

/** Newest first; an unparseable timestamp sorts last rather than throwing. */
function compareFailures(left: DiagnosticsFailure, right: DiagnosticsFailure): number {
  const leftAt = Date.parse(left.at);
  const rightAt = Date.parse(right.at);
  const leftKey = Number.isNaN(leftAt) ? Number.NEGATIVE_INFINITY : leftAt;
  const rightKey = Number.isNaN(rightAt) ? Number.NEGATIVE_INFINITY : rightAt;
  if (leftKey !== rightKey) return rightKey - leftKey;
  return left.requestId < right.requestId ? 1 : left.requestId > right.requestId ? -1 : 0;
}

/** The aggregation surface `diagnostics.routes.ts` and `diagnostics.module.ts` drive. */
export type DiagnosticsService = {
  features: () => DiagnosticsFeature[];
  recentFailures: (limit: number) => DiagnosticsFailure[];
  bundleInput: (limit?: number) => DiagnosticsBundleInput;
};

/** The injected collaborators. `meta` is a thunk because it re-reads settings. */
export type DiagnosticsServiceDeps = {
  providers: DiagnosticsFeatureProvider[];
  meta: () => DiagnosticsMeta;
  now?: () => number;
};

/**
 * Build the service over the injected providers.
 *
 * Consumers: `diagnostics.module.ts` only (through the barrel's module factory).
 */
export function createDiagnosticsService(deps: DiagnosticsServiceDeps): DiagnosticsService {
  const now = deps.now ?? Date.now;

  const readProvider = (provider: DiagnosticsFeatureProvider): DiagnosticsFeature => {
    let reading: DiagnosticsFeatureReading;
    try {
      reading = provider.read();
    } catch (error) {
      reading = failedReading(error);
    }
    return toWireFeature(provider, reading);
  };

  const features = (): DiagnosticsFeature[] => deps.providers.map(readProvider);

  const recentFailures = (limit: number): DiagnosticsFailure[] => {
    const failures: DiagnosticsFailure[] = [];
    for (const provider of deps.providers) {
      let reading: DiagnosticsFeatureReading;
      try {
        reading = provider.read();
      } catch {
        // A broken provider contributes no history; `features()` already reports the failure.
        continue;
      }
      for (const record of reading.failures) failures.push(toWireFailure(record, provider));
    }
    return failures.sort(compareFailures).slice(0, clampRecentFailuresLimit(limit));
  };

  return {
    features,
    recentFailures,
    bundleInput(limit: number = DEFAULT_RECENT_FAILURES_LIMIT): DiagnosticsBundleInput {
      return {
        meta: deps.meta(),
        features: features(),
        failures: recentFailures(limit),
        generatedAt: new Date(now()).toISOString(),
      };
    },
  };
}
