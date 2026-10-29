"""Brand mark prototypes for FRC Packs: writes each mark as an app icon (<id>-icon.svg, its own navy tile) and as a bare
mark (<id>-mark.svg, currentColor plus teal, for favicons and lockups), and sheet.html, the preview sheet (icons at
180/32/16 px on dark and light, and the wordmark lockup). Render the sheet to PNG with render.cjs.
Run: python prototype/brand/build.py
"""
import pathlib

here = pathlib.Path(__file__).resolve().parent
NAVY, NAVY2, INK, TEAL, CYAN, GOLD = "#0b0e17", "#14306a", "#eef1f8", "#3cffdc", "#4fd8ff", "#ffd36b"


def star4(cx, cy, r, w=0.24):
    """A four-point spark centred on (cx, cy), `r` tip to centre, `w` how fat the waist is."""
    k = r * w
    return (f"M{cx} {cy - r} C{cx + k / 3:.2f} {cy - k:.2f} {cx + k:.2f} {cy - k / 3:.2f} {cx + r} {cy} "
            f"C{cx + k:.2f} {cy + k / 3:.2f} {cx + k / 3:.2f} {cy + k:.2f} {cx} {cy + r} "
            f"C{cx - k / 3:.2f} {cy + k:.2f} {cx - k:.2f} {cy + k / 3:.2f} {cx - r} {cy} "
            f"C{cx - k:.2f} {cy - k / 3:.2f} {cx - k / 3:.2f} {cy - k:.2f} {cx} {cy - r} Z")


# Each mark is drawn on a 64x64 grid. `ink` is the main colour (white on the navy tile, currentColor when bare).
def seam(ink, uid):
    return f"""
  <defs><linearGradient id="g{uid}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="{TEAL}" stop-opacity=".85"/><stop offset="1" stop-color="{TEAL}" stop-opacity="0"/></linearGradient></defs>
  <path d="M21 20 L43 20 L50 2 L14 2 Z" fill="url(#g{uid})"/>
  <rect x="18" y="21" width="28" height="38" rx="4.5" fill="{ink}"/>
  <rect x="19" y="19.2" width="26" height="2.6" rx="1.3" fill="{TEAL}"/>
  <rect x="18" y="8" width="28" height="7.5" rx="3" fill="{ink}" transform="rotate(-9 32 12)"/>
  <path d="{star4(32, 40, 8, .3)}" fill="{TEAL}"/>"""


def five_stars(ink, uid):
    pts = [(22, 55), (22, 11), (43, 14), (46, 29), (25, 34)]
    line = " ".join(f"{x},{y}" for x, y in pts)
    dots = "".join(f'<circle cx="{x}" cy="{y}" r="4.6" fill="{ink}"/>' for x, y in pts[:4])
    return f"""
  <polyline points="{line}" fill="none" stroke="{ink}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" opacity=".75"/>
  {dots}
  <path d="{star4(25, 34, 10.5, .3)}" fill="{TEAL}"/>"""


def fan(ink, uid):
    card = 'x="21" y="13" width="22" height="31" rx="3.5"'
    return f"""
  <g transform="translate(0 6)">
  <rect {card} fill="{ink}" opacity=".35" transform="rotate(-24 32 50)"/>
  <rect {card} fill="{ink}" opacity=".62" transform="rotate(-8 32 50)"/>
  <rect {card} fill="{ink}" stroke="{TEAL}" stroke-width="2.6" transform="rotate(10 32 50)"/>
  <path d="{star4(35.2, 27.5, 6.5, .3)}" fill="{TEAL}" transform="rotate(10 32 50)"/>
  </g>"""


def spark_card(ink, uid):
    return f"""
  <rect x="14" y="7" width="36" height="50" rx="6" fill="{ink}"/>
  <path d="{star4(32, 32, 14, .26)}" fill="{TEAL}"/>"""


def peel(ink, uid):
    return f"""
  <path d="M36 7 L50 7 L50 21 Z" fill="{TEAL}"/>
  <path d="M20 7 L36 7 L50 21 L50 51 Q50 57 44 57 L20 57 Q14 57 14 51 L14 13 Q14 7 20 7 Z" fill="{ink}"/>
  <path d="M36 7 L36 21 L50 21 Z" fill="{TEAL}" opacity=".45"/>
  <path d="M36 7 L36 21 L50 21" fill="none" stroke="{ink}" stroke-width="1.6" stroke-linejoin="round" opacity=".55"/>"""


MARKS = [
    ("seam", "Seam", seam, "A pack with its top torn off along one clean line, light spilling out. It is the game's signature moment, and the same single seam as the pack opening."),
    ("five-stars", "Five Stars", five_stars, "Five stars traced into a P, from the constellation pack art: five cards in a pack, the last and best one teal."),
    ("fan", "Fan", fan, "Three cards fanned like a hand, the front one edged in Mythic teal. Reads as a card game at any size."),
    ("spark-card", "Spark Card", spark_card, "A card with a teal spark at its heart: the moment of the pull. The simplest of the five."),
    ("peel", "Peel", peel, "A card with its corner peeled back on teal: the reveal, and a hint of what's inside."),
]


def icon(fn, uid):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
            f'<defs><linearGradient id="bg{uid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{NAVY2}"/><stop offset="1" stop-color="{NAVY}"/></linearGradient></defs>'
            f'<rect width="64" height="64" rx="14" fill="url(#bg{uid})"/>{fn(INK, uid)}</svg>')


def mark(fn, uid):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="currentColor">{fn("currentColor", uid)}</svg>'


for mid, _, fn, _ in MARKS:
    (here / f"{mid}-icon.svg").write_text(icon(fn, mid + "f"), encoding="utf-8")
    (here / f"{mid}-mark.svg").write_text(mark(fn, mid + "m"), encoding="utf-8")

