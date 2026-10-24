---
id: architecture-archguard-refresh-trigger
title: 架构图手动刷新分析：确认弹窗后整项目重跑 archguard，多会话并发点击合并为一个作业，失败保留旧产物
status: ready
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

## Evidence

### Spike（隔离 `--work-dir`，源目录只读，2026-10-25）

环境：`@yalehwang/archguard` 0.1.42（`~/.claude/plugins/npm-cache/node_modules/@yalehwang/archguard/dist/cli/index.js`），`cwd=/data/home/yale/work/claudecodeui`，两个 work-dir 都落在本 worktree 的 `tmp/spike/`，用 `systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0` 包裹。

- 运行 1（默认 mermaid 格式）：`node <cli> analyze -s /data/home/yale/work/claudecodeui/src /data/home/yale/work/claudecodeui/server --lang typescript --work-dir <wt>/tmp/spike/work-1`
  - 墙钟 **11.41 s**，峰值 RSS **2,708,428 KB ≈ 2.58 GiB**（`/usr/bin/time -v`）。
  - exit **1**：`server/class/all-classes` 的 Mermaid/SVG worker 报 `CSSStyleSheet is not defined`；`query/` 产物仍完整写出。
- 运行 2（`-f json`，最终采用）：`node <cli> analyze -s <root>/src <root>/server --lang typescript -f json --work-dir <wt>/tmp/spike/work-2`
  - 墙钟 **11.74 s**，峰值 RSS **2,002,628 KB ≈ 1.91 GiB**，exit **0**。
  - 结论：`-f json` 关掉本任务不消费的 Mermaid/SVG 渲染腿，避免无头主机上"产物正确但 exit 1"；服务端 argv 固定带 `-f json`。
- scope key / label：运行 1、2 的 manifest 都恰好给出 `93e0a992` "src (typescript)"（sources `<root>/src`）与 `bcc56acf` "server (typescript)"（sources `<root>/server`），与现有 manifest 一致。key 由 `hashSources(sources, language)` = `sha256('typescript::' + realpath 排序 join).slice(0,8)` 得出，源目录绝对路径不变则 key 稳定。
- 遗留 `a24387f8` "chat" scope 结论：其源 `src/modules/chat` 嵌套在 `src` 内，服务端 `mergeScopeIndexes` 本就把它当 subsumed；整项目刷新只分析 `src` + `server`，新 manifest 不再写 chat scope（旧 scope 目录在交换时丢弃）。`resolveRefreshSources` 按"嵌套源只留最外层"实现这条结论。
- 原子性：CLI 对 `arch.json` / `arch-index.json` / `manifest.json` 逐文件 `tmp + rename`（`atomicWriteFile`），但**整轮不是原子的**——每个 scope 独立落盘、manifest 最后写，中途失败可在 query 目录留下部分新产物。据此服务端采用**临时 work-dir + 成功后交换**：子进程写 `<project>/.archguard/refresh/<jobId>`，只有 exit 0 且 `query/manifest.json` 存在才把 `query` 目录 rename 交换进去（旧目录先移开，第二次 rename 失败时回滚）；失败 / 超时 / 关闭只删 staging，活 `.archguard/query` 字节不变。旧 query 里非 scope 的辅助产物（`duplicates` / `git-history` / `shape-smells`）随交换搬入新目录。
- 内存上限与超时取值：峰值 ≈2.0 GiB ⇒ `memoryLimitMb` 默认 **6144**（3x 峰值），有 systemd user manager 时用 `systemd-run --user --scope -p MemoryMax=6144M -p MemorySwapMax=0`；`timeoutMs` 默认 **20 min**（实测 11.7 s 的 ~100x）。

### 实现与验证读数（均在本 worktree 内单文件运行）

