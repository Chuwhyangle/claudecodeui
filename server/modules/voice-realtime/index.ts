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
import { installVoiceRulesPort } from '@/shared/ports/voice-rules.port.js';

import { isVoiceSessionActive } from './voice-realtime-active.js';
import { rulesFor } from './voice-mode-rules.js';

// THE LIVE VOICE DISPATCH SEAM, installed where its two halves are in scope.
// The resident launch's `UserPromptSubmit` callback needs "is this session in
// voice" and the rules text, and it must not import this barrel: this module's
// runtime half reaches the MCP gateway, the gateway reaches the providers
// module, and the providers module builds the launch — a static or dynamic
// import of this barrel from the launch closes that initialization cycle (it
// used to, and measured as `ReferenceError: Cannot access
// 'ClaudeResidentHostDriver' before initialization`). Installing the two
// functions into the shared port while this barrel evaluates lets the launch
// read them through a module that imports nothing, which removes the edge
// entirely. `server/index.ts` repeats the installation in the composition root;
// both write the same object, so the second is idempotent documentation of who
// owns the wiring.
installVoiceRulesPort({ isSessionActive: isVoiceSessionActive, rulesFor });

export {
  CONTEXT_BUDGET_WARNING_TOKENS,
  DASHSCOPE_REALTIME_ENDPOINT,
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  DEFAULT_DASHSCOPE_REALTIME_VOICE,
  DEFAULT_SESSION_DEFAULTS,
  TOOL_OUTPUT_MAX_CHARS,
  argumentSchemaViolation,
  contextBudgetStatus,
  createDashscopeTransport,
  estimateRealtimeCostCny,
  isMaskedDashscopeApiKey,
  resolveRealtimeApiKey,
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
  // Which `seq` an input item belongs to: the endpoint's `item_id` for the utterance a segment's
  // commit created, and the seq of a commit the endpoint refused. See
  // `tasks/gap-live-voice-caption-segment-attribution-by-item-id.md`.
  type RealtimeCommitRejected,
  type RealtimeUserAudioCommitted,
} from './voice-realtime-bridge.service.js';
export {
  REALTIME_TOOLS,
  REALTIME_TOOLS_BY_NAME,
  VOICE_REALTIME_TOOLS,
  voiceRealtimeToolsFor,
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
// Silence Tail Suppression (decision doc §10, GOAL-044 / AC-364): the continuous wire's upload state
// machine, the environment switch that resolves it (OFF unless a deployment names it), and the two
// lines that report a resolution. Consumed by `server/index.ts`, which resolves it at the assembly
// point, and by `voice-realtime-ws-proxy.service.ts`, which builds one gate per continuous connection.
export {
  DEFAULT_SILENCE_TAIL_KEEPALIVE_MS,
  DEFAULT_SILENCE_TAIL_MS,
  DEFAULT_SILENCE_TAIL_PREROLL_MS,
  SILENCE_TAIL_ENV,
  SILENCE_TAIL_HANGOVER_MS,
  SILENCE_TAIL_KEEPALIVE_MS_ENV,
  SILENCE_TAIL_MS_ENV,
  SILENCE_TAIL_PREROLL_MS_ENV,
  createSilenceTailGate,
  describeSilenceTail,
  resolveSilenceTail,
  type SilenceTailDecision,
  type SilenceTailGate,
  type SilenceTailOptions,
  type SilenceTailResolution,
  type SilenceTailStage,
  type SilenceTailTransition,
} from './voice-realtime-silence-tail.js';
export {
  VOICE_REALTIME_CALLER_SCOPES,
  VOICE_REALTIME_INSTRUCTIONS,
  voiceRealtimeInstructionsFor,
  VOICE_REALTIME_PATH,
  composeHostRunActivityReading,
  describeBridgeError,
  describeTransportError,
  handleVoiceRealtimeConnection,
  readVoiceRealtimeInboundFrame,
  type HostQueueReading,
  type HostRunActivityReading,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeNarratorTtsSeam,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from './voice-realtime-ws-proxy.service.js';
// The Live Voice connection registry: which sessions are in a voice connection RIGHT NOW. The relay
// owns the lifetime (it marks a session as a connection is handled and clears it on every exit), and
// the resident launch's `UserPromptSubmit` hook reads it when a prompt is submitted. Exported through
// this barrel because `claude-host-driver.provider.ts` — in the providers module — is the reader, and
// the cross-module rule is that a module's internals are reached only through its barrel. The module
// itself imports nothing, so re-exporting it here costs the providers side nothing new.
export {
  clearVoiceSessionActive,
  isVoiceSessionActive,
  markVoiceSessionActive,
} from './voice-realtime-active.js';
// The dispatch rules text itself, so the launch can inject it without a second copy: the resident
// launch's `UserPromptSubmit` callback returns `rulesFor(...)`, and the criterion pins that injected
// text against `VOICE_MODE_RULES` (the byte-for-byte migration of `hooks/voice-mode-context.mjs`).
export { VOICE_MODE_RULES, rulesFor } from './voice-mode-rules.js';
// The uplink VAD's production arm point (scheme §5): the environment switch that turns the continuous
// wire's per-frame speech gate on (OFF unless a deployment names a backend), and the connection-level
// state machine the proxy reads per frame. Consumed by `server/index.ts`, which resolves the switch once
// per connection and builds one arm point, and by `voice-realtime-ws-proxy.service.ts`, which forwards
// through it and degrades it to `failed` when the backend throws.
export {
  UPLINK_VAD_OFF,
  VOICE_REALTIME_UPLINK_VAD_ENV,
  VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH_ENV,
  createUplinkVadArmPoint,
  describeUplinkVad,
  markUplinkVadFailed,
  readUplinkVadArmPoint,
  readUplinkVadState,
  resolveUplinkVad,
  type UplinkVadArmPoint,
  type UplinkVadArmPointOptions,
  type UplinkVadArmResolution,
  type UplinkVadConnectionState,
} from './voice-realtime-uplink-vad-arm-point.js';
// THE SPEAKER TRACKING ARM (Phase 1, shadow): the settings-file block (`speakerTracking`) that
// decides whether this deployment observes speakers at all, the calibrated thresholds it observes
// at, the environment escape hatch that overrides mode/model path, the CAM++ model and the
// per-connection seam the proxy reads. `server/index.ts` reads the settings file once per connection,
// resolves `env > file > default`, caches the model per resolved path and builds one seam per browser
// connection; the proxy logs the seam's `speaker_shadow` readings and nothing else ever sees them.
// Shadow is READ-ONLY: no frame, no client message, no commit, no audio change.
export {
  SPEAKER_TRACKING_MODEL_DIR_DEFAULT,
  SPEAKER_TRACKING_MODEL_FILE_DEFAULT,
  SPEAKER_TRACKING_QUALITY_DEFAULTS,
  SPEAKER_TRACKING_THRESHOLD_DEFAULTS,
  SPEAKER_TRACKING_THRESHOLDS,
  VOICE_SPEAKER_MODEL_PATH_ENV,
  VOICE_SPEAKER_TRACKING_ENV,
  describeSpeakerTracking,
  resolveSpeakerTracking,
  resolveSpeakerTrackingSettings,
  type SpeakerTrackingQualitySettings,
  type SpeakerTrackingResolution,
  type SpeakerTrackingSettingsBlock,
  type SpeakerTrackingThresholdSettings,
  type SpeakerTrackingThresholds,
  type SpeakerTrackingValueSource,
} from './voice-speaker-tracking-arm.js';
export {
  createSpeakerTrackerModel,
  createSpeakerTrackerSeam,
  type SpeakerEmbedder,
  type SpeakerTrackerModel,
  type VoiceSpeakerTrackerSeam,
} from './voice-realtime-speaker-seam.js';
// THE SPEAKER MODEL'S PROVISIONING SERVICE (2026-10-21): the CAM++ weights are a runtime artifact,
// not a release file. `server/index.ts` builds this service from the settings file's
// `speakerTracking` block and hands its two verbs to the routes; the settings page reads the state
// and asks for the one fixed-source download. The browser never names a URL, a directory or a file.
export {
  VOICE_SPEAKER_MODEL_ATTRIBUTION,
  VOICE_SPEAKER_MODEL_BYTES,
  VOICE_SPEAKER_MODEL_DOWNLOAD_TIMEOUT_MS,
  VOICE_SPEAKER_MODEL_FILE_NAME,
  VOICE_SPEAKER_MODEL_LICENSE,
  VOICE_SPEAKER_MODEL_MAX_BYTES,
  VOICE_SPEAKER_MODEL_SHA256,
  VOICE_SPEAKER_MODEL_SOURCE_URL,
  createVoiceSpeakerModelService,
  resolveVoiceSpeakerModelTarget,
  type VoiceSpeakerModelDownloadResult,
  type VoiceSpeakerModelService,
  type VoiceSpeakerModelState,
  type VoiceSpeakerModelStatus,
} from './voice-realtime-speaker-model.js';
// The P4 rollout switch (GOAL-034 / AC-322): which relay a deployment offers a browser, resolved as a
// pure function of the environment. `server/index.ts` calls it at the assembly point; the ws proxy
// calls it when a caller passes no `segmentedRelay` seam; the criterion reads the default from it.
export {
  SEGMENTED_RELAY_PROTOCOL,
  VOICE_REALTIME_MODE_ENV,
  VOICE_REALTIME_TRANSPORT_PARAM,
  applyVoiceRealtimeTransport,
  declaresSegmentedRelay,
  describeVoiceRealtimeMode,
  parseVoiceRealtimeTransport,
  resolveVoiceRealtimeMode,
  type VoiceRealtimeMode,
  type VoiceRealtimeModeResolution,
  type VoiceRealtimeTransport,
} from './voice-realtime-mode.js';
// The closing turn and the slim `session_send`: two independent deployment switches, resolved as pure
// functions of the environment. `server/index.ts` calls them at the assembly point and hands the result
// to the prompt, the proxy seams and the transport's declared intent (`respondToToolOutputs`; the
// resume `response.create` is protocol-mandatory and always sent), so the three can never disagree
// about whether the model is asked to speak again.
export {
  DEFAULT_VOICE_REALTIME_CLOSING_TURN,
  DEFAULT_VOICE_REALTIME_SLIM_SEND_TOOL,
  VOICE_REALTIME_CLOSING_TURN_ENV,
  VOICE_REALTIME_SLIM_SEND_TOOL_ENV,
  describeVoiceRealtimeClosingTurn,
  describeVoiceRealtimeSlimSendTool,
  resolveVoiceRealtimeClosingTurn,
  resolveVoiceRealtimeSlimSendTool,
  type VoiceRealtimeClosingTurn,
  type VoiceRealtimeClosingTurnResolution,
  type VoiceRealtimeSlimSendToolResolution,
} from './voice-realtime-closing-turn.js';
// The narrator layer's assembly: the per-connection queue the announce closing turn and the run-end
// summary speak through, plus the stand-in producer a criterion can name. `server/index.ts` builds one
// wiring per connection at the assembly point; `null` keeps the pre-narrator wire byte-for-byte.
export {
  VOICE_REALTIME_RUN_END_ACK_ENV,
  VOICE_REALTIME_SUMMARY_STANDIN_ENV,
  buildVoiceRealtimeNarratorWiring,
  describeVoiceRealtimeSummaryStandin,
  resolveVoiceRealtimeRunEndAckCandidates,
  resolveVoiceRealtimeSummaryStandin,
  type VoiceRealtimeNarratorWiring,
} from './voice-realtime-narrator.js';
// The run-end summary's SIDE TEXT MODEL leaf (2026-10-20): one `chat/completions` ask per run end,
// `qwen-flash` under the B-1 `voice` prompt (no hard length; Markdown and read-back are still
// refused). `server/index.ts` builds it when `VOICE_REALTIME_SUMMARY_MODEL` is set (credential = the
// user's Live Voice DashScope key) and hands its `summarize` to `buildVoiceRealtimeNarratorWiring` as
// the same seam the stand-in uses.
export {
  VOICE_REALTIME_SUMMARY_MODEL_ENV,
  DEFAULT_VOICE_REALTIME_SUMMARY_MODEL,
  createVoiceRealtimeRunEndSummarizer,
  type VoiceRealtimeRunEndSummarizer,
  type VoiceRealtimeRunEndSummarizerInput,
  type VoiceRealtimeRunEndSummarizerOptions,
} from './voice-realtime-summary.js';
// The per-window spend cap (the `SPEND_LIMIT` guard), resolved as a pure function of the environment
// and an explicit override. `server/index.ts` calls it at the assembly point both the browser socket
// and the HTTP diagnosis route share — the diagnosis route's own ¥0.05 arrives as that call's
// override — so a deployment that names no cap gets NONE rather than a fallback literal, and the
// criterion reads the same answers from the same function.
export {
  VOICE_REALTIME_MAX_CNY_PER_30S_ENV,
  describeSpendWindowLimit,
  resolveSpendWindowLimit,
  type SpendWindowLimitResolution,
} from './voice-realtime-spend-guard.js';
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
// The upstream turn detector's parameters (GOAL-037 / AC-325): the type, threshold and silence window
// the relay advertises in `session.update`, resolved as a pure function of the environment. The
// transport reads `DEFAULT_TURN_DETECTION` for its own fallback; `server/index.ts` resolves a
// deployment's value at the assembly point and hands the diagnosis route the same resolver.
export {
  DEFAULT_TURN_DETECTION,
  SILENCE_DURATION_MS_RANGE,
  THRESHOLD_RANGE,
  VOICE_REALTIME_TURN_DETECTION_ENV,
  VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV,
  VOICE_REALTIME_TURN_DETECTION_THRESHOLD_ENV,
  describeTurnDetection,
  resolveTurnDetection,
  type TurnDetection,
  type TurnDetectionOverride,
  type TurnDetectionResolution,
  type TurnDetectionType,
} from './voice-realtime-turn-detection.js';
// The uplink audio capture (one WAV per browser connection, beside the endpoint's judgement timeline
// on the same clock). `server/index.ts` resolves the directory and the switch at the assembly point,
// builds one recorder per connection from the SAME id the journal used, and wires its `frame`/
// `timeline`/`finalize` onto the proxy's `audioCapture` seam; the criteria build a store against a temp
// directory and drive the recorder directly. OFF unless the deployment asks for it.
export {
  DEFAULT_VOICE_REALTIME_CAPTURE_MAX_BYTES,
  MIN_VOICE_REALTIME_CAPTURE_MAX_BYTES,
  VOICE_REALTIME_CAPTURE_DEFAULT_SAMPLE_RATE,
  VOICE_REALTIME_CAPTURE_DIR_ENV,
  VOICE_REALTIME_CAPTURE_ENV,
  VOICE_REALTIME_CAPTURE_MAX_BYTES_ENV,
  clearVoiceRealtimeCaptureDir,
  createVoiceRealtimeCaptureRecorder,
  createVoiceRealtimeCaptureStore,
  resolveVoiceRealtimeCaptureDir,
  resolveVoiceRealtimeCaptureMaxBytes,
  resolveVoiceRealtimeCaptureMode,
  voiceRealtimeCaptureStartupLine,
  voiceRealtimeCaptureWarningLine,
  type VoiceRealtimeAudioCapture,
  type VoiceRealtimeCaptureClearResult,
  type VoiceRealtimeCaptureEvent,
  type VoiceRealtimeCaptureModeResolution,
  type VoiceRealtimeCaptureRecorder,
  type VoiceRealtimeCaptureStore,
  type VoiceRealtimeCaptureStoreOptions,
} from './voice-realtime-audio-capture.js';
export { createVoiceRealtimeRouter, type VoiceRealtimeRoutesDeps } from './voice-realtime.routes.js';
// The Live Voice TTS leaf (GOAL-047 / AC-405, wired by AC-408). The composition root builds its
// options (credential, voice, endpoint override) and hands `streamVoiceRealtimeSpeech` to the
// narrator queue through the proxy's `tts` seam; the browser receives the leaf's three frame shapes.
// The streaming entry point emits the header frame as soon as the RIFF header is readable, so a
// short announcement starts playing before its synthesis has finished. Nothing here opens a socket
// or reads the environment — the leaf takes every input as an option.
export {
  // The assembler reads the voice id from the deployment and the credential from the user; the two
  // env names live with the leaf so the composition root and this module cannot spell them apart.
  DEFAULT_VOICE_REALTIME_TTS_VOICE,
  VOICE_REALTIME_TTS_ENDPOINT_ENV,
  VOICE_REALTIME_TTS_VOICE_ENV,
  speakVoiceRealtimeText,
  streamVoiceRealtimeSpeech,
  type VoiceRealtimeTtsFrame,
  type VoiceRealtimeTtsOptions,
} from './voice-realtime-tts.js';
// The LOCAL CPU TTS leaf (2026-10-19): the same narrator text synthesized by a bundled Kokoro model
// through sherpa-onnx-node instead of the DashScope cloud. `server/index.ts` switches to it when
// `VOICE_REALTIME_TTS_LOCAL` is set; unset keeps the cloud leaf.
export {
  VOICE_REALTIME_TTS_LOCAL_ENV,
  VOICE_REALTIME_TTS_LOCAL_DIR_ENV,
  VOICE_REALTIME_TTS_LOCAL_SID_ENV,
  VOICE_REALTIME_TTS_LOCAL_DEFAULT_SID,
  createLocalVoiceRealtimeTtsSeam,
  type LocalVoiceRealtimeTtsOptions,
} from './voice-realtime-tts-local.js';
// The announce closing turn's sentence table and the per-connection cache that pre-synthesizes it
// (2026-10-19 live capture: five 8–9-character remarks, each paying its own synthesis round trip).
// The `announcePhrases` key in the settings file replaces the shipped table; `server/index.ts` reads
// the RESOLVED table at connection assembly for the cache warm-up and the proxy picks one sentence
// per announcement. The leaf is also exported so a criterion can pin the parser and the rotation.
export {
  ANNOUNCE_PHRASES,
  ANNOUNCE_PHRASE_MAX_CHARS,
  pickAnnouncePhrase,
  pickAnnouncePhraseFrom,
  resolveAnnouncePhrases,
  type AnnouncePhraseResolution,
} from './voice-realtime-announce-phrases.js';
// The settings file's loader. `server/index.ts` reads it ONCE per connection at assembly: the TTS
// cache warms the same `announcePhrases` table the proxy's announce gate speaks, and the run-end
// `summaryModel` / `runEndAck` keys are read from that same reading (environment > file > default,
// with the environment kept as the escape hatch). The proxy reads it again for the per-connection
// instructions. Kept on the barrel because the composition root is outside this module and must not
// deep-import it.
export { loadVoiceRealtimeSettings, type VoiceRealtimeSettings } from './voice-realtime-settings.js';
export {
  DEFAULT_VOICE_REALTIME_TTS_CACHE_MAX_ENTRIES,
  createVoiceRealtimeTtsCache,
  type VoiceRealtimeTtsCache,
  type VoiceRealtimeTtsCacheOptions,
} from './voice-realtime-tts-cache.js';
// The omission-fill rule v2 (GOAL-046): a pure planner over the transcripts and executed messages the
// relay already holds. It has no I/O, no timers and no parameter defaults — the caller passes the locked
// values from `experiments/voice-relay-qb/omission-fill-params.json`. The ws proxy will call it when it
// replaces the settle producer; the criterion drives it through THIS barrel, so the module stays behind
// the boundary like every other sibling.
export {
  planOmissionFills,
  type OmissionFill,
  type OmissionFillExecuted,
  type OmissionFillFinal,
  type OmissionFillNumeralMode,
  type OmissionFillParams,
  type OmissionFillPlan,
  type OmissionFillSkip,
  type OmissionFillSkipReason,
} from './voice-realtime-omission-fill.js';
