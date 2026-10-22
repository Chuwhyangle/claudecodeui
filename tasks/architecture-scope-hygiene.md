---
id: architecture-scope-hygiene
title: 服务端 scope 清理：绝对路径 id 规范成相对路径、重叠 scope 按 (相对文件, 名字) 去重并重定向边、项目根之外的 scope
  丢弃，并把诊断暴露给界面
status: done
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

2026-10-22 读 archguard 项目的 `.archguard/query/manifest.json` 发现：28 个 scope 里有大量重叠、绝对路径与项目之外的内容，而 `server/modules/architecture/service.ts` 的 `mergeScopeIndexes`（第 708 行附近）把它们原样合并，直接画进了图里。实测的症状（会话 `f3a974c3-510c-4761-ba48-96dff3d5220c`，2000 个实体）：

- **重叠与重复**：scope `8f71319d`（源 `/data/home/yale/work/archguard`，964 个实体）、`465376a8`（源 `…/archguard/src`，943 个）、`42ceaef3`（源 `…/archguard/src/mermaid`，63 个）是同一份代码的嵌套分析；`465376a8` 与 `8f71319d` 各向这张图贡献了 514 个节点，约四分之一是重复。
- **绝对路径 id**：`42ceaef3` 的实体 id 是 `/data/home/yale/work/archguard/src/mermaid/…`，拼上 scope key 成了 `42ceaef3//data/home/…`（双斜杠）；按目录分组时第一段 `data` 被当成目录，出现了 `data (159)` 这个组。
- **项目之外的 scope**：共 12 个 scope 的源目录在 archguard 项目根之外——claudecodeui 3 个（`93e0a992`、`ab4fee8d`、`ab21924e`）、quay 5 个（`b4f87b21`、`2e269126`、`075f2c0c`、`eb75beb1`、`9e8ebf97`）、`/tmp` 下的测试夹具 4 个（`8b7e04c6`、`d48b75a4`、`b79ff7aa`、`73d52a45`）。清单里的 `globalScopeKey` 还指向了 quay 的根 scope `b4f87b21`，所以**不能依赖 `globalScopeKey` 选 scope**。
- 清单里每个 scope 的来源是 `sources: [绝对路径]`；服务端已能推出每个 scope 的 `sourcePrefix`（相对项目根的目录，`ParsedScopeIndex.sourcePrefix`）。

### 上游的结论（2026-10-22 与 archguard 会话核对）

archguard 一侧确认：每个 diagram 源目录各存一个 scope、与项目级 scope 并存于同一个 manifest 是现状设计，没有包含关系元数据；子目录 scope 的 id 为绝对路径是解析路径分叉的缺陷（`ParallelParser` 路径里 `workspaceRoot` 没有传下去，`canonicalizeArchJson` 也不归一 id/file）；`persistQueryScopes` 对项目根之外的 scope 没有任何守卫，`selectGlobalScopeKey` 也没有限定在项目根内。对方计划在上游：(1) 让 `entity.id` 与 `sourceLocation.file` 在出口统一成相对 workspace 根的 posix 路径；(2) 对项目根之外的 scope 在清单项里标 `outsideProjectRoot: true`，并让 `selectGlobalScopeKey` 只在根内选；(3) 给清单项加可选的 `parentScopeKey`（从 sources 的路径包含关系推出）。这三项**还没有发布**，并且**已经落盘的 `.archguard` 都是旧形态**，所以本任务的启发式必须保留；上游字段一旦出现就优先读它们。

### 一、规则（纯函数，放在同一模块目录内的新文件 `scope-hygiene.ts`）

1. **归一化 id**：实体 id（scope key 之后的部分）若以 `/` 开头：以项目根为前缀则剥掉项目根得到相对路径；否则该 scope 的来源在项目根之外（见 3）。归一化后不得再出现 `//` 或以 `/` 开头的 id。
2. **重叠去重**：对每个实体计算规范键 `(项目相对文件, 实体名)`（项目相对文件 = `sourcePrefix` + scope 内文件）；多个 scope 含同一规范键时，**保留来源目录最靠外（路径最短）的 scope 的那个实体，来源相同则取 `generatedAt` 最新的**；只存在于内层 scope 的实体照常保留（它们不是重复）。被丢弃的 id 要建立 `alias → 保留 id` 的映射，并用它重写 `dependencies`/`dependents`/`relationsByType`/`nameToIds`/`fileToIds`/`idToFile`/`idToName`/`entityDetails`：指向被丢弃 id 的边改指向保留 id，去掉自环与重复边，不丢边。
3. **项目根之外的 scope 丢弃**：`sources` 全部不在项目根之内的 scope 不参与合并，只进诊断。路径比较要**先对项目根与每个 source 做 `realpath`**（失败时回落到 `path.resolve`）：archguard 自己对符号链接别名（`/home/...` 与 `/data/...`）做了归一化，我们若只做字符串比较，会把别名路径下的本项目 scope 误判成项目外。
4. **上游元数据优先，启发式兜底**：清单项带 `outsideProjectRoot` 时直接采信它（不再自己比较路径）；带 `parentScopeKey` 时以它判定包含关系并据此决定去重时谁是「外层」（缺失时按 2 的路径包含关系推断）；两个字段**可选**，缺失即旧形态，不得因缺失而报错。不使用 `globalScopeKey`。
5. 规则只改合并结果，不改任何 scope 自己的 `arch-index.json`/`arch.json`；对「单个 scope、相对路径 id、无重叠」的项目输出**逐字节不变**。

