# 通知流（48h 回放，规则改写后：D1/D2/③ 开，release-rule=strict）

由 `node replay.mjs --out out` 生成于 out/notifications.jsonl；本表是它的逐行投影（**改写后 37 条**告警，
改写前为 59 条，前后对照见 RESULT.md §8.3）。证据列：`git <sha>` 在该项目仓库可 `git show`；
`<file>@<byte>` 可 `tail -c +$((byte+1)) <file> | head -1` 取回原记录。GT 列是结局派生标签（见 PREREG §评分）。

| ts (UTC) | 级别 | 规则 | 项目 | task | GT | 证据 | worker 会话 | 主目录会话提及 |
|---|---|---|---|---|---|---|---|---|
| 2026-10-08T17:30 | Notify | human-decision | claudecodeui | gap-ac153-criterion-wallclock-load-headroom | GT+ | git 0e281f24b6 | 6673a011 | 91 |
| 2026-10-09T00:00 | Notify | human-decision | claudecodeui | gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence | GT+ | git 6fa651c80e | 1c348c7c 554ea7ff | 25 |
| 2026-10-09T03:13 | Notify | cost-signal (failures=3) | claudecodeui | gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged | GT$ | claudecodeui/.quay/worker-outcome.jsonl@1732024 | 80592919 171625f6 +7 | 50 |
| 2026-10-09T04:53 | Notify | human-decision | claudecodeui | gap-voice-realtime-browser-e2e-current-session | GT+ | git 66bd8c89da | c3034175 4c9eb16e | 122 |
| 2026-10-09T06:22 | Notify | human-decision | claudecodeui | gap-voice-realtime-microphone-human-smoke-test | GT+ | git 32977e4665 |  | 36 |
| 2026-10-09T06:51 | Notify | cost-signal (failures=3) | claudecodeui | gap-mcp-session-send-reports-pending-interaction-it-queued-behind | GT$ | claudecodeui/.quay/worker-outcome.jsonl@1805134 | 598d02bf d15bb693 +6 | 93 |
| 2026-10-09T06:58 | Escalate | failure-streak (failures=3) | quay | gap-goal033-selfhost-and-archguard-evidence | GT+ | quay/.quay/worker-outcome.jsonl@4230125 | 034ebb38 f5065218 +2 | 40 |
| 2026-10-09T08:12 | Notify | human-decision | claudecodeui | gap-asr-wire-probe-ws-frame-false-positive | GT+ | git be1b641f8c | 5f73d69e c2bd7dfc +5 | 99 |
| 2026-10-09T09:29 | Notify | human-decision | claudecodeui | gap-goal-033-ac317-runnable-criterion | GT+ | git 0bdc0cde77 |  | 33 |
| 2026-10-09T09:38 | Escalate | failure-streak (failures=3) | claudecodeui | gap-asr-wire-probe-ws-frame-false-positive | GT+ | claudecodeui/.quay/worker-outcome.jsonl@1854875 | 5f73d69e c2bd7dfc +5 | 99 |
| 2026-10-09T10:22 | Notify | release-dependency-parked | claudecodeui | gap-quay-tab-loop-pulse-gantt-integration | GT+ | git 1cdcfb8155 | 2b968582 | 106 |
| 2026-10-09T11:02 | Notify | cost-signal (failures=3) | quay | gap-routine-semantic-dedup-scan-parse-args-handrolled-variants | GT$ | quay/.quay/worker-outcome.jsonl@4280195 | c69aabab 08f247f2 +2 | 24 |
| 2026-10-09T11:21 | Notify | cost-signal (failures=3) | claudecodeui | gap-debug-agent-simulates-permission-popup-for-mcp-e2e | GT$ | claudecodeui/.quay/worker-outcome.jsonl@1893106 | 67e73fab 3442d63b +8 | 97 |
| 2026-10-09T11:37 | Notify | cross-project-upstream-landed ← quay/gap-dashboard-kernel-not-packaged-in-plugin-artifact | claudecodeui | gap-quay-tab-loop-pulse-gantt-integration | GT+ | git 531d5fe8d5 | 2b968582 | 106 |
| 2026-10-09T11:43 | Notify | human-decision | claudecodeui | gap-ac315-upload-criterion-boot-race | GT+ | git a1fa372595 | 2088b3b4 | 79 |
| 2026-10-09T11:54 | Notify | failure-unrecovered (failures=1) | claudecodeui | gap-claudecodeui-scoped-self-test-and-concurrent-worker-sessions-bypass-resource-gate | GT+ | claudecodeui/.quay/worker-outcome.jsonl@1793722 | 5e63f1df | 111 |
| 2026-10-09T14:04 | Notify | failure-unrecovered (failures=1) | claudecodeui | gap-ac120-upload-input-locator-ambiguous | GT$ | claudecodeui/.quay/worker-outcome.jsonl@1839019 | 1eeb949e d0cb4ae5 +1 | 156 |
| 2026-10-09T16:24 | Notify | release-dependency-stalled (failures=1) | claudecodeui | gap-quay-tab-loop-pulse-gantt-integration | GT+ | claudecodeui/.quay/worker-outcome.jsonl@1878298 | 2b968582 | 106 |
| 2026-10-09T17:26 | Escalate | failure-streak (failures=3) | claudecodeui | gap-ac188-composer-stop-outlives-dock-idle | GT+ | claudecodeui/.quay/worker-outcome.jsonl@1941830 | aa9ee801 f63e3dd0 +3 | 91 |
| 2026-10-09T17:44 | Notify | failure-unrecovered (failures=1) | claudecodeui | gap-ac315-upload-criterion-boot-race | GT+ | claudecodeui/.quay/worker-outcome.jsonl@1912224 | 2088b3b4 | 79 |
| 2026-10-09T20:24 | Notify | failure-unrecovered (failures=1) | quay | gap-ownership-replay-benchmark-redesign-two-stage | GT- | quay/.quay/worker-outcome.jsonl@4302499 | 4b911dc1 | 19 |
| 2026-10-09T23:04 | Notify | failure-unrecovered (failures=3) | claudecodeui | gap-ac188-composer-stop-outlives-dock-idle | GT+ | claudecodeui/.quay/worker-outcome.jsonl@1934825 | aa9ee801 f63e3dd0 +3 | 91 |
| 2026-10-10T01:46 | Notify | human-decision | claudecodeui | gap-voice-segmented-relay-segmenter-relay-profile | GT+ | git 5a42d83fe6 | 49ae1634 089a6f3f +2 | 65 |
| 2026-10-10T02:21 | Notify | human-decision | claudecodeui | gap-goal-034-exit-conditions-section | GT+ | git f6f6739720 | c399a02a | 73 |
| 2026-10-10T02:55 | Escalate | failure-streak (failures=3) | claudecodeui | gap-voice-segmented-relay-segmenter-relay-profile | GT+ | claudecodeui/.quay/worker-outcome.jsonl@1986573 | 49ae1634 089a6f3f +2 | 65 |
| 2026-10-10T03:54 | Notify | human-decision | claudecodeui | gap-goal-033-ac317-runnable-criterion | GT+ | git 99c4e73ac1 |  | 33 |
| 2026-10-10T05:12 | Notify | human-decision | claudecodeui | gap-voice-segmented-relay-protocol-server-commit | GT+ | git 2e54b173e3 | 05035c65 ebded808 +1 | 63 |
| 2026-10-10T06:22 | Escalate | needs-human-expired | claudecodeui | gap-voice-realtime-microphone-human-smoke-test | GT+ | git 32977e4665 |  | 36 |
| 2026-10-10T06:39 | Escalate | failure-streak (failures=3) | quay | gap-release-workflow-definition-lags-one-release | GT+ | quay/.quay/worker-outcome.jsonl@4341195 | 06fddec6 ea6e9458 +2 | 34 |
| 2026-10-10T09:55 | Escalate | failure-streak (failures=3) | claudecodeui | gap-input-outline-classifies-turns-by-origin | GT+ | claudecodeui/.quay/worker-outcome.jsonl@2086106 | 744b5e3a 959f2709 +1 | 59 |
| 2026-10-10T10:03 | Escalate | failure-streak (failures=3) | claudecodeui | gap-voice-segmented-relay-client-wiring | GT+ | claudecodeui/.quay/worker-outcome.jsonl@2089739 | d3caf6fd ac3bd4b0 +3 | 79 |
| 2026-10-10T10:11 | Notify | human-decision | claudecodeui | gap-session-host-control-lease-gate-rest-parity-followup | GT+ | git a7af89051f | 2e95449e 7ec98981 +1 | 43 |
| 2026-10-10T10:14 | Escalate | failure-streak (failures=3) | claudecodeui | gap-with-memory-cap-default-adapts-to-effective-memory | GT+ | claudecodeui/.quay/worker-outcome.jsonl@2094717 | 9876c027 8b654f58 +2 | 58 |
| 2026-10-10T10:22 | Escalate | needs-human-expired | claudecodeui | gap-quay-tab-loop-pulse-gantt-integration | GT+ | git 1cdcfb8155 | 2b968582 | 106 |
| 2026-10-10T11:27 | Escalate | failure-streak (failures=3) | quay | gap-ac356-criterion-environment-fatal-window-check-unsatisfiable | GT+ | quay/.quay/worker-outcome.jsonl@4370603 | 97dacf13 ee9f47ac +3 | 33 |
| 2026-10-10T14:27 | Notify | failure-unrecovered (failures=3) | claudecodeui | gap-input-outline-classifies-turns-by-origin | GT+ | claudecodeui/.quay/worker-outcome.jsonl@2049064 | 744b5e3a 959f2709 +1 | 59 |
| 2026-10-10T16:39 | Notify | human-decision | claudecodeui | gap-goal-037-exit-conditions-section | GT+ | git a4612658b8 |  | 45 |
