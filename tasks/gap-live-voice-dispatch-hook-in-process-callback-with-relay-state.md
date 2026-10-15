---
id: gap-live-voice-dispatch-hook-in-process-callback-with-relay-state
title: Live Voice hook 换进程内回调：零 spawn、门控改中继会话状态（退役标记文件与启动清理）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**来源（本会话探针，`experiments/claude-hook-callback-probe/README.md`）**：四组合交叉实测（判据是 **transcript 里的注入 attachment**，不是"模型有没有照做"——模型有时会静默忽略注入内容）：

| 形态 | 触发并注入？ |
|---|---|
| `hooks.UserPromptSubmit[].hooks[] = async () => ({ hookSpecificOutput:{ hookEventName:'UserPromptSubmit', additionalContext } })` | **✅**（两种 `settingSources` 配置下都注入；其中一次模型逐字照做） |
| `settings.hooks.UserPromptSubmit[].hooks[].command`（= 现状出货形态） | **✅** |
| `hooks.UserPromptSubmit[].hooks[] = { type:'command', … }` | ❌（复现 driver 注释里那次实测） |
| 不挂 hook | ❌ |

**现状的代价（`gap-live-voice-dispatch-hook-production-wiring`，done）**：hook 是**命令脚本**，于是
① **每次提问 spawn 一个 node 进程**（跑 `dist-server/server/modules/voice-realtime/hooks/voice-mode-context.mjs`）；
② 门控是**文件** `~/.cloudcli/voice-active/<session_id>` ⇒ 连接非正常结束会**残留标记**（本会话实测残留过一个 `session-under-test`），要靠启动时清理兜住；
③ 测试只能靠"跑那个脚本、看 stdout 字节数"，是黑盒。

**改法（三件，都在 server 侧）**：

1. **新增叶子注册表** `server/modules/voice-realtime/voice-realtime-active.ts`：`markVoiceSessionActive(id)` / `clearVoiceSessionActive(id)` / `isVoiceSessionActive(id)`，进程级 `Set<string>`，**无 import**（叶子）⇒ 中继与 driver 都能引而不成环（已核对：`server/modules/voice-realtime/*.ts` **不**反向 import claude driver）。⚠️ **不要**塞进 `voice-realtime-mode.ts`——那个模块的设计明确写着"环境的纯函数、可打印、无副作用"，可变状态放进去违背它的自述。
2. **规则文本搬到 TS**：`server/modules/voice-realtime/voice-mode-rules.ts` 导出 `VOICE_MODE_RULES` 与 `rulesFor(variant)`，**逐字沿用**；`hooks/voice-mode-context.mjs` **退役删除**。`VOICE_MODE_HOOK_FORCE` 与 `VOICE_MODE_RULES_VARIANT` 两个实验开关**保留**（X3' 的臂要用）。注：实验装置 `experiments/voice-now-priority/x3-replay.mts` 指向的是 `experiments/voice-foreground-background/hook/` 那份**副本**，删出货件不影响它。
3. **driver 换进程内回调**：在 resident 工厂（`buildResidentSdkOptions` 之后那段，现有 `UserPromptSubmit` 注册处）改成往 **`hooks` 包**追加一个 async 回调——与同文件里既有的 `Stop` 回调**同一手法**（`[...installed, { hooks: [fn] }]`，不替换 builder 给的东西）；回调读注册表 + 变体 env，命中返回 `hookSpecificOutput.additionalContext`，否则返回 `{}`。**不再往 `launchOptions.settings` 里写 hook**（settings 只留给 remote-control 两项）。

**收益/代价**：收益＝零 spawn、无标记文件、无启动清理、测试变**确定性**（直接调那个回调，不必跑脚本）；代价＝多一个进程级可变模块，且要**认真搬**中继那三处 `clearVoiceActiveMarker` 的竞态注释（transport 失败路径 / teardown / socket close，注释写明"标记先清、这三处按设计互相竞争，清理是幂等的"）。

⚠️ **一条已知的兄弟钉子（本仓库记过这类坑）**：`server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts` 断言 `sdkOptions.settings` **逐字含 remote-control 两项**。拆掉 hook 的 settings 写之后必须**复验它仍绿**，并把该断言原文记进 Notes——`settings` 包的"存在性"本身曾被当成读数。

