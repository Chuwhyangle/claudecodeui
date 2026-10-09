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

- [ ] AC1: baseline red reproduced under a recorded load construction (construction command + N + fail count recorded in the task notes) against the unmodified file.
- [ ] AC2: after the fix, at least 10 consecutive runs of `tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-server-restart.test.ts` under the SAME load all exit 0, each output containing the sigkill-residue reading.
- [ ] AC3: falsification: a build whose sweepOrphanResidentScopes returns [] (no sweeping) still turns the file red; record the mutation, the failing assertion, and revert it.
- [ ] AC4: production semantics unchanged: server/modules/providers/tests claude-session-scope tests and session-hosts tests are green, and `git diff` shows no behavioural change to sweepOrphanResidentScopes unless route (b).
- [ ] AC5: `npm run lint` and `npm run typecheck` exit 0, and the diff is confined to ## Touches.

## DoD

The resident-server-restart file no longer reds fan-in under lane load, proven by the AC2 load-construction runs on a real boot of real servers (not a mock of the sweep), and the AC3 no-sweep falsification still reds, so the sigkill-residue reading is not weakened.

## Touches

- server/modules/session-hosts/tests/resident-server-restart.test.ts
- server/modules/providers/services/claude-session-scope.service.ts (only if route (b))
- tasks/gap-resident-server-restart-sweep-race-exhausts-attempts.md (self)



【2026-10-09 19:48 会话外复核（只读复现 + 台账登记，未改任何代码文件）】
- **Proposal 里「alone on develop under load1≈27 时 23s 通过、swept=1」这一前提在当前 host 上不再成立**：同一命令 `tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-server-restart.test.ts` 连跑 3 次，**3/3 红**，每次输出 `sigkill-residue pid=… alive-at-next-boot=false swept=0` + `sigkill-attempt 1/3,2/3,3/3 read swept=0` + `AssertionError: the next boot swept nothing in 3 attempt(s) (swept=0); the orphan was not there to reap`（`tests 4 / pass 3 / fail 1`）。
- **现场环境读数**：`uptime` load average **58.02 / 39.47 / 36.59**（nproc=128，41 users），同时有 **4 个 `server/index.ts` 进程**在跑——每一个启动都会做 host-wide `sweepOrphanResidentScopes()`。即当前无需人工构造并发清扫者，真实 fleet 并发就足以让本腿 100% 输掉竞态。原 Proposal 的机制分析（foreign boot 先收割本测试的孤儿）与此完全一致，只是「隔离下绿」这一半已随 host 负载变化而翻转。
- **对 AC1 的影响（给执行者的建议）**：AC1 要求的「在记录在案的 load construction 下复现基线红」现在**更省事**——直接复跑即可红，不必额外起 N 个 sweeper；但记录时仍应把当时的 load average 与并发 `server/index.ts` 计数一并写下，否则这份红无法与「host 恰好很闲」的情形区分。
- 未修改 `server/modules/session-hosts/tests/resident-server-restart.test.ts` 或 `claude-session-scope.service.ts`：本任务 status=ready，按并发编辑纪律留给该任务自己的执行者。本条目仅为台账登记。