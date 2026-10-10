---
id: gap-live-voice-composer-embedded-dual-entry
title: Live Voice 入口迁入 Composer 左下角（与 Voice Input 并列）+ 容器内紧凑栏（波形/时长/字幕/模型/Mute/End）
status: todo
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-316
---
## Proposal

去重检查（2026-10-10）：grep `tasks/*.md goals/*.md` 对 `live-voice-button`/`voice-input-button` 无命中；`gap-live-voice-exclusive-mode-fixed-bar`（AC-316，done）已交付互斥渲染/固定栏/持续采集/Mute/End，`gap-live-voice-realtime-asr-caption-transcript`（AC-317）已交付字幕进 transcript，均不重做。本任务只改 UI 形态，不依赖未实施的 VAD/分段中继 SPEC。

现状差距（已核对代码）：
1. Live Voice 入口仍是 Composer 上方外置文字按钮 `live-voice-enter`（`ChatInterface.tsx` 约 876-890），应迁入 `ChatComposer` 左下组，位于 VoiceInputButton 右侧，声波图标，testid `live-voice-button`；VoiceInputButton 加 testid `voice-input-button`。
2. `VoiceRealtimeBar` 是 `border-t` 平铺行，不在 Composer 圆角容器内，且无波形/时长/即时字幕/模型，Mute 与 End 同样式。
3. socket 关闭后 phase=idle 却显示 "Connecting voice…" 且采集已释放，成死态。

方案：ChatComposer 新增 `onLiveVoice` prop；栏内复用 composer 容器外观（同一 `data-chat-composer` 位置、同圆角边框 class）；栏 = [状态图标][波形(AnalyserNode 电平,ref+rAF)+mm:ss+当前 interim 字幕(取 voice.captions 末条,truncate)][模型菜单只读+说明][Mute/Unmute][End 用 destructive 样式]；固定高度；idle 与 connecting 文案拆开，failed/断线给 Retry。字幕仍仅显示，不经 session_send。

## 边界/不做

- 不改服务端协议、session_send 白名单、DashScope 重连。
- 不做 VAD/分段中继。
- 不改 Voice Input 的 ASR/草稿/发送逻辑。

## AC

- [x] AC1 默认 Composer（桌面与 375px）同时可见独立的 `voice-input-button` 与 `live-voice-button`，顺序 附件→麦克风→声波→更多；Composer 外不存在 Live Voice 按钮（`live-voice-enter` count 0）。
- [x] AC2 点 voice-input 不进入 Live Voice；点 live-voice 立即进入并自动采集，不出现 draft/Send/Cancel/Upload。
- [x] AC3 Live Voice 栏在原 Composer 容器内：文本框不可见、无第二个 Composer；含状态图标、波形、mm:ss 时长、即时字幕（空时 Listening…）、模型、Mute/Unmute、End。
- [x] AC4 listening/muted/执行中各态栏 boundingBox 位置与高度不变（容差 ≤2px），桌面与 375px；Mute 与 End 始终可见；字幕超长不撑高；最后一条 transcript 不被遮挡。
- [x] AC5 Mute 停发帧不断连、Unmute 恢复、End 清理并恢复完整默认 Composer；断线后不再显示"Connecting"死态，提供 Retry。
- [x] AC6 既有回归：AC-120 voice-trim、voice-realtime 两个 e2e、协议模拟、useVoiceRealtimeSession/chat vitest、typecheck、lint、build:client 均 exit 0。

## Evidence

- AC1/AC2/AC3/AC4(PC+375)：`npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts` → 7 passed。断言：`live-voice-enter` count 0；`voice-input-button` 与 `live-voice-button` 同行、mic 在前；进入后文本框 hidden；listening/muted/执行中栏 |Δh|≤2px、|Δtop|≤2px；375px 下 Mute/End 在视口内且 ≥36px。
- AC2 独立处理函数：`composerCompactTier.test.tsx` (l) 两例（点 Live Voice 不触发听写 toggle；点 mic 不进入 Live Voice；无 handler 不渲染按钮）。
- AC4 字幕不撑高：结构保证（栏 `h-16` 固定、字幕 `min-w-0 truncate`）；jsdom/e2e 未注入超长字幕，属结构论证而非实测。
- AC5：Mute/Unmute/End 既有 e2e 断言保留；断线标记 `disconnected`/`connectedAt`/`levelRef` 由 `useVoiceRealtimeSession.test.tsx`（23 passed）覆盖；Retry 按钮的浏览器点击未单独实测。
- AC6：`vitest run src/modules/chat/voice-realtime`（46 passed）+ chat 回归 7 文件 75 passed；`tsc --noEmit -p tsconfig.json` exit 0；`npm run build:client` 成功；`e2e/voice-trim.spec.ts -g AC-120` 1 passed；协议模拟 11/11 pass。
- 既有红（非本任务）：`mobile-workspace-composer-layout.spec.ts` 的 "single playback" 六格在 develop 同源码上同样红（75bd6a89 与本分支差异为空的 src 上复现）；其余格含 @320 idle（本任务曾使其红：七个控件在 <360px 溢出 14px，已用 `max-[359px]:[&_button]:w-7` 修复）全部绿。
- 截图：`artifacts/live-voice/composer-embedded/`（default-composer-1280/375、live-listening-1280/375、live-muted-1280/375、live-executing-1280）。

## DoD

真实浏览器桌面+375px 截图（默认/监听/静音/执行中）留存于 artifacts/live-voice/；AC1-AC6 现场运行输出；假形态（外置按钮还原、栏高随状态变化）现场红后还原为绿。

## Touches

- src/modules/chat/ChatInterface.tsx
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/composer/VoiceInputButton.tsx
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/audioSource.ts
- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx
- src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx
- src/modules/chat/tests/forkFromAssistantReply.test.tsx
- e2e/voice-realtime-live-session-send.spec.ts
- e2e/voice-realtime-upload-fixture.spec.ts
- src/modules/chat/tests/composerCompactTier.test.tsx
- tasks/gap-live-voice-composer-embedded-dual-entry.md (self)
