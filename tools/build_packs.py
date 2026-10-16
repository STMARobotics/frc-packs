#!/usr/bin/env python3
"""Build pack recipes (data/packs/<id>.json) from the source rosters in data/.

A recipe is everything the server and the site need to know about a pack: its name, its odds and pity rules,
and every team in it with that team's rarity. Adding a pack means adding an entry to PACKS and rerunning this.

Run: python3 tools/build_packs.py
"""
import json, math, pathlib, re

root = pathlib.Path(__file__).resolve().parent.parent
data = root / "data"

CA_PROV = {"ON", "QC", "AB", "BC", "MB", "SK", "NS", "NB"}

def place(loc):
    if re.fullmatch(r"[A-Z]{2}", loc):
        return loc + (", Canada" if loc in CA_PROV else ", USA")
    return loc

def champs_teams(path):
    """team|name|champs EPA|champs W-L|division|season EPA rank|location, one line per team."""
    teams, seen = [], set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        p = line.split("|")
        if len(p) < 7:
            continue
        num = int(p[0]) if p[0].isdigit() else 0
        if not num or num in seen:
            continue
        seen.add(num)
        try:
            epa = float(p[2])
            epa = epa if math.isfinite(epa) else None
        except ValueError:
            epa = None
        srank = int(p[5]) if p[5].isdigit() else 0
        teams.append({
            "num": num, "name": p[1], "epa": epa,
            "wl": p[3] if re.fullmatch(r"\d+-\d+", p[3]) else "–",
            "div": p[4], "srank": srank, "loc": "" if p[6] == "-" else place(p[6]),
            # Robot photo at /photos/<num>.webp (from The Blue Alliance); teams without one get a drawing.
            "photo": (data / "photos" / f"{num}.webp").exists(),
        })
    # Rarity: the season's top 50 who came were Mythic at launch; everyone else is ranked by EPA at the event. Since
    # October 2026 only the teams in MYTHICS are Mythic: other former Mythics are Legendary, and the rest keep their tier.
    teams.sort(key=lambda t: (-(t["epa"] if t["epa"] is not None else -1), t["num"]))
    below = 0
    for i, t in enumerate(teams):
        t["rank"] = i + 1
        if t["srank"] and t["srank"] <= 50:
            t["tier"] = "mythic"
        else:
            below += 1
            t["tier"] = "legendary" if below <= 50 else "rare" if below <= 170 else "uncommon" if below <= 320 else "common"
    for t in teams:
        if t["num"] in MYTHICS:
            t["tier"] = "mythic"
        elif t["tier"] == "mythic":
            t["tier"] = "legendary"
    return teams

# The only Mythic teams (chosen by hand, October 2026). Changing this changes cards people already own: the server
# re-tiers them (server/src/retier.rs), so bump its VERSION too.
MYTHICS = {4414, 254, 2910, 1690, 1678, 1323, 4946, 2491, 2056, 1114, 125, 27}

ODDS = {
    # Slots 1 to 4, per card. The last slot is always Rare or better.
    "slots": {"common": 0.705, "uncommon": 0.22, "rare": 0.07, "legendary": 0.005},
    "last": {"rare": 0.93, "legendary": 0.07},
    # Mythic meter: 1 in 400 per pack, climbing after 150 packs without one, guaranteed at 200.
    "mythicBase": 1 / 400, "demoMythic": 0.2, "soft": 150, "hard": 200,
    # Legendary or better at least every 20 packs.
    "legEvery": 20,
    # Boosted packs (crafted from parts): better slots, a better last card, and 4x the Mythic chance.
    "boosted": {"slots": {"common": 0.40, "uncommon": 0.35, "rare": 0.20, "legendary": 0.05},
                "last": {"rare": 0.60, "legendary": 0.40}, "mythicMult": 4.0},
}

PACKS = [
    {
        "id": "cmp26", "name": "2026 Championship", "where": "Houston · 8 divisions", "season": 2026,
        "event": "2026 FIRST Championship (Houston)", "claimable": True, "odds": ODDS,
        "teams": champs_teams(data / "cmp-2026.txt"),
    },
]

out = data / "packs"
out.mkdir(exist_ok=True)
for pack in PACKS:
    path = out / (pack["id"] + ".json")
    path.write_text(json.dumps(pack, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    tiers = {}
    for t in pack["teams"]:
        tiers[t["tier"]] = tiers.get(t["tier"], 0) + 1
    print("wrote", path.relative_to(root), len(pack["teams"]), "teams", tiers)
