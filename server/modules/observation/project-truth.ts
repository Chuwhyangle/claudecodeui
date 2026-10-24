/**
 * The project tile's layered truth — five readings, each of which may honestly say "not read".
 *
 * A project is not one boolean. What a person actually asks when they open the cockpit is
 * 「现在在跑什么 / 最近落地了什么 / 线上跑的是不是最新 / 验证过没有 / 谁还活着」, and those
 * five questions have five different sources, five different failure modes and five different
 * kinds of staleness. This module turns them into ONE object reading — `inflight`, `landed`,
 * `deploy`, `verification`, `liveness` — plus the delta items that describe what changed since
 * the previous reading.
 *
 * THE THREE-STATE RULE IS STRUCTURAL, NOT A CONVENTION.
 *
 *   - A layer whose source could not be read is `unevaluated` and MUST carry a `reason`. It is
 *     never collapsed into `ok`: 「取不到」 and 「读到了，是好的」 are different facts.
 *   - A green layer carries `observedAt`, the instant the reading's liveness is anchored to,
 *     so a green dot can never outlive the reading behind it without showing its age.
 *   - `not-applicable` exists ONLY for the deploy layer of a project that has no deployment
 *     concept. It is excluded from the green/red aggregation, so it can neither paint the tile
 *     green nor turn it red.
 *
 * THE CURSOR IS THE PRODUCER'S PREVIOUS OBSERVATION INSTANT. 「自游标以来转为 done」 is decided
 * against the previous revision's `observedAt`, not against a per-user seen cursor: the user
 * cursor filters REVISIONS (the store already does that), while this cursor answers "which
 * tasks landed since the last time we looked". A first reading has no cursor, so it claims no
 * landings — the whole history is not a delta. When the previous reading could NOT read the
 * task list, its `landed.since` is carried forward instead (the producer's job), so a failed
 * read never swallows the landings that happened while it was failing.
 *
 * Consumers: `server/modules/observation/project-truth.producer.ts` (the write path) and
 * `server/modules/observation/tests/project-truth.test.ts` (the criterion).
 */
import type { QuayFleetLivenessReading } from '@/modules/quay/index.js';

import type { ObservedStatus } from './observation-store.js';

/** One project as the producer addresses it. `fleetProjectId` is the `quay://` project segment. */
export type ProjectTruthProjectRef = {
  /** CloudCLI's own project id, used only to ask the quay service for a snapshot. */
  projectId: string;
  /** Absolute project root; the deploy reader resolves its own script relative to it. */
  projectPath: string;
  /** The display title. Defaults to the fleet project id when the caller has no better one. */
  title: string;
  /**
   * The quay-fleet registry id. `null` means the root is not registered with the fleet, so this
   * project cannot be addressed as `quay://<id>/board` and the producer writes nothing for it.
   */
  fleetProjectId: string | null;
  /**
   * The deployment target, or `null` when the project has no deployment concept. Today only
   * CloudCLI itself does; every other project's deploy layer is `not-applicable`.
   */
  deploy: ProjectTruthDeployTarget | null;
};

/** Where a deployed instance can be asked what it is running, and against which ref to compare. */
export type ProjectTruthDeployTarget = {
  /** Base URL of the running instance's `/health` face. */
  healthUrl: string;
  /** The git ref the build should match (the script defaults to `HEAD`). */
  ref: string;
};

/** One task row from the compact `task list --json --no-body` reading. */
export type ProjectTruthTaskRow = {
  taskId: string;
  title: string;
  status: string;
  /** Epoch ms of the record's last write, or `null` when the row carries no usable instant. */
  updatedAt: number | null;
};

/** One task the worker currently has in flight, as the quay snapshot reports it. */
export type ProjectTruthInFlightTask = {
  taskId: string;
  /** Joined from the task list; empty when the task row is not in the same reading. */
  title: string;
  /** The phase quay's lane interval carries (`running`, `fan-in`, …). */
  phase: string;
  startedAt: number | null;
  lastHeartbeat: number | null;
};

/** One goal/AC gate reading, already projected to the three-state vocabulary. */
export type ProjectTruthGoalGateRow = {
  criterionId: string;
  /** The owning `GOAL-NNN` record, when the criterion names one. */
  goal: string | null;
  title: string;
  /** The record's lifecycle status (`active`, `achieved`, `draft`, `superseded`, `retired`). */
  status: string;
  /** `criterion` or `goal`; only criteria carry a runnable gate. */
  kind: string;
  gate: 'pass' | 'fail' | 'not-evaluated';
  /** Epoch ms of the gate evidence behind `gate`, or `null` when there is none. */
  gateAt: number | null;
};

