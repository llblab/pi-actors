/**
 * Pi-facing tool definition tests
 * Covers schema generation without relying on external schema-builder resolution
 */

import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RegisteredTool } from "../lib/config.ts";
import { cancelRun, startRun } from "../lib/async-runs.ts";
import { getRunStateRoot } from "../lib/paths.ts";
import { createActorMessageToolDefinition } from "../lib/tools-message.ts";
import { createInspectToolDefinition } from "../lib/tools-inspect.ts";
import { createSpawnToolDefinition } from "../lib/tools-spawn.ts";
import { createRegisterToolDefinition } from "../lib/tools-register.ts";
import { createRuntimeToolDefinition } from "../lib/tools-local.ts";
import { resolveActiveRuntimeTool } from "../lib/tools.ts";

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
    configPath: "/tmp/tool-registry.json",
    getActiveTools: () => [],
    getToolNameBlocker: () => undefined,
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
  assert.equal(properties.state_dir, undefined);
  assert.equal(properties.draft.type, "string");
  assert.equal(properties.values.type, "object");
  assert.equal(properties.update.type, "boolean");
  assert.equal(Array.isArray(properties.template.anyOf), true);
});

test("Register tool promotes draft recipes into active tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-promote-draft-"));
  try {
    const recipeRoot = join(root, "recipes");
    const draftRoot = join(recipeRoot, "drafts");
    await mkdir(draftRoot, { recursive: true });
    const draftPath = join(draftRoot, "captured.json");
    await writeFile(
      draftPath,
      JSON.stringify({ description: "Captured", template: "echo promoted" }),
    );
    const tools = new Map<string, RegisteredTool>();
    const active: string[] = [];
    const definition = createRegisterToolDefinition({
      ...createRegistryDeps(),
      configPath: join(root, "tool-registry.json"),
      getActiveTools: () => active,
      getTools: () => tools,
      recipeRoot,
      registerRuntimeTool: (tool) => tools.set(tool.name, tool),
      setActiveTools: (names) => active.splice(0, active.length, ...names),
    });

    const result = await definition.execute(
      "call-promote-draft",
      { name: "promoted_tool", draft: draftPath },
      undefined,
      undefined,
      undefined,
    );

    assert.match(result.content[0].text, /Registered tool "promoted_tool" from draft recipe/);
    assert.equal(result.details.promoted, true);
    assert.equal(result.details.config, join(recipeRoot, "promoted_tool.json"));
    assert.equal(result.details.draft, draftPath);
    assert.equal(tools.has("promoted_tool"), true);
    assert.deepEqual(
      JSON.parse(await readFile(join(recipeRoot, "promoted_tool.json"), "utf8")),
      { description: "Captured", template: "echo promoted" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Register tool rejects draft promotion name collisions unless update is explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-promote-collision-"));
  try {
    const recipeRoot = join(root, "recipes");
    const draftRoot = join(recipeRoot, "drafts");
    await mkdir(draftRoot, { recursive: true });
    const draftPath = join(draftRoot, "captured.json");
    await writeFile(
      draftPath,
      JSON.stringify({ description: "Captured", template: "echo promoted" }),
    );
    await writeFile(
      join(recipeRoot, "existing_tool.json"),
      JSON.stringify({ description: "Existing", template: "echo existing" }),
    );
    const definition = createRegisterToolDefinition({
      ...createRegistryDeps(),
      configPath: join(root, "tool-registry.json"),
      recipeRoot,
    });

    await assert.rejects(
      definition.execute(
        "call-promote-collision",
        { name: "existing_tool", draft: draftPath },
        undefined,
        undefined,
        undefined,
      ),
      /already registered.*update=true/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(recipeRoot, "existing_tool.json"), "utf8")),
      { description: "Existing", template: "echo existing" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Promoted draft recipes surface packaged shadowing in recipe inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-promote-shadow-"));
  try {
    const recipeRoot = join(root, "recipes");
    const packagedRoot = join(root, "packaged");
    const draftRoot = join(recipeRoot, "drafts");
    await mkdir(draftRoot, { recursive: true });
    await mkdir(packagedRoot, { recursive: true });
    await writeFile(
      join(packagedRoot, "stdlib_tool.json"),
      JSON.stringify({ description: "Stdlib", template: "echo stdlib" }),
    );
    const draftPath = join(draftRoot, "captured.json");
    await writeFile(
      draftPath,
      JSON.stringify({ description: "Captured", template: "echo promoted" }),
    );
    const register = createRegisterToolDefinition({
      ...createRegistryDeps(),
      configPath: join(root, "tool-registry.json"),
      recipeRoot,
    });
    await register.execute(
      "call-promote-shadow",
      { name: "stdlib_tool", draft: draftPath },
      undefined,
      undefined,
      undefined,
    );

    const inspect = createInspectToolDefinition({
      packagedRecipeRoot: packagedRoot,
      recipeRoot,
    });
    const result = await inspect.execute(
      "call-inspect-promote-shadow",
      { target: "recipes", view: "summary", verbose: true },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(
      (result.details.shadowed as Array<Record<string, unknown>>).some(
        (entry) => entry.id === "stdlib_tool" && String(entry.path).includes("packaged"),
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Register tool rejects invalid draft promotion before writing active recipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-promote-invalid-"));
  try {
    const recipeRoot = join(root, "recipes");
    const draftRoot = join(recipeRoot, "drafts");
    await mkdir(draftRoot, { recursive: true });
    const draftPath = join(draftRoot, "broken.json");
    await writeFile(draftPath, JSON.stringify({ description: "Broken" }));
    const definition = createRegisterToolDefinition({
      ...createRegistryDeps(),
      configPath: join(root, "tool-registry.json"),
      recipeRoot,
    });

    await assert.rejects(
      definition.execute(
        "call-promote-invalid-draft",
        { name: "broken_tool", draft: draftPath },
        undefined,
        undefined,
        undefined,
      ),
      /Draft recipe is invalid/,
    );
    await assert.rejects(readFile(join(recipeRoot, "broken_tool.json"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Spawn tool definition exposes actor creation schema", () => {
  const definition = createSpawnToolDefinition();
  assert.equal(definition.name, "spawn");
  assert.match(definition.description, /instead of ad hoc shell backgrounding/);
  assert.match(definition.description, /may outlive this turn/);
  assert.deepEqual(definition.parameters.required, []);
  const properties = definition.parameters.properties as Record<string, any>;
  assert.equal(properties.artifacts.type, "object");
  assert.equal(properties.as.type, "string");
  assert.equal(properties.recipe.type, "string");
  assert.equal(properties.file.type, "string");
  assert.equal(properties.state_dir, undefined);
  assert.equal(Array.isArray(properties.template.anyOf), true);
  assert.equal(
    properties.template.anyOf.some((item: any) => item.type === "object"),
    true,
  );
  assert.equal(properties.values.type, "object");
});

test("Spawn tool rejects custom state directories", async () => {
  const definition = createSpawnToolDefinition();
  await assert.rejects(
    definition.execute(
      "call-custom-state-dir",
      { state_dir: process.cwd(), template: "echo unsafe" },
      undefined,
      undefined,
      { cwd: process.cwd() },
    ),
    /spawn\.state_dir is not supported.*runtime-owned.*retention-safe/,
  );
});

test("Inspect tool definition exposes intentional observation schema", () => {
  const definition = createInspectToolDefinition();
  assert.equal(definition.name, "inspect");
  assert.match(definition.description, /after follow-ups/);
  assert.match(definition.description, /instead of polling/);
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
        fs.mkdir(join(userRecipes, "drafts"), { recursive: true }),
        fs.mkdir(packagedRecipes, { recursive: true }),
      ]),
    );
    await writeFile(
      join(userRecipes, "base.json"),
      JSON.stringify({ description: "Base", template: "echo base" }),
    );
    await writeFile(
      join(userRecipes, "user-tool.json"),
      JSON.stringify({ description: "User", imports: { base: "base.json" }, template: "echo user" }),
    );
    await writeFile(
      join(userRecipes, "policy.json"),
      JSON.stringify({
        args: ["model:string", "thinking:string"],
        defaults: { model: "{current_model}", thinking: "{current_thinking}" },
        description: "Policy",
        template: "echo {model} {thinking}",
      }),
    );
    await writeFile(join(userRecipes, "broken.json"), JSON.stringify({}));
    await writeFile(
      join(packagedRecipes, "stdlib.json"),
      JSON.stringify({ description: "Stdlib", template: "echo stdlib" }),
    );
    await writeFile(
      join(userRecipes, "drafts", "draft.json"),
      JSON.stringify({ description: "Draft", template: "echo draft" }),
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

    assert.match(result.content[0].text, /recipes active=5/);
    assert.match(result.content[0].text, /drafts=1/);
    assert.match(result.content[0].text, /invalid=1/);
    assert.match(result.content[0].text, /current_policy=1/);
    assert.match(result.content[0].text, /next=.*inspect_target=recipes_view=doctor/);
    assert.match(result.content[0].text, /next=.*spawn_file=.*recipes\/drafts\/draft\.json/);
    assert.equal((result.details.active as unknown[]).length, 5);
    assert.equal((result.details.drafts as unknown[]).length, 1);
    const policy = (result.details.active as Array<Record<string, unknown>>).find(
      (entry) => entry.id === "policy",
    )!;
    assert.deepEqual(policy.current_policy, {
      model: { inherited_defaults: ["model"], public_args: ["model"] },
      thinking: { inherited_defaults: ["thinking"], public_args: ["thinking"] },
    });
    const draft = (result.details.drafts as Array<Record<string, unknown>>)[0];
    assert.equal(draft.valid, true);
    assert.equal(typeof draft.sha256, "string");
    assert.equal(draft.template_preview, "echo draft");
    assert.deepEqual(result.details.next_actions, [
      "inspect target=recipes view=doctor",
      "inspect target=recipes view=summary verbose=true",
      join(userRecipes, "drafts", "draft.json"),
    ].map((action, index) => index === 2 ? `spawn file=${action}` : action));

    const doctor = await definition.execute(
      "call-inspect-recipes-doctor",
      { target: "recipes", view: "doctor" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(doctor.content[0].text, /recipes doctor errors=\d+/);
    assert.match(doctor.content[0].text, /actions=\d+/);
    assert.match(doctor.content[0].text, /risks=\d+/);
    assert.match(doctor.content[0].text, /top severity=/);
    assert.match(doctor.content[0].text, /action=/);
    assert.match(doctor.content[0].text, /next=/);
    assert.equal(Array.isArray(doctor.details.next_actions), true);
    assert.equal(
      (doctor.details.diagnostic_details as Array<Record<string, unknown>>).some(
        (detail) => detail.severity === "error" && detail.id === "broken",
      ),
      true,
    );
    assert.equal(
      (doctor.details.remediations as Array<Record<string, unknown>>).some(
        (item) => item.kind === "invalid" && item.id === "broken",
      ),
      true,
    );

    const imports = await definition.execute(
      "call-inspect-recipes-imports",
      { target: "recipes", view: "imports" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(imports.content[0].text, /recipe=user-tool alias=base from=base\.json/);
    assert.deepEqual(
      ((imports.details.active as Array<Record<string, unknown>>).find((entry) => entry.id === "user-tool")?.imports),
      { base: "base.json" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor message tool definition exposes concentrated message schema", () => {
  const definition = createActorMessageToolDefinition();
  assert.equal(definition.name, "message");
  assert.match(definition.description, /steer an existing actor/);
  assert.match(definition.description, /instead of restarting/);
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
      assert.equal(result.details.result.persisted, true);
      assert.equal(result.details.result.delivered, true);
      assert.equal(result.details.result.consumer, "branch-mailbox");
      assert.equal(result.details.result.reason, "branch_persisted_forwarded");
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

test("Actor message tool reports queued branch delivery when run control endpoint is missing", async () => {
  const definition = createActorMessageToolDefinition();
  const meta = startRun(
    {
      run_id: `branch-mailbox-fallback-${process.pid}-${Date.now()}`,
      template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
    },
    process.cwd(),
  );
  try {
    const result = await definition.execute(
      "call-branch-message-missing-control",
      {
        body: { decision: "approve" },
        from: `run:${meta.run}`,
        to: `branch:${meta.run}/worker`,
        type: "task.assign",
      },
      undefined,
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /^\nto=branch:/);
    assert.match(result.content[0].text, /message=not_sent/);
    assert.match(result.content[0].text, /queued=true/);
    assert.match(result.content[0].text, /delivery_error=/);
    assert.match(result.content[0].text, /next=.*inspect_target=branch:/);
    assert.equal(result.details.result.queued, true);
    assert.equal(result.details.result.sent, false);
    assert.equal(result.details.result.persisted, true);
    assert.equal(result.details.result.delivered, false);
    assert.equal(result.details.result.consumer, "branch-mailbox");
    assert.equal(result.details.result.reason, "branch_persisted_parent_unavailable");
    assert.deepEqual(result.details.result.next_actions, [
      `inspect target=branch:${meta.run}/worker view=mailbox`,
      `inspect target=run:${meta.run} view=status`,
    ]);
  } finally {
    cancelRun(meta.state_dir);
    await rm(meta.state_dir, { recursive: true, force: true });
  }
});

test("Actor message tool rejects cross-run branch senders before inbox writes", async () => {
  const definition = createActorMessageToolDefinition();
  const meta = startRun(
    {
      run_id: `branch-safety-${process.pid}-${Date.now()}`,
      template: "true",
    },
    process.cwd(),
  );
  try {
    await assert.rejects(
      () =>
        definition.execute(
          "call-branch-cross-run-sender",
          {
            body: "wrong run",
            from: "branch:other/builder",
            to: `branch:${meta.run}/reviewer`,
            type: "chat.message",
          },
          undefined,
          undefined,
          undefined,
        ),
      new RegExp(`message to branch:${meta.run}/<branch> requires from=run:${meta.run} or branch:${meta.run}/<branch>`),
    );
    await assert.rejects(
      () => readFile(join(meta.state_dir, "branches", "reviewer", "inbox.jsonl"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await rm(meta.state_dir, { recursive: true, force: true });
  }
});

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
    assert.equal(joinResult.details.result.persisted, true);
    assert.equal(joinResult.details.result.delivered, true);
    assert.equal(joinResult.details.result.consumer, "room-timeline");
    assert.equal(joinResult.details.result.reason, "room_persisted");
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
    assert.equal(result.details.result.persisted, true);
    assert.equal(result.details.result.delivered, true);
    assert.equal(result.details.result.forwarded, true);
    assert.equal(result.details.result.consumer, "room-timeline");
    assert.equal(result.details.result.reason, "room_persisted");
    assert.equal(result.details.result.multicast_count, 2);
    assert.deepEqual(result.details.result.multicast, [
      `branch:${meta.run}/builder`,
      `branch:${meta.run}/reviewer`,
    ]);
    assert.equal(
      Array.isArray(result.details.result.multicast_results),
      true,
    );
    assert.deepEqual(
      result.details.result.multicast_results.map(
        (item: Record<string, unknown>) => item.reason,
      ),
      ["branch_persisted_forwarded", "branch_persisted_forwarded"],
    );
    const inbox = (await readFile(join(meta.state_dir, "inbox.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      inbox.map((message) => message.to),
      [`branch:${meta.run}/builder`, `branch:${meta.run}/reviewer`],
    );
    const builderInbox = JSON.parse(
      (await readFile(join(meta.state_dir, "branches", "builder", "inbox.jsonl"), "utf8")).trim(),
    );
    const reviewerInbox = JSON.parse(
      (await readFile(join(meta.state_dir, "branches", "reviewer", "inbox.jsonl"), "utf8")).trim(),
    );
    assert.equal(builderInbox.to, `branch:${meta.run}/builder`);
    assert.equal(reviewerInbox.to, `branch:${meta.run}/reviewer`);
    assert.equal(builderInbox.status, "queued");
    assert.equal(reviewerInbox.status, "queued");
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

test("Actor message tool rejects cross-run room senders before timeline writes", async () => {
  const definition = createActorMessageToolDefinition();
  const meta = startRun(
    {
      run_id: `room-safety-${process.pid}-${Date.now()}`,
      template: "true",
    },
    process.cwd(),
  );
  try {
    await assert.rejects(
      () =>
        definition.execute(
          "call-room-cross-run-sender",
          {
            from: "branch:other/planner",
            to: `room:${meta.run}`,
            type: "chat.message",
          },
          undefined,
          undefined,
          undefined,
        ),
      new RegExp(`message to room:${meta.run} requires from=run:${meta.run} or branch:${meta.run}/<branch>`),
    );
    await assert.rejects(
      () => readFile(join(meta.state_dir, "rooms", "main", "messages.jsonl"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await rm(meta.state_dir, { recursive: true, force: true });
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

test("Actor message tool rejects non-branch room multicast recipients before timeline writes", async () => {
  const definition = createActorMessageToolDefinition();
  const meta = startRun(
    {
      run_id: `room-multicast-nonbranch-${process.pid}-${Date.now()}`,
      template: "true",
    },
    process.cwd(),
  );
  try {
    await assert.rejects(
      () =>
        definition.execute(
          "call-room-multicast-nonbranch",
          {
            from: `branch:${meta.run}/planner`,
            metadata: { recipients: [`run:${meta.run}`] },
            to: `room:${meta.run}`,
            type: "chat.message",
          },
          undefined,
          undefined,
          undefined,
        ),
      /room multicast recipient must be branch:/,
    );
    await assert.rejects(
      () => readFile(join(meta.state_dir, "rooms", "main", "messages.jsonl"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await rm(meta.state_dir, { recursive: true, force: true });
  }
});

test("Actor message tool rejects same-run branch room posts across session ownership", async () => {
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
    await assert.rejects(
      () => definition.execute(
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
      ),
      /reason=session_mismatch owner_session=parent-session current_session=nested-subagent-session/,
    );
  } finally {
    await rm(meta.state_dir, { recursive: true, force: true });
  }
});

test("Actor message tool rejects branch messages across session ownership", async () => {
  const definition = createActorMessageToolDefinition();
  const runId = `branch-owner-mismatch-${process.pid}-${Date.now()}`;
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: runId,
        ownerId: "other-session",
        template: "true",
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    await assert.rejects(
      () => definition.execute(
        "call-branch-message-mismatch",
        {
          from: `branch:${runId}/sender`,
          to: `branch:${runId}/recipient`,
          type: "task.assign",
        },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "current-session" } },
      ),
      /reason=session_mismatch owner_session=other-session current_session=current-session/,
    );
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
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

test("Inspect tool reads pi-actors runtime status", async () => {
  const definition = createInspectToolDefinition();
  const result = await definition.execute(
    "call-inspect-runtime-status",
    { target: "tool:pi-actors", view: "status" },
    undefined,
    undefined,
    undefined,
  );
  assert.match(result.content[0].text, /pi-actors version=/);
  assert.match(result.content[0].text, /mode=(source|dist)/);
  assert.equal(result.details.package_name, "@llblab/pi-actors");
  assert.equal(typeof result.details.entrypoint, "string");
});

test("Inspect tool reads healthy pi-actors triage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-triage-healthy-"));
  try {
    const userRecipes = join(root, "recipes");
    const packagedRecipes = join(root, "packaged");
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(join(userRecipes, "drafts"), { recursive: true }),
        fs.mkdir(packagedRecipes, { recursive: true }),
      ]),
    );
    const definition = createInspectToolDefinition({
      packagedRecipeRoot: packagedRecipes,
      recipeRoot: userRecipes,
    });
    const result = await definition.execute(
      "call-inspect-runtime-triage-healthy",
      { target: "tool:pi-actors", view: "triage" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /triage version=/);
    assert.match(result.content[0].text, /invalid_recipes=0/);
    assert.match(result.content[0].text, /drafts=0/);
    assert.deepEqual(result.details.invalid_recipes, []);
    assert.deepEqual(result.details.draft_recipes, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Inspect triage tolerates a run disappearing after inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-triage-vanished-run-"));
  try {
    const userRecipes = join(root, "recipes");
    const packagedRecipes = join(root, "packaged");
    await Promise.all([
      mkdir(join(userRecipes, "drafts"), { recursive: true }),
      mkdir(packagedRecipes, { recursive: true }),
    ]);
    const definition = createInspectToolDefinition({
      getRunStatus: () => {
        throw new Error("Run not found");
      },
      listRuns: () => [{ run: "vanished", state_dir: join(root, "vanished") }],
      packagedRecipeRoot: packagedRecipes,
      recipeRoot: userRecipes,
    });
    const result = await definition.execute(
      "call-inspect-runtime-triage-vanished",
      { target: "tool:pi-actors", view: "triage" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /triage version=/);
    assert.deepEqual(result.details.active_runs, []);
    assert.deepEqual(result.details.recent_failed_runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Inspect tool reports degraded pi-actors triage signals", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-triage-degraded-"));
  try {
    const userRecipes = join(root, "recipes");
    const packagedRecipes = join(root, "packaged");
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(join(userRecipes, "drafts"), { recursive: true }),
        fs.mkdir(packagedRecipes, { recursive: true }),
      ]),
    );
    await writeFile(join(userRecipes, "broken.json"), JSON.stringify({}));
    await writeFile(
      join(userRecipes, "shell-risk.json"),
      JSON.stringify({ template: "bash -c 'echo risky'" }),
    );
    await writeFile(
      join(userRecipes, "async-only.json"),
      JSON.stringify({ async: true, template: "echo background" }),
    );
    await writeFile(
      join(packagedRecipes, "packaged-shell.json"),
      JSON.stringify({ template: "bash -c 'echo packaged'" }),
    );
    await writeFile(
      join(userRecipes, "drafts", "draft.json"),
      JSON.stringify({ template: "echo draft" }),
    );
    const definition = createInspectToolDefinition({
      packagedRecipeRoot: packagedRecipes,
      recipeRoot: userRecipes,
    });
    const result = await definition.execute(
      "call-inspect-runtime-triage-degraded",
      { target: "tool:pi-actors", view: "triage" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /invalid_recipes=1/);
    assert.match(result.content[0].text, /high_risk_recipes=1/);
    assert.match(result.content[0].text, /drafts=1/);
    assert.deepEqual(
      (result.details.high_risk_recipes as Array<Record<string, unknown>>).map(
        (entry) => entry.id,
      ),
      ["shell-risk"],
    );
    assert.ok(
      (result.details.next_actions as string[]).includes(
        "inspect target=recipes view=doctor",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
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

test("Extension-local tool routing revokes stale host definitions", () => {
  const active = new Map<string, unknown>([["echo", { version: 1 }]]);
  const definitions = new Map<string, unknown>([["echo", { version: 1 }]]);
  assert.deepEqual(
    resolveActiveRuntimeTool("echo", active, (name) => definitions.get(name)),
    { version: 1 },
  );
  active.delete("echo");
  assert.equal(
    resolveActiveRuntimeTool("echo", active, (name) => definitions.get(name)),
    undefined,
  );
  active.set("echo", { version: 2 });
  definitions.set("echo", { version: 2 });
  assert.deepEqual(
    resolveActiveRuntimeTool("echo", active, (name) => definitions.get(name)),
    { version: 2 },
  );
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
  assert.equal(result.details.result.delivered, true);
  assert.equal(result.details.result.persisted, false);
  assert.equal(result.details.result.consumer, "tool");
  assert.equal(result.details.result.reason, "tool_invoked");
});

test("Actor message tool preserves target tool failure shape", async () => {
  const definition = createActorMessageToolDefinition({
    getTool: (name) =>
      name === "explode"
        ? {
            execute: async () => {
              throw new Error("boom cause");
            },
          }
        : undefined,
  });
  await assert.rejects(
    () => definition.execute(
      "call-tool-message-fail",
      {
        body: { text: "x".repeat(500) },
        to: "tool:explode",
        type: "tool.call",
      },
      undefined,
      undefined,
      undefined,
    ),
    (error: unknown) => {
      const record = error as Record<string, unknown>;
      assert.match(String(record.message), /tool actor explode failed for message type tool\.call/);
      assert.match(String(record.message), /boom cause/);
      assert.equal(record.tool, "explode");
      assert.equal(record.message_type, "tool.call");
      assert.equal(record.original_error, "boom cause");
      assert.equal(String(record.params_preview).length <= 240, true);
      assert.match(String(record.params_preview), /text/);
      return true;
    },
  );
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
    assert.equal(result.details.result.persisted, true);
    assert.equal(result.details.result.queued, true);
    assert.equal(result.details.result.delivered, false);
    assert.equal(result.details.result.consumer, "run-outbox");
    assert.equal(result.details.result.reason, "coordinator_outbox_persisted");
    const event = JSON.parse(await readFile(join(stateDir, "outbox.jsonl"), "utf8"));
    assert.equal(event.to, "coordinator");
    assert.equal(event.from, "run:sender");
    assert.equal(event.type, "checkpoint.ready");
    assert.equal(event.delivery, "notify");
    assert.deepEqual(event.body, { ready: true });
    assert.deepEqual(event.metadata, { checkpoint: "ready" });

    const followupResult = await definition.execute(
      "call-coordinator-message-response-required",
      {
        from: "run:sender",
        metadata: { requires_response: true, reason: "approval" },
        summary: "Approval needed",
        to: "coordinator",
        type: "checkpoint.needs_input",
      },
      undefined,
      undefined,
      undefined,
    );
    assert.match(followupResult.content[0].text, /to=coordinator/);
    const outbox = (await readFile(join(stateDir, "outbox.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(outbox[1].delivery, "followup");
    assert.deepEqual(outbox[1].metadata, { requires_response: true, reason: "approval" });
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
    assert.equal(result.details.result.persisted, true);
    assert.equal(result.details.result.queued, true);
    assert.equal(result.details.result.delivered, false);
    assert.equal(result.details.result.consumer, "run-outbox");
    assert.equal(result.details.result.reason, "session_outbox_persisted");
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
      /reason=session_mismatch owner_session=other-session current_session=session-owner hint=inspect_session:other-session/,
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
      /reason=session_mismatch owner_session=other-session current_session=current-session/,
    );
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor message tool rejects kill control across session ownership", async () => {
  const definition = createActorMessageToolDefinition();
  const runId = `kill-owner-mismatch-${process.pid}-${Date.now()}`;
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
        "call-kill-message-mismatch",
        {
          to: `run:${runId}`,
          type: "control.kill",
        },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "current-session" } },
      ),
      /reason=session_mismatch owner_session=other-session current_session=current-session/,
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
      /reason=session_mismatch owner_session=other-session current_session=current-session/,
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
      /reason=session_mismatch owner_session=target-session current_session=none hint=inspect_session:target-session/,
    );
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
});

test("Spawn tool enriches shadowed recipe launch failures", async () => {
  const definition = createSpawnToolDefinition();
  const agentDir = await mkdtemp(join(tmpdir(), "pi-actors-spawn-shadowed-"));
  const recipesDir = join(agentDir, "recipes");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(recipesDir, { recursive: true });
    await writeFile(join(recipesDir, "actor-worker.json"), "{ bad json", "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await assert.rejects(
      () =>
        definition.execute(
          "call-spawn-shadowed-invalid",
          { as: "run:spawn-shadowed-invalid", recipe: "actor-worker" },
          undefined,
          undefined,
          { cwd: process.cwd() },
        ),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /reason=shadowed_invalid/);
        assert.match(error.message, /active_path=.*actor-worker\.json/);
        assert.match(error.message, /blocked_fallback=.*recipes\/actor-worker\.json/);
        assert.match(error.message, /hint=inspect_recipes_doctor/);
        assert.equal((error as unknown as Record<string, unknown>).reason, "shadowed_invalid");
        return true;
      },
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Spawn tool injects current model and thinking into inherited recipe defaults", async () => {
  const definition = createSpawnToolDefinition();
  const root = await mkdtemp(join(tmpdir(), "pi-actors-current-policy-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let stateDir = "";
  try {
    const recipesDir = join(root, "recipes");
    await mkdir(recipesDir, { recursive: true });
    await writeFile(
      join(recipesDir, "current-review.json"),
      `${JSON.stringify({
        async: true,
        args: ["model:string", "thinking:string"],
        defaults: { model: "{current_model}", thinking: "{current_thinking}" },
        mailbox: { accepts: ["control.kill"], emits: ["command.done", "run.done", "run.failed"] },
        template: `${process.execPath} -e "console.log(process.argv[1], process.argv[2])" {model} {thinking}`,
      }, null, 2)}\n`,
    );
    process.env.PI_CODING_AGENT_DIR = root;
    const runId = `current-policy-${process.pid}-${Date.now()}`;
    const result = await definition.execute(
      "call-spawn-current-policy",
      { as: `run:${runId}`, recipe: "current-review" },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        getThinkingLevel: () => "high",
        model: { provider: "test-provider", id: "test-model" },
      },
    );
    stateDir = String(result.details.state_dir);
    assert.equal(result.details.values.current_model, "test-provider/test-model");
    assert.equal(result.details.values.current_thinking, "high");
    assert.equal(result.details.model_policy.model.source, "inherited");
    assert.equal(result.details.model_policy.thinking.source, "inherited");
    assert.match(result.content[0].text, /model=inherited:test-provider\/test-model/);
    assert.match(result.content[0].text, /thinking=inherited:high/);
    await waitForFile(join(stateDir, "result.json"));
    const inspect = createInspectToolDefinition();
    const status = await inspect.execute(
      "call-inspect-current-policy",
      { target: `run:${runId}`, view: "status" },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    assert.equal(status.details.model_policy.model.source, "inherited");
    assert.equal(status.details.progress.model_policy.thinking.source, "inherited");
    assert.match(status.content[0].text, /model=inherited:test-provider\/test-model/);
    const stdout = await readFile(join(stateDir, "stdout.log"), "utf8");
    assert.match(stdout, /test-provider\/test-model/);
    assert.match(stdout, /high/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("Spawn tool rejects current policy defaults before fanout when unavailable", async () => {
  const definition = createSpawnToolDefinition();
  const root = await mkdtemp(join(tmpdir(), "pi-actors-missing-current-policy-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const recipesDir = join(root, "recipes");
    await mkdir(recipesDir, { recursive: true });
    await writeFile(
      join(recipesDir, "current-review.json"),
      `${JSON.stringify({
        async: true,
        args: ["model:string", "thinking:string"],
        defaults: { model: "{current_model}", thinking: "{current_thinking}" },
        mailbox: { accepts: ["control.kill"], emits: ["command.done", "run.done", "run.failed"] },
        template: `${process.execPath} -e "console.log(process.argv[1], process.argv[2])" {model} {thinking}`,
      }, null, 2)}\n`,
    );
    process.env.PI_CODING_AGENT_DIR = root;
    await assert.rejects(
      () =>
        definition.execute(
          "call-spawn-missing-current-model",
          { as: `run:missing-current-model-${process.pid}-${Date.now()}`, recipe: "current-review" },
          undefined,
          undefined,
          { cwd: process.cwd() },
        ),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /requires the current Pi model/);
        assert.equal((error as any).model_policy.model.source, "unresolved");
        assert.deepEqual((error as any).model_policy.model.unresolved_keys, ["model"]);
        return true;
      },
    );
    await assert.rejects(
      () =>
        definition.execute(
          "call-spawn-missing-current-thinking",
          { as: `run:missing-current-thinking-${process.pid}-${Date.now()}`, recipe: "current-review" },
          undefined,
          undefined,
          {
            cwd: process.cwd(),
            model: { provider: "test-provider", id: "test-model" },
          },
        ),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /requires the current Pi thinking level/);
        assert.equal((error as any).model_policy.model.source, "inherited");
        assert.equal((error as any).model_policy.thinking.source, "unresolved");
        assert.deepEqual((error as any).model_policy.thinking.unresolved_keys, ["thinking"]);
        return true;
      },
    );
    const explicit = await definition.execute(
      "call-spawn-explicit-model",
      {
        as: `run:explicit-model-${process.pid}-${Date.now()}`,
        recipe: "current-review",
        values: { model: "explicit/provider-model", thinking: "off" },
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    assert.equal(explicit.details.model_policy.model.source, "explicit");
    assert.equal(explicit.details.model_policy.thinking.source, "explicit");
    assert.match(explicit.content[0].text, /model=explicit:explicit\/provider-model/);
    await waitForFile(join(String(explicit.details.state_dir), "result.json"));
    await rm(String(explicit.details.state_dir), { recursive: true, force: true });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("Spawn tool starts run actors with artifact metadata", async () => {
  const definition = createSpawnToolDefinition();
  const root = await mkdtemp(join(tmpdir(), "pi-actors-spawn-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousDraftTestFlag = process.env.PI_ACTORS_ENABLE_SPAWN_DRAFTS_IN_TEST;
  let stateDir = "";
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    process.env.PI_ACTORS_ENABLE_SPAWN_DRAFTS_IN_TEST = "1";
    const runId = `spawned-${process.pid}-${Date.now()}`;
    const result = await definition.execute(
      "call-spawn",
      {
        artifacts: {
          missing: { path: "{state_dir}/missing.md", required: true },
          report: { path: "{state_dir}/report.md", kind: "markdown", media_type: "text/markdown", required: true },
        },
        as: `run:${runId}`,
        template: `${process.execPath} -e "console.log('spawned')"`,
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    stateDir = String(result.details.state_dir);
    assert.match(result.content[0].text, /run=spawned-/);
    assert.match(result.content[0].text, /next=inspect_target=run:spawned-/);
    assert.match(result.content[0].text, /message_to=run:spawned-/);
    assert.match(result.content[0].text, /draft_recipe=.*recipes\/drafts\/spawned-/);
    assert.deepEqual(result.details.next_actions, [
      `inspect target=run:${runId} view=status`,
      `inspect target=run:${runId} view=messages`,
      `message to=run:${runId} type=<actor.action>`,
    ]);
    const draftRecipe = JSON.parse(
      await readFile(String(result.details.draft_recipe), "utf8"),
    );
    assert.equal(draftRecipe.async, true);
    assert.equal(draftRecipe.template, `${process.execPath} -e "console.log('spawned')"`);
    assert.deepEqual(draftRecipe.artifacts, result.details.artifacts);
    assert.equal(draftRecipe.defaults, undefined);
    assert.deepEqual(result.details.artifacts, {
      missing: { path: `${stateDir}/missing.md`, required: true },
      report: { path: `${stateDir}/report.md`, kind: "markdown", media_type: "text/markdown", required: true },
    });
    await writeFile(join(stateDir, "report.md"), "# Report\n");
    await waitForFile(join(stateDir, "result.json"));
    const inspect = createInspectToolDefinition();
    const artifacts = await inspect.execute(
      "call-inspect-artifacts",
      { target: `run:${runId}`, view: "artifacts", verbose: true },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    assert.equal(artifacts.details.artifact_manifest.report.exists, true);
    assert.equal(artifacts.details.artifact_manifest.report.size, 9);
    assert.equal(typeof artifacts.details.artifact_manifest.report.sha256, "string");
    assert.equal(artifacts.details.artifact_manifest.missing.exists, false);
    assert.equal(artifacts.details.artifact_manifest.missing.required, true);
    assert.equal(artifacts.details.review_evidence.commands_total, 1);
    assert.equal(artifacts.details.review_evidence.commands.length, 1);
    assert.match(
      artifacts.details.review_evidence.commands[0].attempts[0].stdout.path,
      /captures\/command-001\/attempt-001\/stdout\.log/,
    );
    await writeFile(
      join(stateDir, "review-evidence.json"),
      JSON.stringify({
        version: 1,
        run: runId,
        status: "done",
        commands: [{ id: "command-001" }, { id: "command-002" }, { id: "command-003" }],
      }),
    );
    const files = await inspect.execute(
      "call-inspect-files",
      { target: `run:${runId}`, view: "files", verbose: true, lines: "2" },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    assert.equal(files.details.review_evidence.commands_total, 3);
    assert.equal(files.details.review_evidence.commands_truncated, true);
    assert.deepEqual(
      files.details.review_evidence.commands.map((command: { id: string }) => command.id),
      ["command-002", "command-003"],
    );
    assert.deepEqual(artifacts.details.next_actions, [
      `inspect target=run:${runId} view=artifacts verbose=true`,
      `inspect target=run:${runId} view=messages`,
    ]);
    const roster = JSON.parse(
      await readFile(join(stateDir, "rooms", "main", "roster.json"), "utf8"),
    );
    assert.equal(roster[`run:${runId}`].role, "run");
    const snapshot = JSON.parse(
      await readFile(join(stateDir, "communication.json"), "utf8"),
    );
    assert.equal(snapshot.root, `run:${runId}`);
    assert.equal(snapshot.self, `run:${runId}`);
    assert.match(snapshot.updated_at, /\d{4}-\d{2}-\d{2}T/);
    assert.equal(snapshot.rooms[0].address, `room:${runId}`);
    assert.equal(snapshot.rooms[0].members[0].address, `run:${runId}`);

    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousDraftTestFlag === undefined) delete process.env.PI_ACTORS_ENABLE_SPAWN_DRAFTS_IN_TEST;
    else process.env.PI_ACTORS_ENABLE_SPAWN_DRAFTS_IN_TEST = previousDraftTestFlag;
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
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
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
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
    cancelRun(stateDir);
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
  let otherStateDir = "";
  try {
    const meta = startRun(
      {
        run_id: `session-inspect-${process.pid}-${Date.now()}`,
        ownerId: "session-demo",
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    const other = startRun(
      {
        run_id: `session-inspect-other-${process.pid}-${Date.now()}`,
        ownerId: "other-session",
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    otherStateDir = other.state_dir;
    const result = await definition.execute(
      "call-inspect-session",
      { target: "session:session-demo", view: "status", status: "running" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /session=session-demo/);
    assert.match(result.content[0].text, /other_sessions=/);
    assert.match(result.content[0].text, /other_runs=/);
    assert.equal(result.details.runs.length, 1);
    assert.equal(result.details.runs[0].run, meta.run);
    assert.equal(Number(result.details.other_runs) >= 1, true);

    const all = await definition.execute(
      "call-inspect-all",
      { target: "session:all", view: "runs", status: "running" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(all.details.runs.some((run: { run: string }) => run.run === meta.run), true);
    cancelRun(stateDir);
    cancelRun(otherStateDir);
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    if (otherStateDir) await rm(otherStateDir, { recursive: true, force: true });
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
      /reason=session_mismatch owner_session=other-session current_session=current-session/,
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
        mailbox: {
          accepts: ["control.continue", { type: "task.assign", requires_response: true, summary: "Assign work" }],
          emits: [{ type: "run.done", level: "info" }],
        },
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
    assert.match(result.content[0].text, /accepts=control\.continue,task\.assign/);
    assert.match(result.content[0].text, /emits=run\.done/);
    assert.deepEqual(result.details.normalized_mailbox, {
      accepts: [
        { type: "control.continue" },
        { type: "task.assign", requires_response: true, summary: "Assign work" },
      ],
      emits: [{ type: "run.done", level: "info" }],
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
        mailbox: { accepts: ["control.allowed"] },
        run_id: runId,
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    await writeFile(
      join(stateDir, "run.json"),
      `${JSON.stringify({ ...meta, control: { path: join(stateDir, "inbox.jsonl"), type: "mailbox" } }, null, 2)}\n`,
    );
    const sent = await message.execute(
      "call-run-mailbox-note",
      { body: "queue me", to: `run:${runId}`, type: "control.note" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(String(sent.details.result.warnings?.[0]), /not declared in mailbox\.accepts/);
    assert.equal(sent.details.result.queued, true);
    assert.equal(sent.details.result.persisted, true);
    assert.equal(sent.details.result.delivered, false);
    assert.equal(sent.details.result.consumer, "mailbox");
    assert.equal(sent.details.result.reason, "queued_mailbox");
    const inspected = await inspect.execute(
      "call-inspect-run-mailbox-inbox",
      { target: `run:${runId}`, view: "mailbox" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(inspected.content[0].text, /status=queued/);
    assert.match(inspected.content[0].text, /type=control\.note/);
    assert.equal(inspected.details.messages.length, 1);
    assert.equal(inspected.details.messages[0].type, "control.note");
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

test("Inspect branch mailbox reports corrupted inbox record counts", async () => {
  const inspect = createInspectToolDefinition();
  const message = createActorMessageToolDefinition();
  const runId = `branch-corrupt-inspect-${process.pid}-${Date.now()}`;
  let stateDir = "";
  try {
    const meta = startRun(
      {
        run_id: runId,
        template: "true",
      },
      process.cwd(),
    );
    stateDir = meta.state_dir;
    const seed = await message.execute(
      "call-branch-corrupt-seed",
      {
        from: `branch:${runId}/sender`,
        to: `branch:${runId}/recipient`,
        type: "task.assign",
      },
      undefined,
      undefined,
      undefined,
    );
    assert.match(seed.content[0].text, /queued=true/);
    await appendFile(join(stateDir, "branches", "recipient", "inbox.jsonl"), "bad json\n");
    const result = await inspect.execute(
      "call-branch-corrupt-inspect",
      { target: `branch:${runId}/recipient`, view: "mailbox" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(result.content[0].text, /corrupted=1/);
    assert.equal(result.details.corrupted, 1);
    assert.equal(result.details.messages.length, 1);
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
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
    assert.match(started.content[0].text, new RegExp(`next=inspect_target=run:${runId}_view=status`));
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

    const killed = await message.execute(
      "call-3",
      { to: `run:${runId}`, type: "control.kill" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(killed.content[0].text, /type=control\.kill/);
    assert.match(killed.content[0].text, /stopped=true/);
    assert.doesNotMatch(killed.content[0].text, /state_dir|argv/);
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

test("Actor message tool only treats control.kill as runtime termination", async () => {
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
    await assert.rejects(
      () => message.execute(
        "call-actor-cancel",
        { to: `run:${runId}`, type: "control.cancel" },
        undefined,
        undefined,
        undefined,
      ),
      /Run control FIFO not found/,
    );
    const killed = await message.execute(
      "call-actor-kill",
      { to: `run:${runId}`, type: "control.kill" },
      undefined,
      undefined,
      undefined,
    );
    assert.match(killed.content[0].text, /type=control\.kill/);
    assert.match(killed.content[0].text, /stopped=true/);
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

test("Runtime async tools report inherited current policy", async () => {
  const definition = createRuntimeToolDefinition(
    {
      args: ["model", "thinking"],
      defaults: { model: "{current_model}", thinking: "{current_thinking}" },
      description: "Start policy run",
      recipe: {
        async: true,
        args: ["model:string", "thinking:string"],
        defaults: { model: "{current_model}", thinking: "{current_thinking}" },
        name: "policy",
        template: `${process.execPath} -e "console.log(process.argv[1], process.argv[2])" {model} {thinking}`,
      },
      name: "policy_run",
      template: "policy",
    },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
  );
  const runId = `runtime-policy-${process.pid}-${Date.now()}`;
  let stateDir = "";
  try {
    const result = await definition.execute(
      "call-runtime-current-policy",
      { run_id: runId },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        getThinkingLevel: () => "medium",
        model: { provider: "test-provider", id: "test-model" },
      },
    );
    stateDir = String(result.details.state_dir);
    assert.equal(stateDir, join(getRunStateRoot(), runId));
    assert.equal(result.details.model_policy.model.source, "inherited");
    assert.equal(result.details.model_policy.thinking.source, "inherited");
    assert.match(result.content[0].text, /model=inherited:test-provider\/test-model/);
    await waitForFile(join(stateDir, "result.json"));
  } finally {
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }
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
