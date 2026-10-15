---
id: gap-live-voice-dispatch-hook-production-wiring
title: Live Voice 第 1 层 hook 生产落地：前台只做调度的规则注入 + 中继在连接建立/拆除时写删 voice-active 标记文件
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**来源：X3' 回放实验（2026-10-15，`experiments/voice-now-priority/REPORT.md`）**——10 个真实忙时语音片段 × 5 臂 × 2 次，有效 84 次（A 16 / B 16 / C 16 / D 16 / E 20），全部 sonnet，且用生产的启动参数（`experiments/voice-now-priority/resident-launch.mts` 直接调 `buildResidentSdkOptions`，偏离逐条写在该文件里）。

规则文本与门控**已由实验产出，可直接复用、不重写**：`experiments/voice-foreground-background/hook/voice-mode-context.mjs`（54 行：`VOICE_MODE_RULES` 6 条 + 门控 + 两个实验变体）。本任务只做"落地为生产物 + 接线"。（第 7 条碎片规则的改写**另立任务**，见本仓另一条。）

有效口径读数（hook 关 = A，hook 开 = B–E）：
- **派后台的 run：A 0/16 vs B–E 9–10/16–20**；前台工具调用 7.9/轮 → 2.6–3.6/轮（94 次口径）。
- **「接话」提前**：`b5d01c21` 用户 23.0 s 说的改道，A 要等开场那个长 turn 跑到 56.4 s 才被读到；B–E 因开场先把工作派后台，turn 在 ~20 s 收尾，改道 24 s 就被读到。
- 规则阈值依据（`experiments/voice-foreground-background/analyze-turns.mjs`，25 个语音会话 / 172 个语音触发的前台 turn）：> 20 s 的 turn 占 45% 却占前台总时长 90%；前台时间 75% 是模型自己在想/写。

**落地形态（三处）**：

1. **hook 脚本落到出货树**：`server/modules/voice-realtime/hooks/voice-mode-context.mjs`。规则文本**逐字沿用**实验文件；门控保持"标记文件存在才注入"；`VOICE_MODE_HOOK_FORCE` 与 `VOICE_MODE_RULES_VARIANT` 两个实验开关**保留**（后续实验臂要用），生产默认不设。
2. **driver 注册 `UserPromptSubmit`**：在 `claude-host-driver.provider.ts` 里往 launch 的 hooks 包**追加**一组——与既有 `Stop` 钩子同一手法（`[...installed, { hooks: [...] }]`，**不替换** builder 给的东西）。`command` 的路径必须**从模块自身位置派生**（`import.meta.url`），不得写仓库绝对路径字面量：生产 laydown/打包形态与 dev 不同，字面量会静默失效。
3. **中继写/删标记**：`voice-realtime-ws-proxy.service.ts` 在 Live Voice 连接建立时创建 `~/.cloudcli/voice-active/<boundSessionId>`；在**正常拆除**与**异常 close**两条路径上都删除；服务端启动时清空该目录（防崩溃留下陈旧标记 ⇒ 没有语音连接也一直注入规则）。

**已知边界，写进报告、不算本任务失败**：hook 是**提示级**规则，遵从率不满——`af12cbaf` 的 20 份 digest 里 B/C/D/E **无一处 `[ BG]`**：开场那条 `sleep 30`（单条命令 >10 s，按规则该进后台 Bash）四臂都前台跑完。所以验收只看"规则被注入 + 行为方向确实改变（派后台显著增多）"，不承诺 100% 遵从。

<!-- dedup-ref --> **相关任务与粒度决定**：granularity 工具对两个主子文件报 `peers: []`（无 Touches 重叠的开放任务）；机制查重也未命中（`gap-live-voice-*` 相邻任务均已 done/superseded）。与 `gap-voice-relay-busy-hold-host-rounds-and-queue-visibility`（status done）共享 `voice-realtime-ws-proxy.service.ts`，但那一条改的是忙时 hold 的读数与卡片可见性，本任务只在该文件里加"标记文件的写/删"，机制独立 ⇒ **分开立**，调度器按 Touches 串行。该文件历史落地 44 个任务、中位改动 90 行，属高频文件，实现要小步。

## AC

