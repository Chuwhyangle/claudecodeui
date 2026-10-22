---
id: architecture-toolbar-readout-and-legend
title: 单行工具栏 + 一句话读数 + 类/文件视角（默认类图）+ 种类统计 + 搜索 + 图例，图区占满剩余高度
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-scope-and-detail-controls
  - architecture-class-diagram-rendering
---
## Proposal

评审实测（PC 1440×900）：图区从 y=234 才开始，26% 的高度被三行控件与文字吃掉；「Hover a node…」提示出现两次；「Overview」既是文字标签又是按钮，Explosion view / Focus / Fit 三处都在表达缩放状态；三个互相矛盾的数（`18 of 301`、`1045 of 2000`、横幅里的 `2000 of 5197`）；默认进的是 File graph；没有图例、没有搜索；时间是原始 UTC ISO。本任务重做 `ArchitecturePanel.tsx` 的头部与读数：

1. **单行工具栏（约 40px）**：`[类图 | 文件]` 视角切换（默认**类图**，`radiogroup`）、范围步进器、详情三档、搜索框、`导出 ▾` 占位槽（菜单由相关任务实现）、`?`。其余全部让给图区；图区高度占比 PC ≥ 90%。
2. **一句话读数（画布左上角的浮层小标签，可点开）**：`显示 32 个类 · 共 246 个相关 ▸`。32 = 当前详情档位保留的；246 = 当前范围内全部相关实体。点开的说明写清这两个数怎么来，并给出「提高详情」「减小范围」两个按钮。服务端预算（2000）与 `5197` 不再出现在主界面；真被预算截断时在同一读数后追加「另有 N 个因预算未纳入，减小范围可看全」，取代整行橙色长文。
3. **种类统计**（只陈述事实，不做评价）：读数展开处显示 `805 函数 · 300 接口 · 5 类`（来自 payload 的 `stats.kindCounts`，缺失则不显示这一行）。
4. **来源行**（画布底部左侧的小字）：`分析于 3 小时前`（相对时间，悬停显示本地时区的精确时间，不再是 UTC ISO）；`2 个会话中提到的名字未在分析缓存中找到 ▸` 可展开，列出具体名字。
5. **搜索**：搜索框输入实体/文件名，下拉匹配项，回车或点击后跳转并聚焦到该节点（复用既有「居中某元素」能力 `centerElementInContainer`）；不在当前范围内的匹配项标注「不在当前范围」并可一键把它设为焦点。
6. **图例（`?` 弹层）**：实线/虚线、各类箭头（继承/实现/组合/聚合/依赖）、构造型、种子标记、折叠徽标含义。把现有的两条重复提示合并进这里与读数里，页面上不再有常驻的提示长句。红色圆形徽标改成带文字的标记（如 `+8 已折叠`）并写进图例。
7. 去掉冗余控件：`Explosion view / Overview / Focus` 的三处状态收敛成**一个**缩放档位指示，位置在画布内（与画布交互任务的缩放簇合并时再定位，本任务保证页面上只剩一处）。
8. 无障碍：读数变化走 `aria-live="polite"`；视角、详情是 `radiogroup`；所有控件键盘可达、焦点环清晰。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：头部只有一行（工具栏元素的 `offsetTop` 相同，jsdom 以 DOM 结构断言：工具栏容器内无换行容器）；默认视角是类图；页面不再出现重复的 Hover 提示句；读数含「显示 N 个类 · 共 M 个相关」且 N/M 与过滤结果一致；截断时同一读数追加「另有 K 个」；不再渲染 `2000 of` 之类预算数字
- [ ] 同文件新增用例：`stats.kindCounts` 存在时读数展开处显示 `805 函数 · 300 接口 · 5 类` 形态的一行，缺失则不显示；未解析种子可展开并列出名字；时间显示为相对时间且 `title` 为本地精确时间
- [ ] 同文件新增用例：搜索命中后目标节点被居中并带选中标记；范围外命中带「不在当前范围」且点击后范围/焦点更新
- [ ] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0（12 个 locale 文案键齐全）；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（PC 1440×900）打开 quay 会话 architecture tab：头部是单行 40px 左右，图区占高 ≥ 90%（用 `getBoundingClientRect` 读 host.height/innerHeight，贴数）；默认就是类图视角；读数一句话能看懂 N 与 M；点开读数看到种类统计与两个调节按钮；`?` 里有图例；搜索一个会话提到的类能直接跳过去。截图对照改前 `/tmp/arch-pc-default.png`。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/useArchitectureGraph.ts
- src/modules/architecture/svgViewport.ts
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
- tasks/architecture-toolbar-readout-and-legend.md