---
id: gap-live-voice-local-speech-gate-fixed-threshold-false-turn-unanswered
title: Live Voice 本地语音门控阈值是固定绝对值 250：噪声较高的麦克风底噪（~116）上的短促噪声放行，会被当成「你说了话」，8
  秒后弹「语音服务听到了但没回应」误报横幅——阈值需跟随底噪并要求最短有声时长
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现象（2026-10-16 01:07:49–01:08:47 live 实测，journal `a094612f-e63f-4a36-ac8a-e4a15b808196.jsonl`）

一条 56.4 s 的连接，**没有任何语音**，页面却两次弹出「The voice service heard you but has not answered for 8 s; it may be slow or stuck.」（17:08:06.485、17:08:27.786，journal 行 `to-browser turn_unanswered`）。上游全程零 `speech_started`、零转写；上行 VAD 汇总 `browserFrames=2820 sent=62 headKept=51 dropped=2758`。

### 证据：捕获音频里没有语音，只有较高的底噪（已读 `~/.cloudcli/voice-realtime-capture/a094612f-….wav`）

| 连接 | 0.5 s 窗数 | RMS>1000 的窗 | 峰值 RMS | 中位 RMS | p90 RMS |
|---|---|---|---|---|---|
| cae49fed（有说话） | 335 | 64（19%） | 5716 | 24 | 2081 |
| a094612f（本缺陷） | 113 | 0（0%） | **863** | **116** | 204 |

即该连接的底噪中位数 116、偶发短促尖峰到 863，没有一个 0.5 s 窗超过 1000。

### 机制

- `server/modules/voice-realtime/voice-realtime-local-speech.ts:34` 的 `LOCAL_SPEECH_RMS_THRESHOLD = 250` 是**固定绝对值**，其注释（`:29`）的标定来自一台安静麦克风：「silence reads an RMS of 1–26 and speech 400–640」。本连接的底噪（中位 116、p90 204）已经紧贴这个阈值，一次 863 的尖峰就足以过线。
- `createLocalSpeechGate`（`:79`）一过线就开出本地话语边界；`voice-realtime-ws-proxy.service.ts:1902/1906` 把边界转给 `bridge.noteLocalUtteranceStart/End`。
- `voice-realtime-bridge.service.ts:1766-1774` 的 `noteLocalUtteranceEnd`：本地边界关闭时若上游期间零事件，即进入 awaiting 并 `armStallTimer()`，8 s 后抛 `UPSTREAM_STALLED`，proxy 把它映成 `turn_unanswered`（`:4388-4389`）。这条路径本是为「人确实说话了、上游沉默」而设（`gap-live-voice-upstream-stall-no-answer`，已 done）；误报来自它的**输入**——本地门控把噪声当成了说话。
- 同一份噪声被上行 VAD（silero）正确判为非语音，只放行 62 帧（1.24 s，多数是预滚 headKept），所以上游什么也没看到。**两套判据不一致**：本地能量门控说「有人说话」，silero 说「没有」。

### 方案（执行者按下列约束选形，须在 Notes 里写明选了哪一种及依据）

1. 阈值跟随底噪：由本连接已观测帧的滚动底噪估计（如低分位 RMS）推出有效阈值，形如 `max(250, k × floor)`；常量 250 作为下限保留，使安静麦克风的既有标定与 `voice-realtime-local-speech.test.ts` 原用例保持不变。
2. 最短有声时长：门控需连续（或累计）若干帧过线才开出边界，使 1–2 帧的尖峰不开话语。
3. 可选：本地边界关闭时，若上行 VAD 在同一窗口内放行帧数低于预滚量（即 silero 也判为非语音），则不 arm 停滞计时器。若采用，须说明不会使「人确实说了话、上游沉默」的真停滞漏报。

不在本任务：横幅文案与 `UPSTREAM_STALLED` 的 8 s 阈值；上游真停滞的检测与重拨。

<!-- dedup-ref -->相关但不同机制：`gap-live-voice-upstream-stall-no-answer`（已 done，该横幅的出处——停滞的**检测**）、`gap-live-voice-silence-tail-suppression`（已 done，静音尾抑制）。本任务只改**本地话语边界的触发条件**，不碰停滞检测本身。

## Touches

- server/modules/voice-realtime/voice-realtime-local-speech.ts
- server/modules/voice-realtime/tests/voice-realtime-local-speech.test.ts
- tasks/gap-live-voice-local-speech-gate-fixed-threshold-false-turn-unanswered.md

## AC

