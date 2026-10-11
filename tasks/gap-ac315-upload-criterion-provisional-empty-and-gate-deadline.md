---
id: gap-ac315-upload-criterion-provisional-empty-and-gate-deadline
title: "AC-315 判据（共用 spec）两因致红：AC-326 用例 #4 的 provisional 采样把一次未布局的空 innerText
  读成「定型转写行」（全量串行 flake、单跑 3/3 绿；首跑 exit 1）+ 该 spec 串行墙钟 ≈61s 再加第二条命令 > goal gate
  60000ms 默认（常态 not-evaluated(timeout)）⇒ 修采样竞态 + 在 AC-315 记录声明 timeoutMs(<12e4)"
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-315
---
## Proposal

<!-- dedup-ref --> 去重/粒度（2026-10-11 本轮直接复跑）：声明 `goal_ac: AC-315` 的任务共 6 条（`gap-voice-realtime-upload-audio-and-protocol-simulation`、`gap-ac315-voice-upload-orphaned-never-merged`、`gap-ac315-upload-criterion-repoint-under-voice-bar`、`gap-ac315-upload-criterion-second-upload-flake`、`gap-ac315-upload-criterion-boot-race`、`gap-ac315-reload-window-residual-deterministic-injection`），**全部 `done`**，当前无 todo/ready/needs-human 任务 claim AC-315 ⇒ 本任务为新案，非重复。`node scripts/dist/task-granularity-advice.js --touches e2e/voice-realtime-upload-fixture.spec.ts --touches goals/AC-315-<slug>.md` 报 `peers: []`、`mentions: []` ⇒ 无合并候选。同一份 spec 也是 AC-317/AC-326/AC-327 三条判据的命令输入（它们各自的记录由其自身轮次处理），本任务以 AC-315 的两条命令为验收面。

**本轮的直接测量（不是台账尾巴）**：AC-315 的判据是两条命令的合取（逐字取自 `goals/AC-315-<slug>.md` 的 `criterion`）：

1. `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts`
2. `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`

第二条**确定性绿**：本机直跑 `tests 14 / pass 14 / fail 0`、`duration_ms 3116.7`、exit 0。第一条**红**：本机在判据当前树（`git rev-parse HEAD^{tree}` = `90017da74f3c5f2d50f5b27c39f36711d6a1bce6`，**逐字等于** `.quay/gate-events.jsonl` 里 AC-315 最近一次 `verdict: fail`（`2026-10-11T12:56:17.116Z`）的 `payload.treeSha`）上直跑得 `1 failed / 3 passed / 3 did not run`、exit 1。故判据本体当前为假。红有两个共存的机制，都随 2026-10-11 把 AC-326/AC-327 的浏览器用例加进这同一份 spec 而来。

**机制一（真断言失败，全量串行时 flake）**。失败落在第 4 例 `e2e/voice-realtime-upload-fixture.spec.ts:1267:3`（AC-326 的「three transcriptions … ONE row」）。用例把 `provisional = samples.filter((s) => s.count === 1 && !s.text.includes(ROW_DELIVERED))` 的**最后一个** sample 当作「已定型的转写行」（`:1317`），再对三片段逐个 `expect.soft(...).toContain`（`:1319`）。失败原文：`Received string: ""`（三个 `toContain` 同因）；而同一 run 的 ledger（`counts=[0,1,1,…] texts=[…]`）显示**同一行在更早的 sample 上确实同时带着 `alfa bravo charlie delta echo foxtrot golf hotel india`**（先标 `Heard`、后标 `Tidying up…`）。即读数不是「行没带全」，而是**最后一个 provisional sample 的文本是空串**。根因：采样读 `owned.first().innerText()`（`:1286`），`innerText` 是**布局相关**的——元素在「摘下 caption 文字 / 真实消息上行」的那一次重渲染瞬间未布局时 `innerText()` 返回 `""`，而 `owned`（`USER_ROW.filter({hasText})`）仍按 `textContent` 命中，于是 `count===1` 配上 `text===""`。commit `6ec839cb`（「take caption words off screen only once the real message is shown」，2026-10-11 14:29+0800）把「摘字」时机从 `sent` 改到「真实消息 visible」，正好在新旧行交接处制造了这个未布局窗。单跑第 4 例（`-g "three transcriptions"`）**3/3 绿**、逐次 `(7.7s)`——单跑没有前几例留下的状态，交接更快、采样更难撞上那个窗；**全量串行**时它复现（本任务首跑，见 Evidence 编号）。

