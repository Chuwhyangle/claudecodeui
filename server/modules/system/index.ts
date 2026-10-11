// createSystemModule: used by the server entrypoint to mount protected system update routes.
export { createSystemModule } from './system.module.js';
// readBuildInfo: used by the server entrypoint's `/health` route to report the commit the running
// build was compiled from, so an operator can tell whether a deployment is current.
export { readBuildInfo } from './system.service.js';
