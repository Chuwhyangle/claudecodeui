/**
 * The state machine behind the OAuth consent page.
 *
 * The page is a thin renderer over this hook: it loads the request's validated
 * context from the server (`GET /api/oauth/authorize/context`), tracks which
 * scopes the user ticked, and submits the decision
 * (`POST /api/oauth/authorize/decision`) whose answer names the callback URL to
 * navigate to. The server, not this hook, decides what a decision grants: the
 * selection submitted here is intersected with the scope vocabulary there.
 *
 * The session is a bearer JWT carried by `authenticatedFetch`. An Allow reaches
 * past the read scope by one more check: any state-changing scope needs the
 * signed-in user's password, re-entered on the page as the confirmation step
 * AC-261 restores, so a stolen session token cannot silently authorize a
 * third-party client to act. A grant of nothing but the read scope is within
 * what the session JWT already reads, so the session alone authorizes it and no
 * password is asked for. The server rate-limits that confirmation per source, so
 * a refused decision (401 `invalid_credentials`, 429 `too_many_requests`) is a
 * recoverable in-place state — `submitError` — rather than the page-level error
 * face. A bare 401 with no such code is still the lapsed session, which the page
 * resolves through the ordinary login gate rather than by rendering its own form.
 *
 * Consumers: `OAuthConsentRoute` (the only caller) and its vitest.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiRequestError, api } from '@/shared/api';
import type {
  OAuthConsentContext,
  OAuthConsentDecisionRequest,
  OAuthConsentDecisionResponse,
} from '@/shared/types';

/**
 * Why the page cannot render a decision, or why the one it just submitted was
 * refused: an incomplete link, a request the server refused, a lapsed session,
 * an unreachable server, a wrong confirmation password, or a source the server
 * has rate limited. The page maps each to its own message.
 */
export type OAuthConsentErrorKind =
  | 'missing-request'
  | 'invalid-request'
  | 'unauthorized'
  | 'network'
  | 'invalid-credentials'
  | 'rate-limited';

/** The four faces the consent page can wear; `ready` is the only one that shows the Allow/Deny decision. */
export type OAuthConsentPhase = 'loading' | 'ready' | 'submitting' | 'error' | 'unauthorized';

/** The authorization request parameters the page must echo back on submission. */
export type OAuthConsentRequest = {
  clientId: string | null;
  redirectUri: string | null;
  state: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
};

/** Splits the browser's own query string into the parameters a decision must carry back. */
export function readOAuthConsentRequest(search: string): OAuthConsentRequest {
  const params = new URLSearchParams(search);
  return {
    clientId: params.get('client_id'),
    redirectUri: params.get('redirect_uri'),
    state: params.get('state'),
    codeChallenge: params.get('code_challenge'),
    codeChallengeMethod: params.get('code_challenge_method'),
  };
}

/** How a failure is presented: `kind` selects the message, `message` carries the server's own text when it sent one. */
export type OAuthConsentError = {
  kind: OAuthConsentErrorKind;
  message: string | null;
};

/** Everything `OAuthConsentRoute` renders from. */
export type OAuthConsentController = {
  phase: OAuthConsentPhase;
  request: OAuthConsentRequest;
  context: OAuthConsentContext | null;
  /** The scopes currently ticked; the required read scope is always in here. */
  selectedScopes: string[];
  /** True when at least one ticked scope lets the client change something — the page's risk warning. */
  hasWriteSelection: boolean;
  /**
   * True when this decision will need the password confirmation — i.e. when the
   * grant reaches past the read scope. The page renders the password field only
   * then, and holds Allow until one is typed; a read-only decision is authorized
   * by the session alone. The server derives the same rule from the grant set, so
   * this only decides what the page shows, never what the server accepts.
   */
  requiresPassword: boolean;
  /** The password the user re-entered to confirm an Allow; empty until they type one. */
  password: string;
  setPassword: (value: string) => void;
  /**
   * Why a decision the server refused came back: a wrong confirmation password
   * (401) or a rate-limited source (429). The page stays usable — unlike
   * {@link OAuthConsentController.error}, this does not hide the decision — so
   * the user can correct the password and submit again.
   */
  submitError: OAuthConsentError | null;
  error: OAuthConsentError | null;
  toggleScope: (scope: string, checked: boolean) => void;
  decide: (action: 'allow' | 'deny') => void;
  retry: () => void;
};

/** Navigates the browser to the callback the decision named; injectable so a test can observe it instead of leaving the page. */
export type OAuthConsentNavigate = (url: string) => void;

const defaultNavigate: OAuthConsentNavigate = (url) => {
  window.location.assign(url);
};

/**
 * Drives one consent request. `search` is the browser's query string (leading
 * `?` included) and is passed to the context endpoint unchanged, so the server
 * re-validates exactly the request `/oauth/authorize` accepted.
 */
