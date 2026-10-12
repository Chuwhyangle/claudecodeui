---
id: gap-live-voice-replay-event-synced-waits
title: 回放节奏改为事件/有界状态同步：约 15 处固定 waitForTimeout 收敛到 ≤3 处且每处写明 fixed-wait 理由，CPU
  压力下逐用例结果不变
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-replay-local-egress-guard
goal_ac: AC-358
---
## Proposal

### 问题

回放 spec 的录制（`beforeAll`）用约 15 处固定 `page.waitForTimeout`（150 ms–5 s，见 spec 约 :362–:478）对齐假上游脚本与服务端/浏览器状态。各用例只读录制，所以只有录制时刻对负载敏感；worker 两次运行逐字一致，但未在负载下验证。fan-in 与 goal-driver 都可能在高负载时运行它，固定等待在慢机上会让「晚到」变成「准时」或反之，使分支语义悄悄改变。

### 要做的事

- 用事件同步替代固定等待：假上游 `onClientFrame` / `commitCount()`（等到服务端发出 commit / response.create / session.update）、浏览器 `/voice-realtime` WS 帧（segment_ack、caption、queued、sent、turn_unanswered）、DOM 状态；每个等待有上界并在超时时打印当前录制摘要。
- 只保留协议规定的真实时长（如 2.5 s 合并窗口、8 s 无应答检查须真实越过）——每处同行注释 `fixed-wait: <理由>`，总数 ≤ 3。
- 「晚到」改为显式事件顺序（例如「在服务端发出 seq4 的 commit 之后再发 C 的转写」），不靠毫秒差。

### SCOPE BOUNDARY

- ⛔ 不改产品代码；不改用例所表达的期望；依赖外连守卫任务（串行改本 spec）。

## Plan

1. 盘点每处等待的意图；2. 替换为事件/状态同步；3. 静态检查；4. 连续 3 次 + 压力 1 次。

## AC

- [x] AC1（取假形态排最前）：把某处事件同步改回过短的固定等待（如 50 ms）⇒ 对应分支的录制帧序改变、相关用例红（逐字行写入 Notes），证明同步点真的承重。
- [x] AC2：`grep -c waitForTimeout` ≤ 3，且每处同行带 `fixed-wait:` 理由。
- [x] AC3：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1` 连续 3 次退出 0，逐用例结果逐字相同。
- [x] AC4：在 CPU 压力下（`stress-ng --cpu <核数>` 或等效，用 `scripts/with-memory-cap.sh` 包裹）运行 1 次，逐用例结果与无压力时相同；单次耗时写入 Notes（须远低于记录 timeoutMs 115000）。
- [x] AC5：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

四次运行的逐用例列表（含逐用例结果与单次耗时）、压力参数写入 Notes；`grep -c waitForTimeout` ≤ 3 且每处带 `fixed-wait:` 理由；零云调用。

## Touches

- e2e/voice-realtime-segmented-replay-20261012.spec.ts
- tasks/gap-live-voice-replay-event-synced-waits.md

## Notes

立项：Opus 常驻会话 2026-10-12，人 yale 授权（GOAL-043 / AC-358，建议 (4)）。

### 实现（提交 `299648d3`，分支 `task/gap-live-voice-replay-event-synced-waits`；develop 已并入 `60bb5096`，无冲突）

11 处固定等待 → 有界事件/状态同步：新增 `syncTo`（20 s 上界，超时抛错并附 `describeRecording` 的逐通道摘要：browser frames 计数 / 末 5 帧 / upstream commits+client frames / console warnings）、`waitFrame(type[,match])`、`waitCaption(itemId)`（caption 且 `final===true`）、`syncDom(predicate)`（新鲜 DOM 快照）、`waitStatusInjection`（app 自己的 `session.update` 且 `session.tools.length > 0` 到达上游）。同步点：V seq0→`segment_ack`；A/B after-S1→状态注入；seq1→`error{MODEL_TEXT_REPLY}`；seq2→`caption{B}`；seq3→`turn_unanswered` 帧 + `[data-testid="voice-realtime-unanswered"]` 上屏；seq4→`caption{D}`（B 追加 `caption{C}`）；seq5→`queued` 帧 + delivering 行上屏 → `sent` 帧 + 真实行 → post-S5 状态注入；Exit→heard/delivering 行离场。

### AC2 证据

`grep -c waitForTimeout e2e/voice-realtime-segmented-replay-20261012.spec.ts` = **1**（≤3），该行同行带理由：

```
481:    await page.waitForTimeout(5_000); // fixed-wait: the absent-`sent` reading must truly cross the proxy's 2.5 s coalescing window (VOICE_REALTIME_COALESCE_MS)
```

保留它的原因：变体 V 的读数是「**没有** `sent` 帧」——这是一个否定读数，浏览器侧没有任何事件可以等；必须真正越过代理 2.5 s 合并窗口（`VOICE_REALTIME_COALESCE_MS`，server/index.ts:499），并把 `waitRealRow` 变成 `.catch(() => undefined)` 的条件项。

### AC1 证伪（先试两处不承重的，再落到承重处；均已还原）

- **不承重（诚实记录）**：把 seq4 的「分支 B 晚到 S3」同步换成 `waitForTimeout(50)` → 15 passed, EXIT=0；把 V seq0 的 `segment_ack` 同步换成 `waitForTimeout(50)` → 15 passed, EXIT=0。原因：`upstream.script()` 会等到脚本最后一帧才 resolve（脚本自身的时间线已被 await），且 `utter()` 必须等这一次 commit 到达上游才返回，两处都自带节奏。
- **承重（AC1 正例）**：把 seq5 交付守卫的同步（`waitFrame('sent')` + `waitRealRow(S5)` + post-delivery `waitStatusInjection`）换成一次 `page.waitForTimeout(50)`（分支 A/B）⇒ 3 failed / 12 passed，**EXIT=1**。逐字首行：

```
  1) e2e/voice-realtime-segmented-replay-20261012.spec.ts:846:3 › … › only S1 and S5 reach Claude, in both branches
    Error: branch A: sent frames
    expect(received).toEqual(expected) // deep equality
    - Expected  - 1
    + Received  + 0
      Array [
        "这是一轮新的 live voice mode 测试。",
    -   "上面我们看见丢了一句话。",
      ]
