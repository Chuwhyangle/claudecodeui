import { createDebugAgentProvider, DEBUG_AGENT_PROVIDER_ID, isDebugAgentEnabled } from '@/modules/debug-agent/index.js';
import { ClaudeProvider } from '@/modules/providers/list/claude/claude.provider.js';
import { publishSessionDeliveries } from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import {
  announceNormalizedPermission,
  announceNormalizedPermissionResolved,
  forwardNormalizedFrames,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { CodexProvider } from '@/modules/providers/list/codex/codex.provider.js';
import { CursorProvider } from '@/modules/providers/list/cursor/cursor.provider.js';
import { OpenCodeProvider } from '@/modules/providers/list/opencode/opencode.provider.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { installProviderRegistryPort } from '@/shared/ports/provider-registry.port.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

// Keyed by `string` rather than by `LLMProvider` because a runtime provider id
// is not a member of that union (ADR-003 decision 2): the union is a product
// declaration that appears in settings, model menus and compile-time exhaustive
// maps, and the debug agent deliberately is not one of those. Resolution was
// already written against `string`, so nothing at the read side had to change.
const providers: Record<string, IProvider> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
  cursor: new CursorProvider(),
  opencode: new OpenCodeProvider(),
};

/**
 * Central registry for resolving concrete provider implementations by id.
 *
 * Consumed by: the provider routes, the runtime service, the sessions service
 * and the WebSocket chat path — everything that turns an id from a request into
 * an implementation.
 */
export const providerRegistry = {
  listProviders(): IProvider[] {
    return Object.values(providers);
  },

  resolveProvider(provider: string): IProvider {
    const key = provider as LLMProvider;
    const resolvedProvider = providers[key];
    if (!resolvedProvider) {
      throw new AppError(`Unsupported provider "${provider}".`, {
        code: 'UNSUPPORTED_PROVIDER',
        statusCode: 400,
      });
    }

    return resolvedProvider;
  },

  /**
   * Registers the debug agent under its runtime id, and is the ONLY way a
   * non-union id can enter this table. Consumed by the debug agent's provider
   * module when it constructs itself.
   *
   * ADR-003 decision 3, face 1 — "registry 里没有键". The gate is read HERE, so
   * that a closed gate means the key was **never written**: `resolveProvider
   * ('debug')` then throws the same `UNSUPPORTED_PROVIDER` error, with the same
   * message, as `resolveProvider('claud')`. A closed gate and a typo are
   * indistinguishable, which is the property the face is about — a key that
   * existed and was rejected on lookup would be distinguishable, and would put
   * the debug agent on a code path every user's request already traverses.
   *
   * Invoked from this file's own construction site, below. It cannot be invoked
   * from the debug agent's module: this registry imports that module (for the id
   * and the gate seam), so a registration written there would run while this file
   * is still evaluating and would read a half-initialised registry.
   *
   * @returns whether the key is registered after the call.
   */
  registerDebugAgentProvider(provider: IProvider): boolean {
    if (!isDebugAgentEnabled()) {
      return false;
    }

    providers[DEBUG_AGENT_PROVIDER_ID] = provider;
    return true;
  },
};

/**
 * The debug agent's provider, built once and registered under its runtime id.
 *
 * Registered here, at the registry's own construction site, and not from the
 * debug agent's module: the import edge runs this way round (this file imports
 * that module for the id and the gate seam), so a self-registration would close
 * a cycle and read a half-evaluated binding.
 *
 * The gate decides whether anything exists. While it is closed the factory
 * returns null and the key is never written, so `resolveProvider('debug')` fails
 * exactly as a typo does — and nothing at all was constructed, rather than a
 * provider with a plausible-looking fixture home that a later bug could reach.
 *
 * What is injected is the point of the shape: the product's own normalizer
 * (`sessions`), its own frame forwarder, and an indexer pointed at the fixture
 * home instead of the user's real transcripts.
 *
 * `declareRuntimeCapabilities` is injected here because the capability matrix is
 * this module's, and because the debug agent is not in `LLMProvider`: the
 * declaration records `resident` mode and a multiplexed host against the runtime
 * id, so the union-keyed table stays a complete description of the union. No
 * `openRun` seam is injected — the run registry belongs to the websocket module,
 * which imports this one, so the edge back would close a cycle; the provider
 * states that gap rather than papering over it when an unattended turn needs it.
 */
const debugAgentProvider = createDebugAgentProvider({
  base: providers.claude,
  forwardFrames: forwardNormalizedFrames,
  // The prompt announcer. Built here because this is the one construction site
  // that sees both the debug module and the claude runtime module: the frame's
  // vocabulary (`permission_request`) and the product's Turn Tracker both live on
  // the claude side, and the debug module may not name either (ADR-003 decision
  // 7). The two injected functions are the claude runtime's own, so a debug
  // prompt and a real one reach a client and the activity phase through one
  // implementation rather than two.
  announcePermission: {
    request: ({ sessionId, requestId, toolName, input, writer }) =>
      announceNormalizedPermission({ sessionId, requestId, toolName, input, ws: writer }),
    resolved: ({ sessionId, requestId, writer }) =>
      announceNormalizedPermissionResolved({ sessionId, requestId, ws: writer }),
  },
  createSessionSynchronizer: (options) => new ClaudeSessionSynchronizer(options),
  // The delivery ledger publication. The debug substitute's push is a delivery
  // like any other, and the activity channel's reader is keyed per session in the
  // claude driver's own registry — so the substitute publishes through that ONE
  // seam rather than growing a second ledger no reader looks at. Injected here
  // because this is the one site that sees both modules (ADR-003 decision 7).
  publishDeliveries: publishSessionDeliveries,
  declareRuntimeCapabilities: (capabilities) =>
    providerCapabilitiesService.declareRuntimeProviderCapabilities(capabilities),
});

if (debugAgentProvider) {
  providerRegistry.registerDebugAgentProvider(debugAgentProvider);
}

// The registry's read face, installed as the shared port while this module
// evaluates. Consumers under `services/` (today: `provider-runtime.service.ts`)
// reach the registry through the accessor instead of importing this file, which
// removes the `providers/services -> providers` directory edge that held the
// parent/services pair inside the server initialization cycle. Installing at the
// BOTTOM of the body matters: the table and the debug-agent registration above
// are complete by then, and every port call happens from a method body long
// after module evaluation. `server/index.ts` repeats the installation in the
// composition root; the second write is the same object.
installProviderRegistryPort(providerRegistry);
