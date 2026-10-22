import { useCallback, useEffect, useRef, useState } from 'react';

import { decodeVoiceBlob, downsampleVoice, UPLOAD_SAMPLE_RATE } from '@/shared/audioDecode';
import {
  DEFAULT_FLUSH_SILENCE_SEC,
  DEFAULT_KEEP_GAP_SEC,
  DEFAULT_MIN_SEGMENT_SEC,
  LiveSegmenter,
  segmentLive,
  type LiveSegment,
} from '@/modules/chat/utils/voice/voiceLiveSegmenter';
import {
  reassembleText,
  runSegmentPipeline,
  type ReassemblyPart,
  type SegmentJob,
  type SegmentOutcome,
} from '@/modules/chat/utils/voice/voiceSegments';
import {
  buildVoiceLiveReading,
  type VoiceSegmentMetric,
  type VoiceUsage,
} from '@/modules/chat/utils/voice/voiceLiveReading';
import { buildVoiceInputContextPack } from '@/modules/chat/utils/voice/voiceContextPack';
import { voicePlayer } from '@/modules/chat/utils/voice/voicePlayer';
import { VOICE_FRAME_PROCESSOR_NAME, type VoiceFrameMessage } from '@/modules/chat/audio/voiceFrameProcessor';
import { voiceFrameProcessorUrl } from '@/modules/chat/audio/voiceFrameProcessorUrl';
import {
  clientAsrSegmentTimeoutMs,
  installVoiceClientAsrEngine,
  routeClientAsrSegment,
  type VoiceClientFallbackReason,
} from '@/shared/voiceClientAsrWorker';
import { api, captureRawVoice, effectivePauseCuesDeclaration, transcribeVoice } from '@/shared/api';
import type { VoiceUploadAddress } from '@/shared/api';
import { readVoiceRuntimeConfig } from '@/shared/voiceRuntimeConfig';
import {
  hydrateVoiceRawCapture,
  isVoiceClientAsrSelected,
  isVoiceRawCaptureEnabled,
  readVoiceConfig,
} from '@/shared/voiceConfig';
import { labelsFor, type VoiceSourceSegment } from '@/shared/voiceEditLabels';
import { identifierFidelity } from '@/shared/identifierFidelity';
import { repairIdentifiers } from '@/shared/identifierRepair';
import { StreamingVad, type VadEvent } from '@/shared/voiceEndpoint';
import type {
  ChatMessage,
  VoiceClip,
  VoiceClipPlayState,
  VoiceClipSlot,
  VoiceClipTrack,
  VoiceFailureReport,
  VoiceInputState,
  VoiceTranscriptionFailure,
} from '@/shared/types';
import {
  isVoiceDebugEnabled,
  isVoiceTrimEnabled,
  isVoiceVadEnabled,
  voiceDebugFlushSilenceSec,
  voiceDebugIdleSec,
  voiceDebugMinSegmentSec,
  voiceDebugOriginalCapSec,
} from '@/shared/voiceDebug';
// The read point that turns a recogniser's declared `pauseCues` into the one answer to 裁不裁.
// The capability itself arrives through the health reading's accessor (see `gapFilterSecForCapture`),
// so this hook holds no table of its own — it asks the recogniser that will transcribe the audio.
import { trimDecisionFor, trimSilenceEdges } from '@/shared/voiceTrim';
// The recogniser's answer is read by the same module that built the request — the
// repository-root shared tree the server and the CLI compile.
import { parseTranscriptionResponse } from '@shared/asr/transcriptionWire';

/**
 * Continuous voice capture: one press, one stream, and as many uploads as the speech needs.
 *
 * THERE IS ONLY ONE PATH. A short dictation and a long one are the same code: the microphone's PCM
 * is segmented as it arrives, every segment is transcribed on its own, and the answers are committed
 * in the order they were spoken. A press whose speech is followed by five seconds of silence reaches
 * the recogniser on that silence — the segmenter's flush — so the box fills while the microphone is
 * still open; anything still buffered when the press ends is flushed by the stop, which is the shape
 * the old press-to-talk path always had. While a request from a still-recording listen is outstanding
 * the hook reports `inFlight`, which the composer paints as the mic button's pulsing dot.
 *
 * WHAT THE USER SEES WHILE TALKING. Text appears as each segment settles, but only the *contiguous
 * prefix*: if the second segment's answer arrives before the first's, nothing is committed until the
 * first lands, and then both do, in order. A segment whose retries are exhausted contributes no text
 * at all — the failure is reported in the composer's own red notice, and the segments after it are
 * still committed, so one lost segment costs a phrase rather than the rest of the dictation.
 *
 * WHERE THE TEXT GOES. The hook hands the composer the committed text *so far* on every commit
 * (`onTranscript(full, false)`) and, when the stop was a send, once more with the whole text and
 * `send=true`. The composer owns where that text sits: it tracks the insertion range that opened at
 * the caret when listening began (see `voiceInsertion.ts`), so edits the user makes elsewhere while
 * talking are preserved and the committed words stay contiguous.
 *
 * The clip slot it fills on stop is the replay pair: the filtered audio the segments were cut from,
 * and — when the stream was short enough to keep — the raw PCM the microphone produced.
 */

/** How many retries follow a segment's first attempt before it is reported as lost. */
const SEGMENT_MAX_RETRIES = 2;

/**
 * A segment the on-device recogniser handed to the server, carrying the reason it did.
 *
 * The reason travels WITH the hand-off rather than being reported inside the router, because the two
 * consumers are different concerns: the router's `VoiceClientFallbackDetail` is the announcement
 * (a window event, for anything that wants to know audio left the device), while this is what the
 * composer needs to (a) tell the user why in the notice they are already looking at and (b) address
 * the upload to the fallback recogniser. Passing it as a value keeps the router free of UI.
 */
type ClientAsrGiveUp = { reason: VoiceClientFallbackReason; message: string };

/**
 * The longest a stream may run without any speech before the microphone is closed on its own.
 *
 * A press that is never released — the phone put in a pocket, a tab left open — keeps the mic open
 * and, with it, the browser's recording indicator, for as long as the page lives. This closes it
 * after two minutes of silence without spending a request: silence produces no segments, so the
 * flush at this stop is empty.
 */
const DEFAULT_IDLE_AUTOSTOP_SEC = 120;

/**
 * The longest raw stream kept for the replay slot, in seconds.
 *
 * The original track is 16 kHz mono PCM (32 KB/s), so ten minutes is about 19 MB held in page
 * memory for the length of one dictation. Past it the slot keeps only the filtered audio rather
 * than a truncated original: a replay that silently stops halfway would misrepresent the recording.
 */
const ORIGINAL_CAP_SEC = 600;

/** How often the idle guard looks at the clock. Well under a second, cheap enough to run while idle. */
const IDLE_POLL_MS = 250;

/** The name the segments' uploads carry, so a log line names which piece of a sentence it was. */
const SEGMENT_BASE_NAME = 'segment';

/**
 * The per-tab counter that keeps two listens in one page from sharing a minted pairing id.
 *
 * A module-level counter rather than anything on the session: the id has to be unique across the
 * listens of this page, which is a property of the page rather than of one session's state.
 */
let listenSequence = 0;

/**
 * Mints the pairing id ONE listen carries, on every `/transcribe` upload and on its raw corpus row.
 *
 * WHY IT IS MINTED HERE RATHER THAN BY THE SERVER. The raw corpus row and the trimmed rows are
 * written by two different requests — the raw upload happens after the listen ends, the trims during
 * it — so the only side that can name the pair before either request exists is the client that is
 * doing the recording. Both requests carry this one string, and a reader joins them on it.
 *
 * UNIQUENESS IS BY CONSTRUCTION, not by probability: the per-tab sequence alone distinguishes two
 * listens in one page, and the wall clock plus a random suffix distinguish this page from another
 * tab or a reloaded one. The characters are all file-name safe, so the server can build a raw file
 * name from it without the substitution having to rewrite it.
 */
