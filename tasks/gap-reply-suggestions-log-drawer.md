---
id: gap-reply-suggestions-log-drawer
title: 回复建议日志抽屉：进程内脱敏日志环 + 按 requestId 过滤的右侧抽屉
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-reply-suggestions-failure-reading-and-inline-notice
  - gap-reply-suggestions-diagnostics-tab
---
## Proposal

### 背景

任务 1 让 composer 里的失败可见并可点击查看详情；任务 2 提供 Settings 诊断页。附件事故的排查仍然需要 SSH + `journalctl` 才能看到真正的原因（Traefik 502、容器被停）。已确认的效果图方案是在错误现场提供“查看日志”入口，打开右侧日志抽屉：聊天仍可见、按 requestId 过滤、可按级别/来源筛选、跟随与“加载更早”、复制诊断包。

本任务只做**进程内、结构化、脱敏、字段有界**的日志窗口；不做 journald 代理，不做任意文件读取，也不做 CLI 的 `cloudpit logs`（CLI 是另一个进程，读不到进程内环；要做必须另立任务并决定 file/journald 源，不能半成品）。

### 现状（代码核实，2026-11-18）

- 没有日志 API；`server/index.ts` 只有各模块自己的 `console.log`，`reply-suggestions.module.ts` 接受注入的 `logger`（默认 `console.log`）。
- 任务 1 的失败环与 usage ledger 已经提供结构化失败；任务 2 的 diagnostics 模块与 `/api/diagnostics/*` 已经存在，应扩展而不是新建第二个模块。
- 前端没有全局抽屉；`src/App.tsx` 是 provider/路由的挂载点，`src/modules/standalone-shell/StandaloneShell.tsx` 也有自己的页面壳。
- 直接让 `chat-composer` import `diagnostics` 会把两个模块绑在一起；用共享 port（`src/shared/ports/*` 的既有模式）安装 `openLogDrawer`，notice 只读 port，避免新增模块环。
- 本机事故宿主根盘 98% 满；日志窗口只能驻留内存，不能新增持续写盘的日志文件。journald 仍是持久源，抽屉里要明说“仅本次进程生命周期”。

### 要交付

1. **进程内日志环 `server/shared/log-ring.ts`（new，叶子）**
   - `createLogRing({ maxLines = 1000, maxBytes = 512 * 1024, now?, redact? })`，返回 `{ append(entry), read(query), stats() }`。
   - `entry = { at: ISO string, level: 'info'|'warn'|'error', source: string, text: string }`；`source` 由调用方给，缺省从 `[feature]` 前缀派生，未知为 `other`。
   - 超过 `maxLines`/`maxBytes` 丢最旧；`read` 支持 `{ since?, level?, source?, limit? }`，`limit` 夹在 1..500，返回按时间正序的最后 N 条。
   - 脱敏发生在 **append 时**：`x-api-key`、`authorization: bearer …`、`sk-[A-Za-z0-9_-]{8,}`、`LITELLM_API_KEY=…`、`apiKey`/`client_secret` 赋值一律替换为 `[redacted]`；不得把整段 prompt/消息正文写入。环本身不 console、不递归。
2. **进程接线 `server/index.ts`**
   - 创建唯一 ring；安装 console tee（`console.log/warn/error` 包装一次，先 append 脱敏行，再调用原函数）；用一个布尔守卫防重入；测试不安装 tee。
   - 把 ring 注入 diagnostics 模块；安装点早于路由挂载，且晚于任何会打印启动日志的模块也无妨（环只保留最近窗口）。
3. **日志 API（扩展任务 2 的 diagnostics 模块）**
   - `GET /api/diagnostics/logs/sources` → 固定/派生来源列表 `{ sources: [{ id, label, count, lastAt }] }`；至少 `server`、`reply-suggestions`、`sessions`、`voice`、`other`。
   - `GET /api/diagnostics/logs?source=&level=&since=&limit=` → `{ lines: [{ at, level, source, text }], truncated, window: { maxLines, maxBytes } }`；`limit` 夹在 1..500；`since` 接受 ISO 或 epoch ms；不接受任意文件路径/文件名；鉴权与 `/api/diagnostics/*` 相同。
   - 响应里明确 `truncated`（环丢弃过旧行时为 true）与窗口大小，前端据此显示“仅最近 N 行”。
