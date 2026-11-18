---
id: gap-reply-suggestions-diagnostics-tab
title: 回复建议诊断页：Settings 新增诊断与日志，功能健康/最近失败/复制诊断包
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-reply-suggestions-failure-reading-and-inline-notice
---
## Proposal

### 背景

任务 1 让输入框里的失败可见：行内状态 + 点击后的详情浮层。但附件事故还暴露了第二个缺口——用户和运维没有地方回答“现在坏了吗 / 为什么坏 / 最后一次成功是什么时候”。这次排查用了 SSH、`journalctl`、`docker ps -a`、Traefik API 和 usage ledger，前台没有任何入口。

已确认的效果图方案：Settings 底部新增「诊断与日志」tab（不占侧栏一级导航），内容包括功能健康卡、最近失败表、复制诊断包。这是低频入口，必须能在不读原始日志的前提下定位这次事故。

### 现状（代码核实，2026-11-18）

- `server/modules/` 下没有 diagnostics/log 模块；`server/index.ts` 只挂载 notices、observation 等既有模块。
- Settings tab 在 `src/modules/settings/Settings.tsx:8-18` 与 `SettingsSidebar.tsx` 枚举；`about` 是最后一个（`Settings.tsx:274`），新 tab 应放在它旁边/底部。
- 任务 1 之后 reply-suggestions 的 `/status` 有 `state/problems/lastFailure`，失败环在 `reply-suggestions-failure-state.ts`，usage ledger 有 `failed` 行；这些是健康卡与最近失败表的数据源，不需要读原始日志。
- 新增 `server/modules/diagnostics/` 目录会触发四个目录 pin（两份 source pin + 两份 JSON）：`server/shared/tests/server-import-cycle-budget.test.ts` 的 `MANIFEST_PIN` 与 `server-import-cycle-budget.baseline.json` 的 `directoryManifest`/`nodeCount`，以及 `server/shared/tests/cloudpit-goal-exit-gate.test.ts` 的 `GATE_DIRECTORY_PIN` 与 `cloudpit-goal-exit-gate.baseline.json` 的 `moduleDirectories`。四份必须在同一提交里一起改；只登记一份会让全量 suite 单文件红。
- 新增测试文件会改变 `server/shared/tests/quay-test-script.test.ts` 的 unknown 计数 pin。
- 前端没有 diagnostics 模块；Settings 的 `SettingsCard` / `SettingsRow` 可以复用。

### 要交付

1. **后端叶子模块 `server/modules/diagnostics/`**
   - 新文件：`index.ts`（barrel）、`diagnostics.module.ts`（工厂，接收注入的 feature providers）、`diagnostics.routes.ts`（router）、`diagnostics.service.ts`（聚合/裁剪）、`diagnostics-bundle.ts`（脱敏文本）。
   - `GET /api/diagnostics/features` → `{ features: [{ id, label, state: 'off'|'misconfigured'|'ready'|'degraded'|'ok', enabled, problems, lastSuccessAt, lastFailure }] }`。至少包含 reply-suggestions；observation digest / voice / sessions 可以先返回固定 `unknown` 或由注入 provider 提供，不要伪造读数。
   - `GET /api/diagnostics/recent-failures?limit=50` → `{ failures: [...] }`，最新在前，`limit` 夹在 1..200；字段与任务 1 的失败环一致。
   - `GET /api/diagnostics/bundle` → `text/plain; charset=utf-8`，内容：Cloudpit 版本、安装形态、平台、settings 来源/路径、state、problems、最后成功、最后失败、最近 N 条失败。**服务端脱敏**：不得出现 key、prompt、消息正文、上游响应正文。
   - 模块只 import `server/shared` 与自身；feature 读数通过 `server/index.ts` 注入，不 import reply-suggestions 兄弟模块，不新增环。
   - 路由在 `server/index.ts` 挂在 `authenticateToken` 之后，和 `/api/reply-suggestions` 同一鉴权面。
