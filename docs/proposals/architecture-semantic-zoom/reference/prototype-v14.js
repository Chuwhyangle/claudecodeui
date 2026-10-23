window.__proto2 = function ({ s, F, LIM = 1.8, forceTier = null }) {
  const NS = 'http://www.w3.org/2000/svg';
  const host = document.querySelector('[data-architecture-plantuml]');
  const src = host.querySelector('svg');
  const hr = host.getBoundingClientRect();
  document.getElementById('proto-ov')?.remove();
  const lh = F * 1.25;
  const cv = document.createElement('canvas').getContext('2d');
  const mw = (str, font) => { cv.font = font; return cv.measureText(str).width; };
  const MONO = `bold ${F}px monospace`, SANS = `600 ${F}px ui-sans-serif, system-ui, sans-serif`;
  // ---------- extract
  const nodes = [...src.querySelectorAll('.uml-node')].map((g) => {
    const r = g.querySelector('rect'); const texts = [...g.querySelectorAll('text')]; const raw = texts[0] ? texts[0].textContent : '';
    const m = raw.match(/^<<(\w+)>>\s*/); const mem = texts.slice(1).map((t) => ({ txt: t.textContent, y: +t.getAttribute('y') }));
    const ln = g.querySelector('line');
    return { id: g.getAttribute('data-entity-id'), x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height'), kind: m ? m[1] : 'class', label: raw.replace(/^<<\w+>>\s*/, ''), seed: g.classList.contains('arch-seed'),
      members: mem.filter((q) => !q.txt.startsWith('…')).map((q) => q.txt), moreLine: (mem.find((q) => q.txt.startsWith('…')) || { txt: '' }).txt, mem, y1: ln ? +ln.getAttribute('y1') : null };
  });
  const pks = [...src.querySelectorAll('.uml-package')].map((g) => { const r = g.querySelector('rect'); const t = g.querySelector('text'); return { id: g.getAttribute('data-package-id'), x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height'), text: t ? t.textContent : g.getAttribute('data-package-id') }; });
  const contains = (p, q) => p !== q && p.x <= q.x + 0.5 && p.y <= q.y + 0.5 && p.x + p.w >= q.x + q.w - 0.5 && p.y + p.h >= q.y + q.h - 0.5;
  pks.forEach((p) => { p.depth = pks.filter((q) => contains(q, p)).length; });
  const parentOf = (e) => pks.filter((p) => contains(p, e)).sort((a, b) => b.depth - a.depth)[0] || null;
  pks.forEach((p) => { p.parent = parentOf(p); }); nodes.forEach((n) => { n.parent = parentOf(n); });
  pks.forEach((p) => { p.kids = [...pks.filter((q) => q.parent === p), ...nodes.filter((n) => n.parent === p)]; });
  const edges = [...src.querySelectorAll('.uml-edge')].map((g) => ({ g, s: g.getAttribute('data-edge-source'), t: g.getAttribute('data-edge-target') }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // ---------- per-node text plan (floor font)
  const midEllip = (str, aw, minChars) => { if (mw(str, MONO) <= aw) return str; for (let k = str.length - 1; k >= minChars; k--) { const h = Math.ceil((k + 1) / 2), t = k - h; const c = str.slice(0, h) + '…' + str.slice(str.length - t); if (mw(c, MONO) <= aw) return c; } return str.slice(0, 5) + '…'; };
  const CAP = 130;
  nodes.forEach((n) => {
    const full = mw(n.label, MONO);
    if (full + 10 <= CAP) { n.nl = [n.label]; n.minW = full + 10; n.titleH = F + 5; }
    else {
      const toks = n.label.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])|./g) || [n.label]; let best = null;
      for (let i = 1; i < toks.length; i++) { const a = toks.slice(0, i).join(''), b = toks.slice(i).join(''); const mx = Math.max(mw(a, MONO), mw(b, MONO)); if (!best || mx < best.mx) best = { a, b, mx }; }
      if (best && best.mx + 10 <= CAP) { n.nl = [best.a, best.b]; n.minW = best.mx + 10; n.titleH = 2 * lh + 3; }
      else { n.nl = [midEllip(n.label, CAP - 10, n.seed ? 6 : 9)]; n.minW = CAP; n.titleH = F + 5; }
    }
    n.minH = n.titleH + (n.kind === 'interface' ? 6 : 10) + 2;
    n.mm = n.members.length > 0 && n.w * s >= 120 && Math.floor((n.h * s - lh - 10) / lh) >= 2;
  });
  pks.forEach((p) => {
    const m = p.text.match(/^(.*?)(\s*\(\d+\))?$/); const segs = m[1].split('/'); p.label = segs[segs.length - 1] + (m[2] || '');
    p.tabW0 = mw(p.label, SANS) + 10; p.tabW = p.tabW0; p.tabH = F + 6;
  });
  pks.forEach((p) => { p.seedCount = nodes.filter((n) => n.seed && contains(p, n)).length; p.badge = p.seedCount ? ` ★${p.seedCount}` : ''; });
  // ---------- monotone axis solver
  const alpha = Math.min(1, Math.max(0, (0.9 - s) / 0.4));
  const key = (v) => Math.round(v * 1000);
  const solveAxis = (axis, vis, tier) => {
    const A = axis === 'x' ? 'x' : 'y', L = axis === 'x' ? 'w' : 'h';
    const els = [...vis.pks.map((p) => ({ e: p, p: true })), ...vis.nodes.map((n) => ({ e: n, p: false }))];
    const set = new Set(); els.forEach(({ e }) => { set.add(key(e[A])); set.add(key(e[A] + e[L])); });
    const P = [...set].sort((a, b) => a - b).map((k) => k / 1000); const idx = new Map(P.map((v, i) => [key(v), i]));
    const cons = P.map(() => []);
    const add = (a, b, m) => { const ia = idx.get(key(a)), ib = idx.get(key(b)); if (ia === undefined || ib === undefined || ia >= ib) return; cons[ib].push({ a: ia, m }); };
    vis.nodes.forEach((n) => { if (n.mm && tier === 'A') return; add(n[A], n[A] + n[L], tier === 'B' ? (axis === 'x' ? 24 : 16) : (axis === 'x' ? n.minW : n.minH)); });
    vis.pks.forEach((p) => {
      const kids = p.kids.filter((k) => (k.members !== undefined ? vis.nodes.includes(k) : vis.pks.includes(k)));
      if (!kids.length) { if (axis === 'x' && p.showTab) add(p.x, p.x + p.w, p.tabW + 8); if (axis === 'y') add(p.y, p.y + p.h, p.tabH + 4); return; }
      if (axis === 'y') { add(p.y, Math.min(...kids.map((k) => k.y)), p.showTab ? p.tabH : 3); add(Math.max(...kids.map((k) => k.y + k.h)), p.y + p.h, 3); }
      else { add(p.x, Math.min(...kids.map((k) => k.x)), 3); add(Math.max(...kids.map((k) => k.x + k.w)), p.x + p.w, 3); if (p.showTab) add(p.x, p.x + p.w, p.tabW + 8); }
    });
    const Q = [0];
    for (let k = 1; k < P.length; k++) {
      let comp = false;
      if (axis === 'y' && alpha > 0) {
        const cov = vis.nodes.filter((n) => n.y <= P[k - 1] + 1e-6 && n.y + n.h >= P[k] - 1e-6);
        comp = cov.length > 0 && cov.every((n) => !(n.mm && tier === 'A'));
      }
      Q[k] = Q[k - 1] + s * (P[k] - P[k - 1]) * (comp ? 1 - alpha : 1);
      cons[k].forEach((c) => { Q[k] = Math.max(Q[k], Q[c.a] + c.m); });
    }
    const map = (v) => { if (v <= P[0]) return Q[0] + (v - P[0]) * s; if (v >= P[P.length - 1]) return Q[P.length - 1] + (v - P[P.length - 1]) * s; let lo = 0, hi = P.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (P[mid] <= v) lo = mid; else hi = mid; } const t = (v - P[lo]) / (P[hi] - P[lo]); return Q[lo] + t * (Q[hi] - Q[lo]); };
    return { map, ratio: P.length > 1 ? Q[Q.length - 1] / (s * (P[P.length - 1] - P[0])) : 1, size: Q[Q.length - 1] };
  };
  // ---------- tiers: A names/members, B frames only, C packages only, D packages, tabs only where they fit
  const tiers = ['A', 'B', 'C', 'D']; let chosen = null;
  for (const tier of (forceTier ? [forceTier] : tiers)) {
    const vis = { nodes: tier === 'C' || tier === 'D' ? [] : nodes, pks };
    pks.forEach((p) => { p.showTab = true; p.tabW = p.tabW0 + ((tier === 'C' || tier === 'D') && p.badge ? mw(p.badge, SANS) : 0); });
    const X = solveAxis('x', vis, tier), Y = solveAxis('y', vis, tier);
    const R = Math.max(X.ratio, Y.ratio);
    chosen = { tier, X, Y, vis, R };
    if (R <= LIM && tier !== 'D') break;
    if (tier === 'C') { /* try tier D only if C still blows the budget */ }
  }
  const { tier, X, Y, vis } = chosen;
  // ---------- anchor on the densest window of the mapped layout
  const Wv = hr.width, Hv = hr.height;
  const cen = (vis.nodes.length ? vis.nodes : pks.filter((p) => !p.kids.some((k) => pks.includes(k)))).map((e) => ({ x: (X.map(e.x) + X.map(e.x + e.w)) / 2, y: (Y.map(e.y) + Y.map(e.y + e.h)) / 2 }));
  const ub = { x0: Math.min(...pks.map((p) => X.map(p.x))), y0: Math.min(...pks.map((p) => Y.map(p.y))), x1: Math.max(...pks.map((p) => X.map(p.x + p.w))), y1: Math.max(...pks.map((p) => Y.map(p.y + p.h))) };
  let ax = (ub.x0 + ub.x1) / 2, ay = (ub.y0 + ub.y1) / 2;
  if (ub.x1 - ub.x0 > Wv || ub.y1 - ub.y0 > Hv) {
    let best = null;
    cen.forEach((c) => { const inside = cen.filter((d) => Math.abs(d.x - c.x) <= Wv / 2 && Math.abs(d.y - c.y) <= Hv / 2); if (!best || inside.length > best.length) best = inside; });
    if (best && best.length) { ax = best.reduce((a, c) => a + c.x, 0) / best.length; ay = best.reduce((a, c) => a + c.y, 0) / best.length; }
  }
  const ox = Wv / 2 - ax, oy = Hv / 2 - ay;
  const mx = (v) => X.map(v) + ox, my = (v) => Y.map(v) + oy;
  // ---------- draw
  const ov = document.createElement('div'); ov.id = 'proto-ov';
  ov.style.cssText = `position:fixed;left:${hr.left}px;top:${hr.top}px;width:${hr.width}px;height:${hr.height}px;background:#fff;z-index:99999;overflow:hidden`;
  const o = document.createElementNS(NS, 'svg'); o.setAttribute('width', Wv); o.setAttribute('height', Hv); ov.appendChild(o); document.body.appendChild(ov);
  let cur = o;
  const el = (n, a, parent = cur) => { const e = document.createElementNS(NS, n); Object.entries(a).forEach(([k, v]) => e.setAttribute(k, v)); parent.appendChild(e); return e; };
  const txt = (t, x, y, font, fill, mid) => { const e = el('text', { x, y, fill, 'font-size': F, ...(mid ? { 'text-anchor': 'middle' } : {}) }); e.style.font = font; e.textContent = t; return e; };
  const vp = { x: 0, y: 0, w: Wv, h: Hv };
  const onScreen = (r) => r.x < vp.w && r.x + r.w > 0 && r.y < vp.h && r.y + r.h > 0;
  const depthFill = ['#f1f5f9', '#e7edf5', '#dde6f1', '#d3deec', '#c9d7e7'];
  const R_ = (e) => ({ x: mx(e.x), y: my(e.y), w: mx(e.x + e.w) - mx(e.x), h: my(e.y + e.h) - my(e.y) });
  const stickies = [];
  [...pks].sort((a, b) => a.depth - b.depth).forEach((p) => {
    const r = R_(p); if (r.w < 8 || r.h < 8 || !onScreen(r)) return;
    el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 3, fill: depthFill[Math.min(p.depth, 4)], stroke: '#94a3b8', 'stroke-width': 1 });
    p.sr = r;
  });
  // node geometry: when text is hidden the frame may be drawn shorter than its cell (top-left anchored); cell stays the layout unit
  vis.nodes.forEach((n) => {
    const cell = R_(n); n.cell = cell; n.ext = tier === 'A' && n.mm && cell.w >= 120;
    if (n.ext) { n.rr = cell; return; }
    n.nl1 = tier === 'A' ? (mw(n.label, MONO) + 10 <= cell.w ? [n.label] : n.nl) : null;
    n.hasAttrs = n.members.some((m) => !m.includes('(')); n.hasOps = n.members.some((m) => m.includes('('));
    let th = tier === 'A' ? (n.nl1.length === 2 ? 2 * lh + 3 : F + 5) : 7;
    if (alpha === 0) th = Math.max(th, my(n.y1 ?? n.y + 26) - cell.y);
    const body = n.kind === 'interface' && !n.hasAttrs ? 7 : 13; const hC = th + body;
    const h = cell.h > hC + 2 ? cell.h - alpha * (cell.h - hC) : cell.h;
    n.th = Math.min(th, h * 0.7); n.rr = { ...cell, h };
  });
  // edges (under nodes)
  const eg = el('g', {}); let visEdges = 0; const edgeEls = [];
  if (tier === 'A' || tier === 'B') edges.forEach((ed) => {
    const a = nodeById.get(ed.s), b = nodeById.get(ed.t); if (!a || !b) return;
    const g = ed.g.cloneNode(true); g.removeAttribute('style'); g.querySelectorAll('[style]').forEach((e) => e.removeAttribute('style'));
    let any = false; const shifts = [];
    const nodeAdj = (pt, nd) => {
      const c = nd.cell, rr = nd.rr; if (!c || !rr || rr.h >= c.h - 0.5) return null; const bottom = c.y + c.h, nb = rr.y + rr.h;
      const inX = pt[0] >= c.x - 2 && pt[0] <= c.x + c.w + 2;
      if (inX && pt[1] >= bottom - 2 && pt[1] <= bottom + 22) return nb - bottom;
      const side = (Math.abs(pt[0] - c.x) < 2.5 || Math.abs(pt[0] - (c.x + c.w)) < 2.5) && pt[1] > c.y && pt[1] <= bottom;
      if (side && pt[1] > nb - 3) return Math.max(nb - 4, rr.y + (nd.th || 8) / 2) - pt[1];
      return null;
    };
    g.querySelectorAll('path').forEach((pa) => {
      const cmds = []; pa.getAttribute('d').replace(/([MLQ])([^MLQ]*)/g, (_, c, args) => { const nums = args.trim().split(/[\s,]+/).map(Number); const pts = []; for (let i = 0; i < nums.length; i += 2) pts.push([mx(nums[i]), my(nums[i + 1])]); cmds.push({ c, pts }); return ''; });
      const flat = cmds.flatMap((q) => q.pts);
      [[0, 1], [flat.length - 1, flat.length - 2]].forEach(([ei, ni]) => {
        if (ei === ni || ni < 0 || ni >= flat.length) return;
        for (const nd of [a, b]) { const dy = nodeAdj(flat[ei], nd); if (dy === null) continue; const oy0 = flat[ei][1]; if (Math.abs(flat[ni][1] - oy0) < 0.5) flat[ni][1] += dy; shifts.push({ x: flat[ei][0], y: oy0, dy }); flat[ei][1] += dy; break; }
      });
      flat.forEach((q) => { if (q[0] > 0 && q[0] < Wv && q[1] > 0 && q[1] < Hv) any = true; });
      pa.setAttribute('d', cmds.map((q) => q.c + q.pts.map((t) => t[0].toFixed(1) + ',' + t[1].toFixed(1)).join(' ')).join(' '));
    });
    g.querySelectorAll('polygon').forEach((pg) => {
      const pts = pg.getAttribute('points').trim().split(/\s+/).map((q) => q.split(',').map(Number));
      const cx = pts.reduce((t, q) => t + q[0], 0) / pts.length, cy = pts.reduce((t, q) => t + q[1], 0) / pts.length;
      const ncx = mx(cx); let ncy = my(cy);
      const sh = shifts.find((t) => Math.abs(t.x - ncx) < 16 && Math.abs(t.y - ncy) < 22); if (sh) ncy += sh.dy;
      pg.setAttribute('points', pts.map((q) => `${(ncx + (q[0] - cx) * Math.max(s, 0.6)).toFixed(1)},${(ncy + (q[1] - cy) * Math.max(s, 0.6)).toFixed(1)}`).join(' '));
    });
    if (any) { visEdges++; edgeEls.push(g); }
    eg.appendChild(g);
  });
  const eop = visEdges > 100 ? 0.18 : visEdges > 40 ? 0.3 : visEdges > 22 ? 0.5 : 0.85; edgeEls.forEach((g) => { g.style.opacity = eop; });
  // package labels: v1 form (text inside the frame band + short tab underline); space is reserved by the solver
  [...pks].sort((a, b) => a.depth - b.depth).forEach((p) => {
    const r = p.sr; if (!r) return;
    if (r.w < p.tabW + 4 || r.h < p.tabH + 4) return;
    if (r.y < 0 && r.y + r.h > 40) { stickies.push(p); return; }
    const lx = Math.min(Math.max(r.x + 5, 4), r.x + r.w - p.tabW + 5);
    txt(p.label, lx, r.y + p.tabH / 2 + F * 0.36, SANS, '#334155', false);
    if ((tier === 'C' || tier === 'D') && p.badge) txt(p.badge, lx + mw(p.label, SANS), r.y + p.tabH / 2 + F * 0.36, SANS, '#ea580c', false);
    el('path', { d: `M${lx - 5 + p.tabW},${r.y} V${r.y + p.tabH} H${lx - 5}`, fill: 'none', stroke: '#94a3b8', 'stroke-width': 1 });
  });
  // nodes
  const kindStyle = { interface: ['#e0f2fe', '#0284c7'], enum: ['#fef3c7', '#d97706'], function: ['#f1f5f9', '#64748b'], class: ['#ffffff', '#64748b'] };
  let named = 0, withMembers = 0;
  vis.nodes.forEach((n) => {
    const r = n.rr; if (r.w < 6 || r.h < 4 || !onScreen(r)) return;
    const ks = kindStyle[n.kind] || kindStyle.class; const stroke = n.seed ? '#ea580c' : ks[1];
    cur = o; const cid = 'c' + Math.random().toString(36).slice(2, 8); const cp = el('clipPath', { id: cid }); el('rect', { x: r.x, y: r.y, width: r.w, height: r.h }, cp); cur = el('g', { 'clip-path': `url(#${cid})` }, o);
    el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 2, fill: n.seed && n.kind === 'class' ? '#fff7ed' : ks[0], stroke, 'stroke-width': n.seed ? 2 : 1 });
    const vx0 = Math.max(r.x, 0), vx1 = Math.min(r.x + r.w, Wv), cxv = (vx0 + vx1) / 2;
    const ln = (y) => el('line', { x1: r.x, x2: r.x + r.w, y1: y, y2: y, stroke, 'stroke-width': 1 });
    const ink = n.kind === 'interface' ? '#075985' : '#1e293b';
    if (n.ext) {
      const room = Math.floor((r.h - lh - 10) / lh); const name = n.nl.length === 1 ? n.nl[0] : n.label;
      txt(mw(name, MONO) <= r.w - 8 ? name : midEllip(name, r.w - 8, 6), cxv, r.y + 3 + F, MONO, ink, true);
      ln(r.y + lh + 5);
      const total = (n.moreLine.match(/\((\d+) members\)/) || [0, n.members.length])[1] | 0 || n.members.length;
      const fit = Math.min(n.members.length, room); const hasMore = total > fit; const lines = n.members.slice(0, hasMore ? Math.max(0, fit - 1) : fit);
      const fm = lines.findIndex((x) => x.includes('('));
      if (fm > 0) ln(r.y + lh + 8 + fm * lh + 1); else if (fm < 0) ln(r.y + lh + 8 + (lines.length + (hasMore ? 1 : 0)) * lh + 3);
      const clip = (str) => { let k = str.length; while (k > 8 && mw(str.slice(0, k) + '…', `${F}px monospace`) > r.w - 10) k--; return k < str.length ? str.slice(0, k) + '…' : str; };
      lines.forEach((ml, i) => txt(clip(ml), vx0 + 5, r.y + lh + 8 + (i + 1) * lh - 3, `${F}px monospace`, '#475569', false));
      if (hasMore) txt(`… +${total - lines.length} more`, r.x + 5, r.y + lh + 8 + (lines.length + 1) * lh - 3, `italic ${F}px monospace`, '#64748b', false);
      withMembers++; named++; cur = o; return;
    }
    // compartments: title | attributes | operations (two rules kept at every size; slack is not given to one compartment)
    if (r.h >= 12) {
      const th = n.th;
      ln(r.y + th);
      if (!(n.kind === 'interface' && !n.hasAttrs)) { const body = r.h - th; const sy = r.y + th + (n.hasAttrs && n.hasOps ? body * 0.5 : (n.hasOps ? Math.min(6, body * 0.4) : body - Math.min(6, body * 0.4))); if (sy < r.y + r.h - 2) ln(sy); }
      if (tier === 'A') { const nl = n.nl1; nl.forEach((l, i) => txt(l, cxv, r.y + th / 2 - (nl.length * lh) / 2 + i * lh + F * 0.9 + 0.5, MONO, ink, true)); named++; }
    }
    cur = o;
  });
  stickies.sort((a, b) => a.depth - b.depth).slice(-2).forEach((p) => {
    const r = p.sr; const k = stickies.filter((q) => q !== p && q.depth < p.depth && contains(q, p)).length;
    const x = Math.max(r.x + 5, 4); if (x + p.tabW > r.x + r.w) return;
    const y = 2 + k * (p.tabH + 1);
    el('rect', { x: x - 3, y, width: p.tabW, height: p.tabH, rx: 3, fill: 'rgba(248,250,252,.92)' });
    txt(p.label, x + 2, y + p.tabH / 2 + F * 0.36, SANS, '#334155', false);
  });
  return { tier, R: +chosen.R.toFixed(2), Rx: +X.ratio.toFixed(2), Ry: +Y.ratio.toFixed(2), alpha: +alpha.toFixed(2), named, withMembers, visEdges, size: [Math.round(X.size), Math.round(Y.size)] };
};
