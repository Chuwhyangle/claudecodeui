---
id: deploy-readiness-build-and-safe-restart
title: 委托阶梯第一次晋级：部署就绪读数 + 一键「构建并安全重启」（需确认）+ 重启后自动核验
status: done
labels:
  - cockpit
  - ops
  - delegation
parent: null
children: []
extra: {}
---
## Proposal

决策出处：`docs/proposals/context-layers-and-delegation-ladder.md` 的 P2「第一次晋级」，用户 2026-10-24 确认立项。探针显示「构建 / 重启」占用户全部话语的 10%（116 个会话、1982 条中有 198 条），而且常常连发两次（重启后再问「重启成功了吗」）；「当前运行的版本包括驾驶舱的变更吗」「实际接线可用了吗」也是同一类问题。根因是系统看不到自己的部署状态，于是人只能一遍遍地问、再手动去做。本任务把这一类操作从「你自己做」升到「系统做、你确认」。

现状实读（2026-10-24）：
- `/health` 已经返回 `buildSha` / `builtAt`（`server/index.ts`，来源是构建时写入的 `dist-server/build-info.json`）。
- `scripts/check-deploy-freshness.mjs` 只是手动运行的检测器，判断运行中的构建落后某个 ref 多少。
- `scripts/restart-server-detached.sh` 是安全重启：在独立的 transient unit 里执行，所有前置检查都在 stop 之前完成，启动失败会重试一次，并给出明确的结论。
- 前端 `dist/` 没有构建指纹，只有服务端有。

方案：
1. **部署就绪读数**（服务端新服务 `server/modules/system/deploy-readiness.service.ts`）：比较三个 sha——运行中的服务端（BUILD_INFO）、磁盘上已构建的产物（`dist-server/build-info.json` 以及新增的 `dist/build-info.json`）、检出的 HEAD。从中得出状态：`fresh` / `pending-build`（N 个提交触及 `src/` 或 `server/`，列出提交标题和它们对应的任务 id）/ `built-pending-restart` / `building` / `restarting` / `unknown`（例如开发模式没有指纹）。只读，有短 TTL 缓存。
2. **前端构建指纹**：新增 `scripts/write-client-build-info.mjs`，作为 `build:client` 的最后一步写入 `dist/build-info.json`（gitSha、builtAt），格式与服务端一致。
3. **一个动作：「构建并安全重启」**（`POST /api/system/deploy`，需要认证）：先在独立的 transient unit 中执行 `npm run build`，避免和服务进程同处一个 cgroup；成功后调用 `scripts/restart-server-detached.sh --delay 5`。构建失败时**不重启**，失败原因（哪一步、最后若干行输出）写回读数里。重启前把「期望的目标 sha」记到一个本地状态文件。
4. **重启后自动核验**：新进程启动后读取该状态文件，逐项核对——运行中的 buildSha 是否等于目标 sha、fleet 握手状态（`fleet-summary` 的 `fleet.state`）、几个关键路由（`/`、`/cockpit`、`/api/quay/fleet-summary`）是否返回 200——然后把结果写进读数（`lastDeploy: {targetSha, ok, checks[], at}`）。不再需要人问「重启成功了吗」。
5. **界面**：
   - 驾驶舱常驻一条部署状态：「N 个变更待生效 · [构建并重启]」/「已构建，待重启」/「构建中…」/「最近一次部署：abc123 · 核验通过 · 2 分钟前」。
   - 点击后弹出确认面板，列出将生效的提交与任务，并提示「重启期间页面会断开数秒」；**必须确认才执行**（离散确认，不接受语音的「是」）。
   - 会话页顶部在状态不是 fresh 时显示同一条的紧凑版。
6. 事件留出接缝：构建完成、重启完成、核验结果都通过一个可注入的回调发出（默认什么也不做），之后统一接入主机级上下文事件流。

## AC

