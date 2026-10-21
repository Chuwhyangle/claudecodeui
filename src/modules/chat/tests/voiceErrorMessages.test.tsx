/**
 * AC-151's criterion: every code the shipped vocabulary names has copy in all twelve languages, no
 * code falls back to a sentence built out of the transport, and the composer shows the sentence the
 * code selects — in the user's language, with the status still kept for a technical line.
 *
 * WHAT IS BEING READ, AND WHY IT NEEDS A READING AT ALL. The composer used to say
 * `Transcription failed: transcribe 502 (UNSUPPORTED_MIME)`. That sentence is not a translation of
 * anything: it is the transport's vocabulary (a verb and a number) shown to a user who needs to know
 * what to change, and it is the same sentence in all twelve languages. The fix has two halves that
 * fail independently — copy that exists for a code (the locales) and a mapping that picks the right
 * copy (the frontend) — so this file reads both, and each half is read through the other: the code
 * set here is the SHIPPED runtime vocabulary, never a list kept beside it, and the twelve languages
 * are the SHIPPED `languages` list, never a hand-picked subset.
 *
 * THE VOCABULARY IS THE INPUT, NOT A COPY OF THE INPUT. `AsrErrorCode` is a type and a type is
 * erased; the runtime answer is `ASR_ERROR_CODES` from `@shared/asr/asrRegistry`, value-imported
 * below. Every reading here iterates that constant, which is what makes false form (1) work: add a
 * member to the vocabulary and the coverage reading reddens over twelve missing cells with no edit
 * to this file. A hand-written array here would make that reading true for the wrong reason forever.
 *
 * THE LOCALES ARE READ AS DATA, NOT THROUGH THE TRANSLATOR. The coverage and identity readings
 * (`AC2`, `AC3`) read the imported `chat.json` objects directly, so a missing key cannot be hidden by
 * a fallback language. The composer reading (`AC4`) is the opposite on purpose: it goes through the
 * real `ChatComposer`, the real `useVoiceInput` and a real i18next instance whose `fallbackLng` is
 * OFF — with a fallback language left on, a locale missing `voice.errors.unknown` would silently
 * render English and this file's central equality would hold over a locale that has no copy at all.
 *
 * WHAT THIS FILE DOES NOT DO. AC7 asks for the exit code of five existing composer criteria plus
 * `npm run test:client`, `npm run typecheck` and `npm run lint`; AC6's residue half is a
 * `git status --porcelain` reading. All of those are SUBPROCESSES and a working tree, and AC1
 * requires this file to start none — so AC7's exits and the working-tree reading are taken by the
 * worker outside this file and recorded in the task's completion record. What IS read here is the
 * half that can be: the three mutation phases run as in-memory clones, and `shipped-intact` below
 * re-reads the shipped data after they have all run, which is the in-file face of "no residue".
 *
 * THE FAILURE PAYLOAD IS CAPTURED ON THE SHIPPED PRODUCER. AC4(c) needs the payload a refusal
 * actually carries, not one written out in this file: `useVoiceInput` is driven directly for that
 * reading and its `onError` argument is kept. The composer reading beside it is a second mount of
 * the same chain over the same fake answer, because the composer owns its error callback and does
 * not hand it out — one answer, read at both ends of the chain.
 *
 * Run: npx vitest run src/modules/chat/tests/voiceErrorMessages.test.tsx
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { act, render, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import { createFakeVoiceCapture } from '@/modules/chat/tests/voiceCaptureTestHarness';
import { voiceErrorKey, voiceErrorMessage, voiceErrorTechnicalDetail } from '@/modules/chat/utils/voice/voiceErrorMessages';
// Through the barrel, not the file: this test lives in chat and `languages.ts` belongs to i18n, and
// the module-boundary rule the lint enforces is that a cross-module read goes through `index.ts`.
// The VALUE is still the one `src/modules/i18n/languages.ts` ships — the barrel re-exports it.
import { languages } from '@/modules/i18n';
import deChat from '@/modules/i18n/locales/de/chat.json';
import enChat from '@/modules/i18n/locales/en/chat.json';
import esChat from '@/modules/i18n/locales/es/chat.json';
import frChat from '@/modules/i18n/locales/fr/chat.json';
import idChat from '@/modules/i18n/locales/id/chat.json';
import itChat from '@/modules/i18n/locales/it/chat.json';
import jaChat from '@/modules/i18n/locales/ja/chat.json';
import koChat from '@/modules/i18n/locales/ko/chat.json';
import ruChat from '@/modules/i18n/locales/ru/chat.json';
import trChat from '@/modules/i18n/locales/tr/chat.json';
import zhCNChat from '@/modules/i18n/locales/zh-CN/chat.json';
import zhTWChat from '@/modules/i18n/locales/zh-TW/chat.json';
// Type-only, so it is erased before vi.mock's hoisted factory runs.
import type * as SharedApi from '@/shared/api';
import type { VoiceFailureReport, VoiceTranscriptionFailure } from '@/shared/types';
// The vocabulary as a VALUE: `import type` would be erased, and an erased list cannot be iterated.
// The name is the one AC-149 shipped — a rename there must redden this file, not silently empty it.
import { ASR_ERROR_CODES } from '@shared/asr/asrRegistry';

/* ─── AC1's scope: the doors this file keeps shut ───────────────────── */

