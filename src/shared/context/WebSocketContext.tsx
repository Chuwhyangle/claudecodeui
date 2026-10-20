import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { IS_PLATFORM } from '@/shared/utils';
import { invalidateSessionHosts, setSessionHostsConnection } from '@/shared/hooks/useSessionHosts';
import { readDeviceName } from '@/shared/userSettings';
import { getDeviceId, getTabId } from '@/shared/utils/deviceIdentity';
import type { ServerEvent, UiHelloFrame } from '@/shared/types';


type ServerEventListener = (event: ServerEvent) => void;

/**
 * The auth state this provider needs, supplied by the application assembly point
 * (`App`) rather than read here.
 *
 * The shared layer must not import a feature module, and the auth session is
 * owned by `modules/auth`. Passing it in keeps the dependency pointing the right
 * way: the app knows both layers and wires them together.
 */
export type WebSocketAuthPort = {
  /** True while a stored session is still being recovered after a reload. */
  isLoading: boolean;
  /** Bearer credential used verbatim in the socket URL; null before sign-in. */
  token: string | null;
  /** The signed-in user, or null. Only its presence is read here. */
  user: unknown;
};

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames cannot be coalesced or
   * dropped. Frames are deliberately not copied into React state; each
   * listener updates only the state owned by the feature that handles it.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

/**
 * Announces this browser to the server on the socket it just opened.
 *
 * Sent from `onopen` and nowhere else, so it fires exactly once per connection —
 * including every reconnect, because the identity lives only as long as the
 * server's connection does. A guard on `readyState` keeps an already-closing
 * socket from throwing mid-handshake.
 */
const sendUiHello = (socket: WebSocket) => {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  const frame: UiHelloFrame = {
    type: 'ui.hello',
    deviceId: getDeviceId(),
    tabId: getTabId(),
    deviceName: readDeviceName(),
  };
  socket.send(JSON.stringify(frame));
};

/**
 * The socket URL for the current credential.
 *
 * The token is carried verbatim, however its `exp` reads against the local clock:
 * the server is the authority on whether a credential is still good, and a socket
 * is not allowed to be a logout trigger. A token the server really rejects shows
 * up as a refused REST request, which is where the session is ended; a socket that
 * simply cannot connect is handled by the reconnect loop below.
 */
const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const useWebSocketProviderState = (auth: WebSocketAuthPort): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { isLoading: isAuthLoading, token, user } = auth;

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  // Named function expression so the reconnect timer below can call itself
  // without reading the `connect` binding while it is still initializing.
  const connect = useCallback(function connect() {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    if (!IS_PLATFORM && (isAuthLoading || !user)) return;
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);
      // Store connecting sockets too, so a token refresh can close them before
      // their handshake completes with stale credentials.
      wsRef.current = websocket;

      websocket.onopen = () => {
        setIsConnected(true);
        // Announce this browser's identity before anything else can be asked of
        // this connection: the server holds it in memory per connection, so the
        // announcement and the connection have the same lifetime.
        sendUiHello(websocket);
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (wsRef.current !== websocket) {
          return;
        }
        setIsConnected(false);
        wsRef.current = null;

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [dispatch, isAuthLoading, token, user]); // reconnect with current authentication state

  // Declared after `connect` so the effect body does not reference it before
  // initialization. `connect` is memoized on [dispatch, isAuthLoading, token,
  // user] and `dispatch` is stable, so depending on it reconnects on exactly
  // the same transitions as the previous [isAuthLoading, token, user] list.
  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    if (!IS_PLATFORM && (isAuthLoading || !user)) {
      return undefined;
    }
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      const activeSocket = wsRef.current;
      if (activeSocket) {
        // Prevent the intentionally closed, old-token socket from scheduling
        // a reconnect after the refreshed-token effect has already started.
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        activeSocket.close();
        wsRef.current = null;
      }
    };
  }, [connect, isAuthLoading, user]); // reconnect after authentication or token refresh

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected');
    }
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  // The session-hosts store's bridge to this socket. The server announces that
  // the host listing changed with a `hosts_changed` frame; the store answers by
  // re-reading `GET /api/session-hosts`, so the pushed signal and the REST read
  // can never disagree about the shape of a host. The frame carries a revision
  // and the store drops one it has already applied, which is what makes a
  // re-delivered frame free.
  //
  // The synthetic reconnect event is the same instruction without a revision:
  // every frame sent while the socket was down was never delivered, so the store
  // re-reads at once rather than waiting out the (long) connected fallback
  // interval. The bridge is mounted here rather than inside the store because
  // the store must not import this provider — that would close a cycle — while
  // this provider is already the page's single socket consumer.
  useEffect(() => subscribe((event) => {
    if (event.kind === 'hosts_changed') {
      invalidateSessionHosts(typeof event.rev === 'number' ? event.rev : undefined);
      return;
    }
    if (event.kind === 'websocket_reconnected') {
      invalidateSessionHosts();
    }
  }), [subscribe]);

  // The store's fallback interval depends on whether the socket is up: long when
  // it is (the frames are the signal), short when it is not (nothing else would
  // report a change). The cleanup puts the store back to "disconnected" when the
  // provider goes away, so a later mount does not inherit a long interval it has
  // no socket to justify.
  useEffect(() => {
    setSessionHostsConnection(isConnected);
    return () => {
      if (isConnected) {
        setSessionHostsConnection(false);
      }
    };
  }, [isConnected]);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    isConnected
  }), [sendMessage, subscribe, isConnected]);

  return value;
};

/**
 * Mounted once by App; owns the single chat websocket that the chat, project-workspace
 * and task-master modules subscribe to.
 *
 * `auth` is injected by App (which sits inside `AuthProvider`) so this shared
 * provider never imports the auth feature: the dependency points feature → shared,
 * never shared → feature.
 */
export const WebSocketProvider = (
  { children, auth }: { children?: React.ReactNode; auth: WebSocketAuthPort },
) => {
  const webSocketData = useWebSocketProviderState(auth);

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