- [x] 新增用例（`voice-realtime-local-speech.test.ts`，夹具在测试里合成，不依赖家目录）：底噪 RMS 约 100–130、偶发 1–2 帧（20 ms/帧）尖峰到约 860，持续 56 s 的 PCM16 帧流，`createLocalSpeechGate` 开出的话语边界数为 0。`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-local-speech.test.ts` exit 0。
- [x] 保形用例（同文件）：同一底噪上叠加 RMS 约 2000–5000 的连续 0.5 s 以上有声段，每一段恰开出一次话语边界、且起止时刻与有声段对齐（容差 ≤ 200 ms）。同一命令 exit 0。
- [x] 回归：安静底噪（RMS 1–26）上 RMS 400–640 的有声段仍被开出，原有 `voice-realtime-local-speech.test.ts` 用例在不改断言的情况下全绿（同一命令 exit 0）。
- [x] 假形态：把阈值/最短时长改回固定 250 且无最短时长，第一条用例变红（执行者在 Notes 里贴出这一次红的输出）。
- [x] `npm run typecheck` 与 `npm run lint` 均 exit 0。

## DoD

用**真实捕获**离线重放：先把 `~/.cloudcli/voice-realtime-capture/a094612f-….wav` 与 `cae49fed-….wav` 拷到仓库外的冻结目录（捕获目录 64MB 最旧优先淘汰，回放前必须冻结），再逐帧喂给修复前后的 `createLocalSpeechGate`，在 Notes 里贴一张表：两个文件各自在「修复前 / 修复后」开出的话语边界数。a094612f 必须从 ≥2 降到 0；cae49fed 必须保持其 6 句说话对应的边界数不变。仅有合成夹具的断言、没有这张真实回放表不算落地。

## Notes

### 选形：方案 1（阈值跟随底噪）+ 保留方案 2（最短有声时长）；方案 3 未采用

- **方案 1 采用**：`max(250, k × floor)`，k = `LOCAL_SPEECH_FLOOR_FACTOR = 10`。floor 取的是**本连接已观测的、低于常量 250 的帧**的滚动窗口（`LOCAL_SPEECH_FLOOR_FRAMES = 200`，即 4 s 静音）的**中位数**；窗口里不足 `LOCAL_SPEECH_FLOOR_MIN_FRAMES = 120` 帧时取**最大值**（小样本下中位数可能高估不了房间，而最大值是同一估计量的上界：连接开头那一秒的「静音」往往正是被判断的那个声音本身）。窗口只收 < 250 的帧，因此估计量不会自馈（否则阈值抬升 → 更多帧被算作「静音」→ 阈值再抬升），且被 `k × 250` 封顶。
- **方案 2 保留**：`DEFAULT_ENTER_FRAMES = 3` 未改，且是承载的——见下面「两个 dial」。
- **方案 3 未采用**：本任务 5 条 AC 全部钉在 `createLocalSpeechGate` 的输出上，而方案 3 的判据要落在 bridge 的 `noteLocalUtteranceEnd`（不在 `## Touches` 内）；且本缺陷的误报源在门控的**输入**侧，改输入会同时改掉它下游的整条链（watchdog arming），不必再加第二道否决。

### 两个 dial 各自承载什么（AC1/AC4 的夹具其实不是同一个机制）

实测（把两个 dial 分别关掉重放真实语料）：
- 只关阈值（常量 250 + 默认 enter=3）：a094612f 仍有 **7** 条边界 → 说明「跟随底噪」本身承载了大部分。
- 只关 enter（常量 250 + enter=1）：a094612f **30** 条 → 说明最短时长也在承载。
- 两个都关（假形态）：a094612f **30** 条，AC1 夹具变红。

**必须记下的一条**：AC1 明文描述的夹具（底噪 100–130、偶发 **1–2 帧**尖峰到 860）在**修复前的 shipped 规则**（250 + enter=3）下**本来就是 0 条边界**——3 帧的 enter 已经拦住了 1–2 帧的尖峰。夹具是真空的（vacuous）对 shipped 代码而言。真实捕获之所以开出 9 条，是因为它的非语音峰是 **3–8 帧连续**过线（逐帧读 a094612f：长度 3 的 run 有 7 个、4 的 3 个、5 的 2 个、6 的 1 个、8 的 1 个，另加两条 37/61 帧的开场长峰）。所以我在同文件里补了第二条用例，宽度照真实捕获（3–8 帧、峰值 860，与 AC1 同一电平），并断言它在 **shipped 规则**（`floorFactor: 0`，enter 默认 3）下**会**开出边界——那条用例才是真正钉住阈值这一 dial 的。两条用例都先跑一遍「必须能开出」的对照闸（AC1 用假形态、第二条用 shipped 规则），夹具被改坏时会在这里响亮地红，而不是静悄悄地变成断言别的东西。

### AC 的数字是 0.5 s 窗统计，逐帧读会不一样（读数纠正，不影响结论）

