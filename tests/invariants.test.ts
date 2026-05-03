/**
 * Architecture invariant tests
 * Guards the coordinator entrypoint and namespace domain imports
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexSource = await readFile(
  new URL("../index.ts", import.meta.url),
  "utf8",
);

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
