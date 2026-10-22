---
id: architecture-mentioned-entities-keep-by-kind
title: 会话提到的实体不再自动免隐藏：筛选弹层按种类给出提及数量与「保持显示」开关（默认全关），服务端与客户端用同一规则
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

2026-10-22 在 4 个会话里实测：默认「隐藏函数」几乎被架空，因为会话里直接提到（`mentionTier === 'direct'`）的实体对元素筛选「免隐藏」，而函数名大多唯一，几乎都算 `direct`。`distance 0` 的直接提及按种类统计：本会话 函数 35 · 类 5；live voice 函数 15；「现有语音模型的上下文识别对比」函数 2；「Quay 的 OO 设计重构」函数 20 · 类 6 · 接口 11 · 抽象类 3。免隐藏的实际作用对象因此几乎全是函数（类、接口、抽象类默认本来就显示），结果是没选中任何函数，画面上仍有一大批函数（live voice 会话画出的 18 个实体里 15 个是函数）。提及次数差别也很大（本会话 `hasArchguardCache` 21 次，另一会话的两个函数都只有 1 次）。

用户的决定（2026-10-23）：**默认全部关闭，包括类和接口**；**开关打开的种类，其被提到的实体不受「隐藏孤立节点」影响**；**只做按种类的开关，不做提及次数阈值**；**服务端同步修改**。

### 一、规则

1. 元素筛选隐藏某个种类时，该种类里被会话直接提到的实体**也被隐藏**（不再自动免隐藏），除非用户为该种类打开「保持显示会话里提到的」。被钉住（`pinned`）的实体仍永远免隐藏，不受本规则影响。
2. 开关**按种类**，默认全部关闭（`function`、`class`、`interface`、`enum`、`abstract`、`other` 六种各一个）。某种类本身可见时，开关无可见效果（被提到的类默认就显示），但数量照常显示；用户之后手动隐藏某个种类时，该种类被提到的实体随之被隐藏，除非它的开关打开。
3. **隐藏孤立节点**：开关打开的种类里被提到的实体不被当作孤立节点移除（延续「种子不被当孤立节点」的做法）；开关关闭的种类里被提到的实体按普通节点处理，照常受「隐藏孤立节点」影响。
4. 被隐藏的、会话提到的实体**仍作为服务端遍历的根**（范围 +N 仍从它们向外扩），只是自己不被画出；它们邻居里种类允许的实体照常出现。
5. 选择按项目记住（与既有的元素/关系筛选偏好一起存，沿用同一个存储键族，不另造一套），换项目隔离。

### 二、服务端

- `POST /api/architecture/graph` 新增可选参数 `keepMentionedKinds?: EntityKind[]`（词汇表与 `kinds` 相同，非法值返回 400）。缺省或空数组 = 被隐藏种类里被提到的实体不被画出（但仍是遍历根）。只有同时带了 `kinds` 时它才有意义；不带 `kinds` 的旧客户端与手搓 stub 行为不变（没有筛选）。**这改变了「带 `kinds` 但不带 `keepMentionedKinds`」的既有语义**（此前直接提及永远保留），现有断言必须逐处改写并列在实施记录里。
- 缓存键包含 `keepMentionedKinds`（排序去重后），同一组合不重算；`generator.ts` 里「direct seeds are never hidden by this axis」的注释与实现一并改。
- 响应 `stats` 追加可选字段：`mentionedByKind`（当前范围内被直接提到的实体按种类的计数，**不受筛选影响**，供筛选弹层显示数量）与 `hidden.mentionedByKind`（被筛选隐藏的被提到实体按种类的计数，供读数第二行使用）。字段缺失即旧形态。
- 预算：被隐藏的被提到实体不占节点预算；隐藏函数后腾出的名额照常被其他实体填补。

### 三、客户端

