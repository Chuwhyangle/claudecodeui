---
id: gap-live-monitor-48h-replay-experiment
title: Live Monitor 实验：用 CloudCLI 各 Quay 项目最近 48h 的真实载体回放事件，验证去重去抖 / 失败恢复合并 /
  语义增量 / Ignore-Record-Notify-Escalate 分级，并给出误报漏报、指标和数据缺口
status: done
labels:
  - gap
  - experiment
parent: null
children: []
extra:
  schema: execution
---
## Proposal

背景：用户已同意做一个跨项目 Live Monitor 实验。要回答的问题是：只看 Quay 已有的载体、不新增任何埋点，一个监视器在 CloudCLI 全部 Quay 项目（archguard、cantus、claudecodeui、meta-cc、quay、quay-fleet）的真实事件上能不能做到「少打扰、不漏关键」？关注的是每个项目的 Quay 快照（tasks/goals/driver/tests/fan-in/inFlight）和与之关联的会话，不只是 quay 这一个项目里的会话。查重（2026-10-11）：本仓库 tasks/goals/proposals 里没有 Live Monitor 或事件回放相关的任务；`gap-ac200-monitor-event-projection-collapse`（转写里折叠 Monitor 工具事件）和 `gap-cloudcli-quay-snapshot-inflight-tasks`（快照里补 inFlight 读数）是相邻的，但都不覆盖这件事。

做法：在 `experiments/live-monitor-replay/` 写一个只读的最小回放原型，规则和阈值在看结果之前固定在 PREREG.md 里。
- `collect.mjs`：读取每个项目的 `.quay/{worker,promotion}-round.jsonl`、`worker-outcome.jsonl`、`verification-round.jsonl`、`fan-in-ff-escalations.jsonl`、`task-status-events.jsonl`，加上 `git log develop -- tasks/` 里的 `status:` diff。窗口开始前就已经停在 needs-human 的 task 用 seed 补进来，task 正文按 `now` 时刻的 git 树读取。每条事件都带可回查的证据（`file@byte` 或 `git sha`）。
- `lib.mjs`：四段管线。① 机械去重去抖：心跳投影不变就丢弃，变化须持续 ≥2 轮且 ≥120s。② 失败恢复合并：6h 内落地或转绿的失败合成一条 Record。③ 语义增量：按实体维护状态，跨源回声直接丢弃。④ 分级，并用计时器触发 needs-human 24h 过期、失败 ≥3 次、驱动停摆 30min；另外处理发布依赖和跨项目上游落地唤醒下游。
- `replay.mjs`：关联 worker 会话（来自 `session_id`）和提到该 task 的其它会话；用结局派生标签给原型和「天真监视器」打分。

原型已实现，提交在分支 `proto/live-monitor-replay`（c9ee5858），不在 develop 上。结果见该分支的 `experiments/live-monitor-replay/RESULT.md` / `NOTIFICATIONS.md`。窗口 2026-10-08T17:00Z → 10-10T17:00Z：40,513 条原始事件 → 59 条告警（Notify 39 / Escalate 20），天真监视器是 291 条；precision 0.84 对 0.40；漏报 2 个，都是窗口边界造成的；误报 6 个，全是失败类规则打在最后自愈的 task 上。运行中发现并修掉了 4 个真实问题（心跳的 needs_human 是「本轮新停派」；`committed:false` 跨源竞态；窗口前的 needs-human 看不见；线上系统在回放过程中变化）。数据缺口一共 10 条，最大的是 G1：状态迁移的执行者无法识别，所以「真实人工决策」没法验证。

## AC

