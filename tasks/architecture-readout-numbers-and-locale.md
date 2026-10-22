---
id: architecture-readout-numbers-and-locale
title: 读数口径统一：一句话只说「显示 N 个类 · 共 M 个相关」，两层预算收进展开说明；相对时间跟界面语言走
status: done
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-canvas-fill-and-overlay-layout
---
## Proposal

2026-10-22 实测（archguard 项目会话 `f3a974c3-510c-4761-ba48-96dff3d5220c`）：读数同一行写着 `Showing 2000 classes · 2000 related`、`Showing 556 within the layout budget; raising detail takes longer`、`449 more left out by the node budget`，而画面实际只有 17 个方框。三个「预算」叠在一起，只有一个数被叫做「显示」：

- `2000` 是详情排序保留的数（`retainedCount`，`ArchitecturePanel.tsx` 第 804 行附近），不是画出来的数；
- `556` 是布局预算裁出的数（`layoutFit.graph.nodes.length`）；
- `449` 是服务端预算没取回的数（`stats.entityTotal` 2449 − 2000）；
- 「共 M 个相关」用的是 `activeNeighbourhood.nodes.length`（2000），而不是项目里真正相关的 2449。

另外分析时间显示为 `10小时前`，其余界面是英文：`formatRelativeTime` 用 `new Intl.RelativeTimeFormat(undefined, …)`，语言取的是浏览器的而不是界面语言。

### 一、数字的定义（一个数只对应一件事）

- **N（显示 N 个类）= 真正送进布局并画出的实体数**：详情档位保留后、布局预算裁剪之后的实体总数（若某些实体被折成组框，则按组框里的成员数计入，所以 N 始终是实体数而不是方框数）。
- **M（共 M 个相关）= 当前范围内全部相关实体**：优先取服务端的 `stats.entityTotal`（预算前），缺失时取返回的节点数。筛选与手动调整生效后的口径沿用既有读数的约定，不在本任务内改。
- 折叠行（默认状态）只写 `显示 N 个类 · 共 M 个相关 ▸`；只要有任何一层预算在限制，折叠行末尾追加一个小的琥珀色标记「受预算限制」（`aria-label` 写明是哪一层），不再把预算整句摆在折叠行上。
- **展开说明**里分行写清各层（用人话，每行带「怎么调」）：详情档位保留了 X 个；布局预算只画 N 个（再多会卡，可降低详情）；服务端预算另有 K 个没取回（减小范围可看全）。三行里没有触发的不显示。
- 读数的数字用 `toLocaleString` 做千分位。

### 二、相对时间

`formatRelativeTime`/`formatAbsoluteTime` 的语言取界面语言（`react-i18next` 的 `i18n.language`），不是浏览器语言；界面是英文时显示「10 hours ago」，界面是中文时显示「10 小时前」。悬停的绝对时间同理。

### 三、不改的东西

读数在页面上的位置由相关的布局任务处理（它把读数放进画布上方的一行）；本任务只改读数的内容、数字口径与时间语言；DOM 读数属性 `data-architecture-readout-summary/-total`、`data-architecture-layout-budget*`、`data-architecture-truncated*` 保持存在且数值与新口径一致。

## AC

- [x] `npx vitest run src/modules/architecture/tests/readoutNumbers.test.ts` exit 0（新文件，纯函数 `buildReadout(inputs)`）：给定「详情保留 2000、布局预算后 556、服务端预算前总数 2449、返回 2000」，N = 556、M = 2449、预算说明三层各一行且各自带数字；三层都未触发时不出现预算标记与说明；只触发服务端预算或只触发布局预算时只出现对应一行；折成组框时 N 按成员数计；缺 `entityTotal` 时 M 回落到返回节点数；数字带千分位
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：折叠行只含 N、M 与「受预算限制」标记（不再同时出现 `layout budget` 与 `node budget` 两句）；展开后出现分层说明；`data-architecture-readout-summary` 等读数属性与新口径一致；界面语言为 `zh-CN` 时分析时间含「小时前」、为 `en` 时含「ago」，且二者都不依赖 `navigator.language`（把浏览器语言设成另一种仍按界面语言显示）；既有读数用例不回归（口径变化涉及的断言逐处列在实施记录）
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0（12 个 locale 文案键齐全）；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器打开 archguard 项目的会话 `f3a974c3-510c-4761-ba48-96dff3d5220c`：折叠行一句话读得懂（贴文字），N 与「实际被布局的实体数」一致（贴 `data-architecture-layout-ms` 旁的节点数读数），展开后三层预算分行写明且各带「怎么调」；界面是英文时分析时间不再出现中文。再把界面语言切到中文复测一次。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/readoutNumbers.ts (new)
- src/modules/architecture/layoutBudget.ts
- src/modules/architecture/tests/readoutNumbers.test.ts (new)
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/mobileCompactToolbar.test.tsx
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
- tasks/architecture-readout-numbers-and-locale.md
