/**
 * App-server subpackage barrel — the Codex app-server transport and the upstream
 * provider launch/injection compilers.
 *
 * This is the SINK of the codex split: every file here imports only
 * `server/shared/**`, package-external modules and its own siblings — nothing in
 * `host/`, `sessions/` or the package root. The directory-level reading (AC-394)
 * therefore stays acyclic.
 */
export {
  collectModelPages,
  codexAppServer,
} from './codex-app-server.client.js';
export type {
  CodexModelDescriptor,
  CodexThreadFork,
  CodexThreadReading,
} from './codex-app-server.client.js';

export { startCodexAppServerProcess } from './codex-app-server-process.js';
export type {
  CodexAppServerProcess,
  CodexAppServerProcessOptions,
  CodexAppServerStopResult,
} from './codex-app-server-process.js';

export {
  CodexAppServerConnection,
  CODEX_APP_SERVER_LAUNCHER_ENV,
  resolveCodexAppServerLauncher,
} from './codex-app-server.connection.js';
export type {
  CodexAppServerTransport,
  CodexAppServerLaunch,
  CodexAppServerConnectionOptions,
} from './codex-app-server.connection.js';

export {
  buildCodexProviderEnv,
  codexOptionsForProvider,
  resolveCodexUpstreamProvider,
  codexProviderSpawnArgs,
  compileCodexProviderLaunch,
  compileCodexProviderOptions,
} from './codex-provider-injection.js';
export type { CodexModelLimits } from './codex-provider-injection.js';
