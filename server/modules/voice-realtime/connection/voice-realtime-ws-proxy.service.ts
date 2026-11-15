/**
 * The `/voice-realtime` WebSocket handler — the browser's half of a Realtime
 * voice connection (GOAL-031 / AC-312).
 *
 * WHY IT EXISTS. AC-310 wired the Realtime TOOL table to the real MCP services
 * (`voice-realtime-live-executor.ts`) and AC-311 made the bridge survive a
 * dropped connection, but both are server-side leaves: nothing let a BROWSER
 * open a Realtime session. This handler is that wire. It sits between the
 * browser socket and a real DashScope transport, so the credentials stay on the
 * server (the browser never dials the upstream itself) and the browser speaks
 * one small JSON protocol rather than DashScope's.
 *
 * WHY THERE IS NO INTENT CONFIRMATION (GOAL-033 / AC-316). Earlier builds
 * surfaced the model's proposed `session_send` as an editable draft and
 * awaited a browser `decision` frame before calling the real AC-310 handler.
 * AC-316 removed that step: Live Voice is a continuous-capture mode with no
 * per-utterance confirmation UI, so `session_send` now executes the moment the
 * model calls it. The bridge routes `function_call` frames straight into the
 * executor's routing table and exposes no `onFunctionCall` hook — deliberately,
 * so the bridge stays an offline-provable leaf — so this handler's executor
 * wrapper is now a thin single-flight guard rather than a confirmation gate.
 *
 * WHAT THE BROWSER MAY SAY (inbound, one JSON object per frame):
 *   - `{ type: 'hello', protocol }` — the segmented-relay offer, sent the moment the socket opens
 *     (P4 / AC-322). The server answers it, or does not, and that answer is the whole protocol
 *     switch: silence keeps the connection on the continuous frames below.
 *   - `{ type: 'segment_start' | 'audio' | 'segment_end' }` — one relay segment (SPEC §C1).
 *   - `{ type: 'context', text, chars, rows }` — the C2 context pack.
 *   - `{ type: 'audio', audio }`  — one base64 PCM frame from the capture
 *     pipeline (microphone or an injected test file), sent only while the
 *     browser is not muted.
 *   - `{ type: 'close' }` — the browser is done; the upstream is closed.
 *
 * WHAT THE SERVER SAYS (outbound):
 *   - `{ type: 'ready', protocol }` — the segmented-relay acceptance; absent means "stay continuous".
 *   - `{ type: 'state', state }`   — the bridge's connection state.
 *   - `{ type: 'sent', sessionId, result }` — the real `session_send` answer.
 *   - `{ type: 'error', code, message }` — a reported bridge/transport failure.
 *
 * The tool whitelist that pins every send onto the connection's one session is
 * NOT re-implemented here: the executor the caller injects is
 * `createVoiceRealtimeLiveExecutor`, whose `boundSessionId` already refuses a
 * call naming another session. This handler only decides WHEN a send happens,
 * never WHICH session it reaches.
 */
import { readFileSync } from 'node:fs';

import { WebSocket } from 'ws';

import { truncateRenderedVoiceContext } from "@shared/voice/voiceContextTruncation.js";

