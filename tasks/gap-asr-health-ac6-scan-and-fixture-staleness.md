---
id: gap-asr-health-ac6-scan-and-fixture-staleness
title: AC-134 判据读数失准：AC6 把 JSDoc 散文当能力声明、夹具缺 voiceSettingsRegistry 使全部反证控制红
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-134
---
## Proposal

**现场（判据自己的读数）。** `node scripts/asr-config-resolution-check.mjs` 今天 exit 1，判词只有一条：

```
client-capability-table=declared-in-1-file(s)
failure=AC6: the client declares capabilities of its own in src/shared/voiceTrim.ts
verdict=fail
```

其余读数全部符合：`health-user-configured=true`、`health-empty-configured=false`、`health-providers-match-registry=yes`、`health-unknown-provider=refused-503`、`proxy-unknown-provider=refused-400-no-fetch`、`proxy-registered-provider=sent-1`、`configured-field-present=yes`、`client-read-points=voiceProviderProfile,setVoiceProviderProfile`。被破坏的是 AC6 的**静态声明扫描**，不是健康检查的行为。

**为什么误报。** `scripts/asr-health-provider-check.mjs` 的 `CAPABILITY_DECLARATION = /\b(acceptsMime|maxInlineRequestBytes|pauseCues|oversize|billing|oneShot)\s*:/` 直接扫每个 `src/**/*.ts(x)` 的**原始文本**。`87a4199ab`（2026-10-22 19:29:01 +0800，"fix(voice): keep the relay task out of the audio turn and trim segment edges"）在 `src/shared/voiceTrim.ts:327` 加了一句 JSDoc：

```
* A relay recogniser declares `pauseCues: 'neutral'`, so the ordinary trim (which caps long gaps)
```

这句话在**描述 registry**（`shared/asr/list/dashscope-omni-relay/dashscope-omni-relay.asr-provider.ts:160` 确实声明 `pauseCues: 'neutral'`），不是客户端自己的声明；但正则把注释散文当成声明。剥掉注释后重扫 `src/`，命中文件数为 0 —— AC6 要守的不变量仍然成立，红的是读数本身。

**为什么上一次修复没守住。** AC6 的扫描是 `187d98d24`（2026-09-23 00:46:58 +0800）落的；`gap-asr-pause-cues-second-source-contradicts-registry`（done）在 2026-09-23 的 Evidence 里记录 `client-capability-table=none`。四天后的 `87a4199ab` 只新增了一句注释，读数就翻了 —— 说明这条静态读数是对着散文的，任何解释同一能力的注释都会再次把它打红。不是代码退回去了，而是读数没有区分代码与注释。

**同一条探针的第二个失准（控制面）。** `node --test scripts/asr-health-provider-check.test.mjs` 今天四条反证控制**全红**，且不是断言红，而是每条用例的夹具基线就红：

```
behavioural-reading=unavailable
failure=reading: the reader produced no reading (exit 1): } |  | Node.js v24.21.0
```

原因：`7034d7f1a`（2026-10-22 16:23:23 +0800，"refactor(voice): converge the voice settings/rules contract onto one shared registry"）让 `server/modules/voice/voice.service.ts` 新增 `@shared/voice/voiceSettingsRegistry.js` 引用，而探针的 `FIXTURE_FILES` 没有这个文件，夹具里的 reader 一 import 就 `Cannot find module '@shared/voice/voiceSettingsRegistry.js'`。在诊断夹具里只补这一个文件后，同一探针 `--root` 立即 `verdict=pass`：四条控制失去的只是夹具闭包，不是探针的行为读数。

**本任务做什么（只修读数，不放松判据）。**

1. AC6 的声明扫描改成**注释无关**：先剥掉 `//` 与 `/* … */` 注释再匹配，代码里的真实声明（对象字面量 / 属性）仍然命中。不删这条读数、不改能力名集合。
2. 给 AC6 补上它一直缺的**反证控制**（今天测试文件只覆盖 AC7/AC1/AC3/AC4，AC6 零控制）：真实声明 ⇒ 必红；同一句话包在注释里 ⇒ 绿（就是 87a4199ab 的回归形状）；另外两条腿（client 向 registry 询问、两个读取点）各一条反向控制，防止「把 AC6 整条删掉」也算绿。
3. `FIXTURE_FILES` 补上 `shared/voice/voiceSettingsRegistry.ts`，让 `node --test scripts/asr-health-provider-check.test.mjs` 的夹具重新可加载；四条既有控制（AC1 / AC3 / AC4 / AC7）恢复「先绿后变异」的语义。

