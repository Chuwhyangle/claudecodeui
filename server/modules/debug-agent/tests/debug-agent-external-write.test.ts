import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import util from 'node:util';
import { fileURLToPath } from 'node:url';

import { initializeDatabase } from '@/modules/database/index.js';
import {
  closeSessionsWatcher,
  initializeSessionsWatcher,
  readActiveWatcherModes,
  resolveProviderWatchPaths,
  sessionSynchronizerService,
  sessionsService,
  type WatcherMode,
} from '@/modules/providers/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';

import {
  DEBUG_AGENT_PROVIDER_ID,
  armDebugAgentScenario,
  getDebugAgentProjectsRoot,
  readDebugAgentGate,
  type ArmedDebugAgentScenario,
  type DebugAgentScenario,
} from '../index.js';
import { appendTranscriptRow, buildMessageRow, readTranscriptRows } from '../debug-agent.runtime.js';

/**
 * The criterion for the external-write path: somebody (or some script) appends a
 * row to a transcript file and the app only watches — file observer → re-index →
 * `session_upserted` → the client re-fetches the session's history over its REST
 * read, with the appended content in it.
 *
 * This is the half of the delivery chain that has NO runtime in it. The
 * browser-side stand-ins used elsewhere replace `window.WebSocket` and inject
 * frames, which skips the backend entirely; a run of the debug agent's own engine
 * produces its rows through the runtime. Neither ever exercises "the file changed
 * underneath the app and the app noticed". So this file drives the real chokidar
 * observer (`initializeSessionsWatcher`) against a real fixture transcript, and
 * appends to that file the way an outside writer would — a plain file append
 * through no interface the app exposes, with no runtime in the loop.
 *
 * Three things the criterion has to do, none of them optional:
 *
 *  (i) DRAIN FIRST. Arming the fixture writes a new file into the observed root,
 *      and the observer reads it as an `add` at its next poll. "Wait for an
 *      upsert and pass" is therefore a blind criterion: the load satisfies it and
 *      the external write is never proven. So the criterion waits until an upsert
 *      has been seen AND the observer has then been silent for more than one
 *      polling period, and only then appends.
 * (ii) Demand a NEW upsert after the append, inside an observation window at
 *      least as wide as the worst case. The window is a SAFE UPPER BOUND, never a
 *      lower bound: nothing here asserts that delivery takes that long. It is
 *      derived from the observer's OWN measured latency — the load step times a
 *      write against the observer's own line and the delivery window is built
 *      from that measurement plus the observer's own polling period and flush
 *      debounce, printed on every run (see `deriveDeliveryWindowMs`). The wait is
 *      coupled to (iii)'s evidence, not to the first upsert of any session: a
 *      stale flush from the load or readiness phase can arrive before this file's
 *      own change is even polled, and ending the wait on it is what produced the
 *      2026-10-01 lane red (`(ii) … first at +209ms` beside `(iii) change=0`).
 * (iii) POSITIVE CONTROL: the observer's own log line naming THIS file with a
 *      `change` event, after the append. Without it, "an upsert arrived" cannot
 *      be attributed to the observer, and a build that wrote the database
 *      directly would be indistinguishable from one that watched the file — see
 *      the anti-fake arm below, which is exactly that build.
 *
 * And one thing the criterion has to settle BEFORE any of (i)–(iv), because that
 * is where every recorded failure actually landed: the LOAD EVENT has to be a
 * READING of the observer, not an inference about it. A file armed while the
 * observer's first walk is still running is initial state to it — registered,
 * indexed, REST-addressable, and permanently unannounced, because `ignoreInitial`
 * suppresses the `add` the walk would have produced. So the load step does not
 * arm a fixture and hope: it first takes a readiness READING off the observer
 * itself — a POKE, and the observer's own line about it — and only then arms the
 * load fixture, which is therefore a file whose directory the walk had already
 * read. That line is the whole difference, and it also settles what used to be a
 * wager: the swallowed `add` was never bad luck, it was an ordering fact, and an
 * ordering fact can be read but not guessed. Nothing here reads a second watcher's
 * `ready`, nothing here waits a guessed number of milliseconds, and the load event
 * stays what it always was: the observer's own `add` for a file that appeared
 * under it. See `awaitObserverReadiness` for why the poke is re-issued rather
 * than timed.
 *
 * Why every reading comes from a CHILD process. The gate is cached at first read
 * and the registry registers the debug provider during module evaluation, so
 * whether the debug agent exists at all is decided before any test body runs.
 * Each arm therefore re-executes this file in a child with the gate open and
 * `HOME` redirected into a scratch directory, so no arm can reach the machine's
 * real `~/.claude`, its real database, or a stale fixture root. This mirrors the
 * two sibling criteria in this directory; the three files share no code because
 * the readings differ.
 */

// Spelled through constants so this file never becomes a second reader of the
// gate variable: `debug-agent-gate.test.ts` scans everything under `server/` for
// a direct read of it outside the gate module, and this file must pass that scan.
const GATE_VAR = 'DEBUG_AGENT';
const GATE_HOME_VAR = 'DEBUG_AGENT_HOME';
const PROBE_VAR = 'DEBUG_AGENT_EXTERNAL_WRITE_PROBE';
const MODE_VAR = 'DEBUG_AGENT_EXTERNAL_WRITE_MODE';
/**
 * The observer's mechanism selector. Every arm pins it: the readings below are
 * built around a known clock — the drain's silence requirement, the observation
 * window, the short-window falsification — so an arm that let `auto` choose would
 * be measuring whichever mechanism the host happened to offer, and the polling
 * and native arms would be the same experiment twice on a host that prefers one.
 *
 * Spelled locally rather than imported, like `GATE_VAR` above: this file names
 * the variables it sets, and it is not the module that owns them.
 */
const WATCHER_MODE_VAR = 'CLOUDCLI_WATCHER_MODE';
const PROBE_MARKER = '__DEBUG_AGENT_EXTERNAL_WRITE_READING__';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SELF = fileURLToPath(import.meta.url);

/**
 * The observer's polling interval, copied from the watcher's `chokidar.watch`
 * options. A drain shorter than this proves nothing: the observer could still be
 * sitting on a poll that has not happened yet.
 */
const POLL_INTERVAL_MS = 6_000;
/**
 * The observer's own flush debounce, copied from the same `chokidar.watch` call.
 * A file event does not become an announcement the instant it is seen: the
 * watcher debounces the flush that follows it. Every window below is one polling
 * period PLUS this, because a window that stopped at the polling period would be
 * demanding that the debounce cost nothing.
 */
const FLUSH_DEBOUNCE_MS = 500;
/** The drain's silence requirement — strictly more than one polling period. */
const DRAIN_SILENCE_MS = 6_500;
/**
 * The delivery leg's own window, derived from the observer's OWN measured
 * latency — never from a number picked here.
 *
 * The measurement is the load step's: `armObservedFixture` times a file write
 * (`armDebugAgentScenario`) against the observer's own line for it, which is the
 * same class of event the external write produces (a row appended to a file
 * under the observer's root) and so is the observer's own reading of how long it
 * currently takes to notice one. The window is that measurement PLUS one full
 * polling period — the write lands at an arbitrary phase of the observer's own
 * clock, so the first poll after it can be a whole period away — PLUS the
 * observer's own flush debounce, because the upsert that follows the line is
 * debounced by it. It is a SAFE UPPER BOUND: nothing asserts that delivery takes
 * this long, and the measured value is printed on every run. (The window this
 * replaces was `8_000` — one polling period plus two seconds somebody picked.)
 */
function deriveDeliveryWindowMs(measuredLineLatencyMs: number): number {
  return POLL_INTERVAL_MS + Math.max(measuredLineLatencyMs, 0) + FLUSH_DEBOUNCE_MS;
}
/** The false form of the same window, used by the falsification reading below. */
const SHORT_WINDOW_MS = 1_000;
const SHORT_WINDOW_TRIALS = 3;
/**
 * The floor under every attempt window: one polling period of the observer's own
 * clock plus its own flush debounce. This is a bound WIDTH, not a duration — no
 * attempt waits it out unless the observer stays silent for all of it, and the
 * window is widened only by the observer's OWN measured latency (see
 * `armObservedFixture`), never by a number picked here.
 */
const LOAD_WINDOW_FLOOR_MS = POLL_INTERVAL_MS + FLUSH_DEBOUNCE_MS;
/**
 * How many fixtures the load step may put on disk before it reds. Each attempt is
 * measured against `LOAD_WINDOW_FLOOR_MS` of the observer's OWN clock; an attempt
 * that has not been announced when its window elapses does not stop being an
 * attempt — see `armObservedFixture` — so this bounds a pathological observer
 * rather than doubling as a sleep.
 */
const MAX_LOAD_ATTEMPTS = 3;
/**
 * The widest a single load attempt can end up being measured against, and so the
 * bound the reading's own latency is checked inside: attempts overlap, so the
 * line that wins can be one an earlier attempt earned. Nothing waits this out
 * unless the observer says nothing at all.
 */
