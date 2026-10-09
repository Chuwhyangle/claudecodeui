---
id: gap-ac140-dashscope-public-host-second-copy
title: AC-140 的「端点主机单一实现」读数被今日落地的 realtime 传输打破：dashscope.aliyuncs.com
  出现第二个出货副本；收拢到规则模块的单一来源令判据回绿（AC-140）
status: needs-human
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
`reading=endpoint-rule.single-implementation verdict=FAIL ENDPOINT_RULE_NOT_SINGLE_COPY`；其余读数全绿
（`transport[...]` 三条、`allow[...]` 两条、`reject[...]` 八条、`direct-path[...]` 五条、
`direct-provider-passthrough[http://127.0.0.1:8080] ok=true calls=1`）。驱动这条读数的分项：
`endpoint-rule.modules=1`、`registered-count=5`、`hosts.accepted=2`、`endpoint-rule.host-bearers=2`。
两次连跑同一红行，非 flake（读的是文件内容，不是计时）。

**bearer 是谁**：`grep -rn "dashscope\.aliyuncs\.com" src/ shared/ server/`（排除 `tests/` 与 `*.test.ts`）命中两个出货文件 ——
(1) 规则模块 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts:229`（`const PUBLIC_HOSTNAME = 'dashscope.aliyuncs.com'`，判据的判决要求它必须是唯一 bearer）；
(2) `server/modules/voice-realtime/voice-realtime-dashscope-transport.ts:90`（`export const DASHSCOPE_REALTIME_ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'`）。

**为何今天才红（早先那次实现为何没站住）**：AC-140 的实现任务 `gap-asr-proxy-only-ssrf-and-direct-path-zero` 于 2026-09-24 翻 done，
当时出货树里只有规则模块一处 spelling，判据绿。2026-10-09 落地的 AC-308（commit cdd22421
`voice-realtime: real DashScope realtime transport + eval harness`）新增了 `voice-realtime-dashscope-transport.ts`，
其中硬编码了同一个 DashScope 公网主机 —— 于是「白名单判据与它据以构造的两个主机名只住在一个文件里」这条
single-implementation 断言多出了第二个副本。不是判据变严：是出货树多了一处副本。

**修法（判据结构决定，且不削弱判据）**：`findHostBearers` 只数 `src/**`、`shared/**`、`server/**` 下出货文件里
`includes(host)` 的个数，判决是 `bearers.length === 1 && bearers[0] === ruleModulePath`。因此唯一能让读数回绿
且不动判据的形态是：**主机字面量继续只住在规则模块里**，第二消费方（realtime 传输）从规则模块 import 那个主机常量、
由它拼出端点，而不是各写各的字符串。这与 backend-module-standards「不复制既有 shared 定义以躲避 import」一致；
`server/modules/voice/voice.module.ts:12` 已有 server 直接从 `shared/asr/list/*` 深引 provider 模块的先例
（`sensevoice-local.asr-provider.js`），导入方向不新。**被否的方案**：放宽 `scripts/asr-proxy-only-ssrf-check.mjs`
的 bearer 扫描（把 realtime 文件排除）—— 那正是「改判据以过关」，会把「白名单主机只有一个来源」这条实测断言削成空文，不做。
**代价（如实记录）**：realtime 传输 import 规则模块会一并载入该 provider 的运行时（提示词常量与 `transcribe` 等）；
server 侧可接受，且比复制主机常量更符合单一来源。传输本已 import `ws` / `zod`，非纯 leaf，无「不得 import 其它模块」
的守卫测试会被触红。

**交付三件东西**：

1. **规则模块导出主机**（`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`）：把 `PUBLIC_HOSTNAME` 变为具名导出
   （或在具名导出的常量上引用它），字面量仍只在本文件出现；导出处注释按 backend-module-standards 指名消费方
   （本文件的 `allowedBaseUrl` 与 `voice-realtime` 传输）。
2. **realtime 传输改用单一来源**（`server/modules/voice-realtime/voice-realtime-dashscope-transport.ts`）：从规则模块 import
   该主机常量，`DASHSCOPE_REALTIME_ENDPOINT` 改为 `wss://${HOST}/api-ws/v1/realtime`（模板串），文件内不再出现主机字面量；
   导出名与对外值 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` **逐字不变**（`index.ts` 与两个 realtime 测试零改动）。
3. **回归守卫**（`server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.test.ts`）：加一条断言，
   钉住 `DASHSCOPE_REALTIME_ENDPOINT` 由那条单一来源导出的主机拼成（例如断言它以 `wss://` + 导出主机开头），
   使将来在本文件重新硬编码另一个主机即红。

**边界（不做）**：不改 `allowedBaseUrl` 的判否语义（协议/端口/用户信息/两个主机形态）；不动 realtime 传输的线协议翻译、
inbound call 校验与 socket 注入缝；不通过放宽或修改 `scripts/asr-proxy-only-ssrf-check.mjs` 的判决让它变绿；
不动 `src/`/`server/` 的其它行为读数；不碰 `voice-realtime` 的连接韧性/真实音频/会话发送三条在空任务。

<!-- dedup-ref --> **粒度结论**：merge-candidate 仪器给出一个共享 Touches 的开放 peer `gap-voice-realtime-connection-resilience`
（status `todo`，共享 `voice-realtime-dashscope-transport.ts`）。判为 **separate**：peer 的机制是传输的连接韧性，
本条的机制是「白名单主机被第二个出货副本打破单一来源」，验收互不覆盖；peer 尚未派发，Touches 序列化由调度器处理。

