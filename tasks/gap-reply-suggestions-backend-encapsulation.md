---
id: gap-reply-suggestions-backend-encapsulation
title: 回复建议后端内部封装：拆出上游守卫与抽取存储、设置按职责分组、密钥改不透明值、用量日志记录带类型、收窄导出
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-reply-suggestions-draw-cache-no-repeat-llm-calls
---
## Proposal

2026-10-24 对本功能后端做了面向对象设计评审（遵循 `.agents/skills/backend-module-standards`）。模块的对外边界是好的：`index.ts` 只导出装配函数与两个类型，路由只解析与转发，依赖都由外部注入，叶子模块规则成立。问题在**模块内部**：封装不够，职责混杂。本任务只做**行为不变的内部重构**，不改任何对外行为、接口形状、配置文件格式和日志字段（`served` 字段由缓存任务引入，本任务把它纳入带类型的记录）。

**现状（已读代码确认）。**

1. `server/modules/reply-suggestions/reply-suggestions.service.ts`（约 644 行）里的 `createReplySuggestionsService` 是一个约 250 行的大闭包，装着五件互不相干的事：熔断与限流（`consecutiveFailures`、`circuitOpenUntil`、`minuteCalls`、`dayCalls`）；每会话已展示记录与并发去重（`sessionStates`、`inflight`，以及缓存任务新增的缓存）；请求组装（`settings` 到客户端配置的字段映射是内联的）；提示词选择与构造；用量日志写入。`generate` 一个函数约 110 行，混着组装 key、调用上游、补抽、改状态、写日志。
2. `reply-suggestions-settings.ts` 的 `ReplySuggestionsSettings` 是约 27 个字段的平铺对象，混着四类东西：上游连接参数、生成参数、限额、诊断（`source`、`path`、`problems`、`configuredEnabled`）。消费者拿到全部字段，要手挑 7 个字段拼出客户端配置。
3. 密钥是该对象里的明文字符串字段 `apiKey`，随整个设置对象一路传进服务层。现在没有泄漏，只是因为每个出口都靠人手挑字段；任何一次 `JSON.stringify(settings)`、日志或 `util.inspect` 都会把它带出去。
4. 用量日志的构造细节（`usageLogPath`、`usageLogMaxBytes`、`usageLogHomeDir`）同时出现在模块依赖与服务依赖里，服务内部再拼装一遍。
5. 日志记录类型是 `Record<string, unknown> & { type: string }`，`shown` 行和各事件行的字段没有定义；离线基准脚本按字段名读取，格式没有任何类型约束。
6. 导出偏多：`characterSetOverlap`、`parseSuggestionChips` 以及四个常量被导出，实际只有测试在用，不符合「没有跨文件消费者就不导出」的规则。

**目标结构。**

