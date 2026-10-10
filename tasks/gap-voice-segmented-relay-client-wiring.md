---
id: gap-voice-segmented-relay-client-wiring
title: P1c 浏览器接线：把 voiceLiveSegmenter 接进 Live Voice 采集链，发送
  segment_start/audio(seq)/segment_end，处理 segment_ack，静音不上行
status: ready
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

- [x] `npx vitest run src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.segmented.test.tsx` 退出码 0
- [x] 200 秒含 4 句话的合成输入下，上行 `audio` 帧总时长 ≤ 25 秒，且每段前后恰有一对 `segment_start`/`segment_end`
- [x] 握手能力协商：服务端未声明段协议时，上行帧与改动前逐帧一致（既有 `useVoiceRealtimeSession` 相关测试不改动仍通过）
- [x] Mute 与 End 在段中发生时，发出 `segment_end{reason:'flush'}` 后再关闭
- [x] 取假形态必须变红：去掉静音门（静音也上行）→ 上行时长用例红；去掉 flush → Mute 用例红
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：浏览器里（Playwright，真实页面，真实服务进程，上游用假 DashScope）打开 Live Voice，喂入 4 句话的 WAV，服务端诊断日志显示 `audioSecondsUpstream` ≤ 原片长的 25%，4 条 `session_send` 全部送达绑定的会话；截图存到 `artifacts/` 并在任务记录里引用。不得调用真实上游。

## Notes

实现与验证记录（2026-10-10，`task/gap-voice-segmented-relay-client-wiring`）。

- **能力协商落在客户端，且对现有服务端无害。** `voiceRealtimeProtocol.ts` 的 `segmentedRelayOffer()` 在 `socket.onopen` 发出一帧 `hello{protocol:'segmented-v1'}`；只有服务端回带同一 token 的 `ready` 或 `state` 帧才切到分段上行，否则逐帧维持改动前的连续帧。已核对 P1b：`readVoiceRealtimeInboundFrame` 对未知帧型返回 `null`、调用方 `if (!frame) return;` 忽略，因此这一帧不会被现有服务端当成错误。
- **AC4 的线上 token 是 `reason:'end'`，不是字面 `'flush'`。** P1b 的 `segment_end` 只接受 `gap|max|end`（`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:388`，其它 token 从帧里丢掉、服务端日志回落成 `gap`），Proposal §4 又明确「按 P1b 的约定冲刷」；段的提交只取决于 `seq` 是否是已 `segment_start` 过的整数，与 reason 无关，所以发 `'end'` 既守住协议一致、又让服务端日志如实记下原因。AC4 的承重命题——段中 Mute/End 先送出该段的 `segment_start`/`audio`/`segment_end`、且 `segment_end` 在 `close` 之前——由 `tests/useVoiceRealtimeSession.segmented.test.tsx` 的两条用例直接钉住。
- **DoD 的浏览器实测本任务产不出。** 真实服务端此刻不声明段协议（把它设为默认并补上声明是 P4 `gap-voice-segmented-relay-rollout-and-reconcile` 的事），真实页面因此必然走连续回退，`audioSecondsUpstream ≤ 原片长 25%` 在浏览器里无从复现；本任务声明的 Touches 也不含 `server/`。分段上行路径改由新测试里「会声明的假服务端」覆盖：200 秒输入上行 13.2 秒、恰 4 段、每段一对边界。
- **验证（合并 develop 后的树上）**：`npx vitest run src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.segmented.test.tsx` 退出码 0（10 例）；既有 `useVoiceRealtimeSession.test.tsx` 未改动、23 例仍绿；邻域 6 个文件 84 例全绿；`npm run typecheck`、`npm run lint` 退出码 0（lint 对本任务三个文件零告警）。两条取假都实测变红后回退：去掉静音门 → 上行时长用例读出 213.2 s > 25；去掉 flush → Mute 用例红。

## Touches

- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/voiceRealtimeProtocol.ts
- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.segmented.test.tsx (new)
- tasks/gap-voice-segmented-relay-client-wiring.md