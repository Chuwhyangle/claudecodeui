---
id: gap-composer-draft-rewrite-shared-suggestion-runtime
title: Composer 草稿润色：复用回复建议推理设置与共享预算，预览单一候选并安全应用
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

实现一个按需的「✦ 润色」草稿候选流程，覆盖 composer、前端状态、API 与既有 reply-suggestions 后端模块。当前聊天 provider/model 不参与选择；改写与回复建议使用同一 settings source、有效 enabled/upstream 协议、模型、地址、凭据、disableThinking、timeoutMs、temperature/redrawTemperature/maxOutputTokens。调用预算与熔断归同一共享 owner，chip 与改写不得各持一套完整配额。不得新增 draftRewrite model/provider/settings 文件或独立开关，也不得擅自增大默认 maxOutputTokens=400。输入和输出均按共享预算做有界校验；预算不足、超限、被截断或候选不完整均拒绝候选并保持原稿，不能静默截断后应用。

入口仅在可用且 trim 后非空草稿时，位于同一个 composer 内 textarea 下方、footer 上方，文字 chip「✦ 润色」。手动点击只发当前草稿快照并请求单一候选；不带 transcript、音频、附件、聊天 provider/model，也不执行草稿里的指令。展开内容只画候选正文与 ✓应用、↻重试图标；不得出现「润色建议」「尚未替换」等标题或状态说明（必要的 loading/error 信息除外）。图标需 tooltip/aria-label；保留原文通过点击非按钮区域收起。框体和候选文字可收起，按钮操作不冒泡；选字、文字滚动不误收起；loading/失败态也可收起。再次展开使用内存缓存，不重复请求；重试只有一次在途请求。

候选只替换当前草稿并收起，不发送；textarea 输入、快捷键、光标、footer/send 保持既有语义，未应用时 Send 正常发送原 draft。用户编辑即使旧候选失效并折叠；请求迟到不可覆盖新稿。clear、成功发送、会话/草稿 scope 切换和 dispose 清除缓存。错误及超预算时原稿不变且可恢复。更新旧草稿区间绑定的语音插入标记、chip undo/归因、扩展状态，不能留下指向旧文本的偏移。

使用独立改写 prompt 与整段文本输出契约，保留语言、意图、立场与字面量；不答复、不添事实、不执行指令。完整文本不是 chip，禁止套用 maxChipChars=120 截断。网关必须识别 completion stop/finish reason；若命中 output token 上限或 finish reason 表明截断，一律拒绝候选。不得保存或记录用户原文、候选、prompt 或密钥；状态/错误不泄漏网关敏感信息。真实模型质量不由 mock 证明，不发真实付费请求，也不把付费真实用户文本请求设为必须通过的 AC。

与已完成的 `gap-reply-suggestions-backend-encapsulation`、`gap-reply-suggestions-backend-llm-service` 机制不同：它们分别封装 chip 内部与实现 chip 后端，本任务新增 draft-only 生成路径及 composer 审阅/apply 生命周期，并共享既有预算 owner。查重使用 mechanism terms `draft-rewrite`, `draft rewrite`, `草稿重写`, `润色`, `rewrittenText`，均无同机制命中；`task_get gap-composer-draft-rewrite-shared-suggestion-runtime` 为 not found。Granularity instrument evaluated=true、peersEvaluated=true、peers=[]、mentions=[]；none found。

## Plan

