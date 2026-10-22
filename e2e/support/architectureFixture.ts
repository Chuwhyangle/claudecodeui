/**
 * The `.archguard` cache the architecture-layout criterion measures.
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
 * SHAPE. 120 entities — the size the task names — spread across five nested
 * directory families, chained into one dependency ladder. Every family's seed
 * is one of the transcript's SEEDS (`distance 0`): camelCase function names the
 * session's user text mentions, so the server's seed extractor resolves them by
 * exact `nameToIds` match. Each seed owns three children (`distance 1`) and its
 * children own twenty grandchildren between them (`distance 2`), so the default
 * two-hop scope reaches exactly the whole fixture — there is no node the
 * reading cannot see and no node that arrives without the graph.
 *
 * KINDS. Classes, interfaces and functions all appear, and one class is
 * abstract, because the drawing is supposed to carry the entity-detail payload
 * the real cache carries rather than a flat node list.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The workspace directory the criterion creates under `QUAY_E2E_DEBUG_AGENT_HOME`. */
export const ARCHITECTURE_FIXTURE_WORKSPACE = 'architecture-canvas-layout-workspace';

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

/**
 * One directory family: its scope-relative directory, the directory its
 * grandchildren live in (a nested one for the first family, so the fixture
 * keeps a real hierarchy), its seed name and its entity-name stem.
 *
 * The families are kept FEW on purpose. The panel's overview folds entities
 * into one box per directory, so this list is what decides how many boxes the
 * drawing has — and the drawing has to stay small enough that the floating
 * corner chrome (the minimap and the zoom cluster) is not over it. On a 390 px
 * phone the cluster occupies the bottom-right fifth of the canvas; a drawing
 * that fills that canvas is under it, because the panel's corner-avoiding fit
 * models a left-aligned drawing while the canvas centres it horizontally. Five
 * families keep this fixture's drawing inside the corner-free area on both
 * viewports while the 120 entities still make the entity view a real drawing.
 */
const FAMILIES = [
  { dir: 'core/layout', deepDir: 'core/layout/steps', seed: 'layoutPlanner', stem: 'LayoutStage' },
  { dir: 'ui/panels', deepDir: 'ui/panels', seed: 'panelPlanner', stem: 'PanelStage' },
  { dir: 'adapters/io', deepDir: 'adapters/io', seed: 'ioPlanner', stem: 'IoStage' },
  { dir: 'domain/model', deepDir: 'domain/model', seed: 'modelPlanner', stem: 'ModelStage' },
  { dir: 'app/shell', deepDir: 'app/shell', seed: 'shellPlanner', stem: 'ShellStage' },
] as const;

/** Children per seed, and how many grandchildren each child owns. */
const GRANDCHILDREN_PER_CHILD = [7, 7, 6] as const;

/** What a caller needs to state its fixture and to read the graph back. */
export type ArchitectureFixtureReading = {
  /** Absolute workspace path handed to the debug agent as the scenario's `projectPath`. */
  readonly workspaceDir: string;
  /** Every entity the graph will draw (120). */
  readonly entityTotal: number;
  /** The raw entity ids, in the order the index lists them. */
  readonly entityIds: readonly string[];
  /** The identifiers the session's transcript must mention, one per family. */
  readonly seedIdentifiers: readonly string[];
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

/** The members a class or interface box carries; a function carries none. */
const membersFor = (type: FixtureEntity['type']): unknown[] => {
  if (type === 'function') return [];
  if (type === 'interface') {
    return [{ name: 'id', type: 'property', visibility: 'public', fieldType: 'string' }];
  }
  return [
    {
      name: 'constructor',
      type: 'constructor',
      visibility: 'public',
      parameters: [{ name: 'seed', type: 'number', isOptional: false }],
    },
    { name: 'weight', type: 'property', visibility: 'private', fieldType: 'number' },
    {
      name: 'measure',
      type: 'method',
      visibility: 'public',
      parameters: [{ name: 'input', type: 'string', isOptional: true }],
      returnType: 'number',
    },
  ];
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
function buildEntities(): FixtureEntity[] {
  const entities: FixtureEntity[] = [];
  FAMILIES.forEach((family, familyIndex) => {
    const seedId = `${family.dir}/${family.seed}.ts.${family.seed}`;
    const nextFamily = FAMILIES[familyIndex + 1];
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

    GRANDCHILDREN_PER_CHILD.forEach((grandchildCount, childIndex) => {
      const childName = `${family.stem}${childIndex}`;
      const childId = `${family.dir}/${childName}.ts.${childName}`;
      // One extra dependency across the SAME family pair as the seed chain:
      // ui/panels → core/layout then carries two relations, which is what makes
      // the collapsed package edge a weighted `×N` line the LOD criterion can
      // read (a fixture of single relations would leave that leg vacuous).
      const extraParent = familyIndex === 0 && childIndex === 0
        ? [`${FAMILIES[1].dir}/${FAMILIES[1].seed}.ts.${FAMILIES[1].seed}`]
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
function buildArchive(entities: readonly FixtureEntity[]): Record<string, unknown> {
  return {
    version: '1.0',
    language: 'typescript',
    entities: entities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      isAbstract: entity.isAbstract,
      members: membersFor(entity.type),
    })),
  };
}

/** Write one JSON file, creating its directory. */
function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

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
  generatedAt = new Date().toISOString(),
): ArchitectureFixtureReading {
  const entities = buildEntities();
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
    buildArchive(entities),
  );

  return {
    workspaceDir,
    entityTotal: entities.length,
    entityIds: entities.map((entity) => entity.id),
    seedIdentifiers: FAMILIES.map((family) => family.seed),
  };
}
