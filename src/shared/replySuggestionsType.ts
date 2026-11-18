/**
 * The reply-suggestions wire types, a type-only leaf directly under `src/shared`.
 *
 * WHY NOT `src/shared/types.ts`: that file is an oversize-ratchet baseline entry
 * that may only shrink, and the reply-suggestions surface grew enough to move it
 * up. `src/shared/types.ts` re-exports these names, so every existing
 * `@/shared/types` import keeps working.
 *
 * WHY THE SHARED ROOT, NOT `src/shared/api`: the transport in `src/shared/api`
 * already value-imports `src/shared/types.ts`, so having `types.ts` import a leaf
 * under `src/shared/api` closed the `shared <-> shared/api` DIRECTORY cycle that
 * `server/shared/tests/frontend-import-cycle-budget.test.ts` pins to its baseline.
 * Here both readers and the barrel reach the leaf without leaving their own
 * directory, and no new edge points back up.
 *
 * Consumers: `src/shared/api/clientTail.ts` and `src/shared/api/requests.ts`
 * (the transport), the reply controller, the composer hook and its notice, and
 * `src/shared/tests/replySuggestionsTypeSync.test.ts` (the two-end pin).
 */
//----------------- REPLY SUGGESTIONS ------------

/**
 * The coarse reason a suggestion draw failed, shared with the server
 * (`server/modules/reply-suggestions/reply-suggestions-failure-state.ts`; the two
 * ends are pinned by `replySuggestionsTypeSync.test.ts`). The composer picks the
 * notice copy from it: an upstream HTTP failure, a spent call budget, the open
 * circuit, a network/timeout failure, or a settings file that cannot draw.
 */
export type ReplySuggestionsFailureCategory =
  | 'timeout'
  | 'http'
  | 'network'
  | 'parse'
  | 'shape'
  | 'circuit-open'
  | 'rate-limit'
  | 'misconfigured'
  | 'unknown';

/** The three settings-derived states `/status` publishes.
 *
 * `off` is an explicit `enabled: false`; `misconfigured` is "asked for, but a
 * required item is missing"; `ready` is the only state that draws chips. */
export type ReplySuggestionsState = 'off' | 'misconfigured' | 'ready';

/**
 * The last failed draw as `/status` reports it (the server's failure record,
 * mirrored). It carries correlation facts only — never a prompt, an answer body
 * or a key — so the composer can fill its detail popover.
 */
export type ReplySuggestionsLastFailure = {
  /** When the draw failed, ISO-8601. */
  at: string;
  /** The id minted for that one POST; correlates the log line and the error body. */
  requestId: string;
  category: ReplySuggestionsFailureCategory;
  /** The upstream HTTP status when the failure was an HTTP answer, else null. */
  httpStatus: number | null;
  durationMs: number;
  model: string;
  protocol: 'anthropic' | 'openai';
};

/**
 * One failed draw as the controller remembers it for this session. Built from the
 * typed failure the API answered with, so the inline notice and its popover can
 * name the code, the upstream status, the request id and the model.
 */
export type ReplySuggestionsFailure = {
  /** When this client observed the failure, ISO-8601. */
  at: string;
  /** The server's machine code (`REPLY_SUGGESTIONS_UPSTREAM_FAILED`, …). */
  code: string;
  category: ReplySuggestionsFailureCategory;
  httpStatus: number | null;
  requestId: string | null;
  model: string | null;
  /** The server's message; never a key or a prompt. */
  message: string;
};

/**
 * The public reading of the reply-suggestions feature, from `GET /api/reply-suggestions/status`.
 *
 * Carries no key and no prompt on purpose: the composer needs to know whether the
 * feature can draw, which missing setting (if any) blocks it, and what the last
 * failure was; the server owns everything else.
 */
export type ReplySuggestionsStatus = {
  /** False means the composer neither extracts nor draws the Suggest button. */
  enabled: boolean;
  /** Why it is (not) drawable: an explicit off, a missing setting, or ready. */
  state: ReplySuggestionsState;
  /** What the settings reader found wrong; may name the settings path, never a key. */
  problems: string[];
  /** The most recent failed draw, or null when the last attempt succeeded. */
  lastFailure: ReplySuggestionsLastFailure | null;
  /** The experimental post-pick expansion switch: `vary` makes a picked chip expand into variants. */
  expansion: 'off' | 'vary';
  /** Most model chips one draw may return. */
  maxChips: number;
  /** Longest chip text one draw may return, before the client's own label truncation. */
  maxChipChars: number;
};

/** One completed draw, from `POST /api/reply-suggestions`. `draw` names the batch later events refer to. */
export type ReplySuggestionsResult = {
  /** Complete reply texts, already deduplicated and capped by the server. */
  chips: string[];
  /** Local to this session; the ledger events refer to it. */
  draw: number;
};

/**
 * The discriminated answer of `POST /api/reply-suggestions`: a batch, or the typed
 * reason there is none. The controller switches on `ok` instead of conflating a
 * refused draw with an unreadable answer (the old `null`).
 */
export type ReplySuggestionsSuggestResponse =
  | { ok: true; result: ReplySuggestionsResult }
  | { ok: false; failure: ReplySuggestionsFailure };

/**
 * The text an expansion draw is anchored on: `seed` is the reply the person
 * already picked (it asks for variants). Reported on a `picked` event so the
 * ledger can mark a chip that came from an expansion draw; the anchored text
 * itself is not stored.
 */
export type ReplySuggestionsExpansionSource = 'seed';

/** The pointer/outcome events the composer reports on `POST /api/reply-suggestions/events`. */
export type ReplySuggestionsEventName = 'picked' | 'cleared' | 'redrawn' | 'sent';

/** One ledger event; `index` is present only when a specific chip was picked. */
export type ReplySuggestionsEventInput = {
  sessionId: string;
  draw: number;
  event: ReplySuggestionsEventName;
  index?: number;
  /** Present only when the picked chip came from an expansion draw. */
  source?: ReplySuggestionsExpansionSource;
};

/**
 * One request for a draw; `redraw` asks for a fresh batch, `focus` is the transcript text to centre on.
 *
 * `expand: true` marks the experimental post-pick expansion: `seed` then asks for
 * variants of the picked reply and is required. The server refuses the shape
 * unless `expansion` is `vary`.
 */
export type ReplySuggestionsRequest = {
  sessionId: string;
  redraw?: boolean;
  focus?: string;
  seed?: string;
  expand?: boolean;
};

