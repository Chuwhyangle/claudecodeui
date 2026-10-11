/**
 * B3 — closing-safety mechanisms, at the state-machine level. Zero paid upstream calls: everything
 * here is driven by the SPEC's reference machine (`../state-machine/turn-state-machine.mts`) and
 * synthetic fixtures. Nothing in this file has a transport, so nothing it does can reach a real
 * Claude Code session — every "apply" lands in an in-memory dry-run sink that records
 * `deliveredToRealSession: false`.
 *
 * WHY THREE MECHANISMS AND NOT ONE. B2 showed the segmentation injury is real but *recoverable in
 * principle*: a false cut is not itself the harm, it is the harm only if the pipeline COMMITS on it.
 * Three things have to hold for a false cut to be undone:
 *
 *   (a) AudioWindowMerger — when the speaker resumes and the split turn must be re-joined, the two
 *       audio windows must be stitched back at their ORIGINAL timeline offsets, so the re-joined
 *       stream is byte-identical to the un-split stream. Concatenation would quietly shift every
 *       later sample earlier and silently destroy the timing any downstream timestamp relies on.
 *   (b) VersionedToolCallGate — a tool call generated for a turn that has since been superseded must
 *       be discarded BY VERSION. This is the concrete instance of the machine's `turnVersion`
 *       monotonicity: a late frame, a retransmit, or a stale timer must be voided, never blindly run.
 *   (c) ActionCommitGate — no side effect may be released until the versioned result is FINALIZED.
 *       Staging is free; applying is what costs. The gate releases a staged call only when its
 *       version is the live one at finalize time.
 *
 * THE MEASUREMENT. `runRecoveryScenario` drives the SPEC machine through the 「改成三十秒……不对，二十秒」
 * self-correction and asks one question per scenario: did the CORRECTED call commit, and did the
 * SUPERSEDED call NOT commit? The recovery success rate is the fraction that answer yes. Two
 * controls make the number legible rather than flattering: a NAIVE gate (apply-on-arrival) that
 * scores 0, and an out-of-scope arm where the correction arrives AFTER the grace window expired —
 * a structurally unrecoverable case, reported separately so it is never averaged into the gate's
 * own score.
 *
 * Run (writes the b3 section):  npx tsx --tsconfig server/tsconfig.json \
 *   experiments/voice-turn-detection-compare/closing-safety-b0-b4/action-commit-gate.mts
 * Test (asserts the properties): npx tsx \
 *   experiments/voice-turn-detection-compare/closing-safety-b0-b4/action-commit-gate.test.mts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TurnStateMachine } from '../state-machine/turn-state-machine.mts';
import type { TurnState } from '../state-machine/turn-state-machine.mts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, 'RESULT.json');

// ── (a) audio window merge, preserving original timing ───────────────────────────────────────────

export type AudioWindow = {
  id: string;
  /** Where this window begins on the ORIGINAL timeline, in ms. */
  startMs: number;
  sampleRate: number;
  samples: Float32Array;
};

export type PlacedWindow = { id: string; startMs: number; endMs: number; offsetSamples: number; lengthSamples: number };
export type MergedTimeline = {
  sampleRate: number;
  lengthSamples: number;
  durationMs: number;
  samples: Float32Array;
  windows: PlacedWindow[];
  gaps: Array<{ fromMs: number; toMs: number; ms: number }>;
  overlaps: Array<{ earlier: string; later: string; fromMs: number; toMs: number; ms: number }>;
  spanFromMs: number;
  spanToMs: number;
};

/**
 * The timeline the MERGED windows span, at their true offsets. `merge()` is order-independent
 * (windows are sorted) and idempotent, and the result's length is `lastEnd - 0` — NOT the sum of the
 * window lengths, which is what concatenation would give and what silently breaks timing.
 */
export class AudioWindowMerger {
  #windows: AudioWindow[] = [];

  add(window: AudioWindow): this {
    this.#windows.push(window);
    return this;
  }
  get windowCount(): number {
    return this.#windows.length;
  }

