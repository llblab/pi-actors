---
name: domain-dag
description: Review and validate pi-actors domain ownership, acyclic local imports, composition-root direction, and cross-Skill dependency direction after architecture-affecting changes.
---

# pi-actors Domain DAG

## Scope

Use this project-local development protocol for a new domain, domain split or merge, import-direction change, composition-root change, or runtime ownership move. It is agent tooling, not an npm, CI, or release gate.

pi-actors is a flat Domain DAG. `index.ts` is the composition root; `lib/` owns TypeScript product domains. `scripts/` and `skills/*/scripts/` are executable adapters or self-contained applications and should remain thin unless a reusable compiled domain is justified.

## Durable boundaries

- `index.ts` wires Pi ports and lifecycle registration; it must not own domain behavior.
- `lib/` must not import `index.ts`.
- Local TypeScript imports must remain acyclic.
- A durable responsibility has one owner. Prefer focused public contracts over sibling reach-through or generic shared buckets.
- Keep Run lifecycle/evidence authority in `runs-*`, Recipe resolution in `recipes-*`, tool adapters in `tools-*`, and Inspector projection/action logic in `inspector-*`.
- The bundled Skill Recipe DAG is `artifacts → actors, swarm`, `media → artifacts`, and `project-work → actors, artifacts, swarm`; `actors`, `swarm`, and `recipe-memory` have no cross-Skill Recipe dependencies.
- Domain headers (`Domain:`, `Domains:`, `Owns:`, or `Zones:`) are useful when ownership is otherwise ambiguous, but are not required mechanically for every flat module.

## Validation

From the repository root:

```bash
node .agents/skills/domain-dag/scripts/validate-domain-dag.mjs --root . --config .agents/skills/domain-dag/domain-dag.json
```

Or run the Skill Recipe `domain-dag/validate-domain-dag` when this project Skill is active.

The validator reports local import cycles, reverse imports into `index.ts`, configured forbidden edges, missing optional ownership headers, and shared-bucket pressure. Errors are objective graph/boundary failures; warnings are review leads.

## Updating the map

Edit `domain-dag.json` only when repository architecture changes. Keep `sourceRoots` and `entrypoints` exact. Add a forbidden edge only after a real ownership boundary has been established and the rule is low-noise. Do not add style, line-count, documentation-quota, or generic vocabulary rules.

## Interpretation and repair

- **Cycle:** identify the shared lower capability or narrow contract; do not hide the cycle with dynamic imports.
- **Composition-root inversion:** move wiring outward to `index.ts` or expose a narrow lower-level contract.
- **Authority inversion:** move policy/state to its durable owner and leave orchestration at the caller.
- **Shared-bucket warning:** decide whether the file has a specific owner before extracting or renaming it.

Run normal product tests after architecture repair. Stop when the graph is acyclic, ownership direction is explicit, and further extraction would create one-use wrappers or hide control flow.