2. **reply-suggestions 暴露诊断读数**
   - 在 `reply-suggestions/index.ts` 导出 `createReplySuggestionsDiagnostics` 或等价读取函数，返回 `{ state, problems, lastSuccessAt, lastFailure, failures }`；不暴露 key。
   - 任务 1 的失败状态文件保存 `lastSuccessAt` 与失败环；若没有，补上（仍在 Touches 内）。
3. **前端叶子 `src/modules/diagnostics/`**
   - `useDiagnostics.ts` / `diagnosticsController.ts`：并行拉 features + recent failures；loading / error / refresh；错误不抛进 Settings。
   - `DiagnosticsHealthList.tsx`：每行功能名、状态 pill（off/misconfigured/ready/degraded/ok）、配置来源、最后成功、最近失败；`problems` 用可读列表。
   - `RecentFailuresTable.tsx`：时间、功能、错误码、上游状态、耗时、requestId；窄屏纵向卡片。
   - `copyDiagnosticsBundle()`：`navigator.clipboard.writeText`，成功/失败都有可见状态；按钮文案与时长。
   - `src/modules/settings/tabs/DiagnosticsSettingsTab.tsx` 组合以上；`Settings.tsx` / `SettingsSidebar.tsx` 增加 `diagnostics` tab，默认不选中，不新增一级导航。
   - 本任务不做原始日志抽屉（任务 3）。健康卡不要渲染没有实现的「查看日志」死按钮；可以提供「查看最近失败」滚动到表格。
4. **i18n**：12 个 locale 的 `settings.json` 增加 tab 名、标题、状态、表头、复制成功/失败、空态；新增 `src/modules/settings/tests/i18nDiagnosticsCompleteness.test.ts` 逐 locale 比对 key 与占位符。
5. **目录 pin**：按仓规同时更新四份 pin（source pin + JSON），`nodeCount` 与 `directoryManifest.length` 一致；在完成记录贴改前/改后数字。若还有第五处目录 pin（用 `grep -rn "GATE_DIRECTORY_PIN\|MANIFEST_PIN" server/shared/tests` 复核），同批登记。
6. **测试**：diagnostics service/routes/bundle（鉴权、limit 夹取、state 映射、脱敏、cap）、前端 controller/tab（loading/error/成功、复制成功与失败、无 key）、i18n；`quay-test-script.test.ts` unknown pin 更新；typecheck/lint/build。

### 落点与纪律

- 后端遵循 `$backend-module-standards`：新模块是叶子，无模块级可变状态，工厂 + 注入；不 import 兄弟模块。
- 前端遵循 `$frontend-module-standards`：`settings` 可以 import `diagnostics`，`diagnostics` 不 import `settings`；不新增环。
- 诊断包必须服务端脱敏；前端只负责展示与复制，不做“复制前再过滤”的假安全。
- 接口有界：`limit` 夹取、字符串截断、无任意文件路径参数。
- 新增目录先改 pin 再跑门；不要等 fan-in 才发现单文件红。
- 不改 litellm、不重启本机 Cloudpit；DoD 用隔离实例。

### 去重与粒度

- 本任务 `depends_on` 任务 1：失败读数、`state/problems/lastFailure`、`failed` 行由任务 1 提供；没有任务 1 就没有可展示的数据源。
- 同域已完成任务仅溯源：`gap-cockpit-provider-diagnostics-to-degraded-stage` 是 Cockpit 的 provider 诊断面，机制是“provider 失败坍缩成成功空页”，与本任务的 Settings 诊断页不同；本任务不碰 cockpit。
- 在飞 peer：`gap-server-watcher-db-open-failure-exits-1-kills-resident-turns` 与本任务共享 `server/index.ts`；机制不同（进程崩溃守卫 vs 诊断页），验收独立，保持两单，调度器按 Touches 串行。
- 粒度：后端模块 + 页面 + 四份 pin 是一个完整交付，约 700-1000 行。

