---
id: AC-323
title: Composer 内双语音入口 + 容器内 Live Voice 紧凑栏（波形/时长/字幕/模型/Mute/End）；桌面与 375px
  栏高位置不变；断线可重连
status: achieved
kind: criterion
goal: GOAL-035
criterion: npx playwright test e2e/voice-realtime-live-session-send.spec.ts
  e2e/voice-realtime-upload-fixture.spec.ts
  e2e/voice-realtime-composer-embedded.spec.ts && npx vitest run
  src/modules/chat/tests/composerCompactTier.test.tsx
  src/modules/chat/voice-realtime && npx playwright test
  e2e/mobile-workspace-composer-layout.spec.ts -g " idle "
expect: >-
  三条命令均 exit 0。


  一、双入口（live-session-send / upload-fixture 两个 spec 的进入步骤，桌面 1280 与 375px）：

  - `live-voice-enter` count 0；`voice-input-button` 与 `live-voice-button`
  均可见、同一行、前者在左；`live-voice-button` 在 `[data-slot="prompt-input"]` 内。

  - 点 live-voice-button 立即进入 Live Voice（phase listening），文本框
  hidden；composerCompactTier 单测断言点麦克风不调用 onLiveVoice、点声波不调用听写 toggle。


  二、容器内紧凑栏（e2e/voice-realtime-composer-embedded.spec.ts，新增）：

  - 栏含状态图标、波形、mm:ss 时长、字幕单元、Mute、End；listening/muted/执行中三态 boundingBox 的 height
  与 top 差 ≤2px，桌面与 375px；Mute/End 在视口内且高 ≥36px；栏不遮挡最后一条 transcript（transcript 底边
  ≤ 栏顶边）。

  - 注入一条超长（≥400 字符）interim 字幕后栏高不变、字幕单元 scrollWidth>clientWidth（被截断而非撑高）。

  - 带模型选项的会话中栏内可见模型选择器。


  三、断线：服务端关闭 socket 后栏显示 disconnected 文案（非 Connecting）并出现
  `voice-realtime-retry`；点击后重新进入 listening，且上游连接计数仅 +1、不重复投递此前音频帧。


  四、回归：mobile-workspace-composer-layout 的 `@<w> idle` 各格（含 @320 长模型名不溢出）exit
  0；既有 AC-316/317 判据不变。


  取假形态：(a) 把入口放回 composer 外 ⇒ 第一节 `prompt-input` 内计数断言红；(b) 栏高随阶段变化（如 listening
  用 h-20）⇒ 第二节高度差断言红；(c) 去掉 `disconnected` 标记 ⇒ 第三节红；(d) 去掉 `max-[359px]` 窄化 ⇒
  @320 idle 溢出红。
origin: 2026-10-10 人 yale 的双入口 Composer 集成要求；经验依据：develop 1264090d 之前的代码实测——外置按钮
  `live-voice-enter` 位于 Composer 上方，VoiceRealtimeBar 为无圆角 border-t
  行且无波形/时长/字幕，socket 关闭后 phase=idle 却显示 Connecting（hook onclose 释放采集后无重试）。
activatedAt: 2026-10-10T01:44:15.203Z
statusLog:
  - at: 2026-10-10T01:44:15.203Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-10T03:56:39.184Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-10T01:44:15.202Z
timeoutMs: 480000
---
