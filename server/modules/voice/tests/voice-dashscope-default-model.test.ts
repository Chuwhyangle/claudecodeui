/**
 * An unset per-user model on `dashscope-omni` resolves to THAT provider's own default, never to the
 * deployment's shared `sttModel`.
 *
 * THE DEFECT THIS PINS. `resolveRecognitionConfig` used to read `storedModel || resolved.sttModel`.
 * For a user whose shared backend is an OpenAI-compatible one (Whisper, Groq's `whisper-large-v3-turbo`)
 * that fallback is a model of ANOTHER service: leaving the DashScope model field blank sent the Whisper
 * id to DashScope, which refuses it. The adapter had always exported its frozen `DEFAULT_MODEL`, and
 * nothing consumed it. The provider now declares it as `credentials.defaultModel` and the service reads
 * the declaration, so the server still carries no provider id.
 *
 * Every case drives the shipped `createVoiceService` with the outbound port replaced by a recorder, so
 * what is read is the request body the service really builds.
 *
 * Run: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-dashscope-default-model.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { listProviders } from '../../../../shared/asr/asrRegistry.js';
import { createVoiceService } from '../voice.service.js';
import type { VoiceSettings } from '@/shared/types.js';

/** The adapter is entered after the registry: the reverse order is a TDZ (see voice-provider-dispatch.test.ts). */
const dashscopeOmni = await import(
  '../../../../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.js'
);

/** The shared backend's model: a Whisper id, which no DashScope endpoint accepts. */
const SHARED_STT_MODEL = 'whisper-large-v3-turbo';
const ENDPOINT = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com';

const DEFAULTS = {
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: 'server-key',
  sttModel: SHARED_STT_MODEL,
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  providerId: '',
};

/** A user with a shared Groq-style backend AND a DashScope workspace, `dashscopeModel` as given. */
function settingsWith(dashscopeModel: string): VoiceSettings {
  return {
    baseUrl: DEFAULTS.baseUrl,
    apiKey: 'user-shared-key',
    sttModel: SHARED_STT_MODEL,
    ttsModel: '',
    ttsVoice: '',
    ttsFormat: '',
    providerId: 'dashscope-omni',
    dashscopeEndpoint: ENDPOINT,
    dashscopeApiKey: 'sk-dashscope-sentinel',
    dashscopeModel,
  };
}

/** Transcribes one clip with `settings` and returns the `model` the upstream request body carried. */
async function upstreamModel(
  settings: VoiceSettings,
  overrides: { sttModel?: string } = {},
): Promise<{ model: unknown; url: string }> {
  const seen: { url: string; body: unknown }[] = [];
  const service = createVoiceService({
    defaults: DEFAULTS,
    timeoutMs: 1_000,
    fetchBackend: async (url, init) => {
      seen.push({ url, body: init.body });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"transcript":"k","instruction":"k"}' } }] }),
        { status: 200 },
      );
    },
  });
  const result = await service.transcribe({
    audio: { bytes: Buffer.alloc(16, 0x6b), mimeType: 'audio/webm', fileName: 'clip.webm' },
    overrides,
    settings,
  });
  assert.equal(result.ok, true, 'the request must reach the upstream for its body to be read');
  assert.equal(seen.length, 1);
  return { model: (JSON.parse(String(seen[0].body)) as { model?: unknown }).model, url: seen[0].url };
}

test('a blank dashscopeModel sends the adapter\'s DEFAULT_MODEL, not the shared sttModel', async () => {
  const { model, url } = await upstreamModel(settingsWith(''));
  assert.ok(url.startsWith(ENDPOINT), `the request goes to the user's workspace, saw ${url}`);
  assert.equal(model, dashscopeOmni.DEFAULT_MODEL);
  assert.notEqual(model, SHARED_STT_MODEL);
});

test('a model the user typed wins over the default', async () => {
  const { model } = await upstreamModel(settingsWith('qwen-omni-typed-by-user'));
  assert.equal(model, 'qwen-omni-typed-by-user');
});

test('the shared backend\'s model, sent in the request header on every transcribe, is not the provider\'s model', async () => {
  // The settings page attaches `x-voice-stt-model: <shared sttModel>` to every upload. Read as an
  // override it sent a Whisper id to DashScope, which answered 404 (the defect this pins, seen live).
  const { model } = await upstreamModel(settingsWith(''), { sttModel: SHARED_STT_MODEL });
  assert.equal(model, dashscopeOmni.DEFAULT_MODEL);
  assert.notEqual(model, SHARED_STT_MODEL);
});

test('the provider declares its default, and the health payload republishes it', () => {
  assert.equal(dashscopeOmni.credentials.defaultModel, dashscopeOmni.DEFAULT_MODEL);
  const service = createVoiceService({ defaults: DEFAULTS, timeoutMs: 1_000, fetchBackend: async () => new Response('') });
  const health = service.getHealth({ settings: settingsWith('') });
  assert.equal(health.ok, true);
  if (!health.ok) return;
  const row = (health.value.providers ?? []).find((provider) => provider.id === 'dashscope-omni');
  assert.equal(row?.credentialFields?.defaultModel, dashscopeOmni.DEFAULT_MODEL);
});

test('control: a provider that declares no default keeps falling back to the shared sttModel', () => {
  const declared = listProviders().filter((provider) => provider.credentials?.defaultModel !== undefined);
  // The relay provider is the same service and model, so it declares the same default. Both
  // rows must keep the shared backend's Whisper id off this service.
  assert.deepEqual(
    declared.map((provider) => provider.id),
    ['dashscope-omni', 'dashscope-omni-relay'],
    'only the providers whose model name is not the shared one declare a default',
  );
});
