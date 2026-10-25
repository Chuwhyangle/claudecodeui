---
id: gap-composer-menu-anchor-overflows-mobile-viewport
title: 移动端输入框「…」更多菜单 popover 溢出屏幕：useComposerMenuAnchor 按视口夹紧
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现象**：移动端（窄于 `md`）点击输入框的「…」（`ComposerMobileMoreMenu`）后，popover 显示溢出屏幕。以下为读码得出的根因（当时 MCP 浏览器被别的会话占用，未能实机复现；实现者须先在 390×780 与 320×568 复现并截图，再动手）。

**机制**：`ComposerMenuSurface` 是 `position: fixed` 的 portal，位置全由 `useComposerMenuAnchor` 给出。

1. **宽度夹紧失效（主因）**：`maxWidth = max(200, min(320, innerWidth - right - 8))`，而 surface 又带 `min-w-48`（192px）。触发器左侧可用空间 < 200px 时，下限盖过 `maxWidth`，菜单仍以 ≥200px 宽度右锚，左缘越出屏幕。hook 注释声称「maxWidth 缩小而不是溢出左边」，被这个下限破坏。右锚只在触发器贴右缘时成立；「…」在主行中间时不成立。
2. **日程选择器就地展开**：`SchedulePicker` 在同一 surface 内渲染 `datetime-local`（`w-full`），移动浏览器上该 input 固有最小宽度大，`min-width:auto` 可把 surface 撑过 `maxWidth` 或出横向滚动（surface 为 `overflow-y-auto`，`overflow-x` 随之计算为 `auto`）。
3. **纵向（次要）**：`maxHeight = max(160, rect.top - 16)`，输入框靠视口顶部（如软键盘弹出）时 160 的下限把菜单顶出屏幕上缘；锚点用 `window.innerHeight`，不随软键盘变化，且 hook 不监听 `visualViewport`。

**方案**（改动集中在 hook 与 surface，模型菜单、权限菜单共用，一并受益）：

- 宽度：`maxWidth = min(preferredWidth, innerWidth - 2*VIEWPORT_MARGIN)`，去掉 `max(200, …)` 下限，surface 的 `min-w-48` 改为 `min-w-0` 或随 `maxWidth` 收缩；水平位置夹到 `[8, innerWidth - menuWidth - 8]`（改 `left`/`bottom` 锚定，或保留 `right` 并以 `min(right, innerWidth - 8 - minWidth)` 夹紧）。
- 窄屏（< `md`）可退化为 `left: 8; right: 8` 的底部抬升菜单。
- 选择器：`datetime-local` 加 `min-w-0 max-w-full`，surface 加 `overflow-x-hidden`。
- 纵向：`bottom` / `maxHeight` 基于 `window.visualViewport`（height、offsetTop），并订阅其 `resize` / `scroll`；去掉 160 下限或以可用空间为上限。

**拒绝的替代**：只给「…」菜单打补丁而不动 hook——模型/权限菜单同源同病，会留下同类缺陷。

## AC

- [x] 新增 `src/modules/chat/tests/composerMenuAnchor.test.ts`（vitest）：对 `innerWidth` ∈ {320, 390, 768} × 触发器 `rect.right` ∈ {贴右缘, 视口中部, 偏左} 的组合，断言算出的菜单盒 `[left, right]` 完全落在 `[8, innerWidth-8]` 内；`npx vitest run src/modules/chat/tests/composerMenuAnchor.test.ts` 退出码 0。
- [x] 同文件含纵向用例：`rect.top` 很小（< 100）或 `visualViewport.height` 小于 `innerHeight` 时，菜单盒 `top >= 8`，且底边不低于 `visualViewport` 可视区；该用例在修复前（对 `git stash` 掉修复后的原实现）为红。
- [x] `grep -nE "max\(200|max\(160" src/modules/chat/hooks/useComposerMenuAnchor.ts` 无命中（夹紧下限已移除）。
- [x] `npx vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx` 退出码 0（既有移动端更多菜单行为不回退）；`npx tsc --noEmit -p tsconfig.json` 无新增错误。
- [x] MCP 浏览器在 390×780 与 320×568 下点击「…」，菜单四边都在视口内；展开「定时发送」选择器后仍在视口内且无横向滚动；截图存 `tmp/` 并贴出（UI 任务 DoD 条款，见 AGENTS.md「UI 验证」）。

