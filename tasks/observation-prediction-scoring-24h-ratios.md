---
id: observation-prediction-scoring-24h-ratios
title: 预测对账：观察墙上线前后各 24 小时的行为比例（预览/跳转、观察型切换占比、轮询类输入占比），按登记的预测判
  confirmed/refuted/insufficient-data
status: ready
labels:
  - cockpit
  - observation
  - metrics
parent: null
children: []
extra: {}
depends_on:
  - observation-p0-view-instrumentation-and-weekly-report
---
## Proposal

决策出处：用户 2026-10-24 确认的「预测登记」（quay `docs/references/注意力投放——把处理能力引导到我们关心的流形上.md` §5.5、§6）：对流形的理解是否为真，唯一检验是先登记预测、再对账。用户对第一条预测的修订：**数据类型不变，窗口缩短为 24 小时，度量用行为比例而不是数量**。

第一组预测（倡议 `cockpit-observation-wall` 的章程 `predictions[]`，阈值由用户确认后写入章程）：
- P1：观察墙上线后 24 小时 vs 上线前 24 小时——「驾驶舱预览 /（驾驶舱预览 + 为观察而跳进会话或 tab 的导航）」比例上升；「观察型切换 / 全部导航事件」比例下降。
- P2：同窗口——「查进展 / 是否可用 / 重启是否成功」类输入占人类输入的比例下降。

方案：
1. 在 `scripts/workload-report/` 增加 `predict.py`：
   - `--window-before <ISO起> <ISO止> --window-after <ISO起> <ISO止>`，默认以观察墙上线时刻（参数 `--pivot <ISO>`）前后各 24 小时；
   - 读取 T0 的查看事件 jsonl 与会话记录中的人类输入（沿用 T0 的分类规则与剔除自动会话的规则），计算 P1、P2 的各项**比例**及其样本量；
   - 读取一份预测登记（`--predictions <json>`，形如 `[{id, metric, direction, threshold}]`），逐条输出 confirmed / refuted / insufficient-data（样本量低于下限时，不判定）。
2. 输出 Markdown 与 JSON，JSON 供 fleet 倡议对账与 quay 前沿文档 §6 回填。
3. 分类规则的已知误差（人工一致率约 60%）写进输出的「局限」段；比例的前后对比用同一分类器，误差方向一致。

## AC

- [x] AC1: `python3 -I scripts/workload-report/predict.py --fixture scripts/workload-report/testdata --pivot 2026-10-20T00:00:00+08:00 --predictions scripts/workload-report/testdata/predictions.json --json /tmp/pred-test.json` exit 0；对夹具输出的每个比例与手算一致（脚本 `--self-check` 断言）。
- [x] AC2: 同一夹具——一条按设计应 confirmed、一条应 refuted、一条样本量不足应 insufficient-data，三者判定正确。
- [x] AC3: 输出包含窗口起止、各比例的分子 / 分母、分类器局限说明。

## DoD

- 观察墙上线后满 24 小时，跑一次真实对账，贴出 P1、P2 的比例与判定，并把结果回填 quay 前沿文档 §6 与倡议决策日志（经 fleet CLI）。

## Touches

- scripts/workload-report/predict.py
- scripts/workload-report/testdata/predictions.json
- scripts/workload-report/testdata/predict/predict-events.jsonl (new)
- scripts/workload-report/testdata/predict/predict-human-inputs.jsonl (new)
- scripts/workload-report/testdata/sample.jsonl
- scripts/workload-report/README.md
- tasks/observation-prediction-scoring-24h-ratios.md
