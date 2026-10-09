---
id: gap-voice-realtime-browser-e2e-current-session
title: 浏览器语音→可见可纠正意图→真实 session_send→执行结果回显，PC+移动基本体验（AC-312）
status: done
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

<!-- dedup-ref --> 立案时 `grep -rli "voice-realtime.*e2e\|browser-e2e-current-session" tasks/*.md goals/*.md` 零命中。本任务是 GOAL-031 的收口任务：`depends_on` 前两个任务——没有真实执行体（`gap-voice-realtime-live-session-wiring`）就没有真的能调用的 `session_send`；没有连接韧性（`gap-voice-realtime-connection-resilience`），一条真实打开的语音连接随时可能被并发竞态打断。

### 背景

本任务把前两个任务的后端能力接上浏览器前端，交付 GOAL-031 目标链路里用户能直接感知的那一半：按下麦克风（或上传音频文件，见下方 2026-10-09 补充）、看到理解中的状态、看到待发送的意图文字、能在发送前编辑、确认后真的看到 Claude Code 执行的结果出现在对话里。

### 方案

1. 新前端模块（`src/modules/chat/voice-realtime/`）：麦克风采集复用既有 `AudioWorklet`/`voiceFrameProcessor`；新增一个服务端 WS 代理路由，浏览器→代理→真实 DashScope transport（凭据只在服务端，浏览器不直连，沿用现有语音功能的既有约束）。
2. UI：听/理解中状态指示；最终意图文字展示，**可编辑**（这就是低摩擦的纠正机制，不需要额外确认框）；一个明确的发送动作触发 `session_send`。
3. 执行结果：**不新建反馈 UI**，复用现有聊天转录——语音发起的轮次本来就会以 `ChatRunSource==='mcp'` 的普通轮次出现在转录里。
4. PC 与一个移动视口（375px）各跑一次基本流程。

### 边界（不做）

不做跨会话/跨项目选址（`boundSessionId` 就是当前打开的会话）；不新建确认弹窗或 consent 流程；不做语音输出。

### 实现纪要（落地时补记）

- 代理路由的真实文件名是 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`；`/voice-realtime` 的 upgrade 分支挂在既有的 `createWebSocketServer` 上，与 `/ws`、`/shell`、`/plugin-ws` 同一条鉴权通道（`?token=` 里的 JWT）。
- 假上游只说这一版 bridge 真正消费的一种帧：`response.function_call_arguments.done`。
- 服务端的 transport 在没有凭据时**拒绝**拨号（`MISSING_API_KEY`，这是刻意的护栏）；判据用 transport 既有的 `socketFactory` 缝补，生产路径护栏原样保留。

### 2026-10-09 补充与重定（人 yale 裁定，GOAL-031/AC-312 范围变更）

人 yale 补充明确需求并对本任务原 AC5 的形态做出裁定：

1. **Web 前端同时提供麦克风与音频文件上传**，复用同一条 `useVoiceRealtimeSession` 管线——新增 `src/modules/chat/voice-realtime/audioSource.ts`（`VoiceRealtimeAudioSource` 接口，`microphoneAudioSource()`/`fileAudioSource()`），`connect`/`beginCapture` 对两条源不分叉；`VoiceRealtimeControl.tsx` 新增上传按钮。这一步落地于 `gap-voice-realtime-upload-audio-and-protocol-simulation` / AC-315，经 `gap-ac315-voice-upload-orphaned-never-merged` 真正合并进 develop（merge commit `94547fab`）。
2. **固定语料文件 + Playwright 自动端到端验收**（无物理麦克风）：新增 `e2e/voice-realtime-upload-fixture.spec.ts`，覆盖 PC+375px 移动、可编辑意图、`session_send`、转录回显，全程不调用 `getUserMedia`。
3. **协议/接口层模拟交互测试**：新增 `server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`，offline 驱动 `/voice-realtime` 代理本身，覆盖 chunk 时序、打断、断线清理、并发 response 竞态、工具调用回填五个场景；过程中真的在代理里发现并修复一个死锁（并发 `session_send` 静默覆盖单槛位 `pending`）。
4. **原 AC5（真实麦克风+真实网络人工走查）从本判据拆出**，独立立案为 `gap-voice-realtime-microphone-human-smoke-test`（`needs-human`，明确不阻塞本任务也不阻塞任何其它判据），可在任意时间由具备真实硬件的人完成。本任务不再因为这一条人工走查而停在 `needs-human`。

本任务的判据（AC-312）据此重定为三层自动化方案，见 `goals/AC-312-*.md` 最新 `criterion`/`expect`。

## AC

- [x] AC1 离线闭环可跑（麦克风路径 + 上传路径）：`npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts` 链式跑在 develop 树上实测 `4 passed`（PC+375px 各两条 leg）。
- [x] AC2 可编辑意图：两条路径的 UI 展示的待发送文字都可以被用户编辑，编辑后发送的是编辑后的内容（不是原始理解结果）。
- [x] AC3 执行结果可见：两条路径确认发送后，对应的 `mcp` 来源轮次都出现在聊天转录里（复用既有渲染，不新建组件）。
- [x] AC4 移动视口基本可用：两条路径各自的 375px leg 都断言核心控件可见可操作（boundingBox 落在 0..376 内且宽高 > 0）。
- [x] AC5（重定，见上方「2026-10-09 补充与重定」第 4 点）：真实麦克风人工走查已拆出为独立非阻塞任务 `gap-voice-realtime-microphone-human-smoke-test`，不再是本任务 `done` 的前提。本任务改用协议层模拟测试覆盖打断/重连/并发/回填：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` 在 develop 树上实测 `tests 5 / pass 5 / fail 0`，且并发竞态场景的取假形态现场复现过（删保护→红→恢复→绿）。
- [x] AC6 静态门：`npm run typecheck`（client+server+scripts 三个 tsconfig）与 `npm run lint` 均退出 0，无新增 voice-realtime 相关 warning。

