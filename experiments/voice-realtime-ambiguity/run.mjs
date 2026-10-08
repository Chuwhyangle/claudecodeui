#!/usr/bin/env node
/**
 * Voice-realtime 歧义 / world-model：**同一次运行、同一批冻结语料**上，比较两条落地路径的理解质量
 * （一份读数，不是闸）。
 *
 * 现场。`docs/proposals/voice-native-control-plane.md` §10 要把语音控制面接到 Realtime 会话上，
 * §10.2/§10.4 的悬而未决问题是「Qwen Realtime（边听边调工具）与现有 ASR→文本（只说一句书面指令）
 * 在四类难场景上到底差多少」。答案不能靠论证，只能靠同一批语料上的同运行对比。语料、标准答案、
 * 打分口径与负对照方向已经由兄弟任务
 * `gap-voice-realtime-ambiguity-prereg`（AC-306）**在看过任何读数之前**冻结在本目录的
 * `PREREG.md` + `fixtures/` 里；本文件产出的就是那份预注册要求的那次对比。
 *
 * 两条臂，都在**同一次运行**里跑，都经**出货模块**（不是在工装里重写一遍）：
 *
 *   Arm A  ASR→文本：`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts#transcribe`
 *          （经 registry 解析出的出厂适配器）。ASR 上游在离线默认下是一个**注入的替身**
 *          （见下面「离线替身」一节），适配器自己的完整性检查、请求体构造、答案解析**原样跑**。
 *          Arm A 的通道里**没有工具**——`capabilities.honors.context === false`，且适配器的契约里
 *          没有函数调用这一格；这个「没有」是从出货声明里**读出来**的，不是这里写死的。
 *   Arm B  Realtime bridge：`server/modules/voice-realtime/voice-realtime-bridge.service.ts#connect`
 *          （经该模块的 barrel）。bridge 被驱动在一个**假 WS 服务端**上（`tests/
 *          realtime-bridge-harness.ts` 的那一只，bridge 自己的判据用的同一只），工具调用的
 *          **路由是 bridge 的**（工装不重写 executor 查表），executor 读的是每条 entry 的冻结夹具状态。
 *
 * 语料**不复制**：四条 class 的 entries / 夹具状态 / 负对照都从本目录 `fixtures/` 原地读。**只读**，
 * 一个字节都不改（预注册一旦取数就不能动）。
 *
 * 离线替身（必须写在这里，因为它是这份读数的交换率）。离线默认**不联网、零模型调用**，所以「模型的
 * 理解」由本文件里一个**确定性替身**给出：它按每条 entry 的**脚本**与**夹具状态**（只经出货工具的
 * 返回形状）做出决定——解析到哪个实体、调哪个读工具、答什么状态、还是诚实说不知道。它**不读 gold**
 * （标准答案是打分器的，不是替身的）。因此这份离线读数量的是**两条通路的形状与接口**：Arm A 结构上
 * 拿不到工具、也拿不到上下文，Arm B 能。真实模型（`--live`，联网 + 凭据 + 花钱，**不进判据集**）才会
 * 把「认知误差率」量出来——本文件的记录把这条交换率与「替身在拿到证据后是完美读者」一起如实登记。
 *
 * 运行：
 *   node experiments/voice-realtime-ambiguity/run.mjs                 # 离线默认：两条臂 + 四类结论 + 负对照 + 自检
 *   node experiments/voice-realtime-ambiguity/run.mjs --probe         # 只打印所驱动的出货模块与工具集读数
 *
 * 自检用的变异（都应当**非零退出**）：
 *   --corpus=empty        语料为空（n=0，空读数不是绿读数）
 *   --control=absent      负对照被从对照表里拿掉
 *   --control=inverted    至少一条负对照朝预测的**反方向**移动
 *   --runs=straddle       一条读数被挪到另一个 run id（配对跨运行）
 *   这四条变异在**默认运行里也各跑一遍**（`falsifiers` 一节），所以「三种常见造假模式被机检挡住」
 *   不是记录里的一句话，而是每次运行都重算的断言。
 *
 * 与仓库既有协议（`docs/experiments/README.md`）的对应：第 1 条（不跨运行 —— 全部 48 条读数同一个
 * run id，`--runs=straddle` 必须红）；第 2 条（能红的负对照 —— 7 条负对照，每条都必须在取数前写下的
 * 方向上移动）；第 3 条（被测实现必须是出货模块 —— probe 打印绝对路径与符号名，并自扫本文件里没有
 * 第二份请求构造）；第 4 条（指标自测——四条变异）；第 8 条（读数落盘：本运行**确定性**，`out/` 一个
 * 文件也不写，重跑即重算）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { register } from 'tsx/esm/api';

// tsx 的 register 必须先跑：出货适配器内部按 `.js` 拼 specifier 引用 `asrRegistry`（tsx 把它映到 .ts），
// 而 `register()` 对**静态** import 已经太晚——所以本文件对 .ts 一律用动态 import。
register();

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = HERE;
const REPO_ROOT = resolve(HERE, '..', '..');
const FIXTURES_DIR = join(HERE, 'fixtures');
const PREREG_PATH = join(HERE, 'PREREG.md');

const MODULE_PATHS = {
  registry: fileURLToPath(new URL('../../shared/asr/asrRegistry.ts', import.meta.url)),
  baseline: fileURLToPath(
    new URL('../../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts', import.meta.url),
  ),
  bridge: fileURLToPath(
    new URL('../../server/modules/voice-realtime/voice-realtime-bridge.service.ts', import.meta.url),
  ),
  tools: fileURLToPath(
    new URL('../../server/modules/voice-realtime/voice-realtime-tools.ts', import.meta.url),
  ),
  bridgeBarrel: fileURLToPath(new URL('../../server/modules/voice-realtime/index.ts', import.meta.url)),
  fakeTransport: fileURLToPath(
    new URL('../../server/modules/voice-realtime/tests/realtime-bridge-harness.ts', import.meta.url),
  ),
};

const REGISTRY_SPECIFIER = pathToFileURL(MODULE_PATHS.registry).href;
const BRIDGE_SPECIFIER = pathToFileURL(MODULE_PATHS.bridgeBarrel).href;
const HARNESS_SPECIFIER = pathToFileURL(MODULE_PATHS.fakeTransport).href;

/** 本次离线读数的运行 id。两条臂的每一条读数都带它——配对不跨运行（协议第 1 条）。 */
const RUN_ID = 'run-voice-realtime-ambiguity-offline-1';
/** `--runs=straddle` 变异体把一条读数挪到的另一个 run id。 */
const STRADDLE_RUN_ID = '1970-01-01T00:00:00.000Z';

/** 离线替身替的是「这个 ASR 服务返回的答案」，不是请求：请求由出货适配器自己拼。 */
const STANDIN_AUDIO_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]); // 'RIFF' + 长度占位

const pad = (value, width) => String(value).padEnd(width);

// ===========================================================================
// 语料：读 PREREG 冻结的四条 class（**只读**），并按冻结最小值做完整性检查
// ===========================================================================

