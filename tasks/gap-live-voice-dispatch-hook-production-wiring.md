---
id: gap-live-voice-dispatch-hook-production-wiring
title: Live Voice 第 1 层 hook 生产落地：前台只做调度的规则注入 + 中继在连接建立/拆除时写删 voice-active 标记文件
status: todo
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

- [ ] AC1（无标记 ⇒ 逐字节无输出）：`echo '{"session_id":"no-such-session"}' | node server/modules/voice-realtime/hooks/voice-mode-context.mjs | wc -c` 得 **0**，且整条命令退出 0。
- [ ] AC2（有标记 ⇒ 注入规则）：`mkdir -p ~/.cloudcli/voice-active && touch ~/.cloudcli/voice-active/abc && echo '{"session_id":"abc"}' | node server/modules/voice-realtime/hooks/voice-mode-context.mjs` 的 stdout 是 JSON：`hookSpecificOutput.hookEventName === "UserPromptSubmit"`，且 `additionalContext` 同时含 `[Live Voice 模式]` 与 6 条编号规则的首句；`rm ~/.cloudcli/voice-active/abc` 后重跑回到 0 字节。断言用 `jq`/`python3`，不用肉眼。
- [ ] AC3（driver 注册且不替换既有 hooks）：新增单测断言 resident launch 的 hooks 包**同时**含 `Stop` 与 `UserPromptSubmit`，`UserPromptSubmit[0].hooks[0].command` 指向**由模块位置派生**的 hook 路径，且该路径在磁盘上存在；`npx tsx --tsconfig=server/tsconfig.json --test server/modules/providers/tests/claude-resident-dispatch-hook.test.ts` 退出 0，pass 数记入 `## Notes`。
- [ ] AC4（中继写/删标记，三条路径）：新增单测用既有 relay seam 驱动：(a) 连接建立 ⇒ `~/.cloudcli/voice-active/<boundSessionId>` 存在；(b) 正常 teardown ⇒ 已删除；(c) 异常 close（不经过 teardown）⇒ 同样已删除。`npx tsx --tsconfig=server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-voice-active-marker.test.ts` 退出 0，pass 数记入 `## Notes`。
- [ ] AC5（假形态）：临时把 driver 里注册 `UserPromptSubmit` 的那几行注释掉 ⇒ AC3 的用例**必须红**；复原后变绿。红、绿读数逐字记入 `## Notes`（改动不提交）。
- [ ] AC6（陈旧标记清理）：服务端启动路径清空 `~/.cloudcli/voice-active/`；单测预先放一个陈旧标记文件 ⇒ 启动后该目录为空。随 AC4 的同一命令退出 0。
- [ ] AC7（不削弱既有判据）：`npm run typecheck` 与 `npm run lint` 各自退出 0；按 AGENTS.md 加载 `$backend-module-standards`；单跑 `server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts` 退出 0。

## DoD

一条**真常驻会话**（从 app 起，或走既有 Live Voice e2e 装置）在 Live Voice 连接建立后，`~/.cloudcli/voice-active/<其 session id>` 出现，且该会话的下一轮**实际带上了规则注入**（可在该会话的 transcript/钩子输出里读到「[Live Voice 模式]」及其 6 条规则）；断开连接后标记消失，同一会话再发一轮时注入为空——即与会话没有这个 hook 时逐字节相同。出货的规则文本与实验产出**逐字一致**（`diff` 为空）。

## Touches

- server/modules/voice-realtime/hooks/voice-mode-context.mjs (new)
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/providers/tests/claude-resident-dispatch-hook.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-voice-active-marker.test.ts (new)
- tasks/gap-live-voice-dispatch-hook-production-wiring.md
