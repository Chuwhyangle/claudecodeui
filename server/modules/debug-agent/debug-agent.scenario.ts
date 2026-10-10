import type {
  AnyRecord,
  HostCloseDetail,
  HostLease,
  HostMode,
  MessageOriginTrigger,
} from '@/shared/types.js';
import { AppError, readObjectRecord } from '@/shared/utils.js';

/**
 * The scenario document a debug-agent run replays, and the validation that
 * refuses to load one this build cannot execute.
 *
 * ADR-003 decision 7 draws the line this file sits on: a scenario describes what
 * is WRITTEN TO A TRANSCRIPT and when — never a frame, an event, or any other
 * wire name. The frames a client sees are whatever the shared normalizer makes
 * of the rows this document produces, which is why the `op` closed set below is
 * a set of transcript operations rather than a list of frame kinds.
 *
 * Every closed set is a value this build knows how to execute. An unrecognised
 * value is refused with the value and the set printed, never guessed at: a
 * scenario that quietly ran as something else would produce a reading nobody can
 * attribute to a cause.
 */

/** The document version this build loads. A different one is refused, not migrated. */
export const DEBUG_AGENT_SCENARIO_VERSION = 1;

/**
 * Transcript dialects this build can write. One member today, and it is a closed
 * set rather than an implicit default so that a document asking for a dialect
 * that does not exist fails loudly instead of silently writing claude rows.
 */
export const DEBUG_AGENT_DIALECTS = ['claude'] as const;
export type DebugAgentDialect = (typeof DEBUG_AGENT_DIALECTS)[number];

/**
 * Which root a scenario's transcript is written under. `gate` means the root the
 * gate module resolves from `DEBUG_AGENT_HOME` — the fixture home — and it is a
 * closed set of one because "write to the real `~/.claude`" must not be
 * expressible as a scenario value at all.
 */
export const DEBUG_AGENT_HOMES = ['gate'] as const;
export type DebugAgentHome = (typeof DEBUG_AGENT_HOMES)[number];

/**
 * How a step's rows reach the transcript. `per-row-jsonl` appends one JSON object
 * per line, which is the only shape the indexer and the normalizer read.
 */
export const DEBUG_AGENT_TRANSCRIPT_MODES = ['per-row-jsonl'] as const;
export type DebugAgentTranscriptMode = (typeof DEBUG_AGENT_TRANSCRIPT_MODES)[number];

/**
 * What a step does to the transcript, and to the host that carries it.
 *
 * `row` appends a new row (its own uuid). `grow` rewrites the last row in place
 * and keeps its uuid, which is what makes it the same message with different
 * content rather than a second message. `wait` and `scroll` change nothing on
 * disk: they exist so a scenario can express the passage of time and a
 * follow-along intent without inventing a frame to carry them.
 *
 * The host steps are the same kind of statement about a different seam.
 * `unattended-turn` opens a run for the session with no client behind it and
 * delivers the turn through the host — the row it writes is the turn's own user
 * row, so the step changes the transcript as well, and the trigger it carries is
 * what the row's `origin` says the turn was for. `keepalive-add` and
 * `keepalive-remove` report a reason the process is held open besides a turn,
 * `identity` reports the address the process answers to, and `exit` reports that
 * the process went away. None of them names a frame or an event: they are
 * statements about a process and a transcript, which is the whole of what this
 * document is allowed to describe.
 *
 * `turn-end` is the counterpart of the turn `unattended-turn` opens, and it is a
 * step of its own rather than something the next turn implies: a process that has
 * finished a turn and is still held open is the 空闲 state, and a scenario that
 * could not say "this turn ended" could never place that state on the clock. It
 * writes nothing and carries nothing, because it states an end rather than a
 * row — the same reason `wait` is a step.
 *
 * `dequeue` and `cancel-ack` are the same shape of step for the CLI's own queue
 * (`docs/proposals/claude-resident-sessions-experiments.md` §9.2): the first says
 * the process took the oldest command it is holding and started it, the second
 * that it acted on a withdrawal and dropped a command it had never started. Both
 * carry nothing, because what they state is a moment on the clock for a queue
 * whose commands the run was told about when they were pushed — the scenario
 * cannot know a uuid the host minted at push time, which is exactly why the
 * engine reads the queue rather than the document for these two.
 */
