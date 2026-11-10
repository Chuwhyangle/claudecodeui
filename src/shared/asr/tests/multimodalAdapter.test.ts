/**
 * The second adapter, driven directly — the unit lane beside the behavioural probe
 * (`scripts/asr-second-adapter-check.mjs`, AC-132).
 *
 * The probe is the criterion's instrument: it builds a fixture out of the shipping files, mutates
 * it, and shows each fake form going red. This file is the cheaper, always-on half — it exercises
 * the same declarations and the same guards in the suite that runs on every change, so a
 * regression is caught by a failing assertion rather than only by the probe's fault injection.
 *
 * It lives under `src/` because that is where the unit suite is collected from; the module under
 * test lives in the repository-root `shared/` tree, which the frontend reaches through the
 * `@shared` alias (ADR-004 decision 2). Importing it here is the alias's third registration being
 * used for real rather than merely asserted.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  UnknownAsrProviderError,
  listProviders,
  resolve,
  tryResolve,
  type AsrInvocation,
  type AsrRequest,
} from '@shared/asr/asrRegistry';
import {
  TRANSCRIPTION_INSTRUCTION,
  capabilities,
  generateContentEndpoint,
  id,
  measureInlineRequestBytes,
  mergeTranscriptLines,
  readTranscriptText,
  transcribe,
} from '@shared/asr/list/multimodal/multimodal.asr-provider';
import { honoredHints } from '@shared/asr/contract/asrContract';
import { base64Length } from '@shared/asr/contract/transcriptionWire';

const ENVELOPE = JSON.stringify({
  candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }],
});

/**
 * The two input sizes the budget cases need, DERIVED from the declaration rather than typed in:
 * a declaration whose budget shrinks has to move these with it, or the cases would quietly stop
 * testing anything. The two guards below fail the file if the derived sizes stop straddling the
 * budget, so a stale derivation is a red rather than a vacuous green.
 */
const BUDGET = capabilities.maxInlineRequestBytes;
const AFFORDABLE_AUDIO_BYTES = Math.floor((BUDGET * 0.75) / 4) * 3;
const OVERSIZE_AUDIO_BYTES = Math.ceil((BUDGET + 1) / 4) * 3;
const OVERSIZE_CONTEXT_CHARS = BUDGET - base64Length(AFFORDABLE_AUDIO_BYTES) + 1024;

function audioOf(byteLength: number): AsrRequest['audio'] {
  return { bytes: new Uint8Array(byteLength), mimeType: 'audio/webm;codecs=opus', fileName: 'clip.webm' };
}

function standIn(body: string, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? undefined });
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

function invocationFor(stand: ReturnType<typeof standIn>): AsrInvocation {
  return {
    // `.invalid` never resolves: this file must not be able to reach a real service even by
    // accident, which is what makes the readings below offline readings (AC7).
    baseUrl: 'https://asr.invalid',
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 1000,
    fetchImpl: stand.fetchImpl,
  };
}

/**
 * The headers a stand-in recorded, lower-cased, so a reading can name the header it asks about.
 *
 * Hand-written rather than reached for from `Headers`: the adapter passes a plain object, and a
 * reader that only understood a `Headers` instance would report every request as carrying nothing.
 */
function headersOf(init: RequestInit | undefined): Record<string, string> {
  const raw: unknown = init?.headers;
  const found: Record<string, string> = {};
  if (raw === undefined || raw === null) return found;
  if (typeof (raw as Headers).forEach === 'function') {
    (raw as Headers).forEach((value, key) => {
      found[String(key).toLowerCase()] = String(value);
    });
    return found;
  }
  if (Array.isArray(raw)) {
    for (const entry of raw as [string, string][]) {
      found[String(entry[0]).toLowerCase()] = String(entry[1]);
    }
    return found;
  }
  for (const key of Object.keys(raw as Record<string, string>)) {
    found[key.toLowerCase()] = String((raw as Record<string, string>)[key]);
  }
  return found;
}

/** The body a stand-in was handed, as the string the adapter wrote. */
function bodyOf(stand: ReturnType<typeof standIn>): string {
  return String(stand.calls[0]?.init?.body ?? '');
}

/** The body as the JSON object it is, so a reading can name the field it means. */
function jsonOf(stand: ReturnType<typeof standIn>): Record<string, unknown> {
  return JSON.parse(bodyOf(stand)) as Record<string, unknown>;
}

