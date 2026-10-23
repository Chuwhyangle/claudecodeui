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

- [x] AC1: `npx vitest run src/modules/ui-scenario/tests/scenarioSurface.test.ts` exit 0——`read().focusables` 与视图契约注册表中声明的内容逐项相等；`drive({focus:'②'})` 后 `read().focus` 为对应 URI；`pin` 后 `tray` 增加该 URI；`utter('把这个的第三条 AC 改宽')` 后 `lastInputPack.focus` 为当前焦点 URI，且该包与真实 ASR 输出路径构建出的包逐字相等（同一构建函数，以注入计数断言走的是同一接缝）。
- [x] AC2: 同一测试文件——闸关闭时 `window.__cloudcliScenario` 为 undefined。
- [x] AC3: `npx playwright test e2e/ui-scenario-runner.spec.ts` exit 0——主臂：运行器跑 `e2e/scenarios/quay-wall-focus-pin-utter.json`（≥ 6 步：打开 Quay 面板、按序号聚焦、移动焦点、钉托盘、utter、断言输入包），报告全部通过，检查点截图文件存在且非空；控制臂：同一场景把某一步的期望改错，运行器以非零退出，报告指出的失败步序号正是被改的那一步。两臂共用同一个运行器入口。
- [x] AC4: `npm run build` 后 `grep -rc "__cloudcliScenario" dist/` 合计为 0（生产构建不含语义面）。
- [x] AC5: `grep -n "UI 验证" AGENTS.md` 有命中，该段写明「MCP 浏览器实际操作 + 截图」与「场景运行器报告」两条要求。
- [x] AC6: `npm run typecheck` 通过。

## DoD

- 在真实运行的 CloudCLI 上用运行器跑一个 Quay 墙场景，贴 JSON 报告与检查点截图；同一场景再用 MCP 浏览器手工走一遍，记录两种方式各自的往返次数与耗时，如实对比。
- 如实写明：哪些读数暂时取不到（例如路由结果要等指挥会话落地），以及闸的启用方式。

## Touches

- src/modules/ui-scenario/index.ts
- src/modules/ui-scenario/scenarioSurface.ts
- src/modules/ui-scenario/tests/scenarioSurface.test.ts
- src/modules/quay/QuayPanel.tsx
- src/modules/chat/utils/voice/voiceContextPack.ts
- src/modules/chat/index.ts
- src/main.tsx
- vite.config.js
- scripts/ui-scenario.mjs
- e2e/ui-scenario-runner.spec.ts
- e2e/scenarios/quay-wall-focus-pin-utter.json
- playwright.config.ts
- AGENTS.md
- tasks/ui-scenario-driver-semantic-surface.md

## Evidence

实现落点（2026-10-23，worktree `task/ui-scenario-driver-semantic-surface`）：

- **语义面**：`src/modules/ui-scenario/scenarioSurface.ts` 安装 `window.__cloudcliScenario`（`read()` / `drive(step)`），`src/main.tsx` 在 `import.meta.env.DEV` 下动态导入安装。`QuayPanel` 的 In-flight tile 用 `publishScenarioViewContract` 把自己渲染用的同一份 `{uri,label,display}` 契约推入注册表——`read().focusables` 不是另一套 test-id，`②` 在产品面和场景面是同一个对象。
- **闸（双关）**：构建期 `import.meta.env.DEV`（生产构建整支删除，AC4 实测为证）＋ 运行期 `localStorage['ui-scenario'] = 'on'` 或 URL `?ui-scenario=1`；两者都开才挂载，运行期值只认显式 `on`/`1`。
- **utter 的同一接缝**：跳过音频后调用 `buildVoiceReferencePack`，其文本半部就是真实 ASR 上传路径调用的 `buildVoiceInputContextPack`；该函数内新增 `readVoiceInputPackBuildCount()` 自增计数，`utter` 记录本次的差值 `seamBuilds`（必须为 1），单测再断言 `lastInputPack.text` 与直接调用 `buildVoiceInputContextPack` 的输出逐字相等。
- **运行器**：`node scripts/ui-scenario.mjs <scenario.json> --base-url <url> --auth-token <t> --project <name> --session <name> [--out <dir>]`。检查点之间的连续步骤在**一次**页内 `evaluate` 里全部执行；报告 JSON 打到 stdout（失败也打印完整报告，stderr 一行摘要），`<out>/report.json` 与检查点 PNG 落盘；失败步以 1-based `failedStep` 命名。`open` 是唯一触碰 DOM 的步骤（导航到视图），其余全是语义面读数。
- **场景**：`e2e/scenarios/quay-wall-focus-pin-utter.json`，6 步。

