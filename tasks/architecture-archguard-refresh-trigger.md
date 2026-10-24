---
id: architecture-archguard-refresh-trigger
title: 架构图手动刷新分析：确认弹窗后整项目重跑 archguard，多会话并发点击合并为一个作业，失败保留旧产物
status: todo
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->2026-10-24 已检索 `architecture-*` 的 todo / ready / done 任务与 "archguard analyze" 关键词，没有任务实现"从 UI 触发 archguard 重新分析"这一机制。`architecture-fullscreen-fit-margin`、`architecture-keyboard-nav-start-and-a11y`（均为 ready）与已完成的 `architecture-readout-minimap-hover-layout` 同样改 `ArchitecturePanel.tsx` 与 `playwright.config.ts`，但机制不同（Fit 边距 / 键盘无障碍 / 叠层布局）；kept separate：本任务只在页脚诚实条处新增刷新入口与对话框，改动区域不重叠，冲突由调度器按 Touches 串行化，不设 depends_on。

**问题（证据）**：Architecture 标签页脚显示 "Analysis: 2 days ago" 与 "6 names mentioned in this session were not found in the analysis cache"（`src/modules/architecture/ArchitecturePanel.tsx` 约 3388 行诚实条；`reconciledAnalysisRef` 约 1403 行对每个分析 key 只复核一次未解析名字）。服务端 `server/modules/architecture/routes.ts` 只有只读的 `POST /graph`、`/mentions`、`/search`；`cache.ts` 以 arch.json 内容哈希为 key（"the key is the invalidation"，无 TTL / 淘汰），所以分析产物刷新后下一次读取自动失效，无需显式清缓存。分析产物位于 `.archguard/query/manifest.json`（scopes：`93e0a992` "src (typescript)" 源 `<root>/src`；`bcc56acf` "server (typescript)" 源 `<root>/server`；`a24387f8` "chat" 源 `<root>/src/modules/chat`，陈旧遗留）加每个 scope 的 `arch-index.json` 与 `arch.json`（各约 3MB）；`.archguard` 已 git-ignore。用户目前没有任何办法在 UI 里更新它。

**CLI（已确认）**：PATH 上没有 archguard，仓库里没有 `archguard.config.json`；可用入口是 `node ~/.claude/plugins/npm-cache/node_modules/@yalehwang/archguard/dist/cli/index.js analyze -s <源目录> ...`（v0.1.42；插件缓存目录里另有较旧的 0.1.35–0.1.41）。launcher `mcp-launcher.mjs` 用 `createRequire` 解析 `@yalehwang/archguard/dist/cli/index.js`，找不到再向上走到同级 `npm-cache/node_modules`。已见选项：`--work-dir`（默认 ./.archguard）、`--cache-dir`、`-s/--sources`、`--lang`、`-e/--exclude`、`-c/--concurrency`、`--no-cache`、`--include-tests`、`--include-git`、`-v`。

**用户已定的决定**：只做手动触发（不做自动触发）；刷新整个项目（全部 scope），不只当前 scope；开始前必须有确认对话框；多会话 / 多标签页的并发点击必须合并成一个作业。

## Plan

1. **Spike（先做，结论写进 Evidence）**：在副本上跑（`--work-dir` 指向 `tmp/` 下目录，不碰活的 `.archguard`），确定：(a) 能复现现有 manifest 中 src + server 两个 scope 的确切 argv（scope key / label 必须稳定，`93e0a992` 与 `bcc56acf` 不变；遗留的 `chat` scope 是否保留要明确写出结论）；(b) 墙钟时间；(c) 峰值 RSS；(d) 产物是否原子写入——若不是，则服务端必须用临时 `--work-dir` 跑完、成功后再 rename / 交换到 `.archguard`，失败时旧产物原样保留。spike 的结论决定后面 argv 与内存上限的取值。
2. **后端**（遵循 `.agents/skills/backend-module-standards/SKILL.md`：路由只做解析 / 校验 / 调用服务 / 翻译响应，子进程与编排在服务里，跨模块只经 `index.ts`，测试放 `server/modules/architecture/tests/`，共享类型放 `server/shared/types.ts`）：新增刷新服务（模块级、以项目根为 key 的 single-flight）。`POST /api/architecture/refresh` 启动或加入作业；`GET /api/architecture/refresh/status` 返回状态；若现有模块已有 WS 推送模式则复用，否则前端轮询。项目由服务端按 projectId 解析，客户端不传路径。已有作业运行时第二个请求返回同一 jobId 与 `coalesced:true`，绝不再 spawn。状态 `idle|running|succeeded|failed`，带 startedAt、finishedAt、阶段 / 退出码、最近 N 行 stderr。子进程用 `spawn`（无 shell，argv 数组）、有超时、按 `docs/operations/process-isolation-and-memory-caps.md` 的 `with-memory-cap.sh` / systemd-run 模式加内存上限，服务器关闭时终止子进程；不得使用 `pkill -f`。失败不得破坏旧产物。
3. **CLI 解析可配置**：新增 `server.settings.json` 旋钮（用户偏好：新旋钮进 `server.settings.json`，模板入库、本机副本不入库，不走 env / systemd drop-in），默认解析方式镜像 launcher（`createRequire` 再向上找同级 `npm-cache/node_modules`）；无法解析时返回清晰错误（状态 failed，原因可读），不 spawn。
4. **前端**（遵循 `.agents/skills/frontend-module-standards/SKILL.md`）：新增刷新 hook 与确认对话框组件。页脚 "Analysis: N ago" 旁加刷新图标按钮；"N names … not found" 诚实条加 "Refresh analysis" 动作；点击打开确认对话框（说明：刷新整个项目、耗时数分钟、其他会话也会看到；Cancel / Refresh；焦点陷阱；Escape 只关闭对话框——聊天页的全局 Escape 会发 `chat.abort`，按既有覆盖层的 Escape 守卫（见记忆 "Escape 守卫"）写守卫并验证）。运行中显示已用时间并禁用按钮，画布仍可用；如果作业是别的会话发起的，标签页加载时通过 status GET 直接显示运行态且不提供第二次启动；成功后重新拉取图、重跑未解析名字复核（重置 `reconciledAnalysisRef` 的 key）并自动 Fit；失败显示原因与 Retry。i18n 键补齐应用使用的所有语言包。
5. **测试**：服务 / 路由 / hook / 组件 / e2e（e2e 通过可配置路径指向一个假 CLI，CI 不跑真实的数分钟分析）。

