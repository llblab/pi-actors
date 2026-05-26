/**
 * Protocol fixture regression tests
 * Covers compact machine-readable fixtures for current actor protocol examples.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { normalizeActorMessage, parseActorAddress } from "../lib/actor-messages.ts";

const fixtureRoot = join(process.cwd(), "fixtures", "protocol");

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureRoot, name), "utf8")) as unknown;
}

test("protocol fixtures are valid JSON objects", () => {
  const files = readdirSync(fixtureRoot).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 5);
  for (const file of files) {
    const value = readFixture(file);
    assert.equal(typeof value, "object", `${file} should be an object`);
    assert.equal(Array.isArray(value), false, `${file} should not be an array`);
  }
});

test("actor message fixture normalizes and parses addresses", () => {
  const message = normalizeActorMessage(readFixture("actor-message-branch.json"));
  assert.equal(message.to, "branch:demo/reviewer");
  assert.equal(message.from, "run:demo");
  assert.equal(message.type, "task.assign");
  assert.deepEqual(parseActorAddress(message.to), {
    branch: "reviewer",
    kind: "branch",
    value: "demo",
  });
});

test("mailbox contract fixture uses typed accepts and emits", () => {
  const contract = readFixture("mailbox-contract.json") as Record<string, unknown>;
  assert.ok(Array.isArray(contract.accepts));
  assert.ok(Array.isArray(contract.emits));
  assert.deepEqual(contract.emits, [
    "task.claim",
    "task.result",
    "awaiting_assignment",
    "actor.leave",
  ]);
});

test("artifact manifest fixture covers string and metadata declarations", () => {
  const manifest = readFixture("artifact-manifest.json") as Record<string, unknown>;
  assert.equal(manifest.journal, "{state_dir}/journal.jsonl");
  assert.deepEqual(manifest.report, {
    kind: "markdown",
    media_type: "text/markdown",
    path: "{state_dir}/report.md",
    required: true,
  });
});
