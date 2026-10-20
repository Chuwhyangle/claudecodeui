/**
 * AC-253 criterion — the gateway's assembly and the cross-module barrel audit.
 *
 * The claim has three independent readings:
 *
 *   (a) a pure TypeScript syntax-tree scan of `server/index.ts` finds
 *       `createChatControlService(` exactly ONCE, takes the identifier it is
 *       bound to (`chatControl`), and proves that identifier reaches all three
 *       consumers — `createWebSocketServer`, `initializeScheduledMessageDispatcher`
 *       and `createMcpGatewayModule`. Two synthetic positive controls show the
 *       scanner is not an always-true: a second `createChatControlService(` is
 *       reported with both lines, and an identifier moved out of the
 *       `createMcpGatewayModule` argument is reported missing.
 *
 *   (b) a barrel audit over the three module barrels asserts the four declared
 *       GOAL-020 symbols are exported and consumed by the gateway through a
 *       public seam (never a deep path): `getProjectSessionsPage` from projects,
 *       `startResidentHost` / `closeResidentHost` from session-hosts, and
 *       `getRunById` — landed as the `chatRunRegistry` member AC-248 already
 *       consumes, so per AC-253's own escape clause it is NOT re-exported under a
 *       second name; the audit proves the registry reaches the gateway and is
 *       read through `.getRunById(`. The registry seam is the shared
 *       `chat-run-registry` port (`readChatRunRegistryPort`, installed by the
 *       websocket service and the composition root): the gateway no longer
 *       imports the websocket module's value, which is what removes the edge
 *       from the server initialization cycle, while the websocket barrel
 *       remains the registry's owner and exporter. A synthetic unconsumed
 *       export (fed as a mutated barrel source) is reported by name.
 *
 *   (c) a same-instance spy: ONE real `ChatControlService`, wrapped so every
 *       `send` records its caller and bumps one counter, is handed to the
 *       WebSocket chat handler, to the scheduled-message dispatch entry, and to
 *       `createMcpGatewayModule`. A real express 4 app + real better-sqlite3
 *       temp DB + owner user + real access token + MCP SDK `Client` over
 *       `StreamableHTTPClientTransport` (with a `node:http`-based `fetch`, to
 *       avoid the `listen(0)` undici bad-port lottery) + debug-agent sessions
 *       drive one send per front end; the single spy reads +3 with
 *       `caller.via` = websocket / scheduled / mcp, and each of the three runIds
 *       is readable from the same `chatRunRegistry`.
 *
 * The debug agent's gate is read once per process at module load, so this file
 * has no static application imports: it opens `DEBUG_AGENT` and redirects `HOME`
 * into a scratch directory before any aliased module is pulled in.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import ts from 'typescript';

import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';

const GATE_VAR = 'DEBUG_AGENT';
const GATE_HOME_VAR = 'DEBUG_AGENT_HOME';

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'mcp-gateway-wiring-'));
const SCRATCH_HOME = path.join(SCRATCH, 'home');
const FIXTURE_HOME = path.join(SCRATCH, 'fixture');
process.env.HOME = SCRATCH_HOME;
process.env[GATE_VAR] = 'on';
process.env[GATE_HOME_VAR] = FIXTURE_HOME;
process.env.JWT_SECRET = 'mcp-gateway-wiring-test-secret';
delete process.env.VITE_IS_PLATFORM;
mkdirSync(SCRATCH_HOME, { recursive: true });
mkdirSync(FIXTURE_HOME, { recursive: true });

const { closeConnection, getConnection, initializeDatabase, scheduledMessagesDb, sessionsDb } = await import(
  '@/modules/database/index.js'
);
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const { createProviderRuntimeService, providerRegistry } = await import('@/modules/providers/index.js');
const { createSessionHostManager } = await import('@/modules/session-hosts/index.js');
const { dispatchDueScheduledMessages } = await import('@/modules/scheduled-messages/index.js');
const {
  BOOT_ID,
  chatRunRegistry,
  connectedClients,
  createChatControlService,
  handleChatConnection,
} = await import('@/modules/websocket/index.js');
const { DEBUG_AGENT_PROVIDER_ID, armDebugAgentScenario } = await import('@/modules/debug-agent/index.js');
const { MCP_GATEWAY_PATH, buildRunGet, createMcpAuthMiddleware, createMcpGatewayModule, mountMcpGateway } = await import(
  '../index.js'
);

type AnyRecord = Record<string, unknown>;
type ChatControlService = ReturnType<typeof createChatControlService>;

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`gateway-wiring ${line}`);
}

// =====================================================================
// (a) the single-control-service wiring scanner
// =====================================================================

const CONSTRUCTOR = 'createChatControlService';
const CONSUMERS = ['createWebSocketServer', 'initializeScheduledMessageDispatcher', 'createMcpGatewayModule'] as const;

export type ConsumerHits = { websocket: boolean; scheduled: boolean; gateway: boolean };

export type WiringReading = {
  /** How many `createChatControlService(` call expressions the source contains. */
  constructCount: number;
  /** 1-based lines of each constructor call, in source order. */
  constructLines: number[];
  /** The identifier each constructor call is bound to (`const X = createChatControlService(...)`), or null. */
  constructBindings: (string | null)[];
  /** The single bound identifier when `constructCount === 1`, else null. */
  identifier: string | null;
  /** Whether that identifier appears as an argument of each named consumer call. */
  consumers: ConsumerHits;
};

