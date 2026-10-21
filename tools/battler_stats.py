#!/usr/bin/env python3
"""Fetch the 1v1 battler stats for every team in a pack from Statbotics and write data/battler-<season>.txt.

Each card in the battler carries AUTO, TELE and END (points the team adds in each phase) and three RP chances
(RP1, RP2, RP3, named by slot so they work for any game). They come from the team's EPA breakdown at its Championship
division, the same event the pack's EPA comes from. Statbotics' JSON (backend/src/db/models/team_event.py):
epa.breakdown has auto_points, teleop_points, endgame_points and rp_1, rp_2, rp_3 (2025 and later).

An RP value is the team's share of its alliance's chance at that RP (Statbotics adds the three teams' shares), so the
card shows it as a percent, clamped to 0..100.

Run: python3 tools/battler_stats.py            (only fetches teams missing from the output file)
     python3 tools/battler_stats.py --refresh  (fetches everyone again)
Then rerun tools/build_packs.py to put the stats on the cards.
"""
import json, pathlib, sys, time, urllib.error, urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
data = root / "data"
SEASON = 2026
OUT = data / f"battler-{SEASON}.txt"
API = "https://api.statbotics.io/v3"
HEADER = ("# 1v1 battler stats, " + str(SEASON) + " Championship divisions. Source: Statbotics API v3 team_events.\n"
          "# team|auto|tele|end|rp1 %|rp2 %|rp3 %|event\n")

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "frc-packs battler_stats"})
    for wait in (2, 4, 8, 0):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError) as e:
            if not wait:
                raise
            print(f"  {url}: {e}, retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)

def champs_event(events):
    """The team's Championship division (not Einstein, which is a handful of matches)."""
    divs = [e for e in events if e.get("type") == "champs_div"] or [e for e in events if "Division" in (e.get("event_name") or "")]
    return max(divs, key=lambda e: e.get("time") or 0) if divs else None

def stats(num):
    ev = champs_event(get(f"{API}/team_events?team={num}&year={SEASON}"))
    if not ev:
        return None
    bd = ev["epa"]["breakdown"]
    pct = lambda k: max(0, min(100, round((bd.get(k) or 0) * 100)))
    pts = lambda k: max(0, round(bd.get(k) or 0))
    return [pts("auto_points"), pts("teleop_points"), pts("endgame_points"), pct("rp_1"), pct("rp_2"), pct("rp_3"), ev["event"]]

def main():
    teams = [t["num"] for t in json.loads((data / "packs" / "cmp26.json").read_text(encoding="utf-8"))["teams"]]
    have = {}
    if OUT.exists() and "--refresh" not in sys.argv:
        for line in OUT.read_text(encoding="utf-8").splitlines():
            if line and not line.startswith("#"):
                have[int(line.split("|")[0])] = line
    missing = [n for n in teams if n not in have]
    print(f"{len(have)} teams already fetched, {len(missing)} to go")
    try:
        for i, num in enumerate(missing):
            s = stats(num)
            if s:
                have[num] = "|".join(str(x) for x in [num] + s)
            else:
                print(f"  {num}: no Championship division event", file=sys.stderr)
            if i % 25 == 24:
                print(f"  {i + 1} of {len(missing)}")
            time.sleep(0.2)  # Statbotics asks people to be nice to its servers
    finally:
        # Saves what was fetched even if the API falls over partway, so the next run picks up from there.
        OUT.write_text(HEADER + "".join(have[n] + "\n" for n in teams if n in have), encoding="utf-8", newline="\n")
        print("wrote", OUT.relative_to(root), len(have), "teams")

if __name__ == "__main__":
    main()
