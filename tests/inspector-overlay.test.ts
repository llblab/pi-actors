import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";

import { ActorInspectorOverlay } from "../lib/inspector-overlay.ts";
import type { ActorInspectorTurnItem } from "../lib/inspector.ts";

const theme = {
  bg: (_color: string, text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

async function fixture(): Promise<{ root: string; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-overlay-"));
  const stateDir = join(root, "demo");
  const sessionDir = join(stateDir, "sessions", "command-001");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(stateDir, "run.json"),
    JSON.stringify({
      launch_source: "spawn",
      ownerId: "owner",
      recipe: "demo_recipe",
      recipe_context_records: [{
        depth: 0,
        file: "/recipes/demo_recipe.json",
        import_path: [],
        name: "demo_recipe",
        recipe: {
          args: ["scope:path"],
          description: "Inspect one scope",
          template: "inspect {scope}",
        },
      }],
      recipe_file: "/recipes/demo_recipe.json",
      run: "demo",
      run_instance_id: "demo-instance",
      template: "inspect /workspace",
      values: { scope: "/workspace" },
    }),
  );
  await writeFile(
    join(stateDir, "progress.json"),
    JSON.stringify({ phase: "done" }),
  );
  await writeFile(
    join(stateDir, "inbox.jsonl"),
    `${Array.from({ length: 15 }, (_, index) =>
      JSON.stringify({
        body:
          index === 0
            ? "hello overlay 1\nsecond line\tcontinued"
            : `hello overlay ${index + 1}`,
        from: "branch:demo/reviewer",
        received_at: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
        to: "run:demo",
        type: "chat.message",
      }),
    ).join("\n")}\n`,
  );
  await mkdir(join(stateDir, "rooms", "main"), { recursive: true });
  await writeFile(
    join(stateDir, "rooms", "main", "roster.json"),
    JSON.stringify({
      "run:demo": {
        role: "run",
        status: "present",
      },
      "branch:demo/reviewer": {
        display: "Reviewer",
        role: "reviewer",
        status: "active",
      },
    }),
  );
  await writeFile(
    join(stateDir, "review-evidence.json"),
    JSON.stringify({
      commands: [
        {
          id: "command-001",
          recipe_context: [{ name: "demo_recipe", template: "inspect {scope}" }],
          session_files: ["sessions/command-001/session.jsonl"],
          stage: "reviewer",
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
        message: { role: "user", content: "Audit inspector" },
      }),
      JSON.stringify({
        type: "message",
        id: "a",
        parentId: "u",
        message: {
          role: "assistant",
          provider: "test",
          model: "model",
          stopReason: "toolUse",
          usage: { totalTokens: 9 },
          content: [
            { type: "thinking", thinking: "Visible reasoning" },
            { type: "text", text: "Audit complete\n\nwithout escaping overlay\n" },
            {
              type: "toolCall",
              id: "call-1",
              name: "read",
              arguments: { path: "README.md", token: "hidden" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "result",
        parentId: "a",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "Tool output" }],
          isError: false,
        },
      }),
    ].join("\n"),
  );
  return { root, stateDir };
}

function createOverlay(
  root: string,
  overlayTheme: Theme = theme,
  terminalRows = 30,
  killRun?: (run: string) => { ok: boolean; message: string },
  readTurns?: (stateDir: string) => ActorInspectorTurnItem[],
) {
  let closed = false;
  let renders = 0;
  const overlay = new ActorInspectorOverlay({
    done: () => {
      closed = true;
    },
    killRun,
    ownerId: "owner",
    readTurns,
    stateRoot: root,
    theme: overlayTheme,
    tui: {
      requestRender: () => {
        renders += 1;
      },
      terminal: { rows: terminalRows },
    } as unknown as TUI,
  });
  return { overlay, closed: () => closed, renders: () => renders };
}

test("actor inspector overlay navigates run, nested filters, tabs, and detail", async () => {
  const { root } = await fixture();
  const { overlay, renders } = createOverlay(root);
  try {
    let output = overlay.render(90).join("\n");
    assert.match(output, /Run: #1\s{2}demo\s{2}done/);
    assert.match(output, /\[ Recipe \]/);
    assert.match(output, /Inspect one scope/);
    assert.match(output, /inspect \/workspace/);
    overlay.handleInput("\r");
    assert.match(overlay.render(90).join("\n"), /↑ at top tabs/);
    overlay.handleInput("\u001b[A");
    overlay.handleInput("\u001b[C");
    output = overlay.render(90).join("\n");
    assert.match(output, /\[ Messages \]/);
    assert.ok(output.indexOf("#15") < output.indexOf("#14"));
    assert.match(output, /#15.*hello overlay 15/);
    const initialTabLine = output.split("\n").find((line) => line.includes("Messages")) ?? "";
    overlay.handleInput("\u001b[C");
    const turnsOutput = overlay.render(90).join("\n");
    const switchedTabLine = turnsOutput.split("\n").find((line) => line.includes("Messages")) ?? "";
    assert.equal(switchedTabLine.indexOf("Messages"), initialTabLine.indexOf("Messages"));
    assert.equal(switchedTabLine.indexOf("Turns"), initialTabLine.indexOf("Turns"));
    assert.match(turnsOutput, /#1\s+Subagent 1 \(reviewer\)\s+model\s+\(read\)/);
    assert.doesNotMatch(turnsOutput, /test\/model/);
    overlay.handleInput("\u001b[D");
    overlay.handleInput("\u001b[A");
    output = overlay.render(90).join("\n");
    assert.match(output, /← Run: #1\s{2}demo\s{2}done →/);
    assert.doesNotMatch(output, /\[ Messages \]/);
    overlay.handleInput("\r");
    assert.match(overlay.render(90).join("\n"), /▶ #1\s+demo\s{2}done/);
    overlay.handleInput("\u001b");
    overlay.handleInput("\u001b[B");
    overlay.handleInput("\r");
    output = overlay.render(90).join("\n");
    assert.match(output, /▶ Channel: all/);
    assert.match(output, /State: all/);
    assert.match(output, /From: all/);
    overlay.handleInput("\r");
    output = overlay.render(90).join("\n");
    assert.match(output, /Channel: all/);
    assert.match(output, /▶ all/);
    assert.match(output, /broadcast/);
    assert.match(output, /hello overlay/);
    overlay.handleInput("\u001b[B");
    overlay.handleInput("\r");
    overlay.handleInput("\u001b[B");
    overlay.handleInput("\u001b[B");
    overlay.handleInput("\r");
    output = overlay.render(90).join("\n");
    assert.match(output, /demo/);
    assert.match(output, /Reviewer/);
    assert.doesNotMatch(output, /Run actor/);
    overlay.handleInput("\u001b");
    overlay.handleInput("\u001b");
    overlay.handleInput("\u001b[C");
    overlay.handleInput("\r");
    overlay.handleInput("\r");
    overlay.handleInput("\u001b[B");
    overlay.handleInput("\r");
    overlay.handleInput("\u001b");
    overlay.handleInput("\u001b[B");
    overlay.handleInput("\u001b[C");
    output = overlay.render(90).join("\n");
    assert.match(output, /Subagent 1 \(reviewer\)/);
    assert.doesNotMatch(output, /Command|\(command\)/);
    assert.match(output, /Thinking/);
    assert.match(output, /Visible reasoning/);
    assert.match(output, /Audit complete/);
    assert.match(output, /without escaping overlay/);
    assert.doesNotMatch(output, /Recipe Context|demo_recipe/);
    const evidenceRows = overlay.render(90);
    const subagentIndex = evidenceRows.findIndex((line) =>
      line.includes("Subagent 1 (reviewer)"),
    );
    assert.ok(subagentIndex >= 0);
    assert.match(evidenceRows[subagentIndex + 1] ?? "", /User/);
    assert.doesNotMatch(output, /Provenance|sessions\/command-001/);
    const narrowDetail = overlay.render(32);
    for (const line of narrowDetail) assert.equal(visibleWidth(line), 32);
    assert.doesNotMatch(narrowDetail.slice(4, -3).join("\n"), /…/);
    for (let index = 0; index < 30; index += 1)
      overlay.handleInput("\u001b[B");
    output = overlay.render(90).join("\n");
    assert.match(output, /Provenance/);
    assert.match(output, /sessions\/command-001\/session\.jsonl/);
    const provenanceRows = overlay.render(90);
    const sessionHeading = provenanceRows.findIndex((line) =>
      line.includes("Session"),
    );
    assert.ok(sessionHeading >= 0);
    assert.match(
      provenanceRows[sessionHeading + 1] ?? "",
      /sessions\/command-001\/session\.jsonl/,
    );
    assert.doesNotMatch(output, /readable/);
    overlay.handleInput("\u001b[D");
    assert.ok(renders() >= 4);
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector turns show newest numbered evidence first", async () => {
  const { root, stateDir } = await fixture();
  const secondSessionDir = join(stateDir, "sessions", "command-002");
  await mkdir(secondSessionDir, { recursive: true });
  await writeFile(
    join(stateDir, "review-evidence.json"),
    JSON.stringify({
      commands: [
        {
          id: "command-001",
          session_files: ["sessions/command-001/session.jsonl"],
          stage: "reviewer",
        },
        {
          id: "command-002",
          session_files: ["sessions/command-002/session.jsonl"],
          stage: "executor",
        },
      ],
    }),
  );
  await writeFile(
    join(secondSessionDir, "session.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, id: "session-2" }),
      JSON.stringify({
        type: "message",
        id: "u2",
        parentId: null,
        message: {
          role: "user",
          content: '<file name="prompt.md">\nSecond task\n</file>',
        },
      }),
      JSON.stringify({
        type: "message",
        id: "a2",
        parentId: "u2",
        message: {
          role: "assistant",
          provider: "test-provider",
          model: "new-model",
          content: [{ type: "text", text: "Newest turn" }],
        },
      }),
    ].join("\n"),
  );
  const { overlay } = createOverlay(root);
  try {
    overlay.handleInput("\u001b[C");
    overlay.handleInput("\u001b[C");
    const output = overlay.render(90).join("\n");
    const newest = output.indexOf("#2  Subagent 2 (executor)");
    const older = output.indexOf("#1  Subagent 1 (reviewer)");
    assert.ok(newest >= 0);
    assert.ok(older > newest);
    assert.match(output, /#2.*new-model.*Newest turn/);
    assert.doesNotMatch(output, /test-provider\/new-model/);
    overlay.handleInput("\u001b[B");
    overlay.handleInput("\u001b[C");
    const detail = overlay.render(90).join("\n");
    assert.match(detail, /Second task/);
    assert.doesNotMatch(detail, /<file|prompt\.md|<\/file>/);
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector caches large turn snapshots while list navigation stays active", async () => {
  const { root } = await fixture();
  let reads = 0;
  const turns: ActorInspectorTurnItem[] = Array.from({ length: 90 }, (_, index) => ({
    assistantText: `Turn ${index + 1}`,
    commandId: `command-${String(index + 1).padStart(3, "0")}`,
    diagnostics: [],
    index: index + 1,
    model: "test/model",
    sessionFile: `sessions/command-${index + 1}/session.jsonl`,
    sessionTruncated: false,
    toolCalls: [],
    unmatchedToolResults: 0,
  }));
  const { overlay } = createOverlay(root, theme, 30, undefined, () => {
    reads += 1;
    return turns;
  });
  try {
    overlay.render(90);
    overlay.handleInput("\u001b[C");
    overlay.handleInput("\u001b[C");
    overlay.render(90);
    overlay.handleInput("\u001b[B");
    for (let index = 0; index < 40; index += 1) {
      overlay.handleInput("\u001b[B");
      overlay.render(90);
    }
    assert.equal(reads, 1);
    assert.match(overlay.render(90).join("\n"), /#49|#50/);
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector left arrow returns a scrolled list to its tabs", async () => {
  const { root } = await fixture();
  const { overlay } = createOverlay(root);
  try {
    overlay.render(90);
    overlay.handleInput("\u001b[C");
    overlay.handleInput("\u001b[B");
    for (let index = 0; index < 8; index += 1) overlay.handleInput("\u001b[B");
    assert.match(overlay.render(90).join("\n"), /← tabs/);

    overlay.handleInput("\u001b[D");
    const tabs = overlay.render(90).join("\n");
    assert.match(tabs, /←→ navigate/);
    assert.doesNotMatch(tabs, /← tabs/);

    overlay.handleInput("\u001b[B");
    assert.match(overlay.render(90).join("\n"), /← tabs/);
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector run control cycles with arrows and left-aligns its scrolling menu", async () => {
  const { root } = await fixture();
  for (let index = 1; index <= 20; index += 1) {
    const run = `run-${String(index).padStart(2, "0")}`;
    const stateDir = join(root, run);
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "run.json"),
      JSON.stringify({ ownerId: "owner", run, run_instance_id: `${run}-instance` }),
    );
    await writeFile(join(stateDir, "progress.json"), JSON.stringify({ phase: "done" }));
  }
  const { overlay } = createOverlay(root);
  try {
    overlay.handleInput("\u001b[A");
    let lines = overlay.render(90);
    assert.match(lines[1] ?? "", /← Run: #21\s{2}run-20\s{2}done →/);
    overlay.handleInput("\u001b[C");
    assert.match(overlay.render(90)[1] ?? "", /Run: #20\s{2}run-19\s{2}done/);
    overlay.handleInput("\u001b[D");
    assert.match(overlay.render(90)[1] ?? "", /Run: #21\s{2}run-20\s{2}done/);
    overlay.handleInput("\r");
    lines = overlay.render(90);
    assert.equal(
      (lines[2] ?? "").indexOf("╭"),
      (lines[1] ?? "").indexOf("Run:") - 2,
    );
    for (let index = 0; index < 10; index += 1)
      overlay.handleInput("\u001b[B");
    lines = overlay.render(90);
    const output = lines.join("\n");
    assert.match(output, /╭↑/);
    assert.match(output, /╰↓/);
    assert.match(output, /▶ #11\s+run-10\s{2}done/);
    assert.equal(lines.length, 23);
    overlay.handleInput("\r");
    assert.match(overlay.render(90)[1] ?? "", /Run: #11\s{2}run-10\s{2}done/);
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector nested value menus scroll inside the available viewport", async () => {
  const { root, stateDir } = await fixture();
  const roster = Object.fromEntries([
    ["run:demo", { role: "run", status: "present" }],
    ...Array.from({ length: 24 }, (_, index) => [
      `branch:demo/member-${String(index + 1).padStart(2, "0")}`,
      {
        display: `Member ${String(index + 1).padStart(2, "0")}`,
        role: "reviewer",
        status: "active",
      },
    ]),
  ]);
  await writeFile(
    join(stateDir, "rooms", "main", "roster.json"),
    JSON.stringify(roster),
  );
  const { overlay } = createOverlay(root, theme, 20);
  try {
    overlay.handleInput("\u001b[C");
    overlay.handleInput("\r");
    overlay.handleInput("\u001b[B");
    overlay.handleInput("\u001b[B");
    overlay.handleInput("\r");
    for (let index = 0; index < 10; index += 1)
      overlay.handleInput("\u001b[B");
    const lines = overlay.render(90);
    const output = lines.join("\n");
    assert.match(output, /╭↑/);
    assert.match(output, /╰↓/);
    assert.match(output, /▶ Member 09/);
    assert.equal(lines.length, 18);
    for (const line of lines) assert.equal(visibleWidth(line), 90);
    overlay.handleInput("\r");
    assert.match(overlay.render(90).join("\n"), /Messages \(Member 09\)/);
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector overlay keeps even rows transparent and shades odd rows", async () => {
  const { root } = await fixture();
  const backgrounds: string[] = [];
  const recordingTheme = {
    bg: (color: string, text: string) => {
      backgrounds.push(color);
      return text;
    },
    fg: (_color: string, text: string) => text,
  } as unknown as Theme;
  const { overlay } = createOverlay(root, recordingTheme);
  try {
    overlay.handleInput("\u001b[C");
    overlay.render(72);
    assert.ok(backgrounds.includes("customMessageBg"));
    assert.equal(backgrounds.includes("toolPendingBg"), false);
    overlay.handleInput("\u001b[C");
    backgrounds.length = 0;
    overlay.render(72);
    assert.equal(
      backgrounds.includes("customMessageBg"),
      false,
      "empty viewport padding must not render as striped evidence rows",
    );
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector turn detail keeps wrapped visual rows on one logical stripe", async () => {
  const { root } = await fixture();
  const stripedTheme = {
    bg: (color: string, text: string) =>
      color === "customMessageBg"
        ? `\u001b[48;5;238m${text}\u001b[0m`
        : text,
    fg: (_color: string, text: string) => text,
  } as unknown as Theme;
  const { overlay } = createOverlay(root, stripedTheme);
  try {
    overlay.handleInput("\u001b[C");
    overlay.handleInput("\u001b[C");
    overlay.handleInput("\u001b[B");
    overlay.handleInput("\u001b[C");
    const wrappedPath = (
      overlay as unknown as {
        wrapDetailLines: (
          lines: string[],
          width: number,
        ) => { lines: string[] };
      }
    ).wrapDetailLines([`     sessions/${"x".repeat(48)}.jsonl`], 24).lines;
    assert.ok(wrappedPath.length > 1);
    assert.ok(wrappedPath.every((line) => line.trim().length > 0));
    assert.ok(wrappedPath.every((line) => visibleWidth(line) <= 24));
    const labeledPath = (
      overlay as unknown as {
        wrapDetailLines: (
          lines: string[],
          width: number,
        ) => { lines: string[] };
      }
    ).wrapDetailLines([
      "   file: /home/llb/.pi/agent/extensions/pi-actors/recipes/subagent-preflight.json",
    ], 48).lines;
    assert.match(labeledPath[0] ?? "", /^   file: \/home\/llb/);
    assert.notEqual(labeledPath[0]?.trim(), "file:");
    assert.match(labeledPath[1] ?? "", /^     /);
    const preferred = (
      overlay as unknown as {
        wrapPreferred(content: string, width: number): string[];
      }
    ).wrapPreferred("subagent-preflight+model=current", 12);
    assert.deepEqual(preferred.slice(0, 3), [
      "subagent",
      "-preflight",
      "+model",
    ]);
    const lines = overlay.render(24);
    assert.ok(lines.some((line) => line.includes("Subagent 1 (reviewer)")));
    const assistantIndex = lines.findIndex((line) => line.includes("Assistant"));
    const toolIndex = lines.findIndex((line) => line.includes("Tool 1"));
    assert.ok(assistantIndex >= 0);
    assert.ok(toolIndex > assistantIndex + 1);
    const assistantRows = lines.slice(assistantIndex, toolIndex);
    const striped = assistantRows[0]?.includes("\u001b[48;5;238m");
    assert.ok(assistantRows.every((line) =>
      line.includes("\u001b[48;5;238m") === striped
    ));
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector documents support page up and page down", async () => {
  const { root, stateDir } = await fixture();
  const run = JSON.parse(await readFile(join(stateDir, "run.json"), "utf8"));
  run.recipe_context_records[0].recipe.args = Array.from(
    { length: 40 },
    (_, index) => `argument_${String(index).padStart(2, "0")}:string`,
  );
  await writeFile(join(stateDir, "run.json"), JSON.stringify(run));
  const { overlay } = createOverlay(root, theme, 20);
  try {
    assert.match(overlay.render(90).join("\n"), /argument_00:string/);
    overlay.handleInput("\r");
    overlay.handleInput("\u001b[6~");
    let output = overlay.render(90).join("\n");
    assert.doesNotMatch(output, /argument_00:string/);
    assert.match(output, /argument_\d\d:string/);
    overlay.handleInput("\u001b[5~");
    output = overlay.render(90).join("\n");
    assert.match(output, /argument_00:string/);
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector recipe lists attach object content to the bullet", async () => {
  const { root } = await fixture();
  const { overlay } = createOverlay(root);
  try {
    const lines = (
      overlay as unknown as {
        readableValueLines(value: unknown, indent?: string): string[];
      }
    ).readableValueLines([
      {
        args: ["stage:string", "model:string"],
        template: [{ parallel: true, failure: "root" }],
      },
    ], "  ");
    assert.equal(lines.some((line) => line.trim() === "-"), false);
    assert.equal(lines[0], "  - args:");
    assert.ok(lines.some((line) => line.includes("- parallel: true")));
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector overlay keeps persisted multiline content inside one terminal row", async () => {
  const { root } = await fixture();
  const { overlay } = createOverlay(root);
  try {
    overlay.handleInput("\u001b[C");
    for (const key of ["\u001b[C", "\u001b[B"]) {
      overlay.handleInput(key);
      const lines = overlay.render(72);
      assert.equal(lines.length, 23);
      for (const line of lines) {
        assert.doesNotMatch(line, /[\r\n\t]/);
        assert.equal(visibleWidth(line), 72);
      }
    }
    const output = overlay.render(72).join("\n");
    assert.match(output, /Audit complete with/);
    assert.doesNotMatch(output, /▶\s{2,}\S/);
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector tabs and filters remain usable without owned runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-overlay-empty-"));
  const { overlay } = createOverlay(root);
  try {
    let output = overlay.render(72).join("\n");
    assert.match(output, /Run: none/);
    assert.match(output, /\[ Recipe \]/);
    overlay.handleInput("\u001b[C");
    assert.match(overlay.render(72).join("\n"), /\[ Messages \]/);
    overlay.handleInput("\r");
    output = overlay.render(72).join("\n");
    assert.match(output, /▶ Channel/);
    assert.match(output, /State/);
    overlay.handleInput("\u001b[C");
    assert.match(overlay.render(72).join("\n"), /▶ all/);
    overlay.handleInput("\u001b[D");
    assert.match(overlay.render(72).join("\n"), /▶ Channel: all/);
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector Kill requires confirmation and reports success", async () => {
  const { root, stateDir } = await fixture();
  await writeFile(join(stateDir, "progress.json"), JSON.stringify({ phase: "running" }));
  const killed: string[] = [];
  const { overlay } = createOverlay(root, theme, 30, (run) => {
    killed.push(run);
    return { ok: true, message: `Killed run:${run}.` };
  });
  try {
    overlay.handleInput("\u001b[A");
    assert.match(overlay.render(90).join("\n"), /k kill/);
    overlay.handleInput("k");
    let output = overlay.render(90).join("\n");
    assert.match(output, /Kill running actor run:demo\?/);
    assert.match(output, /canonical control\.kill/);
    assert.match(output, /y\/enter confirm kill/);
    assert.deepEqual(killed, []);

    overlay.handleInput("\r");
    output = overlay.render(90).join("\n");
    assert.deepEqual(killed, ["demo"]);
    assert.match(output, /Killed run:demo\./);
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector Kill cancellation never invokes control", async () => {
  const { root, stateDir } = await fixture();
  await writeFile(join(stateDir, "progress.json"), JSON.stringify({ phase: "running" }));
  let calls = 0;
  const { overlay } = createOverlay(root, theme, 30, () => {
    calls += 1;
    return { ok: true, message: "unexpected" };
  });
  try {
    overlay.handleInput("\u001b[A");
    overlay.handleInput("k");
    overlay.handleInput("\u001b");
    assert.equal(calls, 0);
    assert.match(overlay.render(90).join("\n"), /Kill cancelled\./);
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector disables Kill for terminal runs", async () => {
  const { root } = await fixture();
  let calls = 0;
  const { overlay } = createOverlay(root, theme, 30, () => {
    calls += 1;
    return { ok: true, message: "unexpected" };
  });
  try {
    overlay.handleInput("\u001b[A");
    assert.doesNotMatch(overlay.render(90).join("\n"), /k kill/);
    overlay.handleInput("k");
    assert.equal(calls, 0);
    assert.match(overlay.render(90).join("\n"), /Kill unavailable: run is done\./);
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector overlay closes with escape and bounds every line", async () => {
  const { root } = await fixture();
  const { overlay, closed } = createOverlay(root);
  try {
    for (const line of overlay.render(72)) assert.ok(visibleWidth(line) <= 72);
    overlay.handleInput("\u001b");
    assert.equal(closed(), true);
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
