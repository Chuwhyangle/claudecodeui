/**
 * The transcription seam's contract board: the five invariant groups of ADR-004 §L3(b), written
 * ONCE and driven by both runners.
 *
 * `src/shared/asr/tests/asrContractInvariants.test.ts` drives it as suite readings and
 * `scripts/asr-contract-invariants-check.mjs` drives it as an operator command. Neither holds an
 * invariant of its own: a probe written in the checker and a probe written in the suite would be
 * two implementations of one contract, and a green checker could disagree with a red suite about
 * what "the invariants hold" means.
 *
 * THE BOARD IS PARAMETERISED BY THE REGISTRY, not by a provider list written here. Every group
 * runs against every adapter the caller hands it, so a provider added to `asrRegistry.ts`
 * tomorrow is measured by this file the day it is registered.
 *
 * IT IS ALSO PARAMETERISED BY THE WIRE — and that is a correction rather than a feature. A
 * registered adapter is only half a subject: the readings below are about a request, and a request
 * only exists in some shape. The first version of this board had the multimodal shape written
 * through it — the generation endpoint, a JSON body, base64 audio, a generation envelope — so
 * registering the SHIPPED recogniser (a multipart `/audio/transcriptions` adapter) turned every
 * group red with readings that said the new adapter was broken when the board was. That is the
 * same fault the seam exists to prevent, one level up: expectations held once, for a shape, in a
 * place that then measures a different one. The shape an adapter speaks is therefore DECLARED
 * (`AsrAdapter.wire`) and this file derives its expectations from that declaration, which makes the
 * declaration itself a second thing under test: an adapter that declares one wire and sends another
 * disagrees with the golden body its own declaration implies.
 *
 * A WIRE IS ALSO WHERE THE CREDENTIAL'S HEADER NAME COMES FROM — `authorization` on the multipart
 * shape, `x-goog-api-key` on the generation one — so the credential readings ask each wire's own
 * header rather than one name chosen here. A board that read `authorization` on both would report
 * every generation-shape request as unauthenticated and red an adapter that was authenticating
 * correctly, which is the same fault one level down: the board's own vocabulary deciding what
 * counts as a credential.
 *
 * AN EMPTY BOARD IS NOT A GREEN BOARD. A registry that resolved to zero providers, or a group
 * that produced zero readings, is `empty` — never `pass`. An exit code 0 from a glob that matched
 * nothing is a shape this repository has already paid for, so `readings.length === 0` is scored
 * as loudly as a disagreement is.
 *
 * ENVIRONMENT NEUTRALITY is the same machine property `./asrRegistry.ts` documents: this file is
 * compiled by the root configuration (`lib: ES2020 + DOM`, `types: ["vite/client"]`) AND by
 * `server/tsconfig.json` (`lib: ES2022`, NodeNext, `types: ["node"]`). So it uses no Node built-in
 * and no ES2021+ library feature, and every environment dependency travels in as a parameter.
 * Relative specifiers end in `.js` because NodeNext demands it.
 */
import type {
  AsrAdapter,
  AsrCapabilities,
  AsrErrorCode,
  AsrHints,
  AsrInvocation,
  AsrRequest,
  AsrResult,
  AsrSuccess,
  AsrToken,
  AsrWire,
} from './asrRegistry.js';

export const INVARIANT_GROUP_IDS = [
  'request-construction',
  'error-mapping',
  'size-layering',
  'redaction',
  'mime-gate',
  'token-contract',
] as const;

export type InvariantGroupId = (typeof INVARIANT_GROUP_IDS)[number];

/** One measurement, and what it was compared against. */
export type InvariantReading = {
  group: InvariantGroupId;
  /** Stable across runs: `<probe>.<reading>` with the provider appended for per-provider probes. */
  id: string;
  provider: string;
  observed: string;
  expected: string;
  verdict: 'pass' | 'fail';
  /** What the reading asserts and — on a failure — why it disagrees. Never carries a needle. */
  detail: string;
};

export type InvariantGroupVerdict = {
  group: InvariantGroupId;
  verdict: 'pass' | 'fail' | 'unmeasured';
  readings: number;
  /** The ids that disagreed, so "this group is red" reads as *which reading* is red. */
  failing: string[];
};

export type InvariantReport = {
  /** `empty` whenever nothing was measured, including a board with no readings at all. */
  verdict: 'pass' | 'fail' | 'empty';
  groups: InvariantGroupVerdict[];
  readings: InvariantReading[];
  /**
   * Every line a runner would print for this report, already canonicalised: the recorded request
   * reading carries the audio payload as a token, never as bytes, so the board cannot print what
   * the contract says must not leak. The redaction group scans exactly these lines.
   */
  logs: string[];
};

// ── the recorded fixture ─────────────────────────────────────────────────────────────────────

/** The fixture audio is ASCII so its bytes, its text and its encoding are all one recorded fact. */
export const INVARIANT_AUDIO_TEXT = 'ASR-INVARIANT-AUDIO-c41d';

/**
 * The standard base64 of `INVARIANT_AUDIO_TEXT`, computed independently of the adapter's encoder
 * (`python3 -c "import base64; print(base64.b64encode(b'ASR-INVARIANT-AUDIO-c41d').decode())"`).
 * Independent on purpose: a constant copied out of the adapter would agree with a wrong encoder.
 */
export const INVARIANT_AUDIO_BASE64 = 'QVNSLUlOVkFSSUFOVC1BVURJTy1jNDFk';

export const INVARIANT_API_KEY = 'ASR-INVARIANT-KEY-9f3c2b7a';
export const INVARIANT_PROMPT = 'summarise the invoice';
export const INVARIANT_CONTEXT = 'the invariant context';
export const INVARIANT_TRANSCRIPT = 'the invariant transcript';
export const INVARIANT_BASE_URL = 'https://asr.invalid';
export const INVARIANT_MODEL = 'invariant-model';

/**
 * The instruction the multimodal adapter sends as the first text part of `contents[0]`.
 *
 * RECORDED AS ITS OWN LITERAL — retyped, not imported from the adapter — and that is the same
 * discipline `INVARIANT_ENDPOINT` and `INVARIANT_AUDIO_BASE64` follow: a body composed from the
 * adapter's own constant could not disagree with the adapter. Editing the adapter's instruction
 * without editing this one reds `request.body.golden`, which is the reading that says the request
 * changed; the editor then decides whether the change was meant instead of the board quietly
 * redefining what it expects. It is a text part of `contents[0]` rather than a `systemInstruction`
 * on purpose: that is what keeps `honors.prompt: false` (the caller's prompt is not forwarded)
 * separable from "the request asks for nothing at all".
 */
export const INVARIANT_INSTRUCTION =
  '请逐字转写这段音频，保持原有语言，只输出转写文本，不要时间戳、说话人标签、翻译或总结。';

/**
 * The URL the fixture's base URL and model resolve to, recorded rather than re-derived — one per
 * wire, because the endpoint is the first thing the two shapes disagree about.
 */
export const INVARIANT_ENDPOINT = 'https://asr.invalid/v1beta/models/invariant-model:generateContent';
export const INVARIANT_TRANSCRIPTION_ENDPOINT = 'https://asr.invalid/audio/transcriptions';
export const INVARIANT_CHAT_ENDPOINT = 'https://asr.invalid/compatible-mode/v1/chat/completions';

/**
 * The written instruction the chat wire's answer carries BESIDE its transcript.
 *
 * A value of its own rather than a second use of `INVARIANT_TRANSCRIPT`, and the difference is the
 * reading: a wire whose answer holds two different strings can tell "the adapter returned the
 * rewrite" from "the adapter returned the transcription it was given" — the degradation the
 * `chat-audio` model exists to be measured for. An answer whose two fields held the same string
 * would be green under both, so the chat row's own steps use this one as the instruction.
 */
export const INVARIANT_WRITTEN_INSTRUCTION = 'the invariant written instruction';

/** The audio payload's canonical form inside a recorded body reading. */
export const INVARIANT_AUDIO_TOKEN = '<AUDIO>';

/** The chat wire's audio payload: the data URI with its encoded bytes tokenised. */
export const INVARIANT_CHAT_AUDIO_URI = `data:audio/webm;base64,${INVARIANT_AUDIO_TOKEN}`;

/**
 * The chat wire's two prompt-bearing positions, as tokens rather than as text.
 *
 * WHY THE BOARD DOES NOT RETYPE THE FROZEN PROMPT. The E group's prompt ships as
 * `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`, whose authoritative record is
 * `experiments/voice-omni-written/fixtures/snapshot.json` — the pair
 * `scripts/asr-omni-prompt-frozen-check.mjs` keeps identical segment by segment. This is the same
 * discipline `INVARIANT_INSTRUCTION` follows for the multimodal adapter's own instruction, one step
 * further: that instruction is one short sentence, while this prompt is four segments of measured
 * text. A third copy here would be a copy of a frozen artefact that nothing pins, and importing the
 * adapter's module would make the board depend on the module it measures.
 *
 * What the board pins instead is the SHAPE: the system turn holds a string, the user turn's text
 * part holds a string, and both sit where the declaration says they sit. The prompt's TEXT is
 * pinned where it belongs — by sha256, in the criterion that owns it.
 */
export const INVARIANT_SYSTEM_TOKEN = '<SYSTEM>';
export const INVARIANT_JSON_TASK_TOKEN = '<JSON-TASK>';

export type InvariantFixture = {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  audioText: string;
  mimeType: string;
  fileName: string;
  prompt: string;
  context: string;
  transcript: string;
};

export const INVARIANT_FIXTURE: InvariantFixture = {
  baseUrl: INVARIANT_BASE_URL,
  model: INVARIANT_MODEL,
  apiKey: INVARIANT_API_KEY,
  timeoutMs: 250,
  audioText: INVARIANT_AUDIO_TEXT,
  // A container with parameters: the gate has to match on the base type, which is the half of
  // `acceptsMime` a naive `indexOf(whole-string)` implementation gets wrong.
  mimeType: 'audio/webm;codecs=opus',
  fileName: 'clip.webm',
  prompt: INVARIANT_PROMPT,
  context: INVARIANT_CONTEXT,
  transcript: INVARIANT_TRANSCRIPT,
};

/** The fixture's audio, as bytes. ASCII, so the text and the bytes are the same recorded fact. */
export function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

