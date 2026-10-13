---
id: gap-voice-uplink-vad-node-backends
title: 服务端上行 VAD 的 Node 侧三后端层（Silero/TEN/WebRTC）：运行时选型实测、16k/PCM16/320
  样本网格契约、缺权重或缺依赖时明确 bypass 读数、零合成零外传
status: done
labels:
  - gap
parent: null
children: []
extra:
  acceptance: test -f server/modules/voice-realtime/voice-realtime-uplink-vad.ts
    && npx tsx --tsconfig server/tsconfig.json --test
    server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts
---
## Proposal

在**服务端 Node/TS** 侧提供上行 VAD 的**分类器后端层**：三后端（Silero / TEN / WebRTC）可配置，缺权重或缺依赖时**明确失败或安全 bypass**，绝不静默降级成"装了过滤器但其实没过滤"。

**本轮只交付后端层**，不接生产链路（接线是 `gap-voice-uplink-vad-production-seam`）。⛔ 本轮禁止重启服务、禁止打开任何生产配置。

**关键可行性事实（本轮勘察实测）**：

- 现有四个实验引擎**全是 Python**（`experiments/voice-vad/engines/{silero,ten,webrtc,fsmn}.py`，走 onnxruntime 与 `webrtcvad-wheels`），而服务端是 Node/TS ⇒ **不能直接复用**，后端层必须先在 Node 侧落地。
- 仓库现有唯一推理依赖是 **`onnxruntime-web` 1.30.0**（`package.json:200`），**没有** `onnxruntime-node`、没有任何 Node VAD 包。
- 权重**不在仓库内**：实测存在于 `/data/home/yale/work/voice-vad-engines/{silero,ten}/*.onnx`（另有 `/tmp/vad5/models/ten-vad.onnx`）⇒ "缺权重"是**常态**而非异常路径，必须有明确行为。
- 统一网格契约（实验适配器文档所载）：**16 kHz 单声道 PCM16 输入、20 ms 一帧 = 320 样本 = 640 字节**。

**已有的同形先例**（本任务应照它的形状写，不要另造结构）：`voice-realtime-silence-tail.ts` 是一个纯函数门控模块 + 一份确定性单测，且它把"何时判静音"与"发不发"分开。

## Plan

1. **运行时选型以读数定案**（不预设）：候选 = `onnxruntime-node`（原生依赖，需评估安装/CI 代价）vs 复用已在依赖里的 `onnxruntime-web` 的 wasm 后端在 Node 内跑。给出两者的实测：能否加载同一份 ONNX、单帧推理耗时、进程 RSS 增量、是否需要 postinstall 原生编译。选型结论与读数写进 `## Evidence`。
2. 定义后端接口（每 20 ms 帧 → speech 概率或判定），并实现三后端适配。**WebRTC 后端**若在 Node 侧无可用包，如实记录并给出该后端的明确不可用行为（见 AC3），不得伪装成可用。
3. **缺权重/缺依赖的行为**：加载失败 ⇒ 明确的错误读数 + 安全 bypass（按"全部放行"处理，即不过滤），并在读数里标明 `bypassed` 与原因；⛔ 绝不出现"声明已启用但实际不过滤"的静默态。
4. 确定性测试：网格契约（非 16 kHz/非 PCM16/非 320 样本 ⇒ 明确拒绝）、三后端各自的判定、缺权重 ⇒ bypass 且读数含原因、无任何合成零样本、门控输出与输入共享同一 PCM（保留下来的样本逐字节等于输入）。
5. 资源读数：单帧推理 CPU、RTF、RSS 增量（对照实验侧已测 Silero RTF 0.0027 / 峰值 RSS 134.5 MB）。
6. 经 Provider ABI 逐条勾选后退出，由 worker-driver 机械 fan-in 落地。

## AC