export const DEBUG_AGENT_OPS = [
  // The one step whose timing is the CALLER's rather than the clock's. It carries
  // nothing and writes nothing, the same shape as `wait` below; what it states is
  // "the walk may not pass this point until it is released" (see
  // `runDebugAgentScenario` and the control plane's release action). A criterion
  // uses it to take a fixed offset out of the walk: the events after the barrier
  // fire when the criterion says its own reading window is over, so the wait is
  // the window's own cost and does not scale with host load the way a fixed
  // offset does.
  'await-release',
  'cancel-ack',
  'dequeue',
  'exit',
  'grow',
  'identity',
  'keepalive-add',
  'keepalive-remove',
  // The one step that raises a HUMAN-FACING prompt. It carries the tool whose
  // prompt this is (with its input) and parks the walk until an answer arrives,
  // so both halves of the MCP approval loop — "the prompt is visible" and "the
  // walk resumes once it is answered" — are a scenario's own statements rather
  // than a test's. The step names the REQUEST, never a frame: the frame and the
  // Turn Tracker feed both go through the announcer the registry injects (see
  // `debug-agent.engine.ts`), because this module may not write a wire name
  // (ADR-003 decision 7, pinned by the vocabulary guard).
  'permission-request',
  'row',
  'scroll',
  // The turn-phase steps. Each writes the one claude dialect row that carries a
  // signal the product's frame forwarder reduces into a phase — a thinking-token
  // estimate, a pending tool call, its paired result, a partial text delta, and
  // the turn's own terminal record. They name the SIGNAL, never a frame: what a
  // client sees is what the normalizer makes of the row, exactly as for every
  // step above.
  'text-delta',
  'thinking-tokens',
  'tool-call',
  'tool-result',
  'turn-end',
  'turn-result',
  'unattended-turn',
  'wait',
  // The background-work steps (AC-194). Each writes the one claude dialect row
  // that carries a task-lifecycle signal the product's Task Reducer reads — a
  // task starting, its progress advancing, a status patch, its terminal
  // notification — or the `CronCreate` call/result pair the Schedule Tracker
  // reduces into a plan. They name the SIGNAL, never a frame: what a client sees
  // is what the normalizer makes of the row, exactly as for every step above.
  'schedule-plan',
  'task-notification',
  'task-progress',
  'task-started',
  'task-updated',
] as const;
export type DebugAgentScenarioOp = (typeof DEBUG_AGENT_OPS)[number];

/**
 * The ops that act on the run's host rather than only on its transcript.
 *
 * A run driven with no host layer cannot execute one of these, and it must say
 * so before it starts rather than partway through: a run that wrote half its
 * rows and then discovered it had nowhere to report a lease would leave a
 * transcript no reading could be attributed to. Kept as a closed set so "which
 * steps need the host" is one fact rather than a list the engine re-derives.
 */
export const DEBUG_AGENT_HOST_OPS = [
  'cancel-ack',
  'dequeue',
  'exit',
  'identity',
  'keepalive-add',
  'keepalive-remove',
  'turn-end',
  'unattended-turn',
] as const satisfies readonly DebugAgentScenarioOp[];
export type DebugAgentHostOp = (typeof DEBUG_AGENT_HOST_OPS)[number];

/** Whether one step's op needs the host layer. A type guard, so the engine's switch narrows with it. */
export function isDebugAgentHostOp(op: DebugAgentScenarioOp): op is DebugAgentHostOp {
  return (DEBUG_AGENT_HOST_OPS as readonly DebugAgentScenarioOp[]).includes(op);
}

/** The conversation roles a transcript row can carry in the claude dialect. */
export const DEBUG_AGENT_ROLES = ['assistant', 'user'] as const;
export type DebugAgentRole = (typeof DEBUG_AGENT_ROLES)[number];

/**
 * The lease kinds a scenario may report a process as held for.
 *
 * The three lease kinds that describe work outliving the turn that started it,
 * which is exactly what a keepalive is: a background task reporting back, a
 * timer that will fire, a monitor with something to say. `turn` and
 * `resident-policy` are absent because neither is a scenario's to state — the
 * first belongs to the turn in flight and the second to the mode the manager
 * opened the binding in. Typed by extraction from `HostLease` rather than
 * written out, so a lease kind renamed in the shared contract breaks this file
 * instead of producing a lease the manager cannot interpret.
 *
 * `cron` is here rather than left to a second vocabulary because the status bar
 * shows one count per KIND, and the two it can name must be the two a scenario
 * can produce. A build that could only report a monitor would have to label it
 * "定时任务" to satisfy the section it was written for, which is exactly the
 * second vocabulary this list exists to prevent.
 */
