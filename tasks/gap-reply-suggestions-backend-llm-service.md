---
id: gap-reply-suggestions-backend-llm-service
title: 回复建议后端模块：独立配置文件、Anthropic/OpenAI 两种协议直连 LLM 网关、建议接口、去重、限流、熔断与本机使用记录
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

设计与数据依据全文见 `docs/proposals/composer-reply-suggestions-llm.md`（人 yale 2026-10-24 已确认按其中推荐项推进，形态为 task）。本任务只做**后端**：一个新模块，直连 LLM 网关生成输入框的回复建议 chip。前端、扩展实验、离线基准另有任务。

**约束先行。**

- 新模块 `server/modules/reply-suggestions/` 必须是 AC-394 棘轮下的**叶子模块**：只依赖 `server/shared/**` 与自身，除组合根 `server/index.ts` 外不被任何模块导入。读取会话最后一条助手消息的函数由 `server/index.ts` 注入（参照 `server/modules/architecture/` 的 `createArchitectureModule` 与它在 `server/index.ts` 的挂载方式），**不得导入 providers 模块**。因此新目录不需要登记进 AC-394 的目录清单。
- 遵循 `.agents/skills/backend-module-standards`：模块有 `index.ts`、路由只解析与转发、业务在 service、测试放 `tests/`，不建模块级 `types.ts`、`utils.ts`。
- **配置走独立配置文件，不用环境变量承载旋钮。** 唯一的环境入口 `REPLY_SUGGESTIONS_SETTINGS_PATH`，命名文件位置；其余旋钮都在文件里。
- 生成走**直连 HTTP**，不得经过 Claude Code、Codex 或 Agent SDK（它们会写转写、出现在侧栏）。

**配置文件。** 入库模板 `config/reply-suggestions.settings.example.json`（缺省值，不含任何密钥，每个键配一个 `_<键>` 说明，仿 `config/voice-realtime.settings.example.json`）；本机副本缺省 `~/.config/claudecodeui/reply-suggestions.settings.json`，开发时用 `config/reply-suggestions.settings.json`，在 `.gitignore` 中忽略（仿语音设置文件的写法）。读取规则：文件修改时间变化就重读（不用重启服务）；文件不存在是正常状态（功能关闭、无问题）；显式命名的路径读不到是要报告的问题；已知键的值不合法就回退缺省并把原因放进 `problems`；未知键忽略；任何情况都不得阻止服务启动。键与缺省值：

| 键 | 缺省 |
|---|---|
| `version` | `"example-1"`（非空字符串，每次抽取的日志都带上，使编辑可见） |
| `enabled` | `false` |
| `protocol` | `"anthropic"`，另一个值 `"openai"` |
| `baseUrl`、`model` | `""` |
| `authScheme` | `""`，空表示按协议缺省（anthropic 为 `x-api-key`，openai 为 `bearer`），也可显式写这两个值 |
| `apiKeyFile`、`apiKeyVar` | `""`、`""` |
| `disableThinking` | `true` |
| `temperature`、`redrawTemperature` | `0.3`、`1.0` |
| `maxOutputTokens`、`timeoutMs` | `400`、`5000` |
| `maxChips`、`maxChipChars` | `3`、`120` |
| `maxTailChars`、`maxFocusChars` | `1500`、`600` |
| `maxCallsPerMinute`、`maxCallsPerDay` | `30`、`3000` |
| `expansion` | `"off"`，另一个值 `"vary"`（本任务只解析并在状态里透出，行为由后续任务实现） |
| `usageLog` | `true` |
| `systemPrompt` | `""`，空表示使用内置提示词 |

密钥：`apiKeyFile` 指向一个文件（支持 `~`）；文件内容是单个密钥行，或 `NAME=value`（可带 `export` 与单双引号）。有 `apiKeyVar` 时取该变量；没有时若文件恰有一个赋值就取它，否则取第一个非空行。密钥只在重读文件时读入内存，**不得出现在任何日志、错误信息、状态响应或 `problems` 文本里**。密钥文件权限比 600 宽时报告为问题（不致命）。`enabled` 为 true 但缺 `baseUrl`、`model` 或密钥时按关闭处理，并把缺哪一项写进 `problems`。

