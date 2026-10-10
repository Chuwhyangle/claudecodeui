# CloudCLI AI Manager：把 Monitor Chat 升级成跨项目常驻的 Manager Agent

状态：**设计草案**（2026-10-11）。本文记录人 yale 与 agent 最近一轮 AI Manager 讨论的结论，
**不实现任何东西**，也**不改变**任何现有 GOAL 的验收范围。

## 0. 读法与来源

### 0.1 哪些是已达成的，哪些是本文展开的

讨论中达成一致的是下面这 10 条**方向性结论**（§1 的表格）。本文其余部分是把这些结论展开成可检查的设计，
展开出来的细节（字段、阈值、表格里的具体分级）都是**草案**：凡是标了「草案」或「待定」的地方，都还没有人裁定，
后续修订可以改。

### 0.2 与既有设计的关系：只补充，不覆盖

本文建立在以下文档和机制之上。它们的内容一律**原样保留**；本文和它们有张力的地方集中列在 §11，
不在这里悄悄改口径。

| 已有设计 | 本文从中继承什么 |
|---|---|
| `docs/proposals/voice-native-control-plane.md` §12（多会话聚合/编排前端）、§12.3（协调层五个能力） | Manager 就是 §12 所说的「前端协调层」；本文把它从「语音前端」改成「不绑定任何界面的 agent」 |
| 同上 §12.6（Multimodal Engineering Workspace、三层信息架构、注意力管理、§12.6.6 Quay 是状态权威） | Manager 读 Quay，不自建第二份任务状态机（§3.2） |
| 同上 §13（证据计划）、§14.4（跨项目信任边界未决） | 指标（§8）沿用 §13 的「先写判定标准再取数」纪律；§14.4 由 §6 的 L0–L3 正面回应，但仍待裁定 |
| `docs/proposals/agent-native-semantic-ui-vision.md` §5.2（global scope 是 quay manager 层的事） | Manager 是这一层的宿主/客户端，不重新实现 Quay 的项目内机制（§3、§11） |
| `quay:manager` skill（第三层：规划/排序/看趋势；§1.5 ask-vs-act；§1.6 事件 triage；四条「不做」边界） | §1.5 是 §6 授权分级的雏形；§1.6 是 §5 事件过滤的雏形；四条边界在 §3 原样保留 |
| `docs/proposals/mcp-gateway-SPEC.md`（CloudCLI MCP：`overview`、`sessions_list`、`session_send`、`quay_snapshot`、scope 词表） | Manager 的 Observe/Act 原语 |
| `docs/proposals/claude-resident-sessions.md`（常驻会话、无人轮） | 持久 Manager 的运行底座 |
| GOAL-032 / AC-314（工作台架构规格，draft） | 本文的 Portfolio 层是 AC-314 规格要覆盖的数据归属问题之一；本文**不替代** AC-314 要求的 `multimodal-engineering-workspace-SPEC.md` |
| 实验 `experiments/live-monitor-replay/`（任务 `gap-live-monitor-48h-replay-experiment`，分支 `proto/live-monitor-replay`） | §5 的管线和 §9 的回放直接从这次实验来 |

## 1. 已达成的方向（10 条）

| # | 结论 |
|---|---|
| D1 | **Monitor Chat 升级成跨项目、常驻的 Manager Agent**。Chat 和 Live Voice 都只是它的**界面**，不是它本身。 |
| D2 | Manager 的工作是一个闭环：**Goal → Observe → Assess/Decide → Act/Delegate → Verify → Learn/Report**。 |
| D3 | **分层职责**：CloudCLI 负责跨项目的状态和会话；Quay 负责项目内的 Driver、Gate 和验收。 |
| D4 | Manager 的输入靠**订阅**，再经过**事件过滤**和**语义增量判断**，不是轮询全量。 |
| D5 | 行动按 **L0–L3 授权**分级，有 **Decision Budget**，越界时**升级给人**。 |
| D6 | 管理行为由**版本化的 Management Policy / Playbook** 约束，并且从反馈中学习。 |
| D7 | 用 5 个指标衡量：**Human Attention Cost、Autonomous Resolution Rate、Goal Lead Time、Intervention Quality、Escalation Quality**。 |
| D8 | 已有的历史事件回放扩展成 **Shadow Mode Manager Action Replay**。 |
| D9 | **先做单个 Manager，以后再层级化**。 |
| D10 | 设计先成文，再取证，然后才实现（本文就是这一步）。 |

