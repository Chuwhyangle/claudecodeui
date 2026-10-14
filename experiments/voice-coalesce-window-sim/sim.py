"""Offline replay of the Live Voice coalescing window over real journals.

Model (calibrated 2026-10-14 against 6 continuous journals >= 10-12: 54/56 flushes within 0.15 s):
the window opens on an accepted session_send piece, stays open while the person is speaking
(interim captions re-arm it in production; the journal only keeps finals), and flushes W seconds
after the last of {piece, final caption, speech_stopped}; session_interrupt flushes at once.

usage: python3 -I sim.py --calibrate [journal.jsonl ...]
       python3 -I sim.py --sweep     [journal.jsonl ...]

With no journal arguments the six continuous journals the window was calibrated on are read from
~/.cloudcli/voice-realtime-log/. Pass paths to replay a newer run instead: the point of keeping this
in the repo is that any fresh measurement can be re-calibrated and re-swept without rewriting it.
"""
import glob, json, os, re, sys
from datetime import datetime

# The six continuous journals (>= 10-12) the window was calibrated against, 2026-10-14.
DEFAULT_JOURNAL_IDS = ('99df08d8', 'af5559c0', '7cddaa59', '45c8ee08', 'b5d01c21', 'd4c9bfc4')
JOURNAL_DIR = os.path.expanduser('~/.cloudcli/voice-realtime-log')

def default_journals():
    out = []
    for jid in DEFAULT_JOURNAL_IDS:
        hits = sorted(glob.glob(os.path.join(JOURNAL_DIR, jid + '-*.jsonl')))
        if not hits:
            sys.exit('no journal for %s under %s' % (jid, JOURNAL_DIR))
        out.append(hits[0])
    return out

def ts(s): return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()

def load(path):
    ev, actual = [], []
    for raw in open(path):
        r = json.loads(raw)
        if r.get('kind') != 'log': continue
        line, at = r['line'], ts(r['at'])
        if '<< function_call session_send ' in line:
            try: msg = json.loads(line.split('session_send ', 1)[1]).get('message', '')
            except Exception: continue  # truncated / malformed: never accepted
            if msg.strip(): ev.append((at, 'piece', msg))
        elif '<< function_call session_interrupt' in line: ev.append((at, 'interrupt', ''))
        elif '<< transcription.completed' in line:
            txt = line.split('completed ', 1)[1].strip().strip('"')
            if txt: ev.append((at, 'caption', txt))
        elif 'input_audio_buffer.speech_started' in line: ev.append((at, 'sstart', ''))
        elif 'input_audio_buffer.speech_stopped' in line: ev.append((at, 'sstop', ''))
        elif re.search(r'coalesced \d+ relayed', line): actual.append(at)
    ev.sort(key=lambda e: e[0])
    return ev, actual

def simulate(ev, W):
    out, cur, deadline, speaking = [], [], None, False
    for at, kind, txt in ev:
        if deadline is not None and at >= deadline and not speaking:
            out.append((deadline, cur)); cur, deadline = [], None
        if kind == 'sstart': speaking = True
        elif kind == 'sstop':
            speaking = False
            if cur: deadline = max(deadline or 0, at + W)
        elif kind == 'piece': cur.append((at, txt)); deadline = at + W
        elif kind == 'caption' and cur: deadline = at + W
        elif kind == 'interrupt' and cur: out.append((at, cur)); cur, deadline = [], None
    if cur: out.append((deadline, cur))
    return out

mode, files = sys.argv[1], sys.argv[2:]
if not files:
    files = default_journals()
if mode == '--calibrate':
    a_tot = m_tot = 0
    for f in files:
        ev, actual = load(f)
        sim = [t for t, _ in simulate(ev, 2.5)]
        m = sum(1 for x in actual if any(abs(x - y) <= 0.15 for y in sim))
        a_tot += len(actual); m_tot += m
        print(f'{f.split("/")[-1][:8]} actual={len(actual)} sim={len(sim)} matched={m}')
    print(f'CALIBRATION matched={m_tot}/{a_tot}')
elif mode == '--sweep':
    for W in (0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5):
        groups = [g for f in files for _, g in simulate(load(f)[0], W)]
        print(f'W={W:.1f}s deliveries={len(groups)} pieces={sum(len(g) for g in groups)} merged={sum(1 for g in groups if len(g) > 1)}')