/** The fixture request: a hinted upload, so "which hints reached the wire" is answerable. */
export function invariantRequest(overrides?: {
  bytes?: Uint8Array;
  mimeType?: string;
  hints?: AsrHints;
}): AsrRequest {
  const fixture = INVARIANT_FIXTURE;
  const hints: AsrHints =
    overrides !== undefined && overrides.hints !== undefined
      ? overrides.hints
      : { prompt: fixture.prompt, context: fixture.context };
  return {
    audio: {
      bytes:
        overrides !== undefined && overrides.bytes !== undefined
          ? overrides.bytes
          : asciiBytes(fixture.audioText),
      mimeType:
        overrides !== undefined && overrides.mimeType !== undefined
          ? overrides.mimeType
          : fixture.mimeType,
      fileName: fixture.fileName,
    },
    hints,
  };
}

/**
 * The multimodal service's answer, as the generation envelope carries it: `envelope(text)` is a
 * complete answer and `emptyEnvelope()` the same answer with no text part in it.
 */
export function envelope(text: string): unknown {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

export function emptyEnvelope(): unknown {
  return { candidates: [{ content: { parts: [] } }] };
}

/**
 * The chat service's answer: a chat completion whose assistant turn carries the two-field JSON
 * object the task turn asked for, serialised as its content.
 *
 * The two fields are PARAMETERS because the wire's whole point is that they are different strings:
 * an answer whose instruction and transcript were the same string could not tell a rewrite from a
 * passthrough, and that distinction is the degradation reading.
 */
export function chatEnvelope(transcript: string, instruction: string): unknown {
  return { choices: [{ message: { content: JSON.stringify({ transcript, instruction }) } }] };
}

/** The same answer with an empty assistant turn. */
export function chatEmptyEnvelope(): unknown {
  return { choices: [{ message: { content: JSON.stringify({ transcript: '', instruction: '' }) } }] };
}

// ── the injected transport ───────────────────────────────────────────────────────────────────

/**
 * What the transport does when it is reached. The board never touches the network: every probe
 * runs on one of these, so "zero platform fetch" is a property of the run rather than a promise
 * about the adapter.
 */
export type InvariantStep =
  | { kind: 'json'; status?: number; payload: unknown }
  | { kind: 'raw'; status?: number; body: string }
  | { kind: 'reject'; mode: 'transport' | 'timeout' };

/** One request as it was actually written, with the credential reduced to its presence. */
export type RecordedRequest = {
  method: string;
  url: string;
  contentType: string | null;
  /**
   * `present`/`absent`, and never the value: a board that recorded the key would leak it itself.
   *
   * WHICH HEADER THIS WAS READ FROM IS A PROPERTY OF THE WIRE, NOT OF THE ADAPTER. An API key
   * travels as `Authorization: Bearer <key>` on the OpenAI-compatible shape and as
   * `x-goog-api-key: <key>` on the generation shape (measured against the service, 2026-09-23),
   * so a board that read one name everywhere would record every generation-shape request as
   * unauthenticated and then red an adapter that was authenticating correctly. The name arrives as
   * a parameter (`AsrWireModel.credentialHeader`); the reading stays what it was, which is WHETHER
   * the request announced a credential at all.
   */
  credential: 'present' | 'absent';
  body: string;
};

export type RecordedTransport = {
  calls: number;
  requests: RecordedRequest[];
};

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return null;
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (String(entry[0]).toLowerCase() === wanted) return String(entry[1]);
    }
    return null;
  }
  const asHeaders = headers as { get?: (key: string) => string | null };
  if (typeof asHeaders.get === 'function') {
    const value = asHeaders.get(name);
    return value === null ? null : String(value);
  }
  const record = headers as Record<string, string>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === wanted) return String(record[key]);
  }
  return null;
}

/** One form field, or one file part, as a line that carries no bytes. */
function describePart(name: string, value: unknown): string {
  if (typeof value === 'string') return `${name}=${value}`;
  const part = value as { name?: unknown; type?: unknown; size?: unknown };
  const fileName = typeof part.name === 'string' && part.name !== '' ? part.name : '<unnamed>';
  const type = typeof part.type === 'string' && part.type !== '' ? part.type : '<unlabelled>';
  const size = typeof part.size === 'number' ? part.size : 0;
  return `${name}:<file name=${fileName} type=${type} size=${size}B>`;
}

/**
 * A request body as a comparable string, in whatever shape the wire sent it.
 *
 * WHY THIS IS NOT `typeof body === 'string' ? body : ''`. The multipart wire sends a `FormData`,
 * so that expression records its every request as an empty body — which silently disables the
 * golden-body reading, the hint readings and the redaction needle scan for that whole wire, all of
 * which would then pass by measuring nothing. The rendering below is a faithful account of a
 * `FormData`: the field names in order, the file part's name, container and SIZE, and never the
 * bytes. The size is what keeps the audio part measurable without putting the audio on the log
 * surface the redaction group scans.
 *
 * A body that is neither a string nor a `FormData` is still recorded as empty rather than guessed
 * at — a wire this board cannot render is one whose readings must not be invented.
 */
export function renderBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const parts: string[] = [];
    body.forEach((value, name) => {
      parts.push(describePart(String(name), value));
    });
    return parts.join('&');
  }
  return '';
}

function recordRequest(
  url: string,
  init: RequestInit | undefined,
  credentialHeader: string,
): RecordedRequest {
  const credential = headerOf(init, credentialHeader);
  return {
    method: String(init?.method ?? 'GET'),
    url,
    contentType: headerOf(init, 'content-type'),
    credential: credential === null || credential === '' ? 'absent' : 'present',
    body: renderBody(init?.body),
  };
}

/** The error an aborted fetch rejects with, built rather than read off a platform object. */
function abortError(): Error {
  const error = new Error('the request was aborted');
  error.name = 'AbortError';
  return error;
}

function responseFor(step: InvariantStep): Response {
  if (step.kind === 'json') {
    return new Response(JSON.stringify(step.payload), { status: step.status ?? 200 });
  }
  if (step.kind === 'raw') {
    return new Response(step.body, { status: step.status ?? 200 });
  }
  throw new Error('a reject step is answered by the transport, not by a response');
}

/**
 * The stub transport and the log of what it was asked to send.
 *
 * `credentialHeader` is the name the credential travels under ON THE WIRE THE CALLER IS MEASURING
 * (`AsrWireModel.credentialHeader`), passed in rather than looked up here: the transport is built
 * before a provider is named in some call sites, and the header name belongs to the wire model
 * either way.
 */
export function makeTransport(step: InvariantStep, credentialHeader: string): {
  fetchImpl: AsrInvocation['fetchImpl'];
  transport: RecordedTransport;
} {
  const transport: RecordedTransport = { calls: 0, requests: [] };
  const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
    transport.calls += 1;
    transport.requests.push(recordRequest(String(url), init, credentialHeader));
    if (step.kind === 'reject') {
      if (step.mode === 'transport') return Promise.reject(new Error('the transport is down'));
      // A timeout is the honest shape: the invocation's own signal aborts and the transport
      // rejects the way a real aborted fetch does, rather than a stub inventing an AbortError.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(abortError());
          return;
        }
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    }
    return Promise.resolve(responseFor(step));
  };
  return { fetchImpl: fetchImpl as unknown as AsrInvocation['fetchImpl'], transport };
}

/** The invocation the fixture runs under: everything the adapter needs, injected. */
export function invariantInvocation(overrides?: {
  apiKey?: string;
  baseUrl?: string;
  /** The model name, for the readings about a request whose body depends on it. */
  model?: string;
  signal?: AbortSignal;
}): AsrInvocation {
  const fixture = INVARIANT_FIXTURE;
  const signal =
    overrides !== undefined && overrides.signal !== undefined
      ? overrides.signal
      : new AbortController().signal;
  return {
    baseUrl:
      overrides !== undefined && overrides.baseUrl !== undefined ? overrides.baseUrl : fixture.baseUrl,
    apiKey:
      overrides !== undefined && overrides.apiKey !== undefined ? overrides.apiKey : fixture.apiKey,
    model: overrides !== undefined && overrides.model !== undefined ? overrides.model : fixture.model,
    timeoutMs: fixture.timeoutMs,
    // A signal is always supplied, so the adapter never has to reach for a platform timer to make
    // one; the timeout probe below is the abort that actually fires.
    signal,
    fetchImpl: (() => Promise.reject(new Error('no transport was injected'))) as unknown as AsrInvocation['fetchImpl'],
  };
}

type Driven = { result: AsrResult; transport: RecordedTransport };

/** The invocation fields a probe may vary: what the adapter is handed, never what it sends. */
type DriveOverrides = { apiKey?: string; baseUrl?: string; model?: string };

/**
 * Runs one transcription against a stub transport and keeps what it sent.
 *
 * The transport is built for the wire the PROVIDER declared, so the credential reading below is
 * taken from the header that wire authenticates with rather than from one name chosen here.
 */
async function drive(
  provider: AsrAdapter,
  request: AsrRequest,
  step: InvariantStep,
  invocationOverrides?: DriveOverrides,
): Promise<Driven> {
  const { fetchImpl, transport } = makeTransport(step, wireModelFor(provider).credentialHeader);
  const controller = new AbortController();
  const invocation = invariantInvocation({
    ...(invocationOverrides?.apiKey !== undefined ? { apiKey: invocationOverrides.apiKey } : {}),
    ...(invocationOverrides?.baseUrl !== undefined ? { baseUrl: invocationOverrides.baseUrl } : {}),
    ...(invocationOverrides?.model !== undefined ? { model: invocationOverrides.model } : {}),
    signal: controller.signal,
  });
  const pending = provider.transcribe(request, { ...invocation, fetchImpl });
  if (step.kind === 'reject' && step.mode === 'timeout') controller.abort();
  const result = await pending;
  return { result, transport };
}

// ── readings ─────────────────────────────────────────────────────────────────────────────────

function reading(
  group: InvariantGroupId,
  id: string,
  provider: string,
  observed: string,
  expected: string,
  detail: string,
): InvariantReading {
  return {
    group,
    id,
    provider,
    observed,
    expected,
    verdict: observed === expected ? 'pass' : 'fail',
    // The cause of a failure is the observed/expected pair, which every runner prints; repeating it
    // here would print it twice and put the disagreement in a string that a reader has to parse.
    detail,
  };
}

/** A result and the request count that produced it, as one comparable string. */
function outcome(result: AsrResult, requests: number): string {
  const head = result.ok ? `ok:${result.text}` : result.code;
  return `${head} requests=${requests}`;
}

