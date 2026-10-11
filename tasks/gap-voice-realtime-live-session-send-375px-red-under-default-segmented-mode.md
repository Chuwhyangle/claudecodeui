---
id: gap-voice-realtime-live-session-send-375px-red-under-default-segmented-mode
title: 默认 segmented 配置下 e2e/voice-realtime-live-session-send 的 375px
  腿确定性红：该腿自己那条连接的原声回合没落成第二行（:677 的 >=2 只到 1），continuous 下同树全绿
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra: {}
---
## Proposal

（去重）<!-- dedup-ref --> 与仓内现存任务的关系：`gap-voice-realtime-composer-embedded-spec-red-under-default-segmented-mode`（done）修的是**同一类**「默认 segmented 配置下 e2e 红」，但只盖到 `e2e/voice-realtime-composer-embedded.spec.ts` 与 `e2e/voice-realtime-live-session-send.spec.ts` 的 PC 腿（提交 `d70968d8` "make the Live Voice send spec speak so the default segmented path commits"、`ec6b0145`）；本任务是**它没盖到的 375px 腿**。AC-331 的判据前置 mode 讨论中把这条红**显式排除在覆盖范围之外**（见 `goals/AC-331-…-ex.md` 的 expect 第 (d) 条与 `goals/AC-332-…-md` 的 expect），故必须单独立案——否则它会一直躺在两处记录的「不在本判据范围内」里，没有任何任务认领。

### 现象（2026-10-11，manager 同树单变量实测，非转述）

工作树 `/data/home/yale/work/claudecodeui-worktrees/gap-ac331-gate-deadline-and-ac323-regression-reverify`（HEAD `9b4d00b2`，已含 `d70968d8`/`ec6b0145`），唯一变量是 mode：

| 臂 | 命令 | rc | 墙钟 | 结果 |
|---|---|---|---|---|
| `env -u VOICE_REALTIME_MODE` | `npx playwright test e2e/voice-realtime-live-session-send.spec.ts` | **1** | 42875ms | 375px 腿（`:626`）红于 `:677`：`expect.poll(() => page.locator(USER_ROW).filter({ hasText: PROPOSED_TEXT }).count(), {timeout: 25_000}).toBeGreaterThanOrEqual(2)` ⇒ 实收 **1**；`:680`/`:703` 两条 not run |
| `VOICE_REALTIME_MODE=continuous` | 同上 | 0 | 17728ms | **4 passed** |

两臂都以 `scripts/with-memory-cap.sh`（`QUAY_MEMORY_MAX=6G`）包住，cwd = 该工作树。

**为什么这条红不是「判据没前置 mode」的锅**：spec 自己在 `:112` 就按 mode 分支（`segmentedRelayExpected()` 逐字注释 "The same expression decides which framing the upstream should have seen"），**两种 mode 都该绿是它的设计意图** ⇒ segmented 臂不绿是它没覆盖到的形态，不是配置错误。

**语义**：该腿先 `speak(page, SPEECH_SECONDS)` 打完自己的突发语音，再断言「Both legs' turns are on disk: the second connection wrote its own row」——即这条腿**自己的**那条连接应当把自己的回合写成第二行。segmented 下这第二行没有出现。

### 待回答（本任务的核心）

是 (a) **产品缺陷**——默认 segmented 路径下 375px 这次提交真的丢了（浏览器分段器没切 / relay 没提交 / pane 没落行），还是 (b) **harness 不诚实**——仅是该腿的合成语音 `speak()` 在 segmented 路径下造不出一次真实提交（像 `d70968d8` 对 PC 腿所做的那样）？

两者都要读证据定，⛔ 不许二选一猜。

## AC

- [x] AC1 复现并贴原文：在**未设** `VOICE_REALTIME_MODE` 的臂里跑该 spec（`scripts/with-memory-cap.sh` 包），贴 rc、墙钟、失败断言原文（文件名:行）与 reporter 摘要；同树再跑 `VOICE_REALTIME_MODE=continuous` 臂，贴 `N passed` 对照。 —— 已满足，原文见 Evidence §1。
- [x] AC2 根因定位到 (a)/(b) 之一，并给出**读数级**证据（不是推断）：服务端 `[voice-realtime <session8>]` 行（该腿那次连接的 relay / segment-commit 是否发生）、浏览器分段器的切分事件、上游收到的提交帧 / `function_call_output` 计数、盘上该会话的消息行数——四者中至少两项指向同一结论。 —— 结论是 **(b) harness 不诚实**；四项读数见 Evidence §2。
- [x] AC3 修复后**未设 mode** 的臂里该 spec 全绿（贴 rc / passed 原文），且 `VOICE_REALTIME_MODE=continuous` 臂**仍**全绿（不许把一个绿换成另一个红）。 —— 已满足，双臂读数见 Evidence §3（默认臂连跑两次皆绿），并在合并树上复验见 Evidence §6。
- [x] AC4 ⛔ 不许以「把判据或配置前置 continuous」「删/放宽 `:677` 的 ≥2 断言」「给该腿开 skip / fixme」换绿。若结论是 (b)，只能改**发声方式**（让合成语音在 segmented 路径下真实产生一次切分与提交），该断言文本一字不改，diff 只落在发声辅助与必要注释。 —— 结论是 (b)；diff 只落在发声辅助与注释，`:677` 断言文本一字未改，无 skip/fixme、未前置 continuous。见 Evidence §4。
- [x] AC5 若结论是 (a)（产品缺陷），必须同时给出反向 falsification：把修复回滚 ⇒ 该腿复红（贴读数）。 —— 结论是 (b)，本条的 (a) 前提不成立；作为**等价的反向 falsification**，把发声修复回滚回 pre-fix 文件后该腿在同树同命令下复红，读数见 Evidence §5。

