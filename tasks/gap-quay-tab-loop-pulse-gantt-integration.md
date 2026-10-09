---
id: gap-quay-tab-loop-pulse-gantt-integration
title: Quay tab 嵌入 Loop pulse 5-lane 甘特图（消费 quay 发布的 dashboard-kernel）：被上游
  0.18.0 未发布阻塞，接口与集成方案已定稿
status: needs-human
labels:
  - gap
parent: null
children: []
extra: {}
---
## Proposal

### 去重（立案时实测，按机制）

claudecodeui 任务库检索 `loop pulse` / `gantt` / `dashboard-kernel` / `kernel`，只命中两条 **done** 的设计前置：
- `gap-quay-panel-stage-goals-tests-fanin-cards`（done）——补齐了另外四张卡，**明确搁置** Loop pulse。
- `gap-quay-tab-loop-pulse-gantt-cross-project-interface-design`（done）——消费侧设计记录（接口形状、必须保留的语义、归属判断、后端数据缺口清单）。

没有任何任务认领"真正实现这张卡"，故本条不是重复，是其下游实现。

### 上游状态（2026-10-09 实测，非纸面）

**算法已实现并合入 `develop`，但没有发布。** 逐条取证：

| 事实 | 证据 |
|---|---|
| kernel 源文件存在 | `/data/home/yale/work/quay/packages/quay/src/dashboard-kernel.ts`（7873 B） |
| `exports` 已暴露子路径 | `packages/quay/package.json` 有 `"./dashboard-kernel"`（`types`→`src/*.ts`、`default`→`dist/*.js`）与 `"./dashboard-kernel/vectors"`→`src/dashboard-kernel-vectors.json` |
| 实现已合入 | `git merge-base --is-ancestor 2a894daf4 origin/develop` → 真 |
| **但没有发布** | `git tag --sort=-v:refname \| head -1` → **`v0.17.0`**；github marketplace checkout（`yaleh/quay`）HEAD `09551db`，其 `packages/quay/src/dashboard-kernel.ts` **不存在** |
| **插件产物里也没有** | `plugin/vendor/quay/dist/dashboard-kernel.js` 在 quay 自己的工作树（0.18.0-dev）里**不存在**；`plugin/vendor/quay/package.json` 的 exports **无** kernel 条目 |
| npm 渠道不可用 | `npm view quay` → `0.6.0`（**不相干**的第三方同名包）；`@yalehwang/quay` → 404。quay 的 npm/SEA 渠道已按裁定退役 |
| 无发布任务在飞 | quay 任务库 `--status ready/todo --search release` → 0 条 |

### 消费机制（用户 2026-10-09 裁定）

不复用 vendor、不用 `file:` 依赖（后者会毒化已发布的 `@yalehwang/cloudcli`）。走 quay 自己的正式发布流程：

1. quay 出正式发布到 github（tag + 插件产物重建，含 `vendor/quay/dist/dashboard-kernel.js`）。
2. 安装到 user scope。
3. ClaudeCodeUI（及其它试用 quay 的项目）**启动新会话**，跑 `/quay:init` 完成升级——`.quay/plugin` 符号链接随之指向新插件版本。

消费点：`<projectRoot>/.quay/plugin/vendor/quay/dist/dashboard-kernel.js`（与后端现有解析 quay CLI 的 `.quay/plugin` 同一条路径约定）。

**本任务当前被第 1 步阻塞**：不存在任何含 kernel 的已发布插件版本，所以无法安装、无法 `/quay:init`、无法针对真实产物写可测的集成代码。在发布落地前动工只会产出跑不通的半成品。

### 接口（已定型，发布落地后直接照此接入）

```
import { FIXED_GANTT_LANES, mergeLiveAndHistoryIntervals, packLanes,
         LIVE_INTERVAL_PHASES, LIVE_INTERVAL_FINAL_STATES } from 'quay/dashboard-kernel';

const merged = mergeLiveAndHistoryIntervals(inFlight, historyRecords, windowStartMs, nowMs);
const { lanes, overflow } = packLanes(merged);
```