/** This file, read as text by the door scan. */
const SELF_MODULE = fileURLToPath(import.meta.url);

const STARTED_AT = Date.now();

/** The fallback member's key inside `voice.errors`, spelled once. */
const FALLBACK_KEY_NAME = 'unknown';

/**
 * The shape of the sentence this task exists to remove: the transport's verb followed by a status
 * number. Read against every locale string (AC4a) and against the composer's own bubble (AC4b), so
 * one expression decides both — the pair is only meaningful if both ends read the same rule.
 */
const CONCAT_SHAPE = /transcribe\s*\(?\d+/i;

/**
 * A sentence that also merely OPENS with the transport's word is the same defect wearing a code
 * instead of a number, so the shape is read at the start of the string too.
 */
const CONCAT_PREFIX = 'transcribe';

/**
 * Placeholder tokens an untranslated cell might be filled with. `TODO` is matched CASE-SENSITIVELY
 * on purpose: Spanish "todo" is an ordinary word, and a case-insensitive scan would redden a
 * perfectly good translation for containing it.
 */
const PLACEHOLDERS: readonly string[] = ['TODO', 'FIXME', 'translation missing', 'missing translation'];

/**
 * A module specifier assembled from parts, so that the scan's own text cannot be the thing it
 * matches: spelled out, every candidate would appear in this file whether or not this file used it,
 * and the scan would report the criterion itself.
 */
const specifier = (parts: readonly string[]): string => `'${parts.join('')}'`;

/**
 * The doors a criterion in this family closes: a child process, a listening socket, an outbound
 * request, a thread, a server framework. `node:fs` is deliberately NOT among them — the scan below
 * has to read this file, and reading a source file opens no door the criterion is judged on.
 */
const FORBIDDEN_SPECIFIERS: readonly string[] = [
  specifier(['node:', 'child', '_process']),
  specifier(['node:', 'net']),
  specifier(['node:', 'http']),
  specifier(['node:', 'https']),
  specifier(['node:', 'dgram']),
  specifier(['node:', 'cluster']),
  specifier(['node:', 'tls']),
  specifier(['node:', 'worker', '_threads']),
  specifier(['expr', 'ess']),
  specifier(['mult', 'er']),
  specifier(['playwr', 'ight']),
];

/** The doors THIS file has open, computed from its own text. */
function openDoors(): string[] {
  const source = readFileSync(SELF_MODULE, 'utf8');
  return FORBIDDEN_SPECIFIERS.filter((candidate) => source.includes(candidate));
}

/* ─── The two shipped sets, and the data the readings iterate ───────── */

/** The slice of a `chat.json` these readings touch. Annotated rather than inferred, so the reads
 * below index by a vocabulary member the JSON module's literal type cannot know about. */
type ChatLocale = { voice?: { errors?: Record<string, string> } };

/**
 * The twelve locales the criterion imports, keyed by the language value `languages.ts` publishes.
 *
 * Every language is imported STATICALLY and named here; none is reached by a glob, because a glob
 * would silently cover a thirteenth directory added without copy and the set-equality reading below
 * would then be comparing the shipped list against itself.
 */
const LOCALES: Record<string, ChatLocale> = {
  en: enChat,
  fr: frChat,
  es: esChat,
  ko: koChat,
  'zh-CN': zhCNChat,
  'zh-TW': zhTWChat,
  ja: jaChat,
  ru: ruChat,
  de: deChat,
  tr: trChat,
  it: itChat,
  id: idChat,
};

/** The language values the app ships, in the order `languages.ts` declares them. */
const SHIPPED_LANGUAGES: readonly string[] = languages.map((language) => language.value);

/** Is this string one the concat reading rejects? */
const looksLikeConcat = (text: string): boolean =>
  CONCAT_SHAPE.test(text) || text.trim().toLowerCase().startsWith(CONCAT_PREFIX);

/**
 * The pair of readings a failure sentence has to survive: it must be the fallback copy for the
 * language, and it must not be the transport's verb-plus-number shape. AC4 applies both to the
 * locales and to the composer's bubble; AC6 (iii) applies both to a synthetic `transcribe 502`,
 * which is what proves the pair can tell the two apart instead of being true of anything.
 */
const readsAsLocalizedFallback = (text: string | null, fallbackText: string): boolean =>
  text !== null && text === fallbackText && !looksLikeConcat(text);

/**
 * The cells (language, key) a locale set does not fill in.
 *
 * Takes the vocabulary and the locales as arguments rather than closing over the shipped ones, which
 * is the whole point: false forms (1) and (2) call it with a vocabulary that gained a member and with
 * a locale that lost a cell, and the same function has to report the difference. A version that read
 * the module-level constants directly could only ever return the answer it was written beside.
 */
function missingCells(
  vocabulary: readonly string[],
  locales: Record<string, ChatLocale>,
): Array<{ lang: string; key: string }> {
  const keys = [...vocabulary, FALLBACK_KEY_NAME];
  const missing: Array<{ lang: string; key: string }> = [];
  for (const [lang, chat] of Object.entries(locales)) {
    for (const key of keys) {
      const value = chat.voice?.errors?.[key];
      if (typeof value !== 'string' || value.trim() === '') missing.push({ lang, key });
    }
  }
  return missing;
}

/** The cells of one language that are byte-identical to English — including a cell that is absent. */
function identicalToEnglish(lang: string, vocabulary: readonly string[]): string[] {
  const keys = [...vocabulary, FALLBACK_KEY_NAME];
  const errors = LOCALES[lang]?.voice?.errors;
  const english = LOCALES.en?.voice?.errors;
  assert.ok(errors, `the criterion imported no voice.errors for '${lang}'`);
  assert.ok(english, 'the criterion imported no voice.errors for en');
  return keys.filter((key) => errors[key] === english[key]);
}

/* ─── i18next, with the fallback language OFF ───────────────────────── */

/**
 * `fallbackLng: false` is load-bearing and not a style choice. With English as the fallback, a
 * locale missing `voice.errors.unknown` renders the English sentence, and AC4's equality — "the
 * bubble equals the current language's copy" — would pass over a locale that has no copy at all.
 * With it off, a missing key resolves to the KEY, which no locale's copy can equal.
 */
await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: false,
  ns: ['chat'],
  defaultNS: 'chat',
  resources: Object.fromEntries(
    Object.entries(LOCALES).map(([lang, chat]) => [lang, { chat }]),
  ),
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

/** The shipped translator for one language and the chat namespace, as a component would get it. */
const translate = (lang: string) => i18next.getFixedT(lang, 'chat');

/* ─── Fakes: the speech endpoint, and the browser the mic needs ─────── */

/**
 * The status a failing recogniser answers with, and the answer's body.
 *
 * The body carries NO `code`, which is the arm AC4 is about: the failure is one the vocabulary
 * cannot name, so the only correct sentence is the fallback — and the only incorrect one is the
 * transport's, which is what a `code`-less refusal used to produce.
 */
const REFUSAL_STATUS = 502;
const noCodeRefusalBody = { error: 'the upstream recogniser is unwell' };

/** A `Response`-shaped stand-in, with the `clone()` the hook reads the body from. */
const noCodeRefusal = () => ({
  ok: false,
  status: REFUSAL_STATUS,
  clone: () => ({ json: async () => noCodeRefusalBody }),
  json: async () => noCodeRefusalBody,
});

const { transcribeVoice, getFileIndex } = vi.hoisted(() => ({
  transcribeVoice: vi.fn(),
  getFileIndex: vi.fn(),
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    api: { getFileIndex },
    transcribeVoice,
    // The raw-corpus upload the hook fires after a listen; declared so this whole-module double stays
    // complete. It is never awaited, so a listen with the switch off produces no call and no reading
    // here depends on it.
    captureRawVoice: vi.fn(),
    synthesizeVoice: vi.fn(),
    voiceConfigSignature: () => 'test-signature',
    // The hook reads the recogniser's answer through this named export. It does no I/O, so it is
    // driven for real rather than doubled — the double exists to cut the speech endpoint, and a
    // second copy of the parse here would be a second copy of the thing under test.
    parseTranscriptionResponse: actual.parseTranscriptionResponse,
    // The declaration that decides whether the audio is changed before it is uploaded: taken from
    // the real accessor, so nothing here asserts against a stub of the trim's own decision. Nothing
    // has published a voice profile, so it answers "nothing to read" and the recording travels as it
    // was recorded; the trim is not what this file is reading.
    effectivePauseCuesDeclaration: actual.effectivePauseCuesDeclaration,
  };
});

// The real hook asks the backend whether a voice provider is configured; the mic button is gated on
// that, and both the composer and the hook harness below drive the mic.
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));

