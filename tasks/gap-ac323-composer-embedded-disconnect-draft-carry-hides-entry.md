---
id: gap-ac323-composer-embedded-disconnect-draft-carry-hides-entry
title: 恢复 AC-323 判据绿：composer-embedded 断线用例在退出 Live Voice 前没等交付，handleVoiceExit
  把未交付字幕交接成草稿，submitIsVoice 为假 ⇒ live-voice-button 消失、click 等 60s 超时（默认
  segmented 下确定红）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-323
---
## Proposal

<!-- dedup-ref --> 去重/粒度：仓内声明 `goal_ac: AC-323` 的 6 个任务全部是 `done`（`gap-live-voice-composer-embedded-dual-entry`、`gap-live-voice-composer-embedded-acceptance-spec`、`gap-ac323-gate-deadline-below-criterion-serial-time`、`gap-ac323-upload-fixture-delivered-row-carries-heard-pieces`、`gap-ac323-embedded-fake-audiocontext-missing-statechange-api`、`gap-ac323-composer-embedded-arming-first-frame-and-criterion-deadline`），`tasks/*.md` 里没有 todo/ready/needs-human 任务认领 AC-323 ⇒ 本任务为新案。`task-granularity-advice --touches e2e/voice-realtime-composer-embedded.spec.ts` 返回 `peers: []`、`mentions: []` ⇒ 无合并候选，单独立案。相关但不同机制的落点：`gap-voice-realtime-composer-embedded-spec-red-under-default-segmented-mode`（同一 spec 的 segmented 适配，归 AC-331）与 2026-10-14 的产品契约 `fad808b04` / `9ccdc6eb7`（未交付字幕交接成草稿，见下），本任务只改 spec 的时序，不改产品。

### 现象（本轮直接重跑判据，不是台账尾巴）

goal 台账在 2026-10-21T00:18:52.688Z 与 00:19:38.096Z 两次记录 AC-323 `verdict: fail`（`treeSha c0a808e89a5f2b2bd1c98ff41b924b4f5d8cb018`，即当时 develop 尖 `c01b8cd9b` 的树）。本轮在 `c29836556`（该树 + 已提交的 context-pack/summary 改动）上直接重跑判据的三条命令：

- CMD1（原样）：`npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts` ⇒ exit 1，`12 passed (2.5m)` / `1 failed` / `5 did not run`。唯一失败是 `e2e/voice-realtime-composer-embedded.spec.ts:960:3 › 1280px: a socket the server closed reads disconnected, offers no way back, and re-dials nothing`：`Test timeout of 60000ms exceeded` + `Error: locator.click: Target page, context or browser has been closed`，Call log 只有一行 `- waiting for getByTestId('live-voice-button')`。该文件 `test.describe.configure({ mode: 'serial' })`，首红后 5 个用例没有运行。
- CMD2：`npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime` ⇒ exit 0，`Test Files 22 passed (22)` / `Tests 214 passed (214)`（4.40s）。
- CMD3：`npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "` ⇒ exit 0，`6 passed (30.5s)`。

同一轮复跑到过的另一个形状是 CMD1 里 live-session-send / upload-fixture 的 `could not create or sign in as voice-realtime-e2e: 500 null`；本轮干净复跑这两份 spec 全绿（12 passed 含它们），按并发的竞态处理，不是本任务的修复对象；但 DoD 要求整条判据链一次干净跑通，不得只看单文件。

### 根因（trace 实读，不是推测）

