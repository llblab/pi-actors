/**
 * Helper-backed recipe utility regression tests
 * Covers script utilities used by packaged recipe-library recipes.
 */

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const artifactScript = fileURLToPath(
  new URL("../skills/artifacts/scripts/artifact-utils.mjs", import.meta.url),
);
const projectScript = fileURLToPath(
  new URL("../skills/project-work/scripts/project-utils.mjs", import.meta.url),
);
const actorScript = fileURLToPath(
  new URL("../skills/actors/scripts/run-utils.mjs", import.meta.url),
);

function runScript(
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) {
  const script = args[0] === "artifact-write" ? artifactScript : projectScript;
  const command = args[0] === "artifact-write" ? "write" : args[0];
  return spawnSync(process.execPath, [script, command, ...args.slice(1)], options);
}

function runScriptAsync(args: string[]) {
  return execFileAsync(process.execPath, [projectScript, ...args]);
}

function runActorScriptAsync(args: string[]) {
  return execFileAsync(process.execPath, [actorScript, ...args]);
}

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

test("project-utils package-summary emits bounded package metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipe-utils-"));
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
    const { stdout } = await runScriptAsync(["package-summary", file]);
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

test("project-utils skill-summary emits packaged skill metadata evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipe-utils-"));
  try {
    const packageFile = join(root, "package.json");
    const skillFile = join(root, "SKILL.md");
    await writeFile(packageFile, JSON.stringify({ version: "1.2.3" }));
    await writeFile(
      skillFile,
      `---\nname: demo\ndescription: Demo skill guide\nmetadata:\n  version: 1.2.3\n---\n\n# Demo\n\n## Use\n`,
    );
    const { stdout } = await runScriptAsync(["skill-summary", skillFile, packageFile]);
    const summary = JSON.parse(stdout);
    assert.equal(summary.name, "demo");
    assert.equal(summary.version, "1.2.3");
    assert.equal(summary.versionMatchesPackage, true);
    assert.deepEqual(summary.frontmatterExtraColonLines, []);
    assert.deepEqual(summary.headings, ["# Demo", "## Use"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact-utils writes stdin with explicit mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipe-utils-"));
  try {
    const file = join(root, "artifacts", "report.md");
    const created = runScript(["artifact-write", file, "create"], {
      encoding: "utf8",
      input: "# Report\n",
    });
    assert.equal(created.status, 0, created.stderr);
    assert.equal(await readFile(file, "utf8"), "# Report\n");
    const duplicate = runScript(["artifact-write", file, "create"], {
      encoding: "utf8",
      input: "again",
    });
    assert.notEqual(duplicate.status, 0);
    const appended = runScript(["artifact-write", file, "append"], {
      encoding: "utf8",
      input: "More\n",
    });
    assert.equal(appended.status, 0, appended.stderr);
    assert.equal(await readFile(file, "utf8"), "# Report\nMore\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("actor run-utils snapshot combines Runs, Trace, and recommendations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipe-utils-"));
  try {
    await writeRun(root, "active", "running");
    await writeRun(root, "failed", "failed");
    const traceFile = join(root, "active", "trace.jsonl");
    await writeFile(traceFile, `${JSON.stringify({ id: "trace-1", kind: "demo", summary: "Demo", ts: new Date().toISOString() })}\n`);
    const { stdout } = await runActorScriptAsync(["run-ops-snapshot", root, "active", "5", "1"]);
    const snapshot = JSON.parse(stdout);
    assert.equal(snapshot.runs.length, 2);
    assert.equal(snapshot.inspectedRun, "active");
    assert.equal(snapshot.trace[0].kind, "demo");
    assert.equal(
      snapshot.recommendations.some(
        (item: { suggested_inspect?: Record<string, unknown> }) =>
          item.suggested_inspect?.target === "run:active" &&
          item.suggested_inspect?.view === "control",
      ),
      true,
    );
    assert.equal(
      snapshot.recommendations.some(
        (item: { suggested_inspect?: Record<string, unknown> }) =>
          item.suggested_inspect?.target === "run:failed" &&
          item.suggested_inspect?.view === "trace",
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("actor run-utils summary reads live progress status over static run status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipe-utils-"));
  try {
    await writeRun(root, "finished", "done");
    await writeRun(root, "active", "running");
    const { stdout } = await runActorScriptAsync(["run-summary", root]);
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
