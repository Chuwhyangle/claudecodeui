/**
 * The neutral accessor for the provider registry.
 *
 * WHY THIS FILE EXISTS. `modules/providers/provider.registry.ts` constructs the
 * concrete providers, and every service under `modules/providers/services/`
 * imported it directly to answer "which provider is this id". That import is a
 * parent-directory edge, so the directory graph held `providers <->
 * providers/services`: the barrel re-exported the services while the services
 * imported the registry back, and the pair sat inside the larger server
 * initialization cycle. Services only ever need two verbs (`listProviders`,
 * `resolveProvider`), and they call them from method bodies — never while the
 * registry is still evaluating — so the dependency can be an installed port
 * rather than a static import.
 *
 * `provider.registry.ts` installs itself at the bottom of its own module body
 * (`installProviderRegistryPort(providerRegistry)`), which keeps every existing
 * import path working (the barrel, a direct service import, a criterion) while
 * removing the `services -> parent` edge from the static graph. `server/index.ts`
 * also names the installation explicitly in the composition root, so the wiring
 * is readable where the process is assembled.
 *
 * Consumers: `modules/providers/services/provider-runtime.service.ts` (its
 * default dependencies) and the composition root. This file imports only shared
 * vocabulary and therefore adds no edge in either direction.
 */
import type { IProvider } from '@/shared/interfaces.js';

/**
 * The two registry verbs a provider service needs.
 *
 * `resolveProvider` throws the registry's own `UNSUPPORTED_PROVIDER` `AppError`
 * for an unknown id; the port forwards that behaviour unchanged rather than
 * restating it. A consumer that needs registry state beyond these two verbs
 * should extend this contract deliberately — the narrow surface is what keeps
 * the dependency one-way.
 */
export type ProviderRegistryPort = {
  listProviders(): IProvider[];
  resolveProvider(provider: string): IProvider;
};

/**
 * The installed registry, or null before composition.
 *
 * A process-wide singleton because the registry itself is one: `provider.registry`
 * builds the provider table once at module load, and every service must resolve
 * against that same table. The mutable cell is the seam that replaces the
 * static import; it is written once during module evaluation and again
 * idempotently by the composition root.
 */
let installedProviderRegistry: ProviderRegistryPort | null = null;

/**
 * Installs the process's provider registry.
 *
 * Called by `provider.registry.ts` at the bottom of its own module body and by
 * `server/index.ts`. Re-installing the same object is a no-op; installing a
 * second one replaces the first, which is what lets a criterion drive a service
 * over its own registry if it needs to.
 */
export function installProviderRegistryPort(port: ProviderRegistryPort): void {
  installedProviderRegistry = port;
}

/**
 * Reads the installed provider registry.
 *
 * Throws rather than returning null: every caller is a method on a provider
 * service, and a missing registry there is a composition bug — answering with an
 * empty provider list would turn it into a silent "no providers" runtime
 * behaviour. The error names the installation point so the fix is obvious.
 */
export function readProviderRegistryPort(): ProviderRegistryPort {
  if (installedProviderRegistry === null) {
    throw new Error(
      'The provider registry port is not installed; call installProviderRegistryPort(providerRegistry) at the composition root.',
    );
  }
  return installedProviderRegistry;
}