describe('the declared sizes straddle the declared budget', () => {
  it('sizes the two budget cases so each one can only pass for the right reason', () => {
    expect(base64Length(AFFORDABLE_AUDIO_BYTES)).toBeLessThan(BUDGET);
    expect(base64Length(OVERSIZE_AUDIO_BYTES)).toBeGreaterThan(BUDGET);
    expect(OVERSIZE_CONTEXT_CHARS).toBeGreaterThan(0);
  });
});

describe('registration', () => {
  it('resolves the adapter by id, and the registry hands back the module’s own declaration (AC6)', () => {
    const resolved = resolve(id);

    expect(resolved.id).toBe(id);
    expect(resolved.capabilities).toEqual(capabilities);
    expect(listProviders().map((adapter) => adapter.id)).toContain(id);
  });

  it('fails closed on an unregistered id instead of falling back to a default', () => {
    expect(tryResolve('no-such-provider')).toBeNull();
    expect(() => resolve('no-such-provider')).toThrow(UnknownAsrProviderError);
  });

  it('declares an explicit rejection as the only oversize policy (AC5)', () => {
    expect(capabilities.oversize).toBe('reject');
    for (const adapter of listProviders()) {
      expect(adapter.capabilities.oversize).toBe('reject');
    }
  });
});

describe('the inline budget is the whole request', () => {
  it('refuses an over-budget request without spending an upstream call (AC1)', async () => {
    const stand = standIn(ENVELOPE);
    const spy = vi.spyOn(globalThis, 'fetch');

    const result = await transcribe({ audio: audioOf(OVERSIZE_AUDIO_BYTES) }, invocationFor(stand));

    expect(result).toMatchObject({ ok: false, code: 'OVERSIZE' });
    expect(stand.calls).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts the audio alone and refuses the same audio once a long context joins it (AC2)', async () => {
    const alone = standIn(ENVELOPE);
    const aloneResult = await transcribe({ audio: audioOf(AFFORDABLE_AUDIO_BYTES) }, invocationFor(alone));
    expect(aloneResult.ok).toBe(true);
    expect(alone.calls).toHaveLength(1);

    const withContext = standIn(ENVELOPE);
    const withContextResult = await transcribe(
      { audio: audioOf(AFFORDABLE_AUDIO_BYTES), hints: { context: 'x'.repeat(OVERSIZE_CONTEXT_CHARS) } },
      invocationFor(withContext),
    );

    // The audio is the same object size in both calls, so only the budget's SCOPE can explain the
    // two different verdicts. An implementation that measures the audio bytes alone accepts both.
    expect(withContextResult).toMatchObject({ ok: false, code: 'OVERSIZE' });
    expect(withContext.calls).toHaveLength(0);
  });

  it('counts the context and the prompt into the measured size, not just the audio', () => {
    const audio = audioOf(2048);
    const bare = measureInlineRequestBytes({ audio }, {}, 'test-model');
    const withContext = measureInlineRequestBytes({ audio }, { context: 'x'.repeat(5000) }, 'test-model');

    expect(bare).toBeGreaterThan(base64Length(audio.bytes.length));
    // The whole context is charged, not a sample of it: the delta is the context plus the fixed
    // JSON scaffolding of the part carrying it, so it is bounded above as well as below.
    expect(withContext - bare).toBeGreaterThanOrEqual(5000);
    expect(withContext - bare).toBeLessThan(5000 + 64);
  });
});

describe('hints', () => {
  it('leaves an unacknowledged hint off the wire rather than sending it empty (AC3)', async () => {
    const stand = standIn(ENVELOPE);

    await transcribe(
      {
        audio: audioOf(2048),
        hints: { prompt: 'a prompt this provider does not acknowledge', language: 'zh', context: 'revenue policy' },
      },
      invocationFor(stand),
    );

    const body = String(stand.calls[0]?.init?.body ?? '');
    expect(body).not.toContain('a prompt this provider does not acknowledge');
    expect(body).not.toContain('systemInstruction');
    expect(JSON.parse(body)).not.toHaveProperty('systemInstruction');
    // The positive control: what IS acknowledged is on the wire, so the absences above cannot be
    // satisfied by a body builder that sends no hints at all.
    expect(body).toContain('revenue policy');
  });

  it('drops exactly the hints the declaration does not acknowledge', () => {
    const hints = { prompt: 'p', language: 'zh', context: 'c' };

    expect(honoredHints(capabilities, hints)).toEqual({ context: 'c' });
    expect(honoredHints(capabilities, undefined)).toEqual({});
  });
});

