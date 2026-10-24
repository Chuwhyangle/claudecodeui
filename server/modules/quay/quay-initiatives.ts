import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { locateQuayFleetCli } from './quay-fleet-locator.js';

/**
 * THE INITIATIVE VIEW AND THE DECISION QUEUE, server half (M6).
 *
 * An initiative is a CROSS-PROJECT unit of work owned by quay-fleet: its charter, its member
 * projects, its dependency edges and its decision log all live in the fleet's own home
 * (`<home>/initiatives.json` + `<home>/ledgers/initiative-decisions.jsonl`). The cockpit does
 * not own that state and must not copy it — this module only READS the fleet's own documents
 * and, for a human ruling, calls the fleet's own `initiative decide` verb.
 *
 * WHY THE DECISION QUEUE READS `attention.json` DIRECTLY. `initiative escalate` writes an
 * attention item in the `initiative-decision` category carrying the typed options
 * (`{id,label}`) a person chooses between; the fleet documents that 「the panel's decision
 * queue reads them back from <home>/attention.json」 and ships no read verb for a single
 * category. Reading that one file is therefore the declared interface, not a shortcut around
 * the CLI.
 *
 * WHAT THIS MODULE NEVER DOES. It never writes the fleet's files, and it never forwards a
 * non-human provenance: the cockpit is a person's surface, so `by` is pinned to `human` here
 * and `kind` to `fact`, and the fleet derives `kind` from `by` again on its own side. A
 * liaison's self-decision can only enter this queue to be SPOT-CHECKED, never to be re-cast as
 * a human one.
 */

/** The attention category `initiative escalate` writes. */
export const INITIATIVE_DECISION_CATEGORY = 'initiative-decision';

/** The API-facing default sampling ratio for liaison self-decisions (1/5). */
export const DEFAULT_INITIATIVE_AUDIT_RATIO = 1 / 5;

/** The one reserved fleet address an initiative is known by (`quay://fleet/initiative/<slug>`). */
export const FLEET_INITIATIVE_URI_PREFIX = 'quay://fleet/initiative/';

/** Attention states that still ask something of a person. */
const LIVE_ATTENTION_STATES = new Set(['open', 'surfaced', 'acked']);

/** Epistemology tags that mean 「a liaison decided this on its own」 and are therefore sampled. */
const AUDIT_DECISION_KINDS = new Set(['inference', 'llm']);

/** The fleet's slug grammar: an address, never a path. */
const INITIATIVE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

const QUAY_FLEET_TIMEOUT_MS = 10_000;
const QUAY_FLEET_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** The answer to one fleet CLI invocation, in the same shape the registry reader uses. */
export type QuayFleetCommandResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

/** The child-process seam; production binds {@link defaultExecFile}, a test may bind a stub. */
export type QuayFleetExec = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; encoding: 'utf8'; windowsHide: boolean },
) => Promise<QuayFleetCommandResult>;

type QuayFleetExecError = Error & { code?: number | string | null; killed?: boolean };

const defaultExecFile: QuayFleetExec = (file, args, options) =>
  new Promise((resolve) => {
    execFile(file, [...args], options, (error: QuayFleetExecError | null, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
        return;
      }
      const reason = error.killed === true
        ? `quay-fleet timed out: ${error.message}`
        : error.code === 'ENOENT'
          ? `quay-fleet was not found: ${file}`
          : `quay-fleet failed: ${error.message}`;
      resolve({
        ok: false,
        code: typeof error.code === 'number' ? error.code : null,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error: reason,
      });
    });
  });

/** One typed option a person chooses between; `id` is what `decide` records as `chosen`. */
export type InitiativeDecisionOption = {
  id: string;
  label: string;
};

/** The edge kinds the fleet declares (a closed set, not a ranking). */
export type InitiativeEdgeKind = 'blocks' | 'contract' | 'release';

/** The charter fields the cockpit renders; the fleet validates these before storing them. */
export type InitiativeCharterReading = {
  intent: string;
  projects: string[];
  completionCriteria: string[];
  exitConditions: string[];
  expiresAt: string;
  grantScope: { mayDecide: string[]; mustEscalate: string[] };
};

/** One member project's task/goal refs and its liaison. */
export type InitiativeMemberReading = {
  project: string;
  taskRefs: string[];
  goalRefs: string[];
  liaison: string | null;
};

/** One dependency edge, with the blocking reading derived from the queue. */
export type InitiativeEdgeReading = {
  from: string;
  to: string;
  kind: InitiativeEdgeKind;
  /** True when the edge blocks and the initiative has a live decision pending. */
  blocked: boolean;
  /** When the block started (the oldest live escalation for the initiative); `null` if not blocked. */
  blockedSince: string | null;
};

