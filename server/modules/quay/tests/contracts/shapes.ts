/**
 * The JSON shape declarations for every `quay-fleet` CLI contract CloudCLI consumes.
 *
 * WHY THIS FILE EXISTS. CloudCLI talks to a separately versioned program — the installed
 * `quay-fleet` — through plain JSON on stdout. Until this file, every consumer parsed that JSON
 * with its own hand-written reader and no test ever compared the READER against the REAL CLI:
 * the two sides were validated independently, so a rename in the fleet's output was discovered
 * only after both repositories had merged. The concrete case that motivated this file is the
 * project-segment disagreement (`quay://task/<id>` vs `quay://<project>/task/<id>`): each side's
 * own tests were green, and the breakage only appeared when the two real programs met.
 *
 * A contract here is therefore (a) the exact argv CloudCLI runs and (b) a declared shape for the
 * JSON it must answer with. `fleet-cli-contracts.test.ts` invokes the INSTALLED fleet and checks
 * every answer against these declarations, so an incompatible change on either side reds before
 * merge instead of in production.
 *
 * THE LYING RISK THIS FILE MUST NOT HAVE. A shape that accepts everything protects nothing. The
 * declarations below therefore name the fields CloudCLI actually reads as REQUIRED, pin the
 * closed-vocabulary ones to their legal values (the trivalent readings the fleet uses throughout:
 * `ok` / `absent` / `invalid`, and `string | null`), and let UNDECLARED fields through on purpose
 * — a fleet that ADDS a field stays compatible, which is exactly the forward-compatibility rule
 * the contract must encode.
 *
 * ADDING A CONSUMER. Whenever CloudCLI starts invoking a new `quay-fleet` verb (or starts reading
 * a new field from an existing one), add the invocation and its shape here AND a case to
 * `fleet-cli-contracts.test.ts`. The rule and its rationale are repeated in `README.md`, which is
 * where a human adding a consumer is expected to look first.
 *
 * Consumers: `fleet-cli-contracts.test.ts` (drives the installed CLI against these declarations);
 * `quay-fleet-locator.ts`, `quay-fleet-project-id.ts`, `quay-fleet-registry.ts` and
 * `quay-uri-resolve.ts` are the production readers each `consumer` field names.
 */

//----------------- the shape language ------------

/**
 * One declared JSON node.
 *
 * `optional` means the KEY may be absent; `nullable` means a PRESENT key may hold `null`. The
 * two are different facts (the fleet omits state-dependent fields and emits `null` for a reading
 * it could not take), and the fleet's documents use both, so the language keeps them separate.
 */
export type Shape =
  | StringShape
  | NumberShape
  | BooleanShape
  | ArrayShape
  | ObjectShape;

type ShapeBase = {
  /** The key may be absent. */
  optional?: boolean;
  /** A present value may be `null`. */
  nullable?: boolean;
};

/** A JSON string, optionally restricted to a closed vocabulary. */
export type StringShape = ShapeBase & {
  type: 'string';
  values?: readonly string[];
};

/** A JSON number, optionally an integer, optionally restricted to a closed vocabulary. */
export type NumberShape = ShapeBase & {
  type: 'number';
  integer?: boolean;
  values?: readonly number[];
};

/** A JSON boolean, optionally pinned to one value (`values: [true]` = "the fleet said ok"). */
export type BooleanShape = ShapeBase & {
  type: 'boolean';
  values?: readonly boolean[];
};

/** A JSON array of one declared item shape. */
export type ArrayShape = ShapeBase & {
  type: 'array';
  items: Shape;
};

/** A JSON object whose declared fields are each validated by their own shape. Extra keys pass. */
export type ObjectShape = ShapeBase & {
  type: 'object';
  fields: Readonly<Record<string, Shape>>;
};

/** The first mismatch found while validating a document, addressed by JSON path. */
export type ShapeViolation = {
  /** JSON path of the offending node, e.g. `$.projects[0].root`. */
  path: string;
  /** One sentence naming what the declaration expected and what the document held. */
  message: string;
};

/** Human-readable rendering of a declared node, used in violation messages. */
function describeShape(shape: Shape): string {
  const vocabulary = 'values' in shape && shape.values !== undefined
    ? ` (${shape.values.join('|')})`
    : '';
  const base = shape.type === 'array' ? `array<${describeShape(shape.items)}>` : `${shape.type}${vocabulary}`;
  return shape.nullable === true ? `${base} | null` : base;
}

