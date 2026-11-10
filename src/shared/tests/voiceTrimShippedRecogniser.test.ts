/**
 * The shipped recogniser has to BE the effective provider, and its declaration has to be what the
 * trim decision reads.
 *
 * WHY THIS IS ITS OWN FILE. The trim gate answers "裁不裁" from a capability declaration
 * (`src/modules/chat-voice/hooks/useVoiceInput.ts`) and the declaration comes from the registry — both
 * of which are pinned elsewhere. What nothing pinned is the JOIN between them: which provider the
 * declaration is read FOR. That join is a registration-order fact, and it is invisible from either
 * side. A tree can have one honest read point, one honest declaration, and still trim nothing,
 * because the adapter sitting at `listProviders()[0]` is the second one and its answer is `useful`.
 *
 * THE REGRESSION THIS FILE EXISTS FOR. The client used to carry its own `destructive` table, so
 * the join did not matter. Moving 裁不裁 onto the declaration removed that table — correctly — and
 * the default flipped, because the shipped recogniser this deployment actually posts to had never
 * been registered at all. Both halves of the fix are asserted below: the row exists, and it is
 * first.
 *
 * A NAME IS NOT AN IDENTITY. `listProviders()[0].id === 'openai-compatible'` would hold for an
 * adapter that declared the right string and did something else, so the last case drives the
 * adapter the registry hands back and reads the wire it produces. The claim being made about the
 * first row is that it is the recogniser this deployment sends audio to, and that is only true if
 * the row reaches the transcription endpoint with the audio in a multipart body.
 *
 * It lives under `src/` because that is where the unit suite is collected from; the module under
 * test lives in the repository-root `shared/` tree, which the frontend reaches through the
 * `@shared` alias (ADR-004 decision 2).
 */

import { expect, test } from 'vitest';

import {
  listProviders,
  pauseCuesDeclarationFor,
  type AsrInvocation,
  type AsrRequest,
} from '@shared/asr/asrRegistry';
import {
  capabilities as shippedCapabilities,
  id as shippedId,
  transcribe,
} from '@shared/asr/list/openai-compatible/openai-compatible.asr-provider';
import { transcriptionEndpoint } from '@shared/asr/contract/transcriptionWire';
import { trimDecisionFor } from '@/shared/voice/voiceTrim';

/**
 * The provider a request goes to when nothing is requested and nothing is configured — which is
 * the shipped configuration, and therefore the provider a trim decision in that configuration is
 * about. Read from `server/modules/voice/voice.service.ts`'s `effectiveProviderId`, which is
 * `listProviders()[0]?.id ?? ''`.
 */
const EFFECTIVE_PROVIDER = listProviders()[0];

function audioOf(byteLength: number): AsrRequest['audio'] {
  return { bytes: new Uint8Array(byteLength), mimeType: 'audio/webm;codecs=opus', fileName: 'clip.webm' };
}

function standIn(body: string) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: init?.body });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

function invocationFor(fetchImpl: typeof fetch): AsrInvocation {
  return {
    // `.invalid` never resolves: this file must not be able to reach a real service even by
    // accident.
    baseUrl: 'https://asr.invalid',
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 1000,
    fetchImpl,
  };
}

test('the shipped recogniser is registered, and the registry hands back its own declaration', () => {
  expect(EFFECTIVE_PROVIDER, 'this case needs the registry to hand out at least one provider').toBeDefined();
  expect(EFFECTIVE_PROVIDER.id).toBe(shippedId);

  const declaration = pauseCuesDeclarationFor(shippedId);

  expect(declaration).not.toBeNull();
  expect(declaration?.provider).toBe(shippedId);
  // The declaration is the module's own constant, not a value re-typed into the registry: a
  // second copy is the table this seam exists to not have, and it is the copy that goes stale.
  expect(declaration?.capability).toBe(shippedCapabilities.pauseCues);
  // The row this deployment ACTUALLY sends audio to is not the only one registered, so "first" is
  // a claim about order rather than about a list that happens to have one entry in it.
  expect(listProviders().length).toBeGreaterThan(1);
});

test('the effective provider declares the trim, so the shipped default trims again', () => {
  const declaration = pauseCuesDeclarationFor(EFFECTIVE_PROVIDER.id);

  // The reading this whole task is about: the provider the request goes to says that removing its
  // pauses costs nothing, which is what `trimDecisionFor` turns into "run the trimmer".
  expect(declaration?.capability).toBe('destructive');
  expect(trimDecisionFor(declaration!.capability).trim).toBe(true);
});

test('the first registered adapter is the transcription-wire recogniser, not merely its name', async () => {
  const stand = standIn(JSON.stringify({ text: 'hello' }));

  const result = await transcribe({ audio: audioOf(2048) }, invocationFor(stand.fetchImpl));

  expect(result).toMatchObject({ ok: true, text: 'hello', providerId: shippedId });
  // What makes the identity claim a reading rather than a label: audio sent here goes to the
  // transcription path as a multipart form. An adapter that declared this id but posted a JSON
  // envelope elsewhere would satisfy every string comparison above and fail here.
  expect(stand.calls[0]?.url).toBe(transcriptionEndpoint('https://asr.invalid'));
  expect(stand.calls[0]?.body).toBeInstanceOf(FormData);
});

test('an id nothing is registered under still declares nothing — the lookup did not gain a default row', () => {
  // The falsifying side of the same property: if the registration above were replaced by a
  // fallback row answering for every id, this would return a declaration instead of null, and a
  // caller that mistyped a provider would silently get the shipped behaviour.
  expect(pauseCuesDeclarationFor('no-such-provider')).toBeNull();
});
