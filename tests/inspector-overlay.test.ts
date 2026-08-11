import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

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
        file: "/recipes/demo.json",
        import_path: [],
        name: "demo",
        recipe: { control: ["pause"], prompt: "first\nsecond", template: "echo demo" },
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
    assert.match(recipe, /←\s+Run:.*→/);
    assert.match(recipe, /Recipe.*Trace.*Control/);
    assert.match(recipe, /import_path: \[\]/);
    assert.doesNotMatch(recipe, /import_path:\s*\n\s*\[\]/);
    assert.match(recipe, /control: \[pause\]/);
    assert.match(recipe, /values: \{\}/);
    assert.match(recipe, /prompt: first[^\n]*│\n│\s+second/);
    assert.equal(themeCalls.some(([kind, color]) => kind === "fg" && color === "borderAccent"), true);
    assert.equal(themeCalls.some(([kind, color]) => kind === "fg" && color === "accent"), true);
    assert.equal(themeCalls.some(([kind, color, text]) => kind === "fg" && color === "accent" && text === "←→"), true);
    assert.equal(themeCalls.some(([kind, color, text]) => kind === "fg" && color === "borderAccent" && text === " run"), true);
    assert.equal(themeCalls.some(([kind, color, text]) => kind === "fg" && color === "borderAccent" && text === " ─ "), true);
    assert.equal(themeCalls.some(([kind, color]) => kind === "bg" && color === "customMessageBg"), true);
    assert.equal(themeCalls.some(([kind, color]) => kind === "bg" && color === "selectedBg"), false);
    assert.doesNotMatch(recipe, /Messages|Turns|Communications/);
    instance.handleInput("\u001b[B");
    assert.match(instance.render(90).join("\n"), /\[ Recipe \]/);
    instance.handleInput("\u001b[C");
    const trace = instance.render(90).join("\n");
    assert.match(trace, /\[ Trace \]/);
    assert.match(trace, /lifecycle\/run\.start/);
    assert.match(trace, /enter\/f source/);
    instance.handleInput("\u001b[B");
    assert.match(instance.render(90).join("\n"), /→\/enter open/);
    instance.handleInput("\r");
    assert.match(instance.render(90).join("\n"), /kind: process\.result/);
    instance.handleInput("\u001b[D");
    instance.handleInput("f");
    assert.match(instance.render(90).join("\n"), /\[ Trace \(lifecycle\) \]/);
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
    assert.match(instance.render(90).join("\n"), /run:demo\s+done/);
    instance.handleInput("\u001b");
    instance.handleInput("\u001b[B");
    instance.handleInput("\u001b[C");
    instance.handleInput("\r");
    assert.match(instance.render(90).join("\n"), /Trace source: all/);
    assert.equal(themeCalls.some(([kind, color]) => kind === "bg" && color === "selectedBg"), false);
    assert.equal(themeCalls.some(([kind, color]) => kind === "bg" && color === "customMessageBg"), true);
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

test("Actor Inspector confirms generation-fenced Run Kill", async () => {
  const { root } = await fixture("running");
  const calls: string[] = [];
  const { instance } = overlay(root, (run, generation) => {
    calls.push(`${run}:${generation}`);
    return { ok: true, message: "Killed" };
  });
  try {
    instance.handleInput("k");
    const confirmation = instance.render(90).join("\n");
    assert.match(confirmation, /Confirm Actor Kill/);
    assert.match(confirmation, /The action is destructive and cannot be undone/);
    instance.handleInput("\u001b[C");
    instance.handleInput("\r");
    assert.deepEqual(calls, ["demo:generation-a"]);
    assert.match(instance.render(90).join("\n"), /Killed/);
  } finally {
    instance.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
