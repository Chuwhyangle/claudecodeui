/**
 * API-latency module — barrel.
 *
 * Measures the link between this server and the model gateway in stages (DNS /
 * TCP / TLS / upload / relay wait / download) and serves the recent samples to
 * the workspace's "API speed" tab.
 *
 * `server/index.ts` mounts `createApiLatencyModule` under `/api/api-latency`.
 * Nothing outside deep-imports an internal file.
 */
// consumer: server/index.ts (mounts the returned router under /api/api-latency)
export { createApiLatencyModule } from './api-latency.module.js';
export type { ApiLatencyModuleOptions } from './api-latency.module.js';
