---
id: gap-reply-suggestions-offline-benchmark-tool
title: 回复建议离线基准工具：模型×提示词×温度×思考矩阵、多评判、使用记录回放、盲标清单生成与打分
status: needs-human
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-reply-suggestions-backend-llm-service
---
## Proposal

「建议」按钮会成为改进重点，改进需要可重复的度量。本任务把此前一次性的实验脚本整理成入库的**离线基准工具** `experiments/reply-suggestions-bench/`（Python 标准库，沿用 `experiments/composer-input-suggestions/` 的风格），设计见 `docs/proposals/composer-reply-suggestions-llm.md` 的「评估与改进」一节。

**能力。**

- 从本机会话转写按「助手消息尾部 → 用户下一条回复」抽样（样本只在本机内存与 `tmp/` 临时目录，**不入库**）。
- 按矩阵（模型 × 提示词版本 × 温度 × 思考开关）直连网关生成 chip，两种协议都支持，参数读自 `config/reply-suggestions.settings.json`（只引用密钥文件，密钥只进子进程环境，绝不打印）。
- 至少两个评判模型各自判「同 / 近 / 异」，输出保守一致度（两评判都判同才算同）、逐 chip 与逐消息两级命中率，并分别报「同」与「同或近」。
- 回放：读后端的使用记录（展示、点选、清空、重抽、发送），算真实点选率、重抽率、点选后改动比例。
- 40 条盲标清单生成器（隐去哪个 chip 来自哪个配置）与打分器（读人工标注 `1同 2近 3异 …`，算评判与人工的一致度）。
- `selftest`：用本机回环的假 HTTP 服务跑通全流程，不依赖真实网关。

输出只含聚合指标与脱敏的编号样本；用户文本不得写入入库文件。

## AC

- [ ] 自检通过：`python3 -I experiments/reply-suggestions-bench/bench.py selftest` 退出码 0，覆盖：两种协议的生成、两个评判、矩阵汇总、回放、盲标清单生成与打分各一段，输出末行为 `selftest ok`。
- [ ] 保守一致度逐腿可测：`python3 -I experiments/reply-suggestions-bench/bench.py selftest --only agreement` 在给定的合成判决表上输出的「同」「同或近」两个数与表中手算值一致（脚本内置期望并断言）。
- [ ] 盲标往返：`python3 -I experiments/reply-suggestions-bench/bench.py selftest --only blind` 生成 40 条清单、隐去配置来源，再用合成答案打分，一致度与手算值一致，清单文件中不含任何配置名。
- [ ] 无用户文本与密钥入库：`git ls-files experiments/reply-suggestions-bench | xargs grep -nE "(sk-|Bearer [A-Za-z0-9]|FJDAC_API_KEY=)"` 无任何输出（退出码 1）；`git ls-files experiments/reply-suggestions-bench | grep -E "\.(jsonl|json)$"` 只允许出现 `fixtures/` 下的合成数据。
- [ ] 文档：`experiments/reply-suggestions-bench/README.md` 说明用法、矩阵配置格式、指标定义（含「保守一致度」与「逐 chip／逐消息」两级的区别）与局限（评判偏宽松、首抽指标依赖评判）；`grep -c "保守一致度" experiments/reply-suggestions-bench/README.md` ≥ 1。

## DoD

- [ ] 在真实网关上跑一次小矩阵（v4.1flash，思考开 / 关各一，温度 0.3，样本 ≥60 条，评判用 v4pro 与另一款非生成模型），贴出聚合表（逐 chip、逐消息、同与同或近、耗时中位数、输出 token 中位数），与提案文档里 211 条样本的读数对照并说明差异；全程不打印密钥，网关地址脱敏。
- [ ] 回放一次真实使用记录（后端任务落地后产生的本机记录；若尚无足够记录则注明条数并用合成记录演示格式），贴出点选率、重抽率、点选后改动比例。
- [ ] 贴出盲标清单的头 5 条（脱敏）与打分器对一份人工标注的输出（若 yale 尚未返还标注，用合成答案并注明；真实标注为可选的后续，**不阻塞本任务**）。
- [ ] 证伪：把保守一致度的实现改成「任一评判判同即同」，贴出 `selftest --only agreement` 变红的输出，再恢复并证明 `git diff` 为空。

## Touches

- `experiments/reply-suggestions-bench/bench.py`
- `experiments/reply-suggestions-bench/README.md`
- `experiments/reply-suggestions-bench/fixtures/synthetic-judgements.json`
- `tasks/gap-reply-suggestions-offline-benchmark-tool.md`

## Needs-Human

**执行 2026-10-24T06:30:21.250Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：unsatisfiableUnannotatedAc=[回放一次真实使用记录（后端任务落地后产生的本机记录；若尚无足够记录则注明条数并用合成记录演示格式），贴出点选率、重抽率、点选后改动比例。]（连续 3 轮被结构上不可派的拦截挡住 ⇒ 作者/人改写；⛔ 不派 fix worker）
