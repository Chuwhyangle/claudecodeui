---
id: gap-voice-realtime-live-session-send-375px-red-under-default-segmented-mode
title: 默认 segmented 配置下 e2e/voice-realtime-live-session-send 的 375px
  腿确定性红：该腿自己那条连接的原声回合没落成第二行（:677 的 >=2 只到 1），continuous 下同树全绿
status: todo
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

- [ ] AC1 复现并贴原文：在**未设** `VOICE_REALTIME_MODE` 的臂里跑该 spec（`scripts/with-memory-cap.sh` 包），贴 rc、墙钟、失败断言原文（文件名:行）与 reporter 摘要；同树再跑 `VOICE_REALTIME_MODE=continuous` 臂，贴 `N passed` 对照。
- [ ] AC2 根因定位到 (a)/(b) 之一，并给出**读数级**证据（不是推断）：服务端 `[voice-realtime <session8>]` 行（该腿那次连接的 relay / segment-commit 是否发生）、浏览器分段器的切分事件、上游收到的提交帧 / `function_call_output` 计数、盘上该会话的消息行数——四者中至少两项指向同一结论。
- [ ] AC3 修复后**未设 mode** 的臂里该 spec 全绿（贴 rc / passed 原文），且 `VOICE_REALTIME_MODE=continuous` 臂**仍**全绿（不许把一个绿换成另一个红）。
- [ ] AC4 ⛔ 不许以「把判据或配置前置 continuous」「删/放宽 `:677` 的 ≥2 断言」「给该腿开 skip / fixme」换绿。若结论是 (b)，只能改**发声方式**（让合成语音在 segmented 路径下真实产生一次切分与提交），该断言文本一字不改，diff 只落在发声辅助与必要注释。
- [ ] AC5 若结论是 (a)（产品缺陷），必须同时给出反向 falsification：把修复回滚 ⇒ 该腿复红（贴读数）。

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