import { clearVoiceSessionActive, markVoiceSessionActive } from "../frames/voice-realtime-active.js";
import { pickAnnouncePhraseFrom } from "../core/voice-realtime-announce-phrases.js";
import type { VoiceRealtimeAudioCapture } from "../transport/voice-realtime-audio-capture.js";
import {
  connect,
  type RealtimeBridge,
  type RealtimeBridgeError,
  type RealtimeBridgeHooks,
  type RealtimeBridgeOptions,
  type RealtimeBridgeState,
  type RealtimeSegmentCommitMode,
  type RealtimeSegmentEndReason,
  type RealtimeSegmentForensics,
  type RealtimeSegmentPhaseEvent,
  type RealtimeToolExecutor,
  type RealtimeTransport,
  withoutToolResume,
} from "../frames/voice-realtime-bridge.service.js";
import {
  composeVoiceRealtimeInstructions,
  loadVoiceRealtimeSettings,
  resolveContextPackRuntimeSettings,
} from './voice-realtime-settings.js';
import {
  DEFAULT_VOICE_REALTIME_CLOSING_TURN,
  DEFAULT_VOICE_REALTIME_SLIM_SEND_TOOL,
  acceptedResultTail,
  afterStopSentence,
  type VoiceRealtimeClosingTurn,
} from "../frames/voice-realtime-closing-turn.js";
import {
  OMISSION_FILL_NUMERAL_MODES,
  planOmissionFills,
  type OmissionFill,
  type OmissionFillExecuted,
  type OmissionFillFinal,
  type OmissionFillParams,
} from "../frames/voice-realtime-omission-fill.js";
import { voiceRealtimeToolsFor } from "../frames/voice-realtime-tools.js";
import type {
  VoiceRealtimeTtsFrame,
  VoiceRealtimeTtsInput,
  VoiceRealtimeTtsResult,
} from '../core/voice-realtime-tts.js';
import { createLocalSpeechGate, type LocalSpeechBoundary } from "../transport/voice-realtime-local-speech.js";
import { createSilenceTailGate, type SilenceTailOptions } from "../transport/voice-realtime-silence-tail.js";
import {
  describeUplinkVadBackend,
  readUplinkVadBackend,
  type UplinkVadClassifier,
} from "../transport/voice-realtime-uplink-vad.js";
import {
  UPLINK_VAD_HOLD_OPEN_MAX_MS,
  createUplinkVadGate,
  type UplinkVadGate,
  type UplinkVadGateStats,
} from "../frames/voice-realtime-uplink-vad-gate.js";
import { markUplinkVadFailed, readUplinkVadState } from "../frames/voice-realtime-uplink-vad-arm-point.js";
import {
  describeSilenceDurationSource,
  describeTurnDetection,
  resolveTurnDetection,
  type TurnDetectionValues,
} from "../transport/voice-realtime-turn-detection.js";
import { createUpstreamPool, type UpstreamPoolRotation } from '../core/voice-realtime-upstream-pool.js';
import {
  SPEAKER_WINDOW_MS,
  SPEAKER_WINDOW_SAMPLE_RATE,
  createSpeakerWindowAccumulator,
  describeSpeakerShadowObservation,
  describeSpeakerShadowSummary,
  type SpeakerWindowAccumulator,
  type VoiceSpeakerTrackerSeam,
} from '../core/voice-realtime-speaker-seam.js';
import {
  SEGMENTED_RELAY_PROTOCOL,
  VOICE_REALTIME_MODE_ENV,
  applyVoiceRealtimeTransport,
  describeVoiceRealtimeMode,
  resolveVoiceRealtimeMode,
  type VoiceRealtimeTransport,
} from "../frames/voice-realtime-mode.js";
import { createDefaultVoiceRealtimeFrameRegistry } from './voice-realtime-frame-handlers.js';
import type {
  VoiceRealtimeFrameConnectionState,
  VoiceRealtimeFrameContext,
  VoiceRealtimeFrameRegistry,
} from './voice-realtime-frame-registry.js';
import { createDefaultVoiceRealtimeTrunkSteps } from './voice-realtime-trunk-step-handlers.js';
import type {
  VoiceRealtimeTrunkPayloads,
  VoiceRealtimeTrunkStep,
  VoiceRealtimeTrunkStepRegistry,
  VoiceRealtimeTrunkTiming,
} from './voice-realtime-trunk-steps.js';
import { VOICE_QUEUE_MAX_BYTES } from './voice-realtime-contract.js';
import type {
  HostCommandLifecycleReading,
  HostQueueReading,
  HostRunActivityReading,
  UplinkVadSeam,
  VoiceRealtimeExecPhase,
  VoiceRealtimeExecStatus,
  VoiceRealtimeExecStatusPatch,
  VoiceRealtimeExecStatusReading,
  VoiceRealtimeInboundFrame,
  VoiceRealtimeNarration,
  VoiceRealtimeNarratorInterruptReason,
  VoiceRealtimeNarratorQueue,
  VoiceRealtimeNarratorReading,
  VoiceRealtimeNarratorSeams,
  VoiceRealtimeNarratorTtsSeam,
  VoiceRealtimeOutboundFrame,
  VoiceRealtimePendingInteraction,
  VoiceRealtimeProxySeams,
  VoiceRealtimeRunDigest,
  VoiceRealtimeRunDigestPatch,
  VoiceRealtimeRunEndAckSeam,
  VoiceRealtimeRunEndSummarySeams,
} from './voice-realtime-contract.js';
// THE CONNECTION'S SMALLER CONCERNS LIVE IN frames/ AND transport/ (2026-11-03 god-package
// split). The class below keeps the connection's state and startup order; the prompt/status text,
// the narrator queue, the relay predicates, the shipped omission-fill parameters, the run-end
// quality readings and the bridge/transport error vocabulary each moved to a sibling subdirectory.
// The re-exports keep every existing `…ws-proxy.service.js` import path resolving.
import {
  VOICE_MAX_TIMER_DELAY_MS,
  VOICE_REALTIME_STATUS_MAX_INJECTIONS_PER_RUN,
  VOICE_REALTIME_STATUS_RATE_MS,
  createVoiceRealtimeExecStatus,
  runIdOf,
} from "./voice-realtime-exec-status.js";
import {
  buildInterruptAftermathNote,
  composeHostRunActivityReading,
  voiceRealtimeInstructionsFor,
  type ModelInterruptDecision,
} from "./voice-realtime-instructions.js";
import { createVoiceRealtimeNarratorQueue } from "./voice-realtime-narrator-queue.js";
import { readOmissionFillParams } from '../frames/omission-fill-params.js';
import {
  EMPTY_RELAY_TEXT,
  SEGMENT_TRANSCRIPT_GRACE_MS,
  VOICE_QUEUE_FULL_REASON,
  VOICE_REALTIME_CONTEXT_MAX_CHARS,
  normalizeRelayText,
  relayRestatesDelivery,
  voiceMessageBytes,
} from '../frames/relay-text.js';
import {
  DEFAULT_RUN_END_SUMMARY_POLL_MS,
  DEFAULT_RUN_END_SUMMARY_SETTLE_MS,
  DEFAULT_RUN_OUTPUT_WAIT_MS,
  RUN_END_SUMMARY_MAX_VERBATIM_TAIL,
  readVoiceRealtimeSummaryQuality,
} from '../frames/run-end-quality.js';
import {
  BUSY_RETRY_INTERVAL_MS,
  BUSY_RETRY_MAX_MS,
  UPLINK_VAD_EXIT_WAIT_MS,
  VOICE_BUSY_QUIET_CAP_MS,
  VOICE_BUSY_QUIET_SINCE_PIECE_MS,
  VOICE_BUSY_QUIET_WINDOW_MS,
  VOICE_BUSY_RELEASE_PRIORITY,
  VOICE_REALTIME_BUSY_POLL_MS,
  type VoiceBusyRelease,
} from '../transport/connection-tuning.js';
import { resolveSegmentSelection } from "../frames/segment-selection.js";
import {
  RECOVERABLE_ERROR_CODES,
  UPSTREAM_CANCELLED_BY_NEW_INPUT,
  describeBridgeError,
  describeTransportError,
  errorFrame,
  formatSegmentForensics,
} from "./voice-realtime-transport-errors.js";

