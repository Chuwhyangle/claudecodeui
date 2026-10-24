# reply-suggestions-bench — 回复建议离线基准

输入框「建议」按钮的模型 chip 需要一个可复跑的度量。本工具只用 Python 标准库，按
「助手消息尾部 → 用户下一条真实回复」从本机会话转写抽样，对
**模型 × 提示词版本 × 温度 × 思考开关** 的矩阵生成 chip，再由至少两个评判模型逐条判
「同 / 近 / 异」，输出保守口径与逐评判口径的命中率；另带使用记录回放、盲标清单生成与打分。

设计来源：`docs/proposals/composer-reply-suggestions-llm.md` 的「评估与改进」一节。
后端产出的本机使用记录格式见 `server/modules/reply-suggestions/reply-suggestions-usage-log.ts`。

## 不写入仓库的内容

- 样本、生成结果、清单、标注都只落在调用方指定的 `tmp/`（本仓库已忽略）或临时目录；**不入库**。
- 密钥只在解析后放进本次 HTTP 请求：`apiKeyFile` 指向密钥文件，`apiKeyVar` 选择变量；全程不打印、
  不写日志、不写入任何输出文件。网关地址在需要出示时由调用方自行脱敏。
- 入库文件只有 `bench.py`、本 README 和 `fixtures/synthetic-judgements.json`（纯合成判决表，
  不含任何用户文本或模型输出）。

## 快速开始

```bash
# 1) 自检：本机回环假网关，不依赖真实网关
python3 -I experiments/reply-suggestions-bench/bench.py selftest
python3 -I experiments/reply-suggestions-bench/bench.py selftest --only agreement
python3 -I experiments/reply-suggestions-bench/bench.py selftest --only blind
python3 -I experiments/reply-suggestions-bench/bench.py selftest --only replay

# 2) 抽样（默认最近 30 天，最多 60 条；样本只写到 tmp/）
python3 -I experiments/reply-suggestions-bench/bench.py sample \
  --out tmp/samples.jsonl --limit 60 --days 60 --entrypoints cli,sdk-cli

# 3) 跑矩阵（需要本机 settings 文件，格式同后端）
python3 -I experiments/reply-suggestions-bench/bench.py run \
  --samples tmp/samples.jsonl --matrix tmp/matrix.json \
  --settings config/reply-suggestions.settings.json --out tmp/results.json --concurrency 5

# 4) 回放后端使用记录
python3 -I experiments/reply-suggestions-bench/bench.py replay \
  --ledger ~/.cloudcli/reply-suggestions-usage.jsonl --out tmp/replay.json

# 5) 从评判分歧生成盲标清单，再用人工标注打分
python3 -I experiments/reply-suggestions-bench/bench.py blind \
  --results tmp/results.json --out tmp/blind.jsonl --limit 40
python3 -I experiments/reply-suggestions-bench/bench.py score \
  --manifest tmp/blind.jsonl --key tmp/blind.jsonl-key.jsonl \
  --annotations tmp/annotations.txt
```

`settings` 文件与后端共用模板 `config/reply-suggestions.settings.example.json`；至少要有
`baseUrl`、`model`、`apiKeyFile`（可加 `apiKeyVar`）。矩阵里的每一项可以覆盖
`protocol`、`baseUrl`、`authScheme`、`temperature`、`disableThinking`、`maxOutputTokens`、
`timeoutMs`、`maxChips`、`maxChipChars`，未写的键从 settings 继承。

## 矩阵配置格式

```json
{
  "generation": [
    { "label": "flash-think-off", "protocol": "anthropic", "model": "v4.1flash",
      "temperature": 0.3, "disableThinking": true,  "maxOutputTokens": 400 },
    { "label": "flash-think-on",  "protocol": "anthropic", "model": "v4.1flash",
      "temperature": 0.3, "disableThinking": false, "maxOutputTokens": 400 }
  ],
  "judges": [
    { "label": "judge-a", "protocol": "anthropic", "model": "v4pro",
      "temperature": 0.0, "disableThinking": true,  "maxOutputTokens": 400 },
    { "label": "judge-b", "protocol": "anthropic", "model": "qwen3.8-max",
      "temperature": 0.0, "disableThinking": true,  "maxOutputTokens": 400 }
  ]
}
```

- `generation` 的每一项是一个被测配置；`label` 唯一，进入聚合表。
- `judges` 至少两项。评判协议同样支持 `anthropic` 与 `openai` 两种。
- 两种协议都发送 `thinking: {"type": "disabled"}`（当 `disableThinking` 为真）；温度、`max_tokens`
  原样透传。
- 生成失败（解析不出的 JSON）会**重抽一次**再记错误；评判失败只记类别（如 `http-429`），
  不会把上游响应体或密钥写进结果文件。

## 指标定义

每条样本有一个真实用户回复（`actual`）和某个配置生成的若干 chip。每个评判对每条 chip 给出
`same`（同，可原样发送且效果相同）、`near`（近，只需小幅修改）、`different`（异）。

- **逐 chip 命中率**：分母是全部生成的 chip。衡量「一条 chip 有多大机会直接被采用」。
- **逐消息命中率**：分母是全部消息；一条消息只要**至少一条** chip 命中就算命中。衡量
  「一次抽 3 条里有没有可用的一条」，更接近用户先看一轮的体验。
