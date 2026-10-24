/**
 * Reply-suggestion generation: the orchestration between the injected transcript
 * reader, the one-draw runner, the draw store and the usage ledger.
 *
 * THE SESSION IS READ, NEVER RECEIVED: the browser sends only an id, so a caller
 * cannot make the server echo arbitrary text to the gateway. This file owns the
 * request's shape, the per-session draw state and the ledger rows; the gateway
 * conversation is `reply-suggestions-draw.ts`, the state and cache are
 * `reply-suggestions-draw-store.ts`, prompts are `reply-suggestions-prompts.ts`,
 * chip parsing is `reply-suggestions-chips.ts` and the typed ledger rows are
 * `reply-suggestions-usage-log.ts`.
 *
 * A failure or an empty batch is never cached; a redraw replaces the batch; an
 * expansion draw neither reads nor writes it; a cache hit still leaves a `shown`
 * row so the display is counted apart from the paid call.
 *
 * Consumers: `reply-suggestions.routes.ts` and the service criterion.
 */
import { AppError } from '@/shared/utils.js';

import { tailCodePoints, truncateCodePoints } from './reply-suggestions-chips.js';
import {
  completeReplySuggestions,
  type ReplySuggestionsCompletion,
  type ReplySuggestionsCompletionRequest,
} from './reply-suggestions-client.js';
import { createDrawRunner } from './reply-suggestions-draw.js';
import { createDrawStore } from './reply-suggestions-draw-store.js';
import type { ReplySuggestionsSettings } from './reply-suggestions-settings.js';
import {
  createReplySuggestionsUsageLog,
  eventRecord,
  shownRecord,
  type ReplySuggestionsServed,
  type ReplySuggestionsUsageLog,
  type ReplySuggestionsUsageRecord,
} from './reply-suggestions-usage-log.js';

/** The last assistant message, as the injected reader reports it.
 * Consumers: `reply-suggestions.module.ts` and `server/index.ts` (through the barrel). */
export type LastAssistantMessage = { id: string; text: string };

/** Input the route has already parsed and validated.
 * Consumers: `reply-suggestions.routes.ts` and the service criterion. */
export type ReplySuggestionsInput = {
  sessionId: string;
  redraw?: boolean;
  focus?: string;
  /** The reply the person already picked; only meaningful with `expand: true`. */
  seed?: string;
  /** True for an expansion draw; refused unless the settings say `expansion: "vary"`. */
  expand?: boolean;
};

/**
 * What an expansion draw was anchored on: `seed` is the reply the person picked
 * (variants of it), `focus` is the quoted passage with no reply written yet.
 *
 * This file is the server end of the wire contract: the composer's
 * `src/shared/types.ts` mirrors this union and `src/shared/tests/replySuggestionsTypeSync.test.ts`
 * reds the moment either end gains or loses a member.
 *
 * Consumers: `reply-suggestions-usage-log.ts` (record fields),
 * `reply-suggestions-draw.ts`, `reply-suggestions-prompts.ts` and
 * `reply-suggestions.routes.ts`.
 */
export type ReplySuggestionsExpansionSource = 'seed' | 'focus';

/**
 * The pointer-click events the composer reports on `/events`.
 *
 * Declared here as the server end of the wire contract (the client mirror and
 * the drift test are named on `ReplySuggestionsExpansionSource` above).
 *
 * Consumers: `reply-suggestions-usage-log.ts` (record fields) and
 * `reply-suggestions.routes.ts`.
 */
export type ReplySuggestionsEventName = 'picked' | 'cleared' | 'redrawn' | 'sent';

/** One `/events` posting; `source` is present only for an expansion chip.
 * Consumers: `reply-suggestions.routes.ts` (its parsed event shape). */
export type ReplySuggestionsEventInput = {
  sessionId: string;
  draw: number;
  event: ReplySuggestionsEventName;
  index?: number;
  source?: ReplySuggestionsExpansionSource;
};

/** The reading `GET /status` exposes — no paths and no key.
 * Consumers: `reply-suggestions.routes.ts` and the settings criterion. */
export type ReplySuggestionsStatus = {
  enabled: boolean;
  expansion: ReplySuggestionsSettings['generation']['expansion'];
  maxChips: number;
  maxChipChars: number;
};

/** The public face of the service.
 * Consumers: `reply-suggestions.routes.ts` and the route criterion. */
export type ReplySuggestionsService = {
  status(): ReplySuggestionsStatus;
  suggest(input: ReplySuggestionsInput): Promise<{ chips: string[]; draw: number }>;
  recordEvent(input: ReplySuggestionsEventInput): void;
};

/** The injected seams; criteria replace `complete` and the reader with fakes.
 * Consumers: `reply-suggestions.module.ts` and both service-driving criteria. */
export type ReplySuggestionsServiceDeps = {
  readSettings: () => ReplySuggestionsSettings;
  readLastAssistantMessage: (sessionId: string) => Promise<LastAssistantMessage | null>;
  complete?: (request: ReplySuggestionsCompletionRequest) => Promise<ReplySuggestionsCompletion>;
  now?: () => number;
  logger?: (line: string) => void;
  usageLog?: ReplySuggestionsUsageLog;
};

/** The AppError for each non-2xx path; messages never carry the key or a payload. */
function disabledError(): AppError {
  return new AppError('reply suggestions are disabled', { code: 'REPLY_SUGGESTIONS_DISABLED', statusCode: 503 });
}

/** `expand: true` while the settings say `expansion: "off"`; refused before any upstream call. */
function expansionDisabledError(): AppError {
  return new AppError('reply-suggestions expansion is not enabled', {
    code: 'REPLY_SUGGESTIONS_EXPANSION_DISABLED',
    statusCode: 400,
  });
}