**机制二（整份文件超 goal gate 的 60000ms 默认）**。本任务实测整份文件的第 1 条命令：七例里跳过第 4 例得 `6 passed (52.8s)`、`/usr/bin/time` wallclock `0:53.57`；第 4 例单跑 `(7.7s)` ⇒ 七例全跑的 playwright 段 ≈ **60–61s**；再加第 2 条命令（`npx tsx --test` ≈ 3–6s 含 tsx 启动）⇒ **合取墙钟 ≈ 64–67s > 60000**。台账吻合：AC-315 在 `2026-10-11T12:44:41Z`、`2026-10-11T12:50:52Z` 两条 `verdict: not-evaluated` / `cause: timeout`，reason 逐字 `acceptance timed out after 60000ms (killed)`；且**同文件**是 AC-317/326/327 的判据输入，这三条自 `2026-10-11T09:41` 起连续 `not-evaluated (timeout)`。两条命令各自都「对」、功能也为真，红来自**闸的 deadline 低于判据的串行墙钟**——与 `gap-ac323-gate-deadline-below-criterion-serial-time`（done，commit `19df2137` 给 AC-323 记录加一行 `timeoutMs: 115000`）**同一机制**。`playwright.config.ts` 的 `SPEC_BUDGET_MS['voice-realtime-upload-fixture.spec.ts'] = 240_000` 是给 Playwright **自身看门狗**用的，压不到 goal gate 的 60000ms（AC-323 任务已写明同一结论）。

**为什么前几次 done 没挺住**：6 条 `goal_ac: AC-315` 的 done 任务都早于 AC-326/AC-327 用例进入该文件（`739d5e74` / `8be9df6b` / `6ec839cb`，2026-10-11）；它们修的是启动前导竞态（boot-race / 握手前丢帧 / reload 判定窗），与本轮两机制正交，它们的 `## Touches` 也不含本文件的 AC-326 采样行、不含 `goals/AC-315-<slug>.md`。

**要做的**：

1. **修机制一**：让第 4 例「定型 provisional 行」的读数不再把一次未布局的空 `innerText` 当成定型行——例如改读 `textContent`（布局无关），或把 provisional 选样先限定为「文本非空 / 已含 `ROW_HEARD` 片段」再取最后一个。**不得弱化**：该例仍须断言「恰好一行、三片段齐全、顺序正确、就地定型、逐字徽标」。同源采样（`:1495` 的 `allInnerTexts()` 等）一并核对，避免同一空窗在别处 flake。
2. **修机制二（判据能落进闸）**：按仓库成例（`19df2137`）在 `goals/AC-315-<slug>.md` 的 frontmatter 声明 `timeoutMs`（正整数毫秒），取值 **> 判据合取实测墙钟（含冷缓存上界）** 且 **< 120000**（goal driver 的 `CRITERION_TIMEOUT_MS = 12e4` 会在 120000ms 对 gate spawn 发 SIGKILL，声明值 ≥120000 只会先被杀、得到 `not-evaluated(spawn)`）。建议 ≈110000–118000，由实测决定；`criterion` / `expect` 一字不动。
3. 判据文件路径与两条命令逐字不变。

**边界 / 不做**：⛔ 不 supersede AC-315、不弱化判据、不改第二条命令、不引入麦克风/替身；⛔ 不动本文件里 AC-326/AC-327/AC-317 的实质断言（只允许修它们**采样时**对未布局空窗的误读）；⛔ 不加 retries/skip；⛔ 不以「收窄判据换 60s 内跑完」代替声明 `timeoutMs`；⛔ 不改 `goals/` 下 AC-315 以外任何记录。

## AC

