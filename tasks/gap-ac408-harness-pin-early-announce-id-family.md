---
id: gap-ac408-harness-pin-early-announce-id-family
title: AC-408 e2e 判据仍钉已退役的 announce id 族（/^announce-\d+$/）：a2c2e8139 把 announce
  前移到 speech_stopped 并改用 announce-early-N 后整条判据红；把判据对齐当前生产者并清掉串行模式藏起的后续红
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-408
---
## Proposal

**现象（2026-10-21T07:12Z 直接复跑，不是过期台账）**

`node experiments/voice-e2e-harness/run.mjs --sample 402fad85` → **exit 1**。Playwright 汇总：`3 passed`、`1 failed`、`5 did not run`——该 spec 是 `mode: 'serial'`，首个红会让同文件后续 5 条用例根本不执行（serial spec 藏后续红，排查时不能把「1 failed」当作全部）。

失败腿逐字：

```
the announce closing turn reached the browser as narrator speech
Expected pattern: /^announce-\d+$/
Received string:  "announce-early-0"
    at e2e/voice-output-e2e-harness.spec.ts:1083:35
```

**根因：判据钉的是已经退役的生产者 id 族，不是下行坏了**

`a2c2e8139`（2026-10-21 11:59，`feat(voice-realtime): speak the announce at speech_stopped`）把 announce 从「模型 follow-up 的 closing turn」前移到端点 `speech_stopped`：utteranceId 新族是 `announce-early-${seq}`，并在 3 s 窗口内抑制原 closing-turn announce。该提交只更新了 `server/modules/voice-realtime/tests/voice-realtime-announce-narrator.test.ts`（新断言 `/^announce-early-\d+$/`），没有更新 e2e 判据；`e2e/voice-output-e2e-harness.spec.ts:1083` 的 `/^announce-\d+$/` 仍是 2026-10-19 的旧形状（`git log -L` 显示该行由 `575237e08` 引入）。

同日实跑 dump（`/tmp/voice-e2e-plan-lyKaQV/run.json`）证明机制本身是好的，红的是判据形状：

- `narrator.speaks` = `announce-early-0 "好的"`、`run-end-summary-0 "本轮任务已结束，全部检查通过。"`、`announce-early-1 "收到"`、`announce-early-2 "明白"`、`announce-early-3 "在办"`——**每个 closed turn 一条 announce + run-end 总结**，rotation 与 `ANNOUNCE_PHRASES` 一致；
- 每条 `tts_audio` 的 `seqs` = `[0,1,2]`（连续、从 0 开始），`doneBytes` = `48044`（stand-in WAV 精确字节数），`errorCode` = `null`；
- `announce-early-0` 与 `run-end-summary-0` 都有 `ackedAtMs > doneAtMs`（页面播放完成后回 `narrator_done`）；`announce-early-1/2` 没有 ack，是下一轮用户语音清空了队列——**这是 AC-406 的双工意图，不是缺陷**，判据不得要求每条 announce 都被 ack；
- `narrator.requests` 含全部四句 announce + summary，证明文本真的进了 TTS；`detector.speechStopped = 4 / expected 4`。

<!-- dedup-ref --> 相关但不是重复：`voice-output-tts-downlink-wiring`（done，`goal_ac: AC-408`）是 2026-10-19 接通下行、让本判据首次转绿的任务；本次红是其后继行为变更（`a2c2e8139`）没有同步判据形状，属于「done 的修复没守住」而非同一机制的在途任务。机制去重已查：无 `todo`/`ready`/`needs-human` 任务命中 `announce-early`、`speech_stopped`、`early announce` 或 `voice-output-e2e-harness`。粒度检查 `task-granularity-advice.js`：`peers: []`、`mentions: []`，可独立立案。

**为什么上一版修复没守住**

AC-408 是一条「边界形状」判据：它不仅要求 announce 经 TTS 出声，还用精确 utteranceId 族钉死「这一帧是 announce 生产者发的」。`a2c2e8139` 改变了 announce 的触发时刻和命名，却只改了单元判据；e2e 判据是另一份手写 pin，于是行为升级、判据滞后。教训：**announce 的触发点或 id 族一变，必须同时重读 `e2e/voice-output-e2e-harness.spec.ts` 的 announce 断言**，只跑 `npm test` 的单元测试发现不了。

**要做的（不退回产品行为）**