/** A short, safe description of a value for a violation message. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  return typeof value;
}

/**
 * Validates `value` against `shape`, returning the FIRST violation or `null`.
 *
 * The first violation is returned (not a list) because the caller's job is to red and NAME the
 * field that drifted; a document that fails in five places almost always drifted in one place
 * that the other four sit under, and printing the first path is what makes that visible.
 */
export function validateShape(value: unknown, shape: Shape, path = '$'): ShapeViolation | null {
  if (value === undefined) {
    return shape.optional === true
      ? null
      : { path, message: `required field ${path} is missing (expected ${describeShape(shape)})` };
  }
  if (value === null) {
    return shape.nullable === true
      ? null
      : { path, message: `${path} is null (expected ${describeShape(shape)})` };
  }

  switch (shape.type) {
    case 'string': {
      if (typeof value !== 'string') {
        return { path, message: `${path} is ${describeValue(value)} (expected ${describeShape(shape)})` };
      }
      if (shape.values !== undefined && !shape.values.includes(value)) {
        return { path, message: `${path} is ${JSON.stringify(value)} (expected one of ${shape.values.join('|')})` };
      }
      return null;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { path, message: `${path} is ${describeValue(value)} (expected ${describeShape(shape)})` };
      }
      if (shape.integer === true && !Number.isInteger(value)) {
        return { path, message: `${path} is ${value} (expected an integer)` };
      }
      if (shape.values !== undefined && !shape.values.includes(value)) {
        return { path, message: `${path} is ${value} (expected one of ${shape.values.join('|')})` };
      }
      return null;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        return { path, message: `${path} is ${describeValue(value)} (expected ${describeShape(shape)})` };
      }
      if (shape.values !== undefined && !shape.values.includes(value)) {
        return { path, message: `${path} is ${value} (expected ${shape.values.join('|')})` };
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        return { path, message: `${path} is ${describeValue(value)} (expected ${describeShape(shape)})` };
      }
      for (let index = 0; index < value.length; index += 1) {
        const violation = validateShape(value[index], shape.items, `${path}[${index}]`);
        if (violation !== null) return violation;
      }
      return null;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { path, message: `${path} is ${describeValue(value)} (expected ${describeShape(shape)})` };
      }
      const record = value as Record<string, unknown>;
      for (const [name, fieldShape] of Object.entries(shape.fields)) {
        const violation = validateShape(record[name], fieldShape, `${path}.${name}`);
        if (violation !== null) return violation;
      }
      return null;
    }
  }
}

//----------------- the invocations ------------

/** Everything a contract's argv needs; values are resolved from the live fleet at test time. */
export type FleetCliContractContext = {
  /** The fleet registry id used as the URI's project segment. */
  project: string;
  /** That project's registered root. `wall summary` passes it as `--root`. */
  projectRoot: string;
  /** A syntactically valid task id used to build the reference (never dereferenced by L1). */
  taskId: string;
  /** The session id a `set` invocation pins; a literal UUID is not required by the fleet. */
  sessionId: string;
};

/**
 * One consumed CLI invocation and the shape its stdout must satisfy.
 *
 * `writes: true` is a STRUCTURAL flag, not documentation: `fleet-cli-contracts.test.ts` refuses to
 * run a writing contract unless it was handed a temporary `QUAY_FLEET_HOME`, so the operator's
 * real fleet home can never be the target of a test.
 */
export type FleetCliContract = {
  /** Stable id printed in every failure and per-contract report line. */
  id: string;
  /** The CloudCLI reader that consumes this invocation. */
  consumer: string;
  /** True when the verb mutates the fleet home (must run against a temporary home). */
  writes: boolean;
  /** The argv after the binary path. */
  argv(context: FleetCliContractContext): readonly string[];
  /** The declared JSON shape of the answer. */
  shape: Shape;
};

/** The canonical project-scoped task reference, including the `#ac-<n>` fragment form. */
function taskUri(context: FleetCliContractContext): string {
  return `quay://${context.project}/task/${context.taskId}#ac-2`;
}

//----------------- the declarations ------------

