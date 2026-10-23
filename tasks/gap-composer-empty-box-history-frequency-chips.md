---
id: gap-composer-empty-box-history-frequency-chips
title: 输入框空态建议项（第一档）：按历史输入频次在空 textarea 内显示虚线 chip，Tab/鼠标/Enter 填入，不调模型
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

设计与数据依据全文见 `docs/proposals/composer-empty-input-suggestions.md`（人 yale 2026-10-23 已确认外观、Tab 语义、采用方式、窄屏四项）；可交互原型见 `docs/proposals/assets/composer-empty-input-suggestions/prototype.html`。本任务只做**第一档：纯频次检索，不调模型、不联网**。

**行为**：输入框为空且助手空闲时，把「用户过去常发的短输入」最多 3 个，以虚线 chip 显示在 textarea 内部（不新增行）。右侧显示操作提示 `Tab 选择 · ↵ 采用 · Esc 隐藏`。一旦框里有任何字符，chip 全部消失；清空后重现。

**可见条件（全部满足）**：输入为空；非 `isLoading`；命令菜单与文件菜单都未打开；无排队草稿；无附件；输入未被占用（`isOccupied`）；候选数 ≥1；本轮未被 Esc 隐藏。

**键鼠语义**：焦点始终留在 textarea，选择状态走 `aria-activedescendant`，chip 的 `mousedown` 必须 `preventDefault`。Tab 在 chip 间前进，走过最后一个后复位为未选中并**交还给既有 Tab 分支**（`cyclePermissionMode`）；Shift+Tab 反向，走过第一个同样交还；chip 不可见时 Tab 与现状逐字相同。Enter 在有选中 chip 时采用，无选中时保持现状。点击与 Enter 一律「填入再发送」：文本写入输入框（同步 `inputValueRef`，使紧接着的 Enter 发送读到新文本）、光标置末尾、不提交。Esc 隐藏本轮建议，`preventDefault` 并 `stopPropagation`，直到下一个回合边界（`isLoading` 由 true 变 false，或 `draftScope` 变化）。↑/↓ 仍归既有 `useInputHistory`，不受 chip 影响。IME 组字期间 Enter 不得采用 chip。窄屏（≤480px）chip 保持单行、横向滚动、不显示操作提示。

**候选规则（纯函数）**：数据源是 `chat-input-history` 跨全部 scope 聚合（在 `useInputHistory.ts` 新增 `readAllInputHistory()`，不改既有导出的行为）。只收单行、≤60 字、不以 `/` 开头的条目；大小写与尾部标点归一后计数，展示最近一次的原写法；出现 ≥2 次才入选；按频次降序、同频按最近使用；取前 3；没有历史则不显示，**不得硬编码任何种子短语**。

**采纳读数**：`localStorage['chat-suggestion-stats']` 存 `{shown, accepted, hidden, typedAway}` 四个计数，仅本地、不联网。`shown`＝chip 由不可见变为可见（候选非空）的次数；`accepted`＝采用次数；`hidden`＝Esc 隐藏次数；`typedAway`＝chip 可见时输入变为非空且不是由采用造成的次数。它是第三档（LLM 生成）是否值得做的决策依据。

**无障碍与 i18n**：chip 容器 `role="listbox"` 加 `aria-label`，chip 为 `role="option"`。文案键放 `src/modules/i18n/locales/en/chat.json` 与 `zh-CN/chat.json`：`input.suggestions.listLabel`、`input.suggestions.hintSelect`、`input.suggestions.hintAccept`、`input.suggestions.hintHide`；其余语言走 `defaultValue`。第一档不显示来源标签。

**分工（按 `.agents/skills/frontend-module-standards`）**：纯规则放 `src/modules/chat/utils/inputSuggestions.ts`；状态与按键放 `src/modules/chat/hooks/useInputSuggestions.ts`，由 `useChatComposerState.ts` 接入（其 `handleKeyDown` 中排在 `handleHistoryKeyDown` 之后、Tab 分支与 Enter 分支之前）；渲染放 `src/modules/chat/composer/InputSuggestionChips.tsx`，由 `ChatComposer.tsx` 挂在 `PromptInputBody` 内（有 chip 时 placeholder 置空，chip 占位决定 textarea 高度，不新增 `PromptInputHeader` 行；不画进 `inputHighlightRef` 镜像层，那一层 `pointer-events-none`）；`ChatInterface.tsx` 只负责把新增 props 传给 `ChatComposer`。不新增模块目录，类型用 `type`，应用内导入一律 `@/`。新增 state 需在声明处写明为何必要。