export const DEBUG_AGENT_KEEPALIVE_KINDS = [
  'background-task',
  'cron',
  'monitor',
] as const satisfies readonly Extract<HostLease['kind'], 'background-task' | 'cron' | 'monitor'>[];
export type DebugAgentKeepaliveKind = (typeof DEBUG_AGENT_KEEPALIVE_KINDS)[number];

/**
 * What a scenario may say a turn was started by.
 *
 * Typed by extraction from the shared `MessageOriginTrigger`, so the words the
 * transcript draws its divider with are the words the host layer reports — a
 * scenario cannot name a cause the frontend has no label for, and a trigger
 * added to the contract breaks this file rather than being silently unusable.
 */
export const DEBUG_AGENT_TURN_TRIGGERS = [
  'background-task',
  'cron',
  'cross-session',
] as const satisfies readonly MessageOriginTrigger[];
export type DebugAgentTurnTrigger = (typeof DEBUG_AGENT_TURN_TRIGGERS)[number];

/**
 * How a scenario's process reports that it went away.
 *
 * `forced` is deliberately not expressible: it is not a driver report at all —
 * the manager writes it when a server shutdown had to close a host out from
 * under a driver that never settled — so a scenario asking for it would be
 * asking for a state no process can produce.
 */
export const DEBUG_AGENT_EXIT_DETAILS = [
  'oom',
  'signal',
  'error',
] as const satisfies readonly Exclude<HostCloseDetail, 'forced'>[];
export type DebugAgentExitDetail = (typeof DEBUG_AGENT_EXIT_DETAILS)[number];

/**
 * One step on the scenario clock. `at` is an absolute offset in milliseconds
 * from the start of the run, and the sequence must be non-descending — a clock
 * that can go backwards cannot order two observations of the same file.
 */
