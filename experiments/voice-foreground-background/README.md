# Live Voice：前台只做调度、打断只停前台、中继更多打断——三层设计的实验（2026-10-15）

人 yale 的设计（同日裁定：第 1 层走 hook 注入；不再加「全部停下」硬停；长操作阈值由近期实际使用给建议值）：

1. Claude Code 在 Live Voice 模式下尽量把长操作交给后台 subagent，前台少阻塞；
2. realtime 模型要求打断时，只机械打断前台，后台的去留交给 Claude Code 自己；
3. 在此基础上调整 realtime 指令，让它更多地输出打断。

**花费**：DashScope **¥0.5296**（预算 ¥0.5，**超 ¥0.03**：E3 第二轮 12 路并发，全局预算闸只在越线后关 socket，在飞会话冲过了 ¥0.25 的轮内上限）。
Claude 侧走 Max 订阅，`total_cost_usd` 为名义值：E1/E1b/E1c 全用 haiku；E2 首轮**误用 opus**（22 次，人随后要求实验一律用最便宜的模型），重跑用 haiku（33 次）。

| 文件 | 内容 |
|---|---|
| `analyze-turns.mjs` | 阈值依据：近期语音触发的前台 turn 时长、工具时长 |
| `e1-interrupt-survival.mts` | E1/E1b：SDK `interrupt()` 对后台 Bash / 后台 Agent 的影响 |
| `e1c-now-priority-redirect.mts` | E1c：`priority` 消息能否在工具边界软改道 |
| `hook/voice-mode-context.mjs` | 第 1 层的 UserPromptSubmit hook（规则文本 + 门控） |
| `e2-hook-compliance.mts` | E2：hook 开/关下，真实语音指令的第一步决策 |
| `e3-interrupt-prompt.mts` | E3：中继 prompt「更多打断」臂，真实 capture 回放 |
| `traces/` | 全部原始读数 |

## 阈值依据（`analyze-turns.mjs`）

源：25 个语音会话、172 个由语音投递触发的前台 turn（voice journal `session_send` → app DB → Claude transcript）。

- turn 时长 p50 **15.3 s** · p75 35.4 s · p90 81.7 s。
- **> 20 s 的 turn 占 45%，却占前台总时长的 90%**；≤ 20 s 的 turn 占 59%，代价很小。
- **前台时间的 75% 是模型自己在想/写，不是工具在跑**（>30 s 的 50 个 turn 里 41 个以模型时间为主）。所以阈值必须按「这轮工作要多久」定，而不能只按单个工具的时长定。
- 工具调用里 > 10 s 的只有 25/680，却占工具总时长的 92%。
- 现状：172 个 turn 里只有 6 个用过 `run_in_background`。

⇒ 建议值：**预计本轮 > 约 20 s 的工作 → 第一步派后台 Agent；单条命令 > 约 10 s → 后台 Bash；≤ 20 s 的直接前台做。**

## E1：SDK interrupt 会杀掉后台 Agent

形状与常驻宿主相同（流式输入不关闭 + `Query.interrupt()`，即 `stopResidentTurn`），haiku，临时目录。

| | 后台 Bash | 后台 Agent（正在跑自己的工具） | 前台命令 |
|---|---|---|---|
| E1（Agent 已把活转给自己的后台 Bash） | 存活 | （不构成检验） | — |
| E1b ×3 有效次 | **存活 3/3**（另 1 次 Agent 未起，Bash 仍存活） | **被停 3/3**：`task_notification status=stopped`，0.1 s 内 | 停 |

另：**3/3 次 Claude 事后说「Agent 还在跑」**，实际已被停。⇒ Claude 对后台状态的记忆不可靠，规则里要求它先查实际状态。

## E1c：`priority` 消息就是不杀东西的软打断（前台步子短时）

后台 Agent 跑 30 s 进度循环，前台做 8 个约 3 s 的短步，第 2 步时推一条新指令：

| priority | Claude 看到新话 | 前台完成步数 | 后台 Agent |
|---|---|---|---|
| `now` | **2.2 s，同一 turn 内** | 2/8 | 跑完 |
| `next` | **4.1 s，同一 turn 内** | 2/8 | 跑完 |
| `later`（**driver 现在用的**，`CLAUDE_QUEUED_INPUT_PRIORITY`） | 31.1 s，turn 结束后 | 8/8 | 跑完 |