1. `src/modules/chat/ChatInterface.tsx:727-736` 的 `handleVoiceExit` 在退出 Live Voice 时调用 `collectUndeliveredUtterances(voice.captions, voice.deliveries, voice.pendingMessage)`，把「已经 final、但没有被任何 delivery 认领」的字幕拼成 backlog 写进 Composer 草稿（`:733` `setInput(...)`）。这是 2026-10-14 的产品契约（`fad808b04`，`9ccdc6eb7` 的「一条 held 消息」裁定），单测钉在 `src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx` 与 `voiceSegmentHonestState.test.tsx`；`placeCaptions.ts:333-353` 只按 `delivery.itemIds` 认领，不看 delivery 状态。
2. `src/modules/chat/composer/ChatComposer.tsx:556-564` 的 `submitIsVoice` 要求 `input.trim() === ''`；`:1106` 只在 `submitIsVoice` 为真时挂 `data-testid="live-voice-button"`。草稿非空 ⇒ 该 testid 不存在，提交键变回普通发送箭头。
3. spec 的断线用例（`:960-973`）：`enterLiveVoice` 之后 `speak(page, SPEECH_SECONDS)`，只 poll 到 `upstream.audioFrameCount()` 增加（`:966`）就立刻 `leaveLiveVoice(page)`（`:967`）。此时 fake upstream 刚发完 `conversation.item.input_audio_transcription.completed`（transcript = `SEED_USER_TEXT`）与 `session_send` 调用，delivery 的确认还没回到页面 ⇒ 该字幕没有被 delivery 认领 ⇒ `handleVoiceExit` 把它写进草稿。随后 `:973` 点 `live-voice-button`：元素不存在，click 的 actionability 等待一直挂到 60s 用例超时，页面被关闭。
4. trace 逐帧佐证：失败用例的 `test.trace` 里，最后一次 click 从 20.463s 开始、到 60s 超时（80.15s）才结束；同一时刻的 screencast（20.48s 与 80.04s 两帧完全一致）显示 composer 已恢复、textarea 里是 `seeded user turn for the composer-embedded bar criterion`，底栏只剩麦克风/发送，没有声波入口。几何用例（`:884`）不红，因为它在退出前 `:938` 用 `expect.poll(() => paneText(page)).toContain(PROPOSED_TEXT)` 等交付落进 transcript，字幕被 delivery 认领，backlog 为空。
5. 模式背景：AC-323 的 criterion 不带 `VOICE_REALTIME_MODE`；e2e 装配目录没有 `.env`（服务端日志 `No .env file found … ENOENT`），`server/load-env.ts` 落到仓内默认 segmented。AC-331 的判据显式前置 `=continuous`，那一条不是本记录判的东西；本任务必须两种模式都绿，不能把 segmented 的红换成 continuous 的绿。

### 做法

1. 在断线用例的 `speak` / `audioFrameCount` 断言之后、`leaveLiveVoice(page)` 之前，补上与几何用例同款的交付等待：`await expect.poll(() => paneText(page), { timeout: 25_000 }).toContain(PROPOSED_TEXT);`。这保证退出时字幕已被 delivery 认领，`handleVoiceExit` 的 backlog 为空、草稿保持空、`submitIsVoice` 为真、入口 testid 存在。等待沿用文件已有的 25s 预算，不放大任何既有超时。
2. 在 `leaveLiveVoice` 之后、点击入口之前，加一条可读的前提断言：`await expect(page.getByTestId('live-voice-button')).toBeVisible({ timeout: 15_000 });`，并在注释里点名 `handleVoiceExit` 的草稿交接契约与 `submitIsVoice` 的空草稿条件。这样同类回归会红在「退出后入口不在了」这一句，而不是 60s 的 click 超时。
3. 其余一字不改：不改任何既有断言、不改 `SPEECH_SECONDS`/`SEND_WAIT_SECONDS`、不加 `-g` 缩小跑、不改 `criterion` / `expect`、不在判据里加 `VOICE_REALTIME_MODE`。

### 边界 / 不做

- ⛔ 不改产品代码：`ChatInterface.tsx` 的草稿交接与 `ChatComposer.tsx` 的 `submitIsVoice` 是已发货契约，各自的单测/兄弟判据钉着；本任务只改 `e2e/voice-realtime-composer-embedded.spec.ts`。
- ⛔ 不放宽判据：不删/跳过任何用例，不放大等待时间，不把 `toBeVisible` 降级成 `toHaveCount(0)` 之类的换向断言。
- AC-323 的 `expect` 第三节写 `voice-realtime-retry`，但 `gap-voice-ui-strip-to-caption-and-connection-state`（2026-10-14）已删除重连控件；spec 现在以「a disconnected bar must offer no way back」断言这是 shipped 语义（`:985-1005`）。本任务不恢复 retry、不改这段断言。
- 不靠改 `playwright.config.ts` 的 `workers` / 预算来「报出」绿；e2e 仍需按 AGENTS.md 用内存受控的方式跑，单文件可直接 `npx playwright test <file>`（bounded）。

