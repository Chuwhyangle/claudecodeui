// settingsRoutes: used by the server entrypoint to mount protected application-settings endpoints.
export { settingsRoutes } from './settings.module.js';
// createSettingsRouter: used by the settings criteria to mount the production route
// factory on a real express server without importing the assembled module singleton.
export { createSettingsRouter } from './settings.routes.js';
// createSettingsService: used by the settings criteria to assemble the production
// service with injected dependencies (including the OAuth access-token port).
export { createSettingsService } from './settings.service.js';
// loadServerSettings / SERVER_SETTINGS_ENV: the generic SERVER-level settings file
// (`~/.config/claudecodeui/server.settings.json`, or the path `SERVER_SETTINGS_PATH`
// names), read once at boot by `server/index.ts` for knobs that belong to the
// process rather than to a user. Per-user settings stay in the settings store
// behind the routes above; this file is the one carrier for server-wide policy.
export { loadServerSettings, SERVER_SETTINGS_ENV } from './server-settings.js';
// ServerSettings / ResidentRestoreSettings / ObservationSettings: the reading `server/index.ts`
// branches on (`residentRestore.enabled`, `max`, `maxAgeMs`, `observation.wallLimit`) and the
// shape of those blocks. Exported for that composition root and for the resident-restore
// criterion, which drives the loader over files it owns.
export type { ObservationSettings, ResidentRestoreSettings, ServerSettings } from './server-settings.js';
