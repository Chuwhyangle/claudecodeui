# Voice-native control plane：Qwen Realtime 语音原生推理前端 + Claude Code 执行引擎

状态：Draft / 待评审（架构讨论记录，尚无正式裁定）
日期：2026-10-09
决策输入：与人 yale 的多轮架构讨论；§0 的产品定位由人 yale 在 2026-10-09 明确给出，是本文档其余一切设计决策的框架，优先级高于下文任何具体协议细节。
关系：

- 建立在 `docs/proposals/voice-kit-SPEC.md` 之上（语音采集 / ASR provider 缝 / 裁剪的既有工作），但本文档描述的交互模型**不是**该 SPEC 的"听写进输入框"模型——两者是两种不同的语音能力，关系见 §9。
- 建立在 `docs/proposals/agent-native-semantic-ui-vision.md` 之上：它的共享指针（§4）、"Claude Code 已经是语义接口而不是像素"（§9）、affordance 的四个标注（§3.1/§7）在本文档里被当作**已经验证过的基础设施**直接复用，不是重新发明。
- 建立在 `docs/proposals/claude-resident-sessions.md` 之上：常驻会话、无人轮、`notifyBackgroundWorkCompleted` 通知机制、`HostLease`/保活理由模型，是 §3、§6 的直接依据。
- 建立在 `server/modules/mcp-gateway/*` 的既有工具表之上（`mcp-gateway.read-tools.ts`/`mcp-gateway.write-tools.ts`/`mcp-approvals.ts`/`mcp-tool-annotations.ts`）：§2 把它当作"Claude Code 已经被暴露成少数高层 tool"的现成落地，不是待建的新协议。
- **取代**了本仓库讨论过程中更早一版把 Qwen 当"听写员 + turn framing 过滤器"的设计——那一版已被判定为退化成传统 ASR→文本→二次推理 pipeline，§5 的反模式清单记录了为什么。

---

## 背景：从 Quay 到 Live Voice 的一条连续演化链

这一节说清楚一件事：Live Voice mode 不是一个孤立冒出来的"给 Claude Code 加语音"的功能点子，而是 ClaudeCodeUI / Quay 这条产品路线一直在做的同一件事的下一步——持续把软件开发中的大量活动封装成 agent 可执行、可编排、可后台运行的能力，从而把人从许多低层、重复、等待式、轮询式和跨工具协调的活动里抽离出来，把人与系统交互的抽象层级持续往上抬一级。下面按能力演化的顺序把这条链写清楚，每一环都指向本仓库里真实存在、已经落地或在建的东西，不是事后编的叙事。

### 这条链的五环

**1. Quay：把"开发活动本身"封装成 agent 可执行、可编排、可后台运行的能力。** Quay 的 task/goal 生命周期（`todo→ready→done` 的门禁、`task_check` 的证据要求、fan-in driver 的机械合并）把"选一个任务、实现它、验证它、合并它"这一整条本来需要人逐步跟踪的流程，变成 agent 可以自己走完的闭环。再往上一层，`quay:manager` skill 描述的"第三层——跨项目规划、优先级排序、趋势观察"，把"现在该先做哪个项目的哪件事"这种本来需要人周期性巡检多个项目才能回答的问题，也变成了一层可以持续运行的协调机制。**这一环已经把人从"盯着一个任务走完"和"巡检多个项目找该做的事"这两件低层活动里抽出来了。**

**2. ClaudeCodeUI 的 semantic/MCP control：把"操作"从像素变成语义动作。** `agent-native-semantic-ui-vision.md` §9 已经指出，这个仓库自己的 MCP gateway（`ChatControlService`、`mcp-gateway.read-tools.ts`/`write-tools.ts`）已经是"语义接口代替重新解析像素"的真实落地——GOAL-019 到 GOAL-028 这十个目标，把发消息、打断、批准、改配置这些动作，从"人必须点一个按钮"变成"任何认证过的客户端都可以调一个有 schema、有标注、有 scope 的工具"。**这一环把"驱动 Claude Code"本身的接口从 UI 像素抽象成了少数几个高层动词**——这正是本文档 §2 直接复用的东西，不是为语音重新发明的。

**3. Resident/background tasks：把"工作的生命周期"从"一次来回"解耦成"持续运行"。** `claude-resident-sessions.md`（GOAL-012/013）把 Claude 进程从"每轮一个、答完就死"变成"跨轮存活、能后台继续、无人值守时也能跑 cron/Monitor/跨会话消息"。这一环的意义是：**人不再需要为了让一件事继续发生而一直守在那个会话前**——这是本文档 §0 的 P3（"用户不需要通过重复询问来跟踪长任务"）和 §6（状态跃迁驱动的主动通知）**直接站在的那个台阶上**，不是凭空提出的新目标。

**4. Multi-session coordination：把"跨会话/跨项目的协调"变成系统能力——目前只有部分原语落地，协调本身还是人工在做。** `claude-resident-sessions.md` §12 已经实测过跨会话 `SendMessage` 送达（一个会话能找到另一个会话、对方真的产出一轮）；`sessions_list`/`mcp-resolve-target.ts` 已经能按名字定位到具体会话。但"把 A 的发现转述给 B、让 B 验证、合并结果再汇报"这整套编排逻辑，今天**还是靠人自己做**——本文档 §12.1 已经点出：我们现在人↔ChatGPT↔CloudCLI↔多个 Claude Code resident session 的协作方式，就是这一环**人工版**的真实运行实例。**这一环的原语已经有了，协调者的角色还没有自动化。**

**5. Live Voice coordinator：在同一条线上，再抬高一级交互的抽象层级。** 前四环做的都是"让系统替人做更多执行层/协调层的事"，Live Voice mode 延续的是同一个方向，只是换了下一个要抽离的东西：**不是把人重新拉回每个 session 里逐条操作**，而是让人直接表达高层目标、纠正、优先级和判断（用最高带宽的通道——连续语音、native-audio reasoning），由一个 human-facing coordinator 把这些意图映射到多个后端 project/session/task，跟踪执行、协调依赖、汇总结果，**只在真正需要人判断的时候把控制权交回来**。放进这条链里看，§0 的 P1（voice-native control plane）和 §12（multi-agent aggregation front-end）不是"要不要做语音"的孤立产品决策，是"要不要把第 4 环自动化、并用语音作为这个更高层协调者的输入通道"的架构延续。

### 为什么是现在：吞吐率提升之后，稀缺资源转移到哪里

这条链背后还有一个更高层的经济学判断,支撑着"继续往这个方向投入,而不是只优化写代码本身"这件事：**随着软件开发的吞吐率飞速提升、代码生成和修改的边际成本持续下降,系统里真正稀缺的资源正在从"写代码"这个动作本身,转移到规格/目标澄清、架构设计、上下文组织、跨 agent 协调、验证/评估、风险控制和产品判断这几件事上。**

这个判断的另一半更重要,也更容易被忽略：**代码越便宜,"吞吐率很高但方向错了"这件事就越危险。** 当生成/修改代码的边际成本趋近于零,一个局部最优的实现、一次重复的功能、一处悄悄漂移的架构决策、一个跨模块的不一致假设,都会被更高的吞吐率**放大**而不是被稀释——写得越快,错误方向上跑出去的距离就越远,回头的代价也越大。换句话说：**原来"写代码慢"天然充当的一道隐性刹车（人必须先想清楚才动手，因为改起来贵）正在消失**，接替这道刹车的不能是"写得更快但想得更少"，必须是上面那几件事本身被显式地做强。

**这正是本文档正在推进的两条元层工作的真正动机，不是体验上的锦上添花：**

- **(a) human-facing coordinator / Live Voice**（§0、§12.1-§12.3）：提高人与系统交互的**抽象层级与带宽**——当代码便宜到可以让多个 agent 同时产出大量变更时，人越不能被陷在"逐条审每一次 Edit"里，人的注意力必须能够放在"这个方向对不对、这个判断该不该做"这个更高的层级上，而这需要一个带宽足够高、听得懂高层意图和纠正的前端。
- **(b) architecture-oriented context/workspace**（§12.4）：提高多 agent 后端的**结构化程度与架构表达能力**——当多个 agent 并行产出变更时，"架构漂移""跨模块不一致""局部最优的重复实现"这几件事发生和放大的速度，直接取决于这些 agent 是不是在一个共享的、按架构组织的上下文里工作，而不是各自平铺、互不知情地改代码。

