# S-A 状态注入的净成本与实时性读数

本文件是 `SPEC §8.3` 的每-run 上限与 `§13` 的 S-A 两条 SLO 的**离线实测**记录。量测脚本
`scripts/voice-realtime-status-cost.mjs` 驱动**真 transport + 真 proxy**（`createDashscopeTransport`
+ `handleVoiceRealtimeConnection`）跑在**脚本化假上游**（`createScriptedUpstream`）之上，`apiKey: ''`，
零云端调用；所有读数来自假上游**实际收到**的 `session.update` 帧。

## 复跑

```
node --experimental-transform-types scripts/voice-realtime-status-cost.mjs
node --experimental-transform-types scripts/voice-realtime-status-cost.mjs --check docs/operations/voice-realtime-status-cost.md
node --experimental-transform-types scripts/voice-realtime-status-cost.mjs --self-test
```

`--check` 在读数表为空或缺项时**失败**（空表不等于对账成功，与 `voice-realtime-reconcile.md` 一致）。

## 读数

| 指标 | 值 |
| --- | --- |
| 状态变化次数 | 76 |
| 注入次数 | 43 |
| 去重抑制次数 | 28 |
| 限频抑制次数 | 28 |
| 上限抑制次数 | 5 |
| 注入延迟样本数 | 40 |
| 注入延迟 p50 ms | 1 |
| 注入延迟 p95 ms | 2 |
| 注入延迟 max ms | 2 |
| 基础指令字节 | 740 |
| 指令块字节 p50 | 940 |
| 指令块字节 max | 972 |
| 状态行字节 p50 | 100 |
| 状态行字节 max | 132 |
| 对照臂注入次数 | 0 |
| 对照臂最大指令块字节 | 740 |
| 付费臂 A/B token 差 | 未测 |
| 付费臂花费 CNY | 未测 |

## 逐run

| run | 投递 | 状态变化 | 注入 | 去重抑制 | 限频抑制 | 上限抑制 |
| --- | --- | --- | --- | --- | --- | --- |
| k1 | 13 | 9 | 5 | 4 | 4 | 0 |
| k2 | 13 | 9 | 5 | 4 | 4 | 0 |
| k3 | 13 | 9 | 5 | 4 | 4 | 0 |
| k4 | 13 | 9 | 5 | 4 | 4 | 0 |
| k5 | 13 | 9 | 5 | 4 | 4 | 0 |
| k6 | 13 | 9 | 5 | 4 | 4 | 0 |
| k7 | 13 | 9 | 5 | 4 | 4 | 0 |
| cap | 13 | 13 | 8 | 0 | 0 | 5 |
| 合计 | 104 | 76 | 43 | 28 | 28 | 5 |

## 说明

- **注入载荷**：每次注入把整个 instructions 块重述一遍（`advertiseInstructions()` 没有增量接口），
  体 = 基础指令 740 B + 状态头 + 陈旧规则 + 状态行一行；上表给出体与状态行的**字节**分布。
  状态行本体受 `VOICE_REALTIME_STATUS_MAX_BYTES`（200 B）约束，是这一行而非整块的上限。
- **注入延迟**：以窗口 0 ms 量测，读数是**管线**延迟（状态变化 → 上游收到 `session.update`），
  刻意把出厂限频窗口从读数里排除；出厂窗口 2000 ms 是端到端的另一半。
  端到端 = 窗口 + 管线，其上界即窗口时长；同一窗口内的多次变化会被并成一行（见上表「限频抑制」）。
- **对照臂（注入关）**：同一驱动把限频窗口推到 run 生命之外，flush 永不触发 ⇒ 注入 0 次、指令块回到基础体。
  这一对比是本文的伪形：若脚本没有真的读线上帧，「注入关」与「注入开」两臂会读出同一组数。

## SPEC 校准

据本表校准 `docs/proposals/voice-realtime-persistent-control-SPEC.md` 的数值：

- **§8.3 每-run 上限 ≤ 8 次**：**保留**（仍为安全上限而非最优值）。上限的正当性来自**成本**，而成本本次
  只测到字节（注入体相对基础 +200 B），没测到 token —— 字节→token 需真实计费端点。
  故 §8.3 的注记保留，只把出处改指向本文件。
- **§13 S-A 注入延迟 ≤ 300 ms p95**：**校准**。离线实测管线 p95 = 2 ms
  （n = 40，窗口 0 ms）。管线极快，端到端的量级由出厂窗口决定，
  故该行写成两段：**管线 ≤ 50 ms p95（已实测）** + **端到端 ≤ 窗口 + 管线**。
- **§13 S-A 注入净成本 ≤ 5% 固定上下文（≤ ~64 token 等效）**：**保留「仍为建议值（成本未实测）」的注记**。
  注入体的字节已实测（见上），但 token 等效未测，故不改写该 SLO 的数值。

## 付费臂（本次未运行）

真实 A/B token 用量必须在**付费**端点上跑；本工具不代跑 —— `--paid --max-cny <预算>` 只用于**声明**
（缺预算即拒绝，exit 2），离线外推不得写成计费读数。人工过程逐字记录：

1. 同一会话、同一长回合跑两臂：A 臂注入开（现状），B 臂注入关（`VOICE_REALTIME_STATUS` 关闭或窗口推远）。
2. 从端点账单/dashboard 读两臂的 input token 与金额，差额即「注入净成本」的真实读数。
3. 把 token 差与金额写回上表两个付费行，替换「未测」；`--check` 会拒绝既非数字亦非「未测」的值。
