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

- [ ] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/session-task-chain.test.ts` exit 0——转写夹具中包含 Bash `quay task create a --title …`、`quay task edit b --body-file …`、MCP `task_write`（id c）、只读的 `quay task view d`：结果为 created [a]、edited [b, c]，不含 d；增量读取不会重复计数。
- [ ] AC2: 同一测试文件——在桩任务库、桩 git、桩部署读数下，阶段判定正确：todo ⇒ 立案；ready 且有 worktree ⇒ 执行中；done 且合入提交不在已构建产物的 sha 祖先链上 ⇒ 已合入；在已构建产物里但不在运行中的构建里 ⇒ 已构建；在运行中的构建里 ⇒ 线上运行；带 Blocker ⇒ 卡住，并附未落地原因的第一行。
- [ ] AC3: `npx vitest run src/modules/chat/tests/SessionTaskChain.test.tsx` exit 0——紧凑条的计数与夹具一致；没有任务的会话不显示紧凑条；某个任务从「已合入」变为「线上运行」时出现一次提示，且同一变化不会重复提示。
- [ ] AC4: 文案覆盖 12 个 locale；`npm run typecheck` 通过。

## DoD

- **MCP 浏览器（或独立 Playwright）实际操作 + 截图（必做）**：在隔离实例（复制的数据库，关闭 residentRestore）上打开「人类 I/O 带宽与 UI 设计原则」会话，截图紧凑条和展开列表；对照任务库与 develop 历史，人工核对至少 5 个任务的阶段；截图存 `tmp/` 并贴出。
- 如实写明映射的漏检情况：例如由子代理代写、或从其他会话转交的任务，是否能被识别。

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
- tasks/session-task-flow-chain-status.md
