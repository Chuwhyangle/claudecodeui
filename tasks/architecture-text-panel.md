---
id: architecture-text-panel
title: 停靠区「文本」页：显示当前可见图的 PlantUML，范围选择 + 字符/token 体量读数 + 复制/复制为会话上下文/下载（PlantUML 优先）
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-dock-and-inspector
  - architecture-plantuml-export-menu
---
## Proposal

用户要在画面上直接看到并复制「当前可见架构图」的 PlantUML 文本，用来在 Claude Code 会话里继续讨论（Mermaid 不是优先，只保留在导出菜单的「旧格式」项里）。真实体量决定了设计：quay 全 Entity 图的 PlantUML 是 211,243 字符 / 5,268 行（约 6 万 token），60 个节点是 4,272 字符 / 95 行（约 1.2k token），所以**范围选择与体量读数是核心，不是装饰**。本任务在停靠区外壳（相关任务）上注册第二个页签「文本」。

### 一、范围（三选一，`radiogroup`）

1. **过滤后的全图**：当前视角、范围、详情、筛选、手动调整全部生效后的那张图。
2. **当前视野内**：当前视口与节点矩形相交的节点及它们之间的边；平移/缩放结束后 400ms 重算（节点矩形读自渲染后的 SVG，一次读取并缓存，图重排才重读）。
3. **选中项及其 +1 邻居**：以当前选中（实体或关系两端）为中心的一跳邻域；没有选中时该项禁用并说明原因。

### 二、文本与体量

- 文本来源是桥接层对**所选范围的子图**产出的 PlantUML（含嵌套 package、`<<interface>>`/`<<function>>` 构造型、成员分栏与 `… +N` 行），与屏幕上画的同一份数据；生成随视图/筛选/调整变化防抖 300ms 重算，并在读数旁短暂显示「已更新」。上游 plantuml-js 的 `toPlantUml(renderDetailed().model)` 发布后只需替换「文本生成」这一个函数（接缝：`src/modules/architecture/plantUmlText.ts` 的 `buildPlantUmlText(graph, scope)`，调用方与测试不动）；在那之前，view/transform 层（聚合边、枢纽折叠）对文本的影响不在文本里体现，页内写明「按桥接层输出」。
- **体量读数**：`4,272 字符 · 95 行 · 约 1.2k tokens`；token 估算按 3.5 字符/token（实测 211,243 字符对应约 60,355）并写明「约」。三级：< 8k token 正常；8k–30k 用 `text-amber-600 dark:text-amber-400` 提示「内容较大，建议改用较小范围」；> 30k 仍可复制，但「复制为会话上下文」先弹说明对话框（复用 `src/shared/ui/Dialog.tsx`）。阈值是起点，在真实图上标定后写进实施记录。
- **渲染**：只预览前 300 行并注明「显示 300 / 5,268 行」；复制与下载永远是完整文本，绝不把全部字符塞进 DOM。`<pre>` 等宽（`font-mono text-xs`），可横向滚动，不折行。
- **语法徽标**：对生成文本调用 plantuml-js 自带的 `checkSyntax`，显示「语法通过」或第一条错误的行号与信息（只读展示，不阻止复制）。

### 三、操作

- `复制`：完整文本写入剪贴板，成功/失败用 `aria-live` 提示；剪贴板不可用时回落为带选中文本的对话框。
- `复制为会话上下文`：在文本前加头部说明——`关于架构图（项目 {项目}，会话 {会话标题}，分析于 {时间}；范围：{范围}；视角：{类图|文件}；筛选：{已隐藏的函数数与关系档位}）：`——再用 ` ```plantuml ` 围栏包住文本。
- `下载 .puml`：复用导出菜单任务提供的下载与文件名逻辑（`exportArtifacts.ts`），不重复实现。

### 四、其它

- 手机档位：同一份内容进底部抽屉（不新增断点）。
- 空图（过滤后没有节点）：显示「当前范围内没有可显示的元素」，复制按钮禁用。
- 所有文案走 i18n（12 个 locale 键齐全）；体量读数的数字用 `toLocaleString`。

## AC

- [x] `npx vitest run src/modules/architecture/tests/plantUmlText.test.ts` exit 0（新文件）：三种范围产出的 puml 节点集合正确（全图 = 过滤后的全部；视野内 = 与视口相交的节点及其间的边；选中 +1 = 选中项与一跳邻居）；选中为空时 +1 范围抛出明确的「无选中」状态而不是空文本；`buildPlantUmlText` 对同一输入确定性输出；产出的文本经 plantuml-js `checkSyntax` 无 error 级诊断；字符数/行数/token 估算（3.5 字符/token）与分级边界（8k、30k）的用例
- [x] `npx vitest run src/modules/architecture/tests/textPanel.test.tsx` exit 0（新文件）：停靠区出现第二个页签「文本」；切换范围会改变文本与读数；超过 300 行时只渲染 300 行而 DOM 中没有完整文本，复制拿到的是完整文本；8k–30k 显示提示、> 30k 点「复制为会话上下文」弹对话框；复制头部包含项目、会话、分析时间、范围、视角、筛选信息且正文被 ` ```plantuml ` 围栏包住；剪贴板拒绝时走回落路径；空图时复制禁用；「语法通过」徽标与错误行号两条用例
- [x] `npx vitest run src/modules/architecture/tests/exportMenu.test.tsx src/modules/architecture/tests/architectureTab.test.tsx` exit 0（导出菜单的下载与既有用例不回归；文本页与导出菜单共用同一份文件名与下载逻辑，断言只存在一份实现）
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（PC 1440×900）打开 quay 会话 architecture tab，点工具栏的「文本」：右侧停靠区出现 PlantUML，读数显示字符数、行数与约 token；把范围从「过滤后的全图」切到「选中项 +1」，文本与读数明显缩小（贴两次读数）；点「复制为会话上下文」，把剪贴板内容粘到一个 Claude Code 会话里能得到可读的带围栏的 PlantUML（贴粘贴结果的开头几行与该文本在 PlantUML 渲染器里的截图）。再用全图范围确认 > 30k token 时有说明对话框，页面没有因 21 万字符而卡顿（贴打开面板的耗时读数）。

## Touches

- src/modules/architecture/plantUmlText.ts (new)
- src/modules/architecture/ArchitectureTextPanel.tsx (new)
- src/modules/architecture/ArchitectureDock.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/exportArtifacts.ts
- src/modules/architecture/archguardToPlantUml.ts
- src/modules/architecture/tests/plantUmlText.test.ts (new)
- src/modules/architecture/tests/textPanel.test.tsx (new)
- src/modules/architecture/tests/exportMenu.test.tsx
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
- tasks/architecture-text-panel.md