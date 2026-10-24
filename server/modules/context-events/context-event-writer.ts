/**
 * The host-level context event writer — the CloudCLI side of the shared
 * `~/.quay-fleet/context/events/<YYYY-MM-DD>.jsonl` stream.
 *
 * WHAT THIS OWNS. One append-only file per UTC day, one JSON object per line, and
 * the v0 envelope every producer shares:
 *
 *   { v: 0, id: <ULID>, at: <ISO>, source: 'cloudcli', kind, project?, session?,
 *     refs?: [uri], data: { … } }
 *
 * The authoritative shape is quay-fleet's `config/context-event.schema.v0.json`,
 * read from the installed release (the same install the quay-fleet CLI locator
 * resolves). This writer validates against THAT document rather than against a
 * second copy of the contract — a copy here would drift the moment the fleet
 * ships v1. The document is read lazily and cached; while it is unavailable the
 * writer reports `schema-unavailable` and writes nothing, which is the honest
 * reading for "the fleet is not installed (or predates the schema)".
 *
 * WRITE DISCIPLINE. The whole line is assembled in memory, then written with ONE
 * `write(2)` on a handle opened `O_APPEND`. Two writers in two processes can
 * interleave whole lines but never halves of one. There is no per-event fsync:
 * the stream is evidence, not a write-ahead log, and the fleet's retention job
 * owns rotation and cleanup — CloudCLI never deletes a context event.
 *
 * BOUND. One line is at most {@link CONTEXT_EVENT_MAX_LINE_BYTES} (16 KB). An
 * over-long text field is truncated (and `data.truncated` set) rather than
 * dropped, because a 16 KB ceiling must never turn a recorded action into a hole
 * in the stream.
 *
 * Consumers: `context-events.module.ts` (the only writer of stream events), the
 * writer criterion `tests/context-event-writer.test.ts`, and the shadow-prediction
 * report through the files this writer produces.
 */
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The v0 envelope version. The fleet schema pins this value. */
export const CONTEXT_EVENT_VERSION = 0;

/** The only `source` this writer may mint: this process is the CloudCLI producer. */
export const CONTEXT_EVENT_SOURCE = 'cloudcli';

/** One line's ceiling, in UTF-8 bytes, exactly as the task's write discipline states. */
export const CONTEXT_EVENT_MAX_LINE_BYTES = 16 * 1024;

/**
 * Every kind CloudCLI may produce. A kind outside this list is a programming
 * error in a producer, and the writer rejects it even before the schema is read,
 * so a typo cannot enter the stream while the fleet release is absent.
 */
export const CLOUDCLI_CONTEXT_EVENT_KINDS = [
  'utterance',
  'chip.shown',
  'chip.picked',
  'chip.redrawn',
  'focus',
  'reference.resolved',
  'send.previewed',
  'send.confirmed',
  'send.cancelled',
  'build.completed',
  'service.restarted',
  'correction',
  'shadow.prediction',
  'shadow.prediction.outcome',
] as const;

/** The kinds this producer may write. */
export type CloudCliContextEventKind = (typeof CLOUDCLI_CONTEXT_EVENT_KINDS)[number];

/** One event as a producer states it; the writer mints `v`, `id`, `at` and `source`. */
export type ContextEventDraft = {
  kind: CloudCliContextEventKind;
  project?: string | null;
  session?: string | null;
  refs?: readonly string[];
  data?: Record<string, unknown>;
  /** Injected by criteria that need a deterministic date. Production omits it. */
  at?: string;
};

/** One complete line, after the writer has added the envelope. */
export type ContextEvent = {
  v: number;
  id: string;
  at: string;
  source: typeof CONTEXT_EVENT_SOURCE;
  kind: CloudCliContextEventKind;
  project?: string;
  session?: string;
  refs?: string[];
  data: Record<string, unknown>;
};

/** The writer's public reading: `schema-unavailable` writes nothing and throws nothing. */
export type ContextEventWriterStatus = {
  state: 'ok' | 'schema-unavailable';
  /** Why the state is not `ok`; `null` exactly when it is `ok`. */
  reason: string | null;
  /** The schema document the writer validates against, or the path it tried. */
  schemaPath: string | null;
  /** The directory the daily files live in. */
  eventsDir: string;
  /** Lines successfully appended since this writer was built. */
  writes: number;
  /** Events rejected for a schema/producer violation (never written). */
  rejected: number;
};

