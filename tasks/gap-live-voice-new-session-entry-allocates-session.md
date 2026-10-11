---
id: gap-live-voice-new-session-entry-allocates-session
title: Live Voice 入口在全新会话（尚无 session
  id）里直接分配会话并进入语音，而不是只给一条「先发一条消息」的通知；needsSession 降级为分配失败路径
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

**现状（2026-10-11 本轮亲自复核，逐行读到）**

- `src/modules/chat/ChatInterface.tsx:365` `const voiceSessionId = currentSessionId ?? selectedSession?.id ?? null;`；`:910` 把它取反交给入口（`liveVoiceDisabled={!voiceSessionId}`），`:914` 配一条 `voice.realtime.needsSession` 文案。于是**全新会话**（刚点 New Session、还没有会话行）里点 Live Voice 只得到一条通知，进不去。
- 会话行只在 composer 首次发送时才由 session gateway 分配：`src/modules/chat/hooks/useChatComposerState.ts:992` 是全前端**唯一**的 `api.providers.createSession` 调用点（本轮 grep 整个 `src/`，仅此一处；sidebar 里那个同名函数是视图格式化工具，无关）。全新会话里没有"第一次发送"，所以永远没有 id。
- 就算绕开入口，语音本身也拒绝无 id 的连接：`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:613` 在 sessionId 为空时直接 `setPhase('failed')`；服务端 `server/index.ts:612` 读 `session` 查询参数，缺了立刻 `ws.close()`（那个 boundSessionId 正是 `session_send` 白名单的根）。
- 今天 done 的 `gap-live-voice-unavailable-entry-visible-notice` 把"静默 disabled"改成了"可点 + 可见通知"，其 DoD 的真机读法 A 逐字记录了这个行为（全新工作区 → 点按 → 只拿到通知）。**本任务判定那个前提本身是错的**：用户要的不是更好的解释，而是**能用**。

**本任务要做什么**（方案已由人 yale 在 2026-10-11 本轮选定：进入 Live Voice 时就分配）

全新会话里点 Live Voice 时，**先分配会话、再进入语音** —— 走 composer 首次发送用的**同一条** session gateway（`POST /api/providers/sessions`，语义同构：provider + projectPath，不带 initialMessage），拿到稳定 id 后写进会话状态并像 composer 一样导航到它，再把语音连接绑到这个 id。第一句话被模型交付时 `session_send` 写进这个新会话 —— 与打字首次发送完全同构，只是"第一条消息"由语音产生。

`voice.realtime.needsSession` 那条通知**保留但换位**：从"你还没有会谈"降级为"分配失败"（网关非 2xx，或 2xx 但返回体里 sessionId 为空）时的可见答复，此时**不**进入语音模式。进入语音之后的连接失败仍走既有的 failed 态与 retry 路径，不在本任务范围内。

**已知代价（方案 A 的自觉取舍，人已确认）**：进入 Live Voice 后立刻 End 且一句话没说，会留下一个空会话行（侧栏 Recent 可见、无消息）。本任务不做"退出即删"。

<!-- dedup-ref --> 去重与粒度判定（本轮实测）：机制去重 —— `voiceSessionId` / `liveVoiceDisabled` / `needsSession` / `voice.realtime.needsSession` / `Live Voice needs a conversation` 在 `tasks/*.md` 全仓只命中那条已 done 的 `gap-live-voice-unavailable-entry-visible-notice`（本任务取代其判定）；`createAppSession` 的命中是会话网关命名、权限模式、中断生命周期三条无关任务。粒度 —— `task-granularity-advice.js` 对下面 `## Touches` 的读数为 `peers: []` / `mentions: []`（无在飞任务声明这些文件），判定 **separate / none found**。

## Plan

1. **把"分配会话"收敛到一处。** 新增 `src/modules/chat/utils/sessionCreation.ts`，导出一个薄封装（`api.providers.createSession` 的非 2xx → 抛错；2xx 但 sessionId 为空 → 也抛错；成功返回 `{ sessionId, sessionName }`）。`useChatComposerState.ts` 的首次发送分支改用它（保持既有语义：同样的响应体读取、同样的失败提示、同样的 `onSessionEstablished` 调用点），`ChatInterface.tsx` 的语音入口也用它。**只此一处**触达网关，避免出现会各自漂移的第二份。
   - 退路：若抽取会危及 composer 那条路径的既有语义（draft scope、resident 模式写入、错误卡片），允许语音入口直接调同一个 `api.providers.createSession`，但两处的成功/失败判定必须同形；不允许出现第三份。
