---
id: gap-live-voice-segment-honest-heard-unrecognized-state
title: Live Voice 逐段诚实状态：字幕按说话顺序；未被模型转发的话保持
  heard；无转写/被拒段原位「未识别」；用户退出按序回填未转发的话并留关闭痕迹（不自动补发）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-caption-segment-attribution-by-item-id
  - gap-live-voice-manual-mode-session-update-keeps-vad-off
goal_ac: AC-355
---
## Proposal

### 问题（代码已核对，2026-10-12）

- 前端字幕按 itemId 存，但顺序是首次到达顺序（`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts` 约 :853-885）；`foldCaptionsIntoTranscriptRow` 把所有未上屏字幕折成一行（`placeCaptions.ts` 约 :147-189），状态是 delivering/heard。
- 没有逐段「未识别」标记。唯一信号 `countUnshownUtterances`（`placeCaptions.ts` 约 :265-279）是总数，且只在服务端/网络关闭时计算；用户点退出时 `end()` 先清 `socketRef`，`onclose` 提前返回（约 :1054-1077），`seqRef` 被重置（约 :618）⇒ 用户主动退出时没有任何关闭痕迹。
- `collectUndeliveredUtterances`（`placeCaptions.ts` 约 :296-307）按到达顺序回填 composer。
- 2026-10-12 实测（journal ef9daacd…）：「第三句话」没有任何转写，屏上与 composer 里都看不到它曾被说过。

### 期望（人 yale 2026-10-12 裁定）

- 模型可以不转发部分输入：未被 `sent` 认领的话**诚实地保持 heard**（不显示投递中/已发送、不消失），退出时按说话顺序回填 composer。
- 有段已提交但超过时限既无转写也无失败事件、或提交被上游拒：在原位显示一行「未识别」；转写随后到达则原位替换（晚到不是缺陷）。
- 用户主动退出也留关闭痕迹，计数包含未识别段。
- 可恢复错误继续只进控制台（2026-10-11 裁定不变）。

### SCOPE BOUNDARY

- ⛔ 不实现任何自动补发 Claude 的 UI 或请求。
- ⛔ 不做逐条撤回（AC-351 / `gap-live-voice-pending-utterance-withdraw` 的范围）；与其共改 `useVoiceRealtimeSession.ts` 时按 develop 合并。
- 依赖上游任务提供的 seq↔itemId 帧字段。

## Plan

1. 判据测试（先红，帧序列取自 journal ef9daacd…）；2. 按 seq 排序与 heard 状态；3. 未识别行与 i18n（全部 locale）；4. 用户退出的关闭痕迹；5. 退出回填按 seq；6. 回放缺陷腿 (c)(d) 翻绿并确认回放无剩余 test.fail（AC-356）；typecheck/lint/test:client。

## AC

- [x] AC1（取假形态排最前）：`npx vitest run src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx` 退出 0；首组用例在「按到达顺序排序 / 回填」的假形态下红（证明会红）。
- [x] AC2：字幕行顺序 = seq 顺序，与转写到达顺序无关（分支 B：S3 晚于 S4 到达仍排在 S2、S4 之间）。
- [x] AC3：只有被 `sent` 认领的话变为已发送；其余保持 heard，不出现 delivering，不被移除。
- [x] AC4：无转写段 / 提交被拒段在原位渲染一行「未识别」，全部 locale 有译文（无未翻译字面量）；转写随后到达则原位替换为字幕。
- [x] AC5：用户点退出：composer 只追加未转发的最终转写，按 seq 顺序（分支 A：S2+S4；分支 B：S2+S3+S4）；未识别段不回填，但关闭痕迹计数包含它。
- [x] AC6：UPSTREAM_ERROR / MODEL_TEXT_REPLY 仍只进控制台；无任何自动补发请求。
- [x] AC7：回放 `e2e/voice-realtime-segmented-replay-20261012.spec.ts` 缺陷腿 (c)(d) 去掉 `test.fail()` 后通过；整份 spec 不含 test.fail/fixme/skip 且单文件运行退出 0（AC-356 收口）。
- [x] AC8：回归——`voiceStopVsExit.test.tsx` 及 `src/modules/chat/voice-realtime/tests/` 其余文件、`e2e/voice-realtime-scripted-scenarios.spec.ts` 退出 0；`npm run typecheck`、`npm run lint`、`npm run test:client` 退出 0。