type Located = { call: ts.CallExpression; line: number; binding: string | null };

/**
 * A PURE syntax-tree read over its argument: it does not import `server/index.ts`
 * (importing the entrypoint would run the whole process). It finds every
 * `createChatControlService(` call, takes the identifier it is bound to, and
 * checks that identifier appears (recursively, so nesting inside object
 * literals counts) among the arguments of each consumer call.
 */
export function scanSingleControlServiceWiring(source: string): WiringReading {
  const sourceFile = ts.createSourceFile('wiring.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

  const constructors: Located[] = [];

  const bindingOf = (call: ts.CallExpression): string | null => {
    const parent = call.parent;
    if (
      parent !== undefined &&
      ts.isVariableDeclaration(parent) &&
      parent.initializer === call &&
      ts.isIdentifier(parent.name)
    ) {
      return parent.name.text;
    }
    return null;
  };

  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === CONSTRUCTOR) {
        constructors.push({ call: node, line: lineOf(node), binding: bindingOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const identifier = constructors.length === 1 ? constructors[0].binding : null;

  /** True when `wanted` appears as an Identifier anywhere inside `node`'s subtree. */
  const subtreeHasIdentifier = (node: ts.Node, wanted: string): boolean => {
    if (ts.isIdentifier(node) && node.text === wanted) {
      return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && subtreeHasIdentifier(child, wanted)) {
        found = true;
      }
    });
    return found;
  };

  /** Whether a consumer call exists AND takes the single identifier as an argument. */
  const consumerHit = (name: string): boolean => {
    if (identifier === null) {
      return false;
    }
    let hit = false;
    const search = (node: ts.Node): void => {
      if (
        !hit &&
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === name &&
        node.arguments.some((argument) => subtreeHasIdentifier(argument, identifier))
      ) {
        hit = true;
        return;
      }
      ts.forEachChild(node, search);
    };
    search(sourceFile);
    return hit;
  };

  return {
    constructCount: constructors.length,
    constructLines: constructors.map((entry) => entry.line),
    constructBindings: constructors.map((entry) => entry.binding),
    identifier,
    consumers: {
      websocket: consumerHit(CONSUMERS[0]),
      scheduled: consumerHit(CONSUMERS[1]),
      gateway: consumerHit(CONSUMERS[2]),
    },
  };
}

// --------------------------- (a) positive controls ---------------------------

/** A synthetic entrypoint with TWO constructors — the scanner must see both. */
const TWO_CONSTRUCTORS_SOURCE = [
  "import { createChatControlService } from '@/modules/websocket/index.js';",
  "import { createWebSocketServer } from '@/modules/websocket/index.js';",
  "import { initializeScheduledMessageDispatcher } from '@/modules/scheduled-messages/index.js';",
  "import { createMcpGatewayModule } from '@/modules/mcp-gateway/index.js';",
  'const chatControl = createChatControlService({ runtime });',
  'const chatControlSecond = createChatControlService({ runtime });',
  'createWebSocketServer(server, { chat: { control: chatControl } });',
  'initializeScheduledMessageDispatcher(chatControl);',
  'mountMcpGateway(app, createMcpGatewayModule({ control: chatControl }));',
].join('\n');

/**
 * A synthetic entrypoint that still constructs ONCE and binds `chatControl`, but
 * hands the gateway a DIFFERENT identifier — so the single-constructor reading
 * survives and only the gateway consumer goes false.
 */
const MOVED_IDENTIFIER_SOURCE = [
  "import { createChatControlService } from '@/modules/websocket/index.js';",
  'const chatControl = createChatControlService({ runtime });',
  'createWebSocketServer(server, { chat: { control: chatControl } });',
  'initializeScheduledMessageDispatcher(chatControl);',
  'mountMcpGateway(app, createMcpGatewayModule({ control: someOtherControl }));',
].join('\n');

test('(a) server/index.ts constructs one control service and hands the same identifier to all three consumers', () => {
  const indexSource = readFileSync(fileURLToPath(new URL('../../../index.ts', import.meta.url)), 'utf8');
  const real = scanSingleControlServiceWiring(indexSource);

  const twice = scanSingleControlServiceWiring(TWO_CONSTRUCTORS_SOURCE);
  const moved = scanSingleControlServiceWiring(MOVED_IDENTIFIER_SOURCE);

  say(`(a) real.constructCount=${real.constructCount} lines=${JSON.stringify(real.constructLines)}`);
  say(`(a) real.identifier=${JSON.stringify(real.identifier)} consumers=${JSON.stringify(real.consumers)}`);
  say(`(a) two.constructCount=${twice.constructCount} lines=${JSON.stringify(twice.constructLines)} bindings=${JSON.stringify(twice.constructBindings)}`);
  say(`(a) moved.consumers=${JSON.stringify(moved.consumers)} identifier=${JSON.stringify(moved.identifier)}`);

  // The real reading: exactly one constructor, one identifier, three consumers.
  assert.equal(real.constructCount, 1, 'server/index.ts must construct the chat control service exactly once');
  assert.equal(real.identifier, 'chatControl', 'the constructor must be bound to `chatControl`');
  assert.equal(real.consumers.websocket, true, '`chatControl` must be an argument of createWebSocketServer');
  assert.equal(real.consumers.scheduled, true, '`chatControl` must be an argument of initializeScheduledMessageDispatcher');
  assert.equal(real.consumers.gateway, true, '`chatControl` must be an argument of createMcpGatewayModule');

  // Positive control 1: a second constructor is seen, and both lines are reported.
  assert.equal(twice.constructCount, 2, 'the scanner must see BOTH synthetic constructor calls');
  assert.equal(twice.constructLines.length, 2, 'both constructor lines must be reported');
  assert.notEqual(twice.constructLines[0], twice.constructLines[1], 'the two constructors are on different lines');

  // Positive control 2: the identifier moved out of the gateway argument is reported missing.
  assert.equal(moved.identifier, 'chatControl', 'the moved source still binds `chatControl` once');
  assert.equal(moved.consumers.gateway, false, 'a gateway call without `chatControl` must be reported missing');
  assert.equal(moved.consumers.websocket, true, 'the moved source still reaches the WebSocket consumer');
});

// =====================================================================
// (b) the cross-module barrel audit
// =====================================================================

type GatewayImport = { specifier: string; names: string[]; line: string };

export type BarrelAuditReading = {
  exports: {
    sessionHostsStart: boolean;
    sessionHostsClose: boolean;
    projectsSessionsPage: boolean;
    websocketGetRunById: 'named' | 'registry' | 'missing';
    summaryTypesPresent: boolean;
  };
  gateway: {
    projectsBarrelImport: boolean;
    websocketBarrelImport: boolean;
    sessionHostsBarrelImport: boolean;
    getRunByIdCallOnRegistry: boolean;
    deepImports: string[];
  };
  unconsumed: string[];
};

const MODULE_RE = /^@\/modules\/([\w-]+)\/(.*)$/;

/**
 * A `type Alias = A | B | C` declaration's constituent type names. Used to treat
 * the members of a consumed union as consumed: `ChatRunLookupResult` is the
 * gateway's imported vocabulary entry, and `ChatRunSummary` / `ChatRunLookupMiss`
 * are its constituents — part of the same contract, not dead exports.
 */
export function unionMembers(source: string, aliasName: string): string[] {
  const sourceFile = ts.createSourceFile('union.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const members: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === aliasName &&
      ts.isUnionTypeNode(statement.type)
    ) {
      for (const member of statement.type.types) {
        if (ts.isTypeReferenceNode(member) && ts.isIdentifier(member.typeName)) {
          members.push(member.typeName.text);
        }
      }
    }
  }
  return members;
}

