---
id: gap-live-voice-queue-depth-host-lifecycle-truth
title: Live Voice 队列深度真实：relay 读数与 host command_lifecycle 对账，回合排空即归零（阶段 0a，F1）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-338
---
## Proposal

### 现状（2026-10-12 逐文件复核，develop @ e2bb8089）

- relay 的 CLI 队列计数只增不减：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:1226` `cliQueuedDeliveries`，`:1236` 起的 `deliverSessionSend` 只在 `queued:false` 时归零（同文件 `cliQueuedDeliveries = queuedResult ? +1 : 0`）；`:1352` `queuedDepth()` 把它与合并窗口、等待消息相加。回合排空时 relay 收不到任何信号。
- 真实后果（SPEC §18.1 F-1..F-3）：journal `99df08d8` 报 `queued=8→9→10/576B`，而 Claude transcript `c6493eb6` 的 `queue-operation` 显示 01:26:18.519 七条同毫秒出队合为一轮，此后真实深度 ≤2。S-A 注入、`sent` 帧与 `session_status`（同一聚合器，`server/index.ts` `onExecStatus`）因此一起说错。
- 真实读数已存在于 host：`server/modules/providers/list/claude/claude-host-driver.provider.ts:2528` `busyInputReading()` 给出 `queuedInputs[]`（含 `startedAt`）与 `lifecycle`（`command_lifecycle` queued/started/completed/cancelled）；`:2566` `queuedInputUuid()` 已经通过 runtime gateway 暴露（`server/modules/providers/services/provider-runtime.service.ts:392`、`:771`），但 busy 读数没有通道。

### 要做的事

给 relay 一个**只读**的 host 队列读数 seam（经 runtime gateway，装配点 `server/index.ts`），在每次投递结果、每次状态注入前、以及中断后，以 host 的「未出队条目数 / 字节」对账 `queuedDepth()` 中的 CLI 那一项；读不到（per-run 会话、host 已关）时，CLI 项显式记为未知，状态行降级为「状态未知」而不是沿用旧计数。L3 自己的合并窗口与等待消息计数不变。

**回放夹具**：把 2026-10-12 时间线脱敏为 `server/modules/voice-realtime/tests/fixtures/live-voice-2026-10-12-timeline.json`（只含相对时间、事件类型、条目字节数与出队批次，**不含**任何语音正文），由假 host 按夹具推进 lifecycle，断言每个采样点的三处读数。

<!-- dedup-ref --> 机制去重（2026-10-12）：open 任务对 `cliQueuedDeliveries` / `busyInputReading` / 队列深度对账 0 命中；`gap-live-voice-queue-byte-budget-and-visible-backlog`（done）只改准入轴，未触及排空。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. runtime gateway 增加 `pendingQueuedInputs` 只读通道（`ResidentTurnEntry.pendingQueuedInputs?` + gateway 动词），provider 不支持 / 非 resident / host 已关时返回 `null`。
2. ws-proxy 新增 seam `hostQueueReading?: (sessionId) => {items,bytes} | null`，`queuedDepth()/queuedBytes()` 的 CLI 项以它为准（读不到即未知，状态行 `queued=unknown`）；`server/index.ts` 装配到绑定会话（经 `sessionsDb` 解析 provider）。
3. 写夹具与判据文件；改动钉住旧读数的既有测试（只改读数，不削弱断言）。
4. 新测试文件同步 `server/shared/tests/quay-test-script.test.ts` 计数钉子与 `scripts/suite-duration-baseline.tsv`；`npm run typecheck`、`npm run lint`。

## AC

- [x] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-queue-depth-truth.test.ts` 退出 0；文件内首组用例在「撤掉 host 对账」的假形态下断言会报 8/9/10（证明判据会红），真形态下逐点等于夹具推出的真实深度（峰值 7，出队后 ≤2）。
- [x] AC2：同一采样点 `sent` 帧 depth、S-A 注入行 `queued=` 与 `session_status.queuedItems` 三者相等（给出读数）。
- [x] AC3：per-run（非常驻）会话不回归：既有 `voice-realtime-bounded-queue.test.ts`、`voice-realtime-scripted-scenarios.test.ts`、`voice-realtime-status-injection.test.ts`、`voice-realtime-status-tool.test.ts` 全部退出 0。
- [x] AC4：host 读数为 `null` 时状态行显式降级（断言出现未知标记，且不出现旧计数）。
- [x] AC5：夹具不含语音正文（断言夹具 JSON 中无 `message`/`content`/`text` 字段）。
- [x] AC6：`npm run typecheck` 与 `npm run lint` 退出 0；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

