"""
Download the secondary-node Wikimedia Commons images listed in
data/secondary-images.json into img/<node_id>.<ext>. Updates each entry
with `local_url` and `local_size` so app.js can prefer the local copy.

Uses commons.wikimedia.org/wiki/Special:FilePath?width=N to sidestep
Wikimedia's "robot policy" 429s on arbitrary thumbnail sizes.
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR = os.path.join(ROOT, "img")
SECONDARY_JSON = os.path.join(ROOT, "data", "secondary-images.json")
WIDTH = 1280


def extract_filename(url: str) -> str | None:
    if not url:
        return None
    m = re.search(r"/commons/thumb/[0-9a-f]/[0-9a-f]{2}/([^/]+?)/\d+px-", url)
    if m:
        return m.group(1)
    m = re.search(r"/commons/[0-9a-f]/[0-9a-f]{2}/([^/?#]+)$", url)
    if m:
        return m.group(1)
    return None


def download(url: str, outpath: str) -> int:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "ArtMap-Edu/0.4 (educational; contact via xtec.gencat.cat)",
            "Accept": "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        data = resp.read()
    with open(outpath, "wb") as out:
        out.write(data)
    return len(data)


def main() -> int:
    with open(SECONDARY_JSON, encoding="utf-8") as f:
        data = json.load(f)

    ok, failed, skipped = 0, [], 0

    for entry in data["images"]:
        node_id = entry["node_id"]
        url = entry.get("image_url")

        if not url:
            skipped += 1
            continue

        filename = extract_filename(url)
        if not filename:
            failed.append((node_id, "no filename extractable from URL"))
            continue

        # Extension
        m = re.search(r"\.([A-Za-z0-9]+)$", filename)
        ext = (m.group(1).lower() if m else "jpg")
        if ext in ("jpeg", "jpe"):
            ext = "jpg"

        outpath = os.path.join(IMG_DIR, f"{node_id}.{ext}")
        stable_url = f"https://commons.wikimedia.org/wiki/Special:FilePath/{filename}?width={WIDTH}"

        try:
            size = download(stable_url, outpath)
            entry["local_url"] = f"img/{node_id}.{ext}"
            entry["local_size"] = size

            # If image_missing is True but we have an image (contextual fallback
            # like Sherman's exhibition photo, Dalí's Cap de Creus landscape),
            # promote the agent's notes to image_caveat so the UI shows it.
            if entry.get("image_missing") and entry.get("notes"):
                entry.setdefault("image_caveat", entry["notes"])
                entry.setdefault(
                    "image_strategy",
                    "Imatge contextual (no l'original)."
                )

            ok += 1
            print(f"  OK   {node_id:<40} {size // 1024} KB")
            time.sleep(0.5)
        except urllib.error.HTTPError as e:
            failed.append((node_id, f"HTTP {e.code}"))
            print(f"  FAIL {node_id:<40} HTTP {e.code}")
        except Exception as e:
            failed.append((node_id, f"{type(e).__name__}: {e}"))
            print(f"  FAIL {node_id:<40} {type(e).__name__}: {e}")

    data["meta"]["local_downloaded"] = ok
    data["meta"]["local_failed"] = len(failed)
    data["meta"]["local_updated"] = "2026-04-19"

    with open(SECONDARY_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print()
    print(f"Downloaded: {ok}")
    print(f"Skipped (no URL): {skipped}")
    print(f"Failed: {len(failed)}")
    if failed:
        for nid, err in failed:
            print(f"  - {nid}: {err}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