// The voice path's switches, all off/unset: a plain install, with the shipped segment minimum and
// idle auto-stop. Read here rather than through the environment so a developer's own flags cannot
// change what this file measures.
vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  // VAD on, the shipped default, so these cases still run the segmenting path.
  isVoiceVadEnabled: () => true,
  // The silence flush's window switch: absent means the shipped 5 s default, which these cases run under.
  voiceDebugFlushSilenceSec: () => undefined,
  voiceDebugMinSegmentSec: () => undefined,
  voiceDebugIdleSec: () => undefined,
  voiceDebugOriginalCapSec: () => undefined,
}));

const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();
const fakeStream = { getTracks: () => [{ stop: () => undefined }] };

/** The project's file tree, in the shape `GET …/files` answers with. The composer asks for it on
 * mount and the repair is not this file's subject, so one empty listing is all it needs. */
const FILES: unknown[] = [];
beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => fakeStream },
  });
  let counter = 0;
  createObjectURL.mockReset();
  createObjectURL.mockImplementation(() => `blob:clip-${++counter}`);
  revokeObjectURL.mockReset();
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;

  getFileIndex.mockReset();
  getFileIndex.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ files: FILES, truncated: false }),
  });
  transcribeVoice.mockReset();
  transcribeVoice.mockResolvedValue(noCodeRefusal());
});

