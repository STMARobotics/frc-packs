#!/usr/bin/env python3
"""Fetch the 2026 FIRST Championship (Houston) rosters from Statbotics and write data/cmp-2026.txt.

Every team in the eight divisions (Archimedes, Curie, Daly, Galileo, Hopper, Johnson, Milstein, Newton), with its
Champs EPA (the division's total EPA), qualification record, division, 2026 season EPA rank and location. The season
rank comes from data/battler-2026-raw.json (tools/battler_stats.py's cache of each team's 2026 Statbotics record), so
run this, then battler_stats.py, then this again to fill the ranks in, then build_packs.py.

Run: python3 tools/champs_roster.py
"""
import json, pathlib, sys, time, urllib.error, urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
data = root / "data"
OUT = data / "cmp-2026.txt"
RAW = data / "battler-2026-raw.json"
API = "https://api.statbotics.io/v3"
DIVISIONS = {"2026arc": "Archimedes", "2026cur": "Curie", "2026dal": "Daly", "2026gal": "Galileo",
             "2026hop": "Hopper", "2026joh": "Johnson", "2026mil": "Milstein", "2026new": "Newton"}

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "frc-packs champs_roster"})
    for wait in (2, 4, 8, 0):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError) as e:
            if not wait:
                raise
            print(f"  {url}: {e}, retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)

def where(ty):
    """Where the team is from, from its own 2026 record (a division's team_events give the event's state, Texas, not
    the team's): two-letter state or province for the USA and Canada, else the country; "-" if not fetched yet."""
    if not ty:
        return "-"
    if ty.get("country") in ("USA", "Canada") and ty.get("state"):
        return ty["state"]
    return ty.get("country") or "-"

def tidy(name):
    """Statbotics names can carry runs of spaces; one space each."""
    return " ".join(name.split()).replace("|", "/")

def main():
    raw = json.loads(RAW.read_text(encoding="utf-8")) if RAW.exists() else {}
    # Names already on cards stay as they are (some were tidied by hand); new teams get Statbotics' name, tidied.
    names = {}
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8").splitlines():
            p = line.split("|")
            if p[0].isdigit() and len(p) > 1:
                names[int(p[0])] = p[1]
    rows = []
    for key, div in DIVISIONS.items():
        teams = get(f"{API}/team_events?event={key}&limit=200") or []
        print(f"{div}: {len(teams)} teams")
        for te in teams:
            epa = (te.get("epa") or {}).get("total_points")
            q = (te.get("record") or {}).get("qual") or {}
            wl = f"{q['wins']}-{q['losses']}" if q.get("count") else "-"
            ty = raw.get(str(te["team"])) or {}
            rank = (((ty.get("epa") or {}).get("ranks") or {}).get("total") or {}).get("rank")
            name = names.get(te["team"]) or tidy(te.get("team_name") or str(te["team"]))
            rows.append((te["team"], name, f"{epa:.2f}" if isinstance(epa, (int, float)) else "-", wl, div,
                         str(rank) if rank else "-", where(ty)))
        time.sleep(0.3)
    rows.sort(key=lambda r: (r[4], r[0]))
    header = ("# 2026 FIRST Championship (Houston), 8 divisions. Source: Statbotics API v3 team_events (tools/champs_roster.py).\n"
              "# team|name|champs EPA|champs qual W-L|division|2026 season EPA rank (- if not fetched yet)|location (- if unknown)\n")
    OUT.write_text(header + "".join("|".join(str(x) for x in r) + "\n" for r in rows), encoding="utf-8", newline="\n")
    print("wrote", OUT.relative_to(root), len(rows), "teams")

if __name__ == "__main__":
    main()