- `FIXED_GANTT_LANES = 5`；`packLanes` 贪心装箱，**超出 5 车道的区间被剔除并计入 `overflow`**（不丢弃语义由消费方负责渲染 "+N more"）。
- `mergeLiveAndHistoryIntervals`：在飞 + 历史合并、按时间窗口过滤、按 `(taskId, startMs)` 去重。
- `inFlight` 时间戳与所有 `expected*` 为 **epoch ms**；`records` 的 `started_at`/`ended_at` 是 **ISO 字符串**（worker-outcome 载体原格式）——不要混用。
- 内核**不发布**配色：只发布"有哪些状态"，`phase`/`finalState` → 颜色的映射由本仓库自己的 Tailwind 语义色决定。
- 契约测试向量：`quay/dashboard-kernel/vectors`（JSON，需 `with { type: "json" }` 导入属性，缺了会 `ERR_IMPORT_ATTRIBUTE_MISSING`）。

### 必须保留的语义（来自已完成的设计记录，不得简化）

5 车道固定 / overflow 计数 + "+N more" / 历史+在飞合并 / 时间窗口 1h·3h·6h·12h（默认 3h，切换即重新过滤数据源而非纯视觉缩放）/ 按 phase·finalState 着色 / 每块原生 `<title>` 为 `taskId · state · duration · start→end`。

### 后端数据缺口（设计记录已列，此处转为 Touches）

1. `QUAY_READ_ONLY_COMMANDS` 白名单加 `driver live --kind worker --json`（现有白名单只有 `driver status`，无 `live` verb）。
2. `collectSnapshot` 调该命令取在飞区间；现有 `inFlight` 字段来自 `.quay/worker-round.jsonl` 最后一条心跳（另一条更轻的既有实现），本卡需要的是**区间**——复用还是新开字段由实现定。
3. `summarizeFanInAttempts` 补 `started_at`/`ended_at`/`final_state`/`run_id`，且读取方式从 count-10 尾部截断改为**按时间窗口过滤**。
4. `QuaySnapshot` 增区间数组字段（当前无此形状）。
5. **车道计算放后端**（用 kernel），前端只渲染——避免前端 bundle 外部路径，也让五条语义只有一处实现。

<!-- dedup-ref -->
**与既有已完成任务的关系（不是重复）**：`gap-cloudcli-quay-snapshot-inflight-tasks` / `gap-quay-panel-inflight-task-display`（均 done）做的是"当前在飞**一条**读数"及其渲染；本卡做的是**区间甘特**（历史+在飞、多车道、时间窗口），数据形状与语义都不同。

## AC

- [ ] AC1 **前置解除取证**：`git -C /data/home/yale/work/quay tag --sort=-v:refname | head -1` 指向一个含 kernel 的版本；`<projectRoot>/.quay/plugin/vendor/quay/dist/dashboard-kernel.js` 实际存在（`ls -l` 贴出），且 `readlink -f .quay/plugin` 指向该版本目录。**这三条不成立则本任务不具备开工条件**，不得以自建产物或 vendor 副本绕过。
- [ ] AC2 **等价性证明（契约向量回放）**：新增测试从 `quay/dashboard-kernel/vectors`（或 `.quay/plugin` 内同源文件）读向量，对每条断言 `mergeLiveAndHistoryIntervals` 与 `packLanes` 的输出**逐字相等**（`deepEqual`）。这是"我真的在跑 quay 同一套算法、不是长得像的复刻"的唯一证据。
- [ ] AC3 **后端产出区间**：`GET /api/quay/:id/snapshot` 的响应里含车道数据（`lanes` 数组 + `overflow` 计数 + 时间窗口参数），且 `warnings` 不因 kernel 加载失败而静默退化成空数组（加载失败必须是**可区分的**读数，不能与"没有区间"同形）。
- [ ] AC4 **五条语义逐条可判**：(a) 车道数 ≤ 5 且超载计入 `overflow`；(b) 历史与在飞同时出现在同一窗口内的正确车道；(c) 切换 1h/3h/6h/12h 会改变入选区间集合（非纯缩放）；(d) phase/finalState 映射到**互相不同**的颜色类；(e) 每块带 `taskId · state · duration · start→end` 的 `<title>`。
- [ ] AC5 **overflow 不静默丢数据**：`overflow > 0` 时渲染可见的 "+N more"，且该数与后端 `overflow` 逐字一致。
- [ ] AC6 `npm run typecheck` 退出 0；相关窄测试全绿（按仓库既有 runner，不起无界扇出——见 `docs/operations/process-isolation-and-memory-caps.md`）。
- [ ] AC7 `git diff --stat` 与 `## Touches` 逐条对齐。