## 2. 定位：Manager 是 agent，Chat 和 Live Voice 是界面

**之前**：「Monitor Chat」是一个会话，在里面看事件流、问状态。它的生命周期跟着这个会话走，
上下文也只在这个会话里。

**之后**：Manager Agent 是一个**常驻实体**，自己持有：
- 当前在管的 Goal 集合；
- 订阅；
- 决策记录；
- 所用 Policy 的版本。

各种界面只是它的不同入口：

| 界面 | 角色 |
|---|---|
| Chat（文字） | 详细对话、查证据、下指令 |
| Live Voice | 简报、异常提醒、必要时的口头裁定（与 `voice-native-control-plane.md` §12.6.3 一致：语音不是主要输出通道） |
| Portfolio 视图 / 通知 | 被动呈现 Manager 的 Report 和升级 |
| CloudCLI MCP 外部客户端 | 另一个人类入口（例如手机上的 ChatGPT） |

推论（草案）：
- 换界面不换 Manager。在 Live Voice 里说的话和在 Chat 里打的字，进的是**同一个** Manager 上下文。
- Manager 的持久状态不放在任何一个聊天会话的 transcript 里（§3.2）。

## 3. 分层职责

### 3.1 谁负责什么

| 层 | 负责 | 不负责 |
|---|---|---|
| **人** | 方向、优先级、资源裁定；Policy 的批准；L3 决策；升级的最终处置 | 轮询状态；在会话之间转述信息 |
| **CloudCLI Manager Agent** | 跨项目目标跟踪；订阅、过滤、判断；把事情委派给合适的项目或会话；跨项目依赖的协调；验证委派结果是否被 Quay 认可；向人报告和升级；从反馈中学习 | 项目内的任务执行、验收和 gate（交给 Quay）；写项目代码；在 Quay 之外再建一份任务状态 |
| **CloudCLI 平台**（server） | 跨项目的状态汇聚（`QuaySnapshot` 等投影）；会话、宿主和运行（session hosts、chatRunRegistry）；MCP 控制面；鉴权和 scope | 判断「该做什么」（那是 Manager 的事） |
| **Quay**（各项目内） | task/goal 的权威状态；promotion/worker driver；gate 与验收（`task check`、fan-in、full suite）；needs-human 的停派 | 跨项目的优先级和协调 |
| **项目会话 / worker** | 执行具体任务 | 跨项目的视角 |

### 3.2 Manager 自己的状态：只有「管理状态」，没有「任务状态」

Manager 可以持久化的东西（草案）：
- Goal 跟踪表（只是对 Quay goal/task 的**引用**，不是副本）；
- 订阅；
- 决策日志（每次 Act/Delegate 的前因、授权级别、预算消耗和结果）；
- Policy 版本；
- 反馈记录。

任务、goal、driver、测试的**状态**一律从 Quay 只读接口读取。这是 `voice-native-control-plane.md` §12.6.6
立场在 Manager 上的直接应用。

### 3.3 `quay:manager` 的四条边界原样保留

1. 不写任务正文、AC、DoD。
2. 不跑验证、不构造负对照、不逐行审计声明。
3. 不调试任何项目自己的代码、测试或 CI。
4. 不直接改任何项目的代码。

Manager 需要某个项目内动作时，走 **Delegate**：通过 `session_send` 交给项目会话，或者通过 Quay 的 ABI 由项目自己的
outer 去做。如果 Manager 需要一种新的观测能力，交付物是「对项目层或 CloudCLI 平台提的需求」，
不是 Manager 自己手写的脚本。这一条与 `quay:manager` 的 Mechanical boundary signal 相同。

## 4. 闭环（D2）

