---
id: gap-live-voice-segment-honest-heard-unrecognized-state
title: Live Voice 逐段诚实状态：字幕按说话顺序；未被模型转发的话保持
  heard；无转写/被拒段原位「未识别」；用户退出按序回填未转发的话并留关闭痕迹（不自动补发）
status: todo
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

- [ ] AC1（取假形态排最前）：`npx vitest run src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx` 退出 0；首组用例在「按到达顺序排序 / 回填」的假形态下红（证明会红）。
- [ ] AC2：字幕行顺序 = seq 顺序，与转写到达顺序无关（分支 B：S3 晚于 S4 到达仍排在 S2、S4 之间）。
- [ ] AC3：只有被 `sent` 认领的话变为已发送；其余保持 heard，不出现 delivering，不被移除。
- [ ] AC4：无转写段 / 提交被拒段在原位渲染一行「未识别」，全部 locale 有译文（无未翻译字面量）；转写随后到达则原位替换为字幕。
- [ ] AC5：用户点退出：composer 只追加未转发的最终转写，按 seq 顺序（分支 A：S2+S4；分支 B：S2+S3+S4）；未识别段不回填，但关闭痕迹计数包含它。
- [ ] AC6：UPSTREAM_ERROR / MODEL_TEXT_REPLY 仍只进控制台；无任何自动补发请求。
- [ ] AC7：回放 `e2e/voice-realtime-segmented-replay-20261012.spec.ts` 缺陷腿 (c)(d) 去掉 `test.fail()` 后通过；整份 spec 不含 test.fail/fixme/skip 且单文件运行退出 0（AC-356 收口）。
- [ ] AC8：回归——`voiceStopVsExit.test.tsx` 及 `src/modules/chat/voice-realtime/tests/` 其余文件、`e2e/voice-realtime-scripted-scenarios.spec.ts` 退出 0；`npm run typecheck`、`npm run lint`、`npm run test:client` 退出 0。

## DoD

浏览器回放（分支 A、B）截图：S1/S5 为已发送行、S2/S4 为 heard 行、分支 A 中 S3 位置有「未识别」行、退出后 composer 内容；截图与回放输出写入 Notes；零云调用。

## Touches

- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/placeCaptions.ts
- src/modules/chat/transcript/MessageComponent.tsx（仅当未识别行在此渲染）
- src/modules/chat/ChatInterface.tsx（仅当退出回填需改）
- src/modules/i18n/locales/*/chat.json（未识别行文案，全部 11 个 locale）
- src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx (new)
- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx（仅当既有断言受影响）
- e2e/voice-realtime-segmented-replay-20261012.spec.ts（翻转缺陷腿 c、d）
- tasks/gap-live-voice-segment-honest-heard-unrecognized-state.md

## Notes

立项：Opus 常驻会话 2026-10-12，人 yale 授权（GOAL-043 / AC-355，并承担 AC-356 收口）。依赖 itemId 归属任务（seq↔itemId 帧）与 VAD 修复任务（保证本任务最后落地、回放可整份转绿）。locale 文件在 `src/modules/i18n/locales/<lang>/chat.json`（de/en/es/fr/id/it/ja/ko/ru/tr/zh-CN），按仓库 i18n 约定全部补齐。
