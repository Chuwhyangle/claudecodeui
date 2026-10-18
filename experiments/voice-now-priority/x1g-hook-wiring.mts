/** X1' 前置自检：resident-launch + settings.hooks.UserPromptSubmit 的注入是否真到达模型（haiku，一句话）。 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { residentOptions } from './resident-launch.mts';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', 'voice-foreground-background', 'hook', 'voice-mode-context.mjs');
for (const on of [true, false]) {
  const q = query({ prompt: 'Did you receive any additional context that starts with "[Live Voice"? Answer YES or NO, then quote its rule number 1 if YES. No tools.', options: residentOptions({ cwd: mkdtempSync(path.join(os.tmpdir(), 'x1g-')), model: 'haiku', ...(on ? { settings: { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${HOOK}` }] }] } }, env: { VOICE_MODE_HOOK_FORCE: '1' } } : {}) }) as never });
  for await (const m of q as AsyncIterable<any>) if (m.type === 'result') console.log(on ? 'hook ON ' : 'hook OFF', '→', String(m.result).replace(/\n/g, ' ').slice(0, 200));
}
process.exit(0);
