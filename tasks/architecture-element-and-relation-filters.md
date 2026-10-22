---
id: architecture-element-and-relation-filters
title: 元素/关系筛选：默认隐藏函数与调用边（关系三档 结构/+依赖/+调用），服务端按过滤后的图算 BFS 与预算，客户端收窄即时、放宽重取
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-entity-kind-and-members-payload
  - architecture-scope-and-detail-controls
  - architecture-toolbar-readout-and-legend
  - architecture-mention-provenance
---
## Proposal

2026-10-22 讨论结论。实测（quay Entity 图快照，2000 节点 / 3186 边）：边按类型 `call` 2093（66%）、`dependency` 1042（33%）、`composition` 51（1.6%），`inheritance`/`implementation` 为 0；能拼上类型的 1007 个实体里 function 957；隐藏函数后节点 2000→1043、边 3186→1334。函数与调用边是类图里最主要的噪声，而 UML 类图本身并不包含它们（那是序列图/通信图的材料）。用户确认：**提供隐藏弱元素与弱关系的筛选；默认隐藏函数与调用边；过滤采用「收窄即时、放宽重取」的折中；关系用三档预设；按来源（测试/脚本/构建产物）与隐藏枢纽留到后面，本任务不做。**

### 筛选模型（两条独立的轴）

1. **元素（按种类勾选）**：`class`、`interface`、`enum`、`abstract`、`function`、`other`，每项带范围内计数（`类 5 · 接口 300 · 函数 805`，计数来自 payload 的 `kindCounts`）。**默认：结构性种类开、`function` 与 `other` 关。** 仅在「类图」视角出现；「文件」视角没有 kind，不显示该区。
2. **关系（三档预设，`radiogroup`）**：`结构` = inheritance + implementation + composition + aggregation；`+依赖` = 再加 dependency；`+调用` = 再加 call（即全部）。**默认 `+依赖`（即隐藏 call）。** 未知的关系类型按 `+依赖` 档处理并在实施记录里写明。文件视角的边是否带类型由实现核实：带则同样适用，不带则关系区在文件视角下禁用并写明原因。
3. **隐藏孤立节点**开关：关系被收窄（档位不是 `+调用`）时默认开，否则默认关；开启时去掉过滤后没有任何边的节点。
4. **只有「直接提及」的种子免于隐藏**：`mentionTier === 'direct'` 的实体（会话里被明确点名、且名字只对应少数实体或带了路径消歧，档位由相关的提及出处任务提供）不受元素/关系筛选影响，即使成了孤立节点也保留；`mentionTier` 为 `name`（同名候选）或 `file`（同文件扩展）的 `distance === 0` 节点**当作普通节点**，照常受筛选约束。原因：`distance === 0` 并不等于「会话提到了它」（实测一个名字 `main` 对应 318 个实体、一个文件展开出中位 7 个实体，快照里 `distance === 0` 的节点有 773 个），若按 `distance === 0` 免隐藏，默认隐藏函数的筛选会被数百个同名/同文件的函数架空。缺 `mentionTier` 的旧形态 payload 按 `direct` 处理（旧行为，不报错）。读数中写明「含 N 个直接提及的函数」。
5. 选择按项目记住（复用范围/详情的本地存储与按项目隔离，不另造一套）。

### 过滤落在哪里（折中）

- **服务端**：`POST /api/architecture/graph` 新增可选请求参数 `kinds`（要显示的种类）与 `relations`（要显示的关系类型）。缺省 = 旧行为（全显示），所以旧客户端与手搓 stub 不受影响。BFS 与节点预算都在**过滤后的图**上算：被隐藏种类的节点在遍历前就被移除（不穿过），只沿允许的关系类型的边扩展；`direct` 档种子作为根不受影响。缓存键包含这两个参数（内容寻址缓存，同一组合不重复算）。响应追加可选字段：`stats.relationCounts`（范围内按关系类型的未过滤计数）与 `stats.hidden`（`{ byKind, byRelation, isolated }`，用未过滤的遍历只数不回传节点）。
- **客户端**：记住「上一次响应使用的过滤」。**收窄**（新过滤是它的子集，两条轴都是）：在已取回的数据上即时过滤，仅当上次响应 `entityTruncated` 时才后台补取（预算可能腾出来了）。**放宽或换视角**：重新请求（250ms 防抖），期间保留旧图并置 `aria-busy` 与淡化，不闪白屏。
- 纯函数 `src/modules/architecture/elementRelationFilter.ts`：`applyFilter(graph, filter, directSeedIds)` → `{ nodes, edges, hidden }`，收窄路径与测试共用。

### 与既有旋钮的次序

