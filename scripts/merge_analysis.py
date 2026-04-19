"""
Merge analysis enrichments from data/analysis-enrichments.json into
data/seed.json, replacing `analysis` and `counterfactuals` fields only.

All other node metadata (id, title, author, year, period, technique, location,
canonical, canonicalIndex, themes, notes) is preserved. The 8 Venus-cluster
template nodes (as listed in the enrichment file's meta.skipped_as_template)
remain untouched.

Re-runnable: if seed.json already has the enriched content, this script is a
no-op (just overwrites with the same values).
"""

import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED = os.path.join(ROOT, "data", "seed.json")
ENRICH = os.path.join(ROOT, "data", "analysis-enrichments.json")


def main() -> int:
    with open(SEED, encoding="utf-8") as f:
        seed = json.load(f)
    with open(ENRICH, encoding="utf-8") as f:
        enrich = json.load(f)

    enrichments = enrich.get("enrichments", {})
    merged = 0
    missing = 0
    template_skipped = set(enrich.get("meta", {}).get("skipped_as_template", []))

    for n in seed["nodes"]:
        if n["id"] in enrichments:
            e = enrichments[n["id"]]
            if "analysis" in e:
                n["analysis"] = e["analysis"]
            if "counterfactuals" in e:
                n["counterfactuals"] = e["counterfactuals"]
            merged += 1
        elif n["id"] in template_skipped:
            pass  # intentionally untouched
        else:
            missing += 1
            print(f"  (no enrichment for {n['id']})")

    # Bump version and describe the change
    seed["meta"]["version"] = "0.5.0"
    seed["meta"]["updated"] = "2026-04-19"
    seed["meta"]["description"] = (
        "Mapa complet de les 55 obres canoniques PAU 2026 + 46 nodes pont "
        "secundaris (101 nodes, 177 arestes). Anàlisi enriquida el "
        "2026-04-19 a 93 nodes (51 canòniques + 42 secundàries); els 8 nodes "
        "del clúster Venus queden com a plantilla intacta."
    )

    with open(SEED, "w", encoding="utf-8") as f:
        json.dump(seed, f, ensure_ascii=False, indent=2)

    print(f"Merged analysis+counterfactuals into: {merged} nodes")
    print(f"Template nodes untouched:            {len(template_skipped)}")
    print(f"Nodes without enrichment:            {missing}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
