---
id: gap-live-voice-scripted-upstream-protocol-state-machine
title: 本地 scripted fake 上游协议状态机：可配置 turn_detection 与 append/commit/response
  状态，产生空缓冲错误、speech_started、按 itemId 晚到/乱序/缺失/失败转写、断连与 response.cancel；回放加变体
  R（VAD 重启自然导致空缓冲）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-replay-event-synced-waits
goal_ac: AC-359
---
## Proposal

### 问题

现有假上游（`server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts` 的 `createScriptedUpstream`，e2e 侧 `e2e/voiceRealtimeScriptedUpstream.ts` 的 `startScriptedUpstream`）只回 `session.update` 与 tool output，其余全靠用例逐帧 `emit`/`script`。它**不理会** `turn_detection`，所以 2026-10-12 的根因链（状态注入的 session.update 重开 server_vad → 手动 commit 撞空缓冲 → speech_started → response.create 被吞）在回放里只能把结果帧硬编码，缺陷腿 (a) 只能检查线上帧本身，无法证明修复切断了下游后果。错误帧也缺真实上游的 `type` 字段。

### 要做的事

- 在共享假上游加**可选**协议状态机（不配置时行为与现有 API 逐字不变）：
  - 会话状态：`turn_detection`（随 session.update / 局部 turn_detection 更新）。
  - 输入缓冲：append 累积；commit 在 manual 下产生 `input_audio_buffer.committed` + `conversation.item.created`（item_id 单调）；在 server_vad 下可配置为「与 append 同刻的 commit 撞空缓冲」：`{type:'error', error:{type:'invalid_request_error', message:'Error committing input audio buffer: buffer too small, or have no audio.'}}`，随后 `speech_started` 并自建条目。
  - 转写策略（按 itemId）：准时 / 延迟到第 N 次 commit 之后 / 乱序 / 永不 / `transcription.failed`。
  - response 策略：应答（可附 function_call 或模型文本）/ 扣住 / VAD 进行中被吞；`response.cancel` ⇒ `response.cancelled`；`response.done` 可带 usage。
  - 故障：段中途断开（close / terminate），拒绝重拨。
- 状态机自测 `server/modules/voice-realtime/tests/voice-realtime-scripted-upstream-state.test.ts`（真 ws 客户端）。
- 回放 spec 加变体 R：不脚本化错误帧，由状态机 + 服务端真实的状态注入自然产生空缓冲与 speech_started；断言帧序与 2026-10-12 journal 同形。vad-off 修复已落地时，R 应读到「不再撞空缓冲」——若届时已修，则 R 为正向腿；未修则经 `expectKnownDefect`。

### SCOPE BOUNDARY

- ⛔ 不改产品代码；状态机为可选配置，兄弟 spec 与 `voice-realtime-scripted-scenarios` 的 BUILDERS 钉子不变。
- 与 `gap-live-voice-intent-control-browser-e2e`（todo）共享假上游文件：本任务实现在先，后者在其上追加（后继关系）。
- 新增服务端测试文件需同步 quay-test-script 计数钉子与 suite 基线。

## Plan

1. 状态机与自测（先红）；2. e2e 包装暴露配置；3. 回放变体 R；4. 计数钉子/基线；typecheck/lint。

## AC