// The object-URL stubs stay installed between tests on purpose: jsdom does not implement them at
// all, and testing-library's auto-cleanup unmounts the composer *after* this file's hooks run —
// restoring them here would make the unmount cleanup throw.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ─── The composer, driven through the real chain ───────────────────── */

/** The props `voiceTranscriptRepair.test.tsx` drives the real composer with; only `projectId` and
 * the transcript callback differ per case. */
const composerProps = (
  projectId: string,
  onVoiceTranscript: () => void,
  voiceCaptureEngine: ReturnType<typeof createFakeVoiceCapture>['engine'],
) =>
  ({
    voiceCaptureEngine,
    pendingPermissionRequests: [],
    handlePermissionDecision: () => undefined,
    handleGrantToolPermission: () => ({ success: true }),
    activity: null,
    isLoading: false,
    onAbortSession: () => undefined,
    permissionMode: 'default',
    availablePermissionModes: ['default'],
    onSelectPermissionMode: () => undefined,
    providerLabel: 'Claude',
    effort: 'medium',
    availableEffortOptions: [],
    onSelectEffort: () => undefined,
    model: 'test-model',
    availableModelOptions: [],
    onSelectModel: () => undefined,
    modelsLoading: false,
    tokenBudget: null,
    onShowTokenUsage: () => undefined,
    slashCommandsCount: 0,
    onToggleCommandMenu: () => undefined,
    hasInput: false,
    onClearInput: () => undefined,
    onSubmit: () => undefined,
    isDragActive: false,
    queuedDraft: null,
    isEditingSentMessage: false,
    onCancelEditMessage: () => undefined,
    scheduledMessages: [],
    onScheduleMessage: () => undefined,
    onCancelScheduledMessage: () => undefined,
    onEditQueuedDraft: () => undefined,
    onDeleteQueuedDraft: () => undefined,
    attachedFiles: [],
    onRemoveAttachment: () => undefined,
    fileErrors: new Map<string, string>(),
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    onSelectFile: () => undefined,
    filteredCommands: [],
    selectedCommandIndex: 0,
    onCommandSelect: () => undefined,
    onCloseCommandMenu: () => undefined,
    isCommandMenuOpen: false,
    frequentCommands: [],
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    openAttachmentPicker: () => undefined,
    inputHighlightRef: { current: null },
    renderInputWithMentions: () => null,
    textareaRef: { current: null },
    input: '',
    onVoiceTranscript,
    scope: 'session-a',
    projectId,
    isActive: true,
    onInputChange: () => undefined,
    onTextareaClick: () => undefined,
    onTextareaKeyDown: () => undefined,
    onTextareaPaste: () => undefined,
    onTextareaScrollSync: () => undefined,
    onTextareaInput: () => undefined,
    placeholder: 'Ask anything',
    isTextareaExpanded: false,
  }) as unknown as React.ComponentProps<typeof ChatComposer>;

/**
 * One full mic press on the real composer under one language, ending with whatever the recogniser
 * answered. The labels are the SHIPPED translations for that language, read through the same i18n
 * instance the composer uses — a language whose copy is missing resolves to the key, exactly as the
 * composer's own label does, so the press is found the same way in all twelve.
 */
const speakInto = async (lang: string, projectId: string) => {
  await act(async () => {
    await i18next.changeLanguage(lang);
  });
  const t = translate(lang);
  const capture = createFakeVoiceCapture();
  const view = render(
    React.createElement(ChatComposer, composerProps(projectId, () => undefined, capture.engine)),
  );
  // Drain the candidate fetch so the press is not judged against a half-mounted composer.
  await act(async () => {});
  await act(async () => {
    view.getByRole('button', { name: t('voice.input') }).click();
  });
  // Three seconds of speech: below the segment minimum, so the stop flushes one trailing segment.
  await act(async () => {
    capture.speak(3);
  });
  await act(async () => {
    view.getByRole('button', { name: t('voice.stopRecording') }).click();
  });
  // The flush enqueues the trailing segment; drain its upload tail so the bubble is observable. A
  // refused segment is retried before it is reported, so the wait covers the pipeline's own
  // backoff (250 ms + 500 ms), not just the microtask tail.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
  return { view, t };
};

