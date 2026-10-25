---
id: gap-quay-tab-status-band-charts-session-first-layout
title: Quay tab 优先级重排：整体状态横带 + 三张时间图 + 本会话在前，其余详情降级；窗口设置改为按项目独立存储、取代 URL 参数
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-quay-snapshot-loop-status-version-drain-orphan
---
## Proposal

<!-- dedup-ref --> 数据层依赖 `gap-quay-snapshot-loop-status-version-drain-orphan` 提供的 snapshot `loop` 字段（见 frontmatter 的 depends_on）。相关的已完成任务：`gap-workspace-header-quay-pulse-trigger-and-session-popover`（标题栏触发器与 popover，本任务要复用它的列表组件）与 `gap-quay-tab-drop-pulse-strip`（Quay tab 先前去掉了顶部脉搏条，本任务不恢复它，也不造新的图形编码）。没有同机制的在飞任务。

背景与已定决策（用户 2026-10-25 逐项确认）：用户每次打开 Quay tab 优先看的是 Loop pulse、Tests、Fan-in 这三张图和 loop 整体是否健康；其次是与当前会话相关的任务和 goal；其它详情优先级最低。现状相反：顶部只有一个小的 `Driver running` 徽标，主体是两列网格里的 Task ledger、Stage goals、Loop pulse、Tests、In flight、Fan-in 等全局内容，没有任何与当前会话相关的东西，三张图还分处左右两列、时间轴对不齐。

一、版面（三层）
- 第 1 层上半：整体运行状态横带（新组件 `QuayStatusBand`，`data-testid="quay-status-band"`），一条紧凑横带，始终在最上。内容全部来自 snapshot，只用现有的状态点、徽标和调色板，不造新编码：driver 状态（运行、空闲、停滞、不可用，沿用现有 driver 状态配色）；loop 版本偏差（来自 `loop.kernel.relation`：`behind` 琥珀色并显示「已加载 X → 已安装 Y」，`ahead` 同样标出，`not-evaluated` 灰色且不下任何结论）；插件版本目录孤儿预警（来自 `loop.orphan`：`marked` 时显示「Plugin version removed in N days」，`removeAfter` 已过则显示已超期，其它状态不显示）；drain 状态（`loop.drain` 任一为 true 时显示 `draining` 并列出是哪些 driver）；`.quay/plugin` 指针偏差（来自 `loop.pointer`，只在偏离时显示）；在飞数量及各相位小点（沿用 `IN_FLIGHT_PHASE_META` 的配色）；needs-human 数与 ready 数（来自 `tasks`）；suite 状态与时间（来自 `tests`）；最近心跳的相对时间，超过现有的陈旧阈值时标红。`loop` 缺失（旧服务端）时横带不显示版本、drain、孤儿三类信息，也不得显示任何「正常」字样。
- 第 1 层下半：时间图区（`data-testid="quay-tab-charts"`）：把现有的三张卡片原样搬来，按 Loop pulse、Tests、Fan-in 的顺序叠成一列，同一容器、同一宽度、共用同一个窗口，时间轴因共用 `chartGeometry` 而对齐。三张卡片的内部内容、画法、`data-testid`（`quay-panel-loop-pulse`、`quay-panel-tests`、`quay-panel-fanin`）一律不变，只是位置从下方网格移出，不得在页面上重复出现。窗口选择器仍是 Loop pulse 卡片自带的那个。
- 第 2 层：本会话面板（新组件 `QuaySessionPanel`，`data-testid="quay-session-panel"`），与时间图区并排：桌面（`lg` 及以上）左侧时间图区约 60%、右侧本会话面板约 40%，面板内部可滚动；`lg` 以下上下堆叠，时间图区在前。时间图区在桌面不通栏，因为甘特图高度随宽度缩放，通栏约 1100px 时会高到约 195px，约 650px 宽时约 115px，与现有观感接近。
- 第 3 层：其余详情（`data-testid="quay-tab-details"`）：Task ledger、Stage goals、In flight 卡片、driver 明细行与配置问题、警告、项目尾注，保持现有的两列网格，放在第 1、2 层之下。移动端（`isMobile`）下每张卡片包进 `Collapsible`，默认折叠，标题行带计数；桌面保持展开。需要给 `QuayPanel` 加一个可选属性（折叠开关），由 `WorkspaceMain` 用其已有的 `isMobile` 传入，`QuayPanel` 自己不判断设备。