/**
 * The body the declaration promises for the fixture, composed from recorded fragments.
 *
 * Composed rather than computed: a body builder called here would agree with itself. The
 * fragments are recorded constants and the only things read off the adapter are the declaration the
 * wire is supposed to follow and the model name the body depends on — so a provider whose body
 * disagrees with its own declaration reds.
 *
 * THE INSTRUCTION AND THE DECODE CONFIGURATION ARE PART OF THAT BODY, not decoration around it:
 * the adapter asks the service to transcribe verbatim in a text part of its own, and it configures
 * the decode (`temperature: 0`, plus a zero thinking budget on the 2.5 series). Both are request
 * bytes, both are counted by the request-level budget, so a golden body that omitted them would
 * score "the adapter stopped asking" as green.
 *
 * The 2.5-series branch is the recorded MODEL-NAME rule, written out here rather than imported from
 * the adapter's `thinkingBudgetApplies`: a board that derived its expectation from the function it
 * is measuring could not report that function changing.
 */
export function goldenBody(capabilities: AsrCapabilities, model: string): string {
  const instructionPart = `{"text":"${INVARIANT_INSTRUCTION}"}`;
  const audioPart = `{"inlineData":{"mimeType":"audio/webm","data":"${INVARIANT_AUDIO_TOKEN}"}}`;
  const contextPart = `{"text":"${INVARIANT_CONTEXT}"}`;
  const parts = capabilities.honors.context
    ? [instructionPart, audioPart, contextPart]
    : [instructionPart, audioPart];
  const generationConfig = model.startsWith('gemini-2.5')
    ? '{"temperature":0,"thinkingConfig":{"thinkingBudget":0}}'
    : '{"temperature":0}';
  const contents = `{"contents":[{"parts":[${parts.join(',')}]}],"generationConfig":${generationConfig}`;
  if (!capabilities.honors.prompt) return `${contents}}`;
  return `${contents},"systemInstruction":{"parts":[{"text":"${INVARIANT_PROMPT}"}]}}`;
}

/**
 * The peak a declared budget cannot be guessed at, only derived: base64 turns 3 bytes into 4, so
 * an audio of `ceil((budget + 1) / 4) * 3` bytes encodes to at least one byte past the budget.
 * Derived from the DECLARATION, which is why a declaration that shrinks or grows carries these
 * probes with it instead of leaving them silently on one side of the line.
 *
 * THIS IS THE `inline-json` DERIVATION, and it is named as one: on that wire the budget is spent by
 * the audio's ENCODING, so a raw byte length means nothing until it has been through the encoder.
 * A wire that carries the audio itself has the same pair derived in its own arithmetic, which is
 * why the models below own these two functions rather than the group calling them directly.
 */
export function overBudgetAudioBytes(budget: number): number {
  return Math.ceil((budget + 1) / 4) * 3;
}

/** An audio that leaves room for the request skeleton inside the budget, with a margin to spare. */
export function affordableAudioBytes(budget: number): number {
  return Math.floor((budget * 3) / 4) - 4096;
}

// ── the wire models ──────────────────────────────────────────────────────────────────────────

type PromptReading =
  | 'no-prompt-part'
  | 'empty-prompt-part'
  | 'prompt-part-present'
  | 'unexpected-prompt-text';

type ContextReading = 'text-part-present' | 'no-context-part' | 'unexpected-context-text';

/** The generation body's own vocabulary: a hint is read out of the JSON part that carries it. */
function inlinePromptPart(body: string): PromptReading {
  if (!body.includes('"systemInstruction"')) return 'no-prompt-part';
  if (body.includes('"text":""')) return 'empty-prompt-part';
  if (body.includes(`"text":"${INVARIANT_PROMPT}"`)) return 'prompt-part-present';
  return 'unexpected-prompt-text';
}

function inlineContextPart(body: string): ContextReading {
  if (body.includes(`"text":"${INVARIANT_CONTEXT}"`)) return 'text-part-present';
  return body.includes('"text":') ? 'unexpected-context-text' : 'no-context-part';
}

/**
 * A form field as `renderBody` wrote it. The rendered body is `name=value` parts joined by `&`,
 * which is unambiguous for the fixture's own values — none of them carries a separator.
 */
function fieldValue(body: string, name: string): string | null {
  const prefix = `${name}=`;
  for (const part of body.split('&')) {
    if (part.startsWith(prefix)) return part.slice(prefix.length);
  }
  return null;
}

/** The same two readings, read out of a form: the vocabulary is the wire's, the answer is not. */
function formPromptPart(body: string): PromptReading {
  const value = fieldValue(body, 'prompt');
  if (value === null) return 'no-prompt-part';
  if (value === '') return 'empty-prompt-part';
  return value === INVARIANT_PROMPT ? 'prompt-part-present' : 'unexpected-prompt-text';
}

function formContextPart(body: string): ContextReading {
  const value = fieldValue(body, 'context');
  if (value === null) return 'no-context-part';
  return value === INVARIANT_CONTEXT ? 'text-part-present' : 'unexpected-context-text';
}

/** The audio's file part as `renderBody` writes it: named, contained, sized — never its bytes. */
function formAudioPart(): string {
  return `file:<file name=${INVARIANT_FIXTURE.fileName} type=${INVARIANT_FIXTURE.mimeType} `
    + `size=${INVARIANT_AUDIO_TEXT.length}B>`;
}

/**
 * The multipart body the declaration promises, composed the same way the JSON one is: recorded
 * fragments plus the declaration. The audio part is carried as its size, so the golden body is a
 * statement about WHICH bytes travelled without the golden body carrying them.
 *
 * The model name is a parameter here too, for the same reason it is on the JSON body: it is a field
 * of the request, so a reading that varied it would otherwise be measuring a body this function
 * could not describe.
 */
function formGoldenBody(capabilities: AsrCapabilities, model: string): string {
  const parts = [formAudioPart(), `model=${model}`];
  if (capabilities.honors.prompt) parts.push(`prompt=${INVARIANT_PROMPT}`);
  if (capabilities.honors.context) parts.push(`context=${INVARIANT_CONTEXT}`);
  return parts.join('&');
}

// ── the chat-audio model's own readings ──────────────────────────────────────────────────────

/** The container the fixture's recording is in, as this wire's `format` field spells it. */
const CHAT_AUDIO_FORMAT = 'webm';

/**
 * The chat body the declaration promises for the fixture and `model`.
 *
 * IT IS SERIALISED FROM A LITERAL rather than composed as a string the way the two models above
 * are, and that is a difference in mechanism, not in what the reading asserts: this body is nested,
 * and a hand-composed nesting is a second JSON encoder whose escaping rules the board would have to
 * get right. What it is composed FROM is unchanged — recorded fragments, the model name the body
 * depends on, and the declaration — so it still cannot agree with the adapter by construction, and
 * the three positions the board cannot retype (the system turn, the task turn, the audio) arrive as
 * tokens the recorded body is canonicalised with.
 */
function chatGoldenBody(capabilities: AsrCapabilities, model: string): string {
  const parts: Record<string, unknown>[] = [
    {
      type: 'input_audio',
      input_audio: { data: INVARIANT_CHAT_AUDIO_URI, format: CHAT_AUDIO_FORMAT },
    },
    { type: 'text', text: INVARIANT_JSON_TASK_TOKEN },
  ];
  // A context placed in the system turn is part of the system string the board tokenises, so it
  // must NOT also appear as a user part here. The declaration says which position the adapter
  // promises; the recorded body is canonicalised into the same shape either way.
  if (capabilities.honors.context && capabilities.contextPlacement !== 'system') {
    parts.push({ type: 'text', text: INVARIANT_CONTEXT });
  }
  return JSON.stringify({
    model,
    // The decode parameters this provider's E condition was run at. Retyped rather than imported
    // from the adapter's `REASONING_EFFORT`, for the reason `INVARIANT_INSTRUCTION` gives.
    modalities: ['text'],
    stream: false,
    reasoning_effort: 'low',
    messages: [
      { role: 'system', content: INVARIANT_SYSTEM_TOKEN },
      { role: 'user', content: parts },
    ],
  });
}

/**
 * A prompt reading for the chat wire: the caller's own prompt is the needle.
 *
 * `empty-prompt-part` is unreachable here and deliberately not invented: this adapter's builder
 * takes no hints at all (its declaration is false on all three axes), so "sent, but empty" is not a
 * shape the wire can produce. Two of the four readings is the honest answer for it.
 */
function chatPromptPart(body: string): PromptReading {
  return body.includes(INVARIANT_PROMPT) ? 'prompt-part-present' : 'no-prompt-part';
}

function chatContextPart(body: string): ContextReading {
  return body.includes(INVARIANT_CONTEXT) ? 'text-part-present' : 'no-context-part';
}

/** The fixture's own bytes, base64-encoded, inside the data URI this wire carries them in. */
function chatAudioOnWire(body: string): 'match' | 'mismatch' {
  return body.includes(`data:audio/webm;base64,${INVARIANT_AUDIO_BASE64}`) ? 'match' : 'mismatch';
}

/**
 * The chat wire spends its budget on the audio's ENCODING, like the generation wire and unlike the
 * multipart one (see `overBudgetAudioBytes`), so the oversize size is the same derivation: the
 * encoded payload alone is already past the budget, and this wire adds a fixed data-URI prefix and
 * a larger skeleton on top of it.
 *
 * The affordable size leaves a wider margin than the generation wire's, and the margin is not
 * cosmetic: this skeleton is the larger one, so a derivation that left the generation wire's
 * 4 KiB — or none at all — would put the rejected and the accepted fixture on the same side of the
 * line and the group would measure one side twice.
 */
function chatOverBudgetAudioBytes(budget: number): number {
  return Math.ceil((budget + 1) / 4) * 3;
}

function chatAffordableAudioBytes(budget: number): number {
  return Math.floor((budget * 3) / 4) - 16384;
}

/** The answers each wire's service gives: a transcript, an empty answer, and no answer at all. */
export type AsrWireAnswers = {
  transcript: unknown;
  empty: unknown;
  /** A body that is not this service's answer: the shape both wires must refuse to read as text. */
  notAnAnswer: string;
  /**
   * The text `transcript` must reach the caller as.
   *
   * A field of its own because it is not the same string on every wire: the multipart and
   * generation answers ARE the transcription, while the chat wire's answer carries a transcript and
   * a REWRITE, and the adapter is expected to return the rewrite. Derived here from the same
   * recorded pair the answer was built from, so an expectation cannot drift from the payload it
   * describes.
   */
  transcriptText: string;
};

