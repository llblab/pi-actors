/**
 * Pi-facing tool definition tests
 * Covers schema generation without relying on external schema-builder resolution
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RegisteredTool } from "../lib/config.ts";
import { cancelRun, startRun } from "../lib/async-runs.ts";
import {
  createActorMessageToolDefinition,
  createInspectToolDefinition,
  createRegisterToolDefinition,
  createRuntimeToolDefinition,
  createSpawnToolDefinition,
} from "../lib/tools.ts";

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`file did not appear: ${path}`);
}

function createRegistryDeps() {
  return {
    configPath: "/tmp/legacy-tool-registry.json",
    getActiveTools: () => [],
    getExternalToolConflict: () => undefined,
    getTools: () => new Map<string, RegisteredTool>(),
    notify: () => undefined,
    registerRuntimeTool: () => undefined,
    reservedToolNames: new Set<string>(),
    setActiveTools: () => undefined,
  };
}

test("Register tool definition exposes a JSON schema with no required fields", () => {
  const definition = createRegisterToolDefinition(createRegistryDeps());
  assert.equal(definition.name, "register_tool");
  assert.deepEqual(definition.parameters.required, []);
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.name.type, "string");
  assert.equal(properties.async.type, "boolean");
  assert.equal(properties.state_dir.type, "string");
  assert.equal(properties.values.type, "object");
  assert.equal(properties.update.type, "boolean");
  assert.equal(Array.isArray(properties.template.anyOf), true);
});

test("Spawn tool definition exposes actor creation schema", () => {
  const definition = createSpawnToolDefinition();
  assert.equal(definition.name, "spawn");
  assert.deepEqual(definition.parameters.required, []);
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.artifacts.type, "object");
  assert.equal(properties.as.type, "string");
  assert.equal(properties.recipe.type, "string");
  assert.equal(properties.file.type, "string");
  assert.equal(properties.state_dir.type, "string");
  assert.equal(Array.isArray(properties.template.anyOf), true);
  assert.equal(
    properties.template.anyOf.some((item: any) => item.type === "object"),
    true,
  );
  assert.equal(properties.values.type, "object");
});

test("Inspect tool definition exposes intentional observation schema", () => {
  const definition = createInspectToolDefinition();
  assert.equal(definition.name, "inspect");
  assert.deepEqual(definition.parameters.required, ["target", "view"]);
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.target.type, "string");
  assert.equal(properties.view.type, "string");
  assert.equal(properties.lines.type, "string");
  assert.equal(properties.status.type, "string");
  assert.match(properties.view.description, /messages/);
});

test("Inspect tool reads recipe registry summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inspect-recipes-"));
  try {
    const userRecipes = join(root, "recipes");
    const packagedRecipes = join(root, "packaged");
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(userRecipes, { recursive: true }),
        fs.mkdir(packagedRecipes, { recursive: true }),
      ]),
    );
    await writeFile(
      join(userRecipes, "user-tool.json"),
      JSON.stringify({ description: "User", template: "echo user" }),
    );
    await writeFile(join(userRecipes, "broken.json"), JSON.stringify({}));
    await writeFile(
      join(packagedRecipes, "stdlib.json"),
      JSON.stringify({ description: "Stdlib", template: "echo stdlib" }),
    );

    const definition = createInspectToolDefinition({
      packagedRecipeRoot: packagedRecipes,
      recipeRoot: userRecipes,
    });
    const result = await definition.execute(
      "call-inspect-recipes",
      { target: "recipes", view: "status" },
      undefined,
      undefined,
      undefined,
    );

    assert.match(result.content[0].text, /recipes active=3/);
    assert.match(result.content[0].text, /invalid=1/);
    assert.equal((result.details.active as unknown[]).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor message tool definition exposes concentrated message schema", () => {
  const definition = createActorMessageToolDefinition();
  assert.equal(definition.name, "message");
  assert.deepEqual(definition.parameters.required, ["to", "type"]);
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.to.type, "string");
  assert.equal(properties.type.type, "string");
  assert.equal(Array.isArray(properties.body.anyOf), true);
  assert.equal(properties.reply_to.type, "string");
  assert.equal(properties.correlation_id.type, "string");
});

test(
  "Actor message tool routes branch envelopes through parent run mailboxes",
  { skip: process.platform === "win32" },
  async () => {
    const definition = createActorMessageToolDefinition();
    const root = await mkdtemp(join(tmpdir(), "pi-actors-message-"));
    let stateDir = "";
    const readyFile = join(root, "ready");
    const messageFile = join(root, "message");
    const runId = `parent-${process.pid}-${Date.now()}`;
    const script =
      'mkfifo "$1/control.fifo"; printf ready >"$2"; IFS= read -r message <"$1/control.fifo"; printf %s "$message" >"$3"';
    try {
      const meta = startRun(
        {
          run_id: runId,
          template: "bash -lc {script} -- {state_dir} {readyFile} {messageFile}",
          values: { messageFile, readyFile, script },
        },
        process.cwd(),
      );
      stateDir = meta.state_dir;
      await waitForFile(readyFile);
      const result = await definition.execute(
        "call-branch-message",
        {
          body: { decision: "approve" },
          from: `branch:${runId}/builder-a`,
          to: `branch:${runId}/reviewer-a`,
          type: "control.approve",
        },
        undefined,
        undefined,
        undefined,
      );
      assert.match(result.content[0].text, new RegExp(`to=branch:${runId}/reviewer-a`));
      assert.match(result.content[0].text, /message=sent/);
      await waitForFile(messageFile);
      const envelope = JSON.parse(await readFile(messageFile, "utf8"));
      assert.equal(envelope.from, `branch:${runId}/builder-a`);
      assert.equal(envelope.to, `branch:${runId}/reviewer-a`);
      assert.equal(envelope.type, "control.approve");
      assert.deepEqual(envelope.body, { decision: "approve" });
      const roster = JSON.parse(
        await readFile(join(stateDir, "rooms", "main", "roster.json"), "utf8"),
      );
      assert.equal(roster[`branch:${runId}/reviewer-a`].role, "branch");
      assert.equal(roster[`branch:${runId}/reviewer-a`].parent, `run:${runId}`);
      assert.equal(roster[`branch:${runId}/builder-a`].role, "branch");
      assert.equal(roster[`branch:${runId}/builder-a`].parent, `run:${runId}`);
      const snapshot = JSON.parse(
        await readFile(join(stateDir, "communication.json"), "utf8"),
      );
      assert.equal(
        snapshot.rooms[0].members.some(
          (member: Record<string, unknown>) =>
            member.address === `branch:${runId}/reviewer-a`,
        ),
        true,
      );
      assert.equal(
        snapshot.rooms[0].members.some(
          (member: Record<string, unknown>) =>
            member.address === `branch:${runId}/builder-a`,
        ),
        true,
      );
      const senderSnapshot = JSON.parse(
        await readFile(join(stateDir, "branches", "builder-a", "communication.json"), "utf8"),
      );
      assert.equal(senderSnapshot.self, `branch:${runId}/builder-a`);
      const recipientSnapshot = JSON.parse(
        await readFile(join(stateDir, "branches", "reviewer-a", "communication.json"), "utf8"),
      );
      assert.equal(recipientSnapshot.self, `branch:${runId}/reviewer-a`);
      const branchInbox = JSON.parse(
        (await readFile(join(stateDir, "branches", "reviewer-a", "inbox.jsonl"), "utf8")).trim(),
      );
      assert.equal(branchInbox.to, `branch:${runId}/reviewer-a`);
      assert.equal(branchInbox.status, "queued");
      assert.match(branchInbox.queued_at, /\d{4}-\d{2}-\d{2}T/);
      const inspect = createInspectToolDefinition();
      const inspected = await inspect.execute(
        "call-branch-mailbox",
        { target: `branch:${runId}/reviewer-a`, view: "mailbox" },
        undefined,
        undefined,
        undefined,
      );
      assert.match(inspected.content[0].text, /id=[0-9a-f-]+/);
      assert.match(inspected.content[0].text, /status=queued/);
      assert.match(inspected.content[0].text, /type=control\.approve/);
      assert.equal(inspected.details.messages.length, 1);
      await waitForFile(join(stateDir, "result.json"));
    } finally {
      if (stateDir) await rm(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  },
);

test("Actor message and inspect tools support room timelines and rosters", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-room-"));
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: "room-run",
        template: "true",
      },
      process.cwd(),
    );
    const run = String(meta.run);
    stateDir = meta.state_dir;
    const messageTool = createActorMessageToolDefinition();
    const inspectTool = createInspectToolDefinition();
    const joinResult = await messageTool.execute(
      "call-room-join",
      {
        body: { caps: ["review"], claim: "Check risks", role: "reviewer" },
        from: `branch:${run}/reviewer`,
        summary: "Reviewer joined",
        to: `room:${run}`,
        type: "actor.join",
      },
      undefined,
      undefined,
      undefined,
    );
    assert.match(joinResult.content[0].text, new RegExp(`to=room:${run}`));
    assert.match(joinResult.content[0].text, /message=sent/);
    assert.match(joinResult.content[0].text, /room=main/);
    assert.match(joinResult.content[0].text, /roster=1/);

    const rosterResult = await inspectTool.execute(
      "call-room-roster",
      { target: `room:${run}`, view: "roster" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(
      rosterResult.content[0].text,
      new RegExp(`address=branch:${run}/reviewer`),
    );
    assert.match(rosterResult.content[0].text, /role=reviewer/);
    assert.match(rosterResult.content[0].text, /caps=review/);
    assert.match(rosterResult.content[0].text, /claim=Check_risks/);
    assert.equal(
      rosterResult.details.roster[`branch:${run}/reviewer`].role,
      "reviewer",
    );

    const contactsResult = await inspectTool.execute(
      "call-room-contacts",
      { target: `room:${run}`, view: "contacts" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(
      contactsResult.content[0].text,
      new RegExp(`address=branch:${run}/reviewer`),
    );
    assert.equal(contactsResult.details.contacts[0].address, `branch:${run}/reviewer`);

    await messageTool.execute(
      "call-room-message",
      {
        body: "hello",
        from: `branch:${run}/builder`,
        to: `room:${run}`,
        type: "chat.message",
      },
      undefined,
      undefined,
      undefined,
    );
    const updatedRoster = await inspectTool.execute(
      "call-room-updated-roster",
      { target: `room:${run}`, view: "roster" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(
      updatedRoster.details.roster[`branch:${run}/builder`].role,
      "actor",
    );

    const leaveResult = await messageTool.execute(
      "call-room-leave",
      {
        from: `branch:${run}/builder`,
        summary: "Builder left",
        to: `room:${run}`,
        type: "actor.leave",
      },
      undefined,
      undefined,
      undefined,
    );
    assert.match(leaveResult.content[0].text, /roster=2/);
    const finalRoster = await inspectTool.execute(
      "call-room-final-roster",
      { target: `room:${run}`, view: "roster" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(finalRoster.details.roster[`branch:${run}/builder`].status, "left");

    const statusResult = await inspectTool.execute(
      "call-room-status",
      { target: `room:${run}`, view: "status" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(statusResult.content[0].text, /room=main/);
    assert.match(statusResult.content[0].text, /roster=2/);
    assert.match(statusResult.content[0].text, /last_message_at=\d{4}-\d{2}-\d{2}T/);
    assert.match(statusResult.content[0].text, new RegExp(`last_from=branch:${run}/builder`));
    assert.match(statusResult.content[0].text, /last_type=actor.leave/);
    assert.match(statusResult.content[0].text, /last_summary=Builder_left/);

    const communication = await inspectTool.execute(
      "call-room-branch-communication",
      { target: `run:${run}`, view: "communication" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(communication.details.communication.self, `run:${run}`);
    assert.equal(communication.details.communication.parent, undefined);
    assert.equal(communication.details.communication.contacts[0].address, `branch:${run}/reviewer`);

    const previewsResult = await inspectTool.execute(
      "call-room-previews",
      { target: `room:${run}`, view: "previews" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(previewsResult.content[0].text, /ts=\d{4}-\d{2}-\d{2}T/);
    assert.match(previewsResult.content[0].text, /type=chat.message/);
    assert.equal(previewsResult.details.previews[1].body_preview, "hello");

    const messagesResult = await inspectTool.execute(
      "call-room-messages",
      { target: `room:${run}`, view: "messages" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(messagesResult.content[0].text, /ts=\d{4}-\d{2}-\d{2}T/);
    assert.match(messagesResult.content[0].text, /type=actor.join/);
    assert.match(messagesResult.content[0].text, /type=chat.message/);
    assert.match(messagesResult.content[0].text, /body=hello/);
    assert.match(messagesResult.content[0].text, /type=actor.leave/);
    assert.equal(messagesResult.details.messages[0].to, `room:${run}`);
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "Actor message tool supports selected-recipient room multicast",
  { skip: process.platform === "win32" },
  async () => {
  const definition = createActorMessageToolDefinition();
  const root = await mkdtemp(join(tmpdir(), "pi-actors-room-multicast-"));
  const readyFile = join(root, "ready");
  const script = 'mkfifo "$1/control.fifo"; exec 3<>"$1/control.fifo"; printf ready >"$2"; IFS= read -r one <&3; IFS= read -r two <&3';
  const meta = startRun(
    {
      run_id: `room-multicast-${process.pid}-${Date.now()}`,
      template: "bash -lc {script} -- {state_dir} {readyFile}",
      values: { readyFile, script },
    },
    process.cwd(),
  );
  try {
    await waitForFile(readyFile);
    const result = await definition.execute(
      "call-room-multicast",
      {
        body: "private subset, visible transcript",
        from: `branch:${meta.run}/planner`,
        metadata: {
          recipients: [
            `branch:${meta.run}/builder`,
            `branch:${meta.run}/reviewer`,
          ],
        },
        summary: "Selected multicast",
        to: `room:${meta.run}`,
        type: "chat.message",
      },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(result.details.result.multicast_count, 2);
    assert.deepEqual(result.details.result.multicast, [
      `branch:${meta.run}/builder`,
      `branch:${meta.run}/reviewer`,
    ]);
    const inbox = (await readFile(join(meta.state_dir, "inbox.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      inbox.map((message) => message.to),
      [`branch:${meta.run}/builder`, `branch:${meta.run}/reviewer`],
    );
    const roomMessages = await readFile(
      join(meta.state_dir, "rooms", "main", "messages.jsonl"),
      "utf8",
    );
    assert.match(roomMessages, /room-multicast/);
    assert.match(roomMessages, /Selected multicast/);
  } finally {
    cancelRun(meta.state_dir);
    await rm(meta.state_dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor message tool rejects room multicast outside the run", async () => {
  const definition = createActorMessageToolDefinition();
  const meta = startRun(
    {
      run_id: `room-multicast-invalid-${process.pid}-${Date.now()}`,
      template: "true",
    },
    process.cwd(),
  );
  try {
    await assert.rejects(
      () =>
        definition.execute(
          "call-room-multicast-invalid",
          {
            from: `branch:${meta.run}/planner`,
            metadata: { recipients: ["branch:other/reviewer"] },
            to: `room:${meta.run}`,
            type: "chat.message",
          },
          undefined,
          undefined,
          undefined,
        ),
      /room multicast recipient must be branch:/,
    );
  } finally {
    await rm(meta.state_dir, { recursive: true, force: true });
  }
});

test("Actor message tool allows same-run branch room posts across coordinator sessions", async () => {
  const definition = createActorMessageToolDefinition();
  const meta = startRun(
    {
      run_id: `room-nested-session-${process.pid}-${Date.now()}`,
      ownerId: "parent-session",
      template: "true",
    },
    process.cwd(),
  );
  try {
    const result = await definition.execute(
      "call-room-nested-session",
      {
        from: `branch:${meta.run}/implementer`,
        summary: "Claim first backlog task",
        to: `room:${meta.run}`,
        type: "task.claim",
      },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "nested-subagent-session" } },
    );
    assert.match(result.content[0].text, /message=sent/);
    assert.match(result.content[0].text, /type=task\.claim/);
  } finally {
    await rm(meta.state_dir, { recursive: true, force: true });
  }
});

test("Actor message tool rejects anonymous or cross-run room messages", async () => {
  const definition = createActorMessageToolDefinition();
  const meta = startRun(
    {
      run_id: `room-anon-${process.pid}-${Date.now()}`,
      template: "true",
    },
    process.cwd(),
  );
  try {
    await assert.rejects(
      definition.execute(
        "call-room-anonymous",
        { to: `room:${meta.run}`, type: "chat.message" },
        undefined,
        undefined,
        undefined,
      ),
      /requires from=<actor address>/,
    );
    await assert.rejects(
      definition.execute(
        "call-room-cross-run",
        {
          from: "run:other",
          to: `room:${meta.run}`,
          type: "chat.message",
        },
        undefined,
        undefined,
        undefined,
      ),
      new RegExp(`requires from=run:${meta.run}`),
    );
  } finally {
    await rm(meta.state_dir, { recursive: true, force: true });
  }
});

test("Inspect tool reads tool actor contracts", async () => {
  const definition = createInspectToolDefinition({
    getTool: (name) =>
      name === "echo"
        ? {
            description: "Echo tool",
            parameters: {
              properties: { text: { type: "string" } },
              required: ["text"],
              type: "object",
            },
            promptSnippet: "Echo text",
          }
        : undefined,
  });
  const result = await definition.execute(
    "call-inspect-tool",
    { target: "tool:echo", view: "status" },
    undefined,
    undefined,
    undefined,
  );
  assert.match(result.content[0].text, /tool=echo/);
  assert.match(result.content[0].text, /args=text/);
  assert.match(result.content[0].text, /required=text/);
  assert.equal(result.details.description, "Echo tool");
});

test("Actor message tool routes tool actors to executable tools", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const definition = createActorMessageToolDefinition({
    getTool: (name) =>
      name === "echo"
        ? {
            execute: async (
              toolCallId: string,
              params: unknown,
              _signal: AbortSignal | undefined,
              _onUpdate: unknown,
              ctx: unknown,
            ) => {
              calls.push({ ctx, params, toolCallId });
              return { content: [{ type: "text" as const, text: "\nok" }], details: params };
            },
          }
        : undefined,
  });
  const ctx = { cwd: process.cwd() };
  const result = await definition.execute(
    "call-tool-message",
    {
      body: { text: "hello" },
      to: "tool:echo",
      type: "tool.call",
    },
    undefined,
    undefined,
    ctx,
  );
  assert.match(result.content[0].text, /to=tool:echo/);
  assert.match(result.content[0].text, /tool=echo/);
  assert.match(result.content[0].text, /invoked=true/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolCallId, "message:tool.call");
  assert.deepEqual(calls[0].params, { text: "hello" });
  assert.equal(calls[0].ctx, ctx);
  assert.equal(result.details.result.tool, "echo");
});

test("Actor message tool routes coordinator messages through run outboxes", async () => {
  const definition = createActorMessageToolDefinition();
  const root = await mkdtemp(join(tmpdir(), "pi-actors-message-"));
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: "sender",
        template: `${process.execPath} -e "setTimeout(() => {}, 50)"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    const result = await definition.execute(
      "call-coordinator-message",
      {
        body: { ready: true },
        from: "run:sender",
        metadata: { checkpoint: "ready" },
        summary: "Ready",
        to: "coordinator",
        type: "checkpoint.ready",
      },
      undefined,
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /to=coordinator/);
    assert.match(result.content[0].text, /messages=outbox\.jsonl/);
    const event = JSON.parse(await readFile(join(stateDir, "outbox.jsonl"), "utf8"));
    assert.equal(event.to, "coordinator");
    assert.equal(event.from, "run:sender");
    assert.equal(event.type, "checkpoint.ready");
    assert.equal(event.delivery, "followup");
    assert.deepEqual(event.body, { ready: true });
    assert.deepEqual(event.metadata, { checkpoint: "ready" });
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor message tool routes session messages through owned run outboxes", async () => {
  const definition = createActorMessageToolDefinition();
  const runId = `session-sender-${process.pid}-${Date.now()}`;
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: runId,
        ownerId: "session-target",
        template: `${process.execPath} -e "setTimeout(() => {}, 50)"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    const result = await definition.execute(
      "call-session-message",
      {
        body: { needs: "scope" },
        from: `run:${runId}`,
        summary: "Need scope",
        to: "session:session-target",
        type: "checkpoint.needs_scope",
      },
      undefined,
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /to=session:session-target/);
    assert.match(result.content[0].text, /messages=outbox\.jsonl/);
    const event = JSON.parse(await readFile(join(stateDir, "outbox.jsonl"), "utf8"));
    assert.equal(event.to, "session:session-target");
    assert.equal(event.from, `run:${runId}`);
    assert.equal(event.type, "checkpoint.needs_scope");
    assert.equal(event.delivery, "followup");
    assert.deepEqual(event.body, { needs: "scope" });
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor message tool rejects session messages from differently owned runs", async () => {
  const definition = createActorMessageToolDefinition();
  const runId = `session-mismatch-${process.pid}-${Date.now()}`;
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: runId,
        ownerId: "session-owner",
        template: `${process.execPath} -e "setTimeout(() => {}, 50)"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    await assert.rejects(
      definition.execute(
        "call-session-message-mismatch",
        {
          from: `run:${runId}`,
          to: "session:other-session",
          type: "checkpoint.needs_scope",
        },
        undefined,
        undefined,
        undefined,
      ),
      /requires sender run owner other-session; got session-owner/,
    );
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor message tool rejects run messages across session ownership", async () => {
  const definition = createActorMessageToolDefinition();
  const runId = `run-owner-mismatch-${process.pid}-${Date.now()}`;
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: runId,
        ownerId: "other-session",
        template: `${process.execPath} -e "setTimeout(() => {}, 50)"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    await assert.rejects(
      definition.execute(
        "call-run-message-mismatch",
        {
          body: "stop",
          to: `run:${runId}`,
          type: "control.stop",
        },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "current-session" } },
      ),
      /owned by session:other-session; current session is current-session/,
    );
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor message tool rejects coordinator messages across session ownership", async () => {
  const definition = createActorMessageToolDefinition();
  const runId = `coordinator-owner-mismatch-${process.pid}-${Date.now()}`;
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: runId,
        ownerId: "other-session",
        template: `${process.execPath} -e "setTimeout(() => {}, 50)"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    await assert.rejects(
      definition.execute(
        "call-coordinator-message-mismatch",
        {
          from: `run:${runId}`,
          to: "coordinator",
          type: "checkpoint.ready",
        },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "current-session" } },
      ),
      /owned by session:other-session; current session is current-session/,
    );
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor message tool rejects session messages from unowned runs", async () => {
  const definition = createActorMessageToolDefinition();
  const runId = `session-unowned-${process.pid}-${Date.now()}`;
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: runId,
        template: `${process.execPath} -e "setTimeout(() => {}, 50)"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    await assert.rejects(
      definition.execute(
        "call-session-message-unowned",
        {
          from: `run:${runId}`,
          to: "session:target-session",
          type: "checkpoint.needs_scope",
        },
        undefined,
        undefined,
        undefined,
      ),
      /requires sender run owner target-session; got no owner/,
    );
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Spawn tool starts run actors with artifact metadata", async () => {
  const definition = createSpawnToolDefinition();
  const root = await mkdtemp(join(tmpdir(), "pi-actors-spawn-"));
  const stateDir = join(root, "spawned");
  try {
    const result = await definition.execute(
      "call-spawn",
      {
        artifacts: { report: "{state_dir}/report.md" },
        as: "run:spawned",
        state_dir: stateDir,
        template: `${process.execPath} -e "console.log('spawned')"`,
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    assert.match(result.content[0].text, /run=spawned/);
    assert.deepEqual(result.details.artifacts, { report: `${stateDir}/report.md` });
    const roster = JSON.parse(
      await readFile(join(stateDir, "rooms", "main", "roster.json"), "utf8"),
    );
    assert.equal(roster["run:spawned"].role, "run");
    const snapshot = JSON.parse(
      await readFile(join(stateDir, "communication.json"), "utf8"),
    );
    assert.equal(snapshot.root, "run:spawned");
    assert.equal(snapshot.self, "run:spawned");
    assert.match(snapshot.updated_at, /\d{4}-\d{2}-\d{2}T/);
    assert.equal(snapshot.rooms[0].address, "room:spawned");
    assert.equal(snapshot.rooms[0].members[0].address, "run:spawned");

    await waitForFile(join(stateDir, "result.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Inspect tool reads coordinator-owned runs", async () => {
  const definition = createInspectToolDefinition();
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: `coordinator-inspect-${process.pid}-${Date.now()}`,
        ownerId: "session-demo",
        retire_when: "children_terminal",
        template: `${process.execPath} -e "console.log('ok')"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    const result = await definition.execute(
      "call-inspect-coordinator",
      { target: "coordinator", view: "status", status: "running" },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "session-demo" } },
    );
    assert.match(result.content[0].text, /session=session-demo/);
    assert.match(result.content[0].text, /retire_when=children_terminal/);
    assert.equal(result.details.runs.length, 1);
    assert.equal(result.details.runs[0].run, meta.run);
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Inspect tool requires session context for coordinator inventory", async () => {
  const definition = createInspectToolDefinition();
  await assert.rejects(
    definition.execute(
      "call-inspect-coordinator-no-context",
      { target: "coordinator", view: "status" },
      undefined,
      undefined,
      undefined,
    ),
    /requires a current coordinator session/,
  );
});

test("Inspect tool reads session runs", async () => {
  const definition = createInspectToolDefinition();
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: `session-inspect-${process.pid}-${Date.now()}`,
        ownerId: "session-demo",
        template: `${process.execPath} -e "console.log('ok')"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    const result = await definition.execute(
      "call-inspect-session",
      { target: "session:session-demo", view: "status", status: "running" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /session=session-demo/);
    assert.equal(result.details.runs.length, 1);
    assert.equal(result.details.runs[0].run, meta.run);

    const all = await definition.execute(
      "call-inspect-all",
      { target: "session:all", view: "runs", status: "running" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(all.details.runs.some((run: { run: string }) => run.run === meta.run), true);
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Inspect tool rejects run views across session ownership", async () => {
  const definition = createInspectToolDefinition();
  const runId = `inspect-owner-mismatch-${process.pid}-${Date.now()}`;
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: runId,
        ownerId: "other-session",
        template: `${process.execPath} -e "console.log('ok')"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    await assert.rejects(
      definition.execute(
        "call-inspect-run-mismatch",
        { target: `run:${runId}`, view: "status" },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "current-session" } },
      ),
      /owned by session:other-session; current session is current-session/,
    );
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Inspect tool reads run actor messages", async () => {
  const definition = createInspectToolDefinition();
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: `messages-${Date.now()}`,
        template: `${process.execPath} -e "console.log('done')"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    await waitForFile(join(stateDir, "result.json"));
    const result = await definition.execute(
      "call-inspect-messages",
      { target: `run:${meta.run}`, view: "messages", verbose: true },
      undefined,
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /command\.done/);
    assert.equal(result.details.messages[0].type, "command.done");
    assert.equal(result.details.events, undefined);
    await assert.rejects(
      () => definition.execute(
        "call-inspect-events",
        { target: `run:${meta.run}`, view: "events" },
        undefined,
        undefined,
        undefined,
      ),
      /inspect view must be one of: status, tail, messages, artifacts, files, mailbox/,
    );
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Inspect tool reads run mailbox metadata", async () => {
  const definition = createInspectToolDefinition();
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: "mailbox",
        mailbox: { accepts: ["control.continue"], emits: ["run.done"] },
        template: `${process.execPath} -e "console.log('ok')"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    const result = await definition.execute(
      "call-inspect-mailbox",
      { target: "run:mailbox", view: "mailbox" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /accepts=control\.continue/);
    assert.match(result.content[0].text, /emits=run\.done/);
    assert.deepEqual(result.details.mailbox, {
      accepts: ["control.continue"],
      emits: ["run.done"],
    });
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Inspect tool reads run mailbox inbox entries", async () => {
  const inspect = createInspectToolDefinition();
  const message = createActorMessageToolDefinition();
  let stateDir = "";
  const runId = `mailbox-inbox-${process.pid}-${Date.now()}`;
  try {
    const meta = startRun(
      {
        run_id: runId,
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    await assert.rejects(
      () => message.execute(
        "call-run-mailbox-note",
        { body: "queue me", to: `run:${runId}`, type: "control.note" },
        undefined,
        undefined,
        undefined,
      ),
      /Run control FIFO not found/,
    );
    const inspected = await inspect.execute(
      "call-inspect-run-mailbox-inbox",
      { target: `run:${runId}`, view: "mailbox" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(inspected.content[0].text, /status=queued/);
    assert.match(inspected.content[0].text, /type=run\.message/);
    assert.equal(inspected.details.messages.length, 1);
    assert.equal(inspected.details.messages[0].body, "queue me");
  } finally {
    if (stateDir) {
      try {
        cancelRun(stateDir);
      } catch {
        // Best-effort cleanup.
      }
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});

test("Actor tools start, inspect, and stop run actors", async () => {
  const spawn = createSpawnToolDefinition();
  const inspect = createInspectToolDefinition();
  const message = createActorMessageToolDefinition();
  const runId = `compact-${process.pid}-${Date.now()}`;
  let stateDir = "";
  let retireStateDir = "";
  const recipeRunId = `${runId}-retire`;
  const recipeFile = join(tmpdir(), `${recipeRunId}.json`);
  const ctx = { cwd: process.cwd() };
  try {
    const started = await spawn.execute(
      "call-1",
      {
        as: `run:${runId}`,
        template: `${process.execPath} -e "setTimeout(() => {}, 1000)"`,
      },
      undefined,
      undefined,
      ctx,
    );
    stateDir = String(started.details.state_dir);
    assert.match(started.content[0].text, new RegExp(`run=${runId} status=running pid=\\d+`));
    assert.doesNotMatch(started.content[0].text, /argv|template|values/);

    await writeFile(
      recipeFile,
      JSON.stringify({
        async: true,
        retire_when: "children_terminal",
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      }),
    );
    const retireStarted = await spawn.execute(
      "call-retire",
      { as: `run:${recipeRunId}`, file: recipeFile },
      undefined,
      undefined,
      ctx,
    );
    retireStateDir = String(retireStarted.details.state_dir);
    assert.match(retireStarted.content[0].text, /retire_when=children_terminal/);

    const verbose = await inspect.execute(
      "call-2",
      { target: `run:${runId}`, view: "status", verbose: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(verbose.content[0].text, /"argv"/);
    assert.match(verbose.content[0].text, /"template"/);

    const communication = await inspect.execute(
      "call-communication",
      { target: `run:${runId}`, view: "communication" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(communication.content[0].text, new RegExp(`self=run:${runId}`));
    assert.equal(communication.details.communication.root, `run:${runId}`);

    const cancelled = await message.execute(
      "call-3",
      { to: `run:${runId}`, type: "control.stop" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(cancelled.content[0].text, /type=control\.stop/);
    assert.match(cancelled.content[0].text, /stopped=true/);
    assert.doesNotMatch(cancelled.content[0].text, /state_dir|argv/);
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    if (retireStateDir) {
      try {
        cancelRun(retireStateDir);
      } catch {
        // Best-effort cleanup; the short-lived test run may already be terminal.
      }
      await rm(retireStateDir, { recursive: true, force: true });
    }
    await rm(recipeFile, { force: true });
  }
});

test("Actor message tool does not treat legacy runtime control types as termination aliases", async () => {
  const message = createActorMessageToolDefinition();
  const runId = `legacy-control-${process.pid}-${Date.now()}`;
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: runId,
        template: `${process.execPath} -e "setTimeout(() => {}, 1000)"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    await assert.rejects(
      () => message.execute(
        "call-legacy-runtime-cancel",
        { to: `run:${runId}`, type: "runtime.cancel" },
        undefined,
        undefined,
        undefined,
      ),
      /Run control FIFO not found/,
    );
    const cancelled = await message.execute(
      "call-actor-cancel",
      { to: `run:${runId}`, type: "control.cancel" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(cancelled.content[0].text, /type=control\.cancel/);
    assert.match(cancelled.content[0].text, /stopped=true/);
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Runtime tool definition exposes run id override for async co-located recipes", () => {
  const definition = createRuntimeToolDefinition(
    {
      args: ["scope"],
      defaults: {},
      description: "Start review run",
      recipe: {
        async: true,
        name: "review",
        template: "review {scope}",
      },
      name: "review_run",
      template: "review {scope}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const properties = definition.parameters.properties as Record<string, any>;
  assert.deepEqual(definition.parameters.required, ["scope"]);
  assert.equal(properties.scope.type, "string");
  assert.equal(properties.run_id.type, "string");
  assert.match(definition.promptSnippet, /Start async template recipe: review/);
});

test("Runtime tool definition exposes typed arg schemas", () => {
  const definition = createRuntimeToolDefinition(
    {
      argTypes: {
        dry_run: { kind: "bool" },
        mode: { kind: "enum", values: ["check", "fix"] },
        prompts: { kind: "array" },
        speed: { kind: "number" },
        request_timeout: { kind: "int" },
      },
      args: ["file", "request_timeout", "speed", "dry_run", "mode", "prompts"],
      defaults: { dry_run: "true", mode: "check" },
      description: "Run checker",
      name: "check_tool",
      storedArgs: [
        "file:path",
        "request_timeout:int",
        "speed:number",
        "dry_run:bool",
        "mode:enum(check,fix)",
        "prompts:array",
      ],
      storedDefaults: { dry_run: "true", mode: "check" },
      template: "check {file} {request_timeout} {speed} {dry_run} {mode} {prompts}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.file.type, "string");
  assert.equal(properties.request_timeout.type, "integer");
  assert.equal(properties.speed.type, "number");
  assert.equal(properties.dry_run.type, "boolean");
  assert.deepEqual(properties.mode.enum, ["check", "fix"]);
  assert.equal(properties.prompts.type, "array");
  assert.deepEqual(definition.parameters.required, [
    "file",
    "request_timeout",
    "speed",
    "prompts",
  ]);
});

test("Runtime tool argument errors include compact usage hints", async () => {
  const definition = createRuntimeToolDefinition(
    {
      argTypes: { mode: { kind: "enum", values: ["check", "fix"] } },
      args: ["file", "mode"],
      defaults: { mode: "check" },
      description: "Run checker",
      name: "check_tool",
      template: "check {file} {mode}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  await assert.rejects(
    () =>
      definition.execute(
        "call-1",
        { file: "README.md", mode: "delete" },
        undefined,
        undefined,
        { cwd: "/work" },
      ),
    /Invalid arguments for tool "check_tool": Argument mode must be one of: check, fix\.\n\nExpected call shape for check_tool:\ncheck_tool\(\{\n  "file": "<file>",\n  "mode": "check"\n\}\)\nRequired: file\nOptional: mode/,
  );
});

test("Runtime tool missing value errors include compact usage hints", async () => {
  const definition = createRuntimeToolDefinition(
    {
      args: ["file", "out"],
      defaults: {},
      description: "Copy file",
      name: "copy_file",
      template: "cp {file} {out}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  await assert.rejects(
    () =>
      definition.execute(
        "call-1",
        { file: "README.md" },
        undefined,
        undefined,
        { cwd: "/work" },
      ),
    /Invalid arguments for tool "copy_file": Missing command template value: out\n\nExpected call shape for copy_file:\ncopy_file\(\{\n  "file": "<file>",\n  "out": "<out>"\n\}\)\nRequired: file, out/,
  );
});

test("Runtime tool definition marks defaulted args optional", () => {
  const definition = createRuntimeToolDefinition(
    {
      args: ["file", "lang"],
      defaults: { lang: "ru" },
      description: "Transcribe audio",
      name: "transcribe",
      template: "transcribe {file} {lang}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const properties = definition.parameters.properties as Record<string, any>;
  assert.deepEqual(definition.parameters.required, ["file"]);
  assert.equal(properties.file.type, "string");
  assert.equal(properties.lang.type, "string");
});

test("Runtime tool definition treats inline-default args as optional", () => {
  const definition = createRuntimeToolDefinition(
    {
      args: ["text", "lang"],
      defaults: {},
      description: "Speak text",
      name: "speak",
      template: "speak --text {text} --lang {lang=ru}",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  assert.deepEqual(definition.parameters.required, ["text"]);
});