## DoD

真实跑通，不是「多了一个变量」：AC1 的对照表、AC2 的证据链、AC3 的双臂读数都要原文进 Evidence；修复落在 develop 上（fan-in 全绿）。

⛔ 仅凭「continuous 下绿」宣布完成**不算**——这条红的定义就是**未设 mode** 的那条臂。

## Touches

- e2e/voice-realtime-live-session-send.spec.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/voiceRealtimeProtocol.ts
- tasks/gap-voice-realtime-live-session-send-375px-red-under-default-segmented-mode.md

## Notes

- 立案人：manager 会话，2026-10-11。判据侧的两个「不在范围内」引用点已写进 `goals/AC-331-…-ex.md` 的 expect 第 (d) 条与 `goals/AC-332-…-md` 的 expect。
- 取证入口（同树单变量）：工作树里 `env -u VOICE_REALTIME_MODE npx playwright test e2e/voice-realtime-live-session-send.spec.ts`；trace 落在 `~/.cache/quay-e2e-tmp/quay-e2e-*/test-results/…/trace.zip`。
- 相关 memory：`voice-realtime-upstream-pool-criterion-idle-flake`（同族 e2e 读数的时钟边界形态）、`relay-segmenter-split-boundary-is-strictly-over-merge-gap`（分段切分边界 >1.5s 停顿）。

## Evidence

工作树 `…/gap-voice-realtime-live-session-send-375px-red-under-default-segmented-mode`（分支 `task/gap-voice-realtime-live-session-send-375px-red-under-default-segmented-mode`，HEAD `260df116`）。命令统一：

```
QUAY_MEMORY_MAX=6G bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-live-session-send.spec.ts
```

cwd = 工作树。唯一变量是 `VOICE_REALTIME_MODE`（pre-fix 两个臂用 `git stash push -- e2e/voice-realtime-live-session-send.spec.ts` 把修复暂存掉，跑完 `git stash pop` 复原；`git diff --stat` 复原后与原修复逐字一致）。

### §1 AC1 —— 复现（pre-fix 同树，单变量 = mode）

| 臂 | rc | 墙钟 | reporter 摘要 |
|---|---|---|---|
| `env -u VOICE_REALTIME_MODE` | **1** | 42716ms | `1 failed … 2 did not run … 1 passed (41.7s)` |
| `VOICE_REALTIME_MODE=continuous` | 0 | 18943ms | `4 passed (18.1s)` |

失败断言原文（`/tmp/ac1-red.log`）：

```
  1) e2e/voice-realtime-live-session-send.spec.ts:626:3 › voice realtime live session send › 375px: the same mode and gesture work with the bar inside the viewport
    Error: expect(received).toBeGreaterThanOrEqual(expected)
    Expected: >= 2
    Received:    1
    Call Log:
    - Timeout 25000ms exceeded while waiting on the predicate
      675 |     await expect
      676 |       .poll(() => page.locator(USER_ROW).filter({ hasText: PROPOSED_TEXT }).count(), { timeout: 25_000 })
    > 677 |       .toBeGreaterThanOrEqual(2);
      678 |   });
    …
      680 |   test('a malformed model call is reported on the bar, …
    at …voice-realtime-live-session-send.spec.ts:677:8
  1 failed
    e2e/voice-realtime-live-session-send.spec.ts:626:3 › … 375px: the same mode and gesture work with the bar inside the viewport
  2 did not run
  1 passed (41.7s)
```

（trace：`~/.cache/quay-e2e-tmp/quay-e2e-QGugtg/test-results/voice-realtime-live-sessio-dcb77-the-bar-inside-the-viewport/trace.zip`。与立案人 42875ms/实收 1 同形。）

### §2 AC2 —— 根因 = (b) harness 不诚实

