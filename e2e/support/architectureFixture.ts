/**
 * The `.archguard` caches the architecture-layout criterion measures.
 *
 * WHY IT IS BUILT HERE RATHER THAN COMMITTED. The criterion needs a drawing big
 * enough to have geometry worth reading — a dozen boxes fit anywhere and would
 * make "the canvas is as tall as its panel" true no matter how the panel is
 * laid out. It also needs the exact shape the real analysis tree has, because
 * the panel's readout is computed from it: one scope whose index carries
 * `fileToIds`/`nameToIds`/`dependencies`, plus the sibling `arch.json` that
 * gives each entity its kind and members. Writing that tree at run time keeps a
 * binary-ish blob out of the repository and lets the criterion state its
 * fixture in one place, the way `server/modules/architecture/tests` does with
 * its own temp projects.
 *
 * TWO VARIANTS. The semantic-zoom defects were reproduced on two real
 * projects (Quay OO and claudecodeui) whose drawings differ in size, nesting
 * and label lengths, so the guard runs both:
 *
 *  · `quay-oo` — five shallow directory families (120 entities), short
 *    camel-case class names;
 *  · `claudecodeui` — four deeper families (96 entities) whose first stem is
 *    the long `VoiceFrameProcessor`, the name the fixed 130px planning cap used
 *    to wrap inside a box wide enough for one line.
 *
 * Both variants keep their class member lists past the renderer's compact
 * limit (`COMPACT_MEMBER_ROWS = 4`), including rows long enough to widen the
 * boxes: that is what makes the renderer emit its own `… +K more (N members)`
 * row (defect 4) and what makes a wide box available for the one-line name
 * reading (defect 7).
 *
 * KINDS. Classes, interfaces and functions all appear, and one class is
 * abstract, because the drawing is supposed to carry the entity-detail payload
 * the real cache carries rather than a flat node list.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The Quay OO-shaped workspace under `QUAY_E2E_DEBUG_AGENT_HOME`. */
export const ARCHITECTURE_FIXTURE_WORKSPACE = 'architecture-canvas-layout-workspace';

/** The claudecodeui-shaped workspace beside it. */
export const ARCHITECTURE_FIXTURE_WORKSPACE_CUI = 'architecture-canvas-layout-workspace-cui';

/**
 * The two-entity workspace the node-size criterion measures.
 *
 * The other variants are big enough that the DRAWING is what decides the
 * reading. This one is the opposite: two classes and one edge, so the only
 * thing that can make a box wide is the member text inside it — the defect
 * `architecture-node-size-from-drawn-content` fixes.
 */
export const ARCHITECTURE_FIXTURE_WORKSPACE_NODE_SIZE = 'architecture-canvas-layout-workspace-node-size';

/**
 * A drawing whose relations ELK routes along the OUTSIDE of the outermost
 * package frames (the semantic viewBox used to clip them).
 */
export const ARCHITECTURE_FIXTURE_WORKSPACE_PERIMETER = 'architecture-canvas-layout-workspace-perimeter';

/** A drawing whose class payload interleaves fields and methods. */
export const ARCHITECTURE_FIXTURE_WORKSPACE_INTERLEAVED = 'architecture-canvas-layout-workspace-interleaved';

/** The function-heavy workspace the "Show all" / folded-fit legs drive. */
export const ARCHITECTURE_FIXTURE_WORKSPACE_FUNCTIONS = 'architecture-canvas-layout-workspace-functions';

/**
 * The workspace whose manifest ALSO lists a scope indexed from outside the
 * project root.
 *
 * The panel's "Scope cleanup" row only exists when the server's scope merge
 * actually cleaned something up (`provenance.scopeHygiene`); a healthy
 * single-scope project reports nothing and draws no row. This is the fixture
 * shape that makes the row exist on a real page.
 */
export const ARCHITECTURE_FIXTURE_WORKSPACE_SCOPE_HYGIENE = 'architecture-canvas-layout-workspace-scope-hygiene';

/**
 * The two-entity chain the layout-orientation criterion measures.
 *
 * The entities are deliberately ASYMMETRIC — one tall (the server's 20-member
 * cap), one short — and their member names are exactly 32 characters. That
 * shape is what makes the two directions differ by a visible margin: laid out
 * downward the drawing is a narrow column (360×592) whose fit is limited by
 * height; laid out to the RIGHT it is a wide row (816×480) whose fit uses the
 * desktop canvas. The files sit at the project ROOT so the drawing has no
 * package frame, which is the "connected small graph" shape the orientation
 * policy exists for.
 */
export const ARCHITECTURE_FIXTURE_WORKSPACE_ORIENTATION = 'architecture-canvas-layout-workspace-orientation';

/** Which project shape to write. */
export type ArchitectureFixtureVariant =
  | 'quay-oo'
  | 'claudecodeui'
  | 'node-size'
  /** Two classes in a dependency chain, shaped so RIGHT beats DOWN on a wide canvas. */
  | 'orientation-chain'
  | 'outer-perimeter'
  | 'interleaved-members'
  /** 41 classes with 7–25 members each: just past the renderer's compact threshold. */
  | 'lossless-41'
  /** 150 classes: the `compact` band's upper edge. */
  | 'lossless-150'
  /** 600 classes: the layout budget's ceiling, and the largest text fixture. */
  | 'lossless-600'
  /**
   * 384 FUNCTION entities in 108 deeply named packages: the shape "Show all"
   * was reported on (a project whose drawing is mostly functions, the kind the
   * shipped filter hides). See {@link buildFunctionEntities}.
   */
  | 'functions-384';

/** The scope key the manifest names; the panel and the tests never depend on its value. */
const SCOPE_KEY = 'scope-src';

/** The second, out-of-root scope the `outsideScope` option adds to the manifest. */
const OUTSIDE_SCOPE_KEY = 'scope-vendor';

/**
 * A fixed fingerprint for the scope index.
 *
 * The cache keys on `archJsonHash` exactly as ArchGuard writes it; the value is
 * opaque to every reader here. A constant keeps two runs of the criterion
 * identical, which matters because the cache would otherwise treat a re-run as
 * a different analysis.
 */