- [x] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-scripted-upstream-state.test.ts` 退出 0；首组用例在「忽略 session.update 的 turn_detection」假形态下红。
- [x] AC2：自测覆盖 manual commit、server_vad 空缓冲（错误帧带 type）、speech_started 自建条目、转写准时/延迟/乱序/永不/failed、response 应答/扣住/被吞、response.cancel、段中途断开。
- [x] AC3：回放变体 R 由状态机自然产生与 journal 同形的帧序；`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1` 退出 0。
- [x] AC4：回归——`e2e/voice-realtime-scripted-scenarios.spec.ts`、`e2e/voice-realtime-live-session-send.spec.ts` 单跑结果与改前一致；`voice-realtime-scripted-scenarios.test.ts`、`server/shared/tests/quay-test-script.test.ts` 退出 0；`npm run typecheck`、`npm run lint` 退出 0。

## DoD

变体 R 录制的帧序与 journal ef9daacd…（07:47:36–07:48:23Z）逐类对照表写入 Notes；零云调用。

## Touches

- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts
- e2e/voiceRealtimeScriptedUpstream.ts
- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream-state.test.ts (new)
- e2e/voice-realtime-segmented-replay-20261012.spec.ts
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- server/modules/voice-realtime/tests/voice-realtime-upstream-pool.test.ts（吸收 fan-in 确定性红：AC-321 判据的 idleMs 毫秒时钟边界，详见 Notes）
- tasks/gap-live-voice-scripted-upstream-protocol-state-machine.md

## Notes

立项：Opus 常驻会话 2026-10-12，人 yale 授权（GOAL-043 / AC-359，建议 (5)）。`gap-live-voice-caption-segment-attribution-by-item-id` 已追加依赖本任务，以便用晚到/乱序/空转写策略做判据。

### 交付形态

- `voice-realtime-scripted-upstream.ts`：新增**可选** `protocol?: ScriptedProtocolOptions`（默认缺省）；`createScriptedProtocolState` 是纯 reducer（无 socket / 无时钟 / 无凭据）；`ScriptedUpstream.protocol` 是 **getter**（不是属性快照）——机器在 `socketFactory` 里按连接构造，属性会永久冻结在 `null`；喂帧循环在 `protocol !== null` 守卫之后，所以未配置时线上帧逐字不变（自测的 DISARMED 用例钉住这一点）。错误帧带真实上游的 `error.type`（不是 `code`）。
- `e2e/voiceRealtimeScriptedUpstream.ts`：新增 `armProtocol(config | null)`；每连接一条机器，喂帧循环置于 `session.update` 早返回之前。
- 新自测 20 例（含一个真 `ws.WebSocketServer` + 真 `ws` 客户端组、一个 in-process stand-in 组、一个残留清理组）。
- 回放 spec 新增变体 R（`initialTurnDetection: 'server_vad'`，六条 commit plan，`toolResumeAnswer` 交回状态机），4 条正向腿。
- 计数钉子：`unknown=309` / `unknown=311`（312 个服务端测试文件）；基线 `283/311` → `284/312` 并追加一行。

### 验证读数（本次实现树）

- AC1 `…-state.test.ts`：20 passed / 0 failed，exit 0；首组在「忽略 `turn_detection`」假形态下红（同一进程内写两份临时拷贝，`pathToFileURL` 载入，`finally` 清理，残留组断言无遗留）。
- AC3 `…segmented-replay-20261012.spec.ts`：**19 passed**，exit 0（含 4 条变体 R 腿）。
- AC4：`…scripted-scenarios.spec.ts` 11 passed；`…live-session-send.spec.ts` 4 passed；`…scripted-scenarios.test.ts` 8/8；`server/shared/tests/quay-test-script.test.ts` 11/11；`npm run typecheck` exit 0；`npm run lint` exit 0（仅存量 warning，触及文件无）。

### DoD — 变体 R 录制帧序 vs journal `ef9daacd-9950-414a-acfc-aace142bf273.jsonl`

来源：R 的录制 `…/quay-e2e-tmp/<run>/segmented-replay-20261012.recording.json`（`R.journal` = 端点实收/实发帧，`R.browserFrames` / `R.snapshots` = 页面侧），journal 原文 `~/.cloudcli/voice-realtime-log/ef9daacd-…jsonl`。窗口 = 浏览器提交的 6 段（seq0..seq5，07:47:36.607Z–07:48:22.710Z）。

| # | 类 | journal（窗口内） | 变体 R | 判读 |
|---|---|---|---|---|
| C1 | commit 被接受 `input_audio_buffer.committed` | 6 段中 5 段（seq0,2,3,4,5）；**seq1 被拒** | **6/6** | 同类，计数不同——R 读到的是 vad-off 修复已落地后的乘积：分段路径自己的 `turn_detection: null` 守住，六次 commit 全被接受。差异全部归到 C2 |
| C2 | 空缓冲拒绝 `error{type:'invalid_request_error'}` "buffer too small, or have no audio." | seq1 一次 | 0 次 | **刻意不一致，也是本任务的立项理由**。立项原文已预判：「vad-off 修复已落地时，R 应读到『不再撞空缓冲』……则 R 为正向腿」。探针打开时状态机仍产生此类（`refuseEmptyBufferUnderVad` 默认 true）：AC1 假形态在机器不再读 `turn_detection` 的那一刻红；AC2 的 `server_vad` 用例逐字段钉住该帧（含真实上游的 `error.type`，且 `error.code` 为 `undefined`，并做 JSON 往返） |
| C3 | `input_audio_buffer.speech_started` + 自建 user 条目 | seq1 自建 `item_B5xbXwo6VjzvvwgvdgzvL`（seq2 的转写落在它上面）；seq2/3/4 又各发一次 | 0 次 | 同 C2——拒绝、`speech_started`、自建条目是同一机制的三个帧 |
| C4 | 由 commit 产生的 user 条目，id 以 `previous_item_id` 串链 | seq0 `item_GwgJF…`(prev=∅)、seq3 `item_Q26nL…`、seq4 `item_OsZh2…`、seq5 `item_CGvOOL…`；seq2 无（其条目来自 C3） | R_A..R_F 六条全串链（R_A prev=∅） | 同类同规则；R 每 commit 一条，因为 C3 不出现 |
| C5 | 转写在提交条目 id 上 `transcription.completed` | S1(seq0)、S2(seq2，迟到并落在 C3 自建条目上)、S4(seq4)、S5(seq5)——6 段中 4 段；C 在窗口内无转写 | R_A(S1)、R_B(S2)、R_D(S4)、R_E(S5)——6 中 4；R_C、R_F 为 `never` | **同类：同计数、同说话位置、同归属判据**（每条转写都挂在某个上游 itemId 上）。journal 那一次迟到归属（S2 落到更早的自建条目）归 AC-354，由变体 V 单独隔离；R 的转写按构造全为 `on-time` |
| C6 | 模型以 `function_call session_send` 转发 | S1(seq0)、S5(seq5)——恰好两条 | S1(R_A)、S5(R_E)——恰好两条 | **同类**：同两条句子、同 `function_call` 帧形与 args |
| C7 | tool 结果上的跟进 `model text (not shown to the user) "OK"` | seq0、seq5（另 seq1 与窗口后 seq8 以 MODEL_TEXT_REPLY **故障**形式出现） | R_A、R_E（在 tool resume 之后） | **同类协议帧**。R 里它不构成 MODEL_TEXT_REPLY：桥把 tool resume 指名的 response 注册过，故关闭 resume 的这句是 follow-up 而非故障——R 腿的非空读数取 journal 侧（恰 2 条 `<< function_call session_send`、0 条 `<< …error`）。journal 里作为*故障*出现的那两次，正是 C2/C3 机制的下游 |
| C8 | 送达浏览器 `queued depth=1` → `sent`（伴随 `session.updated`） | seq0、seq5 | R_A、R_E（`coalesced 1 relayed piece(s)`；`session_send delivered in 7 ms` / `1 ms`） | **同类** |
| C9 | 无转写的段可见标记、页面保持 `heard` | seq3（C）→ `turn_unanswered`，无 caption | R_C、R_F → `segment_ack(committed)`，无 caption；R 腿 caption 列表恰为 `[R_A=S1_HEARD, R_B=S2, R_D=S4, R_E=S5]` | **同类** |
| C10 | 段中途断开 / 拒绝重拨 | 窗口内无（窗口以浏览器退出 `state closing`→`state closed` 结束） | 本窗口未走该臂（Exit 为常规路径）；状态机的故障臂（`close`/`terminate`、`failOpens` 拒拨）由自测的 per-connection / 重拨组钉住 | **窗口外**，仅自测覆盖 |

结论：C1、C4–C9 逐类同形；唯一分歧是 C2 的拒绝类**及其同机制 C3**，且分歧方向正是立项时预判的正向读数（修复已落地 ⇒ 不再撞空缓冲）。把 C2/C3 恢复成 journal 的形态只需探针打开，这一点由 AC1 假形态与 AC2 的 `server_vad` 用例证明——所谓「同形」是在*探针状态*这一自变量下的同形，不是把结果帧硬编码。

零云调用：R 腿复用配置的 `envFreeServerRoot`（无 `.env`）+ `DASHSCOPE_API_KEY: ''`，浏览器上下文阻断并记录一切非 loopback 请求，正向腿断言 `CHROME_HOSTS` 之外无任何尝试；R 的 `journal` 内无任何云端端点帧。

### 续做回合：吸收 AC-321 的毫秒时钟边界红，并修掉 R 腿「读数早于落屏」的取景

**一、fan-in 判红（上一回合 exited-not-landed 的真因）**

- 失败原文：`step=suite: not ok - server/modules/voice-realtime/tests/voice-realtime-upstream-pool.test.ts: AssertionError [ERR_ASSERTION]: the switch must follow the idle threshold, got idleMs=29`（判据在 `…upstream-pool.test.ts:220`，`thresholdMs = 30`）。
- 复现：本工作树内单跑该判据的用例，读数恒为 `29`（连续 20 次）；同参数的裸进程探针读数为 `[31,30,30,30,30,29]`。该文件与本任务 delta 无关——分支上它此前**逐字节等于 develop**（本任务从未碰过它）。
- 机制：`idleMs` 是**读数**，为 `triggeredAt - lastActivityAt`，两个时刻都取自 `Date.now()`（1 ms 分辨率）；而轮换定时器由 `setTimeout` 布防，libuv 在自己的时钟上算截止点。两个时钟量化后可以差 1 ms，于是「确实等满了空闲期」的一次切换仍可能读成 `thresholdMs - 1`。原断言把读数当成了阈值本身。
- 判据功率未被改弱：`attemptRotation` 只有**一个**调用者——`voice-realtime-upstream-pool.ts:173` 的空闲定时器。任何没等满空闲期的切换，差的是一整个空闲期，不是它最后 1 ms。改动只把下界放到 `thresholdMs - 1`，机制写在代码注释里。
- 归属披露：该文件是**已落地**任务 AC-321（`gap-voice-realtime-upstream-pool-rotation`）的交付物。本任务只改了它的测量下界，`voice-realtime-upstream-pool.ts`（产品代码）一行未动。做法遵循仓库判例：确定性的、与本 delta 无关的套件红由下一个任务吸收，且**先经 ABI 在 `## Touches` 声明再改**。