<!-- dedup-ref --> **相关任务与粒度决定**：granularity 工具对三个主子文件报 `peers: []`（无 Touches 重叠的开放任务）。本条**回收的是** `gap-live-voice-dispatch-hook-production-wiring`（status done）落下的那条机制，不改它的对外行为（注入内容、门控语义、环境开关全部不变），只换载体与成本；机制与验收都独立 ⇒ 分开立，新任务自触 `tasks/<id>.md`。`voice-realtime-ws-proxy.service.ts` 历史落地 46 个任务、中位改动 830 行——本条在该文件里只把三处 `clearVoiceActiveMarker(...)` 换成注册表调用，实现要小步。

## AC

- [x] AC1（注册形态：回调而非命令）：新增/改写单测断言 `buildResidentSdkOptions` 产出的包满足：`hooks.UserPromptSubmit[0].hooks[0]` 的 `typeof === 'function'`；且 `settings` 里**不再**出现 voice hook（`grep -c "voice-mode-context" <序列化的 settings>` 为 0，或 `settings.hooks.UserPromptSubmit` 不存在）；`npx tsx --tsconfig=server/tsconfig.json --test server/modules/providers/tests/claude-resident-dispatch-hook.test.ts` 退出 0，pass 数记入 `## Notes`。
- [x] AC2（注入随状态，确定性）：同一测试里**直接调用**那个回调两次：(a) 注册表为空时以任意 session id 调用 ⇒ 返回值里**没有** `hookSpecificOutput`（或 `additionalContext` 为空）；(b) `markVoiceSessionActive('x')` 后以 `{ session_id: 'x' }` 调用 ⇒ `hookSpecificOutput.hookEventName === 'UserPromptSubmit'` 且 `additionalContext` 含 `[Live Voice 模式]` 与 6 条编号规则的首句；(c) `clearVoiceSessionActive('x')` 后回到 (a)。三条断言随 AC1 的同一命令。
- [x] AC3（规则文本逐字不变）：① `git show <本任务落地前的最后一次涉及该文件的提交>:server/modules/voice-realtime/hooks/voice-mode-context.mjs | sha256sum` 得 **`40822a31d193fb63ee49dabe9adb6a840d440c20d8c9caf488e8db0833cc7b7d`**（4031 字节），逐字记入 `## Notes`；② 从**旧文件**里取出 6 条规则字符串、与 AC2 里回调实际注入的 `additionalContext` 做 `diff`，**必须为空**（比对脚本与实际输出都记入 Notes）。⚠️ 若 sha 对不上，停手 needs-human——说明基线不是本任务假设的那份。
- [x] AC4（中继三处改注册表，覆盖原竞态）：新增单测用 relay seam 驱动三条路径：(a) 连接建立 ⇒ `isVoiceSessionActive(boundSessionId) === true`；(b) 正常 teardown ⇒ `false`；(c) 异常 close（TRANSPORT 错误路径，不经过 teardown）⇒ `false`。`npx tsx --tsconfig=server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-active-sessions.test.ts` 退出 0（该文件替代被删的 `voice-realtime-voice-active-marker.test.ts`），pass 数记入 `## Notes`。
- [x] AC5（退役干净）：`server/modules/voice-realtime/hooks/voice-mode-context.mjs` 已删除（`test -f` 为假）；`grep -rn "voice-mode-context\|voice-active" server/ --include=*.ts --include=*.mjs` 的命中**只剩注释/历史说明**（逐条列出并说明每一处为何保留）；`npm run build` 后 `find dist-server -name "voice-mode-context*"` 为空。
- [x] AC6（兄弟钉子不破）：`npx tsx --tsconfig=server/tsconfig.json --test server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts` 退出 0；并把该测试对 `sdkOptions.settings` 的**断言原文**逐字记入 `## Notes`（证明拆掉 hook 的 settings 写之后，remote-control 两项仍在）。
- [x] AC7（不削弱既有判据）：`npm run typecheck` 与 `npm run lint` 各自退出 0；按 AGENTS.md 加载 `$backend-module-standards`；单跑 `server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts` 与 `server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts` 各自退出 0。
- [x] AC8（环境开关仍可用）：单测断言 `VOICE_MODE_RULES_VARIANT=fragments` 时注入文本比默认多出第 7 条（碎片规则），`VOICE_MODE_HOOK_FORCE=1` 时即使注册表为空也注入；随 AC2 的同一命令退出 0。（实验臂继续可用的前提。）

