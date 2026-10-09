---
id: gap-ac315-voice-upload-orphaned-never-merged
title: 语音上传 + /voice-realtime 协议模拟（AC-315）已实现但从未合并：在当前 develop 上真正落地这条判据（两条命令 exit 0）
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

**背景（去重，非重新发现）**：`gap-voice-realtime-upload-audio-and-protocol-simulation`（status: done，goal_ac: AC-315）已经把这条判据完整实现并现场验证过：

- 新增 `src/modules/chat/voice-realtime/audioSource.ts`：把麦克风与文件上传统一成一个 `VoiceRealtimeAudioSource` 接口（`start(onFrame)`/`stop()`），`microphoneAudioSource()` 保留原 `getUserMedia`+`AudioWorklet` 逻辑，`fileAudioSource(file)` 走真实 `AudioContext.decodeAudioData` + 20ms 分帧；`useVoiceRealtimeSession` 的 `beginCapture`/socket 发帧对两条源不分叉。
- 新增 `e2e/voice-realtime-upload-fixture.spec.ts`：固定语料 WAV 经 `<input type="file">` 上传 → 真实解码/分帧 → `/voice-realtime` 代理 → fake 上游收到 >1 个 `input_audio_buffer.append` 帧后提议 `session_send` → 页面显示可编辑意图 → 编辑后文本落进 transcript（reload 仍可见）→ 模型原始提议文本不在 transcript。
- 新增 `server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`：5 个 offline 场景（chunk 时序 / 打断 / 断线 teardown / 并发 response 竞态 / 工具调用回填）。

实现 commit `19ed0cb2`，branch `task/gap-voice-realtime-upload-and-protocol-simulation`，worktree `.claude/worktrees/gap-voice-realtime-browser-e2e-current-session`（目录名陈旧，实际 checked out 的是该 branch）。

**本任务要解决的问题不是设计，是落地**：2026-10-09 核实 `19ed0cb2` 不是 `develop` 的祖先——从未合并进主线。证据：

- `git merge-base --is-ancestor 19ed0cb2 develop` 非 0；`git branch --contains 19ed0cb2` 只列出 `task/gap-voice-realtime-upload-and-protocol-simulation` 一条。
- 判据文件在 develop 上不存在：`git cat-file -e develop:e2e/voice-realtime-upload-fixture.spec.ts` 与 `develop:server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` 均 `fatal: ... does not exist`；`git ls-tree -r develop -- src/modules/chat/voice-realtime/` 为空。
- goal driver 在 evaluationRoot `/data/home/yale/work/claudecodeui`（develop）上评估 AC-315 → 第一条命令 `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` 因文件缺失报 `Error: No tests found` → exit 1。台账：`.quay/gate-events.jsonl` 里 AC-315 两次 `gate: goal` / `verdict: fail`（2026-10-09T06:00:58.852Z treeSha `6436fd89…`、2026-10-09T06:07:56.470Z treeSha `abb0fbf9…`），reason 均为 `No tests found`；`.quay/goal-round.jsonl` round 2222（2026-10-09T06:06:45Z）同读。

**为什么上一次「done」没成立**：上一次把「worktree 分支里两条命令跑绿」当成了完工证据，代码故意留在一个从 AC-312 `657e9ca7` 分出的新分支上（其 DoD 原文：「代码目前在新分支 `task/gap-voice-realtime-upload-and-protocol-simulation`…故意不落在 AC-312 自己的 `task/gap-voice-realtime-browser-e2e-current-session` 分支上」）。但 AC-315 的判据是在 develop 上评估的——未合并 worktree 上的绿不算数，判据文件在评估树上根本不存在，于是「No tests found」判红。判据的真假取决于评估树上的文件与读出，不取决于未合并分支。

**方案**：在当前 develop 上把这条判据真正落地。

1. 把 branch `task/gap-voice-realtime-upload-and-protocol-simulation` 的整条改动带进本任务的 worktree。`git merge-tree --write-tree develop task/gap-voice-realtime-upload-and-protocol-simulation` 返回 exit 0（无文本冲突），可直接 merge；但 develop 已从 merge-base `66bd8c89` 前进 14 个 commit 且 `server/modules/voice-realtime/` 模块已存在并有改动，必须逐文件复核语义冲突，重点 `server/index.ts`、`server/modules/voice-realtime/index.ts`、`vite.config.js`、`playwright.config.ts`、`server/modules/websocket/services/websocket-server.service.ts`。
2. 该分支同时携带 AC-312 的基线 `657e9ca7`（`useVoiceRealtimeSession.ts`/`VoiceRealtimeControl.tsx`/`voice-realtime-ws-proxy.service.ts`/`e2e/voice-realtime-live-session-send.spec.ts`）。这是必须的：AC-315 判据要求「上传与麦克风复用同一条 `useVoiceRealtimeSession` 管线」，没有这条基线判据无法成立。AC-312 自己的 `needs-human`（真实麦克风人工走查）不由本任务改变。
3. 在合并后的树上跑 AC-315 的两条判据命令，确认都 exit 0；若 develop 前进导致回归，就地修复（属本任务范围）。
4. 不得弱化判据：`fileAudioSource` 必须真实分帧（≥2 帧），不得退回不产帧的空实现；proxy 的单槽并发保护 `if (pending) throw …` 必须保留；`function_call_output` 回填必须保留。