/**
 * Everything the project tile reads from one project's board, with each source's failure kept
 * separate: an unreadable in-flight set must not blank a task list that did arrive.
 */
export type ProjectTruthBoardReading = {
  tasks: readonly ProjectTruthTaskRow[];
  inFlight: readonly ProjectTruthInFlightTask[];
  goals: readonly ProjectTruthGoalGateRow[];
  /** Why the in-flight reading is missing, or `null` when it was read. */
  inFlightUnavailableReason: string | null;
  /** Why the full task list is missing, or `null` when it was read. */
  tasksUnavailableReason: string | null;
  /** Why the goal/AC gate list is missing, or `null` when it was read. */
  goalsUnavailableReason: string | null;
};

/** The deploy-layer reading, as the freshness check resolves it. */
export type ProjectTruthDeployReading =
  | { kind: 'fresh'; buildSha: string; headSha: string; checkedAt: number }
  | { kind: 'behind'; buildSha: string; headSha: string; behindBy: number; checkedAt: number }
  | { kind: 'diverged'; buildSha: string; headSha: string; checkedAt: number }
  | { kind: 'unknown'; reason: string; checkedAt: number | null }
  | { kind: 'not-applicable'; reason: string };

/** 在飞 — what the worker is executing right now. */
export type ProjectInflightLayer = {
  state: 'ok' | 'unevaluated';
  reason: string | null;
  /** Reading instant; a green layer always has one. */
  observedAt: number | null;
  tasks: readonly ProjectTruthInFlightTask[];
};

/** One task that became done after the cursor. */
export type ProjectLandedTask = {
  taskId: string;
  title: string;
  doneAt: number | null;
};

/** 落地 — tasks that transitioned to done after the previous observation. */
export type ProjectLandedLayer = {
  state: 'ok' | 'unevaluated';
  reason: string | null;
  observedAt: number | null;
  /** The previous observation instant the landing window starts after; `null` on a first read. */
  since: number | null;
  tasks: readonly ProjectLandedTask[];
};

/** 部署 — the running build against its ref. */
export type ProjectDeployLayer = {
  state: 'ok' | 'red' | 'unevaluated' | 'not-applicable';
  reason: string | null;
  observedAt: number | null;
  buildSha: string | null;
  headSha: string | null;
  behindBy: number | null;
};

/** One AC gate's three-state reading inside the verification layer. */
export type ProjectVerificationEntry = {
  criterionId: string;
  goal: string | null;
  title: string;
  gate: 'pass' | 'fail' | 'not-evaluated';
  gateAt: number | null;
};

/** 验证 — the goal/AC gates' three-state reading. */
export type ProjectVerificationLayer = {
  state: 'ok' | 'red' | 'unevaluated';
  reason: string | null;
  observedAt: number | null;
  entries: readonly ProjectVerificationEntry[];
};

/** 活性 — the fleet's per-project driver liveness. */
export type ProjectLivenessLayer = {
  state: 'ok' | 'attention' | 'red' | 'unevaluated';
  reason: string | null;
  observedAt: number | null;
  driverState: 'ok' | 'stale' | 'unknown' | null;
  driverAgeSec: number | null;
  lastGateAt: number | null;
  halted: boolean;
};

/** The five layers, keyed exactly as the wall renders them. */
export type ProjectTruthLayers = {
  inflight: ProjectInflightLayer;
  landed: ProjectLandedLayer;
  deploy: ProjectDeployLayer;
  verification: ProjectVerificationLayer;
  liveness: ProjectLivenessLayer;
};

/** The structured document stored on the observed object. */
export type ProjectTruthDigest = {
  /** The reading instant, and the cursor the NEXT reading uses for its landing window. */
  observedAt: number;
  projectPath: string;
  fleetProjectId: string;
  /** How many tasks are parked on a person (`needs-human`), the tile's attention signal. */
  needsHuman: number;
  layers: ProjectTruthLayers;
};

/** The five-layer reading plus its delta and the object status derived from them. */
export type ProjectTruthReading = {
  status: ObservedStatus;
  digest: ProjectTruthDigest;
  deltaItems: string[];
};

