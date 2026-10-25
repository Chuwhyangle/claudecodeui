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

- [ ] `npx vitest run src/modules/notices/tests/NoticeSlot.test.tsx` 退出码 0；用例覆盖：多条目时只渲染 1 条完整条目且带「另有 N 条」折叠计数；blocking 排在 attention 前；blocking 无忽略按钮；点忽略调用 dismiss 并带当前 revision；dismiss 返回 409 时重新拉取而非报错（N2、N4）。
- [ ] 同一文件覆盖：主操作只打开确认面板，未点确认按钮时不发 `POST /api/system/deploy`（N7）。
- [ ] `npx vitest run src/modules/notices/tests/NoticeInbox.test.tsx` 退出码 0，已忽略项出现在收件箱的「已忽略」分组（N6）。
- [ ] `npx vitest run src/modules/notices/tests/i18nNoticesCompleteness.test.ts` 退出码 0，12 个 locale 的 `notices` 块 key 与占位符一致。
- [ ] `npx vitest run src/modules/cockpit/tests/DeployReadiness.test.tsx` 退出码 0（驾驶舱页的完整形态与确认面板行为不变；原先断言 `compact` 形态的用例随该形态下线而删除或改写，完成记录里列出被删改的用例名）。
- [ ] 假形态：让 `NoticeSlot` 对 blocking 也渲染忽略按钮，blocking 无忽略按钮的用例必须变红；让它渲染全部条目而非 1 条，N4 用例必须变红（贴出两次变红输出，随后还原）。
- [ ] `grep -n "DeployReadiness" src/modules/project-workspace/WorkspaceMain.tsx` 零命中，`grep -n "NoticeSlot" src/modules/project-workspace/WorkspaceMain.tsx` 至少一处命中。
- [ ] `npm run typecheck` 与 `npx oxlint src/modules/notices src/modules/cockpit src/modules/project-workspace` 退出码 0。

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