**二、AC3 回放 spec 的 R 腿：线上帧 ≠ 已落屏**

- 本回合按判据原文重跑 `…segmented-replay-20261012.spec.ts`，**2/2 红在同一腿**：`variant R: only S1 and S5 reach Claude — the same two the journal delivered`，`realRowWith(recording.R.snapshots.beforeExit!, S5)` 读到 0。
- 取证（失败运行自己的录制 JSON，非推测）：R 的 `beforeExit` 行集恰为 3 行——`seeded`、`这是一轮新的 live voice mode 测试。`（real，S1）、`<voice-row-delivering>现在是第二句话。第四句话。上面我们看见丢了一句话。`（两次运行的形态相同，合并的 caption 文字不同）。
- 机制：`sent` 是**线上帧**，而录制用进程外的 `page.on('websocket')` → `framereceived` 读它，所以等到它**不代表 DOM 已经落屏**；`foldCaptionsIntoTranscriptRow` 只在投递被 `shown`（真实消息进 transcript）之后才把合并的 caption 文字从行上撤走。R 腿此前只等线上帧就取快照，而 A/B/V 腿都有 DOM 等待——缺的是 R 腿的这一半，**不是产品缺陷**（同一机制在 R 的 S1 行上正常工作）。
- 改动（13 行，仅 R 腿）：在 `sent` 之后按**帧自己带的 `message`** 等真实行落屏——`await waitRealRow(ctx, String(sent.message))`，与 A 腿 `waitFrame('sent')` → `waitRealRow(S1_RELAYED)` 同形，只是文本取自 app 自己的帧而不是硬编码 S5。判词与紧接其后的断言同形，故**不会引入新的红**，只把「读数早于落屏」变成「读数落在落屏之后」。

