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
