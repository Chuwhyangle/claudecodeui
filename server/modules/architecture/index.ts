/**
 * Architecture module — barrel (AC-415 / AC-416).
 *
 * Today the module holds one pure helper: seed extraction (AC-416). The graph
 * generator (AC-415) and the route wiring (AC-418) reach it through this door
 * only, so the module stays a leaf nobody else may deep-import.
 */
// consumer: server/modules/architecture/tests/seed-extraction.test.ts
export type { SeedExtractionResult } from './seed-extraction.js';
// consumer: server/modules/architecture/tests/seed-extraction.test.ts
export { extractSeeds } from './seed-extraction.js';