二、本会话面板的内容
- 「本会话提到的任务与 goal」：与标题栏 popover 完全同一份数据与同一套行组件（Goals、Tasks 两个分区，Tasks 行用状态徽标，goal 行沿用 Stage goals 的样式，`Done` 默认折叠）。把 `SessionPulsePopover.tsx` 里的行与分区展示部分抽成共用的展示组件，popover 与本面板都引用它，不得复制一份。数据用现有的 `api.quaySessionMentions`。
- 「本会话发起的任务」：服务端已有 `GET /api/quay/:projectId/session-task-chain`（读本会话创建或编辑过的任务及其阶段：filed、ready、in-progress、landed、built、running、blocked、needs-human、superseded、unknown）。在 `src/shared/api.ts` 增加对应的请求函数；它的响应类型目前定义在聊天模块的 `SessionTaskChain.tsx` 里，需要上移到 `src/shared/types.ts`，聊天组件改为从共享类型导入（只改类型导入，该组件的行为与它的测试保持不变，其挂载目前暂停）。每行显示任务 id、标题、阶段徽标，阶段为 blocked 时显示未落地原因的首行。
- 取数：面板挂载（即 Quay tab 激活）时取一次，之后 30 秒一次，页面不可见时暂停，随面板的 Refresh 按钮一起刷新；会话或项目变化时丢弃先前请求的慢响应。放在新 hook `useSessionQuay`（`src/modules/quay/hooks/`）里。
- 状态要如实：未选会话时显示「No session selected」；没有提及时显示「No quay tasks have been mentioned in this session yet.」；两个分区各自独立报错，互不影响；`session-task-chain` 返回 503 或 404 时只隐藏「本会话发起的任务」这一块并说明原因；列表读取失败时其它部分照常显示。
- 需要 `WorkspaceMain` 把当前会话 id 传给 `QuayPanel`（新增可选属性 `sessionId`）。

三、窗口设置（用户裁定：不与标题栏 popover 共用，取代现有 URL 参数）
- Quay tab 的窗口按项目存浏览器 localStorage，键为 `quay-tab-window:<projectId>`，与 popover 使用的 `quay-pulse-window:<projectId>` 是两份互不影响的设置（此处按字面理解用户的话：不共用同一份，且取代 `quayWindow` URL 参数）。默认仍为 3，只接受 1、3、6、12，其它值回落到 3。
- `useQuayStatus` 完全不再读写 URL 参数 `quayWindow`（带 `?quayWindow=6` 的旧链接被忽略，选窗口后地址栏不变）；窗口值随 `projectId` 切换而重新读取各项目自己的值，不得沿用上一个项目的值。窗口选择器、`ganttRefreshing`、选窗口后原地重读而不闪空面板等现有行为不变。该 hook 的另一个使用者是 cockpit（它只用 `view` 与 `refresh`），其行为不得改变。

四、边界
- 新组件都放 `src/modules/quay/`；`project-workspace` 只经 `@/modules/quay` 的 barrel 引用；quay 不得反向导入 `project-workspace`。类型放 `src/shared/types.ts`（含服务端 `QuayLoopStatus` 的镜像），请求放 `src/shared/api.ts`。
- 文案全部进 12 个语言包（`locales/*/common.json`，键用 `quayTab.*`），沿用 `i18nQuayTabCompleteness` 的完整性检查并扩展。
- 暗色只用主题 token 与成对的 `dark:` 类，不写死颜色。
- 不做：标题栏 popover 的行为；点击任务行定位到 Quay tab 内某个任务（popover 的「Open Quay panel」仍只切换到 Quay tab）；Quay tab 内的列表过滤框；服务端。

注意：`e2e/zz-quay-panel-mobile-grid.spec.ts` 钉着旧的网格版面，需要随新版面更新；该规格在任务 worktree 里会因 `.quay/plugin` 不存在而红，这不是本任务的回归，处理办法见记忆「mobile-grid e2e 在 worktree 双红」（仿 `resolveQuayPlugin` 解析插件目录）。

## AC

