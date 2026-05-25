/**
 * Async run primitive regression tests
 * Covers detached state files, status/list/tail, and cancellation stale-state behavior
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendRunOutboxEvent,
  cancelRun,
  getRunProcessSignalPlan,
  getRunStatus,
  killRun,
  listRuns,
  readRunEvents,
  sendRunMessage,
  startRun,
  tailRun,
} from "../lib/async-runs.ts";
import { executeRunRetirements, summarizeRuns } from "../lib/observability.ts";

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

test("Recipe files reject tool references", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-runs-"));
  const file = join(root, "tool-run.json");
  try {
    await writeFile(
      file,
      JSON.stringify({ name: "tool-run", tool: "hello_tool" }, null, 2),
    );
    assert.throws(
      () => startRun({ file }, process.cwd()),
      /Template recipe cannot define tool/,
    );
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
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
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
    assert.match(sentPayload, /hello windows/);
    const inbox = JSON.parse(await readFile(join(stateDir, "inbox.jsonl"), "utf8"));
    assert.equal(inbox.body, "hello windows");
    assert.match(tailRun(stateDir), /run\.message/);
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
