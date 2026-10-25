/**
 * Notices module — barrel.
 *
 * The registry behind `GET /api/notices` and `POST /api/notices/:id/dismiss`: the `Notice` model
 * (lifecycle × severity), the injected `NoticeProvider` contract, the per-user revision-bound
 * dismissal rules, and the thin router. `server/index.ts` builds the one registry and mounts the
 * router behind `authenticateToken`; nothing outside deep-imports an internal file.
 *
 * The module is a leaf: it imports `server/shared` and itself only, and the deploy provider is
 * injected by the composition root rather than imported here (N8).
 */
// consumer: server/index.ts (creates the process-wide registry and mounts the router)
export { createNoticeRegistry } from './notice-registry.service.js';
export type {
  Notice,
  NoticeDismissalsStore,
  NoticeLifecycle,
  NoticeList,
  NoticePrimaryAction,
  NoticeProvider,
  NoticeRegistry,
  NoticeRegistryDeps,
  NoticeSeverity,
} from './notice-registry.service.js';
// consumer: server/index.ts (mounts it under /api/notices); the registry test drives it over a
// real express app.
export { createNoticesRouter } from './notices.routes.js';
