---
id: gap-scripts-lane-fixture-drift
title: 修 scripts lane 的夹具漂移：7 个 ASR 探针的工装漏拷
  sensevoice-local/sensevoice-wasm、替换锚点仍是旧装配形状，`npm run test:scripts` 在 develop
  上确定红
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现场（已独立复核）**：`npm run test:scripts`（= `node scripts/list-script-tests.mjs` + `node --test "scripts/**/*.test.mjs"`，这是 `scripts/**/*.test.mjs` 唯一被执行的 lane）在 develop 上确定红。2026-10-09 复核方式：在 `task/gap-asr-wire-probe-ws-frame-false-positive` 的 worktree 上跑（该树与 develop 只差那条任务自己的 2 个 `scripts/` 文件——`git diff --stat develop -- scripts src server shared experiments` 只有那 2 个文件），`node --test scripts/asr-extraction-parity-check.test.mjs` 退出 1，判词 `AC3: the substitution must hit exactly one site — 3 !== 1`。⇒ 这条红与任何在飞任务无因果，是 develop 自身状态。

**报告的文件清单（来自 `gap-asr-wire-probe-ws-frame-false-positive` 的 park 记录：29 例失败 / 7 个文件）**：`asr-extraction-parity-check`、`asr-health-provider-check`、`asr-pause-cues-source-check`、`asr-proxy-only-ssrf-check`、`asr-trim-capability-check`、`mint-token`、`voice-capture-process-check.false-forms`。本任务第一步就是把这份清单**自己重测一遍**（不采信转述）。

**根因（park 记录的两条；第 1 条待本任务复核）**：
1. 若干 ASR 探针的夹具构建器把 `shared/asr/asrRegistry.ts` 拷进临时工装目录，却漏拷它自 `f8b99cf2`（2026-10-06）起静态引用的 `shared/asr/list/sensevoice-local`（及 `sensevoice-wasm`）适配器 ⇒ 工装内是**相对** import，解析失败（MODULE_NOT_FOUND）。是夹具拷贝清单的缺口，不是 npm 依赖缺失。
2. 另若干条红是出货装配形状已变，而夹具的替换锚点/断言计数仍是旧形状（extraction-parity 那条已实测：预期命中 1 处，现在命中 3 处）。

**危害（为什么值得单独一条）**：这条 lane 不在 fan-in 的 `scripts/test.sh`（typecheck + lint + server node:test + client vitest）里，所以它红多久都不会有人被拦下。代价是任何「`npm run test:scripts` exit 0」形态的判据在本仓**不可满足**：2026-10-09 `gap-asr-wire-probe-ws-frame-false-positive`（AC-129 探针）的 AC6 正因此被迫停在 needs-human——它自己的文件 8/8 绿，却无法让整条 lane 绿。

**去重（按机制，不按关键词）**：`grep -rlE 'sensevoice-local|MODULE_NOT_FOUND|test:scripts' tasks/*.md` 的命中都是这些探针的**来源**任务（`gap-asr-proxy-only-ssrf-and-direct-path-zero`、`gap-asr-trim-capability-wiring`、`gap-asr-health-effective-config-fail-closed`、`gap-scripts-static-gates-and-mint-token` 等），没有一条是「修夹具漂移」本身；`gap-asr-wire-probe-ws-frame-false-positive` 只改它自己那条探针的 2 个文件，与本条同因不同作用面，两者不重叠、互不 `depends_on`。

## 方案

1. **先重测并把清单钉死**：用 `scripts/with-memory-cap.sh` 夹住并发跑这条 lane（⛔ 不要裸跑 `node --test "scripts/**/*.test.mjs"`，会撑爆会话 cgroup 被 OOM 杀），拿到逐文件失败清单，逐条归成「夹具漏拷（相对 import）」与「装配形状已变」两类，写进 Notes。清单与任务体里那份不一致时**以重测为准**并更新本任务体。
2. **漏拷类**：把漏拷的模块补进各夹具构建器的拷贝清单；优先抽一个共享的「按依赖闭包拷贝 `shared/asr` 子树」助手，避免第 8 条探针再漏。同时在夹具里加一条「工装内不存在解析不了的相对 import」的自检。
3. **形状已变类**：按今天的出货形状更新替换锚点/断言计数，每一处都在代码注释里说明「现在是这个数，因为 X」。
4. **出货代码逐字不动**：`shared/**`、`server/**`、`src/**`、`experiments/**` 一行不改；只改 `scripts/**`。
5. **收口**：`npm run test:scripts` 退出 0（0 fail）；`npm run lint`、`npm run typecheck` 退出 0。

## 边界（不做）

- 不改任何探针的**判据语义**（不靠放宽断言买绿）；形状已变的锚点按新形状更新，但替换的**判别力**必须原地验证（见 AC3）。
- 不把这条 lane 接进 fan-in 的 `scripts/test.sh`——那是另一个决定，超出本任务写入面；本任务只把 lane 修绿。
- 不碰 `gap-asr-wire-probe-ws-frame-false-positive` 的那 2 个文件。