## DoD

真实对象上跑通，不是只有 fixture 绿：在真实运行的 CloudCLI 上打开一个有真实 worker 活动的 quay 项目的 Quay tab，甘特图渲染出真实区间（与同一时刻 `quay driver live --json --root <project>` 的在飞集合对应），车道/颜色/overflow/tooltip 与 quay 自己的 dashboard "Loop pulse" 卡在同一时间窗口下**语义一致**（允许配色不同——本仓库用自己的 token）。用真实浏览器（非 jsdom）读数。

## Touches

- package.json（若最终确需声明 kernel 来源依赖；否则不动）
- server/modules/quay/quay.service.ts
- server/modules/quay/tests/quay.service.test.ts
- src/modules/quay/LoopPulseGantt.tsx (new)
- src/modules/quay/QuayPanel.tsx
- src/modules/quay/tests/QuayPanel.test.tsx
- src/modules/quay/tests/LoopPulseGantt.test.tsx (new)
- src/shared/types.ts
- tasks/gap-quay-tab-loop-pulse-gantt-integration.md (self-touch)

## Notes / 阻塞

**当前阻塞**：上游 kernel 已合入 `develop` 但**未发布**（最新 tag `v0.17.0`，插件产物无 kernel，npm 渠道已退役，无发布任务在飞）。用户裁定的路径要求 quay 先出正式发布 → 安装 user scope → `/quay:init`。**第 1 步未发生，故本任务暂不可开工。** 解除条件见 AC1。

不建议的绕法（已评估并否决）：vendor 源码副本、`file:` 依赖指向本地 checkout（会把机器本地绝对路径写进已发布的 `@yalehwang/cloudcli`，对所有消费者致命）、自建 tarball 提交进仓库。用户已明确选择走正式发布渠道。

## 阻塞复核（worker round · 2026-10-09）

AC1 前置复核：**三条全部不成立 ⇒ 本任务不具备开工条件**，按 worker 协议 park 为 `needs-human`（**本轮未做任何实现**；任务明文禁止 vendor 副本 / `file:` 依赖 / 自建产物等绕法）。

- 条件1 `git -C /data/home/yale/work/quay tag --sort=-v:refname | head -1` → `v0.17.0`：kernel 合入 develop 后**无任何含 kernel 的新 tag**。
- 条件2 `<projectRoot>/.quay/plugin/vendor/quay/dist/dashboard-kernel.js`（`ls -l`）→ **No such file or directory**。
- 条件3 `readlink -f .quay/plugin` → `/data/home/yale/.claude/plugins/cache/quay/quay/0.17.0`，其 `vendor/quay/dist/` 仅 `quay.js`（无 kernel）⇒ 指向的不是含 kernel 版本。
- 旁证：plugin cache 最新为 0.17.0（0.10.0/0.11.0/0.14.0/0.15.0/0.16.0/0.17.0 均无 kernel）；kernel 源码仍仅存在于 quay 工作树 `packages/quay/src/dashboard-kernel.ts`（未发布）。

AC 读数：AC1 不成立 ⇒ **AC2–AC7 全部未勾选**（均依赖已发布 kernel 产物，无可验证的实现）。**解除条件**：quay 出正式发布（含 kernel 的 tag + 插件产物 `vendor/quay/dist/dashboard-kernel.js`）→ 安装 user scope → 新会话跑 `/quay:init` → 之后重跑本卡。