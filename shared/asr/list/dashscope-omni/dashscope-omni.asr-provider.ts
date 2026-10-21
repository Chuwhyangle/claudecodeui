/**
 * The THIRD recogniser adapter: DashScope's `qwen3.8-omni-flash` — spoken instruction in, WRITTEN
 * instruction out, over a chat-completions wire that carries the audio inline.
 *
 * IT IS THE REPOSITORY'S ONLY `style: 'written'` RECOGNISER, and that is what the wire is for:
 * `docs/proposals/voice-dashscope-omni-written-instruction.md` §2 fixes the body below, and the E
 * group in `experiments/voice-omni-written/` is the measurement the body rests on. The other two
 * adapters ask their service for the words as they were spoken; this one hands the model a task —
 * transcribe, then rewrite into an instruction an agent can execute — and returns the rewrite.
 *
 * THE FROZEN PROMPT LIVES HERE, AND ITS SIX CONSTANTS ARE NOT THIS TASK'S SUBJECT. `ROLE`, `RULES`,
 * `EXAMPLES`, `JSON_TASK`, `REASONING_EFFORT` and `DEFAULT_MODEL` below are the E group's prompt,
 * character for character, frozen by the task that created this module and compared against the
 * experiment snapshot segment by segment by `scripts/asr-omni-prompt-frozen-check.mjs`. Editing one
 * character of one of them is a change to a measured artefact, and that checker names which segment
 * moved. What THIS module adds is the half the freeze deliberately left out — the wire, the parse
 * and its degradation — so the module's own comment used to say it carried no `transcribe`, no
 * `capabilities` and no `id`; that sentence was true of the frozen half and is now the thing this
 * header replaces.
 *
 * THE WIRE IS `'chat-audio'`, and it is a third shape rather than a variant of the other two: an
 * OpenAI-compatible chat body — `POST {baseUrl}/compatible-mode/v1/chat/completions`, a bearer
 * credential, `application/json` — whose user turn carries the recording as an `input_audio` data
 * URI beside a text part. Neither existing wire can express it: `multipart` posts a form and reads
 * a transcription envelope, `inline-json` posts a generation request whose parts are `inlineData`
 * blocks. So the tag is DECLARED (`AsrWire`), and the contract board derives its expectations from
 * the declaration — a body that contradicts the tag it carries reds there rather than quietly
 * defining a shape nothing describes.
 *
 * THE PARSE DEGRADES RATHER THAN FAILING, which is a product decision with a measurement behind it:
 * the model's written rewrite is sometimes not a JSON object at all (the experiment's raw readings
 * are the evidence), and losing a usable transcription because the wrapper was missing would be
 * worse than returning the transcription. `transcribe` below therefore answers in four shapes, in
 * this order — the table is `docs/proposals/voice-dashscope-omni-written-instruction.md` §2:
 *
 *   · an `instruction` — the answer was a JSON object and the rewrite is non-empty ⇒ `style:
 *     'written'`, and the caller's text IS the instruction;
 *   · otherwise a `transcript` ⇒ `style: 'verbatim'`, `transformations: []` and
 *     `meta.writtenFallback: 1`, so the degradation is a READING the UI and the metrics can select
 *     rather than a silent downgrade;
 *   · neither of the two, in an answer that parsed ⇒ `NO_SPEECH_DETECTED`;
 *   · an answer that is not this service's envelope at all ⇒ `UPSTREAM_UNAVAILABLE`.
 *
 * The wrapper is allowed — first `{` to last `}`, exactly as §2 says — and the CONTENT is never
 * handed back as the transcription on its way to a failure: the fourth row above is a statement
 * about the envelope (a gateway page, a truncated body), not about a model that answered in prose.
 * A model that answers in prose HAS answered, so its text is the transcript; that is the second row
 * read at its widest, and it is why the fallback is a passthrough for an answer with no JSON object
 * in it and an extraction for one with.
 *
 * EVERY DEPENDENCY ARRIVES THROUGH `AsrInvocation` — base URL, credential, model, timeout, the
 * transport and the abort signal — and the two guards run before the transport is touched: an
 * undeclared container is refused before anything is sized, and an oversized request is refused
 * before anything is encoded or sent. The budget is the WHOLE request (§2: the service's 10 MB
 * inline ceiling covers the prompt, the task turn and the encoded audio together), which is why
 * `measureChatRequestBytes` sizes the body it is about to send rather than the audio inside it.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO, because a reader will otherwise look for it: this
 * module owns the wire, the parse, the endpoint rule and the credential-field declaration, and
 * nothing above them — the settings tab, the browser's own provider selection, the masking of a
 * key on its way back to the screen and the health reading's per-provider `configured` semantics
 * are the SERVER's and the client's. What this module does say about the credential is WHICH
 * SETTINGS FIELDS carry it (`credentials` below); how those fields are stored, masked, validated
 * against a request or logged is decided where they are used.
 *
 * THE ENDPOINT RULE IS DECLARED HERE AND ENFORCED ELSEWHERE, which is the point of `allowedBaseUrl`
 * below: what counts as this service's address is a fact this module knows and no other module
 * should hold a second copy of, while the refusal it produces is the server's to issue before a
 * request is built — on the transcription path and, through the same function, on the settings
 * path where the address is first stored. The rule's own text is
 * `docs/proposals/voice-dashscope-omni-written-instruction.md` §3 verbatim, not a rule invented
 * here; the module comment says so because a later reader comparing the two must find them equal.
 *
 * ENVIRONMENT NEUTRALITY, the same machine property `../../asrRegistry.ts` documents: this file is
 * compiled by BOTH compiler configurations (root: `lib: ES2020 + DOM`, `types: vite/client`;
 * server: `lib: ES2022`, NodeNext, `types: node`), so it uses no Node built-in and no ES2021+
 * library feature, and relative specifiers end in `.js`.
 */

