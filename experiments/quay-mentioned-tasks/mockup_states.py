#!/usr/bin/env python3
"""Renders the pulse-strip / mini-gantt + popover state board as a standalone HTML mockup.

Input: a quay snapshot JSON (with `gantt` lanes) at SNAPSHOT_PATH; output: an HTML file
whose bars are computed from those real lanes. Run it, serve the HTML, screenshot it.
"""
import json
import sys

SNAPSHOT_PATH = sys.argv[1] if len(sys.argv) > 1 else '/tmp/quay-snapshot-6h.json'
OUT_PATH = sys.argv[2] if len(sys.argv) > 2 else '/tmp/quay-pulse-states.html'

d = json.load(open(SNAPSHOT_PATH))
g = d['gantt']
now = g['nowMs']; win = g['windowHours']; start = now - win * 3600_000; span = now - start
STATE_COLORS = {'completed': '#059669', 'failed': '#dc2626', 'landed': '#10b981',
                'timed-out': '#ea580c', 'exited-not-landed': '#ca8a04'}


def bars(W):
    out = []
    for li, lane in enumerate(g['lanes']):
        for it in lane:
            x = round((it['startMs'] - start) / span * W, 2)
            w = max(1.5, round((it['endMs'] - it['startMs']) / span * W, 2))
            x = max(0, min(W, x)); w = min(w, W - x)
            c = STATE_COLORS.get(it.get('finalState') or it.get('phase'), '#9ca3af')
            out.append((li, x, w, c))
    return out


def strip_svg(W, H, laneH, y0, barH):
    lanes = '\n'.join(
        f'<line x1="0" y1="{y0+li*laneH+barH+1}" x2="{W}" y2="{y0+li*laneH+barH+1}" '
        f'stroke="#e2ddd2" stroke-opacity="0.7" stroke-width="0.5"/>' for li in range(5))
    rs = '\n'.join(
        f'<rect x="{x}" y="{y0+li*laneH}" width="{w}" height="{barH}" rx="1" fill="{c}"/>'
        for (li, x, w, c) in bars(W))
    return f'<svg viewBox="0 0 {W} {H}" width="{W}" height="{H}" aria-hidden="true">{lanes}\n{rs}</svg>'


MOBILE = strip_svg(43, 32, 5.8, 3, 4)
DESKTOP = strip_svg(150, 30, 5.4, 3, 3.5)


def svg_menu(): return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#757269" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>'
def svg_chat(c='#374151'): return f'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
def svg_chevron(): return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'
def svg_more(): return '<svg width="18" height="18" viewBox="0 0 24 24" fill="#757269"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>'
AVATAR = '<div style="width:24px;height:24px;flex-shrink:0;border-radius:6px;background:#d97706;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">C</div>'


def trigger(svg, active=False, wide=False):
    w = '150px' if wide else '43px'
    style = 'width:%s;height:%s;display:flex;align-items:center;justify-content:center;border-radius:8px;padding:1px;' % (w, '30px' if wide else '32px')
    style += 'background:var(--accent);box-shadow:0 0 0 1px var(--ring);' if active else 'background:transparent;'
    return f'<div style="{style}">{svg}</div>'


def tab_pills():
    tabs = [('Chat', True), ('Shell', False), ('Files', False), ('Git', False), ('Quay', False), ('Architecture', False)]
    out = []
    for name, active in tabs:
        s = 'background:var(--primary);color:var(--primary-fg);' if active else 'background:transparent;color:var(--muted-fg);'
        out.append(f'<div style="height:30px;display:flex;align-items:center;padding:0 10px;border-radius:6px;font-size:13px;font-weight:500;white-space:nowrap;{s}">{name}</div>')
    return '<div style="display:flex;align-items:center;gap:2px;padding:3px;border:1px solid rgba(226,221,210,.6);border-radius:10px;background:rgba(237,234,227,.55)">' + ''.join(out) + '</div>'


def header_mobile(strip, active=False):
    t = trigger(strip, active)
    return f'''<div style="height:45px;display:flex;align-items:center;gap:8px;padding:0 12px;background:rgba(247,246,243,.95);border-bottom:1px solid var(--border);position:relative">
      <div style="width:36px;height:32px;flex-shrink:0;display:flex;align-items:center;justify-content:center">{svg_menu()}</div>
      {AVATAR}
      <div style="flex:1 1 0;min-width:0">
        <div style="font-size:12.5px;font-weight:600;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2">quay 项目的 in-flight 甘特图</div>
        <div style="font-size:10px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">claudecodeui</div>
      </div>
      {t}
      <div style="flex-shrink:0;height:32px;display:flex;align-items:center;gap:6px;padding:0 8px;border:1px solid var(--border);background:rgba(237,234,227,.55);border-radius:8px">{svg_chat()}{svg_chevron()}</div>
      <div style="width:36px;height:32px;flex-shrink:0;display:flex;align-items:center;justify-content:center">{svg_more()}</div>
    </div>'''


def header_desktop(strip, active=False):
    t = trigger(strip, active, wide=True)
    return f'''<div style="height:57px;display:flex;align-items:center;gap:10px;padding:0 12px;background:rgba(247,246,243,.95);border-bottom:1px solid var(--border);position:relative">
      <div style="width:36px;height:32px;flex-shrink:0;display:flex;align-items:center;justify-content:center">{svg_menu()}</div>
      {AVATAR}
      <div style="flex:0 1 240px;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2">quay 项目的 in-flight 甘特图</div>
        <div style="font-size:10.5px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">claudecodeui</div>
      </div>
      {t}
      {tab_pills()}
      <div style="width:32px;height:32px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:1px solid rgba(226,221,210,.6);border-radius:8px">{svg_more()}</div>
    </div>'''


