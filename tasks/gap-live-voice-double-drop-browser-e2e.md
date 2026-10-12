---
id: gap-live-voice-double-drop-browser-e2e
title: 双断线浏览器验收：fake mic + 同一故障计划的本地 e2e 上游，零外联（第三阶段）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-segment-lost-uncertain-honest-state
goal_ac: AC-368
---
## Proposal

### 证据与架构不变量（本组任务共用）

证据：journal `~/.cloudcli/voice-realtime-log/e22ac831-30c6-4600-8bcf-b5c3cc7e3a8c.jsonl`（2026-10-12 16:01–16:03 UTC，segmented，13 段，全部 `frames=1`）：
- seq2（14.6 s 单帧）写出 commit 后 206 ms 断线 1/3，未收到 `committed`；重连后重放，1.15 s 后断线 2/3；第二次重连因 `replayedSeqs`（`voice-realtime-bridge.service.ts:633, 754-760`）不再重放 ⇒ seq2 丢失。
- `pendingCommitSeqs`（`:649`，入队 `:733`，出队 `:837, :885-886`）断线不清空 ⇒ 残留 `[2,2]`，seq3/4/5 的 `committed` 错配两位；ws-proxy 的 `segmentSeqByItemId`（`:2644-2648`）据此把 seq4 的空转写记成「segment 2 dropped: no words」（`markSegmentEmpty` `:2105-2111`）。
- `openAttempts` 终身不复位（`:538/878`）；seq6（12 s 单帧）写出后 1.07 s 断线 3/3 ⇒ 连接永久关闭。
- `endSegment` / `flushOpenSegment` 无条件发 `phase: 'committed'`（`:1145-1159`），`writeSegmentClose` 在非 open 时直接返回（`:729`）⇒ 关闭后 seq7–12 仍收到 `segment_ack committed`（ws-proxy `:2615`）。
- RC-5（**未验证假设**）：3 次断线全部紧随 ≥12 s 单帧 append，10 个 ≤5.5 s 段从未断线。只由 AC-369 的真实探针判定，任何任务不得以此为前提。

不变量（验收以此为准）：
- **ACK 分级**：written（已写到上游 socket）≠ committed（上游 `input_audio_buffer.committed`）≠ recognized（转写完成）≠ delivered（`session_send` 进入 CLI 队列，`sent` 帧）。只有 delivered 叫「投递」。
- **按段至多一次投递**：同一 `seq` 跨 socket epoch 至多一次 delivered；已投递段的重放调用被丢弃（现有 `deliveredSegmentSeqs` 重放闸，`ws-proxy:2131`）；不自动补发。
- **epoch 作用域**：`committed` 只与同一 socket epoch 内未决的 commit 配对；断线即清空，未决段转 uncertain。
- **处置完备且诚实**：每段终态为 delivered / not-forwarded / empty / failed / lost(reason) 之一；lost 不得记为 empty。
- 签名纪律（AC-357 同款）：当前缺陷腿只在**记录的首行失败签名**下通过；意外通过或别的失败必须红。


### 本任务（第三阶段，浏览器验收）

单 spec `e2e/voice-realtime-double-drop.spec.ts`：fake mic 播放 seq0..5 时间线，本地 e2e 上游读取 AC-365 的同一故障计划（F6），AC-360 外联守卫。断言页面：
- seq2 显示未送达；
- seq3–5 字幕各自归属、按说话顺序；
- V-fatal 变体下，连接终止后说的话标为未发送，且状态栏显示断开；
- 投递条数满足按段至多一次。

单次运行 < 100 s。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 编写 spec：fake mic 播放 seq0..5 时间线（时长与 journal e22ac831 一致，音频为合成），e2e 上游读取 AC-365 的故障计划，加 V-fatal 变体；2. 本地连续三次运行并记录耗时与断言读数；3. 在 playwright.config.ts 登记预算；4. `npm run lint`。

## AC

- [x] AC1：`npx playwright test e2e/voice-realtime-double-drop.spec.ts` 退出 0，无 `test.fail` / `skip`。
- [x] AC2：零外联读数（AC-360 守卫）；三次运行耗时均 < 100 s。
- [x] AC3：`npm run lint` 退出 0。

## DoD

真实浏览器在本地跑通「双断线」与「永久断开」两个变体，页面上的处置文案与 AC-367 一致；三次运行读数、外联守卫读数写入 `## Notes`；不重启 :3001，不改产品代码。

