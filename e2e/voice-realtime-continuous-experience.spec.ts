/**
 * The continuous-experience baseline: what the CURRENT `VOICE_REALTIME_MODE=continuous` path actually
 * does, read off a real browser, a real app server, and a scripted Realtime endpoint that hears.
 *
 * WHY THIS SPEC EXISTS. Decision doc `docs/proposals/live-voice-experience-first-decision-2026-10.md`
 * §3 names the minimum experience X-1..X-7 and §4 picks continuous (upstream `server_vad`) as the
 * candidate baseline — but picking a candidate is not the same as reading it. The default may only
 * move once the current continuous path's readings are on the table, and those readings have to come
 * from the product running its own code: the browser's real capture path, the real proxy, the real
 * bridge, the real journal. This spec measures; it changes nothing. `git diff --stat develop --
 * server/modules/voice-realtime src` shows only test files, and that is a property of the task, not a
 * promise about this file.
 *
 * WHAT MAKES IT A READING AND NOT A REHEARSAL.
 *  · The endpoint HEARS. `armVad(...)` gives the scripted upstream an acoustic detector built from the
 *    SAME module the in-process criterion uses, so an utterance ends because its audio stopped, not
 *    because the scenario said so. One `input_audio_buffer.append` can carry a whole speech+silence
 *    burst, and the detector walks it in 20 ms windows — see `createScriptedVad`. Its `speech_stopped`
 *    announcements land on the audio timeline (measured: 1.52 / 3.42 / 5.42 / 8.12 / 11.32 s into the
 *    play against a 1.2 / 1.0 / 0.8+1.2 / 1.0 s spoken timeline), which is what makes the utterances
 *    below the endpoint's own closures rather than the spec's.
 *  · The microphone is a TIMELINE. `voiceRealtimeFakeMic.ts` plays 12.1 s of shaped PCM through the
 *    app's own `microphoneAudioSource` (a fake `AudioContext`/`AudioWorkletNode`/`getUserMedia`), one
 *    100 ms frame at a time, so the app receives audio while it is streaming.
 *  · The execution plane ALTERNATES, and the reading spans the alternation. The armed walk is started
 *    only AFTER the plane has been read free; the turn that walk itself opens is then read RELEASED
 *    before a word is spoken (see `TURN_END_AT_MS` and the pre-play gate in the body); the sampling
 *    continues long after the deliveries, so the dock is read idle BEFORE the walk, busy while the
 *    sentences are being delivered, and idle once the last turn's run has finished. X-1's condition
 *    ("执行面忙闲交替") is a property of the READING rather than of the scheduler's luck.
 *
 *    WHERE THE TIMELINE IS ALLOWED TO BEGIN IS PART OF THE READING AND NOT A WORKAROUND. Whether a
 *    delivered message becomes a visible row is decided by the EXECUTION PLANE at the moment of
 *    delivery: the debug agent's host driver hands a delivery to its turn runner when no turn holds
 *    the session, and to its busy-input path otherwise — and that path (`acceptPushedCommand`) records
 *    a queued command life-cycle frame and paints no row at all. A forwarding that lands inside a
 *    window somebody else opened is therefore a forwarding with no row, which is exactly what X-1 must
 *    not read. Leaving that to a ~200 ms race between the first delivery and the walk's `turn-end` is
 *    what this spec used to do, and it is why the same seed read green twice and then red five times
 *    in a row. So the gate waits — on the product's own lease, not on a sleep — and the timeline starts
 *    on a plane no turn is holding.
 *  · Nothing leaves the machine. The browser aborts every non-loopback request, the app server runs
 *    under the AC-360 egress guard preloaded by `playwright.config.ts`, and the scripted upstream
 *    records the dial and the handshake headers.
 *
 * WHERE THE READINGS COME FROM. Three streams, each recorded verbatim beside the others so a claim
 * can always be traced to the frame it was read off:
 *  · the JOURNAL — one file per browser connection, and `readJournal` selects it by its own
 *    `connection` header (only that entry carries the session id; everything after it is keyed by
 *    `connectionId`). The proxy's `log` entries are the routing timeline: `<< speech_stopped`,
 *    `<< transcription.completed`, `<< function_call session_send`, `queued:` / `coalesced` /
 *    `to-browser sent`, `status injected`, `<< function_call session_interrupt`.
 *  · the ACTIVITY stream — every `chat_subscribed` / `activity.heartbeat` frame the page received,
 *    stamped: the dock is a reduction of these, so a dock reading is only explainable against them.
 *  · the DOCK — `data-activity-state` / `-phase` / `-elapsed-ms`, polled across the whole window.
 *
 * WHY IT IS THE SOLE SELECTION IT RUNS UNDER. `VOICE_REALTIME_MODE` is a property of the SERVER
 * process, and one process serves the whole run — so `playwright.config.ts` arms `continuous` only
 * when this file is the entire selection, and publishes `QUAY_E2E_VOICE_REALTIME_MODE` so a run that
 * somehow lost that arming fails loudly here instead of quietly measuring segmented mode.
 *
 * NOTHING IS DECLARED A KNOWN FAILURE AND NOTHING IS SKIPPED — this file carries no known-failure
 * marker, no skip annotation and no soft assertion of any kind, and it no longer wraps any leg in the
 * known-defect helper the sibling specs use for a leg that is red pending a product fix. That helper
 * is deliberately NOT named here, not even to say it is gone: a file whose whole claim is that the
 * marker is absent has to stay clean under the grep that checks for it, and a paragraph explaining
 * the absence is a place the literal comes back. The last wrapped leg — the merged-delivery leg of
 * X-1 — is a DIRECT assertion as of `gap-voice-delivered-merged-message-invisible-in-transcript`: the
 * delivery that message belongs to now has a carrier row, and the leg demands it. The 2026-10-13
 * ruling had narrowed the other three to direct assertions first (see X-1 / X-2 / X-6).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  CONTINUOUS_EXPERIENCE_TIMELINE,
  fakeMicFrames,
  fakeMicPushed,
  installFakeMic,
  playFakeMic,
} from './voiceRealtimeFakeMic';
import {
  startScriptedUpstream,
  type ScriptedUpstreamServer,
  type ScriptedVadRecord,
} from './voiceRealtimeScriptedUpstream';
import {
  awaitClientMounted,
  warmClientStartup,
  type ClientWarmupReading,
  type RequestFailure,
} from './support/client-startup-warmup';

// ── the page's own vocabulary, copied from the sibling voice specs ────────────────────────────────
const PANE = '.chat-messages-pane';
const BAR = '[data-testid="voice-realtime-bar"]';
const DOCK = '[data-activity-dock]';
const STATUS = '[data-testid="voice-realtime-status"]';
const PHASE = '[data-testid="voice-realtime-phase"]';
const CAPTION = '[data-testid="voice-realtime-caption"]';

/**
 * The prefixes under which the voice layer used to paint a line of its OWN into the conversation — the
 * refusal (拒收), the unrecognized segment (未识别), the lost segment (段丢失), and the provisional
 * heard/delivering rows before them.
 *
 * The 2026-10-13 ruling lets a `policy: 'silent'` utterance have no row at all; asserting it is not
 * painted on THESE is what keeps "no row" from quietly meaning "mislabelled as some other disposition".
 *
 * REWRITTEN with gap-voice-ui-strip-to-caption-and-connection-state (2026-10-14). This used to be a
 * SET of the three state rows' testids. The strip removed every one of those nodes, so a set of their
 * names would have become three strings nothing could ever match — the assertion would still have read
 * green, but as "not painted on names that no longer exist" rather than as a fact about the page. A
 * PREFIX keeps it a reading: any line of the voice layer's own coming back, under any name, fails it.
 */
const VOICE_ROW_PREFIXES = ['voice-row-', 'voice-closed-'] as const;
const isVoiceOnlyRow = (testid: string | null): boolean =>
  testid !== null && VOICE_ROW_PREFIXES.some((prefix) => testid.startsWith(prefix));

const USERNAME = 'voice-continuous-e2e';
const PASSWORD = 'voice-continuous-e2e-pass';

/** The seeded row the armed scenario's transcript starts from. */
const SEED_USER_TEXT = 'seeded turn for continuous experience';
/** The resident turn the walk opens — the fixture's mark of an occupied execution plane. */
const BUSY_TURN_TEXT = '常驻会话里正在跑的一轮（先占住执行面）';

/**
 * When the walk's resident turn ends, in ms from that walk's own start.
 *
 * The runtime re-runs the armed walk for EVERY turn the session is given, so this offset is also how
 * long the plane stays busy after each delivered message — and it is the width of the window a
 * delivery would find if it arrived while the previous one still held the session. It is sized
 * between two hard bounds, and both are properties of the product rather than of this fixture:
 *
 *  · LOWER BOUND — the pre-play gate's own poll cadence. That gate reads the host's `turn` lease off
 *    `GET /api/session-hosts/:sessionId` every `DOCK_POLL_MS`, and it can only read the turn RELEASED
 *    if it also saw it held, so the window has to outlast one poll with room to spare. 3 s is a dozen
 *    polls of margin, and the walk takes the lease on its step 0 — before it paints the row the gate
 *    waits for — so the held reading cannot be missed by starting late.
 *  · UPPER BOUND — the spacing between two forwarded deliveries, which the fake mic's timeline fixes
 *    at ≈ 6.6 s (U1's stop to U4's, measured 1.52 s / 8.12 s into the play against this file's
 *    timeline; the proxy's own coalescing window is the same ~1.0 s for both, so it cancels out of
 *    the difference). A window that outlived the next delivery would swallow THAT delivery — the same
 *    defect one sentence later. 3 s leaves ≈ 3.6 s of slack for the round trip and the scheduler,
 *    ~20× the ~183 ms the two moments used to be apart.
 */
const TURN_END_AT_MS = 3_000;

/**
 * How far past the test the walk is parked. The walk's own `expect.rows.delta` is checked when the
 * walk ENDS, and this run's deliveries write rows into that same transcript — a count stated now
 * would be a count the deliveries invalidate. Parking the walk beyond the test's lifetime is the same
 * device `voice-realtime-scripted-scenarios.spec.ts` uses (`HELD_OFFSET_MS`): the turn is released
 * when it is released, and the self-check that was never reached is never wrong. The `expect` block
 * below is therefore structural (the scenario schema requires one), not a claim about this run.
 */
const WALK_PARKED_AT_MS = 120_000;

/** How often the plane is sampled while it is being read: the dock's state, and the host's turn lease. */
const DOCK_POLL_MS = 250;

/**
 * How long the walk's own turn is given to be read RELEASED before the timeline starts.
 *
 * A release is one step on the walk's own clock (`TURN_END_AT_MS`) plus one poll of the listing, so
 * this is generous on purpose: an environment where the turn never releases must fail the pre-play
 * gate by name, not hand a busy plane to the first delivery and turn the row legs red.
 */
const TURN_RELEASE_TIMEOUT_MS = 20_000;

/** How long the spec waits for a delivery to reach the transcript before giving up on it. */
const DELIVERY_TIMEOUT_MS = 30_000;

/**
 * How long the interface is watched, after the deliveries have been recorded, for the provisional
 * caption row to resolve. A row that never resolves is a READING (X-1's visible-disposition leg), not
 * a reason to hang, so this is bounded and short.
 */
const FOLD_OBSERVE_MS = 8_000;

/** How long the dock keeps being sampled after the timeline has finished, waiting for the idle half. */
const POST_PLAY_OBSERVE_MS = 30_000;

