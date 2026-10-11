---
id: gap-live-voice-caption-row-sorts-above-real-user-row
title: Live Voice 字幕泡泡排到正在处理的消息上面：未上屏的 caption/被拒行按浏览器首见时间与 CLI
  回合开始时间跨时钟比较插入，应永远排在最新真实 user 行及其回复之后
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

### 现象（2026-10-11 操作者实测，会话 79d7515b-24b8-409c-b434-f4669105373b）

Live Voice 里，用户在 Claude 正处理上一条语音消息时继续说话，新话语的 caption 行（`delivering`/`heard`）被排到**正在处理的那条真实 user 消息上面**。操作者原话即那句被错排的话本身：「我会发现…泡泡…上面去」。

证据（voice journal `/data/home/yale/.cloudcli/voice-realtime-log/57279cc1-f597-428f-8f39-7e1d53804510.jsonl`）：
- 消息 A「然后当你在处理…」说话区间 15:41:10.6–16.4Z，`sent` 于 15:41:30.513；真实 user 行时间戳 15:41:30.521（= CLI 回合开始时刻）。
- 话语 B「我会发现…泡泡…上面去」第一条 caption 到达浏览器 15:41:20.757。
- 把这条时间线喂给真实的 `placeCaptions.ts`，得到顺序：上一条 reply 15:40:57 / voice-caption-B 15:41:20（delivering）/ userA 15:41:30 / reply-A ——**B 在 A 上面**。（探针脚本 `/tmp/tmp.gyRoGC2fxq/probe.mts`，可能已被清理。）

### 根因（2026-10-11 逐文件复核，带 file:line）

- `src/modules/chat/voice-realtime/placeCaptions.ts:389-411` `placeCaptionsChronologically`：对每条真实行，把时间戳**早于**它的 caption 行先推进结果（`:399` 的 `while (… < at)`）——即 caption 插到「第一条时间更晚的真实行」之前。
- 两边时间戳不是同一种量、也不是同一个时钟：caption 的时间 = 浏览器**首次看到**该 utterance（`useVoiceRealtimeSession.ts:829` 的 `at: Date.now()`，经 `placeCaptions.ts:172` `timestamp: first.at` 落到行上）；真实 user 行的时间 = **CLI 回合开始**，它晚于说话本身一个合并窗口（服务端 coalescing，`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:929-930`，部署值 2500 ms）再加上 CLI 队列等待（会话忙时可达分钟级）。所以「后说的 B」的 caption 时间系统性地早于「先说的 A」的真实行时间。另外浏览器时钟与服务端时钟比较本身就跨时钟。
- `foldCaptionsIntoTranscriptRow`（`placeCaptions.ts:137`，`:162` 取 `first`）把所有待定 utterance 折进一行、按**第一条**的时间盖章，进一步把整行往前拉。
- 接线：`src/modules/chat/ChatInterface.tsx:549-566`——`:559` 对折叠行调用 `placeCaptionsChronologically`，`:565-566` 对 `undeliveredUtteranceRows`（被拒话语，每句一行）用**同一规则**再排一次，所以被拒行也有同样的错排。

### 修法方向（操作者已定）

**尚未上屏的 caption 行（`delivering` / `heard` / `undelivered`）永远不排到任何真实 user 行之上**：它放在**最新一条真实 user 行及该回合的 reply 行之后**。理由：凡是已被真实行接管的话语，早已被 `markDeliveredVoiceMessages` / `dropCaptionsDeliveredAsMessages` 从 caption 集合里拿掉（`ChatInterface.tsx:557-561`）；还剩在 caption 集合里的，按定义都是「还没变成真实消息」的话，它在对话里的位置只能是「最新的那条之后」。`undeliveredUtteranceRows` 的行同理（`ChatInterface.tsx:563-566` 注释「sits where in the conversation it was spoken」的意图随之改写）。

⚠️ 不得回到 `43504ab9` 之前的老毛病：那次把 caption 从「整段 transcript 末尾」改成按时间排，是为了修「caption 拖在 Claude reply 下面、又重复显示已投递的消息」。重复显示今天已由 `markDeliveredVoiceMessages` / `dropCaptionsDeliveredAsMessages` 负责，本任务不得削弱这两步；新规则只改**位置**，不改**哪些行留下**。

### 与既有测试的冲突（必须照实处理，不得静默改）

`src/modules/chat/voice-realtime/tests/placeCaptions.test.ts:11-15`（「a caption lands before the real rows that came after it, not after Claude's reply」）与 `:23-27`（「captions interleave with the rows around them」）**钉住的正是本缺陷的旧规则**——caption 插到更晚的真实 user 行之前。它们必须按新规则改写（并在提交说明里写明理由），不能保持原样绿；其余用例（`:17-21`、`:29-33`、`:35-38` 及 `dropCaptionsDeliveredAsMessages` / `markDeliveredVoiceMessages` 两组）保持不变且绿。

### 关联 / 粒度