- [ ] 版面顺序：`npx vitest run src/modules/quay/tests/QuayPanel.test.tsx` exit 0；新增用例对一份已加载快照断言 DOM 顺序为 `quay-status-band`、`quay-tab-charts`、`quay-session-panel`、`quay-tab-details`，且 `quay-tab-charts` 与 `quay-session-panel` 是同一个父容器的兄弟、该父容器在 `lg` 下为两列、`lg` 以下为单列（以 className 断言）。
- [ ] 三图搬位不重复：同一测试文件含用例：`quay-tab-charts` 内恰含 `quay-panel-loop-pulse`、`quay-panel-tests`、`quay-panel-fanin` 三个区块且顺序如此、位于同一个单列容器内；这三个 testid 以及 `quay-panel-task-ledger`、`quay-panel-stage-goals`、`quay-panel-inflight` 在页面上各恰出现一次，后三者位于 `quay-tab-details` 内；三张卡片内部原有的全部 `data-testid` 保持不变（既有断言不改即通过）。
- [ ] 横带内容与诚实性：新增 `src/modules/quay/tests/QuayStatusBand.test.tsx`，`npx vitest run src/modules/quay/tests/QuayStatusBand.test.tsx` exit 0：driver 四种状态各有断言；`loop.kernel.relation` 为 `behind`、`ahead`、`not-evaluated` 时分别显示偏差、超前、灰色无结论；`loop.orphan` 为 `marked` 时按注入的时钟显示剩余天数、`removeAfter` 已过时显示已超期，`none`、`not-applicable`、`not-evaluated` 时不显示孤儿预警；`loop.drain` 任一为 true 时显示 draining 并列出 driver；`loop.pointer` 仅在偏离时显示；在飞数与相位小点配色与 `IN_FLIGHT_PHASE_META` 一致；needs-human 数、ready 数、suite 状态、心跳相对时间及陈旧标红；`loop` 缺失或为 null 时不出现版本、drain、孤儿三类元素，也没有任何表示「正常」的文字。取假：把 `loop` 缺失默认成「版本一致」，对应用例必须红。
- [ ] 本会话面板：新增 `src/modules/quay/tests/QuaySessionPanel.test.tsx`，`npx vitest run src/modules/quay/tests/QuaySessionPanel.test.tsx` exit 0：用桩 API 断言「提到的任务与 goal」与「发起的任务」两块各自渲染；未选会话、无提及、两个分区各自读取失败、`session-task-chain` 为 503 或 404（只隐藏发起块并说明原因）各有断言且互不影响；挂载取一次、之后 30 秒一次（假定时器）、页面不可见时暂停、Refresh 触发重取、会话或项目切换后慢响应被丢弃。
- [ ] 复用不复制：`git grep -n "function TaskRow" -- src/modules/quay` 至多一处定义，`SessionPulsePopover.tsx` 与 `QuaySessionPanel.tsx` 都从同一个共用展示组件引用行与分区；`npx vitest run src/modules/quay/tests/SessionPulse.test.tsx` exit 0 且该文件中既有断言未被削弱。
- [ ] 第 3 层折叠：同一 `QuayPanel.test.tsx` 含用例：传入折叠开关时 `quay-tab-details` 内每张卡片被 `Collapsible` 包住、默认折叠、触发器带 `aria-expanded` 且可用键盘切换、标题行带计数；未传开关时全部展开；折叠与展开不改变卡片内部 testid 与内容。
- [ ] 窗口设置：同一 `QuayPanel.test.tsx` 里原先钉住 URL 行为的用例改写为：写入与读取 `quay-tab-window:<projectId>`；默认 3，`5` 与 `abc` 回落 3；切换 `projectId` 重渲染后读到各项目自己的值；设置 `?quayWindow=6` 后窗口仍为 3、选择窗口后 `window.location.search` 不变；修改 Quay tab 的窗口不写 `quay-pulse-window:` 键、修改 popover 的窗口不改变 `quay-tab-window:` 键（两个方向都断言）；选窗口原地重读而面板不闪空、`ganttRefreshing` 行为不变。
- [ ] cockpit 不受影响：`npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0，且 `git diff --stat -- src/modules/cockpit` 无输出。
- [ ] 类型与请求：`src/shared/api.ts` 含会话任务链的请求函数；`SessionTaskChain` 响应类型只在 `src/shared/types.ts` 定义，聊天组件改为从那里导入：`npx vitest run src/modules/chat/tests/SessionTaskChain.test.tsx` exit 0 且 `git diff --stat -- src/modules/chat/tests/SessionTaskChain.test.tsx` 无输出。
- [ ] 语言包：`npx vitest run src/modules/project-workspace/tests/i18nQuayTabCompleteness.test.ts` exit 0，其中新增断言覆盖 12 个语言包都含本任务新增的每个 `quayTab.*` 键，占位符与英文一致，取值不是键名本身。
- [ ] 模块边界与主题：`git grep -n "@/modules/project-workspace" -- src/modules/quay` 无输出；`git grep -nE "@/modules/quay/" -- src/modules/project-workspace` 无输出；新增组件文件里没有十六进制或 rgb 字面颜色（`git grep -nE "#[0-9a-fA-F]{3,8}[^0-9a-fA-F]|rgb\(" -- src/modules/quay/QuayStatusBand.tsx src/modules/quay/QuaySessionPanel.tsx src/modules/quay/hooks/useSessionQuay.ts` 无输出）。
- [ ] e2e 规格更新：`e2e/zz-quay-panel-mobile-grid.spec.ts` 更新为新版面（移动端三层顺序、第 3 层默认折叠、桌面两列），`npx tsc --noEmit -p tsconfig.json` exit 0 且 `npx oxlint e2e` exit 0；实际运行在 DoD 里做。
- [ ] 类型与静态检查：`npx tsc --noEmit -p tsconfig.json` exit 0，`npx oxlint src/modules/quay src/modules/project-workspace src/modules/chat src/shared` exit 0。

## DoD

真实页面验证（AGENTS.md「UI 验证」）：隔离实例（`scripts/isolated-instance.sh`，按记忆关 residentRestore、把已 seed 的库拷进去再起）里用 MCP 浏览器在真实 quay 项目的 Quay tab 上亲手走一遍，截图存 `tmp/` 并贴出：(1) 视口 1440×900：横带、左侧三图、右侧本会话面板、其下的第 3 层，常态与暗色各一张；(2) 视口约 1100×900（侧栏常驻）；(3) 视口 390×844：三层顺序与第 3 层默认折叠，展开其中一张。用 `browser_evaluate` 贴读数：四个区块的 DOM 顺序与各自的 `getBoundingClientRect`；三张图的绘图区左右边缘 x 坐标逐张相同（时间轴对齐，上一版因分处两列而对不齐）；本会话面板在一个有提及的真实会话里出现 Goals 与 Tasks，在一个没有提及的会话里出现空态；`localStorage` 里 `quay-tab-window:<projectId>` 随窗口选择改变、地址栏不含 `quayWindow`、popover 的 `quay-pulse-window:` 键不受影响。用真实的 loop 读数贴出横带：当前 loop 为 current，并用 `quay driver drain --kind worker` 再 `resume` 各截一次横带的 draining 状态。常态与展开态逐项对照上面的版面描述，不一致处在 DoD 里逐条说明。若有可用场景，同时跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴 JSON 报告；并运行更新后的 `e2e/zz-quay-panel-mobile-grid.spec.ts`（按上面的注意事项处理插件目录）贴出结果。另外 `npm run build:client`、`npm run typecheck`、`npm run lint` 均 exit 0。

## Touches

- src/modules/quay/QuayPanel.tsx
- src/modules/quay/QuayStatusBand.tsx (new)
- src/modules/quay/QuaySessionPanel.tsx (new)
- src/modules/quay/SessionTaskRows.tsx (new)
- src/modules/quay/SessionPulsePopover.tsx
- src/modules/quay/hooks/useQuayStatus.ts
- src/modules/quay/hooks/useSessionQuay.ts (new)
- src/modules/quay/index.ts
- src/modules/project-workspace/WorkspaceMain.tsx
- src/modules/chat/SessionTaskChain.tsx
- src/shared/types.ts
- src/shared/api.ts
- src/modules/i18n/locales/*/common.json
- src/modules/quay/tests/QuayPanel.test.tsx
- src/modules/quay/tests/QuayStatusBand.test.tsx (new)
- src/modules/quay/tests/QuaySessionPanel.test.tsx (new)
- src/modules/quay/tests/SessionPulse.test.tsx
- src/modules/project-workspace/tests/i18nQuayTabCompleteness.test.ts
- e2e/zz-quay-panel-mobile-grid.spec.ts
- tasks/gap-quay-tab-status-band-charts-session-first-layout.md