- [x] AC1（无标记 ⇒ 逐字节无输出）：`echo '{"session_id":"no-such-session"}' | node server/modules/voice-realtime/hooks/voice-mode-context.mjs | wc -c` 得 **0**，且整条命令退出 0。
- [x] AC2（有标记 ⇒ 注入规则）：`mkdir -p ~/.cloudcli/voice-active && touch ~/.cloudcli/voice-active/abc && echo '{"session_id":"abc"}' | node server/modules/voice-realtime/hooks/voice-mode-context.mjs` 的 stdout 是 JSON：`hookSpecificOutput.hookEventName === "UserPromptSubmit"`，且 `additionalContext` 同时含 `[Live Voice 模式]` 与 6 条编号规则的首句；`rm ~/.cloudcli/voice-active/abc` 后重跑回到 0 字节。断言用 `jq`/`python3`，不用肉眼。
- [x] AC3（driver 注册且不替换既有 hooks）：新增单测断言 resident launch 的 hooks 包**同时**含 `Stop` 与 `UserPromptSubmit`，`UserPromptSubmit[0].hooks[0].command` 指向**由模块位置派生**的 hook 路径，且该路径在磁盘上存在；`npx tsx --tsconfig=server/tsconfig.json --test server/modules/providers/tests/claude-resident-dispatch-hook.test.ts` 退出 0，pass 数记入 `## Notes`。
- [x] AC4（中继写/删标记，三条路径）：新增单测用既有 relay seam 驱动：(a) 连接建立 ⇒ `~/.cloudcli/voice-active/<boundSessionId>` 存在；(b) 正常 teardown ⇒ 已删除；(c) 异常 close（不经过 teardown）⇒ 同样已删除。`npx tsx --tsconfig=server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-voice-active-marker.test.ts` 退出 0，pass 数记入 `## Notes`。
- [x] AC5（假形态）：临时把 driver 里注册 `UserPromptSubmit` 的那几行注释掉 ⇒ AC3 的用例**必须红**；复原后变绿。红、绿读数逐字记入 `## Notes`（改动不提交）。
- [x] AC6（陈旧标记清理）：服务端启动路径清空 `~/.cloudcli/voice-active/`；单测预先放一个陈旧标记文件 ⇒ 启动后该目录为空。随 AC4 的同一命令退出 0。
- [x] AC7（不削弱既有判据）：`npm run typecheck` 与 `npm run lint` 各自退出 0；按 AGENTS.md 加载 `$backend-module-standards`；单跑 `server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts` 退出 0。

## DoD

一条**真常驻会话**（从 app 起，或走既有 Live Voice e2e 装置）在 Live Voice 连接建立后，`~/.cloudcli/voice-active/<其 session id>` 出现，且该会话的下一轮**实际带上了规则注入**（可在该会话的 transcript/钩子输出里读到「[Live Voice 模式]」及其 6 条规则）；断开连接后标记消失，同一会话再发一轮时注入为空——即与会话没有这个 hook 时逐字节相同。出货的规则文本与实验产出**逐字一致**（`diff` 为空）。

## Touches

- server/modules/voice-realtime/hooks/voice-mode-context.mjs (new)
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/providers/tests/claude-resident-dispatch-hook.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-voice-active-marker.test.ts (new)
- server/modules/voice-realtime/index.ts
- server/index.ts
- server/tsconfig.json
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-live-voice-dispatch-hook-production-wiring.md

## Notes

**读数（AC3 / AC4 / AC6 / AC7）**

- AC3：`npx tsx --tsconfig=server/tsconfig.json --test server/modules/providers/tests/claude-resident-dispatch-hook.test.ts` → `tests 2 / pass 2 / fail 0`，exit 0。
- AC4 + AC6：`npx tsx --tsconfig=server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-voice-active-marker.test.ts` → `tests 4 / pass 4 / fail 0`，exit 0（含 AC6 的陈旧标记清理用例）。
- AC7：`npm run typecheck` exit 0；`npm run lint` exit 0（我方改动文件零告警，输出里只有仓库既有告警）；`npx tsx … --test server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts` → `tests 7 / pass 7 / fail 0`，exit 0。

（上面四条在 2026-10-15 本轮「merge develop 之后」的树上重跑，读数与上一轮一致。）

**AC5 假形态读数（逐字）**

把 `claude-host-driver.provider.ts` 里 `const voiceModeHookPath = join(` 到对应 `};`（原 1622–1645 行）整段注释掉后：

```
✖ AC3: a resident launch registers the Live Voice UserPromptSubmit command hook (36.779848ms)
✖ AC3: the append preserves the settings the launch already carried (0.552057ms)
ℹ tests 2 / ℹ pass 0 / ℹ fail 2        === RED EXIT=1 ===
AssertionError [ERR_ASSERTION]: the launch registers a UserPromptSubmit hook in the settings layer
```

