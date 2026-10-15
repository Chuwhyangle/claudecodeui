---
id: gap-live-voice-busy-release-quiet-window-next-priority
title: Live Voice 忙时投递改为「静止窗口释放 + next 优先级」：不等回合结束，停说满 2 s（20 s 封顶）就在下一个工具边界投进去
status: needs-human
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**来源：X3' 回放实验（2026-10-15，`experiments/voice-now-priority/REPORT.md`）**。现状（= 实验的 A/B 臂）是：忙时把各段缓冲，**等当前 turn 的 `result` 到达**才合成一条投进去（`later` 入队）。实验的 D 臂把释放点改成**静止窗口**（上游停说满 2 s 且距最后一段 ≥0.8 s 才冲洗，20 s 封顶，包含式去重）并**以 `next` 投递**，有效 84 次读数：

| | 现状（A/B） | 静止窗口 + `next`（D） |
|---|---|---|
| 投递延迟 p90 | A 18.5 s / B 10.8 s | **1.6 s** |
| 首个反应 p90 | A 22.5 s（越界）/ B 14.0 s | **8.4 s** |
| 派后台的 run | A 0/16 | 9/16 |

逐条机制证据（带时间戳，读自 digest）：

- **不再白烧重复回合**（`a175e6cd`，A/B 4/4 次，C/D/E 0/6）：A/B 把 `[DUP+REMARK]`「先处理现在的这个请求。哎，挺好。」缓冲到 turn-end（8.0/8.6 s）才投，**晚于模型第一次作答**，同一条指令换来一整个空转的重复回合（A-0 12.1、A-1 16.5、B-0 10.8、B-1 11.4）；静止窗口在 5.6 s 就把它并进当前回合，只消化成一次作答。
- **改道早 23 秒被读到**（`af12cbaf`）：`[REDIRECT]`「再改成十秒。」在 A/B 要等 turn-end（34.0/34.8 s，30 秒任务已跑完）才投到；A-0 甚至在不知情下反问用户「你那边的表现怎么样？」。静止窗口在 **11.5 s** 就投到工具边界（命令仍在跑，没有任何一臂能打断已在跑的命令——差别只在"模型什么时候知道"）。
- **`now` 被否掉**（不在本任务范围，但同一实验的结论）：C 臂（同窗口但 `now`）出现 **2/16 次 `error_during_execution`**（把刚起的 turn 切掉），另有 2 次把 turn 打成**零产出**、回答被推到新 turn，比 `next` 晚 7–14 s。⇒ 本任务**只做 `next`**。

**改动面（三处，皆已定位）**：

