import type { AnyRecord, LLMProvider } from '@/shared/types.js';

/**
 * How an edited conversation recovers the context its replacement turn continues
 * from.
 *
 * The two shapes are independent of the session's lifecycle mode: a per-run
 * session and a resident session can each need either one, and a resident
 * session needs its host closed in addition to whichever recovery applies. That
 * independence is the whole point of stating this as a value — the previous
 * gateway branched "provider rewinds" against "resident rebuild" as if they
 * were mutually exclusive, which silently skipped the host close for a provider
 * that branches (Codex).
 *
 * - `resume-at-anchor`: the provider can resume partway, so the anchor rides
 *   along to its runtime as a resume option. `keepThroughId` is the last row to
 *   keep, or `null` when the edited turn was the first prompt and the
 *   conversation starts over.
 * - `binding-replaced`: the provider cannot resume partway and replaces the
 *   session's provider transcript binding on disk (Codex's `thread/fork`). The
 *   run that follows carries no anchor at all — the provider runtime resumes
 *   from whatever binding the session now points at.
 */
export type ChatEditRecovery = {
  readonly kind: 'resume-at-anchor' | 'binding-replaced';
  /** Last transcript row to keep; `null` means keep nothing (the first prompt). */
  readonly keepThroughId: string | null;
};

/**
 * What an admitted edit-send will do before its replacement run starts.
 *
 * Produced by {@link ChatEditPreparationService.prepare} without side effects,
 * so the gateway can decide the run's resume options and refusal before
 * anything is closed or rewound, and applied only after the run registry has
 * admitted the turn.
 */
export type ChatEditPlan = {
  readonly sessionId: string;
  readonly provider: LLMProvider;
  readonly anchorId: string;
  readonly recovery: ChatEditRecovery;
  /** Whether a resident process holds the old conversation and must close first. */
  readonly closesResidentHost: boolean;
  /**
   * Whether applying the plan changes conversation state before the run starts.
   * A failure while applying it, or a run that fails to start afterwards, must
   * settle the edit as one failure rather than leave the old conversation live.
   */
  readonly mutatesBeforeRun: boolean;
};

/** The verdict `prepare` reaches before any side effect. */
export type ChatEditPreparationOutcome =
  | { readonly kind: 'ready'; readonly plan: ChatEditPlan }
  /** The provider has no edit-anchor capability at all. */
  | { readonly kind: 'unsupported-provider' }
  /** The provider could look, and the anchor is not in the transcript. */
  | { readonly kind: 'anchor-not-found' }
  /** Reading the transcript or the session failed. */
  | { readonly kind: 'lookup-failed'; readonly message: string };

/** The verdict `apply` reaches after running the plan's side effects in order. */
export type ChatEditApplyResult =
  | { readonly kind: 'applied'; readonly hostClosed: boolean }
  | {
      readonly kind: 'failed';
      /** Which preparation step failed; the run must not be started after either. */
      readonly stage: 'close' | 'rewind';
      readonly message: string;
    };

/**
 * The collaborators an edit preparation needs, injected so the orchestration is
 * testable without a database, a provider registry or a live host.
 *
 * Every member answers one question of the shipped services; the preparation
 * itself owns only their order and the rule that a failure stops the chain.
 */
export type ChatEditPreparationDeps = {
  /**
   * Provider-side anchor lookup. `null` means the provider cannot edit at all;
   * `{ found: false }` means this particular anchor is gone.
   */
  resolveEditAnchor(
    sessionId: string,
    anchorId: string,
  ): Promise<{ found: boolean; resumeThroughId: string | null } | null>;
  /** Whether this provider branches on disk instead of resuming partway. */
  providerRewindsForEdit(sessionId: string): boolean;
  /** The stored lifecycle mode: a resident session holds a process across turns. */
  isResidentSession(sessionId: string): boolean;
  /** Replaces the session's provider transcript binding; used by branch providers. */
  rewindSessionForEdit(sessionId: string, keepThroughId: string | null): Promise<void>;
  /**
   * Closes the resident host and reports the driver's own outcome. Rejects when
   * the driver refuses; `{ found: false }` means there was nothing to close.
   */
  closeHostForEditAndWait(sessionId: string): Promise<{ found: boolean }>;
};

/**
 * The provider-run options an edit's recovery implies.
 *
 * `binding-replaced` passes nothing: the provider runtime resolves the session's
 * current binding itself, and handing it a Claude resume anchor it never reads
 * would only invite a second, disagreeing statement of where to resume.
 */
