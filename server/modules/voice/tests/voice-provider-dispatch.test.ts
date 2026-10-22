/**
 * AC-139's criterion: the proxy path DISPATCHES — the wire the request is sent on is the selected
 * provider's adapter's, not this module's.
 *
 * WHAT IS BEING READ, AND WHY IT NEEDS A READING AT ALL. Registering a second recogniser was a
 * one-line change to the address book, and it would have gone on meaning nothing if
 * `voice.service.ts` kept composing the multipart request itself: the registry would have been a
 * description of behaviour the app never went through, and every consumer of the seam — the trim's
 * declaration, the health payload, the invariant board — would have been reading that description.
 * So the reading here is not "a second provider exists" but "the same service, handed the same
 * audio, sends what the SELECTED provider's wire says", which is only observable if the two
 * providers' shapes are driven through one entry point.
 *
 * The cases, and the criterion each belongs to:
 *
 *   AC2  the mutually exclusive pair — `dashscope-omni`'s chat-completions JSON and
 *        `openai-compatible`'s multipart form, driven by the same service on the same audio
 *   AC4  the proxy path's tolerance, on the five inputs the parity baseline was recorded with:
 *        the reading that must NOT move when the dispatch lands
 *   AC5  `AsrErrorCode` to HTTP, as a table with one row per member, each driven to the status it
 *        names, plus the one passthrough (an upstream status the adapter read is reported as
 *        itself)
 *   AC6  registration order and the health payload, which the new row must not have moved
 *   AC10 the scope statement, and the transport double that makes every reading above offline
 *
 * HOW THE READINGS ARE TAKEN. Every case drives the shipped `createVoiceService` and installs the
 * outbound port it takes as a dependency; nothing here re-implements a body or a parse. The one
 * exception is deliberate: AC4 compares against `scripts/__fixtures__/asr-extraction-parity-baseline
 * .json`, which was recorded before this task, so "the reading did not move" is decided by a file
 * this task cannot have written — not by a second copy of the expectation living in this file.
 *
 * Run: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-provider-dispatch.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { listProviders } from '../../../../shared/asr/asrRegistry.js';
import type { AsrErrorCode } from '../../../../shared/asr/asrRegistry.js';
import { createVoiceService, PROVIDER_ERROR_STATUS } from '../voice.service.js';
import type { VoiceServiceResult, VoiceSettings } from '@/shared/types.js';

/**
 * The new provider's module, imported DYNAMICALLY on purpose.
 *
 * The registry and the adapters that declare a capability form an import cycle: every adapter asks
 * the registry for `baseMimeType`/`declaredAcceptsMime` (a value import, so a real edge), and the
 * registry reads each adapter's `id`/`capabilities`/`wire`/`transcribe` while it builds its own
 * registration list. That cycle is fine when the REGISTRY is entered first — the adapters finish
 * evaluating before the list is built — and a `ReferenceError: Cannot access '<id>' before
 * initialization` when an adapter is entered first, because the registry then builds its list while
 * the module it is reading from is still in progress. Measured, in this order:
 *
 *   import ... from 'shared/asr/asrRegistry.js'                        -> the three ids print
 *   import ... from 'shared/asr/list/openai-compatible/...'            -> TDZ (pre-existing: that
 *                                                                         adapter's row is the first)
 *   import ... from 'shared/asr/list/dashscope-omni/...'               -> TDZ (this task's row)
 *
 * The cycle is not this file's to repair — breaking it means moving two pure functions out of the
 * registry, which is a change to the seam's shape and to a frozen adapter — so this file asks for
 * the adapter only after its static graph (the registry) has been evaluated. AC6 wants the
 * registry's row compared against the MODULE's own object, and this is that object.
 */
const dashscopeOmni = await import(
  '../../../../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.js'
);
const dashscopeOmniId = dashscopeOmni.id;
const dashscopeOmniCapabilities = dashscopeOmni.capabilities;

/** Prints one reading line. `process.stdout.write` rather than `console.log`: no colour, no
 * re-formatting, so a line here is byte-comparable with the same line in another run. */
function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

// ── the harness ───────────────────────────────────────────────────────────────────────────────

type Defaults = {
  baseUrl: string;
  apiKey: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  providerId: string;
};

