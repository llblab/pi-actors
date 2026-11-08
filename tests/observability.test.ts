/**
 * Async run observability regression tests
 * Covers compact ambient summaries and terminal transition detection
 */

import "./test-environment.mjs";

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import os from "node:os";
import { EventEmitter } from "node:events";
import fs, { type FSWatcher } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";

function attentionView(text: string): { metadata: any; body?: string } {
  const end = text.startsWith("---\n") ? text.indexOf("\n---\n", 4) : -1;
  assert.ok(!text.startsWith("---\n") || end >= 0);
  const doc = parseDocument(end < 0 ? text : text.slice(4, end), { uniqueKeys: true });
  assert.deepEqual(doc.errors, []);
  const metadata = doc.toJS();
  assert.ok(metadata && !Array.isArray(metadata) && typeof metadata === "object");
  return { metadata, ...(end < 0 ? {} : { body: text.slice(end + 5) }) };
}

import {
  collectRunCompletionBatchMembers,
  countRunningSubagents,
  countRunningSubagentsByRun,
  createRunStateWatcher,
  createRunTerminalReconciliationLoop,
  createRunUiObservationState,
  detectRunAttentionEvents,
  detectRunTransitions,
  deliverRunAttentionNotifications,
  executeRunRetirements,
  findRunRetirementCandidates,
  primeRunAttentionState,
  pruneRunObservationState,
  pruneRunUiObservationState,
  readRunUiSnapshot,
  readRunDeliverySnapshot,
  readRunUiAndDeliverySnapshots,
  retryRunAttentionEvent,
  formatRunAttentionMessage,
  formatRunSteerMessage,
  formatRunTransitionMessage,
  getRunAttentionNotificationType,
  getRunTransitionNotificationType,
  isRunSteerAttentionEvent,
  renderRunStatus,
  renderSubagentStatus,
  shouldNotifyRunAttentionEvent,
  shouldNotifyRunTransition,
  shouldSendRunAttentionFollowUp,
  summarizeRuns,
} from "../lib/observability.ts";
import { readProcessIdentity } from "../lib/runs-process.ts";
import { claimRunStateDirectory } from "../lib/runs-ownership.ts";
import { getRunStatus } from "../lib/async-runs.ts";
import * as Limits from "../lib/limits.ts";
import { appendRunTraceEvent } from "../lib/runs-trace.ts";
import { admitRunCompletionBatch, formatRunCompletionBatchMessage, readRunDeliveryJournal, markRunCompletionBatchQueued, markRunCompletionBatchPresented } from "../lib/run-delivery.ts";

test("Default Windows inventories query unique PIDs in bounded chunks and never share with nested, later or direct reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-windows-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exists = fs.existsSync;
  const hooks = [t.mock.method(os, "platform", () => "win32"), t.mock.method(process, "kill", () => true),
    t.mock.method(fs, "existsSync", (path: fs.PathLike) => String(path) === "/proc" ? false : exists(path))];
  let calls: number[][] = []; let reenter: (() => void) | undefined; let failure: string | undefined;
  const native = t.mock.method(childProcess, "spawnSync", (_file: string, args: string[]) => {
    const pids = [...args[3].matchAll(/ProcessId = ([0-9]+)/g)].map(match => Number(match[1]));
    assert.ok(pids.length > 0 && pids.length <= 64); calls.push(pids);
    const nested = reenter; reenter = undefined; nested?.();
    const rows = pids.map(ProcessId => ({ ProcessId, CreationDate: "birth", ExecutablePath: null, CommandLine: "node inventory" }));
    if (args[3].includes("-InputObject")) {
      if (failure === "duplicate") return { status: 0, stdout: JSON.stringify([...rows, rows[0]]) };
      if (failure === "foreign") return { status: 0, stdout: JSON.stringify([{ ...rows[0], ProcessId: 99999 }]) };
      if (failure === "failed") return { status: 1, stdout: "" };
      if (failure === "throw") throw new Error("CIM unavailable");
    }
    return { status: 0, stdout: JSON.stringify(args[3].includes("-InputObject") ? rows : rows[0]) };
  });
  syncBuiltinESMExports();
  try {
    for (const count of [0, 1, 64, 65]) {
      const inventory = join(root, `count-${count}`); fs.mkdirSync(inventory);
      const directories: string[] = [];
      for (let i = 0; i < count; i++) {
        const run = `run-${i}`; const stateDir = claimRunStateDirectory(join(inventory, run), run); directories.push(stateDir);
        fs.writeFileSync(join(stateDir, "run.json"), JSON.stringify({ run, run_instance_id: `generation-${i}`, ownerId: "owner",
          state_dir: stateDir, pid: 10000 + i, process_identity: { platform: "win32", start_time: "birth", command: "node inventory" } }));
      }
      calls = [];
      assert.equal(summarizeRuns(inventory).running, count);
      assert.deepEqual(calls.map(chunk => chunk.length), count === 0 ? [] : count <= 64 ? [count] : [64, 1]);
      if (count !== 1) continue;
      const duplicate = claimRunStateDirectory(join(inventory, "duplicate"), "duplicate");
      fs.writeFileSync(join(duplicate, "run.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(join(directories[0], "run.json"), "utf8")),
        run: "duplicate", run_instance_id: "other-generation", state_dir: duplicate,
        process_identity: { platform: "win32", start_time: "different-birth", command: "node inventory" } }));
      calls = []; const paired = summarizeRuns(inventory);
      assert.equal(paired.running, 1); assert.equal(paired.exited, 1); assert.deepEqual(calls, [[10000]]);
      for (failure of ["duplicate", "foreign", "failed", "throw"]) {
        calls = []; const fallback = summarizeRuns(inventory);
        assert.equal(fallback.running, 1); assert.equal(fallback.exited, 1);
        assert.deepEqual(calls, [[10000], [10000], [10000]], "One failed chunk and one independently fresh scalar read per original row");
      }
      failure = undefined; calls = [];
      reenter = () => assert.equal(summarizeRuns(inventory).total, 2);
      assert.equal(summarizeRuns(inventory).total, 2); assert.deepEqual(calls, [[10000], [10000]]);
      summarizeRuns(inventory); assert.equal(calls.length, 3, "A second invocation must query again");
      assert.equal(getRunStatus(directories[0]).process_identity_status, "valid");
      assert.equal(calls.length, 4, "Direct status cannot consume an inventory result");
    }
  } finally { native.mock.restore(); for (const hook of hooks) hook.mock.restore(); syncBuiltinESMExports(); }
});

test("Unavailable procfs descendant accounting performs no Run scans or identity probes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-no-proc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let scans = 0;
  const exists = fs.existsSync, readdir = fs.readdirSync;
  const existsHook = t.mock.method(fs, "existsSync", (path: fs.PathLike) =>
    String(path) === "/proc" ? false : exists(path));
  const scanHook = t.mock.method(fs, "readdirSync", (...args: any[]) => {
    if (String(args[0]) === root) scans++;
    return Reflect.apply(readdir, fs, args);
  });
  const probeHook = t.mock.method(process, "kill", () => assert.fail("Unexpected identity probe without procfs"));
  syncBuiltinESMExports();
  try {
    assert.deepEqual(countRunningSubagentsByRun(root), new Map());
    assert.equal(countRunningSubagents(root, "owner"), 0);
    assert.equal(scans, 0);
  } finally {
    existsHook.mock.restore(); scanHook.mock.restore(); probeHook.mock.restore(); syncBuiltinESMExports();
  }
});

test("UI and delivery share one pre-callback observation with independent owners/state and no later reuse", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-shared-observation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeRun(root, "parent", "running", [], 0, "root-owner");
  await writeRun(root, "child", "running", [], 0, "child-owner");
  await writeRun(root, "foreign", "running", [], 0, "foreign-owner");
  const childMeta = join(root, "child", "run.json");
  await writeFile(childMeta, JSON.stringify({ ...JSON.parse(await readFile(childMeta, "utf8")), delivery_owner_id: "root-owner" }));
  const exists = fs.existsSync, kill = process.kill;
  const existsHook = t.mock.method(fs, "existsSync", (path: fs.PathLike) => String(path) === "/proc" ? false : exists(path));
  const probes = t.mock.method(process, "kill", (...args: Parameters<typeof process.kill>) => Reflect.apply(kill, process, args));
  syncBuiltinESMExports();
  try {
    const baselineUi = readRunUiSnapshot(createRunUiObservationState(), "root-owner", { stateRoot: root });
    const baselineDelivery = readRunDeliverySnapshot(createRunUiObservationState(), "root-owner", root);
    assert.equal(probes.mock.callCount(), 6, "Two standalone readers independently probe all three Runs");
    probes.mock.resetCalls();
    const uiState = createRunUiObservationState(), deliveryState = createRunUiObservationState();
    const pair = readRunUiAndDeliverySnapshots(uiState, deliveryState, "root-owner", root);
    assert.equal(probes.mock.callCount(), 3, "Exactly one fresh probe per discovered Run in the shared pass");
    assert.deepEqual(pair.ui, baselineUi); assert.deepEqual(pair.delivery, baselineDelivery);
    assert.deepEqual(pair.ui.summary.runs.map(run => run.run), ["parent"]);
    assert.deepEqual(new Set(pair.delivery.summary.runs.map(run => run.run)), new Set(["parent", "child"]));
    assert.notEqual(uiState.observed, deliveryState.observed); assert.equal(uiState.observed.size, 1); assert.equal(deliveryState.observed.size, 2);
    const parentMeta = join(root, "parent", "run.json");
    await writeFile(parentMeta, JSON.stringify({ ...JSON.parse(await readFile(parentMeta, "utf8")), ownerId: "replacement-owner" }));
    probes.mock.resetCalls();
    const next = readRunUiAndDeliverySnapshots(uiState, deliveryState, "root-owner", root);
    assert.equal(probes.mock.callCount(), 3, "The next invocation observes again, never reusing native facts");
    assert.equal(next.ui.summary.total, 0); assert.deepEqual(next.delivery.summary.runs.map(run => run.run), ["child"]);
  } finally { existsHook.mock.restore(); probes.mock.restore(); syncBuiltinESMExports(); }
});

