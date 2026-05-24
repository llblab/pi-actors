/**
 * Coordinator-locker script regression tests
 * Covers queue, lease lock, and actor-message behavior for the coordinator-locker recipe helper.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/locker.mjs", import.meta.url).pathname;
const roomSwarmScript = new URL("../scripts/coordinator.mjs", import.meta.url).pathname;

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function sendLine(path: string, value: unknown): Promise<void> {
  const line = `${typeof value === "string" ? value : JSON.stringify(value)}\n`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = spawnSync("bash", ["-lc", "printf '%s' \"$1\" > \"$2\"", "bash", line, path], {
      encoding: "utf8",
      timeout: 1000,
    });
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out sending to ${path}`);
}

test("room-swarm optional locker records artifact coordination", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-room-swarm-locker-"));
  try {
    const fakeBin = join(root, "bin");
    await mkdir(fakeBin, { recursive: true });
    const fakePi = join(fakeBin, "pi");
    await writeFile(fakePi, "#!/usr/bin/env bash\necho '# Fake synthesis'\necho\necho 'locker smoke'\n", "utf8");
    await chmod(fakePi, 0o755);
    const artifact = join(root, "artifact.md");
    const runId = "room-swarm-locker-test";
    const result = spawnSync(roomSwarmScript, [
      `--run-id=${runId}`,
      "--mission=locker smoke",
      "--model=fake-model",
      "--thinking=off",
      "--rounds=0",
      "--delay=0",
      "--locker=true",
      "--locker-lease-ms=1000",
      `--artifact-path=${artifact}`,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PI_CODING_AGENT_DIR: root,
      },
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(await readFile(artifact, "utf8"), /Fake synthesis/);
    const lockerDir = join(root, "tmp", "pi-actors", "runs", runId, "locker");
    const queue = JSON.parse(await readFile(join(lockerDir, "queue.json"), "utf8"));
    const locks = JSON.parse(await readFile(join(lockerDir, "locks.json"), "utf8"));
    const journal = await readFile(join(lockerDir, "journal.jsonl"), "utf8");
    assert.deepEqual(queue.items, []);
    assert.deepEqual(locks, {});
    assert.match(journal, /lock\.assigned/);
    assert.match(journal, /lock\.complete/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coordinator processes and handles direct inbox messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-direct-inbox-"));
  try {
    const fakeBin = join(root, "bin");
    await mkdir(fakeBin, { recursive: true });
    const fakePi = join(fakeBin, "pi");
    // Write a mock pi script that logs all received arguments to a file
    const argLog = join(root, "pi-args.txt");
    await writeFile(
      fakePi,
      `#!/usr/bin/env bash\necho "$*" >> "${argLog}"\necho '# Mock output'\n`,
      "utf8"
    );
    await chmod(fakePi, 0o755);

    const runId = "direct-inbox-test";
    const branchDir = join(root, "tmp", "pi-actors", "runs", runId, "branches", "mapper");
    await mkdir(branchDir, { recursive: true });

    // Pre-populate branch inbox with a queued message
    const inboxFile = join(branchDir, "inbox.jsonl");
    const testMessage = {
      id: "msg-123",
      from: "branch:direct-inbox-test/risk",
      to: "branch:direct-inbox-test/mapper",
      type: "task.assign",
      body: "Audit auth boundary risks",
      status: "queued",
      queued_at: new Date().toISOString()
    };
    await writeFile(inboxFile, JSON.stringify(testMessage) + "\n", "utf8");

    const artifact = join(root, "artifact.md");
    const result = spawnSync(roomSwarmScript, [
      `--run-id=${runId}`,
      "--mode=pipeline",
      "--mission=solve task",
      "--model=fake-model",
      "--thinking=off",
      "--roles=mapper",
      "--rounds=1",
      "--delay=0",
      `--artifact-path=${artifact}`,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PI_CODING_AGENT_DIR: root,
      },
      timeout: 10000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);

    // Verify message was injected into the prompt
    const loggedArgs = await readFile(argLog, "utf8");
    assert.match(loggedArgs, /DIRECT INBOX MESSAGES FOR YOU/);
    assert.match(loggedArgs, /Audit auth boundary risks/);

    // Verify inbox message was transitioned to 'handled'
    const inboxContent = await readFile(inboxFile, "utf8");
    const updatedMsg = JSON.parse(inboxContent.trim());
    assert.equal(updatedMsg.status, "handled");
    assert.ok(updatedMsg.claimed_at);
    assert.ok(updatedMsg.handled_at);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coordinator-locker queues, assigns, locks, and stops", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-coordinator-locker-"));
  const child = spawn(script, ["serve", "--state-dir", stateDir, "--lease-ms", "1000"], {
    env: { ...process.env, run_id: "coord-test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const control = join(stateDir, "control.fifo");
    await waitForPath(control);
    await sendLine(control, {
      type: "coord.enqueue",
      body: { id: "task-1", task: "Edit docs", resources: ["file:README.md"] },
    });
    await sendLine(control, { type: "coord.claim", body: { owner: "run:worker" } });
    await sendLine(control, { type: "lock.renew", body: { resource: "file:README.md", owner: "run:worker" } });
    await sendLine(control, { type: "lock.acquire", body: { resource: "file:README.md", owner: "run:other" } });
    await sendLine(control, "stop");
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(code, 0);
    const queue = JSON.parse(await readFile(join(stateDir, "queue.json"), "utf8"));
    const locks = JSON.parse(await readFile(join(stateDir, "locks.json"), "utf8"));
    const messages = (await readFile(join(stateDir, "outbox.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(queue.items, []);
    assert.equal(locks["file:README.md"].owner, "run:worker");
    assert.equal(messages.some((message) => message.type === "lock.assigned"), true);
    assert.equal(messages.some((message) => message.type === "lock.renewed"), true);
    assert.equal(messages.some((message) => message.type === "lock.denied"), true);
    assert.equal(messages.at(-1)?.type, "lock.stopped");
    const snapshot = spawn(script, ["snapshot", "--state-dir", stateDir, "--lines", "5"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const snapshotStdout = await new Promise<string>((resolve) => {
      let output = "";
      snapshot.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      snapshot.on("exit", () => resolve(output));
    });
    const summary = JSON.parse(snapshotStdout);
    assert.equal(summary.queueDepth, 0);
    assert.equal(summary.locks["file:README.md"].owner, "run:worker");
    assert.equal(summary.journal.some((entry: { event?: string }) => entry.event === "lock.assigned"), true);
  } finally {
    child.kill("SIGKILL");
    await rm(stateDir, { recursive: true, force: true });
  }
});
