---
id: AC-365
title: 双断线本地确定性红先行：scripted upstream 故障注入 F1–F6 + node:test 已知缺陷签名，D1–D6
  在当前代码上以签名精确复现（只改测试）
status: active
kind: criterion
goal: GOAL-043
criterion: '[ -f
  server/modules/voice-realtime/tests/voice-realtime-known-defect.ts ] || { echo
  "缺判据文件：server/modules/voice-realtime/tests/voice-realtime-known-defect.ts"
  >&2; exit 1; }; for d in D1 D2 D3 D4 D5 D6; do grep -q "test(.$d "
  server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts
  || { echo "缺用例 $d" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-scripted-upstream-state.test.ts
  server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts'
expect: 读数——(a) scripted upstream 支持按拨号编排的故障计划（接受 / 拒绝 / 接受后断开）、由客户端事件触发断线（第 n 个
  commit、某 seq 重放后、事件后 X ms）、「已处理但事件丢失」（断线前已创建条目或已发 function_call 而事件未送达）、单帧
  append 超过阈值即断开、注入时钟，且 e2e 侧 voiceRealtimeScriptedUpstream 可读同一计划；各有自测；(b)
  node:test 已知缺陷辅助与 e2e/voiceRealtimeKnownDefect.ts
  语义一致：匹配签名才通过、其他失败红「unexpected failure signature」、断言通过红「defect no longer
  reproduces」，并有自测证明这三种分支；(c) connection-resilience 文件新增 D1–D6，按 journal
  e22ac831 的事件序列（seq0..5 + 变体 V-fatal / V-delivered / V-poison）用真实 bridge +
  proxy 回放：D1 seq2 两次断线后的处置不是 empty-transcript；D2 断线后 item→seq 不跨 epoch 错配；D3
  已投递后重放不产生第二次 session_send（当前即应为绿，直接断言）；D4 成功重连后重连计数复位；D5 永久断开后结束的段不得收到
  committed；D6 segment_ack committed 只在上游 committed 之后发出；当前代码上 D1/D2/D4/D5/D6
  以各自记录的首行失败签名精确复现（fixTask 指向修复任务），不得用 skip / todo / 宽泛签名；(d) 产品代码 diff 为空。
origin: 人 yale 2026-10-13 授权按双断线分析方案推进（Opus 常驻会话；证据 journal
  ~/.cloudcli/voice-realtime-log/e22ac831-30c6-4600-8bcf-b5c3cc7e3a8c.jsonl：seq2
  断线重放后再断丢失、pendingCommitSeqs 跨 epoch 错配、openAttempts 不复位致第三次断线永久关闭、关闭后 seq7–12
  仍回 committed）。
activatedAt: 2026-10-12T16:40:48.493Z
statusLog:
  - at: 2026-10-12T16:40:48.493Z
    from: draft
    to: active
    actor: goal-cli
    reason: 双断线：任务同批建立（重试）
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-12T16:40:48.492Z
---