const ARCH_JSON_HASH = 'a7c1f0d4b8e29365f0d4b8e29365a7c1f0d4b8e29365a7c1f0d4b8e29365a7c1';

/** One directory family: its directories, seed name and child-name stem. */
type Family = {
  readonly dir: string;
  readonly deepDir: string;
  readonly seed: string;
  readonly stem: string;
  /** Grandchildren owned by each of the three children. */
  readonly children: readonly [number, number, number];
};

/**
 * Quay OO: five shallow families. Kept FEW on purpose — the panel's overview
 * folds entities into one box per directory, so this list decides how many
 * boxes the file drawing has, and the chrome-clearance reading needs the whole
 * drawing on screen at once.
 */
const QUAY_FAMILIES: readonly Family[] = [
  { dir: 'core/layout', deepDir: 'core/layout/steps', seed: 'layoutPlanner', stem: 'LayoutStage', children: [7, 7, 6] },
  { dir: 'ui/panels', deepDir: 'ui/panels', seed: 'panelPlanner', stem: 'PanelStage', children: [7, 7, 6] },
  { dir: 'adapters/io', deepDir: 'adapters/io', seed: 'ioPlanner', stem: 'IoStage', children: [7, 7, 6] },
  { dir: 'domain/model', deepDir: 'domain/model', seed: 'modelPlanner', stem: 'ModelStage', children: [7, 7, 6] },
  { dir: 'app/shell', deepDir: 'app/shell', seed: 'shellPlanner', stem: 'ShellStage', children: [7, 7, 6] },
];

/**
 * claudecodeui: four deeper families. `VoiceFrameProcessor` is the class the
 * fixed-cap name planner wrapped; its long member list is what makes the box
 * wide enough that wrapping it is visibly wrong.
 */
const CUI_FAMILIES: readonly Family[] = [
  { dir: 'cursor/providers', deepDir: 'cursor/providers/handlers', seed: 'cursorPlanner', stem: 'VoiceFrameProcessor', children: [7, 7, 6] },
  { dir: 'modules/chat', deepDir: 'modules/chat/hooks', seed: 'chatPlanner', stem: 'ChatStage', children: [7, 7, 6] },
  { dir: 'ui/list', deepDir: 'ui/list/rows', seed: 'listPlanner', stem: 'ListStage', children: [7, 7, 6] },
  { dir: 'runtime/vad', deepDir: 'runtime/vad/frames', seed: 'vadPlanner', stem: 'StreamingVad', children: [7, 7, 6] },
];

/** What a caller needs to state its fixture and to read the graph back. */
export type ArchitectureFixtureReading = {
  /** Absolute workspace path handed to the debug agent as the scenario's `projectPath`. */
  readonly workspaceDir: string;
  /** Every entity the graph will draw. */
  readonly entityTotal: number;
  /** The raw entity ids, in the order the index lists them. */
  readonly entityIds: readonly string[];
  /** The identifiers the session's transcript must mention, one per family. */
  readonly seedIdentifiers: readonly string[];
  /** Which project shape this fixture represents. */
  readonly variant: ArchitectureFixtureVariant;
  /**
   * How many member rows each entity carries in the payload. The lossless
   * criteria compare that number with the rows the text actually contains, so
   * a truncated document is detectable per entity rather than in aggregate.
   */
  readonly memberCountById: Readonly<Record<string, number>>;
  /**
   * The member rows a drawn class must show, with the TRUE kind each row has in
   * the payload (the interleaved fixture only). Keyed by entity id, then by the
   * member's declared name; the E2E reading matches a drawn row by that token.
   */
  readonly memberKindsById?: Readonly<Record<string, readonly FixtureMemberKind[]>>;
};

/** One payload member and the kind the drawing must place it in. */
export type FixtureMemberKind = {
  /** The member's declared name — the token a drawn row starts with. */
  readonly token: string;
  readonly kind: 'field' | 'method';
};

/** One entity as this fixture writes it into both `arch-index.json` and `arch.json`. */
type FixtureEntity = {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly type: 'class' | 'interface' | 'function';
  readonly isAbstract: boolean;
  readonly parents: readonly string[];
  /** Overrides the shared member recipe when a variant states its own rows. */
  readonly members?: readonly unknown[];
};

/**
 * The members a class or interface box carries.
 *
 * Past four rows the renderer's compact detail replaces the tail with its own
 * `… +K more (N members)` row. The names are deliberately long: the member
 * text is what widens a class box, so a wide box exists for the one-line name
 * reading.
 */
const membersFor = (type: FixtureEntity['type'], classMembers: number): unknown[] => {
  if (type === 'function') return [];
  if (type === 'interface') {
    return [{ name: 'id', type: 'property', visibility: 'public', fieldType: 'string' }];
  }
  const base: unknown[] = [
    {
      name: 'constructor',
      type: 'constructor',
      visibility: 'public',
      parameters: [{ name: 'seed', type: 'number', isOptional: false }],
    },
    { name: 'forceCutSearchFrames', type: 'property', visibility: 'private', fieldType: 'number' },
    {
      name: 'measure',
      type: 'method',
      visibility: 'public',
      parameters: [{ name: 'input', type: 'string', isOptional: true }],
      returnType: 'number',
    },
  ];
  const extras = ['pendingCount', 'noise', 'windowSize', 'frameBudget'];
  for (let index = 0; base.length < classMembers; index += 1) {
    base.push({
      name: extras[index % extras.length],
      type: 'property',
      visibility: 'private',
      fieldType: 'number',
    });
  }
  return base.slice(0, classMembers);
};

/** The kind rotation the fixture uses, so all three kinds appear at every depth. */
const kindAt = (index: number, forcedAbstract = false): FixtureEntity['type'] => {
  const kinds: FixtureEntity['type'][] = ['class', 'interface', 'function'];
  if (forcedAbstract) return 'class';
  return kinds[index % kinds.length];
};

