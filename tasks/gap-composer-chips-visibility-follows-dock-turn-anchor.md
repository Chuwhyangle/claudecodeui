---
id: gap-composer-chips-visibility-follows-dock-turn-anchor
title: 输入框建议 chip 的可见条件与状态条同源：坞判定回合进行中（含服务端确认的 turn anchor）时不显示 chip，键盘也不接管
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

**症状。** 空输入框的建议 chip 在助手回合还在进行时仍然显示。人工在隔离实例里的两张真实页面截图里，输入框上方的状态条分别读作「Waiting for the server… 15s」「Writing… 35s」，而 chip 同时可见；此时 composer 的提交键是空闲态。

**根因（读代码，已定位到行）。** 两处用的不是同一个活性来源：

- chip 的可见条件在 `src/modules/chat/hooks/useInputSuggestions.ts` 的 `visible`，其中 `!isLoading` 的 `isLoading` 是 `useChatSessionState.ts` 里的 `isProcessing = processingSessions.get(...) !== null`，即**客户端本地**的忙标记。
- 状态条（`ActivityIndicator`）的显示由 `src/modules/chat/utils/voice/activityDockView.ts` 的 `deriveActivityDockView` 决定：`activity === null && !hasTurnAnchor` 才隐藏，也就是 **`activity !== null` 或 `hasTurnAnchor`（`useActivityFreshness` 里由服务端 `activity.*` 帧确认的回合锚点）任一成立，坞都显示回合进行中**。

两路各自由不同的帧喂养，正常一轮里同步，一旦服务端认为回合在跑而本地标记已清空（本地标记被撤回、别的客户端或语音发起的回合、刷新后恢复），就分叉：坞说在跑，chip 仍然显示。

**要做的事：让 chip 的可见条件也服从坞自己的判定。** 坞的判定为 `in-turn` 或 `unreachable`（`deriveActivityDockView` 的 `state`）时，chip 必须不显示，并且键盘不接管（Tab、Enter、Esc 都不被 chip 消费，Tab 照常交给既有的权限模式分支）。显示与按键共用同一个 `visible`，不得出现「看不见却吃键」。

**同源的做法（约束，不限定文件名以外的实现细节）。**

- 新增 `src/modules/chat/hooks/useActivityDockTurn.ts`，导出一个 hook：入参 `sessionId`、`activity`、`sendFailed`，内部用 `useActivityFreshness(sessionId)` 加 `deriveActivityDockView`（与 `ChatComposer.tsx` 现有的 `composerDock` 同样的入参），返回「坞当前是否在画一个回合」的布尔值（`state` 为 `in-turn` 或 `unreachable`）。**判定只能来自 `deriveActivityDockView`，不得在别处重写 `activity !== null || hasTurnAnchor` 之类的条件。**
- `useInputSuggestions.ts` 增加一个**可选**入参 `isDockTurnShown`（缺省 false，不得改成必填，以免逼改其他既有调用与测试），为 true 时 `visible` 为 false。
- `useChatComposerState.ts` 增加同名**可选**参数并透传；`ChatInterface.tsx` 用新 hook 算出该值后传入。`useInputSuggestions.ts` 与 `useChatComposerState.ts` 里不得出现对原始 `hasTurnAnchor` 的读取，它们只认这个布尔值。

**锚点可能陈旧，方向要写清。** `hasTurnAnchor` 历史上出过「永不清除」的缺陷（`gap-activity-dock-heartbeat-never-clears-turn-anchor`，已修）。同源之后，一旦锚点陈旧，chip 会少出现而不会多出现，这是安全方向，也是有意的取舍；但锚点被服务端帧清除后 chip 必须重现，要有测试钉住。

**不要过度隐藏。** 坞的 `background` 状态（没有回合，只有进行中的任务或计划）不是回合，chip 仍应显示。

<!-- dedup-ref --> 相关但不同机制：`gap-ac188-composer-stop-outlives-dock-idle`（提交键与坞、侧栏三处的一致性，已完成）与 `gap-activity-dock-heartbeat-never-clears-turn-anchor`（锚点清除，已完成），它们处理的是坞、提交键、侧栏之间的分叉，本任务把同一条一致性要求延伸到 chip；`gap-composer-empty-box-history-frequency-chips`（chip 本体，已完成）。合并判断：`task-granularity-advice` 对本任务 Touches 返回 peers 为空，改动预计 150–300 行，保持单任务。

**非目标。** 不改坞的判定逻辑与 `useActivityFreshness`，不改 `deriveActivityDockView`；不重做 AC-188 一类的一致性判据；不处理 chip 周围空白处点击不聚焦 textarea 的问题（另案）；不改 chip 的候选来源与排序。

