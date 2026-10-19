---
id: voice-output-spec-announce-summary-gap
title: E0 充分性缺口：spec 补 announce/总结自动输出断言（核心接线已落地 f18c966ee）
status: done
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-403
---
## Proposal

E0 端到端 harness 已跑通（4 passed / exit 0），但它只验证了「链路骨架」——采集→relay→转交→**手动点 Read aloud** 的 TTS stand-in。它**没有**验证「relay/narrator 自动产出的语音输出」，而这才是 GOAL-047 的核心（语音输出 = 信心层）。

充分性缺口分两块：

**A. spec 补 announce/总结自动输出断言（核心接线已落地 commit f18c966ee）**

announce 文本的接线已完成：`bridge.onFollowUpText` → ws-proxy announce 门 → narrator 队列 → `narrator_speak`（单测 `voice-realtime-announce-narrator.test.ts` 2/2 绿）。但 spec 里还没有「relay 自动说开始确认」和「run 结束自动总结」的 e2e 断言。待补三件事：

1. `e2e/voiceRealtimeScriptedUpstream.ts` 加 follow-up text 模拟：session_send 后回 `response.created`（带 id）+ `response.text.done`（带 response_id + text），并在转交后授予 follow-up credit（对应 `notifySynthesizedToolResume`）。
2. `experiments/voice-e2e-harness/run.mjs` 把 `VOICE_REALTIME_CLOSING_TURN=announce` 传进 webServer 的 env（服务器进程读它解析 closing turn）。
3. spec 断言：转交后 `__voiceFrames` 收到 `narrator_speak`（开始确认文本）；构造 run 结束（busy: false）后 `__voiceFrames` 收到 `narrator_speak`（总结文本，stand-in summarizer 返回 ≤40 字）。

**B. 其余充分性缺口（本 task 明确不做，另立或挂起）**

- 真实 TTS 端到端：spec 的 TTS 是 `page.route` 假 WAV stand-in，真实 cosyvoice 合成（AC-405 单测覆盖）没串成真链。
- backchannel 真链：AC-407 的「继续说比例」KPI 未真机统计（T6 只做了能力验证 + 回退机制）。
- 多样本：只跑了 1/5 样本（402fad85），其余 4 个样本未在 e2e 里跑。

## AC

- [x] 转交后（announce 模式）`__voiceFrames` 收到 `narrator_speak`，text 是 ≤15 字的开始确认、非「OK」。
- [x] run 结束后 `__voiceFrames` 收到 `narrator_speak`，text 是 ≤40 字、无 Markdown 的总结。

## DoD

`node experiments/voice-e2e-harness/run.mjs --sample 402fad85` 在 announce 模式下跑通，新增两条断言绿；`npm run typecheck` 退出 0。B 部分（真实 TTS / backchannel / 多样本）不在本 task，明确记为边界。

## Touches

- e2e/voice-output-e2e-harness.spec.ts
- e2e/voiceRealtimeScriptedUpstream.ts
- experiments/voice-e2e-harness/run.mjs
- playwright.config.ts
- server/index.ts
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/voice-realtime-narrator.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/voice-output-spec-announce-summary-gap.md

## Notes

### 落地（2026-10-19，worker）

两条 AC 由 E0 harness 的两条新断言机械验证：`node experiments/voice-e2e-harness/run.mjs --sample 402fad85` 连续两次 `6 passed`（32.2 s / 32.3 s），narrator speaks 读数为 `["好的，我来查一下。","本轮任务已结束，全部检查通过。","好的，我来查一下。","好的，我来查一下。","好的，我来查一下。"]`。

- **announce 腿**：scripted endpoint 对每次 `session_send` 的 resumed response 回 `response.created` + `response.text.done`（`armFollowUpText`）；服务器以 `VOICE_REALTIME_CLOSING_TURN=announce` 启动，proxy 的 announce 门把该文本入 narrator 队列 → 浏览器收到 `narrator_speak`（9 字，非「OK」，utteranceId `announce-N`）。
- **run-end 腿**：armed scenario 的每一轮在 2 s 处 `turn-end`（每个被投递的消息都会重跑该 walk），proxy 的 host poll 观测到真实的 `running → idle`；400 ms settle 后 stand-in producer（`VOICE_REALTIME_SUMMARY_STANDIN`）注入 → 浏览器收到 `narrator_speak`（15 字、无 Markdown，utteranceId `run-end-summary-N`）。
- **执行中发现并修复的缺口**：客户端帧处理器把「未识别的帧」落到协议错误分支并 `setPhase('failed')`；`narrator_speak`/`narrator_stop` 因此会让整个 voice session 变 failed（每次 narration 一出现就断）。客户端现显式声明并容忍这两类帧；真正播放仍属后续 TTS task。没有这一步，服务器一旦启用 announce/总结就会打断会话。
- **生产接线**：`buildVoiceRealtimeNarratorWiring` 每连接注入 `narrator.attach`；只有部署命名 stand-in 时才安装 run-end producer。默认（silent、无 stand-in）返回 `null`，wire 与之前逐字节相同。
- **边界**：summary producer 是 stand-in，不是 B-1 真模型（真模型需要凭据与外联，与本 e2e 的零外联断言冲突）；task B 部分的真实 cosyvoice TTS、backchannel 真链、其余 4 个样本均未做。

### 第二轮（2026-10-19，续做 exited-not-landed）

上一轮 suite 唯一的红是 `server/shared/tests/quay-test-script.test.ts` 的 AC2/AC3 收集计数 pin：`f18c966ee` 在 pin 于 08:57 重测为 371 之后新增了 `server/modules/voice-realtime/tests/voice-realtime-announce-narrator.test.ts`，树变成 372 个文件，而 pin 仍写 368/370。用 `git archive develop` 导出干净 develop 复现了同样两条红，确认是 develop 侧的过期 pin、不是本分支 delta；已重测为 `unknown=369/371` 并把该文件加入 Touches。本轮 harness 再跑一次 `6 passed`（31.9 s），narrator speaks 读数与上一轮一致；`npm run typecheck` 退出 0。