## AC

- [ ] Spike 结论已写入本任务 Evidence：确切 argv、scope key / label 对照现有 manifest、墙钟、峰值 RSS、是否原子写入及据此选定的写入策略；`grep -c "93e0a992" tasks/architecture-archguard-refresh-trigger.md` 与 `grep -c "bcc56acf" tasks/architecture-archguard-refresh-trigger.md` 均 ≥ 2（Proposal 一处加 Evidence 一处）
- [ ] 单文件运行 `server/modules/architecture/tests/refreshJob.test.ts`（按仓库服务端测试运行器直接跑这一个文件，不做多文件 fan-out）exit 0：两个并发 `start` 只 spawn 一次且返回同一 jobId、第二个带 `coalesced:true`；作业结束后再 start 会起新作业；失败（非零退出）时旧产物字节不变且状态为 failed 并带 stderr 尾部；超时会杀掉子进程并置 failed；服务器关闭钩子会杀掉运行中的子进程；CLI 无法解析时给出明确错误且不 spawn；spawn 调用是 argv 数组、无 shell
- [ ] 单文件运行 `server/modules/architecture/tests/refreshRoutes.test.ts` exit 0：`POST /api/architecture/refresh` 首次 202、并发第二次返回同一 jobId 且 `coalesced:true`；`GET /api/architecture/refresh/status` 在 idle / running / succeeded / failed 下的响应形状；请求体里带路径字段被忽略（项目只按 projectId 服务端解析）；未知 projectId 返回 4xx
- [ ] `npx vitest run src/modules/architecture/tests/useArchitectureRefresh.test.tsx` exit 0：hook 加载时读 status 并反映别的会话发起的运行态、运行中不允许第二次启动、成功后触发图重新拉取与未解析名字复核、失败暴露原因与 retry
- [ ] `npx vitest run src/modules/architecture/tests/architectureRefreshDialog.test.tsx` exit 0：确认弹窗内容、焦点陷阱、Escape 只关弹窗且不触发 `chat.abort`、Cancel 不发请求、Refresh 恰好发一次请求、运行态显示已用时间且按钮禁用、失败态显示原因与 Retry
- [ ] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0：新增文案键在应用使用的全部语言包中齐全
- [ ] `npx playwright test e2e/architecture-refresh.spec.ts` exit 0（新增文件，在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）：通过 `server.settings.json` 可配置路径指向假 CLI，点击刷新 → 确认 → 运行态 → 成功后页脚时间更新且未解析名字复核重跑；两个浏览器页并发点击只产生一次假 CLI 调用（计数文件为 1）；假 CLI 失败时旧产物不变并显示原因与 Retry
- [ ] `npx playwright test e2e/architecture-refresh.spec.ts --grep "control arm"` exit 0：控制臂——去掉 single-flight、去掉失败保留旧产物时对应读数变红，主臂与控制臂用同一读取函数
- [ ] `grep -rnE "pkill|shell: *true|exec\(" server/modules/architecture/` 在新增的刷新服务文件中零命中（不含测试里的反例字符串）
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` exit 0

## DoD

后端与前端合在一起真实走通一次：先在 `tmp/` 下的隔离副本上做完 spike；然后用真实 MCP 浏览器在运行中的实例里打开 claudecodeui 的 Architecture 标签，亲手点页脚刷新图标与诚实条 "Refresh analysis"，看确认弹窗、Cancel、Escape（确认聊天页上 Escape 只关弹窗、不中断正在跑的回合）、确认后的运行态与已用时间、开第二个标签页确认它直接显示运行态且无第二次启动入口、成功后图重新加载并 Fit、未解析名字数下降；失败路径用假 CLI 或错误配置演示原因与 Retry。截图存 `tmp/` 并贴进 Evidence。仓库里若存在 Architecture 场景则另跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴出 JSON 报告与检查点截图；目前 `e2e/scenarios/` 只有 `cockpit-mode-switch.json` 与 `quay-wall-focus-pin-utter.json`，不存在 Architecture 场景，届时仍不存在就在 Evidence 里写明。对活仓库的一次真实分析只在使用隔离 `--work-dir`（或 spike 已证明原子写入）时才做，且不得覆盖用户当前的 `.archguard`；任何临时改动必须还原。不得在会话内跑无界多文件测试 fan-out（见 AGENTS.md "Running tests"）。

## Touches

- server/modules/architecture/routes.ts
- server/modules/architecture/refreshJob.ts
- server/modules/architecture/index.ts
- server/modules/architecture/tests/refreshJob.test.ts
- server/modules/architecture/tests/refreshRoutes.test.ts
- server/shared/types.ts
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/useArchitectureRefresh.ts
- src/modules/architecture/ArchitectureRefreshDialog.tsx
- src/modules/architecture/tests/useArchitectureRefresh.test.tsx
- src/modules/architecture/tests/architectureRefreshDialog.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/zh-CN/common.json
- e2e/architecture-refresh.spec.ts
- playwright.config.ts
- tasks/architecture-archguard-refresh-trigger.md