**不做**：不改 `src/shared/voiceTrim.ts` 的注释（它是准确文档，且被 `scripts/asr-pause-cues-source-check.mjs` 读取）；不改健康检查 / provider fail-closed 的任何行为代码；不删 AC6；不改 AC1–AC4、AC7 的读数或假形态。

<!-- dedup-ref --> 同机制去重：`grep -lE "asr-health-provider-check|client-capability-table" tasks/*.md` 命中的 14 条任务全部是 `done`，没有一条在飞的条目声称同一机制；`grep -l voiceSettingsRegistry tasks/*.md` 只有 `gap-voice-settings-single-surface`（done）。`gap-asr-pause-cues-second-source-contradicts-registry`（done）修的是客户端 `pauseCues` 表与 registry 的矛盾，`gap-asr-health-effective-config-fail-closed`（done）落的是健康检查行为；本条修的是**判据读数自身**对注释与夹具闭包的失准。granularity-advice：`--touches scripts/asr-health-provider-check.mjs --touches scripts/asr-health-provider-check.test.mjs` ⇒ `peers: []`、`mentions: []`，无合并候选，独立成条。

## Plan

- S0 先补夹具闭包（`FIXTURE_FILES` 加 `shared/voice/voiceSettingsRegistry.ts`），让 `node --test scripts/asr-health-provider-check.test.mjs` 的四条既有控制回到「未变异夹具绿」的起点；不先做这条，后面任何 AC6 控制都只是在 `behavioural-reading=unavailable` 上叠红。
- S1 修读数：在 `clientReadings()` 里对每个文件先剥注释再跑 `CAPABILITY_DECLARATION`。实现必须保住字符串里的代码样文本（URL 的 `//`、字符串与模板字面量），不能用一个把 `https://` 截断的 naive 替换。
- S2 补 AC6 控制：在 `scripts/asr-health-provider-check.test.mjs` 里新增用例，每条都先对未变异夹具断言退出 0，再 `patchFixtureFile` 单点变异（`from` 在夹具里命中数必须 `=== 1`），断言判词指名期望的读数；最后还原并复跑绿。
- S3 读数落地：跑主判据与测试文件，把 stdout 逐字抄进 Evidence；确认除 AC6 失败行消失外其余读数不变。

## AC

- [x] AC1 主判据绿：`node scripts/asr-config-resolution-check.mjs` 退出码 0，stdout 含 `client-capability-table=none` 与 `verdict=pass`，且不再出现任何 `failure=` 行；同时 `health-user-configured=true`、`health-empty-configured=false`、`health-providers-match-registry=yes`、`health-unknown-provider=refused-503`、`proxy-unknown-provider=refused-400-no-fetch`、`proxy-registered-provider=sent-1`、`configured-field-present=yes`、`client-read-points=voiceProviderProfile,setVoiceProviderProfile` 逐行仍在。
- [x] AC2 既有控制恢复绿：`node --test scripts/asr-health-provider-check.test.mjs` 退出码 0，`# fail 0`，且输出中不出现 `behavioural-reading=unavailable`；四条既有用例（AC7/AC1/AC3/AC4）每条都重新走「未变异夹具绿 → 单点变异红」。
- [x] AC3 夹具闭包有据：`grep -n "shared/voice/voiceSettingsRegistry.ts" scripts/asr-health-provider-check.mjs` 命中 1 行；取假形态——把它从 `FIXTURE_FILES` 删掉后 `node --test scripts/asr-health-provider-check.test.mjs` 必红且判词含 `voiceSettingsRegistry` 或 `behavioural-reading=unavailable`，加回后复绿。
- [x] AC4 AC6 的「真实声明必红」控制：新增用例先对未变异夹具断言退出 0；在同一夹具的 `src/shared/api.ts` 插入一行真实声明（如 `export const probeCaps = { pauseCues: 'neutral' };`，`patchFixtureFile` 的 `from` 命中数 `=== 1`）⇒ 探针退出码非零且 stdout 含 `client-capability-table=declared-in-1-file(s)` 与指名 `src/shared/api.ts` 的 AC6 判词；还原后退出 0。
- [x] AC5 AC6 的「注释不算声明」控制：把 `src/shared/voiceTrim.ts:327` 那句 JSDoc 逐字插入同一夹具的 `src/shared/api.ts`（命中数 `=== 1`）⇒ 探针仍退出 0 且 `client-capability-table=none`；随后在同一位置把同一句改成代码形态 `export const probeRelayCaps = { pauseCues: 'neutral' };`（删掉注释定界符，命中数 `=== 1`）⇒ 退出码非零。两支只差「是否为注释」。
- [x] AC6 AC6 另外两条腿仍有控制：(a) 把夹具 `src/shared/api.ts` 里全部 3 处 `tryResolve` 改名为 `resolveProvider` ⇒ 退出码非零且判词含 `does not ask the registry`；(b) 把夹具 `src/shared/api.ts` 里全部 7 处 `voiceProviderProfile` 改名为 `voiceProfile` ⇒ 退出码非零且判词含 `read points`（hook 侧 `setVoiceProviderProfile(` 保持不动）；两支还原后均退出 0。
- [x] AC7 不碰行为面：`git diff --name-only $(git merge-base HEAD develop) HEAD -- server shared src` 输出为空；改动只落在 `scripts/asr-health-provider-check.mjs`、`scripts/asr-health-provider-check.test.mjs`，不新增生产文件。
- [x] AC8 语法门：`node --check scripts/asr-health-provider-check.mjs` 与 `node --check scripts/asr-health-provider-check.test.mjs` 均退出 0。