export {
  VOICE_MAX_TIMER_DELAY_MS,
  VOICE_REALTIME_STATUS_MAX_BYTES,
  VOICE_REALTIME_STATUS_MAX_INJECTIONS_PER_RUN,
  VOICE_REALTIME_STATUS_RATE_MS,
  createVoiceRealtimeExecStatus,
} from "./voice-realtime-exec-status.js";
export {
  VOICE_REALTIME_INSTRUCTIONS,
  buildInterruptAftermathNote,
  composeHostRunActivityReading,
  voiceRealtimeInstructionsFor,
  type ModelInterruptDecision,
} from "./voice-realtime-instructions.js";
export { createVoiceRealtimeNarratorQueue } from "./voice-realtime-narrator-queue.js";
export {
  SEGMENT_TRANSCRIPT_GRACE_MS,
  VOICE_QUEUE_FULL_REASON,
  VOICE_REALTIME_CONTEXT_MAX_CHARS,
  normalizeRelayText,
  relayRestatesDelivery,
  voiceMessageBytes,
} from '../frames/relay-text.js';
export {
  DEFAULT_RUN_END_SUMMARY_POLL_MS,
  DEFAULT_RUN_END_SUMMARY_SETTLE_MS,
  DEFAULT_RUN_OUTPUT_WAIT_MS,
  RUN_END_SUMMARY_MAX_VERBATIM_TAIL,
  type VoiceRealtimeSummaryQuality,
  readVoiceRealtimeSummaryQuality,
} from '../frames/run-end-quality.js';
export {
  BUSY_RETRY_INTERVAL_MS,
  BUSY_RETRY_MAX_MS,
  UPLINK_VAD_EXIT_WAIT_MS,
  VOICE_BUSY_QUIET_CAP_MS,
  VOICE_BUSY_QUIET_SINCE_PIECE_MS,
  VOICE_BUSY_QUIET_WINDOW_MS,
  VOICE_BUSY_RELEASE_PRIORITY,
  VOICE_REALTIME_BUSY_POLL_MS,
} from '../transport/connection-tuning.js';
export {
  VOICE_REALTIME_SEGMENT_COMMIT_ENV,
  resolveSegmentSelection,
} from "../frames/segment-selection.js";
export {
  describeBridgeError,
  describeTransportError,
} from "./voice-realtime-transport-errors.js";