/**
 * The whole fixture's entity list, in a deterministic order.
 *
 * The families are CHAINED — each seed depends on the next family's seed — so
 * the directory overview is a layered left-to-right ladder rather than a pile
 * of unrelated boxes. The chain keeps the drawing a real architectural diagram
 * while the small family count keeps it inside the corner-free canvas area.
 */
function buildEntities(families: readonly Family[], classMembers: number): FixtureEntity[] {
  const entities: FixtureEntity[] = [];
  families.forEach((family, familyIndex) => {
    const seedId = `${family.dir}/${family.seed}.ts.${family.seed}`;
    const nextFamily = families[familyIndex + 1];
    entities.push({
      id: seedId,
      name: family.seed,
      file: `${family.dir}/${family.seed}.ts`,
      type: 'function',
      isAbstract: false,
      // The chain's link: this family's seed depends on the next family's seed.
      parents: nextFamily === undefined
        ? []
        : [`${nextFamily.dir}/${nextFamily.seed}.ts.${nextFamily.seed}`],
    });

    family.children.forEach((grandchildCount, childIndex) => {
      const childName = `${family.stem}${childIndex}`;
      const childId = `${family.dir}/${childName}.ts.${childName}`;
      const extraParent = familyIndex === 0 && childIndex === 0
        ? [`${families[1].dir}/${families[1].seed}.ts.${families[1].seed}`]
        : [];
      entities.push({
        id: childId,
        name: childName,
        file: `${family.dir}/${childName}.ts`,
        type: kindAt(childIndex),
        isAbstract: false,
        parents: [seedId, ...extraParent],
      });

      for (let stepIndex = 0; stepIndex < grandchildCount; stepIndex += 1) {
        const stepName = `${family.stem}${childIndex}Step${stepIndex}`;
        const stepId = `${family.deepDir}/${stepName}.ts.${stepName}`;
        entities.push({
          id: stepId,
          name: stepName,
          file: `${family.deepDir}/${stepName}.ts`,
          type: kindAt(stepIndex + childIndex, familyIndex === 0 && childIndex === 0 && stepIndex === 0),
          isAbstract: familyIndex === 0 && childIndex === 0 && stepIndex === 0,
          parents: [childId],
        });
      }
    });
  });
  return entities;
}

/** A record whose every key maps to an array, filled with `[]` for the keys not named. */
function emptyRecord(ids: readonly string[]): Record<string, string[]> {
  const record: Record<string, string[]> = {};
  for (const id of ids) record[id] = [];
  return record;
}

/**
 * The outer-perimeter fixture: eight directory families, two classes each, a
 * forward chain per class family, plus FIVE back edges from the last family to
 * earlier ones.
 *
 * Shape, not decoration: the long back edges are what make ELK's orthogonal
 * router place bends OUTSIDE the union of the package frames (measured on this
 * fixture: six relations up to ~35 px outside). That is the state the shipped
 * semantic canvas clipped, because its viewBox was the package union.
 */
function buildPerimeterEntities(): FixtureEntity[] {
  // SINGLE-SEGMENT directories on purpose: a shared parent directory would draw
  // a root package frame around every family, and ELK keeps the perimeter
  // routing inside THAT frame. The defect needs the union of the leaf frames to
  // be the outermost object.
  const idOf = (stem: 'P' | 'Q', index: number): string => `p${index}/${stem}${index}.ts.${stem}${index}`;
  const entities: FixtureEntity[] = [];
  for (let index = 0; index < 8; index += 1) {
    for (const stem of ['P', 'Q'] as const) {
      const name = `${stem}${index}`;
      const parents: string[] = [];
      // `parents` means "this entity depends on …", so a parent becomes an
      // outgoing edge FROM the parent: P(i-1) → P(i).
      if (index > 0) parents.push(idOf(stem, index - 1));
      // Five back edges from the last P: P7 → P0 … P4.
      if (stem === 'P' && index <= 4) parents.push(idOf('P', 7));
      entities.push({
        id: idOf(stem, index),
        name,
        file: `p${index}/${name}.ts`,
        // Member-free class boxes are the same boxes the unit-test fixture
        // lays out, so the routing measured there holds here.
        type: 'class',
        isAbstract: false,
        parents,
        members: [],
      });
    }
  }
  return entities;
}

/**
 * The lossless fixtures: `count` classes carrying 7–25 members each.
 *
 * Both numbers are load-bearing. Past 40 entities the renderer's default
 * `detail` switches to `compact`, which keeps four real rows and writes a
 * synthetic `… +N more (M members)` row into the drawn model; the member count
 * cycles across 7–25 so a document that keeps a fixed number of rows cannot
 * pass. The ids are real three-segment paths so the hierarchy view draws
 * package frames, and the entities form a dependency chain so none is isolated
 * (the panel's default filter hides isolated nodes).
 */
function buildLosslessEntities(count: number): FixtureEntity[] {
  return Array.from({ length: count }, (_unused, index) => {
    const name = `Entity${String(index)}`;
    const file = `pkg${String(index % 7)}/e${String(index)}.ts`;
    const memberCount = 7 + (index % 19);
    return {
      id: `${file}.${name}`,
      name,
      file,
      type: 'class' as const,
      isAbstract: false,
      parents: index === 0
        ? []
        : [`pkg${String((index - 1) % 7)}/e${String(index - 1)}.ts.Entity${String(index - 1)}`],
      members: Array.from({ length: memberCount }, (_member, member) => ({
        name: `member${String(member)}`,
        type: 'property',
        visibility: 'private',
        fieldType: 'number',
      })),
    };
  });
}

/** The entity count a lossless variant states. */
function losslessEntityCount(variant: ArchitectureFixtureVariant): number | null {
  if (variant === 'lossless-41') return 41;
  if (variant === 'lossless-150') return 150;
  if (variant === 'lossless-600') return 600;
  return null;
}

