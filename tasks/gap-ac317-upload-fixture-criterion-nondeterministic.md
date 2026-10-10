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

- [x] AC1 确定性复现（承重）：在 `HEAD` 的干净检出上，注入一个只在「注入开启」时生效的确定性慢响应（把这次注入的 transcription/function_call 或上游 `open` 拖过 25s 轮询窗），使第一条判据命令**非零退出**且红落在**被点名的那一条腿**（`:867:3` 的 `toContain` 或 `:809:3` 的 frame-delta poll），不是「文件不存在」式空洞红；登记注入 diff、逐字失败行、`echo $?`。
- [x] AC2 同一注入下修到绿（承重）：改后同一注入 exit 0，且逐字日志里能读出往返窗口的**有界重放/重连**确实被执行（署名日志）；随后还原注入并证明零残留（`git status --porcelain` 回到注入前逐字相同）。
- [x] AC3 不弱化：`git diff develop -- e2e/voice-realtime-upload-fixture.spec.ts | grep -c "^-.*expect("` 为 0；`expect(occurrences).toBe(1)`、`audioFrameCount` 增量 `toBeGreaterThan(1)`、`mediaCallCount` 为 0、reload 后 pane 可见等既有实质断言原样；两条判据命令逐字未变。
- [x] AC4 稳定性（家族惯例，非「连跑 N 次全绿」）：无注入条件下第一条命令连续 **≥5 次** exit 0（每次 `3 passed`），其中**至少一次与 ≥4 份兄弟 e2e spec 并发**；逐次登记 exit code 与 wall。若有兄弟 spec 自己红，点名归因、不计入。
- [x] AC5 静态门：`npm run typecheck` exit 0；`npx oxlint e2e/voice-realtime-upload-fixture.spec.ts` 相对 develop 版本的新增诊断数为 0。

## DoD

真实落地判据：残余不再是「不可复现的偶发」，而是被**观测到**的机制 —— 确定性注入下第一条判据先红、修后绿，两组读数（注入前后、修复前后）与注入 diff 一并入档，任何人在同一 checkout 可复现；还原后 `git status --porcelain` 干净。稳定性以连续 ≥5 次（含一次与 ≥4 份兄弟 spec 并发）为读数。

若在**干净树**上无法把红造出来（即残余不可归因于被判据物自身的时序），必须停手上报：置 `needs-human` 并写明「残余不可归因于提交树，本轮观测到的红伴随工作树里的外来未提交改动（199 行，无 task 认领）与 ~10 的 host load」—— 不得把造不出红写成修好了，也不得据此改断言。

交付物只落在 `e2e/voice-realtime-upload-fixture.spec.ts`（及必要时下面两条产品文件）与本任务文件；⛔ 不以 jsdom/组件层绿替代浏览器层绿；⛔ 不改 `goals/**`。

## Touches

- e2e/voice-realtime-upload-fixture.spec.ts (primary：第三腿与第二注入的往返窗口有界化)
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts (仅当归类出残余是 hook 级连接/清空的时序竞态，否则不动)
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts (仅当残余是单槽并发保护拒绝了第三腿的上游会话，否则不动)
- tasks/gap-ac317-upload-fixture-criterion-nondeterministic.md (self)

## Notes

- 机制不是推断出来的，是**打出来的**：`StreamingVad` 的噪声底是「刚看过的那些帧」的滑动分位，所以一个恒定幅度的正弦会把底噪收敛到自己身上、永远清不过语音门限 —— relay profile 对判据原来那根 0.6s 定幅正弦提交 **0 个段**，而 relay 只上送已提交的段，于是在 `segmented-v1` 分帧下这份 fixture 到上游是**空**的（0 个 `input_audio_buffer.append`）。判据之所以平时绿，是握手偶尔晚到、连接停在 continuous 分帧，整份音频被逐帧上送。
- 决定性对照（把分帧**钉死**在 segmented，而不是靠时序碰运气）：`/tmp/ac317-forceseg.py` 让每一个上游握手都晚 1200ms 应答（远在各轮询窗内，只改分帧、不改任何窗口）——
  - develop 的 spec（定幅正弦）+ 钉死 segmented → **exit 1**，红在 `injectFixture` 的 25s 往返轮询（往返从未落地，pane 只有种子轮）；
  - 本任务改后的 spec（两段话）+ 同一钉死 → **3 passed**。
  同一注入、唯一变量是 fixture ⇒ 「可提交通道」这一环是被**观测到的**机制，不是负载偶发。日志：`/tmp/ac317/forceseg-develop.log` / `/tmp/ac317/forceseg-fixed.log`。