/**
 * THE REAL-WIRE CORRECTION, and why these labels are not bare numbers.
 *
 * The `ACn` labels above are AC-132's — the second adapter's own criteria. The cases below carry
 * `real-wire ACn`: the criteria of the task that corrected this adapter against the live service
 * (`gap-asr-multimodal-adapter-real-gemini-wire`), which are a different set of claims. Both are
 * real, so a bare number would make two different statements answer to one label.
 *
 * Every case below is falsifiable by restoring the behaviour it replaced: the credential header,
 * the instruction part, the request-level budget that counts it, the model-name rule, the line
 * merge, the failure envelope, and the style declaration. The measured sizes are derived rather
 * than typed in, so a declaration that moves carries these cases with it.
 */
describe('the credential travels in this service’s own header (real-wire AC1)', () => {
  it('sends the key in x-goog-api-key and leaves Authorization off the request', async () => {
    const stand = standIn(ENVELOPE);

    await transcribe({ audio: audioOf(1024) }, invocationFor(stand));

    const headers = headersOf(stand.calls[0]?.init);
    expect(headers['x-goog-api-key']).toBe('test-key');
    // The header this adapter shipped first, and the one the live service answers with
    // `Expected OAuth 2 access token`: a bare API key is not a bearer token, and the request that
    // carries it in `Authorization` is rejected before it is read.
    expect(headers).not.toHaveProperty('authorization');
  });

  it('announces neither header when there is no credential to announce', async () => {
    const stand = standIn(ENVELOPE);

    await transcribe({ audio: audioOf(1024) }, { ...invocationFor(stand), apiKey: '' });

    const headers = headersOf(stand.calls[0]?.init);
    expect(headers).not.toHaveProperty('x-goog-api-key');
    expect(headers).not.toHaveProperty('authorization');
  });
});

describe('the adapter asks for a transcript in its own words (real-wire AC2)', () => {
  it('carries a verbatim-transcription instruction as a part of the request', async () => {
    const stand = standIn(ENVELOPE);

    await transcribe({ audio: audioOf(1024) }, invocationFor(stand));

    const body = jsonOf(stand) as { contents: { parts: { text?: string }[] }[] };
    const texts = body.contents[0].parts
      .map((part) => part.text)
      .filter((text): text is string => text !== undefined);
    expect(texts).toContain(TRANSCRIPTION_INSTRUCTION);
    // What the instruction is, read independently of the adapter's own constant: without an
    // instruction the live service answers in whatever shape it likes — measured, a subtitle script
    // at a mean CER of 2.24 on this repository's own corpus.
    expect(TRANSCRIPTION_INSTRUCTION).toContain('逐字转写');
    expect(TRANSCRIPTION_INSTRUCTION.length).toBeGreaterThan(10);
  });

  it('sends the caller’s prompt nowhere, and the context to the wire', async () => {
    const stand = standIn(ENVELOPE);

    await transcribe(
      {
        audio: audioOf(1024),
        hints: { prompt: 'a prompt this provider does not acknowledge', context: 'revenue policy' },
      },
      invocationFor(stand),
    );

    // The instruction above did NOT become a `systemInstruction`: the contract suite identifies the
    // caller's prompt by that field, so an adapter that moved its own instruction there would be
    // forwarding a hint its declaration promised not to forward.
    expect(bodyOf(stand)).not.toContain('systemInstruction');
    expect(bodyOf(stand)).not.toContain('a prompt this provider does not acknowledge');
    // The positive control: what IS acknowledged is on the wire, so the absences above cannot be
    // satisfied by a body builder that sends no hints at all.
    expect(bodyOf(stand)).toContain('revenue policy');
  });
});

