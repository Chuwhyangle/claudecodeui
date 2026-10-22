/**
 * Architecture module — barrel (AC-415 / AC-416 / AC-417 / AC-418).
 *
 * The pure pieces (seed extraction, the seeded graph generator, the
 * content-addressed cache) plus the AC-418 wiring: the graph service, the Tier-1
 * `hasArchguardCache` path check, and the composed router. Other modules reach
 * the Tier-1 check through this door only, and `server/index.ts` mounts the
 * composed module; no consumer deep-imports an internal file.
 */
// consumer: server/modules/architecture/tests/generator.test.ts (AC-415),
// the provenance-tier criterion, and service.ts (GraphSeeds carries `mentions`)
export type {
  ArchIndex,
  GenerateGraphParams,
  GenerateGraphResult,
  GraphSeeds,
  GraphStats,
  MentionTier,
  SeedMentionProvenance,
  UnresolvedSeeds,
} from './generator.js';
// consumer: server/modules/architecture/tests/generator.test.ts (AC-415)
export { DIRECT_MAX_CANDIDATES, generateGraph, validateMermaid } from './generator.js';
// consumer: server/modules/architecture/tests/seed-extraction.test.ts
export type {
  SeedExtractionResult,
  SeedMentionHit,
  SeedMentionKind,
  SeedMentionOptions,
  SeedMentionResult,
  SeedMentionTrace,
} from './seed-extraction.js';
// consumer: server/modules/architecture/tests/seed-extraction.test.ts
export { extractSeeds, extractSeedMentions } from './seed-extraction.js';
// consumer: server/modules/projects/services/projects-with-sessions-fetch.service.ts,
// server/modules/mcp-gateway/mcp-overview-tools.ts (the Tier-1 gate),
// server/modules/architecture/tests/architecture-routes.test.ts (AC-418)
export { DEFAULT_HOPS, DEFAULT_MAX_NODES, createArchitectureService, hasArchguardCache } from './service.js';
// consumer: server/modules/architecture/tests/architecture-routes.test.ts (AC-418)
export type {
  ArchitectureGraphInput,
  ArchitectureGraphParams,
  ArchitectureGraphResult,
  ArchitectureGraphStats,
  ArchitectureMentionEntity,
  ArchitectureMentionsInput,
  ArchitectureMentionsResult,
  ArchitectureProvenance,
  ArchitectureSeedStats,
  ArchitectureService,
  ArchitectureServiceDeps,
  ArchguardManifest,
  ArchguardManifestScope,
} from './service.js';
// consumer: server/modules/architecture/tests/architecture-routes.test.ts (the
// scope-hygiene criteria); service.ts re-exports the provenance field as a type
export { SCOPE_HYGIENE_RULES_VERSION, mergeScopesWithHygiene } from './scope-hygiene.js';
// consumer: server/modules/architecture/tests/architecture-routes.test.ts, and
// `ArchitectureProvenance.scopeHygiene` below
export type {
  DroppedOutsideRootScope,
  HygieneScope,
  ScopeHygiene,
  ScopeHygieneOptions,
  ScopeHygieneResult,
  SubsumedScope,
} from './scope-hygiene.js';
// consumer: server/index.ts (mounts the router under /api/architecture)
export { createArchitectureModule } from './module.js';
export type { ArchitectureModuleDeps } from './module.js';
