import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';

import { IS_PLATFORM } from '@/shared/utils';
import { api } from '@/shared/api';
import { AUTH_SESSION_EXPIRED_EVENT, AUTH_TOKEN_REFRESHED_EVENT, clearAuthLapse, getAuthTokenRefreshDelay, isValidRefreshedToken, recordAuthLapse, storeAuthToken } from '@/shared/authToken';
import type { AuthLapseReason } from '@/shared/authToken';
import { hydrateChatDrafts, resetChatDrafts } from '@/shared/chatDrafts';
import { hydrateUserPreferences, resetUserPreferences } from '@/shared/userSettings';
/** The signed-in account held by AuthContext - a required `username` plus an optional id and any additional fields the auth API returns - and should be read through `useAuth()` rather than re-derived from raw auth responses. */
type AuthUser = {
  id?: number | string;
  username: string;
  [key: string]: unknown;
};

const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

// How the startup self-check backs off after a failure that is NOT a server-side
// rejection. A gateway 5xx while the server restarts, a reverse proxy's HTML body
// and a dropped connection all mean "the server could not answer", so the check
// waits and repeats the SAME read instead of signing the user out. The interval
// doubles and the cap is what bounds it; the attempts themselves keep going,
// because the only alternative is telling a signed-in user to type their password
// again over a fault that ends on its own.
const AUTH_STATUS_RETRY_BASE_MS = 500;
const AUTH_STATUS_RETRY_MAX_MS = 30_000;

const waitForRetry = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });

const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'errors.authStatusCheckFailed',
  loginFailed: 'errors.loginFailed',
  registrationFailed: 'errors.registrationFailed',
  networkError: 'errors.networkError',
  sessionExpired: 'errors.sessionExpired',
} as const;

type AuthActionResult = { success: true } | { success: false; error: string };

type AuthSessionPayload = {
  token?: string;
  user?: AuthUser;
  error?: string;
  message?: string;
};

type AuthStatusPayload = {
  needsSetup?: boolean;
};

type AuthUserPayload = {
  user?: AuthUser;
};

type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

type ApiErrorPayload = {
  error?: string;
  message?: string;
};

type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  needsSetup: boolean;
  hasCompletedOnboarding: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  logout: () => void;
  refreshOnboardingStatus: () => Promise<void>;
};

type AuthProviderProps = {
  children: ReactNode;
};

