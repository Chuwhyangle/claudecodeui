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

- [x] AC1 红态基线：未改动前，用新写的真实输入判据（滚轮/触摸、测量前无程序化滚动）跑 `npx playwright test e2e/oauth-consent-page.spec.ts`，在 1280x600 与 375x667 上 Allow 在滚动后仍在视口之下并判红；逐字写下红行与量到的 Allow 几何（修复前读数）。
- [x] AC2 修复后判据绿：`npx playwright test e2e/oauth-consent-page.spec.ts` 退出 0；写下 passed/总数与墙钟。桌面 1280x600 用 `page.mouse.wheel`、手机 375x667（及 375x812）用真实触摸滚动手势（或至少滚轮）把 Allow 滚进视口：断言 Allow bottom <= 视口高度、文本非空（几何与文本同一 predicate 轮询）。
- [x] AC3 正控制与无程序化滚动：同一 spec 里在手势前断言 Allow 初始在折叠线之下（1280x600 与 375x667）；`grep -nE "scrollIntoViewIfNeeded|scrollIntoView" e2e/oauth-consent-page.spec.ts` 在授权页几何/点击路径上无命中（写下命令与输出）。
- [x] AC4 真实点击走完授权：滚动后用 `page.mouse.click` 点在量到的 Allow 中心坐标（非 `locator.click`），断言导航到已注册回调且 URL 带 `code` 与 `state`；逐字写下回调 URL 的形状（code 值可打码）。
- [x] AC5 取假形态：(i) 根节点退回 `min-h-screen` 无自有滚动容器 ⇒ AC2 的真实输入判据红；(ii) 把旧判据体（含 `scrollIntoViewIfNeeded`）跑在未修复页面上 ⇒ 记录它是绿的。每条记录变异 diff、逐字红/绿行与恢复命令，恢复后重跑回绿。
- [x] AC6 范围纪律：`git diff develop -- src/index.css` 为空（全局 html/body overflow 规则未动）；`git diff develop --name-only` 无 `server/` 路径；`package.json` 与 lockfile 无 diff（无新依赖）。
- [x] AC7 仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）、`npm run test:client` 退出 0；若 `src/modules/oauth-consent/tests/oauthConsentPage.test.tsx` 有类断言则同步更新并通过。
- [x] AC8 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐，列出实际改动文件清单。

## DoD

- 真实浏览器 + 真实服务端，在 1280x600 与 375x667 两种视口下，**仅用**滚轮/触摸输入与真实鼠标点击（无程序化滚动、无 locator 自动滚动）走完整个授权流程，并留下截图证明 Allow 被滚到并被点中。
- 判据不再空转：手势前 Allow 确在折叠线之下（正控制），退回 `min-h-screen` 的变异让新判据变红，旧判据在未修复页面上为绿的事实已记录。
- 按 quay-webui-bootstrap-methodology 技能做整体视觉评审，并与设置页对照（滚动容器、sticky 决定行（若采用）、密码框在屏幕键盘之上仍可达）。
- 全局 html/body overflow 规则未动；无服务端改动；无新依赖；遵守 `$frontend-module-standards` 与 AGENTS.md；e2e 只按单文件调用，不做无界扇出（见 `docs/operations/process-isolation-and-memory-caps.md`）。

## 完成记录

**本条做了什么。** 授权页的根节点 `ConsentShell` 从 `relative min-h-screen overflow-x-hidden` 改为 `relative h-dvh overflow-y-auto overflow-x-hidden` 并加 `data-testid="consent-scroll"`，`main` 从 `min-h-screen` 改为 `min-h-full`。`src/index.css` 的全局 `html, body { overflow: hidden }` 一字未动。判据 `e2e/oauth-consent-page.spec.ts` 改写为真实输入：删掉手机块里的 `await allowButton().scrollIntoViewIfNeeded();`，新增 `reachDecisionByRealInput` 助手（正控制 → 无程序化滚动的 DOM 级 setup → `page.mouse.wheel` → 几何与文本同一 predicate 轮询 → `page.mouse.click` 点在量到的中心），并新增 1280x600 桌面 Allow/Deny 与 375x667 手机 Allow 三条真实输入腿。

**AC1 红态基线**（未修复树：`git checkout develop -- src/modules/oauth-consent/OAuthConsentRoute.tsx`，即根节点为 `min-h-screen` 无自有滚动容器）

`npx playwright test e2e/oauth-consent-page.spec.ts` → 退出 1。逐字红行：

```
(b) 1280x600 Allow: positive control — decision starts below the 600px fold: {"text":"Allow","disabled":true,"left":465,"top":943.5,"right":635,"bottom":983.5,"width":170,"height":40,"centerX":550,"centerY":963.5}
Error: (b) 1280x600 Allow: real wheel input must bring the decision button fully into the 1280x600 viewport (geometry={"text":"Allow","disabled":false,"left":465,"top":1021.5,"right":635,"bottom":1061.5,"width":170,"height":40,"centerX":550,"centerY":1041.5})
```

