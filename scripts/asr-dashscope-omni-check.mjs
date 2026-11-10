#!/usr/bin/env node
/**
 * AC-138 — the dashscope-omni adapter, checked by RUNNING it rather than by reading it.
 *
 * WHY THIS PROBE EXECUTES THE TREE INSTEAD OF SCANNING IT. The claim under test is "this adapter,
 * offline and against a stand-in upstream, says the right thing": which request it builds, what it
 * makes of each answer shape, how it maps a transport failure, and whether an unaffordable request
 * ever leaves. None of those is visible in a source file. So the probe loads the SHIPPING module —
 * found by the id it declares, not by a path this file asserts — and drives its `transcribe` with an
 * injected transport whose recorded request and call count are the readings.
 *
 * IT DOES NOT GO THROUGH THE REGISTRY, and that is the task's boundary rather than a shortcut: this
 * adapter is not registered (registering it and dispatching to it from `voice.service.ts` is a later
 * task), so the registry cannot hand it out. The board's three probes are fed the module's own
 * `adapter` export for the same reason.
 *
 * THE SIX READINGS THAT CARRY THE TASK, one mechanical measurement each:
 *
 *   · the request is this wire's shape — the endpoint, the two headers, the decode parameters, the
 *     system turn, and a user turn whose parts are one `input_audio` and one `text` (AC2);
 *   · the prompt on the wire is the shipping module's own three segments joined, with each segment
 *     present and each hash the recorded one (AC3) — the tooling holds no prompt text, only hashes;
 *   · the answer is read as the service's chat envelope and DEGRADES rather than failing: a rewrite
 *     when there is one, the transcription when the wrapper was missing, `NO_SPEECH_DETECTED` when
 *     the service heard nothing, and `UPSTREAM_UNAVAILABLE` when the body was not an answer at all —
 *     raw response is never handed back as the text (AC5–AC7);
 *   · a 401/403/429/timeout/transport failure each reach their own code, and the two 403s — a model
 *     this account has not enabled versus a plain refusal — carry two DIFFERENT messages (AC8);
 *   · an unaffordable request is refused with ZERO requests at the stand-in, and an affordable one
 *     is sent — the second half is what makes the guard a line rather than a wall (AC9);
 *   · the caller's hints are nowhere on the body while the audio and the task turn ARE, so a builder
 *     that put nothing on the wire could not pass by sending nothing (AC10).
 *
 * OFFLINE IS ENFORCED, NOT ASSERTED (AC12). Every drive injects its own transport, and the probe
 * also REPLACES `globalThis.fetch` with a poison for the duration: an adapter that reaches for the
 * ambient fetch instead of the injected one is caught by the poison, counted and reported, rather
 * than merely discouraged.
 *
 * AN EMPTY READING IS A FAILURE (AC1). A tree that does not hold the seam — an empty `--root` — is
 * reported as `EMPTY_READING` for every case that should have run, and the probe exits non-zero:
 * "nothing was measured" must never be indistinguishable from "everything held".
 *
 * WHAT THIS PROBE DELIBERATELY DOES NOT DO, stated here because its output is otherwise easy to
 * over-read: it is not a measurement of the live service (ADR-004 decision 8 keeps the real smoke
 * test manual, out of CI), the model it names is an alias the service may re-point, and the prompt
 * TEXT is not in this tooling — the hashes are, and `scripts/asr-omni-prompt-frozen-check.mjs` is
 * the reading that pins the text itself to the experiment snapshot.
 *
 * Usage:
 *   node scripts/asr-dashscope-omni-check.mjs [--root <dir>]
 *
 *   --root <dir>   the tree to check (default: this script's repository root). The falsification
 *                  controls point it at a throwaway tree assembled from the shipping files, which is
 *                  what makes each fake form an executable case rather than a paragraph.
 *
 * Exit codes: 0 = every reading above held; 1 = at least one reading disagreed, or a case produced
 * no reading at all. Every failing reading prints its own `FAIL <TOKEN> <id> value=… expected=…`
 * line, so a red run still shows what was measured.
 */

import { createHash } from 'node:crypto';
import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

// Lets this bare-`node` entrypoint import the tree's `.ts` modules. Registered before anything else,
// because the first thing the probe does is load the shipping module.
register();

/** The id the adapter declares. The module is FOUND by it rather than by a path written in here. */
const ADAPTER_ID = 'dashscope-omni';

/** The reserved TLD, so even a defect that bypassed the stand-in could not reach a real service. */
const PROBE_BASE_URL = 'https://asr.invalid';

/** A base URL that is a WORKSPACE address rather than a bare host: the path must be appended to it. */
const WORKSPACE_BASE_URL = 'https://asr.invalid/workspace';

/** The path this wire's endpoint adds to whatever base URL is configured. */
const CHAT_PATH = '/compatible-mode/v1/chat/completions';

/** A model name of the probe's own, so the body's model field is read as following the invocation. */
const PROBE_MODEL = 'probe-omni-model';

/** A credential with a shape nothing else in the tree has, so its presence is unambiguous. */
const PROBE_API_KEY = 'probe-omni-key-7c1e4d';

const PROBE_TIMEOUT_MS = 1500;

/** The small audio most drives carry. ASCII, so its bytes and its base64 are both recorded facts. */
const AUDIO_TEXT = 'ASR-OMNI-PROBE-AUDIO-5b2e';

/**
 * The two answer strings, and they are DIFFERENT on purpose: this wire's answer carries a transcript
 * and a rewrite, and an adapter that returned the transcription when a rewrite was available could
 * not be told apart from a correct one if the two strings were equal.
 */
const TRANSCRIPT_ANSWER = '逐字那一版';
const INSTRUCTION_ANSWER = '书面那一版';

/** The three hint sentinels. Each is recognisable in a rendered body, which is what makes the
 *  "zero occurrences" reading a measurement instead of a hope. */
const HINT_PROMPT = 'OMNI-HINT-PROMPT-3f9a';
const HINT_CONTEXT = 'OMNI-HINT-CONTEXT-8d21';
const HINT_LANGUAGE = 'OMNI-HINT-LANGUAGE-c4b7';

/**
 * The recorded sha256 of each frozen segment, keyed by the name the shipping module exports.
 *
 * WHY HASHES AND NOT TEXT. The prompt's text has one home — the shipping module — and the tooling
 * must not hold a second copy of it, or the two would drift and the drift would be invisible. A hash
 * is enough to notice that the text moved, and it is the one thing this probe CAN hold: the values
 * below are the ones `scripts/asr-omni-prompt-frozen-check.mjs` verified against
 * `experiments/voice-omni-written/fixtures/snapshot.json` on 2026-09-24, and a segment that changes
 * by one character — deliberately or not — moves its hash and is reported BY NAME.
 */
/** @type {Record<string, string>} */
const RECORDED_SEGMENT_SHA256 = {
  ROLE: 'c1a739006b92b4f214545fa12777f29e0b415c535cade2552a035f50a7fc12a1',
  RULES: 'c9b44891a096d171ef69c079a7c196d38e5666883923d775414175861958862c',
  EXAMPLES: '6d69e4c9fa6b07677c52e1d002c75fa3a1efed8d50e9fc57053e1dfdf91132d6',
  JSON_TASK: 'e8d0f54d826e111b5fc1d51ce33e940445dd2e4acbe0dfeb17395d7cfaa00c52',
};

/** The three segments the system turn is composed from, in the order the shipping module joins them. */
const SYSTEM_SEGMENTS = ['ROLE', 'RULES', 'EXAMPLES'];

/**
 * The container-to-`format` pairs this wire must derive from the recording's base media type.
 *
 * The two halves of each row are the READING: the left is a media type a browser may announce, the
 * right is the word this service spells that container with. The pairs where the two differ
 * (`x-wav`→`wav`, `mpeg`→`mp3`) are the whole reason the derivation is a table rather than a trim.
 */
