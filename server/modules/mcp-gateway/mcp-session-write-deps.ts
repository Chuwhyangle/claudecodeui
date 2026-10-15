/**
 * The production assemblies for the two optional deps `session_create` and
 * `session_interrupt` read (AC-278).
 *
 * AC-250 implemented both handlers and AC-251 the two host tools, but the
 * composition root (`server/index.ts`) never handed the gateway the three deps
 * they dispatch on, so every one of the four tools answered the AC-249
 * placeholder (`MCP_TOOL_NOT_IMPLEMENTED`) in production. This module is the
 * missing half of the wiring: it turns the process singletons the composition
 * root already holds into the two deps bags {@link registerMcpWriteTools}
 * reads, and it lives OUT HERE — rather than inline in `server/index.ts` —
 * precisely so the AC-278 criterion can drive the SAME construction path the
 * production assembly takes instead of assembling a second, test-only bag (the
 * false-green this task exists to close).
 *
 * `sessionHostControl` needs no builder of its own: AC-251's
 * {@link createSessionHostControl} already IS the exported production
 * constructor over the session-hosts barrel, and both `server/index.ts` and the
 * criterion call it the same way.
 *
 * What each builder is handed is the RAW production seam, not a pre-chewed
 * entry list: {@link buildSessionCreateDeps} reads the active-project rows
 * straight off the project repository and does the `{id,title,path}` projection
 * itself, so "the project a `session_create` may target is an ACTIVE one" is a
 * property of the wiring rather than of a caller that remembered to filter. The
 * two `session_create` services are the real `sessionsService` methods, and the
 * control seam is the one `ChatControlService` every front end shares
 * (AC-233/AC-253) — a caller cannot point the gateway at a second one because
 * the bags carry the instance it was given.
 */

import type { providerCapabilitiesService, providerModelsService } from '@/modules/providers/index.js';
import type { LLMProvider, ProjectRepositoryRow, SessionLaunchSelection } from '@/shared/types.js';

import type {
  McpControlAbortSeam,
  McpSessionCreateDeps,
  McpSessionInterruptDeps,
} from './mcp-session-lifecycle.js';
import type { McpControlSeam } from './mcp-session-send.js';

// --------------------------- session_create ---------------------------

/**
 * The production services `session_create` answers from, as the composition
 * root holds them.
 *
 * Every member is a process singleton rather than a value: `projects` is the
 * project repository (its `getProjectPaths` is the ACTIVE listing), `sessions`
 * is `sessionsService` — `createAppSession` mints the row, and
 * `switchSessionLifecycleMode` stores a lifecycle preference before the first
 * turn — and `control` is the one shared `ChatControlService` a message send
 * rides. The two `sessions` members are declared as METHODS so the real
 * service, whose `switchSessionLifecycleMode` takes the narrower `HostMode`,
 * stays assignable (method parameters are checked bivariantly); the builder's
 * own contract widens the mode to `string`, which is the tool's input type.
 *
 * `createAppSession` is declared WITH its trailing `selection` even though the
 * adapter in this file is what forwards it and not what reads it. A declaration
 * that stopped at `initialMessage` would be a second, silent spelling of the
 * value drop this file was fixed for: `session_create`'s `model` arrives here as
 * exactly this argument, so a three-parameter shape would let the adapter
 * discard the model the tool had already validated while still typechecking —
 * the row would keep `model = NULL` and the session's first run would fall back
 * to the CLI's account default (the `--model default` incident).
 */
export type McpSessionCreateWiring = {
  projects: { getProjectPaths(): ReadonlyArray<ProjectRepositoryRow> };
  sessions: {
    createAppSession(
      provider: LLMProvider,
      projectPath: string,
      initialMessage: string,
      selection?: SessionLaunchSelection,
    ): { sessionId: string };
    switchSessionLifecycleMode(provider: LLMProvider, sessionId: string, mode: string): unknown;
  };
  control: McpControlSeam;
  /**
   * The provider capability matrix and the session-row writer `session_create`
   * reads for its optional `permissionMode` — the same two services
   * `session_reconfigure` is wired with. OPTIONAL so a composition that does not
   * hand them over still assembles; the tool fails closed on a mode it cannot
   * verify against the matrix.
   */
  capabilities?: Pick<typeof providerCapabilitiesService, 'getProviderCapabilities'>;
  /**
   * The session-row writer `session_create` records its optional `permissionMode`
   * with, AND the catalog reader it refuses an unselectable `model` with.
   *
   * Both members are declared because both are the model path: the tool reads
   * `assertSelectableModel` to turn an argument typo into `INVALID_ARGUMENT`
   * before the row exists, and it hands the normalized id on to
   * `createAppSession`'s `selection`. Leaving the reader off this Pick would
   * describe a production wiring that skips the guard, which is not what
   * `server/index.ts` hands over (it passes the whole `providerModelsService`).
   */
  models?: Pick<typeof providerModelsService, 'setSessionPermissionMode' | 'assertSelectableModel'>;
};

/**
 * Assembles `session_create`'s deps from the process singletons.
 *
 * The project projection is done HERE — `project_id` is the id AC-246's gate
 * leaves in the `project` argument, `project_path` is the filesystem path
 * `createAppSession` is given, and `title` falls back to the id when a project
 * has no custom name — because the tool's `projects.list()` is asked per call
 * and must reflect the CURRENT active set, not a list captured at assembly
 * time.
 *
 * Consumers: `server/index.ts` (the production assembly) and the AC-278
 * criterion, which hands it the real repository and the real `sessionsService`
 * so it drives the same path.
 */
export function buildSessionCreateDeps(wiring: McpSessionCreateWiring): McpSessionCreateDeps {
  return {
    projects: {
      list: () =>
        wiring.projects.getProjectPaths().map((row) => ({
          id: row.project_id,
          title: row.custom_project_name ?? row.project_id,
          path: row.project_path,
        })),
    },
    sessions: {
      // The `selection` argument is forwarded, not dropped: this adapter is the
      // only thing standing between `session_create`'s validated `model` and the
      // row writer, and a wrapper that named only the first three parameters
      // would silently discard it (the live incident: `args_digest` carried
      // `model`, the row kept `model = NULL`, the first child launched with
      // `--model default` and spent the host account). Every argument the tool
      // states therefore reaches `createAppSession` verbatim.
      create: (provider, projectPath, initialMessage, selection) =>
        wiring.sessions.createAppSession(provider, projectPath, initialMessage, selection),
      switchLifecycle: (provider, sessionId, mode) =>
        wiring.sessions.switchSessionLifecycleMode(provider, sessionId, mode),
    },
    control: wiring.control,
    ...(wiring.capabilities === undefined ? {} : { capabilities: wiring.capabilities }),
    ...(wiring.models === undefined ? {} : { models: wiring.models }),
  };
}

// --------------------------- session_interrupt ---------------------------

/** The production service `session_interrupt` answers from. */
export type McpSessionInterruptWiring = {
  control: McpControlAbortSeam;
};

/**
 * Assembles `session_interrupt`'s deps from the one shared control service.
 *
 * The bag is a single member, and that is the point: interrupting a run is the
 * control service's `abort` verb and nothing else — the adapter holds no host
 * seam, so a resident process survives an interrupt by construction. The
 * builder still exists so the production assembly and the AC-278 criterion
 * reach the same construction path rather than restating the bag in two
 * places.
 *
 * Consumers: `server/index.ts` and the AC-278 criterion.
 */
export function buildSessionInterruptDeps(wiring: McpSessionInterruptWiring): McpSessionInterruptDeps {
  return { control: wiring.control };
}
