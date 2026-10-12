---
id: gap-live-voice-segmented-replay-20261012
title: 2026-10-12 五句话 Live Voice segmented 输入的确定性 Playwright 回放（scripted fake 上游
  + debug-agent + 假麦克风；缺陷腿 test.fail 红先行）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-352
---
## Proposal

### 问题

2026-10-12 07:47–07:49Z 人 yale 用 Live Voice（segmented-v1 手动提交）连说五句：S1「这是一轮新的 Live Voice Mode 测试」S2「现在是第二句话」S3「第三句话」S4「第四句话」S5「上面我们看见丢了一句话」。只有 S1、S5 到达 Claude；退出后 composer 被回填「现在是第二句话。第四句话。」；S3 从未出现在任何字幕里。证据：`~/.cloudcli/voice-realtime-log/ef9daacd-9950-414a-acfc-aace142bf273.jsonl`（07:47:30–07:49:25Z）与 `~/.cloudcli/voice-realtime-capture/ef9daacd-9950-414a-acfc-aace142bf273.timeline.jsonl`（本次无 WAV）。

这类问题目前只能靠真人真模型复现。需要一份零云调用、确定性的浏览器回放，先在当前代码上读出红，再据此驱动修复（GOAL-043）。

### 上游逐提交剧本（按 journal 还原）

| 浏览器段 | 假上游动作 |
|---|---|
| seq0 | committed(A) + item.created(A) → transcription.completed(A,S1) → function_call session_send(S1) → tool output 后模型文本「OK」 |
| （之间） | 服务端状态注入发出完整 session.update（tools=3）——当前代码会带 turn_detection: server_vad |
| seq1 | ERROR invalid_request_error「Error committing input audio buffer: buffer too small, or have no audio.」→ response 只有模型文本「OK」（无函数调用）→ speech_started → item.created(B)（上游 VAD 自建） |
| seq2 | committed → ~170ms 后 transcription.completed(B,S2)（晚到：属于 seq2 提交前就已创建的 B）→ speech_started；无 response.created |
| seq3 | committed + item.created(C)。分支 A：C 永无转写/失败事件；分支 B：C 的 transcription.completed(S3) 在 seq4 提交之后才到 |
| ~8s | 服务端向浏览器发 turn_unanswered |
| seq4 | committed + item.created(D) → speech_started → transcription.completed(D,S4)；无 response |
| seq5 | committed + item.created(E) → transcription.completed(E,S5) → function_call session_send(S5) → 送达 |
| 退出 | 点 voice-realtime-end，读 composer |

### 语义（人 yale 2026-10-12 裁定，SCOPE BOUNDARY）

- ⛔ Realtime 模型**可以**不转发部分输入；**绝不**实现或期望「有转写就自动补发 Claude」。
- ⛔ 转写晚到本身不是缺陷；期望的是按 itemId 归属与诚实状态。
- ⛔ 不改产品代码（只加测试与测试桩）；不重启 :3001；零云调用（DASHSCOPE_API_KEY 置空）。
- 不触碰 GOAL-041 A+ 任务的文件与语义。

## Plan

1. 测试桩：`e2e/voiceRealtimeScriptedUpstream.ts` 加按提交驱动的回调（如 `onClientFrame` / `onCommit((n, socket) => …)`），避免轮询 `clientFrames()` 的亚秒级竞态；`server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts` 补 `committed`、`itemCreated`、`speechStarted`、`responseCreated`、`responseDone` 构造函数并 re-export（同步 `e2e/voice-realtime-scripted-scenarios.spec.ts` 的 BUILDERS 钉子）。
2. 新 spec `e2e/voice-realtime-segmented-replay-20261012.spec.ts`：共享账号 `voice-realtime-e2e`；debug-agent 布置会话；假麦克风照搬 `e2e/voice-realtime-live-session-send.spec.ts:450-540` 的 `__voiceFake.speak`（与兄弟 spec 的假 AudioContext 成员保持一致）；确认服务端发 `ready{segmented-v1}`（显式清掉 VOICE_REALTIME_MODE=continuous 的环境泄漏）。分支 A、分支 B 各一组用例。
3. 正向腿（当前即绿）：只有 S1、S5 到 Claude（debug-agent 用户行 + `sent` 帧）；UPSTREAM_ERROR / MODEL_TEXT_REPLY 不出红色 UI；退出回填 composer。
4. 缺陷腿（当前红）各自独立 `test(...)`，用 `test.fail()` 标注，注释写修复任务 id 与当前代码上的逐字失败行：
   - (a) segments 开始后假上游收到的完整 session.update 的 `session.turn_detection` 非 null → `gap-live-voice-manual-mode-session-update-keeps-vad-off`；
   - (b) 晚到转写按到达时的 activeSegmentSeq 而非 itemId 归属（含「空转写晚到 → 下一段真实转发被误判为空」变体；以服务端 journal / segment 帧 / refused 帧为读数）→ `gap-live-voice-caption-segment-attribution-by-item-id`；
   - (c) 未转发的转写不按说话顺序、或未保持 heard → `gap-live-voice-segment-honest-heard-unrecognized-state`；
   - (d) 无转写段（S3 分支 A）无逐段可见标记、用户退出无关闭痕迹 → 同上。
5. playwright.config.ts 登记：`DEBUG_AGENT_SPEC_FILES`、voice realtime 选择清单、单 spec 预算表（需覆盖 6 段语音 + 8s turn_unanswered 真等待）。
6. 连续跑两次，红绿集合相同。

## AC