| 阶段 | 做什么 | 输入 / 原语（现有的） | 产出 |
|---|---|---|---|
| **Goal** | 维护「在管什么、怎样算完成」 | Quay goals/ACs（`goal_list`/`goal_get`）；人在 Chat/Voice 里给的意图 | Goal 跟踪表 |
| **Observe** | 订阅、接收事件 | `QuaySnapshot`（tasks/goals/driver/tests/fan-in/inFlight）、`.quay/*.jsonl` 载体、`overview`/`sessions_list`、会话的待回答交互（`pendingInteraction`/`awaitingUser`） | 规范化事件 |
| **Assess/Decide** | 过滤；判断语义增量；按 Policy 选动作和授权级别 | Policy/Playbook、Decision Budget | 决策：Ignore / Record / Notify / Escalate，或某个具体动作 |
| **Act/Delegate** | 在授权范围内自己做，或者交给项目 | `session_send`、Quay lifecycle verbs（受 L 级约束）、通知 | 决策日志条目 |
| **Verify** | 由 Quay 的 gate 来证明结果，不信任「已完成」的自述 | `task_check`、fan-in 结局、suite 轮次 | 验证结论 |
| **Learn/Report** | 汇总给人；把人的反馈记成 Policy 候选修订 | 反馈记录 | 简报；Policy diff 提案 |

**Verify 必须引用 Quay 的判据**。Manager 不自己判定「做完了」。这和 `quay:manager` 第 2 条边界一致：验收是 Quay 的。

## 5. 订阅、事件过滤与语义增量（D4）

### 5.1 订阅（草案）

订阅的单位是 `(scope, 事件类别, 条件)`。
- scope 取值：portfolio / 项目 / goal / task / 会话。
- 默认订阅：每个项目的 needs-human 进出、失败链、suite 红绿、driver 健康、在等人回答的会话，以及 Goal 相关 task 的状态迁移。
- 订阅本身也是 Manager 的管理状态，可以由人调整，也可以由 Policy 生成。

### 5.2 过滤与增量判断管线

这条管线在 48h 回放实验中已经用真实数据跑过一次。实验结果在 `experiments/live-monitor-replay/RESULT.md`
（分支 `proto/live-monitor-replay`）：

1. **机械去重去抖**：心跳投影不变就丢弃；变化须持续 ≥2 轮且 ≥120s。
   - 实测：39,200 条心跳里 38,803 条与前一轮相同。
2. **失败恢复合并**：6h 内自行落地或转绿的失败合并成一条 Record。
   - 实测：148 次失败里 92% 属于这种情况。
3. **语义增量**：按实体维护语义状态，只有状态变了才放行，跨数据源的回声被吸收。
4. **分级**：Ignore / Record / Notify / Escalate，外加计时器：
   - needs-human 停留 24h 过期；
   - 失败 ≥3 次未落地；
   - driver 停摆 30min。

实测读数：48h 内 40,513 条原始事件 → 59 条告警。对照「每条原始事件都发通知」的天真监视器，
precision 是 0.84 对 0.40。

这条管线就是 `quay:manager` §1.6「判据不是事件本身，而是该动而没动的东西」的机械化形态。

### 5.3 实验已证实的约束（设计必须吸收）

- **跨源竞态要按载体语义处理**。心跳里的 `needs_human` 表示「本轮新停派」，不是常驻集合；`committed:false`
  的停派在 store 里根本没有发生。
- **窗口开始前就存在的状态要先 seed**，否则过期规则看不见长期悬挂的 needs-human。
  例如 quay-fleet 有 3 个 task 已挂 18–21 天，而它的 driver 一直静默。
- **数据缺口**（实验 RESULT.md §6，G1–G10）直接限制了 Manager 能判断什么，最关键的三条：
  - **G1 状态迁移的执行者无法识别**：git 作者恒定，`cli:<pid>` 映射不到会话。所以「是人做的决定还是机器自己恢复的」
    分不出来，Intervention Quality 和 Escalation Quality（§8）也就算不出来。
  - **G2 没有发布事件的载体**。
  - **G4 非 worker 会话与 task 之间没有结构化的关联**。

## 6. 授权分级、Decision Budget 与人类升级（D5）

### 6.1 L0–L3（分级是共识，每级包含哪些动作是草案）

