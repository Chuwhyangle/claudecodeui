---
id: gap-oauth-consent-flow-ux-hardening
title: OAuth 授权流程体验与安全加固：登录/引导不再截断授权、登录页措辞、scope 按风险分组、客户端"未验证"提示与授权时长说明、密码确认仅对写权限要求
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
---
id: gap-oauth-consent-flow-ux-hardening
title: OAuth 授权流程体验与安全加固：登录/引导不再截断授权、登录页措辞、scope 按风险分组、客户端"未验证"提示与授权时长说明、密码确认仅对写权限要求
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

真实浏览器走查（2026-10-08，已交付的授权页 SPA：`gap-oauth-consent-spa-backend-contract` 与 `gap-oauth-consent-spa-ui` 均 done；构建后的服务端 + 隔离数据目录 + 真实 Playwright Chromium + 一次性用户与 DCR 客户端）发现下列缺陷与缺口。用户已于 2026-10-08 批准全部条目。按优先级：

1. **HIGH 引导向导截断授权。** 实测：`has_completed_onboarding=0` 的全新账号在 `/oauth/consent?...` 登录后，看到的是 Git 配置引导向导而不是授权页；用户视角里 OAuth 上下文丢失（URL 保留了 query，但 `src/modules/auth/ProtectedRoute.tsx` / `src/modules/auth/context/AuthContext.tsx` 的 SPA 闸门先渲染引导）。修法二选一：(A) 授权路由豁免引导闸门（Git 身份与授权 MCP 客户端无关）；(B) 引导完成后保留并恢复授权 URL。执行者读 `ProtectedRoute.tsx` 与 `AuthContext.tsx` 后选更小、更安全的一个，并在 Notes 写明理由（预期 A）。
2. **HIGH 登录页措辞。** 实测：从未登录的用户到达 `/oauth/consent` 时看到红色横幅 “Your session expired. Please log in again.”（`AuthContext.tsx` + `src/modules/i18n/locales/*/auth.json` 的键）。修法：没有先前会话（本地无已存 token）时不显示错误横幅，或显示中性文案 “Sign in to continue authorizing <client>”；「会话已过期」只留给确实已存 token 被拒/过期的情形。另：授权路由未登录时 `/api/plugins` 与 `/api/taskmaster/installation-status` 在登录前被请求并 401（控制台噪声）——若改动很小则一并去掉，否则在 Notes 记为 deferred 并写明原因。
3. **MEDIUM scope 按风险分组。** 现状 6 个 scope 平铺，风险提示只在勾选写 scope 之后出现。改为两组：「读取」（`cloudcli:read`，固定勾选 + 禁用）与「会改变状态的操作」（`session:send`、`session:create`、`session:control`、`approve`、`navigate`），每个操作类 scope 在勾选**之前**就带可见的风险徽标/标签（如“可运行命令”“可批准工具调用”）；任一操作类被勾选时保留现有整体警告。数据取自既有服务端目录（`GET /api/oauth/authorize/context` 的 `scopes[]` 含 `writable`；`server/modules/oauth/oauth-consent.service.ts` 的 `consentScopeOptions`），必要时给目录**增量**加 `risk`/`group` 字段（上下文形状若在 `shared/oauthConsent.ts` 共享则同改）；词表与伪造 scope 拒绝行为保持不变。新字符串补齐 12 种 locale（de en es fr id it ja ko ru tr zh-CN zh-TW，位于 `src/modules/i18n/locales/`），仓库 e2e 有未翻译字面量检查。
4. **MEDIUM 未验证客户端提示与令牌时效说明。** DCR 是开放的，客户端名称由其自报。授权页显示：一句简短可见的说明“应用名称由应用自行提供，未经验证”；客户端首次登记时间（`oauth_clients.created_at`，经上下文端点返回）与 `created_via`（dcr / manual，可得时），当客户端是新的（如登记 < 24 小时，或该用户从未授权过它）时给更醒目的提示。另加一行说明访问令牌有效期（真值来自 provider 常量，实测 `expires_in=3600`）以及客户端可在授权被吊销前续期；**不得硬编码**，经上下文端点从服务端常量读取。未验证说明绝不能被呈现成对任何客户端的信任信号。
5. **已批准的策略变更：仅当授予写权限时才要求密码确认。** 现状：每次允许都要重输密码（`server/modules/oauth/oauth-consent.routes.ts` 的 `POST /decision`，由注入的 `verifyCredentials` + `ConsentPasswordRateLimiter` 把关；SPA 始终显示 “Confirm your password”）。新规则：授予集合（经强制/过滤后）只含 `cloudcli:read` 的决定，仅凭已登录会话即可放行；授予集合里**存在任何可写 scope** 时必须密码。**必须在服务端强制**：由服务端用 `oauth-consent.service.ts` 的 `grantedScopes` 算出授予集合并决定是否需要密码，绝不信任客户端传来的标志；body 看似只读却携带写 scope 的伪造请求，无有效密码必须被拒；词表外 scope 仍在决定**之前**被丢弃；限流只作用于密码分支；拒绝（deny）永远不需要密码。SPA 仅在勾选了写 scope 时显示密码框，且此时在填写前禁用 Allow。安全理由写入 Notes，并明确把「被盗的会话 JWT 仍可签发只读授权」列为被接受的残余风险；并快速核查 mcp-gateway 的读工具不暴露超出该 JWT 本就可读的内容（凭据、会话/项目元数据之外的文件内容）——若有任一读工具返回凭据或超出会话/项目元数据的文件内容，**停止**，本条改为 needs-human 挂起，不得上线。

