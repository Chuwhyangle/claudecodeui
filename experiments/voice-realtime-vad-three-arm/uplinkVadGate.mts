/**
 * 上行 VAD 门控 —— `experiments/voice-realtime-vad-three-arm/probe.mts` 的 `--vad-filtered` 模式用的
 * **纯函数式**门控。实现的是定稿方案 `docs/operations/voice-realtime-uplink-vad-scheme.md` 的第 5 节
 * （非语音段保留开头 `a` 的**真实**音频）与第 6 节在 PCM 侧的取帧决策。
 *
 * ## 三条规则（取代先前「合成零样本补发」的旧形态）
 *
 * 1. **非语音段保留开头 `a` 的真实音频**：每个非语音段（一段连续的 `mask === 0` 帧）的开头
 *    `a = silence_duration_ms / 20 + 1` 帧**原样转发原流样本**，其余丢弃。`a` 由**解析后的**
 *    `turn_detection.silence_duration_ms` 导出（见 `uplinkHeadKeepFrames`），⛔ 不得写死。
 * 2. **段首段整段丢弃**：流开头、任何语音帧之前的非语音段不保留任何帧 —— 上游此时手里**没有**待闭合
 *    的东西，保留纯属浪费字节。这是相对「累积-补发」变体的**刻意偏离**（那个变体在段首段也补一次）。
 * 3. **短于 `a` 的段整段保留**：非语音段长度 `< a` 时，其全部帧都在「开头 `a`」里，逐字节原样发出。
 *
 * ## 为什么是纯函数
 *
 * 整个模块只做从 `(逐帧掩码, aFrames, 是否已见过语音)` 到**每帧动作**的映射，碰都不碰 IO、不碰
 * `Buffer.alloc`（⛔ 本模块**不含任何** `Buffer.alloc` —— 它从不合成样本，只从传入的 PCM 里**取**
 * 真实帧）。这样门控逻辑可离线单测，而不是埋在 290 KB 的探针里。
 *
 * 状态只有两个字段（见 `UplinkVadGateState`）：`seenSpeech`（是否已见过语音帧，决定段首段规则）与
 * `nonSpeechRunIndex`（当前非语音段里已走过多少帧，决定是否还在「开头 a」窗内）。二者都是**纯因果、
 * 逐帧**的，没有「欠一次补发」的计数器。
 *
 * ⛔ 本模块与上游的 VAD 边界事件（`speech_started` / `speech_stopped` / `committed`）**完全无关**：
 * 它的唯一输入是掩码位，从不由任何上游事件驱动。退出路径（第 6 节）由用户动作触发，在探针侧实现，
 * 不在本模块。
 */

/** 帧网格：20 ms。所有时间量一律取整数帧（`ms / 20`），不出现亚帧计时。 */
export const UPLINK_VAD_FRAME_MS = 20;

/**
 * `a = silence_duration_ms + 1 帧` 里的那个 **+1**。
 *
 * 出货的 `silence_duration_ms` 正落在上游 `server_vad` 闭合判据的 `>=` 边界上，所以 +1 帧是**边界
 * 保险** —— 余量是风险选择，不是实测必需（方案 §10 实测「最小可靠 a ≤ 400 ms」）。
 */
export const UPLINK_VAD_HEAD_BOUNDARY_FRAMES = 1;

/** 门控对**单帧**给出的动作。`send-real` / `send-head-kept` 都发**同一份真实样本**，只在可观测性上区分。 */
export type UplinkVadAction =
  /** 语音帧（掩码 1），原样转发。 */
  | 'send-real'
  /** 非语音段的开头 `a` 窗内帧，**原样转发真实样本**（不是合成静音）。 */
  | 'send-head-kept'
  /** 丢弃（段首段，或超出开头 a 窗的非语音帧）。 */
  | 'drop';

/** 逐帧因果状态。只有两个字段，都是纯因果的。 */
export interface UplinkVadGateState {
  /** 是否已经见过语音帧（掩码 1）。决定段首段规则：见到之前一切非语音都丢。 */
  readonly seenSpeech: boolean;
  /** 当前非语音段里已走过的帧数（0 = 下一帧是该段的第 0 帧）。 */
  readonly nonSpeechRunIndex: number;
}

