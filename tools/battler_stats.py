#!/usr/bin/env python3
"""Fetch the Battler stats for every team in a pack from Statbotics and write data/battler-<season>.txt.

Follows the Battler spec (§4, FRC_Card_Game_Implementation_Spec.md): season-specific team_year records, and

    Auto = round(N * A / T)    Tele = round(N * P / T)    End = round(N * E / T)

where N is the team's normalized season EPA, T its total season EPA, and A, P, E its season Auto, Teleop and Endgame
EPA (same units as T). RP1, RP2, RP3 are the season's three bonus RPs as percents (2026: Energized, Supercharged,
Traversal; 2025: Auto, Coral, Barge), clamped to 0..100.

Field paths, from Statbotics' TeamYear.to_dict (backend/src/db/models/team_year.py and backend/src/breakdown.py):
epa.norm (N), epa.total_points (T), epa.breakdown.auto_points / teleop_points / endgame_points (A, P, E) and
epa.breakdown.rp_1 / rp_2 / rp_3 (fractions, 0.42 = 42%). A team missing any of these is left out (its card shows no
stats) rather than given made-up numbers; the raw values are kept in data/battler-<season>-raw.json for audits.

Run: python3 tools/battler_stats.py            (only fetches teams missing from the output file)
     python3 tools/battler_stats.py --refresh  (fetches everyone again)
Then rerun tools/build_packs.py to put the stats on the cards.
"""
import json, math, pathlib, sys, time, urllib.error, urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
data = root / "data"
SEASON = 2026
OUT = data / f"battler-{SEASON}.txt"
RAW = data / f"battler-{SEASON}-raw.json"
API = "https://api.statbotics.io/v3"
TOLERANCE = 0.05  # warn when A + P + E is more than 5% away from T
HEADER = (f"# Battler stats, {SEASON} season. Source: Statbotics API v3 team_year (see tools/battler_stats.py).\n"
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
    n, t = num(epa.get("norm")), num(epa.get("total_points"))
    a, p, e = num(bd.get("auto_points")), num(bd.get("teleop_points")), num(bd.get("endgame_points"))
    rps = [num(bd.get(k)) for k in ("rp_1", "rp_2", "rp_3")]
    if n is None or not t or None in (a, p, e) or None in rps:
        return None, "missing normalized EPA, total EPA, a phase EPA or an RP"
    if abs((a + p + e) - t) > TOLERANCE * abs(t):
        print(f"  {team}: auto+teleop+endgame = {a + p + e:.1f} but total = {t:.1f}", file=sys.stderr)
    # Phases keep their sign (the game floors a robot's final phase score at zero, not the card stat).
    phases = [jsround(n * x / t) for x in (a, p, e)]
    return phases + [max(0, min(100, jsround(r * 100))) for r in rps], None

def main():
    teams = [t["num"] for t in json.loads((data / "packs" / "cmp26.json").read_text(encoding="utf-8"))["teams"]]
    have, raw = {}, {}
    if "--refresh" not in sys.argv:
        if OUT.exists():
            for line in OUT.read_text(encoding="utf-8").splitlines():
                if line and not line.startswith("#"):
                    have[int(line.split("|")[0])] = line
        if RAW.exists():
            raw = {int(k): v for k, v in json.loads(RAW.read_text(encoding="utf-8")).items()}
    missing = [n for n in teams if n not in have]
    print(f"{len(have)} teams already fetched, {len(missing)} to go")
    try:
        for i, team in enumerate(missing):
            ty = get(f"{API}/team_year/{team}/{SEASON}")
            raw[team] = ty
            s, why = stats(team, ty)
            if s:
                have[team] = "|".join(str(x) for x in [team] + s)
            else:
                print(f"  {team}: no stats ({why})", file=sys.stderr)
            if i % 25 == 24:
                print(f"  {i + 1} of {len(missing)}")
            time.sleep(0.2)  # Statbotics asks people to be nice to its servers
    finally:
        # Saves what was fetched even if the API falls over partway, so the next run picks up from there.
        OUT.write_text(HEADER + "".join(have[n] + "\n" for n in teams if n in have), encoding="utf-8", newline="\n")
        RAW.write_text(json.dumps({str(k): raw[k] for k in teams if k in raw}, separators=(",", ":")), encoding="utf-8", newline="\n")
        print("wrote", OUT.relative_to(root), len(have), "teams")

if __name__ == "__main__":
    if "--test" in sys.argv:
        # The spec's worked example: N=120, T=60, A=15, P=36, E=9 gives 30/72/18.
        ex = {"epa": {"norm": 120, "total_points": 60, "breakdown": {"auto_points": 15, "teleop_points": 36, "endgame_points": 9, "rp_1": .42, "rp_2": 1.3, "rp_3": -.1}}}
        assert stats(0, ex) == ([30, 72, 18, 42, 100, 0], None), stats(0, ex)
        assert jsround(2.5) == 3 and jsround(-2.5) == -2
        assert stats(0, {"epa": {"norm": 120, "total_points": 0, "breakdown": {}}})[0] is None
        print("ok")
    else:
        main()
