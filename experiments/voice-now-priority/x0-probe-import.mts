import { buildResidentSdkOptions, CLAUDE_REMOTE_CONTROL_FLAGS } from '/data/home/yale/work/claudecodeui/server/modules/providers/list/claude/claude-host-driver.provider.ts';

const o = buildResidentSdkOptions({ options: { cwd: '/tmp', model: 'haiku', permissionMode: 'default' }, remoteControlFlags: CLAUDE_REMOTE_CONTROL_FLAGS });
const { env, spawnClaudeCodeProcess, ...rest } = o as any;
console.log(JSON.stringify(rest, null, 1));
console.log('env keys added:', Object.keys(env).filter((k) => !(k in process.env)).join(','), ' spawnHook:', typeof spawnClaudeCodeProcess);
process.exit(0);
