/**
 * M3 — liaison delivery by (initiative, project).
 *
 * The mechanism this file implements is small on purpose: given an initiative and a target
 * project, ask the fleet registry which session is that pair's LIAISON session, and hand the
 * message to CloudCLI's existing session send service — or, when nobody is there to take it,
 * queue it in the initiative's inbox until the session comes back.
 *
 * ## Why the resolution is a REGISTRY READ and never a name
 *
 * `fleet-liaison-stable-addressing-probe` (2026-10-24) measured what is stable across a
 * restart: the CloudCLI session id is the only identity a registry row can hold that survives
 * the process, while `pid` changes every launch (and can be reused) and `name` is not an
 * address at all — three live sessions shared one name on the observed host. So this service
 * never looks a peer up by name: it reads the (initiative, project) two-key mapping
 * (`registry.json`'s `liaisonSessions`, written by `registry sessions add --role liaison`),
 * and the registry's `sessionId` is the CloudCLI session id. Liveness is then the ONE
 * question the host registry answers (`liveHostForSession`), which is authoritative in this
 * process in a way a local `~/.claude/sessions/<pid>.json` cross-check is not.
 *
 * ## The four answers a delivery can have
 *
 *   resolved + live     → one send through the existing control service, carrying the
 *                         `[liaison <initiative>/<from>]` prefix and the initiative URI.
 *   resolved + not live → the initiative inbox (the session will drain it on recovery).
 *   dead / unregistered → the initiative inbox.
 *   ambiguous           → REFUSED and reported. Never "pick the first one": a message
 *                         addressed to two sessions is a message addressed to none.
 *   registry unavailable→ an explicit failure, and the message stays in the local pending
 *                         queue. A fleet that cannot answer is not a fleet with no liaison.
 *
 * ## Delivery records
 *
 * Every attempt is recorded (who, when, which initiative, what happened), so "did it arrive?"
 * is a reading rather than an inference. The store is injected: production appends to the
 * fleet home's liaison JSONL files, and a criterion uses the in-memory store exported below.
 *
 * Consumers: `liaison.module.ts` (composition + HTTP face), `tests/liaison-deliver.test.ts`.
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// The address and the message
// ---------------------------------------------------------------------------

/** One (initiative, project) pair, the unit the fleet registry keys liaison sessions by. */
export type LiaisonAddress = {
  initiative: string;
  project: string;
};

/**
 * The `initiative://` address the delivered text carries beside its prefix.
 *
 * The proposal asks for 「前缀与倡议 URI」. The fleet has no initiative URI scheme yet (the
 * probe and the registry only carry the slug), so this module states the one it mints rather
 * than leaving the reader to guess: `initiative://<slug>`, the same two-key address the
 * registry is read by, with the project half of the delivery named in the prefix.
 */
export const LIAISON_INITIATIVE_URI_SCHEME = 'initiative://';

/** `initiative://<slug>` — the address stamped into every delivered message. */
export function initiativeUri(initiative: string): string {
  return `${LIAISON_INITIATIVE_URI_SCHEME}${initiative}`;
}

/**
 * The exact prefix a liaison delivery starts with.
 *
 * Kept as a function (never formatted at a call site) so the criterion, the sender and the
 * receiving session all agree on one spelling.
 */
export function liaisonPrefix(initiative: string, fromProject: string): string {
  return `[liaison ${initiative}/${fromProject}]`;
}

/** The whole delivered text: the prefix + initiative URI, then the sender's message verbatim. */
export function liaisonMessageContent(input: {
  initiative: string;
  from: string;
  message: string;
}): string {
  return `${liaisonPrefix(input.initiative, input.from)} ${initiativeUri(input.initiative)}\n${input.message}`;
}

// ---------------------------------------------------------------------------
// The readings and the injected seams
// ---------------------------------------------------------------------------

/**
 * What the fleet CLI answered for one (initiative, project).
 *
 * `dead` and `unavailable` are DIFFERENT readings and must never collapse into one: `dead`
 * says the registry answered and nobody is registered (the message belongs in the inbox);
 * `unavailable` says the fleet could not be asked at all (the message must be kept, and the
 * caller told). `ambiguous` carries every candidate and NO chosen session.
 */
export type LiaisonRegistryReading =
  | { state: 'resolved'; sessionId: string }
  | { state: 'ambiguous'; candidates: string[] }
  | { state: 'dead'; reason: 'unregistered' }
  | { state: 'unavailable'; reason: string };

/** One fleet CLI invocation, as the runner seam reports it. */
export type LiaisonFleetResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: string };

