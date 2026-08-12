import assert from "node:assert/strict";
import test from "node:test";

import { executableBlockBlankLines } from "../scripts/executable-block-style.mjs";

test("Executable block style rejects function and control-flow spacing", () => {
  assert.deepEqual(executableBlockBlankLines("function run() {\n\n  if (ready) {\n\n  }\n}"), [2, 4]);
});

test("Executable block style permits structural bodies", () => {
  assert.deepEqual(
    executableBlockBlankLines("const value = {\n\n  nested: {\n\n  },\n};\ninterface Shape {\n\n  value: string;\n}"),
    [],
  );
});

test("Executable block style ignores regular expressions and template content", () => {
  assert.deepEqual(
    executableBlockBlankLines("function run() {\n  const regex = /[{}]/u;\n  const text = `first {\n\nsecond }`;\n}"),
    [],
  );
});

test("Executable block style handles arrow, try, catch, and finally blocks", () => {
  assert.deepEqual(
    executableBlockBlankLines("const run = () => {\n\n  try {\n\n  } catch {\n\n  } finally {\n\n  }\n};"),
    [2, 4, 6, 8],
  );
});