- [ ] AC1（取假形态排最前）：去掉任一缺陷腿的 `test.fail()` 标注，该腿在当前代码上红，逐字失败行记入 Notes（证明标注不是空摆设）。
- [ ] AC2：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1` 退出 0（正向腿绿、缺陷腿按预期失败），连续两次结果一致；全程零云调用。
- [ ] AC3：剧本覆盖 seq0~seq5、seq1 空音频报错 + 模型自答 OK、seq2/seq4 晚到转写、S3 分支 A（永无转写）与分支 B（晚到转写）、seq4 模型未转发、~8s turn_unanswered、退出回填；每条缺陷腿注释写明修复任务 id。
- [ ] AC4：回归——`e2e/voice-realtime-scripted-scenarios.spec.ts`、`e2e/voice-realtime-live-session-send.spec.ts` 各单独运行退出 0（共享测试桩改动不红兄弟）。
- [ ] AC5：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

在任务工作树里实际运行回放两次，把每条用例的通过/预期失败列表、缺陷腿逐字失败行、运行时长写入 Notes；不改任何产品代码（`git diff --stat develop...HEAD` 只含测试、测试桩、playwright.config.ts 与本任务文件）。

## Touches

- e2e/voice-realtime-segmented-replay-20261012.spec.ts (new)
- e2e/voiceRealtimeScriptedUpstream.ts
- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts
- e2e/voice-realtime-scripted-scenarios.spec.ts（仅当 BUILDERS 钉子需同步）
- playwright.config.ts
- tasks/gap-live-voice-segmented-replay-20261012.md

## Notes

立项：Opus 常驻会话 2026-10-12，人 yale 授权（GOAL-043 / AC-352）。查重：无既有任务覆盖（grep tasks 的 turn_detection / activeSegmentSeq / buffer too small / not-relayed 无相关 open 任务）。协调：todo 的 `gap-live-voice-intent-control-browser-e2e`（AC-345）也会扩展 `e2e/voiceRealtimeScriptedUpstream.ts`，它依赖三项 A+ 任务、短期不开工；本任务先落地，后者合并 develop 时在本任务的回调/构造函数之上追加。

常驻会话曾在临时工作树起草同名 spec 并在当前代码上取证（工作树已删除，草稿保存为补丁，见下节），可作为参考；以本任务工作树的产物为准。

### 立案取证（2026-10-12，常驻会话临时工作树，当前代码 fce684d2，未提交）

草稿补丁：`/data/scratch/yale/voice-replay-20261012/scratch-replay-fce684d2.patch`（`git apply` 于 develop；含新 spec 768 行、scripted-upstream 新构造函数 `audioCommitted`/`userItemCreated`/`speechStarted`/`responseCreated`/`responseDone`、`modelTextReply` 可选 `responseId`、e2e 侧 `commitCount()`/`onClientFrame(listener)`、playwright.config.ts 三处登记，预算 360_000）。草稿尚未加 `test.fail()` 标注——本任务需按 Plan 4 标注并逐腿写修复任务 id。

命令：`env -u VOICE_REALTIME_MODE -u VOICE_REALTIME_CAPTURE -u VOICE_CAPTURE bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1`。两次运行均 exit 1、约 81 s、5 passed / 9 failed，9 条失败行除时间戳外逐字相同（确定性）。

正向腿（绿）：6 次提交、`ready{segmented-v1}`、上游拨号无 authorization 头、seq3 后出现 turn_unanswered；只有 S1、S5 到 Claude（sent 帧 + 真实行）；全程无 `voice-realtime-error`（UPSTREAM_ERROR、MODEL_TEXT_REPLY 均 recoverable 只进控制台）；字幕按 itemId 到达；分支 A 退出回填恰为 S2+S4。

缺陷腿（红，逐字首条失败）：
1. (a) → `gap-live-voice-manual-mode-session-update-keeps-vad-off`：`a session.update after segments started re-enabled the endpoint's detector: [{"tools":0,"turn_detection":null},{"tools":3,"turn_detection":{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}},…×4]`
2. (b) 变体 V → `gap-live-voice-caption-segment-attribution-by-item-id`：C 的空转写在 seq1 活跃时晚到 ⇒ journal `segment 1 dropped: the endpoint reported no words for it | … session_send {"message":"上面我们看见丢了一句话。"} | session_send not-delivered (empty-transcript)`；S5 真实转发被拒（Expected ["上面我们看见丢了一句话。"]，received []）。
3. (b) 变体 V segment_ack：`Received array: ["0:committed", "1:committed", "1:dropped:empty-transcript"]`。
4. (c) → `gap-live-voice-segment-honest-heard-unrecognized-state`：未转发的 S2、S4 与 S5 折成一行被标 delivering：`branch A @queuedS5: rows […{"testid":"voice-row-delivering","text":"现在是第二句话。第四句话。上面我们看见丢了一句话。"}]`
5. (c) 位置：S2+S4 折叠的 heard 行排在 S5 真实行之后（`placeCaptionsChronologically` 把字幕行放在最新真实行之下）。
6. (d) 分支 A 退出前无 C 段「未识别」标记：`no "not recognized" indication for segment C on the page`
7. (d) 用户退出无关闭痕迹：`after Exit the transcript ends with rows [...]` / `Received: null`
8. 分支 B 退出回填顺序：`draft was "现在是第二句话。第四句话。第三句话。"`
9. 分支 B 屏上顺序：`S3 after S4 inside "现在是第二句话。第四句话。第三句话。"`（Expected < 7 / Received 11）

在忠实回放（A、B）里 activeSegmentSeq 错归属无可见后果（晚到转写都有字）；只在「空转写晚到」变体 V 中致真实转发被拒——修复任务的判据应以 V 为主读数。假上游不响应 turn_detection，故 (a) 只能以线上帧读数断言，不能复现「缓冲为空」的下游效果。
