"""
Merge data/secondary-proposals.json into data/seed.json.

- Appends new periods and themes (deduplicated by id)
- Flattens all axis nodes into seed.nodes
- Flattens all axis edges into seed.edges
- Bumps seed version and updates description
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
PROPOSALS = os.path.join(ROOT, "data", "secondary-proposals.json")

with open(SEED, encoding="utf-8") as f:
    seed = json.load(f)
with open(PROPOSALS, encoding="utf-8") as f:
    props = json.load(f)

# Dedup existing ids
seed_period_ids = {p["id"] for p in seed["periods"]}
seed_theme_ids  = {t["id"] for t in seed["themes"]}
seed_node_ids   = {n["id"] for n in seed["nodes"]}

added_periods = 0
for p in props.get("new_periods", []):
    if p["id"] not in seed_period_ids:
        seed["periods"].append(p)
        seed_period_ids.add(p["id"])
        added_periods += 1

added_themes = 0
for t in props.get("new_themes", []):
    if t["id"] not in seed_theme_ids:
        seed["themes"].append(t)
        seed_theme_ids.add(t["id"])
        added_themes += 1

added_nodes = 0
added_edges = 0
for axis in props["axes"]:
    for n in axis["nodes"]:
        if n["id"] in seed_node_ids:
            print(f"  SKIP duplicate node id: {n['id']}")
            continue
        seed["nodes"].append(n)
        seed_node_ids.add(n["id"])
        added_nodes += 1
    for e in axis["edges"]:
        seed["edges"].append(e)
        added_edges += 1

# Bump version + update description
seed["meta"]["version"] = "0.4.0"
seed["meta"]["updated"] = "2026-04-19"
seed["meta"]["description"] = (
    "Mapa complet de les 55 obres canoniques PAU 2026 + nodes pont secundaris "
    "organitzats per eixos temàtics. La fusió del 2026-04-19 ha afegit 42 nodes "
    "secundaris i 93 arestes (perspectiva de gènere, orient-occident, transicions "
    "abans cobertes a mitges). Veure secondary-proposals.json per al detall d'eixos."
)

with open(SEED, "w", encoding="utf-8") as f:
    json.dump(seed, f, ensure_ascii=False, indent=2)

print(f"Added periods: {added_periods}")
print(f"Added themes:  {added_themes}")
print(f"Added nodes:   {added_nodes}")
print(f"Added edges:   {added_edges}")
print(f"Seed now: {len(seed['nodes'])} nodes, {len(seed['edges'])} edges, "
      f"{len(seed['periods'])} periods, {len(seed['themes'])} themes")

# Validate no orphan edges
node_ids = {n["id"] for n in seed["nodes"]}
orphans = [e for e in seed["edges"] if e["source"] not in node_ids or e["target"] not in node_ids]
if orphans:
    print(f"\nWARN: {len(orphans)} orphan edges:")
    for e in orphans[:5]:
        print(f"  {e['source']} -> {e['target']}")
else:
    print("\nAll edges resolve to valid nodes.")
