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

- [ ] AC1（取假形态排最前）：把某处事件同步改回过短的固定等待（如 50 ms）⇒ 对应分支的录制帧序改变、相关用例红（逐字行写入 Notes），证明同步点真的承重。
- [ ] AC2：`grep -c waitForTimeout` ≤ 3，且每处同行带 `fixed-wait:` 理由。
- [ ] AC3：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1` 连续 3 次退出 0，逐用例结果逐字相同。
- [ ] AC4：在 CPU 压力下（`stress-ng --cpu <核数>` 或等效，用 `scripts/with-memory-cap.sh` 包裹）运行 1 次，逐用例结果与无压力时相同；单次耗时写入 Notes（须远低于记录 timeoutMs 115000）。
- [ ] AC5：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

四次运行的逐用例列表（含逐用例结果与单次耗时）、压力参数写入 Notes；`grep -c waitForTimeout` ≤ 3 且每处带 `fixed-wait:` 理由；零云调用。

## Touches

- e2e/voice-realtime-segmented-replay-20261012.spec.ts
- tasks/gap-live-voice-replay-event-synced-waits.md

## Notes

立项：Opus 常驻会话 2026-10-12，人 yale 授权（GOAL-043 / AC-358，建议 (4)）。