  merge(): MergedTimeline {
    const ws = [...this.#windows].sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (ws.length === 0) {
      return { sampleRate: 0, lengthSamples: 0, durationMs: 0, samples: new Float32Array(0), windows: [], gaps: [], overlaps: [], spanFromMs: 0, spanToMs: 0 };
    }
    const rate = ws[0].sampleRate;
    for (const w of ws) {
      if (w.sampleRate !== rate) {
        // Mixing rates would require a resample the caller never asked for — fail loud, not silently.
        throw new Error(`AudioWindowMerger: window ${w.id} is ${w.sampleRate}Hz; first window is ${rate}Hz`);
      }
    }

    const placed: PlacedWindow[] = [];
    let maxEndMs = 0;
    for (const w of ws) {
      const offsetSamples = Math.round((w.startMs / 1000) * rate);
      const lengthSamples = w.samples.length;
      const endMs = w.startMs + (lengthSamples / rate) * 1000;
      placed.push({ id: w.id, startMs: w.startMs, endMs, offsetSamples, lengthSamples });
      maxEndMs = Math.max(maxEndMs, endMs);
    }

    const lengthSamples = Math.ceil((maxEndMs / 1000) * rate);
    const samples = new Float32Array(lengthSamples);
    const overlaps: MergedTimeline['overlaps'] = [];
    const written: PlacedWindow[] = [];
    for (let i = 0; i < ws.length; i++) {
      const p = placed[i];
      for (const q of written) {
        const fromMs = Math.max(p.startMs, q.startMs);
        const toMs = Math.min(p.endMs, q.endMs);
        if (toMs - fromMs > 1e-6) overlaps.push({ earlier: q.id, later: p.id, fromMs, toMs, ms: toMs - fromMs });
      }
      // THE point: place at the TRUE offset, not appended after the previous window.
      samples.set(ws[i].samples, p.offsetSamples);
      written.push(p);
    }

    const gaps: MergedTimeline['gaps'] = [];
    for (let i = 1; i < placed.length; i++) {
      const prev = placed[i - 1];
      const cur = placed[i];
      if (cur.startMs - prev.endMs > 1e-6) gaps.push({ fromMs: prev.endMs, toMs: cur.startMs, ms: cur.startMs - prev.endMs });
    }

    return {
      sampleRate: rate,
      lengthSamples,
      durationMs: (lengthSamples / rate) * 1000,
      samples,
      windows: placed,
      gaps,
      overlaps,
      spanFromMs: placed[0].startMs,
      spanToMs: maxEndMs,
    };
  }

  /** Negative-control counterpart: naive concatenation. Kept so a test can prove it DIFFERS (and
   *  why) rather than merely assert merge() is "right". */
  static concatenate(windows: AudioWindow[]): Float32Array {
    const total = windows.reduce((a, w) => a + w.samples.length, 0);
    const out = new Float32Array(total);
    let at = 0;
    for (const w of windows) {
      out.set(w.samples, at);
      at += w.samples.length;
    }
    return out;
  }
}

// ── (b)/(c) the versioned gate and its dry-run sink ──────────────────────────────────────────────

export type ToolCall = {
  id: string;
  /** The turn version this call was GENERATED for (mirrors the machine's monotonic `turnVersion`). */
  turnVersion: number;
  name: string;
  args: Record<string, unknown>;
  atMs: number;
};

export type StagedCall = ToolCall & { stagedAtMs: number };
export type VoidedCall = { call: ToolCall; voidedAtMs: number; reason: string };
export type AppliedCall = ToolCall & { appliedAtMs: number; deliveredToRealSession: false };

/**
 * The dry-run sink. It is the ONLY thing in this file that records an "action", and it has no
 * transport of any kind — it cannot reach a session. `deliveredToRealSession: false` is written by
 * the sink itself, so the no-side-effect claim is mechanical, not verbal.
 */
export class DryRunToolSink {
  readonly applied: AppliedCall[] = [];
  apply(call: ToolCall, appliedAtMs: number): AppliedCall {
    const record: AppliedCall = { ...call, appliedAtMs, deliveredToRealSession: false };
    this.applied.push(record);
    return record;
  }
}

/**
 * (b) versioned staleness + (c) the Action Commit Gate, in one object because they share the one
 * invariant that matters: a side effect is released ONLY by `finalize()`, and ONLY for a call whose
 * version is current at that instant.
 */
export class VersionedToolCallGate {
  #currentVersion = 0;
  #staged = new Map<string, StagedCall>();
  #voided: VoidedCall[] = [];

  constructor(readonly sink: DryRunToolSink) {}