/**
 * The fleet CLI seam.
 *
 * `module.ts` binds it to a real `quay-fleet` child; the criterion binds it to a stub, which
 * is how "the registry says X" becomes a fixture instead of a host dependency.
 */
export type LiaisonFleetRun = (args: readonly string[]) => Promise<LiaisonFleetResult>;

/** What the existing session send service answered. Its vocabulary is the control service's. */
export type LiaisonSendResult =
  | { ok: true; deliveryId?: string | null; runId?: string | null }
  | { ok: false; code: string; message: string };

/** One message the delivery path is sending. */
export type LiaisonSendInput = {
  sessionId: string;
  content: string;
  initiative: string;
  project: string;
  from: string;
  deliveryId: string;
  /** The authenticated caller the send is made as; `null` for a caller with no user. */
  userId: string | number | null;
};

/** The existing session send service, injected. Production: the process-wide chat control. */
export type LiaisonSendMessage = (input: LiaisonSendInput) => Promise<LiaisonSendResult>;

// ---------------------------------------------------------------------------
// The initiative inbox — append-only, deduplicated by delivery id
// ---------------------------------------------------------------------------

/** Why a message could not be handed to a session and was queued instead. */
export type LiaisonInboxCause = 'liaison-dead' | 'registry-unavailable' | 'send-refused';

/** One queued message. `sessionId` is the registry's answer when it had one, else null. */
export type LiaisonInboxEntry = {
  deliveryId: string;
  initiative: string;
  project: string;
  from: string;
  message: string;
  enqueuedAt: string;
  cause: LiaisonInboxCause;
  sessionId: string | null;
  detail: string | null;
  /**
   * The authenticated caller the ORIGINAL delivery was made for, carried so a recovery
   * redelivery is made as the same identity. The control service refuses a send with no
   * user (`FORBIDDEN`), so an inbox that dropped this would queue messages it could never
   * drain — which is exactly the failure this field exists to prevent.
   */
  userId: string | number | null;
};

/** The mark a delivered message carries, so a second pass can never resend it. */
export type LiaisonDeliveryMark = {
  at: string;
  sessionId: string | null;
  via: 'delivery' | 'recovery';
};

/** One delivery attempt, as the record a person (or a criterion) reads back. */
export type LiaisonDeliveryRecord = {
  deliveryId: string;
  initiative: string;
  project: string;
  from: string;
  at: string;
  outcome:
    | 'delivered'
    | 'inbox'
    | 'ambiguous'
    | 'registry-unavailable'
    | 'send-refused'
    | 'already-delivered';
  sessionId: string | null;
  detail: string | null;
};

/**
 * The inbox + delivery log.
 *
 * Deliberately SYNC: the carriers are two small append-only JSONL files (the same
 * queued/marked discipline the fleet's outbox uses), and a delivery path that had to await
 * its own bookkeeping would be able to lose a message between the send and the mark.
 */
export type LiaisonStore = {
  enqueue(entry: LiaisonInboxEntry): void;
  /** Queued entries with no delivered mark, oldest first. */
  pendingInbox(): LiaisonInboxEntry[];
  wasDelivered(deliveryId: string): boolean;
  markDelivered(deliveryId: string, mark: LiaisonDeliveryMark): void;
  recordDelivery(record: LiaisonDeliveryRecord): void;
  listDeliveries(): LiaisonDeliveryRecord[];
};

/** An in-memory store — the criterion's fixture, and a valid store for a throwaway process. */
export function createMemoryLiaisonStore(): LiaisonStore {
  const queued = new Map<string, LiaisonInboxEntry>();
  const delivered = new Map<string, LiaisonDeliveryMark>();
  const records: LiaisonDeliveryRecord[] = [];
  return {
    enqueue(entry) {
      if (!queued.has(entry.deliveryId)) queued.set(entry.deliveryId, entry);
    },
    pendingInbox() {
      return [...queued.values()].filter((entry) => !delivered.has(entry.deliveryId));
    },
    wasDelivered(deliveryId) {
      return delivered.has(deliveryId);
    },
    markDelivered(deliveryId, mark) {
      delivered.set(deliveryId, mark);
    },
    recordDelivery(record) {
      records.push(record);
    },
    listDeliveries() {
      return [...records];
    },
  };
}

// ---------------------------------------------------------------------------
// The deliveries
// ---------------------------------------------------------------------------

