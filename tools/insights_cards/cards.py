"""Cards for thelooper.golf/insights: one HTML per part, rendered to 1600 px wide WebP.

    python3 tools/insights_cards/cards.py <out_dir> [part ids...]

Needs Python Playwright and Inter installed. Fraunces goes in tools/insights_cards/fonts/ (not committed):
the two variable TTFs from github.com/google/fonts/tree/main/ofl/fraunces, saved as
Fraunces_SOFT_WONK_opsz_wght_.ttf and Fraunces-Italic_SOFT_WONK_opsz_wght_.ttf.
Copy the WebPs into src/assets/insights/ and update each card's width and height in InsightsPage.tsx.
The numbers are in card_data.py.
"""
import html
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "out"
CREAM = "#f2e2b8"
GOLD = "#eab308"

PARTS = [
    ("fairways", "01", "Fairways", "#76d39b"),
    ("lies", "02", "Lies", "#c9a46a"),
    ("slopes", "03", "Slopes", "#8bb8ff"),
    ("approaches", "04", "Approaches", "#eab308"),
    ("chipping", "05", "Chipping", "#f97316"),
    ("putting", "06", "Putting", "#2ec4e6"),
]
# Parts already posted get a tick and stripes; none are yet.

e = html.escape


def fmt(v, digits=1, signed=False):
    if isinstance(v, str):
        return v
    s = f"{v:+.{digits}f}" if signed else f"{v:.{digits}f}"
    return s.replace("-", "−")


def grid_panel(p, colour):
    """Rows x columns of numbers. Shaded by size within the panel; one cell can be the base."""
    cols = p["cols"]
    values = [float(c.rstrip("*")) if isinstance(c, str) and c.rstrip("*").replace(".", "", 1).isdigit() else c
              for _, row in p["rows"] for c in row]
    values = [c for c in values if isinstance(c, (int, float))]
    hi = max((abs(v) for v in values), default=1) or 1
    base = p.get("base")  # (row index, col index)
    base_value = p["rows"][base[0]][1][base[1]] if base else None
    head = "".join(f"<th>{e(c)}</th>" for c in cols)
    body = []
    for ri, (label, row) in enumerate(p["rows"]):
        cells = []
        for ci, v in enumerate(row):
            if v is None:
                cells.append('<td><div class="cell empty">–</div></td>')
                continue
            note = ""
            mark = ""
            if isinstance(v, str) and v.endswith("*"):
                mark, v = "*", float(v[:-1])
            if isinstance(v, str):
                cells.append(f'<td><div class="cell" style="background: color-mix(in srgb, {colour} 22%, #0d1a11)"><b>{e(v)}</b>'
                             + (f"<small>{e(p['notes'][ri][ci])}</small>" if p.get("notes") and p["notes"][ri][ci] else "") + "</div></td>")
                continue
            bc = p.get("base_col")
            row_base = row[bc] if bc is not None else base_value
            if isinstance(row_base, str):
                row_base = float(row_base.rstrip("*"))
            if (base and (ri, ci) == tuple(base)) or (bc is not None and ci == bc):
                note = "BASE"
                cls = "cell base"
            else:
                cls = "cell"
                if row_base is not None and p.get("diff", True):
                    note = fmt(v - row_base, p.get("digits", 1), signed=True)
                elif p.get("notes"):
                    note = p["notes"][ri][ci] or ""
            strength = min(1.0, abs(v) / hi) if isinstance(v, (int, float)) else 0
            tone = "#5b8bb3" if isinstance(v, (int, float)) and v < 0 else colour
            alpha = int(10 + 52 * strength)
            style = f"background: color-mix(in srgb, {tone} {alpha}%, #0d1a11)"
            if strength > 0.7 and tone == colour:
                style += "; color: #0b140d"
            value = fmt(v, p.get("digits", 1)) + mark + p.get("unit", "")
            cells.append(f'<td><div class="{cls}" style="{style}"><b>{e(value)}</b>'
                         + (f"<small>{e(note)}</small>" if note else "") + "</div></td>")
        rl = label if isinstance(label, str) else label[0]
        rs = "" if isinstance(label, str) else f"<small>{e(label[1])}</small>"
        body.append(f"<tr><th class=\"row\">{e(rl)}{rs}</th>{''.join(cells)}</tr>")
    pill = f'<span class="pill">{e(p["pill"])}</span>' if p.get("pill") else ""
    sub = f' <span class="sub">{e(p["sub"])}</span>' if p.get("sub") else ""
    return (f'<section class="panel {p.get("span", "")}"><header><h3>{e(p["title"])}{sub}</h3>{pill}</header>'
            f'<table><thead><tr><th></th>{head}</tr></thead><tbody>{"".join(body)}</tbody></table>'
            + (f'<p class="foot">{e(p["foot"])}</p>' if p.get("foot") else "") + "</section>")


