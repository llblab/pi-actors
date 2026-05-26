/**
 * Resilient state reader regression tests
 * Covers JSON/JSONL degradation behavior for file-backed actor state.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  formatStateReadDiagnostics,
  readJsonFileResilient,
  readJsonlFileResilient,
} from "../lib/state-readers.ts";

test("resilient JSON reader returns fallback and diagnostics for corrupt files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-state-json-"));
  try {
    const file = join(root, "state.json");
    await writeFile(file, "{bad json\n");

    const result = readJsonFileResilient(file, { ok: false });
    assert.deepEqual(result.value, { ok: false });
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].path, file);
    assert.match(formatStateReadDiagnostics(result.diagnostics)[0], /state\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resilient JSONL reader preserves valid records and reports bad lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-state-jsonl-"));
  try {
    const file = join(root, "events.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({ event: "one" })}\n{bad json\n${JSON.stringify({ event: "two" })}\n`,
    );

    const result = readJsonlFileResilient<Record<string, unknown>>(file);
    assert.deepEqual(result.records, [{ event: "one" }, { event: "two" }]);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].line, 2);
    assert.match(formatStateReadDiagnostics(result.diagnostics)[0], /events\.jsonl:2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
