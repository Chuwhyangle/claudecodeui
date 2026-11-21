---
id: gap-composer-header-backdrop-blur-streaming
title: composer/header 的 backdrop-blur 覆盖流式内容：隔离重算成本并条件化
status: done
labels:
  - gap
  - defect
  - ui
  - performance
parent: null
children: []
extra:
  schema: execution
---
## Finding

线上层审计有 2 个常驻 `BackdropFilter` 层：`src/modules/chat-composer/composer/PromptInput.tsx:43` 的 composer 和 `src/modules/project-workspace/WorkspaceHeader.tsx:152` 的 header，都在流式 transcript 上方；`src/modules/chat/tools/BashCommandDisplay.tsx:101` 也有一个。Transcript 每 100ms 合并一次（`STREAM_FLUSH_INTERVAL_MS=100`），下层的文字/滚动变化可能让 backdrop-filter 反复重算。

我们还没有隔离这项成本：全动画关掉时 running 页面仍有 4–8%，其中可能包含模糊重算，也可能是 React/流式更新。本任务先做 A/B 测量，只有确认有成本才改；不要在未测量的情况下移除视觉模糊。侧栏的同类问题已由 `gap-running-session-cpu-perpetual-animations` 修过（空层 + 有运行会话时关闭 blur），这里只处理 composer/header（BashCommandDisplay 可按同样方法顺带测）。

## AC

- [x] AC1 隔离测量：在同一 running/流式会话上，分别测 composer blur 开/关、header blur 开/关（运行时 CSS/class 注入即可），5×10s CDP，记录 total/main/GPU/recalc 到 Evidence；先打印 `composerBlurOn=... composerBlurOff=... headerBlurOn=... headerBlurOff=...`。若某项差值在噪声内（例如 <2 点 total 且 GPU 无差），记录为不显著。
- [x] AC2 修复或证据化不改：对确认显著的表面选择最小改法（不透明背景、静态背景层、流式期间条件关闭 blur 等），保留静态视觉；对不显著的表面记录证据并保持原样。不得为了关闭 blur 破坏设计或引入新的层。
- [x] AC3 既有判据：composer/header 相关测试（`src/modules/chat/tests/promptInputSubmit.test.tsx`、`src/modules/chat/tests/chatComposerResponsive.test.tsx` 等）、`npm run typecheck`、`npm run lint`、架构棘轮 exit 0；有视觉改动时附截图/说明。
- [x] AC4 线上复测：`npm run build:client` 后在 running 会话复测，读数与修复前对照写入 Evidence；若选择不改，AC4 记录“无改动 + 测量证据”。无法取读数时 park `needs-human` 并说明，不得推断。

## DoD

- 每个被测量的表面都有读数与结论；显著的才改，不显著的保持原样。
- 修复保留视觉意图，不引入新的 compositor 层或持续动画；不改变 composer/header 布局。
- 既有测试/typecheck/lint 全绿；Touches 一致。

## Touches

- src/modules/chat-composer/composer/PromptInput.tsx
- src/modules/project-workspace/WorkspaceHeader.tsx
- src/modules/chat/tests/promptInputSubmit.test.tsx
- src/modules/chat/tests/chatComposerResponsive.test.tsx
- src/index.css
- tasks/gap-composer-header-backdrop-blur-streaming.md

## Evidence

结论：**两个表面都不显著 → 不改代码、保持原样**（AC2 的证据化不改分支）。原因有两层：机制上，两个 blur 表面与流式 transcript **没有空间重叠**，transcript 不在它们的 backdrop 里；读数上，关掉 blur 的稳健统计差值为 0（GPU）到约 2 点（total），在噪声内。

### 测量环境与方法

- 真实 running/流式会话：通过 `POST /api/providers/sessions` 新建会话，再用真实 websocket `chat.send` 在 live 生产服务 `:3001`（develop 生产 bundle）上跑真实模型（v4.1flash）turn，并用 continuation 提示让同一 turn 链持续流式数分钟；测量期间 transcript jsonl 持续增长，页面常驻 `animate-spin`×2 在两个 arm 中不变。测完三个探针会话已 `DELETE ...?force=true&deletedFromDisk=true` 删除。
- 浏览器：Playwright 1.63 → HeadlessChrome 153.0.8010.12（宿主无可授权 X display，走 SwiftShader 软件光栅）。绝对值不可移植，但 A/B 对称；不重叠这一层证据与光栅器无关。
- 页级 CDP `Performance.getMetrics`（TaskDuration / ScriptDuration / RecalcStyleCount / LayoutCount）+ 浏览器级 `SystemInfo.getProcessInfo` 按进程 type 求 CPU 时间差，窗口单位换算为「% of one core」。
- 运行时代码注入验证（不变式）：`composerBlurOn=blur(4px) composerBlurOff=none headerBlurOn=blur(4px) headerBlurOff=none`