async function writeRun(
  root: string,
  run: string,
  status: "running" | "done" | "failed" | "exited" | "cancelled" | "killed",
  failures: unknown[] = [],
  activeSubagents = 0,
  ownerId?: string,
  retireWhen?: string,
  launchSource?: "spawn" | "tool",
  recipeFile?: string,
  tool?: string,
  notificationPolicy?: "normal" | "silent",
): Promise<void> {
  const dir = join(root, run);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      createdAt: "2026-01-01T00:00:00.000Z",
      cwd: process.cwd(),
      run,
      run_instance_id: `generation-${run}`,
      ...(ownerId ? { ownerId } : {}),
      ...(retireWhen ? { retire_when: retireWhen } : {}),
      ...(launchSource ? { launch_source: launchSource } : {}),
      ...(recipeFile ? { recipe_file: recipeFile } : {}),
      ...(tool ? { tool } : {}),
      ...(notificationPolicy ? { notification_policy: notificationPolicy } : {}),
      pid: status === "running" ? process.pid : 999999999,
      ...(status === "running"
        ? { process_identity: readProcessIdentity(process.pid) }
        : {}),
      state_dir: dir,
    }),
  );
  await writeFile(
    join(dir, "progress.json"),
    JSON.stringify({
      activeSubagents,
      completed: status === "running" ? 0 : 1,
      failures,
      updatedAt: `2026-01-01T00:00:0${run.length}.000Z`,
    }),
  );
  if (status === "done")
    await writeFile(join(dir, "result.json"), JSON.stringify({ code: 0 }));
  if (status === "failed")
    await writeFile(join(dir, "result.json"), JSON.stringify({ code: 1 }));
  if (status === "cancelled")
    await writeFile(
      join(dir, "events.jsonl"),
      JSON.stringify({ event: "run.cancel" }),
    );
  if (status === "killed")
    await writeFile(
      join(dir, "events.jsonl"),
      JSON.stringify({ event: "run.kill" }),
    );
}