/** The result of one append. Invalid input and an unavailable schema are values, not throws. */
export type AppendContextEventResult =
  | { ok: true; id: string; path: string }
  | { ok: false; reason: 'schema-unavailable' | 'invalid-kind' | 'invalid' | 'write-failed'; detail: string };

/** The filesystem seam, so a criterion can make a write fail without touching the host. */
export type ContextEventWriterIo = {
  mkdirSync: typeof fs.mkdirSync;
  open: typeof fs.promises.open;
  readFileSync: typeof fs.readFileSync;
};

/** Construction seams: every default is the real host; criteria replace them. */
export type ContextEventWriterOptions = {
  /** Directory holding `<YYYY-MM-DD>.jsonl`; defaults to `~/.quay-fleet/context/events`. */
  eventsDir?: string;
  /** Explicit schema document; when absent the installed fleet release is discovered. */
  schemaPath?: string | null;
  /** Home directory used both for the default events dir and schema discovery. */
  homeDir?: string;
  /** Environment used for `QUAY_FLEET_BIN` / `PATH` discovery; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Clock; defaults to `Date.now`. */
  now?: () => number;
  /** ULID factory; criteria inject a deterministic one. */
  newId?: (nowMs: number) => string;
  /** IO seam; criteria inject a throwing `open` to read the failure path. */
  io?: Partial<ContextEventWriterIo>;
};

/** The writer surface consumed by the module and its criterion. */
export type ContextEventWriter = {
  readonly eventsDir: string;
  readonly schemaPath: string | null;
  append(event: ContextEventDraft): Promise<AppendContextEventResult>;
  status(): ContextEventWriterStatus;
};

/** Crockford's base32 alphabet, the ULID encoding. */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Mints a ULID: 10 crockford characters of millisecond timestamp followed by 16
 * characters of randomness. The timestamp half keeps the file roughly ordered by
 * time (the same order the append discipline preserves), and the randomness half
 * is what makes ids unique across the several code paths that mint them.
 */
export function createUlid(nowMs: number): string {
  let time = Math.max(0, Math.floor(nowMs));
  const timeChars = new Array<string>(10);
  for (let index = 9; index >= 0; index -= 1) {
    timeChars[index] = ULID_ALPHABET[time % 32];
    time = Math.floor(time / 32);
  }
  let randomness = '';
  for (let index = 0; index < 16; index += 1) {
    randomness += ULID_ALPHABET[randomInt(32)];
  }
  return `${timeChars.join('')}${randomness}`;
}

/**
 * Resolves the schema document from the ONE installed fleet release the CLI
 * locator would select, using the same lookup order (`QUAY_FLEET_BIN` → `PATH` →
 * `~/.quay-fleet/bin/quay-fleet`). The binary is a symlink into
 * `<release>/bin/quay-fleet.mjs`, so the release root is two directories up from
 * the resolved binary.
 *
 * Returns `null` when no candidate carries the v0 document: the fleet is absent,
 * or the installed release predates the schema. The writer then reports
 * `schema-unavailable` and writes nothing at all.
 */
