import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import type { ReactNode } from 'react';

import { OAUTH_CONSENT_SPA_PATH } from '@shared/oauthConsent';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { AuthProvider, ProtectedRoute, useAuth } from '@/modules/auth';
import { TaskMasterProvider,TasksSettingsProvider } from '@/modules/task-master';
import { WebSocketProvider } from '@/shared/context/WebSocketContext';
import { PluginsProvider } from '@/modules/plugins';
import { ProjectWorkspaceRoute } from '@/modules/project-workspace';
import { OAuthConsentRoute } from '@/modules/oauth-consent';
import { CockpitPage, CockpitRemote } from '@/modules/cockpit';
import { i18n } from '@/modules/i18n';

const DEPLOYMENT_ASSET_DIRECTORIES = new Set(['assets', 'static', 'icons', 'images']);

/**
 * Detect the router basename from explicit runtime config or deployment hints.
 *
 * CloudCLI can be served from a path prefix by a reverse proxy, for example:
 *   /ai/manifest.json
 *   /ai/assets/index-abc123.js
 *   /ai/icons/icon-192x192.png
 *
 * React Router needs that prefix as its basename, but the packaged app should
 * also keep working when served directly from the domain root. The direct-root
 * case is easy to misread because asset URLs such as /icons/icon-192x192.png
 * contain a directory even though there is no application basename.
 */
function detectRouterBasename() {
  // Deployments can pin the router basename by setting window.__ROUTER_BASENAME__ in
  // index.html, so read it through a local widening instead of augmenting global Window.
  const explicitBasename =
    typeof window !== 'undefined'
      ? (window as Window & { __ROUTER_BASENAME__?: string }).__ROUTER_BASENAME__ || ''
      : '';
  if (explicitBasename) {
    // Keep the deployment escape hatch authoritative. A trailing slash is
    // harmless for humans but React Router expects a normalized basename.
    return explicitBasename.replace(/\/+$/, '');
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return '';
  }

  const candidatePaths = [
    { kind: 'manifest' as const, value: document.querySelector('link[rel="manifest"]')?.getAttribute('href') },
    { kind: 'script' as const, value: document.querySelector('script[type="module"][src]')?.getAttribute('src') },
    ...Array.from(
      document.querySelectorAll(
        'link[rel~="icon"][href], link[rel="apple-touch-icon"][href], link[rel="apple-touch-icon-precomposed"][href], link[rel="mask-icon"][href]'
      )
    ).map((node) => ({
      kind: 'icon' as const,
      value: node.getAttribute('href'),
    })),
  ].filter((candidate): candidate is { kind: 'manifest' | 'script' | 'icon'; value: string } => Boolean(candidate.value));

  let detectedBasename = '';
  for (const candidate of candidatePaths) {
    try {
      const candidateUrl = new URL(candidate.value, document.baseURI || window.location.href);
      if (candidateUrl.origin !== window.location.origin) {
        continue;
      }

      const pathname = candidateUrl.pathname;
      const normalizedPathname = pathname.replace(/\/+$/, '');

      let normalized = '';
      if (candidate.kind === 'script') {
        const match = normalizedPathname.match(/^(.*)\/assets\//);
        normalized = match?.[1] ? match[1].replace(/\/+$/, '') : '';
      } else {
        const manifestMatch = normalizedPathname.match(/^(.*)\/(?:manifest\.json|site\.webmanifest)$/);
        const iconMatch = normalizedPathname.match(
          /^(.*)\/(?:favicon(?:\.[^/]+)?|apple-touch-icon(?:-[^/]+)?(?:\.[^/]+)?|mask-icon(?:\.[^/]+)?|[^/]*icon[^/]*)$/
        );
        const match = candidate.kind === 'manifest' ? manifestMatch : iconMatch;
        if (match?.[1]) {
          const segments = match[1].split('/').filter(Boolean);

          // Strip directories that describe where static files live, not where
          // the app is mounted. This must also run for a single segment:
          //   /icons/icon-192x192.png       -> ''
          //   /ai/icons/icon-192x192.png    -> '/ai'
          // The previous implementation only stripped while more than one
          // segment remained, which incorrectly turned root deployments into a
          // Router basename of /icons and caused a blank page after login.
          while (segments.length > 0 && DEPLOYMENT_ASSET_DIRECTORIES.has(segments[segments.length - 1])) {
            segments.pop();
          }

          normalized = segments.length > 0 ? `/${segments.join('/')}` : '';
        }
      }

      if (normalized.length > detectedBasename.length) {
        detectedBasename = normalized;
      }
    } catch {
      // Ignore invalid candidate URLs and continue checking other hints.
    }
  }

  return detectedBasename;
}

/**
 * Bridges the auth feature into the shared websocket provider.
 *
 * This is the application assembly point: the one place allowed to know both
 * layers. `shared` must not import `modules/auth`, so the session arrives at
 * `WebSocketProvider` as an injected port instead of being read there. Used only
 * by `App`.
 */
function AuthenticatedWebSocket({ children }: { children: ReactNode }) {
  const { isLoading, token, user } = useAuth();
  return <WebSocketProvider auth={{ isLoading, token, user }}>{children}</WebSocketProvider>;
}

/** Rendered by main.tsx; mounts the shared providers, the auth gate and the project workspace routes. */
export default function App() {
  const routerBasename = detectRouterBasename();

  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <UiPreferencesProvider>
        <AuthProvider>
          <AuthenticatedWebSocket>
            <PluginsProvider>
              <TasksSettingsProvider>
                <TaskMasterProvider>
                <ProtectedRoute>
                  <Router basename={routerBasename}>
                    <Routes>
                      <Route path="/" element={<ProjectWorkspaceRoute />} />
                      <Route path="/session/:sessionId" element={<ProjectWorkspaceRoute />} />
                      {/* The cockpit: a top-level read-only stage over the quay fleet, a sibling
                          of the project workspace rather than a tab inside one. It is behind the
                          same ProtectedRoute, so it reads the fleet only for a signed-in user. */}
                      <Route path="/cockpit" element={<CockpitPage />} />
                      {/* The phone remote: the input half of the same hub, opened by scanning
                          the code the stage draws. Same ProtectedRoute, so it binds to the
                          signed-in user's hub with no extra token or pairing step. */}
                      <Route path="/cockpit/remote" element={<CockpitRemote />} />
                      {/* The OAuth consent screen: a full-page surface of its own, NOT
                          inside the project workspace shell, so an authorization request
                          never mounts the sidebar, tabs or chat pane behind it. It is
                          behind the same ProtectedRoute as the workspace — an anonymous
                          visitor lands on the login form with the query string untouched,
                          which is what sends them back here after they sign in. */}
                      <Route path={OAUTH_CONSENT_SPA_PATH} element={<OAuthConsentRoute />} />
                    </Routes>
                  </Router>
                </ProtectedRoute>
                </TaskMasterProvider>
              </TasksSettingsProvider>
            </PluginsProvider>
          </AuthenticatedWebSocket>
        </AuthProvider>
        </UiPreferencesProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
