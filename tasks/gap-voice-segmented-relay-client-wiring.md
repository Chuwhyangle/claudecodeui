---
id: gap-voice-segmented-relay-client-wiring
title: P1c 浏览器接线：把 voiceLiveSegmenter 接进 Live Voice 采集链，发送
  segment_start/audio(seq)/segment_end，处理 segment_ack，静音不上行
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-segmented-relay-segmenter-relay-profile
  - gap-voice-segmented-relay-protocol-server-commit
goal_ac: AC-319
---
## Proposal

<!-- dedup-ref --> 去重检查（2026-10-10）：浏览器侧采集与 WS 客户端 `useVoiceRealtimeSession.ts` 已存在；本条只把 P1a 的纯函数分段器接进去并按 P1b 的帧协议发送，不重做采集。另一常驻会话正在做 Composer 双入口 UI 改造，其任务只存在于它自己的 worktree，主任务库里没有对应 id，所以这里无法用 `depends_on` 引用它；协调办法：本任务只改 `src/modules/chat/voice-realtime/` 下的文件，不碰 Composer 组件；合入前须先看双入口分支是否已进 develop，若已进则 rebase 后再跑。

来源：SPEC「C1 浏览器分段」「客户端接线」。

### 方案

1. 在 `useVoiceRealtimeSession.ts` 的音频采集回调里，用 `voiceLiveSegmenter`（relay 档：mergeGap 1.5 s、commitGap 2.0 s、maxSegment 20 s、minSegment 250 ms、preRoll 300 ms）判段；仅在段内（含 preRoll）发送 `audio{seq}`，段外静音帧不上行。
2. 段边界发 `segment_start` / `segment_end`；收到 `segment_ack` 更新本地段状态（用于调试面板与日志）。
3. 服务端不支持段协议（旧版本）时的回退：握手里带 `protocol: 'segmented-v1'`，服务端回 `ready` 时不带该能力则退回连续发送，行为与改动前一致。
4. 日志：`voiceLog` 每段一行，含 seq、时长、原因、上行帧数；Mute/End 时按 P1b 约定冲刷未结束的段。
5. 不改字幕/投递/徽标逻辑。

## AC

- [ ] `npx vitest run src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.segmented.test.tsx` 退出码 0
- [ ] 200 秒含 4 句话的合成输入下，上行 `audio` 帧总时长 ≤ 25 秒，且每段前后恰有一对 `segment_start`/`segment_end`
- [ ] 握手能力协商：服务端未声明段协议时，上行帧与改动前逐帧一致（既有 `useVoiceRealtimeSession` 相关测试不改动仍通过）
- [ ] Mute 与 End 在段中发生时，发出 `segment_end{reason:'flush'}` 后再关闭
- [ ] 取假形态必须变红：去掉静音门（静音也上行）→ 上行时长用例红；去掉 flush → Mute 用例红
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：浏览器里（Playwright，真实页面，真实服务进程，上游用假 DashScope）打开 Live Voice，喂入 4 句话的 WAV，服务端诊断日志显示 `audioSecondsUpstream` ≤ 原片长的 25%，4 条 `session_send` 全部送达绑定的会话；截图存到 `artifacts/` 并在任务记录里引用。不得调用真实上游。

## Touches

- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/voiceRealtimeProtocol.ts
- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.segmented.test.tsx (new)
- tasks/gap-voice-segmented-relay-client-wiring.md