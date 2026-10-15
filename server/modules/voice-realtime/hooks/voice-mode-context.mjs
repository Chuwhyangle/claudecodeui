#!/usr/bin/env node
/**
 * UserPromptSubmit hook — Live Voice 模式下给 Claude Code 注入「前台只做调度」规则（第 1 层，人裁定的通道）。
 *
 * 门控：只有当这条会话**此刻有 Live Voice 连接**时才注入。实验里用 `VOICE_MODE_HOOK_FORCE=1` 强制；
 * 生产接线需要中继在连接建立/拆除时写/删 `~/.cloudcli/voice-active/<claude session id>`（本实验未接线）。
 * 无连接 ⇒ 什么都不输出，退出 0，会话行为与没有这个 hook 时逐字节相同。
 *
 * 阈值来源：`analyze-turns.mjs` 对 25 个语音会话、172 个语音触发的前台 turn 的读数（见 README）。
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const rulesFor = (variant) =>
  variant === 'fast'
    ? VOICE_MODE_RULES.replace('\n2. ', `\n${FAST_DISPATCH_LINE}\n2. `)
    : variant === 'fragments'
      ? `${VOICE_MODE_RULES}\n${FRAGMENT_LINE}`
      : VOICE_MODE_RULES;

const readStdin = () => { try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; } };

const input = readStdin();
const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
const active =
  process.env.VOICE_MODE_HOOK_FORCE === '1' ||
  (sessionId !== '' && existsSync(path.join(os.homedir(), '.cloudcli', 'voice-active', sessionId)));
if (active) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: rulesFor(process.env.VOICE_MODE_RULES_VARIANT) } }));
}
process.exit(0);
