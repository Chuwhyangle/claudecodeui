---
id: observation-wall-ui
title: 观察墙 T5：驾驶舱观察墙 UI（PC + 移动）——磁贴/观察列表/原地预览/已看到；并入两个走查任务中仍成立的条目
status: todo
labels:
  - cockpit
  - observation
  - ui
parent: null
children: []
extra: {}
depends_on:
  - observation-object-model-seen-cursor-and-delta
  - cockpit-entry-mode-switch-and-attention-badge
---
## Proposal

决策出处：2026-10-24 与用户确定的「观察墙」方案（驾驶舱首先是观察面）。依据：14 天负载分析（2159 条人类输入、相邻输入一半落在不同会话、切换中位间隔 2.4 分钟；只看不打字的切换未被记录，真实观察负载更高）；用户确认观察会话输出 / quay 状态 / 架构以及为此做的切换是最大负载。硬约束（quay references）：读数三态（取不到 = 未评估 + 原因，不得显示为绿）、每盏绿灯带活性时间戳、语义判断标注「仅建议」、驾驶舱本身比被治理对象小一个量级。

用户确认：打开预览即算「已看到」；墙上同时显示上限 12 块。本任务取代 `cockpit-walkthrough-interaction-defects` 与 `cockpit-mobile-layout-and-legibility`（二者已标 superseded），并入其中在新模型下仍成立的条目。

方案：
1. **驾驶舱首页改为观察墙**：三类磁贴（会话 / 项目 / 架构）按 T1 的墙排序；每块磁贴显示 状态（三态 + 活性时间）+ 答案优先的摘要 + 「自上次看过」差量计数；只有 attention/red 使用强调色。原项目网格降级为「全部项目」视图。
2. **观察列表**：磁贴与会话/项目行内操作均可「钉到观察墙 / 取消」；自动浮现的磁贴带「临时」标记。
3. **原地预览**：焦点落在磁贴上（方向键/序号/点击）舞台展开详情——会话：最近一轮全文与改动/测试；项目：五层真相与差量条目；架构：差分列表 + 「在架构 tab 中打开（高亮差异）」。打开预览即 `POST seen`；提供「稍后再看」（不前移游标）。会话详情里「在会话中打开」是唯一跳转到会话的入口。
4. **PC**：磁贴网格 + 右侧舞台；**移动**：单列磁贴，点开全屏预览，返回回到原滚动位置。两者同一模型。
5. 并入的走查条目：视图切换 push 浏览历史（浏览器后退回上一视图）；视图 URL 用 fleet 项目 id（旧 UUID 链接替换）；每次输入都有回声（做了 / 做不了+原因+下一步 / 待确认），前两类 3 秒后消失；状态条只显示人能读的信息，URI/首帧耗时/设备 id 只在 `?debug=1`；去掉 READ-ONLY；二维码收为「手机遥控」按钮；未登记项目收进折叠分组；最小字号 12px、文字对比度 ≥ 4.5、移动端可点元素 ≥ 44×44、底部栏实心背景且内容不被遮挡。
6. **渲染观察层自身的活性**：T1 返回的 `producers[]` 中任一非 ok 时，墙首位显示一块「观察层自身」磁贴（stale / red / 未评估 + 原因 + 最近一次运行时间），不受 12 块上限折叠；全部 ok 时不显示，只在页头以一个小字时间戳表示「各生产者最近更新」。
7. 「目标会话 / 发送到会话」不出现在主路径（保留代码，不展示）；手机遥控器冻结，不在本任务范围。

## AC

