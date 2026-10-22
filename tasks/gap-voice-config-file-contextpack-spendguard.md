---
id: gap-voice-config-file-contextpack-spendguard
title: voice 配置化：contextPack（K/budgetChars）+ spendGuard 阈值进同一个配置文件，Phase 1→2
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 去重检查（2026-10-23）：没有打开的 `todo`/`ready` 任务覆盖“把 `contextPack`（K / budgetChars / rowCapChars）与 `spendGuard` 阈值放进同一个配置文件，并让浏览器拿到生效值”这一机制。相关但不同机制、均已 `done` 的任务：`gap-voice-realtime-context-pack-and-hot-settings`（上下文包与提示词/模板的每连接热读取，本任务在其上加数值旋钮）、`gap-voice-spend-guard-prod-default-window-cap`（2026-10-11 的“生产不设默认”决定，已被 2026-10-23 的 ¥0.05 默认取代，本任务只加文件来源、不改默认语义）、`gap-voice-announce-phrases-settings-key` 与 `voice-speaker-tracking-settings-file`（settings-file 键/块的先例）。合并候选检查：`task-granularity-advice` 的 `peers=[]`、`mentions=[]`。

现状与缺口：

- `config/voice-realtime.settings.json` 已由 `VOICE_REALTIME_SETTINGS_PATH` 指定，并由 proxy **每连接读一次**；现有 key 只有 `version`/`instructions`/`contextTemplate`/`turnDetection`/`omissionFill`/`announcePhrases`/`runEndAck`/`summaryModel`/`speakerTracking`。`contextPack` 与 `spendGuard` 都不在文件里。
- Spend guard 在 `server/index.ts` 的 `buildVoiceRealtimeSeams` 里解析，**早于**同函数的 `loadVoiceRealtimeSettings`；当前只认 `VOICE_REALTIME_MAX_CNY_PER_30S`、诊断路由 override 和代码默认 ¥0.05，文件设置不了。
- K / budgetChars 是浏览器 `src/modules/chat/utils/voice/voiceContextPack.ts` 的编译期常量（4 / 1200 / 600），没有运行时通道。实时 `ready` 帧在浏览器 `onopen` 首发 context **之后**才到（`useVoiceRealtimeSession.ts` 的首发包注释），所以 `ready` 不能作为首包的唯一来源。
- 前端 health 已经在麦克风启用前拉取（`useVoiceAvailable`），但 payload 不含这些运行时值；health 还可能是 per-user/503，不能把部署级配置绑在它身上。

已确认的决定（本任务按此实现，不再重开）：

1. `contextPack` 同时作用于 Live Voice 和 one-shot voice input。
2. 保留 `VOICE_REALTIME_MAX_CNY_PER_30S` 作为 ops escape hatch；配置文件是正常入口。Spend guard 优先级：诊断路由 override > env > file > 默认 ¥0.05。`contextPack` 同样 `env > file > default`（env escape hatch 可选，但优先级按此）。
3. 浏览器必须拿到配置；浏览器保留硬上限 **4,000 字符 / 12 行**，文件值只能在这个范围内生效；超出即拒绝并回落到上限/默认，不能静默放大。
4. 不支持显式关闭 spend guard（不接受 `null`/`0` 表示关闭）；需要放宽就设一个较大的正数。非法值报告后保持默认 ¥0.05，不能把守卫关掉。
5. 热更新按现有契约：文件改动只对**下一个连接**生效，不中途换掉正在说话的会话；配置端点按请求读文件，页面刷新/下一次 health 拉取生效。

配置 schema（继续放在 `config/voice-realtime.settings.json`）：

```json
{
  "contextPack": {
    "maxRows": 4,
    "budgetChars": 1200,
    "rowCapChars": 600
  },
  "spendGuard": {
    "maxCnyPerWindow": 0.05,
    "windowMs": 30000
  }
}
```

范围：`maxRows` 1–12；`budgetChars` 200–4000；`rowCapChars` 100–2000；`maxCnyPerWindow` 0.001–10；`windowMs` 5000–60000。未知 key 继续忽略；已知 key 类型/范围错误 → 该块不生效、默认值顶替、原因进 `problems`。配置端点返回**生效值**（已应用优先级和范围限制）。

## Plan

### Phase 1 — 配置文件承载 spendGuard（后端）

