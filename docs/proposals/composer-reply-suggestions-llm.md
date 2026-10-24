# 输入框回复建议（模型生成 chip、「建议」按钮、选中引用）Proposal

状态：Proposal / 已评审（人 yale 2026-10-24 确认：按本文推荐项推进，形态为 task 而非 goal）
承接：`docs/proposals/composer-empty-input-suggestions.md`（第一档：习惯 chip，已落地）
证据基础：2026-10-23/24 对本机会话历史的量化分析，以及在 quay workers 所用 LLM 网关上的真实调用实验（生成 `v4.1flash`，判官 `v4pro` 与 `v4.1flash`）

---

## 摘要

在已上线的「习惯 chip」之外，增加三个来源的 chip，统一成「一段完整文本，点击填入输入框，再由人发送」：

1. **模型生成 chip**：助手回合结束后，由一个便宜的 LLM 直接生成最多 3 条完整回复。
2. **「建议」按钮**：想要时点一下，重新生成所有模型 chip（带上已展示的作为「不要重复」）；有选中文字时以它为重点。
3. **选中引用 chip**：在 transcript 里选中文字，输入框出现一条 `> 原文` 的 chip；不画任何贴着选区的浮条，避免与手机系统的复制菜单冲突。

配置走项目自己的独立配置文件；生成走直连 HTTP（Anthropic 与 OpenAI 两种协议），**不经过 Claude Code 或 Codex**（它们会写转写、出现在侧栏）。

---

## 依据（两位判官；样本为你的真实回复；首抽）

样本 211 条，来自你**全部**回复（不限助手如何结尾）：

| | `v4pro` 判官 | `v4.1flash` 判官 |
|---|---|---|
| 模型 chip 中有「可原样发送」的消息 | 28% | 18% |
| 习惯 chip 精确命中 | 8% | 8% |
| **有现成 chip（任一类）** | **34%** | **24%** |
| **现成或只需基于它修改** | **45%** | **44%** |

分组：助手以提问结尾时可原样发送为 35% / 24%，只是陈述或汇报时为 22% / 13%；你的短回复（≤15 字，占 28%）模型加习惯合起来 62% 有现成的。每次出 3 条互不相同的备选，通常最多命中一条，所以每条 chip 的理论上限约 1/3。

判官是 LLM，**头条数字对判官敏感**（可原样发送 18%–28%，同或近稳定在 44%–45%），没有经过人工标注校准；三个判官在「某条 chip 是否可原样发送」上的重合只有 63%–69%。

其他结论：

- `v4.1flash` 默认会先思考；`thinking: {"type":"disabled"}` 在两种协议上都被网关接受，质量不降（可原样发送 36% 对 32%），延迟中位数 1.96 秒降到 1.14 秒，输出 token 约 200 降到约 70，JSON 全部可解析。
- 多抽有收益但平缓：1 抽 36%，2 抽 38%–40%，3 抽 42%–43%（可原样发送）。重抽用高温（1.0）比低温（0.3）的近似重复少得多（22% 对 56%），命中收益相当。
- 没有帮助的杠杆：给模型加 3 条你自己过去的回复作示例（−5 个点）、要求备选「在决定上不同」（−7 个点）、被否决后要求「不同类型的回复」（新增的同或近 8% 对 17%）。
- 选一条之后再生成扩展：按每条 chip 的收益算，不比多重抽几次更好；价值若存在是交互手感，离线测不出，因此做成缺省关的实验开关。
- 你有 26.9% 的回复引用助手上一条消息 ≥12 个字符（随机对照 0.6%），其中 46% 只复制片段，41% 来自非列表行：这是选中引用 chip 的依据。

---

## 交互规格

**chip 来源与顺序**：选中引用（最多 1 条）> 模型生成（最多 3 条）> 习惯（最多 3 条，已有）。都是完整文本；按归一化后的文本去重；点击填入，不发送。

**可见条件**：习惯 chip 与模型 chip 沿用现有规则（输入框为空、助手空闲、坞没有在画回合……）。**选中引用 chip 例外**：有选中文字时，输入框非空也显示（选中是主动动作，且 60% 的引用型回复引用多处，需要连续追加）；选区消失即消失。

**长文本**：chip 内只显示约 18 个字符加省略号，完整文本放在 `title`。悬停或键盘选中某条时，完整文本作为灰色预览显示在输入框的**第二行**（输入框本来就是两行高，不增加高度）；没有悬停或选中时默认预览第一条模型 chip。触屏设备（`(pointer: coarse) and (hover: none)`）不显示预览，点击直接填入，不满意清空即可（清空后 chip 会回来）。

