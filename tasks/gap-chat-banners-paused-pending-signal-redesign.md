---
id: gap-chat-banners-paused-pending-signal-redesign
title: 暂停 Chat 页常驻状态 banner：摘掉 NoticeSlot 与 SessionTaskChain 的挂载（驾驶舱部署条与服务端
  notices 保留）
status: todo
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

- [ ] `npx vitest run src/modules/chat/tests/chatBannersPaused.test.ts` 退出码 0。
- [ ] `grep -nE "<(NoticeSlot|SessionTaskChain|DeployReadiness)\b" src/modules/project-workspace/WorkspaceMain.tsx src/modules/chat/ChatInterface.tsx` 零命中，且 `grep -n "noticeSlot" src/modules/project-workspace/WorkspaceMain.tsx` 零命中。
- [ ] 保留项仍在：`grep -n "<DeployReadiness" src/modules/cockpit/CockpitPage.tsx` 至少一处命中；`grep -n "/api/notices" server/index.ts` 至少一处命中；`ls server/modules/notices/index.ts src/modules/notices/NoticeSlot.tsx src/modules/chat/SessionTaskChain.tsx` 均存在。
- [ ] 既有测试不弱化：`npx vitest run src/modules/chat/tests/SessionTaskChain.test.tsx src/modules/notices/tests/NoticeSlot.test.tsx src/modules/cockpit/tests/DeployReadiness.test.tsx` 退出码 0（一个文件一个文件地跑，不做多文件扇出以外的全量）。
- [ ] 假形态：在 `ChatInterface.tsx` 里临时加回对 `SessionTaskChain` 的 JSX 挂载，钉子测试必须变红；在 `WorkspaceMain.tsx` 里临时加回 `<NoticeSlot />`，钉子测试必须变红（完成记录里贴出两次变红输出，随后还原）。
- [ ] `npm run typecheck` 与 `npx oxlint src/modules/chat src/modules/notices src/modules/project-workspace` 退出码 0。

## DoD

UI 任务的真实落地标准（按仓库 UI 验证规则）：在隔离实例上（复制库改密码登录、关掉 residentRestore；隔离状态放在 repo 外；不得在 live :3001 上触发构建或重启）用 MCP 浏览器实际操作并截图存 `tmp/`，在完成记录里贴出：
1. 一个本会话发起过 quay 任务的真实会话页，且隔离实例的 checkout 处于「有未构建提交」状态（旧行为会显示部署条）：聊天页标题与第一条消息之间没有任何 banner；`browser_evaluate` 读到没有 `[data-testid="deploy-readiness"]` 且没有任务链条的节点。
2. 手机宽度视口（如 390×844）再截一张同样的页面，标题下方到第一行消息的间距回到无 banner 的状态。
3. 驾驶舱页：部署条仍在；点「构建并重启」只打开确认面板，不点确认，隔离实例上也不得真的重启。
存在可用场景时同时跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴 JSON 报告与检查点截图。仅有 jsdom 单元测试与源码 grep 不算落地。

## Touches

- src/modules/project-workspace/WorkspaceMain.tsx
- src/modules/chat/ChatInterface.tsx
- src/modules/notices/index.ts
- src/modules/chat/SessionTaskChain.tsx
- src/modules/chat/tests/chatBannersPaused.test.ts
- tasks/gap-chat-banners-paused-pending-signal-redesign.md
