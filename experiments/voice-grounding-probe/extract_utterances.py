import json, glob, os, re, time, collections
cut = time.time() - 12*86400
rows = []
for f in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")):
    if os.path.getmtime(f) < cut: continue
    proj = os.path.basename(os.path.dirname(f))
    try:
        for line in open(f, errors="ignore"):
            if '"type":"user"' not in line: continue
            try: r = json.loads(line)
            except: continue
            if r.get("type") != "user" or r.get("isMeta") or r.get("isSidechain"): continue
            c = r.get("message", {}).get("content")
            if isinstance(c, list):
                c = " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
            if not isinstance(c, str): continue
            c = c.strip()
            if not (6 <= len(c) <= 160) or c.startswith("<") or "\n" in c: continue
            if re.search(r"(task-notification|cross-session|Caveat:|^\[|^/|tool_use|Request interrupted)", c): continue
            if not re.search(r"[一-鿿]", c): continue
            rows.append((r.get("timestamp", ""), proj[-28:], c))
    except Exception: pass
seen, out = set(), []
for ts, p, c in sorted(rows, reverse=True):
    if c in seen: continue
    seen.add(c); out.append((ts, p, c))
print(len(out))
json.dump(out, open("/tmp/vgp/utts.json", "w"), ensure_ascii=False)
for ts, p, c in out[:120]: print(ts[:16], p, "|", c)