// ── the five utterances, as the endpoint's detector will close them ───────────────────────────────
// The text is BOTH the transcript the endpoint completes and the message a `forward` sends, so the
// timeline's own labels and these sentences are two readings of one script.
const U1 = '把 server 的日志贴出来';
/** The 「嗯」 fragment: heard, and carrying no request at all (X-2). */
const U2 = '嗯…那个…';
/** The first half of a thought whose second half comes after a 1.5 s pause (X-4). */
const U3 = '我想想';
const U4 = '然后跑一下测试';
/** The correction (X-5). */
const U5 = '不对，改成跑 lint';

/** Everything X-4 predicts: one message, the deferred half first, because that is the spoken order. */
const MERGED_MESSAGE = `${U3}${U4}`;

const VAD_TURNS = [
  { text: U1, policy: 'forward' as const },
  { text: U2, policy: 'silent' as const },
  { text: U3, policy: 'wait' as const },
  { text: U4, policy: 'forward' as const },
  { text: U5, policy: 'interrupt' as const, intent: '方向改成跑 lint' },
];

/** The five dispositions X-1 predicts, in spoken order. */
const EXPECTED_DISPOSITIONS = ['forwarded', 'unforwarded', 'forwarded', 'forwarded', 'interrupted'];

const deck = (title: string) => ({
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'unattended-turn', text: BUSY_TURN_TEXT, trigger: 'cron' },
    { at: TURN_END_AT_MS, op: 'turn-end' },
    { at: WALK_PARKED_AT_MS, op: 'wait' },
  ],
  // Structural only: the walk is parked past this test's lifetime, so this block is never reached.
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
});

// ── fixture helpers, copied from the sibling specs (there is no shared module for these) ──────────
async function createAccount(api: APIRequestContext): Promise<string> {
  const register = await api.post('/api/auth/register', { data: { username: USERNAME, password: PASSWORD } });
  const registered = await register.json().catch(() => null);
  if (typeof registered?.token === 'string') {
    await api.post('/api/user/complete-onboarding', { headers: { Authorization: `Bearer ${registered.token}` } });
    return registered.token;
  }
  const login = await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
  const loggedIn = await login.json().catch(() => null);
  if (typeof loggedIn?.token !== 'string') {
    throw new Error(`could not create or sign in as ${USERNAME}: ${register.status()} ${JSON.stringify(registered)}`);
  }
  return loggedIn.token;
}

async function armScenario(api: APIRequestContext, projectPath: string, doc: unknown): Promise<string> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario: doc } });
  const body = await response.json().catch(() => null);
  const sessionId = body?.data?.sessionId;
  if (!response.ok() || typeof sessionId !== 'string') {
    throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  }
  return sessionId;
}

async function startResidentProcess(api: APIRequestContext, sessionId: string): Promise<void> {
  const response = await api.post(`/api/session-hosts/${encodeURIComponent(sessionId)}/start`, { data: {} });
  if (!response.ok()) throw new Error(`start failed (${response.status()}): ${await response.text()}`);
}

// ── the journal: one file per browser connection, selected by its own header ──────────────────────
type JournalEntry = Record<string, unknown>;
type LogLine = { atMs: number; line: string };

const entryAt = (entry: JournalEntry): number => Date.parse(String(entry.at));

/**
 * Every journal line belonging to `sessionId`'s connection, verbatim.
 *
 * THE FILE IS SELECTED BY ITS HEADER, NOT THE LINES BY THEIR TEXT. `voice-realtime-log.ts` writes one
 * file per BROWSER CONNECTION and puts the session on exactly one entry — the `connection` header,
 * written first. Every later entry is keyed by `connectionId` alone, so a reader that asked "which
 * lines mention this session?" would keep the header and drop every `session_send` and every
 * `interrupt` — two of the readings this spec exists to take — and would then report, in perfect
 * silence, that the model never delivered and never stopped anything.
 */
export function readJournal(dir: string, sessionId: string): string[] {
  if (!existsSync(dir)) return [];
  const lines: string[] = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.jsonl'))) {
    const rows = readFileSync(path.join(dir, name), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    if (rows.length === 0) continue;
    let header: { kind?: unknown; sessionId?: unknown };
    try {
      header = JSON.parse(rows[0]!) as { kind?: unknown; sessionId?: unknown };
    } catch {
      // A file whose first line is not JSON is not a connection journal this build wrote.
      continue;
    }
    if (header.kind === 'connection' && header.sessionId === sessionId) lines.push(...rows);
  }
  return lines;
}

/** The proxy's own routing timeline: the `log` entries, in file order (which is chronological). */
const logLines = (entries: JournalEntry[]): LogLine[] =>
  entries
    .filter((entry) => entry.kind === 'log' && typeof entry.line === 'string')
    .map((entry) => ({ atMs: entryAt(entry), line: String(entry.line) }));

const FUNCTION_CALL = '<< function_call ';

/** The `message` a `function_call session_send` line carried, or null when the line is not one. */
const sendMessageOf = (line: string): string | null => {
  const marker = `${FUNCTION_CALL}session_send `;
  if (!line.startsWith(marker)) return null;
  try {
    const parsed = JSON.parse(line.slice(marker.length)) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : null;
  } catch {
    return null;
  }
};

/** The `intent` a `function_call session_interrupt` line carried, or null when the line is not one. */
const interruptIntentOf = (line: string): string | null => {
  const marker = `${FUNCTION_CALL}session_interrupt `;
  if (!line.startsWith(marker)) return null;
  try {
    const parsed = JSON.parse(line.slice(marker.length)) as { intent?: unknown };
    return typeof parsed.intent === 'string' ? parsed.intent : null;
  } catch {
    return null;
  }
};

/** `transcription.completed "…"` → the words, or null. */
const transcriptTextOf = (line: string): string | null => {
  const marker = '<< transcription.completed ';
  if (!line.startsWith(marker)) return null;
  const raw = line.slice(marker.length).trim();
  return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
};

/** `to-browser caption "…"` → the words, or null. */
const captionTextOf = (line: string): string | null => {
  const marker = 'to-browser caption ';
  if (!line.startsWith(marker)) return null;
  const raw = line.slice(marker.length).trim();
  return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
};

/** The `id=` a `<< response.created` / `<< conversation.item.created` line carried, or null. */
const idOf = (line: string, prefix: string, key: string): string | null => {
  if (!line.startsWith(prefix)) return null;
  const match = new RegExp(`${key}=(\\S+)`).exec(line);
  return match?.[1] ?? null;
};

/** The last entry of `lines` at or before `atMs` whose text matches, or null. */
const lastBefore = (lines: LogLine[], atMs: number, match: (line: string) => boolean): LogLine | null => {
  let found: LogLine | null = null;
  for (const line of lines) {
    if (line.atMs > atMs) break;
    if (match(line.line)) found = line;
  }
  return found;
};

/** The first entry of `lines` at or after `atMs` whose text matches, or null. */
const firstAfter = (lines: LogLine[], atMs: number, match: (line: string) => boolean): LogLine | null =>
  lines.find((line) => line.atMs >= atMs && match(line.line)) ?? null;

// ── the page readers ─────────────────────────────────────────────────────────────────────────────
type Row = {
  style: string | null;
  testid: string | null;
  text: string;
  /**
   * Every voice-related `data-testid` inside the row — the marks that used to tell a delivered spoken
   * row apart from an ordinary typed one (the `Heard as: …` badge this spec read before, and the
   * voice layer's own row testids).
   *
   * REWRITTEN with gap-voice-ui-strip-to-caption-and-connection-state (2026-10-14): the strip's ruling
   * is that what was sent is an ordinary CloudCLI user message, so a delivered spoken row carries NO
   * mark any more. This list is what the legs read its absence off — scanned, not named, so a mark
   * reintroduced under another name is caught too. Testids only: a `title` can legitimately carry a
   * message's own words, and reading those would be a reading of the copy rather than of the marker.
   */
  marks: string[];
};

type Snap = { rows: Row[]; bodyText: string };

const snap = (page: Page): Promise<Snap> =>
  page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane');
    const rows = [...(pane?.querySelectorAll('[data-message-style]') ?? [])].map((el) => ({
      style: el.getAttribute('data-message-style'),
      testid: el.getAttribute('data-testid'),
      text: ((el.querySelector('div[dir="auto"]')?.textContent ?? el.textContent) || '').trim(),
      marks: [...el.querySelectorAll('[data-testid]')]
        .map((node) => node.getAttribute('data-testid') ?? '')
        .filter((id) => /voice|heard|transcript|badge/i.test(id)),
    }));
    return { rows, bodyText: document.body.innerText.slice(0, 8_000) };
  });

/** The user rows that are DELIVERED turns — a row the voice layer has not flagged with its own testid. */
const deliveredRows = (reading: Snap): Row[] => reading.rows.filter((row) => row.style === 'user' && row.testid === null);

const normalize = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const carries = (rows: Row[], text: string): Row[] => rows.filter((row) => normalize(row.text).includes(normalize(text)));

const phase = async (page: Page): Promise<string> =>
  ((await page.getByTestId('voice-realtime-phase').textContent()) ?? '').trim();

/** The status cell's own reading, taken as attributes rather than parsed out of copy. */
type StatusCell = {
  /** `data-busy` is present only while the relay is holding something, so absence IS the free reading. */
  busy: string | null;
  queuedDepth: string | null;
  queuedBytes: string | null;
  /**
   * `data-capture`: `starting` until the first captured frame, `live` from then on. The stable
   * reading for a transient phase, which carries no words by design.
   */
  capture: string | null;
  /** The raw phase (`voice-realtime-phase`), so a wordless sample can be explained. */
  phase: string | null;
  text: string;
};

/**
 * The dock's whole published reading, not just its state.
 *
 * `state` is the claim, and `null` is the IDLE one: `ActivityIndicator` returns `null` for every state
 * but `in-turn`, so the dock's ABSENCE is the plane being free rather than a missing sample. `phase`
 * and `elapsedMs` are read beside it because they are the SERVER's own account of what the turn is
 * doing and for how long — so a dock that reports `in-turn` for the whole play can be told apart from
 * a dock that is merely stuck, without guessing which of the two it is.
 */
const probeReading = (
  page: Page,
): Promise<{ dock: { state: string | null; phase: string | null; elapsedMs: string | null }; status: StatusCell | null }> =>
  page.evaluate(
    ({ dockSelector, statusSelector, phaseSelector }: { dockSelector: string; statusSelector: string; phaseSelector: string }) => {
      const dock = document.querySelector(dockSelector);
      const status = document.querySelector(statusSelector);
      const phaseElement = document.querySelector(phaseSelector);
      return {
        dock: {
          state: dock?.getAttribute('data-activity-state') ?? null,
          phase: dock?.getAttribute('data-activity-phase') ?? null,
          elapsedMs: dock?.getAttribute('data-activity-elapsed-ms') ?? null,
        },
        status:
          status === null
            ? null
            : {
                busy: status.getAttribute('data-busy'),
                queuedDepth: status.getAttribute('data-queued-depth'),
                queuedBytes: status.getAttribute('data-queued-bytes'),
                capture: status.getAttribute('data-capture'),
                phase: (phaseElement?.textContent ?? '').trim() || null,
                text: (status.textContent ?? '').trim(),
              },
      };
    },
    { dockSelector: DOCK, statusSelector: STATUS, phaseSelector: PHASE },
  );

/** One probe: the dock and the status cell as they stood together, on the wall clock they were taken. */
type ProbeSample = {
  atMs: number;
  dock: { state: string | null; phase: string | null; elapsedMs: string | null };
  status: StatusCell | null;
};