## AC

- [x] AC1 逐文件读数：重测后的完整失败清单写进 Notes；修完后 `npm run test:scripts` 退出 0、0 fail（清单里每个文件都从红转绿）。
- [x] AC2 归因成文：Notes 逐条列出修前失败文件 + 每条归到「漏拷」或「形状已变」，两类各至少一条，并给出定位证据（实际报错文本 / 预期 vs 实际的计数）。
- [x] AC3 判别力未被削弱：至少两条取假形态现场复现为红、再还原为绿各留输出——(a) 故意从某个夹具的拷贝清单里去掉一个必需模块 ⇒ 该夹具的自检（或该文件）必须红；(b) 至少一条「形状已变」的替换锚点改回旧值 ⇒ 该替换必须再度红。
- [x] AC4 出货代码未动：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`，且 `git diff --name-only $(git merge-base HEAD develop) HEAD -- shared server src experiments` 为空。
- [x] AC5 lint/typecheck：`npm run lint`、`npm run typecheck` 均退出 0。

## DoD

真实落地：不是「把断言调松让它绿」，而是这 7 个文件在今天的出货形状下**仍然有判别力地绿**。三组取证：(a) 修前逐文件失败清单（重测所得）；(b) 修后 `npm run test:scripts` 退出 0 的完整输出；(c) AC3 的两条取假形态（去掉一个拷贝 ⇒ 红；替换锚点改回旧值 ⇒ 红）各自的红输出 + 还原后的绿输出。不声称「这条 lane 从此被 gate 保护」——它仍不在 fan-in 的 suite 内。

L_D 该轴仍暗，理由：本任务只修测试夹具，不新增领域数据能力、没有可读出的领域读数。

L_G 该轴仍暗，理由：不新建目标层保证；它只让既有探针的读数重新可信。

## Touches

- scripts/asr-extraction-parity-check.test.mjs
- scripts/asr-health-provider-check.test.mjs
- scripts/asr-pause-cues-source-check.test.mjs
- scripts/asr-proxy-only-ssrf-check.test.mjs
- scripts/asr-trim-capability-check.test.mjs
- scripts/mint-token.test.mjs
- scripts/voice-capture-process-check.false-forms.test.mjs
- scripts/__fixtures__/shared-closure.mjs (new)
- tasks/gap-scripts-lane-fixture-drift.md (new)

（若第 1 步的重测显示某条红落在探针本体 `<name>.mjs` 而非 `.test.mjs`，或需要新增一个共享拷贝助手，实现时**先把该路径补进本节再改它**——不声明不动手。）

## Notes

- 立案来源：2026-10-09 人 yale 对 `gap-asr-wire-probe-ws-frame-false-positive` 的 park 做二选一裁定，选了「复范围 AC6 + 另立 develop 回归任务」，本条即那条回归任务。
- 与 `gap-asr-wire-probe-ws-frame-false-positive` 的关系：那条改 AC-129 的探针精度（2 个文件），本条修这条 lane 的夹具漂移（另一批文件）；两条互不 `depends_on`，但那条的 AC6 要等本条落地后才可能真正复绿。
- 环境约束：这条 lane 的并发必须用 `scripts/with-memory-cap.sh` 夹住（见 `docs/operations/process-isolation-and-memory-caps.md` → "Running tests from a Claude session"）。
- **未改探针本体**：修前红的 7 个文件全是 `.test.mjs`，无一落在 `<name>.mjs` 探针本体；新建的唯一文件是 `scripts/__fixtures__/shared-closure.mjs`（已先补进 `## Touches` 再落盘）。`asr-pause-cues-source-check` 的 AC6 会 grep 探针本体未被改动——本次未碰任何 `.mjs` 探针。

### 重测（AC1）：修前逐文件失败清单

复核方式：本 worktree 上 `npm run test:scripts`（并发由 `scripts/with-memory-cap.sh` 夹住，未裸跑）。重测复现同一 7 个文件全红，与立案转述的清单一致（未采信转述）：