export type AsrWireModel = {
  wire: AsrWire;
  /** The URL the fixture's base URL and model resolve to on this wire — recorded, not re-derived. */
  endpoint: string;
  /** The Content-Type the request announces, or null when it announces none. */
  contentType: string | null;
  /**
   * The header this wire carries an API key in, lower-cased: `authorization` for the
   * OpenAI-compatible multipart shape, `x-goog-api-key` for the generation shape. Recorded per wire
   * rather than written once, because a board that read one name on both wires would report the
   * other as unauthenticated however correct the adapter was.
   */
  credentialHeader: string;
  /** The body the declaration promises for the fixture and `model`, with the audio as a token. */
  goldenBody(capabilities: AsrCapabilities, model: string): string;
  /** `match` when the recorded body carries the fixture's audio the way this wire carries it. */
  audioOnWire(body: string): 'match' | 'mismatch';
  promptPart(body: string): PromptReading;
  contextPart(body: string): ContextReading;
  answers: AsrWireAnswers;
  /** The audio sizes that straddle a declared budget IN THIS WIRE'S ARITHMETIC. */
  overBudgetAudioBytes(budget: number): number;
  affordableAudioBytes(budget: number): number;
};

/**
 * The two shapes a registered adapter may speak, each with the expectations it implies.
 *
 * Both are written out here rather than derived from the adapter, and that is deliberate: these
 * are the CLAIMS. An adapter is scored against the model its own declaration names, so a body that
 * contradicts the declared wire reds instead of quietly defining a third model nothing describes.
 */
const WIRE_MODELS: Record<AsrWire, AsrWireModel> = {
  'inline-json': {
    wire: 'inline-json',
    endpoint: INVARIANT_ENDPOINT,
    contentType: 'application/json',
    credentialHeader: 'x-goog-api-key',
    goldenBody,
    audioOnWire: (body) => (body.includes(`"data":"${INVARIANT_AUDIO_BASE64}"`) ? 'match' : 'mismatch'),
    promptPart: inlinePromptPart,
    contextPart: inlineContextPart,
    answers: {
      transcript: envelope(INVARIANT_TRANSCRIPT),
      empty: emptyEnvelope(),
      notAnAnswer: '<html>502 Bad Gateway</html>',
      transcriptText: INVARIANT_TRANSCRIPT,
    },
    overBudgetAudioBytes,
    affordableAudioBytes,
  },
  'chat-audio': {
    wire: 'chat-audio',
    endpoint: INVARIANT_CHAT_ENDPOINT,
    contentType: 'application/json',
    credentialHeader: 'authorization',
    goldenBody: chatGoldenBody,
    audioOnWire: chatAudioOnWire,
    promptPart: chatPromptPart,
    contextPart: chatContextPart,
    answers: {
      // The answer carries BOTH strings, and they differ: this is the wire whose adapter is
      // expected to return the rewrite, so the transcript alone is distinguishable from it.
      transcript: chatEnvelope(INVARIANT_TRANSCRIPT, INVARIANT_WRITTEN_INSTRUCTION),
      empty: chatEmptyEnvelope(),
      notAnAnswer: '<html>502 Bad Gateway</html>',
      transcriptText: INVARIANT_WRITTEN_INSTRUCTION,
    },
    overBudgetAudioBytes: chatOverBudgetAudioBytes,
    affordableAudioBytes: chatAffordableAudioBytes,
  },
  multipart: {
    wire: 'multipart',
    endpoint: INVARIANT_TRANSCRIPTION_ENDPOINT,
    contentType: null,
    credentialHeader: 'authorization',
    goldenBody: formGoldenBody,
    audioOnWire: (body) => (body.includes(formAudioPart()) ? 'match' : 'mismatch'),
    promptPart: formPromptPart,
    contextPart: formContextPart,
    answers: {
      transcript: { text: INVARIANT_TRANSCRIPT },
      empty: { text: '' },
      notAnAnswer: '<html>502 Bad Gateway</html>',
      transcriptText: INVARIANT_TRANSCRIPT,
    },
    overBudgetAudioBytes: (budget) => budget + 1,
    affordableAudioBytes: (budget) => Math.floor(budget * 0.75),
  },
};

/** The model an adapter is measured against: the wire it declared, or the contract's default. */
export function wireModelFor(provider: AsrAdapter): AsrWireModel {
  return WIRE_MODELS[provider.wire ?? 'inline-json'];
}

/**
 * The recorded body with the audio payload replaced by its token, so no reading carries bytes.
 *
 * A no-op on any wire that does not put the encoding in the body — the multipart rendering already
 * carries the audio as a size — which is why it is a per-model step rather than a shared one.
 */
function canonicaliseBody(body: string, model: AsrWireModel): string {
  if (model.wire === 'multipart') return body;
  if (model.wire === 'chat-audio') return chatCanonicaliseBody(body);
  return body.split(`"data":"${INVARIANT_AUDIO_BASE64}"`).join(`"data":"${INVARIANT_AUDIO_TOKEN}"`);
}

/**
 * The chat body with its three payloads replaced by their tokens: the system turn, the task turn
 * and the audio's data URI.
 *
 * A PARSE-AND-REPLACE rather than a substring substitution, and the difference is the reading: each
 * of the three sits at a position the golden body names, so replacing the audio's encoding wherever
 * it appeared would not say WHICH field carried it — a body that moved the audio into the text part
 * would be canonicalised into agreement with a golden body it no longer matches. The positions are
 * read off the parsed body and the replacements are then made textually (the whole quoted literal,
 * so a value that happened to be a substring of another field cannot be hit twice).
 *
 * A body that does not parse, or one whose messages are not the two this wire's declaration
 * promises, is returned as it stands: it then disagrees with the golden body, which is the red this
 * is here to produce rather than to hide.
 */
function chatCanonicaliseBody(body: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return body;
  }
  const messages = (decoded as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return body;

  let canonical = body;
  const system = (messages[0] as { content?: unknown } | undefined)?.content;
  if (typeof system === 'string') {
    canonical = replaceJsonLiteral(canonical, system, INVARIANT_SYSTEM_TOKEN);
  }

  const userParts = (messages[1] as { content?: unknown } | undefined)?.content;
  if (Array.isArray(userParts)) {
    for (const part of userParts) {
      const record = part as {
        type?: unknown;
        input_audio?: { data?: unknown };
        text?: unknown;
      } | null;
      if (record === null || typeof record !== 'object') continue;
      const audio = record.input_audio?.data;
      if (record.type === 'input_audio' && typeof audio === 'string') {
        canonical = replaceJsonLiteral(canonical, audio, INVARIANT_CHAT_AUDIO_URI);
      }
      if (record.type === 'text' && typeof record.text === 'string') {
        canonical = replaceJsonLiteral(canonical, record.text, INVARIANT_JSON_TASK_TOKEN);
      }
    }
  }
  return canonical;
}

/**
 * `value`'s JSON literal replaced by `token`'s, quoted forms on both sides so only a whole field
 * value can match.
 *
 * An empty `value` is left alone: its literal is `""`, which occurs wherever the body has an empty
 * string, and substituting those would rewrite a field the caller did not ask about.
 */
function replaceJsonLiteral(source: string, value: string, token: string): string {
  if (value === '') return source;
  return source.split(JSON.stringify(value)).join(JSON.stringify(token));
}

// ── group 1: request construction ────────────────────────────────────────────────────────────

/**
 * The model name the request body's decode configuration depends on: a 2.5-series model, which is
 * the series that takes a thinking budget. Named here rather than taken from the fixture because it
 * is an INPUT to a reading — the fixture's own model is deliberately not in that series, so the two
 * readings together show the body following the name instead of one branch being the only one ever
 * driven.
 */
const THINKING_MODEL = 'gemini-2.5-flash-lite';

/**
 * Whether this provider's transcription reaches a wire at all.
 *
 * THE DECLARATION'S OWN ANSWER, never a list of ids kept here. A provider that declares
 * `locality: 'remote'` sends its bytes to a service, and four of the five groups are statements
 * about the REQUEST it sends — its method, its URL, its headers, its body against a recorded golden
 * one, the statuses it reads back. A recogniser this process runs itself, over a pipe to a model
 * loaded in this host's memory, sends none: there is no method to read, no URL to compare, no
 * envelope to parse. Asking those questions anyway would score an absent request against a golden
 * body and report the absence as the defect, which is the fault this predicate exists to prevent.
 *
 * `'local-client'` COUNTS AS NO WIRE TOO, and for the same reason: a recogniser the BROWSER runs
 * reaches no wire from here either. The predicate is therefore "is it remote", not "is it local".
 *
 * Exported because the operator command and the unit suite both describe a provider's mode with it,
 * and a second definition of "reaches a wire" in either of those would be a second thing to keep in
 * step with the declaration.
 */
export function reachesAWire(provider: AsrAdapter): boolean {
  return provider.capabilities.locality === 'remote';
}

/**
 * What a no-wire provider answers a request its own guards ACCEPTED, in this harness.
 *
 * The board injects a transport and installs no engine, so the three groups that read "the request
 * went out" have for such a provider a different success reading: the guards passed, nothing was
 * sent, and the answer is the engine's own absence. Written once here rather than spelt out in each
 * of the three probes, because it is one reading — if the adapter's failure vocabulary or the
 * harness's engine-less state changed, three copies would drift and two of them would keep passing.
 */
const NO_WIRE_ACCEPTED = 'ENGINE_UNAVAILABLE requests=0';

/**
 * The size that is past `budget`, in the arithmetic a provider that reaches NO wire uses.
 *
 * WHY IT DIFFERS FROM `overBudgetAudioBytes`. That function derives its size from the wire's own
 * encoding — the inline-JSON wire spends the budget on base64 of the audio, so a size whose ENCODING
 * is past the line can still be well inside it as raw bytes. An adapter that reaches no wire never
 * encodes anything: it measures the bytes it is handed (see the provider's `measureRequestBytes`, and
 * the board reads the same rule it declares). Sizing such a request with the encoding's arithmetic
 * would hand it an audio its own guard correctly accepts, and the reading would report the guard
 * working as the guard failing.
 *
 * `budget + 1` rather than a fraction of it, so the case stays a one-byte margin — the tightest
 * reading available, and the one a guard that used `>=` instead of `>` would go red on.
 */
