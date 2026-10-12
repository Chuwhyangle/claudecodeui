---
id: gap-live-voice-intent-control-browser-e2e
title: Live Voice 意图控制浏览器验收：Scripted Fake+Paced
  Audio+Playwright，故障注入、跨文本/语音顺序、幂等（阶段 1d）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-interrupt-after-revision-enqueued
  - gap-live-voice-interrupt-run-utterance-fence
  - gap-live-voice-interrupt-honest-aftermath
goal_ac: AC-345
---
## Proposal

### 范围

把 GOAL-041 的服务端行为放到真实浏览器里验收，**零云调用**（`DASHSCOPE_API_KEY` 置空，scripted fake 上游 `e2e/voiceRealtimeScriptedUpstream.ts`），音频用实时节拍音源（`src/modules/chat/voice-realtime/audioSource.ts`，`gap-voice-realtime-paced-audio-source` 已落地），执行面用可控时长的假会话。单文件 `e2e/voice-realtime-intent-control.spec.ts`，单次运行须 < 100 s（goal 判据硬闸 120 s）。

### 用例

1. 执行中连说 N 句后说一句修正 ⇒ 屏上逐条可见；bar 深度与 host 真实值一致；下一轮输入含修正且在后。
2. composer 打字与语音交错 ⇒ CLI 收到顺序 = 发生顺序。
3. 模型对同一修正重复中断 ⇒ 只有一次 abort，屏上只有一条停止回执。
4. 故障注入：中断途中上游断连 ⇒ backlog 不丢、退出后转 composer。
5. 故障注入：abort 失败 ⇒ 诚实回执，不显示「已停止」。
6. 故障注入：修正期上游给出畸形函数调用（MALFORMED_FUNCTION_CALL，2026-10-12 真实出现过）⇒ recoverable，不 abort，后续修正仍可投递。
7. 幂等：重放同一 `itemId` 不二次投递。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. scripted 上游补所需构件（重复中断、中途断连、畸形调用）；2. spec 文件；3. 本地单文件运行三次取稳定性读数；4. `npm run lint`。

## AC

- [ ] AC1：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-intent-control.spec.ts` 退出 0，7 个用例全绿。
- [ ] AC2：连续 3 次单文件运行全绿，记录每次耗时（均 < 100 s）。
- [ ] AC3：spec 内断言「零云调用」（拦截到的上游连接只指向本地 scripted 端点）。
- [ ] AC4：既有 `e2e/voice-realtime-scripted-scenarios.spec.ts` 退出 0。
- [ ] AC5：`npm run lint` 退出 0。

## DoD

三次运行的 Playwright 报告摘要与关键截图路径（`artifacts/`，不入 diff）写入 `## Notes`。

## Touches

- e2e/voice-realtime-intent-control.spec.ts (new)
- e2e/voiceRealtimeScriptedUpstream.ts（新增故障构件）
- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts（仅当共享构件在此）
- src/modules/chat/voice-realtime/audioSource.ts（仅当需暴露测试 seam）
- tasks/gap-live-voice-intent-control-browser-e2e.md

## Notes

立项：Opus 常驻架构会话，2026-10-12，人 yale 授权（GOAL-041 / AC-345）。依赖 AC-342、AC-343、AC-344。
