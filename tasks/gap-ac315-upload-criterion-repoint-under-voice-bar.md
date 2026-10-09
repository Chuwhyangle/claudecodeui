---
id: gap-ac315-upload-criterion-repoint-under-voice-bar
title: AC-315 判据重指：Live Voice 控件已被 AC-316 换成固定底部栏，上传 e2e 仍指向已删除的
  voice-realtime-control/intent，第一条判据命令红
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-315
---
## Proposal

**现状（2026-10-09 本轮现场复跑）**：AC-315 的两条判据命令，第二条确定性绿（`tests 5 / pass 5 / fail 0`，exit 0，本轮实测）；**第一条 `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` 红**（exit 1）。台账：`.quay/gate-events.jsonl` 里 AC-315 最近一条 `gate: goal` 是 `verdict: fail`（2026-10-09T08:16:55Z，`treeSha fc994f65…`），而同一批冻结复核在 08:04/08:05/08:08Z 都判过 pass——红不是恒假，是本轮评估树的工作区状态变了。

**根因（四跳可指）**：AC-315 的判据文件仍是 GOAL-031 旧 UI 的写法，而评估根 `/data/home/yale/work/claudecodeui` 的工作区此刻承载着**在飞任务** `gap-live-voice-exclusive-mode-fixed-bar`（AC-316，`status: ready`）的未提交改造：

1. `src/modules/chat/voice-realtime/VoiceRealtimeControl.tsx` 在工作区已被删除（`git status` 显示 ` D`），新增 `VoiceRealtimeBar.tsx`；`ChatInterface.tsx` 改为互斥渲染 composer / bar，`useVoiceRealtimeSession.ts` 精简了 phase。
2. 旧 UI 的 testid `voice-realtime-control` / `voice-realtime-intent` / `voice-realtime-send` / `voice-realtime-cancel` / `voice-realtime-start` / `voice-realtime-stop` 一并消失，`data-testid="voice-realtime-bar"` 取而代之。
3. 本轮直接复跑第一条命令，失败点在工作区里已被改写的 spec：`expect(page.getByRole('button', { name: /upload/i })).toHaveCount(0)` → `Received: 2`（`ChatComposer` 的附件按钮在 voice 模式下尚未隐藏，AC-316 的互斥改造未收尾）。这是 AC-316 的在飞状态，不是 AC-315 判据自己的逻辑缺陷。
4. AC-316 自己的判据第一条命令把这条 spec 链在里面（`npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts`），所以它必须随 AC-316 一起变绿——但那是 AC-316 的验收；AC-315 的保证仍要独立留在同一条命令里。

**为什么上一次「done」没成立**：三条 claim AC-315 的任务（`gap-voice-realtime-upload-audio-and-protocol-simulation`、`gap-ac315-voice-upload-orphaned-never-merged`、`gap-ac315-upload-criterion-second-upload-flake`）全部是 done，它们在 **AC-316 之前**的 UI 上把这条判据做绿了（当时控件是 `VoiceRealtimeControl` + 可编辑草稿卡）。AC-316 是 2026-10-09 人 yale 正式批准、goal-driver 已判 `achieved` 的 UI 改造，按裁定替换了 AC-312 的 UI 形态（草稿确认 / Send / Cancel / 可见 Start&Upload 按钮）。判据文件没有跟着重指，于是第一条命令在评估树上转红。

**不 supersede AC-315（本任务的硬边界）**：GOAL-033 的 origin 与「非目标」两处都写明「AC-310/311/313/315 的后端与协议保证不受影响，不重新验收」「AC-310/311/313/315 原样有效」——被 supersede 的只有 AC-312 的 **UI 形态**，AC-315 本体继续有效。所以本任务**不得**删除/替换 AC-315、不得恢复草稿确认卡。范围只有两件事：把这条判据重指到已出货的 `VoiceRealtimeBar` UI，并**保留 AC-315 自己的保证断言**——固定语料经真实 `AudioContext.decodeAudioData` 解码 + `fileAudioSource` 分帧 → 与麦克风路径复用同一条 `useVoiceRealtimeSession` 管线（`beginCapture`/socket 发帧不分叉）→ `/voice-realtime` 代理 → 真实 `session_send` → 文本落进会话 transcript 且 reload 后仍可见；全程不调 `getUserMedia`、不存在任何麦克风替身代码路径。旧 spec 里「模型原始提议文本不得出现在 transcript」这一条是 AC-312 草稿卡形态的产物（AC-316 之后模型提议即刻执行，提议文本本身就是发送内容），随被 supersede 的形态一并废弃，不要搬回来。

