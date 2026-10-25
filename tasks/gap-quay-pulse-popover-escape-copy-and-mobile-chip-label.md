---
id: gap-quay-pulse-popover-escape-copy-and-mobile-chip-label
title: 标题栏脉冲 popover 三处缺陷：Escape 被 composer 先吞、「via 1 tasks」与只按分钟计的相对时间、非 quay
  项目的移动端 tab 下拉被去掉文字
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 相关的已完成任务：`gap-workspace-header-quay-pulse-trigger-and-session-popover`（引入这个触发器与 popover，本任务修它真实页面验证里发现的三处缺陷，证据见主检出的 `tmp/b-verify-report.md`，非仓库文件）。在 `WorkspaceTabs.tsx` 等文件上与 `gap-architecture-compact-chrome-and-tab-tooltip`、`gap-quay-tab-status-band-charts-session-first-layout` 有 Touches 重叠，由调度器串行；三者验收独立，本任务不并入它们。

缺陷一：Escape 在 composer 获焦时第一次不关 popover（真实页面复现，刷新后第一次 Escape 无效，第二次才关）。
- 根因（用埋点抓到）：popover 的 Escape 监听挂在 `document` 的冒泡段，且要求 `!event.defaultPrevented`（`SessionPulsePopover.tsx` 里的 `handleKeyDown`）；composer 里 `useInputSuggestions` 的 React 处理器在更早的 React 根容器冒泡段对这次 Escape 调了 `preventDefault()` 与 `stopPropagation()`（它认为建议 chip 可见，`visible = chips.length > 0`，而界面上并没有画出 chip 条），所以 popover 的监听根本收不到。聊天页全局 abort 守卫在 document 捕获段，看到 `[role="dialog"]` 就放行，所以没有误中断回合，问题只是 popover 关不掉。
- 修法：popover 是最上层的层，Escape 应由它先处理。把监听挂到 `window` 的捕获段（与 `useComposerMenuAnchor` 同样的做法）：按下 Escape、事件未被别的层处理（`defaultPrevented` 为假）、也没有其它浮层（`[role="menu"]`、`[role="listbox"]`）开着时，关闭 popover，并 `preventDefault()` 加 `stopPropagation()`，不让 composer 的处理器与聊天页守卫再响应同一次按键；有其它浮层开着时不抢，交给那个浮层。关闭后焦点仍回到触发器（现有行为）。
- 不做：修 `useInputSuggestions` 里「状态认为 chip 可见而界面没画」的不一致，那是 chat 模块的另一个问题，另查。

缺陷二：文案。
- `quayPulse.viaTasks` 现为 `via {{count}} tasks`，数量为 1 时读成「via 1 tasks」。改用 i18next 的复数键：每个语言包按它自己的复数类别提供 `viaTasks_<类别>`（类别以 `Intl.PluralRules(语言).resolvedOptions().pluralCategories` 为准，例如英语 one 与 other，俄语 one、few、many、other，中日韩只有 other），仓库里已有 `_one`、`_other` 的先例（如 `refreshIn_one`）。
- `quayPulse.mentionedAgo` 固定写「Mentioned N min ago」，超过一天仍显示 `1755 min`。改为新键 `quayPulse.mentionedAt`（`Mentioned {{when}}`），`when` 取现成的 `formatRelativeTime(iso, i18n.language)`（`src/shared/utils.ts`，自动在秒、分、时、天、月、年之间换算），不新造格式化函数；提及时间略晚于当前时刻（时钟偏差）时按当前时刻处理，不得出现「in 5 minutes」。旧键 `mentionedAgo` 连同它在 12 个语言包里的条目一并删除，`quay-pulse-mentioned-ago` 这个 testid 保留。

缺陷三：移动端 tab 下拉在非 quay 项目里也被去掉了文字。
- 去文字是为了给脉冲条腾位置；非 quay 项目没有脉冲条，去文字没有任何收益，还让用户看不到当前视图名。`CollapsedWorkspaceSelector` 已经收到 `shouldShowQuayTab`：为假时恢复引入脉冲条之前的标记（可见文字用 `truncate` 的 span，按钮带 `max-w-[8rem]`），为真时保持现在的只留图标与 chevron。两种情形都保留 `aria-label`、`data-workspace-tab`、`aria-current`。组件里关于「可见文字没了」的注释同步改成只在 quay 项目成立。

不做：popover 的其它外观与行为；前端轮询；服务端。

## AC

