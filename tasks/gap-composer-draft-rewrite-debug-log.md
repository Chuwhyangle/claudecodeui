---
id: gap-composer-draft-rewrite-debug-log
title: Composer 草稿润色调试日志：默认关闭、Settings → Diagnostics
  开关、~/.cloudpit/reply-suggestions-debug.jsonl 轮转落盘完整草稿与候选
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

来源：用户 2026-11-21 明确授权「拆 Quay task」，本轮只立案，不实现、不晋升、不启动 driver/worker、不勾 AC。composer 草稿润色（✦ 候选）已由前序任务落地；本任务新增一条**默认关闭、显式开启、可轮转**的本机调试日志，把每次润色尝试的完整草稿与候选原文落盘，用于排查「这一次为什么给出这个候选」。入口在 Settings → Diagnostics 的 reply-suggestions 区块。用户已确认全部推荐项，实施时不得再改。

<!-- dedup-ref --> 与前序任务 `gap-composer-draft-rewrite-shared-suggestion-runtime`（done）机制不同：那是候选的生成路径与 composer 的审阅/应用生命周期，本任务只加旁路调试日志与开关，不改候选内容、不新增模型/provider/settings 文件、不提供第二条生成路径。机制去重读数（`task_list` 按 title+body 子串）：`debug log`、`debugLog`、`debug-log`、`调试日志`、`reply-suggestions-debug`、`轮转` 均无同机制命中（`落盘`/`日志` 的命中是 observation、voice、cockpit 的无关诊断，Touches 无交集）；`task_get gap-composer-draft-rewrite-debug-log` 为 not found。请求方已在完整 Touches 上跑过 granularity instrument：evaluated=true、peers=[]、mentions=[]；none found。kept separate：它是独立于生成路径的本地取证面，独立验收。

已确认的裁定（逐条照做，不得增删旋钮）：

1. 单一设置键 `debugLog: false`（默认关闭）；**不**增加路径/大小/保留天数等旋钮。
2. 固定文件 `~/.cloudpit/reply-suggestions-debug.jsonl`；目录 0700、文件 0600；与 `reply-suggestions-usage.jsonl` 分开，后者继续不存文本。
3. 轮转常量：单文件 2 MB，保留当前文件 + `.1`、`.2`、`.3`（总上限约 8 MB），最旧丢弃；写入前检查大小并轮转；写入失败只记一条不含内容的警告，**绝不**让重写请求失败。
4. 每次尝试一行 JSONL：`at`、`type:"draftRewrite"`、`requestId`、`sessionId?`、`outcome`（`ok` / `error:<category>` / `rejected:truncated|empty-output|output-too-long`）、`durationMs`、`model`、`protocol`、`version`、`inputTokens?`、`outputTokens?`、`inputChars`、`outputChars`、`input`（完整草稿）、`output`（完整候选；拒绝/截断时记录上游原始输出，超过 6000 字符只记前 6000 并置 `outputTruncatedForLog:true`）。不记录 API key、凭据文件内容、`baseUrl`；系统提示只记版本不记原文。
5. 输入/输出沿用现有 6000/6000 字符上限；超限按现有规则拒绝，但调试日志仍记录被拒绝的原始输出。
6. `sessionId` 作为 `POST /api/reply-suggestions/draft-rewrite` 的**可选**字段（string，≤128，仅用于日志关联，**绝不**发给上游）；不传也合法。
7. 开关位置：Settings → Diagnostics 的 reply-suggestions 区块；页面内联警示「开启后会把草稿与候选原文写入本机日志」+ 固定路径说明；开启无需二次确认弹窗；**不提供清空日志按钮**（轮转自动丢弃）。
8. 写入端点 `PUT /api/reply-suggestions/debug-log` `{enabled:boolean}`（挂在既有 `authenticateToken` 下）；`GET /api/reply-suggestions/status` 增加 `debugLog` 布尔读数；TypeSync 双端钉住。
9. 设置写入由 `reply-suggestions-settings.ts` 自己负责（它已拥有路径解析）：读现有 JSON（保留未知键，只改 `debugLog`）→ 同目录临时文件 + rename 原子替换 → 0600；文件存在但 JSON 解析失败时**拒绝写入并返回安全错误，绝不覆盖**；写入后 mtime 变化，现有 reader 下次请求生效，无需重启。
10. 关闭时：不创建文件、不写任何内容；现有元数据日志行为不变。开启后每次尝试恰好一行，含成功、超时、上游错误、拒绝/截断。
11. 文档明确：本机调试文件、不上传、不参与遥测；默认关闭；轮转是唯一保留策略。

