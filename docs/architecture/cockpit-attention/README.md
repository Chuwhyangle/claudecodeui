# 驾驶舱注意力架构（设计稿）

| 项 | 值 |
|---|---|
| 状态 | **设计稿（未实施）**——取代 `notice-registry-and-dismissal.md` 与 `quay-cockpit-signal-inventory.md` |
| 日期 | 2026-10-25 |
| 基线 | `author` @ `62aba2a75` |
| 范围 | 先在**驾驶舱**（fleet / 项目 / initiative 层）实验，稳定后再落到会话页；不新建第四套模型 |
| 图 | 本目录 5 张 PlantUML（源文件即保存形式）：`01-planes`、`02-object-model`、`03-attention-lifecycle`、`04-interrupt-sequence`、`05-levels-and-rollup` |
| 依据 | `~/.quay-fleet/{events.jsonl,decisions.jsonl,attention.json,outbox.jsonl}` 的 2026-10-12 至 10-25 实测；`server/modules/observation/`；`server/modules/quay/quay-initiatives.ts`；`context-layers-and-delegation-ladder.md` |

---

## 1. 结论

1. **通知的生产侧已经存在，且比我之前设想的完整**：quay-fleet 主机目录里是一条 `事件 → 规则 → 注意力条目 → 推送行` 的流水线（`events.jsonl` → `decisions.jsonl` → `attention.json` → `outbox.jsonl`），条目带去重键、分级、生命周期、人的确认与反馈。CloudCLI 的 observation 层是**状态**这一侧。两者互补，但目前**没有连起来**：驾驶舱只读了 `attention.json` 里 `initiative-decision` 这一个类别。
2. **要做的不是新模型，而是三件事**：把 fleet 的注意力条目只读投影进 CloudCLI 并**归类**；把条目**链接到被观察对象**（URI）；在其上写一个**纯函数的打断策略**。
3. **哪些值得打断，由实测反馈决定，不靠拍脑袋**：815 条里只有约 11% 是行动类，它们几乎 100% 被解决；而占 56% 的 digest 有 98.7% 过期未读，l1.proposal 的 67 次人工确认**全部标为 noise**。
4. **打断是对注意力条目生命周期事件的策略，不是数据类型**；**状态不沿层级汇总，只汇总"未解决条目计数"**。
5. **部署"待构建"是状态，不是注意力条目**：它属于项目对象的 `deploy` 层；只有"部署失败"才是行动类条目。这直接回答了最初那条 banner 的问题。

## 2. 实测依据（14 天，815 条注意力条目）

| 类别 | 条数 | 终态分布 | 人的反馈 | 解决时长中位 | 归类 |
|---|---|---|---|---|---|
| digest | 456 | 过期 450，展示中 5，open 1 | — | — | informational（实为噪声） |
| goal-achieved | 186 | 过期 172，已解决 12，确认 2 | useful 2 | 178 分钟 | informational |
| type:l1.proposal | 84 | 确认 67，展示中 16，open 1 | **noise 67** | — | proposal（应降级） |
| worker-fail-repeated | 24 | 解决 24 | — | 12 分钟 | actionable |
| needs-human | 23 | 解决 22，确认 1 | useful 1 | 860 分钟 | actionable |
| worker-stall | 19 | 解决 18，确认 1 | noise 1 | 1776 分钟 | actionable |
| self-backlog | 11 | 解决 11 | — | 52 分钟 | actionable |
| self-code-drift | 9 | 解决 9 | — | 365 分钟 | actionable |
| initiative-decision | 1 | 展示中 | — | — | actionable（待决） |
| session-cost-budget | 1 | 过期 1 | — | — | actionable（样本不足） |
| needs-human-triage | 1 | 解决 1 | — | — | actionable |

补充读数：

- **分级**：`notify` 755、`escalate` 60。`escalate` 里 53 条是行动类；digest 也有 7 条被升级。
- **解决方式**：行动类条目多数不是人点掉的，而是**来源条件消失时被重读来源自动解决**（`resolvedBy` 形如 `quay task list@项目:任务=ready`）。
- **量**：`notify` 日均约 58 条；行动类且 `escalate` 的 14 天共 53 条，**最近 7 天只有 3 条**（日分布 `2,6,25,14,0,0,3,1,0,0,1,0,1,0`，第 3 天的突发 25 条是一次性事件）。
- **积压**：当前 24 条未终结，其中 16 条 l1.proposal 已展示 6–42 小时无人处理。

## 3. 设计决定

### D1. 平面划分与所有权（图 01）

| 平面 | 内容 | 所有者 | 语义 |
|---|---|---|---|
| 事件 | `events.jsonl` 类型化事件 | fleet | 只追加的证据，不直接展示 |
| 注意力 | `attention.json` 条目 | fleet | 边沿产生、条件消失自动解决、人可确认 |
| 状态 | `ObservedObject` | CloudCLI observation | 水平语义：当前是什么样；修订差量即未读事件 |
| 读模型 | `AttentionHub` + 用户态 | CloudCLI（新增，薄） | 只读投影 + 归类 + 主体链接 + 用户的已读/反馈 |

