---
id: AC-326
title: Live Voice 一次语音只对应一行用户消息：原声片段在同一行内累积，交付后就地定型为那一条真实消息，空转写不产生行
status: active
kind: criterion
goal: GOAL-038
criterion: npm run test:client --
  src/modules/chat/voice-realtime/tests/placeCaptions.test.ts
  src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx && npx
  playwright test e2e/voice-realtime-upload-fixture.spec.ts
expect: >-
  两条命令均 exit 0。


  一、屏幕上永远是「一次语音 = 一行」。e2e（假上游连发三条 final 转写事件 + 一次 `session_send`）读数：

  (a) 交付前，`[data-message-style="user"]` 在 `.chat-messages-pane` 中**恰好 1
  行**，其文本同时包含三段原声转写，且按到达顺序排列；

  (b) 交付后仍是 1 行，文本为交付文本、带 `data-testid="voice-transcript-badge"`，且三段原声转写各自作为
  user 行的计数均为 0；

  (c) 从第一条 caption 到交付完成后连续轮询，user 行计数**从不超过 1**——既不存在「碎片与真实消息同时在屏幕上」的窗口，也不存在
  3→1 的塌缩。


  二、空转写不产生行：假上游发一条 `transcript: ""`（以及一条纯空白）的 caption，user 行计数不增加。


  三、纯函数判据：`placeCaptions` 导出的分组/拼接函数对「一段尚未交付的 final captions」返回**一行**文本，CJK
  之间不加空格、非 CJK 之间加一个空格（与 `voice-realtime-ws-proxy.service.ts:702-712` 的
  `joinParts` 同规）；对空/纯空白 caption 不产生行。


  现状（2026-10-11 复核）：`src/modules/chat/ChatInterface.tsx:418-440` 把每条 caption
  各自变成一个 `voice-caption-<itemId>` 的 user ChatMessage，所以 N 条转写就是 N
  行——`server.log` 连接 `d88c6722` 的 14:40 那轮实测是 3 行（`14:40:17.416` /
  `14:40:18.092` / `14:40:19.832` 三条 `to-browser caption`）；交付时由
  `placeCaptions.ts:52-76` 把这 N 行一次删掉。故 (a)(c) 现在必红。


  取假形态：(a) 把渲染改回「一条 caption 一行」⇒ (a)(c) 红，恢复后绿；(b) 不跳过空 caption ⇒ 二红，恢复后绿。


  (d) 既有判据不得变红：`e2e/voice-realtime-upload-fixture.spec.ts` 的三条既有用例全部仍绿，特别是「words
  heard and relayed verbatim appear once」与 AC-317 的「交付后原声文本作为 user 行计数为
  0」两条断言；`npm run typecheck` exit 0。
origin: 2026-10-11 人 yale 裁定采纳方案 A + P4（见 GOAL-038 origin）。现状读数取自 `server.log`
  连接 d88c6722 的真实帧序与
  `src/modules/chat/ChatInterface.tsx:418-440`、`src/modules/chat/voice-realtime/placeCaptions.ts:52-76`
  的代码复核。
activatedAt: 2026-10-10T18:15:47.959Z
statusLog:
  - at: 2026-10-10T18:15:47.959Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-10T18:15:47.959Z
---
