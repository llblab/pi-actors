/**
 * Session-scoped Run naming regression tests
 * Covers session keys, recipe stems, ordinal allocation, explicit names and ledger durability
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { RunNameReservation } from "../lib/runs-naming.ts";
import {
  rememberRunName,
  recipeStem,
  reserveRunName,
  runNameLedgerPath,
  runStateDirFor,
  sessionKey,
} from "../lib/runs-naming.ts";

function reserved(value: RunNameReservation): Extract<RunNameReservation, { state: "reserved" }> {
  assert.equal(value.state, "reserved");
  if (value.state !== "reserved") throw new Error("Expected a reserved Run name.");
  return value;
}

async function withRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-naming-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("Session keys name one directory component and reject unusable identities", () => {
  assert.equal(sessionKey("01a1f15b-8ef7-75e2-b3c7-1545b868b301"), "01a1f15b-8ef7-75e2-b3c7-1545b868b301");
  assert.equal(sessionKey(" session-1 "), "session-1");
  for (const value of [undefined, "", "   ", ".", "..", ".hidden", "a/b", "a\\b", "a b", "a\u0000b", "x".repeat(129)]) {
    assert.equal(sessionKey(value), undefined);
  }
});

test("Recipe stems come from the Recipe identity, not from a caller path", () => {
  assert.equal(recipeStem("package-review"), "package-review");
  assert.equal(recipeStem("swarm/package-review"), "package-review");
  assert.equal(recipeStem("/home/user/.pi/agent/recipes/review.json"), "review");
  assert.equal(recipeStem("skills/actors/recipes/run-summary.md"), "run-summary");
  assert.equal(recipeStem("music-player/playback"), "playback");
  assert.equal(recipeStem(undefined), "run");
  assert.equal(recipeStem("../../etc"), "etc");
  assert.equal(recipeStem("@@@"), "run");
});

test("Automatic names start at zero and never repeat inside one session", async t => {
  const root = await withRoot(t);
  const first = reserved(reserveRunName(root, "session-a", "swarm/package-review", { kind: "auto" }));
  const second = reserved(reserveRunName(root, "session-a", "swarm/package-review", { kind: "auto" }));
  assert.deepEqual([first.name, second.name], ["package-review-0", "package-review-1"]);
  assert.equal(second.state_dir, runStateDirFor(root, "session-a", "package-review-1"));
  const ledger = JSON.parse(await readFile(runNameLedgerPath(root, "session-a"), "utf8"));
  assert.equal(ledger.schema, "run-names-v1");
  assert.deepEqual(Object.keys(ledger.names).sort(), ["package-review-0", "package-review-1"]);
  assert.equal(ledger.names["package-review-1"].ordinal, 1);
});

test("Sessions keep independent sequences", async t => {
  const root = await withRoot(t);
  const a = reserved(reserveRunName(root, "session-a", "swarm/package-review", { kind: "auto" }));
  const b = reserved(reserveRunName(root, "session-b", "swarm/package-review", { kind: "auto" }));
  assert.equal(a.name, "package-review-0");
  assert.equal(b.name, "package-review-0");
  assert.notEqual(a.state_dir, b.state_dir);
});

test("An explicit name is reserved once and then refused", async t => {
  const root = await withRoot(t);
  const first = reserved(reserveRunName(root, "session-a", "swarm/package-review", { kind: "explicit", name: "final-review" }));
  const second = reserveRunName(root, "session-a", "swarm/package-review", { kind: "explicit", name: "final-review" });
  assert.equal(first.name, "final-review");
  assert.deepEqual(second, { state: "refused", reason: "run_name_taken" });
  for (const name of ["", "a/b", "..", "name with space"]) {
    assert.deepEqual(reserveRunName(root, "session-a", "r", { kind: "explicit", name }), { state: "refused", reason: "name_invalid" });
  }
});

test("A reservation survives a missing Run directory and is not reissued", async t => {
  const root = await withRoot(t);
  const first = reserved(reserveRunName(root, "session-a", "swarm/package-review", { kind: "auto" }));
  assert.equal(first.name, "package-review-0");
  const reused = reserveRunName(root, "session-a", "swarm/package-review", { kind: "explicit", name: "package-review-0" });
  assert.deepEqual(reused, { state: "refused", reason: "run_name_taken" });
  const next = reserved(reserveRunName(root, "session-a", "swarm/package-review", { kind: "auto" }));
  assert.equal(next.name, "package-review-1");
});

test("A malformed or foreign ledger refuses instead of restarting at zero", async t => {
  const root = await withRoot(t);
  const ledgerPath = runNameLedgerPath(root, "session-a");
  await mkdir(dirname(ledgerPath), { recursive: true });
  for (const content of ["{", JSON.stringify({ schema: "other", names: {} }), JSON.stringify({ schema: "run-names-v1", names: { "x-0": { recipe: "r", reserved_at: "t" }, "../escape": { recipe: "r", reserved_at: "t" } } })]) {
    await writeFile(ledgerPath, content);
    assert.deepEqual(reserveRunName(root, "session-a", "r", { kind: "auto" }), { state: "refused", reason: "ledger_invalid" });
  }
});

test("An exact name is used once, while an internal re-entry records the same name", async t => {
  const root = await withRoot(t);
  const first = reserved(reserveRunName(root, "session-a", "swarm/package-review", { kind: "explicit", name: "final-review" }));
  assert.equal(first.name, "final-review");
  assert.deepEqual(reserveRunName(root, "session-a", "swarm/package-review", { kind: "explicit", name: "final-review" }),
    { state: "refused", reason: "run_name_taken" });
  const reentry = reserved(rememberRunName(root, "session-a", "swarm/package-review", "final-review"));
  assert.equal(reentry.state_dir, first.state_dir);
  assert.notEqual(reentry.state, "refused");
  assert.deepEqual(reserveRunName(root, "session-a", "swarm/package-review", { kind: "explicit", name: "final-review" }),
    { state: "refused", reason: "run_name_taken" });
  const allocated = reserved(reserveRunName(root, "session-a", "swarm/package-review", { kind: "auto" }));
  assert.equal(allocated.name, "package-review-0");
});

test("An invalid session cannot reserve a name", async t => {
  const root = await withRoot(t);
  assert.deepEqual(reserveRunName(root, "../escape", "r", { kind: "auto" }), { state: "refused", reason: "session_unavailable" });
});

test("Two processes reserving at once never receive the same name", async t => {
  const root = await withRoot(t);
  const modulePath = new URL("../lib/runs-naming.ts", import.meta.url).href;
  const script = `
    const { reserveRunName } = await import(process.env.NAMING_MODULE);
    const names = [];
    for (let index = 0; index < 20; index += 1) {
      const reserved = reserveRunName(process.env.NAMING_ROOT, "race", "swarm/package-review", { kind: "auto" });
      if (reserved.state !== "reserved") { console.error(JSON.stringify(reserved)); process.exit(2); }
      names.push(reserved.name);
    }
    console.log(JSON.stringify(names));
  `;
  const runChild = () => new Promise<string[]>((resolve, reject) => {
    execFile(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
      { env: { ...process.env, NAMING_MODULE: modulePath, NAMING_ROOT: root } },
      (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout.trim()) as string[]));
  });
  const [left, right] = await Promise.all([runChild(), runChild()]);
  const combined = [...left, ...right];
  assert.equal(combined.length, 40);
  assert.equal(new Set(combined).size, 40);
  for (const name of combined) assert.match(name, /^package-review-\d+$/u);
  const ledger = JSON.parse(await readFile(runNameLedgerPath(root, "race"), "utf8"));
  assert.deepEqual(Object.keys(ledger.names).sort(), combined.sort());
});

test("Runtime-owned entries, device aliases and trailing dots are never session keys or Run names", async t => {
  const root = await withRoot(t);
  for (const value of ["names", "NAMES", "index.json", "teardown", "archived", "Preserved-Artifacts", "con", "NUL.txt", "com1", "lpt9", "trailing."]) {
    assert.equal(sessionKey(value), undefined, `${value} must not become a session namespace`);
  }
  assert.equal(sessionKey("_unowned"), "_unowned", "The unowned bucket stays a usable namespace");
  for (const name of ["archived", "ARCHIVED", "preserved-artifacts", "con", "aux.log", "trailing."]) {
    assert.deepEqual(reserveRunName(root, "session-a", "swarm/review", { kind: "explicit", name }), { state: "refused", reason: "name_invalid" });
    assert.deepEqual(rememberRunName(root, "session-a", "music-player/playback", name), { state: "refused", reason: "name_invalid" });
  }
  // Root-level runtime names remain legal Run names inside a session: only retention containers collide there.
  assert.equal(reserved(reserveRunName(root, "session-a", "swarm/review", { kind: "explicit", name: "teardown" })).name, "teardown");
  assert.equal(reserved(reserveRunName(root, "session-a", "swarm/review", { kind: "auto", stem: "archived" })).name, "archived-0");
});