/** What one `deliver()` call decided. */
export type LiaisonDeliveryOutcome =
  | {
      ok: true;
      deliveryId: string;
      outcome: 'delivered';
      sessionId: string;
      runId: string | null;
    }
  | {
      ok: true;
      deliveryId: string;
      outcome: 'inbox';
      cause: LiaisonInboxCause;
      sessionId: string | null;
    }
  | { ok: true; deliveryId: string; outcome: 'already-delivered' }
  | {
      ok: false;
      deliveryId: string;
      code: 'invalid-request';
      message: string;
    }
  | {
      ok: false;
      deliveryId: string;
      code: 'ambiguous-liaison';
      message: string;
      candidates: string[];
    }
  | {
      ok: false;
      deliveryId: string;
      code: 'registry-unavailable';
      message: string;
    }
  | {
      ok: false;
      deliveryId: string;
      code: 'send-refused';
      message: string;
      sessionId: string | null;
    };

/** One delivery request. `project` is the TARGET project; `from` is the sender's project id. */
export type LiaisonDeliverInput = {
  initiative: string;
  project: string;
  from: string;
  message: string;
  deliveryId?: string;
  userId?: string | number | null;
};

/** What one recovery pass did. */
export type LiaisonRecoveryOutcome = {
  delivered: string[];
  failed: Array<{ deliveryId: string; reason: string }>;
};

/** Everything the delivery service reads — all injected, no sibling module is imported. */
export type LiaisonDeliverDeps = {
  /** The fleet CLI seam (production: a real `quay-fleet` child). */
  runFleet: LiaisonFleetRun;
  /** Whether CloudCLI is currently serving this session (production: the host registry). */
  isSessionLive: (sessionId: string) => boolean;
  /** The existing session send service. */
  sendMessage: LiaisonSendMessage;
  store: LiaisonStore;
  now?: () => number;
  newDeliveryId?: () => string;
  log?: (message: string) => void;
};

/** The service the module and its criteria drive. */
export type LiaisonDeliveryService = {
  deliver(input: LiaisonDeliverInput): Promise<LiaisonDeliveryOutcome>;
  handleSessionRecovered(sessionId: string): Promise<LiaisonRecoveryOutcome>;
  listDeliveries(): LiaisonDeliveryRecord[];
  readInbox(): LiaisonInboxEntry[];
};

/** A non-empty, whitespace-free address half. Fleet slugs and project ids are both this shape. */
function isAddressHalf(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !/\s/.test(value);
}

/** The two halves of the fleet registry's answer document, narrowed without `any`. */
function readLiaisonRows(document: unknown): Array<{ initiative: string; project: string; sessionId: string }> | null {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return null;
  const rows = (document as Record<string, unknown>).liaisonSessions;
  if (!Array.isArray(rows)) return null;
  const parsed: Array<{ initiative: string; project: string; sessionId: string }> = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (typeof record.initiative !== 'string' || typeof record.project !== 'string') continue;
    if (typeof record.sessionId !== 'string' || record.sessionId.trim() === '') continue;
    parsed.push({ initiative: record.initiative, project: record.project, sessionId: record.sessionId });
  }
  return parsed;
}

/**
 * Asks the fleet registry which session is the (initiative, project) liaison.
 *
 * The CLI's own `{ok:false, reason}` document is read verbatim; anything that cannot be read
 * as the document is `unavailable` — never `dead`, because "the fleet did not answer" and
 * "the fleet answered that nobody is registered" are the two readings this service must not
 * conflate (one keeps the message pending, the other queues it for the session).
 */
