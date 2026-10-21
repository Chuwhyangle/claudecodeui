---
id: AC-345
title: Live Voice 意图控制浏览器验收：Scripted Fake + Paced Audio + Playwright
  覆盖连说中修正、文本/语音交错顺序、重复中断幂等与故障注入（上游中途断连、abort 失败、修正期
  MALFORMED_FUNCTION_CALL），零云调用
status: achieved
kind: criterion
goal: GOAL-041
criterion: f=e2e/voice-realtime-intent-control.spec.ts; [ -f "$f" ] || { echo
  "缺判据文件：$f" >&2; exit 1; }; DASHSCOPE_API_KEY= npx playwright test "$f"
expect: 读数——单文件 playwright 退出 0，各用例：(1) 执行中（会话忙）连说 N 句后说修正 ⇒ 忙时零逐句投递、屏上是唯一一张
  合并的 pending 卡（按说话顺序含各句）、bar 的队列深度计的是已交给会话的部分（忙时为 0）；中断把保持的话 + 修正 +
  说明折成一条 enqueue-then-abort（下一轮即这一条）；(2) composer 打字与语音交错 ⇒ 顺序一致；(3) 同一修正重复中断 ⇒ 一次 abort；(4) 中断途中上游断连
  ⇒ backlog 不丢、转 composer；(5) abort 失败 ⇒ 诚实回执、不假装停了；(6) 修正期上游给出畸形函数调用 ⇒
  recoverable 且不 abort；全程 DASHSCOPE_API_KEY 置空、零云调用。
origin: 人 yale 2026-10-12 授权按 A+ 推荐落地（Opus 常驻架构会话）。证据：journal
  ~/.cloudcli/voice-realtime-log/99df08d8-….jsonl × Claude transcript
  c6493eb6（2026-10-12 01:24–01:31 UTC）；契约见
  docs/proposals/voice-realtime-persistent-control-SPEC.md §0.3 / §18。
activatedAt: 2026-10-12T06:10:30.422Z
statusLog:
  - at: 2026-10-12T06:10:30.422Z
    from: draft
    to: active
    actor: goal-cli
    reason: GOAL-041 立项：任务同批建立
  - at: 2026-10-12T16:52:04.065Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-12T06:10:30.422Z
timeoutMs: 420000
---