1. `shared/voice/voiceSettingsRegistry.ts`：在 `VOICE_REALTIME_SETTINGS_FILE_KEYS` 加 `contextPack`、`spendGuard`；在同一个共享契约文件里放 `VOICE_RUNTIME_DEFAULTS`（4/1200/600、0.05/30000）和 `VoiceContextPackRuntimeSettings` / `VoiceSpendGuardRuntimeSettings` 类型，避免新增 `shared/` 文件触发 AC-394 导入预算。
2. `server/modules/voice-realtime/voice-realtime-settings.ts`：新增两个块的校验器与 `VoiceRealtimeSettings.contextPack` / `.spendGuard` 字段。校验逻辑纯函数、范围如上；非法块回落到默认并写入 `problems`，不抛异常。
3. `server/modules/voice-realtime/voice-realtime-spend-guard.ts`：解析器增加 `file` 来源，优先级 `override > env > file > DEFAULT_SPEND_WINDOW_LIMIT_CNY`；非法值仍返回默认值 + `invalid`（不关守卫）。`windowMs` 从文件/默认读，传给 `spendGuard.windowMs`。
4. `server/index.ts`：把 `loadVoiceRealtimeSettings` 提到 spend guard 解析之前；用文件值作为第三来源。**同一连接的三个新旋钮只读一次**：把这次 reading 随 seams 传给 proxy（新增 seam 字段），或让 proxy 的那次读取成为唯一来源；不要让 guard 与截断各读一次而在文件编辑时得到不同值。
5. `config/voice-realtime.settings.json` 与 `config/voice-realtime.settings.example.json`：加入两个块和范围/优先级注释。
6. 测试加进既有 `server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts` 与 `voice-realtime-spend-guard.test.ts`；不新增 server 测试文件（`quay-test-script.test.ts` 的文件计数 pin）。

### Phase 2 — 配置文件承载 contextPack，并送到浏览器

1. `server/modules/voice/voice.routes.ts` / `voice.module.ts`：新增部署级 `GET /api/voice/runtime-config`（与 provider health 解耦，缺文件/坏文件返回默认值 + 可读 warning，不因 provider 未知返回 503）。返回 `{ contextPack: { maxRows, budgetChars, rowCapChars } }`。
2. `src/shared/api.ts`：加端点与一个同步缓存（`setVoiceRuntimeConfig` / `voiceRuntimeConfig`，形状仿 `setVoiceProviderProfile`）。`useVoiceAvailable` 在 health/config 流程里拉取并缓存；失败时保留 `null`，调用方用默认值。
3. `src/modules/chat/utils/voice/voiceContextPack.ts`：保留 shipped 默认 4/1200/600；新增浏览器硬上限 4,000/12；`buildVoiceContextPack` / `buildVoiceInputContextPack` 接受运行时 `maxRows` / `budgetChars` / `rowCapChars`，调用方传入缓存值，缺省回落默认。
4. `useVoiceRealtimeSession.ts` 的 `sendContextPack` 与 `useVoiceInput.ts` 的 one-shot 调用点传入缓存值；首包竞态用服务端截断兜底。
5. 服务端截断兜底：在 `server/shared/utils.ts` 加一个纯函数 `truncateRenderedVoiceContext(text, { maxRows, budgetChars, rowCapChars })`（按 `用户（…）：` / `助手（…）：` 行边界，保留最新 N 行；单行超预算按 head 70% + `…` + tail 30%），proxy 的 `context` 帧与 `/api/voice/transcribe` 的 `hints.context` 都调用它；日志写 `context truncated from=… rows/… chars to=… rows/… chars`。它只处理已渲染文本，不重写 ChatMessage 折叠规则；用同一输入的浏览器包做对照测试，防两套规则漂移。
6. 测试：`server/modules/voice/tests/voice-config.routes.test.ts`（端点/默认/坏文件）、`src/modules/chat/utils/tests/voiceContextPack.test.ts` + `src/modules/chat/voice-realtime/tests/contextPack.test.ts`（builder 运行时值/上限/回落）、既有 `voice-realtime-context-and-settings.test.ts`（截断/热更新/单次读取）。
7. 文档：`docs/operations/voice-realtime-test-stages.md` 写 schema、优先级、范围、热更新语义；`docs/proposals/voice-realtime-segmented-relay-SPEC.md` 的字符预算/成本表标注“配置可调，默认 1,200/4、spend 0.05”。

### 明确不做

- 不做 Settings UI；不新增配置文件的默认路径（仍由 `VOICE_REALTIME_SETTINGS_PATH` 指定）。
- 不支持 `maxCnyPerWindow: null/0` 关闭守卫；不改变默认 0.05 的策略。
- 不中途热替换正在说话的连接；不改 ASR provider seam、不重写 relay prompt、不改 context pack 的行过滤/字符折叠语义。
- 不新增 server 测试文件（文件计数 pin）；不新增 `shared/` 文件（AC-394 导入预算）。

## AC