async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function resolveApiErrorMessage(payload: ApiErrorPayload | null, fallback: string): string {
  if (!payload) {
    return fallback;
  }

  return payload.error ?? payload.message ?? fallback;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const readStoredToken = (): string | null => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

const persistToken = (token: string) => {
  storeAuthToken(token);
};

const clearStoredToken = () => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

/** Used by App to expose the session, and its login/logout actions, to every module through useAuth. */
export function AuthProvider({ children }: AuthProviderProps) {
  const { t } = useTranslation('auth');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Whether a session token has existed at any point in this page's lifetime,
  // seeded from what is already stored. The "session expired" banner is only
  // truthful when a session actually lapsed; a visitor who was NEVER signed in
  // (no stored token) must not be told their session expired just because an
  // unauthenticated request answered 401. Set on login/refresh, cleared with the
  // session.
  const hadSessionRef = useRef(readStoredToken() !== null);
  // Whether the "session expired" banner is currently latched. A lapse is a
  // latch rather than a transient status error: it has to survive the auth
  // status re-runs the lapse itself triggers (that effect depends on
  // `checkAuthStatus`, which depends on `token`, so clearing the session
  // re-runs it) and the second run StrictMode's double-invoked effect issues
  // with the stale token still in its closure. Only an explicit auth action
  // (login/register) clears it.
  const sessionExpiredNotifiedRef = useRef(false);
  // Identifies the newest self-check run. The mount effect re-runs whenever
  // `checkAuthStatus` changes (it depends on `token`), so a run that is still
  // backing off has to be able to tell that a newer run — or unmount — has taken
  // over, and abandon its loop rather than publish state the newer run owns.
  const authStatusRunRef = useRef(0);
  // Mirrors `user` for the retry loop: whether a signed-in user is already on
  // screen decides whether a transient failure may drop the loading state (the
  // app keeps running) or must hold the auth gate up instead of offering a login
  // form the stored token does not actually justify. A ref because the decision
  // is made after an await, where a closure over `user` would be stale.
  const userRef = useRef<AuthUser | null>(null);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Abandon any in-flight retry loop on unmount, so it stops scheduling attempts
  // against a provider that no longer exists.
  useEffect(
    () => () => {
      authStatusRunRef.current += 1;
    },
    [],
  );

  const setSession = useCallback((nextUser: AuthUser, nextToken: string) => {
    hadSessionRef.current = true;
    setUser(nextUser);
    setToken(nextToken);
    persistToken(nextToken);
    // A new session opens a new lapse window: the breadcrumb of whatever ended
    // the previous one has now been reported by the login that is establishing
    // this session, so it must not be re-reported on the next one.
    clearAuthLapse();
  }, []);

  const clearSession = useCallback(() => {
    hadSessionRef.current = false;
    setUser(null);
    setToken(null);
    clearStoredToken();
    // Otherwise the next person to sign in on this device would start out
    // looking at the previous user's theme, language, permissions and drafts.
    resetUserPreferences();
    resetChatDrafts();
  }, []);

  /**
   * A session the server no longer accepts has lapsed: drop it and, only when a
   * session really existed, say so.
   *
   * The lapse reaches here two ways: a 401 on the authenticated read, or the
   * `AUTH_SESSION_EXPIRED_EVENT` a refused request raises. Both are the server
   * refusing a credential — the client's own clock no longer ends a session — so
   * `reason` names the server's answer when the 401 carried one. It is recorded
   * for the next login's report; a reason-less call (the event, whose raiser has
   * already recorded its own) records nothing.
   */
  const notifySessionLapsed = useCallback((reason?: AuthLapseReason) => {
    if (reason) {
      recordAuthLapse(reason);
    }
    // Read the flag BEFORE clearing the session: a lapsed real session earns
    // the banner, a never-signed-in visitor earns nothing.
    const hadSession = hadSessionRef.current;
    clearSession();
    if (hadSession) {
      sessionExpiredNotifiedRef.current = true;
      setError(t(AUTH_ERROR_MESSAGES.sessionExpired));
    }
  }, [clearSession, t]);

  // Preferences live in auth.db, so they can only be fetched once there is a
  // user to fetch them for. Until this resolves, every reader falls back to the
  // localStorage mirror of the last known server state.
  const userKey = user ? String(user.id ?? user.username) : null;
  useEffect(() => {
    if (!userKey) {
      return;
    }
    void hydrateUserPreferences();
    void hydrateChatDrafts();
  }, [userKey]);

  const checkOnboardingStatus = useCallback(async () => {
    try {
      const response = await api.user.onboardingStatus();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<OnboardingStatusPayload>(response);
      setHasCompletedOnboarding(Boolean(payload?.hasCompletedOnboarding));
    } catch (caughtError) {
      console.error('Error checking onboarding status:', caughtError);
      // Fail open to avoid blocking access on transient onboarding status errors.
      setHasCompletedOnboarding(true);
    }
  }, []);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  const refreshSession = useCallback(async () => {
    if (IS_PLATFORM || !token || !user) {
      return;
    }

    try {
      const response = await api.auth.refresh();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<AuthSessionPayload>(response);
      if (isValidRefreshedToken(payload?.token)) {
        setToken(payload.token);
        persistToken(payload.token);
      }
    } catch (caughtError) {
      // A transient network failure must not sign the user out. Focus/visibility
      // and the next scheduled refresh will retry while the token remains valid.
      console.warn('[Auth] Session refresh failed:', caughtError);
    }
  }, [token, user]);

  useEffect(() => {
    const handleTokenRefreshed = (event: Event) => {
      const nextToken = (event as CustomEvent<unknown>).detail;
      if (isValidRefreshedToken(nextToken)) {
        hadSessionRef.current = true;
        setToken(nextToken);
      }
    };
    const handleSessionExpired = () => {
      notifySessionLapsed();
    };

    window.addEventListener(AUTH_TOKEN_REFRESHED_EVENT, handleTokenRefreshed);
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => {
      window.removeEventListener(AUTH_TOKEN_REFRESHED_EVENT, handleTokenRefreshed);
      window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    };
  }, [notifySessionLapsed]);

  const checkAuthStatus = useCallback(async () => {
    const runId = authStatusRunRef.current + 1;
    authStatusRunRef.current = runId;
    // A superseded run — a newer one started, or the provider unmounted — must
    // neither publish state nor keep retrying; the newer run owns both now.
    const isCurrentRun = () => authStatusRunRef.current === runId;
    const finish = () => {
      if (isCurrentRun()) {
        setIsLoading(false);
      }
    };

    setIsLoading(true);

    // Grows after each non-rejection failure; resets with every new run so a
    // recovered server is not punished for an old outage's backoff.
    let retryDelay = AUTH_STATUS_RETRY_BASE_MS;

    for (;;) {
      try {
        const statusResponse = await api.auth.status();
        const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);

        if (statusPayload?.needsSetup) {
          setNeedsSetup(true);
          finish();
          return;
        }

        setNeedsSetup(false);

        if (!token) {
          // Nothing to check, and NOTHING to clear: a session that just lapsed
          // reaches here on the re-run the clearing itself triggers (this effect
          // depends on `checkAuthStatus`, which depends on `token`), so clearing
          // the banner here would wipe the very message the lapse just earned.
          finish();
          return;
        }

        if (!sessionExpiredNotifiedRef.current) {
          setError(null);
        }

        const userResponse = await api.auth.user();
        if (userResponse.status === 401) {
          // The one answer that does mean the session is gone. A stored token the
          // server rejects is the whole story — the client does not discard one on
          // its own `exp` any more — so this is where the session ends and the
          // server's own word (`X-Auth-Error`) is what names the reason.
          notifySessionLapsed(
            userResponse.headers.get('X-Auth-Error') === 'session-expired'
              ? 'server-expired'
              : 'server-401',
          );
          finish();
          return;
        }

        const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
        if (userResponse.ok && userPayload?.user) {
          setUser(userPayload.user);
          await checkOnboardingStatus();
          finish();
          return;
        }

        // Everything else — a gateway 502/503/504, a 2xx that is an interception
        // page instead of `{ user }` — says the server did not answer, not that it
        // refused. Record the self-check as temporarily unavailable and leave the
        // token and the session exactly as they are.
        setError(t(AUTH_ERROR_MESSAGES.authStatusCheckFailed));
      } catch (caughtError) {
        // The same kind of failure with no status at all: the connection dropped,
        // or `/api/auth/status` itself could not be reached.
        console.warn('[Auth] Auth status check could not reach the server:', caughtError);
        setError(t(AUTH_ERROR_MESSAGES.authStatusCheckFailed));
      }

      if (!isCurrentRun()) {
        return;
      }

      // A user already on screen means the app must keep running behind this
      // retry; with no user yet, the auth gate holds instead of showing a login
      // form the stored token does not actually justify.
      if (userRef.current) {
        setIsLoading(false);
      }

      await waitForRetry(retryDelay);
      if (!isCurrentRun()) {
        return;
      }
      retryDelay = Math.min(retryDelay * 2, AUTH_STATUS_RETRY_MAX_MS);
    }
  }, [checkOnboardingStatus, notifySessionLapsed, t, token]);

  useEffect(() => {
    if (IS_PLATFORM) {
      setUser({ username: 'platform-user' });
      setNeedsSetup(false);
      void checkOnboardingStatus().finally(() => {
        setIsLoading(false);
      });
      return;
    }

    void checkAuthStatus();
  }, [checkAuthStatus, checkOnboardingStatus]);

  useEffect(() => {
    if (IS_PLATFORM || !token || !user) {
      return undefined;
    }

    const refreshIfNeeded = () => {
      const refreshDelay = getAuthTokenRefreshDelay(token);
      if (refreshDelay !== null && refreshDelay <= 0) {
        void refreshSession();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshIfNeeded();
      }
    };

    const refreshDelay = getAuthTokenRefreshDelay(token);
    const refreshTimer = refreshDelay === null
      ? null
      : window.setTimeout(() => void refreshSession(), refreshDelay);

    window.addEventListener('focus', refreshIfNeeded);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      window.removeEventListener('focus', refreshIfNeeded);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshSession, token, user]);

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      try {
        // An explicit auth attempt is the one thing that retires the latch.
        sessionExpiredNotifiedRef.current = false;
        setError(null);
        const response = await api.auth.login(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, t(AUTH_ERROR_MESSAGES.loginFailed));
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        setError(t(AUTH_ERROR_MESSAGES.networkError));
        return { success: false, error: t(AUTH_ERROR_MESSAGES.networkError) };
      }
    },
    [checkOnboardingStatus, setSession, t],
  );

  const register = useCallback<AuthContextValue['register']>(
    async (username, password) => {
      try {
        sessionExpiredNotifiedRef.current = false;
        setError(null);
        const response = await api.auth.register(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, t(AUTH_ERROR_MESSAGES.registrationFailed));
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        setError(t(AUTH_ERROR_MESSAGES.networkError));
        return { success: false, error: t(AUTH_ERROR_MESSAGES.networkError) };
      }
    },
    [checkOnboardingStatus, setSession, t],
  );

  const logout = useCallback(() => {
    // JWT logout is client-side: the server endpoint does not maintain a
    // revocation list, so clearing the session is the complete operation.
    clearSession();
  }, [clearSession]);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isLoading,
      needsSetup,
      hasCompletedOnboarding,
      error,
      login,
      register,
      logout,
      refreshOnboardingStatus,
    }),
    [
      error,
      hasCompletedOnboarding,
      isLoading,
      login,
      logout,
      needsSetup,
      refreshOnboardingStatus,
      register,
      token,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