### 二、缓存与诊断

- 合并结果由内容寻址缓存按各 scope 的 `archJsonHash` 建键；合并规则变了，必须把「规则版本」放进缓存键（`cache.ts`），否则旧缓存会继续返回未清理的合并。
- `provenance` 追加可选字段 `scopeHygiene?: { total, kept, droppedOutsideRoot: [{ scope, label, sources }], subsumed: [{ scope, label, intoScope, droppedEntities }], normalizedAbsoluteIds: number }`；字段缺失即旧形态。
- 界面：画布底部的来源行（`Analysis: … · N names mentioned … not found`）后追加一个可展开项「scope 清理」，展开后用人话列出：「28 个 scope，保留 N 个；N 个因与外层重叠合并（去掉 N 个重复实体）；N 个在项目目录之外已忽略（列出标签与来源路径）；N 个绝对路径 id 已规范」。没有任何清理动作的项目不显示这一项。新文案走 i18n（12 个 locale）。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/generator.test.ts server/modules/architecture/tests/architecture-routes.test.ts server/modules/architecture/tests/cache-invalidation.test.ts` exit 0：用仿照 archguard 清单的 fixture（三个嵌套来源 + 项目外来源（claudecodeui 形与 `/tmp` 形各一）+ 一个绝对路径 id 的 scope；放在 `server/modules/architecture/tests/fixtures` 下）断言：同一规范键的实体合并后只剩一个 id、保留的是最靠外 scope 的那个；指向被丢弃 id 的边已改指向保留 id、无自环无重复边、边总数不少于「按规范键去重后」应有的数；只在内层出现的实体仍在；绝对路径 id 归一化后不含 `//`、不以 `/` 开头；项目外 scope 贡献 0 个实体且出现在诊断里；诊断计数（total/kept/droppedOutsideRoot/subsumed/normalizedAbsoluteIds）与 fixture 构造一致；同一输入多次输出逐字节相同
- [x] 同上命令：符号链接别名用例——项目根经符号链接访问（清单里的 `sources` 用另一条指向同一目录的路径）时，本项目的 scope **不**被误判为项目外；清单项带 `outsideProjectRoot: true` 时被丢弃而不做路径比较，带 `parentScopeKey` 时按它判定外层，两个字段都缺失时回落到启发式且结果与只用启发式一致
- [x] 同上命令：「单 scope、相对路径 id、无重叠」的既有 fixture 响应与改前逐字节相同；合并规则版本进入缓存键（同一份 fixture 在规则版本变化后不命中旧缓存）；`entityDetails`（kind/members）随保留的 id 正确挂接；`unresolved` 的语义不变
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0：`provenance.scopeHygiene` 存在时来源行出现可展开的「scope 清理」并列出各项计数与项目外 scope 的标签；缺失时不出现；既有用例不回归；12 个 locale 文案键齐全
- [x] `npm run typecheck` 与 `npm run build` 通过

## DoD

对真实 archguard 项目的会话 `f3a974c3-510c-4761-ba48-96dff3d5220c` 发 `POST /api/architecture/graph`，贴改前改后的对照：改前 `42ceaef3//data/home/…` 与 `ab4fee8d//data/home/yale/work/claudecodeui/…` 这类 id 的个数、`465376a8` 与 `8f71319d` 各 514 的重复；改后不再有以 `/` 开头或含 `//` 的 id、按 `(文件, 名字)` 无重复实体、12 个项目外 scope（claudecodeui、quay、`/tmp`）不在节点里，`provenance.scopeHygiene` 的计数与清单一致。再在浏览器里打开该会话的 architecture tab，类图里不再出现 `data (…)` 这种由绝对路径生出来的组，来源行能展开看到「scope 清理」。再对 quay 与 claudecodeui 两个项目各发一次请求，贴节点数与改前相比的变化（无重叠的项目应当不变，有变化的要逐项解释）。

## Touches

- server/modules/architecture/scope-hygiene.ts (new)
- server/modules/architecture/service.ts
- server/modules/architecture/cache.ts
- server/modules/architecture/index.ts
- server/modules/architecture/tests/generator.test.ts
- server/modules/architecture/tests/architecture-routes.test.ts
- server/modules/architecture/tests/cache-invalidation.test.ts
- src/modules/architecture/useArchitectureGraph.ts
- src/modules/architecture/ArchitecturePanel.tsx
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
- tasks/architecture-scope-hygiene.md