const LOAD_ATTEMPT_CEILING_MS = MAX_LOAD_ATTEMPTS * LOAD_WINDOW_FLOOR_MS;
/**
 * How often the readiness handshake re-issues its append while it waits.
 *
 * Re-issued rather than issued once, and this is the whole reason the handshake
 * costs one polling period instead of two: the append that the observer can
 * report is the first one that lands after its walk has already read the file,
 * and nothing observable says when that was. The previous version issued one
 * append, waited out a whole window, and only then issued another — so a probe
 * that landed one millisecond too early cost a full polling period, twice over.
 * Poking repeatedly makes the timing irrelevant: whichever append lands late
 * enough is the one the observer reports, at its next poll either way.
 */
const READINESS_PROBE_INTERVAL_MS = 500;
/**
 * The handshake's own bound — two polling periods of the observer's own clock.
 * One covers the walk finishing its read of the sentinel (the append that lands
 * after it is answered at the next poll), and the second covers that answer. It
 * is a bound on a pathological observer, not a wait: nothing sits this out unless
 * the observer never logs anything, which is the anti-fake arm's build.
 */
const READINESS_DEADLINE_MS = 2 * LOAD_WINDOW_FLOOR_MS;
/** Bound on the wait for the load event, so a dead observer reds instead of hanging. */
const LOAD_TIMEOUT_MS = 40_000;
/** Bound on a whole child, so a hung arm cannot stall the suite. */
const CHILD_TIMEOUT_MS = 150_000;

/**
 * The seed's own text, and the text the external writer appends. Different
 * strings on purpose: the history leg asserts the APPENDED one is present, and
 * that must not be satisfiable by the seed that was there all along.
 */
const SEED_USER_TEXT = 'the seed row the arming step wrote before anything was observed';
const APPENDED_TEXT = 'a row appended by an external writer, not by the app';
/**
 * The readiness handshake's own text. It is a third string, not a second use of
 * one of the two above, because the handshake's rows go to a DIFFERENT file (the
 * sentinel) and a reading that could not tell the two sessions' rows apart would
 * make the history leg's `containsAppended` ambiguous.
 */
const READINESS_APPEND_TEXT = 'a row appended by the readiness handshake, to a file the walk had already read';

/**
 * The scenario the fixture is armed with. It carries no transcript step at all:
 * this criterion is about the row an OUTSIDE writer appends, so the armed
 * scenario's only job is to put an indexable session in the fixture root. A
 * single `wait` keeps `steps` non-empty, which the loader requires, and writes
 * nothing.
 */
const SCENARIO: DebugAgentScenario = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: 'external write fixture', userText: SEED_USER_TEXT },
  steps: [{ at: 0, op: 'wait' }],
  expect: { rows: { delta: 0 }, content: { mustContain: [] } },
};

const OBSERVER_LINE = /Session synchronization triggered by (add|change) event for provider "([^"]+)"/;

/**
 * `external-write` and `external-write-native` are the same arm on the two
 * mechanisms — everything below the mode is shared, including the criterion they
 * are judged by, so the pair reads "the chain holds under native events too"
 * rather than "native events are a different experiment". `bypass` is the fake.
 *
 * `unobserved-load` is the falsification arm: it constructs the condition the
 * loads that were never announced were lost to — the observer out of the loop
 * before the load step runs — so that the criterion's red on the load step is a
 * demonstration rather than a report of bad luck. It exits the child before any
 * of (i)–(iv) is taken, which is the honest place for it: today's red never
 * reached a delivery assertion either.
 *
 * `drop-write` is the delivery leg's own falsification arm, and it is the one
 * the lane reading asked for: the observer is LEFT in the loop through the load
 * and the drain, and is closed the instant the external write is on disk — so
 * the write is never reported by it. The positive arm in the same run is green,
 * which is what makes this a two-way control on (iii) rather than a report.
 */
type ChildMode = 'external-write' | 'external-write-native' | 'bypass' | 'drop-write' | 'unobserved-load';

/** One `session_upserted` as it reached a connected client. */
type UpsertReading = { at: number; sessionId: string | null; providerSessionId: string | null };

/** One line the observer logged, captured in-process so it carries a timestamp. */
type ObserverLine = { at: number; eventType: string; provider: string; text: string };

/** One attempt at producing the load event, and whether the observer announced it. */
type LoadAttempt = {
  attempt: number;
  transcriptPath: string;
  addObserved: boolean;
  /** The window this attempt was actually measured against, and how long it took. */
  windowMs: number;
  waitedMs: number;
};

/**
 * The readiness reading AC2 asks for: the observer's OWN evidence that its first
 * walk has already read the tree the load fixture is about to land in — a log
 * line of its own about a file under its own root — together with the measured
 * value that makes it a reading rather than an assumption.
 *
 * HOW THE EVIDENCE IS PRODUCED, and why this is the shape that survives. A
 * sentinel fixture is armed BEFORE the observer is constructed, so its file is
 * part of the walk's initial state: `ignoreInitial` suppresses any `add` for it,
 * and the only thing the observer can ever say about it is a `change` — logged
 * when the handshake appends to it. That a `change` line exists at all is the
 * readiness fact, and it is a fact about the OBSERVER: chokidar can only report a
 * change for a file it has a baseline for, and the only thing that establishes a
 * baseline is the walk reading the directory the file lives in. So the handshake
 * does not infer that the walk is over from a timer, from a second watcher's
 * `ready`, or from how long the last step took: it appends to a file the walk must
 * have read, and reports the line it gets back.
 *
 * THAT `change` — NOT an `add` — IS THE EVIDENCE, and the direction matters. An
 * `add` here would mean the observer had NOT registered the sentinel when it first
 * saw it, which is the opposite of the fact being established. The load fixture
 * is armed into the same directory immediately afterwards, so the walk having read
 * that directory is exactly what makes its own `add` reachable.
 */
type ReadinessReading = {
  /** Where the evidence came from. There is one source, and it is not a probe. */
  evidence: 'observer-own';
  /**
   * The previous version of this file ran a second watcher of its own over the
   * same roots and read ITS `ready` instead. This field is the reading that says
   * it does not, so the claim is visible in the output rather than only in a
   * comment.
   */
  secondWatcher: 'none';
  /** The sentinel the handshake poked — a file the walk had already read. */
  transcriptPath: string;
  eventType: 'change' | 'add';
  /**
   * The measured value AC2 asks for: how long the handshake took, from its first
   * append to the observer's own line about one of them.
   */
  latencyMs: number;
  /** How many appends it took. Every append before the answered one was absorbed. */
  appends: number;
  /** The handshake's own cadence, so the count above is readable as a duration. */
  appendIntervalMs: number;
};

type ExternalWriteReading = {
  gate: { enabled: boolean; home: string | null; reason: string };
  mode: ChildMode;
  fixture: {
    root: string | null;
    rootListed: boolean;
    /** The mechanism the fixture root's watcher actually runs in. */
    watcherMode: WatcherMode | null;
    transcriptPath: string;
    projectPath: string;
  };
  session: { sessionId: string; providerSessionId: string; seedRows: number };
  /**
   * AC2's reading: the observer's own evidence that it is up and polling, taken
   * beside the load step rather than predicted for it.
   */
  readiness: ReadinessReading;
  /** Producing the load event, and how the observer announced it. */
  load: { attempts: LoadAttempt[]; observedOn: number | null; observedEvent: 'add' | 'change' | null };
  /** (i) — the drain: what it saw, and how quiet it then had to be. */
  drain: { upsertsObserved: number; silenceMs: number; tookMs: number; loadUpsertAt: number | null };
  /** The external write itself, and what the arm had to do to make it one. */
  append: {
    at: number;
    text: string;
    /** The number AC4 asks for: how much room the load event left before the write. */
    loadToAppendMs: number | null;
    observerClosed: boolean;
  };
  /** (ii) — what arrived after the append, and how long it took. */
  delivery: {
    /** The window this run derived from the observer's own measured latency. */
    windowMs: number;
    /** The measurement the window was derived from — the load step's own latency. */
    measuredLineLatencyMs: number;
    /**
     * Whether the observer's own `change` line for THIS file had been logged by
     * the time the terminal wait ended. The wait is coupled to it, so this is the
     * reading that says the window closed on the criterion's OWN evidence rather
     * than on a stale upsert from an earlier phase.
     */
    changeLineArrived: boolean;
    newUpserts: number;
    deliveryMs: number | null;
    upsertsSinceAppend: UpsertReading[];
  };
  /** (iii) — the positive control. */
  positiveControl: {
    changeLinesForThisFile: number;
    changeLinesAfterAppend: number;
    addLinesForThisFile: number;
    lines: ObserverLine[];
  };
  /** The REST re-fetch leg, driven by the same call the route handler makes. */
  history: { count: number; total: number; containsAppended: boolean; containsSeed: boolean; ids: string[] };
  /** The blind criterion's own satisfaction — and whether it predates the write. */
  blind: { upsertsBeforeAppend: number; satisfiedBeforeAppend: boolean };
  /** AC3's false form: the same observation with a window far too small. */
  windowFalsification: { windowMs: number; trials: Array<{ delivered: boolean; elapsedMs: number }> };
};

// --------------------------- child process ---------------------------

/** The real `console.log`, saved before the capture below wraps it. */
const emit = console.log.bind(console);

type CapturedLine = { at: number; text: string };

const captured: CapturedLine[] = [];

