---
id: gap-chat-banners-paused-pending-signal-redesign
title: 暂停 Chat 页常驻状态 banner：摘掉 NoticeSlot 与 SessionTaskChain 的挂载（驾驶舱部署条与服务端
  notices 保留）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

决策出处：用户 2026-10-25 的明确指示。聊天页顶部现在有两类常驻文字 banner —— 部署状态（`WorkspaceMain` 经 `noticeSlot` 挂的 `NoticeSlot`，上线前的构建里是紧凑部署条）与会话任务链（`ChatInterface` 里的 `SessionTaskChain`）。它们与「当前会话直接相关、侵入性尽可能小」的原则相违：部署状态是应用级信息，与这次对话无关；两条都是占行的文字，手机上合计约 220px；且信息源重叠（两者都读同一对部署指纹）。用户决定为保障可用性先停用，待 quay tab 与驾驶舱明确哪些事务需要通知后，再整体设计 Chat 页的显示与交互。

本任务只做「停用」，不做重设计：
1. `src/modules/project-workspace/WorkspaceMain.tsx`：不再给 `ChatInterface` 传 `noticeSlot`，并删去对 `NoticeSlot` 的 import。
2. `src/modules/chat/ChatInterface.tsx`：不再渲染 `SessionTaskChain`（连同只为它服务的 `chainSessionId` 与 import）；`noticeSlot` 这个通用 prop 保留，调用方不传时不渲染任何东西。两处原位各留一行注释：暂停中，待 Chat 页信号设计定稿；注释里不要写出组件的 JSX 标签字面量（`<` 加组件名），以免干扰下面的 grep 判据。
3. 把变假的文件头注释改对：`src/modules/notices/index.ts`（不再说 `WorkspaceMain` 挂载它）、`src/modules/chat/SessionTaskChain.tsx`（不再说 `ChatInterface` 挂载它）。
4. 新增一条钉子测试 `src/modules/chat/tests/chatBannersPaused.test.ts`：读 `WorkspaceMain.tsx` 与 `ChatInterface.tsx` 的源码文本，断言其中没有 `NoticeSlot`、`SessionTaskChain`、`DeployReadiness` 的 JSX 挂载（形如 `<NoticeSlot`）；测试用文件系统读法并从 vitest 进程 cwd 解析路径（jsdom 下 `import.meta.url` 不是 file URL，仓库里其它读文件的测试同此）。

**明确保留，不得改动**：驾驶舱页 `CockpitPage.tsx` 里的完整部署条及其确认面板（「构建并重启」入口仍在）；服务端 `server/modules/notices/`、`user_notice_dismissals` 表与 `/api/notices` 路由（休眠，不删）；`NoticeSlot` / `NoticeInbox` / `SessionTaskChain` 组件及其各自测试文件（只是不再被挂载）。

<!-- dedup-ref -->相关但不同机制：`gap-notices-client-slot-replaces-compact-deploy-strip` 与 `session-task-flow-chain-status`（均已完成）交付了被摘掉的两处挂载，本任务不回滚它们，只摘挂载点。已用 task-granularity-advice 核对：Touches 与任何开放任务无重叠，决定 separate。

## AC

- [x] `npx vitest run src/modules/chat/tests/chatBannersPaused.test.ts` 退出码 0。
- [x] `grep -nE "<(NoticeSlot|SessionTaskChain|DeployReadiness)\b" src/modules/project-workspace/WorkspaceMain.tsx src/modules/chat/ChatInterface.tsx` 零命中，且 `grep -n "noticeSlot" src/modules/project-workspace/WorkspaceMain.tsx` 零命中。
- [x] 保留项仍在：`grep -n "<DeployReadiness" src/modules/cockpit/CockpitPage.tsx` 至少一处命中；`grep -n "/api/notices" server/index.ts` 至少一处命中；`ls server/modules/notices/index.ts src/modules/notices/NoticeSlot.tsx src/modules/chat/SessionTaskChain.tsx` 均存在。
- [x] 既有测试不弱化：`npx vitest run src/modules/chat/tests/SessionTaskChain.test.tsx src/modules/notices/tests/NoticeSlot.test.tsx src/modules/cockpit/tests/DeployReadiness.test.tsx` 退出码 0（一个文件一个文件地跑，不做多文件扇出以外的全量）。
- [x] 假形态：在 `ChatInterface.tsx` 里临时加回对 `SessionTaskChain` 的 JSX 挂载，钉子测试必须变红；在 `WorkspaceMain.tsx` 里临时加回 `<NoticeSlot />`，钉子测试必须变红（完成记录里贴出两次变红输出，随后还原）。
- [x] `npm run typecheck` 与 `npx oxlint src/modules/chat src/modules/notices src/modules/project-workspace` 退出码 0。

## DoD

UI 任务的真实落地标准（按仓库 UI 验证规则）：在隔离实例上（复制库改密码登录、关掉 residentRestore；隔离状态放在 repo 外；不得在 live :3001 上触发构建或重启）用 MCP 浏览器实际操作并截图存 `tmp/`，在完成记录里贴出：
1. 一个本会话发起过 quay 任务的真实会话页，且隔离实例的 checkout 处于「有未构建提交」状态（旧行为会显示部署条）：聊天页标题与第一条消息之间没有任何 banner；`browser_evaluate` 读到没有 `[data-testid="deploy-readiness"]` 且没有任务链条的节点。
2. 手机宽度视口（如 390×844）再截一张同样的页面，标题下方到第一行消息的间距回到无 banner 的状态。
3. 驾驶舱页：部署条仍在；点「构建并重启」只打开确认面板，不点确认，隔离实例上也不得真的重启。
存在可用场景时同时跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴 JSON 报告与检查点截图。仅有 jsdom 单元测试与源码 grep 不算落地。

