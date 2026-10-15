---
id: gap-live-voice-turn-detection-silence-in-settings-file-default-800
title: Live Voice 断句窗口进设置文件（silence_duration_ms，缺省 800）；派生尾窗保持派生并钉住
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**来源（本会话实测，`experiments/voice-realtime-fragment-hold-probe/RESULTS.md` 第二轮）**：整句窗口、3 段真实音频 × 4 次重复、`s400` vs `s800`（唯一变量 = 上游 `server_vad.silence_duration_ms`）：

| 读数 | 7c01be7e | a175e6cd | 86559798 |
|---|---|---|---|
| 上游 turn 15→7 / 8→5 / 6→3 | −53% | −38% | −50% |
| **responses（人抱怨的那个症状：每个半句一次 response）** | **9→3（−67%）** | 9→7（−22%） | 5→4（−20%） |
| 被取消的响应（"cut off because you started speaking again"） | 4→1 | 1→1 | 1→0 |
| 内容覆盖率 relay字/ASR字（不丢内容） | 1.02→0.96 | 1.01→0.87 | 0.89→1.01 |
| 末 stop → 末投递（代价） | +513 ms | +240 ms | 0 ms |
| 单次花费 | −55% | −29% | −3% |

⇒ **800 该出货**（理由＝症状与成本，不是"投递条数减半"——投递条数只在过切分最重的那段从 4 降到 1）。

**现状（已核对）**：
- 出货值写死在 `voice-realtime-turn-detection.ts:70`：`DEFAULT_TURN_DETECTION = { type:'server_vad', threshold:0.5, silence_duration_ms:400 }`，并带 `SILENCE_DURATION_MS_RANGE = {min:200,max:6000}`。
- **env 覆盖已经存在**：`VOICE_REALTIME_TURN_DETECTION` / `_SILENCE_MS` / `_THRESHOLD`，经 `resolveTurnDetection(process.env, override?)`（`server/index.ts:621` 带 override、`voice-realtime-ws-proxy.service.ts:2150` 只带 env）。
- **设置文件面（`VOICE_REALTIME_SETTINGS_PATH` → JSON）目前只认 `version`/`instructions`/`contextTemplate`**，没有任何 turn-detection 键；而代理在 `:1938` 已经 `loadVoiceRealtimeSettings(...)` ⇒ **接线点已就绪**，只差把文件里的值传进 `:2150` 那次 `resolveTurnDetection`。

**改法（两件）**：

1. **设置文件提供 `turnDetection`**（与线上形状同名：`{ type, threshold, silence_duration_ms }`）：缺对象、或缺 `silence_duration_ms` 时取 **800**。
   - **优先级：env > 文件 > 800**（env 仍是部署逃生口），并把**解析结果与来源**记进日志（`describeTurnDetection` 已有，把它接上）。
   - 文件里的值走**既有范围校验**；越界/类型错按既有拒绝路径：回落默认 + 进 `problems`，**绝不抛**。
   - 设置文件里出现**未知键**时沿用文件加载器现有的处理方式（不要新造一套）。
2. **派生尾窗：不提供独立配置，保持派生——这是"检查"的结论**，三条理由：
   - ① 门控的 `a = round((silence + 200) / 20) + 1` 里那个 **`+1` 边界帧是承重的**：出货 400 正好压在上游 `server_vad` 的 `>=` 收口语义上（`voice-realtime-uplink-vad-gate.ts:47-52` 记着这条推理）。默认改 800 后这个关系要**重新核对**，而不是随手加个独立旋钮。
   - ② 独立配置允许出现**不一致的组合**（门控尾窗 ≠ 上游收口语义）⇒ 会落回 gate 注释里记的那个失效形态（"尾窗正好等于 silence 时，回合会一直开到下一句的 pre-roll"）。
   - ③ **800 下派生值自洽**，不需要另调：`uplinkHeadKeepFrames(800) = round(1000/20)+1 = 51`（400 时是 31）；`holdOpenFrames = round(2000/20) = 100`，`holdOpenEnabled = 100 > 51` 仍为真。
   ⇒ 交付形式是**核对 + 钉住**：把这条判断写进 gate 的注释，并用单测钉住派生关系（见 AC5/AC6），这样将来谁要加独立旋钮，必须先有意识地删掉那条钉住。