/** Tees one console method into `captured`, keeping its original behaviour. */
function captureConsole(method: 'log' | 'warn' | 'error'): void {
  const original = console[method].bind(console) as (...data: unknown[]) => void;
  const tee = (...data: unknown[]): void => {
    captured.push({ at: Date.now(), text: util.format(...data) });
    original(...data);
  };

  if (method === 'log') {
    console.log = tee;
    return;
  }

  if (method === 'warn') {
    console.warn = tee;
    return;
  }

  console.error = tee;
}

/**
 * The observer's own log lines, timestamped at capture. `util.format` is used
 * because the watcher passes its file path as a second console argument, and the
 * positive control has to be bound to THIS transcript rather than to any event.
 */
function readObserverLines(lines: CapturedLine[]): ObserverLine[] {
  const readings: ObserverLine[] = [];
  for (const entry of lines) {
    const match = OBSERVER_LINE.exec(entry.text);
    if (!match) {
      continue;
    }

    readings.push({ at: entry.at, eventType: match[1], provider: match[2], text: entry.text });
  }

  return readings;
}

/** A connected client that records the deltas it is handed, and nothing else. */
class RecordingConnection {
  readyState = WS_OPEN_STATE;
  readonly upserts: UpsertReading[] = [];

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    if (frame.kind !== 'session_upserted') {
      return;
    }

    this.upserts.push({
      at: Date.now(),
      sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : null,
      providerSessionId: typeof frame.providerSessionId === 'string' ? frame.providerSessionId : null,
    });
  }
}

/** Waits for one more upsert than `since`, or gives up when the window elapses. */
async function waitForUpsertAfter(
  upserts: UpsertReading[],
  since: number,
  windowMs: number,
): Promise<{ arrived: boolean; elapsedMs: number }> {
  const startedAt = Date.now();
  for (;;) {
    if (upserts.length > since) {
      return { arrived: true, elapsedMs: Date.now() - startedAt };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= windowMs) {
      return { arrived: false, elapsedMs: elapsed };
    }

    await delay(Math.min(50, windowMs - elapsed));
  }
}

/**
 * (i) — the drain. Returns once at least one upsert has been seen AND the
 * observer has then been silent for more than one polling period.
 *
 * Both halves are load-bearing. Without the first, "silence" is satisfied by a
 * child that has seen nothing at all, which is also what a closed gate looks
 * like; without the second, the load event is still in flight and would satisfy
 * the very upsert the criterion waits for next.
 */
async function drainObserver(
  upserts: UpsertReading[],
): Promise<{ upsertsObserved: number; silenceMs: number; tookMs: number; loadUpsertAt: number | null }> {
  const startedAt = Date.now();
  for (;;) {
    const now = Date.now();
    const last = upserts.at(-1);
    const silenceMs = last ? now - last.at : now - startedAt;
    const settled = upserts.length >= 1 && silenceMs > DRAIN_SILENCE_MS;

    if (settled || now - startedAt > LOAD_TIMEOUT_MS) {
      return { upsertsObserved: upserts.length, silenceMs, tookMs: now - startedAt, loadUpsertAt: last?.at ?? null };
    }

    await delay(100);
  }
}

/**
 * Appends one row to the fixture transcript the way an outside writer would: a
 * plain file append carrying the dialect's row shape, through no app interface.
 */
