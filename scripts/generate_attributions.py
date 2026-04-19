"""
Generate ATTRIBUTIONS.md from data/images.json.

For every canonical work, emits a table row with credit, license and source.
For the 5 copyright-workaround works (Guernica, Pollock, Kahlo, Abramović,
Viola), emits a detailed block with strategy and caveat so readers understand
what the image actually shows.

Re-run this script after any change in data/images.json.
"""

import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGES_JSON = os.path.join(ROOT, "data", "images.json")
OUTPUT = os.path.join(ROOT, "ATTRIBUTIONS.md")

# Works for which we use a non-original strategy (replica, context, portrait).
COPYRIGHT_WORKAROUNDS = {50, 51, 52, 54, 55}

HEADER = """# Atribucions d'imatges

Aquest document llista l'origen i la llicència de totes les imatges incloses al
repositori (`img/`). Les imatges s'han descarregat localment per garantir
disponibilitat i evitar dependències amb la política de *hotlinking* de
Wikimedia, però cada fitxer conserva la seva llicència original i cal atribuir-la
correctament en qualsevol reutilització.

Per a les obres que encara estan sota drets d'autor (Picasso, Pollock,
Abramović, Viola), la imatge que es mostra **no és l'original** sinó una rèplica
lliure, una fotografia contextual o un retrat de l'artista. Cada cas està
documentat a la secció [Estratègies alternatives](#estrategies-alternatives).
L'obra de Frida Kahlo va entrar en domini públic a la UE l'1 de gener de 2025.

Generat automàticament per `scripts/generate_attributions.py` des de
`data/images.json`.

## Índex

- [Obres canòniques (1-55)](#obres-canoniques-1-55)
- [Estratègies alternatives (obres sota drets d'autor)](#estrategies-alternatives)

"""

def table_row(w):
    n = w["canonicalIndex"]
    title = w.get("title", "?")
    license_ = w.get("license", "—")
    credit = w.get("credit", "—")
    wiki = w.get("wikimedia_file_page") or w.get("image_url") or ""
    source = f"[Commons]({wiki})" if wiki else "—"
    return f"| {n:02d} | {title} | {license_} | {credit} | {source} |"


def workaround_block(w):
    n = w["canonicalIndex"]
    title = w.get("title", "?")
    strategy = w.get("image_strategy", "")
    caveat = w.get("image_caveat", "")
    license_ = w.get("license", "—")
    credit = w.get("credit", "—")
    wiki = w.get("wikimedia_file_page") or w.get("image_url") or ""
    wiki_line = f"- **Font**: [{wiki}]({wiki})" if wiki else ""
    return f"""### #{n:02d} · {title}

- **Estratègia**: {strategy}
- **Llicència**: {license_}
- **Crèdit**: {credit}
{wiki_line}

> **Nota pedagògica**: {caveat}
"""


def main():
    with open(IMAGES_JSON, encoding="utf-8") as f:
        data = json.load(f)

    works = sorted(data["works"], key=lambda w: w["canonicalIndex"])

    lines = [HEADER, "## Obres canòniques (1-55)\n"]
    lines.append("| # | Obra | Llicència | Crèdit | Font |")
    lines.append("|---|---|---|---|---|")
    for w in works:
        lines.append(table_row(w))
    lines.append("")

    lines.append("## Estratègies alternatives\n")
    lines.append(
        "Les cinc obres següents continuen sota drets d'autor (excepte Kahlo, "
        "que és PD a la UE des de 2025). Per a cadascuna mostrem una imatge "
        "alternativa amb llicència compatible i n'expliquem l'estratègia."
        "\n"
    )

    for w in works:
        if w["canonicalIndex"] in COPYRIGHT_WORKAROUNDS:
            lines.append(workaround_block(w))

    lines.append("---\n")
    lines.append(
        "Si trobeu una atribució incorrecta o incompleta, feu-ho saber obrint "
        "una *issue* al repositori."
    )

    with open(OUTPUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"Wrote {OUTPUT}")
    print(f"  Canonical rows: {len(works)}")
    print(f"  Workaround blocks: {sum(1 for w in works if w['canonicalIndex'] in COPYRIGHT_WORKAROUNDS)}")


if __name__ == "__main__":
    main()
