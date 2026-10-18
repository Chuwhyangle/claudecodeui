import { VOICE_REALTIME_TOOLS } from '../../server/modules/voice-realtime/index.js';
import { z } from 'zod';
for (const t of VOICE_REALTIME_TOOLS) {
  const shape = (t as { inputSchema: Record<string, z.ZodTypeAny> }).inputSchema;
  console.log('==', t.name, '| description chars', t.description.length);
  console.log('   description:', JSON.stringify(t.description));
  console.log('   input fields:', Object.keys(shape).join(', '));
  console.log('   output fields:', Object.keys((t as { outputSchema?: object }).outputSchema ?? {}).join(', ') || '(none)');
}
