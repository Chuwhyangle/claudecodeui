---
id: gap-ac364-supersede-after-sts-production-retirement
title: AC-364 与 2026-10-14「STS 已证实无效，取消生产调用」裁定冲突：判据的 e2e 腿因生产装配不再喂 silenceTail
  seam 而必红（journal 空）⇒ 把 AC-364 记录置 superseded 并写明理由，同步 GOAL-044 退出条件、把归档 spec
  移出默认 playwright 集合
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-364
---
## Proposal

### 判据现状（本轮直接复量，2026-10-14，仓库当前 HEAD）

AC-364 的判据逐字为

```
for f in server/modules/voice-realtime/tests/voice-realtime-silence-tail-suppression.test.ts e2e/voice-realtime-silence-tail-suppression.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-silence-tail-suppression.test.ts && npx playwright test e2e/voice-realtime-silence-tail-suppression.spec.ts
```

两条腿本轮实测：

- **服务端腿绿**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-silence-tail-suppression.test.ts` → `tests 13 / pass 13 / fail 0`，exit 0。
- **e2e 腿红**：`npx playwright test e2e/voice-realtime-silence-tail-suppression.spec.ts` → `1 passed`、`1 failed`、`2 did not run`，**exit 1**。失败用例 `… › the uploads stopped across the quiet stretch, and the gate recorded the episode`，报错逐字：

  ```
  Error: the journal must record the episode: []
  expect(received).toContain(expected)
  Expected value: "suppressed"
  Received array: []
      at e2e/voice-realtime-silence-tail-suppression.spec.ts:511:7
  ```

  即：真实服务进程里 `silence_tail` journal **一条都没有**——门控根本没有被构造。

### 机制（为什么现在必红，且不是「测试写错了」）

1. STS 是 GOAL-044 / AC-364 指定的**产品实现**：continuous 连线上偏向语音的本地静音检测、真实底噪 tail `T`、停传与前滚 `P` 恢复，开关 `VOICE_REALTIME_SILENCE_TAIL` **默认关闭**。AC-364 的 e2e 腿（`S-2`/`S-3`）要读的正是「上游收到的帧被门控裁剪、恢复时前滚成串补发」——这条读数只能由**真实服务进程装配出的门控**产生。
2. 人 yale **2026-10-14 裁定**：「STS 已证实无效，取消生产调用」，由 `gap-live-voice-sts-production-disconnect`（status=done，落地提交 `b6b60a95a`）执行：`server/index.ts` 的 `buildVoiceRealtimeSeams` **任何 env 下都不再**把 `silenceTail` seam 交给代理，`createSilenceTailGate` 在生产装配里**不可达**；该部署下 `VOICE_REALTIME_SILENCE_TAIL` 只被读出并打一行 `DEPRECATED and IGNORED`。模块、其服务端测试、探针文档按裁定**原样归档不删不改**。
3. 该断开任务的 AC6 只声明「既有 STS **服务端**测试文件单文件退出 0」（实测 13 pass），**没有**重跑 AC-364 判据的 e2e 腿 ⇒ 生产接线一断，e2e 腿当轮即红而无人复核。（因此本条**不是**「上一轮的实现没守住」：`gap-live-voice-silence-tail-suppression`（done，`goal_ac: AC-364`）落地时两腿确实全绿；是本轮之后一条**人裁定的退役任务**把它的前提合法移除了。）
4. 要让 e2e 腿在**不改产品装配**的前提下可选地重新看到门控，只能在生产装配根新增一个 STS arm 点——这**正面违反**该裁定与断开任务的 AC4（「两个门控 seam 在生产组装里都不可能同时非 null …… ⛔ 不得新增 arm 点」）。⇒ 判据**在设计上不可满足**，不是可实现的缺陷。

### 结论：本轮合法终态是 driver 的 (b) —— supersede，不是 (a) 硬改绿

AC-364 断言的保证是「STS 是**产品实现**、开关默认关闭、在 continuous 连线上端到端验证 S-1..S-7」。这条保证已被人 2026-10-14 的裁定**退出本仓意图**：生产路径不再有 STS，模块只作归档证据。于是：

- **不做 (a)**：把 e2e 腿删掉/换成别的文件、或把该 spec 改写成断言「不抑制」，都是「改判据让它变绿」——判据会亮，而被断言的保证仍是假的，正是 AC-364 自己的取假形态精神要拦的。
- **做 (b)**：把 AC-364 记录置 `superseded` 并**书面写明理由**（引 2026-10-14 裁定与提交 `b6b60a95a`，指明后继不变量由 `server/modules/voice-realtime/tests/voice-realtime-silence-tail-deprecated.test.ts` 承担），同步 GOAL-044 的退出条件，并把必然红的归档 spec 移出仓库默认的 playwright 集合（**文件本身逐字节不动**，具名选择仍可跑）。

<!-- dedup-ref --> 机制去重（2026-10-14）：`gap-live-voice-sts-production-disconnect`（done，`goal_ac: null`）是**本次冲突的原因**（断开生产调用），不是重复；`gap-live-voice-silence-tail-suppression`（done，`goal_ac: AC-364`）是 STS 落地本身；`gap-live-voice-silence-tail-suppression-probe`（done，`goal_ac: AC-363`）是实测定值；`gap-voice-server-vad-three-arm-replay-on-third-test-corpus`（done）是另一条探针。open 任务对「AC-364 退役 / supersede / 归档 spec 移出默认集合」0 命中。merge-candidate：`node /data/home/yale/.claude/plugins/cache/quay/quay/0.19.0/scripts/dist/task-granularity-advice.js --touches playwright.config.ts --touches e2e/voice-realtime-silence-tail-suppression.spec.ts --touches "goals/AC-364-silence-tail-suppression-产品实现-开关默认关闭-continuous-下偏向语音的本地静音检测.md" --root /data/home/yale/work/claudecodeui --json` → `peers: []`（**separate**）。

## Plan

1. **复量并归档读数**：两条腿按 `## AC` 的命令各跑一次，读数（pass/fail 计数与失败断言原文）写入 `## Notes`。
2. **退役 AC-364 记录**：走本仓既有的授权 goal 写入路径（`quay goal write`，**先 `--dry-run`** 观测一次确认不落盘）。写 `status: superseded`，并把书面理由写进记录（`origin` 追加，或 `body`）——理由须含：2026-10-14 裁定原文「STS 已证实无效，取消生产调用」、落地提交 `b6b60a95a`、`buildVoiceRealtimeSeams` 不再喂 seam、后继不变量载体 `voice-realtime-silence-tail-deprecated.test.ts`。**不改 `criterion` 行**（判据是「它当时断言了什么」的记录，退役不改写它）。写完 `quay goal show AC-364` 复读核对：`status: superseded`、理由在位、`criterion` 逐字未变。
3. **同步 GOAL-044 的 `## 退出条件`**：其现文本第 3 分句逐字为「AC-364 判据通过且开关仍默认关闭」。AC-364 既已 `superseded`，该分句改写为退役态读法（例如「STS 已断开生产调用，`VOICE_REALTIME_SILENCE_TAIL` 在生产装配里不 arm，判据由 `voice-realtime-silence-tail-deprecated.test.ts` 承担」）或按裁定删去该分句；同样走授权 goal 写入路径并记录读数（先例：同一文件的退出条件曾按人裁定改写过一次，提交 `2fadec95`）。
4. **处置归档 e2e spec**：判据退役后 `e2e/voice-realtime-silence-tail-suppression.spec.ts` 是**必然红**的归档文件（`playwright.config.ts:489` 的 `selectedSpecFiles()` 无参数时返回 `e2e/` 下**全部** spec，故它会拖红仓库默认的 `npx playwright test`）。按人裁定「原样归档不删」：**不动该 spec 文件**，在默认集合处把该文件名排除（紧邻现有 `SPEC_BUDGET_MS` / 选择臂的注释里写清「归档产物，AC-364 已 superseded，2026-10-14 裁定」及其具名选择方式），使无参数的默认运行不再包含它、而 `npx playwright test e2e/voice-realtime-silence-tail-suppression.spec.ts` 仍解析到它。**不要**顺手改该 spec 的用例内容或把它的失败改成 expected-fail。
5. **回归**：服务端两条测试腿、`npm run typecheck`、`npm run lint` 全绿；写出 `## Notes` 读数表。

