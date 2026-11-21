# Composer 草稿润色：已裁定的可执行方案

状态：已按实现裁定收敛（共享 reply-suggestions 设置与预算；无独立开关、无标题/状态副文案、不截断候选）。本文描述**已实现**的行为，不再保留与裁定冲突的早期建议。
范围：编辑框中已有 user draft 的按需 LLM 润色，优先覆盖口语化、不完整的语音输入。
原型：`docs/prototypes/composer-draft-rewrite-desktop.svg`、`docs/prototypes/composer-draft-rewrite-mobile.svg`。

> 真实模型质量不由 mock 或回环 HTTP 证明。单元/页面/场景测试只证明实现链路与契约；如需评估改写质量，须另行授权并使用人工提供的非敏感样本。本任务的验收不包含任何真实付费请求。

## 1. 产品定义

用户主动请求模型把当前草稿整理得更清楚、更完整；用户预览**单一候选**后决定是否替换。改写永不自动发送，也不改变会话消息。用户始终拥有最终文本和发送动作。

- 入口文字：`✦ 润色`。
- 目标：整理措辞和明显的语音识别口误，不替用户补充想法、回答问题或创造事实。
- 失败、超预算或被截断时：原稿逐字节不变，候选不出现，可重试。

### 非目标

- 自动改写、自动发送、后台改写、对每次语音转写自动调用模型。
- 对助手回复生成建议（那是 reply-suggestions chip 的职责）、对话摘要。
- 发送对话历史、附件或语音音频；默认只发当前草稿文本。
- 多轮聊天式编辑、多个候选、独立模型/供应商/设置文件或独立开关。

## 2. 交互规格

### 入口

- 仅当草稿 `trim()` 后非空、改写服务已启用时，在**同一个 composer 外框内、textarea 下方且 footer 上方**显示 `✦ 润色` chip。
- 手动点击只提交当前草稿快照；不发送 transcript、音频、附件、聊天 provider/model，也不执行草稿里的指令。
- 点击后同位置展开候选框。展开期间 textarea 仍显示真实、未改动的当前草稿，可继续编辑、移动光标、使用快捷键与 Send。

### 候选框

- **只画候选正文与两个图标按钮**：✓ 应用到草稿、↻ 重试。必要的 loading/error 文案是唯一例外。
- **没有标题**（不出现「润色建议」），**没有状态副文案**（不出现「尚未替换」等）。
- 图标必须有 `title` 与 `aria-label`；按钮点击不冒泡、不触发收起。
- 点击框内非按钮区域收起回 chip。候选上存在非空文字选区时不收起；滚动不收起。loading 与失败态同样可收起。
- 收起后候选留在内存；再次展开显示同一候选，**不重复请求**。只有 ↻ 才发起下一次 completion，且同一时刻最多一个在途请求。

### 应用与并发

- ✓ 只把候选写回当前草稿并折叠，不发送；写入走 composer 唯一的 draft writer（state + send-time mirror），并同步重算/清理旧的语音插入区间、chip undo/归因与扩展状态。
- 未应用时 Send 照常发送当前 textarea 原文；应用后 immediate Enter/按钮发送新文本，行为与普通草稿完全一致。
- 请求返回前若草稿被编辑、清空、会话/草稿 scope 切换或组件 dispose：迟到答复一律丢弃，不入缓存、不覆盖新稿。
- clear、成功发送、scope 切换、dispose 清除候选缓存。
- 候选与原稿完全相同也允许应用，正文不因此损坏。
- 空白/过长输入前后端都有界校验（共享上限 6000 字符）；**不静默截断**。
- 超预算、空输出、非文本、输出超界、或 stop/finish reason 表示截断：拒绝候选，原稿不变，返回可识别的安全错误。

### 错误与日志

- 超时/限流/上游失败：保留草稿，候选框呈可恢复错误，↻ 可重试。
- 服务关闭/缺有效上游：fail closed，不产生任何外部调用。
- 不保存或记录用户原文、候选、prompt 或密钥；日志只含 protocol/model/version/duration/outcome/token 计数/requestId。

## 3. 文案与模型约束

内置独立 rewrite system 指令的核心约束：

1. 将口语、语音转写和不完整表达整理成清楚自然的用户消息；保留原语言、意图、确定性程度、礼貌程度与说话者立场。
2. 不回答草稿中的问题，不替用户选择，不增加原文未表达的请求/承诺/事实/数字/日期/实体。
3. 保留代码、命令、文件路径、URL、标识符、引用、格式化片段及专有名词；不把这些「纠正」成猜测。
4. 不确定时最小改动；必要时原样返回。
5. 仅返回改写后的正文，不加引号、标题、解释或 markdown 围栏。

整段文本输出契约：候选是完整正文，**不套用 `maxChipChars=120` 的 chip 截断**；输出上限由共享预算单独判定。

## 4. 服务端与共享设置（最终裁定）

### 共享 owner，而不是第二套配置

