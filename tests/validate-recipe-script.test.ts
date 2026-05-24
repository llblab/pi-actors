/**
 * Recipe validator script regression tests
 * Covers file and directory validation for template recipe JSON definitions.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = new URL("../scripts/validate-recipe.mjs", import.meta.url).pathname;
const nodeArgs = ["--experimental-strip-types", script];

test("validate-recipe validates one recipe file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-validate-recipe-"));
  try {
    const file = join(root, "recipe.json");
    await writeFile(
      file,
      JSON.stringify({ name: "demo", args: ["name:string"], template: "echo {name}" }),
    );
    const { stdout } = await execFileAsync(process.execPath, [...nodeArgs, file]);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.total, 1);
    assert.equal(report.results[0].name, "recipe");
    assert.equal(report.results[0].template, "leaf");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate-recipe fails invalid recipe files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-validate-recipe-"));
  try {
    const file = join(root, "bad.json");
    await writeFile(file, JSON.stringify({ name: "bad" }));
    await assert.rejects(
      execFileAsync(process.execPath, [...nodeArgs, file]),
      (error: unknown) => {
        const stdout = (error as { stdout?: string }).stdout ?? "";
        const report = JSON.parse(stdout);
        assert.equal(report.ok, false);
        assert.equal(report.failed, 1);
        assert.match(report.results[0].error, /template/i);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate-recipe validates recipe directories with --all", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-validate-recipe-"));
  try {
    await mkdir(join(root, "recipes"));
    await writeFile(join(root, "recipes", "a.json"), JSON.stringify({ template: "echo a" }));
    await writeFile(join(root, "recipes", "b.json"), JSON.stringify({ template: ["echo b", "wc -c"] }));
    const { stdout } = await execFileAsync(process.execPath, [...nodeArgs, join(root, "recipes"), "--all"]);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.total, 2);
    assert.deepEqual(report.results.map((result: { ok: boolean }) => result.ok), [true, true]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
