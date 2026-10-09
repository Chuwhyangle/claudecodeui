---
id: gap-ac315-upload-criterion-second-upload-flake
title: 语音上传判据（AC-315）375px 第二腿 flake：WS 握手完成前整段 fixture 的帧被 beginCapture
  静默丢光、意图永不出现（第一条判据命令间歇 exit 1）
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

**现状（2026-10-09，本轮直接复跑）**：AC-315 有两条判据命令，要求都 exit 0：(1) `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts`；(2) `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`。现场核实：**第二条确定性绿**（连跑 4 次均 `tests 5 / pass 5 / fail 0`，exit 0）；**第一条间歇性红**（本机 8 次里约 2 次失败，~25%）。四个判据文件都已存在于 develop 上（`git cat-file -e develop:e2e/voice-realtime-upload-fixture.spec.ts` 等均 EXISTS；对应两条 done 任务已合并），所以这不是「文件缺失」，而是这条判据本身不确定。

**台账证据（同一 treeSha 上 pass→fail 翻转，证明是 flake 而非恒假）**：`.quay/gate-events.jsonl` 里 AC-315 在**同一 `treeSha: 7a6e50d7`** 上 2026-10-09T06:58:28Z `verdict: pass`（reason `acceptance passed (exit 0)`）、紧接着 2026-10-09T07:00:26Z `verdict: fail`（`acceptance failed (exit 1)`，evaluationRoot `/data/home/yale/work/claudecodeui`）。同一棵树两分钟内翻转，说明评估结果取决于运行时竞态而非代码内容。

**定位（本轮现场复现 + 浏览器侧 WS 帧计数 + onFrame 打点，打点已还原）**：

- 失败**永远**发生在第二个测试，即 375px 移动腿（`e2e/voice-realtime-upload-fixture.spec.ts:376`）：`uploadEditAndSend` 等 `getByTestId('voice-realtime-intent')` 可见，25s 超时，`element(s) not found`；失败时页面 `voice-realtime-phase` 卡在 `listening`，无 error 文本。
- 临时在 `useVoiceRealtimeSession.beginCapture` 的 onFrame 里打点（已用 `git checkout --` 还原）、并用 `page.on('websocket')` 计帧，取到失败运行的逐字日志：第二次上传 `[voice-diag] first frame produced; socket=0` → `frame#1 DROPPED; socket=0` → `frame#2 DROPPED; socket=0` → `frame#3 DROPPED; socket=0` → `source.start resolved; produced=30 dropped=30`，**其后才**收到 `voice ws recv#1`（即 state=open → phase 才变 `listening`）。同一次运行的第一次上传同点位是 `socket=1`、`FIRST frame sent`、`produced=30 dropped=0`。
- **根因**：`beginCapture` 的 onFrame 在 `socketRef.current.readyState !== WebSocket.OPEN` 时直接 `return`（`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts` 约 171-176 行，**静默丢帧**）；而 `fileAudioSource.start` 的帧间让步是**纯微任务** `await Promise.resolve()`（`src/modules/chat/voice-realtime/audioSource.ts:136`）。一次快速 `decodeAudioData` 之后，30 个 20ms 分块在**一条微任务链**里同步派发完毕，不让出宏任务；WS 握手（网络事件 = 宏任务）来不及推进到 OPEN，于是整段 fixture 在 socket 尚未 OPEN 时被逐帧丢光。第一次上传通常握手赢过解码；第二次（移动腿、缓存已热）常常输 → 间歇性红。
- **已排除的替代解释**：不是 `userActivation`（两次上传 `navigator.userActivation.hasBeenActive=true`）；不是 socket 未连上（WS trace 两次都是 `101 Switching Protocols`）；不是「微任务让步换成宏任务就能修」（把 `await Promise.resolve()` 改成 `await new Promise(r => setTimeout(r, 0))` 后 flake 仍 2/8——让步粒度只改赢面，不改「未 OPEN 即丢」这一事实）。

**方案（修在消费侧，不弱化判据、保持无麦克风）**：