- [ ] Escape 先于 composer：`npx vitest run src/modules/quay/tests/SessionPulse.test.tsx` exit 0；含用例，夹具是一个在 React `onKeyDown` 里对 Escape 调 `preventDefault()` 加 `stopPropagation()` 并计数的 textarea（与 `useInputSuggestions` 的做法同形）：popover 打开、焦点在该 textarea 时，只发一次 Escape，popover 关闭、夹具的处理器零次被调用、焦点回到触发器；对照一：popover 未打开时同一次 Escape 仍到达夹具处理器恰好一次；对照二：页面里有一个 `[role="listbox"]` 浮层时，Escape 不被 popover 抢走，popover 仍开着。取假：把监听改回 `document` 的冒泡段，第一例必须红。
- [ ] 聊天页守卫不退化：`npx vitest run src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx` exit 0，原有用例全部保留且通过；新增用例：popover 打开、焦点在 composer 的真实 textarea 上按一次 Escape，popover 关闭且不触发 abort。
- [ ] 复数：`SessionPulse.test.tsx` 含用例：英语下 `viaTasks` 数量为 1 渲染「via 1 task」、为 2 渲染「via 2 tasks」；`npx vitest run src/modules/project-workspace/tests/i18nQuayTabCompleteness.test.ts` exit 0，其中新增断言：对每个语言包，`Intl.PluralRules(该语言).resolvedOptions().pluralCategories` 里的每个类别都有对应的 `quayPulse.viaTasks_<类别>` 键，且取值含 `{{count}}`、不是键名本身；不得再保留不带类别后缀的 `quayPulse.viaTasks`。
- [ ] 相对时间：`SessionPulse.test.tsx` 含用例（用假时钟）：提及于 30 秒前、5 分钟前、3 小时前、29 小时前、3 天前，渲染文本都与 `formatRelativeTime` 对同一时刻给出的结果一致，其中 29 小时前的那一例文本不含 `min`；提及时刻比当前晚 5 分钟（时钟偏差）时文本不含 `in `；`quayPulse.mentionedAgo` 在 12 个语言包里都已不存在而 `quayPulse.mentionedAt` 都存在且含 `{{when}}`（同一个 i18n 完整性测试里断言）；`git grep -n "mentionedAgo" -- src` 无输出。
- [ ] 移动端 tab 下拉：`npx vitest run src/modules/project-workspace/tests/workspaceTabsResponsive.test.tsx` exit 0；含用例：移动端、`shouldShowQuayTab` 为假时触发器的可见文字（`textContent` 去空白）等于当前视图名、带 `truncate` 的 span、按钮 className 含 `max-w-[8rem]`；`shouldShowQuayTab` 为真时可见文字为空；两种情形 `aria-label` 都含当前视图名，`data-workspace-tab` 与 `aria-current` 不变；原有的选中视图、Escape、点击遮罩、焦点回到触发器的用例保持通过。
- [ ] 其余不变：`npx vitest run src/modules/quay/tests/SessionPulse.test.tsx src/modules/quay/tests/QuayPanel.test.tsx src/modules/quay/tests/LoopPulseGantt.test.tsx src/modules/project-workspace/tests/workspaceTabsResponsive.test.tsx` exit 0。
- [ ] 类型与静态检查：`npx tsc --noEmit -p tsconfig.json` exit 0，`npx oxlint src/modules/quay src/modules/project-workspace src/modules/i18n` exit 0。

## DoD

真实页面验证（AGENTS.md「UI 验证」）：隔离实例（`scripts/isolated-instance.sh`，按记忆关 residentRestore；用复制的库，在其中改语言不会碰到真实用户偏好）里用 MCP 浏览器亲手走一遍，截图存 `tmp/` 并贴出读数：(1) 一个空闲会话（不要选正在跑的会话，Escape 会中断回合）刷新页面后点开 popover，把焦点放进 composer，只按一次 Escape，贴出 popover 已关闭与焦点位置的读数，并说明改动前同样操作要按两次；(2) popover 里数量为 1 的 goal 行显示「via 1 task」；提及时间超过一天的任务行显示小时或天（用本项目里一个提及时间较早的长会话），再把界面语言切到 zh-CN 各看一张；(3) 390×844 视口下，非 quay 项目的 tab 下拉按钮显示视图名文字，quay 项目的只显示图标；(4) 暗色一张。若有可用场景，同时跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴 JSON 报告。另外 `npm run build:client` 与 `npm run typecheck` 与 `npm run lint` 均 exit 0。

## Touches

- src/modules/quay/SessionPulsePopover.tsx
- src/modules/project-workspace/WorkspaceTabs.tsx
- src/modules/i18n/locales/*/common.json
- src/modules/quay/tests/SessionPulse.test.tsx
- src/modules/project-workspace/tests/workspaceTabsResponsive.test.tsx
- src/modules/project-workspace/tests/i18nQuayTabCompleteness.test.ts
- src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx
- tasks/gap-quay-pulse-popover-escape-copy-and-mobile-chip-label.md
