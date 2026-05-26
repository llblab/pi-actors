/**
 * Architecture invariant tests
 * Guards the coordinator entrypoint and namespace domain imports
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const indexSource = await readFile(
  new URL("../index.ts", import.meta.url),
  "utf8",
);
const changelogSource = await readFile(
  new URL("../CHANGELOG.md", import.meta.url),
  "utf8",
);

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

test("Entrypoint imports local domains through namespace imports", () => {
  const localImports = [
    ...indexSource.matchAll(/^import\s+(.+?)\s+from\s+"\.\/lib\//gm),
  ].map((match) => match[1]);
  assert.equal(localImports.length > 0, true);
  assert.equal(
    localImports.every((statement) => statement.startsWith("* as ")),
    true,
  );
});

test("Entrypoint stays free of direct typebox and environment access", () => {
  assert.equal(indexSource.includes('from "typebox"'), false);
  assert.equal(indexSource.includes("process.env"), false);
});

test("Entrypoint delegates register_tool definition to the tools domain", () => {
  assert.match(indexSource, /Tools\.createRegisterToolDefinition/);
  assert.equal(indexSource.includes('name: "register_tool"'), false);
});

test("Entrypoint reports recipe watcher failures", () => {
  assert.match(indexSource, /Recipe live reload watcher failed/);
  assert.match(indexSource, /notifyRecipeWatcherFailure\(ctx\)/);
});

const publicGuidanceFiles = [
  "AGENTS.md",
  "BACKLOG.md",
  "README.md",
  ...listFiles("docs").filter((path) => path.endsWith(".md")),
  ...listFiles("skills").filter((path) => path.endsWith(".md")),
];

const operatorGuidanceFiles = [
  "README.md",
  ...listFiles("docs").filter((path) => path.endsWith(".md")),
  ...listFiles("skills").filter((path) => path.endsWith(".md")),
];

test("Public guidance avoids stale concrete model aliases", () => {
  const files = publicGuidanceFiles;
  const staleModelAliases = [
    /openai-codex\/gpt-5\.5/i,
    /deepseek\/deepseek-v4/i,
    /\bgpt-5\.5\b/i,
    /model:string=[^\s",`)]*gpt/i,
    /model=[^\s",`)]*openai/i,
  ];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const pattern of staleModelAliases) {
      assert.doesNotMatch(content, pattern, `${file} should not mention ${pattern}`);
    }
  }
});

test("Operator guidance uses snake_case docs review examples", () => {
  for (const file of operatorGuidanceFiles) {
    const content = readFileSync(file, "utf8");
    assert.doesNotMatch(content, /docs-review/, `${file} should use docs_review`);
  }
});

test("Operator guidance avoids direct inbox and outbox wording", () => {
  for (const file of operatorGuidanceFiles) {
    const content = readFileSync(file, "utf8");
    assert.doesNotMatch(
      content,
      /\binbox\/outbox\b|\bdirect inbox\b|\bdirect outbox\b/i,
      `${file} should describe actor messages instead of inbox/outbox routing`,
    );
  }
});

test("Operator guidance avoids stale FIFO queue wording", () => {
  for (const file of operatorGuidanceFiles) {
    const content = readFileSync(file, "utf8");
    assert.doesNotMatch(
      content,
      /FIFO queue|queued FIFO/i,
      `${file} should describe queued mailbox work, not FIFO queues`,
    );
  }
});

test("Platform guidance makes native Windows FIFO limits visible", () => {
  const readme = readFileSync("README.md", "utf8");
  const asyncRuns = readFileSync("docs/async-runs.md", "utf8");
  assert.match(readme, /FIFO control endpoints[\s\S]*Not supported; use mailbox or named pipe/);
  assert.match(asyncRuns, /FIFO endpoint[\s\S]*Rejected before delivery/);
  assert.match(asyncRuns, /Mailbox-only endpoint[\s\S]*Use for cross-platform workers/);
});

test("Unreleased changelog items avoid version literals", () => {
  const unreleased = changelogSource.match(
    /^## Unreleased\n(?<body>[\s\S]*?)(?=^## \d+\.\d+\.\d+)/m,
  )?.groups?.body ?? "";
  for (const line of unreleased.split("\n").filter((line) => line.startsWith("- `"))) {
    assert.doesNotMatch(
      line,
      /\b\d+\.\d+\.\d+\b/,
      "Unreleased changelog item should rely on the section heading for versioning",
    );
  }
});

test("Music player backend enum stays aligned across recipe docs and script", () => {
  const recipe = JSON.parse(readFileSync("recipes/music-player.json", "utf8"));
  const recipePlayers = recipe.args
    .find((arg: string) => arg.startsWith("player:enum("))
    ?.match(/^player:enum\((?<values>[^)]+)\)$/)?.groups?.values.split(",");
  assert.deepEqual(recipePlayers, [
    "auto",
    "mpv",
    "afplay",
    "ffplay",
    "cvlc",
    "play",
    "wmp",
  ]);

  const docs = readFileSync("docs/recipe-library.md", "utf8");
  const docsPlayers = docs
    .match(/player:enum\((?<values>[^)]+)\)=auto/)?.groups?.values.split(",");
  assert.deepEqual(docsPlayers, recipePlayers);

  const script = readFileSync("scripts/music-player.mjs", "utf8");
  const usagePlayers = script
    .match(/Supported players: (?<values>[^.]+)\./)?.groups?.values.split(", ");
  assert.deepEqual(usagePlayers, recipePlayers);
});
