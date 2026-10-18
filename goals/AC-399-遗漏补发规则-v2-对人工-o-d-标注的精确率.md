---
id: AC-399
title: 遗漏补发规则 v2 对人工 O/D 标注的精确率
status: achieved
kind: criterion
goal: GOAL-046
criterion: python3 -I experiments/voice-relay-qb/replay_rule.py --check-labels
expect: 退出码 0。--check-labels 用 AC-398 的参数文件跑规则 v2，把补发列表按（连接前缀，识别文本）对到
  experiments/voice-relay-qb/labels.json 的人工 O/D 标注（标注集由 flagged-for-review.md 的
  64 条重新生成，不得手抄进脚本），断言：标注集上实际发生的补发 ≥ 15 条（防止空补发真空通过）；其中标 O 的占比 ≥ 80%；并打印被判 D
  的补发明细（含文本）。取假形态：把 SCORE_T 调到 1.1（全补）精确率必须掉到 80% 以下或补发数使断言红；调到
  0（全不补）补发数断言必须红。⚠️ 当前必红：--check-labels 不存在。
origin: 人 yale 2026-10-18 接受 80–87% 的自动补识别原文精确率。数据来自 flagged-for-review.md 的人工
  O/D 标注：≥7 字 80%，数字归一后 87%；v2 回放里把补发列表对标注的接线尚未做（此前 80–87% 是检测器评估而非回放读数）。
activatedAt: 2026-10-18T08:36:43.622Z
statusLog:
  - at: 2026-10-18T08:36:43.622Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-18T08:45:27.595Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-18T08:36:43.622Z
---