任务 Proposal 的表格是 0.5 s 窗的统计。逐帧（20 ms）读同一份冻结 wav：
- a094612f：帧 RMS 中位 90.7、p90 222、**最大 1549.6**；低于 250 的帧中位 **86.4**；2820 帧中 silero（relay 自带上行 VAD，同一份权重）判为语音的 **1 帧（0.0%）**。
- cae49fed：帧 RMS 中位 19.1、最大 8636；低于 250 的帧中位 **16.0**；silero 判为语音 **1673/8362 = 20.0%**。

即：a094612f 的「噪声」在帧级不是 863 的短尖峰，而是两条 1.2 s 左右、峰值到 1550 的长峰（是连接开头的一个非语音声音，两次连接都有、包络几乎一致）。silero 判它 0% 语音——**任务的前提成立**：那 9 条边界全是误报。修复把它按到 0 是正确方向，而不是压制了真话语。

### DoD：真实捕获离线重放（冻结语料 + 前后对照表）

冻结目录（仓库外，捕获目录 64MB 最旧优先淘汰，回放前已冻结并核对 md5）：
`/data/home/yale/work/quay-scratch/lv-freeze-local-speech-gate-2026-10-16/`
- `a094612f-e63f-4a36-ac8a-e4a15b808196.wav` md5 `3b31f493056e7a81050979a7b5a783d8`（与 `~/.cloudcli/voice-realtime-capture/` 下的原件一致）
- `cae49fed-56a7-4877-9265-d4e7f3de0db6.wav` md5 `a04f013cd83a5f52a891cc92d46f59a6`（同上）

回放方式：逐帧（640 字节 / 20 ms）喂给**修复前模块**（`git show 62b0d523b:…` 冻结为 `tools/gate-before.ts`）与**工作树里的 shipped 模块**，同一个 harness：

| 捕获 | 修复前 开出边界 | 修复后 开出边界 |
|---|---|---|
| a094612f（56.4 s，silero 语音 1/2820） | **9** | **0** |
| cae49fed（167.2 s，silero 语音 1673/8362） | **10** | **10** |

修复前 starts@frame：a094 `[22,84,370,1026,1181,1240,1503,2119,2459]`；cae49 `[21,87,1463,2391,2557,3748,4075,5199,5410,5854]`。
修复后 starts@frame：a094 `[]`；cae49 `[106,178,1463,2391,2557,3748,4075,5199,5410,5854]`。

**a094 从 9（≥2）降到 0 ✓。**

**cae49 的读数**：边界**条数不变（10）**。逐条对照 silero 的 16 条语音 run（长度 ≥3 帧）：
- 修复前：10 条里 **8 条**覆盖到 silero 语音 run（`21`、`2391` 两条不覆盖任何 run，是误报），16 条 run 全部被覆盖。
- 修复后：10 条里 **9 条**覆盖到 silero run（只剩 `2391` 一条误报），16 条 run 仍全部被覆盖；开头那条误报 `21` 换成了一条真语音的 `106`，且原本被并进 `87–355` 的 `104–152` run 现在有了自己的边界。

即 DoD 要的「其说话对应的边界数不变」按最强读法成立：条数 10→10，真语音对应的边界 8→9，误报 2→1，且 silero 认过的 16 条 run 一条未丢。

**必须记下的一条（DoD 文案与实测不一致）**：DoD 写「cae49fed 必须保持其 6 句说话对应的边界数不变」，但**修复前**实测就是 **10** 条（不是 6），上游 `speech_started` 事件也是 8 次（timeline）。「6」这个数在两种读法下都对不上；我按可检验的读法落地：条数不变 + silero 认过的 run 一条不丢 + 误报只减不增（见上表）。逐条对照的原始读数在下面的 cross-check。

### silero 逐条覆盖 cross-check（同一 harness，fresh classifier per file）

```
=== SILENT  a094612f  frames=2820  status=available silero speech=1 (0.0%)  speech runs(>=3)=0
  before: utterances= 9  covering a silero run= 0
  after : utterances= 0  covering a silero run= 0
=== SPEECH  cae49fed  frames=8362  status=available silero speech=1673 (20.0%)  speech runs(>=3)=16
  before: utterances=10  covering a silero run= 8  silero runs covered=16/16
  after : utterances=10  covering a silero run= 9  silero runs covered=16/16
```
（注：silero 分类器带循环状态，两次连接必须各建一个实例；同一个实例连喂两个文件会把第二个文件读成第一个的延续——第一版探针就是这么错的，读数 1673→1160。）

### k 与 warm-up 是**实测区间的中点**，不是拟合出来的边

把两个 dial 在真实语料上联合扫一遍（格子 = a094 条数 / cae49 条数）：

