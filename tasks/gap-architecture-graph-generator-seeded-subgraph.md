---
id: gap-architecture-graph-generator-seeded-subgraph
title: 架构图生成器：种子解析 → 1 跳双向扩展 → file/entity 两级聚合 → 合法 .mmd（AC-415）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-415
---
## Proposal

实现 GOAL-049 / ADR-005 决策 4、5 的服务端生成器。本任务只交付「纯生成器 + 模块 barrel + 测试」：路由与端点归 AC-418，种子提取归 AC-416，内容寻址缓存归 AC-417，前端 tab 归 AC-419，均不在本任务范围内。

新建后端叶子模块 `server/modules/architecture/`（遵循 `$backend-module-standards`）：

- `generator.ts`：导出纯函数 `generateGraph(index, seeds, params)`。输入 `index` 就是 `.archguard/query/<scope>/arch-index.json` 的形状：`fileToIds`（文件 → entity id[]）、`nameToIds`（标识符名 → entity id[]）、`dependencies`/`dependents`（entity id → entity id[]）、`idToFile`（entity id → 文件）、`idToName`；不读文件系统、不碰 route、不做缓存。输出 `{ mmd: { file, entity }, stats: { entityNodes, fileNodes, entityEdges, fileEdges, truncated }, unresolved: { files, identifiers } }`。
- 种子形态：`seeds.files` 用 index 自己的 key 形态（scope 相对路径），`seeds.identifiers` 用裸标识符名。scope 前缀拆分与跨 scope 合并是调用方（AC-418）的职责，生成器只处理单份 index，不吞 scope 逻辑。
- 解析：文件种子经 `fileToIds[file]` 展开为实体集合；标识符种子经 `nameToIds[name]` 精确命中（不做子串/大小写模糊）；未命中的种子进 `unresolved`，不得静默丢弃或替换成空图。
- 扩展：`dependencies` 与 `dependents` 两份邻接各走 1 跳（`hops` 默认 1，可参数覆盖），取并集得到 entity 候选节点；边集只保留两端都在节点集内的 entity 边。
- 聚合：file 级节点 = entity 节点经 `idToFile` 得到的文件集合；file 级边 = entity 边按 `(idToFile[from], idToFile[to])` 归并去重，`from === to` 的自环剔除。
- 预算：`maxNodes` 由调用方传入（不钉一个出货常量）。候选节点超限时按「距离种子的跳数升序 → entity id 字典序升序」确定性截断，返回 `truncated: true`，输出节点数 ≤ `maxNodes`，且每条边两端都在保留节点内。
- emit：两份 `.mmd` 都是合法 flowchart——首行 `%%{init: ...}%%` directive；节点 id 只含 `[A-Za-z0-9_]`（其余字符替换为 `_`，数字开头加稳定前缀，清洗后冲突按确定性顺序加后缀）；label 用双引号包裹并把内部 `\"` 转义为 `#quot;`；每条边引用的两端节点都在同一份 mmd 内定义过。导出 `validateMermaid(mmd)`，用与测试同源的读数检查 directive、id 合法性、label 引号、边端点已定义，返回问题列表（合法输入为 `[]`）。
- 模块边界：`index.ts` barrel 只导出生成器、`validateMermaid` 与本任务需要的类型；模块内不得新增 `types.ts`/`utils.ts`；跨模块只经对方 barrel。AC-415 阶段该目录不 import 任何 `server/modules/**` 兄弟目录——新目录必须保持 leaf，否则 AC-394 ratchet 的 `newDirectoryViolations` 会红；不要改 `server-import-cycle-budget.baseline.json` 或 `MANIFEST_PIN` 去「祝福」它。

测试 fixture：`server/modules/architecture/tests/fixtures/arch-index.sample.json`，从真实 `.archguard/query/93e0a992/arch-index.json` 裁剪一个连通小区块（保留 1 跳邻域闭包），文件头/README 注明来源 scope、`archJsonHash`（快照 `d02930eaf41dacb0b22a498575d9d479bd77931e874e78d97b00db170b5e42f0`）与裁剪范围；它是冻结快照，不是对 live 缓存的断言。测试用例按腿拆成独立 test block，名字以 `AC-415` 开头，便于 `--test-name-pattern` 单腿复跑：

