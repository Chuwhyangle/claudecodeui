---
id: gap-live-voice-prompt-drop-stop-word-trigger
title: Live Voice 指令删除停止词触发清单，中断改为语义判断「停止当前执行」，不扩语义（阶段 0c，F4）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-340
---
## Proposal

### 现状（2026-10-12 复核）

`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:112` `VOICE_REALTIME_INSTRUCTIONS` 第 119–121 行写着：`The ONE exception is a stop: if the user tells you to stop — "stop", "停", "停下", "别做了" — call the session_interrupt function …`。这是 SPEC C-2 明令禁止的「关键词表 / 条件式映射」：浏览器侧兜底已由 `bbca2901`/`d03702bb` 移除，prompt 侧仍在（§18.1 F-5）。全仓唯一出现处（`grep -rn '别做了' server src` 仅此一处）。

真实后果：2026-10-12 用户说「你应当能够更主动地去取消已经在执行的这些动作，以更快地推进后面的操作」——不含清单中的字面量，模型只回 OK 并按 `session_send` 转发（journal `99df08d8` 01:26:39–01:26:53）。

### 要做的事（只删规则、不扩语义）

把该句改写为语义描述：当你判断用户想**停止当前执行**时调用 `session_interrupt`，并在 `intent` 里说明你为什么这样判断；没有关键词可依；其余一律 `session_send`。⛔ 本任务**不**加入「修正方向即中断」的措辞——那要等 `gap-live-voice-interrupt-after-revision-enqueued`（AC-342）的「先入队后中断」落地后才安全（否则中断可能让旧队列先单独成轮）。若 `intent` 字段尚未落地（AC-339 未合入），措辞中不得要求填写不存在的字段——按合入时 develop 上的实际 schema 写。

<!-- dedup-ref --> 机制去重：open 任务对停止词 / `VOICE_REALTIME_INSTRUCTIONS` 0 命中。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 改写指令；同步检查 `REALTIME_INTERRUPT_TOOL` 描述无触发措辞。
2. 新判据 `voice-realtime-instructions-no-stop-words.test.ts`：扫描指令与三个语音工具描述，断言无带引号的停止词字面量（至少 `"stop"`、`"停"`、`"停下"`、`"别做了"`、`"cancel"`、`"取消"`）、无 `if the user (says|tells you to)` 条件式；断言仍出现 `session_interrupt` 与「判断 / judge」语义。
3. 更新钉住旧文本的断言（`voice-realtime-bridge.test.ts:169-170` 的 `/stop/i`、`voice-realtime-streaming-stages.test.ts:315-316`、`voice-realtime-log.test.ts` 的 `instructionsChars` 等）——只改到新文本，不削弱意图。
4. 新测试文件同步 quay-test-script 钉子与基线；typecheck / lint。

## AC

- [x] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-instructions-no-stop-words.test.ts` 退出 0；文件内对「把旧词表放回」的假形态断言其会红。
- [x] AC2：指令仍要求停止判断时调用 `session_interrupt`、其余一律 `session_send`、从不文本作答（断言三点各一条）。
- [x] AC3：A-3b 不回归：既有 `voice-realtime-interrupt.test.ts`、`voice-realtime-scripted-scenarios.test.ts`、`voice-realtime-bridge.test.ts`、`voice-realtime-streaming-stages.test.ts`、`voice-realtime-log.test.ts`、`voice-realtime-log-wiring.test.ts` 退出 0。
- [x] AC4：`npm run typecheck`、`npm run lint`、`server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

真 transport + scripted fake 上游下读出实际下发的 `session.update` instructions 文本（摘录写入 `## Notes`），确认无停止词清单；零云调用。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts（仅 VOICE_REALTIME_INSTRUCTIONS）
- server/modules/voice-realtime/voice-realtime-tools.ts（仅 session_interrupt 描述，若含触发措辞）
- server/modules/voice-realtime/tests/voice-realtime-instructions-no-stop-words.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts（指令文本断言）
- server/modules/voice-realtime/tests/voice-realtime-streaming-stages.test.ts（指令文本断言）
- server/modules/voice-realtime/tests/voice-realtime-log.test.ts（仅当 instructionsChars 钉子受影响）
- server/modules/voice-realtime/tests/voice-realtime-log-wiring.test.ts（仅当前缀钉子受影响）
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.real-transport.test.ts（仅当指令文本钉子受影响）
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-live-voice-prompt-drop-stop-word-trigger.md

