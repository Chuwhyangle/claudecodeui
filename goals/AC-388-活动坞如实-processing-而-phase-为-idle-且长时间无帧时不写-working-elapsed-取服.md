---
id: AC-388
title: 活动坞如实：processing 而 phase 为 idle 且长时间无帧时不写 Working…；elapsed 取服务端 turn 起点，重挂载不归零
status: draft
kind: criterion
goal: GOAL-045
criterion: npx vitest run src/modules/chat/tests/activityDockHonestStatus.test.tsx
expect: 读数（vitest + jsdom，真实 ActivityIndicator 与 useActivityFreshness，注入时钟）——(a)
  processing=true、phase=idle、超过阈值仍无任何 turn 帧 ⇒ 标签不是
  `Working…`，而是如实的「等待服务端」类文案，并保留 Stop；(b) elapsed 取服务端 turn 的
  startedAt：组件卸载再挂载、或换 hello 之后读数不归零；(c) 真实在跑的 turn（phase 为
  thinking/writing/tool）仍显示对应标签与逐秒增长的 elapsed；(d) 取假形态：elapsed 仍以 hello 时刻为锚 ⇒
  (b) 红。⚠️ 当前必红：该测试文件不存在。本条在 S3 的出口 AC 全部 achieved 之后才激活。
origin: 2026-10-16 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中认可调查结论，并指示按
  docs/proposals/resident-delivery-turn-ledger-SPEC.md 创建 GOAL/AC 并激活。依据：会话
  fdd3e920（LiveWire 第一次测试，resident）在 turn 结束后底部 Working… 持续
  1h59m、新消息结束后再次出现；server.log 的 command_lifecycle forwarded 行呈现「queued/started
  落在前一条的 run、completed 落在自己的 run」的稳态；fake 进程逐帧回放复现，并用 armRound 三行补丁做因果对照（SPEC
  §1）；生产 SDK 路径上真 claude 二进制 + mock 端点的帧序实测（SPEC §2、附录 A）。本记录承载 SPEC §9。
---
