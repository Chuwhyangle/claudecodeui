import { Navigate } from 'react-router-dom';

import { useServerFeatures } from '@/shared/hooks/useServerFeatures';
import CockpitPage from '@/modules/cockpit/CockpitPage';
import CockpitRemote from '@/modules/cockpit/CockpitRemote';

/**
 * The cockpit's route gate: the switch is the SERVER's answer, never a client preference.
 *
 * WHY A GATE RATHER THAN TWO ROUTES DIRECTLY. `/cockpit` and `/cockpit/remote` are addresses a
 * person can bookmark, scan or type. With the feature off they must not render a stage that
 * then fails against gated APIs — the page does not exist for this deployment, so the router
 * sends the reader back to the workspace (`replace`, so Back does not bounce between the two).
 *
 * WHILE LOADING, NOTHING RENDERS. The alternative — optimistic mount — would fire the
 * cockpit's reads and could briefly show a mode switch on a disabled release. `null` for one
 * request is the honest state in between.
 *
 * Consumers: `App` for both cockpit routes. The unit criterion drives both arms over the real
 * shared store.
 */
export default function CockpitRoute({ surface }: { surface: 'stage' | 'remote' }) {
  const { status, cockpitEnabled } = useServerFeatures();

  if (!cockpitEnabled) {
    if (status === 'loading') {
      return null;
    }
    return <Navigate to="/" replace />;
  }

  return surface === 'remote' ? <CockpitRemote /> : <CockpitPage />;
}
