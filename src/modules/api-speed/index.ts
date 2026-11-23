/**
 * API speed module — barrel.
 *
 * The workspace tab that shows how long a request to the model gateway takes,
 * split into connection, upload, relay wait and download.
 *
 * Consumer: `src/modules/project-workspace/WorkspaceMain.tsx`, which lazy-loads
 * the panel when the workspace tab is `api-speed`.
 */
export { ApiSpeedPanel } from '@/modules/api-speed/ApiSpeedPanel';
