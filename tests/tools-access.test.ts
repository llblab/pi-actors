/** Mirrors tools-access.ts: current-context ownership and optional post-launch location handoff. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import * as Access from "../lib/tools-access.ts";
import { claimRunStateDirectory } from "../lib/runs-ownership.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), "pi-actors-tools-access-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = claimRunStateDirectory(join(root, "state"), "locations");
  const meta = { run: "locations", run_instance_id: "generation-a", ownerId: "session-a", state_dir: directory,
    values: { token: "SOURCE_ONLY_NOT_A_NAVIGATION_FIELD" } };
  fs.writeFileSync(join(directory, "run.json"), JSON.stringify(meta));
  return { meta, directory, ctx: { sessionManager: { getSessionId: () => "session-a" } } };
}

test("Session access requires the actual context session and keeps ownership guards explicit", () => {
  assert.equal(Access.getContextSessionId(undefined), undefined);
  assert.equal(Access.getContextSessionId({ sessionManager: { getSessionId: () => "actual" } }), "actual");
  assert.throws(() => Access.requireContextSessionId({}, "run:example"), { reason: "session_unavailable" });
  const ctx = { sessionManager: { getSessionId: () => "actual" } }, status = { ownerId: "actual" };
  assert.equal(Access.assertRunStatusAccessibleToContext("example", status, ctx), status);
  assert.throws(() => Access.assertRunStatusAccessibleToContext("example", { ownerId: "other" }, ctx), { reason: "session_mismatch" });
  assert.throws(() => Access.assertRunStatusAccessibleToContext("example", {}, ctx), { reason: "session_mismatch" });
});

test("Post-launch navigation projects exact current-session files without source-body fields", t => {
  const f = fixture(t), before = fs.readFileSync(join(f.directory, "run.json"));
  const value = Access.readRunFileNavigationForContext(f.meta, f.ctx);
  assert.equal(value.state, "available");
  if (value.state !== "available") return;
  assert.equal(value.directory, f.directory); assert.equal(value.run_instance_id, "generation-a");
  assert.equal(value.files.find(file => file.role === "metadata")?.path, join(f.directory, "run.json"));
  assert.doesNotMatch(JSON.stringify(value), /SOURCE_ONLY|token|values/);
  assert.deepEqual(fs.readFileSync(join(f.directory, "run.json")), before);
  assert.ok(Object.isFrozen(value));
});

test("Post-launch navigation refuses ownerless, foreign, copied and stale-generation selection", t => {
  const f = fixture(t);
  assert.deepEqual(Access.readRunFileNavigationForContext(f.meta, {}), { state: "unavailable", reason: "session_unavailable" });
  assert.deepEqual(Access.readRunFileNavigationForContext(f.meta, { sessionManager: { getSessionId: () => "new-copy" } }),
    { state: "unavailable", reason: "session_mismatch" });
  assert.deepEqual(Access.readRunFileNavigationForContext({ ...f.meta, run_instance_id: "stale" }, f.ctx),
    { state: "unavailable", reason: "identity_mismatch" });
  assert.deepEqual(Access.readRunFileNavigationForContext({ ...f.meta, state_dir: undefined }, f.ctx),
    { state: "unavailable", reason: "identity_unavailable" });
});

test("Post-launch navigation discards paths when the actual recipient changes during observation", t => {
  const f = fixture(t); let calls = 0;
  const value = Access.readRunFileNavigationForContext(f.meta, { sessionManager: { getSessionId: () => ++calls === 1 ? "session-a" : "session-b" } });
  assert.deepEqual(value, { state: "unavailable", reason: "session_changed" });
  assert.equal(calls, 2); assert.ok(!JSON.stringify(value).includes(f.directory));
});

test("Optional post-launch navigation bounds stale-context errors without failing committed work or exposing causes", t => {
  const f = fixture(t);
  const value = Access.readRunFileNavigationForContext(f.meta, { sessionManager: { getSessionId: () => { throw new Error("PRIVATE_CONTEXT_CAUSE"); } } });
  assert.deepEqual(value, { state: "unavailable", reason: "navigation_unavailable" });
  assert.ok(Object.isFrozen(value)); assert.doesNotMatch(JSON.stringify(value), /PRIVATE_CONTEXT_CAUSE/);
  assert.equal(fs.existsSync(join(f.directory, "run.json")), true);
});