export function overBudgetLocalBytes(budget: number): number {
  return budget + 1;
}

/**
 * The largest audio comfortably inside `budget` for a provider that reaches no wire.
 *
 * Deliberately a margin rather than the exact bound: the case's job is to be a request the guard
 * must NOT refuse, and a size one byte under the line would make "the guard accepted it" and "the
 * guard has an off-by-one" the same reading.
 */
export function affordableLocalBytes(budget: number): number {
  return Math.max(1, budget - LOCAL_BUDGET_MARGIN_BYTES);
}

/** The slack `affordableLocalBytes` leaves under the declared budget. */
const LOCAL_BUDGET_MARGIN_BYTES = 4096;

/**
 * The context a no-wire provider's request carries when the board tests whether an UNACKNOWLEDGED
 * hint is counted against the budget.
 *
 * NOT `'x'.repeat(budget)`, which is what the remote branch uses: for a provider that reaches no
 * wire the hint's BYTES are the only thing that could matter, so a context larger than the margin
 * above is the whole of the reading, and a budget-sized string would be tens of megabytes of
 * transient allocation bought for nothing.
 */
const LOCAL_CONTEXT_TEXT = 'x'.repeat(LOCAL_BUDGET_MARGIN_BYTES * 2);

/** Everything the adapter was asked to send, per method, URL, headers and body. */
export async function probeRequestConstruction(provider: AsrAdapter): Promise<InvariantReading[]> {
  const group: InvariantGroupId = 'request-construction';
  const readings: InvariantReading[] = [];
  const capabilities = provider.capabilities;
  const model = wireModelFor(provider);
  const step: InvariantStep = { kind: 'json', payload: model.answers.transcript };

  const sent = await drive(provider, invariantRequest(), step);
  const first = sent.transport.requests[0];
  const body = first?.body ?? '';

  // A PROVIDER THAT REACHES NO WIRE GETS TWO READINGS, and they are the whole of what this group can
  // honestly say about it. Everything below is a statement about a request — and there is none. These
  // two are the invariants that survive the absence, and both are measured rather than asserted:
  //
  //   · the audio does not leave. The injected transport counts calls, so a provider that quietly
  //     POSTed the recording somewhere reds here — which is the entire promise `locality` makes.
  //   · the answer is the ENGINE's state, not a fabrication. With nothing installed on this host the
  //     adapter reports `ENGINE_UNAVAILABLE`; an adapter that returned `ok:` with text no model
  //     produced would red, and it is the one failure that would be invisible from the outside.
  //
  // The group is not left unmeasured for other providers by this early return: `groupVerdict` scores
  // the group over every provider that produced a reading for it.
  if (!reachesAWire(provider)) {
    readings.push(
      reading(group, `request.no-wire[${provider.id}]`, provider.id,
        String(sent.transport.calls), '0',
        'a recogniser this process runs itself reaches the injected transport zero times — the audio stays on this host, which is what its declared locality promises'),
      reading(group, `request.engine-owned-answer[${provider.id}]`, provider.id,
        outcome(sent.result, sent.transport.calls), 'ENGINE_UNAVAILABLE requests=0',
        'with no engine installed on this host the adapter answers with the engine\'s own absence rather than inventing a transcript or reaching for a wire it does not have'),
    );
    return readings;
  }

  readings.push(
    reading(group, `request.count[${provider.id}]`, provider.id, String(sent.transport.calls), '1',
      'one transcription sends exactly one request'),
    reading(group, `request.method[${provider.id}]`, provider.id, first?.method ?? 'no-request', 'POST',
      'the request is a POST'),
    reading(group, `request.url[${provider.id}]`, provider.id, first?.url ?? 'no-request', model.endpoint,
      'the base URL and the model compose the endpoint recorded for the wire the adapter declared'),
    reading(group, `request.content-type[${provider.id}]`, provider.id, first?.contentType ?? 'no-header',
      model.contentType ?? 'no-header',
      model.contentType === null
        // `no-header` is not "the adapter forgot": a multipart body's Content-Type carries the
        // boundary the transport generates, so the only correct announcement is none at all.
        ? 'this wire announces no Content-Type of its own; the multipart boundary is the transport\'s to name'
        : 'the body is announced as JSON'),
    reading(group, `request.credential[${provider.id}]`, provider.id, first?.credential ?? 'no-request',
      'present',
      `a configured credential reaches the wire in the header this wire authenticates with (${model.credentialHeader})`),
    reading(group, `request.body.golden[${provider.id}]`, provider.id, canonicaliseBody(body, model),
      model.goldenBody(capabilities, INVARIANT_FIXTURE.model),
      'the recorded request body as the wire renders it, with the audio carried as its token or its size and never as its bytes'),
    reading(group, `request.audio-encoding[${provider.id}]`, provider.id, model.audioOnWire(body), 'match',
      model.wire === 'multipart'
        ? `the audio travels as the fixture's own ${INVARIANT_AUDIO_TEXT.length} bytes, in a part naming ${INVARIANT_FIXTURE.fileName} and its container — the part IS the audio rather than a re-encoding of it`
        : `the encoded payload is the independently computed base64 of the fixture bytes (${INVARIANT_AUDIO_BASE64.length} characters)`),
    reading(group, `request.context.honored[${provider.id}]`, provider.id, model.contextPart(body),
      capabilities.honors.context ? 'text-part-present' : 'no-context-part',
      capabilities.honors.context
        ? 'the declaration acknowledges the context, so the context is on the wire — the positive control for hint handling'
        : 'the declaration does not acknowledge the context, so it is off the wire'),
    reading(group, `request.prompt.unsupported-omitted[${provider.id}]`, provider.id, model.promptPart(body),
      capabilities.honors.prompt ? 'prompt-part-present' : 'no-prompt-part',
      capabilities.honors.prompt
        ? 'the declaration acknowledges the prompt, so the prompt is on the wire'
        : 'a prompt the declaration does not acknowledge is left off the wire — not sent empty, not sent at all'),
  );

  // The credential is optional, so its ABSENCE has to be read too: a board that only ever saw a
  // configured key could not tell "the adapter omits an empty credential" from "the adapter always
  // writes one".
  const keyless = await drive(provider, invariantRequest(), step, { apiKey: '' });
  const trailingSlash = await drive(provider, invariantRequest(), step, {
    baseUrl: `${INVARIANT_BASE_URL}/`,
  });
  // The other half of the prompt rule, and the reason it needs its own reading: "not sent" and
  // "sent empty" are different behaviours that produce the same downstream effect, so an adapter
  // that forwarded an empty prompt would be indistinguishable from a correct one if only the
  // declared-unhonored case were measured.
  const emptyPrompt = await drive(provider, invariantRequest({ hints: { prompt: '' } }), step);
  // The same request at a model whose decode configuration differs. The fixture's model is not in
  // the 2.5 series, so without this reading the model-dependent half of the body would never be
  // driven at all: an adapter that asked every model for a thinking budget would pass everything
  // above, and the golden body's own model branch would be a claim nothing measured.
  const thinking = await drive(provider, invariantRequest(), step, { model: THINKING_MODEL });
  readings.push(
    reading(group, `request.credential-absent[${provider.id}]`, provider.id,
      keyless.transport.requests[0]?.credential ?? 'no-request', 'absent',
      'an empty credential is not announced rather than announced empty'),
    reading(group, `request.body.golden-2.5[${provider.id}]`, provider.id,
      canonicaliseBody(thinking.transport.requests[0]?.body ?? '', model),
      model.goldenBody(capabilities, THINKING_MODEL),
      `the same request at a ${THINKING_MODEL} model: the model name is an input to the body, so a series that takes a decode budget is asked for a budget of zero and every other model is sent no such field`),
    reading(group, `request.url-trailing-slash[${provider.id}]`, provider.id,
      trailingSlash.transport.requests[0]?.url ?? 'no-request', model.endpoint,
      'a base URL with a trailing slash joins the path with no doubled slash'),
    reading(group, `request.prompt.empty-hint-omitted[${provider.id}]`, provider.id,
      model.promptPart(emptyPrompt.transport.requests[0]?.body ?? ''), 'no-prompt-part',
      'an empty prompt is left off the wire rather than sent as an empty text part'),
  );

  return readings;
}

// ── group 2: error mapping ───────────────────────────────────────────────────────────────────

type ErrorScenario = { id: string; step: InvariantStep; expected: string; detail: string };

/** A code as the group compares it: the shape of a failed outcome, one request spent. */
function failedWith(code: AsrErrorCode): string {
  return `${code} requests=1`;
}

/**
 * Every way the transport can fail, and the semantic code each one must reach.
 *
 * THE POINT OF THE TABLE IS THAT THE CODES DIFFER — and that the differences are the ones the
 * vocabulary draws rather than the ones the status numbers suggest. Three groups: `401`/`403` are the
 * credential code, `429` the rate-limit code, and every other failure — the other 4xx, the 5xx, the
 * aborted request and the transport that never answered — is `UPSTREAM_UNAVAILABLE`. A board whose
 * rows all expected one code would pass on an adapter that collapsed everything onto it, which is
 * what the first two groups are here to prevent.
 *
 * WHY THE THIRD GROUP IS ONE CODE AND NOT THREE. A 5xx, a timeout and a refused connection are one
 * member of `AsrErrorCode` by construction: from this side of the seam the caller's remedy is the
 * same for all of them, and the browser's direct path and the server's proxy path have to answer one
 * upstream failure with one code. The rows are still four rather than one because each is a different
 * SHAPE reaching the adapter — a status, an abort, a rejection, a body that is not JSON — and it is
 * the shape, not the code, that a regression would break.
 *
 * Every row here reaches the transport, so every row spends exactly one request: the two guards
 * that refuse BEFORE the transport are the size and mime groups' subject, not this one's.
 *
 * THE ANSWER-SHAPED ROWS ARE BUILT PER WIRE. A status is a status on any wire, so those rows are
 * shared; an "answer with no text" is not, because what counts as an answer differs — a generation
 * envelope with no text part on one wire, the transcription envelope's empty string on the other.
 * Handing one wire's payload to the other would red the row for a reason that has nothing to do
 * with error mapping.
 */
