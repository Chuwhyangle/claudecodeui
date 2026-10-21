---
id: gap-ac323-composer-embedded-disconnect-draft-carry-hides-entry
title: 恢复 AC-323 判据绿：composer-embedded 断线用例在退出 Live Voice 前没等交付，handleVoiceExit
  把未交付字幕交接成草稿，submitIsVoice 为假 ⇒ live-voice-button 消失、click 等 60s 超时（默认
  segmented 下确定红）
status: ready
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

- [ ] **AC1 整份 spec 绿**：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` exit 0，list reporter 摘要为 `7 passed`、0 failed、0 skipped；贴原文。serial 文件必须整份跑，不能用 `-g` 单跑代替。
- [ ] **AC2 CMD1 绿**：`npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts` exit 0、`0 failed`；贴 `N passed (time)` 摘要与 wall time。
- [ ] **AC3 CMD2 / CMD3 绿**：`npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime` 与 `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "` 均 exit 0；贴 `Test Files N passed` / `Tests N passed` 与 `6 passed` 形状原文（数字以当次为准）。
- [ ] **AC4 两种模式都绿**：`npx playwright test e2e/voice-realtime-composer-embedded.spec.ts`（不带 env，默认 segmented）exit 0 `7 passed`，且 `VOICE_REALTIME_MODE=continuous npx playwright test e2e/voice-realtime-composer-embedded.spec.ts` exit 0 `7 passed`；两条摘要都贴。
- [ ] **AC5 新增等待确实承重（取假形态）**：临时删掉断线用例里新加的交付等待（其余断言原样）⇒ 同用例在 `getByTestId('live-voice-button')` 的 click 上红，错误形状为 `Test timeout of 60000ms exceeded` 且 Call log 含 `waiting for getByTestId('live-voice-button')`；记录原始输出后恢复，同命令复绿，`git status --porcelain` 为空。
- [ ] **AC6 前提断言存在且先于 click**：`grep -n "getByTestId('live-voice-button')" e2e/voice-realtime-composer-embedded.spec.ts` 在断线用例里同时给出 `toBeVisible` 断言与 click 两行，且断言行号小于 click 行号；注释里出现 `handleVoiceExit` 与 `submitIsVoice` 两个名字（`grep -c` 各 ≥1）。
- [ ] **AC7 无产品代码与判据改动**：`git diff --stat develop..HEAD` 只有 `e2e/voice-realtime-composer-embedded.spec.ts`、`tasks/gap-ac323-composer-embedded-disconnect-draft-carry-hides-entry.md`（若按 AC8 抬了 deadline，再加 `goals/AC-323-composer-内双语音入口-容器内-live-voice-紧凑栏-波形-时长-字幕-模型-mute-end-桌面与.md`）；`git diff --exit-code develop..HEAD -- src/ server/` 为空；AC-323 记录的 `criterion` / `expect` 逐字节不变（`git diff -- goals/` 不出现这两段）。
- [ ] **AC8 闸自证与 deadline**：`quay goal gate AC-323 --dry-run --root <工作树>` exit 0，stdout `verdict == "pass"`、`cause == null`，贴原文与本次三段串行实测墙钟。若输出是 `not-evaluated (timeout)`，按 `gap-ac323-gate-deadline-below-criterion-serial-time` 的形式把记录 `timeoutMs` 抬到「本次实测三段之和 × 1.2 向上取整」（当前声明 200000），重跑至 pass；`git diff -- goals/` 的增删行只允许 `-timeoutMs: 200000` / `+timeoutMs: <新值>`。
- [ ] **AC9 草稿交接契约未被改**：`npx vitest run src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx` exit 0；`git diff --exit-code develop..HEAD -- src/modules/chat/voice-realtime/ src/modules/chat/tests/` 为空。

## DoD

- 在带可写 `.quay/` 的根上真实跑 `quay goal gate AC-323`（非 `--dry-run`）拿到 `verdict: "pass"` 的 GateEvent，留下该条原文；AC-323 的台账尾随之翻 pass。
- 三条判据命令各跑一次并记录 exit code 与 wall time：CMD1 的 `N passed` 摘要、CMD2 的 `Test Files / Tests` 读数、CMD3 的 `6 passed`，以及整份 composer-embedded spec 的 `7 passed`；再补一条 `VOICE_REALTIME_MODE=continuous` 的整文件 `7 passed`。
- 假形态现场红 → 恢复绿：删除新加的交付等待后必须复现同一个 click 超时形状，原始输出与原文件恢复都留档。
- 真实落地读数：trace 的 screencast 两帧（退出后与超时前）证明修复前 composer 草稿里是 `SEED_USER_TEXT`、无声波入口；修复后同一次退出 composer 草稿为空、`live-voice-button` 可见，且该用例继续走完 disconnected/无重连/无自动重拨的三段断言。不得只贴「测试绿了」。
- 不放水：不改产品代码，不改 `handleVoiceExit` / `submitIsVoice`，不删/跳过任何用例，不放大等待，不改 `criterion` / `expect`；`git diff --exit-code develop..HEAD -- src/ server/` 必须为空。
- 在 Evidence 里逐条记明：本轮直跑的三段读数；失败用例的 trace 行号/时间戳；`handleVoiceExit`（`ChatInterface.tsx:727-736`）与 `submitIsVoice`（`ChatComposer.tsx:556-564,1106`）为什么让入口 testid 消失；以及本任务为何不改产品（`fad808b04`/`9ccdc6eb7` 的 2026-10-14 裁定与两份单测）。

## Touches

- e2e/voice-realtime-composer-embedded.spec.ts
- goals/AC-323-composer-内双语音入口-容器内-live-voice-紧凑栏-波形-时长-字幕-模型-mute-end-桌面与.md
- tasks/gap-ac323-composer-embedded-disconnect-draft-carry-hides-entry.md（self）