describe('the request-level budget counts the instruction (real-wire AC3)', () => {
  it('measures the request it is about to send, byte for byte', async () => {
    const stand = standIn(ENVELOPE);
    const request: AsrRequest = {
      audio: audioOf(AFFORDABLE_AUDIO_BYTES),
      hints: { context: '审计口径'.repeat(200) },
    };

    await transcribe(request, invocationFor(stand));

    expect(stand.calls).toHaveLength(1);
    // Measured with an encoder rather than with the adapter's own helper: a reading taken with the
    // function under test could not disagree with it, and "the budget matches the bytes" is exactly
    // the claim that must be able to disagree.
    expect(measureInlineRequestBytes(request, honoredHints(capabilities, request.hints), 'test-model')).toBe(
      new TextEncoder().encode(bodyOf(stand)).length,
    );
  });

  it('refuses an audio that fits alone but not once the instruction joins it', async () => {
    // The pair of sizes is derived from the declaration and from the adapter's own skeleton, and the
    // assertions state the straddle the case rests on: the audio's ENCODING is inside the budget
    // while the WHOLE REQUEST is over it. An audio-only guard accepts this upload.
    const skeletonBytes = measureInlineRequestBytes({ audio: audioOf(0) }, {}, 'test-model');
    const justInside = Math.floor((BUDGET - Math.floor(skeletonBytes / 2)) / 4) * 3;
    expect(base64Length(justInside)).toBeLessThan(BUDGET);
    expect(skeletonBytes + base64Length(justInside)).toBeGreaterThan(BUDGET);

    const stand = standIn(ENVELOPE);
    const result = await transcribe({ audio: audioOf(justInside) }, invocationFor(stand));

    expect(result).toMatchObject({ ok: false, code: 'OVERSIZE' });
    expect(stand.calls).toHaveLength(0);
  });
});

describe('the decode configuration follows the model name (real-wire AC4)', () => {
  it('asks a 2.5-series model for no sampling and no thinking budget', async () => {
    const stand = standIn(ENVELOPE);

    await transcribe({ audio: audioOf(1024) }, { ...invocationFor(stand), model: 'gemini-2.5-flash-lite' });

    const body = jsonOf(stand) as {
      generationConfig: { temperature: number; thinkingConfig?: { thinkingBudget: number } };
    };
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(bodyOf(stand)).toContain('"thinkingBudget":0');
  });

  it('sends no thinking field to a model that does not take one', async () => {
    const stand = standIn(ENVELOPE);

    await transcribe({ audio: audioOf(1024) }, { ...invocationFor(stand), model: 'gemini-3.5-flash-lite' });

    expect(bodyOf(stand)).toContain('"temperature":0');
    // A field the model does not take is answered with a 400, so "not in the series" has to mean
    // "no field at all" rather than "a field of zero".
    expect(bodyOf(stand)).not.toContain('thinkingBudget');
    expect(jsonOf(stand)).not.toHaveProperty('generationConfig.thinkingConfig');
  });
});

describe('the model’s line breaks are joined away (real-wire AC5)', () => {
  it('joins the three measured shapes the way each script needs them', () => {
    // Latin either side: the break stands for a word boundary, so it becomes one space.
    expect(mergeTranscriptLines('server\n的\nvoice.se')).toBe('server 的 voice.se');
    expect(mergeTranscriptLines('把默认模型换成\nwhisper')).toBe('把默认模型换成 whisper');
    // CJK both sides: the break is the model's own wrapping, and a space inside a phrase is an edit
    // the speaker never made.
    expect(mergeTranscriptLines('模块下的\n目录')).toBe('模块下的目录');
  });

  it('leaves a transcript with no break in it alone', () => {
    expect(mergeTranscriptLines('hello world')).toBe('hello world');
    expect(mergeTranscriptLines('  padded  ')).toBe('padded');
    expect(mergeTranscriptLines('\n\n')).toBe('');
  });

  it('reads a broken answer out of the envelope as one transcript', async () => {
    const stand = standIn(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'server\n的\nvoice.se' }] } }] }),
    );

    const result = await transcribe({ audio: audioOf(1024) }, invocationFor(stand));

    expect(result).toMatchObject({ ok: true, text: 'server 的 voice.se' });
  });
});

