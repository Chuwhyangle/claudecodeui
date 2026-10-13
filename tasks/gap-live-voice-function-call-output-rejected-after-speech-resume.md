---
id: gap-live-voice-function-call-output-rejected-after-speech-resume
title: function_call_output 被上游拒（Unknown function call id → Cannot create
  response after rejected
  function_call_output）：调用后、上游确认前用户再开口即必现——归因竞争/取消时序并设计安全回执状态机
status: done
labels:
  - gap
  - P0
parent: null
children: []
extra:
  acceptance: test -f
    server/modules/voice-realtime/tests/voice-realtime-function-call-output-receipt.test.ts
    && npx tsx --tsconfig server/tsconfig.json --test
    server/modules/voice-realtime/tests/voice-realtime-function-call-output-receipt.test.ts
---
## Proposal

**现象（2026-10-13 真实 live voice，journal `b5d01c21`）**：每次出错都是一对上游错误：

```
<< ERROR invalid_request_error "Unknown function call id: call_…" param=call_id
<< ERROR invalid_request_error "Cannot create response after rejected function_call_output; submit valid input or retry for the current input" param=response
```

本连接共 8 次。**相关性（12/12 吻合，测试主段；之后 1 次同样吻合）**：模型发出 `function_call` 后，若在上游回 `conversation.item.created(type=function_call_output)` **之前**出现 `input_audio_buffer.speech_started`（用户再开口）⇒ 必被拒（6/6）；没开口 ⇒ 必成功（6/6）。上游确认 output 的耗时 0.3–3 s 不等。

**影响**：消息本身已由 proxy 投递（投递与回执独立），但①浏览器每次收到两条 `UPSTREAM_ERROR (recoverable)`；②上游会话缺该 call 的 output 与随后的 response，模型上下文出现空洞；③与 `turn_detected` 取消（同场 2 次 `MALFORMED_FUNCTION_CALL`）属同一类「用户续说打断模型回合」的时序面。

**相关代码**：`voice-realtime-bridge.service.ts:1343` `sendFunctionCallOutput` 直接 `transport.send`；`voice-realtime-dashscope-transport.ts:537` 包成 `conversation.item.create` 并合成 `response.create`；transport 文件头说明了重连时重放未确认 output 的现有机制。既有先例：`gap-voice-three-vad-filtered-pcm-real-upstream-replay` 记录「`Unknown function call id` 仍零星出现，未归因」；`gap-voice-server-vad-three-arm-replay-on-third-test-corpus` 记录 dry-run 执行器触发过一次。

人 yale 2026-10-14 批准（复盘 P0-3）：调查竞争/取消时序，设计安全回执状态机，提供复现与真实验证。

## Plan

1. **归因先于修**：写真实上游复现探针（复用 `experiments/voice-realtime-large-append-probe/probe.mts` 骨架），用 capture `b5d01c21….wav` 的真实语句：臂 R（复现）在收到 `function_call` 后延迟发送 output，并在其间推入下一段语音；臂 C（对照）不推入。记录 `speech_started`、`response.done status`、`conversation.item.created`、错误的逐事件时间线。判定：拒收是由「新用户条目已创建」、「所属 response 被 cancel」、还是「合成 `response.create` 撞上进行中的 response」触发——三者择一或写「不足以判断」。
2. 根据归因设计 transport 层**回执状态机**：每个 call 状态 `pending → output-sent → acked | rejected | superseded`；在已知会被拒的状态下（如所属 response 已 cancelled / 新用户条目已开）**不发** output 或不合成 `response.create`；收到 `Unknown function call id` 时将该 call 记为 `rejected` 并**不向浏览器冒泡为错误**（journal 照记）；随后的 `Cannot create response…` 同理吸收。重连重放逻辑与新状态机一致。
3. 不改变投递语义：`session_send` 投递与否只由 proxy 决定，与回执状态无关（加断言）。
4. 脚本测试：新文件 `voice-realtime-function-call-output-receipt.test.ts`，在 scripted fake 上游上复刻真实拒收规则（以第 1 步归因为准）。

## AC