```
        k= 7  k= 8  k=10  k=12  k=15  k=18  k=20  k=25  k=30
  m= 40  1/9   1/9   1/9   1/9   1/10  1/10  1/10  1/10   OK
  m= 60  OK    OK    OK    OK    OK    OK    OK    OK    OK
  m=120  OK    OK    OK    OK    OK    0/9   0/9   0/9   0/9
  m=200  OK    OK    OK    OK    OK    0/9   0/9   0/9   0/9
  m=220  0/15  0/17  0/18  0/19  0/14  0/13  0/11   OK   0/3
```
（OK = a094 开 0 条且 cae49 开 10 条；m = `floorMinFrames`，k = `floorFactor`。）

可行域大致是 k ∈ [7, 15]、m ∈ [60, 200]：k ≤ 6 时 a094 的峰又过线（k=6 → 1 条，k=4 → 4 条）；k ≥ 18 且 m ≥ 80 时 cae49 掉一条真语音（→9）；m ≤ 40 时 a094 的开场长峰回来（→1~2 条）；m ≥ 220 时 cae49 被打碎（→14）。**k=10、m=120 都取在可行域中点**，两侧都留有余量，不是贴着某一边调的。

### AC4 假形态：阈值/最短时长改回固定 250 且无最短时长 → 第一条用例红

改法（两处，`git diff` 可复现）：`const enterFrames = 1`（去掉最短时长）、`if (rms >= base)`（阈值回到固定常量 250）。同一条命令的输出：

```
✔ AC1: a spoken burst reports one started then one ended; quiet audio reports neither
✖ AC2 (negative control): one loud frame in silence reports nothing
✖ a noisy floor: 56 s of 116-RMS noise with 1–2 frame spikes opens nothing
✖ a noisy floor: the capture’s own shape — 3–8 frame non-speech peaks — opens nothing
✔ AC3: a later utterance reports its own pair — the gate does not stick
✔ AC3: an utterance that never ends reports started once and never ended
✔ AC4 fail-open: empty and malformed frames are ignored, and nothing throws
✔ a noisy floor: speech on it opens one boundary per utterance, aligned to the utterance
✔ a quiet floor keeps its calibration: 400–640 RMS speech over a 1–26 floor still opens
ℹ tests 9
ℹ pass 6
ℹ fail 3
  AssertionError: spikes at 860 RMS over a 116 floor are not speech and must close no boundary
    + actual - expected
    + [ { event: 'started', frame: … }, { event: 'ended', frame: … }, … ]   （第一条新用例：红）
  AssertionError: a non-speech peak of 860 RMS over a 1—116 floor is not speech, however many frames wide it is
  AssertionError: a single click must not arm the watchdog        （连既有的 AC2 负控也一起红了）
```
完整日志：`…/lv-freeze-local-speech-gate-2026-10-16/tools/falseform-final-run.log`。红完立刻从备份恢复并 `sha256sum -c` 校验字节一致，恢复后 9/9 绿。

### 边界时刻对齐的读法（AC2 的「容差 ≤ 200 ms」）

`ended` 按构造是在有声段结束后再数满 `DEFAULT_EXIT_FRAMES = 25` 帧（500 ms）才**报出**的——500 ms > 200 ms，所以字面读法下「报出时刻与有声段结束对齐 ≤ 200 ms」定义上不可满足。用例按可满足的读法断言：`started` 报出帧落在有声段起点 +200 ms 内（实测 +0~2 帧），`ended` 则断言它**所描述的时刻**（`ended帧 − DEFAULT_EXIT_FRAMES`）落在有声段结束 ±200 ms 内。断言里写明了这条读法，没有偷偷放宽。

### 代价（写在常量注释里，也记在这里）

连接开头 `floorMinFrames`（2.4 s 静音）之前，阈值取「已收静音帧的最大值 × k」这一保守上界；也就是说**开头 2.4 s 内**的话必须足够响才被开出（对安静麦克风：400 RMS 的话对着 10×max(静音) 判，最坏情况紧贴；2.4 s 之后回到中位数，400–640 对 250 的下限照旧）。这是为了不重演 2026-10-16 那次误报付的代价，写进了 `LOCAL_SPEECH_FLOOR_MIN_FRAMES` 的注释，也在 AC 的「安静麦克风」用例里按最紧的角（底噪 26 + 400 RMS）钉住了。

### 命令与结果

- `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-local-speech.test.ts` → 9 tests / 9 pass / 0 fail（其中 5 条是原有断言，未改一字）。
- `npm run typecheck` → exit 0；`npm run lint` → exit 0（243 条 warning 全为既有、不在这两个文件里）。
- `git -C <worktree> merge --no-edit develop` → 无冲突。
- anti-drift Touches 检查：`ANTI-DRIFT OK — 2 actual file(s), all within declared Touches (3 glob(s))`。