<!-- dedup-ref --> 相邻但机制不同：`gap-live-voice-single-transcript-row`（AC-326，done，折叠成一行）与 AC-327 的交付状态线性可见——本任务不改折叠与状态机，只改折叠行/被拒行在 transcript 里的插入位置。`task-granularity-advice` 对本任务 Touches 无 open 同文件 peer：none found。kept separate：操作者要求三条独立立案（字幕位置 / Exit 键外观 / 可恢复错误显示是三个独立验收面）。

## AC

- [x] AC1 回归用例（**取假形态，排在 `placeCaptionsChronologically` describe 最前**）：在 `src/modules/chat/voice-realtime/tests/placeCaptions.test.ts` 新增用例复现 15:41 时间线——真实行 `prev-reply`(15:40:57Z, assistant) / `userA`(15:41:30.521Z) / `reply-A`(15:41:35Z, assistant)，caption 行 `voice-caption-B`(Date.parse('2026-10-11T15:41:20.757Z'), `voiceRowState: 'delivering'`)——断言输出顺序里 `voice-caption-B` 的下标 **大于** `userA` 与 `reply-A` 的下标。在未修复的树上该用例必红（实施者在 `## 验证记录` 记一次红读数），修复后绿。判据：`npx vitest run src/modules/chat/voice-realtime/tests/placeCaptions.test.ts` 退出 0。
- [x] AC2 被拒行同规则：同一测试文件新增用例——`undeliveredUtteranceRows` 产出的被拒行（时间戳早于最新真实 user 行）经 `placeCaptionsChronologically` 后排在最新真实 user 行之后。判据同 AC1 命令退出 0。
- [x] AC3 旧规则用例改写而非删除：`placeCaptions.test.ts` 原 `:11-15` 与 `:23-27` 两条按新规则改写（期望顺序改为 caption 在所有真实 user 行之后），其余既有用例一字不改。判据：AC1 命令退出 0，且 `git diff develop -- src/modules/chat/voice-realtime/tests/placeCaptions.test.ts` 中被删除的 `expect(` 行只来自这两条用例（实施者在验证记录贴出该 diff 摘要）。
- [x] AC4 相邻判据不回归：`npx vitest run src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx src/modules/chat/voice-realtime/tests/voiceDeliveryState.test.tsx src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx` 退出 0。
- [x] AC5 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

一个**真实对象**被这套机制操作过：真实浏览器里的真实 Live Voice 会话，Claude 正在处理一条语音消息 A 时（回合在飞），操作者再说一句 B——B 的 caption 行（delivering/heard）**出现在 A 的真实 user 行及其 reply 之下**，而不是 A 之上；A 回合结束、B 被投递成真实行后，B 的真实行同样位于 A 之后且 caption 不重复显示。证据落在本任务 `## 验证记录`：该次 voice journal 路径与 A 的 `sent` / B 的首条 caption 时刻、一张 B caption 在飞期间的截图（能看到 A 在上、B 在下）、以及 B 落地后的截图。⛔ fan-in suite 不跑 Playwright，浏览器读数由本任务自证；仅有单元测试不算 done。

## Touches

- src/modules/chat/voice-realtime/placeCaptions.ts
- src/modules/chat/ChatInterface.tsx (only if the wiring at :549-566 must pass the newest real user row or change call order)
- src/modules/chat/voice-realtime/tests/placeCaptions.test.ts
- tasks/gap-live-voice-caption-row-sorts-above-real-user-row.md (self)

## 验证记录

### AC1–AC3（`placeCaptions.test.ts`；AC1 命令 `npx vitest run src/modules/chat/voice-realtime/tests/placeCaptions.test.ts`）

- 修复树（HEAD，已 merge develop）：`Test Files 1 passed (1) / Tests 18 passed (18)`，退出 0。
- 未修复树红读数（把 `git show <merge-base>:src/modules/chat/voice-realtime/placeCaptions.ts` 换回工作树、跑同一命令、再还原）：`Tests 4 failed | 14 passed (18)`，退出 1。失败的四条正是：
  - AC1 `placeCaptionsChronologically > a caption spoken while the previous turn is still in flight stays BELOW that turn, never above its message`
  - AC2 `placeCaptionsChronologically > a refused utterance spoken before the newest real row is placed BELOW it, not above it`
  - AC3 两条旧规则改写用例 `... a caption lands after the real rows that came before it, not before the last one Claude is answering`、`... captions go after every real user row, never interleaved among them`
- 其余 14 条（含 `dropCaptionsDeliveredAsMessages` / `markDeliveredVoiceMessages` 两组及 `:17-21`/`:29-33`/`:35-38`）两树皆绿、一字未改。

AC3 diff 摘要（`git diff <merge-base>..HEAD -- src/modules/chat/voice-realtime/tests/placeCaptions.test.ts`，34 insertions / 5 deletions）。被删除的 `expect(` 行恰好两条，均来自上述两条旧规则用例：

```
-    expect(ids(placeCaptionsChronologically(messages, [caption]))).toEqual(['older', 'voice-caption-a', 'sent', 'reply']);
-    expect(ids(out)).toEqual(['m1', 'c1', 'm2', 'c2', 'm3']);
```

### AC4（相邻判据不回归）