- [x] AC1 配置 loader：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts` 退出 0；逐条打印 `defaults maxRows=4 budgetChars=1200 rowCapChars=600 spend=0.05`、`file maxRows=2 budgetChars=400 rowCapChars=300 spend=0.1`、`invalid maxRows=0 budgetChars=99999 spend=abc -> default + problem`，且未知 key 被忽略。
- [x] AC2 spend 优先级：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-spend-guard.test.ts` 退出 0；逐条打印 `file=0.1`、`env=0.02 压过 file=0.1`、`override=0.07 压过 env/file`、`invalid file -> 0.05 + invalid report`、`windowMs` 来自文件。
- [x] AC3 运行时端点：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-config.routes.test.ts` 退出 0；`GET /api/voice/runtime-config` 返回生效 `contextPack`（临时文件 `2/400/300`），缺文件/坏文件返回默认 `4/1200/600` + warning，且 provider 未知时仍返回 200（不绑 health）。
- [x] AC4 浏览器 builder：`npx vitest run src/modules/chat/utils/tests/voiceContextPack.test.ts src/modules/chat/voice-realtime/tests/contextPack.test.ts` 退出 0；运行时 `2/400` 产出 `rows<=2 && chars<=400`，缺省为 `4/1200`，配置 `99/99999` 被拒/夹到上限 12/4000 并打印读数。
- [x] AC5 服务端截断：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts` 退出 0；6 行/2,000 字符的已渲染 context + `2/400` 产出 `rows<=2 && chars<=400` 且保留最新行；one-shot 的 fetch recorder 看到截断后的 `context`；日志逐字含 `context truncated from=`。
- [x] AC6 热更新/下一连接：同一测试文件退出 0；连接 A 以 `4/1200` 启动，编辑临时文件为 `2/400`，连接 B 读到 `2/400`，A 的 reading 在连接生命周期内不变（无中途替换）。
- [x] AC7 配置文件与文档：`grep -q '"contextPack"' config/voice-realtime.settings.json && grep -q '"spendGuard"' config/voice-realtime.settings.json && grep -q '"contextPack"' config/voice-realtime.settings.example.json && grep -q 'contextPack' docs/operations/voice-realtime-test-stages.md` 退出 0；示例文件写明范围与 `env > file > default`。
- [x] AC8 不新增 server 测试文件：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0；`git status --porcelain 'server/**/tests/*.test.ts'` 无新增文件。
- [x] AC9 类型/构建/静态检查：`npx tsc --noEmit -p server/tsconfig.json && npx tsc --noEmit -p tsconfig.json && npm run build:client && npx oxlint <changed ts files>` 退出 0。

## DoD

真实落地判据（不是“测试存在”）：

1. 在**备用端口**（不是 :3001）启动真实服务，`HOME=<隔离目录>`、`VOICE_REALTIME_SETTINGS_PATH=<临时 settings>`、`VOICE_REALTIME_ENDPOINT` 指向 stand-in 上游；用真实 WS 客户端走浏览器协议连接 Live Voice。临时文件写 `contextPack.maxRows=2, budgetChars=400`、`spendGuard.maxCnyPerWindow=0.001`。读数必须是：`context` 帧/session.update/日志中的生效值为 2 行/400 字符；喂一条 response 后出现 `SPEND_LIMIT`，且账单读数与文件值一致。
2. 编辑同一临时文件为 `maxRows=4, budgetChars=1200, spendGuard.maxCnyPerWindow=0.05`，**新开**一个连接：新连接读到 4/1200/0.05；旧连接在编辑后仍保持 2/400/0.001（无中途替换）。删除 `spendGuard` 块再开一个连接：回落到 ¥0.05。
3. 浏览器侧：真实页面（或等价 e2e harness）调用 `GET /api/voice/runtime-config`，用返回值构建包；服务端收到的 `context` 帧在配置范围内，日志出现 `context truncated from=… to=…`。one-shot voice input 也使用同一配置，fetch recorder 看到截断后的 `context`。
4. 把上述真实读数（端口、临时文件、生效值、SPEND_LIMIT 帧、两连接的先后值）写进 `docs/operations/voice-realtime-test-stages.md` 的新小节；只写“测试通过”不算。

## Touches

- shared/voice/voiceSettingsRegistry.ts
- server/modules/voice-realtime/voice-realtime-settings.ts
- server/modules/voice-realtime/voice-realtime-spend-guard.ts
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/index.ts
- server/modules/voice/voice.routes.ts
- server/modules/voice/voice.module.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/voice-service-transcribe.ts
- server/shared/utils.ts
- src/shared/api.ts
- src/modules/chat/hooks/useVoiceAvailable.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/utils/voice/voiceContextPack.ts
- config/voice-realtime.settings.json
- config/voice-realtime.settings.example.json
- docs/operations/voice-realtime-test-stages.md
- docs/proposals/voice-realtime-segmented-relay-SPEC.md
- server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts
- server/modules/voice-realtime/tests/voice-realtime-spend-guard.test.ts
- server/modules/voice/tests/voice-config.routes.test.ts
- src/modules/chat/utils/tests/voiceContextPack.test.ts
- src/modules/chat/voice-realtime/tests/contextPack.test.ts
- server/modules/voice-realtime/voice-realtime-contract.ts
- server/modules/voice/index.ts
- server/modules/voice-realtime/tests/voice-realtime-context-injection.test.ts
- tasks/gap-voice-config-file-contextpack-spendguard.md

## Blocker

**2026-10-22T17:55:10.380Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/modules/voice/tests/voice-provider-dispatch-falsify.test.ts:   AssertionError [ERR_ASSERTION]: the unmutated temp tree must pass the criterion:
- run_id：wk-prod-anchor
- session_id：2790cd37-ab82-4237-ab2d-5349429cd546
