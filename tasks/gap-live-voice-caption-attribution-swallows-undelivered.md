---
id: gap-live-voice-caption-attribution-swallows-undelivered
title: Live Voice 退出时"未投递话语转入 composer"失效：投递的 caption
  归属按"此刻所有未认领"而非按文本，一条投递吞掉它并未携带的话语（气泡随之消失）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（2026-10-12 逐文件复核，带 file:line）

- **归属是"此刻所有未认领"，不是"这条投递真的携带的"。** `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:933-937` 在 `sent` 帧到达时：
  `const carried = captionsRef.current.filter((caption) => caption.final && !attributedRef.current.has(caption.itemId));`
  代码自己的注释即写 *"This delivery carries every finished utterance not already accounted for by an earlier one."* —— 它**不检查** `frame.message` 里是否真的包含那些 caption 的文字。
- **backlog 的定义因此被架空。** `src/modules/chat/voice-realtime/placeCaptions.ts:289` 的 `collectUndeliveredUtterances` 把 backlog 定义为"**没有任何投递认领**的 final caption"；被误认领的那些对它永久不可见，永远到不了 composer。
- **接线本身是对的。** `src/modules/chat/ChatInterface.tsx:710` 的 `handleVoiceExit` → `setInput(...)` 完全按设计工作（`gap-live-voice-stop-vs-exit-affordances` 的 AC5）。错的是喂给它的集合。
- **同一机制还制造第二个症状。** 被认领的 caption 行随后被 `deliveryIsShown` 判为"已上屏"而移除 ⇒ 退出时气泡消失。操作者看到的"气泡消失"与"文字没进编辑框"是**同一个机制**，不是两件事。

### 真实读数（2026-10-12，journal `99df08d8-d295-4100-b7f7-2cf598a032e8`，会话 `b280be43-25b7-4054-86a4-d29c08ce6457`，mode continuous）

- 22 条 `transcription.completed` 对 17 次 `session_send` 调用：其中 **4 条被识别成 caption 显示、模型从未转发**（无对应 `session_send`）——
  `现在可以看出来啊，当前时间来，Y Smart 和。` / `啊，以这个ChatGPT版本呢，其实会倾向于。` / `懂。` / `而后退。`
- 下一条投递（`01:29:03.739`，`coalesced 3 relayed piece(s)`，文本 `好像现在语音输入又断了。哦，只是慢。还是出来了。`）在到达时把它们**全部认领**：在此之前它们是 final 且未被认领，而更早的投递只有 `01:26:53` 那一条（在它们之前）。
- 结果：退出时 `collectUndeliveredUtterances` 返回空串 ⇒ `handleVoiceExit` 的 `if (backlog !== '')` 不成立 ⇒ 编辑框保持原样；那些 caption 行同时被移除。**那 4 段话只能从原始上行采集 WAV（`~/.cloudcli/voice-realtime-capture/99df08d8….wav`）重新转写找回**——本地 SenseVoice 得到的原句是："现在可以看出来啊，当前[实现] live voice mode 和 ChatGPT 的那个持续的输入，它有个差异，就是 ChatGPT 版本其实会倾向于每次有语音输入的时候，它就会把前序的操作停下来，然后等着用户的输入，攒更多的输入，然后整体地往后推。"
- 这 4 段的**上游成因**（上游 118.4 s 静默把 28 s 连续语音切成 0.1–0.3 s 碎片，模型只转发了其中 3 条）已有独立修复（`6be267f9` 音频寄出时间线、`80a586bf` 看门狗武装条件，均已落 `author`）。**本任务只管客户端归属，不重复上游那两件。**

### 要交付

1. **归属按键文本判定**：一条投递只认领它的 `frame.message` **确实包含**其文字的 caption。判定复用仓库已有的同一套归一化（服务端 `normalizeRelayText`，`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 的导出；客户端若已有等价物则复用它，**不新增第二套**），或等价地把认领限定在该投递自己的合并窗口内。**不得**再使用"此刻所有未认领"。
2. **取假必红**：把 `sent` 处理变异回旧行为（认领所有未认领 final caption）⇒ 本任务新判据必须红；恢复后绿。记录变异 diff、逐字失败行与恢复命令。
3. **不回归**：`gap-live-voice-caption-removal-on-shown` 的 AC4/AC5（`voiceStopVsExit.test.tsx`）不改一字仍逐字通过；"重复投递计数为 0"的断言仍绿；`gap-live-voice-caption-row-sorts-above-real-user-row` 的判据仍绿。
4. **判据落点**：扩展现有 `src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx`（其 AC5 已覆盖"未投递文本进入 composer"，形状最贴）。若新增客户端测试文件，注意 `src/` 与 `server/` 各自的测试文件计数 pin 位置不同。
5. **静态门**：`npm run typecheck`、`npm run lint`（无 `: error `）、`npm run test:client` 退出 0。

<!-- dedup-ref -->
### 范围边界（dedup）

- 与 `gap-live-voice-stop-vs-exit-affordances`（**done**，构建了"退出不中断 + backlog 转入 composer"这条通路及其 AC5）**不同**：本任务是**喂给它的归属集合**出错，不是那条通路没建。⛔ 不要把本任务合并回那条。
- 与 `gap-live-voice-caption-removal-on-shown`（**done**，把移除键从 `sent` 改成 `visibleMessages` 匹配）相邻但不同：那条管**移除时机**，本任务管**归属范围**。
- 与 `gap-live-voice-delivery-state-visible`、`gap-live-voice-bounded-queue-refusal-visible`（均 done）不同：那两条是投递状态与准入，本任务是归属本身。
- 合并候选检查（`task-granularity-advice.js --touches … --json`）：`peers: []`、`mentions: []` ⇒ **none found**，独立立案。

## AC

- [ ] AC1 **归属按键文本**（判据先行）：构造「4 条 final caption 无任何投递携带 + 随后一条只携带其中另 3 条文字的投递」这一形状 ⇒ `collectUndeliveredUtterances` 必须返回那 4 条的拼接文本（而不是空串），且该投递的 `itemIds` 只包含它真正携带的那些。逐字写出两侧读数。判据 `npm run test:client -- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx` 退出 0。
- [ ] AC2 **端到端语义**：同一形状下点退出 ⇒ composer 输入框的值包含那 4 段文字，且退出后**不再**被投递（重复投递计数 0）。判据同 AC1 文件退出 0。
- [ ] AC3 **取假必红**：把归属变异回"此刻所有未认领" ⇒ AC1 红；恢复后绿。逐条记录变异 diff、逐字失败行与恢复命令。
- [ ] AC4 **不回归**：`voiceStopVsExit.test.tsx` 的既有 AC4/AC5 不改一字仍逐字通过；`gap-live-voice-caption-row-sorts-above-real-user-row` 的判据仍绿。
- [ ] AC5 **静态门**：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写明计数）；`npm run test:client` 退出 0。

## DoD

一个**真实对象**被操作过：真实浏览器里跑一次 Live Voice，先说几句正常的话、再说一句**模型不会转发**的话（可用假上游/脚本化上游制造"识别到但无 session_send"的形状），然后点退出——操作者能在编辑框里看到那句没被转发的话并直接发出。证据：退出前后编辑框值的读数、气泡在退出前后的读数（该留下的留下、该带走的带走）。单元判据必要但不充分。

## Touches

- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/placeCaptions.ts
- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx
- tasks/gap-live-voice-caption-attribution-swallows-undelivered.md
