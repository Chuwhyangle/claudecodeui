# UI 观察负载周报（workload-report）

把「驾驶舱/观察墙」之前的观察负载变成可读的周报：查看事件由浏览器本地记录，服务端只追加写本机
JSONL 文件，不进数据库、不出本机。报告用于建立基线（观察墙是否真的减负），并区分「会话输出 /
Quay 状态 / 架构图 / 驾驶舱」四类观察目标。

## 数据从哪来

前端 `src/shared/viewEvents.ts` 记录“读者离开某个查看目标”时结算的一条事件：

```json
{"at":1792838400000,"kind":"session","target":"session-1","fromTarget":null,"dwellMs":120000,"deviceId":"..."}
```

- `kind`：`session` / `tab` / `cockpit-tile` / `cockpit-preview`
- `target`：会话 id，或 tab 名（`quay`、`architecture`、`chat`、`cockpit` …）
- `fromTarget`：进入该目标前所在的目标（首条为 `null`）
- `dwellMs`：实际可见的停留时长；页面隐藏期间不计时
- 批量：每 30 秒或 50 条 POST 到 `/api/observation/view-events`

服务端 `server/modules/observation/view-events.service.ts` 逐行追加到
`~/.cloudcli/ui-view-events.jsonl`（路径与开关见下）。

## 配置

服务级配置文件 `~/.config/claudecodeui/server.settings.json`（模板
`config/server.settings.example.json`）：

```json
{
  "observation": {
    "viewEvents": {
      "enabled": true,
      "path": "~/.cloudcli/ui-view-events.jsonl"
    }
  }
}
```

- `enabled` 默认 `true`；设为 `false` 时接口仍返回 204，但不写任何内容。
- `path` 可改为任意本机路径；目录不存在会自动创建。`~/` 会展开为 HOME。
- 该文件在启动时读取一次，修改后需重启服务。

## 跑周报

```bash
# 读本机日志，写到 /tmp
python3 -I scripts/workload-report/report.py --out /tmp/weekly.md

# 读夹具（不依赖真实日志）
python3 -I scripts/workload-report/report.py \
  --fixture scripts/workload-report/testdata --out /tmp/wr-test.md

# 断言夹具计数与手算一致（改夹具时必须同步改脚本里的 FIXTURE_EXPECTED）
python3 -I scripts/workload-report/report.py \
  --fixture scripts/workload-report/testdata --self-check
```

`-I` 是隔离模式：忽略 `PYTHON*` 环境变量与用户 site-packages，脚本只用标准库。

## 报告读数

| 小节 | 含义 |
| --- | --- |
| 观察型切换 | 每离开一个查看目标计一次；并给出目标数/会话数与隐藏页接续次数 |
| 停留 | 总停留、中位、p90 及分桶（<10s / 10s–1m / 1–5m / ≥5m） |
| 按目标类型 | 会话 / Quay / 架构 / 驾驶舱 / 其他的次数与占比 |
| 驾驶舱：预览 vs 跳转 | `cockpit-preview`、`cockpit-tile`、跳转进驾驶舱的比例 |

## 已知边界

- 事件在“离开目标”时结算，因此最后一个未离开的目标不会出现在日志里（页面隐藏/切换时才结算）。
- 只覆盖本机、本浏览器的记录；换设备或清除站点数据后重新开始。
- 报告是机械读数，不含语义判断；观察墙上的语义结论仍标注“仅建议”。

## 预测对账（predict.py）

`predict.py` 把「观察墙上线后这些行为比例会变」的登记预测变成可判定的
confirmed / refuted / insufficient-data。它读两路证据：

- T0 查看事件 JSONL（`~/.cloudcli/ui-view-events.jsonl`，或 `--log`）；
- Claude Code 会话记录里的人类输入（`~/.claude/projects`，或 `--transcripts`），
  沿用 T0 的正则分类规则与「自动会话」剔除规则（模板首句 / probe-sandbox 项目目录 /
  meta / system / 中断记录都不进入分母）。

### 三个比例

| 指标 | 分子 / 分母 | 预测方向 |
| --- | --- | --- |
| `cockpit_preview_share` | 驾驶舱预览 /（驾驶舱预览 + 为观察而跳进会话、Quay 或架构 tab 的导航） | 上升 |
| `observation_switch_share` | 进入观察目标（会话 / Quay / 架构 tab）的导航 / 全部查看事件 | 下降 |
| `progress_check_share` | T0 分类为 `a_progress` 的人类输入（查进展 / 是否可用 / 重启是否成功）/ 全部人类输入 | 下降 |

比例而不是数量：前后窗口的长度、使用强度不同也不会把「变多」误读成「变好」。

### 判定规则

预测登记是一份 JSON 数组，每项 `{id, metric, direction, threshold}`：

```json
[
  {"id": "P1-cockpit-preview-share", "metric": "cockpit_preview_share", "direction": "up", "threshold": 0.05}
]
```

- `threshold` 是**绝对百分点变化**（0.05 = 5pp），不是相对变化。
- `insufficient-data`：任一窗口的证据量低于下限（查看类每个窗口 ≥ 20 条事件、
  输入类每个窗口 ≥ 10 条人类输入）。样本不足时连「反驳」都不成立。
- `confirmed`：后减前的 Δ 达到登记方向与阈值。
- `refuted`：其余情况（方向相反，或方向对但幅度不到阈值）。

### 跑对账

```bash
# 夹具自检（手算期望写在 predict.py 的 FIXTURE_EXPECTED 里）
python3 -I scripts/workload-report/predict.py \
  --fixture scripts/workload-report/testdata \
  --pivot 2026-10-20T00:00:00+08:00 \
  --predictions scripts/workload-report/testdata/predictions.json \
  --json /tmp/pred-test.json --self-check

# 真实对账：以观察墙上线时刻为支点，前后各 24 小时（默认窗口）
python3 -I scripts/workload-report/predict.py \
  --pivot 2026-10-22T10:00:00+08:00 \
  --predictions /path/to/charter-predictions.json \
  --out /tmp/prediction-report.md --json /tmp/prediction-report.json
```

`--window-before START END` / `--window-after START END` 可显式覆盖默认的
±24 小时窗口。Markdown 与 JSON 都给出窗口起止、每个比例的分子 / 分母 / 样本量，
以及分类器的局限说明；JSON 供 fleet 倡议对账与 quay 前沿文档 §6 回填。

### 夹具

- `testdata/predict/predict-events.jsonl`：前窗口 21 条、后窗口 30 条查看事件；
- `testdata/predict/predict-human-inputs.jsonl`：前窗口 12 条人类输入（另有一个 4 条记录的
  模板自动会话，必须被剔除）、后窗口 4 条；
- `testdata/predictions.json`：三条预测，夹具按设计分别判为 confirmed / refuted /
  insufficient-data。

预测夹具放在 `testdata/predict/` 子目录：周报脚本按非递归的 `*.jsonl` 读
`testdata/`，预测脚本按递归读，因此两套夹具可以共处而不互相污染。夹具目录顶层
还有周报用的 `sample.jsonl`（事件时间在预测窗口之外）；`predict.py` 按每行的形状
而不是文件名分流查看事件与会话记录。