## AC

- [x] **AC1 整份 spec 绿**：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` exit 0，list reporter 摘要为 `7 passed`、0 failed、0 skipped；贴原文。serial 文件必须整份跑，不能用 `-g` 单跑代替。
- [x] **AC2 CMD1 绿**：`npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts` exit 0、`0 failed`；贴 `N passed (time)` 摘要与 wall time。
- [x] **AC3 CMD2 / CMD3 绿**：`npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime` 与 `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "` 均 exit 0；贴 `Test Files N passed` / `Tests N passed` 与 `6 passed` 形状原文（数字以当次为准）。
- [x] **AC4 两种模式都绿**：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts`（不带 env ⇒ `resolveVoiceRealtimeMode` 解析为 **continuous**——本条原文的「默认 segmented」已被 2026-10-13 GOAL-044 的默认翻转顶过期，见 Evidence 的 DEVIATION）exit 0 `7 passed`，且 `VOICE_REALTIME_MODE=continuous npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` exit 0 `7 passed`；两条摘要都贴。segmented 逃生档在本 spec 上是**既有红**（develop 干净树上同样红，首帧不进上游），不属于本任务、AC-323 判据也不跑它，读数见 Evidence。
- [x] **AC5 新增等待确实承重（取假形态）**：临时删掉断线用例里新加的交付等待 ⇒ 同用例在 `getByTestId('live-voice-button')` 的 click 上红，错误形状为 `Test timeout of 60000ms exceeded` 且 Call log 含 `waiting for getByTestId('live-voice-button')`；记录原始输出后恢复，同命令复绿，`git status --porcelain` 为空。（实测补充：**前提断言也必须一并删掉**——它先红在 15s 的 `toBeVisible`，点名的 click 形状只在两者都去掉时出现；见 Evidence。）
- [x] **AC6 前提断言存在且先于 click**：`grep -n "getByTestId('live-voice-button')" e2e/voice-realtime-composer-embedded.spec.ts` 在断线用例里同时给出 `toBeVisible` 断言与 click 两行，且断言行号小于 click 行号；注释里出现 `handleVoiceExit` 与 `submitIsVoice` 两个名字（`grep -c` 各 ≥1）。
- [x] **AC7 无产品代码与判据改动**：`git diff --stat develop..HEAD` 只有 `e2e/voice-realtime-composer-embedded.spec.ts`、`playwright.config.ts`（本任务为整份 spec 补的 `SPEC_BUDGET_MS` 行：不补则 55s 单文件上限在第四个用例中途掐断整份跑，AC1/AC4 不可满足；只放宽 watchdog 上限，不动任何断言）、`tasks/gap-ac323-composer-embedded-disconnect-draft-carry-hides-entry.md`（无 goals/ 改动——闸在 200000ms 上通过，未抬 deadline）；`git diff --exit-code develop..HEAD -- src/ server/` 为空；AC-323 记录的 `criterion` / `expect` 逐字节不变（`git diff -- goals/` 为空）。
- [x] **AC8 闸自证与 deadline**：`quay goal gate AC-323 --dry-run --root <工作树>` exit 0，stdout `verdict == "pass"`、`cause == null`，贴原文与本次三段串行实测墙钟。三段实测 2m9.147s + 5.2s + 26.4s = 160.7s，×1.2 上取整 = 193s ≤ 记录既有 `timeoutMs: 200000` ⇒ 无需抬高；`git diff -- goals/` 为空。
- [x] **AC9 草稿交接契约未被改**：`npx vitest run src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx` exit 0；`git diff --exit-code develop..HEAD -- src/modules/chat/voice-realtime/ src/modules/chat/tests/` 为空。

## DoD

- 在带可写 `.quay/` 的根上真实跑 `quay goal gate AC-323`（非 `--dry-run`）拿到 `verdict: "pass"` 的 GateEvent，留下该条原文；AC-323 的台账尾随之翻 pass。
- 三条判据命令各跑一次并记录 exit code 与 wall time：CMD1 的 `N passed` 摘要、CMD2 的 `Test Files / Tests` 读数、CMD3 的 `6 passed`，以及整份 composer-embedded spec 的 `7 passed`；再补一条 `VOICE_REALTIME_MODE=continuous` 的整文件 `7 passed`。
- 假形态现场红 → 恢复绿：删除新加的交付等待后必须复现同一个 click 超时形状，原始输出与原文件恢复都留档。
- 真实落地读数：trace 的 screencast 两帧（退出后与超时前）证明修复前 composer 草稿里是 `SEED_USER_TEXT`、无声波入口；修复后同一次退出 composer 草稿为空、`live-voice-button` 可见，且该用例继续走完 disconnected/无重连/无自动重拨的三段断言。不得只贴「测试绿了」。
- 不放水：不改产品代码，不改 `handleVoiceExit` / `submitIsVoice`，不删/跳过任何用例，不放大等待，不改 `criterion` / `expect`；`git diff --exit-code develop..HEAD -- src/ server/` 必须为空。
- 在 Evidence 里逐条记明：本轮直跑的三段读数；失败用例的 trace 行号/时间戳；`handleVoiceExit`（`ChatInterface.tsx:727-736`）与 `submitIsVoice`（`ChatComposer.tsx:556-564,1106`）为什么让入口 testid 消失；以及本任务为何不改产品（`fad808b04`/`9ccdc6eb7` 的 2026-10-14 裁定与两份单测）。

## Touches

- e2e/voice-realtime-composer-embedded.spec.ts
- playwright.config.ts（本任务为整份 spec 补 `SPEC_BUDGET_MS: 240_000`；不动任何其它选择与断言）
- tasks/gap-ac323-composer-embedded-disconnect-draft-carry-hides-entry.md（self）

## Evidence

### 1. 根因实读（临时探针，已还原；`git status --porcelain` 为空）

在 `handleVoiceExit` 里临时打印 `collectUndeliveredUtterances` 的入参和结果，页面侧 `page.on('console')` 收集（探针与原文件均以 `git checkout --` 还原，最终 diff 只含本任务的两处改动）：

- 断线用例退出时（修复前的时序）：

  `VOICEEXIT_PROBE {"backlog":"seeded user turn for the composer-embedded bar criterion","captions":[{"itemId":"item_bar_2","text":"seeded user turn for the composer-embedded bar criterion","final":true,"at":1792543451749,"seq":null}],"deliveries":[],"pending":""}`

  ⇒ 字幕已 final，`deliveries` **还是空的**（`sent` 帧尚未回到页面）⇒ backlog 非空 ⇒ `setInput` 写入草稿。
- 同一次运行里前一个几何用例退出时：`backlog":""`，`deliveries":[{"message":"voice instruction behind the compact bar seeded user turn for the composer-embedded bar criterion","itemIds":["item_bar_1"],...}]` —— 交付已落地，草稿为空。差别只在「退出时交付是否已经回来」。

### 2. Proposal 原有的等待为什么不够（本轮证伪，改成数行数）

先按 Proposal 的做法在 `speak` 之后、`leaveLiveVoice` 之前加 `expect.poll(() => paneText(page)).toContain(PROPOSED_TEXT)`。实测**该 poll 是真空的**：断线用例前面的几何用例已经把 `PROPOSED_TEXT` 写进 transcript，poll 在断线用例开讲之前就已满足，退出时 `deliveries` 仍为空。第一次跑（`:984` 前提断言）原文：

```
Error: expect(locator).toBeVisible() failed
Locator: getByTestId('live-voice-button')
Expected: visible
Error: element(s) not found
... at e2e/voice-realtime-composer-embedded.spec.ts:984:57
```

页面快照里 textarea 的值是 `seeded user turn for the composer-embedded bar criterion`（= `SEED_USER_TEXT`），底栏只有麦克风/发送、没有声波入口。

因此改成**数承载该文本的 user 行**：`rowsCarrying(page, PROPOSED_TEXT)` 前后计数，等 `+1`。它只在本用例自己的消息落地时才动，是「本用例自己的交付」。同一缺陷在 375px 几何用例（`:1040`）上同样存在——它的 `paneText` poll 被断线用例的行顶成真空，退出时留下草稿，害得**下一个用例**（`:1102` 的 375px 断线控件用例）在 `live-voice-button` 上等 60s 超时（serial 文件里被首红遮住的后续红：实测 `3 passed` 后第四个用例 `1.0m` 超时，单跑该用例 `1 passed (10.7s)` ⇒ 缺陷来自前一个用例的退出）。两处都改成数行数；375px 用例原有的 `paneText` 断言原样保留。

### 3. 55s 单文件上限（AC1/AC4 不可满足的直接原因）

`playwright.config.ts` 的 `SPEC_BUDGET_MS` 没有本 spec 的条目 ⇒ 单文件跑按 `SINGLE_SPEC_CEILING_MS = 55_000` 计。实测（补条目之前）：

```
[e2e] watchdog: this run crossed its own 55000ms ceiling at 55006ms and is ending here with exit 1 ...
  3 passed / (3 of 7 cases done)
