---
id: gap-ac352-criterion-harden-against-repo-dotenv
title: AC-352 回放判据在钉着非空 DASHSCOPE_API_KEY 的部署方 .env 检出里仍须退出 0：正向腿「上游拨号无
  authorization 头」被 server/load-env.ts 的空值回填顶翻，当前检出红 1 failed/13 passed
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-352
---
## Proposal

### 问题

AC-352 的判据 `f=e2e/voice-realtime-segmented-replay-20261012.spec.ts; [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; DASHSCOPE_API_KEY= npx playwright test "$f" --workers=1` 在**本检出**（仓根 `.env` 钉着非空 `DASHSCOPE_API_KEY`，值长 35）逐字运行：退出 **1**，`1 failed / 13 passed (1.3m)`；连续两次逐字相同（确定性）。9 条 `test.fail` 缺陷腿全部按预期失败（playwright 计为 passed）；红的是一条 AC 文字里写明「当前即绿」的正向腿：

```
1) e2e/voice-realtime-segmented-replay-20261012.spec.ts:631:3 › … › the replay ran segmented, on the local scripted upstream, with no cloud credential
  > 636 |  expect(rec.authorizationHeaderSeen, `branch ${key}: the upstream dial carried a credential`).toBe(false);
  Error: branch A: the upstream dial carried a credential
  Expected: false
  Received: true
```

两次运行的逐字失败行、`1 failed / 13 passed`、退出码完全一致（日志 `/tmp/ac352-criterion-run1.log`、`/tmp/ac352-criterion-run2.log`）。

### 机制（已核对，可复验）

1. `playwright.config.ts:2579` 为 voice realtime 选择设 `DASHSCOPE_API_KEY: ''`，其上方注释写明契约：「Setting the key to the EMPTY STRING here overrides any ambient value（the config's `env` wins the merge）… the upgrade then carries no `Authorization` header at all」。
2. `server/load-env.ts:42` 的回填判据是 `!process.env[key]` —— **空串是 falsy**，于是被显式设成 `''` 的键会被仓根 `.env` 的 35 字符真值顶回。逐字复现（只打印布尔与长度，不打印密钥）：

```
$ node -e 'process.env.DASHSCOPE_API_KEY=""; <server/load-env.ts:38-46 的逐字规则>'
dial apiKey would be empty?  true
after load-env: apiKey empty?  false | length: 35
```

3. `server/modules/voice-realtime/voice-realtime-dashscope-transport.ts:665` 取 `options.apiKey ?? process.env.DASHSCOPE_API_KEY ?? ''`；`:1006` 是 `apiKey === '' ? {} : { Authorization: \`Bearer ${apiKey}\` }`。键一旦被顶回，服务端就带着**真实凭据**去拨本地假上游（`VOICE_REALTIME_ENDPOINT=ws://127.0.0.1:<QUAY_E2E_VOICE_REALTIME_PORT>`）。

**本次没有云调用**：拨号目标就是本地 fake，且 fake 收到了帧（两条分支各 6 次提交、`ready{segmented-v1}`、`turn_unanswered` 均已被正向读数覆盖）。红的是「零云调用」这条**证明读数**与 `.env` 的耦合，不是事实本身。

### 为什么早先那次没守住

`gap-live-voice-segmented-replay-20261012`（`goal_ac: AC-352`，done）的两次绿是在**它自己的工作树**里取的，而工作树里**没有 `.env`**（`.env` 是 gitignored、untracked，worktree 不含它）——已实测两个 worktree 均 `NO .env`，主检出 `HAS .env`。判据却在**主检出**里求值：AC-352 记录里两次读数（`firstAt` 08:30:49Z、`lastProgressAt` 08:58:34Z）都是「缺判据文件」，而判据文件 `b822a041` 提交于任务分支 16:55:36 +0800、17:02:18 才随 fan-in 并入 develop——两次读数都早于这次 ff。于是「文件在、读数在别处」这一层从未被覆盖：文件落地了，判据本身在这份检出里仍是红的。

<!-- dedup-ref --> 同族先例（本段只作溯源，不声明依赖边）：`gap-ac254-criterion-harden-against-repo-dotenv`（AC-254，done）与 `gap-voice-capture-criterion-hardened-root`（AC-148，done）是同一失效族——判据把某一态「能不能产出」外包给部署方 `.env`，而 `server/load-env.ts` 会把子进程里被删/被置空的键顶回来。AC-254 的修法是「读数依赖的键一律显式赋值」；AC-148 的修法是「判据自造一份删掉 `.env` 的硬链接副本」。本条属后者：本条读数是**空值**（`apiKey === ''`），而 `!process.env[key]` 之下没有任何非空值能表达「没有凭据」，所以「显式赋值」那一半不可用。