// The wire contract (frames, execution-status reading, seams) moved into
// `voice-realtime-contract.js` so a leaf that needs one shape does not have to import this handler.
// It is re-exported from here so every existing `…ws-proxy.service.js` import path keeps resolving;
// the handler keeps only the behaviour. The relay queue's byte budget moved with it: the reason it
// is an ADMISSION axis and cannot be a cancellation — `cancelQueuedInput` is `true` for the Claude
// provider, measured by E9 and E10/U4 — is documented on `VOICE_QUEUE_MAX_BYTES` there, not here.
export { VOICE_QUEUE_MAX_BYTES } from './voice-realtime-contract.js';
export type {
  HostCommandLifecycleReading,
  HostQueueReading,
  HostRunActivityReading,
  UplinkVadSeam,
  VoiceRealtimeExecPhase,
  VoiceRealtimeExecStatus,
  VoiceRealtimeExecStatusPatch,
  VoiceRealtimeExecStatusReading,
  VoiceRealtimeInboundFrame,
  VoiceRealtimeNarration,
  VoiceRealtimeNarratorInterruptReason,
  VoiceRealtimeNarratorQueue,
  VoiceRealtimeNarratorReading,
  VoiceRealtimeNarratorSeams,
  VoiceRealtimeNarratorTtsSeam,
  VoiceRealtimeOutboundFrame,
  VoiceRealtimePendingInteraction,
  VoiceRealtimeProxySeams,
  VoiceRealtimeRunDigest,
  VoiceRealtimeRunDigestPatch,
  VoiceRealtimeRunEndAckSeam,
  VoiceRealtimeRunEndSummarySeams,
} from './voice-realtime-contract.js';
// The `before-frame` parse and the `interrupt-decision` fence moved into the trunk step file
// beside this one (a step body runs them and a value import back would close a module cycle);
// they are re-exported here so every existing caller's import path is unchanged.
export { decideModelInterrupt, readVoiceRealtimeInboundFrame } from './voice-realtime-trunk-step-handlers.js';

/** The WebSocket path this handler answers. Mounted by the websocket gateway. */
export const VOICE_REALTIME_PATH = '/voice-realtime';

/**
 * The scopes a first-party voice connection carries.
 *
 * A voice connection presents no PAT and reaches no HTTP endpoint: it is opened
 * by an already-authenticated browser, so the browser's own authority is what it
 * acts with. The set is the full first-party vocabulary the gateway's tools
 * check against, listed in one place so a tool that later adds a scope names a
 * missing entry rather than silently narrowing what the user can say.
 */
export const VOICE_REALTIME_CALLER_SCOPES = [
  'cloudcli:approve',
  'cloudcli:navigate',
  'cloudcli:read',
  'cloudcli:session:control',
  'cloudcli:session:create',
  'cloudcli:session:send',
] as const;

/**
 * Parses one raw browser frame.
 *
 * THE READER MOVED to `voice-realtime-trunk-step-handlers.ts` with the `before-frame` step that
 * runs it; it is re-exported above, so the body and its reasoning are one edit away. `null` is
 * the drop reading it always was: a malformed or unknown frame is refused rather than answered,
 * because the browser speaks a protocol this server owns and a reply per mismatch would be a
 * frame storm.
 */