def popover(kind):
    head = '<div style="padding:9px 12px 7px;border-bottom:1px solid var(--muted);display:flex;align-items:center;justify-content:space-between"><div style="font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted-fg)">本会话提到的任务</div>'
    foot = '<div style="padding:8px 12px;border-top:1px solid var(--muted);display:flex;align-items:center;justify-content:space-between"><span style="font-size:12.5px;color:var(--primary);font-weight:500">在 Quay 面板打开全部</span><span style="color:var(--primary)">→</span></div>'
    if kind == 'list':
        head += '<div style="font-size:10px;color:var(--muted-fg);background:var(--muted);border-radius:999px;padding:1px 7px">3</div></div>'
        rows = []
        for dotc, bg, badge_fg, badge_text, id_ in [
            ('#8b5cf6', '#f5f3ff', '#7c3aed', 'fan-in', 'gap-quay-pulse-strip-readable-window-axis-rows…'),
            ('#ef4444', '#fef2f2', '#dc2626', 'failed', 'gap-quay-tab-three-charts-aligned-time-axis-revert…'),
            ('#10b981', '#ecfdf5', '#059669', 'done', 'gap-quay-tab-drop-pulse-strip'),
        ]:
            rows.append(f'''<div style="display:flex;align-items:center;gap:9px;padding:7px 12px;border-radius:6px">
              <span style="width:8px;height:8px;border-radius:50%;background:{dotc};flex-shrink:0"></span>
              <span style="flex:1 1 0;min-width:0;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{id_}</span>
              <span style="flex-shrink:0;font-size:10px;font-weight:500;border-radius:999px;padding:1px 8px;background:{bg};color:{badge_fg}">{badge_text}</span>
            </div>''')
        return '<div style="position:absolute;top:52px;right:12px;width:334px;background:var(--card);border:1px solid var(--border);border-radius:12px;box-shadow:0 12px 32px rgba(13,11,8,.16);padding:5px;z-index:10">' + head + ''.join(rows) + foot + '</div>'
    if kind == 'empty':
        head += '</div>'
        body = '<div style="padding:14px 12px;font-size:12.5px;color:var(--muted-fg);line-height:1.5">本会话未提及任何 quay 任务。<br/>切换任务会话或去 Quay 面板看全局看板。</div>'
        return '<div style="position:absolute;top:52px;right:12px;width:300px;background:var(--card);border:1px solid var(--border);border-radius:12px;box-shadow:0 12px 32px rgba(13,11,8,.16);padding:5px;z-index:10">' + head + body + foot + '</div>'
    if kind == 'unavailable':
        head += '</div>'
        body = '<div style="padding:14px 12px;font-size:12.5px;color:var(--muted-fg);line-height:1.5">无法读取 quay lanes。<br/><span style="color:#b45309">插件缺少 lanes verb / lanes 读取失败。</span></div>'
        return '<div style="position:absolute;top:52px;right:12px;width:300px;background:var(--card);border:1px solid var(--border);border-radius:12px;box-shadow:0 12px 32px rgba(13,11,8,.16);padding:5px;z-index:10">' + head + body + foot + '</div>'


def panel(label, inner, width):
    return f'''<div style="width:{width}px">
      <div style="font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--muted-fg);margin:0 0 6px 2px">{label}</div>
      <div style="border:1px solid var(--border);border-radius:14px;background:var(--bg);overflow:visible;position:relative">{inner}</div>
    </div>'''


# A popover is absolutely positioned, so reserve height below the header for it.
SPACER = '<div style="height:180px"></div>'

boards = [
    panel('桌面 · 迷你甘特图 · 常态(透明无边框,融入标题栏)', header_desktop(DESKTOP), 900),
    panel('桌面 · 迷你甘特图 · 展开(点击态高亮 + popover 列表)', header_desktop(DESKTOP, active=True) + popover('list') + SPACER, 900),
    panel('移动 · 脉冲条 · 常态(透明无边框)', header_mobile(MOBILE), 392),
    panel('移动 · 脉冲条 · 展开(点击态高亮 + popover 列表)', header_mobile(MOBILE, active=True) + popover('list') + SPACER, 392),
    panel('Popover · 空态(本会话未提及任务)', header_mobile(MOBILE, active=True) + popover('empty') + SPACER, 392),
    panel('Popover · 不可用态(lanes 读不到)', header_mobile(MOBILE, active=True) + popover('unavailable') + SPACER, 392),
]

html = '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>pulse states board</title><style>
:root{
  --bg:#f7f6f3; --card:#ffffff; --fg:#0d0b08; --border:#e2ddd2; --muted:#edeae3;
  --muted-fg:#757269; --accent:#edeae3; --primary:#2563eb; --primary-fg:#f8fafc; --ring:rgba(37,99,235,.30);
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:#ece9e2;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Encode Sans",sans-serif}
.board{max-width:960px;margin:0 auto;padding:28px 20px;display:flex;flex-direction:column;gap:26px;align-items:flex-start}
.footnote{font-size:11px;color:var(--muted-fg);line-height:1.6}
</style></head><body><div class="board">
<div class="footnote">状态总览 · 迷你甘特图(宽屏)/ 脉冲条(窄屏)+ popover。常态 = 透明背景、无边框、融入标题栏;点击态 = 淡色填充 + primary 描边。数据 = 本项目最近 6h 真实 lanes;popover 列表为示例(本会话正文 0 提及)。</div>
''' + '\n'.join(boards) + '</div></body></html>'

open(OUT_PATH, 'w').write(html)
print('written', OUT_PATH, len(html))
