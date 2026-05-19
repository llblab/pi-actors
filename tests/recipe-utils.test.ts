/**
 * Helper-backed recipe utility regression tests
 * Covers script utilities used by packaged recipe-library recipes.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = new URL("../scripts/recipe-utils.mjs", import.meta.url).pathname;

async function writeRun(
  root: string,
  run: string,
  phase: string,
): Promise<void> {
  const dir = join(root, run);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      run,
      status: "running",
      recipe: "demo",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  await writeFile(
    join(dir, "progress.json"),
    JSON.stringify({ phase, updatedAt: "2026-01-01T00:00:01.000Z" }),
  );
  if (phase === "done") {
    await writeFile(
      join(dir, "result.json"),
      JSON.stringify({ code: 0, completedAt: "2026-01-01T00:00:02.000Z" }),
    );
  }
}

test("recipe-utils package-summary emits bounded package metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-recipe-utils-"));
  try {
    const file = join(root, "package.json");
    await writeFile(
      file,
      JSON.stringify({
        name: "demo",
        version: "1.2.3",
        type: "module",
        files: ["index.ts", "recipes"],
        scripts: { test: "node --test", build: "tsc" },
        dependencies: { zod: "latest" },
        devDependencies: { typescript: "latest" },
      }),
    );
    const { stdout } = await execFileAsync(script, ["package-summary", file]);
    const summary = JSON.parse(stdout);
    assert.equal(summary.name, "demo");
    assert.equal(summary.version, "1.2.3");
    assert.deepEqual(summary.scripts, ["build", "test"]);
    assert.equal(summary.dependencyCount, 1);
    assert.equal(summary.devDependencyCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recipe-utils run-summary reads live progress status over static run status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-recipe-utils-"));
  try {
    await writeRun(root, "finished", "done");
    await writeRun(root, "active", "running");
    const { stdout } = await execFileAsync(script, ["run-summary", root]);
    const rows = JSON.parse(stdout);
    assert.equal(
      rows.find((row: { run: string }) => row.run === "finished")?.status,
      "done",
    );
    assert.equal(
      rows.find((row: { run: string }) => row.run === "active")?.status,
      "running",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
