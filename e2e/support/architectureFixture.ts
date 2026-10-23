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
 * The other two variants are big enough that the DRAWING is what decides the
 * reading. This one is the opposite: two classes and one edge, so the only
 * thing that can make a box wide is the member text inside it — the defect
 * `architecture-node-size-from-drawn-content` fixes.
 */
export const ARCHITECTURE_FIXTURE_WORKSPACE_NODE_SIZE = 'architecture-canvas-layout-workspace-node-size';

/** Which project shape to write. */
export type ArchitectureFixtureVariant = 'quay-oo' | 'claudecodeui' | 'node-size';

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
};

/** One entity as this fixture writes it into both `arch-index.json` and `arch.json`. */
type FixtureEntity = {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly type: 'class' | 'interface' | 'function';
  readonly isAbstract: boolean;
  readonly parents: readonly string[];
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
      members: membersFor(entity.type, classMembers),
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

/** Write the two-entity workspace and answer the reading the criterion uses. */
function writeNodeSizeFixture(workspaceDir: string, generatedAt: string): ArchitectureFixtureReading {
  const fixtures: FixtureEntity[] = NODE_SIZE_ENTITIES.map((entity) => ({
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
    entities: NODE_SIZE_ENTITIES.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      isAbstract: entity.isAbstract,
      members: entity.members,
    })),
  });

  return {
    workspaceDir,
    entityTotal: NODE_SIZE_ENTITIES.length,
    entityIds: NODE_SIZE_ENTITIES.map((entity) => entity.id),
    seedIdentifiers: NODE_SIZE_SEED_IDENTIFIERS,
    variant: 'node-size',
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
  // The node-size variant is not a family shape: it states its two classes
  // directly, because the criterion is about one box's member text.
  if (variant === 'node-size') return writeNodeSizeFixture(workspaceDir, generatedAt);
  const families = variant === 'claudecodeui' ? CUI_FAMILIES : QUAY_FAMILIES;
  // Both stay past `COMPACT_MEMBER_ROWS` (4); the second shape adds one more row
  // so its upstream `(N members)` reading differs from the first's.
  const classMembers = variant === 'claudecodeui' ? 6 : 5;
  const entities = buildEntities(families, classMembers);
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

  return {
    workspaceDir,
    entityTotal: entities.length,
    entityIds: entities.map((entity) => entity.id),
    seedIdentifiers: families.map((family) => family.seed),
    variant,
  };
}
