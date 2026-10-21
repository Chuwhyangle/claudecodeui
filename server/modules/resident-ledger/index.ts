/**
 * The resident ledger as a LEAF module (AC-396).
 *
 * `ledger.ts` holds the state and the transitions; this barrel is the one door
 * the rest of `server/` reaches them through. The module imports only
 * `@/shared/**` and itself, so it sits at the bottom of the directory graph: the
 * driver depends on the ledger, the ledger on nobody, and no cycle can close
 * through it (AC-396 (b)).
 *
 * ## Why every export carries a `// consumer:` line
 *
 * A barrel whose exports nobody reads is just a second copy of the module's
 * internals kept in public view. Each name re-exported here names the ONE file
 * that imports it THROUGH this barrel, and the criterion resolves that file's
 * own AST to check the claim (`AC-396 (a)`): an export added "for later", or
 * left behind when its last caller moved on, reds rather than silently widening
 * the surface. Only what the driver and the ledger's own criterion need crosses
 * — the module's internal helpers (`mutable`, `openTurn`, `recordAnomaly`,
 * `boundDeliveryIds`, `closeTurnRecord`, `reconcileOwed`) stay private, and so
 * does the mutable `ResidentLedgerTransition` shape the driver never names.
 */
// consumer: server/modules/providers/list/claude/claude-host-driver.provider.ts
export type { ResidentLedgerEvent } from './ledger.js';
// consumer: server/modules/providers/list/claude/claude-host-driver.provider.ts
export type { ResidentLedgerEffect } from './ledger.js';
// consumer: server/modules/providers/list/claude/claude-host-driver.provider.ts
export { createResidentLedger } from './ledger.js';
// consumer: server/modules/providers/list/claude/claude-host-driver.provider.ts
export { ledgerDeliveries } from './ledger.js';
// consumer: server/modules/providers/list/claude/claude-host-driver.provider.ts
export { ledgerDeliveryByUuid } from './ledger.js';
// consumer: server/modules/providers/list/claude/claude-host-driver.provider.ts
export { ledgerTurn } from './ledger.js';
// consumer: server/modules/providers/list/claude/claude-host-driver.provider.ts
export { ledgerPendingStart } from './ledger.js';
// consumer: server/modules/providers/list/claude/claude-resident-outcome-handlers.ts
export { ledgerForeign } from './ledger.js';
// consumer: server/modules/providers/list/claude/claude-host-driver.provider.ts
export { ledgerClosedTurns } from './ledger.js';
// consumer: server/modules/providers/list/claude/claude-resident-outcome-handlers.ts
export { ledgerAnomalies } from './ledger.js';
// consumer: server/modules/providers/list/claude/claude-host-driver.provider.ts
export { applyLedgerEvent } from './ledger.js';
