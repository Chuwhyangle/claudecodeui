---
id: gap-live-voice-single-transcript-row
title: Live Voice 转写行原地定型（AC-326）：一次语音只对应一行用户消息，原声片段在同一行内累积、交付就地定型为真实消息，空转写不产生行
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-326
---
## Proposal

现状（2026-10-11 复核，`server.log` 连接 `d88c6722`）：说话时上游 server_vad 每切一句就发一条 `transcription.completed`，代理转成 `to-browser caption`；`src/modules/chat/ChatInterface.tsx:418-440` 把每条 caption 各自变成一个 `voice-caption-<itemId>` 的 user ChatMessage，于是 3 句 = 3 行（实测 `14:40:17.416` / `14:40:18.092` / `14:40:19.832`）。说停后中继模型把整段合并成一句、顺手纠正识别错字（`Live Boys`→`Live Voice`，`Order.` 被丢掉），只调一次 `session_send`；`sent` 帧到达时 `placeCaptions.ts:52-76` 把这 3 行一次删掉。用户读到的是「我的话出现 3 次、被改写过、然后被删掉」。

做法（人 yale 2026-10-11 裁定的方案 A）：

1. `src/modules/chat/voice-realtime/placeCaptions.ts` 新增一个纯函数（分组 + 拼接）：把「尚未被任何 delivery 认领的 final captions」折成**一行**文本。拼接规则与服务端 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:702-712` 的 `joinParts` 同规——CJK 之间不加空格、其余之间加一个空格；行的时间戳取组内第一条 caption 的 `at`（那是用户开口的时刻）。
2. `ChatInterface.tsx:418-440` 改为渲染这一行，而不是 `captions.map(...)` 逐条成行。认领机制不变（仍走 `markDeliveredVoiceMessages` / `dropCaptionsDeliveredAsMessages`），所以交付时是 **1↔1 的就地定型**而不是 N→1 的删除。
3. `useVoiceRealtimeSession.ts`：空/纯空白 caption 不进 `captions` —— 在源头就不产生行，比在渲染层过滤更彻底（日志里 `caption ""` 出现 3 次，如 `14:42:57.666`）。
4. `src/modules/chat/voice-realtime/index.ts` 导出新函数（跨模块测试须走 barrel）。
5. **判据文件是本任务新建的**：`src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts`。这不是可选的——AC-326 的 criterion 点名它，且**必须是它自己那条 `npm run test:client` 的唯一过滤器**。实测（2026-10-11）：只用既有测试文件（`placeCaptions.test.ts` + `useVoiceRealtimeSession.test.tsx`，39 个既有用例）的判据在工作尚未开始时就是绿的，goal-driver 据此把 AC-326 与 AC-327 双双机械翻成 `achieved`（commit `7e936c03`）；而 `vitest run <不存在的文件> <存在的文件>` 也 **exit 0**——多过滤器只要有一个命中就不报错。所以纯函数断言必须写在**新文件**里，且新文件在那条命令里不能与既有文件并列。把断言写进 `placeCaptions.test.ts` 会让判据重新变成空过。
6. `e2e/voice-realtime-upload-fixture.spec.ts` 新增用例：假上游连发三条 final 转写事件 + 一次 `session_send`，按 AC-326 的读数逐条断言；再加一条空转写用例。若整文件实测超过 `SINGLE_SPEC_CEILING_MS`（55s），在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 里为本文件声明实测值——该表就是为「一个文件的运行时长是文件自己的属性」这种情况存在的，注释里写明测量日期与余量。

<!-- dedup-ref --> 与 `gap-live-voice-delivery-state-visible`（AC-327）的关系：两者 Touches 有重叠（`useVoiceRealtimeSession.ts` / `ChatInterface.tsx` / 该 e2e spec），但各自绑定一个 `goal_ac`，且 AC-327 的浏览器读数在结构上需要本条的单行先存在，故保持为两个任务、由 `depends_on` 让调度器串行；合并会让一个任务挂两个 AC。

## AC

- [ ] `npm run test:client -- src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts` 退出 0（该文件由本任务新建，且是这条命令的**唯一**过滤器；它与既有文件并列时 vitest 会因另一个过滤器命中而 exit 0，判据即空过）
- [ ] `npm run test:client -- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` 退出 0
- [ ] 纯函数判据（写在 `voiceSingleTranscriptRow.test.ts`，经 barrel 导入）：新分组函数对三段 CJK final captions 返回**一段**文本且段间不加空格；对「英文段 + 英文段」段间加一个空格；对空与纯空白 caption 不产生行
- [ ] e2e 交付前：三次 final 转写到达后，`.chat-messages-pane` 里 `[data-message-style="user"]` **恰好 1 行**，且其文本同时包含三段
- [ ] e2e 交付后：仍是 1 行，文本为交付文本、带 `data-testid="voice-transcript-badge"`，三段原声各自作为 user 行的计数均为 0
- [ ] e2e 全程：从第一条 caption 到交付完成后连续轮询，user 行计数**从不超过 1**
- [ ] e2e 空转写：假上游各发一条 `transcript: ""` 与纯空白 caption，user 行计数不增加
- [ ] 取假形态现场红再还原：把渲染改回「一条 caption 一行」⇒ 第四条与第六条红；不跳过空 caption ⇒ 第三条与第七条红
- [ ] 既有判据不变红：`e2e/voice-realtime-upload-fixture.spec.ts` 三条既有用例仍绿，特别是「words heard and relayed verbatim appear once」与 AC-317 的「交付后原声文本作为 user 行计数为 0」
- [ ] `npm run typecheck` 退出 0

## DoD

真实浏览器 + 假上游实测（`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts`）并在本任务 Evidence 记录读数：三次转写 + 一次交付的全过程中 user 行计数从不超过 1，屏幕上读到的是「一行原地定型」而不是「三行塌缩成一行」；全过程截图或 trace 落在 `artifacts/live-voice/` 下并已查看。AC-326 的 criterion 在合入 develop 后 exit 0（fan-in 后 `quay goal gate AC-326` 退出 0）——注意它点名 `voiceSingleTranscriptRow.test.ts` 且要求它独占一条命令，该文件未落地时这条判据必红。不是「测试存在」——是这个手势真的被跑过并留下读数。

## Touches

- src/modules/chat/ChatInterface.tsx
- src/modules/chat/voice-realtime/placeCaptions.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/index.ts
- src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts
- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx
- e2e/voice-realtime-upload-fixture.spec.ts
- playwright.config.ts
- tasks/gap-live-voice-single-transcript-row.md（self）