## Plan

1. 新建 `server/modules/reply-suggestions/reply-suggestions-debug-log.ts`：一个 `createReplySuggestionsDebugLog({ filePath?, maxBytes?, homeDir?, now?, logger? })` writer，提供 `recordAttempt(record)`（一次尝试一行）与 `path` 读数；默认路径 `path.join(defaultCloudpitDataRoot(homeDir), 'reply-suggestions-debug.jsonl')`（与 usage log 同一 `~/.cloudpit` 根），`maxBytes` 默认 `2 * 1024 * 1024`，轮转保留 `.1`/`.2`/`.3`（rename 链，最旧被覆盖）。写入前 `statSync` 判大小；`mkdirSync(dir, { mode: 0o700 })`、`appendFileSync(..., { mode: 0o600 })`；任何 fs 异常都被吞成一条不含草稿/候选的 `logger` 警告。行构造只接受类型化 record，`output` 超过 6000 字符时 `slice(0, 6000)` 并置 `outputTruncatedForLog:true`。
2. `reply-suggestions-settings.ts` 的 settings source 增加 `writeDebugLog(enabled: boolean): void`：用已解析的 `filePath` 读现有 JSON（不存在则 `{}`）→ 保留未知键、只写 `debugLog` → 同目录 `mkdtemp` 式临时文件写入后 `renameSync` 原子替换 → `chmodSync(0o600)`；解析失败时抛带安全 code/message 的 `AppError`，**不**触碰原文件；`DEFAULT_SETTINGS` 加 `debugLog: false`，`ReplySuggestionsSettings` 加 `debugLog: boolean`。
3. `reply-suggestions-draw.ts` / `reply-suggestions.service.ts` 的每次尝试（成功、超时、上游错误、拒绝/截断）在**结果已确定之后**回调注入的 `recordAttempt`，`outcome` 按既有 failure category / rejection 映射；`input` 是本次请求草稿，`output` 是上游原始输出（拒绝/截断时尤其如此）。service 在**写时**读取当前 `debugLog` 决定是否落盘（同一实例内先关后开即刻生效）；写入异常被 writer 吞掉，HTTP 响应与候选不变。`status()` 的返回体加 `debugLog`。
4. `reply-suggestions.routes.ts` 的 `readDraftRewriteInput` 增加可选 `sessionId`（string、≤128，仅透传给 service 的 record，**绝不**进入上游请求体）；新增 `PUT /debug-log`（`readObjectBody` + 严格布尔校验，非布尔 400）调用 `settings.writeDebugLog`，响应 `{ debugLog: boolean }`；路由仍由 `server/index.ts` 的 `authenticateToken` 保护。
5. `reply-suggestions.module.ts` 组装 writer 并注入 service；`index.ts`（barrel）导出新 writer 的类型与工厂，供测试与组合根使用（沿既有 barrel 惯例，不新增跨模块导入）。
6. `src/shared/replySuggestionsType.ts`：`DraftRewriteRequest` 加 `sessionId?: string`；`ReplySuggestionsStatus` 加 `debugLog: boolean`。`src/shared/api/requests.ts` 的 `readReplySuggestionsStatus` 读取并校验 `debugLog`（缺省 false）。`src/shared/api/clientTail.ts` 的 `replySuggestions` 增加 `setDebugLog(enabled: boolean)`（`put('/api/reply-suggestions/debug-log', { enabled })`，返回布尔或抛错）。
7. Settings → Diagnostics：`DiagnosticsSettingsTab.tsx` 在 reply-suggestions 健康卡之后加一个区块（复用 Settings 页既有 toggle 模式：保存中禁用、失败回滚 + 可见错误、可访问名称与说明），读 `/status.debugLog` 初始值，切换调 `setDebugLog`；内联警示文案含「开启后会把草稿与候选原文写入本机日志」与固定路径 `~/.cloudpit/reply-suggestions-debug.jsonl`；**不**渲染清空按钮；开启不做二次确认。
8. 12 个 locale 的 `settings.json` 补齐新文案键（`de,en,es,fr,id,it,ja,ko,ru,tr,zh-CN,zh-TW`），占位符与既有完整性判据一致。
9. `draftRewriteController.ts` / `useComposerDraftRewrite.ts` / `useChatComposerState.ts`：把当前 `sessionId`（已有上下文时）作为可选字段传给 `draftRewrite`，无会话时省略；请求体仍只含 `{text, retry?, sessionId?}`。
10. 场景与真实浏览器：`scripts/scenarios/composer-draft-rewrite.json` 增加「开关前 0 行 → 开启后一次重写 +1 行 → 关闭后再重写仍 +0 行」的检查点与读数（`src/modules/ui-scenario/chatSurface.ts` 暴露调试行数读数，`scenarioSurface.ts` 汇总）；`e2e/composer-draft-rewrite.spec.ts` 增加同一条 leg（本地注入 mock gateway）。
11. 文档：`docs/proposals/composer-draft-rewrite-plan.md` 与两张原型 SVG 增加 Diagnostics 开关状态与隐私说明（本机调试文件、不上传、不参与遥测、默认关闭、轮转是唯一保留策略）；三份均已 tracked。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-debug-log.test.ts` 退出 0，覆盖：默认关闭时不创建文件且 `existsSync` 为 false；开启后每次尝试恰好一行，`input` 与请求草稿、`output` 与响应候选逐字相等（`assert.equal`）；行字段集为 `at`、`type:"draftRewrite"`、`requestId`、`sessionId`（未传时缺省，`'sessionId' in record === false`）、`outcome`、`durationMs`、`model`、`protocol`、`version`、`inputChars`、`outputChars`、`input`、`output`（`inputTokens`/`outputTokens` 仅在现有 completion 暴露时出现）；`statSync(dir).mode & 0o777 === 0o700`、`statSync(file).mode & 0o777 === 0o600`；预置接近 2 MB 后写一行，`ls` 读到 `…debug.jsonl`、`.1`、`.2`、`.3` 且最旧被丢弃、单文件不超过「上限 + 一行」；写失败（注入只读目录或桩 fs 抛错）只产生一条不含草稿/候选内容的警告且 `recordAttempt` 不抛出；行内不含 API key、凭据文件内容、`baseUrl` 与系统提示原文；拒绝/截断时 `output` 是上游原始输出，超过 6000 字符只记前 6000 且 `outputTruncatedForLog === true`。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-draft-rewrite.test.ts` 退出 0：成功、超时、上游错误、拒绝/截断四条路径各调用注入的 `recordAttempt` 恰一次，`outcome` 分别为 `ok`、`error:timeout`、`error:<category>`、`rejected:truncated|empty-output|output-too-long`；`debugLog` 关闭时零次；同一 service 实例内先关后开，第二次尝试落一行（写时读设置）；`recordAttempt` 抛错不改变 HTTP 响应与候选。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-draft-rewrite-routes.test.ts` 退出 0：`PUT /api/reply-suggestions/debug-log` 传 `{enabled:true}` / `{enabled:false}` ⇒ 200 且随后 `GET /status` 的 `debugLog` 跟随；非布尔或缺失 ⇒ 400；未带 token ⇒ 401；`POST /draft-rewrite` 的 `sessionId` 传合法字符串时透传到 `recordAttempt`、省略时字段缺省、超过 128 字符或非字符串 ⇒ 400；断言发往上游的请求体中不含 `sessionId`。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-settings.test.ts` 退出 0：`writeDebugLog(true)` 只改 `debugLog`、保留未知键；写后文件 0600；写入经同目录临时文件 + rename（任一时刻读取均为可解析的完整文档，不存在半份 JSON）；文件存在但 JSON 解析失败时拒绝写入、抛出安全错误、文件字节不变；写后 mtime 变化且既有 reader 下一请求读到 `true`（无需重建 source）；文件不存在时创建一个合法文档（`debugLog:true`）；`EXPECTED_DEFAULTS` 表含 `debugLog: false`。
- [ ] `npx vitest run src/shared/tests/composerDraftRewriteTypeSync.test.ts src/shared/tests/replySuggestionsTypeSync.test.ts` 退出 0：`DraftRewriteRequest.sessionId?: string` 与 `ReplySuggestionsStatus.debugLog: boolean` 双端逐字段对拍；把任一侧字段单边增删，TypeSync 负控必须红，恢复后通过。
- [ ] `npx vitest run src/modules/chat-composer/tests/composerDraftRewriteController.test.ts` 退出 0：有 `sessionId` 时它进入请求体，未提供时字段缺省；请求体只含 `{text, retry?, sessionId?}`，不含 transcript/model/prompt/url。
- [ ] `npx vitest run src/modules/settings/tests/diagnosticsSettingsTab.test.tsx src/modules/settings/tests/diagnosticsDebugLogSwitch.test.tsx` 退出 0：开关默认关闭；点击一次发出 `PUT {enabled:true}`；保存中禁用（`disabled`）；失败回滚到原值并显示错误；可访问名称与说明（`getByRole('switch', { name: … })` 且说明经 `aria-describedby` 关联）；内联警示含「开启后会把草稿与候选原文写入本机日志」与固定路径 `~/.cloudpit/reply-suggestions-debug.jsonl`；不存在清空日志按钮；开启不弹二次确认；同一文件内循环读取 12 个 locale 的 `settings.json`，新键齐且非空。
- [ ] `node scripts/ui-scenario.mjs scripts/scenarios/composer-draft-rewrite.json --base-url <isolated-url> --auth-token <token> --project <fixture> --session <fixture> --out tmp/composer-draft-rewrite-debug-log/scenario` 退出 0：新增步骤断言开关前调试文件行数不变、开启后一次重写恰好 +1、关闭后再重写行数不变；`npx playwright test e2e/composer-draft-rewrite.spec.ts` 退出 0。两者都用本地注入 mock gateway，不发真实付费请求。
- [ ] 假形态各自变红并改完即还原：关闭时仍写一行 ⇒ 第一条与第二条 AC 红；写失败抛到重写路径 ⇒ 第二条 AC 红；`sessionId` 发给上游 ⇒ 第三条 AC 红；settings 解析失败仍覆盖 ⇒ 第四条 AC 红；单边增删字段而不改另一端 ⇒ 第五条 AC 红。
- [ ] `npm run typecheck`、`npm run lint`、`npm run build` 退出 0（lint 仅既有 warning）；server 测试只用 `npx tsx --tsconfig server/tsconfig.json --test <单个文件>`，client 用 `npx vitest run <文件>`；不跑裸多文件 server test fan-out 或全量 suite（AGENTS.md 的内存规则）。

