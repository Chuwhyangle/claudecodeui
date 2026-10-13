---
id: gap-voice-e2e-spec-read-resolved-mode-not-env
title: e2e 语音 spec 判据改读「解析后的默认模式」而不是 env 原文（默认翻 continuous 后该 spec 恒红）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-land-default-flip-and-attribution-watermark
---
## Proposal

`e2e/voice-realtime-live-session-send.spec.ts:113` 的判据是：

```ts
function segmentedRelayExpected(): boolean {
  return (process.env.VOICE_REALTIME_MODE ?? '').trim() !== 'continuous';
}
```

即「**未设 env ⇒ 期望 segmented**」。2026-10-13 把**服务端默认**翻成 `continuous` 之后，未设 env 时这个表达式仍返回 `true`，而服务端实际走 continuous，于是该 spec 在 `:649` 的 `commitCount() >= 1` 恒红（主检出红、worktree 同命令绿）。

判据必须读**模式解析的结果**，而不是环境变量原文——否则它断言的是"env 说了什么"，而不是"这次运行实际走了哪条路"，而这恰恰是这条 spec 自己要证明的东西（注释写明 "a real reading of the run's own configuration"）。

## Plan

1. 把判据改为「只有显式 `segmented` 才算分段」，与 `resolveVoiceRealtimeMode` 的默认一致。
2. 检查同文件其它以 env 推断模式的地方，一并纠正。
3. 在**未设** `VOICE_REALTIME_MODE` 的配置下跑该 spec，确认绿。

## AC

- [ ] AC1 `grep -n "VOICE_REALTIME_MODE" e2e/voice-realtime-live-session-send.spec.ts` 的判据表达式为「仅显式 `segmented` 视为分段」，与 `server/modules/voice-realtime/voice-realtime-mode.ts` 的默认一致。
- [ ] AC2 在未设 `VOICE_REALTIME_MODE` 的配置下 `npx playwright test e2e/voice-realtime-live-session-send.spec.ts` 退出 0（取假形态：把表达式改回 `!== 'continuous'` ⇒ 红）。

## DoD

该 spec 在主检出、按未设 `VOICE_REALTIME_MODE` 的默认配置运行时为绿；且它的判据读的是"模式被解析成什么"，而不是"环境变量被写成了什么"，因此无论默认值以后如何再翻，它都跟着真实行为走。

## Touches

- e2e/voice-realtime-live-session-send.spec.ts
- tasks/gap-voice-e2e-spec-read-resolved-mode-not-env.md

## Notes

本任务是 gap-live-voice-land-default-flip-and-attribution-watermark 的直接后果：那条之前，该 spec 在主检出并不红。