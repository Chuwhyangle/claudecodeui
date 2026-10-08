---
id: AC-306
title: 四类歧义/world-model 场景的语料、标准答案与打分口径在取数前冻结
status: draft
kind: criterion
goal: GOAL-029
criterion: node experiments/voice-realtime-ambiguity/check-prereg.mjs
expect: "`experiments/voice-realtime-ambiguity/PREREG.md`
  存在，且对四类场景（同音实体歧义、自我更正、指代消解、world-model/状态查询）各自声明：语料条数（≥
  一个预先写定的最小值）、标准答案、打分口径、至少一条负对照（预测方向在取数前写死）。自检脚本验证：四类场景在 `fixtures/`
  下都有对应条目且数量达标；每类至少一条负对照；本任务不产生任何真实识别/推理读数（离线，零模型调用）。取假形态：(1) 删掉任一场景类别的语料 ⇒
  必须红并指名缺的类别；(2) 去掉某一类的负对照 ⇒ 必须红；(3) PREREG.md 的提交先于 fixtures 数据文件（由 Task 3
  取数时核对，本 AC 只保证本任务阶段没有数据文件先于 PREREG 存在）。"
origin: docs/proposals/voice-native-control-plane.md §10.3/§10.6（Task 2
  的预注册范围），延续 `experiments/voice-draft` 系列的 PREREG 纪律
---