- [ ] AC1 归类（先证后修，两形态各留原文）：在判据当前树上 (a) 直跑 `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` 得 exit 1，失败落在 `:1267:3`、报文含 `Received string: ""`，并附该 run 的 ledger（证明同一行更早 sample 已带全三片段）；(b) 记录整份文件墙钟（跳过第 4 例的 `6 passed (52.8s)` + 第 4 例单跑 `(7.7s)` + 第二条命令 wall）与 `.quay/gate-events.jsonl` 里 AC-315 两条 `not-evaluated (timeout)` 的 reason 原文，证明合取墙钟 > 60000。两形态各贴原始输出。
- [ ] AC2 修机制一（不弱化）：把「定型 provisional 行」的读数改为不受一次未布局空 `innerText` 影响；在全量串行下 `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` 连续 ≥5 次 exit 0（家族惯例读数，贴连跑汇总），且第 4 例的三片段齐全 / 顺序 / 就地定型 / 逐字徽标四条 `expect` 未被删除（`git diff` 可查）。
- [ ] AC3 修机制二（判据落进闸）：`goals/AC-315-<slug>.md` frontmatter 声明 `timeoutMs`（正整数、<120000、> 判据合取实测墙钟），记录其余字段（`id`/`title`/`status`/`kind`/`goal`/`criterion`/`expect`/`origin`/`activatedAt`/`statusLog`）逐字节不变 —— 机械判据 `git diff -- goals/` 的增删行只有 `+timeoutMs:` 一行；`quay goal show AC-315 --json` 的 `timeoutMs` == 声明值；`quay goal gate AC-315 --dry-run --root <工作树>` exit 0 且 stdout JSON `verdict == "pass"`、`cause == null`（原文贴 Evidence）。
- [ ] AC4 取假形态（证两条机制各自承重）：(a) 把机制一的修法还原（仍旧直接取最后一个 provisional sample 的 `innerText`）⇒ 全量串行下第 4 例可复现 `Received string: ""`；(b) 删掉记录的 `timeoutMs`（回默认 60000、且未设 `QUAY_ACCEPTANCE_TIMEOUT_MS`）⇒ 同一 `quay goal gate AC-315 --dry-run` 报 `verdict == "not-evaluated"` / `cause == "timeout"`（reason 含 `timed out after 60000ms`）。两形态现场复现并完全还原（`git status --porcelain` 只剩本任务声明内的改动）。
- [ ] AC5 不弱化 + 静态门：`grep -c getUserMedia e2e/voice-realtime-upload-fixture.spec.ts` == 0；上传路径仍 `audioFrameCount()` 增量 >1；第二条命令仍 `pass 14 / fail 0`、exit 0；`npm run typecheck` exit 0；`npx oxlint e2e/voice-realtime-upload-fixture.spec.ts` 新增诊断 0（与 develop 版本同跑对照）。

## DoD

真实落地判据：

① 本任务 worktree 内：判据第一条命令连续 ≥5 次 exit 0（第 4 例不再 flake），第二条命令 exit 0；两条机制的取假形态各自现场红、还原后绿，输出留档（证明修法承重、非摆设）。

② 闸层：`quay goal gate AC-315` 在带可写 `.quay/` 的根上（如合并后主检出或工作树内的 `.quay/`）拿到 `verdict: "pass"` 的 GateEvent（`--dry-run` 不算），或在真实 fan-in 台账（`.quay/gate-events.jsonl` / `.quay/goal-round.jsonl`）看到 AC-315 翻 `pass`。若本会话内未等到 fan-in 落地（`.git/fan-in.lock` 排队等），如实声明只做到 ff-ready + scoped 绿，不得假称已在 develop 上成立。

③ 声明值须覆盖冷缓存上界（冷跑更慢），并在 Evidence 记明它相对判据合取实测墙钟的余量、以及 120000 上限的来源（driver `CRITERION_TIMEOUT_MS = 12e4`）。

## Touches

- e2e/voice-realtime-upload-fixture.spec.ts
- goals/AC-315-语音前端同时支持真实麦克风与音频文件上传-上传与协议模拟测试完全不依赖物理麦克风-ci-可全自动验收.md
- tasks/gap-ac315-upload-criterion-provisional-empty-and-gate-deadline.md (self)