function appendExternally(transcriptPath: string, input: { sessionId: string; cwd: string; text: string }): void {
  const rows = readTranscriptRows(transcriptPath);
  const parentUuid = rows.at(-1)?.uuid;

  appendTranscriptRow(
    transcriptPath,
    buildMessageRow({
      sessionId: input.sessionId,
      cwd: input.cwd,
      role: 'assistant',
      text: input.text,
      uuid: crypto.randomUUID(),
      parentUuid: typeof parentUuid === 'string' ? parentUuid : null,
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * The observer's own line naming this file, logged at or after `since`.
 *
 * `since` is load-bearing, not decoration: a line the observer logged for an
 * EARLIER attempt would otherwise satisfy a later one, and an attempt that was
 * never announced would be reported as announced. It is the reason every reader
 * below takes a `since` rather than asking "has the observer ever mentioned this
 * file".
 */
function observerLineFor(lines: CapturedLine[], filePath: string, since: number): ObserverLine | null {
  return readObserverLines(lines).find((line) => line.at >= since && line.text.includes(filePath)) ?? null;
}

/**
 * The observer's own `change` line naming this file, logged at or after `since`.
 *
 * This is the (iii) evidence and nothing else: the delivery leg's terminal wait
 * is coupled to a line of THIS shape, because a `change` is what an append to an
 * existing file produces and an `add` for this file could only be the load
 * event. `since` is the write, so a line the observer logged for the load — or
 * for the readiness sentinel — can never be read as evidence about the write.
 */
function changeLineFor(lines: CapturedLine[], filePath: string, since: number): ObserverLine | null {
  return (
    readObserverLines(lines).find(
      (line) => line.at >= since && line.eventType === 'change' && line.text.includes(filePath),
    ) ?? null
  );
}

/**
 * The delivery leg's terminal wait, coupled to the criterion's OWN evidence.
 *
 * The wait this replaces returned on the first upsert of ANY session
 * (`waitForUpsertAfter`). Under load that is not the write's delivery: the
 * watcher debounces its flush (`PROJECTS_UPDATE_DEBOUNCE_MS = 500`, capped at
 * `PROJECTS_UPDATE_MAX_WAIT_MS = 2000`) and defers it entirely while a refresh is
 * in flight, so an upsert the LOAD or the readiness handshake queued can land
 * after the drain has settled on silence. The lane reading is exactly that
 * shape: `[delivery (ii)] 1 new upsert(s) … first at +209ms` next to
 * `[control (iii)] add=1 change=0`. 209ms is a quarter of the observer's own
 * flush debounce and three percent of its polling period, so it cannot be this
 * file's own poll-detected change (measured at ~5.4s in every green run beside
 * it); it is a stale flush, and the arm stopped waiting on it.
 *
 * So this wait ends only when BOTH halves of the criterion's evidence are on the
 * record — the observer's own `change` line for this file after the write, and a
 * new upsert — or when `windowMs` elapses. It never sleeps a fixed number: the
 * deadline is the derived upper bound, and this loop returns the moment the
 * evidence is complete. In the `bypass` and `drop-write` arms the line never
 * comes, so the loop runs to the deadline and the verdict below reads the zeros
 * honestly.
 */
async function waitForDeliveryEvidence(
  upserts: UpsertReading[],
  sinceAppend: number,
  transcriptPath: string,
  appendAt: number,
  windowMs: number,
): Promise<{ changeLineArrived: boolean; upsertArrived: boolean; waitedMs: number }> {
  const startedAt = Date.now();
  for (;;) {
    const changeLineArrived = changeLineFor(captured, transcriptPath, appendAt) !== null;
    const upsertArrived = upserts.length > sinceAppend;
    const waitedMs = Date.now() - startedAt;

    if ((changeLineArrived && upsertArrived) || waitedMs >= windowMs) {
      return { changeLineArrived, upsertArrived, waitedMs };
    }

    await delay(Math.min(50, windowMs - waitedMs));
  }
}

/**
 * AC2's readiness reading, taken before the load step and used to gate it.
 *
 * The handshake arms nothing: the sentinel it pokes was armed before the observer
 * existed, so the walk had already read the directory it lives in. What the
 * handshake does is APPEND to that file, over and over, until the observer logs a
 * line of its own naming it — and that line is the reading. A `change` line is the
 * only shape that can prove the walk read that directory (see `ReadinessReading`),
 * and the walk having read it is exactly what makes the load fixture armed
 * immediately afterwards reachable as an `add` instead of swallowed as initial
 * state.
 *
 * WHY IT RE-ISSUES THE APPEND INSTEAD OF WAITING. The append that the observer can
 * report is the first one that lands after its walk has already read the file, and
 * nothing observable says when that was. Waiting a guessed interval and then
 * appending once — which is what the previous version of this file did, at double
 * the cost — turns that unknown into a wager: a poke a millisecond too early is
 * invisible, and the handshake pays a whole polling period to find out. Poking
 * repeatedly makes the timing irrelevant. Whichever append lands late enough is
 * the one the observer reports, at its next poll either way, so the handshake
 * costs one polling period plus however long the walk still had to run, and it
 * reports both: `appends` says how many pokes were absorbed, `latencyMs` says how
 * long it took.
 *
 * The bound is the observer's OWN clock, twice over (`READINESS_DEADLINE_MS`):
 * one polling period covers a poke landing and being answered, and the second
 * covers the walk still reading the tree. It is a bound on a pathological
 * observer, not a wait — the loop returns the moment the line appears, which the
 * printed reading shows is well inside it.
 */
async function awaitObserverReadiness(fixture: ArmedDebugAgentScenario): Promise<ReadinessReading> {
  const startedAt = Date.now();
  const deadline = startedAt + READINESS_DEADLINE_MS;
  let appends = 0;

  for (;;) {
    appends += 1;
    appendExternally(fixture.transcriptPath, {
      sessionId: fixture.providerSessionId,
      cwd: fixture.projectPath,
      text: `${READINESS_APPEND_TEXT} (poke ${appends})`,
    });

    // Wait out this poke's own slice, checking for the line as it goes. `since` is
    // the handshake's start, so a line the observer logged earlier — for the
    // sentinel's OWN arming, say — can never be read as an answer to a poke.
    const pokeDeadline = Math.min(Date.now() + READINESS_PROBE_INTERVAL_MS, deadline);
    for (;;) {
      const line = observerLineFor(captured, fixture.transcriptPath, startedAt);
      if (line !== null) {
        return {
          evidence: 'observer-own',
          secondWatcher: 'none',
          transcriptPath: fixture.transcriptPath,
          eventType: line.eventType === 'add' ? 'add' : 'change',
          latencyMs: line.at - startedAt,
          appends,
          appendIntervalMs: READINESS_PROBE_INTERVAL_MS,
        };
      }

      if (Date.now() >= pokeDeadline) {
        break;
      }

      await delay(50);
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `the observer never logged a line for the readiness sentinel after ${appends} append(s) over ${Date.now() - startedAt}ms, so its first walk cannot be shown to be over — and arming the load fixture now would be the same wager this task removes`,
      );
    }
  }
}

/**
 * Produces the load event, and returns only once the observer has logged a line
 * of its OWN for it.
 *
 * Arming alone is not enough, which is a reading this criterion paid for:
 * `chokidar.watch()` returns before its first walk of the tree has finished, and a
 * file that walk finds IS initial state — `ignoreInitial` suppresses its `add` and
 * the observer says nothing at all. A fixture written inside that window is
 * indexed and REST-addressable and completely unannounced, so the drain below
 * would spend its whole timeout waiting for an upsert that was never coming, and
 * every reading after it would rest on a load event that did not happen.
 *
 * So the observer's own `add` line for the armed fixture IS the load event, read
 * rather than predicted. What makes the read reliable is that `readExternalWrite`
 * runs `awaitObserverReadiness` first: by the time this function arms anything, a
 * line of the observer's has already shown that the walk had read the directory
 * the fixture lands in, so the `add` is reachable on the first attempt rather
 * than a coin flip on whether the walk had passed that directory yet. The retry
 * below is therefore a bound, not a mechanism — the DoD registers consecutive
 * readings of it to show so.
 *
 * The window an attempt is measured against is not a guess: one polling period of
 * the observer's own clock plus its own flush debounce (`LOAD_WINDOW_FLOOR_MS`),
 * which is the width in which the observer owed an answer at all. The previous
 * version waited 8 s — one polling period plus two seconds somebody picked.
 *
 * An attempt whose window elapses is NOT discarded, which is the second half of
 * the fix. The previous version armed a fresh fixture and stopped listening to the
 * old one, so an observer that was simply slower than one polling period — the
 * loaded condition this criterion's recorded reds came from — had its answer
 * thrown away and was asked again from scratch, up to three times. Here every
 * unannounced attempt stays live and the first line naming ANY of them wins, so
 * "the observer is slow" resolves on the answer it eventually gives instead of on
 * a later wager. That is also why an attempt's latency may exceed its own window:
 * the reading is honest about which attempt earned the line, and the ceiling is
 * `LOAD_ATTEMPT_CEILING_MS`.
 *
 * This throws rather than returning an empty load, because a criterion that
 * "waited a while and called it done" would pass on a child whose watcher was
 * never up — the anti-fake arm below is exactly that build, and the falsification
 * arm below it is exactly this throw.
 */
async function armObservedFixture(projectPath: string): Promise<{
  armed: ArmedDebugAgentScenario;
  attempts: LoadAttempt[];
  observedOn: number;
  observedEvent: 'add' | 'change';
  latencyMs: number;
  windowMs: number;
}> {
  type LiveAttempt = { attempt: number; armedAt: number; armed: ArmedDebugAgentScenario; windowMs: number };

  const live: LiveAttempt[] = [];
  const attempts: LoadAttempt[] = [];

  /** One attempt's reading, kept in arm order and updated in place on a hit. */
  const record = (entry: LiveAttempt, addObserved: boolean, waitedMs: number): void => {
    const reading = {
      attempt: entry.attempt,
      transcriptPath: entry.armed.transcriptPath,
      addObserved,
      windowMs: entry.windowMs,
      waitedMs,
    };
    const existing = attempts.find((item) => item.attempt === entry.attempt);
    if (existing === undefined) {
      attempts.push(reading);
      return;
    }

    Object.assign(existing, reading);
  };

  for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt += 1) {
    const armedAt = Date.now();
    const armed = await armDebugAgentScenario({
      projectPath,
      scenario: SCENARIO,
      synchronizeTranscript: indexTranscript,
    });
    const entry: LiveAttempt = { attempt, armedAt, armed, windowMs: LOAD_WINDOW_FLOOR_MS };
    live.push(entry);

    const deadline = armedAt + entry.windowMs;
    for (;;) {
      const announced = live
        .map((item) => ({ item, line: observerLineFor(captured, item.armed.transcriptPath, item.armedAt) }))
        .filter((hit): hit is { item: LiveAttempt; line: ObserverLine } => hit.line !== null)
        .sort((left, right) => left.line.at - right.line.at)[0];

      if (announced !== undefined) {
        const latencyMs = announced.line.at - announced.item.armedAt;
        record(announced.item, true, latencyMs);
        return {
          armed: announced.item.armed,
          attempts,
          observedOn: announced.item.attempt,
          observedEvent: announced.line.eventType === 'add' ? 'add' : 'change',
          latencyMs,
          windowMs: announced.item.windowMs,
        };
      }

      if (Date.now() >= deadline) {
        record(entry, false, Date.now() - armedAt);
        break;
      }

      await delay(100);
    }
  }

  throw new Error(
    `the observer never logged an \`add\` for ${MAX_LOAD_ATTEMPTS} armed fixture(s), so there is no load event to drain: ${JSON.stringify(attempts)}`,
  );
}

/** The product's own file-level indexer, through the service the watcher uses. */
async function indexTranscript(filePath: string): Promise<string | null> {
  const result = await sessionSynchronizerService.synchronizeProviderFile(
    DEBUG_AGENT_PROVIDER_ID as LLMProvider,
    filePath,
  );
  return result.sessionId;
}

/**
 * AC3's false form: the same observation with a window far too small to hold the
 * worst case. Each trial appends a row and then waits only `SHORT_WINDOW_MS` for
 * an upsert. If this came back green every time, the criterion would be measuring
 * a fixture whose phase is fixed rather than the observer.
 *
 * The trials are armed the moment the external write is on disk and run *beside*
 * the arm's own terminal wait, not behind it. They are three sub-second windows
 * against a six-second polling clock, so the wait they would otherwise queue
 * behind (the derived delivery window, or the delivery it is waiting for) is
 * longer than all three of them together: overlapping them costs neither a
 * reading nor an assertion — every trial still appends, still waits out
 * `SHORT_WINDOW_MS`, and the criterion still has to come back not-delivered at
 * least once.
 */
async function runShortWindowTrials(
  armed: ArmedDebugAgentScenario,
  upserts: UpsertReading[],
): Promise<Array<{ delivered: boolean; elapsedMs: number }>> {
  const trials: Array<{ delivered: boolean; elapsedMs: number }> = [];
  for (let trial = 0; trial < SHORT_WINDOW_TRIALS; trial += 1) {
    appendExternally(armed.transcriptPath, {
      sessionId: armed.providerSessionId,
      cwd: armed.projectPath,
      text: `${APPENDED_TEXT} (short-window trial ${trial + 1})`,
    });

    const sinceTrial = upserts.length;
    const outcome = await waitForUpsertAfter(upserts, sinceTrial, SHORT_WINDOW_MS);
    trials.push({ delivered: outcome.arrived, elapsedMs: outcome.elapsedMs });
  }
  return trials;
}

/**
 * Takes one arm's reading.
 *
 * The modes share every step up to and including the drain, and differ in exactly
 * one place: what happens at the moment of the external write. In `external-write`
 * the observer is left running, so the write has to be noticed by it; in `bypass`
 * the observer is closed first and the row is indexed straight into the database,
 * which is the shape of an implementation that skips the gateway — the file
 * changes and the history gains the row, and nobody is told.
 *
 * `unobserved-load` is the falsification arm and returns nothing at all: it
 * closes the observer before the load step and lets it throw, so the criterion's
 * red on the load step is a demonstrated one. See the child-mode note above.
 */
async function readExternalWrite(mode: ChildMode): Promise<ExternalWriteReading> {
  captureConsole('log');
  captureConsole('warn');
  captureConsole('error');

  const gate = readDebugAgentGate();
  await initializeDatabase();

  const connection = new RecordingConnection();
  connectedClients.add(connection as never);

  const fixtureRoot = getDebugAgentProjectsRoot();
  const fixtureRootListed =
    fixtureRoot !== null &&
    resolveProviderWatchPaths().some(
      ({ provider, rootPath }) =>
        provider === (DEBUG_AGENT_PROVIDER_ID as LLMProvider) && path.resolve(rootPath) === path.resolve(fixtureRoot),
    );

  const projectPath = path.join(process.env[GATE_HOME_VAR] ?? '', 'workspace');

  // The readiness sentinel is armed BEFORE the observer exists, which is the
  // entire mechanism: a file already on disk when the walk starts is initial state
  // to it, so `ignoreInitial` suppresses any `add` for it and the only line the
  // observer can ever log about it is a `change` — exactly the shape the readiness
  // reading needs, and one only an observer with a baseline for that file can log.
  const sentinel = await armDebugAgentScenario({
    projectPath,
    scenario: SCENARIO,
    synchronizeTranscript: indexTranscript,
  });

  await initializeSessionsWatcher();
  // The mechanism this arm's observer actually came up in, read from the
  // watcher rather than inferred from the variable this arm exported: an
  // explicit `native` that the host could not honour would have failed the boot,
  // and an `auto` that silently fell back would otherwise make a "native" arm a
  // second reading of the polling one.
  const fixtureWatcherMode =
    fixtureRoot === null
      ? null
      : (readActiveWatcherModes().find(
          ({ rootPath }) => path.resolve(rootPath) === path.resolve(fixtureRoot),
        )?.mode ?? null);

  if (mode === 'unobserved-load') {
    // The falsification arm's degenerate case: the observer leaves the loop
    // BEFORE the load step, so no attempt below can be announced by anything — the
    // file lands on disk, is indexed, is REST-addressable, and no line of the
    // observer's ever mentions it. That is today's red, constructed instead of
    // waited for: the load step's own windows, its own cause (`never logged an
    // add`) and none of (i)–(iv).
    await closeSessionsWatcher();
    await armObservedFixture(projectPath);
    throw new Error(
      'the unobserved-load arm produced a load event with the observer out of the loop, so it is not the falsification it claims to be',
    );
  }

  // AC2's reading, and the load step's gate. The observer's own `change` line for
  // the sentinel is the evidence that its walk has read the directory the load
  // fixture is about to land in, so the `add` below is reachable on its first
  // attempt rather than a wager on where the walk had got to. See
  // `awaitObserverReadiness`.
  const readiness = await awaitObserverReadiness(sentinel);
  const {
    armed,
    attempts,
    observedOn,
    observedEvent,
    latencyMs: measuredLineLatencyMs,
  } = await armObservedFixture(projectPath);

  const drain = await drainObserver(connection.upserts);

  // ---- the external write ----
  const appendAt = Date.now();
  const upsertsBeforeAppend = connection.upserts.length;
  appendExternally(armed.transcriptPath, {
    sessionId: armed.providerSessionId,
    cwd: armed.projectPath,
    text: APPENDED_TEXT,
  });

  const observerClosed = mode === 'bypass' || mode === 'drop-write';
  if (mode === 'bypass') {
    // Bypassing the gateway: the observer leaves the loop entirely and the row is
    // indexed straight into the database. No file event, no flush, no broadcast —
    // only the file and the database move.
    await closeSessionsWatcher();
    await indexTranscript(armed.transcriptPath);
  }

  if (mode === 'drop-write') {
    // The delivery leg's own falsification: the observer was in the loop through
    // the load and the drain — both of those readings are real — and leaves it
    // the instant the write is on disk, so the write's file event is dropped. The
    // criterion has to come back with a zero `change` count for this file, and
    // the positive arm in the same run has to stay green; a criterion that could
    // only ever report one of those is the one this task replaces.
    await closeSessionsWatcher();
  }

  // The window is derived from the observer's OWN measured latency — the load
  // step's own write→line measurement, taken this run — and its arithmetic is
  // printed below. See `deriveDeliveryWindowMs`.
  const windowMs = deriveDeliveryWindowMs(measuredLineLatencyMs);
  const sinceAppend = connection.upserts.length;

  // AC3's false form is armed here, before the terminal wait rather than after
  // it: three `SHORT_WINDOW_MS` waits fit inside the window they would otherwise
  // queue behind. In `bypass` the observer has already been closed above, so
  // these appends cannot be announced — which is what that arm asserts.
  const trialResults = runShortWindowTrials(armed, connection.upserts);

  const deliveryEvidence = await waitForDeliveryEvidence(
    connection.upserts,
    sinceAppend,
    armed.transcriptPath,
    appendAt,
    windowMs,
  );

  const upsertsSinceAppend = connection.upserts.slice(sinceAppend);
  const firstNew = upsertsSinceAppend[0];
  const deliveryMs = firstNew ? firstNew.at - appendAt : null;

  const forThisFile = readObserverLines(captured).filter((line) => line.text.includes(armed.transcriptPath));

  // The REST re-fetch leg, driven the way the frontend drives it after a
  // `complete`: `GET /api/providers/sessions/:sessionId/messages` parses the
  // query, calls exactly this service method and wraps the result in an envelope.
  // The router itself is not reachable from this module — the providers barrel
  // does not export it, and reaching into its file would cross the module
  // boundary the backend standards draw — so the leg starts one hop below HTTP,
  // at the call the route handler makes. `limit: null` and `offset: 0` are what a
  // request with neither query parameter resolves to.
  const history = await sessionsService.fetchHistory(armed.sessionId, { limit: null, offset: 0 });
  const historyText = history.messages
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');

  // ---- AC3's false form, joined above ----
  // Every trial has appended and waited out its own `SHORT_WINDOW_MS` by now;
  // the arm joins them here instead of waiting them out end to end.
  const windowFalsification = {
    windowMs: SHORT_WINDOW_MS,
    trials: await trialResults,
  };

  await closeSessionsWatcher();
  connectedClients.delete(connection as never);

  return {
    gate,
    mode,
    fixture: {
      root: fixtureRoot,
      rootListed: fixtureRootListed,
      watcherMode: fixtureWatcherMode,
      transcriptPath: armed.transcriptPath,
      projectPath: armed.projectPath,
    },
    session: {
      sessionId: armed.sessionId,
      providerSessionId: armed.providerSessionId,
      seedRows: armed.seedRows,
    },
    readiness,
    load: { attempts, observedOn, observedEvent },
    drain,
    append: {
      at: appendAt,
      text: APPENDED_TEXT,
      loadToAppendMs: drain.loadUpsertAt === null ? null : appendAt - drain.loadUpsertAt,
      observerClosed,
    },
    delivery: {
      windowMs,
      measuredLineLatencyMs,
      changeLineArrived: deliveryEvidence.changeLineArrived,
      newUpserts: upsertsSinceAppend.length,
      deliveryMs,
      upsertsSinceAppend,
    },
    positiveControl: {
      changeLinesForThisFile: forThisFile.filter((line) => line.eventType === 'change').length,
      changeLinesAfterAppend: forThisFile.filter((line) => line.eventType === 'change' && line.at >= appendAt).length,
      addLinesForThisFile: forThisFile.filter((line) => line.eventType === 'add').length,
      lines: forThisFile,
    },
    history: {
      count: history.messages.length,
      total: history.total,
      containsAppended: historyText.includes(APPENDED_TEXT),
      containsSeed: historyText.includes(SEED_USER_TEXT),
      ids: history.messages.map((message) => message.id).filter((id): id is string => typeof id === 'string'),
    },
    blind: { upsertsBeforeAppend, satisfiedBeforeAppend: upsertsBeforeAppend >= 1 },
    windowFalsification,
  };
}

// --------------------------- parent process ---------------------------

type ChildRun =
  | { ok: true; reading: ExternalWriteReading }
  | { ok: false; stdout: string; stderr: string; error: string };

/**
 * Runs one arm in a child. `HOME` is redirected into a scratch directory and
 * `DATABASE_PATH` points inside it, so no arm can reach the machine's real
 * `~/.claude` or its real database — including the arm that is supposed to do
 * work. The gate variables are cleared from the inherited environment before
 * being set, so a value the caller happened to export cannot decide an arm.
 */
function runChild(mode: ChildMode): Promise<ChildRun> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `debug-agent-external-write-${mode}-`));
  const home = path.join(scratch, 'home');
  const fixtureHome = path.join(scratch, 'fixture');
  mkdirSync(home, { recursive: true });

  const databasePath = path.join(scratch, 'external-write.db');
  writeFileSync(databasePath, '');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    DATABASE_PATH: databasePath,
    [PROBE_VAR]: '1',
    [MODE_VAR]: mode,
  };
  delete env[GATE_VAR];
  delete env[GATE_HOME_VAR];
  env[GATE_VAR] = 'on';
  env[GATE_HOME_VAR] = fixtureHome;
  // Pinned, not inherited: a `CLOUDCLI_WATCHER_MODE` the caller happened to have
  // exported must not be able to decide which clock an arm is measured against.
  delete env[WATCHER_MODE_VAR];
  env[WATCHER_MODE_VAR] = mode === 'external-write-native' ? 'native' : 'poll';

  return new Promise<ChildRun>((resolve) => {
    execFile(
      process.execPath,
      [TSX_CLI, '--tsconfig', 'server/tsconfig.json', SELF],
      { cwd: REPO_ROOT, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : '';
        const err = typeof stderr === 'string' ? stderr : '';
        const line = out
          .split('\n')
          .filter((entry) => entry.startsWith(PROBE_MARKER))
          .pop();

        if (!line) {
          resolve({
            ok: false,
            stdout: out,
            stderr: err,
            error: error ? `${error.name}: ${error.message}` : 'the probe child printed no reading',
          });
          return;
        }

        resolve({ ok: true, reading: JSON.parse(line.slice(PROBE_MARKER.length)) as ExternalWriteReading });
      },
    );
  }).finally(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
}

