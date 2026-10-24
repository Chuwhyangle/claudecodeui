---
id: gap-reply-suggestions-frontend-controller
title: 回复建议前端控制器：去重、缓存、过期响应守卫、展开深度抽成不依赖 React 的对象，hook 只做订阅；响应解析进 api 层
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-composer-chip-single-accept-path
  - gap-reply-suggestions-draw-cache-no-repeat-llm-calls
---
## Proposal

2026-10-24 对本功能前端做了面向对象设计评审（遵循 `.agents/skills/frontend-module-standards`）。`src/modules/chat/hooks/useReplySuggestions.ts`（约 420 行）把两件事、一堆规则和一份手工维护的镜像状态混在一个 hook 里。本任务只做**行为不变的内部重构**：把规则收进一个不依赖 React 的控制器对象，hook 只做订阅。

**现状（已读代码确认）。**

- 同一个 hook 里有 8 个 `useState`（状态、批、序号、loading、展开 chip、展开来源、展开 loading、展开深度）和 8 个以上 `useRef`（`statusRef`、`sessionRef`、`drawRef`、`extractedRef`、`loadingRef`、`mountedRef`、`expansionLoadingRef`、`expansionDepthRef`、`expansionRequestSeqRef`），其中好几个是 state 的手工镜像，为了在异步回调里读到最新值。
- 规则散在各个 `useEffect` 与回调里：同一条助手消息只抽一次（以及缓存任务引入的按会话和消息 id 记的小表）；响应回来时 `sessionRef.current !== sessionId` 的过期守卫（多处重复）；展开链深度上限；展开请求的序号守卫；失败时静默回退。这些都是与 React 无关的纯逻辑，却只能通过渲染一个 hook 来测试。
- 返回值 `UseReplySuggestionsResult` 有 15 个字段，把首抽批、展开批、事件上报、状态混在一起。
- 响应体由 hook 内的手写函数 `readDraw` 校验，而 `src/shared/types.ts` 里已有的 `ReplySuggestionsResult` 并没有被用来约束解析；`api.replySuggestions.*` 返回原始 `Response`，调用方各自 `.json()` 再解析。
- 服务端与前端各定义了一份 `ReplySuggestionsEventName`、`ReplySuggestionsExpansionSource`，没有任何东西保证两边同步。

**目标结构。**

1. **控制器。** 新文件 `src/modules/chat/utils/replySuggestionsController.ts`（体量较大的模块私有逻辑，按规则放 `utils/` 并起描述性文件名），导出 `createReplySuggestionsController(options)`：持有状态与全部规则，对外有 `subscribe(listener)`、`getSnapshot()`、命令方法（报告当前会话与最后助手消息 id 及是否可见、重抽、请求展开、清除展开、上报事件）。内部包含：按「会话 id + 助手消息 id」记批的小表（缓存任务定的容量）、同键只请求一次、统一的过期响应守卫（用请求序号令牌，而不是散落的 `sessionRef` 比较）、展开深度上限、loading 标志、失败静默回退、事件上报的发射后不管。不得 import React。API 调用通过注入的 `api` 对象，时钟可注入，便于测试。
2. **hook 变薄。** `useReplySuggestions` 用 `useSyncExternalStore` 订阅控制器的快照，用一个 `useEffect` 把「会话 id、最后助手消息 id、是否可见」转交给控制器；不再有镜像 ref，不再有手写的过期守卫。
3. **返回值分组。** `UseReplySuggestionsResult` 改为分组：首抽（`chips`、`draw`、`loading`、`redraw`）、展开（`chips`、`source`、`loading`、`depth`、`canExpand`、`request`、`clear`）、`reportEvent`、`enabled` 与 `status`。接收它的 chip 接入处（chip 统一接受入口所在的 hook）随之调整，行为不变。
4. **响应解析进 api 层。** 把 `readDraw` 的校验逻辑移到 `src/shared/api.ts`，`api.replySuggestions.suggest` 解析并校验后返回类型化的 `ReplySuggestionsResult`（非 2xx 或形状不对时返回约定的失败值，由控制器静默回退），调用方不再接触 `Response`；`status` 同理。解析函数按规则就近定义在 `api.ts` 内并有单测。
5. **两端类型同步有机械保证。** 在 `src/shared/tests/` 新增一条测试（或 Node 脚本形式的断言），读取 `server/modules/reply-suggestions/` 与 `src/shared/types.ts` 里的 `ReplySuggestionsEventName`、`ReplySuggestionsExpansionSource` 字面量联合的成员，两边集合不一致就红。
6. **无下标回取。** 确认接受 chip 时不再有用数组下标回头去数组里取文本的路径；`index` 只用于事件上报（批内序号）。