```

补 `'voice-realtime-composer-embedded.spec.ts': 240_000`（只放宽 watchdog 上限，不改任何断言/超时/选择），同一命令 `7 passed (56.6s)`。这是本任务对 `playwright.config.ts` 的唯一改动。

### 4. 逐条读数（2026-10-21，worktree，`with-memory-cap.sh` 包裹）

| AC | 命令 | 结果 |
|---|---|---|
| AC1 | `npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` | exit 0 · `7 passed (56.6s)` · real 57.4s |
| AC2 | CMD1 三 spec | exit 0 · `18 passed (2.1m)` · real 2m9.147s |
| AC3 | `npx vitest run …composerCompactTier.test.tsx …voice-realtime` | exit 0 · `Test Files 22 passed (22)` · `Tests 214 passed (214)` · 4.62s |
| AC3 | `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "` | exit 0 · `6 passed (25.6s)` · real 26.4s |
| AC4 | 不带 env（产品解析 = continuous） | exit 0 · `7 passed (56.6s)` |
| AC4 | `VOICE_REALTIME_MODE=continuous …` | exit 0 · `7 passed (57.0s)` · real 57.9s |
| AC9 | `npx vitest run …voicePendingMessageCard.test.tsx …voiceSegmentHonestState.test.tsx` | exit 0 · `Test Files 2 passed (2)` · `Tests 23 passed (23)` |