/** One initiative as the cockpit's row draws it. */
export type InitiativeReading = {
  slug: string;
  uri: string;
  status: 'active' | 'closed';
  charter: InitiativeCharterReading;
  members: InitiativeMemberReading[];
  edges: InitiativeEdgeReading[];
};

/** One escalation waiting for a human ruling. */
export type InitiativeQueueItem = {
  attentionId: string;
  initiative: string;
  entity: string;
  question: string;
  options: InitiativeDecisionOption[];
  evidence: string[];
  projectId: string;
  firstSeenAt: string;
};

/** One liaison self-decision eligible for spot-checking. */
export type InitiativeAuditDecision = {
  initiative: string;
  at: string;
  question: string;
  options: string[];
  chosen: string;
  rationale: string;
  by: string;
  kind: string;
  refs: string[];
};

/** The successful document `GET /api/quay/initiatives` answers. */
export type InitiativeReadingDocument = {
  ok: true;
  available: true;
  initiatives: InitiativeReading[];
  decisionQueue: InitiativeQueueItem[];
  audit: InitiativeAuditDecision[];
  /** The configured sampling ratio (0–1) the UI applies to `audit`. */
  auditRatio: number;
};

/**
 * The failed document; the cockpit states the reason instead of drawing an empty board.
 *
 * `decisionQueue` is NOT emptied with the CLI: it is read from the fleet home, and an
 * escalation waiting for a person is exactly the reading this view exists for. Losing it
 * because the initiative list could not be spawned would hide the one thing to act on.
 */
export type InitiativeReadingUnavailable = {
  ok: false;
  available: false;
  reason: string;
  initiatives: [];
  decisionQueue: InitiativeQueueItem[];
  audit: [];
  auditRatio: number;
};

export type InitiativeReadingAnswer = InitiativeReadingDocument | InitiativeReadingUnavailable;

/** A human ruling to record through the fleet's own `initiative decide`. */
export type InitiativeDecisionInput = {
  question: string;
  options: InitiativeDecisionOption[];
  chosen: string;
  rationale: string;
  refs: string[];
  /** Always `human`; `fact` follows from it. Kept explicit so the transport can be checked. */
  by: 'human';
  kind: 'fact';
};

export type InitiativeDecisionResult =
  | {
      ok: true;
      decision: {
        at: string;
        initiative: string;
        by: string;
        kind: string;
        question: string;
        options: string[];
        chosen: string;
        rationale: string;
        refs: string[];
      };
      attentionClosed: unknown[];
    }
  | { ok: false; reason: string; detail?: string };

/** The seam the module exposes to the routes and to criteria. */
export type QuayInitiativesService = {
  read(): Promise<InitiativeReadingAnswer>;
  decide(slug: string, input: InitiativeDecisionInput): Promise<InitiativeDecisionResult>;
};

export type QuayInitiativesDependencies = {
  /** The fleet CLI to spawn. Defaults to the shared locator (env → PATH → ~/.quay-fleet/bin). */
  binPath?: string;
  /** Child-process seam, defaulting to Node's `execFile`. */
  exec?: QuayFleetExec;
  /**
   * The fleet state directory. Defaults to `$QUAY_FLEET_HOME`, then `~/.quay-fleet` — the
   * same rule the CLI itself applies, so the file this module reads is the file the fleet wrote.
   */
  home?: string;
  /** Sampling ratio for `kind ∈ {inference, llm}` decisions; defaults to 1/5. */
  auditRatio?: number;
  /**
   * A lazy ratio provider, used by the composition root instead of `auditRatio` when the
   * server-settings module is part of an import cycle: calling it at module-evaluation time
   * would read that module before its own constants exist. Called on the first read and
   * memoized, so the settings file is still read exactly once per process.
   */
  resolveAuditRatio?: () => number;
};

/** Parses a JSON object, or `null` when the child printed something else. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A non-empty trimmed string, or `null`. */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A string list; anything malformed reads as empty rather than throwing at the UI. */
function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
}

/** The fleet home the CLI writes to, following the CLI's own resolution order. */
export function resolveFleetHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env.QUAY_FLEET_HOME?.trim();
  return configured !== undefined && configured !== ''
    ? configured
    : path.join(os.homedir(), '.quay-fleet');
}

/** The reserved address of one initiative. */
export function initiativeUri(slug: string): string {
  return `${FLEET_INITIATIVE_URI_PREFIX}${slug}`;
}

