---
id: gap-oauth-consent-page-allow-unreachable-by-scroll
title: OAuth 授权页 Allow 按钮在视口低于页面高度时用户无法滚动到：html/body 全局 overflow:hidden，授权页根节点
  min-h-screen 不限高，e2e 的 scrollIntoViewIfNeeded 程序化滚动掩盖了该缺陷
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**缺陷。** 真实用户在视口低于页面内容高度时，无法用滚轮或触摸滚动到授权页的 Allow 按钮；只有键盘 Tab（程序化滚动）能到。

真实浏览器走查读数（2026-10-08，构建后的服务端 + 隔离数据目录 + 真实 Playwright Chromium）：

- 1280x800：页面内容高 1069px，Allow 按钮在 y=963..1003，落在 800px 视口之外。375x812：`body.scrollHeight=1141`，Allow 在 y=995..1035，落在 812px 视口之外。
- Allow 的祖先链：页面根 `div.relative.min-h-screen.overflow-x-hidden`（`src/modules/oauth-consent/OAuthConsentRoute.tsx:104`；computed `overflow-y: auto`，但高度随内容增长，所以永远不会滚动）、`body` 的 `overflow-y: hidden`、`html` 的 `overflow-y: hidden`（`src/index.css:147` 与 `:175` 在整个应用范围设置了 `overflow: hidden`）。
- 真实滚轮输入（`page.mouse.wheel(0, 400)` 连发 6 次）后 document/body 的 `scrollTop` 仍为 0，Allow 仍在视口之下。程序化滚动（`element.scrollIntoView`、Playwright `click()`、`scrollIntoViewIfNeeded()`）**会**移动 `body.scrollTop`（`overflow:hidden` 仍允许程序化滚动）——这正是现有判据绿、用户却够不到按钮的原因。手机上的触摸滚动与滚轮同样无效。键盘 Tab 聚焦同样触发程序化滚动，所以今天只有键盘用户能到 Allow。
- 本应抓住它的判据：`e2e/oauth-consent-page.spec.ts` 的 `(AC8) The phone viewport` 块（约 553-600 行）在读几何**之前**调用了 `await allowButton().scrollIntoViewIfNeeded();`，再断言 bottom <= 视口高度。这个滚动调用就是遮蔽步骤。任务 `gap-oauth-consent-spa-ui` 的 AC (f)「375px：无横向溢出，Allow 在视口内」只有在程序化滚动之后才成立。

**修法**（执行者可凭证据细化，必须守下方不变量）：让授权页自己的根节点成为滚动容器，例如根 `h-dvh overflow-y-auto`（保留 `overflow-x-hidden`），`main` 不再用 `min-h-screen` 去撑 body 高度，使用户在任何视口高度（含矮的笔记本窗口、横屏手机、移动浏览器地址栏伸缩）下都能用滚轮/触摸滚到 Allow 与 Deny（用 `dvh`，不用 `vh`）。**不要**改 `src/index.css` 里全局的 html/body overflow 规则（工作区布局依赖它们）；修复范围限定在授权页。可选：让 Allow/Deny 行在滚动容器底部 sticky，使决定按钮始终可见（视觉评审时决定，须保证密码框在屏幕键盘之上仍可达）。

**不变量**：

- 修复必须用**真实输入**证明，而不是程序化滚动：判据在桌面驱动 `page.mouse.wheel`；手机视口驱动真实触摸滚动手势（如 CDP `Input.synthesizeScrollGesture`，或 Playwright 的 `hasTouch` 触摸模拟），至少在 375x812 视口上用滚轮输入。测量前**不得**调用 `scrollIntoViewIfNeeded`/`scrollIntoView`/基于 click 的自动滚动。
- 读数：手势之前先做正控制——在刻意偏矮的视口（如 1280x600 与 375x667）断言 Allow 初始**确实**在折叠线之下（否则判据空转）；真实滚轮/触摸之后断言 Allow 的 bottom <= 视口高度且其文本非空（几何与文本放在同一个 predicate 里轮询，参照 e2e 教训「empty-placeholder-row-satisfies-a-geometry-only-wait」）；随后用真实鼠标点击在其屏幕坐标上点 Allow（`page.mouse.click` 点在量到的中心，不用会自动滚动的 `locator.click`），并断言导航到已注册的回调且带 `code` 与 `state`。
- 取假（负对照，记录 diff + 逐字红行 + 恢复命令）：把根节点退回 `min-h-screen` 且无自有滚动容器 ⇒ 新的真实输入判据**必须红**（Allow 不可达）；保留修复但在判据里重新加入 `scrollIntoViewIfNeeded` ⇒ 记录「旧形态判据」；并把**旧判据体跑在未修复的页面上**，证明它在那里是绿的，记录结果（这就是旧判据空转的证据）。