export function errorScenarios(wire: AsrWire): ErrorScenario[] {
  const answers = WIRE_MODELS[wire].answers;
  return [
    { id: 'error.status-401', step: { kind: 'json', status: 401, payload: { error: 'unauthorized' } }, expected: failedWith('UNAUTHORIZED'), detail: 'a rejected credential is its own code' },
    { id: 'error.status-403', step: { kind: 'json', status: 403, payload: { error: 'forbidden' } }, expected: failedWith('UNAUTHORIZED'), detail: 'a forbidden credential is the credential code, not a generic upstream failure' },
    { id: 'error.status-429', step: { kind: 'json', status: 429, payload: { error: 'slow down' } }, expected: failedWith('RATE_LIMITED'), detail: 'a throttled upstream is its own code, because the caller retries it differently' },
    { id: 'error.status-500', step: { kind: 'json', status: 500, payload: { error: 'boom' } }, expected: failedWith('UPSTREAM_UNAVAILABLE'), detail: 'an upstream fault is the upstream-unavailable code' },
    { id: 'error.status-503', step: { kind: 'json', status: 503, payload: { error: 'unavailable' } }, expected: failedWith('UPSTREAM_UNAVAILABLE'), detail: 'an unavailable upstream follows the same rule as any other 5xx' },
    { id: 'error.status-400', step: { kind: 'json', status: 400, payload: { error: 'bad request' } }, expected: failedWith('UPSTREAM_UNAVAILABLE'), detail: 'a request the upstream rejects is not the credential code' },
    { id: 'error.transport', step: { kind: 'reject', mode: 'transport' }, expected: failedWith('UPSTREAM_UNAVAILABLE'), detail: 'a transport that never answered is an unavailable upstream, the same code a 5xx reaches' },
    { id: 'error.timeout', step: { kind: 'reject', mode: 'timeout' }, expected: failedWith('UPSTREAM_UNAVAILABLE'), detail: 'an aborted request is an unavailable upstream too, and is read from the abort rather than from any status' },
    { id: 'error.body-not-json', step: { kind: 'raw', body: answers.notAnAnswer }, expected: failedWith('UPSTREAM_UNAVAILABLE'), detail: 'a gateway page is neither a transcript nor a crash' },
    { id: 'error.envelope-without-text', step: { kind: 'json', payload: answers.empty }, expected: failedWith('NO_SPEECH_DETECTED'), detail: 'an answer carrying no text is an empty answer, not a success with empty text' },
    { id: 'error.transcript-arrives', step: { kind: 'json', payload: answers.transcript }, expected: `ok:${answers.transcriptText} requests=1`, detail: 'a well-formed answer reaches the caller as its text, in one request — on a wire whose answer carries two strings, the one the caller must receive is the wire model\'s own `transcriptText`, not whichever field happened to arrive first' },
  ];
}

/**
 * One reading per failure shape, so "the error mapping changed" reads as which row moved.
 *
 * A PROVIDER THAT REACHES NO WIRE PRODUCES NO READING HERE, deliberately, and the group is not left
 * unmeasured by it: `groupVerdict` scores a group over every provider that answered for it, so the
 * remote rows carry this one. Every scenario in the table below is a STATUS or a transport fault
 * read back off a wire — a 401, an aborted request, a gateway page — and a recogniser reached over a
 * pipe has none of them. Driving the table anyway would hand a status to a provider that never reads
 * one and score the resulting absence against `failedWith(code)`, which would print eleven reds for
 * the shape of a seam rather than for a defect in it.
 */
export async function probeErrorMapping(provider: AsrAdapter): Promise<InvariantReading[]> {
  const group: InvariantGroupId = 'error-mapping';
  const readings: InvariantReading[] = [];
  if (!reachesAWire(provider)) return readings;
  for (const scenario of errorScenarios(wireModelFor(provider).wire)) {
    const driven = await drive(provider, invariantRequest(), scenario.step);
    readings.push(
      reading(group, `${scenario.id}[${provider.id}]`, provider.id,
        outcome(driven.result, driven.transport.calls), scenario.expected, scenario.detail),
    );
  }
  return readings;
}

// ── group 3: size layering ───────────────────────────────────────────────────────────────────

/**
 * The declared budget decides who is refused, and a refusal costs no request at all.
 *
 * WHAT THE BUDGET IS SPENT BY DEPENDS ON THE WIRE, and the two sizes are therefore derived per
 * model rather than from one arithmetic: the `inline-json` wire spends the budget on the audio's
 * ENCODING (base64 of n bytes is `ceil(n / 3) * 4` characters), while the multipart wire spends it
 * on the audio's own bytes. A single derivation would leave one of the two wires with both sizes on
 * the same side of the line — the group would still print four readings and measure three sides of
 * nothing.
 */
export async function probeSizeLayering(provider: AsrAdapter): Promise<InvariantReading[]> {
  const group: InvariantGroupId = 'size-layering';
  const readings: InvariantReading[] = [];
  const capabilities = provider.capabilities;
  const model = wireModelFor(provider);
  const budget = capabilities.maxInlineRequestBytes;
  const step: InvariantStep = { kind: 'json', payload: model.answers.transcript };

  // THE TWO SIZES ARE DERIVED FROM WHAT THE BUDGET IS SPENT BY, which is the third case of the same
  // distinction the wire models already draw between encoding and bytes: a provider that reaches no
  // wire spends the budget on the bytes it is handed, so the wire's own encoding arithmetic would
  // size `overBudget` at three quarters of the budget — an audio its guard correctly accepts — and
  // the reading would report the guard working as the guard failing.
  const reachesTransport = reachesAWire(provider);
  const affordable = reachesTransport ? model.affordableAudioBytes(budget) : affordableLocalBytes(budget);
  const overBudget = reachesTransport ? model.overBudgetAudioBytes(budget) : overBudgetLocalBytes(budget);
  const spentBy = reachesTransport && model.wire !== 'multipart' ? 'encodes' : 'measures';

  const oversize = await drive(provider, invariantRequest({ bytes: new Uint8Array(overBudget), hints: {} }), step);
  const fitting = await drive(provider, invariantRequest({ bytes: new Uint8Array(affordable), hints: {} }), step);
  const pushedOver = await drive(
    provider,
    invariantRequest({
      bytes: new Uint8Array(affordable),
      hints: { context: reachesTransport ? 'x'.repeat(budget) : LOCAL_CONTEXT_TEXT },
    }),
    step,
  );

  // The context case is the group's one HONORS-AWARE expectation, and it is the same invariant read
  // from both sides of the declaration. A declaration that acknowledges the context has it counted,
  // so a long one is what pushes an otherwise-affordable audio over. A declaration that does not
  // acknowledges nothing, so the same audio must go out UNCHANGED — a budget that counted a hint
  // the adapter never sends would refuse an upload the service would have accepted.
  const accepted = reachesTransport ? `ok:${model.answers.transcriptText} requests=1` : NO_WIRE_ACCEPTED;
  const pushedOverExpected = capabilities.honors.context ? 'OVERSIZE requests=0' : accepted;

  readings.push(
    reading(group, `size.oversize-declared[${provider.id}]`, provider.id, capabilities.oversize, 'reject',
      'the first version declares rejection as the only oversize policy'),
    reading(group, `size.audio-alone-over-limit[${provider.id}]`, provider.id,
      outcome(oversize.result, oversize.transport.calls), `OVERSIZE requests=0`,
      reachesTransport
        ? `an audio of ${overBudget} B ${spentBy} past the declared ${budget} B budget: refused, and with zero requests the audio was never put on the wire`
        : `an audio of ${overBudget} B ${spentBy} one byte past the declared ${budget} B budget: refused by the adapter's own guard, and with zero requests nothing was handed to the engine — this recogniser sets the ceiling itself rather than publishing a service's`),
    reading(group, `size.audio-alone-affordable[${provider.id}]`, provider.id,
      outcome(fitting.result, fitting.transport.calls), accepted,
      `an audio of ${affordable} B ${spentBy} inside the declared ${budget} B budget: ${reachesTransport ? 'sent' : 'past the guard'} — the guard is a line, not a wall`),
    reading(group, `size.context-pushes-over-limit[${provider.id}]`, provider.id,
      outcome(pushedOver.result, pushedOver.transport.calls), pushedOverExpected,
      capabilities.honors.context
        ? 'the SAME audio as the accepted case, plus a long context: the budget is the whole request, so the context is what pushed it over'
        : 'the SAME audio, plus a long context the declaration does not acknowledge: the context is not on the wire and not counted against the budget, so the request goes out as it would have without it'),
  );

  return readings;
}

// ── group 4: redaction ───────────────────────────────────────────────────────────────────────

/** A needle's shape inside a scanned line, so a finding can be reported without printing it. */
export type NeedleHit = { line: number; needle: string };

/**
 * The needles the answer surface must not carry: the credential, the audio's own bytes, and the
 * audio's encoding as it is written on the wire.
 *
 * Both payload needles are RECORDED CONSTANTS, computed independently of the adapter
 * (`python3 -c "import base64; print(base64.b64encode(...))"`). Deriving them from the recorded
 * request body instead would defeat the purpose twice over: a scanner that re-uses the adapter's
 * encoder agrees with it by construction and so cannot report it as wrong, and the body's shape is
 * not a source of needles at all — a long JSON field name is indistinguishable from a payload
 * token, so a heuristic over the body reports structural names (`systemInstruction`, 17
 * characters, is a legal base64 run) as leaks. The audio reading in the request-construction group
 * is what pins the wire's payload against these same constants — the encoding against the base64
 * one on a wire that carries the encoding, the part naming the fixture's bytes on a wire that
 * carries the bytes themselves.
 */
export function redactionNeedles(): { credential: string; payload: string[] } {
  return { credential: INVARIANT_API_KEY, payload: [INVARIANT_AUDIO_TEXT, INVARIANT_AUDIO_BASE64] };
}

/** Where each needle was found, position only: naming the line would quote the leak. */
export function scanLines(lines: string[], needles: string[]): NeedleHit[] {
  const hits: NeedleHit[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    for (const needle of needles) {
      if (needle.length > 0 && lines[index].includes(needle)) hits.push({ line: index, needle });
    }
  }
  return hits;
}

/** `<n> line(s), first at line <i>` — never the matched text. */
function describeHits(hits: NeedleHit[]): string {
  if (hits.length === 0) return 'absent';
  return `leaked(${hits.length} hit(s), first at line ${hits[0].line})`;
}