rows = []
for i, (mid, name, fn, why) in enumerate(MARKS):
    rows.append(f"""
<section class="row">
  <header><h2><span class="n">{i + 1}</span>{name}</h2><p>{why}</p></header>
  <div class="panes">
    <div class="pane dark">
      <div class="app">{icon(fn, f"{mid}a")}</div>
      <div class="small"><span class="s32">{mark(fn, f"{mid}b")}</span><span class="s16">{mark(fn, f"{mid}c")}</span><span class="t32">{icon(fn, f"{mid}d")}</span><span class="t16">{icon(fn, f"{mid}e")}</span></div>
      <div class="lock"><span class="lm">{mark(fn, f"{mid}g")}</span><b>FRC Packs</b></div>
    </div>
    <div class="pane light">
      <div class="app">{icon(fn, f"{mid}h")}</div>
      <div class="small"><span class="s32">{mark(fn, f"{mid}i")}</span><span class="s16">{mark(fn, f"{mid}j")}</span><span class="t32">{icon(fn, f"{mid}k")}</span><span class="t16">{icon(fn, f"{mid}l")}</span></div>
      <div class="lock"><span class="lm">{mark(fn, f"{mid}o")}</span><b>FRC Packs</b></div>
    </div>
  </div>
</section>""")

sheet = f"""<title>FRC Packs Brand Marks</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lilita+One&family=Chakra+Petch:wght@500;600;700&display=swap">
<style>
/* Layout: one row per mark; each row shows the mark on the game's navy and on white, at app-icon, favicon and lockup
   sizes, so the 16 px test is right next to the big one. */
:root {{
  --bg: #0b0e17; --s1: #131826; --ln: #2a3450; --tx: #eef1f8; --dim: #8b94ab; --teal: {TEAL}; --paper: #f4f6fb; --ink: #0b0e17;
  --display: "Lilita One", "Arial Rounded MT Bold", system-ui, sans-serif;
  --body: "Chakra Petch", ui-sans-serif, system-ui, sans-serif;
  color-scheme: dark;
}}
html, body {{ background: var(--bg); color: var(--tx); }}
body {{ font: 500 15px/1.45 var(--body); padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 22px 40px; }}
main {{ max-width: 980px; margin: 0 auto; display: grid; gap: 26px; }}
h1, h2 {{ font-family: var(--display); font-weight: 400; margin: 0; text-wrap: balance; }}
h1 {{ font-size: clamp(30px, 7vw, 44px); line-height: 1.05; }}
p {{ margin: 0; }}
.intro {{ display: grid; gap: 8px; max-width: 65ch; }}
.intro p, .row header p {{ color: var(--dim); }}
.row {{ display: grid; gap: 12px; }}
.row header {{ display: grid; gap: 4px; max-width: 70ch; }}
.row h2 {{ display: flex; align-items: center; gap: 10px; font-size: 26px; }}
.n {{ display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: var(--s1); box-shadow: inset 0 0 0 1px var(--ln); font: 700 15px var(--body); color: var(--dim); }}
.panes {{ display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }}
.pane {{ display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto; gap: 14px 18px; align-items: center; padding: 18px; border-radius: 18px; min-width: 0; }}
.pane.dark {{ background: var(--s1); color: var(--tx); box-shadow: inset 0 0 0 1px var(--ln); }}
.pane.light {{ background: var(--paper); color: var(--ink); }}
.app {{ grid-row: span 2; width: 128px; height: 128px; filter: drop-shadow(0 8px 18px rgba(0,0,0,.35)); }}
.app svg {{ width: 100%; height: 100%; display: block; }}
.small {{ display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }}
.small span {{ display: inline-block; }}
.small svg {{ display: block; width: 100%; height: 100%; }}
.s32, .t32 {{ width: 32px; height: 32px; }}
.s16, .t16 {{ width: 16px; height: 16px; }}
.lock {{ display: flex; align-items: center; gap: 10px; min-width: 0; }}
.lm {{ width: 40px; height: 40px; flex: none; }}
.lm svg {{ width: 100%; height: 100%; display: block; }}
.lock b {{ font: 400 30px var(--display); white-space: nowrap; }}
.pick {{ display: grid; gap: 8px; padding: 18px; border-radius: 18px; background: var(--s1); box-shadow: inset 0 0 0 1px var(--ln); max-width: 75ch; }}
.pick h2 {{ font-size: 24px; color: var(--teal); }}
@media (max-width: 720px) {{ .panes {{ grid-template-columns: 1fr; }} }}
@media (max-width: 400px) {{ .app {{ width: 96px; height: 96px; }} .lock b {{ font-size: 24px; }} }}
</style>
<main>
  <header class="intro">
    <h1>FRC Packs brand marks</h1>
    <p>Five directions for the mark, each from the game's own world: packs, the single-seam rip, the constellation pack art, and Mythic teal as the payoff. None borrows from FIRST's marks. Each is shown as an app icon, at favicon sizes (32 and 16 px, bare and on the tile) and in the wordmark lockup, on the game's navy and on white.</p>
  </header>
  {"".join(rows)}
  <section class="pick">
    <h2>My pick: Seam</h2>
    <p>It is the only one that could only be FRC Packs: the one clean tear and the light coming out of the top are exactly what happens when you open a pack in the app. It stays a clear shape at 16 px (a block with a bright line and a lifted lid), it works in one colour, and it animates naturally: the lid can lift as a pack opens, or as a loading state. Runner-up: Spark Card, the simplest and the most legible, but it could belong to many card games.</p>
  </section>
</main>
"""
(here / "sheet.html").write_text(sheet, encoding="utf-8")
print("wrote", len(MARKS), "marks and sheet.html")