export function chatEditRuntimeOptions(recovery: ChatEditRecovery): AnyRecord {
  if (recovery.kind === 'binding-replaced') {
    return {};
  }
  return recovery.keepThroughId === null
    ? { resumeFromScratch: true }
    : { resumeAnchorId: recovery.keepThroughId, resumeFromScratch: false };
}

/**
 * Chat edit-send's shared preparation: what must happen before a replacement
 * turn may run, in the only order that is safe.
 *
 * Consumed by the chat websocket gateway's `chat.edit-send` handler, which
 * resolves the request target, awaits `prepare` (no side effects), lets the run
 * registry admit the turn, and then applies the plan inside the admitted run's
 * `beforeRun` hook. Split in two on purpose: an edit that is refused — busy
 * session, unknown anchor, unsupported provider — must not close a host or
 * replace a binding.
 *
 * The order `apply` enforces is:
 *
 *  1. announce the truncation, so every watching tab drops the superseded turns
 *     before a slow close/rewind begins;
 *  2. close the resident host, strictly — a refusal stops the chain;
 *  3. let the provider prepare its own recovery (rewind/replace the binding);
 *  4. the caller starts the run, which resolves the *latest* binding.
 *
 * Lifecycle and provider recovery are composed here as two independent facts.
 * This service never branches on a provider name; the provider states whether
 * it rewinds through its own capability, and the session states its lifecycle
 * mode.
 */
export function createChatEditPreparationService(deps: ChatEditPreparationDeps) {
  return {
    /**
     * Resolves the edit into a plan without changing anything.
     */
    async prepare(input: {
      sessionId: string;
      provider: LLMProvider;
      anchorId: string;
    }): Promise<ChatEditPreparationOutcome> {
      const { sessionId, provider, anchorId } = input;

      let anchor: { found: boolean; resumeThroughId: string | null } | null;
      let providerRewinds: boolean;
      let resident: boolean;
      try {
        anchor = await deps.resolveEditAnchor(sessionId, anchorId);
        if (anchor === null) {
          return { kind: 'unsupported-provider' };
        }
        if (!anchor.found) {
          return { kind: 'anchor-not-found' };
        }
        providerRewinds = deps.providerRewindsForEdit(sessionId);
        resident = deps.isResidentSession(sessionId);
      } catch (error) {
        return { kind: 'lookup-failed', message: error instanceof Error ? error.message : String(error) };
      }

      const recovery: ChatEditRecovery = {
        kind: providerRewinds ? 'binding-replaced' : 'resume-at-anchor',
        keepThroughId: anchor.resumeThroughId,
      };

      return {
        kind: 'ready',
        plan: {
          sessionId,
          provider,
          anchorId,
          recovery,
          closesResidentHost: resident,
          mutatesBeforeRun: resident || providerRewinds,
        },
      };
    },

    /**
     * The provider-run options the plan's recovery implies.
     */
    runtimeOptions(plan: ChatEditPlan): AnyRecord {
      return chatEditRuntimeOptions(plan.recovery);
    },

    /**
     * Performs the plan's side effects in the one safe order.
     *
     * Never throws: a failure is reported with the stage that produced it, so
     * the gateway can settle the run and report the edit once. The truncation
     * announcement always happens first, even when the close then fails — the
     * client re-reads the transcript when the terminal frame lands, so a
     * truncation that turned out not to be applied is repaired the same way a
     * successful one is.
     */
    async apply(
      plan: ChatEditPlan,
      hooks: { onTruncate: () => void },
    ): Promise<ChatEditApplyResult> {
      hooks.onTruncate();

      let hostClosed = false;
      if (plan.closesResidentHost) {
        try {
          hostClosed = (await deps.closeHostForEditAndWait(plan.sessionId)).found;
        } catch (error) {
          return {
            kind: 'failed',
            stage: 'close',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }

      if (plan.recovery.kind === 'binding-replaced') {
        try {
          await deps.rewindSessionForEdit(plan.sessionId, plan.recovery.keepThroughId);
        } catch (error) {
          return {
            kind: 'failed',
            stage: 'rewind',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }

      return { kind: 'applied', hostClosed };
    },
  };
}

export type ChatEditPreparationService = ReturnType<typeof createChatEditPreparationService>;