## DoD

浏览器回放（分支 A、B）截图：S1/S5 为已发送行、S2/S4 为 heard 行、分支 A 中 S3 位置有「未识别」行、退出后 composer 内容；截图与回放输出写入 Notes；零云调用。

## Touches

- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/placeCaptions.ts
- src/modules/chat/transcript/MessageComponent.tsx（仅当未识别行在此渲染）
- src/modules/chat/ChatInterface.tsx（仅当退出回填需改）
- src/modules/i18n/locales/*/chat.json（未识别行文案，全部 12 个 locale：de/en/es/fr/id/it/ja/ko/ru/tr/zh-CN/zh-TW）
- src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx (new)
- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx（仅当既有断言受影响）
- e2e/voice-realtime-segmented-replay-20261012.spec.ts（翻转缺陷腿 c、d）
- tasks/gap-live-voice-segment-honest-heard-unrecognized-state.md
- src/modules/chat/voice-realtime/index.ts（barrel：导出新的取行入口 `voiceTranscriptRows` / `heardUtteranceRows` / `unrecognizedSegmentRows`）
- src/shared/types.ts（`ChatMessage.voiceUnrecognizedSeq`：未识别行的段号）
- e2e/voice-realtime-scripted-scenarios.spec.ts（兄弟 spec 的投递屏障；见 Notes「本任务自己踩的坑」）
- src/modules/chat/tests/liveVoiceNewSessionEntry.test.tsx（hook stub 补 `unrecognizedSeqs`）
- src/modules/chat/tests/voiceModePermissionBanner.test.tsx（同上）

## Notes

立项：Opus 常驻会话 2026-10-12，人 yale 授权（GOAL-043 / AC-355，并承担 AC-356 收口）。依赖 itemId 归属任务（seq↔itemId 帧）与 VAD 修复任务（保证本任务最后落地、回放可整份转绿）。locale 文件在 `src/modules/i18n/locales/<lang>/chat.json`（de/en/es/fr/id/it/ja/ko/ru/tr/zh-CN），按仓库 i18n 约定全部补齐。

### 立案取证（2026-10-12）

回放草稿在当前代码上读到：(1) 未转发的 S2、S4 与 S5 被折成一行并标 `voice-row-delivering`（AC3 针对此）；(2) S2+S4 的 heard 行排在 S5 真实行之后——`placeCaptionsChronologically` 有意把字幕行放在最新真实行之下（既有 done 任务 `gap-live-voice-caption-row-sorts-above-real-user-row` 的约定）；(3) C 段无未识别标记、用户退出无关闭痕迹；(4) 分支 B 屏上与回填顺序为 S2、S4、S3。

⚠️ 待人裁定：heard 行相对**真实已发送行**的位置（保持「字幕行在底部」的既有约定，还是按说话顺序插到 S5 之前）。在裁定前本任务只要求字幕之间按 seq 排序（AC2），不改字幕行相对真实行的位置。

### 落地读数（2026-10-13，工作树已并入 develop fe9fe7e4，实现提交 8a87620b）

**AC1**：`npx vitest run src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx` 退出 0（新文件 16 用例 / 5 组全绿）。取假形态：只去掉那一次 `sortCaptionsInSpokenOrder(next)` 调用后 → `Test Files 1 failed (1)`、`Tests 2 failed | 14 passed (16)`、EXIT=1，两处失败都落在**第一组**（字幕顺序 `to deeply equal` 失败；composer 草稿读到 `第三句话。第四句话。现在是第二句话。`，期望 `现在是第二句话。第四句话。第三句话。`）。复原后与 `voiceStopVsExit.test.tsx` 同跑 = `Test Files 2 passed (2)` / `Tests 24 passed (24)` / EXIT=0。该假形态实验在并入之前完成；并入 `6405ef2f..fe9fe7e4` 带来的文件清单里**没有任何 `src/` 文件**（只有 e2e spec、`e2e/voiceRealtimeScriptedUpstream.ts`、`playwright.config.ts`、server 测试、docs/tasks），故源码级读数不受并入影响。

**AC2 / AC3 / AC4 / AC5**：Playwright 回放单文件 `--workers=1`，在**并入后的树**上重跑 = `19 passed (1.3m)`、EXIT=0。读数取自本次 `QUAY_REPLAY_DUMP` 录制（`snapshot()` 只收 `[data-message-style]` 行；未识别行按设计没有该属性，其存在与位置另取 `bodyText` 与截图为证）：

- 分支 A `beforeExit`：真实行（无 testid 的 user 行）S1 与 S5；`voice-row-heard` 2 行（`现在是第二句话。`、`第四句话。`）；**两行** `Not recognized — this part of your speech was never transcribed.` 夹在 S2 与 S4 之间（原位，不是追加到末尾）；全程 `voice-row-delivering` = 0。
- 分支 B `beforeExit`：真实行 S1、S5；`voice-row-heard` 3 行，DOM 文本顺序为 `现在是第二句话。 → «未识别» → 第三句话。 → 第四句话。` —— 晚到的 S3 落在 S2 与 S4 **之间**（AC2）。
- 原位替换（AC4）：分支 B 快照序列 `afterStall → afterS4` 的未识别行数 2 → 1、`heard` 行数 1 → 3，即 S3 的转写晚到后原位替换掉那一行；分支 A 因为 S3 始终没有转写，标记保持 2 行。
- 退出（`afterExit`）：composer 草稿 分支 A = `现在是第二句话。第四句话。`、分支 B = `现在是第二句话。第三句话。第四句话。`、变体 R（对照）= 同 A、变体 V = 空。关闭痕迹 `Live Voice closed before 4 of your words reached the screen.`（A/B/R），变体 V 为 `before 1` ⇒ 计数 4 / 4 / 1 / 4（AC5：未识别段不回填，但计入关闭痕迹）。
- AC3：`queuedS5` 快照里 `voice-row-delivering` = 1（只有 S5 自身在合并窗口内），未转发的 heard 行从不进入 delivering；退出后 heard 行数为 0，且只以真实行 + 草稿的形式回收，没有丢失。
- AC6：腿 `no red error UI for the recoverable UPSTREAM_ERROR and MODEL_TEXT_REPLY; both reach the console` 通过，`errorVisible=false`；整份回放没有补发请求（腿 3 `only S1 and S5 reach Claude, in both branches`）。
- 变体 V（晚到空转写）与 R（六段全被端点受理）各 2 条腿全绿；腿 12 `unrelayed transcripts are never shown as delivering while S5 is in flight`、腿 13 `… each at its spoken position`、腿 14 `(c) branch A: the segment C that never got a transcript is visibly marked before Exit`、腿 15（退出痕迹）、腿 16 `(d) branch B: Exit back-fills S2, S3, S4 in SPOKEN order, not arrival order`、腿 17 `(d) branch B: the late S3 transcript sits at its spoken position (before S4) on screen` 全部通过。

**AC4 i18n**：`message.voiceUnrecognized` 在 12 个 locale 目录里各有一条真实译文（de/en/es/fr/id/it/ja/ko/ru/tr/zh-CN/zh-TW，zh-TW 也在内；`grep -rl voiceUnrecognized src/modules/i18n/locales/` = 12），无未翻译字面量。

**AC7**：`grep -nE "test\.(fail|fixme|skip)\(|expectKnownDefect\(" e2e/voice-realtime-segmented-replay-20261012.spec.ts` 无匹配（exit 1）；单文件 19 腿全绿 EXIT=0。develop 上该 spec 原有 6 处 `expectKnownDefect(..., { fixTask: 'gap-live-voice-segment-honest-heard-unrecognized-state' })` 已全部拆除（含腿 13）。

**AC8**（并入后的树）：`npm run test:client` = `Test Files 202 passed (202)` / `Tests 1499 passed | 1 skipped (1500)` / `0 failed`、EXIT=0；`npm run typecheck` EXIT=0；`npm run lint` EXIT=0；`e2e/voice-realtime-scripted-scenarios.spec.ts` 单文件 `--workers=1` = `11 passed (1.5m)`、EXIT=0；`src/modules/chat/voice-realtime/tests/` 目录 = `Test Files 14 passed (14)` / `Tests 167 passed`、EXIT=0。

### 本任务自己踩的坑（记录以免误判）

1. **兄弟 spec 的屏障原本读的是一个巧合**。腿 `a phrase the model never forwards stays on its row and re-homes into the composer on leave` 在并入前的树上确定性红（`Error: the delivered utterance must not be re-homed; draft "这句话没有被转发出去把 server 的日志贴出来"`）。根因：develop 的屏障注释（"The tool result lands after the coalescing flush"）是**假的** —— 探针在 develop 与本树上读到工具结果都约 100 ms 就回来（`t=101ms` / `t=102ms`），而中继的合并窗口是 2500 ms；develop 之所以绿，是因为它把未发送字幕折成**一行**、该行在窗口内读作 `delivering`，于是 `getByTestId('voice-row-heard')` 的等待被"顺带"阻塞了约 2.4 s。本任务把行拆成逐句之后，该等待在约 100 ms 就满足，页面在窗口内离开，`sent` 帧无人接收，被投递的话被重新塞回 composer —— 正是该腿禁止的事。修法：把屏障换成页面自己的投递读数 `expect(page.getByTestId('voice-row-delivering')).toHaveCount(1)` → `toHaveCount(0)`（**断言一字未改**）。修后该腿 4.7 s（= develop 自身的耗时），整份 11 passed。
2. **并入后首跑 `npm run test:client` 红**：2 files / 7 tests，全部同一个根因 —— `ChatInterface.tsx` 的取行门读了新增字段 `voice.unrecognizedSeqs.length`，而 `src/modules/chat/tests/liveVoiceNewSessionEntry.test.tsx` 与 `src/modules/chat/tests/voiceModePermissionBanner.test.tsx` 的手搓 hook stub 逐字段枚举了组件会读的字段、独缺这个新字段（develop 自己的门也是无保护地读 `voice.captions.length`，所以约定是 stub 补齐，而不是把门写成 `?.` 放行）。给两处 stub 补 `unrecognizedSeqs: []` 后这两个文件 `10 passed` / EXIT=0，整份套件 202 files / 1499 passed / 0 failed。

### DoD 证据（截图与录制，均在并入后的树上重取）

`/data/home/yale/.cache/quay-e2e-shots-gap-live-voice-segment/`：8 张 PNG —— `branch-{A,B,V,R}-before-exit.png`、`branch-{A,B,V,R}-after-exit-composer.png`，以及录制 `segmented-replay-20261012.recording.json`。零云调用：回放腿 2 读到 `[egress] browser non-local requests: 25 (api.github.com, fonts.googleapis.com)`（只有页面自身的 chrome，无任何语音供应商域名）；每个分支记录的 `dialed` 全部指向 `127.0.0.1:13131`（本机脚本上游），`authorizationHeaderSeen=false`（未出示云凭据）；全程以 `DASHSCOPE_API_KEY=` 空跑。

### ⚠️ 待人裁定一条的处置

原 Notes 的临时条款（「在裁定前只要求字幕之间按 seq 排序，不改字幕行相对真实行的位置」）已被**立案者自己写的腿**越过：develop 上该 spec 的 6 处 `expectKnownDefect` 的 `fixTask` **全部**指向本任务，其中腿 13 名为 "unrelayed transcripts stay visibly heard after S5 is delivered, **each at its spoken position**"，其断言是 `expect(order).toEqual([...order].sort((a,b) => a-b))`（对 `[S1_RELAYED, S2, S4, S5]`）—— 「按说话顺序落位到真实行之间」正是本任务被指派的腿所要求的，而不是留给裁定的可选项。因此本实现按说话顺序落位，AC2 与腿 13 同时为真；该临时条款按「已被取代」记录。
