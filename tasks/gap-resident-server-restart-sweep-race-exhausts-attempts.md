---
id: gap-resident-server-restart-sweep-race-exhausts-attempts
title: resident-server-restart.test.ts 的 SIGKILL-residue 腿在高并发 lane 下三次重试仍读
  swept=0，连续阻塞 fan-in（gap-debug-agent-simulates-permission-popup-for-mcp-e2e 连红
  5 次、gap-asr-wire-probe-ws-frame-false-positive 红 2 次后才落地）——让该腿对 host-wide
  孤儿清扫竞态确定性免疫
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->Related but distinct (all done, other mechanisms): gap-resident-server-restart-criterion-wait-headroom-under-lane-load, gap-resident-server-restart-budget-shorter-than-its-three-boots. Those widened waits/budgets; none addressed attempt exhaustion. Dedup search for "resident-server-restart" and "swept=0" across todo/ready/needs-human found no open owner. Merge decision: none found.

Measured facts (2026-10-09):
- driver_log (.quay/worker-outcome.jsonl): task gap-debug-agent-simulates-permission-popup-for-mcp-e2e fan-in outcome=red step=suite at 2026-10-09 11:08, 11:13, 11:21, 11:27 (+1 earlier) - every time the ONLY failing test of 446 is `server/modules/session-hosts/tests/resident-server-restart.test.ts: AssertionError: the next boot swept nothing in 3 attempt(s) (swept=0); the orphan was not there to reap` (suite log tail: tests 446 / pass 445 / fail 1). gap-asr-wire-probe-ws-frame-false-positive hit the same red at 10:12 and 10:22 and landed on the third try at 10:36. Each red burns a ~170s fan-in lock hold (lockHoldSecs 154-181), blocking every other lane's fan-in.
- Run alone on develop under load1≈27: `tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-server-restart.test.ts` passes in 23s, `sigkill-residue ... swept=1`. So the test is correct in isolation; the red is the race.
- Mechanism: server/modules/providers/services/claude-session-scope.service.ts `sweepOrphanResidentScopes()` (~L682) is HOST-WIDE by design (reaps every resident scope unit whose encoded owner pid is dead). With ~27 concurrent lanes each booting real servers (e2e webServers, other suites), a foreign boot reaps this test's orphan before its own next boot. The test (resident-server-restart.test.ts ~L117 SWEEP_ATTEMPTS = 3, loop ~L1099-1180) retries up to 3 times; at current fleet concurrency all 3 attempts lose the race.
- Production sweep semantics must NOT change (a live server's sessions untouched; orphans from SIGKILLed servers still reaped host-wide at boot).

Plan (worker chooses the least invasive, evidence-driven): (a) test-side only: make the leg robust without weakening the reading - e.g. race-free construction (keep the orphan's reap attributable to THIS test's third boot by shrinking the kill-to-boot window, or by asserting on the orphan's unit being gone plus a sweep log line naming it from EITHER this boot or provably a foreign boot, while a no-sweep build must still read red), and/or unbounded-in-time but bounded-in-cost retries; (b) only if (a) cannot be made deterministic, a narrowly scoped env-gated test seam in claude-session-scope.service.ts (default behaviour byte-identical). Must reproduce the red first under a load construction (e.g. N concurrent sweepers/real-server boots alongside the file) and record the baseline fail rate. Do not add a new server test file (quay-test-script pins the server test-file count).

## AC

- [x] AC1: baseline red reproduced under a recorded load construction (construction command + N + fail count recorded in the task notes) against the unmodified file.
- [x] AC2: after the fix, at least 10 consecutive runs of `tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-server-restart.test.ts` under the SAME load all exit 0, each output containing the sigkill-residue reading.
- [x] AC3: falsification: a build whose sweepOrphanResidentScopes returns [] (no sweeping) still turns the file red; record the mutation, the failing assertion, and revert it.
- [x] AC4: production semantics unchanged: server/modules/providers/tests claude-session-scope tests and session-hosts tests are green, and `git diff` shows no behavioural change to sweepOrphanResidentScopes unless route (b).
- [x] AC5: `npm run lint` and `npm run typecheck` exit 0, and the diff is confined to ## Touches.

## DoD

The resident-server-restart file no longer reds fan-in under lane load, proven by the AC2 load-construction runs on a real boot of real servers (not a mock of the sweep), and the AC3 no-sweep falsification still reds, so the sigkill-residue reading is not weakened.

## Touches

- server/modules/session-hosts/tests/resident-server-restart.test.ts
- server/modules/providers/services/claude-session-scope.service.ts (only if route (b))
- tasks/gap-resident-server-restart-sweep-race-exhausts-attempts.md (self)



## 会话外复核（2026-10-09 19:48，只读复现 + 台账登记，未改任何代码文件）
- **Proposal 里「alone on develop under load1≈27 时 23s 通过、swept=1」这一前提在当前 host 上不再成立**：同一命令 `tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-server-restart.test.ts` 连跑 3 次，**3/3 红**，每次输出 `sigkill-residue pid=… alive-at-next-boot=false swept=0` + `sigkill-attempt 1/3,2/3,3/3 read swept=0` + `AssertionError: the next boot swept nothing in 3 attempt(s) (swept=0); the orphan was not there to reap`（`tests 4 / pass 3 / fail 1`）。
- **现场环境读数**：`uptime` load average **58.02 / 39.47 / 36.59**（nproc=128，41 users），同时有 **4 个 `server/index.ts` 进程**在跑——每一个启动都会做 host-wide `sweepOrphanResidentScopes()`。即当前无需人工构造并发清扫者，真实 fleet 并发就足以让本腿 100% 输掉竞态。原 Proposal 的机制分析（foreign boot 先收割本测试的孤儿）与此完全一致，只是「隔离下绿」这一半已随 host 负载变化而翻转。
- **对 AC1 的影响（给执行者的建议）**：AC1 要求的「在记录在案的 load construction 下复现基线红」现在**更省事**——直接复跑即可红，不必额外起 N 个 sweeper；但记录时仍应把当时的 load average 与并发 `server/index.ts` 计数一并写下，否则这份红无法与「host 恰好很闲」的情形区分。
- 未修改 `server/modules/session-hosts/tests/resident-server-restart.test.ts` 或 `claude-session-scope.service.ts`：本任务 status=ready，按并发编辑纪律留给该任务自己的执行者。本条目仅为台账登记。

## Notes（执行记录 2026-10-09，worker）

**做法（route (a)，测试侧，未走 route (b)）**
该腿此前要求「本 run 的下一个 boot 自己读到 `swept>=1`」并最多重试 `SWEEP_ATTEMPTS=3`。但 sweep 是 host-wide 设计：任何 boot 都会收割所有 owner pid 已死的 scope，高并发下 foreign boot 抢先收割，本 run 三次都诚实地读 0 → 对非本 delta 的 fan-in 连续报红。改为读该腿真正要证的事实——「下一个 boot 之后，kill 留下的孤儿已被某个 boot 的启动 sweep 收割」：本 boot 收割（`swept>=1`，日志点名 unit）或并发 lane 的 boot 抢先收割（`swept=0`，孤儿已不在）。无 sweep 的 build 永远清不掉被 hold 的 in-flight 孤儿，仍在首个 boot 变红；「kill 确实留下残留」的正控仍是信后即读的 `sigkill survivor=true`。重试环已移除。

**AC1 — 基线红（记录在案的 load construction）**
- 构造命令：`/data/scratch/yale/sweep-race/run-under-load.sh <worktree> server/modules/session-hosts/tests/resident-server-restart.test.ts <out.log> 3`
- N = 3 个 sweeper lane，每个 lane 每 150ms 调用**真实的** host-wide `sweepOrphanResidentScopes()`（等价于其它 lane 的 real-server boot 在收割孤儿；非 sweep 的 mock）。
- 未修改文件下：**4/4 红**（1 次临场 + 3 次记录在案），每次都输出 `sigkill-residue pid=… alive-at-next-boot=false swept=0` + `sigkill-attempt 1/3,2/3,3/3 read swept=0` + `AssertionError: the next boot swept nothing in 3 attempt(s) (swept=0); the orphan was not there to reap`（tests 4 / pass 3 / fail 1）——与 fan-in 完全同一签名。
- host 环境：load average ~24-34（nproc=128，41 users），另有 4 个 `server/index.ts` 在跑。

**AC2 — 修复后 10 连跑（同一 load construction）**
- 10/10 exit 0，每次输出都含 `sigkill-residue pid=… alive-at-next-boot=… swept=…`；10 次 reaper 均为 concurrent-boot（`swept=0`，foreign sweep 抢先）。
- 隔离（无 load）跑该文件：exit 0，`sigkill-residue … swept=1`，`sigkill-residue-reaper this-boot swept=1` —— 两条路径都覆盖。
- AC2 字面命令 `tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-server-restart.test.ts`（无 preload）隔离跑 exit 0、`swept=1`。

**AC3 — 反证（no-sweep）**
- 变异：`claude-session-scope.service.ts` 的 `sweepOrphanResidentScopes()` 首行加 `return [];`。隔离跑该文件 → exit 1，失败断言：
  `AssertionError: the boot following the kill left the held in-flight orphan <pid> standing (swept=0, alive-at-next-boot=true): no boot's start-up sweep reaped the SIGKILL residue — a build whose sweep reaps nothing leaves it there`
  且同 run 里 `sigkill survivor=true`（杀后孤儿确实存在）。变异已 revert（`git diff` 对 service 文件为空）。

**AC4 — 生产语义未变**
- diff 仅含 `server/modules/session-hosts/tests/resident-server-restart.test.ts`。
- `server/modules/session-hosts/tests/*.test.ts` + `server/modules/providers/tests/claude-session-scope.test.ts`（with-memory-cap，concurrency=4）：tests 69 / pass 65 / fail 0 / skipped 4，exit 0。

**AC5 — lint / typecheck**
- `npm run lint` exit 0；`npm run typecheck` exit 0；diff 限于 ## Touches（测试文件 + 本任务文件）。