### SCOPE BOUNDARY

- 判据必须在**带非空 `DASHSCOPE_API_KEY` 的检出**里退出 0；⛔ 绝不读写、删除或改动部署方 `.env`（判据只读环境，不改环境）。
- ⛔ 不得靠删除或放宽那条断言换绿：「零云调用」必须仍有**同等强度**的读数（见 Plan 两种可采构造）。
- 9 条 `test.fail` 缺陷腿与另外 4 条正向腿一字不动（去标注是 AC-356 收口任务的事）。
- ⛔ 不改 AC-352 记录的 criterion / expect / status / origin；⛔ 不动 GOAL-041 的文件与语义。

## Plan

1. 取红基线：在带 `.env` 的检出里逐字跑判据，记下上面的失败行与 `1 failed / 13 passed`；连跑两次确认逐字相同。
2. 选一种构造，把「没有凭据」变成**判据自己定义的世界**里成立的事实（二选一，写下选择理由）：
   - (B) **不读部署方 `.env` 的服务端根**（AC-148 族，推荐）：voice realtime 选择下，服务端 webServer 从一份**只硬链接、跳过 `.git` 与 `.env`** 的副本里起（`cp -al`，同族实测约 1.5 s；副本取检出根的兄弟目录以保证同文件系统——`/tmp` 跨设备会 `Invalid cross-device link`）；副本在每条出口（成功／变异红／起不来／抛错）都删除；vite 与浏览器留在原检出。这样 `DASHSCOPE_API_KEY: ''` 的契约才真的成立，凭据不上线，fail-closed 性质保留。
   - (C) **显式锚点且仍 fail-closed**：把「拨号目标」本身作为读数（假上游记录的 upgrade 请求 `Host` 必须是 `127.0.0.1:<QUAY_E2E_VOICE_REALTIME_PORT>`），凭据那条降级为诊断行；**并且**另加一条让「端点被指错」仍然当场变红的读数（例如服务端自己打印实际生效的 `VOICE_REALTIME_ENDPOINT` 与凭据有无）。选 (C) 必须证明「端点指错」这条腿会红，否则等于把验证放宽成「我们拨了某个地方」。
3. 取假形态（承重性）：(i) 把本条的构造改回原状（服务端回到原检出根）⇒ 那条正向腿立刻回到 `Received: true`，逐字记录并给恢复命令；(ii) 把 `VOICE_REALTIME_ENDPOINT` 指到一个非 loopback 地址 ⇒ 必须有读数变红（证明「零外连」仍在判事），不得静默通过。
4. 确定性：连跑两次，逐用例 pass／expected-fail 列表逐字相同。
5. 仓库门与兄弟不回归：`npm run typecheck`、`npm run lint` 退出 0；`e2e/voice-realtime-live-session-send.spec.ts` 单跑退出 0。

## AC