import type {
  AsrAdapter,
  AsrCapabilities,
  AsrCredentialFields,
  AsrInvocation,
  AsrRequest,
  AsrResult,
  AsrWire,
} from '../../asrRegistry.js';
import { baseMimeType, classifyUpstreamFailure, declaredAcceptsMime } from '../../asrRegistry.js';

/**
 * The version of this frozen prompt. A value, not a derivation: it names the experiment round whose
 * readings back the text below, so a future prompt that changes on purpose can be told apart from
 * a prompt that changed by accident.
 */
export const PROMPT_VERSION = 'written-e-2026-09-24';

/**
 * The role line: what the model is, what it receives, and what its output is for.
 *
 * The instruction is a WRITTEN-STYLE rewrite rather than a verbatim transcription — the measured
 * reason the C and E conditions beat the verbatim ones on this corpus.
 */
export const ROLE = '你是编码 agent 的语音指令整理器。用户对着麦克风口述了一条给编码 agent 的指令，你收到的是这段录音。你的任务不是逐字转写，而是输出一条清晰、书面化、可以直接交给编码 agent 执行的指令。';

/**
 * The six rules the rewrite obeys, in the experiment's own order and wording.
 *
 * They are one literal rather than an array of six because the experiment sent them as one string
 * and this module's job is to reproduce that string: splitting them here would be a second shape
 * for a frozen value, and the criterion compares text, not structure.
 */
export const RULES = `规则：
1. 说话人自我更正（如“嗯不对”“啊不”“不是…是…”）时，只保留更正后的意思，删掉被否定的部分。
2. 删掉口头禅和填充词（嗯、那个、就是、啊）。
3. 文件名、函数名、hook 名等代码标识符用反引号包起来，按听到的拼写写出，不要猜测或替换。
4. 数字一律用阿拉伯数字。
5. 不得添加录音里没有的信息，不得省略录音里的任何要求。
6. 只输出整理后的指令本身，不要解释。`;

/**
 * Three worked examples, spoken → written, one per rule family the experiment found load bearing
 * (a numeral rename, a self-correction, a de-disfluency that must not touch the tests).
 */
export const EXAMPLES = `示例（口述 → 整理后的指令）：
口述：嗯，那个，把 README 里的端口，就是 3000，改成八千零八十
指令：把 \`README\` 里的端口从 3000 改成 8080。
口述：给 login 页面加个校验，啊不对，是 signup 页面
指令：给 signup 页面加上校验。
口述：删掉 utils 目录下那个 date 的 helper，嗯，别动测试
指令：删掉 \`utils\` 目录下的 date helper，不要改动测试。`;

/**
 * The user turn: a two-step task (transcribe, then rewrite) whose answer is one JSON object.
 *
 * It is a constant of its own rather than a sentence appended to the role, because the experiment
 * varied exactly this — D and E differ from C by this turn — and the criterion compares this
 * segment by name.
 */
