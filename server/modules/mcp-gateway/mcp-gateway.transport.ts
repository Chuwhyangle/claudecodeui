import type { Express, RequestHandler } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';

import type { AccessTokensService } from '@/modules/oauth/index.js';
// The cross-module barrel imports below are what make this file the ONE place
// the gateway reaches another module for its own wiring (AC-253): the projects
// readers its read tools answer from, the project-path lookup the by-id session
// projection resolves `projectId` through, and the process run registry its
// `run_get` / `session_send` deps read. Every one goes through the owning
// module's barrel — a deep import would be a boundary violation — and each is
// consumed by {@link createMcpGatewayModule} below.
import {
  getArchivedProjectsWithSessions,
  getProjectSessionsPage,
  getProjectsWithSessions,
} from '@/modules/projects/index.js';
import { projectsDb } from '@/modules/database/index.js';
// The chat-run registry is reached through the shared port, never by importing
// the websocket module: the websocket services import the providers module and
// the gateway is reached from the voice-realtime runtime, so the value import
// that used to stand here was one side of the initialization cycle this task
// removes. `ChatRunLookupResult` stays a TYPE-only import because the deps bag's
// shape is the gateway's own (a type edge creates no evaluation order).
import type { ChatRunLookupResult } from '@/modules/websocket/index.js';
import { readChatRunRegistryPort } from '@/shared/ports/chat-run-registry.port.js';

import type { McpToolInputSchema, McpToolRegistrar } from './mcp-gateway.audit.js';
import { installMcpCallDispatcher, withMcpAudit } from './mcp-gateway.audit.js';
import { createMcpAuthMiddleware, readMcpPrincipal } from './mcp-gateway.auth.js';
import type { McpOauthSeam, McpPrincipal } from './mcp-gateway.auth.js';
import { MCP_GATEWAY_PATH, readMcpGatewayGate } from './mcp-gateway.gate.js';
import { createMcpLoopbackGuard } from './mcp-gateway.loopback.js';
import { registerMcpReadTools } from './mcp-gateway.read-tools.js';
import type { McpReadToolDeps, McpReadToolSeam, McpRunningRun, McpRunSummary } from './mcp-gateway.read-tools.js';
import { registerMcpResidentTools } from './mcp-gateway.resident-tools.js';
import type { McpResidentToolDeps, McpResidentToolSeam } from './mcp-gateway.resident-tools.js';
import { registerMcpWriteTools } from './mcp-gateway.write-tools.js';
import type { McpWriteToolDeps, McpWriteToolSeam } from './mcp-gateway.write-tools.js';
import { resolveInputTargets } from './mcp-resolve-target.js';
import type { McpResolveDeps } from './mcp-resolve-target.js';
import type { McpRunGetDeps } from './mcp-run-get.js';
import type { SelfTargetDeps } from './mcp-self-target.js';
import type { McpSessionRunGetSeam, McpSessionRunRecord } from './mcp-session-send.js';
import { readMcpToolAnnotations } from './mcp-tool-annotations.js';
import { readMcpToolErrorCodes } from './mcp-tool-error-codes.js';
import type { McpWriteNotification } from './mcp-write-notification.js';

/**
 * The MCP gateway's production assembly (AC-240). The consumer is
 * `server/index.ts`, which mounts it BEFORE the static-assets middleware.
 *
 * `/mcp` is a STATELESS Streamable HTTP endpoint: every POST builds its own
 * `StreamableHTTPServerTransport` with no session generator and its own
 * `McpServer`, connects them, and hands the request to the transport. Two
 * consecutive requests from one client are therefore two independent exchanges,
 * neither carrying an `Mcp-Session-Id`. `GET`/`DELETE` answer 405 in JSON-RPC,
 * following the SDK's stateless recipe.
 *
 * Mount ORDER is load-bearing, not cosmetic: mounted after the static layer the
 * SPA catch-all would answer `/mcp` with `200 text/html` and no MCP client would
 * ever reach the transport — which is why the mount call sits before
 * `createStaticAssetsMiddleware` and a criterion scans for that order.
 *
 * The gate decides AT MOUNT TIME. When `MCP_ENABLED` is not truthy nothing is
 * attached — no `app.post`/`app.get`/`app.delete` layer exists at the path — so
 * the path is ABSENT rather than forbidden. `authorize` is a seam: the default
 * refuses every request (fail-closed 401), while supplying `tokens` (and, once
 * OAuth is on, `oauth`) lets this mount build the real AC-241/AC-263 auth
 * middleware in front of the transport.
 */

