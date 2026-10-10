---
id: gap-live-voice-composer-embedded-acceptance-spec
title: AC-323 验收 spec：Composer 内双入口栏的浏览器级判据（超长字幕不撑高 / 不遮挡 transcript / 模型选择器 /
  断线 Retry 重连 / 截图）
status: done
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-live-voice-composer-embedded-dual-entry
goal_ac: AC-323
---
## Proposal

背景：`gap-live-voice-composer-embedded-dual-entry`（已合并 develop，commit 1264090d）实现了入口迁移与容器内紧凑栏，但它是在 GOAL-035/AC-323 建立之前落地的，且其证据里有四项只有结构论证、没有浏览器实测：超长字幕不撑高、栏不遮挡最后一条 transcript、栏内模型选择器可见（既有 fixture 的 provider 无模型选项而被隐藏）、断线后 Retry 的真实点击与"连接数仅 +1、不重复投递音频"。AC-323 的判据引用了尚不存在的 `e2e/voice-realtime-composer-embedded.spec.ts`，本任务补上它，并在它暴露缺陷时修正 `VoiceRealtimeBar`/`ChatInterface`。

做法：
1. 新建 `e2e/voice-realtime-composer-embedded.spec.ts`，复用 `e2e/voice-realtime-live-session-send.spec.ts` 的 fixture 形态（伪麦克风 `__voiceFake`、FakeUpstream、debug-agent 会话、`/api/voice/health` 路由与 `uiPreferences.voiceEnabled`）。不要 import 另一个 spec；需要共享的 helper 复制过来并保持体量小。
2. 在 `playwright.config.ts` 中把新 spec 加入与 live-session-send 同一组的 voice-realtime 端口/环境选择（现有 `selectedSpecFiles().includes('voice-realtime-live-session-send.spec.ts')` 等处）。
3. 用例：(a) 默认 Composer 双按钮在 1280 与 375 都可见且 `prompt-input` 内；(b) listening/muted/执行中三态栏 height 与 top 差 ≤2px；(c) 经 fake upstream 下发一条 ≥400 字符 interim caption，栏高不变且字幕单元 `scrollWidth > clientWidth`；(d) 栏顶边 ≥ 最后一条 transcript 消息底边（栏不遮挡）；(e) 配置一个有模型选项的 provider/会话，栏内模型选择器可见；(f) 关闭上游 socket → 栏显示 disconnected 文案与 `voice-realtime-retry`，点击后回到 listening，`upstream.connectionCount()` 仅 +1、重连前已发送的音频帧不重复出现；(g) 在 `QUAY_LIVE_VOICE_SHOT_DIR` 下写默认/监听/静音/执行中/断线五张截图（桌面与 375px）。
4. 用例红时修产品代码（限 `VoiceRealtimeBar.tsx`、`ChatInterface.tsx`），不得改 `useVoiceRealtimeSession.ts`（GOAL-034 的任务正在改它，避免冲突；Retry 已通过其公开的 `start` 工作）。

## 边界/不做

不做自动重连（Retry 为手动）；不改服务端；不改 `useVoiceRealtimeSession.ts`；不依赖 GOAL-034。

## AC

- [x] AC1 新 spec 在桌面 1280 与 375px 全绿，覆盖 (a)–(f)。
- [x] AC2 `npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts` exit 0。
- [x] AC3 取假形态现场红再还原为绿：(a) 字幕单元去掉 truncate；(b) 栏高随阶段变化；(c) 移除 Retry 按钮。
- [x] AC4 桌面与 375px 的五张截图写入 `artifacts/live-voice/composer-embedded/` 并已查看。

## DoD

`quay goal gate AC-323` 的判据三条命令 exit 0；三条假形态红绿输出留档；截图路径与 treeSha 记入本任务 Evidence。

## Touches

- e2e/voice-realtime-composer-embedded.spec.ts (new)
- playwright.config.ts
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
- src/modules/chat/ChatInterface.tsx
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-live-voice-composer-embedded-acceptance-spec.md (self)

## Evidence

treeSha `498c4c191071818a502a9cf0dcdb2953f05e212c`（合并前代码提交 `aa8068d5cf057d372222a7fb1cbdeffdedef9a71`，基于分叉点 `5a42d83f`；`git show --stat`：`e2e/voice-realtime-composer-embedded.spec.ts` +852（新，852 行，md5 `86f57be7e17d6c3e2aa0c3a4642b4a46`）、`playwright.config.ts` +12/-3（md5 `1ce014faa26d71bfda5e0fe75a404ae9`））

