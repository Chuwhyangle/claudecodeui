import type { QuayCommandRunner } from './quay.service.js';

/**
 * The three-state answer for one quay verb.
 *
 * `absent` is a READ (`--help` answered and did not list the verb). `unknown` is NOT a read:
 * the probe could not tell (a spawn error, a timeout, or a non-zero exit with no output), so
 * it must never be collapsed into `absent` — a caller that treated "I could not ask" as "the
 * verb is missing" would silently disable the event path on a transient failure.
 */
export type QuayVerbCapability = 'available' | 'absent' | 'unknown';

/** The verbs this server consumes beyond the long-standing read set. */
export type QuayCapabilities = {
  /** `quay task log --json …` — the incremental transition read (quay v0.20.0+). */
  taskLog: QuayVerbCapability;
  /** `quay lanes --json …` — the packed in-flight gantt (quay v0.19.0+). */
  lanes: QuayVerbCapability;
};

/**
 * The identity of the binary a project's quay entrypoint resolves to. The cache key is the
 * realpath plus mtime plus size, so re-pointing a version symlink (`0.19.0` → `0.22.0`) or
 * replacing/updating the binary invalidates the probe without anyone remembering to.
 */
export type QuayEntrypointIdentity = {
  /** The resolved target of `<projectRoot>/.quay/plugin/bin/quay` (or the bare `quay` on PATH). */
  realpath: string;
  /** The target file's modification time, epoch milliseconds. */
  mtimeMs: number;
  /** The target file's byte size. */
  size: number;
};

/** The injectable boundaries of the capability probe. */
export type QuayCapabilityDependencies = {
  /** Runs the whitelisted `--help` argv through the same project-scoped adapter as every other read. */
  runCommand: QuayCommandRunner;
  /**
   * Reads the entrypoint's identity (realpath + mtime + size), or `null` when no entrypoint is
   * resolvable. Injected so a criterion can change the realpath/mtime without touching disk.
   */
  readEntrypoint(projectPath: string): QuayEntrypointIdentity | null;
  /** Injected clock (epoch ms). */
  now(): number;
  /** Sink for the one-line state-change record. Defaults to the server's `console.log`. */
  log?(message: string): void;
  /** How long an `unknown` answer is used before the probe is retried. Defaults to 60 s. */
  unknownBackoffMs?: number;
  /** Per-probe child-process bound. Defaults to the service's own 8 s command bound. */
  commandTimeoutMs?: number;
};

/** The read/probe pair the event service consumes. */
export type QuayCapabilityReader = {
  /** The last probe's answer, WITHOUT spawning. Never-seen entrypoints read all-`unknown`. */
  read(projectPath: string): QuayCapabilities;
  /** Probes (subject to the realpath+mtime+size cache and the `unknown` backoff) and answers. */
  probe(projectPath: string): Promise<QuayCapabilities>;
};

/** Every capability unknown — the answer for "nothing has been probed" and for "the probe failed". */
const UNKNOWN_CAPABILITIES: QuayCapabilities = { taskLog: 'unknown', lanes: 'unknown' };

const DEFAULT_UNKNOWN_BACKOFF_MS = 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 8_000;

/**
 * One verb's presence in a `--help` text. The contract's help lists one `quay <verb> …` line
 * per verb, so the match is anchored at the line start and requires the verbanme (with
 * `task log` matched as two tokens) to end on a word boundary — never a bare substring, so
 * a help line for `task list` can never read as `task log`.
 */
function helpListsVerb(helpText: string, verb: readonly string[]): boolean {
  const pattern = new RegExp(`^[ \\t]*quay[ \\t]+${verb.join('[ \\t]+')}\\b`, 'm');
  return pattern.test(helpText);
}

/**
 * Narrows one `--help` reading to the two verbs this server cares about. A verb that is not
 * listed is `absent`; the caller has already established that the help text itself was a real
 * reading (non-empty stdout from a completed process), so absence here is a fact, not a guess.
 */
function capabilitiesFromHelp(helpText: string): QuayCapabilities {
  return {
    taskLog: helpListsVerb(helpText, ['task', 'log']) ? 'available' : 'absent',
    lanes: helpListsVerb(helpText, ['lanes']) ? 'available' : 'absent',
  };
}

