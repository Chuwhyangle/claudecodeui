---
id: gap-quay-tab-loop-pulse-gantt-cross-project-interface-design
title: Loop pulse 5-lane 甘特图：跨项目接口设计——quay 0.17.0 已 ship `driver live --json
  --root` 只读出口，此前搁置该卡的 /proc 扫描阻碍已解除，先定接口/归属/判据/依赖，再按风险决定是否实现
status: done
labels:
  - gap
  - design
parent: null
children: []
extra: {}
---
## Proposal

<!-- dedup-ref -->
**去重/边界（按机制）**：`gap-quay-panel-stage-goals-tests-fanin-cards`（claudecodeui，status: done）在补齐 Stage goals/Task ledger/Tests/Fan-in 四张卡时，**明确搁置**了第五张「Loop pulse」（5 道车道的在飞任务甘特图），理由原文：「它需要的"当前在跑哪些任务"数据，quay 自己是扫 `/proc` 拿到的（`readLiveWorkerProcesses`），claudecodeui 这边不打算自己仿一套 `/proc` 扫描……是否由 quay 集中提供等价的只读接口，待其维护者裁决，不预排期」。本任务**不重开**那条已完成任务（它的四张卡仍然成立、仍然绿），而是记录一个**事实变化**：它搁置时等待的那个前置条件——quay 维护者提供等价只读接口——**现已满足**，见下。本任务是设计性质，不在本次实现甘特图本身（用户明确要求「先设计，后按风险决定是否实现」），交付物是接口文档 + 归属判断 + 可验收标准 + 显式依赖清单，供后续一个独立实现任务消费。

**quay 仓库侧的解除记录**：quay 项目自己的任务 `gap-no-readonly-surface-for-live-inflight-workers`（status: done，`/data/home/yale/work/quay`）精确针对这个阻碍立案并已完成——新增只读 CLI verb `quay driver live --json --root <path>`，直接复用 `readLive()`/`readLiveWorkerProcesses()`（quay 自己 dashboard "Loop pulse" 卡的同一条调用链，AC3 断言过同源），**不产生第二份 `/proc` 扫描**（DoD2：扫描形状命中数基线=改后，delta=0），接受 `--root` 并做按项目过滤（AC2 双向负控制已验证：另一 root 的 worker 不出现在本 root 的输出里），诚实区分「零个在飞」与「无法评估」（AC4）。

**已在本仓库实测验证可用，非纸面调查**：

```
$ node /data/home/yale/.claude/plugins/cache/quay/quay/0.17.0/vendor/quay/dist/quay.js \
    driver live --kind worker --json --root /data/home/yale/work/claudecodeui
```

返回（截断，完整见下方"接口形状"）：`{"root":"...","kind":"worker","workerSignal":{"evaluated":true,"reason":null},"telemetry":{...},"inFlight":[{"taskId":"gap-ac140-dashscope-public-host-second-copy","pid":null,"startedAtMs":1791513168161,"phase":"landed","minutes":5.17,"liveness":"unknown"},...]}`——claudecodeui 自己 `.quay/plugin` 符号链接指向的就是这个 0.17.0 版本（`readlink -f .quay/plugin` 确认），即这个 verb **此刻就能用**，不需要等升级。

## 接口形状（quay 侧已 ship，本任务只引用不复述全部字段语义——完整语义见 quay 任务 `gap-no-readonly-surface-for-live-inflight-workers` 的 AC5 记录）

```
quay driver live --kind worker --json --root <workspaceRoot>
→ {
    root: string,
    kind: "worker",
    workerSignal: { evaluated: boolean, reason: string | null },  // false+reason = 未评估，不是「零个在飞」
    telemetry: { status: string, reason: string | null },
    inFlight: Array<{
      taskId: string; runId: string;
      pid: string | null;            // carrier-only 条目为 null，worker 进程条目为字符串
      sessionId: string | null;
      startedAtMs: number;           // readLive 已补齐，非 null
      implCompletedAtMs: number | null;
      status: string | null; phase: string; suite: string | null;
      minutes: number; liveness: "alive" | "unknown" | ...;
    }>
  }
```

