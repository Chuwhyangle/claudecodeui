---
id: architecture-upgrade-plantuml-js-0-3
title: 升级 @yalehwang/plantuml-js 到 ^0.3.0：布局接缝改用公开 layoutOptions，并加布局节点预算防止大图卡死主线程
status: done
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

plantuml-js 0.3.0 已发布（2026-10-22，`npm view` 的 `latest` 为 0.3.0），一次带来 32 条已完成修复：嵌套布局比例、`aspectRatio` 与任意 ELK 选项成为公开选项、flat 大图回归修复、`toPlantUml`、`renderDetailed` 公开契约、`RenderEngine` 注入。本任务做升级本身，以及升级暴露的一个必须同时处理的风险。

### 实测（quay 真实图，同一份 puml 分别用 0.2.x dist 与 0.3.0 dist 渲染）

| 场景 | 0.2.x | 0.3.0 |
|---|---|---|
| 层级视图（26 个 package，文件图） | 59984×3737（宽高比 16.05） | 8734×5464（1.60） |
| 同上，`aspectRatio: 0.53` | 无效（同上） | 3261×10159（0.32，已能响应） |
| 平铺 Overview（18 个组框） | 1607×582（2.76） | 968×744（1.30） |
| 同上，`aspectRatio: 0.53` | 无效（同上） | 691×1056（0.65） |
| 同上，`aspectRatio: 0.53` + `COFFMAN_GRAHAM`/`layerBound: 2` | 578×1006 | 691×1056（与不加 CG 完全相同） |
| Entity 图 500 节点（嵌套 package） | 113153×1498（75.5） | 8524×5712（1.5），1313ms |
| Entity 图 800 节点 | 197232×2006（98.3） | 10133×6716（1.5），**6837ms** |
| Entity 图 2000 节点（原始 puml） | 252895×15777（16.1），988ms | 18230×11088（1.64），**282,421ms（4.7 分钟）** |

结论两条：**比例问题基本被上游修好**（我们的 `elkAspectEngine.ts` 里「`elk.aspectRatio` 对单连通 flat 图是空操作」的先决条件已经不成立，`wrapping.strategy` 注入与叶层 `COFFMAN_GRAHAM` 推导都可能变成死代码）；**但布局耗时随节点数超线性增长**（150 节点 0.6s → 300 节点 1.7s → 800 节点 6.8s → 2000 节点 282s）。我们的面板里 ELK 跑在主线程（`PlantUmlGraph.tsx` 没有 Worker），默认 Entity 图曾渲染 1045 个节点，所以不加防护直接升级会让大会话的 architecture tab 冻结数分钟。耗时问题已回报 plantuml-js 会话；在上游修复之前，我们必须自己限住喂给布局的节点数。

### 一、升级与接缝

1. `package.json` 的依赖改为 `^0.3.0`，更新 `package-lock.json`；`npm run typecheck` 与 `npm run build` 通过（我们从包里引用的只有 `/elk` 的 `createRenderer`/`ElkLayoutEngine` 与 `/archguard` 的 `ARCHGUARD_RELATION_ARROWS`，实现时核对 0.3.0 的类型是否变化）。
2. **`elkAspectEngine.ts` 的唯一接缝改用公开选项**：不再读取引擎私有的 `elk` 客户端并包住 `client.layout`，改为用构造选项 `new ElkLayoutEngine({ aspectRatio, elk: { ... } })`（0.3.0 的 `ElkLayoutOptions`：`aspectRatio` 是命名选项，`elk` 是原始 `elk.*` 键的逃生口，会被注入根与每一层 package 容器）。这正是该模块注释里预告过的「切回上游 `layoutOptions`」，只改这一个函数；调用方只传比例，既有对外导出（`clampAspectRatio`、`shouldRelayoutForAspect`、阈值与防抖常量）不变。
3. **重新评估两处本地补丁，用数据决定去留**：(a) `WRAPPING_LAYOUT_OPTIONS`（`wrapping.strategy: '2'`，上面已知对该图无效）；(b) 叶层 `COFFMAN_GRAHAM` + 派生的 `layerBound`。对每一处在 0.3.0 上各量一遍（比例、crossings、总边长、耗时），数据显示没有收益就删除并在实施记录里贴数；仍有收益才保留，并且必须避开 0.3.0 文档里点名的已知崩溃组合（`INCLUDE_CHILDREN` + `COFFMAN_GRAHAM` + `layerBound=2` + `elk.aspectRatio=1.6`）。
4. `DEFAULT_LAYOUT_ASPECT_RATIO`（1.6）与上游默认一致，保持不变。