| 级别 | 含义 | 动作举例（草案） | 需要人吗 |
|---|---|---|---|
| **L0 观察** | 只读 | 读快照和会话；生成简报；Record | 不需要 |
| **L1 建议** | 提出，不执行 | Notify；草拟任务或 Policy 修订供人审；给出排序建议 | 人决定是否采纳 |
| **L2 有界执行** | 在 Policy 授权、预算之内自己做，事后报告 | 把 Quay 已产出的发现转述给另一个会话（`session_send`）；对已有 Playbook 覆盖的停派按 Playbook 重派；调整订阅 | 事后知会，可撤回 |
| **L3 需人批准** | 改变方向、范围、优先级或资源；不可逆；对外发布 | 改 AC 或 goal 方向；跨项目重排优先级；发布或 push；给会话授予更高权限；回答安全敏感的审批 | 事前必须有人批准 |

分级标准沿用 `quay:manager` §1.5 ask-vs-act：
- 动作是「已声明的 AC 所蕴含的」：可以在 L2 内做。
- 动作「改变 AC 本身、范围、优先级或资源」：一律 L3。

执行层面的危险操作审批，继续复用 Claude Code 的 `canUseTool`/`approval_answer` 和既有的 pending-interaction
可见性，与 `voice-native-control-plane.md` §12.6.8 一致。L0–L3 约束的是 **Manager 自己的行动权限**，
不是另建一套逐操作审批界面（这一点的张力见 §11 T1）。

### 6.2 Decision Budget（草案）

每个时间窗内，Manager 可以自主（L2）做出的决策有一个上限，按维度分别计：
- 决策条数；
- 被影响的项目和 task 数；
- 消耗的 worker 会话或计算量；
- 可打扰人的次数（Notify 预算，直接对应 Human Attention Cost）。

预算用完之后，后续 L2 动作自动降为 L1（只建议）。预算的消耗记进决策日志，并在 Report 里汇报。

### 6.3 人类升级（草案）

以下情况一律 Escalate：
- 动作超出授权级别；
- 预算耗尽；
- Policy 没有覆盖到的情形；
- 实验里验证过的计时器触发：needs-human 过期、失败 ≥3 次、driver 停摆、静默项目里挂着 needs-human。

一条升级应该带上：
- 证据指针（与回放实验 NOTIFICATIONS.md 的 `file@byte` / `git sha` 同一种形式）；
- Manager 自己的建议；
- 可选的处置项；
- 如果人不回应会发生什么。

## 7. 版本化的 Management Policy / Playbook 与反馈学习（D6）

- **Policy**：声明式的规则集合，包括订阅默认值、过滤阈值、分级规则、L 级映射和预算。每次生效都有版本号，
  每一条决策日志都记录当时的 Policy 版本。
  - 形态是草案：例如一个带版本号的 YAML/Markdown 文件，放在 CloudCLI 侧，**不放进**任何项目的 `.quay/`。
- **Playbook**：针对具体情形的处置步骤。例如「机械停派后回到 todo」「发布依赖等待上游 tag」「跨项目上游落地后唤醒下游」。
  每个 Playbook 声明自己最多需要的 L 级。
- **反馈学习**：人对 Notify/Escalate 的反馈是学习信号，包括「该/不该打扰」、对 L1 建议的采纳或否决、
  对 L2 动作的撤回。这些信号**只产出 Policy diff 提案**，经人批准后形成新版本生效。Manager 不静默自改规则。
  - 新版本上线之前，必须先过一遍 §9 的 Shadow 回放，与旧版本做对比。

## 8. 指标（D7）

5 个指标是已达成的；下面的口径是草案，按 `voice-native-control-plane.md` §13.4 的纪律，在取数之前写进 PREREG。

