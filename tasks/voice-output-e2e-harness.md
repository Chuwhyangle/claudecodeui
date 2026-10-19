---
id: voice-output-e2e-harness
title: E0 端到端验证/开发平台：浏览器 + HTTP + DashScope 服务，无人值守回放现有语料
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-405
---
## Proposal

横切底座：端到端验证/开发平台。用 MCP 浏览器（Playwright）+ HTTP 接口 + DashScope 各服务，无人值守把现有 wav 语料（`~/.cloudcli/voice-realtime-closing-turn-corpus/capture/` 的 5 个冻结 wav）驱动过三层——离体能力探针（realtime 服务直接连，run.mts 那种）、服务器回归 gate、浏览器端到端。分别服务「开发（先探能不能做到）/ 测试（回归 gate）/ 验证（真链对不对）」三个用途。

本 task 不实现任何语音机制，是 AC-405（TTS 真机可听）、AC-406（播报打断）、AC-407（backchannel）这三条 AC 真机验证的前置底座（挂 AC-405 下作为第一用例；同时服务 AC-406/AC-407）。

现有 run.mts 是离体 replay（绕过浏览器和服务器），验证不了「浏览器采集 → 服务器 → relay → TTS 播放 → UI」这条真链；E0 补上这条。

关键技术点：wav 喂进浏览器采集 = Chrome `--use-file-for-fake-audio-capture`（标准、干净，依赖启动参数）或 Playwright `addInitScript` 注入假 `getUserMedia`（可控，不依赖启动参数）。复用现有 e2e harness（topic-e2e-ui-lessons 那套），别重造。

## AC

- [ ] 给定一个 wav 样本，无人值守跑完「浏览器进 Live Voice → 播放样本 → 断言 relay 转交正确 message → 断言语音输出到达浏览器」，产出可判 pass/fail（不靠人肉看）。

## DoD

一个可重复的端到端回放脚本 + 至少一个样本跑通并产出 pass/fail；复用现有 e2e harness，不新造测试底座。

## Touches

- experiments/voice-e2e-harness/ (new)
- tasks/voice-output-e2e-harness.md