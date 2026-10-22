---
id: architecture-toolbar-popover-and-fit-fixes
title: 搜索结果框不再被工具栏裁掉、Fit 真正适应、弹层点外面关闭、角落浮层让图避让（桌面与手机）
status: done
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-22 用 MCP 浏览器在本会话（claudecodeui 项目，视口 1440×765 与 390×844）复现并量到几处布局缺陷。它们来自已落地的工具栏、搜索、筛选、缩放簇、缩略图与来源行任务，各自只在 jsdom 里测过，没有任何断言覆盖真实几何或功能叠加。

### 一、搜索结果看不见（根因已定位）

输入 `Architecture` 后只露出输入框下方 3px 的线。结果框 `absolute left-0 top-full z-30 mt-1 max-h-72 w-80`（`ArchitecturePanel.tsx` 第 2206 行附近）存在，实测盒 `[923,93,320,288]`，但它的祖先是工具栏行 `flex shrink-0 items-center gap-2 overflow-x-auto`（第 2772 行附近，实测高 39px）：`overflow-x:auto` 会让 y 方向同样变成 `auto`，于是结果框被裁到只剩 3px。修法：结果框不再放在带裁剪的容器里——用 portal 渲染并用 `position: fixed` 锚定到输入框（滚动/缩放/窗口变化时重新定位），或让工具栏换行而不是滚动；二选一，实施记录里写明并给出理由。同时补 combobox 语义：输入框 `role="combobox"`、`aria-expanded`、`aria-controls`，结果框 `role="listbox"`，选项 `role="option"`，方向键移动活动项、`Enter` 选中活动项、失焦/点外面关闭。

### 二、「Fit to view」不适应

实测：自然尺寸 4395.67×1943.7，画布 1151×615，真正能适应的缩放是 25.6%（`min((1151-24)/4395.67, (615-24)/1943.7)`）；按 Fit 后实际是 18.1%，图只占画布的 70%（宽 795/1151、高 352/615）。缩放簇读 18%，而顶部档位文字写「Zoom 26%」（那是真 fit 值），两个缩放数互相矛盾。根因：`fitAvoidingCorners`（`svgViewport.ts` 第 176 行附近，`PlantUmlGraph.tsx` 第 982 行附近调用）让**居中**的图避开右下角两块浮层，居中后只能对称缩小，图右缘被压到缩略图左缘（x=1262）。修法：避让时允许把图向远离浮层的方向平移（单侧让位），在「存在不相交摆放」时取最大缩放；只有任何摆放都必然相交时才缩小。缩放簇与档位文字的「Zoom N%」必须是同一个数（由同一个状态派生）。

### 三、弹层点外面不关

筛选弹层点侧栏、点工具栏空白都不关闭，只有再点 Filter 按钮才关（点外面关闭的处理只挂在别的 disclosure 上）。筛选弹层、「Adjusted」弹层、图例弹层统一：点外面关闭（不吞掉那次点击）、`Escape` 先关弹层且 `stopPropagation`（聊天页的全局 Escape 会中止当前回合，必须保持既有的拦截）、关闭后焦点回到触发按钮。

### 四、来源行浮层盖住图；手机底部叠层

`Analysis: … · N names mentioned…` 与 `Scope cleanup` 两个药丸浮在画布左下角，压在图的内容上；手机上它们是两行大块，与缩放簇、缩略图按钮叠在一起（`Fit to view` 文字与图文字叠影），顶部读数卡半透明也盖住图。修法：来源行与「Scope cleanup」改成画布下方**文档流里的一行页脚**（单行、超长省略、点开向上展开成弹层，展开时不改变画布尺寸），画布只保留右下角的缩略图与缩放簇两个浮层，且二者不相交；手机的读数卡同样移出画布放进文档流。

### 五、手机「Adjust」面板

范围步进器 `− +2 +` 没有可见的按钮边框，`+2` 比两侧字符偏高；范围与详情两组没有标题；`Filter ▾` 被当成小标题。修法：每组有标题（View/Scope/Detail/Filter/Export/Legend 的本地化文案），步进器两个按钮有可见边框且 ≥ 44×44、读数垂直居中，筛选区标题写「Filter」不带下拉箭头。

## AC

- [x] `npx vitest run src/modules/architecture/tests/svgViewport.test.tsx` exit 0：新增用例用实测形态（自然 4395.67×1943.7、画布 1151×615、角落浮层 166×106 与 77×133 在右下）断言 fit 缩放 ≥ 理论最大值（0.256）的 95%；存在不相交摆放时图与所有角落矩形不相交；任何摆放都必然相交时才低于该比例；既有 fit 用例不回归
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/canvasLayoutContract.test.tsx src/modules/architecture/tests/mobileCompactToolbar.test.tsx` exit 0：搜索结果框不在带 `overflow` 的祖先内（或经 portal 渲染并为 `position: fixed`）；输入框有 combobox 语义，方向键与 Enter 工作；筛选/Adjusted/图例弹层点外面关闭、Escape 先关弹层且 `chat.abort` 调用计数为 0、关闭后焦点回到触发按钮；缩放簇的缩放读数与档位文字的「Zoom N%」来自同一个值；来源行与「Scope cleanup」位于画布之后的文档流页脚且不是 `position: absolute`；手机读数卡不是浮层；Adjust 面板每组有标题，步进器按钮 ≥ 44×44
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（在既有守卫文件里增加断言，整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 为它加条目并写明实测）：搜索结果框完整位于视口内且在其中心 `elementFromPoint` 命中的是选项；Fit 后缩放 ≥ 理论最大值的 95%；页脚与缩略图、缩放簇两两不相交（PC 与手机视口都断言）
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：新增控制臂——对工具栏行注入 `overflow-x:auto; height:39px` 后搜索结果框的可见高度读数落到阈值以下（证明守卫能取假），主臂读取函数与控制臂完全相同
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0（12 个 locale 文案键齐全）；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（1440×765 与 390×844）打开 claudecodeui 项目任一会话的 architecture tab：在搜索框输入名字，结果框完整可见、可用方向键与回车选择；点 Fit，图占满画布（读数：缩放 ≥ 理论最大值的 95%，且缩放簇与档位文字的百分比相同）；筛选弹层点侧栏即关闭；来源行与「Scope cleanup」在画布下方一行，手机上底部不再有叠层；手机「Adjust」面板每组有标题、步进器可见可点。证据是几何读数与前后截图。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/svgViewport.ts
- src/modules/architecture/ArchitectureMinimap.tsx
- src/modules/architecture/ArchitectureSheet.tsx
- src/modules/architecture/tests/svgViewport.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/canvasLayoutContract.test.tsx
- src/modules/architecture/tests/mobileCompactToolbar.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- e2e/architecture-canvas-layout.spec.ts
- e2e/support/architectureFixture.ts
- playwright.config.ts
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/de/common.json
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
- tasks/architecture-toolbar-popover-and-fit-fixes.md

## Blocker

**2026-10-22T16:06:03.280Z — worker 未落地（exited-not-landed）**

- 未落地原因：AC 未全勾（checked 0/5，剩余未勾 5）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：7009e3c6-7392-41c5-acc4-563f3ae313f8
