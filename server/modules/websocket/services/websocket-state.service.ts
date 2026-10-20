import type { RealtimeClientConnection } from '@/shared/types.js';
import { installConnectedClientsPort } from '@/shared/ports/connected-clients.port.js';

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * We keep this in module state so services that broadcast updates do not need
 * to import `ws` directly just to compare open/closed state.
 */
export const WS_OPEN_STATE = 1;

/**
 * Shared registry of active chat WebSocket connections.
 *
 * Project/session services publish realtime updates by iterating this set.
 */
export const connectedClients = new Set<RealtimeClientConnection>();

// The read-only face of this set, installed as the shared `connected-clients`
// port while the module evaluates. The consumer is the resident host driver's
// `connectedClientCount` callback, reached through `claude.provider.ts`; that
// module must not import this one, because the websocket services import the
// providers module and the pair would close an initialization cycle. Installing
// the accessor here means the provider graph sees the live count without an
// edge. `server/index.ts` repeats the installation in the composition root.
installConnectedClientsPort({ count: () => connectedClients.size });