- 复用既有 `server/modules/reply-suggestions/` 的设置来源与有效配置：`enabled`、upstream 协议/地址/模型/凭据、`disableThinking`、`timeoutMs`、`temperature` / `redrawTemperature` / `maxOutputTokens`。
- 不新增 `draftRewrite` 设置文件、model/provider 配置或独立开关；不另造 baseUrl/凭据解析器。
- 首抽使用 `temperature`；重试使用 `redrawTemperature`；`maxOutputTokens` 原值透传，**保持默认 400，不擅自增大**。
- chips 与 rewrite 共享**同一个 upstream guard**：同一个熔断器、同一个每分钟/每天调用预算。任何一方消耗额度，另一方按同一限制被拒绝；不存在「各自一份完整配额」。
- 输入/输出上限是共享 wire 常量（6000 字符），两端逐字段对拍。

### API

- `POST /api/reply-suggestions/draft-rewrite`：请求 `{ text, retry? }`；成功 `{ rewrittenText }`。
- 请求体里除 `text`/`retry` 以外的字段（model、provider、prompt、system、history、url…）一律忽略，不能改变 completion 配置。
- 错误映射：禁用/缺有效上游 `503`、空或超长输入 `400`、无额度 `429`、上游/候选不合格 `502`（携带机器可读 `details.category`）。
- 不提供历史上下文参数、候选列表、客户端 prompt、模型 override 或 arbitrary URL 参数。
- 不持久化原文和候选；不写文本型 usage log。

### 网关 stop reason

- `llm-gateway` 读取并透出真实 stop/finish reason（Anthropic `stop_reason`、OpenAI `finish_reason`）。
- `max_tokens` / `length` 或输出 token 数耗尽 ⇒ 视为截断，拒绝候选；完整 finish 才可应用。
- 网关错误体不回传上游原始文本或密钥。

## 5. 前端状态与写回契约

状态由 React-free controller（`src/modules/chat-composer/utils/draftRewriteController.ts`）持有；hook 只是 `useSyncExternalStore` 绑定。命令：

`openOrRequest()`、`collapse()`、`retry()`、`apply()`、`invalidate()`、`reset()`、`dispose()`。

- 打开：有缓存候选则直接展开；否则发起唯一一次请求。
- 收起：保留候选与在途请求。
- 重试：在途时 no-op，保证只有一个请求。
- 编辑/清空/发送/scope 切换/dispose：清除候选并使迟到结果失效。
- **无独立页面级缓存**；缓存随 composer 生命周期存在，scope 切换即清除。
- 写回经 composer 唯一 writer；仅当当前草稿仍精确等于候选对应的快照时才允许应用。

## 6. 验收矩阵

| 场景 | 期望 |
|---|---|
| 非空语音转写草稿、空草稿、服务禁用 | 仅第一个且已启用状态显示入口；不调用 API |
| 正常生成 | 请求体严格等于草稿快照；原草稿不变化；候选框只显示候选正文与图标 |
| 点击应用图标 | 唯一 draft writer 更新文本、发送次数为 0；框收起 |
| 点击候选框非操作区域 | 框收起为 chip，草稿不变；再次点 chip 重新展开同候选且不再调用 API |
| 点击重试图标 | 仅发起一次新 completion；重复点击只产生一个在途请求 |
| 上游失败 | 草稿逐字节不变；错误可收起；仍可按既有 Send 发送原稿 |
| 展开候选时编辑文本 | 输入照常；候选立即销毁并折叠，不能覆盖新草稿 |
| 请求期间编辑/清空/切换会话 | 迟到结果不入候选、不覆盖当前 draft |
| 候选为空、非文本、超限或截断 | 不接受候选；草稿保持不变；返回安全错误 |
| timeout、429、502、未认证、服务关闭 | 状态可理解、可恢复；不泄漏密钥、文本或上游响应体 |
| 替换后语音区间/扩展/建议归因 | 旧范围不会错误标注新文本；状态按契约失效/重置 |
| 手机 320/375 与桌面 1280 | 入口与候选都在 composer 内；候选限高内部滚动；footer/send 仍可见可用 |

## 7. 原型图说明

- 桌面：transcript 在上、composer 在下；`✦ 润色` chip 在同一 composer 内、textarea 与 footer 之间。
- 手机：沿用底部 composer；入口不占 footer 行；候选上下排列在草稿与 footer 之间，footer 原位置不变。
- 展开框**只有候选正文与 ✓/↻ 两个图标**；无「润色建议」标题、无「尚未替换」状态。图标带 tooltip/aria-label（原型中以提示气泡示意）。
- 点击框内容区收起；点击图标只执行各自操作；无「保留原文」按钮，也无 120 字 chip 截断的暗示。
- 候选不受 120 字 chip 上限约束；超限/截断候选被拒绝且保留原稿。
- SVG 为静态交互原型，不是运行中的 UI；示例文案是虚构文本，未请求任何模型。
