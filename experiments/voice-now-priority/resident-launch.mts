/**
 * 「与 CloudCLI 常驻会话一致」的 SDK 启动参数——实验共用的唯一定义。
 *
 * 构造：直接调生产的 `buildResidentSdkOptions`（→ `mapCliOptionsToSDK`），带上生产同样传的
 * `CLAUDE_REMOTE_CONTROL_FLAGS`。所以 systemPrompt（claude_code preset）、settingSources（project/user/local，
 * 含三个插件与项目 MCP）、tools preset、bypassPermissions、includePartialMessages、BG wait ceiling、
 * systemd scope 的 spawn 钩子，都与生产逐项一致——不是抄一份，是同一个函数。
 *
 * 偏离（每一项都是实验所需，逐条写明）：
 *  1. model：调用方给（haiku；X1' 门槛不过时 B/C/D 用 sonnet——人 2026-10-15 裁定）。
 *  2. env：生产子进程继承的是**服务端进程**的 env；本实验跑在一个 Claude Code 会话里，它的会话变量
 *     （CLAUDECODE、CLAUDE_CODE_SESSION_ID、CLAUDE_EFFORT、CLAUDE_CODE_MESSAGING_SOCKET/TOKEN…）会漏进子进程，
 *     其中消息套接字会让子会话能联络本会话。按 2026-10-15 对 :3001 进程 environ 的比对，删掉服务端没有的
 *     会话变量，补上服务端独有的 NODE_OPTIONS。
 *  3. 宿主的三个人工入口（canUseTool/onElicitation/onUserDialog）在生产里接界面；回放时没有人：
 *     AskUserQuestion 拒绝并请模型直接用文字问，其余工具放行（bypass 下本来就不问），对话框/elicitation 取消。
 *  4. 调用方追加的 hooks 接在**已有** hooks 之后（生产的 Stop 观察钩子只读不决策，这里不装）。
 *  5. 分叉回放时加 `forkSession: true`（生产 resume 不分叉；实验必须不写原会话）。
 */
import { buildResidentSdkOptions, CLAUDE_REMOTE_CONTROL_FLAGS } from '../../server/modules/providers/list/claude/claude-host-driver.provider.ts';

/** Variables this experiment's own Claude Code session carries and the :3001 server process does not. */
const SESSION_ONLY_ENV = [
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_EFFORT', 'CLAUDE_PID', 'CLAUDE_AGENT_SDK_VERSION', 'AI_AGENT',
];
const SERVER_NODE_OPTIONS = '--max-old-space-size=2048';

export type ResidentLaunch = {
  cwd: string;
  model: string;
  /** Fork the original session at this message (inclusive): resume + resumeSessionAt + forkSession. */
  fork?: { sessionId: string; atUuid: string };
  /** Hook groups appended per event after whatever the launch already carries. */
  hooks?: Record<string, unknown[]>;
  /** Extra settings merged into the launch's `settings` (e.g. a UserPromptSubmit command hook). */
  settings?: Record<string, unknown>;
  /** Extra env (e.g. VOICE_MODE_HOOK_FORCE). */
  env?: Record<string, string>;
};

export const NO_DIALOG_MESSAGE =
  'No one can answer an interactive dialog in this session right now. Ask your question in plain text instead and continue.';

export function residentOptions(l: ResidentLaunch): Record<string, unknown> {
  const o = buildResidentSdkOptions({
    options: {
      cwd: l.cwd,
      model: l.model,
      permissionMode: 'default',
      ...(l.fork ? { providerSessionId: l.fork.sessionId, resumeAnchorId: l.fork.atUuid } : {}),
    },
    permissions: {
      canUseTool: async (toolName: string, input: Record<string, unknown>) =>
        toolName === 'AskUserQuestion' ? { behavior: 'deny', message: NO_DIALOG_MESSAGE } : { behavior: 'allow', updatedInput: input },
      onElicitation: async () => ({ action: 'decline' }),
      onUserDialog: async () => ({ behavior: 'cancelled' }),
    } as never,
    remoteControlFlags: { ...CLAUDE_REMOTE_CONTROL_FLAGS },
  }) as Record<string, any>;
  const env = { ...(o.env as Record<string, string>) };
  for (const k of SESSION_ONLY_ENV) delete env[k];
  env.NODE_OPTIONS = SERVER_NODE_OPTIONS;
  Object.assign(env, l.env ?? {});
  o.env = env;
  if (l.fork) o.forkSession = true;
  if (l.settings) o.settings = { ...(o.settings ?? {}), ...l.settings };
  if (l.hooks) {
    const merged: Record<string, unknown[]> = { ...(o.hooks ?? {}) };
    for (const [ev, groups] of Object.entries(l.hooks)) merged[ev] = [...(merged[ev] ?? []), ...groups];
    o.hooks = merged;
  }
  return o;
}