| 指标 | 口径（草案） | 现在能不能算 |
|---|---|---|
| **Human Attention Cost** | 单位时间里 Manager 让人花的注意力：Notify 和 Escalate 的条数，按「人需要读或回应」加权；再加上人主动去轮询的次数 | **能算部分**：回放实验给出了约 30 条告警/天的基线，对照天真监视器约 145 条/天 |
| **Autonomous Resolution Rate** | 需要处置的情形里，Manager 在 L0–L2 内解决、且之后由 Quay 判据证实已解决的比例 | **不能**：需要 Manager 真的行动过；回放里只能在 Shadow 模式下估算（§9） |
| **Goal Lead Time** | 从 Goal 激活（或人提出意图）到它的 AC 全部经 Quay 判据通过的时间；拆成 Manager 造成的等待和执行本身的时间 | **能算部分**：Quay goal/task 的时间戳都在，但「人提出意图」的时刻没有记录 |
| **Intervention Quality** | Manager 的 L1/L2 动作里，人认可（未撤回、被采纳）且结局正确的比例 | **不能**：被 G1（执行者不可识别）阻塞 |
| **Escalation Quality** | 升级的 precision（这次升级是否真的需要人）和 recall（需要人的情形是否都升级了，且在它的出口之前） | **能算代理指标**：回放给出了基于结局标签的 0.84/0.94，但其中 recall 有一大半是循环定义（实验 RESULT.md §3）；真值需要人工抽检，即该任务的 AC8 |

## 9. Shadow Mode Manager Action Replay（D8）

把 48h 的事件回放从「判断要不要通知」扩展成「判断 Manager **会做什么**」，规格是草案：

1. **输入**：与现有回放相同的真实载体和 git 史（只读，按 `--now` 固定）。新增两类：
   - 人当时的**真实动作**，作为对照：哪些 needs-human 被谁、在什么时间、以什么方式处理了。
   - Policy 版本。
2. **Shadow 决策**：Manager 在每个时间点基于当时可见的信息，产出它**本会**采取的动作、L 级和预算消耗，**但不执行**。
3. **对照**：把 Shadow 动作和历史上实际发生的事比较：
   - 人后来做了同样的事 → 可自主化的候选；
   - Manager 会做而人没做 → 潜在越权或噪声；
   - 人做了而 Manager 不会做 → 漏判；
   - Manager 会更早做 → Goal Lead Time 能节省多少。
4. **用途**：
   - Policy 新版本上线之前的回归门（§7）；
   - L2 授权扩大之前的证据；
   - 估算 Autonomous Resolution Rate 和 Intervention Quality。
5. **前置缺口**：G1 不补，就没有「人实际做了什么」的可靠真值，第 3 步的对照只能停在代理标签上。
   所以补 G1（例如由 Quay 在状态迁移上记录 actor/session）是 Shadow 模式有意义的前提。这一条应该作为对 Quay 上游
   的需求提出，不由 CloudCLI 自己去猜。

## 10. 先单 Manager，后层级化（D9）

- **第一阶段**：一个网络或主机上只有**一个** Manager，管所有 CloudCLI 项目。与 `quay:manager` 的
  「one network = one manager」一致。
- **层级化**（以后）：Portfolio Manager 之下，再按项目或领域设子 Manager。必须先满足以下条件：
  - 单 Manager 的 5 个指标有了稳定读数；
  - 有证据表明单 Manager 的瓶颈在于容量或上下文，而不是 Policy 写得不好；
  - 层级之间的授权继承和预算切分规则已经成文（子 Manager 的 L 级不能超过父级）。
- 层级化不改变 §3 的分层：子 Manager 仍然不进入 Quay 的项目内职责。

## 11. 与既有设计的张力（未改写原文，待裁定）

| # | 张力 | 既有立场 | 本文立场 | 待谁裁定 |
|---|---|---|---|---|
| T1 | 新的授权体系 vs「不新建复杂审批体系」 | `voice-native-control-plane.md` §12.6.8：短期不新建复杂审批或逐操作确认门槛，复用既有权限机制（针对 GOAL-031 和工作台） | L0–L3 和 Decision Budget 约束的是 Manager 自己的行动权限，执行层面的审批仍然复用 `canUseTool`/`approval_answer`。是否算「新建审批体系」需要人确认 | 人 |
| T2 | Global scope 归 quay manager，还是归 CloudCLI Manager | `agent-native-semantic-ui-vision.md` §5.2：global scope 是 quay manager 层的事，UI 最多做它的客户端，不重新实现 | CloudCLI Manager 是这一层的**常驻宿主**，读 Quay、遵守 `quay:manager` 的规则和边界。它和 `quay:manager` skill 的关系待定：(a) 在 CloudCLI 宿主会话里激活该 skill；(b) 只沿用它的方法论，自己实现 | 人，可能还需要 Quay 上游 |
| T3 | Manager 能不能写任务 | `quay:manager` 边界 1：不写任务正文、AC、DoD | 草案让 Manager 在 L1 **草拟**任务供人或项目层采纳，不自己写入 store | 人 |
| T4 | 跨项目的信任边界 | `voice-native-control-plane.md` §14.4：MCP scope 是按单个用户设计的，没有区分项目，留待以后设计 | L 级和 Policy 需要按项目区分的授权；现有 scope 词表不够 | 人；属于 mcp-gateway 后续设计 |
| T5 | 设计产物的落点 | AC-314 要求 `multimodal-engineering-workspace-SPEC.md`（工作台三层数据归属） | 本文只覆盖 Manager 这个 agent，不替代那份 SPEC。Portfolio 层的数据归属仍由 AC-314 回答 | 不冲突，并列 |

