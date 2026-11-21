import type {
  DraftRewriteFailure,
  DraftRewriteRequest,
  DraftRewriteResponse,
} from '@/shared/replySuggestionsType';
import { createExternalStore } from '@/shared/utils';

/**
 * The composer's ✦ draft-rewrite candidate, as a React-free controller.
 *
 * WHY A CONTROLLER. The rules — one in-flight request, the draft/scope snapshot a response is
 * valid for, the collapsed-but-kept candidate, the retry de-duplication and the apply guard —
 * are asynchronous and must be readable without React. The hook that binds this controller is a
 * thin `useSyncExternalStore` subscriber; the component only draws the snapshot.
 *
 * THE STATE MACHINE.
 *
 *   idle ──openOrRequest──▶ expanded(requesting) ──answer──▶ expanded(candidate)
 *                                  │                              │
 *                                  └──failure──▶ expanded(error)   ├─collapse()─▶ collapsed(candidate)
 *                                                                  │                 │
 *                                                                  │        openOrRequest() (no request)
 *                                                                  │
 *   any state ──edit/clear/send/scope change/dispose──▶ idle (candidate dropped)
 *
 * WHAT A LATE ANSWER MAY NOT DO. Every request captures the draft text, the draft scope and the
 * session it was made for, plus a sequence token. A response is accepted only while all four are
 * still current; an edit, a clear, a scope/session switch or `dispose` bumps the token, so a late
 * answer neither enters the cache nor writes the draft.
 *
 * APPLY IS THE ONLY DRAFT WRITER. The controller never constructs or sends a message: `apply`
 * checks the current draft is still the exact snapshot the candidate was produced for, then calls
 * the injected writer (the composer's one draft path) and collapses. The caller remains
 * responsible for remapping voice ranges and clearing chip attribution — this controller has no
 * knowledge of them.
 *
 * Consumers: `useDraftRewrite` (the React binding), the composer state hook (which routes edit,
 * clear, send and scope changes) and the controller criterion.
 */

/** One request's identity; everything that must still hold when its answer arrives. */
type RequestSnapshot = {
  sessionId: string | null;
  draftScope: string | null;
  draft: string;
  token: number;
};

/** The page's reading of what the controller should draw, handed in every render. */
export type DraftRewriteContext = {
  /** The open conversation, or null before one exists. */
  sessionId: string | null;
  /** The composer's draft scope (a session id, or `project:<id>` before the first send). */
  draftScope: string | null;
  /** The draft exactly as the textarea shows it. */
  draft: string;
  /** The shared reply-suggestions feature is enabled (the rewrite shares its settings). */
  enabled: boolean;
};

/** Everything the composer draws; the identity changes only when a published value changed. */
export type DraftRewriteSnapshot = {
  /** The ✦ chip may be drawn: the feature is on AND the draft is non-blank. */
  available: boolean;
  /** The candidate panel is open (requesting, candidate or error). */
  expanded: boolean;
  /** A request is in flight; the retry icon is disabled and the panel shows progress. */
  loading: boolean;
  /** The last accepted candidate. Kept while collapsed so re-opening spends no call. */
  candidate: string | null;
  /** The failure of the last request, or null after a success or a reset. */
  failure: DraftRewriteFailure | null;
};

/** The commands the hook and the component drive. */
export type DraftRewriteController = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => DraftRewriteSnapshot;
  /** The page's current session/scope/draft/enabled reading. A changed scope resets. */
  setContext: (context: DraftRewriteContext) => void;
  /** Expand, restoring a cached candidate or starting the one request. */
  openOrRequest: () => void;
  /** Fold the panel; a candidate and an in-flight request are kept. */
  collapse: () => void;
  /** Ask again for the same draft. A no-op while a request is already in flight. */
  retry: () => void;
  /** Write the candidate into the draft through the injected writer, then fold. */
  apply: () => void;
  /** A user edit: the candidate belonged to the old bytes, so drop it and fold. */
  invalidate: () => void;
  /** clear/send/scope switch: drop the candidate, the failure and the panel. */
  reset: () => void;
  /** Stop late answers and listeners; the controller is not reusable afterwards. */
  dispose: () => void;
};

/** The one transport the controller knows. */
export type DraftRewriteApi = {
  rewrite: (request: DraftRewriteRequest) => Promise<DraftRewriteResponse>;
};

/** The controller's injected dependencies; production binds the API and the composer's writer. */
export type DraftRewriteControllerOptions = {
  api: DraftRewriteApi;
  /** The composer's one draft writer (state + send-time mirror + voice/chip bookkeeping). */
  writeDraft: (text: string) => void;
  /** Failure timestamps; injectable so a criterion needs no wall clock. */
  now?: () => number;
};

const emptyContext: DraftRewriteContext = {
  sessionId: null,
  draftScope: null,
  draft: '',
  enabled: false,
};

function isSameContextSnapshot(
  context: DraftRewriteContext,
  snapshot: RequestSnapshot,
): boolean {
  return context.sessionId === snapshot.sessionId
    && context.draftScope === snapshot.draftScope
    && context.draft === snapshot.draft;
}