两条线合起来要做的事，是在"写代码"这个成本持续下降的前提下，把"规格澄清、架构设计、跨 agent 协调、验证评估、风险控制"这几项新稀缺资源的供给**跟上**——不这样做，吞吐率提升带来的不是"做得更多"，是"错得更快、错得更远"。

**这仍然是一个长期假设，需要用数据验证，不是不言自明的真理。** 对应的指标已经并入 §13.3，不在这里重复列。

### 必须说清楚的边界：这是假设，不是已验证的终局

上面这条链的前三环（Quay、semantic/MCP control、resident/background tasks）是**已经落地、有实测读数**的东西；第四环（multi-session coordination）**部分原语已验证，编排本身未自动化**；第五环（Live Voice coordinator）**完全是假设**——"把协调自动化、再用语音做输入通道，会比人直接操作/人工协调更好"这件事，和 §12.5/§13 已经写的立场一致：**这是一条有明确历史连续性的下一步假设，不是已经证明有效的架构终局**。它该不该走、走多远，要靠 §10 的 prototype 和 §13 的评估计划给出的数据决定，不是靠"这条演化链看起来很自然"就能替代验证。上一节的经济学判断同样是假设——"稀缺资源正在转移"是一个方向性直觉，不是已经测过的事实。

---

## 0. 产品定位（框架性判断，优先级高于下文一切协议细节）

这一节的每一条都是约束后续设计的硬边界，不是可以随实现细节权衡掉的偏好。

**P1 — Live Voice 不是"给 Claude Code 加一个更好的语音输入框"。** 它是一种新的 agent interaction mode：**voice-native control plane（语音原生的控制面）+ text-first work surface（以文字为主的工作面）**。输入侧要尽量保留连续语音和 native-audio reasoning 带来的信息带宽（语气、停顿、自我更正、指代都是信号，不是噪声）；输出侧在当前阶段以**持久、可扫读、可搜索、可复制**的文字/代码/diff/tool output/任务状态为主。这两侧不对称是故意的，不是过渡态的妥协——见 P5。

**P2 — 和 ChatGPT Start Voice 的关系是"借用验证过的输入侧范式，拒绝它的输出侧默认假设"。** ChatGPT 已经证明 continuous audio + native-audio reasoning + natural turn-taking 很有价值——这是输入侧，这次架构直接借鉴（§1-§6）。但软件工程场景和"语音助手对话"场景的根本不同在于：ClaudeCodeUI 需要**长期运行的 coding agent、后台任务、常驻会话、权限/approval、通知、复杂格式输出的持久工作区**——这些东西在一个纯语音对话产品里通常被设计成"不存在"（一切都在一次对话的来回里解决）。照搬 Start Voice 的输出侧假设（一切都讲出来、一切都在当下对话里解决）会让这个产品失去它最该有的东西：一份能回去审查的、结构化的事实记录。

**P3 — 正式设计目标：用户不需要通过重复询问来跟踪长任务。** "好了没""继续""现在呢"这类轮询式提问，是旧交互模型（语音=一次性问答）强加给用户的负担，在一个会跑后台任务、会常驻、会需要人批准的系统里尤其浪费——这正是本文档要消除的东西，不是语音体验的自然代价。落地到架构上：

- **Voice session 的生命周期与 Claude run / task 的生命周期解耦。** 一次 Voice session 可以发起、追问、纠正、打断多个 Claude run / 后台任务；Claude 的任务可以在 Voice session 结束之后继续在后台跑——语音前端关掉，不等于它发起的工作停下来。
- **系统在有意义的状态跃迁上主动把结果带回来**（blocked / 需要 approval / failed / completed），而不是等用户来问。具体机制见 §6。

**P4 — Qwen 的 world model 不止"当前这句话在回答什么"，还要覆盖整个会话/任务的态势。** 见 §3 的完整展开。这是让语音里"刚才那个任务怎么样了""等这个做完再查 Windows 那边"有正确语义的前提——没有这一层，语音前端连基本的指代都做不对，更谈不上"不用反复问进展"。

**P5 — 语音输出（TTS）是明确写进 roadmap 的未来阶段，不是当前 milestone 的阻塞项。** 当前阶段的输出侧继续以文字为主（P1）。等到真的做语音输出时，**不是**把 Claude 的原始输出直接念出来——那正是 P2 要拒绝的"一切都讲出来"的假设。未来的语音输出要经过一个独立的 **speech rendering / spoken-summary 层**：先把代码、diff、日志、表格、长结果**总结和改写**成适合耳听的信息密度和结构，再 TTS。用户在不方便看屏幕时能靠这层继续工作，代价是信息密度比看屏幕低；回到屏幕后，仍然有完整的、未经压缩的文字记录可审查。这条扩展**不改变**"Claude Code 是执行 agent、文字工作区是事实记录"这条核心架构——speech rendering 层只是文字记录之上的一个只读投影，不是替代它的第二个事实来源。细节见 §8。

---

## 1. 四层架构

```
L0  音频采集（浏览器）        getUserMedia + AudioWorklet → 流式 PCM，服务端代理转发（浏览器不直连 provider）
L1  Qwen Realtime 会话         语音原生推理：听、消歧、自我更正理解、指代解析、turn/interrupt/queue 决策、
                               world-model 查询（§3）
L2  MCP 控制面（已存在）       session_send / session_interrupt / approval_answer / session_reconfigure /
                               session_cancel_queued + 只读的 ui_visible_context / ui_selected_text /
                               session_read / session_get / run_get / approvals_list / session_background /
                               sessions_list
L3  Claude Code 执行引擎       唯一会调用 Edit/Bash/Write 的实体，对 Qwen 完全不透明——Qwen 只看得到 L2
                               投影出来的东西；一次 Voice session 结束后，L3 的 run / 后台任务按 P3 继续跑
L4  浏览器 UI + 通知           渲染 L2 产生的普通 chat.send 结果；文字工作面持久呈现；状态跃迁驱动的主动
                               通知（§6）；未来阶段叠加 speech-rendering 投影（§8）
```

L1 和 L3 之间没有直接连接，只有 L2——Qwen 永远不知道 Claude Code 内部在用什么工具、怎么编辑文件；它只知道会话忙不忙、有没有权限请求在等、后台有什么在跑、屏幕上选中了什么。这个边界同时服务于两个目标：P1 要求的"输入侧语义理解能力拉满"和"输出侧/执行侧保持 Claude Code 单一事实来源"——边界越清楚，两者越不会互相污染。

---

## 2. MCP 控制面 = Claude Code 已经暴露成的少数高层 tool

`server/modules/mcp-gateway/mcp-gateway.write-tools.ts` + `mcp-session-*.ts` + `mcp-approvals.ts` 已经把"驱动 Claude Code"收窄成这几个动词，**没有一个是文件级的**：

| Tool | 签名（实参） | 语义 |
|---|---|---|
| `session_send` | `{session, message: string, waitSeconds?}` | 对会话发一条**自然语言**消息，开一轮 run；忙时 resident 返回 `queued:true`+`queuedMessageUuid`，per-run 直接拒绝（`SESSION_BUSY`） |
| `session_interrupt` | `{session}` | 停当前轮，`destructiveHint:true` |
| `session_cancel_queued` | `{session, messageUuid}` | 按 uuid 撤回一条**尚未出队**的消息，返回 `cancelled` 或 `already-started`——状态判定，不是计时器 |
| `approval_answer` | `{requestId, decision, message?, updatedInput?}` | 对一个挂起的权限请求/`AskUserQuestion` 下判断 |
| `session_reconfigure` | `{session, model?, effort?, permissionMode?}` | 改模型/思考强度/权限模式 |
| `session_create` / `session_start` / `session_close` | — | 新建/拉起常驻/关闭常驻 |

