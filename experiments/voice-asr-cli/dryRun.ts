/**
 * `--dry-run`: the request this CLI would put on the wire, printed with both of its secrets taken
 * out — and with nothing sent.
 *
 * WHAT MAKES THIS A READING RATHER THAN A PRINT-OUT
 *
 *   · the request is BUILT BY THE SHIPPING ADAPTER (`createTranscriptionRequest`), not by this
 *     file. A dry run that spelled its own multipart would be printing a description of a request
 *     the app would not send, which is the failure this whole CLI exists to avoid;
 *   · the injected transport is NEVER CALLED, and `neverSend` below is the one line that could.
 *     The control suite rewrites exactly that line and requires the criterion to go red on the
 *     transport's own call log — so "a dry run sends nothing" is falsifiable rather than asserted;
 *   · two things are redacted and they are two different kinds of thing, so they get two named
 *     functions: a CREDENTIAL (a secret that must not be echoed, decided by the NAME and never by
 *     the value) and the AUDIO BYTES (a payload that must not be echoed, and whose DIGEST must be
 *     — a redaction that printed nothing at all would be indistinguishable from an implementation
 *     that never opened the file).
 *
 * The body shape is read off whatever the adapter built rather than assumed to be multipart: if
 * the wire protocol changes its body, this report changes with it instead of going quietly stale.
 */

import { createHash } from 'node:crypto';

import { createTranscriptionRequest } from '../../shared/asr/contract/transcriptionWire.js';
import type {
  TranscriptionRequest,
  TranscriptionTarget,
  TranscriptionUpload,
} from '../../shared/asr/contract/transcriptionWire.js';

/**
 * fetch, at the width this CLI uses it: one URL and the init the adapter built.
 *
 * Declared once and imported from here by the replay module and the entry point, so that "the
 * transport this mode must not use" is the same type in all three files.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The placeholder a redacted credential is replaced with. */
export const REDACTED = '<redacted>';

/**
 * The SHAPE of a credential's name, not a list of the names this CLI happens to send.
 *
 * `Authorization` is covered by the last alternative and a `?token=` appended to a base URL is
 * covered by the second, so neither has to be remembered separately when a provider adds one. The
 * match is on the name only: redacting a value that merely LOOKS like a secret would be redacting
 * on a guess, and would leave a credential named `X-Api-Key` in the clear the moment its value
 * stopped looking like one.
 */
const CREDENTIAL_NAME = /key|token|secret|sig|auth/i;

/** Credential side, for a header or a query parameter: the name decides. */
export function redactCredential(name: string, value: string): string {
  return CREDENTIAL_NAME.test(name) ? REDACTED : value;
}

/** Credential side, for the URL: a query parameter whose name is a credential is replaced. */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL this runtime understands: there is nothing to walk, and inventing a redaction
    // would be printing something other than what was built.
    return url;
  }
  for (const name of [...parsed.searchParams.keys()]) {
    if (CREDENTIAL_NAME.test(name)) parsed.searchParams.set(name, REDACTED);
  }
  return parsed.toString();
}

/** @param {Uint8Array} bytes */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Payload side of the redaction: an audio field is printed as its LENGTH and its DIGEST, never as
 * bytes.
 *
 * Both halves carry weight. The digest is what makes "the bytes were actually read" readable — a
 * redaction that printed nothing would score the same as one that never read the file — and the
 * length is what a reader compares against the file on disk.
 */
export function describeAudioField(bytes: Uint8Array): string {
  return `bytes=${bytes.length} sha256=${sha256Hex(bytes)}`;
}

/** One field of the request body, already reduced to something safe to print. */
export type DryRunField = { name: string; detail: string };

/** What `--dry-run` prints: the request, minus its credentials and minus its audio bytes. */
export type DryRunReport = {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  fields: DryRunField[];
  /** The digest of the audio the request carries; empty when the body had no blob field. */
  audioSha256: string;
};

/** @param {unknown} body */
function bodyEntries(body: unknown): Array<[string, unknown]> {
  const candidate = body as { entries?: () => Iterable<[string, unknown]> } | null | undefined;
  if (typeof candidate?.entries !== 'function') return [];
  return [...candidate.entries()];
}

/**
 * Builds the report from the request the adapter produced.
 *
 * The audio digest is taken from the request's OWN blob rather than from the file on disk: the
 * reading is "this is what the request carries", and the file is only what fed it.
 *
 * @param {TranscriptionRequest} request
 * @returns {Promise<DryRunReport>}
 */
export async function buildDryRunReport(request: TranscriptionRequest): Promise<DryRunReport> {
  const headers = Object.entries((request.init.headers ?? {}) as Record<string, string>).map(
    ([name, value]) => /** @type {[string, string]} */ ([name, redactCredential(name, value)]),
  );

  const fields: DryRunField[] = [];
  let audioSha256 = '';

  for (const [name, value] of bodyEntries(request.init.body)) {
    if (typeof value === 'string') {
      fields.push({ name, detail: `text len=${value.length} value=${value}` });
      continue;
    }
    const bytes = new Uint8Array(await (value as Blob).arrayBuffer());
    const detail = describeAudioField(bytes);
    fields.push({ name, detail: `blob ${detail}` });
    audioSha256 = sha256Hex(bytes);
  }

  return {
    url: redactUrl(request.url),
    method: String(request.init.method ?? 'GET'),
    headers,
    fields,
    audioSha256,
  };
}

/** @param {DryRunReport} report */
export function renderDryRun(report: DryRunReport): string {
  const lines = [`url=${report.url}`, `method=${report.method}`];
  for (const [name, value] of report.headers) lines.push(`header=${name}: ${value}`);
  for (const field of report.fields) lines.push(`field=${field.name} ${field.detail}`);
  lines.push('redacted=credentials,audio-bytes');
  return `${lines.join('\n')}\n`;
}

/**
 * The dry run's transport boundary — the one line that could put this request on the wire.
 *
 * It takes the request AND the transport precisely so that the control suite has something to
 * move: replacing the body of this function with a real send must turn the criterion red
 * (`dry-run made N calls`). Without a line like this, "the dry run sends nothing" would be a claim
 * no evidence could contradict, which is how a dry-run flag ends up quietly issuing a request.
 *
 * @param {TranscriptionRequest} request
 * @param {FetchLike | null} transport
 * @returns {Promise<void>}
 */
async function neverSend(request: TranscriptionRequest, transport: FetchLike | null): Promise<void> {
  void request;
  void transport;
}

/**
 * `--dry-run`: build the request through the adapter, print it redacted, send nothing, exit 0.
 *
 * @param {TranscriptionTarget} target
 * @param {TranscriptionUpload} upload
 * @param {FetchLike | null} transport the transport `--fetch-impl` named, if any — carried in so
 *   that its non-use is a decision this function makes rather than a module that was never loaded
 * @returns {Promise<number>} the exit code
 */
export async function runDryRun(
  target: TranscriptionTarget,
  upload: TranscriptionUpload,
  transport: FetchLike | null,
): Promise<number> {
  const request = createTranscriptionRequest(target, upload);
  const report = await buildDryRunReport(request);
  await neverSend(request, transport);
  process.stdout.write(renderDryRun(report));
  return 0;
}
