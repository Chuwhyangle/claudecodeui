---
id: gap-notices-client-slot-replaces-compact-deploy-strip
title: Notice 注册表 P1（客户端）：NoticeSlot 打断位（1 条 + 折叠计数 + 忽略）与 NoticeInbox，取代聊天页紧凑部署条
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-notices-server-registry-and-dismissal
---
## Proposal

出处：`docs/proposals/notice-registry-and-dismissal.md`（P1 的客户端半边，用户 2026-10-25 确认：打断位同时只显示 1 条加折叠计数，忽略状态存服务端）。聊天页顶部现在通过 `WorkspaceMain` 的 `noticeSlot={<DeployReadiness compact />}` 放一条部署 banner，它每 15 秒自己轮询、没有任何关闭办法。本任务用统一的 `NoticeSlot` 取代它，并提供收件箱视图让被忽略的条目仍可找回。

接口由 `gap-notices-server-registry-and-dismissal` 提供（已在 depends_on 声明）：`GET /api/notices` → `{ active, dismissed }`，`POST /api/notices/:id/dismiss` body `{ revision }`。

<!-- dedup-ref -->相关但不同机制：`deploy-readiness-build-and-safe-restart`（已完成）造了 `DeployReadiness` 与确认面板，本任务保留驾驶舱页里的完整形态与确认面板逻辑，只下线 `compact` 形态。已用 task-granularity-advice 核对：Touches 与任何开放任务无重叠，决定 separate（服务端与客户端是不同的交付物，且 UI 验证口径不同）。

做什么：
1. 新 `src/modules/notices/`（遵循 `$frontend-module-standards`）：`useNotices`（轮询 `GET /api/notices`，沿用 15 s）、`NoticeSlot`（打断位）、`NoticeInbox`（折叠展开后的列表，含已忽略项）、`index.ts` barrel、`tests/`。
2. `NoticeSlot` 规则：只渲染 `scope = global`、`severity ≥ attention`、未被忽略的条目；`blocking` 优先于 `attention`，同级按 `raisedAt` 新者优先；**任意时刻至多渲染 1 条完整条目**，其余以「另有 N 条」折叠计数，点开进入 `NoticeInbox`（N4）。非 blocking 条目有「忽略」按钮，调用 `POST /api/notices/:id/dismiss` 带当前 revision；blocking 条目不渲染忽略按钮（N2）。服务端返回 409（revision 已变）时静默重新拉取，不报错。
3. 主操作：部署条目的 `primaryAction`（「构建并重启」）只打开与 `DeployReadiness` 相同的确认面板，**必须点确认按钮才发 `POST /api/system/deploy`**（N7，保持「不接受语音的是」）。确认面板与执行逻辑从 `DeployReadiness.tsx` 复用，不复制一份。
4. `WorkspaceMain.tsx` 的 `noticeSlot` 改为 `<NoticeSlot />`；`DeployReadiness` 的 `compact` 形态与 `ChatInterface` 对它的说明注释下线，驾驶舱页的完整形态保持常驻且不受忽略影响。
5. 文案进 12 个 locale 的 `common.json`（`notices` 块：忽略、另有 N 条、收件箱标题、已忽略分组、各 `title` key），并仿 `i18nCockpitCompleteness.test.ts` 加一个覆盖 `notices` 块的完整性测试（key 与占位符 `{{n}}` 一致）。
6. 在 `src/shared/api.ts` 加 `api.notices.list()` 与 `api.notices.dismiss(id, revision)`。

## AC

- [x] `npx vitest run src/modules/notices/tests/NoticeSlot.test.tsx` 退出码 0；用例覆盖：多条目时只渲染 1 条完整条目且带「另有 N 条」折叠计数；blocking 排在 attention 前；blocking 无忽略按钮；点忽略调用 dismiss 并带当前 revision；dismiss 返回 409 时重新拉取而非报错（N2、N4）。
- [x] 同一文件覆盖：主操作只打开确认面板，未点确认按钮时不发 `POST /api/system/deploy`（N7）。
- [x] `npx vitest run src/modules/notices/tests/NoticeInbox.test.tsx` 退出码 0，已忽略项出现在收件箱的「已忽略」分组（N6）。
- [x] `npx vitest run src/modules/notices/tests/i18nNoticesCompleteness.test.ts` 退出码 0，12 个 locale 的 `notices` 块 key 与占位符一致。
- [x] `npx vitest run src/modules/cockpit/tests/DeployReadiness.test.tsx` 退出码 0（驾驶舱页的完整形态与确认面板行为不变；原先断言 `compact` 形态的用例随该形态下线而删除或改写，完成记录里列出被删改的用例名）。
- [x] 假形态：让 `NoticeSlot` 对 blocking 也渲染忽略按钮，blocking 无忽略按钮的用例必须变红；让它渲染全部条目而非 1 条，N4 用例必须变红（贴出两次变红输出，随后还原）。
- [x] `grep -n "DeployReadiness" src/modules/project-workspace/WorkspaceMain.tsx` 零命中，`grep -n "NoticeSlot" src/modules/project-workspace/WorkspaceMain.tsx` 至少一处命中。
- [x] `npm run typecheck` 与 `npx oxlint src/modules/notices src/modules/cockpit src/modules/project-workspace` 退出码 0。