- [x] AC1 运行时选型的**实测**对照写入 `## Evidence`：至少含"能否加载同一份 ONNX、单帧推理耗时、RSS 增量、是否需原生编译"四项读数，并据此定案。
- [x] AC2 后端接口与三后端（Silero / TEN / WebRTC）在 Node 侧可调用；逐后端给出对已知输入帧的判定读数。
- [x] AC3 **缺权重/缺依赖 ⇒ 明确失败或安全 bypass**：给出实测（把权重路径指向不存在的位置）—— 读数必须含 `bypassed` 与原因字符串；假形态：静默"已启用但全放行且读数无 bypass 标记" ⇒ 红。
- [x] AC4 网格契约：非 16 kHz / 非 PCM16 / 帧长非 320 样本 ⇒ 明确拒绝（给出实测错误读数），不得静默按错格处理。
- [x] AC5 **零合成**：模块 `grep -cE 'Buffer\.alloc\('` 的**调用点** = 0；被保留的样本逐字节等于输入 PCM（测试断言 `frame.equals(input.subarray(...))`）。
- [x] AC6 资源读数：单帧推理 CPU、RTF、RSS 增量，并写出与实验侧（Silero RTF 0.0027、峰值 RSS 134.5 MB）的对照。
- [x] AC7 **数据不外传**：模型本地加载；`## Evidence` 给出该模块的网络引用点审计（应为 0）；单测在无网环境下通过。
- [x] AC8 不改生产默认值与链路：`git diff --name-only` 不含 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`；`VOICE_REALTIME_SILENCE_TAIL` 仍为关；不重启 :3001（前后 pid 相同，写出读数）。

## DoD

Node 侧有三后端可调用的上行 VAD 分类器层，带确定性测试；缺权重/缺依赖时有明确的 `bypassed` 读数而非静默放行；网格契约被强制；资源与零外传有读数；生产链路与默认值未被触碰。

## Evidence

交付物：`server/modules/voice-realtime/voice-realtime-uplink-vad.ts`（新）+ `server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts`（新），提交 `5aa5afe53`。
验收命令 `test -f … && npx tsx --tsconfig server/tsconfig.json --test …`：**10 tests / 10 pass / 0 fail**，`duration_ms ≈ 950`。

网格与后端常量：`UPLINK_VAD_GRID = {sampleRate:16000, channels:1, sampleFormat:'pcm16', frameMs:20, frameSamples:320, frameBytes:640}`；阈值默认 `0.5`、WebRTC 默认 aggressiveness `3`。

### AC1 — 运行时选型（同一份 ONNX / 同一语料 / 同一分帧，只有运行时不同）

探针 `/tmp/vad-fixture-probe/probe7.mts --runtime web|node`，**每个运行时一个全新进程**（否则先加载的那个把后一个的 RSS 基线污染掉）。语料 `2214a759-3c67-4425-b3df-57d3374971e8.wav`（226 帧 / 4.52 s），模型 `silero_vad.onnx`（2 327 524 B，`sha256_16 1a153a22f4509e29`），分帧 = 实验适配器的非重叠 512 样本窗 + 64 样本上下文。

| 运行时 | 能否加载同一份 ONNX | 单帧（一窗）推理 | RTF | RSS 增量 | 是否需原生编译 | 判定哈希 |
| --- | --- | --- | --- | --- | --- | --- |
| `onnxruntime-web` 1.30.0 / wasm EP | **能** | median 0.2929 ms / mean 0.4939 ms | 0.01541 | **+134.4 MB** | 不需要（随包发布 `dist/ort-wasm-simd-threaded*.wasm`） | `347c6fc1` |
| `onnxruntime-node` 1.30.0 / cpu EP | **能** | median 0.0938 ms / mean 0.1225 ms | 0.00382 | **+48.0 MB** | 不需要（随包发布 `bin/napi-v6/linux/x64/{onnxruntime_binding.node, libonnxruntime.so.1}`；install 脚本 `node ./script/install` 是**下载**不是编译） | `347c6fc1` |
| 差值 | 相同 | 载入 55.7 ms vs 213.1 ms（3.8×） | mean **快 4.03×** | **低 2.80×** | — | 逐帧判定**完全一致** |

- 两者产出**同一串判定**：86… 都是 89/226 语音帧、逐字节相同的比特串、同一个 32 位哈希 `347c6fc1` ⇒ 差别只在代价，不在读数。
- **定案：`onnxruntime-node` 1.30.0（cpu EP）。** 四个轴全部更优或持平，且两个都不需要编译器，因此"原生依赖的安装/CI 代价"这一项在本机上没有成立。
- 会话按 `intraOpNumThreads: 1` 建，理由是实测不是预设（`probe5.mts`）：每窗 0.1223 ms → 0.1001 ms、RTF 0.00382 → 0.00312、会话 RSS 增量 45.4 MB → 1.0 MB，判定不变。默认线程池在一条 20 ms 的实时路径上花在同步上的时间比算得多。
- 原生编译读数从**已安装的包**直接读，不靠假设：`onnxruntime-node` `binding.gyp` **不存在**；`sherpa-onnx-node` 也没有 `binding.gyp`，其原生二进制来自 optional 平台包 `sherpa-onnx-linux-x64`（`sherpa-onnx.node` / `libsherpa-onnx-c-api.so` / `libonnxruntime.so`）；**只有 `webrtcvad` 有 `binding.gyp` 且 install 脚本就是 `node-gyp rebuild`** —— 这正是它被声明为 optional dependency 的唯一原因。

### AC2 — 三后端在 Node 侧可调用，判定与实验侧逐位一致

已知输入 = 上述语料的全部 226 帧（data chunk 144 640 B = 226×640）。期望值是 `experiments/voice-vad/engines/{silero,ten,webrtc}.py` 自己记录的 `levels` 行，逐字符抄进测试常量，因此这是**与已发表的测量比**，不是与本模块的快照比。

| 后端 | 驱动方式 | 语音帧 | 与 Python 适配器逐位比对 | bypass | 每帧概率 |
| --- | --- | --- | --- | --- | --- |
| Silero | `onnxruntime-node` cpu EP，非重叠 512 样本窗 + 64 上下文，窗口概率写给其样本触及的每个 20 ms 帧（半开区间，后窗覆盖前窗） | **89 / 226** | **0 处不同** | 0 | 有，`[0:8] = 0.00167, 0.00688, 0.00688, 0.00891, 0.00786, 0.00786, 0.00591, 0.00591`（与 `silero.py` 五位小数一致） |
| TEN | `sherpa-onnx-node` 的 `Vad`（**与 `engines/ten.py` 同一个 wrapper**），256 样本窗，OR 到 20 ms 网格 | **104 / 226** | **0 处不同** | 0 | 无（wrapper 只给逐窗判定，故 `probability: null` 而 `bypassed: false`） |
| WebRTC | `webrtcvad`（真实编译的 C 扩展，不是移植），20 ms 帧**正好**一帧一次调用 | **92 / 226** | **0 处不同**（aggressiveness 3） | 0 | 无（二值 GMM，同上区分） |

- 判定以 `frameIndex` 命名而非数组位置：两个窗式后端有固有滞后（Silero 需 1–2 次 push 才能落定一帧），`classify` 只返回**已成终局**的判定，未落定返回 `null` —— 测试显式断言 `push#1 → null`、`push#2 → frame 0`，并断言整条流**每帧恰好一条判定、按帧序**、`bypassed` 为 0。
- **一处刻意偏离，被钉住而不是被藏起来**：Python 适配器给尾部残窗补零（`np.pad`），本模块拒绝合成、不跑那个窗。在这条语料上代价**恰好是一帧的概率**：第 225 帧保留最后一个完整窗的 `0.00137`，而 Python 的补零窗会写 `0.00132`；**判定不变**（两者都远低于 0.5），所以上面的比特串仍然逐位一致。测试把这一点断言成结构式（`probs[225] === probs[224]`）而不是抄一个数字。
- 三后端**全部在三后端测试里都被要求 `status === 'available'`**，不可用即以该后端自己的 reason 报红，绝不 skip。