**「建议」按钮**：标题「建议」（英文 Suggest），提示「根据上下文建议回复」，放在输入框底栏。功能没启用时不显示；输入框非空或助手忙时不可用。点击重新生成所有模型 chip：已展示过的作为「不要重复」，服务端做近似重复过滤并在不够时补抽一次；新一批到达前保留旧的，不闪烁。习惯 chip 不变。失败静默。

**选中引用**：transcript 内有非空选区（≥4 个字符，稳定约 200 毫秒后）时，选区文本被记下（上限 600 字符，超出取首尾）。chip 文本为 `> 原文` 加换行；输入框为空则直接填入，非空则在末尾空一行后追加；填入后光标在末尾、textarea 聚焦。点击用的是**记下的文本**，不依赖点击后选区是否还在（iOS 点别处会取消选区）。有选区时，「建议」按钮把它作为 `focus` 发给服务端。

**手机上与系统功能的冲突**：不在选区旁画任何 UI，系统的菜单（iOS 的拷贝与查询、Android 的悬浮工具栏）完全不受影响，自定义的只是输入框里的一条 chip。仍可能存在的问题（选区靠近屏幕底部时 Android 系统工具栏翻到选区下方、可能遮住输入框）需要真机确认。

**扩展实验（缺省关）**：设置 `expansion: "vary"` 时，点选一条模型 chip 后，在正文后面再给出同话题的另一种想法（3 条完整替代回复，点击替换正文），可连续进行，深度上限 5。离线数据没有证明它比多重抽更好，所以是实验开关。

---

## 配置

独立配置文件，不使用环境变量承载旋钮：

- 入库模板：`config/reply-suggestions.settings.example.json`（缺省值，不含任何密钥）。
- 本机副本：缺省 `~/.config/claudecodeui/reply-suggestions.settings.json`；开发时 `config/reply-suggestions.settings.json`（`.gitignore`）。
- 唯一的环境入口：`REPLY_SUGGESTIONS_SETTINGS_PATH`，命名文件位置。
- 文件修改时间变化就重读（改模型或网关不用重启服务）；已知键的值不合法就回退缺省并报告原因，未知键忽略，永不阻止服务启动。

| 键 | 缺省 | 说明 |
|---|---|---|
| `enabled` | false | 会把对话尾部发给外部服务，故缺省关 |
| `protocol` | `anthropic` | `anthropic` 或 `openai` |
| `baseUrl`、`model` | 空 | 网关地址与模型名 |
| `authScheme` | 空 | 空表示按协议缺省（anthropic 用 `x-api-key`，openai 用 `bearer`）；网关两种都接受 |
| `apiKeyFile`、`apiKeyVar` | 空 | 密钥文件路径；文件是 `NAME=value`（可带 `export` 与引号）时用 `apiKeyVar` 取变量，否则取第一个非空行 |
| `disableThinking` | true | 两种协议都发送 `thinking: {"type":"disabled"}` |
| `temperature`、`redrawTemperature` | 0.3、1.0 | 首抽、重抽 |
| `maxOutputTokens`、`timeoutMs` | 400、5000 | |
| `maxChips`、`maxChipChars` | 3、120 | 返回的 chip 强制截断 |
| `maxTailChars`、`maxFocusChars` | 1500、600 | 发给模型的助手消息尾部与选中文本上限 |
| `maxCallsPerMinute`、`maxCallsPerDay` | 30、3000 | 保护上限 |
| `expansion` | `off` | `off` 或 `vary`（实验） |
| `usageLog` | true | 只存本机的使用记录 |
| `systemPrompt` | 空 | 空表示使用内置提示词；调提示词不用重新构建 |

**开发时复制 quay workers 的设置**：workers 的网关封装在本机启动器 `~/.local/bin/claude-fjdac`（导出 `ANTHROPIC_BASE_URL`、`ANTHROPIC_DEFAULT_*_MODEL=v4.1flash`，并 `source` 一个密钥文件）。开发副本复制其中的 `baseUrl` 和 `model`，**密钥只引用**：`apiKeyFile` 指向启动器使用的同一个密钥文件（`~/.local/etc/fjdac-api-key`，权限 600），`apiKeyVar` 为 `FJDAC_API_KEY`。理由：把凭据复制成第二份会产生会漂移的副本，本仓库的 profiles.yml 已有同样的教训。全程不打印、不回显、不记录密钥；主机名在任何输出里脱敏。网关为 `http://` 的内部地址。

---

## 后端