**必须保持的行为（不得回退）。** 首抽只在 chip 能被看到时发生；同一条助手消息只请求一次；切走再切回恢复上一批且不发请求；点「建议」整批替换且只发一次请求；展开链深度上限 5；展开请求的并发与顺序守卫；失败静默回退到习惯 chip；事件上报失败被吞掉；`/status` 关闭时没有请求也没有按钮。

**范围外**：服务端；chip 的接受逻辑；展开实验的行为；提示词。

## AC

- [x] 控制器逐腿通过（不渲染任何组件）：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/replySuggestionsController.test.ts` 退出码 0；独立用例：(a) 同键只请求一次；(b) 助手消息 id 变化时再请求一次；(c) 切到另一个会话再切回，不发请求并恢复上一批；(d) 响应回来时会话已切走，该响应被丢弃（过期令牌）；(e) 重抽得到新一批，替换而非累加，并更新记批的小表；(f) 容量超过上限时最早的键被淘汰；(g) 展开链到深度上限后 `canExpand` 为假；(h) 较早发出的展开请求晚于较新的返回时被丢弃；(i) 请求失败静默回退，快照里没有错误、没有抛出；(j) 事件上报失败被吞掉；(k) 取消订阅后不再通知；(l) 两个控制器实例互相独立；(m) `/status` 为关闭时不发任何抽取请求。
- [x] 控制器不依赖 React：`grep -nE "from 'react'|from \"react\"|useState|useEffect|useRef" src/modules/chat/utils/replySuggestionsController.ts` 无任何输出（退出码 1）。
- [x] hook 变薄：`wc -l src/modules/chat/hooks/useReplySuggestions.ts` 不超过 150；`grep -cE "useRef" src/modules/chat/hooks/useReplySuggestions.ts` 不超过 2；`grep -nE "sessionRef|statusRef|loadingRef|expansionLoadingRef|expansionDepthRef|expansionRequestSeqRef|extractedRef|drawRef" src/modules/chat/hooks/useReplySuggestions.ts` 无任何输出。
- [x] hook 行为沿用既有测试：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/useReplySuggestions.test.tsx src/modules/chat/tests/chatComposerReplyChips.test.tsx` 退出码 0；迁移只改返回值的访问路径与装配，不删用例、不放宽断言（`git diff --stat` 里这两个文件的删除行数与新增行数一并贴出，并说明每处删除的原因）。
- [x] 响应解析进 api 层：`grep -n "readDraw" src/modules/chat/hooks/useReplySuggestions.ts` 无任何输出；`bash scripts/with-memory-cap.sh vitest run src/shared/tests/replySuggestionsApi.test.ts` 退出码 0（新增）；独立用例：合法响应得到 `{chips, draw}`；非字符串元素被丢弃；空白被去除；超过 `maxChips` 被截断；非 2xx 返回失败值；响应体不是对象返回失败值；`status` 的合法与非法响应。`grep -rn "replySuggestions\.\(suggest\|status\)" src --include=*.ts --include=*.tsx | grep -v "src/shared/api.ts" | grep -E "\.json\(\)"` 无任何输出（调用方不再自己 `.json()`）。
- [x] 两端类型同步测试：`bash scripts/with-memory-cap.sh vitest run src/shared/tests/replySuggestionsTypeSync.test.ts` 退出码 0；用例：(a) 两边事件名集合相同；(b) 两边展开来源集合相同；(c) 临时在服务端文件加一个事件名，该测试变红（过程贴在 DoD）。
- [x] 无下标回取：`grep -rnE "replySuggestionChips\[|replyChips\[[a-z]+\]" src --include=*.ts --include=*.tsx` 无任何输出。
- [x] 行为反证：把控制器里的过期令牌守卫临时去掉，(d) 与 (h) 变红；把「同键只请求一次」临时去掉，(a) 与 (c) 变红；恢复后 `git diff` 为空（过程贴在 DoD）。
- [x] 静态门：`npm run typecheck`、`npm run lint` 退出码均为 0。

