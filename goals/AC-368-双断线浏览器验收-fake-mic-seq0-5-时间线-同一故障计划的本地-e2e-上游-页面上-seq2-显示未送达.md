---
id: AC-368
title: 双断线浏览器验收：fake mic seq0..5 时间线 + 同一故障计划的本地 e2e 上游，页面上 seq2 显示未送达、seq3–5
  归属与顺序正确、永久断开后有可见断开状态，零外联
status: draft
kind: criterion
goal: GOAL-043
criterion: f=e2e/voice-realtime-double-drop.spec.ts; [ -f "$f" ] || { echo
  "缺判据文件：$f" >&2; exit 1; }; npx playwright test "$f"
expect: 读数——单 spec 退出 0；复用 AC-365 的故障计划（e2e 侧读同一计划）与 AC-360 外联守卫；断言页面：seq2
  显示未送达、seq3/seq4/seq5 字幕各自归属并按说话顺序、V-fatal 变体下连接终止后说的话标为未发送且状态栏显示断开、投递条数与
  at-most-once 一致；单次运行 < 100 s。
origin: 人 yale 2026-10-13 授权按双断线分析方案推进（Opus 常驻会话；证据 journal
  ~/.cloudcli/voice-realtime-log/e22ac831-30c6-4600-8bcf-b5c3cc7e3a8c.jsonl：seq2
  断线重放后再断丢失、pendingCommitSeqs 跨 epoch 错配、openAttempts 不复位致第三次断线永久关闭、关闭后 seq7–12
  仍回 committed）。
---