export const JSON_TASK = '先逐字转写录音，再按规则整理成指令。只输出一个 JSON 对象：{"transcript": "逐字转写", "instruction": "整理后的指令"}，不要输出其他内容。';

/**
 * The thinking budget the E condition was run at, and the value the frozen readings were taken
 * under. `low` is the one that was measured; raising it changes the latency and the answer shape
 * without a reading behind it.
 */
export const REASONING_EFFORT = 'low';

/**
 * The model the frozen readings came from.
 *
 * A DashScope ALIAS, not an immutable snapshot: the service is free to re-point it, so a future
 * reading taken under the same name may differ from these 160. That is recorded in the snapshot's
 * provenance rather than hidden here — the constant says which name the experiment used, not that
 * the name still resolves to the same weights.
 */
export const DEFAULT_MODEL = 'qwen3.8-omni-flash';

// ── the declaration ──────────────────────────────────────────────────────────────────────────

/** The id this provider is registered under (by the task that registers it — not this one). */
export const id: string = 'dashscope-omni';

/**
 * This provider's capability declaration.
 *
 * THE VALUES THAT ARE NOT THE OTHER ADAPTERS' ARE THE LOAD-BEARING PART, and each one is a
 * measurement rather than a preference: `style: 'written'` (the E-group readings — this is the
 * recogniser the whole proposal exists for), `billing: 'audio-tokens'` (measured: 14.5 s of audio
 * billed as 100 audio tokens, so a saved second IS a saved token), `pauseCues: 'neutral'` (measured in
 * `docs/experiments/2026-09-24-omni-written.md`, where the shipping trim ran against this service on
 * the same eight clips: trimming the pauses gained no verdict and cost one, and no clip came out
 * better for it — so the value the reading supports is `neutral`, i.e. the upload is left as
 * recorded), and
 * `honors` false on all three axes (the context experiment produced echo and mis-inserted
 * identifiers, so a prompt has nothing to offer here).
 *
 * `maxInlineRequestBytes` is 10 MB and it is the WHOLE REQUEST, not the audio: the service publishes
 * an inline ceiling for the request, so an adapter that sized the audio alone would send — and pay
 * for — a body the service rejects.
 */
export const capabilities: AsrCapabilities = {
  acceptsMime: [
    'audio/webm',
    'audio/ogg',
    'audio/wav',
    'audio/x-wav',
    'audio/mpeg',
    'audio/mp3',
    'audio/aac',
    'audio/amr',
  ],
  // The published inline maximum, and it is the WHOLE request: prompt, task turn and encoded audio.
  maxInlineRequestBytes: 10 * 1024 * 1024,
  oversize: 'reject',
  honors: { prompt: false, language: false, context: false },
  billing: 'audio-tokens',
  pauseCues: 'neutral',
  style: 'written',
  oneShot: true,
  // 'proxy-only', AND THIS IS A MEASUREMENT RATHER THAN A PREFERENCE. A browser cannot call this
  // service's endpoint itself — the CORS preflight is not answered (the 2026-09-23 webm candidate
  // record has the 401 arriving with no usable CORS headers, which is what a browser reports as an
  // opaque failure) — so a user's recording reaches it through this server and only through it. The
  // declaration is what makes the client's direct path step aside without the client having to know
  // the hostname; `allowedBaseUrl` below is what holds the address the user typed to this service's
  // own.
  transport: 'proxy-only',
  // The written answer is a paragraph, not a token stream: no per-word confidence and no timing
  // travel on this wire, so both facts are declared absent and the invariant board enforces it.
  tokens: { confidence: false, timestamps: false },
  // 'remote': the audio is proxied to the vendor's service. Nothing about this recogniser runs on
  // the device or on this host.
  locality: 'remote',
};

/**
 * The workspace hostname shape this service hands out: one sub-domain under a regional workspace
 * name, under the `maas` product, under the vendor's domain.
 *
 * `maas` IS PART OF THE PATTERN ON PURPOSE. A rule that accepted any `*.aliyuncs.com` host would
 * accept every other product on the vendor's shared domain — DashScope's own model APIs, OSS, the
 * console — so the recording would be offered to a host that has nothing to do with this endpoint
 * while the rule said it was this endpoint's address.
 */