- [x] AC1 复现探针在真实上游上至少 1 次复现 `Unknown function call id`（臂 R）且对照臂 C 0 次；时间线、花费（上限 ¥0.3）、所用音频区间与 capture sha256 前缀 `0f2bd51fbbb28c9f` 写入 `docs/operations/voice-realtime-function-call-output-race.md`；归因结论或「不足以判断」明写。
- [x] AC2 scripted fake 上游按归因规则拒收 ⇒ 状态机下：浏览器 0 条 `UPSTREAM_ERROR` 由该原因产生，journal 有对应 call 的 `rejected|superseded` 记录；取假形态：去掉状态机 ⇒ 浏览器收到该错误、用例红。
- [x] AC3 正常路径（无续说）output 照常发送并被 ack，合成 `response.create` 次数不变；既有 `voice-realtime-dashscope-transport.test.ts`、`voice-realtime-connection-resilience.test.ts` 单文件运行退出 0。
- [x] AC4 投递独立性：被 `rejected` 的 call 对应的 `session_send` 投递记录不变（delivered 仍 delivered）。
- [x] AC5 修复后用同一探针臂 R 在真实上游重跑：拒收导致的浏览器错误为 0（或拒收本身为 0），读数写入同一文档；未重启 :3001（pid 前后相同）、未改生产 env。

## DoD

拒收的时序成因在真实上游上被复现并归因；transport 回执状态机让「用户续说」不再产生浏览器错误、不再在上游会话里留下被拒 output，且不改变任何投递结果；修复后真实复现臂读数为证。

## Touches

- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/tests/voice-realtime-function-call-output-receipt.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts
- experiments/voice-realtime-function-call-output-race/probe.mts (new)
- docs/operations/voice-realtime-function-call-output-race.md (new)
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-live-voice-function-call-output-rejected-after-speech-resume.md

## Notes

**查重（2026-10-14）**：全库检索 `Unknown function call id` 只命中两条 done 的 VAD 实验任务（各自在 Notes 里记为「未归因」），无专门任务。本任务是首个归因与修复任务。

**证据**：journal `~/.cloudcli/voice-realtime-log/b5d01c21-3f53-4228-a28e-d18b7cb967f7.jsonl`（ERROR 行 56:54.413、57:09.557、57:22.026、57:29.557、58:33.810、58:39.869、59:24.990、00:34.524）。

**读数列（AC1/AC5，详见 `docs/operations/voice-realtime-function-call-output-race.md`）**

- 修复前（`/tmp/voice-race-prefix`，`--arm both --hold 6000 --cap 0.30`）：臂 R `sess_BzjzVt46VW4Zswg5WvZRQ` ¥0.004506 —— 拒绝 1 组（`Unknown function call id` + 配对帧）、浏览器 `UPSTREAM_ERROR` 2 条；臂 C `sess_XjSJJ8XBIpP8EDXYyFT9v` ¥0.004182 —— 0/0、output 被 ack。合计 ¥0.008688。
- 修复前（`/tmp/voice-race-prefix2`，`--arm all`）：R=1 / C=0 / A=0（臂 A 另出现 1 条 `Response request cancelled by new input`）。合计 ¥0.017805。
- 归因结论：**证实**。触发条件＝「新用户回合落在回执窗口内」；`owningResponseCancelled`、`synthesizedCreateCollision` 两个候选在真实上游上均被排除（臂 R 与臂 C 的 ownership `response.done` 全为 `status=completed`）。
- 修复后（`/tmp/voice-race-postfix`，`--phase post`）：臂 R `sess_ZpMQjCeVOzZ1t7DKc1Hak` ¥0.004443 —— `output发出=0 回执=0`、错误帧 0、journal 记 `function_call_output receipt call_id=call_6ff31e5d9b054928972fed4b state=superseded turn_seq=1 now=9`；臂 C `sess_RMcFfSDgYDKGKYx87Tl3V` ¥0.004218 —— 发出并被 ack、无回执行；臂 A `sess_VSMDy4hcbPLgzdLvB9ZNE` ¥0.004306 —— 1 条 `Response request cancelled by new input`（**范围外**，不同因，刻意不吸收，见文档）。合计 ¥0.012967（上限 ¥0.30 未触顶）。
- 三次运行 `:3001` pid 全部 766174 → 766174（未重启、未改生产 env）；音频区间＝捕获 slice #3（33607–38371 ms，samples 1075424–1227872），capture sha256 `0f2bd51fbbb28c9f60bc381684fa7b4f38aa845c07f2d79b4f17ed8b08696e33`。

**两半缺一不可的证据**：journal `b5d01c21` 机械计数 17 次 output 发出 / 9 次被接受 / 8 次被拒；8 次被拒**全部**是「先发 output、其后用户才开口」（逐条配对实测发出→其后首句 `speech_started` 为 1 ms–2.97 s），因此「发送前守卫」覆盖 0 次，「吸收」覆盖全部 8 次；而探针臂 R（Plan 的次序）只有发送前守卫能覆盖。两半都保留。

