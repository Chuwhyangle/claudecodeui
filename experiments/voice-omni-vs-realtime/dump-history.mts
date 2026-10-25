import { writeFileSync } from 'node:fs';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
const [, , sessionId, providerSessionId, out] = process.argv;
const provider = new ClaudeSessionsProvider();
const res: any = await provider.fetchHistory(sessionId, { providerSessionId, limit: null } as any);
const messages = Array.isArray(res) ? res : res.messages;
writeFileSync(out, JSON.stringify(messages, null, 1));
console.log('wrote', messages.length, 'to', out);
