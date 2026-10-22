---
id: gap-voice-settings-single-surface
title: 语音 settings/rules 收敛成单一抽象：5 个面（voiceConfig / voice-realtime-settings /
  voice-rules.port / voice-mode-rules / mode）收敛为一个共享类型契约 + 规则注册位（镜像 asrRegistry）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22，HEAD 0acd5b0227fd）**：机制词 grep → 命中多条 voice-settings/rules 任务，逐条读均为**行为/存储/UI** 任务（`gap-voice-settings-server-storage` 是设置存服务端、`voice-settings-live-tab-minimal-surface` 是子 tab 最小面、`gap-voice-announce-phrases-settings-key` 等是单个 key）——**无一认领「把散在 5 个面的语音 settings/rules 收敛成单一抽象」**。granularity 报 `peers: []` ⇒ **separate**。

### 现状（立案时实测）

语音设置/规则散在 **5 个面、横跨三层**，没有单一抽象：

1. `src/shared/voiceConfig.ts`（前端，**19 个导出**）
2. `server/modules/voice-realtime/voice-realtime-settings.ts`（服务端，**12 个导出**）
3. `server/shared/ports/voice-rules.port.ts`（`VoiceRulesPort` + install/read）
4. `server/modules/voice-realtime/voice-mode-rules.ts`
5. `server/modules/voice-realtime/mode.ts`

同类里已有正例：ASR 能力就是 `shared/asr/asrRegistry` 单一注册表、前后端都从它 import，没有跨边界重复。语音 settings/rules 缺的正是这个形状。

### 改法

把语音 settings/rules 收敛成一个**共享类型契约 + 规则注册位**（放 `shared/`，镜像 `asrRegistry`）：settings 的 key/默认值单一定义、规则（mode rules / voice rules）经一个注册表注册；前端与服务端各自通过共享契约读取，不再各自散落定义与 getter。**行为保持**：每个 key 的默认值与取值语义不变。

⛔ 护栏：新共享文件放 `shared/`（既有的跨边界共享层，不是新建模块目录）；收敛是「去重复定义 + 单一访问点」，**不得**把前端运行时态与服务端运行时态强行并进同一个可变对象（两边仍是各自的读面，共享的是**类型与默认值契约**，不是实例）。

## Plan

1. **盘点**：列出 5 个面的全部 key/导出/规则，标出**重复定义**（同名 key 两端各一份）与**散落 getter**。
2. **定契约**：在 `shared/` 定义 `VoiceSettings` 类型 + 默认值表 + 规则注册表（镜像 `asrRegistry` 的形状）。
3. **收敛**：5 个面改为从共享契约读取/注册；删除跨面重复的 key 定义；保留各自的运行时读面。
4. **判据**：结构性断言「每个 settings key 只有一处定义、规则只有一处注册」，复用既有的 voiceConfig/settings 测试做行为保持。
5. **收口**：tsc / typecheck / lint，范围受控。

## AC

- [x] (a) **共享契约存在且被引用**：`test -f shared/voice/voiceSettingsRegistry.ts`（或等价共享文件）退出 0；`grep -q "voiceSettingsRegistry" src/shared/voiceConfig.ts server/modules/voice-realtime/voice-realtime-settings.ts` 退出 0。
- [x] (b) **无跨面重复定义**：结构性 grep——每个 voice settings key 在 `src/` 与 `server/` 两端的「定义」合并后，任一 key 的字符串字面量定义只出现在共享契约一处（判据打印 `duplicatedKeys=[]`，具体 keys 清单见判据文件）。
- [x] (c) **规则单点注册**：`voice-rules` 与 `voice-mode-rules` 的规则都经共享规则注册表注册；`grep -rn "installVoiceRules\|registerVoiceRule\|voiceModeRules" server --include='*.ts' | grep -v '/tests/'` 的命中只在注册表与装配点。
- [x] (d) **既有行为判据不改一字仍绿**：`npx vitest run src/shared/tests/voiceConfig.test.ts src/shared/tests/voiceConfigHydration.test.ts` 退出 0；`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/` 下 voice-settings 相关既有判据单跑退出 0（若文件名漂移用等价判据替换并记录）。
- [x] (e) **静态门**：`npm run typecheck` 退出 0；`npm run lint` 退出 0。
- [x] (f) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「语音 settings/rules 有了**单一类型契约 + 单一规则注册位**，跨面重复定义清零」，不是「多了一个共享文件」。必须贴出：①(a) 共享契约的导出面与两个消费端的 import 行；②(b) `duplicatedKeys=[]` 读数（并列出全量 key 清单）；③(c) 规则注册点的唯一命中清单；④(d) 既有判据单跑退出码；⑤(e) typecheck/lint；⑥纯位移核对（每个 key 的默认值与语义未变；无法收敛的 key 逐条列出原因）。运行结束不重启 :3001、不发布。