/** @type {[string, string][]} */
const FORMAT_BY_MIME = [
  ['audio/webm;codecs=opus', 'webm'],
  ['audio/webm', 'webm'],
  ['audio/ogg', 'ogg'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
  ['audio/aac', 'aac'],
  ['audio/amr', 'amr'],
];

/** The default budget this wire declares, read off the module rather than compared against by name. */

// ── the ledger ───────────────────────────────────────────────────────────────────────────────

/**
 * A single rendered value, never longer than one line and never longer than a screen.
 *
 * Readings are printed whether or not a verdict failed — a red run still has to show what it
 * measured — and the values this probe records are derived (a length, a hash, a flag, a field), so
 * the cap below is a guard against a defect that fed a whole request body into a reading rather than
 * a normal case. It announces itself when it fires, so a truncated value is not mistaken for a short
 * one.
 */
/** @param {unknown} value @returns {string} */
function render(value) {
  const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  return text.length > 400 ? `${text.slice(0, 400)}…(${text.length} chars)` : text;
}

class Ledger {
  constructor() {
    /** @type {string[]} */
    this.lines = [];
    /** @type {{ token: string, detail: string }[]} */
    this.problems = [];
    /** @type {Set<string>} */
    this.ran = new Set();
  }

  /**
   * @param {string} id
   * @param {unknown} value
   */
  ok(id, value) {
    this.ran.add(id);
    this.lines.push(`ok ${id} value=${render(value)}`);
  }

  /**
   * A reading that disagreed. The value, the expectation and the reason are all on the line: a
   * reader must not have to guess which of a hundred readings moved from the token alone.
   *
   * @param {string} token
   * @param {string} id
   * @param {unknown} observed
   * @param {unknown} expected
   * @param {string} detail
   */
  disagree(token, id, observed, expected, detail) {
    this.ran.add(id);
    this.lines.push(`FAIL ${token} ${id} value=${render(observed)} expected=${render(expected)} — ${detail}`);
    this.problems.push({ token, detail: `${id}: ${detail}` });
  }

  /**
   * A reading with an expectation, recorded either way.
   *
   * @param {string} id
   * @param {unknown} observed
   * @param {unknown} expected
   * @param {string} token
   * @param {string} detail
   * @returns {boolean} whether they agreed
   */
  expect(id, observed, expected, token, detail) {
    const agreed = JSON.stringify(observed) === JSON.stringify(expected);
    if (agreed) this.ok(id, observed);
    else this.disagree(token, id, observed, expected, detail);
    return agreed;
  }

  /**
   * A failure that has no observed value: a case that could not be run at all, or an invariant about
   * the tree rather than about a request.
   *
   * @param {string} token
   * @param {string} id
   * @param {string} detail
   */
  absent(token, id, detail) {
    this.lines.push(`FAIL ${token} ${id} — ${detail}`);
    this.problems.push({ token, detail: `${id}: ${detail}` });
  }

  /**
   * The structural half of AC1: every case this probe claims to run must have produced a reading. A
   * case that was skipped — because the shipping module never loaded, or because the case above it
   * bailed out — is an empty reading, and an empty reading is not a pass.
   *
   * @param {string[]} ids
   */
  requireAll(ids) {
    for (const id of ids) {
      if (!this.ran.has(id)) {
        this.absent('EMPTY_READING', id, 'no reading was produced for this case — nothing about it was measured');
      }
    }
  }
}

// ── arguments ────────────────────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {{ root: string }}
 */
function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root needs a directory');
      root = path.resolve(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/asr-dashscope-omni-check.mjs [--root <dir>]\n');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { root };
}

// ── the offline guard ────────────────────────────────────────────────────────────────────────

/**
 * Replaces the ambient transport with a recorder that refuses to answer.
 *
 * An injected transport makes a real call unlikely; this makes it impossible. An adapter that uses
 * `fetch` instead of `invocation.fetchImpl` reaches this and is counted, which is the reading AC12
 * asks for — "every environment dependency is injected" is what keeps the probe offline, and this is
 * how that property is measured rather than trusted.
 *
 * @returns {{ calls: string[], restore: () => void }}
 */
function installFetchPoison() {
  const original = globalThis.fetch;
  /** @type {string[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const poison = async (input) => {
    calls.push(String(input));
    throw new Error('the ambient fetch was used; every environment dependency must be injected');
  };
  globalThis.fetch = poison;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/**
 * One header as the transport recorded it, or `null` when the request does not carry it.
 *
 * Matched case-insensitively because header names are: a reader that compared raw keys would report
 * `Authorization` as absent while the request plainly announced it.
 *
 * @param {RequestInit|undefined} init
 * @param {string} name
 * @returns {string|null}
 */
function headerValue(init, name) {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return null;
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (String(entry[0]).toLowerCase() === wanted) return String(entry[1]);
    }
    return null;
  }
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value === null || value === undefined ? null : String(value);
  }
  const record = /** @type {Record<string, string>} */ (headers);
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === wanted) return String(record[key]);
  }
  return null;
}

// ── the stand-in transport ───────────────────────────────────────────────────────────────────

/**
 * @typedef {{ calls: { url: string, init: RequestInit|undefined }[], fetchImpl: typeof fetch,
 *             count: () => number }} StandIn
 */

/**
 * The transport every drive in this probe runs on. Three modes, one per way a transport can answer:
 *
 *   · `answer` — a response with `body` at `status`. The ordinary case.
 *   · `abort`  — a promise that rejects with an `AbortError` when the signal the adapter passed
 *                aborts, which is how this probe reads a timeout from the abort itself rather than
 *                from a code the adapter chose. The safety timer below settles the promise if the
 *                signal never fires, so a defect that ignored the signal REDS the timeout reading
 *                instead of hanging the probe.
 *   · `reject` — a rejection that is not an abort: a transport that never answered.
 *
 * @param {{ body?: string, status?: number, mode?: 'answer'|'abort'|'reject' }} [options]
 * @returns {StandIn}
 */
function makeStandIn(options = {}) {
  const mode = options.mode ?? 'answer';
  const status = options.status ?? 200;
  const body = options.body ?? '';
  /** @type {{ url: string, init: RequestInit|undefined }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = (input, init) => {
    calls.push({ url: String(input), init: init ?? undefined });
    if (mode === 'reject') return Promise.reject(new TypeError('the transport could not be reached'));
    if (mode === 'answer') {
      return Promise.resolve(
        new Response(body, { status, headers: { 'Content-Type': 'application/json' } }),
      );
    }
    return new Promise((_resolve, reject) => {
      let settled = false;
      /** @param {Error} error */
      const settle = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        reject(error);
      };
      // The guard is a function of the deadline the adapter asked for, so a drive with a long
      // timeout is not cut short by this probe's own safety net. `timeout` is a property of the
      // signal `AbortSignal.timeout()` returns; it is read through a cast because the ambient type
      // does not declare it.
      const signalDeadlineMs = Number(/** @type {any} */ (init?.signal)?.timeout ?? 0);
      const guard = setTimeout(
        () => settle(new Error('the transport was never signalled to abort')),
        Math.max(2000, signalDeadlineMs + 1000),
      );
      const aborted = () => {
        const error = new Error('the request was aborted');
        error.name = 'AbortError';
        settle(error);
      };
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        settle(new Error('no signal reached the transport'));
        return;
      }
      if (signal.aborted) aborted();
      else signal.addEventListener('abort', aborted, { once: true });
    });
  };
  return { calls, fetchImpl, count: () => calls.length };
}

/**
 * The invocation a drive hands its adapter: every environment dependency injected, nothing read from
 * the process.
 *
 * @param {StandIn} standIn
 * @param {{ baseUrl?: string, apiKey?: string, model?: string, timeoutMs?: number, signal?: AbortSignal }} [overrides]
 * @returns {object}
 */
function invocationFor(standIn, overrides = {}) {
  return {
    baseUrl: overrides.baseUrl ?? PROBE_BASE_URL,
    apiKey: overrides.apiKey ?? PROBE_API_KEY,
    model: overrides.model ?? PROBE_MODEL,
    timeoutMs: overrides.timeoutMs ?? PROBE_TIMEOUT_MS,
    fetchImpl: standIn.fetchImpl,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  };
}

// ── reading a result ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ ok: boolean, code: string|null, message: string|null, status: number|null,
 *             text: string|null, style: string|null, transformations: string[]|null,
 *             meta: Record<string, unknown>|null, providerId: string|null }} Outcome
 */

/**
 * @param {unknown} result
 * @returns {Outcome|null} null when nothing readable came back — an empty reading, not a pass
 */
function readOutcome(result) {
  if (typeof result !== 'object' || result === null) return null;
  const candidate = /** @type {Record<string, any>} */ (result);
  if (typeof candidate.ok !== 'boolean') return null;
  return {
    ok: candidate.ok,
    code: typeof candidate.code === 'string' ? candidate.code : null,
    message: typeof candidate.message === 'string' ? candidate.message : null,
    status: typeof candidate.status === 'number' ? candidate.status : null,
    text: typeof candidate.text === 'string' ? candidate.text : null,
    style: typeof candidate.style === 'string' ? candidate.style : null,
    transformations: Array.isArray(candidate.transformations)
      ? candidate.transformations.map((entry) => String(entry))
      : null,
    meta:
      typeof candidate.meta === 'object' && candidate.meta !== null
        ? /** @type {Record<string, unknown>} */ (candidate.meta)
        : null,
    providerId: typeof candidate.providerId === 'string' ? candidate.providerId : null,
  };
}