复原后：`ℹ tests 2 / ℹ pass 2 / ℹ fail 0`，exit 0（GREEN）。改动未提交（`diff` 与该段备份逐字节相同）。

**实现决定（一处对题面字面的偏离，写在最显眼处）**

题面说 driver 往 launch 的 **hooks 包**追加 `{ hooks: [{ command }] }`。实现落在 **`settings.hooks.UserPromptSubmit`**，而不是 `sdkOptions.hooks`。原因是对真实 SDK 实测出来的：SDK 的 `hooks` 选项是**进程内回调通道**，`query()` 会把每个条目标成 `hookCallbackId` 再调用（`hookCallbacks.get(id)(input,…)`），把一个 `{ type: 'command', command }` 对象放进去只会得到

```
[cli] Error in hook callback hook_0: … error: n is not a function
```

而命令**永不执行**（探针 `/tmp/vhprobe3`，`fired.log` 不存在）。命令形态属于 CLI 的 settings schema；SDK 的 `settings` 选项填的是 flag-settings 层，会与其他 settings 源合并 —— 实测该路径**确实会执行**（`/tmp/vhprobe4`：同样形状经由 `query({options:{settings:{hooks:{…}}}})`，`fired.log` 出现）。AC3 断言读的就是这个位置，形状 `UserPromptSubmit[0].hooks[0].command` 与题面逐字一致。既有 `Stop` 钩子仍在 `sdkOptions.hooks` 里、未被替换（同一条用例断言）。

**DoD 的离线 A/B（不是部署读数，是同一份出货 hook + 真实 CLI）**

`/tmp/hooke2e/ab.sh`：`--settings` 里注册**出货树那份** `voice-mode-context.mjs`（`command` 为该文件的绝对路径，形状与 driver 产出的完全相同），`--session-id <uuid>`，抓 mock Anthropic 收到的请求体：

```
arm=no  prompt='alpha-probe' cli_exit=0 injected=False
arm=yes prompt='beta-probe'  cli_exit=0 injected=True
```

两臂唯一的差别是 `~/.cloudcli/voice-active/<该 session id>` 这个标记文件在不在 —— 即"标记存在 ⇒ 规则真的进了模型请求；标记不存在 ⇒ 模型请求里没有它"。`diff` 出货 hook 与实验产出：**空**（`cp` 逐字节复制）。

**Touches 增补的三个文件，以及为什么**

- `server/modules/voice-realtime/index.ts`、`server/index.ts`：AC6 要求"服务端启动路径清空该目录"。本仓既有先例是"模块导出 + `server/index.ts` 组合根调用"（`clearVoiceRealtimeCaptureDir` / `resolveVoiceRealtimeLogDir` 等启动读数都在那里）；barrel 只导出 `clearStaleVoiceActiveMarkers` 这一个跨模块消费者，其余三个 helper 只被同模块的用例 import，未进 barrel（backend-module-standards：不导出没有跨文件消费者的符号）。
- `server/tsconfig.json`：`include` 补 `./**/*.mjs`。`allowJs` 会把 `.mjs` 原样 emit（保留扩展名），不补的话 `tsc` 根本不把该文件收进 program，`dist-server/` 里就没有这个脚本，而 driver 派生的路径在编译形态下指向 `dist-server/server/modules/voice-realtime/hooks/voice-mode-context.mjs` —— 会静默指向一个不存在的文件。这正是题面警告的"字面量会静默失效"的同一种失败，所以补上；`--listFilesOnly` 已确认该文件在 program 里。

**其他**

- `voice-mode-context.mjs` 是 `server/modules/` 下的 JS 文件，与 backend-module-standards 的"模块内用 TypeScript"有张力。它是**被 CLI 作为 hook 命令执行的独立脚本**，从不被 server import，且题面在 Touches/AC1/AC2 三处逐字钉了这个 `.mjs` 路径与文件名，故按题面保留。

**第二轮（exited-not-landed 之后）：上轮 suite 两条红的定位与修复，以及 Touches 第五项**

上一轮的 suite 红了两条，**都不是环境噪声，都是我这一支 delta 造成的**（驱动自己的 baseline 复跑里两条都 `passed=true`：`.quay/fan-in-suite-gap-live-voice-dispatch-hook-production-wiring~wk-prod-anchor~baseline-1792054253428-5fa235.log`）。逐条定位如下：

