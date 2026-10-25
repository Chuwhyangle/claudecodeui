---
id: gap-workspace-header-quay-pulse-trigger-and-session-popover
title: 工作区标题栏：Quay 迷你甘特图/脉冲条触发器 + 会话 task/goal popover（移动端 tab 下拉去文本）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-quay-session-mentions-and-lanes-only-readings
---
## Proposal

<!-- dedup-ref --> 数据层依赖 `gap-quay-session-mentions-and-lanes-only-readings` 提供的两条读数（`GET /api/quay/:projectId/lanes`、`GET /api/quay/:projectId/session-mentions`），见 frontmatter 的 depends_on。相关的已完成任务：`gap-quay-tab-drop-pulse-strip`（Quay tab 去掉脉搏条）与 cockpit 的 PulseStrip 实验；本任务是另一个位置（工作区标题栏）的另一种东西，不动 Quay tab，不动 cockpit，也不新造图形编码，只沿用 `LoopPulseGantt` 现有画法。

背景与已定决策（用户 2026-10-25 逐项确认）：对用 quay 驱动的项目，在工作区标题栏常驻一个迷你甘特图（窄屏为脉冲条），点击展开 popover，列出本会话正文提到过的 task / goal 及状态，并带一张大的甘特图和时间范围设置。

一、触发器（`data-testid="quay-pulse-trigger"`）
- 仅 `hasQuayConfig` 的项目渲染（即现有 `shouldShowQuayTab` 为真）；其它项目标题栏与现状完全一致，也不发任何 lanes 请求。所有 tab 上都显示。
- 两种形态，按 header 元素的实际宽度切换（不是视口宽度）：宽度不小于 960px 且非移动端为迷你甘特图 110×32（`data-variant="wide"`）；否则为脉冲条 43×32（`data-variant="narrow"`）。移动端（`isMobile`，视口小于 768px）恒为脉冲条，并同时把右侧「tab 下拉」按钮的文字去掉，只留图标与 chevron，补 `aria-label` 为活动视图名。位置：桌面在标题块与 tab 条之间，作为 header 自己的 flex 子项（不是塞进 tab 容器里，否则 tab 容器的 `max-w-full` 不会让位）；移动端在 tab 下拉按钮左侧。
- 画法完全沿用 `LoopPulseGantt`：5 条泳道虚线骨架（`text-border`，虚线 `2 2`），bar 用 `currentColor` 加同一份状态色类，lanes 为空也画骨架。lanes 读不到：只画骨架加右上角琥珀小点（`data-testid="quay-pulse-degraded"`，`text-amber-500`），不画 bar。
- 常态：透明背景、无边框，融入标题栏。点击态与现有控件一致：打开时 `bg-accent text-foreground`，hover 为 `hover:bg-accent hover:text-foreground`，键盘焦点 `focus-visible:ring-2 focus-visible:ring-primary/60`；不加自造描边。触发器带 `aria-haspopup="dialog"`、`aria-expanded`、`aria-label`。
- 数据：对 quay 项目轮询 lanes 读数，间隔 30 秒（对齐服务端 TTL），页面不可见时暂停，项目或窗口变化立即重取，慢响应不得覆盖新项目的视图（沿用 `useQuayStatus` 的 requestId 手法）。轮询状态由 quay 模块里的一个 memo 组件自己持有，30 秒一次的刷新不得重渲染 `WorkspaceHeader` 之外的父层（`WorkspaceMain`、`ChatInterface`）。

二、时间范围设置
- popover 里用 `LoopPulseGantt` 自带的窗口选择器（1/3/6/12h），默认仍为 3h，默认值不改。按项目存浏览器 localStorage（键含 projectId，如 `quay-pulse-window:<projectId>`），不跨设备、不写服务端；缺省或非法值回落 3。触发器与 popover 的甘特图读同一个值。
- 没有「应用范围」开关，也没有「在标题栏显示」开关。Quay tab 现有的窗口持久化（URL 参数 `quayWindow`、`useQuayStatus`）一律不动，二者互不影响。