export type DebugAgentScenarioStep = { at: number } & (
  /**
   * Holds the walk until the control plane releases it — the one step whose time
   * is the caller's rather than the clock's. Carries nothing and writes nothing,
   * exactly like `wait`; see `DEBUG_AGENT_OPS` for what a criterion uses it for.
   */
  | { op: 'await-release' }
  | { op: 'cancel-ack' }
  | { op: 'dequeue' }
  | { op: 'exit'; detail: DebugAgentExitDetail }
  | { op: 'grow'; text: string }
  | { op: 'identity'; name: string }
  | { op: 'keepalive-add'; kind: DebugAgentKeepaliveKind }
  | { op: 'keepalive-remove'; kind: DebugAgentKeepaliveKind }
  | {
      /**
       * Raises one human-facing prompt and (by default) parks the walk on it.
       *
       * The prompt is registered as a pending approval the runtime's own
       * `permissions` face lists, announced through the injected announcer (a
       * frame on the run's writer plus a Turn Tracker feed), and — while `hold`
       * is true — awaited until an `approval_answer` resolves it, so the steps
       * behind it land only AFTER the answer. That is the whole "resume" this
       * step makes measurable.
       */
      op: 'permission-request';
      /** The tool whose prompt this is (`AskUserQuestion`, `ExitPlanMode`, `Bash`, …). */
      toolName: string;
      /**
       * The tool's input, as the caller-facing expansion reads it — e.g.
       * `AskUserQuestion`'s `{ questions: [...] }`, which `approvals_list`
       * expands option by option. Optional because a tool may need none.
       */
      input?: Record<string, unknown>;
      /**
       * The request id the prompt is answerable by.
       *
       * Optional, and absent means the engine mints one — the same rule every
       * other minted id in this file follows. A scenario that states it does so
       * to name a prompt in a reading it takes itself (the dropped/timed-out
       * case); a scenario that stays silent lets the id be the run's own.
       */
      requestId?: string;
      /**
       * Whether the walk parks until the prompt is answered.
       *
       * `true` (the default, and the shape a plain `permission-request` has)
       * holds the walk open; `false` announces the prompt and immediately drops
       * it, modelling a prompt that was shown and then timed out or was
       * discarded — the reading that must classify as `expired` rather than
       * `never_issued`. Defaulting to `true` means the common case needs no
       * field, and a document that wants the dropped shape says so.
       */
      hold: boolean;
    }
  | { op: 'row'; role: DebugAgentRole; text: string }
  | { op: 'scroll' }
  | { op: 'text-delta'; text: string }
  | { op: 'thinking-tokens' }
  | { op: 'tool-call'; name: string; /** Optional tool input, for the schedule tools whose expression rides on it. */ input?: Record<string, unknown> }
  | { op: 'tool-result'; text: string }
  | { op: 'task-started'; taskId: string; taskType: string; description: string }
  | { op: 'task-progress'; taskId: string; description: string }
  | {
      op: 'task-updated';
      taskId: string;
      status: string;
      /**
       * Whether this patch is the one that says the task moved to the
       * background.
       *
       * The two-frame shape the CLI emits when a foreground tool is
       * backgrounded is a `task_started` (joining the task to the tool_use that
       * launched it) followed by a `task_updated` whose patch carries
       * `is_backgrounded: true`. This flag is the second half of that pair: the
       * Task Reducer reads it as "this task is a background task now", which is
       * the whole difference between a foreground tool and a background one.
       * Optional, and absent means a patch that says nothing about backgrounding
       * — the shape this step had before it could carry the flag.
       */
      isBackgrounded?: boolean;
    }
  | { op: 'task-notification'; taskId: string; status: string; summary: string }
  | { op: 'schedule-plan'; expression: string; human: string; prompt: string }
  | { op: 'turn-end' }
  | { op: 'turn-result' }
  | {
      op: 'unattended-turn';
      text: string;
      /**
       * What started the turn.
       *
       * Optional, and an omitted trigger is a turn that states no cause — the
       * shape this step had before it could carry one. That is a real case and
       * not a compatibility shim: §15.6's rule for a turn whose cause cannot be
       * read is the same as for one that stated none (the frontend draws
       * 「非用户触发」), and a document that wants a typed divider states the
       * trigger. When it IS stated the closed set above validates it, so a
       * scenario cannot name a cause the frontend has no label for.
       */
      trigger?: DebugAgentTurnTrigger;
      /**
       * The address of the session that sent this turn, for `cross-session`.
       *
       * Refused on any other trigger, including an absent one: only a
       * cross-session turn has another conversation to name, and a scenario that
       * supplied a sender to a cron trigger would be reading its own document
       * back as a message from a session that never sent one.
       */
      sender?: string | null;
    }
  | { op: 'wait' }
);

/**
 * What the run must have produced, stated as an expectation the caller can
 * falsify against the artifact. It is deliberately about the artifact (rows,
 * bytes, content) and not about frames: a document that asserted its own frames
 * would be checking the engine's self-report.
 */
export type DebugAgentScenarioExpectations = {
  /** Rows the run itself appends; the seeded rows are not counted here. */
  rows: { delta: number };
  /** Substrings the transcript must contain once the run is over. */
  content: { mustContain: string[] };
};

/** The rows a session starts with, so it is listable before anything drives it. */
export type DebugAgentScenarioSeed = {
  title: string;
  userText: string;
  /**
   * How the seeded session's process is meant to live, as the session row
   * stores it.
   *
   * Part of the SEED rather than a step, because it is a fact about the fixture
   * that must hold before the run starts: the resident path is chosen at
   * dispatch time by reading the session's stored mode, so a scenario that
   * could only state its mode midway through would have every step before that
   * point dispatched down the per-run path — including the very turn the
   * resident host is supposed to serve.
   *
   * Optional, and an absent field reads as `per-run`: that is what a session
   * nobody has set runs as, which is what a scenario written before this field
   * existed was describing. Typed by extraction from `HostMode` so the two
   * members a fixture can ask for are the two the contract has.
   *
   * Optional on the TYPE as well as in the document, because the two are the
   * same type: `loadScenario` fills the field in (so a loaded scenario always
   * carries it), while a scenario literal written straight into a test omits it.
   * Every reader therefore normalizes an absent value to `per-run` rather than
   * reading the field raw — see `resolveScenarioLifecycleMode` below, which is
   * the one place that does it.
   */
  lifecycleMode?: DebugAgentLifecycleMode;
};