/** The product's own name for each layer, used in status reasons and delta items. */
const PROJECT_TRUTH_LAYER_LABELS = {
  inflight: '在飞',
  landed: '落地',
  deploy: '部署',
  verification: '验证',
  liveness: '活性',
} as const satisfies Record<keyof ProjectTruthLayers, string>;

/** The deploy layer's "no deployment concept" state, excluded from aggregation. */
export const PROJECT_TRUTH_NOT_APPLICABLE_REASON = '该项目没有部署概念（目前只有 CloudCLI 自身有部署）';

/** One criterion row counts as a gate only while it is a live, runnable criterion. */
const GATE_EXCLUDED_GOAL_STATUSES = new Set(['draft', 'superseded', 'retired']);

/** The layer keys, in the wall's display order, for aggregation and delta scanning. */
const LAYER_KEYS = ['inflight', 'landed', 'deploy', 'verification', 'liveness'] as const;

function toEpochMs(value: string | null): number | null {
  if (value === null) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : null;
}

/**
 * Builds one project's five-layer reading.
 *
 * `deploy` is ignored when `project.deploy` is `null`: the absence of a deployment concept is a
 * property of the PROJECT, not something a failing reader gets to turn red.
 */
export function buildProjectTruth(input: {
  project: ProjectTruthProjectRef;
  board: ProjectTruthBoardReading;
  deploy: ProjectTruthDeployReading;
  liveness: QuayFleetLivenessReading;
  /** Previous observation instant; done tasks strictly after it are landings. */
  cursor: number | null;
  /** The previous digest, for transition deltas. `null` on the first write. */
  previous: ProjectTruthDigest | null;
  now: number;
}): ProjectTruthReading {
  const { project, board, liveness, cursor, previous, now } = input;

  const tasksById = new Map(board.tasks.map((task) => [task.taskId, task]));
  const needsHuman = board.tasks.filter((task) => task.status === 'needs-human').length;

  const inflight = buildInflightLayer(board, tasksById, now);
  const landed = buildLandedLayer(board, cursor, now);
  const deploy = buildDeployLayer(project, input.deploy);
  const verification = buildVerificationLayer(board);
  const livenessLayer = buildLivenessLayer(liveness, project.fleetProjectId, now);

  const layers: ProjectTruthLayers = { inflight, landed, deploy, verification, liveness: livenessLayer };
  const digest: ProjectTruthDigest = {
    observedAt: now,
    projectPath: project.projectPath,
    fleetProjectId: project.fleetProjectId ?? '',
    needsHuman,
    layers,
  };

  return {
    status: aggregateStatus(layers, needsHuman),
    digest,
    deltaItems: buildDeltaItems(previous, digest),
  };
}

function buildInflightLayer(
  board: ProjectTruthBoardReading,
  tasksById: ReadonlyMap<string, ProjectTruthTaskRow>,
  now: number,
): ProjectInflightLayer {
  if (board.inFlightUnavailableReason !== null) {
    return {
      state: 'unevaluated',
      reason: board.inFlightUnavailableReason,
      observedAt: null,
      tasks: [],
    };
  }
  return {
    state: 'ok',
    reason: null,
    observedAt: now,
    tasks: board.inFlight.map((task) => ({
      taskId: task.taskId,
      title: task.title || tasksById.get(task.taskId)?.title || '',
      phase: task.phase,
      startedAt: task.startedAt,
      lastHeartbeat: task.lastHeartbeat,
    })),
  };
}

function buildLandedLayer(
  board: ProjectTruthBoardReading,
  cursor: number | null,
  now: number,
): ProjectLandedLayer {
  if (board.tasksUnavailableReason !== null) {
    return {
      state: 'unevaluated',
      reason: board.tasksUnavailableReason,
      observedAt: null,
      since: cursor,
      tasks: [],
    };
  }

  // A first reading has no window: claiming the whole history as "landed" would make the
  // first glance a lie. From the second reading on, the previous observedAt is the cursor.
  const landedTasks =
    cursor === null
      ? []
      : board.tasks
          .filter(
            (task) =>
              task.status === 'done' &&
              task.updatedAt !== null &&
              task.updatedAt > cursor,
          )
          .map((task) => ({ taskId: task.taskId, title: task.title, doneAt: task.updatedAt }));

  return { state: 'ok', reason: null, observedAt: now, since: cursor, tasks: landedTasks };
}