**协议。** 两种都要支持，`baseUrl` 已以 `/v1` 结尾时不重复追加，容忍末尾斜杠。

- anthropic：`POST {root}/v1/messages`，头 `anthropic-version: 2023-06-01` 加按 `authScheme` 的认证头；请求体 `{model, max_tokens, system, messages:[{role:"user",content}], temperature}`，`disableThinking` 为真时再加 `thinking: {"type":"disabled"}`；只取响应里 `type` 为 `text` 的块，忽略 `thinking` 块。
- openai：`POST {root}/v1/chat/completions`，按 `authScheme` 的认证头；请求体 `{model, max_tokens, messages:[system,user], temperature}`，`disableThinking` 为真时同样加 `thinking: {"type":"disabled"}`；取 `choices[0].message.content`，忽略 `reasoning_content`。
- 已实测：本机 workers 的网关对两种协议、两种认证头都接受，也接受上述 `thinking` 参数。

**接口**（均挂 `/api/reply-suggestions`，由 `server/index.ts` 加 `authenticateToken` 挂载）：

- `GET /status` → `{enabled, expansion, maxChips, maxChipChars}`，不含密钥与路径。
- `POST /` 体 `{sessionId, redraw?, focus?}` → `{chips: string[], draw: number}`。服务端用注入的函数读最后一条助手消息，取末尾 `maxTailChars`（不接受客户端传来的助手文本）；`focus` 截到 `maxFocusChars`，超长不报错；按「会话 + 最后一条助手消息 id」记住已展示的 chip 与抽取次数；`redraw` 使用 `redrawTemperature`，并把已展示的 chip（最多最近 12 条）作为「不要重复」写进提示词；对结果做归一化后的精确去重，以及与已展示 chip 的近似重复过滤（字符集重合度 ≥0.7），过滤后不足 2 条时补抽一次；只返回本次新增的 chip；没有助手消息时返回空数组且不调用上游。相同键的并发请求合并为一次上游调用。
- `POST /events` 体 `{sessionId, draw, event: "picked"|"cleared"|"redrawn"|"sent", index?}` → 204，追加到本机使用记录。
- 错误：请求不合法 400、会话不存在 404（由注入函数抛出的 `AppError` 透传）、功能关闭 503、超过上限 429、上游失败 502。

