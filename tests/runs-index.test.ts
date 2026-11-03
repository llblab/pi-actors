/**
 * Run-state discovery regressions.
 * Covers explicit depth truncation and unbounded teardown discovery.
 */

import assert from "node:assert/strict";
import { parseDocument } from "yaml";
import childProcess, { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { acquireFileMutationLock, mutationLockPath, writeJsonAtomic } from "../lib/file-state.ts";

import * as RunIndex from "../lib/runs-index.ts";
import { discoverRunStateDirs } from "../lib/runs-index.ts";
import { claimRunStateDirectory } from "../lib/runs-ownership.ts";

test("Run discovery reports depth truncation instead of silently omitting state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-run-discovery-"));
  try {
    let nested = root;
    for (let depth = 0; depth < 10; depth += 1) {
      nested = join(nested, `level-${depth}`);
      await mkdir(nested);
    }
    await writeFile(join(nested, "run.json"), "{}\n");
    const bounded = discoverRunStateDirs(root, 4);
    assert.equal(bounded.stateDirs.length, 0);
    assert.equal(
      bounded.issues.some((issue) => issue.reason === "depth_truncated"),
      true,
    );
    const unbounded = discoverRunStateDirs(root, Number.POSITIVE_INFINITY);
    assert.deepEqual(unbounded.stateDirs, [nested]);
    assert.deepEqual(unbounded.issues, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function recordedDirectory(root: string, name: string, owner = "session-a") {
  const stateDir = claimRunStateDirectory(join(root, name), name);
  const status = { run: name, state_dir: stateDir, ownerId: owner, run_instance_id: `generation-${name}-1`,
    status: "done", createdAt: "2001-01-01T00:00:00.000Z", progress: { updatedAt: "2001-01-01T00:00:00.000Z" } };
  await writeFile(join(stateDir, "run.json"), `${JSON.stringify(status)}\n`);
  return status;
}

function navigation(root: string, session: string, priority?: RunIndex.RunNavigationPriority): any {
  const read = (RunIndex as unknown as { readRunSessionNavigation?: (root: string, session: string, priority?: RunIndex.RunNavigationPriority) => unknown }).readRunSessionNavigation;
  assert.equal(typeof read, "function");
  return read!(root, session, priority);
}

async function savedIndex(root: string): Promise<{ entries: RunIndex.RunStateIndexEntry[] }> {
  return JSON.parse(await readFile(join(root, "index.json"), "utf8"));
}

function register(root: string, status: Record<string, unknown>): void {
  const operation = (RunIndex as unknown as { registerRunStateDirectory?: (root: string, stateDir: string, status: Record<string, unknown>) => void }).registerRunStateDirectory;
  assert.equal(typeof operation, "function", "the real index owner must register directories");
  operation!(root, String(status.state_dir), status);
}

test("Run navigation is session-filtered root-first metadata without scans, native probes or file bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-navigation-"));
  try {
    const parent = await recordedDirectory(root, "parent");
    const child = { ...await recordedDirectory(root, "child"), delivery_parent: {
      run: parent.run, run_instance_id: parent.run_instance_id, state_dir: parent.state_dir } };
    await writeFile(join(child.state_dir, "run.json"), JSON.stringify(child));
    const foreign = await recordedDirectory(root, "foreign", "other-session");
    await writeFile(join(parent.state_dir, "result.json"), "RAW_BODY_NEVER_IN_NAVIGATION");
    await mkdir(join(parent.state_dir, "evidence"));
    await writeFile(join(parent.state_dir, "evidence", "sessions.json"), "SESSION_BODY_NEVER_IN_NAVIGATION");
    await writeFile(join(child.state_dir, "stderr.log"), Buffer.from([0xff, 0x00])); // Format hints never certify text decoding.
    await mkdir(join(parent.state_dir, "stdout.log"));
    if (process.platform !== "win32") fs.symlinkSync(join(foreign.state_dir, "result.json"), join(parent.state_dir, "context-index.json"));
    register(root, parent); register(root, child); register(root, foreign);
    const before = await readFile(join(root, "index.json"));
    let scans = 0, probes = 0, foreignReads = 0, bodyOpens = 0;
    const readdir = mock.method(fs, "readdirSync", () => { scans++; throw new Error("Forbidden navigation directory scan"); });
    const kill = mock.method(process, "kill", () => { probes++; throw new Error("Forbidden navigation process probe"); });
    const lstat = fs.lstatSync;
    const inspect = mock.method(fs, "lstatSync", (path: fs.PathLike, ...args: any[]) => {
      if (String(path).startsWith(foreign.state_dir)) foreignReads++;
      return Reflect.apply(lstat, fs, [path, ...args]);
    });
    const open = fs.openSync;
    const opened = mock.method(fs, "openSync", (path: fs.PathLike, ...args: any[]) => {
      if (/\/(result\.json|context-index\.json|execution\.json|trace\.jsonl|controls\.jsonl|stdout\.log|stderr\.log|sessions\.json)$/.test(String(path))) bodyOpens++;
      return Reflect.apply(open, fs, [path, ...args]);
    });
    syncBuiltinESMExports();
    let value: any;
    try { value = navigation(root, "session-a"); }
    finally { readdir.mock.restore(); kill.mock.restore(); inspect.mock.restore(); opened.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(scans, 0); assert.equal(probes, 0); assert.equal(foreignReads, 0); assert.equal(bodyOpens, 0);
    assert.equal(value.state, "available");
    assert.equal(value.file_inventory_scope, "canonical_starting_locations");
    assert.deepEqual(value.items.map((item: any) => [item.run, item.depth]), [["parent", 0], ["child", 1]]);
    const formats = { context_index: "json", result: "json", metadata: "json", execution: "json", published_sessions: "json", trace: "jsonl", control: "jsonl", stdout: "text", stderr: "text" };
    for (const item of value.items) for (const file of item.files) {
      assert.equal(file.format_hint, formats[file.role as keyof typeof formats]);
      assert.equal(Object.isFrozen(file), true);
    }
    const binary = value.items[1].files.find((file: any) => file.role === "stderr");
    assert.equal(binary.state, "present"); assert.equal(binary.bytes_total, 2); assert.equal(binary.format_hint, "text");
    assert.equal(value.items[0].files[0].role, "context_index");
    assert.equal(value.items[0].files[0].path, null);
    assert.equal(Object.isFrozen(value) && Object.isFrozen(value.items) && Object.isFrozen(value.items[0].files), true);
    assert.equal(value.items[0].files.find((file: any) => file.role === "result").path, join(parent.state_dir, "result.json"));
    assert.equal(value.items[0].files.find((file: any) => file.role === "stdout").state, "unavailable");
    assert.equal(value.items[0].files.find((file: any) => file.role === "stderr").state, "missing");
    const sessions = value.items[0].files.find((file: any) => file.role === "published_sessions");
    assert.equal(sessions.state, "present"); assert.equal(sessions.path, join(parent.state_dir, "evidence", "sessions.json"));
    assert.equal(sessions.bytes_total, Buffer.byteLength("SESSION_BODY_NEVER_IN_NAVIGATION"));
    assert.equal(value.items[1].files.find((file: any) => file.role === "published_sessions").state, "missing");
    assert.doesNotMatch(JSON.stringify(value), /RAW_BODY_NEVER|SESSION_BODY_NEVER|other-session|foreign/);
    assert.deepEqual(await readFile(join(root, "index.json")), before);
    assert.equal(navigation(root, "other-session").items.length, 1);
    assert.equal(navigation(root, "absent-session").items.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Direct Run file navigation checks current session and generation without catalog, bodies, work or time", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-directory-navigation-"));
  try {
    const meta = await recordedDirectory(root, "selected");
    await writeFile(join(meta.state_dir, "result.json"), "BODY_MUST_NOT_BE_READ");
    const read = (RunIndex as any).readRunDirectoryNavigation;
    assert.equal(typeof read, "function");
    const before = await readFile(join(meta.state_dir, "run.json"));
    const originalOpen = fs.openSync;
    const opened: string[] = [];
    const open = mock.method(fs, "openSync", (path: fs.PathLike, ...args: any[]) => {
      opened.push(String(path));
      assert.ok(!/result\.json|context-index\.json|index\.json$/.test(String(path)), "No catalog or file-body reads");
      return Reflect.apply(originalOpen, fs, [path, ...args]);
    });
    const scan = mock.method(fs, "readdirSync", () => { throw new Error("No scans"); });
    const kill = mock.method(process, "kill", () => { throw new Error("No process probes"); });
    const now = mock.method(Date, "now", () => { throw new Error("No timing"); });
    syncBuiltinESMExports();
    let value: any;
    try {
      assert.deepEqual(read(meta.state_dir, meta, undefined), { state: "unavailable", reason: "session_unavailable" });
      assert.deepEqual(read(meta.state_dir, meta, "foreign"), { state: "unavailable", reason: "session_mismatch" });
      assert.equal(opened.length, 0, "Foreign/unavailable session is filtered before filesystem observations");
      value = read(meta.state_dir, meta, "session-a");
      assert.equal(read(meta.state_dir, { ...meta, run_instance_id: "stale" }, "session-a").reason, "identity_mismatch");
    } finally { open.mock.restore(); scan.mock.restore(); kill.mock.restore(); now.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(value.state, "available"); assert.equal(value.run, meta.run); assert.equal(value.run_instance_id, meta.run_instance_id);
    assert.equal(value.directory, meta.state_dir); assert.equal(value.content_scope, "file_locations_only");
    assert.equal(value.file_inventory_scope, "canonical_starting_locations"); assert.equal(value.files.length, 9);
    assert.ok(Object.isFrozen(value) && Object.isFrozen(value.files) && value.files.every(Object.isFrozen));
    assert.equal(value.files.find((f: any) => f.role === "metadata").path, join(meta.state_dir, "run.json"));
    assert.equal(value.files.find((f: any) => f.role === "result").bytes_total, Buffer.byteLength("BODY_MUST_NOT_BE_READ"));
    assert.equal(value.files.find((f: any) => f.role === "context_index").path, null);
    assert.equal(value.files.find((f: any) => f.role === "context_index").state, "missing");
    assert.doesNotMatch(JSON.stringify(value), /BODY_MUST_NOT_BE_READ/);
    assert.deepEqual(await readFile(join(meta.state_dir, "run.json")), before);
    assert.equal(fs.existsSync(join(root, "index.json")), false, "No registration/read repair is required");

    const stat = fs.lstatSync;
    let replaced = false;
    const change = mock.method(fs, "lstatSync", (path: fs.PathLike, ...args: any[]) => {
      if (!replaced && String(path) === join(meta.state_dir, "stdout.log")) {
        replaced = true; fs.writeFileSync(join(meta.state_dir, "run.json"), JSON.stringify({ ...meta, run_instance_id: "replacement" }));
      }
      return Reflect.apply(stat, fs, [path, ...args]);
    });
    syncBuiltinESMExports();
    try { assert.equal(read(meta.state_dir, meta, "session-a").reason, "observation_changed"); }
    finally { change.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(replaced, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Direct Run navigation refuses an oversized whole location row instead of truncating paths", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-directory-navigation-budget-"));
  try {
    // JSON escaping, not a path beyond Darwin PATH_MAX, exhausts the encoded navigation budget.
    const nested = join(root, ...Array.from({ length: 5 }, (_, i) => String(i) + '"'.repeat(160)));
    await mkdir(nested, { recursive: true });
    const meta = await recordedDirectory(nested, "selected");
    for (const leaf of ["context-index.json", "result.json", "execution.json", "trace.jsonl", "controls.jsonl", "stdout.log", "stderr.log"]) await writeFile(join(meta.state_dir, leaf), "x");
    await mkdir(join(meta.state_dir, "evidence")); await writeFile(join(meta.state_dir, "evidence", "sessions.json"), "x");
    const value = RunIndex.readRunDirectoryNavigation(meta.state_dir, meta, "session-a");
    assert.deepEqual(value, { state: "unavailable", reason: "response_too_large" });
    assert.ok(!JSON.stringify(value).includes(nested));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Frozen file navigation decoding is pure, literal, schema-only and rejects substituted paths or callbacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-navigation-data-"));
  try {
    const meta = await recordedDirectory(root, "selected");
    const observed = RunIndex.readRunDirectoryNavigation(meta.state_dir, meta, "session-a");
    assert.equal(observed.state, "available");
    const input = JSON.parse(JSON.stringify(observed)), expected = structuredClone(input);
    const originals = { readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, statSync: fs.statSync, lstatSync: fs.lstatSync };
    const kill = process.kill, now = Date.now, forbidden = () => assert.fail("Data decoding must not observe sources/time/native state");
    Object.assign(fs, { readFileSync: forbidden, readdirSync: forbidden, statSync: forbidden, lstatSync: forbidden }); process.kill = forbidden as typeof process.kill; Date.now = forbidden;
    syncBuiltinESMExports();
    let decoded: any;
    try {
      decoded = RunIndex.decodeRunDirectoryNavigation(input);
      for (const bad of [{ ...input, extra: true }, { ...input, directory: "relative" }, { ...input, files: [] },
        { ...input, files: input.files.map((file: any, i: number) => i === 2 ? { ...file, path: join(root, "foreign.json") } : file) },
        { ...input, files: input.files.map((file: any, i: number) => i === 2 ? { ...file, bytes_total: -1 } : file) },
        { state: "unavailable", reason: "invented" }, { state: "unavailable", reason: "identity_unavailable", directory: root },
        Object.defineProperty({}, "state", { get: forbidden })]) assert.throws(() => RunIndex.decodeRunDirectoryNavigation(bad), /navigation data/);
    } finally { Object.assign(fs, originals); process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
    input.files[2].path = "mutated";
    assert.deepEqual(decoded, expected); assert.ok(Object.isFrozen(decoded) && Object.isFrozen(decoded.files) && decoded.files.every(Object.isFrozen));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Run navigation ranks observed failed subtrees in both root orders without new observations or catalog changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-navigation-priority-"));
  try {
    const older = await recordedDirectory(root, "older"), parent = await recordedDirectory(root, "parent");
    const failed = await recordedDirectory(root, "failed"), healthy = await recordedDirectory(root, "healthy");
    const latest = await recordedDirectory(root, "latest"), foreign = await recordedDirectory(root, "foreign", "other-session");
    for (const [child, ancestor] of [[parent, older], [failed, parent], [healthy, older]]) {
      await writeFile(join(child.state_dir, "run.json"), JSON.stringify({ ...child,
        delivery_parent: { run: ancestor.run, run_instance_id: ancestor.run_instance_id, state_dir: ancestor.state_dir } }));
    }
    for (const row of [older, parent, failed, healthy, latest, foreign]) register(root, { ...row, status: "failed" }); // Cached status never supplies ranking.
    const before = await readFile(join(root, "index.json"));
    const lstat = fs.lstatSync, open = fs.openSync;
    let foreignReads = 0, scans = 0, probes = 0, bodies = 0;
    const inspect = mock.method(fs, "lstatSync", (path: fs.PathLike, ...args: any[]) => {
      if (String(path).startsWith(foreign.state_dir)) foreignReads++;
      return Reflect.apply(lstat, fs, [path, ...args]);
    });
    const opened = mock.method(fs, "openSync", (path: fs.PathLike, ...args: any[]) => {
      if (/\/(result\.json|context-index\.json|execution\.json|trace\.jsonl|controls\.jsonl|stdout\.log|stderr\.log|sessions\.json)$/.test(String(path))) bodies++;
      return Reflect.apply(open, fs, [path, ...args]);
    });
    const scan = mock.method(fs, "readdirSync", () => { scans++; throw Error("Forbidden ranking scan"); });
    const probe = mock.method(process, "kill", () => { probes++; throw Error("Forbidden ranking native probe"); });
    syncBuiltinESMExports();
    let recent: any, failuresFirst: any, unmatched: any;
    try {
      recent = navigation(root, "session-a", { root_order: "latest_registration", failed: [failed, foreign] });
      failuresFirst = navigation(root, "session-a", { root_order: "failed_subtrees_first", failed: [failed, foreign] });
      unmatched = navigation(root, "session-a", { root_order: "failed_subtrees_first", failed: [
        { ...failed, run_instance_id: "wrong-generation" }, { ...failed, state_dir: healthy.state_dir }, foreign,
      ] });
    } finally { inspect.mock.restore(); opened.mock.restore(); scan.mock.restore(); probe.mock.restore(); syncBuiltinESMExports(); }
    assert.deepEqual([foreignReads, scans, probes, bodies], [0, 0, 0, 0]);
    assert.deepEqual(recent.items.map((item: any) => [item.run, item.depth]), [["latest", 0], ["older", 0], ["parent", 1], ["failed", 2], ["healthy", 1]]);
    assert.deepEqual(failuresFirst.items.map((item: any) => item.run), ["older", "parent", "failed", "healthy", "latest"]);
    assert.deepEqual(unmatched.items.map((item: any) => item.run), ["latest", "older", "healthy", "parent", "failed"]);
    assert.deepEqual(recent.priority, { root_order: "latest_registration", basis: "observed_failed_rows" });
    assert.deepEqual(failuresFirst.priority, { root_order: "failed_subtrees_first", basis: "observed_failed_rows" });
    assert.equal(Object.isFrozen(recent.priority), true); assert.equal(recent.total, 5); assert.equal(recent.omitted, 0);
    assert.deepEqual(await readFile(join(root, "index.json")), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Run navigation rechecks published-session parent locations before returning any path", async (t) => {
  if (process.platform === "win32") { t.skip("Directory symlink fixture needs POSIX symlink permissions"); return; }
  const root = await mkdtemp(join(tmpdir(), "pi-actors-navigation-session-parent-"));
  try {
    const first = await recordedDirectory(root, "first"), later = await recordedDirectory(root, "later");
    const evidence = join(first.state_dir, "evidence"), retained = join(first.state_dir, "retained-evidence");
    await mkdir(evidence); await writeFile(join(evidence, "sessions.json"), "BODY_MUST_NOT_REACH_MAP");
    register(root, later); register(root, first); const before = await readFile(join(root, "index.json"));
    const open = fs.openSync; let changed = false;
    const opened = mock.method(fs, "openSync", (path: fs.PathLike, ...args: any[]) => {
      if (!changed && String(path) === join(later.state_dir, "run.json")) {
        changed = true; fs.renameSync(evidence, retained); fs.symlinkSync(retained, evidence, "dir");
      }
      return Reflect.apply(open, fs, [path, ...args]);
    });
    syncBuiltinESMExports(); let reading: any;
    try { reading = navigation(root, "session-a"); }
    finally { opened.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(changed, true); assert.deepEqual(reading, { state: "unavailable", reason: "catalog_unavailable" });
    assert.deepEqual(await readFile(join(root, "index.json")), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Run navigation refuses stale directory identity, preserves damaged catalogs and bounds whole rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-navigation-boundary-"));
  try {
    assert.equal(navigation(root, "session-a").state, "unavailable");
    const actual = await recordedDirectory(root, "actual");
    register(root, actual);
    await writeFile(join(actual.state_dir, "run.json"), JSON.stringify({ ...actual, ownerId: "changed-session" }));
    const stale = navigation(root, "session-a");
    assert.equal(stale.items[0].state, "unavailable"); assert.equal(stale.items[0].directory, null);
    assert.doesNotMatch(JSON.stringify(stale), /changed-session/);
    await writeFile(join(actual.state_dir, "run.json"), JSON.stringify(actual));
    for (let i = 0; i < 30; i++) register(root, await recordedDirectory(root, `row-${i}`));
    const value = navigation(root, "session-a");
    assert.equal(value.omitted > 0, true);
    assert.equal(value.shown + value.omitted, value.total);
    assert.equal(Buffer.byteLength(JSON.stringify(value)) <= 16384, true);
    const ranked = navigation(root, "session-a", { root_order: "failed_subtrees_first", failed: [actual] });
    assert.equal(ranked.items[0].run, "actual"); assert.equal(ranked.shown + ranked.omitted, ranked.total);
    assert.equal(ranked.omitted > 0, true); assert.equal(Buffer.byteLength(JSON.stringify(ranked)) <= 16384, true);
    await writeFile(join(root, "index.json"), "{broken");
    assert.equal(navigation(root, "session-a").state, "unavailable");
    assert.equal(await readFile(join(root, "index.json"), "utf8"), "{broken");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Run navigation rejects source replacement and duplicate catalogs, and does not present cyclic paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-navigation-frames-"));
  try {
    const a = await recordedDirectory(root, "a"), b = await recordedDirectory(root, "b");
    register(root, a); register(root, b);
    const before = await readFile(join(root, "index.json"));
    const lstat = fs.lstatSync;
    let changes = 0;
    const patched = mock.method(fs, "lstatSync", (path: fs.PathLike, ...args: any[]) => {
      if (String(path) === join(a.state_dir, "stderr.log")) {
        changes++;
        fs.writeFileSync(join(a.state_dir, "run.json"), JSON.stringify({ ...a, run_instance_id: "changed-generation" }));
      }
      return Reflect.apply(lstat, fs, [path, ...args]);
    });
    syncBuiltinESMExports();
    let changed: any;
    try { changed = navigation(root, "session-a"); }
    finally { patched.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(changes, 1); assert.equal(changed.state, "unavailable");
    assert.deepEqual(await readFile(join(root, "index.json")), before);
    await writeFile(join(a.state_dir, "run.json"), JSON.stringify(a));
    const catalog = await savedIndex(root);
    await writeFile(join(root, "index.json"), JSON.stringify({ ...catalog, entries: [...catalog.entries, catalog.entries[0]] }));
    assert.equal(navigation(root, "session-a").state, "unavailable");
    await writeFile(join(root, "index.json"), before);
    for (const [row, parent] of [[a, b], [b, a]]) await writeFile(join(row.state_dir, "run.json"), JSON.stringify({ ...row,
      delivery_parent: { run: parent.run, run_instance_id: parent.run_instance_id, state_dir: parent.state_dir } }));
    const cyclic = navigation(root, "session-a");
    assert.equal(cyclic.items.length, 2);
    assert.equal(cyclic.items.every((item: any) => item.reason === "lineage_cycle" && item.directory === null && item.files.length === 0), true);
    const rankedCycle = navigation(root, "session-a", { root_order: "failed_subtrees_first", failed: [a] });
    assert.equal(rankedCycle.items.every((item: any) => item.reason === "lineage_cycle" && item.directory === null && item.files.length === 0), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Run catalog registers exact generations as a latest-first directory set without status touches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-catalog-order-"));
  const catalog = join(root, "agent", "tmp", "pi-actors", "runs");
  try {
    const a = await recordedDirectory(catalog, "a");
    const b = await recordedDirectory(catalog, "b", "session-b");
    const external = await recordedDirectory(join(root, "external"), "c");
    register(catalog, a); register(catalog, b); register(catalog, a);
    assert.deepEqual((await savedIndex(catalog)).entries.map(row => row.run), ["a", "b"]);
    const next = { ...a, run_instance_id: "generation-a-2" };
    await writeFile(join(a.state_dir, "run.json"), JSON.stringify(next));
    register(catalog, next); register(catalog, external);
    const statuses = new Map([[a.state_dir, next], [b.state_dir, { ...b, progress: { updatedAt: "2099-01-01T00:00:00.000Z" } }],
      [external.state_dir, external]]);
    const portLocks: boolean[] = [];
    RunIndex.rebuildRunStateIndex(catalog, path => {
      portLocks.push(fs.existsSync(mutationLockPath(join(catalog, "index.json"))));
      return statuses.get(path)!;
    });
    assert.deepEqual(portLocks, [false, false]);
    const saved = await savedIndex(catalog);
    assert.deepEqual(saved.entries.map(row => row.run), ["c", "a", "b"]);
    assert.deepEqual(saved.entries.map(row => row.run_instance_id), [external.run_instance_id, next.run_instance_id, b.run_instance_id]);
    const bytes = await readFile(join(catalog, "index.json"));
    const readJson = (path: string) => path.endsWith("index.json") ? saved as unknown as Record<string, unknown> : undefined;
    assert.equal(RunIndex.listRuns(catalog, path => statuses.get(path)!, readJson).length, 3);
    assert.deepEqual(await readFile(join(catalog, "index.json")), bytes);
    const ownerless: Record<string, unknown> = { ...next };
    delete ownerless.ownerId;
    await writeFile(join(a.state_dir, "run.json"), JSON.stringify(ownerless));
    register(catalog, ownerless);
    assert.equal(Object.hasOwn((await savedIndex(catalog)).entries.find(row => row.run === "a")!, "ownerId"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Run inventory displays and filters current observations, never cached registration status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inventory-fresh-"));
  try {
    const current = new Map<string, Record<string, unknown>>();
    for (const [run, cached, status] of [["done", "running", "done"], ["failed", "running", "failed"],
      ["active", "done", "running"], ["unreadable", "running", "running"]]) {
      const recorded = { ...await recordedDirectory(root, run), status: cached };
      await writeFile(join(recorded.state_dir, "run.json"), JSON.stringify(recorded)); register(root, recorded);
      current.set(recorded.state_dir, { ...recorded, status });
    }
    const path = join(root, "index.json"), cached = await readFile(path);
    const readJson = (path: string) => { try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return undefined; } };
    const cases: [string | undefined, string[]][] = [[undefined, ["active", "done", "failed"]], ["all", ["active", "done", "failed"]],
      ["running", ["active"]], ["active", ["active"]], ["done", ["done"]], ["failed", ["failed"]], ["terminal", ["done", "failed"]]];
    for (const catalog of [cached, Buffer.from("{broken")]) {
      await writeFile(path, catalog);
      for (const [filter, expected] of cases) {
        let observations = 0, underLock = 0;
        const listed = RunIndex.listRuns(root, directory => {
          observations++; if (fs.existsSync(mutationLockPath(path))) underLock++;
          if (directory === join(root, "unreadable")) throw new Error("Controlled unavailable observation");
          return current.get(directory)!;
        }, readJson, filter);
        assert.equal(underLock, 0); assert.equal(observations, 4);
        assert.deepEqual(listed.map(row => row.run).sort(), expected);
        for (const row of listed) assert.equal(row.status, current.get(String(row.state_dir))!.status);
        assert.deepEqual(await readFile(path), catalog);
      }
    }
    await writeFile(path, cached);
    const previous = current.get(join(root, "done"))!;
    current.set(join(root, "done"), { ...previous, run: "replacement", run_instance_id: "replacement-generation", ownerId: "new-owner", status: "failed" });
    const replaced = RunIndex.listRuns(root, directory => current.get(directory)!, readJson, "failed");
    assert.deepEqual(replaced.map(row => row.run).sort(), ["failed", "replacement"]);
    assert.deepEqual(await readFile(path), cached);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Common launch catalog registration follows lifecycle release and isolates exact publication failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-launch-catalog-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const AsyncRuns = await import("../lib/async-runs.ts");
  const { compactAsyncRunStatus } = await import("../lib/tools-response.ts");
  const catalogRoot = join(root, "tmp", "pi-actors", "runs"), index = join(catalogRoot, "index.json");
  await mkdir(catalogRoot, { recursive: true });
  const external = await recordedDirectory(catalogRoot, "external"); register(catalogRoot, external);
  const original = await readFile(index);
  let spawns = 0, releases = 0, errorSerializations = 0;
  const native = mock.method(childProcess, "spawn", () => { spawns++; return { pid: undefined, unref() { releases++; } } as any; });
  syncBuiltinESMExports();
  try {
    for (const phase of ["healthy", "corrupt", "read_error", "pre_rename", "post_rename"]) {
      await writeFile(index, phase === "corrupt" ? "{PRIVATE_CATALOG_CANARY" : original);
      const stateDir = join(root, `case-${phase}`), run = `launch-${phase}`;
      const primary = new AggregateError([Object.assign(new Error("PRIVATE_CATALOG_EIO"), { code: "EIO" }), new Error("retained secondary cause")], "private catalog failure");
      Object.defineProperty(primary, "toJSON", { get() { errorSerializations++; throw new Error("Private failure must not be serialized"); } });
      const open = fs.openSync, rename = fs.renameSync;
      const observations: { lifecycle: boolean; catalog: boolean; trace: boolean }[] = [];
      let replacements = 0;
      const opened = mock.method(fs, "openSync", (path: fs.PathLike, ...args: any[]) => {
        if (String(path) === index) {
          observations.push({ lifecycle: fs.existsSync(mutationLockPath(join(stateDir, ".lifecycle"))),
            catalog: fs.existsSync(mutationLockPath(index)), trace: fs.readFileSync(join(stateDir, "trace.jsonl"), "utf8").includes('"kind":"run.start"') });
          if (phase === "read_error") throw primary;
        }
        return Reflect.apply(open, fs, [path, ...args]);
      });
      const renamed = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) === index) {
          replacements++;
          if (phase === "pre_rename") throw primary;
          if (phase === "post_rename") { rename(from, to); throw primary; }
        }
        return rename(from, to);
      });
      syncBuiltinESMExports(); let meta: ReturnType<typeof AsyncRuns.startRun>;
      try { meta = AsyncRuns.startRun({ run_id: run, state_dir: stateDir, ownerId: "session-launch", template: "controlled-no-native-work" }, root); }
      finally { opened.mock.restore(); renamed.mock.restore(); syncBuiltinESMExports(); }
      // The controlled spawn port has no native PID: this proves metadata/error ordering, not an actual process launch.
      assert.equal(meta!.pid, 0); assert.equal(meta!.status, "running");
      assert.deepEqual(observations, [{ lifecycle: false, catalog: true, trace: true }]);
      assert.equal(fs.existsSync(join(stateDir, "result.json")), false); assert.equal(fs.existsSync(join(stateDir, "terminal-handled.json")), false);
      const saved = JSON.parse(await readFile(join(stateDir, "run.json"), "utf8"));
      assert.equal(saved.run_instance_id, meta!.run_instance_id); assert.equal(saved.status, "running");
      assert.equal(Object.hasOwn(saved, "catalog_registration"), false); assert.equal(Object.hasOwn(saved, "catalog_registration_error"), false);
      if (phase === "healthy") {
        assert.equal(Object.hasOwn(meta!, "catalog_registration"), false);
        assert.equal(Object.hasOwn(meta!, "catalog_registration_error"), false);
      } else {
        assert.deepEqual(meta!.catalog_registration, { state: "unavailable", reason: "catalog_registration_failed" });
        if (phase === "corrupt") assert.ok(meta!.catalog_registration_error instanceof SyntaxError);
        else assert.equal(meta!.catalog_registration_error, primary);
        assert.equal(Object.getOwnPropertyDescriptor(meta!, "catalog_registration_error")!.enumerable, false);
        assert.doesNotMatch(JSON.stringify({ ...meta! }), /PRIVATE_CATALOG|catalog_registration_error|retained secondary/);
      }
      const metadata = parseDocument(compactAsyncRunStatus(meta!), { version: "1.2", schema: "core", uniqueKeys: true });
      assert.deepEqual(metadata.errors, []); assert.deepEqual(metadata.warnings, []);
      assert.equal(metadata.get("catalog"), phase === "healthy" ? undefined : "unavailable");
      assert.equal(errorSerializations, 0);
      assert.equal(replacements, ["healthy", "pre_rename", "post_rename"].includes(phase) ? 1 : 0);
      if (["healthy", "post_rename"].includes(phase)) {
        const rows = (await savedIndex(catalogRoot)).entries;
        assert.equal(rows[0].run, run); assert.equal(rows[0].run_instance_id, meta!.run_instance_id);
        assert.equal(rows[0].ownerId, "session-launch"); assert.equal(rows[0].state_dir, stateDir);
        assert.equal(rows.some(row => row.run === external.run), true);
      } else assert.deepEqual(await readFile(index), phase === "corrupt" ? Buffer.from("{PRIVATE_CATALOG_CANARY") : original);
    }
    assert.equal(spawns, 5); assert.equal(releases, 5);
    const before = await readFile(index);
    assert.throws(() => AsyncRuns.startRun({ run_id: "invalid" }, root), /requires file or template/);
    assert.deepEqual(await readFile(index), before); assert.equal(spawns, 5);
  } finally {
    native.mock.restore(); syncBuiltinESMExports();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Run catalog refuses DTO identity/path claims and unpublished state before touching the catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-catalog-identity-"));
  try {
    const actual = await recordedDirectory(root, "actual");
    register(root, actual);
    const before = await readFile(join(root, "index.json"));
    for (const patch of [{ ownerId: "foreign" }, { run: "foreign" }, { run_instance_id: "foreign" }, { state_dir: join(root, "missing") }]) {
      assert.throws(() => register(root, { ...actual, ...patch }), /registration|identity/i);
      assert.deepEqual(await readFile(join(root, "index.json")), before);
    }
    const prepared = claimRunStateDirectory(join(root, "prepared"), "prepared");
    const metadata = { ...actual, run: "prepared", state_dir: prepared };
    await writeFile(join(prepared, "prepared-run.json"), JSON.stringify(metadata));
    assert.throws(() => register(root, metadata), /registration|identity/i);
    assert.deepEqual(await readFile(join(root, "index.json")), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Run catalog preserves corrupt bytes while legacy inventory remains available without repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-catalog-corrupt-"));
  try {
    const actual = await recordedDirectory(root, "actual");
    const index = join(root, "index.json");
    await writeFile(index, "{broken-json\n");
    assert.throws(() => register(root, actual), SyntaxError);
    assert.throws(() => RunIndex.rebuildRunStateIndex(root, () => actual), SyntaxError);
    const readJson = () => undefined;
    assert.equal(RunIndex.listRuns(root, () => actual, readJson).length, 1);
    assert.equal(await readFile(index, "utf8"), "{broken-json\n");
    for (const invalid of ["null", '{"entries":[null]}', '{"entries":{}}']) {
      await writeFile(index, invalid);
      assert.throws(() => register(root, actual), /catalog.*invalid/i);
      assert.equal(await readFile(index, "utf8"), invalid);
    }
    const invalidUtf8 = Buffer.from([0xff]);
    await writeFile(index, invalidUtf8);
    assert.throws(() => register(root, actual), /encoded data|encoding/i);
    assert.deepEqual(await readFile(index), invalidUtf8);
    await rm(index);
    await mkdir(index);
    assert.throws(() => register(root, actual), /regular file/);
    assert.equal(fs.statSync(index).isDirectory(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Run catalog preserves exact publication errors and actual pre/post-replacement bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-catalog-io-"));
  try {
    const a = await recordedDirectory(root, "a");
    const b = await recordedDirectory(root, "b");
    register(root, a);
    const index = join(root, "index.json");
    for (const committed of [false, true]) {
      const before = await readFile(index);
      const primary = Object.assign(new Error("Controlled catalog publication EIO"), { code: "EIO" });
      const rename = fs.renameSync;
      let attempts = 0;
      const patched = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) === index) {
          attempts++;
          if (committed) rename(from, to);
          throw primary;
        }
        return rename(from, to);
      });
      syncBuiltinESMExports();
      try { assert.throws(() => register(root, b), error => error === primary); }
      finally { patched.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(attempts, 1);
      if (committed) assert.deepEqual((await savedIndex(root)).entries.map(row => row.run), ["b", "a"]);
      else assert.deepEqual(await readFile(index), before);
      assert.equal((await fs.promises.readdir(root)).some(name => name.endsWith(".tmp")), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Run catalog rechecks source frames after locked fresh reading without changing generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-catalog-frame-"));
  try {
    const actual = await recordedDirectory(root, "actual");
    register(root, actual);
    const index = join(root, "index.json");
    const before = await readFile(index);
    const identity = fs.statSync(index);
    const read = fs.readFileSync;
    let probes = 0;
    const patched = mock.method(fs, "readFileSync", (path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const value = Reflect.apply(read, fs, [path, ...args]);
      if (typeof path === "number" && fs.fstatSync(path).ino === identity.ino) {
        probes++;
        fs.writeFileSync(join(actual.state_dir, "run.json"), JSON.stringify({ ...actual, run_instance_id: "generation-replaced" }));
      }
      return value;
    });
    syncBuiltinESMExports();
    try { assert.throws(() => register(root, actual), /observation changed/); }
    finally { patched.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(probes, 1);
    assert.deepEqual(await readFile(index), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Run catalog revalidates sources immediately before atomic replacement and preserves read EIO", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-catalog-last-fence-"));
  try {
    const actual = await recordedDirectory(root, "actual");
    register(root, actual);
    const index = join(root, "index.json");
    const before = await readFile(index);
    const write = fs.writeFileSync;
    let tempWrites = 0;
    const patched = mock.method(fs, "writeFileSync", (path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const result = Reflect.apply(write, fs, [path, ...args]);
      if (typeof path === "string" && path.startsWith(`${index}.`) && path.endsWith(".tmp")) {
        tempWrites++;
        write(join(actual.state_dir, "run.json"), JSON.stringify({ ...actual, ownerId: "replaced-owner" }));
      }
      return result;
    });
    syncBuiltinESMExports();
    try { assert.throws(() => register(root, actual), /observation changed/); }
    finally { patched.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(tempWrites, 1);
    assert.deepEqual(await readFile(index), before);
    await writeFile(join(actual.state_dir, "run.json"), JSON.stringify(actual));
    const read = fs.readFileSync;
    const identity = fs.statSync(index);
    const primary = Object.assign(new Error("Controlled catalog read EIO"), { code: "EIO" });
    let reads = 0;
    const failedRead = mock.method(fs, "readFileSync", (path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (typeof path === "number" && fs.fstatSync(path).ino === identity.ino) { reads++; throw primary; }
      return Reflect.apply(read, fs, [path, ...args]);
    });
    syncBuiltinESMExports();
    try { assert.throws(() => register(root, actual), error => error === primary); }
    finally { failedRead.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(reads, 1);
    assert.deepEqual(await readFile(index), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

interface CatalogHost {
  child: ChildProcess;
  frame: Record<string, unknown>;
  manifest: string;
  stdio: string;
  parentFrame: string;
  blocked: string;
  ready: string;
  pid: number | undefined;
  close?: { code: number | null; signal: NodeJS.Signals | null };
  persistenceFailure?: unknown;
  error?: unknown;
  settled: Promise<void>;
}

function startCatalogHost(hosts: CatalogHost[], root: string, catalog: string, status: Record<string, unknown>, slot: string, mode: string): CatalogHost {
  const manifest = join(root, `${slot}-manifest.json`);
  const blocked = join(root, `${slot}-blocked`);
  const ready = join(root, `${slot}-ready`);
  const input = join(root, `${slot}-input.json`);
  const frame = { catalog, state_dir: status.state_dir, run: status.run, run_instance_id: status.run_instance_id, ownerId: status.ownerId };
  fs.writeFileSync(input, JSON.stringify({ catalog, status, mode, manifest, ready, blocked, go: join(root, "go"), frame }));
  const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./fixtures/run-index-writer.ts", import.meta.url)), input],
    { stdio: ["ignore", "pipe", "pipe"] });
  const host: CatalogHost = { child, frame, manifest, stdio: join(root, `${slot}-stdio.json`),
    parentFrame: join(root, `${slot}-parent-frame.json`), blocked, ready, pid: child.pid, settled: Promise.resolve() };
  hosts.push(host);
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout!.on("data", chunk => { stdout.push(Buffer.from(chunk)); });
  child.stderr!.on("data", chunk => { stderr.push(Buffer.from(chunk)); });
  host.settled = new Promise(resolve => {
    child.once("error", error => { host.error = error; });
    child.once("close", (code, signal) => {
      host.close = { code, signal };
      try {
        const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
        fs.writeFileSync(host.stdio, JSON.stringify({ stdout: out.toString("utf8"), stderr: err.toString("utf8"),
          stdout_base64: out.toString("base64"), stderr_base64: err.toString("base64"), close: host.close }));
      }
      catch (error) { host.persistenceFailure = error; }
      resolve();
    });
  });
  fs.writeFileSync(host.parentFrame, JSON.stringify({ ...frame, pid: host.pid, host_exit: "not_asserted" }));
  return host;
}

async function waitForHostFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (fs.existsSync(path)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Captured catalog host did not reach ${path}`);
}

test("Run catalog concurrent real writers fresh-merge sessions and partial maintenance without lost records", { timeout: 45000 }, async () => {
  for (const sameSession of [false, true]) for (const secondMode of ["register", "rebuild"]) {
    const root = await mkdtemp(join(tmpdir(), "pi-actors-catalog-processes-"));
    const catalog = join(root, "agent", "tmp", "pi-actors", "runs");
    const hosts: CatalogHost[] = [];
    let release: (() => void) | undefined;
    let primary: unknown;
    let failed = false;
    try {
      const a = await recordedDirectory(catalog, "a", "session-a");
      const b = await recordedDirectory(catalog, "b", sameSession ? "session-a" : "session-b");
      const external = await recordedDirectory(join(root, "external"), "external");
      register(catalog, external);
      release = acquireFileMutationLock(join(catalog, "index.json"));
      startCatalogHost(hosts, root, catalog, a, "a", "register");
      startCatalogHost(hosts, root, catalog, b, "b", secondMode);
      for (const host of hosts) assert.equal(Number.isSafeInteger(host.pid) && Number(host.pid) > 0, true);
      await Promise.all(hosts.map(host => waitForHostFile(host.ready)));
      await writeFile(join(root, "go"), "go\n");
      await Promise.all(hosts.map(host => waitForHostFile(host.blocked)));
      const saved = await savedIndex(catalog);
      // Controlled fixture edit under the parent's lock, not a new production registration.
      writeJsonAtomic(join(catalog, "index.json"), { ...saved, fixture_revision: "after-both-contenders" });
      release(); release = undefined;
      await Promise.all(hosts.map(host => host.settled));
      const observed = await savedIndex(catalog) as { entries: RunIndex.RunStateIndexEntry[]; fixture_revision?: string };
      assert.equal(observed.fixture_revision, "after-both-contenders");
      assert.deepEqual(new Set(observed.entries.map(row => row.state_dir)), new Set([a.state_dir, b.state_dir, external.state_dir]));
      for (const expected of [a, b, external]) {
        const row = observed.entries.find(entry => entry.state_dir === expected.state_dir)!;
        assert.equal(row.run, expected.run); assert.equal(row.ownerId, expected.ownerId); assert.equal(row.run_instance_id, expected.run_instance_id);
      }
    } catch (error) { failed = true; primary = error; }
    finally {
      try { release?.(); fs.writeFileSync(join(root, "go"), "go\n"); }
      catch (error) { primary = failed ? new AggregateError([primary, error], "Catalog fixture release failed") : error; failed = true; }
      await Promise.all(hosts.map(host => host.settled));
      try {
        for (const host of hosts) {
          if (host.persistenceFailure) throw host.persistenceFailure;
          if (host.error) throw host.error;
          assert.deepEqual(host.close, { code: 0, signal: null });
          const actual = JSON.parse(fs.readFileSync(host.manifest, "utf8"));
          assert.deepEqual(actual, { ...host.frame, pid: host.pid, host_exit: "not_asserted", workloads: 0 });
          assert.deepEqual(JSON.parse(fs.readFileSync(host.parentFrame, "utf8")), { ...host.frame, pid: host.pid, host_exit: "not_asserted" });
          const stdio = JSON.parse(fs.readFileSync(host.stdio, "utf8"));
          assert.deepEqual(stdio.close, host.close);
          assert.equal(Buffer.from(stdio.stdout_base64, "base64").toString("utf8"), stdio.stdout);
          assert.equal(Buffer.from(stdio.stderr_base64, "base64").toString("utf8"), stdio.stderr);
          assert.equal(stdio.stderr, "");
          assert.deepEqual(JSON.parse(stdio.stdout.trim()), { kind: "catalog-writer-settled", frame: actual });
          const metadata = JSON.parse(fs.readFileSync(join(String(host.frame.state_dir), "run.json"), "utf8"));
          assert.equal(metadata.run, host.frame.run); assert.equal(metadata.run_instance_id, host.frame.run_instance_id); assert.equal(metadata.ownerId, host.frame.ownerId);
          assert.equal(Number.isSafeInteger(host.pid) && Number(host.pid) > 0, true);
        }
        if (!failed) {
          for (const host of hosts) assert.throws(() => process.kill(host.pid!, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
          await rm(root, { recursive: true, force: true });
        } else console.error("Catalog fixture assertion failed; retaining captured evidence", root);
      } catch (error) {
        console.error("Captured fixture runner exit remains unproven; retaining state", root);
        throw failed ? new AggregateError([primary, error], "Catalog fixture failed and state was retained") : error;
      }
    }
    if (failed) throw primary;
  }
});
