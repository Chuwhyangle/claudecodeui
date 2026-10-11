---
id: gap-quay-tab-inflight-card-and-gantt-two-sources
title: Quay tab 的「In flight」卡与「Loop pulse」图读的是两份不同来源：已落地任务会被卡显示为在飞、phase
  与图不一致、lastHeartbeat 不可见——收成一份读数并给陈旧标注
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

Quay tab 里「In flight」卡与「Loop pulse」甘特图会对**同一时刻**给出相反读数：卡说某任务在飞，图里却没有它（用户 2026-10-11 实测报告）。根因不是渲染，而是**两条独立的数据通路**：

- 卡：`server/modules/quay/quay.service.ts` 的 `summarizeInFlightTasks` 读 `.quay/worker-round.jsonl` **最后一条记录**的 `in_flight_tasks` —— 不查任务是否已落地、不看心跳是否新鲜；`phase` 走 `inFlightPhase`，取自 `worker-outcome.jsonl` 的 fan-in 尝试（一次尝试**结束**才写）。
- 图：quay 侧 `observation.readLive`（`quay lanes --json` 与 `driver live` 的同一条调用链）读**同一份** round 载体，但丢弃已落地的任务（`packages/quay/src/observation.ts` 第 2088 行 `readTaskStatusForLive(root, t.taskId) === TASK_STATUS.DONE → continue`），另外并入 /proc 活进程源，`phase` 取自 `.quay/fan-in-lock-events.jsonl`（实时 acquire/release）。

**确定性复现（本机实测）**：临时 root 内放 `.quay/config.yml`、两个 task 文件、一行 round 记录同时列出两者，其中 `probe-landed-task` 是 `status: done`：

    quay driver live --kind worker --json --root <fixture>   → inFlight 只有 probe-running-task
    quay lanes --json --window-hours 3 --root <fixture>      → 在飞区间只有 probe-running-task
    tail -1 <fixture>/.quay/worker-round.jsonl               → in_flight_tasks 两个都在   ← 卡的数据源

取假对照：**只**把那个任务的 `status` 改回 `ready`，两条读数立刻都出现它 —— 唯一变量是状态，所以差异就是 `done` 过滤。

**线上现场（/data/home/yale/work/quay，2026-10-11）**：`gap-architecture-evidence-store-and-decision-memory` 于 `03:26:31.918Z` 跑完（`worker-outcome.jsonl` 记 `final_state=completed`、`mechanical_fan_in.outcome=landed`）⇒ 状态翻 `done`；而 round 载体的最后一条停在 `03:17:53`（下一条 round 记录 `03:27:35` 才写，间隔 **9m42s**）⇒ 这 64 秒里卡把它显示为在飞，图正确地不画它；面板不自动刷新，所以错读数会一直停在屏幕上直到手动刷新。

**同源第二处症状（实测 11:44:51 同一任务）**：卡 `implementing` / 图 `fan-in`。锁事件载体 `03:41:20 acquire → 03:45:06 release`，而 outcome 记录 `03:45:30` 才出现 —— 卡的 phase 来源天然慢一个尝试。

**第三个读数缺陷**：payload 里有 `lastHeartbeat`（`src/shared/types.ts`），前端**从不渲染** —— `QuayPanel.tsx` 的 `InFlightCard` 只画 taskId/phase/elapsed，所以「这条读数已 10 分钟没动」在 UI 上与活心跳长得一模一样，陈旧读数没有任何可见标记。

本任务把面板这条读数收成**一份来源 + 诚实的陈旧与相位标注**：卡与图取同一份在飞集合（以 `driver live` / `lanes` 的在飞集合为准，round 载体只负责提供卡需要的补充字段：ISO 起始时刻、`lastHeartbeat`、`workerPid`）；`phase` 与图同源；渲染 `lastHeartbeat` 并对超过一个 round 周期的读数打陈旧标记。

<!-- dedup-ref -->
去重（按机制，立案前检索）：`gap-quay-panel-inflight-task-display`（done）解决的是「面板从未渲染 inFlight」；`gap-cloudcli-quay-snapshot-inflight-tasks`（done）解决的是「后端从未产出 inFlight」；`gap-quay-tab-loop-pulse-gantt-integration`（done）交付的是甘特图本身。三者都已 done，本任务的机制 —— **两个在飞读数会互相矛盾、且陈旧不可见** —— 与它们都不同，不是重复。合并候选检查（quay 插件的 `scripts/dist/task-granularity-advice.js`，即 `${CLAUDE_PLUGIN_ROOT}/scripts/dist/task-granularity-advice.js`）：唯一 peer 是 `gap-live-voice-caption-removal-on-shown`（ready），共享文件只有 `src/shared/types.ts`，机制无关，**分开立案**。

## AC