## AC

- [x] AC1（取假形态排最前）**判据不是被改绿消掉的**：AC-364 记录的 `criterion` 行**逐字未改**（仍要求那两份判据文件、且第二条命令仍是 `npx playwright test e2e/voice-realtime-silence-tail-suppression.spec.ts`）；`git diff -- goals/AC-364-*.md` 只含 `status` / `origin` / `body` 一类字段，`criterion:` 行的 before/after 逐字相同。取假形态：若把 e2e 腿从 `criterion` 里删掉或换掉以让判据转绿 ⇒ 本断言红。
- [x] AC2 AC-364 记录的 `status` 为 `superseded`（`quay goal show AC-364` 读数），且记录内含**书面理由**，理由文本同时出现：(a) 2026-10-14 裁定原文「STS 已证实无效，取消生产调用」；(b) 落地提交 `b6b60a95a`；(c) 后继不变量载体 `voice-realtime-silence-tail-deprecated.test.ts`。写入经授权 goal 写入路径，证据里记 `--dry-run` 那一次的读数（不落盘）与实际写入后的复读。
- [x] AC3 GOAL-044 的退出条件不再要求 AC-364 判据通过：`grep -n "AC-364" goals/GOAL-044-*.md` 要么 0 命中，要么每条命中都在退役态读法里（引 superseded / 裁定 / retired 判据），全文中**不再**出现「AC-364 判据通过且开关仍默认关闭」这一原句。读数（grep 前后）记入证据。
- [x] AC4 **归档产物逐字节原样**：`git diff develop -- e2e/voice-realtime-silence-tail-suppression.spec.ts server/modules/voice-realtime/voice-realtime-silence-tail.ts server/modules/voice-realtime/tests/voice-realtime-silence-tail-suppression.test.ts` 无输出（modules 与两份测试原样归档，一件不删不改）。
- [x] AC5 **归档 spec 不再拖红默认运行、具名仍可跑**：无参数 `npx playwright test --list` 的输出里**不含** `voice-realtime-silence-tail-suppression.spec.ts`；`npx playwright test --list e2e/voice-realtime-silence-tail-suppression.spec.ts` 仍解析到该文件（列出其用例）。两次读数（命令、退出码、匹配行）记入 `## Notes`。
- [x] AC6 回归全绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-silence-tail-suppression.test.ts` → 13 pass / exit 0；`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-silence-tail-deprecated.test.ts` → 4 pass / exit 0；`npm run typecheck`、`npm run lint` → exit 0。

## DoD

AC-364 在 goal store 里被**显式退役**：`status: superseded` + 一条引用 2026-10-14 人裁定与提交 `b6b60a95a` 的书面理由，`criterion` 逐字未改；GOAL-044 的退出条件随之对齐，不再把一条已退役的判据当作在域保证。STS 模块、其两份服务端测试与那份 e2e spec 按裁定逐字节原样归档、一件不删；归档 spec 被移出仓库默认的 playwright 集合（文件本体不动、具名仍可跑），不再拖红默认运行。服务端两条测试腿、typecheck、lint 全绿。

本任务**不**重新给生产装配加 STS arm 点、**不**改 STS 模块、**不**把 e2e 腿改写成断言「不抑制」或删判据来制造假绿。

## Touches

- goals/AC-364-silence-tail-suppression-产品实现-开关默认关闭-continuous-下偏向语音的本地静音检测.md
- goals/GOAL-044-live-voice-体验优先-可用-低延迟-连续交互-模型决定投递边界-vad-只服务传输节奏-先建本地确定性验证与真.md
- playwright.config.ts
- tasks/gap-ac364-supersede-after-sts-production-retirement.md

## Notes

立项：GOAL-044 gap-filing agent，2026-10-14。AC-364 的 GOAL-044 已不在 reverify scope（`longTerm: false`），本轮直接复量判据 ⇒ e2e 腿红（上 `Proposal` 的读数）。

**授权路径**：AC2/AC3 的 goal 记录写入用 `quay goal write`（先 `--dry-run`）。本仓既有先例：`gap-ac-024-criterion-repoint-and-compile-allowlist-coverage`（done）的 worker 即用该路径改写过 `goals/AC-024-*.md` 的 `criterion`（写入落在主检出、再 cherry-pick 进任务分支）。若执行侧确定无权写 goal 记录 ⇒ **停在 needs-human** 并把待写文本备好，⛔ 不得改判据或改测试去制造假绿。

**为什么不是 (a)**：要让 e2e 腿在真实服务进程里看到门控，只能重新在生产装配根新增 STS arm 点；那正面违反 2026-10-14 裁定与 `gap-live-voice-sts-production-disconnect` 的 AC4。故本轮走 (b)。

**未读数/边界**：该 spec 的第 3、4 用例本轮 `did not run`（`mode: serial`，前一条失败即跳过）；退役后不在默认集合里运行，其「前滚成串补发」「零外联」两条读数在本仓不再有活跃判据——若将来需要，它们只能在**不接生产**的前提下重开（例如实验脚本内构造 seam），并在新 AC 下重新立项。


### 执行读数（2026-10-14，本任务分支）

证据提交：AC-364 记录 `3d85034e7`（含尾换行修正）、GOAL-044 退出条件 `559c2a87a`、`playwright.config.ts` `54b8694c5`。全部写在工作树 `/data/home/yale/work/claudecodeui-worktrees/gap-ac364-supersede-after-sts-production-retirement`（分支 `task/gap-ac364-supersede-after-sts-production-retirement`），主检出与 develop 未被本任务改动。

**AC1 — 判据逐字未改**：`criterion` 块 `git show develop:<AC-364>:criterion` vs 工作树，`diff` 无输出，两端 md5 同为 `8d5aa23bcbd415cec6158eb4b6e9a7a1`（409 字节）。`git diff develop -- goals/AC-364-*.md` 的 hunk 只有：`-status: achieved` / `+status: superseded`、新增的 `statusLog` 一条、以及追加的 `## 退役记录（2026-10-14）` 正文；**无任何 `criterion:` 行 hunk**。