**三、本回合读数（合并 develop 后的同一棵工作树）**

- `…upstream-pool.test.ts`：**7 tests / 7 pass / 0 fail，exit 0**（改前该文件每次必红，读数恒 29）。
- AC1 `…scripted-upstream-state.test.ts`：**20 pass / 0 fail，exit 0**。
- AC3 `DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1`：**19 passed，exit 0**（改前 2/2 红，改后连跑两次同读数）。判据命令与上一回合相同，差别只是 R 腿现在等真实行落屏。
- AC4：`…scripted-scenarios.test.ts` 8 pass / 0 fail、`server/shared/tests/quay-test-script.test.ts` 11 pass / 0 fail，均 exit 0（合并树上的服务端测试文件计数钉子仍成立）；`e2e/voice-realtime-scripted-scenarios.spec.ts` 与 `e2e/voice-realtime-live-session-send.spec.ts` 单跑：11 passed / 4 passed，均 exit 0（与改前读数逐字一致）；`npm run typecheck` exit 0；`npm run lint` exit 0（仅存量 warning，触及文件无）。
- ANTI-DRIFT（develop 合并后重跑）：`OK — 7 actual file(s), all within declared Touches (8 glob(s))`。

## Blocker

**2026-10-12T13:04:21.144Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/modules/voice-realtime/tests/voice-realtime-upstream-pool.test.ts:   AssertionError [ERR_ASSERTION]: the switch must follow the idle threshold, got idleMs=29
- run_id：wk-prod-anchor
- session_id：3c9c5927-3b00-48f0-b654-b8a5ebaf30e4