export async function resolveLiaisonSession(
  runFleet: LiaisonFleetRun,
  address: LiaisonAddress,
): Promise<LiaisonRegistryReading> {
  let result: LiaisonFleetResult;
  try {
    result = await runFleet([
      'registry',
      'sessions',
      'list',
      '--role',
      'liaison',
      '--initiative',
      address.initiative,
      '--project',
      address.project,
      '--json',
    ]);
  } catch (error) {
    return { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok) {
    return { state: 'unavailable', reason: result.reason };
  }

  let document: unknown;
  try {
    document = JSON.parse(result.stdout);
  } catch {
    return { state: 'unavailable', reason: 'quay-fleet printed a non-JSON liaison document' };
  }
  if (document !== null && typeof document === 'object' && !Array.isArray(document)) {
    const record = document as Record<string, unknown>;
    if (record.ok !== true) {
      const reason = typeof record.reason === 'string' && record.reason !== ''
        ? record.reason
        : 'quay-fleet refused the liaison registry read';
      return { state: 'unavailable', reason };
    }
  }

  const rows = readLiaisonRows(document);
  if (rows === null) {
    return { state: 'unavailable', reason: 'the liaison registry document carried no liaisonSessions list' };
  }
  const matches = rows.filter(
    (row) => row.initiative === address.initiative && row.project === address.project,
  );
  const ids = [...new Set(matches.map((row) => row.sessionId))];
  if (ids.length === 0) return { state: 'dead', reason: 'unregistered' };
  if (ids.length > 1) return { state: 'ambiguous', candidates: ids };
  return { state: 'resolved', sessionId: ids[0]! };
}

/**
 * Builds the delivery service over the injected seams.
 *
 * The ordering of the decisions is the whole design and is stated once, here: an
 * unavailable registry is checked before ambiguity (there is nothing to call ambiguous),
 * ambiguity is refused before any liveness read (a pair with two sessions is not "one dead
 * one live"), and liveness is checked before the send (a dead session must not be sent to
 * and must not consume a run).
 */
export function createLiaisonDeliveryService(deps: LiaisonDeliverDeps): LiaisonDeliveryService {
  const now = deps.now ?? Date.now;
  const newDeliveryId = deps.newDeliveryId ?? (() => randomUUID());
  const log = deps.log ?? (() => {});
  const store = deps.store;

  const at = (): string => new Date(now()).toISOString();

  function record(
    deliveryId: string,
    input: { initiative: string; project: string; from: string },
    outcome: LiaisonDeliveryRecord['outcome'],
    sessionId: string | null,
    detail: string | null,
  ): void {
    store.recordDelivery({
      deliveryId,
      initiative: input.initiative,
      project: input.project,
      from: input.from,
      at: at(),
      outcome,
      sessionId,
      detail,
    });
  }

  function enqueue(
    deliveryId: string,
    input: LiaisonDeliverInput,
    cause: LiaisonInboxCause,
    sessionId: string | null,
    detail: string | null,
  ): void {
    store.enqueue({
      deliveryId,
      initiative: input.initiative,
      project: input.project,
      from: input.from,
      message: input.message,
      enqueuedAt: at(),
      cause,
      sessionId,
      detail,
      userId: input.userId ?? null,
    });
  }

  async function deliver(input: LiaisonDeliverInput): Promise<LiaisonDeliveryOutcome> {
    const deliveryId = input.deliveryId ?? newDeliveryId();
    const invalid = (message: string): LiaisonDeliveryOutcome => ({
      ok: false,
      deliveryId,
      code: 'invalid-request',
      message,
    });

    for (const [field, value] of [
      ['initiative', input.initiative],
      ['project', input.project],
      ['from', input.from],
    ] as const) {
      if (!isAddressHalf(value)) return invalid(`\`${field}\` must be a non-empty, whitespace-free id`);
    }
    if (typeof input.message !== 'string' || input.message.trim() === '') {
      return invalid('`message` must be a non-empty string');
    }

    // A retry of an already-delivered id is not a second delivery. This is the dedup the
    // recovery pass relies on as well: one delivery id is sent at most once.
    if (store.wasDelivered(deliveryId)) {
      record(deliveryId, input, 'already-delivered', null, 'the delivery id was already sent');
      return { ok: true, deliveryId, outcome: 'already-delivered' };
    }

    const reading = await resolveLiaisonSession(deps.runFleet, {
      initiative: input.initiative,
      project: input.project,
    });

    if (reading.state === 'unavailable') {
      // AC2: a fleet that cannot be asked is an ERROR the caller sees, and the message stays
      // in the local pending queue — never a silent drop, never a fabricated inbox success.
      enqueue(deliveryId, input, 'registry-unavailable', null, reading.reason);
      record(deliveryId, input, 'registry-unavailable', null, reading.reason);
      return {
        ok: false,
        deliveryId,
        code: 'registry-unavailable',
        message: `the fleet registry could not be read (${reading.reason}); the message is queued locally`,
      };
    }

    if (reading.state === 'ambiguous') {
      const detail = `ambiguous liaison address: ${reading.candidates.length} candidate session(s)`;
      record(deliveryId, input, 'ambiguous', null, `${detail}: ${reading.candidates.join(', ')}`);
      log(
        `[liaison] REFUSED ${input.initiative}/${input.project}: ${reading.candidates.length} candidates ` +
          `(${reading.candidates.join(', ')}); no message was sent and none was queued`,
      );
      return {
        ok: false,
        deliveryId,
        code: 'ambiguous-liaison',
        message: `${detail}; refusing rather than picking one`,
        candidates: reading.candidates,
      };
    }

    if (reading.state === 'dead') {
      enqueue(deliveryId, input, 'liaison-dead', null, reading.reason);
      record(deliveryId, input, 'inbox', null, reading.reason);
      return { ok: true, deliveryId, outcome: 'inbox', cause: 'liaison-dead', sessionId: null };
    }

    const sessionId = reading.sessionId;
    if (!deps.isSessionLive(sessionId)) {
      enqueue(deliveryId, input, 'liaison-dead', sessionId, 'the registered liaison session is not live');
      record(deliveryId, input, 'inbox', sessionId, 'the registered liaison session is not live');
      return { ok: true, deliveryId, outcome: 'inbox', cause: 'liaison-dead', sessionId };
    }

    let sent: LiaisonSendResult;
    try {
      sent = await deps.sendMessage({
        sessionId,
        content: liaisonMessageContent({
          initiative: input.initiative,
          from: input.from,
          message: input.message,
        }),
        initiative: input.initiative,
        project: input.project,
        from: input.from,
        deliveryId,
        userId: input.userId ?? null,
      });
    } catch (error) {
      sent = { ok: false, code: 'send-failed', message: error instanceof Error ? error.message : String(error) };
    }

    if (!sent.ok) {
      enqueue(deliveryId, input, 'send-refused', sessionId, `${sent.code}: ${sent.message}`);
      record(deliveryId, input, 'send-refused', sessionId, `${sent.code}: ${sent.message}`);
      return { ok: false, deliveryId, code: 'send-refused', message: sent.message, sessionId };
    }

    store.markDelivered(deliveryId, { at: at(), sessionId, via: 'delivery' });
    record(deliveryId, input, 'delivered', sessionId, null);
    return {
      ok: true,
      deliveryId,
      outcome: 'delivered',
      sessionId,
      runId: sent.runId ?? null,
    };
  }

  /**
   * Drains the inbox for one session that just became live.
   *
   * A queued entry belongs to this session when it was queued against that exact registry
   * id, or when the registry now resolves its address to it (an entry queued as
   * `unregistered` has no id to compare). Every entry that is sent gets its delivered mark
   * BEFORE the next pass can see it, so a second recovery event is a no-op — the
   * no-duplicates half of AC1.
   */
  async function handleSessionRecovered(sessionId: string): Promise<LiaisonRecoveryOutcome> {
    const outcome: LiaisonRecoveryOutcome = { delivered: [], failed: [] };
    if (!deps.isSessionLive(sessionId)) return outcome;

    for (const entry of store.pendingInbox()) {
      let matches = entry.sessionId === sessionId;
      if (!matches) {
        const reading = await resolveLiaisonSession(deps.runFleet, {
          initiative: entry.initiative,
          project: entry.project,
        });
        matches = reading.state === 'resolved' && reading.sessionId === sessionId;
      }
      if (!matches) continue;

      let sent: LiaisonSendResult;
      try {
        sent = await deps.sendMessage({
          sessionId,
          content: liaisonMessageContent({
            initiative: entry.initiative,
            from: entry.from,
            message: entry.message,
          }),
          initiative: entry.initiative,
          project: entry.project,
          from: entry.from,
          deliveryId: entry.deliveryId,
          // The original delivery's caller. A recovery is not a new actor: it finishes the
          // delivery the same person asked for, and the control service's access entry is
          // the one check that says so.
          userId: entry.userId ?? null,
        });
      } catch (error) {
        sent = { ok: false, code: 'send-failed', message: error instanceof Error ? error.message : String(error) };
      }

      if (!sent.ok) {
        outcome.failed.push({ deliveryId: entry.deliveryId, reason: `${sent.code}: ${sent.message}` });
        log(
          `[liaison] inbox redelivery failed for ${entry.deliveryId} (${entry.initiative}/${entry.project}): ` +
            `${sent.code}: ${sent.message}`,
        );
        continue;
      }
      store.markDelivered(entry.deliveryId, { at: at(), sessionId, via: 'recovery' });
      store.recordDelivery({
        deliveryId: entry.deliveryId,
        initiative: entry.initiative,
        project: entry.project,
        from: entry.from,
        at: at(),
        outcome: 'delivered',
        sessionId,
        detail: 'redelivered from the initiative inbox on session recovery',
      });
      outcome.delivered.push(entry.deliveryId);
    }
    return outcome;
  }

  return {
    deliver,
    handleSessionRecovered,
    listDeliveries: () => store.listDeliveries(),
    readInbox: () => store.pendingInbox(),
  };
}
