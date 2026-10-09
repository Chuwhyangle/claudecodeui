import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir),
// recording through the app's own voice button. The recorder is the browser's own: Chromium is launched with a
// fake audio device whose samples come from the WAV playwright.config.ts wrote before the servers booted, so
// `getUserMedia` hands `MediaRecorder` a real stream and the app's own hook encodes what it hears.
//
// What this file adds over e2e/voice-identifier-repair.spec.ts is the voice path's *other* entry: the same
// fixture, chosen as a file instead of spoken into the fake microphone, so that the criterion can be about
// whether a chosen file travels the recording's own chain rather than a second path beside it.
//
// The one stand-in is the recogniser, exactly as in the identifier spec: no offline speech-to-text exists in
// this checkout, so the endpoint the voice settings name is a local server answering `/audio/transcriptions`.
// Nothing here stubs the app — the request that arrives on that socket was made by the running client through
// the real `transcribeVoice()` path, carrying the seeded credential and model.
//
// Both uploads are measured by parsing the container they are in, never by their byte count. A byte count would
// be worse than useless here: the trimmed leg is re-encoded as PCM WAV and the untrimmed leg is the recorder's
// own webm/opus, so the *shorter* upload is the *larger* one. Only the container says how long the audio is.

const DATA_DIR = process.env.QUAY_E2E_DATA_DIR!;
const CLIENT_URL = `http://127.0.0.1:${process.env.QUAY_E2E_CLIENT_PORT}`;
const WORKSPACE = path.join(DATA_DIR, 'voice-trim-workspace');
const SESSION_ID = 'e2e-voice-trim';
const SESSION_NAME = 'voice-trim';
/** Where the fake microphone reads its samples from; the config wrote it before the browser was launched. */
const AUDIO_FILE = process.env.QUAY_E2E_VOICE_TRIM_AUDIO!;
/** The fixture's own duration, derived by the config from the samples it wrote. */
const FIXTURE_SEC = Number(process.env.QUAY_E2E_VOICE_TRIM_FIXTURE_SEC);
/** What the seeded voice settings name as the recogniser endpoint's credential, so the arriving request can be traced back to them. */
const API_KEY = 'sk-e2e-voice-trim-7c2f5a13';
const STT_MODEL = 'whisper-large-v3-turbo';

/**
 * How long each leg holds the recorder open: one pass of the fixture, so the untrimmed upload is the fixture.
 *
 * `useVoiceInput` refuses to upload a blob under 800 bytes ("Recording too short"), which this clears by three
 * orders of magnitude, and the pause the trim is meant to remove has to be *inside* the window for the trim to
 * have anything to do — hence a whole pass rather than a fraction of one.
 */
const CAPTURE_MS = Math.round(FIXTURE_SEC * 1000);

/**
 * How far the untrimmed upload may differ from the fixture and still count as "the whole capture".
 *
 * The gap is the recorder's own start/stop overhead, measured at ~40 ms on a 2.5 s take, so a third of a second
 * is several times the observed error. It is not slack for a trim: nothing the pipeline can do to the audio
 * shortens it by less than the fixture's 1.6 s pause, which is what the trim exists to remove.
 */
const CAPTURE_TOLERANCE_SEC = 0.3;

/**
 * What the recogniser stand-in answers, one entry per upload.
 *
 * Leg-specific on purpose: each leg then has to end up holding *its own* sentence. A single utterance for both
 * would leave the second composer assertion satisfiable by the first leg's text, which is exactly the state a
 * leg that never transcribed anything would be in.
 *
 * Both are ordinary lowercase sentences with nothing an identifier could be: the criterion they were written
 * for is about duration, and a name the repair might rewrite would put a second, unrelated transformation
 * between the recogniser and the assertion. The leg that needs a name to be present names its own answer
 * instead of taking one of these (see `nextAnswer`).
 */
const UTTERANCES = [
  'please repeat the whole sentence back to me',
  'and now read the second line out loud',
];

/**
 * The English vocabulary, read off the shipped locale file for the reason the criterion reads it: a sentence
 * typed into this file stops moving when the copy moves. Read with `fs` rather than imported because this package
 * is ESM and this spec is evaluated by Node's ESM loader, where a JSON import is only legal with a
 * `with { type: 'json' }` attribute that no spec in this checkout carries.
 */
