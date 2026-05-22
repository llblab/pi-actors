/**
 * Helper-backed recipe utility regression tests
 * Covers script utilities used by packaged recipe-library recipes.
 */

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("recipe-utils skill-summary emits packaged skill metadata evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipe-utils-"));
  try {
    const packageFile = join(root, "package.json");
    const skillFile = join(root, "SKILL.md");
    await writeFile(packageFile, JSON.stringify({ version: "1.2.3" }));
    await writeFile(
      skillFile,
      `---\nname: demo\ndescription: Demo skill guide\nmetadata:\n  version: 1.2.3\n---\n\n# Demo\n\n## Use\n`,
    );
    const { stdout } = await execFileAsync(script, ["skill-summary", skillFile, packageFile]);
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

test("recipe-utils artifact-write writes stdin with explicit mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipe-utils-"));
  try {
    const file = join(root, "artifacts", "report.md");
    const created = spawnSync(script, ["artifact-write", file, "create"], {
      encoding: "utf8",
      input: "# Report\n",
    });
    assert.equal(created.status, 0, created.stderr);
    assert.equal(await readFile(file, "utf8"), "# Report\n");
    const duplicate = spawnSync(script, ["artifact-write", file, "create"], {
      encoding: "utf8",
      input: "again",
    });
    assert.notEqual(duplicate.status, 0);
    const appended = spawnSync(script, ["artifact-write", file, "append"], {
      encoding: "utf8",
      input: "More\n",
    });
    assert.equal(appended.status, 0, appended.stderr);
    assert.equal(await readFile(file, "utf8"), "# Report\nMore\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recipe-utils actor-message emits deterministic envelopes", () => {
  const result = spawnSync(
    script,
    ["actor-message", "artifact.written", "coordinator", "run:writer", "Done", '{"path":"report.md"}', "task-1", "msg-0"],
    { encoding: "utf8", input: '{"written":true}' },
  );
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.to, "coordinator");
  assert.equal(envelope.from, "run:writer");
  assert.equal(envelope.type, "artifact.written");
  assert.equal(envelope.summary, "Done");
  assert.deepEqual(envelope.body, { written: true });
  assert.equal(envelope.correlation_id, "task-1");
  assert.equal(envelope.reply_to, "msg-0");
  assert.deepEqual(envelope.metadata, { path: "report.md" });
});

test("recipe-utils actor-message rejects invalid envelopes", () => {
  const result = spawnSync(
    script,
    ["actor-message", "bad type", "coordinator", "run:writer"],
    { encoding: "utf8", input: "body" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid actor message type/);
});

test("recipe-utils run-ops-snapshot combines runs, messages, and recommendations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipe-utils-"));
  try {
    await writeRun(root, "active", "running");
    await writeRun(root, "failed", "failed");
    const eventFile = join(root, "active", "outbox.jsonl");
    await writeFile(eventFile, `${JSON.stringify({ event: "demo", summary: "Demo" })}\n`);
    const { stdout } = await execFileAsync(script, ["run-ops-snapshot", root, "active", "5", "1"]);
    const snapshot = JSON.parse(stdout);
    assert.equal(snapshot.runs.length, 2);
    assert.equal(snapshot.inspectedRun, "active");
    assert.equal(snapshot.messages[0].event, "demo");
    assert.equal(
      snapshot.recommendations.some(
        (item: { suggested_message?: Record<string, unknown> }) =>
          item.suggested_message?.to === "run:active" &&
          item.suggested_message?.type === "control.stop" &&
          item.suggested_message?.body === "stop",
      ),
      true,
    );
    assert.equal(
      snapshot.recommendations.some(
        (item: { suggested_inspect?: Record<string, unknown> }) =>
          item.suggested_inspect?.target === "run:failed" &&
          item.suggested_inspect?.view === "tail",
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recipe-utils run-summary reads live progress status over static run status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipe-utils-"));
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