/**
 * The deployment the shipped tests use, so a reading here is comparable with theirs.
 *
 * WHY THIS HOST AND NOT AN EXAMPLE ONE. AC-140 gave the `'proxy-only'` providers an endpoint rule:
 * `voice.service.ts` asks the SELECTED adapter's `allowedBaseUrl` before it builds a request and
 * refuses the invocation when the rule says no, so an address outside that provider's own service
 * never reaches its adapter. This file drives `dashscope-omni` through the same service as the
 * factory entry — that is the whole reading — so a deployment host that provider may not be reached
 * at would refuse it in the pre-request gate and there would be no wire to read at all. The address
 * is therefore one the rule accepts; the factory entry declares `'direct'`, is held to no rule, and
 * its readings are unaffected either way. Nothing else about this file changed with AC-140: every
 * assertion below is still about WHICH WIRE the selected provider sends, not about which host.
 */
const DEFAULTS: Defaults = {
  baseUrl: 'https://dashscope.aliyuncs.com',
  apiKey: 'server-key',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  providerId: '',
};

/** Never reached: every case installs an answer, so no timeout can fire. */
const TIMEOUT_MS = 1_000;

/** One audio upload, the shape the route hands the service. */
function audioUpload(overrides: Partial<{ mimeType: string; byteLength: number }> = {}) {
  return {
    bytes: Buffer.alloc(overrides.byteLength ?? 16, 0x6b),
    mimeType: overrides.mimeType ?? 'audio/webm',
    fileName: 'clip.webm',
  };
}

/** One outbound call as the recorder saw it. */
type Recorded = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

function readHeaders(headers: RequestInit['headers']): Record<string, string> {
  const collected: Record<string, string> = {};
  if (!headers) return collected;
  const entries = Array.isArray(headers)
    ? headers
    : headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers as Record<string, string>);
  for (const [name, value] of entries) collected[String(name)] = String(value);
  return collected;
}

/**
 * The service with the outbound port replaced by a double that records the call and answers with
 * `answer()`. The dependencies are the service's own injected ports — nothing global is patched —
 * so what a reading sees is the request the service really builds.
 *
 * `answer` may throw, which is how the two transport failures are driven: a double that rejects is
 * the only way to read what the adapters do with a transport that never answered.
 */
function makeService(options: {
  defaults?: Partial<Defaults>;
  answer?: () => Response;
  calls?: Recorded[];
  timeoutMs?: number;
}) {
  const answer =
    options.answer ?? (() => new Response(JSON.stringify({ text: 'k-asr-answer' }), { status: 200 }));

  return createVoiceService({
    defaults: { ...DEFAULTS, ...options.defaults },
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    fetchBackend: async (url, init) => {
      options.calls?.push({
        url,
        method: String(init.method ?? 'GET').toUpperCase(),
        headers: readHeaders(init.headers),
        body: init.body,
      });
      return answer();
    },
  });
}

