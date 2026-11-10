import "./test-environment.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { parse, parseDocument } from "yaml";
import { sliceByColumn, stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";

import * as Inspector from "../lib/inspector.ts";
import { ActorInspectorOverlay } from "../lib/inspector-overlay.ts";
import * as TraceProjection from "../lib/trace-projection.ts";
import * as SessionEvidence from "../lib/session-evidence.ts";

const themeCalls: Array<["bg" | "fg", string, string]> = [];
const theme = {
  bg: (color: string, text: string) => {
    themeCalls.push(["bg", color, text]);
    return text;
  },
  fg: (color: string, text: string) => {
    themeCalls.push(["fg", color, text]);
    return text;
  },
} as unknown as Theme;

function backgroundAt(line: string, column: number): string {
  let background = "default", cells = 0, end = 0;
  for (const match of line.matchAll(/\u001b\[([0-9;]*)m/gu)) {
    cells += visibleWidth(line.slice(end, match.index));
    if (cells > column) return background;
    const codes = match[1]!.split(";").map(Number);
    for (let index = 0; index < codes.length; index++) {
      if (codes[index] === 0 || codes[index] === 49) background = "default";
      else if (codes[index] === 48 && codes[index + 1] === 5) { background = String(codes[index + 2]); index += 2; }
    }
    end = match.index + match[0].length;
  }
  return background;
}

function popupFrame(screen: readonly string[], title: string): { top: number; left: number; width: number; lines: string[] } {
  const plain = screen.map(stripTerminalSequences);
  const top = plain.findIndex(line => line.includes(`╭ ${title} `));
  assert.ok(top >= 0, `Missing ${title} popup`);
  const start = plain[top]!.indexOf(`╭ ${title} `), end = plain[top]!.indexOf("╮", start) + 1;
  const left = visibleWidth(plain[top]!.slice(0, start)), width = visibleWidth(plain[top]!.slice(start, end));
  const bottom = plain.findIndex((line, index) => index > top && sliceByColumn(line, left, 1) === "╰");
  assert.ok(bottom > top);
  return { top, left, width, lines: plain.slice(top, bottom + 1).map(line => sliceByColumn(line, left, width)) };
}

function compactPopupText(lines: readonly string[]): string {
  return lines.slice(1, -1).map(line => line.slice(1, -1)).join("").replaceAll(/\s+/gu, "");
}

async function fixture(status = "done"): Promise<{ root: string; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-actor-inspector-"));
  const stateDir = join(root, "demo");
  await mkdir(stateDir);
  await writeFile(
    join(stateDir, "run.json"),
    JSON.stringify({
      control: ["pause"],
      ownerId: "owner",
      pid: 0,
      recipe: "demo",
      recipe_context_records: [{
        depth: 0,
        import_path: [],
        logical_reference: "demo.json",
        name: "demo",
        recipe: {
          artifacts: {
            queue: "{state_dir}/queue.json",
            locks: "{state_dir}/locks.json",
            journal: "{state_dir}/journal.jsonl",
          },
          control: ["pause"],
          prompt: "first\nsecond",
          template: "echo demo",
        },
        role: "entry",
        source_file: "/recipes/demo.json",
        source_kind: "explicit_file_recipe",
      }],
      run: "demo",
      run_instance_id: "generation-a",
      state_dir: stateDir,
      status,
      template: "echo demo",
      values: {},
    }),
  );
  await writeFile(
    join(stateDir, "progress.json"),
    JSON.stringify({ phase: status }),
  );
  if (status === "done") {
    await writeFile(join(stateDir, "result.json"), JSON.stringify({ code: 0 }));
  }
  await writeFile(
    join(stateDir, "trace.jsonl"),
    `${JSON.stringify({ id: "trace-1", ts: "2026-01-01T00:00:00.000Z", kind: "run.start", summary: "Started" })}\n`,
  );
  return { root, stateDir };
}

function overlay(
  root: string,
  killRun?: (run: string, generation: string) => { ok: boolean; message: string },
  readTrace?: ConstructorParameters<typeof ActorInspectorOverlay>[0]["readTrace"],
  readRuns?: ConstructorParameters<typeof ActorInspectorOverlay>[0]["readRuns"],
  rows?: number,
) {
  let renders = 0;
  const instance = new ActorInspectorOverlay({
    done: () => {},
    killRun,
    ownerId: "owner",
    readRuns,
    readTrace,
    stateRoot: root,
    theme,
    tui: { requestRender: () => { renders += 1; }, terminal: { rows } } as unknown as TUI,
  });
  return { instance, renders: () => renders };
}

test("Control overview explains declared actions without a recorded endpoint", async t => {
  const { root } = await fixture("running");
  const { instance } = overlay(root);
  t.after(async () => { instance.dispose(); await rm(root, { recursive: true, force: true }); });
  instance.handleInput("\u001b[B");
  instance.handleInput("\u001b[C");
  instance.handleInput("\u001b[C");
  const text = instance.render(140).join("\n");
  assert.match(text, /actor_control_readiness: not_ready/);
  assert.match(text, /reason: recorded_endpoint_unavailable/);
  assert.match(text, /actor_actions:/);
  assert.match(text, /pause/);
});

test("Control readiness partitions refuse partial bindings and journals", async t => {
  const { root, stateDir } = await fixture("running");
  const original = JSON.parse(await readFile(join(stateDir, "run.json"), "utf8"));
  const queued = { id: "q", action: "pause", run_instance_id: "generation-a", status: "queued", queued_at: new Date().toISOString() };
  const cases = [
    { control: [], readiness: "unsupported", reason: "no_declared_actor_actions" },
    { control: ["pause"], readiness: "ready_recorded_endpoint", reason: "recorded_endpoint_only_not_connection_proof" },
    { control: ["pause"], records: Array.from({ length: 64 }, (_, id) => ({ ...queued, id: String(id) })), readiness: "backpressure", reason: "pending_limit_reached" },
    ...[null, {}, { ...queued, run_instance_id: "foreign" }, { ...queued, run_instance_id: undefined }].map(record => ({ control: ["pause"], records: [record], readiness: "data_unavailable", reason: "partial_observation" })),
    { control: ["pause"], records: [queued, queued], readiness: "data_unavailable", reason: "partial_observation" },
    ...[["kill"], ["pause", "pause"], [1]].map(control => ({ control, readiness: "data_unavailable", reason: "partial_observation" })),
    { control: ["pause"], records: [{ ...queued, status: "handled", handled_at: "not-a-time" }], readiness: "data_unavailable", reason: "partial_observation" },
    { control: ["pause"], malformed: true, readiness: "data_unavailable", reason: "partial_observation" },
    { control: ["pause"], status: "done", readiness: "not_ready", reason: "run_terminal" },
  ];
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  for (const scenario of cases) {
    await writeFile(join(stateDir, "run.json"), JSON.stringify({ ...original, control: scenario.control, status: "status" in scenario ? scenario.status : "running" }));
    await writeFile(join(stateDir, "progress.json"), JSON.stringify({ phase: "status" in scenario ? scenario.status : "running" }));
    await writeFile(join(stateDir, "control-endpoint.json"), JSON.stringify({ run_instance_id: "generation-a", type: "fifo", path: "/not-a-connection-proof" }));
    await writeFile(join(stateDir, "controls.jsonl"), "malformed" in scenario ? "{bad\n" : (("records" in scenario ? scenario.records : []) ?? []).map(value => JSON.stringify(value)).join("\n"));
    const { instance } = overlay(root, undefined, () => { throw Error("Control must not read Trace"); });
    try {
      instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[C");
      const text = instance.render(140).join("\n");
      assert.match(text, new RegExp(`actor_control_readiness: ${scenario.readiness}`));
      assert.match(text, new RegExp(`reason: ${scenario.reason}`));
      assert.match(text, /runtime_actions:/);
      assert.doesNotMatch(text, /  - kill/);
    } finally { instance.dispose(); }
  }
});

test("Control binding refusal withholds replacement history and unreadable data at all viewport sizes", async t => {
  const { root, stateDir } = await fixture("running");
  const admitted = Inspector.readActorInspectorRuns(root, "owner");
  const original = JSON.parse(await readFile(join(stateDir, "run.json"), "utf8"));
  const record = { id: "private-id", action: "pause", status: "queued", queued_at: new Date().toISOString(), run_instance_id: "generation-a" };
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  for (const metadata of [null, {}, { ...original, ownerId: "replacement" }, { ...original, run_instance_id: "generation-b" }, { ...original, run_instance_id: undefined }]) {
    await writeFile(join(stateDir, "run.json"), JSON.stringify(metadata));
    await writeFile(join(stateDir, "controls.jsonl"), JSON.stringify(record) + "\n");
    for (const rows of [10, 30]) {
      const { instance } = overlay(root, () => { throw Error("No mutation"); }, () => { throw Error("No Trace"); }, () => admitted, rows);
      try {
        instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[C");
        const text = instance.render(140).join("\n"); assert.match(text, /actor_control_readiness: data_unavailable/);
        instance.handleInput("\r");
        for (const width of [24, 52, 90, 140]) {
          const frame = instance.render(width); assert.ok(frame.every(line => visibleWidth(stripTerminalSequences(line)) <= width));
          assert.match(frame.join("\n"), /No requests/); assert.doesNotMatch(frame.join("\n"), /private-id|pause/);
        }
        instance.handleInput("\u001b[C"); instance.handleInput("\u001b");
      } finally { instance.dispose(); }
    }
  }
  await writeFile(join(stateDir, "run.json"), JSON.stringify(original));
  await rm(join(stateDir, "controls.jsonl")); await mkdir(join(stateDir, "controls.jsonl"));
  const { instance } = overlay(root, undefined, undefined, () => admitted);
  try {
    instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[C");
    assert.match(instance.render(140).join("\n"), /actor_control_readiness: data_unavailable/);
  } finally { instance.dispose(); }
});

test("Control request keyboard uses a cached redacted suffix and exact selection across refresh", async t => {
  const { root, stateDir } = await fixture("running");
  let kills = 0, traces = 0, journalReads = 0;
  const originalRead = fs.readSync;
  const originalOpen = fs.openSync;
  const journalFds = new Set<number>();
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const fd = originalOpen(...args);
    if (String(args[0]).endsWith("controls.jsonl")) journalFds.add(fd);
    else journalFds.delete(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    if (journalFds.has(args[0])) journalReads++;
    return originalRead(...args);
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  const { instance } = overlay(root, () => { kills++; return { ok: true, message: "forbidden" }; }, () => { traces++; return []; });
  t.after(async () => { fs.openSync = originalOpen; fs.readSync = originalRead; syncBuiltinESMExports(); instance.dispose(); await rm(root, { recursive: true, force: true }); });
  const records = Array.from({ length: 25 }, (_, id) => ({ id: `request-${id}`, action: `action-${id}`, run_instance_id: "generation-a",
    status: "queued", queued_at: "2020-01-01T00:00:00.000Z", input: { password: "CONTROL_PRIVATE" } }));
  const save = async () => writeFile(join(stateDir, "controls.jsonl"), records.map(row => JSON.stringify(row)).join("\n"));
  await save();
  instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[C");
  instance.render(140);
  const reads = journalReads;
  instance.handleInput("\u001b[B"); instance.handleInput("\r");
  assert.match(instance.render(140).join("\n"), /Requests 20\/25 parsed; recent20; partial/);
  instance.handleInput("\u001b[B"); instance.handleInput("\r");
  const detail = instance.render(140).join("\n");
  assert.match(detail, /id: request-23/); assert.match(detail, /\[REDACTED\]/); assert.doesNotMatch(detail, /CONTROL_PRIVATE|delivered_at:|handled_at:/);
  for (const width of [24, 52, 90, 140]) {
    const frame = instance.render(width);
    assert.ok(frame.every(line => visibleWidth(stripTerminalSequences(line)) <= width));
  }
  assert.equal(journalReads, reads);
  records.push({ ...records[0]!, id: "appended", action: "new" }); await save(); instance.invalidate();
  assert.match(instance.render(140).join("\n"), /id: request-23/);
  records.splice(23, 1); await save(); instance.invalidate();
  assert.match(instance.render(140).join("\n"), /request: unavailable/);
  instance.handleInput("\u001b[D"); instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C");
  assert.doesNotMatch(instance.render(140).join("\n"), /request: unavailable/);
  const meta = JSON.parse(await readFile(join(stateDir, "run.json"), "utf8"));
  await writeFile(join(stateDir, "run.json"), JSON.stringify({ ...meta, run_instance_id: "generation-b" })); instance.invalidate();
  assert.match(instance.render(140).join("\n"), /request: unavailable/);
  instance.handleInput("k"); assert.equal(kills, 0); assert.equal(traces, 0);
});

test("Control request rows distinguish recorded statuses, age and stale without invented stages", async t => {
  const { root, stateDir } = await fixture("running");
  const { instance } = overlay(root, undefined, () => { throw Error("Trace read"); });
  t.after(async () => { instance.dispose(); await rm(root, { recursive: true, force: true }); });
  const now = Date.now();
  const records = ["queued", "delivered", "claimed", "handled", "failed"].map((status, index) => ({
    id: status, action: status, status, run_instance_id: "generation-a", queued_at: "2000-01-01T00:00:00.000Z",
    ...(status !== "queued" ? { [`${status}_at`]: new Date(now - index * 1000).toISOString() } : {}),
    ...(status === "failed" ? { error: "first\nsecond" } : {}),
  }));
  await writeFile(join(stateDir, "controls.jsonl"), records.map(record => JSON.stringify(record)).join("\n"));
  instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[C"); instance.handleInput("\r");
  const list = instance.render(140).join("\n");
  for (const status of ["queued", "delivered", "claimed", "handled", "failed"]) assert.match(list, new RegExp(`${status} \\| ${status}`));
  assert.match(list, /age_threshold_reached/); assert.match(list, /failed \| failed \| [45]s \| first/); assert.doesNotMatch(list, /second/);
  instance.handleInput("\r"); const detail = instance.render(140).join("\n");
  assert.match(detail, /failed_at:/); assert.doesNotMatch(detail, /delivered_at:|claimed_at:|handled_at:/);
  instance.handleInput("\u001b"); instance.handleInput("\u001b"); instance.handleInput("\u001b[B");
  const overview = instance.render(140).join("\n"); assert.match(overview, /stale never expires requests/);
  await writeFile(join(stateDir, "controls.jsonl"), ""); instance.invalidate();
  instance.handleInput("\r"); assert.match(instance.render(140).join("\n"), /No requests/);
  instance.handleInput("\r"); instance.handleInput("\u001b"); assert.match(instance.render(140).join("\n"), /actor_control_readiness:/);
});

test("Control stale threshold is observational at exactly five minutes", async t => {
  const { root, stateDir } = await fixture("running");
  const originalNow = Date.now;
  const now = originalNow();
  Date.now = () => now;
  const { instance } = overlay(root, undefined, () => { throw Error("No Trace"); });
  t.after(async () => { Date.now = originalNow; instance.dispose(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(stateDir, "controls.jsonl"), [299999, 300000].map(age => JSON.stringify({ id: String(age), action: `age-${age}`, status: "queued", run_instance_id: "generation-a", queued_at: new Date(now - age).toISOString() })).join("\n"));
  const before = await readFile(join(stateDir, "controls.jsonl"), "utf8");
  instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[C"); instance.handleInput("\r");
  const lines = instance.render(140);
  assert.match(lines.find(line => line.includes("age-300000"))!, /queued.*300s.*age_threshold_reached/);
  assert.doesNotMatch(lines.find(line => line.includes("age-299999"))!, /age_threshold_reached/);
  instance.handleInput("\u001b[6~"); instance.handleInput("\u001b[5~"); instance.handleInput("\r");
  assert.match(instance.render(140).join("\n"), /status: queued/);
  assert.equal(await readFile(join(stateDir, "controls.jsonl"), "utf8"), before);
});

test("Control narrow request rows retain status for maximum-length actions", async t => {
  const { root, stateDir } = await fixture("running");
  const { instance } = overlay(root, undefined, () => { throw Error("No Trace"); });
  t.after(async () => { instance.dispose(); await rm(root, { recursive: true, force: true }); });
  const statuses = ["queued", "delivered", "claimed", "handled", "failed"];
  const timestamp = new Date().toISOString();
  await writeFile(join(stateDir, "controls.jsonl"), statuses.map(status => JSON.stringify({
    id: status, action: "a".repeat(64), status, run_instance_id: "generation-a", queued_at: timestamp,
    ...(status === "queued" ? {} : { [`${status}_at`]: timestamp }),
  })).join("\n"));
  instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[C"); instance.handleInput("\r");
  for (const width of [24, 52, 90, 140]) {
    const frame = instance.render(width).map(stripTerminalSequences);
    const visible = frame.flatMap(line => /^│[▶ ] (queued|delivered|claimed|handled|failed) \|/u.exec(line)?.[1] ?? []);
    assert.deepEqual(new Set(visible), new Set(statuses), `Every status stays visible at width=${width}`);
    assert.ok(frame.every(line => visibleWidth(line) <= width));
    if (width === 24) assert.ok(frame.some(line => /failed.*…/u.test(line)), "Clipped action remains visibly incomplete");
  }
});

test("Control history labels its parsed suffix when malformed lines follow records", async t => {
  const { root, stateDir } = await fixture("running");
  const { instance } = overlay(root, undefined, () => { throw Error("No Trace"); });
  t.after(async () => { instance.dispose(); await rm(root, { recursive: true, force: true }); });
  const record = { id: "retained", action: "pause", status: "queued", run_instance_id: "generation-a", queued_at: new Date().toISOString() };
  await writeFile(join(stateDir, "controls.jsonl"), [JSON.stringify(record), ...Array(20).fill("{bad")].join("\n") + "\n");
  instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[C");
  assert.match(instance.render(140).join("\n"), /actor_control_readiness: data_unavailable/);
  instance.handleInput("\r");
  const text = instance.render(140).join("\n");
  assert.match(text, /Requests 1\/1 parsed; recent20; partial/);
  assert.match(text, /pause/);
  assert.doesNotMatch(text, /physical suffix|suffix20|\{bad/u);
});

test("Agent tool-call YAML starts with name and arguments and leaves result last", async t => {
  const { root } = await fixture();
  const { instance } = overlay(root);
  t.after(async () => { instance.dispose(); await rm(root, { recursive: true, force: true }); });
  const owner = instance as unknown as { agentDetailSegments(value: unknown): Array<{ kind: string; value?: unknown; text?: string }>;
    metadataText(value: unknown): string };
  for (const argumentsValue of [{ path: "public" }, undefined]) {
    for (const result of [undefined, null, false, 0, { status: "done" }, "Root **tool**", [{ type: "text", text: "Root **tool**" }, { type: "image", data: "selected" }]]) {
      const call = Object.freeze({ result, resultError: false, id: "call-1", arguments: argumentsValue, name: "read" });
      const before = Object.getOwnPropertyDescriptors(call);
      const segments = owner.agentDetailSegments({ detail: { toolCalls: [call] } });
      const selected = segments[0]!.value as { detail: { toolCalls: Array<Record<string, unknown>> } };
      const expected = ["name", "arguments", "resultError", "id", ...(typeof result === "string" ? [] : ["result"])];
      assert.deepEqual(Object.keys(selected.detail.toolCalls[0]!), expected);
      const yaml = owner.metadataText(selected);
      assert.match(yaml, /toolCalls:\n\s+- name: read\n\s+arguments:/u);
      const parsed = parse(yaml).detail.toolCalls[0];
      assert.deepEqual(Object.keys(parsed), expected, "Serialized YAML preserves the action-first display order");
      assert.deepEqual(parsed.arguments, argumentsValue ?? { value_state: "undefined" });
      if (result === undefined) assert.deepEqual(parsed.result, { value_state: "undefined" });
      assert.deepEqual(segments.filter(segment => segment.kind === "body").map(segment => segment.text),
        typeof result === "string" || Array.isArray(result) ? ["Root **tool**"] : []);
      assert.deepEqual(Object.getOwnPropertyDescriptors(call), before, "Display ordering never rewrites retained tool-call data");
    }
  }
  const selected = owner.agentDetailSegments({ detail: { toolCalls: [{ id: "pending", name: "bash" }] } })[0]!.value;
  assert.deepEqual(Object.keys(parse(owner.metadataText(selected)).detail.toolCalls[0]), ["name", "id"],
    "Missing arguments and result remain absent rather than invented");
});

test("Agent detail renders typed YAML and independent zero-outer-indent native Markdown", async t => {
  initTheme("dark", false);
  const { root } = await fixture();
  const bodies = ["Root **assistant**\r\n\r\n  - Authored list  \r\n\r\n```md\r\nunfinished", "---\nnext: forged\n---\n# User", "Thinking 👩‍💻é", '{"result":"literal JSON"}', "Root **tool**"];
  const detail = { index: "?", assistantText: bodies[0], userText: bodies[1], thinking: bodies[2], usage: { input: 4 },
    unknown: { bool: "true", multiline: "\ufeffline\n  own\n", list: [false, null, "null"] },
    toolCalls: [{ id: "call-1", name: "read", arguments: { path: "public" }, resultError: false,
      result: [{ type: "text", text: bodies[3] }, { type: "image", data: "already-selected", mimeType: "image/png" }, { type: "text", text: bodies[4], extra: "retained" }] }] };
  const item: TraceProjection.TraceItem = { id: "typed-agent", ts: "2026-01-01T00:00:00.000Z", source: "agent", kind: "agent.turn", summary: "Selected", detail,
    [TraceProjection.TRACE_ITEM_SEQUENCE]: 42, [TraceProjection.TRACE_ITEM_CHRONOLOGY]: { state: "available", basis: "recorded_observations", ordinal: 7, total: 9 } };
  const before = JSON.stringify(item), native: string[] = [];
  const original = Markdown.prototype.render;
  Markdown.prototype.render = function(width: number) {
    const component = this as unknown as { text: string; paddingX: number; paddingY: number; theme: { codeBlockIndent: string } };
    assert.equal(component.paddingX, 0); assert.equal(component.paddingY, 0); assert.equal(component.theme.codeBlockIndent, "");
    native.push(component.text); return original.call(this, width);
  };
  const { instance } = overlay(root, undefined, () => [item]);
  try {
    instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[B"); instance.handleInput("\r");
    instance.render(140);
    assert.deepEqual(native, bodies, "Actual overlay uses a distinct native Markdown instance for every selected body, without editing source");
    const owner = instance as unknown as { metadataText(value: unknown): string; agentDetailSegments(value: unknown): Array<{ kind: "metadata"; value: unknown } | { kind: "body"; text: string }>; agentDetailProjection(value: unknown, width: number): { lines: string[]; stripes: number[] } };
    const segments = owner.agentDetailSegments({ projection_sequence: 42, ...item, chronology: item[TraceProjection.TRACE_ITEM_CHRONOLOGY] });
    const metadata = segments.filter(segment => segment.kind === "metadata").map(segment => segment.value);
    for (const value of metadata) assert.deepEqual(parse(owner.metadataText(value)), JSON.parse(JSON.stringify(value)), "Metadata round-trips all enumerable string fields before terminal wrapping; Symbols remain private provenance");
    assert.equal(JSON.stringify(metadata).includes("forged"), false);
    assert.ok(JSON.stringify(metadata).includes("already-selected"));
    assert.ok(JSON.stringify(metadata).includes("retained"));
    for (const width of [24, 52, 90, 140]) {
      native.length = 0;
      const screen = instance.render(width);
      assert.ok(screen.every(line => visibleWidth(line) <= width && !/[\r\n]/u.test(line)));
      const projection = owner.agentDetailProjection({ ...item, chronology: item[TraceProjection.TRACE_ITEM_CHRONOLOGY] }, width - 2);
      assert.ok(projection.lines.some(line => stripTerminalSequences(line).startsWith("Root assistant")), "Root paragraph begins at column zero");
      assert.ok(projection.lines.some(line => stripTerminalSequences(line).startsWith("Root tool")), "Unfinished earlier fence cannot capture next body");
      assert.equal(projection.lines.length, projection.stripes.length);
      const rootRow = projection.lines.findIndex(line => stripTerminalSequences(line).startsWith("Root tool"));
      for (let index = 0; index < rootRow; index++) instance.handleInput("\u001b[B");
      const frame = instance.render(width).map(stripTerminalSequences);
      assert.ok(frame.some(line => line.startsWith("│Root tool")), "Actual bordered cell starts immediately after border");
      t.diagnostic(`Headless width=${width}: ${frame.find(line => line.startsWith("│Root tool"))}`);
      instance.handleInput("\u001b[6~"); instance.render(width); instance.handleInput("\u001b[5~");
    }
    instance.handleInput("\u001b"); instance.invalidate();
    assert.match(instance.render(90).join("\n"), /Selected/u);
    instance.handleInput("\r");
    assert.equal(JSON.stringify(item), before);
  } finally { Markdown.prototype.render = original; instance.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("Agent detail preserves bodyless, empty, long and deeply nested already-selected data without completion caps", async () => {
  initTheme("dark", false);
  const { root } = await fixture();
  let deep: unknown = { "\ufeffkey": "true", scalar: "\ufeffbody\r\n  nested  \n", empty: [], object: {} };
  for (let index = 0; index < 70; index++) deep = { nested: deep };
  try {
    for (const body of [undefined, "", "Long **body** 👩‍💻é\r\n  own  ".repeat(2200)]) {
      const detail = { index: 0, unknown: "m".repeat(50000), deep, toolCalls: [], ...(body === undefined ? {} : { assistantText: body }) };
      const item: TraceProjection.TraceItem = { id: "long-agent", ts: "2026-01-01T00:00:00.000Z", source: "agent", kind: "agent.turn", summary: "Selected", detail };
      const before = JSON.stringify(item);
      const { instance } = overlay(root, undefined, () => [item]);
      try {
        instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[B"); instance.handleInput("\r");
        assert.ok(instance.render(52).every(line => visibleWidth(line) <= 52));
        const owner = instance as unknown as { metadataText(value: unknown): string; agentDetailSegments(value: unknown): Array<{ kind: string; value?: unknown; text?: string }> };
        const segments = owner.agentDetailSegments(item);
        assert.deepEqual(segments.filter(segment => segment.kind === "body").map(segment => segment.text), body === undefined ? [] : [body]);
        const metadata = segments[0]!.value as { detail: Record<string, unknown> };
        assert.deepEqual(parse(owner.metadataText(metadata)), JSON.parse(JSON.stringify(metadata)));
        assert.equal((metadata.detail.unknown as string).length, 50000);
        assert.equal(JSON.stringify(item), before);
      } finally { instance.dispose(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Agent detail preserves selected own undefined metadata without confusing absent fields null or literal text", async () => {
  initTheme("dark", false);
  const { root } = await fixture();
  const session = join(root, "undefined-session.jsonl");
  await writeFile(session, [
    { type: "session", id: "undefined-session", timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "assistant-undefined", timestamp: "2026-01-01T00:00:01.000Z", message: {
      role: "assistant", content: [{ type: "toolCall", id: "call-undefined", name: "read" }],
    } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const turn = SessionEvidence.readSessionEvidence(session).turns[0]!;
  assert.equal(Object.hasOwn(turn.toolCalls[0]!, "arguments"), true, "The actual reader selects an own undefined arguments slot");
  assert.equal(turn.toolCalls[0]!.arguments, undefined);
  const detail = { ...turn, assistantText: "Root **body**", future: undefined,
    nested: { missing: undefined, explicitNull: null, literal: "undefined", values: [undefined, null, "undefined"] } };
  const item: TraceProjection.TraceItem = { id: "undefined-agent", ts: "2026-01-01T00:00:01.000Z", source: "agent", kind: "agent.turn", summary: "Selected", detail };
  const { instance } = overlay(root, undefined, () => [item], undefined, 120);
  try {
    instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[B"); instance.handleInput("\r");
    let screen = instance.render(140).map(stripTerminalSequences);
    const owner = instance as unknown as { agentDetailSegments(value: unknown): Array<{ kind: string; value?: unknown }>;
      metadataText(value: unknown): string };
    const selected = owner.agentDetailSegments(item)[0]!.value as { detail: typeof detail };
    assert.equal(Object.hasOwn(selected.detail.toolCalls[0]!, "arguments"), true, "Body extraction must not delete selected undefined metadata");
    assert.equal(selected.detail.toolCalls[0]!.arguments, undefined);
    assert.equal(Object.hasOwn(selected.detail, "future"), true);
    const parsed = parse(owner.metadataText(selected)).detail;
    assert.equal(Object.hasOwn(parsed.toolCalls[0], "arguments"), true);
    assert.deepEqual(parsed.toolCalls[0].arguments, { value_state: "undefined" });
    assert.deepEqual(parsed.future, { value_state: "undefined" });
    assert.deepEqual(parsed.nested, { missing: { value_state: "undefined" }, explicitNull: null,
      literal: "undefined", values: [{ value_state: "undefined" }, null, "undefined"] });
    assert.equal(Object.hasOwn(parsed, "never_selected"), false, "Absent optional fields must not be invented");
    assert.ok(screen.some(line => line.includes("value_state: undefined")), "The actual overlay exposes the selected undefined value state");
    for (let page = 0; page < 3 && !screen.some(line => line.startsWith("│Root body")); page++) {
      instance.handleInput("\u001b[6~");
      screen = instance.render(140).map(stripTerminalSequences);
    }
    assert.ok(screen.some(line => line.startsWith("│Root body")), "Paging exposes the independent unindented body after metadata");
    assert.equal(Object.hasOwn(detail.toolCalls[0]!, "arguments"), true);
    assert.equal(detail.toolCalls[0]!.arguments, undefined);
    assert.equal(detail.future, undefined);
    assert.equal(detail.nested.values[0], undefined);
  } finally { instance.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("Run dropdown owns compact shifted geometry and row backgrounds independently of the document", async () => {
  const { root } = await fixture();
  const runs = Array.from({ length: 7 }, (_, index) => ({ run: `demo-${index}`, runInstanceId: `generation-${index}`, status: "done" }));
  const ansiTheme = {
    fg: (_color: string, text: string) => `\u001b[39m${text}\u001b[39m`,
    bg: (color: string, text: string) => `\u001b[48;5;${color === "selectedBg" ? 4 : 8}m${text}\u001b[49m`,
  } as unknown as Theme;
  try {
    for (const rows of [10, 12, 30]) for (const width of [24, 52, 90, 140]) {
      const instance = new ActorInspectorOverlay({ done: () => {}, ownerId: "owner", readRuns: () => runs,
        readTrace: () => [], stateRoot: root, theme: ansiTheme,
        tui: { requestRender: () => {}, terminal: { rows } } as unknown as TUI });
      try {
        instance.handleInput("\r");
        for (let selected = 0; selected < runs.length; selected++) {
          const frame = instance.render(width), plain = frame.map(stripTerminalSequences);
          assert.ok(plain.every(line => visibleWidth(line) <= width));
          const top = plain[2]!, left = top.indexOf("╭"), right = top.indexOf("╮");
          assert.equal(left, 6, "Run dropdown shifts right one terminal column");
          const contentWidth = Math.min(visibleWidth("#6  demo-0  done"), width - 12);
          assert.equal(right - left + 1, Math.max(8, contentWidth + 3) + 2, "Run options reserve one independent right-padding column");
          let found = false;
          for (let row = 3; row < frame.length - 1; row++) {
            const match: RegExpMatchArray | null = plain[row]!.slice(left, right + 1).match(/^│(▶ |  )#(\d)/u);
            if (!match) continue;
            const index: number = runs.length - Number(match[2]) - 1;
            const active: boolean = index === selected;
            found ||= active;
            const expected: string = active ? "4" : index % 2 ? "8" : "default";
            for (let column: number = left + 1; column < right; column++) assert.equal(backgroundAt(frame[row]!, column), expected, `Menu row ${index}, column ${column} owns its background`);
            assert.equal(backgroundAt(frame[row]!, left), "default");
            assert.equal(backgroundAt(frame[row]!, right), "default");
            assert.equal(sliceByColumn(plain[row]!, right - 1, 1), " ", "Right padding survives full-width option text and ellipses");
          }
          assert.ok(found, "Selected Run remains visible while the menu scrolls");
          instance.handleInput("\u001b[B");
        }
        instance.handleInput("\u001b");
        assert.match(stripTerminalSequences(instance.render(width)[1]!), /#6/u, "Cancel does not apply the highlighted Run");
      } finally { instance.dispose(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Trace rapid key bursts preserve every selection step without intermediate renders", async () => {
  const { root } = await fixture(); let projections = 0, runReads = 0;
  const items: TraceProjection.TraceItem[] = Array.from({ length: 20 }, (_, index) => ({
    id: `burst-${index}`, ts: "2026-01-01T00:00:00.000Z", source: "lifecycle", kind: "run.note", summary: `Event ${index}`, detail: {},
  }));
  const { instance } = overlay(root, undefined, () => { projections++; return items; }, () => {
    runReads++; return [{ run: "demo", runInstanceId: "generation-a", status: "done" }];
  });
  try {
    instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[B");
    instance.render(90);
    for (const [keys, expected] of [[3, 3], [3, 6], [-3, 3], [2, 5]] as const) {
      for (let index = 0; index < Math.abs(keys); index++) instance.handleInput(keys > 0 ? "\u001b[B" : "\u001b[A");
      const selected = instance.render(90).map(stripTerminalSequences).filter(line => line.startsWith("│▶ "));
      assert.equal(selected.length, 1); assert.match(selected[0]!, new RegExp(`Event ${expected}\\b`, "u"));
    }
    assert.equal(projections, 1); assert.equal(runReads, 1);
    instance.invalidate(); instance.render(90);
    assert.match(instance.render(90).map(stripTerminalSequences).find(line => line.startsWith("│▶ "))!, /Event 5\b/u);
    assert.equal(projections, 2); assert.equal(runReads, 2);
    instance.handleInput("\r");
    assert.match(instance.render(90).join("\n"), /id: burst-5/u);
  } finally { instance.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("Trace navigation shows chronological rows without a standing caption or left cursor gutter", async () => {
  const { root } = await fixture();
  try {
    for (const state of ["available", "unavailable"] as const) for (const level of [undefined, "error"] as const) for (const attention of [false, true]) {
      const item: TraceProjection.TraceItem = Object.freeze({ id: "quiet-trace", ts: "2026-01-01T00:00:00.000Z", source: "lifecycle", kind: level === "error" ? "process.failed" : "run.note", level,
        summary: "Quiet row ! kept", detail: Object.freeze(attention ? { attention: "notify" } : {}),
        [TraceProjection.TRACE_ITEM_SEQUENCE]: 0,
        [TraceProjection.TRACE_ITEM_CHRONOLOGY]: state === "available"
          ? Object.freeze({ state: "available" as const, basis: "recorded_observations" as const, ordinal: 102, total: 102 })
          : Object.freeze({ state: "unavailable" as const, basis: "recorded_observations" as const, reason: "metadata_unavailable" as const }) });
      const { instance } = overlay(root, undefined, () => [item]);
      try {
        instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[B");
        for (const width of [24, 52, 90, 140]) {
          themeCalls.length = 0;
          const frame = instance.render(width).map(stripTerminalSequences), first = frame[4]!;
          assert.ok(frame.every(line => visibleWidth(line) <= width));
          const rank = state === "available" ? "#102" : "#?";
          const marker = level !== "error" && attention ? "A " : "";
          assert.ok(first.startsWith("│▶ " + rank + " " + marker + "lifecycle/"), "Only a meaningful attention marker takes space between rank and source/kind");
          assert.ok(!themeCalls.some(([kind, color, text]) => kind === "fg" && color === "error" && text === "!"));
          assert.equal(themeCalls.some(([kind, color, text]) => kind === "fg" && color === "error" && text === item.kind), level === "error");
          if (width === 140) assert.ok(first.includes("Quiet row ! kept"), "Authored exclamation marks remain opaque summary content");
          assert.doesNotMatch(frame.join("\n"), /recorded chronology|recorded ≠ lifetime|chronology unavailable|#\? unavailable/u);
        }
        instance.handleInput("\r"); const detail = instance.render(140).join("\n");
        assert.match(detail, /projection_sequence: 0/); assert.match(detail, /chronology:/);
        assert.match(detail, state === "available" ? /ordinal: 102/ : /reason: metadata_unavailable/);
      } finally { instance.dispose(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Trace navigation caches journal reads with the projection until invalidation without hiding fresh history loss", async () => {
  const { root, stateDir } = await fixture(); const tracePath = join(stateDir, "trace.jsonl");
  const names = ["openSync", "readSync", "closeSync"] as const;
  const descriptors = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(fs, name)!]));
  let opens = 0, reads = 0, projections = 0, runReads = 0; const fds = new Set<number>();
  const { instance } = overlay(root, undefined, (...args) => { projections++; return TraceProjection.projectRunTrace(...args); },
    (...args) => { runReads++; return Inspector.readActorInspectorRuns(...args); });
  try {
    Object.defineProperties(fs, {
      openSync: { ...descriptors.openSync, value: function(...args: Parameters<typeof fs.openSync>) {
        const fd = Reflect.apply(descriptors.openSync.value, fs, args) as number; if (args[0] === tracePath) { opens++; fds.add(fd); } return fd;
      } },
      readSync: { ...descriptors.readSync, value: function(...args: unknown[]) {
        if (fds.has(args[0] as number)) reads++; return Reflect.apply(descriptors.readSync.value, fs, args);
      } },
      closeSync: { ...descriptors.closeSync, value: function(fd: number) { try { return Reflect.apply(descriptors.closeSync.value, fs, [fd]); } finally { fds.delete(fd); } } },
    });
    syncBuiltinESMExports();
    instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[B"); instance.render(90);
    const initial = { opens, reads }; assert.ok(opens > 0 && reads > 0, "Hooks observe real canonical journal IO");
    const navigate = () => {
      for (let index = 0; index < 40; index++) { instance.handleInput(index % 2 ? "\u001b[A" : "\u001b[B"); instance.render(index % 2 ? 52 : 140); }
      instance.handleInput("f"); instance.render(90); instance.handleInput("\r"); instance.render(90); instance.handleInput("\u001b"); instance.render(24);
    };
    navigate(); assert.deepEqual({ opens, reads }, initial, "Navigation/filter/detail/resize do not reopen or parse the journal");
    assert.equal(projections, 1); assert.equal(runReads, 1);
    const marker = { id: "marker", ts: "2026-01-01T00:00:01.000Z", kind: "runtime.trace_compacted", level: "warning",
      data: { version: 1, compactions_total: 1, dropped_valid_events_total: 3, dropped_malformed_lines_total: 0, dropped_bytes_total: 90,
        dropped_event_count_exact: true, retained_events: 1, retained_bytes: 300, history_complete: false } };
    await writeFile(tracePath, JSON.stringify(marker) + "\n"); instance.invalidate();
    assert.match(instance.render(90).join("\n"), /Trace history incomplete: 1 compaction.*3 dropped event/);
    assert.ok(opens > initial.opens && reads > initial.reads); assert.equal(projections, 2); assert.equal(runReads, 2);
    const refreshed = { opens, reads }; navigate(); assert.deepEqual({ opens, reads }, refreshed);
    assert.equal(projections, 2); assert.equal(runReads, 2); assert.equal(fds.size, 0);
  } finally {
    instance.dispose(); for (const name of names) Object.defineProperty(fs, name, descriptors[name]); syncBuiltinESMExports();
    for (const name of names) assert.deepEqual(Object.getOwnPropertyDescriptor(fs, name), descriptors[name]);
    await rm(root, { recursive: true, force: true });
  }
});

async function runIdentityFixture() {
  const { root, stateDir } = await fixture();
  const original = JSON.parse(await readFile(join(stateDir, "run.json"), "utf8"));
  const names = ["run_" + "a".repeat(59) + "x", "run_" + "a".repeat(59) + "y"];
  for (const [index, run] of names.entries()) {
    const dir = join(root, run); await mkdir(dir);
    await writeFile(join(dir, "run.json"), JSON.stringify({ ...original, run, state_dir: dir, run_instance_id: "identity-generation-" + index,
      recipe_context_records: original.recipe_context_records.map((record: { recipe: Record<string, unknown> }) => ({ ...record, recipe: { ...record.recipe, selected_run_id: "AUTHORED_SELECTED_RUN_ID" } })),
    }));
    await writeFile(join(dir, "progress.json"), JSON.stringify({ phase: "done" }));
    await writeFile(join(dir, "result.json"), JSON.stringify({ code: 0 }));
  }
  return { root, names, records: Inspector.readActorInspectorRuns(root, "owner") };
}

test("AX Run control and selector mark real native-column gaps without changing ranks or cached selection", async () => {
  const { root, names, records } = await runIdentityFixture();
  try {
    assert.equal(records.filter(record => names.includes(record.run)).length, 2);
    for (const rows of [10, 12, 30]) for (const width of [24, 52, 90, 140]) {
      let reads = 0, actions = 0;
      const { instance } = overlay(root, () => { actions++; throw Error("Navigation is not an action"); }, undefined,
        (...args) => { reads++; return Inspector.readActorInspectorRuns(...args); }, rows);
      try {
        const index = records.findIndex(record => record.run === names[0]);
        for (let i = 0; i < index; i++) instance.handleInput("\u001b[C");
        const initial = instance.render(width).map(stripTerminalSequences), header = initial[1]!;
        assert.ok(initial.every(line => visibleWidth(line) <= width)); assert.match(header, new RegExp("#" + (records.length - index - 1)));
        if (width <= 52) { assert.ok(header.includes("…")); assert.equal(header.includes(names[0]!), false); }
        else { assert.ok(header.includes(names[0]!)); assert.equal(header.includes("…"), false); }
        instance.handleInput("\r"); const menu = instance.render(width).map(stripTerminalSequences);
        assert.ok(menu.every(line => visibleWidth(line) <= width));
        const options = menu.filter(line => line[6] === "│" && /#\d/u.test(line)); assert.equal(options.length, records.length);
        assert.deepEqual(options.map(line => Number(/#(\d+)/u.exec(line)![1])), records.map((_record, i) => records.length - i - 1));
        if (width <= 52) assert.ok(options.every(line => line.includes("…")), "The Run producer marks its cropped content before generic composition");
        else { assert.ok(names.every(name => options.some(line => line.includes(name)))); assert.ok(options.every(line => !line.includes("…"))); }
        instance.handleInput("\u001b[B"); instance.render(140); instance.render(width); instance.handleInput("\u001b");
        assert.equal(instance.render(width).map(stripTerminalSequences)[1], header, "Cancelling the selector preserves the applied Run across resize");
        assert.equal(reads, 1); assert.equal(actions, 0);
      } finally { instance.dispose(); }
    }
    const { instance } = overlay(root, undefined, undefined, undefined, 30);
    try {
      const short = records.findIndex(record => record.run === "demo"); for (let i = 0; i < short; i++) instance.handleInput("\u001b[C");
      for (const width of [52, 90, 140]) { const header = stripTerminalSequences(instance.render(width)[1]!); assert.ok(header.includes("demo")); assert.equal(header.includes("…"), false); }
    } finally { instance.dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AX selected Run identity is whole and read-only in existing Recipe and Control documents at phone widths", async () => {
  const { root, names, records } = await runIdentityFixture();
  const before = await readFile(join(root, names[1]!, "run.json"), "utf8");
  try {
    assert.match(JSON.stringify(Inspector.readActorInspectorRecipe(join(root, names[1]!))), /AUTHORED_SELECTED_RUN_ID/);
    for (const rows of [10, 12, 30]) for (const width of [24, 52, 90, 140]) {
      let reads = 0, actions = 0;
      const { instance } = overlay(root, () => { actions++; throw Error("Identity reading must not act"); }, undefined,
        (...args) => { reads++; return Inspector.readActorInspectorRuns(...args); }, rows);
      try {
        const first = records.findIndex(record => record.run === names[0]), target = records.findIndex(record => record.run === names[1]);
        for (let i = 0; i < first; i++) instance.handleInput("\u001b[C");
        instance.render(width); instance.handleInput("\r");
        for (let i = first; i !== target; i += target > first ? 1 : -1) instance.handleInput(target > first ? "\u001b[B" : "\u001b[A");
        instance.handleInput("\r"); instance.render(140); instance.render(width);
        instance.handleInput("\u001b[B"); instance.handleInput("\r");
        const readIdentity = () => {
          let value = "", firstLine = true;
          for (let step = 0; step < 20 && value.length < names[1]!.length; step++) {
            const frame = instance.render(width).map(stripTerminalSequences);
            assert.ok(frame.every(line => visibleWidth(line) <= width)); assert.ok(!frame.some(line => line.includes("Confirm Actor Kill")));
            for (const row of frame.slice(4, -1)) {
              const text = row.slice(1, -1).trimEnd();
              if (firstLine) { assert.ok(text.startsWith("selected_run_id:")); value += text.slice("selected_run_id:".length).trimStart(); firstLine = false; }
              else { value += text; }
              if (value.length >= names[1]!.length) break;
            }
            if (value.length < names[1]!.length) instance.handleInput("\u001b[6~");
          }
          assert.equal(value, names[1]); assert.ok(!value.includes("…"));
        };
        readIdentity(); instance.handleInput("\u001b");
        instance.handleInput("\u001b[C"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[B"); readIdentity();
        instance.handleInput("\u001b"); instance.handleInput("\u001b[A");
        assert.ok(instance.render(140).map(stripTerminalSequences)[1]!.includes(names[1]!));
        assert.equal(reads, 1); assert.equal(actions, 0);
      } finally { instance.dispose(); }
    }
    assert.equal(await readFile(join(root, names[1]!, "run.json"), "utf8"), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Actor Inspector exposes exactly Recipe, Trace, and Control tabs", async () => {
  themeCalls.length = 0;
  const { root } = await fixture();
  const { instance } = overlay(root);
  try {
    const recipe = instance.render(90).join("\n");
    assert.match(recipe, /Actor Inspector/);
    assert.match(recipe, /←\s+Run:\s+#0.*→/);
    assert.match(recipe, /Recipe.*Trace.*Control/);
    const recipeRows = recipe.split("\n").slice(4, -1).map(row => row.slice(1, -1).trimEnd());
    const visible = parse(recipeRows.join("\n"));
    assert.deepEqual(visible.composition[0].import_path, []);
    assert.equal(visible.composition[0].depth, 0);
    assert.deepEqual(visible.definition.control, ["pause"]);
    assert.deepEqual(visible.definition.artifacts, { queue: "{state_dir}/queue.json", locks: "{state_dir}/locks.json", journal: "{state_dir}/journal.jsonl" });
    assert.equal(visible.definition.prompt, "first\nsecond");
    assert.doesNotMatch(recipe, /- item:|- #\d+/);
    assert.equal(themeCalls.some(([kind, color]) => kind === "fg" && color === "borderAccent"), true);
    assert.equal(themeCalls.some(([kind, color]) => kind === "fg" && color === "accent"), true);
    assert.equal(themeCalls.some(([kind, color, text]) => kind === "fg" && color === "accent" && text === "←→"), true);
    assert.equal(themeCalls.some(([kind, color, text]) => kind === "fg" && color === "borderAccent" && text === " run"), true);
    assert.equal(themeCalls.some(([kind, color, text]) => kind === "fg" && color === "borderAccent" && text === " ─ "), true);
    assert.equal(themeCalls.some(([kind, color]) => kind === "bg" && color === "customMessageBg"), true);
    assert.equal(themeCalls.some(([kind, color]) => kind === "bg" && color === "selectedBg"), true);
    assert.doesNotMatch(recipe, /Messages|Turns|Communications/);
    instance.handleInput("\u001b[B");
    themeCalls.length = 0;
    assert.match(instance.render(90).join("\n"), /\[ Recipe \]/);
    assert.equal(
      themeCalls.some(([kind, color, text]) =>
        kind === "bg" && color === "selectedBg" && /\[ Recipe \]/.test(text)
      ),
      true,
    );
    assert.equal(
      themeCalls.some(([kind, color]) => kind === "bg" && color === "customMessageBg"),
      true,
    );
    instance.handleInput("\u001b[C");
    const trace = instance.render(90).join("\n");
    assert.match(trace, /\[ Trace \]/);
    assert.match(trace, /lifecycle\/run\.start/);
    assert.doesNotMatch(trace, /[•·]/u);
    assert.match(trace, /enter\/f source/);
    instance.handleInput("\u001b[B");
    themeCalls.length = 0;
    assert.match(instance.render(90).join("\n"), /→\/enter open/);
    assert.equal(
      themeCalls.some(([kind, color]) => kind === "bg" && color === "selectedBg"),
      true,
    );
    instance.handleInput("\r");
    assert.match(instance.render(90).join("\n"), /kind: process\.result/);
    instance.handleInput("\u001b[D");
    instance.handleInput("f");
    assert.match(instance.render(90).join("\n"), /\[ Trace: lifecycle \]/);
    for (let index = 0; index < 8; index += 1) {
      instance.handleInput("f");
      assert.doesNotMatch(instance.render(90).join("\n"), /Trace \(agent\)/);
    }
    instance.handleInput("\u001b[D");
    instance.handleInput("\u001b[C");
    const control = instance.render(90).join("\n");
    assert.match(control, /\[ Control \]/);
    assert.match(control, /actor_actions:/);
    assert.match(control, /pause/);
  } finally {
    instance.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("Actor Inspector composes padded Trace focus with independent row stripes", async () => {
  themeCalls.length = 0;
  const { root, stateDir } = await fixture();
  const { instance } = overlay(root);
  try {
    await writeFile(
      join(stateDir, "trace.jsonl"),
      [
        JSON.stringify({ id: "oldest", ts: "2026-01-01T00:00:00.000Z", kind: "run.start", summary: "Oldest" }),
        JSON.stringify({ id: "newest", ts: "2026-01-01T00:00:01.000Z", kind: "run.done", summary: "Newest" }),
      ].join("\n") + "\n",
    );
    instance.handleInput("\u001b[B");
    instance.handleInput("\u001b[C");
    instance.handleInput("\u001b[B");
    instance.handleInput("\u001b[B");
    themeCalls.length = 0;
    assert.match(instance.render(90).join("\n"), /▶\s+#2.*Newest/);
    const selectedCall = themeCalls.findIndex(([kind, color, text]) =>
      kind === "bg" && color === "selectedBg" && /Newest/.test(text)
    );
    assert.notEqual(selectedCall, -1);
    assert.match(themeCalls[selectedCall]![2], /Newest $/);
    assert.equal(
      themeCalls.slice(selectedCall + 1).some(([kind, color, text]) =>
        kind === "bg" && color === "customMessageBg" && /^ +$/u.test(text)
      ),
      true,
    );
  } finally {
    instance.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("Actor Inspector exposes compacted Trace and Control saturation", async () => {
  const { root, stateDir } = await fixture();
  const { instance } = overlay(root);
  try {
    const marker = { id: "marker", ts: "2026-01-01T00:00:01.000Z",
      kind: "runtime.trace_compacted", level: "warning",
      data: { version: 1, compactions_total: 1, dropped_valid_events_total: 3,
        dropped_malformed_lines_total: 0, dropped_bytes_total: 90,
        dropped_event_count_exact: true, retained_events: 1, retained_bytes: 300,
        history_complete: false } };
    await writeFile(join(stateDir, "trace.jsonl"), `${JSON.stringify(marker)}\n`);
    await writeFile(join(stateDir, "controls.jsonl"), Array.from({ length: 64 }, (_, index) =>
      JSON.stringify({ id: `c-${index}`, run_instance_id: "generation-a", action: "pause",
        status: "queued", queued_at: new Date().toISOString() })).join("\n") + "\n");
    instance.handleInput("\u001b[B");
    instance.handleInput("\u001b[C");
    assert.match(instance.render(90).join("\n"), /Trace history incomplete: 1 compaction.*3 dropped event/);
    instance.handleInput("\u001b[C");
    const control = instance.render(90).join("\n");
    assert.match(control, /pending: 64/);
    assert.match(control, /pending_limit: 64/);
    assert.match(control, /backpressured: true/);
  } finally {
    instance.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("Actor Inspector redacts Control rows, details, and Control documents", async () => {
  const { root, stateDir } = await fixture();
  const { instance } = overlay(root);
  try {
    await writeFile(
      join(stateDir, "controls.jsonl"),
      `${JSON.stringify({
        id: "control-secret",
        run_instance_id: "generation-a",
        action: "pause",
        input: {
          password: "INSPECTOR_PASSWORD_SECRET",
          nested: { token: "INSPECTOR_TOKEN_SECRET" },
          note: "Bearer INSPECTOR_BEARER_SECRET",
        },
        status: "failed",
        queued_at: "2099-01-01T00:00:00.000Z",
        failed_at: "2099-01-01T00:00:01.000Z",
        error: "cookie=INSPECTOR_ERROR_SECRET unavailable",
      })}\n`,
    );
    instance.handleInput("\u001b[B");
    instance.handleInput("\u001b[C");
    instance.handleInput("\u001b[B");
    const row = instance.render(90).join("\n");
    assert.match(row, /control\/control\.failed/);
    assert.doesNotMatch(row, /INSPECTOR_.*_SECRET/);
    instance.handleInput("\r");
    const detail = instance.render(90).join("\n");
    assert.match(detail, /action: pause/);
    assert.match(detail, /status: failed/);
    assert.match(detail, /\[REDACTED\]/);
    assert.doesNotMatch(detail, /INSPECTOR_.*_SECRET/);
    instance.handleInput("\u001b");
    instance.handleInput("\u001b[D");
    instance.handleInput("\u001b[C");
    instance.handleInput("\r");
    const control = instance.render(90).join("\n");
    assert.match(control, /\[ Control \]/);
    assert.match(control, /Requests 1\/1 parsed/);
    assert.match(control, /failed \| pause/);
    instance.handleInput("\r");
    const requestDetail = instance.render(90).join("\n");
    assert.match(requestDetail, /id: control-secret/);
    assert.match(requestDetail, /\[REDACTED\]/);
    assert.doesNotMatch(requestDetail, /INSPECTOR_.*_SECRET/);
    assert.doesNotMatch(control, /INSPECTOR_.*_SECRET/);
    const durable = await readFile(join(stateDir, "controls.jsonl"), "utf8");
    assert.match(durable, /INSPECTOR_PASSWORD_SECRET/);
    assert.match(durable, /INSPECTOR_ERROR_SECRET/);
  } finally {
    instance.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("Actor Inspector restores focused selectors and terminal-relative viewport", async () => {
  themeCalls.length = 0;
  const { root } = await fixture();
  const { instance } = overlay(root);
  try {
    const initial = instance.render(90);
    assert.equal(initial.length, 28);
    assert.match(initial.join("\n"), /←\s+Run:.*→/);
    assert.match(initial.at(-1) ?? "", /enter list/);
    instance.handleInput("\r");
    const runMenu = instance.render(90);
    assert.match(runMenu.join("\n"), /#0\s+demo\s+done/);
    assert.doesNotMatch(runMenu.join("\n"), /run:demo/);
    assert.equal(themeCalls.some(([kind, color, text]) =>
      kind === "fg" && color === "success" && text === "done"
    ), true);
    const runTriggerRow = runMenu.findIndex((line) => /Run:\s+#0/.test(line));
    assert.match(stripTerminalSequences(runMenu[runTriggerRow + 1] ?? ""), /^│ \[ Re╭/);
    assert.match(runMenu.join("\n"), /Control/);
    assert.match(runMenu.join("\n"), /definition:/);
    assert.equal(runMenu.every((line) => visibleWidth(line) <= 90), true);
    assert.equal(themeCalls.some(([kind, color, text]) =>
      kind === "bg" && color === "selectedBg" && /Run:/.test(text)
    ), true);
    instance.handleInput("\u001b");
    instance.handleInput("\u001b[B");
    instance.handleInput("\u001b[C");
    const traceBeforeMenu = instance.render(90).map(stripTerminalSequences);
    assert.match(traceBeforeMenu.join("\n"), /process completed/);
    instance.handleInput("\r");
    const traceMenu = instance.render(90);
    assert.match(traceMenu.join("\n"), /Trace: all/);
    assert.doesNotMatch(traceMenu.join("\n"), /Trace source:/);
    assert.equal(themeCalls.some(([kind, color, text]) =>
      kind === "fg" && color === "accent" && text === "Trace:"
    ), true);
    assert.equal(themeCalls.some(([kind, color, text]) =>
      kind === "fg" && color === "text" && text === "all"
    ), true);
    const traceTriggerRow = traceMenu.findIndex((line) => /\[ Trace \]/.test(line));
    assert.match(traceMenu[traceTriggerRow + 1] ?? "", /^│─{12}╭/);
    assert.equal(traceMenu.every((line) => visibleWidth(line) <= 90), true);
    assert.equal(themeCalls.some(([kind, color, text]) =>
      kind === "bg" && color === "selectedBg" && /\[ Trace \]/.test(text)
    ), true);
    assert.equal(themeCalls.some(([kind, color]) => kind === "bg" && color === "customMessageBg"), true);
    instance.handleInput("\u001b");
    assert.deepEqual(instance.render(90).map(stripTerminalSequences), traceBeforeMenu, "Closing the selector restores all underlying text, including cells covered by its popup");
    instance.handleInput("\r");
    instance.handleInput("\u001b[B");
    instance.handleInput("\r");
    assert.match(instance.render(90).join("\n"), /\[ Trace: lifecycle \]/);
    assert.equal(themeCalls.some(([kind, color, text]) =>
      kind === "fg" && color === "accent" && text === "Trace:"
    ), true);
    assert.equal(themeCalls.some(([kind, color, text]) =>
      kind === "fg" && color === "text" && text === "lifecycle"
    ), true);
    assert.equal(themeCalls.some(([kind, color, text]) =>
      kind === "fg" && color === "text" && text.startsWith(":")
    ), false);
    assert.equal(themeCalls.some(([kind, color, text]) =>
      kind === "fg" && color === "accent" && (text === "[ " || text === " ]")
    ), true);
  } finally {
    instance.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("Actor Inspector formats Run selector as aligned zero-based status-colored columns", async () => {
  themeCalls.length = 0;
  const { root } = await fixture();
  const { instance } = overlay(root, undefined, undefined, () => [
    { run: "long-name", status: "running" },
    { run: "x", status: "done" },
  ]);
  try {
    instance.render(90);
    instance.handleInput("\r");
    const menu = instance.render(90).map(stripTerminalSequences).join("\n");
    const runningRow = menu.split("\n").find((line) =>
      line[6] === "│" && /#1\s+long-name\s+running/.test(line)
    );
    const doneRow = menu.split("\n").find((line) =>
      line[6] === "│" && /#0\s+x\s+done/.test(line)
    );
    assert.ok(runningRow);
    assert.ok(doneRow);
    const runningColumns = /#1\s+long-name\s+running/.exec(runningRow);
    const doneColumns = /#0\s+x\s+done/.exec(doneRow);
    assert.ok(runningColumns);
    assert.ok(doneColumns);
    assert.equal(
      runningColumns.index + runningColumns[0].lastIndexOf("running"),
      doneColumns.index + doneColumns[0].lastIndexOf("done"),
    );
    assert.doesNotMatch(menu, /run:/);
    assert.equal(themeCalls.some(([kind, color, text]) =>
      kind === "fg" && color === "warning" && text === "running"
    ), true);
    assert.equal(themeCalls.some(([kind, color, text]) =>
      kind === "fg" && color === "success" && text === "done"
    ), true);
  } finally {
    instance.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("Actor Inspector caches Trace projection while browsing its list", async () => {
  const { root } = await fixture();
  let runReads = 0;
  let traceReads = 0;
  const { instance } = overlay(
    root,
    undefined,
    (stateDir, options) => {
      traceReads += 1;
      return TraceProjection.projectRunTrace(stateDir, options);
    },
    (stateRoot, ownerId) => {
      runReads += 1;
      return Inspector.readActorInspectorRuns(stateRoot, ownerId);
    },
  );
  try {
    instance.handleInput("\u001b[B");
    instance.handleInput("\u001b[C");
    instance.render(90);
    instance.render(90);
    instance.handleInput("\u001b[B");
    instance.render(90);
    for (let index = 0; index < 20; index += 1) {
      instance.handleInput(index % 2 === 0 ? "\u001b[B" : "\u001b[A");
      instance.render(90);
    }
    assert.equal(traceReads, 1);
    assert.equal(runReads, 1);
  } finally {
    instance.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("Actor Inspector preserves newest-first Trace projection across refresh and navigation", async () => {
  const { root } = await fixture();
  const older: TraceProjection.TraceItem = {
    detail: {},
    id: "older",
    kind: "run.start",
    [TraceProjection.TRACE_ITEM_SEQUENCE]: 0,
    source: "lifecycle",
    summary: "Oldest event",
    ts: "2026-01-01T00:00:00.000Z",
  };
  const middle: TraceProjection.TraceItem = {
    detail: {},
    id: "middle",
    kind: "run.progress",
    [TraceProjection.TRACE_ITEM_SEQUENCE]: 99,
    source: "lifecycle",
    summary: "Middle event",
    ts: "2026-01-02T00:00:00.000Z",
  };
  const newest: TraceProjection.TraceItem = {
    detail: { attention: "notify" },
    id: "newest",
    kind: "run.done",
    [TraceProjection.TRACE_ITEM_SEQUENCE]: 100,
    source: "lifecycle",
    summary: "Newest event",
    ts: "2026-01-03T00:00:00.000Z",
  };
  let refreshed = false;
  const { instance } = overlay(
    root,
    undefined,
    () => { const rows = refreshed ? [newest, middle, older] : [middle, older];
      return rows.map((item, index) => ({ ...item, [TraceProjection.TRACE_ITEM_CHRONOLOGY]: Object.freeze({
        state: "available" as const, basis: "recorded_observations" as const, ordinal: rows.length - index, total: rows.length,
      }) })); },
  );
  try {
    instance.handleInput("\u001b[B");
    instance.handleInput("\u001b[C");
    const initial = instance.render(90).join("\n");
    assert.ok(initial.indexOf("Middle event") < initial.indexOf("Oldest event"));
    assert.match(initial, /#2.*Middle event/);
    instance.handleInput("\u001b[B");
    instance.render(90);
    instance.handleInput("\u001b[B");
    assert.match(instance.render(90).join("\n"), /▶\s+#1.*Oldest event/);
    refreshed = true;
    instance.invalidate();
    const updated = instance.render(90).join("\n");
    assert.ok(updated.indexOf("Newest event") < updated.indexOf("Middle event"));
    assert.ok(updated.indexOf("Middle event") < updated.indexOf("Oldest event"));
    assert.match(updated, /#3\s+A\s+lifecycle\/run\.done.*Newest event/);
    assert.doesNotMatch(updated, /[•·]/u);
    assert.match(updated, /#2.*Middle event/);
    assert.match(updated, /▶\s+#1.*Oldest event/);
    instance.handleInput("\r");
    assert.match(instance.render(90).join("\n"), /projection_sequence: 0/);
    instance.handleInput("\u001b");
    instance.handleInput("\u001b[A");
    instance.handleInput("\r");
    assert.match(instance.render(90).join("\n"), /projection_sequence: 99/);
    instance.handleInput("\u001b");
    instance.handleInput("\u001b[A");
    instance.handleInput("\r");
    assert.match(instance.render(90).join("\n"), /projection_sequence: 100/);
    assert.equal(middle[TraceProjection.TRACE_ITEM_SEQUENCE], 99);
    assert.equal(newest[TraceProjection.TRACE_ITEM_SEQUENCE], 100);
  } finally {
    instance.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("Actor Inspector keeps the selected recorded agent entry when a sibling session grows", async () => {
  const { root, stateDir } = await fixture();
  const files = ["sessions/alpha/session.jsonl", "sessions/beta/session.jsonl"];
  const { instance } = overlay(root);
  try {
    await writeFile(join(stateDir, "execution.json"), JSON.stringify({ commands: files.map((file, index) => ({ id: `command-${index}`, session_files: [file] })) }));
    for (const [index, file] of files.entries()) {
      await mkdir(join(stateDir, file, ".."), { recursive: true });
      await writeFile(join(stateDir, file), [ { type: "session", version: 3, id: "session" },
        { type: "message", id: "native-entry", parentId: null, timestamp: `2026-01-01T00:00:${index ? "20" : "10"}.000Z`,
          message: { role: "assistant", content: index ? "Beta original" : "Alpha original" } }
      ].map(value => JSON.stringify(value)).join("\n") + "\n");
    }
    instance.handleInput("\u001b[B");
    instance.handleInput("\u001b[C");
    for (let index = 0; index < 3; index++) instance.handleInput("f");
    assert.match(instance.render(90).join("\n"), /Trace: agent/);
    instance.handleInput("\u001b[B");
    assert.match(instance.render(90).join("\n"), /▶[^\n]*Beta original/);
    const selected = TraceProjection.projectRunTrace(stateDir, { source: "agent" }).find(item => item.summary === "Beta original")!.id;
    const alpha = join(stateDir, files[0]);
    await writeFile(alpha, await readFile(alpha, "utf8") + JSON.stringify({ type: "message", id: "alpha-next", parentId: "native-entry",
      timestamp: "2026-01-01T00:00:30.000Z", message: { role: "assistant", content: "Alpha next" } }) + "\n");
    instance.invalidate();
    const refreshed = instance.render(90).join("\n");
    assert.ok(refreshed.indexOf("Alpha next") < refreshed.indexOf("Beta original"));
    assert.match(refreshed, /▶[^\n]*Beta original/);
    instance.handleInput("\r");
    const detail = instance.render(110).join("\n");
    assert.match(detail, /Beta original/);
    assert.ok(detail.includes(selected));
  } finally { instance.dispose(); await rm(root, { force: true, recursive: true }); }
});

test("Actor Inspector advances chronological numbers beyond the visible tail without renumbering filters", async () => {
  const { root, stateDir } = await fixture("running");
  const record = (index: number) => JSON.stringify({ id: `number-${index}`, ts: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index).toISOString(),
    kind: index % 2 ? "run.note" : "runtime.note", summary: `Numbered event ${index}` });
  const { instance } = overlay(root);
  try {
    await writeFile(join(stateDir, "trace.jsonl"), Array.from({ length: 101 }, (_, index) => record(index)).join("\n") + "\n");
    instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C");
    assert.match(instance.render(90).join("\n"), /#101\s+runtime\/runtime\.note.*Numbered event 100/);
    await writeFile(join(stateDir, "trace.jsonl"), await readFile(join(stateDir, "trace.jsonl"), "utf8") + record(101) + "\n");
    instance.invalidate();
    const advanced = instance.render(90).join("\n");
    assert.match(advanced, /#102\s+lifecycle\/run\.note.*Numbered event 101/);
    assert.match(advanced, /#101\s+runtime\/runtime\.note.*Numbered event 100/);
    assert.doesNotMatch(advanced, /recorded chronology/);
    instance.handleInput("f");
    const filtered = instance.render(90).join("\n");
    assert.match(filtered, /#102\s+lifecycle\/run\.note.*Numbered event 101/);
    assert.match(filtered, /#100\s+lifecycle\/run\.note.*Numbered event 99/);
    instance.handleInput("\u001b[B"); instance.handleInput("\u001b[6~");
    const scrolled = instance.render(90).join("\n");
    const visible = scrolled.split("\n").filter(line => line.includes("Numbered event"));
    assert.ok(visible.length > 0);
    for (const row of visible) { const index = Number(/Numbered event (\d+)/u.exec(row)![1]); assert.match(row, new RegExp(`#${index + 1}\\s+`)); }
    await writeFile(join(stateDir, "trace.jsonl"), await readFile(join(stateDir, "trace.jsonl"), "utf8") + "malformed JSON\n");
    instance.invalidate();
    const unknown = instance.render(90).join("\n");
    assert.match(unknown, /#\?\s+lifecycle\/run\.note/);
    assert.doesNotMatch(unknown, /chronology unavailable/);
    instance.handleInput("\r");
    const uncertainty: string[] = [];
    for (let index = 0; index < 20; index++) { uncertainty.push(instance.render(90).join("\n")); instance.handleInput("\u001b[B"); }
    assert.match(uncertainty.join("\n"), /reason: history_incomplete/);
  } finally { instance.dispose(); await rm(root, { force: true, recursive: true }); }
});

test("Actor Inspector numbers mixed Trace rows from the shared chronology across filters", async () => {
  const { root } = await fixture();
  const sources = ["agent", "agent", "lifecycle", "control", "process", "runtime"] as const;
  const sequences = [15, 31, 14, 0, 0, undefined];
  const items: TraceProjection.TraceItem[] = Array.from({ length: 40 }, (_, index) => Object.freeze({
    id: `mixed-${index}`, ts: new Date(40 - index).toISOString(), source: sources[index % sources.length],
    kind: "test.event", summary: `Mixed event ${index}`,
    [TraceProjection.TRACE_ITEM_CHRONOLOGY]: Object.freeze({ state: "available" as const, basis: "recorded_observations" as const, ordinal: 40 - index, total: 40 }),
    ...(index % sources.length === 5 ? {} : { [TraceProjection.TRACE_ITEM_SEQUENCE]: sequences[index % sequences.length] }),
    detail: Object.freeze({}) }));
  const before = JSON.stringify(items);
  const { instance } = overlay(root, undefined, () => items);
  const assertRows = (width: number, selected: TraceProjection.TraceItem[]) => {
    const lines = instance.render(width);
    const rows = lines.filter(line => line.includes("Mixed event"));
    assert.ok(rows.length > 0);
    for (const line of rows) {
      const index = Number(/Mixed event (\d+)/u.exec(line)![1]);
      assert.ok(selected.includes(items[index]));
      assert.match(line, new RegExp(`#${40 - index}\\s+`));
      assert.ok(visibleWidth(line) <= width);
    }
    return rows;
  };
  try {
    instance.handleInput("\u001b[B");
    instance.handleInput("\u001b[C");
    for (const width of [52, 90, 140]) assertRows(width, items);
    instance.handleInput("\u001b[B");
    instance.handleInput("\u001b[6~");
    const scrolled = assertRows(90, items);
    assert.ok(Number(/#(\d+)/u.exec(scrolled[0])![1]) < 40, "Scrolling selects the original chronology, not a new viewport counter");
    instance.handleInput("\u001b");
    instance.handleInput("f");
    const lifecycle = items.filter(item => item.source === "lifecycle");
    assertRows(90, lifecycle);
    assert.match(instance.render(90).join("\n"), /#38\s+lifecycle\/test\.event/);
    for (let index = 0; index < 4; index++) instance.handleInput("f");
    const runtime = items.filter(item => item.source === "runtime");
    assertRows(90, runtime);
    instance.handleInput("\u001b[B");
    instance.handleInput("\r");
    const detail = instance.render(90).join("\n");
    assert.match(detail, /id: mixed-5/);
    assert.doesNotMatch(detail, /projection_sequence:/);
    assert.equal(JSON.stringify(items), before);
    assert.deepEqual(items.slice(0, 6).map(item => item[TraceProjection.TRACE_ITEM_SEQUENCE]), sequences);
  } finally { instance.dispose(); await rm(root, { force: true, recursive: true }); }
});


test("Inspector process stderr metadata is a real YAML mapping", async () => {
  const { root } = await fixture();
  const { instance } = overlay(root);
  try {
    const value = { projection_sequence: 1, source: "process", kind: "process.stderr", detail: { text: "error\r\n\r\n# fake\n```yaml\nnext: no\n```\n trailing  " } };
    const owner = instance as unknown as { documentProjection(value: unknown, width: number): { lines: string[] } };
    const document = parseDocument(owner.documentProjection(value, 10000).lines.join("\n"), { version: "1.2", schema: "core", uniqueKeys: true });
    assert.deepEqual(document.errors, []);
    assert.deepEqual(document.warnings, []);
    assert.deepEqual(document.toJS(), value);
  } finally { instance.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("Inspector process Trace detail route renders selected stderr as YAML data", async () => {
  const { root } = await fixture();
  const item: TraceProjection.TraceItem = { id: "stderr", ts: "2026-01-01T00:00:00.000Z", source: "process", kind: "process.stderr", summary: "Error", detail: { text: "failure\r\n# fake\n---\n```\ntrailing  " } };
  const { instance } = overlay(root, undefined, () => [item], undefined, 60);
  try {
    instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C");
    instance.handleInput("\u001b[B"); instance.handleInput("\r");
    const rows = instance.render(1000).map(stripTerminalSequences);
    const start = rows.findIndex(row => row.includes("id: stderr"));
    assert.ok(start > 0);
    const yamlRows = rows.slice(start, -1).filter(row => row.startsWith("│")).map(row => row.slice(1, -1).trimEnd());
    const document = parseDocument(yamlRows.join("\n"), { version: "1.2", schema: "core", uniqueKeys: true });
    assert.deepEqual(document.errors, []); assert.deepEqual(document.warnings, []);
    assert.deepEqual(document.toJS(), { ...item, chronology: { state: "unavailable", reason: "metadata_unavailable" } });
  } finally { instance.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("Inspector shared YAML preserves generic selected data and rejects accessors without invocation", async () => {
  const { root } = await fixture();
  const { instance } = overlay(root);
  const owner = instance as unknown as { metadataText(value: unknown): string; documentProjection(value: unknown, width: number): { lines: string[]; stripes: number[] } };
  try {
    let deep: unknown = "tail";
    for (let index = 0; index < 80; index++) deep = { child: deep };
    const cases = [null, false, 0, "null", "true", "1e3", "", [], {}, [{ a: [{ b: [] }] }],
      { "\uFEFFkey": "BOM", "next:\n- tool:": "# fake\n---\n```\ntrailing  \n", ["__proto__"]: null,
        scalar: "line\r\n\r\nlast\r\n", ambiguous: ["yes", "null", "false", "0", "[]", "{}"], long: "x".repeat(70000), deep }];
    for (const value of cases) {
      const document = parseDocument(owner.documentProjection(value, 100000).lines.join("\n"), { version: "1.2", schema: "core", uniqueKeys: true });
      assert.deepEqual(document.errors, []); assert.deepEqual(document.warnings, []);
      assert.deepEqual(document.toJS(), value);
    }
    assert.deepEqual(parse(owner.metadataText({ absent: undefined, nil: null, literal: "undefined" })),
      { absent: { value_state: "undefined" }, nil: null, literal: "undefined" });
    let calls = 0;
    for (const value of [Object.defineProperty({}, "field", { enumerable: true, get() { calls++; return "bad"; } }),
      Object.defineProperty([], "0", { enumerable: true, get() { calls++; return "bad"; } }),
      { toJSON() { calls++; return "bad"; } }]) assert.throws(() => owner.documentProjection(value, 90), /selected own data/);
    assert.equal(calls, 0);
  } finally { instance.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("Actor Inspector AX documents keep semantic sequences and opaque values without JSON decoration", async () => {
  const { root } = await fixture();
  const { instance } = overlay(root);
  const projection = instance as unknown as {
    documentProjection(value: unknown, width: number): { lines: string[]; stripes: number[] };
  };
  const body = "## Heading\r\n\r\n- original\r  child\nnext: do not promote\n- tool: no action\ntrailing:  \n```ts\nx: y\n```\n· literal";
  const input = Object.freeze({
    answer: body,
    one: Object.freeze(["pause"]),
    many: Object.freeze(["first", "second"]),
    records: Object.freeze([Object.freeze({ name: "alpha", control: Object.freeze(["pause"]) })]),
    empty: Object.freeze([]),
    map: Object.freeze({}),
    missing: undefined,
    quoted: Object.freeze({ "next:\n- tool:": "literal key" }),
  });
  const expected = { ...input, missing: { value_state: "undefined" } };
  try {
    themeCalls.length = 0;
    const result = projection.documentProjection(input, 140);
    const document = parseDocument(result.lines.join("\n"), { version: "1.2", schema: "core", uniqueKeys: true });
    assert.deepEqual(document.errors, []);
    assert.deepEqual(document.warnings, []);
    assert.deepEqual(document.toJS(), expected);
    Object.entries(expected).forEach(([key, item], stripe) => {
      assert.deepEqual(parse(result.lines.filter((_line, index) => result.stripes[index] === stripe).join("\n")), { [key]: item });
    });
    assert.equal(input.answer, body);
    assert.deepEqual(input.records, [{ name: "alpha", control: ["pause"] }]);
    for (const values of [["single"], ["one", "two"], [null, false, 0], [body], [[["deep"]]]]) {
      const result = projection.documentProjection({ values }, 140);
      assert.deepEqual(parse(result.lines.join("\n")), { values });
    }
  } finally { instance.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("Actor Inspector AX documents wrap whole literal content by columns without changing stripe ownership or source", async () => {
  const { root } = await fixture();
  const { instance } = overlay(root);
  const projection = instance as unknown as {
    documentProjection(value: unknown, width: number): { lines: string[]; stripes: number[] };
  };
  const path = "/root/space  branch/`literal`/" + "界👩‍💻é".repeat(35) + "/tail  ";
  const value = Object.freeze({ path, body: "next:\r\n\r\n- list\r  nested", final: "done" });
  const before = JSON.stringify(value);
  try {
    const wide = projection.documentProjection(value, 10000);
    for (const width of [24, 52, 90, 140]) {
      const result = projection.documentProjection(value, width);
      assert.ok(result.lines.every(line => visibleWidth(line) <= width));
      const pathLines = result.lines.filter((_line, index) => result.stripes[index] === 0);
      assert.ok(pathLines.length > 1);
      assert.ok(pathLines.every(line => !/^[\u200d\u0301]/u.test(line.trimStart()) && !line.endsWith("\u200d")));
      for (const stripe of [0, 1, 2]) {
        assert.equal(result.lines.filter((_line, index) => result.stripes[index] === stripe).join(""),
          wide.lines.filter((_line, index) => wide.stripes[index] === stripe).join(""));
      }
      assert.equal(result.lines.at(-1), "final: done");
      assert.deepEqual([...new Set(result.stripes)], [0, 1, 2]);
      assert.ok(!result.lines.some(line => line.includes("…") || line.includes("[omitted:")));
      const opaque = projection.documentProjection({ body: "head\n" + path }, width);
      assert.ok(opaque.lines.every(line => visibleWidth(line) <= width));
      assert.deepEqual(parse(projection.documentProjection({ body: "head\n" + path }, 10000).lines.join("\n")), { body: "head\n" + path });
    }
    let deep: unknown = "tail";
    for (let depth = 0; depth < 30; depth += 1) deep = { child: deep };
    const nested = projection.documentProjection(deep, 50);
    assert.ok(nested.lines.every(line => visibleWidth(line) <= 50));
    assert.ok(nested.lines.join("").includes("tail"));
    for (const width of [52, 90, 140]) assert.ok(instance.render(width).every(line => visibleWidth(line) <= width));
    assert.equal(JSON.stringify(value), before);
  } finally { instance.dispose(); await rm(root, { recursive: true, force: true }); }
});





test("AX Trace table marks real column and line gaps while detail retains the same projected item", async () => {
  const { root } = await fixture();
  const summary = "界👩‍💻é".repeat(50) + "\r\nSECOND: already selected detail";
  const items: TraceProjection.TraceItem[] = [
    Object.freeze({ id: "trace-gap", ts: "2026-01-01T00:00:03.000Z", source: "agent" as const, kind: "agent.turn", summary,
      detail: Object.freeze({ note: "unchanged" }), [TraceProjection.TRACE_ITEM_SEQUENCE]: 42,
      [TraceProjection.TRACE_ITEM_CHRONOLOGY]: Object.freeze({ state: "available" as const, basis: "recorded_observations" as const, ordinal: 7, total: 9 }) }),
    Object.freeze({ id: "trace-short", ts: "2026-01-01T00:00:02.000Z", source: "runtime" as const, kind: "short", summary: "Done", detail: Object.freeze({}),
      [TraceProjection.TRACE_ITEM_CHRONOLOGY]: Object.freeze({ state: "available" as const, basis: "recorded_observations" as const, ordinal: 6, total: 9 }) }),
    Object.freeze({ id: "trace-authored", ts: "2026-01-01T00:00:01.000Z", source: "runtime" as const, kind: "short", summary: "Authored…", detail: Object.freeze({}),
      [TraceProjection.TRACE_ITEM_CHRONOLOGY]: Object.freeze({ state: "available" as const, basis: "recorded_observations" as const, ordinal: 5, total: 9 }) }),
    Object.freeze({ id: "trace-lines", ts: "2026-01-01T00:00:00.000Z", source: "runtime" as const, kind: "short", summary: "First line\r\nSECOND", detail: Object.freeze({}),
      [TraceProjection.TRACE_ITEM_CHRONOLOGY]: Object.freeze({ state: "available" as const, basis: "recorded_observations" as const, ordinal: 4, total: 9 }) }),
  ];
  const before = JSON.stringify(items);
  let reads = 0;
  const { instance } = overlay(root, undefined, () => { reads += 1; return items; });
  try {
    instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C"); instance.handleInput("\u001b[B");
    for (const width of [24, 52, 90, 140]) {
      const screen = instance.render(width);
      assert.ok(screen.every(line => !/[\r\n]/u.test(line) && visibleWidth(line) <= width));
      const row = screen.find(line => /#7\s+/.test(line));
      assert.ok(row); assert.match(stripTerminalSequences(row).slice(1, -1).trimEnd(), /…$/u);
      assert.equal(Buffer.from(row).toString("utf8"), row);
      if (width >= 52) {
        assert.ok(screen.some(line => /#6\s+.*Done\s*│$/u.test(line)));
        assert.ok(screen.some(line => /#5\s+.*Authored…\s*│$/u.test(line)));
        assert.ok(!screen.some(line => /Authored……/u.test(line)));
        assert.ok(screen.some(line => /#4\s+.*First line.*…/u.test(line)));
        assert.ok(!screen.some(line => line.includes("SECOND")));
      }
    }
    instance.handleInput("\r");
    const detail = instance.render(140).join("\n");
    assert.match(detail, /id: trace-gap/);
    assert.match(detail, /projection_sequence: 42/);
    assert.match(detail, /SECOND:/);
    assert.match(detail, /already selected detail/);
    const metadataOwner = instance as unknown as { metadataText(value: unknown): string };
    assert.equal(parse(metadataOwner.metadataText(items[0])).summary, summary, "YAML metadata preserves the full CRLF summary before terminal soft wrapping");
    assert.equal(items[0].summary, summary);
    instance.handleInput("\u001b"); instance.handleInput("f");
    assert.match(instance.render(90).join("\n"), /#7\s+.*agent\/agent\.turn/);
    assert.equal(reads, 1);
    assert.equal(JSON.stringify(items), before);
    assert.equal(items[0][TraceProjection.TRACE_ITEM_SEQUENCE], 42);
  } finally { instance.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("AX Trace table keeps incomplete history and non-lifetime or unavailable rank essentials at narrow widths", async () => {
  const { root, stateDir } = await fixture("running");
  const original = await readFile(join(stateDir, "trace.jsonl"), "utf8");
  const marker = JSON.stringify({ id: "marker", ts: "2026-01-01T00:00:01.000Z", kind: "runtime.trace_compacted", level: "warning",
    data: { version: 1, compactions_total: 1, dropped_valid_events_total: 3, dropped_malformed_lines_total: 0, dropped_bytes_total: 90,
      dropped_event_count_exact: true, retained_events: 1, retained_bytes: 300, history_complete: false } }) + "\n";
  try {
    for (const mode of ["available", "unavailable", "empty"] as const) {
      await writeFile(join(stateDir, "trace.jsonl"), mode === "available" ? original : marker);
      const chronology = mode === "available"
        ? Object.freeze({ state: "available" as const, basis: "recorded_observations" as const, ordinal: 1, total: 1 })
        : Object.freeze({ state: "unavailable" as const, basis: "recorded_observations" as const, reason: "history_incomplete" as const });
      const item: TraceProjection.TraceItem = Object.freeze({ id: "fixed", ts: "2026-01-01T00:00:00.000Z", source: "runtime", kind: "note", summary: "Short",
        detail: Object.freeze({}), [TraceProjection.TRACE_ITEM_CHRONOLOGY]: chronology });
      const { instance } = overlay(root, undefined, () => mode === "empty" ? [] : [item], undefined, 10);
      try {
        instance.handleInput("\u001b[B"); instance.handleInput("\u001b[C");
        for (const width of [24, 52, 90, 140]) {
          const screen = instance.render(width); const text = screen.join("\n");
          assert.ok(screen.every(line => visibleWidth(line) <= width));
          if (mode !== "available") {
            assert.match(text, width === 24 ? /Trace incomplete…/u : /Trace history incomplete/);
            if (width >= 90) assert.match(text, /1 compaction.*3 dropped event/);
          }
          assert.doesNotMatch(text, /recorded ≠ lifetime|recorded chronology|chronology unavailable|#\? unavailable/u);
          if (mode === "available") assert.match(text, /#1\s+/);
          else if (mode === "unavailable") {
            assert.match(text, /#\?\s+/u);
            assert.doesNotMatch(text, /#1\s+.*runtime\/note/);
          } else assert.match(text, /No Trace evidence/);
        }
        if (mode !== "empty") {
          instance.handleInput("\u001b[B"); instance.handleInput("\r");
          const context: string[] = [];
          for (let index = 0; index < 20; index++) { context.push(instance.render(90).join("\n")); instance.handleInput("\u001b[B"); }
          assert.match(context.join("\n"), mode === "available" ? /basis: recorded_observations/ : /reason: history_incomplete/);
        }
        assert.equal(await readFile(join(stateDir, "trace.jsonl"), "utf8"), mode === "available" ? original : marker);
      } finally { instance.dispose(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AX overlay caught Kill feedback preserves the selected 160-unit stage without new coercion or cause reads", async () => {
  const { root } = await fixture("running");
  try {
    for (const [raw, selected, clipped] of [
      ["## Problem\r\n\r\n- detail", "## Problem - detail", false],
      ["a".repeat(160), "a".repeat(160), false],
      ["a".repeat(161), "a".repeat(160) + "…", true],
      ["a".repeat(159) + "😀tail", "a".repeat(159) + "…", true],
      ["bad\ud800value", undefined, false],
    ] as const) {
      let sends = 0, reads = 0;
      const error = Object.defineProperty(new Error("original", { cause: new Error("private") }), "message", { get() { reads += 1; return raw; } });
      const { instance } = overlay(root, () => { sends += 1; throw error; }, undefined, undefined, 10);
      try {
        instance.handleInput("k"); instance.handleInput("y");
        themeCalls.length = 0;
        instance.render(90);
        assert.ok(themeCalls.some(([kind, color, text]) => kind === "fg" && color === "error" && text === "- action: kill"));
        instance.handleInput("i");
        const state = instance as unknown as { feedback: { message: string } };
        const text = state.feedback.message;
        assert.ok(text.startsWith("- action: kill\n- result: failed\n"));
        if (selected === undefined) {
          assert.match(text, /- diagnostic: unavailable\n- diagnostic_reason: malformed_legacy_preview/);
          assert.doesNotMatch(text, /…/);
        } else assert.ok(text.includes("- diagnostic: " + selected + "\n"));
        assert.equal(text.includes("- diagnostic_omission: [omitted: unknown]"), clipped || selected === undefined);
        assert.ok(text.endsWith("- closure: unconfirmed\n- safety: Do not repeat automatically."));
        assert.equal(Buffer.from(text).toString("utf8"), text);
        for (const width of [24, 52, 90, 140]) assert.ok(instance.render(width).every(line => visibleWidth(line) <= width));
        instance.handleInput("k"); instance.handleInput("y"); instance.handleInput("\r");
        assert.equal(sends, 1); assert.equal(reads, 1);
        instance.handleInput("\u001b");
        assert.doesNotMatch(instance.render(90).join("\n"), /╭ Notice /u);
      } finally { instance.dispose(); }
    }
    const token = Symbol("legacy replace failure");
    const selected = { replaceAll() { throw token; } };
    const bad = Object.defineProperty(new Error(), "message", { value: selected });
    const { instance } = overlay(root, () => { throw bad; });
    try {
      instance.handleInput("k");
      assert.throws(() => instance.handleInput("y"), error => error === token);
    } finally { instance.dispose(); }
    const conversion = { replaceAll() { return { slice() { return { toString() { throw token; } }; } }; } };
    const custom = Object.defineProperty(new Error(), "message", { value: conversion });
    const renderer = overlay(root, () => { throw custom; }).instance;
    try {
      renderer.handleInput("k");
      assert.throws(() => renderer.handleInput("y"), error => error === token);
    } finally { renderer.dispose(); }
    let reads = 0;
    const unreadable = Object.defineProperty(new Error(), "message", { get() { reads += 1; throw token; } });
    const getter = overlay(root, () => { throw unreadable; }).instance;
    try {
      getter.handleInput("k");
      assert.throws(() => getter.handleInput("y"), error => error === token);
      assert.equal(reads, 1);
    } finally { getter.dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AX Kill feedback recognition classifies every current producer result without promoting authored text", async () => {
  const { root } = await fixture("running");
  try {
    const running = { ownerId: "owner", run_instance_id: "generation-a", status: "running" };
    const produce = (status: Record<string, unknown>, kill: Record<string, unknown>) =>
      Inspector.killOwnedRunFromInspector("owner", "demo", root, "generation-a", {
        getRunStatus: () => status,
        killRun: () => kill,
      });
    const cases = [
      ["rejected", produce({ ...running, ownerId: "other" }, { killed: true }), "error"],
      ["rejected", produce({ ...running, run_instance_id: "generation-b" }, { killed: true }), "error"],
      ["failed", produce(running, { killed: false, reason: "control rejected" }), "error"],
      ["unavailable", produce({ ...running, status: "done" }, { killed: true }), "warning"],
    ] as const;
    for (const [result, feedback, color] of cases) {
      assert.equal(feedback.ok, false);
      assert.ok(feedback.message.startsWith(`- action: kill\n- result: ${result}\n`));
      const { instance } = overlay(root, () => feedback);
      try {
        instance.handleInput("k"); instance.handleInput("y");
        assert.equal((instance as unknown as { feedback: { message: string } }).feedback.message, feedback.message);
        themeCalls.length = 0;
        instance.render(90);
        assert.ok(themeCalls.some(([kind, value, text]) => kind === "fg" && value === color && text === "- action: kill"), `${result} keeps its selected color`);
        if (color === "warning") {
          assert.ok(!themeCalls.some(([kind, value, text]) => kind === "fg" && value === "error" && text === "- action: kill"), "Availability is not a failure");
        }
      } finally { instance.dispose(); }
    }
    for (const message of [
      "Kill note: - action: kill\n- result: failed",
      "- run: demo\n- action: kill\n- result: failed",
      "- action: kill\n- result: done",
      "  - action: kill\n- result: failed",
    ]) {
      const { instance } = overlay(root, () => ({ ok: false, message }));
      try {
        instance.handleInput("k"); instance.handleInput("y");
        themeCalls.length = 0;
        const popup = popupFrame(instance.render(90), "Notice");
        assert.ok(popup.lines.join("\n").includes(message.split("\n")[0]!), message);
        assert.ok(!themeCalls.some(([kind, value]) => kind === "fg" && value === "error"), message);
      } finally { instance.dispose(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Popover text has two-column left padding vertical breathing room and the Inspector hint color grammar", async () => {
  const { root } = await fixture("running");
  try {
    for (const rows of [30, 80]) for (const width of [52, 90, 140]) for (const mode of ["notice", "kill"] as const) {
      let calls = 0;
      const { instance } = overlay(root, () => { calls++; return { ok: true, message: "not invoked" }; }, undefined,
        () => [{ run: "demo", runInstanceId: "generation-a", status: mode === "kill" ? "running" : "done" }], rows);
      try {
        instance.render(width); instance.handleInput("k"); themeCalls.length = 0;
        const screen = instance.render(width), popup = popupFrame(screen, mode === "kill" ? "Confirm Actor Kill" : "Notice");
        assert.equal(popup.lines[1]!.slice(1, -1).trim(), "", "One blank row above the main content");
        assert.equal(popup.lines.at(-2)!.slice(1, -1).trim(), "", "One blank row below the main content");
        assert.ok(popup.lines.slice(2, -2).every(line => line.startsWith("│  ")), "Every content row has a uniform two-column outer inset");
        assert.ok(themeCalls.some(([kind, color, text]) => kind === "fg" && color === "borderAccent" && text.startsWith(mode === "kill" ? "╭ Confirm Actor Kill " : "╭ Notice ")));
        assert.ok(themeCalls.some(([kind, color, text]) => kind === "fg" && color === "accent" && /^esc(?:\/n)?$/u.test(text)), "Keys use the same accent token as the Inspector");
        assert.ok(themeCalls.some(([kind, color, text]) => kind === "fg" && color === "borderAccent" && (text === " close" || text === " cancel" || text === " back")), "Key descriptions use the frame token, not key color");
        if (mode === "kill") assert.ok(themeCalls.some(([kind, color, text]) => kind === "fg" && color === "borderAccent" && text === " ─ "), "Hint groups are separated by frame segments");
        assert.equal(calls, 0);
      } finally { instance.dispose(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Inspector modals show all selected text directly without i and composite Kill over the original frame", async () => {
  const { root } = await fixture("running");
  const message = "Kill failed: ## Detail\r\n\r\n- authored bullet\nnext: not a command\n  - tool: data · kept\n    code: `source`\nTail END";
  let calls = 0;
  const { instance } = overlay(root, () => { calls++; return { ok: false, message }; });
  try {
    const before = instance.render(140).map(stripTerminalSequences);
    instance.handleInput("k");
    const confirming = instance.render(140).map(stripTerminalSequences);
    assert.equal(confirming.length, before.length, "Kill is a popup on the Inspector, not a replacement screen");
    const kill = popupFrame(confirming, "Confirm Actor Kill");
    assert.ok(kill.lines.length < confirming.length);
    assert.equal(kill.top, Math.floor((before.length - kill.lines.length) / 2));
    for (let row = 0; row < before.length; row++) if (row < kill.top || row >= kill.top + kill.lines.length) assert.equal(confirming[row], before[row]);
    instance.handleInput("y");
    const notice = popupFrame(instance.render(140), "Notice");
    assert.match(notice.lines.join("\n"), /Tail END/u, "All selected details appear without another key or screen");
    assert.doesNotMatch(notice.lines.join("\n"), / i:|i details/u);
    assert.match(notice.lines.at(-1)!, /esc close/u);
    for (const key of ["i", "k", "y", "\r", "\t", "f"]) instance.handleInput(key);
    assert.equal(calls, 1);
    assert.match(popupFrame(instance.render(140), "Notice").lines.join("\n"), /Tail END/u);
    instance.handleInput("\u001b");
    assert.deepEqual(instance.render(140).map(stripTerminalSequences), before);
    instance.handleInput("i");
    assert.deepEqual(instance.render(140).map(stripTerminalSequences), before, "Removed i command cannot reopen feedback");
  } finally { instance.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("Open modals reuse the frozen underlay through invalidation and resize without fresh evidence reads", async () => {
  const { root } = await fixture("running");
  let calls = 0, reads = 0;
  const terminal = { rows: 30 };
  const instance = new ActorInspectorOverlay({ done: () => {}, ownerId: "owner", stateRoot: root, theme,
    killRun: (_run, generation) => { calls++; assert.equal(generation, "generation-a"); return { ok: false, message: "Failed\n" + "opaque ".repeat(100) }; },
    tui: { requestRender: () => {}, terminal } as unknown as TUI });
  const descriptor = Object.getOwnPropertyDescriptor(fs, "readFileSync")!;
  const original = fs.readFileSync;
  try {
    const before = instance.render(140).map(stripTerminalSequences);
    instance.handleInput("k"); instance.render(140);
    Object.defineProperty(fs, "readFileSync", { ...descriptor, value: (...args: Parameters<typeof fs.readFileSync>) => { reads++; return Reflect.apply(original, fs, args); } });
    syncBuiltinESMExports();
    instance.invalidate();
    for (const [width, rows] of [[24, 10], [52, 12], [90, 80], [140, 30]] as const) {
      terminal.rows = rows;
      instance.handleInput("\u001b[6~"); instance.handleInput("\u001b[5~");
      const screen = instance.render(width);
      assert.ok(screen.length <= rows);
      assert.ok(screen.every(line => visibleWidth(line) <= width));
      assert.match(compactPopupText(popupFrame(screen, "Confirm Actor Kill").lines), /-closure:unconfirmed/u);
    }
    assert.equal(reads, 0);
    const confirming = instance.render(140).map(stripTerminalSequences), popup = popupFrame(confirming, "Confirm Actor Kill");
    for (let row = 0; row < before.length; row++) if (row < popup.top || row >= popup.top + popup.lines.length) assert.equal(confirming[row], before[row]);
    instance.handleInput("y");
    instance.invalidate();
    for (const [width, rows] of [[24, 12], [140, 80], [52, 10]] as const) {
      terminal.rows = rows;
      instance.handleInput("\u001b[6~"); instance.handleInput("i"); instance.handleInput("k");
      const screen = instance.render(width);
      assert.ok(screen.length <= rows);
      popupFrame(screen, "Notice");
    }
    assert.equal(reads, 0); assert.equal(calls, 1);
    instance.handleInput("\u001b");
    instance.render(140);
    assert.ok(reads > 0, "Closing the modal resumes the original refresh/invalidation path");
  } finally {
    Object.defineProperty(fs, "readFileSync", descriptor); syncBuiltinESMExports();
    instance.dispose(); await rm(root, { recursive: true, force: true });
  }
});

test("Inspector feedback is a dismissible overlay that never inserts or shifts document Trace or selector rows", async () => {
  const { root } = await fixture("done");
  const items: TraceProjection.TraceItem[] = Array.from({ length: 40 }, (_, index) => ({
    id: `notice-${index}`, ts: "2026-01-01T00:00:00.000Z", source: "lifecycle", kind: "run.note", summary: `Event ${index}`, detail: { body: "opaque ".repeat(100) },
  }));
  const journeys = [[], ["\u001b[B", "\u001b[B", "\u001b[6~"], ["\u001b[B", "\u001b[C", "\u001b[B", "\u001b[B"],
    ["\u001b[B", "\u001b[C", "\u001b[B", "\u001b[B", "\r", "\u001b[6~"], ["\r", "\u001b[B"], ["\u001b[B", "\u001b[C", "\r"]];
  try {
    for (const rows of [10, 12, 30]) for (const width of [24, 52, 90, 140]) for (const keys of journeys) {
      let kills = 0, closed = 0, projections = 0;
      const instance = new ActorInspectorOverlay({ done: () => { closed++; }, killRun: () => { kills++; return { ok: true, message: "not invoked" }; },
        ownerId: "owner", stateRoot: root, theme, readTrace: () => { projections++; return items; },
        tui: { requestRender: () => {}, terminal: { rows } } as unknown as TUI });
      const state = instance as unknown as { focus: string; rowIndex: number; selectedTraceId?: string; documentScroll: number; detailScroll: number; selectorIndex: number; runIndex: number; feedback?: { message: string } };
      const position = () => [state.focus, state.rowIndex, state.selectedTraceId, state.documentScroll, state.detailScroll, state.selectorIndex, state.runIndex];
      try {
        for (const key of keys) instance.handleInput(key);
        const before = instance.render(width).map(stripTerminalSequences), saved = position(), reads = projections;
        instance.handleInput("k");
        const after = instance.render(width).map(stripTerminalSequences);
        assert.equal(after.length, before.length);
        assert.ok(after.every(line => visibleWidth(line) <= width));
        const top = after.findIndex(line => line.includes("╭ Notice "));
        assert.ok(top >= 0, "Feedback owns a separately framed overlay");
        const left = after[top]!.indexOf("╭ Notice "), right = after[top]!.indexOf("╮", left) + 1;
        const bottom = after.findIndex((line, index) => index > top && line[left] === "╰");
        assert.ok(bottom > top);
        for (let row = 0; row < after.length - 1; row++) {
          if (row < top || row > bottom) assert.equal(after[row], before[row], "Uncovered rows remain at their original positions");
          else {
            assert.equal(sliceByColumn(after[row]!, 0, left), sliceByColumn(before[row]!, 0, left));
            assert.equal(sliceByColumn(after[row]!, right, width - right), sliceByColumn(before[row]!, right, width - right));
          }
        }
        assert.doesNotMatch(after.slice(top, bottom + 1).join("\n"), /closure:|No automatic retry/u);
        assert.deepEqual(position(), saved); assert.equal(projections, reads);
        assert.equal(state.feedback!.message, keys.length ? "Focus Run before using Kill." : "Kill unavailable: run is done.");
        instance.handleInput("\u001b");
        assert.deepEqual(instance.render(width).map(stripTerminalSequences).slice(0, -1), before.slice(0, -1));
        assert.deepEqual(position(), saved); assert.equal(state.feedback, undefined);
        assert.equal(closed, 0); assert.equal(kills, 0); assert.equal(projections, reads);
        instance.handleInput("i");
        assert.deepEqual(position(), saved, "Removed i key neither reopens a reader nor changes the underlying focus");
        assert.deepEqual(position(), saved);
        assert.doesNotMatch(instance.render(width).join("\n"), /╭ Notice /u, "Dismissed notification cannot be reopened with i");
      } finally { instance.dispose(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Feedback and Kill popups use terminal background and retain explicit action uncertainty", async () => {
  const { root } = await fixture("running");
  const message = "Kill failed: " + "x".repeat(180) + "\r\n\r\n- tool: literal, not an action";
  const ansiTheme = {
    fg: (_color: string, text: string) => `\u001b[39m${text}\u001b[39m`,
    bg: (color: string, text: string) => `\u001b[48;5;${color === "selectedBg" ? 4 : 8}m${text}\u001b[49m`,
  } as unknown as Theme;
  try {
    for (const rows of [10, 12, 30]) for (const width of [24, 52, 90, 140]) for (const status of ["done", "running"]) {
      const calls: string[] = [];
      const instance = new ActorInspectorOverlay({ done: () => {}, ownerId: "owner", stateRoot: root, theme: ansiTheme,
        readRuns: () => [{ run: "demo", runInstanceId: "generation-a", status }],
        killRun: (run, generation) => { calls.push(`${run}:${generation}`); return { ok: false, message }; },
        tui: { requestRender: () => {}, terminal: { rows } } as unknown as TUI });
      try {
        const before = instance.render(width);
        instance.handleInput("k");
        if (status === "running") {
          const confirming = instance.render(width), kill = popupFrame(confirming, "Confirm Actor Kill");
          const choiceRow = kill.lines.findIndex(line => line.includes(" Cancel "));
          const choiceLeft = kill.left + kill.lines[choiceRow]!.indexOf(" Cancel ");
          for (let row = 0; row < kill.lines.length; row++) for (let column = kill.left; column < kill.left + kill.width; column++) {
            const selected = row === choiceRow && column >= choiceLeft && column < choiceLeft + " Cancel ".length;
            assert.equal(backgroundAt(confirming[kill.top + row]!, column), selected ? "4" : "default", "Kill uses default terminal background except the selected choice");
          }
          instance.handleInput("y");
        }
        const frame = instance.render(width), plain = frame.map(stripTerminalSequences);
        assert.ok(plain.every(line => visibleWidth(line) <= width));
        const top = plain.findIndex(line => line.includes("╭ Notice "));
        assert.ok(top >= 0);
        const left = plain[top]!.indexOf("╭ Notice "), right = plain[top]!.indexOf("╮", left);
        const bottom = plain.findIndex((line, index) => index > top && line[left] === "╰");
        assert.ok(bottom > top);
        for (let row = top; row <= bottom; row++) for (let column = left; column <= right; column++) {
          assert.equal(backgroundAt(frame[row]!, column), "default", `Popup owns row ${row}, column ${column}, without a theme fill`);
        }
        for (let row = 0; row < frame.length; row++) for (let column = 0; column < width; column++) {
          if (row < top || row > bottom || column < left || column > right) assert.equal(backgroundAt(frame[row]!, column), backgroundAt(before[row]!, column), "Uncovered selection/stripe backgrounds survive popup composition");
        }
        const popup = plain.slice(top, bottom + 1).join("\n");
        if (status === "running") {
          assert.match(compactPopupText(plain.slice(top, bottom + 1)), /-closure:unconfirmed/u); assert.match(compactPopupText(plain.slice(top, bottom + 1)), /Noautomaticretry\./u);
          assert.doesNotMatch(popup, /…/u); assert.deepEqual(calls, ["demo:generation-a"]);
        } else { assert.doesNotMatch(popup, /closure:|No automatic retry/u); assert.deepEqual(calls, []); }
        instance.handleInput("i");
        assert.equal((instance as unknown as { feedback: { message: string } }).feedback.message, status === "running" ? message : "Kill unavailable: run is done.");
        for (const key of ["k", "y", "\r", "\t", "i"]) instance.handleInput(key);
        assert.equal(calls.length, Number(status === "running"), "Opening or reading the popup never retries the action");
        instance.handleInput("\u001b");
        assert.doesNotMatch(instance.render(width).join("\n"), /╭ Notice /u);
        instance.handleInput("k");
        if (status === "running") {
          instance.handleInput("n");
          assert.doesNotMatch(instance.render(width).join("\n"), /╭ Notice /u, "Cancellation is not another notification");
          instance.handleInput("\r"); instance.handleInput("k");
        }
        assert.match(instance.render(width).join("\n"), /╭ Notice /u, "A later guard failure can still show its own popup after a previous dismissal");
        assert.equal(calls.length, Number(status === "running"));
      } finally { instance.dispose(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AX feedback popup exposes the complete selected value directly with visible action uncertainty", async () => {
  const { root } = await fixture("running");
  const message = "Kill failed: ## Detail\r\n\r\n- authored bullet\nnext: not a command\n  - tool: data · kept\n    code: \x60source\x60\nTail END";
  const result = Object.freeze({ ok: false, message });
  const calls: string[] = [];
  const { instance } = overlay(root, (run, generation) => { calls.push(run + ":" + generation); return result; }, undefined, undefined, 10);
  const expected = message.split(/\r\n|\r|\n/u);
  try {
    instance.handleInput("k"); instance.handleInput("y");
    for (const width of [24, 52, 90, 140]) {
      const lines = instance.render(width);
      assert.ok(lines.every(line => !/[\r\n]/u.test(line) && visibleWidth(line) <= width));
      const popup = popupFrame(lines, "Notice");
      assert.doesNotMatch(popup.lines.join("\n"), / i:|i details/u);
      assert.match(compactPopupText(popup.lines), /-closure:unconfirmed/);
      assert.match(compactPopupText(popup.lines), /Noautomaticretry\./);
      assert.deepEqual(calls, ["demo:generation-a"]);
    }
    instance.handleInput("\u001b[5~");
    const collected = new Map<number, string>();
    for (let page = 0; page < 30; page++) {
      const popup = popupFrame(instance.render(140), "Notice");
      const contents = popup.lines.slice(2, -2).map(line => line.slice(3, -1).trimEnd());
      const pager = contents.findIndex(line => /^\d+-\d+\/\d+ ↑↓ pgup\/pgdn/u.test(line));
      const body = pager < 0 ? contents.slice(0, -2) : contents.slice(0, pager);
      const start = pager < 0 ? 0 : Number(/^(\d+)-/u.exec(contents[pager])![1]) - 1;
      body.forEach((line, index) => collected.set(start + index, line));
      assert.match(compactPopupText(popup.lines), /-closure:unconfirmed/);
      assert.match(compactPopupText(popup.lines), /Noautomaticretry\./);
      for (const key of ["k", "y", "\r", "\t", "f", "i", "\u001b[D"]) instance.handleInput(key);
      assert.deepEqual(calls, ["demo:generation-a"], "Notification keys never replay the action or navigate underlying work");
      if (start + body.length === expected.length) break;
      instance.handleInput("\u001b[6~");
    }
    assert.deepEqual([...collected].sort(([a], [b]) => a - b).map(([, line]) => line), expected);
    assert.equal(result.message, message);
    for (let page = 0; page < expected.length; page++) instance.handleInput("\u001b[5~");
    assert.match(popupFrame(instance.render(140), "Notice").lines.join("\n"), /Kill failed/);
    instance.handleInput("\u001b");
    assert.match(instance.render(140).join("\n"), /←\s+Run:/);
    assert.deepEqual(calls, ["demo:generation-a"]);
  } finally { instance.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("Inspector Kill cancellation is silent while selector guards and legacy caught-error selection remain visible", async () => {
  const { root } = await fixture("running");
  let calls = 0;
  const { instance } = overlay(root, () => { calls++; return { ok: true, message: "unused" }; }, undefined, undefined, 10);
  try {
    for (const width of [24, 52, 90, 140]) {
      const before = instance.render(width).map(stripTerminalSequences);
      for (const keys of [["\u001b"], ["n"], ["N"], ["\r"], ["\u001b[C", "\u001b[D", "\r"], ["\t", "\t", "\r"]]) {
        instance.handleInput("k");
        assert.match(instance.render(width).join("\n"), /Confirm Actor Kill/u);
        for (const key of keys) instance.handleInput(key);
        const state = instance as unknown as { feedback?: unknown; killConfirmation?: unknown; focus: string };
        assert.equal(state.feedback, undefined); assert.equal(state.killConfirmation, undefined); assert.equal(state.focus, "runs");
        assert.deepEqual(instance.render(width).map(stripTerminalSequences), before, "Cancel restores the same Inspector without an extra dismissal");
        assert.equal(calls, 0);
      }
    }
    instance.handleInput("\r");
    const selector = instance.render(90).map(stripTerminalSequences);
    assert.match(selector.join("\n"), /#0\s+demo\s+running/);
    instance.handleInput("k"); instance.handleInput("i"); instance.handleInput("y"); instance.handleInput("\r");
    assert.match(popupFrame(instance.render(90), "Notice").lines.join("\n"), /Focus Run before using Kill/);
    instance.handleInput("\u001b");
    assert.deepEqual(instance.render(90).map(stripTerminalSequences), selector);
    instance.handleInput("\u001b");
    assert.match(instance.render(90).join("\n"), /←\s+Run:/);
    assert.equal(calls, 0);
  } finally { instance.dispose(); }
  const empty = overlay(root, undefined, undefined, () => [], 10).instance;
  try {
    empty.handleInput("k"); empty.handleInput("i");
    const popup = popupFrame(empty.render(140), "Notice").lines.join("\n");
    assert.match(popup, /Kill unavailable: no owned run\./);
    assert.doesNotMatch(popup, /closure:|No automatic retry/);
    empty.handleInput("\u001b");
    assert.equal(calls, 0);
  } finally { empty.dispose(); }
  let reads = 0;
  const raw = "## Error\r\n\r\n- Diagnostic " + "x".repeat(240);
  const cause = new Error("private source");
  const original = Object.defineProperty(new Error("original", { cause }), "message", { get() { reads++; return raw; } });
  const failed = overlay(root, () => { calls++; throw original; }, undefined, undefined, 10).instance;
  try {
    failed.handleInput("k"); failed.handleInput("y"); failed.handleInput("i");
    assert.equal(reads, 1); assert.equal(calls, 1); assert.equal(original.cause, cause);
    const expected = "- action: kill\n- result: failed\n- diagnostic: " + raw.replaceAll(/\s+/gu, " ").slice(0, 160) + "…\n- diagnostic_omission: [omitted: unknown]\n- preview_basis: selected legacy preview; upstream completeness/privacy unproven\n- closure: unconfirmed\n- safety: Do not repeat automatically.";
    const internal = failed as unknown as { feedback?: { message: string } };
    assert.equal(internal.feedback!.message, expected);
    for (const width of [24, 52, 90, 140]) {
      const screen = failed.render(width);
      assert.ok(screen.every(line => !/[\r\n]/u.test(line) && visibleWidth(line) <= width));
      assert.match(popupFrame(screen, "Notice").lines.at(-1)!, /esc/);
      failed.handleInput("\u001b[6~"); failed.handleInput("\u001b[5~");
    }
    assert.equal(reads, 1); assert.equal(calls, 1);
    failed.handleInput("\u001b");
    assert.equal(internal.feedback, undefined);
  } finally { failed.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("Kill confirmation is a compact centered dialog rather than a stretched Inspector viewport", async () => {
  const { root } = await fixture("running");
  let calls = 0;
  try {
    for (const rows of [10, 12, 30, 80]) for (const width of [24, 52, 90, 140]) {
      const { instance } = overlay(root, () => { calls++; return { ok: true, message: "not invoked" }; }, undefined, undefined, rows);
      try {
        instance.handleInput("k");
        const frame = instance.render(width).map(stripTerminalSequences);
        const popup = popupFrame(frame, "Confirm Actor Kill"), screen = popup.lines;
        const left = 0;
        const dialogWidth = Math.min(width, 72);
        assert.equal(popup.left, Math.floor((width - dialogWidth) / 2), "Dialog is horizontally centered with a bounded width");
        assert.equal(screen[0]!.lastIndexOf("╮") - left + 1, dialogWidth);
        assert.ok(frame.length <= rows);
        assert.ok(screen.length <= frame.length);
        assert.equal(popup.top, Math.floor((frame.length - screen.length) / 2));
        assert.ok(screen.every(line => visibleWidth(line) <= width));
        assert.ok(screen.length <= (width === 24 ? 14 : 10), "Height follows padded content, including wrapped safety and stacked choices at 24 columns, not the tall Inspector viewport");
        const closure = screen.findIndex(line => line.includes("- closure:"));
        assert.ok(closure > 1);
        assert.ok(screen.slice(2, closure).every(line => line.slice(left + 1, left + dialogWidth - 1).trim().length > 0), "Only the requested outer blank rows surround content, not filler between fields and warning");
        assert.match(compactPopupText(screen), /-closure:unconfirmed/u);
        assert.match(screen.join("\n"), /Cancel/u); assert.match(screen.join("\n"), /Kill actor/u);
        const choices = screen.findIndex(line => line.includes(" Cancel "));
        assert.ok(choices > closure + 1);
        assert.equal(screen[choices - 1]!.slice(1, -1).trim(), "", "Exactly one empty row separates description and choices");
        assert.ok(screen[choices - 2]!.slice(1, -1).trim().length > 0, "The spacer is not doubled");
        assert.ok(screen.every(line => line[left] === "│" || line[left] === "╭" || line[left] === "╰"));
        instance.handleInput("\r");
        assert.equal(calls, 0, "Layout keeps default Cancel and never actuates");
      } finally { instance.dispose(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AX Kill confirmation keeps whole captured fields and pinned cancel closure at narrow heights without actuation", async () => {
  const { root } = await fixture("running");
  const name = "long-captured-".repeat(12) + "tail";
  const row = Object.freeze({ run: name, runInstanceId: "captured-generation", status: "running" });
  let calls = 0;
  try {
    for (const rows of [10, 12, 30]) for (const width of [24, 52, 90, 140]) {
      const { instance } = overlay(root, () => { calls += 1; return { ok: true, message: "not invoked" }; }, undefined, () => [row], rows);
      try {
        instance.handleInput("k");
        const collected = new Map<number, string>();
        let screen = instance.render(width);
        for (let page = 0; page < 100; page += 1) {
          assert.ok(screen.every(line => visibleWidth(line) <= width));
          assert.ok(screen.length <= rows);
          assert.match(compactPopupText(popupFrame(screen, "Confirm Actor Kill").lines), /-closure:unconfirmed/);
          assert.ok(screen.some(line => /Cancel/u.test(line))); assert.ok(screen.some(line => /Kill actor/u.test(line)));
          const popup = popupFrame(screen, "Confirm Actor Kill").lines;
          const contentStart = popup[1]!.slice(1, -1).trim() ? 1 : 2;
          const contents = popup.slice(contentStart, -1).map(line => line.slice(3, -1).trimEnd());
          const pager = contents.findIndex(line => /\d+-\d+\/\d+ pgup\/pgdn/u.test(line));
          if (pager < 0) {
            contents.slice(0, contents.findIndex(line => line.startsWith("- closure:"))).forEach((line, index) => collected.set(index, line));
            break;
          }
          const range = /(\d+)-(\d+)\/(\d+) pgup\/pgdn/u.exec(contents[pager])!;
          contents.slice(0, pager).forEach((line, index) => collected.set(Number(range[1]) - 1 + index, line));
          if (Number(range[2]) === Number(range[3])) break;
          instance.handleInput("\u001b[6~");
          screen = instance.render(width);
        }
        const body = [...collected].sort(([a], [b]) => a - b).map(([, line]) => line);
        const state = body.findIndex(line => line === "state: running");
        assert.ok(state > 0);
        assert.equal(body.slice(0, state).join(""), "run: " + name);
        assert.ok(body.slice(state + 1).join("").replaceAll(/\s+/gu, "").includes("action:generation-fencedruntimekill"));
        themeCalls.length = 0;
        instance.render(width);
        assert.ok(themeCalls.some(([kind, color, text]) => kind === "bg" && color === "selectedBg" && text.includes("Cancel")));
        assert.equal(calls, 0);
        instance.handleInput("\r");
        assert.equal(calls, 0, "Enter keeps the original Cancel default, including after reading later pages");
      } finally { instance.dispose(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AX Kill detail paging preserves choice reset exact generation and once-only confirmation", async () => {
  const { root } = await fixture("running");
  const name = "captured-".repeat(10) + "tail";
  try {
    for (const confirm of ["y", "\r"]) {
      const calls: string[] = [];
      let status = "running";
      const { instance } = overlay(root, (run, generation) => { calls.push(run + ":" + generation); status = "killed"; return { ok: true, message: "must not duplicate success" }; },
        undefined, () => [{ run: name, runInstanceId: "old-generation", status }], 10);
      try {
        instance.handleInput("k");
        const first = instance.render(52).join("\n");
        assert.match(first, /1-\d+\/\d+ pgup\/pgdn/);
        instance.handleInput("\u001b[C");
        instance.handleInput("\u001b[6~");
        themeCalls.length = 0;
        const later = instance.render(52).join("\n");
        assert.notEqual(later, first);
        assert.ok(themeCalls.some(([kind, color, text]) => kind === "bg" && color === "selectedBg" && text.includes("Kill actor")));
        assert.deepEqual(calls, []);
        for (const width of [24, 140, 52]) {
          themeCalls.length = 0;
          const resized = instance.render(width);
          assert.ok(resized.every(line => visibleWidth(line) <= width));
          assert.match(compactPopupText(popupFrame(resized, "Confirm Actor Kill").lines), /-closure:unconfirmed/);
          assert.ok(themeCalls.some(([kind, color, text]) => kind === "bg" && color === "selectedBg" && text.includes("Kill actor")));
          assert.deepEqual(calls, []);
        }
        instance.handleInput("\u001b[5~");
        assert.match(instance.render(52).join("\n"), /1-\d+\/\d+ pgup\/pgdn/);
        instance.handleInput("n");
        assert.deepEqual(calls, []);
        instance.handleInput("\u001b");
        instance.handleInput("k");
        themeCalls.length = 0;
        assert.match(instance.render(52).join("\n"), /1-\d+\/\d+ pgup\/pgdn/);
        assert.ok(themeCalls.some(([kind, color, text]) => kind === "bg" && color === "selectedBg" && text.includes("Cancel")));
        instance.handleInput("\u001b[6~");
        instance.render(52);
        instance.handleInput("\u001b");
        assert.deepEqual(calls, []);
        instance.handleInput("\u001b");
        instance.handleInput("k");
        instance.render(52);
        instance.handleInput("\t");
        instance.handleInput("\u001b[6~");
        instance.render(52);
        instance.handleInput(confirm);
        assert.deepEqual(calls, [name + ":old-generation"]);
        const after = instance.render(140).join("\n");
        assert.match(after, /Run:.*killed/);
        assert.doesNotMatch(after, /must not duplicate success|Confirm Actor Kill/);
        instance.handleInput("y");
        assert.equal(calls.length, 1);
      } finally { instance.dispose(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Actor Inspector confirms generation-fenced Run Kill without duplicate success copy", async () => {
  const { root } = await fixture("running");
  try {
    for (const keys of [["y"], ["\u001b[C", "\r"], ["\t", "\r"]]) {
      const calls: string[] = [];
      let status = "running";
      const { instance } = overlay(
        root,
        (run, generation) => {
          calls.push(`${run}:${generation}`);
          status = "killed";
          return { ok: true, message: "Killed run:demo." };
        },
        undefined,
        () => [{
          run: "demo",
          runInstanceId: "generation-a",
          status,
        }],
      );
      try {
        instance.handleInput("k");
        const confirmation = instance.render(90).join("\n");
        assert.match(confirmation, /Confirm Actor Kill/);
        assert.match(confirmation, /generation-fenced runtime kill/);
        assert.doesNotMatch(confirmation, /cannot be undone|kill Control/);
        for (const key of keys) instance.handleInput(key);
        assert.deepEqual(calls, ["demo:generation-a"]);
        for (const width of [24, 52, 90, 140]) {
          const killed = instance.render(width).join("\n");
          if (width >= 90) assert.match(killed, /Run:.*demo.*killed/);
          assert.doesNotMatch(killed, /Killed run:demo|╭ Notice |Confirm Actor Kill/);
        }
        assert.equal((instance as unknown as { feedback?: unknown }).feedback, undefined);
        instance.handleInput("y"); assert.equal(calls.length, 1);
      } finally { instance.dispose(); }
    }
  } finally { await rm(root, { force: true, recursive: true }); }
});
