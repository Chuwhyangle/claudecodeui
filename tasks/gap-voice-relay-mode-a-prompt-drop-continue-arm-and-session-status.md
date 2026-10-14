---
id: gap-voice-relay-mode-a-prompt-drop-continue-arm-and-session-status
title: Live Voice 转发改 (a) 模式：prompt 删「不调用」臂、打断必带原话、撤下 session_status（真实回放验证）
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

**人的裁定（2026-10-14，第二次实测复盘后）**：Realtime 模型定位为 (a)「整理我的输入并发给 Claude Code」，不是 (b)「理解意图并操纵 Claude Code 的主体」；页面应像人与 Claude Code 的两方会话。裁定细项：Q1 抢占仍由模型判断；Q2 整理力度不变；**Q3 撤下 `session_status`**；**Q4 收尾的 "OK"（工具结果后的 `response.create`）保留**；暂不做机械兜底；「谨慎地改进」。**明确不在本任务内**：首句专名/日期识别、术语表、过度纠正（如「气泡→切换」）、重复片段、打断说明（方括号）的发送时机、follow-up 计数、噪音错误帧。

**问题（journal `e650117b`，2026-10-14 11:40）**：4 段话丢失，全在 Claude 忙时。成因之一在 prompt：`VOICE_REALTIME_INSTRUCTIONS`（`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 约 159 行）前半句要求「每句都转发」，后半段却给了 CONTINUE 臂——Claude 在跑且「没有新东西」时可以不调任何函数、回一句 OK——模型据此回「No response requested.」6 次，整段话丢失；另一处是 `session_interrupt` 只带 `intent` 时人的原话不进 CLI（「我希望打断他」）。

**真实上游回放实验（`experiments/voice-realtime-relay-mode-replay/`，实现未改）**：最近 3 份真实 capture（`b5d01c21` / `d4c9bfc4` / `e650117b`）按实时节奏喂给真实 `qwen3.8-omni-flash-realtime`，经出货 transport + bridge，执行器只记录、返回值与出货逐字同形，忙闲按原 journal 的 `status injected` 时间线注入。3 臂 × 2 轮，约 ¥2.75，并按「意图消息单元」（40 个）做了逐条语义评判：

| | B 出货 | A (a 模式) | AN (A 去收尾 OK) |
|---|---|---|---|
| 对人话回文本、没转发 | 31 | **0** | 6 |
| 丢句或实质截断 | ≈22 | **0** | 4 |
| 该打断的确实打断 | 6/10 | **8/10** | 5/10 |
| 打断带原话 | 5/6 | **6/6** | 5/5 |

**修法（只动三处出货表面 + 随之失效的钉子）**：
1. **prompt**：`VOICE_REALTIME_INSTRUCTIONS` 换成下方「定稿 prompt」。它是对出货文本的**最小改动**：删掉「You will be asked, again and again … STOP it — call `session_interrupt`.」整段（CONTINUE / ADD / CHANGE / STOP 四选一）；EVERYTHING 句补「acknowledgements, complaints」并加「There is no case in which you call no function…」；打断句改为 `message` 必带人的原话。D-6 / SPEC C-2 的钉子（`voice-realtime-instructions-no-stop-words.test.ts`：无引号停用词、判断式表述、`call the \`session_interrupt\` function instead of \`session_send\`` 等逐字子串）**全部仍成立、不得放松**——定稿已按这些钉子写好。它与实验 A 臂文本措辞不同，所以 AC7 要用定稿重新回放验证。
2. **工具**：`VOICE_REALTIME_TOOLS`（`voice-realtime-tools.ts` 约 448 行）去掉 `REALTIME_SESSION_STATUS_TOOL`，只剩 `session_send`、`session_interrupt`；`REALTIME_INTERRUPT_TOOL.description` 改为 `` Stop the run, then deliver `message` (the user's words); `intent` = why. ``（实验 A 臂原文；输入 schema 不变，`message` 仍为可选——谨慎起见不改校验）。`REALTIME_SESSION_STATUS_TOOL` 描述符、`VOICE_ONLY_TOOLS`、live executor 里的 `session_status` 实现、`server/index.ts` 的 `latestExecStatus` 接线**保留不删**（不再广告给模型即可；清理另议）。
3. **状态行里指向 `session_status` 的两句**：`VOICE_REALTIME_STATUS_STALENESS_RULE`（`voice-realtime-settings.ts` 约 73 行）改为 `该行的 ageMs 是这条状态的年龄；ageMs > 4000 的状态已过期，不得当作现状复述。`（实验原文）；`render` 的截断标记（`voice-realtime-ws-proxy.service.ts` 约 635 行）改为 `` ` (+${marker.more} more)` ``。
4. 因裁定而失效的钉子随之改写：「恰好三个工具」「session_status 经真实 transport 应答」「标记含 ask session_status」等断言改为断言新事实（两个工具、`session_status` 不在广告集、标记不再指向它）；**不得删除**与本裁定无关的断言。
5. 回放 harness 收进仓库：把 `/data/home/yale/work/claudecodeui/experiments/voice-realtime-relay-mode-replay/` 下的 `run.mts`、`digest.py`、`README.md` 原样复制进任务工作树同路径（主检出里是未跟踪文件）。`README.md` 末尾追加一节记录 AC7 的定稿回放读数。

**已知取舍**：打断现在总带 `message`，走「先入队后中止」（G1，`sessionInterrupt` 约 3203 行）；若恰逢另一条投递在飞（single-flight `sending`），会按现有规则返回 `revision-not-enqueued` 而不中止。此前只带 intent 的打断不受这条影响。窗口为毫秒级，本任务不改，执行时在「验证读数」里注明是否在回放中观察到。

### 定稿 prompt（`VOICE_REALTIME_INSTRUCTIONS` 的数组元素，逐字）

```
'You are a voice relay for one Claude Code session.',
'You never answer, comment or reason yourself, and you never reply in text.',
'EVERYTHING the user says — instructions, questions, remarks, feedback, acknowledgements,',
'complaints, even a single word — must be passed on by calling the `session_send` function',
'with `{ message }`, where message is what the user said, kept in their own words (fix obvious',
'speech-recognition slips only). Always call the function; never produce a text reply.',
'There is no case in which you call no function: deciding that something does not need to be',
'passed on is never your call.',
'The ONE exception is a stop, or a request to correct the direction of what is running:',
'judge for yourself whether the user wants the work that is running right now to stop —',
'or wants it taken a different way — reading what they MEANT rather than looking for any',
'particular word; there is no list of words to match, and what they said may not look',
'like a stop at all. Read the WHOLE wish, not the shape of the sentence: a wish for the',
'running work to stop, or to be taken a different way, is very often wrapped inside new',
'words the person is adding, and those added words do NOT turn it back into an addition —',
'they are the correction to carry, not a reason to queue behind the run. When you judge',
'that they do want it stopped or redirected, call the `session_interrupt` function instead of `session_send`,',
'with their words in `message` — kept exactly as you would for `session_send`, and always',
'present, even when all they asked for was the stop — and the reason you read it that way',
'in `intent`; their words reach the session right after the stop. Then reply with the single',
'word OK and say nothing else.',
'The mistake this exception exists to prevent is relaying such a wish as an ordinary',
'`session_send`, so it sits in the queue and the running work carries on as if the person',
'had said nothing — that answer is wrong whenever the person was asking for the running',
'work to stop or to go somewhere else, however ordinary their words sounded.',
'The session is fixed by the connection; never name one.',
```

（数组仍以 `.join(' ')` 拼接。常量上方的长注释同步改写为本裁定与回放读数；**注释里不要写出被删掉的那段原文**，AC3 的缺失断言会数到注释。）

<!-- dedup-ref -->
合并候选检查：none found（`task-granularity-advice` 对三份源文件 peers=[]、mentions=[]）。相关已落地背景：`gap-live-voice-prompt-drop-stop-word-trigger`（D-6 钉子的来源，本任务保持其断言）。

## AC

- [ ] AC1 定稿 prompt 已上线：`grep -c "There is no case in which you call no function" server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 输出 1，且 `grep -c "present, even when all they asked for was the stop" server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 输出 1。
- [ ] AC2 广告给模型的工具恰为两个：`npx tsx --tsconfig server/tsconfig.json -e "import('./server/modules/voice-realtime/index.ts').then((m) => { console.log(m.VOICE_REALTIME_TOOLS.map((t) => t.name).join(',')); process.exit(0); })"` 的输出行为 `session_send,session_interrupt`；且 `grep -c "Stop the run, then deliver \`message\` (the user's words); \`intent\` = why." server/modules/voice-realtime/voice-realtime-tools.ts` 输出 1。
- [ ] AC3 CONTINUE 臂与指向 `session_status` 的提示已从出货表面移除：`grep -c "call no function at all" server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 输出 0；`grep -c "ask session_status" server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 输出 0；`grep -c "需要现状时调用 session_status" server/modules/voice-realtime/voice-realtime-settings.ts` 输出 0。
- [ ] AC4 D-6 钉子保持不放松：`git diff develop -- server/modules/voice-realtime/tests/voice-realtime-instructions-no-stop-words.test.ts | grep -cE "^-.*(STOP_WORDS|no list of words to match|instead of \`session_send\`|never produce a text reply|you never reply in text|judge for yourself)"` 输出 0，且该文件单跑 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-instructions-no-stop-words.test.ts` 退出 0。
- [ ] AC5 回归面逐文件单跑、各自退出 0（每次一个文件，`npx tsx --tsconfig server/tsconfig.json --test <file>`，均在 `server/modules/voice-realtime/tests/` 下）：`voice-realtime-status-tool.test.ts`、`voice-realtime-status-injection.test.ts`、`voice-realtime-bridge.test.ts`、`voice-realtime-scripted-scenarios.test.ts`、`voice-realtime-ws-proxy.real-transport.test.ts`、`voice-realtime-interrupt.test.ts`、`voice-realtime-interrupt-aftermath.test.ts`、`voice-realtime-live-executor.test.ts`、`voice-realtime-log-wiring.test.ts`、`voice-realtime-empty-transcript-guard.test.ts`、`voice-realtime-queue-depth-truth.test.ts`、`voice-realtime-queue-depth-drain-refresh.test.ts`、`voice-realtime-replay.test.ts`、`voice-realtime-unforwarded-disposition.test.ts`、`voice-realtime-spend-guard.test.ts`、`voice-realtime-diagnose.test.ts`、`voice-realtime-audio-capture-wiring.test.ts`、`voice-realtime-segmented-protocol.test.ts`、`voice-realtime-connection-resilience.test.ts`、`voice-realtime-streaming-stages.test.ts`。逐文件 pass 数写入「验证读数」。
- [ ] AC6 `npm run typecheck` 退出 0。
- [ ] AC7 定稿在真实上游上复验（实验 B 臂 = 出货 HEAD，本任务改完后即定稿）：`experiments/voice-realtime-relay-mode-replay/run.mts` 与 `digest.py` 已在仓库中；对 `b5d01c21`、`d4c9bfc4`、`e650117b` 各跑一次 `npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-relay-mode-replay/run.mts --capture <id> --arm B --rep verify --out /tmp/relay-mode-replay-verify`（三条可并行，约 6 分钟、约 ¥0.5），再 `python3 -I experiments/voice-realtime-relay-mode-replay/digest.py /tmp/relay-mode-replay-verify/<id>-B-rverify`；三份 `SUMMARY` 行里 `text_after_user` 之和 ≤ 1、`status` 均为 0，三行 SUMMARY 原样写入「验证读数」；同节再写**逐条语义读数**：对照每份 capture 的原 journal 转写，列出未送达或意思被改的消息单元（无则写「无」），并注明打断调用是否都带了 `message`。

## DoD

出货的 Live Voice 转发 prompt 不再给模型「不调用」这一选项，打断时人的原话随打断一起进入会话，模型看不到 `session_status`；这一定稿在三份最近真实对话录音上经真实 `qwen3.8-omni-flash-realtime` 回放验证，对人话回文本的次数 ≤ 1、逐条语义读数无丢句；回放 harness 在仓库里，下次实测的 capture 可直接复跑。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-tools.ts
- server/modules/voice-realtime/voice-realtime-settings.ts
- server/modules/voice-realtime/tests/voice-realtime-instructions-no-stop-words.test.ts
- server/modules/voice-realtime/tests/voice-realtime-status-tool.test.ts
- server/modules/voice-realtime/tests/voice-realtime-status-injection.test.ts
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts
- server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.real-transport.test.ts
- server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts
- server/modules/voice-realtime/tests/voice-realtime-log-wiring.test.ts
- experiments/voice-realtime-relay-mode-replay/run.mts
- experiments/voice-realtime-relay-mode-replay/digest.py
- experiments/voice-realtime-relay-mode-replay/README.md
- tasks/gap-voice-relay-mode-a-prompt-drop-continue-arm-and-session-status.md
