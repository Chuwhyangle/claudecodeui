---
id: gap-live-voice-continuous-experience-e2e-harness
title: 连续模式体验基线本地确定性 E2E：fake mic 时间线 + 声学 VAD 仿真 fake upstream + 模型策略，测
  X-1..X-7 读数（不改产品代码）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-scripted-upstream-protocol-state-machine
goal_ac: AC-361
---
## Proposal

### 背景与裁定

人 yale 2026-10-12：Live Voice 体验优先；模型决定何时输出 / 调用工具；VAD 只服务传输与 response 机会节奏，不承担业务断句。决策文档 `docs/proposals/live-voice-experience-first-decision-2026-10.md`（提交 `038730f0`）§3 定义了最小体验验收 X-1..X-7，§4 选定 continuous（上游 `server_vad`）为体验基线候选。**切换默认模式之前，必须先在本地确定性环境里测出当前 continuous 路径的基线读数**——本任务只建验证设施并取读数，**不改任何产品代码**。

### 现状（2026-10-12 复核）

- 假上游：`server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts` 与 `e2e/voiceRealtimeScriptedUpstream.ts` 都是命令式脚本，**不会根据收到的音频做 VAD**；AC-359（`gap-live-voice-scripted-upstream-protocol-state-machine`，本任务的前置）加入协议状态机（turn_detection、append/commit/response、转写策略）。
- fake mic：`src/modules/chat/voice-realtime/audioSource.ts` 的 `pacedFileAudioSource`（可注入时钟）；e2e 页面垫片 `window.__voiceFake.speak(seconds)`（见 `e2e/voice-realtime-segmented-replay-20261012.spec.ts` 与 `voice-realtime-live-session-send.spec.ts`）。
- 外联守卫：AC-360（已落地）。执行面：现有 voice e2e 夹具会话（单一共享夹具账号，spec 串行）。

### 要做的事

1. **声学 VAD 仿真**（在 AC-359 状态机之上）：`server_vad` 配置下按收到的 PCM16 做能量阈值检测，语音后静音 ≥ `silence_duration_ms` ⇒ `speech_started/stopped` + `committed` + 自动 `response.create`；**只送语音帧（丢静音）⇒ 不产生 `speech_stopped`**（决策文档 §5 推论的本地复现）。时钟由注入时钟驱动，不读墙钟。
2. **模型策略**：逐条目可配置——转发 `session_send`（文本取自脚本）、不转发、等待到下一次机会合并转发、`session_interrupt`、文本作答。
3. **fake mic 时间线**：确定性「语音 / 静音 / 背景噪声」时间线脚本（≥5 句、句间 0.3–3 s、含「嗯」类片段、句中 1–2 s 停顿后续说与修正），供 spec 播放。
4. **e2e spec** `e2e/voice-realtime-continuous-experience.spec.ts`：走**当前** continuous 代码路径（不改产品代码），执行面忙闲交替，产出 X-1..X-7 逐项读数表（写入任务 `## Notes` 与 spec 产物）。当前不达标项用 `expectKnownDefect` 错误签名记录（AC-357 已有该辅助），不得用 `test.fail` / `skip`。
5. 单 spec 时长 < 100 s（goal 判据 120 s 硬闸）；必要时在 AC-361 记录上声明 `timeoutMs`。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


- ⛔ 本任务不改 `server/modules/voice-realtime/` 的非测试文件与 `src/` 的产品文件；若当前代码在 continuous 下缺少可测接缝，记入 `## Notes` 并以 needs-human 停下，不得顺手改产品代码。

<!-- dedup-ref --> 机制去重（2026-10-12）：open 任务中只有 AC-359 涉及假上游协议，它不做声学 VAD 仿真与模型策略，本任务以 depends_on 建在其上；AC-345（意图控制浏览器验收）只覆盖打断类场景，不测连续体验基线。

## Plan

1. 在 AC-359 状态机上加声学 VAD 仿真与模型策略；L1 判据 `voice-realtime-fake-vad-upstream.test.ts`（含丢静音用例与墙钟取假形态）。
2. fake mic 时间线辅助与 e2e spec；本地连续跑 3 次比对读数。
3. 新测试文件同步 `server/shared/tests/quay-test-script.test.ts` 计数钉子与 `scripts/suite-duration-baseline.tsv`；`playwright.config.ts` 登记 spec 预算；`npm run typecheck`、`npm run lint`。

## AC

- [ ] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts` 退出 0；文件内「VAD 仿真改为按墙钟定时切分」的取假形态下丢静音用例必须红。
- [ ] AC2：同文件断言：语音后静音 ≥ `silence_duration_ms` ⇒ `speech_stopped`+`committed`+自动 response；只送语音帧 ⇒ 无 `speech_stopped`；模型策略五种取值各有一条用例。
- [ ] AC3：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 退出 0，且 spec 内无 `test.fail` / `test.skip` / `fixme`（不达标项走 `expectKnownDefect`）。
- [ ] AC4：X-1..X-7 逐项读数表写入 `## Notes`（每项：读数、是否达标、若不达标的缺陷签名与归因「我方 / 协议 / 未知」）。
- [ ] AC5：零外联（AC-360 守卫生效的读数）；同一种子连续 3 次读数一致（给出三次对照）。
- [ ] AC6：`npm run typecheck`、`npm run lint`、`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

本地真实浏览器 + 本地服务（不重启 :3001，用 e2e 自带实例）跑完连续体验 spec，X-1..X-7 读数表落盘；全程零云调用；产品代码 diff 为空（`git diff --stat develop -- server/modules/voice-realtime src` 只含测试文件）。

## Touches

- server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts（声学 VAD 仿真与模型策略）
- e2e/voiceRealtimeScriptedUpstream.ts（e2e 侧接入同一仿真）
- e2e/voiceRealtimeFakeMic.ts (new)
- e2e/voice-realtime-continuous-experience.spec.ts (new)
- playwright.config.ts（新 spec 预算登记）
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-live-voice-continuous-experience-e2e-harness.md

## Notes

立项：Opus 常驻会话，2026-10-12，人 yale 体验优先裁定（GOAL-044 / AC-361）。