1. 把 `e2e/voice-output-e2e-harness.spec.ts` 的 announce 断言改成当前生产者：utteranceId 匹配 `/^announce-early-\d+$/`；文本取自 `ANNOUNCE_PHRASES` 的轮转；保留既有意图断言（≤15 字、非 `ok`、非 summary 文本）。
2. 把「找第一条 text === `ANNOUNCE_TEXT` 的 announce」扩展成覆盖整轮：断言 early announce 的条数 = `detector.speechStopped`（本样本 4），每条文本 ∈ `ANNOUNCE_PHRASES`，每条都有 `tts_audio`/`tts_done` 且 `seq` 从 0 连续、bytes 等于 stand-in WAV；ack 只要求至少一条 announce 与 summary 有（双工清队是意图）。
3. 修掉串行模式下 `1 failed → 5 did not run` 的盲区：整文件跑到底，把第 5–9 条也可能存在的红逐条查清（不得用放宽断言的方式凑绿）。特别注意 `the browser played each narration and its narrator_done advanced the queue` 与 timing 腿现在面对的是 4 条 announce + 1 条 summary，而不是两条。
4. 让判据文档说真话：spec 头注释与 `experiments/voice-e2e-harness/run.mjs` 中 `ANNOUNCE_TEXT` 的注释仍写着 announce 由 delivered `session_send` 的 follow-up 触发；改成「`speech_stopped` 触发 early announce、closing turn 被抑制，模型 follow-up 文本不上线」。

**不要做的**

- 不回退 `a2c2e8139` 的 early announce：提前确认是用户可感知的意图内改进。
- 不改 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 让产品迁就旧判据。
- 不把服务端队列读数或 `narrator_speak` 文本帧当作浏览器侧证据；AC 要求帧真的过了 socket。
- 不要求每条 announce 都被 ack（用户打断会清队列）。

## AC

- [ ] **AC1 判据命令（台账逐字命令）整文件转绿**：`node experiments/voice-e2e-harness/run.mjs --sample 402fad85` 退出码 0，日志含 `[voice-e2e] RESULT: PASS (exit 0)`，且 Playwright 汇总为 `9 passed`（不得出现 `did not run`）。取假形态：把 announce 断言改回 `/^announce-\d+$/` 时该命令必红在 `Received string: "announce-early-0"`。
- [ ] **AC2 判据钉的是当前生产者，而不是旧族或空断言**：`grep -qF '/^announce-early-\d+$/' e2e/voice-output-e2e-harness.spec.ts` 退出 0，且 `! grep -qF '/^announce-\d+$/' e2e/voice-output-e2e-harness.spec.ts` 退出 0。取假形态：文件仍只含旧族字面量时第一条必红；把 id 断言整体删成宽松断言时第一条也必红。
- [ ] **AC3 dump 直接读到 AC 的 (b)(c)(d)**：先跑 `node experiments/voice-e2e-harness/run.mjs --sample 402fad85 --dump /tmp/ac408-dump.json`（退出码 0），再用 `node -e` 读该 dump 并断言：(i) 存在 `utteranceId` 匹配 `/^announce-early-\d+$/` 且 `text === "好的"` 的 announce；(ii) 存在 `utteranceId` 匹配 `/^run-end-summary-\d+$/` 的 summary；(iii) 两者 `errorCode === null`、`seqs` 等于 `[0,1,2]`、`doneBytes === 48044`、`ackedAtMs > doneAtMs`；且 (iv) 全部 early announce 条数 = `detector.speechStopped` = `PLAN.vad.expectedUtterances`，每条 `errorCode === null` 且 `seqs` 从 0 连续。总退出码 0。取假形态：TTS 下行不接时 `narrator.tts` 没有 audio 帧/`doneBytes`，必红。
- [ ] **AC4 仓库类型检查不回归**：`npm run typecheck` 退出码 0。

## DoD

**真实对象被真正操作过**：判据命令在本仓库真实 app server + 真实浏览器（scripted relay / scripted TTS stand-in）上跑完整个 `e2e/voice-output-e2e-harness.spec.ts`，9 条用例全绿、没有 `did not run`；`narrator_speak`/`tts_audio`/`tts_done`/`narrator_done` 都是页面 socket 上的真实帧，而不是服务端队列或注入数组的读数。

**判据不真空**：announce 断言钉住当前生产者 `announce-early-N`，并保留 AC 的三条实质要求——(b) `tts_audio` seq 从 0 连续且 `tts_done.bytes` 等于合成字节数、(c) 页面播放后回 `narrator_done` 且队列推进（至少一条 announce 的 ack 早于 summary 的 `narrator_speak`）、(d) run-end 总结同样经 TTS 出声。失败签名与断言同源：删掉新 pin 时红在 `announce-early-0` 的旧族比对，而不是别的副作用。

**行为不回退**：`a2c2e8139` 的 early announce（`speech_stopped` 即说、closing turn 在 3 s 内被抑制、模型 follow-up 文本不上线）原样保留；产品代码不改来迁就判据。

**文档与判据一致**：spec 头注释与 `run.mjs` 的 `ANNOUNCE_TEXT` 注释描述的是当前 `speech_stopped` 触发路径，不再是旧的「delivered `session_send` follow-up 触发」。

## Touches

- e2e/voice-output-e2e-harness.spec.ts
- experiments/voice-e2e-harness/run.mjs
- tasks/gap-ac408-harness-pin-early-announce-id-family.md
