/**
 * `--offline`: replay a recorded response instead of calling the recogniser, and `--record`: write
 * that recording.
 *
 * THE ADAPTER'S PARSE, NOT A SECOND ONE
 *
 * A replayed entry yields the SHIPPING adapter's own `parseTranscriptionResponse` output. This
 * file does not read `text` off a body anywhere — if it did, a criterion built on it would be
 * measuring this file rather than the app, which is the failure mode the whole command line exists
 * to avoid. What this file owns is only the transport side: which recorded entry answers, and what
 * "no entry answers" means.
 *
 * TOLERANCE IS PART OF THE RECORDING, NOT A PROPERTY OF THE REPLAY
 *
 * The two shipping paths already disagree about a body that is not JSON — the direct path reports
 * a failure, the proxy hands the body back as the transcript. A recording therefore carries BOTH
 * readings of the same bytes (`expect.strict` and `expect.lenient`), and a replay names which one
 * it is reproducing. That is what lets one replay mechanism cover the divergence rather than
 * picking a side.
 *
 * NOTHING HERE FALLS BACK
 *
 * An entry that is not recorded is `offline-miss`: not the injected transport, not the network. The
 * injected transport is a parameter of `recordedResponse` on purpose, so that the control suite has
 * one line to move when it asks whether "the replay did not go online" can be false.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createTranscriptionRequest, parseTranscriptionResponse } from '../../shared/asr/contract/transcriptionWire.js';
import type {
  TranscriptionRequest,
  TranscriptionTarget,
  TranscriptionTolerance,
  TranscriptionUpload,
} from '../../shared/asr/contract/transcriptionWire.js';
import type { FetchLike } from './dryRun.js';

/**
 * The provider an entry is filed under.
 *
 * The wire protocol this CLI speaks is the OpenAI-compatible transcription endpoint and there is
 * exactly one of it today. Naming it here, rather than taking it from a flag, is what keeps a
 * recording from being replayed against a different provider's endpoint by pointing `--base-url`
 * somewhere else: a match is provider AND url AND body.
 */
export const PROVIDER_ID = 'openai-compatible';

/**
 * The code a strict replay reports for a body that is not JSON.
 *
 * It is a classification of the SHIPPING failure, not a second parse: `parseTranscriptionResponse`
 * with `strict` reports a non-JSON body by rejecting out of `response.json()`, and the runtime's
 * rejection for that case is a `SyntaxError` (measured on this runtime).
 */
export const OFFLINE_ERROR_NON_JSON = 'non-json-response';

/** What one tolerance of one recorded response is expected to yield. */
export type RecordingExpectation = { kind: 'text'; text: string } | { kind: 'error'; code: string };

/** The same recorded bytes, read under both shipping tolerances. */
export type RecordedTolerances = {
  strict: RecordingExpectation;
  lenient: RecordingExpectation;
};

/** One recorded exchange: the request that was made, and the answer that came back. */
export type RecordingEntry = {
  id: string;
  provider: string;
  baseUrl: string;
  url: string;
  requestSha256: string;
  status: number;
  contentType: string;
  body: string;
  expect: RecordedTolerances;
};

/** A recording, with the provenance that says where its bytes came from. */
export type Recording = {
  schema: string;
  provenance: {
    recordedAt: string;
    recordedFromCommit: string | null;
    source: string;
    recordedBy: string;
  };
  /**
   * The one clip every entry in this recording was taken on. A replay is matched on the body it
   * would send, so this is what ties "the recording answers" to "the bytes being sent are the bytes
   * it was recorded against" — and the criterion recomputes it rather than trusting it.
   */
  audio: { name: string; mimeType: string; bytes: number; sha256: string };
  entries: RecordingEntry[];
};

