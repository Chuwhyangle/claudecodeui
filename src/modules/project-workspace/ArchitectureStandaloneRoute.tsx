import { useCallback } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { useWebSocket } from '@/shared/context/WebSocketContext';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { useProjectsState } from '@/modules/project-workspace/hooks/useProjectsState';
import { ArchitecturePanel, requestArchitectureSessionFocus } from '@/modules/architecture';

/**
 * A stable "nothing is running" answer for the standalone page's project state.
 *
 * `useProjectsState` normally receives the busy-session predicate from the
 * workspace's `SessionProtectionProvider`; the standalone architecture page has
 * no chat, so no turn can be running in it. A module-level function keeps the
 * hook's dependency identity stable across renders.
 */
const NO_SESSION_IS_PROCESSING = (): boolean => false;

/**
 * The `/session/:sessionId/architecture` route: the architecture panel alone, in
 * a page of its own.
 *
 * Opened by the panel's "Open in new tab". It deliberately mounts NO workspace
 * shell (no sidebar, no tab strip), so the drawing gets the whole viewport; the
 * panel itself reports the deep link's first-paint state and draws the "Back to
 * session" entry. The project is resolved from the session through the
 * workspace's own state hook, which is also what carries the Tier-1
 * `hasArchguardCache` reading for a session that is not in the loaded project
 * pages.
 *
 * LIVES IN ITS OWN MODULE so `App` can `React.lazy` it: architecture's renderer
 * graph (plantuml-js, elkjs, the export tooling) is not part of the workspace's
 * first-screen chunk, and a session page that never opens the architecture tab
 * never fetches it.
 */
export default function ArchitectureStandaloneRoute() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { subscribe } = useWebSocket();
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { selectedProject, selectedSession } = useProjectsState({
    sessionId,
    navigate,
    subscribe,
    isMobile,
    isSessionProcessing: NO_SESSION_IS_PROCESSING,
  });

  /**
   * Switch to the open workspace tab when one answers; otherwise navigate this
   * tab to the session. A confirmed tab means this standalone copy closes
   * itself, so "Back" does not leave a duplicate workspace behind.
   */
  const handleBackToSession = useCallback((): void => {
    if (sessionId === undefined || sessionId === '') {
      navigate('/');
      return;
    }
    void (async () => {
      const focused = await requestArchitectureSessionFocus(sessionId);
      if (!focused) {
        navigate(`/session/${encodeURIComponent(sessionId)}`);
        return;
      }
      // The workspace tab brought itself forward. Closing a script-opened tab is
      // allowed; a manually opened one stays, which is harmless — the reader is
      // already looking at the workspace.
      window.close();
    })();
  }, [navigate, sessionId]);

  return (
    <ArchitecturePanel
      projectId={selectedProject?.projectId ?? null}
      sessionId={sessionId ?? null}
      projectName={selectedProject?.displayName ?? null}
      sessionTitle={selectedSession?.title ?? selectedSession?.summary ?? null}
      standalone
      deepLinkSearch={location.search}
      onBackToSession={handleBackToSession}
    />
  );
}