（正控制 bottom=983.5 > 600 成立；真实滚轮后 bottom=1061.5 仍在 600px 视口之下，`scrollTop` 恒为 0。）

375x667 腿的逐字红行（该腿在串行测试里排在桌面腿之后，用一次性 `if (!process.env.AC1_MOBILE_ONLY)` 守卫**临时**跳过桌面腿把它跑出来，守卫用后即删，见 AC5 恢复）:

```
(f) 375x667 Allow: positive control — decision starts below the 667px fold: {"text":"Allow","disabled":true,"left":41,"top":955.5,"right":334,"bottom":995.5,"width":293,"height":40,"centerX":187.5,"centerY":975.5}
(f) 375x667 Allow: scrollWidth=375 clientWidth=375
Error: (f) 375x667 Allow: real wheel input must bring the decision button fully into the 375x667 viewport (geometry={"text":"Allow","disabled":false,"left":41,"top":955.5,"right":334,"bottom":995.5,"width":293,"height":40,"centerX":187.5,"centerY":975.5})
```

（375x667 上滚轮把 Allow 移动了 **0px**：bottom 前后都是 995.5。）

**AC2 修复后判据绿**（修复树）

```
$ PATH="$PWD/node_modules/.bin:$PATH" bash scripts/with-memory-cap.sh npx playwright test e2e/oauth-consent-page.spec.ts
EXIT=0 WALL_MS=27918
  1 passed (27.1s)
```

逐腿读数（几何与文本同一 predicate 轮询取到的那一刻）：

| 视口 | 正控制 bottom | 真实滚轮后 bottom | scrollTop | 结果 |
|---|---|---|---|---|
| 1280x600 Allow | 983.5 (>600) | 534.5 (top 494.5) | 527 | 入视口 |
| 1280x600 Deny | 983.5 (>600) | 534.5 (top 494.5) | 449 | 入视口 |
| 375x667 Allow | 995.5 (>667) | 661.5 (top 621.5) | 334 | 入视口，scrollWidth=375=clientWidth |
| 375x812 Allow | 995.5 (>812) | 706.5 (top 666.5) | 289 | 入视口，scrollWidth=375=clientWidth |

**AC3 正控制与无程序化滚动。** 正控制见上表（手势前 1280x600 bottom=983.5、375x667 bottom=995.5，都在折叠线之下）。授权页几何/点击路径上的程序化滚动已清零：

```
$ grep -nE "scrollIntoViewIfNeeded|scrollIntoView" e2e/oauth-consent-page.spec.ts
（无输出）
```

决策路径上的 setup（写 scope 勾选、密码填入）走 DOM 级非滚动方式：`HTMLInputElement.prototype.value` 原生 setter + `input` 事件、`box.click()`，不用 `locator.fill`/`locator.check`（它们会自动滚动）。点击用 `page.mouse.click(centerX, centerY)`。

**AC4 真实点击走完授权。** 1280x600 点 (550, 514.5)、375x667 点 (187.5, 641.5)，均由 `page.mouse.click` 打在量到的中心；回调 URL 形状：

```
(b) http://127.0.0.1:11691/callback?code=2e208719…&state=state-e2e-consent
(f) http://127.0.0.1:11691/callback?code=8cf3d767…&state=state-e2e-consent
```

Allow 授权码随后在真实 `/oauth/token` 兑换（`POST /oauth/token -> 200 token_type="Bearer"`），铸出的 token 对 `/mcp` 真实认证（`POST /mcp -> 200`），服务端存下的 grant scopes 回读为 `["cloudcli:read","cloudcli:navigate"]`。Deny 腿回调为 `?error=access_denied&state=state-e2e-consent`，无 `code`。

**AC5 取假形态**

(i) 根节点退回 `min-h-screen` 无自有滚动容器（变异 diff = 把 `h-dvh overflow-y-auto` → `min-h-screen`、`min-h-full` → `min-h-screen`，等价 `git checkout develop -- src/modules/oauth-consent/OAuthConsentRoute.tsx`）⇒ AC2 的真实输入判据红，逐字红行即 AC1 那两条。恢复：`cp /tmp/consent-route-fixed.tsx src/modules/oauth-consent/OAuthConsentRoute.tsx`。

(ii) 旧判据体（`git show HEAD:e2e/oauth-consent-page.spec.ts`，手机块第 558 行含 `await allowButton().scrollIntoViewIfNeeded();`）跑在**未修复页面**上 ⇒ **绿**：

