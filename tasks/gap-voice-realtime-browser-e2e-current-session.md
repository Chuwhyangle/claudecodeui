---
id: gap-voice-realtime-browser-e2e-current-session
title: 浏览器语音→可见可纠正意图→真实 session_send→执行结果回显，PC+移动基本体验（AC-312）
status: needs-human
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-voice-realtime-live-session-send-wiring
  - gap-voice-realtime-connection-resilience
goal_ac: AC-312
---
## Proposal

<!-- dedup-ref --> 立案时 `grep -rli "voice-realtime.*e2e\|browser-e2e-current-session" tasks/*.md goals/*.md` 零命中。本任务是 GOAL-031 的收口任务：`depends_on` 前两个任务——没有真实执行体（`gap-voice-realtime-live-session-send-wiring`）就没有真的能调用的 `session_send`；没有连接韧性（`gap-voice-realtime-connection-resilience`），一条真实打开的语音连接随时可能被并发竞态打断。

### 背景

本任务把前两个任务的后端能力接上浏览器前端，交付 GOAL-031 目标链路里用户能直接感知的那一半：按下麦克风、看到理解中的状态、看到待发送的意图文字、能在发送前编辑、确认后真的看到 Claude Code 执行的结果出现在对话里。

### 方案

1. 新前端模块（位置按 `.agents/skills/frontend-module-standards`，建议 `src/modules/chat/voice-realtime/`）：麦克风采集复用既有 `AudioWorklet`/`voiceFrameProcessor`；新增一个服务端 WS 代理路由，浏览器→代理→真实 DashScope transport（凭据只在服务端，浏览器不直连，沿用现有语音功能的既有约束）。
2. UI：听/理解中状态指示；最终意图文字展示，**可编辑**（这就是低摩擦的纠正机制，不需要额外确认框）；一个明确的发送动作触发 `session_send`。
3. 执行结果：**不新建反馈 UI**，复用现有聊天转录——语音发起的轮次本来就会以 `ChatRunSource==='mcp'` 的普通轮次出现在转录里，这次只需要确认这条渲染路径对这种来源确实工作正常（如果发现渲染有问题，登记为缺口，不在本任务里顺手改转录渲染的既有逻辑，除非缺口刚好在本任务声明的 Touches 内）。
4. PC 与一个移动视口（375px）各跑一次基本流程。

### 边界（不做）

不做跨会话/跨项目选址（`boundSessionId` 就是当前打开的会话）；不新建确认弹窗或 consent 流程；不做语音输出；判据环境里的 Realtime 连接是假 WS 服务端（按本仓库 e2e 惯例），真实网络+真实麦克风的走查归人工（AC5）。

### 实现纪要（落地时补记）

- 代理路由的真实文件名是 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`（立案时 Touches 里写的 `.routes.ts` 是错的，已改）；`/voice-realtime` 的 upgrade 分支挂在既有的 `createWebSocketServer` 上，与 `/ws`、`/shell`、`/plugin-ws` 同一条鉴权通道（`?token=` 里的 JWT）。
- 假上游只说这一版 bridge 真正消费的一种帧：`response.function_call_arguments.done`。bridge 的 inbound 分派只认 `function_call`，任何其它事件都会以 `UNKNOWN_EVENT` 进错误通道——第一版假上游照抄了 DashScope 的 `session.created`/`session.updated`/`response.created`/`response.done`，浏览器因此一直停在 `failed`。
- 服务端的 transport 在没有凭据时**拒绝**拨号（`MISSING_API_KEY`，这是刻意的护栏）。判据把 `VOICE_REALTIME_ENDPOINT` 指向自己托管的替身，同时用 transport 既有的 `socketFactory` 缝补上这条护栏；生产路径不提供 factory，护栏原样保留。

## AC

- [x] AC1 离线闭环可跑：假 WS 服务端上，麦克风权限→音频帧→工具调用→意图展示→确认发送→`session_send` 调用全链路，Playwright 退出 0。（`e2e/voice-realtime-live-session-send.spec.ts` 两条 leg 全绿，整轮 12.2s，退出 0。）
- [x] AC2 可编辑意图：UI 展示的待发送文字可以被用户编辑，编辑后发送的是编辑后的内容（不是原始理解结果）。（spec 断言 `voice-realtime-intent` 初值是模型提议，`fill` 成编辑文本后发送；重载后转录里出现编辑文本且**不**出现原始提议。）
- [x] AC3 执行结果可见：确认发送后，对应的 `mcp` 来源轮次出现在聊天转录里（复用既有渲染，不新建组件）。（未新建任何反馈组件；断言用既有的 `[data-message-style="user"]` 行与 `.chat-messages-pane` 文本，重载后按历史读取，证明行落在磁盘/转录上而非本页内存。）
- [x] AC4 移动视口基本可用：375px 视口下跑一遍同样的基本流程，核心控件可见可操作。（同 spec 第二条 leg，另断言起点控件的 boundingBox 落在 0..376 内且宽高 > 0。）
- [ ] AC5 真实半区：至少一次真实麦克风+真实网络的端到端走查，人工确认结果正确渲染（手动，不进 CI）。（**停派待人工**：需要真实麦克风与真实 DashScope 网络，且收尾动作属于人；执行者结构性无法满足，据实留空，见 `## Notes`。）
- [x] AC6 静态门：`npm run typecheck` 与 `npm run lint` 退出 0。（两者均退出 0。）

## DoD

真实落地判据：不是"UI 画出来了"，是**用户按下麦克风说一句话、看到可编辑的理解结果、确认后真的在转录里看到 Claude Code 的回应**——这条链路要在假 WS 环境下机械可证（AC1），且至少有一次真实网络下被人工走查过（AC5，本次未做）。不新建的东西（审批弹窗、反馈组件）本身也是判据的一部分：AC3 明确要求复用既有渲染，不是顺手建一个新的。