/** A chat-completions answer carrying `content`, which is where a written recogniser answers. */
function chatAnswer(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

const NO_USER_SETTINGS: VoiceSettings = {
  baseUrl: '',
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
};

// ── AC2: the pair of shapes, driven through one entry point ───────────────────────────────────

test('AC2 dashscope-omni / chat-audio: one JSON POST to the compatible-mode endpoint, the invocation\'s model and key', async () => {
  const calls: Recorded[] = [];
  const requestedModel = 'omni-model-from-the-invocation';
  const service = makeService({
    calls,
    answer: () => chatAnswer('{"transcript":"k-omni-answer"}'),
  });

  // The model rides in the user's stored per-provider field. It is deliberately NOT the request's
  // `sttModel` override: the settings page sends the shared backend's model in that header on every
  // transcribe, and a provider with its own model field must not read it (voice-dashscope-default-model).
  const result = await service.transcribe({
    audio: audioUpload(),
    overrides: { providerId: dashscopeOmniId },
    settings: { ...NO_USER_SETTINGS, dashscopeModel: requestedModel },
  });

  assert.equal(calls.length, 1, 'the chat-audio shape is one request, not a probe plus a request');
  const [call] = calls;
  assert.equal(call.url, `${DEFAULTS.baseUrl}/compatible-mode/v1/chat/completions`);
  assert.equal(call.method, 'POST');
  assert.equal(call.body instanceof FormData, false, 'the chat-audio wire is JSON, not multipart');
  const body = JSON.parse(String(call.body)) as { messages?: unknown; model?: unknown };
  assert.equal(Array.isArray(body.messages), true, 'the body carries the chat turn list');
  assert.equal(body.model, requestedModel, 'the model is the one the user stored, not the provider default');
  assert.equal(call.headers.Authorization, `Bearer ${DEFAULTS.apiKey}`);
  assert.equal(result.ok, true);

  emit(
    `dispatch-request provider=${dashscopeOmniId} wire=chat-audio url=${call.url} ` +
      `body=json-text messages=array model=${String(body.model)}`,
  );
});

test('AC2 openai-compatible / multipart: the same service posts the form, and the two shapes exclude each other', async () => {
  const multipartCalls: Recorded[] = [];
  const chatCalls: Recorded[] = [];
  const multipartService = makeService({ calls: multipartCalls });
  const chatService = makeService({
    calls: chatCalls,
    answer: () => chatAnswer('{"transcript":"k-omni-answer"}'),
  });
  const overrides = { sttModel: 'k-shared-model' };

  const multipartResult = await multipartService.transcribe({
    audio: audioUpload(),
    overrides: { ...overrides, providerId: 'openai-compatible' },
  });
  await chatService.transcribe({
    audio: audioUpload(),
    overrides: { ...overrides, providerId: dashscopeOmniId },
  });

  // THE POSITIVE CONTROL, in the same file as the case above and on the same audio: without it,
  // "the service sends a chat request for dashscope-omni" would also be green if the service sent
  // that request for every provider.
  assert.equal(multipartCalls.length, 1);
  const [form] = multipartCalls;
  assert.equal(form.url, `${DEFAULTS.baseUrl}/audio/transcriptions`);
  assert.equal(form.method, 'POST');
  assert.ok(form.body instanceof FormData, 'the shipped wire is multipart');
  assert.ok(form.body.get('file') instanceof Blob, 'the recording travels as the `file` part');
  assert.equal(form.body.get('model'), 'k-shared-model');
  assert.equal(form.headers.Authorization, `Bearer ${DEFAULTS.apiKey}`);
  assert.equal(multipartResult.ok, true);

  // The exclusion itself is the reading: the same audio, the same service, two providers, two
  // different body kinds and two different endpoints — neither provider's call is the other's.
  const multipartIsForm = form.body instanceof FormData;
  const chatIsForm = chatCalls[0]?.body instanceof FormData;
  assert.notEqual(multipartIsForm, chatIsForm);
  assert.notEqual(form.url, chatCalls[0]?.url);

  emit(
    `dispatch-shape-pair openai-compatible=multipart(url=${form.url}) ` +
      `dashscope-omni=json-chat(url=${chatCalls[0]?.url}) mutually-exclusive=true`,
  );
});

// ── AC4: the unchanged half — the proxy path's tolerance ──────────────────────────────────────

/**
 * The five bodies the parity baseline's `response-tolerance.proxy` group was recorded on. Written
 * out here rather than read from the reader because a test that took its INPUTS from the fixture
 * would be comparing the fixture with itself; only the EXPECTATIONS come from the fixture.
 */
const TOLERANCE_INPUTS: ReadonlyArray<{ name: string; body: string }> = [
  { name: 'non-json-body', body: 'k-asr-not-json' },
  { name: 'json-text', body: JSON.stringify({ text: 'k-asr-answer' }) },
  { name: 'json-numeric-text', body: JSON.stringify({ text: 0 }) },
  { name: 'json-without-text', body: JSON.stringify({ other: 'k-asr-answer' }) },
  { name: 'json-null', body: 'null' },
];

type BaselineCase = { name: string; outcome: string; text?: string };

const BASELINE_PATH = fileURLToPath(
  new URL('../../../../scripts/__fixtures__/asr-extraction-parity-baseline.json', import.meta.url),
);

function proxyToleranceCases(): BaselineCase[] {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as {
    readings?: { 'response-tolerance'?: { proxy?: { cases?: BaselineCase[] } } };
  };
  const cases = baseline.readings?.['response-tolerance']?.proxy?.cases;
  // Fail-closed on absence: a missing group must be a red, never a loop over nothing.
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error(`the baseline carries no response-tolerance.proxy cases at ${BASELINE_PATH}`);
  }
  return cases;
}