/** A structurally inconsistent expansion request. */
function invalidInputError(message: string): AppError {
  return new AppError(message, { code: 'INVALID_REQUEST', statusCode: 400 });
}

/** The coalescing identity of one draw: everything that decides its answer. */
function inflightKey(
  sessionId: string,
  messageId: string,
  redraw: boolean,
  focus: string,
  expansionSource: ReplySuggestionsExpansionSource | null,
  seed: string,
): string {
  return [sessionId, messageId, redraw ? 'redraw' : 'first', focus,
    expansionSource === null ? '' : `${expansionSource}:${seed}`].join('\u0000');
}

/**
 * Build the service over one settings source and one transcript reader.
 *
 * Consumers: `reply-suggestions.module.ts` only.
 */
export function createReplySuggestionsService(deps: ReplySuggestionsServiceDeps): ReplySuggestionsService {
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? ((line: string) => console.log(line));
  const complete = deps.complete ?? ((request: ReplySuggestionsCompletionRequest) => completeReplySuggestions(request));
  const usageLog = deps.usageLog ?? createReplySuggestionsUsageLog();
  const runner = createDrawRunner({ complete, now, logger });
  const store = createDrawStore();

  function writeUsage(record: ReplySuggestionsUsageRecord): void {
    try {
      usageLog.write(record);
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      logger(`[reply-suggestions] usage log write failed: ${reason}`);
    }
  }

  /** Append one `shown` row; `served` separates a paid draw from a cache hit. */
  function writeShownRow(
    sessionId: string,
    settings: ReplySuggestionsSettings,
    chips: readonly string[],
    draw: number,
    served: ReplySuggestionsServed,
    expansionSource: ReplySuggestionsExpansionSource | null,
  ): void {
    if (!settings.usageLog) return;
    writeUsage(shownRecord({
      at: new Date(now()).toISOString(),
      sessionId,
      draw,
      model: settings.upstream.model,
      protocol: settings.upstream.protocol,
      version: settings.version,
      served,
      ...(expansionSource === null ? {} : { expansion: expansionSource }),
      chips,
    }));
  }

  async function generate(
    input: ReplySuggestionsInput,
    settings: ReplySuggestionsSettings,
  ): Promise<{ chips: string[]; draw: number }> {
    const message = await deps.readLastAssistantMessage(input.sessionId);
    if (message === null || message.text.trim() === '') return { chips: [], draw: 0 };

    const redraw = input.redraw === true;
    const focus = input.focus === undefined ? '' : truncateCodePoints(input.focus, settings.generation.maxFocusChars);
    // A non-empty seed wins over focus; it is chip text, so it gets the chip budget.
    const expand = input.expand === true;
    const seed = expand && input.seed !== undefined
      ? truncateCodePoints(input.seed.trim(), settings.generation.maxChipChars)
      : '';
    const expansionSource: ReplySuggestionsExpansionSource | null = expand
      ? (seed !== '' ? 'seed' : 'focus')
      : null;

    // Only an ordinary first draw may be served from the cache; a hit returns the
    // batch unchanged and leaves a `shown` row, but spends no call budget.
    if (!redraw && !expand) {
      const cached = store.readBatch(input.sessionId, message.id, settings.version);
      if (cached !== undefined) {
        writeShownRow(input.sessionId, settings, cached.chips, cached.draw, 'cache', null);
        return cached;
      }
    }

    const key = inflightKey(input.sessionId, message.id, redraw, focus, expansionSource, seed);
    return store.coalesce(key, async () => {
      const shown = store.shownChips(input.sessionId, message.id);
      const selected = await runner.draw({
        settings,
        tail: tailCodePoints(message.text, settings.generation.maxTailChars),
        focus,
        seed,
        expansionSource,
        redraw,
      }, shown);
      const draw = store.recordDraw(input.sessionId, message.id, selected);
      // A redraw replaces the batch; an expansion leaves it untouched. An empty
      // draw forgets it, so the next request tries upstream again.
      if (!expand) {
        if (selected.length > 0) store.recordBatch(input.sessionId, message.id, settings.version, selected, draw);
        else store.forgetBatch(input.sessionId, message.id, settings.version);
      }
      writeShownRow(input.sessionId, settings, selected, draw, 'upstream', expansionSource);
      return { chips: selected, draw };
    });
  }

  return {
    status(): ReplySuggestionsStatus {
      const settings = deps.readSettings();
      return {
        enabled: settings.enabled,
        expansion: settings.generation.expansion,
        maxChips: settings.generation.maxChips,
        maxChipChars: settings.generation.maxChipChars,
      };
    },

    async suggest(input: ReplySuggestionsInput): Promise<{ chips: string[]; draw: number }> {
      const settings = deps.readSettings();
      if (!settings.enabled) throw disabledError();
      if (input.expand === true) {
        if (settings.generation.expansion !== 'vary') throw expansionDisabledError();
        if ((input.seed?.trim() ?? '') === '' && (input.focus?.trim() ?? '') === '') {
          throw invalidInputError('an expansion request needs a "seed" or a "focus"');
        }
      } else if ((input.seed?.trim() ?? '') !== '') {
        throw invalidInputError('"seed" is only valid with "expand": true');
      }
      return generate(input, settings);
    },

    recordEvent(input: ReplySuggestionsEventInput): void {
      const settings = deps.readSettings();
      if (!settings.usageLog) return;
      writeUsage(eventRecord({
        at: new Date(now()).toISOString(),
        sessionId: input.sessionId,
        draw: input.draw,
        event: input.event,
        ...(input.index === undefined ? {} : { index: input.index }),
        ...(input.source === undefined ? {} : { source: input.source }),
      }));
    },
  };
}
