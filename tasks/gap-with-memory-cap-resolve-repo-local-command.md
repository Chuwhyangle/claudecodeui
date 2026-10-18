---
id: gap-with-memory-cap-resolve-repo-local-command
title: scripts/with-memory-cap.sh 对裸命令回退到仓库 node_modules/.bin：让 AC-400 判据在
  driver PATH 下原样可运行
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-400
---
## Proposal

**现象（判据现在为假，且不是模块缺失）**：AC-400 的判据命令在验收环境（driver 的 PATH = `$QUAY_PLUGIN_DIR/bin` + slice shim + nvm 的 node 目录 + 系统目录，不含仓库 `node_modules/.bin`）下以 exit 1 失败，读数是 `Failed to find executable tsx: No such file or directory`（AC evidence 2026-10-18T09:11:17.577Z）。在共享 checkout 用同一 PATH 形态复现：同一条命令 exit 1、同一句报错；把 `node_modules/.bin` 前置到 PATH 后，同一命令 `ℹ tests 82 / ℹ pass 82 / ℹ fail 0`、exit 0。

**为什么上一个任务没有让它成立**：`gap-omission-fill-pure-module-and-parity`（done）确实落地了 `voice-realtime-omission-fill.ts`、测试与 63 例一致性夹具，但它的 AC1 是手工加 `PATH="$PWD/node_modules/.bin:$PATH"` 跑的（其 Notes 明写这一点）。这掩盖了判据**原样**在验收环境不可运行：产物存在，判据仍红。AC 必须现在为真，所以要修的是「wrapper 解析裸命令」这一环，而不是重写模块。

**改动**：`scripts/with-memory-cap.sh` 在两处 `exec` 之前加一段条件解析：若 `command -v -- "$1"` 失败，且 `<脚本所在仓库>/node_modules/.bin/$1` 可执行，则把 `$1` 替换为该绝对路径，其余参数原样保留。三条执行路径（`QUAY_MEMORY_MAX=0|off` 直通、无 systemd 的直通、systemd-run 封顶）共用该解析。找不到的命令保持原样失败，不会被回退掩盖。

为什么不无条件把 `node_modules/.bin` 前置到 PATH：那会改变所有经 wrapper 运行的命令的解析优先级（仓库本地 `tsc`/`vitest` 会遮蔽系统版本），超出本缺陷所需；条件回退只补「仓库内工具在裸 PATH 下不可达」这一种情况，PATH 上已有的同名命令永远优先。

**自测**：新增 `scripts/with-memory-cap-command-resolution.test.mjs`（node:test；用 `QUAY_MEMORY_MAX=off` 走直通分支，避免测试里起真实 cgroup），覆盖：裸 PATH 下 `tsx --version` 经回退成功；PATH 上已有同名命令时不回退（不遮蔽）；不存在的命令仍非 0；参数与退出码原样转发。

**范围**：不改 `voice-realtime-omission-fill.ts`、其测试与夹具（它们已存在且 82/82 绿），不改 AC-400 的判据文本；只让判据原样可运行。

<!-- dedup-ref -->相关但不同：`gap-omission-fill-pure-module-and-parity`（done，落地了模块，但判据运行时靠手工 PATH）；`gap-omission-fill-wire-into-ws-proxy`（ready）只是在 AC 命令里用到该 wrapper，`task-granularity-advice` 的 `peers=[]`（只有 prose `mentions`），Touches 不重叠，保持独立。

## AC

- [ ] AC1 判据原样（driver 形态的 PATH，不含 node_modules/.bin）退出 0：`env PATH="$(dirname "$(command -v node)"):/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin" bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-omission-fill.test.ts` → 退出码 0，输出含 `ℹ tests 82` 与 `ℹ fail 0`。
- [ ] AC2 回退命中且不遮蔽：同一 PATH 下 `env PATH="…同上…" bash scripts/with-memory-cap.sh tsx --version` 退出 0 且首行匹配 `tsx v`；再把一个打印 `PATH-WINS` 的假 `tsx` 放到 PATH 最前（`tmp=$(mktemp -d); printf '#!/bin/sh\necho PATH-WINS\n' > "$tmp/tsx"; chmod +x "$tmp/tsx"`），同一命令输出 `PATH-WINS`（证明 PATH 优先，回退只在找不到时发生）。
- [ ] AC3 负控制与参数转发：同一 PATH 下 `bash scripts/with-memory-cap.sh definitely-not-a-command-xyz` 退出码非 0；`bash scripts/with-memory-cap.sh bash -c 'exit 7'` 退出码恰为 7（参数与退出码原样转发）。
- [ ] AC4 既有行为回归：`node --test scripts/with-memory-cap-effective-default.test.mjs` → 全部通过（既有 6 例）；`QUAY_MEMORY_MAX=off bash scripts/with-memory-cap.sh true` → 退出 0；在正常（含 node_modules/.bin 的）PATH 下 `bash scripts/with-memory-cap.sh tsx --version` 仍退出 0。
- [ ] AC5 新自测：`node --test scripts/with-memory-cap-command-resolution.test.mjs` → 全部通过。

## DoD

真实落地标准：在 PATH 不含 `node_modules/.bin` 的环境里，AC-400 的判据命令**原样**退出 0，并贴出改动前后的对照读数：改动前同命令 exit 1 + `Failed to find executable tsx`，改动后 exit 0 + `ℹ tests 82 / ℹ pass 82 / ℹ fail 0`。同时贴出条件性证据：PATH 上的假 `tsx` 仍优先（输出 `PATH-WINS`），不存在的命令仍非 0。既有 `scripts/with-memory-cap-effective-default.test.mjs` 复跑全绿。未验证项：AC-400 的取假形态（覆盖度改成 `>`；取消 response 里的调用算已执行）由上一个任务记录过红色读数，本任务不动模块，故不重复演练；若执行中因任何原因改了模块，必须重读这两条假形态并恢复。

## Touches

- scripts/with-memory-cap.sh
- scripts/with-memory-cap-command-resolution.test.mjs (new)
- tasks/gap-with-memory-cap-resolve-repo-local-command.md
