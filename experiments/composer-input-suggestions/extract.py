import json, os, sys, glob, datetime
root = os.path.expanduser('~/.claude/projects')
cut = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)).strftime('%Y-%m-%dT')
out = open('/tmp/suggest-analysis/prompts.jsonl', 'w')
def text_of(c):
    if isinstance(c, str): return c, False
    if isinstance(c, list):
        has_tr = any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c)
        t = '\n'.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text')
        return t, has_tr
    return '', False
n = 0
for f in glob.glob(root + '/*/*.jsonl'):
    if os.path.getmtime(f) < datetime.datetime.now().timestamp() - 7*86400: continue
    proj = os.path.basename(os.path.dirname(f))
    sess = os.path.basename(f)[:-6]
    prev = None   # features of the last assistant turn
    idx = 0
    try:
        fh = open(f, errors='replace')
    except: continue
    for line in fh:
        if '"type":"assistant"' not in line and '"type":"user"' not in line:
            continue
        try: o = json.loads(line)
        except: continue
        t = o.get('type')
        if o.get('isSidechain'): continue
        m = o.get('message') or {}
        if t == 'assistant':
            c = m.get('content')
            txt = ''
            tool = False
            if isinstance(c, list):
                for b in c:
                    if b.get('type') == 'text': txt += b.get('text', '')
                    if b.get('type') == 'tool_use': tool = True
            prev = {'a_len': len(txt), 'a_tail': txt.strip()[-1200:], 'a_tool': tool, 'a_stop': m.get('stop_reason')}
        elif t == 'user':
            if o.get('isMeta'): continue
            txt, has_tr = text_of(m.get('content'))
            if has_tr or not txt.strip(): continue
            ts = o.get('timestamp', '')
            if ts < cut: continue
            idx += 1
            rec = {'proj': proj, 'sess': sess, 'i': idx, 'ts': ts, 'ep': o.get('entrypoint'), 'text': txt[:4000], 'len': len(txt)}
            if prev: rec.update(prev)
            out.write(json.dumps(rec, ensure_ascii=False) + '\n'); n += 1
print('records', n)