- **上游守卫单元。** 新文件 `reply-suggestions-guard.ts`，导出 `createUpstreamGuard(options)`，对外是一个 `run(limits, call)`：内部自己持有熔断状态与每分钟／每天的滑动窗口，调用前检查熔断与限额，成功或失败后更新计数，超限抛现有的限流类错误、熔断期抛现有的熔断类错误。时钟可注入。服务层不再持有任何熔断或限额变量。
- **抽取存储单元。** 新文件 `reply-suggestions-draw-store.ts`，导出 `createDrawStore(options)`：统一管理每会话的 `{messageId, draw, shown}`、并发合并（`inflight`）和缓存任务引入的「当前批」缓存；同一个有上限的存储（缓存任务定的 200 个键、不设过期），**不再有单独无上限增长的 `sessionStates`**。对外的方法按语义命名（读取当前批、记录新一批、取已展示列表、并发合并），不暴露内部 Map 或可变数组；返回给调用者的数组是拷贝或只读视图。
- **提示词与解析各自成文件。** 新文件 `reply-suggestions-prompts.ts`（内置系统提示词、用户提示词、展开提示词的构造）与 `reply-suggestions-chips.ts`（`parseSuggestionChips`、`selectChips`、字符集重合度、归一化与截断）。它们是纯函数；原来为测试而从 service 导出的符号改从这里导出，并各配一个说明消费者的注释。
- **设置按职责分组。** `ReplySuggestionsSettings` 改为分组结构：`upstream`（协议、地址、模型、认证方式、凭证、关思考、超时）、`generation`（温度、重抽温度、最大输出 token、chip 数与长度、尾部与聚焦长度、系统提示词、展开模式）、`limits`（每分钟与每天上限）、`usageLog`、`diagnostics`（来源、路径、`problems`、`configuredEnabled`、`apiKeyFile`、`apiKeyVar`）。**配置文件格式（`config/reply-suggestions.settings.example.json` 与本机副本）不变**，分组只发生在内存里的读取结果上。客户端函数只接收 `upstream` 这一组，`status()` 从分组里取值，不再手挑平铺字段。
- **凭证成为不透明值。** 在设置文件里定义一个小类 `ApiCredential`：私有字段保存密钥，只有 `reveal()` 能取出；`toString()`、`toJSON()` 与 `util.inspect` 一律给出 `[redacted]`。`ReplySuggestionsSettings.upstream.credential` 是它的实例。`reveal()` 只在构造认证头的那一处调用。这样任何误打印、误序列化都不会带出密钥。
- **用量日志记录带类型。** `reply-suggestions-usage-log.ts` 定义按 `type` 区分的联合类型：`shown` 记录（含 `served`、`draw`、`model`、`protocol`、`version`、`chips`、可选的 `expansion`）与事件记录（`picked`、`cleared`、`redrawn`、`sent`，含 `draw`、可选的 `index`、`source`），并导出由它们构造记录的函数；`write` 只接受这个联合类型。字段名与现有 JSONL 完全一致，离线基准不用改。
- **构造细节留在装配处。** `reply-suggestions.module.ts` 负责用路径、大小上限、家目录造出用量日志对象并注入服务；服务依赖里不再有 `usageLogPath`、`usageLogMaxBytes`、`usageLogHomeDir`。
- **收窄导出。** 每个 `export` 都必须有跨文件消费者，并在定义处注释写明消费者；只为测试存在的导出要在注释里点名测试文件。`reply-suggestions.service.ts` 只导出 `createReplySuggestionsService` 与它必需的类型。
- **`generate` 拆小。** 把「组装 key」「组装上游请求」「首抽加一次补抽」「记账与写日志」拆成各自命名的函数；`reply-suggestions.service.ts` 文件行数不超过 260 行。

**必须保持的行为（不得回退）。** 所有已有的服务、路由、设置、客户端测试的断言不变（只允许改导入路径与设置字段的访问路径）；缓存、重抽、展开、限流、熔断、补抽、并发合并、近似去重的行为；错误状态码（400、404、429、502、503）；`/status` 的形状；JSONL 字段；叶子模块规则。

**范围外**：前端；提示词的措辞；展开实验的行为；任何新增功能。

## AC