<!-- dedup-ref --> **相关任务与粒度决定**：granularity 工具对三个主子文件报 `peers: []`（无 Touches 重叠的开放任务）。与本会话已立的两条（`gap-live-voice-dispatch-hook-production-wiring`、`gap-live-voice-busy-release-quiet-window-next-priority`）**改的是不同机制**：那两条分别动 hook 注入与忙时投递释放点，本条只动"断句窗口的配置面 + 默认值"，验收独立 ⇒ 分开立。`voice-realtime-ws-proxy.service.ts` 历史落地 46 个任务、中位改动 830 行——**本条在该文件里只改一行（把文件值传进 `resolveTurnDetection`）**，实现要小步。

## AC

- [x] AC1（文件键生效）：临时写一份设置 JSON（含 `turnDetection.silence_duration_ms = 600`），用 `loadVoiceRealtimeSettings` 读到它、并经 `resolveTurnDetection` 解析 ⇒ 得到 **600**；断言用脚本（`npx tsx --tsconfig=server/tsconfig.json --test <新增/既有 settings 测试文件>`）退出 0，读数记入 `## Notes`。
- [x] AC2（缺省 800）：同一测试里断言 —— 文件**没有** `turnDetection` 对象时、以及对象在但**没有** `silence_duration_ms` 时，解析结果都是 **800**；`grep -n "silence_duration_ms: 800" server/modules/voice-realtime/voice-realtime-turn-detection.ts` 有输出（默认值已改）。
- [x] AC3（优先级 env > 文件 > 默认）：env 设 `VOICE_REALTIME_TURN_DETECTION_SILENCE_MS=500` + 文件设 600 ⇒ 得 **500**；env 无 + 文件 600 ⇒ 600；两者都无 ⇒ 800。三条断言写进同一测试文件，并把这条优先级写成代码注释（`voice-realtime-turn-detection.ts` 的 `resolveTurnDetection` 头部）。
- [x] AC4（越界仍走既有拒绝路径）：文件里写 `silence_duration_ms: 100`（低于 min 200）⇒ 解析回落 **800**、`problems` 非空且含该键名；测试退出 0，`problems` 原文记入 `## Notes`。
- [x] AC5（派生尾窗：核对并钉住）：单测断言 `uplinkHeadKeepFrames(800) === 51` **且** `uplinkHeadKeepFrames(400) === 31`（frameMs=20、margin=200、boundary=1）；并在 `voice-realtime-uplink-vad-gate.ts` 的 `uplinkHeadKeepFrames` 注释里写明**为什么它仍保持派生、不提供独立配置**（把上面 ①②③ 写进去，引用 400→800 的改动）。
- [x] AC6（hold-open 关系不变）：单测断言 `UPLINK_VAD_HOLD_OPEN_MAX_MS` 派生出的 `holdOpenFrames = 100` 与 800 下的 `aFrames = 51` 满足 `holdOpenEnabled === true`（即 `100 > 51`）；若实现里该关系是内部量，则以 gate 暴露的读数断言。
- [x] AC7（不削弱既有判据 + 钉住点全部更新）：`npm run typecheck` 与 `npm run lint` 各自退出 0；单跑这五个文件各自退出 0：`voice-realtime-turn-detection.test.ts`、`voice-realtime-context-and-settings.test.ts`、`voice-realtime-uplink-vad.test.ts`、`voice-realtime-uplink-vad-seam.test.ts`、`voice-realtime-uplink-vad-hold-open.test.ts`。⚠️ `voice-realtime-turn-detection.test.ts` 里有 **4 处 400 的字面量**（含 `DEFAULT_WIRE` 与 `ANCHOR = 'silence_duration_ms: 400,'` 这类**源码钉住**）⇒ 逐处按新默认更新，并把**改动前后逐字**记入 `## Notes`。
- [x] AC8（端到端）：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 单跑退出 0；若该 spec 依赖具体 silence 值而转红，**不得**改判据迁就——把红读数与原因记入 `## Notes` 并停手 needs-human。
- [x] AC9（文档）：若 `docs/operations/voice-realtime-continuous-calibration.md`（或其它文档）描述了设置文件的键集，则把 `turnDetection` 与"缺省 800"补进去；若没有文档描述该键集，则在 `voice-realtime-settings.ts` 的 `loadVoiceRealtimeSettings` 头部注释里写明。两种情形都要在 `## Notes` 里指明走的是哪一支。

## DoD

真实会话里解析出的 `silence_duration_ms` 是 **800**（journal/日志里可见 `describeTurnDetection` 的那行，含来源），且行为按实验预期改变（同一段音频的上游 turn 数明显下降）；**在设置文件里改这个值能生效**（改成 600 后日志显示 600），**删掉该键回落 800**；派生尾窗随之变为 51 帧且**没有**独立的配置项——将来有人要加独立旋钮，必须先删掉 AC5/AC6 那两条钉住。