def bars_panel(p, colour):
    hi = p.get("max") or max(r[1] for r in p["rows"])
    rows = []
    for label, v, text, *rest in p["rows"]:
        ghost = rest[0] if rest else None
        width = max(2, 100 * v / hi)
        ghost_bar = f'<i class="ghost" style="width:{100 * ghost / hi:.1f}%"></i>' if ghost else ""
        rows.append(f'<div class="bar"><span class="lbl">{e(label)}</span><span class="track">{ghost_bar}'
                    f'<i style="width:{width:.1f}%; background:{colour}"></i></span><span class="val">{e(text)}</span></div>')
    sub = f' <span class="sub">{e(p["sub"])}</span>' if p.get("sub") else ""
    pill = f'<span class="pill">{e(p["pill"])}</span>' if p.get("pill") else ""
    return (f'<section class="panel {p.get("span", "")}"><header><h3>{e(p["title"])}{sub}</h3>{pill}</header>'
            f'<div class="bars">{"".join(rows)}</div>'
            + (f'<p class="foot">{e(p["foot"])}</p>' if p.get("foot") else "") + "</section>")


def ranges_panel(p, colour):
    """Range bars per row, one chart per column: line = every shot, bar = most shots (10th-90th), dot = typical."""
    lo, hi = p["scale"]
    pos = lambda v: 100 * (v - lo) / (hi - lo)
    charts = []
    for ci, col in enumerate(p["cols"]):
        rows = []
        for label, cells in p["rows"]:
            mn, p10, med, p90, mx = cells[ci]
            text = f"{med:g}%" if mn == mx else f"{med:g}%  <small>{mn:g}–{mx:g}</small>"
            rows.append(
                f'<div class="rng"><span class="lbl">{e(label)}</span><span class="track">'
                f'<i class="whisk" style="left:{pos(mn):.1f}%;width:{max(0.6, pos(mx) - pos(mn)):.1f}%"></i>'
                f'<i class="band" style="left:{pos(p10):.1f}%;width:{max(1.2, pos(p90) - pos(p10)):.1f}%;background:{colour}"></i>'
                f'<i class="dot" style="left:{pos(med):.1f}%"></i></span><span class="val">{text}</span></div>')
        ticks = "".join(f'<span style="left:{pos(t):.1f}%">{t}%</span>' for t in p["ticks"])
        charts.append(f'<div class="rngchart"><h4>{e(col)}</h4>{"".join(rows)}<div class="ticks"><span class="lbl"></span><span class="tk">{ticks}</span><span class="val"></span></div></div>')
    sub = f' <span class="sub">{e(p["sub"])}</span>' if p.get("sub") else ""
    return (f'<section class="panel {p.get("span", "")}"><header><h3>{e(p["title"])}{sub}</h3></header>'
            f'<div class="rngs">{"".join(charts)}</div>' + (f'<p class="foot">{e(p["foot"])}</p>' if p.get("foot") else "") + "</section>")


def tile_panel(p, colour):
    items = "".join(f'<div class="tile"><b style="color:{colour}">{e(big)}</b><span>{e(text)}</span></div>'
                    for big, text in p["tiles"])
    sub = f' <span class="sub">{e(p["sub"])}</span>' if p.get("sub") else ""
    return (f'<section class="panel {p.get("span", "")}"><header><h3>{e(p["title"])}{sub}</h3></header>'
            f'<div class="tiles">{items}</div>' + (f'<p class="foot">{e(p["foot"])}</p>' if p.get("foot") else "") + "</section>")


PANEL = {"grid": grid_panel, "bars": bars_panel, "tiles": tile_panel, "ranges": ranges_panel}


def tabs(current):
    """All six parts ship together: the current one is filled, the rest are plain tabs with their colour."""
    out = []
    for pid, num, name, colour in PARTS:
        kind = "now" if pid == current else "other"
        style = f"background:{colour}" if pid == current else f"--c:{colour}"
        out.append(f'<div class="tab {kind}" style="{style}"><span>{num}</span>{e(name)}</div>')
    return "".join(out)