`session_send` 的参数是**一整句自然语言**，不是 `{path, old_string, new_string}`——这不是为语音设计的巧合，而是这个仓库已经独立验证过一次"第二个 agent 不该猜文件级参数"的教训（`docs/proposals/mcp-gateway-SPEC.md` 的非目标明确排除"remote write file / git commit / push / arbitrary shell"，即使对认证过、scope 受限的 MCP 客户端也不开放）。**Qwen 的工具表到这一层封顶，Edit/Bash/Write 永远在 Claude Code 内部。**

每个 tool 已经带着 MCP 标准的四个标注（`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`，`mcp-tool-annotations.ts`），直接映射到 `agent-native-semantic-ui-vision.md` §7 的确认策略分级，语音侧复用即可，不需要重新发明。

---

## 3. Qwen 的 world model：不止"当前在回答什么"

P4 要求 Qwen 能按需获取（不是持续推送，见 §4）下面这些态势，每一项对应一个已有的只读 MCP 读法：

| World-model 维度 | 对应的读法 | 语音场景例子 |
|---|---|---|
| **当前聚焦的会话** | `ui_visible_context`（`selectedSession`）/ 共享指针（`agent-native-semantic-ui-vision.md` §4） | "这个会话"、"刚才那个" |
| **当前活跃的 Claude run** | `session_get`（run 状态）/ `run_get` | "它还在跑吗" |
| **排队中的 turn** | `session_send` 自己返回的 `queuedMessageUuid`（Qwen 自己记住自己发过的） | "我刚才那句现在排到哪了" |
| **后台任务** | `session_background`（list 分支）、`session_get` 里的 host snapshot（leases，参见 `claude-resident-sessions.md` §3 的 `HostLease`：`background-task`/`monitor`/`cron`） | "等这个做完再查 Windows 那边" |
| **挂起的权限请求** | `approvals_list` | "是的做吧"（§7 的风险分级） |
| **最近完成的任务** | `session_read(mode='outline')` + 特定 `run_get(runId)` + `sessions_list` 排序 + `task_notification` 这个帧种（`docs/architecture/02-realtime-stream.md` 里的 kind 表） | "刚才那个任务怎么样了" |
| **可见 UI 上下文/选中内容** | `ui_visible_context` / `ui_selected_text` | "这一段"、"刚才选的那个" |

**一个未决问题，如实记录而不是假装已解决**：现有 MCP 工具表里**没有一个"列出这个会话当前排了几条队"的读工具**——`session_cancel_queued` 要求调用方已经持有 `queuedMessageUuid`，没有反向的"把当前队列读出来"接口。Qwen 只能依赖自己在本次连接里记住的、自己发出去的 uuid 集合来回答"我说的那些话现在怎么样了"；如果连接重连、或用户问的是**另一个客户端**（人在界面上点的、另一个 MCP 客户端发的）排的队，Qwen **答不出来**。这是否值得补一个新的只读 MCP 工具（如 `session_queue_get`），留给后续阶段单独评估，本文档不预先下结论——理由同 §7 对"确认阈值"的处理方式：没有读数之前不假装有答案。

---

## 4. `session.update` 与 function-calling 协议

### 4.1 连接建立时（一次性）

- **系统指令**：定义角色边界——"你是语音原生前端，只负责理解、决定该不该交给 Claude Code、要不要打断/排队/批准；你自己从不写代码；你唯一能做的动作是调用下面这些工具"。
- **输出模态**：`modalities: ['text']`——Qwen 自己永远不发语音回复（P1：输出侧当前以文字为主）。
- **工具 schema**：直接从 §2 列出的 MCP 工具的 Zod `inputSchema`/`outputSchema` 导出，单一来源，不手写第二份——这是 `agent-native-semantic-ui-vision.md` §3.2"共享 affordance 声明"原则在这里的落地。
- **初始上下文快照**：当前指针（projectId/sessionId）。

### 4.2 连接存续期间（增量，事件驱动，不是轮询）

只在真实状态发生跃变时推一次结构化小更新，复用现有事件源，不建新的轮询循环：

| 事件源 | 触发条件 | 推给 Qwen 的内容 |
|---|---|---|
| `permission_request` 帧 | 新的权限请求出现 | `{event:'approval_pending', requestId, toolName, inputSummary}` |
| `complete` 帧 | 当前 run 结束 | `{event:'run_completed', success, aborted}` |
| `task_notification` 帧 / 后台任务完成 | 一个后台任务（P3 里"可能在 Voice session 结束后才完成"的那类）结束 | `{event:'background_task_done', taskId, outcome}` |
| `session_upserted`（非本次语音自己打的那一轮） | 另一端改变了这个会话 | `{event:'external_change'}` |

**不持续推全量上下文**——这不只是性能考量,是避免重蹈语音前期实验（`experiments/voice-draft` S1 臂 B）里"喂给听觉/理解阶段的上下文越长越带偏"的覆辙：按需拉取（function call 返回、用完即弃）不会积累这个问题。

---

## 5. 歧义消解 / 自我更正 / 指代解析——避免退化成 ASR pipeline 的反模式清单

| 反模式（旧 ASR pipeline 的做法） | 这次要避免的原因 | voice-native 的替代做法 |
|---|---|---|
| 先转写成文字，再用第二个文本模型判断"这是不是更正" | 转写已经丢掉了语气、停顿、重音——真正承载"我是不是在反悔"的信号 | Qwen 自己同一次推理里直接处理，音频特征和"是不是更正"的判断共享同一次前向传播 |
| 把发给 Claude Code 的内容定义成"转写结果" | 转写结果带着口头禅、停顿，对 Claude Code 没意义甚至误导 | 发给 Claude Code 的 `message` 是 Qwen **理解后的意图陈述**，不必逐字 |
| 标识符纠错做成确定性字符串替换，和理解阶段分开 | 纠错阶段看不到"这句话想干什么"，理解阶段看不到"这个词原本可能是什么" | 标识符解析融进同一次推理，由 `ui_visible_context`/`session_read` 返回的真实文件名作为推理证据 |
| 指代词留给后处理猜 | 纯音频没有指代消解需要的另一半信息 | §3 的只读工具存在的意义：先调用工具把真实选中内容/状态塞进推理上下文，再继续决定 |

一个具体走一遍：用户说"把这个函数改成异步的——不对，是上面那个函数"。Qwen 听到"这个函数"时调用 `ui_selected_text` 拿到选区；听到"不对，是上面那个"时在**自己的推理里**改写指代，从未生成过一个半成品发给 Claude Code；整句话结束才调用 `session_send({message: "把 selectedRange 上面那个函数改成 async/await"})`——仍是自然语言,精确定位哪一行留给 Claude Code 自己读文件去做。

---

## 6. 状态跃迁驱动的主动通知（P3 的落地机制）

这是把"用户不需要反复问进展"从设计目标变成具体行为的一节。触发条件是四类**有意义的状态跃迁**，不是心跳轮询：

| 跃迁 | 触发源 | 行为 |
|---|---|---|
| **completed** | `complete` 帧（成功） | 复用 `claude-resident-sessions.md` 已有的 `notifyBackgroundWorkCompleted`（Web Push）；若 Voice session 仍在线，Qwen 可以**主动用一句话播报**（文字渲染，不是语音——P1） |
| **failed** | `complete` 帧（`success===false`） | 同上，文案区分失败 |
| **blocked / 需要 approval** | `permission_request` 帧 | 进入 §7 的批准流程；若用户当下不在场，走通知，不自动拒绝/不自动批准（和 `claude-resident-sessions.md` §9 的无人值守拦截原则一致——无人时三个入口自动拒绝，而不是假装用户同意了） |
| **外部变更** | `session_upserted` | 轻量提示，不打断当前交互 |