```

红的用例：leg 3（`only S1 and S5 reach Claude, in both branches`，verbtim 首行 `branch A: sent frames`）、leg 6（`branch A: Exit back-fills the composer with exactly the unrelayed transcripts, in spoken order`）、leg 9（known-defect 腿，`unrelayed transcripts stay visibly heard after S5 is delivered…`）。录制确实改变（同一次运行的 dump 与改动前基线对比，分支 A）：

- `browserFrames` 里 `sent` 帧：基线 2 个 → 证伪 1 个（S5 的 relay 根本没发出）；
- `snapshots.beforeExit.rows`：基线 `[seeded, 这是一轮新的 live voice mode 测试。, 上面我们看见丢了一句话。<真实 S5 行>, voice-row-heard:现在是第二句话。第四句话。]` → 证伪 `[seeded, 这是一轮新的 live voice mode 测试。, voice-row-delivering:现在是第二句话。第四句话。]`。

还原后 `diff` 与已验证版本逐字相同（空 diff），`grep -c FALSIFY` = 0。

### AC3：连续 3 次（`DASHSCOPE_API_KEY= node_modules/.bin/playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1`）

三次 EXIT=0，`15 passed (1.0m)`；把「`✓ N › 用例名`」规格化后逐字 diff，run1 vs run2 / run1 vs run3 均**空**（逐用例结果逐字相同）。墙钟（含 webserver 启动）：run1 19:54:30→19:55:34 = 64 s；run2 19:55:34→19:56:37 = 63 s；run3 19:56:37→19:57:40 = 63 s。

逐用例列表（四次运行全同，每用例耗时 ≤10 ms——都是对已录制数据的纯断言）：

1. ✓ the replay ran segmented, on the local scripted upstream, with no cloud credential
2. ✓ nothing left the loopback: zero server dials and no non-local browser request beyond the page's own chrome
3. ✓ only S1 and S5 reach Claude, in both branches
4. ✓ no red error UI for the recoverable UPSTREAM_ERROR and MODEL_TEXT_REPLY; both reach the console
5. ✓ captions reach the browser keyed by the upstream itemId
6. ✓ branch A: Exit back-fills the composer with exactly the unrelayed transcripts, in spoken order
7. ✓ (a) every session.update after segments started keeps turn_detection null (manual mode)
8. ✓ unrelayed transcripts are never shown as delivering while S5 is in flight
9. ✓ unrelayed transcripts stay visibly heard after S5 is delivered, each at its spoken position
10. ✓ (c) branch A: the segment C that never got a transcript is visibly marked before Exit
11. ✓ (c) branch A: leaving with an unrecognized segment leaves an exit trace
12. ✓ (d) branch B: Exit back-fills S2, S3, S4 in SPOKEN order, not arrival order
13. ✓ (d) branch B: the late S3 transcript sits at its spoken position (before S4) on screen
14. ✓ (b) variant V: a late EMPTY transcript for item C does not refuse the active segment's S5 relay
15. ✓ (b) variant V: the segment that carried words is not acked dropped/empty-transcript

### AC4：压力 1 次

本机无 `stress-ng`，用等效负载：**32 个 `yes > /dev/null` 忙循环**（`nproc`=128，起压时 host load1/5/15 = 16.95/15.94/18.72），整条命令用 `bash scripts/with-memory-cap.sh env DASHSCOPE_API_KEY= … --workers=1` 包裹（内存上限走 wrapper 默认派生值，未 override）。

结果：**EXIT=0，15 passed (1.1m)**，逐用例结果与无压力 run1 规格化 diff **空**（相同）。单次耗时：19:57:56→19:59:00 = **64 s**（远低于记录 timeoutMs 115000；无压力同为 63–64 s，压力未改变耗时或结果）。

### AC5

`npm run typecheck` → EXIT=0；`npm run lint` → EXIT=0（0 error，仅仓库既有 warning）。

### 零云调用

leg 1/leg 2 绿：dial 只落在 loopback 假上游（`Host` 全为 `127.0.0.1:$QUAY_E2E_VOICE_REALTIME_PORT`，无 `authorization` 头），server 侧外连守卫日志为空文件存在（守卫确实装载），浏览器非本地请求仅页面自带 chrome 20 条（`api.github.com`、`fonts.googleapis.com`）；worktree 无 `.env`，`DASHSCOPE_API_KEY` 的留空不被 `server/load-env.ts` 回填。

### 合并后复跑

`git merge --no-edit develop` 干净并入（仅 task 文件变动，未触及本 spec）；在合并后的树上复跑一次：**EXIT=0，15 passed (1.0m)**，逐用例结果与前三次规格化 diff 空。
