/**
 * The reply-suggestions reading the Settings diagnostics surface renders.
 *
 * WHY IT IS ITS OWN FILE. `reply-suggestions.service.ts` sits at the backend
 * service ratchet; the diagnostics projection is a distinct concern (what an
 * operator reads) from the draw orchestration (what the composer asks for), and
 * copying the failure ring's shape into the module would make a second place to
 * change. This reader shares the SAME settings source and failure tracker the
 * HTTP module uses, so the Settings page reports what the composer actually
 * experienced rather than a second, independently-observed collection.
 *
 * IT CARRIES NO SECRETS: state, problems (already the settings reader's
 * key-free strings), the last success timestamp, the failure records (category,
 * upstream status, request id, model, protocol) and a config-source label. The
 * HTTP key never enters this type.
 *
 * Consumers: `server/index.ts` (adapts it into the diagnostics module's feature
 * provider) and the diagnostics service criterion.
 */
import type { ReplySuggestionsFailure, ReplySuggestionsState } from './reply-suggestions-failure-state.js';
import { replySuggestionsState } from './reply-suggestions-failure-state.js';
import type { ReplySuggestionsFailureState } from './reply-suggestions-failure-state.js';
import type { ReplySuggestionsSettings } from './reply-suggestions-settings.js';

/**
 * One diagnostics reading for the reply-suggestions feature.
 *
 * `state` is the settings-derived state (`off` / `misconfigured` / `ready`); the
 * diagnostics service decides whether a `ready` feature with a live failure is
 * `degraded`, so this reading never guesses that.
 */
export type ReplySuggestionsDiagnosticsReading = {
  state: ReplySuggestionsState;
  enabled: boolean;
  problems: string[];
  lastSuccessAt: string | null;
  lastFailure: ReplySuggestionsFailure | null;
  /** Newest first, already capped by the tracker's own ring size. */
  failures: ReplySuggestionsFailure[];
  /** `default`, or `file:<path>` — never the key file's contents. */
  configSource: string | null;
};

/** The reader the composition root hands to `modules/diagnostics`.
 * Consumers: `server/index.ts` and the diagnostics service criterion. */
export type ReplySuggestionsDiagnostics = {
  read: () => ReplySuggestionsDiagnosticsReading;
};

/**
 * Build the diagnostics reading over the shared settings source and failure
 * tracker.
 *
 * Consumers: `server/index.ts` only (through the barrel).
 */
export function createReplySuggestionsDiagnostics(deps: {
  readSettings: () => ReplySuggestionsSettings;
  failureState: ReplySuggestionsFailureState;
}): ReplySuggestionsDiagnostics {
  return {
    read(): ReplySuggestionsDiagnosticsReading {
      const settings = deps.readSettings();
      const observed = settings.diagnostics;
      return {
        state: replySuggestionsState(settings),
        enabled: settings.enabled,
        problems: [...observed.problems],
        lastSuccessAt: deps.failureState.lastSuccessAt(),
        lastFailure: deps.failureState.lastFailure(),
        // The tracker keeps oldest-first; both diagnostics surfaces read newest-first.
        failures: [...deps.failureState.history()].reverse(),
        configSource: observed.path === null ? observed.source : `${observed.source}:${observed.path}`,
      };
    },
  };
}
