import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  readActorInspectorPreviews,
  renderInspectorWidget,
} from "../lib/actor-inspector-tui.ts";

test("Actor inspector TUI reads room and direct previews", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-tui-"));
  try {
    const stateDir = join(root, "demo");
    await mkdir(join(stateDir, "rooms", "main"), { recursive: true });
    await writeFile(
      join(stateDir, "rooms", "main", "messages.jsonl"),
      `${JSON.stringify({
        body: "hello room",
        from: "branch:demo/a",
        received_at: "2026-01-01T00:00:00.000Z",
        to: "room:demo",
        type: "chat.message",
      })}\n`,
    );
    await writeFile(
      join(stateDir, "inbox.jsonl"),
      `${JSON.stringify({
        body: "private hello",
        from: "branch:demo/a",
        received_at: "2026-01-01T00:00:01.000Z",
        to: "branch:demo/b",
        type: "chat.message",
      })}\n`,
    );
    await writeFile(
      join(stateDir, "outbox.jsonl"),
      `${JSON.stringify({
        body: { ok: true },
        from: "run:demo",
        timestamp: "2026-01-01T00:00:02.000Z",
        to: "branch:demo/a",
        type: "checkpoint.ready",
      })}\n`,
    );

    const previews = readActorInspectorPreviews(root, 10);
    assert.equal(previews.length, 3);
    assert.equal(previews[0].channel, "room");
    assert.equal(previews[1].channel, "direct");
    assert.equal(previews[1].body_preview, "private hello");
    assert.equal(previews[2].channel, "direct");
    assert.equal(previews[2].body_preview, '{"ok":true}');

    const lines = renderInspectorWidget(previews, 80);
    assert.ok(lines);
    assert.notEqual(lines?.[0], "actors comms");
    assert.match(lines?.join("\n") ?? "", / 1  a # all\s+hello room\s*\n\s+chat\.message\s+hello room/);
    assert.match(lines?.join("\n") ?? "", / 3  demo → a\s+\{"ok":true\}\s*\n\s+checkpoint\.ready\s+\{"ok":true\}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor inspector TUI skips malformed JSONL preview lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-jsonl-"));
  try {
    const stateDir = join(root, "demo");
    await mkdir(join(stateDir, "rooms", "main"), { recursive: true });
    await writeFile(
      join(stateDir, "rooms", "main", "messages.jsonl"),
      [
        "{not-json",
        JSON.stringify({
          body: "after bad line",
          from: "branch:demo/a",
          received_at: "2026-01-01T00:00:00.000Z",
          to: "room:demo",
          type: "chat.message",
        }),
        "",
      ].join("\n"),
    );
    const previews = readActorInspectorPreviews(root, 10);
    assert.equal(previews.length, 1);
    assert.equal(previews[0].body_preview, "after bad line");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor inspector TUI filters previews by run owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-owner-"));
  try {
    const stateA = join(root, "owned-a");
    const stateB = join(root, "owned-b");
    await mkdir(join(stateA, "rooms", "main"), { recursive: true });
    await mkdir(join(stateB, "rooms", "main"), { recursive: true });
    await writeFile(
      join(stateA, "run.json"),
      JSON.stringify({ ownerId: "session-a", run: "owned-a" }),
    );
    await writeFile(
      join(stateB, "run.json"),
      JSON.stringify({ ownerId: "session-b", run: "owned-b" }),
    );
    await writeFile(
      join(stateA, "rooms", "main", "messages.jsonl"),
      `${JSON.stringify({
        body: "visible",
        from: "branch:owned-a/front",
        received_at: "2026-01-01T00:00:00.000Z",
        to: "room:owned-a",
        type: "task.claim",
      })}\n`,
    );
    await writeFile(
      join(stateB, "rooms", "main", "messages.jsonl"),
      `${JSON.stringify({
        body: "hidden",
        from: "branch:owned-b/back",
        received_at: "2026-01-01T00:00:01.000Z",
        to: "room:owned-b",
        type: "task.claim",
      })}\n`,
    );

    const previews = readActorInspectorPreviews(root, 10, {
      ownerId: "session-a",
    });
    assert.equal(previews.length, 1);
    assert.equal(previews[0].run, "owned-a");
    assert.equal(previews[0].body_preview, "visible");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor inspector TUI can scope previews to the current run and reset numbering", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-current-"));
  try {
    const oldState = join(root, "old-run");
    const currentState = join(root, "current-run");
    await mkdir(join(oldState, "rooms", "main"), { recursive: true });
    await mkdir(join(currentState, "rooms", "main"), { recursive: true });
    await writeFile(
      join(oldState, "rooms", "main", "messages.jsonl"),
      `${JSON.stringify({
        body: "old",
        from: "branch:old-run/a",
        received_at: "2026-01-01T00:00:00.000Z",
        to: "room:old-run",
        type: "task.result",
      })}\n`,
    );
    await writeFile(
      join(currentState, "rooms", "main", "messages.jsonl"),
      [
        JSON.stringify({
          body: "current first",
          from: "branch:current-run/a",
          received_at: "2026-01-01T00:00:01.000Z",
          to: "room:current-run",
          type: "task.claim",
        }),
        JSON.stringify({
          body: "current second",
          from: "branch:current-run/a",
          received_at: "2026-01-01T00:00:02.000Z",
          to: "room:current-run",
          type: "task.result",
        }),
        "",
      ].join("\n"),
    );

    const previews = readActorInspectorPreviews(root, 10, {
      currentRunOnly: true,
    });
    assert.deepEqual(
      previews.map((preview) => preview.run),
      ["current-run", "current-run"],
    );
    assert.deepEqual(
      previews.map((preview) => preview.sequence),
      [1, 2],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor inspector TUI renders compact two-line items", () => {
  const lines = renderInspectorWidget(
    [
      {
        body_preview: "one",
        channel: "direct",
        from: "branch:demo/a",
        run: "demo",
        timestamp: "2026-01-01T00:00:00.000Z",
        to: "branch:demo/b",
        type: "chat.message",
      },
      {
        body_preview: "two",
        channel: "room",
        from: "branch:demo/reviewer",
        run: "demo",
        timestamp: "2026-01-01T00:00:01.000Z",
        to: "room:demo",
        type: "actor.join",
      },
    ],
    100,
  );
  assert.ok(lines);
  assert.equal(lines?.length, 4);
  assert.match(lines?.[0] ?? "", /^ 1  a → b\s+one\s+$/);
  assert.match(lines?.[1] ?? "", /^    chat\.message\s+one\s+$/);
  assert.match(lines?.[2] ?? "", /^ 2  reviewer # all  two\s+$/);
  assert.match(lines?.[3] ?? "", /^    actor\.join\s+two\s+$/);
  assert.equal(lines?.some((line) => line.includes("|")), false);
});

test("Actor inspector TUI can stripe entries by historical order", () => {
  const lines = renderInspectorWidget(
    [
      {
        body_preview: "old",
        channel: "direct",
        from: "branch:demo/a",
        run: "demo",
        stripe: true,
        timestamp: "2026-01-01T00:00:00.000Z",
        to: "branch:demo/b",
        type: "chat.message",
      },
      {
        body_preview: "new",
        channel: "direct",
        from: "branch:demo/b",
        run: "demo",
        stripe: false,
        timestamp: "2026-01-01T00:00:01.000Z",
        to: "branch:demo/a",
        type: "chat.message",
      },
    ],
    80,
    {
      stripe: (text) => `<transparent>${text}</transparent>`,
      stripeAlt: (text) => `<dark>${text}</dark>`,
    },
  );
  assert.ok(lines);
  assert.match(lines?.[0] ?? "", /^<transparent>/);
  assert.match(lines?.[1] ?? "", /^<transparent>/);
  assert.match(lines?.[2] ?? "", /^<dark>/);
  assert.match(lines?.[3] ?? "", /^<dark>/);
});

test("Actor inspector TUI renders compact verbosity as twelve minimally aligned one-line items", () => {
  const previews = Array.from({ length: 14 }, (_, index) => ({
    body_preview: `body ${index}`,
    channel: "direct" as const,
    from: `branch:demo/a${index}`,
    run: "demo",
    summary: `summary ${index}`,
    timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    to: "branch:demo/reviewer",
    type: "chat.message",
  }));
  const lines = renderInspectorWidget(previews, 80, {}, { verbosity: "compact" });
  assert.ok(lines);
  assert.equal(lines?.length, 12);
  assert.match(lines?.[0] ?? "", /a2 → reviewer   chat\.message  summary 2/);
  assert.match(lines?.[11] ?? "", /a13 → reviewer  chat\.message  summary 13/);
});

test("Actor inspector TUI can style semantic segments", () => {
  const lines = renderInspectorWidget(
    [
      {
        summary: "Human summary",
        body_preview: "hello",
        channel: "direct",
        from: "branch:demo/a",
        run: "demo",
        timestamp: "2026-01-01T00:00:00.000Z",
        to: "branch:demo/b",
        type: "chat.message",
      },
    ],
    80,
    {
      actor: (text) => `<a>${text}</a>`,
      target: (text) => `<t>${text}</t>`,
      type: (text) => `<y>${text}</y>`,
    },
  );
  assert.match(lines?.join("\n") ?? "", / <t>a → b<\/t>\s+Human summary/);
  assert.match(lines?.join("\n") ?? "", /<y>chat\.message<\/y>  hello/);
  assert.match(lines?.join("\n") ?? "", /Human summary/);
});

test("Actor inspector TUI uses available width for long body previews", () => {
  const narrow = renderInspectorWidget(
    [
      {
        body_preview: "x".repeat(220),
        channel: "room",
        from: "branch:demo/a",
        run: "demo",
        timestamp: "2026-01-01T00:00:00.000Z",
        to: "room:demo",
        type: "chat.message",
      },
    ],
    48,
  );
  const wide = renderInspectorWidget(
    [
      {
        body_preview: "x".repeat(220),
        channel: "room",
        from: "branch:demo/a",
        run: "demo",
        timestamp: "2026-01-01T00:00:00.000Z",
        to: "room:demo",
        type: "chat.message",
      },
    ],
    120,
  );
  assert.ok(narrow);
  assert.ok(wide);
  assert.ok((wide?.[1].match(/x/g)?.length ?? 0) > (narrow?.[1].match(/x/g)?.length ?? 0));
  assert.equal(wide?.[1].length, 120);
});

test("Actor inspector TUI renders requested route summary type body layout", () => {
  const lines = renderInspectorWidget(
    [
      {
        summary: "No immediate patch needed",
        body_preview: "No code patch needed from this drill unless narrow terminal truncation reveals a new problem.",
        channel: "direct",
        from: "branch:demo/implementer",
        run: "demo",
        timestamp: "2026-01-01T00:00:00.000Z",
        to: "branch:demo/reviewer",
        type: "fix.response",
      },
    ],
    140,
  );
  assert.equal(lines?.[0].trimEnd(), " 1  implementer → reviewer  No immediate patch needed");
  assert.equal(
    lines?.[1].trimEnd(),
    "    fix.response            No code patch needed from this drill unless narrow terminal truncation reveals a new problem.",
  );
});

test("Actor inspector TUI keeps type body separator muted when truncated", () => {
  const lines = renderInspectorWidget(
    [
      {
        summary: "s".repeat(28),
        body_preview: "b".repeat(80),
        channel: "direct",
        from: "branch:demo/a",
        run: "demo",
        timestamp: "2026-01-01T00:00:00.000Z",
        to: "branch:demo/b",
        type: "chat.message",
      },
    ],
    72,
    {
      muted: (text) => `<m>${text}</m>`,
      preview: (text) => `<p>${text}</p>`,
      type: (text) => `<y>${text}</y>`,
    },
  );
  assert.match(lines?.[1] ?? "", /<y>chat\.message<\/y>  <p>/);
});

test("Actor inspector TUI bounds wide glyph display width", () => {
  const lines = renderInspectorWidget(
    [
      {
        body_preview: "emoji 😀😀😀😀😀😀😀😀 tail",
        channel: "direct",
        from: "branch:demo/a",
        run: "demo",
        timestamp: "2026-01-01T00:00:00.000Z",
        to: "branch:demo/b",
        type: "chat.message",
      },
    ],
    30,
    { preview: (text) => `\u001b[33m${text}\u001b[0m` },
  );
  const cellWidth = (value: string) => Array.from(
    value.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""),
  ).reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) >= 0x1f300 ? 2 : 1), 0);
  assert.ok(lines);
  assert.equal(lines?.every((line) => cellWidth(line) <= 30), true);
  assert.equal(lines?.some((line) => line.includes("…")), true);
});

test("Actor inspector TUI respects render widths below 32 columns", () => {
  const lines = renderInspectorWidget(
    [
      {
        body_preview: "tiny terminal body",
        channel: "direct",
        from: "branch:demo/a",
        run: "demo",
        timestamp: "2026-01-01T00:00:00.000Z",
        to: "branch:demo/b",
        type: "chat.message",
      },
    ],
    20,
  );
  assert.ok(lines);
  assert.equal(lines?.every((line) => line.length <= 20), true);
});

test("Actor inspector TUI keeps widget lines bounded", () => {
  const lines = renderInspectorWidget(
    [
      {
        body_preview: "x".repeat(120),
        channel: "room",
        from: "branch:demo/very-long-sender-name",
        run: "demo",
        timestamp: "2026-01-01T00:00:00.000Z",
        to: "room:demo-with-a-very-long-name",
        type: "chat.message.with.long.type",
      },
    ],
    48,
  );
  assert.ok(lines);
  for (const line of lines ?? []) assert.ok(line.length <= 48);
});

test("Actor inspector TUI hides empty widgets", () => {
  assert.equal(renderInspectorWidget([]), undefined);
});
