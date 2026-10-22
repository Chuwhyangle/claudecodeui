// Pure helpers for the per-project "hide sessions by name" rules (stored in projects.session_filter).

export const MAX_SESSION_FILTER_PATTERNS = 20;
export const MAX_SESSION_FILTER_PATTERN_LENGTH = 200;

export type SessionFilterValidationResult =
  | { ok: true; hide: string[] }
  | { ok: false; error: string; line: number | null };

/**
 * Validates a user-supplied `hide` list. Each entry must be a compilable JS regex
 * source (<= 200 chars); at most 20 entries. Rejection is all-or-nothing and names
 * the 1-based line of the first offending entry (null when the whole list is invalid).
 * Consumed by the projects routes and the fetch service.
 */
export function validateSessionFilter(input: unknown): SessionFilterValidationResult {
  if (input === null || input === undefined) {
    return { ok: true, hide: [] };
  }
  if (!Array.isArray(input)) {
    return { ok: false, error: 'hide must be an array of regular expressions', line: null };
  }
  if (input.length > MAX_SESSION_FILTER_PATTERNS) {
    return {
      ok: false,
      error: `At most ${MAX_SESSION_FILTER_PATTERNS} patterns are allowed`,
      line: MAX_SESSION_FILTER_PATTERNS + 1,
    };
  }

  for (let index = 0; index < input.length; index += 1) {
    const line = index + 1;
    const pattern = input[index];
    if (typeof pattern !== 'string' || pattern.length === 0) {
      return { ok: false, error: `Line ${line}: pattern must be a non-empty string`, line };
    }
    if (pattern.length > MAX_SESSION_FILTER_PATTERN_LENGTH) {
      return {
        ok: false,
        error: `Line ${line}: pattern is longer than ${MAX_SESSION_FILTER_PATTERN_LENGTH} characters`,
        line,
      };
    }
    try {
      new RegExp(pattern, 'i');
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid regular expression';
      return { ok: false, error: `Line ${line}: ${reason}`, line };
    }
  }

  return { ok: true, hide: input as string[] };
}

/**
 * Compiles the rules into one matcher: unanchored, case-insensitive, true when ANY
 * pattern matches the session display name. An empty list never matches.
 * Consumed by the fetch service (SQL function) and the search service.
 */
export function compileSessionFilter(hide: string[]): (sessionName: string) => boolean {
  const regexes = hide.map((pattern) => new RegExp(pattern, 'i'));
  if (regexes.length === 0) {
    return () => false;
  }
  return (sessionName) => regexes.some((regex) => regex.test(sessionName));
}

/** Parses the stored `session_filter` JSON into a pattern list; malformed or absent values yield []. */
export function parseStoredSessionFilter(storedJson: string | null | undefined): string[] {
  if (!storedJson) {
    return [];
  }
  try {
    const parsed = JSON.parse(storedJson) as { hide?: unknown };
    return Array.isArray(parsed.hide) ? parsed.hide.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Owns the memoized matchers compiled from stored `session_filter` JSON.
 *
 * The cache used to be a module-level `const ... = new Map` mutated from one
 * function: a global mutable container with no owner. It is a private field now,
 * and the class exposes the two transitions the module actually performs — look
 * a matcher up by its JSON text, and compile it on a miss. The module exports one
 * instance ({@link sessionFilterCompiler}) used by `compileStoredSessionFilter`.
 */
export class SessionFilterCompiler {
  private readonly cache = new Map<string, (sessionName: string) => boolean>();

  /** The matcher already compiled for this stored JSON, or undefined on a miss. */
  get(storedJson: string): ((sessionName: string) => boolean) | undefined {
    return this.cache.get(storedJson);
  }

  /**
   * Matcher for a raw stored `session_filter` JSON, memoized by the JSON text so
   * per-row SQL callbacks do not recompile regexes. Invalid stored rules are ignored.
   */
  compile(storedJson: string | null | undefined): (sessionName: string) => boolean {
    if (!storedJson) {
      return () => false;
    }
    let matcher = this.get(storedJson);
    if (!matcher) {
      try {
        matcher = compileSessionFilter(parseStoredSessionFilter(storedJson));
      } catch {
        matcher = () => false;
      }
      if (this.cache.size > 200) {
        this.cache.clear();
      }
      this.cache.set(storedJson, matcher);
    }
    return matcher;
  }
}

/** The module's one compiler; see {@link SessionFilterCompiler}. */
export const sessionFilterCompiler = new SessionFilterCompiler();

/**
 * Matcher for a raw stored `session_filter` JSON, memoized by the JSON text so
 * per-row SQL callbacks do not recompile regexes. Invalid stored rules are ignored.
 */
export function compileStoredSessionFilter(storedJson: string | null | undefined): (sessionName: string) => boolean {
  return sessionFilterCompiler.compile(storedJson);
}