/** Advertised to MCP clients in the `initialize` handshake. */
const SERVER_INFO = { name: 'claudecodeui-mcp-gateway', version: '0.1.0' };

/**
 * A fresh server per request, the stateless recipe's other half.
 *
 * Which tools it carries is decided here, once per request:
 *
 *  1. an explicit `registerTools` seam wins — the criterion-injected path
 *     AC-244's audit criterion uses to install scripted tools;
 *  2. otherwise, when production deps were supplied, AC-245's read tools are
 *     registered through the SAME audited wrapper (a seam closing over this
 *     request's server and principal), so each read tool inherits its audit row
 *     and its `cloudcli:read` refusal without restating either;
 *  3. otherwise an empty list handler is installed, because the server still has
 *     to answer `tools/list` with a result rather than "method not found"
 *     (AC-240's tools-less mount).
 *
 * The three paths are exclusive: a registered tool installs the SDK's own
 * list/call handlers, which would collide with a second, manual `tools/list`.
 *
 * AC-246's target gate sits INSIDE the audited wrapper and OUTSIDE the tool
 * body (path 2): a `project` / `session` argument is resolved to an id before
 * the read tool's handler runs, and an unresolvable target refuses the call
 * there. The gate is applied only when {@link McpGatewayDeps.resolveDeps} was
 * supplied — an unwired mount keeps AC-240/244/245's exact behaviour, and the
 * write tools AC-249 registers compose the same `resolveInputTargets` wrapper.
 * AC-333 tightens that gate for writes: the wrapper is handed each tool's name,
 * reads `readOnlyHint` from the one annotations table, and refuses a target that
 * only resolves by title substring — a fragment discovers a target, it does not
 * address one for a mutation.
 *
 * Stage-4 write tools (AC-249, extended by AC-250 and AC-251) register through
 * the same seam when {@link McpGatewayDeps.writeTools} is present, so their audit
 * row, scope refusal and target gate are the identical machinery — only the name
 * set and the handlers differ. The write-tools bag flows through unchanged, so
 * AC-250's `sessionCreate` / `sessionInterrupt` members and AC-251's
 * `sessionHostControl` member reach `registerMcpWriteTools` and swap in the real
 * `session_create` / `session_interrupt` / `session_start` / `session_close`
 * handlers; a bag without them keeps the placeholders. An unwired mount registers
 * neither read nor write tools and keeps answering an empty `tools/list`.
 *
 * Stage-6 resident tools (AC-271) register through that same seam when
 * {@link McpGatewayDeps.residentTools} is present. They are a SEPARATE table
 * from the stage-4 write tools — `session_cancel_queued` is not one of the five
 * — so the stage-4 name set AC-249 pins stays exactly five, and the resident
 * bag flows to `registerMcpResidentTools` over the same one control service.
 * The bag's optional members register their own tools alongside the table, gated
 * on being supplied: AC-272's `reconfigure`, AC-273's `background`, and AC-274's
 * `approvals` (`approvals_list` / `approval_answer`). AC-271's criterion pins the
 * table's observable contents, so those tools are registered by
 * `registerMcpResidentTools`, never by growing {@link MCP_STAGE6_RESIDENT_TOOLS}.
 */