**与 Voice session 生命周期解耦（P3 直接要求）的具体含义**：一次 Voice 连接关闭（用户切回文字模式、合上笔记本、浏览器标签页关掉）**不触发**任何 `session_interrupt`/`session_close`——它发起的 Claude run / 后台任务继续按自己的生命周期跑（`claude-resident-sessions.md` 已有的常驻/后台任务模型）。等用户下一次打开（语音或文字都行）、或者状态跃迁发生时，上表的机制负责把结果带回来,而不是让用户靠"我记得我问过什么"去追。

这一节描述的是**现有机制的编排**，不是新协议——`notifyBackgroundWorkCompleted`、无人值守拦截、`task_notification` 帧都已经在 `claude-resident-sessions.md` 里落地或设计过。本文档的增量只是"把 Voice session 接成这套机制的又一个消费者/触发者"。

---

## 7. `approval_answer`：语音批准权限请求的专门风险

- Qwen 听到"是的/做吧/批准"类表态时，**先**调用 `approvals_list` 确认真的有 pending 请求、它的 `toolName`/`inputSummary` 是什么，**绝不**凭记忆直接调 `approval_answer`。
- 低风险操作（读文件、`git status`）直接批准；高风险操作（`Bash` 执行、删除、`git push`）走复述确认——`agent-native-semantic-ui-vision.md` §7 原话："voice confirmation only counts if the system echoes back exactly what it understood and gets a distinct affirmative, not a continuation of the same utterance"。
- `approvals_list` 返回空而用户说了"是的"——当成普通陈述处理，不因为出现"是"这个词就去找一个批准来套。

---

## 8. 未来阶段：语音输出（speech rendering / spoken-summary 层）—— roadmap，非当前阻塞项

按 P5，这一节是**roadmap**，不是当前 prototype/GOAL 要交付的东西（见 §10 的非目标）。记录下来是为了让当前的协议设计不要堵死这条路。

### 8.1 为什么不是"把 Claude 的输出直接 TTS"

Claude Code 的原始输出（代码、diff、日志、表格、长结果）是为**眼睛扫读**优化的——固定宽度、可跳读、依赖空间布局（diff 的加减号对齐、表格的列对齐）。直接念出来既念不清楚，信息密度也和"耳朵能跟上"的速度不匹配。P2 明确拒绝"一切都讲出来"这个假设。

### 8.2 预期架构：在文字工作区之上叠加一个只读投影层

```
L3 Claude Code 执行引擎 → 持久文字工作区（事实来源，不变）
                              │
                              ▼
                    speech rendering / spoken-summary 层（新增，未来阶段）
                    将代码/diff/日志/表格/长结果 总结+改写 成适合耳听的
                    信息密度与结构（例如："改了三个文件，核心是把那个函数
                    换成了异步版本；测试跑过了，有一行警告说…"）
                              │
                              ▼
                            TTS → 语音输出
```

- 这一层的输入是文字工作区的内容，输出是**另一段文字**（給 TTS 用的脚本），不是对原始输出的逐字朗读——它本身是一次总结/改写，可能需要一次额外的文本模型调用，和 §1 的 L1（Qwen Realtime）是否是同一个模型待后续阶段决定,不在本文档现在下结论。
- **代价是信息密度**，这是明确接受的权衡（P5 原话）：用户在不方便看屏幕时能靠这层继续工作，但听到的比看屏幕看到的少；回到屏幕后,完整的、未经压缩的文字记录仍然在工作区里,可以审查——**这条扩展不改变"Claude Code 是执行 agent、文字工作区是事实记录"的核心架构**，speech rendering 层永远是只读投影，不是第二个事实来源,不会反向写回工作区。
- 对 §6 的通知机制而言，这一层一旦存在，"主动播报"就可以真的用语音念出来（目前只能用文字渲染）——但这是 §8 落地之后才成立的能力，当前阶段 §6 的播报仍然是文字。

---

## 9. 与 `voice-kit-SPEC.md`"听写"能力的关系

`docs/proposals/voice-kit-SPEC.md` 描述的是另一种、更早、仍然有效的语音能力：按一下说一段、转写、塞进 composer 输入框、用户自己编辑发送——这是"听写得更快"，不是本文档的"voice-native control plane"。两者**不是同一功能的两个实现版本**，是产品里会长期共存的两个入口：

- 传统文字输入模式下的语音按钮：继续走 `voice-kit-SPEC.md` 的听写模型。
- 持续语音流 / Live Voice 模式：走本文档 §1-§8 的模型。

`voice-kit-SPEC.md` 里积累的裁剪/VAD/采集栈（`AudioWorklet`、`StreamingVad`）在 L0 层仍然可以复用（见前序讨论），但 L1 往上的推理/工具调用/状态机是本文档独有的,不下沉进 `voice-kit-SPEC.md` 的包划分。

---

## 10. Prototype / GOAL 范围判断

### 10.1 当前阶段验证范围（按 P6 更新）

当前 prototype 要验证的是三件事,按 P1/P3/P4 重新界定(比单纯"语音识别质量更好"宽,比"完整产品"窄):

1. **live voice-native reasoning**：§5 的歧义场景（同音词歧义、自我更正、指代消解）上,audio-native + 工具调用确实优于现有 ASR→文本路径。
2. **semantic control**：§2 的高层工具调用协议（`session_send` 等形状）可行、可离线验证、不退化成"猜参数"。
3. **background-task-aware interaction**（本轮新增的验证范围，来自 P3/P4）：Qwen 能不能正确回答"刚才那个任务怎么样了""这个做完了吗"这类依赖 §3 world-model 的问题——这不是语音识别质量问题,是"有没有正确调用`session_get`/`run_get`/`approvals_list`/`session_background`,并且没有在找不到答案时瞎编"的问题。

**speech output（§8）明确排除**，放在 roadmap，不是当前 milestone 的阻塞项（P5/P6）。打断/排队完整状态机（上一版设计 §5-§8 的完整实现）、`approval_answer` 的生产级确认 UX、前端模式切换 UI，同样不在当前 prototype 范围——它们是"验证完质量声明之后才值得做"的下一步。

### 10.2 非目标（更新）

- 不接真实 Claude Code 会话落一次真的 `chat.send`；`session_send`/`session_get`/`run_get`/`approvals_list`/`session_background` 形状的工具,执行侧在 prototype 阶段全部是**注入的夹具数据**,不是活的 `ChatControlService` 调用。
- 不改任何前端代码。
- 不做 §6 的生产级主动通知管道（`notifyBackgroundWorkCompleted` 的接线）——prototype 只需要证明"Qwen 能从夹具状态里查到正确答案",不需要证明"通知真的推送到了浏览器"。那是后续阶段,直接复用 `claude-resident-sessions.md` 已有机制,不需要本 GOAL 重新设计。
- 不做 §8 的 speech rendering 层。
- 不做 SSRF 白名单、用户凭据存储、设置页。
- 质量数字不进判据集（ADR-004 决策 8 的既有纪律），任务的 AC 判定"实验跑得严谨、记录写得完整",不是"Qwen 赢了"。

### 10.3 需要改动/新增的模块与测试（更新：world-model 工具集扩大）

| 位置 | 新增/改动 | 理由 |
|---|---|---|
| `server/modules/voice-realtime/` | `voice-realtime-bridge.service.ts`、`voice-realtime-tools.ts`（工具 schema + 注入 executor）、`index.ts` | 真正新的运行时原语,必须是出货模块 |
| `server/modules/voice-realtime/tests/` | 单元测试 + false-forms | 和每个现有适配器任务一样要有"始终在线"的一半 |
| `experiments/voice-realtime-ambiguity/` | `PREREG.md`、`fixtures/`（**四类**场景：同音歧义、自我更正、指代消解、**world-model 状态查询**）、`run.mjs` | 新增第四类场景覆盖 10.1 第 3 点 |
| `docs/experiments/<date>-voice-realtime-ambiguity.md` | 新记录 | |
| `docs/experiments/README.md` | 索引行 | |

`voice-realtime-tools.ts` 的工具 schema 集合相应扩大：不只是 `ui_visible_context`/`session_send` 形状,还要包含 `session_get`/`run_get`/`approvals_list`/`session_background` 形状——这是验证范围第 3 点要求的直接后果,不是额外加戏。

### 10.4 是否需要多层协同（不变）