/**
 * `quay-fleet --version --json` — the compatibility handshake.
 *
 * `contracts` is what decides compatibility (the version string is informational); the locator's
 * `readContracts` requires exactly these three members and their types.
 */
export const HANDSHAKE_SHAPE: Shape = {
  type: 'object',
  fields: {
    name: { type: 'string', optional: true },
    version: { type: 'string' },
    contracts: {
      type: 'object',
      fields: {
        wallUri: { type: 'string' },
        registry: { type: 'number', integer: true },
        interfaceSession: { type: 'string' },
      },
    },
  },
};

/**
 * `quay-fleet wall resolve <uri> --json` — the L1 reference.
 *
 * The test always asks for the fragment form (`#ac-<n>`), so `fragment` is REQUIRED here rather
 * than optional: dropping it would silently stop exercising the branch CloudCLI renders.
 */
export const WALL_RESOLVE_SHAPE: Shape = {
  type: 'object',
  fields: {
    ok: { type: 'boolean', values: [true] },
    project: { type: 'string' },
    uri: { type: 'string' },
    type: { type: 'string', values: ['task', 'goal', 'ledger', 'board'] },
    label: { type: 'string' },
    actions: { type: 'array', items: { type: 'string' } },
    fragment: {
      type: 'object',
      fields: {
        kind: { type: 'string', values: ['ac'] },
        index: { type: 'number', integer: true },
      },
    },
  },
};

/**
 * `quay-fleet wall summary <uri> --root <dir> --json` — the L2 reading.
 *
 * Three-valued on purpose: `ok` carries the stored summary, `absent` is an honest reading of the
 * write path (no row stored yet), and `invalid` means the URI itself was rejected. CloudCLI's
 * `readFleetL2` treats `ok`/`absent` as readings and everything else as unreadable, so the three
 * states must stay distinguishable here.
 */
export const WALL_SUMMARY_SHAPE: Shape = {
  type: 'object',
  fields: {
    state: { type: 'string', values: ['ok', 'absent', 'invalid'] },
    uri: { type: 'string', nullable: true },
    summary: { type: 'string', optional: true },
    generatedAt: { type: 'string', nullable: true, optional: true },
    sourceEventId: { type: 'string', nullable: true, optional: true },
    ledgers: { type: 'number', integer: true, optional: true },
    unreadable: { type: 'number', integer: true, optional: true },
    reason: { type: 'string', optional: true },
  },
};

/**
 * `quay-fleet registry list --json` — the registry document.
 *
 * Both the project-id join and the interface-session writer read `projects[].id` and
 * `projects[].root` and nothing else; `enabled`/`self`/`draftTasks` are declared because they are
 * part of the row but remain optional: the join deliberately ignores `enabled`.
 */
export const REGISTRY_LIST_SHAPE: Shape = {
  type: 'object',
  fields: {
    version: { type: 'number', integer: true },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        fields: {
          id: { type: 'string' },
          root: { type: 'string' },
          enabled: { type: 'boolean', optional: true },
          self: { type: 'boolean', optional: true },
          draftTasks: { type: 'boolean', optional: true },
        },
      },
    },
    interfaceSessionIds: { type: 'array', items: { type: 'string' }, optional: true, nullable: true },
    devSessionIds: { type: 'array', items: { type: 'string' }, optional: true, nullable: true },
  },
};

/**
 * `quay-fleet registry interface-session get <project> --json` — the pinned 对人接口会话.
 *
 * `interfaceSessionId` is the trivalent reading the cockpit renders: an id, `null` (nothing
 * pinned), or — on a refusal — no success document at all (`ok:false` + `reason`), which the
 * success shape below does not accept. The test invokes a registered project, so `ok:true` is
 * the contract it must satisfy.
 */
export const INTERFACE_SESSION_GET_SHAPE: Shape = {
  type: 'object',
  fields: {
    ok: { type: 'boolean', values: [true] },
    project: { type: 'string' },
    interfaceSessionId: { type: 'string', nullable: true },
  },
};

/** `registry interface-session set|clear` — the same answer plus the fleet's `changed` flag. */
export const INTERFACE_SESSION_WRITE_SHAPE: Shape = {
  type: 'object',
  fields: {
    ok: { type: 'boolean', values: [true] },
    project: { type: 'string' },
    interfaceSessionId: { type: 'string', nullable: true },
    changed: { type: 'boolean', optional: true },
  },
};

