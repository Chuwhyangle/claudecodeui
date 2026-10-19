import assert from 'node:assert/strict';

import { fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterAll, beforeEach, test, vi } from 'vitest';

import VoiceSettingsTab from '@/modules/settings/tabs/VoiceSettingsTab';
import { resetVoiceConfig, updateVoiceConfig } from '@/shared/voiceConfig';

/**
 * AC-409: the smallest Live Voice settings surface this product ships.
 *
 * THREE READINGS, all about the SETTINGS FORM rather than about the server's own storage:
 *
 * 1. The Voice page is split into the two sub-tabs the criterion names — "Voice Input" and
 *    "Live Voice" — and the selection is a real one (clicking moves `aria-selected`).
 * 2. The Live Voice sub-tab exposes EXACTLY ONE field, `liveVoiceDashscopeApiKey`; no endpoint,
 *    model or voice input is rendered there. The input half is read first as a POSITIVE CONTROL:
 *    the same form really does render those boxes when they belong to it, so the absence below
 *    cannot be a form that renders nothing for anybody.
 * 3. The credential round-trip: a stored key reads back MASKED, a typed key is saved in the clear,
 *    and a save that did not touch the field sends the mask back verbatim — the exact marker the
 *    server's `unmaskMaskedCredentials` keys on to keep the stored value. The server half of that
 *    rule is pinned by `server/modules/voice/tests/voice-dashscope-settings.test.ts`; the double
 *    below mirrors it so this file can read the CLIENT half: if the form omitted the field, or
 *    blanked/normalised the mask on its way through the whole-document save, the stored credential
 *    would change and the readings here would go red.
 *
 * THE FALSE FORM THE CRITERION NAMES — an extra endpoint/model/voice field on the Live Voice
 * sub-tab — reds case 2: the rendered input names are compared as a whole, not by a sample.
 */

const MASK = '••••••••';

const voice = vi.hoisted(() => ({
  health: vi.fn(),
  config: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('@/shared/api', () => ({ api: { voice }, authenticatedFetch: vi.fn() }));

/**
 * The on-device recogniser's reading, as the settings panel consumes it.
 *
 * Only the panel's subscription and its preload effect touch this, and neither reading below is
 * about the on-device recogniser: doubling the chat barrel keeps a real Web Worker out of the
 * process and leaves the form's own rendering under test.
 */
const clientAsrPanel = vi.hoisted(() => ({
  engine: null as null | { available: boolean; state: string; buildId?: string; reason?: string },
  progress: null as null | {
    receivedBytes: number;
    totalBytes: number;
    bytesPerSec: number;
    remainingMs: number | null;
  },
  fallback: null as null | { providerId: string; reason: string; message: string },
  preload: vi.fn(),
}));

vi.mock('@/modules/chat', () => ({
  useVoiceClientAsrStatus: () => clientAsrPanel,
}));

// The enable switch and the language are not what any reading here is about. Voice must be ON for
// the sub-tab strip and its sections to render at all.
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ voiceEnabled: true }),
  useSetUiPreference: () => () => {},
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (!options) return key;
      return `${key}:${Object.entries(options).map(([name, value]) => `${name}=${String(value)}`).join(',')}`;
    },
  }),
}));

const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

/** The document a server with nothing stored answers with. */
const EMPTY_SERVER_DOCUMENT = {
  baseUrl: '',
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
  providerId: '',
  dashscopeEndpoint: '',
  dashscopeApiKey: '',
  dashscopeModel: '',
  liveVoiceDashscopeApiKey: '',
  voiceDataRecording: true,
  voiceDataMaxBytes: 2147483648,
};

/**
 * A voice settings server, reduced to the one rule this file reads.
 *
 * It is the SERVER-SIDE pair `maskSettingsForReadback` / `unmaskMaskedCredentials`
 * (`server/modules/voice/voice.service.ts`), in two lines: a stored credential reads back as the
 * mask marker (an empty one stays empty), and a saved field holding the mask means "keep what is
 * stored" rather than "the credential is now bullets". Keeping the double this small is the point:
 * it gives the component's whole-document round-trip somewhere to land without restating any rule
 * the client is allowed to own.
 */
const createServerDouble = (initial: Record<string, unknown>) => {
  const stored: Record<string, unknown> = { ...EMPTY_SERVER_DOCUMENT, ...initial };
  const readback = () => ({
    ...stored,
    liveVoiceDashscopeApiKey: stored.liveVoiceDashscopeApiKey === '' ? '' : MASK,
  });

  return {
    read: readback,
    save: (input: Record<string, unknown>) => {
      const next: Record<string, unknown> = { ...input };
      if (next.liveVoiceDashscopeApiKey === MASK) {
        next.liveVoiceDashscopeApiKey = stored.liveVoiceDashscopeApiKey;
      }
      Object.assign(stored, next);
      return readback();
    },
    stored: () => ({ ...stored }),
  };
};