## DoD

UI 任务的真实落地标准（按仓库 UI 验证规则）：在隔离实例上（复制库改密码登录、关掉 residentRestore，不得在 live :3001 上触发构建或重启），用 MCP 浏览器在真实聊天页走一遍并截图存 `tmp/`：未构建提交出现时顶部出现部署条 → 点「忽略」后消失 → 刷新页面仍隐藏 → 在隔离实例的 checkout 上新增一个触及 `src/` 的提交后重新出现 → 构造构建失败态时无忽略按钮 → 同时有两条以上时只显示 1 条并带折叠计数、展开后看到收件箱与已忽略分组 → 点「构建并重启」只打开确认面板（不点确认，隔离实例上也不得真的重启）。另存在可用场景时同时跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴 JSON 报告与检查点截图；失败步排查优先用 `browser_evaluate('window.__cloudcliScenario.read()')`。所有截图与报告贴进完成记录。仅有 jsdom 单元测试不算落地。

## Touches

- src/modules/notices/index.ts
- src/modules/notices/useNotices.ts
- src/modules/notices/NoticeSlot.tsx
- src/modules/notices/NoticeInbox.tsx
- src/modules/notices/tests/NoticeSlot.test.tsx
- src/modules/notices/tests/NoticeInbox.test.tsx
- src/modules/notices/tests/i18nNoticesCompleteness.test.ts
- src/shared/api.ts
- src/modules/project-workspace/WorkspaceMain.tsx
- src/modules/chat/ChatInterface.tsx
- src/modules/cockpit/DeployReadiness.tsx
- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/index.ts
- src/modules/cockpit/tests/DeployReadiness.test.tsx
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
- tasks/gap-notices-client-slot-replaces-compact-deploy-strip.md

## Notes（完成记录）

**单元测试**：`NoticeSlot.test.tsx` 9 例、`NoticeInbox.test.tsx` 3 例、`i18nNoticesCompleteness.test.ts` 4 例、`DeployReadiness.test.tsx` 10 例，全部通过（26 tests）；`npm run typecheck` 退出 0；`npx oxlint src/modules/notices src/modules/cockpit src/modules/project-workspace` 退出 0。

**假形态（随后均已还原）**：
- 让 `isDismissible` 对 blocking 也返回 true ⇒ `renders no dismiss button for a blocking entry` 变红：断言处收到 `<button data-testid="notice-dismiss">Dismiss</button>`（`expected null`）。
- 临时把 `others` 也渲染成 `notice-entry` ⇒ `renders exactly one entry and folds the remaining count` 变红：`expected [ <div …>, … ] to have a length of 1 but got 3`。

**被删改的 compact 用例**（`DeployReadiness.test.tsx`，describe `the session page compact form` 整段删除）：
- `renders nothing while the deployment is fresh`
- `renders the same sentence when the deployment is not fresh`
`renderStrip` 辅助函数同步去掉 `compact` 参数；其余状态文案、pending-build 计数、last deploy、failure tail、确认面板只发一次、cancel 不发等用例保持原样。`CockpitPage.tsx` 移动端的 `<DeployReadiness compact />` 分支随形态下线，改为常驻完整形态。

**DoD 真实页面验证**（隔离实例：worktree 的 tsx 后端 `:3199` + Vite `:5199`；全新隔离库注册 `dod` 用户、`SERVER_SETTINGS_PATH` 关 `residentRestore`；未触碰 live `:3001`，未点确认、未发 `POST /api/system/deploy`）：
- 截图存 `tmp/notice-dod/shots/`：`01-pending.png`（pending 部署条）→ `02-dismissed.png`（点忽略后从聊天页消失）→ `03-reload-still-hidden.png`（刷新仍隐藏，服务端 dismissal 持久）→ `04-reappeared-after-new-commit.png`（新增触及 `src/` 的提交后以新 revision 重新出现）→ `05-confirm-panel-no-deploy.png`（「构建并重启」只打开共享确认面板）→ `06-failure-blocking-no-dismiss.png`（构造 `lastDeploy.ok=false` 后 blocking 无忽略按钮）→ `07-multi-folded.png`（3 条只显示 1 条 +「2 more」）→ `08-inbox-with-dismissed.png`（收件箱 +「Dismissed」分组）。
- 结构化报告：`tmp/notice-dod/report.json`（每步 DOM 读数、`GET /api/notices` 的 active/dismissed、`pageErrors=[]`、`deployRequests=[]`）。
- N1 实测：忽略 revision `125167b…`；新增提交 `19b990e…` 后 `GET /api/notices` 的 active revision 变为 `19b990e…`（旧 revision 的忽略不再生效）。
- 多条目一步用 Playwright route 夹具呈现（P1 只注册一个部署 provider，真实服务端不可能同时产出两条 notice）：夹具 3 active + 1 dismissed，仅验证客户端折叠计数与收件箱渲染；其余各步均走真实服务端与真实 DB。
- `scripts/ui-scenario.mjs` 的 `open` 词汇表不覆盖聊天页/notices（无可用场景），故本次以真实服务端 + 一次性 Playwright 驱动完成，未跑场景运行器。
