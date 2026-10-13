---
id: gap-voice-unforwarded-utterance-visible-disposition
title: continuous 下「听了、未转发」必须有可见处置，不得静默吞掉 MODEL_TEXT_REPLY
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

服务端默认翻成 `continuous` 之后，「模型听到但选择不转发」成为常态路径。而 `voice-realtime-ws-proxy.service.ts` 的 `onError` 对 `MODEL_TEXT_REPLY` 做了这个分支：

```ts
if (error.code === 'MODEL_TEXT_REPLY' && !segmentedRelay) {
  seams.log?.(`to-browser heard-not-forwarded: …`);
  return;   // 不发给浏览器
}
```

依据是决策文档 §12.6 B-8（continuous 下"模型用文本回一句"＝"无需动作"这个处置，页面已通过 caption 体现）。

**后果**：失败**从可见变成不可见**。2026-10-13 早上 segmented 时，模型自答至少会以一个错误帧暴露出来；转 continuous 之后同样的失败在界面上完全无声——用户说的话既没进会话，也没有任何提示。实测当天就出现过两段这样被吞掉的话语。

决策文档 §12.5 已经预留了"听了、未转发"这个处置位；本任务把它落地成一个**显式且可见**的处置。

## Plan

1. 为中继补一个显式的"听了、未转发"处置（帧或状态），在 continuous 下也告知浏览器。
2. 该处置**不得**把会话判为失败（区别于真正的 error 帧）。
3. 文案进入全部 locale。
4. 夹具断言：continuous 下一次 `MODEL_TEXT_REPLY` 会产出一个可见处置。

## AC

- [ ] AC1 新夹具断言：continuous 下一次 `MODEL_TEXT_REPLY` 产出**可见**的"听了、未转发"处置；`npx tsx --tsconfig server/tsconfig.json --test <新夹具>` 退出 0。
- [ ] AC2 取假形态：把该处置去掉（回到静默 `return`）⇒ AC1 红。
- [ ] AC3 同一夹具断言该处置**不**使会话进入失败态。
- [ ] AC4 `npm run typecheck` 与 `npm run lint` 均退出 0。

## DoD

在 continuous 默认下，模型选择不转发的话语在界面上有明确、可见的处置，不再无声消失；且该处置不被误判为会话失败。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
- src/modules/i18n/locales/en/chat.json
- server/modules/voice-realtime/tests/voice-realtime-unforwarded-disposition.test.ts
- tasks/gap-voice-unforwarded-utterance-visible-disposition.md

## Notes

本条的成立条件是 continuous 已是服务端默认；在那条落地之前，这段静默路径并不是常态（功能上仍可达，但罕见）。