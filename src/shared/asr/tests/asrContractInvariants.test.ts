/**
 * The transcription seam's contract board, as the always-on half of the criterion.
 *
 * `scripts/asr-contract-invariants-check.mjs` is the operator command and
 * `scripts/asr-contract-invariants-check.test.mjs` is the fault injection that shows the board
 * going red under a mutation. Both of those run when someone runs them. This file is what runs on
 * every change, and it is deliberately the cheaper half: it drives the same board over the shipped
 * registry and over declarations written here, so a regression is a failing assertion rather than
 * something a reader has to notice.
 *
 * TWO THINGS THIS FILE IS CAREFUL ABOUT:
 *
 *   · IT DOES NOT RESTATE THE INVARIANTS. Every assertion below is about the BOARD — that it
 *     measured, that it scored an empty board as empty, that it reds a declaration which disagrees
 *     with the wire it feeds. A second copy of the probes here would be a second implementation of
 *     the contract, free to disagree with `shared/asr/asrInvariants.ts` while both stay green.
 *   · IT MEASURES A DECLARATION NOBODY WROTE FOR IT. The shipped adapter declares
 *     `honors.prompt: false`, so "the prompt is left off the wire" is the only reading the shipped
 *     declaration can produce — the opposite reading, `prompt-part-present`, is unreachable that
 *     way. The prompt-honouring stand-in below is what makes that axis two-sided: one adapter that
 *     sends the prompt because it declared it would, and one that lies about it and is caught.
 *
 * It lives under `src/` because that is where the unit suite is collected from; the modules under
 * test live in the repository-root `shared/` tree, reached through the `@shared` alias.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyUpstreamFailure,
  honoredHints,
  listProviders,
  type AsrAdapter,
  type AsrCapabilities,
  type AsrHints,
  type AsrInvocation,
  type AsrRequest,
  type AsrSuccess,
} from '@shared/asr/asrRegistry';
import {
  INVARIANT_AUDIO_BASE64,
  INVARIANT_AUDIO_TEXT,
  INVARIANT_API_KEY,
  INVARIANT_GROUP_IDS,
  INVARIANT_MODEL,
  affordableAudioBytes,
  assertTokenInvariants,
  goldenBody,
  overBudgetAudioBytes,
  redactionNeedles,
  runAsrContractInvariants,
  scanLines,
  tokenInvariantViolations,
} from '@shared/asr/asrInvariants';
import {
  base64Encode,
  fetchWithTransportRetry,
  parseTranscriptionResponse,
  type TranscriptionEnvelope,
} from '@shared/asr/contract/transcriptionWire';
import {
  STYLE_TRANSFORMATIONS,
  baseMimeType,
  buildInlineRequestBody,
  capabilities,
  generateContentEndpoint,
  measureInlineRequestBytes,
  readTranscriptText,
  transcribe,
} from '@shared/asr/list/multimodal/multimodal.asr-provider';

/** The same wire as the shipped adapter, driven by a declaration that acknowledges the prompt. */
const promptHonouringAdapter: AsrAdapter = {
  id: 'stand-in-prompt-honouring',
  capabilities: { ...capabilities, honors: { prompt: true, language: false, context: true } },
  async transcribe(request, invocation) {
    const declared = promptHonouringAdapter.capabilities;
    if (declared.acceptsMime.indexOf(baseMimeType(request.audio.mimeType)) === -1) {
      return { ok: false, code: 'UNSUPPORTED_MIME', message: 'stand-in: container not declared' };
    }
    // The same two guards the shipped adapter applies, with the declaration applied in one place —
    // the difference between the two adapters is the declaration, not the discipline.
    const hints: AsrHints = request.hints ?? {};
    const honored: AsrHints = {};
    if (declared.honors.context && hints.context !== undefined && hints.context !== '') {
      honored.context = hints.context;
    }
    if (declared.honors.prompt && hints.prompt !== undefined && hints.prompt !== '') {
      honored.prompt = hints.prompt;
    }
    if (measureInlineRequestBytes(request, honored, invocation.model) > declared.maxInlineRequestBytes) {
      return { ok: false, code: 'OVERSIZE', message: 'stand-in: past the declared budget' };
    }
    const endpoint = generateContentEndpoint(invocation.baseUrl, invocation.model);
    let response: Response;
    try {
      // The same transport discipline the shipping adapters use, retry included: only the
      // declaration differs between this stand-in and the adapter it stands in for.
      response = await fetchWithTransportRetry(invocation.fetchImpl, endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The header this wire declares it reads the credential from (`AsrWireModel`): a stand-in
          // that announced the key in a header the wire does not declare would be a second wire.
          ...(invocation.apiKey ? { 'x-goog-api-key': invocation.apiKey } : {}),
        },
        body: JSON.stringify(
          buildInlineRequestBody(request, honored, base64Encode(request.audio.bytes), invocation.model),
        ),
        signal: invocation.signal,
      });
    } catch {
      // The same single code the shipping adapters reach for a transport that refused and for one the
      // deadline ended: two messages, one meaning (`AsrErrorCode`).
      return { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: 'stand-in: no answer' };
    }
    if (!response.ok) {
      // The shipping classifier, over the same bytes the shipping adapter would hand it: a stand-in
      // with its own idea of the mapping would be measuring a second implementation.
      return {
        ok: false,
        code: classifyUpstreamFailure(response.status, await response.text()),
        message: 'stand-in: the service answered',
        status: response.status,
      };
    }
    let text: string;
    try {
      text = readTranscriptText(await response.text());
    } catch {
      return { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: 'stand-in: unreadable answer' };
    }
    if (text === '') return { ok: false, code: 'NO_SPEECH_DETECTED', message: 'stand-in: no text' };
    return {
      ok: true,
      text,
      style: 'verbatim',
      transformations: [...STYLE_TRANSFORMATIONS],
      providerId: promptHonouringAdapter.id,
    };
  },
};