## DoD

真实落地不是「把 AC6 这条扫描删掉」，而是**读数的区分能力被证明仍在**：

(a) 主判据在出货树上逐字变绿，且变绿的只因注释不再被当作声明 —— AC5 的「注释形态绿 / 代码形态红」两支控制证明；
(b) 声明扫描仍能抓到真实第二份声明 —— AC4 的真实声明变异必红，`client-capability-table=declared-in-1-file(s)` 指名文件；
(c) AC6 不再是「无控制的读数」 —— AC6 的另外两条腿也各有单点变异控制，删读数或删腿都会红；
(d) 控制面恢复可运行 —— AC2/AC3 证明夹具闭包补齐后四条既有假形态仍按原语义先绿后红，`behavioural-reading=unavailable` 不再出现；
(e) 没有把守卫打穿 —— 健康检查 / 三面 fail-closed / `configured` 字段的行为读数（AC1 所列）逐行与今天一致。

## Touches

- scripts/asr-health-provider-check.mjs
- scripts/asr-health-provider-check.test.mjs
- tasks/gap-asr-health-ac6-scan-and-fixture-staleness.md

## Evidence

主判据在出货树上逐字变绿（`node scripts/asr-config-resolution-check.mjs`，exit 0）：

```
landing=shared/asr
landing-candidate=a
server-compiles-landing=yes
registry-providers=openai-compatible,multimodal,dashscope-omni,sensevoice-local,sensevoice-wasm,dashscope-omni-relay
health-user-configured=true
health-empty-configured=false
health-providers-match-registry=yes
health-unknown-provider=refused-503
proxy-unknown-provider=refused-400-no-fetch
proxy-registered-provider=sent-1
configured-field-present=yes
client-capability-table=none
client-read-points=voiceProviderProfile,setVoiceProviderProfile
verdict=pass
```

控制面恢复可运行（`node --test scripts/asr-health-provider-check.test.mjs`，exit 0，`fail 0`）：

```
✔ AC7/AC8: the landing reading is candidate (a), and a frontend-tree landing is refused
✔ AC1/AC8: a health reading that only looks at the server environment is reported
✔ AC3/AC8: an unregistered provider id that silently falls back is reported
✔ AC4/AC8: a renamed `configured` field is reported, not merely un-flagged
✔ AC6/AC8: a second capability declaration in the client is reported
✔ AC6/AC8: a capability name in a comment is prose, but the same text as code is a declaration
✔ AC6/AC8: a client that no longer asks the registry is reported
✔ AC6/AC8: a client whose capability read points moved is reported
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

AC3 假形态：从 `FIXTURE_FILES` 删掉 `shared/voice/voiceSettingsRegistry.ts` ⇒ 未变异夹具基线红（`behavioural-reading=unavailable`，exit 1）；加回后复绿（8/8）。

AC7：`git diff --name-only $(git merge-base HEAD develop) HEAD -- server shared src` 输出为空；改动只落在 `scripts/asr-health-provider-check.mjs` 与 `scripts/asr-health-provider-check.test.mjs`，无新增生产文件。
AC8：`node --check` 两个文件均 exit 0。
