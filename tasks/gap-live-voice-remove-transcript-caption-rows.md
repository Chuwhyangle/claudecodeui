---
id: gap-live-voice-remove-transcript-caption-rows
title: Live Voice 对话区不再显示转写气泡（voice-caption-* 临时行，heard/delivering 两态）—
  底部语音框已显示转写文本；保留 undelivered/unrecognized/段丢失三类诚实状态行与真实消息上的
  voiceTranscript.heard 标注，删净
  heardUtteranceRows/foldCaptionsIntoTranscriptRow/dropCaptionsDeliveredAsMessages
  及其只为这类行存在的判据
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-13）：`task_list search=转写气泡` → 0 条；`task_list status=todo search=voice-caption-` → 0 条；`task-granularity-advice` 对本任务 Touches 的 `placeCaptions.ts`/`ChatInterface.tsx`/`MessageComponent.tsx` 返回 `peers=[]`、`mentions=[]`。相关的历史任务只在代码注释里被引用（`gap-live-voice-caption-removal-on-shown`、`gap-live-voice-caption-attribution-swallows-undelivered`、`gap-live-voice-caption-segment-attribution-by-item-id`）：它们是把转写气泡做对（何时撤、怎么归属、拒收怎么显示），本条是把这一种行整个去掉，方向相反，不是重复。决定：separate。

**人的裁定（人 yale，2026-10-13，第四次 live voice 测试后）**：不再显示转写气泡（临时行）。底部语音框里已经显示转写文本了，这样界面更干净。

**现状（本轮读代码实测）**：
- 对话区里「像你说的话」的东西有三种：转写气泡（`id` 以 `voice-caption-` 开头的临时 user 行，`voiceRowState` 为 `heard` 或 `delivering`，由 `heardUtteranceRows` 逐句产出）、虚线排队行（`VoicePendingUtterance.tsx`，CLI 队列里还没被取走的那条指令，可撤回）、真正的 user 消息。本条只处理第一种。
- 转写气泡只存在于浏览器内存里，不入库；它在真实消息出现在 transcript 里时才被 `markDeliveredVoiceMessages`/`dropCaptionsDeliveredAsMessages` 撤掉，文字与真实消息不一致时就会悬着（见记忆 live-voice-attribution-cannot-rest-on-relayed-text）。
- 底部语音框的转写位 `data-testid="voice-realtime-caption"`（`VoiceRealtimeBar.tsx:208/337`）显示的是 `captions` 里**最后一条**的文字，单行、超长靠 `title` 看全。
- `foldCaptionsIntoTranscriptRow` 在生产里已经没有调用点（`voiceTranscriptRows` 用的是 `heardUtteranceRows`），只剩单测在钉它。

**范围（本条的取舍，已写明理由）**：
1. **去掉**：对话区里 `heard`/`delivering` 两态的转写行。`voiceTranscriptRows` 不再产出它们；`MessageComponent` 里只为这两态存在的标记分支（`Tidying up…`/`Heard`）与 `voiceRowState` 类型里的这两个成员一并去掉。
2. **保留**：`undelivered`（代理拒收的句子）、`unrecognized`（没有转写的段）、段结局 `lost`（segment outcome）三类行。它们不是「转写」，是**出了问题的告知**：删了就是静默吞掉失败，用户看不出哪句没送达。若人要连这三类也去掉，须单独裁定，本条不替人做。
3. **保留**：真实 user 消息上的 `voiceTranscript.heard` 标注（`markDeliveredVoiceMessages` 写入）、退出 Live Voice 时把未送达积压回填输入框（`collectUndeliveredUtterances`）、底部语音框与虚线排队行。
4. **已接受的后果**（写进来是为了不被当成回归）：一次连续说多句时，对话区不再逐句留痕，底部只显示最新一句；从你停顿到真实消息出现（2.5 秒合并窗口加 CLI 排队，今天实测最长约 54 秒）这段时间里，对话区没有任何「已听到」的痕迹，能看到的只有底部语音框与排队行。

