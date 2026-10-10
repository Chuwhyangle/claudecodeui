---
id: gap-voice-realtime-relay-log-persistence
title: Live Voice 实时中继的日志与调试信息落盘：应用自持的逐连接记录（连接/模式、逐段 seq/时长/帧数、逐响应 token
  的文本/音频拆分与估算 CNY、session_send
  延迟与结果、换会话读数），默认开、有界、可一键清空、路径与上限可配、fail-open——对齐非实时 voice/ 上传路径
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（2026-10-10 逐文件复核过的读数，带 file:line）

实时中继**只往 stdout 打日志，不落任何文件或数据库行**，而且它之所以能到磁盘，靠的是启动器把 stdout 重定向：

- 服务端组装处三个 seam 全是 `console.log`：`server/index.ts:561`（`log: (line) => console.log(...)`）、`:571`（`usage connection total input=… output=… cost~CNY…` 那一行）、`:573-574`（`observe` 里的收发线）。模块自己没有任何写文件/写库的路径——`server/modules/voice-realtime/index.ts` 的公开面里没有 store；`voice-realtime-ws-proxy.service.ts` 的 import 只有 `ws` 与模块内部件（无 `node:fs`、无 sqlite）。
- 落盘的唯一来源是启动器的 stdout 重定向：`scripts/serve-scoped.sh:63`（`LOG_FILE="${QUAY_SERVER_LOG:-$ROOT_DIR/server.log}"`）、`scripts/soak.sh:302`（`--property=StandardOutput=append:$WORK/server.log`）。
- **逐连接什么都不存**：识别到的转写以 `caption` 帧回给浏览器、并写进日志行，从不存储；原始音频从不写（日志里只有 `frames=N` 计数）。e2e 临时目录下的 `voice-*.wav` 是 Playwright 的假麦克风夹具，不是生产存储：`playwright.config.ts:1223`（`voice-utterance.wav`）、`:1517`（`voice-dashscope-utterance.wav`）。

**对照——非实时路径确实有自持的持久化面**（这正是本任务要对齐的对象）：`server/modules/voice/voice-data.ts` 把识别文本**与**切段音频写到 `~/.cloudcli/voice-data`（默认目录名见 `:62`，目录 0700 / 文件 0600 见 `:68-69`，字节上限默认 2 GiB 见 `:82`，按时间从旧到新逐出见 `evictToLimit` `:367`，`clear()` 见 `:503`）；对外一键清空经 `server/modules/voice/voice.routes.ts:413` 的 `DELETE /data` 暴露；另有 SQLite 的 `user_voice_settings`（`server/modules/database/schema.ts:287`）与 `voice_user_identifiers`（`:319`）。实时路径今天没有任何与之相当的自持面。

**SPEC 边界，必须写清以免被读成推翻 D8。** `docs/proposals/voice-realtime-segmented-relay-SPEC.md:23` 的决策 D8 明确不为想象中的安全风险设门槛（不脱敏、不保真校验、不默认关闭、不二次确认）。但**同一份 SPEC 的第 6 条目标**（`:32`）把可观测列为目标：「每个片段、每次响应、每次换会话都有日志与用量，能与阿里云账单对上」。本任务**正是**把这条目标落到磁盘上；它**不改** D8 的任何一条（不引入脱敏/保真校验/默认关闭/二次确认），两者的关系是「D8 管隐私门槛、目标 6 管可观测」，不是互相否定。

**当日实测到的具体痛点（动机）**：把阿里云账单与我们自己的数字对账，只能靠在重定向出来的 `server.log` 里 grep；而 usage 行只记**连接级**总量——逐响应的文本/音频拆分、以及固定前缀（指令 + 工具声明 + 上下文包）与会话累积之间的拆分都没有记录，所以把某次连接的 **9,230 个文本输入 token**（立案者当日读数，取自对 `server.log` 的逐行推算，不是本任务复算所得）拆开只能靠 delta 与字符数做算术，而不是从一条记录里**读**出来。

### 方案

给实时中继一个**应用自持**的逐连接记录（不由 stdout 重定向产生），内容是一个操作者在事后审成本与行为所需的最小集：连接标识与模式（segmented/continuous）；每个片段的 seq/时长/帧数；每个响应的输入/输出 token，**带文本/音频拆分与估算 CNY**；每次 `session_send`（延迟、结果）；换会话与延迟读数。默认开、有界（按大小**和/或**年龄轮转）、可一键清空、路径与上限可由环境变量覆盖。**fail-open**：写失败绝不打搅正在进行的调用。

<!-- dedup-ref --> 机制去重（立案时实测）：按机制（不是症状词）检索，`task_list({search:"voice-realtime log"})`、`{search:"日志落盘"}`、`{search:"调试信息"}`、`{search:"voice-realtime-log"}`、`{search:"usage connection total"}` 均 0 命中；`{search:"持久化"}` 命中的是与语音无关的判据类任务。带 `goal_ac: AC-322` 的 `gap-voice-segmented-relay-rollout-and-reconcile`（status=done）做的是**成本回放与对账**（估算公式、对账脚本），不是「把中继日志持久化」；`gap-voice-data-local-store-default-on`（done）建的是**非实时**上传路径的存储，本任务**不改**它，只对齐其形状。本任务与二者是相关但机制不同，不重复它们，也不与它们互为前置。

