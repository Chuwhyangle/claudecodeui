/**
 * Test-only harness for the voice-realtime criteria.
 *
 * Two pieces, both seam-shaped on purpose:
 *
 *  - {@link createFakeTransport} is the fake WS server the bridge is driven
 *    over. It records what the bridge sent, lets a test deliver a server message
 *    (`peerSend`) or drop the socket (`drop`), and never touches a socket — so
 *    the whole bridge is exercised offline.
 *  - {@link captureMcpToolSchemas} reaches the MCP gateway's OWN registration
 *    functions and records the input/output schema each tool registered with.
 *    That is the AC-2 oracle: the mirrored descriptors in
 *    `../voice-realtime-tools.ts` are compared FIELD BY FIELD against what the
 *    gateway actually declared, so a drift on either side is a red rather than a
 *    hand-maintained expectation table that could drift with it.
 *
 * Not a `*.test.ts` on purpose: it is a helper both criteria import, and it must
 * not move the suite's test-file count.
 *
 * Consumers: `voice-realtime-bridge.test.ts` and
 * `voice-realtime-bridge.false-forms.test.ts`.
 */
import type {
  McpApprovalsDeps,
  McpReadToolDeps,
  McpSessionBackgroundDeps,
  McpWriteToolDeps,
} from '@/modules/mcp-gateway/index.js';

import type {
  RealtimeClientMessage,
  RealtimeServerMessage,
  RealtimeToolDescriptor,
  RealtimeTransport,
} from '../index.js';

/** One tool exactly as the MCP gateway registered it — the AC-2 oracle. */
export type CapturedMcpTool = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: RealtimeToolDescriptor['inputSchema'];
  outputSchema: RealtimeToolDescriptor['outputSchema'];
};

/**
 * Captures every tool the MCP gateway registers, keyed by name.
 *
 * The gateway is reached through its barrel (the module boundary) and its four
 * registration functions are handed a RECORDING seam, so what comes back is the
 * schema each tool declared, not a re-declaration. The deps bags are empty
 * shells: registration reads a tool's schemas from its body table and only
 * touches the deps lazily inside the handler, which this harness never calls.
 * `JWT_SECRET` is set before the import because the gateway's auth module
 * requires it at module scope.
 */
export async function captureMcpToolSchemas(): Promise<Record<string, CapturedMcpTool>> {
  process.env.JWT_SECRET ??= 'voice-realtime-criteria';
  delete process.env.VITE_IS_PLATFORM;
  const gateway = await import('@/modules/mcp-gateway/index.js');

  const captured: Record<string, CapturedMcpTool> = {};
  const record = (registration: {
    name: string;
    description: string;
    requiredScope: string;
    inputSchema: unknown;
    outputSchema?: unknown;
  }): void => {
    captured[registration.name] = {
      name: registration.name,
      description: registration.description,
      requiredScope: registration.requiredScope,
      inputSchema: registration.inputSchema as RealtimeToolDescriptor['inputSchema'],
      outputSchema: (registration.outputSchema ?? {}) as RealtimeToolDescriptor['outputSchema'],
    };
  };

  gateway.registerMcpReadTools(record, {
    projects: {},
    sessions: {},
    hosts: {},
    runs: {},
  } as unknown as McpReadToolDeps);
  gateway.registerMcpWriteTools(record, {} as unknown as McpWriteToolDeps);
  gateway.registerMcpApprovalTools(record, {} as unknown as McpApprovalsDeps);
  gateway.registerMcpSessionBackgroundTool(record, {} as unknown as McpSessionBackgroundDeps, 'cloudcli:read');

  return captured;
}

/** The fake WS server's knobs. */
export type FakeTransportOptions = {
  /** Reject the first N `open()` calls, so the reconnect path can be driven. */
  failOpens?: number;
};

/**
 * The fake transport the bridge is driven over. Beyond the {@link
 * RealtimeTransport} contract it exposes the two test-side controls (`peerSend`
 * / `drop`) and the three readings (`sent`, `openCalls`, `closeCalls`).
 */
export type FakeTransport = RealtimeTransport & {
  /** Every client→server message the bridge sent, in order. */
  readonly sent: RealtimeClientMessage[];
  /** How many times the bridge called `open()`. */
  readonly openCalls: number;
  /** How many times the bridge called `close()`. */
  readonly closeCalls: number;
  /** Deliver one server→client message, as the peer would. */
  peerSend(message: RealtimeServerMessage): void;
  /** The peer drops the socket (an UNEXPECTED close, i.e. the reconnect trigger). */
  drop(): void;
  /** Tell the bridge its synthesized tool-resume `response.create` left — the follow-up credit's source. */
  notifySynthesizedToolResume(): void;
};

/** Builds a fresh fake transport. */
export function createFakeTransport(options: FakeTransportOptions = {}): FakeTransport {
  const sent: RealtimeClientMessage[] = [];
  const messageHandlers = new Set<(message: RealtimeServerMessage) => void>();
  const closeHandlers = new Set<() => void>();
  let openCalls = 0;
  let closeCalls = 0;
  let remainingFailingOpens = options.failOpens ?? 0;
  let synthesizedResumeHandler: (() => void) | null = null;

  return {
    sent,
    get openCalls(): number {
      return openCalls;
    },
    get closeCalls(): number {
      return closeCalls;
    },
    async open(): Promise<void> {
      openCalls += 1;
      if (remainingFailingOpens > 0) {
        remainingFailingOpens -= 1;
        throw new Error(`fake transport: open #${openCalls} refused`);
      }
    },
    async close(): Promise<void> {
      closeCalls += 1;
    },
    send(message: RealtimeClientMessage): void {
      sent.push(message);
    },
    subscribe(handler: (message: RealtimeServerMessage) => void): () => void {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },
    onClose(handler: () => void): () => void {
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
    peerSend(message: RealtimeServerMessage): void {
      for (const handler of [...messageHandlers]) {
        handler(message);
      }
    },
    drop(): void {
      for (const handler of [...closeHandlers]) {
        handler();
      }
    },
    onSynthesizedToolResume(handler: () => void): () => void {
      synthesizedResumeHandler = handler;
      return () => {
        synthesizedResumeHandler = null;
      };
    },
    notifySynthesizedToolResume(): void {
      synthesizedResumeHandler?.();
    },
  };
}

/**
 * Polls `predicate` until it holds (or `timeoutMs` elapses, which throws).
 *
 * The bridge's reconnect runs off a `void`-started async loop, so a test that
 * drops the socket must yield to the microtask queue before reading the new
 * state; this is that yield, bounded so a real hang fails instead of stalling.
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