**要做的事（最小充分集）**：
1. `placeCaptions.ts`：`voiceTranscriptRows` 不再调用 `heardUtteranceRows`；删掉 `heardUtteranceRows`、`foldCaptionsIntoTranscriptRow`、`dropCaptionsDeliveredAsMessages` 及只为它们服务的私有辅助（`joinCaptionParts` 等，以 `grep` 为准）；`markDeliveredVoiceMessages` 仍要给真实行写 `voiceTranscript.heard`，不再接收也不再返回转写行；`placeCaptionsChronologically`/`positionOfRow` 里只服务转写行的分支同步收窄，诚实状态行的定位规则不变。
2. `MessageComponent.tsx` 与 `src/shared/types.ts`：去掉 `heard`/`delivering` 的标记分支与类型成员，`undelivered` 行的表现逐字不变。
3. `voice-realtime/index.ts` 与 `ChatInterface.tsx`：同步去掉被删函数的导出与已无意义的实参（如 `delivering`），其余调用方式不变。
4. 判据：新增 `voiceNoTranscriptCaptionRows.test.ts` 钉住「任何读数组合下都没有转写行」与「三类诚实行、真实行标注都还在」；原来断言转写行行为的单测（`voiceCaptionShownState`、`voiceDeliveryState`、`voiceSingleTranscriptRow`、`placeCaptions`、`voiceSegmentHonestState` 里那部分）按新契约改写或删除，**不得为了过测留着死代码**；`sessionLifecycle.timeline.ts` 与 `sessionLifecycleScenario.test.tsx` 里对 `heardUtteranceRows` 的依赖一并改掉；e2e 里断言转写行的臂改成断言底部语音框的转写位，并断言对话区里没有该句文字。
5. 实现须遵守 `AGENTS.md` 中 `$frontend-module-standards` 对 `src/` 前端代码的约束。

**非目标**：不改底部语音框（`VoiceRealtimeBar.tsx`）的显示方式（单行、仅最新一句，若要改成多句是另一条）；不改服务端、relay、归属匹配、`Working…` 指示器；不改虚线排队行；不动三类诚实行的位置与文案。

## AC