真实对象被操作过：在真 proxy + 真 runtime gateway 读数通道（假 resident host 驱动 lifecycle）下回放 2026-10-12 时间线，给出逐采样点「旧计数 / 新读数 / 真实深度」三列对照表写入 `## Notes`；全程零云调用。⛔ 不重启 :3001。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/index.ts（装配 host 队列读数 seam）
- server/modules/providers/services/provider-runtime.service.ts（runtime gateway 只读通道）
- server/modules/providers/list/claude/claude-host-driver.provider.ts（仅当读数需补字段）
- server/shared/types.ts（新增共享读型 HostPendingQueuedInputs）
- server/modules/voice-realtime/index.ts（barrel 导出 HostQueueReading）
- server/modules/websocket/services/chat-websocket.service.ts（仅当 runtime 接口类型声明在此）
- server/modules/voice-realtime/tests/voice-realtime-queue-depth-truth.test.ts (new)
- server/modules/voice-realtime/tests/fixtures/live-voice-2026-10-12-timeline.json (new)
- server/modules/voice-realtime/tests/voice-realtime-bounded-queue.test.ts（仅当钉住旧读数）
- server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts（仅当钉住旧读数）
- server/modules/voice-realtime/tests/voice-realtime-status-injection.test.ts（仅当钉住旧读数）
- server/modules/voice-realtime/tests/voice-realtime-status-tool.test.ts（仅当钉住旧读数）
- server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts（仅当钉住旧读数）
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-live-voice-queue-depth-host-lifecycle-truth.md

## Notes

立项：Opus 常驻架构会话，2026-10-12，人 yale 授权（GOAL-041 / AC-338）。

### DoD 回放对照表（真 proxy + 真 runtime gateway `pendingQueuedInputs` + 假 resident host，全程零云调用）

判据：`server/modules/voice-realtime/tests/voice-realtime-queue-depth-truth.test.ts`「AC1 true form」，夹具 `live-voice-2026-10-12-timeline.json`。

| 采样点 | 旧计数 depth/bytes | 新读数 depth/bytes | 真实深度 depth/bytes |
|---|---|---|---|
| D1（12B） | 1/12 | 1/12 | 1/12 |
| D2（+30B） | 2/42 | 2/42 | 2/42 |
| D3（+48B） | 3/90 | 3/90 | 3/90 |
| D4（+20B） | 4/110 | 4/110 | 4/110 |
| D5（+15B） | 5/125 | 5/125 | 5/125 |
| D6（+60B） | 6/185 | 6/185 | 6/185 |
| D7（+25B） | 7/210 | **7/210（峰值）** | **7/210（峰值）** |
| 出队 7（01:26:18 同毫秒） | — | 0/0 | 0/0 |
| D8（+18B） | **8/228** | 1/18 | 1/18 |
| D9（+22B） | **9/250** | 2/40 | 2/40 |
| 出队 1 | — | 1/22 | 1/22 |
| D10（+9B） | **10/259** | 2/31 | 2/31 |