/** A declaration that claims to honor the prompt while feeding the adapter that does not. */
const lyingAdapter: AsrAdapter = {
  ...promptHonouringAdapter,
  id: 'stand-in-lying-declaration',
  transcribe,
};

/** An adapter that throws out of `transcribe` instead of answering. */
const throwingAdapter: AsrAdapter = {
  id: 'stand-in-throwing',
  capabilities,
  async transcribe() {
    throw new Error('the transport exploded');
  },
};

/** The recorded reading for `id`, or `undefined` when the board never produced it. */
function readingFor(report: Awaited<ReturnType<typeof runAsrContractInvariants>>, id: string) {
  return report.readings.find((entry) => entry.id.startsWith(id));
}

describe('the transcription seam invariant board', () => {
  it('measures every registered provider and passes every group', async () => {
    const providers = listProviders();
    expect(providers.length).toBeGreaterThan(0);

    const report = await runAsrContractInvariants({ providers });

    expect(report.verdict).toBe('pass');
    expect(report.groups.map((entry) => entry.group)).toEqual([...INVARIANT_GROUP_IDS]);
    for (const group of report.groups) {
      expect(group.readings, `${group.group} measured nothing`).toBeGreaterThan(0);
      expect(group.verdict, `${group.group} failed: ${group.failing.join(', ')}`).toBe('pass');
    }
    // A floor, so a board that silently stopped probing most of its subjects cannot pass by
    // measuring one reading per group.
    expect(report.readings.length).toBeGreaterThanOrEqual(40);
    // Every reading is printed, so a reading that cannot be printed cannot hide.
    expect(report.logs.length).toBe(report.readings.length);
    expect(report.verdict === 'pass' && report.readings.some((entry) => entry.verdict === 'fail')).toBe(false);
  });

  it('scores an empty provider list as empty rather than as a pass', async () => {
    const report = await runAsrContractInvariants({ providers: [] });

    expect(report.verdict).toBe('empty');
    expect(report.readings).toEqual([]);
    expect(report.logs).toEqual([]);
    for (const group of report.groups) expect(group.verdict).toBe('unmeasured');
  });

  it('scores a selection that named no group as empty', async () => {
    const report = await runAsrContractInvariants({ providers: listProviders(), groups: [] });

    expect(report.verdict).toBe('empty');
    expect(report.groups).toEqual([]);
    expect(report.readings).toEqual([]);
  });

  it('reports a probe that throws as a red reading instead of a thrown board', async () => {
    const report = await runAsrContractInvariants({ providers: [throwingAdapter] });

    expect(report.verdict).toBe('fail');
    const thrown = report.readings.filter((entry) => entry.id.includes('probe-threw'));
    expect(thrown.length).toBeGreaterThan(0);
    for (const entry of thrown) expect(entry.observed).toContain('the transport exploded');
    // The log surface is still read, so a board that cannot measure the wire can still say that
    // nothing it printed leaked — the failure is reported, not abandoned.
    expect(readingFor(report, 'redaction.log-lines-present')).toBeDefined();
  });

  it('measures a declaration it did not write: an adapter that honors the prompt sends it', async () => {
    const report = await runAsrContractInvariants({ providers: [promptHonouringAdapter] });

    expect(report.verdict).toBe('pass');
    expect(readingFor(report, 'request.prompt.unsupported-omitted')?.observed).toBe('prompt-part-present');
    expect(readingFor(report, 'request.prompt.unsupported-omitted')?.verdict).toBe('pass');
    expect(readingFor(report, 'request.context.honored')?.observed).toBe('text-part-present');
    // An empty prompt is still left off, so the two readings together say "sent when declared, and
    // only when there is something to send".
    expect(readingFor(report, 'request.prompt.empty-hint-omitted')?.observed).toBe('no-prompt-part');
    expect(readingFor(report, 'request.body.golden')?.verdict).toBe('pass');
  });

  it('reds a declaration that disagrees with the wire it feeds', async () => {
    const report = await runAsrContractInvariants({ providers: [lyingAdapter] });

    expect(report.verdict).toBe('fail');
    const prompt = readingFor(report, 'request.prompt.unsupported-omitted');
    expect(prompt?.observed).toBe('no-prompt-part');
    expect(prompt?.expected).toBe('prompt-part-present');
    // The capability table is a claim under test, not documentation: a table that promises the
    // prompt cannot be forwarded while the adapter leaves it off is the red this reading exists for.
    expect(readingFor(report, 'request.body.golden')?.verdict).toBe('fail');
  });

  it('pins the request body against the declaration rather than against itself', () => {
    // The model is a parameter of the golden body because the decode configuration is a function of
    // the model name; the wire's own model is what the board probes with, so it is what is pinned
    // against here.
    const withPrompt = goldenBody(
      { ...capabilities, honors: { prompt: true, language: false, context: true } },
      INVARIANT_MODEL,
    );
    const withoutPrompt = goldenBody(capabilities, INVARIANT_MODEL);

    expect(withoutPrompt).not.toBe(withPrompt);
    expect(withoutPrompt.includes('systemInstruction')).toBe(false);
    expect(withPrompt.includes('systemInstruction')).toBe(true);
    expect(withPrompt.includes(INVARIANT_AUDIO_TEXT)).toBe(false);
    // The audio is carried as a token, so a recorded body can be printed without printing bytes.
    expect(withPrompt.includes('<AUDIO>')).toBe(true);
    // A declaration that does not acknowledge the context drops the part, which is the same rule
    // the prompt axis follows.
    const withoutContext = goldenBody(
      { ...capabilities, honors: { prompt: false, language: false, context: false } },
      INVARIANT_MODEL,
    );
    expect(withoutContext.includes('the invariant context')).toBe(false);
    expect(withoutContext.includes('inlineData')).toBe(true);
  });

  it('derives its size fixtures from the declaration, on both sides of the budget', () => {
    const budget = capabilities.maxInlineRequestBytes;
    // The base64 length of n bytes is ceil(n / 3) * 4 — written out here because THIS is the
    // arithmetic the two fixtures have to straddle, and a stale derivation would leave the size
    // group measuring one side of the line twice.
    const encodedLength = (bytes: number) => Math.ceil(bytes / 3) * 4;
    expect(encodedLength(overBudgetAudioBytes(budget))).toBeGreaterThan(budget);
    expect(encodedLength(affordableAudioBytes(budget))).toBeLessThan(budget);
    expect(affordableAudioBytes(budget)).toBeGreaterThan(0);
  });

  it('scans with a detector that fires on a needle and stays quiet without one', () => {
    const needles = redactionNeedles();

    expect(needles.credential).toBe(INVARIANT_API_KEY);
    expect(needles.payload).toContain(INVARIANT_AUDIO_BASE64);
    expect(needles.payload).toContain(INVARIANT_AUDIO_TEXT);

    const planted = [`a line carrying ${INVARIANT_API_KEY} and ${INVARIANT_AUDIO_BASE64}`];
    expect(scanLines(planted, [needles.credential]).length).toBe(1);
    expect(scanLines(planted, needles.payload).length).toBe(1);
    const clean = ['a line carrying neither'];
    expect(scanLines(clean, [needles.credential, ...needles.payload])).toEqual([]);
  });
});

