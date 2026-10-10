---
id: gap-ac317-upload-fixture-criterion-nondeterministic
title: AC-317 判据非确定性：`e2e/voice-realtime-upload-fixture.spec.ts`
  串行第三腿（identicalText 去重）与 375px 第二注入在负载下 25s 内往返不落地（台账 2026-10-10T16:02/16:03
  连续两红同址）；先确定性复现再把判据做到稳定绿
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-317
---
## Proposal

**本轮直接测量（不是台账尾巴）**

AC-317 的 criterion 是两条命令的合取，逐字取自 `goals/AC-317-*.md`：

1. `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts`
2. `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`

- **第二条命令确定性绿**：本轮直跑 `tests 11 / pass 11 / fail 0`，exit 0（1.5s）。AC-317 的 caption 保证（bridge 对 `conversation.item.input_audio_transcription.delta`/`.completed` 的两个 dispatch 分支、proxy 的 `caption` 帧、caption 文本与 `session_send` 的 `message` 结构隔离）由它逐条覆盖，**成立**。
- **第一条命令非确定性**：本轮在**当前工作树**上直跑 **6 次 → 4 红 2 绿**。红的落点在**两条不同的腿**：
  - 2 次 `e2e/voice-realtime-upload-fixture.spec.ts:809:3`（375px 第二注入）—— `expect.poll(() => upstream.audioFrameCount() - framesBefore).toBeGreaterThan(1)` 收 `Received: 0`，`Timeout 15000ms exceeded while waiting on the predicate`；
  - 2 次 `:867:3`（identicalText 去重腿）—— `expect(received).toContain(expected)`，`Expected: "one sentence, spoken once, relayed word for word"`，`Received` 只有种子轮 + 上两腿的 `PROPOSED_TEXT` ×2 ⇒ 本腿的投递**从未到达**，`Timeout 25000ms`。

**台账两条红与本轮同址**：`.quay/gate-events.jsonl` 里 AC-317 的 `gate: goal` 记录共 **32 条**（29 pass、3 fail）。三条 fail 中：`2026-10-09T08:09:27Z` 是实现前的首次探针；`2026-10-10T16:02:02Z` 与 `2026-10-10T16:03:40Z` 是**连续两红、同一 `treeSha d67453ec`**，其 artifact 逐字读作同一条 `:867:3` 断言（dataDir `quay-e2e-WsynXe` / `quay-e2e-hjkInP` 的 `error-context.md`：`Expected substring: "one sentence, spoken once, relayed word for word"` / `Received string` 只有种子轮 + 两条 `voice instruction delivered from the uploaded fixture`）。`d67453ec` **正是本检出的 `HEAD^{tree}`**（`64b3ae2d`）⇒ 红不在「内容回归」，而在判据自己的时序。

**同树对照（本轮实测，均在 `d67453ec`）**：把工作树里的**外来未提交改动**（`src/modules/chat/ChatInterface.tsx`、`src/modules/chat/composer/ChatComposer.tsx`、`src/modules/chat/tests/composerCompactTier.test.tsx`，共 199 行，与本 GOAL 无关、`tasks/*.md` 中无任何任务认领）临时 stash 掉后连跑 **3 次 → 3/3 绿**；恢复后连跑 4 次 → 3 红 1 绿（并入上面的 6 跑统计）。样本小，不足以断言外来改动是原因，但足以说明这**不是静态内容回归**，而是往返时序/负载敏感的竞态。另注意：判据的 `treeSha` 由 `git rev-parse HEAD^{tree}` 计算，**不含**未提交改动（`packages/quay/src/goal-store.ts:147`），而判据命令在**工作目录**里跑 —— 所以工作树里的残留可以让判据红、而台账只记一个干净树的 sha。

<!-- dedup-ref -->
**为什么上一次 done 没止住**：`gap-live-voice-realtime-asr-caption-transcript`（done）交付了 AC-317 的实现（bridge 的 caption 分支、proxy 的 `caption` 帧、hook 按 itemId 替换、ChatInterface 提到 pane、e2e 断言），其 criterion 连续通过 34 次、约 30 小时（`2026-10-09T08:35Z` → `2026-10-10T12:42Z`）。没止住的原因不是实现坏了（第二条命令今天确定性绿；第一条命令在往返落地时 caption 断言全过），而是 **AC-317 的判据同时骑在一条共享的、历史上就非确定性的 spec 上**：AC-315 与本 AC 的 criterion **逐字相同**（同一条 `e2e/voice-realtime-upload-fixture.spec.ts && ...protocol-simulation...`），该 spec 的残余竞态已被两个 AC-315 任务追过 —— `gap-ac315-upload-criterion-boot-race`（done，加了有界 client 启动预热/优化器静默）与 `gap-ac315-reload-window-residual-deterministic-injection`（done，修了 `page.reload()` 判定窗，第二注入 frame-delta 由 `3e856ef7` 改轮询）—— 但**都没有覆盖本轮的族**：三条用例 `mode: 'serial'` 共用同一 `page`/fake upstream，第三条（`identicalText` 去重腿，由 commit `819cdd2e` 加入）在两次 reload 之后**再**进入 Live Voice 并注入一次，那一次往返在负载下可能 25s 内**完全不落地**；375px 第二注入在 `injectFixture` 的既有轮询被上一腿旧文本秒过时同样可读到 0。