**范围外（已知，本次不改）**：臂 A 的 `Response request cancelled by new input`（修复前后各 1 条）。它发生在 output **已被接受之后**、为它合成的 `response.create` 撞上用户新输入时，没有形成被拒空洞；吸收它需要 transport 向 bridge 回报并释放 `followUpResponsesExpected` 记账，改动面在 bridge，属另一条判据，已在文档中记为后续。

**共享读数文件**：新增一个 server 测试文件同时触动两个计数型读数，已随本分支一起改并声明在 Touches —— `server/shared/tests/quay-test-script.test.ts` 的 `unknown=` 由 develop 的 320/322 抬到 321/323；`scripts/suite-duration-baseline.tsv` 补本文件一行（2733 ms，单文件实测），否则覆盖率从 291/323=90.09% 掉到 291/324=89.81% 而让 AC7 变红。

### 第二轮（2026-10-14）残留红的三分：一条是本任务的真回归（已修），两条不是

第一轮 fan-in 在 suite 阶段 HARD RED，红集三条。本轮逐条查证后只改了一条，另两条不是本任务引入。

**① `voice-realtime-scripted-scenarios.test.ts` 的 B6 —— 本任务引入的真回归，已修。** 本分支的发送前守卫（新用户回合一开始就不再接受更早 call 的 output）让 B6 里 `call_vad_0` 的 tool output 被记为 `superseded`：插桩实测该 output 是在 `userTurnSeq=4` 发出、而回执戳的是 `turnSeq=2`（第 1 句 `speech_started` + `item.created` ⇒ 2，第 2 句 ⇒ 4）。成因是**测试桩的送达次序**而不是产品行为：`speakTurn` 的 `upload()` 把一整个回合的帧**同步**泵进去，于是执行器（异步）的结果还没回到 wire，第 2 句的 `speech_started` 就已经排在了它前面——真实 socket 产生不了这个次序（执行器结果与入站帧由事件循环定序，不由测试的循环定序）。修法：在第 1 句与第 2 句之间加该文件自己已经在用的屏障 `await waitFor(() => upstreamReceipts(scenario.upstream, 'call_vad_0').length === 1, 4_000)`（同 :924、:990、:1089），把「第一次派发被应答过一次」这个断言的前提显式化，断言本身不变（回执仍必须恰好一次，其后的重放去重断言原样保留）。A/B 已证：把本分支的 transport 换成 develop 的 ⇒ 28/28 全绿；换回本分支的 ⇒ B6 红；加屏障后 ⇒ 28/28 绿（本轮实测 `tests 28 / pass 28 / fail 0`）。

**② `voice-realtime-uplink-vad.test.ts` —— 环境红，develop 上同样红。** 5 个子用例全因 `optional dependency onnxruntime-node could not be loaded: Cannot find package 'onnxruntime-node'` 而 `'unavailable' !== 'available'`；该包在本工作树符号链接到的共享 `node_modules` 里不存在，与分支 delta 无关（本会话单跑复现同上）。它同时出现在基线日志里（`...~baseline-1791910547743-543403.log:10`），即 develop 上同一断言同一文本。

**③ `src/shared/tests/voiceErrorClassification.test.ts` —— 既有 sibling falsify 残留竞争，非本任务。** 红文本是 `the run left files behind: /src/shared/tests/__criterion-falsify-voiceEditLabels.ts:35456`，属已有的「残留守卫撞上 sibling 的 falsify 副本」形态；本会话单跑该文件 **6/6 全绿**（`Test Files 1 passed`）。本分支自己的 falsify 副本写在 `server/modules/voice-realtime/`（`MODULE_DIR`）且带 pid 后缀、在 `finally` 里删除，不会落到 `src/shared/tests/`。

### 基线 A/B 的 `changed-assertion` 是日志版式产物，不是内容差异（给下一个处置者）

`changed=` 只落在 uplink-vad 上，读数是 `baselineText="Expected values to be strictly equal: | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:"`、`taskText=""`。逐行比对两侧日志后确认：**两侧的失败断言逐字相同**，差别只在 marker 条目的文本，而 marker 文本来自「`__PERFILE__ … passed=false` 行之后 8 行内第一条 `AssertionError…: <text>`」这个 lookahead：

