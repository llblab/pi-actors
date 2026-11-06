/** Run retirement contracts: controlled filesystem/probe interleavings, not native closure proof. */
import "./test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, test, type TestContext } from "node:test";

import { mutationLockPath, writeJsonAtomic } from "../lib/file-state.ts";
import { claimRunStateDirectory } from "../lib/runs-ownership.ts";
import { acquireStateStartLock } from "../lib/runs-start.ts";
import * as Limits from "../lib/limits.ts";
import { appendRunRetentionEvidence, cleanupStaleRunEntries, DEFAULT_RUN_MAX_AGE_MS, retainRun } from "../lib/runs-retention.ts";

const FIXTURE_PID = 2_000_000_000;
const TTL = 1000;

function fixture(t: TestContext, retainState = false) {
  const root = fs.mkdtempSync(join(tmpdir(), "pi-actors-retirement-"));
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports();
    if (retainState) t.diagnostic(`Controlled file-lock fault state retained: ${root}; no workload/native closure or host exit asserted`);
    else fs.rmSync(root, { recursive: true, force: true }); });
  const originalKill = process.kill.bind(process);
  t.mock.method(process, "kill", (pid: number, signal: NodeJS.Signals | number = 0) => {
    if (pid === FIXTURE_PID && signal === 0) throw Object.assign(new Error("controlled absence"), { code: "ESRCH" });
    return originalKill(pid, signal);
  });
  const add = (run = "owned", stale = true) => {
    const dir = join(root, run);
    claimRunStateDirectory(dir, run);
    writeJsonAtomic(join(dir, "run.json"), { run, run_instance_id: "generation-A", ownerId: "owner-A", state_dir: dir, pid: FIXTURE_PID });
    // This is a bound legacy terminal fixture, not an admitted natural/native outcome.
    writeJsonAtomic(join(dir, "result.json"), { run_instance_id: "generation-A", completedAt: new Date().toISOString(), code: 0 });
    fs.writeFileSync(join(dir, "retained.bin"), Buffer.from([0, 255, 128, 13, 10]));
    if (stale) age(dir);
    return dir;
  };
  return { root, add };
}

function age(dir: string): void {
  const old = new Date(Date.now() - 8000);
  fs.utimesSync(dir, old, old);
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else files[relative(root, path)] = fs.readFileSync(path).toString("base64");
    }
  };
  visit(root);
  return files;
}

function beforeLock(t: TestContext, dir: string, action: () => void): () => boolean {
  const target = mutationLockPath(join(dir, ".lifecycle"));
  const rename = fs.renameSync;
  let seen = false;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === target && !seen) { seen = true; action(); }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  return () => seen;
}