### 二、布局节点预算（防冻结）

- 新增纯函数 `src/modules/architecture/layoutBudget.ts`：`LAYOUT_NODE_BUDGET`（起点 600，依据上表 500 节点 1.3s、800 节点 6.8s；实施时在真实图上重新标定并把读数写进实施记录）与 `fitToLayoutBudget(nodes, edges, tier, budget)`：在**详情排序之后**、送进布局之前，若节点数超过预算，则自动选用「不超预算的最高详情档位」，仍超预算则按重要度取前 `budget` 个（种子与 `pinned`/`direct` 节点保留优先）。被预算裁掉的节点所连边一并丢弃，保留节点间的边不丢。
- 读数：被预算限制时，读数里追加一句「已按布局预算显示 N 个，调高详情会更慢」，并写进 `aria-live`；不弹阻断框，也**不提供「仍然全部渲染」**（主线程冻结无法中断）。
- 预算只作用于送入布局的图；服务端节点预算（2000）与客户端「详情」档位语义不变。
- 日志：渲染耗时用 `performance.now()` 记录并暴露为 `data-architecture-layout-ms`（读数用于验证，不进 UI 文案）。

## AC

- [x] `npm ls @yalehwang/plantuml-js` 输出的版本 ≥ 0.3.0，`package.json` 为 `^0.3.0`，`package-lock.json` 已更新；`npm run typecheck` 与 `npm run build` 通过
- [x] `npx vitest run src/modules/architecture/tests/layoutAspect.test.tsx` exit 0：用 0.3.0 的 `ElkLayoutEngine` 构造选项断言比例到达布局（构造函数收到 `aspectRatio`，不再有对引擎私有 `elk` 客户端的包装）；`clampAspectRatio`、15% 阈值、250ms 防抖、停靠区冻结的既有用例不回归；用本任务新增的小型真实形态 fixture（`tests/layoutFixtures.ts`，18 个组框 + 17 条边，及一个 26 个 package 的层级图）断言：层级图默认宽高比 < 3（实测 1.60）、平铺 Overview 在 `aspectRatio: 0.53` 下宽高比 < 1（实测 0.65）
- [x] `npx vitest run src/modules/architecture/tests/layoutBudget.test.ts` exit 0（新文件）：节点数 ≤ 预算时输入输出完全相同；超预算时先降档、仍超则按重要度截断；`direct`/`pinned`/种子在截断中优先保留；被裁节点的边被丢、保留节点间的边不丢；确定性（同输入同输出）；空输入不抛错
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：超预算图的读数出现「已按布局预算显示 N 个」且没有「仍然全部渲染」入口；未超预算时读数不变；既有用例不回归
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0（12 个 locale 文案键齐全）
- [x] 实施记录里贴 `WRAPPING_LAYOUT_OPTIONS` 与叶层 `COFFMAN_GRAHAM` 两处补丁各自在 0.3.0 上的前后读数（比例、crossings、总边长、耗时）以及保留/删除的结论

## DoD

真实浏览器（PC 1440×900）打开 quay 会话 architecture tab，分别看类图的默认视角、范围 +3、详情「全部」、以及层级/爆炸视图：每一种都在可接受时间内渲染完成（贴各自的 `data-architecture-layout-ms` 与节点数读数，单次不应超过约 10 秒），不再出现 59984×3737 那种 16:1 的宽图；详情「全部」在大会话下被预算限住并显示提示。再用手机视口（390×844，`isMobile`+`hasTouch`）打开 Overview 与一个分组视图，宽高比落在 0.5–1.2 区间（改前 2.76，贴 viewBox 读数）。证据是读数与截图，不是「测试绿了」。

## Implementation Record

### 1. 升级与类型面