## Completion record

实现提交在 `task/gap-chat-banners-paused-pending-signal-redesign`：
- `d89c36a43` feat(chat): pause standing status banners above the transcript
- `bb6a35b62` test(chat): pin the generic noticeSlot seam through the banner pause（构建后提交，使隔离实例的 checkout 处于「有未构建提交」状态）

AC 逐条读数：
1. `npx vitest run src/modules/chat/tests/chatBannersPaused.test.ts` → `Test Files 1 passed (1)` / `Tests 4 passed (4)`，exit 0。
2. `grep -nE "<(NoticeSlot|SessionTaskChain|DeployReadiness)\b" …/WorkspaceMain.tsx …/ChatInterface.tsx` 零命中（exit 1）；`grep -n "noticeSlot" …/WorkspaceMain.tsx` 零命中（exit 1）。
3. 保留项：`CockpitPage.tsx:1465: <DeployReadiness />`；`server/index.ts:1790: app.use('/api/notices', …)`；`server/modules/notices/index.ts`、`src/modules/notices/NoticeSlot.tsx`、`src/modules/chat/SessionTaskChain.tsx` 均存在。
4. 三个既有测试逐文件跑：SessionTaskChain 4 passed、NoticeSlot 9 passed、DeployReadiness 10 passed，均 exit 0。
5. 假形态（两次均变红，随后 `git checkout --` 还原，工作树回到干净）：
   - ChatInterface 临时加回任务链 JSX 挂载 → `assert.equal` received `["<SessionTaskChain","SessionTaskChain"]`，`Test Files 1 failed (1)` / `Tests 1 failed | 2 passed`，exit 1。
   - WorkspaceMain 临时加回 `<NoticeSlot />` → received `["<NoticeSlot","NoticeSlot"]`，`Tests 1 failed | 2 passed`，exit 1。
   还原后 `git status --short` 为空，钉子测试 4 passed。
6. `npm run typecheck` exit 0；`npx oxlint src/modules/chat src/modules/notices src/modules/project-workspace` exit 0（仅既有 warning，develop 同)。

DoD（隔离实例 :31745；复制库、`residentRestore started=0`；隔离 HOME/状态在 repo 外 `/data/scratch/yale/banner-paused-dod`；未触碰 live :3001）：
- 真实会话 `2b2457a6-2ebc-4cc9-80cf-4ac0f7d5a386`（「驾驶舱横幅通知机制」）`GET /api/quay/<project>/session-task-chain?sessionId=…` 返回 `counts.total=3`（edited 含本任务）——旧行为会渲染任务链；`/api/system/deploy-readiness` 返回 `status=pending-build`、`builtSha=d89c36a43…`、`headSha=bb6a35b62…`、`pendingCommits=1`——旧行为会渲染部署条。两条 banner 的来源都非空，缺席不是真空。
- 桌面 1280×900 与手机 390×844 的会话页：`browser_evaluate` 读到 `deployReadiness=0`、`sessionTaskChainAny=0`、`noticeInbox=0`，textarea 存在；`.chat-messages-pane` 的 top 等于 header 的 bottom（桌面 57/57、手机 45/45），即标题条到转录面板之间没有任何 banner 占位。截图：`tmp/banner-paused-dod/chat-desktop.png`、`tmp/banner-paused-dod/chat-mobile.png`，另有 `chat-desktop-top.png`/`chat-mobile-top.png` 与 `report.json`/`report-top.json`。
- 驾驶舱 `/cockpit`：`[data-testid="deploy-readiness"]` 存在，`data-status=pending-build`，文案「1 change not yet built / Build and restart」；点击 `[data-testid="deploy-action"]` 后 `[data-testid="deploy-confirm-panel"]` 出现（列出待生效提交 bb6a35b），未点 Confirm、未发部署请求；隔离实例 server pid 769035 前后不变且仍存活。截图：`tmp/banner-paused-dod/cockpit-desktop.png`、`tmp/banner-paused-dod/cockpit-confirm-panel.png`。
- 场景运行器：`node scripts/ui-scenario.mjs e2e/scenarios/cockpit-mode-switch.json …` 退出码 2（未能开始）：`selectProjectSession` 的 `getByText('claudecodeui', { exact: true }).first()` 命中一个零宽度的 display-name `<span>`（该实例侧栏项目行以路径形式渲染），点击等待 30s 超时；stderr 见 `tmp/banner-paused-dod/scenario-stderr.log`。这是运行器既有选择器与本机侧栏渲染的不匹配，非本任务改动引起；同一条「会话 ↔ 驾驶舱」路径已由上述一次性 Playwright 驱动覆盖。

## Touches

- src/modules/project-workspace/WorkspaceMain.tsx
- src/modules/chat/ChatInterface.tsx
- src/modules/notices/index.ts
- src/modules/chat/SessionTaskChain.tsx
- src/modules/chat/tests/chatBannersPaused.test.ts
- tasks/gap-chat-banners-paused-pending-signal-redesign.md