//----------------- THE LIVE VOICE REGISTRY — the one fact the dispatch hook gates on -------------
//
// The resident launch's `UserPromptSubmit` hook injects the "foreground schedules, background works"
// rules ONLY for a session that has a Live Voice connection at that moment, and this module is what
// tells it: a connection is handled ⇒ {@link markVoiceSessionActive}, every path that ends one ⇒
// {@link clearVoiceSessionActive}. The state lives in `frames/voice-realtime-active.ts`, in this process.
//
// IT USED TO BE A FILE AT `~/.cloudcli/voice-active/<session id>`. The hook was a command hook the
// CLI spawned in its own process, so a file was the cheapest channel across that boundary — at the
// price of a spawn per prompt and of a marker that outlived a relay which was killed, which is why a
// start-up sweep had to exist. The hook is now an in-process callback and both ends are here, so the
// gate is a `Set`. Nothing to clean up at start-up: a `Set` cannot outlive its process.

/**
 * One Live Voice connection's state and startup order.
 *
 * THE FUNCTION BELOW USED TO BE ONE 4,000-LINE CLOSURE. Every collaborator, timer and reading now
 * lives on this object, and the startup order is a list of chunk installers — one per concern — in
 * frames/ and transport/. The chunks are plain functions that take this connection as their `this`,
 * so their bodies are the original statements with the closure's bindings read through `this`:
 * the split changes no variable's lifetime, no callback's identity and no line's execution order.
 * The frame protocol (inbound routing, relay delivery, transcript bridge, run-end/busy frames) lives
 * in frames/; the upstream wire (transport construction, uplink VAD wiring, tuning) lives in
 * transport/.
 */
import type { RealtimeToolDescriptor } from '../frames/voice-realtime-tools.js';
import type { LocalSpeechGate } from '../transport/voice-realtime-local-speech.js';
import type { VoiceContextPackRuntimeResolution, VoiceRealtimeSettings } from './voice-realtime-settings.js';
import type { TurnDetectionResolution } from '../transport/voice-realtime-turn-detection.js';
import type { VoiceRealtimeModeResolution } from '../frames/voice-realtime-mode.js';
import type { SilenceTailGate } from '../transport/voice-realtime-silence-tail.js';
import {
  installConnectionSetup,
  installConnectionStatus,
  installDelivery,
  installInboundFrameRouting,
  installInterrupt,
  installRelay,
  installTranscriptBridge,
} from './voice-realtime-connection-frames.js';
import {
  installBusyWindow,
  installHostQueue,
  installRunEndSummary,
} from './voice-realtime-connection-turn.js';
import {
  installConnectionTeardown,
  installConnectionTransport,
  installUplinkVadWiring,
} from './voice-realtime-connection-transport.js';

