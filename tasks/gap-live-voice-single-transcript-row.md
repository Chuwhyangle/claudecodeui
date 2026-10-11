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

- [x] `npm run test:client -- src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts` 退出 0（该文件由本任务新建，且是这条命令的**唯一**过滤器；它与既有文件并列时 vitest 会因另一个过滤器命中而 exit 0，判据即空过）
- [x] `npm run test:client -- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` 退出 0
- [x] 纯函数判据（写在 `voiceSingleTranscriptRow.test.ts`，经 barrel 导入）：新分组函数对三段 CJK final captions 返回**一段**文本且段间不加空格；对「英文段 + 英文段」段间加一个空格；对空与纯空白 caption 不产生行
- [x] e2e 交付前：三次 final 转写到达后，`.chat-messages-pane` 里 `[data-message-style="user"]` **恰好 1 行**，且其文本同时包含三段
- [x] e2e 交付后：仍是 1 行，文本为交付文本、带 `data-testid="voice-transcript-badge"`，三段原声各自作为 user 行的计数均为 0
- [x] e2e 全程：从第一条 caption 到交付完成后连续轮询，user 行计数**从不超过 1**
- [x] e2e 空转写：假上游各发一条 `transcript: ""` 与纯空白 caption，user 行计数不增加
- [x] 取假形态现场红再还原：把渲染改回「一条 caption 一行」⇒ 第四条与第六条红；不跳过空 caption ⇒ 第三条与第七条红
- [x] 既有判据不变红：`e2e/voice-realtime-upload-fixture.spec.ts` 三条既有用例仍绿，特别是「words heard and relayed verbatim appear once」与 AC-317 的「交付后原声文本作为 user 行计数为 0」
- [x] `npm run typecheck` 退出 0

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

## 验证记录（2026-10-11，worktree `gap-live-voice-single-transcript-row`，已 `git merge develop`＝Already up to date）

AC-326 的 criterion 三条命令逐条实跑，合并后的树上 exit 0：

- `npm run test:client -- src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts` → exit 0，`Test Files 1 passed (1) / Tests 8 passed (8)`（该文件由本任务新建，且是这条命令的唯一过滤器）
- `npm run test:client -- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` → exit 0，`Test Files 1 passed (1) / Tests 25 passed (25)`（新增 2 例：空转写不进 `captions`；关闭句中 utterance 的空帧保留其文字并标 final）
- `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` → exit 0，`4 passed (32.6s)`；整文件 32.6s **低于** `SINGLE_SPEC_CEILING_MS = 55_000`，故 `playwright.config.ts` 的 `SPEC_BUDGET_MS` **未改动**（Touches 里声明该文件是「若超限才改」的条件项）
- `npm run typecheck` → exit 0；`npm run lint:client` → exit 0（仅既有 warning）

e2e 真实浏览器读数（AC-326 用例，1280×800，串行复用同一会话；假上游连发三条 final 转写 `item_fake_<call>_0/1/2` 后延迟 2000ms 再 `session_send`）：

- 计数台账（60ms 一次、从注入前到交付后稳定 500ms）：`counts=[0,1,1,...,1]`，`Math.max = 1`——(a) 交付前恰好 1 行 `[data-message-style="user"]`，文本同时含 `alfa bravo charlie` / `delta echo foxtrot` / `golf hotel india` 且按到达顺序；(c) 全程从不超过 1，无「碎片与真实消息同屏」窗口、无 3→1 塌缩
- 交付后仍 1 行，文本 `send the summary of the release notes to the team channel`，`data-testid="voice-transcript-badge"` 可见且 `title` 含三段原声；三段各自作为 user 行的计数均为 0（AC-317 断言保持绿）
- 空转写臂：另开一条连接，假上游发 `transcript: ""` 与纯空白两条 caption 且不 `session_send`；注入后 user 行计数与注入前相等（5 → 5）
- 截图（`QUAY_LIVE_VOICE_SHOT_DIR=artifacts/live-voice/ac326-single-row`，已逐张查看）：`ac326-one-row-while-spoken-1280.png`（一行含三段、bar 仍 `Listening…`）、`ac326-same-row-after-delivery-1280.png`（同一行原地变为交付文本 + 「From voice transcript」徽章）、`ac326-wordless-made-no-row-1280.png`（无新行）

取假形态现场（改→跑→还原，还原后三条命令重新全绿）：

- (a) 把渲染改回「一条 caption 一行」（`ChatInterface.tsx` 用 `captions.map(...)` 直接当 captionRows）：e2e 红，台账 `counts=[0,3,3,...,3,1,1,...]`，两条读数各自报错——`no reading of the gesture saw exactly ONE user row holding the provisional transcription`（第 4 条）与 `the gesture's user-row count exceeded one at some point`（第 6 条，Expected <= 1, Received 3）；其余 3 条既有用例仍绿
- (b) 不跳过空 caption（去掉 `useVoiceRealtimeSession.ts` 的空帧守卫 + `placeCaptions.ts` 的 `if (next === '') continue;` 与 `if (text === '') return null;`）：纯函数判据红 2 例（`empty and whitespace-only captions produce no row at all`、`a wordless caption is not a piece either`），e2e 空转写臂红（`a transcription with no words became a user row`，5 → 6）
- 两处均以 `git checkout --` 还原并复跑，`8 passed` / `25 passed` / `4 passed` 恢复

实现要点：`placeCaptions.ts` 新增 `foldCaptionsIntoTranscriptRow`（拼接规则与服务端 `joinParts` 同规，模块私有 `joinCaptionParts`），行 id 取 `voice-caption-<首条 itemId>`、时间戳取首条**有字**caption 的 `at`，故交付认领该行时是 1↔1 就地定型；`useVoiceRealtimeSession.ts` 在源头丢弃无字帧（唯一例外：关闭屏上已有 utterance 的空帧保留其文字并标 final）。

## 观察记录（2026-10-11，非判据）

以下是一次真实 Live Voice 交互的实测记录，供 AC-326 落地后重测时作对照基线。**它不是判据、不是 AC、也不是改进方案**——操作者明确要求：暂不定改进方案，等本任务完成后再重测。

- 连接：2026-10-11 08:14 CST，journal `~/.cloudcli/voice-realtime-log/f6166468-b912-4ff9-8522-70935c4afc27.jsonl`，`"mode":"continuous"`（P4 分段中继已按操作者决定回退）。
- 三句话的实测链路：上游把语音切成多次提交 → 显示成 **2 行 caption**（`"已经。"` 08:14:51.265 / `"啊，稍好一点。"` 08:14:52.199）→ 但**只转发 1 条**消息（`session_send {"message":"啊，稍好一点。"}`，08:14:57，`coalesced 1 relayed piece(s)`）。
- 被丢掉的那个片段（`"已经。"`）**是期望行为**：操作者确认这属于 Omni 的预期语义处理，不算缺陷，不要为它立缺陷。
- 语音侧延迟不是问题：`session_send delivered in 1 ms`／`2 ms`；从第一句到第三句共约 7 秒。
- 操作者感到的 >10 秒是 **Claude Code 回合本身**在处理，不是语音链路。
- 操作者的另一条观察：退出 Live Voice **不会**取消已在跑的回合——消息早已投递进会话，回合继续跑；退出时第一段仍在处理中。
- 重测条件：本任务（AC-326）完成后再测，届时以本记录为对照。
