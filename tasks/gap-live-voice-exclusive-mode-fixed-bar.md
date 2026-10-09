---
id: gap-live-voice-exclusive-mode-fixed-bar
title: Live Voice 互斥模式 + 固定紧凑底部栏 + 持续采集（AC-316）
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-316
---
## Proposal

去重检查（2026-10-09 立案时）：grep `tasks/*.md goals/*.md` 未命中任何声称做"Live Voice 互斥模式/固定底部栏/持续采集"的任务；`gap-ac315-upload-criterion-second-upload-flake`、`gap-ac120-upload-input-locator-ambiguous`、`gap-ac315-voice-upload-orphaned-never-merged` 均是本轮改造的前置修复，已合并进 develop，不重复。

本任务是 GOAL-033 的第一增量，实现范围见 AC-316 自身判据的 expect 段。实现要点：

1. **`ChatInterface.tsx`**：新增 `composerMode: 'text' | 'voice'` state（默认 `'text'`），互斥渲染 `ChatComposer` / `VoiceRealtimeBar`，新增模式切换入口。
2. **`useVoiceRealtimeSession.ts`**：精简 phase 为 `idle | connecting | listening | muted | failed`；去掉 `understanding/sending/sent/approve/decline`；新增 `muted` 状态与 `mute()`/`unmute()`（纯前端：暂停发送帧，不关闭 socket）；进入 voice 模式自动触发麦克风采集，带测试专用跳过标志（同构于既有 `__voiceFake` 模式）。
3. **`VoiceRealtimeControl.tsx` → `VoiceRealtimeBar.tsx`**：固定单行紧凑栏（麦克风/静音状态指示 + Mute + End），不显示 Start/Upload 按钮、不显示草稿卡片；隐藏的文件 input 保留（`data-testid="voice-realtime-upload-input"`，无可见触发按钮）；样式全部复用现有 Tailwind/主题 class（不新增颜色）。
4. **`voice-realtime-ws-proxy.service.ts`**：`sessionSend` 收到 function_call 后立即执行真实 `session_send`，不再等待浏览器 `decision` 帧；去掉 `intent`/`decision` 帧类型；保留单槽并发保护（现在保护的是"真实调用互斥"而不是"等待决定互斥"）。
5. **`voice-realtime-ws-proxy.protocol-simulation.test.ts`**：按新协议改写 5 个场景（chunk 时序、Mute 等价的"打断"、断线清理、并发竞态、回填）。
6. **`e2e/voice-realtime-live-session-send.spec.ts` / `e2e/voice-realtime-upload-fixture.spec.ts`**：按新 UI 重写，覆盖 PC+375px、互斥断言、固定栏高度断言、旧 testid 消失断言、Mute 连接不中断断言。

## 边界/不做

- 不做 AC-317（实时 ASR caption 展示）——该事件映射与 transcript 渲染是独立复杂度，另案。
- 不改 `session_send` 的会话绑定白名单/参数校验（AC-310 既有保证原样保留）。
- 不改真实 DashScope transport 的连接/重连逻辑（AC-311 既有保证原样保留，只改"谁触发 session_send"这一层）。
- 不碰 `gap-voice-realtime-microphone-human-smoke-test`。

## AC

(与 AC-316 本体判据逐字一致，见 goals/AC-316-*.md；此处不重复整段 expect，完成时据实勾选并引用具体命令输出。)

- [x] AC1 互斥渲染：composer 与 voice bar 不同时可见，PC+移动均验证。（两个 e2e 的每个 leg 进入 voice 后断言 `[data-slot="prompt-input-textarea"]` hidden；假形态 (a) 现场复现为红）
- [x] AC2 固定栏高度：各阶段 boundingBox height 容差内一致。（live-session PC 断言 listening 与 muted 两态 |Δh| ≤ 4px）
- [x] AC3 持续采集：Mute 不断连接、不发帧；Unmute 恢复发帧、不新开连接；End 才真正关闭。（PC：Mute 后 `audioFrameCount` 不变、`connectionCount` 不变，Unmute 后帧数增长、连接数仍不变；End 后 bar unmount 且 composer 回归）
- [x] AC4 执行期间采集不中断。（PC：`callCount() ≥ 1` 的执行窗口内 Mute→Unmute 仍可操作，`connectionCount` 不变）
- [x] AC5 无草稿确认直接送达，transcript 回显不变（复用既有 mcp 来源渲染）。（两个 e2e 断言 `paneText` 含 PROPOSED_TEXT，无 intent/send UI；reload 后仍在）
- [x] AC6 旧 testid（start/可见 upload/intent/send/cancel）不存在；隐藏 upload input 仍可注入。（两 spec 逐一断言 7 个旧 testid count 0；`voice-realtime-upload-input` count 1 且 sr-only 尺寸 ≤2px）
- [x] AC7 回归：AC-120（`e2e/voice-trim.spec.ts -g "AC-120"`）、协议模拟 5 场景、typecheck、lint 均 exit 0。

## Evidence

判据命令链（本 worktree，AC-316 本体判据的三段），全部 exit 0：

```
npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts  ->  4 passed (19.2s)；复跑 4 passed (26.5s)、4 passed (20.5s)
npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts  ->  tests 5 / pass 5 / fail 0
npx playwright test e2e/voice-trim.spec.ts -g "AC-120"  ->  1 passed (13.6s)
```

AC7 其余项：`tsc --noEmit -p tsconfig.json`、`-p server/tsconfig.json`、`-p scripts/tsconfig.json` 均 exit 0；`oxlint src/ server/ scripts/ shared/` exit 0（仅既有 warning）；`vitest run src/modules/chat/tests/` 92 files / 637 tests 全绿。

DoD 三条假形态（现场复现为红，随后还原为绿）：

- (a) 互斥渲染还原：ChatInterface 让 bar 与 composer 同框渲染 → live-session PC 红（`expect(composer).toBeHidden()`，enterLiveVoice）。
- (b) Mute 实现还原（Mute 关闭连接而非停发帧）→ live-session PC 红（`waitForPhase('muted')` 实际得 `idle`，25000ms 超时）。
- (c) 去掉单槽并发保护 → 协议模拟红（`concurrent response race` 失败，`base.calls.length` 变 2；其余 4 例仍绿）。

## DoD

三条判据命令链式 exit 0；取假形态（互斥渲染还原、Mute 实现还原、并发保护去掉）现场复现为红后再还原为绿，留输出。

## Touches

- src/modules/chat/ChatInterface.tsx
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/VoiceRealtimeControl.tsx（重命名/重构为 VoiceRealtimeBar.tsx）
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx (new)
- src/modules/chat/voice-realtime/index.ts
- src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx
- src/modules/chat/tests/forkFromAssistantReply.test.tsx
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
- e2e/voice-realtime-live-session-send.spec.ts
- e2e/voice-realtime-upload-fixture.spec.ts
- tasks/gap-live-voice-exclusive-mode-fixed-bar.md（self）
