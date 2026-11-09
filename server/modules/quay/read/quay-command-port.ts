
/**
 * The injected boundaries the quay display service is built on: the child-process runner and
 * the read-only filesystem reader. Both are plain value contracts (never classes), so a
 * criterion can compose the real service with fakes and the composition root can bind the
 * production adapters without the service importing a concrete transport.
 *
 * Consumers: every quay subpackage that spawns a command or reads a carrier, plus
 * `quay.module.ts` (which builds the production reader).
 */

/**
 * Why a quay invocation failed, at the granularity the panel reports it. Each
 * member maps to its own remedy, so the frontend can tell "the CLI is not
 * installed for this project" apart from "the process timed out" instead of
 * showing one generic "quay did not answer":
 *
 * - `entrypoint-missing` — no quay CLI could be resolved for the project (no SERVER override,
 *   no usable Claude Code plugin-scope record, no non-cache legacy pin) and the bare `quay`
 *   is not on `PATH`; the remedy is installing the quay plugin or running `/quay:init`.
 * - `entrypoint-not-executable` — the resolved entrypoint exists but lacks the
 *   execute permission bit, so it cannot be spawned.
 * - `timeout` — the child exceeded the per-command wall-clock bound and was killed.
 * - `nonzero-exit` — the child ran and exited non-zero (or wrote to stderr).
 * - `spawn-error` — any other failure to start the child (an unexpected errno).
 */
export type QuayCommandFailureKind =
  | 'entrypoint-missing'
  | 'entrypoint-not-executable'
  | 'timeout'
  | 'nonzero-exit'
  | 'spawn-error';

/**
 * Outcome of one quay CLI invocation, normalized so callers never have to read
 * child-process internals. `error` is set only when the command was refused
 * locally (not on the whitelist) or the process could not be started at all.
 */
export type QuayCommandResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  /**
   * Classification of a failure, set whenever `ok` is false other than for a
   * local whitelist refusal (which never spawns a child). Consumers branch on
   * this field rather than string-matching `error`, so the four failure
   * situations the panel distinguishes stay distinguishable end to end.
   */
  failureKind?: QuayCommandFailureKind;
};

/**
 * The injected child-process boundary. It always receives an argument array
 * (never a shell string) and a wall-clock bound, so the only way a caller can
 * influence what runs is through arguments that `runQuayCommand` has already
 * matched against the read-only whitelist.
 *
 * `cwd` is always the target project's root (the service passes the project's
 * `projectPath`). It is both the child's working directory and the key the
 * adapter passes to the entrypoint resolver, so a project pinned to a particular
 * quay version (by plugin scope, SERVER override or a legacy pin) is driven by
 * the CLI that pin resolves to.
 */
export type QuayCommandRunner = (
  cwd: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<QuayCommandResult>;

/**
 * The injected read-only filesystem boundary for the project's `.quay/` carriers that are
 * still read locally (the worker-round heartbeat, the dashboard's `server.json`, drain flags
 * and the task store). It exposes only byte-range and whole-file *reads*, so the panel can
 * never write through it, and every path is joined under the project root by the service
 * rather than accepted from a request. The byte-range read is what lets
 * `readLastCarrierRecord` stream a bounded window from the end of an append-only history
 * instead of materialising the whole file.
 */
export type QuayFileReader = {
  /** Byte length of the file, or `null` when it does not exist or cannot be stat-ed. */
  size(filePath: string): Promise<number | null>;
  /** Reads up to `length` bytes starting at byte `position`, decoded as UTF-8; shorter near EOF. */
  readChunk(filePath: string, position: number, length: number): Promise<string>;
  /** Reads a small file fully as UTF-8 text; used only for the tiny suite-state JSON. */
  readText(filePath: string): Promise<string>;
};
