---
id: AC-358
title: 回放节奏改为事件/有界状态同步：固定 waitForTimeout 只保留有书面理由的少数处，录制在 CPU 压力下逐用例结果不变
status: active
kind: criterion
goal: GOAL-043
criterion: f=e2e/voice-realtime-segmented-replay-20261012.spec.ts; [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; n=$(grep -c "waitForTimeout"
  e2e/voice-realtime-segmented-replay-20261012.spec.ts); u=$(grep
  "waitForTimeout" e2e/voice-realtime-segmented-replay-20261012.spec.ts | grep
  -vc "fixed-wait:"); if [ "$n" -gt 3 ] || [ "$u" -gt 0 ]; then echo "固定等待 $n
  处（上限 3）、无 fixed-wait 理由 $u
  处：e2e/voice-realtime-segmented-replay-20261012.spec.ts" >&2; exit 1; fi;
  DASHSCOPE_API_KEY= npx playwright test
  e2e/voice-realtime-segmented-replay-20261012.spec.ts --workers=1
expect: "spec 中 waitForTimeout ≤ 3 处且每处同行带 `fixed-wait: <理由>`
  注释（例如合并窗口这类协议规定的真实时长），其余改为等待假上游收到的帧（onClientFrame/commitCount）、浏览器 WS 帧或 DOM
  状态，且每个等待有上界；单文件 playwright 退出 0。DoD 读数（不入判据，因 goal 判据硬上限 120s）：连续 3 次与在
  `stress-ng --cpu <N>` 或等效 CPU 压力下 1 次，逐用例结果逐字相同。"
origin: 人 yale 2026-10-12 授权按建议推进「可控、完全本地、不依赖外部 Realtime/Claude 服务的 Live Voice
  验证能力」（Opus 常驻会话只读审查 gap-live-voice-segmented-replay-20261012 落地产物后的建议
  (3)(4)(5)(6)）。
activatedAt: 2026-10-12T09:08:04.038Z
statusLog:
  - at: 2026-10-12T09:08:04.039Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-12T09:08:04.038Z
---
