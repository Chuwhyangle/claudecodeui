/**
 * One draw: assemble the upstream request from the already-clipped message
 * context, run the first completion, and take exactly ONE supplement when fewer
 * than two chips survive.
 *
 * This unit owns the whole conversation with the gateway for one draw — the
 * request body, the retry-supplement prompt, the logging line and the
 * circuit/limit guard. It holds no per-session state: the caller passes the
 * chips already shown, and gets back the selected chips for the caller to record.
 *
 * A failure or a malformed answer is a 502 (`upstreamError`); the guard maps its
 * own circuit-open and rate-limit errors before any call is made.
 *
 * Consumers: `reply-suggestions.service.ts` (its only caller) and the service
 * criterion in `tests/reply-suggestions-service.test.ts`.
 */
import { AppError, isRecord } from '@/shared/utils.js';

import { parseSuggestionChips, selectChips } from './reply-suggestions-chips.js';
import {
  ReplySuggestionsClientError,
  type ReplySuggestionsCompletion,
  type ReplySuggestionsCompletionRequest,
} from './reply-suggestions-client.js';
import {
  createUpstreamGuard,
  replySuggestionsUpstreamError,
  type ReplySuggestionsUpstreamGuard,
} from './reply-suggestions-guard.js';
import {
  buildExpansionPrompt,
  buildUserPrompt,
  builtInExpansionSystemPrompt,
  builtInSystemPrompt,
  REPLY_SUGGESTIONS_REDRAW_MEMORY,
} from './reply-suggestions-prompts.js';
import type { ReplySuggestionsExpansionSource } from './reply-suggestions.service.js';
import type { ReplySuggestionsSettings } from './reply-suggestions-settings.js';

/** The already-clipped message context one draw shares across its one or two calls. */
type ReplySuggestionsDrawContext = {
  settings: ReplySuggestionsSettings;
  tail: string;
  focus: string;
  seed: string;
  expansionSource: ReplySuggestionsExpansionSource | null;
  redraw: boolean;
  /** The POST's correlation id, minted once by the service and kept across the supplement. */
  requestId: string;
};

/** The one method the service needs: produce the selected chips for a draw. */
type ReplySuggestionsDrawRunner = {
  draw(context: ReplySuggestionsDrawContext, shown: readonly string[]): Promise<string[]>;
};

/** Assemble one upstream request from the draw context. */
function composeRequest(
  context: ReplySuggestionsDrawContext,
  avoided: readonly string[],
  redraw: boolean,
): ReplySuggestionsCompletionRequest {
  const generation = context.settings.generation;
  const system = generation.systemPrompt.trim() !== ''
    ? generation.systemPrompt
    : context.expansionSource === null
      ? builtInSystemPrompt(generation.maxChipChars)
      : builtInExpansionSystemPrompt(generation.maxChipChars);
  const user = context.expansionSource === null
    ? buildUserPrompt({ tail: context.tail, focus: context.focus, avoid: avoided, redraw })
    : buildExpansionPrompt({ tail: context.tail, seed: context.seed, avoid: avoided });
  // An expansion is a diversification draw, so it uses the redraw temperature.
  const temperature = redraw || context.expansionSource !== null
    ? generation.redrawTemperature
    : generation.temperature;
  return {
    config: context.settings.upstream,
    system,
    user,
    temperature,
    maxOutputTokens: generation.maxOutputTokens,
  };
}

/** Parse one answer, mapping a malformed answer to the same 502 as a failed request. */
function parseChipsOrUpstreamFailure(text: string, requestId: string, model: string): string[] {
  try {
    return parseSuggestionChips(text);
  } catch (failure) {
    const category = failure instanceof ReplySuggestionsClientError ? failure.category : 'shape';
    throw replySuggestionsUpstreamError(category, { requestId, model });
  }
}

/** The category and upstream status one failed attempt reports, whichever layer refused it. */
function describeAttempt(failure: unknown): { category: string; httpStatus: number | null } {
  if (failure instanceof ReplySuggestionsClientError) {
    return { category: failure.category, httpStatus: failure.httpStatus };
  }
  if (failure instanceof AppError) {
    const message = failure.message.toLowerCase();
    if (message.includes('circuit-open')) return { category: 'circuit-open', httpStatus: null };
    if (failure.code === 'REPLY_SUGGESTIONS_RATE_LIMITED') return { category: 'rate-limit', httpStatus: null };
  }
  return { category: 'unknown', httpStatus: null };
}