4. **前端全局抽屉 `src/modules/diagnostics/`（扩展任务 2 的模块）**
   - `LogDrawer.tsx`：桌面右侧抽屉（不是 modal，聊天保持可见）、手机全屏 sheet；头部标题 + 来源 tabs + 级别筛选 + requestId/关键字搜索 + 跟随开关 + “加载更早” + “复制诊断包” + 关闭；滚动到顶部时自动暂停跟随；空态“最近 15 分钟没有日志”；Esc 关闭。
   - `logDrawerController.ts` / `useLogDrawer.ts`：打开参数 `{ source?, level?, since?, requestId?, feature? }`；请求失败显示错误但不抛；刷新/轮询只在打开时进行，关闭即停。
   - `src/shared/ports/log-drawer.port.ts`（new）：`installLogDrawerPort(open)`、`openLogDrawer(filter): boolean`、`isLogDrawerAvailable(): boolean`；未安装时 `open` 返回 false，调用方隐藏入口而不是渲染死按钮。
   - `src/App.tsx`（以及 `StandaloneShell.tsx` 若它是独立壳）挂载 `LogDrawerHost` 并在挂载时安装 port；任务 1 的 `SuggestionFailureNotice` 与任务 2 的 `DiagnosticsHealthList` 用 port 的“可用性”决定是否显示「查看日志」，点击打开抽屉并按 `{ requestId, source: 'reply-suggestions', since: failure.at - 60s }` 预过滤。
   - 抽屉里明确写“日志仅保留在当前进程内（最近 N 行），重启后清空；持久日志见 journalctl”，不假装是完整日志。
5. **i18n**：12 个 locale 增加日志抽屉的标题、来源、级别、跟随、加载更早、空态、脱敏说明、关闭等 key；新增/扩展 `src/modules/diagnostics/tests/i18nLogDrawerCompleteness.test.ts`。
6. **测试与门**：ring（边界/脱敏/顺序/来源）、API（鉴权/夹取/无路径参数/sources）、port（未安装 no-op/安装/替换）、抽屉（打开/过滤/跟随暂停/Esc/空态/手机）、脱敏负控；`quay-test-script.test.ts` unknown pin 更新；typecheck/lint/build；`architecture-ratchet.test.ts` 绿；无新增后端目录（diagnostics 已由任务 2 建立），若实现新增了目录则同批补四份目录 pin。

### 落点与纪律

- 后端遵循 `$backend-module-standards`：`log-ring` 在 `server/shared`，diagnostics 模块仍是叶子；ring 通过注入，不做模块级单例。
- 前端遵循 `$frontend-module-standards`：`chat-composer` 不 import `diagnostics`；只用 shared port，避免新增模块环。`src/App.tsx` 只做挂载，不承载业务逻辑。
- 不把日志写盘（本机 98%），不读 journald，不接受路径参数；默认窗口小、可配置但上限固定。
- 脱敏在服务端 append 时完成；前端不再做“假脱敏”。测试必须包含 `sk-`/`LITELLM_API_KEY=`/`Bearer ` 三类 fixture。
- 不重启本机 Cloudpit；DoD 用隔离实例。
- CLI `cloudpit logs` 明确不在本任务范围；完成记录写“未做 CLI”及原因（进程内环跨进程不可读）。

### 去重与粒度

- `depends_on` 任务 1（失败读数与 `onViewLogs` 接点）与任务 2（diagnostics 模块、`/api/diagnostics/*`、Settings 诊断页）。
- 已完成任务 `gap-mcp-correlation-id-write-tools-and-filters` 是 MCP run 的关联标签，不是日志窗口；不复用其存储。
- 在飞 peer `gap-server-watcher-db-open-failure-exits-1-kills-resident-turns` 也改 `server/index.ts`；机制不同（崩溃守卫 vs 日志抽屉），验收独立，保持两单，调度器串行。
- 粒度：ring + API + 抽屉 + port 是一个完整交付，约 800-1000 行；不把前端抽屉与后端 ring 拆开，避免 AC 依赖交接。

## AC