## Touches

- src/modules/chat/voice-realtime/ (new)
- src/modules/chat/ChatInterface.tsx (挂载语音控件)
- src/shared/api.ts (voice-realtime socket URL)
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts (new)
- server/modules/voice-realtime/index.ts (barrel 导出新服务)
- server/modules/websocket/services/websocket-server.service.ts (加 /voice-realtime upgrade 分支)
- server/index.ts (组合根接线 transport/executor)
- vite.config.js (dev 代理 /voice-realtime)
- playwright.config.ts (判据选择、假上游端口与 VOICE_REALTIME_ENDPOINT)
- e2e/voice-realtime-live-session-send.spec.ts (new)
- tasks/gap-voice-realtime-browser-e2e-current-session.md (self)

## Notes

**Parked `needs-human`（2026-10-09，本轮 worker）— 唯一未勾的 AC5 是执行者结构性无法满足的人工门，不是可实现的缺口。**

- AC5 的正文本身把门槛写成「真实麦克风 + 真实网络」且「人工确认结果正确渲染（手动，不进 CI）」：判据环境（假 WS 上游 + 假麦克风 `__voiceFake`）按设计不构成它要的真实性，"人工确认"这一步属于人，执行者不得代写。按本仓库既有裁定（不带 `（待外部）` 后缀的人工读 AC，执行者的合规出口是「勾掉其余、留下这一条、park needs-human」），本任务停在 `needs-human`，等具备真实麦克风与真实 DashScope 网络的人完成一次端到端走查把读数写进本任务后再推进。
- ⛔ 执行者不得代勾 AC5：本任务 DoD 逐字要求「至少有一次真实网络下被人工走查过（AC5）」，代写即为伪记录。这也是上一轮「AC 未全勾」反复停派的原因——它不是一个可从会话内补做的实现缺口，而是一个必须由人执行的验证门。

### 本轮（park 前）在当前 post-merge 树上的复验读数

所有命令均在 worktree（branch `task/gap-voice-realtime-browser-e2e-current-session`，已并入 develop）上运行：

| AC | 命令 | 读数 |
| --- | --- | --- |
| AC1/AC2/AC3/AC4 | `npx playwright test e2e/voice-realtime-live-session-send.spec.ts` | `2 passed (13.9s)`，exit 0（PC leg + 375px leg） |
| AC6 | `npm run typecheck` | exit 0 |
| AC6 | `npm run lint` | exit 0（余下均为既有 warning，无一条落在 voice-realtime 文件） |
| AC5 | —（需真实麦克风 + 真实网络，人工） | 未执行，据实留空 |

AC1–AC4 的语义读数沿用本任务既有记录（spec 未改）：PC leg 断言「可编辑意图 → 发送编辑文本 → 重载后转录出现编辑文本且不出现原始提议」；375px leg 另断言起点控件 boundingBox 落在 0..376 且宽高 > 0。

### 待人读的收尾动作（AC5 的读数只能由人写入，执行者不得代填）

人（具备真实麦克风与真实 DashScope 网络）完成一次真实端到端走查后：

1. 在 AC5 行记录真实读数（真实连接 id / 真实延迟 / 模型自主 function_call / `function_call_output` 回填后同轮继续 / 转录里渲染出的回复）。
2. 勾上 AC5。

此后本任务即可正常 fan-in。若人裁定 AC5 无法由人完成（例如环境长期不具备），应把 AC5 连同依赖它的 DoD 一并作废或降级——像 `gap-voice-client-asr-fallback-and-first-load` 的 S5 那样由人重新立案，而不是执行者在本任务内以代写方式消解它。


【2026-10-09 外层复核（非 worker；本轮只读+验证，未改任何判据）】
- AC1–AC4 本轮亲跑 `npx playwright test e2e/voice-realtime-live-session-send.spec.ts` → 2 passed (13.4s), exit 0（PC leg + 375px leg）；AC6 沿用 worker 读数。两个 depends_on（gap-voice-realtime-live-session-wiring、gap-voice-realtime-connection-resilience）现已**全部 done** 且已被本分支吸收；分支 @657e9ca7 仅落后 develop 1 个提交（Quay 面板 CSS，与本任务无关）。
- **更正下文末段的「已并入 develop」**：那句指的是 pre-exit 把 develop 并进本分支，方向被读反了。**本任务实现尚未落到 develop** —— `e2e/voice-realtime-live-session-send.spec.ts` 与 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 在 develop 上均不存在。该特性**未出货**，勿按已上线对待。
- **环境读数（决定 AC5 可否被满足）**：真实网络**具备** —— `.env.test`（mode 600）内有 `DASHSCOPE_API_KEY`，今日 09:28 仍产出过真实 trace；真实麦克风**不具备** —— 本机 `/dev/snd` 只有 seq/timer，无任何 pcm 采集设备（人工走查所用的麦克风本在客户端一侧）。
- **性质与处置**：AC5 是人工门，executor 不得代写。不解 AC5 就重新派发只会再 park（driver 对该情形走 ac-not-checked-shortcircuit → count-and-retry，已两轮），属死循环。故**保持 needs-human，本轮不重新派发**，以免白烧 worker 会话。
- **待人工裁定（两条都属人工执行或改判据，执行者不自行处置）**：(a) 具备真实麦克风的人在真实网络下走查一次，把读数写进 AC5 并勾选，本任务即可 fan-in（分支已就绪）；(b) 按 GOAL-031 目标第 1 条「真实音频（不是确定性替身）」的措辞、或同族 gap-voice-realtime-live-session-wiring 的 AC6 先例（其真实半区 AC 是在真实栈上机械关掉的）重定 AC5 的形态。