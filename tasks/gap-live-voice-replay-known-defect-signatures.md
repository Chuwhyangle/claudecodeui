---
id: gap-live-voice-replay-known-defect-signatures
title: 回放缺陷腿改为按特定错误签名判定（expectKnownDefect），去掉 test.fail()：任意其他失败或缺陷消失都红
status: ready
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

- [ ] AC1（取假形态排最前）：在 Notes 逐条记录三种假形态及逐字失败行：(i) 删掉录制里某分支的 journal ⇒ 对应缺陷腿红（`unexpected failure signature`）；(ii) 把某签名改成不匹配 ⇒ 红；(iii) 让 assertion 不失败 ⇒ 红（`defect no longer reproduces`）。
- [ ] AC2：spec 中 `test.fail(`/`fixme(`/`skip(` 为 0；每条仍存在的缺陷腿都经 `expectKnownDefect` 并注明 fixTask。
- [ ] AC3：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1` 退出 0，连续两次逐用例一致。
- [ ] AC4：`npm run typecheck`、`npm run lint` 退出 0；helper 文件名不被 playwright testMatch 当作 spec 收集。

## DoD

两次运行的逐用例列表（含每条缺陷腿实际匹配到的签名文本）写入 Notes；零云调用。

## Touches

- e2e/voiceRealtimeKnownDefect.ts (new)
- e2e/voice-realtime-segmented-replay-20261012.spec.ts
- tasks/gap-live-voice-replay-known-defect-signatures.md

## Notes

立项：Opus 常驻会话 2026-10-12，人 yale 授权（GOAL-043 / AC-357，建议 (3)）。回放 spec 的编辑按依赖串行：vad-off → 本任务 → 外连守卫 → 事件同步 → 协议状态机；修复任务 attribution / honest-state 排在其后翻腿。