| 层 | 要不要动 |
|---|---|
| 前端 | 不需要 |
| 后端（新模块） | 需要，核心交付物 |
| MCP / ChatControlService | 只需要 schema 层面复用，不需要真实执行 |
| Realtime provider | 需要，唯一真正新的外部依赖；离线路径假 WS，`--live` 手动模式才打真实 DashScope |

### 10.5 一个任务能不能闭环：不能，结论不变

对照先例的结论没有变（§10.6 展开），**反而因为验证范围第 3 点的加入而更确定**：world-model 查询需要的工具形状比单纯 ASR 对比多了至少四种（`session_get`/`run_get`/`approvals_list`/`session_background`），这进一步确认"新协议原语 + 工具目录 + 严谨对比实验"三件事分开失败点的必要性。

### 10.6 建议的 GOAL 与子任务拆分（更新）

**建议按 GOAL 建**（下一个可用编号示例：GOAL-029，实际由 `goal_write` 分配；`origin` 应引用本文档而不是聊天记录本身）。

标题方向更新为反映 P1/P3/P4：**"Qwen Realtime 语音原生推理 + 语义控制 + 后台任务感知交互——可复现的最小对比读数"**（不再只是"歧义场景对比"）。

**Task 1 — `gap-voice-realtime-bridge-offline-provable`**

- `server/modules/voice-realtime/` 的 bridge + 工具 schema（**现在覆盖 §2/§3 列出的全部只读 + 写 工具形状**，不只是两个）+ 假 WS 服务端上的离线测试。
- AC 骨架：连接状态机可测/`session.update` 工具 schema 与现有 MCP Zod 定义逐字段一致/function-call 路由正确（含对 §3 新增四种读工具形状的路由）/异常路径不崩溃/静态门。
- 边界：不连真实 DashScope；不接 `ChatControlService`。

**Task 2 — `gap-voice-realtime-ambiguity-prereg`**

- **四类**场景的 TTS 语料 + 标准答案 + 打分口径，取数前提交：同音歧义、自我更正、指代消解、**world-model 状态查询**（第四类的标准答案形状不是"转写对不对"，是"该调用哪个工具、工具返回的夹具状态下,正确的自然语言回答是什么,以及"不知道"时是否诚实说不知道而不是编造"）。
- 边界：不跑任何真实识别/推理，只交付语料和判据。

**Task 3 — `gap-voice-realtime-ambiguity-paired-record`**（`depends_on: [Task1, Task2]`）

- 同一次运行跑两条臂（现有 ASR→文本路径 vs Task 1 的 bridge），**四类场景分别出结论**（第四类场景现有 ASR→文本路径大概率直接没有能力回答——这本身也是要如实记录的一条读数，不是预设的"赢"）。
- AC 骨架照抄 `gap-asr-omni-paired-quality-record` 的九条判据结构：n 报告/负对照能红/不跨运行/被测出货模块/记录存在且四类场景各有结论/质量数字不进判据/凭据不入库/静态门。

**Task 4（stretch，可选，依旧非必做）— `gap-voice-realtime-session-send-smoke`**

若 Task 3 的读数支持继续投入，再单独开任务把工具真的接到 `ChatControlService`，对测试会话跑一次真实冒烟（人工验证，不进 CI）。§6 的生产级通知接线、§8 的 speech rendering 层，各自需要独立的后续 GOAL，不在本 GOAL 范围内——这是 P5/P6 对范围的直接约束。

### 10.7 AC-315（2026-10-09 追加）：音频输入要同时支持真实麦克风与文件上传，CI 验收不依赖物理麦克风

GOAL-031/AC-312 落地浏览器闭环时，暴露了一个和§10.1-10.6 的规划不同的具体问题：AC-312 唯一卡住的 AC5（真实麦克风+真实网络的人工走查）是**结构性人工门**，不是实现缺口——执行者无法在没有物理麦克风的 CI 环境里验证它，这也不该被当作缺口去"修"。但这不意味着语音输入的其余部分也必须依赖人工：人 yale 2026-10-09 明确要求把"音频输入"拆成两条独立路径——

- **真实麦克风**：继续只服务 AC-312/AC5 的人工 smoke test，`needs-human` 是它的正确终态，不强行机检。
- **文件上传**：作为并列的第二条输入方式，专门为 CI 设计——固定语料、确定性、可重复，不涉及任何浏览器麦克风权限或音频设备。

这条拆分的落地原则是**一条管线，两个入口**，不是"做一套新的上传专用实现"：浏览器端把音频捕获抽成一个 `VoiceRealtimeAudioSource` 接口（`src/modules/chat/voice-realtime/audioSource.ts`），麦克风和文件解码各自只是这个接口的一个实现，往下的 socket 分帧、代理转发、工具调用、意图确认全部复用同一段代码——这和 `useVoiceInput.ts` 里录音输入已经验证过的 `VoiceCaptureEngine` 抽象是同一个模式，不是本次新发明的设计。

同一次补充里，用户还要求把"协议/接口层的模拟交互测试"做实——chunk 时序、打断、断线重连、并发 `response` 竞态、工具调用/`function_call_output` 回填——这些是 `/voice-realtime` 代理自己的协议行为，和浏览器、麦克风都无关，所以用一个 offline 的 `node:test` 套件直接驱动代理（假的上游 transport + 假的浏览器 socket），复用 AC-310/AC-311 已经验证过的 `createFakeTransport` 测试夹具。这个套件在编写并发竞态场景时，真的在 `voice-realtime-ws-proxy.service.ts` 里揪出一个此前没被任何测试覆盖到的死锁：两个 `session_send` function_call 在被裁决前先后到达，第二个会静默覆盖代理里单槛位的 `pending`，让第一个调用永远等不到裁决——这是 AC-308 已经真实撞过的"DashScope 服务端 VAD 可能在前一个响应完成前就开始下一个"那类竞态的直接后果，不是假设性风险。

这一条追加记为 **AC-315**（挂在 GOAL-031 下，和 AC-312 并列、独立验收，见 GOAL-031 自己的"退出条件"一节），落地任务是 `gap-voice-realtime-upload-audio-and-protocol-simulation`，详细的判据命令、取假形态、现场验证记录见该任务与 AC-315 本身的记录，不在本文档重复。

---

## 12. 长期愿景：从 single-session voice input 到 multi-agent aggregation/orchestration front-end

### 12.1 这不是假设的未来场景——我们现在就在用它的文字版本

人↔ChatGPT↔CloudCLI↔多个 Claude Code resident session，是**我们当前实际的协作方式**：一个持续的、人直接对话的前端（这次架构讨论发生的那个会话本身），后面同时连接着分散在不同 project/session 里的多个 Claude Code agent。这个前端在做的事——根据人的意图定位该找哪个项目、把人的话重写成适合后端执行的指令、汇总多个后端的进展再向人汇报——**已经是本文档 §12.3 要描述的那套能力，只是前端通道是文字,不是语音**。

这件事值得单独写一节的原因是：它纠正了一个容易默认的范围假设。**§1-§9 描述的"一个语音连接 ↔ 一个 Claude Code 会话"不是长期目标的终态，只是长期目标的一个构件（单会话层）。** 长期目标是把这个构件接进一个本身就能跨项目、跨会话协调的前端层——而这个前端层的文字版本不是要新建的东西，是已经在运行的东西。

### 12.2 两种模式的区分

| 维度 | Single-session voice input（§1-§9 当前架构范围） | Multi-agent aggregation / orchestration front-end（长期目标，本节） |
|---|---|---|
| L1 Qwen Realtime 会话 ↔ L3 Claude Code 的关系 | 一个语音连接 ↔ 一个会话/一个 project | **一个**持续的 human-facing 语音会话 ↔ **同时**多个 project/session 的后端 agent |
| 前端的职责范围 | 理解单一会话内的意图、解歧、turn/interrupt/queue（§5、§3） | 在此之上**叠加**：为意图选址（哪个项目/会话该接这句话）、把意图编排/转述到多个后端、合并多个后端的结果、维护跨会话的长期工作上下文 |
| 上下文归属 | 会话局部的 world model（§3） | 前端持有**跨项目的长期上下文**；各后端 session **继续各自保留局部工程上下文**——前端不取代、不吞并后端的上下文，是两层分工，不是前端变成唯一的记忆持有者 |
| 当前证据状态 | §1-§9 是对**已有基础设施**（MCP 工具表、resident session 的跨会话寻址）的组合，架构上可论证、可小步验证（§10 的 prototype） | §13 列出的指标目前**一条都没有测量过**，是重要假设，不是既成事实——这是本节和 §1-§9 最大的区别 |