<!-- dedup-ref -->
去重（按机制，非症状）：`gap-oauth-consent-page-allow-unreachable-by-scroll`（ready）是同页的**另一个**缺陷（Allow 按钮被全局 `overflow:hidden` 挡住、无法滚动到），其 Notes 已把本任务涉及的四项（登录页措辞、引导打断、scope 风险分组、401 噪声）明确列为出范围；机制不同，保持独立（separate）。合并风险：两任务 Touches 都含 `src/modules/oauth-consent/OAuthConsentRoute.tsx` 与 `e2e/oauth-consent-page.spec.ts`；本任务**不得**动该路由的根/`main` 滚动布局 class（归对方所有），两者都落地时小心合并。`gap-oauth-consent-spa-backend-contract` 与 `gap-oauth-consent-spa-ui`（均 done）是被加固对象的原始交付，本任务是其后续缺陷修复/策略变更，非重复。

## AC

- [x] AC1 红态基线逐字记录（先写判据、改动前运行，各记完整命令与逐字红行）：(1) 全新账号（`has_completed_onboarding=0`）经授权 URL 登录后落在引导而非授权页；(2) 从未登录访问授权路由出现 “Your session expired. Please log in again.”；(5) 只读决定无密码被 `POST /decision` 拒绝（当前行为）。命令形如 `npx playwright test e2e/oauth-consent-page.spec.ts` 与 `node --import tsx --test server/modules/oauth/tests/oauth-consent-page.test.ts`（各单文件运行）。
- [x] AC2 (1) 引导不截断：新增 e2e 场景——全新账号经 `/oauth/consent?...` 登录后落在授权页（URL 路径仍为 consent，页面含 Allow/Deny，不含引导向导元素）；若选方案 B，则引导完成后回到同一授权 URL。`npx playwright test e2e/oauth-consent-page.spec.ts` 退出 0，写下 passed/总数。
- [x] AC3 (2) 登录页措辞：e2e 场景断言从未登录用户访问授权路由时页面**不**含 “session expired” 文案（无横幅或为中性 “Sign in to continue…” 文案）；存有被拒/过期 token 时仍显示“会话已过期”（正控制）。未登录授权路由上 `/api/plugins` 与 `/api/taskmaster/installation-status` 的 401 若已去除，写下控制台 401 计数前后对比；未去除则在 Notes 记 deferred 与原因。
- [x] AC4 (3) 风险分组：`src/modules/oauth-consent/tests/oauthConsentPage.test.tsx` 与 e2e 断言：两组标题存在；`cloudcli:read` 在“读取”组且 checked+disabled；5 个操作类 scope 在“会改变状态的操作”组，**勾选前**每个都带可见风险标签；勾选任一后整体警告仍出现。`GET /api/oauth/authorize/context` 的 `scopes[]` 增量带 `risk`/`group`，伪造/词表外 scope 拒绝行为不变（既有用例不改断言仍绿）。
- [x] AC5 (4) 未验证说明与时效：e2e 与组件测试断言页面可见“应用名称由应用自行提供，未经验证”类说明、客户端登记时间与 `created_via`；新客户端（登记 < 24h 或从未授权）显示更醒目的提示；令牌时效行的数值**等于**服务端 provider 常量经上下文端点返回的值（测试读上下文端点响应而非字面量 3600，并断言源码无硬编码时效数字）。该说明不出现“已验证/可信”措辞。
- [x] AC6 (5) 服务端强制，`server/modules/oauth/tests/oauth-consent-page.test.ts` 与 `oauth-consent-ratelimit.test.ts` 就地更新（不新增任何 `server/**/*.test.ts` 文件），各单文件运行退出 0，并含用例：只读决定无密码 ⇒ 放行并签发授权码；含写 scope 无密码 ⇒ 401；body 看似只读但携带写 scope（伪造）无有效密码 ⇒ 401；词表外 scope 先被丢弃，剩余只读 ⇒ 无密码放行；写 scope + 错密码 ⇒ 被拒且计入限流；只读分支不消耗限流计数；deny 永不需要密码。
- [x] AC7 (5) SPA：组件测试断言仅在勾选写 scope 时出现密码框且此时 Allow 在密码未填前禁用；只读时无密码框且 Allow 可用；`server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts` 单文件运行退出 0，完整 PKCE 链在只读无密码与写 + 密码两种模式下都绿。
- [x] AC8 (5) 读工具核查并记录：检查 mcp-gateway 读工具（至少列出每个 `cloudcli:read` 工具及其返回内容类型），在 Notes 逐字写下结论；若任一读工具返回凭据或超出会话/项目元数据的文件内容，**停止**实现第 5 条，把任务改 `needs-human` 并保持本 AC 未勾，不得伪造结论。
- [x] AC9 取假形态（先提交实现再变异，逐条记录变异 diff、逐字红行与恢复命令，恢复后重跑回绿）：(i) 重新对授权路由启用引导闸门 ⇒ AC2 的全新账号 e2e 红；(ii) 让服务端信任客户端“只读”标志，或仅因 body scope 字面看似只读就跳过密码 ⇒ AC6 的伪造写 scope 用例红；(iii) 去掉决定前的词表外 scope 过滤 ⇒ AC6 的词表外用例红。
- [x] AC10 12 种 locale（de en es fr id it ja ko ru tr zh-CN zh-TW）的 `consent.json` 与 `auth.json` 新增键集合与 `en` 完全一致、值非空且不等于键名；e2e 未翻译字面量检查在授权页与登录页通过。
- [x] AC11 范围纪律：`git diff develop -- src/index.css` 为空；`OAuthConsentRoute.tsx` 的根/`main` 滚动布局 class 行未改（`git diff` 中无这些行）；`package.json` 与 lockfile 无 diff；任何几何读数只用真实输入，测量前不调用 `scrollIntoView`/`scrollIntoViewIfNeeded`。
- [x] AC12 仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）、`npm run test:client` 退出 0；每个被触及的测试文件单独运行（见 `docs/operations/process-isolation-and-memory-caps.md`，不做无界扇出）。
- [x] AC13 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐，列出实际改动文件清单。