/** Every name a barrel source exports (named re-exports AND declared exports). */
export function barrelExportNames(source: string): Set<string> {
  const sourceFile = ts.createSourceFile('barrel.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const names = new Set<string>();

  const hasExport = (node: ts.Node): boolean =>
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false;

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        names.add(element.name.text);
      }
    } else if (ts.isVariableStatement(statement) && hasExport(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text);
        }
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      hasExport(statement) &&
      statement.name !== undefined
    ) {
      names.add(statement.name.text);
    }
  }
  return names;
}

/** Every import this source makes: specifier plus the named bindings it pulls. */
function collectImports(source: string): GatewayImport[] {
  const sourceFile = ts.createSourceFile('imports.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const imports: GatewayImport[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const names: string[] = [];
    const clause = statement.importClause;
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        names.push(element.name.text);
      }
    }
    imports.push({
      specifier,
      names,
      line: statement.getText(sourceFile).split('\n').join(' '),
    });
  }
  return imports;
}

/**
 * A PURE audit over barrel sources and the sources that import them. The same
 * function grades the real tree and the synthetic negative control, so a green
 * reading is discriminating power, not a scanner that always answers clean.
 */
export function auditBarrelConsumers(input: {
  barrels: { websocket: string; sessionHosts: string; projects: string };
  sources: { path: string; source: string; kind: 'gateway' | 'root' }[];
  declaredNewExports: string[];
  unionSources?: string[];
}): BarrelAuditReading {
  const websocketNames = barrelExportNames(input.barrels.websocket);
  const sessionHostNames = barrelExportNames(input.barrels.sessionHosts);
  const projectNames = barrelExportNames(input.barrels.projects);

  const gatewayImports: GatewayImport[] = [];
  const consumedNames = new Set<string>();
  const deepImports: string[] = [];
  let gatewayHasGetRunByIdCall = false;

  for (const file of input.sources) {
    const imports = collectImports(file.source);
    for (const entry of imports) {
      const match = MODULE_RE.exec(entry.specifier);
      if (match) {
        const moduleName = match[1];
        const rest = match[2];
        const isBarrel = rest === 'index.js';
        // A cross-module deep path (another module's internals, not its barrel).
        if (file.kind === 'gateway' && moduleName !== 'mcp-gateway' && !isBarrel) {
          deepImports.push(`${file.path} -> ${entry.specifier}`);
        }
      }
      for (const name of entry.names) {
        consumedNames.add(name);
      }
      if (file.kind === 'gateway') {
        gatewayImports.push(entry);
      }
    }
    if (file.kind === 'gateway' && /\.getRunById\s*\(/.test(file.source)) {
      gatewayHasGetRunByIdCall = true;
    }
  }

  const gatewayImportsFrom = (moduleName: string): Set<string> => {
    const names = new Set<string>();
    for (const entry of gatewayImports) {
      const match = MODULE_RE.exec(entry.specifier);
      if (match && match[1] === moduleName && match[2] === 'index.js') {
        for (const name of entry.names) {
          names.add(name);
        }
      }
    }
    return names;
  };

  const websocketConsumed = gatewayImportsFrom('websocket');
  const sessionHostConsumed = gatewayImportsFrom('session-hosts');
  const projectConsumed = gatewayImportsFrom('projects');
  // The registry seam moved to the shared port layer
  // (`gap-server-provider-websocket-init-cycle-ports`): the gateway now reads
  // the process registry through `readChatRunRegistryPort` instead of importing
  // the websocket module, which removes the `mcp-gateway -> websocket` value
  // edge that sat inside the server initialization cycle. The websocket barrel
  // still OWNS and exports `chatRunRegistry`; the port is the public way the
  // gateway reaches it, so both forms satisfy the GOAL-020 consumption claim.
  const gatewayConsumesRegistryPort = gatewayImports.some(
    (entry) =>
      entry.specifier === '@/shared/ports/chat-run-registry.port.js' &&
      entry.names.includes('readChatRunRegistryPort'),
  );

  // `getRunById`'s declared export, per SPEC §223, landed as `chatRunRegistry`
  // (AC-248 already consumes the registry's `getRunById` method), so the escape
  // clause says: do not duplicate it under a second name. It counts as exported
  // when the barrel carries the named form OR the registry the gateway reads —
  // through the websocket barrel or through the shared registry port.
  const websocketGetRunById: BarrelAuditReading['exports']['websocketGetRunById'] = websocketNames.has('getRunById')
    ? 'named'
    : websocketNames.has('chatRunRegistry') &&
        (websocketConsumed.has('chatRunRegistry') || gatewayConsumesRegistryPort) &&
        gatewayHasGetRunByIdCall
      ? 'registry'
      : 'missing';

  const specialConsumed = (name: string): boolean => name === 'getRunById' && websocketGetRunById === 'registry';

  // A type alias landed as a union is ONE exported contract: consuming its anchor
  // (`ChatRunLookupResult`) consumes its constituents, so the constituent names
  // are not read as unconsumed GOAL-020 exports.
  for (const unionSource of input.unionSources ?? []) {
    for (const alias of [...consumedNames]) {
      for (const member of unionMembers(unionSource, alias)) {
        consumedNames.add(member);
      }
    }
  }

  const exportedBySomeBarrel = (name: string): boolean =>
    websocketNames.has(name) || sessionHostNames.has(name) || projectNames.has(name);

  const unconsumed = input.declaredNewExports.filter(
    (name) => exportedBySomeBarrel(name) && !consumedNames.has(name) && !specialConsumed(name),
  );

  return {
    exports: {
      sessionHostsStart: sessionHostNames.has('startResidentHost'),
      sessionHostsClose: sessionHostNames.has('closeResidentHost'),
      projectsSessionsPage: projectNames.has('getProjectSessionsPage'),
      websocketGetRunById,
      summaryTypesPresent: ['ChatRunSummary', 'ChatRunLookupMiss', 'ChatRunLookupResult'].every((name) =>
        websocketNames.has(name),
      ),
    },
    gateway: {
      projectsBarrelImport: projectConsumed.has('getProjectSessionsPage'),
      websocketBarrelImport: websocketConsumed.has('chatRunRegistry') || gatewayConsumesRegistryPort,
      sessionHostsBarrelImport: sessionHostConsumed.has('startResidentHost') && sessionHostConsumed.has('closeResidentHost'),
      getRunByIdCallOnRegistry: gatewayHasGetRunByIdCall,
      deepImports,
    },
    unconsumed,
  };
}

const DECLARED_NEW_EXPORTS = [
  'createChatControlService',
  'getRunById',
  'getProjectSessionsPage',
  'startResidentHost',
  'closeResidentHost',
  'ChatRunSummary',
  'ChatRunLookupMiss',
  'ChatRunLookupResult',
];

test('(b) the three barrels export the GOAL-020 symbols and the gateway consumes each through a barrel', () => {
  const testsDir = fileURLToPath(new URL('.', import.meta.url));
  const gatewayDir = path.resolve(testsDir, '..');

  const barrels = {
    websocket: readFileSync(path.resolve(testsDir, '../../websocket/index.ts'), 'utf8'),
    sessionHosts: readFileSync(path.resolve(testsDir, '../../session-hosts/index.ts'), 'utf8'),
    projects: readFileSync(path.resolve(testsDir, '../../projects/index.ts'), 'utf8'),
  };

  const gatewayFiles = readdirSync(gatewayDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
  const sources: { path: string; source: string; kind: 'gateway' | 'root' }[] = gatewayFiles.map((name) => ({
    path: `server/modules/mcp-gateway/${name}`,
    source: readFileSync(path.join(gatewayDir, name), 'utf8'),
    kind: 'gateway' as const,
  }));
  sources.push({
    path: 'server/index.ts',
    source: readFileSync(path.resolve(testsDir, '../../../index.ts'), 'utf8'),
    kind: 'root',
  });

  const unionSources = [readFileSync(path.resolve(testsDir, '../../websocket/services/chat-run-registry.service.ts'), 'utf8')];

  const audit = auditBarrelConsumers({ barrels, sources, declaredNewExports: DECLARED_NEW_EXPORTS, unionSources });

  // The literal import lines the consumers are reached through.
  const importLines: string[] = [];
  for (const file of sources) {
    for (const entry of collectImports(file.source)) {
      const match = MODULE_RE.exec(entry.specifier);
      if (match && match[2] === 'index.js' && ['websocket', 'projects', 'session-hosts', 'mcp-gateway'].includes(match[1])) {
        importLines.push(`${file.path}: ${entry.line}`);
      }
    }
  }

  say(`(b) exports=${JSON.stringify(audit.exports)}`);
  say(`(b) gateway=${JSON.stringify(audit.gateway)}`);
  say(`(b) unconsumed=${JSON.stringify(audit.unconsumed)}`);
  say(`(b) barrelImportLines=${JSON.stringify(importLines)}`);

  // The four declared symbols: three named exports plus getRunById's landed form.
  assert.equal(audit.exports.sessionHostsStart, true, 'session-hosts barrel must export startResidentHost');
  assert.equal(audit.exports.sessionHostsClose, true, 'session-hosts barrel must export closeResidentHost');
  assert.equal(audit.exports.projectsSessionsPage, true, 'projects barrel must export getProjectSessionsPage');
  assert.notEqual(audit.exports.websocketGetRunById, 'missing', 'getRunById must be reachable through the websocket barrel');
  assert.equal(audit.exports.summaryTypesPresent, true, 'the run-summary vocabulary must be exported from the websocket barrel');

  // The gateway reaches each through a barrel and reads the registry's getRunById.
  assert.equal(audit.gateway.projectsBarrelImport, true, 'the gateway must import getProjectSessionsPage via the projects barrel');
  assert.equal(
    audit.gateway.websocketBarrelImport,
    true,
    'the gateway must reach chatRunRegistry via the websocket barrel or the shared registry port',
  );
  assert.equal(audit.gateway.sessionHostsBarrelImport, true, 'the gateway must import start/closeResidentHost via the session-hosts barrel');
  assert.equal(
    audit.gateway.getRunByIdCallOnRegistry,
    true,
    'the gateway must read getRunById off the registry it reaches through the port',
  );
  assert.deepEqual(audit.gateway.deepImports, [], 'no gateway cross-module import may take a deep path');

  // No declared GOAL-020 export sits unconsumed in a barrel.
  assert.deepEqual(audit.unconsumed, [], 'no declared GOAL-020 export may lack a consumer');

  // ---- the negative control: the SAME audit over a barrel with an unused export ----
  const mutatedWebsocket = `${barrels.websocket}\nexport const ac253UnconsumedProbe = 1;\n`;
  const negative = auditBarrelConsumers({
    barrels: { ...barrels, websocket: mutatedWebsocket },
    sources,
    declaredNewExports: [...DECLARED_NEW_EXPORTS, 'ac253UnconsumedProbe'],
    unionSources,
  });
  say(`(b) negative.unconsumed=${JSON.stringify(negative.unconsumed)}`);
  assert.deepEqual(
    negative.unconsumed,
    ['ac253UnconsumedProbe'],
    'a barrel export with no consumer must be reported by name',
  );
});

// =====================================================================
// (c) the same-instance spy across all three front ends
// =====================================================================

const USER_ONE = 1;
const DEBUG_PROVIDER = DEBUG_AGENT_PROVIDER_ID as LLMProvider;
const WRITE_SCOPE = 'cloudcli:session:send';
const READ_SCOPE = 'cloudcli:read';
const RUN_ALIVE_MS = 1_200;

type SpyCaller = { userId: string | number | null; via: string };
type SpyControl = {
  counts: { send: number };
  callers: SpyCaller[];
  control: ChatControlService;
};

/** Wraps the real service so every send records its caller and bumps ONE counter. */
function wrapControl(real: ChatControlService): SpyControl {
  const counts = { send: 0 };
  const callers: SpyCaller[] = [];
  const control = {
    ...real,
    send: async (...args: Parameters<ChatControlService['send']>) => {
      counts.send += 1;
      callers.push({ userId: args[0].userId, via: args[0].via });
      return real.send(...args);
    },
  };
  return { counts, callers, control };
}

const nodeFetch: FetchLike = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const target = new URL(String(url));
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    const body = init?.body === undefined || init?.body === null ? null : String(init.body);

    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              responseHeaders.set(key, value);
            } else if (Array.isArray(value)) {
              for (const entry of value) {
                responseHeaders.append(key, entry);
              }
            }
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: responseHeaders }));
        });
      },
    );
    request.on('error', reject);
    if (body !== null) {
      request.write(body);
    }
    request.end();
  });