/** Reads the `slug` out of `initiative:<slug>@<fingerprint>`; `null` for any other entity. */
export function initiativeSlugFromEntity(entity: unknown): string | null {
  const text = asString(entity);
  if (text === null) return null;
  const match = /^initiative:([a-z0-9][a-z0-9-]*)@/.exec(text);
  return match === null ? null : match[1]!;
}

/**
 * The question an escalation carries.
 *
 * THE FLEET STORES IT IN THE EVIDENCE ITEM, NOT ON THE ENTRY. `upsertEntry`'s entry shape has
 * no `reason`/`question` field: the candidate's `reason` is copied into each evidence item
 * (`evidence[].reason`), which is what `initiative escalate` writes as
 * `initiative escalate: <question>`. A hand-written row may carry a top-level `reason` or
 * `question`, so both are accepted first; the newest evidence item is the fallback (the last
 * `escalate` of the same question is the current statement of it). With none of those, the
 * honest reading is the entity — the options are still usable.
 */
export function questionFromAttention(entry: Record<string, unknown>, entity: string): string {
  const prefix = 'initiative escalate: ';
  const strip = (value: string): string => (value.startsWith(prefix) ? value.slice(prefix.length) : value);

  const topLevel = asString(entry.reason) ?? asString(entry.question);
  if (topLevel !== null) return strip(topLevel);

  const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const item = evidence[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const reason = asString((item as Record<string, unknown>).reason);
    if (reason !== null) return strip(reason);
  }
  return entity;
}

/** One typed option row, or `null` when it is not `{id,label}`. */
function readOption(value: unknown): InitiativeDecisionOption | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  const label = asString(record.label);
  return id === null || label === null ? null : { id, label };
}

/** The evidence references an attention entry carries, as display strings. */
function readEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const refs: string[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const ref = asString(record.ref);
    const reason = asString(record.reason);
    const combined = ref === null ? reason : reason === null ? ref : `${ref} — ${reason}`;
    if (combined !== null && !refs.includes(combined)) refs.push(combined);
  }
  return refs;
}

/** A stored decision row as the audit group reads it; `null` when it is not one. */
function readAuditDecision(value: unknown): InitiativeAuditDecision | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = asString(record.kind);
  const initiative = asString(record.initiative);
  if (kind === null || initiative === null || !AUDIT_DECISION_KINDS.has(kind)) return null;
  return {
    initiative,
    at: asString(record.at) ?? '',
    question: asString(record.question) ?? '',
    options: asStringList(record.options),
    chosen: asString(record.chosen) ?? '',
    rationale: asString(record.rationale) ?? '',
    by: asString(record.by) ?? '',
    kind,
    refs: asStringList(record.refs),
  };
}

/** The charter projection; a malformed field reads as empty rather than failing the whole view. */
function readCharter(value: unknown): InitiativeCharterReading {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const scope = record.grantScope !== null && typeof record.grantScope === 'object'
    ? (record.grantScope as Record<string, unknown>)
    : {};
  return {
    intent: asString(record.intent) ?? '',
    projects: asStringList(record.projects),
    completionCriteria: asStringList(record.completionCriteria),
    exitConditions: asStringList(record.exitConditions),
    expiresAt: asString(record.expiresAt) ?? '',
    grantScope: {
      mayDecide: asStringList(scope.mayDecide),
      mustEscalate: asStringList(scope.mustEscalate),
    },
  };
}

/** The member projection; a malformed row is skipped. */
function readMembers(value: unknown): InitiativeMemberReading[] {
  if (!Array.isArray(value)) return [];
  const members: InitiativeMemberReading[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const project = asString(record.project);
    if (project === null) continue;
    members.push({
      project,
      taskRefs: asStringList(record.taskRefs),
      goalRefs: asStringList(record.goalRefs),
      liaison: asString(record.liaison),
    });
  }
  return members;
}

/** An edge kind, or `null` for anything outside the closed set. */
function readEdgeKind(value: unknown): InitiativeEdgeKind | null {
  return value === 'blocks' || value === 'contract' || value === 'release' ? value : null;
}

/**
 * Whether a blocking edge is answered by a live escalation.
 *
 * A `blocks` edge is highlighted while a question about THIS initiative waits for a person.
 * When the escalation names the blocked project (`--project <id>`), only the edge whose target
 * is that project's address is highlighted; an escalation with no project attribution (the
 * fleet's default is its own id) blocks the initiative's blocking edges as a whole. The
 * duration is the oldest live escalation's `firstSeenAt`, so re-escalating the same question
 * does not reset the clock.
 */
