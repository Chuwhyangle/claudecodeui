---
id: session-task-flow-chain-status
title: 会话发起任务的流转链状态：立案 → 执行中 → 已合入 → 已构建 → 线上运行，替代「检查进展」
status: ready
labels:
  - chat
  - cockpit
  - delegation
parent: null
children: []
extra: {}
depends_on:
  - deploy-readiness-build-and-safe-restart
---
## Proposal

决策出处：`docs/proposals/context-layers-and-delegation-ladder.md` 的 P2，用户 2026-10-24 确认立项。「检查进展」是用户最常点的习惯 chip，在 1982 条真实话语中有 95 条；再加上「检查是否已经落地可用」「当前运行的版本包括 X 的变更吗」，这一类话的本质都是在问「我在这个会话里发起的事，现在走到哪一步了」。系统应该主动告诉人，而不是等人来问。这是系统自述（L3）的第一块。

现状实读（2026-10-24）：
- 任务提交信息里的 `task_write by cli:<pid>` 是 quay CLI 自身的进程号，追溯不到会话。
- 会话转写里有完整的工具调用记录：`quay task create|edit <id>` 的 Bash 命令、MCP `task_write` 调用、发给 quay 子代理的请求。从这些记录可以确定性地得到「本会话创建或编辑过的任务 id」。
- 任务状态来自任务库；合入提交来自 develop 历史；线上运行的构建由部署就绪读数提供（任务 `deploy-readiness-build-and-safe-restart` 引入）。

方案：
1. **会话 → 任务映射**（服务端新服务 `server/modules/quay/session-task-chain.service.ts`）：扫描会话转写中的工具调用，提取本会话创建或编辑过的任务 id，区分 created 和 edited，按增量缓存（只读新增部分）。
2. **流转链**：每个任务给出阶段 `立案(todo) → 就绪(ready) → 执行中(有 worktree 或 worker) → 已合入(done，带合入提交) → 已构建(合入提交 ⊆ 已构建产物的 sha) → 线上运行(合入提交 ⊆ 运行中的 buildSha)`，另有异常分支：卡住（带 Blocker 的未落地原因摘要）、needs-human、superseded。祖先关系用 `git merge-base --is-ancestor` 判定。
3. **会话视图**：会话顶部显示一条紧凑状态，例如「本会话发起 6 个任务：执行中 2 · 已合入待生效 3 · 线上 1 · 卡住 0」，点开后逐个列出任务和阶段；任一任务从「已合入」进入「线上运行」时，用一次轻量提示告知（不弹窗）。
4. **驾驶舱**：在项目层的任务卡片和舞台上使用同一份阶段数据；「已合入待生效」的计数与部署就绪条联动。
5. 只读，不触发任何构建、重启或任务写入。

## AC

- [x] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/session-task-chain.test.ts` exit 0——转写夹具中包含 Bash `quay task create a --title …`、`quay task edit b --body-file …`、MCP `task_write`（id c）、只读的 `quay task view d`：结果为 created [a]、edited [b, c]，不含 d；增量读取不会重复计数。
- [x] AC2: 同一测试文件——在桩任务库、桩 git、桩部署读数下，阶段判定正确：todo ⇒ 立案；ready 且有 worktree ⇒ 执行中；done 且合入提交不在已构建产物的 sha 祖先链上 ⇒ 已合入；在已构建产物里但不在运行中的构建里 ⇒ 已构建；在运行中的构建里 ⇒ 线上运行；带 Blocker ⇒ 卡住，并附未落地原因的第一行。
- [x] AC3: `npx vitest run src/modules/chat/tests/SessionTaskChain.test.tsx` exit 0——紧凑条的计数与夹具一致；没有任务的会话不显示紧凑条；某个任务从「已合入」变为「线上运行」时出现一次提示，且同一变化不会重复提示。
- [x] AC4: 文案覆盖 12 个 locale；`npm run typecheck` 通过。

## DoD

- **MCP 浏览器（或独立 Playwright）实际操作 + 截图（必做）**：在隔离实例（复制的数据库，关闭 residentRestore）上打开「人类 I/O 带宽与 UI 设计原则」会话，截图紧凑条和展开列表；对照任务库与 develop 历史，人工核对至少 5 个任务的阶段；截图存 `tmp/` 并贴出。
- 如实写明映射的漏检情况：例如由子代理代写、或从其他会话转交的任务，是否能被识别。

## Evidence

**AC 逐条复验（2026-10-24，本任务分支）**

- AC1+AC2：`npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/session-task-chain.test.ts` → exit 0，7 passed / 0 failed。夹具覆盖 Bash create/edit、MCP task_write、只读 view 忽略、增量轮询不重复；阶段覆盖 todo / ready+worktree / done-not-built / built-not-running / running / Blocker（含未落地原因首行）/ needs-human / superseded / 任务库缺失。
- AC3：`npx vitest run src/modules/chat/tests/SessionTaskChain.test.tsx` → exit 0，4 passed。紧凑条四个计数与夹具一致；无任务不渲染；已合入→线上运行只提示一次，且后续轮询不重复；卡住任务展开显示未落地原因首行。
- AC4：12 个 locale 均新增 `sessionTaskChain` 块（en/de/es/fr/id/it/ja/ko/ru/tr/zh-CN/zh-TW），`src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts` 逐 locale 校验键完整与占位符一致 → 10 passed；`npm run typecheck` → exit 0。

**DoD：隔离实例 + 真实浏览器（Playwright headless）**

- 实例：本分支 `npm run build` 产物（`dist-server/build-info.json` gitSha `2b685e3be`），`scripts/isolated-instance.sh start`（复制 live DB、`residentRestore.enabled=false`，日志 `resident-restore started=0`），端口 3149。
- 会话：「人类 I/O 带宽与 UI 设计原则」（session `d01bc610-561d-45ed-baae-98e983ee3e2d`）。
- 截图与读数：`tmp/session-chain-dod/01-compact-bar.png`（紧凑条）、`02-expanded-list.png`（展开列表）、`report.json`。紧凑条读数：19 个任务，执行中 1 · 已合入待生效 0 · 线上 16 · 卡住 1；展开 19 行；console error 0、page error 0。
- 人工核对 5 个任务（对照任务库与 develop 历史）：
  1. `session-task-flow-chain-status`：store `ready` + 本任务 worktree 在列 → 执行中。
  2. `quay-pulse-strip-compact-health-view`：store `ready` + `## Blocker` 的 `未落地原因：step=suite: __PERFILE__ … quay-test-script.test.ts passed=false` → 卡住，界面显示同一行。
  3. `deploy-readiness-build-and-safe-restart`：store `done`，合入提交 `ab9fe56c` 是构建 sha `2b685e3b` 的祖先 → 线上运行。
  4. `quay-wall-addressable-view-and-input-package`：store `done`，合入提交 `4a9b9e3d` 是构建 sha 的祖先 → 线上运行。
  5. `a`：转写里确有 `quay task create a --title …`，但任务库无此任务 → 显示「任务库中不存在」（unknown），按实计 1 条，不隐藏。

