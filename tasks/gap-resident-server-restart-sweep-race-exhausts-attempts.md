---
id: gap-resident-server-restart-sweep-race-exhausts-attempts
title: resident-server-restart.test.ts 的 SIGKILL-residue 腿在高并发 lane 下三次重试仍读
  swept=0，连续阻塞 fan-in（gap-debug-agent-simulates-permission-popup-for-mcp-e2e 连红
  5 次、gap-asr-wire-probe-ws-frame-false-positive 红 2 次后才落地）——让该腿对 host-wide
  孤儿清扫竞态确定性免疫
status: todo
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