export function resolveContextEventSchemaPath(options: {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  fileExists?: (filePath: string) => boolean;
} = {}): string | null {
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? ((filePath: string) => fs.existsSync(filePath));
  const schemaRelative = path.join('config', 'context-event.schema.v0.json');

  const fromBinary = (binaryPath: string): string | null => {
    try {
      const resolved = fs.realpathSync(binaryPath);
      const candidate = path.join(path.dirname(path.dirname(resolved)), schemaRelative);
      return fileExists(candidate) ? candidate : null;
    } catch {
      return null;
    }
  };

  const override = env.QUAY_FLEET_BIN?.trim();
  if (override) {
    const found = fromBinary(override);
    if (found !== null) return found;
  }

  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (directory.trim() === '') continue;
    const found = fromBinary(path.join(directory, 'quay-fleet'));
    if (found !== null) return found;
  }

  const homeBinary = path.join(homeDir, '.quay-fleet', 'bin', 'quay-fleet');
  const fromHome = fromBinary(homeBinary);
  if (fromHome !== null) return fromHome;

  // Last resort: a releases directory whose `bin/quay-fleet` symlink is broken
  // or absent. The newest release that carries the document is still the one the
  // operator installed, so it is a better answer than "unavailable".
  const releasesDir = path.join(homeDir, '.quay-fleet', 'releases');
  try {
    const releases = fs
      .readdirSync(releasesDir)
      .map((name) => path.join(releasesDir, name, schemaRelative))
      .filter((candidate) => fileExists(candidate))
      .sort();
    return releases.at(-1) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// A small JSON-Schema reader: the subset the v0 contract uses
// ---------------------------------------------------------------------------

/**
 * The schema keywords this validator understands. The v0 document is a plain
 * object schema; keeping the reader to these keywords makes validation a reading
 * of the fleet's own constraints instead of a reimplementation of JSON Schema.
 * Unknown keywords are ignored deliberately (they only ADD constraints upstream,
 * never relax one this reader enforces).
 */
type SchemaNode = {
  type?: string;
  required?: readonly string[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
  items?: SchemaNode;
  enum?: readonly unknown[];
  const?: unknown;
  pattern?: string;
  maxLength?: number;
  minLength?: number;
  anyOf?: readonly SchemaNode[];
  oneOf?: readonly SchemaNode[];
};

/** Reads one node from untrusted JSON without trusting its shape. */
function asSchemaNode(value: unknown): SchemaNode | null {
  return value !== null && typeof value === 'object' ? (value as SchemaNode) : null;
}

/** Whether `value` answers the node's `type` keyword (when it states one). */
function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      // A type this reader does not know is not a licence to reject everything.
      return true;
  }
}

/**
 * Validates one value against a schema node, returning human-readable failures.
 * The recursion is depth-first and reports every failure it finds, so a criterion
 * can read WHY an event was rejected rather than only that it was.
 */
function validateNode(value: unknown, node: SchemaNode, at: string): string[] {
  const failures: string[] = [];
  if (node.type !== undefined && !hasType(value, node.type)) {
    failures.push(`${at} must be ${node.type}`);
    return failures;
  }
  if (node.const !== undefined && value !== node.const) {
    failures.push(`${at} must equal ${JSON.stringify(node.const)}`);
  }
  if (node.enum !== undefined && !node.enum.includes(value)) {
    failures.push(`${at} must be one of ${JSON.stringify(node.enum)}`);
  }
  if (typeof value === 'string') {
    if (node.pattern !== undefined) {
      let matches = true;
      try {
        matches = new RegExp(node.pattern, 'u').test(value);
      } catch {
        matches = true;
      }
      if (!matches) failures.push(`${at} must match ${node.pattern}`);
    }
    if (node.minLength !== undefined && value.length < node.minLength) {
      failures.push(`${at} must be at least ${node.minLength} characters`);
    }
    if (node.maxLength !== undefined && value.length > node.maxLength) {
      failures.push(`${at} must be at most ${node.maxLength} characters`);
    }
  }
  if (Array.isArray(value) && node.items !== undefined) {
    const itemSchema = asSchemaNode(node.items);
    if (itemSchema !== null) {
      value.forEach((item, index) => failures.push(...validateNode(item, itemSchema, `${at}[${index}]`)));
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const required of node.required ?? []) {
      if (!(required in record)) failures.push(`${at}.${required} is required`);
    }
    for (const [key, member] of Object.entries(record)) {
      const propertySchema = node.properties?.[key];
      if (propertySchema !== undefined) {
        const child = asSchemaNode(propertySchema);
        if (child !== null) failures.push(...validateNode(member, child, `${at}.${key}`));
        continue;
      }
      if (node.additionalProperties === false) {
        failures.push(`${at}.${key} is not allowed`);
        continue;
      }
      const additional = asSchemaNode(node.additionalProperties);
      if (additional !== null) failures.push(...validateNode(member, additional, `${at}.${key}`));
    }
  }
  if (node.anyOf !== undefined) {
    const branches = node.anyOf.map((branch) => asSchemaNode(branch)).filter((branch): branch is SchemaNode => branch !== null);
    if (branches.length > 0 && !branches.some((branch) => validateNode(value, branch, at).length === 0)) {
      failures.push(`${at} must match at least one anyOf branch`);
    }
  }
  if (node.oneOf !== undefined) {
    const branches = node.oneOf.map((branch) => asSchemaNode(branch)).filter((branch): branch is SchemaNode => branch !== null);
    const matches = branches.filter((branch) => validateNode(value, branch, at).length === 0).length;
    if (branches.length > 0 && matches !== 1) failures.push(`${at} must match exactly one oneOf branch`);
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Truncation: the 16 KB ceiling is enforced on the assembled line
// ---------------------------------------------------------------------------

type StringSlot = { path: readonly (string | number)[]; value: string };

/** Collects every string slot under `data`, so truncation can pick the longest one. */
function collectStringSlots(value: unknown, prefix: readonly (string | number)[] = []): StringSlot[] {
  if (typeof value === 'string') return [{ path: prefix, value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectStringSlots(item, [...prefix, index]));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, member]) =>
      collectStringSlots(member, [...prefix, key]),
    );
  }
  return [];
}

