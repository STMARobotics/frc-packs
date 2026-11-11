"""Robot photos and team avatars from The Blue Alliance, for every team on the Championship roster (data/cmp-2026.txt).

Photos: the team's 2026 robot picture (the one they marked preferred, else the first image), cut to 4:3 and saved as
data/photos/<team>.webp (240 x 180, like the rest). A photo from an earlier season is removed: a card shows the robot
from its own year or the drawing. data/photos.txt records where each one came from.
Avatars: the 40 x 40 team avatar TBA keeps for 2026, saved as data/photos/avatars/<team>.png (teams without one get
none, and the card shows the team number in the ring as before).

Needs a read key from thebluealliance.com/account in the TBA_KEY environment variable (never in a file):
  TBA_KEY=... python tools/tba_media.py            (only teams without a 2026 photo or avatar yet)
  TBA_KEY=... python tools/tba_media.py --all      (everyone again)
Then run tools/photo_focus.py (centers each card on its robot) and tools/build_packs.py (marks who has a photo).
"""
import base64
import io
import json
import os
import pathlib
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PHOTOS = DATA / "photos"
AVATARS = PHOTOS / "avatars"
SOURCES = DATA / "photos.txt"
YEAR = 2026
API = "https://www.thebluealliance.com/api/v3"
SIZE = (240, 180)
IMAGE_TYPES = ("imgur", "cdphotothread", "instagram-image", "onshape", "external-link")
UA = "frc-packs media tool"


def roster():
    teams = []
    for line in (DATA / "cmp-2026.txt").read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#"):
            teams.append(int(line.split("|")[0]))
    return teams


def sources():
    out = {}
    if SOURCES.exists():
        for line in SOURCES.read_text(encoding="utf-8").splitlines():
            if line and not line.startswith("#"):
                t, season, url = line.split("|", 2)
                out[int(t)] = (int(season), url)
    return out


def get(url, key=None, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, **({"X-TBA-Auth-Key": key} if key else {})})
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.read()
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(1.5 * (i + 1))


def cut(raw):
    """A 4:3 crop from the middle, at 240 x 180."""
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = im.size
    if w / h > 4 / 3:
        nw = int(h * 4 / 3)
        im = im.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    else:
        nh = int(w * 3 / 4)
        im = im.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    return im.resize(SIZE, Image.LANCZOS)


def urls(m):
    """Where a media item's picture can be downloaded from, best first. Instagram photos often come with no direct
    link (feedback #120, and team 5913 in #100): TBA's saved thumbnail, then Instagram's own link to the picture."""
    out = [m.get("direct_url")]
    if m.get("type") == "instagram-image":
        out.append((m.get("details") or {}).get("thumbnail_url"))
        if m.get("foreign_key"):
            out.append(f"https://www.instagram.com/p/{m['foreign_key']}/media/?size=l")
    return [u for u in out if u]


def media(team, key):
    items = json.loads(get(f"{API}/team/frc{team}/media/{YEAR}", key))
    avatar = next((m for m in items if m.get("type") == "avatar" and (m.get("details") or {}).get("base64Image")), None)
    pics = [m for m in items if m.get("type") in IMAGE_TYPES and urls(m)]
    pics.sort(key=lambda m: (not m.get("preferred"), IMAGE_TYPES.index(m["type"])))
    return pics, avatar


def one(team, key, redo, have):
    """Returns (team, photo url or None, kept old photo, avatar saved)."""
    photo_path, av_path = PHOTOS / f"{team}.webp", AVATARS / f"{team}.png"
    need_photo = redo or have.get(team, (0, ""))[0] != YEAR or not photo_path.exists()
    need_av = redo or not av_path.exists()
    if not need_photo and not need_av:
        return team, have[team][1], True, av_path.exists()
    try:
        pics, avatar = media(team, key)
    except Exception as e:
        print(f"{team}: couldn't read its media ({e})", file=sys.stderr)
        return team, have.get(team, (0, None))[1] if have.get(team, (0,))[0] == YEAR else None, True, av_path.exists()
    if need_av and avatar:
        AVATARS.mkdir(parents=True, exist_ok=True)
        av_path.write_bytes(base64.b64decode(avatar["details"]["base64Image"]))
    url = have[team][1] if not need_photo else None
    if need_photo:
        for u in (u for m in pics for u in urls(m)):
            try:
                cut(get(u)).save(photo_path, "WEBP", quality=82, method=6)
                url = u
                break
            except Exception as e:
                print(f"{team}: skipped {u} ({e})", file=sys.stderr)
        if url is None and photo_path.exists():
            photo_path.unlink()  # an earlier season's robot: the drawing is truer than the wrong robot
    return team, url, not need_photo, av_path.exists()


def main():
    key = os.environ.get("TBA_KEY", "").strip()
    if not key:
        sys.exit("Set TBA_KEY to a read key from thebluealliance.com/account.")
    redo = "--all" in sys.argv
    teams, have = roster(), sources()
    with ThreadPoolExecutor(8) as ex:
        rows = list(ex.map(lambda t: one(t, key, redo, have), teams))
    # Photos of teams no longer on the roster stay where they are (other packs may use them); their lines too.
    keep = {t: v for t, v in have.items() if t not in set(teams)}
    for team, url, _, _ in rows:
        if url:
            keep[team] = (YEAR, url)
    lines = ["# Robot photos from The Blue Alliance (team media). team|season|source image"]
    lines += [f"{t}|{s}|{u}" for t, (s, u) in sorted(keep.items())]
    SOURCES.write_text("\n".join(lines) + "\n", encoding="utf-8")
    photos = sum(1 for r in rows if r[1])
    avatars = sum(1 for r in rows if r[3])
    print(f"{len(teams)} teams: {photos} with a {YEAR} photo, {len(teams) - photos} without; {avatars} avatars")


if __name__ == "__main__":
    main()