## AC

- [x] AC1 `bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test server/modules/diagnostics/tests/diagnostics-service.test.ts` 退出 0 且 `fail 0`；覆盖 features 的 state 映射（off/misconfigured/ready/degraded）、recent failures 的排序与 limit 夹取、bundle 的字段完整性与脱敏。
- [x] AC2 `bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test server/modules/diagnostics/tests/diagnostics-routes.test.ts` 退出 0；未带 token 返回 401/403；`limit=9999` 被夹到 200；`limit=0` 被夹到 1；响应 content-type 为 `text/plain`（bundle）与 `application/json`（其余）；不存在任意路径/文件名参数。
- [x] AC3 脱敏判据：在 bundle 与 failures 响应里注入含 `sk-test-secret`、`LITELLM_API_KEY=...`、`Authorization: Bearer ...` 的 fixture，断言响应中 `sk-`/`LITELLM_API_KEY=`/`Bearer ` 零命中，且 `[redacted]` 出现；负控：把脱敏函数改为恒等 ⇒ AC1/AC3 红，贴失败行与恢复命令。
- [x] AC4 前端：`bash scripts/with-memory-cap.sh npx vitest run src/modules/diagnostics/tests/diagnosticsController.test.ts src/modules/settings/tests/diagnosticsSettingsTab.test.tsx --maxWorkers=1` 退出 0；覆盖 loading→ready、请求失败显示错误且不抛、health 卡三态、最近失败表行、复制成功/失败状态、`data-slot="diagnostics-health"` / `"diagnostics-recent-failures"` 存在。
- [x] AC5 i18n：`bash scripts/with-memory-cap.sh npx vitest run src/modules/settings/tests/i18nDiagnosticsCompleteness.test.ts --maxWorkers=1` 退出 0；12 个 locale key 集合一致。
- [x] AC6 目录 pin：同时改完四份后，逐字运行 `bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts` 与 `... --test server/shared/tests/cloudpit-goal-exit-gate.test.ts`，均退出 0；完成记录贴 `directoryManifest` 长度 / `nodeCount` 改前改后，以及 `GATE_DIRECTORY_PIN` 与 JSON `moduleDirectories` 均包含 `modules/diagnostics`。
- [x] AC7 `bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0；新增测试文件后按实测更新 unknown pin 并贴改前/改后数字；`npm run typecheck`、`npm run lint`、`npm run build:client` 均退出 0；`architecture-ratchet.test.ts` 退出 0。
- [x] AC8 负控（改完即还原）：(a) 把 `misconfigured` 映射成 `ready` ⇒ AC1/AC4 红；(b) 从 bundle 去掉 `problems` ⇒ AC1 红；(c) 删除一处 pin ⇒ AC6 红。

## DoD

在隔离实例上操作真实页面（不得重启本机正在运行的 Cloudpit）：

- 用临时 stub 网关返回 502，打开 Settings →「诊断与日志」：功能健康卡显示「回复建议 / 上游异常 / 已启用」，给出配置路径、最后成功、最近失败（HTTP 502）；最近失败表至少有一行与 stub 请求对应；截图 `tmp/diagnostics-health-degraded.png`。
- 把临时 settings 改成 `enabled:true` 但缺 `model`，刷新：健康卡显示「配置不完整 · 缺少 model」，而不是「已关闭」；截图 `tmp/diagnostics-health-misconfigured.png`。
- 点「复制诊断包」，从剪贴板读回文本：包含版本、state、problems、最近失败；`sk-` 计数为 0；贴出文本前 20 行。
- 用 MCP 浏览器逐条操作并截图；当前没有覆盖 Settings 诊断页的 `scripts/ui-scenario.mjs` 场景时，完成记录须逐字说明“无可用场景”；若新增场景，同时贴 JSON 报告与检查点截图。
- 诚实边界：本任务不做原始日志抽屉；健康卡不渲染未实现的「查看日志」死按钮。任务 3 会把该动作接到抽屉。

## 完成记录

### 实现

- 后端叶子 `server/modules/diagnostics/`：`diagnostics.service.ts`（聚合、state 推导、limit 夹取、服务端脱敏）、`diagnostics-bundle.ts`（纯文本包 + 末次脱敏）、`diagnostics.routes.ts`（三个只读 GET，`limit` 夹到 1..200，无路径/文件名参数）、`diagnostics.module.ts`（注入 providers + meta）、`index.ts` barrel。
- `reply-suggestions` 新增 `reply-suggestions-diagnostics.ts` 与 barrel 导出；失败跟踪器新增 `lastSuccessAt()`（成功时由注入时钟打点）；`reply-suggestions.module.ts` 接受共享 `settingsSource`/`failureState`；`server/index.ts` 在组合根构建同一对实例，适配为 diagnostics provider，并把 `/api/diagnostics` 挂在 `authenticateToken` 之后。
- 前端 `src/modules/diagnostics/`：React-free controller、thin hook、健康卡、失败表（桌面表格 + 窄屏卡片）、复制动作；`Settings.tsx`/`SettingsSidebar.tsx` 增加最后一个 tab；12 locale + 新 i18n 判据。
- 目录 pin 四份同批 + `architecture-ratchet.baseline.json`（`server/index.ts` 2905→2950，RECORDED CHANGE 已写入 note）。

### AC 证据

- AC1 `bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test server/modules/diagnostics/tests/diagnostics-service.test.ts`：tests 6 / pass 6 / fail 0（state 映射 off/misconfigured/ready/degraded；跨 feature 排序与 0→1、9999→200；bundle 字段完整；脱敏）；同批 `diagnostics-bundle.test.ts` tests 3 / pass 3 / fail 0。
- AC2 `... --test server/modules/diagnostics/tests/diagnostics-routes.test.ts`：tests 5 / pass 5 / fail 0（真实 `authenticateToken` 无 token → 401；9999→200、0→1、默认 50；bundle `text/plain`、其余 `application/json`；`?path=/etc/passwd&file=...` 不影响答案、`/file` 404）。
- AC3 脱敏 fixture（`sk-test-secret` / `LITELLM_API_KEY=abc123` / `Authorization: Bearer ...`）在 features、recent-failures、bundle 三处均零命中且出现 `[redacted]`。负控：把 `redactDiagnosticsText` 改为恒等 ⇒ AC1 `(d)` 红 `features must not carry an sk- token`；routes AC3 红同一断言；恢复后再跑 6/6 与 5/5 全绿。
- AC4 `... npx vitest run src/modules/diagnostics/tests/diagnosticsController.test.ts src/modules/settings/tests/diagnosticsSettingsTab.test.tsx --maxWorkers=1`：Test Files 2 / tests 10 / pass 10；覆盖 loading→ready、失败可见且不抛、五态 pill、失败表行、复制成功/失败、两个 `data-slot`。
- AC5 `... npx vitest run src/modules/settings/tests/i18nDiagnosticsCompleteness.test.ts --maxWorkers=1`：tests 4 / pass 4；12 个 locale（de/en/es/fr/id/it/ja/ko/ru/tr/zh-CN/zh-TW）key 集合与 en 一致，含正向控制。
- AC6 四份 pin 同批：`directoryManifest` 102→103、`nodeCount` 102→103；`GATE_DIRECTORY_PIN` 103→104、`moduleDirectories` 102→103；两份均含 `modules/diagnostics`。`server-import-cycle-budget.test.ts` tests 12 / pass 12；`cloudpit-goal-exit-gate.test.ts` tests 3 / pass 3。第五处目录 pin 复核：`grep -rn "GATE_DIRECTORY_PIN\|MANIFEST_PIN" server/shared/tests` 只命中这两份测试文件，无第五份。
- AC7 `server/shared/tests/quay-test-script.test.ts` tests 14 / pass 14。unknown pin 说明：该文件的 `unknown=501` 是 synthetic 507 文件 manifest 减 6 known 的固定读数，真实收集数不进入该断言；本任务新增 3 个 server 测试文件使真实收集 510→513，pin 无需改（实测复跑仍绿）。`npm run typecheck`、`npm run lint`（0 error，warning 均为既有）、`npm run build:client` 均 exit 0；`architecture-ratchet.test.ts` tests 6 / pass 6。
- AC8 负控（改完即还原）：(a) 服务端 `resolveDiagnosticsFeatureState` 把 misconfigured 映射为 ready ⇒ AC1 红 `actual: 'ready', expected: 'misconfigured'`；前端 `STATE_LABEL_KEYS.misconfigured` 指向 `diagnostics.state.ready` ⇒ AC4 红 `Unable to find an element with the text: diagnostics.state.misconfigured`；(b) 从 bundle 移除 `problems:` 行 ⇒ AC1 红 `the bundle must state "`model` is required when `enabled` is true"`；(c) 从 `MANIFEST_PIN` 删除 `modules/diagnostics` ⇒ AC6 红 `the manifest names directories outside the pin`。

### DoD 证据（隔离实例，未重启本机 Cloudpit）

- 隔离实例：`ISOLATED_INSTANCE_SOURCE_DB=<seeded copy> ISOLATED_INSTANCE_STATE_DIR=$PWD/tmp/dod/iso bash scripts/isolated-instance.sh start`，`resident_restore_started=0`，端口 24161；临时 settings 的 `baseUrl=http://127.0.0.1:18082` 指向 stub 网关（每次请求返回 502，日志 `tmp/dod/stub.log`）。种子会话 `dod-diagnostics-session` 的转写由 `tmp/dod/transcript.jsonl` 提供；`POST /api/reply-suggestions` → 502，stub 收到 `/v1/messages`。
- degraded（`tmp/diagnostics-health-degraded.png`）：健康卡「回复建议 / 已启用 / 上游异常」，配置来源为临时 settings 路径，最后成功「从未」，最近失败「http · HTTP 502 · 2026-11-18T12:11:27.867Z」；最近失败表两行，`requestId=f0c41c1b` / `d5c79959` 与 stub 日志一一对应。
- misconfigured（`tmp/diagnostics-health-misconfigured.png`）：把临时 settings 改成 `enabled:true` 且 `model:""`，点刷新；健康卡状态 pill「配置不完整」、问题列表「`model` is required when `enabled` is true」；不再显示「已关闭」chip（该 chip 仅在 off/ready/degraded/ok 渲染）。
- 复制诊断包：真实点击「复制诊断包」，`navigator.clipboard.readText()` 读回 1099 字符，存 `tmp/diagnostics-bundle.txt`；`grep -o 'sk-' | wc -l` = 0、`LITELLM_API_KEY=` = 0、`Bearer ` = 0。前 20 行：