**长期目标是右列,§10 当前 GOAL/prototype 的范围仍然是左列**——这条边界在 §10 已经用"非目标"写清楚，本节不改变那个边界，只是把左列放进右列的完整图景里，说明左列为什么值得先做。

### 12.3 前端层的五个协调能力

```
                     ┌─────────────────────────────────────┐
                     │   持续的 human-facing 前端会话         │
                     │   （语音版 = L1 Qwen Realtime；        │
                     │    文字版 = 我们现在这种协作方式）       │
                     │                                       │
                     │   持有：跨项目的长期工作上下文           │
                     └──────────────┬────────────────────────┘
                                     │ ① 选址/定位
                        ┌────────────┼────────────┐
                        ▼            ▼            ▼
                  ┌──────────┐ ┌──────────┐ ┌──────────┐
                  │ Project A │ │ Project B │ │ Project C │
                  │ Claude    │ │ Claude    │ │ Claude    │
                  │ resident  │ │ resident  │ │ resident  │
                  │ session   │ │ session   │ │ session   │
                  │（局部工程  │ │（局部工程  │ │（局部工程  │
                  │  上下文）  │ │  上下文）  │ │  上下文）  │
                  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘
                        │ ③ 主动推送    │             │
                        │  进展/阻塞/   │             │
                        │  完成         │             │
                        └──────┬───────┴─────────────┘
                               ▼
                     ④ 前端把 A 的发现转述给 B，
                        让 B 验证，合并结果
                               │
                               ▼
                     ⑤ 向人汇报（一次、合并后的汇报，
                        而不是三条分散的进展）
```

1. **选址/定位（routing）**：根据人的高层意图，决定这句话该找哪个项目/会话——不是"语音永远绑定一个会话"，是"语音前端先判断该找谁"。
2. **意图重写/扩展（intent authoring）**：把自然语音里模糊、高带宽的意图，重写/扩展成更适合**具体那个后端 agent**执行的指令——这是 §5"结构化意图而不是逐字转写"原则的跨会话版本，多了一层"这句话对 B 来说该怎么表达,可能要带上 A 刚才的发现"。
3. **主动接收多后端推送（aggregated notification）**：这是 §6"状态跃迁驱动通知"从**一个会话**扩展到**多个会话的聚合视图**——人不需要轮询三个会话各自的进展,前端负责收。
4. **跨项目协调（cross-session choreography）**：把 A 的发现转述给 B、让 B 验证 A、合并多个结果再向人汇报——这是**全新的编排能力**，不是现有基础设施的直接复用。§2 的 `session_send` 已经可以寻址任意会话（provider-neutral，按 app session id），`claude-resident-sessions.md` 已经实测过"另一个会话用界面上复制的地址 `SendMessage`，对方能收到并产生一轮"（§12，该文档的编号）——这证明**底层的跨会话送达原语已经存在**；但"把 A 的发现转述给 B"需要前端自己**构造**要转述的内容，不只是转发原文，这部分编排逻辑是真正新增的。
5. **分层的上下文归属（layered context）**：前端维护跨项目的长期工作上下文，后端各 session 继续保留自己的局部工程上下文——这是职责分工，不是前端吞并后端的记忆。

**与本系统已有的"人工版"姐妹设计的类比**：`quay:manager` skill 描述的"第三层——跨项目规划、优先级排序、趋势观察"，本质上是同一种分层思路的**人类驱动**版本（人周期性地跨多个 quay 项目巡检、协调）。本节描述的前端层可以理解为"把这个协调动作,接进一个持续对话的 agent,而不是人周期性巡检"——两者的受众和触发节奏不同，但"上面一层做跨项目协调、下面各层保留局部上下文"的分层原则是同构的，不需要为语音前端重新发明这条原则。

### 12.4 另一条互补的工作线：从平铺 session 列表到按架构组织的 engineering context

与"Live Voice coordinator 把人从低层执行与多会话协调中抽离"相对、且互补的，是另一条同样在推进、但方向不同的工作线：提高整个体系的**架构设计、架构表达和上下文组织能力**，让后端 agent/session 不再只是一张平铺的会话列表，而是按系统架构的不同剖面/视图来组织上下文。

**这条线目前在本仓库里没有对应的已落地机制或已提交的 proposal——我没有可以指向的文件。** 唯一能确认存在、方向上相邻的东西，是这次会话工具环境本身就接着的 ArchGuard 能力（分层/聚类边界/依赖图/包级指标/GIM 上下文这一类机械架构分析），但它**没有被接进 ClaudeCodeUI 本身**，也不是"coordinator 按架构剖面路由意图"这件事的现成实现——只是主题相邻，不代表机制已经存在。这条线真正在哪个会话里推进、产物是什么形态，我这边看不到，不替它编一个具体形态；如果已有可引用的 proposal/会话产物，应该在下一次修订里把具体链接补进来，而不是现在猜。

**设想的方向（长期架构方向，非已完成机制）**：未来的 coordinator 面对的不是 N 个平铺的 session，而是一个有结构的 **engineering context graph / architecture-oriented workspace**——不同会话分别承载同一个系统的不同架构剖面（例如：运行时、数据流、部署、UI、协议、任务/风险、验证），或者围绕不同 bounded context 组织。coordinator 能基于这个结构，把人的高层意图路由到合适的剖面/会话，并在一个意图跨越多个剖面时，协调多个 agent 共同完成。

**与 Live Voice 方向的关系：两条线提升的是协调关系的两端，不是同一件事。**

| 工作线 | 提升的是哪一端 | 提升的是什么 |
|---|---|---|
| Live Voice coordinator（§0、§12.1–§12.3） | **人 ↔ coordinator** | 交互的抽象层级和带宽——人说高层意图、纠正、优先级，不用逐条操作 |
| 架构组织 / engineering context graph（本节） | **coordinator ↔ backend agents/context** | 结构化程度和架构表达能力——coordinator 面对的不再是平铺列表，而是按架构剖面组织的上下文 |

两条线各自独立地有价值，**汇合之后的目标**才是本文档 §12 真正想抬到的高度：不是"管理一堆平铺 session"，而是让一个 human-facing coordinator，在一个**按架构组织**的多-agent 工作空间上工作——人说"这个功能要跨运行时和协议剖面都改一下"，coordinator 既要听懂这句话（Live Voice 那一端），也要知道该把哪部分路由给哪个剖面的 agent、以及两个剖面之间需要协调什么（架构组织那一端）。

**这是长期架构方向，不是已经完成的机制。** §12.1–§12.3 描述的多会话协调，今天连"协调本身"都还是人工在做（本文档已经如实记录）；本节描述的"按架构剖面组织的 engineering context graph"，成熟度上比那个更靠后——目前**没有**任何已落地的结构、没有任何已验证的路由机制，只是一个方向性的设想。它和 §12.1–§12.3 一样需要 §13 的证据计划去验证值不值得投入；如果真的要往这个方向走，应该先往 §13 补一条"架构剖面路由准确率 / 跨剖面协调正确率"之类的指标，而不是现在就假设它有效。

### 12.5 这不改变 §10 当前 prototype 的范围

本节（含 12.4）是 roadmap，和 §8（speech output）性质一样：写进文档是为了不让 §1-§9 的协议设计堵死这条路（例如 §2 的工具寻址本来就是按 session id 而不是绑死单一会话，这对将来接多会话、乃至按架构剖面组织会话都是友好的），但**不要求**当前的 GOAL/prototype（§10）提前实现任何跨会话编排能力或架构剖面路由。§10 的非目标继续有效。

