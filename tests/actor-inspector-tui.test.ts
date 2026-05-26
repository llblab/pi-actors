import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  inspectorPreviewReadKey,
  readActorInspectorPreviews,
  readActorInspectorRoster,
  renderInspectorItemView,
  renderInspectorRosterLine,
  renderInspectorRosterPanel,
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
    assert.match(lines?.join("\n") ?? "", / a # all\s+chat\.message\s+hello room/);
    assert.match(lines?.join("\n") ?? "", / demo → a\s+checkpoint\.ready\s+\{"ok":true\}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor inspector TUI renders roster panel summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-roster-"));
  try {
    const stateDir = join(root, "demo");
    await mkdir(join(stateDir, "rooms", "main"), { recursive: true });
    await writeFile(
      join(stateDir, "rooms", "main", "roster.json"),
      JSON.stringify({
        "branch:demo/builder": {
          address: "branch:demo/builder",
          display: "Builder",
          joined_at: "2026-01-01T00:00:00.000Z",
          last_seen: "2026-01-01T00:00:00.000Z",
          role: "implementer",
          status: "present",
        },
        "branch:demo/reviewer": {
          address: "branch:demo/reviewer",
          joined_at: "2026-01-01T00:00:00.000Z",
          last_seen: "2026-01-01T00:00:00.000Z",
          role: "Review Lens",
          status: "present",
        },
      }),
    );
    const members = readActorInspectorRoster(root, "demo");
    assert.equal(members.length, 2);
    const line = renderInspectorRosterLine(members, 48);
    assert.match(line ?? "", /roster 2: Builder\/implementer/);
    assert.equal(line?.startsWith(" "), true);
    assert.equal(line?.endsWith(" "), true);
    assert.equal(visibleWidth(line ?? ""), 48);
    const panel = renderInspectorRosterPanel(members, 120);
    assert.equal(panel?.length, 1);
    assert.match(panel?.[0] ?? "", /roster 2: Builder\/implementer, reviewer\/review-lens/);
    assert.equal(panel?.[0]?.startsWith(" "), true);
    assert.equal(panel?.[0]?.endsWith(" "), true);
    assert.equal(panel?.every((item) => visibleWidth(item) <= 120), true);
    const roleSummary = renderInspectorRosterPanel(
      [
        {
          address: "branch:demo/writer",
          display: "writer",
          role: "software implementer; writes the clean, robust Python timer script",
          status: "present",
        },
      ],
      120,
    );
    assert.match(roleSummary?.[0] ?? "", /writer\/software-implementer/);
    assert.doesNotMatch(roleSummary?.[0] ?? "", /writes-the-clean/);
    const runSummary = renderInspectorRosterPanel(
      [
        {
          address: "run:demo",
          role: "run",
          status: "present",
        },
      ],
      120,
    );
    assert.match(runSummary?.[0] ?? "", /run\/demo/);
    const styled = renderInspectorRosterPanel(
      [members[0], { ...members[1], status: "left" }],
      120,
      { muted: (text) => `<muted>${text}</muted>`, target: (text) => `<target>${text}</target>` },
    );
    assert.match(styled?.[0] ?? "", /<target>Builder\/implementer<\/target>/);
    assert.match(styled?.[0] ?? "", /<muted>reviewer\/review-lens<\/muted>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor inspector TUI renders room display names from roster", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-display-"));
  try {
    const stateDir = join(root, "demo");
    await mkdir(join(stateDir, "rooms", "main"), { recursive: true });
    await writeFile(
      join(stateDir, "rooms", "main", "roster.json"),
      JSON.stringify({
        "branch:demo/mapper": {
          address: "branch:demo/mapper",
          display: "mapper",
          joined_at: "2026-01-01T00:00:00.000Z",
          last_seen: "2026-01-01T00:00:00.000Z",
          role: "systems mapper",
          status: "present",
        },
      }),
    );
    await writeFile(
      join(stateDir, "rooms", "main", "messages.jsonl"),
      `${JSON.stringify({
        body: "mapped",
        from: "branch:demo/mapper",
        received_at: "2026-01-01T00:00:00.000Z",
        to: "room:demo",
        type: "chat.message",
      })}\n`,
    );
    const lines = renderInspectorWidget(readActorInspectorPreviews(root, 10), 80);
    assert.match(lines?.join("\n") ?? "", /mapper # all\s+chat\.message\s+mapped/);
    assert.equal(lines?.every((line) => visibleWidth(line) <= 80), true);
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

test("Actor inspector TUI keeps noisy room previews bounded per run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-bounded-room-"));
  try {
    const stateDir = join(root, "demo");
    await mkdir(join(stateDir, "rooms", "main"), { recursive: true });
    await writeFile(
      join(stateDir, "rooms", "main", "messages.jsonl"),
      Array.from({ length: 5 }, (_, index) =>
        JSON.stringify({
          body: `room ${index + 1}`,
          from: "branch:demo/noisy",
          received_at: `2026-01-01T00:00:0${index}.000Z`,
          to: "room:demo",
          type: "chat.message",
        }),
      ).join("\n") + "\n",
    );
    await writeFile(
      join(stateDir, "inbox.jsonl"),
      `${JSON.stringify({
        body: "private",
        from: "branch:demo/a",
        received_at: "2026-01-01T00:00:05.000Z",
        to: "branch:demo/b",
        type: "chat.message",
      })}\n`,
    );

    const previews = readActorInspectorPreviews(root, 10, {
      roomLimitPerRun: 2,
    });
    assert.deepEqual(
      previews.map((preview) => preview.body_preview),
      ["room 4", "room 5", "private"],
    );
    assert.deepEqual(
      previews.map((preview) => preview.sequence),
      [4, 5, 6],
    );
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

test("Actor inspector TUI filters previews by channel and mention", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-filter-"));
  try {
    const stateDir = join(root, "demo");
    await mkdir(join(stateDir, "rooms", "main"), { recursive: true });
    await writeFile(
      join(stateDir, "rooms", "main", "messages.jsonl"),
      `${JSON.stringify({
        body: "room alpha",
        from: "branch:demo/a",
        received_at: "2026-01-01T00:00:00.000Z",
        to: "room:demo",
        type: "chat.message",
      })}\n`,
    );
    await writeFile(
      join(stateDir, "inbox.jsonl"),
      `${JSON.stringify({
        body: "private beta",
        from: "branch:demo/a",
        id: "evt-beta",
        metadata: { requires_response: true },
        received_at: "2026-01-01T00:00:01.000Z",
        to: "branch:demo/b",
        type: "chat.message",
      })}\n`,
    );
    const room = readActorInspectorPreviews(root, 10, { channels: ["room"] });
    assert.equal(room.length, 1);
    assert.equal(room[0].body_preview, "room alpha");
    const mention = readActorInspectorPreviews(root, 10, { mention: "beta" });
    assert.equal(mention.length, 1);
    assert.equal(mention[0].channel, "direct");
    assert.equal(mention[0].event_id, "evt-beta");
    assert.equal(mention[0].needs_response, true);
    assert.match(renderInspectorWidget(mention, 80)?.[0] ?? "", /! a → b/);
    assert.match(renderInspectorItemView(mention, 80, {}, { sequence: 1 })?.join("\n") ?? "", /needs_response\s+true/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor inspector TUI reads branch inbox previews and filters unread branch work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspector-branch-inbox-"));
  try {
    const stateDir = join(root, "demo");
    await mkdir(join(stateDir, "branches", "front"), { recursive: true });
    await mkdir(join(stateDir, "branches", "back"), { recursive: true });
    await writeFile(
      join(stateDir, "branches", "front", "inbox.jsonl"),
      [
        JSON.stringify({
          body: "front queued",
          from: "branch:demo/back",
          id: "front-1",
          queued_at: "2026-01-01T00:00:00.000Z",
          status: "queued",
          to: "branch:demo/front",
          type: "task.assign",
        }),
        JSON.stringify({
          body: "front handled",
          from: "branch:demo/back",
          id: "front-2",
          queued_at: "2026-01-01T00:00:01.000Z",
          status: "handled",
          to: "branch:demo/front",
          type: "task.assign",
        }),
      ].join("\n"),
    );
    await writeFile(
      join(stateDir, "branches", "back", "inbox.jsonl"),
      `${JSON.stringify({
        body: "back queued",
        from: "branch:demo/front",
        id: "back-1",
        queued_at: "2026-01-01T00:00:02.000Z",
        status: "queued",
        to: "branch:demo/back",
        type: "task.assign",
      })}\n`,
    );
    const previews = readActorInspectorPreviews(root, 10);
    assert.equal(previews.filter((preview) => preview.branch).length, 3);
    assert.deepEqual(
      readActorInspectorPreviews(root, 10, { branch: "front", unreadOnly: true }).map(
        (preview) => [preview.branch, preview.message_id, preview.body_preview],
      ),
      [["front", "front-1", "front queued"]],
    );
    assert.deepEqual(
      readActorInspectorPreviews(root, 10, { unreadOnly: true }).map(
        (preview) => preview.message_id,
      ),
      ["front-1", "back-1"],
    );
    const firstUnread = readActorInspectorPreviews(root, 10, { unreadOnly: true })[0];
    assert.deepEqual(
      readActorInspectorPreviews(root, 10, {
        readKeys: [inspectorPreviewReadKey(firstUnread)],
        unreadOnly: true,
      }).map((preview) => preview.message_id),
      ["back-1"],
    );
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

test("Actor inspector TUI renders default one-line items", () => {
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
  assert.equal(lines?.length, 2);
  assert.match(lines?.[0] ?? "", /^ 1  a → b\s+chat\.message\s+one\s+$/);
  assert.match(lines?.[1] ?? "", /^ 2  reviewer # all\s+actor\.join\s+two\s+$/);
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
        timestamp: "2026-01-01T00:00:00.000Z",
        to: "branch:demo/b",
        type: "chat.message",
      },
      {
        body_preview: "new",
        channel: "direct",
        from: "branch:demo/b",
        run: "demo",
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
  assert.match(lines?.[0] ?? "", /^<dark>/);
  assert.match(lines?.[1] ?? "", /^<transparent>/);
});

test("Actor inspector TUI renders all supplied minimally aligned one-line items", () => {
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
  const lines = renderInspectorWidget(previews, 80);
  assert.ok(lines);
  assert.equal(lines?.length, 14);
  assert.match(lines?.[0] ?? "", /a0 → reviewer\s+chat\.message\s+summary 0\s+body 0/);
  assert.match(lines?.[13] ?? "", /a13 → reviewer\s+chat\.message\s+summary 13\s+body 13/);
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
  assert.match(lines?.join("\n") ?? "", / <t>a → b<\/t>\s+<y>chat\.message<\/y>\s+Human summary\s+hello/);
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
  assert.ok((wide?.[0].match(/x/g)?.length ?? 0) > (narrow?.[0].match(/x/g)?.length ?? 0));
  assert.equal(wide?.[0].length, 120);
});

test("Actor inspector TUI renders requested route summary body layout", () => {
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
  assert.match(
    lines?.[0].trimEnd() ?? "",
    /^ 1  implementer → reviewer  fix\.response  No immediate patch needed  No code patch needed from this drill unless narrow terminal truncatio…$/,
  );
});

test("Actor inspector TUI keeps summary body separator when truncated", () => {
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
  assert.match(lines?.[0] ?? "", /<p>ssss/);
  assert.match(lines?.[0] ?? "", /<p>bbbb/);
});

test("Actor inspector TUI bounds wide preview display width", () => {
  const lines = renderInspectorWidget(
    [
      {
        body_preview: "wide 漢字漢字漢字漢字 tail",
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
  assert.ok(lines);
  assert.equal(lines?.every((line) => visibleWidth(line) <= 30), true);
  assert.equal(lines?.some((line) => line.includes("…")), true);
});

test("Actor inspector TUI keeps columns stable when summary consumes width", () => {
  const lines = renderInspectorWidget(
    [
      {
        summary: "summary ".repeat(40),
        body_preview: "body should not steal formatting",
        channel: "direct",
        from: "branch:demo/very-long-sender-name-that-should-be-bounded",
        run: "demo",
        timestamp: "2026-01-01T00:00:00.000Z",
        to: "branch:demo/very-long-recipient-name-that-should-be-bounded",
        type: "chat.message.with.long.type.name",
      },
    ],
    64,
    {
      muted: (text) => `\u001b[2m${text}\u001b[22m`,
      preview: (text) => `\u001b[33m${text}\u001b[39m`,
      target: (text) => `\u001b[32m${text}\u001b[39m`,
      type: (text) => `\u001b[35m${text}\u001b[39m`,
    },
  );
  assert.ok(lines);
  assert.equal(lines?.every((line) => visibleWidth(line) <= 64), true);
  assert.match(lines?.[0] ?? "", /\u001b\[32m.*…\u001b\[39m/);
  assert.match(lines?.[0] ?? "", /\u001b\[35m.*…\u001b\[39m/);
  assert.doesNotMatch(lines?.[0] ?? "", /^\u001b\[33m 1/);
});

test("Actor inspector TUI lets body occupy summary space when summary is absent", () => {
  const lines = renderInspectorWidget(
    [
      {
        body_preview: "body starts where summary would be",
        channel: "direct",
        from: "branch:demo/a",
        run: "demo",
        timestamp: "2026-01-01T00:00:00.000Z",
        to: "branch:demo/b",
        type: "chat.message",
      },
      {
        summary: "Summary column",
        body_preview: "aligned body column",
        channel: "direct",
        from: "branch:demo/a",
        run: "demo",
        timestamp: "2026-01-01T00:00:01.000Z",
        to: "branch:demo/b",
        type: "chat.message",
      },
    ],
    96,
  );
  assert.ok(lines);
  assert.match(lines?.[0] ?? "", /chat\.message\s+body starts where summary would be/);
  assert.match(lines?.[1] ?? "", /chat\.message\s+Summary column\s+aligned body column/);
});

test("Actor inspector TUI keeps styled wide-character lines within terminal width", () => {
  const lines = renderInspectorWidget(
    [
      {
        body_preview: "Cinder here. Round 1/4 — my spark is already in the shared fire. Waiting for your shapes, swarm!",
        channel: "room",
        from: "branch:deepseek-swarm/cinder",
        run: "deepseek-swarm",
        timestamp: "2026-05-23T01:08:14.000Z",
        to: "room:deepseek-swarm",
        type: "chat.message",
      },
    ],
    134,
    {
      muted: (text) => `\u001b[38;2;146;131;116m${text}\u001b[39m`,
      preview: (text) => `\u001b[38;2;235;219;178m${text}\u001b[39m`,
      stripe: (text) => `\u001b[48;2;60;56;54m${text}\u001b[49m`,
      target: (text) => `\u001b[38;2;184;187;38m${text}\u001b[39m`,
      type: (text) => `\u001b[38;2;250;189;47m${text}\u001b[39m`,
    },
  );
  assert.ok(lines);
  assert.equal(lines?.every((line) => visibleWidth(line) <= 134), true);
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

test("Actor inspector TUI renders selected item view", () => {
  const lines = renderInspectorItemView(
    [
      {
        body_preview: "full-ish selected body",
        channel: "room",
        from: "branch:demo/mapper",
        run: "demo",
        sequence: 7,
        summary: "Selected summary",
        timestamp: "2026-01-01T00:00:00.000Z",
        to: "room:demo",
        type: "chat.message",
      },
    ],
    80,
    {},
    { sequence: 7 },
  );
  assert.ok(lines);
  assert.equal(lines?.[1], "");
  assert.equal(lines?.filter(Boolean).every((line) => line.startsWith(" ") && line.endsWith(" ")), true);
  assert.equal(lines?.filter(Boolean).every((line) => visibleWidth(line) === 80), true);
  assert.match(lines?.[0] ?? "", /^ 7\s+mapper # all/);
  assert.doesNotMatch(lines?.join("\n") ?? "", /sequence\s+7/);
  assert.match(lines?.join("\n") ?? "", /type\s+chat\.message/);
  assert.match(lines?.join("\n") ?? "", /summary\s+Selected summary/);
  assert.match(lines?.join("\n") ?? "", /body\s+full-ish selected body/);
  assert.doesNotMatch(lines?.join("\n") ?? "", /body_preview/);
  assert.match(lines?.join("\n") ?? "", /timestamp\s+2026-01-01T00:00:00\.000Z/);
});

test("Actor inspector TUI hides empty widgets", () => {
  assert.equal(renderInspectorWidget([]), undefined);
});