**本任务要做的**：

1. **先把红造出来（可证）**：在 `HEAD` 的干净树上确定性地把被点名的腿打红 —— 例如在「注入开启」下只把 fake upstream 对这次注入的 transcription/function_call 响应（或上游 `open` 的回报）拖过 25s 轮询窗，证明该红是 spec 自身时序的性质，而不是负载偶发。登记注入 diff、逐字失败行、`echo $?`。
2. **修到绿**：让第三腿（与第二注入）的往返窗口**有界且留得下重放/重连**（照 `gap-ac315-reload-window-residual-deterministic-injection` 在 `reloadPaneBounded` 上的成例：预算算术写进代码注释、署名日志），**而不是**加 sleep、放宽容差、加 retries 或 skip。
3. **不弱化**：`git diff develop -- e2e/voice-realtime-upload-fixture.spec.ts | grep -c "^-.*expect("` 为 **0**；`occurrences`（SAME 出现次数）仍须 `toBe(1)`；`audioFrameCount` 增量、`mediaCallCount` 为 0 等既有读数原样；判据命令逐字不变。

## 边界 / 不做

- ⛔ 不改 AC-317 的 criterion 文本、不改 `goals/**`（本任务只修判据文件本身的时序）。
- ⛔ 不 supersede AC-317 —— caption 展示仍是 GOAL-033 目标第 3 条的本意，第二条命令今天为真。
- ⛔ 不靠删/弱化 caption 或去重断言来「报出」绿。
- ⛔ 不把「外来未提交改动」当成可修对象，只把它当作**诊断对照**如实登记；若最终红**只能**在外来改动存在时复现、干净树上无法造出，则停手上报（见 DoD）。
- ⛔ 不动 `playwright.config.ts`，不加 retries/skip。

## AC

- [ ] AC1 确定性复现（承重）：在 `HEAD` 的干净检出上，注入一个只在「注入开启」时生效的确定性慢响应（把这次注入的 transcription/function_call 或上游 `open` 拖过 25s 轮询窗），使第一条判据命令**非零退出**且红落在**被点名的那一条腿**（`:867:3` 的 `toContain` 或 `:809:3` 的 frame-delta poll），不是「文件不存在」式空洞红；登记注入 diff、逐字失败行、`echo $?`。
- [ ] AC2 同一注入下修到绿（承重）：改后同一注入 exit 0，且逐字日志里能读出往返窗口的**有界重放/重连**确实被执行（署名日志）；随后还原注入并证明零残留（`git status --porcelain` 回到注入前逐字相同）。
- [ ] AC3 不弱化：`git diff develop -- e2e/voice-realtime-upload-fixture.spec.ts | grep -c "^-.*expect("` 为 0；`expect(occurrences).toBe(1)`、`audioFrameCount` 增量 `toBeGreaterThan(1)`、`mediaCallCount` 为 0、reload 后 pane 可见等既有实质断言原样；两条判据命令逐字未变。
- [ ] AC4 稳定性（家族惯例，非「连跑 N 次全绿」）：无注入条件下第一条命令连续 **≥5 次** exit 0（每次 `3 passed`），其中**至少一次与 ≥4 份兄弟 e2e spec 并发**；逐次登记 exit code 与 wall。若有兄弟 spec 自己红，点名归因、不计入。
- [ ] AC5 静态门：`npm run typecheck` exit 0；`npx oxlint e2e/voice-realtime-upload-fixture.spec.ts` 相对 develop 版本的新增诊断数为 0。

## DoD

真实落地判据：残余不再是「不可复现的偶发」，而是被**观测到**的机制 —— 确定性注入下第一条判据先红、修后绿，两组读数（注入前后、修复前后）与注入 diff 一并入档，任何人在同一 checkout 可复现；还原后 `git status --porcelain` 干净。稳定性以连续 ≥5 次（含一次与 ≥4 份兄弟 spec 并发）为读数。

若在**干净树**上无法把红造出来（即残余不可归因于被判据物自身的时序），必须停手上报：置 `needs-human` 并写明「残余不可归因于提交树，本轮观测到的红伴随工作树里的外来未提交改动（199 行，无 task 认领）与 ~10 的 host load」—— 不得把造不出红写成修好了，也不得据此改断言。

交付物只落在 `e2e/voice-realtime-upload-fixture.spec.ts`（及必要时下面两条产品文件）与本任务文件；⛔ 不以 jsdom/组件层绿替代浏览器层绿；⛔ 不改 `goals/**`。

## Touches

- e2e/voice-realtime-upload-fixture.spec.ts (primary：第三腿与第二注入的往返窗口有界化)
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts (仅当归类出残余是 hook 级连接/清空的时序竞态，否则不动)
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts (仅当残余是单槽并发保护拒绝了第三腿的上游会话，否则不动)
- tasks/gap-ac317-upload-fixture-criterion-nondeterministic.md (self)
