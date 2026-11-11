#!/usr/bin/env python3
"""Fetch the Battler stats for every team in a pack from Statbotics and write data/battler-<season>.txt.

Follows the Battler spec (§4, FRC_Card_Game_Implementation_Spec.md): season-specific team_year records, and

    Auto = round(N * A / T)    Tele = round(N * P / T)    End = round(N * E / T)

where N is the team's normalized season EPA on the card scale, T its total season EPA, and A, P, E its season Auto,
Teleop and Endgame EPA (same units as T).

The card scale: Statbotics' normalized EPA (epa.norm) is on a scale where 1500 is an average team and 2026's best is
about 2000, so used as-is the stats would be about ten times the card scale (the spec's top robot is 30/72/18, about
120 in all). It's mapped linearly: N = (norm - NORM_ZERO) * NORM_SCALE. Those two constants are a least-squares fit of
the 2026 Champs teams' normalized EPA to a third of their total EPA (the card scale the game is balanced for), so 4414,
2026's best, is about 120, and the weakest Champs teams (norm about 1500) about 11. RP1, RP2, RP3 are the season's three bonus RPs as percents (2026: Energized, Supercharged,
Traversal; 2025: Auto, Coral, Barge), clamped to 0..100.

Field paths, from Statbotics' TeamYear.to_dict (backend/src/db/models/team_year.py and backend/src/breakdown.py):
epa.norm (N), epa.total_points (T), epa.breakdown.auto_points / teleop_points / endgame_points (A, P, E) and
epa.breakdown.rp_1 / rp_2 / rp_3 (fractions, 0.42 = 42%). In 2026 almost no team earned the Traversal RP (rp_3 is
about -0.34 for nearly everyone), so RP3 is 0% on nearly every card: that's the real number. A team missing any of
these is left out (it plays with placeholder stats) rather than given made-up numbers; every raw record is kept in
data/battler-<season>-raw.json, which is also the cache: a team already in it isn't fetched again.

The teams are the Champs roster in data/cmp-2026.txt (tools/champs_roster.py).

Run: python3 tools/battler_stats.py            (fetches teams missing from the raw cache, then writes every team)
     python3 tools/battler_stats.py --refresh  (fetches everyone again)
Then rerun tools/champs_roster.py (season ranks) and tools/build_packs.py to put the stats on the cards.
"""
import json, math, pathlib, sys, time, urllib.error, urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
data = root / "data"
SEASON = 2026
OUT = data / f"battler-{SEASON}.txt"
RAW = data / f"battler-{SEASON}-raw.json"
API = "https://api.statbotics.io/v3"
TOLERANCE = 0.05  # warn when A + P + E is more than 5% away from T
# The card scale (see the top of this file): N = (norm - NORM_ZERO) * NORM_SCALE.
NORM_ZERO, NORM_SCALE = 1450.0, 0.22
HEADER = (f"# Battler stats, {SEASON} season. Source: Statbotics API v3 team_year, normalized EPA mapped onto the card\n"
          f"# scale as (norm - {NORM_ZERO:g}) * {NORM_SCALE:g}, split by each team's Auto / Teleop / Endgame EPA,\n"
          "# then balanced: rarities closer together (tools/battler_stats.py).\n"
          "# team|auto|tele|end|rp1 %|rp2 %|rp3 %\n")

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "frc-packs battler_stats"})
    for wait in (2, 4, 8, 0):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if not wait:
                raise
            print(f"  {url}: {e}, retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
        except (urllib.error.URLError, TimeoutError) as e:
            if not wait:
                raise
            print(f"  {url}: {e}, retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)

def jsround(x):
    """Rounds halves up, like JavaScript Math.round (Python round() rounds halves to even)."""
    return math.floor(x + 0.5)

def num(x):
    return x if isinstance(x, (int, float)) and math.isfinite(x) else None

def stats(team, ty):
    """The card's stats from one team_year record, or (None, why) if a needed value is missing."""
    epa = (ty or {}).get("epa") or {}
    bd = epa.get("breakdown") or {}
    norm, t = num(epa.get("norm")), num(epa.get("total_points"))
    n = None if norm is None else max(0.0, (norm - NORM_ZERO) * NORM_SCALE)
    a, p, e = num(bd.get("auto_points")), num(bd.get("teleop_points")), num(bd.get("endgame_points"))
    rps = [num(bd.get(k)) for k in ("rp_1", "rp_2", "rp_3")]
    if n is None or not t or None in (a, p, e) or None in rps:
        return None, "missing normalized EPA, total EPA, a phase EPA or an RP"
    if abs((a + p + e) - t) > TOLERANCE * abs(t):
        print(f"  {team}: auto+teleop+endgame = {a + p + e:.1f} but total = {t:.1f}", file=sys.stderr)
    # Phases keep their sign (the game floors a robot's final phase score at zero, not the card stat).
    phases = [jsround(n * x / t) for x in (a, p, e)]
    rp = [max(0, min(100, jsround(r * 100))) for r in rps]
    # Statbotics' RP numbers are each team's share of the expected RP, not chances, so RP2 can come out above RP1. In
    # 2026 Supercharged (RP2) takes the fuel Energized (RP1) needs and more, so it's never likelier: cap it there.
    if SEASON == 2026:
        rp[1] = min(rp[1], rp[0])
    return phases + rp, None

# ---------- balance (0.14) ----------
# The Statbotics numbers above are the real ones; the cards use them after one balance step, so the Battler plays well:
# - Rarities are closer together: each robot's total (Auto + Tele + End) is lifted on a curve that keeps the very best
#   where it was (total' = top * (total / top) ^ CURVE), and its three phases keep their shares. In 2026 an average
#   Mythic was 4.6x an average Common; after this it's about 3.3x, and every robot keeps its order.
# - RP chances get the same curve, so a weak robot's small chance isn't next to nothing (RP2 still never above RP1).
# - RP3 (the climb) is Statbotics' rp_3 like the others. In 2026 almost nobody earned the Traversal RP, so it's 0 for
#   nearly every team: that's the real number. (0.14.0 made it from endgame points instead; 0.14.1 went back.)
CURVE = 0.75


def balance(rows):
    """Balances every team's [auto, tele, end, rp1, rp2, rp3] at once (it needs the best total at Champs)."""
    top = max(sum(r[:3]) for r in rows.values()) or 1
    out = {}
    for team, (a, t, e, r1, r2, r3) in rows.items():
        total = a + t + e
        k = (top * (total / top) ** CURVE) / total if total > 0 else 1
        lift = lambda x: max(0, min(100, jsround(100 * (x / 100) ** CURVE)))
        rp1 = lift(r1)
        rp2 = min(rp1, lift(r2))
        rp3 = lift(r3)
        out[team] = [jsround(a * k), jsround(t * k), jsround(e * k), rp1, rp2, rp3]
    return out


def main():
    teams = [int(l.split("|")[0]) for l in (data / f"cmp-{SEASON}.txt").read_text(encoding="utf-8").splitlines() if l[:1].isdigit()]
    raw = {}
    if RAW.exists() and "--refresh" not in sys.argv:
        raw = {int(k): v for k, v in json.loads(RAW.read_text(encoding="utf-8")).items()}
    missing = [n for n in teams if n not in raw]
    print(f"{len(teams) - len(missing)} teams cached, {len(missing)} to fetch")
    have = {}
    try:
        for i, team in enumerate(missing):
            raw[team] = get(f"{API}/team_year/{team}/{SEASON}")
            if i % 25 == 24:
                print(f"  {i + 1} of {len(missing)}")
            time.sleep(0.2)  # Statbotics asks people to be nice to its servers
    finally:
        # Saves what was fetched even if the API falls over partway, so the next run picks up from there.
        for team in teams:
            if team not in raw:
                continue
            s, why = stats(team, raw[team])
            if s:
                have[team] = s
            else:
                print(f"  {team}: no stats ({why})", file=sys.stderr)
        have = {team: "|".join(str(x) for x in [team] + s) for team, s in balance(have).items()} if have else {}
        OUT.write_text(HEADER + "".join(have[n] + "\n" for n in teams if n in have), encoding="utf-8", newline="\n")
        RAW.write_text(json.dumps({str(k): raw[k] for k in teams if k in raw}, separators=(",", ":")), encoding="utf-8", newline="\n")
        print("wrote", OUT.relative_to(root), len(have), "teams")

if __name__ == "__main__":
    if "--test" in sys.argv:
        # The spec's worked example: N=120 on the card scale, T=60, A=15, P=36, E=9 gives 30/72/18.
        ex = {"epa": {"norm": NORM_ZERO + 120 / NORM_SCALE, "total_points": 60, "breakdown": {"auto_points": 15, "teleop_points": 36, "endgame_points": 9, "rp_1": .42, "rp_2": 1.3, "rp_3": -.1}}}
        assert stats(0, ex) == ([30, 72, 18, 42, 42, 0], None), stats(0, ex)  # RP2 capped at RP1 (2026)
        # The best robot keeps its total; a weaker one is lifted; RP3 stays Statbotics' own.
        b2 = balance({1: [30, 72, 18, 42, 42, 0], 2: [5, 10, 5, 9, 0, 0]})
        assert sum(b2[1][:3]) == 120 and b2[1][5] == 0, b2
        assert sum(b2[2][:3]) > 20 and b2[2][3] > 9 and b2[2][5] == 0, b2
        assert jsround(2.5) == 3 and jsround(-2.5) == -2
        assert stats(0, {"epa": {"norm": 1800, "total_points": 0, "breakdown": {}}})[0] is None
        # 2026's best (norm 1997) is about 120 on the card scale; an average team (1500) about 11.
        assert 118 <= (1997 - NORM_ZERO) * NORM_SCALE <= 122 and 10 <= (1500 - NORM_ZERO) * NORM_SCALE <= 12
        print("ok")
    else:
        main()
