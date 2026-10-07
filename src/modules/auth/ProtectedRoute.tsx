import type { ReactNode } from 'react';

import { OAUTH_CONSENT_SPA_PATH } from '@shared/oauthConsent';
import { IS_PLATFORM } from '@/shared/utils';
import { useAuth } from '@/modules/auth/context/AuthContext';
import { Onboarding } from '@/modules/onboarding';
import AuthLoadingScreen from '@/modules/auth/AuthLoadingScreen';
import LoginForm from '@/modules/auth/LoginForm';
import SetupForm from '@/modules/auth/SetupForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

/**
 * Whether the browser is on the OAuth consent route.
 *
 * `ProtectedRoute` is rendered OUTSIDE `<Router>` in `src/App.tsx`, so it has no
 * router context and cannot call `useLocation`; the pathname is read from
 * `window.location` instead. The comparison is a suffix test so it stays correct
 * under a reverse-proxy basename (the same prefix `detectRouterBasename` hands
 * React Router), and every consent URL — with or without its query — ends with
 * the route constant.
 */
function isOAuthConsentRoute(): boolean {
  return typeof window !== 'undefined' && window.location.pathname.endsWith(OAUTH_CONSENT_SPA_PATH);
}

/** Used by App to gate the routed application behind setup, login and onboarding. */
export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();
  // The Git-identity wizard is unrelated to authorizing an MCP client, and it
  // discards the OAuth context the user arrived with: the consent route is
  // exempt from the onboarding gate (option A — the smaller, state-free fix).
  // Setup and login still gate it, because a consent decision needs a real user.
  const consentRoute = isOAuthConsentRoute();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding && !consentRoute) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return <>{children}</>;
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (!hasCompletedOnboarding && !consentRoute) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return <>{children}</>;
}