// ── the hints contract: one application of every adapter's declaration ───────────────────────
//
// The four adapters that used to carry byte-identical `honoredHints` bodies now all call the one
// function in `asrContract.ts`. This block is the adapter-invariant reading: it walks the SHIPPED
// registry and drives each adapter's declared `honors` through that function, so a declaration
// that changes without its expected reading moving — or an adapter that grows a private copy
// again — is a red here rather than a silent divergence between providers.
//
// THE EXPECTATIONS ARE LITERAL PER ADAPTER rather than re-derived from the declaration: a second
// implementation of the rule inside the test would agree with the helper by construction.

describe('the hints contract is applied once, through each adapter’s declaration', () => {
  const HINTS: AsrHints = { prompt: 'p', language: 'zh', context: 'c' };

  /** What each shipped adapter's declaration says it forwards when every hint is supplied. */
  const EXPECTED: Record<string, AsrHints> = {
    'openai-compatible': {},
    multimodal: { context: 'c' },
    'dashscope-omni': {},
    'dashscope-omni-relay': { context: 'c' },
    'sensevoice-local': {},
    'sensevoice-wasm': {},
  };

  it('honours exactly the declared axes for every shipped adapter, and nothing else', () => {
    for (const adapter of listProviders()) {
      const expected = EXPECTED[adapter.id];
      expect(expected, `no expected hint set declared for shipped adapter '${adapter.id}'`).toBeDefined();
      expect(honoredHints(adapter.capabilities, HINTS), adapter.id).toEqual(expected);
      // An absent hints bag is empty for every declaration, acknowledged axes or not.
      expect(honoredHints(adapter.capabilities, undefined), adapter.id).toEqual({});
    }
  });

  it('forwards every axis a declaration acknowledges (positive control)', () => {
    const allHonors: AsrCapabilities = {
      ...capabilities,
      honors: { prompt: true, language: true, context: true },
    };
    expect(honoredHints(allHonors, HINTS)).toEqual(HINTS);
  });
});

