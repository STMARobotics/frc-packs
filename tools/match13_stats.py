#!/usr/bin/env python3
"""Cache the Match13 team-season card ratings once. Run manually, then run build_packs.py."""
import argparse
import json
import math
import os
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DATA = Path(__file__).resolve().parents[1] / "data"
SEASON = 2026
API = "https://actions.match13.com/v1"
FIELDS = ("xAuto", "xTele", "xEnd", "dpr", "xRp1", "xRp2", "xRp3")


def get(path, key, *, allow_missing=False):
    request = Request(f"{API}/{path}", headers={
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "User-Agent": "frc-packs one-time stats import",
    })
    for attempt in range(4):
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code == 404 and allow_missing:
                return None
            if error.code not in (429, 500, 502, 503, 504) or attempt == 3:
                raise RuntimeError(f"Match13 returned HTTP {error.code} for {path}") from None
            retry_after = error.headers.get("Retry-After", "")
            delay = int(retry_after) if retry_after.isdecimal() else 2 ** attempt
            if delay > 60:
                raise RuntimeError(f"Match13 requested a {delay}s retry delay. Run the import again later.") from None
            time.sleep(delay)
        except (URLError, TimeoutError):
            if attempt == 3:
                raise RuntimeError(f"Could not reach Match13 for {path}") from None
            time.sleep(2 ** attempt)


def ratings(row):
    values = {field: row[field] for field in FIELDS}
    for field, value in values.items():
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value)):
            raise ValueError(f"Unexpected {field} for team {row['teamNumber']}")
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key-file", type=Path, help="Local file containing the Match13 key. Defaults to MATCH13_API_KEY.")
    parser.add_argument("--data-dir", type=Path, default=DATA, help="Directory containing cmp-2026.txt")
    args = parser.parse_args()
    output = args.data_dir / f"match13-{SEASON}.json"
    if output.exists():
        print(f"Using existing snapshot: {output}")
        return
    key = args.key_file.read_text(encoding="utf-8-sig").strip() if args.key_file else os.environ.get("MATCH13_API_KEY", "").strip()
    if not key:
        parser.error("Set MATCH13_API_KEY or pass --key-file. The key is never written to the snapshot.")
    roster = (args.data_dir / f"cmp-{SEASON}.txt").read_text(encoding="utf-8")
    wanted = {int(line.split("|", 1)[0]) for line in roster.splitlines() if line[:1].isdigit()}
    if not wanted:
        raise ValueError("The roster is empty.")
    found = {}
    page = 1
    while page is not None and wanted - found.keys():
        data = get(f"years/{SEASON}/teams?page={page}&limit=1000", key)
        for row in data["teams"]:
            team = row["teamNumber"]
            if team in wanted:
                found[team] = ratings(row)
        next_page = data["nextPage"]
        if next_page is not None and (type(next_page) is not int or next_page <= page):
            raise ValueError("Unexpected Match13 pagination")
        page = next_page

    for team in sorted(wanted - found.keys()):
        row = get(f"teams/{team}/years/{SEASON}", key, allow_missing=True)
        if row is not None and row["teamNumber"] != team:
            raise ValueError(f"Match13 returned the wrong team for {team}")
        found[team] = ratings(row) if row is not None else dict.fromkeys(FIELDS)

    missing = {field: sum(row[field] is None for row in found.values()) for field in FIELDS}
    snapshot = {"season": SEASON, "teams": {team: found[team] for team in sorted(found)}}
    temp = output.with_suffix(".tmp")
    temp.write_text(json.dumps(snapshot, indent=1, allow_nan=False) + "\n", encoding="utf-8", newline="\n")
    temp.replace(output)
    print(f"Wrote {len(found)} teams to {output}")
    print("Unavailable values:", missing)


if __name__ == "__main__":
    main()