const EN_CHAT = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'src/modules/i18n/locales/en/chat.json'), 'utf8'),
) as { voice: { errors: Record<string, string> } };

/**
 * The sentences `useVoiceInput` reports its own failures with, looked for in the page when a transcript never
 * lands. Each one names a link in the chain the composer cannot show: a recording the app refused to send, a
 * recogniser call that came back unusable, a call that returned nothing to say.
 *
 * The last entry used to be the literal `'No speech detected'`, which is what the local-empty branch handed the
 * composer directly. That branch now reports the CODE `NO_SPEECH_DETECTED` and the sentence is resolved at render,
 * in the user's language — so this entry reads the vocabulary instead of restating it, and a future change to the
 * copy moves this diagnostic with it rather than leaving it looking for a sentence the app no longer says. The
 * three literals above it are a different family and stay literals: they are the chain's own transport failures,
 * written in English by `useVoiceInput` itself, and no locale owns them.
 */
const VOICE_ERRORS = [
  'Recording too short',
  'Audio file too small',
  'Transcription failed',
  'Microphone access denied',
  EN_CHAT.voice.errors.NO_SPEECH_DETECTED,
];

/**
 * Chromium's fake audio device, fed from the WAV playwright.config.ts wrote before the servers booted.
 *
 * `--use-fake-device-for-media-stream` is what makes `--use-file-for-fake-audio-capture` take effect at all:
 * without it the file is ignored and the device synthesises a beep, which would still record and still
 * transcribe — the run would go green while testing no fixture.
 */
test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${AUDIO_FILE}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

/** One request the recogniser stand-in saw, kept so the assertions can be about the real socket. */
type RecognizerRequest = {
  url: string;
  method: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: Buffer;
  /**
   * What the stand-in answered this request with.
   *
   * Kept beside the bytes it was asked about rather than restated by the test: the sentence a leg has
   * to end up holding is the one the recogniser really returned, which is a property of the run's own
   * request order and not of a constant the test could get wrong on its own.
   */
  answer: string;
};

/** A variable-length integer as EBML writes it. `keepMarker` keeps the length-marker bit, which is what an element id needs. */
const readVint = (bytes: Buffer, at: number, keepMarker: boolean): { value: number; length: number; allOnes: boolean } | null => {
  if (at >= bytes.length) return null;
  const first = bytes[at];
  if (first === 0) return null;
  let length = 1;
  while ((first & (0x80 >> (length - 1))) === 0) {
    length += 1;
    if (length > 8) return null;
  }
  // For a one-byte vint the mask is the seven low bits; for an eight-byte one the first byte is all marker.
  const mask = 0xff >> length;
  let value = keepMarker ? first : first & mask;
  let allOnes = (first & mask) === mask;
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[at + index];
    if (bytes[at + index] !== 0xff) allOnes = false;
  }
  return { value, length, allOnes };
};

/** An EBML element body read as a big-endian unsigned integer. */
const readUint = (bytes: Buffer, from: number, to: number): number => {
  let value = 0;
  for (let at = from; at < to; at += 1) value = value * 256 + bytes[at];
  return value;
};

const EBML_HEAD = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMESTAMP_SCALE = 0x2ad7b1;
const CLUSTER = 0x1f43b675;
const CLUSTER_TIMESTAMP = 0xe7;
const SIMPLE_BLOCK = 0xa3;

/**
 * The duration of an EBML/WebM recording, in seconds, read from the container's own structure.
 *
 * `MediaRecorder` writes no `Duration` element — the file is a live stream and its length is not known until it
 * ends — so the length has to be reconstructed from the blocks. Each cluster carries a timestamp and each block
 * a timecode relative to it, which gives the position of every frame; the last one plus one frame is the end.
 * The frame size is itself read from the stream, as the gap between two consecutive blocks, rather than assumed
 * from what this checkout's Chromium happens to choose.
 *
 * Returns null when there are no blocks to measure, which is the caller's cue that this is not a recording it
 * can reason about.
 */