// The fleet's `status` document is the largest contract, but CloudCLI consumes it section by
// section. Every field below is one a reader or the cockpit displays; nested extras (the outbox's
// per-class attribution detail, for example) are deliberately not declared — they may grow.
const DRIVER_READ_SHAPE: Shape = {
  type: 'object',
  nullable: true,
  fields: {
    state: { type: 'string', nullable: true },
    ageSec: { type: 'number', nullable: true },
  },
};

/** The four driver kinds `quay-fleet status` reports per project (`DRIVER_KINDS`). */
const DRIVER_KINDS = ['worker', 'promotion', 'goal', 'outer'] as const;

/** `quay-fleet status --json` — heartbeat, takeover state, and per-project board readings. */
export const STATUS_SHAPE: Shape = {
  type: 'object',
  fields: {
    at: { type: 'string' },
    service: {
      type: 'object',
      nullable: true,
      fields: {
        pid: { type: 'number', nullable: true },
        tick: { type: 'number', nullable: true },
        at: { type: 'string', nullable: true },
        ageSec: { type: 'number', nullable: true },
        alive: { type: 'boolean', nullable: true },
        lastTickMs: { type: 'number', nullable: true },
        projects: { type: 'number', nullable: true },
        eventsThisTick: { type: 'number', nullable: true },
        errors: { type: 'number', nullable: true },
      },
    },
    halted: {
      type: 'object',
      nullable: true,
      fields: {
        at: { type: 'string' },
        project: { type: 'string', nullable: true },
        reason: { type: 'string', nullable: true },
      },
    },
    autonomy: { type: 'string', values: ['L0', 'L1', 'L2'] },
    autonomyExplicit: { type: 'boolean' },
    policyVersion: { type: 'string', nullable: true },
    decisions: {
      type: 'object',
      fields: {
        total: { type: 'number', integer: true },
        byGrade: {
          type: 'object',
          fields: {
            ignore: { type: 'number', integer: true },
            record: { type: 'number', integer: true },
            notify: { type: 'number', integer: true },
            escalate: { type: 'number', integer: true },
          },
        },
        latestAt: { type: 'string', nullable: true },
      },
    },
    attention: {
      type: 'object',
      fields: {
        total: { type: 'number', integer: true },
        byState: {
          type: 'object',
          fields: {
            open: { type: 'number', integer: true },
            surfaced: { type: 'number', integer: true },
            acked: { type: 'number', integer: true },
            resolved: { type: 'number', integer: true },
            expired: { type: 'number', integer: true },
          },
        },
        byGrade: {
          type: 'object',
          fields: {
            notify: { type: 'number', integer: true },
            escalate: { type: 'number', integer: true },
          },
        },
        oldestLiveAt: { type: 'string', nullable: true },
      },
    },
    outbox: {
      type: 'object',
      fields: {
        total: { type: 'number', integer: true },
        queued: { type: 'number', integer: true },
        surfaced: { type: 'number', integer: true },
        acked: { type: 'number', integer: true },
        pending: { type: 'number', integer: true },
        receipts: { type: 'number', integer: true },
        budget: {
          type: 'object',
          fields: {
            notifyPerHour: { type: 'number', nullable: true },
            notifyPerDay: { type: 'number', nullable: true },
            escalatePerDay: { type: 'number', nullable: true },
            remainingHour: { type: 'number', nullable: true },
            remainingDay: { type: 'number', nullable: true },
            remainingEscalateDay: { type: 'number', nullable: true },
          },
        },
        budgetExhausted: { type: 'number', integer: true },
      },
    },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        fields: {
          projectId: { type: 'string' },
          root: { type: 'string' },
          snapshot: { type: 'boolean', nullable: true },
          observedAt: { type: 'string', nullable: true },
          counts: {
            type: 'object',
            nullable: true,
            fields: {
              todo: { type: 'number', integer: true },
              ready: { type: 'number', integer: true },
              'needs-human': { type: 'number', integer: true },
              done: { type: 'number', integer: true },
              superseded: { type: 'number', integer: true },
            },
          },
          anchorAlive: { type: 'boolean', nullable: true },
          drivers: {
            type: 'object',
            nullable: true,
            fields: Object.fromEntries(
              DRIVER_KINDS.map((kind) => [kind, DRIVER_READ_SHAPE] as const),
            ),
          },
        },
      },
    },
    codeDrift: { type: 'boolean', nullable: true, optional: true },
    codeVersion: {
      type: 'object',
      fields: {
        state: { type: 'string', values: ['ok', 'not-evaluated'] },
        reason: { type: 'string', nullable: true },
        basis: { type: 'string', nullable: true },
        root: { type: 'string', nullable: true },
        loadedHead: { type: 'string', nullable: true },
        currentHead: { type: 'string', nullable: true },
        loadedFingerprint: { type: 'string', nullable: true },
        currentFingerprint: { type: 'string', nullable: true },
        headMoved: { type: 'boolean', nullable: true },
        loadedAt: { type: 'string', nullable: true },
        fallbackReason: { type: 'string', nullable: true },
        codeDrift: { type: 'boolean', nullable: true },
      },
    },
    interfaceSessions: {
      type: 'object',
      fields: {
        state: { type: 'string', values: ['ok', 'not-evaluated'] },
        checkedAt: { type: 'string' },
        declared: { type: 'number', integer: true },
        live: { type: 'array', items: { type: 'string' } },
        stale: { type: 'array', items: { type: 'string' } },
        notEvaluated: { type: 'array', items: { type: 'string' } },
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            fields: {
              sessionId: { type: 'string' },
              state: { type: 'string', values: ['live', 'stale', 'not-evaluated'] },
              stale: { type: 'boolean', nullable: true },
              hostState: { type: 'string', nullable: true },
              running: { type: 'boolean', nullable: true },
              hostId: { type: 'string', nullable: true },
              reason: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
  },
};

/**
 * Every contract CloudCLI consumes. Order is the report order; the handshake is first because a
 * listener reading the output needs the negotiated version before the verb results.
 */
export const FLEET_CLI_CONTRACTS: readonly FleetCliContract[] = [
  {
    id: 'version-handshake',
    consumer: 'quay-fleet-locator.ts (createQuayFleetCliReader)',
    writes: false,
    argv: () => ['--version', '--json'],
    shape: HANDSHAKE_SHAPE,
  },
  {
    id: 'wall-resolve',
    consumer: 'quay-uri-resolve.ts (readFleetL1)',
    writes: false,
    argv: (context) => ['wall', 'resolve', taskUri(context), '--json'],
    shape: WALL_RESOLVE_SHAPE,
  },
  {
    id: 'wall-summary',
    consumer: 'quay-uri-resolve.ts (readFleetL2)',
    writes: false,
    argv: (context) => ['wall', 'summary', taskUri(context), '--root', context.projectRoot, '--json'],
    shape: WALL_SUMMARY_SHAPE,
  },
  {
    id: 'registry-list',
    consumer: 'quay-fleet-project-id.ts / quay-fleet-registry.ts',
    writes: false,
    argv: () => ['registry', 'list', '--json'],
    shape: REGISTRY_LIST_SHAPE,
  },
  {
    id: 'registry-interface-session-get',
    consumer: 'quay-fleet-registry.ts (readInterfaceSession)',
    writes: false,
    argv: (context) => ['registry', 'interface-session', 'get', context.project, '--json'],
    shape: INTERFACE_SESSION_GET_SHAPE,
  },
  {
    id: 'status',
    consumer: 'cockpit / operator status reading',
    writes: false,
    argv: () => ['status', '--json'],
    shape: STATUS_SHAPE,
  },
  {
    id: 'registry-interface-session-set',
    consumer: 'quay-fleet-registry.ts (writeInterfaceSession)',
    writes: true,
    argv: (context) => ['registry', 'interface-session', 'set', context.project, context.sessionId, '--json'],
    shape: INTERFACE_SESSION_WRITE_SHAPE,
  },
  {
    id: 'registry-interface-session-clear',
    consumer: 'quay-fleet-registry.ts (writeInterfaceSession)',
    writes: true,
    argv: (context) => ['registry', 'interface-session', 'clear', context.project, '--json'],
    shape: INTERFACE_SESSION_WRITE_SHAPE,
  },
];