function createMcpServer(
  registerTools: McpToolRegistrar | undefined,
  principal: McpPrincipal | null,
  readTools: McpReadToolDeps | undefined,
  writeTools: McpWriteToolDeps | undefined,
  residentTools: McpResidentToolDeps | undefined,
  resolveDeps: McpResolveDeps | undefined,
  selfTarget: SelfTargetDeps | undefined,
  writeNotifications: McpWriteNotification | undefined
): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  if (registerTools) {
    registerTools(server, principal);
    // AC-288: the injected seam registers through `withMcpAudit` too, so the
    // dispatcher is installed here as well — after every tool, never before.
    installMcpCallDispatcher(server);
    return server;
  }
  if (!readTools && !writeTools && !residentTools) {
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    return server;
  }

  /**
   * Applies AC-246's target gate then AC-244's audit wrapper, in that order, to
   * one tool body. Composed once per registration, not per call: the gate closes
   * over the injected entry lists and the tool body, and nothing else.
   *
   * It also attaches the tool's declaration hints from the one
   * `MCP_TOOL_ANNOTATIONS` table (AC1–AC7), keyed by name — so every tool the
   * gateway registers on `tools/list` carries accurate annotations without any
   * of the eight registration seams restating them.
   */
  const audited = (
    name: string,
    description: string | undefined,
    requiredScope: string,
    // AC-288: a raw shape OR a built schema carrying a constraint a raw shape
    // cannot express (a `.min()` / `.max()`, or an object-level `.superRefine`).
    // Either way it is both advertised and enforced by `withMcpAudit`.
    inputSchema: McpToolInputSchema,
    outputSchema: ZodRawShape | undefined,
    handle: (args: Record<string, unknown>) => unknown | Promise<unknown>,
  ): void => {
    // AC-333: the tool NAME rides into the gate so it can derive strictness from
    // the one annotations table — a write tool (`readOnlyHint === false`) refuses
    // a substring-only target. It is read here, off `readMcpToolAnnotations(name)`
    // just below, never kept as a second hand-maintained write-name list.
    const guarded = resolveDeps === undefined ? handle : resolveInputTargets(handle, resolveDeps, name);
    withMcpAudit(
      {
        name,
        description,
        inputSchema,
        outputSchema,
        // Every production tool's declaration hints come from the one table
        // (AC1–AC7). Annotations are metadata only and are attached OUTSIDE the
        // target gate and the scope check, so they cannot alter either.
        annotations: readMcpToolAnnotations(name),
        // AC-285: the tool's declared error-code set comes from the one
        // `MCP_TOOL_ERROR_CODES` table and rides `tools/list` as `_meta`. Like
        // the annotations, it is metadata only — declared OUTSIDE the target gate
        // and the scope check — so it cannot widen or narrow what a caller may do.
        meta: { 'cloudcli/errorCodes': readMcpToolErrorCodes(name) },
        requiredScopes: [requiredScope],
        handler: (args) => guarded(args as Record<string, unknown>),
      },
      // AC-303's notification seam is handed every registration; it classifies
      // each call itself (a read-only tool never notifies), so the write/read
      // split stays in the one annotations table rather than here.
      writeNotifications
    )(server, principal);
  };

  if (readTools) {
    const register: McpReadToolSeam = (registration) =>
      audited(
        registration.name,
        registration.description,
        registration.requiredScope,
        registration.inputSchema,
        registration.outputSchema,
        // The read seam's handler takes an optional caller identity; `ui_selected_text`
        // reads its scopes to decide whether the selection text is delivered or
        // withheld. `withMcpAudit` denies a null principal (and the scope) before
        // this runs, so the value is present here.
        (args) => registration.handler(args, { principal }),
      );
    registerMcpReadTools(register, readTools);
  }

  if (writeTools) {
    const register: McpWriteToolSeam = (registration) =>
      audited(
        registration.name,
        registration.description,
        registration.requiredScope,
        registration.inputSchema,
        registration.outputSchema,
        (args) => {
          if (principal === null) {
            // Unreachable: `withMcpAudit` denies a null principal before the
            // handler is reached. Stated rather than asserted so a future
            // wrapper change fails loudly instead of handing `null` on.
            throw new Error(`${registration.name} requires an authenticated principal.`);
          }
          return registration.handler(args, { principal });
        },
      );
    registerMcpWriteTools(
      register,
      selfTarget === undefined ? writeTools : { ...writeTools, selfTarget: writeTools.selfTarget ?? selfTarget },
    );
  }

  if (residentTools) {
    const register: McpResidentToolSeam = (registration) =>
      audited(
        registration.name,
        registration.description,
        registration.requiredScope,
        registration.inputSchema,
        registration.outputSchema,
        (args) => {
          if (principal === null) {
            // Unreachable: `withMcpAudit` denies a null principal before the
            // handler is reached. Stated rather than asserted so a future
            // wrapper change fails loudly instead of handing `null` on.
            throw new Error(`${registration.name} requires an authenticated principal.`);
          }
          return registration.handler(args, { principal });
        },
      );
    registerMcpResidentTools(register, residentTools);
  }

  // AC-288: replace the SDK's `tools/call` handler with the audited dispatcher,
  // now that every read / write / resident tool is registered. Installed last so
  // the registry is complete; the SDK handler would otherwise answer a bad
  // argument (or an unknown name) with its own text-only sentence.
  installMcpCallDispatcher(server);

  return server;
}