  get currentVersion(): number {
    return this.#currentVersion;
  }
  get staged(): readonly StagedCall[] {
    return [...this.#staged.values()];
  }
  get voided(): readonly VoidedCall[] {
    return this.#voided;
  }

  /** The turn advanced (a new candidate point, or a grace-abort/correction). Any staged call for a
   *  superseded version is VOIDED here — before it can ever reach `finalize()`. */
  setVersion(version: number, atMs = 0): VoidedCall[] {
    if (version <= this.#currentVersion) {
      throw new Error(`VersionedToolCallGate.setVersion: version must advance (got ${version}, current ${this.#currentVersion})`);
    }
    this.#currentVersion = version;
    const justVoided: VoidedCall[] = [];
    for (const [id, call] of this.#staged) {
      if (call.turnVersion !== version) {
        const v: VoidedCall = { call, voidedAtMs: atMs, reason: `stale by version: staged at v${call.turnVersion}, turn advanced to v${version}` };
        this.#voided.push(v);
        justVoided.push(v);
        this.#staged.delete(id);
      }
    }
    return justVoided;
  }

  /** A tool call arrives. It is staged only if its version is current; otherwise it is voided on
   *  arrival (late frame, retransmit, or an old turn's timer firing). */
  submit(call: ToolCall, atMs = 0): { decision: 'staged' | 'voided'; call: ToolCall } {
    if (call.turnVersion !== this.#currentVersion) {
      this.#voided.push({ call, voidedAtMs: atMs, reason: `stale on arrival: generated for v${call.turnVersion}, current v${this.#currentVersion}` });
      return { decision: 'voided', call };
    }
    this.#staged.set(call.id, { ...call, stagedAtMs: atMs });
    return { decision: 'staged', call };
  }

  /** The versioned result is FINALIZED. Only calls for the current version reach the sink; a staged
   *  call whose version moved on is dropped (and recorded). */
  finalize(atMs = 0): { applied: AppliedCall[]; dropped: VoidedCall[] } {
    const applied: AppliedCall[] = [];
    const dropped: VoidedCall[] = [];
    for (const [id, call] of this.#staged) {
      if (call.turnVersion !== this.#currentVersion) {
        const v: VoidedCall = { call, voidedAtMs: atMs, reason: `stale at finalize: v${call.turnVersion} != current v${this.#currentVersion}` };
        this.#voided.push(v);
        dropped.push(v);
      } else {
        applied.push(this.sink.apply(call, atMs));
      }
      this.#staged.delete(id);
    }
    return { applied, dropped };
  }

  /** Drop everything staged without applying (grace aborted and nothing supersedes the version). */
  abort(atMs = 0): VoidedCall[] {
    const voided: VoidedCall[] = [];
    for (const [id, call] of this.#staged) {
      const v: VoidedCall = { call, voidedAtMs: atMs, reason: 'aborted before finalize' };
      this.#voided.push(v);
      voided.push(v);
      this.#staged.delete(id);
    }
    return voided;
  }
}

// ── the recovery harness ─────────────────────────────────────────────────────────────────────────

export type RecoveryScenario = {
  id: string;
  /** Did the speaker's correction arrive inside the COMMIT_GRACE window (recoverable) or after the
   *  grace expired and the proposal had already committed (structurally not)? */
  correctionInsideGrace: boolean;
  /** A late duplicate of the superseded call arrives after the correction bumped the version. */
  lateStaleArrival: boolean;
  /** Negative control: a gate that applies on arrival instead of at finalize. */
  naive: boolean;
};

export type RecoveryResult = {
  scenario: RecoveryScenario;
  proposedApplied: boolean;
  correctedApplied: boolean;
  voidedCount: number;
  recovered: boolean;
  finalState: TurnState;
  appliedArgs: Array<Record<string, unknown>>;
};

const GRACE_MS = 900;

/**
 * Drive the SPEC machine + gate through the 「改成三十秒……不对，二十秒」 sequence and report whether the
 * CORRECTED call committed while the SUPERSEDED call did not.
 */
export function runRecoveryScenario(scenario: RecoveryScenario): RecoveryResult {
  const sm = new TurnStateMachine({ graceMs: GRACE_MS });
  const sink = new DryRunToolSink();
  const gate = new VersionedToolCallGate(sink);

  const callA: ToolCall = { id: 'proposed', turnVersion: 1, name: 'set_timeout', args: { seconds: 30 }, atMs: 950 };
  const callB: ToolCall = { id: 'corrected', turnVersion: 3, name: 'set_timeout', args: { seconds: 20 }, atMs: 2000 };

  /** Apply path: a naive gate releases the side effect the moment the call is seen. */
  const releaseOrStage = (call: ToolCall, atMs: number): void => {
    if (scenario.naive) {
      sink.apply(call, atMs);
    } else {
      gate.submit(call, atMs);
    }
  };
  const release = (atMs: number): void => {
    if (!scenario.naive) gate.finalize(atMs);
  };

  sm.onSpeechStart(0);
  sm.onSpeech(0, '改成三十秒');
  const req1 = sm.onCandidatePoint(900);
  if (!scenario.naive) gate.setVersion(1, 900);
  releaseOrStage(callA, 950);
  sm.onDetectorResult(req1, 'END', 950); // COMMIT_GRACE for v1; deadline 950 + 900 = 1850

  if (scenario.correctionInsideGrace) {
    // The speaker resumes INSIDE the window. The machine retracts 改成三十秒 and bumps to v2.
    sm.onSpeechStart(1000);
    if (!scenario.naive) gate.setVersion(2, 1000); // voids callA
    sm.onSpeech(1000, '不对，二十秒');

    const req2 = sm.onCandidatePoint(2000); // v3
    if (!scenario.naive) gate.setVersion(3, 2000);
    releaseOrStage(callB, 2000);
    sm.onDetectorResult(req2, 'END', 2050); // COMMIT_GRACE for v3
    sm.onTick(3000); // ACTION_COMMIT v3
    release(3000);

    if (scenario.lateStaleArrival) {
      // A retransmit / stale timer delivers a second copy of the superseded call now.
      if (scenario.naive) {
        sink.apply({ ...callA, id: 'proposed-dup' }, 3100);
      } else {
        gate.submit({ ...callA, id: 'proposed-dup' }, 3100); // voided on arrival
        gate.finalize(3100); // must not resurrect it
      }
    }
  } else {
    // The grace expires with no correction: the machine commits the PROPOSAL.
    sm.onTick(2000); // deadline 1850 has passed → ACTION_COMMIT v1
    release(2000); // callA is applied — the harm is already released

    // The correction now arrives too late: a NEW turn, whose own call may still commit.
    sm.onSpeechStart(2500); // ACTION_COMMIT -> IDLE, v2
    if (!scenario.naive) gate.setVersion(2, 2500);
    sm.onSpeech(2500, '不对，二十秒');
    const req2 = sm.onCandidatePoint(3500); // v3
    if (!scenario.naive) gate.setVersion(3, 3500);
    releaseOrStage(callB, 3500);
    sm.onDetectorResult(req2, 'END', 3550);
    sm.onTick(4500); // ACTION_COMMIT v3
    release(4500);

    if (scenario.lateStaleArrival) {
      if (scenario.naive) {
        sink.apply({ ...callA, id: 'proposed-dup' }, 4600);
      } else {
        gate.submit({ ...callA, id: 'proposed-dup' }, 4600);
        gate.finalize(4600);
      }
    }
  }

  const proposedApplied = sink.applied.some((a) => a.args.seconds === 30);
  const correctedApplied = sink.applied.some((a) => a.args.seconds === 20);
  return {
    scenario,
    proposedApplied,
    correctedApplied,
    voidedCount: scenario.naive ? 0 : gate.voided.length,
    recovered: correctedApplied && !proposedApplied,
    finalState: sm.state,
    appliedArgs: sink.applied.map((a) => a.args),
  };
}

/** The full scenario grid: recoverable × late-stale × naive. */
export function recoveryScenarios(): RecoveryScenario[] {
  const out: RecoveryScenario[] = [];
  for (const correctionInsideGrace of [true, false]) {
    for (const lateStaleArrival of [true, false]) {
      for (const naive of [false, true]) {
        out.push({
          id: `grace=${correctionInsideGrace ? 'in' : 'after'}|late-stale=${lateStaleArrival ? 'y' : 'n'}|gate=${naive ? 'naive' : 'versioned'}`,
          correctionInsideGrace,
          lateStaleArrival,
          naive,
        });
      }
    }
  }
  return out;
}

export function buildB3Section(): Record<string, unknown> {
  const scenarios = recoveryScenarios();
  const results = scenarios.map(runRecoveryScenario);
  const rate = (rows: RecoveryResult[]): number | null => (rows.length ? Number((rows.filter((r) => r.recovered).length / rows.length).toFixed(6)) : null);

  const versioned = results.filter((r) => !r.scenario.naive);
  const naive = results.filter((r) => r.scenario.naive);
  const inGrace = (rows: RecoveryResult[]): RecoveryResult[] => rows.filter((r) => r.scenario.correctionInsideGrace);
  const afterGrace = (rows: RecoveryResult[]): RecoveryResult[] => rows.filter((r) => !r.scenario.correctionInsideGrace);

  return {
    schema: 'voice-turn-detection-closing-safety/b3-action-commit-gate@1',
    task: 'gap-voice-turn-detection-p0-10-closing-safety-b0-b4',
    kind: 'B3 — closing-safety mechanisms (zero paid upstream calls; synthetic state-machine fixtures)',
    mechanisms: {
      audioWindowMerge: 'AudioWindowMerger.merge() — re-joins split windows at their ORIGINAL timeline offsets (idempotent, order-independent, mixed-rate loud-fail); AudioWindowMerger.concatenate() kept as the negative control its test proves different',
      versionedVoiding: 'VersionedToolCallGate — a call carries the turnVersion it was generated for; a version mismatch voids it on arrival, on setVersion, and again at finalize',
      actionCommitGate: 'VersionedToolCallGate.finalize() — side effects are released ONLY at finalize, ONLY for the current version; staging is free, applying is what the gate guards',
      sink: 'DryRunToolSink writes deliveredToRealSession:false itself and has no transport — the no-side-effect claim is mechanical, not verbal',
    },
    recovery: {
      definition: 'recovered = the CORRECTED call (seconds=20) reached the sink AND the SUPERSEDED call (seconds=30) did not',
      scenarioCount: results.length,
      recoveryRateAll: rate(results),
      recoveryRateVersionedGateAll: rate(versioned),
      recoveryRateNaiveGateAll: rate(naive),
      /** The gate's own score: the scenarios a commit gate can actually govern. */
      recoveryRateVersionedGateInGrace: rate(inGrace(versioned)),
      recoveryRateNaiveGateInGrace: rate(inGrace(naive)),
      /** Structural limit, reported separately so it is never averaged into the gate's score. */
      recoveryRateVersionedGateAfterGrace: rate(afterGrace(versioned)),
      outOfScopeNote: 'correctionInsideGrace=false models a correction that arrives after the grace window expired and the proposal already committed. No commit gate can un-release an applied side effect; the corrected call still commits, but recovery is structurally false. This is the residual cost a finite grace window cannot remove — not a gate failure.',
      naiveControlNote: 'a naive apply-on-arrival gate releases the superseded call immediately and scores 0 across the board — the negative control that shows the versioned gate is doing the work.',
    },
    scenarios: results.map((r) => ({ id: r.scenario.id, ...r.scenario, proposedApplied: r.proposedApplied, correctedApplied: r.correctedApplied, voidedCount: r.voidedCount, recovered: r.recovered, finalState: r.finalState, appliedArgs: r.appliedArgs })),
    budget: { newUpstreamCalls: 0, spendCny: 0, note: 'B3 makes no upstream call; all inputs are synthetic fixtures + the local SPEC machine' },
  };
}

function main(): void {
  const section = buildB3Section();
  const existing = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>) : {};
  existing.schema = existing.schema ?? 'voice-turn-detection-closing-safety/result@1';
  existing.task = 'gap-voice-turn-detection-p0-10-closing-safety-b0-b4';
  existing.b3 = section;
  writeFileSync(OUT, JSON.stringify(existing, null, 2) + '\n');

  const r = section.recovery as Record<string, unknown>;
  console.log('B3 action commit gate complete');
  console.log(`  scenarios: ${r.scenarioCount}`);
  console.log(`  recoveryRate — in-grace versioned ${r.recoveryRateVersionedGateInGrace}, in-grace naive ${r.recoveryRateNaiveGateInGrace}, after-grace versioned ${r.recoveryRateVersionedGateAfterGrace}, all ${r.recoveryRateAll}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