function blockedSinceFor(
  edge: { from: string; to: string; kind: InitiativeEdgeKind },
  queue: readonly InitiativeQueueItem[],
): string | null {
  if (edge.kind !== 'blocks') return null;
  const attributed = queue.filter(
    (item) =>
      item.projectId !== 'quay-fleet' &&
      (edge.to.startsWith(`quay://${item.projectId}/`) || edge.from.startsWith(`quay://${item.projectId}/`)),
  );
  const relevant = attributed.length > 0
    ? attributed
    : queue.filter((item) => item.projectId === 'quay-fleet' || item.projectId === '');
  const since = relevant
    .map((item) => item.firstSeenAt)
    .filter((value) => value !== '')
    .sort()[0];
  return since ?? null;
}

/** The fleet home's attention ledger, read defensively: absent/unreadable reads as empty. */
function readAttentionEntries(home: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(home, 'attention.json'), 'utf8');
  } catch {
    return [];
  }
  const document = parseJsonObject(raw);
  const entries = document?.entries;
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return [];
  return Object.values(entries as Record<string, unknown>).filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry),
  );
}

/**
 * Builds the initiative reading service.
 *
 * The binary and the home are resolved per call, so installing the fleet (or pointing
 * `QUAY_FLEET_HOME` at another deployment) reaches the next read without a restart.
 */