/** 初始状态：还没见过任何语音，也不在任何非语音段里。 */
export function initialUplinkVadGateState(): UplinkVadGateState {
  return { seenSpeech: false, nonSpeechRunIndex: 0 };
}

/**
 * 由**解析后的** `silence_duration_ms` 导出保留窗 `a`，单位**帧**。
 *
 * `a = round(silence_duration_ms / frameMs) + 1 帧`。出货值 400 ⇒ **21 帧 = 420 ms**。
 * ⛔ **必须从解析后的值导出，不得写死**：配置改成 800 时必须跟随（AC3 的假形态正钉这一点）。
 */
export function uplinkHeadKeepFrames(silenceDurationMs: number, frameMs: number = UPLINK_VAD_FRAME_MS): number {
  return Math.round(silenceDurationMs / frameMs) + UPLINK_VAD_HEAD_BOUNDARY_FRAMES;
}

/** 同 `uplinkHeadKeepFrames`，但返回**毫秒**（= 帧数 × frameMs）。出货 400 ⇒ 420 ms。 */
export function uplinkHeadKeepMs(silenceDurationMs: number, frameMs: number = UPLINK_VAD_FRAME_MS): number {
  return uplinkHeadKeepFrames(silenceDurationMs, frameMs) * frameMs;
}

/** 掩码位归一化：接受 `'1'` / `1` / `true` 为语音。 */
function isSpeechBit(maskBit: string | number | boolean): boolean {
  return maskBit === '1' || maskBit === 1 || maskBit === true;
}

/**
 * **单帧**归约：给定当前状态、这一帧的掩码位、以及 `aFrames`（保留窗，单位帧），返回
 * `{ state, action }`。纯函数 —— 同样的输入永远给同样的输出，不碰任何 IO。
 *
 * 规则（与模块头三条一一对应）：
 * - 语音帧（掩码 1）⇒ `send-real`，并清空非语音段计数、置 `seenSpeech`。
 * - 非语音帧且**尚未见过语音** ⇒ `drop`（段首段整段丢弃），状态不变。
 * - 非语音帧且已见过语音：段内索引 `< aFrames` ⇒ `send-head-kept`；否则 `drop`。两种都推进段内索引。
 */
export function reduceUplinkVadFrame(
  state: UplinkVadGateState,
  maskBit: string | number | boolean,
  aFrames: number,
): { state: UplinkVadGateState; action: UplinkVadAction } {
  if (isSpeechBit(maskBit)) {
    return { state: { seenSpeech: true, nonSpeechRunIndex: 0 }, action: 'send-real' };
  }
  if (!state.seenSpeech) {
    // 段首段：任何语音帧之前的非语音整段丢弃 —— 上游没有待闭合的东西。
    return { state, action: 'drop' };
  }
  const action: UplinkVadAction = state.nonSpeechRunIndex < aFrames ? 'send-head-kept' : 'drop';
  return {
    state: { seenSpeech: true, nonSpeechRunIndex: state.nonSpeechRunIndex + 1 },
    action,
  };
}

/**
 * 对**整条掩码**跑一遍门控，产出逐帧动作序列。掩码是 `'0'`/`'1'` 组成的字符串（探针的掩码正是这个
 * 形状）。`seenSpeechBefore` 允许从「已经见过语音」续跑（分段处理时用；默认从头开始）。
 */
export function planUplinkVadGate(
  mask: string,
  aFrames: number,
  seenSpeechBefore: boolean = false,
): UplinkVadAction[] {
  let state: UplinkVadGateState = { seenSpeech: seenSpeechBefore, nonSpeechRunIndex: 0 };
  const actions: UplinkVadAction[] = [];
  for (const ch of mask) {
    const stepped = reduceUplinkVadFrame(state, ch, aFrames);
    state = stepped.state;
    actions.push(stepped.action);
  }
  return actions;
}

/** 动作序列的计数摘要（可观测性：报告里「被保留的段首帧」等读数）。 */
export function summarizeUplinkVadActions(actions: readonly UplinkVadAction[]): {
  sentReal: number;
  headKept: number;
  dropped: number;
  sentFrames: number;
} {
  let sentReal = 0;
  let headKept = 0;
  let dropped = 0;
  for (const action of actions) {
    if (action === 'send-real') sentReal += 1;
    else if (action === 'send-head-kept') headKept += 1;
    else dropped += 1;
  }
  return { sentReal, headKept, dropped, sentFrames: sentReal + headKept };
}