/**
 * Whether the session's host is holding a TURN, read off the listing the product's own UI polls.
 *
 * `GET /api/session-hosts/:sessionId` publishes every binding's held leases, and the debug agent's
 * host driver holds a `{ kind: 'turn' }` lease for the duration of one turn — the same fact behind
 * `turnByAppSession.has(appSessionId)`, which is the predicate that decides whether a delivery becomes
 * a turn (and a visible row) or a pushed command (and none). `null` is returned when the read itself
 * failed, so a caller can tell "read free" apart from "could not read" instead of taking an error for
 * the answer it was hoping for.
 */
async function readTurnLeaseHeld(api: APIRequestContext, sessionId: string): Promise<boolean | null> {
  const response = await api.get(`/api/session-hosts/${encodeURIComponent(sessionId)}`).catch(() => null);
  if (!response || !response.ok()) return null;
  const body = (await response.json().catch(() => null)) as
    | { data?: { hosts?: Array<{ bindings?: Array<{ appSessionId?: string; leases?: Array<{ kind?: string }> }> }> } }
    | null;
  const hosts = body?.data?.hosts;
  if (!Array.isArray(hosts)) return null;
  const bindings = hosts.flatMap((host) => (Array.isArray(host.bindings) ? host.bindings : []));
  const binding = bindings.find((entry) => entry.appSessionId === sessionId);
  // A session with no live host is a session no turn can be held on — the driver's own map is empty in
  // exactly that case, so this is the free reading rather than an unreadable one.
  if (!binding) return false;
  return (binding.leases ?? []).some((lease) => lease.kind === 'turn');
}

/**
 * The fixture's own turn, as the host listing reported it around the timeline's start.
 *
 * The series is sampled from BEFORE the walk is started, so the turn the walk opens is caught being
 * held rather than hoped to still be there when it is looked for — and every read is kept, because
 * "the plane was free when the timeline started" is only a reading if the plane was also seen occupied
 * by the fixture beforehand.
 */
type TurnLeaseReading = {
  series: Array<{ atMs: number; held: boolean | null }>;
  /** Epoch ms the walk's turn was first read held, or null if it never was. */
  heldAtMs: number | null;
  /** Epoch ms it was first read RELEASED after having been held, or null if it never released. */
  releasedAtMs: number | null;
  /** Whether the turn was still held at the instant the timeline started. */
  heldAtPlayStart: boolean | null;
};

/** An activity frame the page received, reduced to the fields the dock is built from. */
type ActivityFrame = {
  atMs: number;
  kind: string;
  sessionId: string | null;
  isProcessing: boolean | null;
  phase: string | null;
  timestamp: string | null;
  unreachableAfterMs: number | null;
};

/** The scripted detector's own readings, flattened into a plain object a recording can hold. */
type DetectorReading = {
  turnDetection: string | null;
  speechStarted: number;
  speechStopped: number;
  opportunities: number;
  items: string[];
  forwarded: string[];
  records: ScriptedVadRecord[];
};

const readDetector = (upstream: ScriptedUpstreamServer): DetectorReading => {
  const vad = upstream.vad();
  if (vad === null) throw new Error('the scripted upstream has no armed detector to read');
  return {
    turnDetection: vad.turnDetection,
    speechStarted: vad.speechStarted,
    speechStopped: vad.speechStopped,
    opportunities: vad.opportunities,
    items: [...vad.items],
    forwarded: [...vad.forwarded],
    // Deep-copied: `records` is live, and a later utterance must not rewrite a table already read.
    records: vad.records.map((record) => ({ ...record })),
  };
};

/**
 * The routing timeline, lifted out of the journal's `log` entries into the shapes the X-legs read.
 *
 * TIMESTAMPS ARE THE POINT. X-7 is a table of intervals and X-3 is a claim about ORDER, so the
 * readings are stamped where they were recorded rather than re-derived at assertion time — the same
 * clock the journal's own `at` fields are on, which is what lets a delivery be lined up against the
 * `speech_stopped` that caused it.
 */
type Routing = {
  speechStops: number[];
  transcripts: Array<{ atMs: number; text: string }>;
  captions: Array<{ atMs: number; text: string }>;
  /** The model's `session_send` calls, with the message each carried. */
  toolCalls: Array<{ atMs: number; message: string }>;
  /** The model's `session_interrupt` calls, with the intent each carried. */
  stops: Array<{ atMs: number; intent: string | null }>;
  /** `to-browser queued` — the instant the interface was told something is waiting. */
  queued: number[];
  /** `to-browser sent` — the instant a message left the queue for the session. */
  sent: number[];
  /** `coalesced N relayed piece(s) into one message` — the debounce firing. */
  coalesced: number[];
  /** `<< response.created` — the response each model turn was opened under. */
  responses: Array<{ atMs: number; id: string }>;
  /** `<< conversation.item.created` — the endpoint's own item for each utterance. */
  items: Array<{ atMs: number; id: string }>;
  /** `session_send` entries: what the session was actually handed, and what it cost. */
  sends: Array<{ atMs: number; message: string; latencyMs: number | null; outcome: string }>;
  /** `session_interrupt` entries: the audit record each stop left. */
  audits: Array<{ atMs: number; by: string | null; intent: string | null; outcome: string | null }>;
  /** `status injected …` — the status line's own injections. */
  statusInjections: Array<{ atMs: number; line: string }>;
  /**
   * `to-browser stopped depth=N` — the stop notice the page was HANDED, in the proxy's own words.
   *
   * The page's DOM reading of a stop moved here with the strip
   * (`gap-voice-ui-strip-to-caption-and-connection-state`, 2026-10-14): the bar draws no stop notice
   * any more, so the fact "the interface was told about the stop" is read one step earlier, on the
   * outbound frame — which cannot be satisfied by a bar that was told nothing.
   */
  stoppedToBrowser: number[];
};

const readRouting = (entries: JournalEntry[]): Routing => {
  const logs = logLines(entries);
  const routing: Routing = {
    speechStops: [],
    transcripts: [],
    captions: [],
    toolCalls: [],
    stops: [],
    queued: [],
    sent: [],
    coalesced: [],
    responses: [],
    items: [],
    sends: [],
    audits: [],
    statusInjections: [],
    stoppedToBrowser: [],
  };
  for (const { atMs, line } of logs) {
    if (line.startsWith('<< input_audio_buffer.speech_stopped')) routing.speechStops.push(atMs);
    const transcript = transcriptTextOf(line);
    if (transcript !== null) routing.transcripts.push({ atMs, text: transcript });
    const caption = captionTextOf(line);
    if (caption !== null) routing.captions.push({ atMs, text: caption });
    const message = sendMessageOf(line);
    if (message !== null) routing.toolCalls.push({ atMs, message });
    if (line.startsWith(`${FUNCTION_CALL}session_interrupt`)) {
      routing.stops.push({ atMs, intent: interruptIntentOf(line) });
    }
    if (line.startsWith('to-browser queued')) routing.queued.push(atMs);
    if (line === 'to-browser sent') routing.sent.push(atMs);
    if (line.startsWith('coalesced ')) routing.coalesced.push(atMs);
    const responseId = idOf(line, '<< response.created', 'response.id');
    if (responseId !== null) routing.responses.push({ atMs, id: responseId });
    const itemId = idOf(line, '<< conversation.item.created', 'item.id');
    if (itemId !== null) routing.items.push({ atMs, id: itemId });
    if (line.startsWith('status injected')) routing.statusInjections.push({ atMs, line });
    if (line.startsWith('to-browser stopped')) routing.stoppedToBrowser.push(atMs);
  }
  for (const entry of entries) {
    if (entry.kind === 'session_send') {
      routing.sends.push({
        atMs: entryAt(entry),
        message: String(entry.message ?? ''),
        latencyMs: typeof entry.latencyMs === 'number' ? entry.latencyMs : null,
        outcome: String(entry.outcome ?? ''),
      });
    }
    if (entry.kind === 'interrupt') {
      routing.audits.push({
        atMs: entryAt(entry),
        by: typeof entry.by === 'string' ? entry.by : null,
        intent: typeof entry.intent === 'string' ? entry.intent : null,
        outcome: typeof entry.outcome === 'string' ? entry.outcome : null,
      });
    }
  }
  return routing;
};

// ── the whole run, recorded once and asserted leg by leg ─────────────────────────────────────────
type ContinuousRun = {
  sessionId: string;
  /** Every segment the PAGE actually pushed — a timeline that played nothing proves nothing. */
  pushed: Array<{ kind: string; seconds: number; label: string }>;
  micFrames: number;
  /** The detector's readings, after the last utterance closed. */
  detector: DetectorReading;
  /** Frame TYPES the app sent upstream, in order. */
  upstreamFrameTypes: string[];
  /** How many `input_audio_buffer.commit` frames the app sent — under `server_vad` it must be none. */
  commits: number;
  /** Whether the proxy ever declared the segmented relay to the page. */
  declaredSegmented: boolean;
  /**
   * The dock and status cell read together, across the whole observation window, in order and stamped.
   *
   * The window opens BEFORE the walk is started and closes only once the plane has been read busy and
   * then free again, so the series carries the alternation X-1's condition asks for rather than
   * whichever state the plane happened to be in.
   */
  probes: ProbeSample[];
  /** The reading taken before the walk was started — the free half of the alternation. */
  probeBeforeWalk: ProbeSample;
  /**
   * The turn the fixture's own walk held, and its release, read off the session-hosts listing.
   *
   * This is the plane every forwarded delivery lands on, and the reading X-1's row leg rests on: a
   * delivery that found a turn held here would have been pushed into the busy-input path and left no
   * row. It is recorded rather than assumed for that reason.
   */
  turnLease: TurnLeaseReading;
  /** Epoch ms when the first frame of the timeline was pushed, and when the last one was. */
  playBeganAtMs: number;
  playEndedAtMs: number;
  /** When the armed walk was started, and when its resident row reached the pane. */
  walkStartedAtMs: number;
  /**
   * Every activity frame the PAGE received, stamped with the wall clock.
   *
   * The dock's state is a REDUCTION of these frames (`useActivityFreshness` + `deriveActivityDockView`),
   * so a dock that never leaves `in-turn` can only be explained by what arrived here: a beat that keeps
   * reporting `isProcessing`, a hello that pinned a turn nothing later cleared, or no frames at all.
   * Reading the dock alone cannot tell those three apart, which is why this is recorded beside it.
   */
  activityFrames: ActivityFrame[];
  /** Frame TYPES the app RECEIVED from the scripted endpoint, with the time each arrived. */
  voiceFrames: Array<{ atMs: number; type: string }>;
  /** The page's transcript once the observation had run its course. */
  transcript: Snap;
  /** The bar's status cell as it stood on the last probe — the final reading of X-6's state line. */
  status: StatusCell | null;
  /** The bar's live caption once the observation had run its course. */
  caption: string;
  /** The phase the bar reported once the observation had run its course. */
  phase: string;
  /** Every journal line recording this session, verbatim. */
  journal: string[];
  /** The journal's parsed entries for this session. */
  journalEntries: JournalEntry[];
  /** The routing timeline lifted out of the journal — the stamps every timing leg reads. */
  routing: Routing;
  /** What the dock is bound to: the session it reports on. */
  dockSessionId: string | null;
  /**
   * Whether the interface stopped claiming a delivery was in flight, and how long that took.
   *
   * A JOURNAL ENTRY IS A SERVER-SIDE FACT; the interface's own surface settles later, when the browser
   * is told. A reading taken the moment the wire settles would therefore miss a real row that has not
   * been painted yet, or read a sentence off the bottom bar's slot that the transcript has not caught
   * up with — the words arriving is not the same event as the interface settling — so this records the
   * second half of the wait separately from the first, and a UI that never settles is a reading here
   * rather than a mystery elsewhere.
   */
  fold: { resolved: boolean; waitedMs: number; lastInFlight: string[] };
  /** Uncaught page exceptions — the interface's own failures, as opposed to a refused request. */
  pageErrors: string[];
  /** Zero-egress readings. */
  egress: {
    logExists: boolean;
    /** Whether the AC-360 preload guard had to refuse a non-loopback dial (it must never have). */
    blocked: boolean;
    dials: number;
    authorizationSeen: boolean;
    /** The URLs THIS spec's own browser route refused before they left the machine. */
    refused: string[];
  };
  /** Console warnings/errors the page produced, verbatim and unfiltered. */
  warnings: string[];
};