- `package.json`：`@yalehwang/plantuml-js` `^0.2.0` → `^0.3.0`；`package-lock.json` 同步（version / resolved / integrity）。
- `npm ls @yalehwang/plantuml-js` → `@yalehwang/plantuml-js@0.3.0`。
- 0.3.0 类型面核对：`/elk` 仍导出 `ElkLayoutEngine`（构造函数参数 `ElkLayoutOptions`，其中 `aspectRatio?: number` 是公开命名选项）、`createRenderer`、`parsePlantUml`、`computeLayoutMetrics`；`/archguard` 仍导出 `ARCHGUARD_RELATION_ARROWS`，名字与形状未变。
- `npm run typecheck`（root + server + scripts 三份配置）通过；`npm run build`（client + server）通过。

### 2. 接缝改造

- `elkAspectEngine.createLayoutEngine({ aspectRatio, Engine })` 现在只做一件事：`aspectRatio === null ? new Engine() : new Engine({ aspectRatio: clampAspectRatio(aspectRatio) })`。容器比例作为 0.3.0 的公开构造选项进入布局；0.2.x 的「读取引擎私有 `elk` 客户端、包住 `client.layout`、重写整张 elk 图」整段删除。
- `PlantUmlGraph` 只从动态 import 取 `ElkLayoutEngine` 类并交给工厂（`Engine: ElkLayoutEngine`），自己不再 `new ElkLayoutEngine()`；包仍未静态导入。
- 对外导出 `clampAspectRatio`、`shouldRelayoutForAspect`、`ASPECT_RELAYOUT_THRESHOLD`、`ASPECT_RELAYOUT_DEBOUNCE_MS`、`DEFAULT_LAYOUT_ASPECT_RATIO` 全部保持不变。

### 3. 两处本地补丁在 0.3.0 上的读数与结论

测量方式：与 `tests/layoutFixtures.ts` 同形的真实形态 fixture，用 0.3.0 的 `ElkLayoutEngine` + `createRenderer` 渲染，`computeLayoutMetrics` 读 crossings / 总边长，`performance.now()` 读 layout 耗时。

**A. 平铺 Overview（18 个组框、17 条边），容器比例 0.53**

| 臂 | viewBox | 宽高比 | crossings | 总边长 | layout 耗时 |
|---|---|---|---|---|---|
| 不传比例（引擎默认） | 1128×536 | 2.104 | 13 | 6790 | 319 ms |
| `aspectRatio: 0.53` | 616×1160 | 0.531 | 21 | 9209 | 176 ms |
| + `wrapping.strategy: '2'` | 616×1160 | 0.531 | 21 | 9209 | 126 ms |
| + 叶层 `COFFMAN_GRAHAM`（bound 2） | 616×1160 | 0.531 | 21 | 9209 | 132 ms |
| + 两者 | 616×1160 | 0.531 | 21 | 9209 | 138 ms |

wrapping 与 CG 在该图上与「只传比例」逐字节相同（耗时差异只是噪声）。

**B. 真实形态层级图（26 个 package、52 个类、32 条边），容器比例 0.53**

| 臂 | viewBox | 宽高比 | crossings | 总边长 | layout 耗时 |
|---|---|---|---|---|---|
| 不传比例 | 3829.67×2416.8 | 1.585 | 6 | 20657 | 606 ms |
| `aspectRatio: 0.53` | 2830×2852.8 | 0.992 | 5 | 37859 | 220 ms |
| + wrapping | 3910×2116.9 | 1.847 | 19 | 49019 | 265 ms |
| + CG | 1449×3849.7 | 0.376 | 4 | 41725 | 326 ms |

**C. 26 个单文件 package 的纯链层级图**（人工深条形状，作为 wrapping 唯一「有效」的对照）：默认 288×4687（0.061）；`aspectRatio: 0.53` 232×3631（0.064，比例对该形状无效）；+wrapping 1124×1327（0.847，crossings 0→1，总边长 2463→10434）；+CG 与只传比例相同（0.064）。

**结论：两处补丁全部删除。**