/**
 * Drives one request and reads the outcome, recording the two ways a case can produce no reading.
 *
 * @param {Ledger} ledger
 * @param {any} adapter
 * @param {any} request
 * @param {StandIn} standIn
 * @param {string} caseId
 * @param {object} [overrides]
 * @returns {Promise<Outcome|null>}
 */
async function drive(ledger, adapter, request, standIn, caseId, overrides = {}) {
  let raw;
  try {
    raw = await adapter.transcribe(request, invocationFor(standIn, overrides));
  } catch (error) {
    ledger.absent(
      'CASE_THREW',
      caseId,
      `transcribe threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
    return null;
  }
  const outcome = readOutcome(raw);
  if (outcome === null) {
    ledger.absent(
      'EMPTY_READING',
      caseId,
      `transcribe returned nothing readable (${render(raw)}) — an unreadable outcome is not a pass`,
    );
    return null;
  }
  ledger.ran.add(caseId);
  return outcome;
}

// ── reading the request the stand-in received ────────────────────────────────────────────────

/**
 * The recorded request, unpacked into the fields the readings below are about.
 *
 * Deliberately NOT shared with the contract board: the board's own reader carries the audio as a
 * token, and this probe needs the audio's data URI in full to check it decodes to the recording it
 * sent. Two readers of one request are not two implementations of one contract — the board declares
 * what the wire must be, this probe checks the adapter against the caller's own request.
 *
 * @param {{ url: string, init: RequestInit|undefined }|undefined} call
 */
function readRequest(call) {
  const init = call?.init;
  const rawBody = typeof init?.body === 'string' ? init.body : '';
  let parsed = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const userParts = Array.isArray(messages[1]?.content) ? messages[1].content : null;
  const audioPart = Array.isArray(userParts)
    ? userParts.find((entry) => entry?.type === 'input_audio') ?? null
    : null;
  const textPart = Array.isArray(userParts)
    ? userParts.find((entry) => entry?.type === 'text') ?? null
    : null;
  return {
    method: typeof init?.method === 'string' ? init.method.toUpperCase() : null,
    url: call?.url ?? null,
    contentType: headerValue(init, 'content-type'),
    authorization: headerValue(init, 'authorization'),
    rawBody,
    model: typeof parsed?.model === 'string' ? parsed.model : null,
    modalities: Array.isArray(parsed?.modalities) ? parsed.modalities : null,
    stream: typeof parsed?.stream === 'boolean' ? parsed.stream : null,
    reasoningEffort: typeof parsed?.reasoning_effort === 'string' ? parsed.reasoning_effort : null,
    messageRoles: messages.map((/** @type {any} */ entry) => String(entry?.role ?? '')),
    system: typeof messages[0]?.content === 'string' ? messages[0].content : null,
    userPartTypes: Array.isArray(userParts)
      ? userParts.map((/** @type {any} */ entry) => String(entry?.type ?? ''))
      : null,
    userPartCount: Array.isArray(userParts) ? userParts.length : null,
    audioData:
      typeof audioPart?.input_audio?.data === 'string' ? audioPart.input_audio.data : null,
    audioFormat:
      typeof audioPart?.input_audio?.format === 'string' ? audioPart.input_audio.format : null,
    textPart: typeof textPart?.text === 'string' ? textPart.text : null,
  };
}

// ── hashing and small arithmetic (this probe's own, for cross-checking) ───────────────────────

/** @param {string} text @returns {string} */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The exact length a base64 encoding of `byteLength` bytes has, recomputed here rather than imported
 * from the adapter: a size reading that borrowed the implementation's arithmetic could not disagree
 * with it.
 *
 * @param {number} byteLength
 * @returns {number}
 */
function base64Length(byteLength) {
  return Math.ceil(byteLength / 3) * 4;
}

// ── the fixture the drives share ─────────────────────────────────────────────────────────────

/** The probe's audio, as bytes: ASCII, so its text and its bytes are the same recorded fact. */
function probeAudioBytes() {
  const bytes = new Uint8Array(AUDIO_TEXT.length);
  for (let index = 0; index < AUDIO_TEXT.length; index += 1) bytes[index] = AUDIO_TEXT.charCodeAt(index) & 0xff;
  return bytes;
}

/** @param {string} text @returns {Uint8Array} */
function asciiBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

/**
 * One recording as the adapter's request shape wants it.
 *
 * The media type defaults to the browser's own recording type rather than to a bare container: it is
 * the header the shipped recorder produces (ADR-004 §缺口①.3), so the default drive is the one every
 * other drive's expectation is calibrated against.
 *
 * @param {string} [mimeType]
 * @param {object} [hints]
 * @param {Uint8Array} [bytes]
 */
function probeRequest(mimeType = 'audio/webm;codecs=opus', hints, bytes) {
  /** @type {{ audio: { bytes: Uint8Array, mimeType: string, fileName: string }, hints?: object }} */
  const request = {
    audio: {
      bytes: bytes ?? probeAudioBytes(),
      mimeType,
      fileName: 'probe.webm',
    },
  };
  if (hints !== undefined) request.hints = hints;
  return request;
}

/** The chat-completions answer envelope this service's own response shape has. @param {string} content */
function chatAnswerBody(content) {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

/** The JSON object the task turn asks for, as the model would serialise it. */
function writtenContent() {
  return JSON.stringify({ transcript: TRANSCRIPT_ANSWER, instruction: INSTRUCTION_ANSWER });
}

// ── the tree's own modules ───────────────────────────────────────────────────────────────────

/**
 * @param {string} root
 * @param {string} pattern
 * @returns {string[]} root-relative `/`-separated paths, sorted
 */
function listFiles(root, pattern) {
  return globSync(pattern, { cwd: root })
    .map((entry) => entry.split(path.sep).join('/'))
    .sort();
}

/**
 * Enter `shared/asr/` through the registry before touching an adapter module.
 *
 * The registry value-imports every adapter; the adapters value-import `baseMimeType` /
 * `declaredAcceptsMime` / `classifyUpstreamFailure` from the contract leaf, so the registry↔adapter
 * value cycle this order was originally written for is gone. The registry-first entry is kept: it is
 * the documented way into the seam and it still holds for a reduced tree that predates the split.
 * The registry is absent in a reduced tree, and then there is nothing to enter through.
 *
 * @param {string} root @returns {Promise<void>}
 */
async function enterThroughRegistry(root) {
  const registry = path.join(root, 'shared/asr/asrRegistry.ts');
  if (existsSync(registry)) await import(pathToFileURL(registry).href);
}

/**
 * The module the probe measures: the one that declares this adapter's id.
 *
 * FOUND by its vocabulary rather than by a path written in here, for the reason the second adapter's
 * probe gives: a hardcoded path keeps "resolving" after the file moved, which is the one thing a
 * resolution check must not do. Loading every candidate is also what makes a second module claiming
 * the same id visible instead of silently ordered.
 *
 * @param {string} root
 * @returns {Promise<{ module: any, path: string, others: string[] }>}
 */
async function loadShippingAdapter(root) {
  const candidates = listFiles(root, 'shared/asr/**/*.asr-provider.ts');
  await enterThroughRegistry(root);
  /** @type {string[]} */
  const others = [];
  for (const relativePath of candidates) {
    const module = await import(pathToFileURL(path.join(root, relativePath)).href);
    if (module.id === ADAPTER_ID) return { module, path: relativePath, others };
    others.push(`${relativePath}(id=${String(module.id)})`);
  }
  throw new Error(
    `no module under shared/asr/ declares id '${ADAPTER_ID}' — saw ${others.join(', ') || 'none'}`,
  );
}

/**
 * A module under `shared/asr/` that exports `name`, found by that export rather than by its path.
 *
 * @param {string} root
 * @param {RegExp} marker
 * @returns {string|null}
 */
function findModuleBySource(root, marker) {
  for (const relativePath of listFiles(root, 'shared/asr/**/*.ts')) {
    let source;
    try {
      source = readFileSync(path.join(root, relativePath), 'utf8');
    } catch {
      continue;
    }
    if (marker.test(source)) return relativePath;
  }
  return null;
}

/**
 * The segment the shipping module exports under `name`, or `undefined` when it exports nothing there.
 *
 * @param {any} module
 * @param {string} name
 * @returns {string|undefined}
 */
function segmentOf(module, name) {
  const value = module[name];
  return typeof value === 'string' ? value : undefined;
}

// ── AC2 and AC3: the request's shape, and the prompt on it ───────────────────────────────────

/**
 * The request-construction group.
 *
 * @param {Ledger} ledger
 * @param {any} adapter
 * @param {any} module the shipping module, for the constants the expectations come from
 */
async function checkRequestShape(ledger, adapter, module) {
  const standIn = makeStandIn({ body: chatAnswerBody(writtenContent()) });
  const outcome = await drive(ledger, adapter, probeRequest(), standIn, 'request.send');
  const call = standIn.calls[0];
  const sent = readRequest(call);

  ledger.expect(
    'request.endpoint',
    sent.url,
    `${PROBE_BASE_URL}${CHAT_PATH}`,
    'REQUEST_ENDPOINT_MISMATCH',
    'the request goes to the chat-completions path this wire declares, under the configured base URL',
  );
  ledger.expect(
    'request.method',
    sent.method,
    'POST',
    'REQUEST_METHOD_MISMATCH',
    'a chat completion is a POST',
  );
  ledger.expect(
    'request.content-type',
    sent.contentType,
    'application/json',
    'REQUEST_CONTENT_TYPE_MISMATCH',
    'the body is announced as JSON, and announced under the header name the transport reads',
  );
  ledger.expect(
    'request.authorization',
    sent.authorization,
    `Bearer ${PROBE_API_KEY}`,
    'REQUEST_AUTH_MISMATCH',
    'the credential travels as a bearer token in the Authorization header, with no second home',
  );
  ledger.expect(
    'request.params',
    { model: sent.model, modalities: sent.modalities, stream: sent.stream },
    { model: PROBE_MODEL, modalities: ['text'], stream: false },
    'REQUEST_PARAMS_MISMATCH',
    'the body names the invocation\'s model, asks for text output only, and does not stream: this service answers a non-streamed chat completion',
  );
  ledger.expect(
    'request.params.reasoning-effort',
    sent.reasoningEffort,
    module.REASONING_EFFORT,
    'REQUEST_PARAMS_MISMATCH',
    'the decode budget is the shipping module\'s own recorded constant, not a value typed into the tooling',
  );
  ledger.expect(
    'request.params.reasoning-effort-literal',
    module.REASONING_EFFORT,
    'low',
    'REQUEST_PARAMS_MISMATCH',
    'and that constant is the `low` budget the frozen readings were taken at',
  );
  ledger.expect(
    'request.message-roles',
    sent.messageRoles,
    ['system', 'user'],
    'REQUEST_MESSAGES_MISMATCH',
    'the prompt is a system turn and the recording a user turn, in that order',
  );

  // ── the system turn, and the segments it is composed from (AC3) ─────────────────────────────
  const composed = SYSTEM_SEGMENTS.map((name) => String(segmentOf(module, name))).join('\n\n');
  ledger.ok('prompt.system.sha256.composed', sha256(composed));
  ledger.ok('prompt.system.sha256.wire', sha256(String(sent.system)));
  ledger.ok('prompt.system.bytes', sent.system === null ? 0 : Buffer.byteLength(sent.system, 'utf8'));
  ledger.expect(
    'request.system.canonical',
    sent.system,
    composed,
    'PROMPT_COMPOSITION_MISMATCH',
    `the system turn on the wire is the shipping module's own segments joined by a blank line, in the recorded order (${SYSTEM_SEGMENTS.join(', ')})`,
  );
  for (const name of SYSTEM_SEGMENTS) {
    const segment = segmentOf(module, name);
    const hash = segment === undefined ? null : sha256(segment);
    ledger.expect(
      `prompt.segment-sha256.${name}`,
      hash,
      RECORDED_SEGMENT_SHA256[name],
      'PROMPT_SEGMENT_SHA256_MISMATCH',
      `the ${name} segment's text changed: its sha256 is no longer the recorded one. The text is pinned by scripts/asr-omni-prompt-frozen-check.mjs against the experiment snapshot; this reading names the segment that moved`,
    );
    if (segment === undefined || segment.length === 0) {
      ledger.absent(
        'PROMPT_SEGMENT_EMPTY',
        `prompt.segment.${name}.non-empty`,
        `the shipping module does not export a non-empty '${name}' segment, so the composition above could be satisfied by a shorter prompt`,
      );
    } else {
      ledger.ok(`prompt.segment.${name}.non-empty`, true);
    }
    ledger.expect(
      `prompt.segment.${name}.in-system`,
      typeof segment === 'string' && segment.length > 0 ? String(sent.system ?? '').includes(segment) : false,
      true,
      'PROMPT_SEGMENT_MISSING',
      `the ${name} segment is not in the system turn the request carried — the prompt on the wire is not the module's own three segments`,
    );
  }
  const taskTurn = segmentOf(module, 'JSON_TASK');
  ledger.expect(
    'prompt.json-task-sha256',
    taskTurn === undefined ? null : sha256(taskTurn),
    RECORDED_SEGMENT_SHA256.JSON_TASK,
    'PROMPT_SEGMENT_SHA256_MISMATCH',
    'the task turn\'s sha256 is the recorded one, so the sentence the recording is turned into an answer by has not moved',
  );

  // ── the user turn's parts (AC2) ─────────────────────────────────────────────────────────────
  ledger.expect(
    'request.user-parts.count',
    sent.userPartCount,
    2,
    'REQUEST_USER_PARTS_MISMATCH',
    'the user turn carries exactly two parts: the recording and the task sentence',
  );
  ledger.expect(
    'request.user-parts.types',
    sent.userPartTypes,
    ['input_audio', 'text'],
    'REQUEST_USER_PARTS_MISMATCH',
    'the parts are an `input_audio` part and a `text` part, in that order, so neither the audio nor the task is left out',
  );
  ledger.expect(
    'request.input-audio.format',
    sent.audioFormat,
    // The expected value comes from the same table the nine rows below read, so the media type the
    // browser actually announces is pinned in one place rather than typed twice.
    FORMAT_BY_MIME.find(([mimeType]) => mimeType === 'audio/webm;codecs=opus')?.[1] ?? null,
    'REQUEST_AUDIO_PART_MISMATCH',
    'the audio part names the container, derived from the recording\'s base media type',
  );
  ledger.expect(
    'request.input-audio.data-prefix',
    typeof sent.audioData === 'string' ? sent.audioData.slice(0, 'data:audio/webm;base64,'.length) : null,
    'data:audio/webm;base64,',
    'REQUEST_AUDIO_PART_MISMATCH',
    'the recording travels as a base64 data URI whose media type is the recording\'s own base type',
  );
  const decoded = decodeDataUri(sent.audioData);
  ledger.expect(
    'request.input-audio.decoded-equals-audio',
    decoded === AUDIO_TEXT,
    true,
    'REQUEST_AUDIO_PART_MISMATCH',
    'the payload decodes to the bytes that were handed in — a data URI that is merely well-formed is not the recording',
  );
  ledger.expect(
    'request.text-part.equals-json-task',
    sent.textPart,
    taskTurn,
    'REQUEST_TEXT_PART_MISMATCH',
    'the text part is the shipping module\'s own task sentence, character for character',
  );

  // ── the base URL is a workspace address: the path is APPENDED, not substituted ──────────────
  const workspaceStandIn = makeStandIn({ body: chatAnswerBody(writtenContent()) });
  await drive(ledger, adapter, probeRequest(), workspaceStandIn, 'request.send.workspace-base', {
    baseUrl: WORKSPACE_BASE_URL,
  });
  ledger.expect(
    'request.endpoint.workspace-base',
    readRequest(workspaceStandIn.calls[0]).url,
    `${WORKSPACE_BASE_URL}${CHAT_PATH}`,
    'REQUEST_ENDPOINT_MISMATCH',
    'a configured base URL that already carries a path keeps it: the chat path is appended to the workspace address rather than replacing it',
  );
  const slashStandIn = makeStandIn({ body: chatAnswerBody(writtenContent()) });
  await drive(ledger, adapter, probeRequest(), slashStandIn, 'request.send.trailing-slash', {
    baseUrl: `${PROBE_BASE_URL}/`,
  });
  ledger.expect(
    'request.endpoint.trailing-slash',
    readRequest(slashStandIn.calls[0]).url,
    `${PROBE_BASE_URL}${CHAT_PATH}`,
    'REQUEST_ENDPOINT_MISMATCH',
    'a base URL with a trailing slash joins the path with no doubled slash, which is a different URL to a service that routes on it',
  );

  ledger.expect(
    'request.send.outcome',
    outcome === null ? 'no-reading' : `ok=${outcome.ok} style=${String(outcome.style)}`,
    `ok=true style=written`,
    'REQUEST_SHAPE_UNREADABLE',
    'the drive that carries every reading above answered with the written rewrite, so its request was read from a request that reached the transport',
  );
}

/**
 * The base64 of a `data:<mime>;base64,<payload>` URI, or `null` when the value is not one.
 *
 * Decoded by Node's own decoder rather than by the adapter's encoder: a check that used the
 * implementation's encoder to verify the implementation would agree with it whatever it did.
 *
 * @param {string|null} dataUri
 * @returns {string|null}
 */
function decodeDataUri(dataUri) {
  if (typeof dataUri !== 'string') return null;
  const marker = ';base64,';
  const at = dataUri.indexOf(marker);
  if (at === -1) return null;
  return Buffer.from(dataUri.slice(at + marker.length), 'base64').toString('latin1');
}

// ── AC4: the format field ────────────────────────────────────────────────────────────────────

/**
 * One drive per media type, each reading the `format` the request actually carried.
 *
 * Read off the WIRE rather than off the module's derivation function, because the reading the task
 * is about is what was sent: a derivation that computed the right word and then put a constant in
 * the body would pass a unit reading of the function and fail this one.
 *
 * @param {Ledger} ledger
 * @param {any} adapter
 */
async function checkFormatDerivation(ledger, adapter) {
  /** @type {Map<string, string|null>} */
  const observedByMime = new Map();
  for (const [mimeType, expected] of FORMAT_BY_MIME) {
    const standIn = makeStandIn({ body: chatAnswerBody(writtenContent()) });
    const outcome = await drive(
      ledger,
      adapter,
      probeRequest(mimeType, undefined, asciiBytes('probe-audio')),
      standIn,
      `format-by-mime[${mimeType}]`,
    );
    const sent = readRequest(standIn.calls[0]);
    const observed = outcome === null ? null : sent.audioFormat;
    observedByMime.set(mimeType, observed);
    ledger.expect(
      `format-by-mime[${mimeType}]`,
      observed,
      expected,
      'FORMAT_MISMATCH',
      `a recording announced as ${mimeType} is addressed to this service as '${expected}' — the container name is derived from the base media type, and the service spells two of them differently from the media type`,
    );
  }
  ledger.expect(
    'format-by-mime.parameters-dropped',
    observedByMime.get('audio/webm;codecs=opus') === observedByMime.get('audio/webm'),
    true,
    'FORMAT_MISMATCH',
    'the same container announced with and without parameters produces the same format: the browser\'s own recording type carries parameters, and a derivation that kept them would send the service a container name it does not know',
  );
}

// ── AC5, AC6, AC7: the answer shapes ─────────────────────────────────────────────────────────

/**
 * The written rewrite, under the three wrappings the proposal's table allows the object to arrive in.
 *
 * WHY ALL THREE ARE DRIVEN. "The model answered with a rewrite" and "the adapter can find a rewrite
 * wherever the model put it" are two different statements, and only the second is what the
 * first-`{`-to-last-`}` rule exists for.
 *
 * @param {Ledger} ledger
 * @param {any} adapter
 * @param {any} module
 */
async function checkWrittenParse(ledger, adapter, module) {
  const variants = [
    ['bare', writtenContent()],
    ['fenced', `\`\`\`json\n${writtenContent()}\n\`\`\``],
    ['prose', `好的，这是整理后的结果：\n${writtenContent()}\n以上。`],
  ];
  const declared = Array.isArray(module.WRITTEN_TRANSFORMATIONS)
    ? module.WRITTEN_TRANSFORMATIONS.map((/** @type {any} */ entry) => String(entry))
    : [];
  for (const [name, content] of variants) {
    const standIn = makeStandIn({ body: chatAnswerBody(content) });
    const outcome = await drive(ledger, adapter, probeRequest(), standIn, `parse.written[${name}]`);
    if (outcome === null) continue;
    ledger.expect(
      `parse.written[${name}].text`,
      outcome.text,
      INSTRUCTION_ANSWER,
      'WRITTEN_PARSE_WRONG_TEXT',
      `a well-formed answer is the REWRITE the model produced (${JSON.stringify(INSTRUCTION_ANSWER)}), on the ${name} wrapping as on the others`,
    );
    ledger.expect(
      `parse.written[${name}].text-is-not-transcript`,
      outcome.text === TRANSCRIPT_ANSWER,
      false,
      'WRITTEN_PARSE_WRONG_TEXT',
      'and it is not the transcription the same answer carries: the two strings differ, so returning the wrong one is visible',
    );
    ledger.expect(
      `parse.written[${name}].text-is-not-content`,
      outcome.text === content,
      false,
      'WRITTEN_PARSE_WRONG_TEXT',
      'the answer\'s raw content — the wrapper around the object — is never the text handed back',
    );
    ledger.expect(
      `parse.written[${name}].style`,
      outcome.style,
      'written',
      'WRITTEN_PARSE_WRONG_STYLE',
      'the result declares itself written, which is what selects the reading the caller shows',
    );
    ledger.expect(
      `parse.written[${name}].transformations`,
      outcome.transformations,
      declared,
      'WRITTEN_PARSE_WRONG_TRANSFORMATIONS',
      'a rewrite reports the transformations the instructions performed, so a caller can say which axis the text moved on',
    );
    ledger.expect(
      `parse.written[${name}].transformations-include-written-style`,
      Array.isArray(outcome.transformations) && outcome.transformations.includes('written-style'),
      true,
      'WRITTEN_PARSE_WRONG_TRANSFORMATIONS',
      'the written register is among them',
    );
    ledger.expect(
      `parse.written[${name}].provider-id`,
      outcome.providerId,
      ADAPTER_ID,
      'WRITTEN_PARSE_WRONG_PROVIDER',
      'the result names the provider that answered',
    );
  }
}

/**
 * The degradation, driven twice: once for an answer that is prose rather than an object, and once for
 * an object that carries only a transcription.
 *
 * THE SECOND VARIANT IS THE ONE THAT MAKES THE FIRST HONEST. An adapter whose fallback returned the
 * whole content would pass the prose variant — the prose IS the transcription — and fail this one,
 * where the content is the wrapper and the transcription is a field inside it. Both are the same
 * row of the table, read from the two directions it can be approached from.
 *
 * @param {Ledger} ledger
 * @param {any} adapter
 */
async function checkDegradation(ledger, adapter) {
  const verbatimProse = '嗯，那个，把 README 的端口改成 8080';
  const variants = [
    ['prose', verbatimProse, verbatimProse],
    ['transcript-only', JSON.stringify({ transcript: TRANSCRIPT_ANSWER }), TRANSCRIPT_ANSWER],
  ];
  for (const [name, content, expectedText] of variants) {
    const standIn = makeStandIn({ body: chatAnswerBody(content) });
    const outcome = await drive(
      ledger,
      adapter,
      probeRequest(),
      standIn,
      `parse.degraded[${name}]`,
    );
    if (outcome === null) continue;
    ledger.expect(
      `parse.degraded[${name}].ok`,
      outcome.ok,
      true,
      'DEGRADATION_NOT_RETURNED',
      'an answer with no rewrite in it still answers: losing a usable transcription because the wrapper was missing would be worse than returning it',
    );
    ledger.expect(
      `parse.degraded[${name}].text`,
      outcome.text,
      expectedText,
      'DEGRADATION_WRONG_TEXT',
      'the transcription reaches the caller — as the answer\'s own transcript field where there is one, and as the model\'s text where the answer was prose',
    );
    // Posted ONLY where the two strings differ. In the prose arm the raw content IS the transcription
    // — that is what makes it the prose arm — so "the text is not the raw content" is unreadable
    // there in both directions: it could neither hold for a correct adapter nor name a defect. In
    // this arm the content is a wrapper and the transcription is a field inside it, which is exactly
    // where handing the content back would be handing back JSON.
    if (content !== expectedText) {
      ledger.expect(
        `parse.degraded[${name}].text-is-not-raw-content`,
        outcome.text === content,
        false,
        'DEGRADATION_RETURNED_RAW_CONTENT',
        'the raw content is not the text: the content is this service\'s answer wrapper, and the transcription is the field inside it',
      );
    }
    ledger.expect(
      `parse.degraded[${name}].style`,
      outcome.style,
      'verbatim',
      'DEGRADATION_WRONG_STYLE',
      'the text IS the words as they were spoken, so it declares itself verbatim rather than claiming a rewrite that did not happen',
    );
    ledger.expect(
      `parse.degraded[${name}].transformations`,
      outcome.transformations,
      [],
      'DEGRADATION_TRANSFORMATIONS_NOT_EMPTY',
      'and claims none of the rewrite\'s transformations, since none of them were performed',
    );
    ledger.expect(
      `parse.degraded[${name}].written-fallback`,
      outcome.meta === null ? null : outcome.meta.writtenFallback,
      1,
      'DEGRADATION_NOT_SELECTABLE',
      'the degradation is a READING a caller can select on, not a silent downgrade: without it, a user shown a verbatim transcription would have no way to know the rewrite was skipped',
    );
  }
}

/**
 * The two empty answers and the body that is not an answer at all.
 *
 * THE THREE ARE READ TOGETHER BECAUSE THE PAIR THAT MATTERS IS THE MIDDLE ONE. "The service heard
 * nothing" and "the body was not this service's answer" are different faults, and collapsing them
 * would report a gateway page as a recording with no speech in it. The evidence for the fault is the
 * envelope, and it is what separates them.
 *
 * @param {Ledger} ledger
 * @param {any} adapter
 */
async function checkEmptyAndNotAnAnswer(ledger, adapter) {
  const emptyCases = [
    ['empty-object', JSON.stringify({ transcript: '', instruction: '' })],
    ['empty-content', ''],
  ];
  for (const [name, content] of emptyCases) {
    const standIn = makeStandIn({ body: chatAnswerBody(content) });
    const outcome = await drive(ledger, adapter, probeRequest(), standIn, `parse.empty[${name}]`);
    if (outcome === null) continue;
    ledger.expect(
      `parse.empty[${name}].code`,
      outcome.code,
      'NO_SPEECH_DETECTED',
      'EMPTY_ANSWER_NOT_NO_SPEECH',
      'an answer that parsed and carried neither a rewrite nor a transcription is a recording with nothing to return',
    );
    ledger.expect(
      `parse.empty[${name}].ok`,
      outcome.ok,
      false,
      'EMPTY_ANSWER_NOT_NO_SPEECH',
      'and it is a failure rather than a success with empty text, so a caller cannot insert an empty instruction',
    );
  }

  const notAnAnswer = '<html><body>502 Bad Gateway</body></html>';
  const standIn = makeStandIn({ body: notAnAnswer });
  const outcome = await drive(ledger, adapter, probeRequest(), standIn, 'parse.not-an-answer');
  if (outcome !== null) {
    ledger.expect(
      'parse.not-an-answer.code',
      outcome.code,
      'UPSTREAM_UNAVAILABLE',
      'NON_ENVELOPE_NOT_UPSTREAM_UNAVAILABLE',
      'a body that is not this service\'s chat envelope is an upstream fault: the model did not answer in prose, there was no answer',
    );
    ledger.expect(
      'parse.not-an-answer.text-absent',
      outcome.text,
      null,
      'RAW_BODY_AS_TRANSCRIPT',
      'the raw response is never handed back as the transcription — the whole body standing in for the text is the fault this row exists to refuse',
    );
  }
}

// ── AC8: the error mapping ───────────────────────────────────────────────────────────────────

/**
 * Every way the upstream can refuse, and the code each one must reach.
 *
 * THE TWO 403s ARE THE POINT OF THE GROUP, and they are two readings rather than one. The CODE says
 * the two are different facts — `AccessDenied.Unpurchased` is a model this account has not enabled
 * (`ACCOUNT_ACCESS`), a 403 naming nothing is a credential the service refuses (`UNAUTHORIZED`) — and
 * the MESSAGES are read against EACH OTHER, because a reading that only checked the code would pass
 * on an adapter that told both users the same thing. The entitlement message is also read for the
 * words that make it say what happened.
 *
 * @param {Ledger} ledger
 * @param {any} adapter
 */
async function checkErrorMapping(ledger, adapter) {
  const unpurchasedBody = JSON.stringify({
    error: { code: 'AccessDenied.Unpurchased', message: 'Model is not purchased' },
  });
  /** @type {[string, { status: number, body: string }, string][]} */
  const statusCases = [
    ['401', { status: 401, body: JSON.stringify({ error: 'unauthorized' }) }, 'UNAUTHORIZED'],
    ['403-unpurchased', { status: 403, body: unpurchasedBody }, 'ACCOUNT_ACCESS'],
    ['403-plain', { status: 403, body: JSON.stringify({ error: 'forbidden' }) }, 'UNAUTHORIZED'],
    ['429', { status: 429, body: JSON.stringify({ error: 'slow down' }) }, 'RATE_LIMITED'],
    ['500', { status: 500, body: JSON.stringify({ error: 'boom' }) }, 'UPSTREAM_UNAVAILABLE'],
  ];
  /** @type {Record<string, string|null>} */
  const messageByCase = {};
  for (const [name, options, expectedCode] of statusCases) {
    const standIn = makeStandIn({ body: options.body, status: options.status });
    const outcome = await drive(ledger, adapter, probeRequest(), standIn, `error.${name}`);
    if (outcome === null) continue;
    messageByCase[name] = outcome.message;
    ledger.ok(`error.${name}.message`, outcome.message);
    ledger.expect(
      `error.${name}.code`,
      outcome.code,
      expectedCode,
      'ERROR_CODE_MISMATCH',
      `a ${name} answer maps to ${expectedCode}: each refusal has the code a caller retries or reports it as, and a mapping that collapsed two of them onto one code would pass a one-code check`,
    );
    ledger.expect(
      `error.${name}.requests`,
      standIn.count(),
      1,
      'ERROR_BEFORE_TRANSPORT',
      'the status was answered by the transport, so this failure costs exactly one request',
    );
  }

  const unpurchasedMessage = messageByCase['403-unpurchased'] ?? '';
  const plainMessage = messageByCase['403-plain'] ?? '';
  ledger.expect(
    'error.403-unpurchased.mentions-entitlement',
    unpurchasedMessage.includes('未开通') || unpurchasedMessage.includes('余额不足'),
    true,
    'UNPURCHASED_MESSAGE_LOST',
    'the message for a model this account has not enabled says so: a user told their key was rejected while their account simply has not enabled the model has no way to act on it',
  );
  ledger.expect(
    'error.messages-differ',
    unpurchasedMessage.length > 0 && unpurchasedMessage !== plainMessage,
    true,
    'ERROR_MESSAGES_COLLAPSED',
    'and it is NOT the message a plain 403 produces — read against each other rather than each against a constant, so the sentence above cannot come from a constant that both cases share',
  );

  const timeoutStandIn = makeStandIn({ mode: 'abort' });
  const timeout = await drive(ledger, adapter, probeRequest(), timeoutStandIn, 'error.timeout', {
    timeoutMs: 40,
  });
  if (timeout !== null) {
    ledger.expect(
      'error.timeout.code',
      timeout.code,
      'UPSTREAM_UNAVAILABLE',
      'TIMEOUT_NOT_MAPPED',
      'a transport that was still silent when the invocation\'s own deadline passed is an unavailable upstream, read from the abort the adapter raised rather than from a code it chose — the failure this row refuses is that abort reaching the caller as something else',
    );
  }

  const controller = new AbortController();
  controller.abort();
  const cancelled = await drive(ledger, adapter, probeRequest(), makeStandIn({ mode: 'abort' }), 'error.caller-signal', {
    timeoutMs: 60000,
    signal: controller.signal,
  });
  if (cancelled !== null) {
    ledger.expect(
      'error.caller-signal.code',
      cancelled.code,
      'UPSTREAM_UNAVAILABLE',
      'CALLER_SIGNAL_IGNORED',
      'a caller\'s own abort signal reaches the transport: an invocation that passed one and had it ignored would keep a cancelled request alive',
    );
  }

  const unreachableStandIn = makeStandIn({ mode: 'reject' });
  const unreachable = await drive(ledger, adapter, probeRequest(), unreachableStandIn, 'error.transport');
  if (unreachable !== null) {
    ledger.expect(
      'error.transport.code',
      unreachable.code,
      'UPSTREAM_UNAVAILABLE',
      'TRANSPORT_NOT_MAPPED',
      "a transport that never answered is an unavailable upstream — the SAME code a 5xx and an aborted request reach, because the caller's remedy is the same for all three — and the failure this row refuses is a transport failure that reaches the caller as some other code (an unmapped one, or the credential code a caller would then retry forever)",
    );
    ledger.expect(
      'error.transport.requests',
      unreachableStandIn.count(),
      2,
      'ERROR_BEFORE_TRANSPORT',
      'the transport was reached twice: a rejection that carried no answer is retried once inside the adapter, and it is the ANSWER that failed',
    );
  }
}

// ── AC9: the budget ─────────────────────────────────────────────────────────────────────────

/**
 * The two sides of the declared budget.
 *
 * THE ZERO IS A COUNTER, NOT AN INFERENCE. "An unaffordable request is refused" is visible in the
 * error code; "it was never sent" is only visible at the transport, so the reading is the stand-in's
 * own call count. The other side is what keeps the guard a line rather than a wall: an audio that
 * fits is sent, measured at the transport as a body whose byte length is inside the budget.
 *
 * @param {Ledger} ledger
 * @param {any} adapter
 * @param {any} module
 */
async function checkBudget(ledger, adapter, module) {
  const budget = module.capabilities.maxInlineRequestBytes;
  ledger.ok('size.declared-budget', budget);

  // The audio's encoding alone is past the budget, so the whole request is too whatever the rest of
  // the skeleton weighs. Derived here rather than imported from the board, so the two agree only if
  // the arithmetic is right.
  const overBytes = Math.ceil((budget + 1) / 4) * 3;
  ledger.ok('size.oversize.audio-bytes', overBytes);
  ledger.ok('size.oversize.encoded-lower-bound', base64Length(overBytes));
  const overStandIn = makeStandIn({ body: chatAnswerBody(writtenContent()) });
  const over = await drive(
    ledger,
    adapter,
    probeRequest('audio/webm', undefined, new Uint8Array(overBytes)),
    overStandIn,
    'size.oversize',
  );
  if (over !== null) {
    ledger.expect(
      'size.oversize.code',
      over.code,
      'OVERSIZE',
      'OVERSIZE_NOT_REFUSED',
      `an audio whose encoding alone (${base64Length(overBytes)} B) is past the declared ${budget} B request budget is refused here rather than handed to the service to refuse`,
    );
    ledger.expect(
      'size.oversize.requests',
      overStandIn.count(),
      0,
      'OVERSIZE_SENT_REQUESTS',
      'and the refusal cost ZERO requests, read off the transport\'s own counter: a guard that runs after the transport has already paid for the upload it meant to prevent',
    );
  }

  // The affordable side leaves a margin for the skeleton — the prompt, the task turn and the JSON
  // around them — which is what makes the pair straddle the line rather than measure one side twice.
  const affordableBytes = Math.floor((budget - 65536) / 4) * 3;
  ledger.ok('size.affordable.audio-bytes', affordableBytes);
  ledger.ok('size.affordable.encoded-bytes', base64Length(affordableBytes));
  const fitStandIn = makeStandIn({ body: chatAnswerBody(writtenContent()) });
  const fit = await drive(
    ledger,
    adapter,
    probeRequest('audio/webm', undefined, new Uint8Array(affordableBytes)),
    fitStandIn,
    'size.affordable',
  );
  if (fit !== null) {
    ledger.expect(
      'size.affordable.code',
      fit.ok ? `ok:${String(fit.text)}` : String(fit.code),
      `ok:${INSTRUCTION_ANSWER}`,
      'AFFORDABLE_NOT_SENT',
      'an audio that fits inside the declared budget is sent and answered: the guard is a line, not a wall',
    );
    ledger.expect(
      'size.affordable.requests',
      fitStandIn.count(),
      1,
      'AFFORDABLE_NOT_SENT',
      'exactly one request, so the accepted side is a request that reached the transport rather than a shortcut',
    );
    const sent = readRequest(fitStandIn.calls[0]);
    ledger.expect(
      'size.affordable.body-within-budget',
      Buffer.byteLength(sent.rawBody, 'utf8') <= budget,
      true,
      'AFFORDABLE_BODY_OVER_BUDGET',
      'the body the transport actually received is inside the budget — read off the received body rather than off the estimate the guard used, so an estimate that under-counts the skeleton is visible here',
    );
  }
}

// ── AC10: the hints ─────────────────────────────────────────────────────────────────────────

/**
 * The caller's hints, and the two positive controls that make their absence a reading.
 *
 * "The prompt is not on the wire" is only evidence if the request carries something it could be told
 * apart from. So the audio's data URI and the task sentence are read as PRESENT in the same body: a
 * builder that put nothing anywhere, or one that sent an empty request, cannot pass this group.
 *
 * @param {Ledger} ledger
 * @param {any} adapter
 * @param {any} module the shipping module, for the task sentence the second control reads
 */
async function checkHints(ledger, adapter, module) {
  const standIn = makeStandIn({ body: chatAnswerBody(writtenContent()) });
  const outcome = await drive(
    ledger,
    adapter,
    probeRequest('audio/webm', {
      prompt: HINT_PROMPT,
      context: HINT_CONTEXT,
      language: HINT_LANGUAGE,
    }),
    standIn,
    'hints.send',
  );
  if (outcome === null) return;
  const sent = readRequest(standIn.calls[0]);
  ledger.ok('hints.body.bytes', Buffer.byteLength(sent.rawBody, 'utf8'));

  for (const [name, sentinel] of [
    ['prompt', HINT_PROMPT],
    ['context', HINT_CONTEXT],
    ['language', HINT_LANGUAGE],
  ]) {
    ledger.expect(
      `hints.${name}.on-the-wire`,
      sent.rawBody.includes(sentinel),
      false,
      'UNHONORED_HINT_ON_THE_WIRE',
      `the declaration says honors.${name}=false, so the caller's ${name} hint must not be on the body at all — not forwarded and ignored, and not sent as an empty value either`,
    );
  }

  ledger.expect(
    'hints.audio-control.on-the-wire',
    typeof sent.audioData === 'string' && sent.audioData.includes(';base64,') && decodeDataUri(sent.audioData) === AUDIO_TEXT,
    true,
    'HINT_CONTROL_ABSENT',
    'the recording IS on the body, in this wire\'s own form: without it the three absences above could be satisfied by a request that carries nothing',
  );
  const taskTurn = segmentOf(module, 'JSON_TASK');
  // Read from the DECODED part rather than from a substring of the body: the task sentence contains
  // quotes, which the body's JSON escaping turns into `\"`, so a raw-substring reading would call a
  // sentence that is plainly on the wire absent.
  ledger.expect(
    'hints.task-turn-control.on-the-wire',
    typeof taskTurn === 'string' && sent.textPart === taskTurn,
    true,
    'HINT_CONTROL_ABSENT',
    'and the shipping module\'s task sentence is on the body, so the absence of the caller\'s hints is an absence and not an empty request',
  );
}

// ── AC13: the contract face ─────────────────────────────────────────────────────────────────

/**
 * The contract face this adapter's wire entered, and the board rows it is measured by.
 *
 * THE ROW IS NOT DECORATION. The probe drives the SHIPPING adapter through the board's own three
 * behavioural probes — request construction, error mapping and size layering — so the row's golden
 * body, its answers, its prompt and context parts and its budget arithmetic each have at least one
 * reading behind them. A row that existed only because the wire union demanded a member would leave
 * these probes measuring nothing, which is why an empty group is a failure here rather than a pass.
 *
 * @param {Ledger} ledger
 * @param {any} adapter
 * @param {any} boardModule
 * @param {string} contractPath
 * @param {string} root
 */
async function checkContractFace(ledger, adapter, boardModule, contractPath, root) {
  const contractSource = readFileSync(path.join(root, contractPath), 'utf8');
  ledger.expect(
    'contract.wire-member',
    /export type AsrWire = [^;]*'chat-audio'/.test(contractSource),
    true,
    'WIRE_MEMBER_ABSENT',
    'the wire union has a member for this shape, so the tag the adapter declares is one the contract names rather than a value that happens to stringify',
  );
  ledger.expect(
    'contract.meta-writtenFallback',
    /writtenFallback\??\s*:/.test(contractSource),
    true,
    'META_FIELD_ABSENT',
    'the success envelope has a field for the degradation, which is what makes it a reading a caller can select on',
  );

  // The row's recorded endpoint against the endpoint the adapter was READ sending to: two facts from
  // two modules, so this is a reading rather than a restatement. The board's own probes build their
  // requests from the same row, which is why a row that recorded a different path would otherwise
  // red first somewhere less legible than here.
  const endpointStandIn = makeStandIn({ body: chatAnswerBody(writtenContent()) });
  await drive(ledger, adapter, probeRequest(), endpointStandIn, 'request.endpoint.equals-board-row');
  ledger.expect(
    'request.endpoint.equals-board-row',
    readRequest(endpointStandIn.calls[0]).url,
    boardModule.INVARIANT_CHAT_ENDPOINT,
    'REQUEST_ENDPOINT_MISMATCH',
    'the endpoint the adapter actually calls is the one the contract board records for its row, so the row and the behaviour are one thing rather than a table beside it',
  );

  const row = boardModule.wireModelFor(adapter);
  ledger.expect('board.row.wire', row?.wire, 'chat-audio', 'WIRE_MODELS_ROW_WRONG',
    'the board resolves the row the adapter\'s own declaration names');
  ledger.expect('board.row.endpoint', row?.endpoint, boardModule.INVARIANT_CHAT_ENDPOINT, 'WIRE_MODELS_ROW_WRONG',
    'the row records the endpoint this wire calls, and it is the one the adapter was read sending to above');
  ledger.expect('board.row.content-type', row?.contentType, 'application/json', 'WIRE_MODELS_ROW_WRONG',
    'the row records the body\'s media type');
  ledger.expect('board.row.credential-header', row?.credentialHeader, 'authorization', 'WIRE_MODELS_ROW_WRONG',
    'the row records the header this wire carries its credential under, which is the header the request above announced');

  const probes = [
    ['request-construction', boardModule.probeRequestConstruction],
    ['error-mapping', boardModule.probeErrorMapping],
    ['size-layering', boardModule.probeSizeLayering],
  ];
  let failures = 0;
  let total = 0;
  for (const [group, probe] of probes) {
    let readings;
    try {
      readings = await probe(adapter);
    } catch (error) {
      ledger.absent('BOARD_PROBE_THREW', `board.${group}.readings`,
        `${group} threw instead of measuring: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (readings.length === 0) {
      ledger.absent('BOARD_GROUP_EMPTY', `board.${group}.readings`,
        `${group} produced no readings at all — a group with nothing behind it is not a green group`);
      continue;
    }
    ledger.ok(`board.${group}.readings`, readings.length);
    for (const reading of readings) {
      total += 1;
      if (reading.verdict === 'fail') {
        failures += 1;
        ledger.disagree('BOARD_READING_FAILED', `board:${reading.id}`, reading.observed, reading.expected,
          `${reading.group}: ${reading.detail}`);
      } else {
        ledger.ok(`board:${reading.id}`, reading.observed);
      }
    }
  }
  ledger.ok('board.readings.total', total);
  ledger.expect(
    'board.failures.total',
    failures,
    0,
    'BOARD_READING_FAILED',
    'the shipping adapter satisfies the board rows its own declaration selects — the new wire is measured by the contract, not merely named in it',
  );
}

// ── the case inventory ──────────────────────────────────────────────────────────────────────

/**
 * Every case this probe claims to run. The inventory is the probe's own, not a claim about the tree:
 * a case on it that produced no reading is exactly the empty reading AC1 refuses to read as green,
 * and it is what makes "it did not run" distinguishable from "it ran and found nothing".
 */
const REQUEST_CASES = [
  'request.send',
  'request.send.workspace-base',
  'request.send.trailing-slash',
  'request.endpoint.equals-board-row',
];
const ANSWER_CASES = [
  'parse.written[bare]',
  'parse.written[fenced]',
  'parse.written[prose]',
  'parse.degraded[prose]',
  'parse.degraded[transcript-only]',
  'parse.empty[empty-object]',
  'parse.empty[empty-content]',
  'parse.not-an-answer',
];
const ERROR_CASES = [
  'error.401',
  'error.403-unpurchased',
  'error.403-plain',
  'error.429',
  'error.500',
  'error.timeout',
  'error.caller-signal',
  'error.transport',
];
const SIZE_CASES = ['size.oversize', 'size.affordable', 'hints.send'];

// ── main ─────────────────────────────────────────────────────────────────────────────────────

/** @returns {Promise<number>} the process exit code */
async function main() {
  /** @type {{ root: string }} */
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const root = options.root;
  let isDirectory = false;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    process.stdout.write(`root is not a directory: ${root}\n`);
    return 1;
  }

  const ledger = new Ledger();
  const poison = installFetchPoison();
  /** @type {string[]} */
  const header = [
    `asr-dashscope-omni-check root=${root}`,
    // AC12: the verdict is about a run on an injected transport, and this is the line that says so.
    'network=stand-in',
    // The boundaries of this reading, printed rather than left to a reader's assumption.
    'honest-registration=adapter-not-registered-in-asrRegistry (a later task owns registration and dispatch)',
    'honest-registration=no-transport-capability-no-ssrf-allowlist (a later task owns that field)',
    'honest-registration=no-user-configuration-no-key-masking-no-health-check (a later task)',
    'honest-registration=no-browser-end-to-end (a later task)',
    'honest-registration=upstream-is-a-stand-in-not-the-real-service (the live smoke test is manual, by decision)',
    'honest-registration=model-is-an-alias-the-service-may-re-point',
    'honest-registration=prompt-text-not-held-by-this-tooling; only its sha256 is, and the text itself is pinned by scripts/asr-omni-prompt-frozen-check.mjs',
  ];

  let adapterId = null;
  try {
    const registryPath = findModuleBySource(root, /export function resolve\s*\(/);
    header.push(`registry-module=${registryPath ?? '<none>'}`);
    // The types the wire union and the success envelope are declared in live in the contract leaf,
    // which the registry re-exports; the contract face is a reading of that file's own text.
    const contractPath = findModuleBySource(root, /export type AsrWire\s*=/);
    header.push(`contract-module=${contractPath ?? '<none>'}`);

    const { module, path: adapterPath, others } = await loadShippingAdapter(root);
    adapterId = String(module.id);
    header.push(`adapter-module=${adapterPath}`);
    header.push(`adapter-id=${adapterId}`);
    for (const other of others) header.push(`  other-provider-module=${other}`);

    const boardPath = findModuleBySource(root, /export async function runAsrContractInvariants\s*\(/);
    header.push(`board-module=${boardPath ?? '<none>'}`);

    const adapter = module.adapter;
    if (adapter === undefined || adapter === null || typeof adapter.transcribe !== 'function') {
      ledger.absent('ADAPTER_UNRESOLVED', 'adapter.export',
        'the shipping module exports no `adapter` with a transcribe, so no reading below has a subject');
    } else {
      ledger.expect('adapter.id', adapter.id, ADAPTER_ID, 'ADAPTER_ID_MISMATCH',
        'the adapter the module exports declares the id this probe was looking for');
      ledger.expect('adapter.wire', adapter.wire, 'chat-audio', 'ADAPTER_WIRE_MISMATCH',
        'and it declares the wire shape this probe reads its requests as');
      ledger.expect('adapter.capabilities.style', adapter.capabilities?.style, 'written', 'CAPABILITIES_WRONG',
        'this is the repository\'s written-style recogniser: the result of a call to it is a rewrite, not a transcription');
      ledger.expect('adapter.capabilities.honors', adapter.capabilities?.honors, { prompt: false, language: false, context: false }, 'CAPABILITIES_WRONG',
        'and it acknowledges none of the caller\'s hints, which is the declaration the hint readings below rest on');
      ledger.expect('adapter.capabilities.oversize', adapter.capabilities?.oversize, 'reject', 'CAPABILITIES_WRONG',
        'an unaffordable request is refused here rather than handed to a service to refuse');

      await checkRequestShape(ledger, adapter, module);
      await checkFormatDerivation(ledger, adapter);
      await checkWrittenParse(ledger, adapter, module);
      await checkDegradation(ledger, adapter);
      await checkEmptyAndNotAnAnswer(ledger, adapter);
      await checkErrorMapping(ledger, adapter);
      await checkBudget(ledger, adapter, module);
      await checkHints(ledger, adapter, module);

      if (boardPath === null) {
        ledger.absent('BOARD_UNRESOLVED', 'board.module',
          'no module under shared/asr/ exports runAsrContractInvariants, so the contract face could not be measured');
      } else if (registryPath === null) {
        ledger.absent('BOARD_UNRESOLVED', 'board.registry',
          'no module under shared/asr/ exports resolve, so the contract face could not be read');
      } else if (contractPath === null) {
        ledger.absent('BOARD_UNRESOLVED', 'board.contract',
          'no module under shared/asr/ declares the AsrWire union, so the contract face could not be read');
      } else {
        const board = await import(pathToFileURL(path.join(root, boardPath)).href);
        await checkContractFace(ledger, adapter, board, contractPath, root);
      }
    }
  } catch (error) {
    ledger.absent('PROBE_THREW', 'main',
      error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
  } finally {
    poison.restore();
  }

  ledger.requireAll([...REQUEST_CASES, ...ANSWER_CASES, ...ERROR_CASES, ...SIZE_CASES]);
  ledger.requireAll(
    FORMAT_BY_MIME.map(([mimeType]) => `format-by-mime[${mimeType}]`).concat('format-by-mime.parameters-dropped'),
  );

  if (poison.calls.length > 0) {
    ledger.absent('NETWORK_CALL', 'ambient-fetch-calls',
      `the ambient fetch was reached ${poison.calls.length} time(s) (${poison.calls.join(', ')}) — every environment dependency must be injected for this probe to be offline`);
  }
  ledger.ok('ambient-fetch-calls', poison.calls.length);

  const failing = [...new Map(ledger.problems.map((problem) => [problem.token + problem.detail, problem])).values()];
  for (const problem of failing) process.stdout.write(`FAIL ${problem.token}: ${problem.detail}\n`);
  process.stdout.write(`${[...header, ...ledger.lines].join('\n')}\n`);
  process.stdout.write(
    `asr-dashscope-omni-check: adapter=${adapterId ?? '<none>'} readings=${ledger.lines.length} `
      + `failures=${failing.length} platform-fetch-calls=${poison.calls.length}\n`,
  );
  return failing.length === 0 ? 0 : 1;
}

process.exitCode = await main();
