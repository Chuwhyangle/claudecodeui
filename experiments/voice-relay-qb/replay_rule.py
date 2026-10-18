"""Replay tool: the omission-fill rule (SPEC voice-realtime-omission-fill-SPEC.md) against the settle producer,
on the real Live Voice journals.  Free (no API calls).  The model's behaviour is taken from the journal as it
happened (which calls ran, which were cancelled); only the DELIVERY POLICY is varied, so the two policies are
compared on identical model output.

   python3 -I replay_rule.py                       # comparison table (all continuous journals)
   python3 -I replay_rule.py --sweep               # parameter sweep (H x G x SCORE_T x weight threshold)
   python3 -I replay_rule.py --check               # AC-398 gate on the FROZEN connection list + params file
   python3 -I replay_rule.py --check-labels        # AC-399 gate: fills vs the human O/D labels
   python3 -I replay_rule.py --print-chosen        # the `chosen` parameters the replay reads (AC-402)
   python3 -I replay_rule.py --emit-fixture        # write the TS parity fixture (frozen connections + synthetics)

Both gates read `omission-fill-params.json` (thresholds, reasons, frozen connections) AND its `chosen`
parameters from `server/modules/voice-realtime/omission-fill-params.json` — the copy that ships with the
build and that the relay imports, so production and the replay can never disagree about the numbers.
The Python `DEFAULT_PARAMS` below must mirror that `chosen` block; `--print-chosen` (and any gate) exits
non-zero if they drift. `--params FILE` overrides BOTH files (used to demonstrate the false forms:
SCORE_T=1.1 fills everything, SCORE_T=0 fills almost nothing; both must turn the gates red).

`--emit-fixture` is the OTHER side of this file's contract: the server-side pure function
(`server/modules/voice-realtime/voice-realtime-omission-fill.ts`) must reproduce THIS implementation's
decisions case for case.  The fixture carries the inputs (finals / executed / speech starts / chosen
parameters) and this file's own output (fill indices, due times, coverage, and every skip reason), so a
rule change on either side without the other turns the TS test red.
"""
import json, glob, os, re, sys, datetime
from collections import defaultdict

LOG = os.path.expanduser('~/.cloudcli/voice-realtime-log')
HERE = os.path.dirname(os.path.abspath(__file__))
PARAMS_FILE = os.path.join(HERE, 'omission-fill-params.json')
# The `chosen` parameters live in the SERVER tree: that copy is imported by
# `voice-realtime-ws-proxy.service.ts` and emitted by tsc with the build, so production does not need
# `experiments/`. The replay reads it back from here — the reverse dependency AC-402 asks for.
SERVER_PARAMS_FILE = os.path.normpath(os.path.join(
    HERE, '..', '..', 'server', 'modules', 'voice-realtime', 'omission-fill-params.json'))
LABELS_FILE = os.path.join(HERE, 'labels.json')
FLAGGED_FILE = os.path.join(HERE, 'flagged-for-review.md')
FIXTURE_FILE = os.path.join(HERE, 'fixtures', 'omission-fill-cases.json')

# ── parameters: settle (as in production: VOICE_SPAN_SETTLE_MS) and the rule ──────────────────────────────────────────
SETTLE_MS = 2500

# Rule v2 parameters.  The dict is the single source of truth for the policy code; the JSON params file
# (omission-fill-params.json) carries the same values plus the frozen connection list and the thresholds.
DEFAULT_PARAMS = {
    'h_ms': 12000,          # H — hard cap on the decision time
    'g_ms': 1000,           # G — grace after the first executed message (a second one may cover the item)
    'score_t': 0.25,        # coverage below this → fill
    'w_min': 7,             # qualification weight (≈7 CJK chars / 4 latin words)
    'w_hallu': 12,          # short line in a different script than the recent past → hallucination
    'dom_n': 10,            # look back this many transcriptions for the dominant script
    'lookback_ms': 1000,    # coverage window starts this long before the utterance
    'len_min': 7,           # legacy v1 length used by the LOST >=7 chars metric
    'numeral_mode': 'runs2',# 'all' | 'runs2' | 'quantifier' — see strip_numerals()
    'silence_ms': 3000,     # S — if NOTHING was sent for S s AND the user did not start speaking again,
                            #     confirm the omission at t+S instead of waiting the full H
    'carried_t': 0.5,       # bigram recall that marks an item "carried" by the model's messages
    'carried_window_ms': 120000,
}
PARAMS = dict(DEFAULT_PARAMS)