2. **`ChatInterface.tsx` 的入口改成 async**：`enterVoiceMode` 在没有 `voiceSessionId` 时先分配；成功后 `handleSessionEstablished(newId, { provider, project: selectedProject, summary })`，并把语音模式的状态设成 **newId 本身**（不是调用时仍为 null 的 `voiceSessionId` —— 否则重渲染后 `composerMode` 仍是 text，栏不会出现）；失败则显示可见通知并且**不**切换模式。
   - ⚠️ `handleSessionEstablished` 会触发一次路由导航（`onNavigateToSession`）。`ChatInterface` 在 `WorkspaceMain` 里没有 `key`，路由变化不会重挂载它，所以状态能活过这次导航 —— 但这一点必须在真机读数里被看见（AC4），不能只在代码里推断。
3. **不可用判定换位**：`liveVoiceDisabled` 不再是 `!voiceSessionId`（全新会话里入口必须是**可用**的），改为"分配进行中"或"上一次分配失败"。`ChatComposer` 的 prop 契约（保持可点、点按给可见通知）不动，只改 `ChatInterface` 何时置位。
4. **单测**：新增 `src/modules/chat/tests/liveVoiceNewSessionEntry.test.tsx`，按 `sessionPermissionMode.test.tsx` / `residentComposerEnableAffordance.test.tsx` 的挂载手法渲染真 `ChatInterface`，用假 fetch 记录 `POST /api/providers/sessions`。三条用例：全新会话分配并进入语音（AC1，取假形态断言排在文件最前）、已有会话零分配（AC2）、分配失败的两种支路（AC3）。
5. **真机 spec**：新增 `e2e/voice-realtime-new-session-entry.spec.ts`，照 `e2e/resident-enable-consent.spec.ts` 的 `openNewSession` 手法（点 "New Session"）站到全新会话上，再点 live-voice-button，读 `[data-testid="voice-realtime-bar"]` 与 `POST /api/providers/sessions` 的响应。CI 机器没有麦克风：按 `e2e/voice-realtime-composer-embedded.spec.ts` 的 init script 给假麦克风，或接受 `Requested device not found`（栏照样渲染，读数只断言"栏出现 + 分配发生 + 无通知"）。
   - ⚠️ 工作树里跑 e2e 之前先 `ln -sfn $(readlink -f <主检出>/.quay/plugin) <worktree>/.quay/plugin`，否则 `seedFixtureProject` 在 `.quay/plugin` 上 ENOENT 直接死。
   - ⚠️ 若整文件超过 `playwright.config.ts` 的 55s 单文件 watchdog 默认上限，再把该 spec 的 basename 加进 `SPEC_BUDGET_MS`（只有那时 `playwright.config.ts` 才进 diff）。
6. **规矩**：改动全在 `src/` 与 `e2e/` 下 —— 按 `AGENTS.md` 加载 `.agents/skills/frontend-module-standards/SKILL.md` 执行（`@/` 别名、`type` 不用 `interface`、新导出带消费者注释、barrel 只暴露公共 API）。跑测试按 `scripts/with-memory-cap.sh` 的缩放规矩来，不要在会话里发起无界并发。

## AC

- [x] AC1（取假形态；这条断言必须排在新增用例文件的**第一条**）全新会话（无 session id）点 Live Voice ⇒ 观测到一次 `POST /api/providers/sessions` 且响应 2xx、语音栏出现（`[data-testid="voice-realtime-bar"]`）、**不出现** `voice.realtime.needsSession` 通知：`npx vitest run src/modules/chat/tests/liveVoiceNewSessionEntry.test.tsx` exit 0。取假：把入口还原成今天的 `liveVoiceDisabled={!voiceSessionId}`（即不分配）⇒ 该文件第一条断言最先变红。
- [x] AC2（负控，正常路径不被骚扰）已有会话（`currentSessionId` 非空）点 Live Voice ⇒ `POST /api/providers/sessions` 的调用计数为 **0**，且直接进入语音模式：同文件第二条用例通过。
- [x] AC3（失败路径：可见，且不进入）分配失败的两条支路 —— 网关返回 500、网关 2xx 但返回体 sessionId 为空 —— 都**不**进入语音模式（`voice-realtime-bar` 计数为 0）、控件保持可点、并出现一条**可见**通知：同文件两条用例通过。
- [x] AC4（真机 e2e，独立 spec 文件）真实浏览器 + 真实服务：从 fixture 项目点 "New Session" 站到全新会话，点 live-voice-button ⇒ 语音栏出现、无 needsSession 通知，且这一次进入**真的分配了会话**（浏览器侧读得 `POST /api/providers/sessions` 的 2xx 响应与新的 session id）：`npx playwright test e2e/voice-realtime-new-session-entry.spec.ts` exit 0。
- [x] AC5（既有契约不回归）入口组件级的"不可用时可点并给出可见通知"契约不变：`npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx` exit 0。
- [x] AC6 静态门：`npm run typecheck` exit 0；`npm run lint` exit 0。

