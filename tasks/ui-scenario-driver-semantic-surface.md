---
id: ui-scenario-driver-semantic-surface
title: UI 场景驱动：页内语义面 + 场景运行器（比 MCP 浏览器更大颗粒度的业务场景验证）+ AGENTS.md UI 验证规则
status: ready
labels:
  - ui
  - testing
  - wall
parent: null
children: []
extra: {}
depends_on:
  - quay-wall-addressable-view-and-input-package
---
## Proposal

决策出处：用户 2026-10-23 指示——本项目要承担更多 UI/UX 交互（墙、指挥会话、语音 + 手柄的焦点导航），因此：(1) 开发过程中持续用 MCP 浏览器做模拟操作与视觉验证；(2) 实现相应接口，以比 MCP 浏览器更高效的形式验证更大颗粒度的业务场景。

问题：MCP 浏览器每一步都是一次往返（snapshot 动辄数千 token → click → 再 snapshot / 截图）。一个 15–20 步的业务场景（「焦点移到 ② → 钉进托盘 → 说一句话 → 检查输入包 → 检查路由结果」）要几十次往返。更关键的是，场景要断言的状态大多**不在 DOM 里**：焦点、可见集、托盘、输入包、路由目标、各阶段延迟。从 DOM 和截图反推这些既慢又不可靠。

方案：两层，加一条流程规则。

1. **页内语义面**（新模块 `src/modules/ui-scenario/`，仅在开发闸打开时存在）：挂 `window.__cloudcliScenario`，提供——
   - `read()`：返回结构化读数 `{route, focusables:[{uri,label,display,rect}], focus, tray, history, lastInputPack, timings}`。数据**直接取自视图契约注册表**（A/B 片 `quay-wall-addressable-view-and-input-package` 落的那份 `{uri,label,display}`），不另立一套 test-id——手柄、语音、测试共用同一份注册表，测试面就是产品面，不会漂移。
   - `drive(step)`：`focus(uri|label)`、`move(up|down|left|right)`、`zoom(in|out)`、`confirm`、`cancel`、`pin`、`utter(text)`。`utter` 注入在 **ASR 输出之后的同一个接缝**（跳过音频，但之后的路径与真实语音完全相同）。
   - 闸：构建期常量 + 运行期开关，双关才挂载；生产构建里不得出现该符号。
2. **场景运行器**（`scripts/ui-scenario.mjs <scenario.json>`）：起一个 playwright 页面，在页内一次性跑完全部步骤，每步之后按读数断言；场景里标注的检查点截图存 `tmp/ui-scenarios/<name>/`；最后输出 JSON 报告（逐步结果、失败步序号、读数差异、截图路径）。后端需要确定性回复时，复用既有 debug-agent 控制面（`server/modules/debug-agent/`）先 arm 场景，不新建第二套后端桩。
3. **与 MCP 浏览器的分工**：运行器负责大颗粒度的场景回归；MCP 浏览器负责视觉验证与探索——看运行器给出的检查点截图，在失败的那一步现场排查，并用 `browser_evaluate('window.__cloudcliScenario.read()')` 一次拿到结构化状态，代替整页 snapshot。
4. **流程规则**：在 AGENTS.md 的 Frontend code 节加一段「UI 验证」：凡改动 UI 的任务，DoD 必须包含 MCP 浏览器实际操作 + 截图（存 `tmp/`）；存在可用场景时，同时跑场景运行器并贴报告。

实施提示：新增 `src/modules/` 目录前先查 AC-394 叶子目录 manifest / MANIFEST_PIN 的要求；新 e2e spec 要在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测；按 AGENTS.md「Running tests」只跑单文件。

## AC

- [ ] AC1: `npx vitest run src/modules/ui-scenario/tests/scenarioSurface.test.ts` exit 0——`read().focusables` 与视图契约注册表中声明的内容逐项相等；`drive({focus:'②'})` 后 `read().focus` 为对应 URI；`pin` 后 `tray` 增加该 URI；`utter('把这个的第三条 AC 改宽')` 后 `lastInputPack.focus` 为当前焦点 URI，且该包与真实 ASR 输出路径构建出的包逐字相等（同一构建函数，以注入计数断言走的是同一接缝）。
- [ ] AC2: 同一测试文件——闸关闭时 `window.__cloudcliScenario` 为 undefined。
- [ ] AC3: `npx playwright test e2e/ui-scenario-runner.spec.ts` exit 0——主臂：运行器跑 `e2e/scenarios/quay-wall-focus-pin-utter.json`（≥ 6 步：打开 Quay 面板、按序号聚焦、移动焦点、钉托盘、utter、断言输入包），报告全部通过，检查点截图文件存在且非空；控制臂：同一场景把某一步的期望改错，运行器以非零退出，报告指出的失败步序号正是被改的那一步。两臂共用同一个运行器入口。
- [ ] AC4: `npm run build` 后 `grep -rc "__cloudcliScenario" dist/` 合计为 0（生产构建不含语义面）。
- [ ] AC5: `grep -n "UI 验证" AGENTS.md` 有命中，该段写明「MCP 浏览器实际操作 + 截图」与「场景运行器报告」两条要求。
- [ ] AC6: `npm run typecheck` 通过。

## DoD

- 在真实运行的 CloudCLI 上用运行器跑一个 Quay 墙场景，贴 JSON 报告与检查点截图；同一场景再用 MCP 浏览器手工走一遍，记录两种方式各自的往返次数与耗时，如实对比。
- 如实写明：哪些读数暂时取不到（例如路由结果要等指挥会话落地），以及闸的启用方式。

## Touches

- src/modules/ui-scenario/index.ts
- src/modules/ui-scenario/scenarioSurface.ts
- src/modules/ui-scenario/tests/scenarioSurface.test.ts
- src/modules/quay/QuayPanel.tsx
- src/modules/chat/utils/voice/voiceContextPack.ts
- src/main.tsx
- vite.config.js
- scripts/ui-scenario.mjs
- e2e/ui-scenario-runner.spec.ts
- e2e/scenarios/quay-wall-focus-pin-utter.json
- playwright.config.ts
- AGENTS.md
- tasks/ui-scenario-driver-semantic-surface.md