/**
 * The session lifecycle modes a scenario may seed.
 *
 * Both members of the shared `HostMode`, and no more: a scenario names a mode
 * the product already knows how to honour, and a third member would be a
 * lifetime no dispatch path could serve.
 */
export const DEBUG_AGENT_LIFECYCLE_MODES = [
  'per-run',
  'resident',
] as const satisfies readonly HostMode[];
export type DebugAgentLifecycleMode = (typeof DEBUG_AGENT_LIFECYCLE_MODES)[number];

/**
 * What a seed with no `lifecycleMode` runs as.
 *
 * The one place the default lives, so a scenario document, a scenario literal
 * written into a test and the loader's own normalization cannot drift into three
 * answers to "what does a seed with no mode run as". `readSeed` fills the field
 * in for a document; {@link resolveScenarioLifecycleMode} answers the same
 * question for a value that never went through the loader.
 */
const DEFAULT_LIFECYCLE_MODE: DebugAgentLifecycleMode = 'per-run';

/**
 * The mode a seed asks for, with an absent field read as
 * {@link DEFAULT_LIFECYCLE_MODE}.
 *
 * Read this rather than the field: a scenario built directly (the module's own
 * tests write `DebugAgentScenario` literals) never passed through `loadScenario`,
 * so its seed may legitimately have no mode at all.
 */
export function resolveScenarioLifecycleMode(seed: DebugAgentScenarioSeed): DebugAgentLifecycleMode {
  return seed.lifecycleMode ?? DEFAULT_LIFECYCLE_MODE;
}

/** A loaded, validated scenario. Only {@link loadScenario} produces one. */
export type DebugAgentScenario = {
  version: typeof DEBUG_AGENT_SCENARIO_VERSION;
  dialect: DebugAgentDialect;
  home: DebugAgentHome;
  transcript: { mode: DebugAgentTranscriptMode };
  seed: DebugAgentScenarioSeed;
  steps: DebugAgentScenarioStep[];
  expect: DebugAgentScenarioExpectations;
};

/**
 * Raised for every refusal below, so a caller (the control plane, the arming
 * step) can tell "this document is not one I can run" apart from "the run
 * itself failed" without reading the message.
 */
function refuse(reason: string): never {
  throw new AppError(`Debug agent scenario refused: ${reason}`, {
    code: 'DEBUG_AGENT_SCENARIO_INVALID',
    statusCode: 400,
  });
}

function readClosedValue<T extends string>(
  value: unknown,
  closedSet: readonly T[],
  where: string,
): T {
  if (typeof value === 'string' && (closedSet as readonly string[]).includes(value)) {
    return value as T;
  }

  return refuse(
    `${where} is ${JSON.stringify(value)}; this build knows: ${closedSet.join(', ')}`,
  );
}

function readText(value: unknown, where: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  return refuse(`${where} must be a non-empty string`);
}

/**
 * An optional string: absent, null and the empty string all read as "none".
 *
 * Written as one reading rather than three so a document that says
 * `"sender": null` and one that omits the field mean the same thing — they are
 * the same statement about a turn nobody sent from another session, and a
 * loader that treated them differently would make the absence of a field
 * expressible as two different facts.
 */
function readOptionalText(value: unknown, where: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return readText(value, where);
}