test('AC4 proxy tolerance: the five baseline inputs read as the pre-task baseline says, and an empty transcript is a success', async () => {
  const baseline = proxyToleranceCases();
  const byName = new Map(baseline.map((entry) => [entry.name, entry]));

  for (const input of TOLERANCE_INPUTS) {
    const expected = byName.get(input.name);
    assert.ok(expected, `the baseline has no recorded case named '${input.name}'`);
    const service = makeService({ answer: () => new Response(input.body, { status: 200 }) });

    const result = await service.transcribe({ audio: audioUpload(), overrides: {} });

    assert.equal(
      result.ok,
      expected.outcome === 'ok',
      `${input.name}: the proxy path must stay ${expected.outcome}`,
    );
    if (result.ok) {
      assert.equal(result.value.text, expected.text, `${input.name}: the transcript must not move`);
    }
    emit(
      `proxy-tolerance case=${input.name} outcome=${result.ok ? 'ok' : 'error'} ` +
        `text=${JSON.stringify(result.ok ? result.value.text : undefined)}`,
    );
  }

  // The two halves of the tolerance, spelled out rather than left to the loop: an empty answer is
  // a successful transcription of silence on this path (the baseline records `ok` + `''`), and a
  // body that is not the envelope at all is handed back as the transcript verbatim.
  const empty = await makeService({
    answer: () => new Response(JSON.stringify({ text: 0 }), { status: 200 }),
  }).transcribe({ audio: audioUpload(), overrides: {} });
  assert.equal(empty.ok, true, 'an empty transcript is still a success on the proxy path');
  assert.ok(empty.ok && empty.value.text === '');

  const notJson = await makeService({
    answer: () => new Response('k-asr-not-json', { status: 200 }),
  }).transcribe({ audio: audioUpload(), overrides: {} });
  assert.ok(notJson.ok && notJson.value.text === 'k-asr-not-json');

  const nullBody = await makeService({
    answer: () => new Response('null', { status: 200 }),
  }).transcribe({ audio: audioUpload(), overrides: {} });
  assert.ok(nullBody.ok && nullBody.value.text === 'null', 'the literal `null` is the transcript');
  emit('proxy-tolerance empty-text=ok-empty not-json=verbatim null-body=literal-null');
});

// ── the response envelope: the token fields are additive, so an answer without them is unchanged ──

/**
 * The token contract's backward-compatibility reading, taken on the LIVE service rather than on a
 * re-statement of its shape.
 *
 * The `/api/voice/transcribe` body IS this service's `value` (`voice.routes.ts` answers
 * `response.json(result.value)`), and before this task that value was `{ text }` and nothing else.
 * The per-token facts and the build identity are ADDITIVE fields, so an answer that carries none —
 * which is every answer the three shipped recognisers produce, since all three declare `false/false`
 * and their adapters propagate neither — must publish the historical body EXACTLY: no `tokens: []`,
 * no `meta: {}`. A client comparing the old response byte-for-byte has to keep matching, and this is
 * the reading that says so. (The token-BEARING half of the chain is driven in
 * `src/shared/asr/tests/asrContractInvariants.test.ts`, because no shipped recogniser can produce it
 * and the task forbids adding one.)
 */
test('the response payload keeps its historical shape: a token-less answer publishes `{ text }` alone', async () => {
  const service = makeService({
    answer: () => new Response(JSON.stringify({ text: 'k-asr-answer' }), { status: 200 }),
  });
  const result = await service.transcribe({ audio: audioUpload(), overrides: {} });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable: the assertion above pins the success');

  assert.deepEqual(Object.keys(result.value).sort(), ['text'], 'the historical body grew no empty fields');
  assert.equal((result.value as { tokens?: unknown }).tokens, undefined, 'no invented `tokens`');
  assert.equal((result.value as { meta?: unknown }).meta, undefined, 'no invented `meta`');
  emit(
    `transcribe-envelope text=${JSON.stringify(result.value.text)} keys=${Object.keys(result.value).join(',')}`,
  );
});