describe('the failure is read for what it says (real-wire AC6)', () => {
  it('reads a 400 whose body names the key as a credential failure', async () => {
    // The live service answers an invalid API key with 400, not 401 — so the status alone cannot
    // reach the credential code and the body has to be read.
    const stand = standIn(
      JSON.stringify({
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: 'API key not valid. Please pass a valid API key.',
          details: [{ reason: 'API_KEY_INVALID' }],
        },
      }),
      400,
    );

    const result = await transcribe({ audio: audioOf(1024) }, invocationFor(stand));

    expect(result).toMatchObject({ ok: false, code: 'UNAUTHORIZED', status: 400 });
  });

  it('keeps an ordinary 400 out of the credential vocabulary', async () => {
    const stand = standIn(JSON.stringify({ error: { code: 400, message: 'bad request' } }), 400);

    const result = await transcribe({ audio: audioOf(1024) }, invocationFor(stand));

    expect(result).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE', status: 400 });
  });

  it('reports a refusal as an upstream fault naming the reason, not as silence', async () => {
    const blocked = await transcribe(
      { audio: audioOf(1024) },
      invocationFor(standIn(JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }))),
    );
    expect(blocked).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' });
    expect(blocked.ok === false ? blocked.message : '').toContain('SAFETY');

    const promptBlocked = await transcribe(
      { audio: audioOf(1024) },
      invocationFor(
        standIn(JSON.stringify({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, candidates: [] })),
      ),
    );
    expect(promptBlocked).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' });
    expect(promptBlocked.ok === false ? promptBlocked.message : '').toContain('PROHIBITED_CONTENT');

    // The positive control: a model that simply produced nothing is still silence, so the two
    // readings above are about the reason rather than about every empty answer.
    const silent = await transcribe(
      { audio: audioOf(1024) },
      invocationFor(standIn(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] }))),
    );
    expect(silent).toMatchObject({ ok: false, code: 'NO_SPEECH_DETECTED' });
  });
});

describe('the style declaration is the wire’s, not a wish (real-wire AC7)', () => {
  it('declares verbatim and answers with the transformations it performs', async () => {
    const stand = standIn(ENVELOPE);

    const result = await transcribe({ audio: audioOf(1024) }, invocationFor(stand));

    // `written` was a claim about an instruction no request ever carried: measured on this corpus,
    // asking for a written-up answer is WORSE (CER 0.456 against a verbatim instruction's 0.195).
    expect(resolve(id).capabilities.style).toBe('verbatim');
    expect(capabilities.style).toBe('verbatim');
    expect(result).toMatchObject({ ok: true, style: 'verbatim', transformations: ['punctuate'] });
  });
});

describe('the answer envelope', () => {
  it('reads the text out of the generation envelope (AC4)', async () => {
    const stand = standIn(ENVELOPE);

    const result = await transcribe({ audio: audioOf(1024) }, invocationFor(stand));

    expect(result).toMatchObject({ ok: true, text: 'hello world', style: 'verbatim', providerId: id });
    expect(stand.calls[0]?.url).toBe(generateContentEndpoint('https://asr.invalid', 'test-model'));
  });

  it('never returns a body that is not the envelope as if it were a transcript (AC4)', async () => {
    const gatewayError = standIn(JSON.stringify({ error: { code: 429, message: 'quota exceeded' } }));
    const gatewayResult = await transcribe({ audio: audioOf(1024) }, invocationFor(gatewayError));

    expect(gatewayResult.ok).toBe(false);

    const htmlError = standIn('<html><body>502 Bad Gateway</body></html>');
    const htmlResult = await transcribe({ audio: audioOf(1024) }, invocationFor(htmlError));

    expect(htmlResult.ok).toBe(false);
    expect(readTranscriptText(ENVELOPE)).toBe('hello world');
  });

  it('maps an upstream status onto the semantic error vocabulary', async () => {
    const unauthorized = await transcribe({ audio: audioOf(1024) }, invocationFor(standIn('{}', 401)));
    const limited = await transcribe({ audio: audioOf(1024) }, invocationFor(standIn('{}', 429)));

    expect(unauthorized).toMatchObject({ ok: false, code: 'UNAUTHORIZED', status: 401 });
    expect(limited).toMatchObject({ ok: false, code: 'RATE_LIMITED', status: 429 });
  });

  it('refuses a container it does not declare, before sizing anything', async () => {
    const stand = standIn(ENVELOPE);

    const result = await transcribe({ audio: { ...audioOf(1024), mimeType: 'video/mp4' } }, invocationFor(stand));

    expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_MIME' });
    expect(stand.calls).toHaveLength(0);
  });
});
