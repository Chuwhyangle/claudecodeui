//----------------- API LATENCY (the workspace "API speed" tab) ------------

/**
 * One probe's staged timings, all in milliseconds.
 *
 * The three connection legs are nullable because a probe that reused a pooled
 * socket never pays them: `null` is the honest reading ("not measured"), and a
 * fabricated `0` would make a reused sample look like an impossibly fast
 * handshake. The remaining legs are always numbers — they are measured on every
 * probe that reaches the request.
 *
 * Consumers: `api-latency-probe.service.ts` (what it measures), the routes and
 * store (answered and persisted verbatim), and the browser's mirror in
 * `src/shared/apiLatencyType.ts` (pinned by `wireContractTypeSync.test.ts`).
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

/**
 * Where the credential a probe used came from. `null` means no credential was
 * found and the probe failed before opening a socket.
 *
 * Consumer: `api-latency-settings.service.ts` (writes it) and the browser's
 * mirror, which prints it beside the gateway host.
 */
export type ApiLatencyCredentialSource = 'env' | 'settings.json' | null;

/**
 * One stored measurement, as `GET /api/api-latency/series` returns it.
 *
 * `transport` separates "this sample paid for a new connection" from "this
 * sample reused a pooled one", so 1.2 s and 0.4 s side by side read as two
 * different legs rather than as instability. `firstTokenMs` exists only for a
 * streaming probe and is the first CONTENT DELTA — not the first byte, which
 * the gateway sends as soon as it accepts the request.
 *
 * Consumers: the probe (produces it), the store (persists it), the routes and
 * the browser mirror.
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
  /**
   * A short human-readable failure reason, or `null` on success. It is a code-like
   * phrase rather than a localized sentence: the browser is free to replace it
   * with its own `apiSpeed.*` copy, and the server never embeds a machine path.
   */
  error: string | null;
};

/**
 * The gateway a probe would measure — host, model and credential presence only.
 *
 * There is deliberately no token field: this shape is answered to the browser by
 * `GET /api/api-latency/target` and `GET /api/api-latency/series`, and a
 * credential must never cross that boundary.
 *
 * Consumers: both read routes, and the browser mirror.
 */
export type ApiLatencyGatewayTarget = {
  baseUrl: string;
  host: string;
  model: string;
  hasCredential: boolean;
  credentialSource: ApiLatencyCredentialSource;
};

/**
 * The resolved gateway PLUS the credential, for the probe's own use.
 *
 * Server-only: this is the one shape that carries the bearer token, and it never
 * leaves `server/`. Keeping it beside {@link ApiLatencyGatewayTarget} makes the
 * difference between the two explicit rather than a cast at the boundary.
 *
 * Consumers: `api-latency-settings.service.ts` (returns it) and
 * `api-latency-probe.service.ts` (reads the token).
 */
export type ResolvedApiLatencyGateway = ApiLatencyGatewayTarget & {
  token: string | null;
};

/** The whole `GET /api/api-latency/series` body, newest sample last. */
export type ApiLatencySeries = {
  target: ApiLatencyGatewayTarget;
  probes: ApiLatencyProbeResult[];
};

/**
 * What `POST /api/api-latency/probe` accepts. Every field is optional: `mode`
 * defaults to `ping`, `stream` to `true`, and `uploadBytes` to the service's own
 * default. `uploadBytes` is clamped by the route, so a caller cannot turn the
 * probe into an unbounded bandwidth test.
 */
export type ApiLatencyProbeRequest = {
  mode?: ApiLatencyProbeMode;
  stream?: boolean;
  model?: string;
  uploadBytes?: number;
};