def page(card):
    pid = card["id"]
    num, name, colour = next((n, nm, c) for p_, n, nm, c in PARTS if p_ == pid)
    title = e(card["title"]).replace("[", f'<em style="color:{colour}">').replace("]", "</em>")
    panels = "".join(PANEL[p["kind"]](p, colour) for p in card["panels"])
    takeaways = "".join(f'<li style="border-color:{colour}"><b>{e(a)}</b> {e(b)}</li>' for a, b in card["takeaways"])
    fonts = (HERE / "fonts").resolve()
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
@font-face {{ font-family: Fraunces; src: url('file://{fonts}/Fraunces_SOFT_WONK_opsz_wght_.ttf'); font-weight: 100 900; font-style: normal; }}
@font-face {{ font-family: Fraunces; src: url('file://{fonts}/Fraunces-Italic_SOFT_WONK_opsz_wght_.ttf'); font-weight: 100 900; font-style: italic; }}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; }}
body {{ width: 800px; font-family: Inter, system-ui, sans-serif; color: #e7efe4;
  background: radial-gradient(700px 380px at 15% 6%, color-mix(in srgb, {colour} 14%, transparent), transparent 70%),
              linear-gradient(180deg, #0b170f, #07100a 60%); }}
.card {{ padding: 0 28px 22px; }}
.tabs {{ display: flex; gap: 6px; margin: 0 -28px; padding: 0 14px; border-bottom: 2px solid {colour}; }}
.tab {{ flex: 1; padding: 7px 9px 7px; border-radius: 9px 9px 0 0; font-size: 11.5px; font-weight: 700; color: #6f7d70; white-space: nowrap; overflow: hidden; }}
.tab span {{ display: block; font-size: 7.5px; letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 1px; }}
.tab.now {{ color: #0b140d; padding-top: 9px; }}
.tab.now span {{ color: rgba(11,20,13,.72); }}
.tab.other {{ color: #b9c4b7; background: #0f1a12; box-shadow: inset 0 3px 0 var(--c); }}
.tab.other span {{ color: var(--c); }}
.top {{ display: flex; align-items: flex-start; justify-content: space-between; margin-top: 20px; }}
.top img {{ height: 64px; }}
.series {{ text-align: right; }}
.series small {{ display: block; color: #d4b15a; font-size: 9.5px; font-weight: 700; letter-spacing: .16em; }}
.series b {{ font-family: Fraunces, Georgia, serif; font-weight: 600; font-size: 34px; color: {colour}; line-height: 1; }}
.series b i {{ font-style: normal; font-size: 16px; color: {CREAM}; margin-left: 3px; }}
h1 {{ margin: 12px 0 6px; font-family: Fraunces, Georgia, serif; font-weight: 600; font-size: 31px; line-height: 1.1; color: #fff; letter-spacing: -.005em; }}
h1 em {{ font-style: italic; }}
.lede {{ margin: 0 0 16px; color: #b9c4b7; font-size: 13px; line-height: 1.45; }}
.lede b {{ color: #fff; }}
.panels {{ display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }}
.panel {{ border: 1px solid #263428; border-radius: 12px; background: rgba(255,255,255,.018); padding: 12px 12px 10px; }}
.panel.wide {{ grid-column: 1 / -1; }}
.panel header {{ display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; }}
.panel h3 {{ margin: 0; font-family: Fraunces, Georgia, serif; font-weight: 600; font-size: 18px; color: #fff; }}
.panel h3 .sub {{ font-family: Inter, sans-serif; font-size: 11px; font-weight: 500; color: #9da99f; margin-left: 4px; }}
.pill {{ flex: none; font-size: 10.5px; font-weight: 700; color: {CREAM}; border: 1px solid #5b5330; background: rgba(234,179,8,.08); padding: 3px 8px; border-radius: 999px; }}
table {{ width: 100%; border-collapse: separate; border-spacing: 4px; table-layout: fixed; }}
thead th:first-child {{ width: 92px; }}
.wide thead th:first-child {{ width: 130px; }}
thead th {{ font-size: 8.5px; letter-spacing: .14em; text-transform: uppercase; color: color-mix(in srgb, {colour} 70%, #e7efe4); font-weight: 700; padding-bottom: 1px; }}
th.row {{ text-align: left; font-size: 11.5px; font-weight: 600; color: #e7efe4; white-space: nowrap; padding-right: 2px; }}
th.row small {{ display: block; font-size: 9px; font-weight: 500; color: #8e9b90; }}
.cell {{ border-radius: 7px; border: 1px solid rgba(255,255,255,.05); text-align: center; padding: 6px 2px 5px; }}
.cell b {{ display: block; font-size: 16px; font-weight: 700; line-height: 1.1; }}
.cell small {{ display: block; font-size: 8.5px; font-weight: 600; opacity: .75; margin-top: 1px; }}
.cell.base {{ outline: 1.5px solid {CREAM}; }}
.cell.empty {{ color: #5f6c61; }}
.bars {{ display: grid; gap: 7px; margin-top: 4px; }}
.bar {{ display: grid; grid-template-columns: 92px 1fr 74px; align-items: center; gap: 8px; font-size: 11.5px; }}
.bar .lbl {{ font-weight: 600; }}
.bar .track {{ position: relative; height: 12px; border-radius: 6px; background: #142118; overflow: hidden; }}
.bar .track i {{ position: absolute; left: 0; top: 0; bottom: 0; border-radius: 6px; }}
.bar .track i.ghost {{ background: #2a3a2d; }}
.bar .val {{ text-align: right; font-weight: 700; font-size: 11.5px; }}
.tiles {{ display: grid; gap: 8px; margin-top: 4px; }}
.tile {{ display: grid; grid-template-columns: 104px 1fr; gap: 10px; align-items: baseline; }}
.tile b {{ white-space: nowrap; font-family: Fraunces, Georgia, serif; font-size: 24px; font-weight: 600; line-height: 1; }}
.tile span {{ font-size: 11.5px; color: #cfd8cd; line-height: 1.35; }}
.rngs {{ display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 4px; }}
.rngchart h4 {{ margin: 0 0 6px; font-size: 8.5px; letter-spacing: .14em; text-transform: uppercase; color: color-mix(in srgb, {colour} 70%, #e7efe4); }}
.rng, .ticks {{ display: grid; grid-template-columns: 70px 1fr 82px; align-items: center; gap: 8px; font-size: 11.5px; margin-bottom: 7px; }}
.rng .lbl {{ font-weight: 600; }}
.rng .track, .ticks .tk {{ position: relative; height: 14px; }}
.rng .track {{ background: #142118; border-radius: 7px; }}
.rng .track i {{ position: absolute; top: 50%; transform: translateY(-50%); }}
.rng .whisk {{ height: 2px; background: #8e9b90; }}
.rng .band {{ height: 8px; border-radius: 4px; opacity: .85; }}
.rng .dot {{ width: 9px; height: 9px; margin-left: -4.5px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 2px #0b140d; }}
.rng .val {{ text-align: right; font-weight: 700; }}
.rng .val small {{ font-weight: 500; color: #8e9b90; font-size: 9.5px; }}
.ticks {{ margin: 0; }}
.ticks .tk span {{ position: absolute; transform: translateX(-50%); font-size: 8.5px; color: #6f7d70; }}
.foot {{ margin: 6px 2px 0; font-size: 9.5px; color: #8e9b90; }}
ul {{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px 18px; margin: 16px 0 0; padding: 0; list-style: none; }}
li {{ border-left: 3px solid; padding: 1px 0 1px 10px; font-size: 12px; line-height: 1.4; color: #cfd8cd; }}
li b {{ color: #fff; }}
footer {{ display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; margin-top: 16px; padding-top: 12px; border-top: 1px solid #1f2c22; }}
footer p {{ margin: 0; font-size: 9.5px; color: #8e9b90; line-height: 1.45; max-width: 560px; }}
footer div {{ text-align: right; flex: none; }}
footer small {{ display: block; font-size: 9.5px; color: #b9c4b7; }}
footer b {{ font-family: Fraunces, Georgia, serif; font-weight: 600; font-size: 21px; color: {GOLD}; }}
</style></head><body><div class="card">
<div class="tabs">{tabs(pid)}</div>
<div class="top"><img src="file://{(HERE.parents[1] / 'src' / 'assets' / 'LooperLogo.webp').resolve()}" alt=""><div class="series"><small>GSPRO PHYSICS, MEASURED</small><b>{int(num)}<i>of 6</i></b></div></div>
<h1>{title}</h1>
<p class="lede">{card["lede"]}</p>
<div class="panels">{panels}</div>
<ul>{takeaways}</ul>
<footer><p>{e(card["footer"])}</p><div><small>Live caddie for GSPro</small><b>thelooper.golf</b></div></footer>
</div></body></html>"""


def render(cards):
    from playwright.sync_api import sync_playwright
    from PIL import Image
    OUT.mkdir(parents=True, exist_ok=True)
    sizes = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page_ = browser.new_page(viewport={"width": 800, "height": 300}, device_scale_factor=2)
        for card in cards:
            html_path = OUT / f"{card['id']}.html"
            html_path.write_text(page(card))
            page_.goto(f"file://{html_path}")
            page_.wait_for_timeout(300)
            png = OUT / f"{card['id']}.png"
            page_.screenshot(path=str(png), full_page=True)
            im = Image.open(png).convert("RGB")
            webp = OUT / f"insight-{next(n for p, n, _, _ in PARTS if p == card['id'])}-{card['id']}.webp"
            im.save(webp, "WEBP", quality=88, method=6)
            sizes[card["id"]] = [im.width, im.height, webp.name]
        browser.close()
    (OUT / "sizes.json").write_text(json.dumps(sizes, indent=1))
    print(json.dumps(sizes))


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    from card_data import CARDS
    only = [a for a in sys.argv[2:]]
    render([c for c in CARDS if not only or c["id"] in only])