### 12.6 Multimodal Engineering Workspace：三层信息架构、注意力管理与 Quay/ClaudeCodeUI 分工（2026-10-09 补充，人 yale 的长期方向判断）

本节把 §12 的长期愿景收紧成一个更具体的产品形态判断：**Live Voice 的终态不是"把语音接进聊天框"，是一个多项目、多会话、多 agent 的 Multimodal Engineering Workspace**——语音是这个工作台的一个输入/提醒通道，不是它的全部，也不是它主要的信息输出形式。这条判断决定了 §12.1-§12.4 描述的协调能力该长在什么界面上，和 §10 当前 prototype/GOAL-031 的范围无关——见 12.6.7。

#### 12.6.1 目标：减少 tab 切换与人工上下文重建

这个工作台存在的理由不是"语音听起来更先进"，是**减少人在多个项目/会话/任务之间来回切换标签页时，每次切换都要在脑子里重新拼出"我刚才在哪、现在该干什么"的操作负荷**。§12.3 已经列出协调层的五个能力（选址、意图重写、聚合通知、跨项目协调、分层上下文）；本节回答的是"这些能力该渲染在什么界面上"，不是重新发明它们。

#### 12.6.2 三层信息架构

| 层 | 内容 | 回答的问题 |
|---|---|---|
| **Portfolio Overview** | 多项目全局状态——有几个项目、哪些在跑、哪些卡住、哪些在等人 | "我该先看哪个项目" |
| **Project / Goal / Task / Driver / Session** | 对单个项目的多剖面展示：任务依赖图、执行时间线（§12.4 提到的 Gantt 一类视图）、资源占用、测试/判据状态、阻塞原因 | "这个项目现在的具体状态是什么" |
| **Evidence / Action** | 关联的 transcript、日志、测试证据，以及直接可执行的操作 | "证据在哪、我现在能做什么" |

三层之间是钻取关系（Portfolio → Project 剖面 → 具体证据/操作），不是三个互相独立的页面；语音/文字输入在任意一层都可以发起钻取或动作，而不是只能在最底层说话。

这一层**不是从零设计**——第二层（Project/Goal/Task/Driver/Session）里"执行时间线"这个具体部件，本仓库已经有一条独立的设计任务把它的接口形状、数据缺口和实现路径定清楚了：`gap-quay-tab-loop-pulse-gantt-cross-project-interface-design`（done，设计性质，未实现）。那份设计本身就是本节三层架构里第二层的一个具体样本，不需要重新调查。

#### 12.6.3 语音的角色：简报、异常提醒、必要交互——不是主要输出通道

这是 §0 的 P1/P5 和 §8 的 speech-rendering 方向在这个工作台里的具体落点：语音承担**简报**（"现在整体状态怎样"）、**异常提醒**（"这个任务卡住了/需要你"）和**必要的交互**（送出一句高层意图、回答一个确实需要人判断的问题）；主要的信息输出仍然是**结构化、可交互的视觉 UI**（三层架构本身），不是让语音去念任务依赖图或测试矩阵——那正是 §8 已经论证过"直接 TTS 念原始输出"不成立的理由，这里只是把它从"一段对话"推广到"一整个工作台"。

#### 12.6.4 注意力管理

工作台要主动管理的，不是内容本身，是"人的注意力该往哪引"：状态变化（一个任务从 ready 变成 done/needs-human）、阻塞（§6 已经设计过的状态跃迁通知，在这里从单会话扩展到跨项目聚合）、**等待用户回答**（AskUserQuestion/权限请求挂起——这正是 `gap-mcp-pending-interaction-visibility-and-idempotent-answer`（ready）已经在打的那个地基：它给 `session_get`/`sessions_list`/`approvals_list` 补上 `pendingInteraction`/`awaitingUser`/`interactive` 这些字段，是本节"注意力管理"在数据层唯一需要的东西，本工作台不应该另起一套"是否在等人"的判断逻辑）、以及**跨会话信息关联与去重**（多个会话在报同一个底层事实时，只提醒一次，不是叠加噪音）。

#### 12.6.5 PC 与移动端的渐进式信息展示

三层架构在小屏幕上不是"全部塞进去再缩小"，是**渐进展开**：移动端默认只看 Portfolio 层 + 异常提醒，钻取才展开到 Project 剖面，再钻取才看到 Evidence/Action 的细节——这和 §10.1 "PC/移动基本体验"的颗粒度不同，§10 只要求当前单会话闭环在两种视口下"能用"，本节是未来多项目工作台在信息密度上的分层策略，不是同一件事的重复描述。

#### 12.6.6 Quay 与 ClaudeCodeUI 的分工边界：不重复构建状态模型

**Quay 优先负责 project/goal/task/driver/session/turn 这些底层语义与状态的权威来源；ClaudeCodeUI 负责 UI 渲染与 Voice 前端，不自建第二份状态机。** 这不是一条新发明的原则——`gap-quay-tab-loop-pulse-gantt-cross-project-interface-design` 的设计结论已经把这条原则应用了一次：它在"甘特图的车道分配算法"这个具体问题上，明确倾向**路径 A**（请 Quay 上游把纯算法导出成可复用 kernel，ClaudeCodeUI 作为真实依赖引入，而不是自己抄一份再用等价性测试兜底）。本节把这个个案决策提升成工作台级别的默认立场：**任何时候 ClaudeCodeUI 想知道"某个任务/会话/driver 现在的状态"，第一选择是读 Quay 已经暴露的只读接口（CLI verb、MCP 工具、`QuaySnapshot` 一类投影），不是自己重新扫一遍 `/proc`、重新维护一份任务图。** 这条边界同时解释了为什么 §12.6.2 的第二层不需要本文档重新设计数据模型——数据模型是 Quay 的，ClaudeCodeUI 只做投影和渲染。

#### 12.6.7 与当前 GOAL 的关系：不扩大 GOAL-031，长期方向另开 GOAL

**本节描述的工作台方向不改变 GOAL-031 的范围**：GOAL-031 仍然是单会话、当前项目范围内的最小语音闭环验证（§10/GOAL-031 自己的"第二阶段非本 GOAL 范围"条款已经把跨项目/多会话排除在外）。本节的长期方向由独立的 **GOAL-032**（draft，未激活）追踪，GOAL-032 的产出是架构规格与可行性调查，不是立即实现——关系是"GOAL-031 先把单会话闭环做实，GOAL-032 在不扩大 GOAL-031 验收范围的前提下，独立推进这个更大的产品形态判断该怎么落地"。

#### 12.6.8 保持已有的审批/确认立场不变

GOAL-031 已经明确裁定：短期不新建复杂审批体系或逐操作确认门槛，复用既有权限机制、工具白名单与参数校验（§7、GOAL-031 的"非目标"一节）。**本节的工作台愿景不改变这条裁定**——即使工作台扩展到多项目/多会话，"危险操作需不需要人确认"这件事仍然应该复用 Claude Code 自己已有的 `canUseTool`/`approval_answer` 机制和 `gap-mcp-pending-interaction-visibility-and-idempotent-answer` 正在强化的那套可见性，不是工作台自己发明一层新的审批界面。

#### 12.6.9 后续：协调层的 agent 化（2026-10-11 补充，指针，不改上文）

§12.3 的协调层后来的讨论结论是：它是一个跨项目、常驻的 **Manager Agent**，Chat 和 Live Voice 都只是它的界面。具体设计（Goal→Observe→Assess/Decide→Act/Delegate→Verify→Learn/Report 闭环、L0–L3 授权与 Decision Budget、版本化 Policy、5 个指标、Shadow 回放）写在 `docs/proposals/cloudcli-ai-manager.md`。该文和本节有两处张力，在那份文档的 §11 列出、待裁定，**本节原有立场不变**：一处是 §12.6.8「不新建复杂审批体系」（那边的 T1），另一处是 §14.4 的跨项目信任边界（那边的 T4）。

---

## 13. Future evaluation / evidence plan（长期愿景的验证计划，非当前 GOAL 范围）