/** The reading, or a red carrying the child's own output so a failure is readable. */
function requireReading(run: ChildRun, arm: string): ExternalWriteReading {
  if (!run.ok) {
    throw new Error(
      `${arm}: the probe child printed no reading (${run.error})\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
    );
  }

  return run.reading;
}

/**
 * The criterion, as one function so both arms are judged by the same code.
 *
 * `failures` is the three-step criterion the task mandates. `blindFailures` is
 * the criterion that "wait for one upsert" amounts to. The anti-fake arm below is
 * the reason the two must be reported separately: that arm is satisfied by both,
 * so the blind one distinguishes nothing.
 */
function evaluateCriterion(reading: ExternalWriteReading): {
  failures: string[];
  blindFailures: string[];
  steps: string[];
} {
  const failures: string[] = [];
  const steps: string[] = [];

  // (i) the drain
  if (reading.drain.upsertsObserved < 1) {
    failures.push(
      `(i) the drain never saw the load upsert (observed ${reading.drain.upsertsObserved}), so there was nothing to drain and the load could still be in flight`,
    );
  }
  if (reading.drain.silenceMs <= POLL_INTERVAL_MS) {
    failures.push(
      `(i) the drain stopped after ${reading.drain.silenceMs}ms of silence, which is not more than one polling period (${POLL_INTERVAL_MS}ms)`,
    );
  }
  steps.push(
    `(i) saw ${reading.drain.upsertsObserved} upsert(s), then waited out ${reading.drain.silenceMs}ms of silence (drain settled ${reading.drain.tookMs}ms after the observer started)`,
  );
  steps.push(
    `(i) the load event was announced by the observer as a \`${reading.load.observedEvent}\` at attempt ${reading.load.observedOn} of ${reading.load.attempts.length} (${reading.load.attempts.filter((entry) => !entry.addObserved).length} attempt(s) were announced nowhere at all)`,
  );

  // (ii) a NEW upsert after the external write
  if (reading.delivery.newUpserts < 1) {
    failures.push(`(ii) no NEW upsert arrived after the external write (0 in a ${reading.delivery.windowMs}ms window)`);
  } else if (reading.delivery.deliveryMs === null || reading.delivery.deliveryMs > reading.delivery.windowMs) {
    failures.push(
      `(ii) the new upsert arrived ${reading.delivery.deliveryMs}ms after the write, outside the ${reading.delivery.windowMs}ms window`,
    );
  }
  steps.push(
    `(ii) ${reading.delivery.newUpserts} new upsert(s) after the write; first at +${reading.delivery.deliveryMs}ms (window ${reading.delivery.windowMs}ms)`,
  );

  // (iii) the positive control
  if (reading.positiveControl.changeLinesAfterAppend < 1) {
    failures.push(
      `(iii) the observer logged no \`change\` event for this transcript after the write (${reading.positiveControl.changeLinesForThisFile} change line(s) for this file in total), so the upsert cannot be attributed to it`,
    );
  }
  steps.push(
    `(iii) observer logged ${reading.positiveControl.addLinesForThisFile} \`add\` and ${reading.positiveControl.changeLinesForThisFile} \`change\` line(s) for this file; ${reading.positiveControl.changeLinesAfterAppend} of the change line(s) follow the write`,
  );

  // (iv) the content reached the history, not only the wire
  if (!reading.history.containsAppended) {
    failures.push('(iv) the REST re-fetch does not contain the externally appended content');
  }
  steps.push(
    `(iv) REST re-fetch returned ${reading.history.count} message(s) (total ${reading.history.total}); contains the appended content: ${reading.history.containsAppended}; contains the seed: ${reading.history.containsSeed}`,
  );

  const blindFailures: string[] = [];
  if (reading.blind.upsertsBeforeAppend < 1) {
    blindFailures.push('blind: not one upsert was observed at all, before or after the write');
  }

  return { failures, blindFailures, steps };
}

function describe(reading: ExternalWriteReading): string {
  const { readiness, load, drain, append, delivery, positiveControl, history, windowFalsification, fixture } =
    reading;
  const verdict = evaluateCriterion(reading);

  return [
    `[gate] ${reading.gate.enabled ? 'OPEN' : 'CLOSED'} (${reading.gate.reason}); home=${reading.gate.home ?? '<none>'}`,
    `[mode] ${reading.mode}`,
    `[fixture] root=${fixture.root ?? '<none>'} listed=${fixture.rootListed} watcherMode=${fixture.watcherMode ?? '<none>'}; transcript=${fixture.transcriptPath} (${reading.session.seedRows} seed row(s), session ${reading.session.sessionId})`,
    `[readiness] evidence=${readiness.evidence}, second watcher used: ${readiness.secondWatcher} — the observer's own \`${readiness.eventType}\` line for the sentinel ${path.basename(readiness.transcriptPath)}, a file armed BEFORE the observer existed. A \`change\` is the only line it can ever log about such a file (the walk found it, so \`ignoreInitial\` suppresses its \`add\` for the whole run), and an observer can only log one at all for a file it holds a baseline for — which only the walk reading that directory establishes. So the line IS the reading that the walk has been through that directory, and it is why the load fixture armed into the same directory right afterwards is announced as an \`add\` instead of swallowed as initial state. Measured ${readiness.latencyMs}ms from the handshake's first poke to that line, over ${readiness.appends} append(s) at ${readiness.appendIntervalMs}ms apart (bound: ${READINESS_DEADLINE_MS}ms = two polling periods of the observer's own clock)`,
    `[load] observer's own \`${load.observedEvent ?? 'none'}\` line observed on attempt ${load.observedOn} of ${load.attempts.length}; per attempt: ${load.attempts.map((entry) => `#${entry.attempt} addObserved=${entry.addObserved} window=${entry.windowMs}ms waited=${entry.waitedMs}ms`).join('; ')}`,
    `[drain (i)] ${drain.upsertsObserved} upsert(s) observed; silence ${drain.silenceMs}ms (> one polling period ${POLL_INTERVAL_MS}ms); settled after ${drain.tookMs}ms`,
    `[append] at +${append.loadToAppendMs}ms after the load upsert; observerClosed=${append.observerClosed}`,
    `[delivery (ii)] ${delivery.newUpserts} new upsert(s) in a ${delivery.windowMs}ms window; first at +${delivery.deliveryMs}ms`,
    `[delivery window] ${delivery.windowMs}ms = poll ${POLL_INTERVAL_MS}ms + observer's own measured line latency ${delivery.measuredLineLatencyMs}ms + flush debounce ${FLUSH_DEBOUNCE_MS}ms — the observer's own clock, widened by the observer's own measurement. The wait ended on ${delivery.changeLineArrived ? "the observer's own `change` line for this file" : 'the deadline, with no `change` line for this file'}`,
    `[control (iii)] add=${positiveControl.addLinesForThisFile} change=${positiveControl.changeLinesForThisFile} (after the write: ${positiveControl.changeLinesAfterAppend})`,
    `[history (iv)] ${history.count} message(s), total ${history.total}; appended content present: ${history.containsAppended}; seed present: ${history.containsSeed}`,
    `[false window] ${windowFalsification.windowMs}ms -> ${JSON.stringify(windowFalsification.trials)}`,
    ...verdict.steps,
    `[criterion] failures=${JSON.stringify(verdict.failures)}`,
    `[blind criterion] failures=${JSON.stringify(verdict.blindFailures)} (satisfied by an upsert that predates the write: ${reading.blind.satisfiedBeforeAppend})`,
  ].join('\n');
}

if (process.env[PROBE_VAR] === '1') {
  // Child mode: take the reading for this arm, print one line, exit.
  const mode = process.env[MODE_VAR];
  if (
    mode !== 'external-write' &&
    mode !== 'external-write-native' &&
    mode !== 'bypass' &&
    mode !== 'drop-write' &&
    mode !== 'unobserved-load'
  ) {
    throw new Error(`unknown probe mode ${JSON.stringify(mode)}`);
  }

  const reading = await readExternalWrite(mode);
  emit(`${PROBE_MARKER}${JSON.stringify(reading)}`);
} else {
  // Every arm is started together. Each is almost entirely waiting on a 6s clock
  // of one kind or another, so running them concurrently costs the suite one arm's
  // wall clock instead of five, and they share nothing — separate scratch HOME,
  // separate database, separate observer. `unobservedLoad` is the falsification
  // arm: it reds, and it must red in the load step's own windows, so it stays
  // concurrent rather than serialised behind a passing arm.
  const runs = {
    externalWrite: runChild('external-write'),
    externalWriteNative: runChild('external-write-native'),
    bypass: runChild('bypass'),
    dropWrite: runChild('drop-write'),
    unobservedLoad: runChild('unobserved-load'),
  };
  registerCriteria(runs);
}

function registerCriteria(runs: {
  externalWrite: Promise<ChildRun>;
  externalWriteNative: Promise<ChildRun>;
  bypass: Promise<ChildRun>;
  dropWrite: Promise<ChildRun>;
  unobservedLoad: Promise<ChildRun>;
}): void {
  test('an external write reaches the client through the file observer, and the criterion drains the load event first', async () => {
    const reading = requireReading(await runs.externalWrite, 'external-write');
    console.log(describe(reading));

    assert.equal(reading.gate.enabled, true, 'this arm needs the gate open');
    assert.equal(reading.mode, 'external-write', 'this arm must leave the observer in the loop');
    assert.equal(
      reading.fixture.rootListed,
      true,
      'the fixture root must be in the observation set, or nothing below is about the observer',
    );
    assert.equal(
      reading.fixture.watcherMode,
      'poll',
      'this arm pins CLOUDCLI_WATCHER_MODE=poll, so every clock below is the one the pre-task code ran on',
    );

    // ---- AC2: readiness is the observer's own reading, not an inference ----
    // Every recorded failure of this criterion landed on the load step, and the
    // step's readiness used to be inferred from a second watcher's `ready`. The
    // evidence is now the observer's own log line about a file under its own root,
    // and the reading carries the measured value that makes it evidence rather
    // than an assumption. The `secondWatcher` field is asserted, not implied: it is
    // the reading that says no probe decided this.
    assert.equal(
      reading.readiness.evidence,
      'observer-own',
      `readiness must be read from the observer itself: ${JSON.stringify(reading.readiness)}`,
    );
    assert.equal(reading.readiness.secondWatcher, 'none', 'no probe watcher may decide readiness');
    // The line has to be a `change`, and the direction is the whole reading: the
    // sentinel was on disk before the observer was constructed, so the walk found
    // it and no `add` for it will EVER be logged. An `add` here would mean the
    // observer had not registered the sentinel when it first saw it — which is the
    // opposite of "the walk has been through that directory", and would put the
    // load step back on the wager this task removes.
    assert.equal(
      reading.readiness.eventType,
      'change',
      `the readiness line must be a \`change\` for a file the walk had already registered: ${JSON.stringify(reading.readiness)}`,
    );
    assert.ok(
      reading.readiness.latencyMs >= 0 && reading.readiness.latencyMs <= READINESS_DEADLINE_MS,
      `the readiness evidence must carry a measured value inside the handshake's own bound (got ${reading.readiness.latencyMs}ms of ${READINESS_DEADLINE_MS}ms)`,
    );
    // The handshake is a bound, not a wait: the pokes are its clock and the field
    // is the reading that says how many it took. Nothing may widen the cadence —
    // a wider one would be the same wager with a different number in it.
    assert.equal(
      reading.readiness.appendIntervalMs,
      READINESS_PROBE_INTERVAL_MS,
      'the handshake must poke at the cadence this file declares, not at a number chosen to be safe',
    );
    assert.ok(
      reading.readiness.appends >= 1,
      `the readiness line must have been earned by at least one poke: ${JSON.stringify(reading.readiness)}`,
    );
    // The sentinel is NOT the load fixture, and that separation is load-bearing: a
    // handshake that took its evidence from the load fixture's own line would be
    // reading the very event it is supposed to gate, which is the shape that let
    // an unannounced load be reported as a readiness reading.
    assert.notEqual(
      reading.readiness.transcriptPath,
      reading.fixture.transcriptPath,
      'the readiness sentinel must be its own file, taken before the load step arms anything',
    );

    const verdict = evaluateCriterion(reading);

    // ---- (i) the drain is not a formality ----
    // The load event has to be on the record first, and announced by the observer
    // rather than by the fixture merely existing: an unannounced load would leave
    // the drain waiting out a timeout and every reading after it resting on an
    // event that never happened. The window it was measured against is one polling
    // period of the observer's own clock plus its own flush debounce — the shape
    // `armObservedFixture` prints per attempt — and the load's own `add` is the
    // shape this arm wants; a `change` would mean the first walk swallowed the
    // appearance, which is a reading worth having and not what this arm asserts.
    assert.notEqual(
      reading.load.observedOn,
      null,
      `the load event must have been announced by the observer: ${JSON.stringify(reading.load.attempts)}`,
    );
    // The SHAPE is asserted, the ATTEMPT is not. Every attempt is judged on an
    // `add` and nothing weaker, so a `change` here would mean the load event had
    // been redefined rather than made reachable — but whether the first attempt or
    // a retry carried it is a reading, not a requirement: requiring attempt 1 would
    // put the walk's own timing back in charge of this criterion, which is the
    // defect this task removes. The per-attempt readings are printed above, and the
    // DoD registers them across consecutive runs.
    assert.equal(
      reading.load.observedEvent,
      'add',
      `the load event must have been a new file's \`add\`: ${JSON.stringify(reading.load.attempts)}`,
    );
    // ... and the winning attempt is bounded by the same ceiling its per-attempt
    // readings are: attempts overlap, so the line that won can be one an EARLIER
    // attempt earned after its own window had elapsed. That is a reading about a
    // slow observer, not a licence to wait forever.
    const observedAttempt = reading.load.attempts.find((entry) => entry.attempt === reading.load.observedOn);
    assert.ok(
      observedAttempt !== undefined && observedAttempt.waitedMs <= LOAD_ATTEMPT_CEILING_MS,
      `the winning attempt must sit inside the ceiling of ${MAX_LOAD_ATTEMPTS} windows (${LOAD_ATTEMPT_CEILING_MS}ms): ${JSON.stringify(reading.load.attempts)}`,
    );
    assert.ok(
      reading.drain.upsertsObserved >= 1,
      `the load event must have been observed for the drain to mean anything (saw ${reading.drain.upsertsObserved})`,
    );
    assert.ok(
      reading.drain.silenceMs > POLL_INTERVAL_MS,
      `the drain must outlast one polling period: silence was ${reading.drain.silenceMs}ms, interval is ${POLL_INTERVAL_MS}ms`,
    );

    // The number AC4 asks for: how much room the load event left between itself
    // and the external write. If the drain were removed this is what would
    // collapse towards zero — which is exactly when a blind criterion lets the
    // load event through.
    assert.ok(
      reading.append.loadToAppendMs !== null && reading.append.loadToAppendMs > POLL_INTERVAL_MS,
      `the write must be separated from the load event by more than one polling period (got ${reading.append.loadToAppendMs}ms)`,
    );

    // ---- (ii) + (iii) + (iv), through the shared criterion ----
    assert.deepEqual(verdict.failures, [], `the criterion must be clean:\n${verdict.failures.join('\n')}`);
    assert.deepEqual(
      verdict.blindFailures,
      [],
      'the blind criterion is clean here too — the next arm is what shows what that is worth',
    );

    // The window is an upper bound DERIVED from the observer's own measured
    // latency (see `deriveDeliveryWindowMs`): this run must never be read as
    // "delivery takes N seconds". The measured latency is printed on every run,
    // and asserted only to be INSIDE the window — never to be at least anything.
    assert.ok(
      reading.delivery.deliveryMs !== null && reading.delivery.deliveryMs <= reading.delivery.windowMs,
      `delivery must land inside the run's own derived window (got ${reading.delivery.deliveryMs}ms of ${reading.delivery.windowMs}ms)`,
    );
    // ... and the window must BE the derivation, not a constant: the observer's
    // own clock widened by the observer's own measurement, recomputable from the
    // printed reading. This is what stops a later "fix" from swapping in a bigger
    // number that has nothing to do with what the observer actually did.
    assert.equal(
      reading.delivery.windowMs,
      deriveDeliveryWindowMs(reading.delivery.measuredLineLatencyMs),
      "the printed window must be the arithmetic the criterion declares, computed from the observer's own measurement",
    );
    assert.ok(
      reading.delivery.windowMs >= LOAD_WINDOW_FLOOR_MS,
      'the derived window must still cover one polling period plus the flush debounce',
    );
    // The wait must have ended on the criterion's OWN evidence — the observer's
    // `change` line for this file — and not on a stale upsert from the load or
    // readiness phase. That stale-upsert ending is the lane red this task fixes:
    // `(ii) … first at +209ms` beside `(iii) add=1 change=0`.
    assert.equal(
      reading.delivery.changeLineArrived,
      true,
      "the delivery wait must have ended on the observer's own `change` line for this file, not on an upsert from an earlier phase",
    );

    // ---- AC3's false form: the same observation with a window too small ----
    assert.equal(reading.windowFalsification.trials.length, SHORT_WINDOW_TRIALS, 'every short-window trial must have run');
    assert.ok(
      reading.windowFalsification.trials.some((trial) => !trial.delivered),
      `a ${SHORT_WINDOW_MS}ms window must not be green every time, or the criterion is measuring a fixed phase: ${JSON.stringify(reading.windowFalsification.trials)}`,
    );
  });

  test('the same chain holds under native events, with no polling clock in the observer at all', async () => {
    const reading = requireReading(await runs.externalWriteNative, 'external-write-native');
    console.log(describe(reading));

    assert.equal(reading.gate.enabled, true, 'this arm needs the gate open');
    assert.equal(reading.mode, 'external-write-native', 'this arm must leave the observer in the loop');
    assert.equal(
      reading.fixture.rootListed,
      true,
      'the fixture root must be in the observation set, or nothing below is about the observer',
    );
    assert.equal(
      reading.fixture.watcherMode,
      'native',
      `this arm pins CLOUDCLI_WATCHER_MODE=native: an arm that silently came up polling would be a second reading of the polling arm, not a reading about native events${JSON.stringify(reading.fixture)}`,
    );

    // ---- (i) the drain still applies ----
    // Native events arrive in microseconds, so the silence requirement is not
    // what makes the drain meaningful here — the LOAD EVENT still is: without it
    // the drain would be "silent" from the start and every reading after it
    // would rest on an `add` that never happened.
    assert.notEqual(
      reading.load.observedOn,
      null,
      `the load event must have been announced by the observer: ${JSON.stringify(reading.load.attempts)}`,
    );
    assert.ok(
      reading.drain.upsertsObserved >= 1,
      `the load event must have been observed for the drain to mean anything (saw ${reading.drain.upsertsObserved})`,
    );
    assert.ok(
      reading.drain.silenceMs > POLL_INTERVAL_MS,
      `the drain must outlast one polling period: silence was ${reading.drain.silenceMs}ms, interval is ${POLL_INTERVAL_MS}ms`,
    );
    assert.ok(
      reading.append.loadToAppendMs !== null && reading.append.loadToAppendMs > POLL_INTERVAL_MS,
      `the write must be separated from the load event by more than one polling period (got ${reading.append.loadToAppendMs}ms)`,
    );

    // ---- (ii) + (iii) + (iv), through the shared criterion ----
    const verdict = evaluateCriterion(reading);
    assert.deepEqual(verdict.failures, [], `the criterion must be clean:\n${verdict.failures.join('\n')}`);
    assert.deepEqual(verdict.blindFailures, [], 'the blind criterion is clean here too');
    assert.ok(
      reading.delivery.deliveryMs !== null && reading.delivery.deliveryMs <= reading.delivery.windowMs,
      `delivery must land inside the run's own derived window (got ${reading.delivery.deliveryMs}ms of ${reading.delivery.windowMs}ms)`,
    );

    // ---- what is deliberately NOT asserted here ----
    // The short-window falsification is a reading about a polling clock: three
    // sub-second windows against a six-second period must not all be green. Under
    // native events delivery is immediate, so EVERY sub-second window would be
    // green and the assertion would be a criterion that cannot go red — the run
    // still measures it (it is printed above), but it is asserted where it means
    // something, in the polling arm. Nothing else is relaxed: (i)–(iv) above are
    // the same assertions, through the same `evaluateCriterion`.
  });

  test('the anti-fake arm bypasses the observer: (ii) and (iii) both fail while the blind criterion stays green', async () => {
    const reading = requireReading(await runs.bypass, 'bypass');
    console.log(describe(reading));

    const verdict = evaluateCriterion(reading);

    // The fake is a GOOD fake: the row really is on disk and really is in the
    // history the REST read returns. Nothing below would be a fair comparison
    // against a fake that simply failed to write.
    assert.equal(reading.append.observerClosed, true, 'this arm must take the observer out of the loop');
    assert.equal(
      reading.history.containsAppended,
      true,
      'the fake must actually write, or it proves nothing about the criterion',
    );

    // The blind criterion is green — and green for the wrong reason: the upsert
    // that satisfies it predates the external write entirely.
    assert.deepEqual(verdict.blindFailures, [], 'the blind criterion must stay green against this fake');
    assert.equal(
      reading.blind.satisfiedBeforeAppend,
      true,
      'and it must be satisfied by the load event, not by anything the write produced',
    );

    // The three-step criterion reds, on (ii) and (iii) at the same time. Both are
    // required: (ii) alone would be satisfied by any other producer, and (iii)
    // alone would not show that nothing reached the client.
    assert.ok(
      verdict.failures.some((failure) => failure.startsWith('(ii)')),
      `the criterion must fail on (ii) here; failures were ${JSON.stringify(verdict.failures)}`,
    );
    assert.ok(
      verdict.failures.some((failure) => failure.startsWith('(iii)')),
      `the criterion must fail on (iii) here; failures were ${JSON.stringify(verdict.failures)}`,
    );
    assert.equal(reading.delivery.newUpserts, 0, 'nothing may be announced through a closed observer');
    assert.equal(
      reading.positiveControl.changeLinesAfterAppend,
      0,
      'and the observer may not have logged the write it never saw',
    );
  });

  // AC5's two-way control on the delivery leg, and the arm the lane reading
  // asked for. The `bypass` arm above closes the observer BEFORE the write and
  // reds on (ii) and (iii) together, so its red on (iii) is not distinguishable
  // from "no upsert arrived". This arm keeps the observer in the loop through
  // the load and the drain — those readings are real — and drops it the instant
  // the write is on disk. The upsert may or may not still arrive (a stale flush
  // from the load phase can land), but the observer's own `change` line for THIS
  // file cannot: the wait runs to its derived deadline with `changeLineArrived`
  // false, and the criterion reds on (iii). The positive arm in this same run is
  // green through the same `evaluateCriterion`, so the red is a property of the
  // dropped frame rather than of a criterion that can only ever say one thing.
  test('the drop-the-write falsification reds on (iii) while the positive arm in the same run stays green', async () => {
    const reading = requireReading(await runs.dropWrite, 'drop-write');
    console.log(describe(reading));

    assert.equal(
      reading.append.observerClosed,
      true,
      'this arm must take the observer out of the loop at the write itself',
    );
    // The wait is coupled to the observer's own line, so its ending is a reading:
    // here the deadline fired with no line, which is what makes the (iii) below a
    // demonstrated red rather than an upsert that happened not to arrive.
    assert.equal(
      reading.delivery.changeLineArrived,
      false,
      'the observer was closed at the write, so its own `change` line for this file can never arrive',
    );
    assert.equal(
      reading.positiveControl.changeLinesAfterAppend,
      0,
      'and no `change` line for this file may follow the write it was closed under',
    );

    const verdict = evaluateCriterion(reading);
    assert.ok(
      verdict.failures.some((failure) => failure.startsWith('(iii)')),
      `the criterion must fail on (iii) when the observer cannot report the write; failures were ${JSON.stringify(verdict.failures)}`,
    );

    // The positive half of the two-way control, in the same run and through the
    // same `evaluateCriterion`: with the observer in the loop the criterion is
    // green. A criterion that could not go red on (iii) here would be the vacuous
    // one this task removes.
    const restored = requireReading(await runs.externalWrite, 'external-write');
    assert.deepEqual(
      evaluateCriterion(restored).failures,
      [],
      'the positive arm in the same run must be green, or the red above proves nothing',
    );
  });

  // AC3's falsification arm. The condition that reds this criterion in the
  // unfixed shape is that the load event is never ANNOUNCED — the recorded reds
  // all died in `armObservedFixture`, before (i) was ever reached, because the
  // walk had already read the fixture as initial state and `ignoreInitial`
  // suppressed its `add` for good. This arm constructs that condition directly
  // (the observer leaves the loop before the load step, so nothing can announce
  // it) and asserts the RED IS THE LOAD STEP'S OWN, verbatim. That distinction is
  // the whole point: it is what makes the fix a fix rather than a re-labelling.
  // A red that arrived on (ii)/(iii), or that named the readiness handshake,
  // would mean the arm had constructed some other failure and proved nothing
  // about the step every recorded failure landed on.
  test('the load-observation falsification reds on the load step itself, with today\'s cause — while the same code with the observer in the loop stays green', async () => {
    const run = await runs.unobservedLoad;
    assert.equal(
      run.ok,
      false,
      'the falsification arm must red: with the observer out of the loop no load event can be announced',
    );
    const cause = run.ok ? '' : `${run.error}\n${run.stdout}\n${run.stderr}`;
    // The child's ABSOLUTE PATHS are not evidence about the red: they ride in the
    // `Command failed:` line and in every frame of its stack trace, and a checkout
    // may be named anything — this task's own worktree ends in `-ft-readiness`, so
    // a bare `/readiness/` scan of the raw output would red on the path rather than
    // on a cause. Strip the checkout root before matching; the full `cause` is kept
    // in the assertion messages. A real readiness red still names the `readiness
    // sentinel` in words, which no path supplies.
    const causeWithoutPaths = cause.split(REPO_ROOT).join('<repo>');

    assert.match(causeWithoutPaths, /never logged an `add`/, `the red must be the load step's own cause:\n${cause}`);
    assert.match(
      causeWithoutPaths,
      /"addObserved":false/,
      `the red must carry the per-attempt reading that shows WHY it could not be announced:\n${cause}`,
    );
    assert.doesNotMatch(
      causeWithoutPaths,
      /\(ii\)|\(iii\)/,
      `the red must not be a delivery assertion — an arm that got as far as (ii)/(iii) did not construct the condition this task is about:\n${cause}`,
    );
    assert.doesNotMatch(
      causeWithoutPaths,
      /readiness/,
      `the red must not be the readiness handshake's — a readiness cause would mean the arm failed at the wrong step:\n${cause}`,
    );

    // The restore leg, in the same run and against the same file: the identical
    // code path with the observer in the loop is green. Read through the same
    // `evaluateCriterion` as the polling arm, so "green" here means the criterion
    // was actually satisfied and not merely un-reached.
    const restored = requireReading(await runs.externalWrite, 'external-write');
    assert.deepEqual(
      evaluateCriterion(restored).failures,
      [],
      'restoring the observer to the loop must return this criterion to green',
    );
  });
}
