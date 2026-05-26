/**
 * Async run primitive regression tests
 * Covers detached state files, status/list/tail, and cancellation stale-state behavior
 */

import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendRunOutboxEvent,
  archiveRun,
  cancelRun,
  getRunProcessSignalPlan,
  getRunStatus,
  claimRunInboxMessage,
  killRun,
  listRuns,
  processRunInboxMessages,
  pruneRun,
  readRunEvents,
  readRunStateIndex,
  rebuildRunStateIndex,
  readRunInboxMessages,
  sendRunMessage,
  startRun,
  tailRun,
} from "../lib/async-runs.ts";
import { executeRunRetirements, summarizeRuns } from "../lib/observability.ts";
import {
  createFileRuntimeNotifier,
  notifyRuntimeWake,
  readRuntimeWakeEvents,
  runtimeWakeFile,
} from "../lib/runtime-notifier.ts";

async function waitForResult(
  stateDir: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 40; i++) {
    const status = getRunStatus(stateDir);
    if (status.result) return status.result as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("run did not finish");
}

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

async function waitForWakeCount(
  observed: unknown[],
  expected: number,
): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (observed.length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`wake events did not reach count: ${expected}`);
}

async function waitForStatus(
  stateDir: string,
  expected: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 40; i++) {
    const status = getRunStatus(stateDir);
    if (status.status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run did not reach status: ${expected}`);
}

async function waitForRunProcessExit(stateDir: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const pid = Number(getRunStatus(stateDir).pid || 0);
    if (!pid) return;
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("Async runs reject reuse of an active run state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-active-"));
  const stateDir = join(root, "active");
  try {
    startRun(
      {
        run_id: "active",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 2000)"`,
      },
      process.cwd(),
    );
    await waitForStatus(stateDir, "running");
    assert.throws(
      () =>
        startRun(
          {
            run_id: "active",
            state_dir: stateDir,
            template: `${process.execPath} -e "console.log('replacement')"`,
          },
          process.cwd(),
        ),
      /active owned process/,
    );
    cancelRun(stateDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs reject state dirs with an in-progress start lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-start-lock-"));
  const stateDir = join(root, "locked");
  try {
    await mkdir(join(stateDir, ".start.lock"), { recursive: true });
    assert.throws(
      () =>
        startRun(
          {
            run_id: "locked",
            state_dir: stateDir,
            template: `${process.execPath} -e "console.log('replacement')"`,
          },
          process.cwd(),
        ),
      /already being started/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs write state files and finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "hello");
  try {
    const meta = startRun(
      {
        run_id: "hello",
        state_dir: stateDir,
        template: `${process.execPath} -e "console.log('hello ' + process.argv[1])" {name}`,
        values: { name: "world" },
      },
      process.cwd(),
    );
    assert.equal(meta.run, "hello");
    assert.equal(meta.ownerId, undefined);
    assert.equal(meta.values.actor_address, "run:hello");
    assert.equal(meta.values.communication_file, join(stateDir, "communication.json"));
    assert.equal(meta.values.default_room, "room:hello");
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    const status = getRunStatus(stateDir);
    assert.equal(status.status, "done");
    assert.equal((listRuns(root)[0] || {}).run, "hello");
    assert.match(tailRun(stateDir), /run\.(start|runner\.start|done)/);
    assert.match(
      await readFile(join(stateDir, "stdout.log"), "utf8"),
      /hello world/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async lifecycle status files preserve terminal semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-lifecycle-"));
  const exitedDir = join(root, "exited-before-result");
  const cancelledDir = join(root, "cancelled-before-result");
  const killedDir = join(root, "killed-before-result");
  try {
    await mkdir(exitedDir, { recursive: true });
    await writeFile(
      join(exitedDir, "run.json"),
      JSON.stringify({ pid: 0, run: "exited-before-result", state_dir: exitedDir }),
    );
    await writeFile(join(exitedDir, "events.jsonl"), `${JSON.stringify({ event: "run.start" })}\n`);
    assert.equal(getRunStatus(exitedDir).status, "exited");
    assert.match(tailRun(exitedDir), /run\.start/);

    await mkdir(cancelledDir, { recursive: true });
    await writeFile(
      join(cancelledDir, "run.json"),
      JSON.stringify({ pid: 0, run: "cancelled-before-result", state_dir: cancelledDir }),
    );
    await writeFile(join(cancelledDir, "events.jsonl"), `${JSON.stringify({ event: "run.cancel" })}\n`);
    assert.equal(getRunStatus(cancelledDir).status, "cancelled");

    await mkdir(killedDir, { recursive: true });
    await writeFile(
      join(killedDir, "run.json"),
      JSON.stringify({ pid: 0, run: "killed-before-result", state_dir: killedDir }),
    );
    await writeFile(join(killedDir, "events.jsonl"), `${JSON.stringify({ event: "run.kill" })}\n`);
    assert.equal(getRunStatus(killedDir).status, "killed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs emit command completion outbox events", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "command-outbox");
  const longArg = "x".repeat(220);
  try {
    startRun(
      {
        run_id: "command-outbox",
        state_dir: stateDir,
        defaults: { report_path: "{state_dir}/report.md" },
        artifacts: {
          report: "{report_path}",
          summary: "{state_dir}/result.json",
        },
        template: `${process.execPath} -e "console.log('artifact')" ${longArg}`,
      },
      process.cwd(),
    );
    await waitForResult(stateDir);
    const outbox = (await readFile(join(stateDir, "outbox.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const status = getRunStatus(stateDir);
    assert.deepEqual(status.artifacts, {
      report: `${stateDir}/report.md`,
      summary: `${stateDir}/result.json`,
    });
    assert.equal(outbox[0].event, "command.done");
    assert.equal(outbox[0].type, "command.done");
    assert.equal(outbox[0].to, "coordinator");
    assert.equal(outbox[0].from, "run:command-outbox");
    assert.equal(outbox[0].delivery, "log");
    assert.match(String(outbox[0].summary), /completed with code 0/);
    assert.equal(String(outbox[0].summary).includes(longArg), false);
    assert.match(
      String((outbox[0].data as Record<string, unknown>).command),
      new RegExp(longArg),
    );
    assert.deepEqual(
      (outbox[0].data as Record<string, unknown>).artifacts,
      {
        report: `${stateDir}/report.md`,
        summary: `${stateDir}/result.json`,
      },
    );
    assert.deepEqual(
      (outbox[0].body as Record<string, unknown>).artifacts,
      {
        report: `${stateDir}/report.md`,
        summary: `${stateDir}/result.json`,
      },
    );
    assert.deepEqual(
      (outbox[0].data as Record<string, unknown>).run_files,
      [
        join(stateDir, "stdout.log"),
        join(stateDir, "stderr.log"),
        join(stateDir, "result.json"),
        join(stateDir, "events.jsonl"),
        join(stateDir, "outbox.jsonl"),
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs append actor messages to outbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "actor-outbox");
  try {
    startRun(
      {
        run_id: "actor-outbox",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 1000)"`,
      },
      process.cwd(),
    );
    const result = appendRunOutboxEvent(stateDir, {
      body: { ok: true },
      delivery: "followup",
      event: "checkpoint.ready",
      from: "run:actor-outbox",
      metadata: { checkpoint: "ready" },
      summary: "Ready for approval",
      to: "coordinator",
      type: "checkpoint.ready",
    });
    assert.equal(result.sent, true);
    const events = readRunEvents(stateDir);
    assert.equal(events[0].event, "checkpoint.ready");
    assert.equal(events[0].type, "checkpoint.ready");
    assert.equal(events[0].to, "coordinator");
    assert.equal(events[0].from, "run:actor-outbox");
    assert.equal(events[0].delivery, "followup");
    assert.deepEqual(events[0].metadata, { checkpoint: "ready" });
    assert.deepEqual(events[0].body, { ok: true });

    appendRunOutboxEvent(stateDir, {
      event: "progress.update",
      metadata: { percent: 50 },
      summary: "Halfway",
      to: "coordinator",
    });
    appendRunOutboxEvent(stateDir, {
      event: "checkpoint.needs_input",
      metadata: { reason: "scope", requires_response: true },
      summary: "Need scope",
      to: "coordinator",
    });
    const updatedEvents = readRunEvents(stateDir, 3);
    assert.equal(updatedEvents[1].delivery, "notify");
    assert.equal(updatedEvents[2].delivery, "followup");
    assert.deepEqual(updatedEvents[2].metadata, { reason: "scope", requires_response: true });
  } finally {
    try {
      cancelRun(stateDir);
      await waitForRunProcessExit(stateDir);
    } catch {
      // Best-effort cleanup for the intentionally long-running actor.
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs expose failed terminal status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "failed");
  try {
    startRun(
      {
        run_id: "failed",
        state_dir: stateDir,
        template: `${process.execPath} -e "process.exit(7)"`,
      },
      process.cwd(),
    );
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 1);
    assert.equal(getRunStatus(stateDir).status, "failed");
    assert.equal((listRuns(root)[0] || {}).status, "failed");
    assert.equal(listRuns(root, "running").length, 0);
    assert.equal(listRuns(root, "terminal").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run restart clears stale terminal state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "restart");
  try {
    startRun(
      {
        run_id: "restart",
        state_dir: stateDir,
        template: `${process.execPath} -e "console.log('first')"`,
      },
      process.cwd(),
    );
    await waitForResult(stateDir);
    assert.equal(getRunStatus(stateDir).status, "done");
    await waitForRunProcessExit(stateDir);

    startRun(
      {
        run_id: "restart",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 1000)"`,
      },
      process.cwd(),
    );
    const status = getRunStatus(stateDir);
    assert.equal(status.status, "running");
    assert.equal(status.result, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs persist coordinator owner ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "owned");
  try {
    const meta = startRun(
      {
        run_id: "owned",
        ownerId: "session-a",
        state_dir: stateDir,
        template: `${process.execPath} -e "console.log('owned')"`,
      },
      process.cwd(),
    );
    assert.equal(meta.ownerId, "session-a");
    await waitForResult(stateDir);
    assert.equal(getRunStatus(stateDir).ownerId, "session-a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs can start from recipe files with overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "file-run");
  const file = join(root, "say.json");
  try {
    await writeFile(
      file,
      JSON.stringify(
        {
          name: "from-file",
          state_dir: stateDir,
          mailbox: { accepts: ["control.continue"], emits: ["run.done"] },
          retire_when: "children_terminal",
          template: `${process.execPath} -e "console.log(process.argv[1] + ' ' + process.argv[2])" {greeting} {name}`,
          values: { greeting: "hello", name: "file" },
        },
        null,
        2,
      ),
    );
    const meta = startRun(
      { file, run_id: "override-run", values: { name: "override" } },
      process.cwd(),
    );
    assert.equal(meta.run, "override-run");
    assert.equal(meta.recipe, "say");
    assert.equal(meta.values.greeting, "hello");
    assert.deepEqual(meta.mailbox, { accepts: ["control.continue"], emits: ["run.done"] });
    assert.equal(meta.retire_when, "children_terminal");
    assert.equal(meta.values.name, "override");
    assert.equal(meta.values.run_id, "override-run");
    assert.equal(meta.values.state_dir, stateDir);
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    assert.match(
      await readFile(join(stateDir, "stdout.log"), "utf8"),
      /hello override/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs can start from Markdown recipe files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-md-"));
  const stateDir = join(root, "md-run");
  const file = join(root, "say-md.md");
  try {
    await writeFile(
      file,
      [
        "---",
        `state_dir: ${stateDir}`,
        "defaults:",
        "  greeting: hello",
        "---",
        "",
        "```template",
        `${process.execPath} -e "console.log(process.argv[1])" {greeting}`,
        "```",
        "",
      ].join("\n"),
    );
    const meta = startRun({ file }, process.cwd());
    assert.equal(meta.recipe, "say-md");
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    assert.match(await readFile(join(stateDir, "stdout.log"), "utf8"), /hello/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs persist recipe context bundles for file-backed recipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-context-"));
  const stateDir = join(root, "context-run");
  const child = join(root, "child.json");
  const parent = join(root, "parent.json");
  try {
    await writeFile(
      child,
      JSON.stringify({ template: `${process.execPath} -e "console.log('child')"` }),
    );
    await writeFile(
      parent,
      JSON.stringify({
        imports: { child_step: "child.json" },
        state_dir: stateDir,
        template: [{ name: "child_step" }],
      }),
    );
    const meta = startRun({ file: parent }, process.cwd());
    assert.equal(meta.recipe_context_records?.length, 2);
    assert.deepEqual(
      meta.recipe_context_records?.map((record) => ({
        alias: record.alias,
        name: record.name,
        role: record.role,
      })),
      [
        { alias: undefined, name: "parent", role: "entry" },
        { alias: "child_step", name: "child", role: "import" },
      ],
    );
    assert.match(JSON.stringify(meta.template), /actorRecipeContext/);
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs allow recipes to opt out of actor recipe context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-context-off-"));
  const stateDir = join(root, "context-off-run");
  const file = join(root, "quiet.json");
  try {
    await writeFile(
      file,
      JSON.stringify({
        actor_context: false,
        state_dir: stateDir,
        template: `${process.execPath} -e "console.log('quiet')"`,
      }),
    );
    const meta = startRun({ file }, process.cwd());
    assert.equal(meta.recipe_context_records, undefined);
    assert.doesNotMatch(JSON.stringify(meta.template), /actorRecipeContext/);
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe files can put command-template flags at the recipe top level", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "top-level-parallel");
  const file = join(root, "parallel.json");
  try {
    await writeFile(
      file,
      JSON.stringify(
        {
          state_dir: stateDir,
          parallel: true,
          template: [
            `${process.execPath} -e "console.log('left')"`,
            `${process.execPath} -e "console.log('right')"`,
          ],
        },
        null,
        2,
      ),
    );
    const meta = startRun({ file }, process.cwd());
    assert.equal(meta.run, "parallel");
    assert.equal(typeof meta.template, "object");
    assert.equal(Array.isArray(meta.template), false);
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    const stdout = await readFile(join(stateDir, "stdout.log"), "utf8");
    assert.match(stdout, /left/);
    assert.match(stdout, /right/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe imports execute under repeated parallel parent nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "import-repeat");
  const child = join(root, "child.json");
  const parent = join(root, "parent.json");
  try {
    await writeFile(
      child,
      JSON.stringify(
        {
          name: "child",
          args: ["word:string"],
          template: `${process.execPath} -e "console.log(process.argv[1])" {word}-{index}-{_index}`,
        },
        null,
        2,
      ),
    );
    await writeFile(
      parent,
      JSON.stringify(
        {
          name: "parent",
          state_dir: stateDir,
          imports: {
            node: {
              from: "child.json",
              values: { word: "base" },
            },
          },
          repeat: 3,
          parallel: true,
          failure: "branch",
          template: {
            name: "node",
            values: { word: "{index}" },
          },
        },
        null,
        2,
      ),
    );
    const meta = startRun({ file: parent }, process.cwd());
    assert.equal(meta.run, "parent");
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    assert.match(String(result.command), /node .*0-0-00/);
    const stdout = await readFile(join(stateDir, "stdout.log"), "utf8");
    assert.match(stdout, /0-0-00/);
    assert.match(stdout, /1-1-01/);
    assert.match(stdout, /2-2-02/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Async runs expose script-authored outbox events", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "outbox");
  const script =
    "const fs=require('fs');const path=require('path');fs.appendFileSync(path.join(process.argv[1],'outbox.jsonl'),JSON.stringify({event:'demo.update',summary:'Demo update',level:'warning',delivery:'notify',data:{ok:true}})+'\\n')";
  try {
    startRun(
      {
        run_id: "outbox",
        state_dir: stateDir,
        template: `${process.execPath} -e {script} {state_dir}`,
        values: { script },
      },
      process.cwd(),
    );
    await waitForResult(stateDir);
    const events = readRunEvents(stateDir).filter(
      (event) => event.event === "demo.update",
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "demo.update");
    assert.equal(events[0].summary, "Demo update");
    assert.equal(events[0].level, "warning");
    assert.equal(events[0].delivery, "notify");
    assert.deepEqual(events[0].data, { ok: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime notifier persists advisory wake events", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runtime-notifier-"));
  const stateDir = join(root, "notified");
  const observed: unknown[] = [];
  try {
    const notifier = createFileRuntimeNotifier(stateDir, {
      pollIntervalMs: 25,
      watch: false,
    });
    const subscription = notifier.subscribe("run:notified", (event) => {
      observed.push(event);
    });
    try {
      const event = notifier.notify({
        actor: "run:notified",
        metadata: { source: "test" },
        reason: "mailbox.update",
      });
      assert.equal(event.actor, "run:notified");
      assert.equal(event.reason, "mailbox.update");
      assert.equal(runtimeWakeFile(stateDir), join(stateDir, "wake.jsonl"));
      await waitForWakeCount(observed, 1);
      const events = readRuntimeWakeEvents(stateDir);
      assert.equal(events.length, 1);
      assert.equal(events[0].id, event.id);
      assert.deepEqual(events[0].metadata, { source: "test" });
    } finally {
      subscription.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime notifier emits reconciliation callbacks without wakes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runtime-notifier-reconcile-"));
  const stateDir = join(root, "notified-reconcile");
  const reconciles: Array<{ actor: string; reason: string }> = [];
  try {
    const notifier = createFileRuntimeNotifier(stateDir, {
      pollIntervalMs: 25,
      watch: false,
    });
    const subscription = notifier.subscribe(
      "run:notified-reconcile",
      () => {},
      {
        onReconcile: (event) => {
          reconciles.push(event);
        },
      },
    );
    try {
      await waitForWakeCount(reconciles, 2);
      assert.equal(reconciles[0].reason, "initial");
      assert.equal(reconciles[0].actor, "run:notified-reconcile");
      assert.equal(reconciles.some((event) => event.reason === "poll"), true);
    } finally {
      subscription.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime notifier periodic fallback observes missed fs watch events", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runtime-notifier-fallback-"));
  const stateDir = join(root, "notified-fallback");
  const observed: unknown[] = [];
  try {
    const notifier = createFileRuntimeNotifier(stateDir, {
      pollIntervalMs: 25,
      watch: false,
    });
    const reconciles: Array<{ actor: string; reason: string }> = [];
    const subscription = notifier.subscribe(
      "run:notified-fallback",
      (event) => {
        observed.push(event);
      },
      {
        onReconcile: (event) => {
          reconciles.push(event);
        },
      },
    );
    try {
      notifyRuntimeWake(stateDir, {
        actor: "run:notified-fallback",
        reason: "mailbox.update",
      });
      await waitForWakeCount(observed, 1);
      assert.equal(readRuntimeWakeEvents(stateDir)[0].actor, "run:notified-fallback");
      assert.equal(reconciles.some((event) => event.reason === "wake"), true);
    } finally {
      subscription.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "Async runs can send line messages to a run control FIFO",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
    const stateDir = join(root, "controlled");
    const readyFile = join(root, "ready");
    const messageFile = join(root, "message");
    const script =
      'mkfifo "$1/control.fifo"; printf ready >"$2"; IFS= read -r message <"$1/control.fifo"; printf %s "$message" >"$3"';
    try {
      startRun(
        {
          run_id: "controlled",
          state_dir: stateDir,
          template:
            "bash -lc {script} -- {state_dir} {readyFile} {messageFile}",
          values: { messageFile, readyFile, script },
        },
        process.cwd(),
      );
      await waitForFile(readyFile);
      const result = await sendRunMessage(stateDir, "next");
      assert.equal(result.sent, true);
      assert.equal(result.control, "control.fifo");
      assert.equal(typeof result.inbox_id, "string");
      await waitForFile(messageFile);
      assert.equal(await readFile(messageFile, "utf8"), "next");
      assert.equal((await waitForResult(stateDir)).code, 0);
      assert.match(tailRun(stateDir), /run\.message/);

      const status = getRunStatus(stateDir);
      assert.equal(status.inboxFile, join(stateDir, "inbox.jsonl"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "Async runs mirror actor envelopes sent to control FIFO into inbox",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
    const stateDir = join(root, "controlled-envelope");
    const readyFile = join(root, "ready");
    const messageFile = join(root, "message");
    const script =
      'mkfifo "$1/control.fifo"; printf ready >"$2"; IFS= read -r message <"$1/control.fifo"; printf %s "$message" >"$3"';
    try {
      startRun(
        {
          run_id: "controlled-envelope",
          state_dir: stateDir,
          template:
            "bash -lc {script} -- {state_dir} {readyFile} {messageFile}",
          values: { messageFile, readyFile, script },
        },
        process.cwd(),
      );
      await waitForFile(readyFile);
      await sendRunMessage(
        stateDir,
        JSON.stringify({
          body: "private hello",
          from: "branch:controlled-envelope/a",
          to: "branch:controlled-envelope/b",
          type: "chat.message",
        }),
      );
      await waitForFile(messageFile);
      const inbox = JSON.parse(await readFile(join(stateDir, "inbox.jsonl"), "utf8"));
      assert.equal(inbox.from, "branch:controlled-envelope/a");
      assert.equal(inbox.to, "branch:controlled-envelope/b");
      assert.equal(inbox.body, "private hello");
      assert.match(inbox.received_at, /\d{4}-\d{2}-\d{2}T/);
      assert.equal((await waitForResult(stateDir)).code, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Async runs can send messages to a Windows named-pipe control endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-winpipe-"));
  const stateDir = join(root, "controlled-winpipe");
  const pipePath = "\\\\.\\pipe\\pi-actors-test-controlled-winpipe";
  let sentPayload = "";
  try {
    startRun(
      {
        run_id: "controlled-winpipe",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 30000)"`,
      },
      process.cwd(),
    );
    await waitForStatus(stateDir, "running");
    const runJsonPath = join(stateDir, "run.json");
    const meta = JSON.parse(await readFile(runJsonPath, "utf8"));
    await writeFile(
      runJsonPath,
      `${JSON.stringify({ ...meta, control: { path: pipePath, type: "named-pipe" } }, null, 2)}\n`,
    );
    const result = await sendRunMessage(
      stateDir,
      JSON.stringify({
        body: "hello windows",
        from: "coordinator",
        to: "run:controlled-winpipe",
        type: "control.note",
      }),
      {
        namedPipeSend: async (_path, payload) => {
          sentPayload = payload;
          return Buffer.byteLength(payload);
        },
        platform: "win32",
      },
    );
    assert.equal(result.sent, true);
    assert.equal(result.control, pipePath);
    assert.equal(result.control_type, "named-pipe");
    assert.equal(typeof result.inbox_id, "string");
    assert.match(sentPayload, /hello windows/);
    const inbox = JSON.parse(await readFile(join(stateDir, "inbox.jsonl"), "utf8"));
    assert.equal(inbox.body, "hello windows");
    const wakeEvents = readRuntimeWakeEvents(stateDir);
    assert.equal(wakeEvents.length, 1);
    assert.equal(wakeEvents[0].actor, "run:controlled-winpipe");
    assert.equal(wakeEvents[0].reason, "run.message");
    assert.equal(typeof wakeEvents[0].metadata?.inbox_id, "string");
    assert.deepEqual(
      {
        bytes: wakeEvents[0].metadata?.bytes,
        control_type: wakeEvents[0].metadata?.control_type,
      },
      {
        bytes: Buffer.byteLength(sentPayload),
        control_type: "named-pipe",
      },
    );
    assert.match(tailRun(stateDir), /run\.message/);
  } finally {
    killRun(stateDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run named-pipe timeout keeps durable queued message details", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-winpipe-timeout-"));
  const stateDir = join(root, "controlled-winpipe-timeout");
  const pipePath = "\\\\.\\pipe\\pi-actors-test-timeout";
  try {
    startRun(
      {
        run_id: "controlled-winpipe-timeout",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 30000)"`,
      },
      process.cwd(),
    );
    await waitForStatus(stateDir, "running");
    const runJsonPath = join(stateDir, "run.json");
    const meta = JSON.parse(await readFile(runJsonPath, "utf8"));
    await writeFile(
      runJsonPath,
      `${JSON.stringify({ ...meta, control: { path: pipePath, type: "named-pipe" } }, null, 2)}\n`,
    );
    await assert.rejects(
      () => sendRunMessage(
        stateDir,
        JSON.stringify({
          body: "queued despite pipe timeout",
          from: "coordinator",
          to: "run:controlled-winpipe-timeout",
          type: "control.note",
        }),
        {
          namedPipeSend: async () => {
            throw new Error("named pipe connection timed out");
          },
          platform: "win32",
        },
      ),
      (error: unknown) => {
        const record = error as Record<string, unknown>;
        assert.equal(record.queued, true);
        assert.equal(record.sent, false);
        assert.equal(record.control_type, "named-pipe");
        assert.equal(record.control_path, pipePath);
        assert.equal(typeof record.inbox_id, "string");
        assert.equal(record.delivery_error, "named pipe connection timed out");
        return true;
      },
    );
    const inbox = JSON.parse(await readFile(join(stateDir, "inbox.jsonl"), "utf8"));
    assert.equal(inbox.body, "queued despite pipe timeout");
    assert.equal(inbox.status, "queued");
  } finally {
    killRun(stateDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs can accept messages through mailbox-only control endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-mailbox-control-"));
  const stateDir = join(root, "controlled-mailbox");
  try {
    startRun(
      {
        run_id: "controlled-mailbox",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    await waitForStatus(stateDir, "running");
    const runJsonPath = join(stateDir, "run.json");
    const meta = JSON.parse(await readFile(runJsonPath, "utf8"));
    await writeFile(
      runJsonPath,
      `${JSON.stringify({ ...meta, control: { path: join(stateDir, "inbox.jsonl"), type: "mailbox" } }, null, 2)}\n`,
    );
    const result = await sendRunMessage(
      stateDir,
      JSON.stringify({
        body: "hello mailbox",
        from: "coordinator",
        to: "run:controlled-mailbox",
        type: "control.note",
      }),
      { platform: "win32" },
    );
    assert.equal(result.sent, true);
    assert.equal(result.queued, true);
    assert.equal(result.control_type, "mailbox");
    assert.equal(result.control_path, join(stateDir, "inbox.jsonl"));
    assert.equal(typeof result.inbox_id, "string");
    const inbox = JSON.parse(await readFile(join(stateDir, "inbox.jsonl"), "utf8"));
    assert.equal(inbox.body, "hello mailbox");
    assert.equal(inbox.status, "queued");
    const [wake] = readRuntimeWakeEvents(stateDir);
    assert.equal(wake.actor, "run:controlled-mailbox");
    assert.equal(wake.metadata?.control_type, "mailbox");
    assert.equal(wake.metadata?.inbox_id, inbox.id);
  } finally {
    killRun(stateDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run messages persist mailbox wake before endpoint delivery failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-wake-before-endpoint-"));
  const stateDir = join(root, "controlled-missing-endpoint");
  try {
    startRun(
      {
        run_id: "controlled-missing-endpoint",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    await waitForStatus(stateDir, "running");
    await assert.rejects(
      () => sendRunMessage(
        stateDir,
        JSON.stringify({
          body: "queued despite missing endpoint",
          from: "coordinator",
          to: "run:controlled-missing-endpoint",
          type: "control.note",
        }),
      ),
      (error: unknown) => {
        const record = error as Record<string, unknown>;
        assert.match(String(record.message), /Run control FIFO not found/);
        assert.equal(record.queued, true);
        assert.equal(record.sent, false);
        assert.equal(typeof record.inbox_id, "string");
        assert.match(String(record.delivery_error), /Run control FIFO not found/);
        return true;
      },
    );
    const inbox = JSON.parse(await readFile(join(stateDir, "inbox.jsonl"), "utf8"));
    assert.equal(inbox.body, "queued despite missing endpoint");
    assert.equal(inbox.status, "queued");
    assert.match(inbox.queued_at, /\d{4}-\d{2}-\d{2}T/);
    const [wake] = readRuntimeWakeEvents(stateDir);
    assert.equal(wake.actor, "run:controlled-missing-endpoint");
    assert.equal(wake.reason, "run.message");
    assert.equal(wake.metadata?.inbox_id, inbox.id);
  } finally {
    killRun(stateDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run inbox messages can be claimed and handled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-inbox-process-"));
  const stateDir = join(root, "inbox-process");
  try {
    startRun(
      {
        run_id: "inbox-process",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    await waitForStatus(stateDir, "running");
    await assert.rejects(
      () => sendRunMessage(
        stateDir,
        JSON.stringify({
          body: "claim me",
          from: "coordinator",
          to: "run:inbox-process",
          type: "control.note",
        }),
      ),
      /Run control FIFO not found/,
    );
    const claimed = claimRunInboxMessage(stateDir, "test-worker");
    assert.equal(claimed?.body, "claim me");
    assert.equal(claimed?.status, "claimed");
    assert.equal(claimed?.claimed_by, "test-worker");
    assert.equal(claimRunInboxMessage(stateDir, "other-worker"), undefined);
    await processRunInboxMessages(
      stateDir,
      () => {
        throw new Error("should not see claimed messages by default");
      },
      { owner: "other-worker" },
    );
    const afterClaim = readRunInboxMessages(stateDir, 1)[0];
    assert.equal(afterClaim.status, "claimed");
  } finally {
    killRun(stateDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run inbox reads skip malformed state records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-inbox-corrupt-"));
  const stateDir = join(root, "inbox-corrupt");
  try {
    startRun(
      {
        run_id: "inbox-corrupt",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    await waitForStatus(stateDir, "running");
    await assert.rejects(
      () => sendRunMessage(
        stateDir,
        JSON.stringify({
          body: "valid",
          from: "coordinator",
          to: "run:inbox-corrupt",
          type: "control.note",
        }),
      ),
      /Run control FIFO not found/,
    );
    await appendFile(join(stateDir, "inbox.jsonl"), "{bad json\n");

    const messages = readRunInboxMessages(stateDir, 10);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].body, "valid");
    const claimed = claimRunInboxMessage(stateDir, "worker");
    assert.equal(claimed?.body, "valid");
  } finally {
    killRun(stateDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run inbox processor marks handled and failed messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-inbox-handler-"));
  const stateDir = join(root, "inbox-handler");
  try {
    startRun(
      {
        run_id: "inbox-handler",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    await waitForStatus(stateDir, "running");
    for (const body of ["ok", "bad"]) {
      await assert.rejects(
        () => sendRunMessage(
          stateDir,
          JSON.stringify({
            body,
            from: "coordinator",
            to: "run:inbox-handler",
            type: "control.note",
          }),
        ),
        /Run control FIFO not found/,
      );
    }
    const result = await processRunInboxMessages(
      stateDir,
      (message) => {
        if (message.body === "bad") throw new Error("handler failed");
      },
      { limit: 2, owner: "handler" },
    );
    assert.deepEqual(result, { claimed: 2, failed: 1, handled: 1 });
    const messages = readRunInboxMessages(stateDir, 2);
    assert.deepEqual(
      messages.map((message) => message.status),
      ["handled", "failed"],
    );
    assert.equal(messages[0].claimed_by, "handler");
    assert.match(String(messages[0].handled_at ?? ""), /\d{4}-\d{2}-\d{2}T/);
    assert.match(String(messages[1].failed_at ?? ""), /\d{4}-\d{2}-\d{2}T/);
    assert.equal(messages[1].error, "handler failed");
  } finally {
    killRun(stateDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run process control maps Windows force kill to taskkill tree", () => {
  assert.deepEqual(getRunProcessSignalPlan(1234, "SIGKILL", "win32"), {
    args: ["/PID", "1234", "/T", "/F"],
    command: "taskkill",
    signalTarget: "processTree",
  });
  assert.deepEqual(getRunProcessSignalPlan(1234, "SIGTERM", "win32"), {
    args: ["/PID", "1234", "/T"],
    command: "taskkill",
    signalTarget: "processTree",
  });
});

test("Async run cancel terminates matching running runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "running");
  try {
    startRun(
      {
        run_id: "running",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    for (let i = 0; i < 20; i++) {
      if (getRunStatus(stateDir).status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const result = cancelRun(stateDir);
    assert.equal(result.cancelled, true);
    const status = await waitForStatus(stateDir, "cancelled");
    assert.equal(status.status, "cancelled");
    const handled = status.terminal_handled as Record<string, unknown>;
    assert.deepEqual(handled, {
      event: "run.cancel",
      signal: "SIGTERM",
      ts: handled.ts,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run cancel signals the running command process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "running-group");
  const pidFile = join(root, "child.pid");
  const termFile = join(root, "child.term");
  let childPid = 0;
  try {
    startRun(
      {
        run_id: "running-group",
        state_dir: stateDir,
        template: `${process.execPath} -e "const fs=require('fs');fs.writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>(fs.writeFileSync(process.argv[2],'term'),process.exit(0)));setTimeout(()=>0,5000)" {pidFile} {termFile}`,
        values: { pidFile, termFile },
      },
      process.cwd(),
    );
    await waitForFile(pidFile);
    childPid = Number(await readFile(pidFile, "utf8"));
    const result = cancelRun(stateDir);
    assert.equal(result.cancelled, true);
    await waitForFile(termFile);
    assert.equal(await readFile(termFile, "utf8"), "term");
  } finally {
    if (childPid > 0) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // Already stopped by process-group cancellation.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run kill terminates matching stuck runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "stuck");
  try {
    startRun(
      {
        run_id: "stuck",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    for (let i = 0; i < 20; i++) {
      if (getRunStatus(stateDir).status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const result = killRun(stateDir);
    assert.equal(result.killed, true);
    assert.equal(result.signal, "SIGKILL");
    const status = await waitForStatus(stateDir, "killed");
    assert.equal(status.status, "killed");
    const handled = status.terminal_handled as Record<string, unknown>;
    assert.deepEqual(handled, {
      event: "run.kill",
      signal: "SIGKILL",
      ts: handled.ts,
    });
    assert.match(tailRun(stateDir), /run\.kill/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run retirement smoke stops supervisor after nested child is terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-retire-smoke-"));
  const supervisorDir = join(root, "supervisor");
  const childDir = join(supervisorDir, "child");
  const serviceDir = join(root, "service");
  try {
    startRun(
      {
        run_id: "supervisor",
        state_dir: supervisorDir,
        retire_when: "children_terminal",
        template: `${process.execPath} -e "setInterval(() => {}, 1000)"`,
      },
      process.cwd(),
    );
    startRun(
      {
        run_id: "child",
        state_dir: childDir,
        template: `${process.execPath} -e "console.log('child done')"`,
      },
      process.cwd(),
    );
    startRun(
      {
        run_id: "service",
        state_dir: serviceDir,
        template: `${process.execPath} -e "setInterval(() => {}, 1000)"`,
      },
      process.cwd(),
    );
    await waitForResult(childDir);
    await writeFile(
      join(supervisorDir, "progress.json"),
      JSON.stringify({ activeSubagents: 0, completed: 1, failures: [], updatedAt: new Date().toISOString() }),
    );
    const summary = summarizeRuns(root);
    assert.deepEqual(
      summary.runs.map((run) => run.run).sort(),
      ["child", "service", "supervisor"],
    );
    const results = await executeRunRetirements(summary, {
      cancelRun: (candidate) => cancelRun(candidate.stateDir),
      sendStop: (candidate) => sendRunMessage(candidate.stateDir, "stop"),
    });
    assert.deepEqual(results, [
      { action: "cancel", run: "supervisor", stateDir: supervisorDir },
    ]);
    for (let index = 0; index < 40; index += 1) {
      if (getRunStatus(supervisorDir).status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(getRunStatus(supervisorDir).status, "cancelled");
    assert.equal(getRunStatus(childDir).status, "done");
    assert.equal(getRunStatus(serviceDir).status, "running");
    assert.match(tailRun(supervisorDir), /run\.cancel/);
  } finally {
    try {
      cancelRun(supervisorDir);
    } catch {
      // Best-effort cleanup for the long-running supervisor process.
    }
    try {
      cancelRun(serviceDir);
    } catch {
      // Best-effort cleanup for the non-retiring service process.
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run cancel fails closed for completed runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const stateDir = join(root, "done");
  try {
    startRun(
      {
        run_id: "done",
        state_dir: stateDir,
        template: `${process.execPath} -e "console.log('done')"`,
      },
      process.cwd(),
    );
    await waitForResult(stateDir);
    const result = cancelRun(stateDir);
    assert.equal(result.cancelled, false);
    assert.equal(result.reason, "not running");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run state index rebuilds and corrupt index falls back", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-index-"));
  const parentDir = join(root, "parent");
  const childDir = join(parentDir, "child");
  try {
    startRun(
      {
        ownerId: "session-a",
        run_id: `index-parent-${process.pid}-${Date.now()}`,
        state_dir: parentDir,
        template: `${process.execPath} -e "console.log('parent')"`,
        tool: "parent-tool",
      },
      process.cwd(),
    );
    startRun(
      {
        ownerId: "session-a",
        run_id: `index-child-${process.pid}-${Date.now()}`,
        state_dir: childDir,
        template: `${process.execPath} -e "console.log('child')"`,
        name: "child-recipe",
      },
      process.cwd(),
    );
    await waitForResult(parentDir);
    await waitForResult(childDir);
    const index = rebuildRunStateIndex(root);
    assert.equal(index.length, 2);
    assert.deepEqual(index.map((entry) => entry.state_dir).sort(), [childDir, parentDir].sort());
    assert.equal(readRunStateIndex(root)?.length, 2);
    assert.equal(listRuns(root, "done").length, 2);
    await writeFile(join(root, "index.json"), "not-json");
    assert.equal(listRuns(root, "done").length, 2);
    assert.equal(readRunStateIndex(root)?.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run archive and prune only allow terminal run state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-retention-"));
  const activeDir = join(root, "active");
  const doneDir = join(root, "done");
  const pruneDir = join(root, "prune");
  try {
    startRun(
      {
        run_id: `active-${process.pid}-${Date.now()}`,
        state_dir: activeDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 3000)"`,
      },
      process.cwd(),
    );
    assert.throws(() => archiveRun(activeDir), /Only terminal runs/);
    assert.throws(() => pruneRun(activeDir), /Only terminal runs/);
    killRun(activeDir);

    startRun(
      {
        run_id: `archive-${process.pid}-${Date.now()}`,
        state_dir: doneDir,
        template: `${process.execPath} -e "console.log('done')"`,
      },
      process.cwd(),
    );
    await waitForResult(doneDir);
    const archived = archiveRun(doneDir);
    assert.equal(archived.archived, true);
    await readFile(join(doneDir, "archive-tombstone.json"), "utf8");
    await readFile(join(String(archived.archive_dir), "run.json"), "utf8");

    startRun(
      {
        artifacts: { report: { path: "{state_dir}/report.txt", required: true } },
        run_id: `prune-${process.pid}-${Date.now()}`,
        state_dir: pruneDir,
        template: `${process.execPath} -e "console.log('done')"`,
      },
      process.cwd(),
    );
    await waitForResult(pruneDir);
    await writeFile(join(pruneDir, "report.txt"), "report");
    const pruned = pruneRun(pruneDir, { preserveArtifacts: true });
    assert.equal(pruned.pruned, true);
    assert.equal(typeof (pruned.preserved_artifacts as Record<string, string>).report, "string");
    await readFile((pruned.preserved_artifacts as Record<string, string>).report, "utf8");
    assert.throws(() => getRunStatus(pruneDir), /Run not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