function mintListenId(): string {
  listenSequence += 1;
  return `listen-${Date.now().toString(36)}-${listenSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** A 16-bit mono PCM WAV's header, matching `audioDecode`'s and the segmenter's encoders. */
const WAV_HEADER_BYTES = 44;

/** The rate the original replay track is stored at: the same 16 kHz the uploads use. */
const STORE_SAMPLE_RATE = UPLOAD_SAMPLE_RATE;

/**
 * A segmenter's frame sink: the PCM the audio graph produced, and the VAD events that preceded it.
 *
 * This is the seam between "where the audio comes from" and "what is done with it". The shipping
 * engine runs an `AudioWorklet` on the microphone; a test supplies PCM directly, because jsdom has
 * neither an audio thread nor a microphone.
 */
export type VoiceCaptureSink = {
  /** One 20 ms frame of PCM plus the VAD events that arrived before it. */
  onFrame: (samples: Float32Array, atSample: number, events: readonly VadEvent[]) => void;
  /** A speech transition, used only by the idle guard. */
  onActivity: () => void;
};

/**
 * Where a listen's PCM and VAD events come from.
 *
 * `start` resolves with the sample rate the frames are at, which is what the segmenter is built
 * against — the audio graph's own rate, not a constant, because a browser capture may be 44.1 or
 * 48 kHz and the frame grid has to match it exactly.
 */
export type VoiceCaptureEngine = {
  start: (stream: MediaStream, sink: VoiceCaptureSink) => Promise<number>;
  stop: () => void;
};

/**
 * The shipping engine: the microphone's PCM framed by `voiceFrameProcessor` on the audio thread.
 *
 * The worklet forwards each 20 ms frame's samples and the VAD events it produced; the events are
 * buffered here until the next frame, because a VAD event is backdated and the segmenter needs the
 * audio it names in the same push.
 */
function workletCaptureEngine(): VoiceCaptureEngine {
  let context: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  return {
    async start(stream, sink) {
      const url = voiceFrameProcessorUrl();
      if (!url) throw new Error('AudioWorklet is unavailable');
      const created = new AudioContext();
      context = created;
      await created.audioWorklet.addModule(url);
      const createdNode = new AudioWorkletNode(created, VOICE_FRAME_PROCESSOR_NAME, {
        processorOptions: { sampleRate: created.sampleRate },
      });
      node = createdNode;
      const events: VadEvent[] = [];
      createdNode.port.onmessage = (message: MessageEvent<VoiceFrameMessage>) => {
        const data = message.data;
        if (!data) return;
        if (data.type === 'pcm') {
          const pending = events.splice(0);
          sink.onFrame(data.samples, data.atSample, pending);
        } else if (data.type === 'event') {
          events.push(data.event);
          sink.onActivity();
        }
      };
      // A zero-gain sink pulls the graph without the microphone reaching the speakers.
      const silent = created.createGain();
      silent.gain.value = 0;
      created.createMediaStreamSource(stream).connect(createdNode);
      createdNode.connect(silent);
      silent.connect(created.destination);
      return created.sampleRate;
    },
    stop() {
      if (node) node.port.onmessage = null;
      node = null;
      const closing = context;
      context = null;
      if (closing) {
        try {
          void closing.close();
        } catch {
          /* a context already closed */
        }
      }
    },
  };
}

/**
 * The recogniser seam's classification out of a refused transcription answer.
 *
 * Read out of the answer's body rather than derived from its status, because the status alone
 * cannot say which of the two refusals this was. `415` and `413` are the two the seam publishes —
 * a container the provider does not read, and an upload past its budget — and both arrive on the
 * direct path and on the proxy path alike, carrying `UNSUPPORTED_MIME` or `OVERSIZE` beside the
 * message.
 */
async function refusalDetail(response: Response): Promise<VoiceTranscriptionFailure> {
  try {
    const body: unknown = await response.clone().json();
    const record = body as { code?: unknown; upstreamCode?: unknown } | null;
    const code = typeof record?.code === 'string' && record.code ? record.code : undefined;
    const upstreamCode =
      typeof record?.upstreamCode === 'string' && record.upstreamCode ? record.upstreamCode : undefined;
    return { status: response.status, code, upstreamCode };
  } catch {
    return { status: response.status };
  }
}

/**
 * The record id out of a recogniser answer, when the deployment kept a record for it.
 *
 * THE HANDLE THE CORRECTION NEEDS, and the reason a `clone()` is taken here at all: the id rides on
 * the transcription answer (the store wrote the record before answering) but it is NOT part of the
 * transcript envelope the wire parser reads, so it has to be picked up beside that parse rather than
 * out of it. Absent is the ordinary case for a user who turned recording off — the store wrote
 * nothing, so there is no id — and it is answered as null rather than as an error, because a
 * dictation that kept no record is a dictation that succeeded.
 *
 * The clone is taken ONLY when the user's own `voiceDataRecording` says records are being kept, so a
 * user who turned recording off pays no second read of the body on every segment.
 */
async function readRecordId(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { recordId?: unknown } | null;
    const recordId = body?.recordId;
    return typeof recordId === 'string' && recordId !== '' ? recordId : null;
  } catch {
    return null;
  }
}

/** Which entry the audio came in through. */
export type VoiceSource = 'mic' | 'file';

/**
 * The token usage out of a recogniser answer, when the provider returned any.
 *
 * A `clone()` is taken because the answer's body is consumed by the transcript parse; the clone is
 * only taken under the debug switch, so a normal dictation pays no second read. A provider that
 * returns no usage — every stand-in the e2e specs use — yields null rather than zeros, so "unknown"
 * and "zero tokens" stay distinguishable in the reading.
 */
async function readUsage(response: Response): Promise<VoiceUsage | null> {
  try {
    const body = (await response.clone().json()) as { usage?: Record<string, unknown> } | null;
    const usage = body?.usage;
    if (!usage || typeof usage !== 'object') return null;
    const read = (key: string): number | undefined => (typeof usage[key] === 'number' ? (usage[key] as number) : undefined);
    return {
      promptTokens: read('prompt_tokens') ?? read('promptTokens'),
      completionTokens: read('completion_tokens') ?? read('completionTokens'),
      totalTokens: read('total_tokens') ?? read('totalTokens'),
    };
  } catch {
    return null;
  }
}

/** Adds one segment's usage onto the input's running total, field by field. */
function accumulateUsage(total: VoiceUsage | null, next: VoiceUsage | null): VoiceUsage | null {
  if (!next) return total;
  const add = (a?: number, b?: number): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return {
    promptTokens: add(total?.promptTokens, next.promptTokens),
    completionTokens: add(total?.completionTokens, next.completionTokens),
    totalTokens: add(total?.totalTokens, next.totalTokens),
  };
}

/** Builds a canonical 16-bit mono PCM WAV from little-endian PCM bytes already in hand. */
function wavFromPcm16(data: Uint8Array, sampleRate: number): Blob {
  const bytes = new Uint8Array(WAV_HEADER_BYTES + data.length);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + data.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, data.length, true);
  bytes.set(data, WAV_HEADER_BYTES);
  return new Blob([bytes], { type: 'audio/wav' });
}

/** The PCM payload of a canonical WAV this module or the segmenter built (44-byte header). */
function wavPcm16(wav: Uint8Array): Uint8Array {
  return wav.subarray(WAV_HEADER_BYTES);
}

/** A recorded track's clip: its object URL plus the meta the replay control renders. */
function clipFromPcm16(data: Uint8Array, sampleRate: number): VoiceClip {
  const blob = wavFromPcm16(data, sampleRate);
  return {
    url: URL.createObjectURL(blob),
    meta: { bytes: blob.size, mimeType: blob.type, durationMs: Math.round((data.length / 2 / sampleRate) * 1000) },
  };
}

/** Concatenates Int16 chunks into one little-endian buffer. */
function concatInt16(chunks: Int16Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const bytes = new Uint8Array(total * 2);
  const view = new DataView(bytes.buffer);
  let at = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      view.setInt16(at, chunk[i], true);
      at += 2;
    }
  }
  return bytes;
}

/** Concatenates float sample views into one buffer, for the whole-buffer (no-VAD) segment. */
function concatFloat(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Encodes mono float samples as a canonical 16-bit PCM WAV at `sampleRate`.
 *
 * The same layout `audioDecode.ts` and the segmenter's encoder write (RIFF/WAVE, a 16-byte `fmt `
 * chunk, mono, 16-bit), so a reader cannot tell which of the three produced it. It is here rather
 * than imported because the segmenter's encoder is private and hands back `Uint8Array` only for
 * segments it built itself; this is the one caller that has samples the segmenter never saw.
 */
function encodePcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(WAV_HEADER_BYTES + i * 2, Math.round(clamped * 32_767), true);
  }
  return bytes;
}

/**
 * The one segment a no-VAD path sends: the whole input, resampled to the upload rate and encoded.
 *
 * This is the `voiceVad=off` shape — no cut, no gap filter, nothing dropped — so the reading's
 * `sentSec` comes out equal to its `recordedSec` and the A/B really is "before" against "after"
 * rather than two different cuts.
 */
function wholeBufferSegment(samples: Float32Array, sampleRate: number): LiveSegment {
  const down = downsampleVoice(samples, sampleRate, UPLOAD_SAMPLE_RATE);
  return {
    wav: encodePcm16Wav(down.samples, UPLOAD_SAMPLE_RATE),
    startSec: 0,
    endSec: samples.length / sampleRate,
    forced: false,
  };
}

/** The duration of a segment's own uploaded audio, in seconds, read off the WAV it built. */
function segmentWavSec(wav: Uint8Array): number {
  return (wav.length - WAV_HEADER_BYTES) / 2 / UPLOAD_SAMPLE_RATE;
}

/**
 * Removes only the empty edges of one segment's WAV before it is uploaded.
 *
 * WHY AT THIS LAYER. The segmenter's flush can leave several seconds of silence at the tail of a
 * push-to-talk segment (the real 2026-10-22 recording: 2 s of speech, then 8 s of near-silence).
 * That silence costs upload bytes, gives the recogniser no words, and — as the same recording
 * showed — gives a model with little to tidy a chance to answer with nearby instruction text. The
 * trim is the ordinary VAD splice with every internal pause kept whole (`trimSilenceEdges`), so the
 * recogniser still sees its punctuation cues; only the head/tail outside the first/last speech
 * region is dropped.
 *
 * FALLBACK IS THE SEGMENT AS RECORDED. A short buffer, an unsupported rate or a detector that finds
 * no speech returns the input unchanged; losing a dictation is worse than sending its silence.
 */
function trimSegmentEdges(wav: Uint8Array): Uint8Array {
  const pcm = wavPcm16(wav);
  if (pcm.length < 2) return wav;

  const samples = new Float32Array(pcm.length / 2);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32_768;
  }

  const trimmed = trimSilenceEdges(samples, UPLOAD_SAMPLE_RATE);
  if (trimmed.stats.fallback || trimmed.samples.length >= samples.length) return wav;
  return encodePcm16Wav(trimmed.samples, UPLOAD_SAMPLE_RATE);
}

/**
 * How long a stepped-over silence gap is kept, for the recogniser that will transcribe this input.
 *
 * THE GAP FILTER IS THIS PATH'S 裁不裁, and 裁不裁 is the recogniser's own declaration (ADR-004
 * decision 1), read at the capability's one read point in `@/shared/voiceTrim` — the pure mapping
 * from a declared capability to "run the trim". A recogniser whose pauses are worth nothing to it
 * (`destructive`) gets long stepped-over gaps compressed to `DEFAULT_KEEP_GAP_SEC` — the shipped
 * behaviour. One whose declaration says its pauses may carry the punctuation (`neutral` / `useful`)
 * keeps them whole, which the segmenter expresses by asking it to keep gaps of unbounded length;
 * no capability knowledge is added to that module, it is only handed a length.
 *
 * The declaration is asked for BY THE ID THE REQUEST WILL BE SENT UNDER — the accessor above reads
 * back the health reading's effective provider, the same id `transcribeVoice` routes on — rather
 * than by an id written here. No declaration to read (the health reading has not landed, or names
 * an id no adapter claims) is not a licence to trim: the filter changes the audio, so an unknown
 * recogniser gets its pauses kept. The switch is the user's and only ever turns a trim off, so it
 * is ANDed with the declaration.
 */
function gapFilterSecForCapture(): number {
  const recogniser = effectivePauseCuesDeclaration();
  if (!isVoiceTrimEnabled() || recogniser === null || !trimDecisionFor(recogniser.capability).trim) {
    return Number.POSITIVE_INFINITY;
  }
  return DEFAULT_KEEP_GAP_SEC;
}

/**
 * The snapshot a new session keeps, with its caret clamped into its own text.
 *
 * The caret is read off a textarea and can be stale or out of range (a standalone render has no
 * textarea at all); clamping here is what keeps the split from producing a 「光标前」 longer than
 * the draft it came from.
 */
function draftSnapshotOrNull(draft: VoiceDraftSnapshot | undefined): VoiceDraftSnapshot | null {
  if (draft === undefined) return null;
  return { text: draft.text, cursor: Math.max(0, Math.min(draft.cursor, draft.text.length)) };
}

/** Concatenates PCM payloads into one buffer. */
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/**
 * One listen's live state, from the first frame to the last committed segment.
 *
 * It is a plain object held in a ref rather than React state because the audio callbacks and the
 * in-flight transcriptions all read and write it outside a render, and every one of them has to see
 * the same values: a state update would hand a callback a snapshot from a previous commit.
 */
type CaptureSession = {
  /** Where the audio comes from; a file is a finite stream whose "stop" is its whole length. */
  source: VoiceSource;
  /**
   * The pairing id this listen carries, minted once at the start and reused by every one of its
   * requests — every segment's `/transcribe` upload and, at the end, the raw corpus upload.
   */
  listenId: string;
  /** The engine that produced this session's frames, so it can be stopped with it. */
  engine: VoiceCaptureEngine;
  /** The segmenter turning PCM and VAD events into upload-sized segments; null until start resolves. */
  segmenter: LiveSegmenter | null;
  /** Next segment ordinal to commit. Segments settle out of order; this is the ordering cursor. */
  nextCommit: number;
  /** Settled outcomes not yet committable because an earlier ordinal is still in flight. */
  settled: Map<number, SegmentOutcome>;
  /** The successfully transcribed parts, for the seam-deduplicating reassembly. */
  parts: ReassemblyPart[];
  /** The full committed text last handed to the composer. */
  committed: string;
  /**
   * The composer draft this listen started in, with its caret — the 「光标前/光标后」 halves of the
   * context pack. Snapshotted once when the session is created and never refreshed: the draft the
   * user keeps editing while they talk is not what this dictation is being committed into.
   *
   * `null` for the file entry, which has no box to have started from.
   */
  draft: VoiceDraftSnapshot | null;
  /** Segments submitted but not yet settled (retries included). */
  pending: number;
  /** The next ordinal a newly closed segment takes. */
  nextIndex: number;
  /** Wall clock of the last speech event or committed segment; the idle guard reads it. */
  lastActivityAt: number;
  idleTimer: number | null;
  /** True once the stop has begun; a second stop is a no-op. */
  stopRequested: boolean;
  /** Whether the stop should send the composer once every segment has settled. */
  sendRequested: boolean;
  /** The last refusal seen for an ordinal, so a failed segment can report its code. */
  refusals: Map<number, VoiceTranscriptionFailure>;
  /** Raw 16 kHz PCM chunks for the original replay track, until the cap is passed. */
  originalChunks: Int16Array[];
  originalSamples: number;
  originalCapped: boolean;
  /** Filtered 16 kHz PCM (the segments' own audio) for the trimmed replay track. */
  filteredChunks: Uint8Array[];
  filteredSamples: number;
  /** True when this session sends the whole input as one segment (`voiceVad=off`). */
  wholeBuffer: boolean;
  /** The raw PCM this session accumulated for the whole-buffer case, copied as it arrived. */
  wholeChunks: Float32Array[];
  /** Total input samples: pushed (mic) or decoded (file), before any cut. */
  inputSamples: number;
  /** The rate those samples are at — the engine's for a mic, the decoder's for a file. */
  inputRate: number;
  /** Wall clock the capture began, so a segment's buffered wait is measurable on the mic path. */
  captureStartedAt: number;
  /** One measurement per submitted segment, indexed by its ordinal. */
  readings: VoiceSegmentMetric[];
  /** When the first segment was cut, or null before any was — the first-text latency's origin. */
  firstCutAt: number | null;
  /** From that cut to the first text in the composer, or null while no text has arrived. */
  firstTextLatencyMs: number | null;
  /** Cumulative usage the recogniser returned, when it returned any. */
  usage: VoiceUsage | null;
  /**
   * The voice-data record each ordinal's transcription was kept in, when the deployment kept one.
   *
   * ONE RECORD PER SEGMENT, because the store writes one per transcription and the server answers
   * each segment's upload with its own id — so a correction is written back per segment rather than
   * per listen. An ordinal is absent here when the user turned `voiceDataRecording` off (the store
   * wrote nothing, so there is no id) or when the recogniser's answer carried none; a label whose
   * ordinal has no record has nowhere to go and is dropped rather than written somewhere else.
   */
  recordIds: Map<number, string>;
};

type UseVoiceInputOptions = {
  /**
   * Draft scope of the composer this hook renders in (the open session, or the project
   * before a chat has a session). A change means a different chat, and the clip belongs
   * to the conversation it was recorded in, so it is dropped rather than carried over.
   */
  scope?: string | null;
  /**
   * Whether the composer is on screen. `false` covers the other workspace tabs and the
   * AskUserQuestion panel replacing the footer; both hide the replay pill, so a playing
   * clip would have no visible control to stop it.
   */
  isActive?: boolean;
  /**
   * Names the open project really has, for the deterministic repair of the transcript
   * (see `src/shared/projectIdentifiers.ts`). Passed in rather than resolved here.
   */
  candidates?: readonly string[];
  /**
   * Where the audio comes from. Absent means the shipping `AudioWorklet` engine; a test
   * supplies one so it can push PCM without a browser audio thread or a microphone.
   */
  captureEngine?: VoiceCaptureEngine;
  /**
   * The conversation the relay-mode context pack is built from.
   *
   * THE SAME ROWS LIVE VOICE USES, passed by the pane that renders them. The pack is built at
   * upload time rather than at listen start, so a turn that landed while the user was speaking is
   * part of what the recogniser sees. It is read through a ref because the transcription callbacks
   * outlive a render, exactly like the other options above. Absent means no pack: a caller that
   * does not own a transcript (or a test) sends no context, and the relay provider falls back to
   * the no-context arm.
   */
  contextMessages?: readonly ChatMessage[];
};

/**
 * The composer's draft at the moment a listen began, and where the caret was in it.
 *
 * HANDED IN BY THE PRESS, NOT READ FROM AN OPTION, because both halves are only exact at that
 * instant: the box's text is a prop of an already-completed render, and the caret is read off the
 * textarea when the mic is pressed. A value captured at session creation would be right; a value
 * re-read at upload time would be wrong by design — the draft is expected to change as the user
 * keeps editing while they talk, and this listen's context is the box it started from.
 */
export type VoiceDraftSnapshot = {
  /** The whole draft as the box held it when the mic was pressed. */
  text: string;
  /** The caret inside that draft: everything before it is 「光标前」, everything at/after 「光标后」. */
  cursor: number;
};

/** Stable identity for the absent-candidate case, so the default does not re-create the callback each render. */
const NO_CANDIDATES: readonly string[] = [];

/** The slot's two replays, in the order the composer renders them. */
const CLIP_TRACKS: readonly VoiceClipTrack[] = ['original', 'trimmed'];

/** Both tracks silent. Written once, so "nothing is playing" has a single value to compare against. */
const NOTHING_PLAYING: VoiceClipPlayState = { original: 'idle', trimmed: 'idle' };

/**
 * The state that starts `track`: that one loads, and the other is stopped by the same write.
 */
const startingPlay = (track: VoiceClipTrack): VoiceClipPlayState => ({
  original: track === 'original' ? 'loading' : 'idle',
  trimmed: track === 'trimmed' ? 'loading' : 'idle',
});

/**
 * Continuous capture dictation. Records the microphone as 20 ms PCM frames, cuts the stream at
 * pauses into upload-sized segments, transcribes each through `/api/voice/transcribe`, and commits
 * the answers in spoken order through `onTranscript`.
 *
 * It also keeps the last listen as a single slot (`clipSlot`) so the composer can replay what was
 * said — the filtered audio the segments were cut from, and, when the stream stayed under the cap,
 * the raw PCM beside it.
 *
 * `onError` carries two kinds of failure (see `VoiceFailureReport`): a recogniser refusal as the
 * `{ code, status, upstreamCode }` the answer carried, and the chain's own local failures as the
 * sentence they have always been. A segment that lost its retries is reported with the span it
 * occupied, so the notice can name which part of the dictation is missing.
 */
export function useVoiceInput(
  onTranscript: (text: string, send?: boolean) => void,
  onError?: (failure: VoiceFailureReport) => void,
  options: UseVoiceInputOptions = {},
) {
  const { scope = null, isActive = true, candidates = NO_CANDIDATES, captureEngine, contextMessages } = options;
  const [state, setState] = useState<VoiceInputState>('idle');
  // How many segments are uploaded but not yet settled. A counter rather than the session's own
  // `pending` (a ref) because the composer's in-flight indicator is painted from it, and a ref
  // write would not re-render. It is read together with `state`: the indicator only shows while
  // *recording*, so the transcribing tail (stop pressed, answers still landing) shows nothing.
  const [pendingRequests, setPendingRequests] = useState(0);
  // The last listen, and the replay pair derived from it. State rather than a ref because the
  // controls render only while a clip exists, and a ref would not re-render on the write.
  const [clipSlot, setClipSlot] = useState<VoiceClipSlot | null>(null);
  // Which of the slot's two tracks is sounding.
  const [clipPlayState, setClipPlayState] = useState<VoiceClipPlayState>(NOTHING_PLAYING);

  const sessionRef = useRef<CaptureSession | null>(null);
  // The listen whose text is in the composer, kept AFTER the session is closed because the send it
  // is waiting for arrives later: the user stops the mic, edits the box, and presses send, and the
  // correction is derived from the two texts at that moment. It holds the session's OWN `parts` and
  // `recordIds` by reference, so a segment that settled between the commit and the send is included
  // without this ref having to be refreshed. See `writeSentLabels`.
  const lastListenRef = useRef<{
    segments: VoiceSourceSegment[];
    recordIds: Map<number, string>;
  } | null>(null);
  const cancelledRef = useRef(false);
  const startingRef = useRef(false);
  // Mirrors the clip slot for callbacks that must not be re-created on every clip change,
  // and owns the object URLs that still have to be revoked.
  const clipSlotRef = useRef<VoiceClipSlot | null>(null);
  // The clip's own elements, one per track.
  const clipAudioRef = useRef<Record<VoiceClipTrack, HTMLAudioElement | null>>({
    original: null,
    trimmed: null,
  });
  // Which track's `play()` has not settled yet.
  const clipStartingRef = useRef<VoiceClipTrack | null>(null);
  // The latest callbacks and options, read by the audio/transcription callbacks that outlive a render.
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  const candidatesRef = useRef(candidates);
  const captureEngineRef = useRef(captureEngine);
  // The transcript the relay mode's pack is built from. A ref for the same reason the callbacks
  // above are refs: a segment's upload may settle after several renders, and the pack must be the
  // conversation as it stood when the upload was sent, not the one this callback closed over.
  const contextMessagesRef = useRef<readonly ChatMessage[]>(contextMessages ?? []);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
    candidatesRef.current = candidates;
    captureEngineRef.current = captureEngine;
    contextMessagesRef.current = contextMessages ?? [];
  }, [onTranscript, onError, candidates, captureEngine, contextMessages]);

  const ensureClipAudio = (track: VoiceClipTrack) => {
    const existing = clipAudioRef.current[track];
    if (existing) return existing;
    const audio = new Audio();
    audio.addEventListener('ended', () => {
      setClipPlayState((previous) => ({ ...previous, [track]: 'idle' }));
    });
    clipAudioRef.current[track] = audio;
    return audio;
  };

  // Stop the sound and leave the slot alone: the controls stay for a retry.
  const pauseClip = () => {
    for (const track of CLIP_TRACKS) clipAudioRef.current[track]?.pause();
    clipStartingRef.current = null;
    setClipPlayState(NOTHING_PLAYING);
  };

  /** Frees every object URL a slot holds — each track only when it is present. */
  const revokeSlot = (slot: VoiceClipSlot) => {
    if (slot.original) URL.revokeObjectURL(slot.original.url);
    if (slot.trimmed) URL.revokeObjectURL(slot.trimmed.url);
  };

  const discardClip = () => {
    pauseClip();
    const previous = clipSlotRef.current;
    clipSlotRef.current = null;
    setClipSlot(null);
    if (previous) revokeSlot(previous);
  };

  // Single slot: adopting a new listen evicts the previous one, URLs and all.
  const adoptClip = (slot: VoiceClipSlot) => {
    const previous = clipSlotRef.current;
    clipSlotRef.current = slot;
    setClipSlot(slot);
    if (previous) revokeSlot(previous);
  };

  /** Stops the audio engine and the idle guard, keeping the session's buffered audio intact. */
  const teardownCapture = (session: CaptureSession) => {
    if (session.idleTimer !== null) {
      window.clearInterval(session.idleTimer);
      session.idleTimer = null;
    }
    session.engine.stop();
  };

  /**
   * Turns one settled outcome into committed text.
   *
   * The reassembly sorts by ordinal and dedupes the overlap at each seam, which is the same code
   * the pipeline's own batch reassembly uses — so a live commit of a two-segment sentence reads
   * exactly like the same sentence reassembled at the end. Only the contiguous prefix is drained:
   * an out-of-order answer stays in `settled` until the ordinal before it has landed.
   */
  const drainCommitted = (session: CaptureSession) => {
    let advanced = false;
    while (session.settled.has(session.nextCommit)) {
      const outcome = session.settled.get(session.nextCommit)!;
      session.settled.delete(session.nextCommit);
      session.nextCommit += 1;
      advanced = true;
      if (outcome.ok && outcome.text.trim()) {
        session.parts.push({ index: outcome.index, text: outcome.text, failed: false });
      }
    }
    if (!advanced) return;
    const full = session.parts.length > 0 ? reassembleText(session.parts) : '';
    if (full !== session.committed) {
      session.committed = full;
      // The first text to reach the composer, timed from the first cut. It is read here, where the
      // text is committed, rather than at the answer: an out-of-order later segment can land before
      // the first, and the reading is about when the box first changed, not when a socket answered.
      if (full && session.firstTextLatencyMs === null && session.firstCutAt !== null) {
        session.firstTextLatencyMs = Date.now() - session.firstCutAt;
      }
      // The listen this text belongs to, remembered for the send that will later derive the
      // correction from it. Set HERE, where text actually reaches the composer, rather than when the
      // session was created: a listen the user cancelled before it said anything must leave no
      // listen behind for a later send to be compared against.
      lastListenRef.current = { segments: session.parts, recordIds: session.recordIds };
      if (!cancelledRef.current) onTranscriptRef.current(full, false);
    }
  };

  /**
   * Closes out a listen: builds the replay slot, returns to idle, and sends when the stop asked it to.
   *
   * Called once, when the stop has been requested and every submitted segment has settled. The send
   * is delivered as one call carrying the whole committed text, so the composer submits the complete
   * dictation exactly once rather than once per segment.
   */
  const finalizeSession = (session: CaptureSession) => {
    if (sessionRef.current !== session) return;
    sessionRef.current = null;
    // THE RAW CORPUS, sent AFTER this listen's text is already the caller's: every segment has
    // settled by the time this runs, so the words have been committed and nothing below can delay
    // them. Fire-and-forget on purpose — the corpus is passive, so it must neither delay nor fail the
    // dictation. Skipped when the deployment does not collect raw audio, and when the original stream
    // passed its retention cap: there is no original left to send then, and a truncated one would
    // misrepresent the pause it dropped, so the client keeps none by design.
    if (isVoiceRawCaptureEnabled() && !session.originalCapped && session.originalSamples > 0) {
      const blob = wavFromPcm16(concatInt16(session.originalChunks), STORE_SAMPLE_RATE);
      void captureRawVoice(session.listenId, blob, `${session.listenId}.wav`).catch(() => {
        // A corpus upload that failed is not a dictation failure: the text arrived, and the only
        // consequence is one missing raw file. Nothing here is shown to a user who never asked for it.
      });
    }
    if (session.source === 'mic') {
      const slot = buildClipSlot(session);
      if (slot) adoptClip(slot);
    }
    // The one reading this input produces. Only under the debug switch: nothing here is shown to a
    // user who did not ask, and a reading on every dictation would be a reading nobody reads.
    if (isVoiceDebugEnabled()) {
      const reading = buildVoiceLiveReading({
        recordedSec: session.inputRate > 0 ? session.inputSamples / session.inputRate : 0,
        segments: session.readings,
        firstTextLatencyMs: session.firstTextLatencyMs,
        usage: session.usage,
      });
      console.debug('[voice:live]', reading);
      (window as unknown as { __voiceLive?: unknown }).__voiceLive = reading;
    }
    if (!cancelledRef.current) {
      setState('idle');
      if (session.sendRequested) onTranscriptRef.current(session.committed, true);
    }
  };

  /** Reports a segment that lost its retries, with the span it covered. */
  const reportLostSegment = (outcome: SegmentOutcome, refusal: VoiceTranscriptionFailure | undefined) => {
    if (refusal && (refusal.code !== undefined || refusal.status !== undefined)) {
      onErrorRef.current?.({ ...refusal, startSec: outcome.startSec, endSec: outcome.endSec });
      return;
    }
    const span = `${outcome.startSec.toFixed(2)}-${outcome.endSec.toFixed(2)}s`;
    onErrorRef.current?.(`Voice segment ${outcome.index + 1} (${span}) failed`);
  };

  /**
   * Tells the user that one segment left the device, and why.
   *
   * THE REASON IS THE ENGINE'S OWN SENTENCE, NOT A CODE. The composer's notice renders a string
   * report verbatim (`VoiceFailureNotice`), which is the only one of the two shapes that can carry the
   * actionable half — "still downloading 12 MB of 239 MB" tells a user to wait, while
   * `ENGINE_UNAVAILABLE` tells them nothing they can act on. It is reported through the same channel a
   * failure uses because the requirement is that it be visible where failures are visible, not
   * because it is one: the segment may well come back with text a moment later.
   */
  const reportClientAsrFallback = (job: SegmentJob, giveUp: ClientAsrGiveUp) => {
    const span = `${job.startSec.toFixed(2)}-${job.endSec.toFixed(2)}s`;
    onErrorRef.current?.(
      `On-device recognition gave up on segment ${job.index + 1} (${span}) — ${giveUp.message}`,
    );
  };

  /**
   * One segment, recognised by the SERVER: upload, parse, repair.
   *
   * `fallback` IS WHERE THE CLIP CAME FROM, and the upload's ADDRESS is built from it rather than a
   * recogniser id being picked here: the segment that leaves the device is addressed
   * `{ kind: 'client-fallback' }`, and `transcribeVoice` resolves which recogniser that means from
   * the deployment's published rows. THE ONE PROPERTY THAT BUYS is that "no recogniser to fall back
   * to" is decided in the module that holds those rows, which answers with a refusal and makes NO
   * request — the audio stays on the device rather than being uploaded to whatever provider the
   * server would otherwise default to.
   *
   * Throwing is how the pipeline is told to retry, and `refusals` is where the structured reason is
   * left so a segment that runs out of retries can still report the code the recogniser sent.
   */
  const transcribeViaServer = (
    session: CaptureSession,
    job: SegmentJob,
    fallback?: ClientAsrGiveUp,
  ): Promise<string> =>
    (async () => {
      const address: VoiceUploadAddress = fallback === undefined
        ? { kind: 'stored' }
        : { kind: 'client-fallback', giveUpMessage: fallback.message };

      // Built per upload from the SNAPSHOT, not from the box as it stands now: the draft the user
      // started the dictation in is the one this listen is being committed into, and the text this
      // listen has already committed is what it must not repeat. The conversation rows are read at
      // upload time, so a turn that landed while the user was speaking is included. An empty pack
      // is `undefined` rather than an empty string, so a provider with context support sees the
      // no-context request exactly as it would have without this parameter.
      // The deployment's effective pack size, published by `useVoiceAvailable`; `null` is the
      // shipped default. The server trims `hints.context` again, so an edit that lands after this
      // reading is still enforced on the one-shot path.
      const packRuntime = readVoiceRuntimeConfig();
      const context = buildVoiceInputContextPack({
        messages: contextMessagesRef.current,
        draftBefore: session.draft === null ? '' : session.draft.text.slice(0, session.draft.cursor),
        draftAfter: session.draft === null ? '' : session.draft.text.slice(session.draft.cursor),
        voiceSoFar: session.committed,
        ...(packRuntime === null ? {} : packRuntime),
      }).text;
      const response = await transcribeVoice(
        job.blob,
        `${SEGMENT_BASE_NAME}-${job.index + 1}.wav`,
        session.listenId,
        address,
        context === '' ? undefined : context,
      );
      if (!response.ok) {
        const refusal = await refusalDetail(response);
        session.refusals.set(job.index, refusal);
        throw refusal;
      }
      // Both taken before the body is read for the transcript, because both live BESIDE the envelope
      // that parse consumes. The record id is only looked for when the deployment is keeping
      // records — a user who turned `voiceDataRecording` off has none to find, so neither the clone
      // nor the parse happens for them — and the usage probe only under the debug switch, so a
      // normal dictation on a default deployment pays no second read at all.
      const recordProbe = readVoiceConfig().voiceDataRecording === false ? null : readRecordId(response);
      const usageProbe = isVoiceDebugEnabled() ? readUsage(response) : null;
      const raw = await parseTranscriptionResponse(response, 'strict');
      if (usageProbe) session.usage = accumulateUsage(session.usage, await usageProbe);
      if (recordProbe) {
        const recordId = await recordProbe;
        // Absent is ordinary rather than an error: the store is optional, and a transcription the
        // deployment did not keep is a transcription that succeeded.
        if (recordId !== null) session.recordIds.set(job.index, recordId);
      }
      const text = raw.trim();
      if (!text) {
        // A well-formed answer with no words in it is the server's own `NO_SPEECH_DETECTED`, named
        // where the emptiness is FOUND. It is handed back as a refusal rather than as an empty success
        // so the composer shows the sentence the code selects — and, like a refusal, it is remembered:
        // a recogniser that answered "nothing to say" will answer the same way again.
        const failure: VoiceTranscriptionFailure = { status: response.status, code: 'NO_SPEECH_DETECTED' };
        session.refusals.set(job.index, failure);
        throw failure;
      }
      const repaired = repairIdentifiers(text, candidatesRef.current);
      if (isVoiceDebugEnabled()) {
        console.debug('[voice] identifier fidelity', {
          before: identifierFidelity(raw, text),
          after: identifierFidelity(raw, repaired),
        });
      }
      return repaired;
    })();

  /**
   * One segment, recognised by THIS DEVICE, or the reason the server should take it.
   *
   * THE ROUTING DECIDES, NOT THIS FUNCTION. `routeClientAsrSegment` is the policy — it recognises on
   * the device, measures the segment, and either returns the result or names why it left. A
   * give-up here is not a failure to report but a HAND-OFF: the caller addresses the upload to the
   * fallback recogniser and tells the user why. The decision is not duplicated here, because a second
   * copy of "when do we fall back" is a second answer that can drift.
   *
   * A REFUSAL FROM THE DEVICE IS KEPT. `NO_SPEECH_DETECTED` from the model, or a container the engine
   * cannot read, is remembered exactly as the server's own refusal is: it is a definitive answer about
   * this clip, and re-asking the server would spend a request (and a metered charge) on a question the
   * user already has an answer to — while also uploading audio the user asked to keep on the device.
   */
  const transcribeOnDevice = async (
    session: CaptureSession,
    job: SegmentJob,
  ): Promise<{ kind: 'device'; text: string } | { kind: 'fallback'; giveUp: ClientAsrGiveUp }> => {
    // Idempotent, and the first thing a client-path listen does: with no engine installed the adapter
    // answers `ENGINE_UNAVAILABLE` and the routing sends this segment to the server, which is the
    // fail-closed behaviour rather than a special case here.
    installVoiceClientAsrEngine();
    const config = readVoiceConfig();
    const durationSec = job.endSec - job.startSec;
    const route = await routeClientAsrSegment({
      request: {
        audio: {
          bytes: new Uint8Array(await job.blob.arrayBuffer()),
          mimeType: 'audio/wav',
          fileName: `${SEGMENT_BASE_NAME}-${job.index + 1}.wav`,
          durationSec,
        },
      },
      // A recogniser that runs in this tab reaches no address, so the invocation carries the
      // deployment's values for the fields the seam requires and nothing else. `timeoutMs` is the one
      // field the client path reads, and it is derived from the segment rather than from a provider's
      // published deadline.
      invocation: {
        baseUrl: config.baseUrl,
        apiKey: '',
        model: config.sttModel,
        timeoutMs: clientAsrSegmentTimeoutMs(durationSec),
        fetchImpl: (...args) => fetch(...args),
      },
      durationSec,
      segmentIndex: job.index,
    });

    if (route.to === 'server') return { kind: 'fallback', giveUp: { reason: route.reason, message: route.message } };
    if (!route.result.ok) {
      const failure: VoiceTranscriptionFailure = {
        code: route.result.code,
        ...(route.result.status === undefined ? {} : { status: route.result.status }),
      };
      session.refusals.set(job.index, failure);
      throw failure;
    }

    const repaired = repairIdentifiers(route.result.text, candidatesRef.current);
    if (isVoiceDebugEnabled()) {
      // The same reading the server path logs, tagged with the path that produced it: a reading taken
      // on the device and a reading taken on the server are not interchangeable, and a log that could
      // not tell them apart would make the two look like a regression of one another.
      console.debug('[voice] identifier fidelity', {
        path: 'client',
        after: identifierFidelity(route.result.text, repaired),
      });
    }
    return { kind: 'device', text: repaired };
  };

  /**
   * One segment's journey: the device when it is selected and can answer, the server otherwise.
   *
   * The remembered refusal is checked HERE rather than inside either path, because it is about the
   * SEGMENT rather than about the recogniser that refused it: whichever path answered first has
   * answered, and the pipeline's retries are for transient failures.
   *
   * A GIVE-UP IS ANNOUNCED, THEN HONOURED. The user is told the clip left the device and why BEFORE
   * the upload starts, because a fallback is a disclosure they did not ask for and the difference
   * between "the device was slow" and "your audio went to a server" is theirs to know — including
   * when the upload then fails, which is exactly when the reason is the only thing left to show.
   */
  const transcribeSegment = (session: CaptureSession, job: SegmentJob): Promise<string> =>
    (async () => {
      // A refusal the recogniser already gave is definitive, and the pipeline's retries are for
      // transient failures. Re-asking a provider that has answered would spend a second request (and
      // for a metered provider, a second charge) on a question whose answer is not going to change, so
      // the remembered refusal is re-thrown without a call: the segment still exhausts its retries and
      // is still reported once, but only one upload is ever made.
      const remembered = session.refusals.get(job.index);
      if (remembered) throw remembered;
      if (isVoiceClientAsrSelected()) {
        const onDevice = await transcribeOnDevice(session, job);
        if (onDevice.kind === 'device') return onDevice.text;
        reportClientAsrFallback(job, onDevice.giveUp);
        return transcribeViaServer(session, job, onDevice.giveUp);
      }
      return transcribeViaServer(session, job);
    })();

  /** Settles one outcome: record it, commit what is now contiguous, and close out if the stop waits. */
  const settleSegment = (session: CaptureSession, outcome: SegmentOutcome) => {
    session.pending -= 1;
    setPendingRequests((n) => Math.max(0, n - 1));
    session.settled.set(outcome.index, outcome);
    // The one place the request count and latency are known. A failed segment still cost its
    // attempts, so the floor is 1 rather than 0 — "it was sent once and came back unusable" is not
    // the same reading as "it was never sent".
    const reading = session.readings[outcome.index];
    if (reading) {
      reading.requests = Math.max(1, outcome.attempts);
      reading.latencyMs = outcome.latencyMs;
    }
    drainCommitted(session);
    if (!outcome.ok) reportLostSegment(outcome, session.refusals.get(outcome.index));
    if (session.stopRequested) {
      if (session.pending === 0) finalizeSession(session);
      else setState('transcribing');
    }
  };

  /** Submits one closed segment and lets it settle in the background. */
  const enqueueSegment = (session: CaptureSession, segment: LiveSegment) => {
    const index = session.nextIndex;
    session.nextIndex += 1;
    // The edge-trimmed bytes are what is uploaded AND what the replay track holds: the silence this
    // removes was never going to reach the recogniser, so keeping it in the replay would show audio
    // this listen did not actually send.
    const wav = trimSegmentEdges(segment.wav);
    // The filtered replay track is every segment's own audio, in order.
    const pcm = wavPcm16(wav);
    session.filteredChunks.push(pcm);
    session.filteredSamples += pcm.length / 2;
    const sentAt = Date.now();
    session.lastActivityAt = sentAt;
    // The reading is recorded here, when the segment is cut and sent, because two of its fields are
    // only knowable now: how long the speech waited in the buffer (a wall clock against the capture's
    // own start, real-time on the mic and zero for a file, whose spans are not wall time) and that
    // this was the first cut. The request count and latency are filled in when it settles.
    session.readings[index] = {
      sentSec: segmentWavSec(wav),
      requests: 1,
      latencyMs: 0,
      waitSec:
        session.source === 'mic'
          ? Math.max(0, (sentAt - session.captureStartedAt) / 1000 - segment.startSec)
          : 0,
      forced: segment.forced,
    };
    if (session.firstCutAt === null) session.firstCutAt = sentAt;
    const job: SegmentJob = {
      index,
      startSec: segment.startSec,
      endSec: segment.endSec,
      // Copied into a fresh buffer: a `Blob` part must be backed by a plain `ArrayBuffer`, and the
      // segmenter's `Uint8Array` is not typed to promise that.
      blob: new Blob([new Uint8Array(wav)], { type: 'audio/wav' }),
    };
    session.pending += 1;
    setPendingRequests((n) => n + 1);
    void runSegmentPipeline([job], (submitted) => transcribeSegment(session, submitted), {
      maxRetries: SEGMENT_MAX_RETRIES,
    }).then(({ segments }) => {
      if (cancelledRef.current) return;
      settleSegment(session, segments[0]);
    }).catch(() => {
      if (cancelledRef.current) return;
      settleSegment(session, {
        index,
        startSec: segment.startSec,
        endSec: segment.endSec,
        durationSec: segment.endSec - segment.startSec,
        bytes: job.blob.size,
        latencyMs: 0,
        attempts: 0,
        ok: false,
      });
    });
  };

  /** Buffers the raw stream, downsampled to the replay track's rate, until the cap is passed. */
  const appendOriginal = (session: CaptureSession, samples: Float32Array, rate: number) => {
    if (session.originalCapped) return;
    const capSamples = (voiceDebugOriginalCapSec() ?? ORIGINAL_CAP_SEC) * STORE_SAMPLE_RATE;
    const down = downsampleVoice(samples, rate, STORE_SAMPLE_RATE);
    const next = session.originalSamples + down.samples.length;
    if (next > capSamples) {
      // Over the cap: the original is dropped whole rather than truncated, so the slot keeps only
      // the filtered track.
      session.originalCapped = true;
      session.originalChunks = [];
      session.originalSamples = 0;
      return;
    }
    const chunk = new Int16Array(down.samples.length);
    for (let i = 0; i < down.samples.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, down.samples[i]));
      chunk[i] = Math.round(clamped * 32_767);
    }
    session.originalChunks.push(chunk);
    session.originalSamples = next;
  };

  /** Ends the capture: flush the trailing segment, tear the engine down, and finalize. */
  const stopCapture = (session: CaptureSession, send: boolean) => {
    if (session.stopRequested) return;
    session.stopRequested = true;
    session.sendRequested = send;
    const trailing = session.segmenter?.flush() ?? [];
    for (const segment of trailing) enqueueSegment(session, segment);
    // The no-VAD case: no segmenter ran, so the whole buffered input is the one segment. It is sent
    // on the stop rather than as it arrives because "the whole recording" only exists once it ends.
    if (session.wholeBuffer && session.wholeChunks.length > 0) {
      enqueueSegment(session, wholeBufferSegment(concatFloat(session.wholeChunks), session.inputRate));
    }
    teardownCapture(session);
    if (session.pending === 0) {
      finalizeSession(session);
    } else {
      setState('transcribing');
    }
  };

  const start = useCallback(async (draft?: VoiceDraftSnapshot) => {
    if (startingRef.current || sessionRef.current) return;
    // A new listen starts with nothing in flight: the previous session's counter has no meaning
    // for this one, and the indicator must not open lit.
    setPendingRequests(0);
    // A new listen is about to replace the slot; stop the old one from sounding.
    pauseClip();
    startingRef.current = true;
    // Warm the deployment's raw-capture switch while the microphone is being opened. Fired, not
    // awaited: the switch only decides whether the END-of-listen corpus upload happens, and waiting
    // for it here would delay the microphone for a capability probe. The read is once per session
    // token, so a later listen finds it already answered (see `hydrateVoiceRawCapture`).
    void hydrateVoiceRawCapture();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (cancelledRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const engine = captureEngineRef.current ?? workletCaptureEngine();
      let sampleRate = STORE_SAMPLE_RATE;
      // Read once, when the listen starts: the A/B arm a page began is the arm this capture keeps.
      const vadEnabled = isVoiceVadEnabled();
      const session: CaptureSession = {
        source: 'mic',
        listenId: mintListenId(),
        engine,
        segmenter: null,
        nextCommit: 0,
        settled: new Map(),
        parts: [],
        committed: '',
        draft: draftSnapshotOrNull(draft),
        pending: 0,
        nextIndex: 0,
        lastActivityAt: Date.now(),
        idleTimer: null,
        stopRequested: false,
        sendRequested: false,
        refusals: new Map(),
        originalChunks: [],
        originalSamples: 0,
        originalCapped: false,
        filteredChunks: [],
        filteredSamples: 0,
        wholeBuffer: !vadEnabled,
        wholeChunks: [],
        inputSamples: 0,
        inputRate: STORE_SAMPLE_RATE,
        captureStartedAt: Date.now(),
        readings: [],
        firstCutAt: null,
        firstTextLatencyMs: null,
        usage: null,
        recordIds: new Map(),
      };
      sessionRef.current = session;
      // Resolve the capture engine, then build the segmenter against the rate it reports. The sink
      // guards on the segmenter being present: the engine may not be handed a frame until its
      // `start` has resolved, which is what makes the assignment below run first.
      sampleRate = await engine.start(stream, {
        onFrame: (samples, atSample, events) => {
          appendOriginal(session, samples, sampleRate);
          session.inputSamples += samples.length;
          session.inputRate = sampleRate;
          if (session.wholeBuffer) {
            // No VAD: nothing is cut as it arrives, so the audio is buffered whole and sent as one
            // segment at the stop. The copy is deliberate — the engine reuses its frame buffer.
            session.wholeChunks.push(samples.slice());
            return;
          }
          const closed = session.segmenter?.push(samples, atSample, events) ?? [];
          for (const segment of closed) enqueueSegment(session, segment);
        },
        onActivity: () => {
          session.lastActivityAt = Date.now();
        },
      });
      if (cancelledRef.current) {
        engine.stop();
        stream.getTracks().forEach((t) => t.stop());
        sessionRef.current = null;
        return;
      }
      session.inputRate = sampleRate;
      session.segmenter = vadEnabled
        ? new LiveSegmenter({
            sampleRate,
            minSegmentSec: voiceDebugMinSegmentSec() ?? DEFAULT_MIN_SEGMENT_SEC,
            // The latency release valve: a short utterance goes out on its own after this much
            // silence rather than waiting for the stop. See `DEFAULT_FLUSH_SILENCE_SEC`.
            flushSilenceSec: voiceDebugFlushSilenceSec() ?? DEFAULT_FLUSH_SILENCE_SEC,
            // 裁不裁, decided by the recogniser's own declaration — see `gapFilterSecForCapture`.
            keepGapSec: gapFilterSecForCapture(),
          })
        : null;
      // The idle guard: no speech event and no committed segment for `voiceIdleSec`, and the mic is
      // closed. A stop with nothing buffered sends no request and reports no error.
      session.idleTimer = window.setInterval(() => {
        const idleMs = (voiceDebugIdleSec() ?? DEFAULT_IDLE_AUTOSTOP_SEC) * 1000;
        if (Date.now() - session.lastActivityAt >= idleMs) stopCapture(session, false);
      }, IDLE_POLL_MS);
      setState('recording');
    } catch (e) {
      sessionRef.current = null;
      if (cancelledRef.current) return;
      const err = e as { name?: string; message?: string };
      let msg = `Mic error: ${err?.message || e}`;
      if (err?.name === 'NotAllowedError') msg = 'Microphone access denied.';
      else if (err?.name === 'NotFoundError') msg = 'No microphone found.';
      onErrorRef.current?.(msg);
      setState('idle');
    } finally {
      startingRef.current = false;
    }
  }, []);

  // Stop listening. `{ send: true }` sends the composer once every segment has settled.
  const stop = useCallback((opts?: { send?: boolean }) => {
    const session = sessionRef.current;
    if (session) stopCapture(session, opts?.send ?? false);
  }, []);

  /**
   * Starts or stops the mic. The draft rides the STARTING call only: it is the box the listen will
   * be committed into, and a press that stops needs no new one.
   */
  const toggle = useCallback((draft?: VoiceDraftSnapshot) => {
    if (state === 'recording') stop();
    else if (state === 'idle') void start(draft);
  }, [state, start, stop]);

  /**
   * Feeds a chosen audio file through the chain a recording travels.
   *
   * The other entry into the same pipeline: the file is decoded to PCM, run through the shared VAD
   * to produce its boundaries, and segmented with the same segmenter a live stream uses. There is no
   * second batch path — this is the same cutter, given the whole buffer at once.
   *
   * With `voiceVad=off` the VAD is skipped entirely and the whole buffer is the one segment: the
   * "before" arm of the A/B, over the very same bytes the "after" arm ran on.
   */
  const transcribeFile = useCallback((file: File) => {
    void (async () => {
      if (sessionRef.current) return;
      pauseClip();
      const decoded = await decodeVoiceBlob(file);
      if (cancelledRef.current) return;
      if (!decoded || decoded.samples.length === 0) {
        onErrorRef.current?.('Audio file too small');
        return;
      }
      const vadEnabled = isVoiceVadEnabled();
      const segments = vadEnabled
        ? segmentLive(
            decoded.samples,
            decoded.sampleRate,
            new StreamingVad({ sampleRate: decoded.sampleRate }).push(decoded.samples),
            {
              minSegmentSec: voiceDebugMinSegmentSec() ?? DEFAULT_MIN_SEGMENT_SEC,
              // The same flush a live stream uses: a file is a finite stream whose "stop" is its
              // whole length, so a sparse file is cut at each sentence even though nothing stops.
              flushSilenceSec: voiceDebugFlushSilenceSec() ?? DEFAULT_FLUSH_SILENCE_SEC,
              // The file entry travels the same chain, so 裁不裁 is read the same way it is for a
              // live stream — one read point, one recogniser, not a second answer for this path.
              keepGapSec: gapFilterSecForCapture(),
            },
          )
        : [wholeBufferSegment(decoded.samples, decoded.sampleRate)];
      if (segments.length === 0) {
        onErrorRef.current?.('Audio file too small');
        return;
      }
      const session: CaptureSession = {
        source: 'file',
        listenId: mintListenId(),
        engine: { start: async () => decoded.sampleRate, stop: () => undefined },
        segmenter: null,
        nextCommit: 0,
        settled: new Map(),
        parts: [],
        committed: '',
        // A file has no composer draft behind it: the box it is transcribed into is whatever the
        // caller's own insertion range holds, and this entry never reads one.
        draft: null,
        pending: 0,
        nextIndex: 0,
        lastActivityAt: Date.now(),
        idleTimer: null,
        stopRequested: true,
        sendRequested: false,
        refusals: new Map(),
        originalChunks: [],
        originalSamples: 0,
        originalCapped: false,
        filteredChunks: [],
        filteredSamples: 0,
        wholeBuffer: !vadEnabled,
        wholeChunks: [],
        inputSamples: decoded.samples.length,
        inputRate: decoded.sampleRate,
        captureStartedAt: Date.now(),
        readings: [],
        firstCutAt: null,
        firstTextLatencyMs: null,
        usage: null,
        recordIds: new Map(),
      };
      sessionRef.current = session;
      setState('transcribing');
      for (const segment of segments) enqueueSegment(session, segment);
    })();
  }, []);

  // A different scope is a different chat. The composer is never unmounted on a session
  // switch, so nothing else would keep one session's recording out of another's composer.
  useEffect(() => {
    discardClip();
  }, [scope]);

  // Off screen — another workspace tab, or the question panel covering the footer —
  // nothing visible can stop the audio, so stop it. The clip is kept.
  useEffect(() => {
    if (!isActive) pauseClip();
  }, [isActive]);

  // Read-aloud and a clip must not sound at once.
  useEffect(() => voicePlayer.subscribe(() => {
    if (voicePlayer.isBusy()) pauseClip();
  }), []);

  // Stop the microphone if the component unmounts mid-recording.
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      startingRef.current = false;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) teardownCapture(session);
      for (const track of CLIP_TRACKS) {
        clipAudioRef.current[track]?.pause();
        clipAudioRef.current[track] = null;
      }
      const slot = clipSlotRef.current;
      clipSlotRef.current = null;
      if (slot) revokeSlot(slot);
    };
  }, []);

  /**
   * Plays one of the slot's tracks, or stops it when it is the one already sounding.
   */
  const toggleClipPlayback = useCallback((track: VoiceClipTrack) => {
    const clip = clipSlotRef.current?.[track];
    if (!clip) return;
    const audio = ensureClipAudio(track);
    if (clipPlayState[track] !== 'idle') {
      audio.pause();
      clipStartingRef.current = null;
      setClipPlayState((previous) => ({ ...previous, [track]: 'idle' }));
      return;
    }
    for (const other of CLIP_TRACKS) {
      if (other !== track) clipAudioRef.current[other]?.pause();
    }
    voicePlayer.stop();
    audio.src = clip.url;
    clipStartingRef.current = track;
    setClipPlayState(startingPlay(track));
    const started: Promise<void> | undefined = audio.play();
    if (started && typeof started.then === 'function') {
      started.then(
        () => {
          if (clipStartingRef.current !== track) return;
          clipStartingRef.current = null;
          if (clipSlotRef.current?.[track] !== clip) return;
          setClipPlayState((previous) => ({ ...previous, [track]: 'playing' }));
        },
        (e: unknown) => {
          if (clipStartingRef.current !== track) return;
          clipStartingRef.current = null;
          if (clipSlotRef.current?.[track] !== clip) return;
          setClipPlayState((previous) => ({ ...previous, [track]: 'idle' }));
          onErrorRef.current?.(`Playback failed: ${e instanceof Error ? e.message : String(e)}`);
        },
      );
    } else {
      clipStartingRef.current = null;
      setClipPlayState((previous) => ({ ...previous, [track]: 'playing' }));
    }
  }, [clipPlayState]);

  // The in-flight indicator's one bit: a request was submitted for the listen that is *still
  // recording*. Deliberately false once the stop has been pressed — the transcribing tail is the
  // recorder draining, not a live request the user is being kept waiting on — and false at idle.
  const inFlight = state === 'recording' && pendingRequests > 0;

  /**
   * Writes the user's own correction back to the records this listen's segments were kept in.
   *
   * CALLED AT SEND, with the text the user actually sent, because that is the only moment the pair
   * exists: the recogniser's words are what the listen committed, and the sent text is what the user
   * left in the box, and the two are only both known once they have stopped editing. See
   * `labelsFor` for what is derived from the difference.
   *
   * IT NEVER COSTS THE SEND. The message the user asked to send has already gone by the time this
   * runs, and everything here is a best-effort side channel: a store that answered `404` (the record
   * was evicted by the ceiling, or cleared, since the listen), a failed request, and a deployment
   * that wired no such route all leave the same trace — the label was not kept — and none of them
   * may surface to a user who never asked for labels in the first place. The synchronous `try` is
   * for the seam itself rather than for the network: this runs inside the submit handler, and a
   * throw from the transport's own construction would otherwise take the send with it.
   *
   * IT IS GATED ON THE USER'S OWN SWITCH, read here rather than captured earlier so that turning
   * recording off in another tab takes effect on the next send: `voiceDataRecording === false` means
   * nothing was written for this listen, so there is nothing to write back to. That gate is also
   * what keeps the whole path — no labels computed, no request built — off for a user who declined.
   */
  const writeSentLabels = useCallback((finalText: string) => {
    const listen = lastListenRef.current;
    if (listen === null || listen.segments.length === 0) return;
    if (readVoiceConfig().voiceDataRecording === false) return;

    const labels = labelsFor(listen.segments, finalText);
    // One request per RECORD rather than per label: a segment's transcriptions were kept in that
    // segment's own record, so the pairs that came from it are the ones that belong beside its audio.
    const bySegment = new Map<number, typeof labels>();
    for (const label of labels) {
      const existing = bySegment.get(label.segmentIndex);
      if (existing) existing.push(label);
      else bySegment.set(label.segmentIndex, [label]);
    }

    for (const [segmentIndex, segmentLabels] of bySegment) {
      const recordId = listen.recordIds.get(segmentIndex);
      // A label with no record has nowhere to go. It is dropped rather than written against another
      // segment's record, which would put one segment's words beside another's audio.
      if (recordId === undefined) continue;
      try {
        void api.voice.writeLabels(recordId, { finalText, labels: segmentLabels }).catch(() => {
          // The label was not kept. Nothing is shown: the user asked to send a message, not to
          // contribute a label, and a correction that failed to file itself is not a failed send.
        });
      } catch {
        // The transport threw before returning a promise — the same outcome by a different route.
      }
    }
  }, []);

  return {
    state,
    inFlight,
    toggle,
    stop,
    transcribeFile,
    clipSlot,
    clipPlayState,
    toggleClipPlayback,
    writeSentLabels,
  };
}

/**
 * The replay slot a finished listen leaves: the filtered audio the segments carried, and — when the
 * stream stayed under the cap — the raw PCM beside it.
 *
 * Both tracks are 16 kHz mono PCM, because both are heard through the same control.
 */
function buildClipSlot(session: CaptureSession): VoiceClipSlot | null {
  const filtered = session.filteredSamples > 0
    ? clipFromPcm16(concatBytes(session.filteredChunks), STORE_SAMPLE_RATE)
    : null;
  const original = !session.originalCapped && session.originalSamples > 0
    ? clipFromPcm16(concatInt16(session.originalChunks), STORE_SAMPLE_RATE)
    : null;
  if (!filtered && !original) return null;
  return { original, trimmed: filtered };
}