## DoD

一个**真实对象**被这套机制操作过（DIR-026 读法 A）：在真机上从**全新会话**点 Live Voice，**真的**进入语音模式、**真的**分配出会话行；并且（用 fixture 音频或真麦克风，配真上游或 stand-in 上游）第一句话被交付后**写进了那个新会话的 transcript**。测试与 spec 变绿是必要但不充分 —— **落地**并且**真机可读**才是交付物。Evidence 里至少要有这些读数（截图/逐帧说明）：

- `git log` 看得到本次改动提交；`git diff --name-status develop...HEAD` 与 `## Touches` 一致。
- 用**备用端口**起一份真实服务（不要重启操作者那个 :3001 实例）：`HOME=<隔离目录> SERVER_PORT=397x JWT_SECRET=x VITE_IS_PLATFORM=true VOICE_REALTIME_CAPTURE=on npx tsx --tsconfig server/tsconfig.json server/index.ts`，再用真实浏览器（Playwright 或真机）走一遍全新会话 → Live Voice。
- 读数至少包含：语音栏出现、无通知、`POST /api/providers/sessions` 的 201 与它返回的 id、以及 URL/侧栏上那个新会话；做了交付的话，附上 transcript 里那一行的截图。
- 工作树里跑浏览器之前记得先给 `.quay/plugin` 建软链（见 Plan 第 5 步），跑完清掉。

## Touches

- src/modules/chat/ChatInterface.tsx (语音入口改为先分配再进入；不可用判定换到分配进行中/失败)
- src/modules/chat/hooks/useChatComposerState.ts (首次发送分支改用同一处分配)
- src/modules/chat/utils/sessionCreation.ts (new)（唯一的 session gateway 调用点）
- src/modules/chat/tests/liveVoiceNewSessionEntry.test.tsx (new)（AC1-AC3 的用例）
- e2e/voice-realtime-new-session-entry.spec.ts (new)（AC4 的真机 spec）
- playwright.config.ts (仅当该 spec 超出 55s 单文件 watchdog 默认上限时才加 SPEC_BUDGET_MS 条目)
- tasks/gap-live-voice-new-session-entry-allocates-session.md (self)

## Evidence

**落地**：`b36299d7 feat(chat): allocate a session when Live Voice opens a new conversation`（5 文件，+882/−21；与 `## Touches` 逐条一致——`playwright.config.ts` 未进 diff），已随机械 fan-in ff 进 develop。fan-in 记录 `.quay/fan-in-gap-live-voice-new-session-entry-allocates-session-wk-prod-anchor.log`：anti-drift exit 0、delta=code、typecheck exit 0（9154ms）、suite exit 0（178109ms；`verification-round.jsonl` round 908 读得 `pass:484 fail:0`，含本任务新增的 `src/modules/chat/tests/liveVoiceNewSessionEntry.test.tsx`）、ac-gate exit 0、flip-done、ff OK。

**独立复核（2026-10-11 17:22，落在 develop 的树上；由常驻会话在落地之后自己重跑，不是 worker 那一轮的读数）**

- `npx vitest run src/modules/chat/tests/liveVoiceNewSessionEntry.test.tsx` → `Tests 4 passed (4)`（AC1 / AC2 / AC3a 500 / AC3b 空 id）。
- `npx playwright test e2e/voice-realtime-new-session-entry.spec.ts` → `1 passed (11.7s)`，spec 自己打印的读数逐字为：`[ac4] pre-entry pathname=/`、`[ac4] allocation.status=201 sessionId=4252c096-3cf2-476a-9966-3080460bde9f`、`[ac4] bar.visible=true`、`[ac4] navigated.pathname=/session/4252c096-3cf2-476a-9966-3080460bde9f`、`[ac4] notice.count=0` —— 即"全新会话（URL 还在 `/`）里点一次入口 → 真的发了一次分配且拿到 201 + id → 语音栏出现 → 导航到该 id → 零通知"（AC4）。
- `npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx` → `17 passed (17)`（AC5）。
- `npx playwright test e2e/voice-realtime-composer-embedded.spec.ts`（AC-323 判据链里的一条，回归）→ `5 passed (19.6s)`。

**已知残留（不影响本任务任何 AC，供人裁定）**：失败路径复用了 `voice.realtime.needsSession` 的原文 "Send a message first, then start Live Voice."。它现在只在**分配失败**时出现，把补救说成"先发一条消息"与成因错位（发送确实也能分配出会话，但失败不是"还没发消息"造成的）。任务体只要求"一条可见通知"，故 AC3 通过；文案本身是产品措辞，留给人。