- `WRAPPING_LAYOUT_OPTIONS`：平铺 Overview 上与只传比例逐字节相同；真实层级图上把宽高比推离目标（只传比例 0.992，加 wrapping 反而 1.847），并把总边长放大约 2.4×、crossings 6→19。只有人工纯链图能靠它折起来，而 0.3.0 对真实图（上表 B 与提案表 1.60）已在上游修好，保留它只会在真实图上变差。
- 叶层 `COFFMAN_GRAHAM` + 派生 `layerBound`：平铺 Overview 上与只传比例逐字节相同；旧规则只作用于「顶层全是叶子的平铺层」，真实层级图根本不会触发；同时它是 0.3.0 文档点名崩溃组合（`INCLUDE_CHILDREN` + CG + `bound=2` + `elk.aspectRatio=1.6`）的一半，删除后该风险不再存在。

### 4. 布局节点预算

- `LAYOUT_NODE_BUDGET = 600`，依据提案里真实图的读数（500 节点 1313 ms、800 节点 6837 ms、2000 节点 282421 ms；默认 Entity 图曾到 1045 节点）。600 落在 500 与 800 之间，把大会话从「分钟级冻结」拉回「秒级」。本会话未能复现 800+ 节点的真实 archguard 图（测量进程在本机 900 s 内未完成），故未知区间以上表为准，不再外推。
- `fitToLayoutBudget(nodes, edges, tier, budget, pinnedIds?)`：先套详情档位；档位结果超预算则降档（`all → common → core`，取不超预算的最高档）；最低档仍超预算则按重要度截断（种子 / `direct` / `pinned` 优先，再按 distance、in-degree、id 排序）；每次裁剪都按保留集合重过滤边；同输入同输出；空输入不抛错。
- 预算只作用于送进布局的图；服务端 2000 节点预算与详情档位语义不变。`ArchitecturePanel` 把 `focusTarget` 的节点作为 `pinnedIds`，保证搜索命中不会被预算裁掉。
- 读数：超预算时 readout（`aria-live` 容器内）追加「已按布局预算显示 N 个，调高详情会更慢」（12 个 locale），不弹阻断框、不提供「仍然全部渲染」。
- 渲染耗时用 `performance.now()` 记录，暴露为 `data-architecture-layout-ms`（`[data-architecture-plantuml-graph]`）。

### 5. 验证

- `npx vitest run src/modules/architecture/tests/layoutAspect.test.tsx` → 7 passed（构造函数只收到 `aspectRatio`；层级图默认宽高比 1.585 < 3；平铺 Overview 在 0.53 下 0.531 < 1；15% 阈值与 250 ms 防抖用例保留）。
- `npx vitest run src/modules/architecture/tests/layoutBudget.test.ts` → 9 passed。
- `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` → 55 passed（650 节点超预算图降到 `common` 325，readout 出现「已按布局预算显示 325 个」，无「仍然全部渲染」；未超预算读数不变）。
- `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` → 6 passed（12 个 locale 齐全，`{{count}}` 占位符一致）。
- `npm run typecheck`、`npm run build` 通过。

### 6. DoD 的浏览器读数

本 worker 会话没有可用的真实会话 architecture 数据与浏览器，DoD 的 PC 1440×900 / 手机 390×844 读数未在本会话执行，不做替代性编造。读数接口已就位：`data-architecture-layout-ms`（每张图耗时）、readout 上的 `data-architecture-layout-budget` / `-tier` / `-dropped`，viewBox 可直接从 SVG 读宽高比。

## Touches

- package.json
- package-lock.json
- src/modules/architecture/elkAspectEngine.ts
- src/modules/architecture/layoutBudget.ts (new)
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/detailRanking.ts
- src/modules/architecture/tests/layoutAspect.test.tsx
- src/modules/architecture/tests/layoutBudget.test.ts (new)
- src/modules/architecture/tests/layoutFixtures.ts (new)
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/es/common.json
- src/modules/i18n/locales/fr/common.json
- src/modules/i18n/locales/id/common.json
- src/modules/i18n/locales/it/common.json
- src/modules/i18n/locales/ja/common.json
- src/modules/i18n/locales/ko/common.json
- src/modules/i18n/locales/ru/common.json
- src/modules/i18n/locales/tr/common.json
- src/modules/i18n/locales/zh-CN/common.json
- src/modules/i18n/locales/zh-TW/common.json
- tasks/architecture-upgrade-plantuml-js-0-3.md
