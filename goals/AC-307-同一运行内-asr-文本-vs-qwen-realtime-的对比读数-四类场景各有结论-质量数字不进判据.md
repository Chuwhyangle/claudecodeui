---
id: AC-307
title: 同一运行内 ASR→文本 vs Qwen Realtime 的对比读数：四类场景各有结论，质量数字不进判据
status: active
kind: criterion
goal: GOAL-029
criterion: node experiments/voice-realtime-ambiguity/run.mjs
expect: 同一次运行内跑两条臂（出货的 `dashscope-omni` 书面化路径 vs AC-305 的 bridge），报
  n，空读数不是绿；至少一条负对照能红；两条臂的语料来自同一个 run id（不跨运行）；记录
  `docs/experiments/<date>-voice-realtime-ambiguity.md` 对四类场景各给出明确结论（含
  world-model/状态查询类——若现有
  ASR→文本路径对该类完全没有能力回答，这本身也要如实记录，不是预设的失败）；记录自陈"质量数字不是判据"，脚本里不出现把这些数字当阈值使用的代码。取假形态：(1)
  `--corpus=empty` 必须红且判词指名空读数；(2) 负对照方向反转必须红；(3) 跨运行拼接数据必须红。
origin: docs/proposals/voice-native-control-plane.md §10.3/§10.6（Task 3
  的对比读数范围），对照先例 `gap-asr-omni-paired-quality-record` 的九条判据结构
activatedAt: 2026-10-08T17:21:05.842Z
statusLog:
  - at: 2026-10-08T17:21:05.842Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-08T17:21:05.842Z
---