type View = ReturnType<typeof render>;

/** Every input on the page, by the stored field its own `name` edits. */
const renderedInputNames = (view: View): string[] =>
  Array.from(view.container.querySelectorAll('input')).map((input) => input.name);

/** The Live Voice sub-tab's own credential box. */
const liveKeyInput = (view: View): HTMLInputElement => {
  const input = view.container.querySelector('input[name="liveVoiceDashscopeApiKey"]');
  assert.ok(input instanceof HTMLInputElement, 'the Live Voice sub-tab renders no liveVoiceDashscopeApiKey input');
  return input;
};

/** Opens the Live Voice sub-tab and waits for its half of the form. */
const openLiveTab = async (view: View): Promise<void> => {
  fireEvent.click(view.getByTestId('voice-settings-tab-live'));
  await waitFor(() => assert.equal(
    view.getByTestId('voice-settings-tab-live').getAttribute('aria-selected'),
    'true',
  ));
  await waitFor(() => assert.ok(liveKeyInput(view)));
};

/** How many cases this file's run has executed, printed once at the end as the criterion's reading. */
let cases = 0;

beforeEach(() => {
  cases += 1;
  voice.health.mockReset();
  voice.config.mockReset();
  voice.saveConfig.mockReset();
  clientAsrPanel.engine = null;
  clientAsrPanel.progress = null;
  clientAsrPanel.fallback = null;
  clientAsrPanel.preload.mockReset();
  clientAsrPanel.preload.mockResolvedValue({ available: true, state: 'ready', buildId: 'preloaded' });
  localStorage.clear();
  // The settings module is a singleton for the whole tab, so a case that typed into it would
  // otherwise leave its values in the next case's document. Resetting it re-hydrates from the
  // mocked server, which is what makes every case start from the same document.
  resetVoiceConfig();
  voice.config.mockImplementation(() => ok({ ...EMPTY_SERVER_DOCUMENT }));
  voice.saveConfig.mockImplementation(() => ok({ ...EMPTY_SERVER_DOCUMENT }));
  voice.health.mockImplementation(() => ok({
    configured: true,
    provider: 'alpha-asr',
    providers: [{
      id: 'alpha-asr',
      label: 'Alpha ASR',
      configured: true,
      // The declaration the positive control reads: this form really renders an endpoint, a key
      // and a model for a provider that declares them — on the INPUT half only.
      credentialFields: { endpointField: 'baseUrl', apiKeyField: 'apiKey', modelField: 'sttModel' },
    }],
  }));
});

afterAll(() => {
  console.log(`cases=${cases}`);
});

test('the Voice page has the two sub-tabs the criterion names, and selecting one moves the selection', async () => {
  const view = render(<VoiceSettingsTab />);

  const tabs = view.getAllByRole('tab');
  assert.deepStrictEqual(
    tabs.map((tab) => tab.getAttribute('data-testid')),
    ['voice-settings-tab-input', 'voice-settings-tab-live'],
    'the Voice page is not split into exactly the Voice Input and Live Voice sub-tabs',
  );
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true', 'the input half is not the opening tab');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'false');

  fireEvent.click(view.getByTestId('voice-settings-tab-live'));
  await waitFor(() => assert.equal(
    view.getByTestId('voice-settings-tab-live').getAttribute('aria-selected'),
    'true',
  ));
  assert.equal(view.getByTestId('voice-settings-tab-input').getAttribute('aria-selected'), 'false');
  assert.ok(view.getByRole('tablist'), 'the sub-tabs are not presented as a tablist');
});

