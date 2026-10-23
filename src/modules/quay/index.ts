export { default as QuayPanel, buildQuayInFlightContract } from '@/modules/quay/QuayPanel';
export { useQuayStatus } from '@/modules/quay/hooks/useQuayStatus';
export type { QuayPanelView } from '@/modules/quay/hooks/useQuayStatus';
export { isQuayTabVisible, useEnsureQuayTabVisible } from '@/modules/quay/hooks/useQuayTabVisibility';
// The wall address grammar and the in-flight tile's view contract, exposed for the cockpit
// module: it declares the same `quay://<project>/board` / `quay://<project>/task/<id>` objects
// the Quay tab declares, and reuses quay's in-flight tile instead of re-deriving its phases.
export { formatQuayUri, parseQuayUri } from '@/modules/quay/quayUri';
export type { QuayParsedObject, QuayUriParseResult, QuayUriRejection } from '@/modules/quay/quayUri';