- [ ] AC1（取假形态排最前）承重性：把本条的构造改回原状后，在本检出重跑判据，那条正向腿立刻红，逐字失败行与立案基线相同（`Error: branch A: the upstream dial carried a credential` / `Received: true`）；恢复后回绿。写下变异 diff、逐字失败行与恢复命令。
- [ ] AC2 判据在**带非空 `DASHSCOPE_API_KEY` 的检出**里退出 0：先 `grep -c '^DASHSCOPE_API_KEY=..*' .env` 读出 ≥1（只打印键名与值长度，绝不打印密钥），随后 `f=e2e/voice-realtime-segmented-replay-20261012.spec.ts; [ -f "$f" ] || exit 1; DASHSCOPE_API_KEY= npx playwright test "$f" --workers=1` 退出 0，写下 tests/passed/failed 与运行时长。
- [ ] AC3 零云调用仍有同等强度读数：写下本条采的构造（B 或 C）、服务端进程里 `DASHSCOPE_API_KEY` 的实际取值来源与长度、`VOICE_REALTIME_ENDPOINT` 的实际取值、假上游记录的 upgrade `Host`；并给出 AC1 第 (ii) 臂（端点指错即红）的逐字读数。
- [ ] AC4 缺陷腿与其余正向腿未被动过：`grep -cE "test\.(fail|fixme|skip)\(" e2e/voice-realtime-segmented-replay-20261012.spec.ts` = 9；`git diff develop HEAD -- e2e/voice-realtime-segmented-replay-20261012.spec.ts` 只含本条改动，逐条列出被改的断言行。
- [ ] AC5 确定性：连跑判据两次都退出 0，逐用例 pass 列表逐字相同（写下两次 tests/passed/failed 与各自时长）。
- [ ] AC6 不回归：`npm run typecheck`、`npm run lint` 退出 0（逐条打印退出码）；`e2e/voice-realtime-live-session-send.spec.ts` 单跑退出 0（共享测试桩未被本条改动）。
- [ ] AC7 范围：`git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐；若本条落在判据侧，`git diff --stat develop HEAD -- server/ src/ shared/` 输出为空（原样打印）；若采产品侧改法，逐条列出改动并说明为什么它是出货实现缺陷而不是判据耦合。
- [ ] AC8 判据不再依赖部署方 `.env` 的**缺席**：逐条列出判据依赖的每个读数，并证明每条在「`.env` 在」与「`.env` 不在」两种检出里取值相同（写下两臂命令与逐字读数）。

## DoD

真实落地判据：不是「spec 改了几行」，而是**在部署方把非空 `DASHSCOPE_API_KEY` 钉在仓根 `.env` 的检出里**，AC-352 的判据逐字退出 0，且「零云调用」仍由与 `.env` 无关的读数支撑；承重性由「改回原状即红」「端点指错即红」两条变异证明；9 条缺陷腿与其余 4 条正向腿一字不动。反事实要如实登记：本次实测确认**那次回放本身是对的**——拨号目标就是本地假上游，全程没有云调用；失效的是**判据对部署方 `.env` 的环境耦合**（AC-254／AC-148 同族：门按锚点的 environ 与检出跑判据，任何把裁决建在环境上的读数都会在别人手上翻面）。

另需如实登记：AC-352 记录没有 `timeoutMs`，默认 60000 ms 低于本 spec 的 76–83 s + boot，因此判据即使在本条之后转绿，也可能被读成 `not-evaluated (timeout)`；该机制另有承载者 `gap-ac352-replay-criteria-record-timeoutms`（todo，无 `goal_ac`），本条只修凭据腿，不代改 goal 记录。

## Touches

- playwright.config.ts
- e2e/voice-realtime-segmented-replay-20261012.spec.ts
- e2e/voiceRealtimeScriptedUpstream.ts（仅当读数需要假上游暴露 upgrade 的 Host 或请求头）
- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts（仅当采产品侧构造并已证明它为出货实现缺陷）
- tasks/gap-ac352-criterion-harden-against-repo-dotenv.md

## Notes

立案：gap-filing agent 2026-10-12（GOAL-043 / AC-352，人 yale 授权）。查重（按机制不按症状）：`grep -rn '^goal_ac: *AC-352' tasks/*.md` 只命中 `gap-live-voice-segmented-replay-20261012`（`status: done`）——按本仓规矩它不是重复，而是「早先那次出货没守住」的证据，故另立本条并说明它为何没守住（见 Proposal 第 3 节）。同族先例另有 AC-254／AC-148 两份 done（机制同、读数不同）。

<!-- dedup-ref --> 粒度与分离决定（本段只作溯源，不声明任何顺序约束）：`task-granularity-advice.js --touches playwright.config.ts …` 给出两个共用 `playwright.config.ts` 的 peer——`gap-live-voice-replay-local-egress-guard`（todo，`goal_ac: AC-360`）与 `gap-live-voice-segmented-replay-closure`（todo，`goal_ac: AC-356`）。判定 **keep-separate**：三条各自要一个不同的顶层 `goal_ac` 承载（driver 的逐 AC 校验按顶层字段认领），且 AC-360 那份要**新增**外连守卫与更强的断言（含「服务端 env 的 DASHSCOPE_API_KEY 为空」，在 `.env` 检出里同样需要本条解决的那件事），与本条「让现有凭据腿在 `.env` 检出里成立」不是同一份验收；调度器按 Touches 串行，合并省不下并行度。

立案证据文件：`/tmp/ac352-criterion-run1.log`、`/tmp/ac352-criterion-run2.log`（各含完整 14 用例列表与逐字失败块）。