**解析要宽松。** 接受 `{"chips":[…]}`、裸数组、带 ``` 围栏的 JSON；要求元素为字符串；去空、截断到 `maxChipChars`、去重、最多 `maxChips` 条；解析不出任何 chip 视为上游失败（502 类错误）。

**内置提示词**要点（`systemPrompt` 非空时整体覆盖）：3 条互不相同的完整回复，用用户的语言和简短风格，每条不超过 `maxChipChars`；第 1 条用「；」分隔、简要回答所有待答点，助手给了推荐就采纳；第 2、3 条是真正的备选（不同的决定，或更短的确认），不是改写；**不得编造消息里没有的事实、数字或测量值**（可以替人做决定，不可以编造事实）；没有待答点时建议最可能的下一条指令。有 `focus` 时加上「用户选中了消息里的这一段，想回应它」。

**保护。** 每分钟与每天的调用上限（滑动窗口）；连续 5 次失败后熔断 30 秒（常量，在文档里注明）；超时（`timeoutMs`）放弃。日志每次一行，只记模型、协议、设置版本、耗时、token 数（上游给了才记）、结果，**不记对话文本、chip 文本和密钥**。

**使用记录**（`usageLog` 为真时，只存本机）：JSONL 追加，路径放在项目已有的本机数据目录下（沿用其他模块解析数据目录的方式），单文件超过 5 MB 就轮转一份并丢弃更旧的。服务端在每次抽取时写一条展示记录（时间、sessionId、抽取序号、模型、协议、设置版本、chip），`/events` 写点选、清空、重抽、发送记录。最终发出的文本可从会话记录还原，不另存。

**文档。** 新增 `docs/operations/reply-suggestions.md`，说明配置文件、每个键、密钥怎么放、接口、日志、使用记录、保护机制与限制。

**本任务不包含**：前端；扩展（`vary`）的行为；离线基准；任何对 :3001 常驻服务的重启。

<!-- dedup-ref --> 相关但不同机制：`gap-composer-empty-box-history-frequency-chips`（习惯 chip，已完成，纯前端）。合并判断：`task-granularity-advice` 对本任务 Touches 的开放任务返回 peers 为空；开放任务 `gap-ac390-resident-reconcile-observability` 的 Touches 里也有 `server/shared/tests/quay-test-script.test.ts` 与 `scripts/suite-duration-baseline.tsv`，调度会串行，合并时这两处的计数要按合并后的整棵树重新测量，不要取任一侧的值。

## AC

- [ ] 设置加载逻辑逐腿通过：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-settings.test.ts` 退出码 0；下列每条各有一个独立 `test`：(a) 没有文件时功能关闭、`problems` 为空；(b) 经 `REPLY_SUGGESTIONS_SETTINGS_PATH` 显式命名一个读不到的文件时报告问题且功能关闭；(c) 未写任何键时各键等于上表缺省值；(d) 已知键的值不合法时回退缺省并在 `problems` 里点名该键，未知键被忽略；(e) `enabled` 为 true 但缺 `baseUrl`、`model` 或密钥各一条用例，按关闭处理并点名缺的是哪一项；(f) `apiKeyFile` 的格式：单个密钥行、`NAME=value`、`export NAME="value"`、单引号、`apiKeyVar` 在多个赋值里选一个、`~` 展开；(g) 修改文件后下一次读取看到新值（修改时间变化重读），修改时间未变时不重读；(h) 密钥不出现在 `problems` 文本与对外的状态对象里；(i) 密钥文件权限比 600 宽时报告问题但不致命。
- [ ] 两种协议的客户端逐腿通过（用本机回环上的假 HTTP 服务）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-client.test.ts` 退出码 0；每条独立 `test`：(a) anthropic 的路径、`anthropic-version` 头、缺省 `x-api-key`、请求体各字段，且 `thinking: {"type":"disabled"}` 当且仅当 `disableThinking` 为真时出现；(b) anthropic 用 `authScheme: "bearer"` 时发 `authorization: Bearer`；(c) openai 的路径、缺省 bearer、system 与 user 两条消息、`thinking` 同样当且仅当 `disableThinking` 为真；(d) `baseUrl` 以 `/v1` 结尾与带末尾斜杠都不产生重复路径；(e) anthropic 响应含 `thinking` 与 `text` 块时只取 `text`；(f) openai 响应含 `reasoning_content` 时只取 `content`；(g) HTTP 500、429、非 JSON 响应、响应体不是预期形状各自得到带类别的错误，错误信息里不含密钥；(h) 假服务延迟超过 `timeoutMs` 时在界限内以超时失败。
- [ ] 服务逻辑逐腿通过：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts` 退出码 0；每条独立 `test`：(a) 解析接受 `{"chips":[…]}`、裸数组、带围栏的 JSON，拒绝非字符串元素，截断到 `maxChipChars`，去空与去重，最多 `maxChips` 条，无法解析时报上游失败；(b) 提示词里的助手消息尾部被截到 `maxTailChars`，`focus` 被截到 `maxFocusChars`；(c) 首抽用 `temperature`，`redraw` 用 `redrawTemperature` 且把已展示的 chip 写进提示词；(d) 与已展示 chip 近似重复（字符集重合度 ≥0.7）的结果被过滤，过滤后不足 2 条时补抽恰好一次；(e) 只返回本次新增的 chip，抽取序号递增；(f) 没有助手消息时返回空数组且没有上游调用；(g) 相同键的并发请求只产生一次上游调用；(h) 每分钟与每天的上限各一条用例，超限得到限流类错误；(i) 连续 5 次失败后熔断，冷却期满后恢复（用可注入的时钟）；(j) 日志记录里不含对话文本、chip 文本和密钥；(k) 使用记录的展示、点选、清空、重抽、发送各写出一行 JSONL，超过大小上限时轮转。
- [ ] 路由与模块装配逐腿通过：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-routes.test.ts` 退出码 0；每条独立 `test`：`GET /status` 的形状且不含密钥与路径；`POST /` 缺 `sessionId` 或类型不对时 400，`focus` 超长被截断而不是拒绝；注入函数抛 404 时透传；功能关闭时 503；超限 429；上游失败 502；成功时 `{chips, draw}`；`POST /events` 的合法请求 204、不合法请求 400；并有一个经 `createReplySuggestionsModule`（在 `module.ts`）挂载到 Express 的装配用例，注入假的会话读取函数与假上游。
- [ ] 叶子规则成立：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts` 退出码 0（不改基线 JSON 与目录清单一字）；且 `grep -rnE "from '(@/modules|\.\./)" server/modules/reply-suggestions --include=*.ts --exclude-dir=tests` 无任何输出（退出码 1）。
- [ ] 计数钉子与耗时基线同步：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0，其中 `unknown=` 两处计数与说明注释按合并后整棵树重新测量，注释点名本任务的测试文件；`scripts/suite-duration-baseline.tsv` 为每个新增 server 测试文件各追加一行「毫秒、路径」（用单文件运行输出的 `duration_ms`），表头的覆盖说明同步更新。
- [ ] 模板与忽略规则：`node -e "const t=require('./config/reply-suggestions.settings.example.json'); const need=['version','enabled','protocol','baseUrl','model','authScheme','apiKeyFile','apiKeyVar','disableThinking','temperature','redrawTemperature','maxOutputTokens','timeoutMs','maxChips','maxChipChars','maxTailChars','maxFocusChars','maxCallsPerMinute','maxCallsPerDay','expansion','usageLog','systemPrompt']; for (const k of need) { if (!(k in t) || typeof t['_'+k] !== 'string') { console.error('missing', k); process.exit(1); } } if (t.enabled !== false || t.apiKeyFile !== '' || 'apiKey' in t) process.exit(1);"` 退出码 0；`git check-ignore -q config/reply-suggestions.settings.json` 退出码 0；`git ls-files | grep -E "reply-suggestions\.settings\.json$"` 无任何输出（入库的只有 `.example.json`）。
- [ ] 不增加环境变量旋钮：`grep -rnoE "process\.env\.[A-Z_]+" server/modules/reply-suggestions --include=*.ts --exclude-dir=tests | grep -v REPLY_SUGGESTIONS_SETTINGS_PATH` 无任何输出（退出码 1）。
- [ ] 文档覆盖每个键：`node -e "const t=require('./config/reply-suggestions.settings.example.json'); const d=require('fs').readFileSync('docs/operations/reply-suggestions.md','utf8'); for (const k of Object.keys(t).filter(k=>!k.startsWith('_'))) if (!d.includes(k)) { console.error('undocumented', k); process.exit(1); }"` 退出码 0。
- [ ] 装配与静态门：`grep -n "reply-suggestions" server/index.ts` 有输出（导入与挂载）；`npm run typecheck` 与 `npm run lint` 退出码均为 0。

