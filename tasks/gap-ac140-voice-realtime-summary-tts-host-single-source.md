---
id: gap-ac140-voice-realtime-summary-tts-host-single-source
title: AC-140 的端点主机单一来源被 voice-realtime 的 summary/TTS
  两个出货叶子各写一份打破：从规则模块导出的主机拼装，判据回绿（AC-140）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-140
---
## Proposal

**现状（本轮实测，可复验）**：`node scripts/asr-proxy-only-ssrf-check.mjs` 退出 **1**，唯一红行是
`FAIL ENDPOINT_RULE_NOT_SINGLE_COPY: the addresses this service is reached at are spelled in 3 shipping source file(s) (shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts, server/modules/voice-realtime/voice-realtime-summary.ts, server/modules/voice-realtime/voice-realtime-tts.ts; ...)`，
对应读数 `reading=endpoint-rule.host-bearers value=3` 与
`reading=endpoint-rule.single-implementation verdict=FAIL`。其余读数全绿：`transport[...]` 三条、
`allow[...]` 两条、`reject[...]` 八条、`direct-path[...]` 五条、
`direct-provider-passthrough[http://127.0.0.1:8080] ok=true calls=1`、`siblings=7/7 exit-0`。
两次连跑同一红行（读的是文件内容，不是计时），非 flake。

**两个 bearer 是谁**：判决要求 `bearers.length === 1 && bearers[0] === ruleModulePath`，而
`ruleModulePath` 是导出 `allowedBaseUrl` 的规则模块
`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`（其中
`export const PUBLIC_HOSTNAME = 'dashscope.aliyuncs.com'`）。多出来的两处是今天新增的出货叶子各自硬编码了同一个主机：
- `server/modules/voice-realtime/voice-realtime-summary.ts:42` — `const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';`
- `server/modules/voice-realtime/voice-realtime-tts.ts:43` — `export const DEFAULT_VOICE_REALTIME_TTS_BASE_URL = 'https://dashscope.aliyuncs.com';`

**为何早先的修复没站住**：AC-140 的上一轮修复 `gap-ac140-dashscope-public-host-second-copy`（done，2026-10-09）
只收拢了 `server/modules/voice-realtime/voice-realtime-dashscope-transport.ts` 这一处，判据当时回绿。
此后 2026-10-19 的 commit `c3b668af8` 引入 `voice-realtime-tts.ts`、2026-10-20 的 commit `e0ee8c6b1`
引入 `voice-realtime-summary.ts`，两个新叶子各写了一份主机字面量。判据的 `findHostBearers` 扫的是
`src/**`、`shared/**`、`server/**` 全树，新增副本时不会出声，只有判据重跑才红。即：上一轮的修复是逐文件的，
而断言是全树的——本条既补上这两处，也把逐文件的守卫钉进两个已有测试，避免同一形态再次静默复发。

**修法（判据结构决定，且不削弱判据）**：唯一能让读数回绿且不动判据的形态是：**主机字面量继续只住在规则模块里**，
两个叶子从规则模块 import `PUBLIC_HOSTNAME` 并拼装 URL：
- `voice-realtime-summary.ts`：`https://${PUBLIC_HOSTNAME}/compatible-mode/v1/chat/completions`
- `voice-realtime-tts.ts`：`https://${PUBLIC_HOSTNAME}`

对外值逐字不变。这条导入方向不是新的：`voice-realtime-dashscope-transport.ts:126` 已经从同一模块
深引 `PUBLIC_HOSTNAME`（AC-140 上一轮修复留下的先例）；规则模块的导出注释按 backend-module-standards
补上这两个新消费方，字面量仍只在本文件出现。
**实现偏差（见 Evidence 末节）**：两个叶子改为从同目录的传输叶子读
`DASHSCOPE_PUBLIC_HOSTNAME`（它 re-export 规则模块的 `PUBLIC_HOSTNAME`），而不是各自深引规则模块——
直引会把 AC-394 的 unresolved-internal 棘轮从 19 顶到 23。单源判据与对外值完全不变。
**被否的方案**：放宽 `findHostBearers`（把 `voice-realtime` 排除）——那是改判据以过关，会把
「白名单主机只有一个来源」这条实测断言削成空文，不做。
**不做**：不改 `allowedBaseUrl` 的判否语义；不动 realtime 传输、summary/TTS 的线协议与请求形状；
不新增测试文件（只在两个既有测试里加断言，避免顶动 suite 的 unknown pin）。

