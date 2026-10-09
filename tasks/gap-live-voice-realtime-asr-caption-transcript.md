---
id: gap-live-voice-realtime-asr-caption-transcript
title: 实时 ASR interim/final caption 作为用户消息展示（AC-317，依赖 AC-316，暂未实现）
status: done
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-live-voice-exclusive-mode-fixed-bar
goal_ac: AC-317
---
## Proposal

（创建时是范围占位草案，实现后本记录改为完成态。）

依赖 `gap-live-voice-exclusive-mode-fixed-bar`（AC-316，已 done 并合入 develop）。范围与判据见 AC-317 自身记录（`goals/AC-317-*.md`）。

**实现差距的核实结论（「识别并明确实现差距」的答复）**：`toBridgeEvent`（`voice-realtime-dashscope-transport.ts:397-413`）本就对未知类型走第 412 行兜底透传，所以 `conversation.item.input_audio_transcription.*` **能**到达 bridge；但 `voice-realtime-bridge.service.ts` 的 `dispatch()` 只认 `function_call`，其余一律 `throw UNKNOWN_EVENT`，代理的 `onError` 钩子再把每一条变成发给浏览器的 `{type:'error'}` 帧。持续采集下端点会不断发 `.delta`，**每一条都会变成一个 error 帧**——底栏会一直停在 `failed`。所以这确实不是 CSS 能做到的：必须补三处真实管道。

**落地内容**：

1. `voice-realtime-bridge.service.ts`：新增 `RealtimeCaption` 类型、`RealtimeBridgeHooks.onCaption` 钩子、`dispatch()` 里对 `.delta`/`.completed` 的分支，以及 `handleCaption()`。字段名按真实抓包取值——delta 的累计文本在 `stash`（其 `text` 字段在每条 delta 上都为空），completed 的最终文本在 `transcript`，读错字段会得到空 caption。不规范的 caption **丢弃而不上报**：它是纯展示、不可行动的，报上去只会把错误通道（浏览器渲染成会话失败）花在会话本身能挺过去的事情上。
2. `voice-realtime-ws-proxy.service.ts`：新增 outbound `caption` 帧 `{type, itemId, text, final}`，由 `onCaption` 原样转发。它与 `session_send` 的执行器**不共享任何路径**。
3. `useVoiceRealtimeSession.ts`：捕获 caption 帧，按 `itemId` **替换**而非追加（首次到达记录时间戳并沿用），每次新连接清空。
4. `ChatInterface.tsx`：把 `useVoiceRealtimeSession` 从底栏**提升**到 pane——AC-317 要求转写出现在 **transcript** 里，而 transcript 与底栏是兄弟节点，钩子留在底栏就够不到它。同时把 `composerMode` 改成由"记住哪个 session 进入了 voice 模式"派生，替代原来那个 `useEffect` 清标志的写法（后者每次切 session 都会先渲染一次底栏再被 effect 纠正）。
5. `e2e/voice-realtime-upload-fixture.spec.ts`：假上游同时发转写事件与 function_call，断言端点"听到的"文本以 **user 行**出现在 `.chat-messages-pane` 中，且与模型自己决定发送的指令**是两个不同字符串**——把展示通道与模型输入通道混为一谈的实现无法同时满足两条断言。

## 边界/不做

没有重做 AC-316 已定的互斥模式/固定栏/Mute 语义；没有改 `session_send` 的会话绑定白名单或参数校验；没有改真实 DashScope transport 的连接/重连逻辑。

## AC

- [x] AC1 两种转写事件被识别，不再误报为未知事件：协议模拟套件新增三条用例，(a) 两个 delta → 两个 caption 帧且**零** error 帧（回归本条要修的缺陷本身）；(b) `.completed` 以 `final:true` 携带最终文本、`itemId` 与 delta 相同；(c) caption 文本与真实 `session_send` 的 `message` 参数来自两条互不相通的通路。实测 `tests 8 / pass 8 / fail 0`。
- [x] AC2 转写以用户消息出现在 transcript：e2e 断言 `HEARD_TEXT` 作为 `[data-message-style="user"]` 行出现在 `.chat-messages-pane`，且 `PROPOSED_TEXT`（模型自己的指令）独立出现。实测该 spec 两条 leg 全绿。
- [x] AC3 按 `itemId` 去重替换而非追加：`useVoiceRealtimeSession` 对同 `itemId` 保留首次时间戳、替换文本，新连接清空 captions。
- [x] AC4 取假承重：去掉 bridge 的 caption dispatch 分支 ⇒ 两条 caption 用例在 2000ms `waitFor` 超时后**真的红**（实测 `pass 6 / fail 2`），恢复后 8/8 绿；把 caption 行接到 `chatMessages` 而非 `visibleMessages` ⇒ e2e 的 user 行断言收到 0 而**真的红**（现场复现：pane 渲染的是 `visibleMessages`），改对后转绿。
- [x] AC5 回归：AC-316 的三条判据命令（两个 e2e spec 链式 + 协议模拟 + AC-120）全部 exit 0；`npm run typecheck` exit 0；`npm run lint` exit 0 且无 voice-realtime 相关告警。

## DoD

两条判据命令（AC-317 的 criterion）已在 develop 树上实测 exit 0：`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` → `2 passed`；`npx tsx --tsconfig server/tsconfig.json --test .../voice-realtime-ws-proxy.protocol-simulation.test.ts` → `tests 8 / pass 8 / fail 0`。实现 commit `e3c39c1a`，已随机械 fan-in 进入 develop（`git merge-base --is-ancestor e3c39c1a develop` 为真）。

## Touches

- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
- src/modules/chat/voice-realtime/index.ts
- e2e/voice-realtime-upload-fixture.spec.ts
- tasks/gap-live-voice-realtime-asr-caption-transcript.md（self）