/**
 * The credential and the audio must not come back out of the answer surface.
 *
 * The scanner is shown to fire before it is trusted: a planted credential and a planted payload
 * token are both required to be found, and a clean line is required to produce nothing. Without
 * that pair, "no leaks found" and "the scanner cannot find anything" are the same reading.
 */
export async function probeRedaction(provider: AsrAdapter): Promise<InvariantReading[]> {
  const group: InvariantGroupId = 'redaction';
  const readings: InvariantReading[] = [];
  const model = wireModelFor(provider);
  const step: InvariantStep = { kind: 'json', payload: model.answers.transcript };

  const sent = await drive(provider, invariantRequest(), step);
  const body = sent.transport.requests[0]?.body ?? '';
  const needles = redactionNeedles();

  const plantedCredential = [`the adapter said ${INVARIANT_API_KEY} out loud`];
  const plantedPayload = [`the adapter said ${INVARIANT_AUDIO_BASE64} out loud`];
  const clean = ['the adapter said nothing it should not have'];

  readings.push(
    reading(group, `redaction.scan.detects-planted-credential[${provider.id}]`, provider.id,
      scanLines(plantedCredential, [needles.credential]).length > 0 ? 'detects' : 'misses', 'detects',
      'a planted credential is found — the scanner is not a function that always returns clean'),
    reading(group, `redaction.scan.detects-planted-payload[${provider.id}]`, provider.id,
      scanLines(plantedPayload, needles.payload).length > 0 ? 'detects' : 'misses', 'detects',
      'a planted payload token is found — the scanner is not a function that always returns clean'),
    reading(group, `redaction.scan.ignores-clean-line[${provider.id}]`, provider.id,
      scanLines(clean, [needles.credential, ...needles.payload]).length === 0 ? 'clean' : 'false-positive',
      'clean', 'a line carrying neither needle is reported as carrying neither'),
  );

  // The two results below are the surfaces a leak would appear on, and the two readings above them
  // are what make their absence meaningful: the request DID carry both, so "not in the answer" is
  // a discrimination rather than a statement about a credential that was never used.
  //
  // FOR A PROVIDER THAT REACHES NO WIRE THE CONTROL IS A STRONGER STATEMENT RATHER THAN A MISSING
  // ONE. There is no request to carry a credential and no body to carry the audio, so read as
  // `present`/`match` these two would red for the shape of the seam. Read as what the declaration
  // actually promises — no credential on any request, and zero departures from this host — they are
  // the reading that a recogniser claiming `locality: 'local-server'` keeps the audio where it says
  // it does, and they still discriminate: an adapter that POSTed the bytes somewhere would read a
  // wire call count above zero here.
  readings.push(
    reading(group, `redaction.credential.reaches-the-wire[${provider.id}]`, provider.id,
      sent.transport.requests[0]?.credential ?? 'no-request',
      reachesAWire(provider) ? 'present' : 'no-request',
      reachesAWire(provider)
        ? `the credential is on the request, in the header this wire declares (${model.credentialHeader}), so its absence from the answer surface says something`
        : 'this recogniser declares no credential fields at all, and the reading is that the fixture\'s credential reaches no request — a provider that put one on a request would red here'),
    reading(group, `redaction.payload.reaches-the-wire[${provider.id}]`, provider.id,
      reachesAWire(provider) ? model.audioOnWire(body) : String(sent.transport.calls),
      reachesAWire(provider) ? 'match' : '0',
      reachesAWire(provider)
        ? 'the audio is on the request in the shape the declared wire carries it, so its absence from the answer surface says something'
        : 'the audio leaves this host zero times: the bytes go to a process on this machine, and the injected transport — the only way out of this module — is never called'),
  );

  const scenarios: InvariantStep[] = [
    step,
    { kind: 'json', status: 500, payload: { error: 'boom' } },
    { kind: 'json', status: 429, payload: { error: 'slow down' } },
    { kind: 'reject', mode: 'transport' },
    { kind: 'reject', mode: 'timeout' },
  ];
  const results: string[] = [];
  const messages: string[] = [];
  for (const scenario of scenarios) {
    const driven = await drive(provider, invariantRequest(), scenario);
    results.push(JSON.stringify(driven.result));
    if (!driven.result.ok) messages.push(driven.result.message);
  }

  const credentialHits = (lines: string[]) => describeHits(scanLines(lines, [needles.credential]));
  const payloadHits = (lines: string[]) => describeHits(scanLines(lines, needles.payload));

  readings.push(
    reading(group, `redaction.credential.absent-from-result[${provider.id}]`, provider.id, credentialHits(results), 'absent',
      'no returned result carries the credential'),
    reading(group, `redaction.credential.absent-from-message[${provider.id}]`, provider.id, credentialHits(messages), 'absent',
      'no failure message carries the credential'),
    reading(group, `redaction.payload.absent-from-result[${provider.id}]`, provider.id, payloadHits(results), 'absent',
      'no returned result carries the audio or its encoding'),
    reading(group, `redaction.payload.absent-from-message[${provider.id}]`, provider.id, payloadHits(messages), 'absent',
      'no failure message carries the audio or its encoding'),
  );

  return readings;
}

/**
 * The log surface, scanned after the rest of the board has been written down.
 *
 * It runs as its own probe because it needs something no other probe has: the lines themselves.
 * The lines it produces are the only ones not covered by it, which is why they report a count and a
 * line number and never the text they matched.
 */
export async function probeLogRedaction(
  provider: AsrAdapter,
  lines: string[],
  needles: { credential: string; payload: string[] },
): Promise<InvariantReading[]> {
  const group: InvariantGroupId = 'redaction';
  return [
    reading(group, `redaction.log-lines-present[${provider.id}]`, provider.id,
      lines.length > 0 ? 'lines-present' : 'no-lines', 'lines-present',
      'the board printed lines to scan — an empty log surface is not a clean one'),
    reading(group, `redaction.credential.absent-from-logs[${provider.id}]`, provider.id,
      describeHits(scanLines(lines, [needles.credential])), 'absent',
      'no printed line carries the credential'),
    reading(group, `redaction.payload.absent-from-logs[${provider.id}]`, provider.id,
      describeHits(scanLines(lines, needles.payload)), 'absent',
      'no printed line carries the audio or its encoding'),
  ];
}

// ── group 5: mime gate ───────────────────────────────────────────────────────────────────────

/** An undeclared container is refused before a request exists, not after the service rejects it. */
export async function probeMimeGate(provider: AsrAdapter): Promise<InvariantReading[]> {
  const group: InvariantGroupId = 'mime-gate';
  const readings: InvariantReading[] = [];
  const model = wireModelFor(provider);
  const step: InvariantStep = { kind: 'json', payload: model.answers.transcript };

  // THE TWO ACCEPT ROWS ARE THE SAME INVARIANT ON BOTH KINDS OF PROVIDER — the gate let a declared
  // base type through — and only the SUCCESS they lead to differs: a wire sends it and answers with
  // text, a recogniser this process runs answers with the engine's absence. The two REJECT rows need
  // no such distinction: a refusal is a refusal, and it costs zero requests on every provider.
  const accepted = reachesAWire(provider) ? `ok:${model.answers.transcriptText} requests=1` : NO_WIRE_ACCEPTED;

  const withParameters = await drive(provider, invariantRequest({ mimeType: 'audio/webm;codecs=opus' }), step);
  const upperCase = await drive(provider, invariantRequest({ mimeType: 'AUDIO/WEBM' }), step);
  const outside = await drive(provider, invariantRequest({ mimeType: 'audio/x-m4a' }), step);
  const unset = await drive(provider, invariantRequest({ mimeType: 'application/octet-stream' }), step);

  readings.push(
    reading(group, `mime.accept.base-type-with-parameters[${provider.id}]`, provider.id,
      outcome(withParameters.result, withParameters.transport.calls), accepted,
      'a declared base type carrying parameters is accepted, so the gate matches the base type'),
    reading(group, `mime.accept.case-insensitive-base-type[${provider.id}]`, provider.id,
      outcome(upperCase.result, upperCase.transport.calls), accepted,
      'the base type is matched case-insensitively'),
    reading(group, `mime.reject.outside-declaration[${provider.id}]`, provider.id,
      outcome(outside.result, outside.transport.calls), 'UNSUPPORTED_MIME requests=0',
      'a container outside the declaration is refused with no request, so nothing undeclared is ever uploaded'),
    reading(group, `mime.reject.unset-container[${provider.id}]`, provider.id,
      outcome(unset.result, unset.transport.calls), 'UNSUPPORTED_MIME requests=0',
      'an unset container is refused rather than sent as a guess — a declaration that listed `application/octet-stream` would turn "the client did not say" into a container the recogniser claims to know'),
  );

  const declared = provider.capabilities.acceptsMime;
  const parameterised = declared.filter((entry) => entry.indexOf(';') !== -1);
  readings.push(
    reading(group, `mime.declared-set-holds-base-types[${provider.id}]`, provider.id,
      parameterised.length === 0 ? 'base-types-only' : `parameters-in-declaration(${parameterised.length})`,
      'base-types-only',
      'every declared entry is a base type: an entry carrying parameters could never match a stripped input, so it could never fire'),
  );

  return readings;
}

// ── the token contract ───────────────────────────────────────────────────────────────────────

/**
 * One disagreement between a recogniser's per-token declaration and a result it produced.
 *
 * `probe` is stable across runs (the field and, where it is per-item, the token index); `detail` is
 * the sentence a reader gets when it disagrees.
 */
