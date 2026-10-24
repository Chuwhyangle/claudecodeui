---
id: cockpit-board-and-fleet-readability-polish
title: 驾驶舱 board / fleet 可读性打磨：回声横幅不挤舞台、Focus 页脚反映圈选磁贴、在途 chip 统一、目标列表默认非
  achieved 优先、id 尾部截断、空态给原因、cached 显示年龄
status: todo
labels:
  - cockpit
  - ui
  - ux
parent: null
children: []
extra:
  schema: execution
---
## Proposal

决策出处：2026-10-24 驾驶舱 UX 走查（截图 `tmp/ux-*.png`）。七处可读性问题，同属 CockpitStage / 观察墙的展示层，合并为一个任务：

(a) 输入框上方的回声横幅出现时把舞台整体下推约 32px，并裁掉最后一行；应预留其空间或改为浮层覆盖。
(b) 「全部项目」视图里某磁贴已有橙色焦点环，页脚却写「Focus: none」；页脚必须反映被圈住的磁贴。
(c) 在途 chip：①② 是单行小药丸，③④ 是两行宽条（624px / 857px），状态标签对齐不同；统一为一种 chip 布局，内容换行而不是溢出。
(d) Stage goals 列表：324 个 achieved 目标满格蓝条淹没了 29 个 draft；默认非 achieved 优先或把 achieved 折叠，achieved 不再画满格条。
(e) Recent tasks 的 id 在共同前缀中间被截断（gap-reply-suggestions-…，彼此无法区分）；改为尾部截断并带 title 提示，或换行显示。
(f) 观察墙空态「Nothing to observe right now.」没有说明什么会让它有内容，即使此刻有会话在运行；补原因与下一步（例如「钉选会话 / 项目，或等待有需要你的事项」）。
(g) 「Last synced … (cached)」里的 (cached) 很容易漏看；加上年龄（「cached 3m ago」）和过期（stale）样式。

相关但不同机制：`cockpit-stage-visual-attention-fixes`（done）处理强调色与 URI 标题；`observation-wall-ui`（done）已建墙与空态本身。与 `cockpit-unregistered-project-click-feedback`、`cockpit-header-controls-and-badge-consistency` 同改 CockpitStage.tsx，由调度器串行，不设 depends_on。

## AC

- [ ] AC1: `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0——回声出现时，横幅容器带「预留空间 / 绝对定位覆盖」的标记类（断言类名与舞台容器 padding / 定位属性，不量像素）；fleet 视图焦点在某磁贴时页脚文本含该磁贴标签而非「none」。
- [ ] AC2: 同一测试文件——4 个在途任务夹具（短 / 长标题）渲染的 chip 使用同一组布局类（`getAllByTestId` 的 className 集合只有一种），长标题带换行类而非 `whitespace-nowrap` 溢出。
- [ ] AC3: 同一测试文件——Stage goals 夹具含 5 个 achieved + 2 个 draft：draft 排在 achieved 之前，achieved 不渲染满格进度条节点（或默认折叠并显示计数）；Recent tasks 的长 id 带 title 属性且使用尾部截断类（不含中间省略逻辑）。
- [ ] AC4: `npx vitest run src/modules/cockpit/tests/ObservationWall.test.tsx` exit 0——空墙文案含原因与下一步；有运行中会话时文案提及如何钉选；既有用例不弱化。
- [ ] AC5: `npx vitest run src/modules/quay/tests/QuayPanel.test.tsx` exit 0——数据来自缓存时「cached」旁显示年龄文本，超过阈值带 stale 标记；非缓存不显示。
- [ ] AC6: `npx vitest run src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts` 与 `npm run typecheck` 均 exit 0——新文案键 12 个 locale 齐全。

## DoD

- **MCP 浏览器实际操作 + 截图（必做，存 `tmp/`）**：真实数据的隔离实例，PC 1440×900：触发回声前后用 `browser_evaluate` 读回舞台容器 `getBoundingClientRect().top` 不变且最后一行可见；All projects 视图方向键圈选后读回页脚；board 视图截图 chip、goals 列表、Recent tasks；空观察墙截图；缓存数据截图。每项修改前后对照。
- 场景运行器：`node scripts/ui-scenario.mjs e2e/scenarios/cockpit-mode-switch.json` 贴报告与检查点截图。
- 隔离实例必须关闭 residentRestore：`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`（或用 `scripts/isolated-instance.sh`）。

## Touches

- src/modules/cockpit/CockpitStage.tsx
- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/ObservationWall.tsx
- src/modules/quay/QuayPanel.tsx
- src/modules/cockpit/tests/CockpitStage.test.tsx
- src/modules/cockpit/tests/ObservationWall.test.tsx
- src/modules/quay/tests/QuayPanel.test.tsx
- src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts
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
- tasks/cockpit-board-and-fleet-readability-polish.md