1. `AC-415 种子解析：fileToIds 展开文件种子，nameToIds 精确命中标识符种子`
2. `AC-415 双向扩展：dependencies + dependents 1 跳并集`
3. `AC-415 file 级聚合：entity 边按 idToFile 归并去重`
4. `AC-415 节点预算：超限返回 truncated 且有界`
5. `AC-415 mermaid 合法性：directive/清洗 id/引号 label/边端点已定义`
6. `AC-415 假形态 A：fileToIds 漏一条 ⇒ 节点集断言红`
7. `AC-415 假形态 B：边引用未定义节点 ⇒ 合法性断言红`

已知联动（落地时必查，别等 suite 红）：

- 新增 server 测试文件会把 `server/shared/tests/quay-test-script.test.ts` 的 collected 计数从 391 顶到 392：同步把 AC2 的 `known=3 unknown=388` 改成 `unknown=389`、AC3 的 `known=1 unknown=390` 改成 `unknown=391`，并更新那两处上方注释的计数叙述。
- 当前 `scripts/suite-duration-baseline.tsv` 覆盖 352/391 = 90.03%；加入新测试文件后若 baseline 不变则是 352/392 = 89.8%，会击穿 AC7 的 90% 覆盖率地板。按该文件 header 的约定单跑新测试文件测耗时，补一行 `<ms>TABserver/modules/architecture/tests/generator.test.ts` 并在 header 记明测量日期与「新文件、尚无绿色轮次包含它」的原因。
- 只交付生成器；不要把路由、缓存、transcript 读取或前端面板顺手带进本任务。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/generator.test.ts` 退出码 0（整份 criterion 绿）。
- [x] `npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern "种子解析" server/modules/architecture/tests/generator.test.ts` 退出码 0：文件种子经 `fileToIds` 全部展开，标识符种子经 `nameToIds` 精确命中，未命中项出现在 `unresolved`。
- [x] `npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern "双向扩展" server/modules/architecture/tests/generator.test.ts` 退出码 0：断言 1 跳 `dependencies ∪ dependents` 的期望节点集与边集（含从 dependents 反向到达的节点）。
- [x] `npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern "file 级聚合" server/modules/architecture/tests/generator.test.ts` 退出码 0：entity 边按 `idToFile` 归并后无重复边、无自环，节点集等于期望文件集。
- [x] `npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern "节点预算" server/modules/architecture/tests/generator.test.ts` 退出码 0：超预算时 `truncated === true`、节点数 ≤ `maxNodes`、每条边两端都在保留节点内；未超限时 `truncated === false`。
- [x] `npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern "mermaid 合法性" server/modules/architecture/tests/generator.test.ts` 退出码 0：file/entity 两份 mmd 均含 `%%{init` directive、节点 id 符合清洗规则、label 均为双引号包裹、每条边两端都已定义；`validateMermaid` 对生成结果返回 `[]`。
- [x] `npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern "假形态 A" server/modules/architecture/tests/generator.test.ts` 退出码 0：删掉一条 `fileToIds` 映射后，同源期望节点集与生成节点集的差集非空，且 `unresolved.files` 点名该种子——证明该断言有区分力。
- [x] `npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern "假形态 B" server/modules/architecture/tests/generator.test.ts` 退出码 0：把一条端点被删的 mmd 喂给 `validateMermaid`，问题列表命中该未定义节点——证明合法性断言有区分力。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0（392 文件计数与 90% 覆盖率地板均已同步）。
- [x] `npm run typecheck` 退出码 0；`npm run lint` 退出码 0。

## DoD

生成器被真实执行过一遍完整机制，而不是只有 fixture 和字符串比较：

- 用 checked-in fixture 调 `generateGraph`，走完「文件种子 + 标识符种子 → 解析 → 1 跳双向扩展 → file/entity 聚合 → 两份 mmd」全链路；测试打印或断言实际读数（entityNodes/fileNodes/两类边数/truncated），并 `validateMermaid` 两份输出均为 `[]`。
- fixture 是从真实 `.archguard/query/93e0a992/arch-index.json` 裁剪的冻结快照，文件内注明来源 scope 与 `archJsonHash`；不是手编的假形状。
- 上列 AC 命令在落地的分支上全绿；`server/shared/tests/server-import-cycle-budget.test.ts` 也绿，且没有改 baseline/manifest（新目录作为 leaf 通过）。
- 任务记录/提交说明里贴出实际测试输出摘要（节点/边计数、truncated 读数、两份 mmd 的 directive 行），供 driver 复核。

## Touches

- server/modules/architecture/generator.ts (new)
- server/modules/architecture/index.ts (new)
- server/modules/architecture/tests/generator.test.ts (new)
- server/modules/architecture/tests/fixtures/arch-index.sample.json (new)
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-architecture-graph-generator-seeded-subgraph.md