新模块 `server/modules/reply-suggestions/`，必须是 AC-394 棘轮下的**叶子模块**：只依赖 `server/shared/**` 与自身，除组合根 `server/index.ts` 外不被任何模块导入；读取会话历史的函数由 `server/index.ts` 注入（参照 `createArchitectureModule` 的做法），不得导入 providers 模块。

接口（均挂在 `/api/reply-suggestions`，经 `authenticateToken`）：

- `GET /status` → `{ enabled, expansion, maxChips, maxChipChars }`，不含任何密钥或路径。
- `POST /` `{ sessionId, redraw?, focus? }` → `{ chips: string[], draw: number }`。服务端读最后一条助手消息的尾部（不接受客户端传来的助手文本）；按「会话 + 最后一条助手消息 id」记住已展示的 chip；`redraw` 用重抽温度并把已展示的作为「不要重复」；对返回结果做归一化后的精确去重与近似重复过滤（字符集重合度 ≥0.7），不够时补抽一次；没有助手消息时返回空数组。
- `POST /events` `{ sessionId, draw, event: "picked"|"cleared"|"redrawn"|"sent", index? }` → 204。追加到本机使用记录；展示记录由服务端在抽取时自己写（模型、协议、设置版本、chip）。最终发出的文本可从会话记录还原，不另存。

错误：会话不存在 404、请求不合法 400、功能关闭 503、超过上限 429、上游失败 502。日志只记结果（模型、协议、耗时、token 数、成败），不记对话文本，不记密钥。

协议细节：
- anthropic：`POST {root}/v1/messages`，头 `anthropic-version: 2023-06-01`，请求体 `{model, max_tokens, system, messages, temperature, thinking?}`，只取 `text` 块，忽略 `thinking` 块。
- openai：`POST {root}/v1/chat/completions`，请求体 `{model, max_tokens, messages(system+user), temperature, thinking?}`，取 `choices[0].message.content`，忽略 `reasoning_content`。
- `baseUrl` 已以 `/v1` 结尾时不重复追加。
- 解析要宽松：接受 `{"chips":[…]}`、裸数组、带围栏的 JSON；校验为字符串数组，截断、去空、去重。

内置提示词要点：3 条互不相同的完整回复，用用户的语言和简短风格，每条不超过 `maxChipChars`；第 1 条用「；」分隔、简要回答所有待答点，助手给了推荐就采纳；第 2、3 条是真正的备选（不同的决定，或更短的确认）；**不得编造消息里没有的事实、数字或测量值**（决定可以替人做，事实不可以）；没有待答点时建议最可能的下一条指令。

保护：每分钟与每天的调用上限（滑动窗口）；连续失败后熔断（常量，文档中注明）；超时放弃；并发的相同请求合并。

---

## 评估与改进

按钮是这个功能的改进重点，所以评估方法本身要可复跑：

- 离线基准（`experiments/reply-suggestions-bench/`）：以会话记录为真值（助手那条消息 → 你接下来的真实回复），对「模型 × 提示词 × 温度 × 思考开关」做矩阵比较，同时用至少两个判官，并报告「至少两个判官都判为可原样发送」的保守口径与上下限。
- 判官需要人工校准：从判官分歧的 chip 中抽 40 条做盲标注清单，计算各判官与人工的一致度。
- 本机使用记录是长期真值：展示了什么、点了哪条、之后清空、重抽还是发送。离线工具可以用这份记录重放。

---

## 风险与未决项

1. 判官未经人工校准，所有「可原样发送」的数字只能当区间。
2. 模型会编造事实（已在提示词中禁止，但要在评估里单独检查）。
3. 手机端系统选择菜单与输入框的重叠只能真机确认（标「待外部」）。
4. 网关价格无法在本环境核实；成本以 token 数报告，不报金额。
5. 近似重复的过滤用字符集重合度，会漏掉改写；语义去重是后续选项。

---

## 任务切分

| 任务 | 内容 |
|---|---|
| `gap-reply-suggestions-backend-llm-service` | 后端模块、配置文件与加载、两种协议客户端、接口、缓存、去重、限流、熔断、使用记录 |
| `gap-reply-suggestions-composer-chips-button-selection` | 前端：来源合并、按钮、长文本截断与预览、选中引用 chip、使用记录上报；依赖后端任务 |
| `gap-reply-suggestions-expansion-experiment` | 缺省关的扩展实验（选一条后再给同话题的另一种想法）；依赖前端任务 |
| `gap-reply-suggestions-offline-benchmark-tool` | 离线基准与重放工具、盲标注清单生成与评分；依赖后端任务 |