export class VoiceRealtimeConnection {
  socket!: WebSocket;
  boundSessionId!: string;
  seams!: VoiceRealtimeProxySeams;
  acceptedTail!: string;
  advertisedTools!: readonly RealtimeToolDescriptor[];
  send!: (frame: VoiceRealtimeOutboundFrame) => void;
  sending!: boolean;
  closed!: boolean;
  audioFramesFromBrowser!: number;
  trunkSteps!: VoiceRealtimeTrunkStepRegistry;
  runTrunk!: <TTiming extends VoiceRealtimeTrunkTiming>(timing: TTiming, payload: VoiceRealtimeTrunkPayloads[TTiming]) => void;
  narratorQueue!: VoiceRealtimeNarratorQueue | null;
  announceNarrationSeq!: number;
  earlyAnnounceSeq!: number;
  earlyAnnounceArmed!: boolean;
  lastEarlyAnnounceAt!: number | null;
  EARLY_ANNOUNCE_SUPPRESS_MS!: number;
  modelReplyNarrationSeq!: number;
  narratorInterruptsOnUserSpeech!: boolean;
  narratorInterruptsOnLocalSpeech!: boolean;
  noteUserSpokeForNarrator!: () => void;
  localSpeechGate!: LocalSpeechGate;
  reportLocalSpeechBoundary!: (boundary: LocalSpeechBoundary | null) => void;
  settings!: VoiceRealtimeSettings;
  contextPackRuntime!: VoiceContextPackRuntimeResolution;
  turnDetection!: TurnDetectionResolution;
  shippedOmissionFill!: { params: OmissionFillParams | null; problem: string | null };
  omissionFillParams!: OmissionFillParams | null;
  contextText!: string;
  contextChars!: number;
  contextRows!: number;
  advertisedKey!: string | null;
  execStatus!: VoiceRealtimeExecStatus;
  statusRateMs!: number;
  statusInjectionsThisRun!: number;
  statusChangesThisRun!: number;
  statusCapReached!: boolean;
  statusMarker!: { more: number; } | null;
  statusTimer!: NodeJS.Timeout | null;
  noteStatus!: (patch: VoiceRealtimeExecStatusPatch) => void;
  advertiseInstructions!: () => boolean;
  flushStatus!: () => void;
  segmentCommitMode!: RealtimeSegmentCommitMode;
  modeResolution!: VoiceRealtimeModeResolution;
  segmentedRelay!: boolean;
  silenceTailOptions!: SilenceTailOptions | null;
  silenceTail!: SilenceTailGate | null;
  speakerWindows!: SpeakerWindowAccumulator | null;
  speakerObserveFailureLogged!: boolean;
  uplinkVadRequested!: boolean;
  uplinkVad!: UplinkVadGate | null;
  uplinkVadClassifier!: UplinkVadClassifier | null;
  uplinkVadExitWaitMs!: number;
  uplinkVadChain!: Promise<void>;
  uplinkVadExitSignals!: number;
  uplinkVadExitResolve!: (() => void) | null;
  signalUplinkVadExit!: (bit: number) => void;
  uplinkVadStats!: UplinkVadGateStats | null;
  uplinkVadBytesIn!: number;
  uplinkVadBytesOut!: number;
  uplinkVadFramesSinceCommit!: number;
  upstreamTurnCloseCount!: number;
  forcedCommitCloseSnapshot!: number | null;
  closeUplinkVadHeldTurn!: () => void;
  enqueueUplinkVad!: (audio: string) => void;
  activeSegmentSeq!: number | null;
  activeSegmentIsReplay!: boolean;
  deliveredSegmentSeqs!: Set<number>;
  unforwardedUserUtterances!: number;
  utteranceSeq!: number;
  deliveredSeqByCommandUuid!: Map<string, number>;
  coveredSeqs!: Set<number>;
  utteranceTextBySeq!: Map<number, string>;
  lastQueuedNotStartedText!: string | null;
  itemTranscriptEmpty!: Map<string, boolean>;
  itemTranscriptText!: Map<string, string>;
  transcribedSinceWatermark!: string[];
  lastCommittedUserItemId!: string | null;
  committedPendingTranscription!: Set<string>;
  committedCoveredByResponse!: Set<string>;
  finalTranscriptHeard!: boolean;
  speechEpoch!: number;
  deliveredEpoch!: number;
  recentDeliveredTexts!: string[];
  omissionFinals!: OmissionFillFinal[];
  omissionExecuted!: OmissionFillExecuted[];
  omissionSpeechStarts!: number[];
  omissionIndexByItemId!: Map<string, number>;
  omissionSettled!: Set<number>;
  omissionTimer!: NodeJS.Timeout | null;
  abortedTriggerSeq!: number | null;
  lastAcceptedRelayText!: string;
  segmentFrameCounts!: Map<number, number>;
  awaitingTranscriptionSeqs!: number[];
  segmentTranscriptEmpty!: Map<number, boolean>;
  emptiedSegmentSeqs!: Set<number>;
  committedSegmentSeqs!: Set<number>;
  segmentSeqByItemId!: Map<string, number>;
  rejectedSegmentSeqs!: Set<number>;
  endedSegmentSeqs!: Set<number>;
  heldDelivery!: { seq: number; isReplay: boolean; args: Record<string, unknown>; resolve: (value: unknown) => void; } | null;
  heldTimer!: NodeJS.Timeout | null;
  transcriptGraceMs!: number;
  segmentSeqForCaption!: (itemId: string) => number | null;
  base!: Readonly<Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>>;
  waitingForBusySession!: boolean;
  waitingExtraMessages!: string[];
  cliQueuedDeliveries!: number;
  cliQueuedBytes!: number;
  hostQueueSource!: ((sessionId: string) => HostQueueReading | null) | undefined;
  hostQueueSample!: HostQueueReading | null;
  refreshHostQueue!: () => void;
  aftermathNote!: string | null;
  lastDeliveryCarriedNote!: boolean;
  readInFlightTool!: () => string | null;
  readRunBusy!: () => boolean | null;
  sampleRunBusy!: () => { busy: boolean | null; source: "host-rounds" | "turn-phase" | null; };
  cliQueueTerm!: () => { known: boolean; items: number; bytes: number; };
  queuedMessageUuidOf!: (result: unknown) => string | null;
  enqueueConfirmed!: (result: unknown) => boolean;
  rememberDeliveredCommand!: (result: unknown) => void;
  refreshInterruptCovers!: () => void;
  pendingQueueUuids!: () => string[];
  pushQueueReconcile!: () => void;
  lastReconcileKey!: string;
  reconcilePollTimer!: NodeJS.Timeout | null;
  armReconcilePoll!: (watch: boolean) => void;
  sampleRunDigest!: () => VoiceRealtimeRunDigestPatch;
  deliverSessionSend!: (args: Record<string, unknown>, answeredThroughItemId?: string | null) => Promise<unknown>;
  coalesceMs!: number;
  pendingParts!: string[];
  pendingExtra!: Record<string, unknown>;
  coalesceTimer!: NodeJS.Timeout | null;
  pendingBoundary!: string | null;
  queuedDepth!: () => number;
  joinParts!: (parts: readonly string[]) => string;
  queuedBytes!: () => number;
  drainPollTimer!: NodeJS.Timeout | null;
  armDrainPoll!: () => void;
  pollDrain!: () => void;
  runEndSummary!: VoiceRealtimeRunEndSummarySeams | undefined;
  runEndAck!: VoiceRealtimeRunEndAckSeam | undefined;
  runEndSettleMs!: number;
  runEndOutputWaitMs!: number;
  runEndPollMs!: number;
  runEndVerbatimTailMax!: number;
  runEndWatchTimer!: NodeJS.Timeout | null;
  runEndSettleTimer!: NodeJS.Timeout | null;
  runOutputPending!: { requestId: string; generation: number; runId: string | null; } | null;
  runOutputTimer!: NodeJS.Timeout | null;
  runOutputSeq!: number;
  runEndGeneration!: number;
  runEndAckDeferredGeneration!: number | null;
  clearRunEndSettle!: () => void;
  speakRunEndAck!: (runId?: string | null) => void;
  clearRunOutputRequest!: () => void;
  requestRunOutput!: (generation: number, runId: string | null) => void;
  summarizeRunOutput!: (generation: number, runId: string | null, output: string) => Promise<void>;
  scheduleRunEndSummary!: (options?: { deferAck?: boolean }) => void;
  pollRunEnd!: () => void;
  armRunEndWatch!: () => void;
  flushCoalesced!: (busyRelease?: VoiceBusyRelease | null) => void;
  armCoalesce!: () => void;
  busyPollMs!: number;
  busyQuietWindowMs!: number;
  busyQuietSincePieceMs!: number;
  busyQuietCapMs!: number;
  busyPollTimer!: NodeJS.Timeout | null;
  busyQuietTimer!: NodeJS.Timeout | null;
  busyWindowOpenedAt!: number | null;
  lastBusyPieceAt!: number | null;
  upstreamTalking!: boolean;
  lastUpstreamSilenceAt!: number | null;
  busyBufferEngaged!: boolean;
  emitPending!: () => void;
  clearBusyPoll!: () => void;
  clearBusyQuiet!: () => void;
  busyQuietDueAt!: (now: number) => number | null;
  armBusyQuietWindow!: () => void;
  releaseBusyQuiet!: () => void;
  resetHeldBuffer!: () => void;
  armBusyPoll!: () => void;
  pollBusy!: () => void;
  handledWithoutDelivery!: () => unknown;
  noteNotDelivered!: (reason: string) => void;
  answerSegmentDropped!: (seq: number, reason: "empty-transcript" | "commit-refused") => void;
  markSegmentEmpty!: (seq: number) => void;
  proceedRelay!: (args: Record<string, unknown>, segmentSeq: number | null, segmentIsReplay: boolean) => Promise<unknown>;
  releaseHeldDelivery!: () => void;
  holdUntilTranscriptKnown!: (seq: number, isReplay: boolean, args: Record<string, unknown>) => Promise<unknown>;
  logOmissionFill!: (payload: Record<string, unknown>) => void;
  clearOmissionTimer!: () => void;
  deliverOmissionFill!: (message: string) => Promise<unknown>;
  evaluateOmissionFill!: () => void;
  registerOmissionFinal!: (text: string, itemId: string) => void;
  closeOmissionFillsDeliveredVerbatim!: (itemIds: readonly string[]) => void;
  registerOmissionExecuted!: (message: unknown) => void;
  registerOmissionSpeechStart!: () => void;
  claimOutstandingCommits!: () => void;
  relaySessionSend!: (args: Record<string, unknown>) => Promise<unknown>;
  sessionSend!: (args: Record<string, unknown>) => Promise<unknown>;
  writeInterruptAudit!: (args: Record<string, unknown>, outcome: "aborted" | "no-run" | "refused" | "covered", queuedStillPending: number, inFlightTool: string | null, noteCarried: boolean) => { runId: string | null; triggerSeq: number | null; queuedStillPending: number; };
  sessionInterrupt!: (args: Record<string, unknown>) => Promise<unknown>;
  executor!: Readonly<Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>>;
  reportTransportError!: (error: { code: string; } & Record<string, unknown>) => void;
  onSegmentPhase!: (event: RealtimeSegmentPhaseEvent) => void;
  bridge!: RealtimeBridge;
  lastSendingTransport!: RealtimeTransport | null;
  openTransport!: () => RealtimeTransport;
  uplinkVadExiting!: boolean;
  uplinkVadExitStarted!: boolean;
  teardown!: () => void;
  exitUplinkVad!: () => Promise<void>;
  frameRegistry!: VoiceRealtimeFrameRegistry;
  frameState!: VoiceRealtimeFrameConnectionState;
  frameContext!: VoiceRealtimeFrameContext;
  browserKeepaliveMs!: number;
  browserAnsweredPing!: boolean;
  browserKeepaliveTimer!: NodeJS.Timeout | null;
  connect!: typeof connect;
  withoutToolResume!: typeof withoutToolResume;