test.describe('live voice continuous experience (X-1..X-7)', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  let run: ContinuousRun;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');

    // The mode this server was started in. A run that lost the arming would otherwise measure the
    // segmented path and report it as the continuous baseline — the one failure this spec must not
    // be able to make quietly.
    const mode = (process.env.QUAY_E2E_VOICE_REALTIME_MODE ?? '').trim();
    if (mode !== 'continuous') {
      throw new Error(
        'this spec measures the continuous path, so it must be the ONLY selection: run ' +
          '`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts`. ' +
          `QUAY_E2E_VOICE_REALTIME_MODE was "${mode || '(unset)'}".`,
      );
    }

    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    const upstreamPort = Number(process.env.QUAY_E2E_VOICE_REALTIME_PORT);
    if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_VOICE_REALTIME_PORT for this selection');
    }

    const dataDir = path.dirname(fixtureHome);
    const journalDir = path.join(dataDir, 'voice-realtime-log');
    const egressLog = path.join(dataDir, 'egress.jsonl');

    // The endpoint hears on the AUDIO-time base: its silence is counted in the samples the app
    // appends, so the reading cannot move with the CI scheduler. The wall-clock base is the open
    // question V-1 answers on the real endpoint, and it is covered by the in-process criterion
    // (`voice-realtime-fake-vad-upstream.test.ts`), which can step a clock deterministically.
    const upstream = await startScriptedUpstream(upstreamPort);
    upstream.armVad({
      timeBase: 'audio-time',
      threshold: 0.5,
      silenceDurationMs: 400,
      sampleRate: 16_000,
      turns: VAD_TURNS,
    });

    const workspacePath = path.join(fixtureHome, 'voice-continuous-workspace');
    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    const api = await request.newContext({
      baseURL: clientUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    try {
      const sessionId = await armScenario(api, workspacePath, deck('continuous experience baseline'));
      await startResidentProcess(api, sessionId);

      // ── this run's dependency pre-bundle, committed before any page of this run exists ────────
      // The optimizer is per-run and commits during the first page load, replacing the document it
      // was triggered from. That cost is paid here, over plain HTTP, and the wait ends when the
      // optimizer's own `browserHash` has stopped moving — see `client-startup-warmup.ts`.
      let warmup: ClientWarmupReading | null = null;
      try {
        warmup = await warmClientStartup(clientUrl, dataDir);
      } catch (error) {
        // A warm-up that cannot commit a pre-bundle is the same failure the criterion would meet on
        // its first navigation, reported with its own readings instead of a 30s locator timeout.
        throw new Error(`this run could not pre-commit its dependency optimizer: ${error instanceof Error ? error.message : String(error)}`);
      }

      const context = await browser.newContext({ baseURL: clientUrl, viewport: { width: 1280, height: 800 } });
      // THE BROWSER HALF OF "ZERO CLOUD CALLS": every non-loopback request is aborted before it
      // leaves, and the ones that were refused are collected so the reading can say the guard fired.
      const browserEgress: string[] = [];
      await context.route('**', (route) => {
        const url = route.request().url();
        if (/^(wss?|https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)) return route.continue();
        browserEgress.push(url);
        return route.abort();
      });
      await context.addInitScript(
        ({ authToken }: { authToken: string }) => {
          window.localStorage.setItem('auth-token', authToken);
          window.localStorage.setItem('userLanguage', 'en');
          const preferences = { voiceEnabled: true };
          window.localStorage.setItem('uiPreferences', JSON.stringify(preferences));
          window.localStorage.setItem(
            'user-preferences',
            JSON.stringify({ uiPreferences: preferences, userLanguage: 'en' }),
          );
        },
        { authToken: token },
      );
      await installFakeMic(context);
      // THE ACTIVITY STREAM, TAPPED. The dock's state is a reduction of these frames, so the frames
      // are the ground truth a dock reading has to be explained against. The tap subclasses the real
      // constructor rather than replacing it, so `instanceof` and every static member still hold and
      // the app's socket behaves exactly as it would without this installed.
      await context.addInitScript(() => {
        const frames: Array<Record<string, unknown>> = [];
        (window as unknown as { __activityFrames: typeof frames }).__activityFrames = frames;
        const Original = window.WebSocket;
        class Tapped extends Original {
          constructor(...args: ConstructorParameters<typeof WebSocket>) {
            super(...args);
            this.addEventListener('message', (event: MessageEvent) => {
              if (typeof event.data !== 'string') return;
              try {
                const parsed = JSON.parse(event.data) as Record<string, unknown>;
                const kind = typeof parsed.kind === 'string' ? parsed.kind : '';
                if (kind !== 'chat_subscribed' && !kind.startsWith('activity.')) return;
                frames.push({
                  atMs: Date.now(),
                  kind,
                  sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
                  isProcessing: typeof parsed.isProcessing === 'boolean' ? parsed.isProcessing : null,
                  phase: typeof parsed.phase === 'string' ? parsed.phase : null,
                  timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : null,
                  unreachableAfterMs: typeof parsed.unreachableAfterMs === 'number' ? parsed.unreachableAfterMs : null,
                });
              } catch {
                /* not a JSON frame */
              }
            });
          }
        }
        (window as unknown as { WebSocket: unknown }).WebSocket = Tapped;
      });

      const page = await context.newPage();
      const warnings: string[] = [];
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'warning' || message.type() === 'error') warnings.push(message.text());
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      // Uncaught exceptions, kept apart from the console stream on purpose. A refused request is
      // something THIS spec caused (see the egress route above) and a library deprecation notice is
      // something the page always says; neither is the interface failing. An exception that reached
      // `window.onerror` is.
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(String(error)));
      // Requests the browser never completed, with Playwright's own `failureText`. This is the stream
      // that tells an optimizer-triggered document replacement (`net::ERR_ABORTED` on the module
      // graph) apart from a server that never answered, and it is what the startup guard reports.
      const requestFailures: RequestFailure[] = [];
      page.on('requestfailed', (request) => {
        requestFailures.push({ url: request.url(), failureText: request.failure()?.errorText ?? '(no failureText)' });
      });
      const browserFrames: Array<Record<string, unknown>> = [];
      // The same frames, stamped: WHEN the app was told something is what tells an app-side delay
      // apart from an endpoint-side one, and the journal's own `at` fields are on this clock.
      const voiceFrames: Array<{ atMs: number; type: string }> = [];
      page.on('websocket', (ws) => {
        if (!ws.url().includes('/voice-realtime')) return;
        ws.on('framereceived', (frame) => {
          try {
            const payload = frame.payload;
            const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
            const parsed = JSON.parse(text) as Record<string, unknown>;
            browserFrames.push(parsed);
            voiceFrames.push({ atMs: Date.now(), type: typeof parsed.type === 'string' ? parsed.type : '(none)' });
          } catch {
            /* binary or non-JSON: not a protocol frame this reading is about */
          }
        });
      });
      // The health route is the one endpoint the page polls before it knows whether the deployment is
      // configured; the scripted upstream is what makes this run's session real, so the probe is
      // answered here rather than left to a network this run refuses to touch.
      await page.route('**/api/voice/health', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true }) }),
      );

      await page.goto(`/session/${sessionId}`);
      // The first navigation's mount gate. A 12s budget: the warm-up above has already committed
      // this run's pre-bundle, so the document either mounts quickly or something in this run's own
      // startup failed — and a miss reports the page's evidence (text, pageerrors, console errors,
      // failed requests) plus this run's optimizer readings instead of a bare locator timeout. The
      // budget is deliberately well inside the 30s the AC allows the failure to take, so the whole
      // failing run ends inside it. See `client-startup-warmup.ts`.
      await awaitClientMounted(page, PANE, 12_000, {
        pageErrors,
        consoleErrors,
        requestFailures,
        warmup,
      });

      // ── the plane BEFORE the walk: nothing is in flight, so the dock has nothing to say ────────
      // This is the first half of X-1's alternation condition, and it is read rather than assumed:
      // the walk that occupies the plane is started on the NEXT line, so whatever the dock says here
      // it says about a session no run has touched.
      const probeBeforeWalk: ProbeSample = { atMs: Date.now(), ...(await probeReading(page)) };

      // ── start the samplers, then the walk ──────────────────────────────────────────────────────
      // The samplers are armed BEFORE the walk so their series span idle → busy, and they run until the
      // plane has been read free again after having been busy (see the observation loop below). Two
      // series, because the alternation X-1 reads is a property of the DOCK while the question that
      // decides whether a delivery can become a row at all is a property of the HOST's turn lease:
      // they are different reductions of different facts, and the run above holds the reason they
      // disagree for as long as a walk is parked.
      const probes: ProbeSample[] = [];
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          const atMs = Date.now();
          probes.push({
            atMs,
            ...(await probeReading(page).catch(() => ({
              dock: { state: null, phase: null, elapsedMs: null },
              status: null,
            }))),
          });
          await new Promise((resolve) => setTimeout(resolve, DOCK_POLL_MS));
        }
      })();

      const leaseSeries: Array<{ atMs: number; held: boolean | null }> = [];
      let leasing = true;
      const leaseSampler = (async () => {
        while (leasing) {
          const atMs = Date.now();
          leaseSeries.push({ atMs, held: await readTurnLeaseHeld(api, sessionId) });
          await new Promise((resolve) => setTimeout(resolve, DOCK_POLL_MS));
        }
      })();

      // The walk is STARTED, never awaited: it is parked far past this test, and awaiting it would
      // hang the spec on a run whose whole purpose is to still be alive at the end.
      const walkStartedAtMs = Date.now();
      void api.post('/api/debug-agent/clock', { data: { sessionId } }).catch(() => undefined);
      // The walk's own step 0 writes the `unattended` row, so it is the proof that the bound session
      // is running the armed scenario at all rather than something this spec put there.
      await expect(page.locator(PANE)).toContainText(BUSY_TURN_TEXT, { timeout: 30_000 });

      // ── the walk's own turn is READ RELEASED before a word is spoken ───────────────────────────
      // WHERE THE FIRST DELIVERY LANDS IS DECIDED HERE, and this is the step the defect was missing.
      // Whether a delivered message becomes a visible row is decided by the execution plane at the
      // moment of delivery: a dispatch that finds a turn on the session is handed to the debug agent's
      // busy-input path, which records a queued command life-cycle frame and paints no user row at all
      // (see the file header). The walk's step 0 takes that turn for the fixture and its `turn-end`
      // (`TURN_END_AT_MS` later) releases it, so the timeline is played only once the turn has been read
      // RELEASED: every forwarded delivery then lands on a plane it occupies itself, which is what makes
      // its row a turn the transcript shows rather than a command nothing drains.
      //
      // WHAT IS READ, AND WHY IT IS NOT THE DOCK. The predicate the dispatcher itself evaluates is the
      // host binding's `turn` lease (`turnByAppSession.has(appSessionId)` in
      // `debug-agent.host-driver.ts`), so that is what this gate reads, off the listing the product's
      // own UI polls. The dock cannot answer this question: its state is a reduction of the chat run
      // registry, and the run a walk's `unattended-turn` opens is never completed while the walk is
      // parked — only the LEASE is released — so the dock goes on reading `in-turn` long after the
      // plane is free. That is measured rather than assumed: a probe series held `in-turn` from
      // walk+4.9 s to walk+24.9 s across a whole pre-play wait, with `turn-end` at walk+5.5 s.
      //
      // The wait is a READING and not a sleep: a turn that never releases fails HERE, by name, with the
      // series that says so, rather than quietly turning the row legs below red.
      const turnReleased = (): boolean => {
        const heldAt = leaseSeries.findIndex((read) => read.held === true);
        return heldAt >= 0 && leaseSeries.slice(heldAt).some((read) => read.held === false);
      };
      const releaseDeadline = Date.now() + TURN_RELEASE_TIMEOUT_MS;
      while (Date.now() < releaseDeadline && !turnReleased()) {
        await page.waitForTimeout(DOCK_POLL_MS);
      }
      if (!turnReleased()) {
        sampling = false;
        leasing = false;
        await Promise.all([sampler, leaseSampler]);
        throw new Error(
          `the walk's turn was never read released within ${TURN_RELEASE_TIMEOUT_MS} ms: ` +
            JSON.stringify(leaseSeries.map((read) => [read.atMs - walkStartedAtMs, read.held])),
        );
      }
      leasing = false;
      await leaseSampler;
      // The two instants are read off the same series the gate judged, and both stay null when nothing
      // was ever seen held: "released" is only a reading if the hold it released from was one too.
      const heldIndex = leaseSeries.findIndex((read) => read.held === true);
      const heldAtMs = heldIndex < 0 ? null : leaseSeries[heldIndex]!.atMs;
      const releasedAtMs =
        heldIndex < 0 ? null : leaseSeries.slice(heldIndex).find((read) => read.held === false)?.atMs ?? null;

      // ── enter Live Voice ──────────────────────────────────────────────────────────────────────
      await page.getByTestId('live-voice-button').click();
      await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });
      // The server has to have opened the upstream session before any audio is meaningful: a detector
      // armed on a socket nobody dialled hears nothing at all.
      await expect.poll(() => upstream.liveConnectionCount(), { timeout: 25_000 }).toBe(1);
      await expect.poll(() => upstream.vad()?.turnDetection ?? null, { timeout: 15_000 }).toBe('server_vad');
      // `state: open` is the CONNECTION, not the microphone. The bar reads `arming` from the moment the
      // upstream reports itself open until a captured frame actually arrives (see
      // `useVoiceRealtimeSession.ts`); this spec's fake capture pushes nothing before `playFakeMic`
      // below, so `arming` is the honest reading of a session whose microphone is still starting — and
      // it is deterministic here, because no frame can have been pushed yet. Waiting for `listening` at
      // this point is exactly the deadlock this gate replaces.
      await expect.poll(() => phase(page), { timeout: 25_000 }).toBe('arming');

      // ── play the timeline ─────────────────────────────────────────────────────────────────────
      // The gate's subject is read ONE more time at the instant the timeline starts: the release was
      // read before Live Voice was entered, and nothing can have taken the turn since (taking it is
      // what delivering does, and no audio has been played yet) — but "nothing can have" is exactly the
      // kind of claim this spec records instead of assuming.
      const heldAtPlayStart = await readTurnLeaseHeld(api, sessionId);
      const playBeganAtMs = Date.now();
      await playFakeMic(page);
      const playEndedAtMs = Date.now();
      // The FIRST captured frame is what moves the bar from `arming` to `listening`; the timeline
      // player has pushed its whole timeline by the time it resolves, so the product's own transition
      // is read here and demanded directly AFTER the first frame — never before it, and never relaxed.
      await expect.poll(() => phase(page), { timeout: 25_000 }).toBe('listening');

      // The detector closes utterances on its own schedule, so the reading waits for the count
      // instead of guessing how long the timeline takes.
      await upstream.waitForUtterances(VAD_TURNS.length);

      // A delivery is a round trip (proxy → coalescing window → session host → journal), so the
      // reading waits for the journal to have recorded the sends the detector already made rather
      // than for a fixed sleep.
      const sendDeadline = Date.now() + DELIVERY_TIMEOUT_MS;
      while (
        countJournal(journalDir, sessionId, 'session_send') < (upstream.vad()?.forwarded.length ?? 0) &&
        Date.now() < sendDeadline
      ) {
        await page.waitForTimeout(DOCK_POLL_MS);
      }

      // The last opportunity's `session_interrupt` is a round trip through the proxy, the session
      // host and the journal — give it the time a round trip takes before reading anything. A stop
      // that never arrives is a READING (X-5 records it as absent), not a reason to fail here.
      const stopDeadline = Date.now() + DELIVERY_TIMEOUT_MS;
      while (countJournal(journalDir, sessionId, 'interrupt') === 0 && Date.now() < stopDeadline) {
        await page.waitForTimeout(DOCK_POLL_MS);
      }

      // ── the interface's half of the wait ──────────────────────────────────────────────────────
      // Everything above is a SERVER-side fact: a journal entry, a detector reading, a frame on the
      // wire. The interface's own surface settles later — but the provisional caption rows it used to
      // settle into are gone (`gap-live-voice-remove-transcript-caption-rows`), so the surface that is
      // now left unsettled is the bottom bar's transcript slot: the latest utterance the model heard
      // sits there until its real message lands as a row. So the reading is the words on that slot the
      // chat transcript does not yet carry; a slot that never resolves is itself a reading (the
      // utterance was never delivered as a message — e.g. a correction carried on a stop's intent),
      // not a reason to hang. Bounded, and reported either way.
      const foldStarted = Date.now();
      let lastInFlight: string[] = [];
      while (Date.now() - foldStarted < FOLD_OBSERVE_MS) {
        const caption = ((await page.locator(CAPTION).textContent().catch(() => '')) ?? '').trim();
        const rows = (await snap(page)).rows;
        lastInFlight = caption !== '' && carries(rows, caption).length === 0 ? [caption] : [];
        if (lastInFlight.length === 0) break;
        await page.waitForTimeout(DOCK_POLL_MS);
      }

      // ── keep the plane under observation until it has been read free again ────────────────────
      // The busy half and the free half of the alternation X-1 reads. The run a delivery opens ends at
      // TURN_END_AT_MS, but the dock is driven by the server's activity frames — a heartbeat every few
      // seconds — so the free reading lands well after the timeline has been played out. Bounded: a
      // plane that never frees is a reading too.
      //
      // The busy half is searched for AT OR AFTER the play, not anywhere in the series: the walk's own
      // run is superseded by the first delivery's, so a busy reading is true of both halves of the
      // window and a search from the top of the series could be satisfied by the reading taken while the
      // walk was still the only thing on the plane — which is not the busyness this condition is about.
      // Anchoring to `playBeganAtMs` keeps the "idle again afterwards" half a reading about the
      // DELIVERIES: the free reading it waits for is the one that follows them.
      const observeDeadline = Date.now() + POST_PLAY_OBSERVE_MS;
      while (Date.now() < observeDeadline) {
        const states = probes.map((probe) => probe.dock.state);
        const busyAt = probes.findIndex((probe) => probe.atMs >= playBeganAtMs && probe.dock.state === 'in-turn');
        if (busyAt >= 0 && states.slice(busyAt).includes(null)) break;
        await page.waitForTimeout(DOCK_POLL_MS);
      }
      sampling = false;
      await sampler;

      const transcript = await snap(page);
      const finalProbe = await probeReading(page);
      const journal = readJournal(journalDir, sessionId);
      const journalEntries = journal.map((line) => JSON.parse(line) as JournalEntry);
      const egressText = existsSync(egressLog) ? readFileSync(egressLog, 'utf8') : '';
      const headers = upstream.upgradeHeaders();

      run = {
        sessionId,
        pushed: await fakeMicPushed(page),
        micFrames: await fakeMicFrames(page),
        detector: readDetector(upstream),
        upstreamFrameTypes: upstream.clientFrames().map((frame) => String(frame.type)),
        commits: upstream.commitCount(),
        declaredSegmented: browserFrames.some((frame) => frame.protocol === 'segmented-v1'),
        probes,
        probeBeforeWalk,
        turnLease: { series: leaseSeries, heldAtMs, releasedAtMs, heldAtPlayStart },
        playBeganAtMs,
        playEndedAtMs,
        walkStartedAtMs,
        activityFrames: await page.evaluate(
          () => ((window as unknown as { __activityFrames?: unknown[] }).__activityFrames ?? []) as ActivityFrame[],
        ),
        voiceFrames,
        transcript,
        status: finalProbe.status,
        caption: ((await page.locator(CAPTION).textContent().catch(() => '')) ?? '').trim(),
        phase: await phase(page),
        journal,
        journalEntries,
        routing: readRouting(journalEntries),
        dockSessionId: null,
        fold: { resolved: lastInFlight.length === 0, waitedMs: Date.now() - foldStarted, lastInFlight },
        pageErrors,
        egress: {
          logExists: existsSync(egressLog),
          blocked: egressText.includes('EGRESS BLOCKED'),
          dials: upstream.dialed(),
          authorizationSeen: headers.some((header) => header.authorization !== undefined),
          refused: [...browserEgress],
        },
        warnings,
      };
      run.dockSessionId =
        run.activityFrames.find((frame) => frame.kind === 'chat_subscribed')?.sessionId ?? null;

      // The run's own artifact, beside the recording: this is the reading table AC4 puts in `## Notes`.
      if (process.env.QUAY_CONTINUOUS_EXPERIENCE_DUMP) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(process.env.QUAY_CONTINUOUS_EXPERIENCE_DUMP, JSON.stringify(run, null, 2));
      }

      // ── leave Live Voice and release the walk, so nothing outlives the reading ────────────────
      await page.getByTestId('voice-realtime-end').click().catch(() => undefined);
      await api.post('/api/debug-agent/release', { data: { sessionId } }).catch(() => undefined);
      await context.close().catch(() => undefined);
    } finally {
      await api.dispose();
      await upstream.close();
    }
  });

  /** How many journal entries of `kind` this session wrote. */
  function countJournal(dir: string, sessionId: string, kind: string): number {
    return readJournal(dir, sessionId)
      .map((line) => JSON.parse(line) as JournalEntry)
      .filter((entry) => entry.kind === kind).length;
  }

  // ── non-vacuity: the timeline and the detector agree on how many utterances there were ────────
  test('the timeline played, and the endpoint closed one utterance per spoken run', () => {
    const spoken = CONTINUOUS_EXPERIENCE_TIMELINE.filter((segment) => segment.kind === 'speech');
    expect(spoken.length, 'the timeline must carry at least five spoken runs').toBeGreaterThanOrEqual(5);
    for (const segment of CONTINUOUS_EXPERIENCE_TIMELINE) {
      if (segment.kind !== 'silence') continue;
      expect(segment.seconds, `gap "${segment.label}" must be inside the 0.3–3 s band`).toBeGreaterThanOrEqual(0.3);
      expect(segment.seconds, `gap "${segment.label}" must be inside the 0.3–3 s band`).toBeLessThanOrEqual(3);
    }
    // The page really pushed the timeline: a play that pushed nothing would make every reading below
    // a reading of silence.
    expect(run.micFrames, 'the fake capture must have pushed frames').toBeGreaterThan(50);
    expect(run.pushed.filter((segment) => segment.kind === 'speech')).toHaveLength(spoken.length);
    // One closure per spoken run, and at least one speech_stopped announcement per closure.
    expect(run.detector.speechStopped, 'one closed utterance per spoken run').toBe(spoken.length);
    expect(run.detector.speechStarted).toBeGreaterThanOrEqual(spoken.length);
    expect(run.detector.opportunities).toBeGreaterThanOrEqual(spoken.length);
    // The detector's own closures are the same events the proxy journaled, one for one.
    expect(run.routing.speechStops, 'the proxy must have journaled every closure').toHaveLength(spoken.length);
    expect(run.routing.transcripts.map((entry) => entry.text)).toEqual(VAD_TURNS.map((turn) => turn.text));
  });

  // ── the wire under test: which mode this session actually ran ─────────────────────────────────
  test('the session ran the continuous wire — server_vad, no commit, no segmented declaration', () => {
    expect(run.detector.turnDetection, 'the endpoint must hold server_vad for this session').toBe('server_vad');
    expect(run.declaredSegmented, 'the proxy must NOT declare the segmented relay in continuous mode').toBe(false);
    expect(run.commits, 'continuous mode commits nothing — the endpoint does the segmenting').toBe(0);
    expect(run.upstreamFrameTypes).toContain('input_audio_buffer.append');
    expect(run.upstreamFrameTypes).not.toContain('input_audio_buffer.commit');
    expect(run.upstreamFrameTypes).not.toContain('segment_start');
    expect(run.phase, 'the bar must be listening at the end of the play').toBe('listening');
    // The journal's own header for this connection: the mode the composition root resolved.
    const connection = run.journalEntries.find((entry) => entry.kind === 'connection');
    expect(connection, 'the journal must carry a connection header for this session').toBeDefined();
    expect(connection?.mode).toBe('continuous');
    // The session the journal was written for is the session the transcript and the dock report on.
    expect(connection?.sessionId).toBe(run.sessionId);
    expect(run.dockSessionId, 'the activity stream must be the bound session').toBe(run.sessionId);
  });

  // ── X-1: what became of each spoken run, and the busy/idle plane it became it on ──────────────
  test("X-1: the endpoint's disposition table, one visible disposition per spoken run, no silent loss", () => {
    const table = run.detector.records.map((record) => `${record.text}=${record.disposition}`);
    expect(table, `dispositions: ${JSON.stringify(table)}`).toEqual([
      `${U1}=forwarded`,
      `${U2}=unforwarded`,
      `${U3}=forwarded`,
      `${U4}=forwarded`,
      `${U5}=interrupted`,
    ]);
    expect(run.detector.records.map((record) => record.disposition)).toEqual(EXPECTED_DISPOSITIONS);
    // Every utterance got an item id, and the ids are the endpoint's own, in spoken order.
    expect(run.detector.records.map((record) => record.itemId)).toEqual(run.detector.items);
    // 静默丢失 = 0: every spoken run is a record, in spoken order, and nothing is missing or repeated.
    expect(run.detector.records).toHaveLength(VAD_TURNS.length);
    expect(run.detector.records.map((record) => record.text)).toEqual(VAD_TURNS.map((turn) => turn.text));

    // VISIBLE DISPOSITION. Each spoken run's words are on screen, re-anchored to the surfaces the
    // CURRENT projection actually paints — the provisional caption rows this spec used to read were
    // removed (`gap-live-voice-remove-transcript-caption-rows`, 2b7dfc17), so each disposition is read
    // off the surface that now carries it, and every leg here is a direct assertion: the last one that
    // was not (the merged delivery, below) became one with
    // `gap-voice-delivered-merged-message-invisible-in-transcript`.
    //
    // A FORWARDED run is the real user row the model relayed: the person's words reach the transcript
    // the one way anything does. Read once, and once only.
    const u1Rows = carries(run.transcript.rows, U1);
    expect(u1Rows, `"${U1}" must be on screen once: ${JSON.stringify(run.transcript.rows)}`).toHaveLength(1);
    expect(u1Rows[0]!.style, 'the delivered sentence must be a real user row').toBe('user');
    expect(u1Rows[0]!.testid, "and not a row of the voice layer's own").toBeNull();
    // ...AND AN ORDINARY ONE. The badge that used to mark the row as spoken — `Heard as: …`, holding
    // what the recogniser heard — is gone with the strip, so the delivered row carries no mark at all.
    // Read off the row's whole subtree rather than by name, so a mark reintroduced under another name
    // fails here too.
    expect(
      u1Rows[0]!.marks,
      `a delivered spoken row must be indistinguishable from a typed one: ${JSON.stringify(u1Rows[0])}`,
    ).toEqual([]);
    // An INTERRUPTED run has no chat-area row, by design: its correction rides the stop's `intent` and
    // is never delivered as a message (see X-5). The one surface that carries it is the bottom voice
    // bar's transcript slot — the last caption the endpoint published — where the words are on screen,
    // so the correction is not silently lost.
    expect(
      normalize(run.caption),
      `"${U5}" must be on the voice bar's transcript slot: ${JSON.stringify(run.caption)}`,
    ).toContain(normalize(U5));
    // The U2 half of the same `[U1, U2, U5]` carrier assertion, re-anchored by the 2026-10-13 ruling
    // onto the projection `gap-live-voice-remove-transcript-caption-rows` (2b7dfc17) leaves behind.
    //
    // THE RULING. U2 is this spec's `policy: 'silent'` run — the model heard it and answered with
    // nothing, and the upstream emits no signal for it at all —, and a `silent` utterance is NOT owed a
    // visible disposition. Only an utterance the model actually DELIVERED must show a row. So this leg
    // now asserts the narrowed behaviour DIRECTLY (it is no longer a known defect): the chat area
    // carries U2 on no row, and no row of the voice layer's own paints it as a refusal (拒收), an
    // unrecognized segment (未识别), or a lost segment (段丢失) — the three honest state rows this
    // projection still draws. A `silent` utterance is thus neither dropped onto a row it does not own,
    // nor mislabelled as some other disposition. (The delivery that IS owed a row — the merged message —
    // is the leg below, and it now has one.)
    expect(
      carries(run.transcript.rows, U2),
      `a silent utterance must be carried by no row: ${JSON.stringify(run.transcript.rows)}`,
    ).toEqual([]);
    const mislabelledU2 = run.transcript.rows.filter(
      (row) => isVoiceOnlyRow(row.testid) && normalize(row.text).includes(normalize(U2)),
    );
    expect(
      mislabelledU2,
      `a silent utterance must not be painted as refused / unrecognized / segment-lost: ${JSON.stringify(mislabelledU2)}`,
    ).toEqual([]);
    // The mid-thought pair shares ONE carrier, which is the merged disposition X-4 predicts.
    //
    // DIRECT ASSERTION, and why it is one: the 2026-10-13 ruling said an `outcome: 'delivered'` message
    // must have a row, and this one had none. `routing.sends` records the merged `U3+U4` as delivered
    // (asserted in X-3 below); the caption rows that used to stand in for a pending delivery were
    // removed (`gap-live-voice-remove-transcript-caption-rows`, 2b7dfc17); `"我想想"` (`item_vad_2`) was
    // claimed by the FIRST delivery's `coveredThroughItemId` while the model had never been shown it,
    // and `"然后跑一下测试"` had no row of its own — so the merged text sat on ZERO rows and nobody could
    // see what Claude was actually given.
    //
    // THE TWO ENDS THAT MAKE IT HOLD, named here so the green is not over-read:
    //  · the proxy stamps `coveredThroughItemId` when the MODEL produced the instruction, not when the
    //    `sent` frame happens to leave (`voice-realtime-ws-proxy.service.ts`), so the first delivery no
    //    longer swallows `item_vad_2` out of the merged delivery's claim; and
    //  · the projection draws a carrier row for a delivery whose real message the transcript is not yet
    //    showing (`placeCaptions.ts`'s `deliveredMessageRows`), carrying the words of the captions the
    //    delivery claims BY ITEM ID whose text the delivered message actually carries.
    // Reverting the first end leaves the merged delivery claiming only `"然后跑一下测试"`; reverting the
    // second removes the row entirely. Either way `carries(..., MERGED_MESSAGE)` is empty and THIS line
    // reds — both falsifications are recorded in the task's `## Evidence`.
    const mergedRows = carries(run.transcript.rows, MERGED_MESSAGE);
    expect(
      mergedRows,
      `the merged delivery must be visible as delivered: rows ${JSON.stringify(run.transcript.rows)}`,
    ).toHaveLength(1);
    expect(mergedRows[0]!.style, 'the merged delivery must be carried by a row of the conversation').toBe('user');
    expect(mergedRows[0]!.testid, "and not by one of the voice layer's own state rows").toBeNull();

    // THE ALTERNATION. The plane was read free before the walk, busy while the sentences were being
    // delivered, and free again afterwards — read off the product's own dock across one window.
    const states = run.probes.map((probe) => probe.dock.state);
    const transitions = states.filter((state, index) => index > 0 && state !== states[index - 1]).length;
    expect(
      run.probeBeforeWalk.dock.state,
      `the plane must be free before the walk: ${JSON.stringify(run.probeBeforeWalk)}`,
    ).toBeNull();
    // ...AND NOTHING ELSE WAS HOLDING IT WHEN THE DELIVERIES BEGAN, which is the reading the row legs
    // above rest on. Three readings off the host's own lease, not off the dock: the walk's turn was seen
    // occupying the plane, seen released, and the lease was read free again at the instant the timeline
    // started — so the first forwarded sentence landed on a plane it occupied itself. Taken here as well
    // as waited on, so a run that pushed a delivery into the busy-input path cannot pass on the row legs
    // alone.
    const leaseSeries = run.turnLease.series.map((read) => [read.atMs - run.walkStartedAtMs, read.held]);
    expect(
      run.turnLease.heldAtMs,
      `the walk's own turn must have been seen occupying the plane: ${JSON.stringify(leaseSeries)}`,
    ).not.toBeNull();
    expect(
      run.turnLease.releasedAtMs,
      `...and then seen released before the timeline started: ${JSON.stringify(leaseSeries)}`,
    ).not.toBeNull();
    expect(
      run.turnLease.heldAtPlayStart,
      `the plane must be free when the timeline starts, or a delivery lands in someone else's window: ${JSON.stringify(leaseSeries)}`,
    ).toBe(false);
    expect(states.length, 'the dock must have been sampled across the observation window').toBeGreaterThan(4);
    expect(states.some((state) => state === 'in-turn'), `the plane must have been busy: ${JSON.stringify(states)}`).toBe(
      true,
    );
    expect(states.some((state) => state === null), `the plane must have been free: ${JSON.stringify(states)}`).toBe(
      true,
    );
    expect(
      transitions,
      `the plane must have gone busy/idle at least twice: ${JSON.stringify(states)}`,
    ).toBeGreaterThanOrEqual(2);
  });

  // ── X-1 (green): the delivered message is not still shown as delivering ───────────────────────
  // GREEN as of `gap-live-voice-segment-honest-heard-unrecognized-state` (AC-355), which replaced the
  // single folded caption row with one row per utterance, and STILL green after
  // `gap-live-voice-remove-transcript-caption-rows` (2b7dfc17) removed the caption rows altogether. The
  // reading this leg was written against — the journal's merged delivery sitting inside ONE row still
  // marked as not-yet-delivered — was:
  //   delivered but still shown as delivering: rows […{"style":"user","testid":"voice-row-… (whichever
  //   disposition marker the projection used at the time)","text":"我想想然后跑一下测试"}…]
  // The marker has been re-anchored twice, and this is the third: the strip
  // (`gap-voice-ui-strip-to-caption-and-connection-state`, 2026-10-14) removed the last of those rows, so
  // naming one would leave this leg filtering on a testid nothing can carry. It reads the PREFIX instead
  // — a delivery that is not yet on the transcript must not be standing on ANY line of the voice layer's
  // own, whatever that line is called. WHY IT HOLDS, stated so the green is not over-read: the merged
  // delivery's own carrier row is an ordinary user row (its `testid` is null), so `isVoiceOnlyRow` finds
  // nothing carrying the merged text. The carrier row itself, and the traceability gap the leg above used
  // to record, belong to the merged-carrier leg of the disposition-table test under
  // `gap-voice-delivered-merged-message-invisible-in-transcript`.
  test('X-1: a message the journal recorded as delivered is not still shown as delivering', () => {
    const rows = JSON.stringify(run.transcript.rows);
    const wrong = run.transcript.rows.filter(
      (row) => isVoiceOnlyRow(row.testid) && normalize(row.text).includes(normalize(MERGED_MESSAGE)),
    );
    expect(wrong, `delivered but still shown as delivering: rows ${rows}`).toEqual([]);
  });

  // ── X-2: heard, and not delivered ─────────────────────────────────────────────────────────────
  test('X-2: the 「嗯」 fragment was heard and never delivered', () => {
    expect(run.detector.forwarded, 'the delivered set is the two forwards, in spoken order').toEqual([
      U1,
      MERGED_MESSAGE,
    ]);
    for (const delivered of run.detector.forwarded) {
      expect(normalize(delivered), `"${U2}" must not ride any delivered message`).not.toContain(normalize(U2));
    }
    // 投递集合 ∩ 未转发集合 = ∅, read off the same session's journal rather than off the detector: what
    // the session was handed is the deliverd set, and the fragment must not be in it.
    expect(run.routing.sends.map((entry) => entry.message)).toEqual(run.detector.forwarded);
    for (const entry of run.routing.sends) {
      expect(normalize(entry.message), `"${U2}" must not ride any delivered message`).not.toContain(normalize(U2));
    }
    // The transcript agrees: the fragment is a row the voice layer owns, and no delivered turn carries it.
    expect(carries(deliveredRows(run.transcript), U2), 'no delivered turn may carry the fragment').toEqual([]);
    // 2026-10-13 ruling. U2 is `policy: 'silent'` — heard, answered with nothing, no upstream signal —
    // so it is NOT owed a visible disposition, and this leg now asserts that narrowing DIRECTLY instead
    // of demanding a row (it is no longer a known defect). The "heard and never delivered" reading above
    // is a property of the JOURNAL (the detector and routing readings); on the page the narrowed
    // guarantee is: the fragment is on no row of the chat area, and no honest state row miscasts it as
    // refused / unrecognized / segment-lost.
    expect(
      carries(run.transcript.rows, U2),
      `a silent utterance must be carried by no row: ${JSON.stringify(run.transcript.rows)}`,
    ).toEqual([]);
    const mislabelledU2 = run.transcript.rows.filter(
      (row) => isVoiceOnlyRow(row.testid) && normalize(row.text).includes(normalize(U2)),
    );
    expect(
      mislabelledU2,
      `a silent utterance must not be painted as refused / unrecognized / segment-lost: ${JSON.stringify(mislabelledU2)}`,
    ).toEqual([]);
  });

  // ── X-3: every delivery traces back to the model turn and the endpoint item that caused it ────
  test('X-3: every delivery chains to its response, its item, and the frame the model spoke it in', () => {
    const logs = logLines(run.journalEntries);
    expect(run.routing.sends.length, 'the run must have delivered something to trace').toBeGreaterThanOrEqual(1);
    for (const send of run.routing.sends) {
      const where = `delivery of ${JSON.stringify(send.message)} at ${new Date(send.atMs).toISOString()}`;
      // (1) The model's own function call for this message, before the session was handed it.
      const call = lastBefore(
        logs,
        send.atMs,
        (line) => sendMessageOf(line) === send.message,
      );
      expect(call, `${where}: no function_call session_send in the journal`).not.toBeNull();
      // (2) The response the call was made under — the chain X-3 asks for, one hop up.
      const response = lastBefore(logs, call!.atMs, (line) => line.startsWith('<< response.created'));
      expect(response, `${where}: no response.created before the call`).not.toBeNull();
      expect(idOf(response!.line, '<< response.created', 'response.id'), `${where}: response id`).toMatch(/^resp_/);
      // (3) The endpoint item the user's words were committed as — the other hop X-3 asks for.
      const item = lastBefore(logs, call!.atMs, (line) => line.startsWith('<< conversation.item.created'));
      expect(item, `${where}: no conversation.item.created before the call`).not.toBeNull();
      expect(idOf(item!.line, '<< conversation.item.created', 'item.id'), `${where}: item id`).toMatch(/^item_/);
      // (4) The proxy held the call in its coalescing window before delivering it — the debounce is
      //     part of the chain, not an unlogged gap between the model and the session.
      const queued = firstAfter(logs, call!.atMs, (line) => line.startsWith('to-browser queued'));
      const sent = firstAfter(logs, call!.atMs, (line) => line === 'to-browser sent');
      expect(queued, `${where}: the delivery was never queued`).not.toBeNull();
      expect(sent, `${where}: the queue never flushed`).not.toBeNull();
      expect(queued!.atMs, `${where}: queue mark before the call`).toBeGreaterThanOrEqual(call!.atMs);
      expect(sent!.atMs, `${where}: flush before the queue mark`).toBeGreaterThanOrEqual(queued!.atMs);
      // The two records of one delivery are written on two sides of the same round trip — the proxy's
      // `to-browser sent` and the session host's journal entry — so their stamps are equal within a
      // millisecond and their ORDER is not a reading. Compared with the slop a millisecond clock
      // cannot resolve, so the leg asks that they agree and not that one won.
      expect(Math.abs(send.atMs - sent!.atMs), `${where}: the flush and the delivery must be one event`)
        .toBeLessThanOrEqual(50);
    }
    // The chain to the CLI's own turn (`commandUuid`) is NOT in the voice journal: the criterion
    // counts an EXPLICIT unknown as complete, so it is recorded as one rather than left implicit.
    expect(run.routing.sends.every((entry) => entry.outcome === 'delivered')).toBe(true);
    expect(
      run.journal.some((line) => line.includes('commandUuid')),
      'the voice journal carries no CLI turn id — X-3 records this hop as unknown',
    ).toBe(false);
  });

  // ── X-4: the mid-thought pause ────────────────────────────────────────────────────────────────
  test('X-4: the 1.5 s mid-thought pause produced ONE message, not two', () => {
    expect(run.detector.forwarded.filter((message) => normalize(message).includes(normalize(U3)))).toEqual([
      MERGED_MESSAGE,
    ]);
    expect(run.detector.forwarded.filter((message) => normalize(message).includes(normalize(U4)))).toEqual([
      MERGED_MESSAGE,
    ]);
    // Both halves were heard as separate utterances...
    expect(run.detector.records[2]?.text).toBe(U3);
    expect(run.detector.records[3]?.text).toBe(U4);
    // ...and the SESSION was handed one message carrying both, which is what X-4 grades on
    // ("Claude 侧收到的消息条数与内容"): the count is one and the content is the spoken order.
    const carryingU3 = run.routing.sends.filter((entry) => normalize(entry.message).includes(normalize(U3)));
    const carryingU4 = run.routing.sends.filter((entry) => normalize(entry.message).includes(normalize(U4)));
    expect(carryingU3).toHaveLength(1);
    expect(carryingU4).toHaveLength(1);
    expect(carryingU3[0]!.message).toBe(carryingU4[0]!.message);
    expect(carryingU3[0]!.message, 'a debounce that reordered the halves would be a different message').toBe(
      MERGED_MESSAGE,
    );
    // The debounce is the proxy's coalescing window: the deferred half rode the next forward rather
    // than a second delivery, which is why there is one send and not two.
    expect(run.detector.records[2]?.disposition).toBe('forwarded');
    expect(run.routing.transcripts.map((entry) => entry.text)).toEqual([U1, U2, U3, U4, U5]);
  });

  // ── X-5: the correction ───────────────────────────────────────────────────────────────────────
  test('X-5: the model issued the stop, it carried the correction, and the deliveries before it stood', () => {
    expect(run.detector.records[4]?.disposition).toBe('interrupted');
    // The model's own call, with its own statement of the new direction — semantic, not a keyword scan.
    expect(run.routing.stops.length, 'the model must have issued the stop').toBeGreaterThanOrEqual(1);
    expect(run.routing.stops[0]!.intent).toBe('方向改成跑 lint');
    // The audit record the stop left, on the journal.
    expect(run.routing.audits.length, 'the journal must carry the stop the model asked for').toBeGreaterThanOrEqual(1);
    const stop = run.routing.audits[0]!;
    expect(stop.by, 'the only caller of this path today is the model').toBe('model');
    expect(stop.intent, "the model's own statement of the new direction").toBe('方向改成跑 lint');
    expect(['aborted', 'no-run', 'refused', 'covered']).toContain(stop.outcome);
    // The correction itself is NOT a second delivery: the interrupt policy carries it on the stop's
    // `intent`, so the words reach the session exactly once and on the channel that ends the run.
    expect(
      run.routing.toolCalls.filter((call) => normalize(call.message).includes(normalize(U5))),
      'the correction must not also be delivered as a message',
    ).toEqual([]);
    // G1, read as an ORDER: the abort was asked for after the delivery that was in flight had already
    // been handed over, so a stop can never overtake words the session already has. Every delivery the
    // journal recorded is `delivered`, and none was recorded after the stop.
    expect(run.routing.sends.every((entry) => entry.outcome === 'delivered')).toBe(true);
    expect(
      run.routing.sends.filter((entry) => entry.atMs > stop.atMs),
      'no delivery may follow the stop — a stop that dropped an accepted message would show here',
    ).toEqual([]);
    // The audit's own accounting of what the stop did NOT take with it, which is the landed G1 fence.
    const audit = run.journalEntries.find((entry) => entry.kind === 'interrupt');
    expect(audit, 'the audit entry itself').toBeDefined();
    expect(typeof audit?.queuedStillPending, 'the stop must account for the queue it left behind').toBe('number');
    expect(audit?.queuedStillPending).toBeGreaterThanOrEqual(0);
    // The interface's own account: the page was HANDED the stop, and the frame names the depth it left
    // queued. REWRITTEN with gap-voice-ui-strip-to-caption-and-connection-state (2026-10-14) — the bar
    // draws no stop notice any more, so this is read on the outbound frame the page received rather
    // than in the DOM. It is the same fact one step earlier, and it cannot be satisfied by a bar that
    // was told nothing; the journal line the proxy writes for that frame is
    // `to-browser stopped depth=N` (`voice-realtime-ws-proxy.service.ts`'s `send`).
    expect(
      run.routing.stoppedToBrowser.length,
      `the page must have been handed the stop it was told about: ${JSON.stringify(run.routing.stoppedToBrowser)}`,
    ).toBeGreaterThan(0);
    // The stop the USER can press shares this path's abort verb (read off the executor, not exercised
    // here): this spec drives the model's stop, so the button half of X-5 is recorded, not measured.
  });

  // ── X-6: the state line, and the frame timeline behind the dock ───────────────────────────────
  test('X-6: only non-transient phases carried words, the capture reading stayed live, and the dock was explained by its own frames', () => {
    // 状态行. The clause is "only a phase the person can act on carries words": `idle`,
    // `connecting`, `arming` and `listening` are transient now — the entry sound marks the live
    // moment — and their reading is `data-capture`, checked beside the text. A wordless sample in
    // any OTHER phase is still exactly the failure this clause is about.
    const TRANSIENT_PHASES = new Set(['idle', 'connecting', 'arming', 'listening']);
    const withStatus = run.probes.filter((probe) => probe.status !== null);
    expect(withStatus.length, 'the bar must have been up for most of the observation').toBeGreaterThan(3);
    expect(
      withStatus.filter((probe) => probe.status!.text.length === 0 && !TRANSIENT_PHASES.has(probe.status!.phase ?? '')),
      `every sample of the state line must carry words outside a transient phase: ${JSON.stringify(
        withStatus.map((p) => ({ phase: p.status!.phase, capture: p.status!.capture, text: p.status!.text })),
      )}`,
    ).toEqual([]);
    // The transient samples are wordless BY DESIGN, and the attribute is what makes them legible.
    const transientSamples = withStatus.filter((probe) => TRANSIENT_PHASES.has(probe.status!.phase ?? ''));
    expect(
      transientSamples.length,
      'the observation must have sampled a transient phase, or the wordless half of this leg is vacuous',
    ).toBeGreaterThan(0);
    expect(
      transientSamples.filter((probe) => probe.status!.text.length > 0),
      `a transient phase must not carry words: ${JSON.stringify(transientSamples.map((p) => p.status!.text))}`,
    ).toEqual([]);
    expect(
      withStatus.filter((probe) => probe.status!.capture !== 'starting' && probe.status!.capture !== 'live'),
      `every sample must publish data-capture=starting|live: ${JSON.stringify(withStatus.map((p) => p.status!.capture))}`,
    ).toEqual([]);
    expect(run.status, 'the bar must still publish a status cell at the end').not.toBeNull();
    expect(run.status!.queuedDepth ?? '', 'the status cell must publish the queue depth').toMatch(/^\d+$/);
    expect(run.status!.queuedBytes ?? '', 'the status cell must publish the queued bytes').toMatch(/^\d+$/);
    expect(run.routing.statusInjections.length, 'the status line must have been injected during the run').toBeGreaterThan(
      0,
    );

    // 帧时间线采样. The dock's claims are a reduction of the activity frames, so the reading that
    // matters is whether the frames can account for them: the busy half is a beat that said
    // `isProcessing: true`, and the free half is a beat that said false.
    const activity = run.activityFrames;
    expect(activity.length, 'the page must have received activity frames').toBeGreaterThan(0);
    expect(
      activity.some((frame) => frame.isProcessing === true),
      `the busy half must be a beat that said so: ${JSON.stringify(activity)}`,
    ).toBe(true);
    expect(
      activity.some((frame) => frame.isProcessing === false),
      `the free half must be a beat that said so: ${JSON.stringify(activity)}`,
    ).toBe(true);
    // The frames are the bound session's, and the dock's busy reading follows the frame that pinned
    // it rather than leading it.
    const firstBusyFrame = activity.find((frame) => frame.isProcessing === true);
    expect(firstBusyFrame?.sessionId).toBe(run.sessionId);
    const firstBusyProbe = run.probes.find((probe) => probe.dock.state === 'in-turn');
    expect(firstBusyProbe, 'the dock must have read busy while a run was in flight').toBeDefined();
    expect(firstBusyProbe!.atMs).toBeGreaterThanOrEqual(run.walkStartedAtMs);

    // 未转发 (silent) is owed NO visible marker, per the 2026-10-13 ruling. This leg used to read the
    // clause "未转发 must be MARKED, not silently dropped"; the ruling narrows that clause to utterances
    // the model DELIVERED (`outcome: 'delivered'`), and U2 is `policy: 'silent'` — heard, answered with
    // nothing, no upstream signal — so it is owed no marker and this leg asserts the narrowed guarantee
    // DIRECTLY: the fragment is on no row of the chat area, and no honest state row miscasts it as
    // refused / unrecognized / segment-lost. (The delivery that IS owed a row — the merged message — is
    // read on X-1's merged-carrier leg, now a direct assertion.)
    expect(
      carries(run.transcript.rows, U2),
      `a silent utterance must be carried by no row: ${JSON.stringify(run.transcript.rows)}`,
    ).toEqual([]);
    const mislabelledU2 = run.transcript.rows.filter(
      (row) => isVoiceOnlyRow(row.testid) && normalize(row.text).includes(normalize(U2)),
    );
    expect(
      mislabelledU2,
      `a silent utterance must not be painted as refused / unrecognized / segment-lost: ${JSON.stringify(mislabelledU2)}`,
    ).toEqual([]);

    // THE DEGRADATION BUDGET, read off the hello that announced it. The criterion is "≤ 2 s 无更新须
    // 显示降级"; the server announces its own budget here, and the reading is what it announced.
    const announced = activity.find((frame) => frame.kind === 'chat_subscribed')?.unreachableAfterMs ?? null;
    expect(announced, 'the hello must announce the silence budget the dock judges freshness against').not.toBeNull();
    expect(announced!, 'the announced budget must be a positive number of ms').toBeGreaterThan(0);
    // Recorded, not asserted: the reading table carries what the product announced against the
    // criterion's 2 s. A spec that demanded 2 s here would be asserting a number the bar has never
    // promised, and the gap is a finding for `## Notes`, not a defect this file gets to declare.
    expect(run.probes.every((probe) => probe.dock.state === null || typeof probe.dock.state === 'string')).toBe(true);
  });

  // ── X-7: the latency the interaction actually cost ────────────────────────────────────────────
  test('X-7: the per-utterance latency table, read off the routing journal', () => {
    const logs = logLines(run.journalEntries);
    /** The closure of the utterance that was still open when `atMs` happened — every interval's origin. */
    const lastStopBefore = (atMs: number): number | null =>
      lastBefore(logs, atMs, (line) => line.startsWith('<< input_audio_buffer.speech_stopped'))?.atMs ?? null;
    const { speechStops, transcripts, captions, toolCalls, queued } = run.routing;
    expect(speechStops.length, 'every closure is a timing origin').toBe(VAD_TURNS.length);
    expect(toolCalls.length, 'both forwards must be visible as model calls').toBe(run.detector.forwarded.length);
    expect(queued.length, 'every forward must have been queued visibly').toBe(toolCalls.length);

    // 说完 → 字幕定型 ≤ 1.0 s p50. The proxy announces the completed transcript the moment it holds
    // it, and the caption it publishes to the page is the same event.
    const captionMs = transcripts.map((entry, index) => entry.atMs - speechStops[index]!);
    expect(captionMs.every((ms) => ms >= 0), `说完 → 字幕定型: ${JSON.stringify(captionMs)} ms`).toBe(true);
    expect(Math.max(...captionMs), `说完 → 字幕定型: ${JSON.stringify(captionMs)} ms`).toBeLessThanOrEqual(1_000);
    expect(captions.map((entry) => entry.text), 'the caption is the transcript the proxy published').toEqual(
      transcripts.map((entry) => entry.text),
    );

    // 说完 → 模型工具调用 ≤ 1.5 s. The call is stamped from the closure of the utterance it answers.
    const callMs = toolCalls.map((call) => call.atMs - (lastStopBefore(call.atMs) ?? call.atMs));
    expect(Math.max(...callMs), `说完 → 工具调用: ${JSON.stringify(callMs)} ms`).toBeLessThanOrEqual(1_500);

    // 忙时说完 → 「已排队」可见 ≤ 1.5 s. The plane was busy for the whole spoken window — X-1's
    // alternation puts its free half outside it — so THIS is the branch the reading exercises, and the
    // criterion's idle branch ("空闲时说完 → Claude 收到 ≤ 2.5 s p50") is recorded as not exercised
    // rather than measured on a plane that was never free while the person was speaking.
    const queuedVisibleMs = toolCalls.map((call, index) => queued[index]! - call.atMs);
    expect(queuedVisibleMs.every((ms) => ms >= 0), `已排队可见: ${JSON.stringify(queuedVisibleMs)} ms`).toBe(true);
    expect(Math.max(...queuedVisibleMs), `忙时说完 → 已排队可见: ${JSON.stringify(queuedVisibleMs)} ms`)
      .toBeLessThanOrEqual(1_500);

    // 说完 → Claude 收到, per delivery, with the proxy's own coalescing window in between. The origin
    // is the utterance the delivery ANSWERS — the last closure whose words the message carries — and
    // not merely the last closure before it: a message that waited in the debounce window is still an
    // answer to the sentence that put it there, and attributing it to whatever was said meanwhile
    // would read the delay as somebody else's.
    const closureOfDelivery = (message: string, atMs: number): number => {
      let origin = lastStopBefore(atMs) ?? atMs;
      run.routing.transcripts.forEach((entry, index) => {
        if (entry.atMs <= atMs && normalize(message).includes(normalize(entry.text))) {
          origin = speechStops[index] ?? origin;
        }
      });
      return origin;
    };
    const deliveredMs = run.routing.sends.map((send) => send.atMs - closureOfDelivery(send.message, send.atMs));
    expect(deliveredMs.every((ms) => ms >= 0), `说完 → Claude 收到: ${JSON.stringify(deliveredMs)} ms`).toBe(true);
    // The tool-side cost the journal itself measured, which is the round trip WITHOUT the debounce.
    for (const entry of run.routing.sends) {
      expect(entry.latencyMs, `latencyMs must be a number: ${JSON.stringify(entry)}`).not.toBeNull();
      expect(entry.latencyMs!).toBeGreaterThanOrEqual(0);
      expect(entry.latencyMs!).toBeLessThanOrEqual(1_000);
    }
    expect(run.routing.sends).toHaveLength(run.detector.forwarded.length);
    // The debounce is visible in the same table: every delivery waited inside a coalescing window, so
    // its wall-clock cost is well above the tool round trip the journal measured — the gap X-4 buys
    // with a mid-thought pause, and the reading that explains why the two are different numbers.
    expect(run.routing.coalesced.length, 'every delivery must be the product of a coalescing window').toBe(
      run.routing.sends.length,
    );
    expect(run.routing.sends.every((entry, index) => deliveredMs[index]! >= entry.latencyMs!)).toBe(true);
  });

  // ── AC5: nothing left the machine ─────────────────────────────────────────────────────────────
  test('zero cloud calls: the guard ran, refused nothing, and the upstream was the stand-in', () => {
    expect(run.egress.logExists, 'the guard creates its log empty as proof the preload ran').toBe(true);
    expect(run.egress.blocked, 'nothing may have been refused a non-loopback dial').toBe(false);
    expect(run.egress.dials, 'the app must have dialled THIS server').toBeGreaterThanOrEqual(1);
    expect(run.egress.authorizationSeen, 'with the credential blanked, no dial may carry an authorization header').toBe(
      false,
    );
    // The BROWSER half of the guard, read as a relation rather than as a count. Every URL this spec's
    // own route refused is a request that did not leave the machine, so the reading that matters is
    // what is IN that list and not how long it is: a refused LOOPBACK request would mean the guard
    // was pointed the wrong way, and the "refused nothing" above would then be a statement about a
    // guard that could not have fired either way.
    expect(
      run.egress.refused.filter((url) => /^(wss?|https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)),
      `the route must never have refused this run's own server: ${JSON.stringify(run.egress.refused)}`,
    ).toEqual([]);
    // An uncaught exception is the interface failing. A refused request is this spec's own route
    // doing what it was installed for, and a library deprecation notice is what the page always
    // says; neither is asserted on. `warnings` keeps all three verbatim in the artifact instead of
    // filtering them away, so the reading stays checkable by whoever reads it next.
    expect(run.pageErrors, `uncaught page errors: ${JSON.stringify(run.pageErrors)}`).toEqual([]);
  });
});
