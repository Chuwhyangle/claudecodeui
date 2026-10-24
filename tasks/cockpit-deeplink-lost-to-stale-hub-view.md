---
id: cockpit-deeplink-lost-to-stale-hub-view
title: 驾驶舱深链被中枢的陈旧视图吞掉：显式 ?view= 导航必须胜过中枢持久视图，仅裸 /cockpit 与重连才采纳中枢视图
status: done
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

决策出处：2026-10-24 驾驶舱 UX 走查（截图 `tmp/ux-*.png`）。严重度最高。现象：打开 `/cockpit?view=board&project=quay`（全新加载、侧边栏模式切换、或项目行「在驾驶舱中查看」）会落在中枢上一次持有的 board（例如 claudecodeui），URL 还被改写成那个 board。实测：在项目 claudecodeui 的 `/session/<id>` 页点「驾驶舱」段，落到 `board&project=quay`；未选中项目时本应打开 fleet 视图，同样落在陈旧 board。

机制：`src/modules/cockpit/CockpitPage.tsx` 的种子 effect（约 497-508 行，注释「hub already has a view … the URL is stale, the hub wins」）在中枢已有视图时丢弃 URL；随后「中枢 -> URL」镜像 effect（约 560-579 行）把 URL 改写成中枢视图。入口链接（`cockpit-entry-mode-switch-and-attention-badge` 已落地）因此形同虚设。

方案：
1. 区分「刻意导航」与「采纳」：URL 带显式 `view` 参数的首次进入视为刻意导航，URL 胜出，并向中枢发 `setView`（来源为本设备），中枢与其他显示端随之更新；
2. 仅当 URL 是裸 `/cockpit`（无 `view` 参数）或是同一页面内的 WebSocket 重连时，才采纳中枢持有的视图（保留「另一台设备驱动了它」的跨设备语义），镜像 effect 只在此情形把 URL 对齐到中枢；
3. 页面已挂载后中枢推来的新视图（别的设备驱动）仍按原语义镜像到 URL，不被本次修改削弱。

相关但不同机制：`cockpit-hub-cross-device-state` 建了中枢；`cockpit-entry-mode-switch-and-attention-badge` 建了入口链接，本任务修二者之间的采纳顺序。`cockpit-initiative-view-and-decision-queue`（ready）与本任务同改 CockpitPage.tsx，由调度器按 Touches 串行，不设 depends_on。

## AC

- [x] AC1: `npx vitest run src/modules/cockpit/tests/CockpitDeepLink.test.tsx` exit 0（新建）——中枢桩持有 board A、URL 为 `?view=board&project=B` 时：渲染出的视图是 B、URL 保持 B、中枢桩收到恰好一次 `setView` 且参数为 B。
- [x] AC2: 同一测试文件——裸 `/cockpit`（无 view 参数）且中枢桩持有 board A 时渲染 A 且 URL 对齐到 A、不发 `setView`；URL 为 `?view=fleet` 而中枢持有 board A 时渲染 fleet 并发 `setView(fleet)`。
- [x] AC3: 同一测试文件——页面挂载后中枢桩推送新视图（模拟另一设备驱动）时，页面渲染该视图且 URL 随之镜像；重连后（连接状态 false→true）裸 URL 采纳中枢视图。
- [x] AC4: `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0——既有用例原样通过、不弱化。
- [x] AC5: `npm run typecheck` 通过。

## DoD

- **MCP 浏览器实际操作 + 截图（必做，存 `tmp/`）**：隔离实例，先让中枢停在 claudecodeui 的 board；再依次：(1) 直接加载 `/cockpit?view=board&project=quay` 落在 quay 且 URL 不变；(2) 从 claudecodeui 的会话页点模式切换「驾驶舱」段，落在该项目 board / 无选中项目时落在 fleet；(3) 项目行「在驾驶舱中查看」落在对应项目；(4) 裸 `/cockpit` 落在中枢视图；(5) 双浏览器上下文，另一端驱动后本端仍跟随。每步 `browser_evaluate` 读回 `location.search` 与 `data-cockpit-view`。
- 场景运行器已有 `e2e/scenarios/cockpit-mode-switch.json`：跑 `node scripts/ui-scenario.mjs e2e/scenarios/cockpit-mode-switch.json` 并贴 JSON 报告与检查点截图。
- 隔离实例必须关闭 residentRestore：`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`（或用 `scripts/isolated-instance.sh`），否则会对线上同一批会话重复起进程。

## 验证记录（2026-10-24 worker）

命令（worktree `cockpit-deeplink-lost-to-stale-hub-view`）：

- AC1–AC3：`npx vitest run src/modules/cockpit/tests/CockpitDeepLink.test.tsx` → exit 0，5 tests passed（3 个 describe 共 5 条用例）。
- AC4：`npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` → exit 0，21 tests passed（文件未改动）。
- AC5：`npm run typecheck` → exit 0。
- 实现提交：`0b074e20c fix(cockpit): an explicit view link beats the hub's stale view`。

隔离实例（`scripts/isolated-instance.sh start`，`residentRestore started=0`，端口 14025）+ Vite dev（5174）。浏览器逐项读数（`tmp/deeplink-dod/readings.json`，`data-cockpit-view` / `location.search` / 中枢视图）：

| 步骤 | 预期 | 实测 |
| --- | --- | --- |
| 前提：中枢先停在 claudecodeui board | hubView board/claudecodeui | board/claudecodeui（rev 26） |
| (1) 直载 `?view=board&project=quay` | quay、URL 不变 | `?view=board&project=quay`，view board，hub 随后 setView 到 quay |
| (2a) claudecodeui 会话页点「驾驶舱」段 | board claudecodeui | `?view=board&project=claudecodeui`，Board · claudecodeui |
| (2b) 未选中项目点「驾驶舱」段 | fleet | `?view=fleet`，view fleet |
| (3) 项目行「在驾驶舱中查看」 | archguard board | `?view=board&project=archguard`，Board · archguard |
| (4) 裸 `/cockpit` | 采纳中枢 archguard | URL 镜像为 `?view=board&project=archguard` |
| (5) 双上下文：另一端驱动 | 本端跟随 | follower 由 archguard 镜像到 claudecodeui |

截图：`tmp/deeplink-dod/step-1-deep-link-board-quay.png`、`step-2-mode-switch-from-session.png`、`step-3-mode-switch-no-selection.png`、`step-4-project-row-cockpit-link.png`、`step-5-bare-cockpit-adopts-hub.png`、`step-6-two-contexts-follower.png`。

场景运行器：`node scripts/ui-scenario.mjs e2e/scenarios/cockpit-mode-switch.json --base-url http://127.0.0.1:5174 …` → `ok:true`，3/3 steps，4339ms，3 checkpoints；报告 `tmp/scenario-report.json`，检查点截图 `tmp/scenario-cockpit-mode-switch/step-{1,2,3}-*.png`。

## Touches

- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/hooks/useCockpitHub.ts
- src/modules/cockpit/cockpitRouting.ts
- src/modules/cockpit/tests/CockpitDeepLink.test.tsx
- src/modules/cockpit/tests/CockpitStage.test.tsx
- tasks/cockpit-deeplink-lost-to-stale-hub-view.md
