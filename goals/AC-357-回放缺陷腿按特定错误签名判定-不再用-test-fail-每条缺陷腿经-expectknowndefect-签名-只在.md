---
id: AC-357
title: 回放缺陷腿按特定错误签名判定：不再用 test.fail()，每条缺陷腿经 expectKnownDefect(签名)
  只在「断言以预期签名失败」时通过，任意其他失败或缺陷消失都红
status: active
kind: criterion
goal: GOAL-043
criterion: f=e2e/voice-realtime-segmented-replay-20261012.spec.ts; [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; f=e2e/voiceRealtimeKnownDefect.ts; [ -f
  "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; if grep -nE
  "test\.(fail|fixme|skip)\("
  e2e/voice-realtime-segmented-replay-20261012.spec.ts >&2; then echo "回放仍用
  test.fail/fixme/skip：e2e/voice-realtime-segmented-replay-20261012.spec.ts"
  >&2; exit 1; fi; DASHSCOPE_API_KEY= npx playwright test
  e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1
expect: 单文件 playwright 退出 0；spec 中 test.fail/fixme/skip 为
  0；e2e/voiceRealtimeKnownDefect.ts 导出 expectKnownDefect(signature,
  assertion)：assertion 以匹配 signature（正则/逐字前缀，取自当前代码上的逐字首条失败行）的错误失败 ⇒ 通过；以其他错误失败
  ⇒ 红并打印「unexpected failure signature」与实际消息；不失败 ⇒ 红并打印「defect no longer
  reproduces — flip this leg」。取假形态（在任务 Notes 逐条记录）：(i) 篡改录制使某缺陷腿因数据缺失而失败 ⇒
  该腿红；(ii) 把某签名改成不匹配 ⇒ 红；(iii) 让某缺陷不再出现 ⇒ 红。
origin: 人 yale 2026-10-12 授权按建议推进「可控、完全本地、不依赖外部 Realtime/Claude 服务的 Live Voice
  验证能力」（Opus 常驻会话只读审查 gap-live-voice-segmented-replay-20261012 落地产物后的建议
  (3)(4)(5)(6)）。
activatedAt: 2026-10-12T09:08:03.396Z
statusLog:
  - at: 2026-10-12T09:08:03.396Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-12T09:08:03.396Z
---