### AC1(a) — 规定的 5×10s 块设计（4 arm，拉丁方轮转）

同一 streaming 会话，每 arm 5 个 10s 窗口，中位数：

| arm | total % | main TaskDuration % | GPU % | recalc/10s |
|---|---:|---:|---:|---:|
| both-on（参照） | 25.5 | 12.02 | 5.5 | 277 |
| composer-off | 27.7 | 11.41 | 6.4 | 259 |
| header-off | 26.1 | 9.19 | 6.8 | 187 |
| both-off | 27.6 | 11.74 | 6.9 | 245 |

逐轮配对差（arm − both-on）中位数：composer-off total +4.3 / task +1.47 / GPU +1.2；header-off total −1.0 / task −3.57 / GPU +1.2；both-off total +8.7 / task +1.84 / GPU +1.5。**去掉 blur 后 GPU 反而略高，方向与「blur 有成本」相反**；块设计受 streaming burst 相位混叠（见 AC1(b) 的对照）。

### AC1(b) — 随机相邻配对（2s 窗口，on/off 相邻成对、种子化随机先后）与噪声地板

块设计里 transcript 的 burst 让 10s 窗口间 total 摆动 ±20 点，因此加做相邻配对：每对两窗相邻 2s，随机先后。`control`（两窗都 ON、无因可归）给出设计噪声地板。

| run | GPU on−off（均值 / 中位） | total on−off（均值 / 中位） | 中位 GPU on/off | 配对 GPU p10..p90 |
|---|---|---:|---:|---|
| control（15 对） | −0.33 / **0** | −1.23 / −1.5 | 4.5 / 4.5 | −1 .. +3.5 |
| composer（25 对） | +6.02 / **0** | +8.04 / +2.0 | 5.5 / 5.5 | −1.5 .. +37 |
| header（25 对） | +4.0 / **0** | +2.4 / +1.5 | 5.5 / 5.0 | −1 .. +29.5 |

均值被 2s 窗口里 30–60% GPU 的周期性 burst 拉动，而这些 burst **在两个 arm 都出现且与 arm 无关**：composer 第 18 对 off=46 / on=5.5，header 第 13 对 on=52 / off=43。稳健统计（中位）下 GPU 差值为 **0**、total 差值约 1.5–2 点，处于 control 噪声地板（GPU ±1–3.5 点）之内 ⇒ **两个表面都不显著**，符合 AC1 的「<2 点 total 且 GPU 无差」判据。

### AC1(c) — 机制读数：blur 表面与流式内容不重叠

DOM 矩形（同一条 streaming 会话，滚动容器为 transcript）：

| 视口 | header | transcript scroll | composer |
|---|---|---|---|
| 1440×900 | y 0–57 | y 57–733 | y 733–876 |
| 390×844（手机） | y 0–45 | y 45–713 | y 713–844 |

两个 blur 表面与 transcript 滚动区**首尾相邻、零重叠**，`elementsFromPoint` 在 composer 中心命中的是 composer 自身子节点而非 transcript。因此流式文字/滚动不在它们的 backdrop 内，没有可反复重算的模糊输入；这与 A/B 的零差值一致。`BashCommandDisplay`（AC 中为「可顺带测」，非必需）未单独测量：它位于 transcript 行内，backdrop 是同一行的静态背景，同样没有动态输入。

### AC2 — 证据化不改

composer 与 header 均判为不显著，按 AC 的「对不显著的表面记录证据并保持原样」**保持 `backdrop-blur-sm` 不变**：没有不透明化、没有新增静态层、没有流式期间条件关闭，`PromptInput.tsx` / `WorkspaceHeader.tsx` / `src/index.css` 零改动，视觉与布局不变。

### AC3 — 既有判据（全绿）

```
npx vitest run src/modules/chat/tests/promptInputSubmit.test.tsx src/modules/chat/tests/chatComposerResponsive.test.tsx --maxWorkers=1
→ Test Files 2 passed / Tests 19 passed
npm run typecheck → exit 0（tsconfig + server/tsconfig + scripts/tsconfig）
npm run lint → exit 0（仅既有 warning，无 error）
npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/architecture-ratchet.test.ts → 6 pass / 0 fail, exit 0
```

无视觉改动，故无截图；说明如上（零源码 diff）。

### AC4 — 无改动 + 测量证据

`npm run build:client` 在任务 worktree 通过：exit 0，产物 `dist/assets/index-DCiRzxcN.js`，`dist/build-info.json` 写入成功。本任务交付的源码 diff 为空，因此「修复后」与被测的生产页面是同一份 bundle；按 AC4 的「若选择不改」分支记录为**无改动 + 测量证据**（上文 AC1 的全部读数即测量证据），不另造一份同源的复测读数。

### ADR-007 暗轴

该轴仍暗,理由:本任务为零源码改动的 UI 性能 A/B（未触及模块依赖图），架构 L_D/L_G 没有新读数。
