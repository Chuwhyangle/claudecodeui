# 通知流（48h 回放，release-rule=strict）

由 `node replay.mjs` 生成于 out/notifications.jsonl；本表是它的逐行投影。证据列：`git <sha>` 在该项目仓库可 `git show`；`<file>@<byte>` 可 `tail -c +$((byte+1)) <file> | head -1` 取回原记录。GT 列是结局派生标签（见 PREREG §评分）。

| ts (UTC) | 级别 | 规则 | 项目 | task | GT | 证据 | worker 会话 | 主目录会话提及 |
|---|---|---|---|---|---|---|---|---|
| 2026-10-08T17:00 | Escalate | needs-human-expired | quay-fleet | gap-pwa-ac077-antishadow-control-splice-exact | GT+ | git 77759c5867 |  | 0 |
| 2026-10-08T17:00 | Escalate | needs-human-expired | quay | gap-retire-needs-human-cause-enumeration | GT+ | git 2400cfa449 |  | 4 |
| 2026-10-08T17:00 | Escalate | needs-human-expired | claudecodeui | gap-server-phase-concurrency-clamp | GT+ | git 7c6e5ea29c |  | 71 |
| 2026-10-08T17:00 | Escalate | needs-human-expired | quay-fleet | gap-ac014-duplicate-sessionkey-from-resume | GT+ | git 4393286d3d |  | 0 |
| 2026-10-08T17:00 | Escalate | needs-human-expired | quay-fleet | gap-ac009-criterion-transient-cli-unavailable | GT+ | git 61befd1b7a |  | 0 |
| 2026-10-08T17:30 | Notify | human-decision | claudecodeui | gap-ac153-criterion-wallclock-load-headroom | GT+ | git 0e281f24b6 | 6673a011 | 66 |
| 2026-10-09T00:00 | Notify | human-decision | claudecodeui | gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence | GT+ | git 6fa651c80e | 1c348c7c 554ea7ff | 22 |
| 2026-10-09T00:06 | Notify | human-decision | claudecodeui | gap-voice-realtime-dashscope-transport-harness | GT+ | git 09faef7e22 | fadad534 d345137a +1 | 45 |
| 2026-10-09T02:37 | Notify | human-decision | claudecodeui | gap-ac140-dashscope-public-host-second-copy | GT+ | git b63c9b0c2a | bc29efb3 5c2c4201 +1 | 132 |
| 2026-10-09T02:48 | Notify | human-decision | quay | gap-direct-to-develop-bypass-check-git-fixture-cost | GT+ | git 01eba64707 | 42de3790 a1dcd7a8 | 31 |
| 2026-10-09T03:13 | Escalate | failure-streak (failures=3) | claudecodeui | gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged | GT- | claudecodeui/.quay/worker-outcome.jsonl@1732024 | 80592919 171625f6 +7 | 49 |
| 2026-10-09T04:53 | Notify | human-decision | claudecodeui | gap-voice-realtime-browser-e2e-current-session | GT+ | git 66bd8c89da | c3034175 4c9eb16e | 94 |
| 2026-10-09T06:22 | Notify | human-decision | claudecodeui | gap-voice-realtime-microphone-human-smoke-test | GT+ | git 32977e4665 |  | 32 |
| 2026-10-09T06:51 | Escalate | failure-streak (failures=3) | claudecodeui | gap-mcp-session-send-reports-pending-interaction-it-queued-behind | GT- | claudecodeui/.quay/worker-outcome.jsonl@1805134 | 598d02bf d15bb693 +6 | 77 |
| 2026-10-09T06:58 | Escalate | failure-streak (failures=3) | quay | gap-goal033-selfhost-and-archguard-evidence | GT+ | quay/.quay/worker-outcome.jsonl@4230125 | 034ebb38 f5065218 +2 | 38 |
| 2026-10-09T06:58 | Notify | human-decision | quay | gap-goal033-selfhost-and-archguard-evidence | GT+ | git 9703822297 | 034ebb38 f5065218 +2 | 38 |
| 2026-10-09T08:12 | Notify | human-decision | claudecodeui | gap-asr-wire-probe-ws-frame-false-positive | GT+ | git be1b641f8c | 5f73d69e c2bd7dfc +5 | 86 |
| 2026-10-09T09:29 | Notify | human-decision | claudecodeui | gap-goal-033-ac317-runnable-criterion | GT+ | git 0bdc0cde77 |  | 30 |
| 2026-10-09T09:38 | Escalate | failure-streak (failures=3) | claudecodeui | gap-asr-wire-probe-ws-frame-false-positive | GT+ | claudecodeui/.quay/worker-outcome.jsonl@1854875 | 5f73d69e c2bd7dfc +5 | 86 |
| 2026-10-09T10:22 | Notify | release-dependency-parked | claudecodeui | gap-quay-tab-loop-pulse-gantt-integration | GT+ | git 1cdcfb8155 | 2b968582 | 58 |
| 2026-10-09T11:02 | Escalate | failure-streak (failures=3) | quay | gap-routine-semantic-dedup-scan-parse-args-handrolled-variants | GT- | quay/.quay/worker-outcome.jsonl@4280195 | c69aabab 08f247f2 +2 | 24 |
| 2026-10-09T11:21 | Escalate | failure-streak (failures=3) | claudecodeui | gap-debug-agent-simulates-permission-popup-for-mcp-e2e | GT- | claudecodeui/.quay/worker-outcome.jsonl@1893106 | 67e73fab 3442d63b +8 | 84 |
| 2026-10-09T11:37 | Notify | cross-project-upstream-landed ← quay/gap-dashboard-kernel-not-packaged-in-plugin-artifact | claudecodeui | gap-quay-tab-loop-pulse-gantt-integration | GT+ | git 531d5fe8d5 | 2b968582 | 58 |
| 2026-10-09T11:43 | Notify | human-decision | claudecodeui | gap-ac315-upload-criterion-boot-race | GT+ | git a1fa372595 | 2088b3b4 | 53 |
| 2026-10-09T11:54 | Notify | failure-unrecovered (failures=1) | claudecodeui | gap-claudecodeui-scoped-self-test-and-concurrent-worker-sessions-bypass-resource-gate | GT+ | claudecodeui/.quay/worker-outcome.jsonl@1793722 | 5e63f1df | 88 |
| 2026-10-09T14:04 | Notify | failure-unrecovered (failures=1) | claudecodeui | gap-ac120-upload-input-locator-ambiguous | GT- | claudecodeui/.quay/worker-outcome.jsonl@1839019 | 1eeb949e d0cb4ae5 +1 | 113 |
| 2026-10-09T16:24 | Notify | release-dependency-stalled (failures=1) | claudecodeui | gap-quay-tab-loop-pulse-gantt-integration | GT+ | claudecodeui/.quay/worker-outcome.jsonl@1878298 | 2b968582 | 58 |
| 2026-10-09T17:26 | Notify | human-decision | claudecodeui | gap-ac188-composer-stop-outlives-dock-idle | GT+ | git e9c8911d5d | aa9ee801 f63e3dd0 +3 | 78 |
| 2026-10-09T17:26 | Escalate | failure-streak (failures=3) | claudecodeui | gap-ac188-composer-stop-outlives-dock-idle | GT+ | claudecodeui/.quay/worker-outcome.jsonl@1941830 | aa9ee801 f63e3dd0 +3 | 78 |
| 2026-10-09T17:44 | Notify | failure-unrecovered (failures=1) | claudecodeui | gap-ac315-upload-criterion-boot-race | GT+ | claudecodeui/.quay/worker-outcome.jsonl@1912224 | 2088b3b4 | 53 |
| 2026-10-09T20:24 | Notify | failure-unrecovered (failures=1) | quay | gap-ownership-replay-benchmark-redesign-two-stage | GT- | quay/.quay/worker-outcome.jsonl@4302499 | 4b911dc1 | 19 |
| 2026-10-09T23:04 | Notify | failure-unrecovered (failures=3) | claudecodeui | gap-ac188-composer-stop-outlives-dock-idle | GT+ | claudecodeui/.quay/worker-outcome.jsonl@1934825 | aa9ee801 f63e3dd0 +3 | 78 |
| 2026-10-10T01:46 | Notify | human-decision | claudecodeui | gap-voice-segmented-relay-segmenter-relay-profile | GT+ | git 5a42d83fe6 | 49ae1634 089a6f3f +2 | 61 |
| 2026-10-10T02:21 | Notify | human-decision | claudecodeui | gap-goal-034-exit-conditions-section | GT+ | git f6f6739720 | c399a02a | 51 |
| 2026-10-10T02:55 | Notify | human-decision | claudecodeui | gap-voice-segmented-relay-segmenter-relay-profile | GT+ | git ddc0898934 | 49ae1634 089a6f3f +2 | 61 |
| 2026-10-10T02:55 | Escalate | failure-streak (failures=3) | claudecodeui | gap-voice-segmented-relay-segmenter-relay-profile | GT+ | claudecodeui/.quay/worker-outcome.jsonl@1986573 | 49ae1634 089a6f3f +2 | 61 |
| 2026-10-10T03:54 | Notify | human-decision | claudecodeui | gap-goal-033-ac317-runnable-criterion | GT+ | git 99c4e73ac1 |  | 30 |
| 2026-10-10T05:12 | Notify | human-decision | claudecodeui | gap-voice-segmented-relay-protocol-server-commit | GT+ | git 2e54b173e3 | 05035c65 ebded808 +1 | 57 |
| 2026-10-10T06:22 | Escalate | needs-human-expired | claudecodeui | gap-voice-realtime-microphone-human-smoke-test | GT+ | git 32977e4665 |  | 32 |
| 2026-10-10T06:39 | Escalate | failure-streak (failures=3) | quay | gap-release-workflow-definition-lags-one-release | GT+ | quay/.quay/worker-outcome.jsonl@4341195 | 06fddec6 ea6e9458 +2 | 31 |
| 2026-10-10T06:39 | Notify | human-decision | quay | gap-release-workflow-definition-lags-one-release | GT+ | git 15d2afda0c | 06fddec6 ea6e9458 +2 | 31 |
| 2026-10-10T08:18 | Notify | human-decision | claudecodeui | gap-effective-capacity-probe-cgroup-cpu-mem-quota | GT+ | git 9c2801f1bd | c96e2589 3c752b9f +1 | 59 |
| 2026-10-10T08:31 | Notify | human-decision | claudecodeui | gap-input-outline-classifies-turns-by-origin | GT+ | git a62d6610af | 744b5e3a 959f2709 +1 | 46 |
| 2026-10-10T09:05 | Notify | human-decision | claudecodeui | gap-with-memory-cap-default-adapts-to-effective-memory | GT+ | git 0d4e48840c | 9876c027 8b654f58 +2 | 55 |
| 2026-10-10T09:08 | Notify | human-decision | claudecodeui | gap-voice-segmented-relay-client-wiring | GT+ | git 09e025cc68 | d3caf6fd ac3bd4b0 +3 | 73 |
| 2026-10-10T09:55 | Notify | human-decision | claudecodeui | gap-input-outline-classifies-turns-by-origin | GT+ | git 621505870f | 744b5e3a 959f2709 +1 | 46 |
| 2026-10-10T09:55 | Escalate | failure-streak (failures=3) | claudecodeui | gap-input-outline-classifies-turns-by-origin | GT+ | claudecodeui/.quay/worker-outcome.jsonl@2086106 | 744b5e3a 959f2709 +1 | 46 |
| 2026-10-10T10:03 | Notify | human-decision | claudecodeui | gap-voice-segmented-relay-client-wiring | GT+ | git aba3e64be2 | d3caf6fd ac3bd4b0 +3 | 73 |
| 2026-10-10T10:03 | Escalate | failure-streak (failures=3) | claudecodeui | gap-voice-segmented-relay-client-wiring | GT+ | claudecodeui/.quay/worker-outcome.jsonl@2089739 | d3caf6fd ac3bd4b0 +3 | 73 |
| 2026-10-10T10:11 | Notify | human-decision | claudecodeui | gap-session-host-control-lease-gate-rest-parity-followup | GT+ | git a7af89051f | 2e95449e 7ec98981 +1 | 33 |
| 2026-10-10T10:14 | Notify | human-decision | claudecodeui | gap-with-memory-cap-default-adapts-to-effective-memory | GT+ | git 32c49bcfca | 9876c027 8b654f58 +2 | 55 |
| 2026-10-10T10:14 | Escalate | failure-streak (failures=3) | claudecodeui | gap-with-memory-cap-default-adapts-to-effective-memory | GT+ | claudecodeui/.quay/worker-outcome.jsonl@2094717 | 9876c027 8b654f58 +2 | 55 |
| 2026-10-10T10:22 | Escalate | needs-human-expired | claudecodeui | gap-quay-tab-loop-pulse-gantt-integration | GT+ | git 1cdcfb8155 | 2b968582 | 58 |
| 2026-10-10T10:33 | Notify | human-decision | claudecodeui | gap-test-sh-concurrency-ceiling-adapts-to-effective-cpu | GT+ | git 1d858520eb | fa022190 aa2c1cd5 +1 | 40 |
| 2026-10-10T10:38 | Notify | human-decision | claudecodeui | gap-voice-realtime-upstream-pool-rotation | GT+ | git 0e9bee67a9 | 2fbe8fc0 7eaaae29 +1 | 64 |
| 2026-10-10T11:27 | Escalate | failure-streak (failures=3) | quay | gap-ac356-criterion-environment-fatal-window-check-unsatisfiable | GT+ | quay/.quay/worker-outcome.jsonl@4370603 | 97dacf13 ee9f47ac +3 | 24 |
| 2026-10-10T11:42 | Notify | human-decision | quay | gap-ac356-criterion-environment-fatal-window-check-unsatisfiable | GT+ | git a59fd21c11 | 97dacf13 ee9f47ac +3 | 24 |
| 2026-10-10T14:27 | Notify | failure-unrecovered (failures=3) | claudecodeui | gap-input-outline-classifies-turns-by-origin | GT+ | claudecodeui/.quay/worker-outcome.jsonl@2049064 | 744b5e3a 959f2709 +1 | 46 |
| 2026-10-10T16:39 | Notify | human-decision | claudecodeui | gap-goal-037-exit-conditions-section | GT+ | git a4612658b8 |  | 10 |