<!-- dedup-ref -->
去重（按机制，非症状）：以 `scrollIntoViewIfNeeded` 与 consent 检索现有任务，未发现同机制的开放任务；`gap-oauth-consent-spa-ui`（已 done）是授权页的原始交付，其 AC (f) 的 375px 读数正是被程序化滚动遮蔽的那条，本任务是对它的缺陷修复与判据补强，不是重复；`gap-ac101-actionmenu-arm-window-unverified` 等命中项只是同样提到 `scrollIntoViewIfNeeded` 的字样，机制无关。合并候选：未发现 Touches 同时覆盖 `OAuthConsentRoute.tsx` 的开放任务，故独立立案（none found）。

## AC

- [ ] AC1 红态基线：未改动前，用新写的真实输入判据（滚轮/触摸、测量前无程序化滚动）跑 `npx playwright test e2e/oauth-consent-page.spec.ts`，在 1280x600 与 375x667 上 Allow 在滚动后仍在视口之下并判红；逐字写下红行与量到的 Allow 几何（修复前读数）。
- [ ] AC2 修复后判据绿：`npx playwright test e2e/oauth-consent-page.spec.ts` 退出 0；写下 passed/总数与墙钟。桌面 1280x600 用 `page.mouse.wheel`、手机 375x667（及 375x812）用真实触摸滚动手势（或至少滚轮）把 Allow 滚进视口：断言 Allow bottom <= 视口高度、文本非空（几何与文本同一 predicate 轮询）。
- [ ] AC3 正控制与无程序化滚动：同一 spec 里在手势前断言 Allow 初始在折叠线之下（1280x600 与 375x667）；`grep -nE "scrollIntoViewIfNeeded|scrollIntoView" e2e/oauth-consent-page.spec.ts` 在授权页几何/点击路径上无命中（写下命令与输出）。
- [ ] AC4 真实点击走完授权：滚动后用 `page.mouse.click` 点在量到的 Allow 中心坐标（非 `locator.click`），断言导航到已注册回调且 URL 带 `code` 与 `state`；逐字写下回调 URL 的形状（code 值可打码）。
- [ ] AC5 取假形态：(i) 根节点退回 `min-h-screen` 无自有滚动容器 ⇒ AC2 的真实输入判据红；(ii) 把旧判据体（含 `scrollIntoViewIfNeeded`）跑在未修复页面上 ⇒ 记录它是绿的。每条记录变异 diff、逐字红/绿行与恢复命令，恢复后重跑回绿。
- [ ] AC6 范围纪律：`git diff develop -- src/index.css` 为空（全局 html/body overflow 规则未动）；`git diff develop --name-only` 无 `server/` 路径；`package.json` 与 lockfile 无 diff（无新依赖）。
- [ ] AC7 仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）、`npm run test:client` 退出 0；若 `src/modules/oauth-consent/tests/oauthConsentPage.test.tsx` 有类断言则同步更新并通过。
- [ ] AC8 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐，列出实际改动文件清单。

## DoD

- 真实浏览器 + 真实服务端，在 1280x600 与 375x667 两种视口下，**仅用**滚轮/触摸输入与真实鼠标点击（无程序化滚动、无 locator 自动滚动）走完整个授权流程，并留下截图证明 Allow 被滚到并被点中。
- 判据不再空转：手势前 Allow 确在折叠线之下（正控制），退回 `min-h-screen` 的变异让新判据变红，旧判据在未修复页面上为绿的事实已记录。
- 按 quay-webui-bootstrap-methodology 技能做整体视觉评审，并与设置页对照（滚动容器、sticky 决定行（若采用）、密码框在屏幕键盘之上仍可达）。
- 全局 html/body overflow 规则未动；无服务端改动；无新依赖；遵守 `$frontend-module-standards` 与 AGENTS.md；e2e 只按单文件调用，不做无界扇出（见 `docs/operations/process-isolation-and-memory-caps.md`）。

## Touches

- src/modules/oauth-consent/OAuthConsentRoute.tsx (根节点与 main 的布局 class；若布局实际在该模块的其他组件文件里，按读码结果补入)
- e2e/oauth-consent-page.spec.ts (改写手机视口块为真实输入；新增矮视口桌面用例)
- src/modules/oauth-consent/tests/oauthConsentPage.test.tsx (仅当其中存在布局 class 断言时才改)
- tasks/gap-oauth-consent-page-allow-unreachable-by-scroll.md

## Notes

- 出范围（如需另行立案）：登录页对从未登录用户显示「会话已过期」措辞；引导向导打断全新账号的 OAuth 返回；scope 风险分组；授权路由上的 401 控制台噪声。
- 测试者的证据在截图 `consent-walk-03-consent-desktop.png` 与 `consent-walk-05-mobile-375.png`（未跟踪，位于仓库根目录）——本任务不依赖它们。
- 注意 e2e 的 `scrollIntoViewIfNeeded`/`click()` 会程序化滚动 `overflow:hidden` 的容器，使「用户够不到」的缺陷被判据遮蔽；本任务的判据必须是真实输入。