- [ ] 新判据入口为绿：`npx vitest run src/modules/chat/voice-realtime/tests/voiceNoTranscriptCaptionRows.test.ts` 退出 **0** 且 `failed 0`。该文件对 `voiceTranscriptRows` 逐一喂：只有 interim 的 caption、一条 final 且无投递、final 且代理 `delivering`、投递已接受但真实消息未出现、投递的真实消息已出现，五种读数，每种都打印 `captionRows=0 heardOrDeliveringRows=0`，且输出里没有任何 `id` 以 `voice-caption-` 开头或 `voiceRowState` 为 `heard`/`delivering` 的行。命令逐字含文件路径，不用 glob。
- [ ] 诚实行与标注仍在（正控制，同一文件）：喂 `undeliveredItemIds` 得到恰好 1 条 `voiceRowState='undelivered'` 的行；喂 `unrecognizedSeqs` 得到对应的未识别行；喂 `lost` 的 `segmentOutcomes` 得到对应的段结局行；投递的真实消息出现时，该真实行带 `voiceTranscript.heard`。分别打印 `undeliveredRows=1 unrecognizedRows=<n> outcomeRows=<n> markedRealRows=1`，保证「没有转写行」不是因为整条通路都空了。
- [ ] 假形态承重：把 `voiceTranscriptRows` 临时改回调用 `heardUtteranceRows`（判据文件一字不动）⇒ 新判据命令退出 **1**，且红落在第一种读数的 `captionRows` 上（不是别的腿先红）；退出码与红态文案逐字抄进完成记录，用后 `git checkout --` 还原。
- [ ] 死代码清零：`grep -rnE "heardUtteranceRows|foldCaptionsIntoTranscriptRow|dropCaptionsDeliveredAsMessages|message\.voiceHeard|message\.voiceDelivering" src e2e | wc -l` 读数为 **0**（用 `grep -r`，不用 `git grep`，避免漏掉未跟踪文件）。
- [ ] 既有前端判据不变红，逐条单文件运行并打印命令与退出码，全部退出 **0**：`npx vitest run src/modules/chat/voice-realtime/tests/placeCaptions.test.ts`、`…/voiceCaptionShownState.test.tsx`、`…/voiceDeliveryState.test.tsx`、`…/voiceSingleTranscriptRow.test.ts`、`…/voiceSegmentHonestState.test.tsx`、`…/voiceSegmentLostState.test.tsx`、`…/voiceStopVsExit.test.tsx`、`src/modules/chat/hooks/tests/sessionLifecycleScenario.test.tsx`。被改写的文件在完成记录里逐个说明「删了哪些断言、为什么」，不得出现把断言改成恒真。
- [ ] 真实界面读数：在脚本化 Live Voice 场景（`e2e/voice-realtime-upload-fixture.spec.ts` 或 `e2e/voice-realtime-scripted-scenarios.spec.ts` 里已有的上传夹具臂）里，说出一句话、在该句被投递成真实消息之前，读 DOM 打印 `barCaptionContains=true chatAreaNodesContaining=0`（底部 `voice-realtime-caption` 含该句，对话区里含该句文字的节点数为 0）；该句成为真实消息之后再读一次，打印 `realRowNodes=1`。被改写的 e2e 臂各自用 `npx playwright test <file> -g "<臂标题>"` 单文件单臂运行并打印命令与退出码，全部退出 **0**。
- [ ] 契约面：`npm run typecheck`、`npm run lint` 退出 **0**。
- [ ] 重新构建并重启生产服务后，在真实 Live Voice 页面上说几句话，对话区不再出现灰色转写气泡、底部语音框仍显示转写文本（待外部）

## DoD

新判据在**修复完成的树**上按原命令重跑：退出 0、`failed 0`，五种读数下转写行数都是 0，三类诚实行与真实行标注的正控制都读得到。真实落地不是「测试存在」：脚本化 Live Voice 场景里真的说一句话，真的在对话区读不到该句转写文字、底部语音框读得到，真的在它成为真实消息后读到那一行真实消息。假形态（`voiceTranscriptRows` 改回产出转写行）把第一种读数打红；`grep -rn` 读数里被删函数 0 处残留。既有的诚实状态判据（未送达、未识别、段丢失）逐条仍绿，没有被连带删除。**生产服务要吃到这条改动必须重新构建并重启 `claudecodeui-server.service`，这会断开当前所有会话**：执行者不得自行重启，须向人说明并由人决定时机；重启后的界面读数由人确认，对应最后一条 AC。

## Touches

- `src/modules/chat/voice-realtime/placeCaptions.ts`
- `src/modules/chat/voice-realtime/index.ts`
- `src/modules/chat/transcript/MessageComponent.tsx`
- `src/modules/chat/ChatInterface.tsx`
- `src/shared/types.ts`
- `src/shared/scenarios/sessionLifecycle.timeline.ts`
- `src/modules/chat/voice-realtime/tests/voiceNoTranscriptCaptionRows.test.ts` (new)
- `src/modules/chat/voice-realtime/tests/placeCaptions.test.ts`
- `src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx`
- `src/modules/chat/voice-realtime/tests/voiceDeliveryState.test.tsx`
- `src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts`
- `src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx`
- `src/modules/chat/voice-realtime/tests/voiceSegmentLostState.test.tsx`
- `src/modules/chat/hooks/tests/sessionLifecycleScenario.test.tsx`
- `e2e/voice-realtime-upload-fixture.spec.ts`
- `e2e/voice-realtime-segmented-replay-20261012.spec.ts`
- `tasks/gap-live-voice-remove-transcript-caption-rows.md`
