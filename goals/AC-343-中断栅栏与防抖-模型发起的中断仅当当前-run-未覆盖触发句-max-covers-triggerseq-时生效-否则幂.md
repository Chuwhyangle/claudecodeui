---
id: AC-343
title: 中断栅栏与防抖：模型发起的中断仅当当前 run 未覆盖触发句（max(covers) < triggerSeq）时生效，否则幂等返回
  covered；同一 triggerSeq 重复调用无第二条回执；UI 停止键不受栅栏约束
status: draft
kind: criterion
goal: GOAL-041
criterion: f=server/modules/voice-realtime/tests/voice-realtime-interrupt-fence.test.ts;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx tsx --tsconfig
  server/tsconfig.json --test "$f"
expect: 读数——(a) 同一句两次 session_interrupt ⇒ 一次 abort + 一次 {stopped:false,
  reason:'covered'}；(b) 修正已被当前 run 覆盖（由 lifecycle started 的
  commandUuid→utteranceSeq 得出）时中断为空操作；(c) UI 停止键在同一状态下仍 abort；(d) 每 run
  模型发起的有效中断 ≤1。取假形态——撤掉栅栏 ⇒ (a) 出现两次 abort。
origin: 人 yale 2026-10-12 授权按 A+ 推荐落地（Opus 常驻架构会话）。证据：journal
  ~/.cloudcli/voice-realtime-log/99df08d8-….jsonl × Claude transcript
  c6493eb6（2026-10-12 01:24–01:31 UTC）；契约见
  docs/proposals/voice-realtime-persistent-control-SPEC.md §0.3 / §18。
---