- `refreshJob.test.ts`：**8 pass / 0 fail**，exit 0，duration 12.77 s。覆盖：并发 start 只 spawn 一次且同一 jobId + `coalesced:true`；结束后再 start 起新作业；失败时活 manifest 字节不变、failed 带 stderr 尾部；超时 SIGTERM 子进程并 failed；`shutdown()` 杀子进程；CLI 无法解析不 spawn 且原因可读；spawn 为 argv 数组、无 shell、`detached`、cwd=项目根。
- `refreshRoutes.test.ts`：**3 pass / 0 fail**，exit 0，duration 2.52 s。覆盖：首次 202、并发第二次同 jobId + `coalesced:true`；idle / running / succeeded / failed 响应形状；请求体 `path` / `sources` 被忽略（cwd 与 `-s` 仍由服务端解析）；未知 projectId 两个动词都 404 `PROJECT_NOT_FOUND`。
- `useArchitectureRefresh.test.tsx`：**8 pass**，exit 0。包含"加载即读 status 并反映别的会话的 running"、"运行中第二次 start 不发请求"、"running→succeeded 只投递一次"、"挂载即 succeeded 不投递"、失败原因 + retry。
- `architectureRefreshDialog.test.tsx`：**8 pass**，exit 0。确认文案 / 焦点陷阱 / Escape 只关弹窗（document 级 `chat.abort` 监听计数为 0）/ Cancel 不发请求 / Refresh 恰好一次 / running 显示 1:05 且按钮 disabled / failed 显示原因 + Retry / 关闭后焦点回触发器。
- `i18nArchitectureTabCompleteness.test.ts`：**8 pass**，exit 0（12 个语言包全部带 `architecture.refresh.*` 键与 `{{elapsed}}` 占位符）。
- 既有面板套件回归：`architectureTab.test.tsx` 127 pass、`mobileCompactToolbar.test.tsx` 15 pass、`fullscreen + canvasLayoutContract + architectureTab` 合计 138 pass（都在本 worktree 单次小范围运行）。
- `npx playwright test e2e/architecture-refresh.spec.ts`：**2 passed (53.8 s)**（整次调用；两 case 体 29.4 s / 13.9 s）。`--grep "control arm"`：**1 passed (24.2 s)**。`SPEC_BUDGET_MS` 已加 `architecture-refresh.spec.ts: 240_000` 并写明实测。
- `quay-test-script.test.ts` 单文件：**14 pass**（80 s），新增两个 server 测试文件后把 `known=3 unknown=434` / `known=1 unknown=436`（收集数 437）与 baseline 行（12769 ms / 2520 ms）一并更新。
- `grep -rnE "pkill|shell: *true|exec\(" server/modules/architecture/refreshJob.ts`：**zero**（其余命中来自既有 `generator.ts` 的正则 `.exec(` 与测试）。
- `npm run typecheck` / `npm run build` / `npm run lint`：均 exit 0（lint 只有仓库既有 warnings，0 errors）。

### DoD（真实页面走通）

- MCP 浏览器在本 worker 不可用（无该工具），改用**真实 Playwright 浏览器**亲手走同一条链路，截图存 `tmp/architecture-refresh/`：`01-baseline.png`（Analysis: 10 months ago、`1 names …`）、`02-confirm-dialog.png`（整项目 / 数分钟 / 其他会话说明 + Cancel/Refresh）、`03-running.png`（Refreshing analysis… `0:00 elapsed`、按钮禁用、页脚 `0:00`）、`04-mid-run-tab.png`（运行中打开的第三标签页 footer state=running、按钮 disabled）、`05-succeeded.png`（`Analysis: 2 seconds ago`、`0 names …`、Delta 入图、zoom 150% = Fit）、`06-failed-retry.png`（`ArchGuard exited with code 1: fake archguard: deliberate analysis failure` + Retry，Analysis 时间不变）、`07-control-no-coalesce.png`、`08-control-no-preserve.png`。
- Escape 的 `chat.abort` 语义由 `architectureRefreshDialog.test.tsx` 用 document 级监听臂验证（真实页面该臂没有启动聊天回合）；焦点陷阱同测。
- 场景运行器：`e2e/scenarios/` 仍只有 `cockpit-mode-switch.json` 与 `quay-wall-focus-pin-utter.json`，不存在 Architecture 场景，因此未运行 `node scripts/ui-scenario.mjs`。
- 真实分析只在 `tmp/` 隔离 work-dir 上跑（源目录只读），活 `.archguard` 未被 spike 覆盖；e2e 用假 CLI，未对活仓库做真实分析；临时文件均在 git-ignored `tmp/`。

## AC