/**
 * Build one draw runner over the injected completion seam. It creates its own
 * upstream guard, so the circuit and the sliding call caps are this unit's state
 * alone; `now` is injectable for criteria.
 *
 * Consumers: `reply-suggestions.service.ts` only.
 */
export function createDrawRunner(options: {
  complete: (request: ReplySuggestionsCompletionRequest) => Promise<ReplySuggestionsCompletion>;
  now: () => number;
  logger: (line: string) => void;
}): ReplySuggestionsDrawRunner {
  const { complete, now, logger } = options;
  const guard: ReplySuggestionsUpstreamGuard = createUpstreamGuard({ now });

  function logCompletion(
    settings: ReplySuggestionsSettings,
    durationMs: number,
    outcome: string,
    completion: ReplySuggestionsCompletion | null,
    requestId: string,
    httpStatus: number | null = null,
  ): void {
    const tokens: string[] = [];
    if (completion?.inputTokens != null) tokens.push(`inputTokens=${completion.inputTokens}`);
    if (completion?.outputTokens != null) tokens.push(`outputTokens=${completion.outputTokens}`);
    // Only protocol/model/version/duration/outcome/token counts/correlation — never text or the key.
    logger(
      `[reply-suggestions] protocol=${settings.upstream.protocol} model=${settings.upstream.model} ` +
        `version=${settings.version} durationMs=${durationMs}${tokens.length === 0 ? '' : ` ${tokens.join(' ')}`} ` +
        `outcome=${outcome} requestId=${requestId}${httpStatus === null ? '' : ` httpStatus=${httpStatus}`}`,
    );
  }

  /** One upstream attempt: the guard owns circuit/limits, this owns logging/mapping. */
  async function callUpstream(
    request: ReplySuggestionsCompletionRequest,
    settings: ReplySuggestionsSettings,
    requestId: string,
  ): Promise<ReplySuggestionsCompletion> {
    const startedAt = now();
    try {
      const completion = await guard.run(settings.limits, () => complete(request));
      logCompletion(settings, now() - startedAt, 'ok', completion, requestId);
      return completion;
    } catch (failure) {
      const { category, httpStatus } = describeAttempt(failure);
      logCompletion(settings, now() - startedAt, `error:${category}`, null, requestId, httpStatus);
      const details = { requestId, httpStatus, model: settings.upstream.model, category };
      if (failure instanceof AppError) {
        throw new AppError(failure.message, {
          code: failure.code,
          statusCode: failure.statusCode,
          details: { ...(isRecord(failure.details) ? failure.details : {}), ...details },
        });
      }
      throw replySuggestionsUpstreamError(category, details);
    }
  }

  return {
    async draw(context: ReplySuggestionsDrawContext, shown: readonly string[]): Promise<string[]> {
      const generation = context.settings.generation;
      // `avoid` only lists what a redraw was asked to steer away from.
      const avoid: readonly string[] = context.redraw ? shown.slice(-REPLY_SUGGESTIONS_REDRAW_MEMORY) : [];
      const first = await callUpstream(composeRequest(context, avoid, context.redraw), context.settings, context.requestId);
      const firstChips = parseChipsOrUpstreamFailure(first.text, context.requestId, context.settings.upstream.model);
      // The seed is "already shown" by definition: an identical variant is no variant.
      const seenBefore = context.expansionSource === 'seed' ? [...shown, context.seed] : shown;
      let selected = selectChips(firstChips, seenBefore, generation);
      // Fewer than two usable chips is a failed draw: supplement exactly ONCE.
      if (generation.maxChips >= 2 && selected.length < 2) {
        const supplement = await callUpstream(
          composeRequest(context, [...avoid, ...firstChips], true),
          context.settings,
          context.requestId,
        );
        selected = selectChips(
          [
            ...firstChips,
            ...parseChipsOrUpstreamFailure(supplement.text, context.requestId, context.settings.upstream.model),
          ],
          seenBefore,
          generation,
        );
      }
      return selected;
    },
  };
}
