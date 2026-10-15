---
id: gap-live-voice-busy-release-quiet-window-next-priority
title: Live Voice 忙时投递改为「静止窗口释放 + next 优先级」：不等回合结束，停说满 2 s（20 s 封顶）就在下一个工具边界投进去
status: todo
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
3. **中继 → 宿主的优先级透传**：中继现在**不**发任何 `priority`（`grep -rn priority server/modules/voice-realtime/*.ts` 零命中），所以要新增这条透传：释放忙时窗口时，投递带上 `next`，一路走到 `turnMessages()` 里能以调用方给的优先级覆盖默认值。

**为什么不是"调大窗口"或"提前 flush"**：实验里 C/D/E 三臂的窗口参数完全相同，只差优先级；窗口本身把 p90 从 18.5 s 拉到 1.6 s，`next` 保证不切正在跑的 turn（切 turn 的那 2 次 `error_during_execution` 全在 `now`）。

<!-- dedup-ref --> **相关任务与粒度决定**：granularity 工具报 `peers: []`（无 Touches 重叠的开放任务）。与 `gap-voice-relay-busy-hold-host-rounds-and-queue-visibility`（status done）**改的是同一段机制**，但方向相反：那一条把忙时 hold 改成"读宿主 rounds、**不再**回合中途放行"（即本任务要改掉的现状），本任务是"在静止窗口放行、投 `next`"——机制独立、验收独立 ⇒ **分开立**，并在报告里引用那一条作为现状的由来。`voice-realtime-ws-proxy.service.ts` 历史落地 44 个任务、中位改动 90 行；`claude-host-driver.provider.ts` 24 个任务、中位 111 行——两个都是高频文件，实现要小步、先写 seam 级用例再动实现。

## AC

- [ ] AC1（静止窗口释放，不再等回合结束）：新增单测用既有 relay seam 驱动：会话 `busy=true`、一段语音在 `t0` 交付、上游 `speech` stop 在 `t1` ⇒ 断言 flush 发生在 `max(t0+800ms, t1+2000ms)`（±1 个 tick），且**在 run 结束之前**；`npx tsx --tsconfig=server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-busy-quiet-window.test.ts` 退出 0，pass 数记入 `## Notes`。
- [ ] AC2（20 s 封顶）：同一文件另一用例：上游 stop 一直不来（人持续说话）⇒ 在 `buf[0]+20 s` 处强制 flush，读数与 AC1 同一次命令。
- [ ] AC3（投递优先级 = `next`，可机械读）：释放出来的那一帧写进宿主时 `priority === 'next'`；断言用既有的 `state.queuedInputs[].priority` 读数（或单测里直接读该帧的 `priority` 字段），不用肉眼；随 AC1 的同一命令退出 0。
- [ ] AC4（不回归既有语义）：`npx tsx --tsconfig=server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts` 退出 0——1 s 空闲合并窗口、`busyBufferEngaged` 守卫（hold 期间窗口不重开）、`pending` 帧语义均不得改变；pass 数与改动前逐字对比记入 `## Notes`。
- [ ] AC5（假形态，两条）：(a) 把释放帧的优先级改回 `later` ⇒ AC3 的用例**必须红**；(b) 把静止窗口阈值改成"无限大"（退回等 run 结束）⇒ AC1 的用例**必须红**。复原后各自变绿；四组读数逐字记入 `## Notes`（改动不提交）。
- [ ] AC6（端到端，不削弱既有判据）：`e2e/voice-realtime-continuous-experience.spec.ts`（它已经在断言 `coalesced N relayed piece(s) into one message` 那条 debounce）单跑退出 0；并在其中新增一条断言：会话忙时说的话在**下一个工具边界**被读到（`command_lifecycle started` 早于该轮 `result`），而不是等整轮结束。红/绿读数、spec 名与运行命令记入 `## Notes`。
- [ ] AC7（不削弱既有判据）：`npm run typecheck` 与 `npm run lint` 各自退出 0；按 AGENTS.md 加载 `$backend-module-standards`；单跑 `server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts` 退出 0。

## DoD

真会话里，Claude 在前台跑一条 >10 s 的命令时用户插话：该句在**下一个工具边界**进入会话（journal/transcript 的时间戳可见，早于该轮 `result`），而**不是**等整轮结束；并且不再出现「答完又被追着答一遍」的重复回合（`a175e6cd` 那类：投递落在模型首次作答之后）。`now` 路径**不得**被引入（本任务只做 `next`）：`grep -c "error_during_execution"` 在新读数里不因本改动上升。生产侧观察项（不作为执行侧 AC）：下一次 Live Voice 实测的 journal 里，忙时插话的投递 → 被读到的间隔应落在秒级而不是十秒级。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/voice-realtime/tests/voice-realtime-busy-quiet-window.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts
- e2e/voice-realtime-continuous-experience.spec.ts
- tasks/gap-live-voice-busy-release-quiet-window-next-priority.md