退出码 0 恒为 JSON；`--root` 过滤是机制级保证（quay 任务 AC2 双向负控制已证）；不依赖 `quay serve` 在跑（纯函数路径，DoD4 已证）。

## 甘特图本体的语义（quay 自己 dashboard "Loop pulse" 卡，必须原样保留，不得简化掉其信息）

源码位置：`packages/quay/src/serve-dashboard.ts`（quay 仓库），`export const FIXED_GANTT_LANES = 5`、`export function packLanes(...)`、`export function renderLiveGanttSvg(...)`——**这三者已经是 `export`**，但只在该文件内，quay 的发布产物是单文件打包的 CLI 二进制（`dist/quay.js`），claudecodeui 不依赖 `quay` npm 包（`grep "\"quay\"" package.json` 为空），所以**目前没有一条干净的 import 路径**可以直接复用这份实现——这正是下面"归属判断"要处理的问题，不要在没有这个决定之前就开始写第二份甘特算法。

必须保留的语义（供复刻/复用双路径共同遵守）：

1. **固定 5 道车道**，贪心区间装箱（`packLanes`：按 `startMs` 排序，分配给最早释放的 lane；超过 5 条并发时记 `overflow` 并在图上渲染 "+N more" 徽标，不丢弃数据，只是不再分配新 lane）。
2. **历史 + 在飞合并**：`mergeLiveAndHistoryIntervals(live.inFlight, historyRecords, windowStart, now)`——把当前在飞任务（上面那个新 CLI verb）与近期完成记录（`.quay/worker-outcome.jsonl`，claudecodeui 后端已经在读这个文件喂 Fan-in 卡，但目前的投影只取了 `outcome`/两个 epoch，**没有**保留 `started_at`/`ended_at`/`final_state`/`run_id`——这几个字段是画区间所必需的，当前投影会把它们丢在半路）合并进同一个时间窗口。
3. **时间窗口可切换**：1h / 3h / 6h / 12h（默认 3h），`windowHours` 参数改变即重新过滤两类记录源，不是前端纯视觉缩放。
4. **按 phase/outcome 着色**：`implementing`/`fan-in`/`landed`/`awaiting-land` 四个在飞态，加 `failed`/`killed`/`timed-out`/`exited-not-landed`/`completed` 几个历史终态，各自固定色值（`ganttIntervalColorVar`）。
5. **hover tooltip**：每个区间块原生 `<title>`，内容 `taskId · state · duration · start→end`（ISO）。

## 归属判断（本任务的核心交付，不替后续实现任务拍板，只把选项和各自代价列清楚）

claudecodeui 现在有两条路径把这份语义接进 Quay tab，**都不是「简单列表替代有信息损失的甘特图」**（这是用户明确排除的做法）：

**路径 A——请求 quay 上游导出可复用 kernel。** 请 quay 维护方把 `packLanes`（纯函数，输入区间数组→输出车道分配，无 DOM/SVG 依赖）与区间合并逻辑（`mergeLiveAndHistoryIntervals`）从 `serve-dashboard.ts` 抽到一个独立、面向消费者发布的子路径或包（例如 `@yalehwang/quay/dashboard-kernel` 或类似），claudecodeui 作为真实 npm 依赖引入。优点：单一实现来源，quay 改算法时 claudecodeui 自动跟随，零重复维护成本。代价：需要 quay 维护方排期并发布，跨项目协调，claudecodeui 侧多了一条真实外部依赖（当前 `package.json` 完全不依赖 quay npm 包，这会是第一条）。

