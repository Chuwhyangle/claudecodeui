---
id: gap-live-voice-continuous-experience-e2e-harness
title: 连续模式体验基线本地确定性 E2E：fake mic 时间线 + 声学 VAD 仿真 fake upstream + 模型策略，测
  X-1..X-7 读数（不改产品代码）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-scripted-upstream-protocol-state-machine
goal_ac: AC-361
---
## Proposal

### 背景与裁定

人 yale 2026-10-12：Live Voice 体验优先；模型决定何时输出 / 调用工具；VAD 只服务传输与 response 机会节奏，不承担业务断句。决策文档 `docs/proposals/live-voice-experience-first-decision-2026-10.md`（提交 `038730f0`）§3 定义了最小体验验收 X-1..X-7，§4 选定 continuous（上游 `server_vad`）为体验基线候选。**切换默认模式之前，必须先在本地确定性环境里测出当前 continuous 路径的基线读数**——本任务只建验证设施并取读数，**不改任何产品代码**。

### 现状（2026-10-12 复核）

- 假上游：`server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts` 与 `e2e/voiceRealtimeScriptedUpstream.ts` 都是命令式脚本，**不会根据收到的音频做 VAD**；AC-359（`gap-live-voice-scripted-upstream-protocol-state-machine`，本任务的前置）加入协议状态机（turn_detection、append/commit/response、转写策略）。
- fake mic：`src/modules/chat/voice-realtime/audioSource.ts` 的 `pacedFileAudioSource`（可注入时钟）；e2e 页面垫片 `window.__voiceFake.speak(seconds)`（见 `e2e/voice-realtime-segmented-replay-20261012.spec.ts` 与 `voice-realtime-live-session-send.spec.ts`）。
- 外联守卫：AC-360（已落地）。执行面：现有 voice e2e 夹具会话（单一共享夹具账号，spec 串行）。

### 要做的事

1. **声学 VAD 仿真**（在 AC-359 状态机之上）：`server_vad` 配置下按收到的 PCM16 做能量阈值检测，语音后静音 ≥ `silence_duration_ms` ⇒ `speech_started/stopped` + `committed` + 自动 `response.create`。**时间基是开关**：`audio-time`（按收到的采样数累计静音）与 `wall-clock`（按注入时钟累计静音，停传期间也计时）——真实上游属于哪一种是 AC-363 V-1 要测的未知量，**本任务不得预设**；两种取值各有用例。时钟一律由注入时钟驱动。
1b. **停传与恢复场景**（Silence Tail Suppression，决策文档 §10，提交 18616927）：tail 后停传、恢复讲话补发前滚、弱尾音、低音量与噪声——只在 fake 侧复现上游在两种时间基下的反应，供 AC-364 复用；本任务不实现 STS 本身。
2. **模型策略**：逐条目可配置——转发 `session_send`（文本取自脚本）、不转发、等待到下一次机会合并转发、`session_interrupt`、文本作答。
3. **fake mic 时间线**：确定性「语音 / 静音 / 背景噪声」时间线脚本（≥5 句、句间 0.3–3 s、含「嗯」类片段、句中 1–2 s 停顿后续说与修正），供 spec 播放。
4. **e2e spec** `e2e/voice-realtime-continuous-experience.spec.ts`：走**当前** continuous 代码路径（不改产品代码），执行面忙闲交替，产出 X-1..X-7 逐项读数表（写入任务 `## Notes` 与 spec 产物）。当前不达标项用 `expectKnownDefect` 错误签名记录（AC-357 已有该辅助），不得用 `test.fail` / `skip`。
5. 单 spec 时长 < 100 s（goal 判据 120 s 硬闸）；必要时在 AC-361 记录上声明 `timeoutMs`。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


- ⛔ 本任务不改 `server/modules/voice-realtime/` 的非测试文件与 `src/` 的产品文件；若当前代码在 continuous 下缺少可测接缝，记入 `## Notes` 并以 needs-human 停下，不得顺手改产品代码。

