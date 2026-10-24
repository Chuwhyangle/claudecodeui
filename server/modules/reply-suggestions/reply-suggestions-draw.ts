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
import { AppError } from '@/shared/utils.js';

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
      : builtInExpansionSystemPrompt(generation.maxChipChars, context.expansionSource);
  const user = context.expansionSource === null
    ? buildUserPrompt({ tail: context.tail, focus: context.focus, avoid: avoided, redraw })
    : buildExpansionPrompt({ tail: context.tail, focus: context.focus, seed: context.seed, avoid: avoided });
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
function parseChipsOrUpstreamFailure(text: string): string[] {
  try {
    return parseSuggestionChips(text);
  } catch (failure) {
    const category = failure instanceof ReplySuggestionsClientError ? failure.category : 'shape';
    throw replySuggestionsUpstreamError(category);
  }
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
  ): void {
    const tokens: string[] = [];
    if (completion?.inputTokens != null) tokens.push(`inputTokens=${completion.inputTokens}`);
    if (completion?.outputTokens != null) tokens.push(`outputTokens=${completion.outputTokens}`);
    // Only protocol/model/version/duration/outcome/token counts — never text or the key.
    logger(
      `[reply-suggestions] protocol=${settings.upstream.protocol} model=${settings.upstream.model} ` +
        `version=${settings.version} durationMs=${durationMs}${tokens.length === 0 ? '' : ` ${tokens.join(' ')}`} ` +
        `outcome=${outcome}`,
    );
  }

  /** One upstream attempt: the guard owns circuit/limits, this owns logging/mapping. */
  async function callUpstream(
    request: ReplySuggestionsCompletionRequest,
    settings: ReplySuggestionsSettings,
  ): Promise<ReplySuggestionsCompletion> {
    return guard.run(settings.limits, async () => {
      const startedAt = now();
      try {
        const completion = await complete(request);
        logCompletion(settings, now() - startedAt, 'ok', completion);
        return completion;
      } catch (failure) {
        const category = failure instanceof ReplySuggestionsClientError ? failure.category : 'unknown';
        logCompletion(settings, now() - startedAt, `error:${category}`, null);
        if (failure instanceof AppError) throw failure;
        throw replySuggestionsUpstreamError(category);
      }
    });
  }

  return {
    async draw(context: ReplySuggestionsDrawContext, shown: readonly string[]): Promise<string[]> {
      const generation = context.settings.generation;
      // `avoid` only lists what a redraw was asked to steer away from.
      const avoid: readonly string[] = context.redraw ? shown.slice(-REPLY_SUGGESTIONS_REDRAW_MEMORY) : [];
      const first = await callUpstream(composeRequest(context, avoid, context.redraw), context.settings);
      const firstChips = parseChipsOrUpstreamFailure(first.text);
      // The seed is "already shown" by definition: an identical variant is no variant.
      const seenBefore = context.expansionSource === 'seed' ? [...shown, context.seed] : shown;
      let selected = selectChips(firstChips, seenBefore, generation);
      // Fewer than two usable chips is a failed draw: supplement exactly ONCE.
      if (generation.maxChips >= 2 && selected.length < 2) {
        const supplement = await callUpstream(
          composeRequest(context, [...avoid, ...firstChips], true),
          context.settings,
        );
        selected = selectChips([...firstChips, ...parseChipsOrUpstreamFailure(supplement.text)], seenBefore, generation);
      }
      return selected;
    },
  };
}
