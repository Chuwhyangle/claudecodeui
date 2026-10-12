---
id: AC-362
title: 连续模式真实校准 C-1/C-2/C-4/C-5 单次运行：semantic_vad 行为、silence_duration
  取舍、静音是否计费、模型可等待转发，并给出成本基线读数（C-3/C-6 已移入 AC-363）
status: achieved
kind: criterion
goal: GOAL-044
criterion: f=docs/operations/voice-realtime-continuous-calibration.md; [ -f "$f"
  ] || { echo "缺报告：$f" >&2; exit 1; }; for k in "C-1 semantic_vad：" "C-2
  silence_duration：" "C-4 静音计费：" "C-5 模型等待：" "成本基线：" "运行次数：" "花费："; do grep -q
  "^$k" "$f" || { echo "缺读数行：$k" >&2; exit 1; }; done
expect: 读数——报告逐项给出 C-1、C-2、C-4、C-5 的原始读数（journal 连接 id、usage 行 text/audio
  token、事件时间线摘录）与结论行（C-3 丢静音致盲、C-6 静音尾已移入 AC-363）；成本基线含 response 数、有效投递率、每
  response text/audio 输入 token、¥/小时（说话场景与挂机场景，外推须标明）；只跑一次付费运行（每条连接设
  VOICE_REALTIME_MAX_CNY_PER_CONNECTION 上限，备用端口实例，dry-run 执行面，:3001 pid
  前后相同）；不设通过门槛，只要求读数完整。
origin: 人 yale 2026-10-12 调整 Live Voice 优先级：体验优先、模型决定何时输出、VAD
  只服务传输与成本、成本为第二阶段（Opus 常驻会话；决策文档
  docs/proposals/live-voice-experience-first-decision-2026-10.md，提交 038730f0）。
activatedAt: 2026-10-12T12:29:30.572Z
statusLog:
  - at: 2026-10-12T12:29:30.572Z
    from: draft
    to: active
    actor: goal-cli
    reason: GOAL-044 立项：任务同批建立
  - at: 2026-10-12T13:15:53.946Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-12T12:29:30.572Z
---