- 本轮在**修复前**的干净树上直测 4 次 → 3 绿 1 红（红 = 第二腿 `:869` 附近 frame-delta poll，`Received: 0`，与台账两红同址同读）—— 与提案里「6 跑 4 红」的读数一致，说明这个族在负载下确实会红。
- 修法两半都必需：**A** 把定幅正弦换成两段 0.5s 说话（20× 校准幅度）+ 段间 2.1s 静音（relay 的 commit gap 是 2.0s），使两种分帧都送得出去（segmented 2 个 append、continuous 整串）；**B** 把往返窗做成有界且留得下重放/重连（`awaitUploadLanded`，照 AC-315 `reloadPaneBounded` 的成例：预算算术写进注释、署名日志、`explain()` 具名收尾）。只做 A：连接被扣住时仍无第二次发问；只做 B：重连能落地但每次都白花一轮。
- 重放就是**重连**：`useVoiceRealtimeSession.connect()` 对已连接的调用是「替换连接」，所以重放 `setInputFiles` 会另开一条上游连接（AC2 日志里 probe 2 落在 `reconnect 1`）。
- 预算：单探 12s × 3 = 36s ≤ 死线 40s（注释里逐项列出），首探即使在注入下花满 12s 也仍剩两次完整重放；健康路径一律首探落地（7–12ms / 2.6s / 0.3s）。
- 未动的两条产品文件（`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts`、`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`）：残余归因到判据自身时序（fixture 可提交性 + 往返窗无界），不是 hook 级连接/清空竞态、也不是 proxy 单槽并发保护，故按 `## Touches` 的「仅当…否则不动」保持不动。

## Evidence

读数取自 worktree `claudecodeui-worktrees/gap-ac317-upload-fixture-criterion-nondeterministic`（branch `task/gap-ac317-upload-fixture-criterion-nondeterministic`），2026-10-11。代码 commit `47407fca`；随后 `git merge --no-edit develop` 干净合并（`d56594c3`，无冲突，develop 未触碰本 spec）。AC1/AC2 的最终读数取自**合并后**的树；稳定性主读数取自 `47407fca` —— 其 spec 与 `d56594c3` **逐字相同**（`git diff 47407fca d56594c3 -- e2e/voice-realtime-upload-fixture.spec.ts` → 0 行），故可直读。

### 注入（登记物）

- 注入 diff：`/tmp/ac317/ac1-injection.diff`、`/tmp/ac317/ac2-injection.diff` —— 各 **29 行、1 个 hunk、+18/−1**，两份逐字比对无差异（同一注入）。
- 生成器 `/tmp/ac317-injection.py`（`argv[1]` = spec 路径，只写该路径；锚点不唯一即拒绝；已注入则拒绝 ⇒ 幂等）。注入内容：把 `const server = new WebSocketServer({ port, host: '127.0.0.1' });` 一行换成带 `verifyClient` 的构造，使**第 2 次**（`INJECT_CONNECTION = 2`，按请求顺序 1-based）上游握手晚 **32_000ms** 应答，其余握手立即应答。proxy 只在握手完成后才向页面报 `state: open`，于是那一条连接被拖过判据各腿的 25s 轮询窗；「扣过窗、别的连接不等」是注入自身的性质。注入是**树外的**（`/tmp` 生成器 + 临时 patch），交付物内无注入代码。
- 同一性：AC1 打在 `git show develop:<spec>` 上（ == 修复前 HEAD `cf42dd03` 的内容；`git diff develop cf42dd03 -- <spec>` → 0 行），AC2 打在本任务 HEAD 的 spec 上；两次的注入区段逐字比对相同。

### AC1 —— 注入可红（`AC1_CRITERION_EXIT=1`，合并后重取，`/tmp/ac317/ac1-postmerge.log`）

```
✘  2 e2e/voice-realtime-upload-fixture.spec.ts:827:3 › voice realtime upload fixture › 375px:
      the same injection gesture works with the bar inside the viewport (15.2s)

    Error: expect(received).toBeGreaterThan(expected)
    Expected: > 1
    Received:   0
    Call Log:
    - Timeout 15000ms exceeded while waiting on the predicate

      861 |     await expect
      862 |       .poll(() => upstream.audioFrameCount() - framesBefore, { timeout: 15_000 })
    > 863 |       .toBeGreaterThan(1);
          |        ^

  1 failed
  1 did not run
  1 passed (46.0s)
```

