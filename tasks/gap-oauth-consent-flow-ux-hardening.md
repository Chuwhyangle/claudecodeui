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

- [ ] AC1 红态基线逐字记录（先写判据、改动前运行，各记完整命令与逐字红行）：(1) 全新账号（`has_completed_onboarding=0`）经授权 URL 登录后落在引导而非授权页；(2) 从未登录访问授权路由出现 “Your session expired. Please log in again.”；(5) 只读决定无密码被 `POST /decision` 拒绝（当前行为）。命令形如 `npx playwright test e2e/oauth-consent-page.spec.ts` 与 `node --import tsx --test server/modules/oauth/tests/oauth-consent-page.test.ts`（各单文件运行）。
- [ ] AC2 (1) 引导不截断：新增 e2e 场景——全新账号经 `/oauth/consent?...` 登录后落在授权页（URL 路径仍为 consent，页面含 Allow/Deny，不含引导向导元素）；若选方案 B，则引导完成后回到同一授权 URL。`npx playwright test e2e/oauth-consent-page.spec.ts` 退出 0，写下 passed/总数。
- [ ] AC3 (2) 登录页措辞：e2e 场景断言从未登录用户访问授权路由时页面**不**含 “session expired” 文案（无横幅或为中性 “Sign in to continue…” 文案）；存有被拒/过期 token 时仍显示“会话已过期”（正控制）。未登录授权路由上 `/api/plugins` 与 `/api/taskmaster/installation-status` 的 401 若已去除，写下控制台 401 计数前后对比；未去除则在 Notes 记 deferred 与原因。
- [ ] AC4 (3) 风险分组：`src/modules/oauth-consent/tests/oauthConsentPage.test.tsx` 与 e2e 断言：两组标题存在；`cloudcli:read` 在“读取”组且 checked+disabled；5 个操作类 scope 在“会改变状态的操作”组，**勾选前**每个都带可见风险标签；勾选任一后整体警告仍出现。`GET /api/oauth/authorize/context` 的 `scopes[]` 增量带 `risk`/`group`，伪造/词表外 scope 拒绝行为不变（既有用例不改断言仍绿）。
- [ ] AC5 (4) 未验证说明与时效：e2e 与组件测试断言页面可见“应用名称由应用自行提供，未经验证”类说明、客户端登记时间与 `created_via`；新客户端（登记 < 24h 或从未授权）显示更醒目的提示；令牌时效行的数值**等于**服务端 provider 常量经上下文端点返回的值（测试读上下文端点响应而非字面量 3600，并断言源码无硬编码时效数字）。该说明不出现“已验证/可信”措辞。
- [ ] AC6 (5) 服务端强制，`server/modules/oauth/tests/oauth-consent-page.test.ts` 与 `oauth-consent-ratelimit.test.ts` 就地更新（不新增任何 `server/**/*.test.ts` 文件），各单文件运行退出 0，并含用例：只读决定无密码 ⇒ 放行并签发授权码；含写 scope 无密码 ⇒ 401；body 看似只读但携带写 scope（伪造）无有效密码 ⇒ 401；词表外 scope 先被丢弃，剩余只读 ⇒ 无密码放行；写 scope + 错密码 ⇒ 被拒且计入限流；只读分支不消耗限流计数；deny 永不需要密码。
- [ ] AC7 (5) SPA：组件测试断言仅在勾选写 scope 时出现密码框且此时 Allow 在密码未填前禁用；只读时无密码框且 Allow 可用；`server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts` 单文件运行退出 0，完整 PKCE 链在只读无密码与写 + 密码两种模式下都绿。
- [ ] AC8 (5) 读工具核查并记录：检查 mcp-gateway 读工具（至少列出每个 `cloudcli:read` 工具及其返回内容类型），在 Notes 逐字写下结论；若任一读工具返回凭据或超出会话/项目元数据的文件内容，**停止**实现第 5 条，把任务改 `needs-human` 并保持本 AC 未勾，不得伪造结论。
- [ ] AC9 取假形态（先提交实现再变异，逐条记录变异 diff、逐字红行与恢复命令，恢复后重跑回绿）：(i) 重新对授权路由启用引导闸门 ⇒ AC2 的全新账号 e2e 红；(ii) 让服务端信任客户端“只读”标志，或仅因 body scope 字面看似只读就跳过密码 ⇒ AC6 的伪造写 scope 用例红；(iii) 去掉决定前的词表外 scope 过滤 ⇒ AC6 的词表外用例红。
- [ ] AC10 12 种 locale（de en es fr id it ja ko ru tr zh-CN zh-TW）的 `consent.json` 与 `auth.json` 新增键集合与 `en` 完全一致、值非空且不等于键名；e2e 未翻译字面量检查在授权页与登录页通过。
- [ ] AC11 范围纪律：`git diff develop -- src/index.css` 为空；`OAuthConsentRoute.tsx` 的根/`main` 滚动布局 class 行未改（`git diff` 中无这些行）；`package.json` 与 lockfile 无 diff；任何几何读数只用真实输入，测量前不调用 `scrollIntoView`/`scrollIntoViewIfNeeded`。
- [ ] AC12 仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）、`npm run test:client` 退出 0；每个被触及的测试文件单独运行（见 `docs/operations/process-isolation-and-memory-caps.md`，不做无界扇出）。
- [ ] AC13 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐，列出实际改动文件清单。

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
- shared/oauthConsent.ts (仅当上下文形状在此共享时)
- server/modules/oauth/tests/oauth-consent-page.test.ts (就地更新，不新增文件)
- server/modules/oauth/tests/oauth-consent-ratelimit.test.ts (就地更新，不新增文件)
- server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts (就地更新，PKCE 全链两种模式)
- e2e/oauth-consent-page.spec.ts (新增分组/未验证说明/无密码只读/写需密码/全新账号/登录措辞场景)
- src/modules/oauth-consent/tests/oauthConsentPage.test.tsx
- tasks/gap-oauth-consent-flow-ux-hardening.md

## Notes

- 兄弟任务 `gap-oauth-consent-page-allow-unreachable-by-scroll`（Allow 滚动不可达）单独处理，本任务不修；两者共享 `OAuthConsentRoute.tsx` 与 `e2e/oauth-consent-page.spec.ts`，合并时小心，尤其不要回退对方的根/`main` 滚动布局与真实输入判据。
- 第 1 条选 A 还是 B 的理由由执行者读码后写在此处（倾向 A：豁免面小，且不需要跨引导流程携带状态）。
- 第 5 条安全理由（执行者落地时补全）：写 scope 授予的是对会话的操作能力，需要密码证明“操作者是账号持有人而非仅持有会话 JWT”；只读授权不超出该 JWT 本就能读到的内容，故仅凭会话放行。**被接受的残余风险**：被盗的会话 JWT 仍可签发只读授权。读工具核查结论见 AC8，须逐字写入此处。
- 立案时限制：立案代理无 shell/grep，未能核查 mcp-gateway 读工具与现有测试文件内容，故 AC8 的核查与各 Touches 的“按读码结果”补全交由执行者；Touches 中遗漏的文件按读码补入。
- 仓库钉住服务端测试文件数：只改既有 `server/**/*.test.ts`，不新增。