/** Writes one string slot in place; the caller owns the object it passes. */
function setStringSlot(root: Record<string, unknown>, slot: StringSlot, next: string): void {
  let cursor: Record<string | number, unknown> = root;
  for (const key of slot.path.slice(0, -1)) {
    cursor = cursor[key] as Record<string | number, unknown>;
  }
  cursor[slot.path.at(-1) as string | number] = next;
}

/**
 * Truncates the longest text fields under `data` until the assembled line fits.
 *
 * The marker is `data.truncated = true`, and it is set BEFORE the first cut so a
 * reader can tell a short original from a cut one. The loop always shrinks the
 * longest remaining string by at least one character, so it terminates; if no
 * string is left (a pathological non-text payload) the line is rejected instead
 * of silently exceeding the ceiling.
 */
function truncateDataToFit(
  event: ContextEvent,
): { event: ContextEvent; line: string } | { error: string } {
  let line = JSON.stringify(event);
  if (Buffer.byteLength(line, 'utf8') <= CONTEXT_EVENT_MAX_LINE_BYTES) return { event, line };

  event.data = { ...event.data, truncated: true };
  for (let attempt = 0; attempt < 64; attempt += 1) {
    line = JSON.stringify(event);
    const overflow = Buffer.byteLength(line, 'utf8') - CONTEXT_EVENT_MAX_LINE_BYTES;
    if (overflow <= 0) return { event, line };

    const slots = collectStringSlots(event.data)
      .filter((slot) => slot.value.length > 0)
      .sort((left, right) => right.value.length - left.value.length);
    const longest = slots[0];
    if (longest === undefined) {
      return { error: `event is ${overflow} bytes over the line ceiling and carries no text field to truncate` };
    }
    // Cut in CHARACTERS, using the byte overflow as a lower bound. Multi-byte
    // text means one character may be several bytes, so the cut is deliberately
    // generous and the loop re-measures; halving guarantees progress on a dense
    // script where one character is 3–4 bytes.
    const target = Math.max(0, Math.min(longest.value.length - 1, longest.value.length - overflow - 32));
    const next = target === longest.value.length ? longest.value.slice(0, Math.floor(longest.value.length / 2)) : longest.value.slice(0, target);
    setStringSlot(event.data, longest, next);
  }
  return { error: 'event could not be truncated under the line ceiling' };
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

/**
 * Builds the append-only writer over one events directory.
 *
 * Consumers: `context-events.module.ts`; the criterion
 * `tests/context-event-writer.test.ts` drives it directly.
 */
export function createContextEventWriter(options: ContextEventWriterOptions = {}): ContextEventWriter {
  const homeDir = options.homeDir ?? os.homedir();
  const eventsDir = options.eventsDir ?? path.join(homeDir, '.quay-fleet', 'context', 'events');
  const now = options.now ?? Date.now;
  const newId = options.newId ?? createUlid;
  const io: ContextEventWriterIo = {
    mkdirSync: options.io?.mkdirSync ?? fs.mkdirSync,
    open: options.io?.open ?? fs.promises.open,
    readFileSync: options.io?.readFileSync ?? fs.readFileSync,
  };

  const explicitSchemaPath = options.schemaPath === undefined ? null : options.schemaPath;
  const discoveredSchemaPath =
    explicitSchemaPath ?? resolveContextEventSchemaPath({ homeDir, ...(options.env === undefined ? {} : { env: options.env }) });
  const attemptedSchemaPath = discoveredSchemaPath;

  let schema: SchemaNode | null = null;
  let schemaError: string | null = null;
  let lastSchemaAttempt = Number.NEGATIVE_INFINITY;
  let writes = 0;
  let rejected = 0;
  let directoryReady = false;

  /** Reads and parses the schema once; a missing/malformed document is a reading, not a throw. */
  const loadSchema = (): SchemaNode | null => {
    if (schema !== null) return schema;
    if (attemptedSchemaPath === null) {
      schemaError = 'no installed quay-fleet release carries config/context-event.schema.v0.json';
      return null;
    }
    // While the fleet is absent this is retried on a coarse throttle, so a
    // release installed after boot starts working without a process restart.
    const current = now();
    if (schemaError !== null && current - lastSchemaAttempt < 30_000) return null;
    lastSchemaAttempt = current;
    try {
      const parsed = JSON.parse(io.readFileSync(attemptedSchemaPath, 'utf8')) as unknown;
      const node = asSchemaNode(parsed);
      if (node === null) throw new Error('schema document is not an object');
      schema = node;
      schemaError = null;
      return schema;
    } catch (error) {
      schemaError = `schema unavailable at ${attemptedSchemaPath}: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    }
  };

  const status = (): ContextEventWriterStatus => {
    const loaded = schema !== null;
    return {
      state: loaded ? 'ok' : 'schema-unavailable',
      reason: loaded ? null : schemaError ?? 'schema has not been read yet',
      schemaPath: attemptedSchemaPath,
      eventsDir,
      writes,
      rejected,
    };
  };

  const append = async (draft: ContextEventDraft): Promise<AppendContextEventResult> => {
    if (!(CLOUDCLI_CONTEXT_EVENT_KINDS as readonly string[]).includes(draft.kind)) {
      rejected += 1;
      return { ok: false, reason: 'invalid-kind', detail: `"${draft.kind}" is not a CloudCLI-produced kind` };
    }
    const node = loadSchema();
    if (node === null) {
      // Zero writes while the schema is unavailable — the stream's shape is the
      // fleet's document, and writing an unvalidated guess would poison it.
      return { ok: false, reason: 'schema-unavailable', detail: schemaError ?? 'schema unavailable' };
    }

    const at = draft.at ?? new Date(now()).toISOString();
    const event: ContextEvent = {
      v: CONTEXT_EVENT_VERSION,
      id: newId(Date.parse(at)),
      at,
      source: CONTEXT_EVENT_SOURCE,
      kind: draft.kind,
      ...(typeof draft.project === 'string' && draft.project.trim() !== '' ? { project: draft.project.trim() } : {}),
      ...(typeof draft.session === 'string' && draft.session.trim() !== '' ? { session: draft.session.trim() } : {}),
      ...(draft.refs !== undefined && draft.refs.length > 0 ? { refs: [...draft.refs] } : {}),
      data: draft.data ?? {},
    };

    const failures = validateNode(event, node, 'event');
    if (failures.length > 0) {
      rejected += 1;
      return { ok: false, reason: 'invalid', detail: failures.join('; ') };
    }

    const fitted = truncateDataToFit(event);
    if ('error' in fitted) {
      rejected += 1;
      return { ok: false, reason: 'invalid', detail: fitted.error };
    }
    const line = fitted.line;
    // One final byte check: truncation and JSON escaping are both measured in
    // UTF-8 bytes, and the ceiling is a byte ceiling.
    const buffer = Buffer.from(`${line}\n`, 'utf8');
    if (buffer.byteLength > CONTEXT_EVENT_MAX_LINE_BYTES + 1) {
      rejected += 1;
      return { ok: false, reason: 'invalid', detail: 'assembled line exceeds the 16 KB ceiling' };
    }

    const day = event.at.slice(0, 10);
    const filePath = path.join(eventsDir, `${day}.jsonl`);
    try {
      if (!directoryReady) {
        io.mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
        directoryReady = true;
      }
      // O_APPEND + ONE write: the kernel appends the whole line or nothing.
      const handle = await io.open(filePath, 'a', 0o600);
      try {
        await handle.write(buffer);
      } finally {
        await handle.close();
      }
      writes += 1;
      return { ok: true, id: event.id, path: filePath };
    } catch (error) {
      return { ok: false, reason: 'write-failed', detail: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    eventsDir,
    schemaPath: attemptedSchemaPath,
    append,
    status,
  };
}