```
Cloudpit diagnostics bundle
generatedAt: 2026-11-18T12:11:31.737Z
version: 3.0.1
installForm: git
platform: linux
settingsSource: file
settingsPath: /data/home/yale/work/claudecodeui-worktrees/gap-reply-suggestions-diagnostics-tab/tmp/dod/config/reply-suggestions.settings.json

features (1):
feature: reply-suggestions (Reply suggestions)
  state: misconfigured
  enabled: no
  config: file:/data/home/yale/work/claudecodeui-worktrees/gap-reply-suggestions-diagnostics-tab/tmp/dod/config/reply-suggestions.settings.json
  lastSuccessAt: never
  problems: `model` is required when `enabled` is true
  lastFailure: at=2026-11-18T12:11:27.867Z feature=reply-suggestions category=http httpStatus=502 durationMs=11 requestId=f0c41c1b model=stub-model protocol=anthropic

recent failures (2):
  - at=2026-11-18T12:11:27.867Z feature=reply-suggestions category=http httpStatus=502 durationMs=11 requestId=f0c41c1b model=stub-model protocol=anthropic
  - at=2026-11-18T12:06:22.744Z feature=reply-suggestions category=http httpStatus=502 durationMs=23 requestId=d5c79959 model=stub-model protocol=anthropic
```