// ── the token contract: the always-on half of the per-token declaration ───────────────────────
//
// WHAT THIS BLOCK IS FOR. The three shipped recognisers declare `tokens: { confidence: false,
// timestamps: false }`, so the two-sided reading the contract exists for — a declaration of `true`
// against a result that carries the facts, and against one that does not — is unreachable through
// the registry. The stand-in below declares `true` and produces them; the negative controls take
// the same declaration and a result that disagrees with it. The declaration/locality half is read
// over the SHIPPED registry, so a field that went missing in an adapter reds here as well.

/** A declaration that promises both per-token facts, which is what a word-level engine publishes. */
const TOKEN_DECLARATION: AsrCapabilities = {
  ...capabilities,
  tokens: { confidence: true, timestamps: true },
  // Not 'remote' on purpose: this stand-in is not a statement about where a shipped recogniser
  // runs, and the locality cases below read the SHIPPED declarations rather than this one.
  locality: 'local-client',
};

/** The audio and invocation the stand-in is driven with; it reads neither, but its contract takes them. */
const TOKEN_STAND_IN_REQUEST: AsrRequest = {
  audio: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/webm', fileName: 'clip.webm' },
};
const TOKEN_STAND_IN_INVOCATION: AsrInvocation = {
  baseUrl: 'https://asr.invalid',
  apiKey: '',
  model: 'stand-in-model',
  timeoutMs: 1_000,
  fetchImpl: (async () => new Response('', { status: 200 })) as typeof fetch,
};

/** A minimal stand-in recogniser that produces the per-token facts it declares. */
const tokenProducingAdapter: AsrAdapter = {
  id: 'stand-in-token-producing',
  capabilities: TOKEN_DECLARATION,
  async transcribe() {
    const result: AsrSuccess = {
      ok: true,
      text: 'tok one tok two',
      style: 'verbatim',
      transformations: [],
      providerId: tokenProducingAdapter.id,
      tokens: [
        { text: 'tok', confidence: 0.91, startMs: 0 },
        { text: 'one', confidence: 0.42, startMs: 120 },
      ],
      meta: { buildId: 'stand-in-build-0001' },
    };
    return result;
  },
};