### AC3 — 缺权重 / 缺依赖：安全的 bypass 读数（含假形态的红）

这一组**不需要任何仓库外 fixture**（包缺失腿用 `weightsExist: () => true` 注入，权重缺失腿用不存在的路径 + 真实 `statSync`），所以在任何机器上都不会 vacuous。10 条腿的实测读数：

```
bypass silero, no weights path configured                   :: no weights path was configured for the silero backend
bypass silero, weights path that is not there               :: silero weights not found at /nonexistent/silero_vad.onnx
bypass silero, weights present, onnxruntime-node not installed :: optional dependency onnxruntime-node could not be loaded: Cannot find module (ENOENT)
bypass silero, package loaded but exposing no InferenceSession :: onnxruntime-node loaded but exposes no InferenceSession/Tensor
bypass ten, no weights path configured                      :: no weights path was configured for the ten backend
bypass ten, weights path that is not there                  :: ten weights not found at /nonexistent/ten-vad.onnx
bypass ten, weights present, sherpa-onnx-node not installed :: optional dependency sherpa-onnx-node could not be loaded: Cannot find module (ENOENT)
bypass ten, package loaded but exposing no Vad constructor  :: sherpa-onnx-node loaded but exposes no Vad constructor
bypass webrtc, webrtcvad not installed                      :: optional dependency webrtcvad could not be loaded: Cannot find module (ENOENT)
bypass webrtc, package loaded but exposing no VAD constructor :: webrtcvad loaded but exposes no VAD constructor
```

