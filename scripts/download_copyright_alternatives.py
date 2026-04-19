"""
Integrate copyright-alternatives.json findings into img/ + images.json.

For each of the 5 copyrighted works:
- Pick a downloadable Wikimedia Commons URL (agent-recommended option or best fallback)
- Download to img/NN.jpg
- Update images.json: local_url, license, credit, and new fields image_strategy + image_caveat
- Clear image_missing flag (since we now have a usable image)

These are NOT reproductions of the copyrighted originals themselves, but:
- Replicas (e.g., ceramic mural of Guernica)
- Installation / gallery photos
- Artist portraits
- Or, for the PD-in-EU Kahlo, the original work is free but no high-res Commons
  file exists — falls back to a related contextual image.

The caveat explains to the student what they're seeing.
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
IMAGES_JSON = os.path.join(ROOT, "data", "images.json")

# Selected strategy per work (human-curated from agent's options).
# Each entry must have a DIRECT Wikimedia Commons URL.
SELECTIONS = {
    50: {
        "url": "https://upload.wikimedia.org/wikipedia/commons/2/26/Guernica_Gernikara.JPG",
        "license": "CC BY 3.0",
        "credit": "Joaquin, via Wikimedia Commons",
        "strategy": "Fotografia del mural ceramic de Gernika (1997, Josep Mari Ximenez i germans Royo) que reprodueix el Guernica.",
        "caveat": "No es l'oli original de Picasso (que es al Museu Reina Sofia i continua protegit per drets d'autor fins al 2044). L'imatge mostra el mural ceramic al poble de Gernika, una replica a mida real en ceramica que reprodueix l'obra."
    },
    51: {
        "url": "https://upload.wikimedia.org/wikipedia/commons/3/30/Regarding_Lavender_Mist.jpg",
        "license": "CC BY-SA 4.0",
        "credit": "Ned Hartley, via Wikimedia Commons",
        "strategy": "Fotografia del quadre 'Lavender Mist' exposat a la National Gallery of Art, amb un visitant davant que dona escala.",
        "caveat": "L'obra de Pollock continua protegida per drets d'autor fins al 2027. Aquesta imatge, feta per un visitant a la NGA, mostra el quadre in situ i es pot fer servir en aquest context."
    },
    52: {
        "url": "https://upload.wikimedia.org/wikipedia/commons/2/2f/Frida_Kahlo%2C_by_Guillermo_Kahlo.jpg",
        "license": "Public Domain",
        "credit": "Guillermo Kahlo (1932), via Wikimedia Commons",
        "strategy": "Retrat fotografic de Frida Kahlo pel seu pare Guillermo Kahlo (1932).",
        "caveat": "Nota: l'obra en si mateixa (1954) es de domini public a la UE des de l'1 de gener de 2025. No hi ha, de moment, una imatge lliure d'alta qualitat a Wikimedia Commons. Aquesta fotografia es un retrat de Kahlo, no el quadre. Es pot substituir manualment baixant una reproduccio del quadre (ara PD) i posant-la a img/52.jpg."
    },
    54: {
        "url": "https://upload.wikimedia.org/wikipedia/commons/e/e5/Marina_Abramovi%C4%87_The_Artist_Is_Present_%284616780675%29.jpg",
        "license": "CC BY 2.0",
        "credit": "Antonio Zugaldia (Flickr), via Wikimedia Commons",
        "strategy": "Fotografia del performance 'The Artist Is Present' al MoMA (2010), amb Abramovic i una visitant.",
        "caveat": "L'obra es un performance, no un objecte. Aquesta fotografia, feta per un visitant durant els tres mesos d'exhibicio, documenta el performance amb llicencia CC BY 2.0."
    },
    55: {
        "url": "https://upload.wikimedia.org/wikipedia/commons/5/52/BillViola.jpg",
        "license": "CC BY-SA 2.0",
        "credit": "Kris McKay (Flickr), via Wikimedia Commons",
        "strategy": "Retrat de l'artista Bill Viola.",
        "caveat": "La videoinstal lacio 'Martyrs' a St Paul's Cathedral continua sota drets d'autor i Bill Viola Studio manté control sobre les reproduccions. No existeix imatge lliure de l'obra. Aquesta es un retrat de l'artista. Per projeccions educatives a classe es pot acompanyar d'una captura sota excepcio educativa (LPI Art. 32) amb atribucio."
    },
}


def download(url: str, outpath: str) -> int:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "ArtMap-Edu/0.3 (educational; contact via xtec.gencat.cat)",
            "Accept": "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        data = resp.read()
    with open(outpath, "wb") as out:
        out.write(data)
    return len(data)


def main() -> int:
    with open(IMAGES_JSON, encoding="utf-8") as f:
        images = json.load(f)

    works_by_index = {w["canonicalIndex"]: w for w in images["works"]}

    ok = 0
    for idx, sel in SELECTIONS.items():
        w = works_by_index.get(idx)
        if not w:
            print(f"  ?? Missing index {idx} in images.json")
            continue
        # Determine extension from URL
        m = re.search(r"\.([A-Za-z0-9]+)$", sel["url"])
        ext = (m.group(1).lower() if m else "jpg")
        if ext in ("jpeg", "jpe"):
            ext = "jpg"
        outname = f"{idx:02d}.{ext}"
        outpath = os.path.join(IMG_DIR, outname)
        try:
            size = download(sel["url"], outpath)
            w["image_missing"] = False
            w["local_url"] = f"img/{outname}"
            w["local_size"] = size
            w["license"] = sel["license"]
            w["credit"] = sel["credit"]
            w["image_strategy"] = sel["strategy"]
            w["image_caveat"] = sel["caveat"]
            # Preserve original wikimedia URL as reference if useful
            w["image_url"] = sel["url"]
            ok += 1
            print(f"  OK   #{idx:02d} {w['title'][:42]} -> {outname} ({size // 1024} KB)")
            time.sleep(0.3)
        except Exception as e:
            print(f"  FAIL #{idx:02d} {w['title'][:42]} - {type(e).__name__}: {e}")

    images["meta"]["copyright_integrated"] = ok
    images["meta"]["copyright_updated"] = "2026-04-19"
    with open(IMAGES_JSON, "w", encoding="utf-8") as f:
        json.dump(images, f, ensure_ascii=False, indent=2)

    print(f"\nIntegrated {ok}/5 copyright-workaround images.")
    return 0 if ok == 5 else 1


if __name__ == "__main__":
    sys.exit(main())