/**
 * The sentence the shipped failure notice is showing, or `null` when no notice is on screen.
 *
 * Read from the notice's own layer, not by text search, and the layer's `textContent` is the whole
 * sentence — which is what makes the equality below an equality: an `includes` reading would pass on
 * the right copy with the transport's sentence glued to it. Nothing but the sentence is a text node
 * in that layer by design: the close control's name is an attribute, the fold's summary as well, and
 * the fold's own body is mounted only while it is open. So this reads the shipped sentence and
 * nothing else, and a sentence with anything appended to it is a different string.
 *
 * `null` when no notice is rendered, and that half is load-bearing: it is what stops "nothing was
 * shown at all" from being read as "the right sentence was shown".
 *
 * WHY THIS IS NO LONGER READ OFF THE MIC BUTTON. It used to climb from the button to the layer whose
 * first child was the bubble, because `VoiceInputButton` rendered the sentence above its own button.
 * It does not any more: the composer's form is `relative overflow-hidden` (so the textarea's
 * highlight layer clips to its rounded corners), so a notice drawn inside the form grows out of the
 * form's box and is clipped, and the close control — the notice's top row — ends up outside it,
 * where the element a pointer meets is the chat pane. The notice is therefore a sibling of the form,
 * drawn from the composer's own shell the way the activity indicator above it is, and the control's
 * reachability is read in `e2e/voice-error-messages.spec.ts` as
 * `close-reachable: … element-at-close=<…> reaches=true`. Only where this reading is taken from
 * moved; the reading itself is unchanged — the whole sentence, by equality, or no notice at all.
 */
const noticeSentence = (view: ReturnType<typeof render>): string | null => {
  const layer = view.queryByTestId('voice-error-notice');
  if (layer === null) return null;
  // The SENTENCE element, not the whole layer. The layer now also carries the spoken span a
  // continuous listen's failed segment occupied (`voice-error-segment`), which is a second fact the
  // notice shows beside the sentence; reading the sentence's own element keeps this an equality on
  // the copy rather than an `includes` that would pass on the right copy with anything glued to it.
  return layer.querySelector('[data-testid="voice-error-message"]')?.textContent ?? null;
};

/**
 * One full mic press on the real hook, with the failure it reported kept.
 *
 * The composer owns its error callback and does not hand it out, so the payload AC4(c) reads is
 * taken from the shipped producer of that payload — the hook — over the same fake answer the
 * composer above is driven with.
 */
const captureFailure = async (): Promise<VoiceFailureReport> => {
  const captured: VoiceFailureReport[] = [];
  const capture = createFakeVoiceCapture();
  const view = renderHook(() =>
    useVoiceInput(() => undefined, (failure) => captured.push(failure), {
      scope: 'session-a',
      isActive: true,
      captureEngine: capture.engine,
    }),
  );
  await act(async () => {
    view.result.current.toggle();
  });
  await act(async () => {
    capture.speak(3);
  });
  await act(async () => {
    view.result.current.stop();
  });
  // Cover the pipeline's retry backoff (250 ms + 500 ms) before a refused segment is reported.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
  const failure = captured.at(0);
  assert.equal(captured.length, 1, 'one refused capture has to report exactly one failure');
  assert.ok(failure !== undefined, 'the hook reported no failure for a refused transcription');
  view.unmount();
  return failure;
};

/* ─── The precondition every reading below rests on ─────────────────── */

test('the criterion\'s own i18n has no fallback language', () => {
  // WHY THIS IS A READING AND NOT A LINE IN THE INIT ABOVE. A fallback language turns "this locale
  // has no copy" into "this locale shows the English copy" — and English copy is copy, so AC2's
  // coverage reading and AC4's equality would both stay green over a locale with nothing in it.
  // The probe is decisive and independent of the locale data: a key that exists ONLY in English is
  // added for the length of this test, in a namespace of its own so no real bundle is touched.
  const ns = 'fallback-probe';
  i18next.addResourceBundle('en', ns, { probe: 'EN' }, true, true);
  try {
    const fromEnglish = i18next.getFixedT('en', ns)('probe');
    const fromGerman = i18next.getFixedT('de', ns)('probe');
    process.stdout.write(
      `fallback-probe en=${JSON.stringify(fromEnglish)} de=${JSON.stringify(fromGerman)} ` +
        `no-fallback=${fromGerman === 'probe'}\n`,
    );
    assert.equal(fromEnglish, 'EN', 'the probe key has to resolve inside the language that has it');
    assert.equal(
      fromGerman,
      'probe',
      'a fallback language is on: a German miss resolved to the English text, so every "missing copy" ' +
        'reading below would be measuring the fallback instead of the locale',
    );
  } finally {
    i18next.removeResourceBundle('en', ns);
  }
});