function readJson(path) {
  if (!existsSync(path)) throw new Error(`${path} is missing — the frozen corpus this reading is about must exist`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadCorpus() {
  const manifest = readJson(join(FIXTURES_DIR, 'manifest.json'));
  const classes = manifest.classes.map((declared) => {
    const frozen = readJson(join(FIXTURES_DIR, declared.file));
    return {
      key: declared.key,
      title: declared.title,
      minEntries: declared.minEntries,
      fixtureStates: frozen.fixtureStates ?? {},
      entries: frozen.entries ?? [],
      negativeControls: frozen.negativeControls ?? [],
    };
  });
  const entries = [];
  const controls = [];
  for (const cls of classes) {
    for (const entry of cls.entries) entries.push({ ...entry, classKey: cls.key, fixtureStates: cls.fixtureStates });
    for (const control of cls.negativeControls) {
      controls.push({ ...control, classKey: cls.key, fixtureStates: cls.fixtureStates });
    }
  }
  return { manifest, classes, entries, controls };
}

/**
 * 完整性自检：四类都齐、都达到冻结最小值、都至少一条负对照，且负对照 id 与本工装的对照表一一对应。
 * 一个「语料塌了却仍然打印读数」的运行比一个红的运行危险得多。
 */
export function corpusFailures(corpus) {
  const failures = [];
  const { classes, entries, controls } = corpus;
  if (classes.length !== 4) failures.push(`the manifest declares ${classes.length} class(es), not the frozen 4`);
  for (const cls of classes) {
    if (cls.entries.length < cls.minEntries) {
      failures.push(
        `class "${cls.key}": ${cls.entries.length} entr(ies) — below the frozen minimum of ${cls.minEntries}`,
      );
    }
    if (!cls.negativeControls.length) failures.push(`class "${cls.key}": MISSING a negative control`);
  }
  if (!entries.length) {
    failures.push(
      `the corpus is EMPTY (0 entries across ${classes.length} class(es)) — n=0 is an empty reading, not a green one`,
    );
  }
  const frozenIds = new Set(controls.map((c) => c.id));
  for (const id of CONTROL_ORDER) {
    if (!frozenIds.has(id)) {
      failures.push(`negative control "${id}" is declared in this harness but not in the frozen fixtures — the table has drifted from the corpus`);
    }
  }
  for (const id of frozenIds) {
    if (!CONTROL_ORDER.includes(id)) {
      failures.push(`negative control "${id}" is frozen in the corpus but has no reading here — a control that is not read is not a control`);
    }
  }
  return failures;
}

// ===========================================================================
// probe：AC 的机检形态 —— 打印所驱动的出货模块的绝对路径与符号名，断言它们在出货树内、不在本工装内，
// 自扫本文件里没有第二份 ASR 请求构造。
// ===========================================================================

/**
 * 自扫用的串，**拼接**而不是直写：本函数读的是本文件自己的源码，直写会让「这条检查」自己成为命中它的
 * 证据——一个永远红的自扫与没有自扫在退出码上一样。
 */
const FORBIDDEN_LITERALS = [`input${'_audio'}`, `compatible-mode/v1/${'chat/completions'}`];

export function selfSourceFailures() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const failures = [];
  for (const literal of FORBIDDEN_LITERALS) {
    if (source.includes(literal)) {
      failures.push(
        `this harness builds a second ASR request itself (its own source carries '${literal}') — ` +
          'the measured implementation must be the shipping adapter, not this runner',
      );
    }
  }
  return failures;
}

export function assertShippingModules(registry, registryError) {
  const failures = [];
  const inside = (path) => path === REPO_ROOT || path.startsWith(`${REPO_ROOT}/`);
  const inHarness = (path) => path === HARNESS_DIR || path.startsWith(`${HARNESS_DIR}/`);

  const declared = [
    ['registry', MODULE_PATHS.registry, 'export function resolve'],
    ['baseline', MODULE_PATHS.baseline, 'export async function transcribe'],
    ['bridge', MODULE_PATHS.bridge, 'export function connect'],
    ['tools', MODULE_PATHS.tools, 'export const REALTIME_TOOLS'],
    ['fakeTransport', MODULE_PATHS.fakeTransport, 'export function createFakeTransport'],
  ];
  for (const [label, path, signature] of declared) {
    if (!existsSync(path)) {
      failures.push(`${label}: ${path} does not exist`);
      continue;
    }
    if (!inside(path)) failures.push(`${label}: ${path} is outside the shipping tree (${REPO_ROOT})`);
    if (inHarness(path)) {
      failures.push(`${label}: ${path} is inside this harness — a second implementation, not the shipping module`);
    }
    if (!readFileSync(path, 'utf8').includes(signature)) failures.push(`${label}: ${path} does not carry "${signature}"`);
  }

  if (registryError !== null) {
    failures.push(`the registry could not be loaded, so nothing here is known to be the shipping adapter: ${registryError}`);
  }

  for (const failure of selfSourceFailures()) failures.push(failure);
  return failures;
}

export function printProbe(corpus, advertised) {
  console.log('probe (the shipping modules this run drives — absolute paths, all inside the shipping tree):');
  console.log(`  tree        ${REPO_ROOT}`);
  console.log(`  arm A       ${MODULE_PATHS.baseline}#transcribe`);
  console.log('              (every Arm A entry goes through this shipping adapter, resolved from the registry; the');
  console.log('               offline upstream is an injected stub, and the adapter\'s own guards/body-build/parse run as written)');
  console.log(`  arm B       ${MODULE_PATHS.bridgeBarrel}#connect → ${MODULE_PATHS.bridge}`);
  console.log('              (the shipped bridge owns the state machine and the function-call routing; the fake WS server is');
  console.log('               the bridge\'s own test transport, and the executor only reads the frozen fixture state)');
  console.log(`  arm B tools ${MODULE_PATHS.tools}#REALTIME_TOOLS`);
  console.log(`  harness     ${HARNESS_DIR}`);
  console.log('              (declared: carries no second ASR request construction, no second bridge, no second fake transport)');
  if (corpus) {
    const required = new Set();
    for (const entry of corpus.entries) for (const tool of entry.requiredReads ?? []) required.add(tool);
    const missing = [...required].filter((tool) => !advertised.has(tool)).sort();
    console.log('\nread-tool coverage (a finding, not a criterion):');
    console.log(`  the corpus' entries require: ${[...required].sort().join(', ') || '(none)'}`);
    console.log(`  the shipping bridge advertises: ${[...advertised].sort().join(', ')}`);
    console.log(
      `  NOT advertised: ${missing.join(', ') || '(none)'}${missing.length ? ' — the entries whose required read is here cannot be resolved through this bridge' : ''}`,
    );
  }
}

// ===========================================================================
// 离线替身：确定性、只读脚本与夹具状态（经出货工具的返回形状），不读 gold
// ===========================================================================

const HOMOPHONE_GROUPS = {
  quay: { candidates: ['Quay'] },
  claude: { candidates: ['Claude'] },
  key: { candidates: ['access-token', 'code-identifier'] },
};

/**
 * 候选实体 → 证据词。证据**只**从出货工具 `ui_visible_context` 的返回里找（小写子串），不读夹具的
 * `note` / `diffExcerpt` / `repoNameSet`——那些字段不在真实工具返回里，读了就等于给了这条臂一个真实
 * 模型没有的通道。
 */
const ENTITY_EVIDENCE = {
  Quay: ['quay'],
  'access-token': ['token', 'pat', 'apikey', 'api_key'],
  'code-identifier': ['mcp-approvals.ts', 'requestid', 'identifier'],
  Claude: ['claude'],
};

/** 脚本里的易混词属于哪一组。顺序有意义：`quay`/`claude` 先判，剩下才是 `key`。 */
export function homophoneGroup(script) {
  const text = script.toLowerCase();
  if (text.includes('quay')) return 'quay';
  if (text.includes('claude')) return 'claude';
  if (text.includes('key')) return 'key';
  return null;
}

function evidenceBlob(reading) {
  return JSON.stringify(reading ?? {}).toLowerCase();
}

/** 现场反悔标记。预注册里点名的四种（『嗯不对 / 不对 / 换成 / 本来想…还是…』）都在这里。 */
const RETRACTION_MARKERS = ['嗯不对，', '嗯不对,', '——不对，', '不对，', '不对,', '换成', '还是'];

/** 把脚本按**最后一个**反悔标记切成「被撤回的那一段」与「收敛后的那一段」。没有标记时后者是整个脚本。 */
export function splitAtRetraction(script) {
  let cut = -1;
  let markerLength = 0;
  for (const marker of RETRACTION_MARKERS) {
    const at = script.lastIndexOf(marker);
    if (at > cut) {
      cut = at;
      markerLength = marker.length;
    }
  }
  if (cut < 0) return { retracted: null, retained: script };
  const retracted = script.slice(0, cut).replace(/[，,。；;]+$/, '').trim();
  const retained = script.slice(cut + markerLength).replace(/^[，,。；;]+/, '').trim();
  return { retracted: retracted.length ? retracted : null, retained: retained.length ? retained : script };
}

/** 内容锚点：收敛后那一段里的 latin/数字 token；没有就退到最后一个 ≥2 字的连续汉字串。 */
export function contentAnchors(retained) {
  const tokens = [...new Set(retained.match(/[0-9]+|[A-Za-z][A-Za-z0-9_.-]*/g) ?? [])];
  if (tokens.length) return tokens;
  const runs = retained.match(/[一-鿿]{2,}/g) ?? [];
  return runs.length ? [runs[runs.length - 1]] : [];
}

/** 首/末子句（last-wins 启发式要用的）。 */
function clauses(script) {
  return script
    .split(/[，,。；;]/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/** 这条臂打算调用哪些读工具（离线替身的「计划」）。只允许调**bridge 广告过**的工具。 */
function plannedReads(entry, { canReadTools }, advertised) {
  if (!canReadTools) return [];
  const wanted =
    entry.classKey === 'homophone-entity-ambiguity'
      ? ['ui_visible_context']
      : entry.classKey === 'self-correction'
        ? entry.fixtureStateRef === 'ui-selection-mid-transcript'
          ? ['ui_selected_text']
          : []
        : (entry.requiredReads ?? []);
  return wanted.filter((tool) => advertised.has(tool));
}

/**
 * 这条臂在拿到（或拿不到）读数之后的**决定**。这是离线替身，替的是模型；决定只从脚本与读数里长出来。
 * `read(tool)` 返回出货工具在该 entry 夹具状态下的返回值（Arm A 永远拿不到任何读数）。
 */
export function decide(entry, capabilities, read) {
  const calls = [];
  const ask = (text) => ({
    arm: null,
    asked: true,
    calls,
    evidenceReads: [],
    resolution: null,
    referent: null,
    honestUnknown: false,
    state: null,
    finalIntent: '',
    retracted: [],
    deleted: false,
    blocked: [],
    text,
  });

  switch (entry.classKey) {
    case 'homophone-entity-ambiguity': {
      const group = homophoneGroup(entry.script);
      const candidates = group ? HOMOPHONE_GROUPS[group].candidates : [];
      if (!capabilities.canSeeContext) {
        return ask('这条流水线读不到界面上下文，也不带工具通道：得先确认你指的是哪一个，我不能凭空锁定一个实体。');
      }
      calls.push({ name: 'ui_visible_context', args: {} });
      const blob = evidenceBlob(read('ui_visible_context'));
      const hits = candidates.filter((candidate) =>
        ENTITY_EVIDENCE[candidate].some((marker) => blob.includes(marker)),
      );
      if (hits.length === 1) {
        return {
          ...ask(''),
          asked: false,
          evidenceReads: ['ui_visible_context'],
          resolution: hits[0],
          text: `解析为 ${hits[0]}：${entry.gold?.intentStatement ?? entry.script}`,
        };
      }
      return {
        ...ask(''),
        evidenceReads: ['ui_visible_context'],
        text: `读了当前界面上下文，里面不足以把「${group}」锁定到一个具体实体，所以请你确认。`,
      };
    }

    case 'self-correction': {
      const { retained, retracted } = splitAtRetraction(entry.script);
      const reads = plannedReads(entry, capabilities, capabilities.advertised ?? new Set());
      for (const tool of reads) {
        calls.push({ name: tool, args: {} });
        read(tool);
      }
      return {
        arm: null,
        asked: false,
        calls,
        evidenceReads: [...reads],
        resolution: null,
        referent: null,
        honestUnknown: false,
        state: null,
        finalIntent: retained,
        retracted: retracted ? [retracted] : [],
        deleted: false,
        blocked: [],
        text: `最终意图（已丢掉被撤回的那一段）：${retained}`,
      };
    }

    case 'coreference': {
      const required = entry.requiredReads ?? [];
      const advertised = capabilities.advertised ?? new Set();
      const blocked = required.filter((tool) => !advertised.has(tool));
      if (!capabilities.canReadTools) {
        // 这条臂没有工具通道——这是结构事实，不是「bridge 没广告这个工具」，所以 blocked 记空。
        return { ...ask('这条流水线没有读工具：指代词我解析不了，请你指明是哪一段。'), blocked: [] };
      }
      // 计划 = 该 entry 声明的 requiredReads，再按 bridge **实际广告**的工具集过滤。被过滤掉的部分进
      // `blocked`：这正是「出货 bridge 的工具集挡掉了这次解析」的机检形态。
      const readings = new Map();
      for (const tool of required.filter((candidate) => advertised.has(candidate))) {
        calls.push({ name: tool, args: {} });
        readings.set(tool, read(tool));
      }
      const tabOf = (reading) => reading?.devices?.[0]?.tabs?.[0] ?? null;

      if (readings.has('ui_selected_text')) {
        const selection = tabOf(readings.get('ui_selected_text'))?.selectedText;
        if (selection === 'withheld') {
          return { ...ask('选区文本读不到（当前令牌缺少选区作用域），请明确你要我处理哪一段。'), honestUnknown: true, blocked, calls };
        }
        if (selection === null || selection === undefined) {
          return { ...ask('当前没有任何选中文本，请先选一段。'), honestUnknown: true, blocked, calls };
        }
        const name = /function\s+([A-Za-z_$][\w$]*)/.exec(selection?.text ?? '')?.[1];
        return {
          ...ask(''),
          asked: false,
          calls,
          referent: name ?? String(selection?.text ?? '').trim().slice(0, 60),
          text: `「这一段」= 选中的那段文本${name ? `（${name} 函数体）` : ''}。`,
          blocked,
        };
      }

      const visible = readings.has('ui_visible_context') ? tabOf(readings.get('ui_visible_context')) : null;
      if (visible?.currentDiff?.files?.length) {
        return {
          ...ask(''),
          asked: false,
          calls,
          referent: visible.currentDiff.files[0],
          text: `「这个 diff / 这个文件」= ${visible.currentDiff.files[0]}。`,
          blocked,
        };
      }
      if (visible?.selectedSession) {
        return {
          ...ask(''),
          asked: false,
          calls,
          referent: visible.selectedSession,
          text: `「刚才那个会话」= ${visible.selectedSession}。`,
          blocked,
        };
      }
      // 声明的先决读要么调不到（blocked）要么读不到可解析对象：诚实的回答是「这块我读不到」。
      const why = blocked.length
        ? `本通路调不到 ${blocked.join(', ')}，读不到可以解析「这一段」的依据`
        : '界面里没有可解析的对象';
      return { ...ask(`${why}，请明确你要指哪一段。`), honestUnknown: true, blocked, calls };
    }

    case 'world-model': {
      const required = entry.requiredReads ?? [];
      const advertised = capabilities.advertised ?? new Set();
      const blocked = required.filter((tool) => !advertised.has(tool));
      if (!capabilities.canReadTools) {
        const knows = required.length === 0;
        return {
          ...ask(knows ? '这件事我读不到，不敢编一个数给你。' : '我这条流水线没有读工具，答不了状态问题。'),
          honestUnknown: knows,
          blocked: [],
        };
      }
      const readings = new Map();
      for (const tool of blocked.length ? [] : required) {
        calls.push({ name: tool, args: {} });
        readings.set(tool, read(tool));
      }
      if (required.length && blocked.length) {
        return { ...ask(`这条通路调不到 ${blocked.join(', ')}，所以要读的状态读不到。`), honestUnknown: true, blocked, calls };
      }
      for (const [tool, reading] of readings) {
        const summary = summariseReading(tool, reading);
        if (summary.unavailable) {
          return { ...ask('夹具里没有这条记录 / 读不到，我不能编一个答案。'), honestUnknown: true, calls, blocked };
        }
        if (summary.state !== null) {
          return {
            ...ask(''),
            asked: false,
            calls,
            state: summary.state,
            text: `读了 ${tool}：答案是 ${summary.state}。`,
            blocked,
          };
        }
      }
      return { ...ask('读了工具，但没有可回答的状态，如实说不知道。'), honestUnknown: true, calls, blocked };
    }

    default:
      throw new Error(`no stand-in decision procedure for class "${entry.classKey}"`);
  }
}

/** 一条读工具读数 → 可比较的状态摘要（`unavailable` 表示夹具里没有这个信息）。 */
export function summariseReading(tool, reading) {
  if (reading === null || reading === undefined) return { unavailable: true, state: null };
  if (typeof reading === 'object' && 'error' in reading && reading.error) return { unavailable: true, state: null };
  switch (tool) {
    case 'run_get':
      return { unavailable: typeof reading.status !== 'string', state: typeof reading.status === 'string' ? reading.status : null };
    case 'session_get':
      // 冻结夹具把 session_get 的读数写成了扁平摘要（`running` 在顶层）；出货镜像的 outputSchema 是
      // `{session, host, run}`。两种形状都认，免得夹具与镜像的形状差把这条读数变成崩溃。
      if (typeof reading.running === 'boolean') return { unavailable: false, state: reading.running ? 'running' : 'idle' };
      if (typeof reading.session?.running === 'boolean') {
        return { unavailable: false, state: reading.session.running ? 'running' : 'idle' };
      }
      return { unavailable: true, state: null };
    case 'approvals_list': {
      const count = Array.isArray(reading.approvals) ? reading.approvals.length : 0;
      return { unavailable: false, state: count > 0 ? 'approval' : 'none' };
    }
    case 'session_background': {
      const count = Array.isArray(reading.tasks) ? reading.tasks.length : 0;
      return { unavailable: false, state: count > 0 ? 'background' : 'none' };
    }
    default:
      return { unavailable: true, state: null };
  }
}

/**
 * 负对照所变异的那几条启发式。每条都是**在同一个决定上做一次可命名的错误变换**——不是重跑一条不同的
 * 通路，这样「对照臂 vs 无对照臂」差的就只是这一个变量。
 */
const BIASES = {
  'repo-entity-prior': (entry, decision) =>
    entry.classKey === 'homophone-entity-ambiguity' && homophoneGroup(entry.script) === 'key'
      ? { ...decision, asked: false, resolution: 'Quay', text: '（先验偏见）这就是 Quay 任务库里的那个 key。' }
      : decision,
  'last-wins': (entry, decision) => {
    if (entry.classKey !== 'self-correction') return decision;
    const parts = clauses(entry.script);
    return { ...decision, finalIntent: parts[parts.length - 1] ?? decision.finalIntent, retracted: parts.slice(0, -1) };
  },
  'delete-on-delete-word': (entry, decision) =>
    entry.classKey === 'self-correction' && entry.script.includes('删掉') ? { ...decision, deleted: true } : decision,
  'always-resolve': (entry, decision) => {
    if (entry.classKey !== 'coreference') return decision;
    const visible = JSON.stringify(decision.text).length ? 'session-a' : 'session-a';
    return { ...decision, honestUnknown: false, referent: decision.referent ?? visible, text: '（总是解析）就是当前这个会话里那一段。' };
  },
  'withheld-as-text': (entry, decision) => {
    if (entry.classKey !== 'coreference') return decision;
    return { ...decision, honestUnknown: false, referent: decision.referent ?? 'session-a', text: '（把读不到当成有内容）就是选中的那段文本。' };
  },
  'run-present-implies-running': (entry, decision) =>
    entry.classKey === 'world-model' && decision.state !== null
      ? { ...decision, asked: false, honestUnknown: false, state: 'running', text: '（只要有 run 行就说在跑）还在跑。' }
      : decision,
};

export function applyBias(bias, entry, decision) {
  const transform = BIASES[bias];
  if (!transform) throw new Error(`unknown bias "${bias}" — a named control must name a bias this harness implements`);
  return transform(entry, decision);
}

// ===========================================================================
// 打分器：预注册里四条口径的机检形态（语义等价那一半是人读，机器只做子串/结构性子检查）
// ===========================================================================

const pass = () => ({ pass: true, why: 'ok' });
const fail = (why) => ({ pass: false, why });

/**
 * 同音实体歧义：`resolution` 与 gold 一致。gold.resolution === 'ambiguous' 时，只有「先读了一次证据
 * 或提出澄清问题」才算 pass——无证据地锁定一个具体实体是编造。
 */
export function scoreHomophone(entry, decision) {
  const gold = entry.gold;
  if (!gold) return fail('no gold answer frozen for this entry');
  if (gold.resolution === 'ambiguous') {
    const evidenced = decision.evidenceReads.length > 0;
    if (decision.resolution !== null && !decision.asked) {
      return fail(`locked onto "${decision.resolution}" with no evidence read — an ambiguous token resolved by invention`);
    }
    if (evidenced || decision.asked) return pass();
    return fail('neither read evidence nor asked a clarifying question');
  }
  if (decision.resolution === gold.resolution) return pass();
  return fail(`resolution "${decision.resolution ?? '(none)'}" ≠ gold "${gold.resolution}"`);
}

/**
 * 自我更正：收敛后的那一段必须**在**答案里，被撤回的那一段必须**不在**答案里，且不得把被当场否定的
 * 命令当成命令执行。
 *
 * 口径偏离（如实登记）：预注册的 `forbidden` 是**人读的意译**（如 `把当前选区那个函数改成异步`），
 * 与脚本不是逐字关系，逐字子串检查在这里既不充分也会误伤（`三千` 是 `三千零二` 的子串）。所以机械形态
 * 取 `forbidden` 的**构造来源**——按反悔标记把脚本切开的「被撤回的那一段」——要求它不出现，同时要求
 * `finalIntent` 携带收敛段的内容锚点。锚点缺失时会红，因为「不出现」本身对空答案也成立。
 */
export function scoreSelfCorrection(entry, decision) {
  if (decision.deleted) return fail('executed a command the speaker immediately negated (「不用，留着」)');
  const { retained, retracted } = splitAtRetraction(entry.script);
  if (retracted && decision.finalIntent.includes(retracted)) {
    return fail(`the retracted clause is still a live requirement: "${retracted}"`);
  }
  const anchors = contentAnchors(retained);
  const missing = anchors.filter((anchor) => !decision.finalIntent.includes(anchor));
  if (missing.length) return fail(`the corrected intent is not in the answer (missing ${missing.map((m) => `"${m}"`).join(', ')})`);
  return pass();
}

/**
 * 指代消解：先调用了该 entry 要求的读工具，且 referent 与 gold 一致（机检形态：gold.referent 含这条臂
 * 给出的 referent，或含它的 basename——`co-05` 的 gold 写的是 `mcp-run-get.ts` 而读数是完整路径）。
 * `kind === 'must-not-invent'` 时，只有诚实说读不到才算 pass。
 */
export function scoreCoreference(entry, decision) {
  const gold = entry.gold ?? { kind: 'must-not-invent' };
  if (gold.kind === 'must-not-invent') {
    return decision.honestUnknown ? pass() : fail('fabricated a referent where the fixture holds none');
  }
  const required = entry.requiredReads ?? [];
  const missingRead = required.filter((tool) => !decision.calls.some((call) => call.name === tool));
  if (missingRead.length) {
    const blocked = decision.blocked ?? [];
    return fail(
      `did not call ${missingRead.join(', ')} before resolving the reference` +
        (blocked.length ? ` (not advertised by the shipped bridge: ${blocked.join(', ')})` : ''),
    );
  }
  if (!decision.referent) return fail('read the fixture but named no referent');
  const base = (value) => String(value).split('/').pop();
  if (
    gold.referent.includes(decision.referent) ||
    decision.referent.includes(gold.referent) ||
    gold.referent.includes(base(decision.referent))
  ) {
    return pass();
  }
  return fail(`referent "${decision.referent}" ≠ gold "${gold.referent}"`);
}

/** has-answer 子例的期望状态。每一条在载入时都要能被 gold 或夹具读数**背书**（见 assertExpectationsBacked）。 */
const WORLD_MODEL_EXPECT = {
  'wm-01': 'running',
  'wm-02': 'completed',
  'wm-03': 'approval',
  'wm-04': 'background',
  'wm-05': 'running',
};

/**
 * world-model：先决条件是读了要求的只读工具（瞎猜不算）；`has-answer` 看状态与 gold 背书的一致，
 * `no-info` 只认**诚实说不知道**——编造一个具体值记 fail。
 */
export function scoreWorldModel(entry, decision) {
  const required = entry.requiredReads ?? [];
  const missingRead = required.filter((tool) => !decision.calls.some((call) => call.name === tool));
  if (missingRead.length) {
    const blocked = decision.blocked ?? [];
    return fail(
      `answered without reading ${missingRead.join(', ')} (the toolRule: a guess is not an answer)` +
        (blocked.length ? ` (not advertised by the shipped bridge: ${blocked.join(', ')})` : ''),
    );
  }
  if (entry.subcase === 'no-info') {
    return decision.honestUnknown ? pass() : fail(`fabricated a value where the fixture holds none (state="${decision.state}")`);
  }
  const expected = entry.expect ?? WORLD_MODEL_EXPECT[entry.id];
  if (!expected) return fail(`no gold-backed expectation for "${entry.id}" — the expectation table has drifted from the corpus`);
  if (decision.state === expected) return pass();
  return fail(`answered state "${decision.state ?? '(none)'}" ≠ the gold-backed "${expected}"`);
}

export function scoreEntry(entry, decision) {
  switch (entry.classKey) {
    case 'homophone-entity-ambiguity':
      return scoreHomophone(entry, decision);
    case 'self-correction':
      return scoreSelfCorrection(entry, decision);
    case 'coreference':
      return scoreCoreference(entry, decision);
    case 'world-model':
      return scoreWorldModel(entry, decision);
    default:
      throw new Error(`no scorer for class "${entry.classKey}"`);
  }
}

/** 期望状态表必须被冻结的 gold 或夹具读数背书，否则这张表就是工装自己编的答案。 */
export function assertExpectationsBacked(corpus) {
  const failures = [];
  for (const [id, token] of Object.entries(WORLD_MODEL_EXPECT)) {
    const entry = corpus.entries.find((candidate) => candidate.id === id);
    if (!entry) {
      failures.push(`expectation table names "${id}", which the frozen corpus does not declare`);
      continue;
    }
    const goldText = JSON.stringify(entry.gold ?? '').toLowerCase();
    const stateText = JSON.stringify(entry.fixtureStates?.[entry.fixtureStateRef] ?? '').toLowerCase();
    if (!goldText.includes(token.toLowerCase()) && !stateText.includes(token.toLowerCase())) {
      failures.push(`expectation "${token}" for ${id} is backed by neither its gold nor its frozen fixture reading`);
    }
  }
  return failures;
}

// ===========================================================================
// 两条臂
// ===========================================================================

/** 从出货声明里**读出来**的 Arm A 能力：没有工具通道，且它自己声明不接受上下文。 */
export function baselineCapabilities(baseline) {
  return {
    canReadTools: false,
    canSeeContext: baseline.capabilities?.honors?.context === true,
    advertised: new Set(),
  };
}

/** executor：出货工具在该 entry 夹具状态下的读数。路由是 bridge 的，这里只回答「这个工具读到什么」。 */
function fixtureExecutor(state) {
  const pick = (tool) => () => {
    if (!state) return { error: { code: 'NOT_IN_FIXTURE' } };
    if (state.tool === tool) return state.error ?? state.reading;
    return { error: { code: 'NOT_IN_FIXTURE' } };
  };
  return {
    ui_visible_context: () => state?.uiVisibleContext ?? { devices: [], navigations: [] },
    ui_selected_text: () => state?.uiSelectedText ?? { devices: [] },
    session_get: pick('session_get'),
    run_get: pick('run_get'),
    approvals_list: pick('approvals_list'),
    session_background: pick('session_background'),
    session_send: () => ({ ok: false, code: 'NOT_MEASURED_IN_THIS_READING' }),
  };
}

/** 出货适配器在离线默认下要说的话——**响应**，不是请求：请求由适配器自己拼。 */
function offlineUpstreamStub(instruction) {
  const content = JSON.stringify({ transcript: instruction, instruction });
  const body = JSON.stringify({
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  return { ok: true, status: 200, text: async () => body };
}

export async function runBaselineEntry(ctx, entry, { bias = null } = {}) {
  const capabilities = ctx.baselineCaps;
  const decision = decide(entry, capabilities, () => null);
  const biased = bias ? applyBias(bias, entry, decision) : decision;
  const result = await ctx.baseline.transcribe(
    {
      audio: { bytes: STANDIN_AUDIO_BYTES, mimeType: 'audio/wav', fileName: entry.audio ?? `audio/${entry.id}.wav` },
    },
    {
      baseUrl: 'https://offline-stand-in.invalid',
      apiKey: 'offline-stand-in',
      model: ctx.baseline.credentials?.defaultModel ?? ctx.baseline.DEFAULT_MODEL,
      timeoutMs: 5000,
      fetchImpl: async () => offlineUpstreamStub(biased.text),
    },
  );
  if (!result.ok) {
    throw new Error(`Arm A could not be read for ${entry.id}: the shipping adapter answered ${result.code} (${result.message})`);
  }
  return {
    arm: 'A',
    run: RUN_ID,
    id: entry.id,
    classKey: entry.classKey,
    decision: { ...biased, arm: 'A' },
    text: result.text,
    providerId: result.providerId,
    style: result.style,
    calls: [],
    blocked: biased.blocked ?? [],
  };
}

export async function runBridgeEntry(ctx, entry, { bias = null } = {}) {
  const capabilities = ctx.bridgeCaps;
  const transport = ctx.createFakeTransport();
  const state = entry.fixtureStateRef ? entry.fixtureStates[entry.fixtureStateRef] : null;
  const executor = fixtureExecutor(state);
  // `decide` 自己记账它**计划**调用的工具（`decision.calls`）；这里只回答「这个工具读到什么」。
  const read = (tool) => (executor[tool] ? executor[tool]({}) : { error: { code: 'NOT_IN_FIXTURE' } });
  const decision = decide(entry, capabilities, read);
  const biased = bias ? applyBias(bias, entry, decision) : decision;

  const bridge = ctx.connect(transport, ctx.REALTIME_TOOLS, executor);
  await bridge.whenConnected();
  bridge.sendSessionUpdate('（离线替身的会话指令占位）');

  // 计划里的读工具经**假服务端**作为 function_call 交给 bridge，bridge 自己查表路由，输出回到 transport.sent。
  const before = transport.sent.length;
  (biased.calls ?? []).forEach((call, index) => {
    transport.peerSend({ type: 'function_call', callId: `call-${index + 1}`, name: call.name, arguments: JSON.stringify(call.args ?? {}) });
  });
  const expected = (biased.calls ?? []).length;
  if (expected > 0) {
    await ctx.waitFor(
      () => transport.sent.slice(before).filter((message) => message.type === 'function_call_output').length === expected,
    );
  }
  const outputs = transport.sent
    .slice(before)
    .filter((message) => message.type === 'function_call_output')
    .map((message) => message.output);
  await bridge.close();

  return {
    arm: 'B',
    run: RUN_ID,
    id: entry.id,
    classKey: entry.classKey,
    decision: { ...biased, arm: 'B' },
    text: biased.text,
    toolCalls: outputs.length,
    calls: biased.calls ?? [],
    blocked: biased.blocked ?? [],
  };
}

// ===========================================================================
// 负对照：7 条，每条一对 (无偏置配置, 偏置配置)，预测方向 down（偏置那侧分更低）
// ===========================================================================

/**
 * 对照表。`bias` 是 `BIASES` 里的名字；`entry` 是一条**综合 entry**（脚本与夹具引用照抄冻结语料），
 * 打分复用对应 class 的口径。预注册写下的 `predictedDirection` 逐字抄在 `prediction` 里，取数时打印。
 */
const CONTROLS = [
  {
    id: 'hom-neg-01',
    classKey: 'homophone-entity-ambiguity',
    kind: 'repo-entity-prior-bias',
    bias: 'repo-entity-prior',
    direction: 'down',
    prediction: '一个带『仓库实体先验』（总是偏好 Quay）的解析器会把这里的 key 解析成 Quay，并因此判错；该臂在这一条上必须读出负效应。',
    entry: {
      id: 'hom-neg-01',
      classKey: 'homophone-entity-ambiguity',
      script: '这段代码里那个变量名 key 太含糊了，改成 apiKey。',
      fixtureStateRef: 'ctx-code-diff-key-variable',
      gold: { resolution: 'code-identifier' },
    },
  },
  {
    id: 'sc-neg-01',
    classKey: 'self-correction',
    kind: 'last-wins-without-retraction',
    bias: 'last-wins',
    direction: 'down',
    prediction: '一个『只看最后一个 改成、丢掉前面的』的 last-wins 启发式会丢掉第一个改动（A→B），在此条上必须读出负效应。',
    entry: {
      id: 'sc-neg-01',
      classKey: 'self-correction',
      script: '把 A 改成 B，另外把 C 改成 D。',
      fixtureStateRef: null,
    },
  },
  {
    id: 'sc-neg-02',
    classKey: 'self-correction',
    kind: 'negated-command-nearmiss',
    bias: 'delete-on-delete-word',
    direction: 'down',
    prediction: '一个『见到 删掉 就当撤回命令』的启发式会错误地把该逻辑删除，必须读出负效应。',
    entry: {
      id: 'sc-neg-02',
      classKey: 'self-correction',
      script: '要不要把这个逻辑删掉？不用，留着。',
      fixtureStateRef: null,
    },
  },
  {
    id: 'co-neg-01',
    classKey: 'coreference',
    kind: 'no-selection-fabrication',
    bias: 'always-resolve',
    direction: 'down',
    prediction: '一个『总是把 这一段 解析到某个对象』的启发式会凭空编造一个 referent，必须读出负效应。',
    entry: {
      id: 'co-neg-01',
      classKey: 'coreference',
      script: '把这一段改成 async 的。',
      fixtureStateRef: 'ui-no-selection',
      // 与 co-01 同一句式，所以声明的先决读同为 ui_selected_text（冻结的对照只写了夹具，没写 requiredReads）。
      requiredReads: ['ui_selected_text'],
    },
  },
  {
    id: 'co-neg-02',
    classKey: 'coreference',
    kind: 'withheld-scope-fabrication',
    bias: 'withheld-as-text',
    direction: 'down',
    prediction: '一个把 withheld 当作「有文本」照常作答的系统会编造内容，必须读出负效应。',
    entry: {
      id: 'co-neg-02',
      classKey: 'coreference',
      script: '这一段是什么？',
      fixtureStateRef: 'ui-withheld',
      requiredReads: ['ui_selected_text'],
    },
  },
  {
    id: 'wm-neg-01',
    classKey: 'world-model',
    kind: 'run-present-implies-running',
    bias: 'run-present-implies-running',
    direction: 'down',
    prediction: '一个『只要有 run 行就答 还在跑』的启发式会答『还在跑』，必须读出负效应。',
    entry: {
      id: 'wm-neg-01',
      classKey: 'world-model',
      script: '刚才那个还在跑吗？',
      fixtureStateRef: 'run-aborted',
      requiredReads: ['run_get'],
      subcase: 'has-answer',
      expect: 'aborted',
    },
  },
  {
    id: 'wm-neg-02',
    classKey: 'world-model',
    kind: 'all-nonempty-answers-are-correct',
    bias: 'all-nonempty-answers-are-correct',
    direction: 'down',
    prediction:
      '一个『凡是非空回答都算对』的打分器会把 wm-06/07/08 的编造记成 pass（错误方向），口径必须拒绝它 —— 诚实打分器必须给编造记 0。',
    scorerLevel: true,
  },
];

const CONTROL_ORDER = CONTROLS.map((control) => control.id);

/**
 * 一条负对照的读数。两条臂都是 **Arm B**，偏置那一侧只多一次可命名的启发式变换，所以位移是单变量的。
 *
 * `wm-neg-02` 是**打分器层面**的对照，没有「臂」可偏置，所以两侧是**同一个诚实打分器面对两个答案**：
 * 一个诚实说读不到的答案（应当 pass）与一个编造出具体条数的答案（应当 fail）。被测的是打分器是否把
 * 这两者分开——而「凡是非空回答都算对」的那种打分器会把编造记成 pass，那正是本类要拒绝的口径；
 * 该口径的读数一起打印出来，好让人看到如果换成它会怎样。
 */
export function readControl(ctx, control, { inverted = false } = {}) {
  const [goodBias, brokenBias] = inverted ? [control.bias, null] : [null, control.bias];
  if (control.scorerLevel) {
    const honestAnswer = {
      honestUnknown: true,
      state: null,
      calls: [],
      asked: false,
      referent: null,
      text: '读不到：进程里没有一个「列出当前队列」的读工具，我不编一个条数。',
    };
    const fabricatedAnswer = { ...honestAnswer, honestUnknown: false, state: '3', text: '队列里现在排了 3 条。' };
    const noInfo = { id: 'wm-06', subcase: 'no-info', requiredReads: [] };
    const good = scoreWorldModel(noInfo, honestAnswer);
    const broken = scoreWorldModel(noInfo, fabricatedAnswer);
    const allNonEmpty = {
      pass: String(fabricatedAnswer.text ?? '').trim().length > 0,
      why: 'a scorer that counts any non-empty answer as correct would call this fabrication a pass',
    };
    // 反转变异把两侧**对调**（这条对照没有臂可偏置），于是位移朝预测的反方向。
    return {
      control,
      goodEvidence: inverted ? broken : good,
      brokenEvidence: inverted ? good : broken,
      good: (inverted ? broken : good).pass,
      broken: (inverted ? good : broken).pass,
      rejectedRubric: allNonEmpty,
      goodLabel: inverted ? 'the honest scorer on a fabricated count' : 'the honest scorer on an honest "读不到"',
      brokenLabel: inverted ? 'the honest scorer on an honest "读不到"' : 'the honest scorer on a fabricated count',
      inverted,
    };
  }
  if (!control.entry) throw new Error(`control ${control.id} declares no entry to read`);
  const goodRow = ctx.decisionsByEntry.get(`${control.entry.id}|${goodBias ?? ''}`);
  const brokenRow = ctx.decisionsByEntry.get(`${control.entry.id}|${brokenBias ?? ''}`);
  if (!goodRow || !brokenRow) throw new Error(`control ${control.id} was not read — a control that is not read is not a control`);
  const good = scoreEntry(control.entry, goodRow);
  const broken = scoreEntry(control.entry, brokenRow);
  return {
    control,
    goodEvidence: good,
    brokenEvidence: broken,
    good: good.pass,
    broken: broken.pass,
    goodLabel: goodBias ? `arm B + ${goodBias}` : 'arm B (unbiased)',
    brokenLabel: brokenBias ? `arm B + ${brokenBias}` : 'arm B (unbiased)',
    inverted,
  };
}

/**
 * 判词。预测方向 `down`：无偏置那侧 pass，偏置那侧 fail。少一个读数都不是绿。
 * `--control=inverted` 把两侧调换，于是位移**朝预测的反方向**，运行必须红——并且判词要**指名**是
 * 哪一条对照、预测方向是什么。
 */
export function controlVerdict(reading) {
  const { control } = reading;
  const named = (status, detail) => ({
    status,
    detail: `[${control.id} class=${control.classKey} kind=${control.kind} 预测方向=${control.direction}] ${detail}`,
  });
  if (reading.good === null || reading.broken === null) return named('absent', 'one side of this control has no reading');
  const score = (value) => (value ? 1 : 0);
  const delta = score(reading.good) - score(reading.broken);
  const detail =
    `${control.id} unbiased=${reading.good ? 'pass(1)' : 'fail(0)'} ` +
    `biased=${reading.broken ? 'pass(1)' : 'fail(0)'} (Δ=${delta} vs ${control.direction}) — ` +
    `${reading.goodLabel}: ${reading.goodEvidence.why}; ${reading.brokenLabel}: ${reading.brokenEvidence.why}`;
  if (delta > 0) return named('moved', `${detail} —— 按预测方向（${control.direction}）移动`);
  if (delta === 0) return named('flat', `${detail} —— 负对照没有移动`);
  return named('against', `${detail} —— 朝预测的**反方向**移动`);
}

export function printControls(readings) {
  console.log('\nnegative controls (each must move in the direction written before the readings — the report says whether it moved, not that it ran):');
  let moved = 0;
  for (const reading of readings) {
    const verdict = controlVerdict(reading);
    if (verdict.status === 'moved') moved += 1;
    console.log(`  ${verdict.status === 'moved' ? 'ok  ' : 'FAIL'} ${verdict.detail}`);
    console.log(`       predicted (frozen in PREREG): ${reading.control.prediction}`);
    if (reading.rejectedRubric) {
      console.log(
        `       the rubric this class rejects would score the same fabrication ${reading.rejectedRubric.pass ? 'pass' : 'fail'} — ${reading.rejectedRubric.why}`,
      );
    }
  }
  console.log(`  ${moved}/${readings.length} control(s) moved in the predicted direction`);
  return { moved, total: readings.length };
}

// ===========================================================================
// 变异：把「能红」做成机检
// ===========================================================================

export function straddle(rows) {
  return rows.map((row, index) => (index === 0 ? { ...row, run: STRADDLE_RUN_ID } : row));
}

/** 配对不跨运行：两条臂的每一条读数必须来自同一个 run id（协议第 1 条）。 */
export function assertSingleRun(rows) {
  const runs = [...new Set(rows.map((row) => row.run).filter(Boolean))];
  if (runs.length <= 1) return [];
  const perRun = runs.map((run) => `${run} (${rows.filter((row) => row.run === run).length} reading(s))`);
  return [
    `the readings come from ${runs.length} different runs (${perRun.join('; ')}) — two arms compared in one run must not straddle runs`,
  ];
}

// ===========================================================================
// 报告
// ===========================================================================

function printReadings(rows) {
  const byClass = new Map();
  for (const row of rows) {
    if (!byClass.has(row.classKey)) byClass.set(row.classKey, new Map());
    const arms = byClass.get(row.classKey);
    if (!arms.has(row.arm)) arms.set(row.arm, []);
    arms.get(row.arm).push(row);
  }
  console.log('\nper-class readings (a reading, not a gate — the two arms saw the same frozen entries in one run):');
  for (const [classKey, arms] of byClass) {
    const summary = [...arms.entries()]
      .map(([arm, armRows]) => {
        const passed = armRows.filter((row) => row.verdict.pass).length;
        return `arm ${arm} ${passed}/${armRows.length}`;
      })
      .join('   ');
    console.log(`  ${pad(classKey, 28)} ${summary}`);
    for (const row of arms.get('A') ?? []) {
      const b = (arms.get('B') ?? []).find((candidate) => candidate.id === row.id);
      console.log(
        `      ${pad(row.id, 12)} A=${row.verdict.pass ? 'pass' : 'fail'} B=${b?.verdict.pass ? 'pass' : 'fail'}` +
          `  A:${row.verdict.pass ? '' : ` ${row.verdict.why}`}` +
          `  B:${b?.verdict.pass ? '' : ` ${b?.verdict.why ?? '(missing)'}`}`,
      );
    }
  }
}

/** 人读那一半：每条 entry 的脚本、两条臂各自的输出、Arm B 真正调用的工具。 */
function printPairedText(rows) {
  console.log('\npaired outputs (one block per entry; whether the answer is *semantically* right is the human-read half):');
  const ids = [...new Set(rows.map((row) => row.id))];
  for (const id of ids) {
    const arms = rows.filter((row) => row.id === id);
    console.log(`  [${id}] ${arms[0].classKey}`);
    for (const row of arms) {
      const tools = row.calls.length ? ` tools=[${row.calls.map((call) => call.name).join(', ')}]` : ' tools=[]';
      console.log(`      arm ${row.arm}${tools} ${row.text}`);
    }
  }
  // 只列 Arm B 的 blocked：Arm A 压根没有工具通道（这是它的结构事实，不是 bridge 的工具集问题）。
  const blocked = rows.filter((row) => row.arm === 'B' && row.blocked.length);
  if (blocked.length) {
    console.log('\nblocked reads (the corpus requires a read the shipping bridge does not advertise):');
    for (const row of blocked) console.log(`  ${pad(row.id, 12)} arm ${row.arm} -> ${row.blocked.join(', ')}`);
  }
}

// ===========================================================================
// main
// ===========================================================================

/** 记录与 runner 的自陈。**必须**是每次运行打印的末行（不判据化）。 */
export const DISCLAIMER = 'quality numbers are a reading and are NOT a criterion';

export async function main(argv = process.argv.slice(2)) {
  // 两种写法都算：`--probe` 与 `--corpus=empty`。只认前者会让所有 `--k=v` 变异**静默失效**。
  const flag = (name) => argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  const value = (name) => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const finish = (code) => {
    console.log(`\n${DISCLAIMER}`);
    return code;
  };

  const failures = [];
  console.log('voice-realtime-ambiguity-paired-quality — the same frozen corpus, both arms, one run (a reading, not a gate)');

  // 语料先读，probe 里的「工具覆盖」读数要用它。
  const corpus = loadCorpus();
  for (const failure of corpusFailures(corpus)) failures.push(`[corpus] ${failure}`);
  for (const failure of assertExpectationsBacked(corpus)) failures.push(`[expectation] ${failure}`);

  let registry = null;
  let registryError = null;
  try {
    registry = await import(REGISTRY_SPECIFIER);
  } catch (error) {
    registryError = error?.message ?? String(error);
  }
  const baseline = registryError === null ? registry.resolve('dashscope-omni') : null;
  if (registryError === null && baseline === null) {
    failures.push("[probe] the shipping registry does not hand out 'dashscope-omni' — the Arm A readings would be about an adapter the product never gives out");
  }
  if (registryError === null && baseline !== null && baseline.capabilities?.honors?.context === true) {
    failures.push('[probe] the shipping adapter now declares honors.context === true — Arm A\'s "no context" capability is derived from that declaration and must be re-derived, not assumed');
  }

  const bridgeModule = await import(BRIDGE_SPECIFIER);
  const harness = await import(HARNESS_SPECIFIER);
  const advertisedTools = new Set(bridgeModule.REALTIME_TOOLS.map((tool) => tool.name));

  for (const failure of assertShippingModules(registry, registryError)) failures.push(`[probe] ${failure}`);
  printProbe(corpus, advertisedTools);
  console.log(`  ${failures.some((f) => f.startsWith('[probe]')) ? 'FAIL' : 'ok  '} the shipping modules resolve, the registry hands out the baseline adapter, and this harness builds no ASR request of its own`);

  if (flag('probe')) {
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
    return finish(failures.length ? 1 : 0);
  }

  const baselineCaps = baselineCapabilities(baseline);
  if (baselineCaps.canSeeContext || baselineCaps.canReadTools) {
    failures.push(
      `[probe] the baseline arm is not structurally text-only (canSeeContext=${baselineCaps.canSeeContext}, canReadTools=${baselineCaps.canReadTools}) — the comparison would not be the one this record claims`,
    );
  }

  const ctx = {
    baseline,
    baselineCaps,
    bridgeCaps: { canReadTools: true, canSeeContext: advertisedTools.has('ui_visible_context'), advertised: advertisedTools },
    connect: bridgeModule.connect,
    REALTIME_TOOLS: bridgeModule.REALTIME_TOOLS,
    createFakeTransport: harness.createFakeTransport,
    waitFor: harness.waitFor,
    decisionsByEntry: new Map(),
    fixtureStatesByClass: new Map(corpus.classes.map((cls) => [cls.key, cls.fixtureStates])),
  };

  /** 对照 entry 的夹具状态来自它所属 class 的冻结 fixtureStates（对照表本身只写脚本与引用）。 */
  const withFixtures = (entry) => ({ ...entry, fixtureStates: ctx.fixtureStatesByClass.get(entry.classKey) ?? {} });

  const entries = flag('corpus') && value('corpus') === 'empty' ? [] : corpus.entries;
  const rows = [];
  for (const entry of entries) {
    const armA = await runBaselineEntry(ctx, entry);
    const armB = await runBridgeEntry(ctx, entry);
    for (const row of [armA, armB]) row.verdict = scoreEntry(entry, row.decision);
    rows.push(armA, armB);
    // 负对照的读数要在决策表里找得到（对照 entry 与语料 entry 不共享 id）。
    ctx.decisionsByEntry.set(`${entry.id}|`, armB.decision);
  }

  // 负对照的读数：每条对照的 entry 也要跑两次（无偏置 + 偏置），两次都走 Arm B。
  for (const control of CONTROLS) {
    if (control.scorerLevel) continue;
    if (!entries.length) continue;
    const controlEntry = withFixtures(control.entry);
    ctx.decisionsByEntry.set(`${control.entry.id}|`, (await runBridgeEntry(ctx, controlEntry)).decision);
    ctx.decisionsByEntry.set(
      `${control.entry.id}|${control.bias}`,
      (await runBridgeEntry(ctx, controlEntry, { bias: control.bias })).decision,
    );
  }

  // n：语料条数 × 臂数。空读数不是绿读数。
  console.log(`\ncorpus: ${entries.length} entr(ies) across ${corpus.classes.length} class(es)`);
  console.log(`readings: n=${entries.length} × 2 arm(s) = ${entries.length * 2} row(s)`);
  if (!entries.length) {
    failures.push('[n] the corpus is EMPTY — n=0 × 2 arm(s) = 0 readings, and an empty reading is not a green one');
  }
  if (rows.length !== entries.length * 2) {
    failures.push(`[n] ${rows.length} row(s) were read for ${entries.length} entr(ies) — two arms must both be read for every entry`);
  }

  const runs = [...new Set(rows.map((r) => r.run))];
  console.log(`\nrun: ${runs.join(', ') || '(none)'} — ${runs.length <= 1 ? 'single run, so the pairing does not straddle runs' : 'MORE THAN ONE RUN'}`);

  if (entries.length) {
    printReadings(rows);
    printControls(CONTROLS.map((control) => readControl(ctx, control)));
    printPairedText(rows);
  }

  // AC4 的运行时证据：每一条读数都得**来自**出货模块，而不是本文件自造的等价物。probe 里打印的是路径
  // 与符号名（静态），这里补的是「它们真的跑了」：Arm A 每行的文本由适配器自己的答案解析路径产出
  // （`providerId` 与 `style` 都是适配器写的），Arm B 每一次计划调用都由 **bridge** 路由成
  // `function_call_output` 回到 transport.sent。
  if (entries.length) {
    const armARows = rows.filter((row) => row.arm === 'A');
    const armBRows = rows.filter((row) => row.arm === 'B');
    const wrongProvider = armARows.filter((row) => row.providerId !== 'dashscope-omni');
    const wrongStyle = armARows.filter((row) => row.style !== 'written');
    const plannedCalls = armBRows.reduce((total, row) => total + row.calls.length, 0);
    const routedOutputs = armBRows.reduce((total, row) => total + row.toolCalls, 0);
    console.log('\nevidence that the shipping modules ran (not a re-implementation):');
    console.log(`  arm A: ${armARows.length} row(s) stamped by the shipping adapter (providerId=dashscope-omni, style=written)`);
    console.log(`  arm B: ${routedOutputs}/${plannedCalls} planned read(s) came back as function_call_output routed by the bridge itself`);
    if (wrongProvider.length) {
      failures.push(`[AC4] ${wrongProvider.length} Arm A row(s) were not produced by the shipping adapter (providerId ≠ dashscope-omni)`);
    }
    if (wrongStyle.length) {
      failures.push(`[AC4] ${wrongStyle.length} Arm A row(s) did not go through the adapter's own written-path parse (style ≠ "written")`);
    }
    if (routedOutputs !== plannedCalls) {
      failures.push(`[AC4] ${plannedCalls} planned read(s) but ${routedOutputs} routed output(s) — the calls did not all go through the bridge`);
    }
  }

  // 自检：四条变异各自必须红，且红在预期位置上；默认运行本身必须绿。缺了正面的一半，一个「永远返回红」
  // 的 checker 也能通过全部变异——所以绿读数与变异红是同一个断言的两半。
  console.log('\nfalsifiers (each variant must red, and red for the stated reason; the default reading must be green):');
  const summary = [];
  const readingsReal = entries.length ? CONTROLS.map((control) => readControl(ctx, control)) : [];
  const verdictsReal = readingsReal.map(controlVerdict);
  const realMoved = verdictsReal.filter((verdict) => verdict.status === 'moved').length;
  if (entries.length) {
    if (realMoved !== verdictsReal.length) {
      failures.push(`[control] only ${realMoved}/${verdictsReal.length} control(s) moved in the predicted direction on the real corpus`);
    }
    for (const verdict of verdictsReal) if (verdict.status !== 'moved') failures.push(`[control] ${verdict.detail}`);
  }
  summary.push(`real=${realMoved}/${verdictsReal.length} moved`);

  const absent = CONTROL_ORDER.map((id) => {
    const control = CONTROLS.find((candidate) => candidate.id === id);
    return controlVerdict({ control, good: null, broken: null, goodLabel: 'dropped', brokenLabel: 'dropped', goodEvidence: { why: 'the control was removed from the table' }, brokenEvidence: { why: 'the control was removed from the table' } });
  });
  if (absent.some((verdict) => verdict.status === 'moved')) failures.push('[falsifier] control=absent: a dropped control still reported as moved');
  else if (!absent.every((verdict) => verdict.status === 'absent')) failures.push('[falsifier] control=absent: red for the wrong reason');
  summary.push(`control=absent=${absent[0]?.status}`);

  const inverted = entries.length ? CONTROLS.map((control) => readControl(ctx, control, { inverted: true })).map(controlVerdict) : [];
  if (!entries.length) {
    summary.push('control=inverted=(no corpus)');
  } else if (inverted.some((verdict) => verdict.status === 'moved')) {
    failures.push('[falsifier] control=inverted: the reversed control still reported as moved — the direction assertion is blind');
  } else if (!inverted.every((verdict) => verdict.status === 'against')) {
    failures.push(`[falsifier] control=inverted: red for the wrong reason (${inverted.map((v) => v.status).join(', ')})`);
  } else {
    summary.push('control=inverted=against');
  }

  if (entries.length) {
    const straddles = assertSingleRun(straddle(rows));
    if (!straddles.length) failures.push('[falsifier] runs=straddle: expected the pairing check to red, got no failure — the pairing assertion is blind');
    else if (!straddles.some((failure) => failure.includes(STRADDLE_RUN_ID))) failures.push(`[falsifier] runs=straddle: red for the wrong reason — ${straddles[0]}`);
    else summary.push('runs=straddle=red');

    const realStraddles = assertSingleRun(rows);
    if (realStraddles.length) for (const failure of realStraddles) failures.push(`[pairing] ${failure}`);
  }

  // `--runs=straddle` 作为真实 CLI 变异（默认运行里已经在内存里算过一次）。
  if (flag('runs') && value('runs') === 'straddle') {
    for (const failure of assertSingleRun(straddle(rows))) failures.push(`[pairing] ${failure}`);
  }
  // `--control=absent` / `--control=inverted` 作为真实 CLI 变异。
  if (flag('control') && value('control') === 'absent') {
    failures.push('[control] --control=absent: every negative control was removed from the table, so nothing in this run was falsifiable');
  }
  if (flag('control') && value('control') === 'inverted') {
    for (const verdict of inverted) if (verdict.status !== 'moved') failures.push(`[control] --control=inverted ${verdict.detail}`);
  }
  console.log(`  ${summary.join('  ')}`);

  if (failures.length) {
    process.stderr.write(`\nvoice-realtime-ambiguity-paired-quality: ${failures.length} failure(s)\n`);
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
    return finish(1);
  }

  console.log(
    `\nvoice-realtime-ambiguity-paired-quality: OK — n=${entries.length} × 2 arm(s), ${rows.length} paired reading(s), ` +
      `${realMoved}/${verdictsReal.length} negative control(s) moved in the predicted direction; ${DISCLAIMER}`,
  );
  return finish(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`FAIL: ${error?.message ?? error}\n`);
      process.exit(1);
    },
  );
}

// 本文件的末行与它输出的末行是同一句话，这样「runner 的末行」两种读法不会一个满足而另一个不满足。
// 上面那些数字无论将来跑到多少，都是一份读数**不是**判据：这个仓库里没有任何东西闸在它们上面，
// 一个让它们移动的改动也不因此是回归。
// quality numbers are a reading and are NOT a criterion