<!-- dedup-ref --> **去重与粒度结论**：仓库内没有仍在飞的任务认领 AC-140 —— `grep -rln "^goal_ac: AC-140" tasks/*.md`
命中三条且全部 `done`（`gap-asr-proxy-only-ssrf-and-direct-path-zero`、`gap-ac140-dashscope-public-host-second-copy`、
`gap-asr-dashscope-user-credential-configured-mask-and-log`）；前两条是同一机制的历史实现与上一轮修复，
按指示不是重复而是「修复未站住」的证据。`task-granularity-advice.js` 对本条 Touches 返回
`peers: []`、`mentions: []`，无合并候选。判为 **separate**。

## Touches

- shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts
- server/modules/voice-realtime/voice-realtime-summary.ts
- server/modules/voice-realtime/voice-realtime-tts.ts
- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/tests/voice-realtime-summary.test.ts
- server/modules/voice-realtime/tests/voice-realtime-tts.test.ts
- tasks/gap-ac140-voice-realtime-summary-tts-host-single-source.md

## AC

- [x] AC1 判据回绿：`node scripts/asr-proxy-only-ssrf-check.mjs` 退出 **0**，输出同时含 `reading=endpoint-rule.host-bearers value=1` 与 `reading=endpoint-rule.single-implementation verdict=ok`，且无 `FAIL ` 行。
- [x] AC2 单一来源（与判据 `findHostBearers` 同口径）：`grep -rln "dashscope\.aliyuncs\.com" src/ shared/ server/ | grep -vE '/tests/|\.test\.tsx?$'` 恰好输出一行且等于 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`；`grep -c "dashscope\.aliyuncs\.com" server/modules/voice-realtime/voice-realtime-summary.ts server/modules/voice-realtime/voice-realtime-tts.ts` 对两个文件均为 0。
- [x] AC3 回归守卫可执行：`server/modules/voice-realtime/tests/voice-realtime-tts.test.ts` 断言 `DEFAULT_VOICE_REALTIME_TTS_BASE_URL` 等于 `` `https://${PUBLIC_HOSTNAME}` ``；`server/modules/voice-realtime/tests/voice-realtime-summary.test.ts` 断言默认请求 URL 等于 `` `https://${PUBLIC_HOSTNAME}/compatible-mode/v1/chat/completions` ``（两处 `PUBLIC_HOSTNAME` 均从规则模块 import）；`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-tts.test.ts server/modules/voice-realtime/tests/voice-realtime-summary.test.ts` 退出 0。
- [x] AC4 对外行为不变：两个模块拼出的 URL 逐字等于修复前的值 —— TTS 基址 `https://dashscope.aliyuncs.com`，summary 端点 `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`；tts 测试既有的 `requests[0]!.url` 断言与 summary 测试既有的默认请求断言保持绿。
- [x] AC5 取假形态：在临时树里把 `voice-realtime-summary.ts`（或 `voice-realtime-tts.ts`）改回主机字面量后，`node scripts/asr-proxy-only-ssrf-check.mjs` 退出 **1**、`reading=endpoint-rule.host-bearers value=3`、`reading=endpoint-rule.single-implementation verdict=FAIL`；未变异的对照先绿。记录命令与红 token。

## DoD

- 出货树上 AC-140 的判据本身（`node scripts/asr-proxy-only-ssrf-check.mjs`）退出 0；`transport[...]`、`allow[...]`、`reject[...]`、`direct-path[...]`、`direct-provider-passthrough` 各读数保持绿（不许为这一条把行为读数弄红）。
- 两个叶子仍**真跑**同一条线与同一个地址：两个测试文件全绿，请求 URL 逐字不变。
- `git diff --stat scripts/asr-proxy-only-ssrf-check.mjs scripts/asr-proxy-only-ssrf-check.test.mjs` 为空 —— 判据没有被放宽。
- 取假形态的「必红」在真实运行里被观察到（记录命令与红的 token），不是口述。
- `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npx oxlint server/modules/voice-realtime/ shared/asr/list/dashscope-omni/` 退出 0。

## Evidence

**2026-10-21 — 本轮（exited-not-landed 后的续做轮）实测**

