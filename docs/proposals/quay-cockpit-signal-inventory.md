# Quay tab 与驾驶舱：需要通知/提醒的事务与状态梳理（讨论稿）

| 项 | 值 |
|---|---|
| 状态 | **讨论稿（未定）**——只做清点与分类，不含任何实现决定 |
| 日期 | 2026-10-25 |
| 目的 | 按用户的顺序：先在 quay tab 与驾驶舱明确「哪些事务/状态需要通知或提醒」，再设计 Chat 页的显示与交互。前置约束见 `notice-registry-and-dismissal.md` 的「暂停说明」 |
| 依据 | `src/shared/types.ts` 的 `QuaySnapshot` 与相关类型、`QuayPanel.tsx` / `CockpitPage.tsx` / `DecisionQueue.tsx` / `DeployReadiness.tsx` 的现有渲染、`fleet-overview-SPEC.md` §5、`context-layers-and-delegation-ladder.md` §4 |

**读法**：「已核对」＝读过类型或渲染代码；「推断」＝我据设计文档或命名判断、未读到实现。每一行回答五件事：它是什么、生命周期（`state` 条件成立期间存在 / `event` 发生一次 / `decision` 待人裁决）、谁需要行动、现在怎么呈现、是否值得升级为提醒。

---

## 1. Quay tab 现有的状态与事件

| # | 状态/事件 | 来源字段 | 生命周期 | 谁行动 | 现有呈现 | 候选 |
|---|---|---|---|---|---|---|
| Q1 | driver 状态 `stale` / `unavailable`（`running` / `idle` / `not-configured` 为常态） | `snapshot.driver.state`（已核对：五个取值） | state | 人（拉起或排查） | 面板头部徽标，`stale` 为琥珀色 | **强候选**：系统停摆而无人知晓是最贵的静默故障 |
| Q2 | 任务进入 `needs-human` | `tasks.byStatus` | state→decision | 人 | 状态计数 | **强候选**：卡在人手里的任务不会自己推进 |
| Q3 | 带 Blocker 的任务及其影响面（依赖方数量、同签名合并次数、起始时间） | `snapshot.blockers[]`（已核对） | state | 人或 worker | 脉搏条阻塞行；面板 | **强候选**，但要带阈值：同签名重复出现、或依赖方 ≥ N、或持续超过 T |
| Q4 | 全量 suite 红 | `tests` / `QuaySuiteState.state`（已核对结构，具体取值未逐个核对） | state | worker 或人 | Tests 卡片、脉搏条 suite 行 | 候选：单次红多为抖动，**连续红**才值得提醒 |
| Q5 | fan-in 尝试失败、重试、ff 竞争 | `fanIn.recent[].outcome`（已核对为字符串，取值集合未核对） | event | 多数无需人 | Fan-in 卡片、脉搏条 fan-in 行 | 弱候选：单次失败是常态噪音；**反复失败或停滞**才升级 |
| Q6 | fan-in 成功/任务已合入 | 同上 | event | 无 | 同上 | **仅进事件流**，不提醒；供「你发起的事已合入」这类与会话相关的呈现取用 |
| Q7 | 在飞任务心跳过期（>5 分钟） | `inFlight[]`，`IN_FLIGHT_STALE_AFTER_MS = 300000`（已核对） | state | 人（排查 worker） | 面板中该行标 stale | 候选：与 Q1 同属「系统在不在干活」，应合并成同一类 |
| Q8 | 配置问题（`configIssues.errors > 0`） | `configIssues`（已核对） | state | 人 | 面板 | 候选：低频但一旦出现会让后续一切无效 |
| Q9 | 项目未向 quay-fleet 登记（`fleetProjectId` 为 `null`）；fleet 契约不兼容/握手未完成 | `fleetProjectId`、`fleetState`（已核对） | state | 人（配置） | 面板与驾驶舱各有一行说明 | 候选：属于「配置/接线」类，与 Q8 合并 |
| Q10 | 甘特/在飞读数缺失（`ganttUnavailable`）、快照来自缓存 | `ganttUnavailable`、`cached`（已核对） | state | 无 | 卡片内说明 | **不提醒**：是读数质量说明，不是事务 |
| Q11 | 任务/目标/ADR 的计数与分布 | `tasks`、`goals`、`adrs` | state | 无 | 计数 | **不提醒**：背景信息 |

## 2. 驾驶舱现有的状态与事件