- 浏览器工具：本会话未挂载 MCP 浏览器工具，页面操作由 Playwright（Chromium 153）直接驱动真实页面完成，脚本 `tmp/dod/dod-diagnostics.mjs`，真实点击了「诊断与日志」tab、「刷新」、「复制诊断包」并从剪贴板读回。`scripts/ui-scenario.mjs` 没有覆盖 Settings 诊断页的场景 —— 无可用场景。
- 诚实边界：本任务不做原始日志抽屉，健康卡没有「查看日志」按钮；「查看最近失败」只滚动到本页表格。

### ADR-007

该轴仍暗,理由:本任务是 Settings 诊断读取面与只读聚合，未改动训练/评测数据轴，L_D/L_G 不适用。

## Touches

- tasks/gap-reply-suggestions-diagnostics-tab.md
- server/modules/diagnostics/index.ts (new)
- server/modules/diagnostics/diagnostics.module.ts (new)
- server/modules/diagnostics/diagnostics.routes.ts (new)
- server/modules/diagnostics/diagnostics.service.ts (new)
- server/modules/diagnostics/diagnostics-bundle.ts (new)
- server/modules/diagnostics/tests/diagnostics-service.test.ts (new)
- server/modules/diagnostics/tests/diagnostics-routes.test.ts (new)
- server/modules/diagnostics/tests/diagnostics-bundle.test.ts (new)
- server/index.ts
- server/modules/reply-suggestions/index.ts
- server/modules/reply-suggestions/reply-suggestions.module.ts
- server/modules/reply-suggestions/reply-suggestions.service.ts
- server/modules/reply-suggestions/reply-suggestions-failure-state.ts
- server/modules/reply-suggestions/reply-suggestions-diagnostics.ts (new)
- server/shared/tests/server-import-cycle-budget.test.ts
- server/shared/tests/server-import-cycle-budget.baseline.json
- server/shared/tests/cloudpit-goal-exit-gate.test.ts
- server/shared/tests/cloudpit-goal-exit-gate.baseline.json
- server/shared/tests/architecture-ratchet.baseline.json
- server/shared/tests/quay-test-script.test.ts
- src/shared/types.ts
- src/shared/diagnosticsType.ts (new)
- src/shared/api/clientTail.ts
- src/shared/tests/replySuggestionsTypeSync.test.ts
- src/modules/diagnostics/index.ts (new)
- src/modules/diagnostics/diagnosticsController.ts (new)
- src/modules/diagnostics/useDiagnostics.ts (new)
- src/modules/diagnostics/DiagnosticsHealthList.tsx (new)
- src/modules/diagnostics/RecentFailuresTable.tsx (new)
- src/modules/diagnostics/tests/diagnosticsController.test.ts (new)
- src/modules/settings/Settings.tsx
- src/modules/settings/SettingsSidebar.tsx
- src/modules/settings/tabs/DiagnosticsSettingsTab.tsx (new)
- src/modules/settings/tests/diagnosticsSettingsTab.test.tsx (new)
- src/modules/settings/tests/i18nDiagnosticsCompleteness.test.ts (new)
- src/modules/i18n/locales/*/settings.json

## Blocker

**2026-11-18T12:34:13.649Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts: AssertionError [ERR_ASSERTION]: the long-corpus sample is missing at /data/home/yale/work/tc-verify/corpus/long/L4-nonstop.wav — the criterion cannot run without it [baseline A/B: HARD RED (changed-assertion) — the task's red set is NOT a subset of the develop baseline red set: added=- changed=src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts]
- run_id：wk-prod-anchor
- session_id：fcac3897-15da-4e1e-b07e-7ed00bb045fd