test("Run observability summarizes state root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-"));
  try {
    await writeRun(root, "running", "running");
    await writeRun(root, "done", "done");
    await writeRun(root, "failed", "failed");
    await writeRun(root, "cancelled", "cancelled");
    await writeRun(root, "killed", "killed");
    const summary = summarizeRuns(root);
    assert.equal(summary.total, 5);
    assert.equal(summary.running, 1);
    assert.equal(summary.done, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.cancelled, 1);
    assert.equal(summary.killed, 1);
    assert.equal(summary.runningSubagents, 1);
    assert.equal(renderRunStatus(summary), "▶");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability discovers nested child async runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-nested-"));
  try {
    await writeRun(root, "supervisor", "running", [], 0, undefined, "children_terminal");
    const childDir = join(root, "supervisor", "child");
    await mkdir(childDir, { recursive: true });
    await writeFile(
      join(childDir, "run.json"),
      JSON.stringify({
        createdAt: "2026-01-01T00:00:00.000Z",
        cwd: process.cwd(),
        pid: 999999999,
        run: "child",
        state_dir: childDir,
      }),
    );
    await writeFile(
      join(childDir, "progress.json"),
      JSON.stringify({ activeSubagents: 0, completed: 1, failures: [], updatedAt: "2026-01-01T00:00:09.000Z" }),
    );
    await writeFile(join(childDir, "result.json"), JSON.stringify({ code: 0 }));
    const summary = summarizeRuns(root);
    assert.deepEqual(summary.runs.map((run) => run.run), ["child", "supervisor"]);
    assert.deepEqual(findRunRetirementCandidates(summary), [
      {
        activeSubagents: 0,
        childRuns: 1,
        descendantSubagents: 0,
        run: "supervisor",
        stateDir: join(root, "supervisor"),
        terminalChildRuns: 1,
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability filters summaries by coordinator owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-"));
  try {
    await writeRun(root, "alpha", "running", [], 3, "session-a");
    await writeRun(root, "beta", "running", [], 2, "session-b");
    await writeRun(root, "global", "running", [], 4);
    const summaryA = summarizeRuns(root, "session-a");
    const summaryB = summarizeRuns(root, "session-b");
    assert.deepEqual(
      summaryA.runs.map((run) => run.run),
      ["alpha"],
    );
    assert.equal(summaryA.runningSubagents, 3);
    assert.deepEqual(
      summaryB.runs.map((run) => run.run),
      ["beta"],
    );
    assert.equal(summaryB.runningSubagents, 2);
    assert.equal(summarizeRuns(root).total, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AX steer capture preserves opaque checkpoint values and whole reference coverage under its existing byte cap", () => {
  const event = Object.freeze({ attention: "steer" as const, id: "ax-checkpoint", kind: "checkpoint.blocked", level: "warning" as const,
    run: "run:unit", runInstanceId: "generation-a", stateDir: "/owned", summary: "## Approval\r\n\r\n- next: authored value", body: "## Context\r\n- tool: source content · kept", ts: "2026-01-01T00:00:00.000Z" });
  const before = JSON.stringify(event), text = formatRunSteerMessage(event);
  assert.equal(attentionView(text).metadata.run, "unit"); assert.equal(attentionView(text).metadata.checkpoint, event.summary);
  assert.equal(attentionView(text).body, event.body);
  assert.equal(attentionView(text).metadata.body_upstream, "[omitted: unknown]"); assert.equal(JSON.stringify(event), before);
  assert.deepEqual(Object.keys(attentionView(text).metadata), ["run", "checkpoint", "body_basis", "body_upstream"]); assert.ok(text.includes(" · kept"));
  assert.equal(formatRunSteerMessage.length, 1);
  const unusual = ["/owned/parent/../target", "/owned/dir/with `tick`\nname", "relative path.log"];
  const literal = formatRunSteerMessage({ ...event, body: undefined, data: { run_files: unusual } });
  assert.deepEqual(attentionView(literal).metadata.run_files.paths, unusual);
  const many = Array.from({ length: 11 }, (_, index) => "/owned/file-" + index + ".log");
  const capped = formatRunSteerMessage({ ...event, body: undefined, data: { run_files: [...many, many[0], ""] } });
  assert.deepEqual(attentionView(capped).metadata.run_files, { shown: 8, omitted: 3, total: 11, paths: many.slice(0, 8) }); assert.ok(!capped.includes(JSON.stringify(many[8])));
  const malformed = formatRunSteerMessage({ ...event, body: undefined, data: { run_files: ["/owned/\ud800", "/owned/safe", ...many] } });
  assert.deepEqual(attentionView(malformed).metadata.run_files, { shown: 7, omitted: 6, total: 13, paths: ["/owned/safe", ...many.slice(0, 6)] }); assert.doesNotMatch(malformed, /\ud800|\ufffd/);
  const longPaths = (prefix: string) => Array.from({ length: 8 }, (_, index) => "/" + prefix + index + "/" + "β".repeat(1800));
  const artifacts = longPaths("artifact"), files = longPaths("file");
  const bounded = formatRunSteerMessage({ ...event, body: undefined, data: { artifacts: Object.fromEntries(artifacts.map((path, index) => [String(index), path])), run_files: files } });
  assert.ok(Buffer.byteLength(bounded) <= Limits.RUN_DELIVERY_STEER_MAX_BYTES); assert.ok(bounded.indexOf("artifacts:") < bounded.indexOf("run_files:"));
  for (const [key, paths] of [["artifacts", artifacts], ["run_files", files]] as const) {
    const section = attentionView(bounded).metadata[key];
    const shown = section.shown; assert.equal(shown + section.omitted, 8); assert.equal(section.total, 8);
    assert.deepEqual(section.paths ?? [], paths.slice(0, shown)); for (const path of paths.slice(shown)) assert.ok(!bounded.includes(JSON.stringify(path)));
  }
  const base = { ...event, run: "unit", summary: "x", body: undefined };
  const remaining = Limits.RUN_DELIVERY_STEER_MAX_BYTES - Buffer.byteLength(formatRunSteerMessage(base)) + 1;
  const summary = "🌍".repeat(Math.floor(remaining / 4)) + "x".repeat(remaining % 4);
  assert.equal(Buffer.byteLength(formatRunSteerMessage({ ...base, summary })), Limits.RUN_DELIVERY_STEER_MAX_BYTES);
  assert.throws(() => formatRunSteerMessage({ ...base, summary: summary + "x" }), /checkpoint text exceeds/);
  assert.throws(() => formatRunSteerMessage({ ...base, summary, data: { run_files: ["/owned/a"] } }), /reference coverage exceed/);
  assert.throws(() => formatRunSteerMessage({ ...base, summary: "lost\ud800" }), /Unicode\/byte delivery limits/);
  const clipped = [4, 4000].map(length => formatRunSteerMessage({ ...base, body: "a".repeat(499) + "🌍" + "H".repeat(length) }));
  assert.equal(clipped[0], clipped[1]); assert.equal(attentionView(clipped[0]).body, "a".repeat(499) + "…"); assert.equal(attentionView(clipped[0]).metadata.body_omission, "[omitted: unknown]");
  assert.equal(Buffer.from(clipped[0]).toString("utf8"), clipped[0]); assert.doesNotMatch(clipped[0], /\[omitted: \d+ chars\]/u);
  const badBody = formatRunSteerMessage({ ...base, body: "q".repeat(499) + "\ud800tail" });
  assert.equal(attentionView(badBody).body, undefined); assert.equal(attentionView(badBody).metadata.body_reason, "malformed_legacy_preview"); assert.doesNotMatch(badBody, /\ud800|\ufffd/);
  const structured = formatRunSteerMessage({ ...base, body: { note: "short" } }); assert.ok(structured.includes('{"note":"short"}'));
});

test("Attention YAML preserves scalar/body boundaries, selection faults and urgent pre-reference refusal", () => {
  const base = { attention: "steer" as const, id: "selection", kind: "checkpoint", level: "info" as const,
    run: "run:null", stateDir: "/owned", summary: '\uFEFF?\r\n---\nnext: authored', ts: "2026-01-01T00:00:00.000Z" };
  for (const body of ['\uFEFF---\r\nnext:\n  tool: inspect\n```yaml\r\n', '  leading\r\n\r\n---\n  tail  ']) {
    const text = formatRunSteerMessage({ ...base, body });
    assert.deepEqual(attentionView(text), { metadata: { run: "null", checkpoint: base.summary,
      body_basis: "Legacy record; original completeness/privacy unproven.", body_upstream: "[omitted: unknown]" }, body });
    assert.ok(text.endsWith("\n---\n" + body));
  }
  let reads = 0;
  const data = Object.defineProperty({}, "run_files", { get() { reads++; throw Error("reference read"); } });
  for (const summary of ["bad\ud800", '"'.repeat(17000)]) {
    assert.throws(() => formatRunSteerMessage({ ...base, summary, data }), /checkpoint text exceeds/);
    assert.equal(reads, 0);
  }
  const fault = { original: "stringify fault" };
  for (const format of [formatRunAttentionMessage, formatRunSteerMessage]) {
    assert.throws(() => format({ ...base, body: { toJSON() { throw fault; } }, data }), error => error === fault);
    assert.throws(() => format({ ...base, body: { toJSON() { return undefined; } }, data }), TypeError);
    assert.equal(reads, 0);
    let observations = 0;
    const event = Object.defineProperty({ ...base }, "body", { get() { observations++; return "body"; } });
    assert.equal(attentionView(format(event)).body, "body"); assert.equal(observations, 4);
  }
  // A nearly full body-bearing header must still reserve both later omission groups.
  const body = "x".repeat(500), files = ["/" + "z".repeat(16000)];
  const event = { ...base, summary: "y".repeat(15200), body, data: { artifacts: { one: files[0] }, run_files: files } };
  const text = formatRunSteerMessage(event), view = attentionView(text);
  assert.ok(Buffer.byteLength(text) <= 16384); assert.equal(view.body, body);
  for (const key of ["artifacts", "run_files"]) assert.deepEqual(view.metadata[key], { shown: 0, omitted: 1, total: 1 });
});

test("New steer formatting preserves full references, slot counts and essential byte boundaries", () => {
  const event = { attention: "steer" as const, id: "checkpoint", kind: "checkpoint.blocked", level: "warning" as const,
    run: "unit", runInstanceId: "generation-a", stateDir: "/owned", summary: "Approval required", ts: "2026-01-01T00:00:00.000Z" };
  const ordinary = { ...event, data: { run_files: ["/owned/a.log", "/owned/b.log"] } };
  assert.equal(formatRunSteerMessage(ordinary), formatRunAttentionMessage(ordinary));
  const many = Array.from({ length: 11 }, (_, index) => "/owned/file-" + index + ".log");
  const capped = formatRunSteerMessage({ ...event, data: { run_files: [...many, many[0], ""] } });
  assert.deepEqual(attentionView(capped).metadata.run_files, { shown: 8, omitted: 3, total: 11, paths: many.slice(0, 8) });
  assert.ok(capped.includes(JSON.stringify(many[7])));
  assert.equal(capped.includes("file-8.log"), false);
  const unusual = ["/owned/parent/../target", "/owned/dir/with `tick`\nname", "relative path.log"];
  const literal = formatRunSteerMessage({ ...event, data: { run_files: unusual } });
  assert.deepEqual(attentionView(literal).metadata.run_files.paths, unusual);
  const malformed = formatRunSteerMessage({ ...event, data: { run_files: ["/owned/\ud800", "/owned/safe"] } });
  assert.deepEqual(attentionView(malformed).metadata.run_files, { shown: 1, omitted: 1, total: 2, paths: ["/owned/safe"] });
  assert.equal(Buffer.from(malformed).toString("utf8"), malformed);
  assert.doesNotMatch(malformed, /\ufffd|\ud800/);
  const remaining = 16 * 1024 - Buffer.byteLength(formatRunSteerMessage({ ...event, summary: "" }));
  const summary = "🌍".repeat(Math.floor(remaining / 4)) + "x".repeat(remaining % 4);
  assert.equal(Buffer.byteLength(formatRunSteerMessage({ ...event, summary })), 16 * 1024);
  assert.throws(() => formatRunSteerMessage({ ...event, summary: summary + "x" }), /checkpoint text exceeds/);
  assert.throws(() => formatRunSteerMessage({ ...event, summary, data: { run_files: ["/owned/a"] } }), /reference coverage exceed/);
  assert.throws(() => formatRunSteerMessage({ ...event, summary: "lost\ud800" }), /Unicode\/byte delivery limits/);
});

test("AX ordinary attention preserves opaque content and slot coverage without adding a steer budget or changing sink semantics", () => {
  const event = { attention: "notify" as "notify" | "followup", id: "ordinary", kind: "checkpoint.notice", level: "warning" as const,
    run: "run:unit", stateDir: "/owned", summary: "## Notice\r\n\r\n- next: authored value", ts: "2026-01-01T00:00:00.000Z",
    body: "## Context\r\n- tool: authored content · kept\r\n\r\n  - Nested\rLast\nLine" };
  const before = JSON.stringify(event), text = formatRunAttentionMessage(Object.freeze(event));
  assert.equal(attentionView(text).metadata.run, "unit"); assert.equal(attentionView(text).metadata.checkpoint, event.summary);
  assert.equal(attentionView(text).body, event.body);
  assert.equal(attentionView(text).metadata.body_upstream, "[omitted: unknown]"); assert.equal(JSON.stringify(event), before);
  assert.deepEqual(Object.keys(attentionView(text).metadata), ["run", "checkpoint", "body_basis", "body_upstream"]);
  assert.equal(text, formatRunSteerMessage({ ...event, attention: "steer" }));
  assert.equal(formatRunAttentionMessage.length, 1);
  const simple = { ...event, run: "unit", summary: "Notice", body: undefined };
  assert.equal(formatRunAttentionMessage(simple), 'run: "unit"\ncheckpoint: "Notice"');
  assert.deepEqual(attentionView(formatRunAttentionMessage(simple)), { metadata: { run: "unit", checkpoint: "Notice" } });
  const unusual = ["/owned/parent/../target", "/owned/with `tick`\nname", "relative path.log", "/owned/\ud800", ...Array.from({ length: 9 }, (_, index) => "/owned/file-" + index)];
  const grouped = formatRunAttentionMessage({ ...simple, data: { artifacts: Object.fromEntries(unusual.map((path, index) => [String(index), path])), run_files: [...unusual, unusual[0], "", 123] } });
  assert.ok(grouped.indexOf("artifacts:") < grouped.indexOf("run_files:"));
  for (const key of ["artifacts", "run_files"]) {
    const section = attentionView(grouped).metadata[key];
    assert.deepEqual(section, { shown: 7, omitted: 6, total: 13, paths: unusual.slice(0, 8).filter(path => Buffer.from(path).toString("utf8") === path) });
  }
  assert.doesNotMatch(grouped, /\ud800|\ufffd/);
  const allBad = formatRunAttentionMessage({ ...simple, data: { run_files: ["\ud800", "", "\ud800"] } });
  assert.deepEqual(attentionView(allBad).metadata.run_files, { shown: 0, omitted: 1, total: 1 }); assert.doesNotMatch(allBad, /paths:/);
  assert.equal(formatRunAttentionMessage({ ...simple, data: { artifacts: {}, run_files: ["", 42] } }), formatRunAttentionMessage(simple));
  const longPath = "/owned/" + "directory/".repeat(7000) + "report.json";
  const unbounded = formatRunAttentionMessage({ ...simple, data: { run_files: [longPath] } });
  assert.ok(Buffer.byteLength(unbounded) > 49152); assert.ok(unbounded.includes(JSON.stringify(longPath)));
  assert.equal(formatRunAttentionMessage({ ...simple, kind: "command.done", body: "ignored", data: { run_files: [longPath] } }), formatRunAttentionMessage(simple));
  const previews = [4, 4000].map(length => formatRunAttentionMessage({ ...simple, body: "a".repeat(499) + "🌍" + "H".repeat(length) }));
  assert.equal(previews[0], previews[1]); assert.equal(attentionView(previews[0]).body, "a".repeat(499) + "…"); assert.equal(attentionView(previews[0]).metadata.body_omission, "[omitted: unknown]");
  assert.equal(Buffer.from(previews[0]).toString("utf8"), previews[0]); assert.doesNotMatch(previews[0], /\[omitted: \d+ chars\]/u);
  const malformed = formatRunAttentionMessage({ ...simple, body: "q".repeat(499) + "\ud800tail" });
  assert.equal(attentionView(malformed).metadata.body, "unavailable"); assert.equal(attentionView(malformed).metadata.body_reason, "malformed_legacy_preview"); assert.doesNotMatch(malformed, /\ud800|\ufffd/);
  const structured = formatRunAttentionMessage({ ...simple, body: { note: "```literal```" } });
  assert.ok(structured.includes('{"note":"```literal```"}'));
  assert.equal(attentionView(structured).body, '{"note":"```literal```"}'); assert.equal(formatRunAttentionMessage({ ...simple, body: "  \r\n" }), formatRunAttentionMessage(simple));
  const events = [{ ...simple, id: "notify" }, { ...simple, id: "followup", attention: "followup" as const }, { ...simple, id: "command", kind: "command.done", attention: "followup" as const }];
  const notices: Array<{ text: string; level: string }> = [], followups: Array<{ content: string; customType: string; display: boolean; details: unknown }> = [], order: string[] = [];
  deliverRunAttentionNotifications(events, { notify: (value, level) => { notices.push({ text: value, level }); order.push("notify"); }, sendFollowUp: message => { followups.push(message); order.push("followup"); } });
  assert.deepEqual(order, ["notify", "notify", "followup"]); assert.deepEqual(notices.map(item => item.level), ["warning", "warning"]);
  assert.deepEqual(notices.map(item => item.text), events.slice(0, 2).map(item => formatRunAttentionMessage(item)));
  assert.equal(followups.length, 1); assert.equal(followups[0].customType, "pi-actors-run-trace"); assert.equal(followups[0].display, false);
  assert.equal(followups[0].content, notices[1].text); assert.equal(followups[0].details, events[1]);
  const committed = followups[0].content; events[1].summary = "Changed after delivery"; assert.equal(followups[0].content, committed);
  const fault = { original: "sink fault" }; let sent = 0;
  assert.throws(() => deliverRunAttentionNotifications(events.slice(0, 1), { notify: () => { throw fault; }, sendFollowUp: () => { sent++; } }), error => error === fault); assert.equal(sent, 0);
  let notified = 0;
  assert.throws(() => deliverRunAttentionNotifications(events.slice(1, 2), { notify: () => { notified++; }, sendFollowUp: () => { throw fault; } }), error => error === fault); assert.equal(notified, 1);
});

test("Canonical notify and followup share exact reference coverage without changing sink routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-attention-paths-"));
  try {
    await writeRun(root, "attention", "running", [], 0, "session-a");
    const stateDir = join(root, "attention");
    const ordinary = Array.from({ length: 11 }, (_, index) => "/owned/file-" + index + ".log");
    const unusual = ["/owned/parent/../target", "/owned/dir/with `tick`\nname", "relative path.log", "/owned/\ud800", ...ordinary];
    const ids = [
      appendRunTraceEvent(stateDir, { attention: "notify", kind: "checkpoint.notice", summary: "Notice", level: "warning",
        data: { run_files: [...ordinary, ordinary[0], ""] } }).id,
      appendRunTraceEvent(stateDir, { attention: "followup", kind: "checkpoint.question", summary: "Question", level: "info",
        data: { artifacts: Object.fromEntries([...unusual, unusual[0], ""].map((path, index) => [String(index), path])) } }).id,
    ];
    const seen = new Map<string, Set<string>>(); const previous = new Map<string, number>();
    const snapshot = summarizeRuns(root, "session-a");
    const events = detectRunAttentionEvents(previous, snapshot, seen);
    assert.deepEqual(events.map(event => event.id), ids);
    const notifications: Array<{ text: string; level: string }> = [];
    const followups: Array<{ content: string; customType: string; display: boolean; details: unknown }> = [];
    deliverRunAttentionNotifications(events, { notify: (text, level) => notifications.push({ text, level }), sendFollowUp: message => followups.push(message) });
    assert.deepEqual(notifications.map(item => item.level), ["warning", "info"]);
    assert.deepEqual(attentionView(notifications[0].text).metadata.run_files, { shown: 8, omitted: 3, total: 11, paths: ordinary.slice(0, 8) });
    assert.ok(notifications[0].text.includes(JSON.stringify(ordinary[7])));
    assert.equal(notifications[0].text.includes("file-8.log"), false);
    const literalPaths = attentionView(notifications[1].text).metadata.artifacts.paths;
    assert.deepEqual(literalPaths, unusual.slice(0, 8).filter(path => Buffer.from(path).toString("utf8") === path));
    assert.deepEqual({ ...attentionView(notifications[1].text).metadata.artifacts, paths: undefined }, { shown: 7, omitted: 8, total: 15, paths: undefined });
    assert.equal(Buffer.from(notifications[1].text).toString("utf8"), notifications[1].text);
    assert.doesNotMatch(notifications[1].text, /\ud800|\ufffd/);
    assert.equal(followups.length, 1);
    assert.equal(followups[0].customType, "pi-actors-run-trace");
    assert.equal(followups[0].display, false);
    assert.equal(followups[0].content, notifications[1].text);
    assert.equal(followups[0].details, events[1]);
    const committedText = followups[0].content;
    events[1].data = { run_files: ["/changed/later"] };
    assert.equal(followups[0].content, committedText);
    assert.deepEqual(detectRunAttentionEvents(previous, snapshot, seen), []);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Run observability detects script-authored Trace attention", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-"));
  try {
    await writeRun(root, "music", "running", [], 0, "session-a");
    await writeFile(
      join(root, "music", "trace.jsonl"),
      `${JSON.stringify({ id: "trace-1", kind: "player.track", summary: "Now playing: track.flac", attention: "followup", level: "info", data: { index: 3, question: "Continue playback?", artifacts: { report: join(root, "music", "report.md") }, run_files: [join(root, "music", "stdout.log")] }, ts: "2026-01-01T00:00:00.000Z" })}\n`,
    );
    const summary = summarizeRuns(root, "session-a");
    const previous = new Map<string, number>();
    const seen = new Map<string, Set<string>>();
    const events = detectRunAttentionEvents(previous, summary, seen);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "player.track");
    assert.equal(events[0].summary, "Now playing: track.flac");
    assert.equal(events[0].body, undefined);
    assert.equal(events[0].metadata, undefined);
    assert.deepEqual(attentionView(formatRunAttentionMessage(events[0])), { metadata: {
      run: "music", checkpoint: "Now playing: track.flac",
      artifacts: { shown: 1, omitted: 0, total: 1, paths: [join(root, "music", "report.md")] },
      run_files: { shown: 1, omitted: 0, total: 1, paths: [join(root, "music", "stdout.log")] },
    } });
    assert.equal(getRunAttentionNotificationType(events[0]), "info");
    assert.equal(shouldNotifyRunAttentionEvent(events[0]), true);
    assert.equal(shouldSendRunAttentionFollowUp(events[0]), true);
    const delivered: Array<{ customType: string }> = [];
    deliverRunAttentionNotifications(events, {
      notify: () => {},
      sendFollowUp: (message) => delivered.push(message),
    });
    assert.deepEqual(
      delivered.map((message) => message.customType),
      ["pi-actors-run-trace"],
    );
    assert.deepEqual(detectRunAttentionEvents(previous, summary, seen), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability keeps canonical attention exactly-once across replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-replace-"));
  const stateDir = join(root, "music");
  try {
    await writeRun(root, "music", "running", [], 0, "session-a");
    const first = appendRunTraceEvent(stateDir, {
      attention: "notify",
      kind: "player.first",
    });
    const summary = summarizeRuns(root, "session-a");
    const legacy = new Map<string, number>();
    const seen = new Map<string, Set<string>>();
    assert.deepEqual(
      detectRunAttentionEvents(legacy, summary, seen).map(({ id }) => id),
      [first.id],
    );
    assert.deepEqual(detectRunAttentionEvents(legacy, summary, seen), []);
    const second = {
      id: "replacement-second",
      kind: "player.second",
      ts: "2026-01-01T00:00:01.000Z",
      attention: "followup",
    };
    await writeFile(
      join(stateDir, "trace.jsonl"),
      `${JSON.stringify(second)}\n`,
    );
    assert.deepEqual(
      detectRunAttentionEvents(legacy, summary, seen).map(({ id }) => id),
      [second.id],
    );
    assert.equal(seen.get(stateDir)?.has(first.id), false);
    assert.deepEqual(detectRunAttentionEvents(legacy, summary, seen), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability delivers multiple unseen retained attention in physical order", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-multiple-"));
  const stateDir = join(root, "music");
  try {
    await writeRun(root, "music", "running", [], 0, "session-a");
    await writeFile(
      join(stateDir, "trace.jsonl"),
      [
        { id: "first", kind: "player.first", ts: "2026-01-01T00:00:02.000Z", attention: "notify" },
        { id: "marker", kind: "runtime.trace_compacted", ts: "2026-01-01T00:00:03.000Z", level: "warning", data: { version: 1, compactions_total: 1, dropped_valid_events_total: 1, dropped_malformed_lines_total: 0, dropped_bytes_total: 10, dropped_event_count_exact: true, retained_events: 3, retained_bytes: 400, history_complete: false } },
        { id: "second", kind: "player.second", ts: "2026-01-01T00:00:01.000Z", attention: "followup" },
      ].map((value) => JSON.stringify(value)).join("\n") + "\n",
    );
    const events = detectRunAttentionEvents(
      new Map(),
      summarizeRuns(root, "session-a"),
      new Map(),
    );
    assert.deepEqual(events.map(({ id }) => id), ["first", "second"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability primes retained attention without startup replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-prime-"));
  const stateDir = join(root, "music");
  try {
    await writeRun(root, "music", "running", [], 0, "session-a");
    const historical = appendRunTraceEvent(stateDir, {
      attention: "followup",
      kind: "player.historical",
    });
    const state = createRunUiObservationState();
    primeRunAttentionState(state, "session-a", root);
    assert.deepEqual(readRunUiSnapshot(state, "session-a", { stateRoot: root }).attentionEvents, []);
    const current = appendRunTraceEvent(stateDir, {
      attention: "notify",
      kind: "player.current",
    });
    assert.deepEqual(
      readRunUiSnapshot(state, "session-a", { stateRoot: root })
        .attentionEvents.map(({ id }) => id),
      [current.id],
    );
    assert.deepEqual(state.attentionEventIds.get(stateDir), new Set([historical.id, current.id]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability delivers retained attention once across repeated compaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-compaction-"));
  const stateDir = join(root, "music");
  try {
    await writeRun(root, "music", "running", [], 0, "session-a");
    const state = createRunUiObservationState();
    primeRunAttentionState(state, "session-a", root);
    const delivered: string[] = [];
    for (let cycle = 0; cycle < 2; cycle += 1) {
      for (let index = 0; index < Limits.TRACE_JOURNAL_MAX_EVENTS - 2; index += 1)
        appendRunTraceEvent(stateDir, { kind: "player.pressure", data: { cycle, index } });
      const attention = appendRunTraceEvent(stateDir, {
        attention: cycle ? "followup" : "notify", kind: `player.cycle_${cycle}`,
      });
      const first = readRunUiSnapshot(state, "session-a", { stateRoot: root });
      delivered.push(...first.attentionEvents.map(({ id }) => id));
      assert.equal(first.attentionEvents.filter(({ id }) => id === attention.id).length, 1);
      appendRunTraceEvent(stateDir, { kind: "player.compact", data: { cycle } });
      assert.deepEqual(readRunUiSnapshot(state, "session-a", { stateRoot: root }).attentionEvents, []);
      assert.ok((state.attentionEventIds.get(stateDir)?.size ?? 0) <= 1);
    }
    const finalAttention = appendRunTraceEvent(stateDir, {
      attention: "notify", kind: "player.final",
    });
    delivered.push(...readRunUiSnapshot(state, "session-a", { stateRoot: root })
      .attentionEvents.map(({ id }) => id));
    assert.equal(new Set(delivered).size, 3);
    assert.equal(delivered.at(-1), finalAttention.id);
    assert.deepEqual(readRunUiSnapshot(state, "session-a", { stateRoot: root }).attentionEvents, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Legacy body clipping discloses unknown privacy-safe counts without exposing raw tail lengths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-legacy-body-"));
  try {
    await writeRun(root, "legacy", "running", [], 0, "session-a");
    const stateDir = join(root, "legacy");
    await assert.rejects(readFile(join(stateDir, "trace.jsonl")), { code: "ENOENT" });
    const cases = [
      { body: "🌍".repeat(250), expected: "🌍".repeat(250), extra: {} },
      ...[4, 4000].map(length => ({ body: "a".repeat(499) + "🌍" + "H".repeat(length),
        expected: "a".repeat(499) + "…", extra: { body_omission: "[omitted: unknown]" } })),
      { body: "q".repeat(499) + "\ud800tail", expected: undefined, extra: { body: "unavailable", body_reason: "malformed_legacy_preview", body_omission: "[omitted: unknown]" } },
      { body: { note: "short" }, expected: '{"note":"short"}', extra: {} },
    ];
    await writeFile(join(stateDir, "outbox.jsonl"), cases.map((value, index) => JSON.stringify({
      id: "legacy-" + index, event: "checkpoint.legacy", summary: "Legacy checkpoint",
      delivery: "followup", body: value.body, metadata: { redacted: true },
    })).join("\n") + "\n");
    const events = detectRunAttentionEvents(new Map(), summarizeRuns(root, "session-a"));
    assert.equal(events.length, cases.length);
    for (const [index, event] of events.entries()) {
      const rendered = formatRunAttentionMessage(event);
      const view = attentionView(rendered);
      assert.equal(view.body, cases[index].expected);
      assert.deepEqual(view.metadata, { run: "legacy", checkpoint: "Legacy checkpoint", ...cases[index].extra,
        body_basis: "Legacy record; original completeness/privacy unproven.", body_upstream: "[omitted: unknown]" });
      assert.equal(Buffer.from(rendered).toString("utf8"), rendered);
      assert.equal(formatRunSteerMessage({ ...event, attention: "steer" }), rendered);
    }
    assert.equal(formatRunAttentionMessage(events[1]), formatRunAttentionMessage(events[2]));
    await assert.rejects(readFile(join(stateDir, "trace.jsonl")), { code: "ENOENT" });
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Run observability suppresses duplicate legacy attention after line counter reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-dedupe-"));
  try {
    await writeRun(root, "music", "running", [], 0, "session-a");
    await writeFile(
      join(root, "music", "outbox.jsonl"),
      `${JSON.stringify({ id: "event-1", event: "player.track", summary: "Now playing", delivery: "followup" })}\n`,
    );
    const summary = summarizeRuns(root, "session-a");
    const previous = new Map<string, number>();
    const seen = new Map<string, Set<string>>();
    assert.equal(detectRunAttentionEvents(previous, summary, seen).length, 1);
    previous.clear();
    assert.equal(detectRunAttentionEvents(previous, summary, seen).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability skips malformed legacy attention records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-corrupt-outbox-"));
  try {
    await writeRun(root, "music", "running", [], 0, "session-a");
    await writeFile(
      join(root, "music", "outbox.jsonl"),
      `{bad json\n${JSON.stringify({ id: "event-1", event: "player.track", summary: "Now playing", delivery: "followup" })}\n`,
    );
    const summary = summarizeRuns(root, "session-a");
    const previous = new Map<string, number>();
    const events = detectRunAttentionEvents(previous, summary);
    assert.equal(events.length, 1);
    assert.equal(events[0].id, "event-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability bounds seen attention ids to the retained canonical set", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-bounded-seen-"));
  const stateDir = join(root, "music");
  try {
    await writeRun(root, "music", "running", [], 0, "session-a");
    const legacy = new Map<string, number>();
    const seen = new Map<string, Set<string>>();
    for (let index = 0; index < 20; index += 1) {
      const record = {
        id: `event-${index}`,
        kind: "player.track",
        ts: new Date(index).toISOString(),
        attention: "notify",
      };
      await writeFile(join(stateDir, "trace.jsonl"), `${JSON.stringify(record)}\n`);
      assert.equal(
        detectRunAttentionEvents(
          legacy,
          summarizeRuns(root, "session-a"),
          seen,
        ).length,
        1,
      );
      assert.deepEqual(seen.get(stateDir), new Set([record.id]));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability detects terminal transitions", () => {
  const previous = new Map([["review", "running" as const]]);
  const transitions = detectRunTransitions(previous, {
    cancelled: 0,
    done: 1,
    exited: 0,
    failed: 0,
    killed: 0,
    running: 0,
    runningSubagents: 0,
    runs: [
      {
        artifacts: { report: "artifacts/report.md" },
        run: "review",
        status: "done",
      },
    ],
    total: 1,
  });
  assert.deepEqual(transitions, [
    {
      from: "running",
      artifacts: { report: "artifacts/report.md" },
      run: "review",
      to: "done",
    },
  ]);
  assert.equal(
    formatRunTransitionMessage(transitions[0]),
    "Run: `review`\nStatus: `done`\nBase: `artifacts`\nArtifacts: `report.md`",
  );
  assert.equal(previous.get("review"), "done");
});

test("Run observability projects sorted exact completion generations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-completion-members-"));
  const stateDir = join(root, "review");
  try {
    await writeRun(root, "review", "done", [], 0, "session-a");
    await writeFile(
      join(stateDir, "result.json"),
      JSON.stringify({ code: 0, completed_at: "2026-01-01T00:00:08.000Z" }),
    );
    const summary = summarizeRuns(root, "session-a");
    assert.equal(summary.runs[0]?.runInstanceId, "generation-review");
    const members = collectRunCompletionBatchMembers(
      detectRunTransitions(new Map([[stateDir, "running" as const]]), summary),
    );
    assert.deepEqual(members, [{
      run: "review",
      run_instance_id: "generation-review",
      state_dir: stateDir,
      status: "done",
      summary: "Run completed.",
      terminal_at: "2026-01-01T00:00:08.000Z",
    }]);
    assert.deepEqual(collectRunCompletionBatchMembers([
      {
        from: "running",
        run: "late",
        runInstanceId: "generation-late",
        stateDir: join(root, "late"),
        terminalAt: "2026-01-01T00:00:09.000Z",
        to: "failed",
      },
      {
        from: "running",
        run: "cancelled",
        runInstanceId: "generation-cancelled",
        stateDir: join(root, "cancelled"),
        terminalAt: "2026-01-01T00:00:07.000Z",
        to: "cancelled",
      },
      {
        from: "running",
        run: "missing-generation",
        stateDir: join(root, "missing"),
        terminalAt: "2026-01-01T00:00:06.000Z",
        to: "done",
      },
      {
        from: "running",
        run: "early",
        runInstanceId: "generation-early",
        stateDir: join(root, "early"),
        terminalAt: "2026-01-01T00:00:05.000Z",
        to: "exited",
      },
    ]).map((item) => item.run), ["early", "late"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run completion delivery waits for the terminal root and retains tree lineage", () => {
  const rootRun = {
    run: "root",
    runInstanceId: "generation-root",
    stateDir: "/runs/root",
    status: "running" as const,
  };
  const childTransition = {
    deliveryParent: {
      run: "root",
      run_instance_id: "generation-root",
      state_dir: "/runs/root",
    },
    from: "running" as const,
    run: "child",
    runInstanceId: "generation-child",
    stateDir: "/runs/child",
    terminalAt: "2026-01-01T00:00:01.000Z",
    to: "done" as const,
  };
  assert.deepEqual(
    collectRunCompletionBatchMembers([childTransition], [rootRun]),
    [],
  );
  const terminalRoot = { ...rootRun, status: "done" as const };
  const runningSibling = {
    deliveryParent: childTransition.deliveryParent,
    run: "sibling",
    runInstanceId: "generation-sibling",
    stateDir: "/runs/sibling",
    status: "running" as const,
  };
  const rootTransition = {
    from: "running" as const,
    run: "root",
    runInstanceId: "generation-root",
    stateDir: "/runs/root",
    terminalAt: "2026-01-01T00:00:02.000Z",
    to: "done" as const,
  };
  assert.deepEqual(
    collectRunCompletionBatchMembers(
      [childTransition, rootTransition],
      [terminalRoot, runningSibling],
    ),
    [],
  );
  assert.deepEqual(
    collectRunCompletionBatchMembers(
      [childTransition, rootTransition],
      [terminalRoot, {
        deliveryParent: childTransition.deliveryParent,
        run: "child",
        runInstanceId: "generation-child",
        stateDir: "/runs/child",
        status: "done",
      }],
    ).map((member) => ({
      parent: member.parent_run,
      run: member.run,
    })),
    [
      { parent: undefined, run: "root" },
      { parent: "root", run: "child" },
    ],
  );
});

test("Terminal reconciliation is independent of retained Trace history", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-terminal-trace-"));
  const stateDir = join(root, "review");
  try {
    await writeRun(root, "review", "done", [], 0, "session-a");
    await writeFile(join(stateDir, "trace.jsonl"), "{compacted away}\n");
    const transitions = detectRunTransitions(new Map([[stateDir, "running" as const]]),
      summarizeRuns(root, "session-a"));
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0]?.to, "done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability bounds terminal artifact references", () => {
  const message = formatRunTransitionMessage({
    artifacts: {
      one: "/reports/one.md",
      two: "/reports/two.md",
      three: "/reports/three.md",
      four: "/reports/four.md",
      five: "/reports/five.md",
    },
    from: "running",
    run: "review",
    to: "done",
  });
  assert.match(
    message,
    /Base: `\/reports`\nArtifacts: `one\.md`, `two\.md`, `three\.md`, `four\.md` \(\+1 more\)/,
  );
  assert.doesNotMatch(message, /five\.md/);
});

test("Legacy completion admission cannot recover upstream counts or privacy from tracked excerpt format", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-legacy-completion-basis-"));
  // Data-only legacy snapshots, not real runners/native closure or admitted privacy projections.
  try {
    for (const kind of ["ascii", "utf8"] as const) {
      const run = kind === "ascii" ? "legacy" : "review";
      await writeRun(root, run, "done", [], 0, "legacy-owner");
      const stateDir = join(root, run), path = join(stateDir, "stdout.log");
      const prefix = kind === "ascii" ? "FIXTURE_PRIVATE_PREFIX=" + "a".repeat(9000) : "界".repeat(3000);
      const observed = [];
      for (const tailLength of [4, 4000]) {
        await writeFile(path, prefix + "T".repeat(tailLength));
        const snapshot = summarizeRuns(root, "legacy-owner");
        const transition = detectRunTransitions(new Map([[stateDir, "running" as const]]), snapshot).find(item => item.run === run)!;
        assert.ok(transition); assert.equal(transition.semanticResult?.synthesized, true);
        assert.equal(transition.semanticResult?.summary, "Run completed.");
        const members = collectRunCompletionBatchMembers([transition], snapshot.runs);
        assert.equal(members.length, 1); assert.equal(members[0].summary, "Run completed.");
        assert.equal(Object.hasOwn(members[0], "chars_omitted"), false); assert.equal(Object.hasOwn(members[0], "privacy_context"), false);
        observed.push(members[0]);
      }
      assert.deepEqual(observed[0], observed[1], "Different original tail lengths collapse before packet admission");
      const body = observed[0].output!; assert.ok(body);
      if (kind === "ascii") {
        assert.equal(body.length, 4000); assert.ok(body.endsWith("…")); assert.ok(body.startsWith("FIXTURE_PRIVATE_PREFIX="));
        // An authored literal ellipsis is observationally identical; its presence is not a loss/length flag.
        await writeFile(path, body);
        const snapshot = summarizeRuns(root, "legacy-owner");
        const transition = detectRunTransitions(new Map([[stateDir, "running" as const]]), snapshot).find(item => item.run === run)!;
        assert.deepEqual(collectRunCompletionBatchMembers([transition], snapshot.runs)[0], observed[0]);
      } else {
        assert.equal(body, "界".repeat(2730) + "\uFFFD", "Existing8192byte decode may end mid-codepoint before4000UTF16 clipping");
        assert.ok(body.length < 4000); assert.equal(body.endsWith("…"), false);
      }
      const packet = admitRunCompletionBatch({ members: [observed[0]], ownerId: "packet-" + kind, tempDir: root });
      assert.equal(packet.presentation_format, "ax_records"); assert.equal(packet.excerpt_format, undefined);
      const rendered = formatRunCompletionBatchMessage(packet);
      assert.ok(rendered.includes(body)); assert.equal(rendered.includes("characters omitted"), false, "Tracked primary/diagnostic version does not claim legacy coverage");
      assert.equal(packet.members[0].output, body);
      await rm(path); // Captured render/phase reload has no permission or need to reread this source.
      for (const phase of [markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
        phase({ batchId: packet.batch_id, ownerId: "packet-" + kind, tempDir: root });
        const saved = readRunDeliveryJournal(root, "packet-" + kind).completion_batch!;
        assert.equal(formatRunCompletionBatchMessage(saved), rendered); assert.equal(saved.members[0].output, body);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Successful reviews project bounded semantic output without transport metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-semantic-review-"));
  const stateDir = join(root, "review");
  try {
    await writeRun(root, "review", "done", [], 0, "session-a");
    const meta = JSON.parse(await readFile(join(stateDir, "run.json"), "utf8"));
    await writeFile(
      join(stateDir, "run.json"),
      JSON.stringify({
        ...meta,
        launch_correlation: {
          correlation_id: "task-42",
          tool_call_id: "call-17",
        },
        transport_context: {
          transport: "telegram",
          chat_id: 123456,
          thread_id: 77,
        },
      }),
    );
    await writeFile(
      join(stateDir, "stdout.log"),
      `ACTOR_REVIEW_RESULT\nStatus: complete\nFinding: ${"x".repeat(6_000)}\n`,
    );
    const previous = new Map([[stateDir, "running" as const]]);
    const [transition] = detectRunTransitions(
      previous,
      summarizeRuns(root, "session-a"),
    );
    assert.equal(transition.semanticResult?.type, "run.done");
    assert.equal(transition.semanticResult?.synthesized, true);
    assert.equal(transition.semanticResult?.correlationId, "task-42");
    assert.match(transition.semanticResult?.body ?? "", /^Status: complete/);
    assert.equal((transition.semanticResult?.body?.length ?? 0) <= 4_000, true);
    const [member] = collectRunCompletionBatchMembers([transition]);
    assert.equal(member.summary, "Run completed.");
    assert.match(member.output ?? "", /^Status: complete\nFinding: x+/);
    assert.equal((member.output?.length ?? 0) <= 4_000, true);
    assert.doesNotMatch(JSON.stringify(member), /chat_id|thread_id|task-42|call-17/);
    assert.equal(transition.semanticResult?.correlationId, "task-42");
    assert.match(transition.semanticResult?.body ?? "", /^Status: complete/);
    assert.deepEqual(transition.semanticResult?.metadata.transport_context, {
      transport: "telegram",
      chat_id: 123456,
      thread_id: 77,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Failed runs retain terminal errors outside follow-up context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-semantic-failed-"));
  const stateDir = join(root, "review");
  try {
    await writeRun(root, "review", "failed", [], 0, "session-a");
    await writeFile(
      join(stateDir, "result.json"),
      JSON.stringify({ code: 65, error: "accepted review output missing" }),
    );
    const [transition] = detectRunTransitions(
      new Map([[stateDir, "running" as const]]),
      summarizeRuns(root, "session-a"),
    );
    assert.equal(transition.semanticResult?.type, "run.failed");
    assert.equal(transition.semanticResult?.body, "accepted review output missing");
    const content = formatRunTransitionMessage(transition);
    assert.match(content, /Run: `review`\nStatus: `failed`/);
    assert.doesNotMatch(content, /accepted review output missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Silent background runs emit no terminal transition", () => {
  const previous = new Map([["draft-sleep", "running" as const]]);
  const transitions = detectRunTransitions(previous, {
    cancelled: 0,
    done: 1,
    exited: 0,
    failed: 0,
    killed: 0,
    running: 0,
    runningSubagents: 0,
    runs: [{
      notificationPolicy: "silent",
      run: "draft-sleep",
      status: "done",
    }],
    total: 1,
  });
  assert.deepEqual(transitions, []);
  assert.equal(previous.get("draft-sleep"), "done");
});

test("Run observability keeps model policy out of terminal follow-up context", () => {
  const message = formatRunTransitionMessage({
    from: "running",
    modelPolicy: {
      model: { source: "inherited", value: "provider/model" },
      thinking: { source: "explicit", value: "high" },
    },
    run: "review",
    to: "done",
  });
  assert.doesNotMatch(message, /Policy:|provider\/model|high/);
});

test("Run observability keys transitions by state directory", () => {
  const previous = new Map([
    ["/tmp/parent/review", "running" as const],
    ["/tmp/parent/child/review", "running" as const],
  ]);
  const transitions = detectRunTransitions(previous, {
    cancelled: 0,
    done: 1,
    exited: 0,
    failed: 1,
    killed: 0,
    running: 0,
    runningSubagents: 0,
    runs: [
      { run: "review", stateDir: "/tmp/parent/review", status: "done" },
      { run: "review", stateDir: "/tmp/parent/child/review", status: "failed" },
    ],
    total: 2,
  });
  assert.deepEqual(
    transitions.map((transition) => ({
      from: transition.from,
      run: transition.run,
      stateDir: transition.stateDir,
      to: transition.to,
    })),
    [
      { from: "running", run: "review", stateDir: "/tmp/parent/review", to: "done" },
      { from: "running", run: "review", stateDir: "/tmp/parent/child/review", to: "failed" },
    ],
  );
  assert.equal(previous.get("/tmp/parent/review"), "done");
  assert.equal(previous.get("/tmp/parent/child/review"), "failed");
});

test("Run observability suppresses terminal follow-up after handled stop messages", () => {
  const transition = {
    from: "running" as const,
    run: "music",
    terminalHandled: true,
    to: "done" as const,
  };
  assert.equal(shouldNotifyRunTransition(transition), false);
});

test("Run observability replays explicit steer after startup until durable admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-steer-observe-"));
  try {
    await writeRun(root, "review", "running", [], 0, "session-a");
    const stateDir = join(root, "review");
    appendRunTraceEvent(stateDir, {
      attention: "steer",
      kind: "checkpoint.blocked",
      level: "warning",
      summary: "Approval required",
    });
    const state = createRunUiObservationState();
    primeRunAttentionState(state, "session-a", root);
    const first = readRunUiSnapshot(state, "session-a", { stateRoot: root });
    assert.equal(first.attentionEvents.length, 1);
    assert.equal(first.attentionEvents[0]?.attention, "steer");
    assert.equal(first.attentionEvents[0]?.runInstanceId, "generation-review");
    assert.equal(isRunSteerAttentionEvent(first.attentionEvents[0]!), true);
    assert.deepEqual(
      readRunUiSnapshot(state, "session-a", { stateRoot: root }).attentionEvents,
      [],
    );
    retryRunAttentionEvent(state, first.attentionEvents[0]!);
    assert.equal(
      readRunUiSnapshot(state, "session-a", { stateRoot: root }).attentionEvents.length,
      1,
    );
    appendRunTraceEvent(stateDir, {
      data: {
        event_id: first.attentionEvents[0]!.id,
        run_instance_id: "generation-review",
        steer_id: "steer-a",
      },
      kind: "delivery.steer_presented",
    });
    const recovered = createRunUiObservationState();
    primeRunAttentionState(recovered, "session-a", root);
    assert.deepEqual(
      readRunUiSnapshot(recovered, "session-a", { stateRoot: root }).attentionEvents,
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability keeps command completion steer out of user projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-"));
  try {
    await writeRun(root, "review", "running", [], 0, "session-a");
    await writeFile(
      join(root, "review", "trace.jsonl"),
      `${JSON.stringify({ id: "command-done", kind: "command.done", summary: "Command pi completed with code 0", attention: "steer", level: "info", data: { artifacts: { report: join(root, "review", "report.md") }, run_files: [join(root, "review", "stdout.log")] }, ts: new Date().toISOString() })}\n`,
    );
    assert.deepEqual(
      detectRunAttentionEvents(
        new Map<string, number>(),
        summarizeRuns(root, "session-a"),
      ),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability detects failed terminal transitions", () => {
  const previous = new Map([["review", "running" as const]]);
  const transitions = detectRunTransitions(previous, {
    cancelled: 0,
    done: 0,
    exited: 0,
    failed: 1,
    killed: 0,
    running: 0,
    runningSubagents: 0,
    runs: [{ run: "review", status: "failed" }],
    total: 1,
  });
  assert.deepEqual(transitions, [
    { from: "running", run: "review", to: "failed" },
  ]);
});

test("Terminal reconciliation contains a throwing error handler", () => {
  const loop = createRunTerminalReconciliationLoop({
    onError: () => {
      throw new Error("notification context is stale");
    },
    reconcile: () => {
      throw new Error("reconciliation failed");
    },
    refreshWatcher: () => undefined,
  });
  assert.doesNotThrow(() => loop.reconcileNow());
  loop.close();
});

test("Periodic terminal reconciliation discovers without projecting", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-terminal-periodic-"));
  let loop: ReturnType<typeof createRunTerminalReconciliationLoop> | undefined;
  const degradedWatcher = createRunStateWatcher({
    stateRoot: root,
    onChange: () => assert.fail("watch callback should remain unused"),
    watchPath: () => {
      throw new Error("watch unavailable");
    },
  });
  try {
    await writeRun(root, "review", "done", [], 0, "session-a");
    await writeRun(root, "audit", "done", [], 0, "session-a");
    await writeRun(root, "foreign", "done", [], 0, "session-b");
    const state = createRunUiObservationState();
    let discovered: string[] = [];
    loop = createRunTerminalReconciliationLoop({
      intervalMs: 10,
      reconcile: () => {
        const snapshot = readRunUiSnapshot(state, "session-a", { stateRoot: root });
        discovered = snapshot.transitions.map((transition) => transition.run);
        pruneRunUiObservationState(state, snapshot);
      },
      refreshWatcher: () => degradedWatcher.refresh(),
    });
    loop.start();
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && discovered.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(discovered.sort(), ["audit", "review"]);
    assert.equal(
      degradedWatcher
        .getDiagnostics()
        .some((diagnostic) => diagnostic.code === "attach_failed"),
      true,
    );
  } finally {
    loop?.close();
    degradedWatcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Periodic reconciliation recovers missed retained attention events", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-attention-reconcile-"));
  try {
    await writeRun(root, "review", "running", [], 0, "session-a");
    const state = createRunUiObservationState();
    primeRunAttentionState(state, "session-a", root);
    const event = appendRunTraceEvent(join(root, "review"), {
      attention: "notify",
      kind: "checkpoint.ready",
    });
    const notified: string[] = [];
    const reconcileAttention = () => {
      const snapshot = readRunUiSnapshot(state, "session-a", { stateRoot: root });
      deliverRunAttentionNotifications(snapshot.attentionEvents, {
        notify: (message) => { notified.push(message); },
        sendFollowUp: () => {},
      });
      pruneRunUiObservationState(state, snapshot);
    };
    reconcileAttention();
    assert.equal(notified.length, 1);
    assert.match(notified[0], new RegExp(event.kind));
    reconcileAttention();
    assert.equal(notified.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AX watcher diagnostics preserve literal paths, raw signatures, bounded identities and existing recovery meaning", () => {
  const root = "/virtual/with```ticks\nroot", runDir = root + "/run", message = "## Attach\r\n\r\n- next: source text · kept";
  class FakeWatcher extends EventEmitter { close(): void {} }
  let attempts = 0, reads = 0, runWatcher: FakeWatcher | undefined;
  const error = new Error(); Object.defineProperty(error, "message", { get: () => { reads++; return message; } });
  const watcher = createRunStateWatcher({ exists: () => true, listDirectories: () => [runDir], onChange: () => {}, stateRoot: root,
    watchPath: path => { if (path === root && ++attempts <= 2) throw error; const value = new FakeWatcher(); if (path === runDir) runWatcher = value; return value as FSWatcher; } });
  try {
    watcher.refresh(); const [first] = watcher.getDiagnostics(); assert.ok(first);
    assert.equal(first.message, "- watcher: attach_failed\n- scope: root\n- path:\n  ````text\n  /virtual/with```ticks\n  root\n  ````\n- diagnostic:\n  " + message.replaceAll(/\r\n|\r|\n/gu, match => match + "  ") + "\n- recovery: terminal reconciliation remains active and watcher rearm will retry");
    assert.equal(first.path, root); assert.equal(first.code, "attach_failed"); assert.equal(first.scope, "root"); assert.equal(first.id, 1);
    assert.equal(Number.isNaN(Date.parse(first.ts)), false); assert.equal(reads, 1);
    watcher.refresh(); assert.equal(reads, 2); assert.deepEqual(watcher.getDiagnostics(), [first], "Same raw signature does not mint another id or timestamp");
    watcher.refresh(); const rearmed = watcher.getDiagnostics().at(-1)!;
    assert.equal(rearmed.id, 2); assert.equal(rearmed.code, "rearmed"); assert.ok(rearmed.message.endsWith("- recovery: terminal watch acceleration restored"));
    assert.equal(watcher.getDiagnostics()[0].message, first.message, "Captured diagnostic text is not regenerated on read");
    for (let index = 0; index < 40; index++) { assert.ok(runWatcher); runWatcher.emit("error", new Error("fault-" + index)); watcher.refresh(); }
    const suffix = watcher.getDiagnostics(); assert.equal(suffix.length, 32); assert.ok(suffix[0].id > 1);
    assert.deepEqual(suffix.map(item => item.id), [...suffix.map(item => item.id)].sort((a, b) => a - b));
    for (const item of suffix) { assert.equal(item.path, runDir); assert.equal(item.scope, "run"); assert.ok(item.message.includes("- path:\n  ````text\n  " + runDir.replaceAll("\n", "\n  ") + "\n  ````")); }
  } finally { watcher.close(); }
  const primitive = createRunStateWatcher({ exists: () => true, listDirectories: () => [], onChange: () => {}, stateRoot: root,
    watchPath: () => { throw Symbol("NOT_A_NEW_DIAGNOSTIC_SOURCE"); } });
  try { primitive.refresh(); assert.doesNotMatch(primitive.getDiagnostics()[0].message, /diagnostic:|NOT_A_NEW_DIAGNOSTIC_SOURCE/); } finally { primitive.close(); }
});

test("Run-state watcher records degradation and bounded rearm diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-watcher-diagnostics-"));
  const stateDir = join(root, "review");
  class FakeWatcher extends EventEmitter {
    close(): void {}
  }
  let rootAttempts = 0;
  let runWatcher: FakeWatcher | undefined;
  const watcher = createRunStateWatcher({
    stateRoot: root,
    onChange: () => {},
    watchPath: (path) => {
      if (path === root && rootAttempts++ === 0)
        throw new Error("root attach failed");
      const next = new FakeWatcher();
      if (path === stateDir) runWatcher = next;
      return next as FSWatcher;
    },
  });
  try {
    await mkdir(stateDir, { recursive: true });
    watcher.refresh();
    watcher.refresh();
    assert.ok(runWatcher);
    const initialDiagnostics = watcher.getDiagnostics();
    assert.equal(
      initialDiagnostics.some(
        (item) => item.scope === "root" && item.code === "attach_failed",
      ),
      true,
    );
    assert.equal(
      initialDiagnostics.some(
        (item) => item.scope === "root" && item.code === "rearmed",
      ),
      true,
    );
    for (let index = 0; index < 20; index += 1) {
      runWatcher?.emit("error", new Error(`watch failed ${index}`));
      watcher.refresh();
    }
    const diagnostics = watcher.getDiagnostics();
    assert.equal(diagnostics.length <= 32, true);
    assert.equal(diagnostics.some((item) => item.code === "removed"), true);
    assert.equal(diagnostics.some((item) => item.code === "rearmed"), true);
    assert.equal(
      diagnostics.some((item) => item.message.includes("watch failed")),
      true,
    );
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Run-state watcher removes deleted run directories without degradation warnings", () => {
  const root = "/virtual/runs";
  const stateDir = `${root}/completed`;
  class FakeWatcher extends EventEmitter {
    close(): void {}
  }
  let runPresent = true;
  const watcher = createRunStateWatcher({
    exists: (path) => path === root || (path === stateDir && runPresent),
    listDirectories: () => (runPresent ? [stateDir] : []),
    onChange: () => {},
    stateRoot: root,
    watchPath: () => new FakeWatcher() as FSWatcher,
  });
  try {
    watcher.refresh();
    runPresent = false;
    watcher.refresh();
    assert.deepEqual(watcher.getDiagnostics(), []);
  } finally {
    watcher.close();
  }
});

test("Run observability reports cancelled terminal transitions clearly", () => {
  const previous = new Map([["music", "running" as const]]);
  const transitions = detectRunTransitions(previous, {
    cancelled: 1,
    done: 0,
    exited: 0,
    failed: 0,
    killed: 0,
    running: 0,
    runningSubagents: 0,
    runs: [{ run: "music", status: "cancelled" }],
    total: 1,
  });
  assert.deepEqual(transitions, [
    { from: "running", run: "music", to: "cancelled" },
  ]);
  assert.equal(
    formatRunTransitionMessage(transitions[0]),
    "Run: `music`\nStatus: `cancelled`",
  );
  assert.equal(getRunTransitionNotificationType(transitions[0]), "info");
  assert.equal(shouldNotifyRunTransition(transitions[0]), false);
});

test("Run observability suppresses duplicate handled terminal transitions", () => {
  const failed = {
    from: "running" as const,
    run: "review",
    to: "failed" as const,
  };
  const killed = {
    from: "running" as const,
    run: "review",
    to: "killed" as const,
  };
  const done = { from: "running" as const, run: "review", to: "done" as const };
  const cancelled = {
    from: "running" as const,
    run: "review",
    to: "cancelled" as const,
  };
  assert.equal(getRunTransitionNotificationType(failed), "error");
  assert.equal(getRunTransitionNotificationType(killed), "warning");
  assert.equal(getRunTransitionNotificationType(done), "info");
  assert.equal(shouldNotifyRunTransition(failed), true);
  assert.equal(shouldNotifyRunTransition(cancelled), false);
  assert.equal(shouldNotifyRunTransition(done), true);
  assert.equal(shouldNotifyRunTransition(failed), true);
  assert.equal(shouldNotifyRunTransition(killed), true);
});

test("Run observability prunes stale entries but retains terminal attention dedupe", () => {
  const statuses = new Map([
    ["/tmp/done", "done" as const],
    ["/tmp/missing", "running" as const],
    ["/tmp/live", "running" as const],
  ]);
  const lineCounts = new Map([
    ["/tmp/done", 3],
    ["/tmp/missing", 4],
    ["/tmp/live", 5],
  ]);
  const seenEventIds = new Map([
    ["/tmp/done", new Set(["done-event"])],
    ["/tmp/missing", new Set(["missing-event"])],
    ["/tmp/live", new Set(["live-event"])],
  ]);
  pruneRunObservationState(
    statuses,
    lineCounts,
    {
      cancelled: 0,
      done: 1,
      exited: 0,
      failed: 0,
      killed: 0,
      running: 1,
      runningSubagents: 1,
      runs: [
        { run: "done-run", stateDir: "/tmp/done", status: "done" },
        { run: "live-run", stateDir: "/tmp/live", status: "running" },
      ],
      total: 2,
    },
    ["/tmp/done"],
    seenEventIds,
  );
  assert.deepEqual([...statuses.keys()], ["/tmp/live"]);
  assert.deepEqual([...lineCounts.keys()], ["/tmp/done", "/tmp/live"]);
  assert.deepEqual([...seenEventIds.keys()], ["/tmp/done", "/tmp/live"]);
});

test("Run observability renders animated subagent triangles", () => {
  assert.equal(renderSubagentStatus(0), undefined);
  assert.equal(renderSubagentStatus(1, 0), "▶");
  assert.equal(renderSubagentStatus(1, 1), "▷");
  assert.equal(renderSubagentStatus(3, 0), "▶ ▷ ▷");
  assert.equal(renderSubagentStatus(3, 1), "▷ ▶ ▷");
  assert.equal(renderSubagentStatus(3, 2), "▷ ▷ ▶");
  assert.equal(renderSubagentStatus(3, 3), "▶ ▷ ▷");
});

test("Run observability counts active parallel branches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-"));
  try {
    await writeRun(root, "alpha", "running", [], 3);
    await writeRun(root, "beta", "running", [], 2);
    await writeRun(root, "done", "done", [], 9);
    const summary = summarizeRuns(root);
    assert.equal(summary.running, 2);
    assert.equal(summary.runningSubagents, 5);
    assert.equal(renderRunStatus(summary, 1), "▷ ▶ ▷ ▷ ▷");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability caches proc descendant scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-"));
  try {
    await writeRun(root, "alpha", "running", [], 0);
    assert.equal(countRunningSubagents(root), countRunningSubagents(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability keeps at least one triangle per running async run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-"));
  try {
    await writeRun(root, "alpha", "running", [], 0);
    await writeRun(root, "beta", "running", [], 2);
    await writeRun(root, "gamma", "running", [], 0);
    const summary = summarizeRuns(root);
    assert.equal(summary.running, 3);
    assert.equal(summary.runningSubagents, 4);
    assert.equal(renderRunStatus(summary, 1), "▷ ▶ ▷ ▷");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability finds opt-in retirement candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-"));
  try {
    await writeRun(root, "coordinator", "running", [], 0, undefined, "children_terminal");
    await writeRun(root, "busy", "running", [], 2, undefined, "children_terminal");
    await writeRun(root, "service", "running", [], 0);
    await writeRun(root, "done", "done", [], 0, undefined, "children_terminal");
    const candidates = findRunRetirementCandidates(summarizeRuns(root));
    assert.deepEqual(candidates.map((item) => item.run), ["coordinator"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability blocks retirement candidates with descendant subagents", () => {
  const candidates = findRunRetirementCandidates({
    cancelled: 0,
    done: 0,
    exited: 0,
    failed: 0,
    killed: 0,
    running: 2,
    runningSubagents: 2,
    runs: [
      {
        activeSubagents: 0,
        descendantSubagents: 1,
        retireWhen: "children_terminal",
        run: "supervisor-busy",
        stateDir: "/tmp/supervisor-busy",
        status: "running",
      },
      {
        activeSubagents: 0,
        descendantSubagents: 0,
        retireWhen: "children_terminal",
        run: "supervisor-idle",
        stateDir: "/tmp/supervisor-idle",
        status: "running",
      },
    ],
    total: 2,
  });
  assert.deepEqual(candidates, [
    {
      activeSubagents: 0,
      childRuns: 0,
      descendantSubagents: 0,
      run: "supervisor-idle",
      stateDir: "/tmp/supervisor-idle",
      terminalChildRuns: 0,
    },
  ]);
});

test("Run observability skips already handled retirement stops", () => {
  const candidates = findRunRetirementCandidates({
    cancelled: 0,
    done: 0,
    exited: 0,
    failed: 0,
    killed: 0,
    running: 1,
    runningSubagents: 1,
    runs: [
      {
        activeSubagents: 0,
        retireWhen: "children_terminal",
        run: "supervisor",
        stateDir: "/tmp/supervisor",
        status: "running",
        terminalHandled: true,
      },
    ],
    total: 1,
  });
  assert.deepEqual(candidates, []);
});

test("AX retirement notices preserve stop cancel skip failure and notifier-effect boundaries without closure claims", async () => {
  const run = "run:supervisor", stateDir = "/virtual/retirement";
  const summary = { cancelled: 0, done: 0, exited: 0, failed: 0, killed: 0, running: 1, runningSubagents: 1, total: 1,
    runs: [{ activeSubagents: 0, retireWhen: "children_terminal", run, stateDir, status: "running" as const }] };
  for (const mode of ["stop", "cancel", "skip", "failed", "silent_skip", "notify_stop", "notify_cancel"] as const) {
    const cause = new Error("Original cause"); let primaryReads = 0, secondaryReads = 0, noticeReads = 0;
    const primary = new Error("", { cause }), secondary = new Error("", { cause }), noticeFailure = new Error("", { cause });
    Object.defineProperty(primary, "message", { get: () => "## Stop\r\n- next: authored · kept " + ++primaryReads });
    Object.defineProperty(secondary, "message", { get: () => "Cancel failed " + ++secondaryReads });
    Object.defineProperty(noticeFailure, "message", { get: () => "Notice failed " + ++noticeReads });
    const calls: string[] = [], notices: Array<{ message: string; level: string }> = [], attempted = new Set<string>();
    const options = { attempted, sendStop: async () => { calls.push("stop"); if (mode !== "stop" && mode !== "notify_stop") throw primary; },
      cancelRun: () => { calls.push("cancel"); if (mode === "failed") throw secondary; return { cancelled: mode !== "skip" && mode !== "silent_skip" }; },
      ...(mode === "silent_skip" ? {} : { notify: (message: string, level: "info" | "warning" | "error") => {
        notices.push({ message, level }); if ((mode === "notify_stop" || mode === "notify_cancel") && notices.length === 1) throw noticeFailure;
      } }) };
    const results = await executeRunRetirements(summary, options);
    const action = mode === "stop" ? "stop" : mode === "failed" || mode === "notify_cancel" ? "failed" : mode === "skip" || mode === "silent_skip" ? "skip" : "cancel";
    assert.deepEqual(results, [{ action, run, stateDir, ...(action === "skip" ? { error: "## Stop\r\n- next: authored · kept " + (mode === "silent_skip" ? 1 : 2) }
      : mode === "failed" ? { error: "Cancel failed 1" } : mode === "notify_cancel" ? { error: "Notice failed 1" } : {}) }]);
    assert.deepEqual(calls, mode === "stop" ? ["stop"] : ["stop", "cancel"]);
    assert.equal(primaryReads, mode === "skip" ? 2 : mode === "silent_skip" ? 1 : 0);
    assert.equal(secondaryReads, mode === "failed" ? 1 : 0); assert.equal(noticeReads, mode === "notify_cancel" ? 1 : 0);
    assert.equal(primary.cause, cause); assert.equal(secondary.cause, cause); assert.equal(noticeFailure.cause, cause);
    for (const notice of notices) {
      assert.ok(notice.message.startsWith("- run: supervisor\n- retirement: "));
      assert.ok(notice.message.endsWith("- closure: unconfirmed")); assert.doesNotMatch(notice.message, /^- next:|run: run:|graceful stop failed/mu);
    }
    if (mode === "stop") assert.equal(notices[0].message, "- run: supervisor\n- retirement: stop\n- result: request returned\n- reason: child runs reached terminal state\n- closure: unconfirmed");
    if (mode === "cancel" || mode === "notify_stop") { assert.equal(notices.at(-1)!.level, "warning"); assert.ok(notices.at(-1)!.message.includes("- result: cancellation reported\n- reason: stop path failed")); }
    if (mode === "skip") assert.ok(notices[0].message.includes("- diagnostic:\n  ## Stop\r\n  - next: authored · kept 1"));
    if (mode === "failed" || mode === "notify_cancel") assert.equal(notices.at(-1)!.level, "error");
    const count = notices.length; assert.deepEqual(await executeRunRetirements(summary, options), [{ action: "skip", run, stateDir }]);
    assert.equal(notices.length, count); assert.equal(calls.length, mode === "stop" ? 1 : 2);
  }
});

test("Run observability executes retirement through graceful stop once", async () => {
  const attempted = new Set<string>();
  const calls: string[] = [];
  const notifications: string[] = [];
  const summary = {
    cancelled: 0,
    done: 1,
    exited: 0,
    failed: 0,
    killed: 0,
    running: 1,
    runningSubagents: 1,
    runs: [
      {
        activeSubagents: 0,
        retireWhen: "children_terminal",
        run: "supervisor",
        stateDir: "/tmp/supervisor",
        status: "running" as const,
      },
      {
        run: "child-done",
        stateDir: "/tmp/supervisor/child-done",
        status: "done" as const,
      },
    ],
    total: 2,
  };
  const first = await executeRunRetirements(summary, {
    attempted,
    cancelRun: () => ({ cancelled: true }),
    notify: (message, level) => notifications.push(`${level}:${message}`),
    sendStop: async (candidate) => calls.push(candidate.run),
  });
  const second = await executeRunRetirements(summary, {
    attempted,
    cancelRun: () => ({ cancelled: true }),
    sendStop: async (candidate) => calls.push(candidate.run),
  });
  assert.deepEqual(first, [{ action: "stop", run: "supervisor", stateDir: "/tmp/supervisor" }]);
  assert.deepEqual(second, [{ action: "skip", run: "supervisor", stateDir: "/tmp/supervisor" }]);
  assert.deepEqual(calls, ["supervisor"]);
  assert.match(notifications[0], /^info:- run: supervisor\n- retirement: stop\n- result: request returned/);
});

test("Run observability falls back to cancellation when graceful retirement stop fails", async () => {
  const results = await executeRunRetirements(
    {
      cancelled: 0,
      done: 0,
      exited: 0,
      failed: 0,
      killed: 0,
      running: 1,
      runningSubagents: 1,
      runs: [
        {
          activeSubagents: 0,
          retireWhen: "children_terminal",
          run: "supervisor",
          stateDir: "/tmp/supervisor",
          status: "running" as const,
        },
      ],
      total: 1,
    },
    {
      cancelRun: () => ({ cancelled: true }),
      sendStop: async () => {
        throw new Error("no endpoint");
      },
    },
  );
  assert.deepEqual(results, [{ action: "cancel", run: "supervisor", stateDir: "/tmp/supervisor" }]);
});

test("Run observability blocks retirement candidates with running child async runs", () => {
  const candidates = findRunRetirementCandidates({
    cancelled: 0,
    done: 1,
    exited: 0,
    failed: 0,
    killed: 0,
    running: 2,
    runningSubagents: 2,
    runs: [
      {
        activeSubagents: 0,
        retireWhen: "children_terminal",
        run: "supervisor",
        stateDir: "/tmp/supervisor",
        status: "running",
      },
      {
        run: "child-running",
        stateDir: "/tmp/supervisor/child-running",
        status: "running",
      },
      {
        run: "child-done",
        stateDir: "/tmp/supervisor/child-done",
        status: "done",
      },
    ],
    total: 3,
  });
  assert.deepEqual(candidates, []);
  const ready = findRunRetirementCandidates({
    cancelled: 0,
    done: 2,
    exited: 0,
    failed: 0,
    killed: 0,
    running: 1,
    runningSubagents: 1,
    runs: [
      {
        activeSubagents: 0,
        retireWhen: "children_terminal",
        run: "supervisor",
        stateDir: "/tmp/supervisor",
        status: "running",
      },
      {
        run: "child-done-a",
        stateDir: "/tmp/supervisor/child-done-a",
        status: "done",
      },
      {
        run: "child-done-b",
        stateDir: "/tmp/supervisor/child-done-b",
        status: "failed",
      },
    ],
    total: 3,
  });
  assert.deepEqual(ready, [
    {
      activeSubagents: 0,
      childRuns: 2,
      descendantSubagents: 0,
      run: "supervisor",
      stateDir: "/tmp/supervisor",
      terminalChildRuns: 2,
    },
  ]);
});

test("Run observability hides status when no runs are running", () => {
  assert.equal(
    renderRunStatus({
      cancelled: 0,
      done: 3,
      exited: 1,
      failed: 0,
      killed: 0,
      running: 0,
      runningSubagents: 0,
      runs: [],
      total: 4,
    }),
    undefined,
  );
});