<!-- no-open-peer --> 合并候选检查：本仓当前 **todo/ready 任务为 0**（`task_list({status:"todo"})` 与 `{status:"ready"}` 均 0 条；`needs-human` 3 条，均与本机制无关）⇒ 没有任何在飞任务会跑在这些文件上，判定为 none found。

## Plan

1. **落盘模块**（对齐 `voice-data.ts` 的形状：小 writer + 注入 sink，从而不必碰真实目录即可测）：新增 `server/modules/voice-realtime/voice-realtime-log.ts`。对外一个 store：`append(entry)`、`clear()`、`directory()`；目录解析写成纯函数（入参显式给出，环境变量归组装点读取），默认放在数据库同级（与 `resolveVoiceDataDir` 同形的 `resolveVoiceRealtimeLogDir`），可用 `VOICE_REALTIME_LOG_DIR` 覆盖；目录 0700、文件 0600（显式 `chmod`，理由同 `voice-data.ts:28-33`）；上限由 `VOICE_REALTIME_LOG_MAX_BYTES` 覆盖，写入后按最旧优先逐出（可再叠加年龄轮转）。**写入失败抛给调用方由调用点吞掉**，模块自己不改变调用语义。
2. **接线到唯一的组装点**：`server/index.ts` 的 `buildVoiceRealtimeSeams`（`:558`）就是已经在建这三个 seam 的地方——把 writer 传进 `log`/`observe`，让每一行**同时**进 stdout 与记录（tee），不要新增第二个组装点；`server/modules/voice-realtime/index.ts` 导出新模块以维持模块边界。
3. **补 usage 行的拆分**：现在 `:565-571` 只累加连接级总量。改为在 `observe` 里额外记录每个 `response.done` 的输入/输出 token，并**带文本/音频拆分**与 `estimateRealtimeCostCny`（`server/index.ts:570` 已有）的估算；固定前缀（`session.update` 的指令 + 工具声明 + 上下文包）与会话累积各记一次，使逐组件成本是**读**出来的，不是推算的。
4. **一键清空**：把 store 的 `clear()` 经模块既有路由 `server/modules/voice-realtime/voice-realtime.routes.ts` 暴露一个 `DELETE`（与非实时路径 `voice.routes.ts:413` 同形），删记录并返回条数，目录不存在返回 0。
5. **fail-open 与可观测自检**：写失败只记一次错误（stdout），调用继续；记录行本身不得成为新的失败源。

## AC

- [x] AC1 落盘存在且形状正确：经一次真实（或本仓 harness 的）Live Voice 连接后，记录文件在磁盘上存在，含连接标识与模式（segmented/continuous）、逐段的 `seq`/时长/帧数、逐响应的输入/输出 token 且带文本/音频拆分与估算 CNY、每次 `session_send` 的延迟与结果、换会话/延迟读数；`stat -c %a` 读到目录 0700、文件 0600。判据：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-log-wiring.test.ts` 退出 0。
- [x] AC2 有界（轮转/逐出）：把上限设小（如 64 KiB），连续写入 N 条记录后目录总字节 ≤ 上限，且被删的是**最旧**的记录、最新一条仍在；上限从 `VOICE_REALTIME_LOG_MAX_BYTES` 读到（`voice-realtime-log.test.ts`）。
- [x] AC3 一键清空：`clear()` 删除记录并返回条数；目录不存在返回 0 且不报错；该清空可从外部经模块路由的 `DELETE` 触发（wiring 测试里走真实 express app + `http.request`）。
- [x] AC4 fail-open：注入一个必失败的 sink，同一次调用**仍然完成**（异常不抛到调用方），且错误只被记录**一次**（单测断言调用成功 + 恰一条错误日志）。
- [x] AC5 逐响应拆分之和 = 连接总量：记录里逐响应的输入/输出 token 求和，逐位等于既有 usage 行打印的 `connection total input=… output=…`（wiring 测试同时读记录与 usage 行）。
- [x] AC6 对照/负控（不是只测 happy path）：记录由**应用**写入而非 stdout 重定向——在**不设置任何重定向**（不写 `server.log`）时记录文件仍出现；同一路径下非实时 store 的目录（`server/modules/voice/voice-data.ts` 的目录）**零新文件**，证明实时路径没有偷偷写进非实时 store。

## DoD

真实落地判据（DIR-026 读法 A：真的有一个对象被这套机制操作过，文件/fixture 存在是必要但不充分）：**一次真实的 Live Voice 连接**在磁盘上留下**一条真实记录**，其内容足以让一个操作者**不 grep stdout 重定向**就复现当日那次账单对账——即能直接从记录里读出逐响应的文本/音频拆分与成本，而不是靠 delta 与字符数做算术。AC1 的段/响应/token 三类读数都取自这次真实连接（真上游或本仓已建立的 live 诊断通道），不是只用单测夹具。

L_D 该轴有读数：新增的是「每次连接的音频秒数、帧数、逐响应 token」这类领域读数，由真实记录给出。

L_G 该轴有读数：文本/音频拆分与固定前缀/会话累积拆分，是成本异常线（SPEC 决策 D2）与账单对账（目标 6）的直接读数。

## Touches

- server/modules/voice-realtime/voice-realtime-log.ts (new)
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/voice-realtime.routes.ts
- server/index.ts
- server/modules/voice-realtime/tests/voice-realtime-log.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-log-wiring.test.ts (new)
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-voice-realtime-relay-log-persistence.md
