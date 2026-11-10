# Inactive Foundations Inventory

Status: evidence inventory for a future removal decision. **Nothing is removed or activated by this document.** Its job is to separate reviewed runtime dependencies from packaged foundations that no default path currently drives, so a later cleanup is decided by wiring, consumers and guards rather than by filename or a disabled default.

Canonical open work and gates live in [BACKLOG.md](../BACKLOG.md); this file records the reachability/package facts those gates depend on.

## Method

- **Entry and wiring:** read `index.ts` (the packaged artifact entry) and `lib/extension-runtime.ts` to see which ports an ordinary `createActorExtensionRuntime(pi)` call supplies.
- **Static reachability:** parse every `./x.ts` import (static and dynamic) across `index.ts` and `lib/`, then walk from the entry.
- **Packaging:** compare against the real npm manifest with `npm pack --dry-run --json`.
- **Parity:** `npm run build:check` proves `dist/` matches source; the packed/installed test family replays the compiled tree.
- **CI references:** `.github/workflows/*` shows which non-packaged sources a research workflow still builds.

Repeatable reachability check (same result as recorded below):

```sh
node -e '
const fs=require("node:fs"),path=require("node:path");
const files=["index.ts",...fs.readdirSync("lib").filter(f=>f.endsWith(".ts")).map(f=>"lib/"+f)];
const g=new Map();
for(const f of files){const t=fs.readFileSync(f,"utf8"),d=new Set();
 for(const m of t.matchAll(/(?:from|import\()\s*"(\.[^"]+\.ts)"/gu))d.add(path.normalize(path.join(path.dirname(f),m[1])));
 g.set(f,[...d]);}
const seen=new Set(),stack=["index.ts"];
while(stack.length){const c=stack.pop();if(seen.has(c))continue;seen.add(c);for(const d of g.get(c)??[])stack.push(d);}
const lib=files.filter(f=>f.startsWith("lib/"));
console.log("entry-reachable:",lib.filter(f=>seen.has(f)).length+"/"+lib.length);
console.log("unreachable:",lib.filter(f=>!seen.has(f)).map(f=>f.slice(4)).join(" ")||"(none)");
'
```

## Current measurements

| Fact | Value |
| --- | --- |
| `lib/` TypeScript modules | 87 |
| Reachable from `index.ts` | 85 |
| Entry-unreachable but packaged | `runs-process-windows-mi.ts`, `preflight-diagnostics.ts` |
| npm tarball (0.56.1 candidate) | 452 files |
| `dist/` parity | `build:check` current |

## Reviewed runtime dependencies (must not be treated as dead)

| Owner | Why it is a real dependency |
| --- | --- |
| Most `lib/` modules | Reachable from `index.ts` through the extension runtime, tools, delivery or Inspector wiring. |
| `preflight-diagnostics.ts` | Entry-unreachable yet packaged **and used** by the packaged `scripts/async-runner.mjs` via dynamic import; the preflight path is a supported script surface, not a leftover. |
| `run-delivery.ts` `ax_records` / `completion_yaml_core_v1` paths | The active fresh completion capture; only the *numbered stream* part of this owner is inactive. |

## Packaged foundations with no default driver

| Foundation | Owner(s) | Consumer today | Default wiring | Interleaved guard | Activation gate |
| --- | --- | --- | --- | --- | --- |
| Independent supervision / owner-loss authority | `run-supervision.ts`, `runs-supervision.ts` | `extension-runtime.ts` only when optional `supervisionPorts` are supplied; `index.ts` supplies none, so `getRunAdmissionObserver` returns `undefined` and no owner is constructed | Off | Optional-dependency contract; controller ports require an unadopted original-clock/native-scope carrier | A/B/C then `D1` (BACKLOG §4) |
| Public completion streams / session-wide numbering | `run-delivery.ts` stream section, `run-ui-runtime.ts` admission hooks | Optional `completionStreamSessionAdmission` / `captureCompletionBatch`; no production provider. Kernel-only capture additionally requires an existing valid stream journal | Off | Missing/corrupt stream state stays unavailable rather than starting at zero; packet-local indices remain authoritative for saved bytes | `S1.1`–`S1.4` (BACKLOG §3) |
| Native launch ledger | `runs-native-launches.ts` | Called by `runs-control/results/start/retention`, but only through the private `readPendingCommandSpawnAdmission()` claim inside `withRunWorkAdmission`; ordinary launches never populate it | Inert | `assertNoRetainedNativeLaunchScope` fences start/retention against stale native scope; a recorded native admission is single-claim | `C1`/`C2`/`D1` |
| Native Windows MI reader | `runs-process-windows-mi.ts` | **No production importer**: the shipped fresh-process reader is inline PowerShell in `runs-process.ts` with the corrected UTF-8 decoding | Inert | Kept separate from the released reader so a prototype cannot silently replace it; unsupported UTC admission stays refused | `N1.2p`, `N1.3`, `N1.6` (BACKLOG §7) |
| Native helper source | `native/windows-mi/windows-mi.cpp` | Only `.github/workflows/windows-native-observation.yml` (research build); **not in the npm manifest** | Not shipped | Container is research-only; manifest-bound provenance/asset decision is unadopted | `N1.3`, `N1.5` |
| Evidence/context export roles beyond the selected subset | `runs-context-exports.ts`, `runs-execution-evidence.ts`, `runs-session-exports.ts`, `run-evidence-policy.ts` | Reachable, but only the selected reference/role subsets publish; broader retention/selection predicates stay gated | Partial | Producer/privacy/identity fences and explicit unavailability instead of fabricated bodies | `A3.1`/`A3.2`/`A3.3` |
| MPRIS playback surface | none (no `lib/` module) | — | Absent | Music playback stays behind the existing `music-player` singleton Control surface | `M1.1`–`M1.4` (BACKLOG §5) |
| Portable composition bundles / CodeMode | none (no `lib/` module) | — | Absent | Recorded as design intake only; host CodeMode calls existing tools | `T1.1`–`T1.3` (BACKLOG §6) |

## Consequences for a removal decision

- A file being default-off is not evidence of dead code: supervision, stream numbering and the native ledger all sit behind optional ports or private admissions that are exercised by tests.
- Removing any row above would also remove a **guard** (unavailable-not-zero, stale native scope refusal, single-claim admission) that the active paths rely on for their refusals.
- The only rows with no runtime consumer at all are the native MI reader, the native helper source, MPRIS and the composition transport; each already carries its own backward gate, so removal stays a separate, explicitly justified decision.
- `preflight-diagnostics.ts` must never be classified by entry reachability alone.

## Open decision

No removal is authorized here. A later cleanup should pick concrete rows, restate which gate replaces their guard, and re-run the reachability, `build:check` and packed/installed evidence for its own tree.