- [x] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/system/tests/deploy-readiness.test.ts` exit 0——用桩 git 和桩指纹：三个 sha 相等 ⇒ fresh；HEAD 领先且有提交触及 `src/` 或 `server/` ⇒ pending-build，并列出这些提交；只触及 `docs/` 或 `tasks/` ⇒ fresh；已构建产物的 sha 等于 HEAD 但运行中的不等 ⇒ built-pending-restart；没有指纹 ⇒ unknown。
- [x] AC2: 同一测试文件——`POST /api/system/deploy`：构建桩失败 ⇒ 重启桩调用 0 次，读数里带失败步骤和输出尾部；构建成功 ⇒ 重启桩恰好调用 1 次，参数含 `--delay`；未认证 ⇒ 401。
- [x] AC3: 同一测试文件——启动核验：状态文件里的目标 sha 等于运行中的 sha 且各检查项为 200 ⇒ `lastDeploy.ok === true`；sha 不等 ⇒ ok 为 false，并在 checks 中指明是哪一项；没有状态文件 ⇒ 不产生 lastDeploy。
- [x] AC4: `node --test scripts/write-client-build-info.test.mjs` exit 0——在临时目录里写出的 `build-info.json` 字段与服务端格式一致。
- [x] AC5: `npx vitest run src/modules/cockpit/tests/DeployReadiness.test.tsx` exit 0——各状态的文案和按钮正确；点击「构建并重启」只打开确认面板，确认之前 deploy 请求为 0 次，确认后恰好 1 次；fresh 状态下会话页不显示紧凑条。
- [x] AC6: 文案覆盖 12 个 locale；`npm run typecheck` 通过。

## DoD

- **MCP 浏览器（或独立 Playwright）实际操作 + 截图（必做）**：在隔离实例（复制的数据库、独立端口，关闭 residentRestore）上截图 pending-build、确认面板、核验结果三种状态；隔离实例的重启使用桩，不碰 :3001。截图存 `tmp/` 并在任务中贴出。
- 在真实 :3001 上只读取部署就绪读数（不执行 deploy），贴出读数并与 `scripts/check-deploy-freshness.mjs` 的结论对照。
- 真实 :3001 上的第一次「构建并重启」由用户在界面上亲手点击触发；执行者如实写明这一步留给用户（待外部）

## Touches

- server/modules/system/deploy-readiness.service.ts (new)
- server/modules/system/tests/deploy-readiness.test.ts (new)
- server/modules/system/system.routes.ts
- server/modules/system/system.service.ts
- server/modules/system/system.module.ts
- server/index.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/write-client-build-info.mjs (new)
- scripts/write-client-build-info.test.mjs (new)
- scripts/suite-duration-baseline.tsv
- package.json
- src/shared/api.ts
- src/modules/cockpit/DeployReadiness.tsx (new)
- src/modules/cockpit/tests/DeployReadiness.test.tsx (new)
- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/index.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/project-workspace/WorkspaceMain.tsx
- src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts
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
- tasks/deploy-readiness-build-and-safe-restart.md

## Verification

证据（2026-10-24，工作树 `deploy-readiness-build-and-safe-restart`）：

- AC1/AC2/AC3：`npx tsx --tsconfig server/tsconfig.json --test server/modules/system/tests/deploy-readiness.test.ts` → 14 pass / 0 fail（fresh、pending-build 列表、docs-only ⇒ fresh、built-pending-restart、unknown；构建失败不重启、成功恰好一次 `--delay`、未认证 401 且 build 调用 0 次；启动核验 ok/失配/无状态文件）。
- AC4：`node --test scripts/write-client-build-info.test.mjs` → 2 pass / 0 fail。
- AC5：`npx vitest run src/modules/cockpit/tests/DeployReadiness.test.tsx` → 12 pass；同轮 `i18nCockpitCompleteness.test.ts` → 9 pass。
- AC6：`npm run typecheck` 通过；12 个 locale 均补齐 `deploy*` 文案（任一 locale 缺键或丢占位符都会被完整性用例打红）。
- 新增 server 测试文件的套件钉子：`server/shared/tests/quay-test-script.test.ts` 的收集数 427→428（AC2 unknown 424→425、AC3 426→427），`scripts/suite-duration-baseline.tsv` 增加本文件的时长行，使 AC7 的 90% 覆盖底线保持在上方（385/428→386/428）。该文件 14 项全绿。
- DoD 浏览器（独立 Playwright；隔离实例 API `:3101` + vite `:5174`，独立 DB，`residentRestore.enabled=false`，重启指向桩脚本，未触碰 `:3001`）：
  - `tmp/deploy-verify/1-pending-build.png` — 驾驶舱常驻条：「1 change not yet built · Build and restart」。
  - `tmp/deploy-verify/2-confirm-panel.png` — 确认面板列出将生效提交与「重启期间页面会断开数秒」；确认前 deploy 请求 0 次。
  - `tmp/deploy-verify/3-after-confirmed-deploy.png` — 确认后恰好一次；重启桩记录 `--delay 5`。
  - `tmp/deploy-verify/4-verification-result.png` — 真实启动核验（新进程读到状态文件后记录）：日志 `deploy: boot verification passed`，条上显示「Last deploy adf07bc · verified · just now」。
- 真实 `:3001` 只读读数（不执行 deploy）：running/built sha = `2d995e88`，HEAD = `0bf6356`，`status: pending-build`，34 个触及 `src/`/`server/` 的待构建提交；`dist/build-info.json` 尚无指纹（新脚本随下次构建落地）。对照 `scripts/check-deploy-freshness.mjs --ref HEAD`：`STALE, behindBy 225` —— 结论一致（检测器数全部提交，本读数只列会触发构建的 source 提交）。原始读数见 `tmp/deploy-verify/real-readiness.json`。
- 2026-10-24 续做轮（suite 红修复）：`src/modules/cockpit/tests/CockpitPushToTalk.test.tsx` 的 AC3「reaches useVoiceInput through the @/modules/chat barrel」在本分支上真实复现（单文件运行同样红）。根因不是该测试自身：`ChatInterface` 从 cockpit 桶导入 `DeployReadiness`，闭合成 `chat/index → ChatInterface → cockpit/index → CockpitPage → useCockpitPushToTalk → chat/index` 的跨模块环，使 vitest 的 `vi.mock('@/modules/chat')` 包不住该 hook。改为 `ChatInterface` 接受可选的 `noticeSlot`，由已经同时导入两个桶的 `WorkspaceMain` 传入 `<DeployReadiness compact />`；chat 不再导入 cockpit，节点位置与视觉不变。复跑：`CockpitPushToTalk` 5 pass、`DeployReadiness` 12 pass、`i18nCockpitCompleteness` 9 pass、`escapeAbortGuard` 6 pass、`scenarioSurface` 2 pass；AC1/AC2/AC3 14 pass；AC4 2 pass；`npm run typecheck` 通过。
- 待外部：真实 `:3001` 上的第一次「构建并重启」由用户在界面上亲手点击触发；执行者未在 `:3001` 执行 deploy。

## Blocker

**2026-10-24T13:52:10.843Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - src/modules/cockpit/tests/CockpitPushToTalk.test.tsx: AssertionError: expected "spy" to be called at least once
- run_id：wk-prod-anchor
- session_id：048cfb69-8793-41b2-8a2b-692b8f2b9dd7