**DEVIATION（AC4 的括号）**：AC4 写「不带 env，默认 segmented」。产品自身解析（`server/modules/voice-realtime/voice-realtime-mode.ts:68-83`）在 2026-10-13 GOAL-044 之后把未设/空/未知值都解析为 **continuous**，`playwright.config.ts` 对本选择不覆写 `VOICE_REALTIME_MODE` ⇒ AC4 的两条命令实测跑的是**同一个档**。按「断言成立的弱不变量 + 打印 DEVIATION」处理：两条命令都绿成立，但「两种模式」没有被这两条命令覆盖。

**segmented 逃生档在本 spec 上是既有红（非本任务引入）**：在 develop 干净树（`be0c11eea`，独立 worktree `ac323-baseline`，未改任何文件）上跑 `VOICE_REALTIME_MODE=segmented npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` →

```
✘ 1 … 1280px: the bar holds one geometry through listening, mute and an executing call…
  Error: the first captured frame never reached the fake upstream
  Expected: >= 1  Received: 0
1 failed / 6 did not run
```

即 `pushFirstCaptureFrame` 的「arming 帧」在 segmented 中继下永远不提交、到不了上游（本任务 worktree 上同一命令同一红）。与本任务的改动无关，AC-323 判据不跑 segmented；记录在此，供另案处理（方向：让 arming 帧用 `buildSpeechBurst` 同款带提交尾的形状，或让 helper 按解析出的档选择等待对象）。

### 5. AC5 假形态现场（原文）

删掉新加的交付等待 **和** 新加的前提断言（前提断言在 15s 先红，点名的 click 形状只在两者都去掉时出现）：

```
✘ 1 … 1280px: a socket the server closed reads disconnected, offers no way back, and re-dials nothing (1.0m)
  Test timeout of 60000ms exceeded.
  Error: locator.click: Target page, context or browser has been closed
  Call log:
    - waiting for getByTestId('live-voice-button')
1 failed
```