/** Canonical JSON: object keys sorted, so "the same request" is "the same bytes". */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The digest a recording entry is keyed by: the method, the URL, and the BODY as the adapter built
 * it — each field's name with either its text or the digest of its bytes.
 *
 * Not the serialized multipart, because the encoder generates a fresh boundary on every
 * serialization: a digest over the wire bytes would differ between the recording and every replay
 * of it, and a key that never matches is a key that cannot go red either. The normalization stops
 * at the boundary; field names, field order, the text fields and the audio bytes are all in it.
 */
export async function requestDigest(request: TranscriptionRequest): Promise<string> {
  const body = request.init.body as { entries?: () => Iterable<[string, Blob | string]> } | null | undefined;
  const parts: unknown[] = [];
  for (const [name, value] of body?.entries?.() ?? []) {
    parts.push(
      typeof value === 'string'
        ? { name, kind: 'text', value }
        : { name, kind: 'blob', type: value.type, sha256: sha256Hex(new Uint8Array(await value.arrayBuffer())) },
    );
  }
  return sha256Hex(Buffer.from(canonical({ method: request.init.method, url: request.url, parts }), 'utf8'));
}

/** The entry a replay of this request would be answered by, or undefined. */
export function findEntry(recording: Recording, url: string, digest: string): RecordingEntry | undefined {
  return recording.entries.find(
    (entry) => entry.provider === PROVIDER_ID && entry.url === url && entry.requestSha256 === digest,
  );
}

/**
 * The one place a replayed response is produced.
 *
 * It reads the recording, and only the recording. `--offline` does not fall back to the injected
 * transport and it does not fall back to the network — an entry that is not there is `offline-miss`
 * and the command fails. The injected transport is in scope here on purpose: "the replay did not go
 * online" is only a falsifiable claim if there is a line where it could be false, and the control
 * suite rewrites exactly that line and requires the criterion to go red on the transport's log.
 *
 * @param {RecordingEntry} entry
 * @param {FetchLike | null} injectedTransport
 * @returns {Promise<Response>}
 */
async function recordedResponse(entry: RecordingEntry, injectedTransport: FetchLike | null): Promise<Response> {
  void injectedTransport;
  return new Response(entry.body, {
    status: entry.status,
    headers: entry.contentType ? { 'content-type': entry.contentType } : {},
  });
}

/**
 * The transcript a replayed entry yields: the shipping adapter's parse output, passed through
 * unchanged.
 *
 * It is a named step so that "this command does not edit the transcript" is a line the control
 * suite can move. A trim or a case fold here — the shape a helpful cleanup takes — would be this
 * file rewriting the recogniser's answer, and the replay criterion has to be able to see that.
 */
export function transcriptFromReplay(text: string): string {
  return text;
}

/** What a replay needs: the recording, the request to answer, and which tolerance to read under. */
export type OfflineInput = {
  recording: Recording;
  target: TranscriptionTarget;
  upload: TranscriptionUpload;
  tolerance: TranscriptionTolerance;
  injectedTransport: FetchLike | null;
};

/**
 * `--offline`: answer the request this CLI would make from the recording, read the answer with the
 * shipping adapter under the named tolerance, and print the transcript.
 *
 * Exit 0 when the tolerance yields a transcript, 1 when it yields the shipping failure. A text
 * transcript is written verbatim with no added newline, so a caller comparing it against a
 * recording is comparing the transcript and not the print statement around it.
 */
export async function runOfflineReplay(input: OfflineInput): Promise<number> {
  const request = createTranscriptionRequest(input.target, input.upload);
  const digest = await requestDigest(request);
  const entry = findEntry(input.recording, request.url, digest);

  if (!entry) {
    process.stderr.write(`offline-miss: no recorded response for ${request.url} sha256=${digest}\n`);
    return 1;
  }

  const response = await recordedResponse(entry, input.injectedTransport);
  try {
    const text = await parseTranscriptionResponse(response, input.tolerance);
    process.stdout.write(transcriptFromReplay(text));
    return 0;
  } catch (error) {
    if (error instanceof SyntaxError) {
      process.stderr.write(`${OFFLINE_ERROR_NON_JSON}\n`);
      return 1;
    }
    throw error;
  }
}