**合并后（本任务最终交付的树）treeSha `a28f36abc99ff461369093d9670be9d0d1559792`，merge commit `8475a100fc57d507dc35a7f744b803d701b73cbb`。**

### 落地

- 新增 `e2e/voice-realtime-composer-embedded.spec.ts`（852 行，5 个用例）。自包含：从 `voice-realtime-live-session-send.spec.ts` 复制 `__voiceFake` 伪麦克风 / `FakeUpstream` / debug-agent 会话 / `/api/voice/health` 路由 / `uiPreferences.voiceEnabled` 的 fixture 形态，不 import 兄弟 spec。
- `playwright.config.ts`：新 spec 名加入 `DEBUG_AGENT_SPEC_FILES`，并把 `voiceRealtimeSelection` 扩到本 spec（`|| selectedSpecFiles().includes('voice-realtime-composer-embedded.spec.ts')`），让三条 spec 共享同一 `QUAY_E2E_VOICE_REALTIME_PORT` 与 webServer env。未加 `SPEC_BUDGET_MS` 行：单跑本 spec 实测 17.6–25.5 s，3 文件选择下 12 例 44–59 s，而 3 文件选择的单文件上限已是 55 s×3。
- 产品代码零改动：`VoiceRealtimeBar.tsx` / `ChatInterface.tsx` 收尾时与 HEAD 逐字节相同（`git diff --stat src/` 为空），AC3 的三次变异-还原不进入提交。Touches 里的这两个前端文件与 `server/shared/tests/quay-test-script.test.ts` 因此都是"允许但未用"。
- `server/shared/tests/quay-test-script.test.ts` **刻意未动**：本改动不新增服务端测试文件，而该文件钉的是服务端测试文件计数（`known=… unknown=…`）。实测见"遗留"第 3 条与"合并后复验"。

### AC1 新 spec 桌面 1280 与 375px 全绿，覆盖 (a)–(f)

命令：`bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-composer-embedded.spec.ts`
结果：**5 passed，exit 0**（三次单跑分别 25.5 s / 17.6 s / 18.0 s；合并后在 3 文件选择里同样 5/5 全绿）。用例与判据的对应：

- (a) 双入口：`live-voice-enter` count 0、`voice-input-button` 与 `live-voice-button` 同行且前者在左、后者在 `[data-slot="prompt-input"]` 内 —— 用例 1（1280）、用例 3（375）。
- (b) listening / muted / 执行中三态 `height` 与 `top` 差 ≤2px —— 用例 1（1280）、用例 3（375）。
- (c) ≥400 字符 interim caption 后栏高不变、字幕单元 `scrollWidth > clientWidth` —— 用例 1（构造 462 字符）。
- (d) 栏顶边 ≥ 最后一条 transcript 消息底边 —— 用例 1。
- (e) 带模型选项的会话里栏内模型选择器可见 —— 用例 5。
- (f) 上游 socket 关闭 → disconnected 文案 + `voice-realtime-retry`，点击后回 listening、`connectionCount()` 仅 +1、重连前音频帧不重复 —— 用例 2（1280）；用例 4 在 375 上只覆盖几何与 Retry 可见。

(e) 踩到一处真实约束：`ComposerModelMenu` 的模型列表默认折叠（composer 自身约定），要先点开 `role="menuitem"` 那一行才列出 `menuitemradio` 选项。首版直接断言选项可见而红，改为"先展开、后断言、再收起"。

### AC2 三条 spec 的 criterion 命令 exit 0

命令（与 AC-323 `criterion` 第一条逐字相同）：
`npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts`
结果：**12 passed (59.2s)，exit 0**（另一次 52.3 s / exit 0；合并后 44.6 s / exit 0），三个文件 5+4+3 例全绿；原始输出存 `artifacts/live-voice/composer-embedded/criterion-cmd1-12-passed.txt`。

这条命令第一版是红的（两次 `2 failed`）：本 spec 首版用私有账号 `voice-bar-e2e`，而三条 spec 共用一台**单用户**服务端与同一数据目录，本 spec 在该选择里排第一 → 先注册占掉唯一席位 → 兄弟 spec 的 `register` 得到 403 `AUTH_USER_ALREADY_CONFIGURED`、其 `login` 得到 401。隔离实验定位：2 文件跑（不含本 spec）7 passed；3 文件跑则同样两例失败。修法是把 fixture 账号改成兄弟 spec 的 `voice-realtime-e2e` / `voice-realtime-e2e-pass`（理由写进 spec 头注释），三个文件因而不依赖运行顺序。