三、popover（`data-testid="quay-pulse-popover"`）
- 根节点 `role="dialog"`：这是 `ChatInterface` 全局 Escape 守卫读取的浮层选择器之一，开着时按 Escape 只关 popover，不中断正在跑的回合。Escape、点击外部都关闭，关闭后焦点回到触发器。
- 几何：桌面宽度为 `min(54.25rem, header 宽 − 16px)` 并在主区内水平居中（与 transcript 栏 `max-w-[54.25rem]` 对齐，实测 868px）；移动端为视口宽 − 16px；top 为 header 下沿 + 4px。最大高度桌面 `min(85vh, 760px)`，移动端 `100vh − top − 8px`。
- 容器类沿用 `WorkspaceMenu` 面板：`fixed z-[70] flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl`。
- 上部固定块：小标题「Loop pulse」加 `LoopPulseGantt`（含窗口选择器与 `+N more` 溢出徽标；lanes 读不到时用它自带的 unavailable 文案）。桌面上这张图约 836px 宽，比 Quay tab 里的约 552px 大。
- 下部列表区（`overflow-y-auto overscroll-contain`，自身不带内边距类）：Goals、Tasks 两个分区，每个分区各自包一层容器（互为兄弟节点），分区标题 `sticky top-0 bg-popover` 并带计数——两个吸顶标题若在同一个滚动容器的直接子级里会互相叠住，所以必须分层；滚动容器自带内边距会在吸顶标题上方漏出一条缝，所以内边距放到分区容器上。底部渐变提示（`pointer-events-none` 加 `hsl(var(--popover))` 渐变）仅在下方还有内容时显示，不画顶部渐变。
- Goals 行沿用 Quay tab 的 Stage goals 卡：等宽 id、大写状态、标题（桌面单行省略，移动端最多 2 行）、状态不是 achieved 才画 `h-1.5 bg-muted` 的进度条（`data-testid="quay-pulse-goal-bar"`，沿用 `GOAL_STATUS_PERCENT`）；附注「via N tasks」或「mentioned in a message」。
- Tasks 行沿用 in-flight 卡片的状态徽标 `rounded px-1.5 py-0.5 text-[10px] font-medium`：在飞相位的色类沿用 `IN_FLIGHT_PHASE_META`；非在飞的任务状态用同样的 `bg-X-50 text-X-700 dark:bg-X-950 dark:text-X-300` 写法（needs-human 琥珀、ready 与 todo 蓝、done 绿、superseded 为 `bg-muted text-muted-foreground`）。id 用 `font-mono text-[11px]`，允许换行不截断；副行为 goal id 加「Mentioned N min ago」。排序：在飞与需处理的在前，其余在后；`done` 与 `superseded` 归入默认折叠的「Done · N」分组（`data-testid="quay-pulse-done-toggle"`，点击展开）。
- 行点击与底部「Open Quay panel」都只切到 Quay tab（本版不做聚焦到具体任务）；底部按钮在滚动区之外固定。
- 状态：加载中；空（`data-testid="quay-pulse-empty"`，「No quay tasks have been mentioned in this session yet.」，甘特图仍显示）；列表读取失败（`data-testid="quay-pulse-list-error"`，甘特图不受影响）；lanes 读不到（触发器降级；列表仍可用但行退回任务库里的普通状态、无相位，列表上方一行琥珀说明 `data-testid="quay-pulse-lanes-note"`）。
- 列表在 popover 打开时取一次（`session-mentions`），再次打开重取；不轮询。
- 暗色：只用主题 token 与成对的 `dark:` 类，不写死颜色。文案进全部 12 个语言包。

四、模块边界与复用
- 新组件放 `src/modules/quay/`，经 `@/modules/quay` 的 barrel 只导出一个公开入口；`WorkspaceHeader` 只经 barrel 引用；quay 不得反向导入 `project-workspace`，「打开 Quay 面板」以回调传入。类型放 `src/shared/types.ts`（服务端响应的镜像），端点放 `src/shared/api.ts`，hooks 放 `src/modules/quay/hooks/`。
- 状态色映射、在飞相位元数据、goal 进度百分比目前是 `LoopPulseGantt.tsx` 与 `QuayPanel.tsx` 各自私有的常量：为复用需把它们提到共用位置（按 frontend-module-standards 的常量放置规则），原处改为引用，不得复制一份。

