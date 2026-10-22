/**
 * The rendered-voice-context truncation: the ONE server-side reading of a pack's configured size.
 *
 * WHY THIS LIVES IN THE SHARED VOICE TREE. Two voice entries enforce the same limits — the Live
 * Voice proxy's `context` frame and the one-shot `/api/voice/transcribe` path's `hints.context` —
 * and both must agree with the browser builder's own bounds. It is also the tree the AC-139
 * dispatch falsification copies wholesale into its temp tree, so a service that reaches this pure
 * function at runtime keeps the tree's "no node_modules, no network" property. Putting the same
 * function beside the settings contract keeps the two ends describing one pack rather than two
 * slightly different ones.
 *
 * This file is compiled by BOTH compiler configurations (the root config includes `shared`), so it
 * uses neither Node built-ins nor ES2021+ library features, and it imports nothing.
 */

/**
 * One rendered voice context's size limits, as the settings file (and its environment escape
 * hatches) resolved them.
 *
 * The SAME shape the browser builder uses (`VoiceContextPackRuntimeSettings` in the shared voice
 * contract): the browser bounds what it BUILDS, the server bounds what it ACCEPTS, and both ends
 * therefore describe one pack rather than two slightly different ones.
 */
export type RenderedVoiceContextLimits = {
  /** The newest-N row boundary the pack may keep. */
  maxRows: number;
  /** The rendered text's hard character budget (UTF-16 code units). */
  budgetChars: number;
  /** One row's own cap, applied before the budget walk. */
  rowCapChars: number;
};

/** The result of truncating one already-rendered pack. */
export type RenderedVoiceContextTruncation = {
  /** The text to hand on: at most `maxRows` rows and `budgetChars` characters. */
  text: string;
  /** `text.length` — the unit the budget is expressed in. */
  chars: number;
  /** Rows in `text`. */
  rows: number;
  /** `text.length` BEFORE truncation, for the operator's log line. */
  sourceChars: number;
  /** Rows in the input, for the same line. */
  sourceRows: number;
  /** Whether anything was dropped or elided. */
  truncated: boolean;
};

/**
 * One rendered row's own elision: the head 70%, `…`, the tail 30%.
 *
 * The ellipsis comes out of the tail, so the result is NEVER longer than `cap` — a row cap that
 * could be overshot by one character would make the pack's own limit a suggestion.
 */
function elideRenderedVoiceRow(text: string, cap: number): string {
  if (cap <= 0) return '';
  if (text.length <= cap) return text;
  if (cap <= 1) return text.slice(0, cap);
  const head = Math.floor(cap * 0.7);
  const tail = cap - head - 1;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** The prefix a rendered pack writes at the start of each row (`用户（刚刚）：`, `助手：`). */
const RENDERED_VOICE_ROW_START = /^(?:用户|助手)(?:（[^）]*）)?：/;

/**
 * Truncates an ALREADY-RENDERED voice context to the given limits, keeping the NEWEST rows.
 *
 * WHY THE SERVER NEEDS ITS OWN TRUNCATION. The browser builds the pack, but the pack is
 * configuration-sized now: a page loaded before an operator shrank the file, a hand-written frame,
 * or simply a race between the browser's build and the connect-time reading would otherwise reach
 * the model at the OLD size. The server is the last point that can enforce the reading it actually
 * resolved for this connection, so it trims there rather than trusting the client.
 *
 * WHAT IT DOES NOT DO. It never rewrites the browser's row SELECTION or its character folding:
 * the input is the rendered `角色（时间）：文本` text, its row boundaries are those rendered lines,
 * and the walk is newest-first. A caller that handed non-pack text gets it treated as one row and
 * elided, which is the honest reading of `rowCapChars` for a shape this function was not given
 * boundaries for.
 *
 * The log line the caller writes names BOTH readings (`from=<rows> rows/<chars> chars
 * to=<rows> rows/<chars> chars`) so an operator can see that the server, not the browser, decided.
 *
 * Consumers: the Live Voice proxy's `context` frame and the one-shot `/api/voice/transcribe`
 * path's `hints.context`.
 */
export function truncateRenderedVoiceContext(
  text: string,
  limits: RenderedVoiceContextLimits,
): RenderedVoiceContextTruncation {
  const sourceChars = text.length;
  if (text === '') {
    return { text: '', chars: 0, rows: 0, sourceChars: 0, sourceRows: 0, truncated: false };
  }

  // Split into rendered rows: a line that starts with `用户…：`/`助手…：` opens a row, and every
  // line that does not (a body's own newline, a blank trailing line) belongs to the row above it.
  const rows: string[] = [];
  let current: string[] = [];
  for (const line of text.split('\n')) {
    if (RENDERED_VOICE_ROW_START.test(line)) {
      if (current.length > 0) rows.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) rows.push(current.join('\n'));
  const sourceRows = rows.length;

  const maxRows = Math.max(1, Math.floor(limits.maxRows));
  const budgetChars = Math.max(0, Math.floor(limits.budgetChars));
  const rowCapChars = Math.max(1, Math.floor(limits.rowCapChars));

  const capped = rows.map((row) => elideRenderedVoiceRow(row, rowCapChars));
  const newest = capped.slice(Math.max(0, capped.length - maxRows));

  // Newest-first until the next row would not fit, exactly like the browser builder: the pack
  // always ends at the newest thing said and never skips an older row to reach the budget.
  const kept: string[] = [];
  let chars = 0;
  for (let index = newest.length - 1; index >= 0; index -= 1) {
    const row = newest[index] ?? '';
    const added = row.length + (kept.length === 0 ? 0 : 1);
    if (chars + added <= budgetChars) {
      kept.push(row);
      chars += added;
      continue;
    }
    if (kept.length === 0) {
      // The newest row ALONE is over budget: elide it toward the budget instead of dropping it,
      // because "nothing said" is a worse context than a shortened newest row.
      const fitted = elideRenderedVoiceRow(row, budgetChars);
      if (fitted !== '') {
        kept.push(fitted);
        chars = fitted.length;
      }
    }
    break;
  }

  kept.reverse();
  const truncatedText = kept.join('\n');
  return {
    text: truncatedText,
    chars: truncatedText.length,
    rows: kept.length,
    sourceChars,
    sourceRows,
    truncated: truncatedText !== text,
  };
}