1. **释放点**：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`。现状 `armCoalesce` 在 `busyBufferEngaged` 时直接 return（把释放交给 `pollBusy` 的"回合结束"读法），`pollBusy` 只在 `readRunBusy() !== true` 时 `flushCoalesced()`。要改成：**忙时也走静止窗口**——复用该文件里空闲路径已有的"还在说话 ⇒ 窗口重新计时"那条语义，给它忙时用的阈值（停说满 2 s / 距最后一段 ≥0.8 s / 20 s 封顶），窗口到点即 `flushCoalesced()`，**不必等 run 结束**。`pending` 帧语义、`busyBufferEngaged` 守卫、1 s 空闲合并窗口**都不变**。
2. **投递优先级**：`server/modules/providers/list/claude/claude-host-driver.provider.ts:375` 的 `CLAUDE_QUEUED_INPUT_PRIORITY = 'later'` 决定"忙时写进去的帧"等整轮；本次释放的帧要 **`next`**（在下一个工具边界并入当前 turn）。该常量目前**只有一个调用点**（`turnMessages()` 里 `queuedBehindTurn` 那处），所以"改常量值"或"新增一个忙时窗口专用常量"都可以——但必须保证**只有这条释放路径**拿到 `next`，并且设备侧可读：`state.queuedInputs[].priority` 已经记录每帧的优先级（同一文件 ~3417 行），这就是 AC 的机械读数。
3. **中继 → 宿主的优先级透传**：中继现在**不发**任何 `priority`（`grep -rn priority server/modules/voice-realtime/*.ts` 零命中），所以要新增这条透传：释放忙时窗口时，投递带上 `next`，一路走到 `turnMessages()` 里能以调用方给的优先级覆盖默认值。

**为什么不是"调大窗口"或"提前 flush"**：实验里 C/D/E 三臂的窗口参数完全相同，只差优先级；窗口本身把 p90 从 18.5 s 拉到 1.6 s，`next` 保证不切正在跑的 turn（切 turn 的那 2 次 `error_during_execution` 全在 `now`）。

**实现补充（执行侧，2026-10-15）**：第 3 条"透传"在实现时比 Proposal 设想的宽一格。中继 → 宿主的唯一通道是 run 的 `options`（`HostTurnInput.options` 是 `AnyRecord`，从 `chat-control` 到 resident dispatch 一路原样透传），而 `options` 由 `mcp-session-send.ts` 的 `buildSessionSend` 组装、`readSessionSendInput` 收窄——所以档位必须在这两个函数里读入并并进 `options`，否则 `priority` 在网关就被丢掉、永远到不了 `turnMessages()`。该文件已按「真的属于本任务」补进 `## Touches`。

<!-- dedup-ref --> **相关任务与粒度决定**：granularity 工具报 `peers: []`（无 Touches 重叠的开放任务）。与 `gap-voice-relay-busy-hold-host-rounds-and-queue-visibility`（status done）**改的是同一段机制**，但方向相反：那一条把忙时 hold 改成"读宿主 rounds、**不再**回合中途放行"（即本任务要改掉的现状），本任务是"在静止窗口放行、投 `next`"——机制独立、验收独立 ⇒ **分开立**，并在报告里引用那一条作为现状的由来。`voice-realtime-ws-proxy.service.ts` 历史落地 44 个任务、中位改动 90 行；`claude-host-driver.provider.ts` 24 个任务、中位 111 行——两个都是高频文件，实现要小步、先写 seam 级用例再动实现。

## AC

- [x] AC1（静止窗口释放，不再等回合结束）：新增单测用既有 relay seam 驱动：会话 `busy=true`、一段语音在 `t0` 交付、上游 `speech` stop 在 `t1` ⇒ 断言 flush 发生在 `max(t0+800ms, t1+2000ms)`（±1 个 tick），且**在 run 结束之前**；`npx tsx --tsconfig=server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-busy-quiet-window.test.ts` 退出 0，pass 数记入 `## Notes`。
- [x] AC2（20 s 封顶）：同一文件另一用例：上游 stop 一直不来（人持续说话）⇒ 在 `buf[0]+20 s` 处强制 flush，读数与 AC1 同一次命令。
- [x] AC3（投递优先级 = `next`，可机械读）：释放出来的那一帧写进宿主时 `priority === 'next'`；断言用既有的 `state.queuedInputs[].priority` 读数（或单测里直接读该帧的 `priority` 字段），不用肉眼；随 AC1 的同一命令退出 0。
- [x] AC4（不回归既有语义）：`npx tsx --tsconfig=server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts` 退出 0——1 s 空闲合并窗口、`busyBufferEngaged` 守卫（hold 期间窗口不重开）、`pending` 帧语义均不得改变；pass 数与改动前逐字对比记入 `## Notes`。
- [x] AC5（假形态，两条）：(a) 把释放帧的优先级改回 `later` ⇒ AC3 的用例**必须红**；(b) 把静止窗口阈值改成"无限大"（退回等 run 结束）⇒ AC1 的用例**必须红**。复原后各自变绿；四组读数逐字记入 `## Notes`（改动不提交）。
- [ ] AC6（端到端，不削弱既有判据）：**未满足，本轮未勾**。前半（`e2e/voice-realtime-continuous-experience.spec.ts` 单跑 11 passed / exit 0、既有判据一条不削弱）已在本轮复量。后半要求新增的那条断言——「会话忙时说的话在下一个工具边界被读到（`command_lifecycle started` 早于该轮 `result`）」——**本轮没有加**。

  理由（**已更正一次，以 `## Notes`「更正」节为准**）：那条断言本身**是可伪的、有意义的**（它验的正是本任务的释放点：把释放点改回「等 run 结束」，它就会红）；卡住的是**在现有 fixture 上它做不成一条确定性的判据**——它要求另起一条会话 + 一套带 turn-phase 步（`thinking-tokens` / `tool-call` / `text-delta`）的 deck，且投递必须正好落在 activity store 的 turn phase 非 `idle` 的那一刻，而那个相位是帧归约出来的、由 relay 在投递那一刻采样 ⇒ 一次**竞态**。AC6 自己写着「**不削弱既有判据**」，而同一条 `mode: 'serial'` spec 的确定性是刻意做出来的，加一条靠计时赢的用例即是削弱它。

  ⇒ 「判据该重锚 / 该缩范围」是**人裁定**，三个选项与可直接执行的配方见 `## Notes` 节末。
- [x] AC7（不削弱既有判据）：`npm run typecheck` 与 `npm run lint` 各自退出 0；按 AGENTS.md 加载 `$backend-module-standards`；单跑 `server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts` 退出 0。

## DoD

真会话里，Claude 在前台跑一条 >10 s 的命令时用户插话：该句在**下一个工具边界**进入会话（journal/transcript 的时间戳可见，早于该轮 `result`），而**不是**等整轮结束；并且不再出现「答完又被追着答一遍」的重复回合（`a175e6cd` 那类：投递落在模型首次作答之后）。`now` 路径**不得**被引入（本任务只做 `next`）：`grep -c "error_during_execution"` 在新读数里不因本改动上升。生产侧观察项（不作为执行侧 AC）：下一次 Live Voice 实测的 journal 里，忙时插话的投递 → 被读到的间隔应落在秒级而不是十秒级。

## Notes

**实现（commit `a126abced`，任务分支）**

- `voice-realtime-ws-proxy.service.ts`：新增 seam `busyQuietWindowMs` / `busyQuietSincePieceMs` / `busyQuietCapMs` 与常量 `VOICE_BUSY_QUIET_WINDOW_MS=2000`、`VOICE_BUSY_QUIET_SINCE_PIECE_MS=800`、`VOICE_BUSY_QUIET_CAP_MS=20000`、`VOICE_BUSY_RELEASE_PRIORITY='next'`。`onUpstreamTurn` 现在也记录 `upstreamTalking` 与 `lastUpstreamSilenceAt`（上游收口的时刻）；忙时分支给 hold 打 `busyWindowOpenedAt`/`lastBusyPieceAt` 并在每个片段后重算窗口；`armCoalesce` 的 busy 守卫从「直接 return」改为「驱动 hold 自己的时钟」；`flushCoalesced(busyRelease)` 只有 `'quiet-window'` 那条写 `priority=next` 并把日志行写成 `busy quiet window released: … busy=<b> source=<s> priority=next`（run 结束那条仍是逐字不变的 `busy hold released: …`）。窗口算术逐字取自回放：`due = min(buf[0]+cap, max(lastPiece+800, lastStop+2000))`，仅在上游 turn 已收口时生效；`lastUpstreamSilenceAt === null`（上游从未报过收口）时只剩封顶。
- `claude-host-driver.provider.ts`：新增 `CLAUDE_TURN_PRIORITY_OPTION='priority'` 与模块私有 `readRequestedPriority()`（只认 CLI 三个档位）。`turnMessages()` 在 `queuedBehindTurn` 时用调用方给的档位，否则仍是 `CLAUDE_QUEUED_INPUT_PRIORITY='later'`；非忙时（冷启动）照旧不写档位。
- `mcp-session-send.ts`（新补进 Touches，理由见 Proposal 的「实现补充」）：`readSessionSendInput` 读 `args.priority`（只认三档，否则 `undefined`），`buildSessionSend` 把它并进 `options`。**刻意不写进 `SESSION_SEND_INPUT_SCHEMA`**：档位不是模型可达的工具参数，进 schema 会让网关的对外声明与 voice 平面的镜像（AC-2 逐字段比对）漂移。

**AC1/AC2/AC3 —— `npx tsx --tsconfig=server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-busy-quiet-window.test.ts`**

```
✔ AC1: a busy hold leaves on the quiet window — max(piece+800ms, stop+2000ms) — before the run ends (2102.848006ms)
✔ AC2: with the endpoint still talking, the hold leaves at the cap counted from its first piece (403.026884ms)
✔ AC3: the quiet-window release carries priority=next, and the run-ending release carries none (156.66335ms)
ℹ tests 3  ℹ pass 3  ℹ fail 0     exit 0
```

- AC1 的读数怎么来的：用例把**出厂常量**当 seam 值喂进去（缺陷改了常量就改行为），但期望值写成**字面量**（`REPLAY_QUIET_WINDOW_MS=2000` / `REPLAY_QUIET_SINCE_PIECE_MS=800` / `REPLAY_QUIET_CAP_MS=20000`）。两边若同源，窗口被改成 `Infinity` 时期望也会跟着变 `Infinity`，红就落在 `Infinity` 算术上而不是「没在窗口上放行」。AC1 另断言 release 行带 `busy=true`（放行时宿主仍说 turn 在飞）、且不是 run 结束那条行。
- AC2 用缩放后的封顶（400 ms）驱动**同一套算术**，并把出厂三数按字面量钉住（20 s / 2 s / 800 ms）——20 s 墙钟不是判据该花的钱。
- AC3 的行为断言直接对字面量 `'next'`（不对常量）：拿常量比常量的话，把常量改回 `later` 仍然相等，假形态就抓不住了。同一用例的下半段是**对照**：run 结束那条放行 `priority === undefined`、日志行不含 `priority=`。

**AC4 —— 既有语义逐字对比**

```
改动后（worktree）：tests 7  pass 7  fail 0
改动前（develop，同一文件）：tests 7  pass 7  fail 0
```
`npx tsx --tsconfig=server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts`，两次均 exit 0，pass 数逐字相同（7/7）。

**AC5 —— 两条假形态（读数，改动未提交）**

| 假形态 | 命令 | 读数 |
|---|---|---|
| (a) `VOICE_BUSY_RELEASE_PRIORITY` 改回 `'later'` | `… --test --test-name-pattern=AC3 …voice-realtime-busy-quiet-window.test.ts` | **红** `AssertionError: the released frame is written under 'next' … 'later' !== 'next'`，pass 0 / fail 1 |
| 复原 | 同上（全文件） | 绿，pass 3 / fail 0 |
| (b) `VOICE_BUSY_QUIET_WINDOW_MS = Number.POSITIVE_INFINITY` | `… --test --test-name-pattern=AC1 …` | **红** `the release must land on the quiet window (by …) rather than waiting for the run to end`，pass 0 / fail 1（2.5 s 落在期限内，未等到封顶） |
| 复原 | 同上（全文件） | 绿，pass 3 / fail 0 |

**AC6 —— e2e（只做了「单跑退出 0」那半）**

```
bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-continuous-experience.spec.ts --reporter=line
→ 11 passed (41.3s)   exit 0
```
含 `zero cloud calls` / X-1..X-7 全部既有判据：本改动**没有**削弱任何一条（改动前同一条命令也是 11 passed，故这一半是「不回归」而不是「新判据」）。要求新增的那条断言**未加**，理由见下面「第 2 轮续做」与「更正」两节。

**AC7**

- `npm run typecheck` exit 0（三个 project 全过）。
- `npm run lint` exit 0（243 条既有 warning，无 error；本任务改动的四个文件零 warning）。
- `$backend-module-standards` 已加载并逐条对照：跨模块只经 barrel（`mcp-session-send.ts` 只新增 `HostInputPriority` 的 type-only import，来自 `@/shared/types.js`）；新常量与新 seam 都带 doc comment；无新增模块局部 `types.ts`/`utils.ts`；导出都带消费者说明。
- `npx tsx --tsconfig=server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts` exit 0（pass 10 / fail 0）。

**2026-10-15 第 2 轮续做（merge develop 后复量）**

本轮先把 develop（当时领先分支 71 个提交）合入，再在合并后的树上逐条复量。

- AC1/AC2/AC3：`voice-realtime-busy-quiet-window.test.ts` → **pass 3 / fail 0，exit 0**。
- AC4：`voice-realtime-single-pending-message.test.ts` → **pass 7 / fail 0，exit 0**（与改动前 7/7 逐字相同）。
- AC5 两条假形态（改动未提交；复原后 `voice-realtime-ws-proxy.service.ts` sha1 两次同为 `a31de9ca8bb1`，`git status` 干净）：
  - (a) `VOICE_BUSY_RELEASE_PRIORITY='later'` ⇒ AC3 **红**（pass 0 / fail 1，`AssertionError: the released frame is written under 'next' …`）；复原 ⇒ 绿 3/3。
  - (b) `VOICE_BUSY_QUIET_WINDOW_MS=Number.POSITIVE_INFINITY` ⇒ AC1 **红**（pass 0 / fail 1，`the release must land on the quiet window (by …) rather than waiting for the run to end`）；复原 ⇒ 绿 3/3。
- AC7：`npm run typecheck` exit 0；`npm run lint` exit 0；`voice-realtime-uplink-vad.test.ts` → pass 10 / fail 0，exit 0。
- AC6 前半：`e2e/voice-realtime-continuous-experience.spec.ts` → **11 passed (39.9s)，exit 0**（含 zero-cloud-calls 与 X-1..X-7）。

AC6 后半仍**未加**，且本轮修正了上一轮对该 blocker 的两处表述：

1. **该 fixture 的忙态窗口被它自己的闸绕开了（复现）。** 本轮新跑的 journal（`<dataDir>/voice-realtime-log/<connId>.jsonl`，125 行）里 `holding while the session is busy` / `busy hold released` / `busy quiet window released` 各 **0 次**，也**没有任何 `busy=` 读数**；两条投递都走 1 s 空闲合并窗口（`queued: opening a 1000 ms coalescing window (the frame precedes the sent)`）。这不是缺陷：`deck()` 是 `unattended-turn`(0) → `turn-end`(TURN_END_AT_MS) → `wait`(120 s)，而该 spec 的门**必须**等 turn lease 被读成 RELEASED 才开播——因为落在忙态上的投递会被 debug agent 交给 `acceptPushedCommand`，**只记 `command_lifecycle state=queued`、不画行**，X-1 的可见 disposition 腿就会红。两条都是该文件自己写下的设计（`e2e/voice-realtime-continuous-experience.spec.ts` 头部与 :933-957）。
2. **上一轮的「第 2 条前提」（"debug agent 没有『并入当前 turn 的下一个工具边界』这件事"）不准确，已修正**：`debug-agent.engine.ts:620` 的 `dequeue` 步**会**在 walk 的 run 仍在飞时写 `command_lifecycle 'started'`（引擎注释明写 "this walk's own run is still in flight"）——也就是说「进程把手里那条命令启动了」这个可观察量在该平面上**是存在**的。所以那条断言并非「加不上」。
3. **机制读数（解释第 1 点为什么在该 deck 下必然如此）**：`hostRunActivity` 对 debug-agent 会话拿不到 rounds——`runInFlight` 只由 `claude-host-driver.provider.ts` 实现，`provider-runtime.service.ts:933` 对没有该 verb 的 driver 返回 `null`——于是落回 activity store 的 turn phase；而该 deck **没有任何 turn-phase 步**（`thinking-tokens` / `tool-call` / `text-delta` 一个都没用，见 `deck()`），所以 relay 的忙时读数在该 fixture 里恒不为 `true`。`debug-agent.scenario.ts` 确实提供这些 op。
4. **更正（同轮，撤回一条过早的结论）**：本轮一度把理由写成「这条断言在该平面上**不可伪**」，**那是错的**，此处更正 —— 断言的可伪性取决于**投递落在什么时候**，与宿主认不认档位无关：
   - **有本改动时**：忙态投递在静止窗口（2 s）就落地，walk 的 turn 仍被持有 ⇒ 该句走 debug agent 的忙时路径入队 ⇒ 之后的 `dequeue` 步写 `command_lifecycle 'started'`，**早于** `turn-end`（该轮 result）⇒ **绿**。
   - **把释放点改回「等 run 结束」时**（= AC5(b) 的假形态，e2e 版）：relay 一直 hold 到 `readRunBusy() !== true`；本 fixture 的 walk 停在 `wait`（120 s）上、在该 spec 寿命内永不结束 ⇒ 永不释放 ⇒ 没有 `started` ⇒ **红**。
   ⇒ 所以那条断言**是可伪、有意义的**，验的正是本任务的**主项（释放点）**，不是档位。顺带一条：`grep -rn priority server/modules/debug-agent/` **零命中**——debug agent 对 CLI 三个档位没有语义，所以这条 e2e 断言**测不到**优先级那一半（那一半由 AC3 的 seam 读数负责）。

**⇒ 为什么仍不勾、仍交人裁定**：把那条断言加进去，必须**另起一条会话 + 一套 fixture**（现有 `deck()` 无 turn-phase 步；要把 relay 读成忙，投递必须正好落在 activity store 的 turn phase 非 `idle` 那一刻，而该相位是**帧归约**出来的、由 relay 在投递那一刻采样 ⇒ 一次**竞态**，拉宽窗口只能压低概率）。而 AC6 自己写着「**不削弱既有判据**」，同一条 `mode: 'serial'` spec 的确定性是刻意做出来的（音频时间基、投递前的 lease 闸、逐帧采样系列）。⇒ 这是「判据该重锚 / 该缩范围」的人裁定，不是执行侧能单方面改判据形态的事。

三个选项（实现均**无需重做**）：

- **(A) 重锚 AC6** 到一条确定性的判据上（例如 `server/modules/providers/tests/claude-resident-busy-input.test.ts` 那一族的真 claude 二进制 resident 忙时判据 / `claude-resident-dispatch-hook.test.ts`）；那条执行面是真 CLI，**认**三个档位，假形态抓得住，且无竞态。
- **(B)** 先另立一条「debug agent 忙时输入也认 `next`」的前置任务（另一组 Touches），再回来补这条 e2e 断言。
- **(C)** 按 DoD 已经写下的那条（「生产侧观察项（不作为执行侧 AC）：下一次 Live Voice 实测的 journal ……」）把 AC6 缩到「spec 单跑绿、既有判据不削弱」——这一半已在本轮复量为 11 passed / exit 0。

**若人裁定走「自己建 fixture」那条**，配方（本轮已勘察，可直接执行）：新建一条会话 + 一套 deck（`unattended-turn` 开后带 `thinking-tokens`/`tool-call` 使其相位非 idle；把 `turn-end` 排远；在投递与该 `turn-end` 之间放一个 `dequeue`），在忙窗内播一句，然后读两处：journal 的 `busy quiet window released … priority=next`，与 transcript 里该命令的 `command_lifecycle started` 时刻早于该轮 result。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/mcp-gateway/mcp-session-send.ts
- server/modules/voice-realtime/tests/voice-realtime-busy-quiet-window.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts
- e2e/voice-realtime-continuous-experience.spec.ts
- tasks/gap-live-voice-busy-release-quiet-window-next-priority.md