/**
 * The function-heavy fixture: the shape the "Show all" defect was reported on.
 *
 * WHY FUNCTIONS. The shipped filter hides the `function` kind, so this drawing
 * is exactly the one "Show all" is FOR: before the click the canvas holds almost
 * nothing (the twelve module-level seeds), after it a 396-box drawing. The
 * relation preset must survive that click — the reported defect was that it
 * silently moved from `+Dependencies` to `+Calls` at the same time.
 *
 * WHY 108 PACKAGES. The folded tier is chosen on the size of the PACKAGE-ONLY
 * drawing, whose width is the sum of its tabs' minimum widths. That many packages
 * with long directory names make that sum many canvases wide on a 1440×765
 * screen — the state the reported 573-function project was in — which is what
 * the folded tier exists to answer. Every function is chained to the next so
 * none is isolated (the default filter would drop it before "Show all" could
 * matter) and the drawing is one connected neighbourhood from any seed.
 */
function buildFunctionEntities(): FixtureEntity[] {
  const entities: FixtureEntity[] = [];
  for (let module = 0; module < 12; module += 1) {
    // One CLASS per module: the shipped filter shows it, so the tab opens on a
    // real drawing (an all-hidden payload would open on the empty state, and
    // "Show all" would then have nothing to widen).
    const moduleDir = `src/modules/module${String(module).padStart(2, '0')}`;
    const serviceName = `Module${String(module).padStart(2, '0')}Service`;
    entities.push({
      id: `${moduleDir}/${serviceName}.ts.${serviceName}`,
      name: serviceName,
      file: `${moduleDir}/${serviceName}.ts`,
      type: 'class',
      isAbstract: false,
      parents: [],
      members: [],
    });
    // Eight units of four functions: 384 functions in 96 leaf packages. The
    // package count is what the folded tier is measured on (the package-only
    // drawing is as wide as its tabs' minimum widths), so breadth per module —
    // not depth per unit — is the lever here.
    for (let unit = 0; unit < 8; unit += 1) {
      for (let step = 0; step < 4; step += 1) {
        const index = entities.length;
        const dir = `${moduleDir}/unit${String(unit)}`;
        const name = `handleFrameBudgetStep${String(index).padStart(3, '0')}`;
        entities.push({
          id: `${dir}/${name}.ts.${name}`,
          name,
          file: `${dir}/${name}.ts`,
          type: 'function',
          isAbstract: false,
          // EVERY function hangs off its module's class. That is what makes the
          // whole 372-entity drawing reachable in ONE hop from the twelve class
          // seeds: the server seeds identifiers from the session text under a
          // hard cap (40), so a chain would leave most of the fixture outside
          // the neighbourhood and the criterion would measure a 50-box drawing
          // instead of the large one this fixture exists for.
          parents: [`${moduleDir}/${serviceName}.ts.${serviceName}`],
        });
      }
    }
  }
  return entities;
}

/**
 * The interleaved-member fixture: one class whose PAYLOAD members alternate
 * field → method → field → method, inside two packages.
 *
 * The renderer groups fields before methods when it draws, so the drawn order
 * differs from the payload order. The read layer must classify each row from
 * the renderer's own compartment class; the indexed payload overlay put the
 * methods in the attributes compartment (the shipped defect).
 */
function buildInterleavedEntities(): FixtureEntity[] {
  const mixedMembers = [
    { name: 'alphaField', type: 'field', visibility: 'private', fieldType: 'string' },
    {
      name: 'deltaMethod',
      type: 'method',
      visibility: 'public',
      parameters: [{ name: 'input', type: 'number', isOptional: false }],
      returnType: 'boolean',
    },
    { name: 'betaField', type: 'field', visibility: 'private', fieldType: 'number' },
    { name: 'gammaMethod', type: 'method', visibility: 'public', parameters: [], returnType: 'void' },
  ];
  return [
    {
      id: 'interleaved/core/Mixed.ts.Mixed',
      name: 'Mixed',
      file: 'interleaved/core/Mixed.ts',
      type: 'class',
      isAbstract: false,
      parents: [],
      members: mixedMembers,
    },
    {
      id: 'interleaved/core/Helper.ts.Helper',
      name: 'Helper',
      file: 'interleaved/core/Helper.ts',
      type: 'class',
      isAbstract: false,
      parents: ['interleaved/core/Mixed.ts.Mixed'],
      members: [],
    },
    {
      id: 'interleaved/util/Util.ts.Util',
      name: 'Util',
      file: 'interleaved/util/Util.ts',
      type: 'class',
      isAbstract: false,
      parents: ['interleaved/core/Mixed.ts.Mixed'],
      members: [],
    },
  ];
}

/** Build the index body's adjacency maps from each entity's parents. */
function buildIndex(entities: readonly FixtureEntity[]): Record<string, unknown> {
  const ids = entities.map((entity) => entity.id);
  const fileToIds: Record<string, string[]> = {};
  const nameToIds: Record<string, string[]> = {};
  const idToFile: Record<string, string> = {};
  const idToName: Record<string, string> = {};
  const dependencies = emptyRecord(ids);
  const dependents = emptyRecord(ids);

  for (const entity of entities) {
    (fileToIds[entity.file] ??= []).push(entity.id);
    (nameToIds[entity.name] ??= []).push(entity.id);
    idToFile[entity.id] = entity.file;
    idToName[entity.id] = entity.name;
    for (const parent of entity.parents) {
      dependencies[parent].push(entity.id);
      dependents[entity.id].push(parent);
    }
  }

  return {
    version: '1.0',
    language: 'typescript',
    archJsonHash: ARCH_JSON_HASH,
    fileToIds,
    nameToIds,
    idToFile,
    idToName,
    dependencies,
    dependents,
  };
}

/** The sibling `arch.json` ArchGuard writes: one entity per class/interface/function. */
function buildArchive(entities: readonly FixtureEntity[], classMembers: number): Record<string, unknown> {
  return {
    version: '1.0',
    language: 'typescript',
    entities: entities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      isAbstract: entity.isAbstract,
      members: entity.members ?? membersFor(entity.type, classMembers),
    })),
  };
}

/* ── the two-entity node-size fixture ─────────────────────────────────────── */

/**
 * One member exactly as ArchGuard writes it into `arch.json`.
 *
 * The unit test and the e2e leg read the SAME records: the criterion is about
 * what the renderer does with a long declaration, so the fixture that states
 * the long signature must be one file, not two drifting copies.
 */