## DoD

- 真实浏览器 + 真实服务端（隔离数据目录、一次性用户与 DCR 客户端，同 2026-10-08 走查）逐步走通：全新账号 → 登录 → 落在授权页（不是引导）；只读 Allow 无密码 ⇒ 回调带 `code` + `state`；勾选写 scope ⇒ 出现密码框，错密码被拒、对密码放行；未验证说明与时效行可见；留 1280x900 与 375x812 截图（注明用了足够高的视口或兄弟任务的修复）。
- 第 5 条的放行/拒绝**真的**由服务端的授予集合决定：伪造写 scope 的“只读外观”请求被服务端 401，不是仅 SPA 隐藏密码框；三条取假形态都先红后恢复。
- 第 5 条的安全理由与残余风险（被盗会话 JWT 仍可签发只读授权）、读工具核查结论写入 Notes；核查不通过则 needs-human 挂起而非上线。
- 按 `quay-webui-bootstrap-methodology` 技能做整体视觉评审（分组、风险标签、未验证提示、密码框显隐在桌面与手机上的观感）。
- 遵守 `$backend-module-standards`、`$frontend-module-standards` 与 AGENTS.md；无新依赖；未新增 `server/**/*.test.ts`；不触碰兄弟任务拥有的滚动布局。

## Touches