- [ ] AC1: `npx vitest run src/modules/cockpit/tests/ObservationWall.test.tsx` exit 0——桩墙数据渲染三类磁贴，状态三态与活性时间可见，unevaluated 显示原因而非绿；超过 12 块显示折叠数；打开预览调用 seen 恰好一次、「稍后再看」不调用；钉选/取消调用对应 API；自动浮现磁贴带临时标记。
- [ ] AC2: 同一测试文件——视图切换 history 长度加 1、同视图重复不加；视图 URL 用 fleet id、UUID 链接被替换；三类回声的出现与消失；默认状态条不含 `quay://`/first frame/设备 id，`?debug=1` 时含；页面不含 READ-ONLY；二维码默认不渲染；桩 `producers[]` 含一个 stale 生产者时墙首位出现「观察层自身」磁贴且不计入 12 块上限，全部 ok 时不出现。
- [ ] AC3: `npx playwright test e2e/cockpit-observation-wall.spec.ts` exit 0（在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 加条目并写明实测）——PC 与移动视口：无横向溢出；移动端可点元素 ≥ 44×44；文字对比度 ≥ 4.5、字号 ≥ 12px；最后一块磁贴可完全滚出且不与底部栏重叠；控制臂：把底部栏背景强制透明后重叠判定读红（主臂与控制臂共用同一读取函数）。
- [ ] AC4: `npm run typecheck` 通过；文案覆盖 12 个 locale 并扩展驾驶舱文案完整性测试。

## DoD

- - **浏览器实际操作 + 截图（必做，PC 1440×900 与移动 390×844 各一套）**，截图存 `tmp/`；场景运行器可用时补场景与报告（AGENTS.md「UI 验证」）。走查路径：钉选 2 个会话、2 个项目、1 个架构视图 → 从会话页经模式切换进入驾驶舱 → 方向键浏览磁贴并预览 → 确认差量清零 → 浏览器后退回上一视图 → 移动端同一路径。
- 对照 P0（T0）周报说明：本任务上线前后观察型切换的变化（若 T0 数据尚不足一周，如实写明）。
- - 隔离实例验证必须关闭常驻会话恢复（`SERVER_SETTINGS_PATH` 指向含 `{"residentRestore":{"enabled":false}}` 的文件，或使用 T7 的隔离实例脚本），否则会对线上同一批会话重复起进程。

## Notes

### 可复用的已有实现（来自被取代的 cockpit-walkthrough-interaction-defects）

该任务的 worker 在被叫停前已完成实现，6 条 AC 测试与 typecheck 在其 worktree 中全绿，PC 端 DoD 走查完成（needs-human 置顶、「第一个」聚焦、无目标卡片列出候选会话、钉选后预览、Back 回 fleet），未提交。改动另存为：
- `tmp/superseded/cockpit-walkthrough-interaction-defects.patch`（主检出下 gitignored，27 个文件，+1452/−146，基于其分支 HEAD `6dc699ee2`）
- 走查截图：`tmp/superseded/cockpit-dod/`
其中**仍可直接沿用**的部分：视图切换 push 历史、URL 用 fleet id、回声 / 原因提示、遥控器无目标时禁用确认、reducer 中无焦点 zoom 的原因提示。**不再沿用**：以目标会话为中心的无目标卡片与钉选流程（目标会话已降级，不在主路径）。按需挑选，不要整体 apply。

## Touches

- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/CockpitStage.tsx
- src/modules/cockpit/ObservationWall.tsx
- src/modules/cockpit/ObservationTile.tsx
- src/modules/cockpit/ObservationPreview.tsx
- src/modules/cockpit/cockpitView.ts
- src/modules/cockpit/CockpitInput.tsx
- src/modules/cockpit/hooks/useCockpitHub.ts
- src/modules/cockpit/hooks/useObservationWall.ts
- src/modules/cockpit/index.ts
- src/modules/cockpit/tests/ObservationWall.test.tsx
- src/modules/cockpit/tests/CockpitStage.test.tsx
- src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts
- src/modules/sidebar/SidebarProjectItem.tsx
- src/modules/sidebar/SidebarSessionItem.tsx
- src/modules/quay/QuayPanel.tsx
- e2e/cockpit-observation-wall.spec.ts
- playwright.config.ts
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
- tasks/observation-wall-ui.md