### AC3 三条假形态现场红再还原为绿

每次只改一处，跑 `npx playwright test e2e/voice-realtime-composer-embedded.spec.ts`，见红后立刻还原并复跑：

- (a) 字幕单元去掉 `truncate`（`VoiceRealtimeBar.tsx` 字幕 `className`）→ 红：
  `Error: the caption cell has to clip 462 characters rather than widen: {"scrollWidth":690,"clientWidth":690,"whiteSpace":"normal"}`（`expect(...).toBeTruthy()`，Received: false，第 627–629 行）。还原后 **5 passed (25.4s)**。
- (b) 栏高随阶段变化（listening 用 `h-20` 而非 `h-16`）→ 红：
  `Error: the bar's height moved while muted`，`Received: 16`（`Math.abs(state.height - listening.height) <= 2` 被 16 打破，第 649 行）。还原后 **5 passed (17.6s)**。
- (c) 移除 Retry 按钮（`canRetry && <button data-testid="voice-realtime-retry">`）→ 红：
  用例 1 passed、用例 2 红 `Error: expect(locator).toBeVisible() failed / element(s) not found`（第 695 行 `getByTestId('voice-realtime-retry')`），**1 failed 1 passed (19.9s)**。还原后 **5 passed (18.0s)**。

三份红/绿原始输出留档在 `artifacts/live-voice/composer-embedded/false-forms/{a,b,c}-{red,green}.txt`；还原后 `git diff --stat src/` 为空。

### AC4 截图写入并已查看

11 张 PNG 写在 `<worktree>/artifacts/live-voice/composer-embedded/`：默认 / 监听 / 静音 / 执行中 / 断线 × {1280, 375} 共 10 张，加模型选择器 1 张（1280）。逐张打开确认：桌面栏是 `[状态图标][波形 00:00 状态][字幕][模型][Mute][End]`；静音态字幕显示截断省略号（"…show the model keeps hearing a much lo…"）；执行中态波形在动、字幕为最新一句；断线态显示 "Voice disconnected" + 红色上游错误 + Retry；375 各态都收在视口内；模型选择器那张能看到展开后的目录（含自定义模型行）。

三条过程事实，供复核者不被误导：

1. 本 spec 的 `shot()` 只在 `QUAY_LIVE_VOICE_SHOT_DIR` 有值时写盘（与两个兄弟 spec 同策略），并在写前断言"名字里的宽度 == 实际视口宽"。首版 `enterLiveVoice()` 没设视口，导致 `composer-embedded-default-1280.png` 与 `…-model-selector-1280.png` 实际是 375×800 —— 现在 `enterLiveVoice(width)` 自己 `setViewportSize`，命名与像素不再可能对不上。**因为这条 guard，判据（不带该环境变量）运行时不会重写任何截图，也就不会把工作树弄脏。**
2. 同目录还有 7 张**兄弟 spec 的、已被 git 跟踪的** PNG（`default-composer-*`、`live-*`）。多文件跑时若把 `QUAY_LIVE_VOICE_SHOT_DIR` 指向本目录，兄弟 spec 会按各自文件名覆盖它们。收尾已 `git checkout -- artifacts/live-voice/composer-embedded/` 还原：`git status --porcelain artifacts/` 只剩本任务 11 张 `??`，无 ` M`（跟踪产物内容与 HEAD 逐字节相同）。
3. 本任务 11 张 PNG 与 false-forms 等文本**保持未跟踪、未写进 Touches**：AC4 只要求"写入并查看"，Touches 未声明 artifacts 路径，而未落地却声明的路径会触发 anti-drift。因此它们不出现在合并增量里，只留在 worktree 内。

### DoD