// ── AC5: the error vocabulary, as a table ─────────────────────────────────────────────────────

type ErrorDrive = {
  code: AsrErrorCode;
  /** Printed with the row, so a failure names the provider and the condition that produced it. */
  provider: string;
  condition: string;
  drive: () => Promise<VoiceServiceResult<{ text: string }>>;
};

function abortError(): Error {
  const error = new Error('the transport was aborted');
  error.name = 'AbortError';
  return error;
}

const ERROR_DRIVES: readonly ErrorDrive[] = [
  {
    code: 'NOT_CONFIGURED',
    provider: 'openai-compatible',
    condition: 'no base URL on either side',
    drive: async () =>
      makeService({ defaults: { baseUrl: '' } }).transcribe({ audio: audioUpload(), overrides: {} }),
  },
  {
    code: 'INVALID_BASE_URL',
    provider: 'openai-compatible',
    condition: 'a configured URL that is not an http(s) URL',
    drive: async () =>
      makeService({ defaults: { baseUrl: 'not a url' } }).transcribe({
        audio: audioUpload(),
        overrides: {},
      }),
  },
  {
    code: 'UNAUTHORIZED',
    provider: 'openai-compatible',
    condition: 'the upstream answers 401',
    drive: async () =>
      makeService({ answer: () => new Response('unauthorized', { status: 401 }) }).transcribe({
        audio: audioUpload(),
        overrides: {},
      }),
  },
  {
    code: 'RATE_LIMITED',
    provider: 'openai-compatible',
    condition: 'the upstream answers 429',
    drive: async () =>
      makeService({ answer: () => new Response('slow down', { status: 429 }) }).transcribe({
        audio: audioUpload(),
        overrides: {},
      }),
  },
  {
    code: 'UPSTREAM_UNAVAILABLE',
    provider: 'openai-compatible',
    condition: 'the transport rejects with an AbortError',
    drive: async () =>
      makeService({
        answer: () => {
          throw abortError();
        },
      }).transcribe({ audio: audioUpload(), overrides: {} }),
  },
  {
    code: 'UPSTREAM_UNAVAILABLE',
    provider: 'openai-compatible',
    condition: 'the transport rejects',
    drive: async () =>
      makeService({
        answer: () => {
          throw new Error('connection refused');
        },
      }).transcribe({ audio: audioUpload(), overrides: {} }),
  },
  {
    code: 'OVERSIZE',
    provider: 'openai-compatible',
    condition: 'an upload past the provider budget',
    drive: async () =>
      makeService({}).transcribe({
        audio: audioUpload({ byteLength: 26 * 1024 * 1024 }),
        overrides: {},
      }),
  },
  {
    code: 'UNSUPPORTED_MIME',
    provider: 'openai-compatible',
    condition: 'a container outside the declaration',
    drive: async () =>
      makeService({}).transcribe({
        audio: audioUpload({ mimeType: 'audio/not-declared' }),
        overrides: {},
      }),
  },
  {
    code: 'NO_SPEECH_DETECTED',
    provider: dashscopeOmniId,
    condition: 'a written answer with neither an instruction nor a transcript',
    drive: async () =>
      makeService({
        answer: () => chatAnswer('{}'),
      }).transcribe({ audio: audioUpload(), overrides: { providerId: dashscopeOmniId } }),
  },
  {
    code: 'UPSTREAM_UNAVAILABLE',
    provider: dashscopeOmniId,
    condition: 'a 200 answer that is not a chat completion envelope',
    drive: async () =>
      makeService({
        answer: () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      }).transcribe({ audio: audioUpload(), overrides: { providerId: dashscopeOmniId } }),
  },
];

