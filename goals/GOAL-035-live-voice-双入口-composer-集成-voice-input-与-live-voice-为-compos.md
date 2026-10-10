---
id: GOAL-035
title: Live Voice 双入口 Composer 集成：Voice Input 与 Live Voice 为 Composer
  内两个独立按钮，Live Voice 在原 Composer 容器内以紧凑栏运行
status: active
kind: goal
origin: 2026-10-10 人 yale 要求：Live Voice 入口不得在输入框外；默认 Composer 左下为 [附件][麦克风 Voice
  Input][声波 Live Voice][…]，两者独立；进入 Live Voice 后在原 Composer 位置显示
  [状态][波形+时长+即时字幕][模型][Mute][End]，高度固定，桌面与 375px
  一致，视觉复用现有主题。GOAL-033/AC-316/317（互斥、持续采集、字幕进 transcript）已 achieved 且不重开；本 GOAL
  只改入口位置与栏内形态。与 GOAL-034（分段中继）正交，不依赖其任何任务。
activatedAt: 2026-10-10T01:42:21.134Z
---
## 背景

GOAL-033/AC-316 把 Live Voice 做成与 Composer 互斥的固定紧凑栏，但入口仍是 Composer 上方的外置文字按钮，栏也是 `border-t` 平铺行，没有波形、时长、即时字幕与模型选择，断线后会停在 "Connecting" 死态。用户要求入口回到 Composer 内部，并与原 Voice Input 并列为两个独立按钮。

## 目标

1. 默认 Composer 左下为 [附件][Voice Input][Live Voice][…]，两个语音按钮独立，各有 testid（`voice-input-button` / `live-voice-button`），Composer 外不存在 Live Voice 入口。
2. Live Voice 在原 Composer 位置、同一外壳内显示紧凑栏：状态图标、波形、mm:ss、即时字幕、模型、Mute/Unmute、End；各阶段高度与位置不变；桌面与 375px 同一交互模型。
3. 字幕只供显示，不经 session_send；Voice Input 的 ASR/草稿/发送逻辑不变。
4. 断线可见且可重连，不留 "Connecting" 死态。

## 范围与非目标

只改前端入口与栏形态（`src/modules/chat/`）及其测试。不改服务端协议、session_send 白名单、DashScope 重连；不依赖 GOAL-034 的任何任务；不重开 GOAL-033。

## 退出条件

AC-323 判据 exit 0，且 `artifacts/live-voice/composer-embedded/` 下有桌面与 375px 的默认/监听/静音/执行中截图。