## DoD

在真实运行的页面上，用 MCP 浏览器移动尺寸（390×780、320×568）实际点开「…」菜单、展开日程选择器、再点开模型菜单与权限菜单各一次，四边均不越出视口，截图存 `tmp/` 并随任务贴出；如存在可用场景，另跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴出 JSON 报告。只有单测绿、没有实机截图，不算落地。MCP 浏览器若被占用，按共享车道教训用一次性 Playwright spec，且不得改动用户服务端偏好、不得在运行中的会话页按 Escape。

## Evidence

- 单测：`QUAY_VITEST_MAX_WORKERS=2 npx vitest run src/modules/chat/tests/composerMenuAnchor.test.ts` → 3 passed。反向验证：只 `git stash` 掉 `useComposerMenuAnchor.ts` 的修复（测试文件保留）→ 3 failed（横向夹紧、顶部 8px、visualViewport 底边三条均红）。
- 回归：`npx vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx` → 16 passed。
- 类型：`npx tsc --noEmit -p tsconfig.json` → exit 0。
- 下限移除：`grep -nE "max\(200|max\(160" src/modules/chat/hooks/useComposerMenuAnchor.ts` → 无命中（exit 1）。
- 实机（本会话无浏览器 MCP，按 DoD 用一次性 Playwright；隔离实例 :3191 + 本 worktree 的 Vite :5199，隔离 HOME、`residentRestore.enabled=false`、未按 Escape、未改用户偏好）。读数（fixed 盒子的左/上/右/下，视口边距）：

  | 视口 | 菜单 | box (l,t,r,b) | 边距 l/t/r/b | scrollWidth/clientWidth |
  | --- | --- | --- | --- | --- |
  | 390×780 | 「…」 | 125,587,328,719 | 125/587/62/61 | 201/201 |
  | 390×780 | 定时发送（已展开） | 53,293,328,719 | 53/293/62/61 | 273/273 |
  | 390×780 | 模型 | 180,418,328,719 | 180/418/62/61 | 146/146 |
  | 390×780 | 权限 | 8,305,360,719 | 8/305/30/61 | 350/350 |
  | 320×568 | 「…」 | 109,375,312,507 | 109/375/8/61 | 201/201 |
  | 320×568 | 定时发送（已展开） | 38,81,312,507 | 38/81/8/61 | 272/272 |
  | 320×568 | 模型 | 164,206,312,507 | 164/206/8/61 | 146/146 |
  | 320×568 | 权限 | 8,29,312,507 | 8/29/8/61 | 302/302 |

  全部 `inside=true`（四边均在视口内）；定时发送的 `datetime-local` 宽 245px（390）/244px（320），完全落在菜单内；`document` 横向溢出 0；关闭后残留 overlay 0；`pageerror` 0。截图与 `report.json`：`tmp/ui-menu-anchor/{390x780,320x568}-{more,schedule,model,permission}.png`。
- ui-scenario：`e2e/scenarios/` 仅有 `cockpit-mode-switch.json` 与 `quay-wall-focus-pin-utter.json`，均不覆盖 composer 菜单，故无可用场景可跑。

## Touches

- src/modules/chat/hooks/useComposerMenuAnchor.ts
- src/modules/chat/composer/ComposerMenuPrimitives.tsx
- src/modules/chat/composer/ScheduleMessagePopover.tsx
- src/modules/chat/tests/composerMenuAnchor.test.ts
- tasks/gap-composer-menu-anchor-overflows-mobile-viewport.md

<!-- dedup-ref -->
去重/合并检查：`tasks/` 中无其他 todo/ready 任务提及 `useComposerMenuAnchor` / `ComposerMobileMoreMenu` / `ComposerMenuSurface`；`task-granularity-advice` 对上述 Touches 返回 `peers: []`、`mentions: []`。结论：none found，单独立案。