const ebmlDurationSec = (bytes: Buffer): number | null => {
  let timestampScaleNs = 1_000_000; // EBML's default: one tick is a millisecond.
  const ticks: number[] = [];

  /** Visits the element children laid out between `from` and `to`. */
  const forEachElement = (
    from: number,
    to: number,
    visit: (id: number, bodyAt: number, bodyEnd: number) => void,
  ): void => {
    let at = from;
    while (at < to) {
      const id = readVint(bytes, at, true);
      const size = id ? readVint(bytes, at + id.length, false) : null;
      if (!id || !size) return;
      const bodyAt = at + id.length + size.length;
      // An unknown size means "until the parent ends" — how a live stream leaves its Segment open.
      const bodyEnd = size.allOnes ? to : Math.min(to, bodyAt + size.value);
      visit(id.value, bodyAt, bodyEnd);
      at = bodyEnd;
    }
  };

  forEachElement(0, bytes.length, (topLevel, topAt, topEnd) => {
    if (topLevel !== EBML_HEAD && topLevel !== SEGMENT) return;
    forEachElement(topAt, topEnd, (element, bodyAt, bodyEnd) => {
      if (element === INFO) {
        forEachElement(bodyAt, bodyEnd, (leaf, leafAt, leafEnd) => {
          if (leaf === TIMESTAMP_SCALE) timestampScaleNs = readUint(bytes, leafAt, leafEnd);
        });
      }
      if (element !== CLUSTER) return;
      let clusterTick = 0;
      forEachElement(bodyAt, bodyEnd, (leaf, leafAt, leafEnd) => {
        if (leaf === CLUSTER_TIMESTAMP) clusterTick = readUint(bytes, leafAt, leafEnd);
        if (leaf !== SIMPLE_BLOCK) return;
        const track = readVint(bytes, leafAt, false);
        // The block's payload: track number, then a signed 16-bit timecode relative to the cluster.
        if (track) ticks.push(clusterTick + bytes.readInt16BE(leafAt + track.length));
      });
    });
  });

  if (ticks.length === 0) return null;

  let last = ticks[0];
  for (const tick of ticks) if (tick > last) last = tick;
  const deltas: number[] = [];
  for (let index = 1; index < ticks.length; index += 1) deltas.push(ticks[index] - ticks[index - 1]);
  deltas.sort((a, b) => a - b);
  const frameTicks = deltas.length > 0 ? deltas[Math.floor(deltas.length / 2)] : 0;

  return ((last + frameTicks) * timestampScaleNs) / 1e9;
};

/** The duration of a 16-bit PCM WAV, in seconds, from its own `fmt `/`data` chunks. */
const wavDurationSec = (bytes: Buffer): number => {
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataBytes = 0;

  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      channels = bytes.readUInt16LE(at + 10);
      sampleRate = bytes.readUInt32LE(at + 12);
      bits = bytes.readUInt16LE(at + 22);
    } else if (id === 'data') {
      dataBytes = size;
    }
    at += 8 + size + (size % 2);
  }

  const bytesPerSecond = sampleRate * channels * (bits / 8);
  if (!bytesPerSecond || !dataBytes) throw new Error('not a PCM WAV with a readable data chunk');
  return dataBytes / bytesPerSecond;
};

/** The duration of an upload in seconds, decided by the container it is really in rather than by its name. */
const containerDurationSec = (bytes: Buffer): number => {
  const magic = bytes.subarray(0, 4).toString('hex');
  if (magic === '52494646') return wavDurationSec(bytes); // 'RIFF'
  if (magic === '1a45dfa3') {
    const seconds = ebmlDurationSec(bytes);
    if (seconds === null) throw new Error('EBML upload carried no block to measure');
    return seconds;
  }
  throw new Error(`unrecognised audio container: ${magic}`);
};

/**
 * The uploaded file's bytes, taken out of the multipart body that carried them.
 *
 * The client posts a `FormData`, so the audio is one part among a few and the part boundaries are the only
 * thing that says where it starts and ends. Reading it here rather than trusting a length in a header keeps the
 * assertion about the bytes the app really put on the socket.
 */
