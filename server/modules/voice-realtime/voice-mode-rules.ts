/**
 * The Live Voice dispatch rules: the text the resident launch's `UserPromptSubmit` hook injects into
 * a session that is in Live Voice at that moment.
 *
 * WHERE THIS LIVES NOW. It used to live in `hooks/voice-mode-context.mjs`, a command hook the launch
 * registered through the CLI's settings layer — which meant a node process spawned on every prompt and
 * a gate that could only be a file on disk. The rules text is unchanged, byte for byte (the criterion
 * pins it against the pre-migration file's sha256); only the CARRIER moved here, into TypeScript the
 * in-process callback can import.
 *
 * Consumed by `claude-host-driver.provider.ts`, whose `UserPromptSubmit` callback returns
 * `rulesFor(process.env.VOICE_MODE_RULES_VARIANT)` as the injection, and by
 * `providers/tests/claude-resident-dispatch-hook.test.ts`, which pins the injected text against
 * {@link VOICE_MODE_RULES}.
 *
 * `VOICE_MODE_RULES_VARIANT` and `VOICE_MODE_HOOK_FORCE` are read by the CALLER, not here: this
 * module is a pure function of its argument so the experimental arms stay a property of the launch.
 */
export const VOICE_MODE_RULES = [
  '[Live Voice 模式] 用户正在用语音和你对话，随时会接着说下一句。前台被你占住的每一秒，他新说的话都要排队等你。所以：',
  '1. 预计本轮要超过约 20 秒才能给出结果的工作——调查、读多份文件或日志、跑测试/构建/实验、写长分析或长文档——第一步就派给后台 Agent（run_in_background: true），不要先在前台查一圈再派。派完用一两句话告诉用户派了什么，然后结束本轮。',
  '2. 单条命令预计超过约 10 秒，用 Bash 的 run_in_background: true。',
  '3. 约 20 秒内能答完的问题、小改动，直接在前台做；为它派后台反而更慢。',
  '4. 前台需要多步时，每步保持短：用户的新话会在下一个工具边界插进来，步子越短他等得越少。',
  '5. 用户的新话进来时，后台任务可能已经完成、还在跑、或已被停止——先用任务工具查实际状态，不要凭记忆判断；再决定保留、停止还是改道。',
  '6. 后台任务完成后，用一两句话简报结果；详细内容留给用户追问。',
].join('\n');

/**
 * 实验臂 `fast`（`VOICE_MODE_RULES_VARIANT=fast`）多出的一行：E2 首轮（opus）里，派后台本身之前前台已经思考了
 * 21–37 s（0 次读文件），这行要求把规划交给 Agent。只在实验里开，不是出货规则。
 */
const FAST_DISPATCH_LINE =
  '1a. 决定派后台时，不要先在脑子里规划怎么查：把用户原话和你已知的上下文直接写进 Agent 的 prompt，让 Agent 自己规划。派发这一步应在几秒内完成。';
/**
 * 实验臂 E（`VOICE_MODE_RULES_VARIANT=fragments`）多出的一条：X3' 里，前台空闲时语音碎片逐条成 turn，
 * Claude 按半句话行动，并把半个问句读成陈述（faeb9c61 C/D）。这条让它对没说完的话只简短应一声、等后续。
 */
const FRAGMENT_LINE =
  '7. 语音会分段到达：一句话常被拆成几条消息，中间隔几秒。一条消息看起来没说完——比如半个问句、只有半个条件（「如果……」）、以「是」「还是」「然后」这类词收尾、或明显在列举中——就只简短应一声（例如「嗯，你接着说」）或不回应，不要据此行动、下结论或修正你之前的理解；等后续消息到了，把几段合起来一起理解再处理。';
export const rulesFor = (variant: string | undefined): string =>
  variant === 'fast'
    ? VOICE_MODE_RULES.replace('\n2. ', `\n${FAST_DISPATCH_LINE}\n2. `)
    : variant === 'fragments'
      ? `${VOICE_MODE_RULES}\n${FRAGMENT_LINE}`
      : VOICE_MODE_RULES;