> 实测补记（执行者，2026-10-22）：①(a) `test -f shared/voice/voiceSettingsRegistry.ts` ⇒ 0；`grep -q voiceSettingsRegistry <两个消费端>` ⇒ 0（两端均 `import ... from '@shared/voice/voiceSettingsRegistry.js'`）。②(b) `node scripts/voice-settings-single-surface-check.mjs` ⇒ `settingsKeys=13 registryKeys=13 duplicatedKeys=[]`；13 个 key：baseUrl / apiKey / sttModel / ttsModel / ttsVoice / ttsFormat / providerId / dashscopeEndpoint / dashscopeApiKey / dashscopeModel / liveVoiceDashscopeApiKey / voiceDataRecording / voiceDataMaxBytes。③(c) 命中 `server/index.ts:21,172`、`server/modules/voice-realtime/index.ts:24,26,37,53`、`server/shared/ports/voice-rules.port.ts:43`——前两处是装配点（注册规则、安装 port），最后一处是注册表的 re-export 面。④(d) vitest 两文件 25/25 绿；server 侧逐文件单跑（按 AGENTS.md 不整目录 fan-out）：voice-realtime-context-and-settings 31/31、status-injection 8/8、context-injection 6/6、voice-settings.db.integration 7/7、voice-dashscope-settings 32/32、voice-config.routes 6/6、claude-resident-dispatch-hook 4/4，均退出 0。⑤(e) `npm run typecheck` 0、`npm run lint` 0（仅既有 warning）。⑥纯位移：默认值表、max-length 表、空文档、规则三臂文本逐字未变，判据 (d) 覆盖；`server/tsconfig.json` 新增 `@shared/*` 别名（镜像前端既有别名），使服务端与浏览器指向同一个模块文件。**无法收敛/未收敛**：`server/modules/voice-realtime/mode.ts`（实际文件名为 `voice-realtime-mode.ts`）里的 `SEGMENTED_RELAY_PROTOCOL` 与浏览器端同名常量重复，但既有判据 `server/modules/voice-realtime/tests/voice-realtime-segmented-default.test.ts` 要求浏览器模块以单引号字面量导出该词并将两侧逐字比对——收敛会红掉该判据，故按现状保留，不改。

> 续做补记（执行者，2026-10-22 第二轮）：上一轮 suite 的唯一红是 `server/modules/voice/tests/voice-provider-dispatch-falsify.test.ts` 的正控制（`the unmutated temp tree must pass the criterion`）。根因是本任务给 `voice.service.ts` 新增的 `@shared/voice/voiceSettingsRegistry.js` **值**导入：该判据用 `cpSync` 复制 shipping 文件搭临时树（原先只有 `shared/asr` + 两个 service sibling），树里没有 `shared/voice`，子进程解析失败 `Cannot find package '@shared/voice'`，正控制 1≠0。修复＝在 `buildTree` 里一并复制 `shared/voice`（判据语义不变：仍是 shipping 文件的拷贝，不是第二份实现；该契约自身零 import，树不需要 node_modules/网络），并把这棵树的 runtime-graph 注释同步更新。单跑该判据：`control=exit-0 mutations=2`，两条 mutation 均按各自原因 red，exit 0。

## Touches

- `shared/voice/voiceSettingsRegistry.ts` (new: VoiceSettings contract, defaults, realtime file keys, rules registry, port)
- `src/shared/voiceConfig.ts` (VoiceConfig = Required<VoiceSettings>; defaults and field list from the contract)
- `server/shared/types.ts` (VoiceSettings re-exported from the contract)
- `server/modules/database/repositories/voice-settings.db.ts` (contract field list and empty document)
- `server/modules/voice/voice.service.ts` (contract field list, bounds and empty document)
- `server/modules/voice-realtime/voice-realtime-settings.ts` (contract realtime key list and context variable)
- `server/modules/voice-realtime/voice-mode-rules.ts` (three rule arms declared as registrations)
- `server/modules/voice-realtime/index.ts` (assembly point: registers the rules, installs the port)
- `server/shared/ports/voice-rules.port.ts` (port storage re-exported from the contract)
- `server/tsconfig.json` (the @shared alias the browser already has)
- `scripts/voice-settings-single-surface-check.mjs` (new: AC b and c criterion, prints duplicatedKeys=[])
- `server/modules/voice/tests/voice-provider-dispatch-falsify.test.ts` (existing falsification criterion; its temp tree now carries the `shared/voice` runtime edge the service's value import added)
- `src/shared/tests/voiceConfig.test.ts` (existing criterion, unchanged, behaviour coverage)
- `src/shared/tests/voiceConfigHydration.test.ts` (existing criterion, unchanged, behaviour coverage)
- `tasks/gap-voice-settings-single-surface.md` (self-touch)
