---
id: gap-live-voice-replay-known-defect-signatures
title: 回放缺陷腿改为按特定错误签名判定（expectKnownDefect），去掉 test.fail()：任意其他失败或缺陷消失都红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-manual-mode-session-update-keeps-vad-off
goal_ac: AC-357
---
## Proposal

### 问题

`e2e/voice-realtime-segmented-replay-20261012.spec.ts`（`gap-live-voice-segmented-replay-20261012`，done）的 9 条缺陷腿用 `test.fail()` 标注。Playwright 对 `test.fail` 腿的语义是「任何失败都算预期」：断言写错、录制缺字段、beforeAll 中途某分支数据缺失，都会被计为通过。5 条正向腿只能挡住整体崩溃，挡不住单腿因错误原因失败——缺陷腿可能伪通过。

### 要做的事

- 新增 `e2e/voiceRealtimeKnownDefect.ts`：`expectKnownDefect(signature, assertion, { fixTask })`——
  - assertion 以匹配 signature 的错误失败 ⇒ 通过（并在报告附注 fixTask）；
  - 以其他错误失败 ⇒ 红，打印 `unexpected failure signature` 与实际消息；
  - 不失败 ⇒ 红，打印 `defect no longer reproduces — flip this leg (<fixTask>)`。
- 缺陷腿改为普通 `test(...)` 内调用 `expectKnownDefect`；签名取自 Notes 记录的当前代码逐字首条失败行（稳定前缀或正则，去掉时间戳/端口等易变部分）。
- 去尽 `test.fail()`。已被修复任务翻绿的腿（如 vad-off 的 (a)）保持普通断言。
- 修复任务的约定改为：修复后把 `expectKnownDefect(...)` 换成直接断言（AC-356 判据同时禁止 `test.fail(` 与 `expectKnownDefect(`）。

### SCOPE BOUNDARY

- ⛔ 不改产品代码；不改断言所表达的期望行为（只改判定方式）。
- 依赖 `gap-live-voice-manual-mode-session-update-keeps-vad-off` 先落地，避免同时改本 spec。

## Plan

1. helper + 自测（取假形态三种）；2. 改写缺陷腿；3. 单跑 spec 两次；4. 取假形态记录；typecheck/lint。

## AC