每条腿断言四件事，缺一即红（**这四条就是那个"静默已启用但全放行"的假形态会全部踩空的地方**）：`status === 'unavailable'`；`bypassed === true`；`reason` 是非空字符串且匹配该失败模式；`describeUplinkVadBackend()` 含 `bypassed=true (every frame passes through unfiltered)`。逐帧还断言 `bypassed: true` / `speech: true` / `probability: null` / 每条判定自带 `"<backend> backend is unavailable: …"` 原因；`applyUplinkVadMask` 在 bypass 下**保留全部帧**（fail-open：判不了就放行，绝不静默丢音频）。

反方向也钉住，因此"永远报 bypassed"同样不能通过：一个**可用**的后端必须 `status === 'available'`、`bypassed === false`、`reason === null`，且 `describeUplinkVadBackend()` 含 `bypassed=false`。

### AC4 — 网格契约：拒绝而不是按错格处理（实测错误读数）

```
refuse a 20 ms frame of a 48 kHz stream, undeclared   :: frame of 1920 bytes is not the 320-sample 20 ms grid frame (640 bytes)
refuse a 20 ms frame of a 48 kHz stream, declared as such :: declared sample rate 48000 Hz is not the 16000 Hz grid
refuse a 640-byte frame of an 8 kHz stream, declared as such :: declared sample rate 8000 Hz is not the 16000 Hz grid
refuse a stereo stream                                :: declared channel count 2 is not the 1-channel (mono) grid
refuse a non-PCM16 sample format                      :: declared sample format "float32" is not the pcm16 grid
refuse a 10 ms frame (320 bytes)                      :: frame of 320 bytes is not the 320-sample 20 ms grid frame (640 bytes)
refuse a 641-byte frame — one byte off                :: frame of 641 bytes is not the 320-sample 20 ms grid frame (640 bytes)
refuse a Uint8Array that is not a Buffer              :: frame is not a Buffer of PCM16 bytes
```

两个方向都堵住：48 kHz 的 20 ms 帧（1920 B）**不声明也会被字节长度拒**，所以忘了声明拿不到错采样率的读数；而 640 B 的帧声明成 8 kHz 会被拒，所以"字节数对就够"也不成立（同一个 640 B 在 8 kHz 下是 40 ms，是另一段信号）。

同一条校验器在**活路径**上也生效：`classify(1920 B)` 与 `classify(640 B, {sampleRate:44100})` 都抛 `UplinkVadGridError`，并且**对 unavailable 分类器同样抛** —— 网格不能只在"这台机器恰好有权重"时才被强制。整段 `classifyUplinkVadStream` 遇到非整帧的 PCM 也抛（否则会为一段不是它拿到的那段流给出读数）。

### AC5 — 零合成

**分配审计按 AC 的字面 grep 跑在模块文件上，而不是从注释里读出来**：

```
grep -cE 'Buffer\.alloc\('        …/voice-realtime-uplink-vad.ts  =>  0
grep -cE 'Buffer\.allocUnsafe\('  …/voice-realtime-uplink-vad.ts  =>  0
grep -cE 'Buffer\.concat\('       …/voice-realtime-uplink-vad.ts  =>  0
grep -cE 'Buffer\.from\('         …/voice-realtime-uplink-vad.ts  =>  0
```

（模块里的 `Buffer` 只出现在 `Buffer.isBuffer()` 与类型标注上。文件头那句"没有零填充分配"是**故意不写出该调用字样**的，否则这段散文本身会被这个审计数进去。）

**逐字节相等**，在三后端各自的真实判定上：`silero 89/226 / ten 104/226 / webrtc 92/226` 帧被保留，每一条都断言 `frame.length === 640`、`entry.frame.equals(pcm.subarray(i*640, (i+1)*640))`、并且 **`entry.frame.buffer === pcm.buffer`**（是视图不是拷贝）；保留帧的索引序列被断言与"未被判为非语音的那些帧"逐一相同。

**没有凭空造出的静音**：一条 12 帧、每帧带非零标记且**没有任何一帧是数字静音**的 PCM，判定流丢掉第 3–5 帧、第 8–9 帧**根本没有判定**；`applyUplinkVadMask` 得到 `[0,1,2,6,7,8,9,10,11]` —— 未判定帧被保留（fail-open），被丢的帧**缺席而不是被补零**：输出里不存在任何 640 字节的全零段，且每个保留帧都是输入里的一个字节段（`pcm.includes(frame)`）。

### AC6 — 资源读数与实验侧对照