| # | 状态/事件 | 来源 | 生命周期 | 谁行动 | 现有呈现 | 候选 |
|---|---|---|---|---|---|---|
| C1 | 待裁决的升级（带选项、证据、首次出现时间） | `decisionQueue[]`（`attentionId`，已核对） | decision | 人 | `DecisionQueue` 卡片 | **强候选**：这是系统「必须等人」的最纯形态，且已有完整模型 |
| C2 | initiative 被阻塞（`blocked`、`blockedSince`） | `InitiativeReading.charter`（已核对字段） | state | 人 | 驾驶舱 initiative 视图 | 候选：与 C1 同源（升级未裁决即阻塞），应合并 |
| C3 | 哪个项目「需要你」 | `cockpit.fleetNeedsYou` / `attentionProject`（已核对存在，聚合规则未读） | state（聚合） | 人 | 页头一行琥珀文字 | **这已经是一个提醒原型**：值得读清楚它的聚合规则，作为统一模型的起点 |
| C4 | 部署：有未构建变更 / 已构建待重启 | `DeployReadiness`（已核对） | state | 人（确认后构建重启） | 驾驶舱完整部署条 | 与 Chat 页**无关**；候选放在驾驶舱/主机级面，是否打断需另议 |
| C5 | 部署失败、重启后核验失败 | `failure`、`lastDeploy.ok === false`（已核对） | state | 人 | 同上，红色文字 | **强候选**：失败不能被忽略 |
| C6 | 部署核验通过 | `lastDeploy.ok === true` | event | 无 | 「Last deploy … verified」 | 仅进事件流；当前常驻显示是噪音 |
| C7 | initiative 自决审计抽样 | `audit[]`、`auditRatio`（已核对） | event | 人（抽查） | 驾驶舱审计区 | 弱候选：属于「系统替你做了什么」的 L3 自述，应可回看而非提醒 |
| C8 | 语音/输入错误、意图未匹配、发送预览待确认 | `cockpit-voice-error`、`cockpit-intent-unmatched`、`cockpit-send-preview` | event / decision | 人（当场） | 页内就地提示 | **不进统一机制**：是交互反馈，生命周期是秒级、就地 |

## 3. 归并后的类别（供讨论，不是定论）

| 类 | 含义 | 包含 | 提醒强度的初步倾向 |
|---|---|---|---|
| **A 待裁决** | 系统必须等人，否则不会推进 | Q2、C1、C2（以及会话内的权限请求） | 最高：需要可见且不可忽略，直到裁决 |
| **B 系统停摆/退化** | 系统不在干活或干得不对，且无人察觉代价高 | Q1、Q7、Q3（带阈值）、Q4（连续红）、Q5（反复失败）、Q8、Q9、C5 | 高：状态型，按 revision 忽略；失败类不可忽略 |
| **C 进展跃迁** | 值得知道、不需行动 | Q6、C6 | 低：只进事件流/feed，不弹提醒 |
| **D 背景读数** | 读数质量与计数 | Q10、Q11、C7（回看用） | 无：不进提醒，仅在面板中呈现 |
| **E 就地交互反馈** | 秒级、与当下操作绑定 | C8 | 不属于统一机制 |
| **F 主机级运维** | 与具体会话/任务无关的应用状态 | C4（C5 属 B） | 仅驾驶舱/主机级面；是否打断待定 |

## 4. 需要用户裁定的问题

1. **B 类的阈值**：suite「连续红几次」才提醒？fan-in「几次失败或停滞多久」才提醒？Blocker「依赖方 ≥ 几个」或「持续 ≥ 多久」？这些要用真实历史数据校准，不应拍脑袋。
2. **谁是受众**：提醒面向「正在驾驶舱的人」，还是也包括「某个具体会话的发起者」？这直接决定后面 Chat 页该显示什么（Chat 页只应显示与该会话有直接关系的那部分）。
3. **A 类能否不可忽略**：待裁决项在被处理前一直在，是否接受它们永远占一个固定位置？
4. **C3 的聚合规则**：驾驶舱页头的「某项目需要你」是怎么算的？它是否就是 A、B 类的现成聚合？需要读清楚后再决定是否以它为模型起点。
5. **F 类（部署状态）放哪里**：驾驶舱已有完整部署条；是否还需要在侧边栏或项目级面提示？这与 Chat 页无关，可独立决定。
6. **事件流**：C 类是否按 `fleet-overview-SPEC` P4 的方向进入主机级事件流与 feed？该流的存储归属（quay-fleet 还是 CloudCLI）仍在 `context-layers` §4.1 中待与 fleet 对齐。

## 5. 本稿没有做的事

- 没有核对各取值集合（fan-in `outcome`、suite `state` 的全部取值）。
- 没有读 C3 `attentionProject` 的聚合实现。
- 没有量化任何阈值，也没有统计各类事件的历史频率。
- 没有涉及 Chat 页；按约定那是下一步，等本稿的类别与问题裁定之后。