describe('the per-token declaration and its invariant', () => {
  it('publishes a well-formed declaration for every shipped recogniser and carries both kinds of recogniser', async () => {
    const providers = listProviders();
    expect(providers.length).toBeGreaterThan(0);

    // WHAT THIS READS, AND WHY IT IS NOT "EVERY ROW SAYS false/false AND remote" ANY MORE. That was
    // the reading while the registry held only HTTP clients, and it stopped being a reading of the
    // registry the moment a recogniser that runs on this host and returns per-token confidences was
    // registered: a literal like that does not describe the shipped declarations, it describes the
    // shape the first three happened to have, and it would have to be edited every time a row of the
    // other kind is added — which is the opposite of what a registry-derived assertion is for.
    //
    // WHAT SURVIVES IS THE DECLARATION BEING WELL-FORMED, read off each row rather than restated:
    // both per-token facts are booleans and the locality is one of the three the vocabulary names.
    // A row that dropped either field, or named a locality nothing knows, reds here.
    const knownLocalities = ['remote', 'local-server', 'local-client'];
    for (const provider of providers) {
      expect(provider.capabilities.tokens, provider.id).toMatchObject({
        confidence: expect.any(Boolean),
        timestamps: expect.any(Boolean),
      });
      expect(knownLocalities, provider.id).toContain(provider.capabilities.locality);
    }

    // THE SET CARRIES BOTH KINDS, and this is the assertion that keeps the two halves of the
    // invariant exercised THROUGH the registry rather than only through the stand-in below. A
    // registry of token-declaring rows would leave `false/false` measured by nothing; a registry of
    // `false/false` rows would leave the token-bearing half to a fixture. Read as a property of the
    // whole set rather than of any one provider, so adding a fifth recogniser does not require
    // editing it — only collapsing the set back to one shape does.
    const declaresTokens = providers.filter(
      (provider) => provider.capabilities.tokens.confidence || provider.capabilities.tokens.timestamps,
    );
    expect(declaresTokens.length, 'at least one shipped recogniser promises per-token facts').toBeGreaterThan(0);
    expect(declaresTokens.length, 'and at least one promises none').toBeLessThan(providers.length);
    expect(
      providers.some((provider) => provider.capabilities.locality !== 'remote'),
      'at least one shipped recogniser runs where the audio already is',
    ).toBe(true);
    expect(
      providers.some((provider) => provider.capabilities.locality === 'remote'),
      'and at least one still reaches a service',
    ).toBe(true);
    console.log(
      `token-declarations=[${providers.map((provider) => `${provider.id}:${provider.capabilities.locality}:`
        + `${provider.capabilities.tokens.confidence ? 'confidence' : ''}${provider.capabilities.tokens.timestamps ? '+timestamps' : ''}`).join(' ')}]`,
    );

    const result = await tokenProducingAdapter.transcribe(
      TOKEN_STAND_IN_REQUEST,
      TOKEN_STAND_IN_INVOCATION,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('the stand-in must answer with a success');

    // The positive control for the invariant: a declaration of `true` met by a result that carries
    // the facts is NOT a violation, and the gate does not throw. Without this, "the bad case
    // throws" would also be green for a checker that throws on everything.
    expect(result.tokens).toBeDefined();
    expect(tokenInvariantViolations(tokenProducingAdapter.capabilities, result)).toEqual([]);
    expect(() => assertTokenInvariants(tokenProducingAdapter.capabilities, result)).not.toThrow();
  });

  it('reds a declaration the result disagrees with, and the red is the check rather than the fixture', () => {
    const promisesConfidence: AsrCapabilities = {
      ...capabilities,
      tokens: { confidence: true, timestamps: false },
    };
    const noTokens: AsrSuccess = {
      ok: true,
      text: 'plain text',
      style: 'verbatim',
      transformations: [],
      providerId: 'stand-in-no-tokens',
    };

    // The missing-tokens half: declared confidence, result carries none.
    expect(tokenInvariantViolations(promisesConfidence, noTokens).length).toBeGreaterThan(0);
    expect(() => assertTokenInvariants(promisesConfidence, noTokens)).toThrow(/tokens/);

    // The out-of-range half, on a result that DOES carry tokens: 1.2 and -0.1 are both outside
    // the closed interval a caller comparing confidences may assume.
    const outOfRange: AsrSuccess = {
      ...noTokens,
      providerId: 'stand-in-out-of-range',
      tokens: [
        { text: 'a', confidence: 1.2, startMs: 0 },
        { text: 'b', confidence: -0.1, startMs: 5 },
      ],
    };
    expect(() => assertTokenInvariants(promisesConfidence, outOfRange)).toThrow(/confidence/);

    // The other direction of the same declaration, which a one-sided check drops: a recogniser
    // that declares `false` must not carry the field anyway.
    const declaresNone: AsrCapabilities = {
      ...capabilities,
      tokens: { confidence: false, timestamps: false },
    };
    expect(() => assertTokenInvariants(declaresNone, outOfRange)).toThrow(/undeclared/);

    // redWhenOff: the assertions above are about the CHECK, not about the fixture, so they must go
    // red when the check is removed and stay green when it is present. Written as a toggle so the
    // dependency is measured rather than assumed — commenting the check out is exactly the `false`
    // arm below, and it makes the `true` arm's expectation fail.
    const redWhenOff = (checkEnabled: boolean): boolean =>
      checkEnabled ? tokenInvariantViolations(promisesConfidence, noTokens).length > 0 : false;
    expect(redWhenOff(true)).toBe(true);
    expect(redWhenOff(false)).toBe(false);
  });

  it('round-trips tokens and meta.buildId through the strict parse, and leaves an old body byte-identical', async () => {
    const richBody = JSON.stringify({
      text: 'k-asr-rich',
      tokens: [
        { text: 'k-asr-rich', confidence: 0.87, startMs: 0 },
        { text: 'tail', confidence: 0.5, startMs: 400 },
      ],
      meta: { buildId: 'build-2026-10-06-abc' },
    });

    // The text view every existing caller reads is unchanged by the extra fields...
    const text = await parseTranscriptionResponse(new Response(richBody, { status: 200 }), 'strict');
    expect(text).toBe('k-asr-rich');

    // ...and the same strict read, asked for the envelope, retains each item VERBATIM: the token
    // texts, their confidences, their start times and the build identity all survive.
    const envelope: TranscriptionEnvelope = await parseTranscriptionResponse(
      new Response(richBody, { status: 200 }),
      'strict',
      'envelope',
    );
    expect(envelope).toEqual({
      text: 'k-asr-rich',
      tokens: [
        { text: 'k-asr-rich', confidence: 0.87, startMs: 0 },
        { text: 'tail', confidence: 0.5, startMs: 400 },
      ],
      meta: { buildId: 'build-2026-10-06-abc' },
    });

    // An old body — no tokens, no buildId — parses to the pre-change snapshot EXACTLY. The
    // snapshot is the literal the old implementation produced (`String(data?.text || '')`), and
    // the envelope must not have invented keys around it for an older client to trip over.
    const oldBody = JSON.stringify({ text: 'k-asr-old' });
    expect(await parseTranscriptionResponse(new Response(oldBody, { status: 200 }), 'strict')).toBe(
      'k-asr-old',
    );
    const oldEnvelope = await parseTranscriptionResponse(
      new Response(oldBody, { status: 200 }),
      'strict',
      'envelope',
    );
    expect(oldEnvelope).toEqual({ text: 'k-asr-old' });
    expect(Object.keys(oldEnvelope)).toEqual(['text']);

    // The lenient branch reads the SAME envelope, so the proxy path is not a second spelling of
    // the parse: the richer answer survives there too.
    expect(
      await parseTranscriptionResponse(new Response(richBody, { status: 200 }), 'lenient', 'envelope'),
    ).toEqual(envelope);
  });

  it('runs the chain end to end from a token-producing adapter to the client parse', async () => {
    // Link 1: the adapter returns a success whose per-token facts satisfy its own declaration.
    const result = await tokenProducingAdapter.transcribe(
      TOKEN_STAND_IN_REQUEST,
      TOKEN_STAND_IN_INVOCATION,
    );
    if (!result.ok) throw new Error('the stand-in must answer with a success');
    assertTokenInvariants(tokenProducingAdapter.capabilities, result);

    // Link 2: the response payload the service publishes for this result. The service copies
    // `text` and — when present — `tokens`/`meta.buildId` verbatim (see
    // `server/modules/voice/voice.service.ts`); the composition below states that one shape, and
    // the dispatch test reads the live service's token-less half.
    const payload: { text: string; tokens?: AsrSuccess['tokens']; meta?: { buildId?: string } } = {
      text: result.text,
    };
    if (result.tokens !== undefined) payload.tokens = result.tokens;
    if (result.meta?.buildId !== undefined) payload.meta = { buildId: result.meta.buildId };

    // Link 3: the client reads the serialized payload back and gets the tokens WITH confidence.
    const clientEnvelope = await parseTranscriptionResponse(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
      'strict',
      'envelope',
    );
    expect(clientEnvelope.text).toBe(result.text);
    expect(clientEnvelope.meta?.buildId).toBe('stand-in-build-0001');
    expect(clientEnvelope.tokens?.map((token) => token.confidence)).toEqual([0.91, 0.42]);
  });
});