## AC

- [x] 新测试文件通过：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/inputSuggestionsDockTurn.test.tsx` 退出码 0；该文件为下列每条各有一个独立 `it`（一腿一 test）：(a) `useInputSuggestions` 在其余显示条件全满足时，`isDockTurnShown: true` 使 `visible` 为 false，缺省或 false 时为 true（正控制）；(b) `isDockTurnShown: true` 时 `handleKeyDown` 对 Tab、Enter、Esc 都返回 false，并且 Tab 在 composer 里恰好触发 1 次 `cyclePermissionMode`；(c) `useActivityDockTurn` 在 `activity` 为 null 且服务端帧确立了回合锚点时返回 true；(d) 在 `activity` 为 null 且没有锚点时返回 false；(e) 在 `activity` 非 null 时返回 true；(f) 锚点被服务端帧清除后重新返回 false；(g) 坞处于 `unreachable`（有锚点且活性判为不可达）时返回 true；(h) 坞处于 `background`（无回合、有进行中的任务或计划）时返回 false；(i) 经 `useChatComposerState` 与 `ChatComposer` 接起来的集成：`isLoading` 为 false 且 `activity` 为 null、坞为 in-turn 时页面上没有 `[role="listbox"]`，textarea 的 placeholder 恢复为非空；同一接线下无锚点时 `[role="listbox"]` 存在。
- [x] 同源约束：`grep -n "deriveActivityDockView(" src/modules/chat/hooks/useActivityDockTurn.ts` 至少 1 行输出；`grep -nE "hasTurnAnchor" src/modules/chat/hooks/useInputSuggestions.ts src/modules/chat/hooks/useChatComposerState.ts` 无任何输出（退出码 1）。
- [x] 既有测试保持绿，以下每个文件单独运行退出码均为 0：`bash scripts/with-memory-cap.sh vitest run src/modules/chat/tests/inputSuggestionsComposer.test.tsx`、`.../activityDockUnreachable.test.tsx`、`.../activityDockHonestStatus.test.tsx`、`.../activityDockControls.test.tsx`、`.../chatInterfaceEscapeAbort.test.tsx`；其中 `inputSuggestionsComposer.test.tsx` 既有 `it` 的断言行没有被修改或删除（diff 只增不改）。
- [x] 静态门通过：`npm run typecheck` 与 `npm run lint` 退出码均为 0。
- [x] 前端规范：新增文件 `src/modules/chat/hooks/useActivityDockTurn.ts` 与 `src/modules/chat/tests/inputSuggestionsDockTurn.test.tsx` 中，`grep -nE "from '\\.{1,2}/"` 与 `grep -nE "^(export )?interface "` 均无输出（退出码 1）；`git diff --name-status` 相对任务起点没有新建目录。

## DoD

真实页面上的读数，缺一不可；测试只是必要条件。

- [x] 在隔离实例（按 AGENTS.md 与 cockpit 隔离实例做法，不碰常驻的 :3001）的真实页面上，用确定性的办法造出「composer 空闲、坞在画回合」：例如用 Playwright 的 `page.routeWebSocket` 向页面注入服务端的 `chat_subscribed` hello（`isProcessing: true`）使坞确立回合锚点，而本地没有任何发送。截图存 `tmp/` 并贴出：坞文字可见且 chip 不显示；再注入能清除锚点的帧，chip 重现；另附一张没有锚点时的正常空闲截图（chip 可见），作为正控制。若找不到确定性的注入办法，如实写明，不得伪造，并说明改用了什么读数。
- [x] 贴出上述三个状态下 `document.querySelectorAll('[role="listbox"]').length` 与坞的 `data-activity-state` 读数，两者须一致：坞为 `in-turn` 时 listbox 数为 0。
- [x] 贴出一次未被注入的常规回合（有条件发真实回合时）的读数：发送后 chip 隐藏、回合结束后 chip 重现。若隔离实例无法发真实回合（例如没有模型凭据），如实写明，不得伪造。
- [x] 证伪记录：临时撤掉 `isDockTurnShown` 对 `visible` 的约束，贴出 AC 中 (a)、(i) 两条对应的 `it` 变红的输出，再恢复。

## Touches

- `src/modules/chat/hooks/useActivityDockTurn.ts`
- `src/modules/chat/hooks/useInputSuggestions.ts`
- `src/modules/chat/hooks/useChatComposerState.ts`
- `src/modules/chat/ChatInterface.tsx`
- `src/modules/chat/tests/inputSuggestionsDockTurn.test.tsx`
- `tasks/gap-composer-chips-visibility-follows-dock-turn-anchor.md`