## Touches

- server/modules/voice-realtime/voice-realtime-turn-detection.ts
- server/modules/voice-realtime/voice-realtime-settings.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-uplink-vad-gate.ts
- server/index.ts
- server/modules/voice-realtime/tests/voice-realtime-turn-detection.test.ts
- server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts
- server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts
- server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts
- server/modules/voice-realtime/tests/voice-realtime-uplink-vad-hold-open.test.ts
- server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.test.ts
- server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts
- server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts
- tasks/gap-live-voice-turn-detection-silence-in-settings-file-default-800.md

## Notes

### Touches 扩了 6 个（原先只声明 8 个）

把出货默认 400 → 800 落下去之后，实现逐处盘了"谁钉住了这个值"，6 个新文件都是必然连带，没有一个是顺手改的：

- `server/index.ts` —— 生产装配点那句注释逐字写着 "shipped default (`server_vad`/0.5/400 ms)"，改默认值后它变成假话；**只改这半句注释**，装配逻辑一字未动。
- `tests/voice-realtime-uplink-vad-seam.test.ts` —— 三处承重：① `A_DEFAULT === 31` / `620 ms` 的钉住（现为 51 / 1020 ms，改成 AC5 的显式读数）；② 两个固定 30 帧的语料在新 `a=51` 下**一帧都不再丢**（腿会静默变真空），改成 `A_DEFAULT + N` 让丢弃与读数在任一出货窗口下都成立；③ AC3 腿的窗口必须显式钉住（下节）。
- `tests/voice-realtime-uplink-vad-hold-open.test.ts` —— AC6 的断言落点（原本只有 `assert.ok(CAP > A)` 一句，没有 800 下的显式读数）。
- `tests/voice-realtime-dashscope-transport.test.ts` —— `DEFAULT_SESSION_DEFAULTS.turn_detection` **就是** `DEFAULT_TURN_DETECTION` 这个冻结对象（该文件自己的 GOAL-037 腿钉死了这条同一性），所以它那条逐字节 pin 必然跟着动。
- `tests/voice-realtime-scripted-upstream.ts`、`tests/voice-realtime-fake-vad-upstream.test.ts` —— 各一句交叉引用注释写着 "this repository sets/ships 400"，被本次改动变成假话；**只改注释**，fixture 的值（`DEFAULT_SILENCE_DURATION_MS = 400`、`SILENCE_MS = 400`）与它们的读数一律不动。

未改但已看过、判断**不动**的：`docs/operations/voice-realtime-uplink-vad-scheme.md:86`「出货值 400 ⇒ a = 420 ms」——这句在本改动**之前**就已经不对（`a = (400+200)/20+1 = 31` 帧 = **620 ms**），属既有失真、非本次引入，不动（改它得连 ④ 图与 §10 的数一起重写，超出本条）；`docs/operations/voice-realtime-vad-three-arm-probe*.md` 里三处「出货 turn_detection 逐字节 = 400」是**当次实跑的读数记录**，按"读数不改写"的惯例保留（它们是那次运行的真相，不是接口描述）。

### AC3 腿的取景变了 —— 这是本次唯一一处，必须说明

该腿的判据是「本地语音门按到达无条件喂入」。要让它非真空，VAD 的 head-keep 窗口 `a` 必须**小于**本地门的 25 帧收口 run（`DEFAULT_EXIT_FRAMES=25`）——否则收口发生在窗口之内、每一帧都被转发了，腿会绿着什么都不证明。而 `a = (silence + 200)/20 + 1`，要 `a < 25` 就得 silence < 280 ms：出货 400 时 `a = 31`（**旧注释里那句 `a = 21` 漏掉了 200 ms 余量，所以这条腿当时就已经不是它自称的形态**），出货 800 时 `a = 51`——**两个都不满足**。

所以这条腿显式钉 `silenceDurationMs: 200`（范围下限，`a = 21`），并新增断言 `AC3_A < 25`（窗口一旦不够小，腿自己先红）。断言强度未降：`withheld.every(帧不曾在线上)` 现在**真的**成立（收口帧 index 39 ≥ 15+21=36，确实被丢），假形态仍红（变异后 turnUnanswered === 0）。取景从「跟随出货默认」变成「显式钉住」，是因为跟随出货默认这条路在新值下**结构上不可满足**，而不是判据松了。

### AC1 读数