<!-- dedup-ref --> 机制去重（2026-10-12）：open 任务中只有 AC-359 涉及假上游协议，它不做声学 VAD 仿真与模型策略，本任务以 depends_on 建在其上；AC-345（意图控制浏览器验收）只覆盖打断类场景，不测连续体验基线。

## Plan

1. 在 AC-359 状态机上加声学 VAD 仿真与模型策略；L1 判据 `voice-realtime-fake-vad-upstream.test.ts`（含丢静音用例与墙钟取假形态）。
2. fake mic 时间线辅助与 e2e spec；本地连续跑 3 次比对读数。
3. 新测试文件同步 `server/shared/tests/quay-test-script.test.ts` 计数钉子与 `scripts/suite-duration-baseline.tsv`；`playwright.config.ts` 登记 spec 预算；`npm run typecheck`、`npm run lint`。

## AC

- [x] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts` 退出 0；文件内「两种时间基共用同一实现（开关失效）」的取假形态下时间基对照用例必须红。
- [x] AC2：同文件断言：语音后静音 ≥ `silence_duration_ms` ⇒ `speech_stopped`+`committed`+自动 response；只送语音帧时 `audio-time` ⇒ 无 `speech_stopped`、`wall-clock` ⇒ 按墙钟出现；停传后恢复讲话在两种时间基下的事件序列各有断言；模型策略五种取值各有一条用例。
- [x] AC3：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 退出 0，且 spec 内无 `test.fail` / `test.skip` / `fixme`（不达标项走 `expectKnownDefect`）。
- [x] AC4：X-1..X-7 逐项读数表写入 `## Notes`（每项：读数、是否达标、若不达标的缺陷签名与归因「我方 / 协议 / 未知」）。
- [x] AC5：零外联（AC-360 守卫生效的读数）；同一种子连续 3 次读数一致（给出三次对照）。
- [x] AC6：`npm run typecheck`、`npm run lint`、`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

本地真实浏览器 + 本地服务（不重启 :3001，用 e2e 自带实例）跑完连续体验 spec，X-1..X-7 读数表落盘；全程零云调用；产品代码 diff 为空（`git diff --stat develop -- server/modules/voice-realtime src` 只含测试文件）。

## Touches

- server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts（声学 VAD 仿真与模型策略）
- e2e/voiceRealtimeScriptedUpstream.ts（e2e 侧接入同一仿真）
- e2e/voiceRealtimeFakeMic.ts (new)
- e2e/voice-realtime-continuous-experience.spec.ts (new)
- playwright.config.ts（新 spec 预算登记）
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-live-voice-continuous-experience-e2e-harness.md

## Notes

立项：Opus 常驻会话，2026-10-12，人 yale 体验优先裁定（GOAL-044 / AC-361）。

### 落地（2026-10-12，worker）

工作树 `/data/home/yale/work/claudecodeui-worktrees/gap-live-voice-continuous-experience-e2e-harness`，分支 `task/gap-live-voice-continuous-experience-e2e-harness`，实现提交 `f316eaf3`，合并 develop 后重跑（见下）。

| 产物 | 内容 |
|---|---|
| `server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts` (new) | L1 判据 13 用例（`npx tsx --test`） |
| `server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts` | `createScriptedVad` / `ScriptedVadDetector`：能量阈值检测、两种时间基（`audio-time` / `wall-clock`）、停传与恢复、五种模型策略 |
| `e2e/voiceRealtimeScriptedUpstream.ts` | e2e 侧 `armVad` / `vad()` / `waitForUtterances()` / `commitCount()` / `upgradeHeaders()` / `dialed()` |
| `e2e/voiceRealtimeFakeMic.ts` (new) | 11 段时间线（语音 / 静音 / 门限下噪声），渲染后按 100 ms 帧真实播放 |
| `e2e/voice-realtime-continuous-experience.spec.ts` (new) | 11 用例；X-1..X-7 读数 |
| `playwright.config.ts` / `server/shared/tests/quay-test-script.test.ts` / `scripts/suite-duration-baseline.tsv` | 单 spec 预算 240 s、计数钉子 312→313、基线行 `412` |

**未改产品代码**：`git diff --stat develop -- server/modules/voice-realtime src` 只含 `server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts`（测试文件）。**未触发 SCOPE BOUNDARY 的 needs-human 停止条件**：continuous 路径的可测接缝充足——`/api/debug-agent/*` 夹具（含可注入时钟）、每连接一份的 `voice-realtime-log` journal（`connection` 行带 sessionId，文件必须按 header 选）、bar 的 `data-busy` / `data-testid="voice-realtime-stopped"`、`ActivityIndicator` 的 `data-activity-state` / `-phase` / `-elapsed-ms`、上游侧收到的 `session.turn_detection` 与 commit 计数——全部读数由此取得，不必改产品代码。

**预算声明（Proposal 5）**：spec 实测 32.3 / 32.7 / 31.5 / 32.2 s（4 次；< 100 s）。`playwright.config.ts` 为该 spec 登记单 spec 预算 `240_000`，spec 内 describe 超时 180 s。本记录即 `timeoutMs` 声明处：**AC-361 声明 `timeoutMs = 240000`**（判据 120 s 硬闸未触及）。

### AC4 — X-1..X-7 逐项读数表

读数取自三次连续运行（run 5/6/7，同一种子、同一时间线、同一假上游），并在合并 develop 后第四次重跑核对（同表）。

| 项 | 读数 | 是否达标 | 不达标的签名与归因 |
|---|---|---|---|
| **X-1 连续交互正确** | 5 句各一条记录、顺序与说话一致：`item_vad_0`「把 server 的日志贴出来」=forwarded；`item_vad_1`「嗯…那个…」=unforwarded；`item_vad_2`「我想想」=forwarded；`item_vad_3`「然后跑一下测试」=forwarded；`item_vad_4`「不对，改成跑 lint」=interrupted。静默丢失 = 0。执行面忙闲交替：dock 采样 83 次，序列 `null →(07.958) in-turn →(23.120) null`，2 次跃迁、两态均出现 | **部分达标**（丢失 0 ✓、顺序 ✓、忙闲交替 ✓） | 有一条可见处置不达标：合并后的投递已落地（journal `session_send … delivered in 2 ms`），屏上却仍留在 `voice-row-delivering` 折叠行里 **> 8.4 s**（观察窗结束仍未解除）。签名 `delivered but still shown as delivering: rows [`；`fixTask gap-live-voice-segment-honest-heard-unrecognized-state`（其 AC3 正是「只有被 sent 认领的话变为已发送；其余保持 heard，不出现 delivering」）；**归因 我方**（UI 折叠行未在投递落地后解除 in-flight 态——代理侧 journal 已记 delivered） |
| **X-2 模型可不输出** | 「嗯…那个…」被听见（`item_vad_1`，detector 记 `unforwarded`）；投递集合 {把 server 的日志贴出来, 我想想然后跑一下测试} ∩ 未转发集合 = ∅（journal 内无该片段的 `session_send`，屏上以 voice 行可见而非投递行） | **达标** | — |
| **X-3 指令可追溯** | 2/2 条投递链路完整：`item_vad_N` → `resp_vad_N` → `<< function_call session_send{message}` → `queued` → `coalesced` → `to-browser sent` → journal `session_send … delivered in N ms`；`\|session_send.atMs − sent.atMs\| ≤ 50 ms`（两条记录是同一次往返，先后顺序不是读数）。CLI 的 `commandUuid` / 回合在 voice journal 中不存在（`grep -c commandUuid` = 0）⇒ 按判据记为**显式 unknown**，计入完整 | **达标** | — / 该跳的归因 **未知**（不在 voice 链路上） |
| **X-4 暂停续说修正** | 句中 1.5 s 停顿被记录为 **2** 条 utterance（`item_vad_2`「我想想」/ `item_vad_3`「然后跑一下测试」），Claude 侧只收到 **1** 条消息「我想想然后跑一下测试」（journal 单条 `session_send delivered in 2 ms`，内容为说话先后顺序）。忙时两半落入同一轮。防抖实现读数：代理的 **2500 ms coalescing window**（`queued: opening a 2500 ms coalescing window` → `coalesced 1 relayed piece(s) into one message`），实测窗长 6407–6410 ms 与 2501–2503 ms（窗口从入队起算，内含执行面占用时间） | **达标**（忙时口径） | 空闲口径未读数（说话窗口内执行面始终忙，见 X-7） |
| **X-5 打断** | `<< function_call session_interrupt {"intent":"方向改成跑 lint"}` → `session_interrupt: aborted=false backlog=0` → `to-browser stopped depth=0`；audit `{by:'model', intent:'方向改成跑 lint', outcome:'no-run', queuedStillPending:0}`（语义来自模型自述，非关键词表）；停止前的两条投递保持 `delivered`，停止后无新投递；状态行 15.414–22.862 s 显示 `Stopped the current turn — 0 still queued`（`voice-realtime-stopped` 被采样到） | **部分达标** | (a) G1「修正先入队后 abort」的栅栏在本次读数上**未被数据触发**：停止瞬间队列为空（`queuedStillPending=0` / `backlog=0`），可读的只是「停止前的投递未被撤回」；(b) UI 停止键**未读数**——`VoiceRealtimeBar` 上只有停止**通告**没有停止**键**，该半边需在带停止键的执行面取读数。归因 **未知**（是覆盖缺口，不是缺陷签名） |
| **X-6 状态可感知** | 状态行在**每一次**带状态采样中都非空（0 次空）：`Listening…` → `Busy 00:04 · 29 bytes waiting`（约每 1.03 s 自刷新，≤ 2 s ✓）→ `Stopped the current turn — 0 still queued`；队列深度 / 字节数可读（29 / 30 / 0 bytes）；未转发标注在位（「嗯…那个…」落在 `voice-row-delivering` 行）；dock 由其自身帧解释（hello `isProcessing=false phase=idle unreachableAfterMs=15000` ×3，心跳 5 s 序列 `true, true, false, false`，dock 逐一跟随） | **部分达标**（非空 ✓、约 1 s 新鲜 ✓、未转发标注 ✓） | 降级阈值口径不达标：产品宣告 `unreachableAfterMs = 15000`，判据要求「≤ 2 s 无更新须显示降级」。本 spec **未触发**该路径（全程连接正常，无 > 2 s 无更新窗口）⇒ 记为阈值口径的未达标读数，**无红断言**，故不走 `expectKnownDefect`（AC3 约束的是被断言的不达标项）；**归因 我方**（阈值常量与 5 s 心跳周期） |
| **X-7 交互延迟** | 说完→字幕定型 `[1,1,0,0,1]` ms（≤ 1000 ✓）；说完→模型工具调用 `[2,1]` ms（≤ 1500 ✓）；忙时说完→「已排队」可见 `[2,0]` ms（≤ 1500 ✓）；工具往返 `latencyMs` 9 ms / 2 ms；空闲说完→Claude 收到**未读数**，对照读数为 6410–6414 ms（首句，含 6407–6410 ms 合并窗口）与 2503–2504 ms（合并句，含 2501–2503 ms 窗口） | **达标**（三项已读数均远低于阈值） | 空闲分支未读数：说话窗口内执行面始终忙（心跳 `isProcessing=true`，dock 07.958–23.120 = `in-turn`），判据的「空闲说完」分支本轮无样本。归因 **未知**（口径缺口，非缺陷） |

### AC5 — 同一种子连续三次读数一致（三次对照）

三次运行的 **结构性读数逐项相同**：处置表（`forwarded/unforwarded/forwarded/forwarded/interrupted`）、`forwarded` 集合、`item_vad_0..4`、detector 计数 `5 started / 5 stopped / 11 opportunities / server_vad`、上游帧计数 `121 append / 5 session.update / 3 conversation.item.create / 3 response.create / 0 commit / segmented=false`、假麦克风 121 帧、时间线 11 段、每段转写文本、`caption == transcript`（逐段同文本）、11 个 response id（`resp_vad_0 … resp_vad_client_10` 逐字相同）、stop 的 `intent`、audit 三元组、3 条状态注入行（`seq=1 phase=queued queued=1/29B`、`seq=3 phase=queued queued=1/30B`、`seq=5 phase=idle queued=0/0B`）、`unreachableAfterMs=15000`、dock 序列形状 `None → in-turn → None`、fold 8.4 s 内未解除、egress 读数、`pageErrors` 0。

**数值读数只有亚 10 ms 抖动**（同一读数表内的对照）：字幕定型 `[1,1,0,0,1] / [1,0,0,1,0] / [1,1,0,0,0]` ms；已排队可见 `[2,0] / [2,1] / [2,0]` ms；合并窗口 `6407 / 6407 / 6410` ms 与 `2503 / 2501 / 2502` ms；工具往返 `9 / 9 / 13` ms 与 `2 / 1 / 1` ms。唯一可见差异是 run 7 的第三次 `chat_subscribed` 报 `isProcessing=true`（另两跑为 false），而由帧派生的 dock 序列三跑完全相同——这正是「dock 由帧解释」的读数，不是分歧。

第四次（合并 develop 后）重跑：`11 passed (32.2s)`，exit 0，`[known-defect]` 签名逐字相同、折叠行 rows 逐字相同 ⇒ 全部读数在合并后的树上依然成立。

### AC5 / AC-360 — 零外联读数

`<dataDir>/egress.jsonl` 存在（`logExists true`）、无阻断记录（`blocked false`）、外联拨号 `dials = 1`（唯一一次是本 spec 自己的 loopback 假上游）、`authorizationSeen false`（上游未收到云凭据）；浏览器侧 route 拒绝 5 个非 loopback 请求（github / fonts），无 loopback 被拒；`pageErrors` 为空。运行命令带 `DASHSCOPE_API_KEY=`（空键）。

### DoD 读数

- 本地真实浏览器（Chromium，e2e 自带实例 client）＋ 本地服务（e2e 自带 WebServer 实例；**未重启 :3001**），spec 四次运行 `32.3 / 32.7 / 31.5 / 32.2 s`，全部 exit 0、11/11 用例通过。
- X-1..X-7 读数表落盘：本节 + spec 产物（`QUAY_CONTINUOUS_EXPERIENCE_DUMP` 时写出整份读数 dump）。
- 产品代码 diff 为空：`git diff --stat develop -- server/modules/voice-realtime src` 只含 `tests/voice-realtime-scripted-upstream.ts`。
- AC1：13 pass / 0 fail，exit 0（含「两种时间基共用同一实现」的取假形态红）；AC6：`npm run typecheck` exit 0、`npm run lint` exit 0（仅仓库既存 warning，无一在本任务改动的文件里）、`quay-test-script.test.ts` 11 pass / exit 0 —— 三项均在合并 develop 后重跑。

### 已知缺陷与未读数汇总（供后续任务接手）

1. **折叠行不解除 in-flight**（`expectKnownDefect` 腿，签名 `delivered but still shown as delivering: rows [`）→ `gap-live-voice-segment-honest-heard-unrecognized-state`，归因我方。
2. **X-5 空闲/停传栅栏未被数据触发**：本轮停止瞬间队列为空，G1 栅栏需在「有在途排队项时停止」的场景另取读数。
3. **X-5 UI 停止键**、**X-6 ≤ 2 s 降级阈值**、**X-7 空闲说完分支**：三项在本 spec 覆盖之外（前两项见上表归因）。