function readStep(input: unknown, index: number): DebugAgentScenarioStep {
  const where = `steps[${index}]`;
  const step = readObjectRecord(input);
  if (!step) {
    return refuse(`${where} must be an object`);
  }

  const at = step.at;
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
    return refuse(`${where}.at must be a non-negative number of milliseconds`);
  }

  const op = readClosedValue(step.op, DEBUG_AGENT_OPS, `${where}.op`);
  switch (op) {
    case 'row':
      return {
        at,
        op,
        role: readClosedValue(step.role, DEBUG_AGENT_ROLES, `${where}.role`),
        text: readText(step.text, `${where}.text`),
      };
    case 'grow':
    case 'text-delta':
    case 'tool-result':
      return { at, op, text: readText(step.text, `${where}.text`) };
    case 'tool-call': {
      // The input is optional, and a non-object input is refused rather than
      // dropped: a schedule step's `CronCreate` expression rides on it, and a
      // document whose expression silently vanished would produce a plan the
      // criterion could not read a countdown for.
      const input = step.input === undefined || step.input === null ? undefined : readObjectRecord(step.input);
      if (step.input !== undefined && step.input !== null && !input) {
        return refuse(`${where}.input must be an object when present`);
      }
      return { at, op, name: readText(step.name, `${where}.name`), ...(input ? { input } : {}) };
    }
    case 'task-started':
      return {
        at,
        op,
        taskId: readText(step.taskId, `${where}.taskId`),
        taskType: readText(step.taskType, `${where}.taskType`),
        description: readText(step.description, `${where}.description`),
      };
    case 'task-progress':
      return {
        at,
        op,
        taskId: readText(step.taskId, `${where}.taskId`),
        description: readText(step.description, `${where}.description`),
      };
    case 'task-updated': {
      // A present-but-non-boolean flag is refused rather than coerced: the flag
      // is what says a task is a background one, and a document whose
      // `isBackgrounded: "true"` silently dropped would produce a task the
      // criterion reads as foreground — a reading nobody could attribute to a
      // cause.
      if (step.isBackgrounded !== undefined && typeof step.isBackgrounded !== 'boolean') {
        return refuse(`${where}.isBackgrounded must be a boolean when present`);
      }
      return {
        at,
        op,
        taskId: readText(step.taskId, `${where}.taskId`),
        status: readText(step.status, `${where}.status`),
        ...(step.isBackgrounded === true ? { isBackgrounded: true } : {}),
      };
    }
    case 'task-notification':
      return {
        at,
        op,
        taskId: readText(step.taskId, `${where}.taskId`),
        status: readText(step.status, `${where}.status`),
        summary: readText(step.summary, `${where}.summary`),
      };
    case 'schedule-plan':
      return {
        at,
        op,
        expression: readText(step.expression, `${where}.expression`),
        human: readText(step.human, `${where}.human`),
        prompt: readText(step.prompt, `${where}.prompt`),
      };
    // `thinking-tokens` and `turn-result` carry nothing: their whole content IS
    // their position on the clock, the same shape as `wait` and `turn-end` below.
    case 'unattended-turn': {
      // Absent and null both read as "no cause stated", which is the one value
      // the closed set below does not have to contain: the trigger is what the
      // turn's row says about itself, and a row that says nothing is a reading
      // the frontend already has a label for.
      const trigger =
        step.trigger === undefined || step.trigger === null
          ? undefined
          : readClosedValue(step.trigger, DEBUG_AGENT_TURN_TRIGGERS, `${where}.trigger`);
      const sender = readOptionalText(step.sender, `${where}.sender`);
      // A sender is only expressible on the one trigger that has another
      // conversation behind it. Refused rather than dropped: a scenario that
      // named a sender and got a turn with none would be reading its own
      // document back as something it is not, which is the class of mistake the
      // closed sets in this file exist to make impossible.
      if (sender !== null && trigger !== 'cross-session') {
        return refuse(
          `${where}.sender is ${JSON.stringify(sender)} but the trigger is ${JSON.stringify(trigger)}; only "cross-session" has another conversation to name.`,
        );
      }

      return { at, op, text: readText(step.text, `${where}.text`), trigger, sender };
    }
    case 'identity':
      return { at, op, name: readText(step.name, `${where}.name`) };
    case 'permission-request': {
      // The input is optional and a present-but-non-object is refused rather
      // than dropped, the same reading `tool-call` takes: an `AskUserQuestion`'s
      // `questions` ride on it, and a document whose options silently vanished
      // would produce a prompt the criterion could not read an expansion from.
      const input = step.input === undefined || step.input === null ? undefined : readObjectRecord(step.input);
      if (step.input !== undefined && step.input !== null && !input) {
        return refuse(`${where}.input must be an object when present`);
      }
      // A present-but-non-boolean is refused rather than coerced: the flag is
      // what says whether the walk parks or the prompt is dropped, and a
      // document whose `hold: "false"` silently read as `true` would park a walk
      // the criterion expected to keep moving.
      if (step.hold !== undefined && typeof step.hold !== 'boolean') {
        return refuse(`${where}.hold must be a boolean when present`);
      }
      const requestId = readOptionalText(step.requestId, `${where}.requestId`);
      return {
        at,
        op,
        toolName: readText(step.toolName, `${where}.toolName`),
        ...(input ? { input } : {}),
        ...(requestId !== null ? { requestId } : {}),
        // Absent means "hold the walk", the shape a plain step has; only an
        // explicit `false` asks for the dropped reading.
        hold: step.hold !== false,
      };
    }
    case 'keepalive-add':
    case 'keepalive-remove':
      return {
        at,
        op,
        kind: readClosedValue(step.kind, DEBUG_AGENT_KEEPALIVE_KINDS, `${where}.kind`),
      };
    case 'exit':
      return {
        at,
        op,
        detail: readClosedValue(step.detail, DEBUG_AGENT_EXIT_DETAILS, `${where}.detail`),
      };
    default:
      // `cancel-ack`, `dequeue`, `scroll`, `wait` and `turn-end` carry nothing:
      // they are the five steps whose whole content IS their position on the
      // clock. Their host layer reads the queue it is holding for the command a
      // step acts on, so a document cannot name one — nor should it: the uuid is
      // the host's to mint, and a scenario that restated it would be a second
      // place the two could disagree.
      return { at, op } as DebugAgentScenarioStep;
  }
}