/* ─── AC2: twelve languages × the shipped vocabulary, every cell filled ─ */

test('AC2 every code in the shipped vocabulary has copy in every shipped language', () => {
  // The language set is the SHIPPED list, compared as a set against the locales this file imported:
  // a criterion that imported its own favourite subset would otherwise read green over the gap.
  assert.deepEqual(
    [...Object.keys(LOCALES)].sort(),
    [...SHIPPED_LANGUAGES].sort(),
    'the locales this criterion read are not the languages the app ships',
  );

  const vocabulary = [...ASR_ERROR_CODES];
  const missing = missingCells(vocabulary, LOCALES);
  for (const lang of SHIPPED_LANGUAGES) {
    const gaps = missing.filter((cell) => cell.lang === lang);
    process.stdout.write(
      `lang=${lang} keys=${vocabulary.length + 1} ` +
        `missing=${gaps.length === 0 ? '0' : gaps.map((cell) => cell.key).join(',')}\n`,
    );
  }
  const cells = SHIPPED_LANGUAGES.length * (vocabulary.length + 1);
  process.stdout.write(
    `langs=${SHIPPED_LANGUAGES.length} vocab=${vocabulary.length} cells=${cells} missing=${missing.length}\n`,
  );
  assert.equal(
    missing.length,
    0,
    `cells with no copy: ${missing.map((cell) => `${cell.lang}:${cell.key}`).join(' ')}`,
  );
});

/* ─── AC3: the non-English copy is a translation, not the English one ─── */

test('AC3 no non-English locale repeats the English sentence or a placeholder', () => {
  const vocabulary = [...ASR_ERROR_CODES];
  const keys = [...vocabulary, FALLBACK_KEY_NAME];
  let identical = 0;
  for (const lang of SHIPPED_LANGUAGES) {
    if (lang === 'en') continue;
    const errors = LOCALES[lang]?.voice?.errors ?? {};
    const same = identicalToEnglish(lang, vocabulary);
    identical += same.length;
    process.stdout.write(`lang=${lang} identical-to-en=${same.length}\n`);
    // Named separately from the identity reading: a cell filled with the KEY, or with a placeholder,
    // is not "translated" either, and neither of those would show up as an English copy.
    for (const key of keys) {
      const text = errors[key];
      assert.equal(
        typeof text === 'string' && text.trim() !== '' && text !== key && !PLACEHOLDERS.some((p) => text.includes(p)),
        true,
        `'${lang}' has no translation for voice.errors.${key}: ${JSON.stringify(text)}`,
      );
    }
  }
  process.stdout.write(`identical=${identical}\n`);
  assert.equal(
    identical,
    0,
    `cells that are still the English sentence: ${SHIPPED_LANGUAGES.filter((lang) => lang !== 'en')
      .flatMap((lang) => identicalToEnglish(lang, vocabulary).map((key) => `${lang}:${key}`))
      .join(' ')}`,
  );
});

/* ─── AC4: not the transport's sentence, on the locale side ──────────── */

test('AC4a no shipped locale sentence is the transport verb plus a status number', () => {
  const hits: string[] = [];
  for (const lang of SHIPPED_LANGUAGES) {
    const errors = LOCALES[lang]?.voice?.errors ?? {};
    for (const [key, text] of Object.entries(errors)) {
      if (typeof text === 'string' && looksLikeConcat(text)) hits.push(`${lang}:${key}=${text}`);
    }
  }
  process.stdout.write(`concat-hits=${hits.length}${hits.length ? ` [${hits.join(' | ')}]` : ''}\n`);
  assert.equal(hits.length, 0, `locale sentences shaped like the transport's: ${hits.join(' ')}`);
});

/* ─── AC4: not the transport's sentence, on the shipped composer ─────── */

// Its own budget: twelve languages, each paying the segment pipeline's retry backoff before the
// refusal is reported, is well past vitest's 5s default.
test('AC4b the shipped composer shows the fallback copy, in every language, for a code-less refusal', async () => {
  let allEqual = true;
  let lastText: string | null = null;
  for (const [index, lang] of SHIPPED_LANGUAGES.entries()) {
    const unknownText = translate(lang)('voice.errors.unknown');
    assert.notEqual(
      unknownText,
      'voice.errors.unknown',
      `'${lang}' has no voice.errors.unknown copy, so this reading would compare a key to itself`,
    );
    const { view } = await speakInto(lang, `project-error-${index}`);
    lastText = noticeSentence(view);
    const equals = readsAsLocalizedFallback(lastText, unknownText);
    allEqual &&= equals;
    process.stdout.write(
      `lang=${lang} unknown=${JSON.stringify(unknownText)} composer-text=${JSON.stringify(lastText)} ` +
        `equals-unknown=${equals}\n`,
    );
    view.unmount();
  }
  process.stdout.write(`composer-text=${JSON.stringify(lastText)} equals-unknown=${allEqual}\n`);
  assert.equal(
    allEqual,
    true,
    'the composer did not show the language\'s own fallback sentence for a refusal that carries no code',
  );
}, 40_000);

