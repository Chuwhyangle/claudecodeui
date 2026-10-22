---
id: architecture-scope-and-detail-controls
title: 「范围 +N」步进器 + 「详情 核心/常用/全部」：用可理解的两个旋钮取代 Hops 三按钮与不明的节点计数
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

评审结论：现在的 `Hops 1/2/3` 三个文字按钮不像数值控件，`32 of 246 nodes` 这类读数没人能懂，也没有办法调整显示多少个类。用户要的是：任一时刻只显示项目的一部分类，有办法**直观**地调多少，不必精确到一个类。

两个独立的旋钮，回答两个不同的问题：

1. **范围（Scope）**：从会话提到的类向外扩几层关联。步进器 `−  +2  +`，取值 0..3：0 = 只看会话提到的，+1 = 直接依赖/被依赖，+2、+3 依此类推。取代 `Hops 1/2/3`（`ArchitecturePanel.tsx`）；文案 `+N`，无障碍语义是 `role="spinbutton"`（或带 `aria-valuenow/min/max` 的步进组），不再用三个 `aria-pressed` 按钮。
2. **详情（Detail）**：在当前范围内保留多少，三档 `核心 · 常用 · 全部`（`radiogroup`）。按**重要度**排序后取前缀：会话提到的类始终保留；其余按「离种子的距离，再按被依赖次数（入度）」排序；`核心` 约取前 15%、`常用` 约取前 50%、`全部` 不裁（比例是起点，实现时在真实图上标定并写进实施记录）。这是**客户端本地过滤**：调节不发请求，沿用现有的本地过滤思路。
3. 排序/裁剪作为纯函数放进新文件 `src/modules/architecture/detailRanking.ts`，输入 `(nodes, edges, tier)`，输出保留的节点 id 集合与「被折叠数」；被裁掉的节点所连边一并丢弃，保留节点之间的边不丢。种子永不被裁。
4. 记住用户的选择（范围与详情）到本地存储，按项目隔离；切会话保持。

读数（「显示 32 个类 · 共 246 个相关」）与整体工具栏布局由相关任务承接，本任务只提供旋钮与可读的状态数据（`shown`、`totalInScope`），并让这两个数在旧的 `visible-summary` 位置先如实显示。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/detailRanking.test.ts` exit 0（新文件）：种子始终保留；`核心 ⊂ 常用 ⊂ 全部`（集合包含）；相同输入确定性输出；被保留节点之间的边不丢、涉及被裁节点的边被丢；全部档位下与改前完全相同
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：界面不再出现 `Hops 1/2/3` 三个按钮；步进器 `+`/`−` 改变范围、范围 0..3 之外被钳制；切换详情档位不触发新的网络请求（fetch 调用计数不变）；`aria-valuenow` 与显示值一致；既有 hover/缩放/下钻用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0：12 个 locale 的新文案键齐全
- [ ] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器打开 quay 会话 architecture tab（Entity 视角）：用 `+`/`−` 把范围从 +2 调到 +1 再到 0，图随之缩小到只剩会话提到的类及其直接关联；把详情从「全部」切到「核心」，图明显变稀疏且种子仍在；两次操作都没有网络请求（devtools 网络面板读数）。证据是前后截图与读数，不是「测试绿了」。

## Touches

- src/modules/architecture/detailRanking.ts (new)
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/useArchitectureGraph.ts
- src/modules/architecture/tests/detailRanking.test.ts (new)
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
- tasks/architecture-scope-and-detail-controls.md