/** One cached probe reading. `retryAtMs` is set only while the answer carries an `unknown`. */
type CapabilityCacheEntry = {
  result: QuayCapabilities;
  retryAtMs: number | null;
};

function hasUnknown(capabilities: QuayCapabilities): boolean {
  return capabilities.taskLog === 'unknown' || capabilities.lanes === 'unknown';
}

/**
 * Creates the per-project quay verb capability probe.
 *
 * Consumers: `quay-task-events.service.ts` (it may only watch a project and call `task log`
 * when the verb is `available`) and `quay.module.ts` (composition). The probe answers from a
 * cache keyed by the resolved entrypoint's realpath+mtime+size; an `unknown` answer expires
 * after {@link QuayCapabilityDependencies.unknownBackoffMs} so a transient failure is retried
 * instead of freezing the project into "cannot refresh" forever.
 */
export function createQuayCapabilities(
  dependencies: QuayCapabilityDependencies,
): QuayCapabilityReader {
  const unknownBackoffMs = dependencies.unknownBackoffMs ?? DEFAULT_UNKNOWN_BACKOFF_MS;
  const commandTimeoutMs = dependencies.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const log = dependencies.log ?? ((message: string) => console.log(message));

  const cache = new Map<string, CapabilityCacheEntry>();
  const inFlight = new Map<string, Promise<QuayCapabilities>>();
  /** The last state-change line written for each project; keyed by project, not entrypoint. */
  const lastReported = new Map<string, string>();

  /** The cache key for one project: the entrypoint identity when known, else the project itself. */
  const cacheKeyFor = (projectPath: string): string => {
    const identity = dependencies.readEntrypoint(projectPath);
    if (identity === null) {
      return `project:${projectPath}`;
    }
    return `${identity.realpath}\u0000${identity.mtimeMs}\u0000${identity.size}`;
  };

  /**
   * Writes at most one line per project per state CHANGE. A project that answers the same
   * reading on every probe stays silent until it actually differs, which is what makes the
   * capability log a change record rather than a heartbeat.
   */
  const reportIfChanged = (projectPath: string, result: QuayCapabilities): void => {
    const summary = `task log=${result.taskLog} lanes=${result.lanes}`;
    if (lastReported.get(projectPath) === summary) {
      return;
    }
    lastReported.set(projectPath, summary);
    log(`quay capabilities: project=${projectPath} ${summary}`);
  };

  const runProbe = async (projectPath: string, key: string): Promise<QuayCapabilities> => {
    const result = await dependencies.runCommand(projectPath, ['--help'], {
      timeoutMs: commandTimeoutMs,
    });

    let capabilities: QuayCapabilities;
    // A spawn failure or a timeout is "could not ask", never "the verb is missing". A
    // non-zero exit WITH output is still a usable reading (some CLIs exit 1 after printing
    // help); a non-zero exit with no output is not.
    if (!result.ok && result.failureKind !== 'nonzero-exit') {
      capabilities = { ...UNKNOWN_CAPABILITIES };
    } else if (result.stdout.trim() === '') {
      capabilities = { ...UNKNOWN_CAPABILITIES };
    } else {
      capabilities = capabilitiesFromHelp(result.stdout);
    }

    cache.set(key, {
      result: capabilities,
      retryAtMs: hasUnknown(capabilities) ? dependencies.now() + unknownBackoffMs : null,
    });
    reportIfChanged(projectPath, capabilities);
    return capabilities;
  };

  const probe = async (projectPath: string): Promise<QuayCapabilities> => {
    const key = cacheKeyFor(projectPath);
    const cached = cache.get(key);
    if (cached !== undefined) {
      const withinUnknownBackoff =
        cached.retryAtMs !== null && dependencies.now() < cached.retryAtMs;
      if (!hasUnknown(cached.result) || withinUnknownBackoff) {
        return cached.result;
      }
      // The unknown answer aged out: fall through and probe again.
    }

    const pending = inFlight.get(key);
    if (pending !== undefined) {
      return pending;
    }

    const promise = runProbe(projectPath, key).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  };

  const read = (projectPath: string): QuayCapabilities => {
    const cached = cache.get(cacheKeyFor(projectPath));
    return cached?.result ?? { ...UNKNOWN_CAPABILITIES };
  };

  return { read, probe };
}