<!-- dedup-ref --> **去重/粒度（2026-10-09）**：`task-granularity-advice.js` 对以上 Touches 只报一个 peer — `gap-mcp-session-send-reports-pending-interaction-it-queued-behind`（ready），仅共享大文件 `server/index.ts`，是另一条机制（MCP session_send pending interaction 上报），与本任务判据无交集；保持独立成案，不并入该 peer。

## AC

- [ ] AC1 两条判据命令逐字复跑均 exit 0：`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts && npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`；第一条输出 `1 passed`，第二条 `# tests 5 / # pass 5 / # fail 0`。
- [ ] AC2 第一条命令真的走上传路径、真的分帧：`e2e/voice-realtime-upload-fixture.spec.ts` 内含「上游收到的音频帧数 > 1」的断言（`grep -c 'audioFrameCount'` ≥1 且存在 >1 比较），且 spec 本身不调用 `getUserMedia`（`grep -c 'getUserMedia' e2e/voice-realtime-upload-fixture.spec.ts` = 0）；headless 无麦克风，第一条命令能过即证明执行路径未依赖 getUserMedia。
- [ ] AC3 编辑后的文本落进 transcript、模型原始提议不在 transcript：spec 内含对应断言（编辑文本出现在 transcript、reload 后仍可见、模型原始提议文本不出现），随 AC1 一起跑绿。
- [ ] AC4 第二条命令的并发竞态用例是可证伪的真断言：临时删掉 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 里的 `if (pending) throw …` 单槽保护 → 重跑第二条命令，「concurrent response race」用例在 2000ms `waitFor` 超时后失败；恢复该保护 → 重跑 `5/5 pass`。（现场执行并留输出。）
- [ ] AC5 工具调用回填未被弱化：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 仍发送 `function_call_output`（`grep -c 'function_call_output'` ≥1），且 AC1 的第二条命令里对应「工具调用回填」用例跑绿。
- [ ] AC6 范围受控：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`（合并会带入被合并分支的既存改动，允许；本任务自身新增/修改的文件必须全部在 Touches 内）。
- [ ] AC7 `npm run typecheck` exit 0（零新增类型错误）。

## DoD

真实落地标准，与上一次失败尝试唯一的区别在于：**拿「改动真的进入 develop」的台账证据，而不是只拿 worktree 上的 scoped 绿**。

① 本任务 worktree 内：AC-315 两条判据命令逐字跑绿（贴出第一条 `1 passed`、第二条 `# tests 5 / # pass 5 / # fail 0` 的输出），AC4 的取假形态现场复现（删保护 → 红 → 恢复 → 绿）并留输出。

② 真实 fan-in 台账：本任务分支经 fan-in 合并进 develop 后，`git merge-base --is-ancestor <本任务落地 commit> develop` 为真；随后 goal driver 在 develop 上重评 AC-315 → `pass`（即 `.quay/gate-events.jsonl` 出现 AC-315 `gate: goal` / `verdict: pass`，或 `.quay/goal-round.jsonl` 出现 AC-315 `status: achieved`）。若本会话内未能等到 fan-in 落地（`.git/fan-in.lock` 排队等），**如实声明只做到 ff-ready + scoped 绿这一步，不得假称已在 develop 上成立**。

③ 不弱化：AC4/AC5 的取假形态必须真的能红（证明断言不是摆设）。

**已知风险（现场发现，需本任务处置）**：两条 e2e spec 落地后，若无过滤地跑 `npm run test:e2e`（`playwright test` 全量），`voice-realtime-live-session-send.spec.ts` 与 `voice-realtime-upload-fixture.spec.ts` 会在同一共享 server 进程里各自注册硬编码用户名，而本仓认证是 single-user，第二个会 403——这是既有 single-user 设计与「每个判据只跑自己那一个 spec 文件」惯例的交叉产物，不是本任务引入的机制缺陷，但 AC-315 的两条命令本身不受影响（各跑各的文件）。`npm test`（`scripts/test.sh`：server + scripts + client vitest 阶段）不跑 e2e，故 fan-in 全量套件不受该碰撞影响；执行者需核实这一点并在完成记录中如实登记。

## Touches

- src/modules/chat/voice-realtime/audioSource.ts (new)
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts (new)
- src/modules/chat/voice-realtime/VoiceRealtimeControl.tsx (new)
- src/modules/chat/voice-realtime/index.ts (new)
- src/modules/chat/ChatInterface.tsx
- src/shared/api.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts (new)
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts (new)
- server/index.ts
- server/modules/websocket/services/websocket-server.service.ts
- vite.config.js
- playwright.config.ts
- e2e/voice-realtime-upload-fixture.spec.ts (new)
- e2e/voice-realtime-live-session-send.spec.ts (new)
- tasks/gap-ac315-voice-upload-orphaned-never-merged.md