临时设置 JSON `{"turnDetection":{"silence_duration_ms":600}}` → `loadVoiceRealtimeSettings` → `resolveTurnDetection({}, {}, 读到的 turnDetection)` ⇒ `silence_duration_ms = 600`，`problems = []`。

`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts` → **10 pass / 0 fail, exit 0, 1.19 s**（该文件原有 4 条 + 本次 6 条）。同文件另有连接级读数：带 600 的设置文件起一条真连接，日志逐字出现 `turn detection: server_vad/0.5/600ms — silence from the settings file`（DoD 的「改成 600 后日志显示 600」）；文件不写该键时该类日志**一行都没有**。

### AC2 读数

- 文件无 `turnDetection` ⇒ 800（`problems = []`）；文件有对象但无 `silence_duration_ms`（只给 `type`/`threshold`）⇒ 800（`problems = []`，缺字段不是拒绝）。
- `grep -n "silence_duration_ms: 800" server/modules/voice-realtime/voice-realtime-turn-detection.ts` → `95:  silence_duration_ms: 800,`（exit 0）。

### AC3 读数

env=`VOICE_REALTIME_TURN_DETECTION_SILENCE_MS=500` + 文件 600 ⇒ **500**；env 无 + 文件 600 ⇒ **600**；两者皆无 ⇒ **800**（`DEFAULT_TURN_DETECTION` 读出的，不写死）。优先级以 `resolveTurnDetection` 头部注释落地（`⛔ PRECEDENCE, FIELD BY FIELD: OVERRIDE > ENVIRONMENT > SETTINGS FILE > SHIPPED DEFAULT`），逐字段独立解析，所以一份只写 `silence_duration_ms` 的文件其余字段仍走 env / 默认。

### AC4 读数（`problems` 原文）

文件 `{"turnDetection":{"silence_duration_ms":100}}` ⇒ 解析回落 **800**，`problems` 逐字为：

```
["silence_duration_ms 100 is not an integer in [200, 6000]"]
```

含键名 `silence_duration_ms`；测试退出 0，未抛。拒绝**不半应用**：被拒字段从读数里丢掉（`settings.turnDetection` 为空对象），整份设置按既有拒绝路径回落默认+problems。

### AC5 / AC6 读数

- `uplinkHeadKeepFrames(400) === 31`、`uplinkHeadKeepFrames(800) === 51`（frameMs=20、margin=200、boundary=1）；`51 − 31 === 20`（多出的 400 ms 正是 20 帧）；`A_DEFAULT`（出货默认解析出的）与 `uplinkHeadKeepFrames(800)` 相等。落在 `voice-realtime-uplink-vad-seam.test.ts`，该文件 **29 pass / 0 fail**。
- `UPLINK_VAD_HOLD_OPEN_MAX_MS = 2000` ⇒ `CAP = 100` 帧，出货 `A = 51` 帧，`CAP > A` 为真（即内部量 `holdOpenEnabled`）；并以 gate 暴露的行为作第二条读数：上游回合保持开着时 `heldOpen = CAP − A = 49`（说明这个关系真在起作用）、`closeTurnAt = [5 + CAP]`（上限仍然兜住，且只请求一次收口）。落在 `voice-realtime-uplink-vad-hold-open.test.ts`，**9 pass / 0 fail**。
- 注释落地：`uplinkHeadKeepFrames` 的 doc 里写明**为什么保持派生、不提供独立配置**（①②③ 三条 + 400→800 的引用），并明说"将来谁要加独立旋钮，必须先删掉这两条钉住"。`UPLINK_VAD_HEAD_BOUNDARY_FRAMES` 的注释重核了那个 `+1` 在 800 下的角色（余量已把 `a` 推到窗口之外，`+1` 仍是边界保险）。

### AC7 读数

- `npm run typecheck` → **exit 0**；`npm run lint` → **exit 0**（243 条既有 warning，**无一条落在本次改动的文件上**，无 error）。
- 五个文件单跑（各自 exit 0）：

| 文件 | 读数 |
|---|---|
| `voice-realtime-turn-detection.test.ts` | 10 pass / 0 fail |
| `voice-realtime-context-and-settings.test.ts` | 10 pass / 0 fail |
| `voice-realtime-uplink-vad.test.ts` | 10 pass / 0 fail |
| `voice-realtime-uplink-vad-seam.test.ts` | 29 pass / 0 fail |
| `voice-realtime-uplink-vad-hold-open.test.ts` | 9 pass / 0 fail |

**4 处 400 字面量，改动前后逐字**（均在 `voice-realtime-turn-detection.test.ts`）：