**(1) 该腿自己那条连接的服务端日志**（pre-fix red 跑：`~/.cache/quay-e2e-tmp/quay-e2e-QGugtg/voice-realtime-log/53a57c02-d8ae-4c92-b5df-38b31a70439c.jsonl`，`"mode":"segmented"`，session `7a6aa9ae`）：

```
10:07:50.362 connection … "mode":"segmented"
10:07:50.504 segment seq=0 dur=860ms reason=gap frames=1
10:07:50.504 >> input_audio_buffer.commit
10:07:50.505 << function_call session_send {"message":"voice instruction delivered with no draft confirmation","waitSeconds":2.5}
10:07:50.536 teardown: the browser sent a close frame (audio frames received=1)
10:07:50.537 session_send not-delivered (socket closed)   {"outcome":"not-delivered","reason":"socket closed"}
```

读数：**切分与提交都真实发生了**（seq=0 有 `input_audio_buffer.commit`）⇒ 不是「浏览器分段器没切 / relay 没提交」；丢的是紧接着 `End` 时那条仍被 hold 的 relay（`not-delivered (socket closed)`）。全文**没有第二条 `segment seq=1`**，也**没有 `queued:`** ⇒ hold 从未被释放。

**(2) 同一棵树里 PC 腿的对照**（`…/quay-e2e-QGugtg/voice-realtime-log/04eff3c6-5394-4ae7-a575-1d4a499be14c.jsonl`）：PC 腿的 3 次 `speak()` 造出 4 个 segment，且有 `queued: opening a 2500 ms coalescing window (the frame precedes the sent)` 与 `session_send delivered in 15 ms` ⇒ 同一个代理、同一条路径，**只要有「后一句」提交，前一句被 hold 的 relay 就被释放并投递**。

**(3) 机制（读代码）**：`voice-realtime-ws-proxy.service.ts` 的 `sessionSend` 在该 segment 的 transcript 仍 `=== undefined` 时 `holdUntilTranscriptKnown(...)`（:1156-1157）；fake upstream 从不下发 transcript，唯一的释放点是 `onSegmentPhase` 里「**另一个** seq 的阶段事件」（:1190：`event.phase === 'settled' || event.seq !== heldDelivery.seq`）或 600ms grace。teardown 的顺序是 `closed = true`（:1305）→ `releaseHeldDelivery()`（此时 `closed` 为真 ⇒ `noteNotDelivered('socket closed')`，:1078-1082）→ `flushCoalesced()`（:1318）。该「浏览器已离开的连接不再投递 held relay」是**被测试钉住的产品策略**：`server/modules/voice-realtime/tests/voice-realtime-teardown-races.test.ts:226`（`':226: the held relay is not delivered into a gone connection'`）断言这一 drop，而该文件**不在本任务 Touches 内** ⇒ 这不是可改的产品缺陷。

**(4) 该腿的 `speak()` 造不出第二句**：375px 腿只有一次 `speak()`（修复前 :664），`buildSpeechBurst` 一次合成**一句** ⇒ 只有 seq=0，没有「后一句」可释放 hold。PC 腿靠 3 次 `speak()` 天然具备这个形状——这正是先例 `d70968d8`/`ec6b0145`（同族 done 任务 `gap-voice-realtime-composer-embedded-spec-red-under-default-segmented-mode`）修 PC 腿时所做的那一类「发声方式」修复，本任务只是把它补到没盖到的 375px 腿上。

结论：**(b) harness 不诚实**——不是产品缺陷；是 375px 腿自己的合成语音在 segmented 路径下造不出一次切分（第二句），于是第一句的 relay 在 `End` 时被按产品既有策略丢弃。（四项读数中 (1)(2)(3)(4) 同向，远超「至少两项」。）

### §3 AC3 —— 修复后双臂

| 臂 | rc | reporter 摘要 |
|---|---|---|
| `env -u VOICE_REALTIME_MODE`（run1） | **0** | `4 passed (19.3s)` |
| `env -u VOICE_REALTIME_MODE`（run2，重跑） | **0** | `4 passed (19.4s)` |
| `VOICE_REALTIME_MODE=continuous` | **0** | `4 passed (19.2s)` |

默认臂连跑两次都绿（修复后 375px 腿 2.7s / 2.9s，不再等 25s 超时）。

修复后 375px 腿**自己那条连接**的日志（`~/.cache/quay-e2e-tmp/quay-e2e-2hGpRD/voice-realtime-log/8be2028e-6e50-4702-83b8-554ec8548e94.jsonl`，`"mode":"segmented"`，session `d3d214f1`）：

