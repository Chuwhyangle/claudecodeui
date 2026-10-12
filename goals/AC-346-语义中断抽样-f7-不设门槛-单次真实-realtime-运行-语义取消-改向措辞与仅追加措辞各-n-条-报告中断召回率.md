---
id: AC-346
title: 语义中断抽样（F7，不设门槛）：单次真实 Realtime 运行，语义取消/改向措辞与仅追加措辞各 N 条，报告中断召回率、精确率与花费
status: draft
kind: criterion
goal: GOAL-041
criterion: f=docs/operations/voice-realtime-interrupt-sampling.md; [ -f "$f" ]
  || { echo "缺报告：$f" >&2; exit 1; }; grep -q "^召回率：" "$f" && grep -q "^精确率："
  "$f" && grep -q "^花费：" "$f" && grep -q "^样本：" "$f"
expect: 读数——报告含样本清单（至少各 10 条，含 2026-10-12
  原句「你应当能够更主动地去取消已经在执行的这些动作，以更快地推进后面的操作」）、每条的 journal 证据（是否调用 session_interrupt
  及 intent）、召回率、精确率、花费（CNY，设 VOICE_REALTIME_MAX_CNY_PER_CONNECTION
  上限）；只跑一次付费运行，其余用录制回放。该 AC 只要求读数完整，不设召回/精确门槛（SPEC §18.7 F7）。
origin: 人 yale 2026-10-12 授权按 A+ 推荐落地（Opus 常驻架构会话）。证据：journal
  ~/.cloudcli/voice-realtime-log/99df08d8-….jsonl × Claude transcript
  c6493eb6（2026-10-12 01:24–01:31 UTC）；契约见
  docs/proposals/voice-realtime-persistent-control-SPEC.md §0.3 / §18。
---