- "三条假形态红绿输出留档"：见 AC3，原始文本 + md5 在 `false-forms/`。
- "截图路径与 treeSha 记入本任务 Evidence"：见上（含合并前后两个 treeSha）。
- "`quay goal gate AC-323` 的判据三条命令 exit 0"：**三条命令本身实测都 exit 0**，但 **`quay goal gate AC-323` 这个动词在当前配置下无法报出 0**。原因与证据（这是本任务无法在 Touches 内修的配置缺陷）：
  - 判据是 `A && B && C` 的三条串行链。逐条实测：CMD1（三 spec playwright）**53.35 s / exit 0**、CMD2（`npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime`）**4.35 s / exit 0**、CMD3（`npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "`）**26.01 s / exit 0**；**串行合计 83.71 s**（带时间戳的原始输出存 `artifacts/live-voice/composer-embedded/criterion-serial-timings.txt`）。
  - 验收闸硬上限是 60000 ms：shipped `DEFAULT_ACCEPTANCE_TIMEOUT_MS = 6e4`，而 AC-323 记录**没有 `timeoutMs`**、仓库**没有 `.quay/gates.yml`**（`resolveAcceptanceTimeoutMs`: 环境变量 `QUAY_ACCEPTANCE_TIMEOUT_MS` → `gateConfig.timeoutMs` → 默认）。83.71 s > 60 s，且 CMD1 单独就占掉上限的 89%。
  - 记录在案的 GateEvent（`gate=goal`、`actor=goal-cli`、`evaluationRoot=/data/home/yale/work/claudecodeui`）与之吻合：AC-323 共 9 条，其中 **8 条 `verdict: not-evaluated` / `cause: timeout`**，reason 逐字相同 —— ``not-evaluated (timeout): acceptance timed out after 60000ms (killed) — set the record's `timeoutMs` or QUAY_ACCEPTANCE_TIMEOUT_MS``（01:46:43 / 01:53:48 / 01:59:49 / 02:05:26 / 02:26:41 / 02:32:21 / 02:38:51 / 02:47:04；treeSha 77a6be76 / e6b2d150 / e6b2d150 / e6b2d150 / 01162e11 / d5d67a7b / 8c2f47e9 / 7f11fdcd）；另有 1 条 `verdict: fail`（02:10:24，treeSha 4ff54c6c），其 reason 引的是一句 vite BABEL 提示而非判据结论。注意其中三条 timeout 事件的 treeSha 正是 `e6b2d150…`（= 本分支分叉点 `5a42d83f` 的 tree），即**同一棵树被反复判为 timeout**，与判据内容无关。
  - 结论：这与 `ac-wallclock-bound-below-a-mandated-floor-is-unsatisfiable` 同族 —— 上限低于判据自身被强制耗掉的时间。修法只有两条，都在 Touches 之外：给 AC-323 记录加 `timeoutMs`（如 ≥120000），或给闸调用方设 `QUAY_ACCEPTANCE_TIMEOUT_MS`。缩判据不现实：CMD2+CMD3 已 ~30 s，CMD1 要启一个真浏览器与一台真 WebSocket 服务端跑 12 例，进不了剩下的 30 s。
  - 按纪律我没有改 `goals/AC-323-*.md`（不在 Touches），也没有缩判据。**以"三条命令 exit 0（实测）+ 闸上限需上调"的形式交给上游**；AC1–AC4 四项判据本身全部独立成立，故照实勾选。

### 合并后复验（step 2b，tree `a28f36abc99ff461369093d9670be9d0d1559792`，merge commit `8475a100`）

`git merge --no-edit develop` **无冲突**（develop 带入 26 个提交，含 `src/modules/chat/transcript/ChatMessagesPane.tsx`、`MessageComponent.tsx`、新增 `src/modules/quay/LoopPulseGantt.tsx` 等）。合并后：