/** Build one controller. */
export function createDraftRewriteController(
  options: DraftRewriteControllerOptions,
): DraftRewriteController {
  const { api, writeDraft } = options;
  const now = options.now ?? Date.now;

  let context: DraftRewriteContext = emptyContext;
  let expanded = false;
  let loading = false;
  let candidate: string | null = null;
  let failure: DraftRewriteFailure | null = null;
  /**
   * The draft the cached candidate was produced for. `apply` requires the live draft to equal it
   * as well as the request snapshot, so a candidate can never replace different bytes just
   * because the controller was not reset (a programmatic write that bypassed setContext).
   */
  let candidateDraft: string | null = null;
  let disposed = false;
  /** Bumped by every request, every invalidation and every reset; a late answer compares it. */
  let requestSeq = 0;

  const buildSnapshot = (): DraftRewriteSnapshot => ({
    available: context.enabled && context.draft.trim() !== '',
    expanded,
    loading,
    candidate,
    failure,
  });

  const store = createExternalStore<DraftRewriteSnapshot>(buildSnapshot());

  const publish = (): void => {
    if (disposed) return;
    const next = buildSnapshot();
    const previous = store.getSnapshot();
    if (
      previous.available === next.available
      && previous.expanded === next.expanded
      && previous.loading === next.loading
      && previous.candidate === next.candidate
      && previous.failure === next.failure
    ) {
      return;
    }
    store.set(next);
  };

  /** Drops the candidate and the error and folds the panel; a request in flight is invalidated. */
  const reset = (): void => {
    requestSeq += 1;
    loading = false;
    expanded = false;
    candidate = null;
    candidateDraft = null;
    failure = null;
    publish();
  };

  /** A user edit invalidates the candidate but leaves the feature reading alone. */
  const invalidate = (): void => {
    if (candidate === null && failure === null && !loading && !expanded) return;
    reset();
  };

  const startRequest = (): void => {
    if (disposed || !context.enabled) return;
    const draft = context.draft;
    if (draft.trim() === '') return;
    if (loading) return;
    const snapshot: RequestSnapshot = {
      sessionId: context.sessionId,
      draftScope: context.draftScope,
      draft,
      token: requestSeq + 1,
    };
    requestSeq = snapshot.token;
    loading = true;
    expanded = true;
    // A new request supersedes the previous error; the old candidate is still shown underneath
    // only if it answered this exact draft, which a new request never does (it is either a first
    // request or a retry after a failure/without a candidate).
    failure = null;
    publish();

    void (async () => {
      let response: DraftRewriteResponse;
      try {
        // `sessionId` is correlation ONLY (the server logs it in the opt-in debug ledger and
        // never forwards it upstream); a composer with no open conversation omits it entirely.
        response = await api.rewrite({
          text: snapshot.draft,
          ...(snapshot.sessionId === null ? {} : { sessionId: snapshot.sessionId }),
        });
      } catch (reason) {
        if (disposed || snapshot.token !== requestSeq) return;
        failure = {
          at: new Date(now()).toISOString(),
          code: 'unknown',
          category: 'network',
          httpStatus: null,
          requestId: null,
          model: null,
          message: reason instanceof Error ? reason.message : String(reason),
        };
        loading = false;
        publish();
        return;
      }
      // The answer belongs to the bytes/scope it was asked for, not to whatever is on screen now.
      if (disposed || snapshot.token !== requestSeq || !isSameContextSnapshot(context, snapshot)) {
        return;
      }
      loading = false;
      if (!response.ok) {
        failure = response.failure;
        publish();
        return;
      }
      candidate = response.result.rewrittenText;
      candidateDraft = snapshot.draft;
      failure = null;
      publish();
    })();
  };

  const setContext = (next: DraftRewriteContext): void => {
    if (disposed) return;
    const previous = context;
    const scopeChanged = previous.sessionId !== next.sessionId || previous.draftScope !== next.draftScope;
    context = {
      sessionId: next.sessionId,
      draftScope: next.draftScope,
      draft: next.draft,
      enabled: next.enabled,
    };
    if (scopeChanged) {
      // Another conversation/draft scope: nothing about the previous one may leak across.
      reset();
      return;
    }
    if (next.draft !== previous.draft) {
      // A user edit (or any external write) makes the candidate and any in-flight answer stale;
      // `reset` also republishes, because `available` is derived from the draft's non-blankness.
      reset();
      return;
    }
    if (!next.enabled || next.draft.trim() === '') {
      // The chip disappears; an open panel and its candidate/error go with it.
      reset();
      return;
    }
    publish();
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    setContext,

    openOrRequest(): void {
      if (disposed || !context.enabled || context.draft.trim() === '') return;
      if (expanded) return;
      expanded = true;
      if (candidate !== null) {
        // The cached candidate answers this draft; re-opening is free.
        publish();
        return;
      }
      if (failure !== null) {
        // A failed attempt is shown again; asking again is the explicit retry.
        publish();
        return;
      }
      // `startRequest` sets `expanded = true` itself; publish the expansion first so the
      // loading panel is drawn even if the transport resolves synchronously.
      publish();
      startRequest();
    },

    collapse(): void {
      if (disposed || !expanded) return;
      expanded = false;
      publish();
    },

    retry(): void {
      if (disposed || loading) return;
      startRequest();
    },

    apply(): void {
      if (disposed) return;
      if (candidate === null || candidateDraft === null) return;
      // Only the exact draft the candidate answered may be replaced; anything else means the
      // page moved on and this candidate must stay out of the way.
      if (context.draft !== candidateDraft) {
        reset();
        return;
      }
      const text = candidate;
      candidate = null;
      candidateDraft = null;
      failure = null;
      expanded = false;
      requestSeq += 1;
      publish();
      writeDraft(text);
    },

    invalidate,

    reset,

    dispose(): void {
      disposed = true;
      requestSeq += 1;
      loading = false;
    },
  };
}
