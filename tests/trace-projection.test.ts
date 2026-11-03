import "./test-environment.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as TraceProjection from "../lib/trace-projection.ts";

import { TRACE_JOURNAL_MAX_BYTES } from "../lib/limits.ts";
import {
  projectRunTrace,
  TRACE_ITEM_SEQUENCE,
} from "../lib/trace-projection.ts";

const { projectRunTraceJournal } = await import("../lib/trace-projection.ts");
const { readRunTraceJournal } = await import("../lib/runs-trace.ts");


test("Agent Trace display counts only retained post-privacy text without splitting scalars", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-omissions-"));
  const dir = join(root, "sessions", "command-001");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, "execution.json"), JSON.stringify({
      commands: [{ id: "command-001", session_files: ["sessions/command-001/session.jsonl"] }],
    }));
    const cases = [
      { text: "🌍".repeat(80), summary: "🌍".repeat(80) },
      { text: "x".repeat(160), summary: "x".repeat(160) },
      { text: "x".repeat(161), summary: "x".repeat(160) + "… [omitted: 1 chars] from normalized retained turn; upstream [omitted: unknown]" },
      { text: "a".repeat(159) + "🌍z", summary: "a".repeat(159) + "… [omitted: 2 chars] from normalized retained turn; upstream [omitted: unknown]" },
      { text: "🌍".repeat(81), summary: "🌍".repeat(80) + "… [omitted: 1 chars] from normalized retained turn; upstream [omitted: unknown]" },
      { text: "A \n " + "b".repeat(160), summary: "A " + "b".repeat(158) + "… [omitted: 2 chars] from normalized retained turn; upstream [omitted: unknown]" },
      { text: "z".repeat(5000), summary: "z".repeat(160) + "… [omitted: 3840 chars] from normalized retained turn; upstream [omitted: unknown]" },
      { text: "Kept … [7 characters omitted from retained turn; upstream count unknown]", summary: "Kept … [7 characters omitted from retained turn; upstream count unknown]" },
      ...[4, 5000].map(length => ({ text: "token=" + "H".repeat(length) + " " + "b".repeat(161),
        summary: "token=[REDACTED] " + "b".repeat(143) + "… [omitted: 18 chars] from normalized retained turn; upstream [omitted: unknown]" })),
    ];
    for (const value of cases) {
      const content = [
        { type: "session", version: 3, id: "session" },
        { type: "message", id: "u", parentId: null, message: { role: "user", content: "Review" } },
        { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: value.text } },
      ].map(entry => JSON.stringify(entry)).join("\n");
      await writeFile(join(dir, "session.jsonl"), content);
      const rows = projectRunTrace(root, { source: "agent" });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].summary, value.summary);
      assert.equal(Buffer.from(rows[0].summary).toString("utf8"), rows[0].summary);
      assert.notEqual(rows[0].id, "agent:command-001:sessions/command-001/session.jsonl:1");
      assert.match(rows[0].id, /^agent:entry:[a-f0-9]{64}$/);
      assert.equal(rows[0][TRACE_ITEM_SEQUENCE], 1);
      assert.deepEqual(Object.keys(rows[0]).sort(), ["detail", "id", "kind", "source", "summary", "ts"]);
      const retained = (rows[0].detail as Record<string, unknown>).assistantText as string;
      const compact = retained.replaceAll(/\s+/gu, " ").trim();
      const marker = /… \[omitted: (\d+) chars\] from normalized retained turn; upstream \[omitted: unknown\]$/u.exec(rows[0].summary);
      if (marker) {
        const preview = rows[0].summary.slice(0, marker.index);
        assert.ok(preview.length <= 160); assert.ok(compact.startsWith(preview));
        assert.equal(Number(marker[1]), Array.from(compact.slice(preview.length)).length);
        assert.doesNotMatch(rows[0].summary, /omitted: 0 chars/);
      } else assert.equal(rows[0].summary, compact);
      assert.doesNotMatch(JSON.stringify(rows), /HHHH/);
      assert.equal(fs.readFileSync(join(dir, "session.jsonl"), "utf8"), content);
    }
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Agent Trace display cannot invent a count for malformed already-retained text", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-unknown-"));
  try {
    await mkdir(join(root, "sessions", "command-001"), { recursive: true });
    await writeFile(join(root, "execution.json"), JSON.stringify({
      commands: [{ id: "command-001", session_files: ["sessions/command-001/session.jsonl"] }],
    }));
    await writeFile(join(root, "sessions", "command-001", "session.jsonl"), [
      { type: "session", version: 3, id: "session" },
      { type: "message", id: "u", parentId: null, message: { role: "user", content: "Review" } },
      { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: "q".repeat(3998) + "🌍tail" } },
    ].map(entry => JSON.stringify(entry)).join("\n"));
    const [row] = projectRunTrace(root, { source: "agent" });
    const retained = (row.detail as Record<string, unknown>).assistantText as string;
    assert.equal(retained.length, 4000);
    assert.notEqual(Buffer.from(retained).toString("utf8"), retained, "Existing upstream UTF-16 cut has already lost a scalar");
    assert.equal(row.summary, "Agent turn [omitted: unknown] (malformed retained text)");
    assert.doesNotMatch(row.summary, /\[omitted: \d+ chars\]|\ud800|\udfff|\ufffd|…/u);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Canonical Trace projection redacts summaries without changing source IDs/order", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-summary-privacy-"));
  try {
    await writeFile(join(root, "trace.jsonl"), [
      { id: "first", ts: "2026-01-01T00:00:00.000Z", kind: "runtime.note", summary: "token=HIDDEN_SUMMARY" },
      { id: "second", ts: "2026-01-01T00:00:00.000Z", kind: "runtime.note", summary: "Bearer HIDDEN_BEARER", data: { password: "HIDDEN_DATA" } },
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    const projected = projectRunTrace(root, { source: "runtime" });
    assert.deepEqual(projected.map(item => item.id), ["second", "first"]);
    assert.doesNotMatch(JSON.stringify(projected), /HIDDEN_SUMMARY|HIDDEN_BEARER|HIDDEN_DATA/);
    assert.match(JSON.stringify(projected), /REDACTED/);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Canonical Trace snapshot projection reads no other sources and shares captured Recipe origin privacy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-selective-"));
  try {
    await writeFile(join(root, "trace.jsonl"), JSON.stringify({ id: "one", ts: "2026-01-01T00:00:00.000Z",
      kind: "command.start", summary: "Run /private/trace/tools/helper.mjs", data: { command: "/private/trace/tools/helper.mjs", api_key: "HIDDEN_KEY" } }) + "\n");
    const read = readRunTraceJournal(root);
    const originals = { openSync: fs.openSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync };
    const forbidden = () => assert.fail("Data-only canonical Trace projection attempted filesystem access");
    fs.openSync = forbidden as typeof fs.openSync;
    fs.readFileSync = forbidden as typeof fs.readFileSync;
    fs.readdirSync = forbidden as typeof fs.readdirSync;
    syncBuiltinESMExports();
    try {
      const items = projectRunTraceJournal(read, { limit: 40, recipe: { values: { skill_dir: "/private/trace" } } });
      assert.equal(items[0].id, "one");
      assert.equal(items[0][TRACE_ITEM_SEQUENCE], 0);
      assert.doesNotMatch(JSON.stringify(items), /\/private\/trace|HIDDEN_KEY/);
      assert.match(JSON.stringify(items), /PRIVATE_RECIPE_ORIGIN/);
    } finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Trace artifact rows use metadata-only observation, not full-file hashing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-artifact-metadata-"));
  const path = join(root, "artifact.bin");
  try {
    await writeFile(path, ""); fs.truncateSync(path, 128 * 1024 * 1024);
    const open = fs.openSync; const close = fs.closeSync; const read = fs.readSync;
    const fds = new Set<number>(); let bodyReads = 0;
    fs.openSync = ((file, ...args) => { const fd = Reflect.apply(open, fs, [file, ...args]); if (String(file) === path) fds.add(fd); return fd; }) as typeof fs.openSync;
    fs.closeSync = ((fd) => { fds.delete(fd); return close(fd); }) as typeof fs.closeSync;
    fs.readSync = ((fd, ...args) => { if (fds.has(fd)) { bodyReads++; throw new Error("Do not hash artifact bodies for Trace"); } return Reflect.apply(read, fs, [fd, ...args]); }) as typeof fs.readSync;
    syncBuiltinESMExports();
    try {
      const rows = projectRunTrace(root, { source: "artifact", artifacts: { result: path } });
      assert.equal(rows[0]?.kind, "artifact.ready");
      assert.equal(bodyReads, 0);
      assert.equal((rows[0]?.detail as Record<string, unknown>).size, 128 * 1024 * 1024);
    } finally { fs.openSync = open; fs.closeSync = close; fs.readSync = read; syncBuiltinESMExports(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Post-stop result captures remain nonterminal in projected process evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-stop-capture-"));
  try {
    for (const code of [0, 7]) {
      await writeFile(join(root, "result.json"), JSON.stringify({
        code, completedAt: "2026-01-01T00:00:04.000Z", run_instance_id: "generation-a",
        terminal_acceptance: "after_stop_claim", stop_claim_id: "claim-a",
      }));
      const result = projectRunTrace(root, { source: "process" }).find((item) => item.id === "process:result");
      assert.equal(result?.kind, "process.result_captured");
      assert.equal(result?.summary, "Workload result captured while stopping");
      assert.equal((result?.detail as Record<string, unknown>).code, code);
      assert.equal(Object.hasOwn(result ?? {}, "attention"), false);
    }
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Trace chronology ranks retained metadata before source limits and preserves the basis under filters", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-common-chronology-"));
  const time = (value: number) => new Date(value).toISOString();
  const event = (index: number) => ({ id: `chronology-${index}`, ts: time(index), kind: index % 2 ? "run.note" : "runtime.note" });
  const frame = (item: TraceProjection.TraceItem) => item[TraceProjection.TRACE_ITEM_CHRONOLOGY]!;
  const available = (item: TraceProjection.TraceItem) => { const value = frame(item); assert.ok(value.state === "available"); return value; };
  try {
    await writeFile(join(root, "trace.jsonl"), Array.from({ length: 101 }, (_, index) => JSON.stringify(event(index))).join("\n") + "\n");
    const first = projectRunTrace(root);
    assert.deepEqual(frame(first[0]), { state: "available", basis: "recorded_observations", ordinal: 101, total: 101 });
    assert.equal(first.length, 100);
    fs.appendFileSync(join(root, "trace.jsonl"), JSON.stringify(event(101)) + "\n");
    const next = projectRunTrace(root);
    assert.equal(frame(next[0]).state, "available");
    assert.deepEqual(frame(next[0]), { state: "available", basis: "recorded_observations", ordinal: 102, total: 102 });
    assert.equal(available(next[1]).ordinal, 101);
    const lifecycle = projectRunTrace(root, { source: "lifecycle" });
    for (const row of lifecycle) assert.deepEqual(frame(row), frame(next.find(item => item.id === row.id)!));
    const relative = "sessions/command/session.jsonl";
    await mkdir(join(root, "sessions", "command"), { recursive: true });
    await writeFile(join(root, "execution.json"), JSON.stringify({ commands: [{ id: "command", session_files: [relative] }] }));
    await writeFile(join(root, relative), [JSON.stringify({ type: "session", version: 3, id: "session" }),
      ...Array.from({ length: 101 }, (_, index) => JSON.stringify({ type: "message", id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
        timestamp: time(200 + index), message: { role: "assistant", content: "Retained body " + index } }))].join("\n") + "\n");
    await writeFile(join(root, "controls.jsonl"), JSON.stringify({ id: "c0", run_instance_id: "generation", action: "pause", status: "queued", queued_at: time(500), input: { token: "NEVER_METADATA" } }) + "\n");
    await writeFile(join(root, "stdout.log"), "Mutable snapshot");
    fs.utimesSync(join(root, "stdout.log"), new Date(700), new Date(700));
    const mixed = projectRunTrace(root, { limit: 200 });
    assert.equal(mixed.length, 200);
    assert.deepEqual(frame(mixed[0]), { state: "available", basis: "recorded_observations", ordinal: 205, total: 205 });
    assert.equal(mixed[0].id, "process:stdout");
    assert.ok(mixed.every(row => frame(row).state === "available"));
    const ranks = mixed.map(row => { const value = frame(row); return value.state === "available" ? value.ordinal : -1; });
    assert.ok(ranks.every((value, index) => !index || value < ranks[index - 1]));
    const agents = projectRunTrace(root, { source: "agent" });
    assert.equal(agents.length, 100);
    assert.deepEqual(frame(agents[0]), frame(mixed.find(row => row.id === agents[0].id)!));
    assert.equal(available(agents.at(-1)!).ordinal, 104);
    assert.ok(Object.isFrozen(frame(mixed[0])));
    assert.equal(Object.getOwnPropertyDescriptor(mixed[0], TraceProjection.TRACE_ITEM_CHRONOLOGY)?.enumerable, false);
    assert.doesNotMatch(JSON.stringify(mixed), /recorded_observations|NEVER_METADATA/);
    fs.appendFileSync(join(root, "trace.jsonl"), JSON.stringify({ id: "late-older", ts: time(-1), kind: "runtime.note" }) + "\n");
    assert.equal(available(projectRunTrace(root)[0]).ordinal, 206, "Late evidence changes rank, not identity");
    const eventsBefore = readRunTraceJournal(root).events.length;
    fs.utimesSync(join(root, "stdout.log"), new Date(50), new Date(50));
    const moved = projectRunTrace(root, { limit: 200 }).find(row => row.id === "process:stdout")!;
    assert.equal(available(moved).total, 206);
    assert.ok(available(moved).ordinal < 206);
    assert.equal(readRunTraceJournal(root).events.length, eventsBefore, "Snapshot updates/read ranks synthesize no journal event");
    for (const [records, reason] of [[[{ id: "control:c0", ts: time(1), kind: "runtime.note" }], "metadata_ambiguous"],
      [[{ id: "token=HIDDEN", ts: time(1), kind: "runtime.note" }], "metadata_private"]] as const) {
      await writeFile(join(root, "trace.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
      assert.ok(projectRunTrace(root).every(row => frame(row).state === "unavailable"));
      assert.deepEqual(frame(projectRunTrace(root)[0]), { state: "unavailable", basis: "recorded_observations", reason });
    }
    fs.appendFileSync(join(root, "trace.jsonl"), "malformed JSON\n");
    assert.equal(frame(projectRunTrace(root)[0]).state, "unavailable");
    const bounded = join(root, "metadata-budget"); await mkdir(bounded);
    for (const count of [1050, 1060]) {
      const records = Array.from({ length: count }, (_, index) => ({ id: "🌍".repeat(970) + index, ts: time(index), kind: "runtime.note" }));
      const source = records.map(record => JSON.stringify(record)).join("\n") + "\n";
      assert.ok(Buffer.byteLength(source) < TRACE_JOURNAL_MAX_BYTES);
      await writeFile(join(bounded, "trace.jsonl"), source);
      assert.equal(readRunTraceJournal(bounded).events.length, count, "Metadata overflow is independent of source loss");
      const rows = projectRunTrace(bounded);
      assert.equal(rows.length, 100, "A metadata index is not a body or work quota");
      if (count === 1050) assert.equal(available(rows[0]).ordinal, count);
      else assert.deepEqual(frame(rows[0]), { state: "unavailable", basis: "recorded_observations", reason: "metadata_too_large" });
    }
    const tied = join(root, "equal-times"); await mkdir(tied);
    for (const count of [2, 102]) {
      await writeFile(join(tied, "trace.jsonl"), Array.from({ length: count }, (_, index) => JSON.stringify({ ...event(index), ts: time(1) })).join("\n") + "\n");
      await writeFile(join(tied, "controls.jsonl"), JSON.stringify({ id: "tie", action: "pause", status: "queued", run_instance_id: "generation", queued_at: time(1) }) + "\n");
      const all = projectRunTrace(tied, { limit: 200 });
      if (count === 2) assert.equal(available(all[0]).total, 3);
      for (const source of ["all", "lifecycle", "runtime", "control"] as const) {
        const rows = projectRunTrace(tied, { source, limit: 200 });
        if (frame(rows[0]).state === "available") {
          const numbers = rows.map(row => available(row).ordinal);
          assert.ok(numbers.every((rank, index) => !index || rank < numbers[index - 1]), "Do not publish ranks inconsistent with preserved legacy tie order");
        } else assert.deepEqual(frame(rows[0]), { state: "unavailable", basis: "recorded_observations", reason: "metadata_ambiguous" });
        for (const row of rows) assert.deepEqual(frame(row), frame(all.find(item => item.id === row.id)!));
      }
    }
    await writeFile(join(tied, "trace.jsonl"), "");
    await writeFile(join(tied, "controls.jsonl"), Array.from({ length: 128 }, (_, index) => JSON.stringify({ id: `handled-${index}`, action: "pause", status: "handled",
      run_instance_id: "generation", queued_at: time(index), handled_at: time(index) })).join("\n") + "\n");
    const terminalTail = projectRunTrace(tied);
    assert.equal(terminalTail.length, 100);
    assert.deepEqual(frame(terminalTail[0]), { state: "unavailable", basis: "recorded_observations", reason: "control_history_unproven" });
    for (const metadata of [{ id: "", run_instance_id: "generation" }, { id: "x".repeat(200), run_instance_id: "generation" }, { id: "id", run_instance_id: "" }]) {
      await writeFile(join(tied, "controls.jsonl"), JSON.stringify({ ...metadata, action: "pause", status: "queued", queued_at: time(1) }) + "\n");
      const rows = projectRunTrace(tied);
      assert.equal(rows.length, 1, "Missing/clipped metadata must not tighten the legacy Control body projection");
      assert.deepEqual(frame(rows[0]), { state: "unavailable", basis: "recorded_observations", reason: "metadata_unavailable" });
    }
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Trace projection retains stable sequences beyond the visible tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-sequence-"));
  try {
    await writeFile(
      join(root, "trace.jsonl"),
      Array.from({ length: 101 }, (_, sequence) => JSON.stringify({
        id: `trace-${sequence}`,
        ts: new Date(sequence).toISOString(),
        kind: "runtime.note",
      })).join("\n") + "\n",
    );
    const items = projectRunTrace(root);
    assert.equal(items.length, 100);
    assert.equal(items[0]?.id, "trace-100");
    assert.equal(items[0]?.[TRACE_ITEM_SEQUENCE], 100);
    assert.equal(items[1]?.[TRACE_ITEM_SEQUENCE], 99);
    assert.equal(Object.hasOwn(items[0] ?? {}, "sequence"), false);
    assert.equal(readRunTraceJournal(root).events.length, 101);
    const largerDisplay = projectRunTrace(root, { limit: 200 });
    assert.equal(largerDisplay.length, 100, "Source collection is capped before the overall display bound");
    const oldLatest = items[0]!.id;
    fs.appendFileSync(join(root, "trace.jsonl"), JSON.stringify({ id: "trace-101", ts: new Date(101).toISOString(), kind: "runtime.note" }) + "\n");
    const advanced = projectRunTrace(root, { limit: 200 });
    assert.equal(readRunTraceJournal(root).events.length, 102);
    assert.equal(advanced.length, 100);
    assert.equal(advanced[0].id, "trace-101");
    assert.equal(advanced[0][TRACE_ITEM_SEQUENCE], 101);
    assert.equal(advanced[1].id, oldLatest);
    assert.equal(advanced[1][TRACE_ITEM_SEQUENCE], 100);
    // This intentionally remains 100: reversing a bounded array cannot mint the lifetime ordinal 102.
    assert.equal(advanced.length, largerDisplay.length);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Agent Trace identity follows retained entries across sibling growth and manifest reorder", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-agent-identity-"));
  const files = ["sessions/alpha/session.jsonl", "sessions/beta/session.jsonl"];
  const commands = files.map((file, index) => ({ id: `command-${index}`, session_files: [file] }));
  const record = (id: string, parentId: string | null, text: string, timestamp: string) => ({
    type: "message", id, parentId, timestamp, message: { role: "assistant", content: text } });
  const nativeId = "native-entry";
  try {
    for (const [index, file] of files.entries()) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), [ { type: "session", version: 3, id: "session" },
        record(nativeId, null, index ? "Beta original" : "Alpha original", `2026-01-01T00:00:${index ? "20" : "10"}.000Z`)
      ].map(value => JSON.stringify(value)).join("\n") + "\n");
    }
    const manifest = join(root, "execution.json");
    await writeFile(manifest, JSON.stringify({ commands }));
    const first = projectRunTrace(root, { source: "agent" });
    const beta = first.find(item => item.summary === "Beta original")!;
    assert.notEqual(beta.id, first.find(item => item.summary === "Alpha original")!.id);
    fs.appendFileSync(join(root, files[0]), JSON.stringify(record("alpha-next", nativeId, "Alpha next", "2026-01-01T00:00:30.000Z")) + "\n");
    const grown = projectRunTrace(root, { source: "agent" });
    assert.deepEqual(grown.map(item => item.summary), ["Alpha next", "Beta original", "Alpha original"]);
    assert.equal(grown.find(item => item.summary === "Beta original")!.id, beta.id);
    assert.match(beta.id, /^agent:entry:[a-f0-9]{64}$/);
    assert.notEqual(grown.find(item => item.summary === "Beta original")![TRACE_ITEM_SEQUENCE], beta[TRACE_ITEM_SEQUENCE]);
    await writeFile(manifest, JSON.stringify({ commands: [...commands].reverse() }));
    const reordered = projectRunTrace(root, { source: "agent" });
    assert.deepEqual(reordered.map(item => item.id), grown.map(item => item.id));
    assert.doesNotMatch(JSON.stringify(reordered), /session.turn.identity/);
    assert.equal(reordered.every(item => Object.getOwnPropertySymbols(item.detail as object).length === 0), true);
    const bytes = fs.readFileSync(join(root, files[1]));
    fs.appendFileSync(join(root, files[1]), JSON.stringify(record("other-branch", null, "Other branch", "2026-01-01T00:00:40.000Z")) + "\n");
    assert.equal(projectRunTrace(root, { source: "agent" }).some(item => item.id === beta.id), false);
    fs.appendFileSync(join(root, files[1]), JSON.stringify(record("return-leaf", nativeId, "Return branch", "2026-01-01T00:00:50.000Z")) + "\n");
    assert.equal(projectRunTrace(root, { source: "agent" }).find(item => item.summary === "Beta original")!.id, beta.id);
    assert.ok(fs.readFileSync(join(root, files[1])).subarray(0, bytes.length).equals(bytes));
    const replaced = fs.readFileSync(join(root, files[1]), "utf8").replace('"id":"session"', '"id":"replacement-session"');
    await writeFile(join(root, files[1]), replaced);
    assert.notEqual(projectRunTrace(root, { source: "agent" }).find(item => item.summary === "Beta original")!.id, beta.id);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Agent Trace identity distinguishes ambiguous and incomplete entry provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-agent-legacy-identity-"));
  const file = join(root, "sessions", "command", "session.jsonl");
  const header = JSON.stringify({ type: "session", version: 3, id: "session" }) + "\n";
  const message = (id: unknown, text: string) => JSON.stringify({ type: "message", ...(id !== undefined ? { id } : {}), parentId: null,
    message: { role: "assistant", content: text } }) + "\n";
  try {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(join(root, "execution.json"), JSON.stringify({ commands: [{ id: "command", session_files: ["sessions/command/session.jsonl"] }] }));
    const rows = () => projectRunTrace(root, { source: "agent" });
    await writeFile(file, header + message("same", "Original"));
    const native = rows()[0].id;
    await writeFile(file, header + JSON.stringify({ type: "message", id: "same", parentId: null, message: { role: "user", content: "Pending user" } }) + "\n");
    assert.notEqual(rows()[0].id, native, "User-only and assistant provenance have distinct roles");
    await writeFile(file, header + message("same", "Original"));
    fs.appendFileSync(file, message("same", "Replacement"));
    const duplicate = rows()[0];
    assert.equal(duplicate.summary, "Replacement");
    assert.notEqual(duplicate.id, native);
    assert.match(duplicate.id, /^agent:record:[a-f0-9]{64}$/);
    fs.appendFileSync(file, message("same", "Replacement again"));
    assert.notEqual(rows()[0].id, duplicate.id);
    await writeFile(file, header + message("", "Empty id"));
    assert.match(rows()[0].id, /^agent:record:[a-f0-9]{64}$/);
    await writeFile(file, header + message(undefined, "Missing id"));
    assert.deepEqual(rows(), []);
    await writeFile(file, message("same", "No session header"));
    assert.match(rows()[0].id, /^agent:record:[a-f0-9]{64}$/);
    await writeFile(file, header + header + message("same", "Duplicate session header"));
    assert.match(rows()[0].id, /^agent:record:[a-f0-9]{64}$/);
    let privateKey: string | undefined;
    for (const length of [4, 4000]) {
      await writeFile(file, header + message("token=" + "H".repeat(length), "Private id"));
      const row = rows()[0];
      assert.match(row.id, /^agent:record:[a-f0-9]{64}$/);
      if (privateKey) assert.equal(row.id, privateKey, "Hidden native id values/lengths do not become digest inputs");
      privateKey = row.id;
    }
    let privateHeaderKey: string | undefined;
    for (const length of [4, 4000]) {
      await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "token=" + "H".repeat(length) }) + "\n" + message("native", "Private header"));
      const row = rows()[0];
      assert.match(row.id, /^agent:record:[a-f0-9]{64}$/);
      if (privateHeaderKey) assert.equal(row.id, privateHeaderKey, "Hidden header values/lengths do not become digest inputs");
      privateHeaderKey = row.id;
    }
    const manifest = join(root, "execution.json");
    let privateNamespace: string | undefined;
    await writeFile(file, header + message("native", "Private namespace"));
    for (const length of [4, 4000]) {
      await writeFile(manifest, JSON.stringify({ commands: [{ id: "token=" + "H".repeat(length), session_files: ["sessions/command/session.jsonl"] }] }));
      const row = rows()[0];
      assert.match(row.id, /^agent:legacy:[a-f0-9]{64}$/);
      if (privateNamespace) assert.equal(row.id, privateNamespace, "Hidden namespace values/lengths do not become digest inputs");
      privateNamespace = row.id;
    }
    await writeFile(manifest, JSON.stringify({ commands: [{ id: "command", session_files: ["sessions/command/session.jsonl"] }] }));
    await writeFile(file, "malformed JSON\n" + header + message("native", "Degraded source"));
    assert.match(rows()[0].id, /^agent:record:[a-f0-9]{64}$/);
    const entries = Array.from({ length: 101 }, (_, index) => JSON.stringify({ type: "message", id: `tail-${index}`,
      parentId: index ? `tail-${index - 1}` : null, message: { role: "assistant", content: `Tail ${index}` } }) + "\n").join("");
    await writeFile(file, header + entries);
    const boundedTurns = rows();
    assert.equal(boundedTurns.length, 100);
    assert.match(boundedTurns[0].id, /^agent:entry:[a-f0-9]{64}$/);
    assert.equal((boundedTurns[0].detail as Record<string, unknown>).sessionTruncated, true);
    await writeFile(file, JSON.stringify({ type: "session", padding: "p".repeat(4 * 1024 * 1024) }) + "\n" + message("tail", "Visible retained tail"));
    assert.deepEqual(rows(), [], "Oversized evidence is refused, not a fabricated retained prefix");
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Trace process rows are mutable observations, not new append-only events", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-observation-"));
  try {
    await writeFile(join(root, "trace.jsonl"), JSON.stringify({ id: "action", ts: "2026-01-01T00:00:15.000Z", kind: "command.done" }) + "\n");
    const output = join(root, "stdout.log");
    await writeFile(output, "before\n");
    fs.utimesSync(output, new Date("2026-01-01T00:00:10.000Z"), new Date("2026-01-01T00:00:10.000Z"));
    const before = projectRunTrace(root);
    assert.deepEqual(before.map(item => item.id), ["action", "process:stdout"]);
    await writeFile(output, "after\n");
    fs.utimesSync(output, new Date("2026-01-01T00:00:20.000Z"), new Date("2026-01-01T00:00:20.000Z"));
    const after = projectRunTrace(root);
    assert.deepEqual(after.map(item => item.id), ["process:stdout", "action"]);
    assert.equal(before.length, after.length);
    assert.equal(before[1][TRACE_ITEM_SEQUENCE], after[0][TRACE_ITEM_SEQUENCE]);
    assert.notEqual(before[1].ts, after[0].ts);
    assert.equal(readRunTraceJournal(root).events.length, 1, "Projection refresh does not synthesize a canonical event");
    fs.appendFileSync(join(root, "trace.jsonl"), JSON.stringify({ id: "late-older", ts: "2026-01-01T00:00:12.000Z", kind: "command.done" }) + "\n");
    const late = projectRunTrace(root);
    assert.deepEqual(late.map(item => item.id), ["process:stdout", "action", "late-older"]);
    assert.ok(late[2][TRACE_ITEM_SEQUENCE]! > late[1][TRACE_ITEM_SEQUENCE]!, "Append order is not timestamp order");
    assert.equal(after[1].id, late[1].id);
    assert.notEqual(after.length - 1, late.length - 1, "A rank computed from current chronology can change for an existing id after an older observation arrives");
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Trace projection merges causal Run evidence newest-first", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-projection-"));
  try {
    await mkdir(join(root, "artifacts"));
    await writeFile(join(root, "artifacts", "report.md"), "report\n");
    await writeFile(join(root, "stdout.log"), "hello\n");
    await writeFile(
      join(root, "trace.jsonl"),
      `${JSON.stringify({ id: "trace-1", ts: "2026-01-01T00:00:01.000Z", kind: "run.start", data: { pid: 1 } })}\n`,
    );
    await writeFile(
      join(root, "controls.jsonl"),
      `${JSON.stringify({ id: "control-1", run_instance_id: "generation-a", action: "pause", input: { apiKey: "secret" }, status: "handled", queued_at: "2026-01-01T00:00:02.000Z", handled_at: "2026-01-01T00:00:03.000Z" })}\n`,
    );
    await writeFile(
      join(root, "result.json"),
      JSON.stringify({ code: 0, completedAt: "2026-01-01T00:00:04.000Z" }),
    );
    const items = projectRunTrace(root, {
      artifacts: { report: join(root, "artifacts", "report.md") },
    });
    assert.deepEqual(
      items.map((item) => item.ts),
      items.map((item) => item.ts).toSorted().reverse(),
    );
    assert.equal(items.some((item) => item.kind === "process.result"), true);
    assert.equal(items.some((item) => item.kind === "run.start"), true);
    assert.equal(items.some((item) => item.kind === "control.handled"), true);
    assert.equal(items.some((item) => item.kind === "process.stdout"), true);
    assert.equal(items.some((item) => item.kind === "artifact.ready"), true);
    assert.equal(JSON.stringify(items).includes("secret"), false);
    assert.equal(JSON.stringify(items).includes("[REDACTED]"), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Trace projection uses physical source order for equal timestamps", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-order-"));
  const ts = "2026-01-01T00:00:00.000Z";
  try {
    await writeFile(join(root, "trace.jsonl"), [
      { id: "z-trace-first", ts, kind: "run.start" },
      { id: "a-trace-second", ts, kind: "run.progress" },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    await writeFile(join(root, "controls.jsonl"), [
      { id: "z-control-first", run_instance_id: "g", action: "pause", status: "queued", queued_at: ts },
      { id: "a-control-second", run_instance_id: "g", action: "resume", status: "queued", queued_at: ts },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const sessionDir = join(root, "sessions", "command-1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(root, "execution.json"), JSON.stringify({
      commands: [{ id: "command-1", session_files: ["sessions/command-1/session.jsonl"] }],
    }));
    await writeFile(join(sessionDir, "session.jsonl"), [
      { type: "session", version: 3, id: "session" },
      { type: "message", id: "u1", parentId: null, timestamp: ts, message: { role: "user", content: "first user" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: ts, message: { role: "assistant", content: "first agent" } },
      { type: "message", id: "u2", parentId: "a1", timestamp: ts, message: { role: "user", content: "second user" } },
      { type: "message", id: "a2", parentId: "u2", timestamp: ts, message: { role: "assistant", content: "second agent" } },
    ].map((value) => JSON.stringify(value)).join("\n"));
    assert.deepEqual(
      projectRunTrace(root, { source: "lifecycle" }).map(({ id }) => id),
      ["a-trace-second", "z-trace-first"],
    );
    assert.deepEqual(
      projectRunTrace(root, { source: "control" }).map(({ id }) => id),
      ["control:a-control-second", "control:z-control-first"],
    );
    assert.deepEqual(
      projectRunTrace(root, { source: "agent" }).map(({ summary }) => summary),
      ["second agent", "first agent"],
    );
    const expected = [
      "a-trace-second",
      "z-trace-first",
      "control:a-control-second",
      "control:z-control-first",
      "agent:command-1:sessions/command-1/session.jsonl:2",
      "agent:command-1:sessions/command-1/session.jsonl:1",
    ];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rows = projectRunTrace(root);
      // Retain the original source-order witnesses; agent public ids now key provenance rather than these traversal labels.
      assert.deepEqual(rows.map(item => {
        if (item.source !== "agent") return item.id;
        const turn = item.detail as { commandId: string; sessionFile: string; index: number };
        assert.match(item.id, /^agent:entry:[a-f0-9]{64}$/);
        return `agent:${turn.commandId}:${turn.sessionFile}:${turn.index}`;
      }), expected);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Trace projection preserves rich owned agent turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-projection-"));
  try {
    const sessionDir = join(root, "sessions", "command-001");
    const minimalSessionDir = join(root, "sessions", "command-002");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(minimalSessionDir, { recursive: true });
    await writeFile(join(root, "outside.jsonl"), "OUTSIDE_SESSION_SECRET\n");
    await writeFile(
      join(root, "execution.json"),
      JSON.stringify({
        commands: [
          {
            id: "command-001",
            session_files: [
              "sessions/command-001/session.jsonl",
              "outside.jsonl",
            ],
            stage: "reviewer",
          },
          {
            id: "command-002",
            session_files: ["sessions/command-002/session.jsonl"],
            stage: "worker",
          },
        ],
      }),
    );
    await writeFile(
      join(sessionDir, "session.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "session" }),
        JSON.stringify({
          type: "message",
          id: "u",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "Audit Trace" },
        }),
        JSON.stringify({
          type: "message",
          id: "a",
          parentId: "u",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "assistant",
            errorMessage: "authorization=AGENT_ERROR_SECRET unavailable",
            model: "test/model",
            provider: "test",
            stopReason: "toolUse",
            usage: { input: 12, output: 7, token: "AGENT_USAGE_SECRET" },
            content: [
              { type: "thinking", thinking: "Persisted thought" },
              { type: "text", text: "Audit complete" },
              { type: "toolCall", id: "call-1", name: "read", arguments: { apiKey: "secret" } },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "r",
          parentId: "a",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "Result token=AGENT_RESULT_SECRET" }],
            isError: true,
          },
        }),
      ].join("\n"),
    );
    await writeFile(
      join(minimalSessionDir, "session.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "minimal" }),
        JSON.stringify({
          type: "message",
          id: "u2",
          parentId: null,
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "user", content: "Run check" },
        }),
        JSON.stringify({
          type: "message",
          id: "a2",
          parentId: "u2",
          timestamp: "2026-01-01T00:00:03.000Z",
          message: { role: "assistant", content: "Check complete" },
        }),
      ].join("\n"),
    );
    const items = projectRunTrace(root, { source: "agent" });
    assert.equal(items.length, 2);
    assert.equal(items.every((item) => item.kind === "agent.turn"), true);
    const rich = items.find((item) =>
      (item.detail as Record<string, unknown>).commandId === "command-001"
    )?.detail as Record<string, any>;
    assert.equal(rich.userText, "Audit Trace");
    assert.equal(rich.assistantText, "Audit complete");
    assert.equal(rich.thinking, "Persisted thought");
    assert.deepEqual(rich.usage, { input: 12, output: 7, token: "[REDACTED]" });
    assert.match(rich.error, /\[REDACTED\]/);
    assert.equal(rich.toolCalls[0].name, "read");
    assert.equal(rich.toolCalls[0].resultError, true);
    assert.match(JSON.stringify(rich.toolCalls[0].result), /\[REDACTED\]/);
    assert.equal(rich.sessionFile, "sessions/command-001/session.jsonl");
    const minimal = items.find((item) =>
      (item.detail as Record<string, unknown>).commandId === "command-002"
    )?.detail as Record<string, any>;
    assert.equal(minimal.userText, "Run check");
    assert.equal(minimal.assistantText, "Check complete");
    assert.deepEqual(minimal.toolCalls, []);
    for (const absent of ["thinking", "usage", "error"]) {
      assert.equal(Object.hasOwn(minimal, absent), false);
    }
    const exposed = JSON.stringify(items);
    assert.doesNotMatch(exposed, /AGENT_.*_SECRET|OUTSIDE_SESSION_SECRET/);
    assert.doesNotMatch(exposed, new RegExp(root.replaceAll("\\", "\\\\")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Trace projection filters sources and keeps malformed evidence diagnosable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-projection-"));
  try {
    await writeFile(
      join(root, "controls.jsonl"),
      `{"input":{"token":"MALFORMED_CONTROL_SECRET"\n${JSON.stringify({ id: "control-1", run_instance_id: "generation-a", action: "pause", status: "failed", queued_at: "2026-01-01T00:00:00.000Z", failed_at: "2026-01-01T00:00:01.000Z", error: "not ready" })}\n`,
    );
    const controls = projectRunTrace(root, { source: "control" });
    assert.equal(controls.length, 1);
    assert.equal(controls[0]?.kind, "control.failed");
    const runtime = projectRunTrace(root, { source: "runtime" });
    assert.equal(runtime.length, 1);
    assert.equal(runtime[0]?.kind, "state.read_error");
    assert.equal(
      (runtime[0]?.detail as Record<string, unknown>).reason,
      "invalid_control_json",
    );
    assert.doesNotMatch(JSON.stringify(runtime), /MALFORMED_CONTROL_SECRET/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Trace projection exposes compaction and legacy history loss without new fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-history-"));
  try {
    const marker = {
      id: "marker-1",
      ts: "2026-01-01T00:00:01.000Z",
      kind: "runtime.trace_compacted",
      level: "warning",
      data: {
        version: 1,
        compactions_total: 1,
        dropped_valid_events_total: 2,
        dropped_malformed_lines_total: 0,
        dropped_bytes_total: 80,
        dropped_event_count_exact: true,
        retained_events: 3,
        retained_bytes: 360,
        history_complete: false,
      },
    };
    const retainedAfterMarker = {
      id: "event-4",
      ts: "2026-01-01T00:00:02.000Z",
      kind: "runtime.note",
    };
    await writeFile(
      join(root, "trace.jsonl"),
      `${JSON.stringify({ id: "event-2", ts: "2026-01-01T00:00:00.000Z", kind: "runtime.note" })}\n${JSON.stringify(marker)}\n${JSON.stringify(retainedAfterMarker)}\n`,
    );
    const compacted = projectRunTrace(root, { source: "runtime" });
    const projectedMarker = compacted.find(({ kind }) => kind === marker.kind)!;
    assert.equal(projectedMarker.level, "warning");
    assert.deepEqual((projectedMarker.detail as Record<string, unknown>).data, marker.data);
    assert.deepEqual(Object.keys(projectedMarker).sort(), [
      "detail", "id", "kind", "level", "source", "summary", "ts",
    ]);
    assert.equal(
      compacted.some(({ kind }) => kind === "runtime.trace_history_incomplete"),
      false,
    );
    assert.equal(
      compacted.find(({ id }) => id === retainedAfterMarker.id)?.[TRACE_ITEM_SEQUENCE],
      4,
    );
    const secondMarker = {
      ...marker,
      id: "marker-2",
      ts: "2026-01-01T00:00:03.000Z",
      data: {
        ...marker.data,
        compactions_total: 2,
        dropped_valid_events_total: 3,
        retained_events: 2,
      },
    };
    await writeFile(
      join(root, "trace.jsonl"),
      `${JSON.stringify(retainedAfterMarker)}\n${JSON.stringify(secondMarker)}\n`,
    );
    assert.equal(
      projectRunTrace(root, { source: "runtime" })
        .find(({ id }) => id === retainedAfterMarker.id)?.[TRACE_ITEM_SEQUENCE],
      4,
    );
    const prefix = Buffer.alloc(TRACE_JOURNAL_MAX_BYTES + 17, 0x61);
    const suffix = `${JSON.stringify({
      id: "legacy-event",
      ts: "2026-01-02T00:00:00.000Z",
      kind: "runtime.note",
    })}\n`;
    await writeFile(
      join(root, "trace.jsonl"),
      Buffer.concat([prefix, Buffer.from(`\n${suffix}`)]),
    );
    const legacy = projectRunTrace(root, { source: "runtime" });
    const incomplete = legacy.filter(
      ({ kind }) => kind === "runtime.trace_history_incomplete",
    );
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0]?.level, "warning");
    assert.ok(
      Number((incomplete[0]?.detail as Record<string, unknown>).omitted_prefix_bytes) >
        TRACE_JOURNAL_MAX_BYTES,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Trace projection applies a deterministic global bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-trace-projection-"));
  try {
    const events = Array.from({ length: 20 }, (_, index) => ({
      id: `trace-${index}`,
      ts: new Date(index).toISOString(),
      kind: "runtime.note",
    }));
    await writeFile(
      join(root, "trace.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    const items = projectRunTrace(root, { limit: 3 });
    assert.deepEqual(items.map((item) => item.id), ["trace-19", "trace-18", "trace-17"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