**路径 B——只移植纯算法，不移植渲染。** 在 claudecodeui 自己的 TS 里重新实现 `packLanes` 的装箱算法（它只有排序+贪心分配，~20 行，无 DOM 依赖），**不**移植 `renderLiveGanttSvg`（那部分本来就要用 React/SVG 重写以配合本仓库的 dark mode/组件风格，不是直接复用的候选）；为防止「悄悄产生第二份实现然后漂移」，必须有一条**等价性测试**——同一组 fixture 区间喂给 claudecodeui 的 `packLanes` 端口与 quay 仓库的 `packLanes`（通过子进程调用 `quay driver live`/读 fixture 或直接 vendor 一份测试向量），断言车道分配结果 `deepEqual`，并在代码注释里显式标注"这是对 `quay packages/quay/src/serve-dashboard.ts:packLanes` 的一次有意移植，而非独立设计，quay 版本升级时需要重新核对该测试向量"。优点：不需要等待跨项目协调即可推进；风险可控（纯函数、测试向量钉死）。代价：仍然是两份代码，长期有漂移风险（尽管有测试挡着）。

**本任务不替后续实现任务选定 A 或 B**——这是需要与 quay 维护方协调的决定，按用户指示"优先协调 Quay 项目既有能力…不要草率双重实现"，倾向路径 A，但需要先确认 quay 维护方是否愿意接这个请求；若短期内无法确认，路径 B 是有等价性测试兜底的合理退路，不是草率重复实现。

## 后端数据缺口（无论选 A 或 B，都需要做；这部分是纯数据管道，风险低，可以先行）

1. `server/modules/quay/quay.service.ts` 的 `QUAY_READ_ONLY_COMMANDS` 白名单需新增 `driver live --kind worker --json`（目前只有 `driver status --kind <X> --json` 六种 kind，没有 `live` 这个 verb）。
2. `collectSnapshot` 需新增一次该命令调用，喂出 `inFlight`（已有同名字段但当前来自 `.quay/worker-round.jsonl` 的最后一条心跳，是另一条更轻的既有实现——见 `gap-cloudcli-quay-snapshot-inflight-tasks`/`gap-quay-panel-inflight-task-display` 两条已完成任务；本任务需要的是**区间**而不是"当前一条"，是否复用同一个 `inFlight` 字段还是新开一个专供甘特图的字段，由实现任务决定）。
3. `summarizeFanInAttempts`（`quay.service.ts`，当前只投影 `task`/`outcome`/两个 epoch）需要补上 `started_at`/`ended_at`/`final_state`/`run_id` 几个字段，且读取方式要从"count-10 尾部截断"改成"按时间窗口过滤"（配合上面的 1h/3h/6h/12h 窗口语义）。
4. `QuaySnapshot` 类型需要能装下"区间数组"这个形状（当前没有任何字段是这个形状）。

## AC（本任务——设计/记录性质，不是实现）

- [x] AC1 接口形状已在本仓库实测验证（非纸面）：贴 `quay driver live --kind worker --json --root /data/home/yale/work/claudecodeui` 的真实命令与真实 JSON 输出（见 Evidence）。
- [x] AC2 归属判断已写清两条路径、各自优缺点，且明确不在本任务内拍板选哪条（见上）。
- [x] AC3 后端数据缺口清单已列出具体文件/字段/现有相关任务的交叉引用，供后续实现任务直接转成 Touches。
- [x] AC4 甘特图语义清单（5 车道/装箱算法/历史+在飞合并/时间窗口/着色/tooltip）逐条对照 quay 源码位置标注，供后续实现任务或等价性测试直接引用，防止实现时凭记忆简化掉信息。

## DoD

本任务产出一份可被下一个实现任务直接消费的设计记录（即本任务体本身）；不改动任何代码、不新增依赖、不实现甘特图组件。后续真正实现 Loop pulse 卡时应新开一个任务，Touches 指向 `server/modules/quay/quay.service.ts`（后端数据缺口部分）与一个新的 `src/modules/quay/LoopPulseGantt.tsx`（前端部分），并在其 Proposal 里引用本任务已做的归属判断——不得在那个任务里重新调查一遍接口是否存在。

## Touches

