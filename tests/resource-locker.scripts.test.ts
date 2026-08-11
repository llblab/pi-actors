import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { deliverRunControl } from "../lib/runs-control-delivery.ts";

const script = fileURLToPath(new URL("../scripts/locker.mjs", import.meta.url));

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForTrace(stateDir: string, kind: string): Promise<void> {
  const path = join(stateDir, "trace.jsonl");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await readFile(path, "utf8")).includes(`\"kind\":\"${kind}\"`)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${kind}`);
}

test("resource-locker consumes exact Controls and emits Trace", {
  skip: process.platform === "win32" ? "exercises the documented Unix FIFO endpoint" : false,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-resource-locker-"));
  await writeFile(
    join(stateDir, "run.json"),
    JSON.stringify({ run: "resource-locker", run_instance_id: "generation-a" }),
  );
  const child = spawn(
    process.execPath,
    [script, "serve", "--state-dir", stateDir, "--lease-ms", "1000"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    const endpointPath = join(stateDir, "control-endpoint.json");
    await waitForPath(endpointPath);
    const endpoint = JSON.parse(await readFile(endpointPath, "utf8"));
    assert.equal(endpoint.run_instance_id, "generation-a");
    assert.equal(endpoint.type, "fifo");
    await deliverRunControl("resource-locker", stateDir, {
      action: "enqueue",
      input: {
        id: "task-1",
        task: "Edit docs",
        resources: ["file:README.md"],
      },
      run_instance_id: "generation-a",
    });
    await deliverRunControl("resource-locker", stateDir, {
      action: "claim",
      input: { owner: "worker-a" },
      run_instance_id: "generation-a",
    });
    await waitForTrace(stateDir, "lock.assigned");
    await deliverRunControl("resource-locker", stateDir, {
      action: "renew",
      input: { resource: "file:README.md", owner: "worker-a" },
      run_instance_id: "generation-a",
    });
    await waitForTrace(stateDir, "lock.renewed");
    await deliverRunControl("resource-locker", stateDir, {
      action: "stop",
      run_instance_id: "generation-a",
    });
    assert.equal(await exited, 0);
    const controls = (await readFile(join(stateDir, "controls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(controls.length, 4);
    assert.equal(controls.every((control) => control.status === "handled"), true);
    assert.equal(controls.every((control) => typeof control.delivered_at === "string"), true);
    const trace = await readFile(join(stateDir, "trace.jsonl"), "utf8");
    assert.doesNotMatch(trace, /\"to\"|\"from\"|\"type\"|\"body\"/);
    assert.match(trace, /\"kind\":\"lock\.stopped\"/);
  } finally {
    child.kill("SIGKILL");
    await rm(stateDir, { recursive: true, force: true });
  }
});