- src/modules/oauth-consent/OAuthConsentRoute.tsx (仅内容区与密码/分组/说明渲染；不改根与 main 的滚动布局 class)
- src/modules/oauth-consent/hooks/useOAuthConsent.ts
- src/modules/auth/ProtectedRoute.tsx (引导闸门对授权路由的豁免或 URL 恢复，按读码结果)
- src/modules/auth/context/AuthContext.tsx
- src/modules/auth/LoginForm.tsx (登录页中性文案 data-testid/键渲染)
- src/shared/types.ts (授权上下文形状：group/risk/createdAt/createdVia)
- src/modules/i18n/locales/de/consent.json
- src/modules/i18n/locales/en/consent.json
- src/modules/i18n/locales/es/consent.json
- src/modules/i18n/locales/fr/consent.json
- src/modules/i18n/locales/id/consent.json
- src/modules/i18n/locales/it/consent.json
- src/modules/i18n/locales/ja/consent.json
- src/modules/i18n/locales/ko/consent.json
- src/modules/i18n/locales/ru/consent.json
- src/modules/i18n/locales/tr/consent.json
- src/modules/i18n/locales/zh-CN/consent.json
- src/modules/i18n/locales/zh-TW/consent.json
- src/modules/i18n/locales/de/auth.json
- src/modules/i18n/locales/en/auth.json
- src/modules/i18n/locales/es/auth.json
- src/modules/i18n/locales/fr/auth.json
- src/modules/i18n/locales/id/auth.json
- src/modules/i18n/locales/it/auth.json
- src/modules/i18n/locales/ja/auth.json
- src/modules/i18n/locales/ko/auth.json
- src/modules/i18n/locales/ru/auth.json
- src/modules/i18n/locales/tr/auth.json
- src/modules/i18n/locales/zh-CN/auth.json
- src/modules/i18n/locales/zh-TW/auth.json
- server/modules/oauth/oauth-consent.routes.ts
- server/modules/oauth/oauth-consent.service.ts
- server/modules/oauth/oauth-provider.service.ts (授权上下文使用的 provider 常量：登记来源与访问令牌时效)
- shared/oauthConsent.ts (仅当上下文形状在此共享时)
- server/modules/oauth/tests/oauth-consent-page.test.ts (就地更新，不新增文件)
- server/modules/oauth/tests/oauth-consent-ratelimit.test.ts (就地更新，不新增文件)
- server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts (就地更新，PKCE 全链两种模式)
- e2e/oauth-consent-page.spec.ts (新增分组/未验证说明/无密码只读/写需密码/全新账号/登录措辞场景)
- src/modules/oauth-consent/tests/oauthConsentPage.test.tsx
- artifacts/oauth-consent-1280x900.png (DoD 截图)
- artifacts/oauth-consent-375x812.png (DoD 截图)
- artifacts/oauth-consent-desktop-1280x600-allow-scrolled.png (DoD 截图)
- artifacts/oauth-consent-desktop-dark.png (DoD 截图)
- artifacts/oauth-consent-desktop.png (DoD 截图)
- artifacts/oauth-consent-mobile-375x667-allow-scrolled.png (DoD 截图)
- artifacts/oauth-consent-mobile-375x812-allow-scrolled.png (DoD 截图)
- artifacts/oauth-consent-mobile-dark.png (DoD 截图)
- artifacts/oauth-consent-settings-theme-reference.png (DoD 截图)
- tasks/gap-oauth-consent-flow-ux-hardening.md

## Notes