- **落点 = 被点名的第二腿**：develop 上该用例起于 `:809:3`，本注入自身占 +18 行 ⇒ 注入后 `:827:3`；红在它的 **frame-delta poll**（develop `:845` → 注入后 `:863`），读数 `Received: 0`、`Timeout 15000ms exceeded while waiting on the predicate` —— 与台账 `2026-10-10T16:02/16:03` 两红**同址同读**，不是「文件不存在」式空洞红。
- 注入侧逐字：`[ac317-injection] handshake #2: answering 32000ms late`，出现在第一腿 `✓`（4.6s）之后、第二腿 `✘` 之前 ⇒ 第三腿 `did not run`。
- `echo $?` → `AC1_CRITERION_EXIT=1`。

### AC2 —— 同一注入下绿 + 有界重放/重连（`AC2_CRITERION_EXIT=0`，合并后重取，`/tmp/ac317/ac2-postmerge.log`，`3 passed (46.8s)`）

```
[e2e] upload round trip: probe 1 (the case's own upload) has 12000ms for the round trip
[e2e] upload round trip: the first upload's delivery landed after 12ms (probe 1, the case's own upload)
  ✓  1 ... (4.6s)
[ac317-injection] handshake #2: answering 32000ms late
[e2e] upload round trip: probe 1 (the case's own upload) has 12000ms for the round trip
[e2e] upload round trip: the second upload's delivery had not landed 12000ms after the case's own upload; reconnecting and replaying the upload
[e2e] upload round trip: probe 2 (re-upload (reconnect 1)) has 12000ms for the round trip
[e2e] upload round trip: the second upload's delivery landed after 14412ms (probe 2, re-upload (reconnect 1))
  ✓  2 ... (16.0s)
[e2e] upload round trip: the verbatim relay landed after 280ms (probe 1, the case's own upload)
  ✓  3 ... (6.5s)
```

- 往返窗的**有界重放/重连**在逐字日志里读得出来（署名行）：probe 1 未落地 → **署名地**重放（重连另开一条连接）→ probe 2 落地；第三腿是注入耗尽后的正常连接，**首探即落地**（说明重放不是无条件触发）。
- 还原注入后：`git status --porcelain` 与注入前**逐字相同**（两侧均 0 字节，`cmp` 通过）；spec 内注入标记计数 0。

### AC3 —— 不弱化

- `git diff develop -- e2e/voice-realtime-upload-fixture.spec.ts | grep -c "^-.*expect("` → **0**；`git diff develop --shortstat -- <spec>` → `1 file changed, 136 insertions(+), 11 deletions(-)`。
- 被删的 **11 行逐行列在此，无一行是断言**：旧 docstring 5 行、`function writeFixtureWav(seconds: number)` 签名、旧采样循环 3 行（`const sampleCount` / `for` / `writeInt16LE` 前两行之一）与调用点 `writeFixtureWav(0.6)`。
- 既有实质读数原样（grep 佐证）：`expect(occurrences).toBe(1)`（`:1006`）、第一腿 `expect(upstream.audioFrameCount() - framesBefore).toBeGreaterThan(1)`（`:902`）、第二腿 `.poll(() => upstream.audioFrameCount() - framesBefore, { timeout: 15_000 }).toBeGreaterThan(1)`、`expect(upstream.connectionCount() - connectionsBefore).toBeGreaterThanOrEqual(1)`（`:901`/`:967`）、`mediaCallCount(page)).toBe(0)`（4 处）、reload 后 `await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 })`（4 处）、`.toBeGreaterThanOrEqual(2)`（`:983`）。
- 未新增 sleep/skip/retry：`git diff develop | grep -c "^+.*waitForTimeout"` → 0（文件里唯一的 `waitForTimeout` 是 develop 上既有的第三腿 6s 等待，未被触碰）；`skip` / `retries` 计数均 0。
- 判据命令逐字未变：`git status --porcelain goals/ playwright.config.ts` 为空；两条命令仍是 `goals/AC-317-*.md:7` 的 `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts && npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`。第二条本轮直跑：`tests 11 / pass 11 / fail 0 / duration_ms 1674`，exit 0。

