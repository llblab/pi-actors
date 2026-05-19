/**
 * Async run primitive regression tests
 * Covers detached state files, status/list/tail, and cancellation stale-state behavior
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cancelRun, getRunStatus, killRun, listRuns, readRunEvents, sendRunMessage, startRun, tailRun } from "../lib/async-runs.ts";

async function waitForResult(stateDir: string): Promise<Record<string, unknown>> {
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

async function waitForStatus(stateDir: string, expected: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 40; i++) {
    const status = getRunStatus(stateDir);
    if (status.status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run did not reach status: ${expected}`);
}

test("Async runs write state files and finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-runs-"));
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
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    const status = getRunStatus(stateDir);
    assert.equal(status.status, "done");
    assert.equal((listRuns(root)[0] || {}).run, "hello");
    assert.match(tailRun(stateDir), /run\.(start|runner\.start|done)/);
    assert.match(await readFile(join(stateDir, "stdout.log"), "utf8"), /hello world/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async runs expose failed terminal status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-runs-"));
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
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-runs-"));
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
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-runs-"));
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
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-runs-"));
  const stateDir = join(root, "file-run");
  const file = join(root, "say.json");
  try {
    await writeFile(
      file,
      JSON.stringify(
        {
          name: "from-file",
          state_dir: stateDir,
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
    assert.equal(meta.recipe, "from-file");
    assert.equal(meta.values.greeting, "hello");
    assert.equal(meta.values.name, "override");
    assert.equal(meta.values.run_id, "override-run");
    assert.equal(meta.values.state_dir, stateDir);
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    assert.match(await readFile(join(stateDir, "stdout.log"), "utf8"), /hello override/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe files can put command-template flags at the recipe top level", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-runs-"));
  const stateDir = join(root, "top-level-mode");
  const file = join(root, "parallel.json");
  try {
    await writeFile(
      file,
      JSON.stringify(
        {
          state_dir: stateDir,
          mode: "parallel",
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

test("Recipe files reject tool references", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-runs-"));
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
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-runs-"));
  const stateDir = join(root, "outbox");
  const script = "const fs=require('fs');const path=require('path');fs.appendFileSync(path.join(process.argv[1],'outbox.jsonl'),JSON.stringify({event:'demo.update',summary:'Demo update',level:'warning',delivery:'notify',data:{ok:true}})+'\\n')";
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
    const events = readRunEvents(stateDir);
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

test("Async runs can send line messages to a run control FIFO", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-runs-"));
  const stateDir = join(root, "controlled");
  const readyFile = join(root, "ready");
  const messageFile = join(root, "message");
  const script = "mkfifo \"$1/control.fifo\"; printf ready >\"$2\"; IFS= read -r message <\"$1/control.fifo\"; printf %s \"$message\" >\"$3\"";
  try {
    startRun(
      {
        run_id: "controlled",
        state_dir: stateDir,
        template: "bash -lc {script} -- {state_dir} {readyFile} {messageFile}",
        values: { messageFile, readyFile, script },
      },
      process.cwd(),
    );
    await waitForFile(readyFile);
    const result = sendRunMessage(stateDir, "next");
    assert.equal(result.sent, true);
    assert.equal(result.control, "control.fifo");
    await waitForFile(messageFile);
    assert.equal(await readFile(messageFile, "utf8"), "next");
    assert.equal((await waitForResult(stateDir)).code, 0);
    assert.match(tailRun(stateDir), /run\.message/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run cancel terminates matching running runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-runs-"));
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
    assert.equal((await waitForStatus(stateDir, "cancelled")).status, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run cancel signals the running command process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-runs-"));
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
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-runs-"));
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
    assert.equal((await waitForStatus(stateDir, "killed")).status, "killed");
    assert.match(tailRun(stateDir), /run\.kill/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Async run cancel fails closed for completed runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-runs-"));
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