### 红态基线（AC1，逐字）
- **(1) 全新账号（`has_completed_onboarding=0`）经授权 URL 登录后落在引导而非授权页**
  - 变异：`git checkout develop -- src/modules/auth/ProtectedRoute.tsx`（`git diff HEAD` 显示删去 `isOAuthConsentRoute()` 豁免、两处闸门回到 `if (!hasCompletedOnboarding)`）
  - 命令：`npx playwright test e2e/oauth-consent-page.spec.ts`
  - 逐字红行：
    ```
    Error: expect(locator).toBeVisible() failed
    Locator: getByTestId('consent-client-name')
    Expected: visible
    Timeout: 20000ms
    Error: element(s) not found
      > 921 |     await expect(page.getByTestId('consent-client-name')).toBeVisible({ timeout: 20_000 });
             |                                                           ^
    ```
  - 恢复：`git checkout HEAD -- src/modules/auth/ProtectedRoute.tsx`；恢复后重跑 `1 passed (27.0s)`。
- **(2) 从未登录访问授权路由出现 “Your session expired. Please log in again.”**
  - 变异：`git checkout develop -- src/modules/auth/context/AuthContext.tsx`
  - 命令：`npx playwright test e2e/oauth-consent-page.spec.ts`
  - 逐字红行：
    ```
    Error: a never-signed-in visitor must not be told the session expired
    Expected substring: not "Your session expired. Please log in again."
    Received string:        "Welcome Back ... Your session expired. Please log in again. ... Sign In ..."
      > 905 |       .not.toContain(SESSION_EXPIRED_TEXT);
    ```
  - 恢复：`git checkout HEAD -- src/modules/auth/context/AuthContext.tsx`。
- **(5) 只读决定无密码被 `POST /decision` 拒绝（改动前行为）**
  - 变异：`git checkout develop -- server/modules/oauth/oauth-consent.routes.ts server/modules/oauth/oauth-consent.service.ts`
  - 命令：`PATH="$PWD/node_modules/.bin:$PATH" bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/oauth/tests/oauth-consent-ratelimit.test.ts`
  - 逐字红行：
    ```
    ✖ (f) a read-only decision needs no password, mints a code, and spends none of the budget
      AssertionError [ERR_ASSERTION]: every read-only decision must be admitted without a password, got 401,401,401,401,401,401,401,401,401,401
        actual: false, expected: true
    ✖ (i) an out-of-vocabulary scope is dropped before the decision, ...
      AssertionError [ERR_ASSERTION]: after the filter the grant is read-only, so the session alone authorizes it
        401 !== 200
    ```
    控制台：`(i) junk+read scopes, no password -> 401; authorizeCalls=0`
  - 注（判据替换）：仅回退 `oauth-consent.routes.ts` 时，`oauth-consent-page.test.ts` 的 (n) 亦红（`AssertionError: the registration route must be reported`，actual `undefined` expected `'manual'`），而 (o) 保持绿——该 harness 未注入 verifier，只读放行规则只在 ratelimit harness 可见。两处都记录。
  - 恢复：`git checkout HEAD -- server/modules/oauth/oauth-consent.routes.ts server/modules/oauth/oauth-consent.service.ts`；恢复后 ratelimit `9/9 pass`。

### AC9 取假形态（逐条：变异 diff / 逐字红行 / 恢复命令 / 恢复后回绿）
- **(i) 重新对授权路由启用引导闸门 ⇒ AC2 全新账号 e2e 红**
  - 变异 diff（同 AC1(1)）：删除 `isOAuthConsentRoute()` 及两处 `!consentRoute` 豁免
  - 命令：`npx playwright test e2e/oauth-consent-page.spec.ts` → exit 1
  - 逐字红行：`getByTestId('consent-client-name') ... Error: element(s) not found` 于 `e2e/oauth-consent-page.spec.ts:921`
  - 恢复：`git checkout HEAD -- src/modules/auth/ProtectedRoute.tsx` → 重跑 `1 passed`