  constructor(socket: WebSocket, boundSessionId: string, seams: VoiceRealtimeProxySeams) {
    this.socket = socket;
    this.boundSessionId = boundSessionId;
    this.seams = seams;
    this.connect = connect;
    this.withoutToolResume = withoutToolResume;
  }

  start(): void {
    installConnectionSetup.call(this);
    installConnectionStatus.call(this);
    installUplinkVadWiring.call(this);
    installTranscriptBridge.call(this);
    installHostQueue.call(this);
    installDelivery.call(this);
    installRunEndSummary.call(this);
    installBusyWindow.call(this);
    installRelay.call(this);
    installInterrupt.call(this);
    // A synchronous transport-construction failure is the one fatal startup branch: the original
    // function RETURNED there, before the teardown definitions and the socket handlers existed.
    // The chunk reports that, and start() preserves the same exit.
    if (!installConnectionTransport.call(this)) {
      return;
    }
    installConnectionTeardown.call(this);
    installInboundFrameRouting.call(this);
  }
}

/**
 * Runs one browser voice connection to completion.
 *
 * Consumed by `server/index.ts`, which derives `boundSessionId` and the caller
 * from the authenticated upgrade request and hands the result to the websocket
 * gateway's `/voice-realtime` branch.
 *
 * The socket is closed by this function on every terminal path — an upstream
 * failure, the browser's own `close`, or the socket's `close` event — because a
 * browser that keeps its microphone open against a dead upstream is the one
 * state this must not leave behind.
 */
export function handleVoiceRealtimeConnection(
  socket: WebSocket,
  boundSessionId: string,
  seams: VoiceRealtimeProxySeams,
): void {
  new VoiceRealtimeConnection(socket, boundSessionId, seams).start();
}

