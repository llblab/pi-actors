import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  killRun,
  sendRunControl,
  startRun,
} from "../lib/async-runs.ts";
import * as Limits from "../lib/limits.ts";
import { appendRunControlInStateDir, readRunControlsFromStateDir } from "../lib/runs-controls.ts";

async function writeNamedPipeEndpoint(
  stateDir: string,
  runInstanceId: string,
): Promise<void> {
  await writeFile(
    join(stateDir, "control-endpoint.json"),
    `${JSON.stringify({
      path: "named-pipe-test",
      ready_at: new Date().toISOString(),
      run_instance_id: runInstanceId,
      type: "named-pipe",
    })}\n`,
  );
}

test("Runtime kill bypasses actor-local Control saturation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-kill-saturation-"));
  const stateDir = join(root, "saturated");
  const meta = startRun({ ownerId: "session-a", run_id: "saturated", state_dir: stateDir,
    template: `${process.execPath} -e "setTimeout(() => {}, 30000)"` }, process.cwd());
  try {
    for (let index = 0; index < Limits.RUN_CONTROL_PENDING_LIMIT; index += 1)
      appendRunControlInStateDir(stateDir, {
        action: "pause", input: { index }, run_instance_id: meta.run_instance_id,
      });
    const killed = killRun(stateDir, { ownerId: "session-a", runInstanceId: meta.run_instance_id });
    assert.equal(killed.killed, true);
    assert.equal(readRunControlsFromStateDir(stateDir).length, Limits.RUN_CONTROL_PENDING_LIMIT);
    assert.equal(readRunControlsFromStateDir(stateDir).every(({ status }) => status === "queued"), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Canonical Run Control revalidates owner and generation under the lifecycle lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-canonical-control-"));
  const stateDir = join(root, "demo");
  const meta = startRun(
    {
      ownerId: "session-a",
      run_id: "demo",
      state_dir: stateDir,
      template: `${process.execPath} -e "setTimeout(() => {}, 30000)"`,
    },
    process.cwd(),
  );
  try {
    await writeNamedPipeEndpoint(stateDir, meta.run_instance_id);
    await assert.rejects(
      sendRunControl(
        stateDir,
        { action: "pause", run_instance_id: meta.run_instance_id },
        { ownerId: "session-b" },
      ),
      (error: unknown) => {
        assert.equal((error as Record<string, unknown>).reason, "owner_mismatch");
        return true;
      },
    );
    await assert.rejects(
      sendRunControl(
        stateDir,
        { action: "pause", run_instance_id: "replacement" },
        { ownerId: "session-a" },
      ),
      (error: unknown) => {
        assert.equal((error as Record<string, unknown>).reason, "generation_mismatch");
        return true;
      },
    );
    const receipt = await sendRunControl(
      stateDir,
      { action: "pause", run_instance_id: meta.run_instance_id },
      {
        ownerId: "session-a",
        namedPipeSend: async (_path, payload) => Buffer.byteLength(payload),
      },
    );
    assert.equal(receipt.delivery, "delivered");
  } finally {
    const killed = killRun(stateDir, {
      ownerId: "session-a",
      runInstanceId: meta.run_instance_id,
    });
    assert.equal(killed.killed, true);
    assert.equal(Object.hasOwn(killed, "control_id"), false);
    await rm(root, { force: true, recursive: true });
  }
});