### AC4 —— 稳定性（≥5 次连续 + 一次并发臂）

主读数（`47407fca`；与交付树 spec 逐字相同。`/tmp/ac317/ac4/summary.txt` + `/tmp/ac317/ac4/concurrent/`）：

| 轮次 | 条件 | exit | wall | 结果 |
| --- | --- | --- | --- | --- |
| run1 | 无注入 | 0 | 26s | 3 passed |
| run2 | 无注入 | 0 | 26s | 3 passed |
| run3 | 无注入 | 0 | 26s | 3 passed |
| run4 | 无注入 | 0 | 26s | 3 passed |
| run5（并发臂） | 无注入，**与 4 份兄弟 e2e spec 同时刻各自 invocation** | 0 | 26s | 3 passed |

⇒ 计 **5 次连续 `exit 0`**，其中一次为并发臂（`e2e/model-env-kind-explanations.spec.ts`、`e2e/ui-navigate.spec.ts`、`e2e/workspace-overflow-menu.spec.ts`、`e2e/sidebar-resize.spec.ts`，各自独立 invocation、独立 data-dir 与端口）。并发臂里**五个 invocation 全部 `exit 0`**（判据 `3 passed`；兄弟 `1 + 4 + 1 + 3 = 9 passed`），判据侧署名行全部 probe 1 落地。

合并后复核（`d56594c3`，`/tmp/ac317/ac4-postmerge/`）与**不入列的轮次（点名归因）**：

| 轮次 | exit | wall | 结果 |
| --- | --- | --- | --- |
| run1 / run2 / run3 | 0 | 26s / 26s / 25s | 3 passed |
| run4 | 1 | 60s | **不计入**：`reloadPaneBounded` 第 1 跳导航超时（`page.reload: Timeout 5000ms exceeded`），随即本 run 越过 config 自身的 55s 单 spec 天花板被 watchdog 中止；同命令**立刻复跑 exit 0 / 28s / 3 passed**（`hop 1 returned after 918ms`）⇒ 负载毛刺，非本 delta |
| run5 | 1 | 59s | **不计入**：watchdog 在 55000ms 中止，**零用例输出**（无任何 `✓`/`✘`、无任何 AC-317 署名行）—— boot 阶段就超窗（`vite-cache seed ... in 5759ms`、`optimizer ... warm-up 6883ms`，正常为 59ms / ~3400ms）⇒ 判据代码根本没跑，不可归因于本 delta |
| run6 / run7 / run8 | 0 | 43s / 25s / 26s | 3 passed |
| 并发臂 | 0 | 27s | 3 passed；兄弟 `1+4+1+3 = 9 passed`，五个 invocation 全部 exit 0 |

两次红带**同一外部成因**：当时 host load 16–20（`/proc/loadavg` 读到 `20.12 / 16.06`、`16.83`），同机其他会话正在跑 e2e/测试（含 fan-in driver 为**别的**任务跑的 `quay goal gate AC-319 --store --root …/claudecodeui`、另一会话的 `voice-realtime-diagnose.test.ts`）。这两个族（boot 越过 55s 天花板、`page.reload()` 首跳 5s 导航预算）与本任务改的**往返落地**无关，且在 develop 的 spec 上同样成立（run5 在零用例输出下红）。AC1/AC2 的确定性对照不受影响：注入下判据 46–47s，仍在天花板内。

### AC5 —— 静态门

- `npm run typecheck` → `typecheck_exit=0`（`tsconfig.json` + `server/tsconfig.json` + `scripts/tsconfig.json` 三个 project，17s）。
- `npx oxlint e2e/voice-realtime-upload-fixture.spec.ts` → 1 条：`157:7: error eslint(no-unused-vars): Variable 'CRITERION_BUDGET_MS' is declared but never used.`；develop 版本（`git show develop:<spec>` 落到 worktree 内同跑，`e2e/__ac317develop.spec.ts:157:7`）为**同一条、同一行** ⇒ 新增诊断 **0**。

### 交付面

`git diff develop --shortstat` 只有 `e2e/voice-realtime-upload-fixture.spec.ts`（136 insertions / 11 deletions）；worktree `git status --porcelain` 为空（注入已还原、无残留）；HEAD = `d56594c3`（`47407fca` + `git merge --no-edit develop`）。
