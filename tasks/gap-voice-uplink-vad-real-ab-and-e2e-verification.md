---
id: gap-voice-uplink-vad-real-ab-and-e2e-verification
title: 上行 VAD 的生产验证：同源 PCM A/B、重连跨 idleRotateMs、长静音存活、主动退出四条真实场景 + Playwright（显式
  arm）+ fast module tests 证明默认关时逐字节不变
status: todo
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-voice-uplink-vad-production-seam
---
## Proposal

对已接线（默认关）的上行 VAD 做**同源 A/B 回归与端到端验证**，并把「默认行为逐字节不变」证成可复跑的读数而不是声明。

**要覆盖的四类场景**（用户验收 4、5 两条）：

1. **同源 PCM A/B**：同一段真实语料、同一窗口、同一会话体，A=完整 PCM、B=过滤后的 PCM，逐项对比。
2. **重连**：过滤期间的**连接存活**与上游池的活动时钟（`noteLocalActivity` / `idleRotateMs`）—— 这是删帧最容易踩断的一根线。
3. **长静音**：静音段不发送时连接是否存活；已知实验读数 TEN 曾有 11.48 s 零发送而连接未断，需在**生产路径**上复现一次。
4. **主动退出**：用户动作触发的 `commit` + `response.create` + 有界等待。

**默认不变的回归**（用户验收 5）：默认关时老链路逐字节不变，用 fast module tests 断言送出的帧序列与今天逐帧逐字节相同。

**已有的可复用设施（不要另造）**：

- 真实上游 A/B：`experiments/voice-realtime-vad-three-arm/probe.mts` 的 `--vad-filtered` 路径（已实测过三轮，含退出顺序与费用上限）。
- Playwright 假上游：`e2e/voice-realtime-continuous-experience.spec.ts` 的 `upstream.armVad({...})`（脚本化上游 + 声学检测器）。
- fan-in suite **不含** Playwright e2e（本仓既有实测结论）⇒ e2e 腿必须**自带命令**并单独跑出读数。

## Plan

1. 真实上游同源 A/B：复用探针，窗口沿用 0–45000 ms 以便与既有三轮读数直接对照；给出上行帧/字节与占比、transcribed、forwarded（含文本）、遗漏、首 `function_call` 延时、上游错误、连接存活、最长无发送间隔、花费。
2. **重连腿**：在过滤开启下跨越一次 `idleRotateMs`；断言上游池**没有**因删帧而轮换（读数：轮换次数、`touch()`/`noteLocalActivity` 计数）。
3. **长静音腿**：构造 ≥30 s 连续非语音，断言连接存活且无被对方关闭（对照既知 ~304 s 上游无接收被关闭的界）。
4. **退出腿**：用户动作触发，断言顺序与"退出前后不丢"；若本窗口 5 条转写全在退出前到达（既有实测如此），**必须另挑一个"语音结束后立即退出"的窗口**才能真正验证救回 —— 否则如实写明"顺序不变式成立、救回未观测"。
5. Playwright：在既有 spec 上**显式 arm 新的上行 VAD** 后断言其可见行为；⛔ 未 arm 就抄既有的 `vad()` 等待 ⇒ 该腿无效。
6. fast module tests：默认关时帧序列逐字节不变；开时首段丢弃/开头 a 保留/短停顿保留。
7. 经 Provider ABI 逐条勾选后退出，由 worker-driver 机械 fan-in 落地。

## AC

- [ ] AC1 同源 A/B 四类读数齐备（帧/字节/占比、transcribed、forwarded 含文本、遗漏、首 call 延时、上游错误、连接存活、最长无发送间隔、花费），并与既有三轮读数可对照。
- [ ] AC2 **重连腿**：过滤开启下跨越 `idleRotateMs`，给出轮换次数与 `noteLocalActivity` 计数；⛔ 出现因删帧导致的轮换 ⇒ 红。
- [ ] AC3 **长静音腿**：≥30 s 连续非语音下连接存活，给出读数；若被关闭，给出关闭方与时刻。
- [ ] AC4 **退出腿**：顺序 `commit → response.create → 有界等待 → 关闭` 被断言；**若未能构造出"语音结束后立即退出"的窗口，必须写明"救回未观测、只有顺序不变式"**，⛔ 不得把它写成已验证。
- [ ] AC5 Playwright 腿：`## Evidence` 给出 arm 了新 VAD 的读数与该腿的**确切命令**；⛔ 未 arm 的腿不算。
- [ ] AC6 **默认逐字节不变**：默认关时同一串帧的送出序列与改动前逐帧逐字节相同（给出前后对照）。
- [ ] AC7 费用上限：单次连接 ≤ ¥0.05、本任务总计 ≤ ¥0.20；写出实际花费与时长。
- [ ] AC8 不改生产配置（`VOICE_REALTIME_SILENCE_TAIL` 仍关、新开关仍默认关）、不重启 :3001（前后 pid 相同，写出读数）。
- [ ] AC9 数据不外传：除上游 realtime 端点外零外联；给出读数。

## DoD

上行 VAD 的四类真实场景（同源 A/B、重连、长静音、主动退出）各有可复算读数；默认关时老链路逐字节不变被实测证明；Playwright 腿真的 arm 了新门控；退出路径若无法构造救回场景则如实标记未观测；生产配置未被打开、服务未被重启。

## Touches

- experiments/voice-realtime-vad-three-arm/probe.mts
- e2e/voice-realtime-continuous-experience.spec.ts
- server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts
- docs/operations/voice-vad-filtered-pcm-upstream-replay.md
- tasks/gap-voice-uplink-vad-real-ab-and-e2e-verification.md

## Notes

**依赖**：被验证的实现是 `gap-voice-uplink-vad-production-seam` 接好的缝（`depends_on` 已设该边）。

**已知陷阱（本仓实测记录）**：未 arm VAD 的 Playwright 腿不能抄既有的 `vad()` 等待；`e2e/voice-realtime-continuous-experience.spec.ts` 用的是脚本化上游，arm 是可观测行为的前提。

**不做**：不打开生产配置；不重启服务；不重跑离线五方案对比。