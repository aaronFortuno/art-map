"""
Generate ATTRIBUTIONS.md from data/images.json + data/secondary-images.json.

For every canonical work (1-55), emits a table row with credit, license and
source. For the canonical and secondary copyright-workaround works, emits a
detailed block with strategy and caveat so readers understand what the image
actually shows.

Re-run this script after any change in the image metadata files.
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
SECONDARY_IMAGES_JSON = os.path.join(ROOT, "data", "secondary-images.json")
OUTPUT = os.path.join(ROOT, "ATTRIBUTIONS.md")

# Canonical works for which we use a non-original strategy.
CANONICAL_WORKAROUNDS = {50, 51, 52, 54, 55}

HEADER = """# Atribucions d'imatges

Aquest document llista l'origen i la llicència de totes les imatges incloses al
repositori (`img/`). Les imatges s'han descarregat localment per garantir
disponibilitat i evitar dependències amb la política de *hotlinking* de
Wikimedia, però cada fitxer conserva la seva llicència original i cal atribuir-la
correctament en qualsevol reutilització.

Per a les obres que encara estan sota drets d'autor (Picasso, Pollock,
Abramović, Viola al bloc canònic; Picasso, Miró, Oppenheim, Kusama,
Guerrilla Girls, Sherman, Dalí al bloc secundari), la imatge que es mostra
**no és l'original** sinó una rèplica lliure, una fotografia contextual o
un retrat de l'artista. Cada cas està documentat a les seccions
[Estratègies alternatives canòniques](#estrategies-alternatives-canoniques)
i [Estratègies alternatives secundàries](#estrategies-alternatives-secundaries).
L'obra de Frida Kahlo va entrar en domini públic a la UE l'1 de gener de 2025.

Generat automàticament per `scripts/generate_attributions.py` des de
`data/images.json` i `data/secondary-images.json`.

## Índex

- [Obres canòniques (1-55)](#obres-canoniques-1-55)
- [Estratègies alternatives canòniques](#estrategies-alternatives-canoniques)
- [Nodes secundaris (ponts pedagògics)](#nodes-secundaris)
- [Estratègies alternatives secundàries](#estrategies-alternatives-secundaries)

"""

def table_row(w):
    n = w["canonicalIndex"]
    title = w.get("title", "?")
    license_ = w.get("license", "—")
    credit = w.get("credit", "—")
    wiki = w.get("wikimedia_file_page") or w.get("image_url") or ""
    source = f"[Commons]({wiki})" if wiki else "—"
    return f"| {n:02d} | {title} | {license_} | {credit} | {source} |"


def workaround_block(w, label_key="canonicalIndex", label_fmt="#{}"):
    tag = w.get(label_key)
    if label_key == "canonicalIndex" and tag is not None:
        header_tag = f"#{tag:02d}"
    else:
        header_tag = f"`{w.get('node_id', '?')}`"
    title = w.get("title", "?")
    strategy = w.get("image_strategy", "")
    caveat = w.get("image_caveat", "")
    license_ = w.get("license", "—")
    credit = w.get("credit", "—")
    wiki = w.get("wikimedia_file_page") or w.get("image_url") or ""
    wiki_line = f"- **Font**: [{wiki}]({wiki})" if wiki else ""
    return f"""### {header_tag} · {title}

- **Estratègia**: {strategy}
- **Llicència**: {license_}
- **Crèdit**: {credit}
{wiki_line}

> **Nota pedagògica**: {caveat}
"""


def secondary_row(entry):
    nid = entry.get("node_id", "?")
    title = entry.get("title", "?")
    author = entry.get("author", "") or "—"
    license_ = entry.get("license", "—")
    credit = entry.get("credit", "—")
    wiki = entry.get("wikimedia_file_page") or ""
    source = f"[Commons]({wiki})" if wiki else "—"
    return f"| `{nid}` | {title} | {author} | {license_} | {credit} | {source} |"


def main():
    with open(IMAGES_JSON, encoding="utf-8") as f:
        canonical_data = json.load(f)
    try:
        with open(SECONDARY_IMAGES_JSON, encoding="utf-8") as f:
            secondary_data = json.load(f)
    except FileNotFoundError:
        secondary_data = {"images": []}

    canonical = sorted(canonical_data["works"], key=lambda w: w["canonicalIndex"])
    secondary = sorted(
        [e for e in secondary_data.get("images", []) if e.get("local_url")],
        key=lambda e: e.get("node_id", "")
    )

    lines = [HEADER]

    # === Canonical ===
    lines.append("## Obres canòniques (1-55)\n")
    lines.append("| # | Obra | Llicència | Crèdit | Font |")
    lines.append("|---|---|---|---|---|")
    for w in canonical:
        lines.append(table_row(w))
    lines.append("")

    # === Canonical workarounds ===
    lines.append("## Estratègies alternatives canòniques\n")
    lines.append(
        "Les cinc obres canòniques següents continuen sota drets d'autor "
        "(excepte Kahlo, PD a la UE des de 2025). Per a cadascuna mostrem una "
        "imatge alternativa amb llicència compatible i n'expliquem l'estratègia.\n"
    )
    for w in canonical:
        if w["canonicalIndex"] in CANONICAL_WORKAROUNDS:
            lines.append(workaround_block(w))

    # === Secondary ===
    lines.append("## Nodes secundaris\n")
    lines.append(
        "Els nodes secundaris són obres pont que enriqueixen la xarxa però no "
        "entren a la llista oficial de les PAU. Inclouen sobretot dones artistes "
        "i obres no-occidentals (mandat del Decret 171/2022).\n"
    )
    lines.append("| id | Obra | Autoria | Llicència | Crèdit | Font |")
    lines.append("|---|---|---|---|---|---|")
    for e in secondary:
        lines.append(secondary_row(e))
    lines.append("")

    # === Secondary workarounds ===
    secondary_with_caveat = [e for e in secondary if e.get("image_caveat")]
    if secondary_with_caveat:
        lines.append("## Estratègies alternatives secundàries\n")
        lines.append(
            "Aquests nodes secundaris mostren una imatge que **no és l'original**: "
            "retrat de l'artista, instal·lació d'una obra germana, rèplica, o "
            "fotografia documental del cartell/obra sota llicència lliure. La nota "
            "pedagògica ho explicita a cada cas.\n"
        )
        for e in secondary_with_caveat:
            lines.append(workaround_block(e, label_key="node_id"))

    lines.append("---\n")
    lines.append(
        "Si trobeu una atribució incorrecta o incompleta, feu-ho saber obrint "
        "una *issue* al repositori."
    )

    with open(OUTPUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"Wrote {OUTPUT}")
    print(f"  Canonical rows:      {len(canonical)}")
    print(f"  Canonical workarounds: {sum(1 for w in canonical if w['canonicalIndex'] in CANONICAL_WORKAROUNDS)}")
    print(f"  Secondary rows:      {len(secondary)}")
    print(f"  Secondary workarounds: {len(secondary_with_caveat)}")


if __name__ == "__main__":
    main()
