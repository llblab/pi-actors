import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { normalizeControlRequest } from "../lib/control.ts";
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
    ...["docs", "fixtures", "lib", "recipes", "scripts", "skills"]
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
  for (const expected of [
    "inspect target=runtime view=status",
    "inspect target=recipes view=status",
    "inspect target=tool:<name> view=status",
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

test("Canonical management inspect examples pass the real dispatcher", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-actors-invocation-contract-"));
  const recipeRoot = join(stateRoot, "recipes");
  const packagedRecipeRoot = join(stateRoot, "packaged");
  try {
    await mkdir(join(recipeRoot, "drafts"), { recursive: true });
    await mkdir(packagedRecipeRoot, { recursive: true });
    const inspect = createInspectToolDefinition({
      getTool: (name) => name === "demo"
        ? { description: "Demo", parameters: { type: "object" }, promptSnippet: "demo" }
        : undefined,
      listRuns: () => [],
      packagedRecipeRoot,
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