type FakeSocket = EventEmitter & {
  readyState: number;
  frames: AnyRecord[];
  send(data: string): void;
};

function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => {
    try {
      socket.frames.push(JSON.parse(data) as AnyRecord);
    } catch {
      socket.frames.push({ raw: data });
    }
  };
  return socket;
}

function aliveScenario(label: string) {
  return {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: { title: `ac253 ${label}`, userText: `first round for ${label}`, lifecycleMode: 'per-run' as const },
    steps: [{ at: RUN_ALIVE_MS, op: 'row', role: 'assistant', text: `${label} round finished` }],
    expect: { rows: { delta: 1 }, content: { mustContain: [`${label} round finished`] } },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('(c) the WebSocket, scheduled and MCP front ends reach one control-service instance', { concurrency: false }, async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(SCRATCH, 'arm-'));
  const clock = { value: Date.now() };
  let server: http.Server | undefined;
  // When the last front end ran, so teardown lets each run's walk finish before
  // the transcript directory is removed (a walk still writing after `rm` recreates
  // a one-row artifact and makes the debug scenario report a spurious row delta).
  let lastSendAt = 0;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'wiring.db');
    await initializeDatabase();
    getConnection()
      .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(USER_ONE, 'owner', 'hash');

    const debugProvider = providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID);
    const hostDriver = debugProvider.hostDriver;
    assert.ok(hostDriver, 'the debug provider must carry a host driver (the gate is open)');

    const arm = async (label: string): Promise<string> => {
      const armed = await armDebugAgentScenario({
        projectPath: path.join(tempDirectory, label),
        scenario: aliveScenario(label),
        synchronizeTranscript: (filePath) => debugProvider.sessionSynchronizer.synchronizeFile(filePath),
        setSessionLifecycleMode: ({ appSessionId, mode }) => sessionsDb.setSessionLifecycleMode(appSessionId, mode),
      });
      return armed.sessionId;
    };
    const wsSession = await arm('ws');
    const schedSession = await arm('sched');
    const mcpSession = await arm('mcp');

    const manager = createSessionHostManager({ scheduler: { schedule: () => () => {} } });
    const runtime = createProviderRuntimeService({
      sessionHostManager: manager,
      resolveProvider: (name) =>
        name === DEBUG_AGENT_PROVIDER_ID ? debugProvider : providerRegistry.resolveProvider(name),
    });

    const spy = wrapControl(createChatControlService({ runtime }));

    const tokens = createAccessTokensService({ now: () => new Date() });
    const issued = tokens.issueToken({
      userId: USER_ONE,
      name: 'ac253-wiring',
      scopes: [READ_SCOPE, WRITE_SCOPE],
      expiresInDays: 30,
    });
    if (!issued.ok) {
      throw new Error('the harness must mint the access token');
    }

    // The production shape: mountMcpGateway keeps its name, and the assembled
    // deps come from createMcpGatewayModule carrying the one spy control.
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    mountMcpGateway(
      app,
      createMcpGatewayModule({
        env: { MCP_ENABLED: 'true' },
        authorize: createMcpAuthMiddleware(tokens),
        control: spy.control,
        writeTools: {
          runGet: {
            deps: {
              activity: { snapshot: () => null },
              sessions: { fetchHistory: async () => ({ messages: [] as NormalizedMessage[] }) },
              now: () => clock.value,
              sleep: async (ms: number) => {
                clock.value += ms;
              },
              bootId: () => BOOT_ID,
            },
            build: buildRunGet,
          },
        },
      }),
    );

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
    const address = server.address() as AddressInfo;
    const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${issued.token.token}` } },
      fetch: nodeFetch,
    });
    const client = new Client({ name: 'ac253-criterion', version: '0.0.0' });
    await client.connect(transport);

    // ---- front end 1: WebSocket chat.send ----
    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: USER_ONE } } as never, {
      runtime,
      control: spy.control,
    } as never);
    const handleMessage = socket.listeners('message')[0] as unknown as (raw: unknown) => Promise<void>;
    void handleMessage(JSON.stringify({ type: 'chat.send', sessionId: wsSession, content: 'from ws' }));
    await waitFor(() => spy.counts.send === 1, 5_000, 'the WebSocket send to reach the spy');
    const wsRun = chatRunRegistry.getRun(wsSession);

    // ---- front end 2: the scheduled-message dispatch entry ----
    scheduledMessagesDb.create({
      userId: USER_ONE,
      sessionId: schedSession,
      content: 'from scheduler',
      options: {},
      scheduledFor: new Date(Date.now() - 60_000),
    });
    const sent = await dispatchDueScheduledMessages(spy.control as never);
    const schedRun = chatRunRegistry.getRun(schedSession);
    assert.equal(sent, 1, 'the scheduled dispatch must claim the one due message');

    // ---- front end 3: MCP session_send ----
    const mcpResult = (await client.callTool({
      name: 'session_send',
      arguments: { session: mcpSession, message: 'from mcp' },
    } as Parameters<Client['callTool']>[0])) as { isError?: boolean; content?: Array<{ text?: string }> };
    lastSendAt = Date.now();
    const mcpRun = chatRunRegistry.getRun(mcpSession);

    const reading = {
      counts: { ...spy.counts },
      callers: spy.callers,
      runs: {
        websocket: wsRun ? { runId: wsRun.runId, source: wsRun.source } : null,
        scheduled: schedRun ? { runId: schedRun.runId, source: schedRun.source } : null,
        mcp: mcpRun ? { runId: mcpRun.runId, source: mcpRun.source } : null,
      },
      mcpIsError: mcpResult.isError === true,
    };
    say(`(c) reading=${JSON.stringify(reading)}`);

    assert.equal(spy.counts.send, 3, 'the ONE spy must have been reached exactly three times');
    assert.deepEqual(
      spy.callers.map((caller) => caller.via).sort(),
      ['mcp', 'scheduled', 'websocket'],
      'the three front ends must identify as websocket / scheduled / mcp',
    );
    for (const caller of spy.callers) {
      assert.equal(caller.userId, USER_ONE, 'every front end must carry the authenticated owner');
    }
    assert.notEqual(mcpResult.isError, true, `session_send must not error (${JSON.stringify(mcpResult.content ?? null)})`);

    // Every leg opened a REAL run with the right source, readable by id.
    for (const [label, run] of [
      ['websocket', wsRun],
      ['scheduled', schedRun],
      ['mcp', mcpRun],
    ] as const) {
      assert.ok(run, `the ${label} send must open a run in the one registry`);
      assert.ok(typeof run.runId === 'string' && run.runId.length > 0, `the ${label} run must carry an id`);
      const byId = chatRunRegistry.getRunById(run.runId);
      assert.ok('status' in byId && byId.status !== 'unknown', `the ${label} runId must be readable from the registry`);
    }
    assert.equal(wsRun?.source, 'user', 'a WebSocket send opens a user run');
    assert.equal(schedRun?.source, 'scheduled', 'a scheduled send opens a scheduled run');
    assert.equal(mcpRun?.source, 'mcp', 'an MCP send opens an mcp run');

    await transport.close().catch(() => undefined);
  } finally {
    // Let each front end's walk finish before the transcript directory goes away.
    if (lastSendAt > 0) {
      const settleBy = lastSendAt + RUN_ALIVE_MS + 500;
      while (Date.now() < settleBy) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});