1. `const DEFAULT_WIRE = '{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}';` → `const DEFAULT_WIRE = '{"type":"server_vad","threshold":0.5,"silence_duration_ms":800}';`
2. `      turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 400 },` → `      turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800 },`
3. `  const ANCHOR = 'silence_duration_ms: 400,';` → `  const ANCHOR = 'silence_duration_ms: 800,';`
4. `    writeFileSync(mutPath, source.replace(ANCHOR, 'silence_duration_ms: 800,'), 'utf8');` → `    writeFileSync(mutPath, source.replace(ANCHOR, 'silence_duration_ms: 900,'), 'utf8');`（假形态必须变到**另一个**值；400→800 会退化成不动）

**另有一处非字面量、但同样必须跟着动的**：AC6 假形态注入的变异串里用了 `rawString(env, VOICE_REALTIME_TURN_DETECTION_ENV, override.type)`，而本次把该私有读取器扩成三源版并改名 `provided(env, name, override, file)`。变异串逐字改成 `provided(env, VOICE_REALTIME_TURN_DETECTION_ENV, override.type, file.type)`；不改就是 `ReferenceError`（首次跑出来的红，正是这条），而**不是**判据本身的问题。AC5 假形态那条（把默认值写死成另一个数）未动。

**顺带看到的既有抖动（不是本次引入）**：`voice-realtime-uplink-vad-seam.test.ts` 的 `AC4 false form — dropping the per-frame activity call` 一条依赖墙钟——语料 120 帧按 50 ms/块喂满 **正好 300 ms**，而 `idleRotateMs` 也是 300 ms，边界上会偶发红。首轮复跑红一次、随后连跑两轮全绿（29/29）。**未改它**（与本任务无关，改它会动另一条判据的取景），记在这里供 fan-in 遇到时识别。

### AC8 读数

`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 单跑两次，两次都是 **11 passed / 0 failed，exit 0**（第一次 35.7 s，改完全部文件后复跑 34.5 s）。该 spec **不**依赖具体 silence 值（它自己的 scripted 上游固定 `silenceDurationMs: 400`，断言只读 `turnDetection === 'server_vad'`），所以没有出现「判据依赖旧值而转红」的情形，也就**不需要**走「记红停手 needs-human」那一支。

### AC9 走的是第二支

**没有任何文档描述这个设置文件的键集。** 全仓唯一提到 `VOICE_REALTIME_SETTINGS_PATH` 的是 `docs/operations/voice-realtime-continuous-calibration.md`，而它是 C-5 那次运行的**测量记录**（"第二个实例用 C-5 自带指令的设置文件跑"），不是接口描述，没有键表可补。⇒ 按 AC9 第二支，把键集（含新增的 `turnDetection`，逐字段可选、缺省 800、越界走 `problems`、未知键忽略）写进 `voice-realtime-settings.ts` 的 `loadVoiceRealtimeSettings` 头部注释（`THE KEY SET` 一节）。

### 其余落地说明

- `describeTurnDetection` 保持原契约（干净解析返回 `null`）**不变**，新增可选的第二参 `origin`：给了来源就总是返回一行（值 + 来源），不给就退回旧行为。`server/index.ts` 的既有调用一字未改，`experiments` 侧的调用也未受影响。
- 连接级的"解析结果与来源"日志挂在设置文件**点名**了 `turnDetection` 时（`Object.keys(settings.turnDetection).length > 0`）——这正是运维在看的那件事（"我改了文件，生效了吗"）。解析提到连接建立时做**一次**，gate 分支复用同一个结果，所以日志里的值与 gate 拿到的值不可能不一致；`uplink_vad:` 那行继续带 `silenceMs=`/`aFrames=`（**生效值**，含 seam 覆盖）。一份不写 `turnDetection` 的文件仍然一行都不多，所以"没有日志"继续等于"没配"。
- 一个更宽的回归面也单跑了，全绿：`arm-point` 28、`diagnose` 12、`dashscope-transport` 14、`fake-vad-upstream` 13、`scripted-upstream-state` 26、`manual-vad-session-update` 6、`transport-opt-in` 8、`context-injection` 6、`scripted-scenarios` 29、`ws-proxy.protocol-simulation` 19。特别地 `uplink-vad-arm-point` 里那条 `assert.deepEqual(resolveTurnDetection({}), { turnDetection, invalid: null })` **仍然通过**——本次刻意**没有**给 `TurnDetectionResolution` 加字段（来源是另起的纯函数 `describeSilenceDurationSource`），就是为了不动那条跨任务的形状 pin。