export type NodeSizeMemberRecord =
  | {
      readonly name: string;
      readonly type: 'field';
      readonly visibility: string;
      readonly fieldType: string;
    }
  | {
      readonly name: string;
      readonly type: 'method';
      readonly visibility: string;
      readonly parameters: readonly {
        readonly name: string;
        readonly type: string;
        readonly isOptional: boolean;
      }[];
      readonly returnType: string;
    };

/** One class of the node-size fixture, as `arch.json` describes it. */
export type NodeSizeEntityRecord = {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly type: 'class';
  readonly isAbstract: boolean;
  /** Entity ids this class depends on. */
  readonly dependsOn: readonly string[];
  readonly members: readonly NodeSizeMemberRecord[];
};

/**
 * The class the defect was measured on: seven members, two of them signatures
 * long enough to widen a box past anything the screen shows.
 *
 * The 105-character `process` signature is the exact shape the task quotes. It
 * sits in the sixth drawn row (fields are drawn before methods), so the cap
 * truncates it to 48 characters plus `…`; `reset` (114 characters) is dropped
 * into the fold row along with `flush`.
 */
const VOICE_FRAME_PROCESSOR: NodeSizeEntityRecord = {
  id: 'src/runtime/voice/VoiceFrameProcessor.ts.VoiceFrameProcessor',
  name: 'VoiceFrameProcessor',
  file: 'src/runtime/voice/VoiceFrameProcessor.ts',
  type: 'class',
  isAbstract: false,
  dependsOn: [],
  members: [
    { name: 'windowSize', type: 'field', visibility: 'private', fieldType: 'number' },
    { name: 'frameBudget', type: 'field', visibility: 'private', fieldType: 'number' },
    { name: 'carryOver', type: 'field', visibility: 'private', fieldType: 'number' },
    { name: 'pendingFrames', type: 'field', visibility: 'private', fieldType: 'number' },
    {
      name: 'process',
      type: 'method',
      visibility: 'public',
      parameters: [
        { name: 'inputs', type: 'Float32Array<ArrayBufferLike>[][]', isOptional: true },
        { name: 'outputs', type: 'Float32Array<ArrayBufferLike>[][]', isOptional: true },
      ],
      returnType: 'boolean',
    },
    {
      name: 'reset',
      type: 'method',
      visibility: 'public',
      parameters: [
        { name: 'frameBudget', type: 'ArrayBufferLike[][]', isOptional: false },
        { name: 'carryOver', type: 'Float32Array<ArrayBufferLike>[]', isOptional: false },
      ],
      returnType: 'Float32Array<ArrayBufferLike>',
    },
    {
      name: 'flush',
      type: 'method',
      visibility: 'public',
      parameters: [],
      returnType: 'void',
    },
  ],
};

/**
 * Twenty members — the server's per-entity cap, so nothing is cut upstream.
 * Every row is short on purpose: this class must NOT be what widens the
 * drawing, or the criterion would stop isolating the long-signature box.
 */
const FRAME_BUDGET_LEDGER: NodeSizeEntityRecord = {
  id: 'src/runtime/voice/FrameBudgetLedger.ts.FrameBudgetLedger',
  name: 'FrameBudgetLedger',
  file: 'src/runtime/voice/FrameBudgetLedger.ts',
  type: 'class',
  isAbstract: false,
  dependsOn: [VOICE_FRAME_PROCESSOR.id],
  members: [
    // One long-but-drawn row: the box must follow a line the canvas keeps
    // verbatim (45 characters with its symbol, inside the 48-character cap), so the criterion
    // measures the member text rather than the class title.
    {
      name: 'frameBudgetWindowInMillisecondsPerFrames',
      type: 'field',
      visibility: 'private',
      fieldType: 'int',
    },
    ...Array.from({ length: 19 }, (_, index) => ({
      name: `n${String(index + 1).padStart(2, '0')}`,
      type: 'field' as const,
      visibility: 'private',
      fieldType: 'int',
    })),
  ],
};

/** Both classes, in the order the index lists them (the seed arrives first). */
export const NODE_SIZE_ENTITIES: readonly NodeSizeEntityRecord[] = [
  VOICE_FRAME_PROCESSOR,
  FRAME_BUDGET_LEDGER,
];

/** The entity whose name the session text must mention to seed the drawing. */
export const NODE_SIZE_SEED_IDENTIFIERS: readonly string[] = ['VoiceFrameProcessor', 'FrameBudgetLedger'];

/** The signature the task quotes, as the server renders it (`name(params): return`). */
export function nodeSizeMemberSignature(member: NodeSizeMemberRecord): string {
  if (member.type === 'field') return member.fieldType;
  const parameters = member.parameters
    .map((parameter) => `${parameter.name}${parameter.isOptional ? '?' : ''}: ${parameter.type}`)
    .join(', ');
  return `${member.name}(${parameters}): ${member.returnType}`;
}

/**
 * The same two classes in the shape the PANEL receives: the server's `kind` +
 * `members` detail, with each member's `signature` rendered exactly as the
 * server renders it. Unit tests draw this through the real renderer.
 */
export function nodeSizeEntityGraph(): {
  readonly nodes: readonly {
    readonly id: string;
    readonly label: string;
    readonly distance: number;
    readonly kind: 'class';
    readonly members: readonly {
      readonly name: string;
      readonly kind: 'field' | 'method';
      readonly visibility: string;
      readonly signature: string;
    }[];
  }[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly relationType: 'dependency' }[];
} {
  return {
    nodes: NODE_SIZE_ENTITIES.map((entity) => ({
      id: entity.id,
      label: entity.name,
      distance: 0,
      kind: 'class' as const,
      members: entity.members.map((member) => ({
        name: member.name,
        kind: member.type,
        visibility: member.visibility,
        signature: nodeSizeMemberSignature(member),
      })),
    })),
    edges: NODE_SIZE_ENTITIES.flatMap((entity) => entity.dependsOn.map((dependency) => ({
      from: entity.id,
      to: dependency,
      relationType: 'dependency' as const,
    }))),
  };
}