def ts(s): return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000
norm = lambda s: re.sub(r'[\s，。！？、,.!?"“”\'’：:；;（）()\-_·]', '', s).lower()
_CN = {'零': 0, '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
def numerals(s):
    def conv(m):
        t = m.group(0)
        if '十' in t or '百' in t:
            a, _, b = t.partition('十'); return str((_CN.get(a, 1) if a else 1) * 10 + (_CN.get(b, 0) if b else 0))
        return ''.join(str(_CN[c]) for c in t)
    return re.sub(r'[零〇一二三四五六七八九十百]+', conv, s)
N = lambda s: norm(numerals(s))
def bigram_recall(a, b):
    A = [a[i:i + 2] for i in range(max(0, len(a) - 1))]
    if not A: return 1.0
    B = set(b[i:i + 2] for i in range(max(0, len(b) - 1)))
    return sum(1 for g in A if g in B) / len(A)
def english_only(s): return re.fullmatch(r"[\x00-\x7f\s]+", s) is not None

# ── journal → events ─────────────────────────────────────────────────────────────────────────────────────────────────────
def load(jf):
    """returns mode, started_at, finals[(t,text)], executed[(t,text)], events[(t,kind,payload)], delivered[(t,text)]"""
    mode = None; started = None
    ev = []; finals = []; executed = []; delivered = []
    cur = None
    for line in open(jf):
        try: e = json.loads(line)
        except Exception: continue
        if e.get('kind') == 'connection': mode = e.get('mode'); started = e.get('at')
        if 'at' not in e: continue
        t = ts(e['at'])
        if e.get('kind') == 'session_send' and e.get('outcome') == 'delivered':
            delivered.append((t, e.get('message', '') or '')); continue
        if e.get('kind') != 'log': continue
        ln = e.get('line', '')
        if ln.startswith('<< input_audio_buffer.speech_started'): ev.append((t, 'start', None))
        elif ln.startswith('<< input_audio_buffer.speech_stopped'): ev.append((t, 'stop', None))
        elif ln.startswith('<< input_audio_buffer.committed'): ev.append((t, 'commit', None))
        elif ln.startswith('<< response.created'): cur = {'calls': []}
        else:
            m = re.match(r'<< transcription\.completed "(.*)"$', ln)
            if m:
                if norm(m.group(1)): finals.append((t, m.group(1))); ev.append((t, 'asr', len(finals) - 1))
                continue
            m = re.match(r'<< function_call (session_send|session_interrupt) (\{.*\})\s*$', ln)
            if m:
                try: msg = json.loads(m.group(2)).get('message', '') or ''
                except Exception: msg = ''
                if cur is not None: cur['calls'].append((t, msg))
                continue
            m = re.match(r'<< response\.done status=(\w+)', ln)
            if m and cur is not None:
                if m.group(1) == 'completed':
                    if cur['calls']:
                        for ct, msg in cur['calls']:
                            if norm(msg): executed.append((ct, msg))
                        ev.append((t, 'call', [ct for ct, _ in cur['calls']]))
                    else: ev.append((t, 'text_reply', None))
                cur = None
    ev.sort(key=lambda z: z[0]); executed.sort(key=lambda z: z[0])
    return mode, started, finals, executed, ev, delivered

def is_connection(jf):
    """The corpus the rule is scored on: continuous mode, at least 2 finals, at least one executed message."""
    mode, started, finals, executed, ev, delivered = load(jf)
    return (mode == 'continuous' and len(finals) >= 2 and bool(executed)), (finals, executed, ev)

# ── policy S: the settle producer as it is in production ────────────────────────────────────────────────────────────────
def policy_S(finals, ev):
    fills = []                         # (time, [item idx])
    talking = False; span = []; timer = None; pending_commits = 0; covered = 0
    def advance(t_next):
        nonlocal timer, span
        while timer is not None and timer <= t_next:
            ft = timer
            if talking: timer = ft + SETTLE_MS; continue          # the endpoint's turn is open → re-arm
            if span: fills.append((ft, span[:])); span = []
            timer = None
    for t, kind, p in ev:
        advance(t)
        if kind == 'start': talking = True
        elif kind == 'stop':
            talking = False
            if timer is not None or span: timer = t + SETTLE_MS     # a turn close re-counts the window
        elif kind == 'commit': talking = False; pending_commits += 1
        elif kind == 'asr':
            pending_commits = max(0, pending_commits - 1)
            if covered > 0: covered -= 1                             # claimed by an earlier response → consumed
            else: span.append(p); timer = t + SETTLE_MS
        elif kind == 'call':                                         # an executed call answers the whole span
            timer = None; span = []; covered = pending_commits
        elif kind == 'text_reply':                                   # production MODEL_TEXT_REPLY: heard items go verbatim
            if span: fills.append((t, span[:])); span = []
            timer = None
    advance(10 ** 15 if False else (ev[-1][0] + 10 * SETTLE_MS if ev else 0))
    return fills

# ── policy R: the v1 omission-fill rule (kept for the comparison table) ─────────────────────────────────────────────────
def policy_R(finals, executed, P=None):
    P = P or PARAMS
    LEN_MIN, SCORE_T = P['len_min'], P['score_t']
    GRACE_MS, HARD_MS, LOOKBACK_MS = P['g_ms'], P['h_ms'], P['lookback_ms']
    fills = []
    for i, (t, x) in enumerate(finals):
        nx = norm(x)
        if len(nx) < LEN_MIN or english_only(x): continue
        first = next((tau for tau, _ in executed if tau >= t - LOOKBACK_MS), None)
        T = min(first + GRACE_MS, t + HARD_MS) if (first is not None and first <= t + HARD_MS) else t + HARD_MS
        msgs = ' '.join(N(m) for tau, m in executed if t - LOOKBACK_MS <= tau <= T)
        if bigram_recall(N(x), msgs) < SCORE_T: fills.append((T, [i]))
    return fills

# ── policy R2: language-neutral variant (rule v2) ───────────────────────────────────────────────────────────────────────
import unicodedata
_CJK_NUM = '零〇一二三四五六七八九十百'
_QUANT = '个条次天日月年点分秒岁块元页行字句位名遍倍号层楼件张只双对'

def strip_numerals(s, mode):
    """Numbers carry no coverage signal.  How much to strip is a measured trade-off:
       'all'        — every digit run and every CJK numeral (the original v2: eats the 一 in 一些/一下)
       'runs2'      — only runs of >=2 numeral characters (a lone 一/二/3 stays a word)
       'quantifier' — only numerals directly before a Chinese measure word, or after 第/每/几
    """
    if mode == 'all':
        s = re.sub(r'\d+', ' ', s)
        return re.sub(r'[零〇一二三四五六七八九十百]+', ' ', s)
    if mode == 'quantifier':
        s = re.sub(r'(?<=[第每几])[0-9零〇一二三四五六七八九十百]+', ' ', s)
        return re.sub(r'[0-9零〇一二三四五六七八九十百]+(?=[' + _QUANT + r'])', ' ', s)
    # 'runs2'
    out = []; i = 0
    while i < len(s):
        if s[i] in _CJK_NUM or s[i].isdigit():
            j = i
            while j < len(s) and (s[j] in _CJK_NUM or s[j].isdigit()): j += 1
            out.append(' ' if j - i >= 2 else s[i:j]); i = j
        else:
            out.append(s[i]); i += 1
    return ''.join(out)

def _script(ch):
    n = unicodedata.name(ch, '')
    if n.startswith(('CJK', 'HIRAGANA', 'KATAKANA')): return 'cjk'
    return n.split(' ')[0] if n else '?'
def analyse(s, mode=None):
    """-> (grams set, weight, dominant script)"""
    mode = mode or PARAMS['numeral_mode']
    s = unicodedata.normalize('NFKC', s).casefold()
    s = strip_numerals(s, mode)
    cjk = []; words = []; cur = []; cnt = defaultdict(int)
    for c in s:
        cat = unicodedata.category(c)
        if cat[0] in 'LM' and not cat == 'Nd':
            sc = _script(c) if cat[0] == 'L' else None
            if sc == 'cjk': cjk.append(c); cnt['cjk'] += 1; (words.append(''.join(cur)) if cur else None); cur = []
            else:
                if sc: cnt[sc] += 1
                cur.append(c)
        else:
            if cur: words.append(''.join(cur)); cur = []
    if cur: words.append(''.join(cur))
    words = [''.join(ch for ch in unicodedata.normalize('NFD', w) if unicodedata.category(ch) != 'Mn') if cnt.get('LATIN') or cnt.get('CYRILLIC') or cnt.get('GREEK') else w for w in words]
    grams = set(('c', ''.join(cjk[i:i + 2])) for i in range(max(0, len(cjk) - 2 + 1)))
    for w in words:
        grams |= set(('w', w[i:i + 3]) for i in range(max(1, len(w) - 2)))
    alpha = {k: v for k, v in cnt.items() if k != 'cjk'}
    nwords = len(words)
    dom = ('cjk' if cnt.get('cjk', 0) >= nwords else max(alpha, key=alpha.get)) if cnt else None   # compare in units (chars vs words), not letters
    return grams, len(cjk) + 2 * len(words), dom

def _analyse_corpus(finals, executed, P):
    mode = P['numeral_mode']
    return [analyse(x, mode) for _, x in finals], [analyse(m, mode) for _, m in executed]

def _plan_R2(finals, executed, events=None, P=None, cache=None, want_reasons=False):
    """The one implementation of rule v2.  `policy_R2` is the fill-only view of this.

    With want_reasons=True the return is (fills, skipped, coverage):
      * fills     — [(T_i, [i])] exactly as policy_R2 returns them
      * skipped   — [(i, reason)] in index order, reason ∈ weight | empty-grams | wrong-script |
                    incomparable | covered — every reason an eligible-looking transcription can be
                    passed over (the vocabulary the TS planner must reproduce)
      * coverage  — {i: coverage} for every filled item (0.0 when the window was empty)
    """
    P = P or PARAMS
    if cache is None:
        A, EA = _analyse_corpus(finals, executed, P)
    else:
        A, EA = cache
    starts = [t for t, k, _ in (events or []) if k == 'start']
    W_MIN, W_HALLU, DOM_N = P['w_min'], P['w_hallu'], P['dom_n']
    SCORE_T = P['score_t']; GRACE_MS, HARD_MS, LOOKBACK_MS, SILENCE_MS = P['g_ms'], P['h_ms'], P['lookback_ms'], P['silence_ms']
    fills = []; skipped = []; coverage = {}
    for i, (t, x) in enumerate(finals):
        g, w, dom = A[i]
        if w < W_MIN:
            if want_reasons: skipped.append((i, 'weight'))
            continue
        if not g:
            if want_reasons: skipped.append((i, 'empty-grams'))
            continue
        prior = defaultdict(int)
        for j in range(max(0, i - DOM_N), i):
            if A[j][2]: prior[A[j][2]] += 1
        if prior and dom != max(prior, key=prior.get) and w < W_HALLU:
            if want_reasons: skipped.append((i, 'wrong-script'))
            continue
        first = next((tau for tau, _ in executed if tau >= t - LOOKBACK_MS), None)
        if first is not None and first <= t + HARD_MS:
            T = min(first + GRACE_MS, t + HARD_MS)
        elif SILENCE_MS is not None and not any(t < st <= t + SILENCE_MS for st in starts):
            T = t + SILENCE_MS                                                       # model silent, user quiet → confirmed
        else:
            T = t + HARD_MS
        cov = 0.0
        win = [k for k, (tau, _) in enumerate(executed) if t - LOOKBACK_MS <= tau <= T]
        if win:
            wd = defaultdict(int)
            for k in win:
                if EA[k][2]: wd[EA[k][2]] += 1
            if wd and max(wd, key=wd.get) != dom:
                if want_reasons: skipped.append((i, 'incomparable'))
                continue                                                             # messages in another script: not comparable
            mg = set().union(*[EA[k][0] for k in win])
            cov = sum(1 for q in g if q in mg) / len(g)
            if cov >= SCORE_T:
                if want_reasons: skipped.append((i, 'covered'))
                continue
        fills.append((T, [i]))
        coverage[i] = cov
    return (fills, skipped, coverage) if want_reasons else fills

def policy_R2(finals, executed, events=None, P=None, cache=None):
    """The rule v2 fill decision (see _plan_R2 for the reason-tracking form).

    Decision time T_i:
      * τ_first = first executed message at/after t_i − LOOKBACK.
      * if τ_first exists and τ_first <= t_i + H:  T_i = min(τ_first + G, t_i + H)
      * elif the model has been silent (no executed message) AND the user did not start speaking again
        within S:                               T_i = t_i + S      ← latency fix: no need to wait the full H
      * otherwise:                              T_i = t_i + H
    Action at T_i: if coverage over [t_i − LOOKBACK, T_i] < SCORE_T, fill x_i verbatim.
    """
    return _plan_R2(finals, executed, events, P, cache, want_reasons=False)

# ── scoring a policy ───────────────────────────────────────────────────────────────────────────────────────────────────
def carried(i, finals, executed, P=None):
    P = P or PARAMS
    t, x = finals[i]; a = N(x)
    msgs = ' '.join(N(m) for tau, m in executed if t - P['lookback_ms'] <= tau <= t + P['carried_window_ms'])
    if not msgs: return False
    if len(a) < 4: return a in msgs
    return bigram_recall(a, msgs) >= P['carried_t']

def score(fills, finals, executed, P=None):
    P = P or PARAMS
    filled = {}
    for T, idxs in fills:
        for i in idxs: filled.setdefault(i, T)
    r = defaultdict(int); lat = []
    for i, (t, x) in enumerate(finals):
        r['items'] += 1
        c = carried(i, finals, executed, P); f = i in filled
        long_ = len(norm(x)) >= P['len_min']
        if f: r['raw'] += 1; lat.append((filled[i] - t) / 1000)
        if c and not f: r['model_only'] += 1
        if c and f: r['dup'] += 1
        if not c and not f: r['lost_long' if long_ else 'lost_short'] += 1
    return r, lat

def pct(a, p):
    a = sorted(a); return a[min(len(a) - 1, int(len(a) * p))] if a else float('nan')

# ── "as it actually ran" (reference: mixed eras, whatever mechanism was live) ────────────────────────────────────────────
def actual(finals, executed, delivered, P=None):
    P = P or PARAMS
    look = P['lookback_ms']; cw = P['carried_window_ms']; ct = P['carried_t']
    r = defaultdict(int)
    for i, (t, x) in enumerate(finals):
        r['items'] += 1
        a = N(x); d = ' '.join(N(m) for dt, m in delivered if t - look <= dt <= t + cw)
        reached = bool(d) and (a in d or (len(a) >= 4 and bigram_recall(a, d) >= ct))
        raw = bool(d) and a in d and not carried(i, finals, executed, P)
        if raw: r['raw'] += 1
        if reached and not raw: r['model_only'] += 1
        if not reached: r['lost_long' if len(norm(x)) >= P['len_min'] else 'lost_short'] += 1
    return r

# ── parameter file ───────────────────────────────────────────────────────────────────────────────────────────────────────
REQUIRED_PARAM_KEYS = ('h_ms', 'g_ms', 'score_t', 'w_min', 'w_hallu', 'dom_n', 'lookback_ms', 'len_min',
                       'numeral_mode', 'silence_ms')
OUTER_THRESHOLDS = {          # AC-398's outer bounds: the params file must not declare anything wider
    'lost_long_ratio_max': 0.03,
    'raw_ratio_max': 0.15,
    'dup_ratio_max': 0.036,
}

def resolve_params_file(path=None):
    return path or PARAMS_FILE

def _read_json(path, label):
    if not os.path.exists(path):
        print(f"FAIL {label} missing: {path}", file=sys.stderr)
        raise SystemExit(2)
    try:
        return json.load(open(path))
    except Exception as e:
        print(f"FAIL {label} unreadable: {path}: {e}", file=sys.stderr)
        raise SystemExit(2)

def read_chosen(path):
    """Read and validate a `chosen` block. Used for the server's shipped file (and, unchanged, for a
    `--params` override file)."""
    raw = _read_json(path, 'chosen params file')
    chosen = raw.get('chosen') or {}
    missing = [k for k in REQUIRED_PARAM_KEYS if k not in chosen]
    if missing:
        print(f"FAIL chosen params file {path} missing chosen keys: {', '.join(missing)}", file=sys.stderr)
        raise SystemExit(2)
    return chosen, raw

def check_chosen_matches_policy(chosen, path):
    """The server's `chosen` is what the relay runs with; `DEFAULT_PARAMS` below keeps this reference
    implementation runnable. A value they disagree on is a gate failure, not a preference: the replay
    would otherwise measure a rule the relay is not running (AC-402 (c))."""
    drift = [f"{k}: server={chosen[k]!r} python={DEFAULT_PARAMS[k]!r}"
             for k in REQUIRED_PARAM_KEYS if chosen[k] != DEFAULT_PARAMS[k]]
    if drift:
        print(f"FAIL {path}: chosen disagrees with the Python defaults: " + '; '.join(drift), file=sys.stderr)
        raise SystemExit(2)

def load_params(path=None):
    """-> (params dict, thresholds dict, frozen connections list, raw file object).  Raises SystemExit(2) on a
    missing/invalid file — a gate must never silently fall back to defaults.

    Without `--params`, the `chosen` parameters come from the SERVER's shipped JSON and the thresholds +
    frozen connection list from this directory's file. A `--params FILE` override is self-contained (as
    before) and deliberately skips the consistency check: it exists to demonstrate false forms."""
    override = path is not None
    path = resolve_params_file(path)
    raw = _read_json(path, 'params file')
    if override:
        chosen = raw.get('chosen') or {}
        missing = [k for k in REQUIRED_PARAM_KEYS if k not in chosen]
        if missing:
            print(f"FAIL params file {path} missing chosen keys: {', '.join(missing)}", file=sys.stderr)
            raise SystemExit(2)
    else:
        chosen, _ = read_chosen(SERVER_PARAMS_FILE)
        check_chosen_matches_policy(chosen, SERVER_PARAMS_FILE)
    P = dict(DEFAULT_PARAMS); P.update({k: chosen[k] for k in REQUIRED_PARAM_KEYS})
    thresholds = raw.get('thresholds') or {}
    for k in OUTER_THRESHOLDS:
        if k not in thresholds:
            print(f"FAIL params file {path} missing threshold: {k}", file=sys.stderr)
            raise SystemExit(2)
    conns = raw.get('connections') or []
    if not conns:
        print(f"FAIL params file {path} has no frozen connection list", file=sys.stderr)
        raise SystemExit(2)
    return P, thresholds, conns, raw

def find_connection(prefix):
    """Locate the single journal whose basename starts with the frozen 8-char prefix."""
    hits = sorted(glob.glob(os.path.join(LOG, prefix + '*.jsonl')))
    if len(hits) != 1:
        return None, hits
    return hits[0], hits

def replay_connections(conns, P):
    """Load + replay exactly the frozen connections.  A missing/ambiguous journal is a hard failure."""
    if not os.path.isdir(LOG):
        print(f"FAIL journal dir missing: {LOG}", file=sys.stderr); raise SystemExit(2)
    out = []; missing = []
    for prefix in conns:
        jf, hits = find_connection(prefix)
        if jf is None:
            missing.append((prefix, len(hits)))
            continue
        mode, started, finals, executed, ev, delivered = load(jf)
        cache = _analyse_corpus(finals, executed, P)
        fills = policy_R2(finals, executed, ev, P, cache)
        r, lat = score(fills, finals, executed, P)
        out.append({'prefix': prefix, 'finals': finals, 'executed': executed, 'fills': fills,
                    'r': r, 'lat': lat})
    if missing:
        for prefix, n in missing:
            why = 'missing' if n == 0 else f'ambiguous ({n} matches)'
            print(f"FAIL frozen connection {prefix}: journal {why} under {LOG}", file=sys.stderr)
        raise SystemExit(2)
    return out

def aggregate(rows):
    r = defaultdict(int); lat = []
    for row in rows:
        for k, v in row['r'].items(): r[k] += v
        lat += row['lat']
    return r, lat

# ── --print-chosen (AC-402) ─────────────────────────────────────────────────────────────────────────────────────────────
def cmd_print_chosen():
    """Print the `chosen` block the replay reads, item for item, as JSON.

    The values come from `server/modules/voice-realtime/omission-fill-params.json` (the file the relay
    imports), and the run fails if that block disagrees with this file's `DEFAULT_PARAMS`. Consumers:
    AC-402 (c) compares the output with the server file itself."""
    chosen, _ = read_chosen(SERVER_PARAMS_FILE)
    check_chosen_matches_policy(chosen, SERVER_PARAMS_FILE)
    print(json.dumps({k: chosen[k] for k in REQUIRED_PARAM_KEYS}, ensure_ascii=False, indent=2, sort_keys=True))
    return 0

# ── --check (AC-398) ────────────────────────────────────────────────────────────────────────────────────────────────────
def cmd_check(param_file=None):
    P, thresholds, conns, raw = load_params(param_file)
    failures = []
    for k, outer in OUTER_THRESHOLDS.items():
        if thresholds[k] > outer:
            failures.append(f"threshold {k}={thresholds[k]} is WIDER than the AC-398 outer bound {outer}")
    if thresholds['delay_p50_max_ms'] is not None and thresholds['delay_p50_max_ms'] > P['h_ms']:
        failures.append(f"threshold delay_p50_max_ms={thresholds['delay_p50_max_ms']} is WIDER than H={P['h_ms']}")
    rows = replay_connections(conns, P)
    r, lat = aggregate(rows)
    n = r['items']
    if n == 0:
        print("FAIL the frozen connections contain no transcribed items", file=sys.stderr); return 2
    lost = r['lost_long'] / n; raw_ratio = r['raw'] / n; dup = r['dup'] / n
    p50 = pct(lat, .5); p90 = pct(lat, .9)
    print(f"params: H={P['h_ms'] / 1000:g}s G={P['g_ms'] / 1000:g}s S={P['silence_ms'] / 1000:g}s "
          f"SCORE_T={P['score_t']} w_min={P['w_min']} numerals={P['numeral_mode']}")
    print(f"frozen connections: {len(conns)}  items: {n}  fills: {r['raw']}")
    print(f"  LOST >=7 chars   {r['lost_long']:3}  {lost:6.2%}   <= {thresholds['lost_long_ratio_max']:.1%}")
    print(f"  raw recogniser   {r['raw']:3}  {raw_ratio:6.2%}   <= {thresholds['raw_ratio_max']:.1%}")
    print(f"  fill+model twice {r['dup']:3}  {dup:6.2%}   <= {thresholds['dup_ratio_max']:.1%}")
    print(f"  fill delay p50   {p50:.2f}s          <  H={P['h_ms'] / 1000:g}s   (p90 {p90:.2f}s)")
    if lost > thresholds['lost_long_ratio_max']: failures.append(f"LOST >=7 chars {lost:.2%} > {thresholds['lost_long_ratio_max']:.1%}")
    if raw_ratio > thresholds['raw_ratio_max']: failures.append(f"raw recogniser {raw_ratio:.2%} > {thresholds['raw_ratio_max']:.1%}")
    if dup > thresholds['dup_ratio_max']: failures.append(f"fill+model twice {dup:.2%} > {thresholds['dup_ratio_max']:.1%}")
    if not (p50 < P['h_ms'] / 1000): failures.append(f"fill delay p50 {p50:.2f}s is not < H={P['h_ms'] / 1000:g}s")
    if thresholds['delay_p50_max_ms'] is not None and pct(lat, .5) * 1000 > thresholds['delay_p50_max_ms']:
        failures.append(f"fill delay p50 {p50:.2f}s > declared max {thresholds['delay_p50_max_ms'] / 1000:g}s")
    if failures:
        for f in failures: print(f"FAIL {f}", file=sys.stderr)
        return 1
    print("PASS --check")
    return 0

# ── --check-labels (AC-399) ─────────────────────────────────────────────────────────────────────────────────────────────
FLAG_HEAD = re.compile(r'^### #(\d+)\s+conn `([0-9a-fA-F]+)`')
FLAG_ITEM = re.compile(r'^\s*[+-][\d.]+s\s+ASR\s+(.*?)\s*<== THIS ITEM\s*$')

def parse_flagged(path=None):
    """Rebuild the annotation set from the review sheet itself (never hand-copied): one entry per block,
    in sheet order, keyed by (connection prefix, recogniser text)."""
    path = path or FLAGGED_FILE
    if not os.path.exists(path):
        print(f"FAIL review sheet missing: {path}", file=sys.stderr); raise SystemExit(2)
    entries = []; cur = None
    for line in open(path):
        m = FLAG_HEAD.match(line)
        if m:
            cur = {'n': int(m.group(1)), 'conn': m.group(2)[:8], 'text': None}
            entries.append(cur); continue
        if cur is None: continue
        m = FLAG_ITEM.match(line)
        if m:
            cur['text'] = m.group(1).strip()
            cur = None
    bad = [e['n'] for e in entries if not e['text']]
    if bad:
        print(f"FAIL review sheet blocks without an ASR item text: {bad}", file=sys.stderr); raise SystemExit(2)
    return entries

def load_labels(path=None):
    path = path or LABELS_FILE
    if not os.path.exists(path):
        print(f"FAIL labels file missing: {path}", file=sys.stderr); raise SystemExit(2)
    raw = json.load(open(path))
    lab = {}
    for k in ('O', 'D', 'blank'):
        for n in raw.get(k, []): lab[int(n)] = k
    return lab

def cmd_check_labels(param_file=None):
    P, thresholds, conns, raw = load_params(param_file)
    entries = parse_flagged(); labels = load_labels()
    by_key = {(e['conn'], e['text']): e for e in entries}
    rows = replay_connections(conns, P)
    matched = []
    for row in rows:
        for T, idxs in row['fills']:
            for i in idxs:
                key = (row['prefix'], row['finals'][i][1])
                e = by_key.get(key)
                if e is not None:
                    matched.append({'n': e['n'], 'label': labels.get(e['n'], 'blank'),
                                    'text': key[1], 'conn': key[0], 'delay': (T - row['finals'][i][0]) / 1000})
    labelled = [m for m in matched if m['label'] in ('O', 'D')]
    o = [m for m in labelled if m['label'] == 'O']; d = [m for m in labelled if m['label'] == 'D']
    o_share = len(o) / len(labelled) if labelled else 0.0
    print(f"annotation set: {len(entries)} flagged items, matched by {len(matched)} fills "
          f"({len(labelled)} O/D-labelled, {len(matched) - len(labelled)} blank)")
    print(f"  O={len(o)}  D={len(d)}  O share of labelled = {o_share:.1%}  "
          f"(need >= {thresholds['labels_o_share_min']:.0%})")
    print(f"  matched fills {len(matched)} (need >= {thresholds['labels_fills_min']})")
    if d:
        print("fills judged D (already carried by the model in a way the labeler considered fine):")
        for m in d: print(f"   #{m['n']} [{m['conn']}] +{m['delay']:.1f}s  {m['text']}")
    failures = []
    if len(matched) < thresholds['labels_fills_min']:
        failures.append(f"only {len(matched)} fills fall on the annotation set (< {thresholds['labels_fills_min']})")
    if not labelled:
        failures.append("no labelled (O/D) fill matches — precision undefined")
    elif o_share < thresholds['labels_o_share_min']:
        failures.append(f"O share {o_share:.1%} < {thresholds['labels_o_share_min']:.0%}")
    if failures:
        for f in failures: print(f"FAIL {f}", file=sys.stderr)
        return 1
    print("PASS --check-labels")
    return 0

# ── --emit-fixture (the TS planner's parity corpus) ─────────────────────────────────────────────────────────────────────
#
# The server-side planner (server/modules/voice-realtime/voice-realtime-omission-fill.ts) is a PORT of
# `_plan_R2`.  A port that drifts silently is the failure this fixture exists to make impossible: every
# case below carries the inputs AND this file's own answer (fill indices, due times, coverage, skip
# reasons), and the TS test compares all four.  Regenerate with:
#
#     python3 -I experiments/voice-relay-qb/replay_rule.py --emit-fixture
#
# The frozen connections make up the bulk of the corpus; the synthetic cases pin the branches the real
# journals do not exercise (pure English, Cyrillic/Greek, cross-script translation, the silence branch,
# the eligibility and coverage boundaries, and the cancelled-response input contract).
FIXTURE_PARAM_MAP = {             # chosen key in omission-fill-params.json → the TS planner's field name
    'h_ms': 'hMs', 'g_ms': 'gMs', 'score_t': 'scoreT', 'w_min': 'wMin', 'w_hallu': 'wHallu',
    'dom_n': 'domN', 'lookback_ms': 'lookbackMs', 'silence_ms': 'silenceMs', 'numeral_mode': 'numeralMode',
}

def fixture_params(P):
    return {ts_key: P[py_key] for py_key, ts_key in FIXTURE_PARAM_MAP.items()}

def _case(name, finals, executed, starts, P, note, source='synthetic', connection=None):
    """Run THIS file's rule on one case and freeze its answer in the fixture's shape."""
    cache = _analyse_corpus(finals, executed, P)
    events = [(t, 'start', None) for t in starts]
    fills, skipped, cov = _plan_R2(finals, executed, events, P, cache, want_reasons=True)
    case = {
        'name': name,
        'source': source,
        'finals': [{'t': t, 'text': x} for t, x in finals],
        'executed': [{'t': t, 'text': x} for t, x in executed],
        'speechStarts': list(starts),
        'params': fixture_params(P),
        'expected': {
            'fills': [{'index': i, 'dueAt': T, 'coverage': cov[i]} for T, idxs in fills for i in idxs],
            'skipped': [{'index': i, 'reason': reason} for i, reason in skipped],
        },
    }
    if connection is not None: case['connection'] = connection
    if note: case['note'] = note
    return case

SYNTH_BASE = 1760000000000          # fixed clock: the fixture must not change when it is regenerated

def synthetic_cases(P):
    """Cases the frozen journals do not contain, one per branch the TS port could get wrong."""
    B = SYNTH_BASE
    return [
        _case('synthetic-pure-english-omission', [(B, 'the connection keeps dropping')], [], [], P,
              'Pure English, model silent and user quiet: the silence branch confirms at t+S.'),
        _case('synthetic-pure-english-covered', [(B, 'the connection keeps dropping')],
              [(B + 500, 'the connection keeps dropping again')], [], P,
              'Pure English, same-script model message covers the item.'),
        _case('synthetic-mixed-script-covered', [(B, '我们check the logs之后再说吧')],
              [(B + 500, '我们check the logs之后再说')], [], P,
              'Chinese + English in one utterance; cjk dominates by unit count (chars vs words).'),
        _case('synthetic-cross-script-translation', [(B, '服务器一直连接不上')],
              [(B + 500, 'the server cannot connect at all')], [], P,
              'The model translated the speech into another script: not comparable, never fill.'),
        _case('synthetic-hallucination-wrong-script',
              [(B, '我们今天讨论一下这个问题'), (B + 5000, 'hello there my friend')], [], [], P,
              'A short line in a different script than the recent past is a recogniser hallucination.'),
        _case('synthetic-pure-cyrillic-covered', [(B, 'сервер постоянно отключается сегодня')],
              [(B + 500, 'сервер постоянно отключается сегодня снова')], [], P,
              'Pure Cyrillic: word trigrams, Cyrillic dominant.'),
        _case('synthetic-greek-covered', [(B, 'ο διακομιστής αποσυνδέεται συνέχεια')],
              [(B + 500, 'ο διακομιστής αποσυνδέεται συνέχεια τώρα')], [], P,
              'Greek with combining marks: NFD + Mn stripping before grams.'),
        _case('synthetic-numeral-runs2',
              [(B, '我们下午三点十八分见吧'), (B + 5000, '订单号是12345678请查收')],
              [(B + 500, '我们下午三点十八分见吧'), (B + 5500, '订单号是请查收')], [], P,
              'runs2: the 十八 run and the 8-digit run are stripped on BOTH sides.'),
        _case('synthetic-silence-branch-speech-restart', [(B, '服务器一直连接不上')], [], [B + 1000], P,
              'The user started speaking again inside S, so the silence branch does not fire: wait H.'),
        _case('synthetic-empty-window', [(B, '服务器一直连接不上')], [(B - 5000, '服务器一直连接不上')], [], P,
              'The only model message predates the look-back window: the window is empty, fill at t+S.'),
        _case('synthetic-cancelled-response-call', [(B, '服务器一直连接不上')], [], [], P,
              'The covering call lived in a CANCELLED response, so the caller kept it out of `executed`; '
              'the planner must fill. Feeding it as executed is the false form.'),
        _case('synthetic-coverage-boundary-025', [(B, '甲乙丙丁戊己庚辛壬')], [(B + 500, '甲乙丙')], [], P,
              'coverage is exactly SCORE_T=0.25 (2 of 8 bigrams): `>=` covers, `>` would fill.'),
        _case('synthetic-coverage-below-024',
              [(B, '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄')],
              [(B + 500, '甲乙丙丁戊己庚')], [], P,
              'coverage 6/25 = 0.24 < 0.25: just below the threshold, fill.'),
        _case('synthetic-weight-boundary', [(B, '今天天气不错呀'), (B + 5000, '今天天气不错')], [], [], P,
              'w=7 qualifies, w=6 does not (the wall is inclusive).'),
        _case('synthetic-first-executed-at-hard-cap', [(B, '服务器一直连接不上')],
              [(B + 12000, '今天天气不错呀')], [], P,
              'The first executed message lands exactly at t+H: `<=` keeps T_i at the cap, same script, '
              'no coverage → fill at t+H.'),
        _case('synthetic-first-executed-just-after-cap', [(B, '服务器一直连接不上')],
              [(B + 12001, '今天天气不错呀')], [], P,
              'The first executed message lands after t+H: the silence branch owns T_i (t+S), and the '
              'late message is outside the window.'),
    ]

def cmd_emit_fixture(out_path=None):
    P, thresholds, conns, raw = load_params()
    cases = []
    for prefix in conns:
        jf, hits = find_connection(prefix)
        if jf is None:
            print(f"FAIL frozen connection {prefix}: no unique journal under {LOG}", file=sys.stderr)
            return 2
        mode, started, finals, executed, ev, delivered = load(jf)
        starts = [t for t, k, _ in ev if k == 'start']
        cases.append(_case(f'connection-{prefix}', finals, executed, starts, P, None,
                           source='frozen-connection', connection=prefix))
    cases.extend(synthetic_cases(P))
    doc = {
        'rule': 'voice-realtime-omission-fill-SPEC.md v2',
        'generatedBy': 'python3 -I experiments/voice-relay-qb/replay_rule.py --emit-fixture',
        'paramsFile': 'server/modules/voice-realtime/omission-fill-params.json',
        'planner': 'server/modules/voice-realtime/voice-realtime-omission-fill.ts',
        'caseCount': len(cases),
        'cases': cases,
    }
    out_path = out_path or FIXTURE_FILE
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write('\n')
    n_conn = sum(1 for c in cases if c['source'] == 'frozen-connection')
    print(f"wrote {len(cases)} cases ({n_conn} frozen connections, {len(cases) - n_conn} synthetic) to {out_path}")
    return 0

# ── --sweep ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
SWEEP_H = (4, 6, 8, 10, 12)
SWEEP_G = (1, 2, 3, 5)
SWEEP_SCORE = (0.15, 0.25, 0.35)
SWEEP_W = (6, 7, 8)

def _load_sweep_corpus(P):
    corpus = []
    for jf in sorted(glob.glob(os.path.join(LOG, '*.jsonl'))):
        ok, (finals, executed, ev) = is_connection(jf)
        if not ok: continue
        corpus.append((finals, executed, ev, _analyse_corpus(finals, executed, P)))
    return corpus

def cmd_sweep():
    P = dict(DEFAULT_PARAMS)
    corpus = _load_sweep_corpus(P)
    print(f"parameter sweep — {len(corpus)} continuous connections (numeral_mode={P['numeral_mode']}, "
          f"S={P['silence_ms'] / 1000:g}s, lookback={P['lookback_ms']}ms)")
    print(f"{'H':>3} {'G':>3} {'SCORE_T':>7} {'w_min':>5} | {'fills':>5} | {'raw':>6} | {'dup':>6} | "
          f"{'LOST>=7':>7} | {'delay p50':>9} | {'delay p90':>9} | ok")
    rows = []
    for H in SWEEP_H:
        for G in SWEEP_G:
            for ST in SWEEP_SCORE:
                for WM in SWEEP_W:
                    PP = dict(P); PP.update({'h_ms': H * 1000, 'g_ms': G * 1000, 'score_t': ST, 'w_min': WM})
                    agg = defaultdict(int); lat = []
                    for finals, executed, ev, cache in corpus:
                        fills = policy_R2(finals, executed, ev, PP, cache)
                        r, l = score(fills, finals, executed, PP)
                        for k, v in r.items(): agg[k] += v
                        lat += l
                    n = agg['items']; raw_ratio = agg['raw'] / n; dup = agg['dup'] / n
                    lost = agg['lost_long'] / n; p50 = pct(lat, .5); p90 = pct(lat, .9)
                    ok = (raw_ratio <= OUTER_THRESHOLDS['raw_ratio_max'] and dup <= OUTER_THRESHOLDS['dup_ratio_max']
                          and lost <= OUTER_THRESHOLDS['lost_long_ratio_max'] and p50 < H)
                    rows.append((H, G, ST, WM, agg['raw'], raw_ratio, dup, lost, p50, p90, ok))
                    print(f"{H:3} {G:3} {ST:7.2f} {WM:5} | {agg['raw']:5} | {raw_ratio:6.1%} | {dup:6.1%} | "
                          f"{lost:7.1%} | {p50:8.2f}s | {p90:8.2f}s | {'OK' if ok else ''}")
    feasible = [r for r in rows if r[-1]]
    print(f"\nfeasible (raw <= 15%, dup <= 3.6%, LOST >=7 <= 3%, p50 < H): {len(feasible)} of {len(rows)} combos")
    if feasible:
        best = min(feasible, key=lambda r: (r[8], r[6], r[7]))
        print(f"lowest p50 among feasible: H={best[0]} G={best[1]} SCORE_T={best[2]} w_min={best[3]} "
              f"p50={best[8]:.2f}s dup={best[6]:.1%} LOST>=7={best[7]:.1%}")
    # The H=4 / H=12 rows the AC asks for are emitted above even when infeasible.
    return 0

# ── default comparison table ────────────────────────────────────────────────────────────────────────────────────────────
def main(argv):
    param_file = argv[argv.index('--params') + 1] if '--params' in argv else None
    if '--emit-fixture' in argv:
        k = argv.index('--emit-fixture')
        out = argv[k + 1] if k + 1 < len(argv) and not argv[k + 1].startswith('--') else None
        return cmd_emit_fixture(out)
    if '--check' in argv: return cmd_check(param_file)
    if '--check-labels' in argv: return cmd_check_labels(param_file)
    if '--print-chosen' in argv: return cmd_print_chosen()
    if '--sweep' in argv: return cmd_sweep()

    since = argv[argv.index('--since') + 1] if '--since' in argv else None
    show = int(argv[argv.index('--list-fills') + 1]) if '--list-fills' in argv else 0
    P = dict(DEFAULT_PARAMS)
    if param_file:
        P, _, _, _ = load_params(param_file)
    agg = {name: defaultdict(int) for name in ('actual', 'S', 'R', 'R2')}; lats = {'S': [], 'R': [], 'R2': []}
    eras = {'before 10-17 (no settle producer)': defaultdict(lambda: defaultdict(int)), 'since 10-17 (settle producer live)': defaultdict(lambda: defaultdict(int))}
    langs = []; conns = 0; fills_R = []; per_conn = []
    for jf in sorted(glob.glob(os.path.join(LOG, '*.jsonl'))):
        mode, started, finals, executed, ev, delivered = load(jf)
        if mode != 'continuous' or len(finals) < 2 or not executed: continue
        if since and started < since: continue
        conns += 1
        era = 'since 10-17 (settle producer live)' if started >= '2026-10-17' else 'before 10-17 (no settle producer)'
        cid = os.path.basename(jf)[:8]
        cache = _analyse_corpus(finals, executed, P)
        fS = policy_S(finals, ev); fR = policy_R(finals, executed, P)
        fR2 = policy_R2(finals, executed, ev, P, cache)
        rR2, lR2 = score(fR2, finals, executed, P)
        rS, lS = score(fS, finals, executed, P); rR, lR = score(fR, finals, executed, P)
        rA = actual(finals, executed, delivered, P)
        for name, r in (('actual', rA), ('S', rS), ('R', rR), ('R2', rR2)):
            for k, v in r.items(): agg[name][k] += v; eras[era][name][k] += v
        lats['S'] += lS; lats['R'] += lR; lats['R2'] += lR2
        langs.append((cid, len(finals), sum(1 for _, x in finals if analyse(x, P['numeral_mode'])[2] not in ('cjk', None)), len(fR), len(fR2), sum(1 for T, ix in fR2 if analyse(finals[ix[0]][1], P['numeral_mode'])[2] not in ('cjk', None))))
        per_conn.append((cid, len(finals), rS['raw'], rR['raw']))
        for T, idxs in fR:
            for i in idxs: fills_R.append((cid, finals[i][0], finals[i][1], T - finals[i][0], carried(i, finals, executed, P)))
    def row(name, r, lat=None):
        n = r['items']
        return (f"{name:34} {n:5} | {r['raw']:4} ({r['raw']/n:4.0%}) | {r['model_only']:4} ({r['model_only']/n:4.0%}) | "
                f"{r['dup']:3} ({r['dup']/n:4.1%}) | {r['lost_long']:3} ({r['lost_long']/n:4.1%}) | {r['lost_short']:3} ({r['lost_short']/n:4.1%}) | "
                + (f"{pct(lat,.5):4.1f}s / {pct(lat,.9):4.1f}s" if lat else '   -'))
    hdr = f"{'':34} items | raw recogniser text | carried by model only | fill+model twice | LOST >=7 chars | LOST <=6 chars | fill delay p50 / p90"
    print(f"{conns} continuous-mode connections replayed")
    print(f"rule v2 params: H={P['h_ms'] / 1000:g}s G={P['g_ms'] / 1000:g}s S={P['silence_ms'] / 1000:g}s "
          f"SCORE_T={P['score_t']} w_min={P['w_min']} numerals={P['numeral_mode']}\n")
    print(hdr)
    for name, label, lat in (('actual', 'as it actually ran (mixed eras)', None), ('S', 'S  settle producer (production)', lats['S']), ('R', 'R  omission-fill rule (v1)', lats['R']), ('R2', 'R2 language-neutral (v2)', lats['R2'])):
        print(row(label, agg[name], lat))
    for era, d in eras.items():
        if not d: continue
        print(f"\n— {era}:")
        for name, label in (('actual', 'as it actually ran'), ('S', 'S  settle'), ('R', 'R  rule v1'), ('R2', 'R2 rule v2')):
            print(row(label, d[name], lats['S'] if False else None))
    print("\nper connection: items, non-CJK-dominant items, fills v1, fills v2, v2 fills on non-CJK items (connections with any non-CJK item or fill differences):")
    for c in langs:
        if c[2] or c[3] != c[4]: print('  ', c)
    print('   non-CJK items total:', sum(c[2] for c in langs), ' of ', sum(c[1] for c in langs))
    if show:
        print(f"\nfirst {show} fills made by R (conn, delay after the utterance, also carried later by a model message?):")
        for cid, t, x, delay, c in fills_R[:show]: print(f"   [{cid}] +{delay/1000:4.1f}s  {'(carried later → duplicate)' if c else '                         '}  {x[:50]!r}")
    os.makedirs(os.path.join(HERE, 'traces'), exist_ok=True)
    json.dump({'fills_R': fills_R, 'per_conn': per_conn}, open(os.path.join(HERE, 'traces', 'replay-rule-last.json'), 'w'), ensure_ascii=False)
    return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
