---
id: AC-369
title: 真实上游大帧 vs 分块 append 探针：同一会话逐级加大单帧 append（2/5/8/12/15/20 s）并与 200 ms
  分块对照，给出断线与时长/字节的关系读数，验证或否证 RC-5，不预设毒载荷结论
status: active
kind: criterion
goal: GOAL-043
criterion: f=docs/operations/voice-realtime-large-append-probe.md; [ -f "$f" ]
  || { echo "缺报告：$f" >&2; exit 1; }; for k in "单帧梯度：" "分块对照：" "断线读数：" "结论："
  "运行次数：" "花费："; do grep -q "^$k" "$f" || { echo "缺读数行：$k" >&2; exit 1; }; done
expect: 读数——真实 qwen3.8-omni-flash-realtime、manual commit 模式，单帧 2/5/8/12/15/20
  s（PCM16 16 kHz 的字节数与 base64 字符数逐级记录）各至少 2 次，与等长 200 ms
  分块对照；记录每次是否断线、断线距写出的毫秒数、关闭码（若有）、是否收到 committed；结论只允许「证实 / 否证 /
  不足以判断」三选一并引用读数；每连接 VOICE_REALTIME_MAX_CNY_PER_CONNECTION
  上限，备用端口实例或实验脚本直连，dry-run 执行面，:3001 pid 前后相同；只跑一次。
origin: 人 yale 2026-10-13 授权按双断线分析方案推进（Opus 常驻会话；证据 journal
  ~/.cloudcli/voice-realtime-log/e22ac831-30c6-4600-8bcf-b5c3cc7e3a8c.jsonl：seq2
  断线重放后再断丢失、pendingCommitSeqs 跨 epoch 错配、openAttempts 不复位致第三次断线永久关闭、关闭后 seq7–12
  仍回 committed）。
activatedAt: 2026-10-12T16:46:43.809Z
statusLog:
  - at: 2026-10-12T16:46:43.809Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-12T16:46:43.808Z
---