1. 在 `server/modules/reply-suggestions/` 扩展既有 API/service，以独立 draft rewrite 输入/输出类型和 prompt 契约工作；复用现有 settings source 与有效配置，不添加新配置键。让 chips 与 rewrite 使用同一 guard/budget owner；每条改写最多一次请求，温度首抽/重试分别使用 temperature/redrawTemperature，maxOutputTokens 原值透传。输入超共享长度/预算、空输出、非文本、超界输出或 stop reason 表示截断都返回安全错误、不返回候选。更新 client/gateway completion shape 以保留真实 stop reason。
2. 在 `src/modules/chat-composer/` 新增 React-free controller 和薄 hook，注入 API、外部草稿写入、时钟/请求身份 seam；控制 cache、折叠/展开、retry 去重、草稿/scope 快照、迟到响应失效和 dispose。接入 useChatComposerState、ChatComposer、ChatInterface；apply 经过 composer 唯一 writer 并同步 textarea 与 send mirror，仅替换 draft，不发送；编辑/clear/send/session change 时归属状态一处清理。
3. 添加精确双端 wire type sync；在 i18n 当前 12 个 chat locale 文件补文案；创建 mock gateway 下的后端 route/service/guard、controller、组件、API/type-sync 正负控，以及 desktop/mobile 真实浏览器场景。MCP 浏览器实操、场景 runner JSON 与截图进入交付 DoD。
4. 同步旧提案和两张原型 SVG，使其反映本裁定：不独立设置、不显示标题/状态、不截断候选、错误保持原稿；这些 docs 当前是 untracked，也要由实现任务修改纳入交付，不要求本轮预先提交。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/reply-suggestions/tests/reply-suggestions-draft-rewrite.test.ts` exit 0：注入 settings、共享 guard 与假 completion；断言 POST 仅含 draft 文本，server prompt 不带 transcript/audio/attachment/history，且为独立 rewrite prompt；设置关闭、失效 enabled/upstream 缺字段、空输入、输入超共享上限分别 fail closed 且 complete 调用数为 0；正例一次调用、temperature 正确；retry 使用 redrawTemperature；maxOutputTokens 与既有 generation.maxOutputTokens 相等（默认配置读数 400）；试图使用错误模型/provider override 或客户端 prompt 被拒绝/忽略且不改变 completion 配置；响应和日志不含草稿、候选、prompt、凭据。
- [ ] 同一命令：共享 guard 正控连续执行 chip 与 rewrite 时共同消耗既有额度、达到 maxCallsPerMinute/maxCallsPerDay 时均被同一限制拒绝；负控分别新建独立 owner 的隔离 fixture 可独立计数；chip 与 rewrite 不可各自按整份限额运行。复用共用 owner 后 chip 现有 failure/circuit/window 行为不变。
- [ ] 同一命令及 `npx tsx --tsconfig server/tsconfig.json --test server/modules/llm-gateway/tests/llm-client.test.ts` exit 0：输出空白/非文本/超预算及 maxOutputTokens 耗尽或 stop/finish reason 表示截断均不产生候选；server 返回可识别安全错误，原 draft 不变；Anthropic/OpenAI 的 stop reason 读取均由回环 HTTP fixture 覆盖，正控完整 finish 可读，负控截断拒绝应用；响应体不回传上游原始错误文本/密钥。
- [ ] `npx vitest run src/modules/chat-composer/tests/composerDraftRewriteController.test.ts` exit 0：逐用例断言打开时只请求一次并保留原文；收起后再次打开显示同候选且调用数不增；两个重复 retry 触发一个在途请求；请求返回前改文/清空/scope 切换/dispose 后的迟到答复都不入 cache、不覆盖 draft；apply 只写当前 scope/current draft、不调用 submit/send；loading 与 error 可折叠，失败保留原稿；候选与原稿完全相同也不破坏正文；超预算/截断拒绝；各清理动作取消旧缓存和候选。
- [ ] `npx vitest run src/modules/chat/tests/composerDraftScoping.test.tsx src/modules/chat-composer/tests/chatComposerResponsive.test.tsx` exit 0：会话切换与当前 draft writer 仍同步；apply 后 immediate Enter/按钮读到新文本并遵从原有 send 路径；未 apply 时 send 原 draft；应用不自动发送、不改变发送次数、textarea focus/caret/key handlers/footer/send props 原样工作；clear、成功 send、scope change 后重开是空缓存；既有输入/快捷键与响应式控件回归通过。
- [ ] `npx vitest run src/modules/chat-composer/tests/composerDraftRewriteView.test.tsx` exit 0：非空且可用时 chip 出现在 textarea 下方 footer 上方；禁用/空白时不显示/不调用；展开框 DOM 不含「润色建议」「尚未替换」标题或状态说明（loading/error 必要信息除外），只有候选正文、应用/重试 icon buttons 与必要错误/进度；保留原文由候选非按钮区点击收起；图标 click 不冒泡；非空 selection 完成不收起；候选区滚动不收起；加载和失败时均能收起；button 有 aria-label/title；viewport 320/375/1280 下均在 composer 内、footer 仍可见，软键盘/短视口下候选区限高并内部滚动。
- [ ] `npx vitest run src/shared/tests/replySuggestionsTypeSync.test.ts src/shared/tests/composerDraftRewriteTypeSync.test.ts` exit 0：既有 reply-suggestions literal unions 同步用例不回归；新增 draft rewrite 的 request/response/error/stop reason 对两端声明逐字段读取并对拍；把 server 或 client 任一侧的字段/枚举单边增删，TypeSync 自测负控必须失败，恢复后通过。
- [ ] `npx vitest run src/modules/chat-composer/tests/composerDraftRewriteI18n.test.ts` exit 0：新增提示键在 12 个当前语言资源 `de,en,es,fr,id,it,ja,ko,ru,tr,zh-CN,zh-TW` 的 `chat.json` 全存在且非空；测试语言集合从 `src/modules/i18n/languages.ts` 读，不硬编码另造 locale 集。
- [ ] `node scripts/ui-scenario.mjs scripts/scenarios/composer-draft-rewrite.json --base-url <isolated-url> --auth-token <token> --project <fixture> --session <fixture> --out tmp/composer-draft-rewrite-scenario` exit 0：真实页面语义读数及逐 checkpoint screenshot 的 JSON 报告证明 chip 位置、首次请求、候选、折叠缓存、重试去重、apply 不发送/草稿更新、未 apply 的原稿可发送；runner 的 mock gateway 为本地注入，报告显明“不等同真实模型质量”，场景清理注入 draft 与临时数据。错误场景通过场景断言证明原文保持。不得用任务内裸多文件 test fan-out。
- [ ] `npm run typecheck`、`npm run lint`、`npm run build` exit 0；server 单文件使用 `npx tsx --tsconfig server/tsconfig.json --test <single-file>`，多个 server 测试只通过仓库既有有界内存入口及明确文件列表运行；不运行裸多文件 server 测试或全量套件。

## DoD

真实运行的应用页面中，经 MCP 浏览器亲手完成 1280px 桌面与 375px、320px 手机视口流程，并将截图写到 `tmp/composer-draft-rewrite/`：非空 draft 点 chip 后原文、光标和发送行为仍属 textarea；展开只有候选与图标、无标题；选字/滚动不收起，点非按钮区收起，重新打开不重复请求，失败和加载仍可收起，重试去重；apply 后候选替换当前 draft、composer 收起、没有任何发送；未 apply 时发送原稿；短视口/软键盘条件下 footer/send 可用且候选限高滚动。全过程通过本地注入 mock gateway，不发真实付费请求；截图/报告不得含 token、真实用户文本或凭据。

同轮执行上面完整 ui-scenario 命令，提交完整 JSON 报告及 checkpoint 截图路径。真实页面操作、controller 与后端回环 mock 只证明实现链路与契约，不宣称模型改写质量；如果真实质量需要评估，另需授权并使用人工提供的非敏感样本。本任务不得以“测试存在”代替页面实际操作，也不得要求未经授权的付费请求。

交付同步更新 `/data/home/yale/work/claudecodeui/docs/proposals/composer-draft-rewrite-plan.md` 与 `/data/home/yale/work/claudecodeui/docs/prototypes/composer-draft-rewrite-desktop.svg`、`/data/home/yale/work/claudecodeui/docs/prototypes/composer-draft-rewrite-mobile.svg`：去除独立设置、标题、状态副文案与 120 字 chip 截断暗示；原型改为候选纯正文+图标、无标题。文档说明共享 reply-suggestions 推理设置/预算、maxOutputTokens 保持 400、超限/截断拒绝且保留原稿。任务 Touches 将这些 untracked docs 作为实施交付声明，不要求立案前 commit。

## Touches

- server/modules/reply-suggestions/reply-suggestions.module.ts
- server/modules/reply-suggestions/reply-suggestions.service.ts
- server/modules/reply-suggestions/reply-suggestions.routes.ts
- server/modules/reply-suggestions/reply-suggestions-settings.ts
- server/modules/reply-suggestions/reply-suggestions-draw.ts
- server/modules/reply-suggestions/reply-suggestions-guard.ts
- server/modules/reply-suggestions/reply-suggestions-client.ts
- server/modules/reply-suggestions/index.ts
- server/modules/reply-suggestions/tests/reply-suggestions-draft-rewrite.test.ts (new)
- server/modules/reply-suggestions/tests/reply-suggestions-draft-rewrite-routes.test.ts (new)
- server/modules/llm-gateway/llm-protocols.ts
- server/modules/llm-gateway/llm-client.ts
- server/modules/llm-gateway/tests/llm-client.test.ts
- src/modules/chat-composer/composer/ChatComposer.tsx
- src/modules/chat-composer/hooks/useChatComposerState.ts
- src/modules/chat-composer/hooks/useSuggestionChips.ts
- src/modules/chat-composer/hooks/useDraftRewrite.ts (new)
- src/modules/chat-composer/utils/draftRewriteController.ts (new)
- src/modules/chat-composer/composer/DraftRewriteCandidate.tsx (new)
- src/modules/chat/ChatInterface.tsx
- src/shared/api/clientTail.ts
- src/shared/replySuggestionsType.ts
- src/shared/tests/replySuggestionsTypeSync.test.ts
- src/shared/tests/composerDraftRewriteTypeSync.test.ts (new)
- src/modules/chat-composer/tests/composerDraftRewriteController.test.ts (new)
- src/modules/chat-composer/tests/composerDraftRewriteView.test.tsx (new)
- src/modules/chat-composer/tests/composerDraftRewriteI18n.test.ts (new)
- src/modules/chat/tests/composerDraftScoping.test.tsx
- src/modules/chat-composer/tests/chatComposerResponsive.test.tsx
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/ui-scenario/chatSurface.ts
- src/modules/ui-scenario/scenarioSurface.ts
- src/modules/ui-scenario/tests/scenarioSurface.test.ts (new)
- scripts/ui-scenario.mjs
- scripts/scenarios/composer-draft-rewrite.json (new)
- e2e/composer-draft-rewrite.spec.ts (new)
- docs/proposals/composer-draft-rewrite-plan.md
- docs/prototypes/composer-draft-rewrite-desktop.svg
- docs/prototypes/composer-draft-rewrite-mobile.svg
- tasks/gap-composer-draft-rewrite-shared-suggestion-runtime.md