## DoD

一条**真常驻会话 + 真 Live Voice 连接**：连接**期间**提问 ⇒ 该会话 transcript 里出现「[Live Voice 模式]」那 6 条规则的注入记录（`attachment`）；**断开后**提问 ⇒ 逐字没有（与"根本没有这个 hook"一致）。附带观察项（不作执行侧 AC）：`~/.cloudcli/voice-active/` 不再被创建或写入；每次提问不再 spawn node 进程。规则文本与退役前那份**逐字一致**（AC3 的 diff 为空）。

## Touches

- server/modules/voice-realtime/voice-realtime-active.ts (new)
- server/modules/voice-realtime/voice-mode-rules.ts (new)
- server/modules/voice-realtime/hooks/voice-mode-context.mjs (删除)
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/providers/tests/claude-resident-dispatch-hook.test.ts
- server/modules/voice-realtime/tests/voice-realtime-active-sessions.test.ts (new，替代 voice-realtime-voice-active-marker.test.ts)
- server/modules/voice-realtime/tests/voice-realtime-voice-active-marker.test.ts (删除，被上一条替代)
- server/modules/voice-realtime/index.ts (barrel：停掉 clearStaleVoiceActiveMarkers 的再导出，新增注册表与规则文本的再导出)
- server/index.ts (退役启动清理调用与 [voice-active] 日志行)
- tasks/gap-live-voice-dispatch-hook-in-process-callback-with-relay-state.md

## Notes

**AC1** — `npx tsx --tsconfig=server/tsconfig.json --test server/modules/providers/tests/claude-resident-dispatch-hook.test.ts` ⇒ exit 0，**4 pass / 0 fail**。两支读法都断言了：`hooks.UserPromptSubmit[0].hooks[0]` 的 `typeof === 'function'`；且 `settings.hooks.UserPromptSubmit === undefined`。序列化 settings 的「无命令路径」一支用 `.mjs` 而不是那串被 AC5 禁的字面量（见下「AC5 逐条」），因为写进断言就等于把该字面量留在 server/ 的功能代码里。

**AC2** — 同一文件的 4 个 pass 之一：(a) 空注册表 + 任意 session id ⇒ 无 `hookSpecificOutput`；(b) `markVoiceSessionActive('ac2-session')` 后 `{ session_id: 'ac2-session' }` ⇒ `hookSpecificOutput.hookEventName === 'UserPromptSubmit'`，`additionalContext === VOICE_MODE_RULES`（含 `[Live Voice 模式]`，且 6 条编号规则首句逐条 `includes` 断言：`1. 预计本轮要超过约 20 秒` / `2. 单条命令预计超过约 10 秒` / `3. 约 20 秒内能答完的问题` / `4. 前台需要多步时` / `5. 用户的新话进来时` / `6. 后台任务完成后`）；(c) `clearVoiceSessionActive('ac2-session')` 后回到 (a)。