- [x] AC1（取假形态排最前）：在 Notes 逐条记录三种假形态及逐字失败行：(i) 删掉录制里某分支的 journal ⇒ 对应缺陷腿红（`unexpected failure signature`）；(ii) 把某签名改成不匹配 ⇒ 红；(iii) 让 assertion 不失败 ⇒ 红（`defect no longer reproduces`）。
- [x] AC2：spec 中 `test.fail(`/`fixme(`/`skip(` 为 0；每条仍存在的缺陷腿都经 `expectKnownDefect` 并注明 fixTask。
- [x] AC3：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1` 退出 0，连续两次逐用例一致。
- [x] AC4：`npm run typecheck`、`npm run lint` 退出 0；helper 文件名不被 playwright testMatch 当作 spec 收集。

## DoD

两次运行的逐用例列表（含每条缺陷腿实际匹配到的签名文本）写入 Notes；零云调用。

## Touches

- e2e/voiceRealtimeKnownDefect.ts (new)
- e2e/voice-realtime-segmented-replay-20261012.spec.ts
- tasks/gap-live-voice-replay-known-defect-signatures.md

## Notes

立项：Opus 常驻会话 2026-10-12，人 yale 授权（GOAL-043 / AC-357，建议 (3)）。回放 spec 的编辑按依赖串行：vad-off → 本任务 → 外连守卫 → 事件同步 → 协议状态机；修复任务 attribution / honest-state 排在其后翻腿。

### 落地（2026-10-12，worker）

- 新增 `e2e/voiceRealtimeKnownDefect.ts`：`expectKnownDefect(signature: string | RegExp, assertion: () => void, { fixTask })`。字符串按字面包含（取稳定前缀），正则用于跨易变部分。匹配 ⇒ 通过并把 fixTask 与实际匹配到的首行写进 `[known-defect]` 注记；其他失败 ⇒ 红 `unexpected failure signature` + 实际消息；不失败 ⇒ 红 `defect no longer reproduces — flip this leg (<fixTask>)`。文件名不含 `.spec.`/`.test.`，不进 testMatch。
- 实际有 **8** 条缺陷腿（非立项时记的 9；vad-off 的 (a) 腿在 `gap-live-voice-manual-mode-session-update-keeps-vad-off` 落地后已翻绿，保持直接断言）。8 条全部由 `test.fail` 改为普通 `test` 包 `expectKnownDefect`，各注明 fixTask。spec 中 `test.fail(`/`fixme(`/`skip(` 计数 0。

### 取假形态（三种；每条均为「临时篡改源码 → 单跑 spec → 取逐字输出 → 还原」）

(i) 删掉录制里的 journal（临时把 `replay()` 返回的 `journal` 置 `[]`）⇒ V 腿红：
```
Error: unexpected failure signature
  expected signature: /journal:.*hello: declaring segmented-v1/
  fix task:           gap-live-voice-caption-segment-attribution-by-item-id
  actual failure:
journal: 
```
(ii) 把 branch B draft 腿的签名改成不匹配（临时 `FALSIFIED-NON-MATCHING-SIGNATURE `）⇒ 红：
```
Error: unexpected failure signature
  expected signature: "FALSIFIED-NON-MATCHING-SIGNATURE "
  fix task:           gap-live-voice-segment-honest-heard-unrecognized-state
  actual failure:
draft was "现在是第二句话。第四句话。第三句话。"
```
(iii) 让 (c)「not recognized」腿的 assertion 不失败（临时空 body）⇒ 红：
```
Error: defect no longer reproduces — flip this leg (gap-live-voice-segment-honest-heard-unrecognized-state). The assertion passed, so "no \"not recognized\" indication for segment C on the page" was not observed.
```
三次取假运行均 exit 1（i/ii 各 1 failed + 12 passed；iii 1 failed + 13 passed），落盘后已还原，非本次绿跑。

### DoD — 两次连续绿跑（AC3）

命令：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1`
- run a：exit 0，`14 passed (1.3m)`；run b：exit 0，`14 passed (1.3m)`。两跑逐用例（14/14，顺序与状态）**逐条一致**。
- 合并 `develop` 后同一命令再跑：exit 0，`14 passed`。
- 零云调用：脚本上游 + `envFreeServerRoot`（无 `.env`）使空 `DASHSCOPE_API_KEY` 不被回填；复用既有正/负向腿的同一读数。
- 两跑 `[known-defect]` 注记一致（仅 journal 腿的 `at=<ts>` 变动，因而是正则签名）。

逐用例（两跑一致，14/14 ✓）：
```
1  the replay ran segmented, on the local scripted upstream, with no cloud credential
2  only S1 and S5 reach Claude, in both branches
3  no red error UI for the recoverable UPSTREAM_ERROR and MODEL_TEXT_REPLY; both reach the console
4  captions reach the browser keyed by the upstream itemId
5  branch A: Exit back-fills the composer with exactly the unrelayed transcripts, in spoken order
6  (a) every session.update after segments started keeps turn_detection null (manual mode)
7  unrelayed transcripts are never shown as delivering while S5 is in flight
8  unrelayed transcripts stay visibly heard after S5 is delivered, each at its spoken position
9  (c) branch A: the segment C that never got a transcript is visibly marked before Exit
10 (c) branch A: leaving with an unrecognized segment leaves an exit trace
11 (d) branch B: Exit back-fills S2, S3, S4 in SPOKEN order, not arrival order
12 (d) branch B: the late S3 transcript sits at its spoken position (before S4) on screen
13 (b) variant V: a late EMPTY transcript for item C does not refuse the active segment's S5 relay
14 (b) variant V: the segment that carried words is not acked dropped/empty-transcript
```
各缺陷腿实际匹配到的签名文本（run a 逐字）：
```
7  [gap-live-voice-segment-honest-heard-unrecognized-state] "branch A @queuedS5: rows " :: branch A @queuedS5: rows [{"style":"user","testid":null,"text":"seeded turn for Voice replay 20261012 branch A"},{"style":"user","testid":null,"text":"这是一轮新的 live voice mode 测试。"},{"style":"user","testid":"voice-row-delivering","text":"现在是第二句话。第四句话。上面我们看见丢了一句话。"}]
8  [gap-live-voice-segment-honest-heard-unrecognized-state] "row indices of S1,S2,S4,S5 in " :: row indices of S1,S2,S4,S5 in [{"style":"user","testid":null,"text":"seeded turn for Voice replay 20261012 branch A"},{"style":"user","testid":null,"text":"这是一轮新的 live voice mode 测试。"},{"style":"user","testid":null,"text":"上面我们看见丢了一句话。"},{"style":"user","testid":"voice-row-heard","text":"现在是第二句话。第四句话。"}]
9  [gap-live-voice-segment-honest-heard-unrecognized-state] "no \"not recognized\" indication for segment C on the page" :: no "not recognized" indication for segment C on the page
10 [gap-live-voice-segment-honest-heard-unrecognized-state] "after Exit the transcript ends with rows " :: after Exit the transcript ends with rows [{"style":"user","testid":null,"text":"seeded turn for Voice replay 20261012 branch A"},{"style":"user","testid":null,"text":"这是一轮新的 live voice mode 测试。"},{"style":"user","testid":null,"text":"上面我们看见丢了一句话。"}]
11 [gap-live-voice-segment-honest-heard-unrecognized-state] "draft was " :: draft was "现在是第二句话。第四句话。第三句话。"
12 [gap-live-voice-segment-honest-heard-unrecognized-state] "S3 after S4 inside " :: S3 after S4 inside "现在是第二句话。第四句话。第三句话。"
13 [gap-live-voice-caption-segment-attribution-by-item-id] /journal:.*hello: declaring segmented-v1/ :: journal:  | hello: declaring segmented-v1 | segment seq=0 dur=1300ms reason=gap frames=1 at=2026-10-12T11:02:25.160Z | to-browser segment_ack | segment seq=1 dur=1900ms reason=gap frames=1 at=2026-10-12T11:02:26.188Z | to-browser segment_ack | segment 1 dropped: the endpoint reported no words for it | to-browser segment_ack | << function_call session_send {"message":"上面我们看见丢了一句话。"} | session_send not-delivered (empty-transcript)
14 [gap-live-voice-caption-segment-attribution-by-item-id] "segment_ack frames" :: segment_ack frames
```

AC4：`npm run typecheck` exit 0；`npm run lint` exit 0（仅仓库既存 warning）；`npx playwright test --list` 中 `voiceRealtimeKnownDefect` 命中 0、回放 spec 命中 14。