- 基线日志（每文件一次 `scripts/test.sh --root <baseline> <file>`）：`__PERFILE__` 在第 7 行、`not ok -` 在第 10 行 ⇒ 落在 8 行窗口内 ⇒ marker 文本 `Expected values to be strictly equal:`。
- 全量 suite 日志：该文件的 `__PERFILE__` 在第 334 行，而所有 `not ok -` 行被攒到日志末尾（552–554）⇒ 窗口内什么都没有 ⇒ marker 文本 `""`。

内容是同一个 pre-existing 红，`""` ∉ 基线的两个文本 ⇒ 判 `changed` ⇒ HARD RED。同一轮、同一份 suite 日志里，兄弟任务 `gap-live-voice-interrupt-missing-intent-drops-stop`（与本文件路径毫无关系）拿到的是**同一条** `changed-assertion`、且 `added=[]`（见 `.quay/worker-outcome.jsonl` 两条记录的 `baselineEquivalence`），可作旁证：这条判词对「两边都红的既有红」是结构性的，与本任务 delta 无关。要真正放开，需要改的是判据侧（`__PERFILE__` 行的 marker 取文本方式，或全量路径把 `not ok -` 行随 `__PERFILE__` 一起打印），那在仓库外的 quay dist 与 `scripts/test.sh` 里，本任务触碰不到，故如实记录而不在本轮绕过。


### 第三轮（2026-10-14）merge develop 后的读数重算，以及前两轮那条环境红已消解

本轮只做合并与复核，未改实现（分支原有 12 个提交原样保留）。

- `git merge develop` 带入 21 个 develop 提交，其中 `gap-optional-dep-absent-from-main-checkout-reds-the-whole-suite` 把共享 `node_modules` 的 `onnxruntime-node` 补回。前两轮连续判 HARD RED 的 `voice-realtime-uplink-vad.test.ts` 本轮单文件直跑 **10 pass / 0 fail**：那条红是环境缺件，不是本分支缺陷，与上一轮记录一致。
- 该合并同时带入已落地的兄弟任务 `gap-live-voice-continuous-empty-guard-misrefuses-multi-item-relay` 的新测试文件。于是本分支相对合并基线**新增两个 server 测试文件**（本任务的 receipt 与兄弟的 span）。两个共享计数型读数按并集重算：`server/shared/tests/quay-test-script.test.ts` 的 AC2 `unknown` 由 321 改到 **322**、valid 由 323 改到 **324**（`find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort` = 325 行）；`scripts/suite-duration-baseline.tsv` 保留两行，覆盖率 **293/325 = 90.15%**（≥ 90% 地板）。
- 本轮 scoped 复核（单文件直跑）：receipt 5 pass、scripted-scenarios 28 pass、dashscope-transport 14 pass、connection-resilience 15 pass、quay-test-script 1 pass；anti-drift Touches 7 文件全部在声明内。

## Needs-Human

**执行 2026-10-13T17:29:35.687Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：LOOP DEADLOCK: task gap-live-voice-function-call-output-rejected-after-speech-resume has been blocked by the SAME pre-existing red set for 3 consecutive fan-in rounds (signature unchanged across rounds). Blocked red points: server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts. Other tasks blocked by the identical red set: gap-live-voice-interrupt-missing-intent-drops-stop — each of these tasks fixes a red point OUTSIDE the blocked set, so they are mutually landing gates (none can produce a green full suite while the others' reds remain). Suggested resolution: land ANY ONE of them first (each one's own fix is outside the blocked set, so the red set does not grow); the others' blocked sets then shrink by that red point and they land in turn. If a landing still makes it worse, a human must decide the order. ⛔ The gates were NOT relaxed: every new/changed red point still hard-fails this task (baseline-equivalence exemption never covers a red the task introduced). — 停止自动重派（电路断路器：同一既存红签名连续 3 轮未变）。⛔ 判据未放宽：本次新增 / 断言文本变化的红点仍然硬红（既存红等价豁免只覆盖「不变差」的方向）。
- 失败步/判词：step=suite: not ok - server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts:   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: [baseline A/B: HARD RED (changed-assertion) — the task's red set is NOT a subset of the develop baseline red set: added=- changed=server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts]
- run_id：wk-prod-anchor
- session_id：1c7beda4-efcf-4912-8979-424d8d15e5c7
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-live-voice-function-call-output-rejected-after-speech-resume~wk-prod-anchor~1791912350246-a43250.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-live-voice-function-call-output-rejected-after-speech-resume-wk-prod-anchor.log