- [ ] AC1 ring 判据：`bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/log-ring.test.ts` 退出 0 且 `fail 0`；覆盖 maxLines 与 maxBytes 两种丢弃、`read` 的 since/level/source/limit 夹取、正序返回、`truncated` 读数、append 时 `[redacted]`。
- [ ] AC2 API 判据：`bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test server/modules/diagnostics/tests/diagnostics-logs.test.ts` 退出 0；未带 token 拒绝；`limit=9999`→500、`limit=0`→1；`source` 不在白名单返回空集而不是读路径；`since` 非法值返回 400；`sources` 的 count/lastAt 与 ring 一致。
- [ ] AC3 脱敏判据：`... --test server/modules/diagnostics/tests/diagnostics-log-redaction.test.ts` 退出 0；注入含 `sk-test-secret`、`LITELLM_API_KEY=sk-...`、`Authorization: Bearer abc`、`x-api-key: xyz` 的行，API 响应零命中这些秘密、均出现 `[redacted]`；负控：把 redact 改为恒等 ⇒ AC1/AC3 红，贴失败行与恢复命令。
- [ ] AC4 port 判据：`bash scripts/with-memory-cap.sh npx vitest run src/shared/tests/logDrawerPort.test.ts --maxWorkers=1` 退出 0；未安装时 `openLogDrawer` 返回 false 且 `isLogDrawerAvailable()` 为 false；安装后可打开、替换安装生效、卸载恢复 false。
- [ ] AC5 抽屉判据：`bash scripts/with-memory-cap.sh npx vitest run src/modules/diagnostics/tests/LogDrawer.test.tsx src/modules/diagnostics/tests/logDrawerController.test.ts --maxWorkers=1` 退出 0；覆盖打开参数、来源/级别/requestId 过滤、跟随开关、滚动暂停、加载更早、Esc 关闭、空态、手机全屏布局、请求失败不抛。
- [ ] AC6 i18n：`bash scripts/with-memory-cap.sh npx vitest run src/modules/diagnostics/tests/i18nLogDrawerCompleteness.test.ts --maxWorkers=1` 退出 0；12 个 locale key 集合一致。
- [ ] AC7 仓库门：`npm run typecheck`、`npm run lint`、`npm run build:client` 均退出 0；`bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/architecture-ratchet.test.ts` 退出 0；`... --test server/shared/tests/quay-test-script.test.ts` 退出 0（新增判据文件后按实测更新 unknown pin 并贴改前/改后数字）。
- [ ] AC8 负控（改完即还原）：(a) 禁止来源过滤但 API 仍返回全部 ⇒ AC2 红；(b) 抽屉关闭后仍轮询 ⇒ AC5 红；(c) 未安装 port 时仍渲染「查看日志」⇒ AC4/AC5 红。

## DoD

在隔离实例上操作真实页面（不得重启本机正在运行的 Cloudpit）：

- 用任务 1 的 502 stub 触发失败；点击输入框错误行的「详情」，再点「查看日志」：右侧抽屉打开，预过滤到 `requestId`，能看到同一 requestId 的 ERROR 行（含 `httpStatus=502`）与相邻 INFO 行；截图 `tmp/log-drawer-requestid.png`。
- 在 stub/测试日志里注入一行含 `LITELLM_API_KEY=sk-test-secret` 的文本：抽屉与 API 都显示 `[redacted]`，页面文本里 `sk-test-secret` 零命中；贴出 API 响应片段与页面读数。
- 切换来源 tab、级别筛选、搜索 requestId、滚动触发暂停跟随、点“加载更早”、点“复制诊断包”并读回剪贴板；逐条记录。
- 手机 390×844：抽屉为全屏 sheet，Esc/关闭可退出；截图 `tmp/log-drawer-phone.png`。
- 当前没有覆盖日志抽屉的 `scripts/ui-scenario.mjs` 场景；完成记录须逐字说明“无可用场景”；若新增场景，贴 JSON 报告与检查点截图。
- 诚实边界：日志只在当前进程内保留（最近 N 行/字节），重启后清空；页面必须显示该说明。不实现 CLI `cloudpit logs`。

## Touches

- tasks/gap-reply-suggestions-log-drawer.md
- server/shared/log-ring.ts (new)
- server/shared/tests/log-ring.test.ts (new)
- server/index.ts
- server/modules/diagnostics/index.ts
- server/modules/diagnostics/diagnostics.module.ts
- server/modules/diagnostics/diagnostics.routes.ts
- server/modules/diagnostics/diagnostics.service.ts
- server/modules/diagnostics/tests/diagnostics-logs.test.ts (new)
- server/modules/diagnostics/tests/diagnostics-log-redaction.test.ts (new)
- server/shared/tests/quay-test-script.test.ts
- server/shared/tests/architecture-ratchet.test.ts
- server/shared/tests/architecture-ratchet.baseline.json
- src/shared/ports/log-drawer.port.ts (new)
- src/shared/tests/logDrawerPort.test.ts (new)
- src/shared/types.ts
- src/shared/api/clientTail.ts
- src/modules/diagnostics/index.ts
- src/modules/diagnostics/LogDrawer.tsx (new)
- src/modules/diagnostics/logDrawerController.ts (new)
- src/modules/diagnostics/useLogDrawer.ts (new)
- src/modules/diagnostics/LogDrawerHost.tsx (new)
- src/modules/diagnostics/tests/LogDrawer.test.tsx (new)
- src/modules/diagnostics/tests/logDrawerController.test.ts (new)
- src/modules/diagnostics/tests/i18nLogDrawerCompleteness.test.ts (new)
- src/modules/diagnostics/DiagnosticsHealthList.tsx
- src/modules/settings/tabs/DiagnosticsSettingsTab.tsx
- src/modules/chat-composer/composer/SuggestionFailureNotice.tsx
- src/App.tsx
- src/modules/standalone-shell/StandaloneShell.tsx
- src/modules/i18n/locales/*/common.json