- [ ] 守卫单元逐腿通过：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-guard.test.ts` 退出码 0；独立用例（时钟可注入）：(a) 连续 5 次失败后熔断，期内抛熔断类错误且不调用 `call`；(b) 冷却期满允许一次试探，成功则恢复，失败则重新熔断；(c) 每分钟上限与每天上限各一条用例，超限抛限流类错误，窗口滑过后恢复；(d) 缓存命中等不经过守卫的路径不占额度（由服务测试覆盖，这里断言守卫只在 `run` 内计数）；(e) 守卫实例之间互相独立。
- [ ] 抽取存储逐腿通过：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-draw-store.test.ts` 退出码 0；独立用例：(a) 同一会话同一助手消息的记账与「已展示」列表；(b) 助手消息 id 变化时重置；(c) 当前批缓存命中与替换；(d) 超过 200 个键淘汰最久未使用的，没有基于时间的过期；(e) 相同键的并发请求合并为一次；(f) 返回给调用者的数组被修改后不影响存储内部状态。
- [ ] 凭证不透明逐腿通过：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-settings.test.ts` 退出码 0（沿用既有文件新增独立用例）：(a) `JSON.stringify(settings)` 不含密钥；(b) `util.inspect(settings, {depth: null})` 不含密钥；(c) `String(credential)` 与模板字符串得到 `[redacted]`；(d) `reveal()` 返回原值；(e) 用 `console.log` 的格式化路径打印设置对象不含密钥；(f) 其余既有设置用例全部保持通过（字段访问路径改为分组后的路径，断言不放宽）。
- [ ] `reveal` 只在一处使用：`grep -rn "reveal()" server/modules/reply-suggestions --include=*.ts --exclude-dir=tests` 只出现在 `reply-suggestions-client.ts`（构造认证头）与凭证类自己的定义里；`grep -rnE "apiKey\b" server/modules/reply-suggestions --include=*.ts --exclude-dir=tests` 不再出现明文字符串形态的 `apiKey` 字段访问（只允许出现在读取密钥文件、构造凭证的位置，在 DoD 里列出）。
- [ ] 用量记录带类型：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-usage-log.test.ts` 退出码 0；独立用例：(a) `shown` 记录的字段名与取值形态与改动前一致（含 `served`）；(b) 四种事件记录的字段名一致；(c) 轮转行为不变；(d) 构造函数产出的记录写入后能被离线基准的回放读取（用基准脚本的 `selftest --only replay` 作为互证，退出码 0）。`grep -nE "Record<string, unknown>" server/modules/reply-suggestions/reply-suggestions-usage-log.ts` 无任何输出。
- [ ] 既有测试迁移后仍然通过：`npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts server/modules/reply-suggestions/tests/reply-suggestions-routes.test.ts server/modules/reply-suggestions/tests/reply-suggestions-client.test.ts` 退出码 0；迁移只改导入路径与设置字段的访问路径，不删用例、不放宽断言（`git diff --stat` 里这几个文件的删除行数与新增行数一并贴出，并说明每处删除的原因）。
- [ ] 服务层瘦身且无熔断与存储变量：`grep -cE "consecutiveFailures|circuitOpenUntil|minuteCalls|dayCalls|sessionStates" server/modules/reply-suggestions/reply-suggestions.service.ts` 为 0；`wc -l server/modules/reply-suggestions/reply-suggestions.service.ts` 不超过 260；`grep -nE "usageLogPath|usageLogMaxBytes|usageLogHomeDir" server/modules/reply-suggestions/reply-suggestions.service.ts` 无任何输出。
- [ ] 导出收窄：`grep -nE "^export (const|function|class|type)" server/modules/reply-suggestions/reply-suggestions.service.ts` 的输出只含 `createReplySuggestionsService` 与服务接口所需的类型；每个 `export` 的定义处有写明消费者的注释（`grep -B1 -E "^export " server/modules/reply-suggestions/*.ts` 人工核对并在 DoD 里贴出逐文件的导出清单与消费者）。
- [ ] 叶子规则与计数钉子：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts` 退出码 0（不改基线）；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0，其中 `unknown=` 计数与说明注释按新增的三个测试文件重新测量；`scripts/suite-duration-baseline.tsv` 为每个新增的 server 测试文件各追加一行「毫秒、路径」。
- [ ] 配置文件格式未变：`node -e "const t=require('./config/reply-suggestions.settings.example.json'); const need=['version','enabled','protocol','baseUrl','model','authScheme','apiKeyFile','apiKeyVar','disableThinking','temperature','redrawTemperature','maxOutputTokens','timeoutMs','maxChips','maxChipChars','maxTailChars','maxFocusChars','maxCallsPerMinute','maxCallsPerDay','expansion','usageLog','systemPrompt']; for (const k of need) if (!(k in t)) process.exit(1);"` 退出码 0，且 `git diff --stat config/reply-suggestions.settings.example.json` 为空。
- [ ] 行为反证：临时让守卫的 `run` 不再计数，守卫 (c) 变红；临时让凭证类的 `toJSON` 返回明文，凭证 (a) 变红；临时让存储返回内部数组本身，存储 (f) 变红；恢复后 `git diff` 对相应文件为空（过程贴在 DoD）。
- [ ] 静态门：`npm run typecheck`、`npm run lint`、`npm run build:server` 退出码均为 0。

## DoD

用**隔离实例**（自己的端口与 `DATABASE_PATH`，`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`，后端用真实网关的设置副本，不碰常驻 :3001，不重启常驻服务）；全程不打印、不回显、不记录密钥或其任何片段，贴出的网关地址一律脱敏。

- [ ] 重构前后对照：同一会话、同一设置，重构前（在改动之前的提交上）与重构后各做一次首抽与一次重抽，贴出状态码、chip 数、`draw`、用量日志行的字段集合，证明形状一致。
- [ ] 真实网关上的熔断与限额各验证一次：把设置里的每分钟上限临时调到 2，连发 3 次得到 429；把模型改成错的，连发 5 次后得到熔断类的 502，改回正确值并等冷却期满后恢复；贴状态码与日志行。
- [ ] 密钥卫生核查：写一个小脚本，从密钥文件读出密钥，在服务日志、全部响应体、使用记录文件、`git diff` 与本任务新增的全部文件里查找它，**只打印出现次数**，应全为 0；并在服务进程里对设置对象做 `JSON.stringify` 与 `util.inspect` 的一次性探针（临时调试入口，用完删除并证明 `git diff` 为空），贴出两个输出里 `[redacted]` 出现的位置，不贴密钥。
- [ ] 贴出重构前后 `reply-suggestions.service.ts` 的行数，以及新增四个源文件各自的行数与对外导出清单。
- [ ] 缓存行为回归：来回读取同一条助手消息，用量日志里是 `served: "cache"`，且上游调用数没有增加；点「建议」是 `served: "upstream"`。

## Touches

- `server/modules/reply-suggestions/reply-suggestions.service.ts`
- `server/modules/reply-suggestions/reply-suggestions-guard.ts`
- `server/modules/reply-suggestions/reply-suggestions-draw-store.ts`
- `server/modules/reply-suggestions/reply-suggestions-prompts.ts`
- `server/modules/reply-suggestions/reply-suggestions-chips.ts`
- `server/modules/reply-suggestions/reply-suggestions-settings.ts`
- `server/modules/reply-suggestions/reply-suggestions-client.ts`
- `server/modules/reply-suggestions/reply-suggestions-usage-log.ts`
- `server/modules/reply-suggestions/reply-suggestions.module.ts`
- `server/modules/reply-suggestions/reply-suggestions.routes.ts`
- `server/modules/reply-suggestions/index.ts`
- `server/modules/reply-suggestions/tests/reply-suggestions-guard.test.ts`
- `server/modules/reply-suggestions/tests/reply-suggestions-draw-store.test.ts`
- `server/modules/reply-suggestions/tests/reply-suggestions-usage-log.test.ts`
- `server/modules/reply-suggestions/tests/reply-suggestions-settings.test.ts`
- `server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts`
- `server/modules/reply-suggestions/tests/reply-suggestions-routes.test.ts`
- `server/modules/reply-suggestions/tests/reply-suggestions-client.test.ts`
- `server/shared/tests/quay-test-script.test.ts`
- `scripts/suite-duration-baseline.tsv`
- `docs/operations/reply-suggestions.md`
- `tasks/gap-reply-suggestions-backend-encapsulation.md`
