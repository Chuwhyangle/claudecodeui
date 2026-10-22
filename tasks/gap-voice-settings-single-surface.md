---
id: gap-voice-settings-single-surface
title: 语音 settings/rules 收敛成单一抽象：5 个面（voiceConfig / voice-realtime-settings /
  voice-rules.port / voice-mode-rules / mode）收敛为一个共享类型契约 + 规则注册位（镜像 asrRegistry）
status: todo
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

- [ ] (a) **共享契约存在且被引用**：`test -f shared/voice/voiceSettingsRegistry.ts`（或等价共享文件）退出 0；`grep -q "voiceSettingsRegistry" src/shared/voiceConfig.ts server/modules/voice-realtime/voice-realtime-settings.ts` 退出 0。
- [ ] (b) **无跨面重复定义**：结构性 grep——每个 voice settings key 在 `src/` 与 `server/` 两端的「定义」合并后，任一 key 的字符串字面量定义只出现在共享契约一处（判据打印 `duplicatedKeys=[]`，具体 keys 清单见判据文件）。
- [ ] (c) **规则单点注册**：`voice-rules` 与 `voice-mode-rules` 的规则都经共享规则注册表注册；`grep -rn "installVoiceRules\|registerVoiceRule\|voiceModeRules" server --include='*.ts' | grep -v '/tests/'` 的命中只在注册表与装配点。
- [ ] (d) **既有行为判据不改一字仍绿**：`npx vitest run src/shared/tests/voiceConfig.test.ts src/shared/tests/voiceConfigHydration.test.ts` 退出 0；`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/` 下 voice-settings 相关既有判据单跑退出 0（若文件名漂移用等价判据替换并记录）。
- [ ] (e) **静态门**：`npm run typecheck` 退出 0；`npm run lint` 退出 0。
- [ ] (f) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「语音 settings/rules 有了**单一类型契约 + 单一规则注册位**，跨面重复定义清零」，不是「多了一个共享文件」。必须贴出：①(a) 共享契约的导出面与两个消费端的 import 行；②(b) `duplicatedKeys=[]` 读数（并列出全量 key 清单）；③(c) 规则注册点的唯一命中清单；④(d) 既有判据单跑退出码；⑤(e) typecheck/lint；⑥纯位移核对（每个 key 的默认值与语义未变；无法收敛的 key 逐条列出原因）。运行结束不重启 :3001、不发布。

## Touches

- `shared/voice/voiceSettingsRegistry.ts` (new)（VoiceSettings 类型 + 默认值契约 + 规则注册表，镜像 asrRegistry）
- `src/shared/voiceConfig.ts`（改为从共享契约读取，删除重复 key 定义）
- `server/modules/voice-realtime/voice-realtime-settings.ts`（同上）
- `server/shared/ports/voice-rules.port.ts`（规则改为经共享规则注册表）
- `server/modules/voice-realtime/voice-mode-rules.ts`（规则注册进共享注册表）
- `server/modules/voice-realtime/mode.ts`（读面从共享契约取）
- `src/shared/tests/voiceConfig.test.ts`（既有判据，不改一字，作行为覆盖）
- `src/shared/tests/voiceConfigHydration.test.ts`（既有判据，不改一字，作行为覆盖）
- `tasks/gap-voice-settings-single-surface.md`（自触）