## DoD

真实运行页面（MCP 浏览器）在隔离实例上完成：Settings → Diagnostics 打开开关 → 用本地 mock gateway 触发一次草稿润色（不发真实付费请求，草稿用合成文本）→ 只读命令 `tail -n 1 ~/.cloudpit/reply-suggestions-debug.jsonl | jq -c '{type,outcome,requestId,model,protocol,version,input,output,inputChars,outputChars,outputTruncatedForLog}'` 核对行内 `input` 与页面草稿逐字相等、`output` 与页面候选逐字相等 → 关闭开关 → 再润色一次 → `wc -l` 与关闭前相同。`stat -c '%a' ~/.cloudpit ~/.cloudpit/reply-suggestions-debug.jsonl` 读到 `700` 与 `600`。轮转实机读数：把文件预置到接近 2 MB 再写一行，`ls` 读到 `…debug.jsonl`、`….1`、`….2`、`….3`。截图（开关开启态、一行 JSONL 的只读读数、关闭后无新行）与场景 JSON 报告写入 `tmp/composer-draft-rewrite-debug-log/`；证据中不得含 token、真实用户文本或凭据，草稿全部合成。真实模型质量不由 mock 证明——本任务只证明日志链路与契约。实例用毕 `scripts/isolated-instance.sh stop`。