**映射漏检（如实登记）**

- 子代理代写：只读会话主转写（`sessions.jsonl_path`），不读 `<session>/subagents/agent-*.jsonl`；在 dispatch / quay 子代理里创建的任务不会归到父会话，除非父会话转写里也出现 `quay task …`。
- 其他会话转交：只认本会话转写中的工具调用；口头转交或别处创建后移交的任务不可见。
- MCP `task_write` 创建新任务但 `input` 不带 id（id 只出现在工具结果里）时无法归属。
- 「执行中」只读 worktree（`git worktree list --porcelain` 的 `task/<id>` 分支）；没有 worktree 的 worker 与「就绪」不可区分，未接 worker 注册表。
- 合入提交按提交消息约定（`task/<id>` 或 `tasks: <id>`）在 develop / HEAD 上检索；消息不含任务 id 的合入读作「已合入」而非线上。

**范围说明**

- 方案 4（驾驶舱复用同一份阶段数据）本轮未接线：AC 只覆盖会话视图；阶段数据已由 `GET /api/quay/:projectId/session-task-chain` 提供，`CockpitStage` 的展示接线留给后续任务，避免在没有判据的情况下改动驾驶舱舞台。

**续跑轮（2026-10-24，suite 红修复）**

- 上一轮 fan-in 红在 `server/shared/tests/quay-test-script.test.ts`：不是 delta-relatedness 判定的「无关」，而是本任务新增 `server/modules/quay/tests/session-task-chain.test.ts` 把 server 收集数 432 → 433，AC2/AC3 的两条精确 pin 各差 1（实读 `unknown=430`/`432`，钉 `429`/`431`）。首次 fan-in 日志里 `not ok` 行点名的子测试（positional test file …）其实是绿的——真红是后面的 AC2/AC3，单文件复跑才看得见。
- 修复：两条 pin 移到 430/432，并在注释链补记本次 +1；`scripts/suite-duration-baseline.tsv` 追加实测行 `1897 server/modules/quay/tests/session-task-chain.test.ts`（单文件跑得 `duration_ms 1897`），391 行 / 433 收集 = 90.3%，AC7 地板仍绿。
- 单文件复验：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` → exit 0，**14 passed / 0 failed，duration_ms 86192**（AC2/AC3/AC4/AC5/AC6/AC7、e2e-lane 三条腿全绿）。
- anti-drift：`anti-drift-touches-check.js --task session-task-flow-chain-status --merge-target develop` → `ANTI-DRIFT OK … 23 actual file(s), all within declared Touches`。

## Touches

- server/modules/quay/session-task-chain.service.ts (new)
- server/modules/quay/tests/session-task-chain.test.ts (new)
- server/modules/quay/quay.routes.ts
- server/modules/quay/quay.service.ts
- server/modules/quay/quay.module.ts
- src/modules/chat/SessionTaskChain.tsx (new)
- src/modules/chat/tests/SessionTaskChain.test.tsx (new)
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/index.ts
- src/modules/cockpit/CockpitStage.tsx
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
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/session-task-flow-chain-status.md

## Blocker

**2026-10-24T15:26:27.192Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=115985 server/shared/tests/quay-test-script.test.ts passed=false end_ms=1792855139045
- run_id：wk-prod-anchor
- session_id：798cddfb-028a-4ff3-a8e8-82c6c9ad53b1
