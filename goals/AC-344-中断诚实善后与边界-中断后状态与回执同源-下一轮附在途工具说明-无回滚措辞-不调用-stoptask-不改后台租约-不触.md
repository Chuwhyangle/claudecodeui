---
id: AC-344
title: 中断诚实善后与边界：中断后状态与回执同源、下一轮附在途工具说明（无回滚措辞）、不调用 stopTask、不改后台租约、不触碰 Quay
  worker/driver 进程或工作树
status: active
kind: criterion
goal: GOAL-041
criterion: f=server/modules/voice-realtime/tests/voice-realtime-interrupt-aftermath.test.ts;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx tsx --tsconfig
  server/tsconfig.json --test "$f"
expect: 读数——(a) 中断后 stopped 帧、S-A 行与 session_status 的 queuedItems 一致且等于 host
  真实值；(b) 下一轮附加的固定说明含 inFlightTool 名与「可能存在部分改动」，不含
  revert/rollback/undo/撤销/回滚；(c) 中断前后 session_background 租约列表相同、stopTask 调用次数为
  0、作为 Quay worker 替身的子进程仍存活。取假形态——中断路径调用 stopTask ⇒ (c) 红。
origin: 人 yale 2026-10-12 授权按 A+ 推荐落地（Opus 常驻架构会话）。证据：journal
  ~/.cloudcli/voice-realtime-log/99df08d8-….jsonl × Claude transcript
  c6493eb6（2026-10-12 01:24–01:31 UTC）；契约见
  docs/proposals/voice-realtime-persistent-control-SPEC.md §0.3 / §18。
activatedAt: 2026-10-12T06:09:58.750Z
statusLog:
  - at: 2026-10-12T06:09:58.750Z
    from: draft
    to: active
    actor: goal-cli
    reason: GOAL-041 立项：任务同批建立
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-12T06:09:58.750Z
---