<!-- dedup-ref --> 去重/粒度判断（2026-10-09）：机制去重——grep `tasks/*.md`，带 `goal_ac: AC-315` 的任务只有上述三条且全部 `done`（它们是「上一次没守住」的证据，不是重复），当前**没有任何 in-flight 任务 claim AC-315**。粒度判断——在飞 peer `gap-live-voice-exclusive-mode-fixed-bar`（AC-316，`status: ready`）的 `## Touches` 里含本任务要改的同一条 e2e spec，但 `task-granularity-advice.js` 把测试文件排除在重叠判定外、`peers` 返回空；仍选择 **separate** 而非 merge：两者是不同的 AC、各自独立验收，且 peer 已是 `ready`，此刻把工作折叠进去只会互相踩踏。调度器若按文件重叠把两者串行，本任务落地时若 spec 已被 peer 改到位，只需逐条复核下面 AC（保留 AC-315 自己的保证断言、补 `getUserMedia` 计数断言）后收口。

## AC

- [ ] `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` 在评估根 `/data/home/yale/work/claudecodeui` 上 exit 0，两个 leg（1280 与 375px）都过。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` exit 0，5 个场景全绿（本轮实测已绿，回归不许破）。
- [ ] `grep -rn "voice-realtime-control\|voice-realtime-intent\|voice-realtime-send\|voice-realtime-cancel\|voice-realtime-start\|voice-realtime-stop" e2e/voice-realtime-upload-fixture.spec.ts` 无命中：该 spec 只用已出货 testid（`voice-realtime-bar` / `voice-realtime-upload-input` / `voice-realtime-end` / `voice-realtime-phase`）。
- [ ] 上传保证被机械断言：注入固定语料后 `upstream.audioFrameCount()` 的增量 >1（证明真的跑了 `decodeAudioData` + `fileAudioSource` 分帧，不是单帧、不是空实现），且 `upstream.connectionCount()` 的增量 ≥1。
- [ ] 无麦克风保证被机械断言：用例对 `navigator.mediaDevices.getUserMedia` 打桩计数，用例结束时断言调用计数为 0；该 spec 全文不存在第二套音频源实现。
- [ ] 落库保证被机械断言：执行文本出现在会话 transcript（`USER_ROW` 命中），且 `page.reload()` 之后仍可见（poll 命中）。
- [ ] 取假形态（现场跑一次并记录）：把 `src/modules/chat/voice-realtime/audioSource.ts` 的 `fileAudioSource` 临时替换为不产生任何帧的空实现 ⇒ 第一条命令必须红（`PROPOSED_TEXT` 永不出现）；还原后复跑绿。
- [ ] `npm run typecheck` 与 `npm run lint` 均 exit 0，无新增 voice-realtime 相关告警。

## DoD

- 两条判据命令在评估根上各自跑绿，且**分别单独重跑一次**确认非一次性通过——AC-315 这条判据历史上就是间歇红的（见 `gap-ac315-upload-criterion-second-upload-flake`），单次绿不算数。
- 台账真实翻转：`.quay/gate-events.jsonl` 中 AC-315 最新一条 `gate: goal` 记录为 `verdict: pass` / `reason: acceptance passed (exit 0)`；`.quay/goal-round.jsonl` 下一轮的 `frozenFailing.failing` 不再含 AC-315（或 `frozenRecheck` 中该项 `outcome: cleared`）。
- 落地的是随 develop 出货的 spec 本体，不是本地临时改动：`git cat-file -e develop:e2e/voice-realtime-upload-fixture.spec.ts` 存在，且 `git log --oneline develop -- e2e/voice-realtime-upload-fixture.spec.ts` 能看到本次提交。
- AC-315 记录保持 `status: achieved`、**未被 supersede**；旧 testid 与草稿确认卡未被恢复（`VoiceRealtimeControl.tsx` 不复活），`VoiceRealtimeBar` 的隐藏上传 input 仍是测试通道。

## Touches

- e2e/voice-realtime-upload-fixture.spec.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
- tasks/gap-ac315-upload-criterion-repoint-under-voice-bar.md（self）