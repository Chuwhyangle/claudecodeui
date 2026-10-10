---
id: gap-voice-segmented-relay-protocol-server-commit
title: P1b 服务端分段协议与提交：segment_start/audio(seq)/segment_end 帧、段尾 commit +
  response.create、seq 幂等重放、诊断报告含 segments 与 audioSecondsUpstream；旧连续协议不变
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-segmented-relay-p0a-commit-rotation-context
  - gap-voice-realtime-test-files-restore-quay-test-script-pins
goal_ac: AC-319
---
## Proposal

<!-- dedup-ref --> 去重检查（2026-10-10）：服务端 `/voice-realtime` 代理、桥、传输、诊断接口都已存在（commits 见 SPEC 附录），本条是在其上**新增**一种帧协议与提交方式，不是新机制重做；与 P1a（浏览器纯函数）、P1c（浏览器接线）分文件，互不相交；`depends_on` P0a 是因为 S1（音频手动提交是否可用）的 verdict 决定提交方式。

来源：SPEC「C1 / 协议」「提交方式」「失败模式」。

### 方案

1. **帧协议**（`readVoiceRealtimeInboundFrame` 扩展）：`segment_start{seq,startedAtMs}`、`audio{audio,seq}`（带 `seq` 的属于该段）、`segment_end{seq,durationMs,reason}`；不带 `seq` 的旧 `audio` 帧走原有连续路径，行为不变。出站新增 `segment_ack{seq,state:'committed'|'dropped',reason?}`。
2. **提交**（取决于 P0a-S1）：
   - S1 为 `supported`：`session.update` 里 `turn_detection: null`，`segment_end` 时依次 `input_audio_buffer.commit`、`response.create`（传输的 `respondToToolOutputs` 与收尾一句保持现状）。
   - S1 为 `unsupported`：回退——保持服务端 VAD，段内持续送帧，段间只送不超过 `commitGapMs` 的真实静音；`segment_ack` 在对应的 `transcription.completed` 到达时发出。回退路径必须有同样的测试覆盖，并且在代码里是一个可切换的实现而不是注释。
3. **幂等**：每段有 `seq`；上游在段提交后断开 → 桥重连后按 `seq` 重放一次，投递侧用 `seq` 去重，会话里只出现一条消息。
4. **诊断**：报告新增 `segments[]`（序号、时长、提交方式、合并原因、`ack` 状态）与 `audioSecondsUpstream`（实际写到上游 socket 的音频秒数）；`scripts/voice-realtime-diagnose.mjs` 打印它们，并加 `--segments` 开关用 `voiceLiveSegmenter` 的 relay 档在脚本侧切分 WAV 后发段协议（让 HTTP 层也能走这条路，不依赖浏览器）。
5. 日志：每段一行 `segment seq=… dur=…ms reason=… frames=…`，带时间戳。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-segmented-protocol.test.ts` 退出码 0
- [x] 只发语音：200 秒、含 4 句话的录音经段协议送往假上游，上游收到的音频 ≤ 25 秒；同一录音走旧连续协议的行为与改动前逐帧相同（既有 `voice-realtime-ws-proxy.protocol-simulation.test.ts`、`…real-transport.test.ts`、`…replay.test.ts` 不改动仍通过）
- [x] 提交顺序：每个 `segment_end` 在上游恰好产生一次 `commit` 与一次 `response.create`，且 `commit` 在该段最后一个 `append` 之后
- [x] 幂等：在 `commit` 之后、`response.done` 之前注入上游断开，重连后该段被重放一次，投递的 `session_send` 恰好一条
- [x] End/Mute：收到 `{type:'close'}` 或 socket 关闭时，已收到 `segment_start` 但未 `segment_end` 的段按「已收到的帧」提交一次，不丢最后一句
- [x] 回退路径（S1 不可用）：同一套用例在回退实现下全部通过（测试用参数化跑两种实现）
- [x] HTTP 诊断：`POST /api/voice-realtime/diagnose` 的报告含 `segments`、`audioSecondsUpstream`；`node scripts/voice-realtime-diagnose.mjs --segments …` 在假上游下打印每段的 seq/时长/ack
- [x] 取假形态各自必须变红：去掉 `seq` 去重 → 幂等用例红；`commit` 早于最后一个 `append` → 提交顺序用例红；去掉关闭冲刷 → End 用例红
- [x] 新增服务端测试文件后 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出码 0（同步钉子与基线）
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：**真实 DashScope 上游**至多一次确认运行（预算 ≤ ¥0.01，估算由 `estimateRealtimeCostCny` 与记录，需 yale 授权的运行已由 GOAL-034 的 origin 覆盖）：用 `--segments` 把 `zh-d01` 经段协议发往真实上游，报告里 `answered=true` 且 `audioSecondsUpstream` ≤ 原片长，把报告 JSON 存为 `server/modules/voice-realtime/tests/fixtures/real-run-segmented-zh-d01.json`（供回放测试使用）。其余全部用假上游，不得在 CI 路径里调用真实上游。

**已解除（2026-10-10，真实运行已完成）**：上一段记录的是当时的状态，现已不再成立——**这一次真实上游确认运行已经执行**，报告 JSON 逐字存为 `server/modules/voice-realtime/tests/fixtures/real-run-segmented-zh-d01.json`（未手改）。读数：`answered=true`、`heard=true`、`segments=2`（两段均 `commit=manual`、`commits=1`、`ack=committed`）、`audioSecondsUpstream=9.04` s ≤ 片长 12 s、`problems=[]`、`usage={responses:4, inputTokens:2666, outputTokens:70}`（按 SPEC 单价估算 ≈ ¥0.0043 ⇒ 在 ≤ ¥0.01 预算内）。⛔ 这一次运行已消费，**不要再跑真实上游**，只需核对上面这个 fixture 与读数。原阻塞的直接根因是 worker 的 worktree 里**没有 `.env`**（未被 git 跟踪、也不随 worktree 复制 ⇒ 服务进程读不到 `DASHSCOPE_API_KEY`，服务启动日志逐字：`No .env file found or error reading it: ENOENT: …/.claude/worktrees/<task>/.env`），且诊断路由在 `authenticateToken` 之后；完整复现配方见文末 `## 复现配方（真实上游确认运行）`。10 条 AC 的假上游验证不受影响（见上方 AC 段）。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/voice-realtime-diagnose.service.ts
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/tests/voice-realtime-segmented-protocol.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-diagnose.test.ts
- server/modules/voice-realtime/tests/fixtures/real-run-segmented-zh-d01.json (new)
- scripts/voice-realtime-diagnose.mjs
- docs/operations/voice-realtime-test-stages.md
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-voice-segmented-relay-protocol-server-commit.md