## DoD

真实页面读数；用**隔离实例**（自己的端口与 `DATABASE_PATH`，`SERVER_SETTINGS_PATH` 指向 `{"residentRestore":{"enabled":false}}`，后端用真实网关的设置副本，不碰常驻 :3001，不重启常驻服务）；真页上**不要按 Escape**；测试会话的提示词里写明「不要写代码、不要调用任何工具」，结束后核对没有留下测试产物。

- [x] 同页来回切换：两个以提问结尾的会话之间来回切换 5 次，贴网络请求列表（`POST /api/reply-suggestions` 只有首次进入的各 1 次）与每次切回时 chip 不变的截图。
- [x] 点「建议」：整批替换，一次 POST，贴截图；连点 3 次，贴网络请求计数。
- [x] 过期响应：在抽取请求在途时切换到另一个会话（可用浏览器的网络节流延迟该请求），贴截图证明旧会话的 chip 没有出现在新会话里。
- [x] 展开实验开启（设置文件改成 `vary`）：点模型 chip 触发展开，连续展开到深度上限，贴每一步的请求次数与最后一步的截图；上限处展开 chip 不再出现。
- [x] 把设置里的模型改成错的：抽取失败后界面只剩习惯 chip，控制台无未处理错误；贴截图与控制台读数。
- [x] 贴出改动前后 `useReplySuggestions.ts` 的行数与 `useRef`、`useState` 个数，以及 `replySuggestionsController.ts` 的行数与对外导出清单。

### 验证证据（2026-10-24，worker 会话）

**隔离实例。** 端口 `3109`，`DATABASE_PATH=<worktree>/tmp/e2e-reply-controller/auth.db`（常驻库的 sqlite `backup` 副本），`SERVER_SETTINGS_PATH`=`{"residentRestore":{"enabled":false}}`，`REPLY_SUGGESTIONS_SETTINGS_PATH` 是 `~/.config/claudecodeui/reply-suggestions.settings.json` 的副本（真实网关 `http://127.0.0.1:26510/`、`v4.1flash`；`apiKeyFile` 改成绝对路径），`HOME` 指向隔离目录（用量日志落在 `tmp/e2e-reply-controller/home/.cloudcli/reply-suggestions-usage.jsonl`，不写常驻日志）。常驻 `:3001`（pid 2465137）全程在听，未重启。真页用一次性 Playwright 驱动（本会话无 MCP 浏览器）：`tmp/e2e-reply-controller/dod.mjs`，结构化报告 `tmp/e2e-reply-controller/report.json`（`ok: true`），截图在 `tmp/e2e-reply-controller/shots/`。真页从未按 Escape。两个会话都是**既有、以提问结尾**的会话，全程没有发送任何消息，因此没有新增转写，也没有「不要写代码/不要调用工具」的测试提示词需求。验证物全在 gitignored `tmp/`。

- 会话 A `6a15ecf0-7582-4092-b59d-c0646dd41ae9`
- 会话 B `108953ba-05bc-4b92-bf9d-13da81ad0aee`

**1）同页来回切换 5 次。** A→B→A→B→A→B：`POST /api/reply-suggestions` 总数 2（首进 A 1 次、首进 B 1 次），5 次切换后计数不变；每次切回的 chip 与首次进入逐字相同（`matchesFirst: true` ×5）。截图：`shots/leg1-00-first-a.png`、`leg1-01-session-b.png`、`leg1-02-session-a.png`、`leg1-03-session-b.png`、`leg1-04-session-a.png`、`leg1-05-session-b.png`。

**2）点「建议」。** 一次 POST，整批替换（进入时的 3 条 → 新批 2 条），截图 `leg2-01-after-suggest.png`；同一帧连点 3 次，`POST` 只增加 1（控制器同步的 loading 守卫把其余两次折叠掉），截图 `leg2-02-after-triple-click.png`。

**3）过期响应。** 用 Playwright 路由把 `POST /api/reply-suggestions` 延迟 3 秒；在 B 点「建议」后 150ms 切到 A。A 到达时与 4.5 秒后（旧请求已返回）的 chip 完全一致；旧会话的 chip 没有出现在 A（`leaked: false`）。截图 `leg3-01-stale-dropped.png`。