- 旧计数（假形态，无 host 对账）= 自投递累计数，只增不减 ⇒ 8/9/10；该行即 F-3 的重现，也是 AC1 首组判据的取假形态。
- 新读数（真形态）= host `command_lifecycle` 对账后的未出队条目数 / 字节，逐点等于夹具真实深度；峰值 7，首个出队批次后 ≤2，回合边界误差 0。
- `pendingQueuedInputs` 实现：`claude-host-driver.provider.ts` 从 `queuedInputs`（`startedAt===null` 且无 `started`/`completed`/`cancelled` lifecycle）计未出队条目与正文 UTF-8 字节；经 `provider-runtime.service.ts` 暴露；`server/index.ts` 接到 proxy 的 `hostQueueReading` seam。
- 读不到（per-run / host 已关）：CLI 项显式未知，状态行 `queued=unknown`，不回退旧计数（AC4）。

## Blocker

**2026-10-12T06:38:20.199Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=26814 server/modules/mcp-gateway/tests/mcp-session-send.test.ts passed=false end_ms=1791786930017
- run_id：wk-prod-anchor
- session_id：4c7f7451-6030-4053-afa8-79548390b5d5


### 2026-10-12 续做轮：上一轮 suite 红（mcp-session-send）非本任务 delta，且 alive 窗口假设已实测证伪

上一轮 exited-not-landed 的 suite 红落在 `server/modules/mcp-gateway/tests/mcp-session-send.test.ts`。**真实失败腿是 (c)（`a resident busy send reports queued`：false !== true），不是驱动 reason 里写的 (d)** —— suite 日志标题行被 stdout 里的 `say()` 行污染，机械归因因此指错了腿（子进程产物 `.out` 才有真身）。本轮读数：

- **单跑（`--test-concurrency=1`）绿**：该文件 pristine 8/8，含 (c) `queued:true` 且 queue tail 非空。另两次带临时探针的运行同样 8/8（探针已 `git checkout` 还原，工作树无残留）。
- **并发 16 跑整个 mcp-gateway 模块（46 文件）绿**：295 tests / 0 fail，(c) 仍绿 ⇒ 本会话内无法复现 lane 红。
- **驱动自己的判词**（对上一轮 outcome 实跑 `judgeRetryExemption`）：`insufficient-data-fallback` —— 失败文件不在本任务 Touches/diff 内、日志未提取出断言签名、失败文件身份在 48h 窗口内无跨任务复发（65 次 suite 红、46 次带文件清单，无一命名该文件）。
- **alive 窗口假设被实测证伪两次 ⇒ ⛔ 不要给该文件加宽 `RUN_ALIVE_MS`（那是无依据的猜测，改了就是把红推给下一个人）**：
  1. 腿内实测两次 send 的间隔：`firstSendMs=12~14` / `secondSendMs=11~13` ⇒ 约 25ms，对 1200ms 窗口有 ~48x 余量；lane 内该腿 body 只膨胀 5.4x（325→1748ms），远不足以吃掉窗口。
  2. 若窗口锚在 arm 时刻，则在首次 send 前注入 1400ms（> 1200ms 窗口）应复现该红；实测仍 `queued:true`（3.4s 腿、8/8 绿）⇒ 窗口锚在首次 send，setup 膨胀同样不解释。（`withHarness` teardown 会 `settleBy = firstSendAt + runAliveMs + 500` 全额等掉窗口，故腿的墙钟可反推出 body 时间。）
- 本任务 delta 对该路径是纯插入（只读 `pendingQueuedInputs`、运行时可选结构成员、`HostPendingQueuedInputs` 类型、`server/index.ts` 一个 `hostQueueReading` seam 回调），未触碰 resident 忙判定 / 队列入队路径。
- 本轮自测：本任务判据 `voice-realtime-queue-depth-truth` + AC3 四个兄弟文件 + `quay-test-script` 共 44 tests / 0 fail；anti-drift OK（10 文件全在 Touches 内）；`task check` 6/6。

结论：该红是**负载相关的瞬时红，且不可归因于本任务**；真正的机制未定（两个候选已排除），留待复现时再定位，⛔ 不以「加宽窗口」冒充修复。