/* ── the two-entity LAYOUT-ORIENTATION fixture ────────────────────────────── */

/** The member-name width (characters) the orientation fixture states. */
const ORIENTATION_MEMBER_CHARS = 32;

/** One fixed-width member row: the width is what makes the drawing's boxes wide. */
function orientationMember(prefix: string, index: number): NodeSizeMemberRecord {
  return {
    name: `${prefix}${String(index).padStart(2, '0')}`
      .padEnd(ORIENTATION_MEMBER_CHARS, 'x')
      .slice(0, ORIENTATION_MEMBER_CHARS),
    type: 'field',
    visibility: 'private',
    fieldType: 'int',
  };
}

/**
 * The tall end of the chain: the server's 20-member cap, all rows the same
 * width. Files at the project root keep the drawing package-free.
 *
 * The CLASS NAME is long on purpose. It is the box's widest line, so it
 * decides how wide the drawing is: with a short name the side-by-side RIGHT
 * drawing is only 816 px wide and the desktop canvas still has spare width;
 * this name makes it ~992 px, which is what lets the turned drawing fill a
 * 1151 px canvas. Both directions grow with it, but only the RIGHT one grows
 * along the canvas' long axis.
 */
const ORIENTATION_ALPHA: NodeSizeEntityRecord = {
  id: 'AlphaServiceWithAReallyLongDescriptiveClassNameForWidthTesting.ts.AlphaServiceWithAReallyLongDescriptiveClassNameForWidthTesting',
  name: 'AlphaServiceWithAReallyLongDescriptiveClassNameForWidthTesting',
  file: 'AlphaServiceWithAReallyLongDescriptiveClassNameForWidthTesting.ts',
  type: 'class',
  isAbstract: false,
  // The chain's direction: Alpha depends on Beta, so the drawn relation is
  // Beta → Alpha (the server emits an edge parent → dependent from this).
  dependsOn: ['BetaLedger.ts.BetaLedger'],
  members: Array.from({ length: 20 }, (_, index) => orientationMember('alpha', index)),
};

/**
 * The short end. Four rows: side by side with the tall class the drawing's
 * height is the tall box's, which is what makes the RIGHT layout wider without
 * growing taller. A symmetric pair would leave both directions the same shape.
 */
const ORIENTATION_BETA: NodeSizeEntityRecord = {
  id: 'BetaLedger.ts.BetaLedger',
  name: 'BetaLedger',
  file: 'BetaLedger.ts',
  type: 'class',
  isAbstract: false,
  dependsOn: [],
  members: Array.from({ length: 4 }, (_, index) => orientationMember('beta', index)),
};

/** Both classes: Alpha first, so the drawing's seed arrives before its dependent. */
export const ORIENTATION_CHAIN_ENTITIES: readonly NodeSizeEntityRecord[] = [ORIENTATION_ALPHA, ORIENTATION_BETA];

/** The names the session text must mention so both ends of the chain are drawn. */
export const ORIENTATION_CHAIN_SEED_IDENTIFIERS: readonly string[] = [ORIENTATION_ALPHA.name, ORIENTATION_BETA.name];

/**
 * The same two classes in the shape the PANEL receives (server `kind` + members
 * detail). The unit test lays this through the real renderer, so the direction
 * decision is pinned on the same geometry the browser criterion reads.
 */
export function orientationChainGraph(): {
  readonly nodes: readonly {
    readonly id: string;
    readonly label: string;
    readonly distance: number;
    readonly kind: 'class';
    readonly members: readonly {
      readonly name: string;
      readonly kind: 'field';
      readonly visibility: string;
      readonly signature: string;
    }[];
  }[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly relationType: 'dependency' }[];
} {
  const toNode = (entity: NodeSizeEntityRecord) => ({
    id: entity.id,
    label: entity.name,
    distance: 0,
    kind: 'class' as const,
    members: entity.members.map((member) => ({
      name: member.name,
      kind: 'field' as const,
      visibility: member.visibility,
      signature: member.type === 'field' ? member.fieldType : '',
    })),
  });
  return {
    nodes: ORIENTATION_CHAIN_ENTITIES.map(toNode),
    // The server's edge direction: for each entity it depends on, an edge runs
    // from that parent TO the entity (see `buildIndex`'s `dependencies` map).
    // The panel criterion therefore draws Beta → Alpha, the same relation the
    // browser criterion draws from the same fixture.
    edges: ORIENTATION_CHAIN_ENTITIES.flatMap((entity) => entity.dependsOn.map((dependency) => ({
      from: dependency,
      to: entity.id,
      relationType: 'dependency' as const,
    }))),
  };
}

/** Write the two-entity orientation workspace and answer the reading the criterion uses. */
function writeEntityFixture(
  workspaceDir: string,
  generatedAt: string,
  entities: readonly NodeSizeEntityRecord[],
  seedIdentifiers: readonly string[],
  variant: ArchitectureFixtureVariant,
): ArchitectureFixtureReading {
  const fixtures: FixtureEntity[] = entities.map((entity) => ({
    id: entity.id,
    name: entity.name,
    file: entity.file,
    type: entity.type,
    isAbstract: entity.isAbstract,
    parents: entity.dependsOn,
  }));
  const srcDir = path.join(workspaceDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  writeJson(path.join(workspaceDir, '.archguard', 'query', 'manifest.json'), {
    version: '1.0',
    generatedAt,
    globalScopeKey: SCOPE_KEY,
    scopes: [
      { key: SCOPE_KEY, label: 'src (typescript)', language: 'typescript', sources: [srcDir] },
    ],
  });
  writeJson(path.join(workspaceDir, '.archguard', 'query', SCOPE_KEY, 'arch-index.json'), {
    ...buildIndex(fixtures),
    generatedAt,
  });
  writeJson(path.join(workspaceDir, '.archguard', 'query', SCOPE_KEY, 'arch.json'), {
    version: '1.0',
    language: 'typescript',
    entities: entities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      isAbstract: entity.isAbstract,
      members: entity.members,
    })),
  });

  return {
    workspaceDir,
    entityTotal: entities.length,
    entityIds: entities.map((entity) => entity.id),
    seedIdentifiers,
    variant,
    memberCountById: Object.fromEntries(entities.map((entity) => [entity.id, entity.members.length])),
  };
}