const WORKSPACE_HOSTNAME = /^[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$/;

/**
 * The service's own public hostname, accepted as it stands: it is the address without a workspace.
 *
 * IT IS EXPORTED SO THE ADDRESS HAS ONE SOURCE, and its consumers are named because an exported
 * value with no named consumer is exactly how a second copy starts. `allowedBaseUrl` below is the
 * first; the second is
 * `server/modules/voice-realtime/voice-realtime-dashscope-transport.ts`, which dials the SAME
 * service over a WebSocket (`wss://<host>/api-ws/v1/realtime`) and used to spell this hostname
 * itself — that second literal broke AC-140's `endpoint-rule.single-implementation` reading, which
 * holds that the addresses this service is reached at are spelled in one shipping file (this one).
 * The two voice-realtime leaves added later consumers and are named here for the same reason:
 * `server/modules/voice-realtime/voice-realtime-summary.ts` composes its compatible-mode
 * `chat/completions` URL from this export, and
 * `server/modules/voice-realtime/voice-realtime-tts.ts` composes its multimodal-generation base URL
 * from it. Each used to spell the hostname itself, and each second literal reds the same reading.
 * A consumer composes its URL from THIS export; typing the hostname again anywhere under `src/`,
 * `shared/` or `server/` re-introduces the second copy and reds that reading.
 */
export const PUBLIC_HOSTNAME = 'dashscope.aliyuncs.com';

/**
 * Whether `baseUrl` is an address this provider's endpoint may be reached at.
 *
 * THE RULE IS `docs/proposals/voice-dashscope-omni-written-instruction.md` §3 (the SSRF section),
 * and each clause is there for a reason that clause alone carries:
 *
 *   · `https:` ONLY — the recording is the user's voice and the credential travels beside it. A
 *     plain-`http` address would send both in the clear, and the workspace shape below says nothing
 *     about the transport.
 *   · THE HOSTNAME IS ONE OF THE TWO DECLARED SHAPES — a workspace under `maas`, or the service's
 *     public hostname. This is the SSRF clause: the address a user types travels to a cloud
 *     metadata endpoint or an internal service exactly as readily as to this one, so the hosts the
 *     value may name are enumerated rather than filtered. `aliyuncs.com.evil.com` and
 *     `dashscope.aliyuncs.com.evil.com` are different hostnames from the two above and are refused
 *     by the same clause — the match is on the WHOLE hostname, never a suffix or a substring.
 *   · NO PORT — the service is reached on its own default port. A port is a way to point a
 *     permitted hostname at something else entirely on the other end of it.
 *   · NO USER INFORMATION — `https://user:pass@host` sends a credential this path does not own and
 *     makes the authority a string no reader of the address would expect.
 *
 * A value that is not a URL at all is refused here too, and by the same answer: `new URL` throwing
 * is not a different meaning, it is the same "this is not this service's address". The caller reads
 * the boolean; the code and message it turns into are the server's (`INVALID_BASE_URL`).
 *
 * WHAT IT DOES NOT DO: it does not resolve DNS, follow redirects or inspect the audio. A hostname
 * that passes and then answers a redirect somewhere else is a property of the transport, and this
 * predicate has no transport to read.
 */
export function allowedBaseUrl(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  if (parsed.port !== '') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;

  const hostname = parsed.hostname;
  return hostname === PUBLIC_HOSTNAME || WORKSPACE_HOSTNAME.test(hostname);
}

/**
 * The request shape this adapter speaks. Declared rather than implied: the contract board selects
 * its expectations by this tag, so a body that contradicts it is a red reading there.
 */
export const wire: AsrWire = 'chat-audio';

/**
 * Which of a user's stored voice-settings fields carry THIS service's address, credential and model.
 *
 * THE SERVER HAS NO SECOND COPY OF THIS, and that is the whole content of the declaration. A
 * deployment-wide `VOICE_API_KEY`/`VOICE_API_BASE_URL` cannot serve this recogniser: the credential
 * is the user's own DashScope key and the address is their own workspace endpoint, both of which
 * only the user knows — so a request that reaches this service has to be given them, and the only
 * module that can say WHICH fields to read them from is this one. A table in the server indexed by
 * provider id would be a second copy of a fact that lives here, and would go stale the day a field
 * is renamed; `AsrCredentialFields` is the seam that lets it be stated once (the same discipline
 * `allowedBaseUrl` above follows for the address RULE, this one for the address ITSELF).
 *
 * THE THREE NAMES ARE SETTINGS KEYS, and the names are this provider's own vocabulary on purpose:
 * `dashscopeApiKey` says whose key it is, so a reader of the settings document can tell the
 * server-held credential from the `apiKey` the browser keeps for its own direct path. The shared
 * settings shape does not know them as first-class fields — the server reaches them through this
 * declaration, which is what keeps the server free of any branching on this provider's id.
 *
 * `modelField` IS DECLARED AND MAY BE EMPTY. An empty value means "unset", and an unset per-user
 * model resolves to `defaultModel` — this module's own frozen `DEFAULT_MODEL`, NOT the deployment's
 * shared `sttModel`, which names a model of another service and would be sent here as-is. The field
 * is declared rather than made mandatory because "this service takes a per-user model" and "this
 * user picked one" are different statements.
 */
export const credentials: AsrCredentialFields = {
  endpointField: 'dashscopeEndpoint',
  apiKeyField: 'dashscopeApiKey',
  modelField: 'dashscopeModel',
  defaultModel: DEFAULT_MODEL,
};

/**
 * What this adapter did to the text when it returns the model's rewrite.
 *
 * All four are performed BY THE INSTRUCTION rather than by this module: the rules in `RULES` ask for
 * punctuation, de-disfluency, self-correction resolution and a written register, and the pair of
 * measurement and instruction is what a `style: 'written'` declaration means here. The degraded path
 * declares `[]` instead — a verbatim transcription is not these four.
 */
export const WRITTEN_TRANSFORMATIONS = [
  'punctuate',
  'de-disfluency',
  'self-correction-applied',
  'written-style',
] as const;

// ── the prompt's composition ─────────────────────────────────────────────────────────────────

/**
 * The system turn's content: the three text segments joined by a blank line, EXACTLY as the
 * experiment sent them.
 *
 * The join is a named function rather than a template at the build site because the criterion
 * compares byte for byte against `` `${ROLE}\n\n${RULES}\n\n${EXAMPLES}` ``: a builder free to
 * compose the three differently would be a second, unreported prompt.
 */
export function systemPrompt(): string {
  return `${ROLE}\n\n${RULES}\n\n${EXAMPLES}`;
}

/**
 * The `format` field, derived from the recording's BASE media type.
 *
 * The rules are the two asymmetries between a media type and this service's own vocabulary, and
 * they are a table rather than a prefix/trim because they are exceptions and not a scheme:
 * `audio/x-wav` and `audio/wav` are the same container and the service knows only `wav`; the
 * service spells MPEG audio `mp3` while the media type spells it `mpeg`. Everything else is its own
 * subtype, so a container the declaration accepts needs no row here.
 *
 * The parameters come off through `baseMimeType` and not a second local rule: the browser's own
 * recording type is `audio/webm;codecs=opus`, and a derivation that kept the parameters would send
 * `webm;codecs=opus` where the service expects a container name.
 */
const FORMAT_ALIASES: Readonly<Record<string, string>> = { 'x-wav': 'wav', mpeg: 'mp3' };

export function audioFormatFor(mimeType: string): string {
  const base = baseMimeType(mimeType);
  const slash = base.indexOf('/');
  const subtype = slash === -1 ? base : base.slice(slash + 1);
  const alias = FORMAT_ALIASES[subtype];
  return alias === undefined ? subtype : alias;
}

/** The `input_audio.data` value: the data URI a recording is addressed by, with `encoded` in it. */
export function chatAudioDataUri(mimeType: string, encoded: string): string {
  return `data:${baseMimeType(mimeType)};base64,${encoded}`;
}

/**
 * The URL the chat-completions call goes to.
 *
 * The configured base URL is a workspace address, so the path is appended to it rather than
 * replacing it — and a trailing slash on the configured value is removed first, because
 * `https://host//compatible-mode/…` is a different URL to a service that routes on the path.
 */
export function chatCompletionsEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/compatible-mode/v1/chat/completions`;
}

// ── the request body ─────────────────────────────────────────────────────────────────────────

export type ChatAudioPart = { type: 'input_audio'; input_audio: { data: string; format: string } };
export type ChatTextPart = { type: 'text'; text: string };
export type ChatMessage = {
  role: 'system' | 'user';
  content: string | (ChatAudioPart | ChatTextPart)[];
};

/** One chat-completions request, as this service's compatible mode expects it. */
export type ChatAudioRequestBody = {
  model: string;
  modalities: string[];
  stream: boolean;
  reasoning_effort: string;
  messages: ChatMessage[];
};

/**
 * Builds the request body.
 *
 * `audioData` is a PARAMETER rather than something this function computes, which is what makes the
 * budget check exact without materialising the encoded audio: the same builder produces the
 * skeleton the guard measures and the body that is sent, so the two can never describe different
 * requests. See `measureChatRequestBytes`.
 *
 * THERE IS NO `hints` PARAMETER, AND THAT IS THE DECLARATION. `honors` is false on all three axes,
 * so the caller's hints have no path onto this body at all: an adapter that took the hints and
 * dropped them would leave "the prompt is not sent" resting on a condition downstream of the
 * declaration, where it could drift from it. The system turn is the adapter's own frozen prompt and
 * is not a hint — the caller cannot set it, and cannot turn it off.
 */
export function buildChatRequestBody(
  request: AsrRequest,
  audioData: string,
  model: string,
): ChatAudioRequestBody {
  return {
    model,
    modalities: ['text'],
    stream: false,
    reasoning_effort: REASONING_EFFORT,
    messages: [
      { role: 'system', content: systemPrompt() },
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: {
              data: chatAudioDataUri(request.audio.mimeType, audioData),
              format: audioFormatFor(request.audio.mimeType),
            },
          },
          { type: 'text', text: JSON_TASK },
        ],
      },
    ],
  };
}

// ── the budget arithmetic ────────────────────────────────────────────────────────────────────

/** The exact length a base64 encoding of `byteLength` bytes has, without encoding anything. */
export function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

/** The UTF-8 length of `value`, counted directly so no encoder global is needed on either side. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 of `bytes`. Written out rather than reached for, for the neutrality reason above. */
export function base64Encode(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    encoded += BASE64_ALPHABET[first >> 2];
    encoded += BASE64_ALPHABET[((first & 0x03) << 4) | (second >> 4)];
    encoded += index + 1 < bytes.length ? BASE64_ALPHABET[((second & 0x0f) << 2) | (third >> 6)] : '=';
    encoded += index + 2 < bytes.length ? BASE64_ALPHABET[third & 0x3f] : '=';
  }
  return encoded;
}

/**
 * The byte length of the request this adapter would send for `request` and `model` — the budget
 * subject, and an exact reading rather than an estimate.
 *
 * It is exact because the audio's contribution is not guessed at: the body is serialised once with
 * an EMPTY payload and the encoded payload's own length, plus the data URI's fixed prefix, is added
 * on. Base64's alphabet contains no character JSON would escape and the prefix is ASCII, so
 * replacing `""` with the real data URI changes the serialised length by exactly that sum. The cost
 * is that the audio is never encoded for a request that is about to be rejected — the same
 * discipline the guard's position (before `fetchImpl`) enforces on the network side.
 *
 * The subject is the WHOLE request (§2: the service's ceiling is a request maximum), and because the
 * frozen prompt, the task turn and the decode parameters are produced by the same builder, they are
 * charged here by construction rather than by a second addition that could be forgotten.
 *
 * What this deliberately does not model: the constant transport envelope (URL, headers). It is
 * fixed per call and carries no caller-controlled bytes; everything a caller can grow — the audio —
 * is inside the number below.
 */
export function measureChatRequestBytes(request: AsrRequest, model: string): number {
  const skeleton = JSON.stringify(buildChatRequestBody(request, '', model));
  const prefix = chatAudioDataUri(request.audio.mimeType, '');
  return utf8ByteLength(skeleton) + utf8ByteLength(prefix) + base64Length(request.audio.bytes.length);
}

// ── the answer ───────────────────────────────────────────────────────────────────────────────

type ChatAnswer = { choices?: { message?: { content?: unknown } }[] };

/**
 * The assistant turn's text out of this service's chat envelope, or `null` when the body is not it.
 *
 * `null` rather than the empty string, because the two are different answers: a body that is not
 * this envelope is an upstream fault, while an assistant turn with nothing in it is a service that
 * heard nothing. Collapsing them would report a gateway page as `NO_SPEECH_DETECTED`.
 */
export function readAnswerContent(responseText: string): string | null {
  let parsed: ChatAnswer;
  try {
    parsed = JSON.parse(responseText) as ChatAnswer;
  } catch {
    return null;
  }
  const content = parsed?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : null;
}

/**
 * The service's own usage reading out of a chat envelope, flattened to numbers, or `undefined` when
 * the body carries none.
 *
 * Counts only, and flattened one level (`prompt_tokens_details.audio_tokens`): the contract's
 * `meta.usage` is `Record<string, number>`, and a field that is not a finite number is the service's
 * business rather than a reading. No price is computed here — a unit price is a deployment fact that
 * changes, and a count is what the service actually states.
 */
// Consumed by this adapter's `transcribe` and by the voice module's adapter tests.
export function readUsage(responseText: string): Record<string, number> | undefined {
  let parsed: { usage?: unknown };
  try {
    parsed = JSON.parse(responseText) as { usage?: unknown };
  } catch {
    return undefined;
  }
  const usage = parsed?.usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const flat: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      flat[key] = value;
    } else if (typeof value === 'object' && value !== null) {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (typeof innerValue === 'number' && Number.isFinite(innerValue)) flat[`${key}.${inner}`] = innerValue;
      }
    }
  }
  return Object.keys(flat).length === 0 ? undefined : flat;
}

/**
 * The JSON object inside an answer, or `null` when there is none.
 *
 * §2 allows the object to arrive wrapped — in a Markdown fence, in explanatory prose — so the slice
 * is first `{` to last `}`, and only that slice is parsed. A slice that does not parse is `null`:
 * the caller decides what an answer with no object in it means, and for this adapter it means the
 * content is the transcription.
 */
export function extractJsonObject(content: string): Record<string, unknown> | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

/**
 * One string field of a parsed answer, or the empty string when it is absent or not a string.
 *
 * The empty string is the absent value on purpose: every caller below asks "is there something
 * here" and nothing distinguishes "the key was missing" from "the key held an empty string", which
 * is exactly the pair §2's table treats alike.
 */
function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Whether a 403 body is the service saying the MODEL is not enabled for this account.
 *
 * WHY THIS IS A BODY READING RATHER THAN A STATUS READING. `AccessDenied.Unpurchased` arrives as a
 * plain 403, exactly like a credential the service refuses, and the two need different words: the
 * experiment hit the first one for real, and a user who is told "your key was rejected" while their
 * account simply has not enabled the model has no way to act on it. The token in the body is what
 * separates them; a 403 carrying neither is an ordinary refusal and keeps the plain message.
 */
export function isModelNotPurchased(responseText: string): boolean {
  return responseText.indexOf('AccessDenied.Unpurchased') !== -1;
}

/**
 * The semantic code this answer means, read by the ONE classifier in the registry.
 *
 * WHAT WAS HERE INSTEAD, and why it was the defect: a three-line `errorCodeForStatus(status)` reading
 * only the number. `isModelNotPurchased` above reads the body for the MESSAGE, and the mapper did not
 * read it at all, so an unenabled model and a refused credential were one code to it. The
 * implementation now lives beside the vocabulary (`classifyUpstreamFailure`), which reads the same
 * body — so the sentence and the code above it are two readings of one answer rather than two
 * answers to one question.
 */

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** A failure body, read for its evidence and never for its text: an unreadable one is empty. */
async function readTextQuietly(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

// ── the adapter ──────────────────────────────────────────────────────────────────────────────

/**
 * Transcribes one recording into a written instruction, or into the transcription it degraded to.
 *
 * The two guards run before the transport is touched, in this order: an undeclared container is
 * refused before anything is sized, and an oversized request is refused before anything is encoded
 * or sent. Neither produces an upstream call — which is what makes "oversize costs nothing" a
 * counter rather than a claim.
 */
export async function transcribe(request: AsrRequest, invocation: AsrInvocation): Promise<AsrResult> {
  if (!declaredAcceptsMime(capabilities, request.audio.mimeType)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_MIME',
      message:
        `provider '${id}' does not accept ${baseMimeType(request.audio.mimeType)}; ` +
        `it accepts ${capabilities.acceptsMime.join(', ')}`,
    };
  }

  const requestBytes = measureChatRequestBytes(request, invocation.model);
  if (requestBytes > capabilities.maxInlineRequestBytes) {
    return {
      ok: false,
      code: 'OVERSIZE',
      message:
        `inline request of ${requestBytes} B exceeds provider '${id}' budget of ` +
        `${capabilities.maxInlineRequestBytes} B (the budget covers the whole request: the encoded ` +
        `audio, the prompt and the task turn together, not the audio alone)`,
    };
  }

  const endpoint = chatCompletionsEndpoint(invocation.baseUrl);
  const body = JSON.stringify(
    buildChatRequestBody(request, base64Encode(request.audio.bytes), invocation.model),
  );
  const signal = invocation.signal ?? AbortSignal.timeout(invocation.timeoutMs);

  let response: Response;
  try {
    response = await invocation.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The bearer form, and only when there is a credential: an unconfigured call is not an
        // unauthenticated claim, so the header is absent rather than empty.
        ...(invocation.apiKey ? { Authorization: `Bearer ${invocation.apiKey}` } : {}),
      },
      body,
      signal,
    });
  } catch (error) {
    // One code, two messages: a transport that never connected and a request the invocation's
    // deadline (or the caller's signal) ended are the same fact about the upstream from this side of
    // the seam (`UPSTREAM_UNAVAILABLE`).
    return {
      ok: false,
      code: 'UPSTREAM_UNAVAILABLE',
      message: isAbortError(error)
        ? `provider '${id}' did not answer within ${invocation.timeoutMs} ms`
        : `provider '${id}' could not be reached`,
    };
  }

  if (!response.ok) {
    // The body decides whether a 403 is a model this account has not enabled — for the MESSAGE; see
    // `isModelNotPurchased`. The CODE comes from the one classifier over the same body, so the two
    // are readings of one answer rather than two answers to one question.
    const failureText = await readTextQuietly(response);
    const notPurchased = response.status === 403 && isModelNotPurchased(failureText);
    let message = `provider '${id}' answered ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      message = notPurchased
        ? `provider '${id}' cannot use this model: it is not enabled for the account or the ` +
          `balance is insufficient（未开通或余额不足）`
        : `provider '${id}' rejected the credential (${response.status})`;
    }
    return {
      ok: false,
      code: classifyUpstreamFailure(response.status, failureText),
      message,
      status: response.status,
    };
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch {
    return { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: `provider '${id}' answer could not be read` };
  }

  const content = readAnswerContent(responseText);
  const usage = readUsage(responseText);
  if (content === null) {
    return {
      ok: false,
      code: 'UPSTREAM_UNAVAILABLE',
      message: `provider '${id}' answer was not a chat completion envelope`,
    };
  }

  // §2's table, in one pass: an answer with a JSON object in it is read out of that object, and an
  // answer without one IS the transcription (the model answered in prose rather than in the shape
  // it was asked for, which is the degradation §2 records — the raw RETURN, the envelope, is never
  // the text; that case was refused above).
  const answer = extractJsonObject(content);
  const instruction = answer === null ? '' : stringField(answer, 'instruction');
  const transcript = answer === null ? content.trim() : stringField(answer, 'transcript');

  if (instruction !== '') {
    return {
      ok: true,
      text: instruction,
      style: 'written',
      transformations: [...WRITTEN_TRANSFORMATIONS],
      providerId: id,
      meta: { model: invocation.model, promptVersion: PROMPT_VERSION, ...(usage ? { usage } : {}) },
    };
  }

  if (transcript !== '') {
    return {
      ok: true,
      text: transcript,
      style: 'verbatim',
      // Not the four the declaration names: nothing was rewritten, and a caller that read
      // `written-style` off a degraded answer would show the user a transformation that did not
      // happen. `meta.writtenFallback` is what carries the degradation.
      transformations: [],
      providerId: id,
      meta: {
        model: invocation.model,
        writtenFallback: 1,
        promptVersion: PROMPT_VERSION,
        ...(usage ? { usage } : {}),
      },
    };
  }

  return {
    ok: false,
    code: 'NO_SPEECH_DETECTED',
    message: `provider '${id}' returned neither an instruction nor a transcript`,
  };
}

/**
 * This module as the registry consumes it. The endpoint rule travels with the adapter, not beside it
 * — and so does the credential-field declaration (`credentials` above), for the same reason: both
 * are facts about this service, and a consumer that read them anywhere else would be reading a copy.
 */
export const adapter: AsrAdapter = { id, capabilities, wire, allowedBaseUrl, credentials, transcribe };