## Touches

- tasks/gap-composer-draft-rewrite-debug-log.md
- server/modules/reply-suggestions/reply-suggestions-debug-log.ts (new)
- server/modules/reply-suggestions/reply-suggestions-settings.ts
- server/modules/reply-suggestions/reply-suggestions.service.ts
- server/modules/reply-suggestions/reply-suggestions-draw.ts
- server/modules/reply-suggestions/reply-suggestions.routes.ts
- server/modules/reply-suggestions/reply-suggestions.module.ts
- server/modules/reply-suggestions/index.ts
- server/modules/reply-suggestions/tests/reply-suggestions-debug-log.test.ts (new)
- server/modules/reply-suggestions/tests/reply-suggestions-settings.test.ts
- server/modules/reply-suggestions/tests/reply-suggestions-draft-rewrite.test.ts
- server/modules/reply-suggestions/tests/reply-suggestions-draft-rewrite-routes.test.ts
- config/reply-suggestions.settings.example.json
- src/shared/replySuggestionsType.ts
- src/shared/api/requests.ts
- src/shared/api/clientTail.ts
- src/shared/tests/composerDraftRewriteTypeSync.test.ts
- src/shared/tests/replySuggestionsTypeSync.test.ts
- src/modules/chat-composer/utils/draftRewriteController.ts
- src/modules/chat-composer/hooks/useComposerDraftRewrite.ts
- src/modules/chat-composer/hooks/useChatComposerState.ts
- src/modules/chat-composer/tests/composerDraftRewriteController.test.ts
- src/modules/settings/tabs/DiagnosticsSettingsTab.tsx
- src/modules/settings/tests/diagnosticsSettingsTab.test.tsx
- src/modules/settings/tests/diagnosticsDebugLogSwitch.test.tsx (new)
- src/modules/i18n/locales/de/settings.json
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/es/settings.json
- src/modules/i18n/locales/fr/settings.json
- src/modules/i18n/locales/id/settings.json
- src/modules/i18n/locales/it/settings.json
- src/modules/i18n/locales/ja/settings.json
- src/modules/i18n/locales/ko/settings.json
- src/modules/i18n/locales/ru/settings.json
- src/modules/i18n/locales/tr/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- src/modules/i18n/locales/zh-TW/settings.json
- scripts/scenarios/composer-draft-rewrite.json
- e2e/composer-draft-rewrite.spec.ts
- src/modules/ui-scenario/chatSurface.ts
- src/modules/ui-scenario/scenarioSurface.ts
- src/modules/ui-scenario/tests/scenarioSurface.test.ts
- docs/proposals/composer-draft-rewrite-plan.md
- docs/prototypes/composer-draft-rewrite-desktop.svg
- docs/prototypes/composer-draft-rewrite-mobile.svg