**AC2 — superseded + 书面理由**
- `--dry-run` 读数（不落盘）：`quay goal write AC-364 --origin <原值> --status superseded --actor worker:gap-ac364-supersede --dry-run --root <WT>` → exit 0，打印记录 `"status": "superseded"`；执行前后 `git rev-parse HEAD` 同为 `559c2a87a`（未落盘）。
- 写入后复读：`quay goal get AC-364 --store --root <WT> --json` → `status = superseded`；`statusLog[-1] = {at: 2026-10-14T09:25:00.123Z, from: achieved, to: superseded, actor: worker:gap-ac364-supersede, reason: "人 yale 2026-10-14 裁定「STS 已证实无效，取消生产调用」；落地提交 b6b60a95a；后继不变量由 voice-realtime-silence-tail-deprecated.test.ts 承担"}`；body 首行 `## 退役记录（2026-10-14）`。三条必含文本 (a) 裁定原文 / (b) `b6b60a95a` / (c) `voice-realtime-silence-tail-deprecated.test.ts` 均逐字在位。
- ⚠️ 读数口径：无参数的 `quay goal show AC-364` 走 Provider ABI，其 goal 目录被本仓 `.quay/config.yml` 钉到**主检出** `/data/home/yale/work/claudecodeui/goals`；本任务的写入先落在任务分支，故合并前它仍打印 `[achieved]`。工作树内的授权读数是 store 方言：`quay goal get AC-364 --store --root <WT>`（`--store` 强制 `runGoalStoreCli` 并尊重 `--root`）。合并 develop 后主检出同步，`quay goal show AC-364` 即读 `superseded`。