test('AC4c the refusal keeps its status, and the technical detail still carries the number', async () => {
  const failure = await captureFailure();
  assert.equal(typeof failure === 'string', false, 'a refusal must not arrive as a finished sentence');
  const payload = failure as VoiceTranscriptionFailure;
  const detail = voiceErrorTechnicalDetail(payload);
  const unknownText = translate('en')('voice.errors.unknown');

  process.stdout.write(
    `status=${String(payload.status)} technical-detail=${JSON.stringify(detail)} ` +
      `status-preserved=${detail.includes(String(REFUSAL_STATUS))}\n`,
  );
  assert.equal(payload.status, REFUSAL_STATUS, 'the refusal lost the status the seam answered with');
  assert.ok(
    detail.includes(String(REFUSAL_STATUS)),
    `the technical detail does not carry the status number: ${JSON.stringify(detail)}`,
  );
  // The same failure, read by the mapping the composer uses: it is the fallback sentence, not the
  // transport's. This is the composer's reading taken one layer down, on the payload itself.
  assert.equal(
    readsAsLocalizedFallback(voiceErrorMessage(payload, translate('en')), unknownText),
    true,
    'the code-less refusal did not map to the fallback copy',
  );
});

/* ─── AC5: the mapping covers the vocabulary, and only the unknown falls back ─ */

test('AC5 the code-to-copy mapping covers the vocabulary and has a real fallback', () => {
  const vocabulary = [...ASR_ERROR_CODES];
  const langs = ['en', 'zh-CN'];
  let mapped = 0;
  const distinct = new Set<string>();
  let everyCodeDiffersFromFallback = true;
  for (const lang of langs) {
    const t = translate(lang);
    const errors = LOCALES[lang]?.voice?.errors ?? {};
    const fallbackText = t('voice.errors.unknown');
    for (const code of vocabulary) {
      const message = voiceErrorMessage({ code }, t);
      mapped += 1;
      distinct.add(message);
      assert.equal(
        message,
        errors[code],
        `'${lang}' mapped ${code} to ${JSON.stringify(message)} instead of its own copy`,
      );
      everyCodeDiffersFromFallback &&= message !== fallbackText;
    }
  }
  // The positive controls: without them "every code returns the fallback" would read green.
  assert.ok(
    distinct.size >= 2,
    'at least two codes have to read differently — one sentence for all of them is not a mapping',
  );

  const t = translate('en');
  const unknownText = t('voice.errors.unknown');
  const unknownCode = voiceErrorMessage({ code: 'Some.Future.Code' }, t);
  const noCode = voiceErrorMessage({ status: REFUSAL_STATUS }, t);

  process.stdout.write(
    `vocab=${vocabulary.length} mapped=${mapped} distinct-messages=${distinct.size} ` +
      `fallback-distinct=${everyCodeDiffersFromFallback} unknown-code=${unknownCode === unknownText} ` +
      `no-code=${noCode === unknownText}\n`,
  );
  assert.equal(everyCodeDiffersFromFallback, true, 'a code in the vocabulary mapped to the fallback copy');
  assert.equal(unknownCode, unknownText, 'a code outside the vocabulary must take the fallback copy');
  assert.equal(noCode, unknownText, 'a failure with no code must take the fallback copy');
  assert.equal(
    voiceErrorKey({ code: 'Some.Future.Code' }),
    'voice.errors.unknown',
    'the mapping has to answer with the fallback key, not a key built out of the unknown code',
  );
});

/* ─── AC6: the three false forms, in memory, in this run ─────────────── */