function buildDeployLayer(
  project: ProjectTruthProjectRef,
  reading: ProjectTruthDeployReading,
): ProjectDeployLayer {
  const base = { buildSha: null, headSha: null, behindBy: null };

  // A project with no deployment concept is `not-applicable` BY THE PROJECT, never by the
  // reader: a reader that failed must not be able to paint a non-deployed project red.
  if (project.deploy === null) {
    return {
      state: 'not-applicable',
      reason: PROJECT_TRUTH_NOT_APPLICABLE_REASON,
      observedAt: null,
      ...base,
    };
  }

  switch (reading.kind) {
    case 'fresh':
      return {
        state: 'ok',
        reason: null,
        observedAt: reading.checkedAt,
        buildSha: reading.buildSha,
        headSha: reading.headSha,
        behindBy: null,
      };
    case 'behind':
      return {
        state: 'red',
        reason: `运行版本落后 ${project.deploy.ref} ${reading.behindBy} 个提交`,
        observedAt: reading.checkedAt,
        buildSha: reading.buildSha,
        headSha: reading.headSha,
        behindBy: reading.behindBy,
      };
    case 'diverged':
      return {
        state: 'red',
        reason: `运行版本不是 ${project.deploy.ref} 的祖先`,
        observedAt: reading.checkedAt,
        buildSha: reading.buildSha,
        headSha: reading.headSha,
        behindBy: null,
      };
    case 'unknown':
      return {
        state: 'unevaluated',
        reason: reading.reason,
        observedAt: reading.checkedAt,
        ...base,
      };
    case 'not-applicable':
      return {
        state: 'not-applicable',
        reason: reading.reason,
        observedAt: null,
        ...base,
      };
  }
}

function buildVerificationLayer(board: ProjectTruthBoardReading): ProjectVerificationLayer {
  if (board.goalsUnavailableReason !== null) {
    return {
      state: 'unevaluated',
      reason: board.goalsUnavailableReason,
      observedAt: null,
      entries: [],
    };
  }

  // A `goal` record carries no runnable criterion of its own; its achievement is derived from
  // its ACs. Including it would make every project permanently "not evaluated".
  const entries: ProjectVerificationEntry[] = board.goals
    .filter((goal) => goal.kind === 'criterion')
    .filter((goal) => !GATE_EXCLUDED_GOAL_STATUSES.has(goal.status))
    .map((goal) => ({
      criterionId: goal.criterionId,
      goal: goal.goal,
      title: goal.title,
      gate: goal.gate,
      gateAt: goal.gateAt,
    }))
    .sort((left, right) => left.criterionId.localeCompare(right.criterionId));

  if (entries.length === 0) {
    return {
      state: 'unevaluated',
      reason: '没有可读的 AC gate 结果',
      observedAt: null,
      entries,
    };
  }

  const failed = entries.filter((entry) => entry.gate === 'fail').length;
  const notEvaluated = entries.filter((entry) => entry.gate === 'not-evaluated').length;
  const observedAt = entries.reduce<number | null>((latest, entry) => {
    if (entry.gateAt === null) return latest;
    return latest === null || entry.gateAt > latest ? entry.gateAt : latest;
  }, null);

  if (failed > 0) {
    return { state: 'red', reason: `${failed} 个 AC gate 失败`, observedAt, entries };
  }
  if (notEvaluated > 0) {
    return { state: 'unevaluated', reason: `${notEvaluated} 个 AC gate 未评估`, observedAt, entries };
  }
  return { state: 'ok', reason: null, observedAt, entries };
}