不做：服务端；Quay tab 的窗口选择器与 URL 参数；cockpit 的 PulseStrip；行点击聚焦任务；列表过滤框；goal 过多时的折叠（本版全部列出，靠滚动）。

非规范参考（不在仓库里，仅主检出可读）：已确认的效果图 `/data/home/yale/work/claudecodeui/tmp/mock-w4-board-desktop.png`、`/data/home/yale/work/claudecodeui/tmp/mock-w4-board-mobile.png`。

## AC

- [ ] 显隐：`npx vitest run src/modules/quay/tests/SessionPulse.test.tsx src/modules/project-workspace/tests/workspaceTabsResponsive.test.tsx` exit 0；含用例：`shouldShowQuayTab` 为假时标题栏里没有 `quay-pulse-trigger`，且 lanes 请求桩零次调用；为真时桌面与移动端都渲染。
- [ ] 形态切换：同一测试文件含用例，用 ResizeObserver 桩驱动 header 宽度：1000 为 `data-variant="wide"`（宽 110），959 为 `narrow`（宽 43），移动端任何宽度都为 `narrow`。取假：把判据改成视口宽度 768，959 这一例必须红。
- [ ] 常态与点击态：触发器常态 className 不含 `border` 与 `bg-accent`，打开态含 `bg-accent`；带 `aria-haspopup="dialog"`、`aria-expanded` 随开合切换、非空 `aria-label`；键盘焦点类为 `focus-visible:ring-2` 加 `ring-primary/60`。
- [ ] 画法同源：同一份 lanes 分别渲染 `LoopPulseGantt` 与触发器，逐状态（completed、failed、timed-out、fan-in）比较 bar 的状态色类相等；lanes 为空仍有 5 条骨架线；lanes 为 null 时有骨架与 `quay-pulse-degraded`、无 bar。
- [ ] 按项目存窗口：切换窗口写 localStorage 的 `quay-pulse-window:<projectId>`；换项目读回各自的值；缺省 3，`5` 与 `abc` 回落 3；整个过程不调用任何服务端保存接口；`git diff --stat -- src/modules/quay/hooks/useQuayStatus.ts` 无输出，`npx vitest run src/modules/quay/tests/QuayPanel.test.tsx src/modules/quay/tests/LoopPulseGantt.test.tsx` exit 0。
- [ ] 轮询：用假定时器：30 秒一次，页面不可见时暂停、恢复后立即补一次；切项目后先前请求的慢响应被丢弃；父组件包一层渲染计数器，连续 3 次轮询后父层渲染次数不变。
- [ ] popover 几何与风格：用例断言根节点 `role="dialog"`，className 含 `rounded-xl border border-border bg-popover` 与 `shadow-xl`；桌面宽度等于 `min(868, header 宽 − 16)` 且水平居中，移动端等于视口宽 − 16；内含 `quay-gantt` 与窗口选择器；选择窗口后触发器与 popover 的甘特图同步变化；Goals 与 Tasks 两个分区容器互为兄弟节点、标题与各自的行在同一容器内，列表区元素的 className 不含 `p-`、`px-`、`py-` 内边距类。
- [ ] 行与徽标：对同一相位，popover 的任务徽标 className 与 `QuayPanel` in-flight 行的徽标 className 相等（逐相位比较 implementing、fan-in、awaiting land、landed）；goal 行状态不是 achieved 才有 `quay-pulse-goal-bar`，achieved 没有；排序为在飞与需处理在前；`done` 与 `superseded` 默认折叠在「Done · N」下，点击后展开并显示全部。
- [ ] 四种状态：加载中、空、列表读取失败、lanes 读不到各有断言：空态甘特图仍在；列表读取失败时甘特图仍在；lanes 读不到时列表仍渲染、行没有相位徽标、出现 `quay-pulse-lanes-note`。
- [ ] 取数时机：popover 未打开时不调用 `session-mentions`；打开时恰好调用一次，关闭再打开调用第二次；打开期间不轮询它。
- [ ] 关闭与 Escape：`src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx` 新增用例：popover 打开且焦点在 composer 时按 Escape，不触发 abort、popover 关闭；popover 未打开时仍触发 abort（原用例保持）。取假：去掉 popover 根节点的 `role="dialog"`，该例必须红。点击外部关闭、关闭后焦点回到触发器各有断言。
- [ ] 移动端 tab 下拉：`workspaceTabsResponsive.test.tsx` 更新：触发器无可见文本（`textContent` 去空白后为空），`aria-label` 含活动视图名，原有 `accessibleName(trigger).includes('Chat')` 与 `aria-haspopup`、`aria-expanded` 断言不变，选中视图、Escape、点击遮罩的原用例保持通过；`data-workspace-tab` 与 `aria-current` 契约不变。
- [ ] 语言包：`npx vitest run src/modules/project-workspace/tests/i18nQuayTabCompleteness.test.ts` exit 0，其中新增断言覆盖全部 12 个语言包都含本任务新增的每个 `quayPulse.*` 键，占位符与英文一致，取值不是键名本身。
- [ ] 模块边界与不复制：`git grep -n "@/modules/project-workspace" -- src/modules/quay` 无输出；`git grep -nE "@/modules/quay/" -- src/modules/project-workspace` 无输出；新增组件文件里没有十六进制或 rgb 字面颜色（`git grep -nE "#[0-9a-fA-F]{3,8}[^0-9a-fA-F]|rgb\(" -- src/modules/quay/SessionPulse.tsx src/modules/quay/SessionPulsePopover.tsx src/modules/quay/hooks/useSessionPulse.ts` 无输出）。
- [ ] 类型与静态检查：`npx tsc --noEmit -p tsconfig.json` exit 0，`npx oxlint src/modules/quay src/modules/project-workspace src/shared` exit 0。

