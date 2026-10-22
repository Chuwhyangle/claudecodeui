---
id: architecture-mentioned-entities-keep-by-kind
title: 会话提到的实体不再自动免隐藏：筛选弹层按种类给出提及数量与「保持显示」开关（默认全关），服务端与客户端用同一规则
status: todo
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

- [ ] `npx vitest run src/modules/architecture/tests/elementRelationFilter.test.ts` exit 0：默认过滤下被提到的函数被隐藏；`keepMentionedKinds` 含 `function` 时被提到的函数显示、其它函数仍隐藏；被钉住的实体在任何设置下都显示；开关打开的种类里被提到的实体不被隐藏孤立节点移除，开关关闭时按普通节点被移除；`isFilterNarrower` 对 `keepMentionedKinds` 缩小为收窄、增加为放宽；`filtersEqual` 与 `activeFilterCount` 的用例；既有「`direct` 永不被隐藏」的断言已逐处改写
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/architecture/tests/generator.test.ts server/modules/architecture/tests/architecture-routes.test.ts server/modules/architecture/tests/cache-invalidation.test.ts` exit 0：带 `kinds` 隐藏函数、不带 `keepMentionedKinds` 时被提到的函数不被画出但仍是遍历根（其允许种类的邻居出现）；带 `keepMentionedKinds: ['function']` 时被提到的函数被画出；不带 `kinds` 的请求响应与改前逐字节相同；非法 `keepMentionedKinds` 返回 400；缓存键因该参数不同而不同、相同组合第二次不重算；`stats.mentionedByKind` 与 `stats.hidden.mentionedByKind` 的计数与 fixture 构造一致且不受筛选影响或只反映被隐藏部分；被隐藏的被提到实体不占节点预算（`entityTruncated` 由 true 变 false 的 fixture）
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：默认状态下画面里没有被提到但被隐藏的函数；筛选弹层出现「会话里提到的」一节，按种类显示数量、数量为 0 的种类不出现、复选框状态有文字或 ✓ 表达；打开 `function` 的开关后被提到的函数出现且触发一次请求，收窄（关闭开关）不触发请求；读数第二行写出被隐藏的被提到函数数并带「显示提到的」，点击后函数出现；选择按项目记住且换项目隔离；既有用例中依赖「提到的函数默认可见」的断言已逐处改为显式设置（列在实施记录）
- [ ] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0（12 个 locale 文案键齐全）；`npm run typecheck` 与 `npm run build` 通过

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