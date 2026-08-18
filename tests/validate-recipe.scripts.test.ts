/**
 * Recipe validator script regression tests
 * Covers file and directory validation for template recipe JSON/Markdown definitions.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("../skills/actors/scripts/validate-recipe.mjs", import.meta.url));
const nodeArgs = ["--experimental-strip-types", script];

test("validate-recipe validates one recipe file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-validate-recipe-"));
  try {
    const file = join(root, "recipe.json");
    await writeFile(
      file,
      JSON.stringify({
        args: ["name:string"],
        control: ["continue"],
        template: "echo {name}",
      }),
    );
    const { stdout } = await execFileAsync(process.execPath, [...nodeArgs, file]);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.total, 1);
    assert.equal(report.results[0].name, "recipe");
    assert.deepEqual(report.results[0].control, ["continue"]);
    assert.equal(report.results[0].template, "leaf");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate-recipe rejects invalid Recipe Control declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-validate-recipe-"));
  try {
    const file = join(root, "bad-control.json");
    await writeFile(file, JSON.stringify({ control: ["kill"], template: "echo bad" }));
    await assert.rejects(
      execFileAsync(process.execPath, [...nodeArgs, file]),
      (error: unknown) => {
        const report = JSON.parse((error as { stdout?: string }).stdout ?? "");
        assert.match(report.results[0].error, /runtime-reserved.*kill/);
        return true;
      },
    );
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

test("validate-recipe rejects top-level Recipe names in favor of filename identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-validate-recipe-"));
  try {
    const file = join(root, "actual.json");
    await writeFile(file, JSON.stringify({ name: "declared", template: "echo bad" }));
    await assert.rejects(
      execFileAsync(process.execPath, [...nodeArgs, file]),
      (error: unknown) => {
        const report = JSON.parse((error as { stdout?: string }).stdout ?? "");
        assert.match(report.results[0].error, /Recipe\.name was removed in pi-actors 0\.46/);
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
    await writeFile(join(root, "recipes", "c.md"), "---\ndescription: Markdown\n---\n\n```template\necho c\n```\n");
    const { stdout } = await execFileAsync(process.execPath, [...nodeArgs, join(root, "recipes"), "--all"]);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.total, 3);
    assert.deepEqual(report.results.map((result: { ok: boolean }) => result.ok), [true, true, true]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate-recipe qa accepts component Recipes without optional descriptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-validate-recipe-qa-"));
  try {
    await mkdir(join(root, "recipes"));
    await writeFile(
      join(root, "recipes", "worker.json"),
      JSON.stringify({
        async: true,
        artifacts: { report: "{state_dir}/report.md" },
        template: "echo ok",
      }),
    );
    const { stdout } = await execFileAsync(process.execPath, [
      ...nodeArgs,
      join(root, "recipes"),
      "--all",
      "--qa",
    ]);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.results[0].qa.ok, true);
    assert.deepEqual(report.results[0].qa.warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate-recipe Skill QA validates direct filesystem identities and imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-validate-skills-"));
  try {
    await mkdir(join(root, "alpha", "recipes"), { recursive: true });
    await mkdir(join(root, "beta", "recipes"), { recursive: true });
    await writeFile(
      join(root, "alpha", "recipes", "parent.json"),
      JSON.stringify({ imports: { child: "beta/task" }, template: "{child}" }),
    );
    await writeFile(join(root, "beta", "recipes", "task.json"), JSON.stringify({ template: "echo ok" }));
    const { stdout } = await execFileAsync(process.execPath, [
      ...nodeArgs,
      root,
      "--skills",
      "--qa",
    ]);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.total, 2);
    assert.deepEqual(report.results.map((result: { name: string }) => result.name), ["parent", "task"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate-recipe Skill QA rejects nested Recipes and duplicate stems precisely", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-validate-skills-"));
  try {
    await mkdir(join(root, "sample", "recipes", "nested"), { recursive: true });
    await writeFile(join(root, "sample", "recipes", "task.json"), JSON.stringify({ template: "echo json" }));
    await writeFile(join(root, "sample", "recipes", "task.md"), "```template\necho markdown\n```\n");
    await writeFile(join(root, "sample", "recipes", "nested", "child.json"), JSON.stringify({ template: "echo nested" }));
    await assert.rejects(
      execFileAsync(process.execPath, [...nodeArgs, root, "--skills", "--qa"]),
      (error: unknown) => {
        const report = JSON.parse((error as { stdout?: string }).stdout ?? "");
        const errors = report.results.map((result: { error?: string }) => result.error ?? "").join("\n");
        assert.match(errors, /Nested Skill Recipe files are not allowed: nested[/\\]child\.json/);
        assert.match(errors, /Skill Recipe stem collision: sample\/task has both \.json and \.md files/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate-recipe Skill QA admits at most one async singleton per Skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-validate-singletons-"));
  try {
    await mkdir(join(root, "sample", "recipes"), { recursive: true });
    await writeFile(
      join(root, "sample", "recipes", "first.json"),
      JSON.stringify({ async: true, singleton: true, template: "echo first" }),
    );
    await writeFile(
      join(root, "sample", "recipes", "second.json"),
      JSON.stringify({ singleton: true, template: "echo second" }),
    );
    await assert.rejects(
      execFileAsync(process.execPath, [...nodeArgs, root, "--skills", "--qa"]),
      (error: unknown) => {
        const report = JSON.parse((error as { stdout?: string }).stdout ?? "");
        const errors = report.results
          .map((result: { error?: string; qa?: { diagnostics?: string[] } }) => [
            result.error ?? "",
            ...(result.qa?.diagnostics ?? []),
          ].join("\n"))
          .join("\n");
        assert.match(errors, /more than one singleton Recipe: first\.json, second\.json/);
        assert.match(errors, /singleton: requires async: true/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate-recipe Skill QA rejects removed prefixes and unknown Skill identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-validate-skills-"));
  try {
    await mkdir(join(root, "sample", "recipes"), { recursive: true });
    for (const [name, target] of [["std", "std:task"], ["skill", "skill:sample/task"], ["unknown", "missing/task"]]) {
      await writeFile(
        join(root, "sample", "recipes", `${name}.json`),
        JSON.stringify({ imports: { child: target }, template: "{child}" }),
      );
    }
    await assert.rejects(
      execFileAsync(process.execPath, [...nodeArgs, root, "--skills", "--qa"]),
      (error: unknown) => {
        const report = JSON.parse((error as { stdout?: string }).stdout ?? "");
        const errors = report.results.map((result: { error?: string }) => result.error ?? "").join("\n");
        assert.match(errors, /std: Recipe references were removed in pi-actors 0\.46/);
        assert.match(errors, /skill: Recipe references were removed in pi-actors 0\.46/);
        assert.match(errors, /Active Skill Recipe not found: missing\/task/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate-recipe Skill QA rejects missing {skill_dir} helper targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-validate-skills-"));
  try {
    await mkdir(join(root, "sample", "recipes"), { recursive: true });
    await writeFile(join(root, "sample", "SKILL.md"), "# Sample\n");
    await writeFile(
      join(root, "sample", "recipes", "task.json"),
      JSON.stringify({ template: "{skill_dir}/scripts/missing.mjs" }),
    );
    await assert.rejects(
      execFileAsync(process.execPath, [...nodeArgs, root, "--skills", "--qa"]),
      (error: unknown) => {
        const report = JSON.parse((error as { stdout?: string }).stdout ?? "");
        assert.match(report.results[0].qa.diagnostics.join("\n"), /referenced Skill helper not found: scripts\/missing\.mjs/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate-recipe qa fails exact shipped Recipe diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-validate-recipe-qa-"));
  try {
    await mkdir(join(root, "recipes"));
    await writeFile(
      join(root, "recipes", "bad-worker.json"),
      JSON.stringify({
        async: true,
        artifacts: { report: "/home/user/report.md" },
        template: "node scripts/missing.mjs",
      }),
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        ...nodeArgs,
        join(root, "recipes"),
        "--all",
        "--qa",
      ]),
      (error: unknown) => {
        const stdout = (error as { stdout?: string }).stdout ?? "";
        const report = JSON.parse(stdout);
        const diagnostics = report.results[0].qa.diagnostics.join("\n");
        assert.deepEqual(report.results[0].qa.warnings, []);
        assert.match(diagnostics, /artifacts.report: must not use a machine-local absolute path/);
        assert.match(diagnostics, /helper scripts must be referenced through \{skill_dir\}\/scripts/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