test('AC5 the code→status table: a row per member, each driven to the status it names', async () => {
  // The table's own keys, which is what makes "one row per member" mechanical: the table is typed
  // `Readonly<Record<AsrErrorCode, number>>`, so a member added to the vocabulary and left without
  // a row fails `npm run typecheck` rather than going quietly unmapped.
  for (const code of Object.keys(PROVIDER_ERROR_STATUS) as AsrErrorCode[]) {
    const status = PROVIDER_ERROR_STATUS[code];
    emit(`provider-error-status ${code}=${status ?? 'UNMAPPED'}`);
  }

  // The rows this criterion pinned before this task, at the numbers it pinned: every one of them is
  // unchanged, which is the reading that says the vocabulary grew around them rather than under them.
  assert.equal(PROVIDER_ERROR_STATUS.NOT_CONFIGURED, 503);
  assert.equal(PROVIDER_ERROR_STATUS.INVALID_BASE_URL, 400);
  assert.equal(PROVIDER_ERROR_STATUS.UNAUTHORIZED, 502);
  assert.equal(PROVIDER_ERROR_STATUS.RATE_LIMITED, 429);
  assert.equal(PROVIDER_ERROR_STATUS.OVERSIZE, 413);
  assert.equal(PROVIDER_ERROR_STATUS.UNSUPPORTED_MIME, 415);
  assert.equal(PROVIDER_ERROR_STATUS.NO_SPEECH_DETECTED, 422);
  // And every other row the vocabulary has is read too, so a missing one cannot hide in the rows
  // above. The three transport failures that used to be three rows (`TIMEOUT` 504, `UNREACHABLE` 502,
  // `UPSTREAM_ERROR` 502) are one member now — `UPSTREAM_UNAVAILABLE` — and it keeps the 502 the two
  // of them shared.
  assert.equal(PROVIDER_ERROR_STATUS.ACCOUNT_ACCESS, 403);
  assert.equal(PROVIDER_ERROR_STATUS.QUOTA_EXHAUSTED, 429);
  assert.equal(PROVIDER_ERROR_STATUS.MODEL_NOT_FOUND, 404);
  assert.equal(PROVIDER_ERROR_STATUS.AUDIO_REJECTED, 400);
  assert.equal(PROVIDER_ERROR_STATUS.CONTENT_FLAGGED, 422);
  assert.equal(PROVIDER_ERROR_STATUS.UPSTREAM_UNAVAILABLE, 502);

  for (const drive of ERROR_DRIVES) {
    const result = await drive.drive();
    const answered = result.ok ? 'ok' : result.status;
    emit(
      `provider-error-drive ${drive.code} provider=${drive.provider} ` +
        `condition="${drive.condition}" answered=${answered}`,
    );
    assert.equal(result.ok, false, `${drive.code}: the drive was expected to fail`);
    assert.equal(
      result.ok ? 'ok' : result.status,
      PROVIDER_ERROR_STATUS[drive.code],
      `${drive.code}: the service must answer the table's status`,
    );
  }

  // The one cell the table does not have the last word on: an `UPSTREAM_UNAVAILABLE` that carries the
  // status its adapter read off the transport is answered with that status, not with the table's
  // 502 — the upstream's own answer about itself, which this path has always passed through.
  const passthrough = await makeService({
    answer: () => new Response('no such model', { status: 404 }),
  }).transcribe({ audio: audioUpload(), overrides: {} });
  assert.equal(passthrough.ok, false);
  assert.equal(passthrough.ok ? 0 : passthrough.status, 404);
  emit('provider-error-passthrough upstream=404 client=404');
});

// ── AC6: registration order and the health payload ────────────────────────────────────────────

test('AC6 the address book still opens with the factory entry and keeps every earlier row in place', () => {
  const ids = listProviders().map((adapter) => adapter.id);
  emit(`provider-order ${ids.join(' ')}`);
  assert.equal(ids[0], 'openai-compatible', 'an id-less deployment must keep resolving to the factory entry');
  // THE REGISTRY IS APPEND-ONLY, WHICH IS THE PROPERTY THIS ROW WAS ALWAYS ABOUT — and it is read as
  // a PREFIX now, because "the last id is dashscope-omni" was a statement about the address book as
  // it stood when that row was added, not about what appending does. A fifth recogniser keeps this
  // green without an edit; a row that INSERTS itself, or that reorders what an id-less deployment
  // resolves to, still reds — which is the failure the original assertion was there to catch.
  assert.deepEqual(
    ids.slice(0, 3),
    ['openai-compatible', 'multimodal', dashscopeOmniId],
    'the rows that existed before this one are unmoved and in order',
  );
  assert.ok(ids.indexOf(dashscopeOmniId) < ids.length - 1, 'a row was appended after dashscope-omni rather than inserted before it');
  assert.equal(dashscopeOmniId, 'dashscope-omni');

  const service = makeService({});
  const health = service.getHealth({ settings: NO_USER_SETTINGS });
  assert.equal(health.ok, true);
  assert.equal(health.ok && health.value.provider, 'openai-compatible', 'the effective provider is unmoved');

  const entry = listProviders().find((adapter) => adapter.id === dashscopeOmniId);
  assert.ok(entry, 'the new provider is registered');
  // The declaration the registry hands out IS the module's own object, so a field changed in the
  // adapter changes what every consumer sees without a second edit in the registry.
  assert.equal(entry.capabilities === dashscopeOmniCapabilities, true);
  assert.deepEqual(entry.capabilities, dashscopeOmniCapabilities);

  const healthRow = health.ok
    ? health.value.providers.find((provider) => provider.id === dashscopeOmniId)
    : undefined;
  assert.ok(healthRow, 'the health payload publishes a row for the new provider');
  assert.equal(healthRow.capabilities === dashscopeOmniCapabilities, true);
  emit(`provider-capabilities ${dashscopeOmniId}=module-object health-provider=openai-compatible`);
});