export function createQuayInitiatives(
  dependencies: QuayInitiativesDependencies = {},
): QuayInitiativesService {
  const exec = dependencies.exec ?? defaultExecFile;
  // Resolved once, on demand: a provider exists because this module is composed during an
  // import cycle with the settings module (its exported constants are not initialised yet
  // while the composition root runs), while a test supplies the number directly.
  let auditRatio: number | null = null;
  const readAuditRatio = (): number => {
    auditRatio ??= clampRatio(
      dependencies.auditRatio ?? dependencies.resolveAuditRatio?.() ?? DEFAULT_INITIATIVE_AUDIT_RATIO,
    );
    return auditRatio;
  };

  const resolveBinPath = (): string | null =>
    dependencies.binPath
    ?? locateQuayFleetCli().binPath
    ?? (dependencies.exec === undefined ? null : 'quay-fleet');

  const run = async (args: readonly string[]): Promise<QuayFleetCommandResult> => {
    const binPath = resolveBinPath();
    if (binPath === null) {
      return {
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: 'quay-fleet was not found (checked QUAY_FLEET_BIN, PATH and ~/.quay-fleet/bin/quay-fleet)',
      };
    }
    return exec(binPath, args, {
      timeout: QUAY_FLEET_TIMEOUT_MS,
      maxBuffer: QUAY_FLEET_MAX_OUTPUT_BYTES,
      encoding: 'utf8',
      windowsHide: true,
    });
  };

  const unavailable = (
    reason: string,
    decisionQueue: InitiativeQueueItem[] = [],
  ): InitiativeReadingUnavailable => ({
    ok: false,
    available: false,
    reason,
    initiatives: [],
    decisionQueue,
    audit: [],
    auditRatio: readAuditRatio(),
  });

  /** Reads one initiative's decision ledger through `initiative show --json`. */
  const readDecisions = async (slug: string): Promise<InitiativeAuditDecision[]> => {
    const result = await run(['initiative', 'show', slug, '--json']);
    if (!result.ok) return [];
    const document = parseJsonObject(result.stdout);
    if (document === null || !Array.isArray(document.decisions)) return [];
    return document.decisions
      .map((row) => readAuditDecision(row))
      .filter((row): row is InitiativeAuditDecision => row !== null);
  };

  return {
    async read() {
      const home = dependencies.home ?? resolveFleetHome();
      // The queue is read even when the CLI cannot answer: an escalation waiting for a person
      // is exactly the reading this view exists for, and losing it with the CLI would hide the
      // one thing a person must act on.
      const queue: InitiativeQueueItem[] = readAttentionEntries(home)
        .filter((entry) => entry.category === INITIATIVE_DECISION_CATEGORY)
        .filter((entry) => typeof entry.state === 'string' && LIVE_ATTENTION_STATES.has(entry.state))
        .map((entry) => {
          const entity = asString(entry.entity) ?? '';
          const initiative = initiativeSlugFromEntity(entity);
          return initiative === null
            ? null
            : {
                attentionId: asString(entry.attentionId) ?? '',
                initiative,
                entity,
                question: questionFromAttention(entry, entity),
                options: Array.isArray(entry.options)
                  ? entry.options
                      .map((option) => readOption(option))
                      .filter((option): option is InitiativeDecisionOption => option !== null)
                  : [],
                evidence: readEvidence(entry.evidence),
                projectId: asString(entry.projectId) ?? '',
                firstSeenAt: asString(entry.firstSeenAt) ?? '',
              };
        })
        .filter((item): item is InitiativeQueueItem => item !== null)
        .sort((left, right) => left.firstSeenAt.localeCompare(right.firstSeenAt));

      const listed = await run(['initiative', 'list', '--json']);
      if (!listed.ok) {
        return unavailable(
          listed.error ?? `quay-fleet initiative list exited ${listed.code === null ? 'without a status' : listed.code}`,
          queue,
        );
      }
      const document = parseJsonObject(listed.stdout);
      if (document === null || !Array.isArray(document.initiatives)) {
        return unavailable('quay-fleet initiative list did not carry an initiatives array', queue);
      }

      const rows = document.initiatives.filter(
        (row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row),
      );

      const initiatives: InitiativeReading[] = [];
      const audit: InitiativeAuditDecision[] = [];
      for (const row of rows) {
        const slug = asString(row.slug);
        if (slug === null || !INITIATIVE_SLUG.test(slug)) continue;
        const charter = readCharter(row.charter);
        const forInitiative = queue.filter((item) => item.initiative === slug);
        const rawEdges = Array.isArray(row.edges) ? row.edges : [];
        const edges: InitiativeEdgeReading[] = [];
        for (const rawEdge of rawEdges) {
          if (rawEdge === null || typeof rawEdge !== 'object' || Array.isArray(rawEdge)) continue;
          const edge = rawEdge as Record<string, unknown>;
          const from = asString(edge.from);
          const to = asString(edge.to);
          const kind = readEdgeKind(edge.kind);
          if (from === null || to === null || kind === null) continue;
          const blockedSince = blockedSinceFor({ from, to, kind }, forInitiative);
          edges.push({ from, to, kind, blocked: blockedSince !== null, blockedSince });
        }
        initiatives.push({
          slug,
          uri: initiativeUri(slug),
          status: row.status === 'closed' ? 'closed' : 'active',
          charter,
          members: readMembers(row.members),
          edges,
        });
        audit.push(...(await readDecisions(slug)));
      }

      // A queue item whose initiative the list did not return is still reported: it is a
      // person's pending question, and the list's scope (active by default) is the fleet's.
      return {
        ok: true,
        available: true,
        initiatives,
        decisionQueue: queue,
        audit,
        auditRatio: readAuditRatio(),
      };
    },

    async decide(slug, input) {
      if (!INITIATIVE_SLUG.test(slug)) {
        return { ok: false, reason: 'invalid-initiative-slug' };
      }
      if (input.by !== 'human' || input.kind !== 'fact') {
        return { ok: false, reason: 'human-fact-required' };
      }
      const optionIds = input.options.map((option) => option.id);
      const args = [
        'initiative',
        'decide',
        slug,
        '--question',
        input.question,
        '--options',
        JSON.stringify(optionIds),
        '--chosen',
        input.chosen,
        '--rationale',
        input.rationale,
        '--by',
        'human',
        '--json',
      ];
      for (const ref of input.refs) args.push('--refs', ref);
      const result = await run(args);
      const document = parseJsonObject(result.stdout);
      if (document === null) {
        return {
          ok: false,
          reason: result.ok ? 'fleet-cli-invalid-output' : 'fleet-cli-unavailable',
          ...(result.error === undefined ? {} : { detail: result.error }),
        };
      }
      if (document.ok !== true) {
        const reason = asString(document.reason) ?? 'fleet-decide-refused';
        const detail = asString(document.message) ?? asString(document.detail);
        return { ok: false, reason, ...(detail === null ? {} : { detail }) };
      }
      const decision = document.decision;
      const record = decision !== null && typeof decision === 'object' && !Array.isArray(decision)
        ? (decision as Record<string, unknown>)
        : {};
      return {
        ok: true,
        decision: {
          at: asString(record.at) ?? '',
          initiative: asString(record.initiative) ?? slug,
          by: asString(record.by) ?? 'human',
          kind: asString(record.kind) ?? 'fact',
          question: asString(record.question) ?? input.question,
          options: asStringList(record.options),
          chosen: asString(record.chosen) ?? input.chosen,
          rationale: asString(record.rationale) ?? input.rationale,
          refs: asStringList(record.refs),
        },
        attentionClosed: Array.isArray(document.attentionClosed) ? document.attentionClosed : [],
      };
    },
  };
}

/** A ratio clamped to (0, 1]; a malformed value falls back to the shipped 1/5. */
function clampRatio(value: number): number {
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : DEFAULT_INITIATIVE_AUDIT_RATIO;
}