export function useOAuthConsent(
  search: string,
  navigate: OAuthConsentNavigate = defaultNavigate,
): OAuthConsentController {
  const request = useMemo(() => readOAuthConsentRequest(search), [search]);
  // Bumped by `retry` to re-run the load effect after a transient failure.
  const [reloadToken, setReloadToken] = useState(0);
  // The request's validated context, or null until it loads (and after a failure).
  const [context, setContext] = useState<OAuthConsentContext | null>(null);
  // The ticks the user has made on top of the context's pinned read scope.
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  // The page's face; `submitting` disables the buttons while a decision is in flight.
  const [phase, setPhase] = useState<OAuthConsentPhase>('loading');
  // Why a load or a decision failed; null whenever the page is usable.
  const [error, setError] = useState<OAuthConsentError | null>(null);
  // The password re-entered to confirm an Allow (AC-261). Held here, never in
  // the URL or storage: it lives only as long as the page is open.
  const [password, setPassword] = useState('');
  // Why the last decision was refused, when the page is still usable; cleared as
  // soon as another decision is submitted.
  const [submitError, setSubmitError] = useState<OAuthConsentError | null>(null);

  useEffect(() => {
    // A link missing client_id or redirect_uri cannot be validated at all: fail
    // before spending a request, and never render a decision for it.
    if (request.clientId === null || request.redirectUri === null) {
      setPhase('error');
      setError({ kind: 'missing-request', message: null });
      return;
    }

    let cancelled = false;
    setPhase('loading');
    setError(null);
    setSubmitError(null);

    api.oauthConsent
      .context(search)
      .then(async (response) => {
        if (!response.ok) {
          throw new ApiRequestError(
            response.status === 401 ? 'Unauthorized' : 'Request failed',
            { status: response.status },
          );
        }
        return (await response.json()) as OAuthConsentContext;
      })
      .then((loaded) => {
        if (cancelled) {
          return;
        }
        setContext(loaded);
        // The pinned read scope starts ticked; every write scope starts clear,
        // so a client can never be granted more than the user explicitly chose.
        setSelectedScopes(loaded.scopes.filter((scope) => scope.required).map((scope) => scope.scope));
        setPhase('ready');
      })
      .catch((failure: unknown) => {
        if (cancelled) {
          return;
        }
        setContext(null);
        if (failure instanceof ApiRequestError && failure.status === 401) {
          setPhase('unauthorized');
          setError({ kind: 'unauthorized', message: null });
          return;
        }
        if (failure instanceof ApiRequestError) {
          setPhase('error');
          setError({ kind: 'invalid-request', message: failure.message });
          return;
        }
        setPhase('error');
        setError({ kind: 'network', message: null });
      });

    return () => {
      cancelled = true;
    };
  }, [search, request.clientId, request.redirectUri, reloadToken]);

  const toggleScope = useCallback((scope: string, checked: boolean) => {
    setSelectedScopes((current) => {
      if (checked) {
        return current.includes(scope) ? current : [...current, scope];
      }
      return current.filter((item) => item !== scope);
    });
  }, []);

  const decide = useCallback(
    (action: 'allow' | 'deny') => {
      if (request.clientId === null || request.redirectUri === null) {
        setPhase('error');
        setError({ kind: 'missing-request', message: null });
        return;
      }
      const decision: OAuthConsentDecisionRequest = {
        client_id: request.clientId,
        redirect_uri: request.redirectUri,
        state: request.state,
        code_challenge: request.codeChallenge,
        code_challenge_method: request.codeChallengeMethod,
        scopes: action === 'allow' ? selectedScopes : [],
        action,
        // Only an Allow confirms a password; a denial grants nothing, so it
        // carries no secret to the server.
        password: action === 'allow' ? password : '',
      };
      setPhase('submitting');
      setError(null);
      setSubmitError(null);
      api.oauthConsent
        .decide(decision)
        .then(async (response) => {
          if (!response.ok) {
            // The consent surface answers refusals as RFC 6749 error objects
            // (`{error, error_description}`), and the code is what separates a
            // wrong password from a lapsed session — both are 401.
            const refusal = (await response.json().catch(() => null)) as
              | { error?: unknown; error_description?: unknown }
              | null;
            const code = typeof refusal?.error === 'string' ? refusal.error : undefined;
            const message =
              typeof refusal?.error_description === 'string'
                ? refusal.error_description
                : response.status === 401
                  ? 'Unauthorized'
                  : 'Request failed';
            throw new ApiRequestError(message, { code, status: response.status });
          }
          return (await response.json()) as OAuthConsentDecisionResponse;
        })
        .then((answer) => {
          navigate(answer.redirectTo);
        })
        .catch((failure: unknown) => {
          // A refused confirmation is recoverable in place: the page keeps the
          // decision on screen so the user can correct the password or wait out
          // the rate limit. Only a lapsed session or a transport failure takes
          // the page away.
          if (failure instanceof ApiRequestError && failure.code === 'invalid_credentials') {
            setPhase('ready');
            setSubmitError({ kind: 'invalid-credentials', message: failure.message });
            return;
          }
          if (failure instanceof ApiRequestError && failure.code === 'too_many_requests') {
            setPhase('ready');
            setSubmitError({ kind: 'rate-limited', message: failure.message });
            return;
          }
          if (failure instanceof ApiRequestError && failure.status === 401) {
            setPhase('unauthorized');
            setError({ kind: 'unauthorized', message: null });
            return;
          }
          setPhase('error');
          setError({ kind: 'network', message: null });
        });
    },
    [navigate, password, request, selectedScopes],
  );

  const retry = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  const hasWriteSelection = useMemo(() => {
    if (!context) {
      return false;
    }
    return context.scopes.some(
      (scope) => scope.writable && selectedScopes.includes(scope.scope),
    );
  }, [context, selectedScopes]);

  return {
    phase,
    request,
    context,
    selectedScopes,
    hasWriteSelection,
    requiresPassword: hasWriteSelection,
    password,
    setPassword,
    submitError,
    error,
    toggleScope,
    decide,
    retry,
  };
}
