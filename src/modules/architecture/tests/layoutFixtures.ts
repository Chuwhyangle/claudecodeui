import { archguardToPlantUml } from '@/modules/architecture/archguardToPlantUml';
import type { ArchitectureRendererGraph } from '@/modules/architecture/rendererContract';

/**
 * Small, REAL-SHAPE PlantUML fixtures for the layout criteria.
 *
 * They are not schematic diagrams: every number below was read off the quay
 * client's own graphs and then kept small enough for a unit test to lay out.
 * The two shapes are the two ways the 0.2.x renderer produced the reported
 * canvases:
 *  · a FLAT overview — 18 directory group boxes and 17 aggregated edges, one
 *    connected component, which `elk.aspectRatio` could not fold at all;
 *  · a NESTED hierarchy — 26 packages (two files each) and 32 module
 *    dependencies, the shape a large session's "explosion" view draws.
 *
 * Consumers: `tests/layoutAspect.test.tsx` (drawn proportions and the
 * constructor-option seam) and the task's implementation record (the
 * before/after readings for the two removed 0.2.x patches).
 */

/**
 * The overview the real quay client graph collapses to: 18 directory group
 * boxes and 17 aggregated edges (the `App.tsx` singleton the real grouping
 * leaves out is dropped here, so the fixture is exactly the shape the layout
 * bug was measured on). Labels keep their real entity counts, and the graph is
 * one connected component — the case `elk.aspectRatio` could not fold in
 * 0.2.x.
 */
export const EIGHTEEN_GROUP_OVERVIEW = `@startuml
class "modules/architecture (12)" as g0
class "modules/auth (8)" as g1
class "modules/browser-use (2)" as g2
class "modules/chat (140)" as g3
class "modules/code-editor (20)" as g4
class "modules/command-palette (9)" as g5
class "modules/file-tree (22)" as g6
class "modules/git-panel (26)" as g7
class "modules/i18n (2)" as g8
class "modules/mcp (5)" as g9
class "modules/oauth-consent (2)" as g10
class "modules/onboarding (5)" as g11
class "modules/plugins (4)" as g12
class "modules/prd-editor (13)" as g13
class "modules/project-creation-wizard (12)" as g14
class "modules/project-workspace (23)" as g15
class "modules/provider-auth (2)" as g16
class "modules/quay (2)" as g17
g1 ..> g11 : <<uses>>
g3 ..> g6 : <<uses>>
g3 ..> g1 : <<uses>>
g4 ..> g5 : <<uses>>
g5 ..> g6 : <<uses>>
g10 ..> g1 : <<uses>>
g11 ..> g16 : <<uses>>
g13 ..> g4 : <<uses>>
g15 ..> g5 : <<uses>>
g15 ..> g0 : <<uses>>
g15 ..> g2 : <<uses>>
g15 ..> g3 : <<uses>>
g15 ..> g4 : <<uses>>
g15 ..> g6 : <<uses>>
g15 ..> g7 : <<uses>>
g15 ..> g12 : <<uses>>
g15 ..> g17 : <<uses>>
@enduml`;

/** The 26 modules the nested fixture draws, using the client's real module names. */
const HIERARCHY_MODULES = [
  'architecture', 'auth', 'browser-use', 'chat', 'code-editor', 'command-palette',
  'file-tree', 'git-panel', 'i18n', 'mcp', 'oauth-consent', 'onboarding', 'plugins',
  'prd-editor', 'project-creation-wizard', 'project-workspace', 'provider-auth', 'quay',
  'settings', 'shell', 'sidebar', 'skills', 'tasks', 'terminal', 'voice', 'workflows',
] as const;

/**
 * The module dependency edges of the real client graph, aggregated to one edge
 * per module pair: `project-workspace` pulls most modules, `sidebar` pulls the
 * chat/file/terminal trio, and so on. One connected component, like the real
 * graph — a chain would be an artificial strip.
 */
const HIERARCHY_DEPENDENCIES: readonly (readonly [string, string])[] = [
  ['auth', 'onboarding'], ['chat', 'file-tree'], ['chat', 'auth'], ['code-editor', 'command-palette'],
  ['command-palette', 'file-tree'], ['oauth-consent', 'auth'], ['onboarding', 'provider-auth'],
  ['prd-editor', 'code-editor'], ['project-workspace', 'command-palette'], ['project-workspace', 'architecture'],
  ['project-workspace', 'browser-use'], ['project-workspace', 'chat'], ['project-workspace', 'code-editor'],
  ['project-workspace', 'file-tree'], ['project-workspace', 'git-panel'], ['project-workspace', 'plugins'],
  ['project-workspace', 'quay'], ['sidebar', 'chat'], ['sidebar', 'file-tree'], ['sidebar', 'terminal'],
  ['tasks', 'quay'], ['workflows', 'tasks'], ['voice', 'settings'], ['skills', 'plugins'],
  ['shell', 'sidebar'], ['shell', 'terminal'], ['terminal', 'settings'], ['project-creation-wizard', 'auth'],
  ['project-creation-wizard', 'plugins'], ['mcp', 'plugins'], ['i18n', 'settings'], ['architecture', 'mcp'],
];

/**
 * The raw graph behind {@link TWENTY_SIX_PACKAGE_HIERARCHY}: two files per
 * module, plus the aggregated module dependencies. Ids are file paths (the
 * panel's file granularity); the scope-prefixed default strips the leading
 * `src`, so the emitted packages are `modules/<name>`.
 */
export const TWENTY_SIX_PACKAGE_GRAPH: ArchitectureRendererGraph = {
  nodes: HIERARCHY_MODULES.flatMap((module, index) => ['index', 'use'].map((stem, offset) => ({
    // The bridge emits `package "modules/<name>"` frames from these paths.
    id: `src/modules/${module}/${stem}.ts`,
    label: `src/modules/${module}/${stem}.ts`,
    // A handful of seeds are direct mentions; the rest sit one to three hops out.
    distance: module === 'chat' ? 0 : 1 + ((index + offset) % 3),
    ...(module === 'chat' ? { mentionTier: 'direct' as const } : {}),
  }))),
  edges: HIERARCHY_DEPENDENCIES.map(([from, to], index) => ({
    from: `src/modules/${from}/index.ts`,
    to: `src/modules/${to}/index.ts`,
    relationType: ['dependency', 'call', 'composition', 'inheritance'][index % 4],
  })),
};

/**
 * The nested hierarchy document the "explosion" view renders: 26 packages and
 * 32 edges, laid out as one nested graph. Emitted through the real bridge so
 * the fixture cannot drift from the document the panel produces.
 */
export const TWENTY_SIX_PACKAGE_HIERARCHY = archguardToPlantUml(TWENTY_SIX_PACKAGE_GRAPH, {
  view: { kind: 'hierarchy' },
}).puml;

/** The width/height reading of a `viewBox` string; `null` when it has none. */
export function viewBoxAspect(viewBox: string | null): number | null {
  if (viewBox === null) return null;
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || !(parts[2] > 0) || !(parts[3] > 0)) return null;
  return parts[2] / parts[3];
}

/** The `viewBox` the renderer emitted, or `null` when the SVG carried none. */
export function viewBoxOf(svg: string): string | null {
  return /viewBox="([^"]+)"/.exec(svg)?.[1] ?? null;
}