## Touches

- e2e/voice-realtime-double-drop.spec.ts (new)
- playwright.config.ts（新 spec 预算登记）
- tasks/gap-live-voice-double-drop-browser-e2e.md

## Notes

立项：Opus 常驻会话，2026-10-13（GOAL-043 / AC-368）。

### 读数（2026-10-13，本工作树）

- **AC1 / 单次运行**：`node_modules/.bin/playwright test e2e/voice-realtime-double-drop.spec.ts`（= `npx playwright test` 同路径）单次运行 **7 passed**，退出码 0；spec 内无 `test.fail` / `test.skip`。
- **AC2 / 耗时（连续三次，墙钟）**：22.45 s、22.20 s、21.60 s；Playwright 自报 21.7 / 21.6 / 21.1 s。均 < 100 s。
- **AC2 / 外联守卫读数**：
  - 服务器侧：`QUAY_E2E_VOICE_REALTIME_EGRESS_LOG` 存在且为空 ⇒ 服务器零外联；
  - 浏览器侧：`[egress] browser non-local requests: 15 (api.github.com, fonts.googleapis.com)` —— 15 条全部被 `context.route('**')` `abort`，且都落在 `CHROME_HOSTS`（页面自身的 chrome）内 ⇒ 非 chrome 外联为 0。两次运行读数一致。
- **AC3**：`npm run lint`（`oxlint src/ server/ scripts/ shared/`）退出 0（仅既有 warning，无新增）。
- 关键断言读数：seq2 的 `segment_ack` 序列 = `['written','written','written','lost:upstream-drop']`（四次 dial，latest wins）；V-fatal 下断线后 seq1/2/3 均为 `['lost:connection-closed']`、`sentMessages === []`；双断线分支 `sentMessages === ['这是第六句话。']`（唯一一次投递，逐字）。

### 设计与发现（落进 spec 注释）

- **故障计划多一个 dial**：`lost(upstream-drop)` 只有在 `DEFAULT_MAX_SEGMENT_REPLAYS = 2` 耗尽（即第 **三** 次重放、第 **四** 次 dial）才发出。AC-365 的三 dial 计划（第三 dial 正常应答重放）到不了本判据的读数，故 `DOUBLE_DROP_PLAN` 在其后补一个普通 dial。
- **断线前不投递**：断线前若已有段被 `session_send` 投递，其 tool output 的 `response.done` 会清空 bridge 的 `committedSegment`（`voice-realtime-bridge.service.ts` 的 `dispatch`），使双断线塌陷成单断（实测：seq1 投递时在 dial #2 塌陷）。故 seq1 只做字幕、不 relay。
- **投递归属按文本**：客户端对 `sent` 的归属是「relayed 文本包含该 caption 原文」优先，否则回退到「上次投递以来的全部 pending」（`useVoiceRealtimeSession` 的 `carried = matched.length > 0 ? matched : thought`）。若 seq5 用改写文本，会把 seq0/1/3/4 一并吞进这一次投递、把它们从屏幕上抹掉（那是改写归属问题，不是本判据）。故 seq5 用**逐字原文** relay，归属精确：只有 seq5 自己的 caption 被这次投递接管，其余句子保留各自 `heard` 行、按说话顺序排列。
- **V-fatal 的第一条 outcome 行**：seq0 在断线前已 committed，被拒拨耗尽重放预算后记为 `lost:upstream-drop`（第 4 条 outcome 行）。AC 读的是断线**后**的 seq1/2/3（`connection-closed`），故按 seq 选择，seq0 单独断言以免计数被藏起来。
- **提交 observer（去竞态）**：重连是 loopback 拨号、毫秒级完成，`commitCount()` 的「拨号前/后」比较会输；改为上游在**到达时**用 `dialed()` 打戳的 commit 观察者（`Ctx.commitDials`），断言 `ctx.commitDials.includes(dial)`。
- **一次观测到的 boot flake**：首轮三连跑中有一跑在 `enterVoice` 的 30 s `toBeVisible` 上红（墙钟 41 s，冷 SPA boot）。已按本文件 `beforeAll` 的同一模式在 `enterVoice` 加一次有界的 `reload` 重试；此后 3/3 + 4/4 绿。

### 边界

- 未重启 :3001；无产品代码改动 —— 仅新增 `e2e/voice-realtime-double-drop.spec.ts` + `playwright.config.ts` 三处登记 + 本任务文件。