### AC 逐条读数

- AC1/AC2：`npx vitest run src/modules/ui-scenario/tests/scenarioSurface.test.ts` → `2 passed`（文件内两条用例；闸关臂真值：`attachScenarioSurface()` 返回 `false`、`window.__cloudcliScenario === undefined`）。
- AC3：`npx playwright test e2e/ui-scenario-runner.spec.ts` → `1 passed (9.8s)`。两臂同一入口 `scripts/ui-scenario.mjs`：主臂 `ok:true`、6 步、2 张检查点；控制臂只把第 3 步 `focusLabel` 由 `②` 改成 `①`，退出 1，`failedStep: 3`，失败文本 `focusLabel: expected "①", read "②"`，且第 1–2 步仍为通过（证明失败点是被改的那一步，不是整轮早倒）。
- AC4：`rm -rf dist && npm run build` 后 `grep -rc "__cloudcliScenario" dist/` 合计 **0**；`dist/assets` 无任何 ui-scenario chunk（静态 false 分支把动态 import 与其 chunk 一起删掉）。
- AC5：`grep -n "UI 验证" AGENTS.md` → `11:### UI 验证`，段内含「MCP 浏览器实际操作 + 截图」与「场景运行器报告」两条。
- AC6：`npm run typecheck` → exit 0（client / server / scripts 三段）。
- 回归：`QuayPanel.test.tsx`（31 passed）与 `voiceContextPack.test.ts`（20 passed）在改动后仍绿。

### DoD：真实 CloudCLI 上的运行器报告

在 e2e 的**真实 client + server** 上跑（fixture 项目通过 `.quay/plugin` 调用真实 quay CLI，`worker-round.jsonl` 提供在飞任务；面板截图见下），主臂报告：

```json
{
  "scenario": "quay-wall-focus-pin-utter",
  "ok": true,
  "failedStep": null,
  "stepCount": 6,
  "durationMs": 4525,
  "checkpoints": [
    { "step": 1, "file": ".../tmp/ui-scenarios/e2e-main/step-1-open-quay-panel.png" },
    { "step": 6, "file": ".../tmp/ui-scenarios/e2e-main/step-6-expect.png" }
  ]
}
```

检查点截图均存在且非空：`step-1-open-quay-panel.png`（116 KB，可见 Quay 面板、In flight 行 ①②）、`step-6-expect.png`（118 KB）。截图与报告落在 `tmp/`（不入库）；`tmp/ui-scenarios/e2e-main/report.json` 是完整逐步读数。控制臂报告：`ok:false`、`failedStep:3`、退出码 1。

往返/耗时对比（如实）：

- **运行器臂**：6 步约 **13 次 page 协议往返**（open 段 9 次：goto、项目/会话/Quay 标签点击、面板与注册表等待；每个检查点段 1 次合并 evaluate；2 次截图），主臂实测 **4.53 s**（含导航与截图，不含 chromium 启动）。第 2–6 步只花 1 次 evaluate。
- **MCP 浏览器手工臂：未实测。** 本 worker 会话没有暴露任何浏览器 MCP 工具（可用工具面只有 quay / archguard / meta-cc / plantuml），无法在这里手工走一遍；不编造读数。按同一步数模型化，MCP 路径每步至少一次 snapshot + 一次动作（通常再补一次 snapshot 验证），约 18–24 次往返，且每次 snapshot 携带整页数千 token——这正是运行器要消除的成本。真实对比需在带浏览器 MCP 的会话里补测，届时按同一场景记录往返次数与总耗时。

暂时取不到的读数（如实）：

- **路由/投递结果**：`utter` 停在输入包接缝（`lastInputPack`），指挥会话的路由目标尚不存在，`read()` 当前没有该字段。接上之后应作为独立读数加入（不是从 DOM 反推）。
- **zoom 子视图契约**：墙的 zoom 导航是后续工作；`drive({ zoom: 'in' })` 只把当前焦点 URI 记入 `zoomStack`，不发布子视图契约，`read().focusables` 仍是父视图声明。
- **真实语音链路**：`utter` 跳过音频，所以 VAD、分段与回环延迟不在本场景读数内；它证明的是「ASR 输出之后」的接缝（同一构建函数 + 计数器），不是整条语音链路。
- **rect**：Proposal 里的 `focusables[{uri,label,display,rect}]` 中的 `rect` 暂未提供——布局几何属于 DOM，按本任务「读数不来自 DOM」的方向留待后续（需要由视图在契约里声明，而不是测试去量）。