- 筛选状态 `ArchitectureElementRelationFilter` 追加 `keepMentionedKinds`（默认空数组）；`applyFilter` 按上面第 1–3 条判定免隐藏与孤立节点；`isFilterNarrower`/`filtersEqual`/`activeFilterCount` 同步：缩小 `keepMentionedKinds`（去掉某个种类）视为收窄（本地即时过滤，除非上次响应被预算截断才补取），增加视为放宽（重新请求）。
- **筛选弹层新增一节「会话里提到的」**：每个有数量的种类一行，显示 `种类名 数量` 与一个复选框（文字或 ✓ 表达开/关状态，不只靠底色）；数量为 0 的种类不显示；该节整体说明「即使该种类被隐藏也保持显示会话里提到的」。
- **读数第二行**：`已隐藏 451 个函数（其中 35 个在会话里提到过）· 503 条调用关系 ▸ 显示提到的`，点击「显示提到的」等价于打开 `function` 的开关（只作用于当前有隐藏的被提到种类）。
- 详情排序、文本页、导出、选择托盘等已有功能读到的是「被画出的图」，无需单独改；种子标记只会出现在被画出的实体上。

## AC

- [x] `npx vitest run src/modules/architecture/tests/elementRelationFilter.test.ts` exit 0：默认过滤下被提到的函数被隐藏；`keepMentionedKinds` 含 `function` 时被提到的函数显示、其它函数仍隐藏；被钉住的实体在任何设置下都显示；开关打开的种类里被提到的实体不被隐藏孤立节点移除，开关关闭时按普通节点被移除；`isFilterNarrower` 对 `keepMentionedKinds` 缩小为收窄、增加为放宽；`filtersEqual` 与 `activeFilterCount` 的用例；既有「`direct` 永不被隐藏」的断言已逐处改写
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/generator.test.ts server/modules/architecture/tests/architecture-routes.test.ts server/modules/architecture/tests/cache-invalidation.test.ts` exit 0：带 `kinds` 隐藏函数、不带 `keepMentionedKinds` 时被提到的函数不被画出但仍是遍历根（其允许种类的邻居出现）；带 `keepMentionedKinds: ['function']` 时被提到的函数被画出；不带 `kinds` 的请求响应与改前逐字节相同；非法 `keepMentionedKinds` 返回 400；缓存键因该参数不同而不同、相同组合第二次不重算；`stats.mentionedByKind` 与 `stats.hidden.mentionedByKind` 的计数与 fixture 构造一致且不受筛选影响或只反映被隐藏部分；被隐藏的被提到实体不占节点预算（`entityTruncated` 由 true 变 false 的 fixture）
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：默认状态下画面里没有被提到但被隐藏的函数；筛选弹层出现「会话里提到的」一节，按种类显示数量、数量为 0 的种类不出现、复选框状态有文字或 ✓ 表达；打开 `function` 的开关后被提到的函数出现且触发一次请求，收窄（关闭开关）不触发请求；读数第二行写出被隐藏的被提到函数数并带「显示提到的」，点击后函数出现；选择按项目记住且换项目隔离；既有用例中依赖「提到的函数默认可见」的断言已逐处改为显式设置（列在实施记录）
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0（12 个 locale 文案键齐全）；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器分别打开 claudecodeui 项目的四个会话（本会话、live voice、「现有语音模型的上下文识别对比」、「Quay 的 OO 设计重构」）的 architecture tab：默认画面里不再出现因被提到而显示的函数（读数第二行写出「其中 N 个在会话里提到过」，N 与上述统计一致：35、15、2、20）；打开筛选弹层看到「会话里提到的」一节与各种类数量；打开「函数」开关后这些函数出现且不被孤立节点规则移除；再关闭，图立即恢复且没有网络请求；对被预算截断的会话，隐藏被提到的函数后截断提示变小或消失。证据是前后截图、网络面板读数与响应里的 `stats.mentionedByKind`、`stats.hidden.mentionedByKind`。

## Touches

- server/modules/architecture/generator.ts
- server/modules/architecture/service.ts
- server/modules/architecture/routes.ts
- server/modules/architecture/cache.ts
- server/modules/architecture/tests/generator.test.ts
- server/modules/architecture/tests/architecture-routes.test.ts
- server/modules/architecture/tests/cache-invalidation.test.ts
- src/modules/architecture/elementRelationFilter.ts
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/useArchitectureGraph.ts
- src/modules/architecture/rendererContract.ts
- src/modules/architecture/tests/elementRelationFilter.test.ts
- src/modules/architecture/tests/architectureTab.test.tsx
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
- tasks/architecture-mentioned-entities-keep-by-kind.md

## 实施记录

### 语义改动（既有断言逐处改写）

服务端（`generator.test.ts` / `architecture-routes.test.ts`）：

1. 「元素筛选：被隐藏种类的节点不穿过（其后代不可达），direct 种子仍保留」→ 改名并改写为「……被提到的隐藏实体不画但仍是遍历根」：`identifiers: ['Fn']` 的 direct 函数种子不再被画出（`['A','D']`），开关打开后重新出现（`['A','D','Fn']`）。
2. `stats.hidden` / `relationCounts` 与预算两处 `deepEqual` 增加 `mentionedByKind` 键；`mentionedByKind` 的读数断言由 `{}` 改为 `{ class: 1 }`（`A`/`Seed` 是唯一的直接提及）。
3. 路由 `kinds: []` 用例：此前「distance-0 direct seed 免隐藏」⇒ 只剩 `Seed`；现在 `Seed` 也被隐藏（`[]` 且无 class 开关），新增 `keepMentionedKinds: ['class']` 一腿证明开关能把它带回来。
4. 路由「a kinds filter…」用例的 direct seed 腿改写为：被提到的函数默认不画、其 class 邻居 `Deep` 仍出现（遍历根），`keepMentionedKinds: ['function']` 时重新画出。
5. 缓存键用例新增 `keepMentionedKinds` 维度（不同列表 miss、同一组合（任意顺序）命中、generator 收到排序后的列表）；`cache-invalidation.test.ts` 的 `TestParams` 增加 `kinds`/`keepMentionedKinds` 并新增一条开关内容键用例。

客户端（`elementRelationFilter.test.ts` / `architectureTab.test.tsx`）：

1. 纯函数用例整体重写：默认下被提到的 `DF` 函数被隐藏并计入 `hidden.mentionedByKind`；`keepMentionedKinds: ['function']` 只放回被提到的那个；pinned 在任何设置下都显示；开关打开/关闭对孤立节点移除的两个方向各一条；`isFilterNarrower` 的收缩/放宽、`filtersEqual` 的集合比较、`activeFilterCount` 的计数各加用例。
2. 依赖「提到的函数默认可见」的三个既有面板用例改为显式设置：`rememberDefaultWithMentionedFunctions()`（默认筛选 + `keepMentionedKinds: ['function']`）用于「entity boxes are UML class shapes…」「the class view opens on the entities themselves…」「the toolbar wraps instead of scrolling…」——断言本身未削弱，图仍是旧数据描述的同一张图。
3. 新增四个面板用例：默认不画被提到的函数且弹层/读数提供入口；「显示提到的」只打开当前被隐藏的种类并发出一次请求；关闭开关是收窄、不发请求；开关按项目记住且另一项目从全关开始。

### 读数

- 纯函数：`elementRelationFilter.test.ts` 23 passed。
- 服务端：`generator.test.ts` 20 passed；`cache-invalidation.test.ts` 13 passed；`architecture-routes.test.ts` 32 passed。
- 客户端：`architectureTab.test.tsx` 81 passed（含 4 条新增）；`i18nArchitectureTabCompleteness.test.ts` 6 passed；`npm run typecheck`、`npm run build` 通过。
- 新增 4 个文案键（`architecture.filter.mentioned` / `mentionedHint` / `mentionedInKind` / `showMentioned`）已写入全部 12 个 locale。

### 设计取舍

- `keepMentionedKinds` 只在带 `kinds` 时生效；单独发送时服务端接受并把结果交给 generator，但 generator 以 `params.kinds === undefined` 短路，所以响应与「无筛选」逐字节一致（`stats.mentionedByKind` 也不出现）。
- 被隐藏的被提到实体保留在 `allEntityIds`（文件图投影与未过滤读数仍看到它打开的 scope），只从 `drawnDistance` 移除——因此不占实体节点预算，`entityTotal` 为被画出候选数。
- 客户端 `isKindExempt` 与 `exemptFromIsolation` 分开：元素轴与孤立节点轴对「被提到」的判定在字面上是两条规则（规则 1 vs 规则 3），合并会让某项读数不成立。

### DoD 状态

DoD 要求真实浏览器在四个会话里核对前后截图与网络面板；本 worker 会话只完成代码、单测与构建，浏览器证据留给人工/后续验收。