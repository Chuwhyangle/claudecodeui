---
id: gap-live-voice-composer-embedded-acceptance-spec
title: AC-323 验收 spec：Composer 内双入口栏的浏览器级判据（超长字幕不撑高 / 不遮挡 transcript / 模型选择器 /
  断线 Retry 重连 / 截图）
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-live-voice-composer-embedded-dual-entry
goal_ac: AC-323
---
## Proposal

背景：`gap-live-voice-composer-embedded-dual-entry`（已合并 develop，commit 1264090d）实现了入口迁移与容器内紧凑栏，但它是在 GOAL-035/AC-323 建立之前落地的，且其证据里有四项只有结构论证、没有浏览器实测：超长字幕不撑高、栏不遮挡最后一条 transcript、栏内模型选择器可见（既有 fixture 的 provider 无模型选项而被隐藏）、断线后 Retry 的真实点击与"连接数仅 +1、不重复投递音频"。AC-323 的判据引用了尚不存在的 `e2e/voice-realtime-composer-embedded.spec.ts`，本任务补上它，并在它暴露缺陷时修正 `VoiceRealtimeBar`/`ChatInterface`。

做法：
1. 新建 `e2e/voice-realtime-composer-embedded.spec.ts`，复用 `e2e/voice-realtime-live-session-send.spec.ts` 的 fixture 形态（伪麦克风 `__voiceFake`、FakeUpstream、debug-agent 会话、`/api/voice/health` 路由与 `uiPreferences.voiceEnabled`）。不要 import 另一个 spec；需要共享的 helper 复制过来并保持体量小。
2. 在 `playwright.config.ts` 中把新 spec 加入与 live-session-send 同一组的 voice-realtime 端口/环境选择（现有 `selectedSpecFiles().includes('voice-realtime-live-session-send.spec.ts')` 等处）。
3. 用例：(a) 默认 Composer 双按钮在 1280 与 375 都可见且 `prompt-input` 内；(b) listening/muted/执行中三态栏 height 与 top 差 ≤2px；(c) 经 fake upstream 下发一条 ≥400 字符 interim caption，栏高不变且字幕单元 `scrollWidth > clientWidth`；(d) 栏顶边 ≥ 最后一条 transcript 消息底边（栏不遮挡）；(e) 配置一个有模型选项的 provider/会话，栏内模型选择器可见；(f) 关闭上游 socket → 栏显示 disconnected 文案与 `voice-realtime-retry`，点击后回到 listening，`upstream.connectionCount()` 仅 +1、重连前已发送的音频帧不重复出现；(g) 在 `QUAY_LIVE_VOICE_SHOT_DIR` 下写默认/监听/静音/执行中/断线五张截图（桌面与 375px）。
4. 用例红时修产品代码（限 `VoiceRealtimeBar.tsx`、`ChatInterface.tsx`），不得改 `useVoiceRealtimeSession.ts`（GOAL-034 的任务正在改它，避免冲突；Retry 已通过其公开的 `start` 工作）。

## 边界/不做

不做自动重连（Retry 为手动）；不改服务端；不改 `useVoiceRealtimeSession.ts`；不依赖 GOAL-034。

## AC

- [ ] AC1 新 spec 在桌面 1280 与 375px 全绿，覆盖 (a)–(f)。
- [ ] AC2 `npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts` exit 0。
- [ ] AC3 取假形态现场红再还原为绿：(a) 字幕单元去掉 truncate；(b) 栏高随阶段变化；(c) 移除 Retry 按钮。
- [ ] AC4 桌面与 375px 的五张截图写入 `artifacts/live-voice/composer-embedded/` 并已查看。

## DoD

`quay goal gate AC-323` 的判据三条命令 exit 0；三条假形态红绿输出留档；截图路径与 treeSha 记入本任务 Evidence。

## Touches

- e2e/voice-realtime-composer-embedded.spec.ts (new)
- playwright.config.ts
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
- src/modules/chat/ChatInterface.tsx
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-live-voice-composer-embedded-acceptance-spec.md (self)