await describe("Run retirement", { concurrency: false }, async () => {
test("Run retention journal keeps a bounded valid tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-retention-bound-"));
  const stateDir = join(root, "run");
  try {
    await mkdir(stateDir);
    const status = { run: "bounded", run_instance_id: "generation-a", state_dir: stateDir };
    await writeFile(join(root, "retention.jsonl"), `{bad json\n${JSON.stringify({ id: "legacy" })}\n`);
    for (let index = 0; index <= Limits.RUN_RETENTION_MAX_RECORDS; index += 1) {
      appendRunRetentionEvidence(status, "archive", "queued", { id: `retention-${index}` });
    }
    const content = await readFile(join(root, "retention.jsonl"), "utf8");
    const records = content.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, Limits.RUN_RETENTION_MAX_RECORDS);
    assert.ok(Buffer.byteLength(content) <= Limits.RUN_RETENTION_MAX_BYTES);
    assert.equal(records[0].id, "retention-1");
    assert.equal(records.at(-1).id, `retention-${Limits.RUN_RETENTION_MAX_RECORDS}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


  test("Age selects owned dead candidates, not fresh entries or retention containers", async (t) => {
    const { root, add } = fixture(t);
    assert.equal(DEFAULT_RUN_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
    const stale = add();
    const fresh = add("fresh", false);
    for (const name of ["archived", "preserved-artifacts", "unowned"]) {
      const path = join(root, name);
      fs.mkdirSync(path);
      fs.writeFileSync(join(path, "run.json"), JSON.stringify({ run: name, pid: 0 }));
      age(path);
    }
    assert.equal(await cleanupStaleRunEntries(root, TTL), 1);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
    for (const name of ["archived", "preserved-artifacts", "unowned"]) assert.equal(fs.existsSync(join(root, name, "run.json")), true);
  });

  test("Alive or unknown PID cannot authorize cleanup even beside a terminal-looking result", async (t) => {
    const { root, add } = fixture(t);
    const dir = add();
    const originalKill = process.kill.bind(process);
    for (const mode of ["alive", "false", "EPERM", "EACCES", "EIO"]) {
      const probe = t.mock.method(process, "kill", (pid: number, signal: NodeJS.Signals | number = 0) => {
        if (pid !== FIXTURE_PID || signal !== 0) return originalKill(pid, signal);
        if (mode === "alive") return true;
        if (mode === "false") return false;
        throw Object.assign(new Error(mode), { code: mode });
      });
      const before = snapshot(dir);
      assert.equal(await cleanupStaleRunEntries(root, TTL), 0, mode);
      assert.deepEqual(snapshot(dir), before, mode);
      probe.mock.restore();
    }
    assert.equal(await cleanupStaleRunEntries(root, TTL), 1);
  });

  test("Malformed, unreadable and invalid-PID metadata is retained", async (t) => {
    const { root, add } = fixture(t);
    const dir = add();
    const path = join(dir, "run.json");
    const original = fs.readFileSync(path, "utf8");
    for (const value of ["{", original.replace(String(FIXTURE_PID), "0"), original.replace(String(FIXTURE_PID), '"unknown"')]) {
      fs.writeFileSync(path, value);
      const before = snapshot(dir);
      assert.equal(await cleanupStaleRunEntries(root, TTL), 0);
      assert.deepEqual(snapshot(dir), before);
    }
    fs.writeFileSync(path, original);
    const before = snapshot(dir);
    const open = fs.openSync;
    const denied = t.mock.method(fs, "openSync", (file: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (String(file) === path) throw Object.assign(new Error("controlled denial"), { code: "EACCES" });
      return open(file, flags, mode);
    });
    syncBuiltinESMExports();
    assert.equal(await cleanupStaleRunEntries(root, TTL), 0);
    denied.mock.restore();
    syncBuiltinESMExports();
    assert.deepEqual(snapshot(dir), before);
  });

  test("Every retained native/descendant/preparation role blocks cleanup", async (t) => {
    const { root, add } = fixture(t);
    for (const name of ["native-launches.json", "descendant-launches.json", "descendant-preparation.json", "prepared-run.json"]) {
      const dir = add(name.replaceAll(".", "-"));
      // Presence is the existing fence; these are deliberately not fabricated closure receipts.
      fs.writeFileSync(join(dir, name), "{}\n");
      age(dir);
    }
    const before = snapshot(root);
    assert.equal(await cleanupStaleRunEntries(root, TTL), 0);
    assert.deepEqual(snapshot(root), before);
  });

  test("The original unowned pid-zero stale scenario no longer permits deletion", async (t) => {
    const { root } = fixture(t);
    const staleRun = join(root, "stale-run");
    const freshRun = join(root, "fresh-run");
    for (const [dir, run] of [[staleRun, "stale-run"], [freshRun, "fresh-run"]]) {
      fs.mkdirSync(dir);
      fs.writeFileSync(join(dir, "run.json"), JSON.stringify({ pid: 0, run }));
    }
    age(staleRun);
    const before = snapshot(root);
    assert.equal(await cleanupStaleRunEntries(root, TTL), 0);
    assert.deepEqual(snapshot(root), before);
  });

  test("Generation replacement at admission retains B instead of adopting the stale A selection", async (t) => {
    const { root, add } = fixture(t);
    const dir = add();
    let expected: Record<string, string> | undefined;
    const seen = beforeLock(t, dir, () => {
      const meta = JSON.parse(fs.readFileSync(join(dir, "run.json"), "utf8"));
      writeJsonAtomic(join(dir, "run.json"), { ...meta, run_instance_id: "generation-B" });
      fs.writeFileSync(join(dir, "retained.bin"), "B owns these bytes");
      expected = snapshot(dir);
    });
    assert.equal(await cleanupStaleRunEntries(root, TTL), 0);
    assert.equal(seen(), true);
    assert.deepEqual(snapshot(dir), expected);
  });

  for (const name of ["native-launches.json", "descendant-launches.json"]) {
    test(`A late ${name} is checked under admission with unchanged generation`, async (t) => {
      const { root, add } = fixture(t);
      const dir = add();
      let expected: Record<string, string> | undefined;
      const seen = beforeLock(t, dir, () => { fs.writeFileSync(join(dir, name), "retained\n"); expected = snapshot(dir); });
      assert.equal(await cleanupStaleRunEntries(root, TTL), 0);
      assert.equal(seen(), true);
      assert.deepEqual(snapshot(dir), expected);
    });
  }

  test("Canonical lifecycle lock survives Run removal and excludes replacement until release", async (t) => {
    const { root, add } = fixture(t);
    const dir = add();
    const remove = fs.rmSync;
    let seen = false;
    t.mock.method(fs, "rmSync", (path: fs.PathLike, options?: fs.RmOptions) => {
      if (String(path) === dir) {
        seen = true;
        remove(path, options);
        const blocked = new Error("controlled contender blocked");
        assert.throws(() => acquireStateStartLock(dir, { onContention() { throw blocked; } }), (error: unknown) => error === blocked);
        return;
      }
      return remove(path, options);
    });
    syncBuiltinESMExports();
    assert.equal(await cleanupStaleRunEntries(root, TTL), 1);
    assert.equal(seen, true);
    const release = acquireStateStartLock(dir);
    release();
    assert.equal(fs.existsSync(dir), false);
  });

  test("Manual retirement preserves exact failures and partial filesystem effects without replay", (t) => {
    const { root, add } = fixture(t);
    for (const phase of ["archive", "prune", "copy"] as const) for (const kind of ["error", "aggregate", "undefined", "primitive", "hostile"] as const) {
      const run = `${phase}-${kind}`; const dir = add(run, false);
      const source = join(root, run + ".artifact"); fs.writeFileSync(source, "PRESERVED_BYTES");
      const originalCause = new Error("original private cause"); const formatting = new Error("format failed"); let formatted = 0;
      const primary: unknown = kind === "error" ? Object.assign(new Error("operation failed", { cause: originalCause }), { details: { partial: true } })
        : kind === "aggregate" ? new AggregateError([originalCause, undefined], "original aggregate", { cause: originalCause })
        : kind === "undefined" ? undefined : kind === "primitive" ? "primitive failure"
        : { [Symbol.toPrimitive]() { formatted++; throw formatting; } };
      const remove = fs.rmSync, rename = fs.renameSync, copy = fs.cpSync;
      let operations = 0; let destination: string | undefined;
      const hooks = [
        t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
          const result = rename(from, to);
          if (phase === "archive" && String(from) === dir) { operations++; destination = String(to); throw primary; }
          return result;
        }),
        t.mock.method(fs, "rmSync", (path: fs.PathLike, options?: fs.RmOptions) => {
          const result = remove(path, options);
          if (phase === "prune" && String(path) === dir) { operations++; throw primary; }
          return result;
        }),
        t.mock.method(fs, "cpSync", (from: string | URL, to: string | URL, options?: fs.CopySyncOptions) => {
          const result = copy(from, to, options);
          if (phase === "copy" && String(from) === source) { operations++; destination = String(to); throw primary; }
          return result;
        }),
      ];
      syncBuiltinESMExports();
      let caught: unknown; let rejected = false;
      try { retainRun(dir, phase === "archive" ? "archive" : "prune", {}, () => ({
        ...JSON.parse(fs.readFileSync(join(dir, "run.json"), "utf8")), status: "done", artifacts: { output: source },
      }), { preserveArtifacts: phase === "copy" }); }
      catch (error) { rejected = true; caught = error; }
      finally { for (const hook of hooks.reverse()) hook.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(rejected, true, run); assert.equal(operations, 1, "Never repeat the retirement action for diagnostics");
      if (kind === "hostile") {
        assert.ok(caught instanceof AggregateError); assert.deepEqual(caught.errors, [primary, formatting]); assert.equal(caught.cause, primary); assert.equal(formatted, 1);
      } else assert.equal(caught, primary, "A single surfaced rejection, including undefined, stays exact");
      const records = fs.readFileSync(join(root, "retention.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(record => record.run === run);
      assert.deepEqual(records.map(record => record.outcome), ["queued", "failed"]);
      assert.equal(records[0].id, records[1].id); assert.equal(records[1].run_instance_id, "generation-A");
      if (kind === "hostile") assert.equal(records[1].error, "failure text unavailable");
      if (phase === "archive") { assert.equal(fs.existsSync(dir), false); assert.ok(fs.existsSync(join(destination!, "retained.bin"))); }
      else if (phase === "prune") assert.equal(fs.existsSync(dir), false);
      else { assert.equal(fs.existsSync(dir), true); assert.equal(fs.readFileSync(destination!, "utf8"), "PRESERVED_BYTES"); }
    }
  });

  test("Retirement chains recording and release faults without erasing admitted effects", (t) => {
    for (const phase of ["compound", "queued-release", "handled-record", "success-release", "read-status-release"] as const) {
      const { root, add } = fixture(t, phase !== "handled-record"); const dir = add(phase, false);
      const journal = join(root, "retention.jsonl"); const journalLock = mutationLockPath(journal); const lifecycleLock = mutationLockPath(join(dir, ".lifecycle"));
      const original = new Error("operation underlying cause"); const format = new Error("format fault"); let formattingCalls = 0;
      const primary = phase === "read-status-release" ? undefined : new AggregateError([original, undefined], "original compound", { cause: original });
      if (primary) Object.defineProperty(primary, "message", { get() { formattingCalls++; throw format; } });
      const recordFault = new Error("record persistence fault", { cause: original });
      const journalRelease = new Error("journal release fault"); const lifecycleRelease = new Error("lifecycle release fault");
      const remove = fs.rmSync, write = fs.writeFileSync, rename = fs.renameSync, mkdir = fs.mkdirSync;
      let writes = 0, actions = 0, failedAttempts = 0, handledCommitted = false; let journalReleases = 0, lifecycleReleases = 0;
      const hooks = [
        t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
          if (String(args[0]).startsWith(journal + ".") && String(args[0]).endsWith(".tmp")) {
            writes++; const records = String(args[1]).trim().split("\n").map(line => JSON.parse(line));
            if (records.at(-1)?.outcome === "failed") { failedAttempts++; if (phase === "compound") throw recordFault; }
          }
          return write(...args);
        }),
        t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
          const result = rename(from, to);
          if (phase === "handled-record" && String(to) === journal) {
            const records = fs.readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line));
            if (records.at(-1)?.outcome === "handled") { handledCommitted = true; throw recordFault; }
          }
          return result;
        }),
        t.mock.method(fs, "rmSync", (path: fs.PathLike, options?: fs.RmOptions) => {
          const result = remove(path, options);
          if (String(path) === dir) { actions++; if (phase === "compound") throw primary; }
          return result;
        }),
        t.mock.method(fs, "mkdirSync", ((...args: Parameters<typeof fs.mkdirSync>) => {
          const path = String(args[0]);
          if (path.startsWith(journalLock + ".reclaim.") && path.endsWith(".pending")) {
            journalReleases++;
            if (phase === "queued-release" || (phase === "compound" && writes >= 2)) throw journalRelease;
          }
          if (path.startsWith(lifecycleLock + ".reclaim.") && path.endsWith(".pending")) {
            lifecycleReleases++;
            if (phase === "compound" || phase === "success-release" || phase === "read-status-release") throw lifecycleRelease;
          }
          return Reflect.apply(mkdir, fs, args);
        }) as typeof fs.mkdirSync),
      ];
      syncBuiltinESMExports(); let rejected = false; let caught: unknown;
      try { retainRun(dir, "prune", {}, () => {
        if (phase === "read-status-release") throw primary;
        return { ...JSON.parse(fs.readFileSync(join(dir, "run.json"), "utf8")), status: "done" };
      }); } catch (error) { rejected = true; caught = error; }
      finally { for (const hook of hooks.reverse()) hook.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(rejected, true); assert.equal(lifecycleReleases, 1);
      const records = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
      if (phase === "compound") {
        assert.ok(caught instanceof AggregateError); assert.equal(caught.cause, primary);
        assert.equal(caught.errors.length, 4); assert.equal(caught.errors[0], primary); assert.equal(caught.errors[1], format); assert.equal(caught.errors[3], lifecycleRelease);
        assert.ok(primary instanceof AggregateError); assert.deepEqual(primary.errors, [original, undefined]); assert.equal(primary.cause, original);
        const recording = caught.errors[2]; assert.ok(recording instanceof AggregateError);
        assert.deepEqual(recording.errors, [recordFault, journalRelease]); assert.equal(recording.cause, recordFault);
        assert.equal(Object.getOwnPropertyDescriptor(caught, "cause")?.enumerable, false);
        assert.equal(Object.getOwnPropertyDescriptor(caught, "errors")?.enumerable, false);
        assert.equal(formattingCalls, 1); assert.equal(actions, 1); assert.equal(failedAttempts, 1); assert.equal(journalReleases, 2);
        assert.deepEqual(records.map(record => record.outcome), ["queued"]); assert.equal(fs.existsSync(dir), false);
      } else if (phase === "queued-release") {
        assert.equal(caught, journalRelease); assert.equal(actions, 0); assert.equal(failedAttempts, 0);
        assert.deepEqual(records.map(record => record.outcome), ["queued"]); assert.equal(fs.existsSync(dir), true);
      } else if (phase === "handled-record") {
        assert.equal(caught, recordFault); assert.equal(handledCommitted, true); assert.equal(actions, 1); assert.equal(failedAttempts, 1);
        assert.deepEqual(records.map(record => record.outcome), ["queued", "handled", "failed"]); assert.equal(fs.existsSync(dir), false);
        assert.ok(records.every(record => record.id === records[0].id));
      } else if (phase === "success-release") {
        assert.equal(caught, lifecycleRelease); assert.equal(actions, 1); assert.equal(failedAttempts, 0);
        assert.deepEqual(records.map(record => record.outcome), ["queued", "handled"]); assert.equal(fs.existsSync(dir), false);
      } else {
        assert.ok(caught instanceof AggregateError); assert.deepEqual(caught.errors, [undefined, lifecycleRelease]); assert.equal(caught.cause, undefined);
        assert.equal(Object.hasOwn(caught, "cause"), true); assert.equal(writes, 0); assert.equal(actions, 0); assert.equal(fs.existsSync(dir), true);
      }
    }
  });

  test("Manual retirement refuses a status reader redirect to a different owned directory", (t) => {
    const { add } = fixture(t);
    const source = add("source");
    const target = add("target");
    const before = snapshot(target);
    assert.throws(() => retainRun(source, "prune", {}, () => ({ run: "target", state_dir: target, status: "done" })), /state directory changed/);
    assert.deepEqual(snapshot(target), before);
    assert.equal(fs.existsSync(source), true);
  });
});