## 复现配方（真实上游确认运行，2026-10-10 实测走通）

worker 的 worktree 里拿不到 `.env`，而诊断路由在 `authenticateToken` 之后 ⇒ 「起一个已认证的真服务」这一步是原先卡住的地方。
下面每条都在任务 worktree 内实测执行过（cwd = 该 worktree）：

```bash
# 1. 副本 DB + 空闲端口起真服务。⛔ 不碰 ~/.cloudcli/auth.db 活库；⛔ 不占 3001（常驻服务）
mkdir -p ~/voicerun && cp ~/.cloudcli/auth.db ~/voicerun/auth.db
set -a; . /data/home/yale/work/claudecodeui/.env; set +a   # .env 只有 7 个键，无 JWT_SECRET
export DATABASE_PATH=$HOME/voicerun/auth.db SERVER_PORT=54891 HOST=127.0.0.1 VOICE_REALTIME_SEGMENT_COMMIT=manual
npm run server:dev &        # 等 `ss -ltn` 出现 :54891

# 2. 一次性主体令牌（mint-token 自建 observer-<ts> 用户；用完 revoke 即删行）
node scripts/mint-token.mjs mint  --db $HOME/voicerun/auth.db --out $HOME/voicerun/token
node scripts/mint-token.mjs probe --token-file $HOME/voicerun/token --base-url http://127.0.0.1:54891

# 3. 那一次付费运行（dry：不投递给任何会话）。--segments 要求单声道 16 kHz PCM16 WAV，段数 ≤ 8
node scripts/voice-realtime-diagnose.mjs --url http://127.0.0.1:54891 \
  --token "$(cat $HOME/voicerun/token)" --session <任意非空串> \
  --wav experiments/voice-trim/fixtures/zh-d01-o85.wav --segments --json > report.json

# 4. 收尾：撤销主体 + 停临时服务（3001 常驻服务不动）
node scripts/mint-token.mjs revoke --db $HOME/voicerun/auth.db --token-file $HOME/voicerun/token --base-url http://127.0.0.1:54891
```


## Evidence

- 2026-10-10 扇入 `step=suite` 红：`server/modules/providers/tests/claude-sessions.test.ts` → `AssertionError [ERR_ASSERTION]: open-a.jsonl was opened by a scan that should have skipped it`（用例 `a scan does not open the transcripts its cursor excludes`）。该文件**不在本任务 Touches/diff**，delta-relatedness = UNRELATED，且非 @load-sensitive。
- 复跑分类（同一族第 4 次；前三次 2026-10-06 / 2026-10-09 / 2026-10-10）：单文件 `30/30 exit 0`；`server/modules/providers/**` 模块在 `with-memory-cap.sh`（`QUAY_MEMORY_MAX=6G`、`--test-concurrency=8`）下 **454 tests / 450 pass / 0 fail（4 skipped）**。⇒ 负载时序 atime 抖动，非本任务回归。
- 本分支 delta 仅 voice-realtime 分段协议相关文件；未改动该测试文件。已 `git merge --no-edit develop`（进到 8e6745af，无冲突），重新退出交由驱动重跑 fan-in。