/** Reads a recording, or throws with the token a caller can act on. */
export function loadRecording(path: string): Recording {
  if (!existsSync(path)) throw new Error(`recording-missing: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Recording;
  if (!parsed || !Array.isArray(parsed.entries)) throw new Error(`recording-missing: ${path} has no entries`);
  return parsed;
}

/** Reads the shipping parse of a recorded body under one tolerance. */
async function expectationFor(
  body: string,
  status: number,
  contentType: string,
  tolerance: TranscriptionTolerance,
): Promise<RecordingExpectation> {
  const response = new Response(body, {
    status,
    headers: contentType ? { 'content-type': contentType } : {},
  });
  try {
    return { kind: 'text', text: await parseTranscriptionResponse(response, tolerance) };
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: 'error', code: OFFLINE_ERROR_NON_JSON };
    throw error;
  }
}

/** A stable identifier for an entry, derived from the endpoint it was recorded at. */
function entryId(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}${parsed.pathname}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
}

function headCommit(): string | null {
  try {
    return String(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })).trim();
  } catch {
    return null;
  }
}

/** What `--record` needs. */
export type RecordInput = {
  recordingPath: string;
  source: string;
  target: TranscriptionTarget;
  upload: TranscriptionUpload;
  audio: { name: string; mimeType: string; bytes: number; sha256: string };
  transport: FetchLike | null;
};

/**
 * `--record`: send the request once through the injected transport and store what came back.
 *
 * Deliberately NOT a criterion. It is the only mode that reaches the network, so it is the mode
 * that needs a credential and a reachable endpoint — ADR-004 decision 8 keeps that out of the
 * criteria set, and the criterion that consumes a recording reads the fixture rather than calling
 * this. Both tolerances are recorded from the same bytes because the shipping paths disagree about
 * a body that is not JSON, and the disagreement is the thing a replay has to be able to reproduce.
 *
 * An entry with the same URL and body digest is replaced rather than duplicated, so re-recording
 * one endpoint does not leave the previous answer behind to shadow it.
 */
export async function runRecord(input: RecordInput): Promise<number> {
  const transport = input.transport ?? fetch;
  const request = createTranscriptionRequest(input.target, input.upload);
  const digest = await requestDigest(request);

  const response = await transport(request.url, request.init);
  const body = await response.text();
  const contentType = response.headers.get('content-type') ?? '';

  const entry: RecordingEntry = {
    id: entryId(request.url),
    provider: PROVIDER_ID,
    baseUrl: input.target.baseUrl,
    url: request.url,
    requestSha256: digest,
    status: response.status,
    contentType,
    body,
    expect: {
      strict: await expectationFor(body, response.status, contentType, 'strict'),
      lenient: await expectationFor(body, response.status, contentType, 'lenient'),
    },
  };

  const previous: Recording | null = existsSync(input.recordingPath)
    ? (JSON.parse(readFileSync(input.recordingPath, 'utf8')) as Recording)
    : null;

  const recording: Recording = {
    schema: 'asr-cli-recording/v1',
    provenance: {
      recordedAt: new Date().toISOString(),
      recordedFromCommit: headCommit(),
      source: input.source,
      recordedBy: 'experiments/voice-asr-cli/transcribe.ts --record',
    },
    audio: input.audio,
    entries: [...(previous?.entries ?? []).filter((existing) => existing.url !== entry.url), entry],
  };

  mkdirSync(dirname(input.recordingPath), { recursive: true });
  writeFileSync(input.recordingPath, `${JSON.stringify(recording, null, 2)}\n`);
  process.stdout.write(`recorded ${entry.id} status=${entry.status} url=${entry.url}\n`);
  process.stdout.write(`  strict=${entry.expect.strict.kind} lenient=${entry.expect.lenient.kind}\n`);
  return 0;
}
