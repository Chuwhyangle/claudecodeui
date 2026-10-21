/**
 * Architecture module — barrel (AC-415 / AC-416).
 *
 * Today the module holds two pure helpers: seed extraction (AC-416) and the
 * seeded graph generator (AC-415). The route wiring (AC-418) reaches both
 * through this door only, so the module stays a leaf nobody else may
 * deep-import.
 */
// consumer: server/modules/architecture/tests/generator.test.ts (AC-415)
export type {
  ArchIndex,
  GenerateGraphParams,
  GenerateGraphResult,
  GraphSeeds,
  GraphStats,
  UnresolvedSeeds,
} from './generator.js';
// consumer: server/modules/architecture/tests/generator.test.ts (AC-415)
export { generateGraph, validateMermaid } from './generator.js';
// consumer: server/modules/architecture/tests/seed-extraction.test.ts
export type { SeedExtractionResult } from './seed-extraction.js';
// consumer: server/modules/architecture/tests/seed-extraction.test.ts
export { extractSeeds } from './seed-extraction.js';
