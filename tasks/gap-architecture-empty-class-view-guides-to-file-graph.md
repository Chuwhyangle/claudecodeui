---
id: gap-architecture-empty-class-view-guides-to-file-graph
title: 架构图类图 0 节点但文件图有内容时给出引导：说明原因并提供切到文件图的入口
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-23 审查：会话 45ac161a 的 `POST /api/architecture/graph` 返回 `seedFiles=2、seedIdentifiers=3、entityTotal=0、fileTotal=3`，另有 `stats.unresolved.files=[".quay/config.yml", ".agents/skills/…/SKILL.md"]`。类图视图因此画不出任何东西，页面只剩 "Showing 0 · 0 related" 加一块空白画布；切到「File graph」才有 120 个文件。会话 726721c0 同样 `entityTotal=0`（种子仅 `.quay/config.yml`），也是空白。

机制：`ArchitecturePanel.tsx` 的 `ArchitectureEmptyState` 只在 `hasSeeds` 为 false 时出现（文案 `architecture.noSeeds`）。「种子已解析、但当前粒度没有可画节点」这第三种状态没有任何提示，用户无法判断是没数据、加载失败还是该换视图。

改法：
- 新增第三种空态：`hasSeeds` 为真、当前粒度 drawn 节点为 0 时，显示说明（当前视图没有可画实体）。当另一粒度有内容（`stats.fileTotal>0` 或 `entityTotal>0`）时，附带一个切换按钮「查看文件图（N 个文件）」，点击等价于切换粒度单选。
- 说明里列出 `stats.unresolved.files` 中被丢弃的文件（最多 5 个，其余用「等 N 个」），让用户知道为什么没画出来。
- `ArchitectureEmptyState` 扩展可选 `action` 属性（按钮节点），保持现有调用方不变。
- 所有新增文案走 i18n，12 个 locale 补齐。

<!-- dedup-ref --> 相关任务：`architecture-landscape-phone-layout`（ready）同改 ArchitecturePanel.tsx，调度器串行；本任务只动空态分支，保持独立验收：separate。

## AC

- [ ] 新增 vitest 用例（用例名含 `empty class view offers the file graph`）：渲染一个 `entityTotal=0、fileTotal>0` 的图，断言出现 `data-architecture-empty` 元素，且其中有可点击的「查看文件图」按钮；点击后粒度单选 `File graph` 为 checked。
- [ ] 新增 vitest 用例：`entityTotal=0` 且 `fileTotal=0` 时不出现切换按钮，只显示说明。
- [ ] 空态说明列出 `unresolved.files` 的前 5 项，超出部分显示「等 N 个」形式的计数（vitest 断言文本）。
- [ ] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` 退出码 0（新增键 12 个 locale 齐全）。
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` 退出码 0。

## DoD

真实落地：MCP 浏览器（390×844，触屏上下文）打开一个类图为空、文件图非空的会话（例如 45ac161a）的 Architecture 标签页，截图存 `tmp/` 并贴出：看到引导文案，点击按钮后进入文件图。涉及 UI，按 AGENTS.md 同时贴 `node scripts/ui-scenario.mjs` 场景报告（存在可用场景时）。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/ArchitectureEmptyState.tsx
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/en/common.json
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
- src/modules/architecture/tests/architectureTab.test.tsx
- tasks/gap-architecture-empty-class-view-guides-to-file-graph.md