- [x] AC1 查重并建档：本任务存在，Proposal 写明了查重结论（没有既有 Live Monitor/回放任务）和相邻任务的边界。
- [x] AC2 真实输入、零伪造：`node experiments/live-monitor-replay/collect.mjs --now 2026-10-10T17:00:00Z` 只读 6 个项目的真实载体和 git 史，输出覆盖面（RESULT.json `coverage`）。单元夹具只出现在 `lib.test.mjs` 里，并且注明了不进入回放。
- [x] AC3 四段管线 + 四级分级已实现，并有单测：`node --test experiments/live-monitor-replay/lib.test.mjs` 15/15 通过，覆盖去抖抖动、失败合并、red→green、跨源回声、`committed:false` 或已 done 的陈旧停派、隐式出口、needs-human 过期（包括窗口前的）、发布依赖、跨项目唤醒（只唤醒一次 / 下游已 done 时不唤醒）、打分。其中一条做过变异验证：删掉 done 守卫后对应用例会红。
- [x] AC4 五个指定场景在真实数据上都有读数和证据（RESULT.md §4）：needs-human 过期 7 条 Escalate；发布依赖 1 个 task（gantt-integration 的「解除条件：quay 出正式发布」）；88 次 suite red 合并成 38 条 red→green；跨项目 1 条（quay/gap-dashboard-kernel-not-packaged-in-plugin-artifact → claudecodeui/gap-quay-tab-loop-pulse-gantt-integration）；38 段 needs-human 按停派原因和出口分好了类。
- [x] AC5 输出了带证据的通知流、误报漏报、指标和数据缺口：NOTIFICATIONS.md 里每行都带证据指针（抽检 `file@byte` 和 `git sha` 都能取回原记录）；RESULT.md §3 给了误报和漏报清单，§2 给了压缩比，§6 列了 G1–G10；事后修改的发布规则 v1/v2 两组读数都列出来了。
- [x] AC6 人裁定 D1：「≥3 次失败最终落地」算误报还是值得通知的成本信号。裁定写进本任务 `## Resolution`。（待外部）
- [x] AC7 人裁定 D2：机械停派（17 段里 16 段回到 todo）是否在 G1 补上之前降为 Record。裁定写进本任务 `## Resolution`。（待外部）
- [x] AC8 人工抽检 D3：在 NOTIFICATIONS.md 里抽 ≥10 条（含全部 6 条误报、7 条过期和那条跨项目通知），标「该不该打扰」，写进 `## Resolution`，作为 G10 的校准。（待外部）

## DoD

- AC1–AC5 的产物都在 `proto/live-monitor-replay` 分支上，可以复现：`node collect.mjs --now 2026-10-10T17:00:00Z && node replay.mjs`。前提是载体还没被轮转（G9）。
- 回放全程只读：没有写任何项目的 `.quay/`、`tasks/` 或会话目录，也没有影响正在运行的 driver/worker。
- AC6–AC8 由人完成之后，才决定是把原型并进 develop（再立产品化任务，例如服务端 monitor 模块和 Quay 面板里的通知流），还是只把结论留作记录。本任务不做产品化。

## Touches

- tasks/gap-live-monitor-48h-replay-experiment.md
- experiments/live-monitor-replay/PREREG.md (new)
- experiments/live-monitor-replay/RESULT.md (new)
- experiments/live-monitor-replay/NOTIFICATIONS.md (new)
- experiments/live-monitor-replay/collect.mjs (new)
- experiments/live-monitor-replay/lib.mjs (new)
- experiments/live-monitor-replay/replay.mjs (new)
- experiments/live-monitor-replay/lib.test.mjs (new)

## Resolution

**人 yale 2026-10-11 的两条裁定（D1 / D2）**：

- **D1 = 成本信号（值得打扰）**：「≥3 次失败但最终落地」**不**按误报计，而记成**成本信号**。依据（本任务 RESULT.md 逐字）：那 6 条按「结局」算误报，但**按成本不一定**——"前三个分别烧了 8–10 个 worker 会话才落地"。判成误报会把最贵的失败静音。
- **D2 = 机械停派降为 Record**：在 G1（状态迁移的执行者不可识别）补上之前，17 段机械停派**降为 Record**；`human-decision` 只对 `task_write` 写入的停派发 Notify。依据：17 段里 **16 段回到了 todo**，而"谁做的决定**从数据里看不出来**（G1）"——对它们发 Notify 等于把机器自愈报成人工事件。

**D3 抽检样本（人 yale 填「该不该打扰」列；取自 `proto/live-monitor-replay` 的 NOTIFICATIONS.md，14 条 = 全部 6 条误报 + 7 条过期 + 1 条跨项目）**：