- [x] AC1 快照内的两个在飞读数不得互相矛盾，且已落地的任务不得出现在卡里：`server/modules/quay/tests/quay.service.test.ts` 新增用例 —— 注入的 round 载体同时列出「`status: done` 的任务」与「running 的任务」，lanes 动词 fixture 只报 running 那个；断言 `snapshot.inFlight` 的 taskId 集合 == `snapshot.gantt` 中 `phase != null` 区间的 taskId 集合，且两者都不含已落地任务。取假：删掉状态过滤（或让卡继续直接投影 round 载体），该用例必须红。判据：`npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/quay.service.test.ts` exit 0。
- [x] AC2 `phase` 与甘特图同源：同一测试文件新增用例 —— 一个持有未释放 fan-in 锁（`.quay/fan-in-lock-events.jsonl` 有 acquire 无 release）、且 `worker-outcome.jsonl` 尚无本次尝试记录的任务，卡的 `phase` 必须是 `fan-in`（今天是 `implementing`），且等于 `snapshot.gantt` 里该区间的 phase。取假：把 phase 来源改回 outcome 尝试表，该用例必须红。
- [x] AC3 `lastHeartbeat` 在卡上可见 + 陈旧读数有标记：`src/modules/quay/tests/QuayPanel.test.tsx` 断言 (a) 每个在飞行渲染 `data-testid="quay-panel-inflight-heartbeat"`，文本为该 ISO 时刻的可读形式；(b) `lastHeartbeat` 距快照 `generatedAt` 超过阈值时出现 `data-testid="quay-panel-inflight-stale"`，未超过时不出现（阈值是具名常量，测试钉住其两侧）。取假：去掉陈旧判断，该用例必须红。
- [x] AC4 窄测试与类型：`npm run typecheck` exit 0；`server/modules/quay/tests/quay.service.test.ts` 与 `src/modules/quay/tests/QuayPanel.test.tsx` 全绿（窄跑，不起无界扇出，见 `docs/operations/process-isolation-and-memory-caps.md`）。

## DoD

真实对象过机制，不靠 fixture 自证：在一台真实 workspace（例如 `/data/home/yale/work/claudecodeui` 或 `/data/home/yale/work/quay`）上，用真实后端 `GET /api/quay/:projectId/snapshot` 与真实 `quay lanes --json --window-hours 3` 取同窗口两份读数，逐条比对**在飞集合完全一致**（不再出现「卡有、图无」或反向）；并在一个真实落地的任务上验证卡不再把它显示为在飞（可在 driver 的 round 记录尚未更新时读取）。浏览器侧：真实页面（MCP 浏览器）上「In flight」卡与「Loop pulse」图对同一快照的在飞任务逐条一致，且一条 `lastHeartbeat` 明显落后的读数带可见陈旧标记。读数与截图记入本任务 `## 验证记录`。

## Touches

- server/modules/quay/quay.service.ts（在飞读数的来源与投影：与图的集合同源、phase 同源、陈旧语义）
- server/modules/quay/tests/quay.service.test.ts（done 过滤 / phase / 两字段自洽的用例）
- src/shared/types.ts（在飞读数契约：陈旧标记所需的字段）
- src/modules/quay/QuayPanel.tsx（InFlightCard 渲染 lastHeartbeat 与陈旧标记）
- src/modules/quay/tests/QuayPanel.test.tsx（前端渲染用例）
- tasks/gap-quay-tab-inflight-card-and-gantt-two-sources.md

## 验证记录

实现：In-flight 卡与 Loop pulse 图改为同源 —— 二者都由 `buildGantt()` 的同一份 `lanes` 读数导出（`.quay/worker-round.jsonl` 只补 `startedAt` / `lastHeartbeat` / `workerPid`）。`gantt === null`（无读数）⇒ 卡 `inFlight === null`；可读 lanes 而无在飞区间 ⇒ `[]`。卡的 `phase` 直接取 lanes 区间的 phase（`implementing` / `fan-in` / `awaiting-land` / `landed`）。前端渲染 `lastHeartbeat`，并在其距快照 `generatedAt` 超过具名常量 `IN_FLIGHT_STALE_AFTER_MS = 300000`（一个 round 周期）时打 `stale` 标记。

### 真实后端读数（真实 workspace `/data/home/yale/work/claudecodeui`，2026-10-11）

进程内挂载**真实** quay router（真实 service、真实 project-scoped CLI 子进程、真实 `.quay/` 载体），发起真实 `GET /api/quay/dod-probe/snapshot?hours=3`，并独立跑真实 `quay lanes --json --window-hours 3` 逐条比对：

    httpStatus              = 200
    snapshotInFlight        = ["gap-quay-tab-inflight-card-and-gantt-two-sources"]
    ganttInFlight           = ["gap-quay-tab-inflight-card-and-gantt-two-sources"]
    lanesInFlight           = ["gap-quay-tab-inflight-card-and-gantt-two-sources"]
    cardEqualsGantt         = true
    cardEqualsLanesVerb     = true
    landedTaskCount         = 11
    landedTasksNoneInFlight = true
    sampleRow               = {taskId:"gap-quay-tab-inflight-card-and-gantt-two-sources", phase:"implementing", startedAt:"2026-10-11T06:35:31.289Z", lastHeartbeat:"2026-10-11T06:45:25.256Z", workerPid:4187865}
    → DOD-OK

即：卡读数 == 图读数 == 真实 `quay lanes` 动词读数；11 个已落地任务无一被卡显示为在飞。

### 浏览器读数（真实页面 Chromium，2026-10-11）

真实 app 栈（鉴权、项目解析、快照其余字段皆真）；对**同一份快照**比对卡与图，快照里注入一份互相自洽的 `inFlight` + `gantt`（含一新一旧两条 lastHeartbeat，否则陈旧标记无对象可测）：

    cardIds  = ["dod-fresh-task","dod-stale-task"]
    ganttIds = ["dod-fresh-task","dod-stale-task"]      ← 逐条一致
    fresh 行无 stale 标记；stale 行渲染 data-testid="quay-panel-inflight-stale"
    每行渲染 data-testid="quay-panel-inflight-heartbeat"（2/2）
    截图：/tmp/quay-inflight-dod.png

截图可见：Loop pulse 两条杆（implementing 蓝 / fan-in 紫）与 In flight 卡两行同名；`dod-stale-task` 一行带红色 `stale` 标记。

### 窄测试

    npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/quay.service.test.ts   → 31 pass / 0 fail
    npx vitest run src/modules/quay/tests/QuayPanel.test.tsx                                        → 22 pass
    npm run typecheck                                                                              → exit 0