test('AC6 each false form reddens exactly the reading it should, and the shipped data stays green', () => {
  const vocabulary = [...ASR_ERROR_CODES];
  const t = translate('en');
  const unknownText = t('voice.errors.unknown');
  const outcomes: string[] = [];

  /* (1) the vocabulary gains a code and the copy does not follow */
  const grownVocabulary = [...vocabulary, 'SYNTHETIC_FUTURE_CODE'];
  const grownMissing = missingCells(grownVocabulary, LOCALES);
  const grownCells = grownMissing.filter((cell) => cell.key === 'SYNTHETIC_FUTURE_CODE');
  const baseMissing = missingCells(vocabulary, LOCALES);
  outcomes.push(
    `mutation=vocab-gains-a-code base-green=${baseMissing.length === 0} ` +
      `mutant-red=${grownCells.length === SHIPPED_LANGUAGES.length} ` +
      `which=ac2-coverage-cell(s) ${grownCells.map((cell) => `${cell.lang}:${cell.key}`).join(',')} ` +
      `outside-family-green=${baseMissing.length === 0}`,
  );
  assert.equal(
    grownCells.length,
    SHIPPED_LANGUAGES.length,
    'a code added to the vocabulary must leave one missing cell per shipped language',
  );
  assert.deepEqual(
    grownMissing.map((cell) => cell.lang).sort(),
    [...SHIPPED_LANGUAGES].sort(),
    'the missing cells of a grown vocabulary must be exactly the shipped languages, no more',
  );
  assert.equal(baseMissing.length, 0, 'the un-mutated vocabulary must still report no missing cell');

  /* (2) one locale loses one cell */
  const victimLang = 'de';
  const victimKey = [...vocabulary][0];
  assert.ok(victimKey, 'the vocabulary has to name at least one code for this false form');
  const mutantLocales: Record<string, ChatLocale> = {
    ...LOCALES,
    [victimLang]: {
      voice: {
        errors: Object.fromEntries(
          Object.entries(LOCALES[victimLang]?.voice?.errors ?? {}).filter(([key]) => key !== victimKey),
        ),
      },
    },
  };
  const mutantMissing = missingCells(vocabulary, mutantLocales);
  const named = mutantMissing.map((cell) => `${cell.lang}:${cell.key}`);
  outcomes.push(
    `mutation=locale-missing-a-key base-green=${baseMissing.length === 0} ` +
      `mutant-red=${named.length === 1 && named[0] === `${victimLang}:${victimKey}`} ` +
      `which=ac2-coverage-cell(s) ${named.join(',')} ` +
      `outside-family-green=${missingCells(vocabulary, LOCALES).length === 0}`,
  );
  assert.deepEqual(
    named,
    [`${victimLang}:${victimKey}`],
    'deleting one cell must name exactly that (language, code) and nothing else',
  );

  /* (3) the transport's sentence, read by the same pair of readings the shipped path passes */
  const concatSentence = `transcribe ${REFUSAL_STATUS}`;
  const concatCaught = looksLikeConcat(concatSentence);
  const concatIsNotTheCopy = concatSentence !== unknownText;
  const shippedPasses = readsAsLocalizedFallback(unknownText, unknownText);
  outcomes.push(
    `mutation=concat-fallback base-green=${shippedPasses} ` +
      `mutant-red=${concatCaught && concatIsNotTheCopy} ` +
      `which=ac4-concat-shape+equality regex=${CONCAT_SHAPE.test(concatSentence)} ` +
      `not-equal-unknown=${concatIsNotTheCopy} outside-family-green=${!looksLikeConcat(unknownText)}`,
  );
  assert.equal(concatCaught, true, 'the concat shape has to be caught by the reading that forbids it');
  assert.equal(concatIsNotTheCopy, true, 'the concat sentence must not read as the fallback copy');
  assert.equal(
    readsAsLocalizedFallback(concatSentence, unknownText),
    false,
    'the equality reading has to reject the transport sentence',
  );
  assert.equal(shippedPasses, true, 'the pair of readings must stay green on the shipped copy');
  assert.equal(looksLikeConcat(unknownText), false, 'the shipped fallback must not look like a concat');

  for (const line of outcomes) process.stdout.write(`${line}\n`);

  // The in-file face of "no residue": every mutation above was a clone, and the shipped data is
  // read once more after all three have run — against the values the shipped data is EXPECTED to
  // hold, not against itself. A phase that had leaked into the shipped objects would show up as a
  // vocabulary of the wrong length or a locale cell that is no longer its language's copy.
  const intact =
    ASR_ERROR_CODES.length === vocabulary.length &&
    JSON.stringify([...ASR_ERROR_CODES]) === JSON.stringify(vocabulary) &&
    LOCALES[victimLang]?.voice?.errors?.[victimKey] === translate(victimLang)(`voice.errors.${victimKey}`);
  process.stdout.write(`shipped-intact=${intact} clones-in-memory=true\n`);
  assert.equal(intact, true, 'the mutation phases changed the shipped vocabulary or locales');
});

/* ─── AC1: the budget, and the doors ─────────────────────────────────── */

test('AC1 budget and scope', () => {
  const elapsed = Date.now() - STARTED_AT;
  const doors = openDoors();

  process.stdout.write(`subprocess-imports=${doors.length}\n`);
  process.stdout.write(`elapsed-ms=${elapsed}\n`);
  process.stdout.write(
    `reading AC1 scope = elapsed-ms=${elapsed} subprocess-imports=${doors.length} ` +
      `[${doors.join(' ')}] offline-transcribe=injected\n`,
  );

  assert.deepEqual(
    doors,
    [],
    `this criterion imports a module that can start a process or open a socket: ${doors.join(', ')}`,
  );
  assert.ok(elapsed < 30_000, `the criterion took ${elapsed}ms, past its own 30s budget`);
});