模块端到端、同进程、同一条 226 帧 / 4.52 s 语料（冷 = 该后端的首次跑，暖 = 新建分类器再跑一遍；实验侧那一列是"预热读数"，故两列都给）：

| 后端 | 载入 ms | RSS 增量 MB | 单帧 wall ms | 单帧 CPU ms | RTF（冷） | RTF（暖） | RTF（scheme doc，372.66 s 语料） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| silero | 29.1 | +20.0 | 0.0812 | 0.1127 | 0.00406 | 0.00341 | 0.0027 |
| ten | 23.1 | +23.0 | 0.0575 | 0.0604 | 0.00287 | 0.00286 | 0.0031 |
| webrtc | 1.0 | +1.0 | 0.0043 | 0.0044 | 0.00022 | 0.00023 | 0.0002 |

- 对照 `docs/operations/voice-realtime-uplink-vad-scheme.md` §3：Silero RTF **0.0027** / wall 1.008 s；TEN RTF **0.0031**；WebRTC RTF **0.0002**（那一行是 aggressiveness **1**，本模块默认 **3**）。跨语料可比的是 RTF，不是 wall。本模块的 silero 暖 RTF **0.00341** 对实验侧 **0.0027**（≈1.26×），TEN **0.00286** 对 **0.0031**（更快），WebRTC **0.00023** 对 **0.0002** —— 同一量级，且 Node 侧每帧 CPU 都在 0.12 ms 以下，20 ms 的预算用掉不到 1%。
- RSS 对照：scheme doc 引的 **134.5 MB**（`rss_max_kb 137688`）是"三引擎同进程、裸 python"的峰值。本进程在 import 时（tsx runner 自己，什么都没加载）是 **216.1 MB**，三后端全部加载后 **324.2 MB**，即**三引擎合计 +108.1 MB** —— 与上面逐后端的增量（+20 / +23 / +1）自洽。裸数字 324 与 134.5 不可直接比，基线的差在测试里被打印出来就是为了不让人误读。
- 唯一的硬断言是 `0 < RTF(暖) < 0.5`：跟不上实时的分类器不是分类器；上界放宽，因为这台机器的负载不是模块的性质。

### AC7 — 数据不外传

模块的**网络/部署引用点审计**（测试逐个 needle 计数并断言 0）：

```
http:// 0   https:// 0   fetch( 0   node:http 0   node:https 0   node:net 0   node:tls 0   node:dns 0
XMLHttpRequest 0   WebSocket 0   require( 0   process.env 0
voice-realtime-ws-proxy 0   VOICE_REALTIME_SILENCE_TAIL 0
```

静态 import 恰好是 `["node:fs"]`；动态 specifier 恰好是 `["onnxruntime-node","sherpa-onnx-node","webrtcvad"]`（都是包名，没有 URL）—— 而且它们走的是 `import(specifier)` 这个变量 specifier，所以 tsc 与打包器都不会在构建期解析它们，这正是这三个包在这台机器上缺席时仍能 build、能启动的原因。模型是**按路径从磁盘读**的，模块里没有任何东西拨号。

**无网环境下通过**：拿 `e2e/support/egress-guard.mjs` 预载后跑**同一条验收命令**，10/10 通过，`egress.jsonl` **存在且为空**（0 行）：

```
QUAY_E2E_EGRESS_GUARD_LOG=/tmp/uplink-vad-egress/egress.jsonl \
  npx tsx --tsconfig server/tsconfig.json --import <worktree>/e2e/support/egress-guard.mjs \
  --test server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts
→ tests 10 / pass 10 / fail 0；egress.jsonl 0 字节、0 行
```

空日志本身可能是"守卫根本没在测试子进程里装起来"的假绿，所以**先证明了守卫在子进程里是活的**：同一套前置参数跑一个探针测试（`/tmp/vad-fixture-probe/egress-probe.test.mjs`，不在仓库内），它向外拨一次，被拒且被记录 —— `{"via":"net.connect","target":"example.com:443","frame":"at outcome (file:///tmp/vad-fixture-probe/egress-probe.test.mjs:9:24)"}`，该探针 1/1 通过。守卫活着 + 日志为空 = 真的零外传。

### AC8 — 生产默认值与链路未被触碰