- **同**：chip 本身即可原样发送。
- **同或近**：同或只需小幅修改即可发送；更接近「省掉大部分输入」的价值。
- **保守一致度**：一条 chip 只有**所有评判都判为命中**才算命中（本工具要求至少两个评判）。
  头条数字用这个口径，避免单个宽松评判抬高读数。
- **逐评判口径**：各评判单独的同 / 同或近，给出区间上下限；评判之间差异大时说明该头条数字
  对评判敏感。
- **宽松口径**（`lenient`）：任一评判判同即算命中。**只用于对照与证伪**：它系统性高于保守口径，
  不能当作效果读数。

聚合表还报告：消息数、chip 数、生成错误数、生成耗时中位数、输出 token 中位数。

### 回放指标

读后端 JSONL 使用记录（`shown` / `picked` / `cleared` / `redrawn` / `sent`），按
`(sessionId, draw)` 归并：

- **批次只数真实调用**：`shown` 行带 `served` 字段（`"upstream"` 或 `"cache"`）。服务端命中缓存
  时也会写一条 `shown`，但 `draw` 与 chip 与首次真实调用相同；回放只按 `served` 不是 `"cache"`
  的行建立批次，否则同一批会被重复计数、点选率的分母被抬高。**没有 `served` 字段的旧记录一律
  按真实调用计。**
- **缓存命中次数 / 真实调用次数**：报告单列 `缓存命中次数(cache_hits)` 与
  `真实调用次数(upstream_calls)`；前者是免费展示，后者才是花掉模型调用的次数。
- **真实点选率**：有点选事件的展示次数 / 有 chip 的真实展示次数。
- **重抽率**：有重抽事件的展示次数 / 有 chip 的真实展示次数。
- **点选后改动比例**：点选并发送的展示里，最终发送文本与点选 chip 归一化后不相等 / 可比对数。
  发送文本从会话转写按时间还原；还原不到的对数计入 `unresolved`，不进入分母。

### 盲标清单与打分

`blind` 只从**评判之间有分歧**的 chip 里抽（默认最多 40 条），并写两个文件：

- `--out`：给人看的清单，每行只有编号、真实回复、chip；**不含配置名、模型名或评判判决**。
- `--key`：内部对照表（编号 → 配置、消息、各评判判决），只用于打分，同样不打印到终端。

`score` 读人工标注（JSONL `{id, verdict}`，或文本 `1同 2近 3异 …`，也接受按清单顺序的
`1/2/3` 序列），按评判分别给出与人工的精确一致率（`exact`）和「同或近」二分一致率
（`sameOrNear`）。

## 抽样口径

- 来源：`~/.claude/projects/*/*.jsonl` 会话转写；按文件修改时间过滤 `--days`。
- 配对：最后一条有文本的助手消息 → 下一条可用的用户消息。
- `--max-gap-seconds`（默认 600）：用户回复距助手消息太久时丢弃该对，避免把「隔了很久的新指令」
  当成对上一轮的回复。
- 排除机器回合：`--entrypoints cli,sdk-cli` 只保留交互式会话，滤掉 worker/driver 写在
  “user” 角色里的任务正文与通知；另外按前缀/标题/客户端包装标签过滤自动化提示词。
- 归一化去重：同一句真实回复在续接/并行会话里重复出现时只留第一次；最终按固定种子打乱后取
  `--limit` 条，样本集合可复现。

## 局限

- **评判是 LLM，未经人工校准。** 所有「同 / 同或近」读数只能当区间；评判偏严或偏松会整体平移
  头条数字。盲标清单与打分器就是为校准准备的，人工标注尚未返还时不应把评判口径当结论。
- **首抽指标依赖生成与评判两个模型**：换生成模型或换评判都会改变读数，跨报告的对比必须固定
  两者并注明。
- **样本构成影响很大**：交互式会话、gap 过滤、去重都会改变分母；与历史读数对比时要先对齐口径。
- **思考开关与 token 上限**：思考开启时思考 token 计入 `max_tokens`，在 400 这类贴近生产值的
  上限下会出现被截断的 JSON（计入生成错误），读数要连同错误数一起看。
- **近重复只按文本归一化**：不做语义去重；评判也看不到用户后续的澄清。
- **成本只报 token 数**：网关价格无法在本环境核实，不折算金额。

## 自检覆盖

`selftest` 用本机回环假 HTTP 服务跑通：两种协议的生成（含 `thinking` 开关与温度透传）、
两个评判、矩阵聚合、使用记录回放（含 `served: "cache"` 行不重复计批次、旧记录按真实调用计）、
盲标清单生成（40 条、隐去配置名）与打分，最后一行是 `selftest ok`。`--only agreement` 只用
合成判决表校验保守一致度的手算值；`--only blind` 单独跑 40 条清单的生成、脱敏检查与合成答案
打分；`--only replay` 单独跑使用记录回放（批次、点选率、缓存命中次数与真实调用次数）。合成
判决表在 `fixtures/synthetic-judgements.json`，其中的手算期望与脚本内置常量互相校验。
