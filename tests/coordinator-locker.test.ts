/**
 * Coordinator-locker script regression tests
 * Covers queue, lease lock, and actor-message behavior for the coordinator-locker recipe helper.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/coordinator-locker.mjs", import.meta.url).pathname;

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
    assert.equal(messages.some((message) => message.type === "coord.assigned"), true);
    assert.equal(messages.some((message) => message.type === "lock.renewed"), true);
    assert.equal(messages.some((message) => message.type === "lock.denied"), true);
    assert.equal(messages.at(-1)?.type, "coord.stopped");
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
    assert.equal(summary.journal.some((entry: { event?: string }) => entry.event === "coord.assigned"), true);
  } finally {
    child.kill("SIGKILL");
    await rm(stateDir, { recursive: true, force: true });
  }
});
