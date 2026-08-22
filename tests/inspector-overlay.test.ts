import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";

import * as Inspector from "../lib/inspector.ts";
import { ActorInspectorOverlay } from "../lib/inspector-overlay.ts";
import * as TraceProjection from "../lib/trace-projection.ts";

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
    tui: { requestRender: () => { renders += 1; } } as unknown as TUI,
  });
  return { instance, renders: () => renders };
}

test("Actor Inspector exposes exactly Recipe, Trace, and Control tabs", async () => {
  themeCalls.length = 0;
  const { root } = await fixture();
  const { instance } = overlay(root);
  try {
    const recipe = instance.render(90).join("\n");
    assert.match(recipe, /Actor Inspector/);
    assert.match(recipe, /←\s+Run:\s+#0.*→/);
    assert.match(recipe, /Recipe.*Trace.*Control/);
    assert.match(recipe, /import_path: \[\]/);
    assert.doesNotMatch(recipe, /import_path:\s*\n\s*\[\]/);
    assert.match(recipe, /composition: \[[\s\S]*#0: \{/);
    assert.doesNotMatch(recipe, /- #\d+/);
    assert.equal(
      themeCalls.some(([kind, color, text]) =>
        kind === "fg" && color === "accent" && text === "#0:"
      ),
      true,
    );
    assert.match(recipe, /control: \[pause\]/);
    assert.match(recipe, /artifacts: \{[\s\S]*queue: \{state_dir\}\/queue\.json,[\s\S]*locks: \{state_dir\}\/locks\.json,[\s\S]*journal: \{state_dir\}\/journal\.jsonl[\s\S]*\}/);
    assert.doesNotMatch(recipe, /artifacts: \{ queue:/);
    assert.match(recipe, /prompt: first[^\n]*│\n│\s+second/);
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
    assert.match(instance.render(90).join("\n"), /▶\s+#1.*Newest/);
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
    assert.match(control, /recent_controls:/);
    assert.match(control, /\[REDACTED\]/);
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
    assert.match(runMenu[runTriggerRow + 1] ?? "", /^│ \[ R╭/);
    assert.match(runMenu.join("\n"), /Control/);
    assert.match(runMenu.join("\n"), /definition:/);
    assert.equal(runMenu.every((line) => visibleWidth(line) <= 90), true);
    assert.equal(themeCalls.some(([kind, color, text]) =>
      kind === "bg" && color === "selectedBg" && /Run:/.test(text)
    ), true);
    instance.handleInput("\u001b");
    instance.handleInput("\u001b[B");
    instance.handleInput("\u001b[C");
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
    assert.match(traceMenu.join("\n"), /process completed/);
    assert.equal(traceMenu.every((line) => visibleWidth(line) <= 90), true);
    assert.equal(themeCalls.some(([kind, color, text]) =>
      kind === "bg" && color === "selectedBg" && /\[ Trace \]/.test(text)
    ), true);
    assert.equal(themeCalls.some(([kind, color]) => kind === "bg" && color === "customMessageBg"), true);
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
    const menu = instance.render(90).join("\n");
    const runningRow = menu.split("\n").find((line) =>
      line[5] === "│" && /#1\s+long-name\s+running/.test(line)
    );
    const doneRow = menu.split("\n").find((line) =>
      line[5] === "│" && /#0\s+x\s+done/.test(line)
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
    source: "lifecycle",
    summary: "Oldest event",
    ts: "2026-01-01T00:00:00.000Z",
  };
  const middle: TraceProjection.TraceItem = {
    detail: {},
    id: "middle",
    kind: "run.progress",
    source: "lifecycle",
    summary: "Middle event",
    ts: "2026-01-02T00:00:00.000Z",
  };
  const newest: TraceProjection.TraceItem = {
    detail: { attention: "notify" },
    id: "newest",
    kind: "run.done",
    source: "lifecycle",
    summary: "Newest event",
    ts: "2026-01-03T00:00:00.000Z",
  };
  let refreshed = false;
  const { instance } = overlay(
    root,
    undefined,
    () => refreshed ? [newest, middle, older] : [middle, older],
  );
  try {
    instance.handleInput("\u001b[B");
    instance.handleInput("\u001b[C");
    const initial = instance.render(90).join("\n");
    assert.ok(initial.indexOf("Middle event") < initial.indexOf("Oldest event"));
    instance.handleInput("\u001b[B");
    instance.render(90);
    instance.handleInput("\u001b[B");
    assert.match(instance.render(90).join("\n"), /▶\s+#0.*Oldest event/);
    refreshed = true;
    instance.invalidate();
    const updated = instance.render(90).join("\n");
    assert.ok(updated.indexOf("Newest event") < updated.indexOf("Middle event"));
    assert.ok(updated.indexOf("Middle event") < updated.indexOf("Oldest event"));
    assert.match(updated, /#2\s+A\s+lifecycle\/run\.done.*Newest event/);
    assert.doesNotMatch(updated, /[•·]/u);
    assert.match(updated, /#1.*Middle event/);
    assert.match(updated, /▶\s+#0.*Oldest event/);
  } finally {
    instance.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("Actor Inspector confirms generation-fenced Run Kill without duplicate success copy", async () => {
  const { root } = await fixture("running");
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
    instance.handleInput("\u001b[C");
    instance.handleInput("\r");
    assert.deepEqual(calls, ["demo:generation-a"]);
    const killed = instance.render(90).join("\n");
    assert.match(killed, /Run:.*demo.*killed/);
    assert.doesNotMatch(killed, /Killed run:demo/);
  } finally {
    instance.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