`npx vitest run src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx src/modules/chat/voice-realtime/tests/voiceDeliveryState.test.tsx src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx` → `Test Files 4 passed (4) / Tests 40 passed (40)`，退出 0。

### AC5（静态门）

`npm run typecheck` → 退出 0（tsconfig.json + server/tsconfig.json + scripts/tsconfig.json 三层全过）。`npm run lint` → 退出 0（仅存量 warning，涉及文件无本任务改动）。

### DoD（真实浏览器读数，本任务自证；fan-in suite 不跑 Playwright）

真实浏览器 + 真实 server + 真实 `/voice-realtime` 代理与 bridge + 真实 `session_send`；上游是脚本化的假 Realtime endpoint（与本目录既有 voice e2e 同一方言），真实 debug-agent 会话由 `/api/debug-agent/scenarios` 布防。

场景：进入 Live Voice 后，说 A「然后，当你在处理我的一个消息的时候，如果继续说。」并闭合（completed），随即 relay A（`session_send`）——代理打开 2500 ms coalescing 窗口，**A 回合在飞、其真实 user 行尚未写出**；此时再说 B「我会发现啊，心。」（interim，浏览器首见）；等 A 真实行落地后把 B 闭合为 final（`heard`）；再 relay B 使其落地。

该次 voice journal：`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-gq7OIj/voice-realtime-log/f48ba359-724e-4433-b292-109078fe07e6.jsonl`（会话 `ffd85805-eba9-4bce-9777-fef8bee68c32`，mode segmented）。关键时刻：

- A 的 `sent`：journal `session_send delivered in 16 ms` @ **2026-10-11T16:17:22.953Z**（`coalesced 1 relayed piece(s)` @ 16:17:22.937；`queued: opening a 2500 ms coalescing window` @ 16:17:20.033）。A 真实 user 行 DOM `data-message-timestamp` = **2026-10-11T16:17:22.949Z**。
- B 的第一条 caption 时刻：cap 行 DOM `data-message-timestamp` = 1791735440437 = **2026-10-11T16:17:20.437Z**，落在 A 的 2500 ms 窗口 [16:17:20.033, 16:17:22.953] 之内 ⇒ 确为「A 回合在飞时说 B」。其 final 帧 journal `to-browser caption "我会发现啊，心。"` @ 16:17:23.586Z。
- 跨时钟错位：B 的 caption 时间（16:17:20.437Z）**早于** A 真实行时间（16:17:22.949Z）约 2.5 s。旧规则按时间排 ⇒ B 在 A 之上；新规则 ⇒ B 在 A 之下。

DOM 文档序读数（`.chat-messages-pane .chat-message`；document order = 视觉序）：

- 截图 `01-b-while-a-in-flight`（A 在飞、B 实况）：`[0] user seed(16:17:15.926Z)` / `[1] voice-row-delivering`（A+B 折进一行、"Tidying up…"）——A 真实行尚未出现。
- 截图 `02-b-heard-below-a`（**B caption 在飞期间、A 在上 B 在下**）：

```
[0] user                 ts=2026-10-11T16:17:15.926Z  seeded user turn …
[1] user                 ts=2026-10-11T16:17:22.949Z  then while you are handling one of my messages if I keep talking  (From voice transcript)
[2] user voice-row-heard ts=1791735440437 (16:17:20.437Z)  我会发现啊，心。  (Heard)
```

  断言 `bIndex(2) > aIndex(1)` 通过 —— B 的 caption 行位于 A 真实 user 行**之下**，尽管其时间戳更早。
- 截图 `03-b-landed`（B 落地后）：

```
[0] user  ts=2026-10-11T16:17:15.926Z  seeded user turn …
[1] user  ts=2026-10-11T16:17:22.949Z  then while you are handling one of my messages if I keep talking  (From voice transcript)
[2] user  ts=2026-10-11T16:17:26.551Z  I will find out, hmm  (From voice transcript)
```

  断言 `bRow(2) > aRow(1)` 通过，`captionLeft == 0`（B 的真实行落在 A 之后且 caption 不重复显示）。

截图（PNG，本机 `/tmp`，随 e2e tmp 回收）：`/tmp/caption-order-evidence/01-b-while-a-in-flight.png`、`/tmp/caption-order-evidence/02-b-heard-below-a.png`、`/tmp/caption-order-evidence/03-b-landed.png`（另有 `00-entered.png`）。

补充（诚实披露）：本布防的 debug-agent 场景时钟不推进，故该 arm 的 transcript 里**没有** A 的 assistant reply 行，浏览器读数落在「B 位于 A 真实 user 行之下」。DoD 中「及其 reply 之下」的一半由 AC1 用例（同一时间线含 `reply-A`，断言 B 的下标 > `reply-A` 的下标）与机制本身（未上屏 caption 恒追加到 transcript 末尾，位于任何 reply 之后）覆盖。

本次布防用的 Playwright spec 是**一次性**的（未提交）：跑完即删除 `e2e/voice-realtime-caption-order.spec.ts` 并还原 `playwright.config.ts` 的两处临时选择项；工作树对 develop 的净 diff 仅两个 Touches 文件。