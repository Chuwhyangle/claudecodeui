---
id: AC-389
title: 全局 Escape 守卫：只在输入框聚焦且无浮层时 abort，浮层内的 Escape 只关浮层
status: active
kind: criterion
goal: GOAL-045
criterion: npx vitest run src/modules/chat/tests/escapeAbortGuard.test.tsx
expect: 读数（vitest + jsdom，真实 ChatInterface 的 Escape 处理）——(a)
  输入框聚焦、无浮层、会话在跑：Escape 触发一次 abort；(b) Resident 面板、对话框、弹层任一打开时按
  Escape：只关闭该浮层，abort 调用数为 0；(c) 焦点不在输入框（例如在页面其它位置）时 Escape 不 abort；(d)
  会话不在跑（canAbortSession=false）时 Escape 不 abort；(e) 取假形态：恢复为无条件 document 级
  capture 监听 ⇒ (b) 红。⚠️ 当前必红：该测试文件不存在。本条在 S3 的出口 AC 全部 achieved 之后才激活。
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC §9。
activatedAt: 2026-10-16T09:34:54.923Z
statusLog:
  - at: 2026-10-16T09:34:54.923Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-16T09:34:54.922Z
---