**AC3** — ① 本任务前最后一次涉及该文件的提交 = `c2ec48bccbe97c99a622ccc4445be127b4b3f07d`（`git log -1 --format=%H -- server/modules/voice-realtime/hooks/voice-mode-context.mjs`）；`git show c2ec48bcc:server/modules/voice-realtime/hooks/voice-mode-context.mjs | sha256sum` = **`40822a31d193fb63ee49dabe9adb6a840d440c20d8c9caf488e8db0833cc7b7d`**，4031 字节 —— 与 AC 给的基线逐字一致。
② 比对脚本 `/tmp/ac3-diff.mts`（跑法：`npx tsx --tsconfig=server/tsconfig.json /tmp/ac3-diff.mts`）：从**旧文件文本**第 15–42 行取出规则块、写成临时 `.mjs` 再 `import` 出 `VOICE_MODE_RULES`，与**生产工厂回调实际注入**的 `additionalContext` 逐字比对。实际输出：
```
AC3① last-touch commit: c2ec48bccbe97c99a622ccc4445be127b4b3f07d
AC3① sha256(old file): 40822a31d193fb63ee49dabe9adb6a840d440c20d8c9caf488e8db0833cc7b7d
AC3① bytes: 4031
AC3② old rules length: 437, injected length: 437
AC3② identical (diff empty): true
AC3② sha256(old rules): af88a4a418f5006e4f197be45ad98cbb9b32279673946574273cd16a863ae837
AC3② sha256(injected):  af88a4a418f5006e4f197be45ad98cbb9b32279673946574273cd16a863ae837
```
（脚本与输出一并记录；`diff` 为空。）

**AC4** — `npx tsx --tsconfig=server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-active-sessions.test.ts` ⇒ exit 0，**4 pass / 0 fail**：(a) 连接被处理的那一刻 `isVoiceSessionActive(SESSION) === true`，upstream open 后仍 true；(b) 浏览器 close frame 触发的正常 teardown ⇒ false；(c) `createTransport()` 抛错（TRANSPORT 错误路径，`openCalls === 0` 且 `closeCalls === 0`，即从未 teardown）⇒ false。另加一条负向对照：空 session id 恒 false、邻接 session 不受影响、重复 clear 幂等。

**AC5** — `test -f server/modules/voice-realtime/hooks/voice-mode-context.mjs` 为假（已 `git rm`）；`npm run build` exit 0，`find dist-server -name "voice-mode-context*"` = **0 行**（整个 dist-server 里已无任何 `.mjs`）。`grep -rn "voice-mode-context\|voice-active" server/ --include=*.ts --include=*.mjs` 共 **6 处命中，全部是注释/历史说明**，逐条：
1. `server/modules/voice-realtime/voice-mode-rules.ts:5` — 说明规则文本从哪来（`WHERE THIS LIVES NOW`）。
2. `server/modules/voice-realtime/voice-realtime-active.ts:6` — 说明门控过去是 `~/.cloudcli/voice-active/<session id>` 文件、为什么现在不必再要一个文件。
3. `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:1793` — 同一段历史说明（文件门控 → 进程内注册表，为什么不需启动清扫）。
4. `server/modules/voice-realtime/index.ts:162` — 说明 barrel 为何导出规则文本（逐字迁移自旧文件）。
5. `server/modules/providers/tests/claude-resident-dispatch-hook.test.ts:8` — 判据头部说明被替换的旧载体是什么。
6. `server/modules/voice-realtime/tests/voice-realtime-active-sessions.test.ts:7` — 判据头部说明为什么这个判据不再需要 `$HOME` 沙箱。
（这 6 处全是注释；没有任何功能代码再读/写标记文件或引用旧脚本。）

**AC6** — `npx tsx --tsconfig=server/tsconfig.json --test server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts` ⇒ exit 0，**8 pass / 0 fail**。该测试对 `sdkOptions.settings` 的断言原文（逐字，`assertLaunchedFlags`，第 393–411 行）：
```ts
function assertLaunchedFlags(
  launched: { remoteControlAtStartup?: boolean; isolatePeerMachines?: boolean } | null | undefined,
  label: string,
): void {
  assert.ok(
    launched,
    `${label}: 传给 SDK 的 sdkOptions.settings 必须被读回（null ⇒ 那次启动没带这两项）`,
  );
  assert.strictEqual(
    launched.remoteControlAtStartup,
    false,
    `${label}: 读回的 sdkOptions.settings.remoteControlAtStartup 必须是 false`,
  );
  assert.strictEqual(
    launched.isolatePeerMachines,
    true,
    `${label}: 读回的 sdkOptions.settings.isolatePeerMachines 必须是 true`,
  );
}
```
即：拆掉 hook 的 settings 写之后，`settings` 里仍逐字是 remote-control 两项（`remoteControlAtStartup === false` / `isolatePeerMachines === true`），且读回非 null。