// ── the relay row: context in the system turn, on the same chat wire ──────────────────────────

/**
 * The relay adapter, entered through the registry for the same TDZ reason the E adapter is.
 *
 * The row is a separate provider rather than a mode on `dashscope-omni`: the E prompt is a frozen
 * measured artefact, and the relay prompt is the voice-input experiment's N1 arm. This reading
 * drives the service, not the adapter directly, so it also proves the new row is dispatched through
 * the same seam.
 */
const dashscopeRelay = await import(
  '../../../../shared/asr/list/dashscope-omni-relay/dashscope-omni-relay.asr-provider.js'
);
const dashscopeRelayId = dashscopeRelay.id;

test('relay: the context is in the system turn and the tidied text is the answer', async () => {
  const calls: Recorded[] = [];
  const service = makeService({
    calls,
    answer: () => chatAnswer('现在可以看到 architecture tab 架构图了，但是看不出继承关系。'),
  });
  const settings: VoiceSettings = {
    ...NO_USER_SETTINGS,
    dashscopeEndpoint: 'https://dashscope.aliyuncs.com',
    dashscopeApiKey: 'k-relay',
  };
  const context = '用户：architecture tab 的图里所有节点箭头都一样，看不出继承关系。';

  const result = await service.transcribe({
    audio: audioUpload(),
    overrides: { providerId: dashscopeRelayId },
    settings,
    hints: { context },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.text : '', '现在可以看到 architecture tab 架构图了，但是看不出继承关系。');
  assert.equal(calls.length, 1, 'the relay row reaches the same outbound port as every other adapter');
  assert.equal(calls[0].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');

  const body = JSON.parse(String(calls[0].body)) as {
    messages: { role: string; content: unknown }[];
    reasoning_effort: string;
  };
  const [system, user] = body.messages;
  assert.equal(system.role, 'system');
  assert.equal(typeof system.content, 'string');
  assert.match(String(system.content), /architecture tab/, 'the context is part of the system instructions');
  assert.doesNotMatch(
    JSON.stringify(user.content),
    /architecture tab/,
    'the context is not repeated as user speech',
  );
  assert.match(String(system.content), /把这段录音整理成要发出去的文字/, 'the task is system-only');
  assert.deepEqual(
    (user.content as { type?: unknown }[]).map((part) => part.type),
    ['input_audio'],
    'the user turn is the recording alone; the task must not sit beside it',
  );
  assert.equal(body.reasoning_effort, 'low');
  emit(`relay context=system provider=${dashscopeRelayId} url=${calls[0].url}`);
});

test('relay prompt: the task is system-only and the user turn carries the recording alone', async () => {
  const calls: Recorded[] = [];
  const service = makeService({ calls, answer: () => chatAnswer('好，我们就现场试一下。') });
  const settings: VoiceSettings = {
    ...NO_USER_SETTINGS,
    dashscopeEndpoint: 'https://dashscope.aliyuncs.com',
    dashscopeApiKey: 'k-relay',
  };

  const result = await service.transcribe({
    audio: audioUpload(),
    overrides: { providerId: dashscopeRelayId },
    settings,
  });

  assert.equal(result.ok, true);
  const body = JSON.parse(String(calls[0].body)) as {
    messages: { role: string; content: unknown }[];
  };
  const system = String(body.messages[0].content);
  const user = body.messages[1].content;
  assert.match(system, /TASK \(never output this\): /, 'the task sentence must be in the system turn');
  assert.match(system, /THE AUDIO IS THE ONLY SOURCE OF CONTENT\./);
  assert.ok(Array.isArray(user), 'the user turn is the parts array');
  assert.deepEqual(
    (user as { type?: unknown }[]).map((part) => part.type),
    ['input_audio'],
    'the user turn must carry the recording and no text part — a task beside the audio is what a silent clip echoed back',
  );
  assert.ok(
    !JSON.stringify(user).includes(dashscopeRelay.RELAY_TASK),
    'the task sentence must not appear anywhere in the user turn',
  );
  emit(`relay prompt=system-only user-parts=${(user as { type?: unknown }[]).length}`);
});

test('relay: a JSON-shaped dictation is returned as text, not mistaken for an envelope', async () => {
  const calls: Recorded[] = [];
  const dictation = '{"feature":"voice","enabled":true}';
  const service = makeService({ calls, answer: () => chatAnswer(dictation) });
  const settings: VoiceSettings = {
    ...NO_USER_SETTINGS,
    dashscopeEndpoint: 'https://dashscope.aliyuncs.com',
    dashscopeApiKey: 'k-relay',
  };

  const result = await service.transcribe({
    audio: audioUpload(),
    overrides: { providerId: dashscopeRelayId },
    settings,
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.text : '', dictation);
  emit(`relay json-shaped-dictation=preserved provider=${dashscopeRelayId}`);
});

test('relay: an absent context leaves the system prompt at the no-context arm', async () => {
  const calls: Recorded[] = [];
  const service = makeService({ calls, answer: () => chatAnswer('丢词丢得太厉害。') });
  const settings: VoiceSettings = {
    ...NO_USER_SETTINGS,
    dashscopeEndpoint: 'https://dashscope.aliyuncs.com',
    dashscopeApiKey: 'k-relay',
  };

  const result = await service.transcribe({
    audio: audioUpload(),
    overrides: { providerId: dashscopeRelayId },
    settings,
  });

  assert.equal(result.ok, true);
  const body = JSON.parse(String(calls[0].body)) as { messages: { content: unknown }[] };
  assert.doesNotMatch(String(body.messages[0].content), /以下是当前 Claude Code 会话的上下文/);
  emit(`relay context=absent provider=${dashscopeRelayId}`);
});

// ── AC10: what this task does not do, and the transport it never uses ─────────────────────────

/**
 * The scope statement, printed with the criterion and carried into the completion record.
 *
 * The transport double below is what makes the "never a real DashScope" half of it a reading rather
 * than a promise: with `globalThis.fetch` replaced by a thrower, a transcribe through the chat
 * wire still completes, and the thrower is never called.
 */
test('AC10 scope: proxy-only routing, not SSRF policy or credential config or browser E2E, and no live recogniser', async () => {
  const realFetch = globalThis.fetch;
  let liveCalls = 0;
  globalThis.fetch = (() => {
    liveCalls += 1;
    throw new Error('the criterion must never reach a recogniser');
  }) as typeof fetch;

  try {
    const calls: Recorded[] = [];
    const result = await makeService({
      calls,
      defaults: { providerId: dashscopeOmniId },
      answer: () => chatAnswer('{"transcript":"k-offline"}'),
    }).transcribe({ audio: audioUpload(), overrides: {} });

    assert.equal(result.ok, true, 'the injected transport carries the whole reading');
    assert.equal(calls.length, 1, 'the recorded double is the request that was made');
    assert.equal(liveCalls, 0, 'no reading in this file may reach the global transport');
  } finally {
    globalThis.fetch = realFetch;
  }

  emit(
    'scope this task registers and dispatches a provider on the proxy path only: ' +
      'proxy-only routing and SSRF policy are AC-140, user configuration and key masking are ' +
      'AC-141, the browser end-to-end path is AC-142. Every reading runs under an injected ' +
      'transport; the live DashScope smoke is a human step (ADR-004 decision 8).',
  );
});