## 12. 相关提案与任务

| 类型 | 指向 | 状态（2026-10-11） | 关系 |
|---|---|---|---|
| 提案 | `docs/proposals/voice-native-control-plane.md` §12、§12.6、§13、§14 | — | 上位愿景；本文是其中协调层的 agent 化 |
| 提案 | `docs/proposals/agent-native-semantic-ui-vision.md` §5.2 | — | scope 分层；T2 |
| 提案 | `docs/proposals/mcp-gateway-SPEC.md` | — | Observe/Act 原语、scope；T4 |
| 提案 | `docs/proposals/claude-resident-sessions.md` | — | 常驻宿主 |
| 提案 | `docs/proposals/claude-background-work-observability.md` | — | 会话内后台工作的可观测性（Observe 的会话侧来源） |
| GOAL/AC | GOAL-032 / AC-314 | draft | 工作台规格；T5 |
| 任务 | `gap-live-monitor-48h-replay-experiment` | needs-human（AC6–AC8 待人裁定） | §5、§9 的实证基础；原型在分支 `proto/live-monitor-replay` |
| 任务 | `gap-cloudcli-quay-snapshot-inflight-tasks` | done | `QuaySnapshot` 的 inFlight 读数（Observe） |
| 任务 | `gap-quay-panel-inflight-task-display` | done | 同上的界面侧 |
| 任务 | `gap-mcp-pending-interaction-visibility-and-idempotent-answer` | done | 「在等人回答」的数据地基（Observe、升级） |
| 任务 | `gap-quay-tab-loop-pulse-gantt-cross-project-interface-design` | done | 「Quay 导出、CloudCLI 只投影」的先例（§3） |
| 任务 | `gap-ac200-monitor-event-projection-collapse` | done | 会话内 Monitor 工具事件的折叠；只是名字相近，与本文的 Manager 不是一回事 |
| Skill | `quay:manager`（quay 插件 `plugin/skills/manager/SKILL.md`） | — | §1.5、§1.6、四条边界；T2、T3 |

## 13. 未决问题

1. T1–T4 的裁定。
2. G1（执行者可识别）由谁补：Quay 上游在状态迁移事件里记录 actor/session，还是 CloudCLI 侧做关联。
   按 §3 的分层，倾向前者。
3. Policy 和决策日志存放在哪里，用什么格式（§7 只给了草案）。
4. 5 个指标的 PREREG 和第一次取数用哪个窗口；Human Attention Cost 的加权口径。
5. 回放实验任务的 AC6–AC8（失败成本策略、机械停派是否降级、人工抽检）。这三项的结论会直接成为 Policy v0 的输入。

## 14. 建议的推进顺序（非承诺，每一步都需要先立 GOAL/AC/任务）

1. 裁定 T1–T4，并完成回放实验的 AC6–AC8，得到 Policy v0。
2. 向 Quay 上游提 G1 需求。
3. 实现 Shadow Mode Manager Action Replay：只读，不执行任何动作。
4. 单 Manager 以 L0+L1 上线：只观察和建议，开始积累指标。
5. 根据 Shadow 回放和 L1 的采纳数据，逐项把具体 Playbook 放到 L2。
6. 指标稳定之后，再评估是否层级化。