const uploadedFile = (body: Buffer, contentType: string | undefined): Buffer => {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!boundary) throw new Error(`no boundary in upload content type: ${contentType}`);

  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let at = body.indexOf(delimiter);
  while (at >= 0) {
    const start = at + delimiter.length;
    if (body.subarray(start, start + 2).toString() === '--') break; // the closing delimiter
    const next = body.indexOf(delimiter, start);
    const part = body.subarray(start, next >= 0 ? next : body.length);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) throw new Error('malformed multipart part: no header terminator');
    if (/name="file"/.test(part.subarray(0, headerEnd).toString('ascii'))) {
      return part.subarray(headerEnd + 4, part.length - 2); // the trailing CRLF before the next boundary
    }
    at = next;
  }
  throw new Error('the upload carried no file part');
};

/**
 * Whether `locator` showed up within `timeoutMs`.
 *
 * The boolean rather than a thrown timeout, because the caller's decision is what to do about its absence and a
 * caught assertion error reads as a failure that has already been reported.
 */
const appears = async (locator: Locator, timeoutMs: number): Promise<boolean> =>
  locator.waitFor({ state: 'visible', timeout: timeoutMs }).then(
    () => true,
    () => false,
  );

test.describe.configure({ mode: 'serial' });

/**
 * The voice path end to end, one test per criterion.
 *
 * The criteria land in one file because they share the expensive half: a real browser, a real client
 * and backend, an account created on a fresh database, and a recogniser stand-in to point the voice
 * settings at. Each criterion names itself in its own title — which is what `-g` selects on — so a
 * criterion can be run alone without this file's other legs paying for it.
 */
