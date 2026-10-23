---
id: gap-architecture-footer-unresolved-button-clipped
title: 架构图页脚「N 个名字未找到」按钮被 truncate 裁掉：按钮移出截断段，窄屏缩短文案
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-23 移动端（390×844）真机路径审查发现：`ArchitecturePanel.tsx` 的 `sourceFooter`（`data-architecture-source-line`）把「Analysis: <时间> · N names mentioned in this session were not found…」整段放进一个 `min-w-0 truncate` 的 `<span>`，其中的 `data-architecture-unresolved` 是可点按钮。实测按钮宽 352px，容器 263px，按钮被 overflow 裁掉，只露出 "Analysis: 14 hours ago · …"；Playwright 对它的点击超时（报被 `data-architecture-source-line` 的 span 拦截）。用户在窄屏上看不到、也点不到「未解析名字」入口。

机制：可交互控件被嵌在会自我裁剪的文本容器里。改法：
- 只让「Analysis: <相对时间>」这一段 truncate；未解析按钮移出该 span，与 `Scope cleanup` 并排，同为 `shrink-0` 的小胶囊。
- 窄屏（compact 档）按钮文案缩成短句（例如「{{count}} 未匹配 ▸」，新增 i18n 键，所有 locale 补齐），完整句子放进向上展开的列表（`data-architecture-unresolved-list`）顶部。
- 保持原有约束：页脚行不能加 `overflow-hidden`（两个向上展开的面板 `absolute bottom-full` 会被裁成零高，见源码注释）。

相关但不同机制：`architecture-landscape-phone-layout`（ready，同改 ArchitecturePanel.tsx，调度器按 Touches 串行）；本任务只动页脚，保持独立验收。<!-- dedup-ref --> 合并决定：separate，原因是验收独立、改动范围只在页脚 JSX。

## AC

- [ ] 在 390px 宽的渲染下，`[data-architecture-unresolved]` 的 `getBoundingClientRect().right` 不超过其父级页脚行 `[data-architecture-source-footer]` 的 `right`（新增 vitest 断言，用例名含 `footer unresolved button stays inside the footer`）。
- [ ] 窄屏下 `[data-architecture-unresolved]` 的文本为短文案（长度小于 20 个字符），点击后 `[data-architecture-unresolved-list]` 出现且列出全部 unresolved 名字。
- [ ] 新增 i18n 键在 `src/modules/i18n/locales/` 下每个 locale 的 `common.json` 里都存在；`npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` 退出码 0。
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` 与 `src/modules/architecture/tests/mobileCompactToolbar.test.tsx` 退出码 0。

## DoD

真实落地：在 MCP 浏览器（390×844，必须触屏上下文 `hasTouch:true, isMobile:true`）里打开一个有未解析名字的会话的 Architecture 标签页，截图存 `tmp/`，页脚能看到并点开「未匹配」按钮、列表向上展开且未被裁成零高；贴出截图。涉及 UI，按 AGENTS.md 同时贴 `node scripts/ui-scenario.mjs` 场景报告（存在可用场景时）。测试存在只是必要条件，不算落地。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/zh-CN/common.json
- src/modules/architecture/tests/mobileCompactToolbar.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- tasks/gap-architecture-footer-unresolved-button-clipped.md