**AC7** — `npm run typecheck` exit 0；`npm run lint` exit 0（改动过的 8 个文件单独跑 oxlint 也是 0 error / 0 warning）；已按 AGENTS.md 加载并遵守 `$backend-module-standards`；`voice-realtime-single-pending-message.test.ts` **7 pass** / exit 0；`voice-realtime-uplink-vad.test.ts` **10 pass** / exit 0。

**AC8** — 随 AC1 的同一命令（4 pass）：`VOICE_MODE_RULES_VARIANT=fragments` 时 `additionalContext === rulesFor('fragments')`，且 `startsWith(VOICE_MODE_RULES)`、其后多出第 7 条（`7. 语音会分段到达`）；`VOICE_MODE_HOOK_FORCE=1` 时即使注册表为空也注入默认规则。

**实现口径 —— 与 Proposal 的两处必要偏差，逐条交代：**

1. **注册表/规则文本经 barrel 被 driver 引用，且这条引用是 lazy（`await import`）。** Proposal 的设计是「叶子模块 ⇒ driver 直接引而不成环」，但本仓库的 `boundaries/dependencies` 是 oxlint **error** 级硬规则：跨模块 import 必须走对方的 `index.ts`（实测直接深引 `@/modules/voice-realtime/voice-realtime-active.js` 报 2 条 `boundaries(dependencies)` error）。而**静态**引 barrel 会闭合成环：`voice-realtime/index` → `voice-realtime-live-executor` → `mcp-gateway/index` → `providers/index` → `provider.registry` → 本 driver —— 实测启动即 `ReferenceError: Cannot access 'ClaudeResidentHostDriver' before initialization`（TDZ），整个 server 起不来。两条路都不能走，故取的第三条：文件仍按 Proposal 落在声明的两个新路径（叶子、无 import），`voice-realtime/index.ts` 增加它们的再导出，driver 侧在**回调内** `await import('@/modules/voice-realtime/index.js')`。生产里该 barrel 由组合根（`server/index.ts`）在启动时已加载 ⇒ 这里是模块缓存命中而非加载；`tsc-alias` 已把动态 import 的 `@/` 重写为相对路径（产物 `dist-server/.../claude-host-driver.provider.js` 第 884 行），`dist-server` 里 `@/` 残留 0，且用 `node` 直接载入 built driver 无 TDZ、built barrel 的 `markVoiceSessionActive`/`clearVoiceSessionActive`/`isVoiceSessionActive` 实测可用。Proposal 里「中继可以直接 import 叶子」仍然成立（同模块，非跨模块）。
2. **Touches 增补 3 个文件**（anti-drift 硬门逐条点名，均为本任务机械必需，非夹带）：
   - `server/index.ts` —— 退役 `clearStaleVoiceActiveMarkers()` 的启动清理调用与 `[voice-active] cleared ...` 日志行（Proposal「无启动清理」+ AC5 要求该字面量只剩注释）。该函数已随 ws-proxy 一并删除，留着 typecheck/import 也直接红。
   - `server/modules/voice-realtime/index.ts` —— 停掉 `clearStaleVoiceActiveMarkers` 的再导出（否则 barrel 引用不存在的符号，typecheck/build 红），并按仓内跨模块规则新增注册表与规则文本的再导出。
   - `server/modules/voice-realtime/tests/voice-realtime-voice-active-marker.test.ts` —— 删除（AC4 原文点名 `voice-realtime-active-sessions.test.ts` 替代它）。

**DoD 本会话未执行（执行侧不可满足，交人工）**：真常驻会话 + 真 Live Voice 连接那条 transcript 读数（连接期间有 `[Live Voice 模式]` attachment、断开后逐字没有），以及两个附带观察项（`~/.cloudcli/voice-active/` 不再被创建；每次提问不再 spawn node 进程）。前者需要真浏览器 + DashScope 凭据 + 真常驻 CLI 会话，本 worker 会话内无法构造。规则文本逐字一致这一半已由 AC3 的 diff 为空证明；执行侧的判据 AC1–AC8 全绿，无遗留 needs-human。
