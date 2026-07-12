import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";

import { ActorInspectorOverlay } from "../lib/inspector-overlay.ts";

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
    JSON.stringify({ ownerId: "owner", run: "demo" }),
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
            { type: "text", text: "Audit complete\nwithout escaping overlay" },
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

function createOverlay(root: string, overlayTheme: Theme = theme) {
  let closed = false;
  let renders = 0;
  const overlay = new ActorInspectorOverlay({
    done: () => {
      closed = true;
    },
    ownerId: "owner",
    stateRoot: root,
    theme: overlayTheme,
    tui: {
      requestRender: () => {
        renders += 1;
      },
    } as unknown as TUI,
  });
  return { overlay, closed: () => closed, renders: () => renders };
}

test("actor inspector overlay navigates run, nested filters, tabs, and detail", async () => {
  const { root } = await fixture();
  const { overlay, renders } = createOverlay(root);
  try {
    let output = overlay.render(90).join("\n");
    assert.match(output, /Run: demo · done/);
    assert.match(output, /\[ Messages \]/);
    const initialTabLine = output.split("\n").find((line) => line.includes("Messages")) ?? "";
    overlay.handleInput("\u001b[C");
    const switchedTabLine = overlay.render(90).find((line) => line.includes("Messages")) ?? "";
    assert.equal(switchedTabLine.indexOf("Messages"), initialTabLine.indexOf("Messages"));
    assert.equal(switchedTabLine.indexOf("Turns"), initialTabLine.indexOf("Turns"));
    overlay.handleInput("\u001b[D");
    overlay.handleInput("\u001b[A");
    output = overlay.render(90).join("\n");
    assert.match(output, /\[ Run: demo · done \]/);
    assert.doesNotMatch(output, /\[ Messages \]/);
    overlay.handleInput("\r");
    assert.match(overlay.render(90).join("\n"), /▶ demo · done/);
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
    assert.match(output, /command.*command-001.*reviewer/);
    assert.match(output, /reasoning.*persisted thinking block/);
    overlay.handleInput("\u001b[D");
    assert.ok(renders() >= 4);
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
    overlay.render(72);
    assert.ok(backgrounds.includes("customMessageBg"));
    assert.equal(backgrounds.includes("toolPendingBg"), false);
  } finally {
    overlay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("actor inspector overlay keeps persisted multiline content inside one terminal row", async () => {
  const { root } = await fixture();
  const { overlay } = createOverlay(root);
  try {
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
    assert.match(output, /Audit complete without/);
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
    assert.match(output, /\[ Messages \]/);
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