## Notes

立项：Opus 常驻架构会话，2026-10-12，人 yale 授权（GOAL-041 / AC-340）。

### 落了什么（提交 `057fd629`）

`VOICE_REALTIME_INSTRUCTIONS` 的停止例外改为语义判断句，并显式写出「没有词表可依」；`intent` 字段已在 develop 上落地（`REALTIME_INTERRUPT_TOOL` 带 `intent`/`heard`），故措辞要求填 `intent` 并给出理由（SPEC §6.2）。未加任何「修正方向即中断」措辞。`REALTIME_INTERRUPT_TOOL` 描述 `Stop the run now; intent = why, heard = words.` 本就无触发措辞 ⇒ `voice-realtime-tools.ts` 未改动（Touches 中该条为条件项，条件未触发）。

### DoD 证据（真 transport + scripted fake 上游，零云调用）

同一对生产接线函数（`createDashscopeTransport` + `handleVoiceRealtimeConnection`，即 `server/index.ts` 所接线者）跑在 `createScriptedUpstream` 上，`apiKey: ''` 且 transport 用 stand-in 自己的 `socketFactory`。实测：dialled URL = `ws://scripted.invalid/api-ws-v1/realtime?model=qwen3.8-omni-flash-realtime`（stand-in，非云端），dialled headers = `{}`（无凭据送出）。

从 `upstream.clientFrames` 读出的 `session.update` 帧，其 `session.instructions`（1003 字符，与导出常量逐字节相同）实际文本：

> You are a voice relay for one Claude Code session. You never answer, comment or reason yourself, and you never reply in text. EVERYTHING the user says — instructions, questions, remarks, feedback, even a single word — must be passed on by calling the `session_send` function with `{ message }`, where message is what the user said, kept in their own words (fix obvious speech-recognition slips only). Always call the function; never produce a text reply. The ONE exception is a stop: judge for yourself whether the user wants the work that is running right now to stop, reading what they MEANT rather than looking for any particular word — there is no list of words to match, and what they said may not look like a stop at all. When you judge that they do want it stopped, call the `session_interrupt` function instead of `session_send`, and put in `intent` the reason you read it that way. Then reply with the single word OK and say nothing else. The session is fixed by the connection; never name one.

同一帧 advertise 的三个工具：`["session_send","session_interrupt","session_status"]`。判读：线上指令带引号停止词 0 个、`if the user (says|tells you to)` 条件式 0 处 ⇒ 无停止词清单。

### 判据与回归读数

- AC1：新判据 5/5 绿。假形态**端到端**证伪过——把旧句（含 `"stop"`、`"停"`、`"停下"`、`"别做了"`）写回常量后判据红，并逐条点名四个词 + `conditional trigger: if the user tells you to`；恢复后复绿。假形态还逐词扫 6 个词（`stop`/`停`/`停下`/`别做了`/`cancel`/`取消`）与源码元素写法，并有反空转负控（只「提到」停止的句子不得红）。
- AC3：六文件（interrupt / scripted-scenarios / bridge / streaming-stages / log / log-wiring）全绿；指令消费面扩测 status-injection / status-tool / replay / diagnose / empty-transcript-guard / segmented-protocol / real-transport / audio-capture-wiring / spend-guard + 新判据 = 94/94 绿。
- AC4：`npm run typecheck` exit 0、`npm run lint` exit 0（仅既有 warning）、`quay-test-script.test.ts` 11/11 绿（其 `known/unknown` 采集计数钉子按 +1 同步为 `unknown=300` / `unknown=302`；基线与 90% 覆盖行按 275/303 同步）。
- `voice-realtime-bridge.test.ts` 原先钉 `/停/`（旧中文停止词）的断言改成钉「判断」语义，意图未削弱；`streaming-stages` / `log` / `log-wiring` / `real-transport` 的钉子在本次改动下本就仍绿，未动。
