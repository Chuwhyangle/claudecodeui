/**
 * The `voice-realtime` module's public API.
 *
 * TWO SURFACES, ONE BARREL. This module offers a lean half and a runtime half:
 *
 *  - the LEAN half — the Realtime bridge, the six mirrored tool descriptors and
 *    the DashScope transport. `voice-realtime-bridge.service.ts` reaches no
 *    module at runtime, so the bridge itself stays an offline-provable leaf.
 *  - the RUNTIME half — {@link createVoiceRealtimeLiveExecutor}, which by design
 *    imports the MCP gateway's barrel (and, through it, the services a real send
 *    needs). A caller that wires a real connection uses this; a caller that only
 *    drives the bridge relies on the lean half.
 *
 * Both are exported here because a caller outside the module imports from this
 * barrel and nowhere else (the module boundary). Everything else — the guards,
 * the state machine's internals, the field comparison helpers, the executor's
 * refusal vocabulary's internals — stays behind it.
 *
 * Consumers: a later task wires a real Realtime client to `connect` and its
 * executor to `createVoiceRealtimeLiveExecutor`; the criteria read the
 * descriptors through `REALTIME_TOOLS` and drive the executor over fake
 * services.
 */
export {
  DASHSCOPE_REALTIME_ENDPOINT,
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  DEFAULT_DASHSCOPE_REALTIME_VOICE,
  argumentSchemaViolation,
  createDashscopeTransport,
  estimateRealtimeCostCny,
  toBridgeEvent,
  toDashscopeFrames,
  type DashscopeSocket,
  type DashscopeSocketFactory,
  type DashscopeTransport,
  type DashscopeTransportError,
  type DashscopeTransportOptions,
  type DashscopeWireObserver,
} from './voice-realtime-dashscope-transport.js';
export {
  connect,
  type RealtimeBridge,
  type RealtimeBridgeError,
  type RealtimeBridgeHooks,
  type RealtimeBridgeOptions,
  type RealtimeBridgeState,
  type RealtimeClientMessage,
  type RealtimeFunctionCall,
  type RealtimeFunctionDeclaration,
  type RealtimeServerMessage,
  type RealtimeToolExecutor,
  type RealtimeTransport,
  // The segmented (manual-commit) path: the browser cuts speech into numbered segments,
  // the bridge closes each one upstream, and a phase hook says which `seq` a delivery
  // belongs to. See `docs/proposals/voice-realtime-segmented-relay-SPEC.md`.
  type RealtimeSegmentCommitMode,
  type RealtimeSegmentEndReason,
  type RealtimeSegmentOptions,
  type RealtimeSegmentPhase,
  type RealtimeSegmentPhaseEvent,
} from './voice-realtime-bridge.service.js';
export {
  REALTIME_TOOLS,
  REALTIME_TOOLS_BY_NAME,
  VOICE_REALTIME_TOOLS,
  diffToolDescriptors,
  diffToolSchemas,
  type RealtimeToolDescriptor,
  type RealtimeToolName,
  type SchemaFieldMismatch,
  type SchemaFieldMismatchKind,
  type ToolSchemaSection,
} from './voice-realtime-tools.js';
export {
  VoiceRealtimeSessionRefusalError,
  createVoiceRealtimeLiveExecutor,
  type VoiceRealtimeCaller,
  type VoiceRealtimeLiveExecutorDeps,
  type VoiceRealtimeSessionRefusal,
} from './voice-realtime-live-executor.js';
// The browser-facing `/voice-realtime` handler (GOAL-031 / AC-312). Consumed by
// `server/index.ts`, which derives the bound session and the caller from the
// authenticated upgrade request and hands the result to the websocket gateway's
// route branch, and by this module's own criterion, which drives it with a fake
// upstream and a fake executor. The three constants are the handler's public
// contract: the path it answers, the prompt it installs, and the scope set a
// first-party voice connection acts with.
// The C3 upstream session pool: one active Realtime session plus a pre-warmed standby, with
// a transparent idle rotation between them (SPEC §C3). A pool IS a `RealtimeBridge`, so the
// proxy swaps it in behind the same surface; the handover latency P0a measured (`p50=259ms
// p90=736ms`) is what the rotation hides. `server/index.ts` builds it for a deployment.
export {
  DEFAULT_IDLE_ROTATE_MS,
  DEFAULT_STANDBY_READY_TIMEOUT_MS,
  VOICE_REALTIME_IDLE_ROTATE_MS_ENV,
  createUpstreamPool,
  type UpstreamPool,
  type UpstreamPoolHooks,
  type UpstreamPoolOptions,
  type UpstreamPoolRotation,
} from './voice-realtime-upstream-pool.js';
export {
  VOICE_REALTIME_CALLER_SCOPES,
  VOICE_REALTIME_INSTRUCTIONS,
  VOICE_REALTIME_PATH,
  describeBridgeError,
  describeTransportError,
  handleVoiceRealtimeConnection,
  readVoiceRealtimeInboundFrame,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from './voice-realtime-ws-proxy.service.js';
// The P4 rollout switch (GOAL-034 / AC-322): which relay a deployment offers a browser, resolved as a
// pure function of the environment. `server/index.ts` calls it at the assembly point; the ws proxy
// calls it when a caller passes no `segmentedRelay` seam; the criterion reads the default from it.
export {
  SEGMENTED_RELAY_PROTOCOL,
  VOICE_REALTIME_MODE_ENV,
  declaresSegmentedRelay,
  describeVoiceRealtimeMode,
  resolveVoiceRealtimeMode,
  type VoiceRealtimeMode,
  type VoiceRealtimeModeResolution,
} from './voice-realtime-mode.js';
// The HTTP-layer Live Voice diagnosis (an audio file through the same proxy a microphone
// uses). `server/index.ts` mounts the router and reuses `summarizeWireObservation` for the
// always-on upstream log; the criterion drives `runVoiceRealtimeDiagnosis` directly.
export {
  parseWavPcm16,
  runVoiceRealtimeDiagnosis,
  summarizeWireObservation,
  type VoiceRealtimeDiagnosisInput,
  type VoiceRealtimeDiagnosisReport,
  type VoiceRealtimeDiagnosisSeams,
  type VoiceRealtimeSegmentReport,
  type VoiceRealtimeWireEntry,
} from './voice-realtime-diagnose.service.js';
// The live relay's on-disk journal (one JSONL file per browser connection). `server/index.ts`
// resolves the directory, builds the store and the per-connection recorder, and wires the recorder's
// `log`/`observe` into the same seams the proxy already exposes; the criteria build the store against
// a temp directory and drive the recorder directly.
export {
  DEFAULT_VOICE_REALTIME_LOG_MAX_BYTES,
  MIN_VOICE_REALTIME_LOG_MAX_BYTES,
  VOICE_REALTIME_LOG_DIR_ENV,
  VOICE_REALTIME_LOG_MAX_BYTES_ENV,
  createVoiceRealtimeLogStore,
  createVoiceRealtimeRecorder,
  resolveVoiceRealtimeLogDir,
  resolveVoiceRealtimeLogMaxBytes,
  voiceRealtimeLogDirStartupLine,
  type VoiceRealtimeLogClearResult,
  type VoiceRealtimeLogEntry,
  type VoiceRealtimeLogMode,
  type VoiceRealtimeLogRecorder,
  type VoiceRealtimeLogStore,
  type VoiceRealtimeLogStoreOptions,
  type VoiceRealtimeWireObservation,
} from './voice-realtime-log.js';
export { createVoiceRealtimeRouter, type VoiceRealtimeRoutesDeps } from './voice-realtime.routes.js';