/** Write the two-entity workspace and answer the reading the criterion uses. */
function writeNodeSizeFixture(workspaceDir: string, generatedAt: string): ArchitectureFixtureReading {
  return writeEntityFixture(workspaceDir, generatedAt, NODE_SIZE_ENTITIES, NODE_SIZE_SEED_IDENTIFIERS, 'node-size');
}

/** Write one JSON file, creating its directory. */
function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** What one `writeArchitectureFixture` call accepts. */
export type ArchitectureFixtureOptions = {
  readonly variant?: ArchitectureFixtureVariant;
  readonly generatedAt?: string;
  /**
   * Also list a SECOND scope — indexed from outside the project root — in the
   * manifest, and write its index. The server drops it from the merge and
   * reports it in `provenance.scopeHygiene`, which is the only way the panel's
   * "Scope cleanup" disclosure exists at all.
   */
  readonly outsideScope?: boolean;
};

/**
 * Write the fixture under `workspaceDir` and answer what the criterion needs.
 *
 * Idempotent: every file is rewritten, so a re-run against a data directory a
 * previous run left behind measures this run's fixture rather than a stale one.
 * The `src` directory is real even though nothing reads the source files — the
 * manifest's `sources` entry is what tells the service which directory the
 * index's keys are relative to, and an analysis tree without it is not the
 * shape the real `.archguard` has.
 */