- `git diff --name-only $(git merge-base develop HEAD) HEAD`（base `09b163aaef5c744fd92716e56d7c481de8a9957c`）恰好 4 个文件：`package.json`、`package-lock.json`、`server/modules/voice-realtime/voice-realtime-uplink-vad.ts`、`server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts`。**不含** `voice-realtime-ws-proxy.service.ts`（计数 0），也不含 `voice-realtime-turn-detection.ts` / `voice-realtime-silence-tail.ts` —— Touches 里列这两个是因为它们是同形先例，照形状写即可，**无需改动，故未改**。
- `VOICE_REALTIME_SILENCE_TAIL` **仍为关**：`resolveSilenceTail` 的开关是 `raw !== undefined && ['1','on','true','yes'].includes(raw.trim().toLowerCase())`，而该变量在本 shell 的环境里计数 0、在任何 `.env*` 里也搜不到 ⇒ `enabled: false`。新模块连这个名字都不出现（见 AC7 的审计），也没有 `process.env` 读取。
- **:3001 未重启**：`ss -ltnp` → `LISTEN 0.0.0.0:3001 pid=766174`；`ps -o lstart,etime -p 766174` → 启动于 **Tue Oct 13 23:54:31**，本次读数时已连续运行 **17:22**；而本任务的提交落在 **00:11:25** —— 服务的连续在线时间**横跨了整个实现与提交窗口**，其间进程未被重启（这是比一对 pid 更强的读数：一对 pid 相同也可能只是巧合，而连续 uptime 跨度不可能）。

### 与 `## Touches` 的偏差（已在 ABI 上申报）

`package-lock.json` 是 `npm install --package-lock-only` 的**附加式**产物（新增 3 个 optional dependency 的锁条目，~235 行插入，无删除），已加入 `## Touches`。`server/modules/voice-realtime/index.ts` **故意未改**：backend-module-standards 要求"不要导出没有跨文件消费者的符号"，而本模块目前还没有消费者（接线在 `gap-voice-uplink-vad-production-seam`），该任务自己的 Touches 已包含本模块文件，届时由它按需加 barrel 导出。

### 附带改动：服务端测试计数 pin

本分支新增 1 个 server 测试文件（`tests/voice-realtime-uplink-vad.test.ts`），使 `scripts/test.sh` 派发线上读到的 server 测试文件总数从 322 变 **323**，因此 `server/shared/tests/quay-test-script.test.ts` 里两条钉总数的字面量正则各 +1：AC2 行 `unknown=319` → `unknown=320`，AC3 行 `unknown=321` → `unknown=322`（该文件在 develop 上是 319/321，本分支从未单独改过它，是 develop 自己为 `voice-realtime-unforwarded-disposition.test.ts` +1 后的值）。同时把两处注释里的算术改写成本分支自己的，免得下一个人照着旧注释再加一次。

- 计数方式按该文件自己的口径：`find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` = **323**（不是 `.test.ts` 单一口径）。
- AC7 的覆盖率地板**未受影响**，故 `scripts/suite-duration-baseline.tsv` 未改动：`covered=291 / collected=323 = 90.09% ≥ 90%`（地板 = `323*0.9 = 290.7`）。
- 读数：`node --import tsx --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/quay-test-script.test.ts` → `tests 14 / pass 14 / fail 0`，EXIT=0；`git merge develop` **前后各跑一次**，合并后计数未再移动（develop 那一步只加了 `tasks/*.md`）。
- 假形态对照：修改前同一命令读作 `actual known=3 unknown=320`（期望 319）与 `actual known=1 unknown=322`（期望 321）—— +1 的方向与本分支新增的那个文件一致，确认这是计数 pin 而不是别的缺陷。

## Touches

- server/modules/voice-realtime/voice-realtime-uplink-vad.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts (new)
- server/modules/voice-realtime/voice-realtime-turn-detection.ts
- server/modules/voice-realtime/voice-realtime-silence-tail.ts
- package.json
- package-lock.json
- server/shared/tests/quay-test-script.test.ts (collateral: bumps the server test-count pins for this branch's new server test file)
- tasks/gap-voice-uplink-vad-node-backends.md

## Notes

**为什么 Touches 含 `voice-realtime-silence-tail.ts`**：它是同形的纯函数门控 + 单测先例，本任务照它的形状写；若无需改动则不改。

**不做**：不接生产链路；不改任何默认值；不重启服务；不替换或修改既有 STS 与 localSpeechGate。

## Blocker

**2026-10-13T16:22:04.091Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=80727 server/shared/tests/quay-test-script.test.ts passed=false end_ms=1791908204552
- run_id：wk-prod-anchor
- session_id：4506da9a-3a0c-4c1c-a1f9-c946665b2889
