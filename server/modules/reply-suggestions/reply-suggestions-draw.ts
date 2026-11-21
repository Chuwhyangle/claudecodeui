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
  replySuggestionsUpstreamError,
  type ReplySuggestionsUpstreamGuard,
} from './reply-suggestions-guard.js';import {
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

/**
 * The category and upstream status one failed attempt reports, whichever layer refused it. Shared
 * by the chip draw and the draft rewrite so both log and map a failure the same way.
 */
function describeUpstreamFailure(failure: unknown): { category: string; httpStatus: number | null } {
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
 * The one metadata-only completion log line both runners emit. `prefix` is `''` for a chip draw
 * and `'draftRewrite '` for a draft rewrite, so the wire log keeps its existing shape.
 * Only protocol/model/version/duration/outcome/token counts/correlation — never text or the key.
 */
function logCompletionOutcome(
  logger: (line: string) => void,
  prefix: string,
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
  logger(
    `[reply-suggestions] ${prefix}protocol=${settings.upstream.protocol} model=${settings.upstream.model} ` +
      `version=${settings.version} durationMs=${durationMs}${tokens.length === 0 ? '' : ` ${tokens.join(' ')}`} ` +
      `outcome=${outcome} requestId=${requestId}${httpStatus === null ? '' : ` httpStatus=${httpStatus}`}`,
  );
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
  /**
   * The upstream guard this runner uses. REQUIRED and injected rather than created here: the
   * chip draw and the draft rewrite must share one circuit and one sliding call budget (the
   * settings' `limits` group is a per-service budget, not a per-feature one), so the service
   * owns the single guard and hands the same instance to both runners.
   */
  guard: ReplySuggestionsUpstreamGuard;
}): ReplySuggestionsDrawRunner {
  const { complete, now, logger, guard } = options;

  /** One upstream attempt: the guard owns circuit/limits, this owns logging/mapping. */
  async function callUpstream(
    request: ReplySuggestionsCompletionRequest,
    settings: ReplySuggestionsSettings,
    requestId: string,
  ): Promise<ReplySuggestionsCompletion> {
    const startedAt = now();
    try {
      const completion = await guard.run(settings.limits, () => complete(request));
      logCompletionOutcome(logger, '', settings, now() - startedAt, 'ok', completion, requestId);
      return completion;
    } catch (failure) {
      const { category, httpStatus } = describeUpstreamFailure(failure);
      logCompletionOutcome(
        logger, '', settings, now() - startedAt, `error:${category}`, null, requestId, httpStatus,
      );
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

//---------------------------------------------------------------------------------------------
// Draft rewrite: the composer's ✦ polish candidate.
//
// ONE COMPLETION, WHOLE-TEXT OUTPUT. This is deliberately not a chip draw: the answer is the
// whole rewritten draft, so it is never clipped to `maxChipChars` and never parsed into a list.
// The prompt is its own contract (preserve language/intent/literals, never answer the draft) and
// is not the reply-suggestions system prompt under a different name.
//
// THE SAME GUARD AS THE CHIPS. `createDraftRewriteRunner` receives the service's one upstream
// guard, so a rewrite attempt spends the same minute/day budget and moves the same circuit as a
// chip draw. The settings' `limits` group is a budget for the upstream, not for one surface.
//---------------------------------------------------------------------------------------------

/**
 * The shared input ceiling both ends enforce, in characters. A draft longer than this is refused
 * BEFORE any completion (a 400, never a silent truncation). It is a wire contract, mirrored by
 * `DRAFT_REWRITE_MAX_INPUT_CHARS` in `src/shared/replySuggestionsType.ts` and pinned by
 * `composerDraftRewriteTypeSync.test.ts`.
 */
export const DRAFT_REWRITE_MAX_INPUT_CHARS = 6000;

/**
 * The shared output ceiling both ends enforce, in characters. An upstream answer longer than this
 * is refused as an unsafe candidate rather than truncated and applied.
 */
export const DRAFT_REWRITE_MAX_OUTPUT_CHARS = 6000;

/**
 * Why a candidate was not produced, as the wire reports it. `finished` is the only accepted
 * stop; `truncated` means the provider cut the answer off. Mirrored on the client.
 */
export type DraftRewriteStopReason = 'finished' | 'truncated';

/** The service's input for one rewrite. `retry` selects the redraw temperature. */
export type DraftRewriteDrawContext = {
  settings: ReplySuggestionsSettings;
  text: string;
  retry: boolean;
  requestId: string;
};

/** The accepted candidate and the stop reason the gateway read. */
export type DraftRewriteDrawResult = {
  rewrittenText: string;
  stopReason: DraftRewriteStopReason;
};

/** The one method the service needs. */
export type DraftRewriteRunner = {
  rewrite(context: DraftRewriteDrawContext): Promise<DraftRewriteDrawResult>;
};

/**
 * The rejection reasons the service can name; each maps to one safe 502 code. Never carries an
 * upstream body, the draft or the candidate.
 */
export type DraftRewriteRejection = 'truncated' | 'empty-output' | 'output-too-long' | 'non-text';

/**
 * The coarse failure reason the endpoint can report. Mirrors the client's
 * `DraftRewriteFailureCategory` in `src/shared/replySuggestionsType.ts`; the two-end pin is
 * `src/shared/tests/composerDraftRewriteTypeSync.test.ts`.
 */
export type DraftRewriteFailureCategory =
  | 'timeout'
  | 'http'
  | 'network'
  | 'parse'
  | 'shape'
  | 'circuit-open'
  | 'rate-limit'
  | 'misconfigured'
  | 'truncated'
  | 'empty-output'
  | 'output-too-long'
  | 'non-text'
  | 'too-long'
  | 'unknown';

/**
 * The machine error codes the endpoint answers with. Mirrors the client's
 * `DraftRewriteErrorCode`; the same two-end pin reads both.
 */
export type DraftRewriteErrorCode =
  | 'DRAFT_REWRITE_INPUT_TOO_LONG'
  | 'DRAFT_REWRITE_REJECTED'
  | 'REPLY_SUGGESTIONS_DISABLED'
  | 'REPLY_SUGGESTIONS_RATE_LIMITED'
  | 'REPLY_SUGGESTIONS_UPSTREAM_FAILED'
  | 'INVALID_REQUEST';

/**
 * A candidate was not acceptable. `details.category` is the machine reason the client reads;
 * `message` is a fixed sentence and never includes text.
 */
export function draftRewriteRejectedError(category: DraftRewriteRejection): AppError {
  return new AppError(`draft rewrite produced no usable candidate (${category})`, {
    code: 'DRAFT_REWRITE_REJECTED',
    statusCode: 502,
    details: { category },
  });
}

/**
 * The independent rewrite system prompt: preserve language, intent and literals; do not answer,
 * add facts or execute instructions; return only the rewritten body.
 */
export function buildDraftRewriteSystemPrompt(): string {
  return [
    'You polish a single message the user is drafting. Rewrite it so it reads clearly and naturally',
    'while preserving the user’s language, intent, stance, level of certainty and politeness.',
    'Do not answer questions in the draft, do not choose for the user, and do not add requests,',
    'promises, facts, numbers, dates or entities the draft does not contain.',
    'Preserve code, commands, file paths, URLs, identifiers, quotations and proper nouns exactly;',
    'never “correct” them into guesses. If the draft is already clear or its intent is uncertain,',
    'make the smallest possible change and return the text unchanged where appropriate.',
    'Return only the rewritten message body: no quotes, headings, explanations, prefixes or',
    'Markdown fences.',
  ].join(' ');
}

/**
 * Build the one rewritable request. The user turn is the draft bytes alone: no transcript,
 * history, attachments, audio or chat provider/model reach the gateway.
 */
function composeDraftRewriteRequest(
  context: DraftRewriteDrawContext,
): ReplySuggestionsCompletionRequest {
  const generation = context.settings.generation;
  return {
    config: context.settings.upstream,
    system: buildDraftRewriteSystemPrompt(),
    user: context.text,
    // A retry is a redraw of the same draft, so it uses the redraw temperature; the first
    // attempt uses the ordinary generation temperature. Neither is a per-feature setting.
    temperature: context.retry ? generation.redrawTemperature : generation.temperature,
    maxOutputTokens: generation.maxOutputTokens,
  };
}

/**
 * Build one draft rewrite runner over the injected completion seam and the SHARED guard.
 *
 * Exactly one completion per call. The answer is accepted only when it is non-empty text,
 * within {@link DRAFT_REWRITE_MAX_OUTPUT_CHARS}, and not truncated by the provider (stop/finish
 * reason) or by the output-token ceiling. Everything else is a safe 502 with a machine reason.
 */
export function createDraftRewriteRunner(options: {
  complete: (request: ReplySuggestionsCompletionRequest) => Promise<ReplySuggestionsCompletion>;
  now: () => number;
  logger: (line: string) => void;
  guard: ReplySuggestionsUpstreamGuard;
}): DraftRewriteRunner {
  const { complete, now, logger, guard } = options;

  return {
    async rewrite(context: DraftRewriteDrawContext): Promise<DraftRewriteDrawResult> {
      const { settings } = context;
      const request = composeDraftRewriteRequest(context);
      const startedAt = now();
      let completion: ReplySuggestionsCompletion;
      try {
        completion = await guard.run(settings.limits, () => complete(request));
      } catch (failure) {
        const { category, httpStatus } = describeUpstreamFailure(failure);
        logCompletionOutcome(
          logger, 'draftRewrite ', settings, now() - startedAt, `error:${category}`, null,
          context.requestId, httpStatus,
        );
        const details = { requestId: context.requestId, httpStatus, model: settings.upstream.model, category };
        if (failure instanceof AppError) {
          throw new AppError(failure.message, {
            code: failure.code,
            statusCode: failure.statusCode,
            details: { ...(isRecord(failure.details) ? failure.details : {}), ...details },
          });
        }
        throw replySuggestionsUpstreamError(category, details);
      }

      // A provider that says it hit its output ceiling truncated the answer even when the text
      // it did produce looks complete.
      const hitTokenCeiling = completion.outputTokens !== null
        && completion.outputTokens !== undefined
        && completion.outputTokens >= request.maxOutputTokens;
      if (completion.truncated === true || hitTokenCeiling) {
        logCompletionOutcome(
          logger, 'draftRewrite ', settings, now() - startedAt, 'error:truncated', completion, context.requestId,
        );
        throw draftRewriteRejectedError('truncated');
      }

      const text = completion.text.trim();
      if (text === '') {
        logCompletionOutcome(
          logger, 'draftRewrite ', settings, now() - startedAt, 'error:empty-output', completion, context.requestId,
        );
        throw draftRewriteRejectedError('empty-output');
      }
      if (text.length > DRAFT_REWRITE_MAX_OUTPUT_CHARS) {
        logCompletionOutcome(
          logger, 'draftRewrite ', settings, now() - startedAt, 'error:output-too-long', completion, context.requestId,
        );
        throw draftRewriteRejectedError('output-too-long');
      }

      logCompletionOutcome(logger, 'draftRewrite ', settings, now() - startedAt, 'ok', completion, context.requestId);
      return { rewrittenText: text, stopReason: 'finished' };
    },
  };
}