```
10:06:45.790 segment seq=0 dur=860ms reason=gap frames=1
10:06:45.791 >> input_audio_buffer.commit
10:06:45.791 << function_call session_send {"message":"voice instruction delivered with no draft confirmation","waitSeconds":2.5}
10:06:46.201 segment seq=1 dur=1500ms reason=gap frames=1          ← 第二句真的切分并提交（+410ms）
10:06:46.202 >> input_audio_buffer.commit
10:06:46.202 queued: opening a 2500 ms coalescing window (the frame precedes the sent)   ← seq=1 释放了 seq=0 的 hold
10:06:46.639 teardown: the browser sent a close frame (audio frames received=2)
10:06:46.639 coalesced 1 relayed piece(s) into one message
10:06:46.644 session_send delivered in 5 ms                        ← 该腿自己那条连接把自己那一回合落成行
```

全文**没有** `not-delivered`。第二次红→绿复跑（`…/quay-e2e-EPu8ZP/…`）同形：两条各只 `speak()` 一次的连接 `segments=2` + `session_send delivered in 5 ms` / `4 ms`；PC 腿 `segments=4` + `delivered in 15 ms`；不开麦的那条 0 segment。continuous 臂该腿无 hold、同样 4 passed ⇒ 未把一个绿换成另一个红。

### §4 AC4 —— diff 只落在发声辅助与注释

`git diff --stat`：`e2e/voice-realtime-live-session-send.spec.ts | 55 +++++++++++++++++++++++-----`，`1 file changed, 45 insertions(+), 10 deletions(-)`（唯一文件）。三个 hunk：

- `@@ -57,10 +57,11 @@`：`SPEECH_SECONDS` 的 doc 注释（「一句」而非「一整个突发」）。
- `@@ -334,11 +335,43 @@`：新增 `SPEECH_BEAT_MS = 400` 与改写后的 `speak()`——一次 `speak()` 现在说**两句**（`say()` → `waitForTimeout(400)` → `say()` → `waitForTimeout(400)`），即 AC4 所说的「让合成语音在 segmented 路径下真实产生一次切分与提交」。两个节拍都是 socket 往返而非时钟刻度：第一个保证「后一句」到达时前一句已被 hold，第二个保证 `speak()` 返回前 seq=1 的提交已到达 relay 并释放 hold（`End` 不等在途帧）。
- `@@ -425,7 +458,9 @@`：`buildSpeechBurst` 注释补一句（提交 ≠ 投递，hold 需后一句释放）。

`:677` 的断言文本**不在任何 hunk 内**（`git diff -U0 | grep -n "toBeGreaterThanOrEqual"` 无输出）；无 skip/fixme；未改 `playwright.config`；未前置 continuous。产品文件（proxy/bridge/useVoiceRealtimeSession/voiceRealtimeProtocol）**零改动**。

### §5 AC5 —— (a) 不成立；等价反向 falsification

结论是 (b)，(a) 的前提不成立，故无「回滚产品修复」可给。作为等价的反向验证：把发声修复回滚回 pre-fix 文件（`git stash push -- e2e/voice-realtime-live-session-send.spec.ts`）后，**同一棵树、同一条命令**该腿复红：`RC=1`、42716ms、`at …voice-realtime-live-session-send.spec.ts:677:8`、`Received: 1`（全文见 §1）⇒ 该修复对这条绿是 load-bearing 的，不是「多了一个变量」。

### §6 合并 develop 后复验（本轮，2026-10-11，merge commit `426aa034`）

develop 本轮只带入 `docs/proposals/cloudcli-mcp-control-observability-2026-10.md` 与两个 `goals/*.md`，**无 server/src/e2e 代码变化**；合并后在同树重跑双臂（同一条命令、同一工作树）：

| 臂 | rc | reporter 摘要 |
|---|---|---|
| `env -u VOICE_REALTIME_MODE` | **0** | `4 passed (18.8s)`，375px 腿 `:661` **2.8s**（非 25s 超时） |
| `VOICE_REALTIME_MODE=continuous` | **0** | `4 passed (19.4s)` |

⇒ 修复在合并树上仍双臂全绿（AC3 的读数在合并后重放，非替换）。

本轮同时核：`git diff --name-only $(git merge-base develop HEAD) HEAD` = 仅 `e2e/voice-realtime-live-session-send.spec.ts`；上一轮 fan-in suite-red 的两个文件（`server/modules/providers/tests/claude-resident-addressable.test.ts`、`server/modules/voice-realtime/tests/voice-realtime-upstream-pool.test.ts`）与 develop **逐字节相同**（`git diff --quiet develop HEAD -- <file>` 皆空），单文件隔离跑分别 **`pass 1 / fail 0`** 与 **`pass 7 / fail 0`** ⇒ 系已知负载型 flake（real-claude-binary 家族 / `idleMs` 时钟边界），与本任务 delta 无关，未改动这两个文件。