1. `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts`：`beginCapture` 未 OPEN 时不再丢弃，而是压入 pending 队列；在 socket 进入 OPEN（`socket.onopen`，或收到首个 `state: open` 时）后**按序补发**队列，OPEN 之后的新帧直接 `send`。语义目标：帧要么送达代理，要么在 `stop()` 时明确失败，杜绝静默丢弃。
2. `src/modules/chat/voice-realtime/audioSource.ts`：作为辅助，把帧间让步从纯微任务改成让出宏任务（`setTimeout(…,0)` 或 `MessageChannel`），使短 fixture 的行为更贴近持续产帧的真实麦克风。**真正的修复是排队补发，不是让步**，两者都做只是让时序更稳。
3. `e2e/voice-realtime-upload-fixture.spec.ts`：把这条 flake 钉成回归断言——在 375px 腿里断言第二次上传送到代理的帧数 `upstream.audioFrameCount()` 相对第一次上传的**增量 > 1**（即第二次确实送达 >1 帧），使「整段被丢」必然红；必要时补一条「decode 后立即产出、OPEN 后补发」的时序断言。不改判据语义、不引入麦克风、不改两次上传的结构。
4. 判据文件路径与两条命令逐字不变。

**为什么上一次 done 没止住**：`gap-ac315-voice-upload-orphaned-never-merged` 的 DoD（其第 63 行）把本机观测到的两次失败归为「与改动无关的宿主机负载型 flake」，未取到浏览器侧根因；本轮在**低负载、同一 treeSha** 上复现出 `pass→fail` 翻转并定位到确定性的「握手前丢帧」竞态，说明它不是宿主负载，而是判据实现本身的竞态。

<!-- dedup-ref --> **去重/粒度（2026-10-09）**：更早的 `gap-voice-realtime-upload-audio-and-protocol-simulation`（done）与 `gap-ac315-voice-upload-orphaned-never-merged`（done）都声明 `goal_ac: AC-315`，但其产出（实现 + 合并进 develop）已落地而判据仍间歇性红——按「done 任务不构成 duplicate」规则本任务为新案，且上文已说明上一次修复为何没止住 flake。`task-granularity-advice.js` 对本 Touches 报 `peers: []`，`mentions` 只有 `gap-mcp-session-send-reports-pending-interaction-it-queued-behind`（ready，另一条机制：MCP `session_send` pending interaction 上报，仅顺带点名同一文件），保持独立成案、不并入。

## AC

- [ ] AC1 第一条判据命令在修复后连续多次 exit 0：`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` 连跑 ≥8 次全部 exit 0（贴出连跑汇总，如 `TOTAL_FAILS=0 / 8`），每次均 `2 passed`。
- [ ] AC2 丢帧竞态被真正消除而非只提赢面：375px 腿断言第二次上传送达代理的帧数相对第一次的增量 > 1（`upstream.audioFrameCount()` 或等价的逐连接帧计数）；把「OPEN 前排队补发」改回「未 OPEN 直接丢帧」时该断言/该腿必然红（取假形态现场复现并留输出）。
- [ ] AC3 判据不弱化、仍无麦克风：`grep -c getUserMedia e2e/voice-realtime-upload-fixture.spec.ts` = 0；上传路径仍真实分帧（`audioFrameCount() > 1`）；判据文件路径与两条命令逐字未变。
- [ ] AC4 第二条判据命令仍绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` exit 0，`tests 5 / pass 5 / fail 0`；proxy 单槽并发保护 `if (pending) throw` 与 `function_call_output` 回填均未被删。
- [ ] AC5 静态/类型检查：`npm run typecheck` exit 0，`npm run lint` exit 0，无新增 voice-realtime 相关告警。

## DoD

真实落地标准：

① 本任务 worktree 内：第一条判据命令连跑 ≥8 次全绿（贴出汇总输出）；AC2 的取假形态现场复现（把排队补发改回丢帧 → 该腿红 → 改回排队补发 → 连续绿）并留输出。

② 真实 fan-in 台账：本任务分支经 fan-in 合并进 develop 后，goal driver 在 develop 上重评 AC-315 → `pass`（`.quay/gate-events.jsonl` 出现 AC-315 `gate: goal` / `verdict: pass`，或 `.quay/goal-round.jsonl` 出现 AC-315 `status: achieved`）。若本会话内未等到 fan-in 落地（`.git/fan-in.lock` 排队等），**如实声明只做到 ff-ready + scoped 绿，不得假称已在 develop 上成立**。

③ 不弱化：AC2 的取假形态必须真的能红，证明新断言不是摆设。

## Touches

- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/audioSource.ts
- e2e/voice-realtime-upload-fixture.spec.ts
- tasks/gap-ac315-upload-criterion-second-upload-flake.md