### AC1 / DoD —— 判据回绿
`node scripts/asr-proxy-only-ssrf-check.mjs` → **exit 0**。读数：
`reading=endpoint-rule.host-bearers value=1`、`reading=endpoint-rule.single-implementation verdict=ok`；
无 `FAIL ` 行。`transport[...]` 3 条、`allow[...]` 2 条、`reject[...]` 8 条、`direct-path[...]` 5 条、
`direct-provider-passthrough[http://127.0.0.1:8080] ok=true calls=1`、`siblings=7/7 exit-0` 全绿。

### AC2 —— 与 `findHostBearers` 同口径
`grep -rln "dashscope\.aliyuncs\.com" src/ shared/ server/ | grep -vE '/tests/|\.test\.tsx?$'` →
唯一一行 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`。
`grep -c "dashscope\.aliyuncs\.com" server/modules/voice-realtime/voice-realtime-summary.ts server/modules/voice-realtime/voice-realtime-tts.ts`
→ 两个文件均为 `0`。

### AC3 / AC4 —— 回归守卫可执行、对外值逐字不变
- `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-tts.test.ts server/modules/voice-realtime/tests/voice-realtime-summary.test.ts`
  → **pass 15 / fail 0**（单跑：tts 9 pass，summary 6 pass）。
- tts 断言 `DEFAULT_VOICE_REALTIME_TTS_BASE_URL === \`https://${PUBLIC_HOSTNAME}\`` 且逐字 `https://dashscope.aliyuncs.com`；
  summary 断言默认请求 URL 等于 \`https://${PUBLIC_HOSTNAME}/compatible-mode/v1/chat/completions\` 且逐字与修复前相同；
  两处 `PUBLIC_HOSTNAME` 均从规则模块 import。

### AC5 —— 假形态（真实运行观察）
临时树装配脚本 `/tmp/ac140-falseform-probe/run.mjs`（`SHIPPING_FILES` + 两个叶子 + `shared` closure + `node_modules` 软链），
以 `node scripts/asr-proxy-only-ssrf-check.mjs --root <tmp>` 运行：
- 对照（未变异）→ exit **0**，`host-bearers value=1`，`verdict=ok`；
- 只把 `voice-realtime-summary.ts` 还原成主机字面量 → exit **1**，`host-bearers value=2`，
  `verdict=FAIL ENDPOINT_RULE_NOT_SINGLE_COPY`；
- 两个叶子都还原成修复前的字面量（即立案时的 shipped 3-bearer 形态）→ exit **1**，
  `reading=endpoint-rule.host-bearers value=3`、`reading=endpoint-rule.single-implementation verdict=FAIL`，
  红 token `FAIL ENDPOINT_RULE_NOT_SINGLE_COPY: ... spelled in 3 shipping source file(s)
  (...asr-provider.ts, ...voice-realtime-summary.ts, ...voice-realtime-tts.ts; test files are out of scope ...)`。

### DoD —— 其余读数
- `git diff --stat scripts/asr-proxy-only-ssrf-check.mjs scripts/asr-proxy-only-ssrf-check.test.mjs` → 空（判据未被放宽）。
- `npx tsc --noEmit -p tsconfig.json` → 0；`npx tsc --noEmit -p server/tsconfig.json` → 0。
- `npx oxlint server/modules/voice-realtime/ shared/asr/list/dashscope-omni/` → 0（仅既有 `importx(order)` warning）。
- `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts`
  → 11 pass / 0 fail，`[ac394] unresolvedInternal=19`（棘轮回到 pinned 值；上一轮红在 23）。

### 实现偏差 —— 为什么经传输叶子而不是各自深引规则模块
上一轮 suite 红的正是这条棘轮：两个叶子各深引「registry + 规则模块」4 条 repo-root `shared/` specifier，
把 `unresolvedInternalBudget` 从 19 顶到 23，而 baseline 只许降。
同目录的 `voice-realtime-dashscope-transport.ts` 早已为自身拼装付出同样的两条导入，并且按
registry-before-provider 的顺序消解 TDZ；本轮让它
`export { PUBLIC_HOSTNAME as DASHSCOPE_PUBLIC_HOSTNAME }` 作为 in-server 缝，两个叶子从它拼装。
结果：主机字面量仍只在规则模块出现（AC2 仍是一行），判据读数不变（AC1 仍 value=1），
而 AC-394 的读数保持 19。`voice-realtime-dashscope-transport.ts` 因此进入 Touches。
