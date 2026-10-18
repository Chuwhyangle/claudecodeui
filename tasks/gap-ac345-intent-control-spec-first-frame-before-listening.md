---
id: gap-ac345-intent-control-spec-first-frame-before-listening
title: AC-345 判据红：arming 相位落地后本 spec 仍在首帧前等 listening——fake worklet 从不推帧，25 s 停在
  arming；适配首帧探针（只改测试）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-345
---
## Proposal

**判据现状（2026-10-18 直测，不是台账尾巴）**：AC-345 的判据

```
f=e2e/voice-realtime-intent-control.spec.ts
[ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }
DASHSCOPE_API_KEY= npx playwright test "$f"
```

退出 1，wall clock 40969 ms。用例 1（`spec.ts:912`）在 `openHeldRun` 的
`waitForPhase(page, 'listening')`（`spec.ts:472` → `:427`）轮询 25 s 后报
`Expected: "listening" / Received: "arming"`；其余 7 个用例因 serial 模式未运行
（`1 failed / 7 did not run`）。

**归因（确定性，与负载无关）**：`c99a0eaba`（2026-10-18 02:16 UTC，"add an arming phase until the
first captured frame"）把 `listening` 改为「首个采集帧到达之后」才成立
（`useVoiceRealtimeSession.ts:1305-1318`、`:1538-1541`）：上游 `state: open` 只到 `arming`。
但本 spec 的 `installFakeAudioGraph`（`spec.ts:562-600`）只造了惰性的 `FakeWorkletNode`——
`port.onmessage` 永远没有人调用，因此 `start()` 虽 resolve、`captureReady` 永远为 false，
相位停在 `arming`。`c99a0eaba` 只新增了它自己的
`e2e/voice-realtime-capture-ready-status.spec.ts`，没有适配本 spec。时间线吻合：
AC-345 最后一次通过 `2026-10-18T01:42:52Z`，`c99a0eaba` 于 02:16Z 落地，首次红 `11:13Z`。

**为什么此前的修复没有兜住**：此前 5 个 `goal_ac: AC-345` 任务（含用例 1 的重锚 `4f18537b1`）
都在 arming 相位落地之前完成；它们修的是 relay / 合并卡 / 跨度守卫，不涉及「首帧」这一新契约，
所以 `c99a0eaba` 之后判据从最后一次绿直接翻红。

**修法（只改测试，不改产品）**：沿用同族已落地做法——
`gap-continuous-experience-arming-phase-before-first-frame`（done）在另一个 spec 里用
`playFakeMic` 在等 `listening` 之前推首帧；`e2e/voice-realtime-capture-ready-status.spec.ts`
（`c99a0eaba` 自带）给出可复用的探针形态：fake graph 保存 worklet node，spec 通过
`window.__…Probe.pushFirstFrame()` 直接向 `port.onmessage` 投一帧 PCM。本任务在
`installFakeAudioGraph` 里保存最近构造的 node（仅当 `onmessage` 已接线时才可推），新增
`pushFirstCaptureFrame(page)` 帮助函数，并在三个 `waitForPhase(page, 'listening')` 之前各推一帧：
`openHeldRun`（`:472`，覆盖大部分用例）、用例 2 的二次进入（`:1179`）、用例 8（`:1708`）。
同步修正文件头「nothing here pushes PCM」的过期说法。**不得**删除或弱化 `listening` 断言，
不得加 `test.skip` / `test.fail` / `fixme`，也不得把等待改成只等 `arming`。

<!-- dedup-ref --> 同族先例（均已 done，不是本任务的前置）：
`gap-continuous-experience-arming-phase-before-first-frame` 修的是 AC-361 的另一个 spec 文件；
`gap-live-voice-listening-before-capture-ready` 是产品侧新增 arming 相位本身。本任务只适配
AC-345 自己的判据文件，保持独立验收。

## AC

- [ ] AC1：`cd /data/home/yale/work/claudecodeui && f=e2e/voice-realtime-intent-control.spec.ts; DASHSCOPE_API_KEY= npx playwright test "$f"` 退出 0，输出 `8 passed`（不是 `1 failed / 7 did not run`），wall clock < 118000 ms（AC-345 记录声明的 timeoutMs）。
- [ ] AC2：`grep -c "test\.fail\|test\.skip\|fixme" e2e/voice-realtime-intent-control.spec.ts` 输出 0；`grep -c "waitForPhase(page, 'listening')" e2e/voice-realtime-intent-control.spec.ts` ≥ 3；`grep -c "pushFirstCaptureFrame" e2e/voice-realtime-intent-control.spec.ts` ≥ 3。
- [ ] AC3：落地 diff 相对 develop 只含 `e2e/voice-realtime-intent-control.spec.ts` 与本任务文件（`git diff --name-only develop...HEAD | sort` 逐行核对），没有产品代码改动。
- [ ] AC4：同一判据连续运行两次都退出 0，且各输出 `8 passed`（排除单次抖动）。
- [ ] AC5：全程 `DASHSCOPE_API_KEY` 为空；用例 1 既有的零云读数保留并通过（`upgradeHeaders` 无 `authorization`、页面无 loopback 以外的 WebSocket）。

## DoD

在真实浏览器 + 真实 app server + 脚本化上游上，`DASHSCOPE_API_KEY=` 的单文件判据连续两次退出 0，
八条用例逐条运行并通过：用例 1 在首帧推进后读到 `listening`，并完成忙时零逐句投递、唯一合并
pending 卡、enqueue-then-abort 的读数；用例 2–8 的原有读数全部恢复；零云调用断言仍是直接读数。
任务 `## Notes` 抄录两次运行的 `8 passed` 行与 wall clock，并注明只改测试、未动产品代码。

## Touches

- e2e/voice-realtime-intent-control.spec.ts
- tasks/gap-ac345-intent-control-spec-first-frame-before-listening.md
