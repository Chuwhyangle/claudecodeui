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
