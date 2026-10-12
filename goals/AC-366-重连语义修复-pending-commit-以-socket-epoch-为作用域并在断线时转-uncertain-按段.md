---
id: AC-366
title: 重连语义修复：pending commit 以 socket epoch 为作用域并在断线时转
  uncertain、按段重放预算、成功打开后复位重连计数、ACK 分级
  written/committed/lost（不臆断毒载荷），D1/D2/D4/D5/D6 翻为直接断言
status: achieved
kind: criterion
goal: GOAL-043
criterion: 'for d in D1 D2 D3 D4 D5 D6; do grep -q "test(.$d "
  server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts
  || { echo "缺用例 $d（AC-365 未落地前本判据不得为绿）" >&2; exit 1; }; done; grep -q
  "expectKnownDefect"
  server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts
  || { echo "缺已知缺陷辅助引用" >&2; exit 1; }; if grep -n "fixTask:
  .gap-live-voice-reconnect-epoch-scoped-commit-pairing."
  server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts;
  then echo "仍有未翻转的已知缺陷腿" >&2; exit 1; fi; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts
  server/modules/voice-realtime/tests/voice-realtime-scripted-upstream-state.test.ts'
expect: 读数——(a) 断线时该 epoch 的未决 commit 全部移出配对队列并标 uncertain，新 epoch 的 committed
  只与本 epoch 配对（D2）；(b) 每段重放次数有显式预算（默认值须写明依据与可配置项，不以「毒载荷」为前提），预算耗尽或连接终止 ⇒ 该段处置
  lost(reason) 并下发浏览器帧，绝不记为 empty-transcript（D1）；(c)
  成功打开后重连计数复位，连续健康会话可承受多次独立断线（D4）；(d) 浏览器 ACK 分级：written（已写出）/ committed（上游
  committed 之后）/ lost（预算耗尽或连接已关闭），连接不在 open 时结束的段只得 lost（D5、D6）；(e)
  按段至多一次投递保持不变：已投递段的重放调用被丢弃（D3 仍绿），不自动补发；(f) connection-resilience 中指向本任务的
  expectKnownDefect 全部翻为直接断言。
origin: 人 yale 2026-10-13 授权按双断线分析方案推进（Opus 常驻会话；证据 journal
  ~/.cloudcli/voice-realtime-log/e22ac831-30c6-4600-8bcf-b5c3cc7e3a8c.jsonl：seq2
  断线重放后再断丢失、pendingCommitSeqs 跨 epoch 错配、openAttempts 不复位致第三次断线永久关闭、关闭后 seq7–12
  仍回 committed）。
activatedAt: 2026-10-12T16:43:09.210Z
statusLog:
  - at: 2026-10-12T16:43:09.210Z
    from: draft
    to: active
    actor: goal-cli
    reason: 双断线：任务同批建立（重试）
  - at: 2026-10-12T17:14:16.538Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-12T16:43:09.209Z
---