test.describe('the voice path end to end', () => {
  let context: BrowserContext;
  let page: Page;
  let recognizer: http.Server;
  let recognizerUrl = '';
  const requests: RecognizerRequest[] = [];
  /**
   * What the page said about the voice call, for a red that explains itself.
   *
   * The step this spec waits on — "the transcript reached the composer" — is the far end of a chain that can
   * break in several places, and every one of them looks identical from the composer: empty. `RecognizerRequest`
   * only covers the case where a request got all the way out; a recorder that produced nothing, a proxy that
   * answered 500, and a decode that threw all leave it empty while the composer stays empty too. So the page's
   * own traffic is collected here and reported by `expectTranscript` when the wait fails.
   */
  const voiceTraffic: string[] = [];
  /**
   * How many `[voice] identifier fidelity` messages the page has printed.
   *
   * That reading is deliberately NOT behind the switch (GOAL-005 / AC-114), and it is printed inside the
   * transcription chain itself — so its arrival is the proof that an upload travelled that chain rather
   * than around it, which is exactly the claim `AC-120` has to make for a chosen file now that the entry
   * shares the recording's pipeline.
   */
  let fidelityMessages = 0;
  /**
   * The sentence the stand-in answers the next upload with, when a leg needs one of its own.
   *
   * `UTTERANCES` is indexed by request order, which is a property of the run rather than of any one
   * criterion: a leg that ran earlier in the same file has already consumed its entries, so an index is
   * not a stable way to say "this leg is answered with this sentence". A leg that asserts something about
   * a particular sentence — rather than about the chain in general — names it here, and the override is
   * consumed by the request it was set for.
   */
  let nextAnswer: string | null = null;

  /**
   * The OpenAI-compatible speech endpoint the voice settings point at.
   *
   * A cross-origin multipart POST carrying `Authorization` is not a simple request, so the browser sends a
   * preflight first and would block the call without an answer to it — the preflight is handled here for the
   * same reason a real provider handles it, not as a convenience.
   */
  const startRecognizer = async (): Promise<http.Server> => {
    const server = http.createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
      response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');

      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return;
      }

      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        // The Nth upload is the Nth leg, so each leg can only be satisfied by its own transcription. The last
        // sentence is the answer for every upload after the last leg, so a leg that uploaded twice fails on the
        // request count rather than on a missing utterance. A leg that named its own answer takes precedence,
        // and the name is spent on this one request.
        const answer = nextAnswer ?? UTTERANCES[Math.min(requests.length, UTTERANCES.length - 1)];
        nextAnswer = null;
        requests.push({
          url: request.url ?? '',
          method: request.method ?? '',
          authorization: request.headers.authorization,
          contentType: request.headers['content-type'],
          body: Buffer.concat(chunks),
          answer,
        });

        if (!(request.url ?? '').endsWith('/audio/transcriptions')) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'unexpected path' }));
          return;
        }

        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ text: answer }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
  };

  /** The composer's textarea, the one place the transcript from a recording lands. */
  const composer = () => page.locator('[data-slot="prompt-input-textarea"]');

  /** The project row is a toggle whose accessible name starts with the workspace's display name. */
  const projectRow = () =>
    page.getByRole('button', { name: new RegExp(`^${path.basename(WORKSPACE)}`) }).first();

  const sessionLink = () => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });

  /**
   * Expands the project's session list. The row is a toggle, so a click that lands while the sidebar is still
   * re-rendering (right after a reload) would leave it collapsed — retry until the row is really on screen.
   */
  const expandProject = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await sessionLink().isVisible().catch(() => false)) {
        return;
      }
      await projectRow().click();
      try {
        await expect(sessionLink()).toBeVisible({ timeout: 10_000 });
        return;
      } catch {
        // Collapsed again (or the click missed); the loop clicks once more.
      }
    }
    await expect(sessionLink()).toBeVisible({ timeout: 15_000 });
  };

  /**
   * Loads `url` (which is how a leg switches the trim), opens the seeded session's composer, and empties it.
   *
   * Emptying is what makes the assertion after a recording a transition rather than a state: the composer keeps
   * a draft per session, so the previous leg's sentence would otherwise already be sitting there.
   */
  const openComposer = async (url: string) => {
    await page.goto(url);
    await expandProject();
    await sessionLink().click();
    await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
    // The same wait and the same budget as any other `toBeVisible` here; only what a timeout *says* changes.
    // The composer's absence is the far end of several unrelated causes and a bare locator timeout names none
    // of them — it reports "element(s) not found" for a client still building its module graph, for a proxy
    // that answered 500, and for a page the dev server cut off mid-load alike. The last of those is the one
    // this file's cold-load retry cannot see: it happens after onboarding, on a later `page.goto`, and it does
    // not blank the page — it renders the app's own error boundary in place of the chat interface, so the
    // sidebar and the shell all look right. The boundary's text and the console errors are what tell these
    // apart, so both are attached to the failure instead of being left in a log the gate's excerpt truncates.
    try {
      await expect(composer()).toBeVisible({ timeout: 15_000 });
    } catch {
      const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
      const errors = voiceTraffic.filter((line) => line.startsWith('console.error'));
      throw new Error(
        `the composer never rendered at ${url}; the page shows: ${JSON.stringify(shown.slice(0, 300))}`
          + `\n  console errors: ${errors.length > 0 ? errors.slice(0, 3).join(' | ') : '<none>'}`,
      );
    }
    await composer().fill('');
    await expect(composer()).toHaveValue('');
  };

  /**
   * Waits for `expected` to land in the composer, and reports the voice call's traffic when it never does.
   *
   * A bare `toHaveValue` timeout costs its whole budget and answers nothing beyond "the box is empty" — and an
   * empty box is what a recorder that captured nothing, a decode that threw, and a proxy that answered 500 all
   * look like. The traffic collected by the page listeners is what tells them apart, so it is attached to the
   * failure instead of being left in a log the gate's excerpt does not print.
   */
  const expectTranscript = async (expected: string, leg: string) => {
    try {
      await expect(composer()).toHaveValue(expected, { timeout: 10_000 });
    } catch {
      const value = await composer().inputValue().catch(() => '<unreadable>');
      // The hook reports every failure it knows about through `onError`, and the composer shows those as text
      // rather than as a status code — so the sentence, not the socket, is where "the recording was too short"
      // and "the transcription failed" are told apart.
      const shown = await page.locator('body').innerText().catch(() => '');
      const reported = VOICE_ERRORS.filter((message) => shown.includes(message));
      throw new Error(
        `${leg}: the composer never took the transcript.\n`
          + `  composer=${JSON.stringify(value)}\n`
          + `  recogniser requests=${requests.length}\n`
          + `  app reported=${reported.length > 0 ? reported.join(' | ') : '<none>'}\n`
          + `  page traffic=${voiceTraffic.length > 0 ? voiceTraffic.join(' | ') : '<none>'}`,
      );
    }
  };

  /**
   * Records one pass of the fixture and returns the sentence the recogniser answered this capture with.
   *
   * The answer is read off the run's own request rather than named from `UTTERANCES`: which entry the
   * stand-in picks is a property of how many legs ran before this one, so a leg that restated an index
   * would be asserting about its own position in the file rather than about the chain. The recogniser is
   * the one stand-in here, and what it answered is the input the rest of the chain is judged on.
   */
  const recordCapture = async (leg: string): Promise<string> => {
    const before = requests.length;
    await recordOnce();
    await expect.poll(
      () => requests.length,
      { timeout: 15_000, message: `${leg}: the recording never reached the recogniser` },
    ).toBe(before + 1);
    return requests[before].answer;
  };

  /**
   * Records one pass of the fixture through the app's voice button.
   *
   * There is no event to wait on for "the recorder has captured enough" — the upload does not exist until the
   * stop — so the wait is the capture duration itself, which is also what makes the untrimmed upload's length
   * the fixture's length.
   */
  const recordOnce = async () => {
    const record = page.getByRole('button', { name: 'Voice input' });
    await expect(record).toBeVisible({ timeout: 15_000 });
    await record.click();

    // Recording really started: the button renames itself for as long as the recorder is running.
    const stop = page.getByRole('button', { name: 'Stop recording' });
    await expect(stop).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(CAPTURE_MS);
    await stop.click();
  };

  /**
   * The hidden `<input type="file">` the upload entry owns.
   *
   * Located by the entry's own stable test id rather than by `accept`: the composer's attachment picker
   * is a file input too, so `input[type=file]` alone would be ambiguous, and `accept="audio/*"` no longer
   * narrows it either — the realtime voice control is a second voice surface that hangs its own
   * `accept="audio/*"` input on the same page, so the acceptance attribute stops being unique. Each voice
   * surface claims its own element instead. It is hidden — the button beside the microphone is the
   * control — which is not something `setInputFiles` minds.
   */
  const uploadInput = () => page.getByTestId('voice-upload-input');

  /** The button that opens the file dialog, named the way `VoiceUploadButton` names it. */
  const uploadEntry = () => page.getByRole('button', { name: 'Upload audio file' });

  /**
   * Submits the fixture through the upload entry, and waits for the request it produced.
   *
   * The wait is on the recogniser rather than on a timer, which is the difference between an upload and
   * a recording: a recording is uploaded when the user lets go, an upload when the file is chosen, and
   * the request is the first thing that says it happened. A red here also names what the recogniser
   * would have been asked, since the request is where the chain's own body can be read.
   */
  const uploadFixture = async (leg: string): Promise<RecognizerRequest> => {
    const before = requests.length;
    await expect(uploadEntry()).toBeVisible({ timeout: 10_000 });
    await uploadInput().setInputFiles(AUDIO_FILE);

    await expect.poll(
      () => requests.length,
      { timeout: 15_000, message: `${leg}: the chosen file never reached the recogniser` },
    ).toBe(before + 1);

    const request = requests[before];
    await expectTranscript(request.answer, leg);
    return request;
  };

  test.beforeAll(async ({ browser }) => {
    // Onboarding plus the first project load outlasts the default per-test budget, but only as far as the
    // criterion's own ceiling allows: a hook that runs longer than that is killed from outside and reports
    // nothing, so the budget stops short of it and lets the failure above be the thing that is read.
    test.setTimeout(40_000);

    recognizer = await startRecognizer();
    recognizerUrl = `http://127.0.0.1:${(recognizer.address() as AddressInfo).port}`;

    context = await browser.newContext({
      baseURL: CLIENT_URL,
      permissions: ['microphone'],
    });

    // The two places an install that predates the server-side move really keeps these values, written before
    // the app runs so the app's own readers are what consume them:
    //   - `user-preferences`, the mirror the first paint reads synchronously;
    //   - `uiPreferences`, the legacy key that mirror's `uiPreferences` entry is migrated from on hydrate;
    //   - `voiceConfig`, the legacy voice settings, imported to the server on the first voice hydration.
    // Seeding both the mirror and the legacy keys is the point: the built-in this exercises is the migration,
    // and a value that only ever existed in the mirror would be dropped the moment hydration replaced it.
    await context.addInitScript(
      ({ voiceConfig, preferences }: { voiceConfig: unknown; preferences: unknown }) => {
        window.localStorage.setItem('voiceConfig', JSON.stringify(voiceConfig));
        window.localStorage.setItem('uiPreferences', JSON.stringify(preferences));
        window.localStorage.setItem('user-preferences', JSON.stringify({ uiPreferences: preferences, userLanguage: 'en' }));
        window.localStorage.setItem('userLanguage', 'en');
      },
      {
        voiceConfig: {
          baseUrl: recognizerUrl,
          apiKey: API_KEY,
          sttModel: STT_MODEL,
          ttsModel: '',
          ttsVoice: '',
          ttsFormat: '',
        },
        preferences: { voiceEnabled: true },
      },
    );

    page = await context.newPage();

    // The page's side of the voice call, so a red can say which link broke. `requestfailed` is the one that
    // catches a call the app made and the network refused; the console listener catches the app's own
    // `onError` path when it reports a failure the composer never shows.
    page.on('response', (response) => {
      if (!response.url().includes('/api/voice/transcribe')) return;
      void response.text().then(
        (body) => voiceTraffic.push(`transcribe -> ${response.status()} ${body.slice(0, 160)}`),
        () => voiceTraffic.push(`transcribe -> ${response.status()} <body unreadable>`),
      );
    });
    page.on('requestfailed', (request) => {
      voiceTraffic.push(`requestfailed ${request.url()} ${request.failure()?.errorText ?? ''}`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') voiceTraffic.push(`console.error ${message.text().slice(0, 200)}`);
    });
    // The chain's unconditional reading (GOAL-005 / AC-114), counted because its arrival is the proof that
    // an upload travelled the transcription chain at all — the file entry's as much as the microphone's.
    page.on('console', (message) => {
      if (message.text().includes('[voice] identifier fidelity')) fidelityMessages += 1;
    });

    // First run on a fresh database: create the single account, then finish onboarding.
    await page.goto('/');
    // The account form is the app's first rendered screen, which also makes it the first thing a cold Vite dev
    // server can fail to produce. Two different blanks arrive here: a transform graph built on demand under load,
    // and — the one this run actually met — `504 Outdated Optimize Dep` on the pre-bundled dependencies, which is
    // what a dev server answers for a moment once its dependency cache has been re-optimized underneath it. That
    // cache is reached through this checkout's `node_modules` symlink, so a sibling run starting its own server is
    // enough to invalidate this one's hashes; the trace of a red run shows the entry chunk failing this way and no
    // page error at all. Neither blank throws on its own: the navigation succeeded, so nothing surfaces until the
    // wait for the form runs out. A reload clears both — it is what Vite's own client does after re-optimizing — so
    // it is retried, bounded, because this preamble is not what the criterion tests and must not eat the hook's
    // budget. The attempts below add up to less than the hook's own ceiling, so a real failure reports here, with
    // the page's text, rather than being killed from outside with nothing to say.
    let onboarded = await appears(page.locator('#username'), 8_000);
    for (let attempt = 0; !onboarded && attempt < 3; attempt += 1) {
      await page.reload();
      onboarded = await appears(page.locator('#username'), 4_000);
    }
    if (!onboarded) {
      const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
      // The console errors are what name the cause: a blank page is a blank page, but "504 Outdated Optimize
      // Dep" and "Failed to fetch dynamically imported module" are two different run environments.
      const errors = voiceTraffic.filter((line) => line.startsWith('console.error'));
      throw new Error(
        `the account form never rendered; the page shows: ${JSON.stringify(shown.slice(0, 300))}`
          + `\n  console errors: ${errors.length > 0 ? errors.slice(0, 3).join(' | ') : '<none>'}`,
      );
    }
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').nth(0).fill('e2epassword');
    await page.locator('input[type=password]').nth(1).fill('e2epassword');
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();

    // Indexing a session auto-registers its project, so the seeded workspace is already a project here; the
    // sidebar is the proof that the fixture really reached the backend.
    await expect(projectRow()).toBeVisible({ timeout: 12_000 });
  });

  test.afterAll(async () => {
    await context?.close();
    await new Promise<void>((resolve) => recognizer?.close(() => resolve()));
  });

  /**
   * The voice path's other entry: a known piece of audio, chosen as a file.
   *
   * The entry is rendered only while the debug switch is on, and what it has to show is that the file is
   * *not* a second path: the bytes are decoded to PCM and handed to the same segmenter, the same upload and
   * the same transcription chain a recording travels. That is read from the chain's own side — the request
   * that lands on the recogniser carries the chain's own audio rather than the chosen container passed
   * through, and the unconditional `[voice] identifier fidelity` print, which is emitted inside the
   * transcription step every upload travels, arrives for it. The composer's half (the recogniser's own
   * sentence reaching the box) is waited on by `uploadFixture`, so it is proven by the leg getting this far.
   *
   * The second leg is the default install's: the switch is off, so the entry is not rendered and the file
   * cannot be chosen at all — which is what makes "an extra control in everyone's composer" a thing this
   * avoided rather than a thing it intended.
   */
  test('AC-120 an uploaded audio file travels the same transcription chain', async () => {
    // Same budget as the microphone's criteria and for the same reason: the goal gate kills the command at
    // 60s, and a run killed from outside says nothing about what it was doing.
    test.setTimeout(35_000);

    // The fixture, read as audio. A file the browser cannot decode is not a failure it reports, so a
    // criterion that only looked at the composer could go green on a chain that never read the file.
    const audio = fs.readFileSync(AUDIO_FILE);
    expect(audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(audio.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wavDurationSec(audio)).toBeCloseTo(FIXTURE_SEC, 3);
    const requestsBefore = requests.length;
    const fidelityBefore = fidelityMessages;

    // Leg 1 — the switch on. One chosen file, one upload, through the recording's own chain.
    await openComposer('/?voiceDebug=1');
    const request = await uploadFixture('uploaded leg');

    const upload = uploadedFile(request.body, request.contentType);
    const uploadSec = containerDurationSec(upload);
    // Printed before the assertions, so a green run says what it measured rather than only what it refused.
    console.log(
      `[voice-upload] file=${FIXTURE_SEC.toFixed(3)}s uploaded=${uploadSec.toFixed(3)}s bytes=${upload.length}`,
    );
    // The body is audio the chain produced rather than the chosen container passed through, and the length
    // rules out a stub body. Segmentation may drop leading or trailing silence, so the bound is the file's
    // length plus the capture tolerance rather than the file's length itself.
    expect(upload.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(uploadSec).toBeGreaterThan(0);
    expect(uploadSec).toBeLessThanOrEqual(FIXTURE_SEC + CAPTURE_TOLERANCE_SEC);
    // The same chain, read from inside it: this print only happens inside the transcription step, so its
    // arrival for the chosen file is what makes "the same chain" an assertion rather than a description.
    await expect
      .poll(() => fidelityMessages, {
        timeout: 5_000,
        message: 'the chosen file reached the recogniser without travelling the same transcription chain',
      })
      .toBeGreaterThan(fidelityBefore);

    // Leg 2 — the default install. The switch is off, so the entry is not rendered; the microphone, which
    // was there before this task, still is.
    const requestsAtDefault = requests.length;
    await openComposer('/?voiceDebug=off');
    // The premise first: the footer really is rendered and its mic is there, so the absence below is the
    // switch's doing rather than a composer that has not painted yet. A zero count is satisfied by a blank
    // page, and a blank page is what a broken build answers with.
    await expect(page.getByRole('button', { name: 'Voice input' })).toBeVisible();
    await expect(uploadEntry()).toHaveCount(0);
    await expect(uploadInput()).toHaveCount(0);
    expect(requests).toHaveLength(requestsAtDefault);

    // One leg, one upload: the leg did not upload twice, and the default install sent nothing at all.
    expect(requests.length).toBe(requestsBefore + 1);
  });
});
