---
id: AC-372
title: Continuous 小额真实校准 R-1..R-3：持续上传含长静音 10–15 min 的连接存活与零计费、30–60 s 连续口述在
  server_vad 800 与 semantic_vad 下的条目/碎片/延迟/转写完整性、执行中补充与改方向的模型决策分布
status: draft
kind: criterion
goal: GOAL-044
criterion: f=docs/operations/voice-realtime-continuous-keepalive-calibration.md;
  [ -f "$f" ] || { echo "缺报告：$f" >&2; exit 1; }; for k in "R-1 存活：" "R-1 计费："
  "R-2 条目：" "R-2 延迟：" "R-2 转写：" "R-3 决策：" "运行次数：" "花费："; do grep -q "^$k" "$f"
  || { echo "缺读数行：$k" >&2; exit 1; }; done
expect: 读数——R-1 continuous 持续上传 PCM（含 ≥10 min 静音）连接是否存活（对照 AC-363 V-2 停传约 300 s
  被 1007 关闭）、该期间 response 数与 audio/text token；R-2 两臂（server_vad silence 800 /
  semantic_vad）对同一 30–60 s 口述的条目数、碎片、说完→response 延迟分布、转写与原稿差异；R-3 在带 RunDigest
  草案指令的实验脚本下，补充/细化/改方向/取消四类语料的模型决策分布（只报读数）；每连接
  VOICE_REALTIME_MAX_CNY_PER_CONNECTION 上限、总上限 ¥1.5、备用端口或脚本直连、dry-run 执行面、:3001
  pid 前后相同、只跑一次。
origin: 人 yale 2026-10-13 裁定：Live Voice 体验优先，禁用浏览器 VAD 分段与中继静音门控，改 continuous
  传输并保留上游 server_vad 作评估触发；模型随意图完整反复评估在执行的 CLI 工作（继续/修改/取消/无需动作）。决策文档
  docs/proposals/live-voice-experience-first-decision-2026-10.md §11–§12（提交
  31d1b8b2）。
---