**4）展开实验（设置文件改成 `expansion: "vary"` 后刷新）。** 点模型 chip 触发展开；逐步点展开 chip，每一步的 expand 请求计数为 1→2→3→4→5；深度 5 时 `canExpand` 为假：该批 chip 仍显示（供最后一次选择），再点一次只清除、不再发请求（`extraPostsAtCap: 0`），展开行消失。截图 `leg4-01-expand-1.png` … `leg4-05-expand-5.png`、`leg4-06-at-cap-final.png`。

**5）模型改成错的（同时 bump `version` 以绕开服务端缓存）。** 抽取请求返回 502；界面只剩习惯 chip（`收到，我看看`，来自浏览器历史），没有模型 chip；`window.__unhandled` 为空，无 `pageerror`、无未处理 rejection（控制台只有 Chromium 对 502 与既有外部 GitHub 403 的资源加载行）。截图 `leg5-01-failed-draw-habits-only.png`。

**6）改动前后读数。** `useReplySuggestions.ts`：536 行 → 146 行；`useState` 9 处 → 0；`useRef` 11 处 → 0。`replySuggestionsController.ts` 603 行，对外导出：`REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH`、`REPLY_SUGGESTIONS_BATCH_CACHE_SIZE`、`ReplySuggestionsClock`、`ReplySuggestionsBatchCache`、`createReplySuggestionsBatchCache`、`replySuggestionsBatchCache`、`resetReplySuggestionsBatchCache`、`ReplySuggestionsApi`、`ReplySuggestionsContext`、`ReplySuggestionsSnapshot`、`ReplySuggestionsController`、`createReplySuggestionsController`。

**AC4 说明（两个既有测试文件的增删）。** `useReplySuggestions.test.tsx` +85/−82，`chatComposerReplyChips.test.tsx` +20/−55；两个文件的 `it(` 用例数前后均为 22 / 24，未删用例、未放宽断言。删除行只有两类：(1) 扁平返回值访问路径改成 `firstDraw.*` / `expansion.*`（`chips`、`draw`、`loading`、`redraw`、`expansionEnabled`、`expansionChips`、`expansionSource`、`expansionDepth`、`canExpand`、`requestExpansion`、`clearExpansion`）；(2) mock 装配从 Response 形状（`{ ok, json }`）改成 typed return，失败用例用 `Promise.resolve(null)`（non-2xx 的约定失败值），并删掉不再需要的 `okJson` 包装。展开 chip 的接受调用改为 `(text, index)`。

**行为反证过程。**
- 去掉过期令牌守卫（抽取与展开两处 `requestId !== seq || session differs` 判定），重跑控制器测试：`(d) drops a response whose session was left...` 与 `(h) drops an older expansion answer...` 变红，其余 11 条绿。
- 去掉「同键只请求一次」（`extractedKey === key` 早退 + 缓存恢复分支），重跑：`(a)`、`(c)`、`(e)` 变红（(e) 也依赖记批小表的恢复），其余 10 条绿。
- 两处均先 `cp` 备份再恢复；恢复后 sha256 与备份一致、13 条用例全绿。控制器文件本次新增，因此以备份哈希比对代替 `git diff`；`git status` 无它的未提交差异。
- 类型同步反证：临时在 `server/modules/reply-suggestions/reply-suggestions.service.ts` 的 `ReplySuggestionsEventName` 加 `'viewed'`，`(a) both ends name the same ledger events` 变红；恢复后 3 条绿、`git status -- server/` 为空。

## Touches

- `src/modules/chat/utils/replySuggestionsController.ts`
- `src/modules/chat/hooks/useReplySuggestions.ts`
- `src/modules/chat/hooks/useSuggestionChips.ts`
- `src/modules/chat/hooks/useChatComposerState.ts`
- `src/modules/chat/composer/ChatComposer.tsx`
- `src/shared/api.ts`
- `src/shared/types.ts`
- `src/modules/chat/tests/replySuggestionsController.test.ts`
- `src/modules/chat/tests/useReplySuggestions.test.tsx`
- `src/modules/chat/tests/chatComposerReplyChips.test.tsx`
- `src/modules/chat/tests/suggestionChipAcceptContract.test.tsx`
- `src/shared/tests/replySuggestionsApi.test.ts`
- `src/shared/tests/replySuggestionsTypeSync.test.ts`
- `tasks/gap-reply-suggestions-frontend-controller.md`
