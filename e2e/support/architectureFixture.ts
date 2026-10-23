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
 * A drawing whose relations ELK routes along the OUTSIDE of the outermost
 * package frames (the semantic viewBox used to clip them).
 */
export const ARCHITECTURE_FIXTURE_WORKSPACE_PERIMETER = 'architecture-canvas-layout-workspace-perimeter';

/** A drawing whose class payload interleaves fields and methods. */
export const ARCHITECTURE_FIXTURE_WORKSPACE_INTERLEAVED = 'architecture-canvas-layout-workspace-interleaved';

/** Which project shape to write. */
export type ArchitectureFixtureVariant =
  | 'quay-oo'
  | 'claudecodeui'
  | 'outer-perimeter'
  | 'interleaved-members'
  /** 41 classes with 7–25 members each: just past the renderer's compact threshold. */
  | 'lossless-41'
  /** 150 classes: the `compact` band's upper edge. */
  | 'lossless-150'
  /** 600 classes: the layout budget's ceiling, and the largest text fixture. */
  | 'lossless-600';

/** The scope key the manifest names; the panel and the tests never depend on its value. */
const SCOPE_KEY = 'scope-src';

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

/** Write one JSON file, creating its directory. */
function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** What one `writeArchitectureFixture` call accepts. */
export type ArchitectureFixtureOptions = {
  readonly variant?: ArchitectureFixtureVariant;
  readonly generatedAt?: string;
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
        : buildEntities(families, classMembers);
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
    ...buildIndex(entities),
    generatedAt,
  });
  writeJson(
    path.join(workspaceDir, '.archguard', 'query', SCOPE_KEY, 'arch.json'),
    buildArchive(entities, classMembers),
  );

  const seedIdentifiers = losslessCount !== null
    // Every entity is named in the session text: a bounded hop expansion from
    // one seed would not necessarily reach the whole fixture, and the lossless
    // criteria need all `count` boxes drawn.
    ? entities.map((entity) => entity.name)
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