- **(ii) 服务端信任客户端“只读”标志 ⇒ AC6 伪造写 scope 用例红**
  - 变异 diff：
    ```
    -    const requiresPassword = grant.some((scope) => scope !== OAUTH_CONSENT_READ_SCOPE);
    +    const requiresPassword = body.readonly !== true && grant.some((scope) => scope !== OAUTH_CONSENT_READ_SCOPE);
    ```
  - 逐字红行：`(h) forged read-only-looking write body: no password=200 wrong=200 correct=200`
    `AssertionError [ERR_ASSERTION]: a write scope dressed as read-only must still need a password` / `200 !== 401`（`oauth-consent-ratelimit.test.ts:409`）
  - 恢复：`git checkout HEAD -- server/modules/oauth/oauth-consent.routes.ts` → `9/9 pass`
- **(iii) 去掉决定前的词表外 scope 过滤 ⇒ AC6 词表外用例红**
  - 变异 diff：
    ```
    -    if (!vocabulary.has(scope) || seen.has(scope)) {
    +    if (seen.has(scope)) {
    ```
  - 逐字红行：`(i) junk+read scopes, no password -> 401; authorizeCalls=0`
    `AssertionError [ERR_ASSERTION]: after the filter the grant is read-only, so the session alone authorizes it` / `401 !== 200`（`oauth-consent-ratelimit.test.ts:421`）
  - 恢复：`git checkout HEAD -- server/modules/oauth/oauth-consent.service.ts` → `9/9 pass`

### 第 1 条：方案 A（授权路由豁免引导闸门）
`ProtectedRoute` 在 `src/App.tsx` 中渲染于 `<Router>` **之外**，无路由上下文，不能 `useLocation`；故从 `window.location.pathname` 读，并以 `endsWith(OAUTH_CONSENT_SPA_PATH)` 做后缀判断（兼容反向代理 basename；每个授权 URL 无论带不带 query 都以该常量结尾）。选 A 而非 B：豁免面更小、无状态，不需要跨引导流程携带并恢复授权 URL 与 query；引导向导（Git 身份）与授权 MCP 客户端无关，但 setup 与 login 仍闸门授权路由（授权决定需要真实用户）。

### 第 2 条：措辞与 `hadSessionRef`/latch
`hadSessionRef = useRef(readStoredToken() !== null)` 在挂载时拍下“是否曾有会话”。只有曾持有 token 的访客才在会话失效时看到 “Your session expired…”。从没有 token 的访客看到的是中性的 `login.consentPrompt`（“Sign in to continue authorizing the application.”，`LoginForm` 的 `data-testid="consent-login-hint"`）。
`sessionExpiredNotifiedRef` 是一个 latch：会话失效是状态，不是可被后续请求改写的瞬时错误——它在失效自身引发的重跑（以及 StrictMode 双调用的陈旧闭包）中必须存活，只有 `login`/`register` 清除它。`checkAuthStatus` 因此在 `sessionExpiredNotifiedRef.current` 为真时不再 `setError(null)`，并在两条被拒分支（`!userResponse.ok`、`!payload?.user`）改走 `notifySessionLapsed()`（= `clearSession()` + 有会话时置 error）。根因：`authenticatedFetch`（`src/shared/api.ts:67-69`）在响应带 `X-Auth-Error` 时**无论有无 token** 都 `expireAuthSession()`，而子模块（`PluginsContext`、`TasksSettingsContext`）的挂载请求先于 `AuthProvider` 的监听器，故事件在监听器挂上之前就派发；旧行为在 401 路径 `clearSession()` 但不提示，或误报。

### 第 3 条（deferred）：未登录授权路由的 401 噪声
**未去除（deferred）**。控制台 401 计数前后一致，实测 **4 of 4**：`/api/plugins` ×2、`/api/taskmaster/installation-status` ×2（e2e 打印 `(AC3) pre-login 401s on the consent route: 4 of 4`）。原因：这两个探针由身份提供者的登录前状态驱动，去掉需要改动未登录时的挂载/轮询时序，超出本任务范围且会触及本任务 Touches 之外的前端模块。AC3 的主断言（无横幅 + 中性提示）已达成。