- `scripts/asr-extraction-parity-check.test.mjs` — **形状已变**。实际判词 `AC3: the substitution must hit exactly one site — 3 !== 1`（AC2b 同因）。`append('audio'` 在 `src/shared/api.ts` 现命中 3 处（三个客户端分支），夹具仍断言恰好 1 处。
- `scripts/mint-token.test.mjs` — **形状已变**。invariant 6 的 `grepCount('mint-token', ['server/','src/'])` = 4，断言 0；4 处命中全在 `server/**/tests/` 下（驱动 CLI 的测试），后来新增的测试把「生产码零引用」读了成红。修法改为只对生产源计数（测试源按 `tests/`、`.test.`、`.spec.` 排除），并加两条正控制。
- `scripts/voice-capture-process-check.false-forms.test.mjs` — **形状已变**。取假形态 `assembly-not-wired` 的替换锚点 `CAPTURE_INJECTION` 用的是整段旧值，在出货文件里已不存在 ⇒ 替换 0 命中，该 case 红在自己的前置。改为 `CAPTURE_INJECTION_HEAD`/`_TAIL` 两点截取。
- `scripts/asr-proxy-only-ssrf-check.test.mjs` — **漏拷 + 形状已变**。夹具内 `shared/asr/asrRegistry.ts` 的**相对** import 解析失败（缺 `list/sensevoice-*.asr-provider.js`，MODULE_NOT_FOUND）；补齐闭包后，AC4 的替换锚点 `"  if (profile !== null && profile.capabilities.transport === 'proxy-only') {"` 在 `src/shared/api.ts` 上不再出现（条件已改为 `!sharedBackendApplies(profile.capabilities)`）。
- `scripts/asr-health-provider-check.test.mjs` — **漏拷 + 形状已变**。同上漏拷；补齐后 3 个替换锚点在 `server/modules/voice/voice.service.ts` 上不再出现：`readStoredField(settings,'baseUrl') || defaults.baseUrl` 的读取、`tryResolve(providerId)` 的拒绝分支（`unknownProviderFailure` 段）、以及 `value: { configured, provider }` 的结果形状（现为 `voiceConfigured`）。
- `scripts/asr-pause-cues-source-check.test.mjs` — **漏拷 + 形状已变**。同上漏拷；补齐后 collision 计数 `new Set(evidence.values()).size === evidence.size - 1` 失败——`sensevoice-local`/`sensevoice-wasm` 没有 record（`evidence === undefined`），两个 `undefined` 被 `Set` 并成 1；改为只在有名 record 上比较。
- `scripts/asr-trim-capability-check.test.mjs` — **漏拷 + 形状已变**。同上漏拷；零行用例原按「行」枚举 `patch()`，行内容已变，改为清空注册表体的等价改写（`emptyRegistrationTable`）。

**归类合计**：漏拷 4 条（`asr-trim-capability`、`asr-proxy-only-ssrf`、`asr-pause-cues-source`、`asr-health-provider`；这 4 条补齐闭包后又各暴露至少一处形状已变）；纯形状已变 3 条（`asr-extraction-parity`、`mint-token`、`voice-capture-process-check.false-forms`）。两类各 ≥1，满足 AC2。

### 修后整条 lane（AC1 收口）

在本 worktree、`merge develop` 之后运行 `npm run test:scripts`：

```
ℹ tests 377
ℹ pass 377
ℹ fail 0
LANE_EXIT=0
```

（清单里 7 个文件全部红转绿；无 `not ok`。）

### AC3 判别力取证（两条取假形态 · 红 → 还原绿）

(a) 从夹具拷贝清单里去掉一个必需模块。用助手自身公开 API 在真树上 provision（entry = `server/modules/voice/voice.service.ts`，闭包 = 8 个 `shared/asr/**` 文件），再删掉 `shared/asr/list/sensevoice-wasm/sensevoice-wasm.asr-provider.ts`，要求自检红：

```
green: provisioned 8 shared file(s), 8 under shared/asr/
green: self-check passed on the provisioned fixture

mutation: deleted shared/asr/list/sensevoice-wasm/sensevoice-wasm.asr-provider.ts from the fixture's copy list
red: the fixture has unresolvable relative imports:
shared/asr/asrRegistry.ts -> ./list/sensevoice-wasm/sensevoice-wasm.asr-provider.js
shared/asr/list/sensevoice-wasm/sensevoice-wasm.asr-provider.ts (missing from the fixture)
2 !== 0
```

(b) 把 `asr-proxy-only-ssrf-check.test.mjs` 里 AC4 的替换锚点改回旧值 `"  if (profile !== null && profile.capabilities.transport === 'proxy-only') {"`：

```
=================== RED HALF: anchor reverted to its pre-drift value ===================
  anchor line now reads:
    from: "  if (profile !== null && profile.capabilities.transport === 'proxy-only') {",
  AssertionError [ERR_ASSERTION]: src/shared/api.ts no longer contains   if (profile !== null && profile.capabilities.transport === 'proxy-only') {; this case needs updating
  RED_EXIT=1

=================== RESTORE + GREEN HALF: anchor back to shipping shape ===================
  anchor line now reads:
    from: '  if (profile !== null && !sharedBackendApplies(profile.capabilities)) {',
ℹ tests 6
ℹ pass 6
ℹ fail 0
  GREEN_EXIT=0
```

### AC5 lint / typecheck

`npm run lint` → `LINT_EXIT=0`（237 条存量 warning 全在无关文件）；`npm run typecheck` → `TYPECHECK_EXIT=0`。

### AC4 出货代码未动

`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`（= 8 个 `scripts/**` 路径 + `tasks/gap-scripts-lane-fixture-drift.md`，后者由 `task_write` 提交）；`git diff --name-only $(git merge-base HEAD develop) HEAD -- shared server src experiments` 为空。
