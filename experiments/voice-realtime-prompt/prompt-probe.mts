import { WebSocket } from 'ws';
const KEY = process.env.DASHSCOPE_API_KEY!;
const VARIANTS: Record<string,string> = {
  A_current: 'You are the voice control plane for one Claude Code session. When the user asks for something to be done in that session, call the `session_send` function with `{ message }` — a single, complete instruction written out in full. Do not call it to answer questions you can answer yourself. The session is fixed by the connection; never name one.',
  B_relay: 'You are a voice relay for one Claude Code session. You never answer, comment or reason yourself, and you never reply in text. EVERYTHING the user says — instructions, questions, remarks, feedback, even a single word — must be passed on by calling the `session_send` function with `{ message }`, where message is what the user said, kept in their own words (fix obvious speech-recognition slips only). Always call the function; never produce a text reply. The session is fixed by the connection; never name one.',
};
const UTTERANCES = ['所以你听见我说什么了，对不对？','你看，第二次推理就出不来了。','三次也没有。','好，我们再试一次。','为什么没有输出？','把 server 里的超时改成三十秒。'];
const tools = [{ type:'function', function:{ name:'session_send', description:'Send a message to the Claude Code session.', parameters:{ type:'object', properties:{ message:{type:'string'} }, required:['message'] } } }];
async function run(instr: string, text: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime', { headers: { Authorization: `Bearer ${KEY}` } });
    let out = 'NO-RESPONSE'; let textOut = '';
    const done = (v: string) => { try { ws.close(); } catch {} resolve(v); };
    const timer = setTimeout(() => done(out), 15000);
    ws.on('open', () => ws.send(JSON.stringify({ type:'session.update', session:{ modalities:['text'], voice:'Tina', instructions: instr, tools, input_audio_format:'pcm16', output_audio_format:'pcm24', turn_detection:null } })));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'session.updated') {
        ws.send(JSON.stringify({ type:'conversation.item.create', item:{ type:'message', role:'user', content:[{ type:'input_text', text }] } }));
        ws.send(JSON.stringify({ type:'response.create' }));
      }
      if (m.type === 'response.text.delta') textOut += m.delta ?? '';
      if (m.type === 'response.function_call_arguments.done') { out = `CALL ${m.arguments}`; }
      if (m.type === 'response.done') { clearTimeout(timer); done(out.startsWith('CALL') ? out : `TEXT-ONLY ${JSON.stringify(textOut)}`); }
    });
    ws.on('error', () => done('ERR'));
  });
}
for (const [name, instr] of Object.entries(VARIANTS)) {
  let calls = 0, total = 0; const lines: string[] = [];
  for (const u of UTTERANCES) for (let i = 0; i < 2; i++) { const r = await run(instr, u); total++; if (r.startsWith('CALL')) calls++; lines.push(`  ${r.startsWith('CALL')?'✔':'✘'} ${u} -> ${r.slice(0,110)}`); }
  console.log(`${name}: session_send called ${calls}/${total}`); console.log(lines.join('\n'));
}
process.exit(0);
