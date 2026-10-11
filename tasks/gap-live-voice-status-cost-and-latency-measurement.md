---
id: gap-live-voice-status-cost-and-latency-measurement
title: S-A 状态注入的净成本与实时性量测：离线（scripted fake，零云）测注入载荷/注入延迟 p50-p95/单 run
  注入与抑制次数；付费 A-B 默认关且需显式 opt-in+预算；据此校准 SPEC §8.3 的 ≤8 次每 run 与 §13 两条 SLO
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-status-aggregate-and-inject
---
## Proposal

### 现状：SPEC 里有两组数字是**建议值**，不是读数

`docs/proposals/voice-realtime-persistent-control-SPEC.md`（Draft-2，已合入 develop `ac5c4de5`）写下两组必须实测才能定值的数字：

1. **§8.3 的注入上限**：单 run **≤ 8 次**、限频 **1 次 / 2 s**。规范原文自述这是**安全上限而非最优值**：*"每次注入的净成本尚未实测（G-5）；因此 §8.3 的 ≤8 次/run 是安全上限而非最优值，必须由 G-5 的读数校准后才可放宽。"*
2. **§13 的两条 SLO**：**S-A 注入延迟 ≤ 300 ms p95**、**S-A 注入净成本 ≤ 5% 固定上下文**。

已有的锚点只有一个：固定上下文约 **1,280 token / 响应**，按"每次响应读取的 token"计费（`server/modules/voice-realtime/voice-realtime-tools.ts:290-291`）——那是**今天**的基线，不含状态注入。

**为什么必须量**：注入走的是 `session.update` **整体重述 instructions**（`voice-realtime-ws-proxy.service.ts:737-752` 的 `advertiseInstructions()`）。整体替换**不累积**（这是它优于 conversation item 的原因，见 SPEC §1.5 的 B-1/B-2/B-3），但**每次注入都要把整个 instructions 块重述一遍**——净成本因此与"注入次数 × 指令块大小"同阶，而这两者都还没有读数。

规范全文见 SPEC §8.3 / §13 / §16 的 **G-5**。

### SCOPE BOUNDARY

- ⛔ 不改产品行为（本任务只量测与写读数；任何阈值调整都只发生在 SPEC 文本里）。
- ⛔ 默认**零云端调用**：离线臂用 scripted fake；付费臂默认关闭，且需要显式 opt-in 与预算上限（见 AC4）。
- ⛔ 不重跑全量 suite。

<!-- dedup-ref --> 机制去重（立案时实测，2026-10-11）：open 任务对 `注入成本` / `measurement` 均 0 命中；`task-granularity-advice.js` 对本任务 Touches 报 `peers: []`。

## Plan

1. **离线臂（默认，零云）**：新脚本 `scripts/voice-realtime-status-cost.mjs`，用 `gap-voice-realtime-scripted-fake-upstream` 已落地的 `createScriptedUpstream()` 驱动真 transport + 真 proxy，跑一段**合成的长回合**（连续状态变化 ≥ 60 次、跨多个 run 边界），采集：
   - 每次注入的**指令块字节数**与**状态行字节数**；
   - **状态变化 → 上游收到 `session.update`** 的延迟（p50 / p95 / max）；
   - 单 run 的**实际注入次数**与**被去重/限频抑制的次数**。
2. **付费臂（默认关，需显式 opt-in）**：同一长回合脚本，A/B 两次真实会话（开/关注入），读上游返回的 token 用量差。**必须**显式开关 + 预算上限（参考既有 `VOICE_REALTIME_MAX_CNY_PER_30S` 的闸），且**未跑时文档必须写"未测"**，不得用离线外推冒充读数。
3. **写读数文档**：`docs/operations/voice-realtime-status-cost.md`——机器可复核的表格 + 复跑命令（与 `scripts/voice-realtime-reconcile.mjs --check` 的风格一致：**空表即失败**）。
4. **校准 SPEC**：把 §8.3 的 ≤8 次/run 与 §13 的两条 S-A SLO 改成实测定值；**若付费臂未跑**，则显式标"仍为建议值（成本未实测）"，不得删掉该标注。
5. **静态门**：`npm run typecheck`、`npm run lint`（脚本若进 `scripts/`，按本仓既有 `.mjs` 风格，不被 `server/**` 的测试收集集收录）。

## AC

- [ ] AC1 离线注入载荷（**取假形态，排在判据文件最前**）：给出状态行与指令块的字节数分布；且脚本在**注入被关掉**时读数必须显著不同（否则说明它没真的在量）——这条对比即本 AC 的假形态。
- [ ] AC2 离线注入延迟：`≥30` 次采样的"状态变化 → 上游 `session.update`"延迟 p50/p95/max（给出读数）。
- [ ] AC3 离线注入次数：合成长回合下单 run 的**实际注入次数**与**被抑制次数**（去重 + 限频各计），给出两个读数。
- [ ] AC4 付费臂（**默认关**）：仅在显式 opt-in 且声明预算上限时运行；给出 token 用量 A/B 差与花费读数。**未运行时，文档必须逐字写明"未测"**——不得以离线外推填充。
- [ ] AC5 SPEC 校准：`docs/proposals/voice-realtime-persistent-control-SPEC.md` 的 §8.3 上限与 §13 的 S-A 两项 SLO 已改为实测定值，**或**显式保留"仍为建议值（成本未实测）"标注（二者必居其一，不得静默）。
- [ ] AC6 读数文档可复核：`docs/operations/voice-realtime-status-cost.md` 含复跑命令，且**空表判定为失败**（与该目录既有 reconcile 风格一致）。
- [ ] AC7 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

一个**真实对象**被这套量测操作过：脚本真的驱动了**生产 transport + 生产 proxy**（不是替身），在**零云端调用**下产出一份可复核的读数（注入载荷 / 注入延迟 / 注入次数与抑制次数），并据此把 SPEC 的两组数字**校准为定值或明确标注未校准**。⛔ 不得把离线外推写成真实计费读数。

## Touches

- scripts/voice-realtime-status-cost.mjs (new)（量测脚本）
- docs/operations/voice-realtime-status-cost.md (new)（读数与复跑命令）
- docs/proposals/voice-realtime-persistent-control-SPEC.md (only the §8.3 cap and the §13 S-A SLO numbers)
- tasks/gap-live-voice-status-cost-and-latency-measurement.md (self)