**AC3 — GOAL-044 退出条件对齐**：改后 `grep -n "AC-364" goals/GOAL-044-*.md` → 2 命中（第 29 行范围句、第 33 行退出条件句），两条都是退役态读法（引 `superseded` / 2026-10-14 裁定 / 后继载体）；原句 `grep -c "AC-364 判据通过" goals/GOAL-044-*.md` → `0`。

**AC4 — 归档产物逐字节原样**：`git diff develop -- e2e/voice-realtime-silence-tail-suppression.spec.ts server/modules/voice-realtime/voice-realtime-silence-tail.ts server/modules/voice-realtime/tests/voice-realtime-silence-tail-suppression.test.ts` → 无输出，exit 0。

**AC5 — 默认集合不收、具名仍解析**（均在工作树内跑）
- 无参数：`node_modules/.bin/playwright test --list` → exit 0，`grep -c voice-realtime-silence-tail-suppression.spec.ts` = **0**，末行 `Total: 254 tests in 66 files`。
- 具名：`node_modules/.bin/playwright test --list e2e/voice-realtime-silence-tail-suppression.spec.ts` → exit 0，匹配 **4** 行，末行 `Total: 4 tests in 1 file`。
- 实现：`ARCHIVED_SILENCE_TAIL_SPEC` 常量 + `namedSpecFiles()`（原始具名读数）+ `selectedSpecFiles()` 的 full-tree 回退过滤 + `defineConfig` 上条件 `testIgnore`（具名时放开）。spec 文件本体未动。

**AC6 — 回归**
- `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-silence-tail-suppression.test.ts` → `tests 13 / pass 13 / fail 0`，exit 0。
- 同命令换 `voice-realtime-silence-tail-deprecated.test.ts` → `tests 4 / pass 4 / fail 0`，exit 0。
- `npm run typecheck` → exit 0（三条 tsc 全过）。
- `npm run lint` → exit 0（仅既有 warning，无 error）。
