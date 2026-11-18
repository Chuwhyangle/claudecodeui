/**
 * The diagnostics wire types, a type-only leaf directly under `src/shared`.
 *
 * WHY A LEAF. `src/shared/types.ts` is an oversize-ratchet baseline entry that
 * may only shrink, and the diagnostics surface is a self-contained read model.
 * Following the `replySuggestionsType.ts` precedent, the declarations live here
 * and `src/shared/types.ts` re-exports them, so existing `@/shared/types`
 * imports keep working while the read model has one owner.
 *
 * Consumers: `src/shared/api/clientTail.ts` (the transport), the diagnostics
 * controller and hook, the health list and recent-failures table, the log
 * drawer's controller and host, the port criterion, and the diagnostics/log
 * drawer criteria.
 */
//----------------- DIAGNOSTICS ------------

/**
 * The five health states the Settings card distinguishes. `off`/`misconfigured`
 * are configuration readings; `degraded` means the feature is configured but
 * its latest attempt failed; `ok` is a provider-reported healthy reading that
 * does not use the ready/degraded split.
 */
export type DiagnosticsFeatureState = 'off' | 'misconfigured' | 'ready' | 'degraded' | 'ok';

/**
 * One failed attempt, in the same correlation vocabulary as the feature's own
 * failure ring (category, upstream status, request id, model, protocol). It
 * never carries a prompt, an answer body or a key.
 */
export type DiagnosticsFailure = {
  at: string;
  featureId: string;
  /** The server-provided fallback label; the UI maps a known id to localized copy. */
  feature: string;
  requestId: string;
  category: string;
  httpStatus: number | null;
  durationMs: number;
  model: string;
  protocol: string;
};

/** One feature's health as `GET /api/diagnostics/features` publishes it. */
export type DiagnosticsFeature = {
  id: string;
  label: string;
  state: DiagnosticsFeatureState;
  enabled: boolean;
  /** What the feature's settings reader found wrong; may name a file, never a key. */
  problems: string[];
  lastSuccessAt: string | null;
  lastFailure: DiagnosticsFailure | null;
  /** `default`, or `file:<path>`. */
  configSource: string | null;
};

/** The `/features` answer. */
export type DiagnosticsFeaturesResponse = {
  features: DiagnosticsFeature[];
};

/** The `/recent-failures` answer, newest first. */
export type DiagnosticsFailuresResponse = {
  failures: DiagnosticsFailure[];
};

//----------------- PROCESS-LOCAL LOG WINDOW ------------

/** The severity a stored log line carries. */
export type LogLineLevel = 'info' | 'warn' | 'error';

/** One already-redacted line from the process-local window. */
export type LogLine = {
  at: string;
  level: LogLineLevel;
  source: string;
  text: string;
};

/** One source tab: its live count and newest line time. */
export type LogSource = {
  id: string;
  label: string;
  count: number;
  lastAt: string | null;
};

/** The `/logs/sources` answer. */
export type LogSourcesResponse = {
  sources: LogSource[];
};

/** The caps the drawer shows ("only the most recent N lines"). */
export type LogWindow = {
  maxLines: number;
  maxBytes: number;
};

/** The `/logs` answer: the retained, already-redacted window. */
export type LogsResponse = {
  lines: LogLine[];
  truncated: boolean;
  window: LogWindow;
};