### 13.1 先把立场说清楚：这是假设,不是事实

§12 描述的核心价值假设是——**前端 agent 对人的原始语音做 native-audio reasoning，再结合跨项目/跨会话上下文把指令编排后发给后端，可能比人直接给每个 Claude Code session 手写 prompt 质量更高、信息带宽更大。**

这是一句"可能"，不是一句"已经证明"。本节的作用是：在真的投入做 §12 那套编排能力之前，先把"将来拿什么数据来判断这个假设对不对"写下来——这是这个仓库一贯的实验纪律（取数之前先写判定标准，`experiments/voice-draft` 的每一版 `PREREG.md` 都是这么做的），不是本节自己发明的新要求。

§13.2 测的是这一句具体的价值假设；§背景节"为什么是现在"提出了一个更高层、覆盖面更宽的经济学假设（吞吐率提升后稀缺资源转移、代码越便宜错误方向越危险），§13.3 是那个假设对应的指标——两组指标回答的是不同层级的问题，不要混着看。

### 13.2 要测的指标

| 指标 | 定义 | 对比对象 |
|---|---|---|
| **任务成功率** | 前端编排后发给后端的指令，后端 agent 一次执行下来是否达成了人实际想要的结果（不只是"没报错"，是"人验收通过"） | 前端编排 vs 人直接手写 prompt 给同一个后端 |
| **返工/澄清次数** | 从意图发出到人验收通过之间，需要几次追加澄清/纠正 | 同上 |
| **语音时长/输入信息量 → 有效任务信息量** | 用户说了多久/多少 token，其中真正转化成后端能执行的有效指令信息占多大比例——需要一个"有效信息量"的打分口径，可以借鉴本仓库已有的弱标签/保真度方法学（如 `src/shared/identifierFidelity.ts` 衡量标识符保真的思路）去定义一个类似的"意图保真度"指标 | 语音输入 vs 文字输入；前端编排后的 prompt vs 原始语音/文字 |
| **跨会话协调成功率** | "把 A 的发现转述给 B，B 验证，合并结果"这类编排动作，最终是否产出正确、人认可的合并结果 | 前端自动编排 vs 人工手动在多个会话间转述 |
| **人工轮询次数** | 人主动问"做完了吗/现在怎样了"这类问题的次数——按 §0 P3 的目标，这个数字应该随前端能力提升而趋向于零 | 有前端主动通知 vs 没有（或传统轮询式交互） |
| **意图到完成的 wall-clock time** | 从人说出一句高层意图，到所有相关后端工作真正完成、人确认验收，经过的真实时间 | 前端编排的多会话协调 vs 人工手动驱动多个会话 |
| **用户干预次数** | 整个过程中人需要亲自介入纠偏（而不是让前端处理）的次数 | 前端编排 vs 无前端 |
| **A/B 对照：前端重写后的 prompt vs 用户原始 prompt** | 把**同一个**后端 agent、**同一个**任务，分别喂"前端编排后的指令"和"用户未经编排的原始表达"，对比下游结果（成功率、返工次数）——这是对核心价值假设**最直接的因果检验**，应该作为这组指标里优先级最高的一项 | 配对比较，同一后端、同一任务、仅指令来源不同 |

### 13.3 对应更高层经济学假设的指标（吞吐率/架构健康，不限于 Live Voice）

§背景节"为什么是现在"提出的判断——吞吐率提升后稀缺资源转移到规格澄清/架构设计/跨 agent 协调/验证评估——比 §13.2 的指标覆盖面更宽：§13.2 测的是"Live Voice 这一个前端好不好用"，这里测的是"抬高协调层这整件事，在吞吐率持续提升的背景下，有没有真的把新风险压住"。这组指标同时适用于 (a) Live Voice coordinator 和 (b) architecture-oriented context/workspace 两条线，不是只归 §12 一节：

| 指标 | 定义 | 对比对象 |
|---|---|---|
| **吞吐提升后的返工率** | 单位时间内产出的变更量上升之后，被要求重做/回退的比例是否同步上升——这是"稀缺资源转移"判断最直接的反面指征 | 有 coordinator/架构组织介入 vs 没有，在同样的吞吐水平下对比 |
| **跨模块冲突率** | 多个 agent 并行改动同一系统时，产生合并冲突/语义冲突（不只是 git 冲突，也包括"两处改动各自看起来对，放在一起不一致"）的频率 | 按架构剖面组织的多 agent 工作 vs 平铺 session 的多 agent 工作 |
| **架构漂移** | 实际实现偏离声明的架构边界/依赖方向的频率或幅度——可能的机械衡量途径见 §12.4 提到的 ArchGuard 一类分层/依赖分析，但这条本身也要先验证"机械读数能不能代表真的漂移"，不能直接假设 | 有架构组织的上下文 vs 无 |
| **协调开销** | coordinator 本身引入的额外延迟/认知负担（人要花多少注意力去理解 coordinator 在做什么），是否小于它省下来的轮询/转述成本——如果协调本身比它要解决的问题更贵，这条线就是净负收益 | 有 coordinator vs 人工直接协调（§13.2 已有的"人工轮询次数"是这条的一个子集） |
| **从意图到验证完成的周期** | 不是"代码写完"算完成，是"验证通过、人确认可接受"才算完成——意图提出到这个点之间的真实耗时，是不是随吞吐率提升而缩短，还是被返工/冲突/漂移抵消掉了 | 吞吐率提升前后对比；有/无这两条元层工作介入对比 |

**这组指标目前都还没有读数**，和 §13.2 一样，是"将来要测什么"的清单，不是已经验证的结论。

### 13.4 方法论：复用这个仓库已经验证过的实验纪律，不是另起一套

真正执行这组评估时，应该遵循本仓库 `experiments/` 目录下所有语音实验共用的纪律（`voice-draft`、`voice-omni-written` 等的通用协议）：取数前写 `PREREG.md` 冻结判定标准和打分口径；留负对照验证打分口径本身没问题；人工盲评而不是只信机械指标；质量数字本身不进 CI 判据，按 ADR-004 决策 8 的既有原则,只以实验记录的形式存在。**不要在还没有真的建成 §12 的编排层之前，先去定一套看起来精确但实际上没有数据支撑的量化门槛**——这正是"写判定标准要在取数之前，不是在建系统之前凭空细化"之间的分界：本节现在要做的只是列清楚"将来测什么"，不是现在就给每个指标定及格线。§13.3 的指标比 §13.2 更难量化（尤其是"架构漂移""协调开销"），更需要先在小范围内做一次探路性的、不预设结论的读数，再决定值不值得定成正式的评估协议。

### 13.5 范围边界：不是当前 GOAL 的一部分

本节和 §12 一样是 roadmap。§10 的 prototype/GOAL 只验证单会话层的 live voice-native reasoning + semantic control + background-task-aware interaction（§10.1），不包含任何跨会话编排能力,因此本节的指标在当前阶段**没有东西可测**——记录下来是为了等真的要做 §12 那层编排能力时，评估设计已经就位，不需要事后现编。

---

## 14. 待确认/未决问题汇总

1. §3 的"排队状态读不出来"的缺口是否值得补一个新 MCP 读工具——留给 Task 1 完成之后，看是否真的卡住了 world-model 场景的读数。
2. §8 的 speech rendering 层是否复用 L1 的同一个 Qwen 模型做总结，还是用另一个更便宜的文本模型——留给 §8 对应的后续 GOAL，本文档不预判。
3. §6 的"主动播报"在 Voice session 仍在线但用户正在说别的话时如何不打断——这是 §6 落地到生产阶段时才需要解决的排队/打断细节，当前 prototype 不覆盖。
4. §12 的前端汇聚层一旦真的跨多个项目/会话操作，它自己的鉴权/信任边界该如何定义——§2 现有的 MCP scope（`cloudcli:read`/`cloudcli:session:send`/…）是按单个已认证用户设计的，没有区分"前端在为哪个项目说话"；是否需要一个更细的、按项目/会话维度授权的模型，留给 §12 真正要落地时单独设计，本文档不预判。