过滤 → （范围由服务端按过滤后的图展开）→ 详情排序（**入度按过滤后的边计算**）→ 绘制。空 package 框随其子节点全被隐藏而消失（桥接按剩余节点生成 package，应自然成立，AC 里钉死）；折叠计数按过滤后数量。

### 读数与 UI

- 工具栏加 `筛选 ▾` 按钮（带「已启用 N 项」徽标）与弹层（元素 / 关系 / 孤立节点）；手机端内容进底部抽屉（由手机布局任务承接容器，本任务保证弹层内容与逻辑与容器无关）。
- 读数新增第二行，只受筛选影响、与「详情」互不重叠：`已隐藏 805 个函数 · 1,288 条调用关系 ▸ 全部显示`，点击一键还原默认之外的全部显示；这一行与 `显示 N 个类 · 共 M 个相关` 的 M 是**过滤后**范围内总数。
- 改默认（隐藏函数与调用边）会让既有用例中「默认可见函数/调用边」的断言失效：必须逐处盘点（grep fixture 里的函数节点与 `call` 边断言），改成显式设置过滤或更新断言，并在实施记录列出，不得放宽断言了事。

## AC

- [x] `npx vitest run src/modules/architecture/tests/elementRelationFilter.test.ts` exit 0（新文件）：默认过滤隐藏 function/other 与 call 边；`mentionTier === 'direct'` 的节点永不被隐藏（含函数），`name`/`file` 档的 `distance === 0` 节点与普通节点一样被隐藏，缺 `mentionTier` 的旧形态节点按 `direct` 处理；`结构 ⊂ +依赖 ⊂ +调用`（边集合包含）；孤立节点开关只去掉非 `direct` 的孤立节点；`hidden.byKind/byRelation/isolated` 计数与实际移除一致；空输入/全隐藏输入不抛错
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/generator.test.ts server/modules/architecture/tests/architecture-routes.test.ts server/modules/architecture/tests/cache-invalidation.test.ts` exit 0：用含 function/interface/class 与 call/dependency/composition 的真实形态 fixture 断言——不带 `kinds/relations` 时响应与改前逐字节相同；带参数时被隐藏种类不被遍历穿过、只沿允许关系扩展、`direct` 档种子保留；隐藏函数后预算腾出的名额被结构性实体填补（`entityTruncated` 由 true 变 false 的 fixture）；缓存键因参数不同而不同、相同组合第二次不重算；`relationCounts` 与 `hidden` 为未过滤计数；非法参数返回 400
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：首次进入默认状态不渲染函数节点与 call 边，读数第二行显示已隐藏数量；`筛选 ▾` 弹层含元素（带计数）/关系三档/孤立节点；**收窄**（如关系切到 `结构`）不触发 fetch、**放宽**（重新显示函数）触发一次 fetch 且期间旧图保留并 `aria-busy`；上次响应 `entityTruncated` 时收窄触发后台补取；选择按项目记住且换项目隔离；文件视角下元素区不显示；既有用例中默认可见函数/call 的断言已逐处改为显式设置过滤（列在实施记录）
- [x] `npx vitest run src/modules/architecture/tests/archguardToPlantUml.test.ts src/modules/architecture/tests/detailRanking.test.ts` exit 0：子节点全被隐藏的 package 框不出现在 puml；详情排序的入度按过滤后的边计算（同一输入换过滤后排序结果不同的用例）
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0（12 个 locale 文案键齐全）；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（PC）打开 quay 会话 architecture tab（类图视角）：默认图里没有函数框和 `call` 边，读数第二行写着已隐藏的函数数与调用关系数；打开 `筛选 ▾` 看到元素计数（如 `函数 805`）与关系三档；切到 `结构` 图立刻变稀疏且没有网络请求；重新勾选函数后触发一次请求、旧图保留到新图到位；会话里被直接提及的函数始终在图上，而仅因同名或同文件被展开进来的函数按默认被隐藏（贴 `stats.seedTiers` 与隐藏数的读数）。再对被预算截断的会话（`2000 of 5197` 那类）对比：隐藏函数后截断提示消失或缺口变小（贴前后读数）。证据是前后截图、网络面板读数与响应里的 `stats.hidden`。

## Touches

- server/modules/architecture/generator.ts
- server/modules/architecture/service.ts
- server/modules/architecture/routes.ts
- server/modules/architecture/cache.ts
- server/modules/architecture/tests/generator.test.ts
- server/modules/architecture/tests/architecture-routes.test.ts
- server/modules/architecture/tests/cache-invalidation.test.ts
- src/modules/architecture/elementRelationFilter.ts (new)
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/useArchitectureGraph.ts
- src/modules/architecture/detailRanking.ts
- src/modules/architecture/archguardToPlantUml.ts
- src/modules/architecture/rendererContract.ts
- src/modules/architecture/tests/elementRelationFilter.test.ts (new)
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/archguardToPlantUml.test.ts
- src/modules/architecture/tests/detailRanking.test.ts
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- src/shared/api.ts
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
- tasks/architecture-element-and-relation-filters.md

## Implementation record

**Wire contract.** `POST /api/architecture/graph` gained two OPTIONAL arrays, `kinds` (⊆ class/interface/enum/abstract/function/other) and `relations` (⊆ dependency/call/composition/inheritance/implementation). An absent field is the old, unfiltered reading and the payload keeps its exact pre-filter key set (`stats.hidden` / `stats.relationCounts` are absent). An EMPTY array is legal and means "show none of that axis". A value outside the vocabulary, a non-array, or a non-string entry answers 400 `INVALID_REQUEST`. The two params are part of the content-addressed key (verified by a counting `generateGraph` injection: two filters ⇒ two builds, a repeat ⇒ `cacheHit: true`, no rebuild, unfiltered is a third key).

**Server semantics.** With a filter present the BFS runs on the filtered graph: an entity whose KNOWN kind is excluded is removed before traversal and is not traversed THROUGH (a class reachable only through a hidden function is unreachable); expansion follows only the allowed relation types (typed adjacency from `relationsByType`, or every adjacency edge as `dependency` for a legacy index); `direct` seeds are roots regardless of kind. A node with NO `arch.json` detail has no known kind and is never hidden by the element axis ("missing" is not `other`). `stats.kindCounts` / `stats.relationCounts` / `stats.hidden` are read from the UNFILTERED traversal (so the popover can show the very functions it hides); `stats.hidden.byRelation` counts only edges whose endpoints survived the element axis — an edge that leaves with a hidden node is attributed to the element cut, not double-counted as a relation removal. `hidden.isolated` is the non-exempt count in the filtered pre-budget set (the budget's own cut stays `entityTruncated`). `entityTotal` under a filter is the FILTERED pre-budget total, which is the `共 M 个相关` reading. The file graph projects the filtered reachable entity set and honours the same relation axis.

**Client semantics.** `src/modules/architecture/elementRelationFilter.ts` is the shared pure core (`applyFilter`, presets, narrowing comparison, storage vocabulary). A narrow change is answered from the arrived payload at once (and a truncated last response schedules a background refetch); a widen or a view switch schedules one debounced (250 ms) request while the old drawing stays on screen with `aria-busy="true"` and a fade. The readout's second line = the server's `stats.hidden` plus the extra hidden items the narrower local selection removes, rendered with the same labels as the popover's checkboxes.

**Unknown relation types** are treated as the `dependency` tier (allowed at `+依赖` and `+调用`, hidden at `结构`). The server's `RelationType` has no `aggregation`, so the structural REQUEST sends inheritance/implementation/composition only (a 400 would otherwise reject the preset); the client still honours `aggregation` on an arrived payload, where ArchGuard can emit it.

**File view.** File edges DO carry `relationType`, so the relation axis applies to the file view; only the element axis is class-only (a file has no kind), and the popover omits the element section there.

**Existing assertions rewritten (no assertion weakened).** Every case that draws/asserts a function box or a `call` edge now states the "show everything" filter explicitly through `rememberShowAllFilter()` (per-project `architecture.filter.*` storage): *the entity detail fields pass through the renderer contract unchanged*, *the renderer draws the neighbourhood as an SVG*, *semantic zoom toggles the drawn hierarchy without re-laying it out*, *the explosion view lays the whole hierarchy out once and zoom reveals its levels*, *expanding a deep group re-groups its subtree by directory instead of flattening its files*, *expanding a flat directory larger than the group limit draws its files, not the same box again*, *the overview never draws a (1) group and names an isolated file by its directory*, *clicking an entity drills into its neighbourhood, and the centre click adds a hop*, *edge relation labels stay hidden until a node is hovered, then leave with the pointer*, *only a direct mention carries the seed marker; name/file tiers and old payloads are read correctly*, *hovering a node highlights its in/out edges and dims the rest*, *the drawn SVG carries the stable ids sibling panels query*, *clicking an entity pins its in/out highlight and announces it to sibling panels*, *a sibling panel selects an entity by its stable id and the graph drills to it*, *an over-budget graph is capped before layout, and the readout says so with no render-all escape*. Two further cases changed because the PROPOSAL changes their behaviour, not to accommodate a weaker assertion: *activating the panel fetches once and the file/entity toggle never refetches* became *activation fetches once; a view switch re-requests because the element axis is class-only* (the proposal's "换视角：重新请求"), and the scope-stepper / remembered-knobs cases compare the first three request arguments because a fourth (filter) argument now rides along.