/**
 * Attaches the three `/mcp` methods onto `app`.
 *
 * Middleware order is load-bearing and written down in exactly one place: body
 * parsing (the caller's) -> the loopback guard -> the injected `authorize` -> the
 * transport handler. The guard sits BEFORE authentication so a request it rejects
 * cannot even reach the token check (AC-242 leg (d) reads this off the spy count);
 * a request it admits still has to pass `authorize`.
 */
function attachTransport(
  app: Express,
  authorize: RequestHandler,
  env: NodeJS.ProcessEnv | undefined,
  registerTools: McpToolRegistrar | undefined,
  readTools: McpReadToolDeps | undefined,
  writeTools: McpWriteToolDeps | undefined,
  residentTools: McpResidentToolDeps | undefined,
  resolveDeps: McpResolveDeps | undefined,
  selfTarget: SelfTargetDeps | undefined,
  writeNotifications: McpWriteNotification | undefined
): void {
  const loopbackGuard = createMcpLoopbackGuard(env);

  app.post(MCP_GATEWAY_PATH, loopbackGuard, authorize, async (req, res) => {
    // The principal the auth middleware attached; audited tools are registered
    // per request against it, so the audit row names the invoking token.
    const server = createMcpServer(
      registerTools,
      readMcpPrincipal(res),
      readTools,
      writeTools,
      residentTools,
      resolveDeps,
      selfTarget,
      writeNotifications,
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[MCP] request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  const methodNotAllowed: RequestHandler = (_req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get(MCP_GATEWAY_PATH, loopbackGuard, authorize, methodNotAllowed);
  app.delete(MCP_GATEWAY_PATH, loopbackGuard, authorize, methodNotAllowed);
}

/**
 * The fail-closed default for the `authorize` seam: until AC-241 replaces it, an
 * enabled gateway refuses every request rather than serving unauthenticated MCP
 * traffic.
 */
const refuseUnauthorized: RequestHandler = (_req, res) => {
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
};

/**
 * The seams `mountMcpGateway` reads. Both are injectable so the criterion can
 * (i) read both gate states in one process and (ii) measure the transport alone,
 * without depending on the token/loopback tasks that land later.
 */
export type McpGatewayDeps = {
  /**
   * Environment read by the mount-time gate (`MCP_ENABLED`) AND, per request, by
   * the loopback guard (the MCP OAuth switch). Defaults to `process.env`; the
   * criterion passes two differently-valued objects to read both switch states in
   * one process.
   */
  env?: NodeJS.ProcessEnv;
  /** Auth middleware in front of the transport. Defaults to a fail-closed 401. */
  authorize?: RequestHandler;
  /**
   * The token service the DEFAULT auth middleware verifies `ccp_` tokens through
   * (AC-241). Supplying it — instead of an explicit `authorize` — lets this mount
   * build the real middleware and thread {@link McpGatewayDeps.oauth} into it;
   * `server/index.ts` is the consumer that does so. Absent on a mount that injects
   * its own `authorize` (AC-240/241/244/245's criteria).
   */
  tokens?: AccessTokensService;
  /**
   * The OAuth access-token verification seam (AC-263), threaded into the default
   * auth middleware so `/mcp` accepts `cca_` tokens once OAuth is on. Only read
   * when `tokens` is supplied and `authorize` is not.
   */
  oauth?: McpOauthSeam;
  /**
   * The tool-registration seam (AC-244): called once per request with the
   * request's principal, it installs the gateway's tools. Audited tools come from
   * `withMcpAudit`; AC-245+'s real tools register through this same seam.
   *
   * When it is absent and {@link McpGatewayDeps.readTools} is present, the
   * transport registers AC-245's read tools instead. Supplying both is legal and
   * means "this caller owns the tool set": the explicit seam wins.
   */
  registerTools?: McpToolRegistrar;
  /**
   * The services AC-245's read tools answer from, assembled by the composition
   * root (`server/index.ts`) over the process singletons. Absent on a mount that
   * registers its own tools, and absent is what keeps a tools-less mount
   * (AC-240's criterion) answering an empty `tools/list`.
   */
  readTools?: McpReadToolDeps;
  /**
   * The services AC-249's stage-4 write tools answer from, assembled by the
   * composition root (`server/index.ts`) over the process singletons: the single
   * chat control service the WebSocket gateway and the scheduled timer share
   * (AC-233), the run registry, AC-248's `run_get` builder over its deps, and —
   * AC-250's optional half — the project/session seams `session_create` reads
   * plus the abort seam `session_interrupt` reads — and AC-251's optional
   * `sessionHostControl` (the resident start/close services `session_start` /
   * `session_close` delegate to; production builds it with
   * `createSessionHostControl` over the session-hosts barrel, AC-253).
   *
   * Supplying it registers the five write tools through the SAME audited seam
   * the read tools use, and threads the whole bag (including AC-250's
   * `sessionCreate` / `sessionInterrupt` and AC-251's `sessionHostControl`) to
   * `registerMcpWriteTools`, which installs the real handlers for exactly the
   * tools whose deps are present. Absent keeps the read-only mount AC-245's
   * criterion reads, and a bag without those optional members keeps AC-249's
   * placeholder registration.
   */
  writeTools?: McpWriteToolDeps;
  /**
   * The services the stage-6 resident tools answer from, assembled by the
   * composition root (`server/index.ts`) over the process singletons. AC-271
   * delivers `session_cancel_queued`, whose one dep is the SAME chat control
   * service `writeTools.control` points at (AC-233's single instance) — the
   * resident bag restates only the `cancelQueued` verb it reads, so the gateway
   * still holds one control service, not two. AC-272's `reconfigure` member
   * carries `session_reconfigure`'s services: the provider runtime's
   * `reconfigure` passthrough over the SAME `providerRuntimeService` singleton
   * plus the session/model/capability readers. AC-273's `background` member
   * carries `session_background`'s services: the session reader, AC-245's host
   * snapshot read seam (`sessionHostManager`), and that same one control service
   * (read through its `stopTask` verb).
   *
   * Supplying it registers the stage-6 tools through the SAME audited seam the
   * read and write tools use. Absent keeps a mount that only exercises the
   * stage-3/4 tools (AC-240/244/245/249's criteria) registering exactly what it
   * did before; a bag without `reconfigure` / `background` (AC-271's criterion)
   * keeps the cancel-queued-only registration, so AC-272's and AC-273's tools
   * are each present only when their deps are wired.
   */
  residentTools?: McpResidentToolDeps;
  /**
   * The active project/session entries AC-246's target gate resolves a
   * `project` / `session` argument against. Supplying it turns on the gate for
   * every tool this mount registers: the reference is rewritten to an id before
   * the tool body runs, and an ambiguous or unknown reference refuses the call
   * without entering it.
   *
   * Absent means "no resolution wired here": the mount behaves exactly as it did
   * before AC-246, which is what keeps the AC-240/244/245 criteria — none of
   * which names a target by anything but an id — reading what they always read.
   */
  resolveDeps?: McpResolveDeps;
  /**
   * The self-referential guard's two seams (AC-252): the target session's live
   * turn reader and the gateway write-tool name set. Supplying it overrides both
   * for every write tool this mount registers — the criterion injects a turn
   * reader it controls and its own registry, so legs (a)–(d) exercise the rule
   * with no real Claude run and no registry edit. Absent keeps each write tool's
   * production default (`readSessionTurn` over `MCP_STAGE4_WRITE_TOOLS`' names),
   * which is the behaviour every criterion before AC-252 already saw because a
   * tool-less turn reads as `idle`. Read tools and the unprotected write tools
   * (`session_start` / `session_create`) are never refused.
   */
  selfTarget?: SelfTargetDeps;
  /**
   * AC-303's write-call notification seam. When supplied, every tool this mount
   * registers is wrapped with it, and a SUCCESSFUL call to a write tool
   * (`readOnlyHint === false`) notifies the token's owner through it. The seam
   * classifies read-only tools itself, so it is safe to hand it every
   * registration. Absent keeps a mount that never notifies — every criterion
   * before AC-303 — behaving exactly as it did; `server/index.ts` supplies the
   * production assembly built by `createMcpWriteNotification`.
   */
  writeNotifications?: McpWriteNotification;
};

/** Whether the gateway attached anything, and the gate's own reason. */
export type McpGatewayReading = {
  mounted: boolean;
  reason: string;
};

/**
 * Mounts the stateless `/mcp` endpoint, or attaches nothing at all.
 *
 * Returns the decision so the entrypoint can log it. The attach is SKIPPED — not
 * guarded downstream — when the gate is closed: nothing is added to the
 * application's middleware stack, so the path has no layer to reach and the
 * static catch-all below (or Express's own 404) answers instead.
 */
export function mountMcpGateway(app: Express, deps: McpGatewayDeps = {}): McpGatewayReading {
  const gate = readMcpGatewayGate(deps.env);
  if (!gate.enabled) {
    return { mounted: false, reason: gate.reason };
  }

  attachTransport(
    app,
    deps.authorize ?? buildDefaultAuthorize(deps),
    deps.env,
    deps.registerTools,
    deps.readTools,
    deps.writeTools,
    deps.residentTools,
    deps.resolveDeps,
    deps.selfTarget,
    deps.writeNotifications
  );
  return { mounted: true, reason: gate.reason };
}

/**
 * The inputs {@link createMcpGatewayModule} accepts from the composition root
 * (`server/index.ts`). It is {@link McpGatewayDeps} minus the members this
 * module itself derives from the owning modules' barrels, plus the one control
 * service the caller MUST hand in (so it can be the same identifier the
 * WebSocket gateway and the scheduled-message timer share).
 *
 * `control` is required, not optional: the whole point of this entry is that
 * the gateway never constructs its own control plane. A criteria mount that
 * wants a mount without write tools can still pass deps straight to
 * {@link mountMcpGateway} — this assembler is for the production composition
 * root, where every front end must share one instance (AC-253).
 */
export type McpGatewayModuleDeps = {
  env?: McpGatewayDeps['env'];
  authorize?: McpGatewayDeps['authorize'];
  tokens?: McpGatewayDeps['tokens'];
  oauth?: McpGatewayDeps['oauth'];
  resolveDeps?: McpGatewayDeps['resolveDeps'];
  selfTarget?: McpGatewayDeps['selfTarget'];
  residentTools?: McpGatewayDeps['residentTools'];
  /** AC-303's write-call notification seam; flows straight through to the mount. */
  writeNotifications?: McpGatewayDeps['writeNotifications'];
  /** The single chat control service every front end shares (AC-233/AC-253). */
  control: McpWriteToolDeps['control'];
  /**
   * AC-245's read-tool services minus what this module supplies: the whole
   * `projects` bag (the three readers plus the by-id `projectId` path lookup)
   * and the run registry come from the barrel imports above. `runGet` is
   * AC-248's bag minus its `runs` member, which is likewise filled here from
   * the single process registry.
   */
  readTools?: Omit<McpReadToolDeps, 'projects' | 'runs' | 'runGet'> & {
    runGet?: Omit<McpRunGetDeps, 'runs'>;
  };
  /**
   * AC-249's write-tool services. `control` is supplied as a top-level member,
   * and `runs` / `runGet.deps.runs` are filled here from the process registry,
   * so the caller cannot accidentally point the gateway at a second one.
   */
  writeTools: Omit<McpWriteToolDeps, 'control' | 'runs' | 'runGet'> & {
    runGet: Omit<McpSessionRunGetSeam, 'deps'> & { deps: Omit<McpRunGetDeps, 'runs'> };
  };
};

/**
 * The gateway's composition entry (AC-253): it takes the pieces only the
 * composition root can supply — above all the one {@link McpGatewayModuleDeps.control}
 * instance — and fills the rest of {@link McpGatewayDeps} from the owning
 * modules' barrels, so `server/index.ts` reads as "one control service, handed
 * to every front end" rather than as a bag of imports.
 *
 * It RETURNS a deps object rather than mounting, because AC-240's frozen
 * criterion requires `server/index.ts` to contain the `mountMcpGateway(...)`
 * call it scans for. The production line is therefore
 * `mountMcpGateway(app, createMcpGatewayModule({ control: chatControl, ... }))`:
 * `mountMcpGateway` keeps its name and semantics, and the same `chatControl`
 * identifier appears in the `createMcpGatewayModule` argument — the reading
 * AC-253(a) takes.
 *
 * Consumers: `server/index.ts`. A criterion that wants the SOURCE-level wiring
 * reads this function's name off `server/index.ts`; a criterion that wants the
 * runtime behaviour supplies the same assembled deps to `mountMcpGateway`.
 */
export function createMcpGatewayModule(deps: McpGatewayModuleDeps): McpGatewayDeps {
  const { control, readTools, writeTools, ...rest } = deps;
  // The process run registry, read through the shared port. A mount that has not
  // loaded the websocket module (a focused transport criterion) gets the
  // documented degradation: every by-id read is an unknown-run miss and the
  // session-addressed reader holds no run. Production always installs the real
  // registry — `chat-run-registry.service.ts` at module load and `server/index.ts`
  // in the composition root — so the fallback never speaks for the product.
  const runs = readChatRunRegistryPort<
    McpSessionRunRecord,
    ChatRunLookupResult,
    McpRunningRun,
    McpRunSummary
  >({
    getRun: () => undefined,
    listRunningRuns: () => [],
    getRunById: () => ({ status: 'unknown', reason: 'unknown' }),
    getRunBootId: () => null,
  });
  return {
    ...rest,
    readTools:
      readTools === undefined
        ? undefined
        : {
            ...readTools,
            // The module OWNS the projects bag so the gateway's project readers
            // come from exactly one place; the three readers plus the path
            // lookup below are that whole bag. `getProjectIdByPath` is not
            // optional here: `toSessionRow` resolves a by-id session's
            // `projectId` through it, and replacing the bag without it made
            // every by-id `session_get` read `projectId: null`
            // (gap-mcp-session-get-projectid-null-under-production-gateway-
            // assembly). It is computed the same way `server/index.ts` computes
            // it — through the database barrel's `projectsDb`, never a deep
            // import — so the two projections cannot disagree.
            projects: {
              getProjectsWithSessions,
              getArchivedProjectsWithSessions,
              getProjectSessionsPage,
              getProjectIdByPath: (projectPath: string) =>
                projectsDb.getProjectPath(projectPath)?.project_id ?? null,
            },
            runs,
            // `changes` (AC-335) rides through the spread above untouched: its
            // whole deps bag is built in `server/index.ts` and this module
            // overlays NONE of it, so the ascending `(updatedAt, sessionId)`
            // keyset session reader (AC-347), the run registry, the approval
            // lookup and the Quay CACHE the tool reads are exactly the ones the
            // composition root assembled. It is stated here only so the day
            // someone adds an override above, it is obvious this bag was
            // deliberately left whole — the same way the `projects` override two
            // properties up is deliberately whole.
            runGet:
              readTools.runGet === undefined ? undefined : { ...readTools.runGet, runs },
          },
    writeTools: {
      ...writeTools,
      control,
      // AC-337: the SAME process registry the read bag above is handed, handed
      // WHOLE. Narrowing it to `{ getRun }` was enough while the only verb a
      // write tool had was a read — but `session_send` / `session_create` now
      // STAMP their optional `correlationId` onto the run they opened through
      // this seam, and a projected `{ getRun }` object silently drops that call,
      // leaving `sessions_list`'s filter empty on the real service while every
      // harness that hand-wrote an adapter stayed green. Handing the registry
      // over keeps the module's promise — the caller still cannot point the
      // gateway at a second one — and gives the stamp the same object the reader
      // sees. (It works only because `McpRunReader` names that member exactly as
      // the registry does; the optional-member trap is recorded there.)
      runs,
      runGet: { ...writeTools.runGet, deps: { ...writeTools.runGet.deps, runs } },
    },
  };
}

/**
 * The `authorize` middleware when the caller did not inject one: the real
 * AC-241/AC-263 middleware over the supplied token service (and OAuth seam), or
 * the fail-closed default when no token service was supplied. Consumers:
 * `mountMcpGateway`; `server/index.ts` relies on this path while the criteria
 * inject their own `authorize`.
 */
function buildDefaultAuthorize(deps: McpGatewayDeps): RequestHandler {
  if (deps.tokens === undefined) {
    return refuseUnauthorized;
  }
  return createMcpAuthMiddleware({ tokens: deps.tokens, oauth: deps.oauth, env: deps.env });
}
