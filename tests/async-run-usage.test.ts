/**
 * Async run usage telemetry regressions
 * Covers extension-owned launch counter increments for recipe-file runs
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test("Async run start increments user recipe launch counter", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-actors-async-usage-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { getRunStatus, startRun } = await import(
      `../lib/async-runs.ts?usage=${Date.now()}`
    );
    async function waitForResult(stateDir: string): Promise<void> {
      for (let i = 0; i < 40; i += 1) {
        if (getRunStatus(stateDir).result) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("run did not finish");
    }

    const recipeRoot = join(agentDir, "recipes");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(recipeRoot, { recursive: true }),
    );
    const recipe = join(recipeRoot, "counted.json");
    await writeFile(
      recipe,
      JSON.stringify({
        async: true,
        template: "printf counted",
      }),
    );

    const meta = startRun({ file: "counted", run_id: "counted-run" }, process.cwd());
    await waitForResult(meta.state_dir);

    const updated = await readJson(recipe);
    assert.equal((updated.usage as Record<string, unknown>).calls, 1);
    assert.equal(
      typeof (updated.usage as Record<string, unknown>).last_called,
      "string",
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});
