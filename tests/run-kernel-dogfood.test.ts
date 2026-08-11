/** End-to-end deterministic dogfood for the public Run kernel. */

import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const agentDir = await mkdtemp(join(tmpdir(), "pi-actors-kernel-dogfood-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const AsyncRuns = await import("../lib/async-runs.ts");
const { createInspectToolDefinition } = await import("../lib/tools-inspect.ts");
const { createSpawnToolDefinition } = await import("../lib/tools-spawn.ts");
const context = {
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => "run-kernel-dogfood-owner" },
} as any;

async function waitForStatus(
  run: string,
  expected: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = AsyncRuns.getRunStatus(run);
    if (status.status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${run} did not reach ${expected}`);
}

async function waitForProcessExit(run: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pid = Number(AsyncRuns.getRunStatus(run).pid || 0);
    if (!pid) return;
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${run} process did not exit`);
}

async function missing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

test.after(async () => {
  try {
    const status = AsyncRuns.getRunStatus("replacement");
    if (status.status === "running") {
      AsyncRuns.killRun("replacement", {
        ownerId: "run-kernel-dogfood-owner",
        runInstanceId: String(status.run_instance_id),
      });
      await waitForProcessExit("replacement");
    }
  } catch {}
  await rm(agentDir, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

test("public spawn and Inspect expose one-shot Recipe, Trace, and Control only", async () => {
  const run = "one-shot";
  const spawn = createSpawnToolDefinition();
  const started = await spawn.execute(
    "spawn-one-shot",
    {
      as: `run:${run}`,
      template: `${process.execPath} -e "console.log('RUN_KERNEL_DOGFOOD_OK')"`,
    },
    undefined,
    undefined,
    context,
  );
  const stateDir = String(started.details.state_dir);
  await waitForStatus(run, "done");
  await waitForProcessExit(run);

  const inspect = createInspectToolDefinition();
  const recipe = await inspect.execute("recipe", { target: `run:${run}`, view: "recipe", verbose: true }, undefined, undefined, context);
  const trace = await inspect.execute("trace", { target: `run:${run}`, view: "trace", verbose: true }, undefined, undefined, context);
  const control = await inspect.execute("control", { target: `run:${run}`, view: "control", verbose: true }, undefined, undefined, context);
  assert.equal((recipe.details as any).identity.run, run);
  assert.equal((trace.details as any).items.some((item: any) => item.kind === "run.start"), true);
  assert.equal((trace.details as any).items.some((item: any) => item.kind === "process.result"), true);
  assert.deepEqual((control.details as any).actor_actions, []);
  assert.deepEqual((control.details as any).recent_controls, []);
  assert.match(await readFile(join(stateDir, "stdout.log"), "utf8"), /RUN_KERNEL_DOGFOOD_OK/);
  const files = await readdir(stateDir);
  for (const removed of [
    "communication.json",
    "events.jsonl",
    "inbox.jsonl",
    "messages.jsonl",
    "outbox.jsonl",
    "room.json",
  ]) assert.equal(files.includes(removed), false, `${removed} must not be created`);
  assert.equal(await missing(join(stateDir, "controls.jsonl")), true);
  assert.equal(await missing(join(stateDir, "control-endpoint.json")), true);
});

test("same-id replacement rejects and hides the old Run generation", async () => {
  const run = "replacement";
  const recipePath = join(agentDir, "controlled.json");
  await writeFile(
    recipePath,
    `${JSON.stringify({
      async: true,
      control: ["pause"],
      template: `${process.execPath} -e "setTimeout(() => {}, 10000)"`,
    })}\n`,
  );
  const spawn = createSpawnToolDefinition();
  const first = await spawn.execute("spawn-first", { as: `run:${run}`, file: recipePath }, undefined, undefined, context);
  const stateDir = String(first.details.state_dir);
  const generationA = String(first.details.run_instance_id);
  AsyncRuns.killRun(run, {
    ownerId: "run-kernel-dogfood-owner",
    runInstanceId: generationA,
  });
  await waitForStatus(run, "killed");
  await waitForProcessExit(run);

  const second = await spawn.execute("spawn-second", { as: `run:${run}`, file: recipePath }, undefined, undefined, context);
  const generationB = String(second.details.run_instance_id);
  assert.notEqual(generationB, generationA);
  await assert.rejects(
    AsyncRuns.sendRunControl(
      run,
      { action: "pause", run_instance_id: generationA },
      { ownerId: "run-kernel-dogfood-owner" },
    ),
    (error: any) => error?.reason === "generation_mismatch",
  );
  assert.equal(await missing(join(stateDir, "controls.jsonl")), true);
  assert.equal(await missing(join(stateDir, "control-endpoint.json")), true);

  const inspect = createInspectToolDefinition();
  const control = await inspect.execute("control", { target: `run:${run}`, view: "control", verbose: true }, undefined, undefined, context);
  assert.equal((control.details as any).run_instance_id, generationB);
  assert.deepEqual((control.details as any).recent_controls, []);
  AsyncRuns.killRun(run, {
    ownerId: "run-kernel-dogfood-owner",
    runInstanceId: generationB,
  });
  await waitForStatus(run, "killed");
  await waitForProcessExit(run);
});