CloudCLI **不写 fleet 的文件**（`quay-initiatives.ts` 已明文如此）。fleet 条目由 `AttentionHub` 只读；用户的"已读 / useful / noise"存 CloudCLI 库；人的**确认**经 fleet 自己的 `ack` 动词回写（outbox 的推送行里已带 `quay-fleet ack <id>`，说明该动词存在）。

### D2. 待决不是独立模型（图 02）

`options` 非空的条目就是待决。现有 `decisionQueue` 是对 `initiative-decision` 类别的过滤视图，推广为"所有带 options 的条目"即可。驾驶舱的"现在什么需要我"因此是**一个**队列：待决条目加行动类条目，而不是待决与状态各画一套。

### D3. 类别归类（派生，不存储）

初始静态表见第 2 节。规则：

- **未知类别默认 `unclassified`**：进队列的被动区、**永不打断**，同时作为一条校准项呈现给人。静默但可见，不丢。
- **类别随反馈调整，且须人批准**：某类别累计 ≥20 次确认且 noise 占比 ≥90% 时，系统生成一条"建议降级"的注意力条目。l1.proposal（67/67 noise）今天就满足。守则遵循 `context-layers` §8.3：晋级要证据且由人批准，不静默接手。

### D4. 打断策略（图 04）

纯函数 `(条目, 触发类型, 类别, 在线状态) → InterruptDecision`：

| 类别 | 分级 | 触发 | 在线（有 display） | 离线 |
|---|---|---|---|---|
| actionable | escalate | created / escalated | 队列队首（打断） | Web Push，一次 |
| actionable | notify | created | 队列被动区 + 计数 | 无 |
| informational | 任意 | 任意 | 不打断；进"离开期间"差量 | 无 |
| proposal | 任意 | 任意 | 队列被动区，**不计入徽标** | 无 |
| unclassified | 任意 | 任意 | 队列被动区，**不计入徽标** | 无 |
| 任意 | 任意 | renotified | 不打断 | 无 |

约束：**同一时刻只有 1 条处于打断态**（队首），其余只以计数呈现；**边沿触发、不重复打断**；条目被来源条件解决即自动撤下。

按实测回放的预期量：行动类且 escalate 的日均约 3.8 条，最近一周共 3 条，相对现状 notify 日均 58 条是一到两个数量级的下降。

### D5. 层级与汇总（图 05）

- 对象：fleet、project、initiative、task、session、architecture，均以 URI 寻址。
- 边：`originated_by`（任务 → 会话，由会话转写扫描得到，`SessionTaskChain` 已在算）、`contains`、`blocks`（`depends_on` / Blocker 的 `dependents`）、`about`（条目 → 对象）。边为**推导值，不存储**。
- **颜色不汇总、计数汇总**：一个会话变红不会让项目、fleet 变色；项目磁贴显示自身状态加"自身与后代的未解决条目数"。这避免一次抖动染红整面墙，同时不丢信息。
- 条目的 `subject` 由 `projectId + entity` 推导。实测的 entity 形态有任务 id、`initiative:<slug>@…`、`<小时窗口>`、`<名>@<日期>` 几种，**推导规则在 P1 对着真实数据核对后固定**，不在本稿里拍定。

### D6. CloudCLI 自有来源

部署失败、会话运行失败等来自 CloudCLI 的条目，写进 CloudCLI 自己的库，**schema 与 fleet 条目相同**，`dedupKey` 加 `cloudcli:` 命名空间，由 `AttentionHub` 在读时合并。理由：不能写 fleet 的文件，又不该为此造第二套语义。

部署的两面分开处理：

- **待构建 / 已构建待重启**：状态，进项目对象的 `deploy` 层（`project-truth` 已有），项目磁贴上可见，**不提醒**。
- **构建 / 重启失败、核验失败**：行动类、`escalate`、**不可忽略**，是唯一会打断的部署事件。

现有 `notifications` 模块（Web Push 与桌面 WS）作为**离页通道**复用，其 stop / error 类事件改为 CloudCLI 自有条目后统一走策略，避免两条通道对同一事重复打断。

### D7. 反馈回路

每个条目带"有用 / 噪声"两个按钮（cockpit 与 popover 均可），写入 `UserAttentionState.feedback` 并经 `ack` 回写 fleet。校准必须便宜（`context-layers` §4.4）。

### D8. 会话页（后期，规则在此先定）

- 只显示与本会话**直接相关**的条目：`about` 指向本会话，或指向本会话所发起的任务。
- 只显示 **actionable**；其余一律不进会话页。
- 载体：标题行字形（颜色取相关未解决条目的最高分级，**不新增行高**）、点击出 popover、之后可选转写内锚定装饰。**聊天页顶部默认固定高度 0。**
- 因此不再有任何常驻文字 banner；之前的 `SessionTaskChain` 与部署条的信息，分别变成"该会话所发起任务的阶段与相关条目"和"项目对象的 `deploy` 层"。