- tasks/gap-quay-tab-loop-pulse-gantt-cross-project-interface-design.md (self-touch; 本任务不改动任何源码文件)

## Evidence

### AC1 — `quay driver live` 在本仓库实测

```
$ cd /data/home/yale/work/claudecodeui && node /data/home/yale/.claude/plugins/cache/quay/quay/0.17.0/vendor/quay/dist/quay.js driver live --kind worker --json --root /data/home/yale/work/claudecodeui
{
  "root": "/data/home/yale/work/claudecodeui",
  "kind": "worker",
  "workerSignal": { "evaluated": true, "reason": null },
  "telemetry": { "status": "ok", "reason": null },
  "inFlight": [
    { "taskId": "gap-ac140-dashscope-public-host-second-copy", "runId": "worker-gap-ac140-dashscope-public-host-second-copy", "pid": null, "sessionId": null, "startedAtMs": 1791513168161, "implCompletedAtMs": null, "status": "needs-human", "phase": "landed", "suite": null, "minutes": 5.16775, "liveness": "unknown" },
    { "taskId": "gap-mcp-pending-interaction-visibility-and-idempotent-answer", "runId": "worker-gap-mcp-pending-interaction-visibility-and-idempotent-answer", "pid": null, "sessionId": null, "startedAtMs": 1791513192183, "implCompletedAtMs": null, "status": "ready", "phase": "implementing", "suite": null, "minutes": 4.767383333333333, "liveness": "unknown" },
    { "taskId": "gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged", "runId": "worker-gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged", "pid": null, "sessionId": null, "startedAtMs": 1791512420027, "implCompletedAtMs": null, "status": "ready", "phase": "implementing", "suite": null, "minutes": 17.63665, "liveness": "unknown" }
  ]
}
```

退出码 0。`.quay/plugin` 符号链接实测指向同一个 `/data/home/yale/.claude/plugins/cache/quay/quay/0.17.0`（`readlink -f .quay/plugin`），确认 claudecodeui 当前实际使用的插件版本已含这个 verb（`VERBS = ["start","stop","drain","resume","status","restart","log","live"]`，在该版本的 `vendor/quay/dist/quay.js` 里 grep 确认）。

### quay 仓库侧完成记录交叉核对

`node plugin/vendor/quay/dist/quay.js task view gap-no-readonly-surface-for-live-inflight-workers --json`（于 `/data/home/yale/work/quay`）：status done，Evidence 段落记录了 AC1-AC7、DoD1-DoD4 的真实实测读数（含 root 过滤双向负控制、无第二份 `/proc` 扫描的命中数核对、与 dashboard 同源的可区分对照）。本任务的 AC1 实测与之使用同一条 CLI verb、同一条调用链。

## Update（本任务完成后的跟进，不改变上面已锁定的内容）

路径 A（上文"归属判断"）已正式立案到 quay 自己的任务库：`gap-dashboard-kernel-export-for-cross-project-reuse`（`/data/home/yale/work/quay`，status: todo，未 promote 到 ready——该任务体里明确建议先由人工/高优先级会话过一遍"quay 是否要在此刻承诺这个外部发布面"，不要被机械 worker 循环直接摘取）。已通过 SendMessage 把该任务指给 quay 工作区里一个以"Quay 架构审查"为主题的常驻会话（`Quay 架构审查与 ArchGuard 能力评估`），请其评审/裁决，消息里同时给出了本任务作为消费侧完整上下文的链接，并明确表示设计可以被该会话推翻/改写，不是单方面定案。

本任务保持 done、不重开；后续真正的 claudecodeui 侧实现任务（本任务 DoD 里描述的 `server/modules/quay/quay.service.ts` + `src/modules/quay/LoopPulseGantt.tsx`）应等 `gap-dashboard-kernel-export-for-cross-project-reuse` 在 quay 侧有明确结论（promote 到 ready/done，或被该会话判定不做并说明替代方案）之后再立案——在那之前立案会立刻卡在"依赖的包版本号还不存在"，不是真正可执行的任务。