## DoD

真实落地判据：用户按下麦克风说一句话，或上传一个固定语料文件，都能看到可编辑的理解结果，确认后真的在转录里看到 Claude Code 的回应——这条链路在 develop 树上机械可证（AC1-4），协议层的打断/并发/回填也有独立可证伪的自动化证据（AC5 重定后的新形态）。真实网络+真实麦克风的人工走查已拆出为独立非阻塞任务，不计入本任务的完工门槛。

**真实落地台账**：实现分支 `task/gap-voice-realtime-browser-e2e-current-session`（已 fast-forward 到含 AC-315 改动的 `ef449097`）已通过 `task/gap-voice-realtime-upload-and-protocol-simulation` 以 merge commit `94547fab` 合并进 `develop`；`quay goal gate AC-312` 在该 develop 树上真实复判 `verdict: pass`；goal-driver 已把 AC-312 自动迁至 `achieved`（`statusLog` 可查）。

## Touches

- src/modules/chat/voice-realtime/ (new)
- src/modules/chat/voice-realtime/audioSource.ts (new, 2026-10-09 补充)
- src/modules/chat/ChatInterface.tsx (挂载语音控件)
- src/shared/api.ts (voice-realtime socket URL)
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts (new)
- server/modules/voice-realtime/index.ts (barrel 导出新服务)
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts (new, 2026-10-09 补充)
- server/modules/websocket/services/websocket-server.service.ts (加 /voice-realtime upgrade 分支)
- server/index.ts (组合根接线 transport/executor)
- vite.config.js (dev 代理 /voice-realtime)
- playwright.config.ts (判据选择、假上游端口与 VOICE_REALTIME_ENDPOINT；2026-10-09 补充 upload-fixture spec 的选择项)
- e2e/voice-realtime-live-session-send.spec.ts (new)
- e2e/voice-realtime-upload-fixture.spec.ts (new, 2026-10-09 补充)
- tasks/gap-voice-realtime-browser-e2e-current-session.md (self)

## Notes

**历史记录（保留，供审计）**：本任务曾在 2026-10-09 早些时候 park 为 `needs-human`，理由是原 AC5（真实麦克风+真实网络人工走查）结构性只能人工验收，执行者不得代勾。该 park 判断本身没有错——AC5 确实无法由执行者在无物理麦克风的环境里满足。2026-10-09 稍后，人 yale 按本任务自己记录的待裁定选项 (b) 做出裁定：把这一条人工走查从本判据拆出，本判据改用三层自动化方案（麦克风+上传同管线、固定文件 e2e、协议模拟）结算，本任务据此改判 `done`。

**与 AC-315 的关系**：AC-315 是并列的独立判据（文件上传+协议模拟，详见其自己的记录），不是本任务的子集；两者共享同一条实现分支（代码上互相依赖，判据上互相独立），都已真实合并进 develop 并各自在 develop 树上被 goal-driver 判定 `achieved`。

**与新拆出任务的关系**：`gap-voice-realtime-microphone-human-smoke-test` 是本任务原 AC5 的后续承接，`needs-human`，明确不阻塞本任务、不阻塞 AC-315、不阻塞 GOAL-031 的其它退出条件。完成时间不设限。