- 合并增量 `git diff --stat develop HEAD` = 恰好两条路径：`e2e/voice-realtime-composer-embedded.spec.ts`（+852）、`playwright.config.ts`（+12/-3），**⊆ Touches**。任务文件本身不出现在增量里：本工作区的 store 就是 develop，勾选与 Evidence 已随 `task_write` 落在 develop 上，两侧逐字节相同。
- 我的两个文件 md5 与合并前一致（`86f57be7…` / `1ce014fa…`），即合并没有改写它们。
- 在合并后的树上重跑 criterion 的 CMD1：**12 passed (44.6s)，exit 0**（本 spec 5/5 全绿）；原始输出存 `criterion-cmd1-after-merge.txt`。
- 遗留第 3 条的钉子红**已随合并消失**：`server/shared/tests/quay-test-script.test.ts` 合并后单跑 **exit 0**（AC2–AC7 全 ✔），develop 的 `unknown=267` / `269` 与实际一致；输出存 `count-pin-after-merge.txt`。
- 一处需如实记录的观察：合并后**第一次**跑 CMD1 时红过一次 —— `e2e/voice-realtime-live-session-send.spec.ts:543` 的 375px 用例在第 591 行 `page.reload()` 后 30 s 内等不到 `.chat-messages-pane`（该用例记 30.7 s，整轮 1.2 m，另 2 例未跑）。同树复跑即绿（12 passed 44.6 s），该用例单独跑 2.1 s 绿（`sibling-alone-after-merge.txt`）。判为**冷缓存/依赖优化器热身期的抖动**，不是判据的确定性红：合并带进新的 `src/` 文件 → vite 依赖图变化 → 首次运行要重建优化缓存，兄弟 spec 的 reload 恰落在该窗口（那一轮日志里 `[e2e] optimizer quiet: browserHash=1db9bb87 held 1000ms (warm-up 1021ms, commits seen 1)` 出现在失败用例之后）。触发者是 develop 的内容变化而非本 spec：合并前三 spec 同一条命令在本 spec 同样排第一的情况下两次绿（59.2 s / 52.3 s），且我的改动只新增一个文件、只给一个原本已为真的 OR 分支再添一项。两轮原始输出分别存 `criterion-cmd1-after-merge-first-run-red.txt` 与 `criterion-cmd1-after-merge.txt`。
- 结论：合并后的树上，判据三条命令仍全部 exit 0（CMD1 已实测；CMD2/CMD3 不涉及本任务改动的文件，且 driver 的 fan-in 会各自复跑）。

### 遗留 / 风险（供上游）

1. **AC-323 闸上限**（上条 DoD）：不改就无法让 `quay goal gate AC-323` 报 0。
2. **fixture 账号改为与兄弟 spec 共用**：这是让三条 spec 在单用户服务端上任意顺序共存的唯一办法，代价是三条 spec 共享一个账号 —— 若将来有人给 voice-realtime 家族再加第四条 spec 且用私有账号，同样的 403 会回来。
3. **`server/shared/tests/quay-test-script.test.ts` 在分叉点上是红的（本任务未动它）**：实测 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts`，第 154 / 203 行断言失败 —— 期望 `known=3 unknown=262` / `known=1 unknown=264`，实际 `known=1 unknown=269`。原因是分叉点 `5a42d83f` 落后 develop 26 个提交，而 develop（`751127c2`）已把该钉子改成 `unknown=267` / `unknown=269`，与实际完全一致；同时 `git ls-files 'server/**/*.test.*'` 在本分支与 develop 上同为 270 —— 本改动不新增任何服务端测试文件，红是"旧钉子 + 兄弟任务新增测试文件"的合并期假象。**已在合并后复验为绿（见上）。**
4. **`e2e/` 与 `playwright.config.ts` 不在仓库 typecheck / lint 覆盖内**：`tsconfig.json` 的 include 只有 `["src","shared","vite.config.js"]`（另有 `server/`、`scripts/` 两个 tsconfig），`oxlint` 只扫 `src/ server/ scripts/ shared/`。本 spec 的"类型正确"因此只能由 Playwright 运行本身担保 —— 这与既有 633 行的兄弟 spec 处于同一状态，不是本任务引入的缺口。
5. **工作树干净度**：主 checkout 在我开始时有 5 条与本任务无关的未跟踪路径（`artifacts/gap-settings-access-tokens-dod-{form-default-name,oauth-collapsed,oauth-expanded,pat-list}.png`、`goals/AC-322.lock`，而 `scripts/quay-runtime-artifacts.txt` 只列 `.workflow-events/`、`orchestration/…`、`milestones/fast-mode-telemetry/*.json`、`**/.quay-parse-cache.json`）。**收尾复验：`git -C <主检出> status --porcelain` 已为空**（兄弟任务把这两条精确写进 `.git/info/exclude`，见该文件里 `# quay worker (gap-ac266)` 注释），故 fan-in 的 clean-tree 检查在退出时是绿的。本任务的 11 张截图与文本只存在于**本 worktree**，不进主检出、也不进合并增量。
6. **判据 CMD1 的运行时预算**：合并后实测 44.6 s（冷缓存那轮 1.2 m）。这与第 1 条同源 —— 闸上限若仍为 60 s，CMD1 一个命令就可能吃掉全部预算。