- [x] Spike 结论已写入本任务 Evidence：确切 argv、scope key / label 对照现有 manifest、墙钟、峰值 RSS、是否原子写入及据此选定的写入策略；`grep -c "93e0a992" tasks/architecture-archguard-refresh-trigger.md` 与 `grep -c "bcc56acf" tasks/architecture-archguard-refresh-trigger.md` 均 ≥ 2（Proposal 一处加 Evidence 一处）
- [x] 单文件运行 `server/modules/architecture/tests/refreshJob.test.ts`（按仓库服务端测试运行器直接跑这一个文件，不做多文件 fan-out）exit 0：两个并发 `start` 只 spawn 一次且返回同一 jobId、第二个带 `coalesced:true`；作业结束后再 start 会起新作业；失败（非零退出）时旧产物字节不变且状态为 failed 并带 stderr 尾部；超时会杀掉子进程并置 failed；服务器关闭钩子会杀掉运行中的子进程；CLI 无法解析时给出明确错误且不 spawn；spawn 调用是 argv 数组、无 shell
- [x] 单文件运行 `server/modules/architecture/tests/refreshRoutes.test.ts` exit 0：`POST /api/architecture/refresh` 首次 202、并发第二次返回同一 jobId 且 `coalesced:true`；`GET /api/architecture/refresh/status` 在 idle / running / succeeded / failed 下的响应形状；请求体里带路径字段被忽略（项目只按 projectId 服务端解析）；未知 projectId 返回 4xx
- [x] `npx vitest run src/modules/architecture/tests/useArchitectureRefresh.test.tsx` exit 0：hook 加载时读 status 并反映别的会话发起的运行态、运行中不允许第二次启动、成功后触发图重新拉取与未解析名字复核、失败暴露原因与 retry
- [x] `npx vitest run src/modules/architecture/tests/architectureRefreshDialog.test.tsx` exit 0：确认弹窗内容、焦点陷阱、Escape 只关弹窗且不触发 `chat.abort`、Cancel 不发请求、Refresh 恰好发一次请求、运行态显示已用时间且按钮禁用、失败态显示原因与 Retry
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0：新增文案键在应用使用的全部语言包中齐全
- [x] `npx playwright test e2e/architecture-refresh.spec.ts` exit 0（新增文件，在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）：通过 `server.settings.json` 可配置路径指向假 CLI，点击刷新 → 确认 → 运行态 → 成功后页脚时间更新且未解析名字复核重跑；两个浏览器页并发点击只产生一次假 CLI 调用（计数文件为 1）；假 CLI 失败时旧产物不变并显示原因与 Retry
- [x] `npx playwright test e2e/architecture-refresh.spec.ts --grep "control arm"` exit 0：控制臂——去掉 single-flight、去掉失败保留旧产物时对应读数变红，主臂与控制臂用同一读取函数
- [x] `grep -rnE "pkill|shell: *true|exec\(" server/modules/architecture/` 在新增的刷新服务文件中零命中（不含测试里的反例字符串）
- [x] `npm run typecheck`、`npm run build`、`npm run lint` exit 0

## DoD

后端与前端合在一起真实走通一次：先在 `tmp/` 下的隔离副本上做完 spike；然后用真实 MCP 浏览器在运行中的实例里打开 claudecodeui 的 Architecture 标签，亲手点页脚刷新图标与诚实条 "Refresh analysis"，看确认弹窗、Cancel、Escape（确认聊天页上 Escape 只关弹窗、不中断正在跑的回合）、确认后的运行态与已用时间、开第二个标签页确认它直接显示运行态且无第二次启动入口、成功后图重新加载并 Fit、未解析名字数下降；失败路径用假 CLI 或错误配置演示原因与 Retry。截图存 `tmp/` 并贴进 Evidence。仓库里若存在 Architecture 场景则另跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴出 JSON 报告与检查点截图；目前 `e2e/scenarios/` 只有 `cockpit-mode-switch.json` 与 `quay-wall-focus-pin-utter.json`，不存在 Architecture 场景，届时仍不存在就在 Evidence 里写明。对活仓库的一次真实分析只在使用隔离 `--work-dir`（或 spike 已证明原子写入）时才做，且不得覆盖用户当前的 `.archguard`；任何临时改动必须还原。不得在会话内跑无界多文件测试 fan-out（见 AGENTS.md "Running tests"）。

## Touches

- config/server.settings.example.json
- e2e/architecture-refresh.spec.ts
- playwright.config.ts
- scripts/suite-duration-baseline.tsv
- server/modules/architecture/module.ts
- server/modules/architecture/refreshJob.ts
- server/modules/architecture/routes.ts
- server/modules/architecture/tests/refreshJob.test.ts
- server/modules/architecture/tests/refreshRoutes.test.ts
- server/shared/tests/quay-test-script.test.ts
- server/shared/types.ts
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/ArchitectureRefreshDialog.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/rendererContract.ts
- src/modules/architecture/tests/architectureRefreshDialog.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- src/modules/architecture/tests/useArchitectureRefresh.test.tsx
- src/modules/architecture/useArchitectureRefresh.ts
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/es/common.json
- src/modules/i18n/locales/fr/common.json
- src/modules/i18n/locales/id/common.json
- src/modules/i18n/locales/it/common.json
- src/modules/i18n/locales/ja/common.json
- src/modules/i18n/locales/ko/common.json
- src/modules/i18n/locales/ru/common.json
- src/modules/i18n/locales/tr/common.json
- src/modules/i18n/locales/zh-CN/common.json
- src/modules/i18n/locales/zh-TW/common.json
- src/shared/api.ts
- tasks/architecture-archguard-refresh-trigger.md