```
$ git show HEAD:e2e/oauth-consent-page.spec.ts > e2e/oauth-consent-page.spec.ts   # 换回旧判据
$ git checkout develop -- src/modules/oauth-consent/OAuthConsentRoute.tsx         # 未修复页面
$ ... npx playwright test e2e/oauth-consent-page.spec.ts
(f) 375x812: scrollWidth=375 clientWidth=375; Allow={"text":"Allow","left":41,"top":666.5,"right":334,"bottom":706.5,"width":293,"height":40}
  ✓  1 passed (22.6s)
```

即「Allow 在视口内（bottom=706.5）」这个读数只是 `scrollIntoViewIfNeeded()` 把 `body.scrollTop` 程序化挪动后的产物 —— 这正是旧判据空转的证据。恢复：`cp /tmp/consent-new-spec.ts e2e/oauth-consent-page.spec.ts`。两条变异恢复后 `git diff --stat` 为空、重跑回绿（见 AC2）。

**AC6 范围纪律**

```
$ git diff develop -- src/index.css
（无输出）
$ git diff develop --name-only | grep -E "^server/|package.json|lock"
NONE
```

**AC7 仓库门**

```
npm run typecheck   → exit 0（tsconfig.json + server/tsconfig.json + scripts/tsconfig.json）
npm run lint        → exit 0，`: error ` 计数 0（输出只有既有 warning）
npm run test:client → exit 0，Test Files 179 passed (179)；Tests 1209 passed | 1 skipped (1210)
```

`src/modules/oauth-consent/tests/oauthConsentPage.test.tsx` 通读后**没有**布局 class 断言（只断言决策逻辑与 render，不含 `h-dvh`/`min-h-*`/`overflow-*`），故未改；该文件随 `test:client` 一起绿。

**AC8 产物边界（`git diff --stat develop...HEAD` 对齐 Touches）**

```
 e2e/oauth-consent-page.spec.ts                  | 291 +++++++++++++++++++-----
 src/modules/oauth-consent/OAuthConsentRoute.tsx |  23 +-
 2 files changed, 250 insertions(+), 64 deletions(-)
```

两条都在 `## Touches` 内；Touches 第三条（`oauthConsentPage.test.tsx`，仅当有类断言才改）经通读无需改；Touches 第四条（任务文件）由 ABI 自己提交。

**DoD 视觉评审。** 截图：`artifacts/oauth-consent-desktop-1280x600-allow-scrolled.png`、`artifacts/oauth-consent-mobile-375x667-allow-scrolled.png`、`artifacts/oauth-consent-mobile-375x812-allow-scrolled.png`（均在滚轮之后、点击之前拍下，可见 Allow 已被滚入视口且卡片在容器内滚动而非页面滚动）。与设置页对照：1280x600 下设置面板 `<main>` 的读数 `{overflowY:"auto", height:473, scrollHeight:516}` —— 与应用内既有约定一致（有界容器 + 自有 `overflow-y-auto`；对照 `src/modules/settings/Settings.tsx:215`、`WorkspaceMenu.tsx:137`），本条把授权页从「无限高根节点」改成同一约定。**sticky 决定行未采用**（Proposal 标为可选）：sticky 底行会盖住滚动容器末尾的内容、并可能与屏幕键盘争位，而 `h-dvh` 让容器随可视高度收缩，滚轮/触摸即可把密码框与 Allow 都带上来 —— 375x667 的读数已证明。授权页自身视觉探针：`(visual) unnamed controls=[]; headings=[1]; below-AA text runs=[]`，无无名字控件、标题层级从 h1 起、无低于 AA 的文本。

**判据不再空转**：手势前折叠线之下的正控制（AC3）、退回 `min-h-screen` 后新判据变红（AC5i）、旧判据在未修复页面为绿（AC5ii）三条事实均已登记。

## Touches

- src/modules/oauth-consent/OAuthConsentRoute.tsx (根节点与 main 的布局 class；若布局实际在该模块的其他组件文件里，按读码结果补入)
- e2e/oauth-consent-page.spec.ts (改写手机视口块为真实输入；新增矮视口桌面用例)
- src/modules/oauth-consent/tests/oauthConsentPage.test.tsx (仅当其中存在布局 class 断言时才改)
- tasks/gap-oauth-consent-page-allow-unreachable-by-scroll.md

## Notes

- 出范围（如需另行立案）：登录页对从未登录用户显示「会话已过期」措辞；引导向导打断全新账号的 OAuth 返回；scope 风险分组；授权路由上的 401 控制台噪声。
- 测试者的证据在截图 `consent-walk-03-consent-desktop.png` 与 `consent-walk-05-mobile-375.png`（未跟踪，位于仓库根目录）——本任务不依赖它们。
- 注意 e2e 的 `scrollIntoViewIfNeeded`/`click()` 会程序化滚动 `overflow:hidden` 的容器，使「用户够不到」的缺陷被判据遮蔽；本任务的判据必须是真实输入。