### D9. 源头噪声归 fleet

digest 占条目 56% 且 98.7% 过期，应当只进事件流 / feed，不应是注意力条目；l1.proposal 同理。这是 **quay-fleet 仓库**的改动，本仓库不实现；CloudCLI 在此之前靠归类过滤。

### D10. 自身故障要响

`AttentionHub` 注册为一个 observation producer，复用现有的心跳存活机制：`attention.json` 读不到或解析失败时，墙上出现"观察层自身"条，而不是一个看起来健康的空队列。"安静 ≠ 没事"。

## 4. 阶段计划（每步有可验证的出口）

| 阶段 | 内容 | 出口 |
|---|---|---|
| **P0 离线回放** | 脚本读 `attention.json` 历史，按 D3、D4 计算每条的 `InterruptDecision`，不接任何 UI | 14 天回放：打断日均 ≤5；**精确率** ≥0.9（被打断的条目最终是 resolved 而非 expired / noise）；**召回** ≥0.95（最终 resolved 的行动类条目都至少进过队列） |
| **P1 只读投影** | `AttentionHub`：读 `attention.json`、归类、推导 `subject`；`GET /api/attention`；注册为 producer | 现网 24 条未终结条目全部被归类，未知类别被计数；`subject` 推导对真实 entity 全部命中或显式 `unresolved` |
| **P2 驾驶舱队列 + 磁贴计数** | 统一"现在什么需要我"队列；项目磁贴计数徽标；策略**影子运行**，只记录"本会打断"不真打断 | 隔离实例 + MCP 浏览器；影子日志与 P0 回放同口径 |
| **P3 打断上线 + 反馈** | 队首打断、离页 Web Push、有用 / 噪声按钮、`UserAttentionState` | 反馈经 `ack` 回写 fleet 并在 `attention.json` 可见 |
| **P4 会话页 S0** | 标题行字形 + popover，依赖 `originated_by` 边 | 无关会话不渲染（反向测试）；聊天页顶部高度为 0 |
| **P5 CloudCLI 自有来源** | 部署失败、会话运行失败进自有库并走同一策略 | 构造一次失败部署，只产生一条打断 |
| **跨仓库** | quay-fleet：digest / l1.proposal 不再建注意力条目 | 在 fleet 仓库立任务，不在本仓库 |

**不可做**：不给 Chat 页加任何常驻条；不让 CloudCLI 写 fleet 文件；不让颜色沿层级汇总；不在 P0–P2 期间真打断。

## 5. 预答：几个必然会被追问的点

- **为什么不新建 Notice / Signal？** 事实源已有两个：fleet 的条目、CloudCLI 的观察对象。再建一个会形成第三份事实，违背 `context-layers` §4.1 的"唯一事实来源"。
- **为什么颜色不汇总？** 汇总让最嘈杂的下层决定整面墙的颜色，丢掉"哪里出了事"这个最有价值的位置信息。计数汇总保留了"下面有事"，又不改色。
- **阈值哪来的？** 来自 14 天实测与人的 `noise` 反馈，并且是可回放、可调的参数（P0 的出口）。局限见第 6 节。
- **两个库会不会分叉？** 只读合并，schema 相同、命名空间隔离；用户态单独成表。分叉点只有"自有条目不回写 fleet"，这是有意的。
- **fleet 不在或文件坏了怎么办？** D10：墙上有"观察层自身"条；CloudCLI 自有条目仍可用。
- **多用户？** 条目是主机级；已读与反馈按用户存。
- **为什么待构建不再提醒？** 它是状态：每次轮询都重新为真。可见但不打断；只有失败才打断。
- **与旧 `notifications` 的关系？** 复用为离页通道；其事件源改走统一策略，避免双通道重复。

## 6. 未核实与局限

- **样本小**：14 天、单用户；`useful` 反馈只有 3 条，`noise` 的 67 条几乎全来自一个类别。"噪声占比 ≥90%"这条降级阈值是工程判断，不是统计结论。
- **规则映射未核对**：哪条规则（R1–R6、`plan.*`）把哪类事件映射成哪个类别，我没读规则实现；图 04 的事件到类别的对应是示意。
- **`subject` 推导规则未固定**：见 D5，P1 的第一件事。
- **fleet 的 `ack` 动词的参数形式**只从 outbox 的推送行里读到（`quay-fleet ack <attentionId>`），`feedback` 字段如何经 CLI 传入未核对。
- **`originated_by` 的覆盖率**：`SessionTaskChain` 靠转写里的工具调用提取，未经 quay 工具创建的任务不会有这条边。
- **`session-cost-budget`、`needs-human-triage`、`initiative-decision`** 样本各 1 条，归类只是暂定。
- 本稿没有读 `cockpit.reducer`、观察墙的前端排序实现（`compareWallEntries`）和现有 `notifications` 的偏好存储，P2 之前需要读。