1. **`server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts` 假形态 (b) 红 —— 我的 `settings` 写入把「没读到」变成了「读到空」。**
   用例 (4) 的契约是：一次**不传**那两项 flag 的启动，`host.remoteControl.launched` 必须是 `null`，于是 `assertLaunchedFlags` 的第一条断言以 `/必须被读回/` 打红。
   改动前 `buildResidentSdkOptions` 只在 `input.remoteControlFlags` 存在时才写 `sdkOptions.settings`，所以不传 flag 时 `sdkOptions.settings === undefined` ⇒ `readLaunchedRemoteControlSettings(undefined)` ⇒ `null` ⇒ 绿。
   我为了让 hook 落地，**无条件**给同一个 bag 写了 `settings`（`{ hooks: { UserPromptSubmit: [...] } }`），于是 `sdkOptions.settings` 恒为一个对象，`readLaunchedRemoteControlSettings` 走到末尾 `return launched` 返回 **`{}`** ⇒ 第一条断言不再命中，第二条以 `/必须是 false/` 抛 ⇒ 外层正则对不上 ⇒ 红。suite 里那条 `[remote-control] 假形态 (b)：不传 flags ⇒ 读回={}` 就是这个数。
   **修法（改生产，不改兄弟判据）**：`readLaunchedRemoteControlSettings` 在**两个 key 一个都没记到**时返回 `null`，而不是 `{}`。理由与函数自身契约一致：它读的是「这两项 flag，launch 是怎么说的」，一个只带了无关 key（hook、`applyClaudeEffort` 的 marker）的 bag 对这两项 flag 而言什么都没记到 —— `{}` 是一个没有任何消费者要过的形状，而且假形态腿分不出它和真读数。没有碰 `claude-resident-remote-control-isolation.test.ts` 一个字（AC7「不削弱既有判据」）。
   读数：改前（suite 工件）`ℹ tests 8 / pass 7 / fail 1`，`(4)` 腿红；改后同一条命令 `ℹ tests 8 / ℹ pass 8 / ℹ fail 0 / duration_ms 6558`，exit 0，日志里 `[remote-control] 假形态 (b)：不传 flags ⇒ 读回=null`。
   边界核对：`launchSettings` 全仓只被本文件产生、只被该用例与 `host.remoteControl.launched` 消费（`grep -rn launchSettings` 仅 4 处，全在两个文件内），所以这个读数的变化不会波及别的钉子。

2. **`server/shared/tests/quay-test-script.test.ts` AC2/AC3 红 —— 本任务新增 2 个服务器测试文件，把「收集到的服务器测试文件数」这个移动计数顶掉了。**
   该文件把收集数**钉成字面量**，且自己的注释就写明「the tree is a moving target, so the pin is re-measured, never derived」。实测：`find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort | wc -l` 在 develop 上是 **337**，在我这棵树上 **339** —— 差的正是本任务新增的 `claude-resident-dispatch-hook.test.ts` 与 `voice-realtime-voice-active-marker.test.ts`。suite 读数与之逐字吻合：AC2 `期望 unknown=334 实读 336`、AC3 `期望 unknown=336 实读 338`（两个 fixture 分别点名 3 个 / 1 个已知文件，337−3=334、337−1=336；339−3=336、339−1=338）。
   **修法**：按现树重钉这两个字面量（334→336、336→338），并把注释里的由来改成点明本任务的这两个文件。这与本仓既有先例同形（`gap-baseline-red-suite-count-pins-336`、以及把 336 顶成 337 的 `mcp-session-create` 那条：都是"本支在 develop 之上多带一个文件，于是 merged tree 的计数跟着动"）。
   ⚠️ 这里**不是**削弱判据：被钉的是**计数**不是**行为**，AC7 的覆盖率地板（`covered >= collected * 0.9`）没有动、仍绿。因为这条修复落在原 Touches 之外，`server/shared/tests/quay-test-script.test.ts` 已按 ABI 补进 `## Touches`（手改 task 文件到不了 fan-in）。
   读数：改前 suite `AC2`/`AC3` 红；改后同一条命令 `ℹ tests 14 / ℹ pass 14 / ℹ fail 0 / duration_ms 69824`，exit 0。
   时序注意：这两个计数是在**合并 develop 之后**的树上重量的（339），钉子按合并后的树钉，不是按合并前的。

**第二轮合并 develop**：`git merge --no-edit develop` 干净合并（develop 侧只动了本任务文件本身，即驱动记的未落地原因那一提交），无 unmerged path；合并后 `develop` 是 `HEAD` 的祖先。

## Blocker

**2026-10-15T08:52:25.979Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=7747 server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts passed=false end_ms=1792053830911
- run_id：wk-prod-anchor
- session_id：0387ac11-9d82-406f-8daf-b7c7cd2298a8