| # | ts (UTC) | 级别 | 规则 | 项目 | task | GT | 该不该打扰 |
|---|---|---|---|---|---|---|---|
| 1 | 2026-10-09T03:13 | Escalate | failure-streak (failures=3) | claudecodeui | gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged | GT- | **打扰** |
| 2 | 2026-10-09T06:51 | Escalate | failure-streak (failures=3) | claudecodeui | gap-mcp-session-send-reports-pending-interaction-it-queued-behind | GT- | **打扰** |
| 3 | 2026-10-09T11:02 | Escalate | failure-streak (failures=3) | quay | gap-routine-semantic-dedup-scan-parse-args-handrolled-variants | GT- | **打扰** |
| 4 | 2026-10-09T11:21 | Escalate | failure-streak (failures=3) | claudecodeui | gap-debug-agent-simulates-permission-popup-for-mcp-e2e | GT- | **打扰** |
| 5 | 2026-10-09T14:04 | Notify | failure-unrecovered | claudecodeui | gap-ac120-upload-input-locator-ambiguous | GT- | Record |
| 6 | 2026-10-09T20:24 | Notify | failure-unrecovered | quay | gap-ownership-replay-benchmark-redesign-two-stage | GT- | Record |
| 7 | 2026-10-08T17:00 | Escalate | needs-human-expired | quay-fleet | gap-pwa-ac077-antishadow-control-splice-exact | GT+ | Record |
| 8 | 2026-10-08T17:00 | Escalate | needs-human-expired | quay | gap-retire-needs-human-cause-enumeration | GT+ | Record |
| 9 | 2026-10-08T17:00 | Escalate | needs-human-expired | claudecodeui | gap-server-phase-concurrency-clamp | GT+ | Record |
| 10 | 2026-10-08T17:00 | Escalate | needs-human-expired | quay-fleet | gap-ac014-duplicate-sessionkey-from-resume | GT+ | Record |
| 11 | 2026-10-08T17:00 | Escalate | needs-human-expired | quay-fleet | gap-ac009-criterion-transient-cli-unavailable | GT+ | Record |
| 12 | 2026-10-10T06:22 | Escalate | needs-human-expired | claudecodeui | gap-voice-realtime-microphone-human-smoke-test | GT+ | **打扰** |
| 13 | 2026-10-10T10:22 | Escalate | needs-human-expired | claudecodeui | gap-quay-tab-loop-pulse-gantt-integration | GT+ | **打扰** |
| 14 | 2026-10-09T11:37 | Notify | cross-project-upstream-landed | claudecodeui | gap-quay-tab-loop-pulse-gantt-integration | GT+ | **打扰** |

**AC8（D3）仍未勾**：上表由人 yale 标记后写回本段即可勾。**本任务保持 `needs-human`、⛔ 不退回重派**——其 DoD 明写"AC6–AC8 由人完成之后，才决定是把原型并进 develop（再立产品化任务），还是只把结论留作记录"；提前退它进循环会让 worker 把原型直接并进 develop，那不是本 DoD 的形态。

**D3 结论（2026-10-11，人 yale 采用 manager 建议的标记）**：14 条中 **打扰 7 条 / Record 7 条**——

- **打扰（7）**：#1–4（failure-streak=3 且最终落地：正是 D1 裁定的适用对象，且是最贵的几条——各带 7–8 个 worker 会话、提及 24–84）、#12（mic smoke test 是真·人工门，>24h 到期对人是有效信号）、#13（甘特图那条当时正等机制裁定 A/B/C）、#14（跨项目上游落地唤醒被挡下游，正是"不漏关键"那类）。
- **Record（7）**：#5–6（同族但 `failures=1`——单次失败是正常翻腾，D1 的阈值 ≥3 就是那条线）、#7–11（**五条时刻都恰好是 `2026-10-08T17:00` 窗口起点、无 worker 会话** ⇒ 它们是"窗口前就已停"的 seed 段，不是窗口内新发生的事件；且按 D2，执行者不可识别（G1）前不发 Notify）。

**两条规则级决定（同批采纳）**：

1. **过期规则不得对"窗口前遗留"发单条告警**：应改为**积压摘要**（一条"另有 N 条早于窗口的停派"），否则每次冷启动都会重放一批历史噪声。
2. **先补 G1，再谈产品化 ⇒ 本次决定：不把原型并进 develop**。结论与 PREREG 留在 `proto/live-monitor-replay` 分支；后续工作另立任务 `gap-live-monitor-g1-executor-and-rule-rerun`（补 G1 取证 + 按 D1/D2 改规则 + 同一窗口重跑做前后对照），两个读数出来再定产品化。理由：本实验最大数据缺口就是 G1（状态迁移的执行者不可识别），而 **D2 的裁定本身就依赖 G1** 才能落地（"降为 Record"的前提是能区分机械 vs 人工）。
3. 附带登记：2 条漏报都是**窗口边界**造成的 ⇒ 产品化时边界要显式处理（或把窗口前端对齐到最后一个完整事件），否则每次都会有这对固定漏报。