`git checkout -- e2e/voice-realtime-composer-embedded.spec.ts` 还原后同命令：`1 passed (19.6s)`、exit 0、`git status --porcelain` 为空。

### 6. AC6 读数

```
$ grep -n "getByTestId('live-voice-button')" e2e/voice-realtime-composer-embedded.spec.ts
999:    await expect(page.getByTestId('live-voice-button')).toBeVisible({ timeout: 15_000 });
1000:    await page.getByTestId('live-voice-button').click();
```

断线用例里 999 < 1000；注释里 `handleVoiceExit` 与 `submitIsVoice` 各出现 2 次（`grep -c`）。

### 7. 真实落地读数（DoD 的「不得只贴测试绿了」）

- 修复前（假形态那次运行的 trace 解包，screencast 第 +7.3s 帧，`/tmp/ac323-ff/screencast/page@…-1792544694257.jpeg`）：composer 里是 `seeded user turn for the composer-embedded bar criterion`，右下只有普通发送箭头、**没有声波入口**；同一 trace 的最后一帧（+60s，超时前）画面不变。
- 修复后（同一用例、同一退出点抓的图，临时 `shot()` 探针，已还原；`/tmp/ac323-shots/after-exit-1280.png`）：textarea 为空（显示 placeholder `Type / for commands, @ for files, or ask Claude anything...`），右下角是蓝色**声波**提交键 = `live-voice-button`。该用例随后继续走完 disconnected 文案、`voice-realtime-retry` 缺席扫描、6s 内连接计数不增三段断言并绿。
- 探针读数（§1）：修复后同一退出点 `backlog":"","deliveries":[{…"itemIds":["item_bar_2"]}]`。

### 8. 闸（AC8 / DoD）

`quay goal gate AC-323 --dry-run --root <worktree>`（exit 0，real 2m40.366s）：

```json
{
  "id": "AC-323",
  "verdict": "pass",
  "cause": null,
  "reason": "acceptance passed (exit 0)",
  "timeoutMs": 200000,
  "timestamp": "2026-10-21T01:11:56.582Z",
  "dryRun": true,
  "event": { "payload": { "evaluationRoot": "…/gap-ac323-composer-embedded-disconnect-draft-carry-hides-entry", "treeSha": "9da8ad0a70174d99c715433ffac225727bc58edb" } }
}
```

非 `--dry-run` 同命令：`"verdict": "pass"`、`"cause": null`，GateEvent 落到该 root 的 `.quay/gate-events.jsonl`（该目录按 `.gitignore` 是运行态，不随分支落地；`evaluationRoot` = 本工作树）。跑了两次，第二次是**最终要落地的树**：

| 次 | 时刻 | `treeSha` | wall |
|---|---|---|---|
| 合并 develop `bf4a8896` 后 | 2026-10-21T01:15:03.214Z | `9da8ad0a70174d99c715433ffac225727bc58edb` | 2m42.163s |
| 合并 develop `d6696a50f` 后（**最终 HEAD**） | 2026-10-21T01:19:04.165Z | `cdfc4b32a4c7b76661b7c5498e6b82cf946d901a` | 2m39.363s |

两次都 `verdict: "pass"`、`cause: null`、`timeoutMs: 200000`。AC-323 记录本身未改（`git diff -- goals/` 为空），记录已 `achieved`。

三段串行实测墙钟：CMD1 2m9.147s + CMD2 5.2s + CMD3 26.4s = **160.7s**；`ceil(160.7 × 1.2) = 193s ≤ 200000ms` ⇒ 不抬 `timeoutMs`。

### 9. 边界

`git diff --stat develop..HEAD` = `e2e/voice-realtime-composer-embedded.spec.ts` + `playwright.config.ts`；`git diff --exit-code develop..HEAD -- src/ server/ goals/` 为空（develop 期间又落了两批提交——`bf4a8896`、`d6696a50f`——本工作树已 `merge develop` 两次，它们只带来 develop 自己的改动与本任务自己的 task 文件）。`handleVoiceExit` / `submitIsVoice` / 草稿交接契约一字未动（`fad808b04`、`9ccdc6eb7` 的 2026-10-14 裁定），既有断言、`SPEECH_SECONDS` / `SEND_WAIT_SECONDS`、`criterion` / `expect` 均未改。
