"""
Download all non-copyrighted Wikimedia Commons images referenced in data/images.json
to img/ as local files, and update images.json with local_url pointers.

Uses commons.wikimedia.org/wiki/Special:FilePath?width=1280 which handles arbitrary
width requests by redirecting to the nearest pre-generated step — avoids the
'robot policy' 429 rejections that direct upload.wikimedia.org/thumb/ URLs hit.
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error

# Windows cp1252 stdout can't print the Unicode arrow/ellipsis used below.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR = os.path.join(ROOT, "img")
IMAGES_JSON = os.path.join(ROOT, "data", "images.json")
WIDTH = 1280  # single size: good for fullscreen (up to ~1800px viewport) and node display (browser scales down)

os.makedirs(IMG_DIR, exist_ok=True)


def extract_filename(url: str) -> str | None:
    """Extract the URL-encoded filename from any Wikimedia Commons URL."""
    m = re.search(r"/commons/thumb/[0-9a-f]/[0-9a-f]{2}/([^/]+?)/\d+px-", url)
    if m:
        return m.group(1)
    m = re.search(r"/commons/[0-9a-f]/[0-9a-f]{2}/([^/?#]+)$", url)
    if m:
        return m.group(1)
    return None


def extension_from_filename(filename: str) -> str:
    m = re.search(r"\.([A-Za-z0-9]+)$", filename)
    ext = (m.group(1).lower() if m else "jpg")
    if ext in ("jpeg", "jpe"):
        ext = "jpg"
    return ext


def download(url: str, outpath: str) -> int:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "ArtMap-Edu/0.2 (educational tool; contact via https://xtec.gencat.cat/)",
            "Accept": "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8",
            "Accept-Language": "ca,es;q=0.8,en;q=0.5",
        },
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        data = resp.read()
    with open(outpath, "wb") as out:
        out.write(data)
    return len(data)


def main() -> int:
    with open(IMAGES_JSON, encoding="utf-8") as f:
        data = json.load(f)

    ok_count = 0
    fail_count = 0
    skipped = 0

    for work in data["works"]:
        n = work["canonicalIndex"]
        title = work["title"]
        short = (title[:45] + "…") if len(title) > 46 else title

        if work.get("image_missing"):
            skipped += 1
            print(f"  skip #{n:02d} {short} (copyright)")
            continue

        filename = extract_filename(work.get("image_url") or "")
        if not filename:
            fail_count += 1
            print(f"  FAIL #{n:02d} {short} — no filename in image_url")
            continue

        ext = extension_from_filename(filename)
        outname = f"{n:02d}.{ext}"
        outpath = os.path.join(IMG_DIR, outname)

        url = f"https://commons.wikimedia.org/wiki/Special:FilePath/{filename}?width={WIDTH}"

        try:
            size = download(url, outpath)
            work["local_url"] = f"img/{outname}"
            work["local_size"] = size
            ok_count += 1
            print(f"  OK   #{n:02d} {short} → {outname} ({size // 1024} KB)")
            time.sleep(0.25)  # small delay, be nice to Wikimedia
        except urllib.error.HTTPError as e:
            fail_count += 1
            work["local_url"] = None
            print(f"  FAIL #{n:02d} {short} — HTTP {e.code}")
        except Exception as e:
            fail_count += 1
            work["local_url"] = None
            print(f"  FAIL #{n:02d} {short} — {type(e).__name__}: {e}")

    # Write manifest update
    data["meta"]["local_downloaded"] = ok_count
    data["meta"]["local_failed"] = fail_count
    data["meta"]["local_updated"] = "2026-04-19"
    with open(IMAGES_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print()
    print(f"Downloaded: {ok_count}")
    print(f"Failed:     {fail_count}")
    print(f"Skipped (copyright): {skipped}")
    print(f"Manifest updated: {IMAGES_JSON}")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