function readSeed(input: unknown): DebugAgentScenarioSeed {
  const seed = readObjectRecord(input);
  if (!seed) {
    return refuse('seed must be an object');
  }

  return {
    title: readText(seed.title, 'seed.title'),
    userText: readText(seed.userText, 'seed.userText'),
    // Absent and null both read as `per-run`, the mode a session nobody set
    // runs as — so the field's absence states the same thing it did before the
    // field existed rather than becoming a value a reader has to special-case.
    lifecycleMode:
      seed.lifecycleMode === undefined || seed.lifecycleMode === null
        ? DEFAULT_LIFECYCLE_MODE
        : readClosedValue(seed.lifecycleMode, DEBUG_AGENT_LIFECYCLE_MODES, 'seed.lifecycleMode'),
  };
}

function readExpectations(input: unknown): DebugAgentScenarioExpectations {
  const expect = readObjectRecord(input);
  if (!expect) {
    return refuse('expect must be an object');
  }

  const rows = readObjectRecord(expect.rows);
  const delta = rows?.delta;
  if (typeof delta !== 'number' || !Number.isInteger(delta) || delta < 0) {
    return refuse('expect.rows.delta must be a non-negative integer');
  }

  const content = readObjectRecord(expect.content);
  const mustContain = content?.mustContain;
  if (!Array.isArray(mustContain) || mustContain.some((entry) => typeof entry !== 'string')) {
    return refuse('expect.content.mustContain must be an array of strings');
  }

  return { rows: { delta }, content: { mustContain: mustContain as string[] } };
}

/**
 * Validates one scenario document, or refuses it with a reason naming the value
 * it did not recognise and the set it was expected to come from.
 *
 * Validation is complete before any caller touches the filesystem: an arming
 * step that wrote a fixture transcript first and then discovered the document
 * was unreadable would leave half a scenario behind for the next run to find.
 */
export function loadScenario(input: unknown): DebugAgentScenario {
  const document: AnyRecord | null = readObjectRecord(input);
  if (!document) {
    return refuse('expected a scenario object');
  }

  if (document.version !== DEBUG_AGENT_SCENARIO_VERSION) {
    return refuse(
      `version is ${JSON.stringify(document.version)}; this build loads version ${DEBUG_AGENT_SCENARIO_VERSION}`,
    );
  }

  const transcript = readObjectRecord(document.transcript);
  if (!transcript) {
    return refuse('transcript must be an object');
  }

  if (!Array.isArray(document.steps) || document.steps.length === 0) {
    return refuse('steps must be a non-empty array');
  }

  const steps = document.steps.map(readStep);
  let previousAt = -Infinity;
  for (const [index, step] of steps.entries()) {
    if (step.at < previousAt) {
      return refuse(
        `steps[${index}].at is ${step.at}, after ${previousAt}: the scenario clock must not go backwards`,
      );
    }

    previousAt = step.at;
  }

  return {
    version: DEBUG_AGENT_SCENARIO_VERSION,
    dialect: readClosedValue(document.dialect, DEBUG_AGENT_DIALECTS, 'dialect'),
    home: readClosedValue(document.home, DEBUG_AGENT_HOMES, 'home'),
    transcript: {
      mode: readClosedValue(transcript.mode, DEBUG_AGENT_TRANSCRIPT_MODES, 'transcript.mode'),
    },
    seed: readSeed(document.seed),
    steps,
    expect: readExpectations(document.expect),
  };
}
