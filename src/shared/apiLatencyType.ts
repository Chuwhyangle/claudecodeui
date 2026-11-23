/**
 * The API-latency wire types, a type-only leaf directly under `src/shared`.
 *
 * WHY NOT `src/shared/types.ts`: that file is an oversize-ratchet baseline entry
 * that may only shrink, and the API-speed surface is a new wire shape rather
 * than an addition to an existing one — the same reason `src/shared/ncLeaseType.ts`
 * and `src/shared/turnTokenUsageType.ts` sit here. Every consumer names this leaf
 * directly.
 *
 * Every shape mirrors the server's `server/shared/types/api-latency.ts`; the pair
 * is pinned by `src/shared/tests/wireContractTypeSync.test.ts`, so a field added
 * on one end without the other reds the run.
 *
 * Consumers: `src/shared/api/clientTail.ts` (the two endpoints) and the
 * `src/modules/api-speed` controller, hook and panel.
 */

//----------------- API LATENCY (the workspace "API speed" view) ------------

/**
 * One probe's staged timings, all in milliseconds.
 *
 * The three connection legs are `null` when the probe reused a pooled socket —
 * they were not measured, and printing `0` would claim an impossible handshake.
 */
export type ApiLatencyStageTimings = {
  dnsMs: number | null;
  tcpMs: number | null;
  tlsMs: number | null;
  uploadMs: number;
  firstByteMs: number;
  downloadMs: number;
  totalMs: number;
};

/** Which probe shape ran: a ping-sized body, or one carrying a synthetic upload. */
export type ApiLatencyProbeMode = 'ping' | 'upload';

/** Where the credential came from; `null` means none was found and the probe failed early. */
export type ApiLatencyCredentialSource = 'env' | 'settings.json' | null;

/**
 * One stored measurement, as `GET /api/api-latency/series` returns it.
 *
 * `transport` separates "paid for a new connection" from "reused one", and
 * `firstTokenMs` is the first CONTENT DELTA of a streaming probe — not the first
 * byte, which arrives as soon as the gateway accepts the request.
 */
export type ApiLatencyProbeResult = {
  id: string;
  at: string;
  ok: boolean;
  mode: ApiLatencyProbeMode;
  stream: boolean;
  model: string;
  transport: 'fresh' | 'reused';
  status: number | null;
  requestBytes: number;
  responseBytes: number;
  timings: ApiLatencyStageTimings;
  firstTokenMs: number | null;
  /** A short failure reason, already code-like; the panel may show it verbatim. */
  error: string | null;
};

/** The gateway a probe would measure. Carries no credential by construction. */
export type ApiLatencyGatewayTarget = {
  baseUrl: string;
  host: string;
  model: string;
  hasCredential: boolean;
  credentialSource: ApiLatencyCredentialSource;
};

/** The whole `GET /api/api-latency/series` body, newest sample last. */
export type ApiLatencySeries = {
  target: ApiLatencyGatewayTarget;
  probes: ApiLatencyProbeResult[];
};

/** What `POST /api/api-latency/probe` accepts; every field is optional. */
export type ApiLatencyProbeRequest = {
  mode?: ApiLatencyProbeMode;
  stream?: boolean;
  model?: string;
  uploadBytes?: number;
};