export function writeArchitectureFixture(
  workspaceDir: string,
  options: ArchitectureFixtureOptions = {},
): ArchitectureFixtureReading {
  const variant = options.variant ?? 'quay-oo';
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  // The node-size variant is not a family shape: it states its two classes
  // directly, because the criterion is about one box's member text.
  if (variant === 'node-size') return writeNodeSizeFixture(workspaceDir, generatedAt);
  // The orientation variant states its own asymmetric pair for the same reason.
  if (variant === 'orientation-chain') {
    return writeEntityFixture(
      workspaceDir,
      generatedAt,
      ORIENTATION_CHAIN_ENTITIES,
      ORIENTATION_CHAIN_SEED_IDENTIFIERS,
      'orientation-chain',
    );
  }
  const families = variant === 'claudecodeui' ? CUI_FAMILIES : QUAY_FAMILIES;
  // Both family shapes stay past `COMPACT_MEMBER_ROWS` (4); the second shape
  // adds one more row so its upstream `(N members)` reading differs from the
  // first's. The dedicated variants state their own shapes below.
  const classMembers = variant === 'claudecodeui' ? 6 : 5;
  const losslessCount = losslessEntityCount(variant);
  const entities = losslessCount !== null
    ? buildLosslessEntities(losslessCount)
    : variant === 'outer-perimeter'
      ? buildPerimeterEntities()
      : variant === 'interleaved-members'
        ? buildInterleavedEntities()
        : variant === 'functions-384'
          ? buildFunctionEntities()
          : buildEntities(families, classMembers);
  const srcDir = path.join(workspaceDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  // The out-of-root scope's sources sit beside the workspace, never inside it:
  // the containment check is what marks the scope as "outside the project".
  const outsideSources = [path.join(path.dirname(workspaceDir), `${path.basename(workspaceDir)}-vendor`)];
  writeJson(path.join(workspaceDir, '.archguard', 'query', 'manifest.json'), {
    version: '1.0',
    generatedAt,
    globalScopeKey: SCOPE_KEY,
    scopes: [
      { key: SCOPE_KEY, label: 'src (typescript)', language: 'typescript', sources: [srcDir] },
      ...(options.outsideScope === true
        ? [{
            key: OUTSIDE_SCOPE_KEY,
            label: 'vendor (typescript)',
            language: 'typescript',
            sources: outsideSources,
            // Upstream metadata is trusted over the heuristic (see
            // `server/modules/architecture/scope-hygiene.ts`).
            outsideProjectRoot: true,
          }]
        : []),
    ],
  });
  writeJson(path.join(workspaceDir, '.archguard', 'query', SCOPE_KEY, 'arch-index.json'), {
    ...buildIndex(entities),
    generatedAt,
  });
  writeJson(
    path.join(workspaceDir, '.archguard', 'query', SCOPE_KEY, 'arch.json'),
    buildArchive(entities, classMembers),
  );
  if (options.outsideScope === true) {
    // One entity of its own: the scope is DROPPED by the merge either way, and
    // an index with no entity would never become a candidate `total` counts.
    const outsideEntities: FixtureEntity[] = [{
      id: 'vendor/dep.ts.Vendor',
      name: 'Vendor',
      file: 'vendor/dep.ts',
      type: 'class',
      isAbstract: false,
      parents: [],
    }];
    writeJson(
      path.join(workspaceDir, '.archguard', 'query', OUTSIDE_SCOPE_KEY, 'arch-index.json'),
      { ...buildIndex(outsideEntities), generatedAt },
    );
    writeJson(
      path.join(workspaceDir, '.archguard', 'query', OUTSIDE_SCOPE_KEY, 'arch.json'),
      buildArchive(outsideEntities, 1),
    );
  }

  const seedIdentifiers = losslessCount !== null
    // Every entity is named in the session text: a bounded hop expansion from
    // one seed would not necessarily reach the whole fixture, and the lossless
    // criteria need all `count` boxes drawn.
    ? entities.map((entity) => entity.name)
    : variant === 'functions-384'
    // ONLY the twelve module classes are named. The server caps identifier
    // seeds (40), so naming all 372 would seed an arbitrary prefix of the list;
    // naming the twelve hubs reaches every function in one hop instead, and the
    // whole drawing exists BEFORE "Show all" so the click is the only change.
    ? entities.filter((entity) => entity.type === 'class').map((entity) => entity.name)
    : variant === 'outer-perimeter'
    // EVERY entity is a seed: the class graph expands a bounded number of hops
    // from the mentioned names, and a chain seeded only at its head would be
    // drawn three packages deep — the back edges that route around the outside
    // would never reach the canvas.
    ? buildPerimeterEntities().map((entity) => entity.name)
    : variant === 'interleaved-members'
      ? ['Mixed', 'Util']
      : families.map((family) => family.seed);

  return {
    workspaceDir,
    entityTotal: entities.length,
    entityIds: entities.map((entity) => entity.id),
    seedIdentifiers,
    variant,
    // The SAME expression `buildArchive` writes, so a criterion can compare the
    // text's member rows with the payload's without re-deriving the recipe.
    memberCountById: Object.fromEntries(entities.map((entity) => [
      entity.id,
      (entity.members ?? membersFor(entity.type, classMembers)).length,
    ])),
    ...(variant === 'interleaved-members'
      ? {
          memberKindsById: {
            'interleaved/core/Mixed.ts.Mixed': [
              { token: 'alphaField', kind: 'field' as const },
              { token: 'betaField', kind: 'field' as const },
              { token: 'deltaMethod', kind: 'method' as const },
              { token: 'gammaMethod', kind: 'method' as const },
            ],
          },
        }
      : {}),
  };
}

/* ── the fit-contract matrix: S / M / L / Quay-shaped drawings ─────────────────────────────── */

/** The four fixture workspaces the fit-contract criterion drives. */
export const FIT_CONTRACT_WORKSPACES = {
  s: 'architecture-fit-contract-workspace-s',
  m: 'architecture-fit-contract-workspace-m',
  l: 'architecture-fit-contract-workspace-l',
  quay: 'architecture-fit-contract-workspace-quay',
} as const;

/** Which size/shape one fit-contract fixture is. */
export type FitContractFixtureOptions = {
  readonly entityCount: number;
  readonly entityKind: 'class' | 'interface';
  readonly packageCount: number;
  /** The visible name stem (`FitM`, `Quay`), so ids and labels are readable. */
  readonly labelStem: string;
};

/** What the criterion reads back about one fit-contract fixture. */
export type FitContractFixtureReading = {
  readonly workspaceDir: string;
  readonly entityTotal: number;
  readonly entityIds: readonly string[];
  /** The identifiers the session text must name (one hub + package leaders). */
  readonly seedIdentifiers: readonly string[];
  readonly packageIds: readonly string[];
};

/**
 * Write one fit-contract fixture: a HUB-AND-SPOKE drawing of `entityCount`
 * entities spread over `packageCount` packages.
 *
 * The hub is what makes the size measurable: it depends on every spoke, so the
 * server's bounded hop expansion from the named hub reaches the whole drawing,
 * and the drawing really has `entityCount` boxes for the criterion to measure.
 * The seed list stays far below the server's 40-identifier cap.
 */
export function writeFitContractFixture(
  workspaceDir: string,
  options: FitContractFixtureOptions,
): FitContractFixtureReading {
  const generatedAt = new Date().toISOString();
  const packages = Array.from(
    { length: Math.max(1, options.packageCount) },
    (_, index) => `src/fit/p${index}`,
  );
  const entities: { id: string; name: string; file: string; parents: string[] }[] = [];
  for (let index = 0; index < options.entityCount; index += 1) {
    const packageId = packages[index % packages.length];
    const name = `${options.labelStem}${index}`;
    entities.push({
      id: `${packageId}/${name}.ts.${name}`,
      name,
      file: `${packageId}/${name}.ts`,
      parents: index === 0 ? [] : [entities[0].id],
    });
  }
  const hub = entities[0];
  const leaders = packages
    .map((packageId) => entities.find((entity) => entity.file.startsWith(`${packageId}/`)))
    .filter((entity): entity is typeof entities[number] => entity !== undefined);
  const seedIdentifiers = [hub.name, ...leaders.map((entity) => entity.name).filter((name) => name !== hub.name)];

  const fileToIds: Record<string, string[]> = {};
  const nameToIds: Record<string, string[]> = {};
  const idToFile: Record<string, string> = {};
  const idToName: Record<string, string> = {};
  const dependencies: Record<string, string[]> = {};
  const dependents: Record<string, string[]> = {};
  for (const entity of entities) {
    (fileToIds[entity.file] ??= []).push(entity.id);
    (nameToIds[entity.name] ??= []).push(entity.id);
    idToFile[entity.id] = entity.file;
    idToName[entity.id] = entity.name;
    dependencies[entity.id] ??= [];
    dependents[entity.id] ??= [];
  }
  for (const entity of entities) {
    for (const parent of entity.parents) {
      dependencies[parent].push(entity.id);
      dependents[entity.id].push(parent);
    }
  }

  const srcDir = path.join(workspaceDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  writeJson(path.join(workspaceDir, '.archguard', 'query', 'manifest.json'), {
    version: '1.0',
    generatedAt,
    globalScopeKey: SCOPE_KEY,
    scopes: [{ key: SCOPE_KEY, label: 'src (typescript)', language: 'typescript', sources: [srcDir] }],
  });
  writeJson(path.join(workspaceDir, '.archguard', 'query', SCOPE_KEY, 'arch-index.json'), {
    version: '1.0',
    language: 'typescript',
    archJsonHash: ARCH_JSON_HASH,
    generatedAt,
    fileToIds,
    nameToIds,
    idToFile,
    idToName,
    dependencies,
    dependents,
  });
  writeJson(path.join(workspaceDir, '.archguard', 'query', SCOPE_KEY, 'arch.json'), {
    version: '1.0',
    language: 'typescript',
    entities: entities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: options.entityKind,
      isAbstract: false,
      members: options.entityKind === 'interface'
        ? [{ name: 'id', type: 'property', visibility: 'public', fieldType: 'string' }]
        : [
            { name: 'constructor', type: 'constructor', visibility: 'public', parameters: [] },
            { name: 'run', type: 'method', visibility: 'public', parameters: [], returnType: 'void' },
          ],
    })),
  });

  return {
    workspaceDir,
    entityTotal: entities.length,
    entityIds: entities.map((entity) => entity.id),
    seedIdentifiers,
    packageIds: packages,
  };
}