export type TokenInvariantViolation = { probe: string; detail: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The per-token declaration, checked against one success result.
 *
 * The pair is the contract: a declaration is a PROMISE about every result the recogniser produces,
 * so it is asked of each result rather than of the declaration alone. Returned as a list rather
 * than thrown, so a caller can report every disagreement instead of the first one;
 * `assertTokenInvariants` is the throwing face for a caller that wants the check as a gate.
 *
 * The readings, and what each one is the negation of:
 *   · declared confidence ⇒ the result carries tokens, else a caller that ranks by confidence has
 *     nothing to rank;
 *   · declared confidence ⇒ every token's `confidence` is a finite number in `[0, 1]`, else a
 *     caller comparing two confidences could be comparing a number against `NaN`;
 *   · declared timestamps ⇒ every token's `startMs` is a finite, non-negative number;
 *   · declared `false` ⇒ NO token carries that field, which is the half a permissive check drops:
 *     an adapter that declares `false` and emits a confidence anyway has told a caller to ignore a
 *     field that is really there.
 */
export function tokenInvariantViolations(
  capabilities: AsrCapabilities,
  result: AsrSuccess,
): TokenInvariantViolation[] {
  const violations: TokenInvariantViolation[] = [];
  const declared = capabilities.tokens;
  const tokens: AsrToken[] | undefined = result.tokens;

  if (declared.confidence && !Array.isArray(tokens)) {
    violations.push({
      probe: 'tokens-present-when-confidence-declared',
      detail: 'the declaration promises a confidence per token but the success result carries no tokens',
    });
  }
  if (declared.timestamps && !Array.isArray(tokens)) {
    violations.push({
      probe: 'tokens-present-when-timestamps-declared',
      detail: 'the declaration promises a start time per token but the success result carries no tokens',
    });
  }
  if (!Array.isArray(tokens)) return violations;

  tokens.forEach((token, index) => {
    if (declared.confidence) {
      if (!isFiniteNumber(token.confidence) || token.confidence < 0 || token.confidence > 1) {
        violations.push({
          probe: `confidence-in-range[${index}]`,
          detail: `token ${index} confidence is ${String(token.confidence)}, not a finite number in [0, 1]`,
        });
      }
    } else if (token.confidence !== undefined) {
      violations.push({
        probe: `confidence-undeclared[${index}]`,
        detail: `token ${index} carries a confidence while the declaration says this recogniser produces none`,
      });
    }

    if (declared.timestamps) {
      if (!isFiniteNumber(token.startMs) || token.startMs < 0) {
        violations.push({
          probe: `start-ms-non-negative[${index}]`,
          detail: `token ${index} startMs is ${String(token.startMs)}, not a finite non-negative number`,
        });
      }
    } else if (token.startMs !== undefined) {
      violations.push({
        probe: `start-ms-undeclared[${index}]`,
        detail: `token ${index} carries a startMs while the declaration says this recogniser produces none`,
      });
    }
  });

  return violations;
}

/** The throwing face: a gate for a caller that wants the check to stop it rather than inform it. */
export function assertTokenInvariants(capabilities: AsrCapabilities, result: AsrSuccess): void {
  const violations = tokenInvariantViolations(capabilities, result);
  if (violations.length === 0) return;
  const detail = violations.map((entry) => `${entry.probe} (${entry.detail})`).join('; ');
  throw new Error(`token invariants violated for '${result.providerId}': ${detail}`);
}

/**
 * The board's reading for the token contract.
 *
 * WHAT IT CAN AND CANNOT SEE FROM THE REGISTRY. The three hosted recognisers declare `false/false`
 * and the on-host one declares `true/true`, so both sides of the declaration are reachable here and
 * the probe must therefore build its agreement case from the declaration rather than assuming the
 * token-less shape — a token-less result is the RED for a recogniser that promises a confidence, not
 * a neutral input. What is still measured only in the unit suite
 * (`src/shared/asr/tests/asrContractInvariants.test.ts`) is a real `transcribe` driven over a
 * stand-in whose declared tokens and returned tokens disagree: this probe reads the DECLARATION
 * against a result of the shape it promises, not an engine's actual output, which needs the engine.
 * So what reds here is a declaration that went missing or malformed, a locality outside the
 * vocabulary, and a declaration the invariant itself cannot satisfy.
 */
export async function probeTokenContract(provider: AsrAdapter): Promise<InvariantReading[]> {
  const group: InvariantGroupId = 'token-contract';
  const declared = provider.capabilities.tokens;
  const shape =
    declared !== undefined &&
    typeof declared.confidence === 'boolean' &&
    typeof declared.timestamps === 'boolean'
      ? 'booleans'
      : 'malformed';
  const locality = provider.capabilities.locality;
  const knownLocality =
    locality === 'remote' || locality === 'local-server' || locality === 'local-client'
      ? locality
      : 'unknown';

  // The success this declaration promises, ASSEMBLED FROM THE DECLARATION — tokens when either
  // per-token fact is promised, and on each token exactly the fields that are promised. Absence
  // rather than `undefined` for the promised-false case, because the invariant's second half is
  // precisely "a token that carries a field the declaration says the recogniser does not produce",
  // and a key present with the value `undefined` is a different object from one that is not there.
  //
  // THE VALUES SIT ON THE BOUNDARIES THE INVARIANT DRAWS — `startMs: 0`, which is the smallest
  // non-negative start, and `confidence: 1`, the top of `[0, 1]` — so a declared range that quietly
  // became exclusive at either end would red on this reading rather than on nothing.
  const promised: AsrToken[] =
    declared.confidence || declared.timestamps
      ? [
          {
            text: INVARIANT_TRANSCRIPT,
            ...(declared.confidence ? { confidence: 1 } : {}),
            ...(declared.timestamps ? { startMs: 0 } : {}),
          },
        ]
      : [];
  const asPromised: AsrSuccess = {
    ok: true,
    text: INVARIANT_TRANSCRIPT,
    style: provider.capabilities.style,
    transformations: [],
    providerId: provider.id,
    ...(promised.length === 0 ? {} : { tokens: promised }),
  };
  const agreement =
    tokenInvariantViolations(provider.capabilities, asPromised).length === 0 ? 'consistent' : 'inconsistent';

  // Named from the two booleans so the printed detail says which fields the promise was about, and
  // says it in the declaration's own terms rather than by describing the object built above.
  const promisedFields = [
    declared.confidence ? 'confidence' : null,
    declared.timestamps ? 'startMs' : null,
  ].filter((field): field is string => field !== null);
  const promisedShape =
    promised.length === 0
      ? 'no tokens'
      : `one token carrying exactly ${promisedFields.join(' and ')}`;

  return [
    reading(group, `token-contract.declaration[${provider.id}]`, provider.id, shape, 'booleans',
      'the declaration names both per-token facts as booleans'),
    reading(group, `token-contract.locality[${provider.id}]`, provider.id, knownLocality, locality,
      'the declaration names a locality from the vocabulary'),
    reading(group, `token-contract.result-agrees[${provider.id}]`, provider.id, agreement, 'consistent',
      `a success result of the shape this declaration promises — ${promisedShape}, at the boundary of each declared range — satisfies the invariant it declares`),
  ];
}

// ── the board ────────────────────────────────────────────────────────────────────────────────

export type InvariantRunOptions = {
  /** The adapters to measure: every provider the registry hands out. */
  providers: readonly AsrAdapter[];
  /** Narrow the board. A narrowed board is scored against the groups it ran, never the others. */
  groups?: readonly InvariantGroupId[];
};

/** The runners' line for one reading: id, value and — on a failure — the disagreement. */
function lineFor(entry: InvariantReading): string {
  const mark = entry.verdict === 'fail' ? 'FAIL' : 'ok';
  return `${mark} ${entry.id} observed=${entry.observed} expected=${entry.expected} — ${entry.detail}`;
}

function groupVerdict(
  group: InvariantGroupId,
  readings: InvariantReading[],
): InvariantGroupVerdict {
  const own = readings.filter((entry) => entry.group === group);
  const failing = own.filter((entry) => entry.verdict === 'fail').map((entry) => entry.id);
  return {
    group,
    verdict: own.length === 0 ? 'unmeasured' : failing.length > 0 ? 'fail' : 'pass',
    readings: own.length,
    failing,
  };
}

/**
 * Runs the selected groups against every provider.
 *
 * Three properties are load-bearing here:
 *   · a provider list of zero is `empty`, never `pass` — the empty reading is a verdict with its
 *     own name;
 *   · a probe that throws is a red reading in its own group rather than an exception that takes the
 *     whole board down, because a board that cannot report is a board that cannot be trusted;
 *   · the log surface is scanned by a probe that runs last, so it sees every line the other probes
 *     produced.
 */
export async function runAsrContractInvariants(
  options: InvariantRunOptions,
): Promise<InvariantReport> {
  const providers = options.providers;
  const selected: InvariantGroupId[] =
    options.groups === undefined ? [...INVARIANT_GROUP_IDS] : [...options.groups];

  if (providers.length === 0) {
    const groups = selected.map((group) => ({
      group,
      verdict: 'unmeasured' as const,
      readings: 0,
      failing: [] as string[],
    }));
    return { verdict: 'empty', groups, readings: [], logs: [] };
  }

  const readings: InvariantReading[] = [];
  for (const group of selected) {
    if (group === 'redaction') continue;
    for (const provider of providers) {
      try {
        readings.push(...(await PROBES[group](provider)));
      } catch (error) {
        readings.push(
          reading(group, `${group}.probe-threw[${provider.id}]`, provider.id, reasonFor(error),
            'the probe completes', 'the probe threw instead of measuring, so this group is red'),
        );
      }
    }
  }

  const redactionSelected = selected.indexOf('redaction') !== -1;
  if (redactionSelected) {
    for (const provider of providers) {
      try {
        readings.push(...(await probeRedaction(provider)));
      } catch (error) {
        readings.push(
          reading('redaction', `redaction.probe-threw[${provider.id}]`, provider.id, reasonFor(error),
            'the probe completes', 'the probe threw instead of measuring, so this group is red'),
        );
      }
    }
    // Second phase: the lines only exist once every behavioural probe has written its readings
    // down, so the log surface is scanned by a probe that runs after them. The three readings it
    // adds are the only lines it cannot cover, which is why they report a count and a line number
    // and never the text they matched.
    const provisional = readings.map(lineFor);
    const needles = redactionNeedles();
    for (const provider of providers) {
      readings.push(...(await probeLogRedaction(provider, provisional, needles)));
    }
  }

  const logs = readings.map(lineFor);
  const groups = selected.map((group) => groupVerdict(group, readings));
  const failing = readings.filter((entry) => entry.verdict === 'fail').length;
  const unmeasured = groups.filter((entry) => entry.verdict === 'unmeasured').length;
  const verdict = failing > 0 ? 'fail' : readings.length === 0 || unmeasured > 0 ? 'empty' : 'pass';
  return { verdict, groups, readings, logs };
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PROBES: Record<Exclude<InvariantGroupId, 'redaction'>, (provider: AsrAdapter) => Promise<InvariantReading[]>> = {
  'request-construction': probeRequestConstruction,
  'error-mapping': probeErrorMapping,
  'size-layering': probeSizeLayering,
  'mime-gate': probeMimeGate,
  'token-contract': probeTokenContract,
};