与 2026-10-14 探针合读：`now` **不会**抢占一个正在跑的长前台工具（45 s Bash 跑完才轮到它）。所以软打断成立的前提是第 1 层：前台不跑长命令、步子短。

## E2：hook 遵从率（第一步是否派后台）

语料：上面那批里当时前台很长的 7 条 + 很短的 4 条，冷启动单条，cwd = 本仓库。只读工具放行，其它工具记录后拦截。

| 模型 | 臂 | 长任务第一步派后台 | 短句直接答 |
|---|---|---|---|
| opus（首轮，误用） | off | 0/7 | 4/4 |
| opus | on | **4/7**（另 1 meta 答复、1 追问、1 `CronList`） | 4/4 |
| haiku | off / on / fast | **0/7 · 0/7 · 0/7**（多为「需要更多上下文」） | 4/4 |

- opus 派后台之前，前台已思考 **21–37 s**（0 次读文件）。规则管住了「派」，没管住「派之前想多久」。
- haiku 在冷启动语料上不派也不查，主要是追问，**不能代表生产模型在这件事上的行为**；`fast` 臂（「别在脑子里规划，直接把原话写进 Agent prompt」）因此**不足以判断**。
- 风险线索：haiku 在第 5 条（「方括号里那段英文不是我说的」）把注入的 `[Live Voice 模式]` 文本当成了答案。需核对 hook 的 additionalContext 在 claudecodeui 的对话视图里是否可见；可见的话，人会看到一段不是自己说的话。

## E3：中继 prompt「更多打断」

`experiments/voice-realtime-closing-turn` 的骨架：真实 capture 实时回放、出货 silero 门控、原 journal 的 status 时间线。W3 的 capture timeline 已被淘汰，所以只用 W1 / W2 / W4（三个窗口各含一次真停）。

| 臂 | 次数 | 真停识别 | 多出的打断 |
|---|---|---|---|
| K 出货 | 1+2 | **9/9** | 0 |
| I 改写例外段为「忙时凡与工作相关都打断」 | 1 | **2/3**：W4 的「OK，现在可以终止它了」被发成 send | 0 |
| I8 I + 800 ms | 1 | 2/3（同样丢 W4） | 1（一句旁白） |
| **I2 出货段逐字保留 + 追加忙时规则** | 2 | **6/6** | 1/6（「我看你都跑完了？」） |

- 改写例外段会丢真停：出货段里那句「the mistake this exception exists to prevent…」承载着真停识别。
- 追加式（I2）不回退，但增加的打断很少：这些窗口里忙时的话大多是旁白和反馈，不是新指令。**靠 prompt 调高打断率是弱杠杆。**
- 截断调用 `{"message": "` 在各臂都出现（`turn_detected` 截断，与本实验无关的既有缺陷）。

## 结论

1. **第 2 层不能用现在的 interrupt 实现。** `session_interrupt` → `stopResidentTurn` → SDK `interrupt()` 会连带停掉在跑的后台 Agent。「只停前台」的实现应是以 `priority:'now'`（或 `next`）投递新话：在下一个工具边界注入，2–4 s，后台不受影响。
2. **最大的杠杆是机械的，不在 prompt 里。** 忙时语音投递现在被代理的 busy hold 扣住（p50 12 s / p90 106 s），之后又以 `later` 入 CLI 队列、等整个 turn 结束。改成忙时直接以 `now`/`next` 投递，就是「更多打断」，且不依赖中继模型判断。中继模型的 `session_interrupt` 只保留给它判断为停止或改道的话（同样走软路径）。
3. **第 1 层 hook 管用但有残差。** opus 4/7 第一步派后台，但派之前要想 21–37 s。阈值建议 20 s / 10 s（依据见上）。
4. **第 3 层**：要改中继 prompt 的话用 I2 的追加式，不要改写原段落。但在 2 落地之后，它的边际价值有限。

## 局限

- E1/E1c 每格 n=1–3，haiku；CLI 2.1.300 / SDK 0.3.165。interrupt 杀后台 Agent 是 CLI 行为，升级后要复验。
- E2 是冷启动单条，拦截工具后只读第一次决策；生产里有完整对话上下文，遵从率可能更高。
- E3 每臂 1–2 次、3 个窗口、单一说话人；回放不经过 ws-proxy（busy hold、合并窗、follow-up 计数都不在链路里）。
- hook 的生产门控（中继在连接建立/拆除时写/删 `~/.cloudcli/voice-active/<claude session id>`）**未接线**；实验用 `VOICE_MODE_HOOK_FORCE=1`。