function buildLivenessLayer(
  reading: QuayFleetLivenessReading,
  fleetProjectId: string | null,
  now: number,
): ProjectLivenessLayer {
  const empty = { driverState: null, driverAgeSec: null, lastGateAt: null, halted: false };

  if (!reading.available) {
    return {
      state: 'unevaluated',
      reason: reading.reason ?? 'quay-fleet 读口不可用',
      observedAt: null,
      ...empty,
    };
  }

  const project =
    fleetProjectId === null
      ? undefined
      : reading.projects.find((candidate) => candidate.projectId === fleetProjectId);

  if (project === undefined) {
    return {
      state: 'unevaluated',
      reason:
        fleetProjectId === null
          ? '项目未登记到 quay-fleet，没有活性读数'
          : `fleet 读数里没有 ${fleetProjectId}`,
      observedAt: null,
      ...empty,
    };
  }

  const observedAt = project.driverAgeSec === null ? null : now - project.driverAgeSec * 1000;
  const base = {
    driverState: project.driverState,
    driverAgeSec: project.driverAgeSec,
    lastGateAt: toEpochMs(project.lastGateAt),
    halted: project.halted,
  };

  if (project.driverState === 'stale') {
    return {
      state: 'red',
      reason: `driver 已静默 ${project.driverAgeSec ?? '?'} 秒`,
      observedAt,
      ...base,
    };
  }
  if (project.driverState === 'unknown') {
    return {
      state: 'unevaluated',
      reason: project.driverReason ?? 'driver 状态未知',
      observedAt,
      ...base,
    };
  }
  if (project.halted) {
    return { state: 'attention', reason: 'driver 已人工停用', observedAt, ...base };
  }
  return { state: 'ok', reason: null, observedAt, ...base };
}

function aggregateStatus(layers: ProjectTruthLayers, needsHuman: number): ObservedStatus {
  const red = LAYER_KEYS.map((key) => ({ key, layer: layers[key] })).filter(
    (entry) => entry.layer.state === 'red',
  );
  if (red.length > 0) {
    return {
      state: 'red',
      reason: red
        .map((entry) =>
          entry.layer.reason === null
            ? PROJECT_TRUTH_LAYER_LABELS[entry.key]
            : `${PROJECT_TRUTH_LAYER_LABELS[entry.key]}：${entry.layer.reason}`,
        )
        .join('；'),
    };
  }

  const notGreen: string[] = [];
  if (needsHuman > 0) notGreen.push(`${needsHuman} 个任务 needs-human`);
  for (const key of LAYER_KEYS) {
    const layer = layers[key];
    if (layer.state === 'unevaluated' || layer.state === 'attention') {
      const label = PROJECT_TRUTH_LAYER_LABELS[key];
      notGreen.push(layer.reason === null ? label : `${label}：${layer.reason}`);
    }
  }
  if (notGreen.length > 0) {
    return { state: 'attention', reason: notGreen.join('；') };
  }
  return { state: 'ok' };
}

/**
 * The delta the wall shows after this revision.
 *
 * Only facts that changed against the object's OWN previous revision are claimed:
 *   · a landed task is one that became done after the cursor (first reading: none);
 *   · `X 转红` requires the previous layer NOT to be red;
 *   · `goal Y 推进` requires that AC's gate evidence instant to advance;
 *   · `driver 静默 N 分钟` is emitted for the stale-driver reading itself, including the first.
 */
function buildDeltaItems(
  previous: ProjectTruthDigest | null,
  next: ProjectTruthDigest,
): string[] {
  const items: string[] = [];

  for (const task of next.layers.landed.tasks) {
    items.push(`落地 ${task.title}`);
  }

  for (const key of LAYER_KEYS) {
    const layer = next.layers[key];
    if (layer.state !== 'red') continue;
    const wasRed = previous?.layers[key]?.state === 'red';
    if (wasRed) continue;
    items.push(previous === null ? `${PROJECT_TRUTH_LAYER_LABELS[key]} 红` : `${PROJECT_TRUTH_LAYER_LABELS[key]} 转红`);
  }

  if (previous !== null) {
    const previousGateAt = new Map(
      previous.layers.verification.entries.map((entry) => [entry.criterionId, entry.gateAt]),
    );
    const advanced = new Set<string>();
    for (const entry of next.layers.verification.entries) {
      const before = previousGateAt.get(entry.criterionId);
      const after = entry.gateAt;
      if (after === null) continue;
      if (before === undefined || before === null || after > before) {
        // Group an AC's progress under its owning GOAL so one tile change reads as one line.
        advanced.add(entry.goal ?? entry.criterionId);
      }
    }
    for (const goal of advanced) items.push(`goal ${goal} 推进`);
  }

  const liveness = next.layers.liveness;
  if (liveness.state === 'red' && liveness.driverAgeSec !== null) {
    items.push(`driver 静默 ${Math.max(1, Math.round(liveness.driverAgeSec / 60))} 分钟`);
  }

  return items;
}