### 第 5 条：安全理由与残余风险
写 scope 授予的是对会话的操作能力，需要密码证明“操作者是账号持有人，而非仅持有会话 JWT”。授予集**由服务端**用 `grantedScopes` 算出并决定是否需要密码，绝不信任客户端标志；只读授权不超出该 JWT 本就能读到的内容，故仅凭会话放行。限流只作用于密码分支；deny 永不需要密码、不消耗预算。**被接受的残余风险：被盗的会话 JWT 仍可签发只读授权。**

### AC8 读工具核查（逐字结论）
读工具目录 `MCP_STAGE3_READ_TOOLS`（`server/modules/mcp-gateway/mcp-gateway.read-tools.ts:88`）列出 **11 个 `cloudcli:read` 工具**：`overview`、`projects_list`、`sessions_list`、`session_get`、`session_read`、`run_get`、`quay_snapshot`、`ui_last_opened_session`、`ui_visible_context`、`ui_clients_list`、`session_search`；返回内容类型分别为：项目概览、项目列表、会话列表、单会话元数据与宿主状态、会话转录（最近消息/用户回合大纲/消息窗口）、单次 run 状态、项目 quay 快照、UI 最后打开的会话、UI 可见上下文、UI 客户端列表、会话搜索——均为会话/项目元数据或转录内容，属该会话 JWT 本就可读范围。对读工具实现做大小写不敏感扫描（`secret|api[_-]?key|password|credential|token`），返回字段中唯一命中是 `mcp-gateway.read-tools.ts:791` 的分页游标（`Continuation token from a previous call. Not stable across calls.`），**不是凭据**。结论：**无读工具返回凭据或超出会话/项目元数据的文件内容，第 5 条继续实施，无需 needs-human。**

### AC10 locale 新增键
对 `develop` 求新增键：`consent.json` 13 个（`scopes.risk.*` ×5、`groups.read`、`groups.write`、`clientUnverified`、`clientRegisteredAt`、`clientRegisteredVia.dcr`、`clientRegisteredVia.manual`、`newClientNotice`、`tokenLifetime`）；`auth.json` 1 个（`login.consentPrompt`）。全部 12 种 locale 均含这些键、值非空且不等于键名（脚本输出 `ALL 12 LOCALES CARRY THE ADDED KEYS`）。`consent.json` 全量键集亦与 `en` 完全一致（42 键）。**既有（非本次新增）缺口**：`errors.sessionExpired` 仅存在于 `en` 与 `id`；`auth.json` 中 `login.footerText`、`register.*` 等 46 个键在 10 种 locale 缺失——均为 develop 基线既存、非本任务新增键，不属 AC10 范围，未改动。e2e 未翻译字面量检查在授权页与登录页通过。

### AC12
`npm run typecheck` 退出 0（三 tsconfig 全过）；`npm run lint` 退出 0，`: error ` 计数 **0**（仅既有 warning）；`npm run test:client` 退出 0：`Test Files 179 passed (179)`、`Tests 1214 passed | 1 skipped (1215)`。逐文件单跑：`oauthConsentPage.test.tsx` 17/17、`oauth-consent-page.test.ts` 16/16、`oauth-consent-ratelimit.test.ts` 9/9、`oauth-flow.e2e.test.ts` 1/1。**首轮 `test:client` flake（与本任务无关）**：`voiceErrorClassification.test.ts` 的 residue guard 报 `voiceEditLabels.test.ts:433` 写的 `__criterion-falsify-cjk-*.ts` 残留（同一次并行 run 内的跨文件竞态）；隔离重跑绿、配对重跑绿、全量重跑绿——记为环境竞态，不改该文件。

### 其他
- `oauthConsentPage.test.tsx` harness 不注入 verifier，故“只读放行/写需密码”的服务端规则在该 harness 之外的 ratelimit harness 与 e2e 可见；服务端 (n) 用例覆盖上下文 provenance。
- 兄弟任务 `gap-oauth-consent-page-allow-unreachable-by-scroll`（Allow 滚动不可达）单独处理，本任务未修；两者共享 `OAuthConsentRoute.tsx` 与 `e2e/oauth-consent-page.spec.ts`，AC11 已确认未回退对方的根/`main` 滚动布局与真实输入判据。
- 无新依赖；未新增 `server/**/*.test.ts`（既有文件就地更新）。