---
id: GOAL-043
title: Live Voice 分段输入的条目归属与诚实状态：2026-10-12 五句话回放红先行，修 server_vad 被状态注入重开、转写按
  itemId 归属、逐段 heard/未识别/退出回填（模型可不转发，不自动补发）
status: achieved
kind: goal
origin: 人 yale 2026-10-12 授权（Opus 常驻会话 live voice 五句话测试复盘，journal
  ef9daacd-9950-414a-acfc-aace142bf273）；裁定：模型可不转发、禁止自动补发、晚到非缺陷。同日人 yale 将活跃 GOAL
  上限调到 5 后激活。
activatedAt: 2026-10-12T08:26:34.157Z
statusLog:
  - at: 2026-10-12T08:26:34.157Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-20T16:12:12.861Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

（状态说明：2026-10-12 立案时活跃 GOAL 已达上限 3，先以 draft 落库；同日人 yale 将上限调到 5（`.quay/config.yml` goals.cap，提交 e0af9310）后激活。）

2026-10-12 07:47–07:49Z 人 yale 用 Live Voice（segmented-v1 手动提交）对常驻会话连说五句：「这是一轮新的 Live Voice Mode 测试」「现在是第二句话」「第三句话」「第四句话」「上面我们看见丢了一句话」。只有第一句和最后一句到达 Claude；退出后 composer 被回填「现在是第二句话。第四句话。」；「第三句话」从未出现在任何字幕里（journal ef9daacd…）。

复盘读到的机制（代码已核对）：

- 状态注入经 bridge.sendSessionUpdate 发出的完整 session.update 由 voice-realtime-dashscope-transport.ts 的 toDashscopeFrames 以 {...sessionDefaults} 组装，携带 turn_detection: server_vad；ensureManualVadOff（voice-realtime-bridge.service.ts）每个 socket 只发一次 turn_detection:null。于是 seq0 送达后的第一次状态注入就把上游 VAD 重新打开：之后每次手动提交后都出现 speech_started，seq1/seq6 提交报 buffer too small，response.create 多次无回应。
- voice-realtime-ws-proxy.service.ts 的 onCaption 用到达时的 activeSegmentSeq 归属最终转写（segmentTranscriptEmpty、markSegmentEmpty、held delivery 释放），而不是用上游 itemId；Realtime 输入输出都是流式、延迟不确定，晚到的转写会被记到下一段。
- 前端没有逐段的「未识别」标记；用户主动退出时连关闭痕迹都没有，没有转写的话静默消失。

用户裁定（2026-10-12）：Realtime 模型可以不转发部分输入，「第三句话」被模型丢掉可以接受；转写晚到本身不是缺陷；绝不实现「有转写就自动补发 Claude」。要的是归属正确与状态诚实。

## 范围

- AC-352：先用 scripted fake 上游 + debug-agent + 假麦克风建立这次会话的确定性 Playwright 回放，缺陷腿以 test.fail 标注、指向修复任务（红先行）。
- AC-353：分段手动模式下所有完整 session.update 都带 turn_detection:null，journal 记录取值。
- AC-354：转写/分段按 itemId 归属，晚到不污染当前段，提交被拒与上游自建条目诚实标注，向浏览器下发 seq↔itemId。
- AC-355：前端逐段诚实状态（说话顺序、未转发保持 heard、未识别原位标记、退出按序回填与关闭痕迹）。
- AC-356：回放收口，无预期失败/已知缺陷腿。
- 本地验证基建（2026-10-12 人 yale 追加授权：可控、完全本地、不依赖外部 Realtime/Claude 服务）：AC-357 缺陷腿按特定错误签名判定（expectKnownDefect，去掉 test.fail）；AC-358 节奏改为事件/有界状态同步；AC-359 scripted fake 上游协议状态机（turn_detection、append/commit/response、晚到/乱序/缺失/失败转写、断连/cancel）；AC-360 本地封闭性守卫（外连 0、无 key、debug-agent 代 Claude、本地认证）。

## 非目标

- 不自动把模型未转发的转写补发给 Claude（用户明确禁止）。
- 不改 Realtime 模型提示词去「强迫」转发；不把转写延迟当缺陷去压缩。
- 不触碰 GOAL-041（A+ 意图控制）的语义：中断、栅栏、队列深度、撤回；与其共用 ws-proxy 的任务串行于其后。
- 不重启 :3001、不发布；修复上线需人工 build/restart。

## 退出条件

（口径：下列各条逐条对应 GOAL-043 的一个在域 AC，由该 AC 的 criterion 机械判定。）

1. AC-352：回放 spec 在 develop 上确定性运行（两次红绿集合相同），零云调用。
2. AC-353：手动模式 session.update 不再重开 server_vad。
3. AC-354：itemId 归属正确，且模型未转发的转写投递次数恒为 0。
4. AC-355：逐段诚实状态与退出按序回填。
5. AC-356：回放 spec 不含任何 test.fail/fixme/skip/expectKnownDefect 且全部通过。
6. AC-357：缺陷腿只在预期错误签名下通过，任意其他失败或缺陷消失即红。
7. AC-358：固定等待 ≤3 处且有书面理由，回放单次运行通过。
8. AC-359：假上游协议状态机自测通过，回放变体 R 由状态机自然复现空缓冲链。
9. AC-360：回放运行期间服务端与浏览器外连为 0。
10. AC-365：双断线本地确定性红先行：scripted upstream 故障注入 F1–F6 + 已知缺陷签名 D1–D6 在当前代码上精确复现。
11. AC-366：重连语义：pending commit 以 socket epoch 为作用域并在断线时转 uncertain、按段重放预算、成功打开后复位重连计数、ACK 分级 written·committed·lost。
12. AC-367：逐段 uncertain/lost 诚实状态（与 AC-355 的 heard/未识别同一处置）。
13. AC-368：双断线浏览器验收。
14. AC-369：真实上游大帧 vs 分块 append 探针报告读数齐全（证实 / 否证 / 不足以判断）。
15. AC-370：双断线已知缺陷签名精确到实际值（夹具自身出错不得被判为已知缺陷复现）。

## 非 AC 门（2026-10-15 人 yale 裁定：以下两条不计入上方「退出条件」的 AC 覆盖要求）

- H1 人工复测：一次真实 Live Voice 复测（人工，五句话同形）中不再出现手动提交后的 speech_started 与 buffer too small；未复测时不得据此宣称真实链路已修复。（非 AC 人工门，由人现场复测确认，⛔ 不另立同模真实上游 AC。）
- D1 压力读数：AC-358 的「固定等待 ≤3 处」在 CPU 压力下逐用例结果不变，由 AC-358 的任务 DoD 读数覆盖。

## 范围增补（2026-10-13，双断线 journal e22ac831）

AC-365（故障注入与红先行，只改测试）、AC-366（epoch 作用域 commit 配对、按段重放预算、重连计数复位、ACK 分级 written/committed/lost）、AC-367（浏览器 uncertain/lost 诚实状态）、AC-368（Playwright 双断线验收）、AC-369（真实上游大帧 vs 分块探针，验证或否证 RC-5）。不变量见 docs/proposals/live-voice-architecture-review-2026-10.md §14。退出条件同步要求：AC-365..AC-368 判据通过、AC-369 报告读数齐全，且按段至多一次投递与不自动补发保持。
