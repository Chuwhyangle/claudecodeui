// createSystemModule: used by the server entrypoint to mount protected system update routes.
export { createSystemModule } from './system.module.js';
// readBuildInfo: used by the server entrypoint's `/health` route to report the commit the running
// build was compiled from, so an operator can tell whether a deployment is current.
export { readBuildInfo } from './system.service.js';
// createDeployNoticeProvider: used by the server entrypoint (the composition root) to adapt the
// deploy readiness reading into the notices registry's provider list. The notices module must not
// import system (N8), so the arrow points this way and the entrypoint injects the reader.
export { createDeployNoticeProvider } from './deploy-notice-provider.js';
export type { DeployNoticeProviderDeps } from './deploy-notice-provider.js';