**边界**：不碰服务端、不新增 API、不读写 `chat-input-history` 之外的历史来源；不做「回复被截断→继续」与「发送失败→重试」两条场景规则（前者客户端无 `stop_reason` 信号，后者失败时草稿仍留在框里、框不为空；理由见 proposal）；不做设置开关（隐私开关见 proposal 开放问题 1）。

相关但不同机制：`architecture-send-selection-to-chat-entry-points`（把选中实体预填进输入框，不是建议项）。合并判断：`task-granularity-advice` 对三个主要 Touches 文件返回 peers 为空；这三个文件历史上的中位改动行为 446 / 926 / 878，本任务预计 500–700 行，保持单任务。

## AC

- [ ] 纯规则单测通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/inputSuggestions.test.ts` 退出码 0；该文件为下列每一条规则各有一个独立 `it`（一腿一 test）：(a) 按频次降序取前 3；(b) 同频按最近使用；(c) 出现次数 <2 的条目不入选；(d) 多行条目被排除；(e) 超过 60 字的条目被排除；(f) 以 `/` 开头的条目被排除；(g) 大小写与尾部标点归一后合并计数，展示最近一次写法；(h) 空历史返回空数组；(i) 跨 scope 聚合后统计。
- [ ] 历史存储聚合：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/useInputHistory.test.ts` 退出码 0，其中新增一个 `it` 断言 `readAllInputHistory()` 合并多个 scope 的条目，且该文件既有 `it` 的断言行没有被修改或删除（diff 只增不改）。
- [ ] 可见条件逐腿通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/inputSuggestionsComposer.test.tsx` 退出码 0；其中「可见」一个正例，以及下列每个负例各一个独立 `it`：输入非空、`isLoading`、命令菜单打开、文件菜单打开、有排队草稿、有附件、`isOccupied`、候选为空、本轮已 Esc 隐藏。
- [ ] 键盘语义逐腿通过（同一测试文件，每条独立 `it`）：Tab 依次选中第 1、2、3 个 chip；走过最后一个后选中态复位且既有 Tab 分支的 `cyclePermissionMode` 恰好被调用 1 次；Shift+Tab 反向并在越过第一个时同样交还；chip 不可见时 Tab 恰好调用 `cyclePermissionMode` 1 次（与现状一致）；有选中时 Enter 把文本写入输入框与 `inputValueRef` 且不触发 `requestSubmit`；无选中时 Enter 不采用任何 chip；Esc 隐藏并调用 `preventDefault` 与 `stopPropagation`；IME 组字（`isComposing`）期间 Enter 不采用；chip 可见时 ↑ 仍由 `useInputHistory` 召回历史。
- [ ] 鼠标与生命周期逐腿通过（同一测试文件，每条独立 `it`）：chip 的 `mousedown` 被 `preventDefault`；点击后文本填入、光标在末尾、textarea 保持焦点；输入任意字符后 chip 消失，清空后重现；Esc 隐藏在 `isLoading` 由 true 变 false 时恢复；Esc 隐藏在 `draftScope` 变化时恢复；采用后输入变空再次清空时不重复展示被采用的同一批 chip 之外的内容（候选按最新历史重算）。
- [ ] 无障碍与读数通过（同一测试文件，每条独立 `it`）：容器带 `role="listbox"` 与 `aria-label`，chip 为 `role="option"`，选中时 textarea 的 `aria-activedescendant` 指向该 chip 的 id，选中态清除时该属性被移除；`chat-suggestion-stats` 的四个计数按上文定义分别累加，且写入失败（`localStorage` 抛错）时不影响渲染。
- [ ] 相邻既有测试保持绿：以下每个文件单独运行退出码均为 0，`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/composerDraftScoping.test.tsx`、`.../sendOnEnter.test.tsx`、`.../chatComposerResponsive.test.tsx`、`.../composerCompactTier.test.tsx`、`.../chatInterfaceEscapeAbort.test.tsx`。
- [ ] 静态门通过：`npm run typecheck`、`npm run lint`、`bash scripts/with-memory-cap.sh npm run build:client` 退出码均为 0；`bash scripts/with-memory-cap.sh vitest run src/modules/i18n/tests/localeDuplicateKeys.test.ts` 退出码 0。
- [ ] 不联网不调模型：在 `src/modules/chat/utils/inputSuggestions.ts`、`src/modules/chat/hooks/useInputSuggestions.ts`、`src/modules/chat/composer/InputSuggestionChips.tsx` 三个新文件中，`grep -nE "fetch\(|authenticatedFetch|EventSource|from '@/shared/api'"` 无任何输出（退出码 1）。
- [ ] 前端规范：上述三个新文件中，`grep -nE "from '\.{1,2}/"` 与 `grep -nE "^(export )?interface "` 均无输出（退出码 1）；`git diff --name-status` 相对任务起点只出现已有目录下的新增文件，没有新建目录。
- [ ] 文案键就位：`node -e "for (const l of ['en','zh-CN']) { const c = require('./src/modules/i18n/locales/'+l+'/chat.json').input.suggestions; for (const k of ['listLabel','hintSelect','hintAccept','hintHide']) if (typeof c[k] !== 'string' || !c[k].trim()) { console.error(l, k); process.exit(1); } }"` 退出码 0。

## DoD

真实运行页面上的操作与读数，缺一不可；测试与夹具只是必要条件。

- [ ] 用 MCP 浏览器在**隔离实例**（按 AGENTS.md 与 cockpit 隔离实例做法，不碰常驻的 :3001）的真实页面上走完整个交互，截图存 `tmp/` 并贴出：在一个真实会话里通过**真实发送**把「检查进展」发 2 次、「继续」发 2 次、「提交」发 2 次（chip 的首次出现必须由真实送达写入 `chat-input-history` 产生，不得直接写 localStorage 造夹具）；助手空闲、输入为空时 chip 可见；Tab 选中第 1 个；Enter 填入；输入一个字符后 chip 消失；清空后重现；鼠标点击填入；Esc 隐藏；深色主题一张；窄屏 390px 一张。
- [ ] 用 `browser_evaluate` 贴出布局读数：有 chip 与无 chip 时 `PromptInputBody` 高度之差 ≤8px，composer 整体高度之差 ≤8px；窄屏 `document.documentElement.scrollWidth <= window.innerWidth` 且 chip 容器可横向滚动。
- [ ] 贴出完成上述操作后 `localStorage['chat-suggestion-stats']` 的实际值，四个计数均大于 0，证明计数在真实交互中累加而非只在单测里累加。
- [ ] 场景运行器：若存在适用场景，运行 `node scripts/ui-scenario.mjs <scenario.json>` 并贴出 JSON 报告与检查点截图；若没有适用场景，如实写明「无适用场景」及原因，不得伪造。
- [ ] 证伪记录：对「候选规则」(a)–(i) 与「可见条件」负例各临时撤掉对应一条实现，贴出对应 `it` 变红的输出，再恢复；至少覆盖 Tab 交还、Esc 的 `stopPropagation`、`mousedown` 的 `preventDefault` 三处。
- [ ] Esc 的真实验证只在**空闲**会话里进行；在运行中的会话里按 Escape 会中止该轮，不得在真实会话中这样验证。
- [ ] 若实现与 `docs/proposals/composer-empty-input-suggestions.md` 有出入，更新该文档对应段落，并在任务收尾说明出入原因。

## Touches

- `src/modules/chat/utils/inputSuggestions.ts`
- `src/modules/chat/hooks/useInputSuggestions.ts`
- `src/modules/chat/composer/InputSuggestionChips.tsx`
- `src/modules/chat/hooks/useInputHistory.ts`
- `src/modules/chat/hooks/useChatComposerState.ts`
- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/chat/ChatInterface.tsx`
- `src/modules/i18n/locales/en/chat.json`
- `src/modules/i18n/locales/zh-CN/chat.json`
- `src/modules/chat/tests/inputSuggestions.test.ts`
- `src/modules/chat/tests/inputSuggestionsComposer.test.tsx`
- `src/modules/chat/tests/useInputHistory.test.ts`
- `docs/proposals/composer-empty-input-suggestions.md`
- `tasks/gap-composer-empty-box-history-frequency-chips.md`
