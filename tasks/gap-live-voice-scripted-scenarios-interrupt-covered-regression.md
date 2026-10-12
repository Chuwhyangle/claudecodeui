---
id: gap-live-voice-scripted-scenarios-interrupt-covered-regression
title: 既有回归：voice-realtime-scripted-scenarios.spec.ts:673 的 scripted interrupt
  用例被 A+ 中断栅栏判为 covered 而等不到 stopped 帧——按栅栏语义修正用例（先有新话语再中断），不改产品代码
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

### 问题（2026-10-12 实测）

`e2e/voice-realtime-scripted-scenarios.spec.ts` 的 `a scripted interrupt reaches the session and the page reports the backlog it left`（约 :673）在干净 develop 上确定性红（3/3）：`voice-realtime-stopped` 20 s 内未出现。证据：`gap-live-voice-segmented-replay-20261012` Notes 的 AC4 段（worker 以 `git stash -u` 回到干净树复现）。

原因：A+ 栅栏（`gap-live-voice-interrupt-run-utterance-fence`，AC-343，已 done）落地后，`voice-realtime-ws-proxy.service.ts` 的 `decideModelInterrupt`（约 :699）在 `max(covers) >= triggerSeq` 或同一 triggerSeq 已执行时返回 `covered`，不发 `stopped` 帧。该用例只发了 `session_send('start the held turn')` 再直接 `session_interrupt`，中间没有任何新的用户话语（无 `transcription.completed`），触发句就是当前 run 已覆盖的那句 ⇒ 被正确判为 covered。用例的前提（「模型无新话语也会中断」）已被 D-7 栅栏语义推翻。

该 spec 被多处回归点名（`gap-live-voice-intent-control-browser-e2e` AC4、`gap-live-voice-segment-honest-heard-unrecognized-state` AC8、`gap-live-voice-segmented-replay-closure` AC5），不修会一直挡住它们。

### 要做的事

- 按栅栏语义修正用例：在 `session_interrupt` 前由假上游发一条新的最终转写（新 itemId，模拟用户说出「停下/改方向」的话语），使 `triggerSeq` 大于当前 run 的 covers，再断言 `stopped` 帧与 tool output。
- 另加一个用例钉住栅栏的负面：无新话语的重复中断 ⇒ 无 `stopped` 帧、tool output 为 `{stopped:false, reason:'covered'}`。

### SCOPE BOUNDARY

- ⛔ 不改产品代码（`voice-realtime-ws-proxy.service.ts` 归 GOAL-041 A+ 任务）；⛔ 不放宽栅栏。
- 不改共享测试桩（`e2e/voiceRealtimeScriptedUpstream.ts`、`voice-realtime-scripted-upstream.ts`），只改本 spec。

## Plan

1. 本地复现红；2. 修正用例；3. 加 covered 负面用例；4. 单跑 spec 两次。

## AC

- [ ] AC1（取假形态排最前）：去掉新增的那条转写 ⇒ 修正后的用例红（逐字失败行记入 Notes），证明它依赖栅栏放行条件。
- [ ] AC2：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-scripted-scenarios.spec.ts --workers=1` 退出 0，连续两次一致。
- [ ] AC3：covered 负面用例：无新话语的中断 ⇒ 无 `voice-realtime-stopped`，tool output 含 `covered`。
- [ ] AC4：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

在任务工作树里修复前后各跑一次该 spec，逐用例结果与失败行写入 Notes；零云调用。

## Touches

- e2e/voice-realtime-scripted-scenarios.spec.ts
- tasks/gap-live-voice-scripted-scenarios-interrupt-covered-regression.md

## Notes

立项：Opus 常驻会话 2026-10-12，人 yale 授权（建议 (2)，独立最小回归修复）。纯修复，不挂 goal_ac。查重：无既有 open 任务认领该红。Touches 与在途 A+ 任务（服务端文件）及 `intent-control-browser-e2e`（新 spec + 共享测试桩）不相交。