## DoD

真实网关上的读数，缺一不可；测试与假服务只是必要条件。全程**不打印、不回显、不记录密钥或其任何片段**，贴出的网关地址一律脱敏为 `http://<gateway>`。

- [ ] 建开发副本：`config/reply-suggestions.settings.json`（已被忽略、权限 600）。`baseUrl` 与 `model` 复制自 quay workers 所用启动器 `~/.local/bin/claude-fjdac`（读它导出的 `ANTHROPIC_BASE_URL` 与模型名，当前为 `v4.1flash`）；密钥**只引用**：`apiKeyFile` 指向启动器 `source` 的那个密钥文件，`apiKeyVar` 为 `FJDAC_API_KEY`，不要把密钥复制进任何文件。贴出该文件内容（`baseUrl` 脱敏）、`ls -l` 的权限与 `git check-ignore -v` 的结果。
- [ ] 起一个**隔离的后端实例**（自己的 `DATABASE_PATH`、`SERVER_PORT`，按 AGENTS.md 与 cockpit 隔离实例做法，不碰常驻的 :3001，不重启任何常驻服务），准备一个最后一条助手消息以提问结尾的会话（真实会话或播种的转写均可，注明是哪种）。在该实例上用真实网关各做一次：`protocol: "anthropic"` 与 `protocol: "openai"`——后者**通过在服务运行期间改写设置文件**切换，以证明按修改时间重读。每种贴出：HTTP 状态、返回的 chip 数（应为 2–3 条）、耗时、日志里那一行（含协议、模型、设置版本、耗时、token 数）、chip 文本样例。
- [ ] 思考开关的读数：同一会话、同一协议下，`disableThinking` 为 true 与 false 各连续调用 5 次，贴出两组耗时的中位数与输出 token 数；参考此前直接调网关的实测（关思考中位数约 1.1 秒、输出约 70 token，开思考约 2.0 秒、约 200 token），若差异很大要说明。
- [ ] 重抽与聚焦：对同一会话再调 `redraw: true`，贴出新一批与首抽的对比，二者不得有精确重复，抽取序号为 2；再带一个 `focus`（取该助手消息里的一句话）调用，贴出 chip 是否围绕它。
- [ ] 失败形态在真实网关上的读数：错误的模型名、指向不存在文件的 `apiKeyFile`、极小的 `timeoutMs` 各一次，贴出状态码（应分别为 502、功能关闭下的 503、502）、日志行，并证明日志与响应里没有密钥。
- [ ] 密钥卫生核查：写一个小脚本，从密钥文件读出密钥，在服务日志、全部响应体、使用记录文件、`git diff` 与本任务新增的全部文件里查找它，**只打印出现次数**，应全为 0。
- [ ] 使用记录：完成一次抽取并向 `/events` 发 `picked` 与 `cleared` 后，贴出记录文件的行数与字段名（不贴 chip 全文以外的内容），并演示超过大小上限时的轮转（可临时调小上限）。
- [ ] 证伪记录：对下列三处各临时破坏一次，贴出对应 `test` 变红的输出，再恢复并证明恢复（`git diff` 为空）：把 `thinking` 参数的转发去掉（客户端 (a) 与 (c)）；去掉近似重复过滤（服务 (d)）；把密钥写进一条错误信息（客户端 (g) 或服务 (j)）。
- [ ] 本任务没有改动常驻服务：贴出整个验证过程只用了隔离端口，且 :3001 的进程启动时间未变。

## Touches

- `server/modules/reply-suggestions/index.ts` (new)
- `server/modules/reply-suggestions/reply-suggestions.module.ts` (new)
- `server/modules/reply-suggestions/reply-suggestions.routes.ts` (new)
- `server/modules/reply-suggestions/reply-suggestions.service.ts` (new)
- `server/modules/reply-suggestions/reply-suggestions-settings.ts` (new)
- `server/modules/reply-suggestions/reply-suggestions-client.ts` (new)
- `server/modules/reply-suggestions/reply-suggestions-usage-log.ts` (new)
- `server/modules/reply-suggestions/tests/reply-suggestions-settings.test.ts` (new)
- `server/modules/reply-suggestions/tests/reply-suggestions-client.test.ts` (new)
- `server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts` (new)
- `server/modules/reply-suggestions/tests/reply-suggestions-routes.test.ts` (new)
- `server/index.ts`
- `config/reply-suggestions.settings.example.json` (new)
- `docs/operations/reply-suggestions.md` (new)
- `.gitignore`
- `server/shared/tests/quay-test-script.test.ts`
- `scripts/suite-duration-baseline.tsv`
- `tasks/gap-reply-suggestions-backend-llm-service.md`