test('the Live Voice sub-tab exposes exactly liveVoiceDashscopeApiKey, and no endpoint, model or voice field', async () => {
  const view = render(<VoiceSettingsTab />);

  // THE POSITIVE CONTROL FIRST, on the input half: endpoint, model and voice boxes are real
  // controls this form renders. Without this, the absence below would also be satisfied by a form
  // that rendered nothing anywhere.
  await waitFor(() => assert.ok(
    renderedInputNames(view).includes('baseUrl'),
    'the input half never rendered its endpoint field — the absence below would be vacuous',
  ));
  const inputHalf = renderedInputNames(view);
  for (const field of ['baseUrl', 'sttModel', 'ttsModel', 'ttsVoice', 'ttsFormat', 'apiKey']) {
    assert.ok(inputHalf.includes(field), `the input half does not render ${field}`);
  }

  await openLiveTab(view);

  // THE READING THE CRITERION NAMES, taken as the WHOLE set of inputs on the page rather than as
  // a sample: an added endpoint/model/voice box is a name this comparison does not contain.
  assert.deepStrictEqual(
    renderedInputNames(view),
    ['liveVoiceDashscopeApiKey'],
    'the Live Voice sub-tab must expose exactly the one credential field',
  );
  assert.equal(liveKeyInput(view).type, 'password', 'the Live Voice credential is not masked on screen');

  // ...and the absence, named explicitly: none of the fields a fuller form would have renders here.
  for (const absent of ['baseUrl', 'dashscopeEndpoint', 'sttModel', 'dashscopeModel', 'ttsModel', 'ttsVoice', 'ttsFormat']) {
    assert.equal(
      view.container.querySelector(`input[name="${absent}"]`),
      null,
      `the Live Voice sub-tab renders ${absent}, which the minimal surface does not expose`,
    );
  }

  // Switching back restores the input half, so the one-field reading above is a property of the
  // Live Voice sub-tab rather than of a form that discarded its other fields.
  fireEvent.click(view.getByTestId('voice-settings-tab-input'));
  await waitFor(() => assert.ok(renderedInputNames(view).includes('baseUrl')));
});

test('a stored key reads back masked, a typed key saves in the clear, and an untouched mask is never written back', async () => {
  const ORIGINAL = 'sk-live-original-4c19';
  const REPLACEMENT = 'sk-live-replacement-7f02';
  const server = createServerDouble({ liveVoiceDashscopeApiKey: ORIGINAL });
  voice.config.mockImplementation(() => ok(server.read()));
  voice.saveConfig.mockImplementation((document) => ok(server.save(document as Record<string, unknown>)));

  const first = render(<VoiceSettingsTab />);
  await openLiveTab(first);

  // READBACK IS THE MASK: the browser is handed the marker, never the key itself, even though the
  // server holds one. The plaintext appears nowhere in the rendered page.
  await waitFor(() => assert.equal(liveKeyInput(first).value, MASK));
  assert.equal(first.container.textContent?.includes(ORIGINAL), false, 'the stored key leaked into the page');
  assert.equal(server.stored().liveVoiceDashscopeApiKey, ORIGINAL);

  // WHAT THE USER TYPES IS WHAT IS SAVED: the debounced whole-document save carries the new key in
  // the clear (the server is the side that stores and masks it).
  fireEvent.change(liveKeyInput(first), { target: { value: REPLACEMENT } });
  await waitFor(
    () => assert.ok(voice.saveConfig.mock.calls.length > 0, 'the form never sent the settings document'),
    { timeout: 4_000 },
  );
  const typedSave = voice.saveConfig.mock.calls[voice.saveConfig.mock.calls.length - 1][0] as Record<string, unknown>;
  assert.equal(typedSave.liveVoiceDashscopeApiKey, REPLACEMENT, 'the key the user typed did not go out as typed');
  await waitFor(() => assert.equal(server.stored().liveVoiceDashscopeApiKey, REPLACEMENT));

  // A FRESH SESSION READS THE MASK BACK, and the stored document still holds the real key: the
  // readback never becomes the stored value.
  first.unmount();
  resetVoiceConfig();
  const second = render(<VoiceSettingsTab />);
  await openLiveTab(second);
  await waitFor(() => assert.equal(liveKeyInput(second).value, MASK));
  assert.equal(server.stored().liveVoiceDashscopeApiKey, REPLACEMENT);

  // A SAVE THAT DID NOT TOUCH THE FIELD sends the whole document back — the Live Voice key is the
  // mask, byte for byte. `updateVoiceConfig({})` is that save (an edit elsewhere in the document
  // triggers it), and the server's unmask rule keys on exactly this marker to keep the stored
  // credential rather than overwrite it with bullets.
  updateVoiceConfig({});
  await waitFor(
    () => assert.ok(voice.saveConfig.mock.calls.length >= 2, 'the second save never reached the server'),
    { timeout: 4_000 },
  );
  const untouchedSave = voice.saveConfig.mock.calls[voice.saveConfig.mock.calls.length - 1][0] as Record<string, unknown>;
  assert.equal(
    untouchedSave.liveVoiceDashscopeApiKey,
    MASK,
    'an untouched credential must be sent back as the mask marker the server recognises',
  );
  await waitFor(() => assert.equal(server.stored().liveVoiceDashscopeApiKey, REPLACEMENT));
  assert.notEqual(
    server.stored().liveVoiceDashscopeApiKey,
    MASK,
    'the mask was persisted as the credential',
  );

  console.log(
    `[settings] live voice: shared-tabs=2 liveFields=${renderedInputNames(second).length}`
      + ` readbackMasked=${liveKeyInput(second).value === MASK} storedAfterUntouchedSave="${String(server.stored().liveVoiceDashscopeApiKey)}"`,
  );
});