## Touches

- shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts
- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.test.ts
- tasks/gap-ac140-dashscope-public-host-second-copy.md

## AC

- [x] AC1 判据回绿：`node scripts/asr-proxy-only-ssrf-check.mjs` 退出 **0**，输出含 `reading=endpoint-rule.single-implementation verdict=ok`，且 `reading=endpoint-rule.host-bearers value=1`。
- [x] AC2 单一来源（与判据 `findHostBearers` 同口径）：`grep -rln "dashscope\.aliyuncs\.com" src/ shared/ server/ | grep -vE '/tests/|\.test\.tsx?$'` 恰好输出一行，且该行为 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`；`server/modules/voice-realtime/voice-realtime-dashscope-transport.ts` 正文零命中（`grep -c` 为 0）。
- [x] AC3 对外值不变：`DASHSCOPE_REALTIME_ENDPOINT` 仍逐字等于 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`（由单一来源导出的主机拼成），导出名与 `server/modules/voice-realtime/index.ts` 的导出面不变。
- [x] AC4 回归守卫可执行：realtime 测试新增断言钉住端点由单一来源的主机导出拼成；`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.test.ts server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.false-forms.test.ts` 退出 0。
- [x] AC5 取假形态：把规则模块导出的主机（或传输里的拼接）在临时树里改掉后，AC2 的 grep 或 AC4 的断言必须红；未变异的对照先绿 —— 证明读的是出货树，不是判据自造的副本。

## DoD

- 出货树上 **AC-140 的判据本身**（`node scripts/asr-proxy-only-ssrf-check.mjs`）退出 0：红行 `endpoint-rule.single-implementation` 翻绿，
  且 `allow`/`reject`/`direct-path`/`direct-provider-passthrough` 各读数**保持绿**（不许为了这一条把行为读数弄红）。
- realtime 传输仍是**真跑**的：它自己的测试（含 `startsWith(DASHSCOPE_REALTIME_ENDPOINT)` 与 `trace.endpoint` 两条断言）绿，
  证明收拢来源没有改掉拨号地址。
- `grep` 类读数（AC2）在**出货树**上取到，覆盖 `src/`、`shared/`、`server/` 三个 glob 且排除测试文件——与判据 `findHostBearers` 同一口径。
- 取假形态的「必红」在真实运行里被观察到（记录命令与红的 token），不是口述。

## Verification

All readings taken on the shipping tree at commit `b8e13c60`
(worktree `claudecodeui-worktrees/gap-ac140-dashscope-public-host-second-copy`, branch `task/gap-ac140-dashscope-public-host-second-copy`).

- AC1 `node scripts/asr-proxy-only-ssrf-check.mjs` → exit 0; `reading=endpoint-rule.host-bearers value=1`,
  `reading=endpoint-rule.single-implementation verdict=ok`; 22 `verdict=ok`, 0 non-ok.
- AC2 `grep -rln "dashscope\.aliyuncs\.com" src/ shared/ server/ | grep -vE '/tests/|\.test\.tsx?$'` → **1** line
  (`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`); transport `grep -c` → **0**.
- AC3 `git status --porcelain server/modules/voice-realtime/index.ts` → empty (barrel export surface untouched).
  Read through the barrel: `DASHSCOPE_REALTIME_ENDPOINT` = `"wss://dashscope.aliyuncs.com/api-ws/v1/realtime"`, byte-equal (47/47).
- AC4 `npx tsx --tsconfig server/tsconfig.json --test …transport.test.ts …transport.false-forms.test.ts`
  → tests 19, pass 19, fail 0, exit 0; includes `AC-140: the endpoint is composed from the rule module’s single-source host`.
- AC5 falsification in a temp tree (`/tmp/ac140-falsify`, removed afterward); control green first (exit 0, `host-bearers value=1`, `verdict=ok`):
  - Form A — restore the pre-fix hard-coded host literal in the transport:
    `node scripts/asr-proxy-only-ssrf-check.mjs` → exit **1**;
    `reading=endpoint-rule.host-bearers value=2`;
    `reading=endpoint-rule.single-implementation verdict=FAIL ENDPOINT_RULE_NOT_SINGLE_COPY`;
    AC2 grep → **2** lines (rule module + transport).
  - Form B — mutate the transport concat path (`/api-ws/v1` → `/api-ws/v2`):
    `✖ AC-140: the endpoint is composed from the rule module’s single-source host`,
    `AssertionError [ERR_ASSERTION]: the endpoint must be composed from the rule module’s exported host` (exit 1).
- `npx tsc --noEmit -p tsconfig.json` and `-p server/tsconfig.json` → exit 0;
  `npx oxlint shared/asr/list/dashscope-omni/ server/modules/voice-realtime/` → exit 0.

## Needs-Human

**执行 2026-10-09T02:37:07.608Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：exited-not-landed 失败无法归因（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (parser extracted 0 of 1 failing lines and attributed none to a file; pseudo-stage tokens: suite-watchdog); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：5c2c4201-cb3d-40e7-8af8-ce576c959f6a
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-ac140-dashscope-public-host-second-copy~wk-prod-anchor~1791513353174-3ec531.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-ac140-dashscope-public-host-second-copy-wk-prod-anchor.log
