---
id: gap-ac459-criterion-stale-architecture-panel-send-site
title: AC-459 判据仍钉 ArchitecturePanel.tsx 的 send 落点：residual-oversize 拆分后调用已移入
  useArchitecturePanelActions，改钉组合链与唯一调用点
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-459
---
## Proposal

### 现场读数（2026-11-14，直接重跑判据）

AC-459 的 criterion 逐字运行：

```bash
npx tsx --tsconfig server/tsconfig.json --test electron/tests/cloudpit-runtime-identity-surfaces.test.mjs
```

exit 1，tests 10 / pass 9 / fail 1，唯一红：

```
✖ AC-459 expect: one BroadcastChannel name feeds both architecture surfaces
  AssertionError: the standalone architecture page sends over the bridge
  ...
  expected: /sendArchitectureChatMessage/
  at electron/tests/cloudpit-runtime-identity-surfaces.test.mjs:313:10
```

活代码面本身没有旧名残留：同轮 AC2 的零命中扫描通过（`filesScanned >= 20`），IPC / contextBridge / 语义面 / 非目标面各臂全绿。失败的是判据 BroadcastChannel 用例的**落点读数**，不是身份面本身。

### 根因

`52e5a74ca refactor(architecture): split ArchitecturePanel into an owner hook and leaf views`（任务 `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`）把面板的 action 半边搬进新文件，`sendArchitectureChatMessage` 的调用点从 `ArchitecturePanel.tsx` 移到 `src/modules/architecture/render/useArchitecturePanelActions.ts:115`。现在的组合链是：

```
ArchitecturePanel.tsx:1794          → <ArchitecturePanelShell model={model} />
architecturePanelShell.tsx:94       → <ArchitecturePanelReadyView model={model} />
architecturePanelReadyView.tsx:37   → useArchitecturePanelActions({...})
useArchitecturePanelActions.ts:115  → sendArchitectureChatMessage({ sessionId, text })   // 仅 standalone 分支
architectureChatBridge.ts           → new BroadcastChannel(ARCHITECTURE_CHAT_CHANNEL)
```

不变式仍然成立：channel 常量仍是 `export const ARCHITECTURE_CHAT_CHANNEL = 'cloudpit-architecture';`，`new BroadcastChannel(...)` 仍恰好一次且用该常量，工作区标签页的接收 hook 仍从 `src/modules/architecture/index.ts` 导出，独立页仍通过上面的链发送。判据只是把读数钉死在一个不再承载该调用的叶子文件上。

### 更早的修复为什么没保住

<!-- dedup-ref -->
去重：`gap-ac459-criterion-stale-architecture-split-paths`（done）与本任务修的是同一判据的不同环——它把读数从拆分前的 `src/modules/architecture/ArchitecturePanel.tsx` 改到 `render/ArchitecturePanel.tsx`，当时正确；`gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`（done）是这次造成漂移的拆分任务。两者都已 done，不构成在飞重复，也不是本任务的前置。

residual-oversize 拆分任务的 Touches 只声明了 `src/modules/architecture/render/*`，**没有声明 `electron/tests/cloudpit-runtime-identity-surfaces.test.mjs`**，于是拆分 diff 不在判据文件的变更面内，判据没有随调用点一起搬，下一轮重跑即真红。这也是本次修法要从「钉一个叶子文件」升级为「钉整条组合链 + 唯一调用点」的原因：下次再拆时失败信息会指向断掉的那一环，而不是又一次无声的路径漂移。

### 修法（保留不变式，不做真空绿）

在判据文件里把 BroadcastChannel 用例的正臂改成：

1. bridge 断言原样保留：`export const ARCHITECTURE_CHAT_CHANNEL = 'cloudpit-architecture';` 逐字、`new BroadcastChannel(...)` 恰好一次且使用该常量。
2. 新增可注入 root 的 `architectureSendChain(root)` 读数，逐环检查：
   - `ArchitecturePanel.tsx` 含 `ArchitecturePanelShell`；
   - `architecturePanelShell.tsx` 含 `ArchitecturePanelReadyView`；
   - `architecturePanelReadyView.tsx` 含 `useArchitecturePanelActions`；
   - `useArchitecturePanelActions.ts` 含 `sendArchitectureChatMessage(` 调用；
   - 在 `src/modules/architecture/`（排除 `tests/` 与 bridge 的定义文件）内统计 `sendArchitectureChatMessage(` 的调用文件，要求**恰好一个**且就是 actions hook。