/** 一个「将被发出去的帧」：它在原流里的**索引**、门控给的动作、以及**原流的该帧**（`subarray` 视图）。 */
export interface UplinkVadPlannedFrame {
  readonly index: number;
  readonly action: 'send-real' | 'send-head-kept';
  /** 原流里该帧的真实样本（视图，不复制、不合成）。 */
  readonly frame: Buffer;
}

/**
 * 把门控决策**落到 PCM 上**：返回将被发出去的每一帧 —— 其原流索引、动作、以及 `pcm` 里对应位置的
 * **真实样本视图**。
 *
 * 这是「被保留的样本逐字节等于原流对应位置」这条判据的实现面：返回值里的 `frame` **就是**输入 PCM
 * 的子视图（`pcm.subarray`），从不 `Buffer.alloc`、从不合成。探针对 `frame.toString('base64')` 后
 * `append` 上行。
 *
 * `mask.length * frameBytes` 必须 ≤ `pcm.length`（掩码覆盖的每一个被发帧都要在 PCM 里取得到）。
 */
export function materializeUplinkVadFrames(options: {
  pcm: Buffer;
  mask: string;
  aFrames: number;
  frameBytes: number;
  seenSpeechBefore?: boolean;
}): UplinkVadPlannedFrame[] {
  const { pcm, mask, aFrames, frameBytes } = options;
  const actions = planUplinkVadGate(mask, aFrames, options.seenSpeechBefore ?? false);
  const planned: UplinkVadPlannedFrame[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    if (action === 'drop') continue;
    const start = index * frameBytes;
    planned.push({ index, action, frame: pcm.subarray(start, start + frameBytes) });
  }
  return planned;
}

// ── 退出路径（方案 §6）的**顺序**判据 ─────────────────────────────────────────────────────────
//
// 退出路径本身在探针里实现（要连上游、要等待）。这里只放一个纯的**顺序校验器**，让「commit 必须在
// response.create 之前、二者都必须在关闭之前」这条不变式可离线单测，且能被探针在读实时用。

/** 退出路径必须按这个顺序出现（方案 §6.3）。`bounded-wait` 是本地等待、不是发出帧，但计入顺序。 */
export const UPLINK_EXIT_STEPS = [
  'input_audio_buffer.commit',
  'response.create',
  'bounded-wait',
  'socket-close',
] as const;

export type UplinkExitStep = (typeof UPLINK_EXIT_STEPS)[number];

/**
 * 校验一段**观测到的**退出步骤序列是否良构：这段序列里，各步骤必须按 `UPLINK_EXIT_STEPS` 的相对顺序
 * 出现（允许缺步 —— 例如假形态里没有 commit/response.create；但**不许乱序**，尤其不许
 * `socket-close` 出现在 `response.create` 之前）。
 *
 * 假形态（收尾改回直接 `ws.close()`）的观测序列是 `['socket-close']`，不含 `response.create` ——
 * 调用方（探针）据此判红：它要求 `commit` 与 `response.create` **都在** `socket-close` 之前。
 */
export function uplinkExitIsWellFormed(observed: readonly string[]): boolean {
  let cursor = -1;
  for (const step of observed) {
    const at = UPLINK_EXIT_STEPS.indexOf(step as UplinkExitStep);
    if (at === -1) return false; // 未知步骤
    if (at < cursor) return false; // 乱序
    cursor = at;
  }
  return true;
}

/** 退出路径**完整**（commit 与 response.create 都在关闭之前）—— 这就是 AC4 的正常形态。 */
export function uplinkExitHasCommitAndResponse(observed: readonly string[]): boolean {
  if (!uplinkExitIsWellFormed(observed)) return false;
  const commit = observed.indexOf('input_audio_buffer.commit');
  const response = observed.indexOf('response.create');
  const close = observed.indexOf('socket-close');
  return commit !== -1 && response !== -1 && close !== -1 && commit < close && response < close && commit < response;
}