## DoD

真实页面验证（AGENTS.md「UI 验证」）：隔离实例（`scripts/isolated-instance.sh`，按记忆关 residentRestore、把已 seed 的库拷进去再起）里用 MCP 浏览器在真实 quay 项目上亲手走一遍，截图存 `tmp/` 并贴出：(1) 视口 1440×900：header 不小于 960 宽，迷你甘特图 110px 的常态与展开；(2) 视口约 1100×900（侧栏常驻，header 小于 960）：脉冲条 43px；(3) 视口 390×844：tab 下拉去文本、脉冲条、展开；(4) 暗色各一张。用 `browser_evaluate` 贴读数：触发器 `data-variant` 与宽度；popover 与 transcript 栏的 `getBoundingClientRect`（桌面应几乎重合）；常态触发器的计算样式无边框、背景透明。选一个有提及的真实会话看到 Goals 与 Tasks 两个分区，再选或构造一个不少于 25 个任务的长会话，滚到中段贴吸顶标题位置读数（标题顶边为 0）与底部渐变。Escape 的探查只在空闲会话上做（正在跑的会话上按 Escape 会中断回合）。常态与展开态逐项对照上面的参考效果图，不一致处在 DoD 里逐条说明。若有可用场景，同时跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴 JSON 报告。另外 `npm run build:client` 与 `npm run typecheck` 与 `npm run lint` 均 exit 0。

## Touches

- src/modules/quay/SessionPulse.tsx (new)
- src/modules/quay/SessionPulsePopover.tsx (new)
- src/modules/quay/hooks/useSessionPulse.ts (new)
- src/modules/quay/LoopPulseGantt.tsx
- src/modules/quay/QuayPanel.tsx
- src/modules/quay/index.ts
- src/shared/constants.ts
- src/shared/types.ts
- src/shared/api.ts
- src/modules/project-workspace/WorkspaceHeader.tsx
- src/modules/project-workspace/WorkspaceTabs.tsx
- src/modules/i18n/locales/*/common.json
- src/modules/quay/tests/SessionPulse.test.tsx (new)
- src/modules/project-workspace/tests/workspaceTabsResponsive.test.tsx
- src/modules/project-workspace/tests/i18nQuayTabCompleteness.test.ts
- src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx
- tasks/gap-workspace-header-quay-pulse-trigger-and-session-popover.md