3. 断言该调用位于 `standalone` 分支内（`if (standalone)` 在源码中的位置先于该调用），保留「独立页才走 channel、内嵌标签页写自己的草稿」这一语义。
4. 接收面断言原样保留：`src/modules/architecture/index.ts` 含 `useArchitectureChatBridge` 与 `render/architectureChatBridge`。
5. 负臂（`tmp/` 夹具 + 注入 root，沿用本文件既有的 `makeFixtureRoot` / `writeFixtureFile` 模式）：
   - 夹具里 actions hook 不含该调用 ⇒ `architectureSendChain` 报出断环，用例必须红；
   - 夹具里另加一个 render 文件的第二个调用点 ⇒ caller 计数为 2，用例必须红。
6. 不删除任何既有臂（AC2 零命中 + 非真空、AC3 注入旧名变红、AC4 非目标面健在、AC6 历史账本、IPC/preload/desktopWindow 三处一致、contextBridge 两个名字、语义面同步面清单），不把任何断言降级为「文件存在即绿」。

### 非目标

- 本任务预期 diff 只有判据文件与任务文件自身，不改活代码。若执行中发现在不弱化断言的前提下无法只靠改判据转绿（例如链真的断了），才允许改 `src/modules/architecture/render/` 下的链文件，并在提交前把对应文件补进 Touches、在任务里说明。
- 历史账本（`tasks/`、`goals/`、`adr/`、`experiments/`、`docs/proposals/`、`CHANGELOG`）按 GOAL-054 非目标不修改。
- `cloudcli.ai`、`cloudcli://auth/callback`、`app_surface=cloudcli_desktop`、`LEGACY_DESKTOP_APP_ID = 'ai.cloudcli.desktop'`、`cloudcli://session|architecture` 解析为 null 全部保持原样。

## AC

- [ ] AC1: `npx tsx --tsconfig server/tsconfig.json --test electron/tests/cloudpit-runtime-identity-surfaces.test.mjs` 退出 0，`fail 0`，且 `pass` ≥ 10；把尾部输出（tests/pass/fail 计数与 `✔ AC-459 expect: one BroadcastChannel name feeds both architecture surfaces`）贴进任务。
- [ ] AC2: 判据的 BroadcastChannel 正臂不再对单个叶子文件断言 `sendArchitectureChatMessage`，改为 `architectureSendChain(root)`：四个链文件逐环命中，`src/modules/architecture/`（排除 `tests/` 与 bridge 定义）内 `sendArchitectureChatMessage(` 的调用文件恰好一个且为 `useArchitecturePanelActions.ts`；`grep -n "architectureSendChain" electron/tests/cloudpit-runtime-identity-surfaces.test.mjs` 非空可复核。
- [ ] AC3: 负臂实测（贴输出）：`tmp/` 夹具删掉 actions hook 的调用 ⇒ 该用例红；`tmp/` 夹具增加第二个调用文件 ⇒ 该用例红；两臂都走注入 root，不碰活代码。
- [ ] AC4: 既有臂逐条保留并同轮通过：AC2 零命中且 `filesScanned >= 20`、AC3 两条注入旧名变红、AC4 非目标面夹具与活面断言、AC6 历史账本、IPC/preload/desktopWindow 三处一致、contextBridge 两个名字、语义面同步面清单；`git diff` 显示判据文件外无非目标面改动。
- [ ] AC5: 非目标面未被为凑零命中而改写：`electron/appIdMigration.js` 仍有 `LEGACY_DESKTOP_APP_ID` 且活值 `APP_USER_MODEL_ID` 仍是 `ai.cloudpit.desktop`；`cloudcli://session|architecture` 仍在 `src/modules/cockpit/tests/observationUri.test.ts` 钉为 null；`git diff --stat` 证明 `tasks/ goals/ adr/ experiments/ docs/proposals/ CHANGELOG` 无改动。
- [ ] AC6: `git diff --stat` 只含 `electron/tests/cloudpit-runtime-identity-surfaces.test.mjs` 与 `tasks/gap-ac459-criterion-stale-architecture-panel-send-site.md`（若链真断需改代码，则按 Proposal 非目标补 Touches 并在任务里说明）。

## DoD

- 判据文件在 worktree 内改完并提交；同一 worktree 内从 exit 1 / 9 pass 变 exit 0 / ≥10 pass，命令、exit code 与尾部输出贴进任务。
- 负臂是实测而非描述：两条夹具臂各自变红的实际输出在任务里可见；同一正臂在活代码根上为绿。
- 既有臂一条不少：删臂、把断言降级为存在性检查、或为凑零命中改写 AC4 的非目标面，任一出现都算未完成。
- 提交包含判据文件与任务文件自身，`git status` 干净；任务顶层 `goal_ac: AC-459` 保留，下一轮 driver 可直接独立复验。

## Touches

- `electron/tests/cloudpit-runtime-identity-surfaces.test.mjs`
- `tasks/gap-ac459-criterion-stale-architecture-panel-send-site.md`
