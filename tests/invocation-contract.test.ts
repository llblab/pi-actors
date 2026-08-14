import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { normalizeControlRequest } from "../lib/control.ts";
import { createSpawnToolDefinition } from "../lib/tools-spawn.ts";
import { parseAutomaticReviewScope } from "../lib/review-control.ts";
import { createInspectToolDefinition } from "../lib/tools-inspect.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const maintainedExtensions = new Set([".json", ".md", ".mjs", ".ts"]);

function filesUnder(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return filesUnder(child);
    return entry.isFile() && maintainedExtensions.has(extname(entry.name)) ? [child] : [];
  });
}

function maintainedInvocationFiles(): string[] {
  return [
    join(root, "AGENTS.md"),
    join(root, "README.md"),
    join(root, "index.ts"),
    ...["docs", "fixtures", "lib", "scripts", "skills"]
      .flatMap((dir) => filesUnder(join(root, dir))),
  ];
}

function commandSegments(line: string, pattern: RegExp): string[] {
  const matches = [...line.matchAll(pattern)];
  return matches.map((match, index) =>
    line.slice(match.index, matches[index + 1]?.index ?? line.length),
  );
}

test("Maintained invocation guidance uses complete current inspect and Control shapes", () => {
  const sources = maintainedInvocationFiles().map((path) => ({
    path,
    source: readFileSync(path, "utf8"),
  }));
  const combined = sources.map(({ source }) => source).join("\n");
  assert.doesNotMatch(combined, /new tool is immediately callable/);
  for (const expected of [
    "inspect target=runtime view=status",
    "inspect target=recipes view=status",
    "inspect target=tool:<name> view=status",
    'launch_kind: "spawn"',
    'launch_kind: "tool"',
    "callable_now",
    "catalog partial",
    "message target=runtime action=review.retry input={\"scope\":\"draft\"}",
    "message target=runtime action=review.retry input={\"scope\":\"tool\"}",
    "message target=runtime action=review.reset input={\"scope\":\"draft\"}",
    "message target=runtime action=review.reset input={\"scope\":\"tool\"}",
  ]) {
    assert.ok(combined.includes(expected), `Missing canonical invocation: ${expected}`);
  }
  for (const { path, source } of sources) {
    assert.doesNotMatch(source, /body\.scope/);
    assert.doesNotMatch(source, /message to=tool:pi-actors type=review\.(?:retry|reset)/);
    assert.doesNotMatch(source, /inspect target=run:[^\s`"']+ view=(?:artifacts|messages|turns|communications)/);
    for (const [lineIndex, rawLine] of source.split("\n").entries()) {
      const line = rawLine.replaceAll('\\"', '"');
      for (const command of commandSegments(
        line,
        /\binspect target=(?:runtime|recipes|tool:[^\s`"',]+)/g,
      )) {
        assert.match(command, /\bview=[a-z]+/, `${path}:${lineIndex + 1}`);
      }
      for (const command of commandSegments(
        line,
        /\bmessage target=runtime action=review\.(?:retry|reset)/g,
      )) {
        assert.match(
          command,
          /\binput=\{"scope":"(?:draft|tool)"\}/,
          `${path}:${lineIndex + 1}`,
        );
      }
    }
  }
});

test("Canonical runtime review Controls pass the real normalizers", () => {
  for (const action of ["review.retry", "review.reset"] as const) {
    for (const scope of ["draft", "tool"] as const) {
      const request = normalizeControlRequest({
        action,
        input: { scope },
        target: "runtime",
      });
      assert.equal(request.target, "runtime");
      assert.equal(request.action, action);
      assert.equal(parseAutomaticReviewScope(request.input), scope);
    }
  }
  assert.throws(
    () => parseAutomaticReviewScope({}),
    /input\.scope=draft or input\.scope=tool/,
  );
});

test("Maintained public examples pass current schemas and protocol fixtures parse", () => {
  const spawn = createSpawnToolDefinition();
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const requestBlock = readme.match(/```json\s+(\{\s+"target": "run:player"[\s\S]*?\})\s+```/);
  assert.ok(requestBlock);
  const control = normalizeControlRequest(JSON.parse(requestBlock[1]));
  assert.equal(control.target, "run:player");
  assert.equal(control.action, "pause");
  for (const params of [
    { as: "run:demo", template: "sleep 30" },
    { recipe: "project-work/repo-health", values: { repo: "/work/project", model: "provider/model" } },
    { as: "run:test", template: "make test" },
  ]) {
    const unknown = Object.keys(params).filter((key) => !Object.hasOwn(spawn.parameters.properties, key));
    assert.deepEqual(unknown, []);
    assert.equal(spawn.parameters.required.every((key: string) => Object.hasOwn(params, key)), true);
  }
  for (const file of ["control-record.json", "trace-event.json", "control-endpoint.json", "artifact-manifest.json", "recipe-summary.json"])
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, "fixtures", "protocol", file), "utf8")), file);
});

test("Canonical management inspect examples pass the real dispatcher", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-actors-invocation-contract-"));
  const recipeRoot = join(stateRoot, "recipes");
  try {
    await mkdir(join(recipeRoot, "drafts"), { recursive: true });
    const inspect = createInspectToolDefinition({
      getTool: (name) => name === "demo"
        ? { description: "Demo", parameters: { type: "object" }, promptSnippet: "demo" }
        : undefined,
      listRuns: () => [],
      recipeRoot,
    });
    for (const params of [
      { target: "runtime", view: "status" },
      { target: "runtime", view: "triage" },
      { target: "recipes", view: "status" },
      { target: "tool:demo", view: "status" },
      { target: "tool:demo", view: "schema" },
    ]) {
      const result = await inspect.execute("call", params, undefined, undefined, {});
      assert.equal(result.content[0].type, "text");
    }
    await assert.rejects(
      inspect.execute("call", { target: "runtime" }, undefined, undefined, {}),
      /inspect runtime supports view=status/,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
