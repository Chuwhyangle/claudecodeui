import { BrowserRouter as Router, Route, Routes, useLocation } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';

import { OAUTH_CONSENT_SPA_PATH } from '@shared/oauthConsent';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { AuthProvider, ProtectedRoute, useAuth } from '@/modules/auth';
import { TaskMasterProvider } from '@/modules/task-master/context/TaskMasterContext';
import { TasksSettingsProvider } from '@/modules/task-master/context/TasksSettingsContext';
import { WebSocketProvider } from '@/shared/context/WebSocketContext';
import { PluginsProvider } from '@/modules/plugins/context/PluginsContext';
import { ProjectWorkspaceRoute } from '@/modules/project-workspace';
import { useServerFeatures } from '@/shared/hooks/useServerFeatures';
import { installViewEvents, reportView } from '@/shared/api/viewEvents';
import { i18n } from '@/modules/i18n';

/**
 * The non-resident surfaces are route-level code splits: only the workspace and
 * the sign-in/shell providers ship in the first-screen chunk. Each surface below
 * is fetched when its address is actually mounted, and the local `Suspense`
 * keeps the fallback confined to that surface — the whole App is never
 * suspended.
 *
 * The workspace itself is deliberately NOT lazy: it is the first screen and the
 * session state is mounted directly under it. Its heavy side tabs (architecture,
 * git, files, shell, tasks, quay, plugins, browser, code editor) are the split
 * points, and they live in `WorkspaceMain`.
 */
const LazyArchitectureStandaloneRoute = lazy(() => import('@/modules/project-workspace/ArchitectureStandaloneRoute'));
const LazyCockpitRoute = lazy(() =>
  import('@/modules/cockpit').then((module) => ({ default: module.CockpitRoute })),
);
const LazyCockpitOverlayHost = lazy(() =>
  import('@/modules/cockpit').then((module) => ({ default: module.CockpitOverlayHost })),
);
const LazyOAuthConsentRoute = lazy(() =>
  import('@/modules/oauth-consent').then((module) => ({ default: module.OAuthConsentRoute })),
);
const LazyLogDrawerHost = lazy(() =>
  import('@/modules/diagnostics').then((module) => ({ default: module.LogDrawerHost })),
);

const DEPLOYMENT_ASSET_DIRECTORIES = new Set(['assets', 'static', 'icons', 'images']);

/**
 * Detect the router basename from explicit runtime config or deployment hints.
 *
 * Cloudpit can be served from a path prefix by a reverse proxy, for example:
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

/**
 * The wait state for a lazy route.
 *
 * Deliberately one fixed-size, centered spinner: the fallback never changes the
 * shell's layout (no header, sidebar or tab strip is drawn here), so the page
 * it replaces does not jump when the chunk arrives. It is local to the surface
 * being loaded — there is no `Suspense` above `Routes`.
 */
function RouteLoadingFallback() {
  return (
    <div className="flex h-dvh w-full items-center justify-center" role="status" aria-label="Loading">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-foreground" />
    </div>
  );
}

/** A route's own `Suspense` boundary, so one lazy surface never blanks another. */
function LazySurface({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteLoadingFallback />}>{children}</Suspense>;
}

/**
 * Starts the local view-event instrumentation and reports the cockpit route.
 *
 * The cockpit is a sibling of the project workspace, so it has no active tab for
 * `useProjectsState` to report; every view inside the workspace is reported there instead.
 * Mounted first among the router's children, so its install effect runs before the
 * workspace's first report. Uploads can be disabled in `server.settings.json`
 * (`observation.viewEvents.enabled`); the server then answers 204 without writing.
 *
 * THE COCKPIT REPORT IS GATED TOO. With the feature switched off, a `/cockpit` deep link is
 * redirected by {@link CockpitRoute}; reporting the tab before that redirect would record a
 * visit to a page this deployment does not have.
 */
function ViewEventInstrumentation() {
  const location = useLocation();
  const { cockpitEnabled } = useServerFeatures();
  useEffect(() => installViewEvents(), []);
  useEffect(() => {
    if (!cockpitEnabled) return;
    if (location.pathname === '/cockpit' || location.pathname.startsWith('/cockpit/')) {
      reportView('tab', 'cockpit');
    }
  }, [location.pathname, cockpitEnabled]);
  return null;
}

/** Rendered by main.tsx; mounts the shared providers, the auth gate and the project workspace routes. */
export default function App() {  const routerBasename = detectRouterBasename();

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
                  {/* The one global log drawer. Mounted at the root (and installed
                      before the routes' children mount) so the failure notice, the
                      diagnostics health cards and the Settings tab all reach the
                      same drawer through the shared port instead of importing
                      this module. Renders nothing until a producer opens it. */}
                  <Suspense fallback={null}>
                    <LazyLogDrawerHost />
                  </Suspense>
                  <Router basename={routerBasename}>
                    <ViewEventInstrumentation />
                    <Routes>
                      <Route path="/" element={<ProjectWorkspaceRoute />} />
                      <Route path="/session/:sessionId" element={<ProjectWorkspaceRoute />} />
                      {/* The standalone architecture page: the same session's
                          reading without the workspace shell, so it can live on
                          a second screen or be shared as a link. Sits behind the
                          same ProtectedRoute as the workspace, so an anonymous
                          visitor is sent to the existing login first. */}
                      <Route
                        path="/session/:sessionId/architecture"
                        element={<LazySurface><LazyArchitectureStandaloneRoute /></LazySurface>}
                      />
                      {/* The cockpit: a top-level read-only stage over the quay fleet, a sibling
                          of the project workspace rather than a tab inside one. It is behind the
                          same ProtectedRoute, so it reads the fleet only for a signed-in user;
                          `CockpitRoute` additionally checks the server's boot-time
                          `cockpit.enabled` switch and redirects to the workspace when off. */}
                      <Route path="/cockpit" element={<LazySurface><LazyCockpitRoute surface="stage" /></LazySurface>} />
                      {/* The phone remote: the input half of the same hub, opened by scanning
                          the code the stage draws. Same ProtectedRoute and the same switch, so a
                          disabled deployment cannot be reached by scanning a previously drawn
                          code either. */}
                      <Route path="/cockpit/remote" element={<LazySurface><LazyCockpitRoute surface="remote" /></LazySurface>} />
                      {/* The OAuth consent screen: a full-page surface of its own, NOT
                          inside the project workspace shell, so an authorization request
                          never mounts the sidebar, tabs or chat pane behind it. It is
                          behind the same ProtectedRoute as the workspace — an anonymous
                          visitor lands on the login form with the query string untouched,
                          which is what sends them back here after they sign in. */}
                      <Route path={OAUTH_CONSENT_SPA_PATH} element={<LazySurface><LazyOAuthConsentRoute /></LazySurface>} />
                    </Routes>
                    {/* The phone's cockpit layer. A SIBLING of the routes, not a route: it draws
                        the cards over whatever the current location matched while the session page
                        underneath stays mounted. It reads the history entry its opener pushed (the
                        phone header's cockpit button) and renders nothing without it, so a direct
                        `/cockpit?view=cards` deep link remains the standalone page. */}
                    <Suspense fallback={null}>
                      <LazyCockpitOverlayHost />
                    </Suspense>
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
